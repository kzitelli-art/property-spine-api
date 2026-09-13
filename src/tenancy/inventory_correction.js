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
//  · The relationship policy. Which references block, which are history
//    and which are interest is declared ONCE in
//    inventory_relationship_policy.js; this module reads it, migration
//    197 installs it as database triggers, and the coverage gate asserts
//    nothing references a unit or space without a classification.
//  · Authority. The route decides who may call this (the existing
//    governed override on the property assignment); this module only
//    RE-VERIFIES, inside the transaction and AFTER the inventory locks,
//    that the assignment is still live with that authority and the
//    actor is still an active user. A leasing assignment, an actor id,
//    or knowledge of a unit id is not authority.
//  · Identity decisions about real records. Eligibility here is a
//    statement about RELATIONSHIPS Spine holds, never about whether a
//    record is physically real. A unit that passes every check is
//    *retirable*, not *wrong*; the human decides that and says why.
//
//  ── THE REASON, PRESERVED ───────────────────────────────────────────
//  Only `superseded_by_corrected_inventory_grain` is accepted, and its
//  meaning is unchanged: the representation was never separate real
//  inventory. Demolition, conversion, temporary unavailability and
//  ordinary vacancy are refused by the owner's vocabulary wall.
//
//  ── STALE REVIEW ────────────────────────────────────────────────────
//  The review read returns a `review_token`: a hash of the facts the
//  decision was made on (identity, hierarchy, retirement state, every
//  relationship count, the identity read). Apply recomputes it inside
//  the transaction, after taking the locks, and refuses on mismatch.
//
//  ── LOCK ORDER (every writer here, always the same) ─────────────────
//    1. units FOR UPDATE (by id)      2. their spaces FOR UPDATE (by id)
//    3. the actor's assignment FOR SHARE   4. the actor's user row FOR SHARE
//  The assignment and user rows are read AFTER the inventory locks, so a
//  revocation that lands while this transaction waits for inventory is
//  seen (the delivered candidate read them first and never rechecked).
//  FOR SHARE makes the governed PATCH door wait for this commit instead
//  of slipping between the check and the write.
//
//  ── COMMAND IDENTITY ────────────────────────────────────────────────
//  A retire or reinstate command with an idempotency key is a durable
//  receipt in inventory_correction_commands (the 188 tour-command
//  pattern). The receipt is looked up BEFORE the stale-review and
//  already-retired checks, so a lost response after commit replays the
//  recorded result instead of becoming a different refusal; the same key
//  with a different payload is a conflict; retire and reinstate are
//  independent identities. Entitlement is revalidated before a replay.
//
//  CLASSIFICATION: Class 1 — permanent product door over a Class 1 owner.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");
const {
  retireInventoryUnits, reinstateInventoryUnit, retirementProvenance,
  REASON_SUPERSEDED_GRAIN, ALL_REASONS,
} = require("./inventory_retirement");
const { POLICY, BLOCKING, TREATMENTS, operativeSql } = require("./inventory_relationship_policy");

const EXPLANATION_LIMIT = 25;
const LIST_LIMIT_DEFAULT = 100, LIST_LIMIT_MAX = 500;
const HISTORY_LIMIT_DEFAULT = 50, HISTORY_LIMIT_MAX = 500;
const IDENTITY_SETTLED = "settled_by_established_record";
const IDENTITY_NOT_COVERED = "position_not_covered_by_current_representation";
const IDENTITY_DECISIONS = [IDENTITY_SETTLED, IDENTITY_NOT_COVERED];
const REASON_MEANING = {
  [REASON_SUPERSEDED_GRAIN]: "the record modelled a position the corrected inventory grain represents elsewhere; it was never separate real inventory",
};

function refuse(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = extra.httpStatus || 409;
  e.publicMessage = message;
  e.body = { error: code, receipt: message, ...extra, httpStatus: undefined };
  delete e.body.httpStatus;
  return e;
}

//  Canonical JSON: sorted keys at every level, so the same command hashes
//  the same however the client ordered its fields.
function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}
const sha = (v) => crypto.createHash("sha256").update(canonical(v)).digest("hex");
const clampInt = (v, d, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : d; };

/*  ── THE POLICY, AS SQL ─────────────────────────────────────────────
 *  Blocking entries grouped by table, so a row that names both a unit
 *  and one of its positions is counted once. `t` is the alias every
 *  operativeSql predicate is written against.  */
