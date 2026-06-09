// ════════════════════════════════════════════════════════════════════
//  ONBOARDING MODULE — onboarding.js
//
//  The operating truth: a takeover is a property where EVERYTHING starts
//  ASSUMED. This module builds the first load-bearing rung of the onboarding
//  funnel — the SECURITY-DEPOSIT CLAIM reconciliation.
//
//  Why deposits first: it's the highest-mass, UNGAMEABLE rung. The prior owner
//  SAYS it holds $X per tenant. An employee can't fake the proof — it either
//  ties to transferred cash or it doesn't. Get it wrong and the clearing
//  account is out of balance (the deposit-transfer SOP failure, at takeover
//  scale). This rung proves the whole funnel.
//
//  THE FLOW (mirrors movein: prepare → prove → approve, with a deferral exit):
//    1. POST /onboarding/runs                  → open a takeover run
//         (scenario + effective_date = the clock anchor).
//    2. POST /onboarding/runs/:id/deposit-claims → ingest claims. Each row is
//         a funnel item entering ASSUMED (status 'claimed'). No obligation yet.
//    3. POST /onboarding/runs/:id/reconcile-deposits → spawn ONE reconciliation
//         obligation per 'claimed' deposit. Accountant-owned, escalates to the
//         accountable PM. Idempotent (only 'claimed' picked up; flips to
//         'reconciling' + records spawned_obligation_id). Read-time trigger,
//         same as movein's process-due.
//         Required inputs:
//           cash_tie         — the UNGAMEABLE gate: confirmed_amount tied to cash
//           reconcile_signoff— the FINAL gate: accountable signer confirms
//    4. POST /onboarding/deposit-claims/:id/tie-out → record confirmed_amount.
//         If it matches claimed → satisfies cash_tie, status → (await signoff).
//         If it differs → status 'discrepancy', cash_tie still satisfied (the
//         tie is DONE — we know the truth — the variance is just surfaced).
//    5. POST /onboarding/deposit-claims/:id/signoff → accountable signer gives
//         reconcile_signoff. HARD RULE: refused until cash_tie is satisfied.
//         You cannot sign off a deposit nobody tied to cash. Completes the
//         obligation; claim status → 'confirmed'.
//    6. POST /onboarding/deposit-claims/:id/defer → the legitimate not-done
//         EXIT (the checklist's "intentionally deferred with owner approval").
//         Requires owner_approved_by. Completes the obligation as deferred;
//         claim status → 'deferred'. Counted, not lost — the dead-lead exit.
//
//  Accountant ties to cash. Accountable signer confirms. Owner can defer.
//  That's the rung.
//
//  Mount in server.js (two lines):
//    const onboardingModule = require("./onboarding");
//    app.use("/", onboardingModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
// ════════════════════════════════════════════════════════════════════

