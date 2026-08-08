#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 7 — FALSIFICATION

   Break the activation transaction deliberately. Every breakage must turn
   the relevant assertion in prove_step7_activation.js RED. A breakage that
   leaves everything green means that proof was not testing the invariant
   it claims to test.

   ── WHY THIS IS A SEPARATE TOOL ─────────────────────────────────────

   The cutover record is APPEND-ONLY: `no_delete_r0lci` and `no_update_r0lci`
   refuse DELETE and UPDATE outright, and `uq_r0ah_genesis` permits exactly
   one genesis activation, ever. So a falsification cannot reset state
   between variants, and a harness that COULD would be proving the opposite
   of the invariant.

   Each variant therefore needs a virgin activation history. This runs ONE
   variant per invocation, named by --variant, and refuses against a dirty
   baseline rather than improvising a cleanup the schema forbids.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     for V in derived-instant one-direction scope-blind; do
       bash tools/steps23/baseline_136.sh
       PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
       FALSIFY7_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
         node tools/step7/falsify_step7.js --variant $V
     done
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const SERVICE = path.join(ROOT, "src/release0/activation_service.js");
const URL = process.env.FALSIFY7_DATABASE_URL;
const SERVICE_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(SERVICE)).digest("hex");

const argIdx = process.argv.indexOf("--variant");
const VARIANT = argIdx > -1 ? process.argv[argIdx + 1] : null;

