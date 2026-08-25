"use strict";

/*  ════════════════════════════════════════════════════════════════════
 *  setup_state IS A READINESS DECISION, NOT A DISPLAY HINT.  CLASS 3.
 *
 *  Two consumers branch on it, and both are decisions:
 *
 *    src/surfaces/asset_management.js:461
 *        setup_state !== "not_established"  → Contracted Services is pushed
 *        onto the operator's `live` door list.
 *    src/shared/domain_standing_projections.js:206
 *        setup_state === "not_established"  → Ask Spine answers
 *        NOT_ESTABLISHED; anything else answers ESTABLISHED.
 *
 *  The defect this pins: hasTruth counted RAW observations, which are not
 *  as_of scoped, while engagements and requirements are. So an observation
 *  with period 2099 — excluded from every visible bucket — established the
 *  domain at as_of 2010, while a FUTURE ENGAGEMENT in the same situation
 *  correctly did not. The same temporal fact, opposite readiness decisions,
 *  decided only by which table it sat in. That parity is asserted below.
 *
 *  Visibility is asked of classifyObservation() and nothing else.
 *
 *  ⚠ DOCUMENTS ARE DELIBERATELY NOT PINNED HERE. They remain temporally
 *  unscoped and REPORTED: the repository does not establish which document
 *  date owns visibility. The setup_state temporal contract is NOT yet whole.
 *
 *  ⚠ NOT CI-WIRED. tests/e2e/verify_all.sh is not this lane's to edit, so a
 *  green parent run is NOT evidence that this ran. Rung: LOCALLY_EXERCISED.
 *
 *  Every row it creates is created in one transaction and ROLLED BACK, on
 *  success and on failure alike.
 *  ════════════════════════════════════════════════════════════════════ */

const { Client } = require("pg");

const runReceipt = require("./_run_receipt.js");
const positionRead = require("../src/asset/contracted_service_position_read.js");

const PREFIX = "camp-setup-state-temporal";
const AS_OF = "2010-06-15";
const AS_OF_LATER = "2099-06-15";

