#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   JS SELECTS · DB VALIDATES — AND THEY MUST AGREE

   Two definitions of "evidence a completion may rest on" now exist, and
   that is DELIBERATE rather than duplication:

     technician/evidence_service.completionEligibleEvidenceFor
         SELECTS which attachments a completion may be built on, BEFORE
         the canonical writer creates the evaluation.

     release_0_evidence_qualifies / release_0_completion_proof_status
         VALIDATES what was actually recorded, at COMMIT, for any writer
         including hand-run SQL that never touched the service.

   Different jobs, different moments, different callers. Forcing them into
   one implementation would mean either the database calling JavaScript or
   the writer's selection becoming a round trip per candidate photo.

   ── BUT TWO DEFINITIONS OF TRUTH DRIFT ──────────────────────────────

   A source gate comparing the classification and MIME arrays is NOT
   enough: the conditions can drift while the arrays stay identical. So
   this proves EQUIVALENCE over every row shape the schema permits,
   generated as a cross product rather than a hand-picked list — a
   hand-picked list is exactly what misses the case somebody adds later.

   Disagreement in either direction is a defect:

     JS says eligible, DB says not   the canonical writer builds a
                                     completion the database then refuses
                                     — an outage in the completion path
     DB says qualifies, JS says not  the writer refuses evidence the
                                     database would have accepted — work
                                     that cannot be completed through the
                                     product, only by hand

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137.

   usage:
     EQUIV_DATABASE_URL='postgresql://…' node tools/step12/prove_evidence_equivalence.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const evidence = require(path.join(ROOT, "src/technician/evidence_service.js"));
const guardWindow = require("./guard_window.js");
const URL = process.env.EQUIV_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);

