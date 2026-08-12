/* ════════════════════════════════════════════════════════════════════
   philadelphia_tax_funding.db.js — THE WALL BETWEEN WHAT A TAX COSTS AND
   HOW IT IS PAID FOR, PROVEN BEHAVIOURALLY AGAINST REAL POSTGRESQL.

   `gate_funding_boundary.js` proves the wall STRUCTURALLY: the economic
   chain cannot import funding, funding cannot write an economic table.
   That is a claim about source text. This file proves the two claims
   that actually reach an operator, against real rows:

     1  A SERVICER RAISING THE ESCROW CONTRIBUTION CHANGES NOTHING about
        the annual liability or the monthly accrual. Asserted by
        serialising the whole tax position before and after and comparing
        the strings — and, so the comparison is not vacuous, by asserting
        the funding read DID change in the same breath.

     2  AN ESCROW BALANCE OVER THE BILL IS NOT A PAYMENT. Neither is a
        servicer's disbursement record. The obligation keeps reading
        overdue until there is City payment evidence, and the
        disagreement is surfaced rather than resolved.

   Both are the same failure in different clothes: cash mistaken for
   economics. Both are the reason 161 exists in Insurance and the reason
   166 was written the way it was.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/philadelphia_tax_funding.db.js
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
const funding = require("../src/asset/tax_funding_service.js");
const fundingRead = require("../src/asset/tax_funding_read.js");

const EXPECTED_ASSERTIONS = 54;
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

//  A fixed observation date. The proof must be able to ask about any day
//  without waiting for it, and a suite whose verdict changes in April is
//  not a proof.
const AS_OF = "2026-08-12";

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "phl_taxfund_" + Date.now();
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
    const dropKindCheck = [/alter table source_artifacts drop constraint[\s\S]*$/m];
    await c.query(scopedMigration("164_legal_entities.sql", dropKindCheck));
    await c.query(scopedMigration("165_philadelphia_tax_position.sql", dropKindCheck));
    await c.query(scopedMigration("166_tax_funding.sql", dropKindCheck));

    console.log("\n══ 0. THE FIXTURE ═══════════════════════════════════════════");

    const uid = (await c.query(
      `insert into users (name) values ('Asset Ops') returning id`)).rows[0].id;
    const prop = (await c.query(
      `insert into properties (name) values ('1850 N 18th') returning id`)).rows[0].id;
    const other = (await c.query(
      `insert into properties (name) values ('4233 Chestnut') returning id`)).rows[0].id;

    const art = async (name, kind) => (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ($1,$2) returning id`, [name, kind])).rows[0].id;
    const cityBill = await art("2026 RE tax bill.pdf", "tax_bill");
    const escrowStmt = await art("servicer escrow statement 2026-08.pdf", "tax_escrow_statement");
    const analysis = await art("escrow analysis 2026-06.pdf", "tax_escrow_analysis");
    const cityReceipt = await art("city payment confirmation.pdf", "tax_payment_receipt");

    const holdings = await entities.establishEntity(c, {
      legal_name: "1850 N 18th Holdings LLC", entity_type: "llc",
      provenance_note: "operating agreement", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: holdings.id, property_id: prop, relationship_type: "owner",
      effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });

    //  A second entity that this property does NOT reach, to prove the
    //  subject rules bite rather than merely being stated.
    const stranger = await entities.establishEntity(c, {
      legal_name: "Unrelated Partners LP", entity_type: "lp",
      provenance_note: "seen in a rent roll footer", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: stranger.id, property_id: other, relationship_type: "owner",
      effective_from: "2024-01-01", provenance_note: "deed", user_id: uid });

    for (const [t, d, basis] of [
      ["real_estate", "applies", "Philadelphia property; OPA account on the City bill."],
      ["uo", "not_applicable", "Entirely residential; no commercial use of the premises."],
      ["birt", "applies", "The owning entity conducts business in Philadelphia."],
      ["npt", "not_applicable", "The owner is an LLC filing BIRT; no NPT-liable individual."],
    ]) {
      await taxes.confirmApplicability(c, {
        tax_type: t, determination: d, basis,
        property_id: rules.SUBJECT_KIND[t] === "property" ? prop : null,
        legal_entity_id: rules.SUBJECT_KIND[t] === "legal_entity" ? holdings.id : null,
        effective_from: "2024-01-01", provenance_note: "asset manager review", user_id: uid,
      });
    }

    //  2026 Real Estate Tax. Due 2026-03-31 — already past as of AS_OF.
    const re2026 = await taxes.establishObligation(c, {
      tax_type: "real_estate", period_year: 2026, property_id: prop,
      account_identifier: "OPA 881234567",
      source_artifact_id: cityBill, user_id: uid });
    await taxes.recordLiability(c, {
      obligation_id: re2026.id, annual_liability_cents: USD(14203.00),
      assessment_cents: USD(1014500), due_date: "2026-03-31",
      source_artifact_id: cityBill, user_id: uid });

    //  2025 BIRT for the entity, related to this property.
    const birt2025 = await taxes.establishObligation(c, {
      tax_type: "birt", period_year: 2025, legal_entity_id: holdings.id,
      related_property_ids: [prop], provenance_note: "prior-year return", user_id: uid });
    await taxes.recordFiling(c, {
      obligation_id: birt2025.id, filed_at: "2026-04-10", filing_kind: "return",
      provenance_note: "filed by the accountant", user_id: uid });
    await taxes.recordPayment(c, {
      obligation_id: birt2025.id, paid_at: "2026-04-10", amount_cents: USD(2140.00),
      paid_by: "property", provenance_note: "ACH from operating account", user_id: uid });

    ok("fixture: four applicability determinations and two obligations exist", true);

    console.log("\n══ 1. THE ARRANGEMENT REFUSES WHAT IT CANNOT SAY HONESTLY ═══");

    await refuses("a directly-paid tax cannot carry escrow detail",
      () => funding.openArrangement(c, {
        tax_type: "real_estate", property_id: prop, funding_method: "direct",
        effective_from: "2024-01-01", provenance_note: "n",
        escrow: { servicer_name: "Cenlar" }, user_id: uid }), "DIRECT_HAS_NO_ESCROW");

    await refuses("an escrowed tax must name who holds the money",
      () => funding.openArrangement(c, {
        tax_type: "real_estate", property_id: prop, funding_method: "lender_escrow",
        effective_from: "2024-01-01", provenance_note: "n",
        escrow: { monthly_contribution_cents: USD(1250) }, user_id: uid }),
      "ESCROW_HOLDER_REQUIRED");

    await refuses("an arrangement with no provenance is refused",
      () => funding.openArrangement(c, {
        tax_type: "real_estate", property_id: prop, funding_method: "direct",
        effective_from: "2024-01-01", user_id: uid }), "PROVENANCE_REQUIRED");

    await refuses("Real Estate Tax funding cannot be recorded against a legal entity",
      () => funding.openArrangement(c, {
        tax_type: "real_estate", legal_entity_id: holdings.id,
        funding_method: "direct", effective_from: "2024-01-01",
        provenance_note: "n", user_id: uid }), "SUBJECT_REQUIRED");

    await refuses("BIRT funding cannot be recorded against the property",
      () => funding.openArrangement(c, {
        tax_type: "birt", property_id: prop, funding_method: "direct",
        effective_from: "2024-01-01", provenance_note: "n", user_id: uid }),
      "SUBJECT_REQUIRED");

    console.log("\n══ 2. THE ESCROW, ESTABLISHED ═══════════════════════════════");

    const esc = await funding.openArrangement(c, {
      tax_type: "real_estate", property_id: prop, funding_method: "lender_escrow",
      effective_from: "2024-01-01",
      escrow: { lender_name: "Berkadia", servicer_name: "Cenlar FSB",
                escrow_account_reference: "ESC-88412",
                monthly_contribution_cents: USD(1250.00) },
      source_artifact_id: escrowStmt, user_id: uid });
    ok("a lender escrow arrangement is recorded for Real Estate Tax", !!esc.id);

    //  BIRT is paid directly by the entity — a POSITIVE finding, and it
    //  must surface on the property through the entity relationship.
    await funding.openArrangement(c, {
      tax_type: "birt", legal_entity_id: holdings.id, funding_method: "direct",
      effective_from: "2024-01-01", provenance_note: "the entity pays its own BIRT",
      user_id: uid });

    await refuses("restating the same arrangement on the same date demands a correction",
      () => funding.openArrangement(c, {
        tax_type: "real_estate", property_id: prop, funding_method: "direct",
        effective_from: "2024-01-01", provenance_note: "changed my mind", user_id: uid }),
      "CORRECTION_REQUIRED");

    let f = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("the property's funding read reports two arrangements", f.arrangements.length === 2,
       JSON.stringify(f.arrangements.map((a) => a.tax_type)));
    ok("the BIRT arrangement reaches the property through its entity",
       !!f.arrangements.find((a) => a.tax_type === "birt" && a.subject_kind === "legal_entity"));
    ok("U&O and NPT are reported as UNKNOWN funding, never as 'paid directly'",
       f.unknown_for.map((u) => u.tax_type).sort().join(",") === "npt,uo",
       JSON.stringify(f.unknown_for));

    const re = () => f.arrangements.find((a) => a.tax_type === "real_estate");
    ok("the escrow names its holder and its monthly contribution",
       re().escrow.servicer_name === "Cenlar FSB"
       && re().escrow.monthly_contribution_cents === USD(1250.00));
    ok("no balance has been observed yet, and the read says null rather than zero",
       re().escrow.balance === null);

    console.log("\n══ 3. A BALANCE IS NOT A PAYMENT ════════════════════════════");

    //  MORE THAN THE BILL. This is the persuasive-wrong case: $18,400
    //  held against a $14,203 bill.
    await funding.recordEscrowObservation(c, {
      arrangement_id: esc.id, observed_on: "2026-08-01",
      balance_cents: USD(18400.00), source_artifact_id: escrowStmt, user_id: uid });

    await refuses("two statements cannot claim different balances on the same day",
      () => funding.recordEscrowObservation(c, {
        arrangement_id: esc.id, observed_on: "2026-08-01",
        balance_cents: USD(9000.00), provenance_note: "a different statement",
        user_id: uid }), "ALREADY_OBSERVED");

    f = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("the balance is reported with the day it was true",
       re().escrow.balance.balance_cents === USD(18400.00)
       && re().escrow.balance.observed_on === "2026-08-01");
    ok("the balance carries its age, so a stale figure cannot read as today's",
       re().escrow.balance.days_old === 11, String(re().escrow.balance.days_old));
    ok("the read states, in the payload, that a balance is not evidence of payment",
       /not evidence the City was paid/.test(re().escrow.balance_is_not_payment));

    let p = await position.readTaxPosition(c, { property_id: prop, as_of: AS_OF, rules });
    const reRow = () => p.rows.find((r) => r.tax_type === "real_estate");

    //  ⚠ THE ASSERTION THE WHOLE DOMAIN IS BUILT AROUND.
    ok("⚠ escrow holding MORE than the bill does NOT make the tax paid",
       reRow().state === "overdue", `state=${reRow().state}`);
    ok("the position says WHY, in words an operator can act on",
       /balance outstanding/i.test(reRow().why_not_current || ""), reRow().why_not_current);
    ok("the overall standing is overdue, not current",
       p.overall === "overdue", p.overall);

    console.log("\n══ 4. NEITHER IS THE SERVICER'S OWN DISBURSEMENT RECORD ═════");

    await refuses("a disbursement cannot be pointed at another tax's bill",
      () => funding.recordDisbursement(c, {
        arrangement_id: esc.id, obligation_id: birt2025.id,
        disbursed_on: "2026-03-28", amount_cents: USD(14203.00),
        provenance_note: "servicer statement", user_id: uid }), "OBLIGATION_MISMATCH");

    const disb = await funding.recordDisbursement(c, {
      arrangement_id: esc.id, obligation_id: re2026.id,
      disbursed_on: "2026-03-28", amount_cents: USD(14203.00),
      reference: "RE TAX DISB 03/28", source_artifact_id: escrowStmt, user_id: uid });
    ok("the servicer's disbursement is recorded as a funding fact", !!disb.id);

    p = await position.readTaxPosition(c, { property_id: prop, as_of: AS_OF, rules });
    ok("⚠ a recorded disbursement STILL does not make the tax paid",
       reRow().state === "overdue", `state=${reRow().state}`);

    f = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("the disagreement is SURFACED, not resolved",
       f.unevidenced_disbursements.length === 1
       && f.unevidenced_disbursements[0].obligation_id === re2026.id);
    ok("and it names what would resolve it",
       /City receipt|confirmation|account statement/.test(
         f.unevidenced_disbursements[0].resolves || ""));
    ok("the disbursement itself carries the flag, beside the amount",
       re().disbursements[0].city_payment_evidenced === false);

    console.log("\n══ 5. CITY EVIDENCE IS WHAT MOVES IT ════════════════════════");

    await taxes.recordPayment(c, {
      obligation_id: re2026.id, paid_at: "2026-03-30", amount_cents: USD(14203.00),
      //  Remitted by the escrow — recorded as WHO paid, evidenced by the
      //  City. The escrow is never the proof; the receipt is.
      paid_by: "lender_escrow", confirmation_reference: "PHL-2026-88412",
      source_artifact_id: cityReceipt, user_id: uid });

    p = await position.readTaxPosition(c, { property_id: prop, as_of: AS_OF, rules });
    ok("with City payment evidence the obligation finally reads paid",
       reRow().state === "paid", `state=${reRow().state}`);
    ok("and the overall standing clears",
       p.overall === "current", `${p.overall} — ${p.overall_why}`);

    f = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("the funding gap closes because the CITY side arrived, not the escrow side",
       f.unevidenced_disbursements.length === 0);
    ok("the disbursement now reports City payment evidenced",
       re().disbursements[0].city_payment_evidenced === true);

    console.log("\n══ 6. CHANGING THE CONTRIBUTION CANNOT MOVE THE ECONOMICS ═══");

    //  ⚠ THE BYTE-IDENTICAL PROOF.
    //  A servicer's escrow analysis raises the monthly contribution by
    //  $410. If one character of the tax position moves, the wall leaks.
    const before = JSON.stringify(
      await position.readTaxPosition(c, { property_id: prop, as_of: AS_OF, rules }));
    const fundingBefore = JSON.stringify(
      await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF }));

    const raised = await funding.openArrangement(c, {
      tax_type: "real_estate", property_id: prop, funding_method: "lender_escrow",
      effective_from: "2026-07-01",
      escrow: { lender_name: "Berkadia", servicer_name: "Cenlar FSB",
                escrow_account_reference: "ESC-88412",
                monthly_contribution_cents: USD(1660.00) },
      source_artifact_id: analysis, user_id: uid });
    ok("the escrow analysis opens a NEW SLICE — last year's cash stays explainable",
       !!raised.id && raised.id !== esc.id);

    const after = JSON.stringify(
      await position.readTaxPosition(c, { property_id: prop, as_of: AS_OF, rules }));
    const fundingAfter = JSON.stringify(
      await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF }));

    //  ⚠ THE FALSIFICATION GUARD. Without this, "nothing changed" would
    //  also pass if the write had silently done nothing — which is the
    //  vacuous version of this proof and reads identically.
    ok("the FUNDING read did change — so the comparison below is not vacuous",
       fundingBefore !== fundingAfter);

    ok("⚠ the tax position is BYTE-IDENTICAL after the contribution changed",
       before === after,
       before === after ? "" : firstDivergence(before, after));

    const fNow = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    const reNow = fNow.arrangements.find((a) => a.tax_type === "real_estate");
    ok("the new contribution is what the funding read now reports",
       reNow.escrow.monthly_contribution_cents === USD(1660.00));
    ok("the earlier slice is closed, not deleted",
       (await c.query(`select effective_to from tax_funding_arrangements where id = $1`,
         [esc.id])).rows[0].effective_to !== null);
    //  ── THE BALANCE SURVIVES THE SLICE ────────────────────────────
    //  It is a fact about the ESCROW ACCOUNT, not about the contribution
    //  term. Keying it to the arrangement id would blank the balance on
    //  screen every time a servicer ran an analysis — reporting as
    //  unknown something Spine plainly holds.
    ok("the balance carries across the new slice — it is the same escrow account",
       reNow.escrow.balance !== null
       && reNow.escrow.balance.balance_cents === USD(18400.00));
    ok("and it says it was observed under an earlier arrangement",
       reNow.escrow.balance.observed_under_current_arrangement === false
       && reNow.escrow.balance.observed_account_reference === "ESC-88412");
    ok("the March disbursement also survives — it is what happened to this bill",
       reNow.disbursements.length === 1
       && reNow.disbursements[0].disbursed_on === "2026-03-28");

    console.log("\n══ 7. A CORRECTION IS A DIFFERENT VERB ══════════════════════");

    await refuses("a correction with no reason is refused",
      () => funding.correctArrangement(c, {
        arrangement_id: raised.id, user_id: uid }), "REASON_REQUIRED");

    const corrected = await funding.correctArrangement(c, {
      arrangement_id: raised.id,
      revision_reason: "The servicer is Cenlar; Berkadia is the lender, not the servicer.",
      escrow: { lender_name: "Berkadia", servicer_name: "Cenlar FSB, N.A.",
                escrow_account_reference: "ESC-88412",
                monthly_contribution_cents: USD(1660.00) },
      user_id: uid });
    ok("the correction governs the same period the mistaken claim governed",
       position.isoDay(corrected.effective_from) === "2026-07-01");
    ok("the predecessor is preserved and still readable",
       (await c.query(`select id from tax_funding_arrangements where id = $1`,
         [raised.id])).rows.length === 1);

    const fCorr = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("only the successor is live",
       fCorr.arrangements.filter((a) => a.tax_type === "real_estate").length === 1);
    ok("and it says it was corrected, with the reason",
       fCorr.arrangements.find((a) => a.tax_type === "real_estate").corrected === true);

    //  A correction that does not restate the escrow must not drop it.
    const c2 = await funding.correctArrangement(c, {
      arrangement_id: corrected.id, revision_reason: "Account reference transposed.",
      user_id: uid });
    const fCarry = await fundingRead.readTaxFunding(c, { property_id: prop, as_of: AS_OF });
    ok("a correction that omits escrow detail carries the prior detail forward",
       fCarry.arrangements.find((a) => a.tax_type === "real_estate")
         .escrow.monthly_contribution_cents === USD(1660.00), JSON.stringify(c2.id));

    console.log("\n══ 8. OBSERVATIONS AND DISBURSEMENTS NEED AN ESCROW ═════════");

    const direct = (await c.query(
      `select id from tax_funding_arrangements
        where tax_type = 'birt' and funding_method = 'direct' limit 1`)).rows[0].id;

    await refuses("a balance cannot be recorded against a directly-paid tax",
      () => funding.recordEscrowObservation(c, {
        arrangement_id: direct, observed_on: "2026-08-01", balance_cents: USD(100),
        provenance_note: "n", user_id: uid }), "NOT_AN_ESCROW");

    await refuses("neither can a disbursement",
      () => funding.recordDisbursement(c, {
        arrangement_id: direct, obligation_id: birt2025.id, disbursed_on: "2026-04-10",
        amount_cents: USD(100), provenance_note: "n", user_id: uid }), "NOT_AN_ESCROW");

    await refuses("a disbursement with no amount is refused",
      () => funding.recordDisbursement(c, {
        arrangement_id: corrected.id, obligation_id: re2026.id,
        disbursed_on: "2026-03-28", provenance_note: "n", user_id: uid }), "BAD_INPUT");

    console.log("\n══ 9. THE SCHEMA HOLDS THE SAME LINES ═══════════════════════");

    await refuses("the database refuses an arrangement with two subjects",
      () => c.query(
        `insert into tax_funding_arrangements
           (tax_type, subject_property_id, subject_legal_entity_id, funding_method,
            effective_from, provenance_note, recorded_by_user_id)
         values ('real_estate',$1,$2,'direct','2027-01-01','x',$3)`,
        [prop, holdings.id, uid]));

    await refuses("the database refuses BIRT funding attached to a property",
      () => c.query(
        `insert into tax_funding_arrangements
           (tax_type, subject_property_id, funding_method, effective_from,
            provenance_note, recorded_by_user_id)
         values ('birt',$1,'direct','2027-01-01','x',$2)`, [prop, uid]));

    await refuses("the database refuses a second live arrangement for one tax",
      () => c.query(
        `insert into tax_funding_arrangements
           (tax_type, subject_property_id, funding_method, effective_from,
            provenance_note, recorded_by_user_id)
         values ('real_estate',$1,'direct','2026-07-01','x',$2)`, [prop, uid]));

    await refuses("the database refuses an escrow observation with no provenance",
      () => c.query(
        `insert into tax_escrow_observations
           (arrangement_id, observed_on, balance_cents, recorded_by_user_id)
         values ($1,'2026-09-01',100,$2)`, [corrected.id, uid]));

    await refuses("the database refuses a disbursement of zero",
      () => c.query(
        `insert into tax_escrow_disbursements
           (arrangement_id, obligation_id, disbursed_on, amount_cents,
            provenance_note, recorded_by_user_id)
         values ($1,$2,'2026-03-28',0,'x',$3)`, [corrected.id, re2026.id, uid]));

    console.log("\n══ 10. AND THE OTHER PROPERTY SEES NONE OF IT ═══════════════");

    const fOther = await fundingRead.readTaxFunding(c, { property_id: other, as_of: AS_OF });
    ok("a property with no arrangements reports established=false",
       fOther.established === false && fOther.arrangements.length === 0);
    ok("all four taxes are reported as unknown funding there",
       fOther.unknown_for.length === 4);

  } finally {
    if (c) {
      try { await c.query(`drop schema ${schema} cascade`); } catch (_) {}
      c.release();
    }
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
  if (pass + fail !== EXPECTED_ASSERTIONS) {
    console.log(`  ✗ FAIL — expected ${EXPECTED_ASSERTIONS} assertions, ran ${pass + fail}.`);
    console.log("  A suite that silently runs fewer assertions than it claims is how a");
    console.log("  green result comes to mean less than it looks like.");
    process.exit(1);
  }
  if (fail) { console.log("  ✗ FAIL"); process.exit(1); }
  console.log("  ✓ PASS — escrow funds the bill; only the City's evidence pays it.");
  console.log("════════════════════════════════════════════════════════════════");
}

function firstDivergence(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `diverges at ${i}:\n  before …${a.slice(Math.max(0, i - 60), i + 60)}\n` +
         `  after  …${b.slice(Math.max(0, i - 60), i + 60)}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
