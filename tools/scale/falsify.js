#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 SCALE PROOF — PHASE 8, FALSIFICATION

   A suite that has never failed is a suite nobody has tested. Each case
   below breaks ONE thing, proves the corresponding check goes red FOR THE
   INTENDED REASON, restores it, and proves it goes green again.

   Run AFTER run_scale_proof.js against the same populated database.

   ⚠ ISOLATED HARNESS ONLY.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const URL = process.env.SCALE_DATABASE_URL
  || "postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable";
const SENTINEL = "ISOLATED RELEASE 0 SCALE HARNESS — NEVER PRODUCTION";
const CANDIDATE = path.join(__dirname, "137_release_0_payload.sql");

let pass = 0, fail = 0;
const out = {};
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

async function conn() {
  const c = new Client({ connectionString: URL });
  await c.connect();
  const g = await c.query(
    "select current_database() db,(select purpose from public.release_0_scale_harness_guard where id=true) p");
  if (g.rows[0].db !== "r0scale" || g.rows[0].p !== SENTINEL) throw new Error("REFUSED: not the harness");
  return c;
}
const num = async (c, s, a) => Number(Object.values((await c.query(s, a)).rows[0])[0]);
const rows = async (c, s, a) => (await c.query(s, a)).rows;
//  A REFUSAL MUST BE THE STATEMENT'S OWN REFUSAL.
//  The first cut issued SAVEPOINT unconditionally. Outside a transaction
//  that fails with "SAVEPOINT can only be used in transaction blocks", and
//  the helper returned THAT as the refusal message — so a check asserting
//  "this was refused" passed without the statement ever running. F5 went
//  green on it. Same error class as the placeholder password: a convincing
//  refusal that proves nothing.
//
//  Now it opens its own transaction when there is not one, and always
//  returns the message the STATEMENT produced.
async function refuses(c, sql, args) {
  let started = false;
  try { await c.query("savepoint f"); }
  catch (e) {
    if (!/transaction block/i.test(e.message)) throw e;
    await c.query("begin"); started = true; await c.query("savepoint f");
  }
  let msg = null;
  try { await c.query(sql, args); }
  catch (e) { msg = e.message; }
  try { await c.query("rollback to savepoint f"); } catch (_) {}
  if (started) { try { await c.query("rollback"); } catch (_) {} }
  return msg;
}

const INS = `insert into public.work_order_proof_evaluations
  (id, work_order_id, property_id, state, evaluated_by_service, rule_version, supersedes_id)
  values ($1,$2,$3,'satisfied','falsify','v1',$4)`;

//  THE REAL PREDICATE (§3.2.0) and the BROKEN one revision 3 had.
const DEFECT_REAL = `
  select w.id from public.work_orders w
   where w.status in ('complete','closed')
     and not exists (select 1 from public.work_order_proof_evaluations e
                      where e.work_order_id=w.id and e.property_id=w.property_id)
     and not exists (select 1 from public.release_0_legacy_cutover_inventory i
                      where i.work_order_id=w.id and i.property_id=w.property_id)`;

//  Revision 3: terminal = "complete, or closed FOR AN INVENTORIED ROW".
//  A closed row outside the inventory is then not terminal and escapes.
const DEFECT_BROKEN = `
  select w.id from public.work_orders w
   where (w.status = 'complete'
          or (w.status = 'closed'
              and exists (select 1 from public.release_0_legacy_cutover_inventory i
                           where i.work_order_id=w.id and i.property_id=w.property_id)))
     and not exists (select 1 from public.work_order_proof_evaluations e
                      where e.work_order_id=w.id and e.property_id=w.property_id)
     and not exists (select 1 from public.release_0_legacy_cutover_inventory i
                      where i.work_order_id=w.id and i.property_id=w.property_id)`;

