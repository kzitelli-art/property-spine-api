#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt");
const askSpineAnswer = require("../src/agent/ask_spine_answer");
const obligationRead = require("../src/obligations/operator_obligations_service");

const EXPECTED = 28;
let passed = 0;
let failed = 0;
function ok(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  ->  " + detail : "")); }
}

receipt.begin(__filename, { expected: EXPECTED });

(async () => {
  ok("the owner's exact question is personal attention",
    askSpineAnswer.isPersonalAttentionQuestion("What should I do today?"));
  ok("an assignment question is personal attention",
    askSpineAnswer.isPersonalAttentionQuestion("What work is assigned to me?"));
  ok("a natural today variant is personal attention",
    askSpineAnswer.isPersonalAttentionQuestion("What do I need to do today?"));
  ok("a personal question may name its property",
    askSpineAnswer.isPersonalAttentionQuestion("What should I do today at Skyline Apartments?"));
  ok("a property-wide attention question stays property-wide",
    !askSpineAnswer.isPersonalAttentionQuestion("What needs attention at Skyline?"));
  ok("a technician action is not a personal read",
    !askSpineAnswer.isPersonalAttentionQuestion("Accept work order 1042"));
  ok("a question about one work order remains a technician conversation",
    !askSpineAnswer.isPersonalAttentionQuestion("What should I do about work order 1042?"));

  let modelCalls = 0;
  let queryCalls = 0;
  const db = {
    async query(sql, params) {
      queryCalls += 1;
      ok("the canonical query keeps the property and module walls",
        /o\.property_id = \$1/.test(sql) && /o\.module = any\(\$2::text\[\]\)/.test(sql));
      ok("personal scope is direct assignment, escalation, or unassigned primary work",
        /o\.assigned_user_id = \$4/.test(sql)
          && /o\.escalates_to_user_id = \$4/.test(sql)
          && /o\.assigned_user_id is null and o\.module = any\(\$5::text\[\]\)/.test(sql));
      ok("identity and module ownership are server inputs",
        JSON.stringify(params) === JSON.stringify([
          "property-1", ["leasing", "management"], "open", "user-1", ["leasing"],
        ]), JSON.stringify(params));
      return { rows: [
        {
          id: "obligation-1", property_id: "property-1", module: "leasing",
          type: "application_followup", label: "Send Jordan's application",
          due_at: "2026-08-21T12:00:00.000Z", assigned_user_id: "user-1",
          person_id: "person-1", is_overdue: true, total_open: 2,
          personal_basis: "assigned_to_you",
        },
        {
          id: "obligation-2", property_id: "property-1", module: "leasing",
          type: "tour_followup", label: "Capture Taylor's tour",
          due_at: "2026-08-22T15:00:00.000Z", assigned_user_id: null,
          related_type: "application", related_id: "application-1",
          is_overdue: false, total_open: 2,
          personal_basis: "unassigned_in_your_module",
        },
      ] };
    },
  };
  const anthropic = { messages: { async create() { modelCalls += 1; throw new Error("model must not run"); } } };
  const out = await askSpineAnswer.answer(db, anthropic, {
    property_id: "property-1",
    allowed_modules: ["leasing", "management"],
    operator_user_id: "user-1",
    primary_for_modules: ["leasing", "outside-entitlement"],
    question: "What should I do today?",
  });

  ok("the personal question executes one canonical read", queryCalls === 1);
  ok("the personal answer never needs a model", modelCalls === 0);
  ok("the shared answer is successful", out.outcome === "answered");
  ok("the answer states the recorded personal count", /^2 recorded open items are routed to you\./.test(out.answer));
  ok("the canonical ranking is preserved in the answer",
    out.answer.indexOf("Send Jordan's application") < out.answer.indexOf("Capture Taylor's tour"));
  ok("overdue meaning is preserved", /Send Jordan's application \(overdue\)/.test(out.answer));
  ok("the grounding names personal scope",
    out.grounded_on.attention_scope === "personal" && out.grounded_on.personal_open_items === 2);
  ok("server-resolved references survive without model-owned ids", out.references.length === 2);
  ok("the direct-assignment basis survives", out.references[0].personal_basis === "assigned_to_you");
  ok("the module-owner basis survives", out.references[1].personal_basis === "unassigned_in_your_module");

  let unauthorizedQueries = 0;
  const noIdentity = await askSpineAnswer.answer({
    async query() { unauthorizedQueries += 1; return { rows: [] }; },
  }, anthropic, {
    property_id: "property-1", allowed_modules: ["leasing"],
    question: "What should I do today?",
  });
  ok("missing live identity refuses", noIdentity.outcome === "not_authorized");
  ok("missing identity reads no work", unauthorizedQueries === 0);

  let serviceMissingIdentityRefused = false;
  try {
    await obligationRead.personalAttention(db, {
      property_id: "property-1", allowed_modules: [], primary_for_modules: [],
    });
  } catch (error) {
    serviceMissingIdentityRefused = /server-derived operator_user_id/.test(error.message);
  }
  ok("the canonical service itself requires live identity", serviceMissingIdentityRefused);

  const root = path.join(__dirname, "..");
  const route = fs.readFileSync(path.join(root, "src", "agent", "ask_spine.js"), "utf8");
  const sms = fs.readFileSync(path.join(root, "src", "comms", "staff_governed_read.js"), "utf8");
  const leasingRail = fs.readFileSync(path.join(root, "src", "leasing", "leasingconversion.js"), "utf8");
  const closure = fs.readFileSync(path.join(root, "src", "leasing", "conversion_obligation_closure.js"), "utf8");
  ok("the dashboard passes its live user and module ownership",
    /operator_user_id: req\.operator\.id/.test(route)
      && /primary_for_modules: req\.operator\.primary_for_modules/.test(route));
  ok("staff SMS passes the same identity inputs",
    /operator_user_id: userId/.test(sms)
      && /primary_for_modules: propertyContext\.primaryForModules/.test(sms));
  ok("a new leasing rung stamps its eligible owner on the canonical obligation",
    /assigned_user_id: owner_user_id \|\| null/.test(leasingRail));
  ok("an explicit conversation handoff moves the link and canonical obligation together",
    /with moved as \([\s\S]*update leasing_conversion_obligations[\s\S]*returning obligation_id[\s\S]*update obligations o[\s\S]*assigned_user_id=\$1/.test(leasingRail));
  ok("a reopened rung restores the same owner on the canonical obligation",
    /update obligations[\s\S]*status='open'[\s\S]*assigned_user_id=\$3[\s\S]*owner_eligibility_state=\$4/.test(closure));

  process.exitCode = receipt.complete({
    harness: __filename, passed, failed, expectedAtLeast: EXPECTED,
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
