// ════════════════════════════════════════════════════════════════════
//  appointment_attribution_backfill.js — THE EXACT-LINKS-ONLY BACKFILL.
//
//  Phase 4 of the enforcement sequence in
//  docs/slices-6-to-10/APPOINTMENT_ATTRIBUTION_MIGRATION_CONTRACT.md §5.
//  Runs AFTER migration 127 and AFTER the writer cutover.
//
//  ── IT DOES NOT DECIDE WHAT IS EXACT ─────────────────────────────────
//  It asks the analyzer. The analyzer is the ONE definition of "exact", so
//  this file cannot drift from the measurement that justified it. Only three
//  buckets are ever written:
//
//      exact_native_pointer     leasing_conversions.origin_tour_id names it
//      exact_external_pointer   leasing_conversions.scheduled_tour_id names it
//      chain_inheritance        the chain's root is attributed and every
//                               attributed member AGREES
//
//  Everything else the analyzer reports — inference_only, unattributed,
//  chain_conflict, chain_untrackable, wrong_property — is LEFT NULL. Those are
//  not a queue to be worked down. NULL is the truthful answer for them, and
//  closing that gap by nearest timestamp, same person, same lead, same property
//  or current-active-conversion is forbidden. This tool has no code path that
//  could do it: it never issues a lookup of its own.
//
//  ── WHAT IT WILL NOT OVERWRITE ───────────────────────────────────────
//  Every write is guarded by `and conversion_id is null`. A row that already
//  carries an attribution is never reassigned, even to the value the analyzer
//  computed — a disagreement there is a CONFLICT for a human, not something to
//  resolve by writing. Those are counted and reported, never silently applied.
//
//  ── SAFETY ───────────────────────────────────────────────────────────
//  · DRY RUN BY DEFAULT. Pass --apply to write.
//  · One transaction; any error rolls the whole thing back.
//  · Property equality is RE-CHECKED here, not trusted from the analyzer.
//  · Idempotent: a second run writes zero rows.
//
//  Run: DATABASE_URL=... node tools/appointment_attribution_backfill.js [--apply] [property_id]
// ════════════════════════════════════════════════════════════════════

"use strict";
const { Pool } = require("pg");
const { analyze } = require("./appointment_attribution_analyzer");

const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

const TABLE = {
  native: "leasing_tours",
  external: "scheduled_tours",
};

/**
 * backfill(q, { property_id, apply })
 *
 * @param q      a client already inside a transaction when apply is true.
 * @param apply  false (default) computes and reports without writing.
 */
async function backfill(q, { property_id = null, apply = false } = {}) {
  const R = await analyze(q, { property_id });

  // The three exact buckets, tagged with which table each row lives in.
  const candidates = [
    ...R.exact_native_pointer.map((r) => ({ ...r, kind: "native" })),
    ...R.chain_inheritance.map((r) => ({ ...r, kind: "native" })),
    ...R.exact_external_pointer.map((r) => ({ ...r, kind: "external" })),
  ];

  const out = {
    considered: candidates.length,
    written: 0,
    already_correct: 0,     // already carries exactly this opportunity
    conflict_left_alone: 0, // already carries a DIFFERENT one — never rewritten
    refused_wrong_property: 0,
    left_null_by_design:
      R.inference_only.length + R.unattributed.length +
      R.chain_conflict.length + R.chain_untrackable.length,
    conflicts: [],
    applied: apply,
  };

  for (const c of candidates) {
    const table = TABLE[c.kind];

    // Re-check property equality HERE. The analyzer reports wrong_property, but
    // a backfill must not trust an upstream report to authorise a write.
    const same = (await q.query(
      `select 1 from ${table} t join leasing_conversions v on v.id = $2
        where t.id = $1 and v.property_id = t.property_id`,
      [c.tour_id, c.opportunity_id])).rows[0];
    if (!same) { out.refused_wrong_property++; continue; }

    const cur = (await q.query(
      `select conversion_id from ${table} where id = $1`, [c.tour_id])).rows[0];
    if (cur && cur.conversion_id) {
      if (String(cur.conversion_id) === String(c.opportunity_id)) out.already_correct++;
      else {
        out.conflict_left_alone++;
        out.conflicts.push({ table, tour_id: c.tour_id,
                             existing: String(cur.conversion_id),
                             analyzer_says: String(c.opportunity_id) });
      }
      continue;
    }

    if (!apply) { out.written++; continue; }   // would write

    //  `and conversion_id is null` is the write-once guarantee AND the
    //  concurrency gate: only one transaction can satisfy it.
    const res = await q.query(
      `update ${table} set conversion_id = $2
        where id = $1 and conversion_id is null`, [c.tour_id, c.opportunity_id]);
    out.written += res.rowCount;
  }

  return out;
}

function report(o) {
  console.log("\n══ EXACT-LINKS-ONLY BACKFILL " + (o.applied ? "(APPLIED)" : "(DRY RUN)") + " ══");
  console.log(`  exact candidates          ${o.considered}`);
  console.log(`  ${o.applied ? "written" : "would write"}               ${o.written}`);
  console.log(`  already correct           ${o.already_correct}`);
  console.log(`  conflicts LEFT ALONE      ${o.conflict_left_alone}`);
  console.log(`  refused, wrong property   ${o.refused_wrong_property}`);
  console.log(`  left NULL by design       ${o.left_null_by_design}`);
  for (const c of o.conflicts) {
    console.log(`     ! ${c.table} ${String(c.tour_id).slice(0, 8)} has ${c.existing.slice(0, 8)}, analyzer says ${c.analyzer_says.slice(0, 8)} — needs a human`);
  }
  console.log("  (rows left NULL are NOT a backlog — inference is forbidden)\n");
}

module.exports = { backfill, report };

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes("--apply");
    const property_id = process.argv.slice(2).find((a) => !a.startsWith("--")) || null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    const c = await pool.connect();
    try {
      await c.query("begin");
      const o = await backfill(c, { property_id, apply });
      await c.query(apply ? "commit" : "rollback");
      report(o);
      if (!apply) console.log("  Nothing was written. Re-run with --apply to write.\n");
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); await pool.end(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
