#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — THE REAL ACTIVATION TRANSACTION, MEASURED

   Closure defect 2. The first scale receipt timed a read-back of an
   already-populated inventory at 2.2 ms and said so honestly — but that
   means the activation transaction was never measured. This measures it:
   the one-shot capture → insert → exact-set compare → activation-genesis
   → commit that §6 describes.

   ── WHAT IT RUNS ────────────────────────────────────────────────────
     1  a census OUTSIDE the transaction, producing the expected exact set
     2  BEGIN
        · activation-history genesis, activated_at CAPTURED (never now())
        · the full legacy cutover inventory, FROM THE LIVE TABLE
        · exact-set comparison, BOTH directions, inside the transaction
        COMMIT
     3  a negative control: the expected set is deliberately altered, the
        activation must refuse, and NOTHING may survive the rollback

   ── ISOLATED HARNESS ONLY ───────────────────────────────────────────
   Applies assert_isolated_environment.sql, then the production payload,
   then evaluations only — activation history and the inventory must be
   EMPTY when this starts, because populating them is what it measures.

   usage:  node tools/scale/activation_proof.js [--json out.json]
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const HERE = __dirname;
const URL = process.env.SCALE_DATABASE_URL
  || "postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable";
const PAYLOAD = path.join(HERE, "137_release_0_payload.sql");
const WRAPPER = path.join(HERE, "assert_isolated_environment.sql");
const EVALS = path.join(HERE, "fixture_evaluations_only.sql");
const SENTINEL = "ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION";

//  THE CAPTURED INSTANT. §6.1 — the single most important line in the
//  release. It is SUPPLIED, never sampled: using insertion time reopens
//  the gap the ruling closes. A literal here is that discipline made
//  visible.
const CAPTURED_AT = "2026-02-01T00:00:00.000Z";

let pass = 0, fail = 0;
const R = {};
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const ms = (t) => Number(t.toFixed(2));

async function conn() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  const g = await c.query(
    "select current_database() db,(select purpose from public.release_0_scale_harness_guard where id=true) p");
  if (g.rows[0].db !== "r0scale" || g.rows[0].p !== SENTINEL) throw new Error("REFUSED: not the harness");
  return c;
}
const q = async (c, s, a) => (await c.query(s, a)).rows;
const num = async (c, s, a) => Number(Object.values((await q(c, s, a))[0])[0]);
async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const v = await fn();
  return { v, msec: ms(Number(process.hrtime.bigint() - t0) / 1e6) };
}

//  §6.2 step 2 — the census query, verbatim in shape.
const CENSUS_SQL = `
  select w.id as work_order_id, w.property_id, w.status,
         (w.completion_photo is not null) as had_column_photo,
         (w.completion_note  is not null) as had_column_note
    from public.work_orders w
   where w.status in ('complete','closed')
     and not exists (select 1 from public.work_order_proof_evaluations e
                      where e.work_order_id = w.id
                        and e.property_id   = w.property_id)
   order by w.property_id, w.id`;

const key = (r) => `${r.work_order_id}|${r.property_id}`;

/*  The activation transaction. `expected` is the census set supplied from
 *  outside; the comparison happens INSIDE the transaction, both
 *  directions, before commit. A count is never sufficient — one row
 *  completed and one deleted between census and activation produce a
 *  matching count over an entirely different population. */
