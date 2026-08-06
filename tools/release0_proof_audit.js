#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   release0_proof_audit.js — READ-ONLY Release 0 proof-correction audit.

   AUTHORIZED BY: docs/RELEASE_0_AUDIT_PLAN.md, under charter Open Ruling 4.
   THAT PLAN MUST BE APPROVED AT A NAMED COMMIT BEFORE THIS RUNS.
   Being named "audit" is not authorization — Ruling 4 says so in those words.

   WHAT IT ANSWERS. Five question groups, each traced to a Release 0
   acceptance criterion or a frozen ruling. Nothing else. A question that is
   not in the plan is not in this file:

     A  full ledger reconciliation            (delegated — see below)
     B  the unclassified blast radius         §16 acceptance 1, 6
     C  completion-timestamp coverage         §19 Ruling 1 predicate
     D  composite-scoping constraints         §16 composite FK
     E  finished-work population by lane      §19 Ruling 2 mapping

   Query A is NOT reimplemented here. tools/ledger_reconcile.js already does
   it, already imports the same classifyLedger that migrate.js runs at boot,
   and therefore cannot disagree with what a deploy will decide. A second
   implementation of that comparison is the exact hazard that tool's own
   header warns about. Run it first, separately; this tool refuses to
   duplicate it.

   ── STRUCTURALLY READ-ONLY ──────────────────────────────────────────
   Everything runs inside `begin transaction read only`, and the tool PROVES
   it cannot write BEFORE it reads anything. The probe is savepoint-wrapped:
   a failed statement aborts the whole transaction block, so an unwrapped
   probe kills every read after it and the tool reports nothing while
   appearing to have run. That is a documented incident on this repository,
   not a hypothesis. See docs/MIGRATION_LEDGER_INVERSE_GATE.md §5.

   ── WHAT IT MAY NOT SELECT ──────────────────────────────────────────
   No message bodies, no field notes, no titles or descriptions, no resident
   identity, no phone/email/media URL, no user names, and never the CONTENTS
   of completion_photo or completion_note. Presence (`IS NOT NULL`) is
   permitted and is checked; contents are not. Enforced by review against
   docs/RELEASE_0_AUDIT_PLAN.md §5 and by
   tests/release0_audit_forbidden_fields.test.js, which reads this file's
   own source.

   ── DETERMINISM ─────────────────────────────────────────────────────
   Every query carries an explicit ORDER BY, and the emitted JSON has
   stable key order. Two runs against identical data produce byte-identical
   output, so a receipt can be diffed rather than eyeballed.

   USAGE
     DATABASE_URL="<read-only connection>" node tools/release0_proof_audit.js
     …                                    node tools/release0_proof_audit.js --json

   EXIT  — every one of these is exercised in
          docs/release-0-audit/ISOLATED_PROOF_RECEIPT.md §4.5
     0  the audit completed and its findings were emitted
     2  refused, and nothing usable was read. Four causes, each with its own
        message: DATABASE_URL unset · the database is unreachable · the
        connection accepted a write · a required table is absent.
     1  an unexpected error; the transaction is rolled back.
   ════════════════════════════════════════════════════════════════════ */

"use strict";

const { Client } = require("pg");

//  ── THE QUERIES ────────────────────────────────────────────────────
//  Declared as data, not scattered through control flow, so the set that
//  runs is the set that can be read and reviewed in one place. Every entry
//  states the plan section that authorizes it.

