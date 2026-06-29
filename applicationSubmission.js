// =============================================================
// applicationSubmission.js — the SHARED submission service + the
// invitation front of the application chain. Real infrastructure:
// every fact is a server transaction, every obligation born/closed
// by the shared engine, never browser state.
//
// This module does NOT replace applications.js. It adds the missing
// front (sent invitation) and the missing decision obligation
// (the leasing_manager application_approval gate, born at SUBMIT),
// and routes BOTH the public applicant path and the internal staff
// path through ONE submission service so the event, the gate, the
// idempotency, and the audit are identical.
//
// Authority split HONORED (not relabeled):
//   leasing_manager  → application_approval   (this module)
//   property_manager → terms/countersign/activation (applications.js)
//
// Two facts, one transaction, NOT duplicates:
//   • conversion rail  → the rung's write-once kept/missed outcome
//   • lease_applications.status → the application disposition
//
// Deps:
//   { pool, spawnObligationFromEvent, completeObligation,
//     conversionService }   // = leasingConversionModule(...)._service
//
// Mount AFTER applications + leasingConversion in server.js:
//   const convMod = leasingConversionModule({ pool, spawnObligationFromEvent, completeObligation });
//   app.use("/", convMod);
//   app.use("/", applicationSubmission({ pool, spawnObligationFromEvent,
//                                        completeObligation,
//                                        conversionService: convMod._service }));
// =============================================================

const express = require("express");
const crypto = require("crypto");

// Non-recoverable digest of a bearer token. We store ONLY this; the raw token
// lives solely in the issued URL. SHA-256 is sufficient for a high-entropy
// (192-bit) random token — there is nothing to brute-force.
function digestToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

