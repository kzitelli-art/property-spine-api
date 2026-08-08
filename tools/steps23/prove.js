#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEPS 2–3 — INTEGRATED PROOF

   Applies the migration-137 candidate to an isolated ledger-136 database
   and then runs the completion writer against the ACTUAL new schema.

   ⚠ ISOLATED POSTGRES ONLY. Refuses unless the scale-harness sentinel row
     is present — identity, not a port number.

   Sections:
     M   migration application, timing, locks, reads and writes during
     N   negative matrix          every refusal, and what it left behind
     J   success matrix           jpeg/png/webp, supersession, replay
     H   idempotency + REAL concurrency (overlapping transactions)
     X   mixed-version model      old API/reader against schema 137
     C   chain invariants after every write

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/steps23/prove.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATION = path.join(ROOT, "migrations/137_release_0_completion_proof.sql");
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const evidence = require(path.join(ROOT, "src/technician/evidence_service.js"));
const proofEvaluations = require(path.join(ROOT, "src/maintenance/proof_evaluation_service.js"));

const URL = process.env.PROVE_DATABASE_URL;
let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

/*  Every connection gets a lock timeout. A proof harness that can hang
 *  indefinitely is worse than one that fails: the hang reads as slow work
 *  and the run never produces a verdict. 8s is far longer than any
 *  legitimate step here, so a timeout means a real lock problem and the
 *  error names the statement that hit it. */
const open = async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '30s'");
  return c;
};

//  Deterministic ids so a failure names the same row on every run.
const ID = (n) => crypto.createHash("md5").update("steps23:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");

const ORG = ID("org"), PROP = ID("prop"), PROP2 = ID("prop2");
const TECH = ID("tech"), OTHER = ID("other"), UNIT = ID("unit"), SPACE = ID("space");

async function seed(c) {
  //  Individually, each tolerant: the evaluation tables do not exist
  //  until 137 is applied, and one multi-statement block would abandon
  //  every later delete when the first one failed.
  for (const q of [
    "delete from work_order_proof_evaluation_attachments where true",
    "delete from work_order_proof_evaluations where true",
    "delete from work_order_proof_attachments where true",
    "delete from work_order_progress where true",
    "delete from obligations where related_type='work_order'",
    "delete from work_orders where source='steps23'",
  ]) await c.query(q).catch(() => {});
  await c.query(`insert into organizations (id,name) values ($1,'Steps23 Org')
                 on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values
                 ($1,'Steps23 Property',$3),($2,'Steps23 Other',$3)
                 on conflict (id) do update set organization_id=excluded.organization_id`,
                [PROP, PROP2, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active) values
                 ($1,'Tess Tech','+15415551001','maintenance',true),
                 ($2,'Otto Other','+15415551002','maintenance',true)
                 on conflict (id) do nothing`, [TECH, OTHER]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                 values ($1,$2,'Maintenance Tech',true),($1,$3,'Maintenance Tech',true),
                        ($4,$2,'Maintenance Tech',true)`, [TECH, PROP, PROP2, OTHER]);
}

