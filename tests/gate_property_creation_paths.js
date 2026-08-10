#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — EXACTLY THE KNOWN CLIENT / PROPERTY CREATION PATHS

   Build 0 asked one question: what is the ONE canonical path by which a
   client, entity and property become durable Spine truth? The measured
   answer is that there is no such path — FOUR routes create a property
   and they do not agree on identity, hierarchy or authority. A fifth
   site in `src/` can mint one with no route and no actor at all.

   This gate exists so that answer cannot drift while Build 1 collapses
   them. It pins the register, and it pins the DIVERGENCES the audit
   named, so that:

     · a FIFTH creation path cannot appear silently, and
     · the four cannot be quietly "harmonised" without the register, the
       audit and this gate moving together in one commit.

   A creation path is the highest-authority write in the product: after
   it, a durable object exists that every board, projection and report
   will read as truth. It is currently the LEAST governed write in the
   product — see D1–D4 below, and note that all four routes have zero
   test coverage (C1).

   FALSIFIED, not assumed: an unregistered `insert into properties` added
   to another src/ module turns S2 red, and a register entry that
   misdescribes its own source turns D3 red. Both were run.

   ── WHAT IT MEASURES, AND WHAT IT DOES NOT ──────────────────────────
   Source only, DB-free. It reads `src/` for statements that insert into
   `properties` or `organizations`. It cannot say whether a path has ever
   been used, or whether production rows carry an organization — those
   are database questions and this gate does not pretend to answer them.

   ── WHY THE DIVERGENCE ASSERTIONS ARE "PINS", NOT "FAILURES" ────────
   D1–D4 pass TODAY, describing the state Build 0 found. They are not
   claiming that state is good. They turn RED the moment somebody
   changes it — which is exactly when a human should be reading the
   audit rather than trusting a green suite. Fixing a divergence is
   supposed to break this gate; the fix is to update the register in the
   same commit, deliberately.

   run:  node tests/gate_property_creation_paths.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/*  THE REGISTER. Every path that can bring a property into existence,
 *  with the authority it actually requires and what it does NOT record.
 *  `class` is the §18 classification from the Build 0 audit. */
const PROPERTY_CREATORS = [
  {
    file: "src/identity/super_admin.js",
    route: "POST /admin/organizations/:id/properties/new",
    probe: "/properties/new",
    authority: "staff session → users.platform_role = 'super_admin'",
    sets_organization: true,
    sets_canonical_key: false,
    class: "KEEP — the only path that establishes hierarchy. Build 1A extends it.",
  },
  {
    file: "src/money/bankintake.js",
    route: "POST /bank/onboard-property",
    probe: "/bank/onboard-property",
    authority: "shared OPERATOR_KEY header — a bearer secret, not an actor",
    sets_organization: false,
    sets_canonical_key: true,
    class: "ADAPT — its address-anchored identity discipline is right; its " +
           "authority model and orphan hierarchy are not.",
  },
  {
    file: "src/surfaces/owner.js",
    route: "POST /owner/properties/create-from-upload",
    probe: "/create-from-upload",
    authority: "shared OPERATOR_KEY header — a bearer secret, not an actor",
    sets_organization: false,
    sets_canonical_key: true,
    class: "ADAPT — the alias-hijack refusal is the best identity behaviour " +
           "of the four and must survive the collapse.",
  },
  {
    file: "src/onboarding/dealintake.js",
    route: "POST /deal-intakes/:id/create-property",
    probe: "/create-property",
    authority: "shared OPERATOR_KEY header — a bearer secret, not an actor",
    sets_organization: false,
    sets_canonical_key: false,
    class: "ADAPT — teaches observed aliases at creation, which is the " +
           "behaviour Build 2's Share→Recognize→Confirm loop needs.",
  },
];

/*  NOT a route, and therefore not an authority path — but it lives in
 *  `src/` and it can mint a real `properties` row against whatever
 *  DATABASE_URL names. It is registered rather than excluded because an
 *  unregistered exception is indistinguishable from an oversight. */
const NON_ROUTE_CREATORS = [
  {
    file: "src/shared/no076_failclosed_check.js",
    route: "(no route — standalone proof script, run by hand)",
    authority: "none. Whoever holds DATABASE_URL. Already registered as an " +
               "unguarded write-capable consumer by gate_harness_isolation.js",
    prefix: "__CB_NO076__",
    class: "RETIRE from src/ — it is a harness misfiled into the product tree. " +
           "Removal condition: relocate under tests/ with the rest of the " +
           "migration-matrix proofs; no product code imports it (verified: " +
           "nothing requires it).",
  },
];

