#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   THE ACTIVATION'S OWN REFUSALS — the one irreversible act

   Two questions, both about the single act that cannot be undone:

     G  Does the activation validate the ACTUAL guard, or its NAME?
        A trigger can be present and disabled. A function can carry the
        right name and a permissive body. A constraint trigger can be
        recreated as immediate. Each of those looks correct in a listing
        and protects nothing.

     P  Does the activation refuse a population that ALREADY violates the
        invariant? The census only sees terminal rows with NO evaluation,
        so a terminal row with a `not_satisfied` head — or a `satisfied`
        head citing no real evidence — is invisible to it. It would exist
        on day one, permanently, legal purely because no trigger fired at
        the instant the cutover was recorded.

   ── ONE VARIANT PER INVOCATION ──────────────────────────────────────

   A database has exactly one genesis activation, and the record is
   append-only, so a refusal cannot be retried on the same baseline
   without ambiguity about which refusal fired. Each variant gets its own.

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.

   usage:
     REFUSAL_DATABASE_URL='…' node tools/step12/falsify_activation_refusals.js --variant <v>
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const guardWindow = require("./guard_window.js");
const URL = process.env.REFUSAL_DATABASE_URL;

const VARIANTS = {
  //  ── G · the guard is present in NAME only ────────────────────────
  "guard-absent": {
    what: "migration 140 was never applied",
    expect: "GUARD_ABSENT",
    break: async (c) => {
      for (const [n, t] of guardWindow.TRIGGERS) {
        // eslint-disable-next-line no-await-in-loop
        await c.query(`drop trigger if exists ${n} on public.${t}`);
      }
      await c.query(`drop function if exists public.release_0_assert_completion_truth(uuid) cascade`);
    },
  },
  "trigger-dropped": {
    what: "the function is intact; ONE trigger was dropped",
    expect: "GUARD_ABSENT",
    break: (c) => c.query(`drop trigger assert_completion_truth_upd on public.work_orders`),
  },
  "trigger-disabled": {
    what: "every trigger EXISTS, correctly defined — and is DISABLED",
    expect: "GUARD_STALE",
    break: async (c) => {
      for (const [n, t] of guardWindow.TRIGGERS) {
        // eslint-disable-next-line no-await-in-loop
        await c.query(`alter table public.${t} disable trigger ${n}`);
      }
    },
  },
  "not-deferred": {
    what: "the trigger is recreated as an IMMEDIATE constraint trigger",
    expect: "GUARD_STALE",
    break: async (c) => {
      await c.query(`drop trigger assert_completion_truth_upd on public.work_orders`);
      await c.query(`create constraint trigger assert_completion_truth_upd
        after update on public.work_orders
        for each row
        when (new.status in ('complete','closed') or old.status in ('complete','closed'))
        execute function public.release_0_guard_work_order()`);
    },
  },
  "permissive-body": {
    what: "the function keeps its NAME and returns immediately",
    expect: "GUARD_STALE",
    break: (c) => c.query(`create or replace function
      public.release_0_assert_completion_truth(p_work_order uuid)
      returns void as $x$ begin return; end; $x$ language plpgsql`),
  },
  "epoch-missing": {
    what: "the epoch table is gone — nothing for a stale snapshot to fail on",
    expect: "GUARD_ABSENT",
    break: (c) => c.query(`drop table public.release_0_activation_epoch cascade`),
  },
  "epoch-not-stamped": {
    what: "the epoch exists; the trigger that MOVES it was dropped",
    expect: "GUARD_ABSENT",
    break: (c) => c.query(
      `drop trigger stamp_activation_epoch on public.release_0_activation_history`),
  },

  //  ── P · the population is already unexplainable ──────────────────
  "population-not-satisfied": {
    what: "a terminal work order already carries a `not_satisfied` head",
    expect: "POPULATION_NOT_EXPLAINABLE",
    populate: async (ctx) => {
      const wo = await ctx.mkWo("complete");
      await ctx.forge(wo, [], "not_satisfied");
      return wo;
    },
  },
  "population-ungrounded": {
    what: "a terminal work order carries a `satisfied` head citing NO evidence",
    expect: "POPULATION_NOT_EXPLAINABLE",
    populate: async (ctx) => {
      const wo = await ctx.mkWo("complete");
      await ctx.forge(wo, [], "satisfied");
      return wo;
    },
  },
  "population-closed-evaluated": {
    what: "a `closed` work order carries an evaluation — invisible to the census",
    expect: "POPULATION_NOT_EXPLAINABLE",
    populate: async (ctx) => {
      const wo = await ctx.mkWo("closed");
      await ctx.forge(wo, [await ctx.mkAtt(wo)], "satisfied");
      return wo;
    },
  },
  "population-clean": {
    what: "CONTROL — grounded satisfied completions and unevaluated legacy only",
    expect: null,                    // must ACTIVATE
    populate: async (ctx) => {
      const done = await ctx.mkWo("open");
      const att = await ctx.mkAtt(done);
      await ctx.forge(done, [att], "satisfied");
      await ctx.c.query(`update work_orders set status='complete' where id=$1`, [done]);
      await ctx.mkWo("closed");      // unevaluated legacy → the census sees it
      return done;
    },
  },
};

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };

