"use strict";

const assert = require("assert");
const ask = require("../../src/agent/ask_spine_answer.js");

const PROPERTY = "property-a";
let passed = 0;
async function ok(label, check) {
  await check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

//  ⚠ FAKES THE SAME TWO FUNCTIONS THE CAPITAL STACK UI CALLS — loadHistory
//  then position()/standingProjection(). No new reader shape is being
//  tested here; this proves ask_spine_answer.js gathers through the exact
//  same governed pipe, never a second one.
const NOT_ESTABLISHED = "NOT_ESTABLISHED";

function equityService(overrides = {}) {
  return {
    async loadHistory(_db, propertyId) {
      if (overrides.error) throw overrides.error;
      if (overrides.spy) overrides.spy.calledWith = propertyId;
      return overrides.history || { positions: [] };
    },
  };
}

function equityRead(overrides = {}) {
  return {
    NOT_ESTABLISHED,
    position(_history, asOf) {
      return overrides.reading || {
        as_of: asOf,
        positions: [{
          position_id: "secret-position-id",
          position_class: "preferred",
          issuer_legal_entity_id: "secret-issuer-id",
          holder: { legal_entity_id: "secret-holder-id", legal_name: "MSC 4125 Chestnut LLC" },
          preferred: {
            terms: [{ term_source: "governing_document", source_authority: "governed_read",
              current_pay_rate_bp: 1250, compounding: "quarterly" }],
            accrued_preferred_return: { truth_state: NOT_ESTABLISHED },
          },
          common: null,
          capital_amounts: { contribution: [], ownership_percent: [] },
          encumbrance: { truth_state: NOT_ESTABLISHED },
        }],
        conflicts: [],
        coverage_gaps: [{ kind: "unrecorded_ownership_percent", position_id: "secret-position-id",
          what: "a common holder is named with no recorded ownership percentage" }],
      };
    },
    standingProjection(reading) {
      return {
        position_count: reading.positions.length,
        named_holder_count: reading.positions.length,
        preferred_position_count: reading.positions.filter((p) => p.position_class === "preferred").length,
        open_conflict_count: reading.conflicts.length,
        coverage_gap_count: reading.coverage_gaps.length,
        next_milestone: reading.coverage_gaps.length
          ? "resolve the largest recorded coverage gap" : "no open coverage gaps or conflicts recorded",
      };
    },
  };
}

function model(answerText, spy = {}) {
  return { messages: { async create(request) {
    spy.request = request;
    return { content: [{ type: "text", text: JSON.stringify({
      outcome: "answered", answer: answerText,
    }) }] };
  } } };
}

async function main() {
  console.log("\nEQUITY ASK SPINE\n");

  await ok("capital-stack language selects Equity; plain 'equity' outside that vocabulary does not force it",
    async () => {
      assert.strictEqual(ask.questionSubject("Who holds preferred equity at this property?"), "equity");
      assert.strictEqual(ask.questionSubject("What is our cap table for this deal?"), "equity");
      assert.strictEqual(ask.questionSubject("What is our ownership percentage here?"), "equity");
    });

  await ok("cross-domain questions preserve the composition refusal", async () => {
    assert.strictEqual(ask.questionSubject(
      "Is our preferred equity current and is the property inspection compliant?"),
    "composition_unavailable");
  });

  await ok("no Asset Management entitlement means no governed read", async () => {
    let called = false;
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: [], subject: "equity",
      question: "Who holds preferred equity here?",
      equityService: { async loadHistory() { called = true; } },
      equityRead: equityRead(),
    });
    assert.strictEqual(called, false);
    assert.strictEqual(facts.equity, undefined);
  });

  await ok("the canonical reader receives the server-derived property, not a client-supplied one", async () => {
    const spy = {};
    await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "equity",
      question: "Who holds preferred equity here?",
      equityService: equityService({ spy }),
      equityRead: equityRead(),
    });
    assert.strictEqual(spy.calledWith, PROPERTY);
  });

  await ok("zero positions reads NOT_ESTABLISHED, never a fabricated empty success", async () => {
    const facts = await ask.gatherFacts({}, {
      property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "equity",
      question: "Who holds equity here?",
      equityService: equityService({ history: { positions: [] } }),
      equityRead: equityRead(),
    });
    assert.strictEqual(facts.equity.read_state, "OK");
    assert.strictEqual(facts.equity.positions.length, 0);
    assert.strictEqual(facts.equity.standing.truth_state, NOT_ESTABLISHED);
  });

  await ok("a failed read is named and never shaped as NOT_ESTABLISHED (§40.7's silences stay distinct)",
    async () => {
      const facts = await ask.gatherFacts({}, {
        property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "equity",
        question: "Who holds equity here?",
        equityService: equityService({ error: new Error("database down") }),
        equityRead: equityRead(),
      });
      assert.strictEqual(facts.equity.read_state, "READ_FAILED");
      assert.deepStrictEqual(facts.reads_that_failed, ["equity"]);
      assert.strictEqual(facts.equity.standing, undefined);
    });

  await ok("a real position is gathered with database ids stripped before the model ever sees it",
    async () => {
      const facts = await ask.gatherFacts({}, {
        property_id: PROPERTY, allowed_modules: ["asset_management"], subject: "equity",
        question: "Who holds preferred equity here, on what terms?",
        equityService: equityService({ history: { positions: [{ id: "p1" }] } }),
        equityRead: equityRead(),
      });
      assert.strictEqual(facts.equity.read_state, "OK");
      assert.strictEqual(facts.equity.standing.preferred_position_count, 1);
      const blob = JSON.stringify(facts.equity);
      assert(!/secret-position-id|secret-issuer-id|secret-holder-id/.test(blob),
        "no raw record id reached the gathered facts: " + blob);
      assert.strictEqual(facts.equity.positions[0].holder.legal_name, "MSC 4125 Chestnut LLC");
      assert.strictEqual(facts.equity.positions[0].preferred.accrued_preferred_return.truth_state,
        NOT_ESTABLISHED);
      assert.strictEqual(facts.equity.coverage_gaps.length, 1);
    });

  await ok("the composer grounds the answer, keeps ids from the model, and teaches Equity's own walls",
    async () => {
      const spy = {};
      const result = await ask.answer({}, model(
        "MSC's preferred return is 12.50%, governed. Nothing else is established.", spy), {
        property_id: PROPERTY, allowed_modules: ["asset_management"],
        question: "Who holds preferred equity here, on what terms?",
        equityService: equityService({ history: { positions: [{ id: "p1" }] } }),
        equityRead: equityRead(),
      });
      assert.strictEqual(result.outcome, "answered");
      assert.strictEqual(result.grounded_on.equity_position_count, 1);
      assert.strictEqual(result.grounded_on.equity_read_state, "OK");
      assert.strictEqual(result.grounded_on.equity_coverage_gap_count, 1);
      assert(!spy.request.messages[0].content.includes("secret-position-id"));
      assert(/accrued preferred balance is NEVER computed/i.test(spy.request.system));
      assert(/Minimum-Dividend-shaped schedule/i.test(spy.request.system));
      assert(/not yet applied/i.test(spy.request.system));
      assert(/coverage gap, not a property fact you may fill in/i.test(spy.request.system));
    });

  await ok("unauthorized Equity questions reach neither reader nor model", async () => {
    let read = false, composed = false;
    const result = await ask.answer({}, { messages: { async create() { composed = true; } } }, {
      property_id: PROPERTY, allowed_modules: [],
      question: "Who holds preferred equity here?",
      equityService: { async loadHistory() { read = true; } },
      equityRead: equityRead(),
    });
    assert.strictEqual(result.outcome, "not_authorized");
    assert.strictEqual(read, false);
    assert.strictEqual(composed, false);
    assert(/Preferred Equity or Common Equity/.test(result.answer));
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
