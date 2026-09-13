"use strict";

// The retained approval door may be used after a two-step resident signature.
// Generation and Execute must also serialize on their application first.
module.exports = async function proveApprovalCoexistence({ pool, api, J, F, propertyId, check }) {
  const assert = require("node:assert/strict");
  const engine = require("../../../src/shared/obligation_engine");
  const packets = require("../../../src/applications/lease_packets")({ pool, ...engine })._service;
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const approved = await api("POST", `/operator/leasing/applications/${J.app}/approve`, { token: F.kzTok, body: {} });
  assert.equal(approved.status, 200);
  const gateId = approved.body.terms_review_obligation_id;
  assert(gateId);
  const gateBefore = await one("select status from obligations where id=$1", [gateId]);
  check(gateBefore.status === "open", "retained approval creates the expected open terms-review gate");

  const generation = await pool.connect();
  let pending, issueRetry;
  try {
    await generation.query("begin");
    await generation.query("set local statement_timeout='5s'");
    await generation.query("select id from lease_applications where id=$1 for update", [J.app]);
    const pid = (await generation.query("select pg_backend_pid() as pid")).rows[0].pid;
    pending = api("POST", `/operator/leasing/lease-packets/${J.packet}/execute`, {
      token: F.kzTok, body: { application_decision: "approve", idempotency_key: `coexistence-${J.packet}` },
    });
    let waiting;
    for (let i = 0; i < 160; i++) {
      waiting = await one("select query from pg_stat_activity where datname=current_database() and $1=any(pg_blocking_pids(pid)) and wait_event_type='Lock'", [pid]);
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(waiting, "Execute must be observed waiting on this owned application transaction");
    assert.match(waiting.query, /lease_applications/);
    check(true, "Execute waits on the application before taking the packet lock");
    issueRetry = api("POST", `/operator/leasing/lease-packets/${J.packet}/send`, {
      token: F.mike.tok, body: { idempotency_key: `late-issue-${J.packet}` },
    });
    let waiters;
    for (let i = 0; i < 160; i++) {
      waiters = await one("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%lease_applications%for update%' and array_length(pg_blocking_pids(pid),1)>0");
      if (waiters.n >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(waiters.n >= 2, "both Execute and a delayed issue retry must wait on application first");
    check(true, "a delayed signing-link issue also waits on the application before the packet");
    let generated, refused;
    try {
      generated = await packets.generateLeasePacket(generation, {
        applicationId: J.app, actorUserId: F.mike.id, expectedPropertyId: propertyId,
      });
    } catch (error) { refused = error; }
    assert(!refused || (refused.httpStatus === 409 && !["40P01", "57014"].includes(refused.code)),
      `generation must finish or refuse truthfully, never deadlock or time out: ${refused?.message}`);
    check(!!generated || !!refused, "canonical generation completes its read while Execute waits; no inverted-lock deadlock");
  } finally {
    await generation.query("rollback");
    generation.release();
  }
  const executed = await pending;
  const lateIssue = await issueRetry;
  check(lateIssue.status === 409 && lateIssue.body.error === "packet_not_issuable",
    "the delayed issue retry refuses the signed packet without deadlock, timeout or a new link");
  assert.equal(executed.status, 201, JSON.stringify(executed.body));
  check(executed.body.decisions[0].decision === "application_already_approved"
      && executed.body.decisions[0].actor_user_id === null,
    "Execute preserves the separate earlier approval instead of claiming a new one");
  const gateAfter = await one("select status,required_inputs from obligations where id=$1", [gateId]);
  check(gateAfter.status === "complete" && gateAfter.required_inputs.length === 0,
    "resident acknowledgment closes the gate even when approval used the retained door");
  const open = await one("select count(*)::int n from obligations where related_id=$1 and related_type='lease_application' and type in ('terms_review','terms_review_followup','lease_signature_followup') and status in ('open','in_progress')", [J.app]);
  check(open.n === 0, "completed resident work leaves no open terms/signature work for this application");
  const state = await one("select count(*)::int n,min(lease_status) status from leases where application_id=$1", [J.app]);
  check(state.n === 1 && state.status === "pending", "coexisting commands produce exactly one pending lease");
};
