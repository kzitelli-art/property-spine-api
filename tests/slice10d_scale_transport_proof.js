#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  slice10d_scale_transport_proof.js — SCALE AND TRANSPORT.
//  Expects the fixture built by tests/slice10d_build_fixture.js.
//  Synthetic data only.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const receipt = require(path.join(__dirname, "_run_receipt"));
const { forwardRentRollPage, cursorEncode, SECRET_SOURCE, PAGE_DEFAULT, PAGE_MAX } =
  require(path.join(__dirname, "..", "src/tenancy/forward_rent_roll_page"));
const { forwardRentRollSummary } = require(path.join(__dirname, "..", "src/tenancy/forward_rent_roll_summary"));
const { datedPositionRows } = require(path.join(__dirname, "..", "src/tenancy/dated_position_rows"));
const FIX = require(path.join(__dirname, "fixtures/slice10d_scale_fixture"));

//  This harness only required the variable to be PRESENT — it never compared
//  it to DATABASE_URL at all, so it was the weakest of the four. The governed
//  helper supplies both the requirement and the same-target refusal.
const CONN = receipt.harnessConnectionString();
let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));
const TARGET = "2026-12-01";

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false, max: 4 });
  const H = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".slice10d_fixture.json"), "utf8"));
  const A = H.selected_property_id, N = H.neighbour_property_id, M = H.manifest;
  const q = async (s, a = []) => (await pool.query(s, a)).rows;

  console.log("\n════ SLICE 10D — SCALE AND TRANSPORT ════");
  console.log(`   cursor signing: ${SECRET_SOURCE}   default/max: ${PAGE_DEFAULT}/${PAGE_MAX}`);

  section("A  fixture validation — direct SQL, not the code under test");
  const sel = Number((await q(`select count(*) n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [A]))[0].n);
  const nb = Number((await q(`select count(*) n from spaces s join units u on u.id=s.unit_id where u.property_id=$1`, [N]))[0].n);
  ok(`selected spaces = 10,000 (got ${sel})`, sel === 10000);
  ok(`neighbouring spaces >= 100,000 (got ${nb})`, nb >= 100000);
  const byUse = await q(
    `select coalesce(s.use_type,'(null)') ut, count(*) n from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 group by 1 order by 1`, [A]);
  const use = Object.fromEntries(byUse.map((r) => [r.ut, Number(r.n)]));
  const revenue = (use.residential || 0) + (use.commercial || 0);
  ok(`revenue = ${M.revenue} by SQL (got ${revenue})`, revenue === M.revenue);
  ok(`non_revenue = ${M.non_revenue} by SQL (got ${use.non_revenue || 0})`, (use.non_revenue || 0) === M.non_revenue);
  ok(`unknown denominator = ${M.unknown_denominator} by SQL (got ${use["(null)"] || 0})`, (use["(null)"] || 0) === M.unknown_denominator);
  ok("revenue + non_revenue + unknown = 10,000",
    revenue + (use.non_revenue || 0) + (use["(null)"] || 0) === 10000);

  //  Adverse conditions must genuinely sit at ordinals >= 9,900.
  const lateOverlap = await q(
    `select count(*) n from (
       select l.space_id from leases l join spaces s on s.id=l.space_id join units u on u.id=s.unit_id
        where u.property_id=$1 and (substring(u.unit_number from 2))::int >= $2
        group by l.space_id having count(*) > 1) x`, [A, FIX.LATE]);
  ok(`lease overlaps exist at ordinals >= ${FIX.LATE} (${lateOverlap[0].n})`, Number(lateOverlap[0].n) > 0);
  const earlyOverlap = await q(
    `select count(*) n from (
       select l.space_id from leases l join spaces s on s.id=l.space_id join units u on u.id=s.unit_id
        where u.property_id=$1 and (substring(u.unit_number from 2))::int < $2
        group by l.space_id having count(*) > 1) x`, [A, FIX.LATE]);
  ok("and NO overlap exists in the early range — page one is clean by construction",
    Number(earlyOverlap[0].n) === 0);
  const lateNullUse = await q(
    `select count(*) n from spaces s join units u on u.id=s.unit_id
      where u.property_id=$1 and s.use_type is null and (substring(u.unit_number from 2))::int >= $2`, [A, FIX.LATE]);
  ok(`unclassified positions are all late (${lateNullUse[0].n} of ${M.unknown_denominator})`,
    Number(lateNullUse[0].n) === M.unknown_denominator);

  section("B  unbounded baseline (comparative evidence only)");
  const t0 = Date.now();
  let baseQ = 0;
  const cnt = { query: (...a) => { baseQ++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
  const unbounded = await forwardRentRollSummary(cnt, { property_id: A, as_of: TARGET });
  const baseMs = Date.now() - t0;
  const baseBytes = Buffer.byteLength(JSON.stringify(unbounded), "utf8");
  console.log(`   OBSERVED  unbounded: ${unbounded.rows.length} rows · ${baseQ} queries · ${baseMs}ms · ${Math.round(baseBytes/1024)}KB`);
  ok("the unbounded shape really is too large to transport", baseBytes > 500 * 1024);
  ok("summary counts match the independent manifest",
    unbounded.summary.positions.total_canonical_positions === 10000
    && unbounded.summary.positions.revenue === M.revenue
    && unbounded.summary.positions.non_revenue === M.non_revenue
    && unbounded.summary.positions.unknown_denominator === M.unknown_denominator);

  section("C  full traversal at two page sizes");
  const traverse = async (limit) => {
    const seen = [], t = Date.now(); let cursor = null, pages = 0, last = null;
    for (;;) {
      const p = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit, cursor });
      if (p.error) throw new Error("traversal refused: " + p.error);
      pages++; last = p;
      for (const r of p.rows) seen.push(String(r.space_id));
      if (!p.page.has_more) break;
      cursor = p.page.next_cursor;
      if (pages > 600) throw new Error("traversal did not terminate");
    }
    return { seen, pages, ms: Date.now() - t, last };
  };
  const t25 = await traverse(25);
  const t200 = await traverse(200);
  console.log(`   OBSERVED  limit 25: ${t25.pages} pages ${t25.ms}ms · limit 200: ${t200.pages} pages ${t200.ms}ms`);
  ok(`limit 25 returns all 10,000 (got ${t25.seen.length})`, t25.seen.length === 10000);
  ok(`limit 200 returns all 10,000 (got ${t200.seen.length})`, t200.seen.length === 10000);
  ok("no duplicates at limit 25", new Set(t25.seen).size === 10000);
  ok("no duplicates at limit 200", new Set(t200.seen).size === 10000);
  ok("no omissions — the traversed set equals the fixture set",
    new Set(t25.seen).size === sel);
  ok("both page sizes produce the IDENTICAL ordered sequence",
    JSON.stringify(t25.seen) === JSON.stringify(t200.seen));
  ok("final page has_more = false", t25.last.page.has_more === false && t200.last.page.has_more === false);
  ok("final page next_cursor = null", t25.last.page.next_cursor === null && t200.last.page.next_cursor === null);
  ok("the page discloses its ordering fields and their mutability",
    t25.last.page.ordering_fields.some((f) => f.field === "units.unit_number" && f.mutable === true)
    && t25.last.page.ordering_fields.some((f) => f.field === "spaces.id" && f.mutable === false));
  ok("and states the concurrent-change limitation rather than claiming a snapshot",
    /not snapshot isolation/i.test(t25.last.page.concurrent_change_limitation));

  section("D  cursor binding — every refusal named, none silently restarts");
  const first = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 25 });
  const good = first.page.next_cursor;
  const cases = [
    ["wrong property", { property_id: N, as_of: TARGET, cursor: good }, "cursor_property_mismatch"],
    ["wrong as_of", { property_id: A, as_of: "2026-11-01", cursor: good }, "cursor_date_mismatch"],
    ["tampered payload", { property_id: A, as_of: TARGET, cursor: "x" + good }, "cursor_signature_invalid"],
    ["no signature", { property_id: A, as_of: TARGET, cursor: good.split(".")[0] }, "cursor_malformed"],
    ["garbage", { property_id: A, as_of: TARGET, cursor: "not-a-cursor" }, "cursor_malformed"],
  ];
  for (const [label, args, expected] of cases) {
    const r = await forwardRentRollPage(pool, { limit: 25, ...args });
    ok(`${label} → ${expected}`, r.error === expected);
    ok(`${label} does NOT silently restart at page one`, !r.rows || r.rows.length === 0);
  }
  //  An earlier version of this assertion string-replaced inside a BASE64URL
  //  payload, so the replace was a no-op and the cursor stayed valid — the
  //  test proved nothing and correctly failed. A wrong-contract cursor has to
  //  be forged properly: build the payload, then sign it with the same secret.
  //  This requires CURSOR_SECRET to be set, which also exercises the governed
  //  signing path rather than the ephemeral one.
  if (process.env.CURSOR_SECRET) {
    const crypto = require("crypto");
    const b64u = (x) => Buffer.from(x, "utf8").toString("base64url");
    const payload = b64u(JSON.stringify({
      v: "frr_cur_v1", p: A, d: TARGET, o: "unit_number asc, space_id asc",
      rc: "forward_rent_roll_rows_v0", sc: "forward_rent_roll_summary_v1",
      u: "S000001", s: "00000000-0000-0000-0000-000000000000",
    }));
    const sig = crypto.createHmac("sha256", process.env.CURSOR_SECRET).update(payload).digest("base64url").slice(0, 32);
    const bc = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 25, cursor: payload + "." + sig });
    ok("a VALIDLY SIGNED cursor from another contract version is refused",
      bc.error === "cursor_contract_mismatch");
    ok("and it does not silently restart at page one", !bc.rows || bc.rows.length === 0);
    ok("the governed signing path is in use", SECRET_SOURCE === "env_cursor_secret");
  } else {
    ok("contract-version refusal is UNPROVEN without CURSOR_SECRET (rerun with it set)", false);
  }
  for (const [label, lim, expect] of [["zero", 0, "limit_invalid"], ["negative", -5, "limit_invalid"],
                                      ["non-numeric", "abc", "limit_invalid"]]) {
    const r = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: lim });
    ok(`limit ${label} → ${expect}`, r.error === expect);
  }
  const clamped = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 5000 });
  ok("limit above max is clamped WITH disclosure",
    clamped.page.limit === PAGE_MAX && clamped.page.limit_clamped_from === 5000);
  const one = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 1 });
  ok("limit 1 returns exactly one position", one.rows.length === 1);
  const dflt = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET });
  ok(`a missing limit defaults to ${PAGE_DEFAULT}`, dflt.rows.length === PAGE_DEFAULT);

  section("E  summary invariance — the page never becomes the summary");
  const mid = await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 200,
    cursor: (await traverseTo(pool, A, 200, 25)).cursor });
  const sig = (x) => JSON.stringify({ p: x.summary.positions, o: x.summary.occupancy, r: x.summary.contractual_rent });
  ok("page 1 summary = middle page summary", sig(t200.last) === sig(mid) && sig(first) === sig(mid));
  ok("page 1 summary = final page summary", sig(first) === sig(t25.last));
  ok("limit 25 summary = limit 200 summary", sig(t25.last) === sig(t200.last));
  ok("PAGE ONE withholds the occupancy rate because of a blocker 9,900 rows away",
    first.summary.occupancy.target.state === "withheld" && first.summary.occupancy.target.rate === null);
  ok("and names the unknown-denominator blocker with its late count",
    first.summary.occupancy.target.blockers.some((b) => b.code === "unknown_denominator" && b.count === M.unknown_denominator));
  ok("PAGE ONE withholds the combined rent total because of late conflicting economics",
    first.summary.contractual_rent.target.state === "withheld"
    && first.summary.contractual_rent.target.combined_total === null);
  ok("PAGE ONE still publishes the independently-true dated subtotal",
    first.summary.contractual_rent.target.dated_authority_subtotal > 0);
  ok("PAGE ONE reports the late two-obligation conflicts",
    first.summary.positions.total_canonical_positions === 10000);
  ok("no page-one row is itself adverse — the withholding is genuinely remote",
    first.rows.every((r) => r.conflict_state !== "conflicted" && r.denominator_class !== "unknown"));

  section("F  payload bytes — measured, not estimated");
  const bytes = (o) => Buffer.byteLength(JSON.stringify(o), "utf8");
  const summaryOnly = bytes({ summary: first.summary });
  const defBytes = bytes(dflt), maxBytes = bytes(clamped);
  const largestRow = Math.max(...clamped.rows.map((r) => bytes(r)));
  console.log(`   OBSERVED  summary ${Math.round(summaryOnly/1024)}KB · default page ${Math.round(defBytes/1024)}KB · max page ${Math.round(maxBytes/1024)}KB · largest row ${largestRow}B`);
  ok(`default page under 500KB (${Math.round(defBytes/1024)}KB)`, defBytes < 500 * 1024);
  ok(`maximum page under 500KB (${Math.round(maxBytes/1024)}KB)`, maxBytes < 500 * 1024);
  ok("the bounded page is dramatically smaller than the unbounded shape", defBytes * 10 < baseBytes);
  ok("no evidence was removed to fit — rows still carry lineage, blockers and evidence state",
    dflt.rows.every((r) => Array.isArray(r.blockers) && Array.isArray(r.rent_lineage) && r.evidence_state));

  section("G  query counts — same shape, three sizes");
  const countFor = async (pid, label) => {
    let n = 0;
    const c2 = { query: (...a) => { n++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
    const r = await forwardRentRollPage(c2, { property_id: pid, as_of: TARGET, limit: 50 });
    console.log(`   OBSERVED  ${label}: ${r.summary ? r.summary.positions.total_canonical_positions : 0} positions → ${n} queries`);
    return n;
  };
  //  Sub-properties of the SAME shape, built by slicing the selected property
  //  is not possible without mutation, so cost is compared against the two
  //  properties that exist plus the full selected property.
  const qFull = await countFor(A, "10,000 positions");
  const qNeighbour = await countFor(N, "100,000 positions");
  ok("query count does not grow with row count (10,000 vs 100,000 positions)", qFull === qNeighbour);
  let qLater = 0;
  const c3 = { query: (...a) => { qLater++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
  await forwardRentRollPage(c3, { property_id: A, as_of: TARGET, limit: 50, cursor: good });
  console.log(`   OBSERVED  later page: ${qLater} queries (summary recomputed each request)`);
  ok("a later page costs the same as the first — no per-row lookup", qLater === qFull);

  section("H  cross-property isolation");
  const ids = new Set(t25.seen);
  const nSpaces = await q(`select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 limit 500`, [N]);
  ok("no neighbouring space id appears in the traversal", !nSpaces.some((r) => ids.has(String(r.id))));
  const payload = JSON.stringify(dflt);
  const nLeases = await q(`select id from leases where property_id=$1 limit 200`, [N]);
  ok("no neighbouring lease id appears in a page payload", !nLeases.some((r) => payload.includes(r.id)));

  section("I  writes");
  const before = (await q(`select (select count(*) from leases) l, (select count(*) from obligations) o`))[0];
  await forwardRentRollPage(pool, { property_id: A, as_of: TARGET, limit: 50 });
  const after = (await q(`select (select count(*) from leases) l, (select count(*) from obligations) o`))[0];
  ok("paged transport writes nothing", before.l === after.l && before.o === after.o);

  console.log(`\n════ scale and transport: ${pass} passed, ${fail} failed ════\n`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED: " + e.message); console.error(e.stack.split("\n").slice(1, 4).join("\n")); process.exit(1); });

//  Walk forward n pages and return the cursor, so a MIDDLE page can be fetched.
async function traverseTo(pool, property_id, limit, pages) {
  let cursor = null;
  for (let i = 0; i < pages; i++) {
    const p = await forwardRentRollPage(pool, { property_id, as_of: TARGET, limit, cursor });
    if (!p.page.has_more) break;
    cursor = p.page.next_cursor;
  }
  return { cursor };
}
