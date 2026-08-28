/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_standing.db.js — THE FOUR CORRECTNESS DEFECTS FOUND
   IN REVIEW, EACH PINNED AGAINST REAL POSTGRESQL SO IT CANNOT RETURN.

   The clocks have a pure test of their own. This file proves the two
   defects that only show up once real rows exist:

     PAYMENT IDENTITY   a payment satisfies the requirement it NAMES, and
                        nothing else. A part payment is not payment.
     THE STANDING READ  a row is a compressed position over every active
                        requirement, not one selected period.

   Every assertion here corresponds to a specific wrong answer the
   product gave before migration 167 and the read rewrite:

       $50,000 against a $122,259.93 bill              read PAID
       an NPT first estimate                           closed the second
       a BIRT balance payment                          closed the following
                                                       year's mandatory estimate
       a row with July complete and August open        could not say either

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/proofs/philadelphia_tax_standing.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const URL_ = receipt.harnessConnectionString();

const entities = require("../../src/entity/legal_entity_service.js");
const taxes = require("../../src/asset/tax_obligation_service.js");
const rules = require("../../src/asset/philadelphia_tax_rules.js");
const position = require("../../src/asset/tax_position_read.js");

const EXPECTED_ASSERTIONS = 41;
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
  let m = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", file), "utf8");
  m = m.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
  for (const d of drops) m = m.replace(d, "");
  return m;
}

