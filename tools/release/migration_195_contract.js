"use strict";

const { normalizeName } = require("../../migrations/ledger_verdict");

const FILE_195 = "195_two_step_leasing_authored_offer_basis.sql";

// Normalise only SQL syntax outside quoted regions. Literal and quoted
// identifier bytes remain exact: case or whitespace in either can change the
// database predicate and must never be laundered into agreement.
function normalizeDefinition(definition) {
  const input = String(definition);
  let out = "", quote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      out += ch;
      if (ch === quote && input[i + 1] === quote) { out += input[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (/\s/.test(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

function positiveInterval(value) {
  const normalized = String(value).trim().toLowerCase();
  if (!/^\d+(ms|s|min)?$/.test(normalized)) return null;
  const amount = Number(normalized.match(/^\d+/)[0]);
  return Number.isSafeInteger(amount) && amount > 0 ? normalized : null;
}

const PRE_CONTRACT = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", "CHECK (source = 'operator_proposed_terms'::text)"],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text]))"],
  ["la_term_source_ck", "lease_applications", "CHECK (term_source IS NULL OR (term_source = ANY (ARRAY['application_capture'::text, 'confirm_term_repair'::text, 'operator_proposed_terms'::text])))"],
].map(([name, table, definition]) => [name, table, normalizeDefinition(definition)]);

const POST_CONTRACT = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", "CHECK (source = ANY (ARRAY['operator_proposed_terms'::text, 'authored_offer_acknowledged'::text]))"],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text, 'authored_offer'::text]))"],
  ["aptc_derived_names_offer_ck", "application_proposed_terms_confirmations", "CHECK (source <> 'authored_offer_acknowledged'::text OR application_offer_id IS NOT NULL AND application_terms_hash IS NOT NULL)"],
  ["la_term_source_ck", "lease_applications", "CHECK (term_source IS NULL OR (term_source = ANY (ARRAY['application_capture'::text, 'confirm_term_repair'::text, 'operator_proposed_terms'::text, 'authored_offer_acknowledged'::text])))"],
].map(([name, table, definition]) => [name, table, normalizeDefinition(definition)]);

function constraintKey(schema, table, name) { return `${schema}.${table}.${name}`; }

function requiredConstraint(defs, name, table, definition) {
  const row = defs.get(constraintKey("public", table, name));
  if (!row) return `${name} is absent from public.${table}`;
  if (row.contype !== "c" || !row.convalidated) return `${name} is not a validated CHECK on public.${table}`;
  if (normalizeDefinition(row.definition) !== definition) {
    return `${name} differs from the reviewed definition: ${row.definition}`;
  }
  return null;
}

function expectedRows(files) {
  return files.map((file) => ({ version: file.slice(0, 3), name: file.slice(4, -4) }));
}

function exactVersions(rows, expected) {
  const got = new Map(rows.filter((row) => row.version !== "000").map((row) => [String(row.version), row.name]));
  if (got.size !== expected.length) return false;
  return expected.every((want) => got.has(want.version) &&
    (normalizeName(got.get(want.version)) === normalizeName(want.name) || want.version === "012"));
}

function decideState({ files, rows, verdict }) {
  const future = files.filter((file) => Number(file.slice(0, 3)) > 195);
  if (future.length || files.filter((file) => file === FILE_195).length !== 1) {
    return { ok: false, reason: `this build is not the exact 195 release set: ${future.join(", ") || "195 is absent or duplicated"}` };
  }
  const pre = expectedRows(files.filter((file) => Number(file.slice(0, 3)) <= 194));
  const post = expectedRows(files);
  const state = exactVersions(rows, pre) ? "pre" : exactVersions(rows, post) ? "post" : null;
  if (!state) return { ok: false, reason: `ledger is neither exact 194 nor exact 195 (ceiling ${verdict.ceiling})` };
  const pending = verdict.fileMissingFromLedger;
  if (state === "pre" && (pending.length !== 1 || pending[0] !== FILE_195)) {
    return { ok: false, reason: `194 state has unexpected pending migrations: ${pending.join(", ") || "none"}` };
  }
  if (state === "post" && (verdict.ceiling !== "195" || pending.length !== 0)) {
    return { ok: false, reason: `195 post-state is not exact: ceiling ${verdict.ceiling}; pending ${pending.join(", ") || "none"}` };
  }
  return { ok: true, state, entries: rows.filter((row) => row.version !== "000").length, ceiling: verdict.ceiling };
}

module.exports = {
  FILE_195,
  PRE_CONTRACT,
  POST_CONTRACT,
  normalizeDefinition,
  positiveInterval,
  constraintKey,
  requiredConstraint,
  decideState,
};
