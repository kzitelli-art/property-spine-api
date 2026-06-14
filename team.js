// ============================================================
// team.js — PHONE-FIRST TEAM: invite, verify, session, access
//
// The EMPLOYEE twin of tenant_link. The rule, Kameron's words:
//   "Phone is the identity. Role is the access. Accountability is the work."
//   Normal operators get NO username, NO password, NO email login. A manager
//   adds them by phone; they tap an SMS link, verify a code, and land in the
//   exact modules their job allows.
//
// This module is the BACKEND the dev's phone-login dashboard already drew
// (operator_dashboard_phone_login_smooth.html — its invite form and access
// cards are a live mockup calling nothing). The contract is read from that
// UI: a team member is { name, phone, role_title, scope, email?, modules[] }.
//
// MIRRORS THE PROVEN PATTERN (tenant_link 027/030), does not reinvent it:
//   invite → token → OTP (salted hash, NEVER stored plain) → scoped session.
//   SMS SEND is INJECTED (deps.sms), exactly as tenant_link injects it, so
//   flipping Twilio on for staff is a config change, not a code change. Until
//   then the OTP is returned in the API response under dev_code for testing —
//   the same honest pre-Twilio path tenant_link shipped on.
//
// SECURITY (spec's tiered model):
//   Phone verification is enough for normal operating work. HIGH-RISK actions
//   (changing role access, adding/removing users, exporting full reporting,
//   approving the monthly package, bank/payment settings, ownership rules)
//   should later require a FRESH SMS re-check. This module records the
//   session and exposes the access read; the high-risk re-check gate is a
//   noted follow-on, not faked here.
//
// HASHING: OTP and tokens are sha256(value + APP_SECRET). The plain code is
//   shown once (dev_code) and otherwise lives only as a hash — same rule 030
//   states. Not bcrypt — these are short-lived single-use codes, not stored
//   passwords; sha256 with a server secret is the right tool and matches the
//   existing transport's posture.
//
// Factory (standing module pattern, deps like tenant_link):
//   const teamModule = require('./team');
//   app.use("/", teamModule({ pool, sms }));   // sms optional; null = dev_code path
// ============================================================

const express = require("express");
const crypto = require("crypto");

// normalize a phone to its NANP 10-digit key — the identity match. Mirrors
// the migration's index expression so app and DB agree on "same phone".
const normPhone = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

const SECRET = process.env.APP_SECRET || process.env.ANTHROPIC_API_KEY || "ps-dev-secret";
const sha = (v) => crypto.createHash("sha256").update(String(v) + SECRET).digest("hex");
const randToken = () => crypto.randomBytes(24).toString("hex");
const sixDigit = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

// app-layer module vocabulary (DB stores text[]; vocab enforced here — the
// 007 §1b precedent: the list evolves without a migration).
const MODULES = ["management", "leasing", "maintenance", "reporting"];
const validModules = (arr) =>
  Array.isArray(arr) ? arr.filter(m => MODULES.includes(m)) : [];

// the landing module: where a user drops after login. First of a sensible
// priority order they're allowed into — reporting/management are "wider"
// views, maintenance/leasing are focused. A tech lands in maintenance; a
// PM with everything lands in management.
function landingModule(allowed) {
  for (const m of ["management", "reporting", "leasing", "maintenance"]) {
    if (allowed.includes(m)) return m;
  }
  return allowed[0] || null;
}