function blockingByTable() {
  const m = new Map();
  for (const e of BLOCKING) {
    if (e.table === "spaces") continue;              //  a unit's own positions are not a relationship
    if (!m.has(e.table)) m.set(e.table, { entry: e, columns: [] });
    m.get(e.table).columns.push(e.column);
  }
  return [...m.values()];
}
const unitOrSpacePredicate = (columns, unitParam, spacesParam) => "(" + columns.map((c) =>
  c === "unit_id" ? `t.unit_id = ${unitParam}` : `t.${c} = any(${spacesParam}::uuid[])`).join(" or ") + ")";

//  Per-unit relationship counts, one statement.
const RELATIONSHIP_SQL = blockingByTable().map(({ entry, columns }) =>
  `select '${entry.code}' as code, '${entry.label}' as kind, count(*)::int as n from ${entry.table} t
    where ${unitOrSpacePredicate(columns, "$1", "$2")} and ${operativeSql(entry)}`).join("\nunion all\n");

//  Non-blocking references, counted so the review can say they exist.
const RETAINED_SQL = POLICY.filter((e) => e.treatment === TREATMENTS.H || e.treatment === TREATMENTS.I).map((e) =>
  `select '${e.treatment}' as treatment, '${e.label}' as kind, count(*)::int as n from ${e.table} t
    where ${e.column === "unit_id" || e.column.endsWith("unit_id") ? `t.${e.column} = $1` : `t.${e.column} = any($2::uuid[])`}`).join("\nunion all\n");

//  Property-wide: operative rows attached to LIVE-RETIRED units, by label
//  and kind. Includes the owner's any-lease wall. This is the conflict
//  read the standing projection and the history carry; it never repairs.
const CONFLICT_SQL = blockingByTable().map(({ entry, columns }) => {
  const unitExpr = columns.includes("unit_id") && columns.length > 1
    ? "coalesce(t.unit_id, (select s.unit_id from spaces s where s.id = t.space_id))"
    : columns.includes("unit_id") ? "t.unit_id" : `(select s.unit_id from spaces s where s.id = t.${columns[0]})`;
  return `select u.unit_number as label, '${entry.code}' as code, '${entry.label}' as kind, count(*)::int as n
            from ${entry.table} t
            join units u on u.id = ${unitExpr}
            join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
           where u.property_id = $1 and ${operativeSql(entry)}
           group by u.unit_number`;
}).join("\nunion all\n");

