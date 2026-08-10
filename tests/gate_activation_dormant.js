#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   BOUNDARY 8a — THE ACTIVATION MACHINERY SHIPS DORMANT

   8a puts the activation service into production. 8b turns the guard on.
   Between those two deploys there is a window, and the whole value of
   splitting them is that the window is inert: the code is present, and
   nothing can reach it.

   "Nothing reaches it" is a claim about the whole repository, and the way
   this codebase has been wrong before is by checking a subfolder. So this
   scans EVERY .js file outside src/release0/ and tools/, including
   server.js at the root — the file that defines routes and is 3,000+
   lines, and the exact blind spot that let Build 0 report four
   property-creation doors when there were five.

   ── WHAT WOULD MAKE THIS RED ────────────────────────────────────────

   Someone wiring the activation service into a route, a boot path, or a
   scheduled job before 8b is authorised. That is not a hypothetical
   tidiness rule: an activation reachable over HTTP is an activation that
   can happen without the census, without the frozen legacy set, and
   without anyone reading POPULATION_NOT_EXPLAINABLE.

   ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────

   That the guard is off. That is a fact about the DATABASE — the epoch
   row — and no source scan can answer it. tools/step7/census.js reads it
   from production. This file answers only the source question: can the
   deployed application invoke an activation? Today it cannot.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVICE = "src/release0/activation_service.js";

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

//  Every .js in the repo except node_modules, and except the two places
//  the activation machinery is ALLOWED to live: its own module, and the
//  tools that exercise it deliberately.
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(path.relative(ROOT, p));
  }
  return out;
}

console.log("\n" + "═".repeat(66));
console.log("  BOUNDARY 8a · THE ACTIVATION MACHINERY IS DORMANT");
console.log("═".repeat(66) + "\n");

const all = walk(ROOT, []);
const runtime = all.filter((f) =>
  !f.startsWith("src/release0/") && !f.startsWith("tools/") && !f.startsWith("tests/"));

ok("S1  the activation service exists in this build",
   fs.existsSync(path.join(ROOT, SERVICE)),
   "8a is supposed to LAND it — there is nothing to keep dormant");
ok("S2  the scan covers the repository root, not just src/",
   runtime.includes("server.js"),
   "server.js is not in the scanned set. It defines routes and is the blind spot " +
   "that has already produced a false count in this repo once.");
console.log(`        ${all.length} .js files total · ${runtime.length} in the runtime scope\n`);

//  A require of the module, by any spelling.
const IMPORTS = /require\s*\(\s*["'][^"']*release0\/(activation_service|proof_state)/;
const importers = runtime.filter((f) =>
  IMPORTS.test(fs.readFileSync(path.join(ROOT, f), "utf8")));

ok("D1  no runtime file imports the activation service or proof state",
   importers.length === 0,
   "IMPORTED BY:\n        " + importers.join("\n        ") +
   "\n        8a ships this dormant. If it is being wired up, that is 8b and it " +
   "needs authorization.");

//  And the named entry points, in case someone reaches them another way
//  (a re-export, a dynamic path, a wrapper).
const ENTRIES = ["activateRelease0", "recordActivation", "runActivation", "activate("];
const callers = [];
for (const f of runtime) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  for (const e of ENTRIES) if (src.includes(e)) callers.push(`${f} → ${e}`);
}
ok("D2  no runtime file calls an activation entry point by name",
   callers.length === 0,
   "CALLED IN:\n        " + callers.join("\n        "));
console.log("        (comments stripped first — a mention is not a call)\n");

//  The boot path specifically. This is the one that would activate
//  something without anybody asking for it.
const boot = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
ok("B1  server.js does not require anything under src/release0/",
   !/require\s*\(\s*["'][^"']*release0/.test(boot));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const scripts = Object.entries(pkg.scripts || {});
const bootScripts = scripts.filter(([k]) => k === "prestart" || k === "start" || k === "poststart");
ok("B2  no start/prestart script runs anything under src/release0/ or tools/step7/",
   bootScripts.every(([, v]) => !/release0|step7|step12/.test(v)),
   "boot scripts: " + bootScripts.map(([k, v]) => `${k}: ${v}`).join(" · "));
bootScripts.forEach(([k, v]) => console.log(`        ${k}: ${v}`));

console.log("\n" + "═".repeat(66));
console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
if (fail === 0) {
  console.log("  The code is present and unreachable. Turning the guard on is 8b,");
  console.log("  and it is a deliberate act against production, not a deploy.");
}
console.log("═".repeat(66) + "\n");
process.exit(fail === 0 ? 0 : 1);
