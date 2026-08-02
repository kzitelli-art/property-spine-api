// ════════════════════════════════════════════════════════════════════
//  slice9_route_retirement_proof.js
//
//  Commit E. The legacy forward-supply projection is gone: the bare public
//  GET /availability route is unmounted and src/tenancy/availability.js is
//  deleted.
//
//  NO ADAPTER WAS BUILT. Its two internal decision consumers — unitOfferableState
//  and the leaseable-units selector — were CUT OVER to canonical availability in
//  Commits B and D. Retirement followed the cutover; it did not wrap it.
//
//  ── EVIDENCE LIMITATION, STATED PLAINLY ─────────────────────────────
//  DEPLOYED REQUEST LOGS ARE UNAVAILABLE in this environment. There is a
//  standing constraint against production credentials, so no check of live
//  traffic was performed or is implied. Retirement rests on the REPOSITORY
//  CENSUS below and on nothing else.
//
//  The bare route was PUBLIC and accepted a caller-supplied property_id.
//  Removing it also removes that exposure.
//
//  Run: node tests/slice9_route_retirement_proof.js   (no database required)
// ════════════════════════════════════════════════════════════════════

"use strict";
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const APP = path.resolve(REPO, "../property-spine-app");

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};

// Walk real source trees. The app is a FLAT repository with no src/ directory —
// searching a nonexistent path returns a clean zero for every term, which is
// how a live route nearly got retired on a false negative in a prior session.
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|json|ya?ml|sh|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

const apiFiles = walk(REPO);
const appFiles = walk(APP);
const allFiles = apiFiles.concat(appFiles);

// EXECUTABLE files only for "does anything still USE this" questions.
// A document describing the retirement necessarily quotes what was retired, and
// this proof necessarily contains the literal it searches for. Neither is a
// consumer. The existing status-read drift guard strips comments for the same
// reason: documentation naming a defect is not the defect.
const codeFiles = allFiles.filter((f) =>
  /\.(js|html)$/.test(f) && path.resolve(f) !== path.resolve(__filename));

console.log("\n── THE SEARCH SURFACE IS REAL ───────────────────────────");
ok(apiFiles.length > 100, `API tree walked (${apiFiles.length} files)`);
ok(fs.existsSync(APP), "the app repository is present and was searched");
ok(!fs.existsSync(path.join(APP, "src")),
  "the app has NO src/ directory — confirmed, so a src-scoped search would have been a false zero");
ok(appFiles.length > 20, `app root walked (${appFiles.length} files)`);
ok(appFiles.some((f) => f.endsWith("index.html")), "including index.html, the app's main surface");

console.log("\n── THE MODULE IS GONE ───────────────────────────────────");
ok(!fs.existsSync(path.join(REPO, "src/tenancy/availability.js")),
  "src/tenancy/availability.js no longer exists");

const importers = codeFiles.filter((f) => /require\(["'][^"']*tenancy\/availability["']\)/.test(fs.readFileSync(f, "utf8")));
ok(importers.length === 0,
  `ZERO files import the deleted module (found ${importers.length})`,
  importers.map((f) => path.relative(REPO, f)).join(", "));

console.log("\n── NO ADAPTER WAS BUILT ─────────────────────────────────");
//  Tested against LEGACY-DISTINCTIVE markers only.
//
//  'ready_now' and 'vacant_turning' are NOT legacy vocabulary — they are
//  canonical position_classifier availability_state values and are very much
//  alive. The legacy module reused the same words in its own response shape,
//  which is precisely why a naive grep for them is dangerous: it flags
//  canonical fixtures in readiness/triage/turn-scope proofs that never touched
//  the legacy module at all.
//
//  What IS distinctive: the service function name, and the four response fields
//  the consumer census found had ZERO repository consumers.
//  Comments are stripped first, the same way slice9_status_read_drift_guard
//  does it: prose EXPLAINING what the retired projection used to do is not a
//  reimplementation of it.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const LEGACY_ONLY = /readAvailability\s*\(|commitment_tier|projected_ready_date|date_confidence|tourable_in_person/;
const shim = codeFiles.filter((f) => LEGACY_ONLY.test(stripComments(fs.readFileSync(f, "utf8"))));
ok(shim.length === 0,
  `nothing reimplements the legacy service or its zero-consumer fields (found ${shim.length})`,
  shim.map((f) => path.relative(REPO, f)).join(", "));
