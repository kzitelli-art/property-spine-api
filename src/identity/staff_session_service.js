// staff_session_service.js
//
// BRICK ONE (S1)  THE canonical staff-session service. Class 1 permanent
// product primitive. After Deploy A, every staff-session mint, resolve, and
// revoke in the system goes through this file. No other module may touch
// staff_sessions directly.
//
//   issueStaffSession(client, { userId, propertyId, purpose })
//     one issuer. Verifies live authority, mints ADDITIVE, digest-at-rest.
//   resolveStaffSession(db, token)
//     one live resolver. Session validity + live user status + live active
//     property assignment on EVERY call. Returns the session's property and
//     the assignment's current modules/role  never a login-time snapshot.
//   revokeCurrentStaffSession(db, token)
//     one revocation meaning. Revokes exactly the presented session.
//
// AUTHORITY LAW (MASTER rules 10/12):
//   - The property_team_assignments row IS the authority. Not account_kind,
//     not global role, not the invite that bound the login, not the caller.
//   - No property branch, no user branch, no DEMO_MODE in here. Demo is a
//     caller that resolves its server-pinned user/property and calls in.
//   - The caller never supplies role, modules, TTL, or entitlement.
//
// TOKEN-AT-REST (Gate 2 decision):
//   New sessions store sha256(raw) in token_digest; the raw token is
//   returned once and never persisted or logged. Legacy pre-cutover rows
//   (raw `token`, token_digest IS NULL) keep resolving for their remaining
//   TTL (max 14 days). Removal: hardening release SESSION-DIGEST-CLEANUP
//   deletes the legacy branch and drops the raw column once every
//   pre-digest session has expired.

"use strict";

const crypto = require("crypto");
const staffIdentity = require("./staff_identity_resolver.js"); // 067: THE user-eligibility rule

// server-owned issuance policy. The browser and ordinary callers never
// choose duration; a trusted caller names its purpose and the service maps it.
const ISSUANCE_POLICY = {
  demo:             { ttlHours: 6 },   // fenced Demo Building presentation sessions
  bootstrap_invite: { ttlHours: 12 },  // Class 2 interim proof (this brick)
  sms_otp:          { ttlHours: 24 * 14 }, // preserve team_access's existing 14-day policy
};

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function svcErr(status, publicMessage) {
  const e = new Error(publicMessage);
  e.httpStatus = status;
  e.publicMessage = publicMessage;
  return e;
}

// ---------------------------------------------------------------------------
// issueStaffSession  the ONE mint path.
// Runs inside the CALLER's transaction (client must be a checked-out pg
// client mid-transaction, or a pool for standalone use  both expose .query).
// ---------------------------------------------------------------------------
async function issueStaffSession(client, { userId, propertyId, purpose }) {
  const policy = ISSUANCE_POLICY[purpose];
  if (!policy) throw svcErr(500, "Unknown session issuance purpose.");
  if (!userId || !propertyId) throw svcErr(500, "issueStaffSession requires userId and propertyId.");

  // 1) the user must exist and be eligible by the ONE canonical rule (067):
  //    is_active = true AND status = 'active'. Never account_kind  4 live
  //    users are 'unclassified' and are legitimate operators.
  // FOR SHARE: hold the authority rows for the life of this transaction so
  // a concurrent suspension/deactivation cannot slip between validation and
  // mint. Either the deactivation waits until this commit (and the LIVE
  // resolver denies the very next request), or it wins first and this
  // issuance refuses  with the bootstrap proof left unconsumed. There is
  // no third outcome. (Blocker-4 proof: prove_service LOCK block.)
  const u = (await client.query(
    `select id, name, role, is_active, status, account_kind
       from users where id = $1
       for share`,
    [userId]
  )).rows[0];
  if (!u || !staffIdentity.userIsActive(u)) {
    throw svcErr(403, "This account is not active.");
  }

  // 2) the CURRENT active assignment for exactly (user, property) is the
  //    authority. Absent  refuse. The invite/demo/OTP caller may have
  //    bound the attempt to this property, but binding is not authority.
  const a = (await client.query(
    `select role_title, allowed_modules, primary_for_modules, can_manage_roles
       from property_team_assignments
      where property_id = $1 and user_id = $2 and active = true
      for share`,
    [propertyId, userId]
  )).rows[0];
  if (!a) {
    throw svcErr(403, "No active access to this property.");
  }

  // 3) mint  ADDITIVE (no revoke-on-mint here; a phone and a desktop may
  //    both be signed in). Demo's revoke-prior behavior is that caller's
  //    fenced pre-mint step, not issuer policy.
  const rawToken = crypto.randomBytes(32).toString("base64url");
  // token = NULL by construction: post-cutover rows carry NO raw bearer
  // value at all (070 dropped the NOT NULL). Only the digest is stored.
  const s = (await client.query(
    `insert into staff_sessions (user_id, property_id, token, token_digest, issuance_purpose, expires_at)
     values ($1, $2, null, $3, $4, now() + ($5 || ' hours')::interval)
     returning id, expires_at`,
    [userId, propertyId, sha256(rawToken), purpose, String(policy.ttlHours)]
  )).rows[0];

  const propertyRow = (await client.query(
    `select coalesce(display_name, name) as name from properties where id = $1`,
    [propertyId]
  )).rows[0];

  return {
    session_id: s.id,
    session_token: rawToken,             // returned ONCE; never stored or logged
    expires_at: s.expires_at,
    expires_in_hours: policy.ttlHours,
    user: { id: u.id, name: u.name, global_role: u.role },
    property: { id: propertyId, name: propertyRow ? propertyRow.name : null },
    property_role_title: a.role_title,
    allowed_modules: a.allowed_modules,          // server-derived, never a literal
    primary_for_modules: a.primary_for_modules,
    can_manage_roles: a.can_manage_roles,
  };
}

