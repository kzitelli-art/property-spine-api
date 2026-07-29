// ════════════════════════════════════════════════════════════════════
//  baseline_analysis.js — WHAT THE RESTORED DATABASE ACTUALLY SAYS
//
//  PURE. Catalog readings in, findings out. No database handle, no network,
//  no clock. `verify-baseline.js` does the reading; this file does the
//  thinking, which is why the thinking can be tested against synthetic
//  readings instead of against a manufactured copy of the real schema.
//
//  ── IT NEVER REPAIRS ANYTHING ───────────────────────────────────────
//  Every function here returns findings. None of them returns a fix, and
//  nothing downstream is permitted to apply one automatically. A ledger that
//  disagrees with the objects in the database is a fact about a real system
//  somebody operates; guessing which side is wrong and silently correcting it
//  is how a baseline stops describing the thing it was taken from.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  ── THE BUILD 1-5 MIGRATIONS ──────────────────────────────────────
//
//  For each one: the number, the label the runner records, and the objects
//  that must exist if it really ran. `tables` are the ones it creates
//  outright; `columns` are the ones it adds to a table an earlier migration
//  created — a migration that only ALTERs leaves no new table to look for, so
//  its added columns are its signature.
//
//  Read off the migration files at the infrastructure-discovery checkpoint,
//  plus the closure slice's 118. The kit tracks what the PRODUCT branch
//  contains; it does not carry the migration itself.
//  If a migration file changes, this list must change with it; the verifier
//  cross-checks the numbers against the folder so a divergence is visible.
const BUILD_MIGRATIONS = Object.freeze([
  {
    version: "112", label: "unit_triage_capture", build: "BUILD 1",
    tables: ["unit_observations", "unit_triage_confirmations", "unit_triage_findings", "unit_triage_required_work"],
    columns: [],
  },
  {
    version: "113", label: "unit_turn_scope", build: "BUILD 2",
    tables: ["unit_turn_scopes", "unit_turn_appliances"],
    columns: [
      ["unit_triage_required_work", "stage"],
      ["unit_triage_required_work", "turn_scope_id"],
      ["unit_triage_required_work", "disturbs_painted_surfaces"],
    ],
  },
  {
    version: "114", label: "inherited_work_stage_decision", build: "BUILD 2",
    tables: [],
    columns: [
      ["unit_triage_required_work", "stage_decision_required"],
      ["unit_triage_required_work", "stage_decision_note"],
    ],
  },
  {
    version: "115", label: "work_acceptance_and_proof", build: "BUILD 3",
    tables: ["work_acceptances", "work_completion_claims", "work_reopenings"],
    columns: [],
  },
  {
    version: "116", label: "readiness_certification", build: "BUILD 4",
    tables: ["unit_readiness_walks", "unit_readiness_certifications", "reclean_rulings"],
    columns: [["unit_triage_required_work", "readiness_walk_id"]],
  },
  {
    version: "117", label: "staff_agent_capture", build: "BUILD 5",
    tables: ["staff_agent_threads", "staff_agent_messages", "staff_agent_proposals"],
    columns: [],
  },
  {
    //  The unit-turn CLOSURE SLICE: one completion photo, tied to one work
    //  item. Its number is PROVISIONAL in the product branch — it is 118 only
    //  if the live ledger's ceiling really is 117. That is exactly what this
    //  verifier establishes, and a collision at 118 is reported like any other
    //  rather than worked around.
    version: "118", label: "work_proof_attachments", build: "CLOSURE SLICE",
    tables: ["work_proof_attachments"],
    columns: [],
  },
]);

//  ── FOUNDATIONS THE BUILD MIGRATIONS STAND ON ─────────────────────
//  Not an inventory of the whole schema. These are the objects 112-117
//  reference directly — a foreign key, a lookup, a session. If one is
//  missing, the baseline is not a baseline these migrations can be applied to,
//  and that must be said before anything is run rather than discovered as a
//  constraint error halfway through.
const REQUIRED_FOUNDATIONS = Object.freeze([
  { table: "properties", columns: ["id"] },
  { table: "units", columns: ["id", "property_id"] },
  { table: "spaces", columns: ["id"] },
  { table: "leases", columns: ["id"] },
  { table: "users", columns: ["id"] },
  { table: "persons", columns: ["id"] },
  { table: "property_team_assignments", columns: ["property_id", "user_id"] },
  { table: "staff_sessions", columns: ["id"] },
  { table: "unit_events", columns: ["id"] },
  { table: "events", columns: ["id"] },
  { table: "obligations", columns: ["id"] },
  { table: "turnovers", columns: ["id"] },
  { table: "schema_migrations", columns: ["version", "name"] },
]);

//  Extension functions and enum types the Build migrations use directly.
//  `gen_random_uuid()` is the default on every primary key they create, so its
//  absence is a hard stop rather than a curiosity.
const REQUIRED_ROUTINES = Object.freeze(["gen_random_uuid"]);

