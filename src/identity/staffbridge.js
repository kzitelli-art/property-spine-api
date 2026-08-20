// ════════════════════════════════════════════════════════════════════
//  staffbridge.js — the authorized point-and-confirm bridge workflow.
//
//  Bridges are created by an authorized human — never by ordinary capture
//  flow, never by inference. Name matching is not evidence. Phone matching
//  is not evidence. AI confidence is not evidence. Exact verified email may
//  SUGGEST a candidate; it is never auto-applied.
//
//  AUTH: a real staff session (x-staff-session) whose user is active-
//  eligible AND holds a bridge-admin role: owner | asset_manager |
//  property_manager. NO demo widening — production runs DEMO_MODE=true for
//  the boardroom bootstrap, which mints leasing_manager sessions from a
//  PUBLIC access code; bridge mutations are not property-scoped, so any
//  widening would hand the public demo code admin over production users.
//  The demo seed therefore runs through the service layer from the Render
//  shell (seeds/seed_bridge_demo_staff.js), never through a demo session.
//  performed_by is SERVER-DERIVED from that session at the route boundary;
//  a request body can never supply it (same discipline as recorded_by).
//
//  BOOTSTRAP (contract Part 2.4): the first bridge needs no already-bridged
//  admin. Authority is the authenticated admin ACCOUNT and its role; an
//  admin may bridge others or itself before holding a bridge of its own.
//
//  EVERY MUTATION IS ONE TRANSACTION:
//    lock the user row → read current pointer → close open audit range →
//    write the new audit record → update users.person_id → commit together.
//
//  Routes (all under the operator CORS + staff-session world):
//    GET  /operator/admin/bridge/coverage        coverage + divergence report
//    GET  /operator/admin/bridge/candidates/:userId   suggestions (writes nothing)
//    POST /operator/admin/bridge/classify        set account_kind
//    POST /operator/admin/bridge/link            link or relink (audited)
//    POST /operator/admin/bridge/unlink          unlink (audited)
//
//  This module NEVER: enables the Commitment Ledger, wires the promise
//  seam, scores anyone, or exposes a staff Person Card.
// ════════════════════════════════════════════════════════════════════

"use strict";
const express = require("express");
const staffSessions = require("./staff_session_service.js"); // BRICK ONE: the ONE issuer/resolver/revoke
const resolver = require("./staff_identity_resolver.js");

