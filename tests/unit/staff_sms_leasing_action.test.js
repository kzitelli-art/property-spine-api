#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const receipt = require("../_run_receipt");
const intentReader = require("../../src/leasing/staff_sms_intent");
const { routeStaffSmsTurn } = require("../../src/conversation/staff_sms_router");
const { makeStaffLeasingAction } = require("../../src/leasing/staff_sms_action");
const { operatingReceipt } = require("../../src/conversation/receipt");

const EXPECTED = 38;
let passed = 0;
let failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed += 1; console.log(`  ok    ${label}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? `  ->  ${detail}` : ""}`); }
};

receipt.begin(__filename, { expected: EXPECTED });
const read = intentReader.readStaffLeasingIntent;
const privateAction = makeStaffLeasingAction()._private;

console.log("\n-- STAFF LANGUAGE IS NARROW AND DETERMINISTIC ----------------");
for (const [text, standing] of [
  ["Jane's tour is done and she is ready to apply", "ready_to_apply"],
  ["Jane's tour was a hot lead", "hot_lead"],
  ["Jane's tour is possible", "possible"],
  ["Jane's tour is done and she is not moving forward", "not_moving_forward"],
]) {
  const parsed = read(text);
  ok(`${standing} is recognized only from explicit staff language`,
    parsed.intent === "capture_tour" && parsed.standing === standing);
}
ok("'went well' asks for the canonical four-word standing instead of guessing",
  read("Jane's tour went really well").intent === "clarify_tour_standing");
ok("a direct standing reply can complete the unfinished assigned tour",
  read("Ready to Apply").intent === "capture_tour");
ok("a field phrase containing a standing word is not mistaken for leasing",
  read("Possible leak under the sink").intent === "unclear");
ok("a standing question never becomes a tour write",
  read("Is Jane ready to apply?").intent === "unclear");
ok("an explicit application command is a send action",
  read("Please send Jane an application").intent === "send_application");
ok("an exact application target reply stays on the leasing action",
  read("Application for Unit 302, Bed B").intent === "application_target");
ok("an application-status question is not a write intent",
  read("Where is Jane's application?").intent === "unclear");
ok("an application-status question with a unit is still not a write intent",
  read("Where is Jane's application for Unit 302?").intent === "unclear");
ok("the shared router sends a capture to Leasing",
  routeStaffSmsTurn({ text: "Jane's tour is done and she is ready to apply" }).destination === "leasing");
ok("the shared router sends an application command to Leasing",
  routeStaffSmsTurn({ text: "Send Jane an application" }).destination === "leasing");
ok("an attachment still wins and remains a technician turn",
  routeStaffSmsTurn({ text: "Send Jane an application", attachments: [{ id: "photo" }] }).destination === "technician");

console.log("\n-- PEOPLE AND TARGETS ARE CHOSEN ONLY WHEN EXACT -------------");
const candidates = [
  { prospect_name: "Jane Smith", unit_number: "302" },
  { prospect_name: "Maria Jones", unit_number: "204" },
];
ok("a full name selects one prospect",
  privateAction.chooseNamedCandidate("Send Jane Smith the application", candidates).candidate === candidates[0]);
ok("a unique first name selects one prospect",
  privateAction.chooseNamedCandidate("Send Maria the application", candidates).candidate === candidates[1]);
ok("a full name outranks shared partial-name tokens",
  privateAction.chooseNamedCandidate("Send Skyline Journey 222 the application", [
    { prospect_name: "Skyline Journey 111", unit_number: "302" },
    { prospect_name: "Skyline Journey 222", unit_number: "302" },
  ]).candidate.prospect_name === "Skyline Journey 222");
ok("no name among multiple open follow-ups is ambiguous",
  privateAction.chooseNamedCandidate("Send the application", candidates).candidate === null);
ok("one open follow-up can be selected without inventing a name",
  privateAction.chooseNamedCandidate("Send the application", [candidates[0]]).candidate === candidates[0]);
ok("no open follow-up stays an honest none",
  privateAction.chooseNamedCandidate("Send Jane the application", []).reason === "none");
ok("an ambiguous tour prompt teaches a complete deterministic reply",
  privateAction.candidatePrompt("tour", candidates, "hot_lead")
    .includes("Jane's tour: Hot Lead"));
ok("an ambiguous application prompt teaches a complete deterministic reply",
  privateAction.candidatePrompt("application", candidates)
    .includes("Send Jane the application"));

const targets = [
  { unit_id: "u302", unit_number: "302", space_id: "a", space_label: "Bed A", rentable_space_count: 2 },
  { unit_id: "u302", unit_number: "302", space_id: "b", space_label: "Bed B", rentable_space_count: 2 },
  { unit_id: "u204", unit_number: "204", space_id: "w", space_label: "(whole unit)", rentable_space_count: 1 },
  { unit_id: "u401", unit_number: "401", space_id: "b2", space_label: "Bed B", rentable_space_count: 2 },
];
ok("unit plus bed selects one exact by-bed target",
  privateAction.chooseTarget("Application for Unit 302 Bed B", targets).target.space_id === "b");
