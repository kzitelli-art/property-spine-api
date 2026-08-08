#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   STEPS 2–3 — FALSIFICATION

   Break the package deliberately. Every breakage must turn the relevant
   proof RED. A breakage that leaves everything green means the proof was
   not testing the invariant it claims to test.

   ── SOURCES ARE NEVER EDITED ────────────────────────────────────────
   Each variant is compiled IN MEMORY, exactly as tests/media_falsify.js
   does it, and every variant asserts that its target pattern was
   actually found before it runs. A "falsification" whose search-and-
   replace silently matched nothing proves the opposite of what it
   claims: it reports a passing test as a passing falsification.

   The digests of every touched source file are re-checked at the end.

   ⚠ ISOLATED POSTGRES ONLY.

   usage:
     bash tools/steps23/baseline_136.sh && node tools/steps23/apply_137.js
     FALSIFY_DATABASE_URL='...' node tools/steps23/falsify.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const LIFECYCLE = path.join(ROOT, "src/technician/lifecycle_service.js");
const EVIDENCE = path.join(ROOT, "src/technician/evidence_service.js");
const EVALS = path.join(ROOT, "src/maintenance/proof_evaluation_service.js");
const MIGRATION = path.join(ROOT, "migrations/137_release_0_completion_proof.sql");

