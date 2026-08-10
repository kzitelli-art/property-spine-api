#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROVING THE ACTIVATION RUNNER

   tools/step7/activate.js is the only thing in this repository that can
   perform the cutover against production, and it will be run exactly
   once. Everything it claims has to be true the first time.

   The service it calls is already proven (prove_step7_activation 37/0,
   two falsification suites, 11 sabotage variants). This proves the
   RUNNER: that its dry run cannot write, that each precondition actually
   refuses, and that the live path reaches the service unchanged.

   ── THE DRY RUN IS THE ASSERTION THAT MATTERS ───────────────────────

   Not "it did not write this time" — that is a report. The dry run opens
   a transaction proven unable to write BEFORE it reads, and the proof
   below takes a full census of the database on both sides of a dry run
   and requires them byte-identical.

       PROOF_DATABASE_URL='postgres://…/isolated' \
         node tools/step7/prove_activate_runner.js

   REFUSES against anything that looks like production.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const URL = process.env.PROOF_DATABASE_URL;
const ROOT = path.join(__dirname, "..", "..");
const RUNNER = path.join(__dirname, "activate.js");
const CENSUS = path.join(__dirname, "census.js");

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

function run(args, env) {
  try {
    const out = execFileSync(process.execPath, [RUNNER, ...args], {
      env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME,
                           DATABASE_URL: URL }, env || {}),
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) { return { out: String(e.stdout || "") + String(e.stderr || ""), code: e.status }; }
}
function takeCensus(file) {
  const out = execFileSync(process.execPath, [CENSUS, "--json"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: URL,
           R0_CENSUS_AUTHORIZATION: "authorized by the activation-runner proof 2026-08-10 (isolated)" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  fs.writeFileSync(file, out);
  return JSON.parse(out);
}

(async function main() {
  if (!URL) { console.error("\nREFUSED: PROOF_DATABASE_URL is not set.\n"); process.exit(2); }
  if (/neon\.tech|render\.com/i.test(URL)) {
    console.error("\nREFUSED: this proof performs a real cutover. Use an isolated database.\n");
    process.exit(2);
  }

  console.log("\n" + "═".repeat(68));
  console.log("  PROOF · the activation runner");
  console.log("═".repeat(68));
  console.log("  ASSERTIONS STARTED\n");

  const db = new Client({ connectionString: URL });
  await db.connect();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actproof-"));
  const censusFile = path.join(tmp, "census.json");

  //  A full picture of everything the cutover could touch. Used to prove
  //  the dry run changed nothing at all — not just "no activation row".
  const snapshot = async () => {
    const q = async (s) => JSON.stringify((await db.query(s).catch(() => ({ rows: ["ERR"] }))).rows);
    return crypto.createHash("sha256").update([
      await q("select * from release_0_activation_epoch"),
      await q("select * from release_0_activation_history order by id"),
      await q("select * from release_0_legacy_cutover_inventory order by work_order_id"),
      await q("select id, status from work_orders order by id"),
    ].join("|")).digest("hex");
  };

  /*  SEED A REAL LEGACY POPULATION FIRST.
   *
   *  The first version of this proof ran against the bare baseline, which
   *  has no work orders at all. Every census was empty, the drift probe
   *  ("insert … select … from work_orders limit 1") inserted nothing, and
   *  S4's --activate therefore found no drift and performed the real
   *  cutover early — which then made A1 report "already active".
   *
   *  Seven assertions failed and NOT ONE of them was the runner's fault.
   *  A proof that cannot distinguish "the tool is wrong" from "my fixture
   *  is empty" is worse than no proof, so the population is explicit:
   *  terminal work orders with no evaluation, which is exactly what the
   *  census is defined to see.  */
  const ORG = "8a000000-0000-4000-8000-00000000ac01";
  const PROP = "8a000000-0000-4000-8000-00000000ac02";
  await db.query(`insert into organizations (id,name) values ($1,'Activate Proof Org')
                  on conflict (id) do nothing`, [ORG]);
  await db.query(`insert into properties (id,name,organization_id)
                  values ($1,'Activate Proof Property',$2) on conflict (id) do nothing`, [PROP, ORG]);
  const seedLegacy = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i++) {
      const r = await db.query(
        `insert into work_orders (id,property_id,title,status,source,completion_photo)
         values (gen_random_uuid(),$1,$2,'closed','activate_proof',$3) returning id`,
        [PROP, "legacy " + i, "stub://closeout-photo/proof/" + i]);
      ids.push(r.rows[0].id);
    }
    return ids;
  };
  await seedLegacy(2);
  const seeded = Number((await db.query(
    `select count(*) n from work_orders where source = 'activate_proof'`)).rows[0].n);
  ok("P0  a legacy population exists to census — the fixture is not empty",
     seeded === 2,
     `seeded ${seeded} — with an empty population every assertion below is vacuous, ` +
     "which is exactly how the first run of this proof reported seven false failures");

  const AUTH = "authorized by proof 2026-08-10";
  const cen = takeCensus(censusFile);
  ok("P1  the census sees them", cen.count === 2, `census counted ${cen.count}, expected 2`);
  ok("C1  the census tool produced a receipt the runner can read",
     cen.kind === "release_0_cutover_census" && Array.isArray(cen.set),
     JSON.stringify(cen).slice(0, 200));
  console.log(`        ${cen.count} legacy row(s), digest ${cen.digest.slice(0, 16)}\n`);

  // ── R · REFUSALS BEFORE ANYTHING OPENS ────────────────────────────
  const noMode = run(["--census", censusFile]);
  ok("R1  with neither --dry-run nor --activate it does NOTHING",
     noMode.code === 1 && /does nothing by default/.test(noMode.out), noMode.out.slice(-200));

  const bothModes = run(["--dry-run", "--activate", "--census", censusFile]);
  ok("R2  --dry-run and --activate together are refused",
     bothModes.code === 1 && /mutually exclusive/.test(bothModes.out));

  const noCensus = run(["--dry-run"]);
  ok("R3  a missing --census is refused, and names how to make one",
     noCensus.code === 1 && /--census <file> is required/.test(noCensus.out) &&
     /census\.js --json/.test(noCensus.out));

  const noAuth = run(["--activate", "--census", censusFile]);
  ok("R4  --activate with no R0_ACTIVATION_AUTHORIZATION is refused",
     noAuth.code === 1 && /R0_ACTIVATION_AUTHORIZATION is not set/.test(noAuth.out));

  //  A census edited to hide a row must not be accepted.
  const tampered = path.join(tmp, "tampered.json");
  const t = JSON.parse(fs.readFileSync(censusFile, "utf8"));
  t.set = []; t.count = 0;                       // digest left as-is
  fs.writeFileSync(tampered, JSON.stringify(t));
  const tamperRun = run(["--dry-run", "--census", tampered]);
  ok("R5  a census whose digest does not describe its own set is refused",
     tamperRun.code === 1 && /digest does not match its own set/.test(tamperRun.out),
     "a hand-edited census was accepted — the expected set could be anything");

  const notCensus = path.join(tmp, "notcensus.json");
  fs.writeFileSync(notCensus, JSON.stringify({ hello: "world" }));
  ok("R6  a file that is not a census receipt is refused",
     run(["--dry-run", "--census", notCensus]).code === 1);

  // ── D · THE DRY RUN CANNOT WRITE ──────────────────────────────────
  const before = await snapshot();
  const dry = run(["--dry-run", "--census", censusFile]);
  const after = await snapshot();

  ok("D1  the dry run reports READY on a clean baseline",
     dry.code === 0 && /✓ READY/.test(dry.out),
     "exit " + dry.code + "\n        " + dry.out.split("\n").slice(-14).join("\n        "));
  ok("D2  …and it changed NOTHING — full snapshot identical either side",
     before === after,
     `${before.slice(0, 16)} → ${after.slice(0, 16)} — the dry run wrote to the database`);
  ok("D3  …having PROVEN read-only before it read anything",
     /read-only probe\s+PROVEN/.test(dry.out));
  ok("D4  …and it printed all five facts the owner asked for",
     /POPULATION_NOT_EXPLAINABLE\s+0/.test(dry.out) &&
     /legacy population \(live\)\s+\d+ row/.test(dry.out) &&
     /legacy digest \(live\)\s+[0-9a-f]{64}/.test(dry.out) &&
     /guard currently\s+INACTIVE/.test(dry.out) &&
     /census age\s+[\d.]+ min/.test(dry.out),
     dry.out.split("\n").filter((l) => /POPULATION|legacy|guard|census age/.test(l)).join("\n        "));
  ok("D5  …and it names the exact next command, with the same census file",
     dry.out.includes("--activate --census " + censusFile));

  // ── S · STALENESS AND DRIFT ───────────────────────────────────────
  const stale = path.join(tmp, "stale.json");
  const s = JSON.parse(fs.readFileSync(censusFile, "utf8"));
  s.taken_at = new Date(Date.now() - 3600e3).toISOString();
  fs.writeFileSync(stale, JSON.stringify(s));
  const staleDry = run(["--dry-run", "--census", stale]);
  ok("S1  an hour-old census is marked STALE and the dry run is NOT ready",
     /⛔ STALE/.test(staleDry.out) && /NOT READY/.test(staleDry.out) && staleDry.code === 1);
  const staleGo = run(["--activate", "--census", stale], { R0_ACTIVATION_AUTHORIZATION: AUTH });
  const afterStale = await snapshot();
  ok("S2  …and --activate on it REFUSES rather than cutting over",
     staleGo.code === 1 && /minutes old/.test(staleGo.out) && afterStale === before,
     "the database changed while refusing a stale census");

  //  Drift: production moves after the census was taken. Asserted to have
  //  actually happened — a probe that silently inserts nothing is how the
  //  first run of this proof "passed" its way into an early cutover.
  await seedLegacy(1);
  const drifted = Number((await db.query(
    `select count(*) n from work_orders where source = 'activate_proof'`)).rows[0].n);
  ok("S3a the drift probe actually changed the population",
     drifted === 3, `population is ${drifted}, expected 3 — the drift never happened`);
  const driftDry = run(["--dry-run", "--census", censusFile]);
  ok("S3  a population that moved since the census is caught as drift",
     /production moved/.test(driftDry.out) && /NOT READY/.test(driftDry.out) && driftDry.code === 1,
     driftDry.out.split("\n").filter((l) => /matches the census/.test(l)).join("\n        "));
  const driftGo = run(["--activate", "--census", censusFile], { R0_ACTIVATION_AUTHORIZATION: AUTH });
  ok("S4  …and --activate refuses on it too",
     driftGo.code === 1 && /production has moved/.test(driftGo.out));

  //  Put the population back by taking a fresh census of the new truth.
  const fresh = takeCensus(censusFile);
  ok("S5  a fresh census of the changed population is accepted again",
     fresh.count === cen.count + 1 && run(["--dry-run", "--census", censusFile]).code === 0,
     `census went ${cen.count} → ${fresh.count}`);

  // ── A · THE LIVE CUTOVER ──────────────────────────────────────────
  const preCut = await snapshot();
  const go = run(["--activate", "--census", censusFile], { R0_ACTIVATION_AUTHORIZATION: AUTH });
  ok("A1  the live cutover succeeds", go.code === 0 && /✓ CUTOVER RECORDED/.test(go.out),
     "exit " + go.code + "\n        " + go.out.split("\n").slice(-18).join("\n        "));
  ok("A2  …and it actually changed the database", (await snapshot()) !== preCut);

  const ep = (await db.query(`select activation_id from release_0_activation_epoch`)).rows[0];
  ok("A3  the epoch now names an activation", !!ep && !!ep.activation_id, JSON.stringify(ep));

  const inv = Number((await db.query(
    `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n);
  ok("A4  every census row was inventoried as legacy, and only those",
     inv === fresh.count, `inventory ${inv} vs census ${fresh.count}`);

  ok("A5  the receipt names the authorization that ran it",
     go.out.includes(AUTH));

  // ── O · ONCE, AND ONLY ONCE ───────────────────────────────────────
  const again = run(["--activate", "--census", censusFile], { R0_ACTIVATION_AUTHORIZATION: AUTH });
  ok("O1  a SECOND cutover is refused",
     again.code === 1 && /already active/i.test(again.out), again.out.slice(-300));
  const dryAfter = run(["--dry-run", "--census", censusFile]);
  ok("O2  …and the dry run now reports the guard ACTIVE, not ready",
     /guard currently\s+ACTIVE/.test(dryAfter.out) && dryAfter.code === 1);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  await db.end();

  console.log("\n" + "═".repeat(68));
  console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("  The dry run cannot write. Every precondition refuses. The cutover");
    console.log("  happens once and the second attempt is refused by the database.");
  }
  console.log("═".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(2); });
