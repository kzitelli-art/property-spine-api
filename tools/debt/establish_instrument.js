#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   establish_instrument.js — THE CONTROLLED PRODUCTION ESTABLISHMENT
   STEP FOR ONE DEBT INSTRUMENT.

   CLASS 4 — DELETE-ON-ACTIVATION SCAFFOLDING.
   RETIREMENT CONDITION: this file is deleted when governed document
   establishment can produce these same proposals from the same retained
   artifacts and a human confirms them through the product. At that point
   the declaration file becomes the historical record of how the first
   instrument was established, and this tool has no job. That condition is
   testable, not "when convenient".

   ── WHAT THIS IS NOT ────────────────────────────────────────────────
   Not an HTTP route. Not a seed script. Not a 4125 code path — 4125 is a
   DECLARATION FILE handed in as input, so a second loan is a second
   declaration and never a second branch in here.

   ── PROVENANCE IS THE WHOLE POINT ───────────────────────────────────
   The failure this exists to prevent is loading $28.25M, 3.28% and a
   maturity date into production as unexplained literals so a screen looks
   finished. Every canonical row written here carries the retained
   document that supports it.

       declaration cites a document by sha256
         → the tool resolves it in source_artifacts
         → not retained? THE ROW IS REFUSED, not written without evidence

   Evidence comes first and facts reference it. A hash cannot be invented
   into existence, which is exactly why the declaration cites hashes
   rather than artifact ids.

   ── ONE ARTIFACT PER CANONICAL ROW ──────────────────────────────────
   The declaration is organised around the ROWS the canonical writers
   persist, because each row carries exactly one `source_artifact_id`.

       ✗ FORBIDDEN   gather facts from three documents, write one row,
                     attach whichever artifact id is convenient
       ✓ REQUIRED    one retained artifact supports the whole row, with a
                     locator naming where inside it

   If two facts genuinely need two documents, they are two rows or they
   are refused. A row whose evidence is a blend is a row nobody can walk
   back, and it would pass every other check in this file.

   ── SAFETY ──────────────────────────────────────────────────────────
   Dry-run by default. `--apply` writes. One transaction: the instrument
   and every related row commit together or nothing does — a partial
   establishment is unrecoverable against append-only history, because
   the re-run would duplicate whatever already landed.

   Run:
     DATABASE_URL=… node tools/debt/establish_instrument.js \
       --declaration tools/debt/declarations/<file>.json \
       --property <properties.id> \
       --recorded-by-user <users.id> \
       [--apply]
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const svc = require("../../src/asset/debt_instrument_service.js");

const HEX64 = /^[0-9a-f]{64}$/;

function die(lines) {
  console.error("\n════════════════════════════════════════════════════════════════");
  console.error("  ✗ REFUSED — nothing was written.\n");
  (Array.isArray(lines) ? lines : [lines]).forEach((l) => console.error("    " + l));
  console.error("════════════════════════════════════════════════════════════════\n");
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : null;
}

/*  ── THE DECLARATION CONTRACT ───────────────────────────────────────
 *  Every group is a list of canonical ROWS. Each row is
 *      { row: {...writer fields...}, source_sha256, locator }
 *  and both provenance fields are mandatory on every single one.        */
const GROUPS = [
  ["instrument",            "establishInstrument",      false],
  ["parties",               "addParty",                 true],
  ["collateral",            "addCollateral",            true],
  ["terms",                 "addTerm",                  true],
  ["reserve_requirements",  "addReserveRequirement",    true],
  ["balance_observations",  "recordBalanceObservation", true],
  ["payment_observations",  "recordPaymentObservation", true],
];

function validateShape(decl) {
  const problems = [];
  if (!decl.instrument || !decl.instrument.row) problems.push("no `instrument` row declared");

  for (const [key] of GROUPS) {
    const v = decl[key];
    if (v === undefined) continue;
    const entries = key === "instrument" ? [v] : v;
    if (!Array.isArray(entries)) { problems.push(`${key} must be a list`); continue; }
    entries.forEach((e, i) => {
      const where = `${key}[${i}]`;
      if (!e || typeof e !== "object" || !e.row) { problems.push(`${where}: no \`row\``); return; }
      //  PROVENANCE IS NOT OPTIONAL, PER ROW.
      if (!e.source_sha256) problems.push(`${where}: no source_sha256 — a canonical row without evidence is refused`);
      else if (!HEX64.test(String(e.source_sha256))) {
        problems.push(`${where}: source_sha256 is not a sha256 — placeholders are refused, retain the document and use its real hash`);
      }
      if (!e.locator || !String(e.locator).trim()) {
        problems.push(`${where}: no locator — "which document" is half an answer; say where inside it`);
      }
      //  The writers own their own required-field refusals; this only
      //  catches the fields the TOOL is responsible for supplying.
      if (e.row.source_artifact_id) problems.push(`${where}: row must not carry source_artifact_id; it is resolved from source_sha256`);
      if (e.row.recorded_by_user_id) problems.push(`${where}: row must not carry recorded_by_user_id; it comes from --recorded-by-user`);
    });
  }
  return problems;
}

