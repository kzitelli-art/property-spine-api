/* ════════════════════════════════════════════════════════════════════
   THE FAULT SHIM — loaded with `--require`, BEFORE the train

   This file exists so that `falsify_train_composition.js` can prove the
   train's composition check is capable of going red. It is loaded into
   the child process ahead of `rehearse_release_train.js`, mutates the
   train's DEPENDENCIES, and then gets out of the way.

   ── WHY A SHIM AND NOT A FLAG IN THE TRAIN ──────────────────────────

   The alternative is an `if (process.env.TRAIN_FAULT)` branch inside the
   rehearsal itself, which would ship fault-injection scaffolding into the
   artifact that is supposed to be the evidence. The train that runs under
   this shim is BYTE-IDENTICAL to the train that runs in the rehearsal.
   Nothing here is reachable unless TRAIN_FAULT is set, and the driver is
   the only thing that sets it.

   ── WHAT EVERY FAULT DOES FIRST ─────────────────────────────────────

   A divergence needs something to diverge ABOUT, so every variant first
   manufactures one real invariant violation inside the train's own
   population, at the only moment where that is possible: immediately
   after the activation commits, with the guard triggers dropped the way
   an operator at a psql prompt could drop them.

   Then each variant blinds exactly one of the two witnesses, and the
   train is expected to notice.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const FAULT = process.env.TRAIN_FAULT;
if (FAULT) {
  const path = require("path");
  const ROOT = path.join(__dirname, "..", "..");
  const activation = require(path.join(ROOT, "src/release0/activation_service.js"));
  const reader = require(path.join(ROOT, "src/surfaces/work_order_status_read.js"));
  const guardWindow = require(path.join(ROOT, "tools/step12/guard_window.js"));

  const realRecord = activation.recordActivation;

  activation.recordActivation = async function patched(client, opts) {
    const out = await realRecord.call(this, client, opts);

    //  Drop the guard, exactly as `prove_boundary_reversibility` B7b.3
    //  measured it can be dropped. DDL inside the activation's own
    //  transaction, so the deferred check never fires at COMMIT.
    for (const [n, t] of guardWindow.TRIGGERS) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`drop trigger if exists ${n} on public.${t}`);
    }

    //  One hollow completion: terminal, no evaluation, no evidence. It
    //  joins the train's own population so `oneTruth` is looking at it.
    const prop = (await client.query(
      `select property_id from work_orders where source='trainproof' limit 1`)).rows[0];
    await client.query(
      `insert into work_orders (id, property_id, title, status, source)
       values (gen_random_uuid(), $1, 'INJECTED hollow completion', 'complete', 'trainproof')`,
      [prop.property_id]);

    if (FAULT === "audit-blind") {
      //  The DATABASE stops reporting the violation. The reader still does.
      //  This is the shape where a "clean audit" is the lie.
      //  DROP then CREATE, not CREATE OR REPLACE: replacing a view cannot
      //  drop columns, and the real view has five. The first version of
      //  this shim crashed the train instead of blinding it, which looked
      //  exactly like a detection and was not one.
      await client.query(
        `drop view public.release_0_completion_invariant_violations`);
      await client.query(
        `create view public.release_0_completion_invariant_violations as
           select null::uuid as work_order_id, null::uuid as property_id,
                  null::text as status, null::text as proof_status,
                  null::text as violation
            where false`);
    }

    return out;
  };

  if (FAULT === "reader-blind") {
    //  The READER stops reporting the violation. The database still does.
    //  This is the shape where a green surface is the lie — and it is the
    //  one an operator would actually believe, because the surface is what
    //  they look at.
    const realRead = reader.readWorkOrderStatus;
    reader.readWorkOrderStatus = async function patched(...args) {
      const s = await realRead.apply(this, args);
      if (s && s.proof && s.proof.state === "missing_evaluation_defect") {
        return { ...s, proof: { ...s.proof, state: "satisfied", satisfied: true } };
      }
      return s;
    };
  }

  process.stderr.write(`[fault shim] TRAIN_FAULT=${FAULT} armed\n`);
}