const BLOCKER_DETAIL = {
  unit_carries_leases: "A lease is attached at some grain of this unit. The retirement owner refuses this; resolve the tenancy first.",
  possession_recorded: "A scheduled or actioned unit event (move-in, possession, lease start/end, use change) names this unit or one of its positions.",
  open_applications: "An application that is not declined, withdrawn or expired targets this unit or a position in it.",
  current_offers: "An offer that is not expired, superseded or cancelled targets a position in this unit.",
  open_invitations: "A prepared or sent application invitation targets this unit.",
  open_lease_packets: "A lease packet that is neither executed nor voided names this unit.",
  economic_schedules: "A locked or active economic schedule is attached to a position in this unit.",
  executed_lease_records: "An executed lease record names a position in this unit.",
  open_renewals: "A renewal case is open on a position in this unit.",
  future_tours: "A future tour or published tour slot names this unit.",
  open_work_orders: "Work is open on this unit.",
  open_turnovers: "A turnover is open on this unit.",
  open_obligations: "An obligation is open on this unit.",
  required_work: "Required work from triage is still outstanding on this unit or a position in it.",
  readiness_certifications: "A readiness certification stands on this unit.",
  procurement: "A bid or supply request names this unit.",
  money_attached: "A scheduled charge, ledger claim, deposit claim or money event is attached to this unit. Money is evidence; it is never zero by assumption.",
  configured_services: "A utility service point or contracted service location is configured on this unit or a position in it.",
};

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
            ru.name as retired_by_name, vu.name as reversed_by_name,
            b.source_file as superseding_source_file, b.source_as_of_date as superseding_source_as_of
       from inventory_retirements ir
       left join users ru on ru.id = ir.retired_by_user_id
       left join users vu on vu.id = ir.reversed_by_user_id
       left join import_batches b on b.id = ir.superseded_by_import_batch_id
      where ir.unit_id = $1 order by ir.retired_at desc`, [unit_id])).rows;
  const live = retirements.find((r) => !r.reversed_at) || null;

  //  ── RELATIONSHIPS, FROM THE POLICY (each one a reason a retirement
  //     cannot stand), plus the retained/interest references it names ──
  const relRows = (await q.query(RELATIONSHIP_SQL, [unit_id, spaceIds])).rows;
  const relationships = {};
  const kinds = {};
  for (const r of relRows) {
    relationships[r.code] = (relationships[r.code] || 0) + r.n;
    if (r.n > 0) (kinds[r.code] = kinds[r.code] || []).push({ kind: r.kind, count: r.n });
  }
  const retainedRows = (await q.query(RETAINED_SQL, [unit_id, spaceIds])).rows;
  const retained = { history_records: 0, interest_records: 0, kinds: [] };
  for (const r of retainedRows) {
    if (r.treatment === TREATMENTS.H) retained.history_records += r.n; else retained.interest_records += r.n;
    if (r.n > 0) retained.kinds.push({ kind: r.kind, count: r.n, treatment: r.treatment });
  }

  const lineage = { candidates, source_rows: sourceRows, claims, current_representation: latest, claimed_by_current_representation: claimedByCurrent };
  const identity = await identityFacts(q, { property_id, unit, spaceIds, live_retirement: live, lineage });

  return { unit, spaces, lineage, retirements, live_retirement: live, relationships, relationship_kinds: kinds, retained, identity };
}

/*  ── IDENTITY: DOES A CURRENT RECORD COVER THIS POSITION? ───────────
 *  Read from durable evidence keyed by the record's LABEL, never inferred
 *  from label shape:
 *    · a promoted claim under the current established representation
 *      whose key or source values name this label but which produced a
 *      DIFFERENT unit or position (a differently labelled parent/bed
 *      record covering the same position)
 *    · a row of the cited superseding source that names this label and
 *      produced a different record
 *    · a position under a current unit carrying this label
 *  `own_claim_by_current_representation` is the opposite evidence: the
 *  current representation confirms this record's own position.
 *
 *  reinstatement:  covered     a current record covers it — reinstating
 *                              would knowingly double-count; refused
 *                  clear       the established record settles it (own
 *                              claim, or no superseding source was cited)
 *                  unresolved  a superseding source was cited and the
 *                              established record says nothing either
 *                              way; only an explicit authorized
 *                              correction settles it, and it is recorded
 *                  null        not retired — nothing to reinstate  */
async function identityFacts(q, { property_id, unit, spaceIds, live_retirement, lineage }) {
  const label = unit.unit_number;
  const cur = lineage.current_representation;
  const covering = [];
  if (cur) {
    const rows = (await q.query(
      `select pr.natural_key, pu.unit_number as produced_unit_label, ps.space_label as produced_space_label
         from proposed_records pr
         join import_source_rows r on r.id = pr.import_source_row_id
         left join units pu on pu.id = r.produced_unit_id
         left join spaces ps on ps.id = r.produced_space_id
        where pr.property_id = $1 and pr.activation_id = $2 and pr.status = 'promoted'
          and (r.produced_unit_id is not null or r.produced_space_id is not null)
          and r.produced_unit_id is distinct from $3
          and (r.produced_space_id is null or r.produced_space_id <> all($4::uuid[]))
          and (pr.natural_key = $5 or pr.natural_key like $5 || '|%'
               or exists (select 1 from jsonb_each_text(coalesce(pr.normalized_json, '{}'::jsonb)) kv where kv.value = $5)
               or exists (select 1 from jsonb_each_text(coalesce(r.raw, '{}'::jsonb)) kv where kv.value = $5))
        order by pr.natural_key limit 25`, [property_id, cur.activation_id, unit.id, spaceIds, label])).rows;
    for (const r of rows) covering.push({ evidence: "promoted_claim_under_current_representation", key: r.natural_key, produced_unit_label: r.produced_unit_label, produced_space_label: r.produced_space_label });
  }
  if (live_retirement && live_retirement.superseded_by_import_batch_id) {
    const rows = (await q.query(
      `select r.row_index, pu.unit_number as produced_unit_label, ps.space_label as produced_space_label
         from import_source_rows r
         left join units pu on pu.id = r.produced_unit_id
         left join spaces ps on ps.id = r.produced_space_id
        where r.import_batch_id = $1
          and (r.produced_unit_id is not null or r.produced_space_id is not null)
          and r.produced_unit_id is distinct from $2
          and (r.produced_space_id is null or r.produced_space_id <> all($3::uuid[]))
          and exists (select 1 from jsonb_each_text(coalesce(r.raw, '{}'::jsonb)) kv where kv.value = $4)
        order by r.row_index limit 25`, [live_retirement.superseded_by_import_batch_id, unit.id, spaceIds, label])).rows;
    for (const r of rows) covering.push({ evidence: "cited_superseding_source_row", key: `row ${r.row_index}`, produced_unit_label: r.produced_unit_label, produced_space_label: r.produced_space_label });
  }
  const spaceRows = (await q.query(
    `select u.unit_number as produced_unit_label, s.space_label as produced_space_label
       from spaces s join units u on u.id = s.unit_id
      where u.property_id = $1 and s.space_label = $2 and u.id <> $3
        and not exists (select 1 from inventory_retirements ir where ir.unit_id = u.id and ir.reversed_at is null)
      order by u.unit_number limit 25`, [property_id, label, unit.id])).rows;
  for (const r of spaceRows) covering.push({ evidence: "current_position_carrying_this_label", key: `${r.produced_unit_label} | ${r.produced_space_label}`, produced_unit_label: r.produced_unit_label, produced_space_label: r.produced_space_label });

  let reinstatement = null;
  if (live_retirement) {
    if (covering.length) reinstatement = "covered";
    else if (lineage.claimed_by_current_representation || !live_retirement.superseded_by_import_batch_id) reinstatement = "clear";
    else reinstatement = "unresolved";
  }
  return {
    label,
    own_claim_by_current_representation: lineage.claimed_by_current_representation,
    cited_superseding_source: live_retirement && live_retirement.superseded_by_import_batch_id
      ? { source_file: live_retirement.superseding_source_file || null, source_as_of: live_retirement.superseding_source_as_of || null } : null,
    covering_records: covering,
    reinstatement,
    settles_by: reinstatement === "unresolved"
      ? `an explicit authorized correction: identity_decision '${IDENTITY_NOT_COVERED}' with a reason of at least 20 characters`
      : reinstatement === "covered" ? "correcting the covering record first; reinstating over it would double-count the position" : null,
  };
}

function blockersFrom(facts) {
  const b = [];
  const r = facts.relationships;
  //  The owner's own wall first, in the owner's words: ANY lease.
  const order = ["unit_carries_leases", ...Object.keys(BLOCKER_DETAIL).filter((c) => c !== "unit_carries_leases")];
  for (const code of order) {
    if ((r[code] || 0) > 0) b.push({ code, count: r[code], kinds: facts.relationship_kinds[code] || [], detail: BLOCKER_DETAIL[code] });
  }
  if (facts.lineage.claimed_by_current_representation) {
    b.push({ code: "claimed_by_current_representation", count: 1, kinds: [],
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
    identity: { reinstatement: facts.identity.reinstatement, covering: facts.identity.covering_records.map((c) => [c.evidence, c.key]) },
  });
}

function assess(facts) {
  const blockers = blockersFrom(facts);
  if (facts.live_retirement) {
    const id = facts.identity.reinstatement;
    return { action: "reinstate", eligible: id !== "covered", reason_code: id === "covered" ? "identity_covered" : id === "unresolved" ? "identity_unresolved" : "retired",
      blockers, //  reported, not enforced: they are conflicts that arrived after retirement, and reinstating makes them visible again
      identity: id,
      message: id === "covered"
        ? "This unit is retired and a current record covers the same position. Reinstating it would double-count that position; correct the covering record first."
        : id === "unresolved"
          ? "This unit is retired citing a superseding source that does not name it. Spine cannot settle whether the corrected inventory covers this position; reinstating requires an explicit authorized correction saying it does not."
          : "This unit is retired from current inventory. It can be reinstated; the retirement stays as history." };
  }
  if (blockers.length) {
    return { action: "retire", eligible: false, reason_code: "blocked", blockers,
      message: "This unit cannot be retired as an obsolete representation while these relationships stand." };
  }
  return { action: "retire", eligible: true, reason_code: "eligible", blockers: [],
    message: "No lease, possession, application, offer, invitation, packet, renewal, work, turnover, obligation, required work, readiness certification, procurement, money, configured service, tour or current-source claim references this unit. " +
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
    relationship_kinds: facts.relationship_kinds,
    retained_references: facts.retained,
    identity: facts.identity,
    identity_decisions: IDENTITY_DECISIONS,
    eligibility: verdict,
    reason_vocabulary: ALL_REASONS,
    proposed_reason: REASON_SUPERSEDED_GRAIN,
    review_token: reviewToken(facts),
  };
}

/*  listUnits — units at the property with their correction state, so the
 *  surface can show retired records the position readers hide. Bounded
 *  and filterable; the totals are always the whole property's.  */
async function listUnits(pool, { property_id, limit, offset, state = "all", q = "" } = {}) {
  const lim = clampInt(limit, LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX) || LIST_LIMIT_DEFAULT;
  const off = clampInt(offset, 0, 1e9);
  const st = ["all", "current", "retired"].includes(state) ? state : "all";
  const needle = String(q || "").trim();
  const totals = (await pool.query(
    `select count(*)::int as units_total,
            count(*) filter (where ir.id is not null)::int as retired_now,
            count(*) filter (where ir.id is null)::int as current_inventory_units
       from units u left join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
      where u.property_id = $1`, [property_id])).rows[0];
  const where = ["u.property_id = $1"];
  const args = [property_id];
  if (st === "current") where.push("ir.id is null");
  if (st === "retired") where.push("ir.id is not null");
  if (needle) { args.push("%" + needle.replace(/[%_\\]/g, (c) => "\\" + c) + "%"); where.push(`u.unit_number ilike $${args.length} escape '\\'`); }
  const filtered = (await pool.query(
    `select count(*)::int as n from units u left join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null where ${where.join(" and ")}`, args)).rows[0].n;
  args.push(lim, off);
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
      where ${where.join(" and ")}
      order by u.unit_number
      limit $${args.length - 1} offset $${args.length}`, args)).rows;
  return {
    property_id,
    units_total: totals.units_total,
    retired_now: totals.retired_now,
    current_inventory_units: totals.current_inventory_units,
    page: { limit: lim, offset: off, returned: rows.length, filtered_total: filtered, state: st, q: needle || null },
    units: rows.map((r) => ({
      unit_id: r.unit_id, unit_number: r.unit_number, spaces: r.spaces,
      state: r.live_retirement_id ? "retired" : "current",
      retired_at: r.retired_at || null, reason_code: r.reason_code || null,
      retirement_history: r.retirement_history, lineage_known: r.lineage_known === true,
      carries_leases: r.leases_any > 0,
    })),
  };
}

