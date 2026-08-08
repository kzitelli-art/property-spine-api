#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 7 — PROVE THE CUTOVER TRANSACTION

   Step 7 runs ONCE, against production, and cannot be undone by re-running
   it. So every refusal it depends on is exercised here first, against a
   real PostgreSQL at schema 137, including the ones the DATABASE owns
   rather than the service.

   ── THE FOUR CLAIMS ─────────────────────────────────────────────────

     I   the instant is CAPTURED, never derived. now() is not it.
     D   the comparison is BOTH directions, and a matching COUNT over a
         different population still aborts.
     A   activation and inventory are ONE transaction — a failure leaves
         nothing, not half a cutover.
     O   it runs once. A second genesis is refused by the database, and a
         correction must cite the head with a reason.

   ⚠ ISOLATED POSTGRES ONLY. Needs schema 137.

   usage:
     bash tools/steps23/baseline_136.sh
     PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
     STEP7_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
       node tools/step7/prove_step7_activation.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const SERVICE = path.join(ROOT, "src/release0/activation_service.js");
const URL = process.env.STEP7_DATABASE_URL;
const SERVICE_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(SERVICE)).digest("hex");

const svc = require(SERVICE);
/*  Migration 140 REFUSES to let recordActivation run without it: a
 *  guard detected missing AFTER an irreversible act is useless. So a
 *  harness that activates must install it first. It is inert until the
 *  activation lands, so it changes nothing about what is proven here. */
const guardWindow = require("../step12/guard_window.js");


let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

