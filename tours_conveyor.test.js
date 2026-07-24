// ════════════════════════════════════════════════════════════════════
//  tours_conveyor.test.js — the tours board's DAY WINDOW.
//
//  WHAT CHANGED AND WHY THIS TESTS IT
//  ----------------------------------
//  The board could only read forward: the offset was clamped with
//  Math.max(days, 0), so "yesterday" was not expressible in the contract
//  and no UI could page backward regardless of how it was written. The
//  window is now a range of operating days, and terminal tours can be
//  included so a past day describes itself honestly instead of showing
//  only the outcomes nobody captured.
//
//  THREE LAYERS, DELIBERATELY
//    A. the pure decision — resolveTourWindow, every edge, executed
//    B. the real predicates against real Postgres, on seeded rows whose
//       times are computed BY POSTGRES in the property's timezone (no
//       date math in Node — a second date library is a second opinion
//       about what day it is, and that is how this morning's bug worked)
//    C. the ACTUAL board query, extracted from operator.js and run — so
//       a clause that parses but does not execute cannot pass
//
//  Layers B and C build their SQL from tour_window.js, the same module
//  the route uses. A harness asserting against a re-typed WHERE clause
//  proves only that someone can type.
//
//  BACKWARD COMPATIBILITY IS AN ASSERTION, NOT A HOPE. Every existing
//  caller sends no parameters at all. Case A1 and C1 pin that path.
//
//  SAFETY: one transaction, always rolled back. Nothing persists, so the
//  shared Demo Building is never polluted and there is no cleanup to get
//  wrong. No deletes anywhere.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN (Render Web Shell, repo root):  node tours_conveyor.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const TW = require("./tour_window");

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const TZ = "America/New_York";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`); }

// ════════ A. THE PURE DECISION ═══════════════════════════════════════
function testWindowResolution() {
  section("A · window resolution");
  const R = (q) => TW.resolveTourWindow(q);

  const a1 = R({});
  ok("A1. no parameters is today-only (every existing caller)",
    a1.fromOffset === 0 && a1.toOffset === 0 && a1.mode === "legacy_days" && a1.includeTerminal === false,
    JSON.stringify(a1));

  const a2 = R({ days: "6" });
  ok("A2. days=6 is today through six days out (legacy, unchanged)",
    a2.fromOffset === 0 && a2.toOffset === 6, JSON.stringify(a2));

  const a3 = R({ days: "-5" });
  ok("A3. a negative days is clamped to today, never backward",
    a3.fromOffset === 0 && a3.toOffset === 0, JSON.stringify(a3));

  const a4 = R({ days: "999" });
  ok("A4. days is capped at the 30-day ceiling",
    a4.toOffset === TW.MAX_OFFSET, JSON.stringify(a4));

  const a5 = R({ from: "-1" });
  ok("A5. from alone anchors against today (yesterday..today)",
    a5.fromOffset === -1 && a5.toOffset === 0 && a5.mode === "window", JSON.stringify(a5));

  const a6 = R({ to: "6" });
  ok("A6. to alone anchors against today (today..+6)",
    a6.fromOffset === 0 && a6.toOffset === 6, JSON.stringify(a6));

  const a7 = R({ from: "-7", to: "-1" });
  ok("A7. a window entirely in the past is expressible",
    a7.fromOffset === -7 && a7.toOffset === -1, JSON.stringify(a7));

  const a8 = R({ from: "1", to: "-1" });
  ok("A8. a reversed window is refused, not silently swapped",
    !!a8.error && a8.error.code === "TOUR_WINDOW_REVERSED", JSON.stringify(a8));

  const a9 = R({ from: "-30", to: "30" });
  ok("A9. an over-wide window is refused",
    !!a9.error && a9.error.code === "TOUR_WINDOW_TOO_WIDE", JSON.stringify(a9));

  const a10 = R({ from: "-15", to: "15" });
  ok("A10. the widest legal window is accepted",
    !a10.error && a10.toOffset - a10.fromOffset === TW.MAX_SPAN, JSON.stringify(a10));

  const a11 = R({ from: "-99", to: "0" });
  ok("A11. an out-of-range edge clamps rather than erroring",
    a11.fromOffset === -TW.MAX_OFFSET && !a11.error, JSON.stringify(a11));

  const a12 = R({ days: "6", from: "-2" });
  ok("A12. from/to takes precedence over days (stated, not implied)",
    a12.fromOffset === -2 && a12.toOffset === 0, JSON.stringify(a12));

  const a13 = R({ from: "abc" });
  ok("A13. unparseable input falls back to legacy today-only, never NaN",
    a13.fromOffset === 0 && a13.toOffset === 0 && a13.mode === "legacy_days", JSON.stringify(a13));

  const a14 = R({ include_terminal: "1" });
  const a15 = R({ include_terminal: "0" });
  ok("A14. include_terminal is opt-in and defaults off",
    a14.includeTerminal === true && a15.includeTerminal === false);
}

// ════════ SEED (all times computed by Postgres, in the property tz) ═══
//  local(dayOffset, hour) → a timestamptz for that wall-clock time in TZ.
const localExpr = (dayOffset, hour) =>
  `(((now() at time zone '${TZ}')::date + interval '${dayOffset} day' + interval '${hour} hour') at time zone '${TZ}')`;

async function seed(client) {
  const src = (await client.query(
    `insert into lead_sources (name, source_type) values ($1,'manual')
     on conflict (name) do update set name = excluded.name returning id`,
    ["harness_conveyor"])).rows[0];

  const person = (await client.query(
    `insert into persons (name, phone, primary_phone_e164, lifecycle_status, leasing_stage, source)
     values ($1,$2,$3,'prospect','inquiry',$4) returning id`,
    ["Harness Conveyor Probe", "+15005550002", "+15005550002", "harness_conveyor"])).rows[0];

  const lead = (await client.query(
    `insert into leasing_leads (person_id, property_id, source_id, message)
     values ($1,$2,$3,'harness') returning id`,
    [person.id, DEMO_PROPERTY_ID, src.id])).rows[0];

  // one tour per case; slots give ends_at so phase is computable
  async function mk(dayOffset, hour, status) {
    const slot = (await client.query(
      `insert into tour_availability (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, status)
       values ($1, null, null, ${localExpr(dayOffset, hour)}, ${localExpr(dayOffset, hour)} + interval '30 minutes', 1, 'booked')
       returning id, starts_at`, [DEMO_PROPERTY_ID])).rows[0];
    const tour = (await client.query(
      `insert into leasing_tours (lead_id, property_id, slot_id, scheduled_for, status)
       values ($1,$2,$3,$4,$5) returning id, scheduled_for`,
      [lead.id, DEMO_PROPERTY_ID, slot.id, slot.starts_at, status])).rows[0];
    return tour;
  }

  return {
    lead,
    yesterdayLive: await mk(-1, 10, "scheduled"),
    yesterdaySettled: await mk(-1, 14, "completed"),
    todayLive: await mk(0, 10, "scheduled"),
    tomorrowLive: await mk(1, 10, "scheduled"),
    // 8pm Eastern is 00:00 UTC the NEXT day — the boundary that makes a
    // UTC-based board put a tour on the wrong page.
    todayEvening: await mk(0, 20, "scheduled"),
  };
}

// ════════ B. THE REAL PREDICATES ═════════════════════════════════════
async function testPredicates(client, ids) {
  section("B · window + status predicates on real Postgres");

  const all = new Set(Object.values(ids).filter((x) => x && x.id).map((x) => x.id));
  async function read(from, to, includeTerminal) {
    const sql =
      `select t.id, t.status,
              ${TW.operatingDateExpr("$2")} as operating_date,
              ${TW.isTerminalExpr()} as is_terminal
         from leasing_tours t
        where t.property_id = $1
          and ${TW.windowPredicate("$2", "$3", "$4")}
          and ${TW.statusPredicate("$5")}
        order by t.scheduled_for`;
    const r = await client.query(sql, [DEMO_PROPERTY_ID, TZ, from, to, includeTerminal]);
    return r.rows.filter((x) => all.has(x.id));   // ignore the property's real tours
  }

  const b1 = await read(0, 0, false);
  ok("B1. today-only returns exactly today's live tours",
    b1.length === 2 && b1.some((x) => x.id === ids.todayLive.id) && b1.some((x) => x.id === ids.todayEvening.id),
    `got ${b1.length}`);

  const b2 = await read(-1, 0, false);
  ok("B2. yesterday..today reaches backward — the point of the change",
    b2.length === 3 && b2.some((x) => x.id === ids.yesterdayLive.id),
    `got ${b2.length}`);

  ok("B3. the settled tour is excluded by default",
    !b2.some((x) => x.id === ids.yesterdaySettled.id));

  const b4 = await read(-1, 0, true);
  ok("B4. include_terminal brings the settled tour back",
    b4.length === 4 && b4.some((x) => x.id === ids.yesterdaySettled.id),
    `got ${b4.length}`);

  ok("B5. the settled tour is labelled, not just present",
    b4.some((x) => x.id === ids.yesterdaySettled.id && x.is_terminal === true));

  const b6 = await read(1, 1, false);
  ok("B6. a future-only window excludes today",
    b6.length === 1 && b6[0].id === ids.tomorrowLive.id, `got ${b6.length}`);

  const b7 = await read(-1, -1, false);
  ok("B7. a past-only window excludes today",
    b7.length === 1 && b7[0].id === ids.yesterdayLive.id, `got ${b7.length}`);

  // The boundary. In UTC this tour is tomorrow; on the board it is today.
  const b8 = (await read(0, 0, false)).find((x) => x.id === ids.todayEvening.id);
  const today = (await client.query(
    `select (now() at time zone $1)::date as d`, [TZ])).rows[0].d;
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  ok("B8. an 8pm tour belongs to TODAY, not to the next UTC day",
    !!b8 && iso(b8.operating_date) === iso(today),
    b8 ? `operating_date=${iso(b8.operating_date)} today=${iso(today)}` : "row missing");
}

// ════════ C. THE ACTUAL BOARD QUERY ══════════════════════════════════
//  Extracted from operator.js and executed. A clause can parse and still
//  fail against the real schema; only running it settles that.
async function testRealQuery(client, ids) {
  section("C · the board query as operator.js builds it");

  let sql = null;
  try {
    const src = fs.readFileSync(path.join(process.cwd(), "operator.js"), "utf8");
    const cte = /const PROJECTION_CTE = `([\s\S]*?)`;/.exec(src)[1];
    const i = src.indexOf("PROJECTION_CTE + `,\n        proj as ( select conversation_id");
    const j = src.indexOf("order by scheduled_for`", i) + "order by scheduled_for".length;
    const body = src.slice(i + "PROJECTION_CTE + `".length, j);
    // render the template literal with TW in scope, exactly as the route does
    // eslint-disable-next-line no-eval
    sql = cte + eval("`" + body.replace(/`/g, "\\`") + "`");
  } catch (e) {
    ok("C0. the board query could be located in operator.js", false,
      `${e.message} — if operator.js was reformatted, update this extractor`);
    return;
  }
  ok("C0. the board query could be located in operator.js", true);

  const GRACE = 15;
  async function board(from, to, includeTerminal) {
    const r = await client.query(sql, [DEMO_PROPERTY_ID, TZ, GRACE, from, to, includeTerminal]);
    const mine = new Set(Object.values(ids).filter((x) => x && x.id).map((x) => x.id));
    return r.rows.filter((x) => mine.has(x.id));
  }

  const c1 = await board(0, 0, false);
  ok("C1. the default window executes and returns today's live tours",
    c1.length === 2, `got ${c1.length}`);

  const c2 = await board(-1, 0, true);
  ok("C2. a backward window with terminal tours executes",
    c2.length === 4, `got ${c2.length}`);

  const settled = c2.find((x) => x.id === ids.yesterdaySettled.id);
  ok("C3. a settled tour buckets as 'settled', never as work to capture",
    !!settled && settled.primary_bucket === "settled",
    settled ? `bucket=${settled.primary_bucket}` : "row missing");

  ok("C4. a settled tour carries no open issues",
    !!settled && Array.isArray(settled.open_issues) && settled.open_issues.length === 0,
    settled ? `open_issues=${JSON.stringify(settled.open_issues)}` : "row missing");

  const pastLive = c2.find((x) => x.id === ids.yesterdayLive.id);
  ok("C5. yesterday's uncaptured tour is past and needs its outcome",
    !!pastLive && pastLive.phase === "past" && pastLive.primary_bucket === "outcomes_needing_capture"
      && pastLive.primary_action_key === "capture_outcome",
    pastLive ? `phase=${pastLive.phase} bucket=${pastLive.primary_bucket}` : "row missing");

  ok("C6. every returned row carries an operating_date",
    c2.every((x) => x.operating_date != null));
}

// ════════ MAIN ═══════════════════════════════════════════════════════
async function main() {
  testWindowResolution();

  if (!process.env.DATABASE_URL) {
    lines.push("\n  note  DATABASE_URL not set — layers B and C skipped.");
    report();
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ids = await seed(client);
    await testPredicates(client, ids);
    await testRealQuery(client, ids);
  } catch (e) {
    failed++;
    lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }
  report();
}

function report() {
  const bar = "─".repeat(66);
  console.log(`\n${bar}\nTOURS CONVEYOR — DAY WINDOW CONTRACT\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted. Fix the failures above and re-run."
    : "The board can read backward and forward, and a past day tells the truth about itself.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
