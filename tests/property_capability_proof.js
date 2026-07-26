// ════════════════════════════════════════════════════════════════════
//  PROPERTY CHANNEL CAPABILITIES (094) — proof
//
//  FALSIFIABLE BY CONSTRUCTION. Everything runs against REAL Postgres,
//  and every write happens inside a transaction that ALWAYS ROLLS BACK.
//  Nothing is persisted. No property is activated by running this file.
//
//  Proves:
//    1. The table exists with the closed vocabulary the ruling requires,
//       and the DB itself rejects anything outside it. A CHECK that does
//       not reject is not a CHECK — each one is proven by attempting a
//       violating insert and requiring it to FAIL.
//    2. FAIL-CLOSED IS REAL: with the table empty, propertyHasCapability
//       returns false for every property and every capability. If it ever
//       returns true without an active row, this fails.
//    3. Grants do not leak sideways: an active send_customer_care_human
//       grant does NOT make send_ai_autodispatch or send_marketing true.
//       This is the ruling's core separation, tested rather than asserted.
//    4. suspended and revoked rows read as false — history is kept, but
//       only 'active' is authority.
//    5. At most ONE active grant per (property, channel, capability).
//    6. Nothing is activated in production by this migration: the live
//       table is empty.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/property_capability_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const boundaryFactory = require("../src/comms/communications_boundary");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// a write that MUST be rejected by the database
async function mustReject(client, label, sql, params) {
  await client.query("savepoint sp");
  try {
    await client.query(sql, params);
    await client.query("rollback to savepoint sp");
    check(false, label, "the database ACCEPTED it — the constraint does not bind");
  } catch (e) {
    await client.query("rollback to savepoint sp");
    check(true, label, e.code || "rejected");
  }
}

