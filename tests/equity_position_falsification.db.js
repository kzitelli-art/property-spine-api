/* ════════════════════════════════════════════════════════════════════
   equity_position_falsification.db.js — E1–E10 AND THE ROUND-4
   STRUCTURAL RULINGS, AGAINST SCHEMA AND READ.

   Same discipline as debt_schema_falsification.db.js +
   debt_position_falsification.db.js, combined into one file: the
   schema must refuse to STORE a collapsed distinction, and position()
   must refuse to HAND ONE BACK collapsed. Every fixture below is drawn
   from docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md's own cited specimens,
   which are drawn from EQUITY_SURVEY.md's real evidence — nothing here
   is invented for the test.

   THIS FILE PROVES FIVE FROZEN STRUCTURAL RULINGS, NOT JUST E1–E10:
     1  ONE shared capital_stack_positions identity holds both MSC
        (preferred) and Holdings (common) at the same issuer — no
        position_kind base-table split.
     2  Skyline's 7.5% pro-rata preferred return AND its 65/35 waterfall
        default are recorded ONCE at the issuer, never duplicated onto
        Shafran's or the GP's own position.
     3  Lincoln's side-letter override is recorded, but because it is
        unexecuted, position() refuses to apply it — the deal-level
        65/35 remains the operative reading for every common holder.
     4  MSC's Minimum Dividend schedule is observed and stored, but its
        relationship to the 12.5% preferred return stays
        NOT_ESTABLISHED — never guessed from the schedule's own shape.
     5  no capital_stack_exposure table exists — Holdings' own unnamed
        common tier and MSC's unresolved Minimum Dividend relationship
        both surface as DERIVED coverage_gaps, not stored rows.

   TWO PROPERTIES, ON PURPOSE. Unlike Debt (one clean specimen), Equity's
   own wall doc draws its ten walls from several different deals in the
   surveyed portfolio, because no single deal exhibits all ten. P is
   4125 Chestnut (Debt's own specimen, for continuity); P2 stands in for
   1417 Skyline, whose real facts (B-Note, the Deemed Contributions
   pledge, the Lightstone/Shafran K-1 substitution, the Lincoln side
   letter, the GP pledge) supply E5, E7, E8 and E9.

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
receipt.begin(__filename, { url, expected: 58 });

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
    await db.query(`create table legal_entities (id uuid primary key, legal_name text not null)`);
    await db.query(`create table source_artifacts (id uuid primary key)`);
    for (const [t, v] of [["users", U], ["properties", P_4125], ["properties", P_SKYLINE],
                          ["source_artifacts", ART]]) {
      await db.query(`insert into ${t} values ($1)`, [v]);
    }
    for (const [id, legalName] of [
      [E_MSC, "MSC 4125 Chestnut LLC"],
      [E_INTEREST_HOLDER, "4125 Chestnut Interest Holder LLC"],
      [E_HOLDINGS, "4125 Chestnut Holdings LLC"],
      [E_SKYLINE_MAJORITY, "Skyline Majority Member LLC"],
    ]) {
      await db.query(`insert into legal_entities (id, legal_name) values ($1, $2)`, [id, legalName]);
    }
    await db.query(fs.readFileSync(MIGRATION, "utf8"));

    console.log("\n  ── the migration applies, and creates what it claims ──");
    const EXPECTED_TABLES = ["capital_stack_positions", "common_equity_class_terms",
      "common_equity_position_overrides", "preferred_equity_terms",
      "capital_stack_pledges", "capital_amount_claims", "capital_stack_conflicts"];
    const t = await db.query(
      `select table_name from information_schema.tables
        where table_schema = $1 and table_name = any($2::text[]) order by 1`,
      [SCHEMA, EXPECTED_TABLES]);
    ok("174 applies against real Postgres", t.rows.length > 0);
    ok("it creates exactly the 7 governed tables Round 4 froze",
       t.rows.length === 7, t.rows.map((r) => r.table_name).join(", "));

    //  ── E5, STRUCTURALLY — DEBT-SHAPED COLUMNS DO NOT EXIST ──────────
    //  Also proves the self-discovered tier_order bug is actually fixed:
    //  no entities table, no tier_order column, anywhere.
    console.log("\n  ── E5 · columns that must NOT exist, including the retired tier_order ──");
    const cols = await db.query(
      `select table_name, column_name from information_schema.columns where table_schema = $1`, [SCHEMA]);
    const colSet = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const forbidden of [
      "capital_stack_positions.interest_rate_bp", "capital_stack_positions.maturity_date",
      "capital_stack_positions.lien_position", "preferred_equity_terms.maturity_date",
      "capital_stack_positions.accrued_balance_cents", "preferred_equity_terms.accrued_balance_cents",
      "capital_stack_positions.tier_order", "capital_stack_positions.current_ownership_percent",
    ]) {
      ok(`no ${forbidden} — a member loan has no home here, tier_order never stands in for ownership`,
         !colSet.has(forbidden));
    }
    ok("there is no equity_capital_entities table — the tier chain is positions, not a hierarchy table",
       !(await db.query(
         `select 1 from information_schema.tables where table_schema=$1 and table_name='equity_capital_entities'`,
         [SCHEMA])).rows.length);
    ok("there is no capital_stack_exposure table — coverage gaps are derived, never stored",
       !(await db.query(
         `select 1 from information_schema.tables where table_schema=$1 and table_name='capital_stack_exposure'`,
         [SCHEMA])).rows.length);

    /*  ══ ESTABLISH THE 4125 SPECIMEN — THROUGH THE WRITERS ═══════════
     *  Ruling 1: MSC (preferred) and Holdings (common) are BOTH rows in
     *  ONE shared table, same issuer, distinguished only by
     *  position_class — never a base-table split.                    */
    console.log("\n  ── establishing 4125's capital stack — one shared identity, two classes ──");

    const msc = await svc.addPosition(db, {
      property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER, position_class: "preferred",
      holder_legal_entity_id: E_MSC, effective_from: "2020-07-31",
      source_artifact_id: ART, provenance_note: "Interest Holder OA, MSC's admission",
      recorded_by_user_id: U,
    });
    const holdings = await svc.addPosition(db, {
      property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER, position_class: "common",
      holder_legal_entity_id: E_HOLDINGS, effective_from: "2020-07-31",
      source_artifact_id: ART, provenance_note: "Interest Holder OA, Holdings' admission",
      recorded_by_user_id: U,
    });

    //  ⚠ Ruling 1 proof, at the storage level — both rows really are in
    //  the same table.
    const bothInOneTable = await db.query(
      `select position_class from capital_stack_positions where id = any($1::uuid[]) order by position_class`,
      [[msc.id, holdings.id]]);
    ok("MSC and Holdings are two rows in ONE shared capital_stack_positions table",
       bothInOneTable.rows.length === 2
       && bothInOneTable.rows[0].position_class === "common"
       && bothInOneTable.rows[1].position_class === "preferred");

    //  Holdings' known 77.57% ownership of Interest Holder LLC — kept
    //  as a SEPARATE fact from the contribution amount, per the
    //  standing decoupling ruling.
    await svc.addCapitalAmountClaim(db, {
      position_id: holdings.id, claim_source: "governing_document", ownership_percent: 77.57,
      as_of_date: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA, Schedule I percentage interests", recorded_by_user_id: U,
    });
    await svc.addCapitalAmountClaim(db, {
      position_id: holdings.id, claim_source: "governing_document", amount_cents: 904835000,
      as_of_date: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA, Holdings' stated capital contribution", recorded_by_user_id: U,
    });

    //  ⚠ E2 — TWO disagreeing preferred-terms rows for the SAME current-
    //  pay rate, real: OA §1.60 vs. the servicer's own HoldCo Pay
    //  Schedule header.
    await svc.addPreferredTerms(db, {
      position_id: msc.id, term_source: "governing_document", source_authority: "governed_read",
      current_pay_rate_bp: 1250,
      rate_convention_as_stated: "compounded quarterly, determined on an actual/360 basis",
      compounding: "quarterly",
      make_whole_text: "145% of MSC's Capital Contribution, over distributions received; not discounted to present value",
      redemption_terms_text: "Company election, 90-30 days notice, $500,000 minimum partial; " +
        "if not fully redeemed by the 7th anniversary (2027-07-31), MSC gains sole authority to sell or refinance",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA §1.60, §1.42, §4.7", recorded_by_user_id: U,
    });
    await svc.addPreferredTerms(db, {
      position_id: msc.id, term_source: "governing_document", source_authority: "tracker_claim",
      current_pay_rate_bp: 1250, rate_convention_as_stated: "Compounding Monthly (per the tracker's own header)",
      compounding: "monthly",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "4125 Chestnut HoldCo Pay Schedule, header row", recorded_by_user_id: U,
    });

    //  ⚠ Ruling 4 / THE MSC DEFERRAL — a THIRD, separately-sourced row:
    //  the Minimum Dividend schedule the survey paraphrases, never
    //  merged with the OA's own current-pay rate row above, and its
    //  relationship left at the schema's own default.
    await svc.addPreferredTerms(db, {
      position_id: msc.id, term_source: "secondary_summary", source_authority: "secondary_summary",
      minimum_dividend_schedule_text:
        "8% → 9% → 10% → 11% → 12% → 12.5%, stepped over the investment's early years " +
        "(per the portfolio survey's paraphrase of OA §1.49 — the clause itself has not been read)",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "portfolio equity survey, MSC Minimum Dividend summary — not OA §1.49 itself",
      recorded_by_user_id: U,
    });

    //  ⚠ E4 + THE VERNICEK FIX — FOUR disagreeing sources for the same
    //  contribution, `internal_note` now a real slot instead of being
    //  forced into `tracker`.
    await svc.addCapitalAmountClaim(db, {
      position_id: msc.id, claim_source: "governing_document", amount_cents: 250000000,
      as_of_date: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Interest Holder OA, MSC capital contribution", recorded_by_user_id: U,
    });
    await svc.addCapitalAmountClaim(db, {
      position_id: msc.id, claim_source: "accounting_record", amount_cents: 250000000,
      as_of_date: "2025-12-31", source_artifact_id: ART,
      provenance_note: "Uno on Chestnut Trial Balance Dec 2025, account 3450-01", recorded_by_user_id: U,
    });
    await svc.addCapitalAmountClaim(db, {
      position_id: msc.id, claim_source: "tracker", amount_cents: 289209489,
      as_of_date: "2024-12-31", source_artifact_id: ART,
      provenance_note: "4125 Chestnut HoldCo Pay Schedule, ending balance", recorded_by_user_id: U,
    });
    await svc.addCapitalAmountClaim(db, {
      position_id: msc.id, claim_source: "internal_note", asserted_by_text: "Rob Vernicek",
      amount_cents: 370000000, as_of_date: "2026-03-30", source_artifact_id: ART,
      provenance_note: "internal note: \"their interest plus preferred accrual is about $3.7MM\"",
      recorded_by_user_id: U,
    });

    //  ⚠ Holdings LLC's OWN common tier (one level up the chain) — its
    //  6.0% pro-rata pref return is governed, but the chain emerges
    //  from POSITIONS: no position names a member of Holdings LLC
    //  itself, so this is now a DERIVED gap, never a stored Exposure
    //  row.
    await svc.addCommonClassTerms(db, {
      property_id: P_4125, issuer_legal_entity_id: E_HOLDINGS,
      term_source: "governing_document", source_authority: "governed_read",
      rate_bp: 600, compounding: "monthly",
      effective_from: "2020-07-31", source_artifact_id: ART,
      provenance_note: "Holdings LLC Operating Agreement §1.44; Schedule I: " +
        "\"[OWNERSHIP/INVESTOR INFORMATION MAINTAINED BY MANAGING MEMBER]\"",
      recorded_by_user_id: U,
    });

    /*  ══ SKYLINE FIXTURES — E5, E7, E8, E9, Rulings 2 & 3 ═══════════ */
    console.log("\n  ── establishing Skyline fixtures — entity-level pref, Lincoln's unexecuted override ──");

    //  ⚠ Ruling 2 — the 7.5% pro-rata preferred return AND the deal's
    //  65/35 default waterfall are recorded ONCE, at the issuer.
    await svc.addCommonClassTerms(db, {
      property_id: P_SKYLINE, issuer_legal_entity_id: E_SKYLINE_MAJORITY,
      term_source: "governing_document", source_authority: "governed_read",
      rate_bp: 750, compounding: "unstated",
      waterfall_priority_text: "65/35 to the General Partner (deal-level, §7.3(a))",
      effective_from: "2017-06-01", source_artifact_id: ART,
      provenance_note: "Second A&R LP Agreement §7.3(a), §4.2 (7.5% pro-rata preferred return)",
      recorded_by_user_id: U,
    });

    const shafran = await svc.addPosition(db, {
      property_id: P_SKYLINE, issuer_legal_entity_id: E_SKYLINE_MAJORITY, position_class: "common",
      holder_name_text: "Joel Shafran", effective_from: "2017-06-01",
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
      property_id: P_SKYLINE, issuer_legal_entity_id: E_SKYLINE_MAJORITY, position_class: "common",
      holder_name_text: "Skyline Apartments GP LLC", effective_from: "2017-06-01",
      source_artifact_id: ART, provenance_note: "Exhibit A, GP interest", recorded_by_user_id: U,
    });
    await svc.addPledge(db, {
      position_id: skylineGp.id, pledgee_name_text: "Lender (Pledge and Security Agreement)",
      pledge_description: "GP interest pledged as collateral, September 2025",
      effective_from: "2025-09-04", source_artifact_id: ART,
      provenance_note: "Pledge and Security Agreement - Skyline Apartments GP LLC", recorded_by_user_id: U,
    });

    //  ⚠ Ruling 3, THE CENTRAL PROOF — Lincoln's override is a real,
    //  dated, sourced row, and it is UNEXECUTED (counsel's own framing
    //  is a draft: "consistent with how we've handled this in the
    //  past" — no signature, no execution date found anywhere in the
    //  survey). It must be recorded and it must NOT be applied.
    const lincoln = await svc.addPosition(db, {
      property_id: P_SKYLINE, issuer_legal_entity_id: E_SKYLINE_MAJORITY, position_class: "common",
      holder_name_text: "Lincoln Extend Adj", effective_from: "2017-06-01",
      source_artifact_id: ART, provenance_note: "Skyline Note Owner Schedule I", recorded_by_user_id: U,
    });
    await svc.addPositionOverride(db, {
      position_id: lincoln.id, override_kind: "promote_exemption",
      override_text: "100% of amounts payable as though paid in proportion to Percentage " +
        "Interests — exempting this holder from the promote",
      execution_status: "draft_unexecuted", source_authority: "governed_read",
      effective_from: "2017-06-01", source_artifact_id: ART,
      provenance_note: "Lincoln side letter, draft — counsel: \"consistent with how we've handled " +
        "this in the past\"", recorded_by_user_id: U,
    });

    //  ⚠ E6 — the same dollars, debt in one document, equity in
    //  another. No position row on the equity side yet — the conflict
    //  is property-scoped and stands on its own.
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

    /*  ══ HOSTILE FIXTURES — THE SCHEMA REFUSES TO STORE THE COLLAPSE ═ */
    console.log("\n  ── the schema itself refuses an executed override with no execution_date ──");
    let executedNoDateFailed = false;
    try {
      await db.query(
        `insert into common_equity_position_overrides
           (position_id, override_kind, override_text, execution_status, execution_date,
            term_source, source_authority, effective_from, recorded_by_user_id)
         values ($1,'other','test','executed',null,'side_letter','governed_read','2020-01-01',$2)`,
        [lincoln.id, U]);
    } catch (e) { executedNoDateFailed = true; }
    ok("an 'executed' override with no execution_date is refused at the DB layer",
       executedNoDateFailed);

    console.log("\n  ── the writer refuses a capital amount claim stating both amount AND percent ──");
    let bothValuesFailed = false;
    try {
      await svc.addCapitalAmountClaim(db, {
        position_id: holdings.id, claim_source: "tracker", amount_cents: 100, ownership_percent: 1,
        as_of_date: "2026-01-01", recorded_by_user_id: U,
      });
    } catch (e) { bothValuesFailed = e.code === "EQUITY_CLAIM_EXACTLY_ONE_VALUE"; }
    ok("amount_cents and ownership_percent are refused together — they are separate facts",
       bothValuesFailed);

    console.log("\n  ── weak evidence cannot establish an ambiguous economic mechanic ──");
    let ungovernedRelationshipFailed = false;
    try {
      await svc.addPreferredTerms(db, {
        position_id: msc.id, term_source: "secondary_summary",
        source_authority: "secondary_summary", current_pay_rate_bp: 1250,
        minimum_dividend_schedule_text: "8% to 12.5%",
        minimum_dividend_relationship_to_preferred_return: "additive",
        effective_from: "2020-07-31", source_artifact_id: ART,
        recorded_by_user_id: U,
      });
    } catch (e) {
      ungovernedRelationshipFailed =
        e.code === "EQUITY_MINIMUM_DIVIDEND_RELATIONSHIP_UNGOVERNED";
    }
    ok("a secondary summary cannot turn MSC's open Minimum Dividend relationship into 'additive'",
       ungovernedRelationshipFailed);

    console.log("\n  ── a spoken estimate must retain who said it ──");
    let unattributedInternalNoteFailed = false;
    try {
      await svc.addCapitalAmountClaim(db, {
        position_id: msc.id, claim_source: "internal_note", amount_cents: 370000000,
        as_of_date: "2026-03-30", source_artifact_id: ART, recorded_by_user_id: U,
      });
    } catch (e) {
      unattributedInternalNoteFailed =
        e.code === "EQUITY_INTERNAL_NOTE_ATTRIBUTION_REQUIRED";
    }
    ok("an internal-note amount without a named speaker is refused",
       unattributedInternalNoteFailed);

    console.log("\n  ── subtype terms cannot be attached to the other position class ──");
    let preferredOnCommonFailed = false;
    try {
      await svc.addPreferredTerms(db, {
        position_id: holdings.id, term_source: "governing_document",
        source_authority: "governed_read", current_pay_rate_bp: 1250,
        effective_from: "2020-07-31", source_artifact_id: ART,
        recorded_by_user_id: U,
      });
    } catch (e) {
      preferredOnCommonFailed = e.code === "EQUITY_POSITION_CLASS_MISMATCH";
    }
    ok("preferred terms cannot be attached to Holdings' common position",
       preferredOnCommonFailed);

    let commonOverrideOnPreferredFailed = false;
    try {
      await svc.addPositionOverride(db, {
        position_id: msc.id, override_kind: "other", override_text: "not applicable",
        execution_status: "draft_unexecuted", source_authority: "governed_read",
        effective_from: "2020-07-31", source_artifact_id: ART,
        recorded_by_user_id: U,
      });
    } catch (e) {
      commonOverrideOnPreferredFailed = e.code === "EQUITY_POSITION_CLASS_MISMATCH";
    }
    ok("common holder overrides cannot be attached to MSC's preferred position",
       commonOverrideOnPreferredFailed);

    console.log("\n  ── no Equity fact is written without provenance ──");
    let unsourcedPositionFailed = false;
    try {
      await svc.addPosition(db, {
        property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER,
        position_class: "common", holder_name_text: "UNSOURCED HOLDER",
        effective_from: "2026-01-01", recorded_by_user_id: U,
      });
    } catch (e) {
      unsourcedPositionFailed = e.code === "EQUITY_PROVENANCE_REQUIRED";
    }
    ok("an unsourced capital-stack position is refused", unsourcedPositionFailed);

    let crossPropertySupersessionFailed = false;
    try {
      await svc.addPosition(db, {
        property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER,
        position_class: "common", holder_name_text: "FALSE SUCCESSOR",
        effective_from: "2026-01-01", supersedes_position_id: skylineGp.id,
        source_artifact_id: ART, recorded_by_user_id: U,
      });
    } catch (e) {
      crossPropertySupersessionFailed = e.code === "EQUITY_POSITION_SUPERSESSION_MISMATCH";
    }
    ok("a position cannot supersede a different property's capital-stack position",
       crossPropertySupersessionFailed);

    let ungovernedSupersessionFailed = false;
    try {
      await svc.addPosition(db, {
        property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER,
        position_class: "common", holder_name_text: "UNPROVEN SUCCESSOR",
        effective_from: "2026-01-01", supersedes_position_id: holdings.id,
        provenance_note: "someone said ownership changed", recorded_by_user_id: U,
      });
    } catch (e) {
      ungovernedSupersessionFailed =
        e.code === "EQUITY_POSITION_SUPERSESSION_UNGOVERNED";
    }
    ok("a holder supersession without its transfer artifact is refused",
       ungovernedSupersessionFailed);

    console.log("\n  ── a governed transfer retires, rather than duplicates, the prior holder ──");
    const successor = await svc.addPosition(db, {
      property_id: P_4125, issuer_legal_entity_id: E_INTEREST_HOLDER,
      position_class: "common", holder_name_text: "Successor Holdings LLC",
      effective_from: "2027-01-01", supersedes_position_id: holdings.id,
      source_artifact_id: ART, provenance_note: "executed assignment",
      recorded_by_user_id: U,
    });
    const beforeTransfer = read.position(await svc.loadHistory(db, P_4125), "2026-12-31");
    const afterTransfer = read.position(await svc.loadHistory(db, P_4125), "2027-01-01");
    ok("the recorded holder remains current before the assignment's effective date",
       beforeTransfer.positions.some((p) => p.position_id === holdings.id)
       && !beforeTransfer.positions.some((p) => p.position_id === successor.id));
    ok("the successor replaces the prior holder on the assignment's effective date",
       afterTransfer.positions.some((p) => p.position_id === successor.id)
       && !afterTransfer.positions.some((p) => p.position_id === holdings.id));

    let crossPropertyConflictFailed = false;
    try {
      await svc.recordConflict(db, {
        property_id: P_4125, position_id: skylineGp.id,
        conflict_kind: "holder_identity",
        claim_a_text: "4125 claim", claim_a_source_artifact_id: ART,
        claim_b_text: "Skyline claim", claim_b_source_artifact_id: ART,
        noted_as_of: "2026-01-01", recorded_by_user_id: U,
      });
    } catch (e) {
      crossPropertyConflictFailed = e.code === "EQUITY_CONFLICT_PROPERTY_MISMATCH";
    }
    ok("a conflict cannot point at another property's position",
       crossPropertyConflictFailed);

    /*  ══ NOW READ IT BACK — E1 THROUGH E10, AND THE ROUND-4 RULINGS ═ */
    const hist4125 = await svc.loadHistory(db, P_4125);
    const pos4125 = read.position(hist4125, "2026-08-15");
    const blob4125 = JSON.stringify(pos4125);

    console.log("\n  ── Ruling 1 · the shared identity survives the read, split only by class ──");
    const mscRead = pos4125.positions.find((p) => p.position_id === msc.id);
    const holdingsRead = pos4125.positions.find((p) => p.position_id === holdings.id);
    ok("MSC reads as preferred, with a `preferred` section and no `common` section",
       mscRead.position_class === "preferred" && mscRead.preferred && mscRead.common === null);
    ok("MSC's governed legal name survives the canonical read; the UI never needs to print its UUID",
       mscRead.holder.legal_name === "MSC 4125 Chestnut LLC");
    ok("Holdings reads as common, with a `common` section and no `preferred` section",
       holdingsRead.position_class === "common" && holdingsRead.common && holdingsRead.preferred === null);

    console.log("\n  ── E2 · disagreeing sources, both returned, never merged ──");
    ok("MSC's preferred terms carry all THREE differently-sourced rows",
       mscRead.preferred.terms.length === 3);
    ok("...quarterly current-pay from governed_read",
       mscRead.preferred.terms.some((t) => t.source_authority === "governed_read" && t.compounding === "quarterly"));
    ok("...monthly current-pay from tracker_claim",
       mscRead.preferred.terms.some((t) => t.source_authority === "tracker_claim" && t.compounding === "monthly"));
    ok("no single unqualified \"compounding\" field exists in the blob",
       !/"compounding":"(monthly|quarterly)"[^{]*"compounding"/.test(blob4125.replace(/\s/g, "")));

    console.log("\n  ── Ruling 4 · MSC's Minimum Dividend, exactly as the frozen render requires ──");
    const msDividendRow = mscRead.preferred.terms.find((t) => t.minimum_dividend_schedule_text);
    ok("MSC Return reads 12.5% established, from governed_read",
       mscRead.preferred.terms.find((t) => t.source_authority === "governed_read").current_pay_rate_bp === 1250);
    ok("the Minimum Dividend schedule is observed, from secondary_summary, not governed_read",
       !!msDividendRow && msDividendRow.source_authority === "secondary_summary"
       && /8% . 9% . 10% . 11% . 12% . 12\.5%/.test(msDividendRow.minimum_dividend_schedule_text));
    ok("the relationship between the two is NOT_ESTABLISHED — never guessed from the schedule's own shape",
       msDividendRow.minimum_dividend_relationship_to_preferred_return === "not_established");
    ok("accrued preferred balance is NOT_ESTABLISHED, unconditionally",
       mscRead.preferred.accrued_preferred_return.truth_state === NE);
    ok("...and no dollar figure claims to BE the accrual",
       !/"accrued_preferred_return":\{"truth_state":"NOT_ESTABLISHED"[^}]*value/.test(blob4125));

    console.log("\n  ── E4 · capital claims, amount and percent kept as separate facts ──");
    ok("MSC's contribution claims carry all FOUR sources, including internal_note",
       new Set(mscRead.capital_amounts.contribution.map((c) => c.claim_source)).size === 4);
    const internalNote = mscRead.capital_amounts.contribution.find((c) => c.claim_source === "internal_note");
    ok("...Vernicek's $3.7MM is correctly tagged internal_note, not laundered into 'tracker'",
       internalNote.amount_cents === 370000000 && internalNote.asserted_by_text === "Rob Vernicek");
    const trackerClaim = mscRead.capital_amounts.contribution.find((c) => c.claim_source === "tracker");
    ok("...and the real tracker source is untouched at its own figure",
       trackerClaim.amount_cents === 289209489);
    ok("Holdings' ownership percentage (77.57%) reads separately from its contribution amount",
       holdingsRead.capital_amounts.ownership_percent.some((c) => c.ownership_percent === 77.57)
       && holdingsRead.capital_amounts.contribution.some((c) => c.amount_cents === 904835000));
    ok("4125's ownership schedule stays incomplete at 77.57%; no balancing holder is invented",
       pos4125.ownership_reconciliation.truth_state === "INCOMPLETE"
       && pos4125.ownership_reconciliation.current_total_percent === 77.57);

    console.log("\n  ── Round 3 · coverage_gaps, derived, no exposure table anywhere ──");
    ok("Holdings LLC's own common tier is a DERIVED gap — governed pref terms, zero named holders",
       pos4125.coverage_gaps.some((g) => g.kind === "unnamed_common_tier"
         && g.issuer_legal_entity_id === E_HOLDINGS));
    ok("MSC's Minimum Dividend relationship is ALSO a derived gap, not merely a field value",
       pos4125.coverage_gaps.some((g) => g.kind === "minimum_dividend_relationship_not_established"
         && g.position_id === msc.id));

    console.log("\n  ── E9 · Skyline GP's pledge, and absence elsewhere ──");
    const histSkyline = await svc.loadHistory(db, P_SKYLINE);
    const posSkyline = read.position(histSkyline, "2026-08-15");
    const gpRead = posSkyline.positions.find((p) => p.position_id === skylineGp.id);
    const shafranRead = posSkyline.positions.find((p) => p.position_id === shafran.id);
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

    console.log("\n  ── Ruling 2 · the 7.5% pref and 65/35 waterfall live ONCE, at the issuer ──");
    ok("Shafran's own reading carries the issuer's class terms, not a copy on his position",
       shafranRead.common.class_terms.length === 1 && shafranRead.common.class_terms[0].rate_bp === 750
       && /65\/35/.test(shafranRead.common.class_terms[0].waterfall_priority_text));
    ok("the GP's reading carries the SAME class terms object shape — not duplicated per holder",
       gpRead.common.class_terms.length === 1 && gpRead.common.class_terms[0].rate_bp === 750);

    console.log("\n  ── Ruling 3 · Lincoln's unexecuted override is surfaced, never applied ──");
    const lincolnRead = posSkyline.positions.find((p) => p.position_id === lincoln.id);
    ok("Lincoln still reads the deal-level 65/35 class terms, same as every other common holder",
       /65\/35/.test(lincolnRead.common.class_terms[0].waterfall_priority_text));
    ok("Lincoln's override is NOT in `applied` — it is not settled economics",
       lincolnRead.common.overrides.applied.length === 0);
    ok("...but it IS surfaced in `surfaced_not_applied`, with the real override text and why",
       lincolnRead.common.overrides.surfaced_not_applied.length === 1
       && /exempting this holder/.test(lincolnRead.common.overrides.surfaced_not_applied[0].override_text)
       && /not executed/.test(lincolnRead.common.overrides.surfaced_not_applied[0].why_not_applied));

    console.log("\n  ── E6 · the same dollars, debt in one document and equity in another ──");
    ok("the characterization conflict is recorded property-wide, no position forced onto either side",
       posSkyline.conflicts.some((c) => c.conflict_kind === "characterization_debt_vs_equity"
         && /Loan from Shafran/.test(c.claim_b) && /re-contributed as equity/.test(c.claim_a)));

    console.log("\n  ── the standing projection stays honest at scale ──");
    const standing4125 = read.standingProjection(pos4125);
    ok("4125's standing shows 2 positions, both named, 3 coverage gaps",
       standing4125.position_count === 2 && standing4125.named_holder_count === 2
       && standing4125.coverage_gap_count === 3);
    ok("...and next_milestone points at a coverage gap, never claims completeness",
       standing4125.next_milestone === "resolve the largest recorded coverage gap");

    //  ── as_of is a reading, not a freshness claim ──
    console.log("\n  ── as_of is a reading, not a freshness claim ──");
    const beforeEstablishment = read.position(hist4125, "2019-01-01");
    ok("reading before the positions existed sees nothing established",
       beforeEstablishment.positions.length === 0);

    await db.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    db.release(); await pool.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  db.release();
  await pool.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 58 }));
})();
