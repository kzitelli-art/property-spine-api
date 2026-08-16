#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   establish_position.js — THE CONTROLLED PRODUCTION ESTABLISHMENT STEP
   FOR ONE PROPERTY'S CAPITAL-STACK POSITIONS.

   Mirrors tools/debt/establish_instrument.js's discipline exactly.
   Read that file's header first — this one only documents where Equity
   genuinely differs.

   CLASS 4 — DELETE-ON-ACTIVATION SCAFFOLDING.
   RETIREMENT CONDITION: deleted when governed document establishment
   can produce these same proposals from the same retained artifacts and
   a human confirms them through the product. Until then the declaration
   file is the historical record of how a property's positions were
   established.

   ── WHERE THIS DIFFERS FROM DEBT'S TOOL ─────────────────────────────
   Debt has ONE owning row (the instrument) that every other group
   attaches to by a freshly-minted id. Equity has NO single owning row —
   `positions` is itself a LIST, because a property's capital stack is
   several holders at possibly several issuers, not one instrument. Every
   OTHER group (common_class_terms excepted) needs to say WHICH position
   it belongs to, and the position may not exist yet when the
   declaration is written by hand — so declarations reference positions
   by a `key` chosen in the file, not by a database id:

       positions: [ { key: "msc", row: {...}, source_sha256, locator } ]
       preferred_terms: [ { position_key: "msc", row: {...}, ... } ]

   `common_equity_class_terms` is the one dependent group that does NOT
   take a position_key — it is issuer-scoped, not position-scoped
   (Round-4 Ruling 2), and its row already names issuer_legal_entity_id
   directly.

   `conflicts` is the one group with TWO citations, not one — a conflict
   is by definition two disagreeing sources, and citing only one of them
   would misrepresent which claim came from where. Its shape is
   `{ position_key?, row, claim_a_source_sha256, claim_a_locator,
      claim_b_source_sha256, claim_b_locator }`.

   ── THE MSC DEFERRAL IS AN EXECUTABLE REFUSAL, NOT JUST A DEFAULT ────
   The schema default for minimum_dividend_relationship_to_preferred_
   return is 'not_established'. Both the canonical writer and this tool's
   preflight refuse to resolve that relationship from a secondary source.
   A resolved value requires governed_read authority, a non-secondary
   term source, and a retained artifact — i.e. evidence capable of
   establishing the mechanic, not a survey paraphrase, an internal note,
   or any other secondary source. This is Round 4's frozen ruling made
   mechanically impossible to route around by a declaration file that
   just fills in a plausible-looking value.

   ── SAFETY ──────────────────────────────────────────────────────────
   Dry-run by default. `--apply` writes. One transaction: every position
   and every dependent row commit together or nothing does.

   Run:
     DATABASE_URL=… node tools/equity/establish_position.js \
       --declaration tools/equity/declarations/<file>.json \
       --recorded-by-user <users.id> \
       [--apply]
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const svc = require("../../src/asset/equity_position_service.js");

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

//  ── GROUPS THAT REFERENCE A POSITION BY key/position_key ────────────
const POSITION_SCOPED_GROUPS = [
  ["position_overrides",  "addPositionOverride",       true],
  ["preferred_terms",     "addPreferredTerms",          true],
  ["pledges",             "addPledge",                  true],
  ["amount_claims",       "addCapitalAmountClaim",      true],
];

function validateOneCitation(where, e, problems) {
  if (!e || typeof e !== "object" || !e.row) { problems.push(`${where}: no \`row\``); return; }
  if (!e.source_sha256) problems.push(`${where}: no source_sha256 — a canonical row without evidence is refused`);
  else if (!HEX64.test(String(e.source_sha256))) {
    problems.push(`${where}: source_sha256 is not a sha256 — placeholders are refused, retain the document and use its real hash`);
  }
  if (!e.locator || !String(e.locator).trim()) {
    problems.push(`${where}: no locator — "which document" is half an answer; say where inside it`);
  }
  if (e.row.source_artifact_id) problems.push(`${where}: row must not carry source_artifact_id; it is resolved from source_sha256`);
  if (e.row.recorded_by_user_id) problems.push(`${where}: row must not carry recorded_by_user_id; it comes from --recorded-by-user`);
}