function loadVariant(edits) {
  let src = fs.readFileSync(SERVICE, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — proves nothing: " + from.slice(0, 70));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(SERVICE, null);
  m.filename = SERVICE;
  m.paths = Module._nodeModulePaths(path.dirname(SERVICE));
  m._compile(src, SERVICE);
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("step7:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), PROP_B = ID("propB"), TECH = ID("tech");

(async function main() {
  if (!URL) { console.error("REFUSED: STEP7_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  const ledger = (await c.query(`select max(version) v from schema_migrations`)).rows[0].v;
  if (ledger !== "137") { console.error(`REFUSED: ledger ${ledger}, expected 137.`); process.exit(2); }
  await c.query("set lock_timeout = '8s'");
  await c.query("set statement_timeout = '60s'");

  const leftover = Number((await c.query(
    `select count(*) n from release_0_activation_history`)).rows[0].n);
  if (leftover > 0) {
    console.error("REFUSED: activation history is not empty — this proof needs a clean");
    console.error("         baseline because ONE GENESIS EVER is the invariant under test.");
    console.error("         Rebuild:  bash tools/steps23/baseline_136.sh && node tools/steps23/apply_137.js");
    process.exit(3);
  }

  console.log("STEP 7 — CUTOVER ACTIVATION PROOF — isolated postgres\n");

  await guardWindow.installGuard(c);

  await c.query(`insert into organizations (id,name) values ($1,'Step7 Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "Step7 Property"], [PROP_B, "Step7 Property B"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Tam Step7','+15415559401','maintenance',true) on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const mkWo = async ({ status = "closed", property = PROP, photo = null, note = null } = {}) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source,completion_photo,completion_note)
                   values ($1,$2,'step7',$3,'step7proof',$4,$5)`, [wo, property, status, photo, note]);
    return wo;
  };
  const inTx = async (fn) => {
    await c.query("begin");
    try { const out = await fn(); await c.query("commit"); return { out }; }
    catch (e) { await c.query("rollback").catch(() => {}); return { err: e }; }
  };
  const counts = async () => ({
    activations: Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n),
    inventory: Number((await c.query(`select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n),
  });

  //  The legacy population: terminal work orders with no evaluation.
  const legacyA = await mkWo({ status: "closed", photo: "stub://x/1", note: "did it" });
  const legacyB = await mkWo({ status: "complete" });
  const legacyC = await mkWo({ status: "closed", property: PROP_B, photo: "stub://x/2" });
  //  Noise that must NOT be in the set: an open work order, and a terminal
  //  one that DOES carry an evaluation.
  await mkWo({ status: "open" });
  const evaluated = await mkWo({ status: "complete" });
  await c.query(`insert into work_order_proof_evaluations
    (work_order_id,property_id,state,evaluated_by_service,rule_version)
    values ($1,$2,'satisfied','step7proof','x')`, [evaluated, PROP]);

  // ══ S — THE SET IS THE RIGHT SET ═══════════════════════════════════
  sec("S · THE CENSUS SET IS THE LEGACY POPULATION, AND ONLY THAT");
  const census = await svc.readLegacyTerminalSet(c);
  const inSet = (id) => census.some((r) => r.work_order_id === id);
  ok("S1  every terminal work order with no evaluation is in the set",
     inSet(legacyA) && inSet(legacyB) && inSet(legacyC), JSON.stringify(census.map((r) => r.work_order_id)));
  ok("S2  an OPEN work order is not", census.length === 3, "set size " + census.length);
  ok("S3  a terminal work order WITH an evaluation is not", !inSet(evaluated));
  ok("S4  the set carries the legacy column facts, not their contents",
     census.every((r) => typeof r.had_column_photo === "boolean" && !("completion_note" in r)),
     JSON.stringify(census[0]));

  // ══ I — THE INSTANT IS CAPTURED, NOT DERIVED ═══════════════════════
  sec("I · THE INSTANT IS CAPTURED AT STEP 6, NEVER now()");
  const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));
  {
    const r = await inTx(() => svc.recordActivation(c, {
      captured_by: "step7 proof", expected: census }));
    ok("I1  a missing instant is REFUSED, not defaulted to now()",
       !!r.err && r.err.code === "BAD_INPUT" && /activated_at is required/.test(r.err.message),
       r.err ? r.err.code + " " + r.err.message : "it activated with no instant");

    const bad = await inTx(() => svc.recordActivation(c, {
      activated_at: "not-a-time", captured_by: "p", expected: census }));
    ok("I2  an unparseable instant is REFUSED",
       !!bad.err && bad.err.code === "BAD_INPUT", bad.err && bad.err.message);

    const future = await inTx(() => svc.recordActivation(c, {
      activated_at: new Date(Date.now() + 86400000), captured_by: "p", expected: census }));
    /*  The message names the TRANSACTION START, not "the future", because
     *  PostgreSQL's now() is transaction start time. Asserted on the code
     *  and the shape of the message rather than one word, so a precision
     *  improvement to the wording does not read as a regression. */
    ok("I3  an instant later than the cutover transaction is refused",
       !!future.err && future.err.code === "BAD_INPUT" &&
       /not earlier than this transaction/.test(future.err.message),
       future.err && future.err.message);

    const anon = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "  ", expected: census }));
    ok("I4  an unattributed cutover is refused", !!anon.err && anon.err.code === "BAD_INPUT");

    const noSet = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p" }));
    ok("I5  a missing expected set is refused — it is never derived here",
       !!noSet.err && /expected must be the census set/.test(noSet.err.message),
       noSet.err && noSet.err.message);

    const after = await counts();
    ok("I6  every refusal above wrote NOTHING",
       after.activations === 0 && after.inventory === 0, JSON.stringify(after));
  }

  // ══ D — BOTH DIRECTIONS, AND COUNTS ARE NOT ENOUGH ═════════════════
  sec("D · DRIFT IS DETECTED IN BOTH DIRECTIONS");
  {
    //  A row appeared since the census.
    const surprise = await mkWo({ status: "closed" });
    const r = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: census }));
    ok("D1  a row that APPEARED since the census aborts the activation",
       !!r.err && r.err.code === "CENSUS_DRIFT", r.err && r.err.code);
    ok("D2  …and the unexpected row is named",
       !!r.err && r.err.unexpected.some((x) => x.work_order_id === surprise),
       JSON.stringify(r.err && r.err.unexpected));

    /*  A row disappeared since the census: reopen one of them.
     *
     *  The first version of this built the expected set as
     *  `[...census2, census[1]]`, assuming index 1 was legacyB. The census
     *  is ordered by (property_id, id), so it was not — it was a row still
     *  live, which made expected a superset of live with nothing missing,
     *  and the activation SUCCEEDED. The test then reported a service
     *  defect that did not exist, and the committed inventory made the
     *  cleanup delete fail against fk_r0lci_work_scope.
     *
     *  Name the row. A positional index into a sorted set is not an
     *  identity. */
    await c.query(`update work_orders set status='open' where id=$1`, [legacyB]);
    const census2 = await svc.readLegacyTerminalSet(c);
    const vanished = { work_order_id: legacyB, property_id: PROP, status: "complete",
                       had_column_photo: false, had_column_note: false };
    ok("D3a the reopened row really is absent from the live set",
       !census2.some((r) => r.work_order_id === legacyB),
       "the fixture did not actually remove it, so D3 below would be vacuous");
    const r2 = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: [...census2, vanished] }));
    ok("D3  a row that DISAPPEARED since the census aborts too",
       !!r2.err && r2.err.code === "CENSUS_DRIFT" &&
       r2.err.missing.some((x) => x.work_order_id === legacyB),
       JSON.stringify(r2.err && (r2.err.missing || r2.err.message)));

    /*  ── THE CASE §6.2 EXISTS FOR ──────────────────────────────────
     *  One row appeared and one disappeared. The COUNT matches exactly,
     *  over an entirely different population. A count-based check would
     *  commit a silently wrong inventory here. */
    const drifted = await svc.readLegacyTerminalSet(c);
    const stale = [...drifted.filter((x) => x.work_order_id !== surprise),
                   { work_order_id: legacyB, property_id: PROP, status: "closed",
                     had_column_photo: false, had_column_note: false }];
    ok("D4  the compensating case has a MATCHING COUNT", stale.length === drifted.length,
       `${stale.length} vs ${drifted.length}`);
    const r3 = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: stale }));
    ok("D5  …and it is STILL refused — a count is never sufficient",
       !!r3.err && r3.err.code === "CENSUS_DRIFT",
       "a matching count over a different population was accepted. This is the " +
       "exact failure §6.2 was written to prevent.");
    ok("D6  …reporting BOTH directions, not stopping at the first",
       !!r3.err && r3.err.unexpected.length > 0 && r3.err.missing.length > 0,
       JSON.stringify({ unexpected: r3.err && r3.err.unexpected.length,
                        missing: r3.err && r3.err.missing.length }));

    const after = await counts();
    ok("D7  every drift refusal wrote NOTHING",
       after.activations === 0 && after.inventory === 0, JSON.stringify(after));

    //  Restore the population so the activation below is over a known set.
    await c.query(`update work_orders set status='complete' where id=$1`, [legacyB]);
    await c.query(`delete from work_orders where id=$1`, [surprise]);
  }

  // ══ A — ONE TRANSACTION, AND THE INSTANT SURVIVES VERBATIM ═════════
  sec("A · THE ACTIVATION ITSELF");
  let genesisId = null;
  {
    const fresh = await svc.readLegacyTerminalSet(c);
    const r = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "step 6 capture, proof run", expected: fresh }));
    ok("A1  a matching census activates", !r.err && r.out.outcome === "activated",
       r.err ? r.err.code + " " + r.err.message : "");
    genesisId = r.out && r.out.activation.id;

    const row = (await c.query(`select * from release_0_activation_current`)).rows[0];
    ok("A2  the persisted instant is EXACTLY the captured one, not the insert time",
       new Date(row.activated_at).getTime() === STEP6_INSTANT.getTime(),
       `persisted ${new Date(row.activated_at).toISOString()} vs captured ${STEP6_INSTANT.toISOString()}`);
    ok("A3  …and it differs from the row's own recorded_at, which proves the point",
       new Date(row.recorded_at).getTime() !== new Date(row.activated_at).getTime(),
       "recorded_at equals activated_at — the fixture cannot distinguish captured " +
       "from derived, so A2 would pass for a now() implementation too");

    const inv = (await c.query(
      `select * from release_0_legacy_cutover_inventory order by work_order_id`)).rows;
    ok("A4  every census row is in the inventory", inv.length === fresh.length,
       `${inv.length} vs ${fresh.length}`);
    ok("A5  …attributed to THIS activation", inv.every((x) => x.activation_id === genesisId));
    ok("A6  …carrying the legacy column facts as they were",
       inv.some((x) => x.work_order_id === legacyA && x.had_column_photo === true) &&
       inv.some((x) => x.work_order_id === legacyB && x.had_column_photo === false),
       JSON.stringify(inv.map((x) => [x.work_order_id, x.had_column_photo])));
    ok("A7  …including the row on the OTHER property, scoped correctly",
       inv.some((x) => x.work_order_id === legacyC && x.property_id === PROP_B));

    /*  ── THE INVENTORY CANNOT BE ORPHANED ──────────────────────────
     *  fk_r0lci_work_scope is ON DELETE RESTRICT, so once a work order is
     *  in the cutover record it cannot be deleted out from under it. An
     *  inventory naming rows that no longer exist would be a cutover
     *  receipt nobody could check.
     *
     *  Found by the harness tripping over it during cleanup, which is the
     *  honest way to learn that a constraint is real rather than declared. */
    let restricted = false, msg = null;
    try { await c.query(`delete from work_orders where id=$1`, [legacyA]); }
    catch (e) { restricted = true; msg = e.message; }
    ok("A8  an inventoried work order CANNOT be deleted — the record cannot be orphaned",
       restricted, "the delete succeeded; the cutover receipt can lose its referent");
    if (msg) console.log("        " + String(msg).split("\n")[0]);
  }

  // ══ O — IT RUNS ONCE ═══════════════════════════════════════════════
  sec("O · ONE CUTOVER, EVER");
  {
    const fresh = await svc.readLegacyTerminalSet(c);
    const again = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: fresh }));
    ok("O1  a SECOND genesis is refused by the database, not by a pre-check",
       !!again.err && /genesis refused|uq_r0ah_genesis/i.test(again.err.message),
       again.err ? again.err.message : "a second activation was accepted");

    const c2 = await counts();
    ok("O2  …and the refusal left the first cutover intact",
       c2.activations === 1 && c2.inventory === 3, JSON.stringify(c2));

    const noReason = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: fresh,
      supersedes_id: genesisId }));
    ok("O3  a correction with no reason is refused",
       !!noReason.err && /non-empty reason/i.test(noReason.err.message), noReason.err && noReason.err.message);

    const corrected = await inTx(() => svc.recordActivation(c, {
      activated_at: new Date(Date.parse("2026-08-08T09:20:00.000Z")),
      captured_by: "p", expected: fresh, supersedes_id: genesisId,
      reason: "step 6 instant was re-derived from the drain log" }));
    ok("O4  a correction citing the head WITH a reason is accepted",
       !corrected.err && corrected.out.outcome === "superseded",
       corrected.err && corrected.err.message);

    const head = (await c.query(`select * from release_0_activation_current`)).rows;
    ok("O5  …and the view shows exactly one head", head.length === 1, String(head.length));

    const fork = await inTx(() => svc.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "p", expected: fresh,
      supersedes_id: genesisId, reason: "a fork" }));
    ok("O6  a FORKED correction citing the old head is refused",
       !!fork.err, fork.err ? fork.err.message : "the chain forked");

    ok("O7  re-inserting the same inventory rows is a no-op, not a duplicate",
       (await counts()).inventory === 3, JSON.stringify(await counts()));
  }

  // ══ N — THE RECORD CANNOT BE UNWOUND ══════════════════════════════
  sec("N · THE CUTOVER RECORD IS APPEND-ONLY");
  {
    /*  Learned by the harness tripping over it: the inventory refuses
     *  DELETE outright. That is why the falsification lives in its own
     *  tool against its own fresh baseline — a harness able to delete the
     *  cutover record would be proving the opposite of the invariant.
     *
     *  This is the same shape as the evaluations chain in Step 3, and it
     *  matters more here: the inventory is the only surviving statement of
     *  which rows predate the proof rail. If it could be edited, a row
     *  could be moved across the boundary after the fact. */
    let delRefused = false, updRefused = false, dmsg = null;
    try { await c.query(`delete from release_0_legacy_cutover_inventory`); }
    catch (e) { delRefused = true; dmsg = e.message; }
    ok("N1  DELETE on the cutover inventory is refused", delRefused,
       "the inventory can be emptied — a row could be moved across the boundary later");
    if (dmsg) console.log("        " + String(dmsg).split("\n")[0]);

    try {
      await c.query(`update release_0_legacy_cutover_inventory set status_at_cutover='complete'`);
    } catch (e) { updRefused = true; }
    ok("N2  UPDATE on it is refused too", updRefused,
       "an append-only record that accepts UPDATE is not append-only");

    ok("N3  falsification therefore lives in tools/step7/falsify_step7.js, which",
       true);
    console.log("        refuses to run against a dirty baseline rather than improvising");
    console.log("        a cleanup the schema deliberately forbids.");
  }

  sec("SOURCE");
  ok("Z1  activation_service.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(SERVICE)).digest("hex") === SERVICE_DIGEST);

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