/*  ── THE BOUNDED CORRECTION EXPLANATION ─────────────────────────────
 *  One read, two projections: the staff history view and the tenancy
 *  standing projection Ask Spine gathers. Labels only — no record ids, no
 *  actor ids — so it survives the model-payload sanitizer unchanged and
 *  the two audiences read the same words.  */
async function correctionStanding(pool, { property_id }) {
  const live = (await pool.query(
    `select ir.original_unit_number as label, ir.retired_at::date as retired_on, ir.reason_code,
            left(coalesce(ir.superseded_rationale, ''), 240) as rationale,
            b.source_file as superseding_source_file, b.source_as_of_date as superseding_source_as_of,
            case when ir.retired_by_user_id is not null then 'staff decision' else coalesce(ir.retired_by_system, 'system') end as decided_by
       from inventory_retirements ir
       left join import_batches b on b.id = ir.superseded_by_import_batch_id
      where ir.property_id = $1 and ir.reversed_at is null
      order by ir.retired_at desc, ir.original_unit_number
      limit ${EXPLANATION_LIMIT + 1}`, [property_id])).rows;
  const counts = (await pool.query(
    `select count(*) filter (where reversed_at is null)::int as retired_now,
            count(*) filter (where reversed_at is not null)::int as reversed,
            count(*)::int as decisions
       from inventory_retirements where property_id = $1`, [property_id])).rows[0];
  const conflictRows = (await pool.query(CONFLICT_SQL, [property_id])).rows;
  const byLabel = new Map();
  for (const c of conflictRows) {
    if (!byLabel.has(c.label)) byLabel.set(c.label, []);
    byLabel.get(c.label).push({ kind: c.kind, code: c.code, count: c.n });
  }
  const conflicts = [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, attachments]) => ({ label, attachments }));
  return {
    read_state: "OK",
    excluded_from_current_inventory: counts.retired_now,
    excluded_records: live.slice(0, EXPLANATION_LIMIT).map((r) => ({
      label: r.label, retired_on: r.retired_on, reason: r.reason_code,
      reason_meaning: REASON_MEANING[r.reason_code] || null, rationale: r.rationale || null,
      superseding_source: r.superseding_source_file ? { source_file: r.superseding_source_file, source_as_of: r.superseding_source_as_of } : null,
      decided_by: r.decided_by,
    })),
    excluded_records_truncated: live.length > EXPLANATION_LIMIT,
    reinstated_records: counts.reversed,
    //  Operative work attached to retired inventory: named, scoped,
    //  never zeroed and never repaired here.
    operative_work_on_retired_inventory: conflicts,
    conflict: conflicts.length > 0,
    provenance: { decisions_recorded: counts.decisions, reason_vocabulary: ALL_REASONS, recorded_by: "inventory_retirement (owner) via the governed staff door" },
    does_not_establish: [
      "Whether a retired record was physically real — retirement records a decision about representation, with the decider's rationale.",
      "Any occupancy, availability, readiness or use for a reinstated record — reinstating restores current-inventory participation only.",
    ],
  };
}

