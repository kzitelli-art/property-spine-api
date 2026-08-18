#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
 *  activate_property_line.js
 *
 *  CLASS 2 — TEMPORARY ADAPTER
 *  REPLACEMENT CONDITION: API-driven property-line provisioning exists.
 *    Deleted when onboarding can buy a number, attach it to the approved
 *    Messaging Service, verify registration, and write the canonical line
 *    in one transaction. One manual activation is correct. Two is a smell.
 *    Two hundred is a business bounded by how fast a person clicks a
 *    console. See the parked design item: "Portfolio Communications
 *    Provisioning & Sender Identity".
 *
 *  WHAT THIS DOES, AND ONLY THIS
 *    provider configuration established externally
 *            ↓  one deliberate canonical Spine write
 *            ↓  read back canonical communication_lines row
 *            ↓  read back properties.sms_number projection
 *            ↓  agree or fail
 *
 *  HARD BOUNDARY. This tool does NOT and must never: buy Twilio numbers,
 *  call Twilio, attach Messaging Services, inspect campaigns, modify
 *  environment variables, configure webhooks, or infer the property from a
 *  name. The provider side is a human's job today; this establishes the
 *  already-provisioned line in canonical Spine truth and proves the legacy
 *  projection follows.
 *
 *  WHY A SEPARATE WRITER EXISTS AT ALL
 *  The existing POST /properties/:id/sms-number writes a row that is
 *  internally consistent and operationally false — outbound_enabled=false
 *  with outbound_policy defaulting to 'disabled', which satisfies
 *  ck_cl_outbound_flag_matches_policy while being the only property line in
 *  production that cannot send. That route is being deleted. This writes
 *  the row every other property line has: outbound_policy='proactive'.
 *
 *  DRY-RUN BY DEFAULT. Nothing commits without --commit. The dry run does
 *  the entire transaction — schema check, refusals, insert, both read-backs
 *  — and then ROLLS BACK, so what --commit will do is exactly what the dry
 *  run showed, minus the rollback.
 *
 *  USAGE
 *    DATABASE_URL=... node tools/activate_property_line.js \
 *        --property <skyline-uuid> --number +12157708837 [--commit]
 *    DATABASE_URL=... node tools/activate_property_line.js \
 *        --property <skyline-uuid> --retire [--commit]
 * ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");
const {
  normalizePropertyLine,
  isCanonicalPropertyLine,
} = require("../src/comms/property_line.js");

//  The ONE property this adapter is for. A different id is refused, not
//  activated — "exact canonical Skyline UUID" is a wall, not a default.
const SKYLINE_PROPERTY_ID = "14e41b7c-e91c-49e8-9651-10c4908a8f6a";

//  The exact canonical row. Every field is here so the record is legible
//  in one place and the reader is not chasing it through an INSERT.
const CANONICAL = {
  line_type: "property_facing",
  authority_ceiling: "external",
  permitted_audience: "residents_and_prospects",
  inbound_enabled: true,
  outbound_policy: "proactive",   // matches every other property line (132 backfill)
  outbound_enabled: true,         // forced true by ck_cl_outbound_flag_matches_policy
  status: "active",
};

//  The live-schema assertions. Names, not shapes: the migrations own the
//  shapes; this proves the walls the row will be checked against actually
//  exist in the database being written, rather than in a migration file
//  that may or may not have applied (see migration 090's swallowed
//  exceptions — ledger height is not evidence of applied schema).
const REQUIRED_CONSTRAINTS = [
  "ck_cl_outbound_policy_by_type",
  "ck_cl_outbound_flag_matches_policy",
  "ck_cl_e164_canonical",
  "ck_cl_posture_coherent",
  "ck_cl_exactly_one_owner",
];
const REQUIRED_INDEXES = [
  "uq_communication_lines_active_e164",
  "uq_cl_one_active_property_line",
  "uq_cl_one_active_ops_line_per_org",
];
const REQUIRED_TRIGGER = "trg_cl_project_property_line";

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes("--" + name);

function die(msg) {
  console.error("\n  REFUSED: " + msg + "\n  Nothing was written.\n");
  process.exit(1);
}
const line = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 60 - t.length)));

