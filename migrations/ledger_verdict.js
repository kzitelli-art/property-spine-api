/* ════════════════════════════════════════════════════════════════════
   ledger_verdict.js — the DECISION, separated from the doing.

   migrate.js connects, prints and exits. This file decides. It is pure:
   no database, no filesystem, no process.exit, no console. Give it the
   list of migration files and the ledger rows; it returns a verdict.

   WHY IT IS ITS OWN FILE. A gate that has never executed is a claim, not
   a control. This logic stops production deploys, so it has to be
   exercised directly rather than inferred from the behaviour of the
   script that wraps it — and it must be exercised as the SAME code the
   deploy runs, not a copy of it. tests/_engine.js is the standing
   counter-example: a hand-maintained duplicate of one rule that drifted
   in three places, all permissive, and every harness importing it
   asserted against an engine more forgiving than production.

   So: one implementation. migrate.js imports it. The harness imports it.
   They cannot disagree, because there is nothing to disagree with.

   ── THE TWO DIRECTIONS ───────────────────────────────────────────────

   A ledger and a folder of files can disagree in two ways, and until
   2026-08-03 this system checked only one of them:

     repo file  →  must be in the ledger      (checked since ITEM 5)
     ledger row →  must have its repo file    (NOT checked — added here)

   The first direction protects the RUNTIME: new code against an older
   schema is a live correctness hazard, so it refuses to start.

   The second protects the TRUTH. A ledger row whose file the repository
   has forgotten means the database contains a change nothing in this
   codebase can describe. Nobody can rebuild it, nobody can review it,
   and the next contributor allocating a migration number cannot see that
   the number is spent. That is a reconstruction problem — exactly the
   class of uncertainty this product exists to eliminate — and it is how
   "the migration GAP at 121" sat in the handoff as a curiosity for weeks
   while being the visible symptom of a deploy silently migrating
   production.

   Both directions therefore refuse. Neither warns.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/*  Versions that live in the ledger but deliberately have no tracked file.
 *
 *  This is SYMMETRY with the file scan, not an ignore list. migrate.js
 *  excludes 000_schema_migrations.sql because the ledger table is created
 *  directly rather than applied as a migration; a 000 row (some databases
 *  have one from before that was settled) is that same decision seen from
 *  the ledger side. Any other version must have its file. */
const UNTRACKED_VERSIONS = new Set(["000"]);

/*  DOCUMENTED LEGACY NAMING EXCEPTIONS.
 *
 *  A ledger row and its file share a number but not a name, and it has
 *  been checked by a human who confirmed they are the same migration.
 *
 *  Pinned on BOTH the version AND the exact ledger name it forgives. If a
 *  different migration ever occupies that number, the exception stops
 *  matching and the gate fires — which is the difference between a
 *  documented exception and a hole. */
const LEGACY_LEDGER_NAMES = [
  {
    version: "012",
    ledgerName: "property_noi_goals",
    fileName: "bank_intake",
    /*  Verified 2026-07-26 against the live database. property_noi_goals
     *  was renumbered to 029 and the 012 row was never corrected;
     *  bank_intake DID run — vendors 51 rows, vendor_aliases 121,
     *  bank_accounts 2, bank_transactions 160, check_register_orphans 4.
     *  Nothing is missing, so blocking every deploy over a stale label
     *  would be the guard lying about a problem instead of the ledger
     *  lying about a name. */
    reason: "ledger row never corrected after property_noi_goals was renumbered to 029; bank_intake verified applied",
    removeWhen: "the 012 ledger row is corrected to 'bank_intake'",
  },
];

/*  DOCUMENTED LEDGER-ONLY MIGRATIONS.
 *
 *  A version recorded as applied whose file this repository does not
 *  carry, which a human has inspected and accepted as historical.
 *
 *  DELIBERATELY EMPTY. It is populated only from a read of the actual
 *  production ledger, one entry at a time, each naming what the version
 *  is, why the file is absent, and what removes the entry. It is not a
 *  range, not a pattern, and not configurable from the environment — a
 *  broad ignore mechanism here would hide exactly the drift the inverse
 *  check exists to surface.
 *
 *  Same double pin as above: version AND expected ledger name. */
const DOCUMENTED_LEDGER_ONLY = [
  // (none — see docs/MIGRATION_LEDGER_INVERSE_GATE.md before adding one)
];

/*  Ledger names have been recorded by hand and by browsers over the years.
 *  Normalise before comparing, so a messier spelling of the SAME migration
 *  is not reported as a different one:
 *    062/063/064  'pricing_authority (1)'                    — download duplicate
 *    083/084      '084_application_intent_prepare_send.sql'  — whole filename
 *  A genuinely different migration still trips the guard. */
