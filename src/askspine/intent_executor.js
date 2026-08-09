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
    const cap = contract.result_cap;

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
    return {
      lane_a: { total: totalOf(laneA), rows: laneA.rows },
      lane_b: { total: totalOf(laneB), rows: laneB.rows },
    };
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
      source_outcomes: [],
      supporting_records: [],
      totals: null,
      contract: null,
    };
  }

  const base = {
    intent_slug,
    contract: {
      version: contract.version,
      digest: contract.digest,
      candidate_predicate_version: contract.candidate_predicate.version,
      result_cap: contract.result_cap,
    },
  };

  //  MODULE ENTITLEMENT. Property-wide denial may be visible; it is not
  //  an error and it is not an empty answer. It is unauthorized.
  const modules = Array.isArray(allowed_modules) ? allowed_modules.filter(Boolean) : [];
  const needed = contract.scope.module_entitlement_required;
  if (needed && !modules.includes(needed)) {
    return {
      ...base,
      coverage_state: COVERAGE_STATES.UNAVAILABLE,
      conclusion_code: "unauthorized_module",
      source_outcomes: [{ id: "module_entitlement", status: READ_STATUS.UNAUTHORIZED,
                          detail: `operator has no ${needed} entitlement for this property` }],
      supporting_records: [],
      totals: null,
      evidence: { evidence_as_of: null, basis: "not_read" },
    };
  }

  const source_outcomes = [];

  //  ── ANSWERABILITY FIRST ──────────────────────────────────────────
  //  Before any population read. See the header: the invariant view is
  //  empty before activation by construction, so reading it first would
  //  manufacture a confident zero.
  let authority;
  try {
    authority = await proofState.activationAuthority(db);
  } catch (e) {
    source_outcomes.push({ id: "release_0_activation_authority",
                           status: READ_STATUS.FAILED, detail: "authority read failed" });
    return { ...base, coverage_state: COVERAGE_STATES.UNAVAILABLE,
             conclusion_code: "unavailable_source_cannot_answer",
             source_outcomes, supporting_records: [], totals: null,
             evidence: { evidence_as_of: null, basis: "not_read" } };
  }
  if (!authority.available) {
    source_outcomes.push({ id: "release_0_activation_authority",
                           status: READ_STATUS.FAILED, detail: authority.reason_code });
    return { ...base, coverage_state: COVERAGE_STATES.UNAVAILABLE,
             conclusion_code: "unavailable_source_cannot_answer",
             source_outcomes, supporting_records: [], totals: null,
             evidence: { evidence_as_of: null, basis: "not_read" } };
  }
  source_outcomes.push({ id: "release_0_activation_authority",
                         status: READ_STATUS.ANSWERED, detail: authority.activation.id });

  //  ── THE POPULATION ───────────────────────────────────────────────
  let population;
  try {
    population = await POPULATION_READERS[intent_slug](db, { contract, property_id });
  } catch (e) {
    //  A failed read is a failure. It must never arrive shaped like an
    //  empty result — the whole point of separating unavailable from
    //  valid_empty.
    source_outcomes.push({ id: "release_0_invariant_audit", status: READ_STATUS.FAILED,
                           detail: `population read failed: ${e && e.message}` });
    return { ...base, coverage_state: COVERAGE_STATES.UNAVAILABLE,
             conclusion_code: "unavailable_source_cannot_answer",
             source_outcomes, supporting_records: [], totals: null,
             evidence: { evidence_as_of: null, basis: "not_read" } };
  }
  source_outcomes.push({ id: "release_0_invariant_audit", status: READ_STATUS.ANSWERED,
                         detail: `lane_a=${population.lane_a.total} lane_b=${population.lane_b.total}` });

  //  ── PER-RECORD CANONICAL VERDICTS ────────────────────────────────
  //  The authority is resolved once and passed in, so a page of twenty
  //  rows cannot see it change mid-list and render two verdicts on one
  //  screen.
  const cap = contract.result_cap;
  const supporting_records = [];
  const shape = async (row, lane) => {
    const wo = (await db.query(
      `select id, property_id, status, completion_photo, completion_note
         from public.work_orders where id = $1 and property_id = $2`,
      [row.work_order_id, property_id])).rows[0];
    if (!wo) return null;
    const s = await proofState.deriveProofState(db, { workOrder: wo, authority });
    return {
      work_order_id: row.work_order_id,
      work_order_ref: row.work_order_ref,
      unit_label: row.unit_label || null,
      status: row.status,
      //  BOTH canonical answers travel. When they disagree — a reader
      //  saying `satisfied` over a row the DB validator calls ungrounded
      //  — that disagreement IS the finding, and hiding it because
      //  migration 140 "should" prevent it is exactly what ruling 9
      //  forbids.
      canonical_proof_state: s.read_status === "ok" ? s.state : null,
      canonical_proof_read_status: s.read_status,
      canonical_db_proof_status: row.proof_status || null,
      violation: row.violation || null,
      lane,
    };
  };

  //  `.slice(cap)` again on purpose. The SQL already carries LIMIT, and
  //  the cap is a contract of THIS layer too — delegating the guarantee
  //  downward is how a cap quietly stops holding when a query is edited.
  for (const row of population.lane_a.rows.slice(0, cap)) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await shape(row, "current");
    if (rec) supporting_records.push(rec);
  }
  for (const row of population.lane_b.rows.slice(0, cap)) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await shape(row, "pre_cutover_history");
    if (rec) supporting_records.push(rec);
  }

  const evidence = await resolveEvidenceAsOf(db, {
    property_id, workOrderIds: supporting_records.map((r) => r.work_order_id) });

  //  ── COVERAGE IS COMPUTED, NEVER CHOSEN ───────────────────────────
  const failed = source_outcomes.filter((o) => o.status === READ_STATUS.FAILED);
  const answered = source_outcomes.filter((o) => o.status === READ_STATUS.ANSWERED);
  let coverage_state;
  if (failed.length && answered.length) coverage_state = COVERAGE_STATES.PARTIAL;
  else if (failed.length) coverage_state = COVERAGE_STATES.UNAVAILABLE;
  else if (population.lane_a.total === 0 && population.lane_b.total === 0) {
    coverage_state = COVERAGE_STATES.VALID_EMPTY;
  } else coverage_state = COVERAGE_STATES.DECISIVE;

  //  The conclusion CODE. The English sentence is the renderer's job and
  //  is derived from this code plus the counts — never the other way
  //  round, and never authored by a model.
  const a = population.lane_a.total, b = population.lane_b.total;
  const conclusion_code =
    a === 0 && b === 0 ? "current_none_legacy_none"
      : a === 0 ? "current_none_legacy_present"
        : b === 0 ? "current_present_legacy_none"
          : "current_present_legacy_present";

  return {
    ...base,
    coverage_state,
    conclusion_code,
    source_outcomes,
    supporting_records,
    totals: {
      lane_a_total: a,
      lane_b_total: b,
      //  Selected PER LANE. The cap is per lane on purpose (see the
      //  renderer): a large pre-cutover history must not crowd current
      //  integrity failures off the page, and a single combined count
      //  would mix two populations this intent exists to keep apart.
      lane_a_selected: supporting_records.filter((r) => r.lane === "current").length,
      lane_b_selected: supporting_records.filter((r) => r.lane === "pre_cutover_history").length,
      total_matching: a + b,
      selected_count: supporting_records.length,
      result_cap: cap,
    },
    evidence,
  };
}

module.exports = {
  execute, loadContract, listContracts,
  COVERAGE_STATES, READ_STATUS, CONTRACT_DIR,
};
