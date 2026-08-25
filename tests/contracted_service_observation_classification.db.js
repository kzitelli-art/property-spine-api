"use strict";

/*  ════════════════════════════════════════════════════════════════════
 *  HOW A FINANCIAL OBSERVATION IS CLASSIFIED — real-Postgres proof. CLASS 3.
 *
 *  contracted_service_projection.js used to answer a LINKAGE question with a
 *  TIMING answer: an observation was "unmatched" when its engagement was not
 *  CURRENT at as_of. An invoice for a contract that simply ended was therefore
 *  reported as an unexplained amount, and the operator was asked a question
 *  Spine had already recorded the answer to.
 *
 *  The obvious one-line repair — widen the linkage set to every known
 *  engagement — is WORSE: a non-current engagement produces no engagement
 *  view, so those observations would be neither under an engagement nor
 *  unmatched. They would DISAPPEAR. That is what the no-vanish invariant
 *  below exists to make impossible to reintroduce.
 *
 *  Three orthogonal facts, never collapsed:
 *      visibility                    IN_SCOPE | FUTURE       (period_start)
 *      linkage                       LINKED   | ORPHANED     (engagement_id)
 *      engagement_temporal_relation  CURRENT | ENDED | NOT_YET_BEGUN | null
 *
 *  ⚠ NOT CI-WIRED. tests/e2e/verify_all.sh is not this lane's to edit, so a
 *  green parent run is NOT evidence that this ran. Rung: LOCALLY_EXERCISED.
 *
 *  Everything it creates is created inside one transaction and ROLLED BACK,
 *  on success and on failure alike.
 *  ════════════════════════════════════════════════════════════════════ */

const assert = require("assert");
const { Client } = require("pg");

const runReceipt = require("./_run_receipt.js");
const positionRead = require("../src/asset/contracted_service_position_read.js");

const PREFIX = "camp-obs-classification";
const AS_OF = "2010-06-15";          // live engagement current; ended ended; future not begun
const AS_OF_LATER = "2099-06-15";    // the future-period observation becomes economic

function refuse(lines) {
  console.error("\n  ✘ REFUSED");
  for (const line of lines) console.error(`    ${line}`);
  console.error("");
  process.exit(2);
}

/*  Two independent refusals. harnessConnectionString() owns the same-target
    check against DATABASE_URL and is not reimplemented here; localOnly() adds
    the stricter rule that this proof may never reach a non-local host.      */