const ID = (n) => crypto.createHash("md5").update("equiv:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), PROP_B = ID("propB"), TECH = ID("tech");

//  The full vocabularies the SCHEMA allows, read from its own check
//  constraints rather than retyped — a hardcoded list here would be a
//  fourth copy of exactly the thing this file exists to police.
const parseCheckList = (def) =>
  [...def.matchAll(/'([a-z_/]+)'::text/g)].map((m) => m[1]);

(async function main() {
  if (!URL) { console.error("REFUSED: EQUIV_DATABASE_URL is not set."); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const sentinel = Number((await c.query(
    `select count(*) n from release_0_scale_harness_guard where purpose like 'ISOLATED RELEASE 0%'`
  ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (sentinel !== 1) { console.error("REFUSED: not the isolated baseline."); process.exit(2); }

  console.log("EVIDENCE EQUIVALENCE — the JS selector vs the DB validator\n");
  await guardWindow.installGuard(c);

  await c.query(`insert into organizations (id,name) values ($1,'EQ Org') on conflict (id) do nothing`, [ORG]);
  for (const [p, n] of [[PROP, "EQ Property"], [PROP_B, "EQ Other"]]) {
    await c.query(`insert into properties (id,name,organization_id) values ($1,$2,$3)
                   on conflict (id) do nothing`, [p, n, ORG]);
  }
  await c.query(`insert into users (id,name,phone,role,is_active)
                 values ($1,'Eq Tech','+15415559971','maintenance',true) on conflict (id) do nothing`, [TECH]);

  const checks = Object.fromEntries((await c.query(
    `select conname, pg_get_constraintdef(oid) d from pg_constraint
      where conrelid='work_order_proof_attachments'::regclass and contype='c'`))
    .rows.map((r) => [r.conname, r.d]));
  const CLASSES = parseCheckList(checks.work_order_proof_attachments_proof_classification_check);
  const STATES = parseCheckList(checks.work_order_proof_attachments_storage_state_check);
  const MIMES = parseCheckList(checks.work_order_proof_attachments_mime_type_check);

  ok("V0  the schema's own vocabularies were read, not retyped",
     CLASSES.length >= 3 && STATES.length >= 3 && MIMES.length >= 2,
     JSON.stringify({ CLASSES, STATES, MIMES }));
  console.log(`        classifications ${CLASSES.length} · storage states ${STATES.length} · mimes ${MIMES.length}`);
  console.log(`        cross product to exercise: ${CLASSES.length * STATES.length * MIMES.length}`);

  let seq = 0;
  const mkWo = async (property = PROP, status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'equiv',$3,'equivproof')`, [wo, property, status]);
    return wo;
  };
  /*  `ck_wopa_stored_is_complete` moves the four durable fields together
   *  with the state, so they are not independently variable — the schema
   *  refuses a half-stored row. That is recorded rather than worked
   *  around: an axis that cannot vary is a stronger answer than one this
   *  file varies artificially. */
  const mkAtt = async (wo, property, { cls, state, mime }) => {
    const att = ID("att" + (++seq));
    const b = Buffer.from([2, 2, 2, 2, 2, 2]);
    const stored = state === "stored";
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [att, wo, property, TECH, "ME" + att.slice(0, 8), mime, state, cls,
       stored ? b : null, stored ? b.length : null,
       stored ? crypto.createHash("sha256").update(b).digest("hex") : null,
       stored ? new Date() : null]);
    return att;
  };

  // ══ E — THE FULL CROSS PRODUCT, ROW BY ROW ═════════════════════════
  sec("E · EVERY ROW SHAPE THE SCHEMA PERMITS — JS vs DB, one attachment at a time");
  const disagreements = [];
  let exercised = 0, unrepresentable = 0;
  {
    const wo = await mkWo();
    const built = [];   // { att, cls, state, mime }
    for (const cls of CLASSES) {
      for (const state of STATES) {
        for (const mime of MIMES) {
          // eslint-disable-next-line no-await-in-loop
          try {
            const att = await mkAtt(wo, PROP, { cls, state, mime });
            built.push({ att, cls, state, mime });
          } catch (e) { unrepresentable++; }
        }
      }
    }
    exercised = built.length;
    ok("E0  the cross product actually built rows", built.length >= 8, String(built.length));

    //  JS: the selector, asked once for the whole work order.
    const eligible = new Set((await evidence.completionEligibleEvidenceFor(c,
      { work_order_id: wo, property_id: PROP })).map((r) => r.id));

    //  DB: the validator, asked per attachment.
    for (const b of built) {
      // eslint-disable-next-line no-await-in-loop
      const dbSays = (await c.query(
        `select public.release_0_evidence_qualifies($1) q`, [b.att])).rows[0].q;
      const jsSays = eligible.has(b.att);
      if (dbSays !== jsSays) {
        disagreements.push({ ...b, jsSays, dbSays });
      }
    }
    ok("E1  the JS selector and the DB validator agree on EVERY representable row shape",
       disagreements.length === 0,
       JSON.stringify(disagreements, null, 1) +
       "\n          → JS-yes/DB-no is an OUTAGE: the canonical writer builds a completion " +
       "the database then refuses. DB-yes/JS-no is work that cannot be completed through " +
       "the product, only by hand.");
    console.log(`        ${exercised} shapes exercised · ${unrepresentable} refused by the schema`);

    //  ANTI-VACUITY. If neither side ever said yes, E1 passes trivially.
    const anyYes = eligible.size > 0;
    const anyNo = built.length > eligible.size;
    ok("E2  …and the matrix contains BOTH answers, so E1 is not vacuous",
       anyYes && anyNo,
       `eligible=${eligible.size} of ${built.length} — a matrix where every row gets the ` +
       "same answer would agree no matter what either side computed");
    console.log(`        qualifying: ${eligible.size} · non-qualifying: ${built.length - eligible.size}`);

    //  And name which axes actually discriminate, so a future reader can
    //  see WHY only some combinations qualify.
    const byAxis = {};
    for (const b of built) {
      const yes = eligible.has(b.att);
      byAxis[`class:${b.cls}`] = (byAxis[`class:${b.cls}`] || 0) + (yes ? 1 : 0);
      byAxis[`state:${b.state}`] = (byAxis[`state:${b.state}`] || 0) + (yes ? 1 : 0);
      byAxis[`mime:${b.mime}`] = (byAxis[`mime:${b.mime}`] || 0) + (yes ? 1 : 0);
    }
    console.log("        qualifying rows per axis value: " + JSON.stringify(byAxis));
    ok("E3  MIME does not discriminate — the schema already refuses every non-qualifying one",
       MIMES.every((m) => byAxis[`mime:${m}`] > 0),
       JSON.stringify(MIMES.map((m) => [m, byAxis[`mime:${m}`]])) +
       " — recorded, not hidden: the guard's MIME list is defence in depth over a " +
       "column the CHECK constraint has already narrowed to exactly those values");
  }

  // ══ W — THE WORK-ORDER LEVEL QUESTION ══════════════════════════════
  sec("W · release_0_completion_proof_status — the four answers, from real rows");
  {
    const cases = [];
    const record = async (label, expect, build) => {
      const wo = await mkWo();
      await build(wo);
      const got = (await c.query(
        `select public.release_0_completion_proof_status($1,$2) s`, [wo, PROP])).rows[0].s;
      cases.push({ label, expect, got, wo });
      ok(`W·${label.padEnd(34)} → ${expect}`, got === expect, `got ${got}`);
    };
    const evalRow = async (wo, state, atts = [], supersedes = null) => {
      const ev = ID("ev" + (++seq));
      await c.query(`insert into work_order_proof_evaluations
        (id,work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,$3,$4,'equiv','x',$5)`, [ev, wo, PROP, state, supersedes]);
      for (const a of atts) {
        // eslint-disable-next-line no-await-in-loop
        await c.query(`insert into work_order_proof_evaluation_attachments
          (evaluation_id,attachment_id,work_order_id,property_id) values ($1,$2,$3,$4)`,
          [ev, a, wo, PROP]);
      }
      return ev;
    };
    const good = (wo) => mkAtt(wo, PROP, { cls: "repair_photo", state: "stored", mime: MIMES[0] });
    const bad = (wo) => mkAtt(wo, PROP, { cls: "unclassified", state: "stored", mime: MIMES[0] });

    await record("no evaluation at all", "none", async () => {});
    await record("a not_satisfied head", "not_satisfied",
      async (wo) => { await evalRow(wo, "not_satisfied"); });
    await record("satisfied, zero links", "ungrounded",
      async (wo) => { await evalRow(wo, "satisfied"); });
    await record("satisfied, one NON-qualifying link", "ungrounded",
      async (wo) => { await evalRow(wo, "satisfied", [await bad(wo)]); });
    await record("satisfied, one qualifying link", "grounded",
      async (wo) => { await evalRow(wo, "satisfied", [await good(wo)]); });
    await record("satisfied, MIXED links", "grounded",
      async (wo) => { await evalRow(wo, "satisfied", [await bad(wo), await good(wo)]); });
    await record("satisfied, MANY qualifying links", "grounded",
      async (wo) => { await evalRow(wo, "satisfied", [await good(wo), await good(wo)]); });

    /*  SUPERSESSION. Only the HEAD counts — a grounded evaluation that has
     *  been superseded by a bare one must NOT keep the work order legal,
     *  and a superseded bare one must not keep it illegal. */
    await record("grounded head SUPERSEDED by a bare satisfied", "ungrounded",
      async (wo) => {
        const first = await evalRow(wo, "satisfied", [await good(wo)]);
        await evalRow(wo, "satisfied", [], first);
      });
    await record("bare head SUPERSEDED by a grounded satisfied", "grounded",
      async (wo) => {
        const first = await evalRow(wo, "satisfied");
        await evalRow(wo, "satisfied", [await good(wo)], first);
      });
    await record("grounded head SUPERSEDED by not_satisfied", "not_satisfied",
      async (wo) => {
        const first = await evalRow(wo, "satisfied", [await good(wo)]);
        await evalRow(wo, "not_satisfied", [], first);
      });

    ok("W·all every case returned one of the four documented answers",
       cases.every((x) => ["none", "not_satisfied", "ungrounded", "grounded"].includes(x.got)),
       JSON.stringify(cases.map((x) => x.got)));
    ok("W·mix the cases are not all the same answer",
       new Set(cases.map((x) => x.got)).size === 4,
       JSON.stringify([...new Set(cases.map((x) => x.got))]));
  }

  // ══ S — CROSS-SCOPE ════════════════════════════════════════════════
  sec("S · A LINK ACROSS PROPERTIES OR WORK ORDERS IS UNREPRESENTABLE");
  {
    const mine = await mkWo(PROP);
    const theirs = await mkWo(PROP_B);
    const theirAtt = await mkAtt(theirs, PROP_B,
      { cls: "repair_photo", state: "stored", mime: MIMES[0] });
    const ev = ID("ev-cross");
    await c.query(`insert into work_order_proof_evaluations
      (id,work_order_id,property_id,state,evaluated_by_service,rule_version)
      values ($1,$2,$3,'satisfied','equiv','x')`, [ev, mine, PROP]);

    let err = null;
    try {
      await c.query(`insert into work_order_proof_evaluation_attachments
        (evaluation_id,attachment_id,work_order_id,property_id) values ($1,$2,$3,$4)`,
        [ev, theirAtt, mine, PROP]);
    } catch (e) { err = e; }
    ok("S1  citing another work order's photo is refused by the composite FK",
       !!err && err.code === "23503", err ? err.code : "IT WAS ACCEPTED");
    ok("S2  …so the work order reads `ungrounded`, not `grounded`",
       (await c.query(`select public.release_0_completion_proof_status($1,$2) s`,
                      [mine, PROP])).rows[0].s === "ungrounded");
    console.log("        → the scope predicate in the validator is belt-and-braces over a");
    console.log("          link the schema already makes unrepresentable. Both, deliberately.");
  }

  // ══ A — THE AUDIT VIEW READS THE SAME FUNCTION ═════════════════════
  sec("A · THE AUDIT VIEW IS NOT A FOURTH INTERPRETATION");
  {
    const def = (await c.query(
      `select pg_get_viewdef('public.release_0_completion_invariant_violations'::regclass) d`))
      .rows[0].d;
    ok("A1  the violations view derives from release_0_completion_proof_status",
       /release_0_completion_proof_status/.test(def),
       "the view has grown its own copy of the rule — which is the fourth interpretation " +
       "this whole refactor exists to prevent");
    ok("A2  …and does not restate the evidence columns itself",
       !/proof_classification|storage_state|sha256/.test(def),
       def.slice(0, 300));

    const guardSrc = (await c.query(
      `select prosrc from pg_proc where proname='release_0_assert_completion_truth'`))
      .rows[0].prosrc;
    ok("A3  the deferred guard calls it too, rather than restating it",
       /release_0_completion_proof_status/.test(guardSrc) &&
       !/proof_classification/.test(guardSrc),
       "the guard still carries its own copy of the evidence predicate");

    console.log("        → three callers, one definition: the deferred guard, the");
    console.log("          activation's population validation, and this view.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
