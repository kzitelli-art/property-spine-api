// ════════════════════════════════════════════════════════════════════
//  migration_ledger_verdict.test.js — DB-FREE. Proves the DECISION the
//  migration gate makes, by exercising migrations/ledger_verdict.js
//  directly — the same module migrate.js imports, not a copy of it.
//
//  WHAT IS NEW HERE. The gate has always checked one direction:
//
//      repo file  →  must be recorded in the ledger
//
//  It never checked the other:
//
//      ledger row →  must still have its file in this repo
//
//  A ledger version with no file means the database holds a change this
//  codebase cannot describe: unrebuildable, unreviewed, and invisible to
//  the next person allocating a migration number. That is what "the
//  migration GAP at 121" actually was, and it sat in the handoff as a
//  curiosity for weeks.
//
//  These cases pin BOTH directions, and — the part that matters most —
//  pin that the documented exceptions cannot be widened by accident. An
//  exception matches only when the version AND the ledger name both
//  agree. Anything looser is a hole with a comment over it.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt");
const {
  classifyLedger,
  DOCUMENTED_LEDGER_ONLY,
  LEGACY_LEDGER_NAMES,
} = require("../migrations/ledger_verdict");

const HARNESS = __filename;
const EXPECTED = 30;
let passed = 0, failed = 0, ran = 0;

function ok(label, cond, detail) {
  ran++;
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
}

// Build ledger rows from a list of files, so "agrees" is never hand-typed.
const rowsFor = (files) => files.map((f) => ({ version: f.slice(0, 3), name: f.slice(4, -4) }));

receipt.begin(HARNESS, { expected: EXPECTED });

