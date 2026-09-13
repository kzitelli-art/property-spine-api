"use strict";
const assert = require("node:assert/strict");
const {
  loadExecutionDecision,
} = require("../../src/applications/application_review");
(async () => {
  const app = { id: "app", property_id: "property" },
    packet = { id: "current-packet" };
  let row = null;
  const calls = [];
  const db = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      return { rows: row ? [row] : [] };
    },
  };
  assert.equal(await loadExecutionDecision(db, null, app), null);
  assert.equal(calls.length, 0);
  assert.equal(
    await loadExecutionDecision(db, packet, app),
    null,
    "separate approval/signature without Execute audit stays legacy",
  );
  row = {
    id: "event",
    lease_packet_id: packet.id,
    created_at: "time",
    event_json: {
      actor_user_id: "signer",
      application_decision: "approve",
      decisions: [
        { decision: "application_already_approved", actor_user_id: null },
        { decision: "company_signed", actor_user_id: "signer" },
      ],
    },
  };
  const read = await loadExecutionDecision(db, packet, app);
  assert.equal(read.event_id, "event");
  assert.equal(read.actor_user_id, "signer");
  assert.equal(
    read.decisions[0].actor_user_id,
    null,
    "existing approval is not attributed to current signer",
  );
  assert.deepEqual(calls[1].args, ["current-packet", "app", "property"]);
  assert.match(calls[1].sql, /superseded_at is null/);
  assert.match(calls[1].sql, /event_type='executed_by_decision'/);
  assert.doesNotMatch(calls[1].sql, /for update/i);
  await assert.rejects(
    () =>
      loadExecutionDecision(
        {
          query: async () => {
            throw Error("read outage");
          },
        },
        packet,
        app,
      ),
    /read outage/,
  );
  console.log("execution decision read: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
