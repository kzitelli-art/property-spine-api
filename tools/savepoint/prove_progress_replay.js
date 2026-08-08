#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   PROVE THE PROGRESS-REPLAY SAVEPOINT

   ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────

   `appendProgress` caught PostgreSQL 23505 — a duplicate idempotency key,
   which is what a carrier redelivery looks like — and then issued a
   recovery SELECT to return the fact already recorded.

   PostgreSQL aborts the WHOLE transaction on a failed statement. With no
   savepoint between the failing INSERT and that SELECT, the SELECT does
   not run. It raises 25P02, `current transaction is aborted, commands
   ignored until end of transaction block`.

   So the handler written to make a redelivery harmless was itself the
   thing that threw. The technician's turn rolled back and — because
   25P02 is not 23505 — `tenantlink`'s duplicate-suppression branch could
   not recognise it either. The technician got silence: no completion, no
   refusal, no sentence.

   ── WHAT IS PROVEN, AND WHAT IS NOT ─────────────────────────────────

   proven here   the service contract against a real PostgreSQL at the
                 current ledger: the replay returns the recorded fact, the
                 transaction stays usable, and the pre-fix source aborts.
   NOT proven    HTTP, Twilio, the browser, production population. Those
                 are the post-deploy handset check, not this file.

   This needs NO migration 137 and NO Release 0 schema. It runs against
   the ledger production is already at, which is the point: the fix is
   deployable on its own.

   ⚠ ISOLATED POSTGRES ONLY. Refuses without the harness sentinel row.

   usage:
     bash tools/scale/setup_baseline.sh
     SAVEPOINT_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/savepoint/prove_progress_replay.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const LIFECYCLE = path.join(ROOT, "src/technician/lifecycle_service.js");
const TENANTLINK = path.join(ROOT, "src/comms/tenantlink.js");
const URL = process.env.SAVEPOINT_DATABASE_URL;

const DIGEST_BEFORE = crypto.createHash("sha256").update(fs.readFileSync(LIFECYCLE)).digest("hex");

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

/*  ── THE PRE-FIX SOURCE, COMPILED IN MEMORY ────────────────────────
 *  Never edited on disk. Three substitutions, because the guard is
 *  spelled across non-adjacent lines: removing only the savepoint would
 *  fail on a missing savepoint instead of reproducing the real abort,
 *  which is a different bug and would prove the wrong thing. */