const QUERIES = [
  {
    key: "B1",
    title: "Proof attachments by storage state and classification",
    authority: "plan §4 B1 · charter §16 acceptance 1",
    sql: `
      select storage_state, proof_classification, count(*)::int as n
        from work_order_proof_attachments
       group by storage_state, proof_classification
       order by storage_state, proof_classification`,
  },
  {
    key: "B2",
    singleRow: true,
    title: "Work orders whose proof is satisfied ONLY by an unclassified attachment",
    authority: "plan §4 B2 · THE NUMBER THAT SIZES THE RELEASE",
    sql: `
      with stored as (
        select work_order_id, proof_classification
          from work_order_proof_attachments
         where storage_state = 'stored'
      )
      select count(*)::int as flipping_work_orders
        from (
          select work_order_id
            from stored
           group by work_order_id
          having bool_or(proof_classification = 'unclassified')
             and not bool_or(proof_classification in ('repair_photo', 'condition'))
        ) t`,
  },
  {
    key: "B3",
    title: "Identifiers of the flipping work orders",
    authority: "plan §4 B3 · identifiers only",
    sql: `
      with stored as (
        select work_order_id, property_id, proof_classification
          from work_order_proof_attachments
         where storage_state = 'stored'
      )
      select work_order_id, property_id
        from stored
       group by work_order_id, property_id
      having bool_or(proof_classification = 'unclassified')
         and not bool_or(proof_classification in ('repair_photo', 'condition'))
       order by property_id, work_order_id`,
  },
  {
    key: "C0",
    title: "Status census — run before anything filters on status",
    authority: "plan §4 C0 · charter §6 (a filter may not define the question)",
    sql: `
      select status, count(*)::int as n
        from work_orders
       group by status
       order by status`,
  },
  {
    key: "C1",
    title: "Ruling 1 gap: finished work by lane and completion-timestamp presence",
    authority: "plan §4 C1 · §19 Ruling 1 predicate",
    sql: `
      select w.status,
             (p.work_order_id is not null) as has_completed_progress_row,
             count(*)::int as n
        from work_orders w
        left join (select distinct work_order_id, property_id
                     from work_order_progress
                    where kind = 'completed') p
          on p.work_order_id = w.id
         and p.property_id  = w.property_id
       where w.status in ('complete', 'closed')
       group by w.status, (p.work_order_id is not null)
       order by w.status, (p.work_order_id is not null)`,
  },
  {
    key: "C2",
    singleRow: true,
    title: "Recorded completion-time range (NOT an activation-boundary input)",
    authority: "plan §3.3 · the boundary is CAPTURED at the writer's verified-live instant",
    sql: `
      select count(*)::int as completed_progress_rows,
             min(occurred_at) as earliest,
             max(occurred_at) as latest
        from work_order_progress
       where kind = 'completed'`,
  },
  {
    key: "C3",
    title: "Identifiers with no completion timestamp — Ruling 1 cannot evaluate these",
    authority: "plan §4 C3 · identifiers and presence booleans only",
    sql: `
      select w.id as work_order_id, w.property_id, w.status,
             (w.completion_photo is not null) as has_column_photo,
             w.created_at, w.updated_at
        from work_orders w
        left join (select distinct work_order_id, property_id
                     from work_order_progress
                    where kind = 'completed') p
          on p.work_order_id = w.id
         and p.property_id  = w.property_id
       where w.status in ('complete', 'closed')
         and p.work_order_id is null
       order by w.property_id, w.status, w.created_at, w.id`,
  },
  {
    key: "C4",
    singleRow: true,
    title: "Cross-property scoping check (expected zero)",
    authority: "plan §4 C4 · §21 property is the scope of every read",
    sql: `
      select count(*)::int as cross_property_progress_rows
        from work_order_progress p
        join work_orders w on w.id = p.work_order_id
       where w.property_id <> p.property_id`,
  },
  {
    key: "C5",
    title: "The third proof model: evidence stored in columns, counted by presence",
    authority: "plan §4 C5 · presence permitted, contents forbidden (§5)",
    sql: `
      select w.status,
             (w.completion_photo is not null) as has_column_photo,
             (w.completion_note  is not null) as has_column_note,
             count(*)::int as n
        from work_orders w
       where w.status in ('complete', 'closed')
       group by w.status,
                (w.completion_photo is not null),
                (w.completion_note is not null)
       order by w.status,
                (w.completion_photo is not null),
                (w.completion_note is not null)`,
  },
  {
    key: "D1a",
    title: "Composite foreign keys on the progress and attachment tables",
    authority: "plan §4 D1 · confirms migration 134 applied as written",
    sql: `
      select conname,
             pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid in ('work_order_progress'::regclass,
                          'work_order_proof_attachments'::regclass)
         and contype = 'f'
       order by conname`,
  },
  {
    key: "D1b",
    title: "The uniquely-constrained (id, property_id) the composite FKs reference",
    authority: "plan §4 D1",
    sql: `
      select indexname, indexdef
        from pg_indexes
       where tablename = 'work_orders'
         and indexname = 'uq_work_orders_id_property'
       order by indexname`,
  },
  {
    key: "E1",
    title: "Finished-work population by lane and Ruling 1 evaluability",
    authority: "plan §4 E1 · NO classification claim is made for either gap population",
    sql: `
      select w.status,
             case when p.work_order_id is not null
                    then 'has_completion_timestamp'
                    else 'no_completion_timestamp'
             end as ruling_1_evaluable,
             count(*)::int as n
        from work_orders w
        left join (select distinct work_order_id, property_id
                     from work_order_progress
                    where kind = 'completed') p
          on p.work_order_id = w.id
         and p.property_id  = w.property_id
       where w.status in ('complete', 'closed')
       group by w.status,
                case when p.work_order_id is not null
                       then 'has_completion_timestamp'
                       else 'no_completion_timestamp' end
       order by w.status,
                case when p.work_order_id is not null
                       then 'has_completion_timestamp'
                       else 'no_completion_timestamp' end`,
  },
];