(async () => {
  console.log("PROPERTY CHANNEL CAPABILITIES (094) — proof\n");

  const boundary = boundaryFactory({ pool, sms: null });
  check(typeof boundary.propertyHasCapability === "function",
        "boundary exports propertyHasCapability");
  check(Array.isArray(boundary.CAPABILITIES) && boundary.CAPABILITIES.length === 5,
        "five capabilities are defined", (boundary.CAPABILITIES || []).join(", "));

  // ── [0] the live table is EMPTY. The migration activates nobody. ──
  console.log("\n[0] the migration grants nothing");
  const live = await pool.query(`select count(*)::int c from property_channel_capabilities`);
  check(live.rows[0].c === 0, "property_channel_capabilities is empty in production",
        live.rows[0].c === 0 ? "0 rows — nobody activated" : `${live.rows[0].c} ROWS — something granted authority`);

  // ── [1] fail-closed against the REAL, empty table ──
  console.log("\n[1] FAIL-CLOSED — no row means no authority");
  const props = (await pool.query(`select id, name from properties limit 5`)).rows;
  let anyTrue = false;
  for (const p of props) {
    for (const cap of boundary.CAPABILITIES) {
      if (await boundary.propertyHasCapability(pool, { property_id: p.id, capability: cap })) anyTrue = true;
    }
  }
  check(!anyTrue, `all ${boundary.CAPABILITIES.length} capabilities refuse for ${props.length} real properties`);
  check((await boundary.propertyHasCapability(pool, { property_id: props[0].id, capability: "not_a_capability" })) === false,
        "an unknown capability name refuses rather than guessing");
  check((await boundary.propertyHasCapability(pool, { property_id: null, capability: "receive_inbound" })) === false,
        "a null property refuses");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const prop = props[0];

    // ── [2] the closed vocabulary is enforced BY THE DATABASE ──
    console.log("\n[2] the database rejects anything outside the ruling's vocabulary");
    const ins = `insert into property_channel_capabilities
      (property_id, channel, capability, status, activation_note) values ($1,$2,$3,$4,'proof')`;
    await mustReject(client, "unknown channel rejected",
      ins, [prop.id, "carrier_pigeon", "receive_inbound", "active"]);
    await mustReject(client, "unknown capability rejected",
      ins, [prop.id, "sms", "send_anything_ever", "active"]);
    await mustReject(client, "unknown status rejected",
      ins, [prop.id, "sms", "receive_inbound", "probably"]);
    await mustReject(client, "an 'active' row carrying a deactivated_at is rejected",
      `insert into property_channel_capabilities
         (property_id, channel, capability, status, deactivated_at, activation_note)
       values ($1,'sms','receive_inbound','active', now(), 'proof')`, [prop.id]);
    await mustReject(client, "a 'revoked' row with NO deactivated_at is rejected",
      `insert into property_channel_capabilities
         (property_id, channel, capability, status, activation_note)
       values ($1,'sms','receive_inbound','revoked','proof')`, [prop.id]);
    await mustReject(client, "an anonymous grant with no actor AND no note is rejected",
      `insert into property_channel_capabilities (property_id, channel, capability)
       values ($1,'sms','receive_inbound')`, [prop.id]);

    // ── [3] a grant is honoured, and does NOT leak to other capabilities ──
    console.log("\n[3] a grant is honoured — and does NOT widen");
    await client.query(
      `insert into property_channel_capabilities
         (property_id, channel, capability, status, activation_note)
       values ($1,'sms','send_customer_care_human','active','proof: granted inside a rolled-back tx')`,
      [prop.id]);

    check(await boundary.propertyHasCapability(client, { property_id: prop.id, capability: "send_customer_care_human" }),
          "the granted capability now reads true");
    for (const other of ["send_ai_autodispatch", "send_marketing", "send_ai_assisted_approved", "receive_inbound"]) {
      const leaked = await boundary.propertyHasCapability(client, { property_id: prop.id, capability: other });
      check(leaked === false, `it does NOT grant ${other}`,
            leaked ? "LEAKED — capabilities are not separate" : "separate");
    }
    const otherProp = props[1];
    if (otherProp) {
      check((await boundary.propertyHasCapability(client, { property_id: otherProp.id, capability: "send_customer_care_human" })) === false,
            "it does NOT grant the same capability at another property");
    }

    // ── [4] only 'active' is authority ──
    console.log("\n[4] suspended and revoked are history, not authority");
    await client.query(
      `update property_channel_capabilities set status='suspended', deactivated_at=now(),
              deactivation_reason='proof' where property_id=$1 and capability='send_customer_care_human'`,
      [prop.id]);
    check((await boundary.propertyHasCapability(client, { property_id: prop.id, capability: "send_customer_care_human" })) === false,
          "a suspended grant reads false");
    await client.query(
      `update property_channel_capabilities set status='revoked' where property_id=$1 and capability='send_customer_care_human'`,
      [prop.id]);
    check((await boundary.propertyHasCapability(client, { property_id: prop.id, capability: "send_customer_care_human" })) === false,
          "a revoked grant reads false");

    // ── [5] one active grant, not two ──
    console.log("\n[5] at most ONE active grant per property x channel x capability");
    await client.query(
      `insert into property_channel_capabilities (property_id, channel, capability, status, activation_note)
       values ($1,'sms','receive_inbound','active','proof')`, [prop.id]);
    await mustReject(client, "a second ACTIVE grant for the same triple is rejected",
      `insert into property_channel_capabilities (property_id, channel, capability, status, activation_note)
       values ($1,'sms','receive_inbound','active','proof duplicate')`, [prop.id]);

  } finally {
    await client.query("rollback");   // ALWAYS. Nothing above survives.
    client.release();
  }

  console.log("\n[6] the rollback left nothing behind");
  const after = await pool.query(`select count(*)::int c from property_channel_capabilities`);
  check(after.rows[0].c === 0, "production table still empty",
        after.rows[0].c === 0 ? "0 rows" : `${after.rows[0].c} ROWS LEAKED`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
