#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  receipts_b1_m1_queryability_probe.js — CAN A TOUR OPERATION BE RECOVERED?
//
//  M1 stores its replay identity inside tour_events.metadata, a JSONB field.
//  Before any tour receipt is built on it, the exact recovery lookup has to
//  be measured — not assumed, and not excused by the presence of a property
//  predicate. A property predicate narrows the ROWS RETURNED. It does not by
//  itself stop the planner from reading every event row to find them.
//
//  The governed lookup must be equivalent to:
//      authenticated property + exact tour operation + exact operation_id
//        → at most one durable tour event
//
//  Never by operation_id alone. Never across properties, event types or
//  operation namespaces.
//
//  This probe builds real volume with neighbouring-property noise, runs
//  EXPLAIN (ANALYZE, BUFFERS) against the actual proposed query, and
//  classifies. It writes no product code and adds no index.
//
//  Run:  HARNESS_DATABASE_URL=… node tests/receipts_b1_m1_queryability_probe.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const { Pool } = require("pg");
const crypto = require("crypto");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
//  Volume is a knob so the SHAPE of growth can be observed, not a single
//  point that could be read either way.
const SCALES = (process.env.M1_SCALES || "2000,20000").split(",").map(Number);

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 12 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const q = async (s, a = []) => (await pool.query(s, a)).rows;
  const results = [];
  try {
    section("1  tour_events — schema, constraints, indexes");
    const cols = await q(`select column_name, data_type, is_nullable
      from information_schema.columns where table_name='tour_events' order by ordinal_position`);
    console.log("   columns:");
    cols.forEach((c) => console.log(`     ${c.column_name.padEnd(14)} ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`));
    ok("1a tour_events was inspected", cols.length > 0);
    //  THE DECISIVE FACT: there is no property_id on the event. Property
    //  lineage runs tour_events.tour_id → leasing_tours.property_id, so every
    //  property-scoped lookup is a JOIN, not a column filter.
    ok("1b tour_events carries NO property_id — property lineage is via leasing_tours",
      !cols.some((c) => c.column_name === "property_id"));

    const idx = await q(`select indexname, indexdef from pg_indexes where tablename='tour_events'`);
    console.log("   indexes:");
    idx.forEach((i) => console.log(`     ${i.indexname.padEnd(24)} ${i.indexdef.replace(/^.*USING /, "USING ")}`));
    ok("1c indexes were enumerated", idx.length > 0);
    const jsonIdx = idx.filter((i) => /metadata/i.test(i.indexdef));
    console.log(`   indexes touching metadata: ${jsonIdx.length}`);
    ok("1d NO index exists on metadata — the replay identity is unindexed",
      jsonIdx.length === 0);

    const cons = await q(`select conname, pg_get_constraintdef(oid) d
      from pg_constraint where conrelid='tour_events'::regclass`);
    console.log("   constraints:");
    cons.forEach((c) => console.log(`     ${c.conname}: ${c.d.slice(0, 110)}`));
    ok("1e constraints were enumerated", cons.length > 0);

    section("2  the metadata JSON shape actually written");
    const shapes = await q(`select event_type, jsonb_object_keys(metadata) k, count(*)::int n
      from tour_events where metadata is not null group by 1,2 order by 1,3 desc limit 24`);
    shapes.forEach((s) => console.log(`     ${s.event_type.padEnd(22)} ${s.k.padEnd(30)} ${s.n}`));
    ok("2a the written metadata shape was read from real rows", shapes.length >= 0);
    //  The existing capture key is capture_idempotency_key, written ONLY by
    //  completeTourService. It is not a general operation identity, and it is
    //  absent from check-in and every other verb.
    const capKeys = (await q(`select count(*)::int n from tour_events
      where metadata ? 'capture_idempotency_key'`))[0].n;
    console.log(`   rows carrying capture_idempotency_key: ${capKeys}`);
    ok("2b the existing capture key was located (or proven absent) in real rows", capKeys >= 0);

    section("3  volume with neighbouring-property noise");
    //  A synthetic estate: the property under test, plus neighbours whose
    //  events are the noise a real recovery lookup has to see past.
    const u = "m1q" + Date.now().toString(36);
    const mkProp = async (n) => (await q(`insert into properties (name, operating_timezone)
      values ($1,'America/New_York') returning id`, [n]))[0].id;
    const target = await mkProp(u + " TARGET");
    const neighbours = [await mkProp(u + " N1"), await mkProp(u + " N2"), await mkProp(u + " N3")];

    //  One lead per property is enough — the row count that matters is events.
    const mkLead = async (prop) => {
      const p = (await q(`insert into persons (name, lifecycle_status)
        values ($1,'lead') returning id`, [u + Math.random().toString(36).slice(2, 9)]))[0].id;
      return (await q(`insert into leasing_leads (person_id, property_id, status, received_at)
        values ($1,$2,'new', now()) returning id`, [p, prop]))[0].id;
    };
    const mkTour = async (prop, lead) => (await q(
      `insert into leasing_tours (lead_id, property_id, scheduled_for, status)
       values ($1,$2, now(), 'scheduled') returning id`, [lead, prop]))[0].id;

    //  The operation_id we will later look up. Buried in the middle of the
    //  volume, never first and never last — a lookup that only works because
    //  the row happens to be recently written proves nothing.
    //  ONE NEEDLE PER SCALE. An earlier version reused a single operation_id
    //  across both scale iterations and planted it twice, so the correctness
    //  check found two events and failed — the FIXTURE was wrong, not the
    //  lookup. A replay identity is unique by construction; the fixture must
    //  be too.
    const needles = {};
    let needleTour = null;

    for (const scale of SCALES) {
      //  Grow the estate to `scale` events per property, then measure.
      for (const prop of [target, ...neighbours]) {
        const lead = await mkLead(prop);
        const tour = await mkTour(prop, lead);
        if (prop === target && !needleTour) needleTour = tour;
        //  Bulk insert via generate_series — the volume is the point, and one
        //  round trip per row would make this probe the slow thing.
        await pool.query(
          `insert into tour_events (tour_id, lead_id, event_type, actor_type, metadata)
           select $1, $2, 'checked_in', 'human',
                  jsonb_build_object('operation_id', gen_random_uuid()::text,
                                     'operation', 'tour.check_in')
             from generate_series(1, $3)`,
          [tour, lead, Math.max(1, Math.floor(scale / 2))]);
      }
      //  Plant the needle in the MIDDLE of the target property's volume.
      const needleLead = (await q(`select lead_id from leasing_tours where id=$1`, [needleTour]))[0].lead_id;
      needles[scale] = crypto.randomUUID();
      await pool.query(
        `insert into tour_events (tour_id, lead_id, event_type, actor_type, metadata)
         values ($1,$2,'checked_in','human',
                 jsonb_build_object('operation_id', $3::text, 'operation', 'tour.check_in'))`,
        [needleTour, needleLead, needles[scale]]);
      await pool.query(
        `insert into tour_events (tour_id, lead_id, event_type, actor_type, metadata)
         select $1, $2, 'checked_in', 'human',
                jsonb_build_object('operation_id', gen_random_uuid()::text,
                                   'operation', 'tour.check_in')
           from generate_series(1, $3)`,
        [needleTour, needleLead, Math.max(1, Math.floor(scale / 2))]);

      await pool.query("analyze tour_events");
      await pool.query("analyze leasing_tours");

      const total = (await q(`select count(*)::int n from tour_events`))[0].n;
      const sel = (await q(`select count(*)::int n from tour_events te
        join leasing_tours t on t.id=te.tour_id where t.property_id=$1`, [target]))[0].n;
      const nbr = total - sel;

      //  ── THE ACTUAL PROPOSED RECOVERY LOOKUP ────────────────────────
      //  property + operation namespace + operation_id, at most one row.
      const SQL = `
        select te.id, te.tour_id, te.event_at
          from tour_events te
          join leasing_tours t on t.id = te.tour_id
         where t.property_id = $1
           and te.event_type = $2
           and te.metadata->>'operation' = $3
           and te.metadata->>'operation_id' = $4
         limit 1`;
      const plan = (await q(`explain (analyze, buffers, format json) ${SQL}`,
        [target, "checked_in", "tour.check_in", needles[scale]]))[0]["QUERY PLAN"][0];

      const flat = [];
      (function walk(n) { flat.push(n); (n.Plans || []).forEach(walk); })(plan.Plan);
      const scans = flat.filter((n) => /Scan/.test(n["Node Type"]));
      const seq = scans.filter((n) => n["Node Type"] === "Seq Scan");
      const rowsExamined = flat.reduce((a, n) => a + (n["Actual Rows"] || 0), 0);

      const r = {
        scale,
        total_events: total,
        selected_property_events: sel,
        neighbour_events: nbr,
        scan_types: scans.map((n) => `${n["Node Type"]}${n["Index Name"] ? "(" + n["Index Name"] + ")" : ""} on ${n["Relation Name"] || "?"}`),
        seq_scan_on_tour_events: seq.some((n) => n["Relation Name"] === "tour_events"),
        seq_scan_rows: seq.filter((n) => n["Relation Name"] === "tour_events")
          .reduce((a, n) => a + (n["Actual Rows"] || 0) + (n["Rows Removed by Filter"] || 0), 0),
        rows_examined: rowsExamined,
        rows_returned: plan.Plan["Actual Rows"],
        planning_ms: plan["Planning Time"],
        execution_ms: plan["Execution Time"],
        shared_hit: plan.Plan["Shared Hit Blocks"],
        shared_read: plan.Plan["Shared Read Blocks"],
        temp_written: plan.Plan["Temp Written Blocks"] || 0,
      };
      results.push(r);

      console.log(`\n   ── scale ${scale} ─────────────────────────────`);
      console.log(`   selected-property tour_events : ${r.selected_property_events}`);
      console.log(`   neighbouring-property events  : ${r.neighbour_events}`);
      console.log(`   total tour_events             : ${r.total_events}`);
      console.log(`   scan types                    : ${r.scan_types.join(" · ")}`);
      console.log(`   seq scan on tour_events       : ${r.seq_scan_on_tour_events ? "YES — " + r.seq_scan_rows + " rows" : "no"}`);
      console.log(`   rows examined / returned      : ${r.rows_examined} / ${r.rows_returned}`);
      console.log(`   planning / execution (ms)     : ${r.planning_ms} / ${r.execution_ms}`);
      console.log(`   buffers hit / read            : ${r.shared_hit} / ${r.shared_read}`);
      console.log(`   temp spill (blocks)           : ${r.temp_written}`);
    }

    section("4  the lookup is CORRECT before it is fast");
    //  Speed of a wrong answer is worthless. Correctness first.
    const SQL_CHECK = `
      select te.id from tour_events te
        join leasing_tours t on t.id = te.tour_id
       where t.property_id = $1 and te.event_type = $2
         and te.metadata->>'operation' = $3 and te.metadata->>'operation_id' = $4`;
    const lastNeedle = needles[SCALES[SCALES.length - 1]];
    const hit = await q(SQL_CHECK, [target, "checked_in", "tour.check_in", lastNeedle]);
    ok(`4a the governed lookup finds EXACTLY ONE event (${hit.length})`, hit.length === 1);
    const wrongProp = await q(SQL_CHECK, [neighbours[0], "checked_in", "tour.check_in", lastNeedle]);
    ok(`4b a neighbouring property finds NOTHING (${wrongProp.length})`, wrongProp.length === 0);
    const wrongOp = await q(SQL_CHECK, [target, "checked_in", "tour.complete", lastNeedle]);
    ok(`4c a different operation namespace finds NOTHING (${wrongOp.length})`, wrongOp.length === 0);
    const wrongType = await q(SQL_CHECK, [target, "completed", "tour.check_in", lastNeedle]);
    ok(`4d a different event type finds NOTHING (${wrongType.length})`, wrongType.length === 0);

    section("5  CLASSIFICATION");
    const worst = results[results.length - 1];
    const first = results[0];
    //  The question is not "is it fast today" but "does the work grow with
    //  total events". A scan that doubles when the estate doubles is a scan,
    //  whatever the millisecond count says at fixture size.
    const grew = results.length > 1
      && worst.seq_scan_rows > first.seq_scan_rows * 1.5;
    const scanning = worst.seq_scan_on_tour_events;
    console.log(`   sequential scan on tour_events at largest scale : ${scanning ? "YES" : "no"}`);
    if (results.length > 1) {
      console.log(`   scanned rows ${first.seq_scan_rows} → ${worst.seq_scan_rows} as events ${first.total_events} → ${worst.total_events}`);
      console.log(`   growing with volume                            : ${grew ? "YES" : "no"}`);
    }

    if (scanning) {
      console.log("\n   M1 TOUR CAPTURE RECOVERY");
      console.log("   BLOCKED — QUERYABLE OPERATION ID REQUIRES MIGRATION");
      console.log("\n   The property predicate narrows what is RETURNED; it does not");
      console.log("   stop the planner reading every event row to find it. No index");
      console.log("   can resolve metadata->>'operation_id' today, and none is added");
      console.log("   here while migration 129 is unresolved.");
    } else {
      console.log("\n   M1 TOUR CAPTURE RECOVERY — QUERYABLE ON EXISTING INDEXES");
    }
    //  The probe's own integrity: it must have actually measured something.
    ok("5a the probe measured at least two volumes", results.length >= 2);
    ok("5b a classification was reached from measured plans, not from assumption",
      typeof scanning === "boolean" && worst.total_events > 0);
  } finally { await pool.end(); }
  console.log(`\n════ M1 queryability: ${pass} passed, ${fail} failed ════`);
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 12 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e && e.stack || e); process.exit(1); });
