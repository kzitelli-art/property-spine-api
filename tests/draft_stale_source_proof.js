// ════════════════════════════════════════════════════════════════════
//  draft_stale_source_proof.js — A PENDING PROMISE REVALIDATES TRUTH
//
//  A draft reviewed against one set of economic terms must not dispatch after
//  those terms move. Pure contract layer: no database, no network.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node tests/draft_stale_source_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const { economicSourceIdentity, compareEconomicSources, staleReasonForOperator, isEconomic } =
  require("../src/agent/draft_source_identity");

let passed = 0, failed = 0;
const lines = [];
const ok = (l, c, d) => { if (c) { passed++; lines.push("  ok    " + l); }
                          else { failed++; lines.push(`  FAIL  ${l}${d ? "\n          " + d : ""}`); } };

const govCharge = (over = {}) => ({ fact_key: "fee.application", category: "pricing",
  source: "governed_charge", rendered_text: "The application fee is $50 per applicant for a new lease application.",
  terms_digest: "aaaa1111", ...over });
const priceFact = (over = {}) => ({ fact_key: "pricing_admin_fee", category: "pricing",
  source: "field_guide_2026", rendered_text: "A $99 admin fee applies per unit, once at move-in and at renewal.", ...over });
const tourFact = { fact_key: "tour_window", category: "tours", source: "field_guide_2026",
  rendered_text: "Tours start in the lobby." };

// ── WHAT COUNTS AS ECONOMIC ──────────────────────────────────────────
ok("a governed charge is an economic source", isEconomic(govCharge()));
ok("a pricing-category fact is an economic source", isEconomic(priceFact()));
ok("a tours fact is NOT an economic source", !isEconomic(tourFact));

// ── IDENTITY IS STRUCTURED WHERE POSSIBLE ────────────────────────────
const id1 = economicSourceIdentity([govCharge(), priceFact(), tourFact]);
ok("only economic sources enter the identity set", id1.sources.length === 2);
ok("a governed charge uses its STRUCTURED terms digest",
  id1.sources.find((s) => s.type === "governed_charge").identity === "structured_terms");
ok("a prose fact falls back to its rendered text, and says so",
  id1.sources.find((s) => s.type === "property_fact").identity === "rendered_text");
ok("the set is order-independent",
  economicSourceIdentity([priceFact(), tourFact, govCharge()]).digest === id1.digest);

// ── THE LOAD-BEARING COMPARISON ──────────────────────────────────────
const same = compareEconomicSources([govCharge(), priceFact()], [govCharge(), priceFact()]);
ok("identical truth MATCHES — the normal dispatch path is permitted", same.match === true);
ok("and it is recorded as having economic sources", same.had_economic_sources === true);

// A material term moves without changing one word of the sentence.
const silent = compareEconomicSources(
  [govCharge()], [govCharge({ terms_digest: "bbbb2222" })]);
ok("a TERM change with IDENTICAL wording is still caught (why display text is not enough)",
  silent.match === false && silent.changed_ids.includes("fee.application"));

const reworded = compareEconomicSources(
  [priceFact()], [priceFact({ rendered_text: "A $149 admin fee applies per unit at move-in." })]);
ok("a prose fact whose text changed is caught", reworded.match === false);

const retired = compareEconomicSources([govCharge(), priceFact()], [govCharge()]);
ok("a source that DISAPPEARED (retired) is caught", retired.match === false
  && retired.removed_ids.includes("pricing_admin_fee"));

const appeared = compareEconomicSources([govCharge()], [govCharge(), priceFact()]);
ok("a source that APPEARED (newly governed) is caught", appeared.match === false
  && appeared.added_ids.includes("pricing_admin_fee"));

// ── UNRELATED DRAFTS ARE UNAFFECTED ──────────────────────────────────
const noEcon = compareEconomicSources([tourFact], [tourFact]);
ok("a draft with NO economic sources reports none", noEcon.had_economic_sources === false);
const noEconChanged = compareEconomicSources([tourFact], [tourFact, govCharge()]);
ok("and it is never blocked, even when economics appear elsewhere",
  noEconChanged.had_economic_sources === false);
ok("a non-economic fact changing does NOT make an economic draft stale",
  compareEconomicSources([govCharge(), tourFact],
    [govCharge(), { ...tourFact, rendered_text: "Tours start on the roof." }]).match === true);