ok(!/LEASEABLE_STATES/.test(fs.readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8")),
  "the legacy allowlist constant is gone rather than relocated");

console.log("\n── THE BARE ROUTE IS UNMOUNTED ──────────────────────────");
const server = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
ok(!/tenancy\/availability/.test(server), "server.js no longer mounts the module");
const bareDefs = codeFiles.filter((f) =>
  /router\.(get|use)\(\s*["'`]\/availability["'`]/.test(fs.readFileSync(f, "utf8")));
ok(bareDefs.length === 0,
  `no file defines the bare GET /availability route any more (found ${bareDefs.length})`,
  bareDefs.map((f) => path.relative(REPO, f)).join(", "));

console.log("\n── ZERO EXACT BARE-ROUTE REQUESTS ───────────────────────");
//  EXACT path literals, not a substring grep. '/availability' must not be
//  confused with '/operator/leasing/availability-canonical',
//  '/operator/leasing/leaseable-units', or leasingleads' TOUR-SLOT routes
//  '/leasing/availability', '/properties/:propertyId/leasing/availability' and
//  '/leasing/availability/:slotId/block' — which are a different concern
//  entirely and are deliberately untouched.
const literals = new Map();
for (const f of codeFiles) {
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/["'`]([^"'`\n]*\/availability[^"'`\n]*)["'`]/g)) {
    const lit = m[1];
    if (!literals.has(lit)) literals.set(lit, []);
    literals.get(lit).push(path.relative(REPO, f));
  }
}
const bare = [...literals.keys()].filter((l) => l === "/availability" || /^\/availability\?/.test(l));
ok(bare.length === 0, `no exact '/availability' request literal survives (found ${bare.length})`,
  bare.map((b) => `${b} in ${literals.get(b).join(", ")}`).join(" · "));

const tourSlot = [...literals.keys()].filter((l) => /leasing\/availability/.test(l));
ok(tourSlot.length > 0,
  `tour-slot availability routes are PRESERVED and distinguished (${tourSlot.length} literals)`);

console.log("\n── THE CANONICAL SURFACES REMAIN ────────────────────────");
const operator = fs.readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
ok(/availability-canonical/.test(operator), "the canonical availability route is still defined");
ok(/leaseable-units/.test(operator), "leaseable-units is still defined");
ok(/require\(["']\.\.\/surfaces\/availability_read["']\)/.test(operator),
  "operator.js reads canonical availability directly");
ok(fs.existsSync(path.join(REPO, "src/surfaces/availability_read.js")),
  "surfaces/availability_read.js is untouched and present");

const appIndex = fs.readFileSync(path.join(APP, "index.html"), "utf8");
ok(/operator\/leasing\/availability-canonical/.test(appIndex),
  "the app still requests availability-canonical");
ok(/operator\/leasing\/leaseable-units/.test(appIndex),
  "and still requests leaseable-units");

console.log("\n── OTHER CANONICAL CONSUMERS ARE INTACT ─────────────────");
for (const f of ["src/maintenance/unit_triage_service.js", "src/surfaces/rent_roll_canonical.js",
                 "src/surfaces/future_rent_roll_facts.js", "src/tenancy/dated_positions.js",
                 "src/tenancy/position_classifier.js", "src/tenancy/space_position.js"]) {
  ok(fs.existsSync(path.join(REPO, f)), `${f} still exists`);
}

console.log("\n── THE SERVER STILL PARSES ──────────────────────────────");
let parses = true, why = "";
try { new (require("vm").Script)(server, { filename: "server.js" }); }
catch (e) { parses = false; why = e.message; }
ok(parses, "server.js parses after the mount removal", why);

console.log("\n── EVIDENCE LIMITATION IS RECORDED, NOT IMPLIED ─────────");
const self = fs.readFileSync(__filename, "utf8");
ok(/DEPLOYED REQUEST LOGS ARE UNAVAILABLE/.test(self),
  "this proof states plainly that deployed request logs were unavailable");
ok(/rests on the REPOSITORY\s*\n\/\/  CENSUS/.test(self) || /rests on the REPOSITORY CENSUS/.test(self.replace(/\n\/\/\s*/g, " ")),
  "and that retirement rests on the repository census alone");

console.log("\n──────────────────────────────────────────────────────────");
console.log(`   route retirement: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
