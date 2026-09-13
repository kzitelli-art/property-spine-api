// ════════════════════════════════════════════════════════════════════
//  inventory_correction.js — THE GOVERNED STAFF DOOR OVER THE EXISTING
//  RETIREMENT OWNER (inventory_retirement.js).
//
//  ── WHAT THIS IS ────────────────────────────────────────────────────
//  A review read, a transactional apply and a transactional reversal, so
//  an authorized person can look at ONE unit record, see why it is or is
//  not eligible to be retired as an obsolete inventory representation,
//  record that decision, and put it back later without erasing history.
//
//  ── WHAT IT DOES NOT OWN ────────────────────────────────────────────
//  · The retirement record and its predicate. Both belong to
//    inventory_retirement.js and are called, never copied.
//  · Authority. The route decides who may call this (the existing
//    governed override on the property assignment); this module only
//    RE-VERIFIES, inside the transaction, that the assignment it was told
//    about is still live with that authority. A leasing assignment, an
//    actor id, or knowledge of a unit id is not authority.
//  · Identity decisions about real Greenery records. Eligibility here
//    is a statement about RELATIONSHIPS Spine holds (leases, possession,
//    applications, offers, work, tours, a current-source claim), never
//    about whether a record is physically real. A unit that passes every
//    check is *retirable*, not *wrong*; the human decides that and says
//    why in the rationale.
//
//  ── THE REASON, PRESERVED ───────────────────────────────────────────
//  Only `superseded_by_corrected_inventory_grain` is accepted, and its
//  meaning is unchanged: the representation was never separate real
//  inventory. Demolition, conversion, temporary unavailability and
//  ordinary vacancy are refused by the owner's vocabulary wall, not by
//  copy here.
//
//  ── STALE REVIEW ────────────────────────────────────────────────────
//  The review read returns a `review_token`: a hash of the facts the
//  decision was made on (identity, hierarchy, retirement state, every
//  relationship count). Apply recomputes it inside the transaction, after
//  taking the locks, and refuses on mismatch. A decision is bound to what
//  was reviewed, not to a unit id.
//
//  ── CONCURRENT WRITERS ──────────────────────────────────────────────
//  A `FOR UPDATE` on the unit row alone excludes nothing that matters: a
//  lease, application, offer or possession event references a SPACE, and
//  its insert takes a KEY SHARE lock on that space row. So the apply locks
//  the unit's SPACES `FOR UPDATE` as well. A concurrent writer then waits
//  until this transaction commits, and finds either the retirement row
//  (the 180 trigger refuses the lease) or the relationship check on the
//  other side (this transaction refuses the retirement). Proven, not
//  described: see tests/e2e/inventory_correction.e2e.js.
//
//  CLASSIFICATION: Class 1 — permanent product door over a Class 1 owner.
//  TRANSACTION: apply/reinstate own their transaction (pool in, one
//  begin/commit/rollback); the retirement owner keeps its caller-owned
//  contract and runs inside it.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const {
  retireInventoryUnits, reinstateInventoryUnit, retirementProvenance,
  REASON_SUPERSEDED_GRAIN, ALL_REASONS,
} = require("./inventory_retirement");

const TERMINAL_APPLICATION = ["declined", "withdrawn", "expired"];
const CLOSED_WORK = ["closed", "cancelled", "completed", "done", "resolved", "void"];
const CLOSED_TOUR = ["cancelled", "completed", "no_show"];

function refuse(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = extra.httpStatus || 409;
  e.publicMessage = message;
  e.body = { error: code, receipt: message, ...extra, httpStatus: undefined };
  delete e.body.httpStatus;
  return e;
}

const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");

/*  ── THE FACTS A DECISION IS MADE ON ────────────────────────────────
 *  One loader, used by the review read AND by apply (inside the lock).
 *  q is a pool or a client; the shape is identical either way.  */
