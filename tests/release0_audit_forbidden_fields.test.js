#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   release0_audit_forbidden_fields.test.js

   Proves that docs/RELEASE_0_AUDIT_PLAN.md §5 — the columns the Release 0
   audit may never select — is enforced by something other than the author
   remembering it.

   NOT a .db.js harness. It opens no database connection, so it cannot
   pollute anything, and it is safe to run anywhere. It reads the audit
   tool's OWN SOURCE and the query set it exports.

   TWO CHECKS, because they fail differently:

     1. STATIC   — no forbidden column may appear as a selected expression
                   in any query the tool ships.
     2. SHAPE    — presence checks (`col is not null`) are permitted and
                   must survive, so the test cannot pass by banning the
                   substring outright. That distinction is the one most
                   likely to be lost in a later edit, so it is asserted
                   rather than trusted.

   Run:  node tests/release0_audit_forbidden_fields.test.js
   Exit: 0 all assertions passed · 1 one or more failed
   ════════════════════════════════════════════════════════════════════ */

"use strict";

const fs = require("fs");
const path = require("path");

const TOOL_PATH = path.join(__dirname, "..", "tools", "release0_proof_audit.js");
const { QUERIES } = require(TOOL_PATH);

let failures = 0;
let passes = 0;

function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
    if (detail) console.error(`      ${detail}`);
  }
}

/*  The §5 list, as identifiers. Each entry is a column whose CONTENTS may
 *  never be emitted. `presenceOk` marks the two columns a presence check is
 *  explicitly permitted on (plan §5, query C5). */
const FORBIDDEN = [
  { table: "comm_events", column: "body", presenceOk: false },
  { table: "work_order_progress", column: "note", presenceOk: false },
  { table: "work_orders", column: "description", presenceOk: false },
  { table: "work_orders", column: "title", presenceOk: false },
  { table: "work_orders", column: "completion_note", presenceOk: true },
  { table: "work_orders", column: "completion_photo", presenceOk: true },
  { table: "users", column: "name", presenceOk: false },
  { table: "persons", column: "name", presenceOk: false },
  { table: "persons", column: "phone", presenceOk: false },
  { table: "persons", column: "email", presenceOk: false },
  { table: "work_order_proof_attachments", column: "provider_media_url", presenceOk: false },
  { table: "work_order_proof_attachments", column: "content", presenceOk: false },
];

/*  Strip SQL comments before scanning. A column named in a comment is
 *  documentation, not a selection, and treating it as a violation would
 *  push authors toward deleting the explanation instead of the risk. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/*  A permitted presence check: the column appears ONLY inside an
 *  `is not null` / `is null` test. */
function occurrencesOutsidePresenceCheck(sql, column) {
  const cleaned = stripComments(sql);
  const presence = new RegExp(
    `[\\w.]*\\b${column}\\b\\s+is\\s+(not\\s+)?null`, "gi");
  const withoutPresence = cleaned.replace(presence, " __presence__ ");
  const bare = new RegExp(`\\b${column}\\b`, "gi");
  return (withoutPresence.match(bare) || []).length;
}

console.log("\n══ Release 0 audit — forbidden field enforcement ══\n");
console.log(`  queries under test: ${QUERIES.length}\n`);

// ── 1. STATIC: no forbidden column contents in any shipped query ──────
for (const f of FORBIDDEN) {
  let violations = [];
  for (const q of QUERIES) {
    const n = occurrencesOutsidePresenceCheck(q.sql, f.column);
    if (n > 0) violations.push(`${q.key} (${n}×)`);
  }
  check(
    `${f.table}.${f.column} contents never selected`,
    violations.length === 0,
    violations.length ? `appears outside a presence check in: ${violations.join(", ")}` : null);
}

// ── 2. SHAPE: the permitted presence checks must actually be present ──
//  Without this, deleting query C5 entirely would make check 1 pass while
//  losing the finding C5 exists to produce.
const allSql = QUERIES.map((q) => stripComments(q.sql)).join("\n");
check(
  "completion_photo IS still checked for presence (C5 not silently dropped)",
  /completion_photo\s+is\s+not\s+null/i.test(allSql),
  "the third proof model would go uncounted");
check(
  "completion_note IS still checked for presence",
  /completion_note\s+is\s+not\s+null/i.test(allSql),
  "C5 cannot split on both columns");

