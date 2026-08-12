/* ════════════════════════════════════════════════════════════════════
   insurance_truth.db.js — GOVERNED INSURANCE ECONOMICS, proven against
   real PostgreSQL and real HTTP.

   THE ACCEPTANCE CASE, and it is a sentence rather than a schema:

     Skyline is covered by these insurance terms.
     $X of the insurance economics belongs to Skyline.
     The coverage term is Y–Z.
     Therefore $A belongs to June 2026.

   …said WITHOUT ANY FINANCING SCHEDULE. The June 2026 workpaper computes
   that figure from allocated IPFS down payment plus installments ÷ 12,
   which makes the payment instrument the source of the economic fact.
   Nothing in this test knows IPFS exists, and that is the proof.

   THE HARDER CASE, which proves the model rather than the arithmetic:
   4233 is added mid-term and the allocation is recut. JUNE MUST NOT MOVE.

   ISOLATION: harnessConnectionString() resolves host/port/database and
   refuses a target that matches DATABASE_URL. Scoped schema, because the
   full chain cannot rebuild from empty (012_bank_intake / yardi_code) —
   which predates this work and bounds every proof in this repo.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/insurance_truth.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const programs = require("../src/asset/insurance_program_service.js");
const allocations = require("../src/asset/insurance_allocation_service.js");
const position = require("../src/asset/insurance_position_read.js");

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
async function refuses(label, fn, code) {
  try { await fn(); ok(label, false, "it was ACCEPTED"); }
  catch (e) { ok(label, !code || e.code === code, `code=${e.code} msg=${e.message}`); }
}
const USD = (dollars) => Math.round(dollars * 100);

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "ins_truth_" + Date.now();
  let server, port, c;

  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);

    // ── scoped schema: only what this chain touches ────────────────
    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table deal_intakes (id uuid primary key default gen_random_uuid());
      create table deal_intake_properties (
        id uuid primary key default gen_random_uuid(),
        intake_id uuid references deal_intakes(id),
        property_id uuid references properties(id),
        status text not null default 'current');
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        original_filename text not null,
        artifact_kind text not null default 'other');
    `);

    //  Apply the real migration body, minus its own begin/commit and the
    //  source_artifacts widening (this scoped table has no such check).
    const fs = require("fs"), path = require("path");
    let mig = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "161_insurance_economic_truth.sql"), "utf8");
    mig = mig.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "")
             .replace(/alter table source_artifacts[\s\S]*?;\s*$/m, "");
    await c.query(mig);

    //  162 is part of the insurance schema now. It adds participation and
    //  the foreign key making an allocation impossible for a property that
    //  is not named on the coverage — so this file must build the same
    //  schema production has, or it would be proving 161 against a shape
    //  that no longer exists anywhere.
    let mig162 = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "162_insurance_coverage_participation.sql"), "utf8");
    mig162 = mig162.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
    await c.query(mig162);

    //  163 — the FUNDING side. This file proves the ECONOMIC chain, and
    //  none of its assertions touch funding. It is applied because the
    //  Asset Management surface now reads funding alongside economics,
    //  and a scoped schema missing the table makes the compartment 503 —
    //  which would look like an economic defect and is not one.
    let mig163 = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "163_insurance_funding.sql"), "utf8");
    mig163 = mig163.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "")
                   .replace(/alter table source_artifacts drop constraint[\s\S]*$/m, "");
    await c.query(mig163);

    const uid = (await c.query(`insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const skyline = (await c.query(`insert into properties (name) values ('Skyline') returning id`)).rows[0].id;
    const c4233 = (await c.query(`insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;
    const intake = (await c.query(`insert into deal_intakes default values returning id`)).rows[0].id;
    await c.query(`insert into deal_intake_properties (intake_id, property_id) values ($1,$2)`,
                  [intake, skyline]);
    const artifact = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('2026 property binder.pdf','insurance_binder') returning id`)).rows[0].id;

    console.log("\n── 1. CURRENCY IS REFUSED, NEVER DEFAULTED ───────────");

    await refuses("establishing a term with no currency is refused",
      () => programs.establishProgram(c, {
        program_name: "2026 Property Program",
        term_start: "2026-03-01", term_end: "2027-03-01", user_id: uid }),
      "CURRENCY_NOT_ESTABLISHED");
    await refuses("a non-ISO currency is refused rather than coerced",
      () => programs.establishProgram(c, {
        program_name: "X", term_start: "2026-03-01", term_end: "2027-03-01",
        currency_code: "dollars", user_id: uid }), "BAD_INPUT");

    console.log("\n── 2. THE TERM, AND POLICY NUMBER AS EVIDENCE ────────");

    const prog = await programs.establishProgram(c, {
      program_name: "2026 Property Program",
      term_start: "2026-03-01", term_end: "2027-03-01",
      currency_code: "USD", user_id: uid });
    ok("a program is established with an explicit currency", prog.currency_code === "USD");

    const propCov = await programs.establishCoverage(c, {
      program_id: prog.id, coverage_type: "property",
      carrier_name: "Ally", broker_name: "USI",
      coverage_period_start: "2026-03-01", coverage_period_end: "2027-03-01",
      premium_cents: USD(400000), taxes_cents: USD(12000),
      fees_cents: USD(3000), broker_fee_cents: USD(5000), user_id: uid });
    ok("coverage total is generated from its parts, not supplied",
       Number(propCov.total_cents) === USD(420000), String(propCov.total_cents));

    //  THE ALLY CASE: one policy, three textual renderings across systems.
    for (const [v, by] of [["AILUPR1000218-00", "carrier"],
                           ["AILUPR100021800", "broker"],
                           ["ailupr-1000218", "lender"]]) {
      await programs.recordIdentifier(c, {
        coverage_id: propCov.id, identifier_value: v, issued_by: by,
        observed_in_artifact_id: artifact, user_id: uid });
    }
    const ids = (await c.query(
      `select * from insurance_coverage_identifiers where coverage_id=$1`, [propCov.id])).rows;
    ok("three textual renderings of one policy coexist as evidence", ids.length === 3);
    ok("…and none of them is the coverage's identity",
       ids.every((r) => r.identifier_value !== propCov.id));
    ok("policy-number formatting cannot create a second coverage",
       new Set(ids.map((r) => r.coverage_id)).size === 1);

    const glCov = await programs.establishCoverage(c, {
      program_id: prog.id, coverage_type: "general_liability",
      carrier_name: "Lantern", broker_name: "USI",
      coverage_period_start: "2026-03-01", coverage_period_end: "2027-03-01",
      premium_cents: USD(90000), taxes_cents: 0, fees_cents: 0,
      broker_fee_cents: USD(1000), user_id: uid });

    //  ── NAMED ON THE POLICY, BEFORE ANY SHARE OF IT ─────────────────
    //  Migration 162's foreign key makes allocation imply participation.
    //  Recording it here is not test scaffolding — it is the order the
    //  real establish route writes in, and the order the schema now
    //  requires: you cannot hold a share of a policy you are not on.
    //  (glCov, c4233) is named too, so the OVER-allocation case below
    //  actually reaches the over-allocation guard. Without it that test
    //  would refuse one step earlier, on participation, and would stop
    //  proving the arithmetic rule it was written for.
    for (const [cov, prop] of [[propCov, skyline], [glCov, skyline],
                               [propCov, c4233], [glCov, c4233]]) {
      await programs.recordParticipation(c, {
        coverage_id: cov.id, property_id: prop,
        observed_in_artifact_id: artifact, user_id: uid });
    }

    console.log("\n── 3. ALLOCATION IS A GOVERNED FACT ──────────────────");

    await refuses("an allocation with no provenance is refused",
      () => allocations.openSlice(c, {
        coverage_id: propCov.id, property_id: skyline,
        allocated_amount_cents: USD(100000),
        allocation_class: "stated", allocation_basis: "broker_stated",
        effective_from: "2026-03-01", user_id: uid }), "PROVENANCE_REQUIRED");

    await refuses("a DERIVED allocation that does not name its model is refused",
      () => allocations.openSlice(c, {
        coverage_id: propCov.id, property_id: skyline,
        allocated_amount_cents: USD(100000),
        allocation_class: "derived", allocation_basis: "tiv_prorata",
        effective_from: "2026-03-01", provenance_note: "computed", user_id: uid }),
      "DERIVED_NEEDS_MODEL");

    //  THE §38 GUARD: a model's output may not wear an external
    //  authority's label. This is how an internal estimate would
    //  otherwise reach a lender looking carrier-stated.
    await refuses("a TIV pro-rata split cannot be recorded as 'stated'",
      () => allocations.openSlice(c, {
        coverage_id: propCov.id, property_id: skyline,
        allocated_amount_cents: USD(100000),
        allocation_class: "stated", allocation_basis: "tiv_prorata",
        effective_from: "2026-03-01", provenance_note: "x", user_id: uid }),
      "STATED_NEEDS_EXTERNAL_BASIS");

    //  Skyline's property allocation — broker-STATED, with a document.
    const skyProp = await allocations.openSlice(c, {
      coverage_id: propCov.id, property_id: skyline,
      allocated_amount_cents: USD(120000),
      allocation_class: "stated", allocation_basis: "broker_stated",
      effective_from: "2026-03-01",
      source_artifact_id: artifact, user_id: uid });
    ok("a stated allocation records documentary provenance",
       !!skyProp.source_artifact_id);
    ok("Deal membership is stamped at origin", !!skyProp.deal_membership_id);

    //  Skyline's GL allocation — DERIVED, naming its model. Proves the
    //  workbook's separate "property allocation" and "GL allocation".
    await allocations.openSlice(c, {
      coverage_id: glCov.id, property_id: skyline,
      allocated_amount_cents: USD(24000),
      allocation_class: "derived", allocation_basis: "tiv_prorata",
      basis_detail: "TIV pro-rata: Skyline 26.4% of $34.5M scheduled values",
      effective_from: "2026-03-01",
      provenance_note: "computed internally from the 2026 SOV", user_id: uid });

    console.log("\n── 4. MANY-TO-MANY IS REAL ───────────────────────────");

    await allocations.openSlice(c, {
      coverage_id: propCov.id, property_id: c4233,
      allocated_amount_cents: USD(80000),
      allocation_class: "stated", allocation_basis: "broker_stated",
      effective_from: "2026-03-01", source_artifact_id: artifact, user_id: uid });

    const covProps = (await c.query(
      `select count(distinct property_id)::int n from insurance_property_allocations
        where coverage_id=$1`, [propCov.id])).rows[0].n;
    ok("ONE COVERAGE → MANY PROPERTIES", covProps === 2, String(covProps));

    const propCovs = (await c.query(
      `select count(distinct coverage_id)::int n from insurance_property_allocations
        where property_id=$1`, [skyline])).rows[0].n;
    ok("ONE PROPERTY → MANY COVERAGES", propCovs === 2, String(propCovs));

    console.log("\n── 5. ARITHMETIC MAY NOT INVENT A SHARE ──────────────");

    await refuses("OVER-allocation is refused",
      () => allocations.openSlice(c, {
        coverage_id: glCov.id, property_id: c4233,
        allocated_amount_cents: USD(500000),
        allocation_class: "stated", allocation_basis: "carrier_stated",
        effective_from: "2026-03-01", provenance_note: "carrier schedule", user_id: uid }),
      "OVER_ALLOCATED");

    const comp = await position.readCompleteness(c, { property_id: skyline, period: "2026-06" });
    const propComp = comp.find((x) => x.coverage_type === "property");
    ok("UNDER-allocation is exposed as an unresolved remainder, not plugged",
       propComp && propComp.unallocated_cents === USD(220000) && propComp.reconciles === false,
       JSON.stringify(propComp));

    console.log("\n── 6. THE ACCEPTANCE CASE, WITHOUT A FINANCING SCHEDULE ──");

    const june = await position.readPosition(c, { property_id: skyline, period: "2026-06" });
    ok("Skyline is covered by two insurance terms", june.coverages.length === 2);
    ok("the coverage term is 2026-03-01 – 2027-03-01",
       june.coverages.every((x) => x.coverage_period_start === "2026-03-01"
                                && x.coverage_period_end === "2027-03-01"));
    ok("$144,000.00 of insurance economics belongs to Skyline",
       june.annual_cost_cents === USD(144000), String(june.annual_cost_cents));
    //  120,000/12 = 10,000  and  24,000/12 = 2,000  →  12,000
    ok("therefore $12,000.00 belongs to June 2026",
       june.period_accrual_cents === USD(12000), String(june.period_accrual_cents));
    ok("the term divisor is the coverage period, twelve months",
       june.coverages.every((x) => x.term_months === 12));
    ok("stated and derived remain different classes in the position",
       new Set(june.coverages.map((x) => x.allocation_class)).size === 2);
    ok("provenance strength distinguishes a document from a human's word",
       new Set(june.coverages.map((x) => x.provenance_strength)).size === 2,
       JSON.stringify(june.coverages.map((x) => x.provenance_strength)));

    console.log("\n── 7. A MID-TERM CHANGE DOES NOT REWRITE JUNE ────────");

    //  4233's participation grows on 1 July and Skyline's share is recut
    //  downward. This is a NEW effective slice, not a correction.
    await allocations.openSlice(c, {
      coverage_id: propCov.id, property_id: skyline,
      allocated_amount_cents: USD(96000),
      allocation_class: "stated", allocation_basis: "broker_stated",
      effective_from: "2026-07-01",
      source_artifact_id: artifact, user_id: uid });

    const juneAfter = await position.readPosition(c, { property_id: skyline, period: "2026-06" });
    ok("JUNE IS UNCHANGED after the July recut",
       juneAfter.period_accrual_cents === USD(12000), String(juneAfter.period_accrual_cents));
    ok("…and June's annual figure is still the one that governed it",
       juneAfter.annual_cost_cents === USD(144000));

    const july = await position.readPosition(c, { property_id: skyline, period: "2026-07" });
    //  96,000/12 = 8,000  +  2,000  =  10,000
    ok("July reflects the new effective truth", july.period_accrual_cents === USD(10000),
       String(july.period_accrual_cents));

    const hist = await position.readHistory(c, { property_id: skyline });
    ok("the history records this as an effective change, not a correction",
       hist.filter((h) => h.change_kind === "effective_change").length === 3,
       JSON.stringify(hist.map((h) => h.change_kind)));
    ok("the June slice is closed, never edited",
       hist.some((h) => h.effective_from === "2026-03-01" && h.effective_to === "2026-07-01"
                        && h.amount_cents === USD(120000)));

    console.log("\n── 8. A CORRECTION IS NOT AN EFFECTIVE CHANGE ────────");

    await refuses("a correction with no reason is refused",
      () => allocations.correctSlice(c, {
        allocation_id: skyProp.id, allocated_amount_cents: USD(118000), user_id: uid }),
      "REASON_REQUIRED");

    const corrected = await allocations.correctSlice(c, {
      allocation_id: skyProp.id, allocated_amount_cents: USD(118000),
      revision_reason: "broker schedule was transcribed as 120,000; the binder says 118,000",
      user_id: uid });
    ok("a correction supersedes the prior claim", corrected.supersedes_id === skyProp.id);

    const supersededRow = (await c.query(
      `select * from insurance_property_allocations where id=$1`, [skyProp.id])).rows[0];
    ok("the corrected row is PRESERVED, not deleted",
       !!supersededRow && Number(supersededRow.allocated_amount_cents) === USD(120000));

    const hist2 = await position.readHistory(c, { property_id: skyline });
    ok("history distinguishes correction from effective change",
       hist2.some((h) => h.change_kind === "correction")
       && hist2.some((h) => h.change_kind === "effective_change"));

    await refuses("the same row cannot be superseded twice",
      () => allocations.correctSlice(c, {
        allocation_id: skyProp.id, allocated_amount_cents: USD(1),
        revision_reason: "again", user_id: uid }));

    //  CROSS-SCOPE SUPERSESSION, refused by the database trigger.
    await refuses("supersession may not cross (coverage, property) scope", async () => {
      await c.query(
        `insert into insurance_property_allocations
           (coverage_id, property_id, allocated_amount_cents, allocation_class,
            allocation_basis, effective_from, provenance_note, confirmed_by_user_id,
            supersedes_id, revision_reason)
         values ($1,$2,$3,'stated','broker_stated','2026-03-01','x',$4,$5,'y')`,
        [glCov.id, c4233, USD(10), uid, corrected.id]);
    });

    console.log("\n── 9. THE WALL, AT RUNTIME ───────────────────────────");

    //  The schema-level half of the gate: no economic table may carry a
    //  financing column, whatever a future migration intends.
    const cols = (await c.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = $1
          and table_name in ('insurance_programs','insurance_coverages',
                             'insurance_property_allocations','insurance_coverage_identifiers')`,
      [schema])).rows;
    ok("no economic table carries a financing, escrow or payment column",
       !cols.some((r) => /financ|installment|escrow|down_payment|payment/i.test(r.column_name)),
       JSON.stringify(cols.filter((r) => /financ|installment|escrow|payment/i.test(r.column_name))));

    ok("the position was produced with no financing input at all",
       JSON.stringify(june).search(/ipfs|installment|escrow|down_payment/i) === -1);

    console.log("\n── 10. THE DASHBOARD READ, OVER REAL HTTP ────────────");

    const resolverPath = require.resolve("../src/identity/staff_session_service.js");
    require.cache[resolverPath] = { id: resolverPath, filename: resolverPath, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => (t === "tok"
        ? { id: uid, property_id: skyline, allowed_modules: ["asset_management"] } : null) } };

    const express = require("express");
    const app = express();
    const scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${schema}`));
    app.use("/", require("../src/surfaces/asset_management.js")({ pool: scoped }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;

    const get = (p) => new Promise((resolve) => {
      http.request({ host: "127.0.0.1", port, path: p, method: "GET",
        headers: { "x-staff-session": "tok" } }, (res) => {
        let b = ""; res.on("data", (d) => b += d);
        res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: j }); });
      }).end();
    });

    const http6 = await get("/operator/asset-management/insurance?period=2026-06");
    ok("the dashboard read returns 200", http6.status === 200);
    const pos = (http6.body.position || []).reduce((m, x) => (m[x.key] = x.value, m), {});

    //  ── THE CONTRAST THAT PROVES THE MODEL ────────────────────────
    //
    //  June read $144,000 / $12,000 at section 6. It now reads $142,000 /
    //  $11,833.33, and the difference is the whole point:
    //
    //    section 7  an EFFECTIVE CHANGE (the July recut).  June did NOT move.
    //               The world changed going forward; June's slice stands.
    //
    //    section 8  a CORRECTION ($120,000 → $118,000).    June DID move.
    //               The earlier figure was never true, so the period it
    //               governed now reads the corrected one — while the
    //               superseded claim is preserved and still readable.
    //
    //  A model that moved June in both cases would be overwriting history.
    //  One that moved it in neither could never fix a transcription error.
    //  Getting exactly one of them to move is the requirement.
    //
    //  118,000 + 24,000 = 142,000 annual;  118,000/12 + 24,000/12 = 11,833.33
    ok("ANNUAL COST reflects the CORRECTED June figure",
       pos.annual_cost === "$142,000.00", pos.annual_cost);
    ok("MONTHLY ACCRUAL reflects the CORRECTED June figure",
       pos.monthly_accrual === "$11,833.33", pos.monthly_accrual);
    ok("…and the superseded claim is still readable, so June stays explainable",
       (await c.query(`select allocated_amount_cents from insurance_property_allocations
                        where id = $1`, [skyProp.id])).rows[0].allocated_amount_cents === "12000000");
    ok("NEXT RENEWAL renders the coverage end", pos.next_renewal === "2027-03-01", pos.next_renewal);
    ok("PAYMENT stays unestablished — cash is a different chain", pos.payment === null);

    const sec = (k) => (http6.body.sections || []).find((s) => s.key === k);
    ok("Coverage Stack is established", sec("coverage_stack").establishment === "established");
    ok("…and reports shared vs individually insured from the allocation graph",
       sec("coverage_stack").rows.some((r) => /Shared/.test(r.participation)));
    ok("Economic Position is established", sec("economic_position").establishment === "established");
    ok("…and surfaces the unresolved remainder", sec("economic_position").unreconciled.length > 0);
    ok("Renewals & History is established", sec("renewals_history").establishment === "established");
    ok("CASH & FINANCING REMAINS UNESTABLISHED",
       sec("cash_financing").establishment === "not_established"
       && sec("cash_financing").rows.length === 0);
    ok("the compartment reads partially_established, never established",
       http6.body.establishment === "partially_established");
    //  SCOPED TO THE ECONOMIC HALF, deliberately. The cash_financing
    //  section's `reserved` list names down payments, installments and
    //  lender escrow — because that is what that section is FOR, and it
    //  is the only thing describing its shape while its chain is unbuilt.
    //
    //  The wall is not "the word never appears". It is that nothing which
    //  produces the property's insurance ECONOMICS may depend on, derive
    //  from, or so much as mention the cash path. So assert exactly that:
    //  the position strip and the two economic sections.
    const economicHalf = JSON.stringify({
      position: http6.body.position,
      coverage_stack: sec("coverage_stack"),
      economic_position: sec("economic_position"),
    });
    ok("the position and the economic sections mention no financing vocabulary",
       economicHalf.search(/ipfs|installment|escrow|down.?payment|financ/i) === -1,
       (economicHalf.match(/\w*(?:ipfs|installment|escrow|financ)\w*/i) || [])[0]);
    ok("…while the cash section still names the shape it will hold",
       (sec("cash_financing").reserved || []).some((r) => /financing|escrow/i.test(r)));

    //  A period is a preference; a property is not.
    const spoof = await get("/operator/asset-management/insurance?property_id=" + c4233);
    ok("§21 a client-supplied property is still refused on this route", spoof.status === 403);

  } finally {
    //  RELEASE BEFORE end(). A client left checked out makes pool.end()
    //  wait for it forever — the first run of this file hung for two
    //  minutes and printed nothing, which reads exactly like a query that
    //  never returns rather than a harness that never let go.
    if (c) c.release();
    if (server) await new Promise((r) => server.close(r));
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
