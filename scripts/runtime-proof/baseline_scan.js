// ════════════════════════════════════════════════════════════════════
//  baseline_scan.js — BASIC INSPECTION OF TWO EXPORTED ARTIFACTS
//
//  PURE. No database, no network, no clock. Text in, findings out. That is
//  what makes it testable against synthetic artifacts rather than against a
//  manufactured copy of the real schema.
//
//  ── WHAT THIS IS NOT ────────────────────────────────────────────────
//
//      THIS IS AN INSPECTION AID. IT DOES NOT PROVE AN ARTIFACT IS SAFE.
//
//  It looks for a small number of shapes that have obvious reasons to be
//  absent from a schema-only dump. It cannot know what a column comment
//  contains, what a default expression encodes, or whether a view name is
//  itself sensitive. A clean run means "none of these specific shapes were
//  found", and nothing more.
//
//  The owner reads the warnings and decides. Nothing here edits a dump — a
//  scanner that silently rewrites the artifact would leave the owner
//  transferring a file nobody has actually looked at.
// ════════════════════════════════════════════════════════════════════

"use strict";

const crypto = require("crypto");

//  ── SHAPES ────────────────────────────────────────────────────────
//  Deliberately loose. A false positive costs the owner one read; a false
//  negative costs an artifact leaving the building with something in it.
const SHAPE = {
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  // +1 555-123-4567 / (555) 123-4567 / 555.123.4567 — 10+ digits with separators.
  phone: /(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
};

//  A schema-only dump legitimately contains DDL and a handful of SET/SELECT
//  lines. It does NOT contain table data. These are the statements that mean
//  rows are travelling with the schema.
const DATA_STATEMENT = /^\s*(insert\s+into|copy\s+[a-z_."]+\s*(\(|from)|\\\.)/i;

const LEDGER_TABLE = /^(public\.)?schema_migrations$/i;

function lines(text) { return String(text == null ? "" : text).split(/\r?\n/); }

//  ── FUNCTION AND VIEW BODIES ──────────────────────────────────────
//  A UUID sitting in a table default is usually gen_random_uuid()'s absence,
//  which is uninteresting. A UUID hard-coded inside a function or a view is a
//  specific real row being referenced by a piece of logic — a property id, a
//  user id — and that is worth a look before the file leaves the machine.
function bodyRegions(text) {
  const src = String(text || "");
  const out = [];

  // Dollar-quoted bodies: $$ ... $$ or $tag$ ... $tag$
  const dollar = /(\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/g;
  let m;
  while ((m = dollar.exec(src)) !== null) {
    out.push({ kind: "function body", text: m[2], index: m.index });
  }

  // CREATE [OR REPLACE] VIEW/MATERIALIZED VIEW ... AS <select> ;
  const view = /create\s+(or\s+replace\s+)?(materialized\s+)?view\s+([^\s(]+)[\s\S]*?;/gi;
  while ((m = view.exec(src)) !== null) {
    out.push({ kind: `view ${m[3]}`, text: m[0], index: m.index });
  }
  return out;
}

function lineOf(text, index) {
  return String(text).slice(0, index).split(/\r?\n/).length;
}

/**
 * scanSchemaDump — the schema-only artifact.
 * Returns { warnings: [{code, detail, line}], counts }
 */
function scanSchemaDump(text) {
  const src = String(text == null ? "" : text);
  const warnings = [];
  const add = (code, detail, line) => warnings.push({ code, detail, line: line || null });

  // 1. Table data in a schema-only dump.
  lines(src).forEach((l, i) => {
    if (DATA_STATEMENT.test(l)) {
      add("data_statement_in_schema_dump",
          `Line ${i + 1} looks like table data in a schema-only dump: ${l.trim().slice(0, 80)}`,
          i + 1);
    }
  });

  // 2. Identifier-shaped literals inside logic.
  for (const region of bodyRegions(src)) {
    const uuids = region.text.match(SHAPE.uuid) || [];
    for (const u of new Set(uuids)) {
      add("uuid_literal_in_logic",
          `A UUID literal appears inside a ${region.kind}: ${u}`,
          lineOf(src, region.index));
    }
  }

  // 3. Contact-shaped literals anywhere in the file.
  const emails = new Set(src.match(SHAPE.email) || []);
  for (const e of emails) add("email_literal", `An email-shaped literal appears in the dump: ${e}`);
  const phones = new Set(src.match(SHAPE.phone) || []);
  for (const p of phones) add("phone_literal", `A phone-shaped literal appears in the dump: ${p.trim()}`);

  return {
    warnings,
    counts: {
      lines: lines(src).length,
      function_or_view_bodies: bodyRegions(src).length,
    },
  };
}

/**
 * scanLedgerDump — the migration-ledger artifact.
 * The ONLY table permitted here is public.schema_migrations.
 */
function scanLedgerDump(text) {
  const src = String(text == null ? "" : text);
  const warnings = [];
  const add = (code, detail, line) => warnings.push({ code, detail, line: line || null });

  const tables = new Set();
  lines(src).forEach((l, i) => {
    let m = /^\s*insert\s+into\s+([a-z_0-9."]+)/i.exec(l);
    if (!m) m = /^\s*copy\s+([a-z_0-9."]+)/i.exec(l);
    if (!m) return;
    const t = m[1].replace(/"/g, "");
    tables.add(t);
    if (!LEDGER_TABLE.test(t)) {
      add("non_ledger_table_data",
          `Line ${i + 1} carries data for "${t}", which is not the migration ledger.`,
          i + 1);
    }
  });

  // Contact shapes should be impossible in a ledger, so their presence is a
  // strong sign the wrong table was exported.
  for (const e of new Set(src.match(SHAPE.email) || [])) {
    add("email_literal", `An email-shaped literal appears in the ledger artifact: ${e}`);
  }
  for (const p of new Set(src.match(SHAPE.phone) || [])) {
    add("phone_literal", `A phone-shaped literal appears in the ledger artifact: ${p.trim()}`);
  }

  return { warnings, tables: [...tables] };
}

/**
 * ledgerFacts — read the ledger artifact for what the manifest must record.
 *
 * Deliberately derived from the ARTIFACT, not from a second database query, so
 * the manifest describes the file that will actually be transferred. A count
 * taken from the database could differ from the file by a race, a mistake, or
 * a swapped path, and the manifest would then vouch for the wrong thing.
 */
function ledgerFacts(text) {
  const src = String(text == null ? "" : text);
  const versions = [];

  //  --column-inserts form:
  //    INSERT INTO public.schema_migrations (version, name, applied_at) VALUES ('112', ...);
  const insertRe = /insert\s+into\s+[a-z_0-9."]*schema_migrations[^)]*\)\s*values\s*\(\s*('([^']*)'|([0-9]+))/gi;
  let m;
  while ((m = insertRe.exec(src)) !== null) versions.push(String(m[2] !== undefined ? m[2] : m[3]));

  //  COPY form, for an artifact produced without --column-inserts.
  const copyBlock = /^\s*copy\s+[a-z_0-9."]*schema_migrations[^\n]*from\s+stdin[^\n]*\n([\s\S]*?)^\\\.$/gim;
  while ((m = copyBlock.exec(src)) !== null) {
    for (const l of m[1].split(/\r?\n/)) {
      if (!l.trim()) continue;
      versions.push(l.split("\t")[0]);
    }
  }

  const sorted = versions.slice().sort();
  return {
    rows: versions.length,
    versions,
    highest: sorted.length ? sorted[sorted.length - 1] : null,
    // Duplicates in the EXPORT are their own kind of problem — the ledger is
    // primary-keyed, so a duplicate here means the file, not the database.
    duplicates: versions.filter((v, i) => versions.indexOf(v) !== i),
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text == null ? "" : text), "utf8").digest("hex");
}

module.exports = {
  scanSchemaDump, scanLedgerDump, ledgerFacts, sha256,
  bodyRegions, SHAPE, DATA_STATEMENT,
};