//  The operator's own specimen figures.
const ANNUAL = USD(122259.93);
const ACCRUAL = USD(10188.33);
const AS_OF = "2026-08-12";

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "phl_standing_" + Date.now();
  let c;
  try {
    await pool.query(`create schema ${schema}`);
    c = await pool.connect();
    await c.query(`set search_path to ${schema}`);
    await c.query(`
      create extension if not exists pgcrypto;
      create table users (id uuid primary key default gen_random_uuid(), name text);
      create table properties (id uuid primary key default gen_random_uuid(), name text);
      create table source_artifacts (
        id uuid primary key default gen_random_uuid(),
        original_filename text not null, artifact_kind text not null default 'other');
    `);
    const drop = [/alter table source_artifacts drop constraint[\s\S]*$/m];
    await c.query(scopedMigration("164_legal_entities.sql", drop));
    await c.query(scopedMigration("165_philadelphia_tax_position.sql", drop));
    await c.query(scopedMigration("167_tax_payment_identity.sql"));

    const uid = (await c.query(
      `insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const prop = (await c.query(
      `insert into properties (name) values ('2116 Chestnut') returning id`)).rows[0].id;
    const bill = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('2026 RET bill.pdf','tax_bill') returning id`)).rows[0].id;

    const holder = await entities.establishEntity(c, {
      legal_name: "2116 Chestnut Partners LLC", entity_type: "llc",
      provenance_note: "operating agreement", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: holder.id, property_id: prop, relationship_type: "owner",
      effective_from: "2020-01-01", provenance_note: "deed", user_id: uid });

    for (const [t, ent] of [["real_estate", null], ["uo", null],
                            ["birt", holder.id], ["npt", holder.id]]) {
      await taxes.confirmApplicability(c, {
        tax_type: t, determination: "applies",
        basis: "Philadelphia property operated as a business.",
        property_id: ent ? null : prop, legal_entity_id: ent,
        effective_from: "2020-01-01", provenance_note: "asset manager review",
        user_id: uid });
    }

    const read = () => position.readTaxPosition(c,
      { property_id: prop, as_of: AS_OF, rules });
    const rowOf = (p, t) => p.rows.find((r) => r.tax_type === t);

    console.log("\n══ 1. A PART PAYMENT IS NOT A PAYMENT ═══════════════════════");

    const re = await taxes.establishObligation(c, {
      tax_type: "real_estate", period_year: 2026, property_id: prop,
      account_identifier: "OPA 881566975", source_artifact_id: bill, user_id: uid });
    await taxes.recordLiability(c, {
      obligation_id: re.id, annual_liability_cents: ANNUAL,
      due_date: "2026-03-31", source_artifact_id: bill, user_id: uid });

    let pos = await read();
    ok("the governed liability is the City's figure, to the cent",
       rowOf(pos, "real_estate").annual_liability_cents === ANNUAL,
       String(rowOf(pos, "real_estate").annual_liability_cents));
    ok("the accrual is that liability over its own twelve months",
       rowOf(pos, "real_estate").monthly_accrual_cents === ACCRUAL,
       String(rowOf(pos, "real_estate").monthly_accrual_cents));
    ok("unpaid past its March 31 date, it reads OVERDUE",
       rowOf(pos, "real_estate").state === "overdue");

    //  ⚠ THE DEFECT. $50,000 against $122,259.93.
    await taxes.recordPayment(c, {
      obligation_id: re.id, paid_at: "2026-03-30", amount_cents: USD(50000),
      paid_by: "property", provenance_note: "partial City payment", user_id: uid });

    pos = await read();
    let reRow = rowOf(pos, "real_estate");
    ok("⚠ $50,000 against $122,259.93 does NOT read PAID",
       reRow.state !== "paid", reRow.state);
    ok("…it reads OVERDUE, because the due date has passed",
       reRow.state === "overdue", reRow.state);
    ok("…and the row says PARTLY PAID rather than a bare 'outstanding'",
       reRow.detail === "Partly paid", reRow.detail);
    ok("…and names what is still owed, to the cent",
       /\$72,259\.93 still outstanding/.test(reRow.why_not_current || ""),
       reRow.why_not_current);

    const annualReq = reRow.periods[0].requirements
      .find((r) => r.key === "payment:annual");
    ok("the requirement itself carries paid, required and outstanding",
       annualReq.paid_cents === USD(50000) && annualReq.required_cents === ANNUAL
       && annualReq.outstanding_cents === USD(72259.93), JSON.stringify(annualReq));
    ok("the payment allocated itself — one requirement leaves nothing to guess",
       (await c.query(`select satisfies_requirement from tax_payments
                        where obligation_id = $1`, [re.id])).rows[0]
         .satisfies_requirement === "payment:annual");

    //  Now the rest of it.
    await taxes.recordPayment(c, {
      obligation_id: re.id, paid_at: "2026-03-31", amount_cents: USD(72259.93),
      paid_by: "property", provenance_note: "balance of the City payment", user_id: uid });
    pos = await read();
    ok("⚠ the full governed amount, across two payments, reads PAID",
       rowOf(pos, "real_estate").state === "paid", rowOf(pos, "real_estate").state);

    console.log("\n══ 2. ONE ESTIMATE DOES NOT PAY THE OTHER ═══════════════════");

    //  NPT 2026: estimates due Apr 15 and Jun 15 2026 — both already past
    //  at AS_OF, and neither is the other.
    const npt = await taxes.establishObligation(c, {
      tax_type: "npt", period_year: 2026, legal_entity_id: holder.id,
      related_property_ids: [prop], provenance_note: "City NPT account", user_id: uid });

    await refuses("a payment with no named requirement is REFUSED where several exist",
      () => taxes.recordPayment(c, { obligation_id: npt.id, paid_at: "2026-04-15",
        amount_cents: USD(4000), provenance_note: "estimate", user_id: uid }),
      "REQUIREMENT_REQUIRED");
    await refuses("…and the refusal lists the requirements it could have meant",
      () => taxes.recordPayment(c, { obligation_id: npt.id, paid_at: "2026-04-15",
        amount_cents: USD(4000), provenance_note: "estimate", user_id: uid }),
      "REQUIREMENT_REQUIRED");
    await refuses("a requirement this obligation does not carry is REFUSED",
      () => taxes.recordPayment(c, { obligation_id: npt.id, paid_at: "2026-04-15",
        amount_cents: USD(4000), satisfies_requirement: "payment:annual",
        provenance_note: "estimate", user_id: uid }), "UNKNOWN_REQUIREMENT");

    await taxes.recordPayment(c, {
      obligation_id: npt.id, paid_at: "2026-04-15", amount_cents: USD(4000),
      satisfies_requirement: "payment:estimate_1",
      provenance_note: "first estimate, City receipt", user_id: uid });

    pos = await read();
    const nptRow = rowOf(pos, "npt");
    const p2026 = nptRow.periods.find((x) => x.period_label === "2026");
    const est1 = p2026.requirements.find((r) => r.key === "payment:estimate_1");
    const est2 = p2026.requirements.find((r) => r.key === "payment:estimate_2");
    ok("the FIRST estimate is satisfied", est1.satisfied === true);
    ok("⚠ the SECOND estimate is NOT — one estimate never pays the other",
       est2.satisfied === false, JSON.stringify(est2));
    ok("…and the second is overdue, because Jun 15 has passed",
       est2.overdue === true);
    ok("the row is overdue on account of it",
       nptRow.state === "overdue", nptRow.state);
    ok("…and the reason names the SECOND estimate specifically",
       /second 2026 estimated payment/i.test(nptRow.why_not_current || ""),
       nptRow.why_not_current);
    ok("an estimate's amount is not governed, so satisfaction says it was unchecked",
       est1.amount_unchecked === true);

    console.log("\n══ 3. A ROW HOLDS SEVERAL PERIODS AT ONCE ═══════════════════");

    ok("⚠ NPT holds BOTH the 2025 return year and the 2026 estimate year",
       nptRow.periods.map((x) => x.period_label).sort().join(",") === "2025,2026",
       JSON.stringify(nptRow.periods.map((x) => x.period_label)));
    ok("…and 2025 is flagged as not established, since its April has passed",
       nptRow.periods.find((x) => x.period_label === "2025").state === "action_required");

    console.log("\n══ 4. BIRT: THE BALANCE AND THE ESTIMATE ARE TWO THINGS ═════");

    const birt = await taxes.establishObligation(c, {
      tax_type: "birt", period_year: 2025, legal_entity_id: holder.id,
      related_property_ids: [prop], provenance_note: "prior-year return", user_id: uid });

    pos = await read();
    ok("⚠ with no filer profile, the row will not claim to be settled",
       rowOf(pos, "birt").unestablished_requirements.length === 1,
       JSON.stringify(rowOf(pos, "birt").unestablished_requirements));

    await taxes.setBirtFilerProfile(c, {
      obligation_id: birt.id, birt_filer_profile: "established",
      basis: "Filing in Philadelphia since 2019; not a new business.", user_id: uid });
    await refuses("a filer profile with no basis is refused",
      () => taxes.setBirtFilerProfile(c, { obligation_id: birt.id,
        birt_filer_profile: "first_year", basis: "  ", user_id: uid }), "BASIS_REQUIRED");

    await taxes.recordLiability(c, {
      obligation_id: birt.id, annual_liability_cents: USD(8400),
      due_date: "2026-04-15", provenance_note: "2025 BIRT return", user_id: uid });
    await taxes.recordFiling(c, {
      obligation_id: birt.id, filed_at: "2026-03-29", filing_kind: "return",
      provenance_note: "filed by the accountant", user_id: uid });
    await taxes.recordPayment(c, {
      obligation_id: birt.id, paid_at: "2026-04-15", amount_cents: USD(8400),
      satisfies_requirement: "payment:balance",
      provenance_note: "City receipt for the 2025 balance", user_id: uid });

    pos = await read();
    const birtRow = rowOf(pos, "birt");
    const bp = birtRow.periods[0];
    ok("the return is filed and the 2025 balance is paid",
       bp.requirements.find((r) => r.key === "filing:return").satisfied === true
       && bp.requirements.find((r) => r.key === "payment:balance").satisfied === true);
    //  ⚠ THE ONE THE OPERATOR NAMED: prior-year return filed while the
    //  current-year estimate is outstanding must not read as settled.
    ok("⚠ the mandatory 2026 estimate is STILL outstanding",
       bp.requirements.find((r) => r.key === "payment:estimate_next_year")
         .satisfied === false);
    ok("⚠ …so the row does NOT overstate itself as current or paid",
       !["current", "paid"].includes(birtRow.state), birtRow.state);
    ok("…and the reason names the estimate, not the balance",
       /mandatory 2026 estimated payment/i.test(birtRow.why_not_current || ""),
       birtRow.why_not_current);
    ok("the whole position cannot read current either",
       pos.overall !== "current", pos.overall);

    await taxes.recordPayment(c, {
      obligation_id: birt.id, paid_at: "2026-04-15", amount_cents: USD(9000),
      satisfies_requirement: "payment:estimate_next_year",
      provenance_note: "City receipt for the 2026 estimate", user_id: uid });
    pos = await read();
    ok("with the estimate evidenced too, the BIRT year finally reads PAID",
       rowOf(pos, "birt").state === "paid", rowOf(pos, "birt").state);

    console.log("\n══ 5. U&O: JULY CLOSED, AUGUST OPEN, ON ONE ROW ═════════════");

    let uoRow = rowOf(await read(), "uo");
    ok("⚠ with nothing established the row still says NEXT AUG 25",
       uoRow.next_due === "2026-08-25", String(uoRow.next_due));
    ok("…and reads CURRENT, because the 25th has not arrived",
       uoRow.state === "current", uoRow.state);

    //  July, established, filed and paid.
    const july = await taxes.establishObligation(c, {
      tax_type: "uo", period_year: 2026, period_month: 7, property_id: prop,
      provenance_note: "City U&O account", user_id: uid });
    await taxes.recordLiability(c, {
      obligation_id: july.id, annual_liability_cents: USD(1450),
      due_date: "2026-07-27", provenance_note: "July U&O filing", user_id: uid });
    await taxes.recordFiling(c, {
      obligation_id: july.id, filed_at: "2026-07-24", filing_kind: "return",
      provenance_note: "monthly filing", user_id: uid });
    await taxes.recordPayment(c, {
      obligation_id: july.id, paid_at: "2026-07-24", amount_cents: USD(1450),
      provenance_note: "City receipt", user_id: uid });

    uoRow = rowOf(await read(), "uo");
    ok("⚠ the row now holds BOTH July and August",
       uoRow.periods.map((x) => x.period_label).sort().join(",") === "2026-07,2026-08",
       JSON.stringify(uoRow.periods.map((x) => x.period_label)));
    ok("…July reads PAID on its own period",
       uoRow.periods.find((x) => x.period_label === "2026-07").state === "paid");
    ok("…August is open and not late",
       uoRow.periods.find((x) => x.period_label === "2026-08").state === "current");
    ok("…the row compresses to CURRENT, next due Aug 25",
       uoRow.state === "current" && uoRow.next_due === "2026-08-25",
       `${uoRow.state} / ${uoRow.next_due}`);
    ok("…and the July payment allocated itself to the monthly requirement",
       uoRow.periods.find((x) => x.period_label === "2026-07").requirements
         .find((r) => r.key === "payment:monthly").satisfied === true);

    console.log("\n══ 6. MONEY THAT NAMES NOTHING SATISFIES NOTHING ════════════");

    //  Written behind the writer on purpose — the service would have
    //  refused it. This proves the READ is defensive too, because a row
    //  inserted by a repair script or a future caller must not silently
    //  close a requirement.
    await c.query(
      `insert into tax_payments (obligation_id, paid_at, amount_cents,
         provenance_note, recorded_by_user_id)
       values ($1,'2026-06-15',400000,'unattributed',$2)`, [npt.id, uid]);

    pos = await read();
    const nrow = rowOf(pos, "npt");
    ok("⚠ an unallocated payment does NOT satisfy the outstanding estimate",
       nrow.periods.find((x) => x.period_label === "2026").requirements
         .find((r) => r.key === "payment:estimate_2").satisfied === false);
    ok("…and it is SURFACED rather than ignored — money with no purpose is a finding",
       nrow.unallocated_payments.length === 1
       && nrow.unallocated_payments[0].amount_cents === USD(4000),
       JSON.stringify(nrow.unallocated_payments));
    ok("…and says why it satisfies nothing",
       /does not say which requirement/.test(nrow.unallocated_payments[0].why));

    console.log("\n══ 7. THE READ CARRIES ITS OWN CALENDAR VERDICT ═════════════");

    ok("the position reports zero disagreement between our rule and the City",
       Array.isArray(pos.schedule_disagreements) && pos.schedule_disagreements.length === 0,
       JSON.stringify(pos.schedule_disagreements));
    ok("every U&O date it used is one the City published",
       uoRow.periods.every((x) => x.requirements.every((r) => r.date_source === "published")));

  } finally {
    if (c) {
      try { await c.query(`drop schema ${schema} cascade`); } catch (_) {}
      c.release();
    }
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}.`);
    process.exit(1);
  }
  if (fail) { console.log("  ✗ FAIL"); process.exit(1); }
  console.log("  ✓ PASS — a payment proves what it names, and a row is a position.");
  console.log("════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error("HARNESS DIED:", e); process.exit(1); });