/*  Re-verify, inside the transaction and AFTER the inventory locks, that
 *  the actor still holds the governed override at THIS property and is
 *  still an active user. FOR SHARE on both rows: the governed PATCH door
 *  and any deactivation wait for this commit rather than slipping between
 *  the check and the write.  */
async function assertLiveAuthority(client, { property_id, user_id }) {
  const a = (await client.query(
    `select id, can_manage_roles, allowed_modules from property_team_assignments
      where property_id = $1 and user_id = $2 and active order by created_at desc limit 1 for share`,
    [property_id, user_id])).rows[0];
  if (!a || a.can_manage_roles !== true || !(a.allowed_modules || []).includes("management")) {
    throw refuse("authority_changed", "Your assignment at this property no longer carries inventory-correction authority.", { httpStatus: 403 });
  }
  const u = (await client.query(`select is_active, status from users where id = $1 for share`, [user_id])).rows[0];
  if (!u || u.is_active !== true || u.status !== "active") {
    throw refuse("actor_disabled", "Your account is no longer active.", { httpStatus: 403 });
  }
  return a.id;
}

/*  Command receipts. Looked up after authority, before any decision
 *  check; written inside the command's transaction.  */
async function findCommand(client, { property_id, command_type, idempotency_key }) {
  if (!idempotency_key) return null;
  return (await client.query(
    `select id, payload_hash, input, result, recorded_at from inventory_correction_commands
      where property_id = $1 and command_type = $2 and idempotency_key = $3`, [property_id, command_type, idempotency_key])).rows[0] || null;
}
async function recordCommand(client, { property_id, command_type, idempotency_key, payload_hash, input, result, actor_user_id, assignment_id }) {
  if (!idempotency_key) return null;
  return (await client.query(
    `insert into inventory_correction_commands (property_id, command_type, idempotency_key, payload_hash, input, result, actor_user_id, assignment_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, recorded_at`,
    [property_id, command_type, idempotency_key, payload_hash, JSON.stringify(input), JSON.stringify(result), actor_user_id, assignment_id])).rows[0];
}
async function currentStateOf(q, unit_ids) {
  const rows = (await q.query(
    `select u.id as unit_id, u.unit_number, ir.id is not null as retired from units u
       left join inventory_retirements ir on ir.unit_id = u.id and ir.reversed_at is null
      where u.id = any($1::uuid[]) order by u.unit_number`, [unit_ids])).rows;
  return { as_of: new Date().toISOString(), units: rows.map((r) => ({ unit_id: r.unit_id, unit_number: r.unit_number, state: r.retired ? "retired" : "current" })) };
}
function replay(row, current_state) {
  return { ...row.result, idempotent: true, replayed_from: row.recorded_at, command_id: row.id, current_state };
}
const isDuplicateKey = (e) => e && e.code === "23505" && /uq_inventory_correction_commands_key/.test(e.constraint || e.message || "");