//  Conclusions this audit is NOT permitted to draw. Emitted with the
//  findings so a reader of the receipt cannot mistake a silence for a
//  verdict. §19 reserves these to the owner.
const WITHHELD_CONCLUSIONS = [
  "What a work order with no completion timestamp emits under the proof-state " +
    "contract. Ruling 1's predicate reads completed_at; without one, neither " +
    "branch applies and none of the four published states describes the row.",
  "Whether a status='closed' work order is completed work for Release 0's " +
    "purposes. lifecycleStateOf tests status='complete' only, so these never " +
    "reach the classification. See RELEASE_0_COMPLETION_WRITER_MATRIX.md §3.",
  "Whether Open Ruling 2's four proof states cover column-stored photo proof.",
  "Any value for the Release 0 activation boundary. It is CAPTURED at the " +
    "writer's verified-live instant under Ruling 1 and is never derived from " +
    "production data, including anything in this audit.",
];

/*  Deterministic serialisation. Key order is the insertion order declared
 *  above, dates render as ISO-8601 UTC, and nothing depends on the host's
 *  locale or timezone. Two runs on identical data diff to nothing. */
function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => (v instanceof Date ? v.toISOString() : v), 2);
}

function renderText(report) {
  const L = [];
  L.push("════════════════════════════════════════════════════════════════");
  L.push("  RELEASE 0 PROOF AUDIT — read-only");
  L.push(`  database   ${report.connection.database}  (user ${report.connection.user})`);
  L.push(`  read-only  ${report.connection.read_only_proof}`);
  L.push("════════════════════════════════════════════════════════════════");
  for (const r of report.findings) {
    L.push("");
    L.push(`── ${r.key}  ${r.title}`);
    L.push(`   authority: ${r.authority}`);
    if (r.rows.length === 0) {
      L.push("   (no rows)");
      continue;
    }
    const cols = Object.keys(r.rows[0]);
    const width = cols.map((c) =>
      Math.max(c.length, ...r.rows.map((row) => String(row[c] ?? "").length)));
    L.push("   " + cols.map((c, i) => c.padEnd(width[i])).join("  "));
    for (const row of r.rows) {
      L.push("   " + cols.map((c, i) => {
        const v = row[c] instanceof Date ? row[c].toISOString() : String(row[c] ?? "");
        return v.padEnd(width[i]);
      }).join("  "));
    }
  }
  L.push("");
  L.push("── CONCLUSIONS WITHHELD (§19 reserves these to the owner)");
  for (const w of report.withheld_conclusions) L.push(`   · ${w}`);
  L.push("");
  L.push("── QUERY A (full ledger reconciliation) IS NOT RUN BY THIS TOOL");
  L.push("   Run tools/ledger_reconcile.js separately. It shares classifyLedger");
  L.push("   with migrate.js, so it cannot disagree with what a deploy decides.");
  L.push("");
  return L.join("\n");
}

