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
  router.post("/applications/:id/countersign", async (req, res) => {
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

      // the ONLY path that sets 'active' — and only after the gate completed.
      const upd = await client.query(
        `update lease_applications
            set status='active', countersigned_at=now(), activated_at=now(), updated_at=now()
          where id=$1 returning *`,
        [app.id]
      );

      // promote the person to tenant if one is linked
      if (app.person_id) {
        await client.query("update persons set lifecycle_status='tenant' where id=$1", [app.person_id]).catch(() => {});
      }

      await client.query("commit");
      res.json({
        receipt: `Countersigned and activated — ${app.applicant_name}. The completed obligation is the verified record the company accepted the lease.`,
        application: shape(upd.rows[0], { remaining: [], obligation_status: "complete" }),
      });
    } catch (e) {
      await client.query("rollback");
      console.error("application countersign:", e);
      res.status(500).json({ receipt: "Could not countersign.", error: e.message });
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
