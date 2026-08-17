"use strict";

const REQUIRED_LEDGER_CEILING = "176";

const REQUIRED_TABLES = Object.freeze([
  "meeting_evidence_meetings",
  "transcript_versions",
  "transcript_segments",
  "meeting_speaker_resolutions",
  "meeting_extraction_runs",
  "meeting_interpretation_candidates",
  "candidate_support",
  "candidate_quotes",
  "candidate_branches",
  "candidate_measurements",
  "meeting_receipts",
  "meeting_receipt_items",
  "meeting_receipt_candidate_reviews",
  "meeting_receipt_missed_items",
  "meeting_receipt_manual_edit_deltas",
]);

function numericVersion(value) {
  const n = Number.parseInt(String(value || "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function releaseReadinessSql() {
  const tableSelects = REQUIRED_TABLES
    .map((table) => `to_regclass('public.${table}') is not null as has_${table}`)
    .join(",\n  ");
  return `select
  (select max(version) from schema_migrations) as ledger_ceiling,
  (select count(*)::int from schema_migrations) as migration_count,
  ${tableSelects};`;
}

function evaluateReleaseReadiness(row, {
  requiredLedgerCeiling = REQUIRED_LEDGER_CEILING,
  requiredTables = REQUIRED_TABLES,
} = {}) {
  const ceiling = numericVersion(row && row.ledger_ceiling);
  const required = numericVersion(requiredLedgerCeiling);
  const missingTables = [];
  for (const table of requiredTables) {
    if (!row || row[`has_${table}`] !== true) missingTables.push(table);
  }
  const problems = [];
  if (ceiling === null) {
    problems.push("schema_migrations has no readable ceiling");
  } else if (required !== null && ceiling < required) {
    problems.push(`ledger ceiling ${row.ledger_ceiling} is below required ${requiredLedgerCeiling}`);
  }
  if (missingTables.length) {
    problems.push(`missing required meeting receipt tables: ${missingTables.join(", ")}`);
  }
  return {
    ok: problems.length === 0,
    required_ledger_ceiling: requiredLedgerCeiling,
    ledger_ceiling: row ? row.ledger_ceiling : null,
    migration_count: row ? row.migration_count : null,
    missing_tables: missingTables,
    problems,
  };
}

module.exports = {
  REQUIRED_LEDGER_CEILING,
  REQUIRED_TABLES,
  evaluateReleaseReadiness,
  releaseReadinessSql,
};
