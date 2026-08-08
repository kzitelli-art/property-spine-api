#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 2 — PROVE THE BOUNDARY, NOT JUST THE MIGRATION

   After Step 2, production is a state that has never run anywhere:

       schema 137  +  the OLD writer

   The Steps 2–3 candidate proved schema 137 against the NEW writer. That
   is a different thing, and it is not the state Step 2 creates. This
   branch carries main's `src/` untouched, so this file proves the actual
   post-Step-2 combination by running it.

   ── AND IT MEASURES THE DEPLOY GATE IN BOTH DIRECTIONS ──────────────

   `prestart` runs `migrate.js` with no `--apply`, which is VERIFY-ONLY
   and refuses to boot on a mismatch — in EITHER direction:

     file in the build, not in the ledger   → REFUSING TO START
     version in the ledger, no file here    → LEDGER VERSION MISSING

   Those two refusals are what force Step 2 and Step 3 to be separate
   production events, and together they define the only safe ordering.
   They are asserted here by running the real script against a real
   database, because a deployment sequence derived from reading code is a
   guess, and this one has a window in it that must not be guessed at.

   ⚠ ISOLATED POSTGRES ONLY. Starts from the ledger-136 baseline.

   usage:
     bash tools/steps23/baseline_136.sh
     STEP2_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/steps23/prove_step2_boundary.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const M137 = path.join(ROOT, "migrations/137_release_0_completion_proof.sql");
const HELD = path.join(ROOT, "migrations", ".137_held_by_step2_proof");
const URL = process.env.STEP2_DATABASE_URL;

const M137_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(M137)).digest("hex");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const runMigrate = (args = [], env = {}) => spawnSync(process.execPath,
  [path.join(ROOT, "migrations/migrate.js"), ...args],
  { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL, ...env } });

const ID = (n) => crypto.createHash("md5").update("step2:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");

