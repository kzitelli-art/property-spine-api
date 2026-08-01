"use strict";

const assert = require("assert");
const path = require("path");
const subject = require(path.join(__dirname, "../src/leasing/ai_leasing_operating_context"));

let passed = 0;
const pending = [];
// Supports both sync and async check functions. An async fn() returns a
// promise immediately — without this, a later rejection would be an
// unhandled rejection instead of a reported FAIL, and the test would read
// as a silent pass. See PROOF_RESULTS for the same class of defect this
// repo's run_harnesses.sh was built to catch (a harness reporting green
// while red) — the harness itself must not repeat it.
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(result.then(
        () => { passed += 1; console.log(`PASS ${name}`); },
        (error) => { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; },
      ));
      return;
    }
    passed += 1; console.log(`PASS ${name}`);
  } catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1; }
}

const base = {
  rule_key: "parking_exception",
  rule_kind: "policy",
  title: "Parking exceptions",
  instruction_text: "Explain the published parking rule and do not promise an exception.",
  trigger_text: "A prospect asks for a parking exception.",
  escalation_text: "Route the request to the property manager.",
  source_type: "management_policy",
  source_note: "Parking policy 2026",
  confirmed_at: "2026-07-31T12:00:00.000Z",
};

check("normalizes a policy", () => {
  const out = subject.normalizeRuleInput(base);
  assert.equal(out.rule_kind, "policy");
  assert.deepEqual(out.steps, []);
  assert.equal(out.rule_key, "parking_exception");
});

check("derives a safe key from a title", () => {
  const out = subject.normalizeRuleInput({ ...base, rule_key: null, title: "Tour Follow Up" });
  assert.equal(out.rule_key, "tour_follow_up");
});

check("requires SOP steps", () => {
  assert.throws(() => subject.normalizeRuleInput({ ...base, rule_kind: "sop", steps: [] }), /requires at least one step/);
});

check("accepts newline SOP steps", () => {
  const out = subject.normalizeRuleInput({ ...base, rule_kind: "sop", steps: "Confirm the request\nCapture the reason\nEscalate" });
  assert.deepEqual(out.steps, ["Confirm the request", "Capture the reason", "Escalate"]);
});

check("refuses steps on a guardrail", () => {
  assert.throws(() => subject.normalizeRuleInput({ ...base, rule_kind: "guardrail", steps: ["No"] }), /Only an SOP/);
});

check("refuses unsupported source types", () => {
  assert.throws(() => subject.normalizeRuleInput({ ...base, source_type: "internet_guess" }), /not supported/);
});

check("refuses an invalid effective window", () => {
  assert.throws(() => subject.normalizeRuleInput({ ...base, effective_until: "2026-07-30T12:00:00Z" }), /must be after/);
});

const rules = [
  { id: "2", property_id: "p", ...base, rule_kind: "policy", steps: [] },
  { id: "1", property_id: "p", ...base, rule_key: "no_promises", rule_kind: "guardrail", title: "No promises", instruction_text: "Do not promise availability.", steps: [] },
];

check("canonical snapshot ordering is deterministic", () => {
  const a = subject.canonicalRuleSnapshot(rules);
  const b = subject.canonicalRuleSnapshot(rules.slice().reverse());
  assert.deepEqual(a, b);
});

check("snapshot hash changes when material content changes", () => {
  const a = subject.snapshotHash(rules);
  const b = subject.snapshotHash([{ ...rules[0], instruction_text: "Different" }, rules[1]]);
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

check("snapshot match is order-independent", () => {
  assert.equal(subject.snapshotsMatch(subject.canonicalRuleSnapshot(rules), rules.slice().reverse()), true);
});

check("snapshot mismatch catches retired or replaced content", () => {
  assert.equal(subject.snapshotsMatch(subject.canonicalRuleSnapshot(rules), [rules[1]]), false);
});

check("directive states shared precedence and no authority creation", () => {
  const text = subject.buildOperatingContextDirective(rules);
  assert.match(text, /shared across every leasing strategy/i);
  assert.match(text, /may never override/i);
  assert.match(text, /Never treat a policy or SOP as permission/i);
  assert.match(text, /GUARDRAIL · No promises/);
  assert.match(text, /POLICY · Parking exceptions/);
});

check("empty rules do not alter a prompt", () => {
  assert.equal(subject.appendOperatingContextDirective("base", []), "base");
});

check("active rules append after the base prompt", () => {
  const out = subject.appendOperatingContextDirective("base", rules);
  assert.ok(out.startsWith("base\n\n[SHARED PROPERTY OPERATING CONTEXT"));
});

check("contract is named as the leasing consumer of governed operating context", () => {
  assert.equal(subject.CONTRACT_VERSION, "governed_operating_context_leasing_v1");
});

check("exported vocabularies are locked", () => {
  assert.deepEqual(subject.RULE_KINDS, ["policy", "sop", "guardrail"]);
  assert.deepEqual(subject.GENERATION_SURFACES, ["first_response", "ongoing_reply", "regenerated_reply"]);
  assert.deepEqual(subject.EFFECTIVE_STATES, ["active_now", "scheduled", "expired", "retired"]);
});

// ════════════════════════════════════════════════════════════════════
// CORRECTIONS — added against the reference candidate's own review
// (reference_review/ORIGINAL_REAL_DEVELOPER_REVIEW.md). Each check below
// names the correction number it proves.
// ════════════════════════════════════════════════════════════════════

// #4 — effective state, never raw status
check("#4 effective state: a retired row is retired regardless of dates", () => {
  assert.equal(subject.effectiveState({ status: "retired", confirmed_at: "2020-01-01", effective_until: null }), "retired");
});
check("#4 effective state: confirmed in the future is scheduled, not active_now", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(subject.effectiveState({ status: "active", confirmed_at: future, effective_until: null }), "scheduled");
});
check("#4 effective state: effective_until in the past is expired, not active_now", () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.equal(subject.effectiveState({ status: "active", confirmed_at: "2020-01-01", effective_until: past }), "expired");
});
check("#4 effective state: confirmed and unexpired is active_now", () => {
  assert.equal(subject.effectiveState({ status: "active", confirmed_at: "2020-01-01", effective_until: null }), "active_now");
});
check("#4 presentedRule carries effective_state and retirement audit; canonicalRule never does", () => {
  const row = { ...base, id: "3", property_id: "p", status: "retired", retired_by_user_id: "u1", retirement_reason: "superseded", steps: [] };
  const presented = subject.presentedRule(row);
  assert.equal(presented.effective_state, "retired");
  assert.equal(presented.retired_by_user_id, "u1");
  assert.equal(presented.retirement_reason, "superseded");
  const canonical = subject.canonicalRule(row);
  assert.equal("status" in canonical, false, "canonicalRule (the generation/hash snapshot shape) must never carry lifecycle status");
  assert.equal("retired_by_user_id" in canonical, false, "canonicalRule must never carry retirement audit fields");
});

