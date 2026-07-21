// tools/proofs/proof_lease_packet_operator_service.js
// Real-Postgres rollback proof for the canonical packet service.
//
// Required:
//   DATABASE_URL
// Optional:
//   PROOF_APPLICATION_ID (defaults to QA Lifecycle Tester standing id)
//
// Run from repository root:
//   node tools/proofs/proof_lease_packet_operator_service.js
//
// Every mutation runs inside one transaction and is rolled back.

const crypto = require("crypto");
const { Pool } = require("pg");
const leasePacketsModule = require("../../leasepackets");
const applicationsModule = require("../../applications");
const { buildReviewDetail } = require("../../application_review");

const APPLICATION_ID =
  process.env.PROOF_APPLICATION_ID ||
  "9c45f91f-ec23-4052-9e68-9df53a265c94";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const engineStub = async () => {
  throw new Error("proof: obligation engine must not be called by packet generate/issue");
};
const packetService = leasePacketsModule({
  pool,
  satisfyObligation: engineStub,
  completeObligation: engineStub,
})._service;

const applicationsService = applicationsModule({
  pool,
  spawnObligationFromEvent: engineStub,
  satisfyObligation: engineStub,
  completeObligation: engineStub,
})._service;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log("  ok  " + name);
}
function assert(name, condition, detail) {
  if (!condition) {
    throw new Error(name + (detail ? " — " + detail : ""));
  }
  ok(name);
}
async function expectError(name, fn, status, code) {
  try {
    await fn();
  } catch (e) {
    assert(name + " status", e.httpStatus === status, `got ${e.httpStatus}`);
    assert(name + " code", e.code === code, `got ${e.code}`);
    return;
  }
  throw new Error(name + " — expected refusal");
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const column = (await client.query(
      `select 1
         from information_schema.columns
        where table_schema='public'
          and table_name='lease_packets'
          and column_name='proposed_terms_confirmation_id'`
    )).rows[0];
    assert("schema column exists", !!column);

    const app = (await client.query(
      `select * from lease_applications where id=$1 for update`,
      [APPLICATION_ID]
    )).rows[0];
    assert("proof application exists", !!app);
    assert("proof application has current confirmation", !!app.proposed_terms_confirmation_id);

    const wrongProperty = crypto.randomUUID();
    await expectError(
      "cross-property generate refused",
      () => packetService.generateLeasePacket(client, {
        applicationId: app.id,
        actorUserId: crypto.randomUUID(),
        expectedPropertyId: wrongProperty,
      }),
      403,
      "not_permitted"
    );

    const confirmationId = app.proposed_terms_confirmation_id;
    await client.query(
      `update lease_applications
          set proposed_terms_confirmation_id=null
        where id=$1`,
      [app.id]
    );
    await expectError(
      "missing confirmation refused",
      () => packetService.generateLeasePacket(client, {
        applicationId: app.id,
        actorUserId: crypto.randomUUID(),
        expectedPropertyId: app.property_id,
      }),
      409,
      "no_current_proposed_terms_confirmation"
    );
    await client.query(
      `update lease_applications
          set proposed_terms_confirmation_id=$2
        where id=$1`,
      [app.id, confirmationId]
    );

    const actor = crypto.randomUUID();
    const first = await packetService.generateLeasePacket(client, {
      applicationId: app.id,
      actorUserId: actor,
      expectedPropertyId: app.property_id,
      auditContext: { ip_address: "127.0.0.1", user_agent: "packet-proof" },
    });
    assert("generate returns draft packet", first.packet && first.packet.status === "draft");
    assert(
      "generate binds current confirmation",
      String(first.packet.proposed_terms_confirmation_id) === String(confirmationId)
    );

    const second = await packetService.generateLeasePacket(client, {
      applicationId: app.id,
      actorUserId: actor,
      expectedPropertyId: app.property_id,
      auditContext: { ip_address: "127.0.0.1", user_agent: "packet-proof" },
    });
    assert("repeat generate converges on same draft", second.packet.id === first.packet.id);
    assert(
      "repeat generate preserves lineage",
      String(second.packet.proposed_terms_confirmation_id) === String(confirmationId)
    );

    await expectError(
      "cross-property issue refused",
      () => packetService.issueLeasePacketLink(client, {
        packetId: first.packet.id,
        expectedPropertyId: wrongProperty,
        actorUserId: actor,
      }),
      403,
      "not_permitted"
    );

    const issued = await packetService.issueLeasePacketLink(client, {
      packetId: first.packet.id,
      expiresDays: 14,
      idempotencyKey: crypto.randomUUID(),
      actorUserId: actor,
      expectedPropertyId: app.property_id,
      auditContext: { ip_address: "127.0.0.1", user_agent: "packet-proof" },
    });
    assert("first issue returns URL", issued.status === "sent" && /^https?:\/\//.test(issued.tenant_url));
    assert("first issue is not retry", issued.already_issued === false);

    const hash1 = (await client.query(
      `select tenant_token_hash
         from lease_packets
        where id=$1`,
      [first.packet.id]
    )).rows[0].tenant_token_hash;

    const retry = await packetService.issueLeasePacketLink(client, {
      packetId: first.packet.id,
      expiresDays: 14,
      idempotencyKey: crypto.randomUUID(),
      actorUserId: actor,
      expectedPropertyId: app.property_id,
      auditContext: { ip_address: "127.0.0.1", user_agent: "packet-proof" },
    });
    assert("retry reports already issued", retry.already_issued === true);
    assert("retry returns no raw URL", retry.tenant_url === null);

    const hash2 = (await client.query(
      `select tenant_token_hash
         from lease_packets
        where id=$1`,
      [first.packet.id]
    )).rows[0].tenant_token_hash;
    assert("retry does not rotate token", hash1 === hash2);

    const detail = await buildReviewDetail(
      client,
      app.id,
      app.property_id,
      {
        loadGate: (q, application, options) =>
          applicationsService.outstanding(q, application, options),
        resolveNext: applicationsService.applicationNext,
      }
    );
    assert(
      "review projection waits for resident",
      detail.next_action &&
      detail.next_action.code === "await_resident_acknowledgment",
      detail.next_action && JSON.stringify(detail.next_action)
    );
    assert(
      "issued packet lineage now matches",
      detail.lineage_matches_current_confirmation === true
    );
    assert(
      "no lineage-unproven warning",
      !detail.next_action.warning_code ||
      detail.next_action.warning_code !== "issued_packet_lineage_unproven"
    );

    await client.query("rollback");
    console.log(`\nPASS — ${passed} service/database checks (transaction rolled back).`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error("\nFAIL:", e.stack || e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
