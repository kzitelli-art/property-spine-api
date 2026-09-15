"use strict";
const assert = require("node:assert/strict");
const boundary = require("./proof_boundary");

// The caller already owns the nonce-fenced pool and signed synthetic packet.
// No substitute approval writer: compose the same active services as server.js.
module.exports = async function proveExecuteRollback({ pool, J, operator, key, check }) {
  await boundary.assertDatabase();
  const engine = require("../../src/shared/obligation_engine");
  const conversion = require("../../src/leasing/leasing_conversion")({
    pool, spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation,
    closureAuthority: require("../../src/leasing/conversion_obligation_closure").createConversionClosureAuthority(),
  })._service;
  const submission = require("../../src/applications/application_submission")({
    pool, spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation, conversionService: conversion,
  })._service;
  const applications = require("../../src/applications/applications")({
    pool, ...engine, submissionService: submission, conversionService: conversion,
  })._service;

  async function snapshot(q) {
    const rows = async (sql, args) => (await q.query(sql, args)).rows;
    const obligations = `select id from obligations where property_id=$1 and person_id=$2`;
    const scope = [operator.property_id, J.person];
    return {
      application: await rows("select * from lease_applications where id=$1", [J.app]),
      obligations: await rows("select * from obligations where property_id=$1 and person_id=$2 order by id", scope),
      rail: await rows(`select * from leasing_conversion_obligations where obligation_id in (${obligations}) order by obligation_id`, scope),
      events: await rows("select * from events where property_id=$1 and person_id=$2 order by id", scope),
      packet: await rows("select * from lease_packets where id=$1", [J.packet]),
      fields: await rows("select * from lease_packet_fields where lease_packet_id=$1 order by id", [J.packet]),
      audits: await rows("select * from lease_packet_audit_events where lease_packet_id=$1 order by id", [J.packet]),
      leases: await rows("select * from leases where application_id=$1 order by id", [J.app]),
      executed: await rows("select * from executed_lease_records where application_id=$1 order by id", [J.app]),
    };
  }

  const before = await snapshot(pool);
  assert.equal(before.application.length, 1);
  const initial = before.application[0];
  assert.equal(initial.status, "submitted");
  assert.ok(initial.approval_obligation_id, "fixture must carry a real submission approval gate");
  assert.equal(initial.terms_review_obligation_id, null);
  let witnessed = false;
  const sentinel = new Error("injected execution-service boundary failure after real approval and signature");
  const packetService = require("../../src/applications/lease_packets")({
    pool, satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation,
    executionServices: () => ({
      spawnObligationFromEvent: engine.spawnObligationFromEvent,
      executedLease: {
        verifyExecutedLease: async (client, args) => {
          assert.equal(args.application_id, J.app);
          const inside = await snapshot(client);
          const app = inside.application[0];
          assert.ok(app.approved_at && app.terms_review_obligation_id);
          const approval = inside.obligations.find(o => o.id === initial.approval_obligation_id);
          const terms = inside.obligations.find(o => o.id === app.terms_review_obligation_id);
          assert.equal(approval.status, "complete", "real submission gate completed");
          assert.equal(terms.status, "complete", "real terms review completed");
          assert.deepEqual(terms.required_inputs, []);
          assert.ok(inside.events.some(e => e.type === "input_satisfied:terms_acknowledged"
            && e.note.includes(terms.id) && !before.events.some(old => old.id === e.id)),
            "canonical durable terms acknowledgment event exists");
          assert.equal(inside.events.filter(e => e.type === "application_approved").length,
            before.events.filter(e => e.type === "application_approved").length + 1);
          assert.equal(inside.packet[0].status, "executed");
          assert.ok(inside.packet[0].company_executed_at);
          assert.ok(inside.fields.some(f => f.field_key === "sign_company" && f.completed && f.signed_by_user_id === operator.id));
          assert.equal(inside.audits.filter(e => e.event_type === "company_executed").length,
            before.audits.filter(e => e.event_type === "company_executed").length + 1);
          assert.deepEqual(inside.leases, before.leases);
          witnessed = true;
          throw sentinel;
        },
      },
    }),
  })._service;
  const client = await pool.connect();
  let thrown;
  try {
    await client.query("begin");
    await packetService.executeLeasePacketDecision(client, {
      packetId: J.packet, operator, req: { headers: {} }, decision: "approve", idempotencyKey: key,
    }, { applications });
  } catch (error) { thrown = error; }
  finally {
    try { await client.query("rollback"); } finally { client.release(); }
  }
  assert.equal(thrown, sentinel, "failure must be the injected boundary, not an earlier service refusal");
  assert.ok(witnessed);
  check(true, "real approval, submission gate, terms proof/completion and company signature existed inside the failed transaction");
  const after = await snapshot(pool);
  for (const section of Object.keys(before)) {
    assert.deepEqual(after[section], before[section], `${section} must return exactly to its pre-Execute state`);
    check(true, `ROLLBACK restored ${section} without deleting earlier resident evidence`);
  }
};
