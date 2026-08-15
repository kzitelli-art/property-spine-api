/* ════════════════════════════════════════════════════════════════════
   debt_schema_falsification.db.js — THE DEBT WALLS THAT THE SCHEMA
   ITSELF REFUSES, PROVEN AGAINST REAL POSTGRES BY TRYING TO BREAK THEM.

   Every assertion here writes something that SHOULD be impossible and
   fails if the database accepts it. A constraint nobody has attacked is
   a comment with a semicolon.

   ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────
   This is the SCHEMA half of the Debt falsification. It proves the
   database refuses to STORE a collapsed distinction.

   It does NOT prove the walls hold. Structural protection narrows the
   attack surface; it does not discharge the obligation to prove:

       no compliance column     stops storing a bogus status. It does NOT
                                stop position() seeing covenants exist and
                                rendering "covenants: okay".
       no projection enum       stops writing a projection as an
                                observation. It does NOT stop a read
                                computing one and labelling it "balance".
       funding boundary gate    stops Debt WRITING tax truth. It does NOT
                                stop a Debt reader SAYING taxes are paid.

   The read-level hostile proofs for W1–W9 live in the position() harness
   and are a separate, required file. Defense in depth. Do not let this
   file's green be cited as "the walls hold".

   ── ISOLATION ───────────────────────────────────────────────────────
   Requires HARNESS_DATABASE_URL via receipt.harnessConnectionString(),
   which refuses to run against the same target as DATABASE_URL. This
   harness COMMITS into a scoped schema and drops it on entry, so it must
   never point at production.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/debt_schema_falsification.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const SCHEMA = "debt_falsification";
const MIGRATION = path.join(__dirname, "..", "migrations", "173_debt_instruments.sql");

const url = receipt.harnessConnectionString();
const started = receipt.begin(__filename, { url, expected: 14 });

let pass = 0, fail = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const U = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";

/*  Attempt a write that must be refused. Returns the SQLSTATE class so a
 *  test can assert it was refused for the RIGHT reason — "it threw" is
 *  not the same claim as "the constraint fired", and a typo throws too. */
async function refused(db, sql, params) {
  try {
    await db.query(sql, params);
    return null;                      // accepted — the wall did not hold
  } catch (e) {
    return e.code || "unknown";
  }
}

