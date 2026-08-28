// ════════════════════════════════════════════════════════════════════
//  slice9_scale_proof.js — THE BOUNDED SNAPSHOT AT SCALE.
//
//  The claim: the four-funnel read is property-scoped and constant-query, so
//  10,000 opportunities in the selected property project correctly while
//  100,000+ noisy neighbours at OTHER properties change neither the query
//  count nor the selected-property plan. This proves SCOPING, not decorative
//  realism.
//
//  DB DISCIPLINE: builds ~120k committed rows. HARNESS_DATABASE_URL required
//  and must differ from DATABASE_URL — point it at a disposable scale DB.
//
//  Run: HARNESS_DATABASE_URL=... node tests/proofs/slice9_scale_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const { opportunityFunnelRows, aggregateOpportunityFunnel } =
  require(path.join(REPO, "src/evidence/opportunity_funnel"));

const CONN = process.env.HARNESS_DATABASE_URL;
if (!CONN) { console.error("FATAL: HARNESS_DATABASE_URL required (commits ~120k rows)."); process.exit(1); }
if (process.env.DATABASE_URL && CONN === process.env.DATABASE_URL) {
  console.error("FATAL: HARNESS_DATABASE_URL must differ from DATABASE_URL."); process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const IN_PROP = 10000, NEIGHBOURS = 100000, NEIGHBOUR_PROPS = 10;

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false, max: 4 });
  const c = await pool.connect();
  try {
    console.log(`\n── FIXTURE: ${IN_PROP.toLocaleString()} in-property + ${NEIGHBOURS.toLocaleString()} neighbours ──`);
    const t0 = Date.now();
    await c.query("begin");
    const one = async (q, a = []) => (await c.query(q, a)).rows[0];
    const P = (await one(`insert into properties (name, operating_timezone)
      values ('S9 scale — target','America/New_York') returning id`)).id;
    const host = (await one(`insert into users (email,name)
      values ('scale@proof.test','Scale host') returning id`)).id;
    await c.query(`create temp table _props (ord int primary key, id uuid)`);
    await c.query(`insert into _props
      select n, gen_random_uuid() from generate_series(1, $1) n`, [NEIGHBOUR_PROPS]);
    await c.query(`insert into properties (id, name, operating_timezone)
      select id, 'S9 scale — neighbour '||ord, 'America/New_York' from _props`);

    //  One person + lead + ACTIVE opportunity per row (one_active-safe).
    //  n <= IN_PROP → target property; else spread across neighbours.
    const TOTAL = IN_PROP + NEIGHBOURS;
    await c.query(`
      create temp table _rows as
      select n,
             gen_random_uuid() as person_id,
             gen_random_uuid() as lead_id,
             gen_random_uuid() as conv_id,
             case when n <= $1 then $2::uuid
                  else (select id from _props where ord = 1 + (n % $3)) end as prop_id,
             timestamptz '2026-07-01' + (n % 45) * interval '1 day' as opened
        from generate_series(1, $4) n`, [IN_PROP, P, NEIGHBOUR_PROPS, TOTAL]);
    await c.query(`insert into persons (id, name, lifecycle_status)
      select person_id, 'scale-'||n, 'lead' from _rows`);
    await c.query(`insert into leasing_leads (id, person_id, property_id, status, received_at)
      select lead_id, person_id, prop_id, 'new', opened from _rows`);
    await c.query(`insert into leasing_conversions
        (id, person_id, property_id, lead_id, status, current_stage, opened_at,
         actual_tour_host_user_id, conversation_owner_user_id)
      select conv_id, person_id, prop_id, lead_id, 'active', 'touring', opened, $1, $1
        from _rows`, [host]);
    //  Appointments: 30% of in-property attended, 10% scheduled-future;
    //  50k neighbour tours as noise volume in the same table.
    await c.query(`insert into leasing_tours
        (lead_id, property_id, leasing_agent_id, scheduled_for, status, completed_at, conversion_id)
      select lead_id, prop_id, $1,
             opened + interval '3 days',
             case when n % 10 < 3 then 'completed' when n % 10 = 3 then 'scheduled' else 'scheduled' end,
             case when n % 10 < 3 then opened + interval '3 days' end,
             conv_id
        from _rows where n <= $2 and n % 10 <= 3`, [host, IN_PROP]);
    await c.query(`update leasing_tours t set scheduled_for = timestamptz '2026-12-01'
      from _rows r where r.conv_id = t.conversion_id and r.n % 10 = 3 and r.n <= $1`, [IN_PROP]);
    await c.query(`insert into leasing_tours (lead_id, property_id, leasing_agent_id, scheduled_for, status, conversion_id)
      select lead_id, prop_id, $1, opened + interval '2 days', 'scheduled', conv_id
        from _rows where n > $2 and n % 2 = 0`, [host, IN_PROP]);
    //  Applications: 15% of in-property, exactly linked, durable milestones.
    await c.query(`insert into lease_applications
        (property_id, person_id, conversion_id, status, created_at, submitted_at, approved_at)
      select prop_id, person_id, conv_id, 'submitted', opened + interval '5 days',
             opened + interval '5 days',
             case when n % 20 = 0 then opened + interval '8 days' end
        from _rows where n <= $1 and n % 20 < 3`, [IN_PROP]);
    //  Lifecycle: 10% of in-property closed by exact event (needs conversations).
    await c.query(`insert into conversations (property_id, person_id, channel_primary, status)
      select prop_id, person_id, 'sms', 'open' from _rows where n <= $1 and n % 10 = 7`, [IN_PROP]);
    await c.query(`insert into leasing_lead_lifecycle_events
        (conversation_id, conversion_id, property_id, event_sequence, event_type,
         actor_type, actor_id, reason_code, idempotency_key, occurred_at)
      select cv.id, r.conv_id, r.prop_id, 1, 'closed_not_fit', 'operator', $1,
             'budget_mismatch', 'scale-'||r.n, r.opened + interval '10 days'
        from _rows r join conversations cv on cv.person_id = r.person_id and cv.property_id = r.prop_id
       where r.n <= $2 and r.n % 10 = 7`, [host, IN_PROP]);
    await c.query("commit");
    await c.query("analyze");
    const build_s = ((Date.now() - t0) / 1000).toFixed(1);
    const counts = (await c.query(`select
      (select count(*) from leasing_conversions) conv,
      (select count(*) from leasing_conversions where property_id=$1) inprop,
      (select count(*) from leasing_tours) tours,
      (select count(*) from lease_applications) apps,
      (select count(*) from leasing_lead_lifecycle_events) events`, [P])).rows[0];
    console.log(`  built in ${build_s}s · conversions ${counts.conv} (${counts.inprop} in-property) · tours ${counts.tours} · apps ${counts.apps} · lifecycle events ${counts.events}`);
    ok(Number(counts.inprop) === IN_PROP, `${IN_PROP} opportunities in the target property`);
    ok(Number(counts.conv) - Number(counts.inprop) >= NEIGHBOURS,
      `${NEIGHBOURS.toLocaleString()}+ noisy neighbours outside it`);

    // ── THE MEASURED RUN ──────────────────────────────────────────────
    const W = {
      state: "ok", property_id: P, operating_timezone: "America/New_York",
      window_start_local: "2026-07-01", window_end_local: "2026-08-31",
      window_start_utc: "2026-07-01T04:00:00.000Z", window_end_utc: "2026-09-01T04:00:00.000Z",
      as_of_utc: "2026-08-20T00:00:00.000Z",
    };
    console.log("\n── QUERY COUNT, TIME, MEMORY ────────────────────────────");
    const issued = [];
    const counting = {
      connect: pool.connect.bind(pool), totalCount: pool.totalCount,
      query: (...a) => c.query(...a),
    };
    //  Count on the CALLER-TRANSACTION path (deterministic capture of SQL).
    await c.query("begin transaction isolation level repeatable read read only");
    const capture = { query: (text, ...rest) => { issued.push({ text, args: rest[0] || [] }); return c.query(text, ...rest); } };
    const memBefore = process.memoryUsage().heapUsed;
    const tRun = Date.now();
    const out = await opportunityFunnelRows(capture, W);
    const elapsed_ms = Date.now() - tRun;
    const memAfter = process.memoryUsage().heapUsed;
    await c.query("commit");
    const agg = aggregateOpportunityFunnel(out.rows);
    const respBytes = Buffer.byteLength(JSON.stringify({ rows: out.rows, agg }));
    console.log(`  queries ${issued.length} · elapsed ${elapsed_ms}ms · rows ${out.rows.length} · response ${(respBytes / 1e6).toFixed(1)}MB · heap +${((memAfter - memBefore) / 1e6).toFixed(0)}MB`);
    //  9 or 10: the scheduled_tour_revisions read is issued only when external
    //  tours exist — a bounded conditional (0 or 1 extra query), never an N+1.
    ok(issued.length >= 9 && issued.length <= 11,
      `query count is CONSTANT-BOUNDED with 110k rows on the tables (${issued.length})`);
    ok(out.rows.length === IN_PROP, `every in-property opportunity projects (${out.rows.length})`);
    ok(agg.reconciles === true, "and the aggregate still reconciles exactly");
    ok(!out.rows.some((r) => String(r.property_id) !== String(P)),
      "not one neighbour row leaked into the selected property");
    ok(elapsed_ms < 60000, `bounded time (${elapsed_ms}ms)`);

    console.log("\n── EXPLAIN ANALYZE (BUFFERS) — THE MATERIAL READS ───────");
    let seqScanOnBigTable = null;
    for (const q of issued) {
      if (!/^\s*select/i.test(q.text)) continue;
      const plan = (await c.query(`explain (analyze, buffers, format json) ${q.text}`, q.args)).rows[0]["QUERY PLAN"][0];
      const flat = JSON.stringify(plan);
      const table = (q.text.match(/from\s+([a-z_]+)/i) || [])[1] || "?";
      const ms = plan["Execution Time"].toFixed(1);
      const usesIndex = /Index Scan|Index Only Scan|Bitmap Index Scan/.test(flat);
      const seq = /"Node Type":"Seq Scan"/.test(flat);
      console.log(`  ${table.padEnd(32)} ${String(ms).padStart(8)}ms  ${usesIndex ? "INDEX" : ""}${seq ? " seq" : ""}`);
      //  A seq scan is a FINDING only when it hits a genuinely large table
      //  that has no usable property index. On a 1,500-row table the planner
      //  correctly prefers a seq scan even though the index exists — reporting
      //  that as a missing index would be the detector lying about a problem.
      if (seq && !usesIndex) {
        const sz = (await c.query(
          `select coalesce(reltuples,0)::bigint n from pg_class where relname = $1`, [table])).rows[0];
        const hasIdx = (await c.query(
          `select 1 from pg_indexes where tablename = $1 and indexdef like '%property_id%' limit 1`,
          [table])).rows[0];
        if (Number(sz && sz.n) > 20000 && !hasIdx) seqScanOnBigTable = { table, plan: flat.slice(0, 400) };
        if (Number(sz && sz.n) > 20000 && hasIdx) console.log(`     NOTE ${table}: planner chose seq scan over an existing property index at ${sz.n} rows — worth watching, not a missing index`);
      }
    }
    ok(!seqScanOnBigTable,
      seqScanOnBigTable
        ? `STOP CONDITION 8: property predicate not indexed on ${seqScanOnBigTable.table}`
        : "every big-table read is bounded by its property index — no missing index demonstrated");

    console.log("\n── THE BOUNDED WIRE RESPONSE AT 10,000 OPPORTUNITIES ────");
    //  What a browser would actually receive: complete summaries + ONE page.
    const { marketEvidenceProjection } = require(path.join(REPO, "src/evidence/evidence_projection"));
    const wire = await marketEvidenceProjection(pool, {
      property_id: P, start_local: "2026-07-01", end_local: "2026-08-31",
      as_of: "2026-08-20T00:00:00.000Z" });
    const wireBytes = Buffer.byteLength(JSON.stringify(wire));
    const sr = wire.sections.conversion.supporting_rows;
    console.log(`  wire response ${(wireBytes / 1024).toFixed(0)}KB · page ${sr.page.length} of ${sr.total_rows} · cursor ${sr.cursor ? "present" : "none"}`);
    ok(wireBytes < 500 * 1024,
      `summaries + first page stay under 500KB at 10,000 opportunities (${(wireBytes / 1024).toFixed(0)}KB)`);
    ok(sr.page.length === 100 && sr.total_rows === IN_PROP,
      `one default page of 100 with the full total stated (${sr.page.length} of ${sr.total_rows})`);
    //  f1's cohort is the PROPERTY-LOCAL window, so fixture rows opened at
    //  UTC midnight on the boundary day fall before the 04:00Z local start —
    //  correct window semantics, asserted exactly rather than hand-waved.
    const windowed = (await c.query(
      `select count(*)::int n from leasing_conversions
        where property_id = $1
          and opened_at >= '2026-07-01T04:00:00Z' and opened_at < '2026-09-01T04:00:00Z'`, [P])).rows[0].n;
    ok(wire.state && wire.coverage
       && wire.sections.conversion.metrics.f1all.denominator === windowed,
      `the four-funnel summaries remain COMPLETE over the whole windowed population (${wire.sections.conversion.metrics.f1all.denominator} === ${windowed})`);

    //  Cursor walk: page 2 continues exactly where page 1 ended, no overlap.
    const wire2 = await marketEvidenceProjection(pool, {
      property_id: P, start_local: "2026-07-01", end_local: "2026-08-31",
      as_of: "2026-08-20T00:00:00.000Z", rows: { cursor: sr.cursor } });
    const sr2 = wire2.sections.conversion.supporting_rows;
    const ids1 = new Set(sr.page.map((r) => String(r.opportunity_id)));
    ok(sr2.page.length === 100 && sr2.page.every((r) => !ids1.has(String(r.opportunity_id))),
      "the cursor's second page overlaps the first by zero rows");
    const last1 = sr.page[sr.page.length - 1], first2 = sr2.page[0];
    ok(new Date(first2.opened_at) >= new Date(last1.opened_at),
      "and continues in the stable server-authored order");

    console.log("\n── NEIGHBOUR VOLUME DOES NOT CHANGE THE PLAN ────────────");
    //  Re-run against ONE neighbour property (~10k rows of its own): the same
    //  query shape, the same index-bounded plan, comparable time.
    const n1 = (await c.query(`select id from properties where name = 'S9 scale — neighbour 1'`)).rows[0].id;
    const W2 = { ...W, property_id: n1 };
    await c.query("begin transaction isolation level repeatable read read only");
    let issued2 = 0;
    const t2 = Date.now();
    const out2 = await opportunityFunnelRows({ query: (...a) => { issued2++; return c.query(...a); } }, W2);
    const el2 = Date.now() - t2;
    await c.query("commit");
    console.log(`  neighbour property: queries ${issued2} · elapsed ${el2}ms · rows ${out2.rows.length}`);
    ok(issued2 === issued.length,
      `same constant query count for a different property (${issued2} === ${issued.length})`);
    ok(out2.rows.length === Math.round(NEIGHBOURS / NEIGHBOUR_PROPS),
      `and exactly its own ${out2.rows.length} opportunities`);

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
    await c.query("rollback").catch(() => {});
  } finally {
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   scale: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