/*  applyRetirement — one decision over one or more reviewed units. All or
 *  nothing: any refused unit refuses the whole submission before a row
 *  is written.  */
async function applyRetirement(pool, {
  property_id, actor, unit_ids = [], review_tokens = {}, rationale,
  reason_code = REASON_SUPERSEDED_GRAIN, superseded_by_import_batch_id = null,
  confirmed = false, idempotency_key = null,
} = {}) {
  if (!actor || !actor.user_id) throw refuse("actor_required", "A signed-in person is required.", { httpStatus: 401 });
  const ids = [...new Set((unit_ids || []).map(String).filter(Boolean))].sort();
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
  const key = idempotency_key ? String(idempotency_key).slice(0, 200) : null;
  const input = { unit_ids: ids, review_tokens: Object.fromEntries(ids.map((id) => [id, String(review_tokens[id])])), rationale: rationale == null ? null : String(rationale), reason_code, superseded_by_import_batch_id: superseded_by_import_batch_id || null };
  const payload_hash = sha(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    //  1–2. Locks: the units, then their spaces (KEY SHARE exclusion — a
    //  lease, application, offer or possession event references a SPACE,
    //  and its insert takes KEY SHARE on that row).
    const locked = (await client.query(
      `select id, property_id from units where id = any($1::uuid[]) order by id for update`, [ids])).rows;
    const found = new Set(locked.map((u) => String(u.id)));
    const missing = ids.filter((i) => !found.has(i));
    if (missing.length) throw refuse("UNIT_NOT_FOUND", `No such unit(s): ${missing.join(", ")}.`, { httpStatus: 404, missing });
    const foreign = locked.filter((u) => String(u.property_id) !== String(property_id));
    if (foreign.length) throw refuse("not_permitted", "This action is not permitted.", { httpStatus: 403 });
    await client.query(`select id from spaces where unit_id = any($1::uuid[]) order by id for update`, [ids]);
    //  3–4. Authority, AFTER the inventory locks.
    const assignmentId = await assertLiveAuthority(client, { property_id, user_id: actor.user_id });
    //  Retry identity, BEFORE any decision check.
    const prior = await findCommand(client, { property_id, command_type: "retire", idempotency_key: key });
    if (prior) {
      if (prior.payload_hash !== payload_hash) {
        throw refuse("command_payload_conflict", "That idempotency key was already used for a different retirement command. Nothing was written.", { httpStatus: 409, recorded_at: prior.recorded_at });
      }
      const state = await currentStateOf(client, ids);
      await client.query("rollback");
      return replay(prior, state);
    }
    if (superseded_by_import_batch_id) {
      const b = (await client.query(`select property_id from import_batches where id = $1`, [superseded_by_import_batch_id])).rows[0];
      if (!b || String(b.property_id) !== String(property_id)) {
        throw refuse("superseding_batch_not_at_property", "The cited superseding source is not this property's.", { httpStatus: 409 });
      }
    }
    const refused = [];
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
      [property_id, `retired as obsolete representation by user ${actor.user_id} (assignment ${assignmentId}${key ? ", key " + key : ""})`, ids]);
    const result = { ...out, assignment_id: assignmentId, idempotency_key: key, command_identity: key ? "recorded" : "none" };
    const receipt = await recordCommand(client, { property_id, command_type: "retire", idempotency_key: key, payload_hash, input, result, actor_user_id: actor.user_id, assignment_id: assignmentId });
    await client.query("commit");
    return { ...result, command_id: receipt ? receipt.id : null };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    if (isDuplicateKey(e)) {
      //  A concurrent duplicate with the same key committed first. One
      //  decision stands; this one replays it or names the conflict.
      const prior = await findCommand(pool, { property_id, command_type: "retire", idempotency_key: key });
      if (prior && prior.payload_hash === payload_hash) return replay(prior, await currentStateOf(pool, ids));
      throw refuse("command_payload_conflict", "That idempotency key was already used for a different retirement command. Nothing was written.", { httpStatus: 409 });
    }
    throw e;
  } finally { client.release(); }
}