// ---------------------------------------------------------------------------
// resolveStaffSession  the ONE live authority read.
// Every protected request re-verifies: session valid + user active (067 rule)
// + assignment for the SESSION's property currently active. Returns live
// role/modules from the assignment  entitlement removal, deactivation, or
// suspension takes effect on the very next request.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// LEGACY RAW-TOKEN SUNSET (Gate 2, explicit in code  not a memo)
//
//   Pre-cutover sessions store a raw token (token_digest IS NULL). The
//   longest TTL any such session can carry is team_access's 14-day OTP
//   policy, so every legacy row is dead within LEGACY_MAX_TTL_DAYS of the
//   cutover. The fallback branch below therefore refuses ANY raw-token row
//   whose created_at is older than LEGACY_MAX_TTL_DAYS  the branch cannot
//   outlive the sessions it exists to honor, even if the cleanup release
//   is late. SESSION-DIGEST-CLEANUP then deletes the branch + raw column.
// ---------------------------------------------------------------------------
const LEGACY_MAX_TTL_DAYS = 14; // = max pre-cutover session lifetime (team_access SESSION_TTL_DAYS)

// THE resolver query, defined once. resolveStaffSession() binds it; the
// proof harness EXPLAINs this exact constant  byte-identical, sunset
// predicate included. $1=sha256(token) $2=raw token $3=LEGACY_MAX_TTL_DAYS.
const RESOLVER_SQL =
    `select s.id as session_id, s.property_id, s.expires_at,
            u.id, u.name, u.phone, u.email, u.role as global_role, u.is_active, u.status, u.account_kind,
            a.role_title, a.allowed_modules, a.primary_for_modules, a.can_manage_roles
       from staff_sessions s
       join users u on u.id = s.user_id
       join property_team_assignments a
         on a.user_id = u.id and a.property_id = s.property_id and a.active = true
      where ( s.token_digest = $1
              or ( s.token_digest is null
                   and s.token = $2
                   and s.created_at > now() - ($3 || ' days')::interval ) )
        and s.revoked = false
        and s.expires_at > now()
        and u.is_active = true
        and u.status = 'active'`;

async function resolveStaffSession(db, token) {
  if (!token || typeof token !== "string") return null;

  const digest = sha256(token);

  // Primary branch: digest-at-rest (all post-cutover sessions).
  // Legacy branch: raw-token rows (token_digest IS NULL), accepted ONLY
  // while the row is younger than LEGACY_MAX_TTL_DAYS. A raw row older
  // than the maximum possible pre-cutover lifetime is refused even if its
  // expires_at was somehow extended  the sunset is structural.
  const r = await db.query(RESOLVER_SQL, [digest, token, String(LEGACY_MAX_TTL_DAYS)]);

  const row = r.rows[0];
  if (!row) return null;

  return {
    session_id: row.session_id,
    id: row.id,                       // user id (kept as `id` for drop-in
    name: row.name,                   // compatibility with req.operator)
    phone: row.phone,                 // team_access callers use me.phone
    email: row.email,
    role: row.global_role,            // global role (users.role)
    global_role: row.global_role,
    account_kind: row.account_kind,
    property_id: row.property_id,     // the SESSION's property  scope truth
    role_title: row.role_title,       // live, from the assignment
    allowed_modules: row.allowed_modules || [],
    primary_for_modules: row.primary_for_modules || [],
    can_manage_roles: row.can_manage_roles === true,
  };
}

// ---------------------------------------------------------------------------
// revokeCurrentStaffSession  revoke exactly the presented session.
// Idempotent from the user's perspective: revoking an already-revoked,
// expired, or unknown token is a no-op success (no state oracle).
// ---------------------------------------------------------------------------
async function revokeCurrentStaffSession(db, token) {
  if (!token || typeof token !== "string") return { revoked: false };
  const digest = sha256(token);
  const r = await db.query(
    `update staff_sessions
        set revoked = true
      where ( token_digest = $1
              or (token_digest is null and token = $2) )
        and revoked = false`,
    [digest, token]
  );
  return { revoked: r.rowCount > 0 };
}

// NOTE (reviewer architecture ruling): userIsOperational  the central
// internal-QA output-exclusion predicate  lives in staff_identity_resolver
// with the rest of user eligibility. Identity eligibility belongs to the
// identity layer; this module owns session mechanics only.

module.exports = {
  issueStaffSession,
  resolveStaffSession,
  revokeCurrentStaffSession,
  _sha256: sha256, // exposed for the bootstrap module + proof harness
  RESOLVER_SQL,
  LEGACY_MAX_TTL_DAYS,
  ISSUANCE_POLICY,
};
