/* ════════════════════════════════════════════════════════════════════
   tax_obligation_state_bound.db.js — THE STATE BOUND WAS TRIED AND IT
   CHANGES THE ANSWER. THIS IS THE COUNTEREXAMPLE.

   `select distinct o.* from tax_obligations o …` loads EVERY tax
   obligation ever recorded for this property and its entities, with all
   their liabilities, filings and payments behind it. One row per period
   per tax type — Real Estate yearly, U&O MONTHLY — so it grows with the
   calendar forever. A history walk by any reading of §40.6.

   ── WHY A DATE BOUND IS WRONG, AND THE READ SAYS SO ITSELF ──────────
   tax_position_read.js deliberately walks past periods:

       "Plus any period ALREADY ESTABLISHED that still carries an
        unsatisfied milestone whose date has passed. A two-year-old
        unpaid bill does not stop being a problem because it got old."

   So the bound has to be by STATE — settled obligations are the curve
   that grows; unpaid ones are a small set at any age. That is the right
   instinct. This file is what happened when it was built.

   ── THE STRONGEST STATE SIGNAL SQL CAN SEE, AND WHY IT IS NOT ENOUGH ─
   Nothing in the schema records that an obligation is SETTLED. There is
   no status column, and there is deliberately none: settlement is
   DERIVED, in JavaScript, by evaluate() against milestones that
   rules.milestonesFor() computes. THOSE DUE DATES ARE NOT IN THE
   DATABASE AT ALL.

   The strongest thing SQL can ask is "does a liability say the City's
   balance is zero". That is exactly the candidate bound below. It is
   correct for nine obligations out of eleven here, and it is WRONG for
   one — and the one is not exotic:

       Someone checks the City account in JANUARY. Nothing is due yet.
       Balance: zero. The annual bill then comes due on March 31 and is
       never paid.

   `evaluate()` gets this right, because cityClear requires the balance
   observation to be dated ON OR AFTER the milestone's due date:

       city_balance_cents === 0 && balance_as_of >= m.due

   `>= m.due` is the whole ballgame, and `m.due` is a rules value. To put
   that predicate in SQL, SQL would have to know the City's calendar —
   a SECOND DEFINITION of when a tax is due, beside the one in
   philadelphia_tax_rules.js. §40.5's truth walls are exactly this:
   `filed ≠ paid`, and a second definition of "settled" is how those two
   words collapse into each other quietly.

   ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────
   Not an argument. The read is run TWICE against the same database —
   once as it is, once through a client that applies the candidate bound
   to that one statement — and the two positions are compared. The
   bounded one reports a clean position for a property with an unpaid
   2018 bill.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: when a durable
   settlement fact exists on tax_obligations (written by the canonical
   writer, not derived), at which point the bound becomes expressible and
   this file should be REPLACED by an equivalence proof like
   debt_observation_bound_equivalence.db.js. Deleting it without that is
   deleting the reason the walk is still there.

     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
       node tests/tax_obligation_state_bound.db.js
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

const AS_OF = "2026-08-12";
const USD = (d) => Math.round(d * 100);
const ANNUAL = USD(122259.93);

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ✔ " + label); }
  else { fail++; console.log("  ✘ " + label + (detail ? "\n      " + detail : "")); }
}

function scopedMigration(file, drops = []) {
  let m = fs.readFileSync(path.join(__dirname, "..", "migrations", file), "utf8");
  m = m.replace(/^begin;\s*/m, "").replace(/commit;\s*$/m, "");
  for (const d of drops) m = m.replace(d, "");
  return m;
}

/*  ── THE CANDIDATE BOUND, APPLIED TO THE REAL READ ─────────────────
 *  A wrapper client that rewrites exactly one statement — the
 *  tax_obligations load — and passes everything else through untouched.
 *  The read does not know it is being bounded, which is the point: this
 *  measures the CANDIDATE, not a re-implementation of the read that
 *  might differ for some other reason.
 *
 *  The candidate is generous on purpose. It keeps every recent period
 *  outright, so it cannot be accused of failing on the current year, and
 *  drops an older obligation only when a liability row says the City's
 *  balance is zero — the strongest settled signal the schema carries. */