module.exports = function teamModule(deps) {
  const { pool, sms } = deps;
  const router = express.Router();
  const INVITE_TTL_MIN = 60 * 48;   // 48h to accept the invite
  const OTP_TTL_MIN = 10;           // code is short-lived
  const SESSION_TTL_DAYS = 30;
  const MAX_FAILS = 5;

  // ──────────────────────────────────────────────────────────────────
  // GET /properties/:propertyId/team
  // The roster: active staff at this property + their access + the
  // accountability tiers (backup, escalation). Feeds the dev's roster UI.
  // ──────────────────────────────────────────────────────────────────
  router.get("/properties/:propertyId/team", async (req, res) => {
    try {
      const rows = (await pool.query(
        `select pta.id as assignment_id, pta.role_title, pta.scope_type,
                pta.allowed_modules, pta.primary_for_modules,
                pta.can_manage_roles, pta.active,
                u.id as user_id, u.name, u.phone, u.email,
                u.phone_verified_at, u.status as user_status,
                bu.name as backup_name, bu.id as backup_user_id,
                eu.name as escalates_to_name, eu.id as escalates_to_user_id
           from property_team_assignments pta
           join users u  on u.id = pta.user_id
           left join users bu on bu.id = pta.backup_user_id
           left join users eu on eu.id = pta.escalates_to_user_id
          where pta.property_id = $1 and pta.active = true
          order by u.name`, [req.params.propertyId])).rows;
      // pending invites (not yet accepted) shown alongside, honestly labeled
      const invites = (await pool.query(
        `select id, invited_name, phone_number, role_title, allowed_modules, status, expires_at
           from team_invites
          where property_id = $1 and status = 'active'
          order by created_at desc`, [req.params.propertyId])).rows;
      return res.json({
        property_id: req.params.propertyId,
        team: rows.map(r => ({
          assignment_id: r.assignment_id,
          user_id: r.user_id,
          name: r.name,
          phone: r.phone,
          email: r.email || null,
          phone_verified: r.phone_verified_at != null,
          role_title: r.role_title,
          scope_type: r.scope_type,
          allowed_modules: r.allowed_modules || [],
          primary_for_modules: r.primary_for_modules || [],
          can_manage_roles: r.can_manage_roles,
          backup: r.backup_user_id ? { user_id: r.backup_user_id, name: r.backup_name } : null,
          escalates_to: r.escalates_to_user_id ? { user_id: r.escalates_to_user_id, name: r.escalates_to_name } : null,
        })),
        pending_invites: invites.map(i => ({
          invite_id: i.id, name: i.invited_name, phone: i.phone_number,
          role_title: i.role_title, allowed_modules: i.allowed_modules || [],
          status: i.status, expires_at: i.expires_at,
        })),
        note: "Phone is identity; modules are access. Pending invites are not yet verified staff.",
      });
    } catch (e) {
      console.error("team roster error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /properties/:propertyId/team-invites
  // Add a team member by phone. Creates a real invite row + token + hashed
  // OTP. Sends the SMS link if a transport is wired; otherwise returns the
  // code under dev_code for testing (the proven pre-Twilio path).
  // Body: { name, phone_number, email?, role_title, allowed_modules[],
  //         scope_type?, backup_user_id?, escalates_to_user_id?,
  //         can_manage_roles?, invited_by_user_id? }
  // ──────────────────────────────────────────────────────────────────
  router.post("/properties/:propertyId/team-invites", async (req, res) => {
    const propertyId = req.params.propertyId;
    const b = req.body || {};
    const phone = normPhone(b.phone_number);
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: "name is required" });
    if (phone.length < 10) return res.status(400).json({ error: "a valid phone_number is required — phone is the identity" });

    const modules = validModules(b.allowed_modules);
    if (modules.length === 0) return res.status(400).json({ error: "allowed_modules must include at least one of", allowed: MODULES });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const prop = (await client.query("select id from properties where id=$1", [propertyId])).rows[0];
      if (!prop) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }

      // supersede any live invite for this phone+property — never two live links
      await client.query(
        `update team_invites set status='superseded'
          where property_id=$1 and phone_number=$2 and status='active'`,
        [propertyId, phone]);

      const token = randToken();
      const code = sixDigit();
      const now = new Date();
      const inviteExp = new Date(now.getTime() + INVITE_TTL_MIN * 60000);
      const otpExp = new Date(now.getTime() + OTP_TTL_MIN * 60000);

      const ins = await client.query(
        `insert into team_invites
           (property_id, phone_number, invited_name, role_title, allowed_modules,
            scope_type, backup_user_id, escalates_to_user_id, can_manage_roles,
            invited_by_user_id, token, status,
            otp_hash, otp_expires_at, otp_sent_at, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15)
         returning id`,
        [propertyId, phone, b.name.trim(), b.role_title || "Team member", modules,
         b.scope_type || "property", b.backup_user_id || null, b.escalates_to_user_id || null,
         b.can_manage_roles === true, b.invited_by_user_id || null, token,
         sha(code), otpExp, now, inviteExp]);
      const inviteId = ins.rows[0].id;

      // send the SMS link if a transport is wired. The link carries the token;
      // the code is texted separately on /auth/sms/start at tap-time. For the
      // invite text we include the link + first code together (one message).
      const base = process.env.APP_BASE_URL || "";
      const link = base ? `${base}/t/team/${token}` : `/t/team/${token}`;
      let smsSent = false, smsError = null;
      if (sms && typeof sms.sendSms === "function") {
        const fromNum = (await client.query(
          "select sms_number from properties where id=$1", [propertyId])).rows[0]?.sms_number || process.env.TWILIO_FROM;
        if (fromNum) {
          try {
            await sms.sendSms({ to: "+1" + phone, from: fromNum,
              body: `You've been added to the team on Property Spine. Tap to set up: ${link} — code ${code}` });
            smsSent = true;
          } catch (e) { smsError = e.message; }
        } else { smsError = "no sms_number on property and no TWILIO_FROM"; }
      }

      await client.query("commit");
      return res.status(201).json({
        receipt: smsSent ? "Text invite sent." : "Invite created (SMS not sent — dev_code path).",
        invite_id: inviteId,
        status: "pending",
        link,
        sms_sent: smsSent,
        sms_error: smsError,
        // shown only while SMS is not live — the proven pre-Twilio testing path
        dev_code: smsSent ? undefined : code,
        note: smsSent ? undefined : "SMS transport not wired/active — code returned here for testing. Wire deps.sms + APP_BASE_URL + property sms_number to go live.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("team-invite error", e);
      return res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /auth/sms/start   { token }   (or { phone_number, property_id })
  // (Re)issues a fresh OTP for an active invite and texts it (or dev_code).
  // ──────────────────────────────────────────────────────────────────
  router.post("/auth/sms/start", async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "token is required (from the invite link)" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inv = (await client.query(
        "select * from team_invites where token=$1 for update", [token])).rows[0];
      if (!inv) { await client.query("rollback"); return res.status(404).json({ error: "invite not found" }); }
      if (inv.status !== "active") { await client.query("rollback"); return res.status(409).json({ error: `invite is ${inv.status}` }); }
      if (new Date(inv.expires_at).getTime() < Date.now()) {
        await client.query("update team_invites set status='expired' where id=$1", [inv.id]);
        await client.query("commit");
        return res.status(409).json({ error: "invite expired" });
      }
      // rate-limit resends: one code per 30s
      if (inv.otp_sent_at && Date.now() - new Date(inv.otp_sent_at).getTime() < 30000) {
        await client.query("rollback");
        return res.status(429).json({ error: "code just sent — wait a moment before requesting another" });
      }
      const code = sixDigit();
      const otpExp = new Date(Date.now() + OTP_TTL_MIN * 60000);
      await client.query(
        "update team_invites set otp_hash=$1, otp_expires_at=$2, otp_sent_at=now() where id=$3",
        [sha(code), otpExp, inv.id]);

      let smsSent = false, smsError = null;
      if (sms && typeof sms.sendSms === "function") {
        const fromNum = (await client.query(
          "select sms_number from properties where id=$1", [inv.property_id])).rows[0]?.sms_number || process.env.TWILIO_FROM;
        if (fromNum) {
          try { await sms.sendSms({ to: "+1" + inv.phone_number, from: fromNum,
            body: `Your Property Spine login code is ${code}` }); smsSent = true; }
          catch (e) { smsError = e.message; }
        } else { smsError = "no sms_number and no TWILIO_FROM"; }
      }
      await client.query("commit");
      return res.json({
        receipt: smsSent ? "Code sent." : "Code generated (dev_code path).",
        sms_sent: smsSent, sms_error: smsError,
        dev_code: smsSent ? undefined : code,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("sms start error", e);
      return res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /auth/sms/verify   { token, code }
  // Verifies the code, resolves identity BY PHONE (creating the user row on
  // first verify), applies the invited access as a real assignment, and
  // issues a scoped staff session. The whole accept is one transaction.
  // ──────────────────────────────────────────────────────────────────
  router.post("/auth/sms/verify", async (req, res) => {
    const { token, code } = req.body || {};
    if (!token || !code) return res.status(400).json({ error: "token and code are required" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inv = (await client.query(
        "select * from team_invites where token=$1 for update", [token])).rows[0];
      if (!inv) { await client.query("rollback"); return res.status(404).json({ error: "invite not found" }); }
      if (inv.status !== "active") { await client.query("rollback"); return res.status(409).json({ error: `invite is ${inv.status}` }); }
      if (!inv.otp_hash || new Date(inv.otp_expires_at).getTime() < Date.now()) {
        await client.query("rollback");
        return res.status(409).json({ error: "no current code — request a new one via /auth/sms/start" });
      }
      if (inv.failed_attempts >= MAX_FAILS) {
        await client.query("update team_invites set status='revoked' where id=$1", [inv.id]);
        await client.query("commit");
        return res.status(423).json({ error: "too many wrong codes — invite revoked. Ask your manager to resend." });
      }
      if (sha(code) !== inv.otp_hash) {
        await client.query("update team_invites set failed_attempts = failed_attempts + 1 where id=$1", [inv.id]);
        await client.query("commit");
        return res.status(401).json({ error: "wrong code", attempts_left: MAX_FAILS - inv.failed_attempts - 1 });
      }

      // CODE OK. Resolve the staff user by normalized phone — create on first.
      const phone = inv.phone_number;
      let user = (await client.query(
        `select * from users
          where regexp_replace(phone, '\\D', '', 'g') = $1
             or regexp_replace(phone, '\\D', '', 'g') = '1' || $1
          limit 1`, [phone])).rows[0];
      if (!user) {
        user = (await client.query(
          `insert into users (name, phone, role, auth_provider, phone_verified_at, status)
           values ($1,$2,$3,'phone_otp',now(),'active') returning *`,
          [inv.invited_name || "Team member", "+1" + phone, "property_manager"])).rows[0];
      } else if (!user.phone_verified_at) {
        await client.query("update users set phone_verified_at=now(), status='active' where id=$1", [user.id]);
      }

      // apply the invited access as a real assignment (upsert on user+property)
      await client.query(
        `insert into property_team_assignments
           (property_id, user_id, role_title, scope_type, allowed_modules,
            primary_for_modules, backup_user_id, escalates_to_user_id, can_manage_roles)
         values ($1,$2,$3,$4,$5,$5,$6,$7,$8)
         on conflict (property_id, user_id) do update set
           role_title = excluded.role_title,
           scope_type = excluded.scope_type,
           allowed_modules = excluded.allowed_modules,
           primary_for_modules = excluded.primary_for_modules,
           backup_user_id = excluded.backup_user_id,
           escalates_to_user_id = excluded.escalates_to_user_id,
           can_manage_roles = excluded.can_manage_roles,
           active = true, updated_at = now()`,
        [inv.property_id, user.id, inv.role_title || "Team member", inv.scope_type || "property",
         inv.allowed_modules || [], inv.backup_user_id, inv.escalates_to_user_id, inv.can_manage_roles]);

      // mark the invite accepted, issue a scoped session
      await client.query(
        "update team_invites set status='accepted', accepted_at=now(), accepted_user_id=$1 where id=$2",
        [user.id, inv.id]);
      const sessTok = randToken();
      const sessExp = new Date(Date.now() + SESSION_TTL_DAYS * 86400000);
      await client.query(
        `insert into staff_sessions (user_id, property_id, token, expires_at)
         values ($1,$2,$3,$4)`, [user.id, inv.property_id, sessTok, sessExp]);

      const allowed = inv.allowed_modules || [];
      await client.query("commit");
      return res.json({
        receipt: `Welcome, ${user.name}. You're verified.`,
        session_token: sessTok,
        user: { id: user.id, name: user.name, phone: user.phone },
        property_id: inv.property_id,
        allowed_modules: allowed,
        landing_module: landingModule(allowed),
        note: "Send session_token as x-session-token on subsequent requests. High-risk actions will require a fresh code (follow-on).",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("sms verify error", e);
      return res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /properties/:propertyId/my-access   (header: x-session-token)
  // What the front end filters the dashboard on. Resolves the session,
  // returns the user's access at this property + the landing module.
  // ──────────────────────────────────────────────────────────────────
  router.get("/properties/:propertyId/my-access", async (req, res) => {
    const tok = req.headers["x-session-token"];
    if (!tok) return res.status(401).json({ error: "x-session-token required" });
    try {
      const sess = (await pool.query(
        `select s.*, u.name, u.phone from staff_sessions s
           join users u on u.id = s.user_id
          where s.token=$1 and s.revoked=false and s.expires_at > now()`, [tok])).rows[0];
      if (!sess) return res.status(401).json({ error: "session invalid or expired" });
      if (sess.property_id !== req.params.propertyId) {
        return res.status(403).json({ error: "session is scoped to a different property" });
      }
      const a = (await pool.query(
        `select role_title, allowed_modules, can_manage_roles
           from property_team_assignments
          where property_id=$1 and user_id=$2 and active=true`,
        [req.params.propertyId, sess.user_id])).rows[0];
      if (!a) return res.status(403).json({ error: "no active assignment for this user at this property" });
      const allowed = a.allowed_modules || [];
      return res.json({
        user: { id: sess.user_id, name: sess.name, phone: sess.phone },
        property_id: req.params.propertyId,
        role_title: a.role_title,
        allowed_modules: allowed,
        can_manage_roles: a.can_manage_roles,
        landing_module: landingModule(allowed),
      });
    } catch (e) {
      console.error("my-access error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // PATCH /property-team-assignments/:assignmentId
  // An authorized manager changes access after onboarding. (High-risk: a
  // fresh-code gate belongs here later; for now it's operator-key guarded
  // like the rest of the operator surface.)
  // Body: any of { role_title, allowed_modules, primary_for_modules,
  //   backup_user_id, escalates_to_user_id, can_manage_roles, active }
  // ──────────────────────────────────────────────────────────────────
  router.patch("/property-team-assignments/:assignmentId", async (req, res) => {
    const b = req.body || {};
    const sets = [], vals = [];
    let i = 1;
    const add = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
    if (b.role_title != null) add("role_title", String(b.role_title));
    if (b.allowed_modules != null) add("allowed_modules", validModules(b.allowed_modules));
    if (b.primary_for_modules != null) add("primary_for_modules", validModules(b.primary_for_modules));
    if (b.backup_user_id !== undefined) add("backup_user_id", b.backup_user_id || null);
    if (b.escalates_to_user_id !== undefined) add("escalates_to_user_id", b.escalates_to_user_id || null);
    if (b.can_manage_roles != null) add("can_manage_roles", b.can_manage_roles === true);
    if (b.active != null) add("active", b.active === true);
    if (sets.length === 0) return res.status(400).json({ error: "no updatable fields supplied" });
    sets.push(`updated_at = now()`);
    vals.push(req.params.assignmentId);
    try {
      const r = await pool.query(
        `update property_team_assignments set ${sets.join(", ")} where id = $${i} returning *`, vals);
      if (r.rowCount === 0) return res.status(404).json({ error: "assignment not found" });
      return res.json({ receipt: "Access updated.", assignment: r.rows[0] });
    } catch (e) {
      console.error("assignment patch error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
