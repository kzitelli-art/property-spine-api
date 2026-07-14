// =============================================================
// applications.js — the application record + the binding countersign wall.
//
//   This is the spine of the application rung. It does NOT generate a
//   lease document and does NOT capture a legally-binding signature —
//   those wait on the real lease template and a legal answer on e-sign,
//   and land as a separate rung. What this builds is the part that is
//   safe to build now and carries all the structural value:
//
//     • an application is a REAL row (the operator Gate's list/buttons
//       finally have a source — no more provisional summary count);
//     • the lifecycle is born through the SHARED obligation engine
//       (spawnObligationFromEvent / satisfyObligation / completeObligation),
//       not a parallel state machine;
//     • the WALL: a tenant signature is INTENT, not truth. An application
//       reaches 'active' ONLY through a manager countersign that completes
//       the activation obligation — and completeObligation refuses while
//       any required input is still outstanding. There is no other code
//       path that sets 'active'. Tenant-signed ≠ company-accepted.
//
//   Mount:
//     app.use("/", applicationsModule({ pool, spawnObligationFromEvent,
//                                        satisfyObligation, completeObligation }));
// =============================================================

const express = require("express");

module.exports = function applicationsModule(deps) {
  const { pool, spawnObligationFromEvent, satisfyObligation, completeObligation } = deps;
  // Optional: the application-submission service (its _service exposes
  // closeApprovalGate) and the conversion service. Injected so /approve can
  // close the leasing_manager application_approval gate before spawning the
  // property_manager activation obligation. Backward-compatible: if absent,
  // approve behaves exactly as before (no gate to close).
  const submissionService = deps.submissionService || null;
  const conversionService = deps.conversionService || null; // 068: approval's signature-work creator
  // Optional: the commitment-ledger service (062/063). When present, the
  // countersign transaction locks the immutable economic schedule from an
  // eligible lease offer (J1). Backward-compatible: absent service, or an
  // application with NO offer, behaves exactly as before.
  const ledgerService = deps.ledgerService || null;
  const { dormantWriteGuard } = require("./dormant_gate");  // fail-closed commitment-write gate
  const router = express.Router();

  const ACTIVATION_TYPE = "lease_activation";
  const COUNTERSIGN = "manager_countersign";

  // signatures that gate activation, given whether a guarantor is on the app
  const tenantInputs = (hasGuarantor) =>
    ["applicant_signature", ...(hasGuarantor ? ["guarantor_signature"] : [])];
  const activationInputs = (hasGuarantor) => [...tenantInputs(hasGuarantor), COUNTERSIGN];

  async function recordEvent(client, { property_id, person_id = null, unit_id = null, type, note }) {
    const r = await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning id`,
      [property_id, person_id, unit_id, type, note]
    );
    return r.rows[0].id;
  }

  const getApp = async (q, id) =>
    (await q.query("select * from lease_applications where id=$1", [id])).rows[0];

  // outstanding required inputs on the activation obligation (the live gate)
  async function outstanding(q, app) {
    if (!app.activation_obligation_id) return null;
    const o = (await q.query("select required_inputs, status from obligations where id=$1",
      [app.activation_obligation_id])).rows[0];
    return o ? { remaining: o.required_inputs || [], obligation_status: o.status } : null;
  }

  function nextAction(app, rem) {
    switch (app.status) {
      case "submitted": return "Approve the application (clears it to a lease packet).";
      case "lease_ready": return "Awaiting applicant" + (app.guarantor_name ? " / guarantor" : "") + " signature.";
      case "tenant_signed": return "Tenant signed — manager must COUNTERSIGN to activate. Not active yet.";
      case "active": return "Lease active. Tenant file open.";
      case "declined": return "Declined.";
      case "withdrawn": return "Withdrawn.";
      default: return "Submit the application.";
    }
  }

  const shape = (app, gate) => ({
    id: app.id,
    property_id: app.property_id,
    unit_id: app.unit_id,
    person_id: app.person_id,
    status: app.status,
    applicant_name: app.applicant_name,
    unit_label: app.unit_label,
    rent: app.rent == null ? null : Number(app.rent),
    deposit: app.deposit == null ? null : Number(app.deposit),
    guarantor_name: app.guarantor_name,
    applicant_signed_at: app.applicant_signed_at,
    guarantor_signed_at: app.guarantor_signed_at,
    countersigned_at: app.countersigned_at,
    activated_at: app.activated_at,
    activation_obligation_id: app.activation_obligation_id,
    outstanding_inputs: gate ? gate.remaining : null,
    next_action: nextAction(app, gate ? gate.remaining : []),
  });

  // ─────────────── create (intake record) ───────────────
  router.post("/properties/:propertyId/applications", async (req, res) => {
    const { applicant_name, unit_id = null, unit_label = null, rent = null, deposit = null,
            guarantor_name = null, person_id = null, captured = {} } = req.body || {};
    if (!applicant_name) return res.status(400).json({ receipt: "applicant_name is required." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const prop = (await client.query("select id from properties where id=$1", [req.params.propertyId])).rows[0];
      if (!prop) { await client.query("rollback"); return res.status(404).json({ receipt: "No property with that id." }); }

      const ins = await client.query(
        `insert into lease_applications
           (property_id, unit_id, person_id, status, applicant_name, unit_label, rent, deposit, guarantor_name, captured)
         values ($1,$2,$3,'submitted',$4,$5,$6,$7,$8,$9) returning *`,
        [req.params.propertyId, unit_id, person_id, applicant_name, unit_label, rent, deposit, guarantor_name,
         JSON.stringify(captured || {})]
      );
      const app = ins.rows[0];
      await recordEvent(client, { property_id: app.property_id, person_id, unit_id, type: "application_submitted",
        note: `Application submitted — ${applicant_name}${unit_label ? " · " + unit_label : ""}` });

      await client.query("commit");
      res.json({ receipt: `Application created for ${applicant_name}.`, application: shape(app, null) });
    } catch (e) {
      await client.query("rollback");
      console.error("application create:", e);
      res.status(500).json({ receipt: "Could not create the application.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── approve → spawn the activation obligation ───────────────
  // Approval clears the application to a lease packet AND opens the binding
  // gate: applicant (+ guarantor) signature, then manager countersign.
  router.post("/applications/:id/approve", async (req, res) => {
    const { approved_by = null, note = null } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const app = await getApp(client, req.params.id);
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }
      if (!["submitted", "approved"].includes(app.status)) {
        await client.query("rollback");
        return res.status(409).json({ receipt: `Cannot approve from status '${app.status}'.` });
      }
      if (app.activation_obligation_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Application already approved — activation obligation exists." });
      }

      const evId = await recordEvent(client, { property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
        type: "application_approved", note: `Application approved${approved_by ? " by " + approved_by : ""}` });

      // Close the leasing_manager application_approval gate (born at submission)
      // in THIS transaction — the manager's decision is made. The rail records
      // kept/missed timeliness; this approval is the disposition. Only the
      // submission-backed flow has the gate; the legacy direct-create path may
      // not, so this is guarded.
      if (app.approval_obligation_id && submissionService && submissionService.closeApprovalGate) {
        try {
          await submissionService.closeApprovalGate(client, { app, by_user_id: null, decision: "approved" });
        } catch (e) { /* gate already closed or not rail-linked — non-fatal */ }
      }

      const hasGuarantor = !!app.guarantor_name;
      const obligation = await spawnObligationFromEvent(client, {
        property_id: app.property_id,
        person_id: app.person_id,
        unit_id: app.unit_id,
        source_event_id: evId,
        related_id: app.id,
        related_type: "lease_application",
        module: "applications",
        type: ACTIVATION_TYPE,
        label: `Activate lease — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
        owner_type: "human",
        assigned_role: "property_manager",   // the role that countersigns/activates
        status: "open",
        priority: "normal",
        severity: "normal",
        required_inputs: activationInputs(hasGuarantor),
      });

      const upd = await client.query(
        `update lease_applications set status='lease_ready', activation_obligation_id=$1, updated_at=now()
           where id=$2 returning *`,
        [obligation.id, app.id]
      );

      // 051 doctrine, domain-locked + self-verifying: APPROVAL is the only
      // authorized cause of signature-chasing work. The creator re-reads the
      // application's post-approval status in THIS transaction (written just
      // above) and the DB's unique index makes double-creation impossible.
      if (app.conversion_id && conversionService && conversionService.ensureLeaseSignatureFollowup) {
        await conversionService.ensureLeaseSignatureFollowup(client, { conversion_id: app.conversion_id });
      }

      await client.query("commit");
      const gate = await outstanding(pool, upd.rows[0]);
      res.json({
        receipt: `Approved. Lease packet ready for ${app.applicant_name}. Awaiting signatures, then manager countersign.`,
        application: shape(upd.rows[0], gate),
        activation_obligation_id: obligation.id,
        required_before_active: activationInputs(hasGuarantor),
      });
    } catch (e) {
      await client.query("rollback");
      console.error("application approve:", e);
      res.status(500).json({ receipt: "Could not approve the application.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── sign (INTENT — never activates) ───────────────
  // party = 'applicant' | 'guarantor'. Records the signature against the
  // activation obligation. When the tenant side is fully signed, status
  // becomes 'tenant_signed' — but the lease is NOT active. Countersign is
  // still outstanding. This is the legal control made explicit.
  router.post("/applications/:id/sign", async (req, res) => {
    const { party, signature = null, signed_by = null } = req.body || {};
    if (!["applicant", "guarantor"].includes(party))
      return res.status(400).json({ receipt: "party must be 'applicant' or 'guarantor'." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const app = await getApp(client, req.params.id);
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }
      if (!app.activation_obligation_id || !["lease_ready", "tenant_signed"].includes(app.status)) {
        await client.query("rollback");
        return res.status(409).json({ receipt: `Nothing to sign — application is '${app.status}', not an open lease packet.` });
      }

      const input = `${party}_signature`;
      try {
        await satisfyObligation(client, { obligation_id: app.activation_obligation_id, input,
          proof: { signature, signed_by } });
      } catch (e) {
        if (e.code === "NOT_OUTSTANDING") {
          await client.query("rollback");
          return res.status(409).json({ receipt: `${party} signature is not required or already recorded on this application.` });
        }
        throw e;
      }

      // stamp the signature time; if tenant side is now complete, mark tenant_signed
      const col = party === "applicant" ? "applicant_signed_at" : "guarantor_signed_at";
      const o = (await client.query("select required_inputs from obligations where id=$1", [app.activation_obligation_id])).rows[0];
      const remaining = o.required_inputs || [];
      const tenantDone = !remaining.includes("applicant_signature") &&
                         (!app.guarantor_name || !remaining.includes("guarantor_signature"));
      const newStatus = tenantDone ? "tenant_signed" : app.status;

      const upd = await client.query(
        `update lease_applications set ${col}=now(), status=$1, updated_at=now() where id=$2 returning *`,
        [newStatus, app.id]
      );

      await client.query("commit");
      const gate = await outstanding(pool, upd.rows[0]);
      res.json({
        receipt: tenantDone
          ? `${party} signed. Tenant side complete — NOT active. Manager countersign required to activate.`
          : `${party} signed. Still awaiting remaining signature(s) before countersign.`,
        application: shape(upd.rows[0], gate),
        still_outstanding: gate ? gate.remaining : [],
      });
    } catch (e) {
      await client.query("rollback");
      console.error("application sign:", e);
      res.status(500).json({ receipt: "Could not record the signature.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── countersign → activate (THE WALL) ───────────────
  // Modeled on the move-in approval gate. Refuses to activate unless the
  // tenant side is fully signed, then satisfies the countersign and
  // completes the obligation (which itself refuses on any outstanding
  // input). 'active' is set ONLY here, ONLY after completeObligation
  // succeeds — the single, structural path to an active lease.
  router.post("/applications/:id/countersign", dormantWriteGuard, async (req, res) => {
    const { countersigned_by = null, note = null } = req.body || {};
    if (!countersigned_by) return res.status(400).json({ receipt: "countersigned_by required — a human must countersign." });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const app = await getApp(client, req.params.id);
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }
      if (!app.activation_obligation_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Application is not approved — no activation gate to countersign." });
      }
      if (app.status === "active") {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Lease is already active." });
      }

      const oQ = await client.query("select * from obligations where id=$1 for update", [app.activation_obligation_id]);
      const obligation = oQ.rows[0];
      const remaining = obligation.required_inputs || [];

      // HARD GATE: tenant must have signed before the company countersigns.
      const tenantLeft = tenantInputs(!!app.guarantor_name).filter((i) => remaining.includes(i));
      if (tenantLeft.length > 0) {
        await client.query("rollback");
        return res.status(409).json({
          receipt: "Cannot countersign — the tenant side has not signed yet. Tenant signature is intent; the company is not bound until they sign first.",
          tenant_signatures_outstanding: tenantLeft,
        });
      }

      // satisfy the countersign, then complete (the engine refuses on any leftover input)
      try {
        await satisfyObligation(client, { obligation_id: obligation.id, input: COUNTERSIGN,
          proof: { countersigned_by, note } });
      } catch (e) { if (e.code !== "NOT_OUTSTANDING") throw e; }

      try {
        await completeObligation(client, { obligation_id: obligation.id, completed_by: countersigned_by });
      } catch (e) {
        if (e.code === "INPUTS_OUTSTANDING") {
          await client.query("rollback");
          return res.status(409).json({ receipt: "Cannot activate — required inputs still outstanding.", outstanding: e.outstanding_inputs });
        }
        if (e.code !== "ALREADY_COMPLETE") throw e;
      }

      // ── J1: THE COUNTERSIGN LOCK (Commitment Ledger, 063) ─────────────
      // If an eligible lease offer is bound to this application, its dated
      // economic schedule locks HERE, in this same transaction — the lease
      // and its committed economics activate together or not at all.
      //   · no ledger service / no offer → exactly the prior behavior.
      //   · offer present but the calendar contract (month placement) is
      //     not filled yet → REFUSE the countersign honestly rather than
      //     activate a lease whose committed economics can't be recorded.
      if (ledgerService && ledgerService.findEligibleOfferForApplication) {
        const offers = await ledgerService.findEligibleOfferForApplication(client, app.id);
        if (offers && offers.length > 0) {
          const offer = offers[0];
          // D10: the lock is attributed to the COUNTERSIGNER, a real person
          // row — the free-text countersigned_by name is not enough when
          // committed economics are being locked. Fail-closed, never faked.
          const countersignerPersonId = (req.body || {}).countersigned_by_person_id || null;
          if (!countersignerPersonId) {
            await client.query("rollback");
            return res.status(409).json({
              receipt: "Cannot countersign — this application carries a lease offer, so the lock needs countersigned_by_person_id (the actual countersigning person). Committed economics are never attributed to a name string.",
              offer_id: offer.id,
            });
          }
          let lines;
          // Scoped offer (an eligibility class, not a quoted slot): the
          // lease chooses the room. Resolve the application's unit to its
          // '(whole unit)' space; an application with NO unit cannot lock
          // a scoped offer — refuse honestly, never guess a room.
          let resolvedSpaceId = null;
          if (!offer.space_id) {
            if (!app.unit_id) {
              await client.query("rollback");
              return res.status(409).json({
                receipt: "Cannot countersign — the lease offer is scoped (no exact unit quoted) and this application has no unit selected. Select the unit first; an offer never holds a room, the lease chooses one.",
                offer_id: offer.id,
              });
            }
            const sp = await client.query(
              `select id from spaces where unit_id = $1 order by created_at limit 1`, [app.unit_id]);
            if (sp.rowCount === 0) {
              await client.query("rollback");
              return res.status(409).json({ receipt: "Cannot countersign — the application's unit has no space record.", offer_id: offer.id });
            }
            resolvedSpaceId = sp.rows[0].id;
          }
          try {
            lines = ledgerService.computeScheduleLines(offer);
          } catch (e) {
            if (e.code === "CALENDAR_CONTRACT_MISSING") {
              await client.query("rollback");
              return res.status(409).json({
                receipt: "Cannot countersign yet — this application carries a lease offer, but the calendar contract (concession month placement) is not configured. The lease cannot activate with its committed economics unrecorded.",
                offer_id: offer.id,
              });
            }
            throw e;
          }
          const locked = await ledgerService.lockLeaseEconomics(client, {
            application_id: app.id, offer_id: offer.id, lines,
            locked_by_person_id: countersignerPersonId,
            resolved_space_id: resolvedSpaceId,
          });
          void locked;
        }
      }

      // ── TWO-PHASE COUNTERSIGN (COUNTERSIGN_TENANCY_ANCHOR.md §2-3) ────
      // Countersign RECORDS ACCEPTANCE. It does NOT create the tenancy.
      // There is no canonical lease term at this moment (the offer carries a
      // duration, not dated start/end; computeScheduleLines is a stub). An
      // active application / tenant person with no describable term is a
      // poisoned truth, so we STOP here:
      //   · status → accepted_term_required   (accepted, term not yet pinned)
      //   · spawn a term_required obligation pointing at the APPLICATION
      //     (no lease exists yet: related_type='lease_application')
      //   · NO activated_at, NO 'active', NO tenant promotion, NO leases row.
      // The economics lock above (J1) already ran if an offer existed — the
      // committed schedule is preserved, application-linked, and will gain its
      // lease_id in Phase 2. Phase 2 (POST .../confirm-term) is the ONLY path
      // that creates the pending lease and promotes application + person.
      const upd = await client.query(
        `update lease_applications
            set status='accepted_term_required', countersigned_at=now(), updated_at=now()
          where id=$1 returning *`,
        [app.id]
      );

      // spawn the term_required obligation — the owned work that unblocks the
      // tenancy. It is NOT an error state; it is the product surfacing the
      // missing decision. Assigned to the manager; completed by Phase 2.
      const trEvId = await recordEvent(client, {
        property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
        type: "countersign_accepted_term_required",
        note: `Countersign accepted — lease term required before activation (${app.applicant_name})`,
      });
      let termObligation = null;
      try {
        termObligation = await spawnObligationFromEvent(client, {
          property_id: app.property_id,
          person_id: app.person_id,
          unit_id: app.unit_id,
          source_event_id: trEvId,
          related_id: app.id,
          related_type: "lease_application",
          module: "applications",
          type: "term_required",
          label: `Confirm lease term — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
          owner_type: "human",
          assigned_role: "property_manager",
          status: "open",
          priority: "high",
          severity: "normal",
          required_inputs: ["lease_term_confirmation"],
        });
      } catch (e) {
        // idempotency belt: if a term_required obligation already exists for
        // this application (re-countersign), do not stack a second one.
        if (e.code === "23505") {
          const ex = await client.query(
            `select id from obligations
              where related_id=$1 and related_type='lease_application'
                and type='term_required' and status in ('open','in_progress')
              order by created_at desc limit 1`, [app.id]);
          termObligation = ex.rows[0] || null;
        } else { throw e; }
      }

      await client.query("commit");
      res.json({
        receipt: `Countersign accepted — ${app.applicant_name}. Acceptance is recorded; the lease is NOT active yet. Confirm the lease term (start and end dates) to activate the tenancy.`,
        phase: "accepted_term_required",
        term_required_obligation_id: termObligation ? termObligation.id : null,
        next_action: "POST /operator/leasing/applications/:applicationId/confirm-term",
        application: shape(upd.rows[0], { remaining: ["lease_term_confirmation"], obligation_status: "open" }),
      });
    } catch (e) {
      await client.query("rollback");
      console.error("application countersign:", e);
      res.status(500).json({ receipt: "Could not countersign.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── PHASE 2 — TERM CONFIRMATION (the tenancy anchor) ─────
  // POST /applications/:id/confirm-term
  //   Body: { start_date (YYYY-MM-DD), end_date (YYYY-MM-DD),
  //           confirmed_by (required), rent?, security_deposit? }
  //
  // This is the ONLY path that creates the pending lease and promotes the
  // application to active + the person to tenant. It runs ONLY against an
  // application in status 'accepted_term_required' with an OPEN term_required
  // obligation. It requires STRUCTURED dates — captured free-text may seed the
  // caller's form but is never accepted here as truth. Rent/deposit are
  // source-ranked: locked economics (if present) win over the application's
  // seed values; a conflict is surfaced, never silently resolved.
  //
  // NOTE (path): the app-facing operator route
  //   POST /operator/leasing/applications/:applicationId/confirm-term
  // proxies to this canonical service route, which lives here because the
  // commitment-ledger service, obligation helpers, and dormant gate are all
  // injected into this module. Flagged for the supervised review: confirm the
  // proxy vs. moving the mount, but the SERVICE logic belongs with its deps.
  //
  // IDEMPOTENCY (ruling gate C): a guarded transaction. It refuses to create a
  // second CURRENT tenancy anchor (a lease in 'pending'|'active'|'commercial')
  // for the same application. Amendment / reissue / cancellation is a separate
  // future path; this route creates exactly one anchor or refuses.
  router.post("/applications/:id/confirm-term", dormantWriteGuard, async (req, res) => {
    const { start_date = null, end_date = null, confirmed_by = null,
            rent: rentIn = null, security_deposit: depositIn = null } = req.body || {};
    if (!confirmed_by) return res.status(400).json({ receipt: "confirmed_by required — a human confirms the lease term." });
    // STRUCTURED dates only — never a fallback string.
    if (!start_date || !end_date) {
      return res.status(400).json({ receipt: "start_date and end_date are required (YYYY-MM-DD). Captured free-text dates may seed the form but cannot confirm the term." });
    }
    const sd = new Date(start_date), ed = new Date(end_date);
    if (isNaN(sd.getTime()) || isNaN(ed.getTime())) {
      return res.status(400).json({ receipt: "start_date / end_date must be valid dates (YYYY-MM-DD)." });
    }
    if (ed <= sd) {
      return res.status(400).json({ receipt: "end_date must be after start_date — a term with no duration is not a term." });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");

      const app = (await client.query("select * from lease_applications where id=$1 for update", [req.params.id])).rows[0];
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }

      // must be in the accepted-term-required state (Phase 1 output)
      if (app.status !== "accepted_term_required") {
        await client.query("rollback");
        return res.status(409).json({
          receipt: `Cannot confirm term — application status is '${app.status}', not accepted_term_required. Term confirmation follows countersign acceptance.`,
        });
      }

      // there must be an OPEN term_required obligation
      const oQ = await client.query(
        `select * from obligations
          where related_id=$1 and related_type='lease_application'
            and type='term_required' and status in ('open','in_progress')
          order by created_at desc limit 1 for update`, [app.id]);
      if (oQ.rows.length === 0) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Cannot confirm term — no open term_required obligation for this application." });
      }
      const termObligation = oQ.rows[0];

      // ── IDEMPOTENCY GUARD (gate C): one lease anchor per application, PERIOD ──
      // The invariant (reviewer correction #1) is one lease per application
      // REGARDLESS of status — application_id is the provenance of one tenancy
      // decision; a re-lease comes from a new application or a governed renewal,
      // never from reusing this application. So this pre-check must match the
      // unique index `leases_one_anchor_per_application` (any lease on the
      // application), NOT just live states — otherwise an expired lease would
      // pass the check and the insert would hit the index with a raw 23505.
      // Combined with the SELECT ... FOR UPDATE on the application row above,
      // two concurrent calls serialize and the second returns this controlled
      // 409 rather than ever throwing.
      const existing = await client.query(
        `select id, lease_status from leases
          where application_id=$1
          order by created_at asc limit 1`, [app.id]);
      if (existing.rows.length > 0) {
        await client.query("rollback");
        // Convergence contract (reviewer correction #2): the domain fact is
        // that both callers receive the SAME durable anchor. The replay
        // response names the winning lease id explicitly and marks itself
        // idempotent — the status code is secondary to the shared lease_id.
        return res.status(409).json({
          error: "term_already_confirmed",
          lease_id: existing.rows[0].id,
          lease_status: existing.rows[0].lease_status,
          idempotent: true,
          receipt: "Term already confirmed for this application — converging on the existing lease anchor. One application creates exactly one lease; renewal, correction, and replacement are separate governed paths.",
          existing_lease_id: existing.rows[0].id,     // back-compat alias
        });
      }

      // ── resolve space_id (server-side, never client-nominated) ──
      // the application's unit → its '(whole unit)' space (first by creation).
      if (!app.unit_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Cannot confirm term — the application has no unit selected. A lease chooses a room; select the unit first." });
      }
      const sp = await client.query(
        `select id from spaces where unit_id=$1 order by created_at asc limit 1`, [app.unit_id]);
      if (sp.rows.length === 0) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Cannot confirm term — the application's unit has no space record." });
      }
      const spaceId = sp.rows[0].id;

      // ── SOURCE-RANK rent/deposit (ruling gate B): locked economics win ──
      // If a locked economic schedule exists for this application, its base_rent
      // is authoritative; the application's rent/deposit only SEED. A conflict is
      // reported, never silently overwritten.
      let rent = rentIn != null ? Number(rentIn) : (app.rent != null ? Number(app.rent) : null);
      let security_deposit = depositIn != null ? Number(depositIn) : (app.deposit != null ? Number(app.deposit) : null);
      let rent_source = rentIn != null ? "caller_confirmed" : (app.rent != null ? "application_seed" : "unset");
      let economics_conflict = null;
      const schedQ = await client.query(
        `select id from lease_economic_schedules where application_id=$1 and status='locked' order by created_at desc limit 1`,
        [app.id]);
      const schedule = schedQ.rows[0] || null;
      if (schedule) {
        // authoritative base_rent = sum of base_rent lines' first month, best-effort:
        // read the base_rent line amount (recurring). If it disagrees with the
        // resolved rent, surface it rather than pick silently.
        const brQ = await client.query(
          `select amount from lease_economic_lines
            where schedule_id=$1 and line_type='base_rent'
            order by effective_month asc limit 1`, [schedule.id]);
        if (brQ.rows.length > 0) {
          const lockedRent = Number(brQ.rows[0].amount);
          if (rent != null && Math.abs(lockedRent - rent) > 0.001) {
            economics_conflict = { application_or_caller_rent: rent, locked_economics_rent: lockedRent, resolved: lockedRent };
          }
          rent = lockedRent;               // locked economics WIN
          rent_source = "locked_economics";
        }
      }

      // ── create the PENDING lease — the tenancy anchor ──
      const tenantIds = app.person_id ? [app.person_id] : [];
      const lease = (await client.query(
        `insert into leases
           (property_id, space_id, tenant_ids, rent, start_date, end_date,
            security_deposit, lease_status, application_id)
         values ($1,$2,$3,$4,$5,$6,$7,'pending',$8) returning *`,
        [app.property_id, spaceId, tenantIds, rent, start_date, end_date, security_deposit, app.id]
      )).rows[0];

      // ── link economics → the lease (fills the 071 handle) ──
      let economics_linked = false;
      if (schedule) {
        await client.query(`update lease_economic_schedules set lease_id=$1 where id=$2`, [lease.id, schedule.id]);
        economics_linked = true;
      }

      // ── complete the term_required obligation ──
      try {
        if (typeof satisfyObligation === "function") {
          await satisfyObligation(client, { obligation_id: termObligation.id, input: "lease_term_confirmation",
            proof: { confirmed_by, start_date, end_date } });
        }
      } catch (e) { if (e.code !== "NOT_OUTSTANDING") throw e; }
      try {
        await completeObligation(client, { obligation_id: termObligation.id, completed_by: confirmed_by });
      } catch (e) { if (e.code !== "ALREADY_COMPLETE") throw e; }

      // ── NOW promote: application → active, person → tenant ──
      const updApp = (await client.query(
        `update lease_applications
            set status='active', activated_at=now(), updated_at=now()
          where id=$1 returning *`, [app.id])).rows[0];
      if (app.person_id) {
        await client.query("update persons set lifecycle_status='tenant' where id=$1", [app.person_id]).catch(() => {});
      }

      // ── SLICE D 2A — lease-linked move-in event (inline, atomic) ──────
      // The pending lease is a committed move-in. Create the move_in_scheduled
      // event linked to the lease by a REAL column (migration 074), effective on
      // the lease start_date (delivery-due default; no separate possession field
      // this slice). The partial unique index guarantees one move-in per lease —
      // a concurrent/retry insert fails on the constraint, caught below.
      if (app.unit_id) {
        try {
          await client.query(
            `insert into unit_events (unit_id, property_id, event_type, effective_date, payload, source, status, lease_id)
             values ($1,$2,'move_in_scheduled',$3,$4,'confirm_term','scheduled',$5)`,
            [app.unit_id, app.property_id, start_date,
             JSON.stringify({ applicant_name: app.applicant_name, lease_id: lease.id }), lease.id]);
        } catch (e) {
          // 23505 = the one-move-in-per-lease guard already fired (idempotent replay). Not fatal.
          if (e.code !== "23505") throw e;
        }

        // ── SLICE D 2B — PM-owned move_in_delivery obligation ───────────
        // Severity DERIVES from due_at proximity (not blanket high). Read the
        // property's delivery window; a move-in far out is planned, not urgent.
        let windowDays = 14;
        try {
          const cal = await client.query(
            `select delivery_window_days from property_leasing_calendar where property_id=$1 and active=true`,
            [app.property_id]);
          if (cal.rows[0] && cal.rows[0].delivery_window_days != null) windowDays = cal.rows[0].delivery_window_days;
        } catch (e) { /* calendar optional; default window */ }
        const msPerDay = 86400000;
        const daysUntil = Math.round((new Date(start_date).getTime() - Date.now()) / msPerDay);
        let dPriority = "low", dSeverity = "low";        // outside window → planned
        if (daysUntil <= windowDays) { dPriority = "high"; dSeverity = "normal"; }  // inside window
        if (daysUntil <= Math.ceil(windowDays / 2)) { dSeverity = "high"; }         // due soon → exception

        // guard: don't spawn a second delivery obligation for the same lease.
        const existingDelivery = await client.query(
          `select id from obligations where related_id=$1 and related_type='lease'
             and type='move_in_delivery' and status in ('open','in_progress') limit 1`, [lease.id]);
        if (existingDelivery.rows.length === 0) {
          const dEv = await recordEvent(client, {
            property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
            type: "move_in_delivery_opened",
            note: `Delivery promise opened — deliver unit for move-in ${start_date} (${app.applicant_name})`,
          });
          await spawnObligationFromEvent(client, {
            property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
            source_event_id: dEv,
            related_id: lease.id, related_type: "lease",
            module: "leasing", type: "move_in_delivery",
            label: `Deliver unit for move-in — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
            owner_type: "human", assigned_role: "property_manager",
            escalates_to_role: "regional_manager",
            status: "open", due_at: start_date,
            priority: dPriority, severity: dSeverity,
            // HARD gates only; resident_instructions_sent + move_in_logistics_considered are
            // tracked as soft prompts (payload), never required_inputs.
            required_inputs: ["unit_ready", "keys_access_ready"],
          });
        }
      }

      await recordEvent(client, {
        property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
        type: "lease_term_confirmed",
        note: `Lease term confirmed (${start_date} → ${end_date}) — pending lease created, tenancy activated (${app.applicant_name})`,
      });

      await client.query("commit");
      res.json({
        receipt: `Lease term confirmed — ${app.applicant_name}. Pending lease created (${start_date} → ${end_date}); the application is active and the person is a tenant.`,
        phase: "active",
        lease_id: lease.id,
        lease_status: lease.lease_status,
        lease_application_id: app.id,
        economics_linked,
        rent_source,
        economics_conflict,   // non-null only when locked economics disagreed with the seed
        term_required_obligation_id: termObligation.id,
        application: shape(updApp, { remaining: [], obligation_status: "complete" }),
      });
    } catch (e) {
      await client.query("rollback");
      console.error("confirm-term:", e);
      res.status(500).json({ receipt: "Could not confirm the lease term.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── reads (the operator Gate's real rows) ───────────────
  router.get("/properties/:propertyId/applications", async (req, res) => {
    try {
      const rows = (await pool.query(
        `select la.*, o.required_inputs as gate_inputs, o.status as gate_status
           from lease_applications la
           left join obligations o on o.id = la.activation_obligation_id
          where la.property_id = $1
          order by la.created_at desc`,
        [req.params.propertyId]
      )).rows;
      const applications = rows.map((r) =>
        shape(r, r.activation_obligation_id ? { remaining: r.gate_inputs || [], obligation_status: r.gate_status } : null));
      const pending = applications.filter((a) => !["active", "declined", "withdrawn"].includes(a.status)).length;
      res.json({ property_id: req.params.propertyId, count: applications.length, pending, applications });
    } catch (e) {
      console.error("applications list:", e);
      res.status(500).json({ receipt: "Could not list applications.", error: e.message });
    }
  });

  router.get("/applications/:id", async (req, res) => {
    try {
      const app = await getApp(pool, req.params.id);
      if (!app) return res.status(404).json({ receipt: "No application with that id." });
      const gate = await outstanding(pool, app);
      res.json({ application: shape(app, gate) });
    } catch (e) {
      console.error("application get:", e);
      res.status(500).json({ receipt: "Could not load the application.", error: e.message });
    }
  });

  return router;
};