(async () => {
  const declPath = arg("declaration");
  const propertyId = arg("property");
  //  ⚠ ATTRIBUTION, NOT AUTHORITY. This uuid records WHO the facts are
  //  attributed to in canonical history. It does not prove that person
  //  authorised the release, and nothing here should be read as consent.
  //  Human authorisation for running this tool lives outside the Debt
  //  facts, in whatever approves the production operation itself.
  const recordedBy = arg("recorded-by-user");
  const apply = process.argv.includes("--apply");

  if (!declPath || !propertyId || !recordedBy) {
    die(["usage: --declaration <file> --property <uuid> --recorded-by-user <uuid> [--apply]",
         "",
         "--recorded-by-user is recording ATTRIBUTION, not proof of authorisation."]);
  }
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");

  const raw = fs.readFileSync(path.resolve(declPath));
  //  The declaration's own hash goes into every row's provenance note, so
  //  a re-run with an EDITED declaration is visibly a different input
  //  rather than silently the same one.
  const declSha = crypto.createHash("sha256").update(raw).digest("hex");
  let decl;
  try { decl = JSON.parse(raw.toString("utf8")); }
  catch (e) { die(["declaration is not valid JSON: " + e.message]); }

  const problems = validateShape(decl);
  if (problems.length) die(["the declaration is not establishable:", ""].concat(problems));

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  DEBT INSTRUMENT ESTABLISHMENT" + (apply ? "" : "   — DRY RUN"));
  console.log(`  declaration   ${path.basename(declPath)}`);
  console.log(`  decl sha256   ${declSha.slice(0, 16)}…`);
  console.log(`  property      ${propertyId}`);
  console.log(`  recorded by   ${recordedBy}   (attribution, not authorisation)`);
  console.log("════════════════════════════════════════════════════════════════\n");

  try {
    //  ── EVERY REFERENCED DOCUMENT MUST ALREADY BE RETAINED ─────────
    //  Exactly the artifacts this declaration cites — no hardcoded list
    //  of required documents, so the tool never demands evidence it does
    //  not use.
    const hashes = [...new Set(GROUPS.flatMap(([key]) => {
      const v = decl[key];
      if (!v) return [];
      return (key === "instrument" ? [v] : v).map((e) => e.source_sha256);
    }))];

    const found = await db.query(
      `select id, sha256, original_filename from source_artifacts where sha256 = any($1::text[])`,
      [hashes]);
    const bySha = new Map(found.rows.map((r) => [r.sha256, r]));
    const missing = hashes.filter((h) => !bySha.has(h));
    if (missing.length) {
      die(["the declaration cites documents that are NOT retained in this database:", ""]
        .concat(missing.map((h) => "  " + h))
        .concat(["", "Retain the source documents first. A canonical fact may not be",
                 "established from a document Spine does not hold."]));
    }

    console.log("  ── evidence resolved ──");
    for (const h of hashes) {
      const a = bySha.get(h);
      console.log(`    ${h.slice(0, 12)}…  ${a.original_filename}`);
    }

    //  ── ALREADY ESTABLISHED? ───────────────────────────────────────
    const loanNumber = decl.instrument.row.loan_number || null;
    if (loanNumber) {
      const dup = await db.query(
        `select i.id from debt_instruments i
           join debt_instrument_properties p on p.instrument_id = i.id
          where i.loan_number = $1 and p.property_id = $2`, [loanNumber, propertyId]);
      if (dup.rows.length) {
        die([`loan ${loanNumber} is already established for this property (${dup.rows[0].id}).`,
             "",
             "Re-running would append a SECOND set of parties, terms and observations",
             "to append-only history. There is no safe partial re-run; correct the",
             "existing instrument through the canonical writers instead."]);
      }
    }

    await db.query("begin");

    const note = (e) => `${e.locator} · via establish_instrument declaration ${declSha.slice(0, 16)}`;
    const written = [];
    let instrumentId = null;

    for (const [key, writer, isList] of GROUPS) {
      const v = decl[key];
      if (!v) continue;
      const entries = isList ? v : [v];
      for (const e of entries) {
        const artifactId = bySha.get(e.source_sha256).id;
        const row = Object.assign({}, e.row, {
          provenance_note: note(e),
          recorded_by_user_id: recordedBy,
        });
        /*  ⚠ THE PROVENANCE FIELD IS NOT UNIFORMLY NAMED.
         *  addCollateral takes `established_by_source_artifact_id` — the
         *  collateral link records WHAT ESTABLISHED IT, because a loan
         *  named "LVL 4125" must never resolve a property by its name.
         *  Setting `source_artifact_id` there is silently ignored by the
         *  writer and the row lands with NO evidence while every other
         *  check still passes. The harness caught exactly that. */
        if (key === "collateral") row.established_by_source_artifact_id = artifactId;
        else row.source_artifact_id = artifactId;
        if (key !== "instrument") row.instrument_id = instrumentId;
        if (key === "collateral") row.property_id = propertyId;

        const out = await svc[writer](db, row);
        if (key === "instrument") instrumentId = out.id;
        written.push(`${key}  ${e.locator}`);
      }
    }

    console.log("\n  ── rows " + (apply ? "written" : "that WOULD be written") + " ──");
    written.forEach((w) => console.log("    " + w));

    if (apply) {
      await db.query("commit");
      console.log(`\n  ✓ ESTABLISHED — instrument ${instrumentId}`);
      console.log(`    ${written.length} canonical rows, each carrying its source document.`);
    } else {
      await db.query("rollback");
      console.log("\n  DRY RUN — rolled back. Nothing was written.");
      console.log("  Re-run with --apply to establish.");
    }
    console.log("════════════════════════════════════════════════════════════════\n");
    await db.end();
    process.exit(0);
  } catch (e) {
    //  One transaction: a partial establishment is unrecoverable against
    //  append-only history, so any failure takes the whole thing back.
    try { await db.query("rollback"); } catch (_) {}
    await db.end();
    die(["establishment failed and was rolled back in full:", "", "  " + (e.message || String(e))]);
  }
})();
