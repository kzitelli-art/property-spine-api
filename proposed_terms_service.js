// ════════════════════════════════════════════════════════════════════
//  proposed_terms_service.js — the governed proposed-terms confirmation.
//
//  "Management confirmed these exact proposed economics for resident review."
//  Part 2 of the proposed-terms slice (FROZEN SPEC r2). Class 1 primitive.
//
//  Contracts verified live this session (head cff332fa, migration 085 applied):
//   · req.operator (op) carries: id, name, email, role, property_id, role_title,
//     allowed_modules, can_manage_roles  (staff_session_service.resolveStaffSession).
//   · obligations: assigned_role (enum), assigned_user_id (uuid),
//     required_inputs (array), status (text), type (text).
//   · approve derives authority from the obligation row: owner (assigned_user_id
//     === op.id) | role (assigned_role === op.role_title || op.role) |
//     managed_role_override (op.can_manage_roles). We reuse EXACTLY that basis.
//   · events(property_id, person_id, unit_id, type, note) returning id — no json
//     column → the CONFIRMATION ROW is authoritative; the event note is a trace.
//
//  This service changes NO application status, closes NO obligation, creates NO
//  lease, satisfies NO terms_review input. It records a proposed-terms fact and
//  updates the current pointer + 075 projection columns. That is all.
// ════════════════════════════════════════════════════════════════════
const crypto = require("crypto");

// ── SHARED authority resolver (used here AND by the packet services in Part 4).
//    Derives the basis from the obligation ROW — never a route-supplied literal.
//    Returns { eligible, basis } where basis ∈ owner|role_authority|managed_role_override|null.
function resolveObligationAuthority(obligationRow, op) {
  if (op && op.can_manage_roles === true) return { eligible: true, basis: "managed_role_override" };
  if (!obligationRow) return { eligible: false, basis: null };
  if (obligationRow.assigned_user_id && obligationRow.assigned_user_id === op.id) {
    return { eligible: true, basis: "owner" };
  }
  if (obligationRow.assigned_role &&
      (obligationRow.assigned_role === op.role_title || obligationRow.assigned_role === op.role)) {
    return { eligible: true, basis: "role_authority" };
  }
  return { eligible: false, basis: null };
}

// ── normalize the economics into a canonical payload, then hash it. So 1500,
//    1500.0, 1500.00 are ONE fact; dates are canonical YYYY-MM-DD.
function normalizeAndHash({ rent, security_deposit, lease_start_date, lease_end_date, concession_status }) {
  const money = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw badRequest("invalid_money", `Non-numeric money value: ${v}`);
    return n.toFixed(2); // decimal-normalized
  };
  const date = (v) => {
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(v);
      if (isNaN(d.getTime())) throw badRequest("invalid_date", `Unparseable date: ${v}`);
      return d.toISOString().slice(0, 10);
    }
    return s;
  };
  const canonical = {
    rent: money(rent),
    security_deposit: money(security_deposit),
    lease_start_date: date(lease_start_date),
    lease_end_date: date(lease_end_date),
    concession_status: String(concession_status),
  };
  const payload_hash = crypto.createHash("sha256")
    .update(JSON.stringify(canonical)).digest("hex");
  return { canonical, payload_hash };
}

// typed errors the route maps to HTTP
function err(httpStatus, code, message) {
  const e = new Error(message || code); e.httpStatus = httpStatus; e.code = code; return e;
}
function badRequest(code, m) { return err(400, code, m); }
function conflict(code, m) { return err(409, code, m); }
function refused(code, m) { return err(403, code, m); } // opaque at the route

