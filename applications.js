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

  // ── v3 TERMS-REVIEW CORRECTION (the birth event) ─────────────────────
  // Approval creates a TERMS_REVIEW obligation whose ONLY required input is
  // the resident's acknowledgment of the proposed terms. It carries NO
  // signature inputs and NO countersign input, because:
  //     reviewed demonstration terms ≠ signed governing lease.
  // The old blended vocabulary below is HISTORICAL — retained so existing
  // rows read honestly (§9). Nothing in this file creates it anymore, and no
  // new code may derive current authority from it.
  const TERMS_REVIEW_TYPE = "terms_review";
  const TERMS_INPUT = "terms_acknowledged";
  // HISTORICAL (read-only vocabulary for pre-v3 rows):
  const ACTIVATION_TYPE = "lease_activation"; // eslint-disable-line no-unused-vars

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

  // outstanding required inputs on the live gate. v3: the terms_review gate is
  // the current birth event; the activation gate is legacy (pre-v3 rows only).
  // Also loads the CURRENT packet (latest non-superseded — §5: never merely
  // highest version) so the application_next resolver can speak with truth.
  async function outstanding(q, app, opts) {
    let gate = null;
    if (app.terms_review_obligation_id) {
      const o = (await q.query("select required_inputs, status from obligations where id=$1",
        [app.terms_review_obligation_id])).rows[0];
      if (o) gate = { remaining: o.required_inputs || [], obligation_status: o.status, gate_kind: "terms_review" };
    } else if (app.activation_obligation_id) {
      const o = (await q.query("select required_inputs, status from obligations where id=$1",
        [app.activation_obligation_id])).rows[0];
      if (o) gate = { remaining: o.required_inputs || [], obligation_status: o.status, gate_kind: "legacy_activation" };
    }
    if (!gate) return null;
    // Slice 1 — single-read invariant. If the caller already loaded the current
    // non-superseded packet (Application Review does, for currency/lineage), it
    // passes it in via opts.packet so the SAME row drives both the projection and
    // this gate — no second lease_packets read, no chance the resolver and the
    // rendered detail observe different "current" packets under a concurrent
    // generation/issuance. Standalone callers omit opts and this self-loads.
    if (opts && Object.prototype.hasOwnProperty.call(opts, "packet")) {
      gate.packet = opts.packet || null;
      return gate;
    }
    try {
      const pk = (await q.query(
        `select id, version, status from lease_packets
          where application_id=$1 and superseded_at is null
          order by version desc limit 1`, [app.id])).rows[0];
      gate.packet = pk || null;
    } catch (_) { gate.packet = null; } // packet read is enrichment, never fatal
    return gate;
  }

  // ── application_next — THE server-authored lifecycle resolver (§7) ──────
  // The Person Card and every queue consume THIS; no frontend computes the
  // lifecycle, and no reader derives execution readiness from raw status
  // (lease_ready is explicitly NON-AUTHORITATIVE, §3).
  //
  // SLICE 1 — NEXT-ACTION AUTHORITY. The resolver now accepts an OPTIONAL
  // third argument: the richer review facts Application Review already loads.
  //     applicationNext(app, gate, {
  //       confirmation,                          // current proposed-terms confirmation row | null
  //       packet,                                // current non-superseded packet row | null
  //       currency_status,                       // 'not_generated' | 'current' | 'stale'
  //       lineage_matches_current_confirmation,  // true only when packet.proposed_terms_confirmation_id === confirmation.id
  //     })
  // WITH review facts, the old catch-all "send_terms_for_review" refines into
  // one precise action per stage. WITHOUT them (every existing two-arg caller)
  // action_code values are unchanged — except ONE deliberate drift fix noted
  // at PK_AWAITING below. Additive fields on every return:
  //     code         — canonical name going forward (same value as action_code)
  //     group_code   — the pre-slice broad vocabulary; existing consumers may
  //                    keep switching on this until deliberately migrated
  //     state        — 'available' | 'blocked' | 'waiting' | 'complete'
  //     blocker_code — why the KNOWN next action cannot run right now (else null)
  // "What is next" (code) and "why it is blocked" (blocker_code) are separate
  // facts and must never collapse. Actor permission is NOT a lifecycle state:
  // it stays in the authenticated write-route guards. This resolver is a PURE
  // interpreter of already-loaded facts — no queries — and it is a read
  // projection, not authorization: every write route still revalidates status,
  // gate, packet, lineage, property scope, and operator authority inside its
  // own transaction at execution time.
  //
  // ONE LIFECYCLE VOCABULARY (drift kill): the packet-status names below are
  // the single normalization point. 'tenant_in_progress' (the packet column's
  // own vocabulary) previously fell through to "send_terms_for_review" here —
  // a wrong answer for an already-sent packet. It now correctly reads as
  // awaiting acknowledgment in BOTH modes. That is the one intentional
  // legacy-mode behavior change in this slice.
  const PK_AWAITING = ["sent", "in_progress", "tenant_in_progress"];

  function applicationNext(app, gate, review) {
    const rv = review || null;
    // Review's packet is authoritative when review facts are provided (it is
    // loaded by the same canonical non-superseded/version-desc rule as the
    // gate's enrichment, but carries the full lifecycle/lineage columns).
    const pk = (rv && rv.packet !== undefined) ? rv.packet : (gate && gate.packet);
    const gateClosed = gate && ["complete", "completed"].includes(gate.obligation_status);
    const base = { source_type: "lease_application", source_id: app.id,
                   obligation_id: (gate && gate.gate_kind === "terms_review") ? app.terms_review_obligation_id : null,
                   packet_id: pk ? pk.id : null, blocked_reason: null };
    // #2 — action_code stays the LEGACY contract for any consumer (including
    // ones outside this repo the grep can't see). `code` is the new precise
    // value; `action_code`/`group_code` carry the pre-slice value. For every
    // legacy two-arg return these three are the same string; for a refined
    // three-arg return, `code` is precise while action_code/group_code stay the
    // broad legacy value (passed via extra.group_code). Nothing outside the new
    // panel silently changes.
    const out = (code, label, extra) => {
      const e = extra || {};
      const legacy = (e.group_code !== undefined) ? e.group_code : code;
      return {
        ...base, label,
        code, action_code: legacy, group_code: legacy,
        state: "available", blocker_code: null, warning_code: null,
        ...e,
        // action_code is ALWAYS the legacy value even if extra tried to set code-ish fields
        action_code: legacy, group_code: legacy,
      };
    };
    if (app.status === "active") return out("active", "Lease active. Tenant file open.", { state: "complete" });
    if (["declined", "withdrawn", "expired"].includes(app.status)) return out("closed", "Application closed (" + app.status + ").", { state: "complete" });
    if (app.status === "accepted_term_required") return out("confirm_term", "Company accepted — confirm the lease term.");
    if (app.status === "submitted") {
      return rv
        ? out("approve_application", "Approve the application.", { group_code: "approve" })
        : out("approve", "Approve the application.");
    }
    if (!gate) return out("review_application", "Submit the application.");
    if (gate.gate_kind === "legacy_activation") {
      // Pre-v3 row. Its blended gate cannot pass the corrected countersign
      // without real execution proof — the honest next is the same dead-end.
      return out("executed_lease_required",
        "Executed lease required. (Legacy activation gate — a terms acknowledgment is not an executed lease.)");
    }
    if (gateClosed) return out("executed_lease_required", "Executed lease required.");
    if (pk && PK_AWAITING.includes(pk.status)) {
      // Already issued. Nothing is pending, so there is NO blocker — the resident
      // is being awaited regardless of packet metadata. But if review facts show
      // the issued packet's lineage/currency is off, that is a real anomaly on
      // completed work: surface it as a WARNING (not a blocker — no pending
      // action is being prevented). #3.
      let warning = null;
      if (rv) {
        if (rv.lineage_matches_current_confirmation !== true) {
          warning = (pk.proposed_terms_confirmation_id == null)
            ? "issued_packet_lineage_unproven" : "issued_packet_confirmation_mismatch";
        } else if (rv.currency_status === "stale") {
          warning = "issued_packet_stale";
        }
      }
      return rv
        ? out("await_resident_acknowledgment", "Awaiting the resident's terms acknowledgment.",
              { group_code: "awaiting_acknowledgment", state: "waiting", warning_code: warning })
        : out("awaiting_acknowledgment", "Awaiting the resident's terms acknowledgment.", { state: "waiting" });
    }
    if (pk && pk.status === "submitted") return out("executed_lease_required", "Executed lease required.");

    // ── the middle of the flow (the old single catch-all) ─────────────────
    if (!rv) return out("send_terms_for_review", "Send terms for review."); // legacy two-arg: unchanged

    const G = { group_code: "send_terms_for_review" };
    const conf = rv.confirmation || null;
    if (!conf && !pk) return out("confirm_proposed_terms", "Confirm the proposed terms.", G);
    if (!conf && pk) {
      // A packet with no current confirmation is a contradiction under v3
      // governance. The truthful missing thing IS the confirmation — but
      // confirming is locked by the existing packet, so this is a governed-
      // correction case, never a normal next step.
      return out("confirm_proposed_terms", "Confirm the proposed terms.",
        { ...G, state: "blocked", blocker_code: "inconsistent_application_state" });
    }
    if (conf && !pk) return out("generate_terms_review_packet", "Generate the terms-review packet.", G);

    // conf && pk. #2 — ONLY a real draft is issuable. A voided/unknown/future
    // packet status must NEVER fall through to an Issue action. These are
    // governed-correction states: the honest next is to regenerate, blocked
    // with an explicit reason. (Note: 'sent'/'tenant_in_progress'/'submitted'
    // packets are already handled above — this reaches only draft-or-other.)
    if (pk.status === "voided") {
      return out("generate_terms_review_packet", "Regenerate the terms-review packet (prior packet voided).",
        { ...G, state: "blocked", blocker_code: "packet_voided" });
    }
    if (pk.status !== "draft") {
      return out("generate_terms_review_packet", "Regenerate the terms-review packet.",
        { ...G, state: "blocked", blocker_code: "packet_status_not_issuable" });
    }

    // A real draft packet. Blocker precedence: integrity (lineage) before
    // freshness (currency). A historical packet with NULL lineage is NOT
    // treated as a match — it is honestly unproven (§ do not weaken walls).
    if (rv.lineage_matches_current_confirmation !== true) {
      return out("issue_terms_review_link", "Issue the terms-review link.",
        { ...G, state: "blocked",
          blocker_code: (pk.proposed_terms_confirmation_id == null)
            ? "packet_lineage_unproven" : "packet_confirmation_mismatch" });
    }
    if (rv.currency_status === "stale") {
      return out("issue_terms_review_link", "Issue the terms-review link.",
        { ...G, state: "blocked", blocker_code: "packet_stale" });
    }
    return out("issue_terms_review_link", "Issue the terms-review link.", G);
  }

  // Derived operating position (§3) — so no reader quietly recreates the old
  // status equivalence from lease_ready.
  // Slice 1: switch on group_code first — for every existing two-arg call
  // group_code === action_code (identical behavior); if a refined next is
  // ever passed through, the precise middle codes still map to their group.
  function applicationPosition(app, gate) {
    const next = applicationNext(app, gate);
    switch (next.group_code || next.action_code) {
      case "active": return "active";
      case "closed": return "closed_" + app.status;
      case "confirm_term": return "accepted_term_required";
      case "approve": case "review_application": return "pre_approval";
      case "send_terms_for_review": return "approved_terms_pending";
      case "awaiting_acknowledgment": return "approved_awaiting_acknowledgment";
      case "executed_lease_required":
        return (gate && gate.gate_kind === "legacy_activation") ? "legacy_pre_execution" : "terms_acknowledged_execution_required";
      default: return "pre_approval";
    }
  }

  const shape = (app, gate) => {
    const next = applicationNext(app, gate);
    return {
      id: app.id,
      property_id: app.property_id,
      unit_id: app.unit_id,
      person_id: app.person_id,
      status: app.status,               // NON-AUTHORITATIVE (§3) — position + next below are the truth
      application_position: applicationPosition(app, gate),
      application_next: next,
      applicant_name: app.applicant_name,
      unit_label: app.unit_label,
      rent: app.rent == null ? null : Number(app.rent),
      deposit: app.deposit == null ? null : Number(app.deposit),
      guarantor_name: app.guarantor_name,
      applicant_signed_at: app.applicant_signed_at,     // historical evidence (pre-v3 rows)
      guarantor_signed_at: app.guarantor_signed_at,     // historical evidence (pre-v3 rows)
      countersigned_at: app.countersigned_at,
      activated_at: app.activated_at,
      activation_obligation_id: app.activation_obligation_id,     // legacy link, read-only
      terms_review_obligation_id: app.terms_review_obligation_id, // v3 birth link
      outstanding_inputs: gate ? gate.remaining : null,
      next_action: next.label, // back-compat display — SAME resolver, one truth
    };
  };

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
  // ── THE CANONICAL APPROVE SERVICE (v3 birth event; R3: one service, all
  //    adapters — legacy key route, /operator route, demo orchestration).
  //    Approval creates a TERMS_REVIEW obligation (input: terms_acknowledged),
  //    owned by the approval role. It creates NO lease_activation gate, NO
  //    signature inputs, NO countersign input. Status stays 'lease_ready'
  //    (existing vocabulary, §3 non-authoritative). Approve is DURABLE
  //    independent of packet generation (§4: joined, not fused).
  function appErr(status, receipt, extra = {}) {
    const e = new Error(receipt); e.httpStatus = status; e.body = { receipt, ...extra }; return e;
  }
  async function approveApplication(client, { applicationId, approvedByNote = null, actorUserId = null }) {
    const app = await getApp(client, applicationId);
    if (!app) throw appErr(404, "No application with that id.");
    // Idempotency FIRST (before the status refusal): a re-approve of an
    // already-approved application deserves the controlled idempotent 409
    // with its gate ids — not a raw status complaint. EITHER vocabulary
    // counts as approved: pre-v3 historical gate (§9) or v3 terms gate.
    if (app.terms_review_obligation_id || app.activation_obligation_id) {
      throw appErr(409, "Application already approved.", {
        idempotent: true,
        terms_review_obligation_id: app.terms_review_obligation_id || null,
        activation_obligation_id: app.activation_obligation_id || null,
      });
    }
    if (!["submitted", "approved"].includes(app.status)) {
      throw appErr(409, `Cannot approve from status '${app.status}'.`);
    }

    const evId = await recordEvent(client, { property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      type: "application_approved", note: `Application approved${approvedByNote ? " by " + approvedByNote : ""}` });

    // Close the leasing_manager application_approval gate (born at submission)
    // in THIS transaction. Guarded: the legacy direct-create path has no gate.
    if (app.approval_obligation_id && submissionService && submissionService.closeApprovalGate) {
      try {
        await submissionService.closeApprovalGate(client, { app, by_user_id: actorUserId || null, decision: "approved" });
      } catch (e) { /* gate already closed or not rail-linked — non-fatal */ }
    }

    // THE BIRTH EVENT. Owner = the approval role (read from the rail's own
    // config where available — never a second hardcoded comparison).
    const ownerRole = (submissionService && typeof submissionService.approvalGateRole === "function")
      ? submissionService.approvalGateRole() : "leasing_manager";
    const obligation = await spawnObligationFromEvent(client, {
      property_id: app.property_id,
      person_id: app.person_id,
      unit_id: app.unit_id,
      source_event_id: evId,
      related_id: app.id,
      related_type: "lease_application",
      module: "applications",
      type: TERMS_REVIEW_TYPE,
      label: `Review proposed terms — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
      owner_type: "human",
      assigned_role: ownerRole,
      escalates_to_role: "asset_manager",
      status: "open",
      priority: "normal",
      severity: "normal",
      required_inputs: [TERMS_INPUT],
    });

    const upd = await client.query(
      `update lease_applications set status='lease_ready', terms_review_obligation_id=$1, updated_at=now()
         where id=$2 returning *`,
      [obligation.id, app.id]
    );

    // v3 followup: approval is the ONLY authorized cause of the terms-review
    // chase (R1: new rung, never the historical signature rung — a chase for
    // an acknowledgment must not be recorded as a chase for a signature).
    if (app.conversion_id && conversionService && conversionService.ensureTermsReviewFollowup) {
      await conversionService.ensureTermsReviewFollowup(client, { conversion_id: app.conversion_id });
    }

    return { application: upd.rows[0], obligation };
  }

  // Legacy key-gated adapter (Class 2 door — coarse operator-key authority;
  // the role-walled adapter lives at /operator/leasing/.../approve).
  router.post("/applications/:id/approve", async (req, res) => {
    const { approved_by = null } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await approveApplication(client, {
        applicationId: req.params.id, approvedByNote: approved_by, actorUserId: null });
      await client.query("commit");
      const gate = await outstanding(pool, out.application);
      res.json({
        receipt: `Approved. Terms-review packet next for ${out.application.applicant_name}. The resident acknowledges proposed terms; an executed lease is a separate, later fact.`,
        application: shape(out.application, gate),
        terms_review_obligation_id: out.obligation.id,
        terms_review_required_input: [TERMS_INPUT],
      });
    } catch (e) {
      await client.query("rollback");
      if (e.httpStatus) return res.status(e.httpStatus).json(e.body);
      console.error("application approve:", e);
      res.status(500).json({ receipt: "Could not approve the application.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── sign (INTENT — never activates) ───────────────
  // party = 'applicant' | 'guarantor'. Records the signature against the
  // activation obligation. When the tenant side is fully signed, status
  // becomes 'tenant_signed' — but the lease is NOT active. Countersign is
  // still outstanding. This is the legal control made explicit.
  // ─────────────── sign — RETIRED (v3 terms-review correction) ───────────
  // This route recorded a "signature" by satisfying applicant_signature /
  // guarantor_signature on the blended activation gate — the exact semantic
  // equivalence v3 removes: reviewed demonstration terms ≠ signed governing
  // lease. There is no signature system today, so there is no honest thing
  // for this route to record. 410 Gone (not 404): callers deserve the reason.
  // Classification: Class 4 — delete-on-cleanup; kept as an explaining stub
  // one release so old harnesses fail loudly with the truth.
  router.post("/applications/:id/sign", async (req, res) => {
    return res.status(410).json({
      receipt: "Retired. A terms acknowledgment is not a signature, and no lease-execution system exists yet. " +
               "The resident acknowledges proposed terms via the terms-review packet (/t/lease). " +
               "Lease execution arrives with the Executed Lease build (Path B).",
      error: "sign_route_retired",
    });
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
        `select la.*, o.required_inputs as gate_inputs, o.status as gate_status,
                (case when la.terms_review_obligation_id is not null then 'terms_review'
                      when la.activation_obligation_id  is not null then 'legacy_activation' end) as gate_kind,
                pk.id as pk_id, pk.version as pk_version, pk.status as pk_status
           from lease_applications la
           left join obligations o
             on o.id = coalesce(la.terms_review_obligation_id, la.activation_obligation_id)
           left join lateral (
             select id, version, status from lease_packets
              where application_id = la.id and superseded_at is null
              order by version desc limit 1
           ) pk on true
          where la.property_id = $1
          order by la.created_at desc`,
        [req.params.propertyId]
      )).rows;
      const applications = rows.map((r) =>
        shape(r, r.gate_kind
          ? { remaining: r.gate_inputs || [], obligation_status: r.gate_status, gate_kind: r.gate_kind,
              packet: r.pk_id ? { id: r.pk_id, version: r.pk_version, status: r.pk_status } : null }
          : null));
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

  // The canonical service layer — the operator adapter (operator.js) and demo
  // orchestration (demo.js) call THESE, never a second implementation (R3).
  router._service = { approveApplication, applicationNext, applicationPosition, outstanding, shape, getApp, TERMS_REVIEW_TYPE, TERMS_INPUT };

  return router;
};