function validateShape(decl) {
  const problems = [];
  if (!Array.isArray(decl.positions) || !decl.positions.length) {
    problems.push("no `positions` list declared — a property with no positions is not an establishment");
  }
  const keys = new Set();
  (decl.positions || []).forEach((e, i) => {
    const where = `positions[${i}]`;
    if (!e || !e.key || !String(e.key).trim()) { problems.push(`${where}: no \`key\` — dependent groups reference positions by key`); }
    else if (keys.has(e.key)) { problems.push(`${where}: duplicate key "${e.key}"`); }
    else keys.add(e.key);
    validateOneCitation(where, e, problems);
  });

  (decl.common_class_terms || []).forEach((e, i) => validateOneCitation(`common_class_terms[${i}]`, e, problems));

  for (const [group] of POSITION_SCOPED_GROUPS) {
    (decl[group] || []).forEach((e, i) => {
      const where = `${group}[${i}]`;
      if (!e || !e.position_key) { problems.push(`${where}: no \`position_key\``); }
      else if (!keys.has(e.position_key)) { problems.push(`${where}: position_key "${e.position_key}" is not declared in \`positions\``); }
      validateOneCitation(where, e, problems);
      //  ⚠ THE MSC DEFERRAL, ENFORCED HERE — see file header.
      if (group === "preferred_terms" && e && e.row) {
        const rel = e.row.minimum_dividend_relationship_to_preferred_return;
        if (rel && rel !== "not_established"
            && (e.row.source_authority !== "governed_read"
                || e.row.term_source === "secondary_summary")) {
          problems.push(`${where}: minimum_dividend_relationship_to_preferred_return="${rel}" is refused ` +
            `unless source_authority is "governed_read" and term_source is not "secondary_summary" — ` +
            `a survey paraphrase or any other secondary source may not settle this relationship. ` +
            `Read the actual governing clause first.`);
        }
      }
      if (group === "amount_claims" && e && e.row
          && e.row.claim_source === "internal_note"
          && (!e.row.asserted_by_text || !String(e.row.asserted_by_text).trim())) {
        problems.push(`${where}: claim_source="internal_note" requires asserted_by_text — ` +
          `a spoken estimate without its speaker is not attributable evidence.`);
      }
    });
  }

  (decl.conflicts || []).forEach((e, i) => {
    const where = `conflicts[${i}]`;
    if (!e || !e.row) { problems.push(`${where}: no \`row\``); return; }
    if (e.position_key && !keys.has(e.position_key)) problems.push(`${where}: position_key "${e.position_key}" is not declared`);
    for (const side of ["a", "b"]) {
      const sha = e[`claim_${side}_source_sha256`], loc = e[`claim_${side}_locator`];
      if (!sha) problems.push(`${where}: no claim_${side}_source_sha256 — both sides of a conflict need their own evidence`);
      else if (!HEX64.test(String(sha))) problems.push(`${where}: claim_${side}_source_sha256 is not a sha256`);
      if (!loc || !String(loc).trim()) problems.push(`${where}: no claim_${side}_locator`);
    }
    if (e.row.recorded_by_user_id) problems.push(`${where}: row must not carry recorded_by_user_id; it comes from --recorded-by-user`);
  });

  return problems;
}

module.exports = { validateShape };