const ORGANIZATION_CREATORS = [
  {
    file: "src/identity/super_admin.js",
    route: "POST /admin/organizations",
    authority: "staff session → users.platform_role = 'super_admin'",
    class: "KEEP — already the single path. Build 1A adds legal entities " +
           "beneath it, not beside it.",
  },
];

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_property_creation_paths.js");
console.log("  checks: exactly the known client/property creation paths");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/*  An insert statement and enough of what follows it to see the column
 *  list. Matched case-insensitively because the codebase writes SQL in
 *  both cases, and a creation path that shouted its keywords would
 *  otherwise be invisible to a lower-case-only scan. */
function scanInserts(table) {
  const STMT = new RegExp("insert\\s+into\\s+(?:public\\.)?" + table + "\\b[\\s\\S]{0,600}?`", "gi");
  const found = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    for (const m of text.matchAll(STMT)) {
      found.push({ rel, line: text.slice(0, m.index).split("\n").length, stmt: m[0] });
    }
  }
  return found;
}

const propInserts = scanInserts("properties");
const orgInserts = scanInserts("organizations");

// ── S1  the scan is not broken ──────────────────────────────────────
ok("S1  the scan found property-creation sites at all", propInserts.length > 0,
   "zero found — the scan is broken and would pass anything");
console.log("        " + propInserts.length + " property insert site(s), " +
            orgInserts.length + " organization insert site(s)\n");

// ── S2  no fifth property creator ───────────────────────────────────
const ALL_CREATORS = [...PROPERTY_CREATORS, ...NON_ROUTE_CREATORS];
const unregisteredProp = propInserts
  .filter((f) => !ALL_CREATORS.some((c) => c.file === f.rel))
  .map((f) => f.rel + ":" + f.line);

for (const f of propInserts) {
  const entry = ALL_CREATORS.find((c) => c.file === f.rel);
  if (entry) console.log("  ok    " + f.rel + ":" + f.line + "  " + entry.route);
}
if (propInserts.some((f) => ALL_CREATORS.some((c) => c.file === f.rel))) pass++;

ok("S2  NO unregistered property-creation path exists in src/",
   unregisteredProp.length === 0,
   unregisteredProp.join("\n        ") +
   "\n        → a new door that mints durable Spine truth. Before registering it, answer" +
   "\n          the Eight Questions (§31) for it, and say what its authority actually is." +
   "\n          Build 1A is supposed to REMOVE doors here, not add them. STOP.");

// ── S2b  the non-route creator stays confined to its own prefix ─────
//  A harness that can mint a property is tolerable only while every row
//  it writes is unmistakably its own. The moment it can create an
//  ordinary-looking property, it is a creation path with no authority.
for (const c of NON_ROUTE_CREATORS) {
  const stmts = propInserts.filter((f) => f.rel === c.file).map((f) => f.stmt).join("\n");
  ok("S2b " + path.basename(c.file) + " creates only its own '" + c.prefix + "' rows",
     stmts.includes(c.prefix),
     "it now writes a property row with no distinguishing prefix, from a script with" +
     "\n        no authenticated actor and no organization. That is a creation path. STOP.");
}

// ── S3  no second organization creator ──────────────────────────────
const unregisteredOrg = orgInserts
  .filter((f) => !ORGANIZATION_CREATORS.some((c) => c.file === f.rel))
  .map((f) => f.rel + ":" + f.line);
ok("S3  NO unregistered organization-creation path exists in src/",
   unregisteredOrg.length === 0,
   unregisteredOrg.join("\n        ") +
   "\n        → the client level currently has exactly one door. A second one means" +
   "\n          two answers to 'who is the customer'. STOP.");

// ── S4  the register cannot rot ─────────────────────────────────────
const staleProp = ALL_CREATORS.filter((c) => !propInserts.some((f) => f.rel === c.file));
const staleOrg = ORGANIZATION_CREATORS.filter((c) => !orgInserts.some((f) => f.rel === c.file));
ok("S4  the register is still accurate (no entry naming a file that no longer creates)",
   staleProp.length === 0 && staleOrg.length === 0,
   [...staleProp, ...staleOrg].map((s) => "no longer a creator: " + s.file).join("\n        ") +
   "\n        → if Build 1 collapsed this path, remove the entry here and record the" +
   "\n          collapse in docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md in the same commit.");

// ════════════════════════════════════════════════════════════════════
//  THE DIVERGENCES. These pin the state Build 0 MEASURED. Each one is a
//  fact about how the four paths disagree. Each turns red when it stops
//  being true — which is the moment the audit needs re-reading.
// ════════════════════════════════════════════════════════════════════
console.log("\n  ── DIVERGENCE PINS (the Build 0 findings, held in place) ──");

const stmtFor = (file) => propInserts.filter((f) => f.rel === file).map((f) => f.stmt).join("\n");
const setsColumn = (file, col) => new RegExp("\\b" + col + "\\b").test(stmtFor(file));