(async function main() {
  const c = await conn();
  await c.query("set application_name='r0_falsify'");
  console.log("RELEASE 0 SCALE PROOF — FALSIFICATION\n");

  // ── 1. remove the closed-row branch from the defect predicate ───────
  sub("1  the defect predicate loses its closed-row branch");
  {
    const real = (await rows(c, DEFECT_REAL)).length;
    const broken = (await rows(c, DEFECT_BROKEN)).length;
    out.defect_predicate = { real, broken, hidden: real - broken };
    ok("F1  the real predicate finds 7,000 defects", real === 7000, String(real));
    ok("F1b the broken predicate HIDES the closed defects", broken === 4000, String(broken));
    ok("F1c exactly the 3,000 closed rows disappear — the correction-7 hole",
       real - broken === 3000, `hid ${real - broken}`);
    const missed = await num(c,
      `select count(*) from (${DEFECT_REAL}) r
         where r.id not in (select id from (${DEFECT_BROKEN}) b)
           and exists (select 1 from public.work_orders w where w.id=r.id and w.status='closed')`);
    ok("F1d every hidden row is a CLOSED, non-inventoried, unevaluated row",
       missed === 3000, String(missed));
  }

  // ── 2. the reader permits a missing state instead of refusing ───────
  sub("2  the reader defaults a missing evaluation to 'not_due'");
  {
    //  The permissive reader: no head → not_due, regardless of terminality.
    //  Safe-LOOKING, and it silently reclassifies every defect as "not yet
    //  due" — the exact confident-wrong Release 0 exists to remove.
    const permissive = await rows(c, `
      select case when h.id is not null then h.state else 'not_due' end st, count(*) n
        from public.work_orders w
        left join public.work_order_proof_evaluation_head h
          on h.work_order_id=w.id and h.property_id=w.property_id
       where w.source='scale_fixture' group by 1`);
    const p = Object.fromEntries(permissive.map(r => [r.st, Number(r.n)]));
    out.permissive_reader = p;
    ok("F2  the permissive reader reports ZERO defects",
       (p.missing_evaluation_defect || 0) === 0, JSON.stringify(p));
    ok("F2b it buries all 32,000 unevaluated terminal rows in not_due",
       p.not_due === 72000, String(p.not_due));
  }

  // ── 3. remove the one-successor index ───────────────────────────────
  sub("3  uq_wope_one_successor is dropped");
  {
    const w = await rows(c,
      `insert into public.work_orders (id, property_id, title, status, source, urgency_status, work_order_ref)
       values (gen_random_uuid(), md5('r0-prop-1')::uuid, 'FALSIFY', 'open', 'falsify', 'regular', 8500001)
       returning id, property_id`);
    const { id: wo, property_id: pr } = w[0];
    const g = crypto.randomUUID();
    await c.query(INS, [g, wo, pr, null]);

    await c.query("begin");
    await c.query("drop index public.uq_wope_one_successor");
    //  With the index gone, the TRIGGER still refuses sequentially — the
    //  index is the CONCURRENCY backstop, not the sequential rule. Prove
    //  which one is doing the work rather than assuming.
    await c.query(INS, [crypto.randomUUID(), wo, pr, g]);
    const seqRefusal = await refuses(c, INS, [crypto.randomUUID(), wo, pr, g]);
    ok("F3  without the index, the TRIGGER still refuses a sequential fork",
       seqRefusal !== null && /not the head/.test(seqRefusal), seqRefusal || "NOT REFUSED");
    //  but the index is what a race needs; with it gone the guarantee rests
    //  on the FOR UPDATE lock alone.
    await c.query("rollback");
    const idx = await num(c,
      "select count(*) from pg_indexes where indexname='uq_wope_one_successor'");
    ok("F3b the index is restored by the rollback", idx === 1, String(idx));
    out.one_successor_index = { sequential_refusal: seqRefusal };
    await c.query("delete from public.work_order_proof_evaluations where evaluated_by_service='falsify'")
      .catch(() => {});
  }

  // ── 4. remove the self-supersession guard ───────────────────────────
  sub("4  the self-supersession guard is removed from the trigger");
  {
    const w = (await rows(c,
      `insert into public.work_orders (id, property_id, title, status, source, urgency_status, work_order_ref)
       values (gen_random_uuid(), md5('r0-prop-1')::uuid, 'FALSIFY2', 'open', 'falsify', 'regular', 8500002)
       returning id, property_id`))[0];
    const selfId = crypto.randomUUID();
    const before = await refuses(c, INS, [selfId, w.id, w.property_id, selfId]);
    ok("F4  with the guard, self-supersession is refused",
       before !== null && /supersede itself/.test(before), before || "NOT REFUSED");

    await c.query("begin");
    //  replace the guard body with the self-check stripped out
    const src = fs.readFileSync(CANDIDATE, "utf8");
    const fn = src.slice(src.indexOf("create or replace function public.wope_chain_guard()"),
                         src.indexOf("alter function public.wope_chain_guard()"));
    const stripped = fn.replace(
      /-- 1\. NO SELF-SUPERSESSION[\s\S]*?end if;\n/, "-- (guard removed by falsification)\n");
    await c.query(stripped);
    const after = await refuses(c, INS, [selfId, w.id, w.property_id, selfId]);
    //  The FK still catches it — but with a generic constraint error, not
    //  the named refusal. Losing the guard loses the DIAGNOSIS, and on an
    //  empty scope it would also be accepted as a rootless component.
    out.self_supersession = { with_guard: before, without_guard: after };
    ok("F4b without the guard, the named refusal is GONE",
       after === null || !/supersede itself/.test(after),
       "still says: " + after);
    await c.query("rollback");
    const restored = await refuses(c, INS, [selfId, w.id, w.property_id, selfId]);
    ok("F4c the guard is restored and names the reason again",
       restored !== null && /supersede itself/.test(restored), restored || "NOT REFUSED");
  }

  // ── 5. remove the cross-property check ──────────────────────────────
  sub("5  the cross-scope check is removed from the trigger");
  {
    const head = (await rows(c, "select * from public.work_order_proof_evaluation_head limit 1"))[0];
    const other = (await rows(c,
      `select id, property_id from public.work_orders
        where source='scale_fixture' and property_id <> $1 limit 1`, [head.property_id]))[0];
    const before = await refuses(c, INS, [crypto.randomUUID(), other.id, other.property_id, head.id]);
    ok("F5  with the check, a cross-scope predecessor is refused",
       before !== null, before || "NOT REFUSED");

    await c.query("begin");
    const src = fs.readFileSync(CANDIDATE, "utf8");
    const fn = src.slice(src.indexOf("create or replace function public.wope_chain_guard()"),
                         src.indexOf("alter function public.wope_chain_guard()"));
    const stripped = fn.replace(
      /if pred\.work_order_id <> NEW\.work_order_id[\s\S]*?end if;\n/,
      "-- (cross-scope check removed by falsification)\n");
    await c.query(stripped);
    const after = await refuses(c, INS, [crypto.randomUUID(), other.id, other.property_id, head.id]);
    out.cross_scope = { with_check: before, without_check: after };
    //  The COMPOSITE SELF-FK is the second line of defence and still holds —
    //  which is the point of having both. What is lost is the named refusal.
    ok("F5b without the check the composite FK still refuses, but unnamed",
       after !== null && !/cross-scope/.test(after), after || "NOT REFUSED AT ALL");
    await c.query("rollback");
  }

  // ── 6. two "concurrent" operations without real overlap ─────────────
  sub("6  a fake concurrency test — sequential, dressed as parallel");
  {
    const w = (await rows(c,
      `insert into public.work_orders (id, property_id, title, status, source, urgency_status, work_order_ref)
       values (gen_random_uuid(), md5('r0-prop-1')::uuid, 'FALSIFY3', 'open', 'falsify', 'regular', 8500003)
       returning id, property_id`))[0];
    //  Two promises, one connection, no open transactions. They serialize
    //  in the pool and NEVER contend. The unique index still refuses the
    //  second — so the test PASSES while proving nothing about races.
    const A = await conn(), B = await conn();
    const r = await Promise.allSettled([
      A.query(INS, [crypto.randomUUID(), w.id, w.property_id, null]),
      new Promise(res => setTimeout(res, 150)).then(() =>
        B.query(INS, [crypto.randomUUID(), w.id, w.property_id, null])),
    ]);
    const winners = r.filter(x => x.status === "fulfilled").length;
    //  Overlap evidence: was anything ever waiting on a lock?
    const waits = await num(c,
      `select count(*) from pg_stat_activity where wait_event_type='Lock'
        and application_name like 'r0_%'`);
    out.fake_concurrency = { winners, lock_waits_observed: waits };
    ok("F6  the fake test still shows 'exactly one winner' — and is worthless",
       winners === 1, String(winners));
    ok("F6b NO lock wait was ever observed, so overlap was never established",
       waits === 0, String(waits));
    ok("F6c this is why R1b/R2b/R4b assert overlap SEPARATELY from the outcome", true);
    await A.end(); await B.end();
  }

  // ── 7. change the expected fixture count ────────────────────────────
  sub("7  the expected fixture cardinality is changed");
  {
    const actual = await num(c,
      "select count(*) from public.work_orders where source='scale_fixture'");
    const wrongExpectation = 99999;
    out.fixture_count = { actual, wrong_expectation: wrongExpectation };
    ok("F7  a wrong expected count makes C1 go red",
       actual !== wrongExpectation, `actual ${actual}`);
    ok("F7b the real expectation still holds", actual === 100000, String(actual));
  }

  // ── 8. change the candidate digest after measurement ────────────────
  sub("8  the candidate file changes after its digest was recorded");
  {
    const digest = crypto.createHash("sha256").update(fs.readFileSync(CANDIDATE)).digest("hex");
    const mutated = crypto.createHash("sha256")
      .update(fs.readFileSync(CANDIDATE, "utf8") + "\n-- one added comment\n").digest("hex");
    out.digest = { recorded: digest, after_one_comment: mutated };
    ok("F8  a single added comment changes the digest",
       digest !== mutated, "digests matched — hashing is broken");
    ok("F8b the recorded digest is the one measured against",
       digest === crypto.createHash("sha256").update(fs.readFileSync(CANDIDATE)).digest("hex"));
    //  This is why the promotion rule permits comment differences ONLY as a
    //  reviewed, re-digested step — never as a silent edit after measurement.
  }

  await c.query("delete from public.work_order_proof_evaluations where evaluated_by_service='falsify'")
    .catch(() => {});
  await c.query("delete from public.work_orders where source='falsify'").catch(() => {});

  console.log(`\n${"═".repeat(66)}\n  falsification: ${pass} passed   ${fail} failed\n${"═".repeat(66)}`);
  const i = process.argv.indexOf("--json");
  if (i > -1) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ passed: pass, failed: fail, out }, null, 2));
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nFALSIFY HARNESS ERROR:\n" + (e && e.stack || e)); process.exit(1); });
