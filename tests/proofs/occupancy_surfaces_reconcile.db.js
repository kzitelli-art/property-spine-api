#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   occupancy_surfaces_reconcile.db.js — READ EVERYWHERE MEANS RECONCILE
   EVERYWHERE (PHILOSOPHY §33).

   The canonical dated read (dated_positions.js) decides whether a lease
   spans today. Five operator surfaces counted `lease_status = 'active'`
   with no date at all, so an imported lease whose term ended last year
   read as occupied on the desk, the board and the management header while
   the Rent Roll said the position was open. Two screens, one bed, opposite
   answers.

   This proof seeds the four hostile states — a lease that spans today, one
   that ENDED, one that has not STARTED, and one that has started but is
   still pending activation — and asserts that every surface agrees with
   the canonical bucket count. It must go RED when the span rule is removed
   from any surface (falsified on first landing: 3 vs 1).

   Real Postgres, real routers, real socket. HARNESS_DATABASE_URL required (same-target guarded).
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require("pg");
const express = require("express");
const http = require("http");

const receipt = require("../_run_receipt");
const URL_ = receipt.harnessConnectionString(); // refuses when it is the same target as DATABASE_URL
const KEY = process.env.OPERATOR_KEY || "reconcile-key";
process.env.OPERATOR_KEY = KEY;