async function loadUnitFacts(q, { property_id, unit_id }) {
  const unit = (await q.query(
    `select u.id, u.property_id, u.unit_number, u.created_at, u.import_batch_id,
            u.source_type, u.source_as_of_date, u.is_down, u.operating_use,
            t.code as unit_type_code, t.label as unit_type_label
       from units u left join property_unit_types t on t.id = u.unit_type_id
      where u.id = $1`, [unit_id])).rows[0];
  if (!unit) return { unit: null };
  //  Custody is decided from the unit's own row, never from the request.
  if (String(unit.property_id) !== String(property_id)) {
    return { unit, not_at_property: true };
  }
  const spaces = (await q.query(
    `select s.id as space_id, s.space_label, s.use_type, s.position_kind
       from spaces s where s.unit_id = $1 order by s.space_label`, [unit_id])).rows;
  const spaceIds = spaces.map((s) => s.space_id);

  //  ── SOURCE AND PROMOTION LINEAGE (what produced this record) ───
  const candidates = (await q.query(
    `select ic.id as candidate_id, ic.run_id, r.created_at as run_at
       from ingest_candidates ic left join ingest_runs r on r.id = ic.run_id
      where ic.promoted_unit_id = $1 order by ic.id`, [unit_id])).rows;
  const sourceRows = (await q.query(
    `select r.id as source_row_id, r.row_index, r.produced_space_id, b.id as batch_id,
            b.source_file, b.source_as_of_date, b.leasing_model, b.confidence, b.status as batch_status
       from import_source_rows r join import_batches b on b.id = r.import_batch_id
      where r.produced_unit_id = $1 or r.produced_space_id = any($2::uuid[])
      order by b.source_as_of_date desc nulls last, r.row_index`, [unit_id, spaceIds])).rows;
  const claims = (await q.query(
    `select pr.id as proposed_record_id, pr.natural_key, pr.status, pr.status_reason,
            pr.confirmed_at, pr.activation_id
       from proposed_records pr
       join import_source_rows r on r.id = pr.import_source_row_id
      where pr.property_id = $1 and (r.produced_unit_id = $2 or r.produced_space_id = any($3::uuid[]))
      order by pr.confirmed_at desc nulls last`, [property_id, unit_id, spaceIds])).rows;
  //  The CURRENT representation: the latest established opening position's
  //  activation. A unit that representation itself produced cannot be
  //  "superseded by the corrected grain" — it IS the corrected grain.
  const latest = (await q.query(
    `select o.activation_id, o.import_batch_id, o.as_of_date, o.status
       from opening_tenancy_positions o
      where o.property_id = $1 and o.status = 'established' and o.superseded_at is null
      order by o.as_of_date desc nulls last, o.established_at desc nulls last limit 1`, [property_id])).rows[0] || null;
  const claimedByCurrent = latest ? claims.some((c) => String(c.activation_id) === String(latest.activation_id)
    && c.status === "promoted") : false;

  //  ── RETIREMENT STATE ────────────────────────────────────────────
  const retirements = (await q.query(
    `select ir.id, ir.retired_at, ir.retired_by_user_id, ir.retired_by_system, ir.reason_code,
            ir.superseded_rationale, ir.superseded_by_import_batch_id, ir.original_unit_number,
            ir.promoted_from_candidate_id, ir.promoted_from_ingest_run_id,
            ir.reversed_at, ir.reversed_by_user_id, ir.reversal_reason,
            ru.name as retired_by_name, vu.name as reversed_by_name
       from inventory_retirements ir
       left join users ru on ru.id = ir.retired_by_user_id
       left join users vu on vu.id = ir.reversed_by_user_id
      where ir.unit_id = $1 order by ir.retired_at desc`, [unit_id])).rows;
  const live = retirements.find((r) => !r.reversed_at) || null;

  //  ── RELATIONSHIPS (each one a reason a retirement cannot stand) ──
  const rel = (await q.query(
    `select
       (select count(*)::int from leases l where l.space_id = any($2::uuid[])) as leases_any,
       (select count(*)::int from leases l where l.space_id = any($2::uuid[])
          and l.lease_status not in ('cancelled','rescinded','void','superseded','terminated','expired')) as leases_live,
       (select count(*)::int from unit_events e where (e.unit_id = $1 or e.space_id = any($2::uuid[]))
          and coalesce(e.status,'') in ('scheduled','actioned')) as possession_events,
       (select count(*)::int from lease_applications a where (a.unit_id = $1 or a.space_id = any($2::uuid[]))
          and a.status not in ('declined','withdrawn','expired')) as open_applications,
       (select count(*)::int from lease_offers o where o.space_id = any($2::uuid[])
          and o.source = 'application_proposal' and o.status in ('draft','sent')
          and not exists (select 1 from lease_offers c where c.supersedes_application_offer_id = o.id)) as current_offers,
       (select count(*)::int from application_invitations i where (i.unit_id = $1 or i.space_id = any($2::uuid[]))
          and coalesce(i.status,'') in ('prepared','manually_sent','provider_dispatched')) as open_invitations,
       (select count(*)::int from work_orders w where w.unit_id = $1
          and coalesce(w.status,'') not in ('closed','cancelled','completed','done','resolved','void')) as open_work_orders,
       (select count(*)::int from tour_availability t where t.unit_id = $1 and t.ends_at > now()
          and coalesce(t.status,'') not in ('cancelled')) as future_tour_slots,
       (select count(*)::int from leasing_tours t where t.unit_id = $1
          and coalesce(t.scheduled_for, t.requested_for) > now()
          and coalesce(t.status,'') not in ('cancelled','completed','no_show')) as future_tours,
       (select count(*)::int from executed_lease_records x where x.space_id = any($2::uuid[])
          and coalesce(x.record_state,'') <> 'voided') as executed_lease_records,
       (select count(*)::int from renewal_cases rc where rc.space_id = any($2::uuid[]) and rc.terminal_state is null) as open_renewals,
       (select count(*)::int from turnovers tv where tv.unit_id = $1
          and coalesce(tv.status,'') not in ('closed','cancelled','completed','done')) as open_turnovers`,
    [unit_id, spaceIds])).rows[0];

  return {
    unit, spaces, lineage: { candidates, source_rows: sourceRows, claims, current_representation: latest, claimed_by_current_representation: claimedByCurrent },
    retirements, live_retirement: live, relationships: rel,
  };
}