/*  One work order + its obligation. Returns ids. */
let woSeq = 0;
async function makeWorkOrder(c, { property_id = PROP, status = "open" } = {}) {
  const id = ID("wo" + (++woSeq));
  await c.query(`insert into work_orders (id,property_id,title,status,source)
                 values ($1,$2,'Steps23 fixture',$3,'steps23')`, [id, property_id, status]);
  await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status,assigned_user_id)
                 values ($1,$2,'work_order','maintenance','work_order_routing','route',$3,$4)`,
                [property_id, id, status === "complete" ? "complete" : "open", TECH]);
  return id;
}

/*  An attachment in any state we need to test. */
let attSeq = 0;
async function makeAttachment(c, { work_order_id, property_id = PROP, state = "stored",
  classification = "repair_photo", mime = "image/jpeg", bytes = Buffer.from([1, 2, 3, 4]),
  noSha = false, noStoredAt = false, noSize = false } = {}) {
  const id = ID("att" + (++attSeq));
  if (state !== "stored") {
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,storage_state,proof_classification)
      values ($1,$2,$3,$4,'twilio',$5,$6,$7,$8)`,
      [id, work_order_id, property_id, TECH, "ME" + id.slice(0, 8), mime, state, classification]);
    return id;
  }
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  await c.query(`insert into work_order_proof_attachments
    (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
     storage_state,proof_classification,content,byte_size,sha256,stored_at)
    values ($1,$2,$3,$4,'twilio',$5,$6,'stored',$7,$8,$9,$10,$11)`,
    [id, work_order_id, property_id, TECH, "ME" + id.slice(0, 8), mime, classification,
     bytes, noSize ? null : bytes.length, noSha ? null : sha, noStoredAt ? null : new Date()]);
  return id;
}

/*  Run claimCompletion the way production does: inside a transaction the
 *  CALLER owns, so a thrown error rolls every fact back together. */
async function claimInTx(c, args) {
  await c.query("begin");
  try {
    const out = await lifecycle.claimCompletion(c, args);
    await c.query("commit");
    return { ...out, threw: null };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { outcome: "threw", threw: e, closed: false };
  }
}

async function census(c, wo) {
  const q = async (s, a) => Number((await c.query(s, a)).rows[0].n);
  return {
    status: (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0].status,
    completed: await q(`select count(*) n from work_order_progress where work_order_id=$1 and kind='completed'`, [wo]),
    claimed: await q(`select count(*) n from work_order_progress where work_order_id=$1 and kind='completion_claimed'`, [wo]),
    evals: await q(`select count(*) n from work_order_proof_evaluations where work_order_id=$1`, [wo]),
    links: await q(`select count(*) n from work_order_proof_evaluation_attachments where work_order_id=$1`, [wo]),
    oblComplete: await q(`select count(*) n from obligations where related_id=$1 and status='complete'`, [wo]),
  };
}

/*  Chain invariants, checked after every write that touches a chain. */
async function chainOk(c, wo) {
  const g = Number((await c.query(
    `select count(*) n from work_order_proof_evaluations where work_order_id=$1 and supersedes_id is null`, [wo])).rows[0].n);
  const heads = Number((await c.query(
    `select count(*) n from work_order_proof_evaluations e where e.work_order_id=$1
       and not exists (select 1 from work_order_proof_evaluations s where s.supersedes_id=e.id)`, [wo])).rows[0].n);
  const total = Number((await c.query(
    `select count(*) n from work_order_proof_evaluations where work_order_id=$1`, [wo])).rows[0].n);
  const forks = Number((await c.query(
    `select coalesce(max(c),0) n from (select count(*) c from work_order_proof_evaluations
       where work_order_id=$1 and supersedes_id is not null group by supersedes_id) x`, [wo])).rows[0].n);
  return { genesis: g, heads, total, maxSuccessors: forks,
           valid: total === 0 ? (g === 0 && heads === 0) : (g === 1 && heads === 1 && forks <= 1) };
}