ok("naming a bed excludes a whole-unit position in that same unit",
  privateAction.chooseTarget("Application for Unit 302 Bed B", [
    { unit_id: "u302", unit_number: "302", space_id: "whole", space_label: "(whole unit)", rentable_space_count: 2 },
    targets[1],
  ]).target.space_id === "b");
ok("a multi-bed unit without the bed stays ambiguous",
  privateAction.chooseTarget("Application for Unit 302", targets).target === null);
ok("a bed label without a unit stays ambiguous across units",
  privateAction.chooseTarget("Application for Bed B", targets).target === null);
ok("a whole-unit target is exact from its unit number",
  privateAction.chooseTarget("Application for Unit 204", targets).target.space_id === "w");
ok("a sole target in the toured unit can be selected from recorded context",
  privateAction.chooseTarget("Send the application", targets, "u204").target.space_id === "w");
ok("two beds in the toured unit still require a choice",
  privateAction.chooseTarget("Send the application", targets, "u302").target === null);
ok("the by-bed label says both unit and bed",
  privateAction.targetLabel(targets[1]) === "Unit 302, Bed B");
ok("the whole-unit label stays simple",
  privateAction.targetLabel(targets[2]) === "Unit 204");
ok("the target prompt teaches the reply shape without choosing",
  privateAction.targetPrompt(targets.slice(0, 2), "Alex Rivera")
    .includes("Send Alex Rivera the application for Unit 302, Bed B"));
ok("Leasing access is read from the assignment modules",
  privateAction.leasingAllowed({ allowedModules: ["maintenance", "leasing"] }));
ok("a title alone never grants Leasing access",
  !privateAction.leasingAllowed({ allowedModules: [], roleTitle: "Leasing Agent" }));

console.log("\n-- RECEIPTS SPEAK ONLY FROM COMMITTED FACTS ------------------");
const clarification = operatingReceipt({
  outcome: "leasing_clarification",
  result: { answer: "Which prospect?", reasonCode: "ambiguous_open", isQuestion: true },
});
ok("a leasing clarification claims no write", !clarification.committed);
ok("a leasing clarification preserves the exact question", clarification.text === "Which prospect?");
ok("a blank leasing clarification is refused",
  operatingReceipt({ outcome: "leasing_clarification", result: { answer: "" } }).text === null);

const captured = operatingReceipt({
  outcome: "tour_outcome_recorded",
  result: { tourId: "tour-1", conversionId: "conv-1", prospectName: "Jane Smith",
            standingLabel: "Ready to Apply", nextPrompt: "Which bed?" },
});
ok("a canonical tour result produces a committed conversion receipt", captured.committed);
ok("the tour receipt names the recorded standing", captured.text.includes("Ready to Apply"));
ok("a tour receipt without a conversion is refused",
  operatingReceipt({ outcome: "tour_outcome_recorded",
    result: { tourId: "tour-1", prospectName: "Jane" } }).text === null);

const sent = operatingReceipt({
  outcome: "application_invitation_prepared",
  result: { invitationId: "invite-1", prospectName: "Jane Smith", targetLabel: "Unit 302, Bed B",
            dispatched: true, capture: { tourId: "tour-1", standingLabel: "Ready to Apply" } },
});
ok("a dispatched invitation receipt is committed", sent.committed);
ok("the application receipt names the exact target", sent.text.includes("Unit 302, Bed B"));
ok("the application receipt separately names provider dispatch", sent.serviceOutcome === "provider_dispatched");
const unsent = operatingReceipt({
  outcome: "application_invitation_prepared",
  result: { invitationId: "invite-2", prospectName: "Jane", targetLabel: "Unit 302, Bed B",
            dispatched: false, capture: null },
});
ok("a provider failure does not erase the prepared invitation", unsent.committed);
ok("a provider failure is visible and needs a human", unsent.requiresHuman === true);

console.log("\n-- BOTH SURFACES DEFER TO THE SAME DOMAIN SERVICES -----------");
const root = path.join(__dirname, "..", "..");
const operatorSource = fs.readFileSync(path.join(root, "src", "identity", "operator.js"), "utf8");
const actionSource = fs.readFileSync(path.join(root, "src", "leasing", "staff_sms_action.js"), "utf8");
const targetSource = fs.readFileSync(path.join(root, "src", "applications", "application_target_read.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
ok("the dashboard imports the one application-target reader",
  operatorSource.includes('require("../applications/application_target_read")'));
ok("the SMS adapter imports that same target reader",
  actionSource.includes('require("../applications/application_target_read")'));
ok("the exact target SQL lives in the target reader, not the dashboard route",
  targetSource.includes("count(s.id) over") && !operatorSource.includes("count(s.id) over"));
ok("the SMS adapter delegates tour capture to completeTour",
  actionSource.includes("tourService.completeTour"));
ok("the SMS adapter delegates application staging to applicationSendCommand",
  actionSource.includes("applicationSendCommand.stageApplicationSend"));
ok("the SMS adapter does not insert a tour or application invitation directly",
  !/insert\s+into\s+(leasing_tours|application_invitations)/i.test(actionSource));
ok("server composition injects the already-built conversion service by reference",
  serverSource.includes("getConversionService: () => __leasingConversion"));

const code = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: EXPECTED });
process.exit(code);