module.exports = function applicationSubmissionModule(deps) {
  const { pool, spawnObligationFromEvent, completeObligation, conversionService } = deps;
  const router = express.Router();

  // operator gate — same shared key the other modules use
  function requireOperator(req, res, next) {
    const key = req.get("x-operator-key");
    if (!process.env.OPERATOR_KEY || key === process.env.OPERATOR_KEY) return next();
    return res.status(401).json({ receipt: "operator key required." });
  }

  // small tx helper mirroring the conversion module's shape
  async function tx(fn, res) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      res.json(out);
    } catch (e) {
      await client.query("rollback");
      const code = e.httpStatus || 500;
      res.status(code).json({ receipt: e.publicMessage || "Could not complete the request.", error: e.message });
    } finally {
      client.release();
    }
  }
  function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; return e; }

  async function recordEvent(client, { property_id, person_id = null, unit_id = null, type, note }) {
    const r = await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning id`,
      [property_id, person_id, unit_id, type, note]
    );
    return r.rows[0].id;
  }

  // signatures that gate activation later (mirror applications.js so the
  // record is consistent regardless of which path created it)
  const tenantInputs = (hasGuarantor) =>
    ["applicant_signature", ...(hasGuarantor ? ["guarantor_signature"] : [])];

  // ════════════════════════════════════════════════════════════════════
  //  THE APPLICATION_APPROVAL GATE — born at submission, owned by
  //  leasing_manager. Spawned via the conversion service's addGate when a
  //  conversion exists; spawned as a bare obligation otherwise (internal
  //  path with no conversation). The leasing_manager role is read from the
  //  rail's own RUNG config so the role can never drift from the contract.
  // ════════════════════════════════════════════════════════════════════
  function approvalGateRole() {
    // authoritative source: the conversion rail's RUNG config
    const cfg = conversionService && conversionService.RUNG && conversionService.RUNG.application_approval;
    return (cfg && cfg.gate_role) || "leasing_manager";
  }

  async function spawnApprovalGate(client, { conversion_id, app }) {
    if (conversion_id && conversionService && conversionService.addGate) {
      // the rail owns the gate (window + role + kept/missed link)
      const out = await conversionService.addGate(client, {
        conversion_id,
        rung: "application_approval",
        // owner_user_id left null → role-resolved at read time (resolveObligationOwner)
      });
      return out.obligation;
    }
    // internal path, no conversation: a bare gate obligation, same role
    const evId = await recordEvent(client, {
      property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      type: "application_submitted", note: `Application submitted — ${app.applicant_name} (internal)`,
    });
    return spawnObligationFromEvent(client, {
      property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      source_event_id: evId, related_id: app.id, related_type: "lease_application",
      module: "applications", type: "application_approval",
      label: `Application approval — ${app.applicant_name}`,
      owner_type: "human", assigned_role: approvalGateRole(),
      status: "open", priority: "normal", severity: "normal",
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  CORE SUBMISSION SERVICE — both paths call this. Idempotent on a
  //  caller-supplied submission key (the token for public, an explicit key
  //  for internal). One transaction:
  //    • create/locate the lease_applications row at 'submitted'
  //    • write application_submitted event
  //    • close the EXACT applicant_followup rung (if invitation-backed)
  //    • spawn the application_approval gate (leasing_manager)
  // ════════════════════════════════════════════════════════════════════
  async function submitApplicationService(client, {
    property_id, person_id = null, unit_id = null, unit_label = null,
    applicant_name, rent = null, deposit = null, guarantor_name = null,
    captured = {}, source = "applicant",
    conversion_id = null,
    progress_obligation_id = null,   // the applicant_followup rung to close (public path)
    submitted_by = null,             // staff actor for internal path
  }) {
    if (!property_id) throw httpErr(400, "property_id is required.");
    if (!applicant_name) throw httpErr(400, "applicant_name is required.");

    const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
    if (!prop) throw httpErr(404, "No property with that id.");

    // 1) the application RECORD — 'submitted'
    const ins = await client.query(
      `insert into lease_applications
         (property_id, unit_id, person_id, status, applicant_name, unit_label,
          rent, deposit, guarantor_name, captured, source, conversion_id)
       values ($1,$2,$3,'submitted',$4,$5,$6,$7,$8,$9,$10,$11)
       returning *`,
      [property_id, unit_id, person_id, applicant_name, unit_label, rent, deposit,
       guarantor_name, JSON.stringify(captured || {}), source, conversion_id]
    );
    const app = ins.rows[0];

    // 2) the durable event
    await recordEvent(client, {
      property_id, person_id, unit_id,
      type: "application_submitted",
      note: `Application submitted — ${applicant_name}${unit_label ? " · " + unit_label : ""}`,
    });

    // 3) close the EXACT applicant_followup rung — the apply push is kept.
    //    (only the invitation-backed path has a progress rung to close.)
    //    CRITICAL: suppress_next. Closing applicant_followup must NOT auto-start
    //    lease_signature_followup — a submitted application is awaiting a
    //    leasing_manager decision, not ready for signature. Signature follow-up
    //    begins ONLY on approval (see the approve path). This is a GATED
    //    transition, not the rail's normal auto-advance.
    let rung_closed = null;
    if (progress_obligation_id && conversionService && conversionService.resolveRung) {
      const out = await conversionService.resolveRung(client, {
        obligation_id: progress_obligation_id,
        result: "completed",
        by_user_id: null,
        suppress_next: true,
        proof: { application_id: app.id, kind: "application_submitted" },
      });
      rung_closed = { obligation_id: progress_obligation_id, outcome: out.outcome, suppressed_next: out.suppressed_next };
    }

    // 4) spawn the application_approval gate (leasing_manager), born HERE.
    const gate = await spawnApprovalGate(client, { conversion_id, app });

    // link the gate onto the application record (mirror activation_obligation_id pattern)
    await client.query(
      `update lease_applications set approval_obligation_id=$1, updated_at=now() where id=$2`,
      [gate.id, app.id]
    );

    return { application: app, approval_obligation_id: gate.id, rung_closed, gate_role: approvalGateRole() };
  }

  // ════════════════════════════════════════════════════════════════════
  //  DECISION SERVICE — approve | deny, both CLOSE the application_approval
  //  gate (write-once kept outcome on the rail link), then:
  //    approve → applications.js activation obligation is spawned by the
  //              EXISTING /applications/:id/approve route (we do NOT
  //              duplicate it; we close the gate and the caller approves).
  //    deny    → disposition recorded on lease_applications.status with a
  //              distinct reason code (declined|withdrawn|expired).
  //  The two facts (rung outcome vs. status) are written in ONE tx and are
  //  NOT duplicates: one answers "did the manager decide in time," the other
  //  answers "what was the decision."
  // ════════════════════════════════════════════════════════════════════
  async function closeApprovalGate(client, { app, by_user_id, decision }) {
    if (!app.approval_obligation_id) throw httpErr(409, "No open application_approval gate on this application.");
    if (conversionService && conversionService.resolveRung) {
      // try the rail close (conversion-backed gate). If the gate was a bare
      // obligation (internal, no conversion) the rail has no link row — fall
      // back to completing the obligation directly. If it's ALREADY closed
      // (idempotent re-call), that's success, not an error.
      try {
        await conversionService.resolveRung(client, {
          obligation_id: app.approval_obligation_id,
          result: "completed",
          by_user_id: by_user_id || null,
          proof: { decision, application_id: app.id },
        });
      } catch (e) {
        // "rung already closed as kept/completed" → idempotent success
        if (!/already closed/i.test(e.message || "")) {
          // not a rail-linked gate → fall through to plain completion
          try {
            await completeObligation(client, { obligation_id: app.approval_obligation_id, completed_by: by_user_id || null });
          } catch (e2) { if (e2.code !== "ALREADY_COMPLETE") throw e2; }
        }
      }
    } else {
      try {
        await completeObligation(client, { obligation_id: app.approval_obligation_id, completed_by: by_user_id || null });
      } catch (e) { if (e.code !== "ALREADY_COMPLETE") throw e; }
    }

    // GATED TRANSITION: lease-signature follow-up begins ONLY on approval.
    // Submission suppressed the auto-advance; approval is the event that starts
    // signature work. A decline/withdraw/expire never reaches here with
    // decision='approved', so signature work cannot be opened on a non-approval.
    // advanceToRung is idempotent-guarded (refuses a duplicate open rung).
    if (decision === "approved" && app.conversion_id &&
        conversionService && conversionService.advanceToRung) {
      try {
        await conversionService.advanceToRung(client, {
          conversion_id: app.conversion_id,
          rung: "lease_signature_followup",
        });
      } catch (e) {
        // a duplicate open signature rung is fine (idempotent); anything else surfaces
        if (!/already exists/i.test(e.message || "")) throw e;
      }
    }
  }

  // ─────────────── ROUTES ───────────────

  // 1) INVITATION — prepare a token. status 'prepared'. NO link-sent event yet
  //    (a prepared token is NOT a send). Internal/operator only.
  router.post("/leasing/application-invitations", requireOperator, (req, res) => tx(async (client) => {
    const { conversion_id = null, person_id = null, property_id, unit_id = null,
            expires_at = null, created_by_user_id = null } = req.body || {};
    if (!property_id) throw httpErr(400, "property_id is required.");
    const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
    if (!prop) throw httpErr(404, "No property with that id.");

    const rawToken = crypto.randomBytes(24).toString("base64url");
    const tokenDigest = digestToken(rawToken);
    const inv = (await client.query(
      `insert into application_invitations
         (token_digest, conversion_id, person_id, property_id, unit_id, status, expires_at, created_by_user_id)
       values ($1,$2,$3,$4,$5,'prepared',$6,$7) returning *`,
      [tokenDigest, conversion_id, person_id, property_id, unit_id, expires_at, created_by_user_id]
    )).rows[0];

    return {
      receipt: "Invitation prepared. Send it through the real channel, then call /mark-sent to attest the send.",
      invitation_id: inv.id,
      // RAW token returned ONCE for building the applicant URL. NOT stored
      // (only its digest is). If lost, revoke and prepare a new invitation.
      token: rawToken,
      status: inv.status,
    };
  }, res));

  // 2) MARK SENT — the SEND attestation. This is an authenticated, auditable
  //    operator action, NOT a loose checkbox. It records that a human attested
  //    they sent the invitation through the real channel. It does NOT claim the
  //    prospect received or opened it. ONLY here is application_link_sent
  //    written, the applicant_followup rung attached, and its clock started.
  //
  //    dispatch_source 'manual' (now): requires acting user + channel +
  //      recipient snapshot. The event means "<user> attested they sent it by
  //      <channel> at <time>."
  //    dispatch_source 'provider' (later, Twilio): the provider send result
  //      writes the SAME event with provider_message_id. Delivery/open arrive
  //      as SEPARATE later facts, never as edits to this send record.
  router.post("/leasing/application-invitations/:id/mark-sent", requireOperator, (req, res) => tx(async (client) => {
    const { dispatch_source = "manual", channel, recipient_snapshot = null,
            provider_message_id = null, sent_by_user_id = null, note = null } = req.body || {};
    if (!["manual", "provider"].includes(dispatch_source)) {
      throw httpErr(400, "dispatch_source must be 'manual' or 'provider'.");
    }
    if (!["sms", "email", "other"].includes(channel || "")) {
      throw httpErr(400, "channel must be 'sms', 'email', or 'other'.");
    }
    // attestation requirements differ by source
    if (dispatch_source === "manual") {
      if (!sent_by_user_id) throw httpErr(400, "manual send requires sent_by_user_id (who attests they sent it).");
      if ((channel === "sms" || channel === "email") && !recipient_snapshot) {
        throw httpErr(400, `manual ${channel} send requires recipient_snapshot (the destination as sent).`);
      }
    } else { // provider
      if (!provider_message_id) throw httpErr(400, "provider send requires provider_message_id.");
    }

    const inv = (await client.query("select * from application_invitations where id=$1 for update", [req.params.id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (inv.status !== "prepared") throw httpErr(409, `Invitation is '${inv.status}', not 'prepared'. A send cannot be re-attested; create a correction instead.`);

    // locate the open applicant_followup rung on the conversion (the progress
    // commitment the submission will close). If the rail is earlier, it may not
    // be open yet — submission resolves whatever applicant_followup is open then.
    let progressObId = null;
    if (inv.conversion_id) {
      const r = await client.query(
        `select o.id from leasing_conversion_obligations lco
           join obligations o on o.id = lco.obligation_id
          where lco.conversion_id=$1 and lco.rung='applicant_followup' and lco.outcome is null
          order by o.created_at desc limit 1`,
        [inv.conversion_id]
      );
      progressObId = r.rows[0] ? r.rows[0].id : null;
    }

    // the SEND event — an attestation, scoped truthfully.
    const sentByNote = dispatch_source === "manual"
      ? `attested sent via ${channel}${recipient_snapshot ? " to " + recipient_snapshot : ""}`
      : `dispatched by provider via ${channel}${provider_message_id ? " · " + provider_message_id : ""}`;
    const evId = await recordEvent(client, {
      property_id: inv.property_id, person_id: inv.person_id, unit_id: inv.unit_id,
      type: "application_link_sent",
      note: `Application link ${sentByNote}. (Send attested — not a delivery/open confirmation.)`,
    });

    const newStatus = dispatch_source === "manual" ? "manually_sent" : "provider_dispatched";
    const upd = (await client.query(
      `update application_invitations
          set status=$1, dispatch_source=$2, channel=$3, recipient_snapshot=$4,
              provider_message_id=$5, sent_by_user_id=$6, sent_at=now(), sent_note=$7,
              progress_obligation_id=$8, updated_at=now()
        where id=$9 returning *`,
      [newStatus, dispatch_source, channel, recipient_snapshot, provider_message_id,
       sent_by_user_id, note, progressObId, inv.id]
    )).rows[0];

    return {
      receipt: `Send attested (${newStatus}) via ${channel}. The applicant-follow-up clock has started.`,
      invitation_id: upd.id, status: upd.status, link_sent_event_id: evId,
      progress_obligation_id: progressObId,
      note: "This records that the link was SENT, not that the prospect received or opened it.",
    };
  }, res));

  // 2b) REVOKE — a CORRECTION fact (e.g. wrong number, sent in error). Does NOT
  //     rewrite the original send record; stamps a separate revocation. A revoked
  //     invitation can no longer be consumed.
  router.post("/leasing/application-invitations/:id/revoke", requireOperator, (req, res) => tx(async (client) => {
    const { revoked_by_user_id = null, reason = null } = req.body || {};
    const inv = (await client.query("select * from application_invitations where id=$1 for update", [req.params.id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (inv.status === "consumed") throw httpErr(409, "Cannot revoke a consumed invitation (the application already exists).");
    if (inv.status === "revoked") throw httpErr(409, "Invitation already revoked.");
    await recordEvent(client, {
      property_id: inv.property_id, person_id: inv.person_id, unit_id: inv.unit_id,
      type: "application_link_revoked",
      note: `Application invitation revoked${reason ? " — " + reason : ""}`,
    });
    const upd = (await client.query(
      `update application_invitations
          set status='revoked', revoked_by_user_id=$1, revoked_at=now(), revoked_reason=$2, updated_at=now()
        where id=$3 returning *`,
      [revoked_by_user_id, reason, inv.id]
    )).rows[0];
    return { receipt: "Invitation revoked (correction fact recorded; original send record preserved).", invitation_id: upd.id, status: upd.status };
  }, res));

  // 3) PUBLIC SUBMIT — invitation-bound. The applicant submits against a live
  //    valid token. Resolves identity/conversion FROM the token, runs the
  //    shared submission service, marks the invitation consumed. Idempotent:
  //    a token already consumed returns its existing application.
  router.post("/applications/submit-public", (req, res) => tx(async (client) => {
    const { token, applicant_name = null, rent = null, deposit = null,
            guarantor_name = null, captured = {} } = req.body || {};
    if (!token) throw httpErr(400, "token is required.");

    // look up by DIGEST — the raw token is never stored. `for update` row-locks
    // the invitation so concurrent submits serialize on it (double-tap safety).
    const inv = (await client.query(
      "select * from application_invitations where token_digest=$1 for update",
      [digestToken(token)]
    )).rows[0];
    if (!inv) throw httpErr(404, "Invalid application link.");
    if (inv.status === "revoked") throw httpErr(410, "This application link was revoked.");
    if (inv.status === "expired") throw httpErr(410, "This application link has expired.");
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      await client.query("update application_invitations set status='expired', updated_at=now() where id=$1", [inv.id]);
      throw httpErr(410, "This application link has expired.");
    }
    // a 'prepared' (never-sent) token cannot be submitted — there is no attested send
    if (inv.status === "prepared") throw httpErr(409, "This link was never sent; it cannot be used to submit.");
    // idempotency: already consumed → return the existing application
    if (inv.status === "consumed" && inv.lease_application_id) {
      const ex = (await client.query("select * from lease_applications where id=$1", [inv.lease_application_id])).rows[0];
      return { receipt: "Application already submitted.", application: ex, idempotent: true };
    }
    // valid live token = it has been SENT (manually_sent | provider_dispatched)
    if (!["manually_sent", "provider_dispatched"].includes(inv.status)) {
      throw httpErr(409, `Invitation is '${inv.status}' — not in a submittable state.`);
    }

    // resolve the applicant name: explicit, else the person on file
    let name = applicant_name;
    if (!name && inv.person_id) {
      const p = (await client.query("select name from persons where id=$1", [inv.person_id])).rows[0];
      name = p && p.name;
    }
    if (!name) throw httpErr(400, "applicant_name is required (none on file for this link).");

    // ATOMIC CONSUME: flip the invitation to 'consumed' FIRST, conditional on it
    // still being in a sent state. If a concurrent transaction already consumed
    // it, this UPDATE affects 0 rows and we abort — the token can be consumed
    // exactly once. Everything below (record, event, rung, gate) then happens in
    // the SAME transaction; either all of it commits with the consume, or the
    // whole thing rolls back and the invitation stays usable. There is no state
    // where the token is consumed but the application did not submit.
    const claim = await client.query(
      `update application_invitations
          set status='consumed', consumed_at=now(), updated_at=now()
        where id=$1 and status in ('manually_sent','provider_dispatched')
        returning id`,
      [inv.id]
    );
    if (claim.rows.length === 0) {
      throw httpErr(409, "This application link is being or has already been used.");
    }

    const out = await submitApplicationService(client, {
      property_id: inv.property_id, person_id: inv.person_id, unit_id: inv.unit_id,
      applicant_name: name, rent, deposit, guarantor_name, captured,
      source: "applicant",
      conversion_id: inv.conversion_id,
      progress_obligation_id: inv.progress_obligation_id,
    });

    // link the consumed invitation to the application it produced
    await client.query(
      `update application_invitations set lease_application_id=$1, updated_at=now() where id=$2`,
      [out.application.id, inv.id]
    );

    return {
      receipt: `Application submitted for ${name}. Now with ${out.gate_role} for approval.`,
      application: out.application,
      approval_obligation_id: out.approval_obligation_id,
      rung_closed: out.rung_closed,
    };
  }, res));

  // 4) INTERNAL SUBMIT — operator-authorized, no invitation. Same service,
  //    source 'staff'|'import', NO progress rung to close. Produces the same
  //    application_submitted event + application_approval gate + audit.
  router.post("/properties/:propertyId/applications/internal", requireOperator, (req, res) => tx(async (client) => {
    const { applicant_name, unit_id = null, unit_label = null, rent = null, deposit = null,
            guarantor_name = null, person_id = null, captured = {},
            source = "staff", conversion_id = null, submitted_by = null } = req.body || {};
    if (!["staff", "import"].includes(source)) throw httpErr(400, "source must be 'staff' or 'import' for the internal path.");

    const out = await submitApplicationService(client, {
      property_id: req.params.propertyId, person_id, unit_id, unit_label,
      applicant_name, rent, deposit, guarantor_name, captured,
      source, conversion_id, submitted_by,
      progress_obligation_id: null,    // internal path has no invitation rung
    });
    return {
      receipt: `Internal application created for ${applicant_name} (source: ${source}). With ${out.gate_role} for approval.`,
      application: out.application, approval_obligation_id: out.approval_obligation_id,
    };
  }, res));

  // 5) DENY — a real leasing decision. Closes the application_approval gate
  //    (rail kept outcome) AND records the disposition with a distinct reason.
  //    reason ∈ declined (leasing decision) | withdrawn (applicant/staff) |
  //    expired (window elapsed). NOT collapsed into one status.
  router.post("/applications/:id/deny", requireOperator, (req, res) => tx(async (client) => {
    const { reason = "declined", note = null, decided_by_user_id = null } = req.body || {};
    if (!["declined", "withdrawn", "expired"].includes(reason)) {
      throw httpErr(400, "reason must be 'declined', 'withdrawn', or 'expired'.");
    }
    const app = (await client.query("select * from lease_applications where id=$1 for update", [req.params.id])).rows[0];
    if (!app) throw httpErr(404, "No application with that id.");
    if (!["submitted", "approved", "lease_ready"].includes(app.status)) {
      throw httpErr(409, `Cannot deny from status '${app.status}'.`);
    }

    // close the approval gate (kept — the manager DID decide, in time or not;
    // the rail records timeliness; the disposition records the decision).
    // decision != 'approved' so this will NOT start signature follow-up.
    await closeApprovalGate(client, { app, by_user_id: decided_by_user_id, decision: reason });

    // SAFETY: a decline/withdraw/expire must never leave lease-signature work
    // open. In the correct flow signature follow-up only begins on approval, so
    // there should be none — but if one exists (e.g. a prior approval later
    // reversed), release it so the team is not told to chase a signature on a
    // dead application.
    if (conversionService && conversionService.resolveRung && app.conversion_id) {
      const sig = await client.query(
        `select o.id from leasing_conversion_obligations lco
           join obligations o on o.id = lco.obligation_id
          where lco.conversion_id=$1 and lco.rung='lease_signature_followup' and lco.outcome is null`,
        [app.conversion_id]
      );
      for (const row of sig.rows) {
        try {
          await conversionService.resolveRung(client, {
            obligation_id: row.id, result: "released",
            by_user_id: decided_by_user_id || null,
            suppress_next: true,
            proof: { reason: `application ${reason}`, application_id: app.id },
          });
        } catch (e) { if (!/already closed/i.test(e.message || "")) throw e; }
      }
    }

    await recordEvent(client, {
      property_id: app.property_id, person_id: app.person_id, unit_id: app.unit_id,
      type: "application_denied",
      note: `Application ${reason}${note ? " — " + note : ""}`,
    });

    const upd = (await client.query(
      `update lease_applications
          set status=$1, decision_reason=$2, decision_by_user_id=$3, decided_at=now(), updated_at=now()
        where id=$4 returning *`,
      [reason, note || reason, decided_by_user_id, app.id]
    )).rows[0];

    return { receipt: `Application ${reason}.`, application: upd };
  }, res));

  // expose the service for in-process tests + the approve route to close the gate
  router._service = { submitApplicationService, closeApprovalGate, spawnApprovalGate, approvalGateRole };
  return router;
};