async function main() {
  const declPath = arg("declaration");
  //  ⚠ ATTRIBUTION, NOT AUTHORITY — same as Debt's tool. This uuid
  //  records WHO the facts are attributed to in canonical history. It is
  //  not proof that person authorised the release.
  const recordedBy = arg("recorded-by-user");
  const apply = process.argv.includes("--apply");

  if (!declPath || !recordedBy) {
    die(["usage: --declaration <file> --recorded-by-user <uuid> [--apply]",
         "",
         "--recorded-by-user is recording ATTRIBUTION, not proof of authorisation.",
         "property_id is read from the declaration's own position rows, not a flag —",
         "positions at different issuers may still share one property_id, but the",
         "tool never assumes a single property the way Debt's --property flag does."]);
  }
  if (!process.env.DATABASE_URL) die("DATABASE_URL is not set.");

  const raw = fs.readFileSync(path.resolve(declPath));
  const declSha = crypto.createHash("sha256").update(raw).digest("hex");
  let decl;
  try { decl = JSON.parse(raw.toString("utf8")); }
  catch (e) { die(["declaration is not valid JSON: " + e.message]); }

  const problems = validateShape(decl);
  if (problems.length) die(["the declaration is not establishable:", ""].concat(problems));

  const propertyIds = new Set(decl.positions.map((e) => e.row.property_id).filter(Boolean));
  if (propertyIds.size !== 1) {
    die([`every position must share one property_id — found ${propertyIds.size}: ` +
      [...propertyIds].join(", ")]);
  }
  const propertyId = [...propertyIds][0];

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("  EQUITY CAPITAL-STACK ESTABLISHMENT" + (apply ? "" : "   — DRY RUN"));
  console.log(`  declaration   ${path.basename(declPath)}`);
  console.log(`  decl sha256   ${declSha.slice(0, 16)}…`);
  console.log(`  property      ${propertyId}`);
  console.log(`  positions     ${decl.positions.length}`);
  console.log(`  recorded by   ${recordedBy}   (attribution, not authorisation)`);
  console.log("════════════════════════════════════════════════════════════════\n");

  try {
    //  ── EVERY REFERENCED DOCUMENT MUST ALREADY BE RETAINED ─────────
    const hashes = new Set();
    decl.positions.forEach((e) => hashes.add(e.source_sha256));
    (decl.common_class_terms || []).forEach((e) => hashes.add(e.source_sha256));
    for (const [group] of POSITION_SCOPED_GROUPS) (decl[group] || []).forEach((e) => hashes.add(e.source_sha256));
    (decl.conflicts || []).forEach((e) => { hashes.add(e.claim_a_source_sha256); hashes.add(e.claim_b_source_sha256); });

    const found = await db.query(
      `select id, sha256, original_filename from source_artifacts where sha256 = any($1::text[])`,
      [[...hashes]]);
    const bySha = new Map(found.rows.map((r) => [r.sha256, r]));
    const missing = [...hashes].filter((h) => !bySha.has(h));
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
    //  Equity has no single natural key the way a loan_number is for
    //  Debt — the safe, conservative check is "does this property have
    //  ANY governed position at all". A partial re-run against append-
    //  only history is unrecoverable the same way Debt's is.
    const existing = await db.query(
      `select count(*)::int as n from capital_stack_positions where property_id = $1`, [propertyId]);
    if (existing.rows[0].n > 0) {
      die([`property ${propertyId} already has ${existing.rows[0].n} governed capital-stack ` +
           "position(s).",
           "",
           "Re-running would append a SECOND declaration's worth of positions and terms",
           "to append-only history, with no way to tell which position came from which",
           "run. There is no safe partial re-run; correct existing positions through the",
           "canonical writers directly instead."]);
    }

    await db.query("begin");

    const note = (e) => `${e.locator} · via establish_position declaration ${declSha.slice(0, 16)}`;
    const written = [];
    const posIdByKey = {};

    for (const e of decl.positions) {
      const artifactId = bySha.get(e.source_sha256).id;
      const row = Object.assign({}, e.row, {
        source_artifact_id: artifactId,
        provenance_note: note(e),
        recorded_by_user_id: recordedBy,
      });
      const out = await svc.addPosition(db, row);
      posIdByKey[e.key] = out.id;
      written.push(`positions  ${e.locator}`);
    }

    for (const e of (decl.common_class_terms || [])) {
      const artifactId = bySha.get(e.source_sha256).id;
      await svc.addCommonClassTerms(db, Object.assign({}, e.row, {
        source_artifact_id: artifactId, provenance_note: note(e), recorded_by_user_id: recordedBy,
      }));
      written.push(`common_class_terms  ${e.locator}`);
    }

    for (const [group, writer] of POSITION_SCOPED_GROUPS) {
      for (const e of (decl[group] || [])) {
        const artifactId = bySha.get(e.source_sha256).id;
        const row = Object.assign({}, e.row, {
          position_id: posIdByKey[e.position_key],
          source_artifact_id: artifactId, provenance_note: note(e), recorded_by_user_id: recordedBy,
        });
        await svc[writer](db, row);
        written.push(`${group}  ${e.locator}`);
      }
    }

    for (const e of (decl.conflicts || [])) {
      const artifactA = bySha.get(e.claim_a_source_sha256).id;
      const artifactB = bySha.get(e.claim_b_source_sha256).id;
      const row = Object.assign({}, e.row, {
        position_id: e.position_key ? posIdByKey[e.position_key] : null,
        claim_a_source_artifact_id: artifactA,
        claim_b_source_artifact_id: artifactB,
        provenance_note: `${e.claim_a_locator} vs. ${e.claim_b_locator} · via establish_position declaration ${declSha.slice(0, 16)}`,
        recorded_by_user_id: recordedBy,
      });
      await svc.recordConflict(db, row);
      written.push(`conflicts  ${e.claim_a_locator} vs. ${e.claim_b_locator}`);
    }

    console.log("\n  ── rows " + (apply ? "written" : "that WOULD be written") + " ──");
    written.forEach((w) => console.log("    " + w));

    if (apply) {
      await db.query("commit");
      console.log(`\n  ✓ ESTABLISHED — ${decl.positions.length} position(s) for property ${propertyId}`);
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
    try { await db.query("rollback"); } catch (_) {}
    await db.end();
    die(["establishment failed and was rolled back in full:", "", "  " + (e.message || String(e))]);
  }
}

if (require.main === module) main();
