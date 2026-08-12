/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax.db.js — THE GOVERNED TAX POSITION, proven against
   real PostgreSQL.

   THE ACCEPTANCE CASE: an operator opens one Philadelphia property and
   can answer — are our taxes current, what applies, what is due next,
   what does the property owe — with nothing invented anywhere.

   The assertions that matter most are the REFUSALS: applicability that
   cannot be inferred, a headline that cannot outrun its evidence, a
   filed return that is not a paid one, and an appeal that changes
   nothing about what is currently owed.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/philadelphia_tax.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const entities = require("../src/entity/legal_entity_service.js");
const taxes = require("../src/asset/tax_obligation_service.js");
const rules = require("../src/asset/philadelphia_tax_rules.js");
const position = require("../src/asset/tax_position_read.js");

const EXPECTED_ASSERTIONS = 58;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
async function refuses(label, fn, code) {
  try { await fn(); ok(label, false, "it was ACCEPTED"); }
  catch (e) { ok(label, !code || e.code === code, `code=${e.code} msg=${e.message}`); }
}
const USD = (d) => Math.round(d * 100);

function scopedMigration(file, drops = []) {
  let m = fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
  m = m.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
  for (const d of drops) m = m.replace(d, "");
  return m;
}

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "phl_tax_" + Date.now();
  let c;
  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);
    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table organizations (id uuid primary key default gen_random_uuid(), name text);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        original_filename text not null, artifact_kind text not null default 'other');
    `);
    await c.query(scopedMigration("164_legal_entities.sql",
      [/alter table source_artifacts drop constraint[\s\S]*$/m]));
    await c.query(scopedMigration("165_philadelphia_tax_position.sql",
      [/alter table source_artifacts drop constraint[\s\S]*$/m]));

    const uid = (await c.query(`insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const p1850 = (await c.query(
      `insert into properties (name) values ('1850 N 18th') returning id`)).rows[0].id;
    const p4233 = (await c.query(
      `insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;
    const bill = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('2026 city tax bill.pdf','tax_bill') returning id`)).rows[0].id;
    const birtReturn = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('1850 Holdings BIRT 2025.pdf','tax_return') returning id`)).rows[0].id;

    const holdings = await entities.establishEntity(c, {
      legal_name: "1850 N 18th Holdings LLC", entity_type: "llc",
      provenance_note: "operating agreement", user_id: uid });
    for (const pid of [p1850, p4233]) {
      await entities.relateToProperty(c, {
        legal_entity_id: holdings.id, property_id: pid, relationship_type: "owner",
        effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });
    }

    const TODAY = "2026-08-12";
    const read = (pid, day) => position.readTaxPosition(c,
      { property_id: pid, as_of: day || TODAY, rules });
    const rowOf = (pos, t) => pos.rows.find((r) => r.tax_type === t);

    console.log("\n── 1. THE LIABLE SUBJECT IS ENFORCED ─────────────────");

    await refuses("BIRT cannot be owed by a PROPERTY",
      () => taxes.establishObligation(c, { tax_type: "birt", period_year: 2025,
        property_id: p1850, provenance_note: "x", user_id: uid }), "SUBJECT_REQUIRED");
    await refuses("Real Estate Tax cannot be owed by a LEGAL ENTITY",
      () => taxes.establishObligation(c, { tax_type: "real_estate", period_year: 2026,
        legal_entity_id: holdings.id, provenance_note: "x", user_id: uid }),
      "SUBJECT_REQUIRED");
    await refuses("…and naming both subjects is refused rather than resolved",
      () => taxes.establishObligation(c, { tax_type: "birt", period_year: 2025,
        property_id: p1850, legal_entity_id: holdings.id, provenance_note: "x",
        user_id: uid }), "WRONG_SUBJECT");
    await refuses("a monthly tax with no month is refused",
      () => taxes.establishObligation(c, { tax_type: "uo", period_year: 2026,
        property_id: p1850, provenance_note: "x", user_id: uid }), "PERIOD_REQUIRED");

    //  ⚠ THE SAAS TENANT CANNOT BECOME A TAXPAYER. There is no column on
    //  tax_obligations that could reach organizations, and this proves it
    //  at the schema rather than by reading the service.
    const cols = (await c.query(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = 'tax_obligations'`, [schema]))
      .rows.map((r) => r.column_name);
    ok("no tax obligation column can reference `organizations`",
       !cols.some((x) => /organi[sz]ation/.test(x)), cols.join(", "));

    console.log("\n── 2. APPLICABILITY IS NEVER INFERRED ────────────────");

    let pos = await read(p1850);
    ok("with no determinations, every row reads NOT ESTABLISHED",
       pos.rows.every((r) => r.applicability === "not_established"),
       JSON.stringify(pos.rows.map((r) => r.applicability)));
    ok("…and the HEADLINE cannot be current",
       pos.overall === "not_established", pos.overall);
    ok("…and it names which taxes are unconfirmed",
       /Real Estate Tax/.test(pos.overall_why) && /NPT/.test(pos.overall_why),
       pos.overall_why);
    ok("…and each row says why it is not current",
       pos.rows.every((r) => /Applicability has not been confirmed/.test(r.why_not_current || "")));

    await refuses("an applicability determination with no basis is refused",
      () => taxes.confirmApplicability(c, { tax_type: "npt", determination: "not_applicable",
        legal_entity_id: holdings.id, effective_from: "2026-01-01",
        provenance_note: "x", user_id: uid }), "BASIS_REQUIRED");
    await refuses("there is no `unknown` determination to store",
      () => taxes.confirmApplicability(c, { tax_type: "npt", determination: "unknown",
        basis: "b", legal_entity_id: holdings.id, effective_from: "2026-01-01",
        provenance_note: "x", user_id: uid }), "BAD_INPUT");

    //  ⚠ THE TRAP. The entity is an LLC, so NPT plausibly applies; making
    //  it a corporation would plausibly exempt it. NEITHER may move the
    //  determination on its own.
    await c.query(`update legal_entities set entity_type = 'corporation' where id = $1`,
                  [holdings.id]);
    pos = await read(p1850);
    ok("changing entity_type to `corporation` does NOT flip NPT to not-applicable",
       rowOf(pos, "npt").applicability === "not_established",
       rowOf(pos, "npt").applicability);
    await c.query(`update legal_entities set entity_type = 'llc' where id = $1`, [holdings.id]);

    console.log("\n── 3. ESTABLISHING THE FOUR ─────────────────────────");

    for (const [t, subj] of [["real_estate", { property_id: p1850 }],
                             ["uo", { property_id: p1850 }],
                             ["birt", { legal_entity_id: holdings.id }],
                             ["npt", { legal_entity_id: holdings.id }]]) {
      await taxes.confirmApplicability(c, { tax_type: t, determination: "applies",
        basis: "Confirmed against the City tax account", ...subj,
        effective_from: "2026-01-01", provenance_note: "City Tax Center", user_id: uid });
    }
    pos = await read(p1850);
    ok("four applicable obligations are counted", pos.obligation_count === 4,
       String(pos.obligation_count));
    ok("the headline is no longer not_established once applicability is confirmed",
       pos.overall !== "not_established", pos.overall);
    ok("…but it is ACTION REQUIRED, because no obligation exists yet",
       pos.overall === "action_required", pos.overall);

    console.log("\n── 4. REAL ESTATE — THE ECONOMIC SPECIMEN ────────────");

    const re = await taxes.establishObligation(c, { tax_type: "real_estate",
      period_year: 2026, property_id: p1850, account_identifier: "OPA 888123456",
      source_artifact_id: bill, user_id: uid });
    await taxes.recordLiability(c, { obligation_id: re.id,
      annual_liability_cents: USD(122259.93), assessment_cents: USD(8732000),
      city_balance_cents: USD(122259.93), balance_as_of: "2026-02-01",
      due_date: "2026-03-31", source_artifact_id: bill, user_id: uid });

    pos = await read(p1850);
    let reRow = rowOf(pos, "real_estate");
    ok("the governed annual liability is the CITY's figure",
       reRow.annual_liability_cents === USD(122259.93),
       String(reRow.annual_liability_cents));
    //  THE SPECIMEN: 122,259.93 over a 12-month period.
    ok("the monthly accrual is the liability over its economic period — 10,188.33",
       reRow.monthly_accrual_cents === 1018833, String(reRow.monthly_accrual_cents));
    ok("the assessment is recorded but is NOT the liability",
       reRow.annual_liability_cents !== USD(8732000));

    //  Past the March 31 due date with a balance outstanding.
    ok("an outstanding City balance after the due date reads OVERDUE",
       reRow.state === "overdue", reRow.state);
    ok("…and says exactly why", /City balance outstanding/.test(reRow.why_not_current || ""),
       reRow.why_not_current);
    ok("…and the headline follows it", pos.overall === "overdue", pos.overall);

    console.log("\n── 5. AN APPEAL CHANGES NOTHING THAT IS OWED ─────────");

    const beforeAppeal = JSON.stringify({
      liab: reRow.annual_liability_cents, accrual: reRow.monthly_accrual_cents });
    await taxes.openAppeal(c, { obligation_id: re.id, opened_on: "2026-04-10",
      provenance_note: "assessment appeal filed", user_id: uid });
    pos = await read(p1850); reRow = rowOf(pos, "real_estate");
    ok("opening an assessment appeal leaves the current liability UNCHANGED",
       JSON.stringify({ liab: reRow.annual_liability_cents,
                        accrual: reRow.monthly_accrual_cents }) === beforeAppeal);
    ok("…and the appeal is surfaced as a fact beside it", reRow.appeal_open === true);

    console.log("\n── 6. AN ADJUSTED BILL CORRECTS, PRESERVING HISTORY ──");

    const firstLiab = (await c.query(
      `select id from tax_liabilities where obligation_id = $1`, [re.id])).rows[0].id;
    await refuses("correcting a liability with no reason is refused",
      () => taxes.recordLiability(c, { obligation_id: re.id,
        annual_liability_cents: USD(118000), due_date: "2026-03-31",
        supersedes_id: firstLiab, provenance_note: "x", user_id: uid }), "REASON_REQUIRED");

    await taxes.recordLiability(c, { obligation_id: re.id,
      annual_liability_cents: USD(118400), city_balance_cents: USD(118400),
      balance_as_of: "2026-05-01", due_date: "2026-03-31",
      supersedes_id: firstLiab, revision_reason: "City issued an adjusted bill after appeal",
      source_artifact_id: bill, user_id: uid });
    pos = await read(p1850); reRow = rowOf(pos, "real_estate");
    ok("the corrected City figure governs the current position",
       reRow.annual_liability_cents === USD(118400), String(reRow.annual_liability_cents));
    const preserved = (await c.query(
      `select annual_liability_cents from tax_liabilities where id = $1`, [firstLiab])).rows[0];
    ok("…and the superseded figure is preserved and still readable",
       Number(preserved.annual_liability_cents) === USD(122259.93));
    const both = (await c.query(
      `select count(*)::int n from tax_liabilities where obligation_id = $1`, [re.id])).rows[0].n;
    ok("…so the history explains what we thought the tax was, and when it changed",
       both === 2, String(both));

    console.log("\n── 7. PAID MEANS THE CITY WAS PAID ───────────────────");

    ok("a positive City balance is not paid", reRow.state === "overdue", reRow.state);
    await taxes.recordPayment(c, { obligation_id: re.id, paid_at: "2026-05-20",
      amount_cents: USD(118400), paid_by: "lender_escrow",
      confirmation_reference: "CITY-8891", provenance_note: "City payment receipt",
      user_id: uid });
    pos = await read(p1850); reRow = rowOf(pos, "real_estate");
    ok("City payment evidence makes it PAID", reRow.state === "paid", reRow.state);
    ok("…and `paid_by = lender_escrow` records WHO remitted without becoming the proof",
       (await c.query(`select paid_by from tax_payments where obligation_id=$1`, [re.id]))
         .rows[0].paid_by === "lender_escrow");

    console.log("\n── 8. BIRT — ONE ENTITY, ONE OBLIGATION ──────────────");

    const birt = await taxes.establishObligation(c, { tax_type: "birt", period_year: 2025,
      legal_entity_id: holdings.id, related_property_ids: [p1850, p4233],
      account_identifier: "PHL 1234567", source_artifact_id: birtReturn, user_id: uid });
    ok("BIRT belongs to the legal entity, not the property",
       birt.liable_legal_entity_id === holdings.id && birt.liable_property_id === null);

    await refuses("the same entity cannot hold two BIRT obligations for one year",
      () => taxes.establishObligation(c, { tax_type: "birt", period_year: 2025,
        legal_entity_id: holdings.id, provenance_note: "x", user_id: uid }),
      "ALREADY_ESTABLISHED");

    //  ⚠ THE DUPLICATION TEST. The entity holds two properties. It has ONE
    //  BIRT return, and both screens must show that same obligation id.
    for (const [t, subj] of [["birt", { legal_entity_id: holdings.id }],
                             ["npt", { legal_entity_id: holdings.id }],
                             ["real_estate", { property_id: p4233 }],
                             ["uo", { property_id: p4233 }]]) {
      await taxes.confirmApplicability(c, { tax_type: t, determination: "applies",
        basis: "Confirmed against the City tax account", ...subj,
        effective_from: "2026-01-01", provenance_note: "City Tax Center", user_id: uid })
        .catch(() => {});
    }
    const posA = await read(p1850), posB = await read(p4233);
    ok("the entity's BIRT surfaces on BOTH properties",
       !!rowOf(posA, "birt").obligation_id && !!rowOf(posB, "birt").obligation_id);
    ok("…as ONE obligation, not two",
       rowOf(posA, "birt").obligation_id === rowOf(posB, "birt").obligation_id);
    const birtCount = (await c.query(
      `select count(*)::int n from tax_obligations where tax_type='birt'`)).rows[0].n;
    ok("…and exactly one BIRT row exists in the database", birtCount === 1, String(birtCount));

    console.log("\n── 9. FILED IS NOT PAID ──────────────────────────────");

    await taxes.recordLiability(c, { obligation_id: birt.id,
      annual_liability_cents: USD(14200), city_balance_cents: USD(14200),
      balance_as_of: "2026-04-20", due_date: "2026-04-15",
      source_artifact_id: birtReturn, user_id: uid });
    await taxes.recordFiling(c, { obligation_id: birt.id, filed_at: "2026-04-14",
      filing_kind: "return", source_artifact_id: birtReturn, user_id: uid });

    pos = await read(p1850);
    const birtRow = rowOf(pos, "birt");
    ok("a filed return with an outstanding balance is NOT simply current",
       birtRow.state !== "current", birtRow.state);
    ok("…it reads OVERDUE once the payment date has passed unsatisfied",
       birtRow.state === "overdue", birtRow.state);
    ok("…and the reason names the balance, not the return",
       /balance outstanding/i.test(birtRow.why_not_current || ""), birtRow.why_not_current);

    //  An ESTIMATE is not a return, and must not satisfy the filing.
    const npt = await taxes.establishObligation(c, { tax_type: "npt", period_year: 2025,
      legal_entity_id: holdings.id, related_property_ids: [p1850],
      provenance_note: "City account", user_id: uid });
    await taxes.recordFiling(c, { obligation_id: npt.id, filed_at: "2026-04-15",
      filing_kind: "estimate", provenance_note: "estimate 1", user_id: uid });
    pos = await read(p1850);
    ok("an ESTIMATE does not satisfy the annual return requirement",
       rowOf(pos, "npt").state === "overdue", rowOf(pos, "npt").state);
    ok("…and says the return is not filed",
       /return not filed/i.test(rowOf(pos, "npt").why_not_current || ""),
       rowOf(pos, "npt").why_not_current);

    console.log("\n── 10. U&O IS LIVE, AND MONTHLY ──────────────────────");

    ok("the rules module states the annual exemption ENDED, not the tax",
       rules.uoExemptionStatus(TODAY).annual_exemption_available === false
       && /remains active/i.test(rules.uoExemptionStatus(TODAY).note));
    ok("…and it was available before 2026",
       rules.uoExemptionStatus("2025-06-01").annual_exemption_available === true);

    const uoMs = rules.milestonesFor("uo", "2026-07-01");
    ok("U&O for July is due on the 25th of August",
       uoMs.every((m) => m.due === "2026-08-25"), JSON.stringify(uoMs));

    pos = await read(p1850);
    ok("with July U&O unestablished, the row says exactly that",
       /2026-07/.test(rowOf(pos, "uo").why_not_current || ""), rowOf(pos, "uo").why_not_current);

    const uo = await taxes.establishObligation(c, { tax_type: "uo", period_year: 2026,
      period_month: 7, property_id: p1850, provenance_note: "City U&O account",
      user_id: uid });
    await taxes.recordFiling(c, { obligation_id: uo.id, filed_at: "2026-08-10",
      filing_kind: "return", provenance_note: "monthly filing", user_id: uid });
    await taxes.recordPayment(c, { obligation_id: uo.id, paid_at: "2026-08-10",
      amount_cents: USD(1450), provenance_note: "City receipt", user_id: uid });
    pos = await read(p1850);
    ok("a filed and paid July U&O reads PAID", rowOf(pos, "uo").state === "paid",
       rowOf(pos, "uo").state);

    //  Residential-only, confirmed. NOT inferred from the absence of
    //  commercial space — a human established it with a basis.
    await taxes.confirmApplicability(c, { tax_type: "uo", determination: "not_applicable",
      basis: "Confirmed residential-only; no business-used portion",
      property_id: p4233, effective_from: "2026-02-01",
      provenance_note: "site confirmation", user_id: uid });
    //  ⚠ AND A SAME-DAY RESTATEMENT MUST BE A CORRECTION, NOT A SECOND
    //  LIVE TRUTH. Without this the property would be both `applies` and
    //  `not_applicable` and the screen would show whichever came first.
    await refuses("restating an applicability for the same date is refused as needing a correction",
      () => taxes.confirmApplicability(c, { tax_type: "uo", determination: "applies",
        basis: "changed my mind", property_id: p4233, effective_from: "2026-02-01",
        provenance_note: "x", user_id: uid }), "CORRECTION_REQUIRED");

    const posC = await read(p4233);
    ok("exactly ONE live U&O determination exists for the property",
       (await c.query(`select count(*)::int n from tax_obligation_applicability
                        where tax_type='uo' and subject_property_id=$1
                          and effective_to is null and supersedes_id is null`,
                      [p4233])).rows[0].n === 1);
    ok("a CONFIRMED residential-only property reads U&O NOT APPLICABLE",
       rowOf(posC, "uo").applicability === "not_applicable");
    ok("…carrying the basis, so it can be re-examined",
       /residential-only/i.test(rowOf(posC, "uo").applicability_basis || ""));
    ok("…and it is excluded from the obligation count",
       posC.obligation_count === 3, String(posC.obligation_count));

    console.log("\n── 11. CLEARANCE IS EVIDENCE, NOT AN ANSWER ──────────");

    await taxes.recordClearance(c, { property_id: p1850, issued_on: "2026-07-01",
      verified_through: "2026-09-30", certificate_reference: "TC-4233",
      provenance_note: "City clearance certificate", user_id: uid });
    pos = await read(p1850);
    ok("a valid clearance is reported", pos.clearance
       && pos.clearance.verified_through === "2026-09-30", JSON.stringify(pos.clearance));
    //  ⚠ IT MUST NOT PAPER OVER AN OVERDUE OBLIGATION.
    ok("…and it does NOT make the position current while BIRT is overdue",
       pos.overall === "overdue", pos.overall);
    ok("…the disagreement is SURFACED as a conflict rather than resolved silently",
       pos.clearance.conflicts_with.length > 0,
       JSON.stringify(pos.clearance.conflicts_with));

    console.log("\n── 12. NOTHING IS INVENTED ───────────────────────────");

    //  4233 legitimately shows the ENTITY's BIRT liability — that is the
    //  compression working. What must be blank is its own REAL ESTATE
    //  row, where no obligation and no City bill exist.
    const posD = await read(p4233);
    const reD = rowOf(posD, "real_estate");
    ok("a property with no City bill reports NO real-estate amount",
       reD.annual_liability_cents === null, JSON.stringify(reD.annual_liability_cents));
    ok("…and no accrual — never a zero", reD.monthly_accrual_cents === null,
       JSON.stringify(reD.monthly_accrual_cents));
    ok("…while the shared entity BIRT liability DOES surface here, as one obligation",
       rowOf(posD, "birt").annual_liability_cents === USD(14200)
       && rowOf(posD, "birt").obligation_id === birt.id);
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "asset", "tax_position_read.js"), "utf8");
    ok("the position read imports NOTHING — it cannot reach funding by any path",
       !/require\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, " ")
                                 .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")));
    const svc = fs.readFileSync(
      path.join(__dirname, "..", "src", "asset", "tax_obligation_service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    ok("no rate, no assessment × rate, no computed tax anywhere in the writer",
       !/\*\s*rate|rate\s*\*|millage/i.test(svc));

  } catch (e) {
    console.error("\nHARNESS DIED:", e); process.exitCode = 1;
  } finally {
    if (c) c.release();
    try { await pool.query(`drop schema ${schema} cascade`); } catch (_) {}
    await pool.end();
  }

  const total = pass + fail;
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${total} assertions · ${pass} passed · ${fail} failed`);
  if (total < EXPECTED_ASSERTIONS) {
    console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${total}.`);
    process.exit(1);
  }
  console.log("════════════════════════════════════════════════════════");
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
