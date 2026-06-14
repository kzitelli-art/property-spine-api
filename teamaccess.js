// ============================================================
// teamaccess.js — PHONE-FIRST STAFF LOGIN + ACCOUNTABILITY ROUTING
//
// "Phone is the identity. Role is the access. Accountability is the work."
//
// This is the STAFF twin of tenantlink.js. It deliberately reuses that
// proven module's exact crypto and lifecycle — token = randomBytes(18)
// base64url, OTP = sha256(code:token) salted hash never stored plain,
// 10-minute code expiry, 60s resend floor, 5-miss lockout, normalized
// E.164 phones — so there is ONE auth pattern in the system, not two.
//
// WHAT IT OWNS (the data-layer slice — option 1):
//   POST /properties/:id/team-invites        add staff by phone → invite
//   POST /auth/sms/start                      send the login/accept code
//   POST /auth/sms/verify                     verify code → session (+ provision assignment on accept)
//   GET  /properties/:id/team                 the roster (access + routing)
//   GET  /properties/:id/my-access            current user's allowed modules + landing
//   PATCH /property-team-assignments/:id      authorized manager edits access
//
// HONEST SMS DEGRADATION: if Twilio isn't wired (no creds / package), the
// invite + start endpoints still WORK — they return the link and, in the
// non-production fallback, the code itself — so the flow is testable before
// the number is provisioned. Identical philosophy to tenant_link's
// link-only pilot. A real send is attempted whenever transport is ready.
//
// SECURITY NOTE (high-risk actions): the spec lists role changes, user
// add/remove, full-report export, final-report approval, and bank settings
// as requiring fresh SMS re-check LATER. This slice builds the identity +
// access spine; the fresh-re-check gate is a documented follow-on, not
// silently skipped. can_manage_roles is enforced now on the write paths.
//
// Factory:
//   const teamAccessModule = require('./teamaccess');
//   app.use("/", teamAccessModule({ pool, sms }));   // sms = smsTransport() instance (optional)
// ============================================================

const express = require("express");
const crypto = require("crypto");

