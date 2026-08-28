"use strict";

const assert = require("assert");
const path = require("path");
const subject = require(path.join(__dirname, "../../src/leasing/ai_leasing_operating_context"));

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

// ════════════════════════════════════════════════════════════════════
// SECOND-PASS DESIGN CORRECTIONS — found by re-reading the module after
// the first round, not supplied by any external review.
// ════════════════════════════════════════════════════════════════════

// ONE IMPLEMENTATION OF "IN FORCE": loadActiveRules must delegate the
// in-force judgment to effectiveState rather than carry a second copy of the
// rule in SQL. Proven by handing it rows the OLD SQL predicate would have
// filtered server-side and confirming the JS filter removes exactly them.
check("one implementation: loadActiveRules filters via effectiveState, not a second SQL date rule", async () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const past = "2026-07-01T00:00:00.000Z";
  const future = "2026-09-01T00:00:00.000Z";
  const rows = [
    { id: "in_force", property_id: "p", ...base, rule_key: "in_force", status: "active", confirmed_at: past, effective_until: null, steps: [] },
    { id: "scheduled", property_id: "p", ...base, rule_key: "scheduled", status: "active", confirmed_at: future, effective_until: null, steps: [] },
    { id: "expired", property_id: "p", ...base, rule_key: "expired", status: "active", confirmed_at: past, effective_until: past, steps: [] },
  ];
  let sqlSeen = "";
  const db = fakeClient({ query: (s) => { sqlSeen = s; return { rows }; } });
  const out = await subject.loadActiveRules(db, "p", now);
  assert.deepEqual(out.map((r) => r.id), ["in_force"], "only the in-force rule may reach generation");
  assert.equal(/confirmed_at\s*<=/.test(sqlSeen), false, "the SQL must not carry its own second copy of the in-force date rule");
  assert.equal(/effective_until/.test(sqlSeen.split("where")[1] || ""), false, "the SQL WHERE clause must not re-implement the effective window");
});

check("one implementation: the settings surface and generation agree on the same row", async () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const scheduled = { id: "s1", property_id: "p", ...base, status: "active", confirmed_at: "2026-09-01T00:00:00.000Z", effective_until: null, steps: [] };
  // What the settings surface would label it:
  assert.equal(subject.effectiveState(scheduled, now), "scheduled");
  // What generation would include:
  const db = fakeClient({ query: () => ({ rows: [scheduled] }) });
  const loaded = await subject.loadActiveRules(db, "p", now);
  assert.equal(loaded.length, 0, "a rule labelled 'scheduled' must not be in the generation set");
});

// WRITE-TIME BUDGET: a save that would silently degrade every later
// generation must be refused at the moment of writing, in operator language.
// The per-field cap and the whole-prompt budget are DIFFERENT limits and both
// are load-bearing. normalizeRuleInput caps one instruction at 6,000 chars;
// MAX_DIRECTIVE_CHARS caps the assembled directive at 12,000. A single rule
// therefore can never overflow the prompt by itself — the field cap always
// fires first, with its own clearer message. The budget only ever binds
// ACROSS rules, which is exactly the case an operator cannot see coming.
check("write-time budget: the two limits are layered — one oversized rule is caught by the field cap first", () => {
  assert.ok(subject.MAX_DIRECTIVE_CHARS > 6000,
    "if the directive budget ever drops to/below the 6,000-char field cap, a single valid rule could overflow the prompt and the two limits would need re-reconciling");
  assert.throws(
    () => subject.normalizeRuleInput({ ...base, instruction_text: "x".repeat(6001) }),
    /Instruction is too long/,
  );
});

check("write-time budget: refuses when EXISTING rules plus the new one overflow, though none is individually oversized", async () => {
  // Three ~4,200-char rules: each well inside the 6,000 field cap, together
  // over the 12,000 directive budget. This is the real failure shape.
  const chunk = "y".repeat(4200);
  const existing = [1, 2].map((n) => ({
    id: `e${n}`, property_id: "p", ...base, rule_key: `existing_${n}`, status: "active",
    confirmed_at: "2026-07-01T00:00:00.000Z", effective_until: null, instruction_text: chunk, steps: [],
  }));
  const client = fakeClient({
    query: (s) => {
      if (s.startsWith("select id from ai_leasing_operating_rules")) return { rows: [] };
      if (s.startsWith("select count(*)::int as n")) return { rows: [{ n: existing.length }] };
      if (s.includes("where property_id=$1 and status='active'")) return { rows: existing };
    },
  });
  await assert.rejects(
    () => subject.createRule(client, { propertyId: "p", actorUserId: "u1", input: { ...base, rule_key: "new_one", instruction_text: chunk } }),
    /character limit the leasing assistant can be given/,
    "must refuse in operator language at write time, not throw a raw 500 later at generation time",
  );
});

check("write-time budget: a create that fits is not refused", async () => {
  const client = fakeClient({
    query: (s) => {
      if (s.startsWith("select id from ai_leasing_operating_rules")) return { rows: [] };
      if (s.startsWith("select count(*)::int as n")) return { rows: [{ n: 0 }] };
      if (s.includes("where property_id=$1 and status='active'")) return { rows: [] };
      if (s.startsWith("insert into ai_leasing_operating_rules")) return { rows: [{ id: "new", rule_kind: "policy" }] };
    },
  });
  const out = await subject.createRule(client, { propertyId: "p", actorUserId: "u1", input: base });
  assert.equal(out.id, "new", "an ordinary rule must still save — the budget must not refuse everything");
});