function blockersFrom(facts) {
  const b = [];
  const r = facts.relationships;
  const add = (code, count, detail) => { if (count > 0) b.push({ code, count, detail }); };
  //  The owner's own wall first, in the owner's words: ANY lease.
  add("unit_carries_leases", r.leases_any, "A lease is attached at some grain of this unit. The retirement owner refuses this; resolve the tenancy first.");
  add("possession_recorded", r.possession_events, "A scheduled or actioned unit event (move-in, possession, lease start/end, use change) names this unit or one of its positions.");
  add("open_applications", r.open_applications, "An application that is not declined, withdrawn or expired targets this unit or a position in it.");
  add("current_offers", r.current_offers, "A current application offer targets a position in this unit.");
  add("open_invitations", r.open_invitations, "A prepared or sent application invitation targets this unit.");
  add("executed_lease_records", r.executed_lease_records, "An executed lease record names a position in this unit.");
  add("open_renewals", r.open_renewals, "A renewal case is open on a position in this unit.");
  add("open_work_orders", r.open_work_orders, "Work is open on this unit.");
  add("open_turnovers", r.open_turnovers, "A turnover is open on this unit.");
  add("future_tours", r.future_tour_slots + r.future_tours, "A future tour or published tour slot names this unit.");
  if (facts.lineage.claimed_by_current_representation) {
    b.push({ code: "claimed_by_current_representation", count: 1,
      detail: "The latest established opening position's own confirmed source row produced this unit. It is part of the current representation, not superseded by it." });
  }
  return b;
}

function reviewToken(facts) {
  return sha({
    unit_id: facts.unit.id, unit_number: facts.unit.unit_number, property_id: facts.unit.property_id,
    spaces: facts.spaces.map((s) => [s.space_id, s.space_label, s.use_type, s.position_kind]),
    live_retirement: facts.live_retirement ? facts.live_retirement.id : null,
    retirements: facts.retirements.length,
    relationships: facts.relationships,
    claimed_by_current: facts.lineage.claimed_by_current_representation,
    current_activation: facts.lineage.current_representation ? facts.lineage.current_representation.activation_id : null,
  });
}

