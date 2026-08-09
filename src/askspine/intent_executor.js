// ════════════════════════════════════════════════════════════════════
//  intent_executor.js — BUILD 1, THE GOVERNED INTENT EXECUTOR
//
//  Given an immutable intent contract and a server-derived property
//  scope, inspect canonical truth and produce a bounded, auditable
//  conclusion. No LLM decides the operating answer. No conversation, no
//  cards, no actions.
//
//  ── IT CONSUMES CANONICAL TRUTH; IT DOES NOT RE-DERIVE IT ──────────
//
//  The one architectural rule of this file: there is no proof predicate
//  in it. Not a classification, not an "if attachment stored and
//  classification in (…)", not a recomputation of what `satisfied`
//  means. Lane membership comes from `release_0_completion_invariant_
//  violations` — the canonical view, which derives from the same SQL
//  function the deferred guard and the activation use. Per-record
//  verdicts come from `proof_state.deriveProofState`. If this file ever
//  grows a rule about what makes evidence valid, the architecture is
//  wrong.
//
//  ── ANSWERABILITY IS CHECKED BEFORE THE POPULATION ─────────────────
//
//  The invariant view is empty before the activation BY CONSTRUCTION —
//  its own predicate requires a stamped epoch. Reading it first and
//  counting zero would produce the exact false-empty this architecture
//  exists to prevent: "no completions lack proof" when the truth is "I
//  cannot tell you." So the activation authority is resolved FIRST, and
//  an unavailable source short-circuits before any population read.
//
//  ── GENERIC MEANS CONTRACT-DRIVEN, NOT PLUGGABLE ───────────────────
//
//  This executor contains no `if (intent === …)` business truth. It also
//  does not model hypothetical money or compliance domains. Genericity
//  is proven by the second and third intents, not predicted by the
//  first — so the abstraction here is the minimum this intent requires.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const proofState = require("../release0/proof_state");

const CONTRACT_DIR = path.join(__dirname, "contracts");

/*  The five COMPLETED-answer outcomes. `clarification_required` is not
 *  here on purpose: it is a pre-answer interpretation state, and this
 *  module only ever returns a completed execution. */
const COVERAGE_STATES = Object.freeze({
  DECISIVE: "decisive",
  VALID_EMPTY: "valid_empty",
  PARTIAL: "partial",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
});

/*  Per-source read outcomes. `coverage_state` is COMPUTED from these and
 *  is never chosen by a caller or a renderer. */
const READ_STATUS = Object.freeze({
  ANSWERED: "answered",
  FAILED: "failed",
  UNAUTHORIZED: "unauthorized",
  NOT_APPLICABLE: "not_applicable",
});

/*  Contracts are read from disk and digested at load. The digest is the
 *  file's bytes — a contract that carried its own digest could not be
 *  verified against itself. Cached because a digest that changes between
 *  two calls in one process would mean the file moved underneath a
 *  running answer. */
const cache = new Map();

function loadContract(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const file = path.join(CONTRACT_DIR, `${slug}.json`);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    //  An unknown slug is UNSUPPORTED, not a crash: a question outside
    //  the contract set cannot be answered by improvising from nearby
    //  data, and saying so is the answer.
    return null;
  }
  const contract = JSON.parse(bytes.toString("utf8"));
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const loaded = Object.freeze({ ...contract, digest });
  cache.set(slug, loaded);
  return loaded;
}

