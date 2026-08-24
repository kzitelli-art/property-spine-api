#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE FOUR SILENCES MUST NEVER COLLAPSE — §40.7

       node tests/gate_four_silences.js

   §40.7 names four different kinds of nothing, and they are four
   different answers:

       NOT_ESTABLISHED   a fact about the PROPERTY — we looked, and the
                         property has nothing recorded
       READ_FAILED       a fact about SPINE — we could not look
       READ_TIMED_OUT    also about Spine, and different again — we
                         looked, and gave up before the answer arrived
       QUIET             we looked, everything answered, and nothing
                         needs attention

   The first two are the ones that matter most: "the property has no
   insurance" and "we could not read insurance" are opposite answers, and
   only one of them is safe to act on. An attention surface that cannot
   tell quiet from blind is worse than none, because composite silence
   reads as health (§5).

   ── HOW THIS IS TESTED ──────────────────────────────────────────────
   Failures are INJECTED into the real `gatherFacts`, which takes its
   readers as parameters, and the real returned facts are inspected. No
   source pattern-matching: Build 2's cost gate was falsely green twice
   for exactly that reason, and a gate that infers behaviour from text is
   asserting about the text.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: none. This is how
   the distinction stays true for the ninth domain.

   No database, no network.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
const ask = require(path.join(ROOT, "src/agent/ask_spine_answer.js"));

const PROPERTY = "b3000000-0000-4000-8000-000000000001";
const AM = ["asset_management"];
const ALL = ["asset_management", "leasing", "management", "maintenance"];

let pass = 0, fail = 0;
const L = (s = "") => console.log(s);
function ok(name, cond, detail = "") {
  if (cond) { pass++; L(`  ✔ ${name}`); }
  else { fail++; L(`  ✘ ${name}${detail ? "\n      " + detail : ""}`); }
}

const boom = () => { throw new Error("database down"); };
const timeout = () => { const e = new Error("timed out"); e.code = "READ_TIMED_OUT"; throw e; };

/*  Each domain, with a reader that FAILS and one that TIMES OUT, and the
    fact key its silence is supposed to land on. Everything here is a
    real injection into the real gatherFacts.                           */
const DOMAINS = [
  { domain: "compliance", subject: "compliance", modules: AM, key: "compliance",
    fail: { complianceReader: { readComplianceStanding: boom } },
    slow: { complianceReader: { readComplianceStanding: timeout } } },
  { domain: "utility", subject: "utility", modules: AM, key: "utility",
    //  The catch block calls detailRequest() on the SAME reader that just
    //  threw, so a faithful stub must provide it. Noted as a robustness
    //  smell — an error handler that depends on the failed collaborator —
    //  and left alone; it is not this build's target.
    fail: { utilityReader: { readForQuestion: boom, detailRequest: () => ({ mode: "standing" }) } },
    slow: { utilityReader: { readForQuestion: timeout, detailRequest: () => ({ mode: "standing" }) } } },
  { domain: "contracted_service", subject: "contracted_service", modules: AM, key: "contracted_service",
    fail: { contractedServiceReader: { readForQuestion: boom, detailRequest: () => ({ mode: "standing" }) } },
    slow: { contractedServiceReader: { readForQuestion: timeout, detailRequest: () => ({ mode: "standing" }) } } },
  { domain: "debt", subject: "debt", modules: AM, key: "debt",
    fail: { debtService: { listInstrumentsForProperty: boom } },
    slow: { debtService: { listInstrumentsForProperty: timeout } } },
  { domain: "equity", subject: "equity", modules: AM, key: "equity",
    fail: { equityService: { loadHistory: boom } },
    slow: { equityService: { loadHistory: timeout } } },
  { domain: "tenancy", subject: "tenancy", modules: ALL, key: "tenancy",
    fail: { tenancyReader: { readTenancyStanding: boom } },
    slow: { tenancyReader: { readTenancyStanding: timeout } } },
  { domain: "economics", subject: "economics", modules: ALL, key: "economics",
    fail: { economicReader: boom },
    slow: { economicReader: timeout } },
  { domain: "tour_schedule", subject: "tour_schedule", modules: ALL, key: "tour_schedule",
    fail: { tourScheduleReader: boom },
    slow: { tourScheduleReader: timeout } },
];

