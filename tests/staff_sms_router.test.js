#!/usr/bin/env node
"use strict";

const receipt = require("./_run_receipt");
const { routeStaffSmsTurn } = require("../src/conversation/staff_sms_router");
const technicianIntent = require("../src/conversation/technician_intent");
const { operatingReceipt } = require("../src/conversation/receipt");

const EXPECTED = 35;
let passed = 0;
let failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `  ->  ${detail}` : ""}`); }
};

receipt.begin(__filename, { expected: EXPECTED });

const routesTo = (destination, text, attachments = []) => {
  const result = routeStaffSmsTurn({ text, attachments });
  return result.destination === destination ? result : null;
};

console.log("\n-- CLEAR GOVERNED READS --------------------------------------");
for (const [text, subject] of [
  ["What pricing is published?", "economics"],
  ["How many units are occupied?", "tenancy"],
  ["What is the utility setup?", "utility"],
  ["Where is Maria's application?", "leasing_person"],
  ["What is the loan balance?", "debt"],
  ["Who is hosting tours this week?", "tour_schedule"],
]) {
  const routed = routesTo("ask_spine", text);
  ok(`${JSON.stringify(text)} routes to Ask Spine`, !!routed);
  ok(`...with subject ${subject}`, routed && routed.subject === subject,
    routed && routed.subject);
}

for (const text of ["What should I do today?", "What work is assigned to me?"]) {
  const routed = routesTo("ask_spine", text);
  ok(`${JSON.stringify(text)} uses the shared personal Ask Spine read`, !!routed);
  ok("...as a work question", routed && routed.subject === "work");
}

console.log("\n-- WORK ALWAYS WINS ------------------------------------------");
for (const text of [
  "accept 1042",
  "I'm heading over",
  "the valve is corroded and needs replacing",
  "anything else open here?",
  "should I replace the valve?",
  "What should I do about work order 1042?",
]) {
  ok(`${JSON.stringify(text)} stays on the technician path`,
    !!routesTo("technician", text));
}
ok("an attachment always stays on the technician path",
  !!routesTo("technician", "What pricing is published?", [{ id: "ME1" }]));
ok("a vague question stays on the technician path",
  !!routesTo("technician", "Can you help?"));
ok("a vague lease update creates no conversational write path",
  !!routesTo("technician", "lease update"));
ok("postboard feedback stays on the technician rail because no postboard owner exists",
  !!routesTo("technician", "postboard feedback"));
ok("maintenance feedback remains on the canonical technician rail",
  !!routesTo("technician", "the elevator repair is holding this up"));
ok("a statement about pricing is not mistaken for a question",
  !!routesTo("technician", "Pricing changed yesterday"));
ok("an application-send request is not mistaken for an application-status read",
  !!routesTo("leasing", "Can you send Maria an application?"));
const leasingAction = routesTo("leasing", "Please can you send Maria an application?");
ok("a polite application-send request reaches the leasing action adapter",
  leasingAction && leasingAction.leasing.intent === "send_application");
ok("a proposed fee waiver stays on the action path",
  !!routesTo("technician", "Can we waive Maria's fee?"));

console.log("\n-- QUESTION AND RECEIPT CONTRACTS ----------------------------");
ok("question punctuation is recognized", technicianIntent.looksLikeQuestion("Published pricing?"));
ok("a question word is recognized without punctuation",
  technicianIntent.looksLikeQuestion("What pricing is published"));
ok("a statement is not question-shaped", !technicianIntent.looksLikeQuestion("Published pricing"));

const governed = operatingReceipt({
  outcome: "governed_read",
  result: { answer: "The published rent is $850.", readOutcome: "answered",
            isClarificationQuestion: false },
});
ok("a governed answer is a non-writing operating receipt",
  governed.kind === "operating_receipt" && governed.committed === false);
ok("the service answer is preserved exactly", governed.text === "The published rent is $850.");
ok("the Ask Spine outcome remains separately visible", governed.serviceOutcome === "answered");
ok("a blank governed answer is refused", operatingReceipt({
  outcome: "governed_read",
  result: { answer: "", readOutcome: "answered", isClarificationQuestion: false },
}).text === null);

const code = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: EXPECTED });
process.exit(code);
