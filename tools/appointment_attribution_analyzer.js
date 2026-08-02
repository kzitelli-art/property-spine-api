// ════════════════════════════════════════════════════════════════════
//  appointment_attribution_analyzer.js — HOW MUCH EXACT ATTRIBUTION
//  ALREADY EXISTS, BEFORE ANYTHING IS WRITTEN.
//
//  READ-ONLY. This is a MEASUREMENT, not a backfill. It writes nothing and
//  must not be turned into a writer: its whole purpose is to establish the
//  honest opening state so that a later exact-links-only backfill can be
//  judged against a baseline rather than against a hope.
//
//  It runs against the CURRENT schema and does not require the attribution
//  bridge to exist, so it is ledger-independent.
//
//  ── WHAT COUNTS AS EXACT ─────────────────────────────────────────────
//  Only explicit durable links:
//    · leasing_conversions.origin_tour_id   → an exact native pointer
//    · leasing_conversions.scheduled_tour_id → an exact external pointer
//    · rescheduled_from chains whose attributed members AGREE
//
//  ── WHAT IS FORBIDDEN, AND THEREFORE COUNTED SEPARATELY ──────────────
//  nearest timestamp · same person · same lead alone · same property ·
//  conversation proximity · current active conversion · first/latest tour ·
//  unit preference · browser state.
//
//  Appointments whose ONLY possible association is one of those are reported
//  as `inference_only` and remain UNTRACKABLE. They are counted so the size of
//  the honest gap is visible — never so it can be closed by guessing.
//
//  Run: DATABASE_URL=... node tools/appointment_attribution_analyzer.js [property_id]
// ════════════════════════════════════════════════════════════════════

"use strict";
const { Pool } = require("pg");

const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

async function analyze(q, { property_id = null } = {}) {
  const scope = property_id ? "and t.property_id = $1" : "";
  const args = property_id ? [property_id] : [];

  // ── NATIVE APPOINTMENTS ────────────────────────────────────────────
  //  Every native tour, with the exact pointer that claims it (if any) and its
  //  reschedule parent. LEFT JOIN on the pointer: a tour nobody points at must
  //  still appear, as unattributed.
  const native = (await q.query(
    `select t.id, t.property_id, t.lead_id, t.status, t.rescheduled_from,
            t.scheduled_for, t.completed_at, t.no_show_at, t.cancelled_at,
            (select array_agg(c.id) from leasing_conversions c
              where c.origin_tour_id = t.id) as origin_pointers
       from leasing_tours t
      where true ${scope}`, args)).rows;

  // ── EXTERNAL APPOINTMENTS ──────────────────────────────────────────
  const external = (await q.query(
    `select t.id, t.property_id, t.status, t.scheduled_start, t.reschedule_count,
            (select array_agg(c.id) from leasing_conversions c
              where c.scheduled_tour_id = t.id) as scheduled_pointers,
            (select count(*) from scheduled_tour_revisions r
              where r.scheduled_tour_id = t.id)::int as revisions
       from scheduled_tours t
      where true ${scope}`, args)).rows;

  const byId = new Map(native.map((t) => [String(t.id), t]));

  // ── CHAIN ROOTS ────────────────────────────────────────────────────
  //  Iterative with a visited set. A cycle, a parent outside the scope, or a
  //  missing parent cannot resolve to one root — those are reported, never
  //  silently rooted at whichever row the walk happened to stop on.
  function rootOf(t) {
    const seen = new Set();
    let cur = t;
    while (cur && cur.rescheduled_from) {
      const k = String(cur.id);
      if (seen.has(k)) return { root: null, reason: "cycle" };
      seen.add(k);
      const parent = byId.get(String(cur.rescheduled_from));
      if (!parent) return { root: null, reason: "parent_missing_or_out_of_scope" };
      if (String(parent.property_id) !== String(cur.property_id)) {
        return { root: null, reason: "parent_in_another_property" };
      }
      cur = parent;
    }
    return { root: cur ? String(cur.id) : null, reason: null };
  }

  const chains = new Map();          // rootId -> { members[], links:Set }
  const untrackableChains = [];

  for (const t of native) {
    const { root, reason } = rootOf(t);
    if (!root) { untrackableChains.push({ tour_id: t.id, reason }); continue; }
    if (!chains.has(root)) chains.set(root, { root, members: [], links: new Set() });
    const ch = chains.get(root);
    ch.members.push(t);
    for (const c of t.origin_pointers || []) ch.links.add(String(c));
  }

  // ── CLASSIFY ───────────────────────────────────────────────────────
  const R = {
    native_total: native.length,
    external_total: external.length,

    exact_native_pointer: [],      // a conversion.origin_tour_id names this tour
    exact_external_pointer: [],    // a conversion.scheduled_tour_id names it
    chain_inheritance: [],         // root attributed, members agree
    chain_conflict: [],            // members carry DIFFERENT opportunities
    chain_untrackable: untrackableChains,
    unattributed: [],              // no exact link of any kind
    inference_only: [],            // could ONLY be linked by forbidden inference
    wrong_property: [],            // pointer crosses a property boundary
  };

  for (const ch of chains.values()) {
    const links = [...ch.links];
    if (links.length > 1) {
      R.chain_conflict.push({ root: ch.root, opportunities: links,
                              members: ch.members.map((m) => m.id) });
      continue;
    }
    if (links.length === 1) {
      for (const m of ch.members) {
        const direct = (m.origin_pointers || []).length > 0;
        (direct ? R.exact_native_pointer : R.chain_inheritance)
          .push({ tour_id: m.id, opportunity_id: links[0], chain_root: ch.root });
      }
      continue;
    }
    // No exact link anywhere in the chain. Could it be associated at all?
    for (const m of ch.members) {
      if (m.lead_id) R.inference_only.push({ tour_id: m.id, chain_root: ch.root,
                                             only_via: "lead/person/property/time" });
      else R.unattributed.push({ tour_id: m.id, chain_root: ch.root });
    }
  }

  for (const e of external) {
    const links = e.scheduled_pointers || [];
    if (links.length > 1) {
      R.chain_conflict.push({ root: e.id, opportunities: links.map(String), members: [e.id] });
    } else if (links.length === 1) {
      R.exact_external_pointer.push({ tour_id: e.id, opportunity_id: String(links[0]),
                                      revisions: e.revisions });
    } else {
      R.inference_only.push({ tour_id: e.id, only_via: "person/property/time (external)" });
    }
  }

  // Cross-property check on every exact pointer.
  for (const bucket of [R.exact_native_pointer, R.exact_external_pointer]) {
    for (const row of bucket) {
      const bad = (await q.query(
        `select 1 from leasing_conversions c
          where c.id = $1 and c.property_id <> (
            select property_id from leasing_tours where id = $2
            union all select property_id from scheduled_tours where id = $2 limit 1)`,
        [row.opportunity_id, row.tour_id])).rows[0];
      if (bad) R.wrong_property.push(row);
    }
  }

  return R;
}

