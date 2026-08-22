#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE STANDING PROJECTION CONTRACT — SHAPE, AND COST

       node tests/gate_standing_projection_contract.js

   PHILOSOPHY §40.6 requires every governed domain to expose a compact
   standing projection — current position, important unknowns, next
   milestone — and requires it be answerable CHEAPLY, "without walking
   its full payment, amendment or event history."

   Two halves, and the second is the one that matters:

     SHAPE   does every discovered domain expose a projection, in one
             agreed shape, that `standing_projection.validate()` accepts?
     COST    can it be produced without loading the domain's full
             history? §40.6 calls this "a design input at the first
             schema conversation, not an optimisation afterward."

   ── WHY COST IS NOT A PERFORMANCE CONCERN ───────────────────────────
   §40.6 states the purpose plainly: the projection is small "so that
   many entitled domains can be gathered on every question, which is what
   lets Ask Spine answer cross-domain questions WITHOUT a classifier or
   an intent router." A router is judgement with no edge, and it fails in
   the direction of answering the wrong domain confidently.

   `ask_spine_answer.js` HAS such a router — `questionSubject()`, a bank
   of regexes, gating every gather behind `if (subject === …)`. It exists
   because gathering everything is not currently affordable. So cost is
   not a nice-to-have here: it is the thing standing between this system
   and deleting the router doctrine forbids.

   ── DOMAIN DISCOVERY ────────────────────────────────────────────────
   Discovered the same way `gate_ask_spine_readers.js` discovers them —
   from the filesystem, never a hand-kept list. A registry that only
   knows what someone remembered to add cannot detect the omission it
   exists to prevent (§40.11).

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: none. When every
   domain is compliant this gate is what keeps the eighth from landing
   without a projection.

   No database, no network. It reads source and calls pure functions.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sp = require(path.join(ROOT, "src/shared/standing_projection.js"));

/*  Mirrors gate_ask_spine_readers.js exactly. If the two ever disagree
    about what a domain is, they are asserting different things while
    appearing to agree — so this is asserted below, not assumed. */
const STANDING_READ_DIRS = ["src/asset", "src/tenancy"];
const STANDING_READ_SUFFIXES = ["_position_read.js", "_establishment.js", "_read.js"];
const NON_STANDING_READ_SUFFIXES = ["_document_read.js", "_funding_read.js"];

function discoverDomains() {
  const byDomain = new Map();
  for (const dir of STANDING_READ_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (NON_STANDING_READ_SUFFIXES.some((s) => f.endsWith(s))) continue;
      for (const s of STANDING_READ_SUFFIXES) {
        if (f.endsWith(s)) {
          const d = f.slice(0, -s.length);
          if (!byDomain.has(d)) byDomain.set(d, []);
          byDomain.get(d).push(path.join(dir, f));
          break;
        }
      }
    }
  }
  return byDomain;
}

/*  ── COST, MEASURED WHERE IT IS ACTUALLY PAID ────────────────────────
    THE FIRST VERSION OF THIS GATE WAS FALSELY GREEN, and the reason is
    worth keeping: it scanned only the `*_position_read.js` files and
    reported debt and equity CHEAP. They are not. `standingProjection()`
    takes a `reading`, `position()` takes a `history`, and `loadHistory()`
    is called by the SERVICE at the GATHER SITE — so the file that names
    the cost is `ask_spine_answer.js`, not the read.

    A gate that scans less than it asserts launders the gap into evidence
    (CLAUDE.md). Cost is therefore measured over BOTH the read files and
    the per-domain gather block that produces the projection.            */
