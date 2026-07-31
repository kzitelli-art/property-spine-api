"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const runtime = require("../src/leasing/ai_leasing_strategy_runtime");

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.stack || e}`); process.exitCode = 1; }
}

class SavepointClient {
  constructor({ failAssignment = false } = {}) { this.failAssignment = failAssignment; this.queries = []; }
  async query(sql) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    this.queries.push(q);
    if (this.failAssignment && q.includes("from conversations c") && q.includes("for update of c, l")) {
      const e = new Error("simulated"); e.code = "simulated_assignment_failure"; throw e;
    }
    if (q.includes("from conversations c") && q.includes("for update of c, l")) {
      return { rows: [{ conversation_id: "conversation-1", leasing_lead_id: "lead-1", property_id: "property-a", person_id: "person-1" }] };
    }
    if (q.includes("from leasing_lead_ai_strategy_current")) return { rows: [] };
    if (q.includes("from property_ai_leasing_strategy_deployments")) return { rows: [] };
    return { rows: [] };
  }
}

const patch = fs.readFileSync(path.join(__dirname, "../ai-leasing-strategy-runtime-activation.patch"), "utf8");
const migration = fs.readFileSync(path.join(__dirname, "../migrations/120_ai_leasing_strategy_foundation.sql"), "utf8");

(async () => {
  await test("assignment failure rolls back only the strategy savepoint", async () => {
    const client = new SavepointClient({ failAssignment: true });
    const out = await runtime.assignForConversationWithoutBlockingCapture(client, {
      conversationId: "conversation-1", leasingLeadId: "lead-1", propertyId: "property-a",
    }, { log: () => {} });
    assert.strictEqual(out.assigned, false);
    assert(client.queries.some((q) => q.startsWith("rollback to savepoint ai_leasing_strategy_")));
  });
  await test("no deployment leaves capture on the generic path", async () => {
    const client = new SavepointClient();
    const out = await runtime.assignForConversationWithoutBlockingCapture(client, {
      conversationId: "conversation-1", leasingLeadId: "lead-1", propertyId: "property-a",
    });
    assert.strictEqual(out.reason, "no_active_strategy_deployment");
    assert(!client.queries.some((q) => q.startsWith("rollback to savepoint")));
  });
  await test("directive is absent without assignment", () => {
    assert.strictEqual(runtime.appendStrategyDirective("BASE", null), "BASE");
  });
  await test("deterministic replacements remove strategy credit", () => {
    assert.strictEqual(runtime.finalBodyRetainsStrategyCredit({ strategyApplied: true, policyCode: "fairhousing_redirected" }), false);
    assert.strictEqual(runtime.finalBodyRetainsStrategyCredit({ strategyApplied: true, policyCode: null }), true);
  });

  await test("intake assignment is tied to exact leasing lead", () => {
    assert(patch.includes("leasingLeadId: lead.id"));
    assert(patch.includes("assignmentKey: `${propertyId}:${lead.id}`"));
  });
  await test("ongoing inbound resolves the one open opportunity", () => {
    assert(patch.includes("status not in ('leased','lost')"));
    assert(patch.includes("strategyLead.id"));
    assert(patch.includes("no_open_leasing_opportunity"));
  });
  await test("returning prospect does not reuse conversation id as assignment key", () => {
    assert(!patch.includes("assignmentKey: `${b.property_id}:${conv.id}`"));
    assert(!patch.includes("assignmentKey: `${property_id}:${conv.id}`"));
  });
  await test("agent runs pin both assignment and opportunity", () => {
    assert(patch.includes("ai_leasing_strategy_assignment_event_id, ai_leasing_strategy_leasing_lead_id"));
    assert(migration.includes("ai_leasing_strategy_leasing_lead_id uuid"));
  });
  await test("first response attribution includes exact opportunity", () => {
    assert(patch.includes("commEventId: commEvent.id, conversationId, leasingLeadId: lead.id, propertyId"));
  });
  await test("ongoing dispatch attribution uses run-pinned opportunity", () => {
    assert(patch.includes("leasingLeadId: run.ai_leasing_strategy_leasing_lead_id"));
  });
  await test("human edit is only marked when text actually changed", () => {
    assert(patch.includes("normalizedEdit !== d.generated_body"));
  });
  await test("application submission resolves and verifies direct opportunity", () => {
    assert(patch.includes("resolveOpenLeasingLeadId"));
    assert(patch.includes("Application evidence is never inferred across opportunities"));
    assert(patch.includes("leasing_lead_id, status, applicant_name"));
  });
  await test("each generation path checks its own validated runtime identity", () => {
    for (const surface of ["first_response", "ongoing_reply", "regenerated_reply"]) assert(patch.includes(`surface: "${surface}"`));
    assert(patch.includes("promptRevision: AI_FIRST_RESPONSE_PROMPT_REVISION"));
    assert(patch.includes("promptRevision: PROMPT_REVISION"));
  });
  await test("all three generation paths remain wired", () => {
    assert.strictEqual((patch.match(/appendStrategyDirective\(/g) || []).length, 2);
    assert((patch.match(/assignForConversationWithoutBlockingCapture\(client/g) || []).length >= 3);
  });
  await test("strategy-bearing messages still fail closed on attribution", () => {
    const attr = patch.indexOf("recordAiMessageAttribution(client");
    const outbound = patch.lastIndexOf("insert into comm_events", attr);
    const dispatched = patch.indexOf("mark the draft dispatched", attr);
    assert(outbound >= 0 && attr > outbound && dispatched > attr);
  });
  await test("migration prevents deployment without replay evidence", () => {
    assert(migration.includes("trg_require_validated_ai_strategy_deployment"));
    assert(migration.includes("must pass first-response, ongoing-reply, and regenerated-reply validation"));
  });
  await test("migration creates no active strategy deployment", () => {
    assert(!/insert\s+into\s+property_ai_leasing_strategy_deployments/i.test(migration));
  });
  await test("runtime patch still makes no app or UI change", () => {
    assert(!patch.includes("property-spine-app"));
    assert(!patch.includes("conversations-board.js"));
    assert(!patch.includes("avatar"));
  });

  console.log(`\n${passed} hardened runtime checks passed.`);
  if (process.exitCode) process.exit(process.exitCode);
})();
