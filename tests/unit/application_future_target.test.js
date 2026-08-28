#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  evaluateOfferability,
  REFUSAL,
} = require("../../src/applications/application_target_authority");

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) {
    passed++;
    console.log("  PASS  " + message);
    return;
  }
  failed++;
  console.error("  FAIL  " + message);
}

const future = {
  marketing_state: "turnover_required",
  available_from: "2026-09-03",
  availability_confidence: "expected",
};

console.log("\nFuture application target policy");
ok(evaluateOfferability({ marketing_state: "marketable_now" }).offerable === true,
  "a home available now remains offerable without a target date");
ok(evaluateOfferability(future).refusal_code === REFUSAL.MOVE_IN_DATE_REQUIRED,
  "a future home requires an intended move-in date");
ok(evaluateOfferability(future, { intended_move_in: "2026-09-02" }).refusal_code
    === REFUSAL.MOVE_IN_BEFORE_READY,
  "a move-in before the governed ready date is refused");
ok(evaluateOfferability(future, { intended_move_in: "2026-09-03" }).offerable === true,
  "the governed ready date is an admissible target");
ok(evaluateOfferability(future, { intended_move_in: "2026-09-05" }).offerable === true,
  "a later target remains admissible");
ok(evaluateOfferability({
  ...future,
  availability_confidence: "incomplete",
}, { intended_move_in: "2026-09-05" }).refusal_code === REFUSAL.READY_DATE_NOT_GOVERNED,
  "a lease end without a governed turn-ready date cannot support an application");

console.log("\nDurable lineage across both boundaries");
const submission = fs.readFileSync(path.join(
  __dirname, "..", "..", "src", "applications", "application_submission.js"), "utf8");
const migration = fs.readFileSync(path.join(
  __dirname, "..", "..", "migrations", "190_application_move_in_lineage.sql"), "utf8");
ok(/resolveSubmissionTarget\(client,\s*\{[\s\S]*?intended_move_in:\s*inv\.intended_move_in\s*\}/
    .test(submission),
  "tenant submission rechecks the persisted invitation date");
ok(/application_invitations[\s\S]*?intended_move_in date/.test(migration)
    && /lease_applications[\s\S]*?intended_move_in date/.test(migration),
  "the target date is durable on both the invitation and application");

console.log(`\n  application future target: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