// ════════════════════════════════════════════════════════════════════
//  1. THE LEDGER ITSELF
// ════════════════════════════════════════════════════════════════════
/**
 * analyseLedger — rows: [{version, name}]
 */
function analyseLedger(rows) {
  const list = (rows || []).map((r) => ({
    version: String(r.version), name: r.name == null ? null : String(r.name),
  }));
  const versions = list.map((r) => r.version);

  const seen = new Map();
  const duplicates = [];
  for (const v of versions) {
    if (seen.has(v)) duplicates.push(v); else seen.set(v, true);
  }

  //  Gaps are reported, never "fixed". A gap can be entirely legitimate — a
  //  migration withdrawn before it ever ran leaves one — so this is
  //  information for a human, not a verdict.
  const numeric = versions
    .filter((v) => /^\d+$/.test(v)).map(Number).sort((a, b) => a - b);
  const gaps = [];
  if (numeric.length) {
    for (let n = numeric[0]; n < numeric[numeric.length - 1]; n++) {
      if (!numeric.includes(n)) gaps.push(String(n).padStart(3, "0"));
    }
  }

  const sorted = versions.slice().sort();
  return {
    count: list.length,
    versions,
    highest: sorted.length ? sorted[sorted.length - 1] : null,
    duplicates: [...new Set(duplicates)],
    gaps,
    rows: list,
  };
}

// ════════════════════════════════════════════════════════════════════
//  2. FOUNDATIONS
// ════════════════════════════════════════════════════════════════════
/**
 * analyseFoundations
 *   columnsByTable: { table_name: [column_name, ...] }
 *   routines:       [routine_name, ...]
 */
function analyseFoundations(columnsByTable, routines) {
  const have = columnsByTable || {};
  const rout = new Set((routines || []).map((r) => String(r).toLowerCase()));

  const tables = REQUIRED_FOUNDATIONS.map((f) => {
    const cols = have[f.table];
    if (!cols) return { table: f.table, present: false, missing_columns: f.columns };
    const set = new Set(cols.map((c) => String(c).toLowerCase()));
    const missing = f.columns.filter((c) => !set.has(c.toLowerCase()));
    return { table: f.table, present: true, missing_columns: missing };
  });

  const missingRoutines = REQUIRED_ROUTINES.filter((r) => !rout.has(r.toLowerCase()));

  return {
    tables,
    missing_tables: tables.filter((t) => !t.present).map((t) => t.table),
    tables_missing_columns: tables.filter((t) => t.present && t.missing_columns.length)
      .map((t) => ({ table: t.table, missing: t.missing_columns })),
    missing_routines: missingRoutines,
    satisfied: tables.every((t) => t.present && t.missing_columns.length === 0) &&
               missingRoutines.length === 0,
  };
}

// ════════════════════════════════════════════════════════════════════
//  3. LEDGER-TO-OBJECT AGREEMENT FOR 112-117
// ════════════════════════════════════════════════════════════════════
//
//  Four verdicts, and the two in the middle are the reason this file exists:
//
//    applied_and_recorded  the ledger says it ran and its objects are there
//    pending               neither — this migration has simply not run yet
//    objects_without_ledger  the objects exist but the ledger does not say so.
//                          The runner keys on the number alone, so it would
//                          try to run this migration again.
//    recorded_without_objects  the ledger says it ran and its objects are
//                          absent. The runner would skip it forever, and the
//                          tables it promised would never exist.
//
//  Both mismatches are silent failures in opposite directions, and NEITHER is
//  repaired here.
function analyseBuildMigrations({ ledgerRows = [], tables = [], columnsByTable = {} } = {}) {
  const ledger = new Map((ledgerRows || []).map((r) => [String(r.version), r.name == null ? null : String(r.name)]));
  const tableSet = new Set((tables || []).map((t) => String(t).toLowerCase()));
  const colSet = (t) => new Set(((columnsByTable || {})[t] || []).map((c) => String(c).toLowerCase()));

  const results = BUILD_MIGRATIONS.map((m) => {
    const recorded = ledger.has(m.version);
    const recorded_name = recorded ? ledger.get(m.version) : null;

    const missingTables = m.tables.filter((t) => !tableSet.has(t.toLowerCase()));
    const missingColumns = m.columns
      .filter(([t, c]) => !colSet(t).has(c.toLowerCase()))
      .map(([t, c]) => `${t}.${c}`);

    const expected = m.tables.length + m.columns.length;
    const missing = missingTables.length + missingColumns.length;
    const objects_present = expected > 0 && missing === 0;
    const objects_absent = missing === expected;

    let verdict;
    if (recorded && objects_present) verdict = "applied_and_recorded";
    else if (recorded && !objects_present) verdict = "recorded_without_objects";
    else if (!recorded && objects_absent) verdict = "pending";
    else if (!recorded && objects_present) verdict = "objects_without_ledger";
    else verdict = "partial_objects_without_ledger";

    //  The runner normalises a recorded name before comparing it with a
    //  filename, so a label mismatch is reported here the same way — as a
    //  fact, not a failure.
    const name_matches = !recorded || normaliseName(recorded_name) === normaliseName(m.label);

    return {
      version: m.version, build: m.build, expected_label: m.label,
      recorded, recorded_name, name_matches,
      objects_present, missing_tables: missingTables, missing_columns: missingColumns,
      verdict,
    };
  });

  const mismatches = results.filter((r) =>
    r.verdict === "recorded_without_objects" ||
    r.verdict === "objects_without_ledger" ||
    r.verdict === "partial_objects_without_ledger");

  return {
    migrations: results,
    pending: results.filter((r) => r.verdict === "pending").map((r) => r.version),
    applied: results.filter((r) => r.verdict === "applied_and_recorded").map((r) => r.version),
    mismatches,
    agrees: mismatches.length === 0,
  };
}