function refuse(lines) {
  console.error("\n  ✘ REFUSED");
  for (const line of lines) console.error(`    ${line}`);
  console.error("");
  process.exit(2);
}

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
      is frozen; since every host reaching here is local, port+database closes
      the alias hole for THIS harness.                                        */
  const other = process.env.DATABASE_URL;
  if (other) {
    try {
      const mine = new URL(url); const theirs = new URL(other);
      const port = (u) => u.port || "5432";
      const database = (u) => u.pathname.replace(/^\//, "");
      if (LOCAL.includes(String(theirs.hostname).toLowerCase())
          && port(mine) === port(theirs) && database(mine) === database(theirs)) {
        refuse(["HARNESS_DATABASE_URL and DATABASE_URL name the SAME local database",
          `  port=${port(mine)}  database=${database(mine)}`]);
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

//  ── the two consumer predicates, copied VERBATIM from their owners ──
//  src/surfaces/asset_management.js:461
const assetManagementListsDoorLive = (standing) => standing.setup_state !== "not_established";
//  src/shared/domain_standing_projections.js:206
const askSpineSays = (standing) =>
  (!standing || standing.setup_state === "not_established") ? "NOT_ESTABLISHED" : "ESTABLISHED";

async function scaffold(client, label) {
  const user = (await client.query(
    `insert into users (name, email) values ($1, $2) returning id`,
    [label, `${label}@example.invalid`])).rows[0];
  const property = (await client.query(
    `insert into properties (name) values ($1) returning id`, [label])).rows[0];
  const artifact = (await client.query(
    `insert into source_artifacts
       (scope_type, scope_id, original_filename, uploaded_by_user_id, uploaded_by_basis)
     values ('property', $1, 'proof.pdf', $2, 'disposable local setup_state proof') returning id`,
    [property.id, user.id])).rows[0];
  const provider = (await client.query(
    `insert into contracted_service_providers
       (provider_name, provenance_note, created_by_user_id)
     values ($1, 'disposable local setup_state proof', $2) returning id`,
    [`${label}-provider`, user.id])).rows[0];
  return { user: user.id, property: property.id, artifact: artifact.id, provider: provider.id };
}

const engagement = (client, s, serviceClass, from, to) => client.query(
  `insert into contracted_service_engagements
     (property_id, service_class, service_label, provider_id, effective_from, effective_to,
      provenance_note, created_by_user_id)
   values ($1, $2, $2, $3, $4, $5, 'disposable local setup_state proof', $6) returning id`,
  [s.property, serviceClass, s.provider, from, to, s.user]).then((r) => r.rows[0].id);

const observation = (client, s, engagementId, label, periodStart, periodEnd, serviceClass) =>
  client.query(
    `insert into contracted_service_financial_observations
       (property_id, engagement_id, service_class, provider_id, source_artifact_id,
        observation_kind, line_label, period_start, period_end, amount_cents,
        provenance_note, observed_by_user_id)
     values ($1, $2, $3, $4, $5, 'invoice', $6, $7, $8, 184000,
             'disposable local setup_state proof', $9) returning id`,
    [s.property, engagementId, serviceClass || null, s.provider, s.artifact,
     label, periodStart, periodEnd, s.user]).then((r) => r.rows[0].id);

const review = (client, s, when) => client.query(
  `insert into contracted_service_coverage_reviews
     (property_id, reviewed_as_of, provenance_note, reviewed_by_user_id)
   values ($1, $2, 'disposable local setup_state proof', $3)`,
  [s.property, when, s.user]);

function bucketsOf(position) {
  const detail = position.detail || {};
  const ids = [];
  for (const e of detail.engagements || []) for (const r of e.financial_observations || []) ids.push(r.id);
  for (const e of detail.noncurrent_engagements || []) for (const r of e.financial_observations || []) ids.push(r.id);
  for (const r of detail.unmatched_financial_observations || []) ids.push(r.id);
  return ids;
}

const SCENARIOS = [
  { name: "no truth at all", expect: "not_established", build: async () => {} },
  { name: "coverage review only", expect: "established",
    build: async (c, s) => { await review(c, s, "2010-01-01"); } },
  { name: "FUTURE-only observation, no engagement, no review", expect: "not_established",
    build: async (c, s) => { await observation(c, s, null, "fut", "2099-01-01", "2099-01-31", "svc_a"); } },
  { name: "FUTURE observation on a live engagement, no review", expect: "partially_established",
    build: async (c, s) => {
      const e = await engagement(c, s, "svc_a", "2000-01-01", null);
      await observation(c, s, e, "fut", "2099-01-01", "2099-01-31"); } },
  { name: "FUTURE engagement only, no observation", expect: "not_established",
    build: async (c, s) => { await engagement(c, s, "svc_a", "2020-01-01", null); } },
  { name: "IN_SCOPE orphan observation", expect: "partially_established",
    build: async (c, s) => { await observation(c, s, null, "orph", "2010-05-01", "2010-05-31", "svc_a"); } },
  { name: "IN_SCOPE observation on an ENDED engagement", expect: "partially_established",
    build: async (c, s) => {
      const e = await engagement(c, s, "svc_a", "2000-01-01", "2005-01-01");
      await observation(c, s, e, "hist", "2003-04-01", "2003-04-30"); } },
  { name: "review + ENDED-engagement observation", expect: "established",
    build: async (c, s) => {
      await review(c, s, "2010-01-01");
      const e = await engagement(c, s, "svc_a", "2000-01-01", "2005-01-01");
      await observation(c, s, e, "hist", "2003-04-01", "2003-04-30"); } },
];

async function run() {
  const connectionString = localOnly(runReceipt.harnessConnectionString());
  runReceipt.begin(__filename, { url: connectionString, expected: 12 });
  const client = new Client({ connectionString, application_name: PREFIX });
  await client.connect();

  let died = null;
  try {
    console.log(`\n  ── setup_state at as_of ${AS_OF} ──`);
    const observed = {};
    for (const scenario of SCENARIOS) {
      await client.query("begin");
      try {
        const s = await scaffold(client, `${PREFIX}-${SCENARIOS.indexOf(scenario)}`);
        await scenario.build(client, s);
        const position = await positionRead.readPosition(client,
          { property_id: s.property, as_of: AS_OF });
        const standing = position.standing;
        observed[scenario.name] = { standing, position };
        const live = assetManagementListsDoorLive(standing);
        console.log(`     ${scenario.name.padEnd(48)} ${String(standing.setup_state).padEnd(23)}`
          + `${live ? "door LIVE" : "door absent"} · ${askSpineSays(standing)}`);
        ok(`${scenario.name} → ${scenario.expect}`,
          standing.setup_state === scenario.expect,
          `got ${standing.setup_state}`);
        //  Both consumer decisions must agree with the expected state.
        ok(`  consumers agree for "${scenario.name}"`,
          live === (scenario.expect !== "not_established")
            && askSpineSays(standing) === (scenario.expect === "not_established"
              ? "NOT_ESTABLISHED" : "ESTABLISHED"),
          `door_live=${live} ask_spine=${askSpineSays(standing)}`);
      } finally { await client.query("rollback"); }
    }

    //  ── FOCUSED PARITY · future observation vs future engagement ──────
    //  Deliberately narrow: these two facts, at this as_of. Not generalised
    //  to unrelated table semantics.
    const futureObservation = observed["FUTURE-only observation, no engagement, no review"].standing;
    const futureEngagement = observed["FUTURE engagement only, no observation"].standing;
    ok("PARITY: a future-only observation and a future-only engagement give the SAME setup_state",
      futureObservation.setup_state === futureEngagement.setup_state,
      `observation=${futureObservation.setup_state} engagement=${futureEngagement.setup_state}`);
    ok("PARITY: and both consumer decisions match between those two",
      assetManagementListsDoorLive(futureObservation) === assetManagementListsDoorLive(futureEngagement)
        && askSpineSays(futureObservation) === askSpineSays(futureEngagement));

    //  ── the ended-engagement case must not inflate current standing ───
    const ended = observed["IN_SCOPE observation on an ENDED engagement"];
    const endedGaps = (ended.position.detail.unresolved || [])
      .filter((row) => row.concept === "unmatched_financial_observation");
    ok("ENDED-engagement observation establishes truth with NO current engagement count",
      ended.standing.engagement_count === 0,
      `engagement_count=${ended.standing.engagement_count}`);
    ok("ENDED-engagement observation raises NO false unmatched gap",
      endedGaps.length === 0, `gaps=${endedGaps.length}`);

    //  ── a FUTURE observation is excluded, not lost ────────────────────
    await client.query("begin");
    try {
      const s = await scaffold(client, `${PREFIX}-later`);
      const e = await engagement(client, s, "svc_a", "2000-01-01", null);
      const idFuture = await observation(client, s, e, "fut", "2099-01-01", "2099-01-31");
      const before = await positionRead.readPosition(client, { property_id: s.property, as_of: AS_OF });
      const after = await positionRead.readPosition(client,
        { property_id: s.property, as_of: AS_OF_LATER });
      const countBefore = bucketsOf(before).filter((id) => id === idFuture).length;
      const countAfter = bucketsOf(after).filter((id) => id === idFuture).length;
      ok("FUTURE observation is in NO bucket before its period, and EXACTLY ONE after",
        countBefore === 0 && countAfter === 1,
        `before=${countBefore} after=${countAfter}`);
    } finally { await client.query("rollback"); }

    //  ── documents are deliberately NOT pinned: still unscoped, REPORTED ──
    console.log("\n  note  documents remain temporally unscoped and REPORTED —");
    console.log("        the setup_state temporal contract is NOT yet whole.\n");

    runReceipt.complete({ harness: __filename, passed,
      failed: failures.length, expectedAtLeast: 12 });
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
