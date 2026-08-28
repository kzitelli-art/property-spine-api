#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   gate_ci_path_ssl.js — NOTHING ON THE CI PATH DECIDES SSL FOR ITSELF.

   A Postgres that does not speak SSL answers a client that asks for it
   with "The server does not support SSL connections" and nothing else.
   Neon requires SSL. A developer machine's Postgres has `ssl = on`. CI's
   postgres:16 container does not. So a hardcoded `ssl: { … }` is right in
   two of the three places a line of this code ever runs, and fatal in the
   third — the one nobody can see from their own terminal.

   It has now happened twice. First in server.js, which came up and never
   became healthy. Then in tools/apply_unit_type_mapping.js, which took CI
   red for four consecutive runs while the whole suite passed locally,
   because two e2e proofs shell out to it. Both times the fix was the same
   four lines, and both times the rule was somewhere the next file could
   not reach.

   src/shared/database_ssl.js is now the one answer. This gate is what
   stops a third file from deciding for itself.

   ── IT DISCOVERS ITS SUBJECTS, IT DOES NOT LIST THEM ─────────────────
   The tools it checks are read out of the e2e sources — whatever they
   actually shell out to today. A hand-maintained list would go stale in
   exactly the way that produced the defect: silently, and only in CI.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
const ok = (label, cond, why) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${why ? "\n      " + why : ""}`); }
};

//  Comments are where this defect's history is written down, so a check
//  that counted them would fail on the very files that explain it.
const live = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

console.log("\n── what the CI path executes ──");

//  boot.sh starts the server; verify_all.sh runs the e2e proofs; those
//  proofs shell out to tools. That is the whole reachable set.
const e2eDir = path.join(ROOT, "tests/e2e");
const e2eFiles = fs.readdirSync(e2eDir).filter((f) => f.endsWith(".js"));
const tools = new Set();
for (const f of e2eFiles) {
  const src = fs.readFileSync(path.join(e2eDir, f), "utf8");
  for (const m of src.matchAll(/["'`](tools\/[A-Za-z0-9_\/-]+\.js)["'`]/g)) tools.add(m[1]);
  for (const m of src.matchAll(/"(tools)",\s*"([A-Za-z0-9_.-]+\.js)"/g)) tools.add(`${m[1]}/${m[2]}`);
}
const subjects = ["server.js", ...[...tools].sort()];
console.log(`  subjects discovered: ${subjects.join(", ")}`);
ok("the discovery found the server and at least one tool",
   subjects.length >= 2,
   "if the e2e proofs stopped shelling out to any tool this gate would be " +
   "guarding nothing, and would say so rather than pass quietly");

console.log("\n── none of them decides SSL for itself ──");
for (const rel of subjects) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { ok(`${rel} exists`, false, "named by an e2e proof but not on disk"); continue; }
  const src = live(fs.readFileSync(abs, "utf8"));
  ok(`${rel} hardcodes no SSL option`,
     !/rejectUnauthorized/.test(src),
     "it must take its answer from databaseSsl(), which relaxes for a local " +
     "host and keeps SSL everywhere else");
  ok(`${rel} takes its answer from the one rule`,
     /databaseSsl\s*\(/.test(src) || !/new\s+(Pool|Client)\s*\(/.test(src),
     "it opens a pg connection without calling databaseSsl()");
}

console.log("\n── and the rule itself still answers correctly ──");
const { databaseSsl } = require(path.join(ROOT, "src/shared/database_ssl"));
const CASES = [
  ["postgres://u:p@127.0.0.1:5432/spine_verify", false, "loopback — CI's container, and it does not speak SSL"],
  ["postgres://u:p@localhost:5432/spine_verify", false, "localhost by name"],
  ["postgres://u:p@[::1]:5432/spine_verify",     false, "IPv6 loopback — URL.hostname keeps the brackets"],
  ["postgres://u:p@ep-x.aws.neon.tech/n?sslmode=require", true, "Neon — production, and SSL must stay on"],
  ["postgres://u:p@db.internal.example.com:5432/x", true, "any remote host"],
  ["postgres://u:p@db:5432/property_spine?sslmode=disable", false, "docker-compose service name — the caller declared no SSL in the URL"],
  ["not a url at all",                          true, "unparseable falls to the SAFE side, not the open one"],
  [undefined,                                   true, "unset falls to the safe side too"],
];
for (const [url, wantSsl, why] of CASES) {
  const got = databaseSsl(url) !== false;
  ok(`${wantSsl ? "SSL" : "no SSL"} for ${String(url).slice(0, 46)}`, got === wantSsl, why);
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_ci_path_ssl.js");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