function report(R) {
  const n = (a) => (Array.isArray(a) ? a.length : a);
  const ids = (a, k = "tour_id") => a.slice(0, 3).map((x) => String(x[k]).slice(0, 8)).join(", ");
  console.log("\n══ APPOINTMENT ATTRIBUTION — HONEST OPENING STATE ══");
  console.log(`  native appointments      ${R.native_total}`);
  console.log(`  external appointments    ${R.external_total}`);
  console.log("\n  EXACT (a durable link names it)");
  console.log(`    native pointer         ${n(R.exact_native_pointer)}   ${ids(R.exact_native_pointer)}`);
  console.log(`    external pointer       ${n(R.exact_external_pointer)}   ${ids(R.exact_external_pointer)}`);
  console.log(`    chain inheritance      ${n(R.chain_inheritance)}   ${ids(R.chain_inheritance)}`);
  console.log("\n  NOT EXACT (stays untrackable)");
  console.log(`    chain conflict         ${n(R.chain_conflict)}   ${ids(R.chain_conflict, "root")}`);
  console.log(`    chain untrackable      ${n(R.chain_untrackable)}   ${ids(R.chain_untrackable)}`);
  console.log(`    inference-only         ${n(R.inference_only)}   ${ids(R.inference_only)}`);
  console.log(`    unattributed           ${n(R.unattributed)}   ${ids(R.unattributed)}`);
  console.log(`    wrong property         ${n(R.wrong_property)}   ${ids(R.wrong_property)}`);
  const exact = n(R.exact_native_pointer) + n(R.exact_external_pointer) + n(R.chain_inheritance);
  const total = R.native_total + R.external_total;
  console.log(`\n  BACKFILLABLE BY EXACT LINK ONLY: ${exact} of ${total}`);
  console.log(`  PERMANENTLY UNTRACKABLE:         ${total - exact} of ${total}`);
  console.log("  (the second number is not a defect to close — it is the honest gap)\n");
}

module.exports = { analyze, report };

if (require.main === module) {
  (async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    try { report(await analyze(pool, { property_id: process.argv[2] || null })); }
    finally { await pool.end(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
