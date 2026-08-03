#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   application_milestone_baseline.js — the Deployment A/B exception receipt.

   Migration 125 deliberately refuses FUTURE bad writes without manufacturing
   missing historical milestones. That is correct, and it creates a blind spot:
   a defective row written during the rolling window would land in the same
   "milestone is null" population as the legitimate historical exceptions, and
   then survive enforcement unnoticed forever.

   This tool closes that. Run it immediately after 124 applies to capture the
   exception population, and again before 125 to prove the population has NOT
   GROWN. Existing exceptions may remain or shrink. A new id is a defect.

   The digest is over the SORTED id list, so the receipt is comparable across
   runs and machines and cannot be quietly reordered into agreement.

     node tools/application_milestone_baseline.js --capture > baseline.json
     node tools/application_milestone_baseline.js --verify baseline.json

   Requires DATABASE_URL.
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const SUBMISSION_REACHED = ["submitted", "approved", "lease_ready", "tenant_signed",
  "countersigned", "accepted_term_required", "active"];
const APPROVAL_REACHED = ["approved", "lease_ready", "tenant_signed",
  "countersigned", "accepted_term_required", "active"];
const TERMINAL = ["declined", "withdrawn", "expired"];

// The last two MUST be empty at every capture. They are not "historical
// exceptions" — they are states no correct writer can produce, so a non-zero
// count is a defect whenever it appears.
const CATEGORIES = [
  { key: "submission_reached_without_submitted_at", must_be_zero: false,
    sql: `select id from lease_applications where status = any($1) and submitted_at is null`,
    params: [SUBMISSION_REACHED] },
  { key: "approval_reached_without_approved_at", must_be_zero: false,
    sql: `select id from lease_applications where status = any($1) and approved_at is null`,
    params: [APPROVAL_REACHED] },
  { key: "terminal_without_terminal_metadata", must_be_zero: false,
    sql: `select id from lease_applications where status = any($1)
            and (terminal_at is null or terminal_code is null)`,
    params: [TERMINAL] },
  // Terminal rows are EXCLUDED from both of these. A withdrawn application
  // may legitimately preserve a prior approval milestone — going terminal
  // never erases history that was authored while the row was progressive.
  { key: "pre_submission_status_carrying_submitted_at", must_be_zero: true,
    sql: `select id from lease_applications
           where submitted_at is not null
             and not (status = any($1)) and not (status = any($2))`,
    params: [SUBMISSION_REACHED, TERMINAL] },
  { key: "pre_approval_status_carrying_approved_at", must_be_zero: true,
    sql: `select id from lease_applications
           where approved_at is not null
             and not (status = any($1)) and not (status = any($2))`,
    params: [APPROVAL_REACHED, TERMINAL] },
  { key: "terminal_code_mismatched", must_be_zero: true,
    sql: `select id from lease_applications
           where terminal_code is not null and terminal_code <> status`,
    params: [] },
  { key: "nonterminal_carrying_terminal_metadata", must_be_zero: true,
    sql: `select id from lease_applications
           where not (status = any($1)) and (terminal_at is not null or terminal_code is not null)`,
    params: [TERMINAL] },
];

const digest = (ids) => crypto.createHash("sha256").update(ids.join("\n")).digest("hex");

async function capture(pool) {
  const categories = {};
  for (const c of CATEGORIES) {
    const ids = (await pool.query(c.sql + " order by id", c.params)).rows.map((r) => String(r.id));
    categories[c.key] = {
      count: ids.length,
      sha256_of_sorted_ids: digest(ids),
      must_be_zero: c.must_be_zero,
      ids,
    };
  }

  // Which migration state this receipt describes. A baseline captured against
  // the wrong migration version proves nothing.
  let migration = null;
  try {
    const r = await pool.query(
      `select version, name, applied_at from schema_migrations
        where version::text like '124%' or name like '124%' order by applied_at desc limit 1`);
    migration = r.rows[0] || null;
  } catch (_) { migration = null; }

  const enforcementPresent = (await pool.query(
    `select count(*)::int n from pg_trigger where tgname='trg_application_authors_milestones'`)).rows[0].n > 0;
  const compatPresent = (await pool.query(
    `select count(*)::int n from pg_trigger where tgname='trg_app_compat_author_milestones'`)).rows[0].n > 0;

  return {
    receipt_version: "application_milestone_baseline_v1",
    captured_at: new Date().toISOString(),
    migration_124: migration
      ? { version: String(migration.version), name: migration.name, applied_at: migration.applied_at }
      : { version: null, name: null, applied_at: null, note: "124 not found in schema_migrations" },
    triggers: {
      compatibility_authoring_present: compatPresent,   // expected true on Deployment A
      strict_enforcement_present: enforcementPresent,   // expected false until Deployment B
    },
    total_applications: (await pool.query("select count(*)::int n from lease_applications")).rows[0].n,
    categories,
  };
}

