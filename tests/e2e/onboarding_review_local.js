"use strict";

// Windows-local orchestration around the existing owned-database/server fence.
// Only the companion wrapper may provide this newly initialized cluster.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");
const boundary = require("./proof_boundary.js");
const ROOT = path.resolve(__dirname, "../..");
const runRoot = fs.realpathSync(process.env.PSPINE_OWNED_CLUSTER_ROOT);
const token = process.env.PSPINE_OWNED_CLUSTER_TOKEN;
assert.match(token || "", /^[a-f0-9]{32}$/);
assert.equal(path.dirname(runRoot).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
assert.equal(path.basename(runRoot), `spine-onboarding-proof-${token}`);
assert.equal(fs.readFileSync(path.join(runRoot, "owner.txt"), "utf8").trim(), token);
boundary.validateInputs(process.env);
const appRoot = fs.realpathSync(process.env.PSPINE_APP_ROOT);
const childLog = fs.openSync(path.join(runRoot, "server.log"), "a");
let server;
let pool;
const children = new Set();
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore","pipe","pipe"], ...options });
    if (child.stdout) child.stdout.on("data",chunk=>{process.stdout.write(chunk);fs.appendFileSync(path.join(runRoot,"proof-stages.log"),chunk);});
    if (child.stderr) child.stderr.on("data",chunk=>{process.stderr.write(chunk);fs.appendFileSync(path.join(runRoot,"proof-stages.log"),chunk);});
    children.add(child);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code !== 0) reject(new Error(`Proof subprocess failed (${code || signal}): ${path.basename(command)}`));
      else resolve();
    });
  });
}
async function stopServer() {
  if (!server) return;
  if (server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Owned server did not exit")), 5000);
      server.once("exit", () => { clearTimeout(timeout); resolve(); });
      server.kill("SIGTERM");
    });
  }
  server = null;
  await boundary.portFree(Number(process.env.PORT));
}
(async () => {
  fs.mkdirSync(process.env.PROOF_OUTPUT_DIR, { recursive: true });
  const boundaryLog = fs.openSync(path.join(runRoot, "boundary.log"), "a");
  try { await run(process.execPath, [path.join(__dirname, "proof_boundary.js"), "create"], { stdio: ["ignore", boundaryLog, boundaryLog] }); }
  finally { fs.closeSync(boundaryLog); }
  const owned = boundary.manifest(false);
  process.env.E2E_DATABASE_URL = owned.url;
  process.env.E2E_API_BASE = `http://127.0.0.1:${process.env.PORT}`;
  await boundary.assertDatabase();
  for (const log of ["E2E_SMS_LOG", "E2E_ANTHROPIC_LOG", "E2E_EGRESS_LOG", "E2E_SESSION_LOG"]) fs.writeFileSync(process.env[log], "");
  const migrationLog = fs.openSync(path.join(runRoot, "migrations.log"), "a");
  try { await run("C:\\Program Files\\Git\\bin\\bash.exe", ["tests/e2e/apply_migrations.sh"], { stdio: ["ignore", migrationLog, migrationLog] }); }
  finally { fs.closeSync(migrationLog); }
  console.log("REAL_MIGRATION_CHAIN_APPLIED");
  const parentRoot = path.resolve(process.env.ONBOARDING_PARENT_ROOT || path.join(ROOT, "../qb-proof-checkpoint"));
  if (process.env.ONBOARDING_SPACE_PROOF_ONLY !== "1") {
  await run(process.execPath, [path.join(ROOT, "tests/proofs/canonical_onboarding_source.db.js")], {
    env: { ...process.env, PROOF_EXPECT_DEFECT: "1", PROOF_BUSINESS_ROOT: parentRoot },
  });
  await run(process.execPath, [path.join(ROOT, "tests/proofs/canonical_onboarding_lifecycle.db.js")], {
    env: { ...process.env, PROOF_EXPECT_DEFECT: "1", PROOF_BUSINESS_ROOT: parentRoot,HARNESS_DATABASE_URL:owned.url },
  });
  await run(process.execPath, [path.join(ROOT, "tests/proofs/canonical_onboarding_snapshot.db.js")], {
    env: { ...process.env, PROOF_EXPECT_DEFECT: "1", PROOF_BUSINESS_ROOT: parentRoot,HARNESS_DATABASE_URL:owned.url },
  });
  }
  const { Pool } = require("pg");
  pool = new Pool({ connectionString: owned.url, ssl: false });
  const baselineMode = process.env.PROOF_EXPECT_SHIPPED_HEADER_FAILURE === "1";
  const spaceParentMode = process.env.ONBOARDING_SPACE_PROOF_ONLY === "1" && process.env.PROOF_SPACE_EXPECT_DEFECT === "1";
  const businessRoot = spaceParentMode && process.env.ONBOARDING_SPACE_PARENT_ROOT
    ? fs.realpathSync(process.env.ONBOARDING_SPACE_PARENT_ROOT) : baselineMode ? parentRoot : ROOT;
  if (spaceParentMode) {
    assert.equal(execFileSync("git",["rev-parse","HEAD"],{cwd:businessRoot,encoding:"utf8",windowsHide:true}).trim(),
      "018e6d621ef7e2e3bd4c074f6c7d6f97e5811061", "space defect witness requires its inspected parent");
    for (const file of ["src/onboarding/activation_service.js","src/shared/snapshot_loader.js"]) {
      assert.equal(execFileSync("git",["diff","HEAD","--",file],{cwd:businessRoot,encoding:"utf8",windowsHide:true}).trim(),"",
        "space defect witness cannot run a modified parent");
    }
  }
  if (baselineMode) {
    assert.equal(execFileSync("git",["rev-parse","HEAD"],{cwd:appRoot,encoding:"utf8",windowsHide:true}).trim(),"4849545118fc422177bc604389608cdbb55df458");
    execFileSync("git",["diff","--exit-code","HEAD","--","index.html"],{cwd:appRoot,windowsHide:true,stdio:"pipe"});
  }
  if (!baselineMode) {
    await run(process.execPath, [path.join(ROOT,"tests/proofs/onboarding_claim_index_dependency.db.js")], {
      env: {...process.env,PROOF_CLAIM_INDEX:"released"},
    });
    await boundary.assertDatabase();
    await pool.query(fs.readFileSync(path.join(ROOT,"migrations/pending/proposed_source_claim_identity.sql"),"utf8"));
    console.log("PENDING_CLAIM_INDEX_APPLIED_TO_OWNED_LOCAL_DB_ONLY");
    await run(process.execPath, [path.join(ROOT,"tests/proofs/onboarding_claim_index_dependency.db.js")], {
      env: {...process.env,PROOF_CLAIM_INDEX:"pending"},
    });
    for (const proof of (process.env.ONBOARDING_SPACE_PROOF_ONLY === "1" ? [] : ["canonical_onboarding_source.db.js","canonical_onboarding_ledger.db.js","canonical_onboarding_lifecycle.db.js","canonical_onboarding_snapshot.db.js","deal_setup_http.db.js"])) {
      await run(process.execPath, [path.join(ROOT,"tests/proofs",proof)], {
        env: {...process.env,PROOF_EXPECT_DEFECT:"0",PROOF_BUSINESS_ROOT:ROOT,HARNESS_DATABASE_URL:owned.url},
      });
    }
  }
  const tag = `Review-${randomUUID()}`;
  const one = async (sql, values) => (await pool.query(sql, values)).rows[0];
  const org = await one("insert into organizations(name,slug) values($1,$2) returning id", [tag, tag.toLowerCase()]);
  const person = await one("insert into persons(name) values($1) returning id", ["Synthetic Review Operator"]);
  const user = await one(`insert into users(name,email,platform_role,organization_id,is_active,status,person_id,account_kind)
    values('Synthetic Review Operator',$1,'org_admin',$2,true,'active',$3,'human_staff') returning id`, [`${tag}@example.test`, org.id, person.id]);
  const seat = await one("insert into properties(name,canonical_key,organization_id) values($1,$2,$3) returning id", [tag, tag, org.id]);
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,allowed_modules,active)
    values($1,$2,'Proof Manager','{management,leasing}',true)`, [seat.id, user.id]);
  const client = await pool.connect();
  let session;
  try {
    await client.query("begin");
    session = (await require("../../src/identity/staff_session_service.js").issueStaffSession(client,
      { userId: user.id, propertyId: seat.id, purpose: "sms_otp" })).session_token;
    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; }
  finally { client.release(); }
  await boundary.portFree(Number(process.env.PORT));
  const apiSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: businessRoot, encoding: "utf8", windowsHide: true }).trim();
  const custody = {};
  for (const [label,cwd] of [["api",businessRoot],["app",appRoot]]) {
    const diff = execFileSync("git",["diff","HEAD","--"],{cwd,windowsHide:true});
    custody[label] = {head:execFileSync("git",["rev-parse","HEAD"],{cwd,encoding:"utf8",windowsHide:true}).trim(),
      tracked_diff_sha256:createHash("sha256").update(diff).digest("hex"),
      working_tree_clean:execFileSync("git",["status","--porcelain"],{cwd,encoding:"utf8",windowsHide:true}).trim() === ""};
    const changed = [...new Set([
      ...execFileSync("git",["diff","--name-only","HEAD"],{cwd,encoding:"utf8",windowsHide:true}).trim().split(/\r?\n/),
      ...execFileSync("git",["ls-files","--others","--exclude-standard"],{cwd,encoding:"utf8",windowsHide:true}).trim().split(/\r?\n/),
    ].filter(Boolean))].sort();
    custody[label].changed_file_sha256 = Object.fromEntries(changed.map(file=>[file,
      fs.existsSync(path.join(cwd,file)) ? createHash("sha256").update(fs.readFileSync(path.join(cwd,file))).digest("hex") : "deleted"]));
  }
  fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"worktree-custody.json"),JSON.stringify(custody,null,2));
  const startServer = async () => {
  server = spawn(process.execPath, [
    "--require", path.join(__dirname, "proof_fence_preload.js"),
    "--require", path.join(__dirname, "fake_sms_preload.js"),
    "--require", path.join(__dirname, "fake_anthropic_preload.js"), "server.js"], {
    cwd: businessRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: boundary.serverEnvironment({ OPERATOR_KEY: "e2e-key", PORT: process.env.PORT,
      E2E_SERVER_ROOT: businessRoot, RENDER_GIT_COMMIT: apiSha, OPERATOR_APP_ORIGIN: "http://localhost:5173" }),
  });
  server.stdout.on("data", chunk => fs.writeSync(childLog, chunk));
  server.stderr.on("data", chunk => fs.writeSync(childLog, chunk));
  // Cold module loading on this Windows/OneDrive workspace can exceed the
  // standard 30-second readiness window. Retry that timeout only, at most four
  // windows, retaining the same owned process/port/nonce and every refusal.
  for (let attempt = 1; ; attempt++) {
    try {
      await boundary.waitServer(process.env.E2E_API_BASE, () => server.exitCode === null && server.signalCode === null);
      break;
    } catch (error) {
      if (error.message !== "Owned server readiness was not proven" || attempt === 4) throw error;
      console.log(`OWNED_API_COLD_START_WAIT=${attempt}`);
    }
  }
  console.log(`OWNED_API_READY=${apiSha}`);
  };
  await startServer();
  if (!baselineMode) {
    await run(process.execPath,[path.join(ROOT,"tests/proofs/onboarding_space_availability.db.js")]);
  }
  const runBrowser = async phase => run(process.execPath, [path.join(appRoot, baselineMode ? "canonical_onboarding_first_red.browser.js" : "canonical_onboarding_review.browser.js")], {
    cwd: appRoot,
    env: { ...process.env, SP: ROOT, API: process.env.E2E_API_BASE, SESSION: session,
      PROOF_PHASE:phase,PROOF_REVIEW_STATE:path.join(process.env.PROOF_OUTPUT_DIR,"review-state.private.json"),
      PROOF_SYNTHETIC_STATE:path.join(process.env.PROOF_OUTPUT_DIR,"mixed-state.private.json"),
      PROOF_SPACE_STATE:path.join(process.env.PROOF_OUTPUT_DIR,"space-state.private.json"),
      PROOF_API_SHA: apiSha, PROOF_APP_SHA: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8", windowsHide: true }).trim() },
  });
  if (!baselineMode && !spaceParentMode && process.env.PROOF_SPACE_BROWSER === "1") await runBrowser("spaces");
  if (process.env.ONBOARDING_SPACE_PROOF_ONLY === "1") {
    for (const name of ["E2E_SMS_LOG","E2E_ANTHROPIC_LOG","E2E_EGRESS_LOG"]) assert.equal(fs.statSync(process.env[name]).size,0);
    return;
  }
  await runBrowser("stage");
  if (!baselineMode) {
    const state = JSON.parse(fs.readFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"review-state.private.json"),"utf8"));
    const snapshots = async () => {
      const result = [];
      for (const source of state.sources) {
        const act = await one("select * from activations where id=$1",[source.activation_id]);
        assert.equal(act.status,"open");
        assert.equal(act.source_artifact_id,source.artifact_id);
        const artifact = await one("select * from source_artifacts where id=$1",[source.artifact_id]);
        assert.equal(artifact.scope_id,source.property_id);
        assert.equal(artifact.sha256.toUpperCase(),source.source_sha256.toUpperCase());
        assert.equal(createHash("sha256").update(artifact.content).digest("hex").toUpperCase(),source.source_sha256.toUpperCase());
        const batch = await one("select * from import_batches where id=$1",[act.import_batch_id]);
        assert.equal(batch.source_artifact_id,source.artifact_id);
        const rows = (await pool.query("select * from import_source_rows where import_batch_id=$1 order by row_index,id",[batch.id])).rows;
        const proposals = (await pool.query("select * from proposed_records where activation_id=$1 order by id",[act.id])).rows;
        assert.equal(rows.length,source.review_counts.total);
        assert.equal(proposals.length,rows.length);
        assert.equal(new Set(proposals.map(p=>p.import_source_row_id)).size,rows.length);
        assert.ok(proposals.every(p=>p.target_type === "lease" && rows.some(row=>row.id === p.import_source_row_id)));
        assert.ok(rows.every(row=>!row.produced_person_id && !row.produced_lease_id));
        const counts = await one(`select
          (select count(*)::int from units where property_id=$1) units,
          (select count(*)::int from spaces s join units u on u.id=s.unit_id where u.property_id=$1) spaces,
          (select count(*)::int from leases where property_id=$1) leases,
          (select count(*)::int from persons where import_batch_id=$2) persons,
          (select count(*)::int from opening_tenancy_positions where property_id=$1) positions`,[source.property_id,batch.id]);
        assert.deepEqual(counts,{units:source.label === "july" ? 64 : 72,spaces:source.label === "july" ? 105 : 160,leases:0,persons:0,positions:0});
        const operating = await require("../../src/shared/snapshot_loader.js").readLatestSnapshot(pool,source.property_id,"2026-07-31");
        assert.equal(operating.has_data,false,"Review-only evidence cannot become the operating snapshot");
        const dated = await require("../../src/tenancy/dated_positions.js").datedPropertyPositions(pool,{property_id:source.property_id,as_of:"2026-07-31"});
        assert.equal(dated.opening_truth.latest_confirmed_source,null);
        assert.equal(dated.opening_baseline,null);
        assert.equal(dated.positions.length,counts.spaces);
        assert.ok(dated.positions.every(position=>position.basis_state === "not_established" && position.lease === null && position.contributes_trusted_rent === false));
        // Exercise Ask Spine's real fact-gathering boundary as well as the
        // direct readers. No model/provider call; do not claim answer/HTTP proof.
        const askClient = await pool.connect();
        try {
          await askClient.query("begin isolation level repeatable read read only");
          const { gatherFacts } = require("../../src/agent/ask_spine_answer.js");
          const facts = await gatherFacts(askClient, {
            property_id: source.property_id, allowed_modules: ["management"], subject: "tenancy",
          });
          assert.equal(facts.tenancy.read_state,"OK");
          assert.equal(facts.tenancy.standing.truth_state,"NOT_ESTABLISHED");
          assert.equal(facts.tenancy.established_from,null,"Ask Spine cannot cite the open review as established source");
          assert.equal(facts.tenancy.position.rentable_positions,counts.spaces);
          assert.equal(facts.tenancy.position.not_established,counts.spaces);
          for (const key of ["established","occupied","open","positions_with_a_known_next"]) {
            assert.equal(facts.tenancy.position[key],0,`Ask Spine review-only ${key}`);
          }
          const denied = await gatherFacts(askClient, {
            property_id: source.property_id, allowed_modules: [], subject: "tenancy",
          });
          assert.equal(denied.tenancy,undefined,"Unentitled tenancy facts never enter the gathered envelope");
          await askClient.query("rollback");
        } catch (error) { await askClient.query("rollback").catch(()=>{}); throw error; }
        finally { askClient.release(); }
        const fingerprint = createHash("sha256").update(JSON.stringify({act,batch,rows,proposals,counts})).digest("hex");
        result.push({label:source.label,counts,rows:rows.length,proposals:proposals.length,fingerprint});
      }
      return result;
    };
    const before = await snapshots();
    await stopServer();
    console.log("OWNED_API_STOPPED_FOR_RESTART_PROOF");
    await startServer();
    await runBrowser("restart");
    const after = await snapshots();
    assert.deepEqual(after,before,"Restart and review preserve every source, claim, decision and inventory record");
    fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"canonical-review-db-receipt.json"),JSON.stringify({
      source_lineage_verified:true,restart_unchanged:true,real_source_confirmations:0,
      ask_spine_fact_gathering_verified:true,ask_spine_http_or_model_answer_tested:false,
      sources:after.map(({fingerprint,...safe})=>safe),custody},null,2));
    console.log("REAL_SOURCE_DB_LINEAGE_AND_RESTART_PROOF_PASSED");
    // Separate synthetic fixture exercises a genuine mixed HTTP outcome.
    // The real-source properties above remain review-only.
    const deals = require("../../src/onboarding/deal_service.js");
    const activation = require("../../src/onboarding/activation_service.js");
    const artifacts = require("../../src/onboarding/source_artifact_service.js");
    const mixedName = `Synthetic mixed review ${randomUUID()}`;
    const mixedDeal = await deals.createDeal(pool,{user_id:user.id,deal_name:mixedName,creation_source:"deal_setup_console"});
    const mixedProperty = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id",[mixedName,org.id]);
    await deals.addProperty(pool,{user_id:user.id,deal_intake_id:mixedDeal.id,property_id:mixedProperty.id});
    const mixedAct = (await activation.openActivation(pool,{user_id:user.id,deal_intake_id:mixedDeal.id,property_id:mixedProperty.id})).activation;
    const mixedArtifact = await artifacts.store(pool,{scope_type:"property",scope_id:mixedProperty.id,filename:"synthetic-mixed.csv",mimetype:"text/csv",
      buffer:Buffer.from("Unit,Room,Resident,Market Rent,Actual Rent\n101,Room1,VACANT,900,\n102,Room1,VACANT,900,\n"),
      uploaded_by_user_id:user.id,source_as_of_date:"2026-07-31"});
    await activation.ingestRentRoll(pool,{user_id:user.id,deal_intake_id:mixedDeal.id,property_id:mixedProperty.id,activation_id:mixedAct.id,source_artifact_id:mixedArtifact.id,source_as_of_date:"2026-07-31"});
    const occupied = await one("select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and u.unit_number='102'",[mixedProperty.id]);
    await pool.query("insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status) values($1,$2,$3,900,'2026-01-01','2027-12-31','active')",[mixedProperty.id,occupied.id,[person.id]]);
    fs.writeFileSync(path.join(process.env.PROOF_OUTPUT_DIR,"mixed-state.private.json"),JSON.stringify({deal_id:mixedDeal.id,property_id:mixedProperty.id,property_name:mixedName,activation_id:mixedAct.id,
      ready_before:2,expected_added:1,expected_refused:1,expected_remaining:0,expected_refusal_error:"vacancy_contradicted_by_operative_lease"}));
    await runBrowser("mixed");
    const mixedCounts = (await activation.readActivation(pool,{user_id:user.id,activation_id:mixedAct.id})).counts;
    assert.deepEqual(mixedCounts,{promoted:1,needs_review:1});
    assert.deepEqual(await snapshots(),before,"Synthetic mixed proof cannot alter either real source review");
    console.log("SYNTHETIC_MIXED_CONFIRM_ALL_DB_PROOF_PASSED");
  }
  for (const name of ["E2E_SMS_LOG", "E2E_ANTHROPIC_LOG", "E2E_EGRESS_LOG"]) {
    assert.equal(fs.statSync(process.env[name]).size, 0, `No external provider work: ${name}`);
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => {
    try {
      for (const child of children) child.kill("SIGTERM");
      await stopServer();
      if (pool) await pool.end();
      if (fs.existsSync(process.env.E2E_PROOF_MANIFEST)) {
        await run(process.execPath, [path.join(__dirname, "proof_boundary.js"), "cleanup"]);
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { fs.closeSync(childLog); }
  });
