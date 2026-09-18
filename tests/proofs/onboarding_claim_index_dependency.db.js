"use strict";

/*
  Migration 198 turns the reviewed retained-source claim-index policy into the
  numbered chain. This owned witness reconstructs the exact 197 index state,
  runs the real migrations/migrate.js runner across the current successor
  suffix, and proves its failure and success branches rather than treating a
  hidden psql step as a release.

  THE SUCCESSOR SUFFIX IS DERIVED FROM DISK, NOT HARDCODED. This file used to
  hardcode '199' as "the current successor" and the repeat-release ceiling.
  When migration 200 landed, every EXPECTED_LEDGER_CEILING call below still
  said '197' (correct, unchanged — 198's fixed numeric predecessor) or '199'
  (now wrong: the real post-release ceiling was 200), and the proof went red
  with "RELEASE REFUSED ... the database says 200" — the identical defect
  found and fixed the same day in tests/e2e/verify_all.sh's "restore numbered
  198-200 ledger" step (commit de9b199e), which itself repeated a pattern
  first fixed for 199 in commit 3b92d652. Reading migrations/ at runtime for
  FROM_BASELINE / NEWEST_VERSION means the next migration above 200 does not
  require this file to be hand-edited again.
*/
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");
const { normalizeName } = require("../../migrations/ledger_verdict.js");
require("../e2e/proof_fence_preload.js");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATE = path.join(ROOT, "migrations", "migrate.js");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const DB_URL = boundary.manifest().url;
const EXPECTED = 16;
let passed = 0, failed = 0, pool;

const OLD_INDEX = "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE (natural_key IS NOT NULL)";
const NEW_INDEX = "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE ((natural_key IS NOT NULL) AND (import_source_row_id IS NULL))";
const normalized = sql => String(sql).replace(/\s+/g, "").toLowerCase();

// This proof is ABOUT migration 198's claim-index policy specifically — that
// literal is the reviewed SUBJECT under test, not an artifact of how many
// migrations now sit above it, so it stays a literal on purpose. '197' is
// 198's fixed numeric predecessor: a historical fact that cannot change,
// because every file below 198 is immutable history.
const BASELINE_VERSION = "198";
const PREDECESSOR_CEILING = "197";
const ALL_MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => /^\d{3}_.*\.sql$/.test(f))
  .sort();
// Every migration file at or above 198, in order — whatever the chain has
// grown to. FROM_BASELINE[0] is always 198's own file; the rest are the
// "successor suffix" this witness must remove and the real runner must
// restore alongside 198.
const FROM_BASELINE = ALL_MIGRATION_FILES.filter(f => f.slice(0, 3) >= BASELINE_VERSION);
const BASELINE_FILE = FROM_BASELINE.find(f => f.slice(0, 3) === BASELINE_VERSION);
const SUCCESSOR_FILES = FROM_BASELINE.filter(f => f !== BASELINE_FILE);
const NEWEST_VERSION = FROM_BASELINE[FROM_BASELINE.length - 1].slice(0, 3);
if (!BASELINE_FILE) throw new Error(`migration ${BASELINE_VERSION} is not on disk under ${MIGRATIONS_DIR}`);

function ok(label, condition, detail = "") {
  if (condition) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}
async function one(sql, values = []) { return (await pool.query(sql, values)).rows[0]; }
async function indexDefinition() {
  const row = await one(`select pg_get_indexdef(i.indexrelid) as definition
    from pg_index i join pg_class c on c.oid=i.indexrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='uq_proposed_natural'`);
  return row && row.definition;
}
function runMigration(expectedCeiling, lockTimeout) {
  const env = { ...process.env, DATABASE_URL: DB_URL, MIGRATION_RELEASE: "1",
    EXPECTED_LEDGER_CEILING: String(expectedCeiling) };
  delete env.EXPECTED_SHA; delete env.RENDER_GIT_COMMIT;
  if (lockTimeout) env.MIGRATION_LOCK_TIMEOUT = lockTimeout;
  const result = spawnSync(process.execPath, [MIGRATE, "--apply"], {
    cwd: ROOT, encoding: "utf8", env, windowsHide: true,
  });
  return { code: result.status == null ? -1 : result.status,
    output: String(result.stdout || "") + String(result.stderr || "") };
}
async function rejected(action) {
  try { await action(); return null; } catch (error) { return error; }
}
async function count(table, where, values) {
  return Number((await one(`select count(*)::int as n from ${table} where ${where}`, values)).n);
}