async function runActivation(c, expected, { capturedAt }) {
  const t = {};
  const whole = process.hrtime.bigint();
  await c.query("begin");
  try {
    const a = await timed(() => q(c,
      `insert into public.release_0_activation_history
         (activated_at, captured_at_step, captured_by)
       values ($1, 'legacy_writer_dead_and_canonical_live', $2)
       returning id`, [capturedAt, "activation_proof"]));
    t.activation_insert_ms = a.msec;
    const activationId = a.v[0].id;

    const i = await timed(() => c.query(
      `insert into public.release_0_legacy_cutover_inventory
         (work_order_id, property_id, status_at_cutover,
          had_column_photo, had_column_note, activation_id)
       select w.id, w.property_id, w.status,
              (w.completion_photo is not null),
              (w.completion_note  is not null),
              $1
         from public.work_orders w
        where w.status in ('complete','closed')
          and not exists (select 1 from public.work_order_proof_evaluations e
                           where e.work_order_id = w.id
                             and e.property_id   = w.property_id)`, [activationId]));
    t.inventory_insert_ms = i.msec;
    t.rows_inserted = i.v.rowCount;

    //  §6.2 step 5 — BOTH directions, and REPORT BOTH. Do not stop at the
    //  first difference.
    const cmp = await timed(async () => {
      const live = await q(c,
        `select work_order_id, property_id from public.release_0_legacy_cutover_inventory
          where activation_id = $1`, [activationId]);
      const L = new Set(live.map(key));
      const E = new Set(expected.map(key));
      return {
        unexpected: [...L].filter(x => !E.has(x)),   // live \ expected
        missing:    [...E].filter(x => !L.has(x)),   // expected \ live
        live_count: L.size, expected_count: E.size,
      };
    });
    t.comparison_ms = cmp.msec;
    t.unexpected = cmp.v.unexpected.length;
    t.missing = cmp.v.missing.length;
    t.live_count = cmp.v.live_count;
    t.expected_count = cmp.v.expected_count;

    if (cmp.v.unexpected.length || cmp.v.missing.length) {
      throw Object.assign(new Error(
        `ACTIVATION REFUSED — unexpected ${cmp.v.unexpected.length}, missing ${cmp.v.missing.length}`),
        { activationRefusal: true, detail: cmp.v });
    }

    const cm = await timed(() => c.query("commit"));
    t.commit_ms = cm.msec;
    t.outcome = "committed";
    t.activation_id = activationId;
  } catch (e) {
    try { await c.query("rollback"); } catch (_) {}
    t.outcome = "refused";
    t.refusal = e.message;
    t.detail = e.detail || null;
  }
  t.total_ms = ms(Number(process.hrtime.bigint() - whole) / 1e6);
  return t;
}