// ── THE SERVICE. Per this codebase's convention (see the approve route:
//    begin → approveApplication(client) → commit), the CALLER owns the
//    transaction boundary. This service does its locks + writes on the passed
//    client and NEVER issues begin/commit/rollback itself. The route wraps the
//    call in begin/commit; the proof wraps it in begin/rollback (true isolation
//    with zero committed fixtures). The service must be called inside an open tx.
async function confirmProposedTerms(client, input) {
  const {
    application_id, rent, security_deposit, lease_start_date, lease_end_date,
    concession_status, idempotency_key, actor,
  } = input;

  if (!application_id) throw badRequest("application_id_required");
  if (!idempotency_key) throw badRequest("idempotency_key_required");
  if (!actor || !actor.user_id || !actor.property_id) throw badRequest("actor_context_required");
  if (concession_status !== "none") throw refused("structured_source_not_supported"); // r2: none-only this slice

  // validate + normalize BEFORE any write; hash the canonical form
  if (Number(rent) <= 0) throw badRequest("rent_must_be_positive");
  if (Number(security_deposit) < 0) throw badRequest("deposit_must_be_nonnegative");
  const { canonical, payload_hash } = normalizeAndHash({ rent, security_deposit, lease_start_date, lease_end_date, concession_status });
  if (canonical.lease_end_date <= canonical.lease_start_date) throw badRequest("end_must_be_after_start");

  // ── LOCK ORDER (r2): application → terms_review obligation → current confirmation → (packet check)
  // 1. lock exact application
  const app = (await client.query(
    `select id, property_id, status, terms_review_obligation_id, proposed_terms_confirmation_id
       from lease_applications where id=$1 for update`, [application_id])).rows[0];
  if (!app) throw err(404, "application_not_found");

  // property wall
  if (app.property_id !== actor.property_id) throw refused("property_mismatch");

  // governed window: v3 terms-review lifecycle only
  if (app.status !== "lease_ready") throw refused("not_lease_ready");
  if (!app.terms_review_obligation_id) throw refused("no_terms_review_obligation");

  // 2. lock the exact terms_review obligation
  const ob = (await client.query(
    `select id, type, status, assigned_role, assigned_user_id, required_inputs
       from obligations where id=$1 for update`, [app.terms_review_obligation_id])).rows[0];
  if (!ob) throw refused("terms_review_obligation_missing");
  if (ob.type !== "terms_review") throw refused("obligation_not_terms_review");
  if (!["open", "in_progress"].includes(ob.status)) throw refused("terms_review_not_open");
  const inputs = ob.required_inputs || [];
  if (!inputs.includes("terms_acknowledged")) throw refused("terms_review_missing_input");

  // authority — SERVICE-DERIVED from the obligation row (shared resolver)
  const auth = resolveObligationAuthority(ob, {
    id: actor.user_id, role: actor.role, role_title: actor.role_title, can_manage_roles: actor.can_manage_roles,
  });
  if (!auth.eligible) throw refused("not_authorized_for_terms");

  // 3. lock current confirmation (if any) — for supersession + correction window
  let current = null;
  if (app.proposed_terms_confirmation_id) {
    current = (await client.query(
      `select id, payload_hash from application_proposed_terms_confirmations where id=$1 for update`,
      [app.proposed_terms_confirmation_id])).rows[0];
  }

  // idempotency: same (app, actor, key) already recorded?
  const existing = (await client.query(
    `select id, payload_hash from application_proposed_terms_confirmations
      where application_id=$1 and actor_user_id=$2 and idempotency_key=$3`,
    [application_id, actor.user_id, idempotency_key])).rows[0];
  if (existing) {
    if (existing.payload_hash === payload_hash) {
      return { idempotent: true, confirmation_id: existing.id, authority_basis: auth.basis };
    }
    throw conflict("idempotency_conflict", "Same key, different terms.");
  }

  // correction window (r2: no-packet-only; no void primitive this slice)
  const pkt = (await client.query(
    `select id, status from lease_packets where application_id=$1 order by version desc limit 1`,
    [application_id])).rows[0];
  if (pkt) throw conflict("proposed_terms_locked_by_packet", "A packet already exists for this application.");

  // concession source-rank: 'none' allowed only when NO LOCKED structured economic
  // schedule exists. Authoritative rule (verified vocabulary): status='locked' AND
  // locked_at is not null. A draft/unlocked schedule does not conflict.
  const sched = (await client.query(
    `select id from lease_economic_schedules
      where application_id=$1 and status='locked' and locked_at is not null
      limit 1`, [application_id])).rows[0];
  if (sched) throw conflict("economics_conflict", "A locked economic schedule exists; 'none' refused.");

  // ── WRITE. event first (returns id) → confirmation row → projection.
  const ev = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1, null, null, 'proposed_terms_confirmed', $2) returning id`,
    [app.property_id,
     `proposed terms confirmed for application ${application_id} (hash ${payload_hash.slice(0, 12)})`])).rows[0];

  const supersedes = current ? current.id : null;

  const conf = (await client.query(
    `insert into application_proposed_terms_confirmations
       (application_id, property_id, actor_user_id, event_id, rent, security_deposit,
        lease_start_date, lease_end_date, concession_status, source, authority_basis,
        idempotency_key, payload_hash, supersedes_confirmation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'none','operator_proposed_terms',$9,$10,$11,$12)
     returning id, created_at`,
    [application_id, app.property_id, actor.user_id, ev.id,
     canonical.rent, canonical.security_deposit, canonical.lease_start_date, canonical.lease_end_date,
     auth.basis, idempotency_key, payload_hash, supersedes])).rows[0];

  // update current pointer + 075 projection columns (term_source is now GOVERNED)
  await client.query(
    `update lease_applications
        set proposed_terms_confirmation_id=$1,
            lease_start_date=$2, lease_end_date=$3,
            rent=$4, deposit=$5,
            term_source='operator_proposed_terms',
            terms_completed_at=now(), terms_completed_by=$6,
            concession_status='none'
      where id=$7`,
    [conf.id, canonical.lease_start_date, canonical.lease_end_date,
     canonical.rent, canonical.security_deposit, actor.user_id, application_id]);

  return {
    idempotent: false, confirmation_id: conf.id, authority_basis: auth.basis,
    supersedes_confirmation_id: supersedes, payload_hash, confirmed_at: conf.created_at,
  };
}

module.exports = { confirmProposedTerms, resolveObligationAuthority, normalizeAndHash };
