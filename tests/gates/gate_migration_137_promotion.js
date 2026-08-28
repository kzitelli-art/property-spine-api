#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — MIGRATION 137 IS THE PROVEN PAYLOAD, UNCHANGED

   The 100k-row scale proof measured ONE artifact:

     tools/scale/137_release_0_payload.sql
     sha256 ae4b9b774cd9be8568ea24219d4ee4a98350b2bce3a03baf8de33d0cfcc2ea4d

   If migrations/137 differs from it in any substantive byte, that proof
   no longer binds and nobody has measured what production would run.
   This gate exists so promotion cannot quietly become authorship.

   ── WHAT MAY DIFFER, AND WHY ────────────────────────────────────────
   Exactly three things:

     filename        the payload is not in migrations/ by design
     comments        the promoted file explains its own provenance
     the wrapper     migrate.js already issues begin/commit AND writes
                     the schema_migrations row INSIDE that transaction

   The wrapper is the one that matters. Leaving the payload's own
   `begin; … commit;` in place would commit the DDL BEFORE the ledger
   insert, so a crash in between would leave schema 137 applied with no
   ledger row — the exact split-brain the ledger exists to prevent.
   Removing it does not change transaction semantics; it hands the
   transaction to the caller that already owns it.

   ── WHAT MAY NOT DIFFER ─────────────────────────────────────────────
   Table definitions, columns, constraints, foreign keys, ON DELETE
   behaviour, indexes, trigger bodies, functions, views. Every one of
   those is compared statement by statement after normalisation.

   ── ANTI-VACUUM ─────────────────────────────────────────────────────
   Normalisation that removes too much would make any two files "equal".
   The gate therefore refuses unless the normalised form retains a
   substantial statement count and character length, and it proves the
   frozen digest still matches the payload on disk before comparing
   anything at all.

   run:  node tests/gates/gate_migration_137_promotion.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const PAYLOAD = path.join(ROOT, "tools/scale/137_release_0_payload.sql");
const MIGRATION = path.join(ROOT, "migrations/137_release_0_completion_proof.sql");

//  The digest the scale proof measured. Frozen. If the payload changes,
//  this gate fails and the scale proof must be re-run — it does not get
//  updated to match.
const PROVEN_DIGEST = "ae4b9b774cd9be8568ea24219d4ee4a98350b2bce3a03baf8de33d0cfcc2ea4d";

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); } return c; };

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_migration_137_promotion.js");
console.log("  checks: migrations/137 DDL == the proven scale payload DDL");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

// ── 1. THE PAYLOAD IS STILL THE MEASURED ARTIFACT ─────────────────────
if (!ok("P1  the proven payload exists", fs.existsSync(PAYLOAD), PAYLOAD)) process.exit(1);
const payloadRaw = fs.readFileSync(PAYLOAD, "utf8");
const payloadDigest = crypto.createHash("sha256")
  .update(payloadRaw.replace(/\r\n/g, "\n")).digest("hex");
ok("P2  the payload still carries the digest the scale proof measured",
   payloadDigest === PROVEN_DIGEST,
   "expected " + PROVEN_DIGEST + "\n        got      " + payloadDigest +
   "\n        → the measured artifact changed. Re-run the scale proof; do not " +
   "update this constant to match.");

if (!ok("P3  the migration candidate exists", fs.existsSync(MIGRATION), MIGRATION)) {
  console.log("\n  Nothing to compare. Author the migration by DERIVING it from the payload.");
  process.exit(1);
}
const migrationRaw = fs.readFileSync(MIGRATION, "utf8");

// ── 2. NORMALISE ──────────────────────────────────────────────────────
/*  Full-line comments only. An INLINE comment is deliberately NOT
 *  stripped: if one appeared on a DDL line and differed between the two
 *  files, this gate should notice rather than quietly forgive it. Erring
 *  toward flagging is the safe direction for a promotion check. */
function normalise(sql, { stripOuterTransaction }) {
  let lines = sql.split("\n").filter((l) => !/^\s*--/.test(l));
  let text = lines.join("\n");
  if (stripOuterTransaction) {
    //  Remove exactly ONE leading `begin;` and ONE trailing `commit;`.
    //  Anchored so a `begin`/`commit` appearing anywhere else — inside a
    //  function body, say — is left alone and would surface as a diff.
    text = text.replace(/^\s*begin\s*;/i, "");
    text = text.replace(/commit\s*;\s*$/i, "");
  }
  return text.replace(/\s+/g, " ").trim();
}

const nPayload = normalise(payloadRaw, { stripOuterTransaction: true });
const nMigration = normalise(migrationRaw, { stripOuterTransaction: false });

//  ANTI-VACUUM. Normalisation that ate the content would make anything
//  equal to anything.
ok("N1  the normalised payload is substantial (normalisation did not eat it)",
   nPayload.length > 3000, "normalised to " + nPayload.length + " chars");
const stmtCount = nPayload.split(";").filter((s) => s.trim()).length;
ok("N2  the normalised payload retains its statements",
   stmtCount >= 15, "only " + stmtCount + " statements survived normalisation");
console.log("        " + stmtCount + " statements · " + nPayload.length + " normalised chars");

// ── 3. THE MIGRATION MUST NOT OPEN ITS OWN TRANSACTION ────────────────
//  migrate.js issues begin/commit AND writes schema_migrations inside it.
const migCode = migrationRaw.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
ok("W1  the migration does not issue its own `begin`",
   !/^\s*begin\s*;/im.test(migCode),
   "migrate.js already opened one; a nested begin is a no-op warning");
ok("W2  the migration does not issue its own `commit`",
   !/^\s*commit\s*;/im.test(migCode),
   "a commit here lands the DDL BEFORE the schema_migrations row — a crash " +
   "between them leaves schema 137 applied with no ledger entry");

// ── 4. STATEMENT-BY-STATEMENT EQUIVALENCE ─────────────────────────────
const split = (s) => s.split(";").map((x) => x.trim()).filter(Boolean);
const a = split(nPayload), b = split(nMigration);
ok("E1  same statement count", a.length === b.length,
   "payload " + a.length + " vs migration " + b.length);

let firstDiff = null;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) { firstDiff = i; break; }
}
ok("E2  every statement is byte-identical after normalisation",
   firstDiff === null,
   firstDiff === null ? null :
   "first difference at statement " + (firstDiff + 1) +
   "\n        payload:   " + String(a[firstDiff]).slice(0, 160) +
   "\n        migration: " + String(b[firstDiff]).slice(0, 160));

ok("E3  the whole normalised body is identical", nPayload === nMigration);

// ── 5. THE PROMOTED FILE STILL SAYS WHERE IT CAME FROM ────────────────
ok("D1  the migration cites the payload path", /tools\/scale\/137_release_0_payload\.sql/.test(migrationRaw));
ok("D2  the migration records the proven digest", migrationRaw.includes(PROVEN_DIGEST));

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log("  " + (fail === 0 ? "✓ PASS" : "✗ FAIL") + " — gate_migration_137_promotion.js");
if (fail === 0) console.log("\n  The scale proof binds migrations/137. Same DDL, measured at 100k rows.");
console.log("  EXIT      " + (fail === 0 ? 0 : 1));
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