(async function main() {
  const c = await conn();
  await c.query("set application_name='r0_activation'");

  R.payload_sha256 = sha(PAYLOAD);
  R.isolation_wrapper_sha256 = sha(WRAPPER);
  R.harness_runner_sha256 = sha(__filename);
  R.captured_at = CAPTURED_AT;
  R.pg_settings = Object.fromEntries((await q(c,
    `select name, setting from pg_settings
      where name in ('fsync','synchronous_commit','full_page_writes','shared_buffers','work_mem')`))
    .map(r => [r.name, r.setting]));

  console.log("RELEASE 0 — ACTIVATION TRANSACTION PROOF");
  console.log("  payload      " + R.payload_sha256);
  console.log("  durability   fsync=" + R.pg_settings.fsync
            + " synchronous_commit=" + R.pg_settings.synchronous_commit
            + " full_page_writes=" + R.pg_settings.full_page_writes);

  sec("SETUP — payload, then evaluations only");
  await c.query(fs.readFileSync(WRAPPER, "utf8"));
  const payloadSql = fs.readFileSync(PAYLOAD, "utf8");
  if (crypto.createHash("sha256").update(payloadSql).digest("hex") !== R.payload_sha256) {
    throw new Error("payload digest changed between recording and execution");
  }
  await c.query(payloadSql);
  await c.query(fs.readFileSync(EVALS, "utf8"));
  ok("A0  activation history is EMPTY before the transaction",
     await num(c, "select count(*) from public.release_0_activation_history") === 0);
  ok("A0b legacy inventory is EMPTY before the transaction",
     await num(c, "select count(*) from public.release_0_legacy_cutover_inventory") === 0);

  sec("CENSUS — outside the transaction (§6.2)");
  const census = await timed(() => q(c, CENSUS_SQL));
  R.census = {
    ms: census.msec, rows: census.v.length,
    digest: crypto.createHash("sha256")
      .update(census.v.map(r => `${r.work_order_id}|${r.property_id}|${r.status}|${r.had_column_photo}|${r.had_column_note}`).join("\n"))
      .digest("hex"),
  };
  console.log("  census rows               " + R.census.rows + " in " + R.census.ms + " ms");
  console.log("  census digest             " + R.census.digest);
  ok("A1  the census returned the full terminal-without-evaluation set",
     R.census.rows === 32000, String(R.census.rows));

  sec("THE ACTIVATION TRANSACTION — with lock observation");
  //  A second connection watches locks and a third keeps working, so
  //  "it committed" is not the only thing recorded.
  const obs = await conn(); await obs.query("set application_name='r0_act_observer'");
  const work = await conn(); await work.query("set application_name='r0_act_workload'");
  let observing = true;
  const lockSamples = [];
  const observer = (async () => {
    while (observing) {
      try {
        const rows = await q(obs, `
          select l.mode, l.granted, coalesce(cl.relname, l.locktype) obj,
                 a.application_name, a.wait_event_type
            from pg_locks l
            left join pg_class cl on cl.oid = l.relation
            left join pg_stat_activity a on a.pid = l.pid
           where a.application_name in ('r0_activation','r0_act_workload')
             and l.locktype in ('relation','transactionid','tuple')`);
        if (rows.length) lockSamples.push(rows);
      } catch (_) {}
      await new Promise(r => setTimeout(r, 5));
    }
  })();
  const wl = { reads: 0, fail: 0, max_ms: 0, errors: [] };
  let working = true;
  const workload = (async () => {
    while (working) {
      const t0 = process.hrtime.bigint();
      try { await work.query("select id, status from public.work_orders where source='scale_fixture' limit 20"); wl.reads++; }
      catch (e) { wl.fail++; wl.errors.push(e.message); }
      const l = Number(process.hrtime.bigint() - t0) / 1e6;
      if (l > wl.max_ms) wl.max_ms = ms(l);
    }
  })();

  const act = await runActivation(c, census.v, { capturedAt: CAPTURED_AT });
  working = false; observing = false;
  await workload; await observer;

  const locked = new Map();
  for (const s of lockSamples) for (const r of s) {
    const k = `${r.obj} ${r.mode}${r.granted ? "" : " (WAITING)"}`;
    locked.set(k, (locked.get(k) || 0) + 1);
  }
  R.activation = act;
  R.activation.lock_observations = Object.fromEntries(locked);
  R.activation.lock_samples = lockSamples.length;
  R.activation.concurrent_reads = wl;

  console.log("  outcome                   " + act.outcome);
  console.log("  rows inserted             " + act.rows_inserted);
  console.log("  activation insert         " + act.activation_insert_ms + " ms");
  console.log("  inventory insert          " + act.inventory_insert_ms + " ms");
  console.log("  exact-set comparison      " + act.comparison_ms + " ms");
  console.log("  commit                    " + act.commit_ms + " ms");
  console.log("  TOTAL                     " + act.total_ms + " ms");
  console.log("  concurrent reads          " + wl.reads + " (max " + wl.max_ms + " ms, " + wl.fail + " failed)");

  ok("A2  the activation transaction COMMITTED", act.outcome === "committed", act.refusal);
  ok("A3  it inserted the full census population", act.rows_inserted === 32000, String(act.rows_inserted));
  ok("A4  exact-set reconciliation: unexpected = 0", act.unexpected === 0, String(act.unexpected));
  ok("A5  exact-set reconciliation: missing = 0", act.missing === 0, String(act.missing));
  ok("A6  live and expected sets are the same SIZE and the same MEMBERS",
     act.live_count === act.expected_count && act.live_count === 32000,
     `live ${act.live_count} expected ${act.expected_count}`);
  ok("A7  ordinary reads continued throughout", wl.reads > 0 && wl.fail === 0,
     `${wl.reads} reads, ${wl.fail} failures`);
  ok("A8  locks were actually observed", lockSamples.length > 0, String(lockSamples.length));

  const head = await q(c, "select id, activated_at, captured_at_step from public.release_0_activation_current");
  R.activation.final_head = head[0];
  R.activation.final_inventory_count = await num(c,
    "select count(*) from public.release_0_legacy_cutover_inventory");
  ok("A9  exactly one activation head", head.length === 1, String(head.length));
  ok("A10 activated_at is the CAPTURED instant, not the insert time",
     new Date(head[0].activated_at).toISOString() === CAPTURED_AT,
     `${new Date(head[0].activated_at).toISOString()} vs ${CAPTURED_AT}`);
  ok("A11 final inventory count is 32,000", R.activation.final_inventory_count === 32000,
     String(R.activation.final_inventory_count));

  sec("NEGATIVE CONTROL — the expected set is deliberately wrong");
  //  Everything is torn down and rebuilt so the control starts from the
  //  same empty state the real run did. Teardown disables the append-only
  //  triggers — which is the harness resetting its own fixture, and is
  //  itself evidence those triggers are on.
  await c.query("begin");
  await c.query("alter table public.release_0_legacy_cutover_inventory disable trigger no_delete_r0lci");
  await c.query("alter table public.release_0_activation_history disable trigger no_delete_r0ah");
  await c.query("delete from public.release_0_legacy_cutover_inventory");
  await c.query("delete from public.release_0_activation_history");
  await c.query("alter table public.release_0_activation_history enable trigger no_delete_r0ah");
  await c.query("alter table public.release_0_legacy_cutover_inventory enable trigger no_delete_r0lci");
  await c.query("commit");

  //  DROP ONE ROW from the expected set, and ADD ONE THAT IS NOT THERE.
  //  Both directions must be caught, and a count-only check would see
  //  32,000 vs 32,000 and pass.
  const tampered = census.v.slice(1).concat([{
    work_order_id: "00000000-0000-4000-8000-000000000001",
    property_id: census.v[0].property_id, status: "complete",
    had_column_photo: false, had_column_note: false,
  }]);
  ok("N0  the tampered set has the SAME COUNT as the real one — a count "
     + "comparison would pass", tampered.length === census.v.length,
     `${tampered.length} vs ${census.v.length}`);

  const neg = await runActivation(c, tampered, { capturedAt: CAPTURED_AT });
  R.negative_control = neg;
  console.log("  outcome                   " + neg.outcome);
  console.log("  refusal                   " + (neg.refusal || "—"));
  console.log("  unexpected / missing      " + neg.unexpected + " / " + neg.missing);

  ok("N1  the activation REFUSED", neg.outcome === "refused", JSON.stringify(neg));
  ok("N2  it reported BOTH directions, not just the first",
     neg.unexpected === 1 && neg.missing === 1,
     `unexpected ${neg.unexpected}, missing ${neg.missing}`);
  const partialInv = await num(c, "select count(*) from public.release_0_legacy_cutover_inventory");
  const partialAct = await num(c, "select count(*) from public.release_0_activation_history");
  R.negative_control.rows_after_rollback = { inventory: partialInv, activation_history: partialAct };
  ok("N3  ZERO partial inventory rows survived the rollback", partialInv === 0, String(partialInv));
  ok("N4  ZERO activation-history rows survived the rollback", partialAct === 0, String(partialAct));

  console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}`);
  R.summary = { passed: pass, failed: fail };
  await c.end(); await obs.end(); await work.end();
  const i = process.argv.indexOf("--json");
  if (i > -1) { fs.writeFileSync(process.argv[i + 1], JSON.stringify(R, null, 2));
                console.log("  receipt → " + process.argv[i + 1]); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error("\nACTIVATION HARNESS ERROR — no result is claimed:\n" + (e && e.stack || e));
  process.exit(1);
});
