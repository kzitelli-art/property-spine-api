#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   property_line_preflight.js — READ-ONLY. Run before releasing 129.

   Answers one question: can `properties.sms_number` carry a unique index
   in canonical form, or are there duplicates a human has to resolve first?

   It uses normalizePropertyLine() from src/comms/property_line.js — the
   SAME function the resolver and the write path use. Not a copy, not a
   SQL re-implementation. If this reports clean, migration 129's own
   refusal checks will agree with it, because they are checking the same
   thing the same way.

   STRUCTURALLY READ-ONLY, in the pattern of
   tests/prod_smoke_missed_readonly.js: everything happens inside
   `begin transaction read only`, and it PROVES it cannot write before it
   reads anything. That is why this may point at DATABASE_URL when every
   .db.js harness may not — it cannot mutate the database it inspects, and
   the proof of that is executed, not asserted in a comment.

   It never selects a winner and never mutates. Where two properties share
   a line it prints their exact ids and stops. Which building owns a number
   is an owner ruling, not something a tool infers from row order.

   USAGE
     DATABASE_URL="<connection string>" node tools/property_line_preflight.js

   EXIT
     0  clean — every line normalizes, none collide. 129 can be released.
        (Non-canonical-but-fixable values are listed; 129 backfills them.)
     1  blocked — duplicates and/or unnormalizable values. Ids printed.
     2  could not run.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { Client } = require("pg");
const {
  normalizePropertyLine,
  isCanonicalPropertyLine,
} = require("../src/comms/property_line");

function mask(line) {
  //  A receipt gets pasted into chat. Enough to identify the line, not
  //  enough to publish a resident-facing number.
  if (!line) return String(line);
  const s = String(line);
  return s.length <= 4 ? "***" : `${s.slice(0, 2)}***${s.slice(-4)}`;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("\n  ✗ DATABASE_URL is not set.\n");
    process.exit(2);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  PROPERTY LINE PREFLIGHT — read-only");
  try {
    const who = await client.query("select current_database() as db, current_user as usr, inet_server_addr() as host");
    console.log(`  DATABASE  ${who.rows[0].db}  (user ${who.rows[0].usr})`);
  } catch { /* identity is a courtesy, not the proof */ }

  // ── PROVE READ-ONLY BEFORE READING ANYTHING ───────────────────────
  await client.query("begin transaction read only");
  //  THE PROBE MUST NOT POISON THE TRANSACTION. A failed statement aborts the
  //  whole transaction block, so every read after it dies with "current
  //  transaction is aborted". That is verbatim the documented incident — a
  //  read-only smoke whose own safety probe aborted its own transaction and
  //  then reported nothing. The savepoint is what makes the probe survivable.
  let writable = false;
  await client.query("savepoint write_probe");
  try {
    await client.query("create temporary table __preflight_write_probe (x int)");
    writable = true;
  } catch { /* expected: read-only transaction */ }
  await client.query("rollback to savepoint write_probe");
  if (writable) {
    console.error("\n  ✗ REFUSED — this transaction accepted a write.");
    console.error("    A read-only tool that can write is not read-only. Nothing was read.\n");
    await client.query("rollback").catch(() => {});
    await client.end();
    process.exit(2);
  }
  console.log("  READ-ONLY proven — a write was attempted and refused before any read.");
  console.log("════════════════════════════════════════════════════════════════\n");

  const { rows } = await client.query(
    "select id, name, sms_number from properties where sms_number is not null order by id"
  );

  const unnormalizable = [];
  const byNormalized = new Map();
  const needsBackfill = [];

  for (const r of rows) {
    const norm = normalizePropertyLine(r.sms_number);
    if (!norm) { unnormalizable.push(r); continue; }
    if (!isCanonicalPropertyLine(r.sms_number)) needsBackfill.push({ ...r, norm });
    if (!byNormalized.has(norm)) byNormalized.set(norm, []);
    byNormalized.get(norm).push(r);
  }

  const duplicates = [...byNormalized.entries()].filter(([, rs]) => rs.length > 1);

  console.log(`  properties holding a line   ${rows.length}`);
  console.log(`  distinct lines after normalizing   ${byNormalized.size}`);
  console.log(`  stored in non-canonical form       ${needsBackfill.length}`);
  console.log(`  unnormalizable                     ${unnormalizable.length}`);
  console.log(`  COLLIDING LINES                    ${duplicates.length}\n`);

  if (needsBackfill.length) {
    console.log("  ── non-canonical, will be rewritten by migration 129 ──");
    for (const r of needsBackfill) {
      console.log(`     property ${r.id}   ${JSON.stringify(r.sms_number)}  ->  ${mask(r.norm)}`);
    }
    console.log("");
  }

  let code = 0;

  if (unnormalizable.length) {
    code = 1;
    console.log("  ── ✗ UNNORMALIZABLE — not US phone numbers ──");
    for (const r of unnormalizable) {
      console.log(`     property ${r.id}  ${r.name || "(unnamed)"}   stored: ${JSON.stringify(r.sms_number)}`);
    }
    console.log("     An unreadable line is not a line. Correct or clear each value.\n");
  }

  if (duplicates.length) {
    code = 1;
    console.log("  ── ✗ COLLISION — one line, more than one property ──");
    for (const [norm, rs] of duplicates) {
      console.log(`     ${mask(norm)}`);
      for (const r of rs) {
        console.log(`        property ${r.id}   ${r.name || "(unnamed)"}   stored: ${JSON.stringify(r.sms_number)}`);
      }
    }
    console.log("");
    console.log("     A resident texting this number cannot be routed: there is no");
    console.log("     correct property to bind their claim to. This tool does NOT");
    console.log("     pick one — clear the line on whichever properties should not");
    console.log("     hold it, then re-run. Migration 129 refuses until this is clean.\n");
  }

  if (code === 0) {
    console.log("  ✓ CLEAN — every line normalizes and none collide.");
    console.log("    Migration 129 can be released.\n");
  } else {
    console.log("  ✗ BLOCKED — resolve the above before releasing migration 129.\n");
  }

  await client.query("rollback");
  await client.end();
  console.log(`  EXIT  ${code}`);
  console.log("════════════════════════════════════════════════════════════════\n");
  process.exit(code);
}

main().catch((e) => {
  console.error("\n  ✗ preflight could not run: " + (e && e.message ? e.message : e) + "\n");
  process.exit(2);
});