const VARIANTS = {
  //  Derive the boundary from the clock instead of taking the captured one.
  //  TWO guards have to come out, and that is the finding. The required-
  //  argument check is the obvious one. The second is the transaction-start
  //  comparison: PostgreSQL's now() is the TRANSACTION START time, so a
  //  `new Date()` taken inside the transaction is always later than it and
  //  is refused as a boundary ahead of the cutover. A first version of this
  //  variant removed only the first guard, was refused by the second, and
  //  reported a proof defect that did not exist.
  "derived-instant": {
    what: "the instant is derived from now(), with BOTH guards removed",
    breaks: "I1/I2/I3 — the captured-instant guards (there are two)",
    edits: [
      { from: 'if (activated_at === undefined || activated_at === null || activated_at === "") {',
        to:   "if (false) {" },
      { from: "const instant = activated_at instanceof Date ? activated_at : new Date(activated_at);",
        to:   "const instant = new Date(); /* falsified: derived */" },
      { from: "  if (instant.getTime() > new Date(txStart).getTime()) {",
        to:   "  if (false) { /* falsified: transaction-start guard removed */" },
    ],
  },
  //  Compare live-minus-expected only. A row that vanished since the census
  //  then lands in the inventory although it is no longer terminal.
  "one-direction": {
    what: "the comparison drops the expected-minus-live direction",
    breaks: "D3/D5/D6 — both-direction drift detection",
    edits: [
      { from: "const missing = expected.filter((r) => !liveKeys.has(key(r)));",
        to:   "const missing = []; /* falsified: one direction only */" },
    ],
  },
  //  Compare on work_order_id alone. A row whose property changed then
  //  compares equal, and the inventory records the wrong scope.
  "scope-blind": {
    what: "set identity ignores property_id",
    breaks: "the composite identity the inventory's primary key depends on",
    edits: [
      { from: "const key = (r) => `${r.work_order_id}::${r.property_id}`;",
        to:   "const key = (r) => `${r.work_order_id}`; /* falsified: scope-blind */" },
    ],
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

function loadVariant(edits) {
  let src = fs.readFileSync(SERVICE, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — the mutation matched nothing, " +
                      "so it proves nothing: " + from.slice(0, 70));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(SERVICE, null);
  m.filename = SERVICE;
  m.paths = Module._nodeModulePaths(path.dirname(SERVICE));
  m._compile(src, SERVICE);
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("fals7:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFY7_DATABASE_URL is not set."); process.exit(1); }
  if (!VARIANT || !VARIANTS[VARIANT]) {
    console.error("REFUSED: --variant is required. One of:");
    for (const [k, v] of Object.entries(VARIANTS)) console.error(`  ${k.padEnd(18)} ${v.what}`);
    console.error("\n  One variant per invocation, each against a FRESH baseline — the");
    console.error("  cutover record is append-only and cannot be reset between them.");
    process.exit(2);
  }

  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  const dirty = Number((await c.query(
    `select count(*) n from release_0_activation_history`)).rows[0].n);
  if (dirty > 0) {
    console.error("REFUSED: activation history is not empty.");
    console.error("");
    console.error("  The cutover record is append-only (no_delete_r0lci / no_update_r0lci)");
    console.error("  and permits ONE genesis ever, so this harness cannot clean up after");
    console.error("  itself — and one that could would be proving the opposite of the");
    console.error("  invariant. Rebuild the baseline:");
    console.error("");
    console.error("    bash tools/steps23/baseline_136.sh");
    console.error("    PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js");
    process.exit(3);
  }

  const V = VARIANTS[VARIANT];
  console.log(`STEP 7 FALSIFICATION — variant "${VARIANT}"\n`);
  console.log("  breaks:  " + V.what);
  console.log("  targets: " + V.breaks + "\n");

  await c.query(`insert into organizations (id,name) values ($1,'F7 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'F7 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);

  let seq = 0;
  const mkWo = async (status = "closed") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'fals7',$3,'fals7proof')`, [wo, PROP, status]);
    return wo;
  };
  const inTx = async (fn) => {
    await c.query("begin");
    try { const out = await fn(); await c.query("commit"); return { out }; }
    catch (e) { await c.query("rollback").catch(() => {}); return { err: e }; }
  };

  const real = require(SERVICE);
  const broken = loadVariant(V.edits);

  await mkWo("closed");
  await mkWo("complete");

  if (VARIANT === "derived-instant") {
    const set = await real.readLegacyTerminalSet(c);
    const r = await inTx(() => broken.recordActivation(c, { captured_by: "falsify", expected: set }));
    ok("F1  with BOTH guards removed, it ACTIVATES WITH NO CAPTURED INSTANT", !r.err,
       "it refused anyway: " + (r.err && r.err.message) +
       "\n          → then I1–I3 are not what stops this, and the proof is weaker than it reads");
    const row = (await c.query(`select * from release_0_activation_current`)).rows[0];
    ok("F2  …and the boundary silently becomes the insert time",
       !!row && Math.abs(new Date(row.activated_at) - new Date(row.recorded_at)) < 2000,
       row ? `activated_at ${row.activated_at} vs recorded_at ${row.recorded_at}` : "no activation row");
    console.log("        → a `closed` row written by a draining instance between step 6");
    console.log("          and step 7 would then be classed as pre-cutover legacy, hiding");
    console.log("          a defect the release itself caused.");
    console.log("        → NOTE: the real service has TWO independent guards here. The");
    console.log("          transaction-start comparison refuses a derived instant even");
    console.log("          with the required-argument check removed, because now() is");
    console.log("          the transaction start and new Date() is always after it.");

    const rr = await inTx(() => real.recordActivation(c, { captured_by: "falsify", expected: set }));
    ok("F3  the REAL service refuses that same call",
       !!rr.err && /activated_at is required/.test(rr.err.message), rr.err && rr.err.message);
  }

  if (VARIANT === "one-direction") {
    const gone = await mkWo("closed");
    const staleSet = await real.readLegacyTerminalSet(c);
    await c.query(`update work_orders set status='open' where id=$1`, [gone]);

    const r = await inTx(() => broken.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify", expected: staleSet }));
    ok("F1  comparing ONE direction lets a vanished row through", !r.err,
       "it refused anyway: " + (r.err && r.err.code) +
       "\n          → then D3/D5/D6 are not proving the expected-minus-live side");
    const inv = Number((await c.query(
      `select count(*) n from release_0_legacy_cutover_inventory where work_order_id=$1`, [gone])).rows[0].n);
    ok("F2  …and it is COMMITTED to the inventory although it is no longer terminal",
       inv === 1, String(inv));
    console.log("        → the cutover receipt would name a row that is currently OPEN,");
    console.log("          and the reader would treat a live work order as pre-cutover.");

    const rr = await inTx(() => real.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify", expected: staleSet }));
    ok("F3  the REAL service refuses that same call with CENSUS_DRIFT",
       !!rr.err && rr.err.code === "CENSUS_DRIFT" && rr.err.missing.length > 0,
       rr.err && (rr.err.code + " " + JSON.stringify(rr.err.missing || [])));
  }

  if (VARIANT === "scope-blind") {
    /*  A work order cannot change property — the composite FK forbids it —
     *  so the drift this variant admits is one the schema already prevents.
     *  Stated as a finding rather than dressed up as a caught bug: the
     *  property_id in the comparison key is defence in depth, and saying so
     *  is worth more than a control that pretends the query is what stops it. */
    const set = await real.readLegacyTerminalSet(c);
    let moved = false;
    try {
      await c.query(`update work_orders set property_id=$1 where id=$2`, [ID("otherProp"), set[0].work_order_id]);
      moved = true;
    } catch (_) { /* refused, as expected */ }
    ok("F1  a work order CANNOT change property — the drift is unrepresentable", !moved,
       "the database allowed it, so the scope-blind key is a live hazard, not defence in depth");

    const r = await inTx(() => broken.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify", expected: set }));
    ok("F2  …so the scope-blind variant behaves identically here", !r.err,
       r.err && r.err.message);
    console.log("        → RECORDED AS DEFENCE IN DEPTH, not as a caught defect. The");
    console.log("          composite key is right, and this control cannot demonstrate");
    console.log("          it is load-bearing. Saying so beats a green tick that implies");
    console.log("          the comparison is what prevents a cross-property inventory.");
  }

  ok("Z1  activation_service.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(SERVICE)).digest("hex") === SERVICE_DIGEST);

  console.log(`\n  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
