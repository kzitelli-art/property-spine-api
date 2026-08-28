"use strict";

const { stageApplicationSend, dispatchApplicationSend } = require(
  "../../src/applications/application_send_command"
);

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) {
    passed++;
    console.log("   PASS  " + message);
  } else {
    failed++;
    console.log("   FAIL  " + message);
  }
}

(async () => {
  const calls = {};
  const client = { query: async () => ({ rows: [] }) };
  const deps = {
    conversionService: {
      recordApplicationIntent: async (_client, input) => {
        calls.intent = input;
        return {
          recorded: true,
          intent: { id: "intent-1" },
          obligation: { id: "prepare-1", parent_obligation_id: "parent-1" },
        };
      },
    },
    applicationInvitations: {
      prepareApplicationLinkForObligation: async (_client, input) => {
        calls.prepare = input;
        return {
          invitation_id: "invitation-1",
          token: "raw-token",
          send_obligation_id: "send-1",
          parent_obligation_id: "parent-1",
        };
      },
      dispatchPreparedLinkProvider: async (input) => {
        calls.dispatch = input;
        return { dispatched: true, provider_message_id: "SM-test" };
      },
    },
  };

  console.log("\n== exact application target ==");
  const staged = await stageApplicationSend(client, deps, {
    conversionId: "conversion-1",
    actorUserId: "user-1",
    unitId: "unit-302",
    spaceId: "bed-b",
    idempotencyKey: "send-1",
  });
  ok(calls.prepare.unit_id === "unit-302", "the chosen unit reaches canonical preparation");
  ok(calls.prepare.space_id === "bed-b", "the chosen bed reaches canonical preparation");
  ok(staged.space_id === "bed-b", "the staged receipt preserves the chosen bed");
  ok(staged.prepare_obligation_id === "prepare-1", "the prepare commitment remains server-authored");

  console.log("\n== provider dispatch keeps the target receipt ==");
  const sent = await dispatchApplicationSend(deps, staged, {
    actorUserId: "user-1",
    messagePrefix: "Please apply:",
  });
  ok(sent.sent === true && sent.dispatched === true, "provider acceptance is the only sent state");
  ok(sent.unit_id === "unit-302" && sent.space_id === "bed-b", "the dispatch receipt names the exact target");
  ok(calls.dispatch.invitation_id === "invitation-1", "dispatch uses the staged invitation");
  ok(calls.dispatch.raw_token === "raw-token", "dispatch uses the once-returned raw token");

  console.log("\n== invalid space identity fails before domain work ==");
  let invalid = null;
  try {
    await stageApplicationSend(client, deps, {
      conversionId: "conversion-2",
      actorUserId: "user-1",
      unitId: "unit-302",
      spaceId: "   ",
      idempotencyKey: "send-2",
    });
  } catch (error) {
    invalid = error;
  }
  ok(invalid && invalid.code === "INVALID_COMMAND", "a blank supplied space id is refused");

  console.log(`\n==== ${passed} passed, ${failed} failed ====\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
