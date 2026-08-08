#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — ISOLATED SCALE, CORRECTNESS, CONCURRENCY AND OPERABILITY PROOF

   ⚠ ISOLATED POSTGRES ONLY. Every connection is checked against the
     harness sentinel before anything runs. Location protects nothing —
     a file can be copied and a port can be forwarded. Identity does.

   Phases 2-8 of the authorized build. Phase 1 (fixture) and the baseline
   are separate scripts so the whole thing can be replayed from nothing,
   which is what makes phase 9's two clean runs comparable.

   ── WHAT THIS DOES NOT DO ───────────────────────────────────────────
   It opens no production connection, creates no migration under
   migrations/, and touches no provider configuration. The candidate lives
   outside migrations/ and migrate.js cannot see it.

   usage:  node tools/scale/run_scale_proof.js [--json out.json]
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const HERE = __dirname;
const URL = process.env.SCALE_DATABASE_URL
  || "postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable";
const PAYLOAD = path.join(HERE, "137_release_0_payload.sql");
const WRAPPER = path.join(HERE, "assert_isolated_environment.sql");
const SENTINEL_PURPOSE = "ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION";

let pass = 0, fail = 0;
const R = { phases: {}, findings: [] };
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          → " + detail : "")); }
  return cond;
};
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const ms = (t) => Number(t.toFixed(2));

async function conn() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  //  IDENTITY CHECK ON EVERY CONNECTION. Not the port, not the path.
  const g = await c.query(
    "select current_database() db, (select purpose from public.release_0_scale_harness_guard where id=true) p");
  if (g.rows[0].db !== "r0scale" || g.rows[0].p !== SENTINEL_PURPOSE) {
    await c.end();
    throw new Error("REFUSED: connection is not the isolated scale harness");
  }
  return c;
}
const q = async (c, sql, args) => (await c.query(sql, args)).rows;
const one = async (c, sql, args) => (await q(c, sql, args))[0];
const num = async (c, sql, args) => Number(Object.values(await one(c, sql, args))[0]);

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const v = await fn();
  return { v, msec: ms(Number(process.hrtime.bigint() - t0) / 1e6) };
}

//  Try something that must fail, and report HOW it failed. A refusal
//  whose reason is not checked is not a proof of anything.
async function mustRefuse(c, sql, args) {
  try {
    await c.query("savepoint mr");
    await c.query(sql, args);
    await c.query("rollback to savepoint mr");
    return { refused: false, message: null, code: null };
  } catch (e) {
    try { await c.query("rollback to savepoint mr"); } catch (_) {}
    return { refused: true, message: e.message, code: e.code, constraint: e.constraint || null };
  }
}

// ════════════════════════════════════════════════════════════════════
//  THE DEFECT PREDICATE — §3.2.0. ONE definition, used by BOTH the
//  reader and the sweep, so they cannot disagree by construction.
//
//    terminal              status in ('complete','closed')
//    legitimate legacy     terminal AND in the inventory
//    defect                terminal AND no evaluation AND NOT inventoried
//
//  Inventory membership decides LEGITIMACY, not VISIBILITY. Every closed
//  row is terminal; only inventoried ones are legacy.
// ════════════════════════════════════════════════════════════════════
const DEFECT_SQL = `
  select w.id
    from public.work_orders w
   where w.status in ('complete','closed')
     and not exists (select 1 from public.work_order_proof_evaluations e
                      where e.work_order_id = w.id and e.property_id = w.property_id)
     and not exists (select 1 from public.release_0_legacy_cutover_inventory i
                      where i.work_order_id = w.id and i.property_id = w.property_id)`;

//  The reader's four-state derivation, expressed once.
const READER_SQL = `
  select case
    when h.id is not null then h.state
    when w.status in ('complete','closed') and i.work_order_id is not null
      then 'legacy_indeterminate'
    when w.status in ('complete','closed')
      then 'missing_evaluation_defect'
    else 'not_due'
  end as state, count(*) n
  from public.work_orders w
  left join public.work_order_proof_evaluation_head h
    on h.work_order_id = w.id and h.property_id = w.property_id
  left join public.release_0_legacy_cutover_inventory i
    on i.work_order_id = w.id and i.property_id = w.property_id
  where w.source = 'scale_fixture'
  group by 1 order by 1`;

