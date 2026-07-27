// ════════════════════════════════════════════════════════════════════
//  admission_eligibility_contract.test.js — admission asks about the
//  TENANCY, not about the person.
//
//  WHAT THIS PROTECTS
//  ------------------
//  The person-level condition on tenancy admission went through four
//  shapes in a single day, and the fourth is none:
//
//    1. record_class === 'internal_qa'
//         Deadlocked against the comms boundary, which demanded
//         'production' for the same person. A prospect could be textable
//         or leasable, never both.
//    2. a shared class allowlist with capability.js
//         The two gates agreed — and a field with three jobs still decided
//         whether anything worked.
//    3. consent
//         Dissolved that deadlock and created a worse one: a person who
//         texts STOP could not have their signed lease recorded. Stopping
//         texts is not declining a tenancy.
//    4. nothing.
//
//  RECORDING A SIGNED LEASE IS NOT AN OUTBOUND. Consent governs whether
//  the product may message someone. Class governs replay and metrics.
//  Neither answers "may this tenancy be admitted", so neither is asked.
//
//  This file now asserts the ABSENCE. That is a real contract: three times
//  a person-level flag was added here, and each time it broke something
//  two stages away. The next person tempted to add a fourth should have to
//  delete a test that explains why.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node tests/admission_eligibility_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const path = require("path");
const perimeter = require(path.join(__dirname, "..", "src", "identity", "activation_perimeter.js"));
const capability = require(path.join(__dirname, "..", "src", "identity", "capability.js"));

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "identity", "activation_perimeter.js"), "utf8");
// The guard body, with comments STRIPPED. The notes explaining why consent
// and class were removed contain both words, so a prose-sensitive search
// would fail the moment someone documented the decision properly. These
// assertions are about what the code READS, not about what it says.
const GUARD = (SRC.split("return async function perimeterGuard")[1] || "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

// ════ A · NO PERSON-LEVEL CONDITION ═════════════════════════════════
section("A · admission does not ask about the person");

ok("A1. the guard reads no record_class — the first shape is gone",
  !/record_class/.test(GUARD));

ok("A2. the guard reads no consent — the third shape is gone too",
  !/contact_preferences|consent_state|opted_in/.test(GUARD), GUARD.match(/consent\w*/g));

ok("A3. the class allowlist no longer exists to import",
  capability.ELIGIBLE_RECORD_CLASSES === undefined,
  JSON.stringify(capability.ELIGIBLE_RECORD_CLASSES));

ok("A4. currentEligibleClass is not exported — nothing can quietly re-wire it",
  typeof perimeter.currentEligibleClass === "undefined",
  Object.keys(perimeter).join(", "));

ok("A5. the perimeter reads person_property_classifications nowhere at all",
  !/person_property_classifications/.test(SRC));

// ════ B · WHAT STILL GATES ADMISSION ════════════════════════════════
//  Removing a condition is only safe if the remaining ones are real. These
//  assert the gate did not become a formality.
section("B · the conditions that remain");

ok("B1. the dormant-mode kill switch is still the first thing checked",
  /resolveMode\(\)\s*!==\s*"enabled"/.test(GUARD));

ok("B2. an authenticated staff session is still required",
  /resolveStaffSession/.test(GUARD));

ok("B3. THE PROPERTY WALL — the application's OWN property must be activated",
  /activatedPropertyIds\(\)\.has\(app\.property_id\)/.test(GUARD));

ok("B4. the session must be scoped to the application's property",
  /session\.property_id === app\.property_id/.test(GUARD));

ok("B5. the session must hold the governing module",
  /sessionModules\.includes\(REQUIRED_MODULE\)/.test(GUARD));

ok("B6. the application state must be eligible",
  /eligible\.has\(app\.status\)/.test(GUARD));

ok("B7. refusal is still single and non-revealing — the gate leaks nothing",
  /function refuse\(res\)/.test(SRC) && /not_permitted/.test(SRC));

// ════ C · THE PROPERTY WALL IS NOT A FORMALITY ══════════════════════
section("C · the property wall actually refuses");

const saved = process.env.ACTIVATION_PROPERTY_IDS;
process.env.ACTIVATION_PROPERTY_IDS = "";
ok("C1. an empty allowlist activates NOTHING — fail closed, not fail open",
  perimeter.activatedPropertyIds().size === 0);

process.env.ACTIVATION_PROPERTY_IDS = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const ids = perimeter.activatedPropertyIds();
ok("C2. a listed property is activated",
  ids.has("a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"));
ok("C3. an UNLISTED property is not — one property's activation never leaks to another",
  !ids.has("9e2bb96e-08e2-41db-81c2-91055ceb50a3"));

delete process.env.ACTIVATION_PROPERTY_IDS;
ok("C4. an UNSET allowlist activates nothing either",
  perimeter.activatedPropertyIds().size === 0);
if (saved === undefined) delete process.env.ACTIVATION_PROPERTY_IDS;
else process.env.ACTIVATION_PROPERTY_IDS = saved;

// ════ D · CONSENT STILL GOVERNS MESSAGING ═══════════════════════════
//  The point of the split. Consent left ADMISSION; it did not leave the
//  product. The application gate — which does send a text — still enforces
//  it, so this change moved consent to where it belongs rather than
//  weakening it.
section("D · consent moved, it did not weaken");

const stopped = capability.decideApplicationLinkBirth({
  enabled: true, property_allowlisted: true, person_id: "p", consent_state: "opted_out" });
ok("D1. an opted-out person is still refused an application link — that one DOES send",
  stopped.allowed === false && stopped.reason_code === "NO_CONSENT", JSON.stringify(stopped));

const noRow = capability.decideApplicationLinkBirth({
  enabled: true, property_allowlisted: true, person_id: "p", consent_state: null });
ok("D2. absence of consent is still refusal at the sending gate",
  noRow.allowed === false, JSON.stringify(noRow));

// Asserted on the READ, not on the prose. The notes explaining this removal
// necessarily contain the word "consent"; a word-search would fail the moment
// someone documented the decision, which is the opposite of what we want.
ok("D3. THE ONE THAT MATTERS — admission queries no consent source, so a STOP cannot block a signed lease",
  !/contact_preferences|consent_state/.test(GUARD) &&
  !/contact_preferences/.test(SRC),
  "admission consulted consent again; stopping texts is not declining a tenancy");

const bar = "─".repeat(66);
console.log(`\n${bar}\nADMISSION — ASKS ABOUT THE TENANCY, NOT THE PERSON\n${bar}`);
console.log(lines.join("\n"));
console.log(`\n${bar}`);
console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
console.log(failed
  ? "Fix the failures above."
  : "Consent governs messaging. Class governs replay. Neither governs a tenancy.");
console.log(`${bar}\n`);
process.exitCode = failed ? 1 : 0;
