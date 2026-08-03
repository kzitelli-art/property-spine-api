// ════════════════════════════════════════════════════════════════════
//  lifecycle_event_attribution_backfill.js — EXACT LINKS ONLY, FOR THE
//  LIFECYCLE RAIL (migration 128).
//
//  READ-ONLY BY DEFAULT. Not imported by application runtime, not called by
//  migration startup or any deployment hook, never runs automatically. Writes
//  require --apply. Same operating contract as the appointment backfill.
//
//  ── THE ONLY PERMITTED EVIDENCE ──────────────────────────────────────
//  A source object the event ALREADY NAMES which itself carries the exact
//  opportunity UUID. Today that is exactly one thing:
//
//      leasing_lead_lifecycle_events.tour_id
//        -> scheduled_tours.conversion_id     (migration 127)
//
//  The event names a specific tour; that tour carries its own durable
//  attribution. Following that pointer is lineage, not inference.
//
//  ── FORBIDDEN, AND STRUCTURALLY ABSENT ───────────────────────────────
//  whichever opportunity was active at the event time · the only opportunity
//  currently open · nearest conversion creation time · same lead · same person
//  and property · current lead status · current conversion status.
//
//  There is no code path here that could do any of them: the only lookup issued
//  is by the event's OWN tour_id.
//
//  ── WHAT STAYS NULL ──────────────────────────────────────────────────
//  closed_not_fit and reopened carry no tour pointer, so historical ones have
//  NO exact evidence and remain NULL — permanently, unless an explicit governed
//  correction supplies attribution. That is the honest answer, not a backlog.
//
//  Run: DATABASE_URL=... node tools/lifecycle_event_attribution_backfill.js [--apply] [property_id]
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");

const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

async function measure(q, { property_id = null } = {}) {
  const scope = property_id ? "and e.property_id = $1" : "";
  const args = property_id ? [property_id] : [];

  //  Every event, with the EXACT opportunity its own named tour carries.
  const rows = (await q.query(
    `select e.id, e.event_type, e.conversion_id, e.tour_id, e.property_id,
            t.conversion_id as tour_conversion_id,
            t.property_id   as tour_property_id
       from leasing_lead_lifecycle_events e
       left join scheduled_tours t on t.id = e.tour_id
      where true ${scope}`, args)).rows;

  const R = {
    total: rows.length,
    exactly_attributable: [],   // exact evidence, currently NULL -> writable
    already_correct: [],        // exact evidence, already set, agrees
    conflicting: [],            // exact evidence disagrees with what is set
    untrackable: [],            // no exact evidence of any kind
    wrong_property: [],
  };

  for (const r of rows) {
    const exact = r.tour_conversion_id ? String(r.tour_conversion_id) : null;
    if (!exact) {
      if (!r.conversion_id) {
        R.untrackable.push({ event_id: r.id, event_type: r.event_type,
                             reason: r.tour_id ? "named_tour_is_itself_unattributed"
                                               : "no_source_object_carrying_an_exact_opportunity" });
      } else {
        R.already_correct.push({ event_id: r.id, opportunity_id: String(r.conversion_id),
                                 basis: "already_attributed_by_writer" });
      }
      continue;
    }
    if (r.tour_property_id && String(r.tour_property_id) !== String(r.property_id)) {
      R.wrong_property.push({ event_id: r.id, event_property: r.property_id,
                              tour_property: r.tour_property_id });
      continue;
    }
    if (!r.conversion_id) {
      R.exactly_attributable.push({ event_id: r.id, event_type: r.event_type,
                                    opportunity_id: exact, basis: "named_tour_pointer" });
    } else if (String(r.conversion_id) === exact) {
      R.already_correct.push({ event_id: r.id, opportunity_id: exact, basis: "named_tour_pointer" });
    } else {
      R.conflicting.push({ event_id: r.id, existing: String(r.conversion_id), exact_evidence: exact });
    }
  }
  return R;
}

async function backfill(q, { property_id = null, apply = false } = {}) {
  const R = await measure(q, { property_id });
  let written = 0;
  if (apply) {
    for (const c of R.exactly_attributable) {
      //  `and conversion_id is null` is the write-once guarantee AND the
      //  concurrency gate. An event that gained attribution meanwhile is left
      //  exactly as it is.
      const res = await q.query(
        `update leasing_lead_lifecycle_events set conversion_id = $2
          where id = $1 and conversion_id is null`, [c.event_id, c.opportunity_id]);
      written += res.rowCount;
    }
  }
  return { ...R, written, applied: apply };
}

function report(R) {
  const n = (a) => (Array.isArray(a) ? a.length : a);
  console.log("\n══ LIFECYCLE EVENT ATTRIBUTION " + (R.applied ? "(APPLIED)" : "(DRY RUN)") + " ══");
  console.log(`  events examined           ${R.total}`);
  console.log(`  exactly attributable      ${n(R.exactly_attributable)}`);
  console.log(`  ${R.applied ? "written" : "would write"}               ${R.applied ? R.written : n(R.exactly_attributable)}`);
  console.log(`  already correct           ${n(R.already_correct)}`);
  console.log(`  conflicting               ${n(R.conflicting)}`);
  console.log(`  wrong property            ${n(R.wrong_property)}`);
  console.log(`  untrackable from evidence ${n(R.untrackable)}`);
  console.log("  (untrackable is NOT a backlog — closed_not_fit and reopened carry no");
  console.log("   source object naming an opportunity, so no exact evidence exists)\n");
}

module.exports = { measure, backfill, report };

if (require.main === module) {
  (async () => {
    const apply = process.argv.includes("--apply");
    const property_id = process.argv.slice(2).find((a) => !a.startsWith("--")) || null;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await backfill(c, { property_id, apply });
      await c.query(apply ? "commit" : "rollback");
      report(out);
      if (!apply) console.log("  Nothing was written. Re-run with --apply to write.\n");
    } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
    finally { c.release(); await pool.end(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
