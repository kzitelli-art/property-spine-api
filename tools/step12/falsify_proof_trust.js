#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   WHAT IS THE GUARD ACTUALLY ENTITLED TO BELIEVE?

   Revision 2 made a terminal work order legal only with a current
   `satisfied` evaluation. That moved the whole question onto one column
   in one row: does `state = 'satisfied'` mean anything?

   We spent this release learning not to trust `work_orders.status`. A
   column in a DIFFERENT table that happens to read 'satisfied' has earned
   no more trust than that one had — unless something makes it earn it.

   ── WHAT THIS FILE ATTACKS ──────────────────────────────────────────

     C  FORGE IT.   Insert `satisfied` with no evidence, with
                    non-qualifying evidence, and with evidence whose bytes
                    / storage / classification fail the Step 3 gate — then
                    terminalize. Each case names WHICH layer refused.
     P  ROT IT.     Complete properly, then try every mutation that would
                    make the evidence underneath cease to qualify. The
                    invariant is cross-table; this enumerates every table
                    that can invalidate it WITHOUT touching work_orders.
     D  `closed`.   Post-cutover `open → closed` WITH a satisfied
                    evaluation must still be refused: `closed` is
                    historical vocabulary. And an inventoried legacy row's
                    status is frozen, not merely "some terminal value".
     H  THE EDGE.   A deliberately hollow-but-proof-satisfied completion:
                    what migration 140 does NOT guarantee, stated exactly
                    rather than left to grow into a bigger claim.

   Predictions are recorded BEFORE results.

   ⚠ ISOLATED POSTGRES ONLY. Ledger 137, virgin activation history.

   usage:
     TRUST_DATABASE_URL='postgresql://…' node tools/step12/falsify_proof_trust.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
const lifecycle = require(path.join(ROOT, "src/technician/lifecycle_service.js"));
const FACTS = require(path.join(ROOT, "tools/step4/completion_facts.js"));
const guardWindow = require("./guard_window.js");
const URL = process.env.TRUST_DATABASE_URL;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sec = (t) => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const predict = (t) => console.log("  PREDICTION:  " + t + "\n");

const ID = (n) => crypto.createHash("md5").update("trust:" + n).digest("hex")
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");
const ORG = ID("org"), PROP = ID("prop"), TECH = ID("tech");
const CUTOVER = new Date(Date.parse("2026-08-08T09:15:00.000Z"));