(async function main() {
  if (!URL) { console.error("REFUSED: STEP2_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '60s'");

  console.log("STEP 2 BOUNDARY PROOF — schema 137 against the OLD writer\n");

  /*  This proof describes ONE state: schema 137 with the OLD writer. If the
   *  Step 3 writer is present, that state does not exist here and every
   *  result below would be about the wrong code.
   *
   *  It REFUSES rather than reporting failures. On the Step 3 branch the
   *  writer is supposed to be there, and a wall of red FAILs would read as
   *  "Step 2's proof broke" when the truth is "this is the wrong commit for
   *  this question". Exit 3 distinguishes wrong-commit from proof-failed. */
  const lifecycleSrc = fs.readFileSync(path.join(ROOT, "src/technician/lifecycle_service.js"), "utf8");
  const step3Present = /recordEvaluation\(/.test(lifecycleSrc)
    || fs.existsSync(path.join(ROOT, "src/maintenance/proof_evaluation_service.js"));
  if (step3Present) {
    console.error("REFUSED: the Step 3 completion writer is present in this checkout.");
    console.error("         This proof is about schema 137 against the OLD writer, which");
    console.error("         is the state the Step 2 deploy creates. Run it at the Step 2");
    console.error("         commit. For the writer itself, use tools/steps23/prove.js.");
    await c.end();
    process.exit(3);
  }
  sec("B · THIS CHECKOUT IS STEP 2 ONLY");
  ok("B1  lifecycle_service writes NO proof evaluation here", true);
  ok("B2  the evaluation service does not exist here", true);

  // ══ D — THE DEPLOY GATE REFUSES A PENDING MIGRATION ════════════════
  sec("D · A DEPLOY CANNOT MIGRATE — verify mode refuses, both directions");
  {
    //  Direction 1: the file is in the build, the ledger is at 136.
    //  This is what Render does the moment the Step 2 PR merges.
    const before = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
    ok("D0  starting from ledger 136", before === "136", String(before));

    const boot = runMigrate();
    ok("D1  with 137 pending, verify mode REFUSES TO START (exit non-zero)",
       boot.status !== 0, "exit " + boot.status);
    ok("D2  …and names the pending migration rather than booting anyway",
       /REFUSING TO START/.test(boot.stdout + boot.stderr) &&
       /137_release_0_completion_proof/.test(boot.stdout + boot.stderr),
       (boot.stdout + boot.stderr).split("\n").filter(Boolean).slice(-4).join(" | "));
    const after = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
    ok("D3  …and it applied NOTHING while refusing", after === "136", String(after));
    console.log("        → merging Step 2 makes the Render deploy FAIL at prestart.");
    console.log("          That is the gate working, not an incident. The old");
    console.log("          instance keeps serving; nothing is migrated.");
  }

  // ══ A — THE RELEASE, AS THE DEPLOY ITSELF ══════════════════════════
  sec("A · APPLYING IT AS PART OF THE DEPLOY — no window at all");
  {
    /*  ── THIS IS THE RUNBOOK, AND IT SUPERSEDES AN EARLIER ONE ───────
     *
     *  The first version of the Step 2 runbook said: merge, let the deploy
     *  fail, apply from an external checkout, then redeploy. That works,
     *  but it opens the W window below — the ledger moves while the live
     *  build has no file for it.
     *
     *  migrate.js already supports the better path, and the support is
     *  deliberate: APPLY is chosen from the ENVIRONMENT
     *  (`MIGRATION_RELEASE=1`), and when `RENDER_GIT_COMMIT` is present it
     *  additionally demands `EXPECTED_SHA` — a branch exists solely to pin
     *  a release to one deployed build. So `prestart` CAN apply, but only
     *  for a named commit, authorised by someone who read the ledger.
     *
     *  Setting those three variables makes ONE deploy apply the migration
     *  and then boot. There is no interval where the ledger is ahead of
     *  the running build, so W never opens.
     *
     *  The cost is that the auto-apply behaviour is armed while they are
     *  set, which is the 121/126 failure mode. A3–A5 measure what the
     *  guards actually do about that. */
    const RENDER = { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "136",
                     EXPECTED_SHA: "abc123def456", RENDER_GIT_COMMIT: "abc123def4567890" };
    const t0 = Date.now();
    //  No --apply flag: this is `prestart` verbatim, with the env set.
    const rel = runMigrate([], RENDER);
    const ms = Date.now() - t0;
    ok("A1  prestart WITH the release env applies 137 and exits 0", rel.status === 0,
       (rel.stdout + rel.stderr).split("\n").filter(Boolean).slice(-5).join(" | "));
    const v = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
    ok("A2  the ledger advances to 137 inside that same deploy", v === "137", String(v));
    console.log("        applied in " + ms + " ms (process wall time, empty tables)");
    console.log("        → the deploy that applies is the deploy that boots. No window.");

    //  ── WHAT HAPPENS IF THE VARIABLES ARE LEFT BEHIND ───────────────
    //  This is the question that decides whether the path is safe, and
    //  the answer is NOT "nothing". Left set, the NEXT deploy refuses and
    //  the service does not boot. Loud, not silent — but it must be
    //  cleaned up, and "remove them afterwards" is a step, not advice.
    const leftover = runMigrate([], RENDER);
    ok("A3  LEFT BEHIND, the next deploy REFUSES on the stale ceiling",
       leftover.status !== 0 && /not in the expected state/i.test(leftover.stdout + leftover.stderr),
       "exit " + leftover.status + " — it booted, so a stale release env is silent. " +
       "That would be the 121/126 failure mode re-armed.");
    console.log("        → so REMOVING them is a step. Forgetting fails the next");
    console.log("          deploy loudly rather than migrating something silently.");

    const wrongSha = runMigrate([], { ...RENDER, EXPECTED_LEDGER_CEILING: "137",
                                      EXPECTED_SHA: "deadbeef" });
    ok("A4  a release pinned to a DIFFERENT build is REFUSED",
       wrongSha.status !== 0 && /not the build you authorised/i.test(wrongSha.stdout + wrongSha.stderr),
       "exit " + wrongSha.status);

    const noSha = runMigrate([], { MIGRATION_RELEASE: "1", EXPECTED_LEDGER_CEILING: "137",
                                   RENDER_GIT_COMMIT: "abc123def4567890" });
    ok("A5  on a Render deploy, EXPECTED_SHA is REQUIRED — omitting it refuses",
       noSha.status !== 0 && /EXPECTED_SHA is required/i.test(noSha.stdout + noSha.stderr),
       "exit " + noSha.status + " — then the release is not pinned to a build");

    const noCeiling = runMigrate([], { MIGRATION_RELEASE: "1", EXPECTED_SHA: "abc123def456",
                                       RENDER_GIT_COMMIT: "abc123def4567890" });
    ok("A6  …and so is EXPECTED_LEDGER_CEILING — a release cannot be run unlooked",
       noCeiling.status !== 0 && /EXPECTED_LEDGER_CEILING is required/i.test(noCeiling.stdout + noCeiling.stderr),
       "exit " + noCeiling.status);
  }

  // ══ V — THE DEPLOY WILL NOW BOOT ═══════════════════════════════════
  sec("V · WITH THE RELEASE ENV REMOVED, VERIFY MODE PASSES");
  {
    //  Removing the variables on Render triggers a redeploy, which is
    //  convenient rather than annoying: it proves the ordinary boot path
    //  works, immediately, instead of leaving it to be discovered later.
    const boot = runMigrate([], { RENDER_GIT_COMMIT: "abc123def4567890" });
    ok("V1  verify mode EXITS 0 with 137 applied and present",
       boot.status === 0, "exit " + boot.status + " — the deploy would not boot");
    ok("V2  …and says so in both directions",
       /SCHEMA VERIFIED/.test(boot.stdout) && /both directions checked/.test(boot.stdout),
       boot.stdout.split("\n").filter(Boolean).slice(-4).join(" | "));
  }

  // ══ W — THE WINDOW THE RUNBOOK AVOIDS ══════════════════════════════
  sec("W · WHY NOT TO APPLY OUT-OF-BAND — the window this would open");
  {
    /*  Kept, and still proven, because it is the REASON section A is the
     *  runbook. Applying from an external checkout moves the ledger while
     *  the live build has no file for it, and a restart in that interval
     *  refuses to boot. The deploy-time path in A never creates it.
     *
     *  Between "137 applied" and "the build containing 137 is live", the
     *  RUNNING build has no file for a ledger version.
     *
     *  Held by MOVING the file, restored in `finally` and verified by
     *  digest — the same discipline baseline_136.sh uses, because a proof
     *  that can leave the tree modified is a proof that can lie later. */
    let boot;
    try {
      fs.renameSync(M137, HELD);
      boot = runMigrate();
    } finally {
      if (fs.existsSync(HELD)) fs.renameSync(HELD, M137);
    }
    ok("W1  ledger 137 with NO file in the build REFUSES TO START",
       boot.status !== 0, "exit " + boot.status + " — then the window is harmless and " +
       "the ordering below is over-cautious");
    ok("W2  …and names it as a ledger version this build cannot describe",
       /LEDGER VERSION MISSING FROM THIS REPOSITORY/.test(boot.stdout + boot.stderr),
       (boot.stdout + boot.stderr).split("\n").filter(Boolean).slice(-4).join(" | "));
    ok("W3  the migration file is restored byte-for-byte",
       fs.existsSync(M137) && !fs.existsSync(HELD) &&
       crypto.createHash("sha256").update(fs.readFileSync(M137)).digest("hex") === M137_DIGEST);
    console.log("        → the running instance is UNAFFECTED (migrate.js runs only at");
    console.log("          prestart), but it cannot RESTART until the build carries the");
    console.log("          file. Keep the window short and quiet.");
  }

  // ══ O — THE OLD WRITER AGAINST SCHEMA 137 ══════════════════════════
  sec("O · THE OLD WRITER, UNCHANGED, AGAINST SCHEMA 137");
  {
    await c.query(`insert into organizations (id,name) values ($1,'Step2 Org')
                   on conflict (id) do nothing`, [ORG]);
    await c.query(`insert into properties (id,name,organization_id) values ($1,'Step2 Property',$2)
                   on conflict (id) do nothing`, [PROP, ORG]);
    await c.query(`insert into users (id,name,phone,role,is_active)
                   values ($1,'Tess Step2','+15415559201','maintenance',true)
                   on conflict (id) do nothing`, [TECH]);
    await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                   values ($1,$2,'Maintenance Tech',true)`, [TECH, PROP]).catch(() => {});

    const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));

    const mk = async (n) => {
      const wo = ID("wo" + n);
      await c.query(`insert into work_orders (id,property_id,title,status,source)
                     values ($1,$2,'step2','open','step2proof')`, [wo, PROP]);
      await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                     values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
      return wo;
    };
    const photo = async (wo) => {
      const att = ID("att" + wo.slice(0, 8)), bytes = Buffer.from([5, 5, 5, 5]);
      await c.query(`insert into work_order_proof_attachments
        (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
         storage_state,proof_classification,content,byte_size,sha256,stored_at)
        values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
        [att, wo, PROP, TECH, "ME" + att.slice(0, 8), bytes, bytes.length,
         crypto.createHash("sha256").update(bytes).digest("hex")]);
    };
    const inTx = async (fn) => {
      await c.query("begin");
      try { const out = await fn(); await c.query("commit"); return { out }; }
      catch (e) { await c.query("rollback").catch(() => {}); return { err: e }; }
    };

    const woA = await mk("A");
    const fact = await inTx(() => lifecycle.reportFieldFact(c, {
      kind: "en_route", work_order_id: woA, user_id: TECH, organization_id: ORG,
      idempotency_key: "step2-a" }));
    ok("O1  the old writer records a field fact against schema 137",
       !fact.err && fact.out.outcome === "recorded", fact.err && fact.err.message);

    //  The redelivery path too: the savepoint fix is already on main, and
    //  Step 2 must not disturb it.
    const replay = await inTx(() => lifecycle.reportFieldFact(c, {
      kind: "en_route", work_order_id: woA, user_id: TECH, organization_id: ORG,
      idempotency_key: "step2-a" }));
    ok("O2  …and the savepoint replay path still works at schema 137",
       !replay.err && replay.out.outcome === "replayed",
       replay.err ? replay.err.code + " " + replay.err.message : replay.out.outcome);

    const woB = await mk("B");
    await photo(woB);
    const done = await inTx(() => lifecycle.claimCompletion(c, {
      work_order_id: woB, user_id: TECH, organization_id: ORG, idempotency_key: "step2-b" }));
    const st = (await c.query(`select status from work_orders where id=$1`, [woB])).rows[0].status;
    ok("O3  the OLD completion path still closes a work order at schema 137",
       !done.err && done.out.closed === true && st === "complete",
       (done.err && done.err.message) || JSON.stringify({ closed: done.out && done.out.closed, st }));

    //  And the point of the boundary: Step 2 adds the CAPACITY to record
    //  proof, not the proof itself. Nothing writes an evaluation yet, and
    //  saying otherwise after this deploy would be a false claim.
    const evals = Number((await c.query(
      `select count(*) n from work_order_proof_evaluations`)).rows[0].n);
    const links = Number((await c.query(
      `select count(*) n from work_order_proof_evaluation_attachments`)).rows[0].n);
    ok("O4  NO evaluation was written — the tables stay empty after Step 2",
       evals === 0 && links === 0, JSON.stringify({ evals, links }));
    ok("O5  and no activation row exists — the reader is not switched on",
       Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) === 0);
    console.log("        → after Step 2, completion means exactly what it meant before.");
    console.log("          The capacity to record proof exists; nothing records it.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  //  Never leave the migration held on an unexpected failure.
  if (fs.existsSync(HELD)) { try { fs.renameSync(HELD, M137); } catch (_) {} }
  console.error("\nERROR:\n" + (e && e.stack || e));
  process.exit(1);
});