// D1 — hierarchy is optional at creation.
const orgSetters = PROPERTY_CREATORS.filter((c) => setsColumn(c.file, "organization_id"));
ok("D1  exactly ONE of the property-creation paths attaches an organization",
   orgSetters.length === 1 && orgSetters[0].file === "src/identity/super_admin.js",
   "measured: " + JSON.stringify(orgSetters.map((c) => c.file)) +
   "\n        → Build 0 found 1 of 4. If this changed, the client/entity/property" +
   "\n          hierarchy Build 1A depends on has moved. Re-read the audit, then" +
   "\n          update this pin deliberately.");
console.log("        3 of the 4 doors create a property with organization_id NULL.");

// D2 — identity protection is per-door, not per-object.
const keySetters = PROPERTY_CREATORS.filter((c) => setsColumn(c.file, "canonical_key"));
ok("D2  only TWO of the four paths set the address-anchored canonical_key",
   keySetters.length === 2
     && keySetters.some((c) => c.file === "src/money/bankintake.js")
     && keySetters.some((c) => c.file === "src/surfaces/owner.js"),
   "measured: " + JSON.stringify(keySetters.map((c) => c.file)) +
   "\n        → uq_properties_canonical_key (migration 011) is a plain UNIQUE," +
   "\n          so NULLs never collide. The two doors that leave it NULL get no" +
   "\n          duplicate protection from it at all.");
console.log("        uq_properties_canonical_key protects only rows that carry one.");

// D3 — the register's own claims about each path match the measured source.
const misdescribed = PROPERTY_CREATORS.filter((c) =>
  setsColumn(c.file, "organization_id") !== c.sets_organization
  || setsColumn(c.file, "canonical_key") !== c.sets_canonical_key);
ok("D3  the register describes each path the way the source actually behaves",
   misdescribed.length === 0,
   misdescribed.map((c) => c.file + ": register says organization=" + c.sets_organization +
     " canonical_key=" + c.sets_canonical_key + ", source says organization=" +
     setsColumn(c.file, "organization_id") + " canonical_key=" +
     setsColumn(c.file, "canonical_key")).join("\n        ") +
   "\n        → a register that describes the wrong behaviour is worse than none:" +
   "\n          it implies a control that is not there.");

// D4 — org membership is a mutable column with no supersession record.
//      Measured, not asserted from memory: the reassignment write is read
//      out of the shipped source and checked for a history write beside it.
const superAdminSrc = fs.readFileSync(path.join(ROOT, "src/identity/super_admin.js"), "utf8");
const reassign = /update\s+properties\s+set\s+organization_id[\s\S]{0,300}?`/i.exec(superAdminSrc);
ok("D4  reassigning a property to another organization writes no history",
   !!reassign && !/organization_.*history|property_org_history|supersed/i.test(superAdminSrc),
   !reassign
     ? "the reassignment write is gone — if Build 1A replaced it, update this pin"
     : "a history/supersession write appeared beside it — good, and this pin must" +
       "\n        now be replaced with an assertion that it is ALWAYS written.");
console.log("        POST /admin/organizations/:id/properties overwrites the column in place;");
console.log("        it does not check for an existing different owner and keeps no record.");

// ── C1  no creation path has a proof harness ────────────────────────
//  Named separately because it is the finding that makes every other
//  finding cheap to regress: none of these routes is exercised anywhere.
const TEST_DIRS = ["tests", "tools"].map((d) => path.join(ROOT, d)).filter(fs.existsSync);
//  This file is excluded: it lives under tests/ and names every route in
//  its own register, so scanning it would let the gate satisfy itself.
const allTestText = TEST_DIRS.flatMap((d) => walk(d))
  .filter((p) => p !== __filename)
  .map((p) => fs.readFileSync(p, "utf8")).join("\n");
const exercised = PROPERTY_CREATORS.filter((c) => allTestText.includes(c.probe));
ok("C1  the creation paths' proof debt is recorded, not discovered again later",
   exercised.length === 0,
   "measured: " + JSON.stringify(exercised.map((c) => c.route)) +
   "\n        → one of them gained coverage. Good — record it in the audit and" +
   "\n          narrow this pin to the ones still unproven.");
console.log("        0 of 4 property-creation routes are exercised by any harness or tool.");
console.log("        This is the proof debt Build 1 inherits (§33: not even 'locally exercised').");

console.log("\n  ── REGISTER ──");
for (const c of PROPERTY_CREATORS) {
  console.log("    PROPERTY  " + c.route);
  console.log("      file:      " + c.file);
  console.log("      authority: " + c.authority);
  console.log("      class:     " + c.class);
}
for (const c of ORGANIZATION_CREATORS) {
  console.log("    ORGANIZATION  " + c.route);
  console.log("      file:      " + c.file);
  console.log("      authority: " + c.authority);
  console.log("      class:     " + c.class);
}
console.log("\n  Full audit: docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md");

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_property_creation_paths.js");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