const listContracts = () =>
  fs.readdirSync(CONTRACT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

/*  ── THE ONE INTENT THIS BUILD SHIPS ───────────────────────────────
 *
 *  Registered by slug rather than branched on inside the executor: the
 *  executor's job is contract mechanics (answerability, caps, coverage,
 *  receipts), and the population read belongs to the intent. A second
 *  intent adds an entry here and changes nothing above or below it. */
const POPULATION_READERS = Object.create(null);

POPULATION_READERS["maintenance.completion_without_valid_proof"] =
  async function readPopulation(db, { contract, property_id }) {
    const cap = contract.result_cap_per_lane;

    /*  LANE A — current governed completion integrity.
     *
     *  The canonical invariant view, plus a property filter. Nothing
     *  else. `total_matching` is a COUNT over the complete predicate —
     *  never over the capped page — so "20 of 147" is true rather than
     *  a guess, and the cap is applied in SQL, not by the renderer.
     *
     *  Ordering is deterministic so the same question twice returns the
     *  same page: an unstable order would make two receipts disagree
     *  about a population that never changed. */
    const laneA = await db.query(
      `with matching as (
         select v.work_order_id, v.property_id, v.status, v.proof_status, v.violation,
                w.work_order_ref, u.unit_number as unit_label
           from public.release_0_completion_invariant_violations v
           join public.work_orders w
             on w.id = v.work_order_id and w.property_id = v.property_id
           left join public.units u on u.id = w.unit_id
          where v.property_id = $1
       )
       select (select count(*) from matching)::int as total_matching, m.*
         from matching m
        order by m.status asc, m.work_order_ref asc, m.work_order_id asc
        limit $2`,
      [property_id, cap]);

    /*  LANE B — pre-cutover unverified history.
     *
     *  The cutover inventory is the canonical record of what predates
     *  the activation. This lane is counted and reported SEPARATELY and
     *  must never be added to lane A: folding fourteen unverified
     *  historical completions into "14 work orders failed proof" would
     *  rewrite history and invent a failure that nobody committed. */
    const laneB = await db.query(
      `with matching as (
         select i.work_order_id, i.property_id, w.status,
                w.work_order_ref, u.unit_number as unit_label
           from public.release_0_legacy_cutover_inventory i
           join public.work_orders w
             on w.id = i.work_order_id and w.property_id = i.property_id
           left join public.units u on u.id = w.unit_id
          where i.property_id = $1
       )
       select (select count(*) from matching)::int as total_matching, m.*
         from matching m
        order by m.status asc, m.work_order_ref asc, m.work_order_id asc
        limit $2`,
      [property_id, cap]);

    const totalOf = (r) => (r.rows.length ? Number(r.rows[0].total_matching) : 0);
    //  Keyed by the contract's OWN lane names. `lane_a`/`lane_b` forced
    //  the executor to know which lane was which; a contract that names
    //  its lanes can be iterated by any executor that never heard of it.
    return {
      current: { total: totalOf(laneA), rows: laneA.rows },
      pre_cutover_history: { total: totalOf(laneB), rows: laneB.rows },
    };
  };

/*  ── INTENT 2 · maintenance.ownership_and_acceptance ───────────────
 *
 *  A DIFFERENT RAIL. Nothing here touches Release 0: no activation, no
 *  proof state, no invariant view. That is the point — if this intent
 *  could not be decisive while Capability 1 says `unavailable`, the
 *  executor's answerability machinery would be Release-0-shaped rather
 *  than contract-driven.
 *
 *  THE GOVERNING OBJECT IS THE OBLIGATION. `work_orders.assigned_to` is
 *  free text with no governed writer and is never read. A work order may
 *  carry MANY obligations with different assignees and different
 *  acceptance states, so there is no such thing as the work order's
 *  owner; grouping under a work order is presentation, never aggregation.
 */
POPULATION_READERS["maintenance.ownership_and_acceptance"] =
  async function readOwnership(db, { contract, property_id }) {
    const cap = contract.result_cap_per_lane;
    const LANE = contract.lanes[0];

    /*  The ownership state is derived in SQL from durable fields only —
     *  never from activity, age, notes or judgement. The impossible
     *  fourth combination cannot appear: ck_oblig_accepter_is_owner and
     *  ck_oblig_acceptance_has_owner refuse it at write time. */
    const OWNERSHIP_SQL = `
      case
        when o.assigned_user_id is null then 'unassigned'
        when o.accepted_by_user_id is null then 'assigned_not_accepted'
        else 'assigned_accepted'
      end`;

    const WHERE = `o.property_id = $1
                   and o.related_type = 'work_order'
                   and o.module = 'maintenance'
                   and o.status in ('open','in_progress')`;

    const page = await db.query(
      `with matching as (
         select o.id as obligation_id, o.type as obligation_type, o.status as obligation_status,
                o.assigned_user_id, o.accepted_by_user_id, o.accepted_at, o.updated_at,
                o.related_id as work_order_id, ${OWNERSHIP_SQL} as ownership_state,
                w.work_order_ref, u.unit_number as unit_label
           from public.obligations o
           join public.work_orders w
             on w.id = o.related_id and w.property_id = o.property_id
           left join public.units u on u.id = w.unit_id
          where ${WHERE}
       )
       select (select count(*) from matching)::int as total_matching, m.*
         from matching m
        order by m.work_order_ref asc, m.obligation_type asc, m.obligation_id asc
        limit $2`,
      [property_id, cap]);

    /*  FACETS COME FROM THE FULL POPULATION, not the capped page. "8
     *  unassigned, 14 assigned but not accepted, 51 accepted" is a claim
     *  about all 73 or it is a lie. */
    const facet = await db.query(
      `select ${OWNERSHIP_SQL} as ownership_state, count(*)::int as n
         from public.obligations o
        where ${WHERE}
        group by 1`, [property_id]);

    const counts = { unassigned: 0, assigned_not_accepted: 0, assigned_accepted: 0 };
    for (const r of facet.rows) counts[r.ownership_state] = Number(r.n);

    return {
      [LANE]: {
        total: page.rows.length ? Number(page.rows[0].total_matching) : 0,
        rows: page.rows,
        facets: { ownership_state: counts },
      },
    };
  };

/*  ── PRECHECKS ARE KEYED BY SOURCE ID, NOT BY INTENT ───────────────
 *
 *  This is the seam the second intent proved was needed. Answerability
 *  used to BE `proofState.activationAuthority` — hard-coded, so every
 *  intent inherited Release 0's cutover whether or not it read Release 0
 *  data. A contract now declares which sources it requires, and a source
 *  brings its own precheck if it has one. `maintenance.ownership_and_
 *  acceptance` declares no Release 0 source and therefore has no
 *  activation gate: it can be DECISIVE in the same database where
 *  Capability 1 is honestly UNAVAILABLE.
 *
 *  Source ids are shared vocabulary across intents. Intent slugs are not
 *  mentioned here, and must never be. */
const PRECHECKS = Object.create(null);

PRECHECKS["release_0_activation_authority"] = async function checkActivation(db) {
  //  The invariant view is empty before activation BY CONSTRUCTION, so a
  //  reader that looked at the population first would count zero and call
  //  it an answer.
  const authority = await proofState.activationAuthority(db);
  if (!authority.available) {
    return { status: READ_STATUS.FAILED, detail: authority.reason_code, context: null };
  }
  return { status: READ_STATUS.ANSWERED, detail: authority.activation.id, context: authority };
};

/*  Per-intent adapters. Dispatch tables, not business branches: the
 *  executor never asks WHICH intent it is running, only what the contract
 *  registered. */
const RECORD_SHAPERS = Object.create(null);
const CONCLUSION_MAPPERS = Object.create(null);
const EVIDENCE_READERS = Object.create(null);
const OPTIONAL_READERS = Object.create(null);


/*  ── ADAPTERS · maintenance.completion_without_valid_proof ─────────── */
RECORD_SHAPERS["maintenance.completion_without_valid_proof"] = async function shapeWorkOrder(db, row, { lane, property_id, context }) {
  const authority = context["release_0_activation_authority"];
  const wo = (await db.query(
    `select id, property_id, status, completion_photo, completion_note
       from public.work_orders where id = $1 and property_id = $2`,
    [row.work_order_id, property_id])).rows[0];
  if (!wo) return null;
  const st = await proofState.deriveProofState(db, { workOrder: wo, authority });
  return {
    record_type: "work_order",
    work_order_id: row.work_order_id,
    work_order_ref: row.work_order_ref,
    unit_label: row.unit_label || null,
    status: row.status,
    //  BOTH canonical answers travel. A disagreement between them IS the
    //  finding; hiding it because migration 140 "should" prevent it is
    //  exactly what ruling 9 forbids.
    canonical_proof_state: st.read_status === "ok" ? st.state : null,
    canonical_proof_read_status: st.read_status,
    canonical_db_proof_status: row.proof_status || null,
    violation: row.violation || null,
    lane,
  };
};

CONCLUSION_MAPPERS["maintenance.completion_without_valid_proof"] = ({ lanes }) => {
  const a = lanes.current.total, b = lanes.pre_cutover_history.total;
  return a === 0 && b === 0 ? "current_none_legacy_none"
    : a === 0 ? "current_none_legacy_present"
      : b === 0 ? "current_present_legacy_none"
        : "current_present_legacy_present";
};

EVIDENCE_READERS["maintenance.completion_without_valid_proof"] = async function evidenceForWorkOrders(db, { property_id, records }) {
  const ids = records.map((r) => r.work_order_id).filter(Boolean);
  if (!ids.length) return { evidence_as_of: null, basis: "no_supporting_records" };
  const ev = await db.query(
    `select max(evaluated_at) t from public.work_order_proof_evaluations
      where property_id = $1 and work_order_id = any($2::uuid[])`, [property_id, ids]);
  if (ev.rows[0] && ev.rows[0].t) {
    return { evidence_as_of: ev.rows[0].t, basis: "latest_proof_evaluation" };
  }
  const pr = await db.query(
    `select max(occurred_at) t from public.work_order_progress
      where property_id = $1 and work_order_id = any($2::uuid[])`, [property_id, ids]);
  if (pr.rows[0] && pr.rows[0].t) {
    return { evidence_as_of: pr.rows[0].t, basis: "latest_progress_event" };
  }
  //  Honest absence. A terminal work order with no evaluation and no
  //  progress row is precisely the defect shape; claiming an observation
  //  time for it would be a fabricated fact.
  return { evidence_as_of: null, basis: "no_evidence_timestamp" };
};

/*  ── ADAPTERS · maintenance.ownership_and_acceptance ───────────────── */

/*  The assignee's CURRENT standing on this property's team. Genuinely
 *  separable from the assignment: a person can be deactivated while
 *  obligations still name them. A missing standing NEVER becomes
 *  UNASSIGNED — that would corrupt the operating fact. */
OPTIONAL_READERS["assignee_team_standing"] =
  async function readStanding(db, { property_id, records }) {
    const ids = [...new Set(records.map((r) => r.assigned_user_id).filter(Boolean))];
    if (!ids.length) return { status: READ_STATUS.NOT_APPLICABLE, detail: "no assignees", data: {} };
    const r = await db.query(
      `select a.user_id, a.role_title, u.name
         from public.property_team_assignments a
         join public.users u on u.id = a.user_id
        where a.property_id = $1 and a.user_id = any($2::uuid[]) and a.active = true`,
      [property_id, ids]);
    const by = {};
    for (const row of r.rows) by[row.user_id] = { name: row.name, role_title: row.role_title };
    return { status: READ_STATUS.ANSWERED, detail: `${r.rows.length}/${ids.length} resolved`, data: by };
  };

RECORD_SHAPERS["maintenance.ownership_and_acceptance"] = async function shapeObligation(db, row, { lane, optional }) {
  const standing = (optional["assignee_team_standing"] || {})[row.assigned_user_id] || null;
  return {
    record_type: "obligation",
    obligation_id: row.obligation_id,
    obligation_type: row.obligation_type,
    obligation_status: row.obligation_status,
    ownership_state: row.ownership_state,
    assigned_user_id: row.assigned_user_id,
    //  Present only when the optional source resolved it. Absent is
    //  ABSENT — never a placeholder, never a downgrade of the assignment.
    assignee_display: standing ? standing.name : null,
    assignee_team_standing: standing ? standing.role_title : null,
    accepted_at: row.accepted_at,
    work_order_id: row.work_order_id,
    work_order_ref: row.work_order_ref,
    unit_label: row.unit_label || null,
    lane,
  };
};

CONCLUSION_MAPPERS["maintenance.ownership_and_acceptance"] = ({ lanes, contract }) => {
  const lane = lanes[contract.lanes[0]];
  const f = (lane.facets && lane.facets.ownership_state) || {};
  if (lane.total === 0) return "ownership_none_current";
  const unowned = (f.unassigned || 0) + (f.assigned_not_accepted || 0);
  return unowned === 0 ? "ownership_all_accepted" : "ownership_mixed";
};

EVIDENCE_READERS["maintenance.ownership_and_acceptance"] = async function evidenceForObligations(db, { records }) {
  const times = records
    .flatMap((r) => [r.accepted_at])
    .filter(Boolean)
    .map((t) => new Date(t).getTime());
  if (times.length) {
    return { evidence_as_of: new Date(Math.max(...times)), basis: "latest_acceptance" };
  }
  //  No acceptance anywhere in the page. There is no governed
  //  reassignment history to fall back on, so this is honestly absent
  //  rather than approximated with an update timestamp that means
  //  "a column changed", not "the world was observed".
  return { evidence_as_of: null, basis: "no_evidence_timestamp" };
};

/*  Evidence time, per the contract's basis order. Read time is not fact
 *  time, and a missing evidence timestamp is reported as missing rather
 *  than replaced with now(). */
async function resolveEvidenceAsOf(db, { property_id, workOrderIds }) {
  if (!workOrderIds.length) {
    return { evidence_as_of: null, basis: "no_supporting_records" };
  }
  const ev = await db.query(
    `select max(evaluated_at) t from public.work_order_proof_evaluations
      where property_id = $1 and work_order_id = any($2::uuid[])`,
    [property_id, workOrderIds]);
  if (ev.rows[0] && ev.rows[0].t) {
    return { evidence_as_of: ev.rows[0].t, basis: "latest_proof_evaluation" };
  }
  const pr = await db.query(
    `select max(occurred_at) t from public.work_order_progress
      where property_id = $1 and work_order_id = any($2::uuid[])`,
    [property_id, workOrderIds]);
  if (pr.rows[0] && pr.rows[0].t) {
    return { evidence_as_of: pr.rows[0].t, basis: "latest_progress_event" };
  }
  //  Honest absence. A work order can be terminal with no evaluation and
  //  no progress row — that is precisely the missing_evaluation_defect
  //  shape — and claiming an observation time for it would be a
  //  fabricated fact.
  return { evidence_as_of: null, basis: "no_evidence_timestamp" };
}

/**
 * Execute a resolved intent.
 *
 * @param db          a pg client or pool
 * @param intent_slug the RESOLVED intent. This function does not interpret
 *                    natural language and never guesses a slug.
 * @param property_id server-derived. There is no other source for it.
 * @param allowed_modules  server-derived module entitlement.
 */
async function execute(db, { intent_slug, property_id, allowed_modules }) {
  if (!property_id) {
    throw new Error("intent_executor.execute requires a server-derived property_id");
  }

  const contract = loadContract(intent_slug);
  if (!contract || !POPULATION_READERS[intent_slug]) {
    //  Outside the contract set. Improvising from nearby data is exactly
    //  what this state exists to refuse.
    return {
      intent_slug,
      coverage_state: COVERAGE_STATES.UNSUPPORTED,
      conclusion_code: "unsupported_question",
      source_outcomes: [], supporting_records: [], totals: null, contract: null,
    };
  }

  const base = {
    intent_slug,
    contract: {
      version: contract.version,
      digest: contract.digest,
      candidate_predicate_version: contract.candidate_predicate.version,
      result_cap_per_lane: contract.result_cap_per_lane,
    },
  };
  const bail = (source_outcomes, code = "unavailable_source_cannot_answer") => ({
    ...base, coverage_state: COVERAGE_STATES.UNAVAILABLE, conclusion_code: code,
    source_outcomes, supporting_records: [], totals: null,
    evidence: { evidence_as_of: null, basis: "not_read" },
  });

  //  MODULE ENTITLEMENT. Property-wide denial may be visible; it is not an
  //  error and it is not an empty answer. It is unauthorized.
  const modules = Array.isArray(allowed_modules) ? allowed_modules.filter(Boolean) : [];
  const needed = contract.scope.module_entitlement_required;
  if (needed && !modules.includes(needed)) {
    return bail([{ id: "module_entitlement", status: READ_STATUS.UNAUTHORIZED,
                   detail: `operator has no ${needed} entitlement for this property` }],
                "unauthorized_module");
  }

  const source_outcomes = [];
  const context = Object.create(null);

  //  ── 1 · ANSWERABILITY, FROM THE CONTRACT'S REQUIRED SOURCES ──────
  //  Before any population read. A source with a registered precheck gets
  //  checked; one without is answered by the population read itself. An
  //  intent that declares no prechecked source therefore carries NO
  //  inherited gate — which is how Intent 2 can be decisive in a database
  //  where Capability 1 is honestly unavailable.
  for (const src of contract.required_sources || []) {
    const check = PRECHECKS[src.id];
    if (!check) continue;
    let verdict;
    try {
      // eslint-disable-next-line no-await-in-loop
      verdict = await check(db, { property_id });
    } catch (e) {
      source_outcomes.push({ id: src.id, status: READ_STATUS.FAILED,
                             detail: `precheck failed: ${e && e.message}` });
      return bail(source_outcomes);
    }
    source_outcomes.push({ id: src.id, status: verdict.status, detail: verdict.detail });
    if (verdict.status === READ_STATUS.FAILED) return bail(source_outcomes);
    context[src.id] = verdict.context;
  }

  //  ── 2 · THE POPULATION ───────────────────────────────────────────
  const populationSourceId = (contract.required_sources || [])
    .filter((s) => !PRECHECKS[s.id]).map((s) => s.id).pop() || "population";
  let lanes;
  try {
    lanes = await POPULATION_READERS[intent_slug](db, { contract, property_id, context });
  } catch (e) {
    //  A failed read is a failure. It must never arrive shaped like an
    //  empty result — that separation is the whole architecture.
    source_outcomes.push({ id: populationSourceId, status: READ_STATUS.FAILED,
                           detail: `population read failed: ${e && e.message}` });
    return bail(source_outcomes);
  }
  const laneNames = contract.lanes;
  for (const name of laneNames) if (!lanes[name]) lanes[name] = { total: 0, rows: [] };
  source_outcomes.push({ id: populationSourceId, status: READ_STATUS.ANSWERED,
                         detail: laneNames.map((n) => `${n}=${lanes[n].total}`).join(" ") });

  //  ── 3 · OPTIONAL SOURCES ─────────────────────────────────────────
  //  Enrichment only. A failure degrades coverage to PARTIAL; it may never
  //  change an operating fact. `assignee_team_standing` failing must not
  //  turn an assigned obligation into an unassigned one.
  const cap = contract.result_cap_per_lane;
  const rawRows = laneNames.flatMap((n) => lanes[n].rows.slice(0, cap));
  const optional = Object.create(null);
  for (const src of contract.optional_sources || []) {
    const reader = OPTIONAL_READERS[src.id];
    if (!reader) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await reader(db, { property_id, records: rawRows });
      source_outcomes.push({ id: src.id, status: out.status, detail: out.detail });
      optional[src.id] = out.data || {};
    } catch (e) {
      source_outcomes.push({ id: src.id, status: READ_STATUS.FAILED,
                             detail: `optional read failed: ${e && e.message}` });
      optional[src.id] = {};
    }
  }

  //  ── 4 · SHAPE THE SELECTED RECORDS ───────────────────────────────
  //  `.slice(cap)` again on purpose: the SQL already carries LIMIT, and
  //  the cap is a contract of THIS layer too. Delegating the guarantee
  //  downward is how a cap quietly stops holding when a query is edited.
  const shape = RECORD_SHAPERS[intent_slug];
  const supporting_records = [];
  for (const name of laneNames) {
    for (const row of lanes[name].rows.slice(0, cap)) {
      // eslint-disable-next-line no-await-in-loop
      const rec = await shape(db, row, { lane: name, property_id, context, optional });
      if (rec) supporting_records.push(rec);
    }
  }

  const evidence = await EVIDENCE_READERS[intent_slug](db,
    { property_id, records: supporting_records });

  //  ── 5 · COVERAGE IS COMPUTED, NEVER CHOSEN ───────────────────────
  const failed = source_outcomes.filter((o) => o.status === READ_STATUS.FAILED);
  const answered = source_outcomes.filter((o) => o.status === READ_STATUS.ANSWERED);
  const totalMatching = laneNames.reduce((n, name) => n + lanes[name].total, 0);
  let coverage_state;
  if (failed.length && answered.length) coverage_state = COVERAGE_STATES.PARTIAL;
  else if (failed.length) coverage_state = COVERAGE_STATES.UNAVAILABLE;
  else if (totalMatching === 0) coverage_state = COVERAGE_STATES.VALID_EMPTY;
  else coverage_state = COVERAGE_STATES.DECISIVE;

  //  The conclusion CODE. The English sentence is the renderer's job, and
  //  is derived from this code plus the counts — never the other way
  //  round, and never authored by a model.
  const conclusion_code = CONCLUSION_MAPPERS[intent_slug]({ lanes, contract });

  return {
    ...base,
    coverage_state,
    conclusion_code,
    source_outcomes,
    supporting_records,
    totals: {
      result_cap_scope: contract.result_cap_scope,
      result_cap_per_lane: cap,
      lanes: laneNames.map((name) => ({
        lane: name,
        total_matching: lanes[name].total,
        selected_count: supporting_records.filter((r) => r.lane === name).length,
        result_cap: cap,
        //  Facets come from the FULL population, never the capped page.
        ...(lanes[name].facets ? { facets: lanes[name].facets } : {}),
      })),
      total_matching: totalMatching,
      selected_count: supporting_records.length,
    },
    evidence,
  };
}

module.exports = {
  execute, loadContract, listContracts,
  COVERAGE_STATES, READ_STATUS, CONTRACT_DIR,
  //  Exported so a gate can assert the executor dispatches by registry
  //  rather than by `if (intent_slug === …)`.
  PRECHECKS, POPULATION_READERS, RECORD_SHAPERS, CONCLUSION_MAPPERS,
  EVIDENCE_READERS, OPTIONAL_READERS,
};
