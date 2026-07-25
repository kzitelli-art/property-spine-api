#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  prospect_text_punctuation_proof.js
//
//  Asserts the EMITTED OUTPUT of stripDashes() — the deterministic strip
//  applied to every prospect-facing text — plus the persona's no-promise
//  rule in the shipped prompt source.
//
//  WHY: a live conversation produced two visible breaks in prospect texts:
//     "quiet hours (9 PM, 8 AM Sunday, Thursday, 11 PM, 8 AM Friday, Saturday)"
//        should read: 9 PM–8 AM Sun–Thu, 11 PM–8 AM Fri–Sat
//     "$2,700, month"        should read: $2,700/month
//  Cause: the strip targeted the EN dash (U+2013) as well as the EM dash.
//  The en dash is the RANGE character; removing it turns two ranges into
//  four random times. Fix narrows the strip to the em dash only.
//
//  EVIDENCE STANDARD: node --check cannot catch this class of defect (the
//  old code parsed and booted fine). This asserts real emitted strings and
//  is falsifiable — it FAILS against pre-fix source.
//    Run against old code:  git show main:src/agent/agent.js > /tmp/old.js
//                           AGENT_SRC=/tmp/old.js node tests/prospect_text_punctuation_proof.js
//  Pure string/source assertions. No DB, no network, no sends.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");

const AGENT_SRC = process.env.AGENT_SRC ||
  path.join(__dirname, "..", "src", "agent", "agent.js");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}

// Extract stripDashes from the real source and evaluate it in isolation, so
// we test the SHIPPED implementation rather than a copy of it.
function loadStripDashes(src) {
  const m = src.match(/function stripDashes\(text\)\s*\{[\s\S]*?\n  \}/);
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return stripDashes;`)();
}

const src = fs.readFileSync(AGENT_SRC, "utf8");
console.log("═══ prospect text punctuation proof ═══");
console.log("source:", AGENT_SRC, "\n");

const stripDashes = loadStripDashes(src);
check("stripDashes extracted from shipped source", typeof stripDashes === "function");
if (typeof stripDashes !== "function") { console.log("\n═══ 0 passed · 1 failed ═══"); process.exit(1); }

// ── 1. RANGES MUST SURVIVE (the live breakage) ───────────────────────────
const quiet = "Quiet hours are 9 PM–8 AM Sun–Thu, 11 PM–8 AM Fri–Sat.";
const quietOut = stripDashes(quiet);
check("quiet-hours ranges survive intact",
  quietOut === quiet,
  `got: ${quietOut}`);
check("quiet hours did NOT become a comma list",
  !/9 PM, 8 AM/.test(quietOut),
  `got: ${quietOut}`);

const units = "Units 402–602 are available.";
check("numeric range survives (402–602)", stripDashes(units) === units, `got: ${stripDashes(units)}`);

// ── 2. PRICES AND HYPHENS UNTOUCHED ──────────────────────────────────────
const price = "Rent is $2,700/month for a 12-month lease.";
check("price slash + hyphenated compound untouched",
  stripDashes(price) === price, `got: ${stripDashes(price)}`);
check("price did NOT become '$2,700, month'",
  !/\$2,700, month/.test(stripDashes(price)), `got: ${stripDashes(price)}`);

const phone = "Call 215-645-7147 on 2026-07-27.";
check("phone + ISO date hyphens untouched", stripDashes(phone) === phone, `got: ${stripDashes(phone)}`);

// ── 3. EM DASH IS STILL STRIPPED (the AI tell must not return) ────────────
const spaced = "I checked the unit — it is ready now.";
check("spaced em dash still removed", !spaced.split("").every(() => false) && !/—/.test(stripDashes(spaced)),
  `got: ${stripDashes(spaced)}`);
const tight = "It is ready—today in fact.";
check("tight em dash still removed", !/—/.test(stripDashes(tight)), `got: ${stripDashes(tight)}`);
check("no em dash survives any position",
  !/—/.test(stripDashes("— lead — middle —")));

// ── 4. PERSONA: NO PROMISE OF ACTION OR FOLLOW-UP ────────────────────────
// The live failure: "Let me see if I can shake the tree ... I'll push for it
// and get back to you." v7 already forbade promising an OUTCOME or a RESPONSE
// TIME, but not promising ACTION or a CALLBACK. The prompt must name both.
check("persona forbids promising action outright",
  /YOU MAY NOT PROMISE ACTION/i.test(src));

// Scope phrase assertions to the no-promise rule ITSELF. Matching anywhere in
// a 2,000-line file would pass on incidental prose — a test that passes for the
// wrong reason is not evidence.
const ruleBlock = (src.match(/YOU MAY NOT PROMISE ACTION[\s\S]{0,900}/i) || [""])[0];
["advocate", "push", "escalate", "chase", "shake the tree",
 "follow up", "circle back", "get back to them", "reach out"].forEach(phrase => {
  check(`no-promise rule names the failure phrasing: "${phrase}"`,
    new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(ruleBlock));
});
check("persona still permits the honest line (team can see the conversation)",
  /team can see (your|the) conversation/i.test(src));
check("no-promise rule forbids first-person future action (I'll / let me)",
  /first-person future action/i.test(ruleBlock));
check("no-promise rule forbids third-party future action (they'll / someone will)",
  /third-party future action/i.test(ruleBlock));

console.log(`\n═══ ${pass} passed · ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