function localOnly(url) {
  let host = null;
  try { host = new URL(url).hostname; } catch (error) {
    refuse([`HARNESS_DATABASE_URL is not a parsable URL: ${error.message}`]);
  }
  const LOCAL = ["127.0.0.1", "localhost", "::1", "[::1]", ""];
  if (!LOCAL.includes(String(host).toLowerCase())) {
    refuse([`HARNESS_DATABASE_URL points at a NON-LOCAL host: ${host}`,
      "This proof writes real rows and may only target a disposable LOCAL Postgres."]);
  }
  /*  RECORDED, NOT FIXED HERE: _run_receipt.js sameTarget() compares hostnames
      literally, so 127.0.0.1 and localhost read as different targets. That file
      is frozen for this slice; since every host reaching here is already local,
      comparing port+database closes the alias hole for THIS harness.          */
  const other = process.env.DATABASE_URL;
  if (other) {
    try {
      const mine = new URL(url); const theirs = new URL(other);
      const port = (u) => u.port || "5432";
      const database = (u) => u.pathname.replace(/^\//, "");
      if (LOCAL.includes(String(theirs.hostname).toLowerCase())
          && port(mine) === port(theirs) && database(mine) === database(theirs)) {
        refuse(["HARNESS_DATABASE_URL and DATABASE_URL name the SAME local database",
          `  port=${port(mine)}  database=${database(mine)}`,
          "Refusing to write into the database this service reads."]);
      }
    } catch (_) { /* an unparseable DATABASE_URL is not a same-target claim */ }
  }
  return url;
}

let passed = 0; const failures = [];
function ok(label, condition, detail) {
  if (condition) { passed++; console.log(`  ok    ${label}`); return; }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  if (detail) console.log(`        ${detail}`);
}

function bucketsOf(position) {
  const detail = position.detail || {};
  const current = new Map();
  for (const engagement of detail.engagements || []) {
    for (const row of engagement.financial_observations || []) current.set(row.id, engagement);
  }
  const noncurrent = new Map();
  for (const engagement of detail.noncurrent_engagements || []) {
    for (const row of engagement.financial_observations || []) noncurrent.set(row.id, engagement);
  }
  const unmatched = new Map();
  for (const row of detail.unmatched_financial_observations || []) unmatched.set(row.id, row);
  return { current, noncurrent, unmatched };
}

async function run() {
  const connectionString = localOnly(runReceipt.harnessConnectionString());
  runReceipt.begin(__filename, { url: connectionString, expected: 14 });
  const client = new Client({ connectionString, application_name: PREFIX });
  await client.connect();

  let died = null;
  try {
    await client.query("begin");

    const user = (await client.query(
      `insert into users (name, email) values ($1, $2) returning id`,
      [`${PREFIX} recorder`, `${PREFIX}@example.invalid`])).rows[0];
    const property = (await client.query(
      `insert into properties (name) values ($1) returning id`, [`${PREFIX} property`])).rows[0];
    const artifact = (await client.query(
      `insert into source_artifacts
         (scope_type, scope_id, original_filename, uploaded_by_user_id, uploaded_by_basis)
       values ('property', $1, $2, $3, 'disposable local classification proof') returning id`,
      [property.id, `${PREFIX}.pdf`, user.id])).rows[0];
    const provider = (await client.query(
      `insert into contracted_service_providers
         (provider_name, provenance_note, created_by_user_id)
       values ($1, 'disposable local classification proof', $2) returning id`,
      [`${PREFIX} provider`, user.id])).rows[0];

    const engagement = async (serviceClass, from, to) => (await client.query(
      `insert into contracted_service_engagements
         (property_id, service_class, service_label, provider_id, effective_from, effective_to,
          provenance_note, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, 'disposable local classification proof', $7) returning id`,
      [property.id, serviceClass, serviceClass, provider.id, from, to, user.id])).rows[0].id;

    const liveEngagement = await engagement("hvac_maintenance", "2000-01-01", null);
    const endedEngagement = await engagement("elevator_maintenance", "2000-01-01", "2005-01-01");
    const futureEngagement = await engagement("window_washing", "2020-01-01", null);

    const observe = async (engagementId, label, periodStart, periodEnd, serviceClass) =>
      (await client.query(
        `insert into contracted_service_financial_observations
           (property_id, engagement_id, service_class, provider_id, source_artifact_id,
            observation_kind, line_label, period_start, period_end, amount_cents,
            provenance_note, observed_by_user_id)
         values ($1, $2, $3, $4, $5, 'invoice', $6, $7, $8, 184000,
                 'disposable local classification proof', $9) returning id`,
        [property.id, engagementId, serviceClass || null, provider.id, artifact.id,
         label, periodStart, periodEnd, user.id])).rows[0].id;

    const idCurrent   = await observe(liveEngagement,   "current-2010-04", "2010-04-01", "2010-04-30");
    const idEnded     = await observe(endedEngagement,  "ended-2003-04",   "2003-04-01", "2003-04-30");
    const idNotBegun  = await observe(futureEngagement, "prepaid-2009-04", "2009-04-01", "2009-04-30");
    const idOrphan    = await observe(null, "orphan-2010-05", "2010-05-01", "2010-05-31", "roof_repair");
    const idFuture    = await observe(liveEngagement,   "future-2099-01",  "2099-01-01", "2099-01-31");
    const idNoPeriod  = await observe(liveEngagement,   "no-period",       null,         null);

    //  A correction: heads() must drop the superseded row. A corrected row is
    //  not a vanished row, so it is excluded from the invariant set below.
    const idSuperseded = await observe(liveEngagement, "superseded-2010-04", "2010-04-01", "2010-04-30");
    await client.query(
      `insert into contracted_service_financial_observations
         (property_id, engagement_id, service_class, provider_id, source_artifact_id,
          observation_kind, line_label, period_start, period_end, amount_cents,
          provenance_note, observed_by_user_id, supersedes_id, revision_reason)
       values ($1, $2, null, $3, $4, 'invoice', 'correction-2010-04', '2010-04-01', '2010-04-30',
               190000, 'disposable local classification proof', $5, $6, 'amount corrected')`,
      [property.id, liveEngagement, provider.id, artifact.id, user.id, idSuperseded]);

    const position = await positionRead.readPosition(client, { property_id: property.id, as_of: AS_OF });
    const { current, noncurrent, unmatched } = bucketsOf(position);

    const engagementOf = (id) => noncurrent.get(id) || null;
    const countIn = (id) => [current.has(id), noncurrent.has(id), unmatched.has(id)]
      .filter(Boolean).length;

    console.log("\n  ── classification at as_of " + AS_OF + " ──");
    for (const [label, id] of [["current-linked", idCurrent], ["ended-linked", idEnded],
      ["not-yet-begun-linked", idNotBegun], ["orphaned", idOrphan],
      ["future-period", idFuture], ["null-period", idNoPeriod]]) {
      const where = current.has(id) ? "detail.engagements"
        : noncurrent.has(id) ? `noncurrent_engagements (${(engagementOf(id) || {}).temporal_relation})`
        : unmatched.has(id) ? "unmatched" : "— absent —";
      console.log(`     ${label.padEnd(24)} ${where}`);
    }
    console.log("");

    ok("current-linked observation appears exactly once under detail.engagements",
      current.has(idCurrent) && countIn(idCurrent) === 1,
      `buckets=${countIn(idCurrent)}`);

    ok("ended-linked observation appears exactly once under noncurrent_engagements, ENDED",
      noncurrent.has(idEnded) && countIn(idEnded) === 1
        && (engagementOf(idEnded) || {}).temporal_relation === "ENDED",
      `relation=${(engagementOf(idEnded) || {}).temporal_relation} buckets=${countIn(idEnded)}`);

    ok("ended entry carries its ended_on date",
      (engagementOf(idEnded) || {}).ended_on === "2005-01-01",
      `ended_on=${(engagementOf(idEnded) || {}).ended_on}`);

    ok("not-yet-begun in-scope observation appears exactly once, NOT_YET_BEGUN",
      noncurrent.has(idNotBegun) && countIn(idNotBegun) === 1
        && (engagementOf(idNotBegun) || {}).temporal_relation === "NOT_YET_BEGUN",
      `relation=${(engagementOf(idNotBegun) || {}).temporal_relation}`);

    ok("not-yet-begun entry carries its begins_on date and no ended_on",
      (engagementOf(idNotBegun) || {}).begins_on === "2020-01-01"
        && (engagementOf(idNotBegun) || {}).ended_on === null,
      `begins_on=${(engagementOf(idNotBegun) || {}).begins_on}`);

    ok("a future engagement is NOT reported as historical/ENDED",
      (engagementOf(idNotBegun) || {}).temporal_relation !== "ENDED");

    ok("orphaned observation appears exactly once in unmatched",
      unmatched.has(idOrphan) && countIn(idOrphan) === 1);

    ok("future-period observation appears NOWHERE at an as_of before its period",
      countIn(idFuture) === 0, `buckets=${countIn(idFuture)}`);

    ok("null period_start stays visible, with period_start null and no invented date",
      countIn(idNoPeriod) === 1 && current.has(idNoPeriod)
        && (position.detail.engagements[0].financial_observations
            .find((row) => row.id === idNoPeriod) || {}).period_start === null);

    ok("superseded observation is dropped by heads(), not surfaced anywhere",
      countIn(idSuperseded) === 0);

    //  ── unmatched gaps are raised for ORPHANED rows only ──────────────
    const observationGaps = (position.detail.unresolved || [])
      .filter((row) => row.concept === "unmatched_financial_observation");
    const gapIds = new Set(observationGaps.map((row) => row.financial_observation_id));
    ok("unmatched gaps are generated for ORPHANED observations only",
      gapIds.size === 1 && gapIds.has(idOrphan),
      `gaps=${observationGaps.length} ids=${[...gapIds].length}`);

    //  ── current standing is unchanged and current-only ────────────────
    const standingIds = (position.standing.engagements || []).map((row) => row.id);
    const noncurrentIds = new Set((position.detail.noncurrent_engagements || []).map((r) => r.id));
    ok("standing stays current-only: count, engagement ids, and no noncurrent leakage",
      position.standing.engagement_count === 1
        && standingIds.length === 1 && standingIds[0] === liveEngagement
        && !standingIds.some((id) => noncurrentIds.has(id))
        && (position.detail.engagements || []).every((row) => !noncurrentIds.has(row.id)),
      `engagement_count=${position.standing.engagement_count} standing=${standingIds.length}`);

    ok("noncurrent entries carry no term_standing, milestone or accountable_owner",
      (position.detail.noncurrent_engagements || []).every((row) =>
        row.term_standing === undefined && row.milestone === undefined
        && row.accountable_owner === undefined && row.execution_standing === undefined));

    //  ── THE NO-VANISH INVARIANT ───────────────────────────────────────
    //  In-scope head observations computed INDEPENDENTLY in SQL. Every one
    //  must occur in EXACTLY ONE bucket: set equality AND uniqueness.
    const inScope = (await client.query(
      `select t.id from contracted_service_financial_observations t
        where t.property_id = $1
          and (t.period_start is null or t.period_start <= $2)
          and not exists (select 1 from contracted_service_financial_observations s
                           where s.supersedes_id = t.id)`,
      [property.id, AS_OF])).rows.map((row) => String(row.id));
    const placed = [...current.keys(), ...noncurrent.keys(), ...unmatched.keys()].map(String);
    const placedSet = new Set(placed);
    const missing = inScope.filter((id) => !placedSet.has(id));
    const extra = placed.filter((id) => !inScope.includes(id));
    const duplicated = placed.filter((id, index) => placed.indexOf(id) !== index);

    ok("NO-VANISH: every in-scope head observation is placed (set equality)",
      missing.length === 0 && extra.length === 0,
      `in_scope=${inScope.length} placed=${placedSet.size} missing=${missing.length} extra=${extra.length}`);
    ok("NO-VANISH: no observation occupies two buckets (uniqueness)",
      duplicated.length === 0, `duplicated=${duplicated.length}`);

    //  ── the future observation is excluded, not lost ──────────────────
    const later = await positionRead.readPosition(client,
      { property_id: property.id, as_of: AS_OF_LATER });
    const laterBuckets = bucketsOf(later);
    const laterCount = [laterBuckets.current.has(idFuture), laterBuckets.noncurrent.has(idFuture),
      laterBuckets.unmatched.has(idFuture)].filter(Boolean).length;
    ok("future-period observation appears EXACTLY ONCE at a later qualifying as_of",
      laterCount === 1, `buckets_at_${AS_OF_LATER}=${laterCount}`);

    ok("the ended engagement is still ENDED at the later as_of (never becomes current)",
      (later.detail.noncurrent_engagements || []).some((row) =>
        row.id === endedEngagement && row.temporal_relation === "ENDED")
        || !(later.detail.engagements || []).some((row) => row.id === endedEngagement));

    console.log(runReceipt.complete({ harness: __filename, passed,
      failed: failures.length, expectedAtLeast: 14 }) === 0 ? "" : "");
  } catch (error) {
    died = error;
  } finally {
    try { await client.query("rollback"); } catch (_) { /* connection already gone */ }
    await client.end();
  }

  if (died) { console.error(`\n  ✘ ${died.message}\n`); process.exit(1); }
  if (failures.length) process.exit(1);
}

run().catch((error) => { console.error(error); process.exit(1); });