module.exports = function buildStaffBridge({ pool }) {
  const router = express.Router();
  const ADMIN_ROLES = ["owner", "asset_manager", "property_manager"];
  // account kinds that can never hold admin authority, even with an admin
  // role and active flags ('unclassified' stays allowed — the bootstrap rule).
  const NON_ADMIN_KINDS = ["service_account", "integration_account", "shared_account", "disabled_legacy"];

  function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; return e; }

  // ── session → admin user, server-derived. The ONLY identity source. ──
  async function resolveAdmin(req) {
    // BRICK ONE: shared live resolver (session + active user per 067 +
    // active assignment for the session's property  a deliberate
    // TIGHTENING: an admin session now also requires live property
    // authority  one meaning of authorization everywhere). The bridge's
    // own narrowing stays layered on top, unchanged below.
    const u = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
    if (!u) return null;
    if (NON_ADMIN_KINDS.includes(u.account_kind)) return null;  // a machine/shared/legacy account never administers
    return ADMIN_ROLES.includes(u.role) ? u : null;             // NO widening — see header
  }

  async function requireBridgeAdmin(req, res, next) {
    try {
      const admin = await resolveAdmin(req);
      if (!admin) return res.status(403).json({
        error: "Bridge administration requires an active admin staff session." });
      req.bridgeAdmin = admin;
      next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  // ════════════════════════════════════════════════════════════════
  //  THE SERVICE LAYER (transaction-aware, testable, route-independent).
  //  performed_by_user_id is a PARAMETER here so the proof harness can
  //  exercise it; ROUTES derive it from the session and nothing else.
  // ════════════════════════════════════════════════════════════════

  // classify: the gate before any bridge. Unclassified accounts cannot link.
  async function classifyAccount(client, { user_id, account_kind, performed_by_user_id }) {
    const KINDS = ["human_staff", "service_account", "integration_account",
                   "shared_account", "disabled_legacy"];
    if (!KINDS.includes(account_kind)) throw httpErr(400, `account_kind must be one of: ${KINDS.join(", ")}`);
    const u = (await client.query(`select id, person_id from users where id = $1 for update`, [user_id])).rows[0];
    if (!u) throw httpErr(404, "user not found");
    // A non-human kind may never keep a live bridge.
    if (account_kind !== "human_staff" && u.person_id) {
      throw httpErr(409, "this account holds a live person bridge; unlink it before reclassifying as non-human");
    }
    const r = await client.query(
      `update users set account_kind = $2, account_kind_set_by_user_id = $3,
              account_kind_set_at = now(), updated_at = now()
        where id = $1 returning id, name, account_kind`, [user_id, account_kind, performed_by_user_id]);
    return r.rows[0];
  }

  // Safe staff-person creation (contract Part 2.2): the person is created
  // WITH an active staff context in the same transaction, so no window
  // exists in which they are only a bare default-'lead' row. No synthetic
  // phone. No fake lead record. lifecycle_status stays at the schema floor
  // ('lead') — it is the LEASING lifecycle and means nothing until a real
  // leasing relationship (a leasing_leads row) exists; every prospect
  // surface excludes active-staff-context persons without one.
  async function createStaffPerson(client, { name, email = null, phone = null,
                                             property_id = null, created_by_user_id }) {
    if (!name || !String(name).trim()) throw httpErr(400, "a staff person needs a name");
    const p = (await client.query(
      `insert into persons (name, email, phone, source)
       values ($1, $2, $3, 'staff_bridge') returning *`,
      [String(name).trim(), email, phone])).rows[0];
    await client.query(
      `insert into person_contexts (person_id, context_type, property_id, created_by_user_id)
       values ($1, 'staff', $2, $3)`, [p.id, property_id, created_by_user_id]);
    return p;
  }

  // link / relink — ONE transaction, append-only audit, range semantics.
  async function linkBridge(client, {
    user_id, person_id = null, create_staff_person = null,
    reason_code, reason_detail = null,
    evidence_type = "operator_attestation", evidence_reference = null,
    performed_by_user_id, request_id = null,
  }) {
    if (!reason_code) throw httpErr(400, "reason_code is required — every bridge answers WHY");
    if (!person_id && !create_staff_person) throw httpErr(400, "supply person_id or create_staff_person");
    if (person_id && create_staff_person) throw httpErr(400, "supply person_id OR create_staff_person, not both");

    // ── IDEMPOTENT STAFF CREATION ─────────────────────────────────
    // A re-run of a creation script produced a second identical staff person.
    // A pre-check alone cannot prevent it: two concurrent callers both read
    // "none exists", then both insert. So the guard is a transaction-scoped
    // ADVISORY LOCK keyed on the user — concurrent requests for the same
    // identity serialise here, and the second sees the first's result.
    // The partial unique index (migration 104) is the backstop underneath:
    // even a caller that bypasses this function cannot create a second
    // ACTIVE staff person for one email.
    if (create_staff_person) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [String(user_id)]);

      // Already bridged to a LIVE staff person? Return it. Never create again.
      const cur = (await client.query(
        `select p.id, p.name, p.email, p.record_status
           from users u join persons p on p.id = u.person_id
          where u.id = $1`, [user_id])).rows[0];
      if (cur && cur.record_status === "active") {
        return { replayed: true, already_exists: true, action: "already_linked",
                 person: cur,
                 detail: "This login is already bridged to an active staff person. " +
                         "No second person was created." };
      }
      // A retired historical person must never be silently re-selected.
      if (cur && cur.record_status === "retired") {
        throw httpErr(409,
          `this login points at a RETIRED person (${cur.id}); unlink it explicitly before creating a new staff record`);
      }
      // An active staff person already holding this email is the same identity.
      const email = create_staff_person.email;
      if (email) {
        const owned = (await client.query(
          `select id, name from persons
            where lower(email) = lower($1) and source = 'staff_bridge' and record_status = 'active'
            limit 1`, [email])).rows[0];
        if (owned) {
          return { replayed: true, already_exists: true, action: "existing_staff_person",
                   person: owned,
                   detail: "An active governed staff person already holds this email. " +
                           "Link to it explicitly rather than creating a duplicate." };
        }
      }
    }

    // Idempotency: an identical request replays its receipt, writes nothing.
    if (request_id) {
      const dup = (await client.query(
        `select * from user_person_bridge_audit where request_id = $1 limit 1`, [request_id])).rows[0];
      if (dup) return { replayed: true, audit: dup };
    }

    // Lock the user row for the whole mutation.
    const u = (await client.query(
      `select id, name, is_active, status, person_id, account_kind
         from users where id = $1 for update`, [user_id])).rows[0];
    if (!u) throw httpErr(404, "user not found");
    if (u.account_kind !== "human_staff") {
      throw httpErr(409, `only classified human_staff accounts may be bridged (this account: ${u.account_kind})`);
    }

    let targetPersonId = person_id;
    if (create_staff_person) {
      const p = await createStaffPerson(client, {
        ...create_staff_person, created_by_user_id: performed_by_user_id });
      targetPersonId = p.id;
    } else {
      const p = (await client.query(`select id from persons where id = $1`, [person_id])).rows[0];
      if (!p) throw httpErr(404, "person not found");
      // Linking an EXISTING person as staff: ensure the additive staff
      // context exists (idempotent — the partial unique index guards it).
      await client.query(
        `insert into person_contexts (person_id, context_type, created_by_user_id)
         values ($1, 'staff', $2) on conflict do nothing`, [targetPersonId, performed_by_user_id]);
    }

    const isRelink = !!u.person_id;
    if (isRelink && u.person_id === targetPersonId) {
      throw httpErr(409, "already linked to this person — nothing to change");
    }

    // Close the open range (the ONLY permitted touch of a prior audit row).
    await client.query(
      `update user_person_bridge_audit set effective_to = now()
        where user_id = $1 and effective_to is null`, [user_id]);

    const audit = (await client.query(
      `insert into user_person_bridge_audit
         (user_id, prior_person_id, new_person_id, action,
          performed_by_user_id, reason_code, reason_detail,
          evidence_type, evidence_reference, request_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [user_id, u.person_id, targetPersonId, isRelink ? "relinked" : "linked",
       performed_by_user_id, reason_code, reason_detail,
       evidence_type, evidence_reference, request_id])).rows[0];

    await client.query(
      `update users set person_id = $2, updated_at = now() where id = $1`,
      [user_id, targetPersonId]);

    return { replayed: false, action: audit.action, audit,
             user_id, person_id: targetPersonId,
             receipt: `${u.name} ${isRelink ? "re-linked" : "linked"} to person ${targetPersonId}. Audited.` };
  }

  /*  ── ADD A PROPERTY-SCOPED STAFF CONTEXT TO AN EXISTING STAFF PERSON ──
   *
   *  THE GAP THIS CLOSES. person_contexts had exactly one writer — this
   *  module — and only two paths into it: createStaffPerson, which writes a
   *  SCOPED context but only while creating a NEW person, and linkBridge,
   *  which writes an UNSCOPED one and refuses outright for a person already
   *  linked ("already linked to this person — nothing to change").
   *
   *  So an established staff person could never gain a context at a SECOND
   *  property. That is not a schema limit: uq_person_context_active is
   *  unique on (person_id, context_type, coalesce(property_id, zero-uuid)),
   *  so one active row per property plus one unscoped row is already legal.
   *  Nothing exercised it, and resolveAuthority's person_entitled_to_property
   *  check therefore could not be satisfied for a real second property.
   *
   *  WHAT IT DELIBERATELY DOES NOT DO. It creates no person, touches no
   *  users.person_id, closes no bridge audit range, and confers no authority.
   *  Entitlement and authority are two facts and stay two writes — this one
   *  only says "this staff person is entitled to operate at this property".
   *
   *  IDEMPOTENT. A repeat is a replay, not a second row and not an error:
   *  the partial unique index is the guard, and the conflict is read rather
   *  than assumed.
   *
   *  ATTRIBUTED. created_by_user_id is the acting admin, server-derived at
   *  the route. This is the same attribution column createStaffPerson uses;
   *  no second audit mechanism is invented for the same fact.              */
  async function grantStaffContext(client, {
    person_id, property_id, performed_by_user_id, reason_detail = null,
  } = {}) {
    if (!person_id)  throw httpErr(400, "person_id is required");
    if (!property_id) throw httpErr(400, "property_id is required — an unscoped context is granted by linkBridge, not here");
    if (!performed_by_user_id) throw httpErr(400, "performed_by_user_id is required");

    const person = (await client.query(
      `select id, name from persons where id = $1 for update`, [person_id])).rows[0];
    if (!person) throw httpErr(404, "person not found");

    const property = (await client.query(
      `select id, name from properties where id = $1`, [property_id])).rows[0];
    if (!property) throw httpErr(404, "property not found");

    //  ESTABLISHED STAFF ONLY. Staffness is a governed fact written at
    //  classification; this widens an existing one and must never be the
    //  thing that first makes someone staff. A person with no active staff
    //  context belongs in the link/classify path, not here.
    const existing = (await client.query(
      `select id, property_id from person_contexts
        where person_id = $1 and context_type = 'staff' and active_to is null`,
      [person_id])).rows;
    if (!existing.length) {
      throw httpErr(409,
        "this person holds no active staff context, so there is nothing to widen. " +
        "Classify and bridge them first — becoming staff is a different act from " +
        "being entitled to another property.");
    }

    if (existing.some((c) => c.property_id === null)) {
      return { replayed: true, already: "unscoped",
        receipt: `${person.name} already holds an UNSCOPED staff context, which covers every property including ${property.name}. Nothing to add.` };
    }
    const here = existing.find((c) => String(c.property_id) === String(property_id));
    if (here) {
      return { replayed: true, already: "scoped", context_id: here.id,
        receipt: `${person.name} is already entitled at ${property.name}. Unchanged.` };
    }

    const ctx = (await client.query(
      `insert into person_contexts (person_id, context_type, property_id, created_by_user_id)
       values ($1, 'staff', $2, $3)
       on conflict do nothing
       returning id`, [person_id, property_id, performed_by_user_id])).rows[0];
    if (!ctx) {
      //  The index refused and the reads above did not predict it. Say so
      //  rather than reporting a success nobody performed.
      throw httpErr(409, "the staff context was refused by the uniqueness guard and no existing row explains it");
    }

    return {
      replayed: false, context_id: ctx.id, person_id, property_id,
      reason_detail: reason_detail || null,
      receipt: `${person.name} is now entitled to operate at ${property.name}. ` +
               `This is entitlement only — it confers no pricing or approval authority.`,
    };
  }

  async function unlinkBridge(client, { user_id, reason_code, reason_detail = null,
                                        performed_by_user_id, request_id = null }) {
    if (!reason_code) throw httpErr(400, "reason_code is required");
    const u = (await client.query(
      `select id, name, person_id from users where id = $1 for update`, [user_id])).rows[0];
    if (!u) throw httpErr(404, "user not found");
    if (!u.person_id) throw httpErr(409, "no live bridge to unlink");

    await client.query(
      `update user_person_bridge_audit set effective_to = now()
        where user_id = $1 and effective_to is null`, [user_id]);

    const audit = (await client.query(
      `insert into user_person_bridge_audit
         (user_id, prior_person_id, new_person_id, action, effective_to,
          performed_by_user_id, reason_code, reason_detail, evidence_type, request_id)
       values ($1,$2,null,'unlinked', now(), $3,$4,$5,'operator_attestation',$6) returning *`,
      [user_id, u.person_id, performed_by_user_id, reason_code, reason_detail, request_id])).rows[0];

    await client.query(`update users set person_id = null, updated_at = now() where id = $1`, [user_id]);
    return { audit, receipt: `${u.name} unlinked. History preserved; past events keep their original actors.` };
  }

  // Candidate SUGGESTIONS: exact verified email only. Writes nothing.
  // Never phone. Never name similarity. Never auto-applied.
  async function bridgeCandidates(client, user_id) {
    const u = (await client.query(
      `select id, name, email, account_kind, person_id from users where id = $1`, [user_id])).rows[0];
    if (!u) throw httpErr(404, "user not found");
    let candidates = [];
    if (u.email) {
      candidates = (await client.query(
        `select p.id, p.name, p.email,
                exists (select 1 from person_contexts pc
                         where pc.person_id = p.id and pc.context_type = 'staff'
                           and pc.active_to is null) as has_staff_context
           from persons p where lower(p.email) = lower($1)`, [u.email])).rows
        .map((p) => ({ ...p, suggestion_basis: "exact_email_match" }));
    }
    return { user: { id: u.id, name: u.name, email: u.email,
                     account_kind: u.account_kind, current_person_id: u.person_id },
             candidates,
             note: "Suggestions only. A bridge is written solely by an authorized, audited confirm." };
  }

  // ── coverage + divergence report (contract Part 2.3) ──
  // Per user: identity, activity, classification, bridge state, person-keyed
  // assignments (004 — the eligibility truth), user-keyed team assignments
  // (035 — reconciliation source ONLY), and divergence between the two.
  async function coverageReport(client) {
    // The raw users↔persons↔assignments read lives in the CANONICAL resolver
    // (the static gate forbids it here). This module only SHAPES the report.
    const rows = await resolver.coverageRows(client);

    const report = rows.map((r) => {
      const activeEligible = r.is_active === true && r.status === "active";
      let bridge_state;
      if (!activeEligible)                        bridge_state = "user_ineligible";
      else if (!r.person_id)                      bridge_state = "unbridged";
      else if (r.active_links_to_person > 1)      bridge_state = "conflicted";
      else if (r.active_assignments_004 === 0)    bridge_state = "linked_no_active_assignment";
      else                                        bridge_state = "linked_and_eligible";

      const a004 = new Set((r.assignment_properties_004 || []).map(String));
      const t035 = (r.team_properties_035 || []).map(String);
      const divergence = [];
      for (const pid of t035) if (!a004.has(pid))
        divergence.push({ property_id: pid, kind: "team_035_only",
          note: "phone-first team row exists here but no person-keyed eligible assignment (035 grants NO eligibility)" });
      for (const pid of a004) if (!t035.includes(pid))
        divergence.push({ property_id: pid, kind: "assignments_004_only",
          note: "eligible assignment here but no phone-first team row" });

      return { ...r, bridge_state, divergence,
               eligible_to_receive_new_work: bridge_state === "linked_and_eligible" &&
                                             r.account_kind === "human_staff" };
    });

    const counts = {};
    for (const r of report) counts[r.bridge_state] = (counts[r.bridge_state] || 0) + 1;
    return { generated_at: new Date().toISOString(), counts, users: report,
             doctrine: "assignments(004) is the only eligibility source; property_team_assignments(035) is reconciliation-only." };
  }

  // ════════════════════════════════════════════════════════════════
  //  ROUTES — thin, session-derived, transactional.
  // ════════════════════════════════════════════════════════════════
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
    catch (e) { await c.query("rollback"); throw e; }
    finally { c.release(); }
  }
  function send(res, e) {
    return res.status(e.httpStatus || 500).json({ error: e.message });
  }

  router.get("/operator/admin/bridge/coverage", requireBridgeAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const c = await pool.connect();
      try { return res.json(await coverageReport(c)); } finally { c.release(); }
    } catch (e) { return send(res, e); }
  });

  router.get("/operator/admin/bridge/candidates/:userId", requireBridgeAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const c = await pool.connect();
      try { return res.json(await bridgeCandidates(c, req.params.userId)); } finally { c.release(); }
    } catch (e) { return send(res, e); }
  });

  router.post("/operator/admin/bridge/classify", requireBridgeAdmin, async (req, res) => {
    try {
      const out = await tx((c) => classifyAccount(c, {
        user_id: req.body?.user_id, account_kind: req.body?.account_kind,
        performed_by_user_id: req.bridgeAdmin.id }));           // server-derived
      return res.json({ receipt: `Account classified: ${out.account_kind}.`, user: out });
    } catch (e) { return send(res, e); }
  });

  router.post("/operator/admin/bridge/link", requireBridgeAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await tx((c) => linkBridge(c, {
        user_id: b.user_id, person_id: b.person_id || null,
        create_staff_person: b.create_staff_person || null,
        reason_code: b.reason_code, reason_detail: b.reason_detail || null,
        evidence_type: b.evidence_type || "operator_attestation",
        evidence_reference: b.evidence_reference || null,
        request_id: b.request_id || null,
        performed_by_user_id: req.bridgeAdmin.id,               // server-derived, NEVER body
      }));
      return res.json(out);
    } catch (e) { return send(res, e); }
  });

  //  Entitlement, not authority. The acting admin comes from the session.
  router.post("/operator/admin/bridge/staff-context", requireBridgeAdmin, async (req, res) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await grantStaffContext(c, {
        person_id: (req.body || {}).person_id,
        property_id: (req.body || {}).property_id,
        reason_detail: (req.body || {}).reason_detail || null,
        performed_by_user_id: req.bridgeAdmin.id,   // SERVER-DERIVED, never body-supplied
      });
      await c.query("commit");
      return res.json(out);
    } catch (e) {
      await c.query("rollback");
      return res.status(e.httpStatus || 500).json({ error: e.message });
    } finally { c.release(); }
  });

  router.post("/operator/admin/bridge/unlink", requireBridgeAdmin, async (req, res) => {
    try {
      const out = await tx((c) => unlinkBridge(c, {
        user_id: req.body?.user_id, reason_code: req.body?.reason_code,
        reason_detail: req.body?.reason_detail || null,
        request_id: req.body?.request_id || null,
        performed_by_user_id: req.bridgeAdmin.id,               // server-derived
      }));
      return res.json(out);
    } catch (e) { return send(res, e); }
  });

  // service layer exposed for the proof harness + the audited demo seed
  router._service = { classifyAccount, createStaffPerson, linkBridge, unlinkBridge, grantStaffContext,
                      bridgeCandidates, coverageReport };
  router._internal = { resolveAdmin, requireBridgeAdmin };
  return router;
};
