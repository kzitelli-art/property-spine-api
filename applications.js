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
  // ── THE ONE CANONICAL TENANCY-ANCHOR SERVICE (Fable ruling) ──────────
  // countersign + confirm-term now live in tenancy_anchor_service.js as ONE
  // implementation both this route family AND the new /operator/leasing/*
  // adapters call. These routes are entry adapters over that service; they
  // do NOT contain the transaction body. Injected from server.js (built from
  // the same obligation engine + ledger service this module already gets).
  // Back-compat: if absent (older server.js), the two routes fail closed with
  // a clear 503 rather than silently reverting to a second implementation.
  const tenancyAnchor = deps.tenancyAnchor || null;
  const { dormantWriteGuard } = require("./dormant_gate");  // fail-closed commitment-write gate
  const { activationPerimeter } = require("./activation_perimeter"); // Step 6: scoped activation perimeter
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

  // ── ACTIVATION PERIMETER GUARDS (Step 6) ──────────────────────────────
  // Scoped, fail-closed Layer-2 guards for the two gated tenancy routes.
  // dormantWriteGuard (Layer 1, no DB) still runs FIRST in each chain; these
  // add: approved-property + internal_qa-record + authorized-operator +
  // eligible-application-state. Eligible states are route-specific:
  //   · countersign  runs on a 'lease_ready' application (approve set this;
  //     activation gate open, tenant may have signed, not yet accepted/active).
  //   · confirm-term runs on an application in 'accepted_term_required'.
  const countersignPerimeter = activationPerimeter({
    pool,
    loadApplication: getApp,
    // countersign runs AFTER approve (lease_ready) and typically AFTER the
    // tenant signs (tenant_signed). Both are legitimate pre-countersign states
    // — the handler is final authority (it re-checks obligation inputs under
    // lock and refuses if the tenant hasn't signed). The perimeter must not be
    // stricter than the handler here.
    eligibleStatuses: ["lease_ready", "tenant_signed"],
    action: "countersign",
    requiredModule: "leasing",
  });
  const confirmTermPerimeter = activationPerimeter({
    pool,
    loadApplication: getApp,
    eligibleStatuses: ["accepted_term_required"],
    action: "confirm_term",
    requiredModule: "leasing",
  });

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
  router.post("/applications/:id/countersign", dormantWriteGuard, countersignPerimeter, async (req, res) => {
    // THIN ADAPTER over the ONE canonical countersign service. This route's job
    // is authority (the two guards above) + transaction lifecycle; the write
    // body lives in tenancy_anchor_service.js so this legacy door and the new
    // /operator/leasing/* door share exactly one implementation.
    if (!tenancyAnchor || typeof tenancyAnchor.countersignService !== "function") {
      return res.status(503).json({ receipt: "Countersign service not wired on this deploy (tenancyAnchor missing). Deploy tenancy_anchor_service.js + the updated server.js together." });
    }
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await tenancyAnchor.countersignService(client, {
        applicationId: req.params.id,
        countersigned_by: b.countersigned_by || null,          // legacy attestation (name string)
        note: b.note || null,
        countersigned_by_person_id: b.countersigned_by_person_id || null,
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      // svcErr carries the exact { http, body } the route should send.
      if (e.svc) return res.status(e.http).json(e.body);
      console.error("application countersign:", e);
      return res.status(500).json({ receipt: "Could not countersign.", error: e.message });
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
  router.post("/applications/:id/confirm-term", dormantWriteGuard, confirmTermPerimeter, async (req, res) => {
    // THIN ADAPTER over the ONE canonical confirm-term service (the tenancy
    // anchor). Authority (guards) + transaction lifecycle live here; the write
    // body — pending-lease creation, one-lease-per-application idempotency,
    // tenant promotion, move-in delivery obligation — lives in
    // tenancy_anchor_service.js, shared with the /operator/leasing/* door.
    if (!tenancyAnchor || typeof tenancyAnchor.confirmTermService !== "function") {
      return res.status(503).json({ receipt: "Confirm-term service not wired on this deploy (tenancyAnchor missing). Deploy tenancy_anchor_service.js + the updated server.js together." });
    }
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await tenancyAnchor.confirmTermService(client, {
        applicationId: req.params.id,
        start_date: b.start_date || null,
        end_date: b.end_date || null,
        confirmed_by: b.confirmed_by || null,
        rent: b.rent != null ? b.rent : null,
        security_deposit: b.security_deposit != null ? b.security_deposit : null,
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e.svc) return res.status(e.http).json(e.body);
      console.error("confirm-term:", e);
      return res.status(500).json({ receipt: "Could not confirm the lease term.", error: e.message });
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