async function main() {
  const asJson = process.argv.includes("--json");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("  ✗ DATABASE_URL is not set. Refusing to guess a connection.");
    process.exit(2);
  }

  const client = new Client({ connectionString: url });

  //  CONNECT INSIDE ITS OWN GUARD. An unreachable database is the single
  //  most likely real failure — wrong host, wrong credentials, no network —
  //  and an unguarded await here surfaces it as an unhandled rejection and a
  //  Node stack trace. That is a confident-wrong in miniature: the operator
  //  cannot tell "the audit failed" from "the audit crashed", and a stack
  //  trace is not an answer. Refuse in the tool's own voice instead.
  try {
    await client.connect();
  } catch (err) {
    console.error("");
    console.error("  ✗ Could not connect to the database. Nothing was read.");
    console.error(`    ${err && err.message ? err.message : err}`);
    console.error("");
    await client.end().catch(() => {});
    process.exit(2);
  }

  const report = {
    tool: "tools/release0_proof_audit.js",
    authorized_by: "docs/RELEASE_0_AUDIT_PLAN.md (Open Ruling 4)",
    connection: { database: null, user: null, read_only_proof: null },
    findings: [],
    withheld_conclusions: WITHHELD_CONCLUSIONS,
    query_a_note:
      "Full ledger reconciliation is delegated to tools/ledger_reconcile.js " +
      "and is not reimplemented here.",
  };

  try {
    // ── PROVE READ-ONLY BEFORE READING ANYTHING ─────────────────────
    //
    //  THE FIRST STATEMENT THIS TOOL SENDS IS `begin transaction read only`.
    //  Nothing precedes it — not a version check, not a health ping, and in
    //  particular NOT the connection-identity query, which used to sit here.
    //
    //  Identity is only two catalog functions and could not mutate anything,
    //  so the temptation is to call it harmless. That misses the point. The
    //  tool's own claim is "a write was attempted and refused BEFORE ANY
    //  READ", and the refusal path says "Nothing was read." With an identity
    //  query first, both sentences were false — narrowly, but a safety
    //  contract that is narrowly false is not a safety contract, and a
    //  receipt repeating it is a confident-wrong about the audit itself.
    //
    //  Postgres's read-only transaction is still the substantive barrier.
    //  This ordering is what makes the SENTENCE true as well.
    await client.query("begin transaction read only");
    let writable = false;
    await client.query("savepoint write_probe");
    try {
      await client.query("create temporary table __release0_audit_write_probe (x int)");
      writable = true;
    } catch {
      /*  Expected. A refused write is the pass condition. */
    }
    await client.query("rollback to savepoint write_probe");

    if (writable) {
      console.error("");
      console.error("  ✗ REFUSED — this transaction accepted a write.");
      console.error("    A read-only tool that can write is not read-only.");
      console.error("    Nothing was read — not the connection identity, not any");
      console.error("    domain data. The write probe was the only statement sent.");
      console.error("");
      await client.query("rollback").catch(() => {});
      await client.end();
      process.exit(2);
    }
    report.connection.read_only_proof = "a write was attempted and refused before any read";

    //  ONLY NOW. Identity is a courtesy for the receipt, not the proof, and
    //  it is read inside the proven read-only transaction like everything
    //  else. A failure here costs the receipt a label, never the audit.
    try {
      const who = await client.query("select current_database() as db, current_user as usr");
      report.connection.database = who.rows[0].db;
      report.connection.user = who.rows[0].usr;
    } catch {
      /*  An honest blank beats a guessed database name. */
    }

    // ── READ ────────────────────────────────────────────────────────
    for (const q of QUERIES) {
      let rows;
      try {
        ({ rows } = await client.query(q.sql));
      } catch (err) {
        if (err && err.code === "42P01") {
          console.error("");
          console.error(`  ✗ ${q.key}: a required table does not exist in this database.`);
          console.error(`    ${err.message}`);
          console.error("    This is a finding, not a crash — but it is not an audit.");
          console.error("");
          await client.query("rollback").catch(() => {});
          await client.end();
          process.exit(2);
        }
        throw err;
      }
      report.findings.push({ key: q.key, title: q.title, authority: q.authority, rows });
    }

    await client.query("rollback");
    await client.end();

    process.stdout.write(asJson ? `${stableStringify(report)}\n` : renderText(report));
    process.exit(0);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
    console.error(`\n  ✗ ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { QUERIES, WITHHELD_CONCLUSIONS, stableStringify, renderText };