// ── 3. No SELECT * anywhere. A wildcard defeats every check above. ────
{
  const wildcards = QUERIES.filter((q) => /select\s+\*/i.test(stripComments(q.sql)));
  check(
    "no query uses SELECT * (a wildcard would defeat every check above)",
    wildcards.length === 0,
    wildcards.map((q) => q.key).join(", "));
}

// ── 4. Forbidden TABLES are never joined at all. ──────────────────────
//  persons carries nothing this audit needs, so reaching it is a mistake
//  regardless of which column is named.
{
  const banned = ["persons", "conversations", "staff_threads"];
  for (const t of banned) {
    const hits = QUERIES.filter((q) =>
      new RegExp(`\\b(from|join)\\s+${t}\\b`, "i").test(stripComments(q.sql)));
    check(`${t} is never read`, hits.length === 0, hits.map((q) => q.key).join(", "));
  }
}

// ── 5. Every query declares the plan section that authorizes it. ──────
{
  const undeclared = QUERIES.filter((q) => !q.authority || !q.authority.trim());
  check(
    "every query names the plan section that authorizes it",
    undeclared.length === 0,
    undeclared.map((q) => q.key).join(", "));
}

// ── 6. Every query is deterministically ordered, or DECLARES one row. ─
//  An unordered multi-row result makes the receipt undiffable.
//
//  Row count is DECLARED (`singleRow: true`), not inferred from the SQL.
//  An earlier version of this check guessed by pattern — "an aggregate with
//  no GROUP BY" — and it was wrong about B2, whose GROUP BY sits in a
//  subquery under a top-level count. Guessing the shape of SQL with a regex
//  is how a test ends up asserting something other than what it claims.
{
  const unordered = QUERIES.filter(
    (q) => !q.singleRow && !/order\s+by/i.test(stripComments(q.sql)));
  check(
    "every multi-row query carries an ORDER BY (receipts stay diffable)",
    unordered.length === 0,
    unordered.map((q) => q.key).join(", "));

  //  And the declaration must be honest: a query claiming one row must not
  //  contain a top-level GROUP BY, which would produce many.
  const lying = QUERIES.filter((q) => {
    if (!q.singleRow) return false;
    //  Strip parenthesised subqueries before looking for a GROUP BY, so a
    //  subquery's grouping is not mistaken for the outer statement's.
    let s = stripComments(q.sql);
    let prev;
    do { prev = s; s = s.replace(/\([^()]*\)/g, " "); } while (s !== prev);
    return /group\s+by/i.test(s);
  });
  check(
    "every singleRow declaration is honest (no top-level GROUP BY)",
    lying.length === 0,
    lying.map((q) => q.key).join(", "));
}

// ── 7. The tool never writes. No DML/DDL verbs outside the probe. ─────
{
  const src = fs.readFileSync(TOOL_PATH, "utf8");
  //  The write probe is the one intentional write attempt, and it is the
  //  thing being proven, so it is excluded by name rather than by pattern.
  const withoutProbe = src.replace(
    /create temporary table __release0_audit_write_probe \(x int\)/g, " __probe__ ");
  //  Strip comments with the SAME stripper used on the SQL. A line-prefix
  //  filter misses continuation lines inside a /* */ block — which is how
  //  the word "commit" in this file's own header once failed this check.
  //  The prose is documentation; only executable code is under test.
  const inCode = stripComments(withoutProbe);
  const verbs = ["insert into", "update", "delete from", "drop", "alter", "truncate", "commit"];
  const found = verbs.filter((v) =>
    new RegExp(`\\b${v.replace(/ /g, "\\s+")}\\b`, "i").test(inCode));
  check(
    "the tool source contains no write verb outside the write probe",
    found.length === 0,
    found.join(", "));
}

// ── 8. The withheld conclusions are shipped, not just documented. ─────
//  §19 reserves these to the owner. If they stop being emitted, a receipt
//  reads as a verdict on questions the audit is not allowed to answer.
{
  const { WITHHELD_CONCLUSIONS } = require(TOOL_PATH);
  check(
    "the tool ships its withheld-conclusions list",
    Array.isArray(WITHHELD_CONCLUSIONS) && WITHHELD_CONCLUSIONS.length >= 4,
    `got ${WITHHELD_CONCLUSIONS && WITHHELD_CONCLUSIONS.length}`);
  check(
    "the activation boundary is named as a withheld conclusion",
    WITHHELD_CONCLUSIONS.some((w) => /activation boundary/i.test(w)),
    "Ruling 1 forbids deriving it from production data");
}

console.log(`\n  ${passes} passed · ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
