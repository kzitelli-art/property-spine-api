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

  L("SHAPE — does every discovered domain map into the contract?");
  L("-".repeat(70));
  L("  The mapping lives in domain_standing_projections.js, NOT in the reads.");
  L("  It was in the reads first; gate_funding_boundary.js refused it, because");
  L("  equity, insurance, tax and debt's derivation reads must import nothing —");
  L("  that is how the funding boundary is guaranteed structurally. A boundary");
  L("  gate is not weakened to fit a refactor.");
  L("");
  const adapter = require(path.join(ROOT, "src/shared/domain_standing_projections.js"));
  const bad = [];
  for (const domain of [...domains.keys()].sort()) {
    if (!adapter.MAPPERS[domain]) {
      bad.push(domain);
      L(`  ● RED  ${domain.padEnd(20)} discovered on disk, no mapping`);
      continue;
    }
    let problems;
    try { problems = sp.validate(adapter.project(domain, null)); }
    catch (e) { problems = ["threw: " + e.message]; }
    if (problems.length) { bad.push(domain); L(`  ● RED  ${domain.padEnd(20)} ${problems.join("; ")}`); }
    else L(`  ·      ${domain.padEnd(20)} contract-valid`);
  }
  const orphans = adapter.DOMAINS.filter((d) => !domains.has(d));
  L("");
  ok("every domain discovered on disk has a contract mapping",
     bad.length === 0, `${bad.length} do not: ${bad.join(", ")}`);
  ok("and no mapping exists for a domain that is not on disk",
     orphans.length === 0,
     `${orphans.join(", ")} — a mapping outliving its domain is stale debt the gate should name`);
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

  L("PENDING — the router §40.6 forbids by name");
  L("-".repeat(70));
  const answerSrc = fs.readFileSync(path.join(ROOT, "src/agent/ask_spine_answer.js"), "utf8");
  const routerGuards = (answerSrc.match(/if \(subject === /g) || []).length;
  const hasRouter = /function questionSubject\s*\(/.test(answerSrc);

  /*  ── WHY THIS IS PENDING AND NOT A FAILURE ──────────────────────────
   *  This was written as a hard assertion and it was RED ON PURPOSE, as a
   *  Build 4 handoff. That is fine for a gate run by hand and wrong for a
   *  gate in the runner: `verify_source_governance.js` stops at the first
   *  failure and reports the rest NOT RUN, so a deliberate red here would
   *  have halted every gate after it — a known, ruled, not-yet-started
   *  item silently suppressing unrelated evidence.
   *
   *  The repo already has a shape for "eligible, not yet wired":
   *  gate_ask_spine_readers.js declares `state: "pending"` with an owner
   *  and a `clears` condition (Insurance and Tax sit there today). Same
   *  shape, same reason. A pending item is DECLARED and printed loudly —
   *  it is not a skip, and it is not green.                             */
  const PENDING = {
    what: "Ask Spine gathers every entitled domain rather than routing to one",
    owner: "Build 4",
    clears: "questionSubject() and its `if (subject === …)` guards are gone, and " +
            "gatherFacts collects every entitled domain's standing projection. " +
            "BLOCKED ON COST: gate_standing_projection_cost.js measures 42 queries " +
            "for 8 domains on an EMPTY property, 8 of them unbounded. §40.6 says " +
            "the projection exists so this router is unnecessary; it is only " +
            "necessary while the projections are this expensive.",
  };
  L(`  ⏳ PENDING  ${PENDING.what}`);
  L(`     owner   ${PENDING.owner}`);
  L(`     state   questionSubject() present: ${hasRouter} · subject guards: ${routerGuards}`);
  L(`     clears  ${PENDING.clears.replace(/(.{62})\s/g, "$1\n             ")}`);
  L("");
  //  The one thing that IS asserted: a pending item must still be honest
  //  about itself. If the router disappears, this declaration is stale
  //  debt and the gate says so rather than quietly staying pending.
  ok("the pending declaration still describes reality",
     hasRouter === (routerGuards > 0),
     "questionSubject() and its guards disagree — the declaration above is stale");
  ok("…and if the router is gone, this pending entry must be removed",
     hasRouter || routerGuards > 0,
     "the router is GONE — Build 4 landed. Delete this pending block; a pending " +
     "item outliving its condition is exactly the stale debt it exists to prevent");
  L("");

  L("THE ESTABLISHED BRANCH — proven on representative readings");
  L("-".repeat(70));
  L("  The cost gate maps every domain against a real database, but that");
  L("  property is EMPTY, so all eight take the NOT_ESTABLISHED branch. These");
  L("  are the ESTABLISHED shapes, drawn from each read's documented return.");
  L("");
  const ESTABLISHED = {
    insurance: { established: true, period: "2026-08", coverages: [{}, {}],
      annual_cost_cents: 120000, period_accrual_cents: 10000, currency_code: "USD", mixed_currency: true },
    tax: { as_of: "2026-08-22", overall: "current", overall_why: "all filed",
      obligation_count: 2, next_due_label: "BRT appeal", schedule_disagreements: [{}],
      rows: [{ applicability: "not_established", label: "Use & Occupancy" }] },
    utility: { setup_state: "established", as_of: "2026-08-22",
      unresolved_count: 2, unresolved: [{ why: "no provider" }, "meter unread"],
      next_due_statement: "2026-09-01" },
    contracted_service: { setup_state: "partially_established", as_of: "2026-08-22",
      unresolved_count: 1, unresolved: [{ label: "elevator scope" }], next_milestone: "2026-10-01" },
    compliance: { as_of: "2026-08-22", coverage: { state: "unknown", meaning: "no census" },
      items: [{ attention: true, unresolved: ["no certificate"], next: { date: "2026-09-30", action: "renew" } },
              { attention: false, unresolved: [], next: { date: "2026-12-01", action: "inspect" } }] },
    tenancy: { as_of: "2026-08-22", standing: { truth_state: "PARTIALLY_ESTABLISHED", why: "some" },
      position: { units: 10, occupied: 8 },
      unknowns: { occupied_positions_with_no_recorded_rent: 3, positions_with_overlapping_lease_claims: 0 },
      next_milestone: { on: "2026-09-01", what: "renewals" } },
    debt: { as_of: "2026-08-22", current_position: { payoff: 1 },
      important_unknowns: ["rate reset date"], next_milestone: "maturity" },
  };
  for (const [domain, reading] of Object.entries(ESTABLISHED)) {
    const p = adapter.project(domain, reading);
    const probs = sp.validate(p);
    ok(`${domain} ESTABLISHED maps to a contract-valid projection`,
       probs.length === 0 && p.truth_state === "ESTABLISHED", probs.join("; ") || `truth_state=${p.truth_state}`);
  }
  //  equity's mapper takes (rich, reading) — the one two-argument case
  {
    const rich = { position_count: 3, named_holder_count: 1, coverage_gap_count: 2,
      open_conflict_count: 1, next_milestone: "resolve gap" };
    const p = adapter.project("equity", rich, { as_of: "2026-08-22", positions: [{}, {}, {}] });
    const probs = sp.validate(p);
    ok("equity ESTABLISHED maps to a contract-valid projection",
       probs.length === 0 && p.truth_state === "ESTABLISHED" && p.important_unknowns.length === 3,
       probs.join("; ") || JSON.stringify(p.important_unknowns));
  }
  ok("an unknown domain THROWS rather than returning something answer-shaped",
     (() => { try { adapter.project("not_a_domain", {}); return false; } catch { return true; } })());
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
  ok("validate() REFUSES a failed read that asserts truth_state (§40.7)",
     sp.validate({ ...sp.readFailed("x"), truth_state: "NOT_ESTABLISHED" }).some((m) => /may NOT assert truth_state/.test(m)));
  /*  The assertion above builds the bad object by hand, so it proves
      validate() catches it and NOTHING about readFailed(). Deleting
      readFailed's `truth_state: null` left this suite green — the third
      false green of this build. This is the one that covers it. */
  ok("readFailed() itself produces a contract-valid projection",
     sp.validate(sp.readFailed("x")).length === 0 && sp.readFailed("x").truth_state === null,
     JSON.stringify(sp.validate(sp.readFailed("x"))));
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