function normalizeName(s) {
  return String(s == null ? "" : s)
    .replace(/\.sql$/i, "")
    .replace(/^\d{3}_/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim()
    .toLowerCase();
}

function versionOf(file) {
  return file.slice(0, 3);
}
function labelOf(file) {
  return file.slice(4, -4);
}

/*  classifyLedger — the whole decision, as data.
 *
 *  files       : ['001_baseline.sql', ...]  already filtered to NNN_*.sql, no 000_
 *  ledgerRows  : [{ version: '001', name: 'baseline' }, ...]
 *
 *  Returns every finding separately, so the caller can NAME each one
 *  rather than collapsing them into a single "mismatch". They are
 *  genuinely different problems with genuinely different repairs. */
function classifyLedger({ files = [], ledgerRows = [], legacyNames, ledgerOnly } = {}) {
  const legacy = legacyNames || LEGACY_LEDGER_NAMES;
  const orphansAllowed = ledgerOnly || DOCUMENTED_LEDGER_ONLY;

  const ledger = new Map();
  for (const row of ledgerRows) ledger.set(String(row.version), row.name);

  // ── 1. Two files sharing one number ────────────────────────────────
  //  The ledger is keyed on the number alone, so the second file would
  //  print "already applied" and never run. Checked first: while this is
  //  true, every other answer is unreliable.
  const seen = new Map();
  const duplicateFileNumbers = [];
  for (const f of files) {
    const v = versionOf(f);
    if (seen.has(v)) duplicateFileNumbers.push({ version: v, first: seen.get(v), second: f });
    else seen.set(v, f);
  }

  // ── 2. Version/name conflicts, and the legacy names we forgive ─────
  const versionNameConflicts = [];
  const acceptedLegacyNames = [];
  for (const f of files) {
    const v = versionOf(f);
    const fileLabel = labelOf(f);
    if (!ledger.has(v)) continue;
    const ledgerName = ledger.get(v);
    if (normalizeName(ledgerName) === normalizeName(fileLabel)) continue;

    const exception = legacy.find(
      (e) => e.version === v && normalizeName(e.ledgerName) === normalizeName(ledgerName)
    );
    if (exception) {
      acceptedLegacyNames.push({ version: v, ledgerName, file: f, reason: exception.reason, removeWhen: exception.removeWhen });
      continue;
    }
    versionNameConflicts.push({ version: v, ledgerName, fileLabel, file: f });
  }

  // ── 3. FORWARD: a repository file the ledger has never recorded ────
  //  New code against an older schema. Refuses to start.
  const fileMissingFromLedger = files.filter((f) => !ledger.has(versionOf(f)));

  // ── 4. INVERSE: a ledger version this repository cannot account for ─
  //  The database carries a change no file here describes.
  const filesByVersion = new Set(files.map(versionOf));
  const ledgerVersionMissingFromRepo = [];
  const acceptedLedgerOnly = [];
  for (const [version, name] of ledger) {
    if (UNTRACKED_VERSIONS.has(version)) continue;
    if (filesByVersion.has(version)) continue;

    const exception = orphansAllowed.find(
      (e) => e.version === version && normalizeName(e.ledgerName) === normalizeName(name)
    );
    if (exception) {
      acceptedLedgerOnly.push({ version, ledgerName: name, reason: exception.reason, removeWhen: exception.removeWhen });
      continue;
    }
    ledgerVersionMissingFromRepo.push({ version, ledgerName: name });
  }
  ledgerVersionMissingFromRepo.sort((a, b) => a.version.localeCompare(b.version));
  acceptedLedgerOnly.sort((a, b) => a.version.localeCompare(b.version));

  const ceiling = [...ledger.keys()].sort().pop() || "000";

  return {
    duplicateFileNumbers,
    versionNameConflicts,
    acceptedLegacyNames,
    fileMissingFromLedger,
    ledgerVersionMissingFromRepo,
    acceptedLedgerOnly,
    ceiling,
    /*  `structurallySound` covers only the things that are wrong no matter
     *  which mode we are in. Whether pending files are acceptable depends
     *  on verify vs release, so it is deliberately NOT folded in here. */
    structurallySound:
      duplicateFileNumbers.length === 0 &&
      versionNameConflicts.length === 0 &&
      ledgerVersionMissingFromRepo.length === 0,
  };
}

module.exports = {
  classifyLedger,
  normalizeName,
  UNTRACKED_VERSIONS,
  LEGACY_LEDGER_NAMES,
  DOCUMENTED_LEDGER_ONLY,
};
