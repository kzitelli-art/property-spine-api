/* ════════════════════════════════════════════════════════════════════
   equity_position_falsification.db.js — E1–E10 AGAINST SCHEMA AND READ.

   Same discipline as debt_schema_falsification.db.js +
   debt_position_falsification.db.js, combined into one file: the
   schema must refuse to STORE a collapsed distinction, and position()
   must refuse to HAND ONE BACK collapsed. Every fixture below is drawn
   from docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md's own cited specimens,
   which are drawn from EQUITY_SURVEY.md's real evidence — nothing here
   is invented for the test.

   TWO PROPERTIES, ON PURPOSE. Unlike Debt (one clean specimen), Equity's
   own wall doc draws its ten walls from several different deals in the
   surveyed portfolio, because no single deal exhibits all ten. P is
   4125 Chestnut (Debt's own specimen, for continuity); P2 stands in for
   1417 Skyline, whose real facts (B-Note, the Deemed Contributions
   pledge, the Lightstone/Shafran K-1 substitution, the Lincoln side
   letter, the GP pledge) supply E5, E7, E8 and E9. Using a second
   property is the honest choice — attributing Skyline's real facts to
   4125's property_id would itself violate E1.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/equity_position_falsification.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");
const svc = require("../src/asset/equity_position_service.js");
const read = require("../src/asset/equity_position_read.js");

const SCHEMA = "equity_position_proof";
const MIGRATION = path.join(__dirname, "..", "migrations", "174_equity_positions.sql");
const NE = read.NOT_ESTABLISHED;

const url = receipt.harnessConnectionString();
receipt.begin(__filename, { url, expected: 34 });

let pass = 0, fail = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const U = "11111111-1111-1111-1111-111111111111";
const P_4125 = "22222222-2222-2222-2222-222222222222";
const P_SKYLINE = "22222222-2222-2222-2222-222222222223";

//  legal_entities the fixtures reference — the id is arbitrary, the
//  NAME is what the tests assert against, matching Debt's own pattern
//  of using attributed names for the assertions that matter.
const E_MSC = "33333333-3333-3333-3333-333333333301";
const E_INTEREST_HOLDER = "33333333-3333-3333-3333-333333333302";
const E_HOLDINGS = "33333333-3333-3333-3333-333333333303";
const E_SKYLINE_MAJORITY = "33333333-3333-3333-3333-333333333304";
const ART = "44444444-4444-4444-4444-444444444444";

(async () => {
  const pool = new Pool({ connectionString: url });
  const db = await pool.connect();
  try {
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set search_path to ${SCHEMA}`);
    await db.query(`create extension if not exists pgcrypto`);
    await db.query(`create table users (id uuid primary key)`);
    await db.query(`create table properties (id uuid primary key)`);
    await db.query(`create table legal_entities (id uuid primary key)`);
    await db.query(`create table source_artifacts (id uuid primary key)`);
    for (const [t, v] of [["users", U], ["properties", P_4125], ["properties", P_SKYLINE],
                          ["legal_entities", E_MSC], ["legal_entities", E_INTEREST_HOLDER],
                          ["legal_entities", E_HOLDINGS], ["legal_entities", E_SKYLINE_MAJORITY],
                          ["source_artifacts", ART]]) {
      await db.query(`insert into ${t} values ($1)`, [v]);
    }
    await db.query(fs.readFileSync(MIGRATION, "utf8"));

    console.log("\n  ── the migration applies, and creates what it claims ──");
    const t = await db.query(
      `select table_name from information_schema.tables
        where table_schema = $1 and table_name like 'equity%' order by 1`, [SCHEMA]);
    ok("174 applies against real Postgres", t.rows.length > 0);
    ok("it creates exactly 7 equity tables", t.rows.length === 7, t.rows.map((r) => r.table_name).join(", "));

    //  ── E5, STRUCTURALLY — DEBT-SHAPED COLUMNS DO NOT EXIST ──────────
    console.log("\n  ── E5 · columns that must NOT exist ──");
    const cols = await db.query(
      `select table_name, column_name from information_schema.columns where table_schema = $1`, [SCHEMA]);
    const colSet = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const forbidden of [
      "equity_positions.interest_rate_bp", "equity_positions.maturity_date",
      "equity_positions.lien_position", "equity_preferred_terms.maturity_date",
      "equity_positions.accrued_balance_cents", "equity_preferred_terms.accrued_balance_cents",
      "equity_positions.current_ownership_percent", "equity_positions.ownership_percent",
    ]) {
      ok(`no ${forbidden} — a member loan has no home here, and accrual is never stored`,
         !colSet.has(forbidden));
    }

    /*  ══ ESTABLISH THE 4125 SPECIMEN — THROUGH THE WRITERS ═══════════ */
    console.log("\n  ── establishing 4125's capital stack through the canonical writers ──");

    const interestHolder = await svc.establishCapitalEntity(db, {
      property_id: P_4125, entity_kind: "llc_membership", legal_entity_id: E_INTEREST_HOLDER,
      tier_order: 1, effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "4125 Interest Holder LLC Operating Agreement, preamble", recorded_by_user_id: U,
    });
    const holdings = await svc.establishCapitalEntity(db, {
      property_id: P_4125, entity_kind: "llc_membership", legal_entity_id: E_HOLDINGS,
      tier_order: 2, effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "4125 Chestnut Holdings LLC Operating Agreement, preamble", recorded_by_user_id: U,
    });

    const msc = await svc.addPosition(db, {
      capital_entity_id: interestHolder.id, position_kind: "preferred_class",
      legal_entity_id: E_MSC, effective_from: "2020-07-31",
      source_artifact_id: ART, provenance_note: "Interest Holder OA, MSC's admission",
      recorded_by_user_id: U,
    });

    //  ⚠ E2 — TWO rows, same position, disagreeing compounding, each
    //  with its own source_authority. Real: OA §1.60 vs. the servicer's
    //  own HoldCo Pay Schedule header.
    await svc.addPreferredTerms(db, {
      position_id: msc.id, term_source: "governing_document", source_authority: "governed_read",
      rate_bp: 1250, rate_convention_as_stated: "compounded quarterly, determined on an actual/360 basis",
      compounding: "quarterly",
      make_whole_text: "145% of MSC's Capital Contribution, over distributions received; not discounted to present value",
      redemption_terms_text: "Company election, 90-30 days notice, $500,000 minimum partial; " +
        "if not fully redeemed by the 7th anniversary (2027-07-31), MSC gains sole authority to sell or refinance",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA §1.60, §1.42, §4.7", recorded_by_user_id: U,
    });
    await svc.addPreferredTerms(db, {
      position_id: msc.id, term_source: "governing_document", source_authority: "tracker_claim",
      rate_bp: 1250, rate_convention_as_stated: "Compounding Monthly (per the tracker's own header)",
      compounding: "monthly",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "4125 Chestnut HoldCo Pay Schedule, header row", recorded_by_user_id: U,
    });

    //  ⚠ E4 — FOUR disagreeing sources for the same contribution.
    await svc.addContributionClaim(db, {
      position_id: msc.id, claim_source: "governing_document", amount_cents: 250000000,
      as_of_date: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA, MSC capital contribution", recorded_by_user_id: U,
    });
    await svc.addContributionClaim(db, {
      position_id: msc.id, claim_source: "accounting_record", amount_cents: 250000000,
      as_of_date: "2025-12-31", source_artifact_id: ART,
      provenance_note: "Uno on Chestnut Trial Balance Dec 2025, account 3450-01", recorded_by_user_id: U,
    });
    await svc.addContributionClaim(db, {
      position_id: msc.id, claim_source: "tracker", amount_cents: 289209489,
      as_of_date: "2024-12-31", source_artifact_id: ART,
      provenance_note: "4125 Chestnut HoldCo Pay Schedule, ending balance", recorded_by_user_id: U,
    });
    await svc.addContributionClaim(db, {
      position_id: msc.id, claim_source: "tracker", amount_cents: 370000000,
      as_of_date: "2026-03-30", source_artifact_id: ART,
      provenance_note: "Rob Vernicek, internal note: \"their interest plus preferred accrual is about $3.7MM\"",
      recorded_by_user_id: U,
    });

    //  ⚠ E1/E10 — Holdings' common tier: the entity is established; its
    //  members are not. Zero position rows, on purpose.
    await svc.recordExposure(db, {
      property_id: P_4125, capital_entity_id: holdings.id,
      what_text: "4125 Chestnut Holdings LLC's common membership — the 77.57% common tier, " +
        "$9,048,350 total per the ownership chain, believed distributed among UPenn Apartments LLC, " +
        "EquityMultiple 80 LLC, Talisen 1849 LLC, FPP 1 LLC and other investors",
      magnitude_cents: 904835000,
      magnitude_basis_text: "stated total per the Interest Holder LLC chain, not a per-holder breakdown",
      why_unresolved_text: "Holdings LLC Schedule I reads '[OWNERSHIP/INVESTOR INFORMATION " +
        "MAINTAINED BY MANAGING MEMBER]' — the register it defers to has not been produced anywhere retained",
      resolution_text: "obtain the actual member register from the Managing Member",
      as_of_date: "2026-08-15", source_artifact_id: ART, recorded_by_user_id: U,
    });
    //  A second, distinct Exposure: Holdings' own 6% pref return exists
    //  on paper but cannot be attached to any position, because the
    //  positions it would attach to are themselves Exposure above.
    await svc.recordExposure(db, {
      property_id: P_4125, capital_entity_id: holdings.id,
      what_text: "Holdings LLC's own 6.0% monthly-compounding preferred return (per its Operating " +
        "Agreement) cannot be attached to any specific holder position",
      why_unresolved_text: "the common holders it would apply to are not established (see the " +
        "membership Exposure above); no Holdings-level accrual schedule, capital account statement, " +
        "or preferred calculation was found in any retained source",
      as_of_date: "2026-08-15", source_artifact_id: ART, recorded_by_user_id: U,
    });

    /*  ══ SKYLINE FIXTURES — E5, E7, E8, E9 ════════════════════════════ */
    console.log("\n  ── establishing Skyline fixtures for E5/E7/E8/E9 ──");
    const skylineMajority = await svc.establishCapitalEntity(db, {
      property_id: P_SKYLINE, entity_kind: "lp_interest", legal_entity_id: E_SKYLINE_MAJORITY,
      tier_order: 1, effective_from: "2017-06-01", source_artifact_id: ART,
      provenance_note: "Second A&R LP Agreement, Exhibit A", recorded_by_user_id: U,
    });
    const shafran = await svc.addPosition(db, {
      capital_entity_id: skylineMajority.id, position_kind: "common",
      party_name_text: "Joel Shafran", effective_from: "2017-06-01",
      source_artifact_id: ART, provenance_note: "Skyline Minority Schedule I", recorded_by_user_id: U,
    });

    //  ⚠ E7 — the 2024 K-1 names a different holder with NO assignment
    //  on file. This must be a CONFLICT, never a silent supersession.
    await svc.recordConflict(db, {
      property_id: P_SKYLINE, position_id: shafran.id, conflict_kind: "holder_identity",
      claim_a_text: "Schedule I: Joel Shafran, 25% of Skyline Minority",
      claim_a_source_artifact_id: ART,
      claim_b_text: "2024 K-1 issued to Aryeh Lightstone in the same 25% slot — no assignment, " +
        "no GP consent, no amended Schedule I found; LPA §10.2(b) deems such transfers void",
      claim_b_source_artifact_id: ART,
      noted_as_of: "2025-04-01", recorded_by_user_id: U,
    });

    //  ⚠ E9 — the GP's own interest, pledged.
    const skylineGp = await svc.addPosition(db, {
      capital_entity_id: skylineMajority.id, position_kind: "common",
      party_name_text: "Skyline Apartments GP LLC", effective_from: "2017-06-01",
      source_artifact_id: ART, provenance_note: "Exhibit A, GP interest", recorded_by_user_id: U,
    });
    await svc.addPledge(db, {
      position_id: skylineGp.id, pledgee_name_text: "Lender (Pledge and Security Agreement)",
      pledge_description: "GP interest pledged as collateral, September 2025",
      effective_from: "2025-09-04", source_artifact_id: ART,
      provenance_note: "Pledge and Security Agreement - Skyline Apartments GP LLC", recorded_by_user_id: U,
    });

    //  ⚠ E8 — a side letter overriding ONE holder's waterfall, layered
    //  over the deal-level terms, never replacing them.
    const lincoln = await svc.addPosition(db, {
      capital_entity_id: skylineMajority.id, position_kind: "common",
      party_name_text: "Lincoln Extend Adj", effective_from: "2017-06-01",
      source_artifact_id: ART, provenance_note: "Skyline Note Owner Schedule I", recorded_by_user_id: U,
    });
    await svc.addPreferredTerms(db, {
      position_id: lincoln.id, term_source: "governing_document", source_authority: "governed_read",
      waterfall_priority_text: "65/35 to the General Partner (deal-level, §7.3(a))",
      effective_from: "2017-06-01", source_artifact_id: ART,
      provenance_note: "Second A&R LP Agreement §7.3(a)", recorded_by_user_id: U,
    });
    await svc.addPreferredTerms(db, {
      position_id: lincoln.id, term_source: "side_letter", source_authority: "governed_read",
      waterfall_priority_text: "100% of amounts payable as though paid in proportion to Percentage " +
        "Interests — exempting this holder from the promote",
      effective_from: "2017-06-01", source_artifact_id: ART,
      provenance_note: "Lincoln side letter, draft — counsel: \"consistent with how we've handled " +
        "this in the past\"", recorded_by_user_id: U,
    });

    //  ⚠ E6 — the same dollars, debt in one document, equity in another.
    //  No position row on the equity side yet — the conflict is
    //  property-scoped and stands on its own.
    await svc.recordConflict(db, {
      property_id: P_SKYLINE, conflict_kind: "characterization_debt_vs_equity",
      claim_a_text: "1417 Note Purchase - Summary.docx: \"$338,050 ... re-contributed as equity in " +
        "Skyline Note Owner LLC\"",
      claim_a_source_artifact_id: ART,
      claim_b_text: "Carlisle Street Partners LP trial balance: account 2525 'Loan from Shafran " +
        "$338,000.00' — a liability, $50 off the equity-side figure",
      claim_b_source_artifact_id: ART,
      noted_as_of: "2025-12-01", recorded_by_user_id: U,
    });

    /*  ══ NOW READ IT BACK — E1 THROUGH E10 ═══════════════════════════ */
    const hist4125 = await svc.loadHistory(db, P_4125);
    const pos4125 = read.position(hist4125, "2026-08-15");
    const blob4125 = JSON.stringify(pos4125);

    console.log("\n  ── E1 · a redacted schedule is Exposure, never a guessed holder ──");
    const holdingsRead = pos4125.capital_entities.find((e) => e.capital_entity_id === holdings.id);
    ok("Holdings LLC is established as an entity", !!holdingsRead);
    ok("...with ZERO named positions — never backfilled", holdingsRead.positions.length === 0);
    ok("...and its redaction is recorded as Exposure, not silence",
       pos4125.exposure.some((x) => /MAINTAINED BY MANAGING MEMBER/.test(x.why_unresolved)));

    console.log("\n  ── E2 · disagreeing sources, both returned, never merged ──");
    const mscRead = pos4125.capital_entities
      .find((e) => e.capital_entity_id === interestHolder.id).positions
      .find((p) => p.position_id === msc.id);
    ok("MSC's terms carry BOTH compounding claims", mscRead.preferred_terms.length === 2);
    ok("...quarterly from governed_read", mscRead.preferred_terms.some(
       (t) => t.source_authority === "governed_read" && t.compounding === "quarterly"));
    ok("...monthly from tracker_claim", mscRead.preferred_terms.some(
       (t) => t.source_authority === "tracker_claim" && t.compounding === "monthly"));
    ok("no single unqualified \"compounding\" field exists in the blob",
       !/"compounding":"(monthly|quarterly)"[^{]*"compounding"/.test(blob4125.replace(/\s/g, "")));

    console.log("\n  ── E3 · accrual is never computed, ever ──");
    ok("MSC's accrued preferred return is NOT_ESTABLISHED",
       mscRead.accrued_preferred_return.truth_state === NE);
    ok("...and no dollar figure claims to BE the accrual",
       !/"accrued_preferred_return":\{"truth_state":"NOT_ESTABLISHED"[^}]*value/.test(blob4125));

    console.log("\n  ── E4 · four disagreeing contribution claims, none a winner ──");
    ok("MSC's contribution_claims carries governing_document, accounting_record AND tracker",
       new Set(mscRead.contribution_claims.map((c) => c.claim_source)).size === 3);
    const trackerClaim = mscRead.contribution_claims.find((c) => c.claim_source === "tracker");
    ok("the tracker source shows its LATEST claim (Vernicek's $3.7MM), not an earlier one",
       trackerClaim.amount_cents === 370000000);
    ok("the governing-document claim is untouched at $2,500,000",
       mscRead.contribution_claims.find((c) => c.claim_source === "governing_document").amount_cents === 250000000);

    console.log("\n  ── E9 · Skyline GP's pledge, and absence elsewhere ──");
    const histSkyline = await svc.loadHistory(db, P_SKYLINE);
    const posSkyline = read.position(histSkyline, "2026-08-15");
    const skylineEntity = posSkyline.capital_entities.find((e) => e.capital_entity_id === skylineMajority.id);
    const gpRead = skylineEntity.positions.find((p) => p.position_id === skylineGp.id);
    const shafranRead = skylineEntity.positions.find((p) => p.position_id === shafran.id);
    ok("the GP's interest shows its real pledge", Array.isArray(gpRead.encumbrance) && gpRead.encumbrance.length === 1);
    ok("...naming the actual pledgee, not a boolean flag",
       typeof gpRead.encumbrance[0].pledgee_name_text === "string"
       && gpRead.encumbrance[0].pledgee_name_text.includes("Lender"));
    ok("Shafran's position — no pledge recorded — reads NOT_ESTABLISHED, never \"unencumbered\"",
       shafranRead.encumbrance.truth_state === NE);

    console.log("\n  ── E7 · a K-1 substitution with no assignment is a conflict, not a transfer ──");
    ok("Shafran remains the standing holder of record", shafranRead.holder.party_name_text === "Joel Shafran");
    ok("...while the Lightstone substitution is a surfaced conflict",
       posSkyline.conflicts.some((c) => c.conflict_kind === "holder_identity" && /Lightstone/.test(c.claim_b)));

    console.log("\n  ── E8 · a side letter layers over the deal waterfall, never replaces it ──");
    const lincolnRead = skylineEntity.positions.find((p) => p.position_id === lincoln.id);
    ok("Lincoln's terms carry BOTH the deal-level and the side-letter waterfall",
       lincolnRead.preferred_terms.length === 2);
    ok("...the deal-level 65/35 survives, untouched",
       lincolnRead.preferred_terms.some((t) => t.term_source === "governing_document"
         && /65\/35/.test(t.waterfall_priority_text)));
    ok("...and the side letter is its own row, not a mutation of the first",
       lincolnRead.preferred_terms.some((t) => t.term_source === "side_letter"
         && /exempting this holder/.test(t.waterfall_priority_text)));

    console.log("\n  ── E6 · the same dollars, debt in one document and equity in another ──");
    ok("the characterization conflict is recorded property-wide, no position forced onto either side",
       posSkyline.conflicts.some((c) => c.conflict_kind === "characterization_debt_vs_equity"
         && /Loan from Shafran/.test(c.claim_b) && /re-contributed as equity/.test(c.claim_a)));

    console.log("\n  ── the standing projection stays honest at scale ──");
    const standing4125 = read.standingProjection(pos4125);
    ok("4125's standing shows 2 capital entities, 1 named position, 2 exposure items",
       standing4125.capital_entity_count === 2 && standing4125.named_holder_count === 1
       && standing4125.exposure_item_count === 2);
    ok("...and next_milestone points at Exposure, never claims completeness",
       standing4125.next_milestone === "resolve the largest recorded Exposure item");

    //  ── as_of is a reading, not a freshness claim ──
    console.log("\n  ── as_of is a reading, not a freshness claim ──");
    const beforeEstablishment = read.position(hist4125, "2019-01-01");
    ok("reading before the entities existed sees nothing established",
       beforeEstablishment.capital_entities.length === 0);

    await db.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    db.release(); await pool.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  db.release();
  await pool.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 34 }));
})();