async function verifyLiveSchema(c) {
  line("SCHEMA — proving the walls exist in THIS database");
  const missing = [];

  const cons = (await c.query(
    `select conname from pg_constraint where conname = any($1)`, [REQUIRED_CONSTRAINTS]
  )).rows.map((r) => r.conname);
  for (const name of REQUIRED_CONSTRAINTS) {
    const ok = cons.includes(name);
    console.log("  " + (ok ? "ok  " : "MISSING ") + "constraint " + name);
    if (!ok) missing.push("constraint " + name);
  }

  const idx = (await c.query(
    `select indexname from pg_indexes where indexname = any($1)`, [REQUIRED_INDEXES]
  )).rows.map((r) => r.indexname);
  for (const name of REQUIRED_INDEXES) {
    const ok = idx.includes(name);
    console.log("  " + (ok ? "ok  " : "MISSING ") + "index " + name);
    if (!ok) missing.push("index " + name);
  }

  const trg = (await c.query(
    `select tgname from pg_trigger where tgname = $1`, [REQUIRED_TRIGGER]
  )).rowCount;
  console.log("  " + (trg ? "ok  " : "MISSING ") + "trigger " + REQUIRED_TRIGGER);
  if (!trg) missing.push("trigger " + REQUIRED_TRIGGER);

  if (missing.length) {
    die("live schema is not what this tool builds against — " + missing.join(", ") +
        ".\n  The migration for the communication-line model is not applied here.");
  }
  console.log("\n  all schema walls present.");
}

async function activate(c, propertyId, rawNumber) {
  const number = normalizePropertyLine(rawNumber);
  if (!number || !isCanonicalPropertyLine(number)) {
    die("'" + rawNumber + "' is not a US number this tool can canonicalize. " +
        "Give 10 digits or +1XXXXXXXXXX.");
  }

  line("REFUSALS — all four must hold");

  //  1 · the property exists, exactly.
  const prop = (await c.query(
    `select id, coalesce(display_name, name) as name,
            (select count(*) from units u where u.property_id = p.id) as units
       from properties p where id = $1`, [propertyId]
  )).rows[0];
  if (!prop) die("no property has id " + propertyId + ".");
  console.log("  ok  property exists: " + prop.name + " (" + prop.units + " units)");

  //  2 · it is exactly the canonical Skyline id.
  if (String(propertyId) !== SKYLINE_PROPERTY_ID) {
    die("property " + propertyId + " is not the canonical Skyline id " +
        SKYLINE_PROPERTY_ID + ". This adapter activates one property.");
  }
  console.log("  ok  it is the canonical Skyline id");

  //  3 · Skyline has no active property-facing line already.
  const existing = (await c.query(
    `select e164 from communication_lines
      where property_id = $1 and line_type = 'property_facing' and status = 'active'`,
    [propertyId]
  )).rows;
  if (existing.length) {
    die("Skyline already has an active property line (" + existing.map((r) => r.e164).join(", ") +
        "). Retire it first if you mean to replace it — do not stack a second.");
  }
  console.log("  ok  Skyline has no active property-facing line");

  //  4 · the number is not active anywhere else.
  const elsewhere = (await c.query(
    `select cl.property_id, coalesce(p.display_name, p.name) as name
       from communication_lines cl
       left join properties p on p.id = cl.property_id
      where cl.e164 = $1 and cl.status = 'active'`, [number]
  )).rows;
  if (elsewhere.length) {
    die(number + " is already an active line on " +
        elsewhere.map((r) => r.name || r.property_id || "an operations line").join(", ") +
        ". One active line per number, globally.");
  }
  console.log("  ok  " + number + " is not active anywhere else");

  //  ── THE ONE WRITE ──────────────────────────────────────────────────
  line("WRITE — the canonical row");
  const inserted = (await c.query(
    `insert into communication_lines
       (e164, line_type, property_id, organization_id, authority_ceiling,
        permitted_audience, inbound_enabled, outbound_policy, outbound_enabled,
        status, notes)
     values ($1, $2, $3, null, $4, $5, $6, $7, $8, $9, $10)
     returning id, e164, line_type, property_id, authority_ceiling,
               permitted_audience, inbound_enabled, outbound_policy,
               outbound_enabled, status`,
    [number, CANONICAL.line_type, propertyId, CANONICAL.authority_ceiling,
     CANONICAL.permitted_audience, CANONICAL.inbound_enabled, CANONICAL.outbound_policy,
     CANONICAL.outbound_enabled, CANONICAL.status,
     "activated via tools/activate_property_line.js (Class 2 adapter)"]
  )).rows[0];
  console.table(inserted);

  //  ── READ BACK BOTH, REQUIRE AGREEMENT ──────────────────────────────
  //  The projection trigger fires AFTER the insert, inside this same
  //  transaction, so the projected column is already set. If it disagrees
  //  the trigger did not fire, and the whole point of this tool — that the
  //  legacy column follows the canonical truth — is unproven.
  line("PROJECTION — communication_lines vs properties.sms_number");
  const projected = (await c.query(
    `select sms_number from properties where id = $1`, [propertyId]
  )).rows[0].sms_number;
  console.log("  canonical communication_lines.e164 : " + inserted.e164);
  console.log("  projected properties.sms_number    : " + projected);
  if (projected !== inserted.e164) {
    die("the projection did not follow the canonical write (" +
        JSON.stringify(projected) + " vs " + inserted.e164 + "). " +
        "The projection trigger did not fire — do not trust this activation.");
  }
  console.log("\n  they agree. the projection trigger fired.");
  return inserted;
}

