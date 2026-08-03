// ════════════════════════════════════════════════════════════════════
//  migration_release_gate.test.js — DB-FREE. Proves the ITEM 5 gate DECIDES
//  correctly, by stubbing `pg` so migrate.js talks to a fake ledger.
//
//  WHY THIS EXISTS. Twice today a safety check was shipped that had never
//  executed — a read-only smoke whose probe aborted its own transaction, and a
//  closure gate blind since a directory move. Both read as protection. Neither
//  ran. This gate stops production deploys, so it does not get to be the third.
//
//  Runs migrate.js as a child process with `pg` intercepted at module-load
//  time (NODE_PATH does not work — the real node_modules/pg wins), and asserts
//  on exit code + output.
// ════════════════════════════════════════════════════════════════════
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

let pass = 0, fail = 0;
const ok = (l) => { console.log("  ok    " + l); pass++; };
const bad = (l, d) => { console.log("  FAIL  " + l + (d ? "  →  " + d : "")); fail++; };

// Intercept `pg` at module-load time so migrate.js talks to a ledger we
// control. NODE_PATH is NOT enough: node resolves node_modules first, so the
// real driver wins and the test dials a nonexistent host.
const PRELOAD = path.join(os.tmpdir(), "ps_pg_intercept.js");
fs.writeFileSync(PRELOAD, `
  const Module = require("module");
  const original = Module._load;
  const LEDGER = JSON.parse(process.env.__STUB_LEDGER || "[]");
  class Client {
    async connect() {}
    async end() {}
    async query(sql) {
      if (/from schema_migrations/i.test(String(sql))) return { rows: LEDGER };
      return { rows: [] };
    }
  }
  Module._load = function (request) {
    if (request === "pg") return { Client, Pool: Client };
    return original.apply(this, arguments);
  };
`);

function run(ledgerRows, env, args = []) {
  try {
    const out = execFileSync(process.execPath,
      ["--require", PRELOAD, path.join(__dirname, "..", "migrations", "migrate.js"), ...args],
      { env: { ...process.env, __STUB_LEDGER: JSON.stringify(ledgerRows),
               DATABASE_URL: "postgres://stub/stub", ...env },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

// The real migrations directory is the input; build a ledger from it.
const files = fs.readdirSync(path.join(__dirname, "..", "migrations"))
  .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();
const asRow = (f) => ({ version: f.slice(0, 3), name: f.slice(4, -4) });
const ALL = files.map(asRow);
const MISSING_LAST = ALL.slice(0, -1);          // newest migration unapplied
const ceilingOfAll = ALL.map((r) => r.version).sort().pop();
const ceilingOfMissing = MISSING_LAST.map((r) => r.version).sort().pop();

console.log("\n═══ ITEM 5 — migration release gate ═══\n");
console.log(`  (using the real migrations/ directory: ${files.length} files, newest ${files[files.length - 1]})\n`);

// 1. VERIFY, everything applied → passes, applies nothing.
{
  const r = run(ALL, {});
  ok_or(r.code === 0 && /SCHEMA VERIFIED/.test(r.out),
    "verify: all applied → starts", `exit=${r.code}`);
  ok_or(!/applying\.\.\./.test(r.out), "verify: applied nothing", "it applied something");
}

// 2. VERIFY, one pending → REFUSES TO START. This is the whole point.
{
  const r = run(MISSING_LAST, {});
  ok_or(r.code === 1 && /REFUSING TO START/.test(r.out),
    "verify: pending migration → refuses to start", `exit=${r.code}`);
  ok_or(/does not match this code/.test(r.out),
    "verify: says the schema does not match the code");
  ok_or(!/applying\.\.\./.test(r.out),
    "verify: pending migration was NOT silently applied", "it applied it");
  ok_or(new RegExp(files[files.length - 1]).test(r.out),
    "verify: names the pending migration");
}

// 3. RELEASE without EXPECTED_LEDGER_CEILING → refused.
{
  const r = run(MISSING_LAST, { MIGRATION_RELEASE: "1" });
  ok_or(r.code === 1 && /EXPECTED_LEDGER_CEILING is required/.test(r.out),
    "release: refused without a stated expectation", `exit=${r.code}`);
}

// 4. RELEASE with the WRONG ceiling → refused (something moved since you looked).
{
  const r = run(MISSING_LAST, { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "001" });
  ok_or(r.code === 1 && /not in the expected state/.test(r.out),
    "release: refused when the ledger moved since inspection", `exit=${r.code}`);
}

// 5. RELEASE on a Render build without EXPECTED_SHA → refused.
{
  const r = run(MISSING_LAST, {
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing,
    RENDER_GIT_COMMIT: "abc123def456789",
  });
  ok_or(r.code === 1 && /EXPECTED_SHA is required/.test(r.out),
    "release: refused on a deployed build with no pinned SHA", `exit=${r.code}`);
}

// 6. RELEASE with a MISMATCHED SHA → refused.
{
  const r = run(MISSING_LAST, {
    MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: ceilingOfMissing,
    RENDER_GIT_COMMIT: "abc123def456789", EXPECTED_SHA: "999999",
  });
  ok_or(r.code === 1 && /not the build you authorised/.test(r.out),
    "release: refused when the running build is not the authorised one", `exit=${r.code}`);
}

// 7. A feature branch cannot migrate production by deploying. (Same as case 2,
//    stated as the property that matters rather than the mechanism.)
{
  const r = run(MISSING_LAST, { RENDER_GIT_COMMIT: "feature123" });
  ok_or(r.code === 1 && !/applied and recorded/.test(r.out),
    "PROPERTY: a branch deploy with a new migration neither migrates nor boots");
}

function ok_or(cond, label, detail) { cond ? ok(label) : bad(label, detail); }

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