(async () => {
  const pool = new Pool({ connectionString: url });
  const db = await pool.connect();
  try {
    //  ── scoped schema, rebuilt every run ──────────────────────────
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.query(`create schema ${SCHEMA}`);
    await db.query(`set search_path to ${SCHEMA}`);
    await db.query(`create extension if not exists pgcrypto`);

    //  Minimal dependencies. The full migration chain cannot rebuild from
    //  empty (012_bank_intake / yardi_code), which predates this work and
    //  bounds every DB proof in this repo — so 173's referents are stubbed
    //  at the shape 173 actually uses.
    await db.query(`create table users (id uuid primary key)`);
    await db.query(`create table properties (id uuid primary key)`);
    await db.query(`create table legal_entities (id uuid primary key)`);
    await db.query(`create table source_artifacts (id uuid primary key)`);
    await db.query(`insert into users values ($1)`, [U]);
    await db.query(`insert into properties values ($1)`, [P]);
    await db.query(`insert into legal_entities values ($1)`, [E]);

    //  ── the real migration, unmodified ────────────────────────────
    const sql = fs.readFileSync(MIGRATION, "utf8");
    await db.query(sql);

    console.log("\n  ── the migration applies, and creates what it claims ──");
    const t = await db.query(
      `select table_name from information_schema.tables
        where table_schema = $1 and table_name like 'debt%' order by 1`, [SCHEMA]);
    const tables = t.rows.map((r) => r.table_name);
    ok("173 applies against real Postgres", tables.length > 0);
    ok("it creates exactly 7 debt tables", tables.length === 7, tables.join(", "));

    //  ── ABSENCE IS PART OF THE DESIGN, SO ABSENCE IS ASSERTED ──────
    //  Each of these columns was designed and deliberately REMOVED. If one
    //  reappears it will arrive as a helpful convenience, and this is the
    //  assertion that makes that a decision instead of a drift.
    console.log("\n  ── columns that must NOT exist ──");
    const cols = await db.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = $1 and table_name like 'debt%'`, [SCHEMA]);
    const has = (re) => cols.rows.filter((c) => re.test(c.column_name))
      .map((c) => `${c.table_name}.${c.column_name}`);

    ok("W5 — no compliance column anywhere in the Debt domain",
       has(/complian/i).length === 0, has(/complian/i).join(", "));
    ok("no current_* column — position() is a reading, not a row",
       has(/^current_/i).length === 0, has(/^current_/i).join(", "));
    ok("no balloon_amount — the schedule's figure is a projection",
       has(/balloon/i).length === 0, has(/balloon/i).join(", "));
    ok("no satisfies_requirement — requirements are derived, not rows",
       has(/satisf/i).length === 0, has(/satisf/i).join(", "));
    ok("no superseded_by — append-only points BACKWARD",
       has(/superseded_by/i).length === 0, has(/superseded_by/i).join(", "));
    ok("no extension_standing — 4125 forces no extension object",
       has(/extension/i).length === 0, has(/extension/i).join(", "));
    //  A reserve REQUIREMENT is Debt's. A reserve BALANCE is Tax's or
    //  Insurance's funding truth, and this is the structural half of W6.
    const reserveBalance = cols.rows.filter(
      (c) => c.table_name === "debt_reserve_requirements" && /balance/i.test(c.column_name));
    ok("no balance column on reserve requirements — W6 structural half",
       reserveBalance.length === 0, reserveBalance.map((c) => c.column_name).join(", "));

    //  ── WRITES THAT MUST BE REFUSED ───────────────────────────────
    console.log("\n  ── writes the database must refuse ──");

    ok("currency is required — no silent USD default",
       (await refused(db,
         `insert into debt_instruments (instrument_kind, original_principal_cents, recorded_by_user_id)
          values ('first_mortgage', 2825000000, $1)`, [U])) === "23502");

    const ins = await db.query(
      `insert into debt_instruments (instrument_kind, original_principal_cents, currency, recorded_by_user_id)
       values ('first_mortgage', 2825000000, 'USD', $1) returning id`, [U]);
    const I = ins.rows[0].id;

    //  W8's structural half. There is no enum value for a projection, so a
    //  projected balance cannot be parked here and later read back as
    //  though someone had observed it.
    ok("W8 — a schedule projection cannot be stored as an observation",
       (await refused(db,
         `insert into debt_balance_observations
            (instrument_id, observed_balance_cents, as_of_date, observation_source, recorded_by_user_id)
          values ($1, 2713187412, '2026-08-01', 'schedule_projection', $2)`, [I, U])) === "23514");

    ok("interest-only cannot carry a level payment",
       (await refused(db,
         `insert into debt_terms (instrument_id, effective_from, term_source, rate_kind, fixed_rate_bp,
            day_count_convention, payment_frequency, amortization_kind, level_payment_cents, recorded_by_user_id)
          values ($1,'2020-09-01','original','fixed',328,'actual_360','monthly','interest_only',12341140,$2)`,
         [I, U])) === "23514");

    ok("level_payment must carry its payment",
       (await refused(db,
         `insert into debt_terms (instrument_id, effective_from, term_source, rate_kind, fixed_rate_bp,
            day_count_convention, payment_frequency, amortization_kind, recorded_by_user_id)
          values ($1,'2024-09-01','original','fixed',328,'actual_360','monthly','level_payment',$2)`,
         [I, U])) === "23514");

    ok("a floating rate requires an index formula",
       (await refused(db,
         `insert into debt_terms (instrument_id, effective_from, term_source, rate_kind,
            day_count_convention, payment_frequency, amortization_kind, recorded_by_user_id)
          values ($1,'2020-09-01','original','floating','actual_360','monthly','interest_only',$2)`,
         [I, U])) === "23514");

    //  A guarantor is a natural person and a borrower is an entity. One
    //  subject each, so a loan document can never mint a durable person by
    //  filling both columns "to be safe".
    ok("a party has exactly one subject — entity XOR attributed name",
       (await refused(db,
         `insert into debt_instrument_parties
            (instrument_id, party_role, legal_entity_id, party_name_text, effective_from, recorded_by_user_id)
          values ($1,'guarantor',$2,'Kameron Zitelli','2020-09-01',$3)`, [I, E, U])) === "23514");

    //  ── AND THE SHAPE 4125 ACTUALLY FORCES MUST BE ACCEPTED ────────
    //  A schema that refuses everything is not a wall, it is a brick. The
    //  original instrument's two regimes must both land, from one document.
    console.log("\n  ── the real 4125 term shape must be accepted ──");
    const io = await db.query(
      `insert into debt_terms (instrument_id, effective_from, effective_to, term_source, rate_kind,
         fixed_rate_bp, day_count_convention, payment_frequency, amortization_kind,
         maturity_date, recorded_by_user_id)
       values ($1,'2020-09-01','2024-08-01','original','fixed',328,'actual_360','monthly',
               'interest_only','2030-08-01',$2) returning id`, [I, U]);
    const amort = await db.query(
      `insert into debt_terms (instrument_id, effective_from, term_source, rate_kind, fixed_rate_bp,
         day_count_convention, payment_frequency, amortization_kind, level_payment_cents,
         fully_amortizing, maturity_date, supersedes_term_id, recorded_by_user_id)
       values ($1,'2024-09-01','original','fixed',328,'actual_360','monthly','level_payment',
               12341140, false, '2030-08-01', $2, $3) returning id`, [I, io.rows[0].id, U]);
    ok("both original regimes coexist, from one governing document",
       !!io.rows[0].id && !!amort.rows[0].id);

    const chain = await db.query(
      `select count(*)::int n from debt_terms where instrument_id = $1 and supersedes_term_id is not null`, [I]);
    ok("the amortizing regime points BACKWARD at the IO regime",
       chain.rows[0].n === 1);

    await db.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    db.release(); await pool.end();
    process.exit(receipt.died(__filename, e, ran));
  }
  db.release();
  await pool.end();
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 14 }));
})();