const ID = (n) => crypto.createHash("md5").update("refuse:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  const V = (process.argv.find((a) => a.startsWith("--variant=")) || "").split("=")[1]
    || process.argv[process.argv.indexOf("--variant") + 1];
  if (!URL) { console.error("REFUSED: REFUSAL_DATABASE_URL is not set."); process.exit(1); }
  if (!V || !VARIANTS[V]) {
    console.error("REFUSED: --variant is required. One of:");
    for (const [k, v] of Object.entries(VARIANTS)) console.error(`  ${k.padEnd(28)} ${v.what}`);
    process.exit(2);
  }
  const spec = VARIANTS[V];

  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }
  if (Number((await c.query(`select count(*) n from release_0_activation_history`)).rows[0].n) > 0) {
    console.error("REFUSED: activation history is not empty. Rebuild the baseline.");
    process.exit(3);
  }

  console.log(`ACTIVATION REFUSALS — variant "${V}"`);
  console.log(`  breaks : ${spec.what}`);
  console.log(`  expect : ${spec.expect || "IT MUST ACTIVATE (control)"}\n`);

  await guardWindow.installGuard(c);
  await c.query(`insert into organizations (id,name) values ($1,'RF Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'RF Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Ren Refuse','+15415559961','maintenance',true) on conflict (id) do nothing`, [TECH]);

  let seq = 0;
  const ctx = {
    c,
    mkWo: async (status = "open") => {
      const wo = ID("wo" + (++seq));
      await c.query(`insert into work_orders (id,property_id,title,status,source)
                     values ($1,$2,'refuse',$3,'refuseproof')`, [wo, PROP, status]);
      return wo;
    },
    mkAtt: async (wo) => {
      const att = ID("att" + (++seq)); const b = Buffer.from([3, 3, 3, 3]);
      await c.query(`insert into work_order_proof_attachments
        (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
         storage_state,proof_classification,content,byte_size,sha256,stored_at)
        values ($1,$2,$3,$4,'twilio',$5,'image/jpeg','stored','repair_photo',$6,$7,$8,now())`,
        [att, wo, PROP, TECH, "ME" + att.slice(0, 8), b, b.length,
         crypto.createHash("sha256").update(b).digest("hex")]);
      return att;
    },
    forge: async (wo, attIds, state) => {
      const ev = ID("ev" + (++seq));
      await c.query(`insert into work_order_proof_evaluations
        (id,work_order_id,property_id,state,evaluated_by_service,rule_version)
        values ($1,$2,$3,$4,'refuse-forge','x')`, [ev, wo, PROP, state]);
      for (const a of attIds) {
        // eslint-disable-next-line no-await-in-loop
        await c.query(`insert into work_order_proof_evaluation_attachments
          (evaluation_id,attachment_id,work_order_id,property_id) values ($1,$2,$3,$4)`,
          [ev, a, wo, PROP]);
      }
      return ev;
    },
  };

  /*  A population variant builds a state the guard would refuse, so it is
   *  built with the guard off — the point is that the ACTIVATION catches
   *  what the guard never got the chance to. */
  let subject = null;
  if (spec.populate) {
    subject = await guardWindow.withGuardOff(c,
      `the ${V} variant must present the activation with a pre-existing violation`,
      () => spec.populate(ctx));
  }
  //  Always at least one legitimate legacy row, so the census is real.
  await ctx.mkWo("closed");

  if (spec.break) await spec.break(c);

  const census = await activation.readLegacyTerminalSet(c);
  let err = null;
  try {
    await c.query("begin");
    await activation.recordActivation(c, {
      activated_at: CUTOVER, captured_by: "refusal proof", expected: census });
    await c.query("commit");
  } catch (e) { err = e; await c.query("rollback").catch(() => {}); }

  const activated = Number((await c.query(
    `select count(*) n from release_0_activation_history`)).rows[0].n);

  if (spec.expect === null) {
    ok("R1  CONTROL — a clean population ACTIVATES",
       err === null && activated === 1,
       (err ? err.code + " " + err.message : `activated=${activated}`) +
       "\n          → if the control is refused too, every refusal above passes because " +
       "the activation refuses everything, and none of them prove anything");
    ok("R2  …and the epoch moved with it",
       (await c.query(`select activation_id from release_0_activation_epoch`))
         .rows[0].activation_id !== null,
       "the epoch is still null after a successful activation — the guard would stay inert");
  } else {
    ok(`R1  the activation is REFUSED with ${spec.expect}`,
       !!err && err.code === spec.expect,
       err ? err.code + " " + err.message.slice(0, 200) : "IT ACTIVATED");
    ok("R2  …and NOTHING was recorded — the irreversible act did not happen",
       activated === 0, `${activated} activation row(s) exist`);
    ok("R3  …nor any inventory",
       Number((await c.query(
         `select count(*) n from release_0_legacy_cutover_inventory`)).rows[0].n) === 0);
    ok("R4  …and the epoch was not stamped",
       spec.expect === "GUARD_ABSENT" && V === "epoch-missing" ? true :
       (await c.query(`select activation_id from release_0_activation_epoch`))
         .rows[0].activation_id === null,
       "the epoch moved even though the activation was refused");
    if (subject) {
      console.log(`        offending work order: ${subject}`);
      if (err && err.unexplainable) {
        console.log(`        the refusal named ${err.unexplainable.length} row(s): ` +
          JSON.stringify(err.unexplainable.map((r) => ({
            status: r.status, head: r.head_state, grounded: r.grounded }))));
      }
    }
  }

  console.log(`\n  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