let code = 1;
try {
  const A = "101_alpha.sql", B = "102_bravo.sql", C = "103_charlie.sql";
  const THREE = [A, B, C];

  // ── 1. Agreement ───────────────────────────────────────────────────
  {
    const v = classifyLedger({ files: THREE, ledgerRows: rowsFor(THREE) });
    ok("agreement: structurally sound", v.structurallySound === true);
    ok("agreement: nothing missing from the ledger", v.fileMissingFromLedger.length === 0);
    ok("agreement: nothing missing from the repo", v.ledgerVersionMissingFromRepo.length === 0);
    ok("agreement: ceiling is the highest ledger version", v.ceiling === "103", `got ${v.ceiling}`);
  }

  // ── 2. FORWARD — a repo file the ledger never recorded ─────────────
  {
    const v = classifyLedger({ files: THREE, ledgerRows: rowsFor([A, B]) });
    ok("forward: names the file missing from the ledger",
      v.fileMissingFromLedger.length === 1 && v.fileMissingFromLedger[0] === C);
    ok("forward: is NOT reported as a repo-side orphan",
      v.ledgerVersionMissingFromRepo.length === 0);
    //  A pending file is a release decision, not a structural defect — verify
    //  refuses it, release exists to apply it. Deliberately not folded in.
    ok("forward: pending files do not make the ledger structurally unsound",
      v.structurallySound === true);
  }

  // ── 3. INVERSE — a ledger version this repo has no file for ────────
  //  The whole point of this change.
  {
    const v = classifyLedger({ files: [A, B], ledgerRows: rowsFor(THREE) });
    ok("INVERSE: names the ledger version missing from the repo",
      v.ledgerVersionMissingFromRepo.length === 1 &&
      v.ledgerVersionMissingFromRepo[0].version === "103",
      JSON.stringify(v.ledgerVersionMissingFromRepo));
    ok("INVERSE: reports the ledger's name for it, so it can be found",
      v.ledgerVersionMissingFromRepo[0].ledgerName === "charlie");
    ok("INVERSE: makes the ledger structurally unsound",
      v.structurallySound === false);
    ok("INVERSE: is NOT reported as a pending file",
      v.fileMissingFromLedger.length === 0);
    ok("INVERSE: is NOT reported as a name conflict",
      v.versionNameConflicts.length === 0);
  }

  // ── 4. The two directions are independent ──────────────────────────
  {
    const v = classifyLedger({ files: [A, C], ledgerRows: rowsFor([A, B]) });
    ok("both directions at once: pending file named",
      v.fileMissingFromLedger.length === 1 && v.fileMissingFromLedger[0] === C);
    ok("both directions at once: orphan ledger version named",
      v.ledgerVersionMissingFromRepo.length === 1 &&
      v.ledgerVersionMissingFromRepo[0].version === "102");
    ok("PROPERTY: neither direction can be satisfied by the other",
      v.fileMissingFromLedger.length === 1 && v.ledgerVersionMissingFromRepo.length === 1);
  }

  // ── 5. Version 000 is symmetry, not an ignore list ─────────────────
  //  migrate.js excludes 000_schema_migrations.sql from the file scan
  //  because the ledger table is created directly. A 000 ledger row is the
  //  same decision seen from the other side.
  {
    const v = classifyLedger({
      files: THREE,
      ledgerRows: [{ version: "000", name: "schema_migrations" }, ...rowsFor(THREE)],
    });
    ok("000: a ledger row for the ledger table is not an orphan",
      v.ledgerVersionMissingFromRepo.length === 0);
    ok("000: and does not make the ledger unsound", v.structurallySound === true);
  }
  {
    //  ...but nothing else gets that treatment.
    const v = classifyLedger({ files: THREE, ledgerRows: [{ version: "099", name: "whatever" }, ...rowsFor(THREE)] });
    ok("000: no OTHER version is exempt by default",
      v.ledgerVersionMissingFromRepo.length === 1 &&
      v.ledgerVersionMissingFromRepo[0].version === "099");
  }

  // ── 6. Genuine version/name conflict ───────────────────────────────
  {
    const v = classifyLedger({
      files: THREE,
      ledgerRows: [{ version: "101", name: "something_else" }, ...rowsFor([B, C])],
    });
    ok("conflict: a spent number under a different name is a conflict",
      v.versionNameConflicts.length === 1 && v.versionNameConflicts[0].version === "101");
    ok("conflict: reports both sides, so the repair is obvious",
      v.versionNameConflicts[0].ledgerName === "something_else" &&
      v.versionNameConflicts[0].fileLabel === "alpha");
    ok("conflict: makes the ledger structurally unsound", v.structurallySound === false);
  }

  // ── 7. Name normalisation — messier spelling of the SAME migration ──
  {
    const v = classifyLedger({ files: [A], ledgerRows: [{ version: "101", name: "alpha (1)" }] });
    ok("normalise: 'alpha (1)' is the same migration as 'alpha'",
      v.versionNameConflicts.length === 0);
  }
  {
    const v = classifyLedger({ files: [A], ledgerRows: [{ version: "101", name: "101_alpha.sql" }] });
    ok("normalise: a whole filename in the ledger is the same migration",
      v.versionNameConflicts.length === 0);
  }
  {
    const v = classifyLedger({ files: [A], ledgerRows: [{ version: "101", name: "alphabet" }] });
    ok("normalise: a genuinely different name still conflicts",
      v.versionNameConflicts.length === 1);
  }

  // ── 8. Documented legacy naming exception — and its limits ─────────
  {
    const f012 = "012_bank_intake.sql";
    const v = classifyLedger({
      files: [f012],
      ledgerRows: [{ version: "012", name: "property_noi_goals" }],
    });
    ok("legacy 012: the documented mismatch is accepted",
      v.versionNameConflicts.length === 0 && v.acceptedLegacyNames.length === 1);
    ok("legacy 012: acceptance carries its reason and removal condition",
      !!v.acceptedLegacyNames[0].reason && !!v.acceptedLegacyNames[0].removeWhen);

    //  PINNED ON THE NAME. A different name at 012 is NOT forgiven.
    const w = classifyLedger({
      files: [f012],
      ledgerRows: [{ version: "012", name: "some_other_migration" }],
    });
    ok("legacy 012: pinned on the ledger NAME — a different name still conflicts",
      w.versionNameConflicts.length === 1 && w.acceptedLegacyNames.length === 0);

    //  PINNED ON THE VERSION. The same name elsewhere is NOT forgiven.
    const x = classifyLedger({
      files: ["077_bank_intake.sql"],
      ledgerRows: [{ version: "077", name: "property_noi_goals" }],
    });
    ok("legacy 012: pinned on the VERSION — the same name elsewhere still conflicts",
      x.versionNameConflicts.length === 1 && x.acceptedLegacyNames.length === 0);
  }

  // ── 9. Documented ledger-only exception — and its limits ───────────
  {
    const ledgerOnly = [{
      version: "103", ledgerName: "charlie",
      reason: "test fixture", removeWhen: "the test ends",
    }];
    const v = classifyLedger({ files: [A, B], ledgerRows: rowsFor(THREE), ledgerOnly });
    ok("documented orphan: an explicitly listed ledger-only version is accepted",
      v.ledgerVersionMissingFromRepo.length === 0 && v.acceptedLedgerOnly.length === 1);
    ok("documented orphan: acceptance carries its reason and removal condition",
      !!v.acceptedLedgerOnly[0].reason && !!v.acceptedLedgerOnly[0].removeWhen);
    ok("documented orphan: an accepted orphan leaves the ledger sound",
      v.structurallySound === true);

    //  PINNED ON THE NAME — the exception must not cover whatever later
    //  occupies that number.
    const w = classifyLedger({
      files: [A, B],
      ledgerRows: [...rowsFor([A, B]), { version: "103", name: "a_completely_different_migration" }],
      ledgerOnly,
    });
    ok("documented orphan: pinned on the ledger NAME — a different migration at that number is NOT covered",
      w.ledgerVersionMissingFromRepo.length === 1 && w.acceptedLedgerOnly.length === 0);
  }

  // ── 10. What ships ─────────────────────────────────────────────────
  //  The exception list is empty until a human reads the real ledger. If a
  //  future change quietly pre-populates it, this fails and says so.
  {
    ok("SHIPPED: DOCUMENTED_LEDGER_ONLY is empty — no orphan is forgiven by default",
      Array.isArray(DOCUMENTED_LEDGER_ONLY) && DOCUMENTED_LEDGER_ONLY.length === 0,
      `it has ${DOCUMENTED_LEDGER_ONLY.length} entr(ies)`);
    ok("SHIPPED: exactly one legacy naming exception (012), as documented",
      LEGACY_LEDGER_NAMES.length === 1 && LEGACY_LEDGER_NAMES[0].version === "012",
      `${LEGACY_LEDGER_NAMES.length} entries`);
    ok("SHIPPED: every exception carries a removal condition (§18)",
      [...LEGACY_LEDGER_NAMES, ...DOCUMENTED_LEDGER_ONLY].every((e) => !!e.removeWhen && !!e.reason));
  }

  // ── 11. Duplicate file numbers still stop everything ───────────────
  {
    const v = classifyLedger({ files: [A, "101_duplicate.sql"], ledgerRows: [] });
    ok("duplicates: two files sharing a number are reported",
      v.duplicateFileNumbers.length === 1 && v.duplicateFileNumbers[0].version === "101");
    ok("duplicates: make the ledger structurally unsound", v.structurallySound === false);
  }

  // ── 12. Against the REAL migrations directory ──────────────────────
  //  A classifier that is correct on fixtures and wrong on this repo has
  //  proven nothing about this repo.
  {
    const dir = path.join(__dirname, "..", "migrations");
    const real = fs.readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f) && !f.startsWith("000_")).sort();

    const v = classifyLedger({ files: real, ledgerRows: rowsFor(real) });
    ok(`real dir: ${real.length} files, ledger built from them → sound`,
      v.structurallySound === true && v.fileMissingFromLedger.length === 0,
      JSON.stringify({ conflicts: v.versionNameConflicts, orphans: v.ledgerVersionMissingFromRepo }));

    //  THE 125 SHAPE, exactly. A ledger that carries a version staged
    //  outside migrations/ — which is where
    //  docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql
    //  sits today. If production's ledger has it, this is what the deploy
    //  will say.
    const w = classifyLedger({
      files: real,
      ledgerRows: [...rowsFor(real), { version: "125", name: "application_lifecycle_enforcement" }],
    });
    ok("real dir: a 125-shaped ledger-only version is caught",
      w.ledgerVersionMissingFromRepo.length === 1 &&
      w.ledgerVersionMissingFromRepo[0].version === "125",
      JSON.stringify(w.ledgerVersionMissingFromRepo));
    ok("real dir: and it refuses rather than warns",
      w.structurallySound === false);
  }

  code = receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
} catch (e) {
  code = receipt.died(HARNESS, e, ran);
}
process.exit(code);