function assess(facts) {
  const blockers = blockersFrom(facts);
  if (facts.live_retirement) {
    return { action: "reinstate", eligible: true, reason_code: "retired",
      blockers, //  reported, not enforced: reinstatement restores reads, it does not need a clean slate
      message: "This unit is retired from current inventory. It can be reinstated; the retirement stays as history." };
  }
  if (blockers.length) {
    return { action: "retire", eligible: false, reason_code: "blocked", blockers,
      message: "This unit cannot be retired as an obsolete representation while these relationships stand." };
  }
  return { action: "retire", eligible: true, reason_code: "eligible", blockers: [],
    message: "No lease, possession, application, offer, work, tour or current-source claim references this unit. " +
      "It MAY be retired as an obsolete representation if a person decides it never was separate real inventory and says why." };
}

/*  reviewUnit — the read the decision is made on.  */
async function reviewUnit(pool, { property_id, unit_id }) {
  if (!property_id || !unit_id) throw refuse("unit_id_required", "A unit id is required.", { httpStatus: 400 });
  const facts = await loadUnitFacts(pool, { property_id, unit_id });
  if (!facts.unit) throw refuse("unit_not_found", "No unit with that id.", { httpStatus: 404 });
  if (facts.not_at_property) throw refuse("not_permitted", "This action is not permitted.", { httpStatus: 403 });
  const verdict = assess(facts);
  return {
    unit: {
      unit_id: facts.unit.id, unit_number: facts.unit.unit_number, property_id: facts.unit.property_id,
      unit_type: facts.unit.unit_type_code ? { code: facts.unit.unit_type_code, label: facts.unit.unit_type_label } : null,
      created_at: facts.unit.created_at, source_type: facts.unit.source_type || null,
      source_as_of_date: facts.unit.source_as_of_date || null, import_batch_id: facts.unit.import_batch_id || null,
      is_down: facts.unit.is_down === true, operating_use: facts.unit.operating_use || null,
    },
    spaces: facts.spaces,
    lineage: {
      promotion: facts.lineage.candidates,
      source_rows: facts.lineage.source_rows,
      claims: facts.lineage.claims,
      current_representation: facts.lineage.current_representation,
      claimed_by_current_representation: facts.lineage.claimed_by_current_representation,
      //  Unknown stays visible: a unit with no lineage rows is a unit Spine
      //  cannot explain, which is a fact about the record, not a defect in it.
      lineage_known: facts.lineage.candidates.length > 0 || facts.lineage.source_rows.length > 0,
    },
    retirement: { state: facts.live_retirement ? "retired" : "current", live: facts.live_retirement, history: facts.retirements },
    relationships: facts.relationships,
    eligibility: verdict,
    reason_vocabulary: ALL_REASONS,
    proposed_reason: REASON_SUPERSEDED_GRAIN,
    review_token: reviewToken(facts),
  };
}

/*  listUnits — every unit at the property with its correction state, so
 *  the surface can show retired records the position readers hide.
 *  Nothing is pre-selected; this is a list, not a proposal.  */
async function listUnits(pool, { property_id }) {
  const rows = (await pool.query(
    `select u.id as unit_id, u.unit_number,
            (select count(*)::int from spaces s where s.unit_id = u.id) as spaces,
            ir.id as live_retirement_id, ir.retired_at, ir.reason_code,
            (select count(*)::int from inventory_retirements h where h.unit_id = u.id) as retirement_history,
            exists (select 1 from ingest_candidates ic where ic.promoted_unit_id = u.id)
              or exists (select 1 from import_source_rows r where r.produced_unit_id = u.id) as lineage_known,
            (select count(*)::int from leases l join spaces s on s.id = l.space_id where s.unit_id = u.id) as leases_any
       from units u
       left join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
      where u.property_id = $1
      order by u.unit_number`, [property_id])).rows;
  return {
    property_id,
    units_total: rows.length,
    retired_now: rows.filter((r) => r.live_retirement_id).length,
    current_inventory_units: rows.filter((r) => !r.live_retirement_id).length,
    units: rows.map((r) => ({
      unit_id: r.unit_id, unit_number: r.unit_number, spaces: r.spaces,
      state: r.live_retirement_id ? "retired" : "current",
      retired_at: r.retired_at || null, reason_code: r.reason_code || null,
      retirement_history: r.retirement_history, lineage_known: r.lineage_known === true,
      carries_leases: r.leases_any > 0,
    })),
  };
}

/*  Re-verify, inside the transaction, that the actor still holds the
 *  governed override at THIS property. Authority that was removed after
 *  the review was rendered must not carry the write.  */