(async () => {
  receipt.begin(__filename, { url: DB_URL, expected: EXPECTED });
  await boundary.assertDatabase();
  pool = new Pool({ connectionString: DB_URL, ssl: false });

  const beforeLedger = await one("select name from schema_migrations where version=$1", [BASELINE_VERSION]);
  ok(`numbered ${BASELINE_VERSION} is present before the witness`,
    beforeLedger && normalizeName(beforeLedger.name) === normalizeName(BASELINE_FILE), JSON.stringify(beforeLedger));
  ok(`numbered ${BASELINE_VERSION} has the reviewed source-row index predicate`,
    normalized(await indexDefinition()) === normalized(NEW_INDEX), await indexDefinition());
  const successorRows = [];
  for (const file of SUCCESSOR_FILES) {
    const version = file.slice(0, 3);
    successorRows.push({ version, file, row: await one("select name from schema_migrations where version=$1", [version]) });
  }
  ok(`the current successor migration(s) are present before the witness (${SUCCESSOR_FILES.map(f => f.slice(0, 3)).join(", ") || "none"})`,
    successorRows.every(({ file, row }) => row && normalizeName(row.name) === normalizeName(file)),
    JSON.stringify(successorRows));

  // Actual pre-198 state: exact prior index and an exact 197 ledger. A numbered
  // ledger cannot keep a successor while 198 is absent, so every ledger row
  // from 198 through whatever is newest on disk is removed temporarily and
  // the canonical runner restores the whole suffix. RECONSTRUCT_VERSIONS is
  // derived from FROM_BASELINE (disk), not a hardcoded pair.
  const RECONSTRUCT_VERSIONS = FROM_BASELINE.map(f => f.slice(0, 3));
  await pool.query("delete from schema_migrations where version = any($1::text[])", [RECONSTRUCT_VERSIONS]);
  await pool.query("drop index uq_proposed_natural");
  await pool.query(`create unique index uq_proposed_natural
    on proposed_records (activation_id, target_type, natural_key)
    where natural_key is not null`);
  const stillPresentAfterReconstruct = (await pool.query(
    "select version from schema_migrations where version = any($1::text[])", [RECONSTRUCT_VERSIONS])).rows;
  ok("owned witness reconstructed exact 197 ledger/index state",
    stillPresentAfterReconstruct.length === 0 &&
    normalized(await indexDefinition()) === normalized(OLD_INDEX), await indexDefinition());

  const tag = `claim-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const human = await one("insert into persons(name) values($1) returning id", [tag]);
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
    [tag, `${tag}@example.test`, org.id, human.id]);
  const deals = require("../../src/onboarding/deal_service.js");
  const activation = require("../../src/onboarding/activation_service.js");
  const artifacts = require("../../src/onboarding/source_artifact_service.js");
  const { reviewedIngest } = require("../helpers/reviewed_source.js");
  const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: tag, creation_source: "deal_setup_console" });
  const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
    values($1,$1,$2,'bed') returning id`, [tag, org.id]);
  await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id });
  const opened = await activation.openActivation(pool,
    { user_id: user.id, deal_intake_id: deal.id, property_id: property.id });
  const bytes = Buffer.from("Unit,Room,Resident,Actual Rent\n101,Room1,Synthetic Current,850\nFuture Residents/Applicants\n101,Room1,Synthetic Future,900\n");
  const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: property.id,
    filename: "same-home-current-and-future.csv", mimetype: "text/csv", buffer: bytes,
    uploaded_by_user_id: user.id, source_as_of_date: "2026-07-31" });
  const ingestArgs = { user_id: user.id, deal_intake_id: deal.id, property_id: property.id,
    activation_id: opened.activation.id, source_artifact_id: artifact.id, source_as_of_date: "2026-07-31" };

  const preError = await rejected(() => reviewedIngest(activation, pool, ingestArgs));
  ok("197 index rejects distinct source rows sharing one natural home key",
    preError && preError.code === "23505" && preError.constraint === "uq_proposed_natural",
    preError && String(preError.stack || preError));
  ok("pre-198 23505 rolls back batch and proposal writes",
    await count("import_batches", "property_id=$1", [property.id]) === 0 &&
    await count("proposed_records", "activation_id=$1", [opened.activation.id]) === 0);
  const retained = await one("select content from source_artifacts where id=$1", [artifact.id]);
  ok("pre-198 refusal retains its exact source bytes",
    retained && Buffer.compare(retained.content, bytes) === 0);

  // A real runner failure after BEGIN must leave both the index and the ledger
  // in the state the next release attempt can truthfully inspect.
  const blocker = await pool.connect();
  await blocker.query("begin");
  await blocker.query("lock table proposed_records in access exclusive mode");
  const locked = runMigration(PREDECESSOR_CEILING, "100ms");
  await blocker.query("rollback"); blocker.release();
  ok(`held table lock makes the real ${BASELINE_VERSION} runner fail within its timeout`,
    locked.code !== 0 && /lock timeout|canceling statement due to lock timeout/i.test(locked.output),
    `exit=${locked.code}\n${locked.output.slice(-900)}`);
  const stillGoneAfterLockFailure = (await pool.query(
    "select version from schema_migrations where version = any($1::text[])", [RECONSTRUCT_VERSIONS])).rows;
  ok("lock failure leaves ledger 197 and the old physical index intact",
    stillGoneAfterLockFailure.length === 0 &&
    normalized(await indexDefinition()) === normalized(OLD_INDEX), await indexDefinition());

  const released = runMigration(PREDECESSOR_CEILING, "2s");
  const releasedEveryFile = FROM_BASELINE.every(file => released.output.includes(file));
  ok(`real runner restores ${BASELINE_VERSION} and the current successor suffix from exact 197`,
    released.code === 0 && releasedEveryFile,
    `exit=${released.code}\n${released.output.slice(-900)}`);

  const appliedRows = [];
  for (const file of FROM_BASELINE) {
    const version = file.slice(0, 3);
    appliedRows.push({ version, file, row: await one("select name,applied_at from schema_migrations where version=$1", [version]) });
  }
  const applied198 = appliedRows.find(r => r.version === BASELINE_VERSION).row;
  const afterDefinition = await indexDefinition();
  ok(`${BASELINE_VERSION} records its ledger row and exact reviewed physical predicate, and every successor through ${NEWEST_VERSION} is restored`,
    appliedRows.every(({ file, row }) => row && normalizeName(row.name) === normalizeName(file)) &&
    normalized(afterDefinition) === normalized(NEW_INDEX),
    JSON.stringify({ appliedRows, afterDefinition }));

  // The repeat-release rehearsal must expect the ceiling the ledger is
  // ACTUALLY at after the real release above — the newest file on disk,
  // derived, not a hardcoded successor version. Hardcoding this the way the
  // old '199' literal did is exactly what broke when migration 200 landed.
  const repeat = runMigration(NEWEST_VERSION, "2s");
  const afterRepeat = await one("select name,applied_at from schema_migrations where version=$1", [BASELINE_VERSION]);
  ok("repeat release is a no-op with unchanged ledger receipt and index",
    repeat.code === 0 && /Everything was already up to date/.test(repeat.output) &&
    afterRepeat && String(afterRepeat.applied_at) === String(applied198.applied_at) &&
    normalized(await indexDefinition()) === normalized(afterDefinition),
    `exit=${repeat.code}\n${repeat.output.slice(-700)}`);

  const succeeded = await reviewedIngest(activation, pool, ingestArgs);
  const staged = (await pool.query(`select natural_key, import_source_row_id, normalized_json->>'section' as section
    from proposed_records where activation_id=$1 and target_type='lease'
    order by normalized_json->>'section'`, [opened.activation.id])).rows;
  ok("198 retains both distinct source rows for one source home",
    succeeded.rows_read === 2 && staged.length === 2 &&
    new Set(staged.map(row => row.import_source_row_id)).size === 2 &&
    new Set(staged.map(row => row.natural_key)).size === 1 &&
    staged.map(row => row.section).join(",") === "current,future", JSON.stringify(staged));

  const replayError = await rejected(() => reviewedIngest(activation, pool, ingestArgs));
  ok("same activation replay refuses without double-staging evidence",
    replayError && (replayError.reason === "setup_already_read_source" ||
      replayError.reason === "already_established_from_this_file" ||
      /already been read/i.test(replayError.message || "")) &&
    await count("proposed_records", "activation_id=$1 and target_type='lease'", [opened.activation.id]) === 2,
    replayError && String(replayError.stack || replayError));

  const legacyActivation = (await activation.openActivation(pool,
    { user_id: user.id, deal_intake_id: deal.id, property_id: property.id })).activation;
  await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,status)
    values($1,$2,'leasing','lease','legacy-no-source','staged')`, [legacyActivation.id, property.id]);
  const legacyError = await rejected(() => pool.query(`insert into proposed_records
    (activation_id,property_id,module,target_type,natural_key,status)
    values($1,$2,'leasing','lease','legacy-no-source','staged')`, [legacyActivation.id, property.id]));
  ok("198 retains the old non-source natural-key duplicate refusal",
    legacyError && legacyError.code === "23505" && legacyError.constraint === "uq_proposed_natural",
    legacyError && String(legacyError.stack || legacyError));
  ok("non-source duplicate refusal leaves exactly one original claim",
    await count("proposed_records", "activation_id=$1 and natural_key='legacy-no-source'", [legacyActivation.id]) === 1);

  process.exitCode = receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: EXPECTED });
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  if (pool) await pool.end();
});
