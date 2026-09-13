#!/usr/bin/env node
/*
  One bounded release/recovery operation for migrations 195 through 198.

  No arguments verifies exact 198 and never writes. --apply is accepted only
  from exact 194. A file-level failure after 195 commits is recovered only by
  the explicit --resume195, --resume196, or --resume197 command matching the
  full ledger and physical state. The canonical per-file transaction owner is
  migrations/migrate.js; this wrapper does not reproduce migration execution.
*/
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { Client } = require("pg");
const { databaseSsl } = require("../../src/shared/database_ssl");
const { classifyLedger } = require("../../migrations/ledger_verdict");
const { triggerTables } = require("../../src/tenancy/inventory_relationship_policy");
const {
  RELEASE_FILES, normalizeDefinition, positiveInterval, decideState,
  parseCommand, constraintKey, requiredConstraint,
} = require("./migration_194_198_contract");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const REVIEWED_HASHES = Object.freeze({
  "195_two_step_leasing_authored_offer_basis.sql": "e5c8f9bdb382b3a36e56e9b514db25734639500be9579171762d37c7e28b02bb",
  "196_source_home_identity_review.sql": "671273a93914056c0efbf929daab4c0001f7fe4687ae7b5238532f9677e4470c",
  "197_inventory_correction_hardening.sql": "83d878dc556687e0d5771a4317330f6ebeafe6376a363b590b47578d83bb33a9",
  "198_proposed_source_claim_identity.sql": "0185b55e8ad6ae6b3763296f1136d82064a1f2effc0944e32f32f974c1699556",
});
// SHA-256 of normalized pg_get_functiondef() for the reviewed migration 197
// body. Normalization removes server formatting differences outside quotes;
// body literals and identifiers stay byte-sensitive. The source-file hash
// proves the input and this proves that the installed same-signature function
// was not replaced by weaker code.
const REVIEWED_197_FUNCTION_SHA256 = "ac63979747bc83b85649301594c3bb1a4339570b30a92b92e0624adc7f9208e5";

const CHECK_195_PRE = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", "CHECK (source = 'operator_proposed_terms'::text)"],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text]))"],
  ["la_term_source_ck", "lease_applications", "CHECK (term_source IS NULL OR (term_source = ANY (ARRAY['application_capture'::text, 'confirm_term_repair'::text, 'operator_proposed_terms'::text])))"],
];
const CHECK_195_POST = [
  ["aptc_source_ck", "application_proposed_terms_confirmations", "CHECK (source = ANY (ARRAY['operator_proposed_terms'::text, 'authored_offer_acknowledged'::text]))"],
  ["aptc_authority_ck", "application_proposed_terms_confirmations", "CHECK (authority_basis = ANY (ARRAY['owner'::text, 'role_authority'::text, 'managed_role_override'::text, 'authored_offer'::text]))"],
  ["aptc_derived_names_offer_ck", "application_proposed_terms_confirmations", "CHECK (source <> 'authored_offer_acknowledged'::text OR application_offer_id IS NOT NULL AND application_terms_hash IS NOT NULL)"],
  ["la_term_source_ck", "lease_applications", "CHECK (term_source IS NULL OR (term_source = ANY (ARRAY['application_capture'::text, 'confirm_term_repair'::text, 'operator_proposed_terms'::text, 'authored_offer_acknowledged'::text])))"],
];

const CHECK_196 = [
  ["ck_proposed_selected_space_parent", "proposed_records", "CHECK (selected_space_id IS NULL OR selected_unit_id IS NOT NULL)"],
  ["ck_proposed_inventory_identity_complete", "proposed_records", "CHECK (target_type <> 'inventory_identity'::text OR status = 'promoted'::text AND resolution_kind IS NOT NULL AND (resolution_kind = ANY (ARRAY['created'::text, 'resolved_existing'::text])) AND selected_unit_id IS NOT NULL AND promoted_record_id IS NOT NULL AND promoted_record_id = COALESCE(selected_space_id, selected_unit_id) AND confirmed_by IS NOT NULL AND length(btrim(confirmed_by)) > 0 AND confirmed_at IS NOT NULL AND inventory_identity_decision_id IS NULL)"],
  ["ck_proposed_inventory_target_owner", "proposed_records", "CHECK (target_type = 'inventory_identity'::text OR selected_unit_id IS NULL AND selected_space_id IS NULL)"],
];
const FK_196 = [
  ["proposed_records_selected_unit_id_fkey", "proposed_records", "FOREIGN KEY (selected_unit_id) REFERENCES units(id) ON DELETE RESTRICT"],
  ["proposed_records_selected_space_id_fkey", "proposed_records", "FOREIGN KEY (selected_space_id) REFERENCES spaces(id) ON DELETE RESTRICT"],
  ["proposed_records_inventory_identity_decision_id_fkey", "proposed_records", "FOREIGN KEY (inventory_identity_decision_id) REFERENCES proposed_records(id) ON DELETE RESTRICT"],
];