(async () => {
  L("\nTHE FOUR SILENCES — §40.7");
  L("=".repeat(72));
  L("  Real failures injected into the real gatherFacts. No source scanning.");
  L("");

  L("1 · A FAILED READ MUST BE VISIBLE ON ITS OWN FACT KEY");
  L("-".repeat(72));
  L("  A domain whose fact key simply VANISHES on failure is the worst case:");
  L("  an absent key is indistinguishable from a domain nobody asked about.");
  L("");
  const invisible = [];
  for (const d of DOMAINS) {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: d.modules, subject: d.subject, ...d.fail });
    const f = facts[d.key];
    const visible = f && typeof f === "object" && typeof f.read_state === "string";
    if (!visible) {
      invisible.push(d.domain);
      L(`  ● RED  ${d.domain.padEnd(20)} fact key is ${f === undefined ? "ABSENT" : "present with no read_state"}`);
    } else {
      L(`  ·      ${d.domain.padEnd(20)} read_state = ${f.read_state}`);
    }
  }
  L("");
  ok("every domain reports a read_state when its read fails",
     invisible.length === 0, `${invisible.length} do not: ${invisible.join(", ")}`);
  L("");

  L("2 · A TIMEOUT MUST STAY DISTINCT FROM A FAILURE");
  L("-".repeat(72));
  const collapsed = [];
  for (const d of DOMAINS) {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: d.modules, subject: d.subject, ...d.slow });
    const f = facts[d.key];
    const state = f && f.read_state;
    if (state !== "READ_TIMED_OUT") {
      collapsed.push(d.domain);
      L(`  ● RED  ${d.domain.padEnd(20)} timeout reported as ${state === undefined ? "nothing at all" : state}`);
    } else {
      L(`  ·      ${d.domain.padEnd(20)} READ_TIMED_OUT`);
    }
  }
  L("");
  ok("every domain distinguishes READ_TIMED_OUT from READ_FAILED",
     collapsed.length === 0, `${collapsed.length} collapse it: ${collapsed.join(", ")}`);
  L("");

  L("3 · A FAILED READ MUST NEVER CLAIM THE PROPERTY HAS NOTHING");
  L("-".repeat(72));
  const conflated = [];
  for (const d of DOMAINS) {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: d.modules, subject: d.subject, ...d.fail });
    const f = facts[d.key] || {};
    const s = f.standing;
    const claims = s && (s.truth_state === "NOT_ESTABLISHED" || s.truth_state === "ESTABLISHED");
    if (claims) { conflated.push(d.domain); L(`  ● RED  ${d.domain.padEnd(20)} asserts truth_state ${s.truth_state} on a failed read`); }
    else L(`  ·      ${d.domain.padEnd(20)} asserts nothing about the property`);
  }
  L("");
  ok("no failed read asserts a truth_state about the property",
     conflated.length === 0, conflated.join(", "));
  L("");

  L("4 · QUIET MUST BE COMPUTED, NOT PROMPTED");
  L("-".repeat(72));
  L("  §40.7: \"Composite silence may only mean 'nothing needs attention' when");
  L("  every required reader successfully returned — computed from reader");
  L("  outcomes IN CODE, NEVER PROMPTED.\"");
  L("");
  const facts = await ask.gatherFacts({}, {
    property_id: PROPERTY, allowed_modules: AM, subject: "debt",
    ...DOMAINS.find((d) => d.domain === "debt").fail });
  ok("gatherFacts computes a composite silence verdict",
     typeof facts.composite_silence === "object" && facts.composite_silence !== null,
     "there is no computed verdict — `reads_that_failed` is a LIST handed to the model,\n" +
     "      and the prompt asks it not to confuse a failed read with 'nothing to report'.\n" +
     "      That is the distinction being PROMPTED. §40.7 says computed, in code.");
  if (facts.composite_silence) {
    ok("…and it is BLIND, not QUIET, when a reader failed",
       facts.composite_silence.state === "BLIND",
       `saw ${facts.composite_silence.state}`);
  }
  L("");

  L("=".repeat(72));
  L(`  ${pass} passed   ${fail} failed`);
  L("");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