const { datedPropertyPositions, rentRollBuckets } = require(path.join(ROOT, "src/tenancy/dated_positions"));
const { occupancyByBasis } = require(path.join(ROOT, "src/leasing/leasing_occupancy_facts"));
const { availabilityRead } = require(path.join(ROOT, "src/surfaces/availability_read"));
const { futureRentRollFacts } = require(path.join(ROOT, "src/surfaces/future_rent_roll_facts"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok   ", n); } else { fail++; console.log("  FAIL ", n); if (d) console.log("        " + String(d).slice(0, 400)); } };
const find = (obj, key) => { // first value of `key` anywhere in a JSON tree
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) { const r = find(v, key); if (r !== undefined) return r; }
  return undefined;
};

(async () => {
  const pool = new Pool({ connectionString: URL_, ssl: false });
  const q = (sql, p) => pool.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  const TAG = "reconcile-" + Date.now();

  // ── SEED: one property, four units, four hostile lease states ──
  const prop = (await one(`insert into properties (name, leasing_basis) values ($1, 'unit') returning id`, [TAG])).id;
  const person = async (n) => (await one(`insert into persons (name) values ($1) returning id`, [n])).id;
  const unit = async (n) => (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [prop, n])).id;
  const space = async (u) => (await one(`select id from spaces where unit_id=$1 order by created_at limit 1`, [u])).id;
  const lease = async (u, status, start, end) => q(
    `insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
     values ($1,$2,$3,$4,$5,$6,1200)`, [prop, await space(u), [await person("R " + u)], status, start, end]);
  const iso = (days) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const u1 = await unit("101"), u2 = await unit("102"), u3 = await unit("103"), u4 = await unit("104");
  //  Availability refuses to market a space with no governed use — correct,
  //  and not what this proof is about. Give every space its purpose.
  await q(`update spaces set use_type = 'residential' where unit_id = any($1::uuid[])`, [[u1, u2, u3, u4]]);
  await lease(u1, "active",  iso(-30), null);          // spans today            → occupied
  await lease(u2, "active",  "2024-01-01", "2024-12-31"); // ENDED, still 'active' → open
  await lease(u3, "active",  null, null);              // no start date          → not spanning
  await lease(u4, "pending", iso(-5), iso(360));       // commenced, pending     → activation_pending

  // ── THE CANONICAL ANSWER ──
  const dp = await datedPropertyPositions(pool, { property_id: prop });
  const buckets = rentRollBuckets(dp.positions);
  ok("canonical: exactly ONE position is occupied (the spanning lease)", buckets.occupied === 1, JSON.stringify(buckets));
  ok("canonical: the commenced pending lease is activation_pending, not open", buckets.activation_pending === 1, JSON.stringify(buckets));
  ok("canonical: the ended lease and the dateless lease are NOT occupied", buckets.open + buckets.needs_review + buckets.not_established + buckets.unclassified === 2, JSON.stringify(buckets));

  // ── SURFACE 1: the leasing occupancy fact ──
  const fact = await occupancyByBasis(pool, prop);
  ok("leasing_occupancy_facts agrees with the canonical occupied count", fact.status === "ok" && fact.occupied_count === buckets.occupied, JSON.stringify(fact));

  // ── SURFACES 2–4 over real routers on a real socket ──
  const app = express(); app.use(express.json());
  app.use("/", require(path.join(ROOT, "src/surfaces/management"))({ pool }));
  app.use("/", require(path.join(ROOT, "src/surfaces/desks"))({ pool }));
  app.use("/", require(path.join(ROOT, "src/surfaces/board"))({ pool }));
  const srv = http.createServer(app); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => { const r = await fetch(base + p, { headers: { "x-operator-key": KEY } }); return { status: r.status, body: await r.json().catch(() => null) }; };

  const mgmt = await get(`/properties/${prop}/management-surface`);
  const occ = mgmt.body && mgmt.body.header && mgmt.body.header.occupancy;
  const occUnits = occ && occ.current && occ.current.units && occ.current.units.occupied;
  ok("management-surface header counts ONE occupied unit (was 3: every 'active' row)", occUnits === buckets.occupied, JSON.stringify(occ));

  const home = await get(`/properties/${prop}/operator-home`);
  const homeOcc = find(home.body, "occupied_units");
  ok("operator-home desk occupancy agrees (occupied_units)", home.status === 200 && (homeOcc === undefined || homeOcc === buckets.occupied), `status ${home.status} occupied_units=${homeOcc} ${JSON.stringify(home.body).slice(0, 200)}`);
  const homeLabel = JSON.stringify(home.body || {});
  ok("operator-home never says '75% occupied' for a property with one spanning lease of four", !/7[45]% occupied/.test(homeLabel), homeLabel.slice(0, 200));

  const today = await get(`/properties/${prop}/today`);
  const tl = today.body && today.body.sections && today.body.sections.tenant_line;
  ok("board tenant-line counts residents on SPANNING leases only", tl && tl.status === "ok" && tl.occupants === buckets.occupied, JSON.stringify(tl));

  // ── SURFACE 5: availability — a bed the Rent Roll calls occupied is not inventory; an ended lease is ──
  const av = await availabilityRead(pool, { property_id: prop });
  const rows = (av && (av.rows || av.positions)) || [];
  const byUnit = Object.fromEntries(rows.map((r) => [r.unit_number, r.marketing_state && (r.marketing_state.state || r.marketing_state)]));
  ok("availability: the spanning lease's unit is NOT marketable", byUnit["101"] && byUnit["101"] !== "marketable_now", JSON.stringify(byUnit));
  ok("availability: the ENDED lease's unit IS marketable now", byUnit["102"] === "marketable_now", JSON.stringify(byUnit));
  ok("availability: the commenced pending lease reads activation_pending", byUnit["104"] === "activation_pending", JSON.stringify(byUnit));

  // ── SURFACE 6: future rent roll — a commenced pending lease is committed, not open ──
  const fr = await futureRentRollFacts(pool, { property_id: prop });
  const frRows = (fr && (fr.rows || fr.positions)) || [];
  const fr104 = frRows.find((r) => r.unit_number === "104");
  ok("future rent roll: unit 104 (pending, commenced) is not open_or_uncovered", fr104 && fr104.future_state !== "open_or_uncovered", JSON.stringify(fr104));

  srv.close(); await pool.end();
  console.log(`\n  ${fail ? "✗ FAIL" : "✓ PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
