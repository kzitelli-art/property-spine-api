/* ════════════════════════════════════════════════════════════════════
   debt_establishment_tool.db.js — THE CONTROLLED ESTABLISHMENT STEP,
   RUN AS A REAL PROCESS AGAINST REAL POSTGRES.

   Spawns tools/debt/establish_instrument.js the way an operator would —
   real argv, real DATABASE_URL, real exit codes. A test that imported the
   tool's functions would prove a different program than the one that runs.

   ── WHAT IT HAS TO PROVE ────────────────────────────────────────────
   The tool exists to stop $28.25M, 3.28% and a maturity date entering
   production as unexplained literals. So the assertions are mostly about
   REFUSAL, and about provenance surviving all the way to the row:

       every established row carries its source artifact  — none exempt
       a cited document that is not retained    → refuse
       a row with no provenance                 → refuse
       a placeholder hash                       → refuse
       the shipped declaration carries real hashes, not fixtures
       a second run                             → refuse, no duplicates
       dry run                                  → writes nothing
       what it wrote reads back through the HTTP seam unchanged

   The last one matters: the tool and the read seam must agree, or a
   correct establishment could still surface wrong.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   The tool reads DATABASE_URL, so the harness passes the HARNESS url in
   as DATABASE_URL to the CHILD process only — this process never points
   the tool at anything the guard has not already cleared.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/postgres \
       node tests/proofs/debt_establishment_tool.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");

const SCHEMA = "debt_establish_proof";
const TOOL = path.join(__dirname, "..", "..", "tools", "debt", "establish_instrument.js");
const MIGRATION = path.join(__dirname, "..", "..", "migrations", "173_debt_instruments.sql");
const REAL_DECL = path.join(__dirname, "..", "..", "tools", "debt", "declarations", "4125_480010465.json");

const URL_ = receipt.harnessConnectionString();
receipt.begin(__filename, { url: URL_, expected: 19 });

let pass = 0, fail = 0, ran = 0;
function ok(label, cond, detail) {
  ran++;
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "debt-establish-"));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

//  Fixture documents. Their CONTENT is irrelevant; their hashes are what
//  the declaration cites and what the tool must resolve.
const DOCS = {
  schedule: { name: "Lument amortization schedule.pdf", body: "AMORTIZATION SCHEDULE 480010465" },
  packet:   { name: "4125 Chestnut Debt Closing Packet.pdf", body: "DEBT CLOSING PACKET ORIX FREDDIE 2020" },
  stmtAug:  { name: "480010465 statement 2025-08-01.pdf", body: "MORTGAGE LOAN STATEMENT 2025-08-01" },
  stmtDec:  { name: "480010465 statement 2025-12-01.pdf", body: "MORTGAGE LOAN STATEMENT 2025-12-01" },
  stmtMar:  { name: "480010465 statement 2026-03-01.pdf", body: "MORTGAGE LOAN STATEMENT 2026-03-01" },
};
for (const d of Object.values(DOCS)) d.sha = sha(d.body);

const REAL_HASHES = Object.freeze({
  schedule: "1f146fe73fb0b2bc673e0e413f0a3ba9a29b32317bb1b839518efc0f6e9113c3",
  packet:   "8aa80192cc4563533d1be212dcdcd0f359bda8874ca797ec5d1e6a22a11d18eb",
  stmtAug:  "136f595d11b4c51c26d0087f5d0bfb94c58f4901a383c91392c4b3721cd37a34",
  stmtDec:  "148ec36181e26f54c0d14f019cf4e6d4f22383700122c31aba62f57208a48d0e",
  stmtMar:  "50c3a3c0a581147ccddf6b7d5afd603fe39fc42ac6869c592749261a534e620b",
});

//  Substitute only the retained production digests with isolated fixture
//  digests. This proves the shipped declaration's exact row structure while
//  keeping the harness independent of production bytes.
function realDeclarationWithFixtureHashes() {
  let text = fs.readFileSync(REAL_DECL, "utf8");
  for (const [key, realHash] of Object.entries(REAL_HASHES)) {
    text = text.split(realHash).join(DOCS[key].sha);
  }
  return JSON.parse(text);
}

function writeDecl(name, obj) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

let pool = null, server = null, scoped = null;

function runTool(args, extraEnv) {
  try {
    const out = execFileSync(process.execPath, [TOOL].concat(args), {
      env: Object.assign({}, process.env, { DATABASE_URL: URL_, PGOPTIONS: `-c search_path=${SCHEMA}` }, extraEnv || {}),
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

(async () => {
  try {
    pool = new Pool({ connectionString: URL_ });
    const c = await pool.connect();
    await c.query(`drop schema if exists ${SCHEMA} cascade`);
    await c.query(`create schema ${SCHEMA}`);
    await c.query(`set search_path to ${SCHEMA}`);
    await c.query(`create extension if not exists pgcrypto`);
    await c.query(`create table users (id uuid primary key)`);
    await c.query(`create table properties (id uuid primary key default gen_random_uuid(), name text)`);
    await c.query(`create table legal_entities (id uuid primary key default gen_random_uuid())`);
    await c.query(`create table source_artifacts (
      id uuid primary key default gen_random_uuid(),
      original_filename text not null, sha256 text)`);
    await c.query(fs.readFileSync(MIGRATION, "utf8"));

    const uid = "11111111-1111-1111-1111-111111111111";
    await c.query(`insert into users values ($1)`, [uid]);
    const prop = (await c.query(`insert into properties (name) values ('4125 Chestnut') returning id`)).rows[0].id;

    //  Retain four of the five documents. The March statement is deliberately
    //  absent, so the first assertion proves that one missing source refuses
    //  the whole atomic establishment.
    for (const k of ["schedule", "packet", "stmtAug", "stmtDec"]) {
      await c.query(`insert into source_artifacts (original_filename, sha256) values ($1,$2)`,
        [DOCS[k].name, DOCS[k].sha]);
    }
    c.release();

    const decl = realDeclarationWithFixtureHashes();
    const declPath = writeDecl("real.json", decl);
    const base = ["--declaration", declPath, "--property", prop, "--recorded-by-user", uid];

    /*  ══ REFUSALS ═════════════════════════════════════════════════ */
    console.log("\n  ── it refuses before it writes ──");

    const missingDoc = runTool(base.concat(["--apply"]));
    ok("a cited document that is NOT retained → refused",
       missingDoc.code === 1 && /NOT retained/i.test(missingDoc.out), `exit ${missingDoc.code}`);
    ok("…and the refusal names the missing hash",
       missingDoc.out.includes(DOCS.stmtMar.sha));

    const shipped = JSON.parse(fs.readFileSync(REAL_DECL, "utf8"));
    const shippedHashes = JSON.stringify(shipped).match(/[0-9a-f]{64}/g) || [];
    ok("the shipped declaration carries five real retained-source hashes",
       new Set(shippedHashes).size === 5
       && Object.values(REAL_HASHES).every((h) => shippedHashes.includes(h)));

    const placeholder = JSON.parse(JSON.stringify(decl));
    placeholder.instrument.source_sha256 = "FILL-with-sha256-of-retained-source";
    const placeholderRes = runTool(["--declaration", writeDecl("placeholder.json", placeholder),
                                    "--property", prop, "--recorded-by-user", uid, "--apply"]);
    ok("a placeholder hash → refused",
       placeholderRes.code === 1 && /placeholder|not a sha256/i.test(placeholderRes.out),
       `exit ${placeholderRes.code}`);

    const noProv = JSON.parse(JSON.stringify(decl));
    delete noProv.terms[0].source_sha256;
    const noProvRes = runTool(["--declaration", writeDecl("noprov.json", noProv),
                               "--property", prop, "--recorded-by-user", uid, "--apply"]);
    ok("a canonical row with no source_sha256 → refused",
       noProvRes.code === 1 && /without evidence is refused/i.test(noProvRes.out));

    const noLoc = JSON.parse(JSON.stringify(decl));
    noLoc.balance_observations[0].locator = "";
    const noLocRes = runTool(["--declaration", writeDecl("noloc.json", noLoc),
                              "--property", prop, "--recorded-by-user", uid, "--apply"]);
    ok("a row citing a document but no locator → refused",
       noLocRes.code === 1 && /locator/i.test(noLocRes.out));

    const missingArgs = runTool(["--declaration", declPath, "--apply"]);
    ok("missing --property / --recorded-by-user → refused",
       missingArgs.code === 1 && /usage/i.test(missingArgs.out));
    ok("…and it says the uuid is attribution, not authorisation",
       /ATTRIBUTION, not proof of authorisation/i.test(missingArgs.out));

    /*  ══ NOW RETAIN THE FIFTH DOCUMENT ═══════════════════════════ */
    await pool.query(`set search_path to ${SCHEMA}`);
    const c2 = await pool.connect();
    await c2.query(`set search_path to ${SCHEMA}`);
    await c2.query(`insert into source_artifacts (original_filename, sha256) values ($1,$2)`,
      [DOCS.stmtMar.name, DOCS.stmtMar.sha]);
    c2.release();

    console.log("\n  ── dry run writes nothing ──");
    const dry = runTool(base);
    ok("dry run exits 0 and says it rolled back",
       dry.code === 0 && /DRY RUN/i.test(dry.out), `exit ${dry.code}`);
    const afterDry = await pool.query(`select count(*)::int n from ${SCHEMA}.debt_instruments`);
    ok("…and no instrument exists afterwards", afterDry.rows[0].n === 0);

    /*  ══ ESTABLISH ════════════════════════════════════════════════ */
    console.log("\n  ── establishment ──");
    const run = runTool(base.concat(["--apply"]));
    ok("--apply establishes the instrument", run.code === 0 && /ESTABLISHED/.test(run.out),
       `exit ${run.code}\n${run.out.slice(-400)}`);

    const inst = await pool.query(`select * from ${SCHEMA}.debt_instruments`);
    ok("exactly one instrument was created", inst.rows.length === 1);

    //  THE ASSERTION THE TOOL EXISTS FOR.
    const orphan = await pool.query(`
      select 'parties' t, count(*)::int n from ${SCHEMA}.debt_instrument_parties where source_artifact_id is null
      union all select 'collateral', count(*)::int from ${SCHEMA}.debt_instrument_properties where established_by_source_artifact_id is null
      union all select 'terms', count(*)::int from ${SCHEMA}.debt_terms where source_artifact_id is null
      union all select 'reserves', count(*)::int from ${SCHEMA}.debt_reserve_requirements where source_artifact_id is null
      union all select 'balances', count(*)::int from ${SCHEMA}.debt_balance_observations where source_artifact_id is null
      union all select 'payments', count(*)::int from ${SCHEMA}.debt_payment_observations where source_artifact_id is null`);
    const provless = orphan.rows.filter((r) => r.n > 0);
    ok("EVERY established row carries its source document — none exempt",
       provless.length === 0, provless.map((r) => `${r.t}=${r.n}`).join(", "));

    const noteRow = await pool.query(`select provenance_note from ${SCHEMA}.debt_terms limit 1`);
    ok("each row's provenance names the locator AND the declaration hash",
       /Amortization schedule/.test(noteRow.rows[0].provenance_note)
       && /declaration [0-9a-f]{16}/.test(noteRow.rows[0].provenance_note),
       noteRow.rows[0].provenance_note);

    console.log("\n  ── re-running cannot duplicate append-only history ──");
    const again = runTool(base.concat(["--apply"]));
    ok("a second run → refused", again.code === 1 && /already established/i.test(again.out));
    const still = await pool.query(`select count(*)::int n from ${SCHEMA}.debt_instrument_parties`);
    ok("…and no extra party rows were appended", still.rows[0].n === 9, `${still.rows[0].n} parties`);

    /*  ══ THE SEAM AGREES WITH THE TOOL ════════════════════════════ */
    console.log("\n  ── what it wrote reads back through the HTTP seam ──");
    const http = require("http");
    const SESSIONS = { entitled: { id: uid, property_id: prop, allowed_modules: ["asset_management"] } };
    const rp = require.resolve("../../src/identity/staff_session_service.js");
    require.cache[rp] = { id: rp, filename: rp, loaded: true,
      exports: { resolveStaffSession: async (_p, t) => SESSIONS[t] || null } };
    const express = require("express");
    const app = express();
    app.use(express.json());
    scoped = new Pool({ connectionString: URL_ });
    scoped.on("connect", (cl) => cl.query(`set search_path to ${SCHEMA}`));
    app.use("/", require("../../src/surfaces/asset_management.js")({
      pool: scoped, fileToText: async ({ buffer }) => buffer.toString("utf8") }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const body = await new Promise((resolve) => {
      http.get({ host: "127.0.0.1", port: server.address().port,
                 path: "/operator/debt/standing", headers: { "x-staff-session": "entitled" } },
        (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve(JSON.parse(b))); });
    });
    const pos = body.instruments[0];
    ok("the seam reports the established loan, unchanged",
       body.instrument_count === 1 && pos.instrument.loan_number === "480010465"
       && pos.instrument.original_principal_cents === 2825000000);
    ok("…with the observed balance and its as_of intact",
       pos.principal_position.observed.value_cents === 2774526577
       && pos.principal_position.observed.as_of_date === "2025-08-01");
    ok("…and debt service is the P&I established from the schedule",
       pos.debt_service.principal_and_interest_cents === 12341140);

    await pool.query(`drop schema ${SCHEMA} cascade`);
  } catch (e) {
    if (server) server.close();
    if (scoped) await scoped.end();
    if (pool) await pool.end();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(receipt.died(__filename, e, ran));
  }
  server.close();
  await scoped.end();
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 19 }));
})();