module.exports = function onboarding(deps) {
  const express = require("express");
  const router = express.Router();

  const { pool, spawnObligationFromEvent, satisfyObligation, completeObligation } = deps;
  if (!pool) throw new Error("onboarding module requires a pool");

  // the ungameable gate (proven by cash) and the final human sign-off behind it
  const CASH_GATE = "cash_tie";
  const SIGNOFF_GATE = "reconcile_signoff";
  const ALL_INPUTS = [CASH_GATE, SIGNOFF_GATE];

  // ── LEDGER rung (rung 2) ──────────────────────────────────────────
  // A ledger balance is NOT cash — it's the prior owner's claim of what a
  // tenant owes, reconciled against payment/charge history. Distinct gate
  // name so the two proofs are never conflated.
  const LEDGER_GATE = "ledger_tie";
  const LEDGER_SIGNOFF_GATE = "ledger_signoff";
  const LEDGER_ALL_INPUTS = [LEDGER_GATE, LEDGER_SIGNOFF_GATE];

  // org-chart role → obligations role_name enum (same bridge movein/turnover use)
  function mapRole(orgRole) {
    const map = { property_manager: "property_manager", maintenance: "maintenance",
      leasing: "leasing_agent", bookkeeper: "accountant", asset_manager: "asset_manager", owner: "owner" };
    return map[orgRole] || "property_manager";
  }

  // resolve the accountable signer (escalation + who may sign off). Falls back
  // to property_manager if no accountable owner is set on the property.
  async function resolveApprover(client, property_id) {
    const prop = await client.query("select accountable_assignment_id from properties where id=$1", [property_id]);
    const accId = prop.rows[0] ? prop.rows[0].accountable_assignment_id : null;
    if (accId) {
      const acc = await client.query("select role from assignments where id=$1 and is_active=true", [accId]);
      if (acc.rows.length) return mapRole(acc.rows[0].role);
    }
    return "property_manager";
  }

  // ════════════════════════════════════════════════════════════════
  //  OPEN A RUN  —  POST /onboarding/runs
  //  Body: { property_id (required), effective_date (required),
  //          scenario?, prior_manager?, notes? }
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/runs", async (req, res) => {
    const { property_id, effective_date, scenario = "management_only",
            prior_manager = null, notes = null } = req.body || {};
    if (!property_id) return res.status(400).json({ error: "property_id is required" });
    if (!effective_date) return res.status(400).json({ error: "effective_date is required (YYYY-MM-DD) — the clock anchor for every stage" });
    if (!["deed_transfer", "management_only"].includes(scenario)) {
      return res.status(400).json({ error: "scenario must be 'deed_transfer' or 'management_only'" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const p = await client.query("select id from properties where id=$1", [property_id]);
      if (p.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }

      const ins = await client.query(
        `insert into onboarding_runs (property_id, scenario, effective_date, prior_manager, notes)
         values ($1,$2,$3,$4,$5) returning *`,
        [property_id, scenario, effective_date, prior_manager, notes]
      );
      await client.query("commit");
      res.status(201).json({
        run: ins.rows[0],
        note: "Onboarding run opened. Every inherited fact for this property now starts ASSUMED. Ingest deposit claims next via POST /onboarding/runs/:id/deposit-claims.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("onboarding run create error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  INGEST DEPOSIT CLAIMS  —  POST /onboarding/runs/:id/deposit-claims
  //  Body: { claims: [ { claimed_amount (required), unit_id?, tenant_name? } ] }
  //  Each claim enters the funnel ASSUMED (status 'claimed'). NO obligation yet
  //  — reconciliation is spawned in a deliberate batch step, like movein.
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/runs/:id/deposit-claims", async (req, res) => {
    const run_id = req.params.id;
    const claims = Array.isArray(req.body?.claims) ? req.body.claims : null;
    if (!claims || claims.length === 0) {
      return res.status(400).json({ error: "claims[] is required — each { claimed_amount, unit_id?, tenant_name? }" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const runQ = await client.query("select * from onboarding_runs where id=$1", [run_id]);
      if (runQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "onboarding run not found" }); }
      const run = runQ.rows[0];

      const inserted = [];
      for (const c of claims) {
        const amt = Number(c.claimed_amount);
        if (!Number.isFinite(amt)) { await client.query("rollback"); return res.status(400).json({ error: "each claim needs a numeric claimed_amount", bad: c }); }
        const ins = await client.query(
          `insert into deposit_claims (onboarding_run_id, property_id, unit_id, tenant_name, claimed_amount, status)
           values ($1,$2,$3,$4,$5,'claimed') returning *`,
          [run_id, run.property_id, c.unit_id || null, c.tenant_name || null, amt]
        );
        inserted.push(ins.rows[0]);
      }
      await client.query("commit");

      const total = inserted.reduce((s, r) => s + Number(r.claimed_amount), 0);
      res.status(201).json({
        run_id, ingested: inserted.length,
        total_claimed: total,
        claims: inserted,
        note: "Deposit claims ingested as ASSUMED. None are proven yet. Spawn reconciliation obligations via POST /onboarding/runs/:id/reconcile-deposits.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("deposit-claims ingest error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  RECONCILE — spawn obligations  —  POST /onboarding/runs/:id/reconcile-deposits
  //  Spawns ONE reconciliation obligation per 'claimed' deposit. Accountant-owned,
  //  escalates to accountable PM. IDEMPOTENT: only 'claimed' picked up; flips to
  //  'reconciling' + records spawned_obligation_id.
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/runs/:id/reconcile-deposits", async (req, res) => {
    const run_id = req.params.id;

    const client = await pool.connect();
    try {
      await client.query("begin");
      const runQ = await client.query("select * from onboarding_runs where id=$1 for update", [run_id]);
      if (runQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "onboarding run not found" }); }
      const run = runQ.rows[0];

      const claimed = await client.query(
        `select * from deposit_claims where onboarding_run_id=$1 and status='claimed' for update`,
        [run_id]
      );

      const approver = await resolveApprover(client, run.property_id);
      const spawned = [];
      for (const dc of claimed.rows) {
        const obligation = await spawnObligationFromEvent(client, {
          property_id: dc.property_id,
          unit_id: dc.unit_id,
          related_id: dc.id,
          related_type: "deposit_claim",
          module: "onboarding",
          type: "deposit_reconciliation",
          label: `Reconcile security deposit${dc.tenant_name ? " — " + dc.tenant_name : ""} (claimed ${Number(dc.claimed_amount).toFixed(2)})`,
          owner_type: "human",
          assigned_role: "accountant",      // accounting ties to cash
          escalates_to_role: approver,      // accountable PM (or PM fallback)
          status: "open",
          priority: "high",                 // deposits are highest-mass at takeover
          severity: "normal",
          due_at: run.effective_date ? new Date(run.effective_date) : null,
          required_inputs: ALL_INPUTS,
        });

        await client.query(
          `update deposit_claims set status='reconciling', spawned_obligation_id=$1, updated_at=now() where id=$2`,
          [obligation.id, dc.id]
        );

        spawned.push({ deposit_claim_id: dc.id, unit_id: dc.unit_id, tenant_name: dc.tenant_name,
          claimed_amount: dc.claimed_amount, obligation_id: obligation.id,
          assigned_role: "accountant", approver_role: approver });
      }

      await client.query("commit");
      res.json({
        run_id, processed: spawned.length, spawned,
        note: spawned.length
          ? "Spawned deposit-reconciliation obligations. Accounting ties each to cash (cash_tie); the accountable signer gives reconcile_signoff (gated behind the tie)."
          : "No unreconciled deposit claims. Nothing to spawn.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("reconcile-deposits error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  TIE OUT TO CASH  —  POST /onboarding/deposit-claims/:id/tie-out
  //  Body: { confirmed_amount (required), proof? }
  //  Records what actually tied to cash. Satisfies the UNGAMEABLE cash_tie gate.
  //  If confirmed != claimed → claim status 'discrepancy' (variance surfaced),
  //  but the tie is still DONE (we now KNOW the truth). If equal → on track to
  //  confirmed once signed off.
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/deposit-claims/:id/tie-out", async (req, res) => {
    const claim_id = req.params.id;
    const { confirmed_amount, proof = null } = req.body || {};
    const amt = Number(confirmed_amount);
    if (!Number.isFinite(amt)) return res.status(400).json({ error: "confirmed_amount (numeric) is required — what actually tied to cash" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const dcQ = await client.query("select * from deposit_claims where id=$1 for update", [claim_id]);
      if (dcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "deposit claim not found" }); }
      const dc = dcQ.rows[0];
      if (!dc.spawned_obligation_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "this claim has no reconciliation obligation yet — run POST /onboarding/runs/:id/reconcile-deposits first" });
      }

      const matches = Number(dc.claimed_amount) === amt;
      const newStatus = matches ? "reconciling" : "discrepancy"; // stays reconciling until signoff; discrepancy is surfaced
      await client.query(
        `update deposit_claims set confirmed_amount=$1, status=$2, proof=$3, updated_at=now() where id=$4`,
        [amt, newStatus, (proof == null ? null : (typeof proof === "string" ? proof : JSON.stringify(proof))), claim_id]
      );

      // satisfy the ungameable cash gate (shared helper). Idempotent on re-tie.
      let note = "Cash tie recorded.";
      try {
        await satisfyObligation(client, {
          obligation_id: dc.spawned_obligation_id, input: CASH_GATE,
          proof: { claimed: Number(dc.claimed_amount), confirmed: amt, variance: Number(dc.claimed_amount) - amt, detail: proof },
        });
      } catch (e) {
        if (e.code === "NOT_OUTSTANDING") note = "Cash tie was already recorded (updated amount).";
        else if (e.code === "NOT_FOUND") { await client.query("rollback"); return res.status(404).json({ error: "linked obligation not found" }); }
        else throw e;
      }

      await client.query("commit");
      res.json({
        deposit_claim_id: claim_id,
        claimed_amount: Number(dc.claimed_amount),
        confirmed_amount: amt,
        variance: Number(dc.claimed_amount) - amt,
        matches,
        claim_status: newStatus,
        note: matches
          ? `${note} Claim ties exactly. Awaiting reconcile_signoff.`
          : `${note} DISCREPANCY surfaced (variance ${(Number(dc.claimed_amount) - amt).toFixed(2)}). The tie is done — the truth is known — but a signer must confirm or the claim can be deferred with owner approval.`,
      });
    } catch (e) {
      await client.query("rollback");
      console.error("tie-out error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  SIGN OFF  —  POST /onboarding/deposit-claims/:id/signoff
  //  Body: { signed_by_person_id (required), note? }
  //  Final human confirmation. HARD RULE: refused (409) until cash_tie is
  //  satisfied — you cannot sign off a deposit nobody tied to cash. On signoff:
  //  satisfies reconcile_signoff, completes the obligation, claim → 'confirmed'.
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/deposit-claims/:id/signoff", async (req, res) => {
    const claim_id = req.params.id;
    const { signed_by_person_id, note: signNote = null } = req.body || {};
    if (!signed_by_person_id) return res.status(400).json({ error: "signed_by_person_id required — a human must sign off the reconciliation" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const dcQ = await client.query("select * from deposit_claims where id=$1 for update", [claim_id]);
      if (dcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "deposit claim not found" }); }
      const dc = dcQ.rows[0];
      if (!dc.spawned_obligation_id) { await client.query("rollback"); return res.status(409).json({ error: "no reconciliation obligation on this claim yet" }); }

      const oQ = await client.query("select * from obligations where id=$1 for update", [dc.spawned_obligation_id]);
      if (oQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "linked obligation not found" }); }
      const outstanding = oQ.rows[0].required_inputs || [];

      // HARD GATE: cash must be tied before sign-off.
      if (outstanding.includes(CASH_GATE)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "cannot sign off — deposit not yet tied to cash",
          hint: "record the tie first via POST /onboarding/deposit-claims/:id/tie-out",
        });
      }

      try {
        await satisfyObligation(client, {
          obligation_id: dc.spawned_obligation_id, input: SIGNOFF_GATE,
          proof: { signed_by_person_id, note: signNote },
        });
      } catch (e) {
        if (e.code !== "NOT_OUTSTANDING") throw e; // already signed → fall through to complete
      }

      let completedNote;
      try {
        await completeObligation(client, { obligation_id: dc.spawned_obligation_id, completed_by: signed_by_person_id });
        completedNote = "Reconciliation obligation COMPLETE — verified record that this deposit ties to cash.";
      } catch (e) {
        if (e.code === "ALREADY_COMPLETE") completedNote = "Obligation was already complete.";
        else if (e.code === "INPUTS_OUTSTANDING") { await client.query("rollback"); return res.status(409).json({ error: "unexpected outstanding inputs after signoff", outstanding: e.outstanding_inputs }); }
        else throw e;
      }

      await client.query(
        `update deposit_claims set status='confirmed', updated_at=now() where id=$1`, [claim_id]
      );

      await client.query("commit");
      res.json({
        deposit_claim_id: claim_id,
        claim_status: "confirmed",
        signed_by_person_id,
        variance: dc.confirmed_amount == null ? null : Number(dc.claimed_amount) - Number(dc.confirmed_amount),
        obligation_note: completedNote,
        note: "Deposit confirmed: assumed → proven. One claim out the bottom of the funnel.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("signoff error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  DEFER (the legitimate not-done EXIT)  —  POST /onboarding/deposit-claims/:id/defer
  //  Body: { owner_approved_by (required), reason? }
  //  The checklist's "intentionally deferred with owner approval." Completes the
  //  obligation as deferred; claim → 'deferred'. Counted, not lost.
  // ════════════════════════════════════════════════════════════════
  router.post("/onboarding/deposit-claims/:id/defer", async (req, res) => {
    const claim_id = req.params.id;
    const { owner_approved_by, reason = null } = req.body || {};
    if (!owner_approved_by) return res.status(400).json({ error: "owner_approved_by required — deferral is an owner-approved exit, not a skip" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const dcQ = await client.query("select * from deposit_claims where id=$1 for update", [claim_id]);
      if (dcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "deposit claim not found" }); }
      const dc = dcQ.rows[0];

      // Deferral is an HONEST exit, not fake proof. We do NOT loop
      // satisfyObligation (that would write input_satisfied events claiming
      // inputs were provided when they were waived). Instead: clear the
      // required_inputs in ONE update that records the waiver as a durable
      // event, then call completeObligation so the real completion event +
      // completed_at still fire through the shared helper.
      if (dc.spawned_obligation_id) {
        const oQ = await client.query("select * from obligations where id=$1 for update", [dc.spawned_obligation_id]);
        if (oQ.rows.length) {
          const ob = oQ.rows[0];
          if (ob.status !== "complete") {
            const waived = ob.required_inputs || [];
            // one truthful event: these inputs were WAIVED by owner, not satisfied
            await client.query(
              `insert into events (property_id, person_id, unit_id, type, note)
               values ($1,$2,$3,'inputs_waived_for_deferral',$4)`,
              [ob.property_id, ob.person_id, ob.unit_id,
               `deposit reconciliation deferred by ${owner_approved_by}; inputs waived: ${waived.join(", ") || "none"}${reason ? "; reason: " + reason : ""}`]
            );
            // clear inputs so the proof gate passes, then complete via shared helper
            await client.query(
              `update obligations set required_inputs = '{}', updated_at = now() where id = $1`,
              [dc.spawned_obligation_id]
            );
            try {
              await completeObligation(client, { obligation_id: dc.spawned_obligation_id, completed_by: owner_approved_by });
            } catch (e) {
              if (e.code !== "ALREADY_COMPLETE") throw e;
            }
          }
        }
      }

      await client.query(
        `update deposit_claims set status='deferred', proof=$1, updated_at=now() where id=$2`,
        [JSON.stringify({ deferred: true, owner_approved_by, reason }), claim_id]
      );

      await client.query("commit");
      res.json({
        deposit_claim_id: claim_id, claim_status: "deferred", owner_approved_by,
        note: "Deferred with owner approval — the legitimate exit. Counted, not lost. It leaves the active funnel but stays on the record.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("defer error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  BOARD  —  GET /onboarding/runs/:id/deposits
  //  The funnel view: every claim, where it sits, the spread top-to-bottom.
  // ════════════════════════════════════════════════════════════════
  router.get("/onboarding/runs/:id/deposits", async (req, res) => {
    const run_id = req.params.id;
    try {
      const runQ = await pool.query("select * from onboarding_runs where id=$1", [run_id]);
      if (runQ.rows.length === 0) return res.status(404).json({ error: "onboarding run not found" });

      const r = await pool.query(
        `select dc.*, o.status as obligation_status, o.required_inputs as obligation_outstanding
           from deposit_claims dc
           left join obligations o on o.id = dc.spawned_obligation_id
          where dc.onboarding_run_id=$1
          order by dc.created_at asc`,
        [run_id]
      );

      const claims = r.rows;
      const totalClaimed   = claims.reduce((s, c) => s + Number(c.claimed_amount), 0);
      const totalConfirmed = claims.reduce((s, c) => s + (c.confirmed_amount == null ? 0 : Number(c.confirmed_amount)), 0);
      const byStatus = claims.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {});

      // ── THE BOARD RULE (reusable across every rung) ──────────────────
      // The gate is GROSS unproven exposure, never net. Net can hide problems:
      // offsetting errors cancel to ~0 while the property is still a mess —
      // the exact anti-Mark failure. Two honest buckets, different operator
      // actions:
      //   known_error_exposure = tied-but-mismatched (discrepancy): sum |variance|.
      //     "we checked and found an error."
      //   untied_exposure      = not yet reconciled (claimed|reconciling):
      //     full claimed amount. "we have NOT proven this." (the Mark risk —
      //     things sitting mid-funnel pretending to be done are NOT neutral.)
      // deferred = owner-approved exit, left the funnel, NOT exposure.
      let known_error_exposure = 0, untied_exposure = 0, confirmed_clean = 0;
      for (const c of claims) {
        const claimed = Number(c.claimed_amount);
        const conf = c.confirmed_amount == null ? null : Number(c.confirmed_amount);
        if (c.status === "confirmed") confirmed_clean += claimed;
        else if (c.status === "discrepancy") known_error_exposure += Math.abs(claimed - (conf == null ? 0 : conf));
        else if (c.status === "deferred") { /* exited, not exposure */ }
        else untied_exposure += Math.abs(claimed); // claimed | reconciling = unproven
      }
      const gross_unproven_exposure = known_error_exposure + untied_exposure;

      res.json({
        run: runQ.rows[0],
        funnel: {
          total_claims: claims.length,
          by_status: byStatus,
          // HEADLINE — the truth signal. Clean ONLY when actually proven.
          gross_unproven_exposure,
          fully_clean: gross_unproven_exposure === 0,
          // the two buckets, because they demand different action
          known_error_exposure,   // checked, found wrong
          untied_exposure,        // not yet proven (the Mark risk)
          confirmed_clean,
          discrepancies: claims.filter(c => c.status === "discrepancy").length,
          unreconciled_count: claims.filter(c => !["confirmed", "deferred"].includes(c.status)).length,
          // SECONDARY CONTEXT ONLY — never the gate. Can read ~0 on offsetting errors.
          total_claimed: totalClaimed,
          total_confirmed: totalConfirmed,
          net_spread: totalClaimed - totalConfirmed,
        },
        claims: claims.map(c => ({
          id: c.id, unit_id: c.unit_id, tenant_name: c.tenant_name,
          claimed_amount: Number(c.claimed_amount),
          confirmed_amount: c.confirmed_amount == null ? null : Number(c.confirmed_amount),
          variance: c.variance == null ? null : Number(c.variance),
          status: c.status,
          obligation_id: c.spawned_obligation_id,
          obligation_status: c.obligation_status,
          obligation_outstanding: c.obligation_outstanding || [],
        })),
        note: "Funnel view. HEADLINE is gross_unproven_exposure (known errors + not-yet-proven), the truth signal — clean only when actually proven, never when problems cancel. net_spread is secondary context and can mislead on offsetting errors.",
      });
    } catch (e) {
      console.error("deposits board error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  RUNG 2 — OPENING-BALANCE / LEDGER RECONCILIATION
  //  Same funnel as deposits, different proof. A ledger balance is the prior
  //  owner's claim of what a tenant owes; the proof is reconciliation against
  //  payment/charge history (NOT cash in an account). Signed balances:
  //  + = arrears (tenant owes), - = credit (owed to tenant).
  // ══════════════════════════════════════════════════════════════════

  // ── INGEST LEDGER CLAIMS  —  POST /onboarding/runs/:id/ledger-claims
  //  Body: { sign_convention?, claims: [ { claimed_balance (required, signed), unit_id?, tenant_name? } ] }
  //  Each enters ASSUMED (status 'claimed'). No obligation yet. sign_convention
  //  is captured PER SOURCE (default arrears_positive, matching the 4125 Yardi
  //  roll) — never hardcoded, because other exports invert it.
  router.post("/onboarding/runs/:id/ledger-claims", async (req, res) => {
    const run_id = req.params.id;
    const claims = Array.isArray(req.body?.claims) ? req.body.claims : null;
    const sign_convention = req.body?.sign_convention || "arrears_positive";
    if (!["arrears_positive", "arrears_negative"].includes(sign_convention)) {
      return res.status(400).json({ error: "sign_convention must be 'arrears_positive' or 'arrears_negative' — confirm which this source uses" });
    }
    if (!claims || claims.length === 0) {
      return res.status(400).json({ error: "claims[] is required — each { claimed_balance, unit_id?, tenant_name? }. claimed_balance is signed: + arrears, - credit." });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const runQ = await client.query("select * from onboarding_runs where id=$1", [run_id]);
      if (runQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "onboarding run not found" }); }
      const run = runQ.rows[0];

      const inserted = [];
      for (const c of claims) {
        const bal = Number(c.claimed_balance);
        if (!Number.isFinite(bal)) { await client.query("rollback"); return res.status(400).json({ error: "each claim needs a numeric claimed_balance (signed)", bad: c }); }
        const ins = await client.query(
          `insert into ledger_claims (onboarding_run_id, property_id, unit_id, tenant_name, claimed_balance, sign_convention, status)
           values ($1,$2,$3,$4,$5,$6,'claimed') returning *`,
          [run_id, run.property_id, c.unit_id || null, c.tenant_name || null, bal, sign_convention]
        );
        inserted.push(ins.rows[0]);
      }
      await client.query("commit");

      const total = inserted.reduce((s, r) => s + Number(r.claimed_balance), 0);
      res.status(201).json({
        run_id, ingested: inserted.length, sign_convention, total_claimed_balance: total, claims: inserted,
        note: `Ledger balance claims ingested as ASSUMED (sign_convention: ${sign_convention}). None reconciled yet. Spawn obligations via POST /onboarding/runs/:id/reconcile-ledgers.`,
      });
    } catch (e) {
      await client.query("rollback");
      console.error("ledger-claims ingest error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── RECONCILE — spawn obligations  —  POST /onboarding/runs/:id/reconcile-ledgers
  //  One accountant-owned obligation per 'claimed' ledger. Idempotent.
  router.post("/onboarding/runs/:id/reconcile-ledgers", async (req, res) => {
    const run_id = req.params.id;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const runQ = await client.query("select * from onboarding_runs where id=$1 for update", [run_id]);
      if (runQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "onboarding run not found" }); }
      const run = runQ.rows[0];

      const claimed = await client.query(
        `select * from ledger_claims where onboarding_run_id=$1 and status='claimed' for update`,
        [run_id]
      );

      const approver = await resolveApprover(client, run.property_id);
      const spawned = [];
      for (const lc of claimed.rows) {
        const obligation = await spawnObligationFromEvent(client, {
          property_id: lc.property_id,
          unit_id: lc.unit_id,
          related_id: lc.id,
          related_type: "ledger_claim",
          module: "onboarding",
          type: "ledger_reconciliation",
          label: `Reconcile tenant ledger${lc.tenant_name ? " — " + lc.tenant_name : ""} (claimed ${Number(lc.claimed_balance).toFixed(2)})`,
          owner_type: "human",
          assigned_role: "accountant",
          escalates_to_role: approver,
          status: "open",
          priority: "high",                 // opening balances are high-mass at takeover
          severity: "normal",
          due_at: run.effective_date ? new Date(run.effective_date) : null,
          required_inputs: LEDGER_ALL_INPUTS,
        });

        await client.query(
          `update ledger_claims set status='reconciling', spawned_obligation_id=$1, updated_at=now() where id=$2`,
          [obligation.id, lc.id]
        );

        spawned.push({ ledger_claim_id: lc.id, unit_id: lc.unit_id, tenant_name: lc.tenant_name,
          claimed_balance: lc.claimed_balance, obligation_id: obligation.id,
          assigned_role: "accountant", approver_role: approver });
      }

      await client.query("commit");
      res.json({
        run_id, processed: spawned.length, spawned,
        note: spawned.length
          ? "Spawned ledger-reconciliation obligations. Accounting reconciles each against payment/charge history (ledger_tie); the accountable signer gives ledger_signoff (gated behind the tie)."
          : "No unreconciled ledger claims. Nothing to spawn.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("reconcile-ledgers error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── RECONCILE A LEDGER  —  POST /onboarding/ledger-claims/:id/tie-out
  //  Body: { confirmed_balance (required, signed), proof? }
  //  Records the TRUE balance after reconciliation. Satisfies ledger_tie.
  //  Match → on track; differ → status 'discrepancy' (variance surfaced; the
  //  reconciliation is still DONE — the truth is now known).
  // ── RECONCILE A LEDGER  —  POST /onboarding/ledger-claims/:id/tie-out
  //  Body: { confirmed_balance (required, signed), components?, proof? }
  //  Records the TRUE balance after reconciliation. Satisfies ledger_tie.
  //  Match → on track; differ → status 'discrepancy' (variance surfaced).
  //
  //  components (optional but recommended): the per-bucket reconciled detail,
  //  e.g. { "rent": 1200, "parking": 50, "utilities": 0, "late_fees": 75,
  //         "prepaid_credit": -200 }. A real Yardi balance is a roll-up of these
  //  GL accounts; without the breakdown a variance says "off by $300" but not
  //  WHICH bucket — useless to the operator. If components are given, their sum
  //  must equal confirmed_balance (we validate) so the breakdown can't silently
  //  disagree with the total.
  router.post("/onboarding/ledger-claims/:id/tie-out", async (req, res) => {
    const claim_id = req.params.id;
    const { confirmed_balance, components = null, proof = null } = req.body || {};
    const bal = Number(confirmed_balance);
    if (!Number.isFinite(bal)) return res.status(400).json({ error: "confirmed_balance (numeric, signed) is required — the TRUE balance after reconciliation" });

    // If a breakdown is provided, it must reconcile to the total. Penny-tolerant.
    let componentsClean = null;
    if (components != null) {
      if (typeof components !== "object" || Array.isArray(components)) {
        return res.status(400).json({ error: "components must be an object of bucket:amount, e.g. { rent: 1200, late_fees: 75 }" });
      }
      componentsClean = {};
      let sum = 0;
      for (const [k, v] of Object.entries(components)) {
        const n = Number(v);
        if (!Number.isFinite(n)) return res.status(400).json({ error: `component "${k}" must be numeric`, bad: { [k]: v } });
        componentsClean[k] = n;
        sum += n;
      }
      if (Math.abs(sum - bal) > 0.01) {
        return res.status(400).json({
          error: "component breakdown does not sum to confirmed_balance",
          components_sum: Number(sum.toFixed(2)), confirmed_balance: bal,
          hint: "the per-bucket amounts must add up to the reconciled total",
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const lcQ = await client.query("select * from ledger_claims where id=$1 for update", [claim_id]);
      if (lcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "ledger claim not found" }); }
      const lc = lcQ.rows[0];
      if (!lc.spawned_obligation_id) {
        await client.query("rollback");
        return res.status(409).json({ error: "this claim has no reconciliation obligation yet — run POST /onboarding/runs/:id/reconcile-ledgers first" });
      }

      const matches = Number(lc.claimed_balance) === bal;
      const newStatus = matches ? "reconciling" : "discrepancy";
      await client.query(
        `update ledger_claims set confirmed_balance=$1, confirmed_components=$2, status=$3, proof=$4, updated_at=now() where id=$5`,
        [bal,
         componentsClean == null ? null : JSON.stringify(componentsClean),
         newStatus,
         (proof == null ? null : (typeof proof === "string" ? proof : JSON.stringify(proof))),
         claim_id]
      );

      let note = "Ledger reconciliation recorded.";
      try {
        await satisfyObligation(client, {
          obligation_id: lc.spawned_obligation_id, input: LEDGER_GATE,
          proof: { claimed: Number(lc.claimed_balance), confirmed: bal, variance: Number(lc.claimed_balance) - bal, components: componentsClean, detail: proof },
        });
      } catch (e) {
        if (e.code === "NOT_OUTSTANDING") note = "Ledger tie was already recorded (updated balance).";
        else if (e.code === "NOT_FOUND") { await client.query("rollback"); return res.status(404).json({ error: "linked obligation not found" }); }
        else throw e;
      }

      await client.query("commit");

      const variance = Number(lc.claimed_balance) - bal;
      // When there's a discrepancy and we have a breakdown, surface the buckets
      // ranked by magnitude — that's the "where is the problem" answer.
      let component_breakdown = null;
      if (componentsClean) {
        component_breakdown = Object.entries(componentsClean)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .map(([bucket, amount]) => ({ bucket, amount }));
      }

      res.json({
        ledger_claim_id: claim_id,
        claimed_balance: Number(lc.claimed_balance),
        confirmed_balance: bal,
        variance,
        matches,
        claim_status: newStatus,
        component_breakdown,
        components_note: componentsClean
          ? "Reconciled with a per-bucket breakdown — a discrepancy can be traced to the bucket carrying it."
          : "Reconciled at NET level only. Provide components next time to make a discrepancy actionable (which bucket is off).",
        note: matches
          ? `${note} Ledger ties exactly. Awaiting ledger_signoff.`
          : `${note} DISCREPANCY surfaced (variance ${variance.toFixed(2)}). The reconciliation is done — the truth is known — but a signer must confirm or the claim can be deferred with owner approval.`,
      });
    } catch (e) {
      await client.query("rollback");
      console.error("ledger tie-out error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── SIGN OFF  —  POST /onboarding/ledger-claims/:id/signoff
  //  Body: { signed_by_person_id (required), note? }
  //  HARD RULE: refused (409) until ledger_tie satisfied. Completes; → 'confirmed'.
  router.post("/onboarding/ledger-claims/:id/signoff", async (req, res) => {
    const claim_id = req.params.id;
    const { signed_by_person_id, note: signNote = null } = req.body || {};
    if (!signed_by_person_id) return res.status(400).json({ error: "signed_by_person_id required — a human must sign off the reconciliation" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const lcQ = await client.query("select * from ledger_claims where id=$1 for update", [claim_id]);
      if (lcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "ledger claim not found" }); }
      const lc = lcQ.rows[0];
      if (!lc.spawned_obligation_id) { await client.query("rollback"); return res.status(409).json({ error: "no reconciliation obligation on this claim yet" }); }

      const oQ = await client.query("select * from obligations where id=$1 for update", [lc.spawned_obligation_id]);
      if (oQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "linked obligation not found" }); }
      const outstanding = oQ.rows[0].required_inputs || [];

      if (outstanding.includes(LEDGER_GATE)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "cannot sign off — ledger not yet reconciled",
          hint: "reconcile first via POST /onboarding/ledger-claims/:id/tie-out",
        });
      }

      try {
        await satisfyObligation(client, {
          obligation_id: lc.spawned_obligation_id, input: LEDGER_SIGNOFF_GATE,
          proof: { signed_by_person_id, note: signNote },
        });
      } catch (e) {
        if (e.code !== "NOT_OUTSTANDING") throw e;
      }

      let completedNote;
      try {
        await completeObligation(client, { obligation_id: lc.spawned_obligation_id, completed_by: signed_by_person_id });
        completedNote = "Ledger reconciliation obligation COMPLETE — verified record of the true tenant balance.";
      } catch (e) {
        if (e.code === "ALREADY_COMPLETE") completedNote = "Obligation was already complete.";
        else if (e.code === "INPUTS_OUTSTANDING") { await client.query("rollback"); return res.status(409).json({ error: "unexpected outstanding inputs after signoff", outstanding: e.outstanding_inputs }); }
        else throw e;
      }

      await client.query(`update ledger_claims set status='confirmed', updated_at=now() where id=$1`, [claim_id]);

      await client.query("commit");
      res.json({
        ledger_claim_id: claim_id, claim_status: "confirmed", signed_by_person_id,
        variance: lc.confirmed_balance == null ? null : Number(lc.claimed_balance) - Number(lc.confirmed_balance),
        obligation_note: completedNote,
        note: "Ledger confirmed: assumed → proven. One balance out the bottom of the funnel.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("ledger signoff error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── DEFER (owner-approved exit)  —  POST /onboarding/ledger-claims/:id/defer
  //  Body: { owner_approved_by (required), reason? }
  //  Honest waiver event (NOT fake satisfaction), then complete; → 'deferred'.
  router.post("/onboarding/ledger-claims/:id/defer", async (req, res) => {
    const claim_id = req.params.id;
    const { owner_approved_by, reason = null } = req.body || {};
    if (!owner_approved_by) return res.status(400).json({ error: "owner_approved_by required — deferral is an owner-approved exit, not a skip" });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const lcQ = await client.query("select * from ledger_claims where id=$1 for update", [claim_id]);
      if (lcQ.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "ledger claim not found" }); }
      const lc = lcQ.rows[0];

      if (lc.spawned_obligation_id) {
        const oQ = await client.query("select * from obligations where id=$1 for update", [lc.spawned_obligation_id]);
        if (oQ.rows.length) {
          const ob = oQ.rows[0];
          if (ob.status !== "complete") {
            const waived = ob.required_inputs || [];
            await client.query(
              `insert into events (property_id, person_id, unit_id, type, note)
               values ($1,$2,$3,'inputs_waived_for_deferral',$4)`,
              [ob.property_id, ob.person_id, ob.unit_id,
               `ledger reconciliation deferred by ${owner_approved_by}; inputs waived: ${waived.join(", ") || "none"}${reason ? "; reason: " + reason : ""}`]
            );
            await client.query(`update obligations set required_inputs = '{}', updated_at = now() where id = $1`, [lc.spawned_obligation_id]);
            try {
              await completeObligation(client, { obligation_id: lc.spawned_obligation_id, completed_by: owner_approved_by });
            } catch (e) {
              if (e.code !== "ALREADY_COMPLETE") throw e;
            }
          }
        }
      }

      await client.query(
        `update ledger_claims set status='deferred', proof=$1, updated_at=now() where id=$2`,
        [JSON.stringify({ deferred: true, owner_approved_by, reason }), claim_id]
      );

      await client.query("commit");
      res.json({
        ledger_claim_id: claim_id, claim_status: "deferred", owner_approved_by,
        note: "Deferred with owner approval — the legitimate exit. Counted, not lost.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("ledger defer error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ── BOARD  —  GET /onboarding/runs/:id/ledgers
  //  The funnel view: claimed (assumed) vs confirmed (reconciled), the spread.
  router.get("/onboarding/runs/:id/ledgers", async (req, res) => {
    const run_id = req.params.id;
    try {
      const runQ = await pool.query("select * from onboarding_runs where id=$1", [run_id]);
      if (runQ.rows.length === 0) return res.status(404).json({ error: "onboarding run not found" });

      const r = await pool.query(
        `select lc.*, o.status as obligation_status, o.required_inputs as obligation_outstanding
           from ledger_claims lc
           left join obligations o on o.id = lc.spawned_obligation_id
          where lc.onboarding_run_id=$1
          order by lc.created_at asc`,
        [run_id]
      );

      const claims = r.rows;
      const totalClaimed   = claims.reduce((s, c) => s + Number(c.claimed_balance), 0);
      const totalConfirmed = claims.reduce((s, c) => s + (c.confirmed_balance == null ? 0 : Number(c.confirmed_balance)), 0);
      const byStatus = claims.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {});

      // ── THE BOARD RULE (same as deposits — gross is the gate, never net) ──
      // Ledger balances are SIGNED (+ arrears, - credit), which makes netting
      // EVEN more dangerous: a big credit and a big arrears cancel to ~0. So
      // exposure uses absolute values. Two buckets:
      //   known_error_exposure = tied-but-mismatched: sum |variance|.
      //   untied_exposure      = not reconciled yet: |claimed_balance| (the
      //                          magnitude that's still unproven, either sign).
      let known_error_exposure = 0, untied_exposure = 0, confirmed_count = 0;
      for (const c of claims) {
        const claimed = Number(c.claimed_balance);
        const conf = c.confirmed_balance == null ? null : Number(c.confirmed_balance);
        if (c.status === "confirmed") confirmed_count += 1;
        else if (c.status === "discrepancy") known_error_exposure += Math.abs(claimed - (conf == null ? 0 : conf));
        else if (c.status === "deferred") { /* exited, not exposure */ }
        else untied_exposure += Math.abs(claimed);
      }
      const gross_unproven_exposure = known_error_exposure + untied_exposure;

      res.json({
        run: runQ.rows[0],
        funnel: {
          total_claims: claims.length,
          by_status: byStatus,
          // HEADLINE — truth signal. Clean only when actually proven.
          gross_unproven_exposure,
          fully_clean: gross_unproven_exposure === 0,
          known_error_exposure,   // checked, found wrong
          untied_exposure,        // not yet proven (the Mark risk)
          confirmed_count,
          discrepancies: claims.filter(c => c.status === "discrepancy").length,
          unreconciled_count: claims.filter(c => !["confirmed", "deferred"].includes(c.status)).length,
          // SECONDARY CONTEXT ONLY — signed, nets, can mislead. Never the gate.
          total_claimed_balance: totalClaimed,
          total_confirmed_balance: totalConfirmed,
          net_spread: totalClaimed - totalConfirmed,
        },
        claims: claims.map(c => ({
          id: c.id, unit_id: c.unit_id, tenant_name: c.tenant_name,
          claimed_balance: Number(c.claimed_balance),
          confirmed_balance: c.confirmed_balance == null ? null : Number(c.confirmed_balance),
          variance: c.variance == null ? null : Number(c.variance),
          status: c.status,
          obligation_id: c.spawned_obligation_id,
          obligation_status: c.obligation_status,
          obligation_outstanding: c.obligation_outstanding || [],
        })),
        note: "Funnel view. HEADLINE is gross_unproven_exposure (uses absolute values — signed balances make netting especially deceptive). net_spread is secondary context only.",
      });
    } catch (e) {
      console.error("ledgers board error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
