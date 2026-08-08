/* ════════════════════════════════════════════════════════════════════
   CONSTRUCTING A STATE THE GUARD EXISTS TO PREVENT

   Migration 140 makes several states unrepresentable after activation:
   terminal-without-evaluation, terminal-with-a-failed-evaluation, and a
   re-terminalized legacy row. And `recordActivation` now REFUSES to
   activate at all unless the guard is installed — detecting a missing
   guard after the fact is useless when the activation is irreversible.

   Both are correct, and together they mean a proof harness cannot simply
   avoid the migration: activating requires it. So a harness that needs to
   EXHIBIT a forbidden state — the reader's `missing_evaluation_defect`,
   the sweep's population, a hollow completion — has to turn the guard off
   deliberately, in the open, for the length of that construction.

   ── THAT IS A FEATURE OF THE PROOFS, NOT A HOLE ─────────────────────

   Every use of this helper is a line that says, in the harness itself:
   THIS STATE CANNOT BE CREATED WHILE THE GUARD IS INSTALLED. Reading the
   call sites is the shortest honest summary of what migration 140
   actually prevents.

   It restores by RE-APPLYING THE MIGRATION rather than by re-issuing
   remembered DDL, so a drifted copy of the trigger definition cannot be
   what gets put back.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATION = path.join(__dirname, "..", "..",
  "migrations", "140_post_activation_completion_guard.sql");

const TRIGGERS = [
  ["assert_completion_truth_ins", "work_orders"],
  ["assert_completion_truth_upd", "work_orders"],
  ["assert_completion_truth_eval", "work_order_proof_evaluations"],
];

/** Apply migration 140. Idempotent — it drops and recreates. */
async function installGuard(db) {
  await db.query(fs.readFileSync(MIGRATION, "utf8"));
}

/**
 * Run `fn` with the containment triggers removed, then put them back by
 * re-applying the migration.
 *
 * The restore runs in `finally`, so a throw inside `fn` cannot leave a
 * harness running against an unguarded database — which would make every
 * later assertion in that file meaningless without saying so.
 */
async function withGuardOff(db, why, fn) {
  if (!why) throw new Error("withGuardOff requires a reason — an undocumented " +
    "guard-off window is indistinguishable from a bypass");
  for (const [name, table] of TRIGGERS) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(`drop trigger if exists ${name} on public.${table}`);
  }
  try {
    return await fn();
  } finally {
    await installGuard(db);
  }
}

/** Is the guard currently installed, in full? */
async function guardInstalled(db) {
  const n = Number((await db.query(
    `select count(*) n from pg_trigger t join pg_class k on k.oid = t.tgrelid
      where not t.tgisinternal and t.tgname = any($1::text[])`,
    [TRIGGERS.map((t) => t[0])])).rows[0].n);
  return n === TRIGGERS.length;
}

module.exports = { installGuard, withGuardOff, guardInstalled, MIGRATION, TRIGGERS };
