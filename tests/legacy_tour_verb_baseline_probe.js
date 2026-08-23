#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  legacy_tour_verb_baseline_probe.js — DID I BREAK IT, OR WAS IT BROKEN?
//
//  Exercising the reminder and correct-outcome routes through their new
//  session doors produced two database check-constraint violations. Before
//  either is reported as a product defect, the LEGACY shared-key doors are
//  driven directly. They call the same extracted service. If they fail the
//  same way here and at the pre-extraction commit, the defect predates this
//  packet and the extraction is exonerated.
//
//  Run this file at HEAD and again with the working tree stashed. Same two
//  failures both times = pre-existing.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3119);
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const h = { "content-type": "application/json", "x-operator-key": KEY,
                "content-length": Buffer.byteLength(data) };
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject);
    r.write(data); r.end();
  });
}

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  process.env.DATABASE_URL = CONN;
  process.env.OPERATOR_KEY = KEY;
  process.env.PORT = String(PORT);
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1500));

  const u = "lbp" + Date.now().toString(36);
  const prop = (await pool.query(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [u + " P"])).rows[0].id;
  const mkTour = async () => {
    const p = (await pool.query(`insert into persons (name, lifecycle_status)
      values ($1,'lead') returning id`, [u + Math.random().toString(36).slice(2, 8)])).rows[0].id;
    const lead = (await pool.query(`insert into leasing_leads (person_id, property_id, status, received_at)
      values ($1,$2,'new', now()) returning id`, [p, prop])).rows[0].id;
    return (await pool.query(`insert into leasing_tours (lead_id, property_id, scheduled_for, status)
      values ($1,$2, now() + interval '2 hours', 'scheduled') returning id`, [lead, prop])).rows[0].id;
  };

  const results = [];

  //  CONTROL — confirm-prospect goes through the same extracted-service
  //  shape. If it works, the extraction pattern itself is sound.
  const tc = await mkTour();
  const rc = await req("POST", `/leasing/tours/${tc}/confirm-prospect`, {});
  results.push(["confirm-prospect (legacy key door)", rc.status]);

  const t1 = await mkTour();
  const r1 = await req("POST", `/leasing/tours/${t1}/reminder`, {});
  results.push(["reminder (legacy key door)", r1.status]);

  //  correct-outcome needs a completed tour to correct.
  const t2 = await mkTour();
  await req("POST", `/leasing/tours/${t2}/complete`, {
    feedback: { interest_level: "warm", next_step: "follow_up", tour_given: true, disposition: "keep_working" } });
  const r2 = await req("POST", `/leasing/tours/${t2}/correct-outcome`, {
    reason: "baseline probe", revised: { disposition: "start_application" } });
  results.push(["correct-outcome (legacy key door)", r2.status]);

  console.log("\n──────── LEGACY SHARED-KEY DOORS, DRIVEN DIRECTLY ────────");
  results.forEach(([n, s]) => console.log(`   ${s === 200 ? "OK    " : "BROKEN"}  ${n}  →  HTTP ${s}`));
  console.log("\n   constraint the DB rejected on, if any:");
  [["reminder", r1], ["correct-outcome", r2]].forEach(([n, r]) => {
    const msg = (r.body && (r.body.error || r.body.receipt)) || r.raw.slice(0, 160);
    if (r.status !== 200) console.log(`     ${n}: ${msg}`);
  });
  await pool.end();
  process.exit(0);
})().catch((e) => { console.error("DIED:", e.message); process.exit(1); });