/*  applyReinstatement — reverse one live retirement, as history. An
 *  identity decision: the established record must settle that no current
 *  record covers this position, or an authorized person must say so.  */
async function applyReinstatement(pool, {
  property_id, actor, unit_id, review_token, reason, confirmed = false,
  idempotency_key = null, identity_decision = null, identity_reason = null,
} = {}) {
  if (!actor || !actor.user_id) throw refuse("actor_required", "A signed-in person is required.", { httpStatus: 401 });
  if (!unit_id) throw refuse("unit_id_required", "A unit id is required.", { httpStatus: 400 });
  if (confirmed !== true) throw refuse("confirmation_required", "Confirm the reinstatement explicitly.", { httpStatus: 400 });
  if (!review_token) throw refuse("review_required", "Review the unit first; its review token is missing.", { httpStatus: 400 });
  if (identity_decision != null && !IDENTITY_DECISIONS.includes(identity_decision)) {
    throw refuse("identity_decision_unknown", `'${identity_decision}' is not an identity decision. Known: ${IDENTITY_DECISIONS.join(", ")}.`, { httpStatus: 400 });
  }
  const key = idempotency_key ? String(idempotency_key).slice(0, 200) : null;
  const input = { unit_id: String(unit_id), review_token: String(review_token), reason: reason == null ? null : String(reason), identity_decision: identity_decision || null, identity_reason: identity_reason == null ? null : String(identity_reason) };
  const payload_hash = sha(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const u = (await client.query(`select id, property_id from units where id = $1 for update`, [unit_id])).rows[0];
    if (!u) throw refuse("UNIT_NOT_FOUND", "No such unit.", { httpStatus: 404 });
    if (String(u.property_id) !== String(property_id)) throw refuse("not_permitted", "This action is not permitted.", { httpStatus: 403 });
    await client.query(`select id from spaces where unit_id = $1 order by id for update`, [unit_id]);
    const assignmentId = await assertLiveAuthority(client, { property_id, user_id: actor.user_id });
    const prior = await findCommand(client, { property_id, command_type: "reinstate", idempotency_key: key });
    if (prior) {
      if (prior.payload_hash !== payload_hash) {
        throw refuse("command_payload_conflict", "That idempotency key was already used for a different reinstatement command. Nothing was written.", { httpStatus: 409, recorded_at: prior.recorded_at });
      }
      const state = await currentStateOf(client, [unit_id]);
      await client.query("rollback");
      return replay(prior, state);
    }
    const facts = await loadUnitFacts(client, { property_id, unit_id });
    if (String(review_token) !== reviewToken(facts)) {
      throw refuse("stale_review", "The record changed after it was reviewed. Review it again before deciding.", { httpStatus: 409 });
    }
    if (!facts.live_retirement) throw refuse("NOT_RETIRED", "That unit has no live retirement to reverse.", { httpStatus: 409 });
    //  IDENTITY, REVALIDATED INSIDE THE TRANSACTION (the token already
    //  binds it; this names the refusal in words).
    const identity = facts.identity;
    if (identity.reinstatement === "covered") {
      throw refuse("identity_covered", `A current record covers the position ${facts.unit.unit_number} represented. Reinstating it would double-count that position; correct the covering record first.`, { httpStatus: 409, covering_records: identity.covering_records });
    }
    let decision = identity_decision || IDENTITY_SETTLED;
    if (identity.reinstatement === "unresolved") {
      if (decision !== IDENTITY_NOT_COVERED || !identity_reason || String(identity_reason).trim().length < 20) {
        throw refuse("identity_unresolved", `The retirement of ${facts.unit.unit_number} cited a superseding source that does not name it, and the established record does not settle whether the corrected inventory covers this position. Reinstate only with the explicit correction '${IDENTITY_NOT_COVERED}' and a reason.`, { httpStatus: 409, identity, settles_by: identity.settles_by });
      }
    } else if (decision === IDENTITY_NOT_COVERED && (!identity_reason || String(identity_reason).trim().length < 20)) {
      throw refuse("identity_reason_required", "An explicit identity correction must say why (at least 20 characters).", { httpStatus: 400 });
    }
    const out = await reinstateInventoryUnit(client, { unit_id, actor: { user_id: actor.user_id }, reason });
    await client.query(
      `insert into events (property_id, unit_id, type, note) values ($1, $2, 'inventory_reinstated_by_decision', $3)`,
      [property_id, unit_id, `reinstated to current inventory by user ${actor.user_id} (assignment ${assignmentId}; identity ${identity.reinstatement} → ${decision}${identity_reason ? ": " + String(identity_reason).trim().slice(0, 240) : ""}${key ? "; key " + key : ""})`]);
    const result = { ...out, unit_id, assignment_id: assignmentId, idempotency_key: key, command_identity: key ? "recorded" : "none",
      identity: { read: identity.reinstatement, decision, reason: identity_reason ? String(identity_reason).trim() : null, covering_records: identity.covering_records },
      //  Reinstating does not manufacture a basis: the position reads again,
      //  with whatever basis it had. Said here so the receipt cannot imply more.
      restores: "current inventory participation only — no opening position, use, availability or readiness is established by this act",
      tenancy_attached_while_retired: facts.relationships.unit_carries_leases || 0,
      operative_work_attached_while_retired: blockersFrom(facts).filter((b) => b.code !== "claimed_by_current_representation") };
    const receipt = await recordCommand(client, { property_id, command_type: "reinstate", idempotency_key: key, payload_hash, input, result, actor_user_id: actor.user_id, assignment_id: assignmentId });
    await client.query("commit");
    return { ...result, command_id: receipt ? receipt.id : null };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    if (isDuplicateKey(e)) {
      const prior = await findCommand(pool, { property_id, command_type: "reinstate", idempotency_key: key });
      if (prior && prior.payload_hash === payload_hash) return replay(prior, await currentStateOf(pool, [unit_id]));
      throw refuse("command_payload_conflict", "That idempotency key was already used for a different reinstatement command. Nothing was written.", { httpStatus: 409 });
    }
    throw e;
  } finally { client.release(); }
}

async function history(pool, { property_id, limit, offset } = {}) {
  const lim = clampInt(limit, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX) || HISTORY_LIMIT_DEFAULT;
  const off = clampInt(offset, 0, 1e9);
  const prov = await retirementProvenance(pool, { property_id });
  const explanation = await correctionStanding(pool, { property_id });
  return { ...prov, rows: prov.rows.slice(off, off + lim), page: { limit: lim, offset: off, returned: Math.min(lim, Math.max(0, prov.rows.length - off)), total: prov.rows.length }, explanation };
}

module.exports = {
  reviewUnit, listUnits, applyRetirement, applyReinstatement, history, correctionStanding,
  loadUnitFacts, assess, reviewToken, canonical,
  IDENTITY_DECISIONS, IDENTITY_SETTLED, IDENTITY_NOT_COVERED, EXPLANATION_LIMIT,
};