(async function main() {
  if (!URL) { console.error("REFUSED: TRUST_DATABASE_URL is not set."); process.exit(1); }
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

  console.log("THE TRUST ROOT — is `satisfied` a fact or a word?\n");
  await guardWindow.installGuard(c);

  await c.query(`insert into organizations (id,name) values ($1,'TR Org') on conflict (id) do nothing`, [ORG]);
  await c.query(`insert into properties (id,name,organization_id) values ($1,'TR Property',$2)
                 on conflict (id) do nothing`, [PROP, ORG]);
  await c.query(`insert into users (id,name,phone,role,is_active,status)
                 values ($1,'Tris Trust','+15415559951','maintenance',true,'active')
                 on conflict (id) do nothing`, [TECH]);
  await c.query(`insert into property_team_assignments
                   (user_id,property_id,role_title,allowed_modules,active)
                 values ($1,$2,'Maintenance Tech',array['maintenance'],true)`, [TECH, PROP]);

  let seq = 0;
  const mkWo = async (status = "open") => {
    const wo = ID("wo" + (++seq));
    await c.query(`insert into work_orders (id,property_id,title,status,source)
                   values ($1,$2,'trust',$3,'trustproof')`, [wo, PROP, status]);
    await c.query(`insert into obligations (property_id,related_id,related_type,module,type,label,status)
                   values ($1,$2,'work_order','maintenance','work_order_routing','r','open')`, [PROP, wo]);
    return wo;
  };
  /*  An attachment, with every qualifying property individually
   *  overridable. That is what makes C3–C6 one-variable-at-a-time rather
   *  than a pile of differently-broken rows. */
  const mkAtt = async (wo, over = {}) => {
    const att = ID("att" + (++seq));
    const b = Buffer.from([5, 5, 5, 5, 5]);
    const f = Object.assign({
      storage_state: "stored", proof_classification: "repair_photo",
      mime_type: "image/jpeg", content: b, byte_size: b.length,
      sha256: crypto.createHash("sha256").update(b).digest("hex"), stored_at: new Date(),
    }, over);
    await c.query(`insert into work_order_proof_attachments
      (id,work_order_id,property_id,uploaded_by_user_id,provider,provider_media_id,mime_type,
       storage_state,proof_classification,content,byte_size,sha256,stored_at)
      values ($1,$2,$3,$4,'twilio',$5,$6,$7,$8,$9,$10,$11,$12)`,
      [att, wo, PROP, TECH, "ME" + att.slice(0, 8), f.mime_type, f.storage_state,
       f.proof_classification, f.content, f.byte_size, f.sha256, f.stored_at]);
    return att;
  };
  //  A raw `satisfied` evaluation, optionally citing attachments.
  const forge = async (client, wo, attIds = [], state = "satisfied") => {
    const ev = ID("ev" + (++seq));
    await client.query(`insert into work_order_proof_evaluations
      (id,work_order_id,property_id,state,evaluated_by_service,rule_version)
      values ($1,$2,$3,$4,'forged-by-hand','x')`, [ev, wo, PROP, state]);
    for (const a of attIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`insert into work_order_proof_evaluation_attachments
        (evaluation_id,attachment_id,work_order_id,property_id) values ($1,$2,$3,$4)`,
        [ev, a, wo, PROP]);
    }
    return ev;
  };
  const tx = async (fn) => {
    await c.query("begin");
    try { await fn(); await c.query("commit"); return null; }
    catch (e) { await c.query("rollback").catch(() => {}); return e; }
  };
  const stateOf = async (wo) => {
    const s = await reader.readWorkOrderStatus(c, { propertyId: PROP, workOrderId: wo });
    return s && s.proof && (s.proof.state || s.proof.read_status);
  };
  const statusOf = async (wo) => (await c.query(
    `select status from work_orders where id=$1`, [wo])).rows[0]?.status ?? null;

  //  A pre-cutover legacy row, so the inventory is real.
  const LEGACY = await mkWo("closed");

  const census = await activation.readLegacyTerminalSet(c);
  await c.query("begin");
  await activation.recordActivation(c, {
    activated_at: CUTOVER, captured_by: "trust proof", expected: census });
  await c.query("commit");
  console.log(`  (activated; ${census.length} legacy row(s) inventoried)\n`);

  /* ═══ C · FORGE `satisfied` ═══════════════════════════════════════ */
  sec("C · CAN `satisfied` BE MANUFACTURED AND CASHED IN?");
  predict("Nothing in the schema ties an evaluation to evidence: no NOT NULL, no FK,\n"
        + "             no check. So all five forgeries INSERT cleanly — the evaluation table\n"
        + "             will not stop them. The question is whether terminalizing then\n"
        + "             succeeds. If the guard trusts the word, C1 commits and we have moved\n"
        + "             the status bypass one table over instead of closing it. I expect the\n"
        + "             GUARD to be the layer that refuses, and no other.");
  {
    const cases = [
      { id: "C1", what: "zero attachment links", atts: async () => [] },
      { id: "C2", what: "linked to a NON-QUALIFYING classification ('unclassified')",
        atts: async (wo) => [await mkAtt(wo, { proof_classification: "unclassified" })] },
      { id: "C3", what: "linked to evidence that was never STORED",
        atts: async (wo) => [await mkAtt(wo, {
          storage_state: "referenced", content: null, byte_size: null,
          sha256: null, stored_at: null })] },
      { id: "C4", what: "linked to a disallowed MIME (application/pdf)",
        atts: async (wo) => [await mkAtt(wo, { mime_type: "application/pdf" })] },
      { id: "C5", what: "linked to a qualifying photo of a DIFFERENT work order",
        atts: async (wo) => { void wo; const other = await mkWo("open");
                              return [await mkAtt(other)]; } },
    ];
    for (const t of cases) {
      // eslint-disable-next-line no-await-in-loop
      const wo = await mkWo("open");
      /*  The forgery may be unrepresentable: the schema refuses some of
       *  these outright. That is a REFUSAL, not a harness failure, and it
       *  is a better answer than the guard's — so it is caught and
       *  attributed rather than crashing the run. */
      let atts = null, setupErr = null;
      // eslint-disable-next-line no-await-in-loop
      try { atts = await t.atts(wo); } catch (e) { setupErr = e; }
      /*  Status and evaluation in ONE transaction, exactly as a real
       *  completion does it — so the attack gets every advantage the
       *  deferred design gives the canonical writer. */
      // eslint-disable-next-line no-await-in-loop
      const err = setupErr || await tx(async () => {
        await forge(c, wo, atts);
        await c.query(`update work_orders set status='complete' where id=$1`, [wo]);
      });
      // eslint-disable-next-line no-await-in-loop
      const st = await statusOf(wo);
      ok(`${t.id}  forged satisfied, ${t.what} → REFUSED`,
         err !== null && st !== "complete",
         (err ? err.code + " " + err.message : "IT COMMITTED") + ` · status=${st}`);
      const layer = !err ? "NOTHING" :
        setupErr ? "schema — the forgery is not even REPRESENTABLE (" +
                   (err.constraint || err.code) + ")" :
        err.code === "R0004" ? "migration 140 (unqualified evidence)" :
        err.code === "R0001" ? "migration 140 (no satisfied head)" :
        err.code === "23503" ? "schema — foreign key" :
        err.code === "23514" ? "schema — check constraint (" + (err.constraint || "") + ")" :
        "code " + err.code;
      console.log(`        refused by: ${layer}`);
    }

    //  THE CONTROL. The same shape, with evidence that genuinely
    //  qualifies, must COMMIT — otherwise C1–C5 prove only that the guard
    //  refuses everything.
    const good = await mkWo("open");
    const goodAtt = await mkAtt(good);
    const gerr = await tx(async () => {
      await forge(c, good, [goodAtt]);
      await c.query(`update work_orders set status='complete' where id=$1`, [good]);
    });
    ok("C6  CONTROL — the same hand-written shape with QUALIFYING evidence commits",
       gerr === null && await statusOf(good) === "complete",
       (gerr ? gerr.code + " " + gerr.message : "") +
       " — if this is refused too, C1–C5 pass because the guard refuses everything " +
       "and prove nothing about evidence");
    ok("C6a …and the canonical reader calls it satisfied",
       await stateOf(good) === "satisfied", String(await stateOf(good)));
    console.log("        → note what C6 means: migration 140 does NOT require the CALLER");
    console.log("          to be claimCompletion. It requires the STATE to be true. Raw SQL");
    console.log("          that establishes real evidence and cites it is not an attack.");
  }

  /* ═══ P · MAKE THE EVIDENCE ROT UNDERNEATH ════════════════════════ */
  sec("P · CAN THE EVIDENCE UNDER A COMPLETED WORK ORDER BE INVALIDATED?");
  predict("The invariant is cross-table, so every table that can change what the guard\n"
        + "             reads is an attack surface. I expect append-only triggers to refuse the\n"
        + "             evaluation and link mutations, an FK ON DELETE RESTRICT to refuse the\n"
        + "             attachment deletion, and a CHECK to refuse a half-un-stored attachment.\n"
        + "             The one I am least sure of is UPDATEing the attachment's\n"
        + "             classification — no rule obviously forbids it, and it would silently\n"
        + "             hollow out a completed work order without touching work_orders.");
  let COMPLETED = null;
  {
    //  A REAL completion through the canonical writer.
    COMPLETED = await mkWo("open");
    await mkAtt(COMPLETED);
    await c.query("begin");
    const done = await lifecycle.claimCompletion(c, {
      work_order_id: COMPLETED, user_id: TECH, organization_id: ORG,
      idempotency_key: "trust-p" });
    await c.query("commit");
    ok("P0  the canonical writer completed it, under the guard",
       done.closed === true && await stateOf(COMPLETED) === "satisfied",
       JSON.stringify({ outcome: done.outcome, missing: done.missing }));

    const headId = (await c.query(
      `select id from work_order_proof_evaluation_head where work_order_id=$1`,
      [COMPLETED])).rows[0].id;

    const attacks = [
      { id: "P1", what: "re-classify the cited attachment to 'unclassified'",
        run: () => c.query(`update work_order_proof_attachments
                              set proof_classification='unclassified' where work_order_id=$1`,
                           [COMPLETED]) },
      { id: "P2", what: "un-store the cited attachment (all four durable fields)",
        run: () => c.query(`update work_order_proof_attachments
                              set storage_state='not_preserved', content=null, byte_size=null,
                                  sha256=null, stored_at=null where work_order_id=$1`,
                           [COMPLETED]) },
      { id: "P3", what: "delete the cited attachment",
        run: () => c.query(`delete from work_order_proof_attachments where work_order_id=$1`,
                           [COMPLETED]) },
      { id: "P4", what: "delete the evaluation→attachment link",
        run: () => c.query(`delete from work_order_proof_evaluation_attachments
                             where work_order_id=$1`, [COMPLETED]) },
      { id: "P5", what: "re-point the link at a different attachment",
        run: async () => {
          const other = await mkAtt(await mkWo("open"));
          return c.query(`update work_order_proof_evaluation_attachments
                            set attachment_id=$2 where work_order_id=$1`, [COMPLETED, other]);
        } },
      { id: "P6", what: "edit the evaluation's state to not_satisfied in place",
        run: () => c.query(`update work_order_proof_evaluations set state='not_satisfied'
                             where id=$1`, [headId]) },
      { id: "P7", what: "delete the evaluation",
        run: () => c.query(`delete from work_order_proof_evaluations where id=$1`, [headId]) },
      { id: "P8", what: "SUPERSEDE the head with an ungrounded not_satisfied evaluation",
        run: () => c.query(`insert into work_order_proof_evaluations
          (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
          values ($1,$2,'not_satisfied','forged-by-hand','x',$3)`, [COMPLETED, PROP, headId]) },
    ];
    for (const t of attacks) {
      // eslint-disable-next-line no-await-in-loop
      const err = await tx(t.run);
      // eslint-disable-next-line no-await-in-loop
      const st = await stateOf(COMPLETED);
      const layer = !err ? "NOTHING — IT SUCCEEDED" :
        /append-only|forbid/i.test(err.message) ? "schema — append-only trigger" :
        err.code === "23503" ? "schema — FK ON DELETE RESTRICT" :
        err.code === "23514" ? "schema — CHECK constraint" :
        err.code === "R0004" ? "migration 140 (evidence no longer qualifies)" :
        err.code === "R0001" ? "migration 140 (head is not satisfied)" :
        "code " + err.code;
      ok(`${t.id}  ${t.what} → REFUSED`,
         err !== null && st === "satisfied",
         (err ? err.code + " " + err.message.slice(0, 140) : "IT SUCCEEDED") +
         ` · reader now: ${st}`);
      console.log(`        refused by: ${layer}`);
    }

    /*  ── AND THE LINE THAT MUST NOT BE CROSSED ──────────────────────
     *
     *  P8 refuses a superseding `not_satisfied` on a completed work
     *  order. Read carelessly that is a database invariant keeping
     *  `satisfied` true by DENYING THE SYSTEM PERMISSION TO RECORD THAT
     *  IT WAS WRONG — which would be the worst possible outcome for a
     *  product whose north star is recording the truth.
     *
     *  It is not that, and P9 is the proof. What the guard forbids is a
     *  work order that ENDS the transaction terminal without proof. A
     *  correction that also reopens the work — in the same transaction,
     *  which the deferred design makes natural — is entirely legal.
     *
     *  So the rule is "correcting completed work reopens it", not "you
     *  may never say a completion was wrong". Recorded here because a
     *  future correction path must be built against this shape.  */
    const headNow = (await c.query(
      `select id from work_order_proof_evaluation_head where work_order_id=$1`,
      [COMPLETED])).rows[0].id;
    const corrected = await tx(async () => {
      await c.query(`update work_orders set status='open' where id=$1`, [COMPLETED]);
      await c.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,'not_satisfied','governed-correction','x',$3)`,
        [COMPLETED, PROP, headNow]);
    });
    ok("P9  a CORRECTION that reopens the work in the same transaction is ALLOWED",
       corrected === null && await stateOf(COMPLETED) === "not_satisfied" &&
       await statusOf(COMPLETED) === "open",
       (corrected ? corrected.code + " " + corrected.message : "") +
       ` · status=${await statusOf(COMPLETED)} · reader=${await stateOf(COMPLETED)}` +
       "\n          → if this were refused, the guard would be preserving a completion by " +
       "forbidding the system to record evidence that it was wrong. That is the one " +
       "thing this product must never do.");
    console.log("        → THE RELEASE 0 RULE, stated: changing the proof state of");
    console.log("          completed work is a REOPEN. The evidence is recordable; what");
    console.log("          is refused is leaving the work order terminal while saying so.");

    //  Put it back, so H below starts from a clean population.
    await tx(async () => {
      await c.query(`update work_orders set status='complete' where id=$1`, [COMPLETED]);
      await c.query(`insert into work_order_proof_evaluations
        (work_order_id,property_id,state,evaluated_by_service,rule_version,supersedes_id)
        values ($1,$2,'satisfied','governed-correction','x',
                (select id from work_order_proof_evaluation_head where work_order_id=$1))`,
        [COMPLETED, PROP]);
    });
  }

  /* ═══ D · THE FROZEN MEANING OF `closed` ══════════════════════════ */
  sec("D · `closed` IS HISTORICAL VOCABULARY, AND LEGACY STATUS IS FROZEN");
  predict("Revision 2 asked only 'is the proof good?', so `open → closed` WITH a\n"
        + "             satisfied evaluation was legal — a second, permanently valid completion\n"
        + "             vocabulary the day after cutover, contradicting the frozen Step 6\n"
        + "             ruling. And an inventoried row only had to stay SOME terminal value, so\n"
        + "             `closed → complete` with no evaluation relabelled history as a governed\n"
        + "             completion. Both must now be refused.");
  {
    const wo = await mkWo("open");
    const att = await mkAtt(wo);
    const err = await tx(async () => {
      await forge(c, wo, [att]);
      await c.query(`update work_orders set status='closed' where id=$1`, [wo]);
    });
    ok("D1  post-cutover `open → closed` is REFUSED even WITH qualifying proof",
       !!err && err.code === "R0003" && await statusOf(wo) !== "closed",
       (err ? err.code + " " + err.message : "IT COMMITTED") +
       " — `closed` would become a second completion vocabulary that Step 6 froze");

    /*  …and the same work, completed the right way, is fine. Otherwise D1
     *  could pass simply because the row was unfinishable.
     *
     *  The evaluation has to be re-forged: D1's transaction was REFUSED,
     *  so it rolled back the evaluation along with the status. A first
     *  version reused it and D1a failed with "no proof evaluation" —
     *  which would have read as `open → complete` being broken when in
     *  fact the control had nothing to stand on. */
    const err2 = await tx(async () => {
      await forge(c, wo, [att]);
      await c.query(`update work_orders set status='complete' where id=$1`, [wo]);
    });
    ok("D1a …while `open → complete` on the SAME row, same proof, commits",
       err2 === null && await statusOf(wo) === "complete",
       err2 && err2.code + " " + err2.message);

    const relabel = await tx(() =>
      c.query(`update work_orders set status='complete' where id=$1`, [LEGACY]));
    ok("D2  an inventoried legacy row cannot be relabelled `closed → complete`",
       !!relabel && relabel.code === "R0002" && await statusOf(LEGACY) === "closed",
       (relabel ? relabel.code + " " + relabel.message : "IT COMMITTED") +
       " — grandfathering would become a standing licence to re-complete history");

    const reopen = await tx(() =>
      c.query(`update work_orders set status='open' where id=$1`, [LEGACY]));
    ok("D3  …nor reopened", !!reopen && reopen.code === "R0002",
       reopen ? reopen.code : "IT COMMITTED");
    ok("D4  …and the reader still calls it legacy_indeterminate, untouched",
       await stateOf(LEGACY) === "legacy_indeterminate", String(await stateOf(LEGACY)));
  }

  /* ═══ H · WHAT MIGRATION 140 DOES NOT GUARANTEE ═══════════════════ */
  sec("H · THE BOUNDARY, STATED EXACTLY — proof/status truth is NOT the eight facts");
  predict("Migration 140 governs the relationship between terminal status and proof. It\n"
        + "             says nothing about the progress rows, the obligation closure or the\n"
        + "             receipt. So a deliberate SQL writer that establishes REAL evidence and\n"
        + "             cites it can commit a work order that is proof-true and structurally\n"
        + "             hollow. I expect that to COMMIT, and the Step 4 fact set to catch it.\n"
        + "             This is a boundary to document, not a hole to fix here.");
  {
    const wo = await mkWo("open");
    const att = await mkAtt(wo);
    const err = await tx(async () => {
      await forge(c, wo, [att]);
      await c.query(`update work_orders set status='complete' where id=$1`, [wo]);
    });
    ok("H1  a proof-satisfied but structurally hollow completion COMMITS",
       err === null && await statusOf(wo) === "complete",
       err ? err.code + " " + err.message : "");
    ok("H2  …and the reader, correctly, calls its proof satisfied",
       await stateOf(wo) === "satisfied", String(await stateOf(wo)));

    const f = await FACTS.checkCompletionFacts(c,
      { work_order_id: wo, property_id: PROP, actor_user_id: TECH });
    const red = f.facts.filter((x) => !x.held).map((x) => x.id);
    ok("H3  …but the STEP 4 FACT SET refuses it — the eight facts are not satisfied",
       f.allHeld === false && red.length > 0, "red: " + red.join(","));
    ok("H4  …specifically the progress/obligation/receipt facts, not the proof facts",
       red.some((id) => ["F1", "F1b", "F6", "F8"].includes(id)),
       "red: " + red.join(",") + " — if only proof facts are red, H's claim is wrong");
    console.log("        red facts: " + red.join(" · "));
    console.log("        → SAY IT THIS WAY, AND NO STRONGER:");
    console.log("          migration 140 prevents terminal-state/proof DIVERGENCE.");
    console.log("          The canonical service still owns the full eight-fact completion");
    console.log("          transaction. The trigger does not make arbitrary SQL equivalent");
    console.log("          to claimCompletion, and no receipt may say that it does.");
  }

  sec("VERDICT");
  console.log(`  passed ${pass}   failed ${fail}`);
  await c.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("\nERROR:\n" + (e && e.stack || e)); process.exit(1); });
