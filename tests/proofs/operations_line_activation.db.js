#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const { Pool } = require("pg");
const receipt = require("../_run_receipt");
const {
  activateOperationsLine,
  transferOperationsLine,
  resolveInboundLine,
  resolveOutboundLine,
} = require("../../src/comms/communication_lines");

const HARNESS = __filename;
const EXPECTED = 40;
const URL = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL, max: 4 });
const tag = `OPS_LINE_${process.pid}_${Date.now()}`;

let passed = 0;
let failed = 0;
let ran = 0;

function ok(label, condition, detail = "") {
  ran += 1;
  if (condition) {
    passed += 1;
    console.log("  ok    " + label);
    return;
  }
  failed += 1;
  console.log("  FAIL  " + label + (detail ? "  ->  " + detail : ""));
}

async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

async function unusedHarnessNumber() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = String(crypto.randomInt(1000, 10000));
    const e164 = `+1555010${suffix}`;
    const found = await pool.query(
      `select 1 from communication_lines where e164 = $1 and status = 'active'`,
      [e164]
    );
    if (found.rowCount === 0) return e164;
  }
  throw new Error("Could not mint an unused reserved harness number.");
}

(async () => {
  receipt.begin(HARNESS, { url: URL, expected: EXPECTED });

  let organizationId = null;
  let personId = null;
  let actorId = null;
  let memberId = null;
  let propertyId = null;
  let lineId = null;
  let targetOrganizationId = null;
  let targetPropertyId = null;
  let targetLineId = null;
  let historyEventId = null;

  try {
    organizationId = (await pool.query(
      `insert into organizations (name, slug)
       values ($1, $2) returning id`,
      [`${tag} Org`, tag.toLowerCase().replace(/_/g, "-")]
    )).rows[0].id;
    personId = (await pool.query(
      `insert into persons (name) values ($1) returning id`, [`${tag} Human`]
    )).rows[0].id;
    actorId = (await pool.query(
      `insert into users
         (name, email, platform_role, organization_id, is_active, status, person_id)
       values ($1, $2, 'super_admin', null, true, 'active', $3) returning id`,
      [`${tag} Super Admin`, `${tag.toLowerCase()}-admin@example.test`, personId]
    )).rows[0].id;
    memberId = (await pool.query(
      `insert into users
         (name, email, platform_role, organization_id, is_active, status, person_id)
       values ($1, $2, 'member', $3, true, 'active', $4) returning id`,
      [`${tag} Member`, `${tag.toLowerCase()}-member@example.test`, organizationId, personId]
    )).rows[0].id;

    const e164 = await unusedHarnessNumber();
    const noProperty = await refusal(activateOperationsLine(pool, {
      organizationId, phoneNumber: e164, actorUserId: actorId,
    }));
    ok("an organization without a property is refused", noProperty && noProperty.httpStatus === 409);
    ok("the no-property refusal is explicit",
      noProperty && noProperty.refusalReason === "organization_has_no_property");

    propertyId = (await pool.query(
      `insert into properties (name, canonical_key, organization_id)
       values ($1, $2, $3) returning id`,
      [`${tag} Property`, `${tag}-PROPERTY`, organizationId]
    )).rows[0].id;

    const wrongActor = await refusal(activateOperationsLine(pool, {
      organizationId, phoneNumber: e164, actorUserId: memberId,
    }));
    ok("a non-super-admin actor is refused", wrongActor && wrongActor.httpStatus === 403);
    ok("the actor refusal is explicit",
      wrongActor && wrongActor.refusalReason === "super_admin_required");

    const activated = await activateOperationsLine(pool, {
      organizationId, phoneNumber: e164, actorUserId: actorId,
    });
    lineId = activated.line.id;
    ok("first activation reports a new line", activated.already === false);
    ok("the number is stored canonically", activated.line.e164 === e164);
    ok("the line type is operations", activated.line.line_type === "operations");
    ok("the line belongs to the organization", activated.line.organization_id === organizationId);
    ok("the line does not imply a property", activated.line.property_id == null);
    ok("the authority ceiling is operational", activated.line.authority_ceiling === "operational");
    ok("the permitted audience is staff", activated.line.permitted_audience === "staff");
    ok("inbound staff texting is enabled", activated.line.inbound_enabled === true);
    ok("outbound replies are enabled", activated.line.outbound_enabled === true);
    ok("outbound is reply-only", activated.line.outbound_policy === "reply_only");
    ok("the activated line is active", activated.line.status === "active");

    const stored = (await pool.query(
      `select notes from communication_lines where id = $1`, [lineId]
    )).rows[0];
    ok("the stored receipt names the actor and authority",
      stored && stored.notes.includes(actorId) && stored.notes.includes("platform_role:super_admin"));

    const inbound = await resolveInboundLine(pool, e164);
    ok("the inbound resolver sees exactly one line", inbound.outcome === "one");
    ok("the inbound resolver returns the activated line", inbound.line && inbound.line.id === lineId);

    const proactive = await resolveOutboundLine(pool, { organizationId });
    ok("an unbound outbound send is refused",
      proactive.refusal === "reply_only_requires_inbound");
    ok("the refusal states the reply-only policy", proactive.policy === "reply_only");

    const reply = await resolveOutboundLine(pool, {
      organizationId, replyToCommEventId: crypto.randomUUID(),
    });
    ok("a reply-bound lookup returns the activated line", reply.line && reply.line.id === lineId);
    ok("a reply-bound lookup has no refusal", reply.refusal == null);

    const repeated = await activateOperationsLine(pool, {
      organizationId, phoneNumber: e164, actorUserId: actorId,
    });
    ok("repeating the same activation is idempotent", repeated.already === true);
    ok("idempotence returns the original row", repeated.line.id === lineId);

    const replacement = await refusal(activateOperationsLine(pool, {
      organizationId, phoneNumber: await unusedHarnessNumber(), actorUserId: actorId,
    }));
    ok("the activation command cannot replace a line", replacement && replacement.httpStatus === 409);
    ok("the replacement refusal is explicit",
      replacement && replacement.refusalReason === "operations_line_already_active");

    targetOrganizationId = (await pool.query(
      `insert into organizations (name, slug)
       values ($1, $2) returning id`,
      [`${tag} Target Org`, `${tag.toLowerCase().replace(/_/g, "-")}-target`]
    )).rows[0].id;
    targetPropertyId = (await pool.query(
      `insert into properties (name, canonical_key, organization_id)
       values ($1, $2, $3) returning id`,
      [`${tag} Target Property`, `${tag}-TARGET-PROPERTY`, targetOrganizationId]
    )).rows[0].id;
    historyEventId = (await pool.query(
      `insert into comm_events
         (channel,direction,body,communication_line_id)
       values ('sms','inbound',$1,$2) returning id`,
      [`${tag} historical staff text`, lineId]
    )).rows[0].id;

    const transferred = await transferOperationsLine(pool, {
      sourceLineId: lineId,
      targetOrganizationId,
      actorUserId: actorId,
    });
    targetLineId = transferred.line.id;
    ok("the transfer reports a new target line", transferred.already === false);
    ok("the receipt names the retired source row", transferred.retiredLineId === lineId);
    ok("the target line preserves the exact phone number", transferred.line.e164 === e164);
    ok("the target line belongs to the target organization",
      transferred.line.organization_id === targetOrganizationId);
    const retired = (await pool.query(
      `select status,superseded_at from communication_lines where id=$1`, [lineId]
    )).rows[0];
    ok("the source line is retired", retired && retired.status === "retired");
    ok("the source retirement carries its clock", retired && !!retired.superseded_at);
    const history = (await pool.query(
      `select communication_line_id from comm_events where id=$1`, [historyEventId]
    )).rows[0];
    ok("historical staff SMS stays attached to the retired source row",
      history && history.communication_line_id === lineId);
    const transferredInbound = await resolveInboundLine(pool, e164);
    ok("the transferred number still resolves exactly once", transferredInbound.outcome === "one");
    ok("new inbound resolves only to the target row",
      transferredInbound.line && transferredInbound.line.id === targetLineId);
    const sourceOutbound = await resolveOutboundLine(pool, {
      organizationId,
      replyToCommEventId: historyEventId,
    });
    ok("the source organization no longer resolves the staff line",
      sourceOutbound.refusal === "no_property_line");
    const targetOutbound = await resolveOutboundLine(pool, {
      organizationId: targetOrganizationId,
      replyToCommEventId: historyEventId,
    });
    ok("reply-bound target routing returns the transferred line",
      targetOutbound.line && targetOutbound.line.id === targetLineId);
    const repeatedTransfer = await transferOperationsLine(pool, {
      sourceLineId: lineId,
      targetOrganizationId,
      actorUserId: actorId,
    });
    ok("repeating the completed transfer is idempotent", repeatedTransfer.already === true);
    ok("the idempotent receipt returns the same target row",
      repeatedTransfer.line.id === targetLineId);
    const activeCount = (await pool.query(
      `select count(*)::int n from communication_lines where e164=$1 and status='active'`,
      [e164]
    )).rows[0].n;
    ok("the phone number has exactly one active owner after retry", activeCount === 1);
  } finally {
    if (historyEventId) await pool.query(`delete from comm_events where id = $1`, [historyEventId]).catch(() => {});
    if (targetLineId) await pool.query(`delete from communication_lines where id = $1`, [targetLineId]).catch(() => {});
    if (lineId) await pool.query(`delete from communication_lines where id = $1`, [lineId]).catch(() => {});
    if (targetPropertyId) await pool.query(`delete from properties where id = $1`, [targetPropertyId]).catch(() => {});
    if (targetOrganizationId) await pool.query(`delete from organizations where id = $1`, [targetOrganizationId]).catch(() => {});
    if (propertyId) await pool.query(`delete from properties where id = $1`, [propertyId]).catch(() => {});
    if (memberId) await pool.query(`delete from users where id = $1`, [memberId]).catch(() => {});
    if (actorId) await pool.query(`delete from users where id = $1`, [actorId]).catch(() => {});
    if (personId) await pool.query(`delete from persons where id = $1`, [personId]).catch(() => {});
    if (organizationId) await pool.query(`delete from organizations where id = $1`, [organizationId]).catch(() => {});
    await pool.end();
  }

  process.exitCode = receipt.complete({
    harness: HARNESS,
    passed,
    failed: failed + Math.max(0, EXPECTED - ran),
    expectedAtLeast: EXPECTED,
  });
})().catch(async (error) => {
  await pool.end().catch(() => {});
  process.exitCode = receipt.died(HARNESS, error, ran);
});