async function retire(c, propertyId) {
  line("RETIRE — take Skyline's active property line to 'retired'");
  console.log("  This is the rollback path. Carrier registration can reset after a");
  console.log("  verified-deliverable check (moving a number between Messaging Services");
  console.log("  is itself a reset trigger). Without this, a post-commit reset leaves a");
  console.log("  row that is correct-by-design and wrong-in-fact.\n");

  if (String(propertyId) !== SKYLINE_PROPERTY_ID) {
    die("property " + propertyId + " is not the canonical Skyline id.");
  }
  const r = await c.query(
    `update communication_lines
        set status = 'retired', superseded_at = now(), updated_at = now()
      where property_id = $1 and line_type = 'property_facing' and status = 'active'
      returning id, e164`, [propertyId]
  );
  if (r.rowCount === 0) die("Skyline has no active property line to retire.");
  if (r.rowCount > 1)  die("more than one active property line for Skyline — refusing to retire " +
                           r.rowCount + " at once. Investigate; this should be impossible under the unique index.");
  console.log("  retired: " + r.rows[0].e164 + " (id " + r.rows[0].id + ")");

  //  status='retired' is NOT in uq_cl_one_active_property_line, so the
  //  projection trigger now finds no active line and clears the column.
  const projected = (await c.query(
    `select sms_number from properties where id = $1`, [propertyId]
  )).rows[0].sms_number;
  console.log("  projected properties.sms_number now : " + JSON.stringify(projected));
  if (projected !== null) {
    die("retiring the line did not clear the projection (still " + JSON.stringify(projected) + "). " +
        "The projection trigger did not fire on the update.");
  }
  console.log("\n  projection cleared. the number no longer belongs to Skyline.");
}

(async () => {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");
  const propertyId = arg("property", null);
  if (!propertyId) die("--property <uuid> is required.");
  const isRetire = flag("retire");
  const number = arg("number", null);
  if (!isRetire && !number) die("--number +1XXXXXXXXXX is required (or use --retire).");
  const commit = flag("commit");

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  PROPERTY LINE ACTIVATION" + (isRetire ? " — RETIRE" : "") +
              "   [" + (commit ? "COMMIT" : "DRY RUN") + "]");
  console.log("════════════════════════════════════════════════════════════════");

  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  let failed = false;
  try {
    await c.query("begin");
    await verifyLiveSchema(c);
    if (isRetire) await retire(c, propertyId);
    else await activate(c, propertyId, number);

    if (commit) {
      await c.query("commit");
      console.log("\n  COMMITTED. This is a real, durable change.\n");
    } else {
      await c.query("rollback");
      console.log("\n  DRY RUN — rolled back. Nothing changed. Re-run with --commit to write.\n");
    }
  } catch (e) {
    failed = true;
    try { await c.query("rollback"); } catch (_) {}
    console.error("\n  FAILED — " + (e && e.message ? e.message : String(e)) +
                  "\n  Rolled back. Nothing was written.\n");
  } finally {
    await c.end();
  }
  process.exit(failed ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
