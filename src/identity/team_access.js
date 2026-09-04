// ============================================================
// team_access.js — PHONE-FIRST STAFF LOGIN + ACCOUNTABILITY ROUTING
//
// "Phone is the identity. Role is the access. Accountability is the work."
//
// This is the STAFF twin of tenant_link.js. It deliberately reuses that
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
// HONEST SMS DEGRADATION: if Twilio isn't wired (no creds / package), invite
// creation can still return its link. The sign-in endpoint returns a code only
// outside production so the flow remains testable. Production never claims a
// code was sent unless the transport accepted it.
//
// SECURITY NOTE (high-risk actions): the spec lists role changes, user
// add/remove, full-report export, final-report approval, and bank settings
// as requiring fresh SMS re-check LATER. This slice builds the identity +
// access spine; the fresh-re-check gate is a documented follow-on, not
// silently skipped. can_manage_roles is enforced now on the write paths.
//
// Factory:
//   const teamAccessModule = require('./team_access');
//   app.use("/", teamAccessModule({ pool, sms }));   // sms = smsTransport() instance (optional)
// ============================================================

const express = require("express");
const crypto = require("crypto");

const staffSessions = require("./staff_session_service.js"); // BRICK ONE: the ONE issuer/resolver/revoke

module.exports = function teamAccessModule({ pool, sms, commBoundary }) {
  const router = express.Router();

  //  THE OPERATOR MODULE VOCABULARY.
  //
  //  `asset_management` is the fourth operating door (Leasing · Management ·
  //  Maintenance · Asset Management) and is a MODULE ENTITLEMENT, not a job
  //  title. Holding it is what opens /operator/asset-management/*; being
  //  called an asset manager is a separate organizational fact and grants
  //  nothing on its own.
  //
  //  The future Owner / Investor surface is a DIFFERENT audience and must
  //  NOT reuse this entitlement merely because it consumes this door's truth.
  const ALLOWED_MODULES = ["management", "leasing", "maintenance", "reporting", "asset_management"];
  const OTP_TTL_MIN = 10;
  const INVITE_TTL_HOURS = 72;
  const SESSION_TTL_DAYS = 14;
  const RESEND_FLOOR_SEC = 60;
  const MAX_FAILED = 5;

  // ── shared helpers, mirrored from tenant_link.js ──────────────────────
  const newToken = () => crypto.randomBytes(18).toString("base64url");
  const otpHash = (code, token) =>
    crypto.createHash("sha256").update(`${code}:${token}`).digest("hex");
  const newOtp = () => String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
  const smsReady = () => !!(sms && typeof sms.sendSms === "function" && (typeof sms.enabled !== "function" || sms.enabled()));
  //  FAIL CLOSED. Nothing in this repository sets NODE_ENV (not the
  //  Dockerfile, compose, deploy.sh or the deployment doc), so "not
  //  production" was true wherever nobody remembered to set it — and this
  //  flag decides whether the sign-in code is echoed back to the caller.
  //  Production is the default; a debug posture must be asked for by name.
  const isProd = () => !["development", "test"].includes(String(process.env.NODE_ENV || "").toLowerCase());

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
    // BRICK ONE: shared live resolver, HEADER-ONLY (the ?session= query
    // path is deleted  tokens never belong in URLs). Returns live
    // property_id / role_title / allowed_modules / can_manage_roles.
    return staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
  }

  // ── POST /properties/:id/team-invites — add staff by phone ───────────
  //  ── BUILD 1A-2: THE GRANTING ACTOR IS DERIVED, NEVER SUPPLIED ─────
  //  This route grants module-level access to a property. It used to sit
  //  behind the shared OPERATOR_KEY alone, take the property from the URL
  //  with nothing but an existence check, and record the granting actor
  //  from `req.body.invited_by_user_id` — defaulting to NULL. So the
  //  record of WHO conferred access was written by the caller, and could
  //  be nobody. That is §21 exactly inverted: the browser was deciding.
  //
  //  Now: the session is the actor, and the session's holder must hold
  //  authority AT THIS PROPERTY. Three ways to hold it, all server-read:
  //    · super_admin                                    (spans all orgs)
  //    · org_admin of the organization owning it        (their client)
  //    · an active assignment here with can_manage_roles
  //
  //  ── A BODY ACTOR FIELD IS REJECTED, NOT IGNORED ──────────────────
  //  This route first shipped ignoring `invited_by_user_id`, on the
  //  reasoning that a caller sending the right value should not be
  //  punished. That contradicts the house rule already frozen by the
  //  write-authority hardening packet (PR #38,
  //  docs/WRITE_AUTHORITY_HARDENING_INVENTORY.md §6):
  //
  //    "Body actor fields will be REJECTED, not ignored: a caller sending
  //     approved_by is either a stale client or an attempt, and both
  //     deserve a 400 rather than silent substitution. Silent ignoring
  //     would let a stale app keep sending a field it believes is
  //     honoured."
  //
  //  That reason is better than the original one: silently ignoring means
  //  the broken client never finds out, and the next person reading it
  //  believes the field still matters. Nothing in the app sends this
  //  field, so rejecting costs no live caller.
  router.post("/properties/:id/team-invites", async (req, res) => {
    const propertyId = req.params.id;
    try {
      const session = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
      if (!session) {
        return res.status(401).json({
          error: "A staff session is required to invite someone to a property.",
          reason: "no_authenticated_actor",
          receipt: "Send x-staff-session. The operator key authenticates the caller, not the " +
                   "human — and an access grant records who granted it.",
        });
      }

      const prop = (await pool.query(
        "select id, name, sms_number, organization_id from properties where id=$1", [propertyId])).rows[0];
      if (!prop) return res.status(404).json({ error: "property not found" });

      const actor = (await pool.query(
        `select platform_role, organization_id from users where id = $1`, [session.id])).rows[0];
      const here = (await pool.query(
        `select can_manage_roles from property_team_assignments
          where property_id = $1 and user_id = $2 and active = true`,
        [propertyId, session.id])).rows[0];

      const basis =
        actor && actor.platform_role === "super_admin" ? "platform_role:super_admin"
        : actor && actor.platform_role === "org_admin" && actor.organization_id
            && prop.organization_id
            && String(actor.organization_id) === String(prop.organization_id)
          ? "platform_role:org_admin"
        : here && here.can_manage_roles === true ? "assignment:can_manage_roles"
        : null;

      if (!basis) {
        //  Named plainly rather than opaquely: this is an operator surface,
        //  and "you are signed in but not for this building" is the useful
        //  answer. It reveals nothing the caller could not learn by asking
        //  for their own access.
        return res.status(403).json({
          error: "You do not have authority to grant access at this property.",
          reason: "insufficient_property_authority",
          receipt: "Granting access needs super-admin, org-admin of this property's " +
                   "organization, or an assignment here that can manage roles.",
        });
      }

      const b = req.body || {};

      //  Rejected, not ignored — see the note above the route.
      if (Object.prototype.hasOwnProperty.call(b, "invited_by_user_id")) {
        return res.status(400).json({
          error: "invited_by_user_id is not accepted. The granting actor is the signed-in operator.",
          reason: "body_actor_field_rejected",
          receipt: "Remove invited_by_user_id from the request. Who granted access is " +
                   "derived from the session, so a body value could only ever disagree with it.",
        });
      }

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
         b.can_manage_roles === true, session.id, token, String(INVITE_TTL_HOURS)])).rows[0];

      if (prior.length) {
        await pool.query(`update team_invites set status='superseded', superseded_by=$1 where id = any($2)`,
          [inv.id, prior.map(p => p.id)]);
      }

      const base = process.env.APP_BASE_URL || `https://${req.headers.host}`;
      const link = `${base}/join/${token}`;
      const smsText = `You've been added to ${prop.name} on Property Spine. Tap to set up your access: ${link}`;

      // COMMUNICATIONS BOUNDARY: staff-invite is explicitly classified
      // credential transport (purpose='staff_invite'); the gate derives
      // the property line server-side and refuses honestly without one.
      let delivery = "link_only";
      {
        const wire = await commBoundary.sendPropertySms({
          property_id: inv.property_id, recipient: phone, body: smsText,
          purpose: "staff_invite",
        });
        if (wire.sent) delivery = "sms_sent";
        else if (!["transport_not_configured", "no_property_line", "send_mode_disabled"].includes(wire.reason)) delivery = "sms_failed";
      }

      return res.json({
        receipt: delivery === "sms_sent" ? "Text invite sent." : "Invite created. SMS transport not active — share the link.",
        invite_id: inv.id,
        status: "pending",
        delivery,
        link,                                  // operator can copy when link-only
        sms_text: smsText,
        expires_at: inv.expires_at,
        //  The grant's provenance, visible at the point it is made.
        granted_by_user_id: session.id,
        authority_basis: basis,
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
        //  A superseded invite was refused at /verify but still SENT a code
        //  here — a real text for a link that could never succeed.
        if (inviteRow.status === "superseded") return res.status(410).json({ receipt: "That invite was replaced by a newer one. Use the latest link you were sent." });
        if (inviteRow.status === "accepted") return res.status(409).json({ receipt: "That invite was already used." });
        if (new Date(inviteRow.expires_at) < new Date()) return res.status(410).json({ receipt: "That invite link expired. Ask for a new one." });
        if (inviteRow.failed_attempts >= MAX_FAILED) return res.status(423).json({ receipt: "Too many wrong codes. Ask for a new invite." });
        phone = inviteRow.phone_number;
      } else {
        // ── RE-LOGIN for an already-onboarded staff member ──────────────
        // No invite token: this is a returning user logging back in by phone.
        // We reuse the SAME proven OTP machinery (don't fork it) by minting a
        // short-lived, login-PURPOSE team_invites row for this user. The invite
        // table IS the OTP holder; a re-login is just a system-generated invite
        // for someone who already exists. The structural marker that makes it a
        // re-login (not an onboarding invite) is: accepted_user_id is set to the
        // user AT CREATION, and allowed_modules is left empty — because the
        // user's LIVE assignment is the source of truth for access, never this
        // synthetic row. /verify reads that marker and the live assignment.
        phone = normalizePhone(b.phone_number || b.phone);
        if (!phone) return res.status(400).json({ receipt: "Enter the phone number on your account (10 digits)." });

        const u = (await pool.query(
          `select id, name from users where phone=$1 and status<>'suspended'`, [phone])).rows[0];
        if (!u) return res.status(404).json({ receipt: "No active account for that number. You may need an invite first." });

        // they must own access to at least one property — otherwise there is
        // nothing to log into. Scope the login to a property they're active on.
        // (Single-session-per-verify is the schema's model; a stuck multi-
        // property picker is a later step — for now, land them on a property
        // they own. A deliverable credential channel comes first; within that
        // set, prefer one where they can manage roles.)
        const a = (await pool.query(
          `select a.property_id,
                  nullif(btrim(p.sms_number), '') is not null as sms_ready
             from property_team_assignments a
             join properties p on p.id = a.property_id
            where a.user_id=$1 and a.active=true
            order by (nullif(btrim(p.sms_number), '') is not null) desc,
                     a.can_manage_roles desc, a.updated_at desc
            limit 1`, [u.id])).rows[0];
        if (!a) return res.status(403).json({
          receipt: "Your account exists but isn't assigned to a property yet. Ask a manager to add you.",
        });
        if (!a.sms_ready) return res.status(503).json({
          receipt: "SMS sign-in is not configured for any property assigned to your account.",
          delivery: "not_configured",
        });

        // resend floor for re-login: if a live login invite for this phone
        // already has a fresh code, don't mint another (same 60s floor rule).
        const recent = (await pool.query(
          `select id, token, otp_sent_at from team_invites
            where phone_number=$1 and property_id=$2 and status='active'
              and accepted_user_id=$3 and allowed_modules='{}'
            order by created_at desc limit 1`, [phone, a.property_id, u.id])).rows[0];
        if (recent && recent.otp_sent_at &&
            (Date.now() - new Date(recent.otp_sent_at).getTime()) < RESEND_FLOOR_SEC * 1000) {
          return res.status(429).json({
            receipt: "A code was just sent. Enter it below.",
            token: recent.token,
          });
        }

        // supersede any prior live login invite for this phone+property, then
        // mint a fresh login-purpose invite (the OTP holder).
        const loginToken = newToken();
        const prior = recent ? [recent.id] : (await pool.query(
          `select id from team_invites
            where phone_number=$1 and property_id=$2 and status='active'
              and accepted_user_id=$3 and allowed_modules='{}'`,
          [phone, a.property_id, u.id])).rows.map(r => r.id);

        inviteRow = (await pool.query(
          `insert into team_invites
             (property_id, phone_number, invited_name, allowed_modules,
              accepted_user_id, invited_by_user_id, token, status, expires_at)
           values ($1,$2,$3,'{}',$4,$4,$5,'active', now() + ($6 || ' minutes')::interval)
           returning *`,
          [a.property_id, phone, u.name, u.id, loginToken, String(OTP_TTL_MIN)])).rows[0];

        if (prior.length) {
          await pool.query(
            `update team_invites set status='superseded', superseded_by=$1 where id = any($2)`,
            [inviteRow.id, prior]);
        }
        // fall through to the shared send path below (one code path, not two).
      }

      // resend floor (invite-accept path; re-login already checked its own above)
      if (inviteRow.otp_sent_at && (Date.now() - new Date(inviteRow.otp_sent_at).getTime()) < RESEND_FLOOR_SEC * 1000) {
        return res.status(429).json({ receipt: "A code was just sent. Wait a moment before requesting another." });
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

      // COMMUNICATIONS BOUNDARY: staff OTP is explicitly classified
      // credential transport (purpose='staff_otp') through the gate.
      let delivery = "link_only", wire = null;
      {
        wire = await commBoundary.sendPropertySms({
          property_id: inviteRow.property_id, recipient: phone, body,
          purpose: "staff_otp",
        });
        if (wire.sent) delivery = "sms_sent";
        else if (!["transport_not_configured", "no_property_line", "send_mode_disabled"].includes(wire.reason)) delivery = "sms_failed";
      }

      // a re-login invite is marked by accepted_user_id set at creation with
      // empty allowed_modules. The client has no link, so it needs the token
      // back to call /verify. (For the invite-accept flow the client already
      // holds the token from its link, so we don't echo it there.)
      const isRelogin = !!inviteRow.accepted_user_id && (inviteRow.allowed_modules || []).length === 0;

      // Production must never advance the browser to code entry when no code
      // left the system. Undo the send marker and OTP material so the operator
      // can retry immediately after the channel is corrected.
      if (isProd() && delivery !== "sms_sent") {
        await pool.query(
          `update team_invites
              set otp_hash=null, otp_expires_at=null, otp_sent_at=null
            where id=$1`,
          [inviteRow.id]
        );
        console.error(`sms/start delivery failed property=${inviteRow.property_id} reason=${wire && wire.reason || "unknown"}`);
        return res.status(503).json({
          receipt: "We couldn't send a sign-in code. Try again in a moment.",
          delivery: delivery === "sms_failed" ? "failed" : "not_configured",
          flow: isRelogin ? "relogin" : "invite_accept",
        });
      }

      const out = {
        receipt: delivery === "sms_sent" ? "Code sent by text." : "SMS transport not active.",
        masked_phone: maskPhone(phone),
        delivery,
        flow: isRelogin ? "relogin" : "invite_accept",
        expires_in_minutes: OTP_TTL_MIN,
      };
      if (isRelogin) out.token = inviteRow.token;   // client passes this to /verify
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

      // ── RE-LOGIN branch ─────────────────────────────────────────────────
      // Marker: this invite was minted WITH accepted_user_id set and empty
      // allowed_modules (the /start re-login path). It is NOT an onboarding
      // invite — it must not provision or overwrite access. We read the user's
      // CURRENT live assignment and issue a session from that live truth.
      const isRelogin = !!inv.accepted_user_id && (inv.allowed_modules || []).length === 0;
      if (isRelogin) {
        const user = (await client.query(
          `update users set phone_verified_at = coalesce(phone_verified_at, now())
            where id=$1 returning *`, [inv.accepted_user_id])).rows[0];
        if (!user || user.status === "suspended") {
          await client.query("rollback");
          return res.status(403).json({ receipt: "This account is not active. Ask a manager." });
        }

        // the user's LIVE access on the property this login was scoped to.
        const a = (await client.query(
          `select role_title, allowed_modules, primary_for_modules, can_manage_roles
             from property_team_assignments
            where property_id=$1 and user_id=$2 and active=true`,
          [inv.property_id, user.id])).rows[0];
        if (!a) {
          // access was revoked between /start and /verify — fail honestly.
          await client.query("rollback");
          return res.status(403).json({ receipt: "Your access to this property was removed. Ask a manager." });
        }

        // close the login invite (so the code can't be replayed).
        await client.query(
          `update team_invites set status='accepted', accepted_at=now() where id=$1`, [inv.id]);

        // issue the scoped staff session (same as accept path).
        const issued = await staffSessions.issueStaffSession(client, {
          userId: user.id, propertyId: inv.property_id, purpose: "sms_otp",
        });
        const sessionToken = issued.session_token;

        const propRow = (await client.query(
          `select id, name from properties where id=$1`, [inv.property_id])).rows[0];
        const prRow = (await client.query(
          `select platform_role from users where id=$1`, [user.id])).rows[0];

        await client.query("commit");
        return res.json({
          receipt: "Welcome back. You're in.",
          flow: "relogin",
          session_token: sessionToken,
          user: { id: user.id, name: user.name, phone_number: user.phone },
          property: { id: inv.property_id, name: propRow ? propRow.name : null },
          role_title: a.role_title,
          allowed_modules: a.allowed_modules,
          can_manage_roles: a.can_manage_roles,
          landing_module: landingModule(a.allowed_modules, a.primary_for_modules),
          platform_role: prRow ? (prRow.platform_role || "member") : "member",
        });
      }

      // ── INVITE-ACCEPT branch (onboarding) ──────────────────────────────
      // code is valid. Upsert the user by normalized phone.
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
      const issued = await staffSessions.issueStaffSession(client, {
        userId: user.id, propertyId: inv.property_id, purpose: "sms_otp",
      });
      const sessionToken = issued.session_token;

      const propRow2 = (await client.query(
        `select id, name from properties where id=$1`, [inv.property_id])).rows[0];
      const prRow2 = (await client.query(
        `select platform_role from users where id=$1`, [user.id])).rows[0];

      await client.query("commit");

      const landing = landingModule(inv.allowed_modules, primaryFinal);
      return res.json({
        receipt: "Verified. You're in.",
        session_token: sessionToken,
        user: { id: user.id, name: user.name, phone_number: user.phone },
        property: { id: inv.property_id, name: propRow2 ? propRow2.name : null },
        role_title: inv.role_title,
        allowed_modules: inv.allowed_modules,
        can_manage_roles: inv.can_manage_roles,
        landing_module: landing,
        platform_role: prRow2 ? (prRow2.platform_role || "member") : "member",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      //  The session service refuses with a STATUS (403 inactive account, 403
      //  no access). Answering every refusal as 500 told an inactive user the
      //  server was broken. Its status and public message are the answer.
      if (e && e.httpStatus) return res.status(e.httpStatus).json({ receipt: e.publicMessage || e.message });
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
            and u.account_kind <> 'internal_qa'  -- Gate 3: QA never on the roster
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
      // BRICK ONE property wall: a property-scoped session may read only
      // ITS property's access. No URL-selected authority.
      if (propertyId !== me.property_id)
        return res.status(403).json({ receipt: "Not in your property scope." });

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
      const target = (await pool.query(
        `select * from property_team_assignments where id=$1`, [req.params.id])).rows[0];
      if (!target) return res.status(404).json({ error: "assignment not found" });

      // ── AUTH: two accepted callers ──────────────────────────────────────
      // (1) OWNER via the operator dashboard. This route is NOT under /auth/,
      //     so the global operator-key gate in server.js has ALREADY required
      //     a valid x-operator-key to reach this handler. A request carrying a
      //     matching operator key is the owner/admin surface — allow it. The
      //     operator dashboard auths with the key, not a staff phone session.
      // (2) MANAGER via a staff phone session: must be can_manage_roles on the
      //     SAME property (the staff-facing path).
      // Either is sufficient; we don't require both.
      const opKey = process.env.OPERATOR_KEY;
      const isOperator = !!opKey && req.get("x-operator-key") === opKey;

      if (!isOperator) {
        const me = await currentUser(req);
        if (!me) return res.status(401).json({ receipt: "Not signed in." });
        // BRICK ONE property wall: the target assignment must belong to the
        // SESSION's property  can_manage_roles is live off the resolver.
        if (target.property_id !== me.property_id)
          return res.status(403).json({ receipt: "Not in your property scope." });
        if (!me.can_manage_roles)
          return res.status(403).json({ receipt: "Only an authorized manager on this property can change access." });
      }

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