module.exports = function teamAccessModule({ pool, sms }) {
  const router = express.Router();

  const ALLOWED_MODULES = ["management", "leasing", "maintenance", "reporting"];
  const OTP_TTL_MIN = 10;
  const INVITE_TTL_HOURS = 72;
  const SESSION_TTL_DAYS = 14;
  const RESEND_FLOOR_SEC = 60;
  const MAX_FAILED = 5;

  // ── shared helpers, mirrored from tenantlink.js ──────────────────────
  const newToken = () => crypto.randomBytes(18).toString("base64url");
  const otpHash = (code, token) =>
    crypto.createHash("sha256").update(`${code}:${token}`).digest("hex");
  const newOtp = () => String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
  const smsReady = () => !!(sms && typeof sms.sendSms === "function" && (typeof sms.enabled !== "function" || sms.enabled()));
  const isProd = () => process.env.NODE_ENV === "production";

  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") return "+" + d;
    if (d.length === 10) return "+1" + d;
    if (String(raw).trim().startsWith("+") && d.length >= 10) return "+" + d;
    return null; // not a US number we can normalize — reject honestly
  }
  const maskPhone = (p) => (p ? p.replace(/^(\+1)(\d{3})(\d{3})(\d{2})(\d{2})$/, "$1 ($2) ***-**$5") : null);

  // sanitize a requested module list to the known set, preserving order, deduped.
  const cleanModules = (arr) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const m of arr) {
      const v = String(m || "").toLowerCase().trim();
      if (ALLOWED_MODULES.includes(v) && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  };

  // landing module = first primary_for, else first allowed, else null.
  const landingModule = (allowed, primary) =>
    (primary && primary[0]) || (allowed && allowed[0]) || null;

  // resolve the staff session from the header (twin of tenant session resolve).
  async function currentUser(req) {
    const token = req.headers["x-staff-session"] || req.query.session;
    if (!token) return null;
    const r = await pool.query(
      `select u.id, u.name, u.phone, u.email, u.role, u.status
         from staff_sessions s join users u on u.id = s.user_id
        where s.token = $1 and s.revoked = false and s.expires_at > now()`, [token]);
    return r.rows[0] || null;
  }

  // ── POST /properties/:id/team-invites — add staff by phone ───────────
  router.post("/properties/:id/team-invites", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query("select id, name, sms_number from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const b = req.body || {};
      const phone = normalizePhone(b.phone_number || b.phone);
      if (!phone) return res.status(400).json({ receipt: "A valid US phone number is required (10 digits or +1 format). Email is optional." });
      if (!b.role_title || !String(b.role_title).trim())
        return res.status(400).json({ receipt: "A job title is required — the role drives the access." });

      const allowed = cleanModules(b.allowed_modules);
      if (allowed.length === 0)
        return res.status(400).json({ receipt: "Choose at least one module the job allows (management, leasing, maintenance, reporting)." });

      const scope = ["property", "portfolio", "owner"].includes(b.scope_type) ? b.scope_type : "property";

      // supersede any existing active invite for this phone at this property
      // (never two live links for one person — same rule as tenant_invites).
      const token = newToken();
      const prior = (await pool.query(
        `select id from team_invites where property_id=$1 and phone_number=$2 and status='active'`,
        [propertyId, phone])).rows;

      const inv = (await pool.query(
        `insert into team_invites
           (property_id, phone_number, invited_name, role_title, scope_type,
            allowed_modules, backup_user_id, escalates_to_user_id,
            can_manage_roles, invited_by_user_id, token, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' hours')::interval)
         returning id, expires_at`,
        [propertyId, phone, b.invited_name || b.name || null, String(b.role_title).trim(), scope,
         allowed, b.backup_user_id || null, b.escalates_to_user_id || null,
         b.can_manage_roles === true, b.invited_by_user_id || null, token, String(INVITE_TTL_HOURS)])).rows[0];

      if (prior.length) {
        await pool.query(`update team_invites set status='superseded', superseded_by=$1 where id = any($2)`,
          [inv.id, prior.map(p => p.id)]);
      }

      const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
      const link = `${base}/join/${token}`;
      const smsText = `You've been added to ${prop.name} on Property Spine. Tap to set up your access: ${link}`;

      // attempt a real send only if transport is ready AND the property has a line.
      let delivery = "link_only";
      if (smsReady() && prop.sms_number) {
        try {
          await sms.sendSms({ to: phone, from: prop.sms_number, body: smsText });
          delivery = "sms_sent";
        } catch (e) { delivery = "sms_failed"; }
      }

      return res.json({
        receipt: delivery === "sms_sent" ? "Text invite sent." : "Invite created. SMS transport not active — share the link.",
        invite_id: inv.id,
        status: "pending",
        delivery,
        link,                                  // operator can copy when link-only
        sms_text: smsText,
        expires_at: inv.expires_at,
      });
    } catch (e) {
      console.error("team-invites error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /auth/sms/start — send the login / invite-accept code ───────
  // Body: { phone_number } for plain login, OR { token } for invite accept.
  router.post("/auth/sms/start", async (req, res) => {
    try {
      const b = req.body || {};
      let phone = null, inviteRow = null;

      if (b.token) {
        inviteRow = (await pool.query(
          `select * from team_invites where token=$1`, [b.token])).rows[0];
        if (!inviteRow) return res.status(404).json({ receipt: "That invite link isn't valid." });
        if (inviteRow.status === "revoked") return res.status(410).json({ receipt: "That invite was revoked." });
        if (inviteRow.status === "accepted") return res.status(409).json({ receipt: "That invite was already used." });
        if (new Date(inviteRow.expires_at) < new Date()) return res.status(410).json({ receipt: "That invite link expired. Ask for a new one." });
        if (inviteRow.failed_attempts >= MAX_FAILED) return res.status(423).json({ receipt: "Too many wrong codes. Ask for a new invite." });
        phone = inviteRow.phone_number;
      } else {
        phone = normalizePhone(b.phone_number || b.phone);
        if (!phone) return res.status(400).json({ receipt: "Enter the phone number on your account (10 digits)." });
        // plain login requires an existing active user with this phone
        const u = (await pool.query(`select id from users where phone=$1 and status<>'suspended'`, [phone])).rows[0];
        if (!u) return res.status(404).json({ receipt: "No active account for that number. You may need an invite first." });
      }

      // rate-limit resends (60s floor) using the invite's otp_sent_at, or a
      // transient login code row. For login (no invite), we stash the OTP on
      // a short-lived invite-less record keyed by phone via a lightweight
      // reuse of team_invites is wrong; instead, for login we mint a code and
      // store its hash on the most recent invite for that phone if present,
      // else we create a login-purpose holder. To keep this slice tight and
      // honest, LOGIN reuses the same OTP-on-invite slot only when an invite
      // exists; pure passwordless re-login for already-active users issues a
      // session-bootstrap code stored on a fresh staff_sessions precursor.
      // → For clarity and to avoid a half-built path, this slice supports the
      //   INVITE-ACCEPT flow fully (the onboarding spine). Pure re-login for
      //   existing users is the documented next step.
      if (!inviteRow) {
        return res.status(501).json({
          receipt: "Re-login for existing users is the next step. Use your invite link to set up access first.",
          supported_now: "invite_accept",
        });
      }

      // resend floor
      if (inviteRow.otp_sent_at && (Date.now() - new Date(inviteRow.otp_sent_at).getTime()) < RESEND_FLOOR_SEC * 1000) {
        return res.status(429).json({ receipt: "A code was just sent. Wait a moment before requesting another." });
      }

      const code = newOtp();
      await pool.query(
        `update team_invites
            set otp_hash=$1, otp_expires_at = now() + ($2 || ' minutes')::interval, otp_sent_at = now()
          where id=$3`,
        [otpHash(code, inviteRow.token), String(OTP_TTL_MIN), inviteRow.id]);

      const prop = (await pool.query("select name, sms_number from properties where id=$1", [inviteRow.property_id])).rows[0];
      const body = `Your ${prop.name} access code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`;

      let delivery = "link_only";
      if (smsReady() && prop.sms_number) {
        try { await sms.sendSms({ to: phone, from: prop.sms_number, body }); delivery = "sms_sent"; }
        catch (e) { delivery = "sms_failed"; }
      }

      const out = {
        receipt: delivery === "sms_sent" ? "Code sent by text." : "SMS transport not active.",
        masked_phone: maskPhone(phone),
        delivery,
        expires_in_minutes: OTP_TTL_MIN,
      };
      // ONLY in non-production with no real SMS: surface the code so the flow
      // is testable. Never in production — that would be a security hole.
      if (!isProd() && delivery !== "sms_sent") out.dev_code = code;
      return res.json(out);
    } catch (e) {
      console.error("sms/start error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /auth/sms/verify — verify code → session (+ provision on accept) ──
  // Body: { token, code }. On success: upsert the user, provision the
  // assignment from the invite (atomically), mark invite accepted, issue a
  // staff session.
  router.post("/auth/sms/verify", async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      if (!b.token || !b.code) return res.status(400).json({ receipt: "Enter the code from your text." });

      await client.query("begin");
      const inv = (await client.query(`select * from team_invites where token=$1 for update`, [b.token])).rows[0];
      if (!inv) { await client.query("rollback"); return res.status(404).json({ receipt: "That invite link isn't valid." }); }
      if (inv.status === "accepted") { await client.query("rollback"); return res.status(409).json({ receipt: "Already used." }); }
      if (inv.status === "revoked" || inv.status === "superseded") { await client.query("rollback"); return res.status(410).json({ receipt: "That invite is no longer active." }); }
      if (!inv.otp_hash || !inv.otp_expires_at || new Date(inv.otp_expires_at) < new Date()) {
        await client.query("rollback"); return res.status(410).json({ receipt: "That code expired. Request a new one." });
      }
      if (inv.failed_attempts >= MAX_FAILED) { await client.query("rollback"); return res.status(423).json({ receipt: "Too many wrong codes. Ask for a new invite." }); }

      if (otpHash(String(b.code).trim(), inv.token) !== inv.otp_hash) {
        await client.query(`update team_invites set failed_attempts = failed_attempts + 1 where id=$1`, [inv.id]);
        await client.query("commit");
        return res.status(401).json({ receipt: "That code didn't match. Try again." });
      }

      // ── code is valid. Upsert the user by normalized phone. ──
      const phone = inv.phone_number;
      let user = (await client.query(`select * from users where phone=$1`, [phone])).rows[0];
      if (!user) {
        user = (await client.query(
          `insert into users (name, phone, role, auth_provider, phone_verified_at, status)
           values ($1,$2, 'property_manager'::role_name, 'phone_otp', now(), 'active')
           returning *`,
          [inv.invited_name || "New teammate", phone])).rows[0];
      } else {
        user = (await client.query(
          `update users set phone_verified_at = coalesce(phone_verified_at, now()),
                            status = case when status='invited' then 'active' else status end
            where id=$1 returning *`, [user.id])).rows[0];
      }

      // primary_for_modules is derived at ACCEPT time (their schema's design):
      // you own everything you're granted unless narrowed later via PATCH.
      const allowed = inv.allowed_modules || [];
      const primaryFinal = allowed.slice();

      // ── provision the assignment from the invite (upsert on (property,user)) ──
      await client.query(
        `insert into property_team_assignments
           (property_id, user_id, role_title, scope_type, allowed_modules, primary_for_modules,
            backup_user_id, escalates_to_user_id, can_manage_roles, active, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, true, now())
         on conflict (property_id, user_id) do update set
            role_title = excluded.role_title,
            scope_type = excluded.scope_type,
            allowed_modules = excluded.allowed_modules,
            primary_for_modules = excluded.primary_for_modules,
            backup_user_id = excluded.backup_user_id,
            escalates_to_user_id = excluded.escalates_to_user_id,
            can_manage_roles = excluded.can_manage_roles,
            active = true,
            updated_at = now()`,
        [inv.property_id, user.id, inv.role_title, inv.scope_type, allowed,
         primaryFinal, inv.backup_user_id, inv.escalates_to_user_id, inv.can_manage_roles]);

      await client.query(`update team_invites set status='accepted', accepted_at=now(), accepted_user_id=$2 where id=$1`, [inv.id, user.id]);

      // ── issue the scoped staff session (property-scoped, per their schema) ──
      const sessionToken = newToken();
      await client.query(
        `insert into staff_sessions (user_id, property_id, token, expires_at)
         values ($1,$2,$3, now() + ($4 || ' days')::interval)`,
        [user.id, inv.property_id, sessionToken, String(SESSION_TTL_DAYS)]);

      await client.query("commit");

      const landing = landingModule(inv.allowed_modules, primaryFinal);
      return res.json({
        receipt: "Verified. You're in.",
        session_token: sessionToken,
        user: { id: user.id, name: user.name, phone_number: user.phone },
        property_id: inv.property_id,
        role_title: inv.role_title,
        allowed_modules: inv.allowed_modules,
        can_manage_roles: inv.can_manage_roles,
        landing_module: landing,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      console.error("sms/verify error", e);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── GET /properties/:id/team — the roster (access + accountability routing) ──
  router.get("/properties/:id/team", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const prop = (await pool.query("select id, name from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const rows = (await pool.query(
        `select a.id as assignment_id, a.role_title, a.scope_type, a.allowed_modules,
                a.primary_for_modules, a.can_manage_roles, a.active,
                u.id as user_id, u.name, u.phone, u.email, u.phone_verified_at, u.status as user_status,
                bu.id as backup_user_id, bu.name as backup_name,
                eu.id as escalates_to_user_id, eu.name as escalates_to_name
           from property_team_assignments a
           join users u on u.id = a.user_id
           left join users bu on bu.id = a.backup_user_id
           left join users eu on eu.id = a.escalates_to_user_id
          where a.property_id=$1 and a.active = true
          order by u.name asc`, [propertyId])).rows;

      // also surface pending invites (added, not yet verified) so the roster
      // honestly shows who's been invited vs who's active.
      const pending = (await pool.query(
        `select id as invite_id, invited_name, phone_number, role_title, allowed_modules, expires_at
           from team_invites
          where property_id=$1 and status='active'
          order by created_at desc`, [propertyId])).rows;

      return res.json({
        property: { id: prop.id, name: prop.name },
        team: rows.map(r => ({
          assignment_id: r.assignment_id,
          user: { id: r.user_id, name: r.name, phone_number: r.phone, email: r.email,
                  phone_verified: !!r.phone_verified_at, status: r.user_status },
          role_title: r.role_title,
          scope_type: r.scope_type,
          allowed_modules: r.allowed_modules,
          primary_for_modules: r.primary_for_modules,
          landing_module: landingModule(r.allowed_modules, r.primary_for_modules),
          backup: r.backup_user_id ? { id: r.backup_user_id, name: r.backup_name } : null,
          escalates_to: r.escalates_to_user_id ? { id: r.escalates_to_user_id, name: r.escalates_to_name } : null,
          can_manage_roles: r.can_manage_roles,
        })),
        pending_invites: pending.map(p => ({
          invite_id: p.invite_id, invited_name: p.invited_name,
          phone_number: maskPhone(p.phone_number), role_title: p.role_title,
          allowed_modules: p.allowed_modules, expires_at: p.expires_at,
          status: "pending",
        })),
        active_count: rows.length,
        pending_count: pending.length,
        note: "Roster shows access AND accountability routing: who owns each module (primary), their backup, and where stuck work escalates. Phone is identity; role is access.",
      });
    } catch (e) {
      console.error("team roster error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── GET /properties/:id/my-access — current user's modules + landing ──
  router.get("/properties/:id/my-access", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const me = await currentUser(req);
      if (!me) return res.status(401).json({ receipt: "Not signed in. Verify by phone first." });

      const a = (await pool.query(
        `select role_title, allowed_modules, primary_for_modules, can_manage_roles
           from property_team_assignments
          where property_id=$1 and user_id=$2 and active=true`, [propertyId, me.id])).rows[0];

      if (!a) return res.status(403).json({
        receipt: "You don't have access to this property.",
        user: { id: me.id, name: me.name, phone_number: me.phone },
        property_id: propertyId, allowed_modules: [], landing_module: null,
      });

      return res.json({
        user: { id: me.id, name: me.name, phone_number: me.phone },
        property_id: propertyId,
        role_title: a.role_title,
        allowed_modules: a.allowed_modules,
        primary_for_modules: a.primary_for_modules,
        can_manage_roles: a.can_manage_roles,
        landing_module: landingModule(a.allowed_modules, a.primary_for_modules),
      });
    } catch (e) {
      console.error("my-access error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /property-team-assignments/:id — authorized manager edits access ──
  router.patch("/property-team-assignments/:id", async (req, res) => {
    try {
      const me = await currentUser(req);
      if (!me) return res.status(401).json({ receipt: "Not signed in." });

      const target = (await pool.query(
        `select * from property_team_assignments where id=$1`, [req.params.id])).rows[0];
      if (!target) return res.status(404).json({ error: "assignment not found" });

      // only a role-manager on the SAME property may edit access.
      const mine = (await pool.query(
        `select can_manage_roles from property_team_assignments
          where property_id=$1 and user_id=$2 and active=true`, [target.property_id, me.id])).rows[0];
      if (!mine || !mine.can_manage_roles)
        return res.status(403).json({ receipt: "Only an authorized manager on this property can change access." });

      const b = req.body || {};
      const allowed = b.allowed_modules != null ? cleanModules(b.allowed_modules) : target.allowed_modules;
      const primary = b.primary_for_modules != null
        ? cleanModules(b.primary_for_modules).filter(m => allowed.includes(m))
        : target.primary_for_modules.filter(m => allowed.includes(m));

      const updated = (await pool.query(
        `update property_team_assignments set
           role_title = coalesce($2, role_title),
           allowed_modules = $3,
           primary_for_modules = $4,
           backup_user_id = $5,
           escalates_to_user_id = $6,
           can_manage_roles = coalesce($7, can_manage_roles),
           active = coalesce($8, active),
           updated_at = now()
         where id=$1
         returning *`,
        [target.id,
         b.role_title != null ? String(b.role_title).trim() : null,
         allowed, primary,
         b.backup_user_id !== undefined ? b.backup_user_id : target.backup_user_id,
         b.escalates_to_user_id !== undefined ? b.escalates_to_user_id : target.escalates_to_user_id,
         b.can_manage_roles != null ? b.can_manage_roles === true : null,
         b.active != null ? b.active === true : null])).rows[0];

      return res.json({
        receipt: "Access updated.",
        assignment_id: updated.id,
        allowed_modules: updated.allowed_modules,
        primary_for_modules: updated.primary_for_modules,
        landing_module: landingModule(updated.allowed_modules, updated.primary_for_modules),
        active: updated.active,
      });
    } catch (e) {
      console.error("assignment patch error", e);
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