const WALK_SIGNALS = [
  { re: /loadHistory\s*\(/,                       why: "loads full domain history" },
  { re: /for\s*\(\s*const\s+\w+\s+of\s+ids\s*\)/, why: "loops a query per sub-entity" },
  { re: /for\s*\(\s*const\s*\[\s*\w+\s*,\s*table\s*\]\s*of\s+Object\.entries\(TABLES\)/,
    why: "loads every table in TABLES for the property" },
];

/*  The gather block for one domain inside ask_spine_answer.js: from its
    `if (subject === "<domain>"` to the next such guard. */
function gatherBlock(answerSrc, domain) {
  const start = answerSrc.indexOf(`if (subject === "${domain}"`);
  if (start === -1) return null;
  const next = answerSrc.indexOf("if (subject === ", start + 10);
  return answerSrc.slice(start, next === -1 ? answerSrc.length : next);
}

function costOf(files, answerSrc, domain) {
  const hits = [];
  const scan = (text, label) => {
    for (const s of WALK_SIGNALS) if (s.re.test(text)) hits.push(`${label}: ${s.why}`);
  };
  for (const rel of files) scan(fs.readFileSync(path.join(ROOT, rel), "utf8"), path.basename(rel));
  const block = gatherBlock(answerSrc, domain);
  if (block) scan(block, "ask_spine_answer gather");
  return [...new Set(hits)];
}

function exportsOf(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { return { __loadError: e.message }; }
}

let pass = 0, fail = 0;
const L = (s = "") => console.log(s);
function ok(name, cond, detail = "") {
  if (cond) { pass++; L(`  ✔ ${name}`); }
  else { fail++; L(`  ✘ ${name}${detail ? "\n      " + detail : ""}`); }
}

(function main() {
  L("\nSTANDING PROJECTION CONTRACT — §40.6");
  L("=".repeat(70));

  const domains = discoverDomains();
  L(`  discovered ${domains.size} domains from ${STANDING_READ_DIRS.join(", ")}`);
  L("");

  /*  The gate that owns registration must see the same domains. */
  const gateSrc = fs.readFileSync(path.join(ROOT, "tests/gate_ask_spine_readers.js"), "utf8");
  ok("this gate and gate_ask_spine_readers.js discover domains identically",
     STANDING_READ_DIRS.every((d) => gateSrc.includes(`"${d}"`)) &&
     STANDING_READ_SUFFIXES.every((s) => gateSrc.includes(`"${s}"`)),
     "the two gates would be asserting different things while appearing to agree");
  L("");

  L("SHAPE — does each domain expose a contract-valid standing projection?");
  L("-".repeat(70));
  const missing = [];
  for (const [domain, files] of [...domains].sort()) {
    const mods = files.map(exportsOf);
    const withProjection = mods.find((m) => typeof m.standingProjection === "function");
    if (!withProjection) {
      missing.push(domain);
      L(`  ● RED  ${domain.padEnd(20)} no standingProjection() in ${files.map((f) => path.basename(f)).join(", ")}`);
    } else {
      L(`  ·      ${domain.padEnd(20)} has standingProjection()`);
    }
  }
  L("");
  ok(`every discovered domain exposes standingProjection()`,
     missing.length === 0,
     `missing in ${missing.length}: ${missing.join(", ")}`);
  L("");

  L("COST — measured, not inferred. See gate_standing_projection_cost.js");
  L("-".repeat(70));
  L("  This gate deliberately does NOT judge cost from source patterns.");
  L("  It tried twice and was FALSELY GREEN both times:");
  L("");
  L("    attempt 1  scanned only *_position_read.js and called debt and equity");
  L("               cheap. loadHistory() is called at the GATHER SITE, not in");
  L("               the read, so the file naming the cost was never opened.");
  L("    attempt 2  added the gather site and caught those two, then still");
  L("               called compliance, tax and tenancy cheap. Their walks are");
  L("               unbounded `select *` queries over fact, payment and lease");
  L("               tables — no loadHistory(), no loop, no pattern to match.");
  L("");
  L("  A regex over source cannot answer 'how much does this cost'. The");
  L("  companion gate answers it by COUNTING REAL QUERIES against a real");
  L("  database, which is the only form of that claim worth making.");
  L("");

  L("THE CONSEQUENCE — the router §40.6 forbids by name");
  L("-".repeat(70));
  const answerSrc = fs.readFileSync(path.join(ROOT, "src/agent/ask_spine_answer.js"), "utf8");
  const routerGuards = (answerSrc.match(/if \(subject === /g) || []).length;
  const hasRouter = /function questionSubject\s*\(/.test(answerSrc);
  L(`  questionSubject() present: ${hasRouter}`);
  L(`  gathers gated on a chosen subject: ${routerGuards}`);
  ok("Ask Spine gathers every entitled domain rather than routing to one",
     !hasRouter && routerGuards === 0,
     "a regex intent router picks ONE domain per question. §40.6 says the standing\n" +
     "      projection exists precisely so this is unnecessary — and it is only\n" +
     "      necessary while the projections are too expensive to gather routinely.\n" +
     "      Deleting the router is Build 4; making that possible is this build.");
  L("");

  L("THE CONTRACT ITSELF — validate() must refuse what §40.7 forbids");
  L("-".repeat(70));
  const good = sp.established("x", { as_of: "2026-08-22", current_position: { a: 1 }, next_milestone: "y" });
  ok("a well-formed projection validates", sp.validate(good).length === 0, JSON.stringify(sp.validate(good)));
  ok("NOT_ESTABLISHED is a successful read about the property",
     (() => { const p = sp.notEstablished("x", { as_of: "2026-08-22", why: "nothing recorded" });
              return p.read_state === "OK" && p.truth_state === "NOT_ESTABLISHED" && sp.validate(p).length === 0; })());
  ok("notEstablished REFUSES an unexplained blank (§5)",
     (() => { try { sp.notEstablished("x", { as_of: "2026-08-22" }); return false; } catch { return true; } })());
  ok("a failed read may NOT assert truth_state (§40.7)",
     sp.validate({ ...sp.readFailed("x"), truth_state: "NOT_ESTABLISHED" }).some((m) => /may NOT assert truth_state/.test(m)));
  ok("READ_TIMED_OUT stays distinct from READ_FAILED",
     sp.readFailed("x", { timed_out: true }).read_state === "READ_TIMED_OUT" &&
     sp.readFailed("x").read_state === "READ_FAILED");
  ok("a domain may not self-declare QUIET (§40.7)",
     sp.validate({ ...good, quiet: true }).some((m) => /may not declare `quiet`/.test(m)));
  ok("composite silence is BLIND when a required reader is missing",
     sp.compositeSilence([good], { required: ["x", "z"] }).state === "BLIND");
  ok("composite silence is BLIND when any reader failed",
     sp.compositeSilence([sp.readFailed("x")], { required: ["x"] }).state === "BLIND");
  ok("QUIET only when every required reader returned and none is pending",
     sp.compositeSilence(
       [sp.established("x", { as_of: "2026-08-22", current_position: {}, next_milestone: null })],
       { required: ["x"] }).state === "QUIET");

  L("");
  L("=".repeat(70));
  L(`  ${pass} passed   ${fail} failed`);
  L("");
  if (fail) {
    L("  The contract module is green. The DOMAINS are not — which is the");
    L("  finding, and the work. Nothing is fixed by this file.");
    L("");
  }
  process.exit(fail === 0 ? 0 : 1);
})();