const INDEX_196 = [
  ["ix_proposed_selected_unit", "proposed_records", false, "CREATE INDEX ix_proposed_selected_unit ON public.proposed_records USING btree (selected_unit_id) WHERE (selected_unit_id IS NOT NULL)"],
  ["ix_proposed_selected_space", "proposed_records", false, "CREATE INDEX ix_proposed_selected_space ON public.proposed_records USING btree (selected_space_id) WHERE (selected_space_id IS NOT NULL)"],
  ["ix_proposed_inventory_identity_decision", "proposed_records", false, "CREATE INDEX ix_proposed_inventory_identity_decision ON public.proposed_records USING btree (inventory_identity_decision_id) WHERE (inventory_identity_decision_id IS NOT NULL)"],
];
const INDEX_198_PRE = ["uq_proposed_natural", "proposed_records", true,
  "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE (natural_key IS NOT NULL)"];
const INDEX_198_POST = ["uq_proposed_natural", "proposed_records", true,
  "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE ((natural_key IS NOT NULL) AND (import_source_row_id IS NULL))"];

function die(message, detail) {
  console.error(`\nCOMBINED MIGRATION 194-198 PREDEPLOY REFUSED: ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS)
    .filter((file) => /^\d{3}_.*\.sql$/.test(file) && !file.startsWith("000_"))
    .sort();
}

function exactBuildPin(files) {
  const expected = String(process.env.EXPECTED_SHA || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    die("EXPECTED_SHA must be one full 40-hex commit SHA.");
  }
  let head;
  try { head = git(["rev-parse", "HEAD"]).toLowerCase(); }
  catch { die("the executing checkout and tracked cleanliness could not be inspected."); }
  const rendered = String(process.env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  if (rendered && rendered !== expected) die("RENDER_GIT_COMMIT differs from EXPECTED_SHA.", `render ${rendered}\npin    ${expected}`);
  if (head !== expected) die("EXPECTED_SHA differs from the executing checkout.", `head ${head}\npin  ${expected}`);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) die("the executing checkout has tracked changes.", dirty);

  const tracked = new Set(git(["ls-tree", "-r", "--name-only", expected, "--", "migrations"])
    .split(/\r?\n/).filter(Boolean).map((name) => path.basename(name)));
  const unpinned = files.filter((file) => !tracked.has(file));
  if (unpinned.length) die("migration files on disk are absent from the pinned commit.", unpinned.join("\n"));
  const pinnedEntrypoints = new Set(git(["ls-tree", "-r", "--name-only", expected, "--",
    "tools/release/migration_194_198_predeploy.js",
    "tools/release/migration_194_198_contract.js",
    "migrations/migrate.js",
    "migrations/ledger_verdict.js",
    "src/tenancy/inventory_relationship_policy.js",
  ]).split(/\r?\n/).filter(Boolean).map((name) => name.replace(/\\/g, "/")));
  for (const required of [
    "tools/release/migration_194_198_predeploy.js",
    "tools/release/migration_194_198_contract.js",
    "migrations/migrate.js",
    "migrations/ledger_verdict.js",
    "src/tenancy/inventory_relationship_policy.js",
  ]) if (!pinnedEntrypoints.has(required)) die(`the executing release dependency is absent from the pinned commit: ${required}`);
  return expected;
}

function verifyReviewedHashes() {
  for (const file of RELEASE_FILES) {
    const fullPath = path.join(MIGRATIONS, file);
    if (!fs.existsSync(fullPath)) die(`migrations/${file} is absent.`);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
    if (actual !== REVIEWED_HASHES[file]) {
      die(`migrations/${file} differs from the reviewed source.`,
        `expected ${REVIEWED_HASHES[file]}\nactual   ${actual}`);
    }
  }
}

function interval(name, fallback) {
  const value = positiveInterval(process.env[name] || fallback);
  if (!value) die(`${name} is malformed or non-positive.`, "Use 500ms, 10s, or 2min.");
  return value;
}

async function establishBoundedPreflight(client, lockTimeout, statementTimeout) {
  try {
    await client.query(`set lock_timeout = '${lockTimeout}'`);
    await client.query(`set statement_timeout = '${statementTimeout}'`);
  } catch (error) {
    die("could not establish bounded preflight reads.", error.message);
  }
}

async function constraintDefinitions(client, names) {
  const result = await client.query(`
    select n.nspname as schema_name, cl.relname as table_name, c.conname,
           c.contype, c.convalidated, pg_get_constraintdef(c.oid, true) as definition
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public' and c.conname = any($1::text[])
  `, [names]);
  return new Map(result.rows.map((row) => [
    constraintKey(row.schema_name, row.table_name, row.conname), row,
  ]));
}

async function requireConstraints(client, contracts, type = "c") {
  const definitions = await constraintDefinitions(client, contracts.map(([name]) => name));
  return contracts.map(([name, table, definition]) =>
    requiredConstraint(definitions, name, table, definition, type)).filter(Boolean);
}

async function columnMap(client, table) {
  const result = await client.query(`
    select column_name, data_type, udt_name, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'public' and table_name = $1
  `, [table]);
  return new Map(result.rows.map((row) => [row.column_name, row]));
}

function requireColumn(columns, table, name, expected) {
  const row = columns.get(name);
  if (!row) return `required column public.${table}.${name} is absent`;
  for (const [field, value] of Object.entries(expected)) {
    const actual = row[field];
    if (field === "column_default") {
      if (normalizeDefinition(actual) !== normalizeDefinition(value)) {
        return `public.${table}.${name} default differs: ${actual}`;
      }
    } else if (actual !== value) return `public.${table}.${name} ${field} is ${actual}, expected ${value}`;
  }
  return null;
}

async function indexMap(client, names) {
  const result = await client.query(`
    select ns.nspname as schema_name, tbl.relname as table_name,
           idx.relname as index_name, i.indisunique, i.indisvalid, i.indisready,
           pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      join pg_class idx on idx.oid = i.indexrelid
      join pg_class tbl on tbl.oid = i.indrelid
      join pg_namespace ns on ns.oid = tbl.relnamespace
     where ns.nspname = 'public' and idx.relname = any($1::text[])
  `, [names]);
  return new Map(result.rows.map((row) => [row.index_name, row]));
}

function requireIndex(indexes, contract) {
  const [name, table, unique, definition] = contract;
  const row = indexes.get(name);
  if (!row) return `${name} is absent`;
  if (row.schema_name !== "public" || row.table_name !== table) return `${name} is attached to ${row.schema_name}.${row.table_name}`;
  if (row.indisunique !== unique) return `${name} uniqueness differs`;
  if (!row.indisvalid || !row.indisready) return `${name} is not valid and ready`;
  if (normalizeDefinition(row.definition) !== normalizeDefinition(definition)) return `${name} definition differs: ${row.definition}`;
  return null;
}

async function inspect194Prerequisites(client) {
  const failures = [];
  const terms = await columnMap(client, "application_proposed_terms_confirmations");
  const applications = await columnMap(client, "lease_applications");
  for (const [columns, table, name, expected] of [
    [terms, "application_proposed_terms_confirmations", "application_offer_id", { data_type: "uuid", is_nullable: "YES" }],
    [terms, "application_proposed_terms_confirmations", "application_terms_hash", { data_type: "text", is_nullable: "YES" }],
    [applications, "lease_applications", "term_source", { data_type: "text", is_nullable: "YES" }],
  ]) {
    const failure = requireColumn(columns, table, name, expected);
    if (failure) failures.push(failure);
  }
  const requiredWork = await columnMap(client, "unit_triage_required_work");
  for (const [name, expected] of [
    ["scope_kind", { data_type: "text", is_nullable: "NO", column_default: "'unspecified'::text" }],
    ["space_id", { data_type: "uuid", is_nullable: "YES" }],
  ]) {
    const failure = requireColumn(requiredWork, "unit_triage_required_work", name, expected);
    if (failure) failures.push(failure);
  }
  const requiredConstraints = [
    ["required_work_target_shape", "unit_triage_required_work", "CHECK (scope_kind = 'rentable_space'::text AND space_id IS NOT NULL OR scope_kind <> 'rentable_space'::text AND space_id IS NULL)"],
  ];
  failures.push(...await requireConstraints(client, requiredConstraints));
  failures.push(...await requireConstraints(client, [[
    "required_work_space_unit", "unit_triage_required_work",
    "FOREIGN KEY (space_id, unit_id) REFERENCES spaces(id, unit_id)",
  ]], "f"));
  const indexes = await indexMap(client, ["spaces_work_target_identity"]);
  const indexFailure = requireIndex(indexes, ["spaces_work_target_identity", "spaces", true,
    "CREATE UNIQUE INDEX spaces_work_target_identity ON public.spaces USING btree (id, unit_id)"]);
  if (indexFailure) failures.push(indexFailure);
  return failures;
}

async function inspect195(client, ceiling) {
  const contracts = ceiling >= 195 ? CHECK_195_POST : CHECK_195_PRE;
  const failures = await requireConstraints(client, contracts);
  const definitions = await constraintDefinitions(client, ["aptc_derived_names_offer_ck"]);
  const derived = definitions.get(constraintKey("public", "application_proposed_terms_confirmations", "aptc_derived_names_offer_ck"));
  if (ceiling < 195 && derived) failures.push("195 derived-confirmation CHECK exists before migration 195");
  return failures;
}

async function inspect196(client, ceiling) {
  const failures = [];
  const columns = await columnMap(client, "proposed_records");
  const names = ["selected_unit_id", "selected_space_id", "inventory_identity_decision_id"];
  if (ceiling < 196) {
    for (const name of names) if (columns.has(name)) failures.push(`196 column proposed_records.${name} exists too early`);
    const identityRows = await client.query("select count(*)::int as count from proposed_records where target_type = 'inventory_identity'");
    if (identityRows.rows[0].count !== 0) failures.push(`${identityRows.rows[0].count} incompatible pre-196 inventory_identity row(s) exist`);
    return failures;
  }
  for (const name of names) {
    const failure = requireColumn(columns, "proposed_records", name, { data_type: "uuid", is_nullable: "YES" });
    if (failure) failures.push(failure);
  }
  failures.push(...await requireConstraints(client, CHECK_196));
  failures.push(...await requireConstraints(client, FK_196, "f"));
  const indexes = await indexMap(client, INDEX_196.map(([name]) => name));
  for (const contract of INDEX_196) {
    const failure = requireIndex(indexes, contract);
    if (failure) failures.push(failure);
  }
  return failures;
}

async function inspect197(client, ceiling) {
  const failures = [];
  const objects = await client.query(`
    select to_regclass('public.inventory_correction_commands')::text as commands,
           to_regprocedure('public.refuse_operative_attachment_to_retired_inventory()')::text as policy_function
  `);
  const expectedTriggerNames = triggerTables().map((entry) => `trg_retired_inventory_${entry.table}`);
  const triggerResult = await client.query(`
    select ns.nspname as schema_name, tbl.relname as table_name, trg.tgname,
           trg.tgenabled, pg_get_triggerdef(trg.oid, true) as definition,
           fn.proname as function_name
      from pg_trigger trg
      join pg_class tbl on tbl.oid = trg.tgrelid
      join pg_namespace ns on ns.oid = tbl.relnamespace
      join pg_proc fn on fn.oid = trg.tgfoid
     where not trg.tgisinternal and trg.tgname = any($1::text[])
  `, [expectedTriggerNames]);
  if (ceiling < 197) {
    if (objects.rows[0].commands) failures.push("inventory_correction_commands exists before migration 197");
    if (objects.rows[0].policy_function) failures.push("197 policy function exists before migration 197");
    if (triggerResult.rowCount) failures.push("one or more 197 policy triggers exist before migration 197");
    return failures;
  }
  if (!objects.rows[0].commands) failures.push("inventory_correction_commands is absent");
  if (!objects.rows[0].policy_function) failures.push("197 policy function is absent");
  const functionResult = await client.query(`
    select ns.nspname as schema_name, p.proname, l.lanname,
           pg_get_function_result(p.oid) as result_type,
           pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where ns.nspname='public' and p.proname='refuse_operative_attachment_to_retired_inventory'
       and p.pronargs=0
  `);
  if (functionResult.rowCount !== 1 || functionResult.rows[0].lanname !== "plpgsql" ||
      functionResult.rows[0].result_type !== "trigger") failures.push("197 policy function signature differs");
  if (functionResult.rowCount === 1) {
    const functionHash = crypto.createHash("sha256")
      .update(normalizeDefinition(functionResult.rows[0].definition)).digest("hex");
    if (functionHash !== REVIEWED_197_FUNCTION_SHA256) {
      failures.push(`197 policy function body differs from reviewed pg_get_functiondef hash: ${functionHash}`);
    }
  }

  const byName = new Map(triggerResult.rows.map((row) => [row.tgname, row]));
  for (const entry of triggerTables()) {
    const name = `trg_retired_inventory_${entry.table}`;
    const row = byName.get(name);
    if (!row) { failures.push(`${name} is absent from public.${entry.table}`); continue; }
    const call = `EXECUTE FUNCTION refuse_operative_attachment_to_retired_inventory('${entry.status_column || ""}', '${entry.terminal.join(",")}', '${entry.null_means}')`;
    if (row.schema_name !== "public" || row.table_name !== entry.table || row.tgenabled !== "O" ||
        row.function_name !== "refuse_operative_attachment_to_retired_inventory" ||
        !row.definition.includes("BEFORE INSERT OR UPDATE ON") ||
        !row.definition.includes("FOR EACH ROW") || !row.definition.includes(call)) {
      failures.push(`${name} relation, timing, enabled state, function, or arguments differ: ${row.definition}`);
    }
  }

  const columns = await columnMap(client, "inventory_correction_commands");
  const commandColumns = [
    ["id", { data_type: "uuid", is_nullable: "NO", column_default: "gen_random_uuid()" }],
    ["property_id", { data_type: "uuid", is_nullable: "NO" }],
    ["command_type", { data_type: "text", is_nullable: "NO" }],
    ["idempotency_key", { data_type: "text", is_nullable: "NO" }],
    ["payload_hash", { data_type: "text", is_nullable: "NO" }],
    ["input", { data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" }],
    ["result", { data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" }],
    ["actor_user_id", { data_type: "uuid", is_nullable: "YES" }],
    ["assignment_id", { data_type: "uuid", is_nullable: "YES" }],
    ["recorded_at", { data_type: "timestamp with time zone", is_nullable: "NO", column_default: "now()" }],
  ];
  for (const [name, expected] of commandColumns) {
    const failure = requireColumn(columns, "inventory_correction_commands", name, expected);
    if (failure) failures.push(failure);
  }
  failures.push(...await requireConstraints(client, [[
    "inventory_correction_commands_command_type_check", "inventory_correction_commands",
    "CHECK (command_type = ANY (ARRAY['retire'::text, 'reinstate'::text]))",
  ]]));
  failures.push(...await requireConstraints(client, [
    ["inventory_correction_commands_property_id_fkey", "inventory_correction_commands",
      "FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE"],
    ["inventory_correction_commands_actor_user_id_fkey", "inventory_correction_commands",
      "FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT"],
  ], "f"));
  const indexes = await indexMap(client, [
    "uq_inventory_correction_commands_key", "idx_inventory_correction_commands_property",
  ]);
  for (const contract of [
    ["uq_inventory_correction_commands_key", "inventory_correction_commands", true,
      "CREATE UNIQUE INDEX uq_inventory_correction_commands_key ON public.inventory_correction_commands USING btree (property_id, command_type, idempotency_key)"],
    ["idx_inventory_correction_commands_property", "inventory_correction_commands", false,
      "CREATE INDEX idx_inventory_correction_commands_property ON public.inventory_correction_commands USING btree (property_id, recorded_at DESC)"],
  ]) {
    const failure = requireIndex(indexes, contract);
    if (failure) failures.push(failure);
  }
  return failures;
}

async function inspect198(client, ceiling) {
  const indexes = await indexMap(client, ["uq_proposed_natural"]);
  const failure = requireIndex(indexes, ceiling >= 198 ? INDEX_198_POST : INDEX_198_PRE);
  return failure ? [failure] : [];
}

async function inspect(client, files) {
  const rows = (await client.query("select version, name from schema_migrations order by version")).rows;
  const verdict = classifyLedger({ files, ledgerRows: rows });
  if (!verdict.structurallySound) {
    die("the migration ledger is malformed or disagrees with this build.", JSON.stringify(verdict, null, 2));
  }
  const state = decideState({ files, rows, verdict });
  if (!state.ok) die("ledger/build is not an exact reviewed 194-198 state.", state.reason);
  const failures = [
    ...await inspect194Prerequisites(client),
    ...await inspect195(client, state.ceiling),
    ...await inspect196(client, state.ceiling),
    ...await inspect197(client, state.ceiling),
    ...await inspect198(client, state.ceiling),
  ];
  if (failures.length) {
    die(`ledger ${state.ceiling} does not carry its exact physical schema.`,
      failures.map((failure) => `- ${failure}`).join("\n"));
  }
  return state;
}

function runCanonicalMigration(state, pin, lockTimeout, statementTimeout) {
  const result = spawnSync(process.execPath, [path.join(MIGRATIONS, "migrate.js"), "--apply"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_RELEASE: "1",
      EXPECTED_LEDGER_CEILING: String(state.ceiling),
      EXPECTED_SHA: pin,
      MIGRATION_LOCK_TIMEOUT: lockTimeout,
      // The canonical runner owns each transaction and already sets the lock
      // timeout locally. PGOPTIONS gives that unchanged runner a positive,
      // session-wide statement timeout for every DDL and ledger statement.
      PGOPTIONS: `-c statement_timeout=${statementTimeout}`,
    },
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) {
    die("the canonical migration runner failed; inspect the exact ledger and physical state before retry or resume.",
      `exit ${result.status}`);
  }
}

(async () => {
  const command = parseCommand(process.argv.slice(2));
  if (!command) {
    die("unknown command arguments.",
      "Usage: node tools/release/migration_194_198_predeploy.js [--apply|--resume195|--resume196|--resume197]");
  }
  if (process.env.MIGRATION_RELEASE) {
    die("MIGRATION_RELEASE must not be set by the caller.",
      "Only the child canonical apply process receives release authority.");
  }
  const url = String(process.env.DATABASE_URL || "").trim();
  if (!url) die("DATABASE_URL is required.");
  const files = migrationFiles();
  const pin = exactBuildPin(files);
  verifyReviewedHashes();
  const lockTimeout = interval("MIGRATION_PREFLIGHT_LOCK_TIMEOUT", "10s");
  const statementTimeout = interval("MIGRATION_PREFLIGHT_STATEMENT_TIMEOUT", "30s");
  const applyLockTimeout = interval("MIGRATION_APPLY_LOCK_TIMEOUT", "10s");
  const applyStatementTimeout = interval("MIGRATION_APPLY_STATEMENT_TIMEOUT", "30s");

  let client = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await client.connect();
  let before;
  try {
    await establishBoundedPreflight(client, lockTimeout, statementTimeout);
    before = await inspect(client, files);
  } finally { await client.end(); }
  console.log(`COMBINED MIGRATION 194-198 PREDEPLOY: exact ${before.ceiling} accepted ` +
    `(${before.entries} ledger rows); full pin, reviewed hashes, and physical fingerprint verified.`);

  if (command.kind === "verify") {
    if (before.ceiling !== 198) die("verify-only accepts exact 198 only.");
    console.log("VERIFY-ONLY: exact 198 verified; no migration was applied.");
    return;
  }
  if (before.ceiling !== command.ceiling) {
    die(`${command.kind} requires exact ${command.ceiling}, observed exact ${before.ceiling}.`);
  }
  runCanonicalMigration(before, pin, applyLockTimeout, applyStatementTimeout);

  client = new Client({ connectionString: url, ssl: databaseSsl(url) });
  await client.connect();
  let after;
  try {
    await establishBoundedPreflight(client, lockTimeout, statementTimeout);
    after = await inspect(client, files);
  } finally { await client.end(); }
  if (after.ceiling !== 198) die("canonical runner returned without exact 198 post-state.");
  console.log(`COMBINED MIGRATION 194-198 RELEASE VERIFIED: ${after.entries} ledger rows, ` +
    "ceiling 198, all reviewed physical contracts present.");
})().catch((error) => die("the operation threw.", error && error.stack ? error.stack : String(error)));