//  Same normalisation the repository's migration runner uses, so this reports
//  what the runner will actually conclude rather than a stricter opinion.
function normaliseName(s) {
  return String(s || "")
    .replace(/\.sql$/i, "")
    .replace(/^\d{3}_/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim().toLowerCase();
}

// ════════════════════════════════════════════════════════════════════
//  4. NUMBER COLLISIONS
// ════════════════════════════════════════════════════════════════════
//
//  Two shapes, both of which make a migration silently never run:
//
//    · two files in the folder sharing a number
//    · a file whose number the ledger already spent on a different migration
//
//  The second is the one that matters for 112-117 on a real baseline: if
//  something else already occupies 114, the Build 2 migration would print
//  "already applied" and its columns would never exist.
function analyseCollisions({ ledgerRows = [], migrationFiles = [] } = {}) {
  const files = (migrationFiles || [])
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_"))
    .map((f) => ({ file: f, version: f.slice(0, 3), label: f.slice(4, -4) }));

  const byVersion = new Map();
  const duplicate_files = [];
  for (const f of files) {
    if (byVersion.has(f.version)) duplicate_files.push({ version: f.version, files: [byVersion.get(f.version).file, f.file] });
    else byVersion.set(f.version, f);
  }

  const ledger = new Map((ledgerRows || []).map((r) => [String(r.version), r.name == null ? null : String(r.name)]));
  const number_already_spent = [];
  for (const f of files) {
    if (!ledger.has(f.version)) continue;
    if (normaliseName(ledger.get(f.version)) !== normaliseName(f.label)) {
      number_already_spent.push({
        version: f.version,
        ledger_says: ledger.get(f.version),
        folder_has: f.file,
        consequence: "the runner would print 'already applied' and this file would never run",
      });
    }
  }

  const buildVersions = BUILD_MIGRATIONS.map((m) => m.version);
  return {
    duplicate_files,
    number_already_spent,
    // Scoped answer: does anything collide with 112-117 specifically?
    build_collisions: number_already_spent.filter((c) => buildVersions.includes(c.version))
      .concat(duplicate_files.filter((d) => buildVersions.includes(d.version))),
    clean: duplicate_files.length === 0 && number_already_spent.length === 0,
  };
}

// ════════════════════════════════════════════════════════════════════
//  5. WHAT WOULD ACTUALLY RUN
// ════════════════════════════════════════════════════════════════════
//
//  The repository's runner applies EVERY pending migration in the folder, not
//  a chosen subset. So "apply the Build migrations" is only a safe request
//  when the Build migrations are the only pending ones. If anything earlier is
//  also pending, the runner would reach into the historical chain — which this
//  kit does not repair and must not trigger.
function analysePendingApplication({ ledgerRows = [], migrationFiles = [] } = {}) {
  const applied = new Set((ledgerRows || []).map((r) => String(r.version)));
  const files = (migrationFiles || [])
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_"))
    .sort();

  const pending = files.filter((f) => !applied.has(f.slice(0, 3)));
  const buildVersions = new Set(BUILD_MIGRATIONS.map((m) => m.version));
  const pending_build = pending.filter((f) => buildVersions.has(f.slice(0, 3)));
  const pending_other = pending.filter((f) => !buildVersions.has(f.slice(0, 3)));

  return {
    pending, pending_build, pending_other,
    safe_to_run: pending.length > 0 && pending_other.length === 0,
    reason: pending.length === 0
      ? "Nothing is pending. Every migration in the folder is already recorded in the ledger."
      : pending_other.length
        ? `The repository's runner applies EVERY pending migration, and ${pending_other.length} pending ` +
          `migration(s) are outside Builds 1-5: ${pending_other.join(", ")}. Running it would reach into ` +
          `the historical chain, which this kit does not repair.`
        : "Only Build 1-5 migrations are pending, so the repository's runner would apply exactly those.",
  };
}

module.exports = {
  analyseLedger, analyseFoundations, analyseBuildMigrations,
  analyseCollisions, analysePendingApplication, normaliseName,
  BUILD_MIGRATIONS, REQUIRED_FOUNDATIONS, REQUIRED_ROUTINES,
};