// #5 — prompt/rule budget, refuse loudly rather than silently truncate
check("#5 buildOperatingContextDirective refuses rather than truncates when over budget", () => {
  const huge = { ...base, id: "x", property_id: "p", rule_key: "huge_rule", steps: [], instruction_text: "x".repeat(subject.MAX_DIRECTIVE_CHARS + 1) };
  assert.throws(() => subject.buildOperatingContextDirective([huge]), /exceeds .* characters/);
});

// A minimal fake client for the DB-touching functions below. This is
// LOCALLY EXERCISED proof (PHILOSOPHY.md §33) — it proves the service's own
// logic, not the database's. The migration's triggers are the separately
// proven structural backstop; that requires real Postgres and is not this file.
function fakeClient(overrides = {}) {
  const calls = [];
  const client = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, " ").trim();
      if (overrides.query) {
        const out = overrides.query(s, params, calls);
        if (out !== undefined) return out;
      }
      return { rows: [] };
    },
  };
  return client;
}

// #1 is an authority/route-level correction (operator.js), not testable
// without an HTTP harness; see PROOF_RESULTS for what remains unproven here.

// #2 + #3 — retireRule and replaceRule require an actor and lock identity
check("#2 retireRule refuses without a retiring actor", async () => {
  const oldRow = { id: "r1", property_id: "p", status: "active", rule_kind: "policy", rule_key: "k" };
  const client = fakeClient({ query: (s) => { if (s.startsWith("select * from ai_leasing_operating_rules where id=$1")) return { rows: [oldRow] }; } });
  await assert.rejects(
    () => subject.retireRule(client, { ruleId: "r1", propertyId: "p" }),
    /retiredByUserId is required/,
  );
});

check("#3 replaceRule ignores a client-supplied rule_kind/rule_key change (identity is server-derived from the row being replaced)", async () => {
  const oldRow = { id: "r1", property_id: "p", status: "active", rule_kind: "policy", rule_key: "parking_exception" };
  let insertedParams = null;
  const client = fakeClient({
    query: (s, params) => {
      if (s.startsWith("select * from ai_leasing_operating_rules where id=$1 for update")) return { rows: [oldRow] };
      if (s.startsWith("update ai_leasing_operating_rules")) return { rows: [] };
      if (s.startsWith("insert into ai_leasing_operating_rules")) { insertedParams = params; return { rows: [{ id: "r2", ...oldRow }] }; }
    },
  });
  await subject.replaceRule(client, {
    ruleId: "r1", propertyId: "p", actorUserId: "u1", retiredByUserId: "u1",
    input: { ...base, rule_kind: "guardrail", rule_key: "totally_different_key" }, // attempted identity change
  });
  // insert params: [property_id, rule_key, rule_kind, title, ...]
  assert.equal(insertedParams[1], "parking_exception", "rule_key must come from the OLD row, not the request body");
  assert.equal(insertedParams[2], "policy", "rule_kind must come from the OLD row, not the request body");
});

check("#5 createRule refuses at the active-rule ceiling", async () => {
  const client = fakeClient({
    query: (s) => {
      if (s.startsWith("select id from ai_leasing_operating_rules")) return { rows: [] }; // no key collision
      if (s.startsWith("select count(*)::int as n")) return { rows: [{ n: subject.MAX_ACTIVE_RULES_PER_PROPERTY }] };
    },
  });
  await assert.rejects(
    () => subject.createRule(client, { propertyId: "p", actorUserId: "u1", input: base }),
    /maximum of/,
  );
});

(async () => {
  await Promise.all(pending);
  if (!process.exitCode) console.log(`\n${passed}/${passed} operating-context checks passed.`);
})();