check("write-time budget: a scheduled rule still counts toward the ceiling", async () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const chunk = "z".repeat(subject.MAX_DIRECTIVE_CHARS - 500);
  const scheduledBig = {
    id: "future_big", property_id: "p", ...base, rule_key: "future_big", status: "active",
    confirmed_at: "2026-09-01T00:00:00.000Z", effective_until: null, instruction_text: chunk, steps: [],
  };
  const db = fakeClient({ query: () => ({ rows: [scheduledBig] }) });
  // It is NOT in force today...
  assert.equal((await subject.loadActiveRules(db, "p", now)).length, 0);
  // ...but it IS budget-relevant, because it will be.
  const relevant = await subject.loadBudgetRelevantRules(db, "p", now);
  assert.deepEqual(relevant.map((r) => r.id), ["future_big"],
    "a scheduled rule must count toward the budget — treating it as unreal is the mistake correction #4 fixed");
});

check("write-time budget: replaceRule excludes the row it is replacing from the ceiling", async () => {
  // A(4200) + B(4200) already sit near the budget. Replacing B with a
  // same-size B' fits (A + B' = 8400) but would overflow if the superseded
  // copy were double-counted (A + B + B' = 12600).
  const chunk = "w".repeat(4200);
  const other = {
    id: "other", property_id: "p", ...base, rule_key: "other_rule", rule_kind: "policy", status: "active",
    confirmed_at: "2026-07-01T00:00:00.000Z", effective_until: null, instruction_text: chunk, steps: [],
  };
  const oldRow = {
    id: "r1", property_id: "p", ...base, rule_key: "parking_exception", rule_kind: "policy", status: "active",
    confirmed_at: "2026-07-01T00:00:00.000Z", effective_until: null, instruction_text: chunk, steps: [],
  };
  let inserted = false;
  const client = fakeClient({
    query: (s) => {
      if (s.startsWith("select * from ai_leasing_operating_rules where id=$1 for update")) return { rows: [oldRow] };
      if (s.includes("where property_id=$1 and status='active'")) return { rows: [other, oldRow] };
      if (s.startsWith("update ai_leasing_operating_rules")) return { rows: [] };
      if (s.startsWith("insert into ai_leasing_operating_rules")) { inserted = true; return { rows: [{ id: "r2" }] }; }
    },
  });
  await subject.replaceRule(client, {
    ruleId: "r1", propertyId: "p", actorUserId: "u1", retiredByUserId: "u1",
    input: { ...base, instruction_text: chunk },
  });
  assert.equal(inserted, true, "a like-for-like replacement must not be refused by double-counting the superseded rule");
});

check("write-time budget: a refused replace does NOT retire the rule still in force", async () => {
  // Two other ~5,000-char rules already in force; the replacement cannot fit
  // even after the superseded row is excluded.
  const chunk = "q".repeat(5000);
  const others = [1, 2].map((n) => ({
    id: `o${n}`, property_id: "p", ...base, rule_key: `other_${n}`, rule_kind: "policy", status: "active",
    confirmed_at: "2026-07-01T00:00:00.000Z", effective_until: null, instruction_text: chunk, steps: [],
  }));
  const oldRow = {
    id: "r1", property_id: "p", ...base, rule_key: "parking_exception", rule_kind: "policy", status: "active",
    confirmed_at: "2026-07-01T00:00:00.000Z", effective_until: null, instruction_text: "short", steps: [],
  };
  const client = fakeClient({
    query: (s) => {
      if (s.startsWith("select * from ai_leasing_operating_rules where id=$1 for update")) return { rows: [oldRow] };
      if (s.includes("where property_id=$1 and status='active'")) return { rows: others.concat([oldRow]) };
    },
  });
  await assert.rejects(() => subject.replaceRule(client, {
    ruleId: "r1", propertyId: "p", actorUserId: "u1", retiredByUserId: "u1",
    input: { ...base, instruction_text: chunk },
  }), /character limit/);
  const retired = client.calls.some((c) => /^update ai_leasing_operating_rules/.test(c.sql.replace(/\s+/g, " ").trim()));
  assert.equal(retired, false, "a refused replace must leave the governed rule in force, never retire it and then fail");
});

// AUTHORITY IS SERVER-DECIDED AND SURFACED, so the browser can render honestly.
check("authority: listSettings reports may_manage_governance so the UI cannot offer a write that 403s", async () => {
  const db = fakeClient({ query: () => ({ rows: [] }) });
  const denied = await subject.listSettings(db, { propertyId: "p", mayManageGovernance: false });
  assert.equal(denied.authority.may_manage_governance, false);
  assert.match(denied.authority.read_only_reason, /manage roles/);
  const allowed = await subject.listSettings(db, { propertyId: "p", mayManageGovernance: true });
  assert.equal(allowed.authority.may_manage_governance, true);
  assert.equal(allowed.authority.read_only_reason, null);
});

check("authority: the read defaults to read-only when the caller asserts nothing", async () => {
  const db = fakeClient({ query: () => ({ rows: [] }) });
  const out = await subject.listSettings(db, { propertyId: "p" });
  assert.equal(out.authority.may_manage_governance, false, "absent authority must fail closed, never open");
});

check("snapshotsMatch compares digests without implying a secret-comparison threat model", () => {
  assert.equal(subject.snapshotsMatch(subject.canonicalRuleSnapshot(rules), rules.slice().reverse()), true);
  assert.equal(subject.snapshotsMatch([], rules), false);
  // A shape it must answer rather than crash on:
  assert.equal(subject.snapshotsMatch(null, []), true);
});

(async () => {
  await Promise.all(pending);
  if (!process.exitCode) console.log(`\n${passed}/${passed} operating-context checks passed.`);
})();