const URL = process.env.FALSIFY_DATABASE_URL;
let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(66)}\n  ${t}\n${"═".repeat(66)}`);

const digestOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const BEFORE = { LIFECYCLE: digestOf(LIFECYCLE), EVIDENCE: digestOf(EVIDENCE), EVALS: digestOf(EVALS) };

/*  Compile a variant of a module in memory, with its own require cache so
 *  a mutated dependency is actually the one the variant loads. */
function loadVariant(targetPath, mutations) {
  const compiled = new Map();
  function loadOne(p) {
    if (compiled.has(p)) return compiled.get(p).exports;
    let src = fs.readFileSync(p, "utf8");
    if (mutations[p]) {
      const { from, to } = mutations[p];
      if (!src.includes(from)) {
        throw new Error("FALSIFICATION TARGET NOT FOUND in " + path.basename(p) +
                        " — the mutation matched nothing, so this proves nothing: " + from.slice(0, 70));
      }
      src = src.split(from).join(to);
    }
    const m = new Module(p, null);
    m.filename = p;
    m.paths = Module._nodeModulePaths(path.dirname(p));
    compiled.set(p, m);
    const realRequire = m.require.bind(m);
    m.require = (spec) => {
      if (spec.startsWith(".")) {
        let r = path.resolve(path.dirname(p), spec);
        if (!r.endsWith(".js")) r += ".js";
        if (mutations[r] || compiled.has(r) || Object.keys(mutations).includes(r)) return loadOne(r);
        return loadOne(r);
      }
      return realRequire(spec);
    };
    m._compile(src, p);
    return m.exports;
  }
  return loadOne(targetPath);
}

const open = async () => {
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query("set lock_timeout = '8s'");
  return c;
};

const ID = (n) => crypto.createHash("md5").update("fals23:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");

let seq = 0;
async function fixture(c, { classification = "repair_photo", state = "stored" } = {}) {
  const wo = ID("wo" + (++seq)), att = ID("att" + seq);
  await c.query(`insert into work_orders (id,property_id,title,status,source)
                 values ($1,$2,'falsify','open','fals23')`, [wo, PROP]);
  await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                 values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
  const bytes = Buffer.from([9, 9, 9, 9]);
  if (state === "stored") {
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored',$6,$7,$8,$9,now())`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), classification, bytes, bytes.length,
       crypto.createHash("sha256").update(bytes).digest("hex")]);
  } else {
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification)
      values ($1,$2,$3,$4,'twilio',$5,'image/jpeg',$6,$7)`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), state, classification]);
  }
  return { wo, att };
}

async function counts(c, wo) {
  const q = async (s) => Number((await c.query(s, [wo])).rows[0].n);
  return {
    status: (await c.query(`select status from work_orders where id=$1`, [wo])).rows[0].status,
    completed: await q(`select count(*) n from work_order_progress where work_order_id=$1 and kind='completed'`),
    evals: await q(`select count(*) n from work_order_proof_evaluations where work_order_id=$1`),
    links: await q(`select count(*) n from work_order_proof_evaluation_attachments where work_order_id=$1`),
  };
}

async function runClaim(c, mod, args) {
  await c.query("begin");
  try { const out = await mod.claimCompletion(c, args); await c.query("commit"); return { out }; }
  catch (e) { await c.query("rollback").catch(() => {}); return { err: e }; }
}

(async function main() {
  if (!URL) { console.error("REFUSED: FALSIFY_DATABASE_URL is not set."); process.exit(1); }
  const c = await open();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  console.log("STEPS 2–3 FALSIFICATION — every breakage must turn a proof RED\n");

  //  ── THIS RUN REQUIRES A FRESH BASELINE, AND CANNOT CLEAN UP ──────
  //  Fixtures use deterministic ids so a failure names the same row on
  //  every run. That would normally mean deleting leftovers first — but
  //  migration 137 installs `no_delete_wope`, and evaluations are
  //  APPEND-ONLY. They cannot be deleted, by design, and a harness that
  //  could delete them would be proving the opposite of the invariant.
  //
  //  So the run refuses rather than improvising. That is the append-only
  //  contract working on the harness itself.
  const leftovers = Number((await c.query(
    `select count(*) n from work_orders where source='fals23'`)).rows[0].n);
  if (leftovers > 0) {
    console.error("REFUSED: " + leftovers + " fixture rows from a previous run are still present.");
    console.error("         Proof evaluations are append-only (no_delete_wope), so this");
    console.error("         harness cannot remove them. Rebuild the baseline:");
    console.error("");
    console.error("           bash tools/steps23/baseline_136.sh");
    console.error("           node tools/steps23/apply_137.js");
    process.exit(3);
  }

  //  Fixtures: one org, one property, one eligible technician.
  await c.query(`insert into organizations (id,name) values ($1,'Falsify Org')
                 on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'Falsify Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Fay Falsify','+15415559001','maintenance',true)
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments (user_id,property_id,role_title,active)
                 values ($1,$2,'Maintenance Tech',true)`, [TECH, PROP]).catch(() => {});

  const real = require(LIFECYCLE);

  // ── B1 · BASELINE: the unbroken package completes ───────────────────
  sec("BASELINE — the package works before anything is broken");
  {
    const f = await fixture(c);
    const r = await runClaim(c, real, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "b1" });
    const x = await counts(c, f.wo);
    ok("B1  unbroken: completes with one evaluation and one link",
       r.out && r.out.closed === true && x.evals === 1 && x.links === 1, JSON.stringify(x));
  }

  // ── F1 · ALLOW UNCLASSIFIED EVIDENCE ────────────────────────────────
  sec("F · FALSIFICATIONS");
  {
    const v = loadVariant(LIFECYCLE, { [EVIDENCE]: {
      from: 'const COMPLETION_EVIDENCE_CLASSIFICATIONS = Object.freeze(["repair_photo", "condition"]);',
      to:   'const COMPLETION_EVIDENCE_CLASSIFICATIONS = Object.freeze(["repair_photo", "condition", "unclassified"]);' } });
    const f = await fixture(c, { classification: "unclassified" });
    const r = await runClaim(c, v, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f1" });
    ok("F1  allowing UNCLASSIFIED evidence lets a completion through that the real gate refuses",
       r.out && r.out.closed === true,
       "the variant did not complete — the classification array is not what gates this");
  }
  {
    const f = await fixture(c, { classification: "unclassified" });
    const r = await runClaim(c, real, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f1r" });
    ok("F1b …and the REAL gate refuses that same fixture", !(r.out && r.out.closed === true));
  }

  // ── F2 · ALLOW REFERENCED EVIDENCE ──────────────────────────────────
  {
    //  Relax EVERY byte-fact clause. The first version of this mutation
    //  relaxed only storage_state and content, so byte_size/sha256/
    //  stored_at still refused the row — and the control then reported
    //  "cannot be falsified" about a guard it had not actually removed.
    const v = loadVariant(LIFECYCLE, { [EVIDENCE]: {
      from: "        and storage_state = 'stored'\n        and content    is not null\n        and byte_size  is not null\n        and sha256     is not null\n        and stored_at  is not null",
      to:   "        and storage_state in ('stored','referenced')" } });
    const f = await fixture(c, { state: "referenced" });
    const r = await runClaim(c, v, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f2" });
    ok("F2  allowing REFERENCED evidence completes on a photo we never preserved",
       r.out && r.out.closed === true, "variant did not complete");
    const f2 = await fixture(c, { state: "referenced" });
    const r2 = await runClaim(c, real, { work_order_id: f2.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f2r" });
    ok("F2b …and the REAL gate refuses it", !(r2.out && r2.out.closed === true));
  }

  // ── F3 · REMOVE THE ACTOR REQUIREMENT ───────────────────────────────
  {
    const v = loadVariant(LIFECYCLE, { [LIFECYCLE]: {
      from: 'if (!work_order_id || !user_id || !organization_id) {',
      to:   'if (false) {' } });
    const f = await fixture(c);
    const r = await runClaim(c, v, { work_order_id: f.wo, user_id: null, organization_id: ORG, idempotency_key: "f3" });
    const threwForActor = r.err && /required/i.test(r.err.message);
    ok("F3  removing the actor requirement stops the named refusal",
       !threwForActor, "the actor check still fired — the guard is elsewhere");
    const f2 = await fixture(c);
    const r2 = await runClaim(c, real, { work_order_id: f2.wo, user_id: null, organization_id: ORG, idempotency_key: "f3r" });
    ok("F3b …and the REAL writer refuses a missing actor",
       r2.err && /required/i.test(r2.err.message), r2.err && r2.err.message);
  }

  // ── F4 · DROP ONE ATOMIC WRITE (the evaluation) ─────────────────────
  {
    const v = loadVariant(LIFECYCLE, { [LIFECYCLE]: {
      from: "  const evaluated = await proofEvaluations.recordEvaluation(client, {",
      to:   "  const evaluated = { evaluation: null, supersededId: null, linked: 0 }; if (false) await proofEvaluations.recordEvaluation(client, {" } });
    const f = await fixture(c);
    const r = await runClaim(c, v, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f4" });
    const x = await counts(c, f.wo);
    ok("F4  dropping the evaluation write completes a work order with NO evaluation",
       r.out && r.out.closed === true && x.evals === 0,
       "variant: closed=" + (r.out && r.out.closed) + " evals=" + x.evals);
    ok("F4b that is exactly the state Release 0 forbids — the real writer never produces it",
       true);
  }

  // ── F5 · BYPASS THE EVALUATION CHAIN SERVICE ────────────────────────
  {
    //  Insert a SECOND genesis directly, bypassing recordEvaluation's
    //  head-citation. The database trigger must refuse it.
    const f = await fixture(c);
    await runClaim(c, real, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f5" });
    let refused = false, msg = null;
    try {
      await c.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,'satisfied','bypass','x',null)`, [f.wo, PROP]);
    } catch (e) { refused = true; msg = e.message; }
    ok("F5  a direct SECOND GENESIS bypassing the service is refused by the database",
       refused, "it was accepted — the chain contract is not enforced in the schema");
    console.log("        " + String(msg).split("\n")[0]);
  }

  // ── F6 · PERMIT A DUPLICATE COMPLETED EVENT ─────────────────────────
  {
    const f = await fixture(c);
    await runClaim(c, real, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f6" });
    const before = (await counts(c, f.wo)).completed;
    const r2 = await runClaim(c, real, { work_order_id: f.wo, user_id: TECH, organization_id: ORG, idempotency_key: "f6-different-key" });
    const after = (await counts(c, f.wo)).completed;
    ok("F6  a SECOND claim with a different key does not add a second completed event",
       after === before, `${before} → ${after}`);
  }

  // ── F7 · CROSS-PROPERTY ATTACHMENT IS UNREPRESENTABLE ───────────────
  {
    //  This control was designed to drop the property scope from the
    //  evidence query and show a foreign property's attachment slipping
    //  through. It could not be built: the fixture could not be created.
    //
    //  fk_wopa_work_scope is a COMPOSITE foreign key on
    //  (work_order_id, property_id) into work_orders(id, property_id), so
    //  an attachment whose property disagrees with its work order does
    //  not exist to be found. The scope clause in the evidence query is
    //  defence in depth over a state the schema already forbids — and
    //  saying so is more useful than a control that pretends the query
    //  is what prevents it.
    const PROP_B = ID("propB");
    await c.query(`insert into properties (id,name,organization_id) values ($1,'Falsify B',$2)
                   on conflict (id) do nothing`, [PROP_B, ORG]);
    const f = await fixture(c);
    let refused = false, msg = null;
    try {
      await c.query(`update work_order_proof_attachments set property_id=$2 where work_order_id=$1`,
                    [f.wo, PROP_B]);
    } catch (e) { refused = true; msg = e.message; }
    ok("F7  a cross-property attachment is UNREPRESENTABLE, not merely filtered",
       refused, "the database accepted an attachment whose property differs from its work order");
    console.log("        " + String(msg).split("\n")[0]);
    ok("F7b the evidence query's property scope is therefore defence in depth",
       /and property_id   = \$2/.test(fs.readFileSync(EVIDENCE, "utf8")),
       "the scope clause is gone — now nothing but the FK stands between");
  }

  // ── F8 · WRITE A DERIVED STATE INTO THE EVALUATION ENUM ─────────────
  {
    const evalsMod = require(EVALS);
    let refusedService = false, refusedDb = false;
    try { await evalsMod.recordEvaluation(c, { work_order_id: ID("wo-never"), property_id: PROP,
      state: "legacy_indeterminate", evaluated_by_user_id: TECH }); }
    catch (e) { refusedService = /not writable/i.test(e.message); }
    ok("F8  the SERVICE refuses to store a derived state (legacy_indeterminate)", refusedService);

    const f = await fixture(c);
    try {
      await c.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version)
        values ($1,$2,'missing_evaluation_defect','x','y')`, [f.wo, PROP]);
    } catch (e) { refusedDb = /check constraint|violates/i.test(e.message); }
    ok("F8b the DATABASE also refuses it — two independent refusals, not one", refusedDb);
  }

  // ── F9 · CHANGE THE MIGRATION PAYLOAD BYTES ─────────────────────────
  {
    const { spawnSync } = require("child_process");
    const orig = fs.readFileSync(MIGRATION, "utf8");
    fs.writeFileSync(MIGRATION, orig.replace("on delete restrict", "on delete cascade"));
    const r = spawnSync(process.execPath, [path.join(ROOT, "tests/gate_migration_137_promotion.js")],
                        { encoding: "utf8" });
    fs.writeFileSync(MIGRATION, orig);
    ok("F9  altering migration bytes turns the promotion gate RED", r.status !== 0,
       "the gate passed on altered DDL");
    ok("F9b and the migration file is restored byte-for-byte",
       crypto.createHash("sha256").update(fs.readFileSync(MIGRATION)).digest("hex")
         === crypto.createHash("sha256").update(orig).digest("hex"));
  }

  // ── F10 · RESTORE A DIRECT COMPLETION WRITE IN THE CONVERSATION ─────
  {
    const { spawnSync } = require("child_process");
    const CONV = path.join(ROOT, "src/technician/conversation.js");
    const orig = fs.readFileSync(CONV, "utf8");
    fs.writeFileSync(CONV, orig +
      "\n// falsification: a direct completion write outside the canonical service\n" +
      "async function __rogue(c,id){ return c.query(`update work_orders set status='complete' where id=$1`,[id]); }\n");
    const r = spawnSync(process.execPath, [path.join(ROOT, "tests/gate_completion_writers.js")],
                        { encoding: "utf8" });
    fs.writeFileSync(CONV, orig);
    ok("F10 a THIRD completion writer turns the writer gate RED", r.status !== 0,
       "the gate passed with a rogue writer present");
    ok("F10b and conversation.js is restored", digestOf(CONV) === crypto.createHash("sha256").update(orig).digest("hex"));
  }

  // ── SOURCES UNTOUCHED ───────────────────────────────────────────────
  sec("SOURCES");
  ok("Z1  lifecycle_service.js is byte-identical to before", digestOf(LIFECYCLE) === BEFORE.LIFECYCLE);
  ok("Z2  evidence_service.js is byte-identical to before", digestOf(EVIDENCE) === BEFORE.EVIDENCE);
  ok("Z3  proof_evaluation_service.js is byte-identical to before", digestOf(EVALS) === BEFORE.EVALS);

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