function loadVariant(targetPath, edits) {
  let src = fs.readFileSync(targetPath, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — the mutation matched nothing, " +
                      "so it proves nothing: " + from.slice(0, 70));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(targetPath, null);
  m.filename = targetPath;
  m.paths = Module._nodeModulePaths(path.dirname(targetPath));
  m._compile(src, targetPath);
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("savepoint:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");

let seq = 0;
async function makeWorkOrder(c) {
  const wo = ID("wo" + (++seq));
  await c.query(`insert into work_orders (id,property_id,title,status,source)
                 values ($1,$2,'savepoint proof','open','savepointproof')`, [wo, PROP]);
  return wo;
}

async function census(c, wo) {
  const q = async (s, p = [wo]) => Number((await c.query(s, p)).rows[0].n);
  return {
    status: (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0].status,
    progress: await q(`select count(*) n from work_order_progress where work_order_id=$1`),
    claimed: await q(`select count(*) n from work_order_progress
                       where work_order_id=$1 and kind='completion_claimed'`),
    events: await q(`select count(*) n from events where note like '%' || $1 || '%'`),
  };
}

/*  Run a verb the way production does: inside an explicit transaction the
 *  caller owns, committing on success and rolling back on failure —
 *  exactly what tenantlink's inbound-SMS wrapper does. */
async function inTx(c, fn) {
  await c.query("begin");
  try { const out = await fn(); await c.query("commit"); return { out }; }
  catch (e) { await c.query("rollback").catch(() => {}); return { err: e }; }
}

(async function main() {
  if (!URL) { console.error("REFUSED: SAVEPOINT_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  //  Identity, not location. A path can be copied; a port is an
  //  operational detail. This row is what makes the database THIS one.
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated harness baseline."); process.exit(2); }
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '30s'");

  const leftovers = Number((await c.query(
    `select count(*) n from work_orders where source='savepointproof'`)).rows[0].n);
  if (leftovers > 0) {
    console.error("REFUSED: " + leftovers + " fixture rows from a previous run remain.");
    console.error("         Rebuild: bash tools/scale/setup_baseline.sh");
    process.exit(3);
  }

  console.log("PROGRESS-REPLAY SAVEPOINT PROOF — isolated postgres\n");
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  console.log("  ledger ceiling " + ledger + " — this proof needs no Release 0 schema\n");

  await c.query(`insert into organizations (id,name) values ($1,'Savepoint Org')
                 on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Savepoint Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Sam Savepoint','+15415559101','maintenance',true)
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                 values ($1,$2,'Maintenance Tech',true)`, [TECH, PROP]).catch(() => {});

  const lifecycle = require(LIFECYCLE);
  const verb = (client, kind, wo, key, note = null) => lifecycle.reportFieldFact(client, {
    kind, work_order_id: wo, user_id: TECH, organization_id: ORG, note, idempotency_key: key });

  // ══ P — THE REDELIVERY IS ABSORBED AND THE TURN SURVIVES ═══════════
  sec("P · A REDELIVERED MESSAGE IS ABSORBED, AND THE TURN SURVIVES");
  {
    const wo = await makeWorkOrder(c);
    const first = await inTx(c, () => verb(c, "en_route", wo, "SM-p-1"));
    ok("P1  a field fact is recorded at all (the writer works)",
       !first.err && first.out.outcome === "recorded" && first.out.progress,
       first.err && first.err.message);

    //  The redelivery, and — this is the whole bug — MORE WORK AFTER IT.
    //  Asserting only that the replay returns a row would have passed
    //  before the fix too, because the throw happens on the way there.
    let replay = null, afterReplay = null;
    const second = await inTx(c, async () => {
      replay = await verb(c, "en_route", wo, "SM-p-1");
      afterReplay = (await c.query(
        `update work_orders set updated_at = now() where id=$1 returning id`, [wo])).rows[0];
      return replay;
    });
    ok("P2  the same provider key redelivered does NOT throw",
       !second.err, second.err && `${second.err.code} ${second.err.message}`);
    ok("P3  …it reports a REPLAY of the fact already recorded, same row",
       !!replay && replay.outcome === "replayed" &&
       replay.progress && replay.progress.id === first.out.progress.id,
       JSON.stringify({ outcome: replay && replay.outcome,
                        same: !!(replay && replay.progress && first.out.progress &&
                                 replay.progress.id === first.out.progress.id) }));
    ok("P4  …the transaction is STILL USABLE — later work in the same turn runs",
       !!afterReplay, "the turn could not continue past the replay");

    const x = await census(c, wo);
    ok("P5  …and the turn COMMITTED: one progress row, one event, nothing doubled",
       x.progress === 1 && x.events === 1, JSON.stringify(x));

    //  Not everything is a replay now. A different key is a new fact.
    const third = await inTx(c, () => verb(c, "en_route", wo, "SM-p-2"));
    const x2 = await census(c, wo);
    ok("P6  a DIFFERENT key is a new fact, not a replay",
       !third.err && third.out.outcome === "recorded" && x2.progress === 2,
       JSON.stringify({ outcome: third.out && third.out.outcome, progress: x2.progress }));
  }

  // ══ THE EXACT PRODUCTION SEQUENCE ══════════════════════════════════
  sec("P · THE SEQUENCE THAT BROKE IT — blocked claim, then a redelivery");
  {
    //  A completion claim with no evidence: recorded, work order stays
    //  OPEN. That leaves a live idempotency key on an open work order —
    //  which is the state a redelivery then lands on. Nothing exotic; a
    //  phone with one bar does this.
    const wo = await makeWorkOrder(c);
    const k = "SM-blocked-then-redelivered";
    const claim = await inTx(c, () => lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k }));
    const x0 = await census(c, wo);
    ok("P7  a claim with no evidence is RECORDED and the work order stays open",
       !claim.err && claim.out.closed === false && x0.status === "open" && x0.claimed === 1,
       (claim.err && claim.err.message) || JSON.stringify(x0));

    const redeliver = await inTx(c, () => lifecycle.claimCompletion(c, {
      work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k }));
    const x1 = await census(c, wo);
    ok("P8  the carrier redelivers that same claim → the turn does NOT throw",
       !redeliver.err, redeliver.err && `${redeliver.err.code} ${redeliver.err.message}`);
    ok("P9  …the claim is not duplicated and the work order is still open",
       x1.claimed === 1 && x1.status === "open", JSON.stringify(x1));
    ok("P10 …and the technician gets an answer rather than silence: a stated `missing`",
       !!(redeliver.out && redeliver.out.missing), JSON.stringify(redeliver.out && redeliver.out.missing));
  }

  // ══ Q — THE HANDLER FAILS LOUDLY WHEN IT CANNOT KNOW ═══════════════
  sec("Q · A 23505 THAT IS NOT THE IDEMPOTENCY KEY MUST NOT BECOME A REPLAY");
  {
    /*  In production there is exactly one unique index on this table —
     *  134's partial index on idempotency_key — so no other 23505 can
     *  reach the handler. That makes the "rethrow" branch unobservable
     *  by running the code, and a branch that cannot be observed is
     *  indistinguishable from a comment.
     *
     *  So the harness installs a second unique index to make the branch
     *  reachable, proves it, and drops it. ISOLATED DATABASE ONLY. */
    //  Partial, on `finding` only: the P sections deliberately wrote two
    //  `en_route` rows on one work order, and an index that refused those
    //  would be describing a rule the product does not have.
    await c.query(`create unique index tmp_savepoint_probe
                     on work_order_progress (work_order_id) where kind = 'finding'`);
    try {
      const woA = await makeWorkOrder(c);
      await inTx(c, () => verb(c, "finding", woA, null, "first"));
      const keyless = await inTx(c, () => verb(c, "finding", woA, null, "second"));
      ok("Q1  a KEYLESS duplicate rethrows instead of inventing a replay",
         !!keyless.err && keyless.err.code === "23505",
         keyless.err ? keyless.err.code + " " + keyless.err.message
                     : "it returned " + JSON.stringify(keyless.out && keyless.out.outcome));

      const woB = await makeWorkOrder(c);
      await inTx(c, () => verb(c, "finding", woB, "SM-q-1", "first"));
      let stillUsable = null;
      const other = await inTx(c, async () => {
        try { return await verb(c, "finding", woB, "SM-q-2", "second"); }
        finally {
          //  The savepoint's other job: even on the rethrow path the
          //  transaction is not poisoned, so the CALLER decides. That is
          //  a real behaviour change and it is asserted, not assumed.
          stillUsable = await c.query(`select 1 n`).then(() => true).catch(() => false);
        }
      });
      ok("Q2  a KEYED duplicate whose key is not the collision rethrows too",
         !!other.err && other.err.code === "23505",
         other.err ? other.err.code + " " + other.err.message
                   : "it returned " + JSON.stringify(other.out && other.out.outcome) +
                     " — a replay row that was never recorded");
      ok("Q3  …and on the rethrow path the transaction is NOT poisoned either",
         stillUsable === true,
         "so the CALLER must roll back — see T2");

      const xA = await census(c, woA), xB = await census(c, woB);
      ok("Q4  both refusals left exactly the one fact that did land",
         xA.progress === 1 && xB.progress === 1, JSON.stringify({ xA, xB }));
    } finally {
      await c.query(`drop index if exists tmp_savepoint_probe`);
    }
    const gone = Number((await c.query(
      `select count(*) n from pg_indexes where indexname='tmp_savepoint_probe'`)).rows[0].n);
    ok("Q5  the probe index is dropped — the harness left no schema behind", gone === 0);
  }

  // ══ T — THE CALLER ROLLS BACK, AND THE OLD CODE COULD NOT BE CAUGHT ═
  sec("T · THE CALLER, AND WHY THE OLD FAILURE WAS SILENT");
  {
    const tl = fs.readFileSync(TENANTLINK, "utf8");
    //  Q3 shows the transaction survives a rethrow. That is only safe
    //  because the caller rolls back rather than committing what landed.
    const wrapper = tl.slice(tl.indexOf("technicianConversation.runOperationsTurn"));
    ok("T1  tenantlink's operations turn rolls back on ANY throw",
       /catch \(e\) \{\s*await t\.query\("rollback"\)/.test(wrapper),
       "if the caller ever swallows the error, a partial turn could commit");
    ok("T2  …and it only treats 23505 as an already-answered duplicate",
       /if \(e\.code === "23505"\)/.test(wrapper),
       "the pre-fix error was 25P02, not 23505, which is why the technician got " +
       "silence rather than the duplicate-suppressed path");
  }

  // ══ R — FALSIFICATION: PUT THE BUG BACK ════════════════════════════
  sec("R · FALSIFICATION — restore the pre-fix source and watch it abort");
  {
    const prefix = loadVariant(LIFECYCLE, [
      { from: 'await client.query("savepoint append_progress");',
        to:   'await Promise.resolve(); /* pre-fix: no savepoint */' },
      { from: 'await client.query("rollback to savepoint append_progress");',
        to:   'await Promise.resolve(); /* pre-fix: no rollback */' },
      { from: 'await client.query("release savepoint append_progress");',
        to:   'await Promise.resolve(); /* pre-fix: no release */' },
    ]);

    const wo = await makeWorkOrder(c);
    const k = "SM-r-prefix";
    await inTx(c, () => prefix.reportFieldFact(c, {
      kind: "en_route", work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k }));
    const boom = await inTx(c, () => prefix.reportFieldFact(c, {
      kind: "en_route", work_order_id: wo, user_id: TECH, organization_id: ORG, idempotency_key: k }));

    ok("R1  the pre-fix source ABORTS the turn on a redelivery",
       !!boom.err && /current transaction is aborted/i.test(boom.err.message),
       boom.err ? boom.err.code + " " + boom.err.message
                : "it survived — then the savepoint is not what makes the retry work");
    ok("R2  …and the error is 25P02, which tenantlink's 23505 branch cannot recognise",
       !!boom.err && boom.err.code === "25P02",
       "code was " + (boom.err && boom.err.code) +
       " — the claim about WHY the technician got silence depends on this");
    const x = await census(c, wo);
    ok("R3  …leaving the redelivered turn with nothing recorded",
       x.progress === 1, JSON.stringify(x));

    //  And the real code, same fixture shape, same key.
    const wo2 = await makeWorkOrder(c);
    await inTx(c, () => verb(c, "en_route", wo2, "SM-r-real"));
    const good = await inTx(c, () => verb(c, "en_route", wo2, "SM-r-real"));
    ok("R4  the REAL source survives that identical sequence",
       !good.err && good.out.outcome === "replayed",
       good.err ? good.err.code + " " + good.err.message : JSON.stringify(good.out.outcome));
  }

  sec("SOURCE");
  ok("Z1  lifecycle_service.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(LIFECYCLE)).digest("hex") === DIGEST_BEFORE);

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
