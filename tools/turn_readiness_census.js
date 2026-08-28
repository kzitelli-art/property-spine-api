#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   turn_readiness_census.js — COUNT PRODUCTION BEFORE WRITING SEMANTICS

   `turnovers.ready_date` currently holds a TARGET (written when the turn
   opens, from the submitted `expected_ready_date`) and an ACHIEVEMENT
   (written on completion). Before any migration decides what a historical
   value MEANT, this counts what production actually contains.

   ⚠ IT INFERS NOTHING. `status='ready' ⇒ achievement` is a plausible rule
   and it is still a guess about what a human meant when they typed a
   date. So this reports EVIDENCE PAIRS instead:

     · an in_progress turn whose obligation due_at EQUALS ready_date is
       strong TARGET evidence, because turnover_service wrote both from
       one submitted input
     · a ready turn with a matching unit_readiness_certifications row is
       strong ACHIEVEMENT evidence
     · rows matching NEITHER are the honest unknowns, and they are the
       number the migration actually has to make a decision about

   READ-ONLY. Every statement below is a SELECT. It opens a read-only
   transaction and rolls back, so it cannot write even by accident.

   CLASS 3 — migration-preparation tooling. Removal condition: delete once
   `ready_date` is retired (see docs/archive/TURN_READINESS_SEMANTICS_TRACE.md §4).

   Run:
     DATABASE_URL=<production or a replica> node tools/turn_readiness_census.js

   Paste the output into the trace before writing backfill semantics.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Pool } = require("pg");

/*  ⚠ WRITTEN THIS WAY ON PURPOSE — do not refactor into a local alias.
 *
 *  `tests/gates/gate_harness_isolation.js` detects a production-facing script by
 *  matching `connectionString: process.env.DATABASE_URL` AT THE CONNECTION
 *  SITE. The first draft of this file read the variable once into a `const`
 *  and passed the alias to `new Pool`, which is identical at runtime and
 *  INVISIBLE to that detector. One variable of indirection was enough to
 *  walk past the gate.
 *
 *  That is a real under-detection in the gate — recorded as GAP 2 in
 *  docs/build1/INTEGRITY_GAPS.md, with the measurement. It is not fixed
 *  here, because widening the detector reclassifies 31 other files and that
 *  is a harness-inventory project, not this build. What IS fixed here is
 *  this file: it reads the variable at the connection site, so the gate sees
 *  it, AND it is registered in PRODUCTION_APPROVED. Either alone would have
 *  been enough to pass. Neither alone is honest. */
const CONN = process.env.DATABASE_URL;
if (!CONN) {
  console.error("\n  DATABASE_URL is required. This census reads production (or a replica);");
  console.error("  it makes no sense against an empty local database.\n");
  process.exit(2);
}