async function assertLiveAuthority(client, { property_id, user_id }) {
  const a = (await client.query(
    `select id, can_manage_roles, allowed_modules from property_team_assignments
      where property_id = $1 and user_id = $2 and active order by created_at desc limit 1`,
    [property_id, user_id])).rows[0];
  if (!a || a.can_manage_roles !== true || !(a.allowed_modules || []).includes("management")) {
    throw refuse("authority_changed", "Your assignment at this property no longer carries inventory-correction authority.", { httpStatus: 403 });
  }
  return a.id;
}

/*  applyRetirement — one decision over one or more reviewed units. All or
 *  nothing: any refused unit refuses the whole submission before a row
 *  is written.  */
async function applyRetirement(pool, {
  property_id, actor, unit_ids = [], review_tokens = {}, rationale,
  reason_code = REASON_SUPERSEDED_GRAIN, superseded_by_import_batch_id = null,
  confirmed = false, idempotency_key = null,
} = {}) {
  if (!actor || !actor.user_id) throw refuse("actor_required", "A signed-in person is required.", { httpStatus: 401 });
  const ids = [...new Set((unit_ids || []).map(String).filter(Boolean))];
  if (!ids.length) throw refuse("unit_ids_required", "Select at least one unit.", { httpStatus: 400 });
  if (confirmed !== true) throw refuse("confirmation_required", "Confirm the retirement explicitly.", { httpStatus: 400 });
  if (!ALL_REASONS.includes(reason_code)) {
    throw refuse("UNKNOWN_RETIREMENT_REASON",
      `'${reason_code}' is not a governed retirement reason. Known: ${ALL_REASONS.join(", ")}.`, { httpStatus: 400 });
  }
  const missingTokens = ids.filter((id) => !review_tokens || !review_tokens[id]);
  if (missingTokens.length) {
    throw refuse("review_required", "Each selected unit must be reviewed first; its review token is missing.", { httpStatus: 400, unit_ids: missingTokens });
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    const assignmentId = await assertLiveAuthority(client, { property_id, user_id: actor.user_id });
    //  Locks: the units, then their spaces (KEY SHARE exclusion — see header).
    const locked = (await client.query(
      `select id, property_id from units where id = any($1::uuid[]) order by id for update`, [ids])).rows;
    const found = new Set(locked.map((u) => String(u.id)));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw refuse("UNIT_NOT_FOUND", `No such unit(s): ${missing.join(", ")}.`, { httpStatus: 404, missing });
    const foreign = locked.filter((u) => String(u.property_id) !== String(property_id));
    if (foreign.length) throw refuse("not_permitted", "This action is not permitted.", { httpStatus: 403 });
    await client.query(`select id from spaces where unit_id = any($1::uuid[]) order by id for update`, [ids]);
    if (superseded_by_import_batch_id) {
      const b = (await client.query(`select property_id from import_batches where id = $1`, [superseded_by_import_batch_id])).rows[0];
      if (!b || String(b.property_id) !== String(property_id)) {
        throw refuse("superseding_batch_not_at_property", "The cited superseding source is not this property's.", { httpStatus: 409 });
      }
    }
    const refused = [];
    const reviewed = [];
    for (const id of ids) {
      const facts = await loadUnitFacts(client, { property_id, unit_id: id });
      //  A repeat of a decision already taken is named as such (the owner's
      //  own word), not reported as a stale review.
      if (facts.live_retirement) {
        refused.push({ unit_id: id, unit_number: facts.unit.unit_number, code: "ALREADY_RETIRED", retirement_id: facts.live_retirement.id,
          detail: "Already retired. Nothing was written." });
        continue;
      }
      const token = reviewToken(facts);
      if (String(review_tokens[id]) !== token) {
        refused.push({ unit_id: id, unit_number: facts.unit.unit_number, code: "stale_review",
          detail: "The record changed after it was reviewed. Review it again before deciding." });
        continue;
      }
      const verdict = assess(facts);
      if (!verdict.eligible) {
        refused.push({ unit_id: id, unit_number: facts.unit.unit_number, code: "blocked", blockers: verdict.blockers });
        continue;
      }
      reviewed.push(facts);
    }
    if (refused.length) {
      throw refuse("retirement_refused", "Nothing was written: one or more selected units cannot be retired.", { httpStatus: 409, refused, written: 0 });
    }
    //  THE OWNER WRITES. Its own walls (any lease, vocabulary, rationale
    //  length, already-retired) are re-applied here; nothing above replaces them.
    const out = await retireInventoryUnits(client, {
      property_id, unit_ids: ids, reason_code, rationale, superseded_by_import_batch_id,
      actor: { user_id: actor.user_id },
    });
    await client.query(
      `insert into events (property_id, unit_id, type, note)
       select $1, x.unit_id, 'inventory_retired_by_decision', $2 from unnest($3::uuid[]) as x(unit_id)`,
      [property_id, `retired as obsolete representation by user ${actor.user_id} (assignment ${assignmentId}${idempotency_key ? ", key " + idempotency_key : ""})`, ids]);
    await client.query("commit");
    return { ...out, assignment_id: assignmentId, idempotency_key: idempotency_key || null };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

/*  applyReinstatement — reverse one live retirement, as history.  */
async function applyReinstatement(pool, { property_id, actor, unit_id, review_token, reason, confirmed = false } = {}) {
  if (!actor || !actor.user_id) throw refuse("actor_required", "A signed-in person is required.", { httpStatus: 401 });
  if (!unit_id) throw refuse("unit_id_required", "A unit id is required.", { httpStatus: 400 });
  if (confirmed !== true) throw refuse("confirmation_required", "Confirm the reinstatement explicitly.", { httpStatus: 400 });
  if (!review_token) throw refuse("review_required", "Review the unit first; its review token is missing.", { httpStatus: 400 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const assignmentId = await assertLiveAuthority(client, { property_id, user_id: actor.user_id });
    const u = (await client.query(`select id, property_id from units where id = $1 for update`, [unit_id])).rows[0];
    if (!u) throw refuse("UNIT_NOT_FOUND", "No such unit.", { httpStatus: 404 });
    if (String(u.property_id) !== String(property_id)) throw refuse("not_permitted", "This action is not permitted.", { httpStatus: 403 });
    await client.query(`select id from spaces where unit_id = $1 order by id for update`, [unit_id]);
    const facts = await loadUnitFacts(client, { property_id, unit_id });
    if (String(review_token) !== reviewToken(facts)) {
      throw refuse("stale_review", "The record changed after it was reviewed. Review it again before deciding.", { httpStatus: 409 });
    }
    if (!facts.live_retirement) throw refuse("NOT_RETIRED", "That unit has no live retirement to reverse.", { httpStatus: 409 });
    //  Identity is revalidated, not assumed: the label must still be free
    //  among CURRENT units (the unique index holds it regardless, but the
    //  refusal should be a sentence, not a constraint error).
    const clash = (await client.query(
      `select u2.id from units u2 where u2.property_id = $1 and u2.unit_number = $2 and u2.id <> $3
          and not exists (select 1 from inventory_retirements ir where ir.unit_id = u2.id and ir.reversed_at is null)`,
      [property_id, facts.unit.unit_number, unit_id])).rows[0];
    if (clash) throw refuse("identity_conflict", `Another current unit already carries the label ${facts.unit.unit_number}.`, { httpStatus: 409 });
    const out = await reinstateInventoryUnit(client, { unit_id, actor: { user_id: actor.user_id }, reason });
    await client.query(
      `insert into events (property_id, unit_id, type, note) values ($1, $2, 'inventory_reinstated_by_decision', $3)`,
      [property_id, unit_id, `reinstated to current inventory by user ${actor.user_id} (assignment ${assignmentId})`]);
    await client.query("commit");
    return { ...out, unit_id, assignment_id: assignmentId,
      //  Reinstating does not manufacture a basis: the position reads again,
      //  with whatever basis it had. Said here so the receipt cannot imply more.
      restores: "current inventory participation only — no opening position, use, availability or readiness is established by this act",
      tenancy_attached_while_retired: facts.relationships.leases_any };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function history(pool, { property_id }) {
  return retirementProvenance(pool, { property_id });
}

module.exports = { reviewUnit, listUnits, applyRetirement, applyReinstatement, history, loadUnitFacts, assess, reviewToken };