// ── DEPLOYMENT-PHASE GATE ───────────────────────────────────────────
//  A receipt captured in the wrong phase proves nothing. Recording the phase
//  in a note and continuing is how a baseline taken AFTER enforcement — when
//  the population can no longer grow — gets mistaken for one taken before it.
function phaseProblems(receipt, phase) {
  const p = [];
  const m = receipt.migration_124 || {};
  if (!m.version || !m.applied_at) {
    p.push("migration 124 is not recorded as applied in schema_migrations");
  }
  if (!receipt.triggers.compatibility_authoring_present) {
    p.push("the 124 compatibility trigger is absent — this is not Deployment A");
  }
  if (receipt.triggers.strict_enforcement_present) {
    p.push("strict 125 enforcement is already present — the pre-B window has closed");
  }
  return p.map((detail) => ({ category: `deployment_phase_${phase}`, severity: "blocker", detail, ids: [] }));
}

// ── RECEIPT INTEGRITY ───────────────────────────────────────────────
//  A baseline is a security artifact for Deployment B. Trusting its stored
//  counts and digests without recomputing them lets a hand-edited file widen
//  the accepted population.
function receiptProblems(baseline) {
  const p = [];
  if (baseline.receipt_version !== "application_milestone_baseline_v1") {
    p.push(`unexpected receipt_version: ${baseline.receipt_version}`);
  }
  if (!baseline.migration_124 || !baseline.migration_124.applied_at) {
    p.push("baseline carries no migration 124 identity");
  }
  for (const c of CATEGORIES) {
    const b = baseline.categories && baseline.categories[c.key];
    if (!b) { p.push(`baseline is missing category ${c.key}`); continue; }
    if (!Array.isArray(b.ids)) { p.push(`${c.key}: ids is not an array`); continue; }
    if (b.count !== b.ids.length) p.push(`${c.key}: stored count ${b.count} != ${b.ids.length} ids`);
    const sorted = [...b.ids].sort();
    if (sorted.join(",") !== b.ids.join(",")) p.push(`${c.key}: ids are not sorted`);
    if (new Set(b.ids).size !== b.ids.length) p.push(`${c.key}: ids contain duplicates`);
    if (digest(b.ids) !== b.sha256_of_sorted_ids) p.push(`${c.key}: digest does not reconcile with ids`);
  }
  return p.map((detail) => ({ category: "receipt_integrity", severity: "blocker", detail, ids: [] }));
}

function verify(baseline, current) {
  const problems = [];
  for (const c of CATEGORIES) {
    const b = baseline.categories[c.key] || { ids: [], count: 0 };
    const n = current.categories[c.key];

    if (c.must_be_zero && n.count !== 0) {
      problems.push({
        category: c.key, severity: "blocker",
        detail: `must be zero, found ${n.count}`,
        ids: n.ids.slice(0, 20),
      });
      continue;
    }

    // THE RULE: the population may shrink, never grow. A new id means a
    // rollout-window write produced a truth gap that would otherwise hide
    // among the legitimate historical exceptions.
    const known = new Set(b.ids);
    const added = n.ids.filter((id) => !known.has(id));
    if (added.length) {
      problems.push({
        category: c.key, severity: "blocker",
        detail: `${added.length} id(s) appeared after the baseline — a rollout-window write lost a milestone`,
        ids: added.slice(0, 20),
      });
    }
  }
  return problems;
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required."); process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const mode = process.argv[2];

  try {
    if (mode === "--capture") {
      const receipt = await capture(pool);
      const zeroViolations = CATEGORIES.filter((c) => c.must_be_zero)
        .filter((c) => receipt.categories[c.key].count !== 0);
      const phase = phaseProblems(receipt, "capture");
      process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
      if (phase.length) {
        console.error("\nBLOCKER — wrong deployment phase for a capture:");
        for (const x of phase) console.error(`  ${x.detail}`);
        process.exit(1);
      }
      if (zeroViolations.length) {
        console.error(`\nBLOCKER: ${zeroViolations.map((c) => c.key).join(", ")} must be zero at capture time.`);
        process.exit(1);
      }
      process.exit(0);
    }

    if (mode === "--verify") {
      const path = process.argv[3];
      if (!path) { console.error("usage: --verify <baseline.json>"); process.exit(1); }
      const baseline = JSON.parse(fs.readFileSync(path, "utf8"));
      const current = await capture(pool);
      const problems = [
        ...receiptProblems(baseline),
        ...phaseProblems(current, "verify"),
        ...verify(baseline, current),
      ];

      console.log("── application milestone baseline verification ──");
      console.log(`baseline captured_at : ${baseline.captured_at}`);
      console.log(`current  captured_at : ${current.captured_at}`);
      for (const c of CATEGORIES) {
        const b = baseline.categories[c.key] || { count: 0 };
        const n = current.categories[c.key];
        const delta = n.count - b.count;
        console.log(`  ${c.key.padEnd(42)} ${String(b.count).padStart(5)} → ${String(n.count).padStart(5)}  (${delta > 0 ? "+" : ""}${delta})`);
      }
      if (problems.length) {
        console.log("\nBLOCKERS:");
        for (const p of problems) console.log(`  [${p.severity}] ${p.category}: ${p.detail}\n    ${p.ids.join(", ")}`);
        console.log("\nDeployment B is BLOCKED. The exception population grew.\n");
        process.exit(1);
      }
      console.log("\nException population did not grow. Deployment B gate: PASS.\n");
      process.exit(0);
    }

    console.error("usage: --capture | --verify <baseline.json>");
    process.exit(1);
  } finally { await pool.end().catch(() => {}); }
})().catch((e) => { console.error("baseline tool failed:", e.message); process.exit(1); });