//  Every query is a SELECT and the whole run is wrapped in a read-only
//  transaction. Belt and braces, because this tool exists to be pointed at
//  production by someone who is not reading its source first.
const QUERIES = [
  ["turnovers by status", `
    select status, count(*)::int as n
      from turnovers group by status order by n desc`],

  ["ready_date populated, by status", `
    select status,
           count(*) filter (where ready_date is not null)::int as with_date,
           count(*) filter (where ready_date is null)::int     as without_date
      from turnovers group by status order by status`],

  ["IN_PROGRESS · target evidence (ready_date vs the turnover obligation's due_at)", `
    with o as (
      select related_id as turnover_id, max(due_at) as due_at
        from obligations
       where module='turnover' and type='move_out' and related_id is not null
       group by related_id
    )
    select case
             when o.due_at is null                                   then 'no obligation deadline'
             when t.ready_date = (o.due_at at time zone 'UTC')::date then 'ready_date == due_at  (strong TARGET evidence)'
             else                                                         'ready_date != due_at'
           end as evidence,
           count(*)::int as n
      from turnovers t
      left join o on o.turnover_id = t.id
     where t.status = 'in_progress' and t.ready_date is not null
     group by 1 order by n desc`],

  ["READY · achievement evidence (a matching readiness certification)", `
    select case when exists (
             select 1 from unit_readiness_certifications c
              where c.unit_id = t.unit_id
                and c.certified_at::date >= t.ready_date - 7
                and c.certified_at::date <= t.ready_date + 7
           ) then 'certification within ±7d  (strong ACHIEVEMENT evidence)'
             else 'no matching certification'
           end as evidence,
           count(*)::int as n
      from turnovers t
     where t.status = 'ready' and t.ready_date is not null
     group by 1 order by n desc`],

  ["THE HONEST UNKNOWNS · ready_date matching NEITHER pattern", `
    with o as (
      select related_id as turnover_id, max(due_at) as due_at
        from obligations
       where module='turnover' and type='move_out' and related_id is not null
       group by related_id
    )
    select count(*)::int as n
      from turnovers t
      left join o on o.turnover_id = t.id
     where t.ready_date is not null
       and not (t.status='in_progress'
                and o.due_at is not null
                and t.ready_date = (o.due_at at time zone 'UTC')::date)
       and not (t.status='ready' and exists (
                 select 1 from unit_readiness_certifications c
                  where c.unit_id = t.unit_id
                    and c.certified_at::date between t.ready_date - 7 and t.ready_date + 7))`],

  ["turn completion already durable? (obligations.completed_at on turnover obligations)", `
    select status,
           count(*) filter (where completed_at is not null)::int as with_completed_at,
           count(*) filter (where completed_at is null)::int     as without,
           count(*) filter (where due_at is not null)::int       as with_due_at
      from obligations
     where module='turnover' and type='move_out'
     group by status order by status`],

  ["…and does a completed turnover obligation coincide with a certification?", `
    select case when exists (
             select 1 from unit_readiness_certifications c
              where c.unit_id = ob.unit_id
                and c.certified_at >= ob.completed_at - interval '7 days'
                and c.certified_at <= ob.completed_at + interval '7 days'
           ) then 'turn completion HAS a certification near it'
             else 'turn completion with NO certification  ← turn complete ≠ ready'
           end as evidence,
           count(*)::int as n
      from obligations ob
     where ob.module='turnover' and ob.type='move_out' and ob.completed_at is not null
     group by 1 order by n desc`],

  ["units flagged DOWN whose turn is marked ready (the axis the code already warns about)", `
    select count(*)::int as n
      from turnovers t join units u on u.id = t.unit_id
     where t.status='ready' and coalesce(u.is_down,false) = true`],

  ["certifications with no turnover at all (readiness does not require a turn)", `
    select count(*)::int as n
      from unit_readiness_certifications c
     where not exists (select 1 from turnovers t where t.unit_id = c.unit_id)`],
];

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  //  ⚠ this said `new URL(URL)` with a local `const URL` shadowing the
  //  global constructor, so it always reported "(unparsed)". In a tool whose
  //  entire output is a claim about WHICH database was counted, naming the
  //  wrong database — or none — is not a cosmetic bug.
  const host = (() => { try { return new globalThis.URL(CONN).host; } catch (_) { return "(unparsed)"; } })();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  TURN READINESS CENSUS — read-only");
  console.log(`  DATABASE  ${host}`);
  console.log(`  TAKEN AT  ${new Date().toISOString()}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  Nothing below is inferred. Each block reports evidence pairs;");
  console.log("  the migration decides from these numbers, not from status.");

  try {
    await client.query("begin read only");
    for (const [label, sql] of QUERIES) {
      console.log(`\n  ── ${label} ──`);
      let rows;
      try {
        rows = (await client.query(sql)).rows;
      } catch (e) {
        //  A missing table is a FINDING, not a crash: it tells the reader
        //  this deployment does not have that primitive.
        console.log(`     QUERY FAILED: ${e.message}`);
        continue;
      }
      if (!rows.length) { console.log("     (no rows)"); continue; }
      const keys = Object.keys(rows[0]);
      const w = keys.map((k) => Math.max(k.length,
        ...rows.map((r) => String(r[k] == null ? "—" : r[k]).length)));
      console.log("     " + keys.map((k, i) => k.padEnd(w[i])).join("  "));
      for (const r of rows) {
        console.log("     " + keys.map((k, i) =>
          String(r[k] == null ? "—" : r[k]).padEnd(w[i])).join("  "));
      }
    }
    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  Paste this into docs/archive/TURN_READINESS_SEMANTICS_TRACE.md §4 before");
  console.log("  any backfill semantics are written. Where evidence does not");
  console.log("  support a reading, the answer stays UNKNOWN.");
  console.log("════════════════════════════════════════════════════════════════\n");
})().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
