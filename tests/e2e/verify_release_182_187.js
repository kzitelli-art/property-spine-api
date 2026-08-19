#!/usr/bin/env node
/*  ════════════════════════════════════════════════════════════════════
    RELEASE VERIFIER — 181 → 187

    THE AUTHORITATIVE VERDICT ON WHETHER THE RELEASE ACTUALLY EXISTS.

    It is NOT a migration runner and it applies NOTHING. Every statement
    it issues is a SELECT. It reads the database and answers one question:
    is the intended release present, in the expected shape?

    ── WHY IT EXISTS ───────────────────────────────────────────────────
    Five migrations in this chain record themselves into schema_migrations
    inside their own transaction, and the runner then reports "FAILED —
    rolled back. Nothing from this file was applied" while the objects
    were in fact created and persist. An operator is told the opposite of
    the truth at the moment they most need accuracy.

    This verifier protects THIS release from that. It does not fix it.
    W-4 REMAINS OPEN: the runner still lies to its operator, and the fix
    for that is to correct the runner's own reporting after 182–187 have
    safely landed — not to build a second migration mechanism.

    ── USE ─────────────────────────────────────────────────────────────
      node tests/e2e/verify_release_182_187.js --db "$URL" --before
      node tests/e2e/verify_release_182_187.js --db "$URL" --after

    --before  asserts the starting state is EXACTLY 181 and that none of
              182–187 is already present. Run immediately before applying.
    --after   asserts the full release landed. This is the release verdict.

    Exit 0 only when every assertion holds. Anything else is non-zero.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const { Pool } = require(path.join(__dirname, "..", "..", "node_modules", "pg"));

const RELEASE = ["182", "183", "184", "185", "186", "187"];
const START_CEILING = 181;
const END_CEILING = 187;

//  ── WHAT THE SIX MIGRATIONS CLAIM TO CREATE ───────────────────────────
//  Declared, not derived. A verifier that re-parses the migration files
//  would agree with them by construction — including where they are wrong.
//  This list was read off a schema the release was actually applied to,
//  then checked against the migration text.
const COLUMNS = [
  ["182", "application_invitations", "space_id", "uuid"],
  ["182", "lease_applications", "space_id", "uuid"],
  ["184", "lease_packets", "instrument_form_code", "text"],
  ["184", "lease_packets", "instrument_form_version", "text"],
  ["184", "lease_packets", "instrument_body_sha256", "text"],
  ["184", "lease_packets", "instrument_established_at", "timestamp with time zone"],
  ["184", "lease_packets", "resident_executed_at", "timestamp with time zone"],
  ["184", "lease_packets", "company_executed_at", "timestamp with time zone"],
  ["184", "lease_packet_fields", "signed_by_user_id", "uuid"],
  ["184", "lease_packet_fields", "signed_by_person_id", "uuid"],
  ["185", "executed_lease_records", "verification_basis", "text"],
  ["185", "executed_lease_records", "source_lease_packet_id", "uuid"],
  ["186", "properties", "lease_config", "jsonb"],
  ["187", "leases", "security_deposit", "numeric"],
];

const INDEXES = [
  ["182", "ix_application_invitations_space"],
  ["182", "ix_lease_applications_space"],
  ["183", "uq_pricing_terms_default_version_type_term"],
  ["183", "uq_pricing_terms_override_version_type_term_scope"],
  ["185", "uq_elr_source_lease_packet"],
  ["185", "ix_elr_verification_basis"],
];

//  183 REPLACES an index shipped by 101. Its absence is part of the
//  release landing, and an index that is supposed to be gone but is not
//  means the migration did not do what it claims.
const ABSENT_INDEXES = [["183", "uq_pricing_terms_version_type_term"]];

const TRIGGERS = [
  ["182", "trg_application_invitation_space_grain"],
  ["182", "trg_lease_application_space_grain"],
  ["184", "trg_lease_packet_execution_guard"],
];
const FUNCTIONS = [
  ["182", "assert_application_space_grain"],
  ["184", "assert_lease_packet_execution"],
];

//  ── SHAPE, NOT MERE EXISTENCE ─────────────────────────────────────────
//  A constraint can exist and still not admit the values the release is
//  for. 185's own migration note records exactly this trap: a DROP of a
//  guessed constraint name succeeded silently, leaving the real one still
//  rejecting spine_esign while the migration appeared to apply. So each
//  constraint is checked for the tokens it must ADMIT.
const CONSTRAINT_ADMITS = [
  ["184", "lease_packet_fields_signer_role_check", ["tenant", "guarantor", "company"]],
  ["184", "lease_packets_status_check", ["resident_executed", "executed", "voided"]],
  ["185", "ck_elr_verification_basis", ["staff_attestation", "spine_instrument"]],
  ["185", "executed_lease_channel_ck", ["paper", "external_esign", "spine_esign", "other"]],
  ["185", "ck_elr_spine_instrument_lineage", ["spine_instrument", "spine_esign", "source_lease_packet_id"]],
];

let failures = 0;
const ok   = (m, d) => console.log(`  ✓ ${m}${d ? "  — " + d : ""}`);
const bad  = (m, d) => { failures++; console.log(`  ✗ ${m}  — ${d}`); };

(async () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--db");
  const url = i > -1 ? argv[i + 1] : process.env.E2E_DATABASE_URL;
  if (!url) { console.error("usage: --db <url>  (or set E2E_DATABASE_URL)"); process.exit(64); }
  const phase = argv.includes("--before") ? "before" : "after";
  const pool = new Pool({ connectionString: url });
  const q = (s, p) => pool.query(s, p);

  console.log("=".repeat(64));
  console.log(`  RELEASE VERIFIER  ·  181 → 187  ·  phase: ${phase.toUpperCase()}`);
  console.log(`  ${url.replace(/:\/\/[^@]*@/, "://****@").split("?")[0]}`);
  console.log("=".repeat(64));

  // ── the ledger ──────────────────────────────────────────────────────
  const led = (await q("select version from schema_migrations")).rows.map((r) => String(Number(r.version)));
  const have = new Set(led);
  const ceiling = Math.max(...led.map(Number).filter(Number.isFinite));
  const present = RELEASE.filter((v) => have.has(String(Number(v))));

  if (phase === "before") {
    if (ceiling === START_CEILING) ok(`starting ceiling is exactly ${START_CEILING}`);
    else bad(`starting ceiling is exactly ${START_CEILING}`, `found ${ceiling} — DO NOT APPLY`);
    if (!present.length) ok("none of 182–187 is already present");
    else bad("none of 182–187 is already present", `already there: ${present.join(", ")}`);
    console.log(`  · ledger entries: ${led.length}`);
  } else {
    if (ceiling === END_CEILING) ok(`final ceiling is exactly ${END_CEILING}`);
    else bad(`final ceiling is exactly ${END_CEILING}`, `found ${ceiling}`);

    const missing = RELEASE.filter((v) => !have.has(String(Number(v))));
    if (!missing.length) ok("182–187 all recorded in the ledger");
    else bad("182–187 all recorded in the ledger", `missing: ${missing.join(", ")}`);

    //  The count is derived from the starting count, not hardcoded: the
    //  release adds exactly six rows to whatever was there.
    const expected = Number(process.env.EXPECTED_START_ENTRIES || 169) + RELEASE.length;
    if (led.length === expected) ok(`ledger entry count is ${expected}`);
    else bad(`ledger entry count is ${expected}`, `found ${led.length} (set EXPECTED_START_ENTRIES if the pre-release count differed)`);
  }

  if (phase === "before") {
    console.log("=".repeat(64));
    console.log(failures ? "  ✗ NOT SAFE TO APPLY" : "  ✓ STARTING STATE CONFIRMED — safe to apply 182–187");
    console.log("=".repeat(64));
    await pool.end();
    process.exit(failures ? 2 : 0);
  }

  // ── every durable object the release claims ─────────────────────────
  console.log("\n── columns ──");
  for (const [v, t, c, type] of COLUMNS) {
    const r = (await q(
      `select data_type from information_schema.columns where table_name=$1 and column_name=$2`, [t, c])).rows[0];
    if (!r) bad(`${v}  ${t}.${c}`, "ABSENT");
    else if (r.data_type !== type) bad(`${v}  ${t}.${c}`, `type is ${r.data_type}, expected ${type}`);
    else ok(`${v}  ${t}.${c}`, type);
  }

  console.log("\n── indexes ──");
  for (const [v, n] of INDEXES) {
    const r = (await q(`select 1 from pg_indexes where indexname=$1`, [n])).rows[0];
    r ? ok(`${v}  ${n}`) : bad(`${v}  ${n}`, "ABSENT");
  }
  for (const [v, n] of ABSENT_INDEXES) {
    const r = (await q(`select 1 from pg_indexes where indexname=$1`, [n])).rows[0];
    r ? bad(`${v}  ${n} is GONE`, "still present — the replacement did not take") : ok(`${v}  ${n} is gone, as ${v} intends`);
  }

  console.log("\n── triggers and functions ──");
  for (const [v, n] of TRIGGERS) {
    const r = (await q(`select 1 from pg_trigger where tgname=$1 and not tgisinternal`, [n])).rows[0];
    r ? ok(`${v}  ${n}`) : bad(`${v}  ${n}`, "ABSENT");
  }
  for (const [v, n] of FUNCTIONS) {
    const r = (await q(`select 1 from pg_proc where proname=$1`, [n])).rows[0];
    r ? ok(`${v}  ${n}()`) : bad(`${v}  ${n}()`, "ABSENT");
  }

  console.log("\n── constraints, by what they ADMIT ──");
  for (const [v, n, tokens] of CONSTRAINT_ADMITS) {
    const r = (await q(`select pg_get_constraintdef(oid) d from pg_constraint where conname=$1`, [n])).rows[0];
    if (!r) { bad(`${v}  ${n}`, "ABSENT"); continue; }
    const absent = tokens.filter((t) => !r.d.includes(t));
    absent.length
      ? bad(`${v}  ${n}`, `exists but does NOT admit: ${absent.join(", ")}`)
      : ok(`${v}  ${n}`, `admits ${tokens.join(", ")}`);
  }

  console.log("=".repeat(64));
  if (failures) {
    console.log(`  ✗ RELEASE NOT VERIFIED — ${failures} assertion(s) failed.`);
    console.log("    The runner's own message is NOT evidence. This is.");
  } else {
    console.log("  ✓ RELEASE VERIFIED — 181 → 187 exists in the expected shape.");
  }
  console.log("=".repeat(64));
  await pool.end();
  process.exit(failures ? 2 : 0);
})().catch((e) => { console.error("DIED: " + e.stack); process.exit(1); });
