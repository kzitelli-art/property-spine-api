"use strict";

/*
  Migration 198 turns the reviewed retained-source claim-index policy into the
  numbered chain. This owned witness reconstructs the exact 197 index state,
  runs the real migrations/migrate.js runner, and proves its failure and
  success branches rather than treating a hidden psql step as a release.
*/
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");
const receipt = require("../_run_receipt.js");
const boundary = require("../e2e/proof_boundary.js");
const { normalizeName } = require("../../migrations/ledger_verdict.js");
require("../e2e/proof_fence_preload.js");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATE = path.join(ROOT, "migrations", "migrate.js");
const DB_URL = boundary.manifest().url;
const EXPECTED = 15;
let passed = 0, failed = 0, pool;

const OLD_INDEX = "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE (natural_key IS NOT NULL)";
const NEW_INDEX = "CREATE UNIQUE INDEX uq_proposed_natural ON public.proposed_records USING btree (activation_id, target_type, natural_key) WHERE ((natural_key IS NOT NULL) AND (import_source_row_id IS NULL))";
const normalized = sql => String(sql).replace(/\s+/g, "").toLowerCase();

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

  const beforeLedger = await one("select name from schema_migrations where version='198'");
  ok("numbered 198 is present before the witness",
    beforeLedger && normalizeName(beforeLedger.name) === "proposed_source_claim_identity", JSON.stringify(beforeLedger));
  ok("numbered 198 has the reviewed source-row index predicate",
    normalized(await indexDefinition()) === normalized(NEW_INDEX), await indexDefinition());

  // Actual pre-198 state: exact prior index and an exact 197 ledger.
  await pool.query("delete from schema_migrations where version='198'");
  await pool.query("drop index uq_proposed_natural");
  await pool.query(`create unique index uq_proposed_natural
    on proposed_records (activation_id, target_type, natural_key)
    where natural_key is not null`);
  ok("owned witness reconstructed exact 197 ledger/index state",
    !(await one("select 1 from schema_migrations where version='198'")) &&
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
  const locked = runMigration("197", "100ms");
  await blocker.query("rollback"); blocker.release();
  ok("held table lock makes the real 198 runner fail within its timeout",
    locked.code !== 0 && /lock timeout|canceling statement due to lock timeout/i.test(locked.output),
    `exit=${locked.code}\n${locked.output.slice(-900)}`);
  ok("lock failure leaves ledger 197 and the old physical index intact",
    !(await one("select 1 from schema_migrations where version='198'")) &&
    normalized(await indexDefinition()) === normalized(OLD_INDEX), await indexDefinition());

  const released = runMigration("197", "2s");
  ok("real runner applies only 198 from exact 197",
    released.code === 0 && /198_proposed_source_claim_identity\.sql/.test(released.output),
    `exit=${released.code}\n${released.output.slice(-900)}`);
  const applied = await one("select name,applied_at from schema_migrations where version='198'");
  const afterDefinition = await indexDefinition();
  ok("198 records its ledger row and exact reviewed physical predicate",
    applied && applied.name === "proposed_source_claim_identity" &&
    normalized(afterDefinition) === normalized(NEW_INDEX),
    JSON.stringify({ applied, afterDefinition }));

  const repeat = runMigration("198", "2s");
  const afterRepeat = await one("select name,applied_at from schema_migrations where version='198'");
  ok("repeat release is a no-op with unchanged ledger receipt and index",
    repeat.code === 0 && /Everything was already up to date/.test(repeat.output) &&
    afterRepeat && String(afterRepeat.applied_at) === String(applied.applied_at) &&
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
