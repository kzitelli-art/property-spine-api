#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEP 8 — FALSIFICATION

   Three ways the reader could be wrong, each of which has ALREADY been
   shipped once by some system somewhere, and each of which the frozen
   plan names as a correction to an earlier revision of itself.

     collapse-legacy       legacy history rendered as "proof failed"
     defect-fallback       no activation → missing_evaluation_defect
     inventoried-terminal   revision 3's definition of terminal

   Each must turn a specific assertion in prove_step8_reader.js RED. One
   variant per invocation against a fresh baseline, because the activation
   record is append-only and the proof needs to observe the reader both
   before and after activation.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     for V in collapse-legacy defect-fallback inventoried-terminal; do
       bash tools/steps23/baseline_136.sh
       PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
       FALSIFY8_DATABASE_URL='...' node tools/step8/falsify_step8.js --variant $V
     done
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const PS = path.join(ROOT, "src/release0/proof_state.js");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const URL = process.env.FALSIFY8_DATABASE_URL;
const PS_DIGEST = crypto.createHash("sha256").update(fs.readFileSync(PS)).digest("hex");

const argIdx = process.argv.indexOf("--variant");
const VARIANT = argIdx > -1 ? process.argv[argIdx + 1] : null;

const VARIANTS = {
  //  §3.4: "null is deliberate. Legacy and writer-defect may not be
  //  collapsed into 'proof failed'." This collapses them.
  "collapse-legacy": {
    what: "legacy_indeterminate maps to satisfied:false, not null",
    breaks: "C3/C5/C6 — legacy is not 'proof failed'",
    edits: [{ from: "  legacy_indeterminate: null,", to: "  legacy_indeterminate: false," }],
  },
  //  §3.2.1: "It must not fall back to missing_evaluation_defect. That
  //  would raise a writer-defect on every terminal work order the moment
  //  the reader shipped."
  "defect-fallback": {
    what: "an absent activation falls back to missing_evaluation_defect",
    breaks: "U1–U5 — unavailable is the READ failing, not a state",
    edits: [{
      from: `    return { read_status: "unavailable",
             reason_code: (authority && authority.reason_code) || "activation_absent" };`,
      to: `    return { read_status: "ok", state: "missing_evaluation_defect", satisfied: null };`,
    }],
  },
  //  §3.2.0, correction 7: revision 3 defined terminal as "complete, or
  //  closed FOR AN INVENTORIED ROW", which exempted the exact row the
  //  release exists to catch.
  "inventoried-terminal": {
    what: "terminal means complete, or closed AND inventoried (revision 3)",
    breaks: "H1/H2 — closed + NOT inventoried must not escape",
    edits: [{
      from: `const isTerminal = (workOrder) =>
  !!workOrder && TERMINAL_STATUSES.includes(workOrder.status);`,
      to: `const isTerminal = (workOrder) =>
  !!workOrder && (workOrder.status === "complete" ||
    (workOrder.status === "closed" && workOrder.__inventoried === true));`,
    }],
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

function loadVariant(edits) {
  let src = fs.readFileSync(PS, "utf8");
  for (const { from, to } of edits) {
    if (!src.includes(from)) {
      throw new Error("FALSIFICATION TARGET NOT FOUND — proves nothing: " + from.slice(0, 80));
    }
    src = src.split(from).join(to);
  }
  const m = new Module(PS, null);
  m.filename = PS;
  m.paths = Module._nodeModulePaths(path.dirname(PS));
  m._compile(src, PS);
  return m.exports;
}

const ID = (n) => crypto.createHash("md5").update("fals8:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop");
const STEP6_INSTANT = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFY8_DATABASE_URL is not set."); process.exit(1); }
  if (!VARIANT || !VARIANTS[VARIANT]) {
    console.error("REFUSED: --variant is required. One of:");
    for (const [k, v] of Object.entries(VARIANTS)) console.error(`  ${k.padEnd(22)} ${v.what}`);
    process.exit(2);
  }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty — rebuild the baseline.");
    process.exit(3);
  }

  const V = VARIANTS[VARIANT];
  console.log(`STEP 8 FALSIFICATION — variant "${VARIANT}"\n`);
  console.log("  breaks:  " + V.what);
  console.log("  targets: " + V.breaks + "\n");

  await c.query(`insert into organizations (id,name) values ($1,'F8 Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'F8 Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);

  let seq = 0;
  const mkWo = async (status) => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'fals8',$3,'fals8proof')`, [wo, PROP, status]);
    return wo;
  };

  const real = require(PS);
  const broken = loadVariant(V.edits);

  if (VARIANT === "defect-fallback") {
    //  BEFORE any activation exists.
    const wo = await mkWo("closed");
    const workOrder = (await c.query(`select * from work_orders where id=$1`, [wo])).rows[0];
    const auth = await real.activationAuthority(c);
    const b = await broken.deriveProofState(c, { workOrder, authority: auth });
    ok("F1  with the fallback, an absent activation yields a DEFECT verdict",
       b.read_status === "ok" && b.state === "missing_evaluation_defect",
       JSON.stringify(b) + " — then U1–U5 are not what stops this");
    console.log("        → every terminal work order in production would be reported as a");
    console.log("          writer defect the moment the reader shipped, before the");
    console.log("          inventory that distinguishes legacy from defect even exists.");
    const r = await real.deriveProofState(c, { workOrder, authority: auth });
    ok("F2  the REAL reader reports the READ as unavailable and omits state",
       r.read_status === "unavailable" && !("state" in r) && !("satisfied" in r),
       JSON.stringify(r));
  }

  if (VARIANT === "collapse-legacy") {
    const legacyWo = await mkWo("closed");
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify8", expected: census });
    await c.query("commit");
    const defectWo = await mkWo("closed");   // after activation → not inventoried

    const workOrder = (await c.query(`select * from work_orders where id=$1`, [legacyWo])).rows[0];
    const defectRow = (await c.query(`select * from work_orders where id=$1`, [defectWo])).rows[0];
    const auth = await real.activationAuthority(c);

    const bl = await broken.deriveProofState(c, { workOrder, authority: auth });
    const bd = await broken.deriveProofState(c, { workOrder: defectRow, authority: auth });
    ok("F1  with the collapse, legacy history reads satisfied:false",
       bl.satisfied === false, JSON.stringify(bl) + " — then C3 is not what stops this");
    ok("F2  …i.e. 'proof failed', which is what the release exists to stop saying",
       bl.satisfied === false && bd.satisfied === null,
       "legacy and defect now differ in a way that reads as a verdict on the work");
    console.log("        → an operator sees a legitimate historical close reported as a");
    console.log("          failed proof, and cannot tell it from work done badly.");

    const rl = await real.deriveProofState(c, { workOrder, authority: auth });
    ok("F3  the REAL reader keeps legacy at satisfied:null",
       rl.satisfied === null && rl.state === "legacy_indeterminate", JSON.stringify(rl));
  }

  if (VARIANT === "inventoried-terminal") {
    const census = await activation.readLegacyTerminalSet(c);
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: STEP6_INSTANT, captured_by: "falsify8", expected: census });
    await c.query("commit");

    //  The escapee: closed AFTER activation, so not inventoried.
    const escapee = await mkWo("closed");
    const workOrder = (await c.query(`select * from work_orders where id=$1`, [escapee])).rows[0];
    const auth = await real.activationAuthority(c);

    ok("F1  under revision 3's definition the row is NOT terminal",
       !broken.isTerminal(workOrder),
       "the mutation did not reproduce revision 3 — check the edit");
    const b = await broken.deriveProofState(c, { workOrder, authority: auth });
    ok("F2  …so it ESCAPES missing_evaluation_defect",
       b.state !== "missing_evaluation_defect", JSON.stringify(b.state) +
       " — then H1/H2 are not what closes the hole");
    console.log("        → " + JSON.stringify(b.state) + ": a closed work order with no");
    console.log("          evidence and no evaluation, rendered as if the work were");
    console.log("          merely unstarted. That is the row a surviving legacy writer");
    console.log("          or an in-flight request creates after activation — the case");
    console.log("          the release exists to catch, exempted by the definition");
    console.log("          meant to catch it.");

    const r = await real.deriveProofState(c, { workOrder, authority: auth });
    ok("F3  the REAL reader calls it missing_evaluation_defect",
       r.state === "missing_evaluation_defect", JSON.stringify(r.state));
  }

  ok("Z1  proof_state.js is byte-identical to before this run",
     crypto.createHash("sha256").update(fs.readFileSync(PS)).digest("hex") === PS_DIGEST);

  console.log(`\n  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