// ── OPERATOR LANGUAGE ────────────────────────────────────────────────
const reason = staleReasonForOperator(silent);
ok("a matching comparison produces NO reason", staleReasonForOperator(same) === null);
ok("a mismatch produces operator language", typeof reason === "string" && reason.length > 40);
ok("it says what became stale", /fee policy|fees and charges/i.test(reason), reason);
ok("it says why it cannot send", /can't be sent|cannot be sent/i.test(reason), reason);
ok("it names the next action", /regenerate/i.test(reason), reason);
ok("it leaks NO digest", !/[0-9a-f]{16,}/.test(reason), reason);
ok("it leaks NO fact key or charge code",
  !/fee\.|pricing_|fact_key|charge_code/.test(reason), reason);
ok("it leaks NO schema or migration terminology",
  !/digest|snapshot|column|migration|jsonb|agent_runs|status=/i.test(reason), reason);
// Subject/verb agreement. An earlier version produced "the fees and charges
// … was withdrawn" on the REAL draft — a grammar bug in the one sentence an
// operator has to trust.
const plural = staleReasonForOperator(
  compareEconomicSources([govCharge(), priceFact()],
    [govCharge({ terms_digest: "x" }), priceFact({ rendered_text: "changed" })]));
ok("plural wording when several sources moved", /fees and charges/.test(plural), plural);
ok("plural subject takes a plural verb", /charges this message relied on have changed/.test(plural), plural);

const oneRemoved = staleReasonForOperator(
  compareEconomicSources([govCharge(), priceFact()], [govCharge()]));
ok("a single withdrawn source reads as singular and correct",
  /the fee policy this message relied on has been withdrawn/.test(oneRemoved), oneRemoved);

const oneChanged = staleReasonForOperator(
  compareEconomicSources([govCharge()], [govCharge({ terms_digest: "z" })]));
ok("a single changed source reads as singular and correct",
  /the fee policy this message relied on has changed/.test(oneChanged), oneChanged);

const oneAdded = staleReasonForOperator(
  compareEconomicSources([govCharge()], [govCharge(), priceFact()]));
ok("a newly-applying source reads correctly",
  /a fee policy now applies that did not when this was written/.test(oneAdded), oneAdded);

// The real draft's shape: one source withdrawn AND one added = plural.
const realShape = staleReasonForOperator(
  compareEconomicSources([priceFact({ fact_key: "pricing_application_fee" })], [govCharge()]));
ok("the real draft's shape (one withdrawn, one added) reads as plural and grammatical",
  /fees and charges this message relied on have changed/.test(realShape), realShape);

// ── THE GUARD IS WIRED WHERE IT MATTERS ──────────────────────────────
const agentSrc = require("fs").readFileSync(
  require("path").join(__dirname, "../src/agent/agent.js"), "utf8");
const dispatch = agentSrc.split("async function sendDraftService")[1].split("return { ok: true")[0];
ok("sendDraftService performs the economic comparison", /compareEconomicSources/.test(dispatch));
ok("it refuses BEFORE the outbound comm_event is written",
  dispatch.indexOf("compareEconomicSources") < dispatch.indexOf("insert into comm_events"));
// STALENESS IS DERIVED, NOT STORED (ruling 2026-07-28). The earlier shape
// wrote status='superseded' then threw inside tx(), which rolls back on throw
// — so the write was always discarded. The fix was to remove the write, not
// repair it: a currently-stale draft has not been replaced or closed, and a
// second stored state would have to be kept in sync with the facts it derives
// from. These assertions stop it being reintroduced.
// Strip comments first: the source deliberately EXPLAINS the removed write,
// so a naive text match finds the prose and reports a defect that isn't there.
const dispatchCode = dispatch.split("\n")
  .filter((l) => !l.trim().startsWith("//")).join("\n");
ok("a stale refusal writes NOTHING to the draft",
  !/status='superseded'/.test(dispatchCode), "a supersede write is back in the dispatch guard");
ok("the only agent_drafts write left in dispatch is the successful send",
  (dispatchCode.match(/update agent_drafts set/g) || []).length <= 1,
  `${(dispatchCode.match(/update agent_drafts set/g) || []).length} agent_drafts writes in the dispatch path`);
ok("`superseded` remains reserved for drafts actually replaced or closed",
  /superseded.*reserved|reserved.*superseded/i.test(agentSrc));
ok("the source states that staleness is derived rather than stored",
  /STALENESS IS DERIVED, NOT STORED/.test(agentSrc));
// The message is split across source lines, so match on the parts, not a
// contiguous phrase — and on the 503, which is the behaviour that matters.
ok("an unreadable source refuses to send rather than assuming freshness",
  /httpErr\(503/.test(dispatch) && /could not be read/.test(dispatch));
ok("the review surface projects staleness from the SAME comparison",
  /draft\.stale\s*=/.test(agentSrc) && /staleReasonForOperator/.test(agentSrc));
ok("the raw snapshot never leaves the server on the review payload",
  /delete draft\.resolved_fact_snapshot_json/.test(agentSrc));
ok("governed-charge facts carry the structured terms digest into the snapshot",
  /terms_digest:\s*termsDigest\(g\)/.test(agentSrc));

console.log("\ndraft_stale_source_proof");
console.log(lines.join("\n"));
console.log(`\n  ${passed} passed, ${failed} failed  (${passed + failed} assertions)\n`);
process.exit(failed ? 1 : 0);