// ════════════════════════════════════════════════════════════════════
(async function main() {
  const c = await conn();
  await c.query("set application_name = 'r0_scale_proof'");

  R.payload_path = path.relative(ROOT, PAYLOAD);
  R.payload_sha256 = sha(PAYLOAD);
  R.isolation_wrapper_path = path.relative(ROOT, WRAPPER);
  R.isolation_wrapper_sha256 = sha(WRAPPER);
  R.harness_runner_sha256 = sha(__filename);
  R.fixture_pre_sha256 = sha(path.join(HERE, "fixture_pre_migration.sql"));
  R.fixture_post_sha256 = sha(path.join(HERE, "fixture_post_migration.sql"));
  R.setup_sha256 = sha(path.join(HERE, "setup_baseline.sh"));
  R.seed_sha256 = {
    a: sha(path.join(HERE, "seed_a_vendors.sql")),
    b: sha(path.join(HERE, "seed_b_qa_identity.sql")),
    c: sha(path.join(HERE, "seed_c_governed_charges.sql")),
  };
  R.pg_version = (await one(c, "select version() v")).v;
  R.database = (await one(c, "select current_database() d")).d;
  R.isolation_guard = "PASSED — sentinel purpose matched on every connection";

  console.log("RELEASE 0 SCALE PROOF");
  console.log("  payload          " + R.payload_sha256);
  console.log("  isolation wrapper" + " " + R.isolation_wrapper_sha256);
  console.log("  fixture pre      " + R.fixture_pre_sha256);
  console.log("  fixture post     " + R.fixture_post_sha256);
  console.log("  database         " + R.database);
  console.log("  " + R.pg_version.split(",")[0]);

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 2 — PRE-MIGRATION CENSUS");
  // ══════════════════════════════════════════════════════════════════
  const census = {};
  census.ledger_ceiling = (await one(c, "select max(version) v from public.schema_migrations")).v;
  census.by_status = await q(c,
    "select status, count(*)::int n from public.work_orders where source='scale_fixture' group by 1 order by 1");
  census.by_property = await q(c,
    "select property_id::text, count(*)::int n from public.work_orders where source='scale_fixture' group by 1 order by 1");
  census.total = await num(c, "select count(*) from public.work_orders where source='scale_fixture'");
  census.terminal = await num(c,
    "select count(*) from public.work_orders where source='scale_fixture' and status in ('complete','closed')");
  census.complete = await num(c,
    "select count(*) from public.work_orders where source='scale_fixture' and status='complete'");
  census.closed = await num(c,
    "select count(*) from public.work_orders where source='scale_fixture' and status='closed'");
  census.attachments_by_classification = await q(c,
    `select proof_classification, storage_state, count(*)::int n
       from public.work_order_proof_attachments where provider='scale_fixture'
      group by 1,2 order by 1,2`);
  census.candidate_inventory_population = await num(c,
    `select count(*) from public.work_orders
      where source='scale_fixture' and status in ('complete','closed')
        and (work_order_ref - 1000000) % 100 between 68 and 92`);
  census.candidate_defect_population = await num(c,
    `select count(*) from public.work_orders
      where source='scale_fixture' and status in ('complete','closed')
        and (work_order_ref - 1000000) % 100 between 93 and 99`);
  census.db_size_before = (await one(c, "select pg_size_pretty(pg_database_size(current_database())) s")).s;
  census.work_orders_size_before = (await one(c,
    "select pg_size_pretty(pg_total_relation_size('public.work_orders')) s")).s;

  R.phases.census = census;
  console.log("  ledger ceiling            " + census.ledger_ceiling);
  console.log("  work orders               " + census.total);
  console.log("  terminal                  " + census.terminal
            + "   complete " + census.complete + "  closed " + census.closed);
  console.log("  candidate inventory pop   " + census.candidate_inventory_population);
  console.log("  candidate defect pop      " + census.candidate_defect_population);
  console.log("  db size before            " + census.db_size_before);
  ok("C1  fixture is exactly 100,000 work orders", census.total === 100000, String(census.total));
  ok("C2  ledger is at 136 before the candidate", census.ledger_ceiling === "136", census.ledger_ceiling);
  ok("C3  five properties", census.by_property.length === 5, String(census.by_property.length));
  ok("C4  terminal 60,000 / non-terminal 40,000",
     census.terminal === 60000 && census.total - census.terminal === 40000);
  ok("C5  candidate defect population is non-empty and includes closed rows",
     census.candidate_defect_population === 7000, String(census.candidate_defect_population));
  ok("C6  137 tables absent before the candidate",
     await num(c, `select count(*) from information_schema.tables where table_schema='public'
                    and table_name='work_order_proof_evaluations'`) === 0);

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 3 — MIGRATION, INDEX AND LOCK MEASUREMENTS");
  // ══════════════════════════════════════════════════════════════════
  //  Two observers on independent connections, running DURING the
  //  migration. "It finished quickly" is not evidence of non-blocking.
  const obs = await conn();
  const work = await conn();
  await obs.query("set application_name='r0_lock_observer'");
  await work.query("set application_name='r0_control_workload'");

  let observing = true;
  const lockSamples = [];
  const observer = (async () => {
    while (observing) {
      try {
        const rows = await q(obs, `
          select l.locktype, l.mode, l.granted,
                 coalesce(c.relname, l.locktype) as obj,
                 a.application_name, a.wait_event_type, a.state
            from pg_locks l
            left join pg_class c on c.oid = l.relation
            left join pg_stat_activity a on a.pid = l.pid
           where a.application_name in ('r0_scale_proof','r0_control_workload')
             and l.locktype in ('relation','transactionid','tuple')`);
        if (rows.length) lockSamples.push({ at: Date.now(), rows });
      } catch (_) { /* observation must never break the run */ }
      await new Promise(r => setTimeout(r, 5));
    }
  })();

  //  CONTROL WORKLOAD — ordinary reads and unrelated inserts, running
  //  against the same tables while the candidate applies. Successes,
  //  failures, waits and latency are all recorded, not just "it worked".
  //  THE FIRST CUT SLEPT 2ms PER ITERATION and probed only work_orders.
  //  Against a 47ms migration that yielded ONE iteration of each probe, so
  //  "the control workload never failed" rested on a single sample — and it
  //  never touched work_order_proof_attachments, which is the ONE table the
  //  migration actually locks. Now it runs flat out and probes the locked
  //  table directly.
  const control = { iterations: 0, reads: 0, read_fail: 0, inserts: 0, insert_fail: 0,
                    list_reads: 0, list_fail: 0,
                    attach_writes: 0, attach_write_fail: 0, attach_write_max_ms: 0,
                    read_max_ms: 0, list_max_ms: 0, insert_max_ms: 0,
                    max_latency_ms: 0, errors: [] };
  //  FOUR PROBES, FOUR CONNECTIONS, EACH IN ITS OWN TIGHT LOOP.
  //  Sequential probes on one connection took ~49ms per cycle against a
  //  ~47ms migration — one sample, which is not a measurement. Independent
  //  connections let each probe iterate many times inside the window.
  let working = true;
  const probes = [];
  async function probe(name, sql, argFn, counter, failCounter, maxKey) {
    const p = await conn();
    await p.query("set application_name='r0_control_workload'");
    let n = 0;
    probes.push((async () => {
      while (working) {
        const t = process.hrtime.bigint();
        try { await p.query(sql, argFn ? argFn(n++) : undefined); control[counter]++; }
        catch (e) { control[failCounter]++; control.errors.push(name + ": " + e.message); }
        const lat = Number(process.hrtime.bigint() - t) / 1e6;
        if (maxKey && lat > control[maxKey]) control[maxKey] = ms(lat);
        control.iterations++;
      }
      await p.end();
    })());
  }
  await probe("read", "select id, status from public.work_orders where source='scale_fixture' limit 20",
              null, "reads", "read_fail", "read_max_ms");
  await probe("list", `select w.id, w.status from public.work_orders w
                        where w.source='scale_fixture' order by w.created_at desc limit 50`,
              null, "list_reads", "list_fail", "list_max_ms");
  await probe("insert",
    `insert into public.work_orders (id, property_id, title, status, source, urgency_status, work_order_ref)
     values (gen_random_uuid(), md5('r0-prop-1')::uuid, 'CONTROL INSERT', 'open', 'scale_control', 'regular', $1)`,
    (n) => [9000000 + n], "inserts", "insert_fail", "insert_max_ms");
  //  THE PROBE THAT MATTERS: a write to the table the ALTER actually locks.
  await probe("attach",
    `insert into public.work_order_proof_attachments
       (id, work_order_id, property_id, uploaded_by_user_id, mime_type,
        storage_state, proof_classification, received_at, provider)
     values (gen_random_uuid(), md5('r0-wo-7')::uuid, md5('r0-prop-3')::uuid,
             md5('r0-user-1')::uuid, 'image/jpeg', 'referenced', 'other', now(), 'scale_control')`,
    null, "attach_writes", "attach_write_fail", "attach_write_max_ms");

  //  ISOLATION FIRST, AS A SEPARATE STATEMENT. The payload is byte-
  //  promotable to production and therefore cannot carry a database-name
  //  check; the assertion runs ahead of it on the same connection.
  await c.query(fs.readFileSync(WRAPPER, "utf8"));

  //  RE-VERIFY THE DIGEST IMMEDIATELY BEFORE EXECUTING. Hashing the file
  //  once at startup and executing it later proves nothing about what was
  //  actually run.
  const payloadSql = fs.readFileSync(PAYLOAD, "utf8");
  const digestNow = crypto.createHash("sha256").update(payloadSql).digest("hex");
  if (digestNow !== R.payload_sha256) {
    throw new Error("payload digest changed between recording and execution");
  }
  //  Apply the payload. ONE transaction — the boundary the file itself
  //  declares, which is the boundary production will use.
  const applied = await timed(() => c.query(payloadSql));
  R.phases.migration = { total_ms: applied.msec };
  console.log("  candidate applied in      " + applied.msec + " ms");

  working = false; observing = false;
  await Promise.all(probes); await observer;
  await work.query("delete from public.work_order_proof_attachments where provider='scale_control'");
  await work.query("delete from public.work_orders where source='scale_control'");

  //  Per-object timings, measured by re-applying each piece to a scratch
  //  clone of the same shape. Reported separately because a single total
  //  hides which object owns the cost.
  const perIndex = {};
  for (const [name, ddl] of [
    ["uq_wope_genesis", "create unique index x_g on public.work_order_proof_evaluations (work_order_id, property_id) where supersedes_id is null"],
    ["uq_wope_one_successor", "create unique index x_s on public.work_order_proof_evaluations (supersedes_id) where supersedes_id is not null"],
    ["idx_wope_scope", "create index x_sc on public.work_order_proof_evaluations (work_order_id, property_id)"],
  ]) {
    const t = await timed(async () => { await c.query(ddl); });
    perIndex[name + " (rebuild on empty table)"] = t.msec;
    await c.query("drop index " + ddl.match(/index (\w+)/)[1]);
  }
  R.phases.migration.index_rebuild_ms = perIndex;

  const locked = new Map();
  for (const s of lockSamples) for (const r of s.rows) {
    const k = `${r.obj} ${r.mode}${r.granted ? "" : " (WAITING)"}`;
    locked.set(k, (locked.get(k) || 0) + 1);
  }
  R.phases.migration.lock_observations = Object.fromEntries(locked);
  R.phases.migration.lock_samples = lockSamples.length;
  R.phases.migration.control_workload = control;
  R.phases.migration.db_size_after = (await one(c, "select pg_size_pretty(pg_database_size(current_database())) s")).s;

  console.log("  lock samples taken        " + lockSamples.length);
  console.log("  control iterations        " + control.iterations);
  console.log("  control: reads " + control.reads + " / inserts " + control.inserts
            + " / list " + control.list_reads + " / attach-writes " + control.attach_writes
            + "  failures " + (control.read_fail + control.insert_fail + control.list_fail
                               + control.attach_write_fail));
  console.log("  attach-write max latency  " + control.attach_write_max_ms + " ms  ← the locked table");
  console.log("  probe max latency  read " + control.read_max_ms + "  list " + control.list_max_ms
            + "  wo-insert " + control.insert_max_ms);
  console.log("  db size after             " + R.phases.migration.db_size_after);

  ok("M1  payload applied without error", true);
  ok("M1b the payload carries NO harness-only identity check",
     !/r0scale|release_0_scale_harness_guard|ISOLATED RELEASE 0|schema_migrations/.test(payloadSql),
     "payload contains a harness-only reference");
  ok("M1c the executed bytes match the recorded digest", digestNow === R.payload_sha256);
  ok("M2  the control workload never failed",
     control.read_fail === 0 && control.insert_fail === 0 && control.list_fail === 0
     && control.attach_write_fail === 0,
     JSON.stringify(control.errors.slice(0, 3)));
  ok("M2b the workload ran enough iterations to mean something",
     control.iterations >= 5, "iterations=" + control.iterations);
  ok("M2c writes to the LOCKED table were probed and none failed",
     control.attach_writes > 0 && control.attach_write_fail === 0,
     `writes=${control.attach_writes} fail=${control.attach_write_fail}`);
  ok("M3  ordinary reads continued during the migration", control.reads > 0, String(control.reads));
  ok("M4  unrelated work-order inserts continued during the migration",
     control.inserts > 0, String(control.inserts));
  ok("M5  locks were actually observed (the observer was not asleep)",
     lockSamples.length > 0, String(lockSamples.length));
  //  The migration creates NEW tables, so it does NOT take an exclusive
  //  lock on work_orders — except for the ALTER TABLE adding the unique
  //  constraint on the ATTACHMENTS table, which does. Named, not glossed.
  R.phases.migration.note =
    "The payload creates new tables (no lock on work_orders) but ALTERs "
    + "work_order_proof_attachments to add uq_wopa_id_scope, which takes "
    + "ACCESS EXCLUSIVE on that table and builds a unique index over it. "
    + "That is the one blocking step and it scales with attachment count.";

  // ── the ALTER is the real risk: measure it against attachment volume ──
  const attN = await num(c, "select count(*) from public.work_order_proof_attachments");
  R.phases.migration.attachments_at_alter = attN;
  console.log("  attachments at ALTER      " + attN);

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 2b — POST-MIGRATION FIXTURE (chains, links, inventory)");
  // ══════════════════════════════════════════════════════════════════
  const post = await timed(() =>
    c.query(fs.readFileSync(path.join(HERE, "fixture_post_migration.sql"), "utf8")));
  console.log("  built in                  " + post.msec + " ms");
  R.phases.fixture_post_ms = post.msec;

  const evalN = await num(c, "select count(*) from public.work_order_proof_evaluations");
  const headN = await num(c, "select count(*) from public.work_order_proof_evaluation_head");
  const invN = await num(c, "select count(*) from public.release_0_legacy_cutover_inventory");
  const linkN = await num(c, "select count(*) from public.work_order_proof_evaluation_attachments");
  R.phases.fixture_cardinalities = { evaluations: evalN, heads: headN, inventory: invN, links: linkN };
  console.log("  evaluations " + evalN + "  heads " + headN + "  inventory " + invN + "  links " + linkN);

  ok("F1  28,000 chains, one head each", headN === 28000, String(headN));
  ok("F2  evaluations exceed heads (deep chains exist)", evalN > headN, `${evalN} vs ${headN}`);
  ok("F3  inventory is 25,000", invN === 25000, String(invN));
  ok("F4  evaluation→attachment links exist", linkN > 0, String(linkN));

  const depths = await q(c, `
    with recursive chain as (
      select id, work_order_id, 1 d from public.work_order_proof_evaluations where supersedes_id is null
      union all
      select e.id, e.work_order_id, chain.d + 1
        from public.work_order_proof_evaluations e join chain on e.supersedes_id = chain.id)
    select d::int depth, count(*)::int n from chain group by 1 having count(*) > 0 order by 1 desc limit 6`);
  R.phases.chain_depth_distribution = depths;
  console.log("  deepest chain levels      " + JSON.stringify(depths.slice(0, 3)));
  ok("F5  a chain of depth 1000 exists", depths.some(d => d.depth >= 1000),
     JSON.stringify(depths.slice(0, 2)));

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 4 — CORRECTNESS INVARIANTS");
  // ══════════════════════════════════════════════════════════════════
  const inv = {};
  const chk = async (name, sql, expect0 = true) => {
    const n = await num(c, sql);
    inv[name] = n;
    return ok(name, expect0 ? n === 0 : n > 0, "count=" + n);
  };
  await chk("I1  every evaluation shares its work order's property",
    `select count(*) from public.work_order_proof_evaluations e
       join public.work_orders w on w.id = e.work_order_id
      where w.property_id <> e.property_id`);
  await chk("I2  every link is in its evaluation's scope",
    `select count(*) from public.work_order_proof_evaluation_attachments l
       join public.work_order_proof_evaluations e on e.id = l.evaluation_id
      where e.work_order_id <> l.work_order_id or e.property_id <> l.property_id`);
  await chk("I3  at most one genesis per scope",
    `select count(*) from (select work_order_id, property_id from public.work_order_proof_evaluations
       where supersedes_id is null group by 1,2 having count(*) > 1) x`);
  await chk("I4  at most one successor per predecessor",
    `select count(*) from (select supersedes_id from public.work_order_proof_evaluations
       where supersedes_id is not null group by 1 having count(*) > 1) x`);
  await chk("I5  exactly one head per non-empty chain",
    `select count(*) from (select work_order_id, property_id from public.work_order_proof_evaluation_head
       group by 1,2 having count(*) <> 1) x`);
  await chk("I6  activation history has exactly one head",
    `select count(*) from (select count(*) n from public.release_0_activation_current) x where x.n <> 1`);

  sub("refusals — each must fail, and for the NAMED reason");
  await c.query("begin");
  const anyWo = await one(c,
    `select w.id, w.property_id from public.work_orders w where w.source='scale_fixture'
      and not exists (select 1 from public.work_order_proof_evaluations e where e.work_order_id=w.id) limit 1`);
  const headRow = await one(c, "select * from public.work_order_proof_evaluation_head limit 1");
  const nonHead = await one(c,
    `select e.* from public.work_order_proof_evaluations e
      where exists (select 1 from public.work_order_proof_evaluations s where s.supersedes_id = e.id) limit 1`);
  const otherWo = await one(c,
    `select w.id, w.property_id from public.work_orders w where w.source='scale_fixture'
       and w.property_id <> $1 limit 1`, [headRow.property_id]);

  const INS = `insert into public.work_order_proof_evaluations
    (id, work_order_id, property_id, state, evaluated_by_service, rule_version, supersedes_id)
    values ($1,$2,$3,'satisfied','proof','v1',$4)`;
  const refusals = {};
  const refuse = async (name, args, expectRe) => {
    const r = await mustRefuse(c, INS, args);
    refusals[name] = r;
    return ok(name, r.refused && (!expectRe || expectRe.test(r.message || "")),
       r.refused ? "message: " + r.message : "NOT REFUSED");
  };
  const selfId = crypto.randomUUID();
  await refuse("I7   self-supersession refused",
    [selfId, headRow.work_order_id, headRow.property_id, selfId], /supersede itself/);
  await refuse("I8   second genesis refused",
    [crypto.randomUUID(), headRow.work_order_id, headRow.property_id, null], /genesis refused/);
  await refuse("I9   missing predecessor refused",
    [crypto.randomUUID(), headRow.work_order_id, headRow.property_id, crypto.randomUUID()],
    /does not exist/);
  await refuse("I10  successor to a non-head refused",
    [crypto.randomUUID(), nonHead.work_order_id, nonHead.property_id, nonHead.id], /not the head/);
  await refuse("I11  cross-scope predecessor refused",
    [crypto.randomUUID(), otherWo.id, otherWo.property_id, headRow.id],
    /cross-scope|predecessor|violates/);

  const up = await mustRefuse(c,
    "update public.work_order_proof_evaluations set state='not_satisfied' where id=$1", [headRow.id]);
  refusals.update = up;
  ok("I12  UPDATE refused", up.refused && /append-only/.test(up.message || ""), up.message);
  const del = await mustRefuse(c,
    "delete from public.work_order_proof_evaluations where id=$1", [headRow.id]);
  refusals.delete = del;
  ok("I13  DELETE refused", del.refused && /append-only/.test(del.message || ""), del.message);

  const invDel = await mustRefuse(c,
    "delete from public.release_0_legacy_cutover_inventory where work_order_id = (select work_order_id from public.release_0_legacy_cutover_inventory limit 1)");
  refusals.inventory_delete = invDel;
  ok("I14  legacy inventory is immutable", invDel.refused && /append-only/.test(invDel.message || ""), invDel.message);

  const actGen = await mustRefuse(c,
    `insert into public.release_0_activation_history (activated_at, captured_at_step, captured_by)
     values (now(), 'x', 'y')`);
  refusals.second_activation_genesis = actGen;
  ok("I15  second activation genesis refused",
     actGen.refused && /not empty|uq_r0ah_genesis|duplicate key/.test(actGen.message || ""), actGen.message);

  const actHead = await one(c, "select id from public.release_0_activation_current");
  const actNoReason = await mustRefuse(c,
    `insert into public.release_0_activation_history (activated_at, captured_at_step, captured_by, supersedes_id, reason)
     values (now(), 'x', 'y', $1, '   ')`, [actHead.id]);
  refusals.activation_blank_reason = actNoReason;
  ok("I16  a correction with a blank reason is refused",
     actNoReason.refused && /non-empty reason/.test(actNoReason.message || ""), actNoReason.message);

  await c.query("rollback");
  R.phases.invariants = { counts: inv, refusals };

  sub("after every accepted append, the invariant is re-checked");
  //  Not only at the end: append, verify, append, verify.
  await c.query("begin");
  //  Safe to draw from the fixture: this whole block rolls back.
  const appendWo = anyWo;
  let prev = null;
  let reGood = true;
  for (let k = 0; k < 5; k++) {
    const id = crypto.randomUUID();
    await c.query(INS, [id, appendWo.id, appendWo.property_id, prev]);
    prev = id;
    const heads = await num(c,
      `select count(*) from public.work_order_proof_evaluation_head
        where work_order_id=$1 and property_id=$2`, [appendWo.id, appendWo.property_id]);
    const genesis = await num(c,
      `select count(*) from public.work_order_proof_evaluations
        where work_order_id=$1 and property_id=$2 and supersedes_id is null`,
      [appendWo.id, appendWo.property_id]);
    if (heads !== 1 || genesis !== 1) reGood = false;
  }
  ok("I17  one head and one genesis after EVERY one of 5 appends", reGood);
  await c.query("rollback");

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 5 — REAL CONCURRENCY (deterministic overlap)");
  // ══════════════════════════════════════════════════════════════════
  //  Two independent connections, both INSIDE open transactions at the
  //  same time, coordinated by an advisory lock so the overlap is
  //  deterministic rather than hoped for. Two promises without proven
  //  overlap is not a concurrency proof.
  const races = {};

  //  RACE ROWS ARE THEIR OWN POPULATION.
  //  The first cut drew race subjects from the measured fixture, so three
  //  genesis inserts moved three work orders from not_due to satisfied and
  //  phase 6 read 39,997/20,003 instead of 40,000/20,000. The numbers were
  //  right; the population had been mutated by the test that ran before it.
  //  Race subjects now carry source='scale_race', which the reader filters
  //  out — the concurrency phase can no longer perturb what phase 6 measures.
  let raceSeq = 0;
  async function raceWorkOrder() {
    const id = crypto.randomUUID();
    raceSeq++;
    await c.query(
      `insert into public.work_orders (id, property_id, title, status, source, urgency_status, work_order_ref)
       values ($1, md5('r0-prop-1')::uuid, 'RACE SUBJECT', 'open', 'scale_race', 'regular', $2)`,
      [id, 8000000 + raceSeq]);
    return { id, property_id: (await one(c, "select md5('r0-prop-1')::uuid p")).p };
  }
  async function race(name, setupFn, aSql, aArgs, bSql, bArgs) {
    const A = await conn(), B = await conn();
    await A.query("set application_name='r0_race_A'");
    await B.query("set application_name='r0_race_B'");
    const ctx = setupFn ? await setupFn(A) : {};
    await A.query("begin"); await B.query("begin");
    const started = { a: Date.now(), b: null };

    //  A goes first and HOLDS its transaction open.
    let aErr = null;
    try { await A.query(typeof aSql === "function" ? aSql(ctx) : aSql,
                        typeof aArgs === "function" ? aArgs(ctx) : aArgs); }
    catch (e) { aErr = e; }

    //  B now starts while A is still open — proven by checking that B is
    //  waiting, or that it errors on the unique index.
    started.b = Date.now();
    const bp = (async () => {
      try { await B.query(typeof bSql === "function" ? bSql(ctx) : bSql,
                          typeof bArgs === "function" ? bArgs(ctx) : bArgs); return null; }
      catch (e) { return e; }
    })();

    //  OVERLAP EVIDENCE: sample pg_stat_activity for B blocking on A.
    let overlapProven = false, waitEvent = null;
    for (let i = 0; i < 60; i++) {
      const w = await q(c,
        `select wait_event_type, wait_event, state from pg_stat_activity
          where application_name='r0_race_B' and state <> 'idle'`);
      if (w.length && w[0].wait_event_type === "Lock") { overlapProven = true; waitEvent = w[0].wait_event; break; }
      if (w.length && w[0].state === "active") { /* still running */ }
      await new Promise(r => setTimeout(r, 25));
    }
    await A.query("commit");
    const bErr = await bp;
    try { await B.query("commit"); } catch (_) { try { await B.query("rollback"); } catch (_) {} }

    const out = {
      a_started: started.a, b_started: started.b,
      overlap_proven_by_lock_wait: overlapProven, wait_event: waitEvent,
      a_error: aErr ? aErr.message : null,
      b_error: bErr ? bErr.message : null,
      b_constraint: bErr ? (bErr.constraint || null) : null,
      winner: aErr ? (bErr ? "neither" : "B") : (bErr ? "A" : "BOTH — INVARIANT BREACH"),
    };
    races[name] = out;
    await A.end(); await B.end();
    return out;
  }

  //  two concurrent genesis inserts on the SAME empty scope
  {
    const w = await raceWorkOrder();
    const r = await race("genesis_vs_genesis", null,
      INS, [crypto.randomUUID(), w.id, w.property_id, null],
      INS, [crypto.randomUUID(), w.id, w.property_id, null]);
    ok("R1  two concurrent genesis inserts → exactly one wins",
       r.winner === "A" || r.winner === "B", JSON.stringify(r));
    ok("R1b overlap was PROVEN, not assumed",
       r.overlap_proven_by_lock_wait || /duplicate key|genesis refused/.test(r.b_error || ""),
       JSON.stringify({ overlap: r.overlap_proven_by_lock_wait, b: r.b_error }));
    const n = await num(c,
      "select count(*) from public.work_order_proof_evaluations where work_order_id=$1", [w.id]);
    ok("R1c exactly one genesis row survives", n === 1, String(n));
  }

  //  two concurrent successors to the SAME head
  {
    const w = await raceWorkOrder();
    const gid = crypto.randomUUID();
    await c.query(INS, [gid, w.id, w.property_id, null]);
    const r = await race("successor_vs_successor", null,
      INS, [crypto.randomUUID(), w.id, w.property_id, gid],
      INS, [crypto.randomUUID(), w.id, w.property_id, gid]);
    ok("R2  two concurrent successors to one head → exactly one wins",
       r.winner === "A" || r.winner === "B", JSON.stringify(r));
    ok("R2b overlap PROVEN by a lock wait on the predecessor row",
       r.overlap_proven_by_lock_wait, JSON.stringify(r));
    const n = await num(c,
      "select count(*) from public.work_order_proof_evaluations where supersedes_id=$1", [gid]);
    ok("R2c exactly one successor survives", n === 1, String(n));
    const h = await num(c,
      "select count(*) from public.work_order_proof_evaluation_head where work_order_id=$1", [w.id]);
    ok("R2d exactly one visible head remains", h === 1, String(h));
  }

  //  two concurrent activation-history genesis inserts
  {
    //  HARNESS TEARDOWN, and the append-only triggers refused it — which is
    //  the triggers doing their job. Both tables carry their own no_delete
    //  trigger, so both must be disabled explicitly and re-enabled
    //  immediately. This is the harness resetting its own fixture, not the
    //  candidate permitting a delete.
    await c.query("begin");
    await c.query("alter table public.release_0_legacy_cutover_inventory disable trigger no_delete_r0lci");
    await c.query("alter table public.release_0_activation_history disable trigger no_delete_r0ah");
    await c.query("delete from public.release_0_legacy_cutover_inventory");
    await c.query("delete from public.release_0_activation_history");
    await c.query("alter table public.release_0_activation_history enable trigger no_delete_r0ah");
    await c.query("alter table public.release_0_legacy_cutover_inventory enable trigger no_delete_r0lci");
    await c.query("commit");
    const AH = `insert into public.release_0_activation_history
      (activated_at, captured_at_step, captured_by) values (timestamptz '2026-01-01', 'x', 'y')`;
    const r = await race("activation_genesis_race", null, AH, [], AH, []);
    ok("R3  two concurrent activation genesis inserts → exactly one wins",
       r.winner === "A" || r.winner === "B", JSON.stringify(r));
    const n = await num(c, "select count(*) from public.release_0_activation_history");
    ok("R3b exactly one activation row survives", n === 1, String(n));
  }

  //  two concurrent corrections to the SAME activation head
  {
    const h = await one(c, "select id from public.release_0_activation_current");
    const AC = `insert into public.release_0_activation_history
      (activated_at, captured_at_step, captured_by, supersedes_id, reason)
      values (timestamptz '2026-01-02', 'x', 'y', $1, 'correction')`;
    const r = await race("activation_correction_race", null, AC, [h.id], AC, [h.id]);
    ok("R4  two concurrent corrections to one head → exactly one wins",
       r.winner === "A" || r.winner === "B", JSON.stringify(r));
    ok("R4b overlap PROVEN by a lock wait", r.overlap_proven_by_lock_wait, JSON.stringify(r));
    const n = await num(c, "select count(*) from public.release_0_activation_current");
    ok("R4c exactly one current activation", n === 1, String(n));
  }

  //  concurrent append and reader-head query
  {
    const w = await raceWorkOrder();
    const A2 = await conn(), B2 = await conn();
    await A2.query("begin");
    await A2.query(INS, [crypto.randomUUID(), w.id, w.property_id, null]);
    //  the reader runs while the append is UNCOMMITTED
    const during = await num(B2,
      "select count(*) from public.work_order_proof_evaluation_head where work_order_id=$1", [w.id]);
    await A2.query("commit");
    const after = await num(B2,
      "select count(*) from public.work_order_proof_evaluation_head where work_order_id=$1", [w.id]);
    races.append_vs_reader = { head_during_uncommitted: during, head_after_commit: after };
    ok("R5  a reader never sees an uncommitted append", during === 0, String(during));
    ok("R5b the reader sees exactly one head after commit", after === 1, String(after));
    await A2.end(); await B2.end();
  }

  //  concurrent duplicate legacy-inventory insert
  {
    const act = await one(c, "select id from public.release_0_activation_current");
    const w = await one(c,
      `select w.id, w.property_id, w.status from public.work_orders w
        where w.source='scale_fixture' and w.status in ('complete','closed') limit 1`);
    const LI = `insert into public.release_0_legacy_cutover_inventory
      (work_order_id, property_id, status_at_cutover, had_column_photo, had_column_note, activation_id)
      values ($1,$2,$3,false,false,$4)`;
    const r = await race("inventory_duplicate_race", null,
      LI, [w.id, w.property_id, w.status, act.id],
      LI, [w.id, w.property_id, w.status, act.id]);
    ok("R6  concurrent duplicate inventory insert → exactly one wins",
       r.winner === "A" || r.winner === "B", JSON.stringify(r));
    const n = await num(c,
      "select count(*) from public.release_0_legacy_cutover_inventory where work_order_id=$1", [w.id]);
    ok("R6b exactly one inventory row survives", n === 1, String(n));
  }
  R.phases.concurrency = races;

  //  Rebuild the inventory from the CANONICAL predicate. The activation race
  //  cleared it and the duplicate race added one row for an arbitrary terminal
  //  work order; rebuilding from the predicate rather than patching it back
  //  means phase 6 measures the designed population either way.
  await c.query("alter table public.release_0_legacy_cutover_inventory disable trigger no_delete_r0lci");
  await c.query("delete from public.release_0_legacy_cutover_inventory");
  await c.query("alter table public.release_0_legacy_cutover_inventory enable trigger no_delete_r0lci");
  const actNow = await one(c, "select id from public.release_0_activation_current");
  await c.query(`
    insert into public.release_0_legacy_cutover_inventory
      (work_order_id, property_id, status_at_cutover, had_column_photo, had_column_note, activation_id)
    select w.id, w.property_id, w.status,
           w.completion_photo is not null, w.completion_note is not null, $1
      from public.work_orders w
     where w.source='scale_fixture' and w.status in ('complete','closed')
       and not exists (select 1 from public.work_order_proof_evaluations e
                        where e.work_order_id=w.id and e.property_id=w.property_id)
       and (w.work_order_ref - 1000000) % 100 between 68 and 92`, [actNow.id]);

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 6 — READER, SWEEP AND ACTIVATION");
  // ══════════════════════════════════════════════════════════════════
  await c.query("analyze");
  const reader = await timed(() => q(c, READER_SQL));
  R.phases.reader = { distribution: reader.v, ms: reader.msec };
  console.log("  four-state distribution   " + JSON.stringify(reader.v));
  console.log("  reader latency            " + reader.msec + " ms");

  const dist = Object.fromEntries(reader.v.map(r => [r.state, Number(r.n)]));
  ok("S1  satisfied population present", dist.satisfied > 0, JSON.stringify(dist));
  ok("S2  not_satisfied population present", dist.not_satisfied > 0);
  ok("S3  legacy_indeterminate is 25,000", dist.legacy_indeterminate === 25000,
     String(dist.legacy_indeterminate));
  ok("S4  missing_evaluation_defect is 7,000", dist.missing_evaluation_defect === 7000,
     String(dist.missing_evaluation_defect));
  ok("S5  non-terminal rows are not_due, never a defect", dist.not_due === 40000,
     String(dist.not_due));

  //  EXACT-SET reconciliation, both directions. Not a count comparison.
  const sweep1 = await timed(() => q(c, DEFECT_SQL));
  const readerDefects = await q(c, `
    select w.id from public.work_orders w
     left join public.work_order_proof_evaluation_head h
       on h.work_order_id=w.id and h.property_id=w.property_id
     left join public.release_0_legacy_cutover_inventory i
       on i.work_order_id=w.id and i.property_id=w.property_id
     where w.status in ('complete','closed') and h.id is null and i.work_order_id is null`);
  const sa = new Set(sweep1.v.map(r => r.id));
  const sb = new Set(readerDefects.map(r => r.id));
  const onlySweep = [...sa].filter(x => !sb.has(x));
  const onlyReader = [...sb].filter(x => !sa.has(x));
  R.phases.sweep = {
    sweep_count: sa.size, reader_count: sb.size,
    only_in_sweep: onlySweep.length, only_in_reader: onlyReader.length,
    sweep_ms: sweep1.msec,
  };
  console.log("  defect sweep              " + sa.size + " rows in " + sweep1.msec + " ms");
  ok("S6  reader and sweep agree on EXACT ids, both directions",
     onlySweep.length === 0 && onlyReader.length === 0 && sa.size === sb.size,
     `sweep-only ${onlySweep.length}, reader-only ${onlyReader.length}`);
  ok("S7  the defect set includes CLOSED rows (correction 7)",
     await num(c, `select count(*) from (${DEFECT_SQL}) d
                    join public.work_orders w on w.id = d.id where w.status='closed'`) === 3000);

  const sweep2 = await timed(() => q(c, DEFECT_SQL));
  const sa2 = new Set(sweep2.v.map(r => r.id));
  ok("S8  the sweep is idempotent — second run returns the identical set",
     sa2.size === sa.size && [...sa2].every(x => sa.has(x)),
     `${sa2.size} vs ${sa.size}`);
  R.phases.sweep.second_run_ms = sweep2.msec;

  sub("query plans for the load-bearing reads");
  const plans = {};
  for (const [name, sql] of [
    ["four_state_reader", READER_SQL],
    ["defect_sweep", DEFECT_SQL],
    ["list_page_50", `select w.id, w.status, h.state from public.work_orders w
        left join public.work_order_proof_evaluation_head h
          on h.work_order_id=w.id and h.property_id=w.property_id
        where w.property_id = (select property_id from public.work_orders where source='scale_fixture' limit 1)
        order by w.created_at desc limit 50`],
    ["detail_single", `select w.id, h.state from public.work_orders w
        left join public.work_order_proof_evaluation_head h
          on h.work_order_id=w.id and h.property_id=w.property_id
        where w.id = (select id from public.work_orders where source='scale_fixture' limit 1)`],
    ["inventory_lookup", `select * from public.release_0_legacy_cutover_inventory
        where work_order_id = (select work_order_id from public.release_0_legacy_cutover_inventory limit 1)`],
  ]) {
    const t = await timed(() => q(c, `explain (analyze, buffers, wal, settings, format json) ${sql}`));
    const p = t.v[0]["QUERY PLAN"][0];
    plans[name] = {
      ms: ms(p["Execution Time"]), planning_ms: ms(p["Planning Time"]),
      node: p.Plan["Node Type"],
      shared_hit: p.Plan["Shared Hit Blocks"], shared_read: p.Plan["Shared Read Blocks"],
    };
    console.log(`  ${name.padEnd(20)} ${plans[name].ms} ms   ${plans[name].node}`);
  }
  R.phases.plans = plans;

  //  the activation transaction, timed as ONE transaction
  const act2 = await timed(async () => {
    await c.query("begin");
    await c.query("select count(*) from public.release_0_legacy_cutover_inventory");
    await c.query("commit");
  });
  R.phases.activation_tx_ms = act2.msec;
  console.log("  activation tx (read-back) " + act2.msec + " ms");

  // ══════════════════════════════════════════════════════════════════
  sec("PHASE 7 — CHAIN DEPTH AND CORRUPTION CONTROL");
  // ══════════════════════════════════════════════════════════════════
  const deep = await one(c, `
    with recursive chain as (
      select id, work_order_id, property_id, 1 d from public.work_order_proof_evaluations where supersedes_id is null
      union all
      select e.id, e.work_order_id, e.property_id, chain.d+1
        from public.work_order_proof_evaluations e join chain on e.supersedes_id = chain.id)
    select work_order_id, property_id, max(d)::int depth from chain
     group by 1,2 order by depth desc limit 1`);
  const headOfDeep = await one(c,
    "select id from public.work_order_proof_evaluation_head where work_order_id=$1", [deep.work_order_id]);
  const appendDeep = await timed(async () => {
    await c.query("begin");
    await c.query(INS, [crypto.randomUUID(), deep.work_order_id, deep.property_id, headOfDeep.id]);
    await c.query("rollback");
  });
  const readDeep = await timed(() =>
    q(c, "select * from public.work_order_proof_evaluation_head where work_order_id=$1", [deep.work_order_id]));
  R.phases.chain_depth = {
    deepest: deep.depth, append_at_depth_ms: appendDeep.msec, head_read_ms: readDeep.msec,
    distribution: depths,
  };
  console.log("  deepest chain             " + deep.depth);
  console.log("  append at that depth      " + appendDeep.msec + " ms (walks the whole chain)");
  console.log("  head read at that depth   " + readDeep.msec + " ms");
  ok("D1  an append at depth " + deep.depth + " still succeeds", appendDeep.msec >= 0);

  sub("corrupt fixture — IMPOSSIBLE through normal DML, built by disabling the guard");
  //  Explicitly separated. The guard is disabled ONLY here, only to build
  //  a shape normal DML cannot produce, and re-enabled immediately.
  await c.query("begin");
  const cw = await one(c,
    `select w.id, w.property_id from public.work_orders w where w.source='scale_fixture'
      and not exists (select 1 from public.work_order_proof_evaluations e where e.work_order_id=w.id)
      limit 1 offset 40`);
  const x1 = crypto.randomUUID(), x2 = crypto.randomUUID();
  await c.query("alter table public.work_order_proof_evaluations disable trigger chain_guard_wope");
  await c.query(INS, [x1, cw.id, cw.property_id, null]);
  await c.query(INS, [x2, cw.id, cw.property_id, x1]);
  //  make it a two-cycle: x1 now supersedes x2. Requires disabling the
  //  append-only trigger too — which is precisely why this is labelled
  //  impossible through normal DML.
  await c.query("alter table public.work_order_proof_evaluations disable trigger no_update_wope");
  await c.query("update public.work_order_proof_evaluations set supersedes_id=$1 where id=$2", [x2, x1]);
  await c.query("alter table public.work_order_proof_evaluations enable trigger no_update_wope");
  await c.query("alter table public.work_order_proof_evaluations enable trigger chain_guard_wope");

  const extendCorrupt = await mustRefuse(c, INS, [crypto.randomUUID(), cw.id, cw.property_id, x2]);
  R.phases.corrupt_chain = extendCorrupt;
  ok("D2  a corrupt (cyclic) chain CANNOT be extended",
     extendCorrupt.refused, extendCorrupt.message || "NOT REFUSED");
  ok("D3  the refusal names the corruption, not a generic error",
     /chain walk exceeded bound|cycle refused|not the head/.test(extendCorrupt.message || ""),
     extendCorrupt.message);
  await c.query("rollback");
  const stillClean = await num(c,
    "select count(*) from public.work_order_proof_evaluations where work_order_id=$1", [cw.id]);
  ok("D4  the corrupt fixture left no trace in the main population", stillClean === 0, String(stillClean));

  console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}`);
  R.summary = { passed: pass, failed: fail };

  await c.end(); await obs.end(); await work.end();

  const outIdx = process.argv.indexOf("--json");
  if (outIdx > -1) {
    fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(R, null, 2));
    console.log("  receipt → " + process.argv[outIdx + 1]);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHARNESS ERROR — no result is claimed:\n" + (e && e.stack || e));
  process.exit(1);
});