function boundedClient(real, dropped) {
  return {
    query: async (sql, params) => {
      if (typeof sql === "string" && /from tax_obligations o\b/.test(sql)
          && /left join tax_obligation_properties/.test(sql)) {
        const bounded =
          `select * from (${sql}) o2
            where o2.period_end >= date '2025-01-01'
               or not exists (select 1 from tax_liabilities l
                               where l.obligation_id = o2.id
                                 and l.city_balance_cents = 0)`;
        const full = await real.query(sql, params);
        const cut = await real.query(bounded, params);
        const kept = new Set(cut.rows.map((r) => String(r.id)));
        for (const r of full.rows) if (!kept.has(String(r.id))) dropped.push(r);
        return cut;
      }
      return real.query(sql, params);
    },
  };
}

async function main() {
  const pool = new Pool({ connectionString: URL_ });
  const schema = "tax_state_bound_" + Date.now();
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
      `insert into properties (name) values ('4125 Chestnut') returning id`)).rows[0].id;
    const bill = (await c.query(
      `insert into source_artifacts (original_filename, artifact_kind)
       values ('RET bill.pdf','tax_bill') returning id`)).rows[0].id;

    const holder = await entities.establishEntity(c, {
      legal_name: "4125 Chestnut LLC", entity_type: "llc",
      provenance_note: "operating agreement", user_id: uid });
    await entities.relateToProperty(c, {
      legal_entity_id: holder.id, property_id: prop, relationship_type: "owner",
      effective_from: "2015-01-01", provenance_note: "deed", user_id: uid });
    /*  ALL FOUR TAXES ARE DETERMINED, not just the one under test.
        Leaving BIRT/NPT/U&O unconfirmed makes `overall` read
        NOT_ESTABLISHED for a reason that has nothing to do with this
        proof — and correctly so: §5 says an unconfirmed applicability is
        not a clean bill of health. The first version of this fixture left
        them blank and both reads returned the same verdict, which would
        have looked like the bound was SAFE. */
    await taxes.confirmApplicability(c, {
      tax_type: "real_estate", determination: "applies",
      basis: "Philadelphia real property.", property_id: prop,
      effective_from: "2015-01-01", provenance_note: "asset manager review",
      user_id: uid });
    for (const [t, ent] of [["uo", null], ["birt", holder.id], ["npt", holder.id]]) {
      await taxes.confirmApplicability(c, {
        tax_type: t, determination: "not_applicable",
        basis: "Not operated as a business at this address in the period under test.",
        property_id: ent ? null : prop, legal_entity_id: ent,
        effective_from: "2015-01-01", provenance_note: "asset manager review",
        user_id: uid });
    }

    console.log("\nTAX OBLIGATIONS — CAN THE WALK BE BOUNDED BY STATE?");
    console.log("=".repeat(70));
    console.log("  eleven tax years, established through the canonical writers\n");

    /*  ── THE SPECIMEN ───────────────────────────────────────────────
        2016–2024 settled the ordinary way: the City's balance observed
        as zero AFTER the March 31 due date. 2025 and 2026 are recent.

        2018 is the counterexample, and nothing about it is exotic: the
        balance was observed as zero in JANUARY, before the annual bill
        came due. It was never paid.                                   */
    const OPEN_YEAR = 2018;
    for (let y = 2016; y <= 2026; y++) {
      const o = await taxes.establishObligation(c, {
        tax_type: "real_estate", period_year: y, property_id: prop,
        account_identifier: "888888888", source_artifact_id: bill,
        provenance_note: `City Real Estate Tax bill ${y}`, user_id: uid });

      /*  2026 is SETTLED too, so the only problem on this property is the
          2018 bill. Left unpaid, the current year is overdue on its own
          and both reads say "overdue" — which would hide the very
          difference this file exists to show. */
      const zeroSeenOn = y === OPEN_YEAR ? `${y}-01-15`
        : y === 2026 ? "2026-04-15" : `${y}-12-31`;
      await taxes.recordLiability(c, {
        obligation_id: o.id, annual_liability_cents: ANNUAL,
        due_date: `${y}-03-31`,
        city_balance_cents: 0, balance_as_of: zeroSeenOn,
        source_artifact_id: bill, provenance_note: `City account ${y}`,
        user_id: uid });

      if (y !== OPEN_YEAR) {
        await taxes.recordPayment(c, {
          obligation_id: o.id, paid_at: `${y}-03-30`, amount_cents: ANNUAL,
          paid_by: "property", satisfies_requirement: "payment:annual",
          source_artifact_id: bill, provenance_note: `paid ${y}`, user_id: uid });
      }
    }

    const n = (await c.query(`select count(*)::int n from tax_obligations`)).rows[0].n;
    ok(`${n} obligations recorded — one per tax year, the calendar's own cadence`, n === 11);
    ok("…and every one of them is settled EXCEPT 2018",
       (await c.query(`select count(*)::int n from tax_payments`)).rows[0].n === 10);
    console.log("");

    /*  ══ THE TWO READS ══════════════════════════════════════════════ */
    const full = await position.readTaxPosition(c,
      { property_id: prop, as_of: AS_OF, rules });

    const dropped = [];
    const bounded = await position.readTaxPosition(boundedClient(c, dropped),
      { property_id: prop, as_of: AS_OF, rules });

    console.log("  THE READ AS IT IS");
    console.log("  " + "-".repeat(66));
    console.log(`    overall        ${full.overall}`);
    console.log(`    why            ${(full.overall_why || "").slice(0, 60)}`);
    console.log("");
    console.log("  THE READ WITH THE CANDIDATE STATE BOUND");
    console.log("  " + "-".repeat(66));
    console.log(`    overall        ${bounded.overall}`);
    console.log(`    why            ${(bounded.overall_why || "(none)").slice(0, 60)}`);
    console.log(`    dropped        ${dropped.length} obligation(s) before the read saw them`);
    console.log("");

    ok("the bound does what it was built to do — it drops most of the series",
       dropped.length >= 8, `dropped ${dropped.length}`);

    const droppedOpen = dropped.filter(
      (r) => String(r.period_start).slice(0, 4) === String(OPEN_YEAR)
          || (r.period_start instanceof Date && r.period_start.getFullYear() === OPEN_YEAR));
    ok(`…and it also drops the unpaid ${OPEN_YEAR} obligation`, droppedOpen.length === 1,
       `dropped ${droppedOpen.length} rows for ${OPEN_YEAR}`);

    console.log("  THE OUTPUT DIFFERENCE — this is the whole finding");
    console.log("  " + "-".repeat(66));
    ok(`the real read reports OVERDUE — there is an unpaid ${OPEN_YEAR} bill`,
       full.overall === "overdue", `saw "${full.overall}"`);
    ok("the BOUNDED read reports a position with no problem in it",
       bounded.overall !== "overdue", `saw "${bounded.overall}"`);
    ok("so the bound does not change the cost of the answer — it changes the ANSWER",
       full.overall !== bounded.overall);

    /*  ── WHY evaluate() GETS IT RIGHT AND SQL CANNOT ────────────────
        Both years carry city_balance_cents = 0. The ONLY difference is
        whether the observation is dated on or after the milestone's due
        date, and that due date is computed by the rules module. */
    console.log("");
    console.log("  WHY — the difference is a date SQL does not have");
    console.log("  " + "-".repeat(66));
    const ms = rules.milestonesFor("real_estate", `${OPEN_YEAR}-01-01`);
    ok("real_estate carries exactly one milestone for the period", ms.length === 1);
    ok(`…due ${ms[0] && ms[0].due} — a value from the RULES module, not a column`,
       !!(ms[0] && ms[0].due),
       "if this is ever a column, the bound becomes expressible and this file "
       + "should be replaced by an equivalence proof");
    const bothZero = (await c.query(
      `select count(*)::int n from tax_liabilities where city_balance_cents = 0`)).rows[0].n;
    ok("every settled year AND the unpaid one record city_balance_cents = 0",
       bothZero === 11, `saw ${bothZero}`);

    /*  ⚠ NOT `ok(..., true)`. The first version asserted the literal
        `true` here with a sentence attached, which is a claim wearing an
        assertion's clothes and proves nothing. Compare the two rows. */
    const pair = (await c.query(
      `select extract(year from o.period_start)::int as yr,
              l.city_balance_cents::int as bal,
              to_char(l.balance_as_of,'YYYY-MM-DD') as seen
         from tax_liabilities l
         join tax_obligations o on o.id = l.obligation_id
        where extract(year from o.period_start) in ($1, 2017)
        order by yr`, [OPEN_YEAR])).rows;
    const settled = pair.find((r) => r.yr === 2017);
    const open_ = pair.find((r) => r.yr === OPEN_YEAR);
    ok("the settled year and the unpaid year carry the SAME city_balance_cents",
       settled.bal === open_.bal && settled.bal === 0,
       `2017=${settled.bal} ${OPEN_YEAR}=${open_.bal}`);
    ok(`…and differ ONLY in balance_as_of (${settled.seen} vs ${open_.seen})`,
       settled.seen !== open_.seen);
    /*  ⚠ EACH YEAR AGAINST ITS OWN DUE DATE. The first version compared
        2017's observation to 2018's due date and went red — correctly.
        A milestone date is a function of the PERIOD; borrowing one
        period's date for another is the same class of mistake as
        borrowing one obligation's evidence for another. */
    const dueOf = (yr) => rules.milestonesFor("real_estate", `${yr}-01-01`)[0].due;
    ok(`the settled year was seen AFTER its due date (${settled.seen} > ${dueOf(2017)})`,
       settled.seen > dueOf(2017));
    ok(`the unpaid year was seen BEFORE its due date (${open_.seen} < ${dueOf(OPEN_YEAR)})`,
       open_.seen < dueOf(OPEN_YEAR));
    ok("…so `>= m.due` is the ONLY thing separating them, and m.due is a rules value",
       settled.bal === open_.bal
       && (settled.seen > dueOf(2017)) !== (open_.seen > dueOf(OPEN_YEAR)));

    /*  The read still has to be correct about the settled years, or the
        counterexample would just be a broken fixture. */
    console.log("");
    console.log("  THE CONTROL — the settled years really are settled");
    console.log("  " + "-".repeat(66));
    const row = full.rows.find((r) => r.tax_type === "real_estate");
    const openPeriods = (row.periods || []).filter((p) => p.state !== "paid");
    ok("exactly ONE period is not paid, and it is the counterexample",
       openPeriods.length === 1
       && openPeriods[0].period_label === String(OPEN_YEAR),
       `saw ${openPeriods.map((p) => `${p.period_label}=${p.state}`).join(", ")}`);

    console.log("\n" + "=".repeat(70));
    console.log(`  ${pass} green   ${fail} failed`);
    if (fail === 0) {
      console.log("\n  The state bound is not too hard to write. It is written above and");
      console.log("  it drops an unpaid bill, because the fact that would justify");
      console.log("  dropping it — settled — is not recorded anywhere. It is derived in");
      console.log("  JavaScript against a calendar the database has never seen.");
      console.log("");
      console.log("  BLOCKED on a durable settlement fact, which is a writer change and");
      console.log("  a migration. Counted until then.\n");
    }
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    if (c) c.release();
    await pool.end();
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