(async function main() {
  if (!URL) { console.error("REFUSED: PROVE_DATABASE_URL is not set."); process.exit(1); }
  const c0 = await open();
  const sentinel = Number((await c0.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) {
    console.error("REFUSED: harness sentinel absent. This is not the isolated baseline.");
    process.exit(2);
  }

  console.log("STEPS 2–3 INTEGRATED PROOF — isolated postgres");

  //  FIXTURES FIRST, BEFORE THE MIGRATION.
  //  The concurrent-writer observer below inserts a real work order, which
  //  needs a real property to exist. Seeding after the migration made that
  //  insert violate its FK, abort the observer's transaction, and the
  //  follow-up probe then reported "a concurrent writer was blocked by the
  //  migration" when the harness had broken the writer itself. A control
  //  that fails for its own reason is worse than no control.
  await seed(c0);

  // ══ M — THE MIGRATION ═══════════════════════════════════════════════
  sec("M · MIGRATION 137 APPLICATION");
  const before = (await c0.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("M1  baseline ledger is 136", before === "136", String(before));
  const sql = fs.readFileSync(MIGRATION, "utf8");

  //  ── PHASE 1: DOES AN ORDINARY WRITE BLOCK THIS MIGRATION? ────────
  //  Migration 137 creates tables whose FKs REFERENCE work_orders, and
  //  adding such a constraint takes SHARE ROW EXCLUSIVE on the referenced
  //  table. An ordinary INSERT holds ROW EXCLUSIVE. Those conflict.
  //
  //  This is measured rather than assumed, because the answer decides how
  //  the migration may be deployed. The first version of this section
  //  asserted "a concurrent writer still works" and would have shipped a
  //  comfortable claim that is false.
  const writer = await open();
  await writer.query("begin");
  await writer.query(`insert into work_orders (id,property_id,title,status,source)
                      values ($1,$2,'held open across the migration','open','steps23')`,
                     [ID("during"), PROP]);

  const probe = await open();
  await probe.query("set lock_timeout = '3s'");
  let blocked = false, blockErr = null;
  await probe.query("begin");
  try { await probe.query(sql); }
  catch (e) { blocked = /lock timeout/i.test(e.message); blockErr = e.message; }
  await probe.query("rollback").catch(() => {});
  await probe.end();

  ok("M2  an ordinary in-flight WRITE to work_orders BLOCKS migration 137",
     blocked === true,
     "expected a lock timeout; got: " + (blockErr || "the migration proceeded"));
  console.log("        → 137 takes SHARE ROW EXCLUSIVE on work_orders (FK creation).");
  console.log("          Deploy it against quiet write traffic, WITH a lock_timeout,");
  console.log("          so it fails fast instead of queueing behind a long");
  console.log("          transaction and blocking every writer behind it.");

  await writer.query("rollback").catch(() => {});
  await writer.end();

  //  ── PHASE 2: READS ARE UNAFFECTED, AND THE REAL APPLICATION ──────
  const reader = await open();
  await reader.query("begin");
  await reader.query(`select count(*) from work_orders`);

  const t0 = process.hrtime.bigint();
  await c0.query("begin");
  await c0.query(sql);
  await c0.query(`insert into schema_migrations (version,name) values ('137','release_0_completion_proof')`);
  await c0.query("commit");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log("  migration transaction: " + ms.toFixed(1) + " ms (no competing writer)");
  ok("M3  with no competing writer the migration applies in one transaction", true);

  const readerAlive = await reader.query(`select count(*) n from work_orders`)
    .then(() => true).catch(() => false);
  ok("M4  a concurrent READER held open ACROSS the migration is unaffected", readerAlive);
  await reader.query("rollback").catch(() => {});
  await reader.end();

  const after = (await c0.query(`select max(version) v from schema_migrations`)).rows[0].v;
  ok("M5  ledger is 137", after === "137", String(after));
  ok("M6  the four objects exist", Number((await c0.query(
    `select count(*) n from information_schema.tables where table_schema='public'
      and table_name in ('work_order_proof_evaluations','work_order_proof_evaluation_attachments',
                         'release_0_activation_history','release_0_legacy_cutover_inventory')`)).rows[0].n) === 4);
  ok("M7  the head views exist", Number((await c0.query(
    `select count(*) n from information_schema.views where table_schema='public'
      and table_name in ('work_order_proof_evaluation_head','release_0_activation_current')`)).rows[0].n) === 2);

  // ══ J — SUCCESS MATRIX ══════════════════════════════════════════════
  sec("J · SUCCESS MATRIX");
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo, mime });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG,
      note: "done", idempotency_key: "k-" + mime });
    const x = await census(c0, wo);
    const ch = await chainOk(c0, wo);
    ok(`J1  ${mime} evidence completes`, r.closed === true && x.status === "complete", r.threw && r.threw.message);
    ok(`J2  ${mime} → exactly one completed event, one evaluation, one link`,
       x.completed === 1 && x.evals === 1 && x.links === 1, JSON.stringify(x));
    ok(`J3  ${mime} → chain valid (1 genesis, 1 head)`, ch.valid, JSON.stringify(ch));
    ok(`J4  ${mime} → obligation closed`, x.oblComplete === 1, String(x.oblComplete));
  }

  {
    //  Multiple attachments, one valid: policy is satisfied by the valid
    //  one, and ONLY the eligible ones are linked.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo, state: "referenced" });
    await makeAttachment(c0, { work_order_id: wo, classification: "unclassified" });
    await makeAttachment(c0, { work_order_id: wo });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "k-multi" });
    const x = await census(c0, wo);
    ok("J5  one valid attachment among invalid ones completes", r.closed === true);
    ok("J6  ONLY the eligible attachment is linked (not the referenced/unclassified)",
       x.links === 1, "links=" + x.links);
  }

  {
    //  Supersession: a not_satisfied genesis, then a satisfied completion
    //  that must cite it rather than opening a second genesis.
    const wo = await makeWorkOrder(c0);
    await proofEvaluations.recordEvaluation(c0, { work_order_id: wo, property_id: PROP,
      state: "not_satisfied", evaluated_by_user_id: TECH, attachment_ids: [] });
    await makeAttachment(c0, { work_order_id: wo });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "k-sup" });
    const ch = await chainOk(c0, wo);
    const head = (await c0.query(`select * from work_order_proof_evaluation_head where work_order_id=$1`, [wo])).rows[0];
    ok("J7  completion SUPERSEDES a prior not_satisfied evaluation", r.closed === true && !!r.supersededEvaluationId);
    ok("J8  chain stays single-rooted after supersession", ch.valid && ch.total === 2, JSON.stringify(ch));
    ok("J9  the head is the satisfied evaluation", head && head.state === "satisfied", head && head.state);
  }

  {
    //  Replay of an already-successful claim.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const k = "k-replay";
    const a = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k });
    const x1 = await census(c0, wo);
    const b = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k });
    const x2 = await census(c0, wo);
    ok("J10 first claim completes", a.closed === true);
    ok("J11 replay does not add a second completed event",
       x2.completed === x1.completed && x2.completed === 1, `${x1.completed} → ${x2.completed}`);
    ok("J12 replay does not add a second evaluation genesis",
       x2.evals === x1.evals, `${x1.evals} → ${x2.evals}`);
    ok("J13 chain still valid after replay", (await chainOk(c0, wo)).valid);
  }

  // ══ N — NEGATIVE MATRIX ═════════════════════════════════════════════
  sec("N · NEGATIVE MATRIX — every refusal, and what it left behind");
  const negatives = [
    ["no attachment at all", async (wo) => {}],
    ["referenced attachment", async (wo) => { await makeAttachment(c0, { work_order_id: wo, state: "referenced" }); }],
    ["fetch_failed attachment", async (wo) => { await makeAttachment(c0, { work_order_id: wo, state: "fetch_failed" }); }],
    ["unclassified attachment", async (wo) => { await makeAttachment(c0, { work_order_id: wo, classification: "unclassified" }); }],
    ["access_attempt classification", async (wo) => { await makeAttachment(c0, { work_order_id: wo, classification: "access_attempt" }); }],
    ["attachment on ANOTHER work order", async (wo) => {
      const other = await makeWorkOrder(c0); await makeAttachment(c0, { work_order_id: other }); }],
    ["attachment on ANOTHER property", async (wo) => {
      await makeAttachment(c0, { work_order_id: wo, property_id: PROP2 }).catch(() => {}); }],
    ["attachment missing sha256", async (wo) => { await makeAttachment(c0, { work_order_id: wo, noSha: true }).catch(() => {}); }],
    ["attachment missing stored_at", async (wo) => { await makeAttachment(c0, { work_order_id: wo, noStoredAt: true }).catch(() => {}); }],
  ];
  for (const [label, setup] of negatives) {
    const wo = await makeWorkOrder(c0);
    await setup(wo);
    const b4 = await census(c0, wo);
    const r = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG,
      idempotency_key: "neg-" + label.replace(/\W/g, "") });
    const x = await census(c0, wo);
    const ch = await chainOk(c0, wo);
    ok(`N· ${label} → does NOT complete`, r.closed !== true, "it completed");
    ok(`   ${label} → status unchanged, no completed event, no evaluation, no link`,
       x.status === b4.status && x.completed === 0 && x.evals === 0 && x.links === 0,
       JSON.stringify(x));
    ok(`   ${label} → obligation not closed`, x.oblComplete === 0, String(x.oblComplete));
    ok(`   ${label} → chain empty and valid`, ch.valid && ch.total === 0, JSON.stringify(ch));
  }

  {
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: OTHER, organization_id: ORG, idempotency_key: "neg-wrongtech" });
    const x = await census(c0, wo);
    //  OTHER is on PROP, so the service-level rule permits them. This
    //  asserts what the SERVICE actually enforces rather than what a
    //  reader might assume, and the SMS lane's stricter assignment rule
    //  is proven separately at the selection layer.
    console.log("        (service rule is property eligibility — see X4 for the SMS lane's stricter rule)");
    ok("N· an eligible-but-different technician is permitted BY THE SERVICE", r.closed === true || x.completed === 1);
  }
  {
    const wo = await makeWorkOrder(c0, { property_id: PROP2 });
    await makeAttachment(c0, { work_order_id: wo, property_id: PROP2 });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: OTHER, organization_id: ORG, idempotency_key: "neg-outscope" });
    const x = await census(c0, wo);
    ok("N· actor OUTSIDE the work order's property → refused",
       r.refusal === "property_outside_actor_scope" || x.completed === 0, JSON.stringify(r.refusal));
    ok("   and nothing was written", x.completed === 0 && x.evals === 0);
  }
  {
    const wo = await makeWorkOrder(c0, { status: "complete" });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "neg-already" });
    ok("N· already complete → refused", r.refusal === "work_order_already_complete", JSON.stringify(r.refusal));
    ok("   and no second completed event", (await census(c0, wo)).completed === 0);
  }
  {
    //  Missing actor identity must refuse, never substitute a placeholder.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const r = await claimInTx(c0, { work_order_id: wo, user_id: null, organization_id: ORG, idempotency_key: "neg-noactor" });
    ok("N· missing actor identity → refuses, does not substitute system/unknown/null",
       r.outcome === "threw" && /required/i.test(r.threw.message), r.threw && r.threw.message);
    ok("   and nothing was written", (await census(c0, wo)).completed === 0);
  }

  // ══ H — IDEMPOTENCY AND REAL CONCURRENCY ════════════════════════════
  sec("H · IDEMPOTENCY AND REAL CONCURRENCY (overlapping transactions)");
  {
    //  TWO SEPARATE CONNECTIONS, both inside open transactions at the same
    //  time. Sequential awaits on one client would prove nothing about
    //  races — the whole point is that both transactions are live at once.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");

    const pa = lifecycle.claimCompletion(a, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "race-a" });
    const pb = lifecycle.claimCompletion(b, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "race-b" });
    const ra = await pa.then((v) => ({ v })).catch((e) => ({ e }));
    await a.query(ra.e ? "rollback" : "commit").catch(() => {});
    const rb = await pb.then((v) => ({ v })).catch((e) => ({ e }));
    await b.query(rb.e ? "rollback" : "commit").catch(() => {});
    await a.end(); await b.end();

    const x = await census(c0, wo);
    const ch = await chainOk(c0, wo);
    const winners = [ra, rb].filter((r) => r.v && r.v.closed === true).length;
    ok("H1  two CONCURRENT completions → exactly one closes", winners === 1,
       `${winners} closed; a=${ra.e ? ra.e.message : ra.v.outcome} b=${rb.e ? rb.e.message : rb.v.outcome}`);
    ok("H2  exactly one completed event", x.completed === 1, String(x.completed));
    ok("H3  exactly one evaluation, no second genesis", x.evals === 1, String(x.evals));
    ok("H4  chain valid after the race", ch.valid, JSON.stringify(ch));
  }
  {
    //  Same provider correlation key delivered twice, concurrently.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");
    const K = "same-provider-sid";
    const pa = lifecycle.claimCompletion(a, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: K });
    const pb = lifecycle.claimCompletion(b, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: K });
    const ra = await pa.then((v) => ({ v })).catch((e) => ({ e }));
    await a.query(ra.e ? "rollback" : "commit").catch(() => {});
    const rb = await pb.then((v) => ({ v })).catch((e) => ({ e }));
    await b.query(rb.e ? "rollback" : "commit").catch(() => {});
    await a.end(); await b.end();
    const x = await census(c0, wo);
    ok("H5  duplicate provider delivery → one completed event", x.completed === 1, String(x.completed));
    ok("H6  duplicate provider delivery → one evaluation", x.evals === 1, String(x.evals));
    ok("H7  chain valid", (await chainOk(c0, wo)).valid);
  }
  {
    //  Completion racing evidence ingestion on the same work order.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");
    const pa = lifecycle.claimCompletion(a, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "race-evi" });
    const pb = b.query(`insert into work_order_proof_attachments
      (work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,storage_state,proof_classification)
      values ($1,$2,$3,'twilio',$4,'image/jpeg','referenced','repair_photo')`,
      [wo, PROP, TECH, "ME-race-" + wo.slice(0, 6)]);
    const ra = await pa.then((v) => ({ v })).catch((e) => ({ e }));
    await pb.catch(() => {});
    await a.query(ra.e ? "rollback" : "commit").catch(() => {});
    await b.query("commit").catch(() => {});
    await a.end(); await b.end();
    const x = await census(c0, wo);
    ok("H8  completion racing evidence ingestion → still exactly one completion", x.completed === 1, String(x.completed));
    ok("H9  and the chain is valid", (await chainOk(c0, wo)).valid);
  }
  {
    //  Two concurrent evaluation supersessions on one head — the pure
    //  chain race, without the completion path around it.
    const wo = await makeWorkOrder(c0);
    await proofEvaluations.recordEvaluation(c0, { work_order_id: wo, property_id: PROP,
      state: "not_satisfied", evaluated_by_user_id: TECH, attachment_ids: [] });
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");
    const pa = proofEvaluations.recordEvaluation(a, { work_order_id: wo, property_id: PROP, state: "satisfied", evaluated_by_user_id: TECH });
    const pb = proofEvaluations.recordEvaluation(b, { work_order_id: wo, property_id: PROP, state: "satisfied", evaluated_by_user_id: TECH });
    const ra = await pa.then(() => ({ okv: true })).catch((e) => ({ e }));
    await a.query(ra.e ? "rollback" : "commit").catch(() => {});
    const rb = await pb.then(() => ({ okv: true })).catch((e) => ({ e }));
    await b.query(rb.e ? "rollback" : "commit").catch(() => {});
    await a.end(); await b.end();
    const winners = [ra, rb].filter((r) => r.okv).length;
    const ch = await chainOk(c0, wo);
    ok("H10 two CONCURRENT supersessions of one head → exactly one wins", winners === 1, String(winners));
    ok("H11 no fork: at most one successor", ch.maxSuccessors <= 1, JSON.stringify(ch));
    ok("H12 single genesis, single head", ch.valid, JSON.stringify(ch));
  }
  {
    //  Two concurrent GENESIS inserts in one empty scope.
    const wo = await makeWorkOrder(c0);
    const a = await open(), b = await open();
    await a.query("begin"); await b.query("begin");
    const pa = proofEvaluations.recordEvaluation(a, { work_order_id: wo, property_id: PROP, state: "satisfied", evaluated_by_user_id: TECH });
    const pb = proofEvaluations.recordEvaluation(b, { work_order_id: wo, property_id: PROP, state: "satisfied", evaluated_by_user_id: TECH });
    const ra = await pa.then(() => ({ okv: true })).catch((e) => ({ e }));
    await a.query(ra.e ? "rollback" : "commit").catch(() => {});
    const rb = await pb.then(() => ({ okv: true })).catch((e) => ({ e }));
    await b.query(rb.e ? "rollback" : "commit").catch(() => {});
    await a.end(); await b.end();
    ok("H13 two CONCURRENT genesis inserts → exactly one wins",
       [ra, rb].filter((r) => r.okv).length === 1);
    ok("H14 chain valid", (await chainOk(c0, wo)).valid);
  }

  // ══ X — MIXED VERSION ═══════════════════════════════════════════════
  sec("X · MIXED-VERSION MODEL — old API against schema 137");
  {
    //  "Old API" = the reads and writes that existed before this branch.
    //  If schema 137 broke any of them, an old deploy could not boot or
    //  serve against a migrated database and rollback would be trapped.
    const wo = await makeWorkOrder(c0);
    const oldRead = await c0.query(
      `select w.*, u.unit_number from work_orders w left join units u on u.id=w.unit_id where w.id=$1`, [wo])
      .then(() => true).catch(() => false);
    ok("X1  the pre-137 work-order read still works against schema 137", oldRead);
    const oldProgress = await c0.query(
      `select * from work_order_progress where work_order_id=$1 order by occurred_at`, [wo])
      .then(() => true).catch(() => false);
    ok("X2  the pre-137 progress read still works", oldProgress);
    const oldWrite = await c0.query(
      `update work_orders set status='in_progress', updated_at=now() where id=$1`, [wo])
      .then(() => true).catch(() => false);
    ok("X3  a pre-137 work-order write still works (rollback is not trapped)", oldWrite);
    const legacyClose = await c0.query(
      `update work_orders set status='closed', completion_photo='stub://legacy', updated_at=now() where id=$1`, [wo])
      .then(() => true).catch(() => false);
    ok("X4  the LEGACY closeout write still works — Step 6 retires it, not Step 3", legacyClose);
    const evalsForLegacy = Number((await c0.query(
      `select count(*) n from work_order_proof_evaluations where work_order_id=$1`, [wo])).rows[0].n);
    ok("X5  a legacy close writes NO evaluation (it is not canonical completion)",
       evalsForLegacy === 0, String(evalsForLegacy));
  }
  {
    //  Data written by the NEW writer must remain readable by the OLD
    //  reader — rolling the writer back must not strand rows.
    const wo = await makeWorkOrder(c0);
    await makeAttachment(c0, { work_order_id: wo });
    await claimInTx(c0, { work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: "x-roll" });
    const asOld = (await c0.query(`select status, completion_note from work_orders where id=$1`, [wo])).rows[0];
    ok("X6  after the new writer completes, the OLD reader sees a coherent row",
       asOld.status === "complete", JSON.stringify(asOld));
    const prog = (await c0.query(
      `select kind from work_order_progress where work_order_id=$1 order by occurred_at`, [wo])).rows.map((r) => r.kind);
    ok("X7  the old progress reader sees claim then completed",
       prog.includes("completion_claimed") && prog.includes("completed"), JSON.stringify(prog));
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  console.log("  migration transaction " + ms.toFixed(1) + " ms");
  await c0.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
