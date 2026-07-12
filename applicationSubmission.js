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
  const { pool, spawnObligationFromEvent, completeObligation, conversionService, commBoundary = null } = deps;
  const router = express.Router();

  // operator gate — shared key. LEGACY: this shared-key gate and the routes under
  // it are MARKED FOR RETIREMENT. The permanent live-operator entry point is
  // operator.js's POST /operator/leasing/application-invitations (staff-session,
  // server-derived actor), which calls this module's invitation service. These
  // legacy routes stay untouched until their remaining callers are migrated.
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
  // plain transaction for SERVICES (no res): begin/commit/rollback, returns fn's value
  async function runTx(fn) {
    const client = await pool.connect();
    try { await client.query("begin"); const out = await fn(client); await client.query("commit"); return out; }
    catch (e) { try { await client.query("rollback"); } catch (_) {} throw e; }
    finally { client.release(); }
  }

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

    // ONE CREATOR (reviewer ruling §2, Jul 4 2026): signature-chasing work is
    // created ONLY by ensureLeaseSignatureFollowup, called by the approve
    // transaction AFTER it writes the application's post-approval status —
    // because the creator SELF-VERIFIES approval with its own read, and the
    // 068 unique index makes double-creation impossible. The old advanceToRung
    // spawn here ran while status was still 'submitted' and carried no
    // verification; it is removed, not relocated. Gate close = decision
    // recorded; creation belongs to the approver.
  }

  // ─────────────── ROUTES ───────────────

  // 1) INVITATION — prepare a token. status 'prepared'. NO link-sent event yet
  //    (a prepared token is NOT a send). Internal/operator only.
  // CREATE-PREPARED SERVICE (shared): create a 'prepared' invitation for a
  // person/property/unit. Enforces the property wall on the unit. Returns the
  // raw token ONCE (for building the applicant URL) — digest-only at rest. A
  // prepared token is NOT a send. BOTH the legacy shared-key route and the new
  // staff-session operator route call this ONE service — no duplicated logic.
  async function createPreparedInvitation(client, {
    conversion_id = null, person_id = null, property_id, unit_id = null,
    expires_at = null, created_by_user_id = null,
  }) {
    if (!property_id) throw httpErr(400, "property_id is required.");
    const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
    if (!prop) throw httpErr(404, "No property with that id.");
    // PROPERTY WALL: a supplied unit must belong to THIS property.
    if (unit_id) {
      const u = (await client.query("select property_id from units where id=$1", [unit_id])).rows[0];
      if (!u) throw httpErr(404, "No unit with that id.");
      if (u.property_id !== property_id) throw httpErr(403, "That unit belongs to a different property.");
    }
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
      token: rawToken,          // RAW token returned ONCE — digest-only at rest.
      status: inv.status,
    };
  }

  router.post("/leasing/application-invitations", requireOperator, (req, res) => tx(async (client) => {
    return await createPreparedInvitation(client, req.body || {});
  }, res));


  // ── CANONICAL SERVICE (funnel-flow 3a): createAndDispatchApplicationInvitation ──
  //  ONE service defines what "application link dispatched" means, whoever
  //  invokes it (operator route today; agent/review workflows later):
  //    authorize → validate person+unit belong to property → create prepared
  //    invitation (raw token in hand THIS call only — digest-only storage
  //    means dispatch cannot happen later without a new invitation) → build
  //    the PUBLIC applicant URL → save-first outbound comm_event → send
  //    through the communications boundary → on accepted transport, write the
  //    SAME provider attestation mark-sent defines → on refusal, invitation
  //    stays 'prepared' with an honest receipt and NO sent-state.
  //  prepared ≠ dispatched · transport-accepted ≠ received. Both kept.
  async function createAndDispatchApplicationInvitation({
    property_id, person_id, unit_id = null, conversion_id = null,
    expires_at = null, created_by_user_id = null, message_prefix = null,
    resume_invitation_id = null,
  }) {
    if (!commBoundary) return { dispatched: false, reason: "boundary_not_wired" };

    // ── RESUME / CRASH RECONCILIATION ─────────────────────────────────
    // One invitation ⇒ at most one accepted dispatch. If a prior attempt
    // crashed after Twilio accepted but before the attestation landed,
    // resume re-reads the bound comm_event: the gate's already-sent guard
    // returns the existing sid with NO second wire attempt, and the
    // attestation is completed. A resume of an already-attested invitation
    // is an idempotent success.
    if (resume_invitation_id) {
      const inv = (await pool.query(`select * from application_invitations where id=$1`, [resume_invitation_id])).rows[0];
      if (!inv) return { dispatched: false, reason: "invitation_not_found" };
      if (inv.status === "provider_dispatched") {
        return { dispatched: true, invitation_id: inv.id, status: inv.status,
                 provider_message_id: inv.provider_message_id, idempotent: true,
                 receipt: "Already dispatched — no new send (idempotent)." };
      }
      if (inv.status !== "prepared" || !inv.dispatch_comm_event_id) {
        return { dispatched: false, reason: `not_resumable_status_${inv.status}`, invitation_id: inv.id, status: inv.status };
      }
      const evt = (await pool.query(`select id, body from comm_events where id=$1`, [inv.dispatch_comm_event_id])).rows[0];
      const per = (await pool.query(`select phone from persons where id=$1`, [inv.person_id])).rows[0] || {};
      if (!per.phone) return { dispatched: false, reason: "no_phone_on_person", invitation_id: inv.id, status: inv.status };
      const wire = await commBoundary.sendPropertySms({
        property_id: inv.property_id, recipient: per.phone, body: evt.body,
        purpose: "application_link", person_id: inv.person_id, eventId: evt.id,
        actor_user_id: created_by_user_id || null,
      });
      if (!wire.sent) {
        return { dispatched: false, reason: wire.reason, invitation_id: inv.id, status: inv.status };
      }
      const att = await runTx(async (client) => {
        const evId = await recordEvent(client, {
          property_id: inv.property_id, person_id: inv.person_id, unit_id: inv.unit_id,
          type: "application_link_sent",
          note: `Application link dispatched by provider via sms · ${wire.sid}. (Send attested — not a delivery/open confirmation.)`,
        });
        const upd = (await client.query(
          `update application_invitations
              set status='provider_dispatched', dispatch_source='provider', channel='sms',
                  provider_message_id=$1, sent_by_user_id=$2, sent_at=now(), updated_at=now()
            where id=$3 and status='prepared' returning *`,
          [wire.sid, created_by_user_id, inv.id]
        )).rows[0];
        return { evId, status: (upd && upd.status) || "provider_dispatched" };
      });
      return { dispatched: true, invitation_id: inv.id, status: att.status,
               provider_message_id: wire.sid, resumed: true, link_sent_event_id: att.evId,
               receipt: wire.reason === "already_sent"
                 ? "Recovered: prior accepted send reconciled into the invitation — no second text."
                 : "Application link dispatched (resumed)." };
    }
    // PUBLIC URL BASE: the applicant-facing route may not live on the API
    // origin. Named env, fail-closed when absent — never assume.
    const base = (process.env.PUBLIC_APPLY_BASE_URL || "").trim().replace(/\/$/, "");
    if (!base) return { dispatched: false, reason: "public_apply_base_url_not_configured" };

    // Phase 1 (txn): validate + create prepared invitation + save-first comm_event.
    const made = await runTx(async (client) => {
      const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
      if (!prop) throw httpErr(404, "No property with that id.");
      const per = (await client.query("select id, phone from persons where id=$1", [person_id])).rows[0];
      if (!per) throw httpErr(404, "No person with that id.");
      if (unit_id) {
        const u = (await client.query("select property_id from units where id=$1", [unit_id])).rows[0];
        if (!u) throw httpErr(404, "No unit with that id.");
        if (u.property_id !== property_id) throw httpErr(403, "That unit belongs to a different property.");
      }
      const rawToken = crypto.randomBytes(24).toString("base64url");
      const inv = (await client.query(
        `insert into application_invitations
           (token_digest, conversion_id, person_id, property_id, unit_id, status, expires_at, created_by_user_id)
         values ($1,$2,$3,$4,$5,'prepared',$6,$7) returning *`,
        [digestToken(rawToken), conversion_id, person_id, property_id, unit_id, expires_at, created_by_user_id]
      )).rows[0];
      const url = `${base}/apply/${rawToken}`;
      const body = `${message_prefix ? message_prefix + " " : ""}Here's your secure application link: ${url}`;
      const evt = (await client.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role, sent_by_user_id)
         values ($1,$2,$3,null,'text','outbound',$4,'leasing','agent',$5) returning id`,
        [property_id, person_id, unit_id, body, created_by_user_id]
      )).rows[0];
      // stable dispatch identity: one invitation ⇔ one save-first event
      await client.query(`update application_invitations set dispatch_comm_event_id=$1 where id=$2`, [evt.id, inv.id]);
      return { inv, url, body, evt_id: evt.id, phone: per.phone || null };
    });

    // Phase 2: the ONE gate. No raw transport, ever.
    if (!made.phone) {
      return { dispatched: false, reason: "no_phone_on_person", invitation_id: made.inv.id, status: "prepared" };
    }
    const wire = await commBoundary.sendPropertySms({
      property_id, recipient: made.phone, body: made.body,
      purpose: "application_link", person_id, eventId: made.evt_id,
      actor_user_id: created_by_user_id || null,
    });

    if (!wire.sent) {
      // HONEST REFUSAL: the raw token existed only in this call — a
      // 'prepared' status would falsely imply this invitation can still
      // be dispatched later. It cannot. Revoke it in the correction path;
      // eligibility later requires a FRESH invitation.
      await runTx(async (client) => {
        await client.query(
          `update application_invitations
              set status='revoked', revoked_by_user_id=$1, revoked_at=now(),
                  revoked_reason=$2, updated_at=now()
            where id=$3 and status='prepared'`,
          [created_by_user_id, `dispatch refused by communications gate: ${wire.reason}`, made.inv.id]
        );
      });
      return { dispatched: false, reason: wire.reason, invitation_id: made.inv.id,
               status: "revoked", retry_requires_new_invitation: true, comm_event_id: made.evt_id,
               receipt: `Dispatch refused (${wire.reason}). Invitation revoked — a new invitation is required when sending becomes eligible.` };
    }

    // Phase 3 (txn): accepted transport → the SAME provider attestation.
    const attested = await runTx(async (client) => {
      const evId = await recordEvent(client, {
        property_id, person_id, unit_id,
        type: "application_link_sent",
        note: `Application link dispatched by provider via sms · ${wire.sid}. (Send attested — not a delivery/open confirmation.)`,
      });
      const upd = (await client.query(
        `update application_invitations
            set status='provider_dispatched', dispatch_source='provider', channel='sms',
                provider_message_id=$1, sent_by_user_id=$2, sent_at=now(), updated_at=now()
          where id=$3 and status='prepared' returning *`,
        [wire.sid, created_by_user_id, made.inv.id]
      )).rows[0];
      return { evId, status: (upd && upd.status) || "provider_dispatched" };
    });

    return { dispatched: true, invitation_id: made.inv.id, status: attested.status,
             provider_message_id: wire.sid, comm_event_id: made.evt_id, link_sent_event_id: attested.evId,
             receipt: "Application link dispatched through the communications boundary (transport accepted — delivery arrives as a separate fact)." };
  }

  // 1b) CREATE + DISPATCH — the governed one-call path (operator-gated).
  router.post("/leasing/application-invitations/dispatch", requireOperator, async (req, res) => {
    try {
      const out = await createAndDispatchApplicationInvitation(req.body || {});
      const code = out.dispatched ? 200 : 409;
      return res.status(out.reason === "boundary_not_wired" || out.reason === "public_apply_base_url_not_configured" ? 503 : code).json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

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
  // ATTEST-SENT SERVICE (shared): record a truthful send attestation on a
  // 'prepared' invitation. manual → requires sent_by_user_id (who attests) +
  // recipient_snapshot for sms/email → status 'manually_sent'. provider →
  // provider_message_id → 'provider_dispatched'. A send cannot be re-attested.
  // BOTH the legacy route and the new operator route call this ONE service.
  async function attestInvitationSent(client, {
    invitation_id, dispatch_source = "manual", channel, recipient_snapshot = null,
    provider_message_id = null, sent_by_user_id = null, note = null,
  }) {
    if (!["manual", "provider"].includes(dispatch_source)) {
      throw httpErr(400, "dispatch_source must be 'manual' or 'provider'.");
    }
    if (!["sms", "email", "other"].includes(channel || "")) {
      throw httpErr(400, "channel must be 'sms', 'email', or 'other'.");
    }
    if (dispatch_source === "manual") {
      if (!sent_by_user_id) throw httpErr(400, "manual send requires sent_by_user_id (who attests they sent it).");
      if ((channel === "sms" || channel === "email") && !recipient_snapshot) {
        throw httpErr(400, `manual ${channel} send requires recipient_snapshot (the destination as sent).`);
      }
    } else {
      if (!provider_message_id) throw httpErr(400, "provider send requires provider_message_id.");
    }

    const inv = (await client.query("select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (inv.status !== "prepared") throw httpErr(409, `Invitation is '${inv.status}', not 'prepared'. A send cannot be re-attested; create a correction instead.`);

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

    // THE TRANSITION FACT: an actually-sent invitation advances this leasing
    // opportunity from Post-Tour into Applicants. The conversion rail is the
    // authority — we ASK it to ensure the applicant_followup rung (idempotent,
    // conversion-scoped); the invitation module never spawns rungs itself. Same
    // transaction, so it sees the sent status we just wrote. Prepared invitations
  // ── THE ONE APPLICANTS TRANSITION — shared by BOTH legitimate send sources ──
  //  (manual attest AND provider SMS dispatch). Given a conversion whose
  //  invitation just reached a SENT state, this advances the leasing
  //  opportunity Post-Tour → Applicants: ensure the applicant_followup rung
  //  (idempotent, conversion-scoped) AND close the open tour_followup rung in
  //  the SAME transaction, so the opportunity is never in two buckets. One
  //  transition mechanism, two send sources. Only advances when the invitation
  //  belongs to a conversion. Returns a summary, or null.
  //
  //  resolution_basis: closing the tour rung requires a basis when the closer
  //  does NOT own it. The sender may be covering another owner's follow-up
  //  (the common case), so we pass 'coverage' when a human closes work they
  //  don't own; the rail records 'owner' automatically when they do, and a
  //  null actor (service close) is exempt. This is the honest attribution the
  //  rail demands — never a silent close.
  async function advanceOpportunityToApplicants(client, { conversion_id, invitation_id, by_user_id = null }) {
    if (!conversion_id || !conversionService || !conversionService.ensureApplicantFollowup) return null;
    const ens = await conversionService.ensureApplicantFollowup(client, { conversion_id });
    const out = { ensured: ens.ensured, rung: ens.link && ens.link.rung, obligation_id: ens.link && ens.link.obligation_id };
    if (conversionService.resolveRung) {
      const openTour = (await client.query(
        `select lco.obligation_id, lco.owner_user_id from leasing_conversion_obligations lco
          where lco.conversion_id=$1 and lco.rung='tour_followup' and lco.outcome is null
          limit 1`, [conversion_id])).rows[0];
      if (openTour) {
        // basis: 'coverage' only when an identified human is closing work they
        // don't own; owner/service-close cases the rail resolves itself.
        const closerOwns = by_user_id != null && openTour.owner_user_id != null && String(openTour.owner_user_id) === String(by_user_id);
        const needsBasis = by_user_id != null && !closerOwns;
        const closed = await conversionService.resolveRung(client, {
          obligation_id: openTour.obligation_id,
          result: "completed",
          by_user_id: by_user_id || null,
          suppress_next: true,
          resolution_basis: needsBasis ? "coverage" : null,
          proof: { invitation_id, kind: "application_link_sent" },
        });
        out.tour_followup_closed = { obligation_id: openTour.obligation_id, outcome: closed.outcome };
      }
    }
    return out;
  }

  // never reach here. Only advances when this invitation belongs to a conversion.
    let applicant_followup = null;
    if (inv.conversion_id) {
      applicant_followup = await advanceOpportunityToApplicants(client, {
        conversion_id: inv.conversion_id, invitation_id: inv.id, by_user_id: sent_by_user_id || null });
    }

    return {
      receipt: `Send attested (${newStatus}) via ${channel}. The applicant-follow-up clock has started.`,
      invitation_id: upd.id, status: upd.status, link_sent_event_id: evId,
      progress_obligation_id: progressObId,
      applicant_followup,   // the Post-Tour → Applicants transition, or null if no conversion
      note: "This records that the link was SENT, not that the prospect received or opened it.",
    };
  }

  router.post("/leasing/application-invitations/:id/mark-sent", requireOperator, (req, res) => tx(async (client) => {
    return await attestInvitationSent(client, Object.assign({ invitation_id: req.params.id }, req.body || {}));
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
            // an identified human releasing WORK they do not own states the
            // truthful basis: the application is dead, the work is moot.
            resolution_basis: "no_longer_needed",
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
  // ════════════════════════════════════════════════════════════════
  //  TENANT-FACING APPLICATION SURFACE  (under /t/ — no operator gate)
  //  Two routes: the context resolver the page reads, and the page itself.
  //  Authority for what unit/property/economics apply is DERIVED from the
  //  invitation server-side; the browser never supplies it. Submission goes
  //  through the existing /applications/submit-public (unchanged).
  // ════════════════════════════════════════════════════════════════

  // Shared read-only invitation resolver for the tenant surface. Mirrors the
  // submit route's validation, but takes NO lock and writes nothing (except the
  // honest lazy expire flip, which is safe/idempotent). Returns a shape the
  // page renders, plus an honest `state` the page branches on.
  async function resolveTenantContext(client, rawToken) {
    const inv = (await client.query(
      "select * from application_invitations where token_digest=$1",
      [digestToken(rawToken)]
    )).rows[0];
    if (!inv) return { state: "invalid", receipt: "This application link is not valid." };
    if (inv.status === "revoked") return { state: "revoked", receipt: "This application link was revoked. Contact the leasing office." };
    if (inv.status === "expired") return { state: "expired", receipt: "This application link has expired. Contact the leasing office for a new one." };
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      await client.query("update application_invitations set status='expired', updated_at=now() where id=$1", [inv.id]);
      return { state: "expired", receipt: "This application link has expired. Contact the leasing office for a new one." };
    }
    if (inv.status === "prepared") return { state: "not_sent", receipt: "This link is not active yet." };
    if (inv.status === "consumed") return { state: "already_submitted", receipt: "This application has already been submitted. The leasing team has it." };
    if (!["manually_sent", "provider_dispatched"].includes(inv.status)) {
      return { state: "unavailable", receipt: `This link is not currently open (${inv.status}).` };
    }

    // live token → resolve the display context, all server-derived from the invitation
    const prop = inv.property_id
      ? (await client.query("select id, name from properties where id=$1", [inv.property_id])).rows[0]
      : null;
    let unitLabel = null;
    if (inv.unit_id) {
      const u = (await client.query("select unit_number from units where id=$1", [inv.unit_id])).rows[0];
      unitLabel = u ? u.unit_number : null;
    }
    // known person → prefill (recognition over re-entry). Honest nulls if absent.
    let person = null;
    if (inv.person_id) {
      const p = (await client.query("select id, name, email, phone from persons where id=$1", [inv.person_id])).rows[0];
      if (p) person = { name: p.name || null, email: p.email || null, phone: p.phone || null };
    }
    // prefill from the most recent lead's raw_payload (same source prospectVitals uses)
    let prefill = { move_month: null };
    if (inv.person_id && inv.property_id) {
      const lead = (await client.query(
        "select raw_payload from leasing_leads where person_id=$1 and property_id=$2 order by created_at desc limit 1",
        [inv.person_id, inv.property_id])).rows[0];
      try {
        const rp = lead && lead.raw_payload
          ? (typeof lead.raw_payload === "string" ? JSON.parse(lead.raw_payload) : lead.raw_payload) : null;
        if (rp && rp.desired_move_month) prefill.move_month = rp.desired_move_month;
      } catch (_) { /* honest null beats a bad parse */ }
    }
    return {
      state: "open",
      property_name: prop ? prop.name : null,
      unit_label: unitLabel,
      person, prefill,
    };
  }

  // Context the page reads. Read-only; the page renders `state` honestly.
  router.get("/t/application/:token/context", (req, res) => tx(async (client) => {
    return await resolveTenantContext(client, req.params.token);
  }, res));

  // The mobile application page. Self-contained inline HTML (no file dependency).
  // It reads /context, prefills, collects only missing info in short sections,
  // and POSTs to the existing /applications/submit-public.
  router.get("/t/application/:token", (req, res) => {
    const token = String(req.params.token).replace(/[^A-Za-z0-9_\-]/g, "");
    res.set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Apply</title>
<style>
  :root{ --ink:#0b0b0b; --line:#e6e5e0; --muted:#8a8a84; --brass:#9a6b1f; --good:#1d6b54; --bad:#b23b2e; --bg:#faf9f6; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; color:var(--ink); background:var(--bg); -webkit-font-smoothing:antialiased; }
  .wrap{ max-width:520px; margin:0 auto; min-height:100vh; background:#fff; }
  header{ padding:34px 22px 22px; border-bottom:1px solid var(--line); }
  .kicker{ font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
  h1{ font-family:Fraunces,Georgia,serif; font-weight:600; font-size:30px; line-height:1.1; margin:0; }
  .sub{ font-size:15px; color:var(--muted); margin:6px 0 0; }
  main{ padding:22px; }
  .prog{ display:flex; gap:6px; margin:0 0 22px; }
  .prog i{ height:3px; flex:1; background:var(--line); border-radius:2px; }
  .prog i.on{ background:var(--ink); }
  .sec{ display:none; }
  .sec.on{ display:block; }
  .sec h2{ font-family:Fraunces,Georgia,serif; font-weight:600; font-size:20px; margin:0 0 4px; }
  .sec p.hint{ font-size:13px; color:var(--muted); margin:0 0 18px; }
  label{ display:block; font-size:13px; font-weight:600; margin:16px 0 6px; }
  input,select{ width:100%; font:inherit; font-size:16px; padding:13px 14px; border:1px solid var(--line); border-radius:11px; background:#fff; color:var(--ink); }
  input:focus,select:focus{ outline:none; border-color:#2563a8; }
  .row2{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .known{ background:var(--bg); border:1px solid var(--line); border-radius:11px; padding:12px 14px; font-size:14px; margin:0 0 6px; }
  .known b{ font-weight:600; } .known span{ color:var(--muted); }
  .cta{ appearance:none; border:none; width:100%; background:var(--ink); color:#fff; font:inherit; font-size:16px; font-weight:600; padding:15px; border-radius:12px; margin-top:26px; cursor:pointer; }
  .cta[disabled]{ opacity:.4; cursor:default; }
  .back{ appearance:none; border:none; background:none; color:var(--muted); font:inherit; font-size:14px; padding:14px 0 0; cursor:pointer; }
  .review dl{ margin:0; } .review .rr{ display:flex; justify-content:space-between; gap:14px; padding:11px 0; border-bottom:1px solid var(--line); font-size:14px; }
  .review .rr span{ color:var(--muted); } .review .rr b{ font-weight:600; text-align:right; }
  .msg{ padding:40px 24px; text-align:center; }
  .msg .ic{ font-size:40px; } .msg h1{ margin:14px 0 8px; } .msg p{ color:var(--muted); font-size:15px; }
  .foot{ font-size:12px; color:var(--muted); text-align:center; padding:18px 22px 30px; }
</style></head>
<body><div class="wrap" id="app"><div class="msg"><p>Loading…</p></div></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const el = (h)=>{ const d=document.createElement('div'); d.innerHTML=h.trim(); return d.firstChild; };
const esc = (s)=> String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const app = document.getElementById('app');
let CTX=null, STEP=0;
const STATE = { legal_name:'', date_of_birth:'', email:'', phone:'', current_address:'',
                employer:'', job_title:'', monthly_income:'', occupants:'', pets:'', desired_move_in:'' };

function screenMsg(ic,title,body){ app.innerHTML=''; app.appendChild(el(
  '<div class="msg"><div class="ic">'+ic+'</div><h1>'+esc(title)+'</h1><p>'+esc(body)+'</p></div>')); }

async function boot(){
  try{
    const r = await fetch('/t/application/'+encodeURIComponent(TOKEN)+'/context');
    CTX = await r.json();
  }catch(e){ return screenMsg('!','Something went wrong',"Please try again, or contact the leasing office."); }
  if(!CTX || CTX.state!=='open'){
    const m = {
      invalid:['This link isn’t valid', CTX&&CTX.receipt],
      revoked:['Link revoked', CTX&&CTX.receipt],
      expired:['Link expired', CTX&&CTX.receipt],
      not_sent:['Not active yet', CTX&&CTX.receipt],
      already_submitted:['Already submitted', CTX&&CTX.receipt],
      unavailable:['Unavailable', CTX&&CTX.receipt],
    }[(CTX&&CTX.state)||'unavailable'] || ['Unavailable','Please contact the leasing office.'];
    return screenMsg(CTX&&CTX.state==='already_submitted'?'✓':'—', m[0], m[1]||'Please contact the leasing office.');
  }
  // prefill from what Spine already knows
  if(CTX.person){ STATE.legal_name=CTX.person.name||''; STATE.email=CTX.person.email||''; STATE.phone=CTX.person.phone||''; }
  if(CTX.prefill && CTX.prefill.move_month) STATE.desired_move_in = CTX.prefill.move_month;
  render();
}

function progress(){ let s=''; for(let i=0;i<4;i++) s+='<i class="'+(i<=STEP?'on':'')+'"></i>'; return s; }

function render(){
  if(STEP>=4) return renderReview();
  const unit = CTX.unit_label ? ('Unit '+esc(CTX.unit_label)) : 'Your application';
  const prop = CTX.property_name ? esc(CTX.property_name) : '';
  const secs = [aboutSec, incomeSec, householdSec][STEP] ? [aboutSec, incomeSec, householdSec][STEP]() : reviewSec();
  app.innerHTML='';
  app.appendChild(el(
    '<div><header><p class="kicker">Apply for '+unit+'</p><h1>'+prop+'</h1>'+
    (STEP===0?'<p class="sub">A few quick details. We’ve filled in what we already know.</p>':'')+
    '</header><main><div class="prog">'+progress()+'</div>'+secs+'</main>'+
    '<div class="foot">Your information is sent securely to the leasing team.</div></div>'));
  wire();
}

function fld(label,key,type,ph,extra){ return '<label>'+esc(label)+'</label><input id="f_'+key+'" type="'+(type||'text')+'" placeholder="'+esc(ph||'')+'" value="'+esc(STATE[key]||'')+'" '+(extra||'')+'/>'; }

function aboutSec(){
  const known = CTX.person && (CTX.person.name||CTX.person.phone||CTX.person.email)
    ? '<div class="known"><b>'+esc(CTX.person.name||'You')+'</b> '+
      (CTX.person.phone?'· <span>'+esc(CTX.person.phone)+'</span> ':'')+
      (CTX.person.email?'· <span>'+esc(CTX.person.email)+'</span>':'')+'</div>' : '';
  return '<section class="sec on"><h2>About you</h2><p class="hint">Confirm your details.</p>'+known+
    fld('Legal name','legal_name','text','Full legal name')+
    fld('Date of birth','date_of_birth','date','')+
    fld('Email','email','email','you@email.com')+
    fld('Phone','phone','tel','')+
    fld('Current address','current_address','text','Street, city, state')+
    '<button class="cta" id="next">Continue</button></section>';
}
function incomeSec(){
  return '<section class="sec on"><h2>Employment & income</h2><p class="hint">Where you work and what you earn.</p>'+
    fld('Employer','employer','text','Company name')+
    fld('Job title','job_title','text','')+
    fld('Monthly income (before taxes)','monthly_income','number','$ / month')+
    '<button class="cta" id="next">Continue</button>'+
    '<button class="back" id="back">‹ Back</button></section>';
}
function householdSec(){
  return '<section class="sec on"><h2>Household & move-in</h2><p class="hint">Who’s moving in and when.</p>'+
    '<div class="row2"><div>'+fld('Occupants','occupants','number','# people')+'</div>'+
    '<div>'+fld('Pets','pets','text','None, or describe')+'</div></div>'+
    fld('Intended move-in','desired_move_in','text','e.g. 2026-09 or flexible')+
    '<button class="cta" id="next">Review</button>'+
    '<button class="back" id="back">‹ Back</button></section>';
}
function reviewSec(){ return ''; }

function renderReview(){
  const rows = [
    ['Applying for', CTX.unit_label?('Unit '+CTX.unit_label):'—'],
    ['Property', CTX.property_name||'—'],
    ['Legal name', STATE.legal_name], ['Date of birth', STATE.date_of_birth],
    ['Email', STATE.email], ['Phone', STATE.phone], ['Current address', STATE.current_address],
    ['Employer', STATE.employer], ['Job title', STATE.job_title],
    ['Monthly income', STATE.monthly_income?('$'+Number(STATE.monthly_income).toLocaleString()):''],
    ['Occupants', STATE.occupants], ['Pets', STATE.pets], ['Intended move-in', STATE.desired_move_in],
  ];
  const body = rows.map(r=>'<div class="rr"><span>'+esc(r[0])+'</span><b>'+(r[1]?esc(r[1]):'<span>—</span>')+'</b></div>').join('');
  app.innerHTML='';
  app.appendChild(el(
    '<div><header><p class="kicker">Review & submit</p><h1>Almost done</h1>'+
    '<p class="sub">Check everything, then submit your application.</p></header>'+
    '<main><div class="prog">'+progress()+'</div><div class="review sec on"><dl>'+body+'</dl>'+
    '<button class="cta" id="submit">Submit application</button>'+
    '<button class="back" id="back">‹ Back</button></div></main>'+
    '<div class="foot">By submitting, you confirm this information is accurate.</div></div>'));
  document.getElementById('back').onclick=()=>{ STEP=2; render(); };
  document.getElementById('submit').onclick=submit;
}

function grab(){ ['legal_name','date_of_birth','email','phone','current_address','employer','job_title','monthly_income','occupants','pets','desired_move_in'].forEach(k=>{ const n=document.getElementById('f_'+k); if(n) STATE[k]=n.value; }); }

function wire(){
  const nx=document.getElementById('next'); if(nx) nx.onclick=()=>{ grab(); STEP++; render(); };
  const bk=document.getElementById('back'); if(bk) bk.onclick=()=>{ grab(); STEP--; render(); };
}

async function submit(){
  const btn=document.getElementById('submit'); btn.disabled=true; btn.textContent='Submitting…';
  const captured = {
    date_of_birth:STATE.date_of_birth||null, email:STATE.email||null, phone:STATE.phone||null,
    current_address:STATE.current_address||null, employer:STATE.employer||null, job_title:STATE.job_title||null,
    monthly_income:STATE.monthly_income||null, occupants:STATE.occupants||null, pets:STATE.pets||null,
    desired_move_in:STATE.desired_move_in||null,
  };
  try{
    const r = await fetch('/applications/submit-public', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token:TOKEN, applicant_name:STATE.legal_name||null, captured }),
    });
    const out = await r.json();
    if(!r.ok){ btn.disabled=false; btn.textContent='Submit application';
      return screenMsg('—','Could not submit', (out&&out.receipt)||'Please try again.'); }
    screenMsg('✓','Application submitted', "Thanks — the leasing team has your application and will follow up.");
  }catch(e){ btn.disabled=false; btn.textContent='Submit application';
    screenMsg('—','Could not submit',"Please check your connection and try again."); }
}

boot();
</script>
</body></html>`);
  });

  // ══════════════════════════════════════════════════════════════════
  //  sendApplication — THE ONE canonical business operation.
  //  The operator thinks ONE thought ("Send application"); this owns the whole
  //  action: guard against a double-send, dispatch the link over SMS (records
  //  the provider SID), and — only on provider acceptance — advance the
  //  opportunity to Applicants. The route and UI see ONE operation, never the
  //  internal steps. Actor + property are passed by the session-scoped route.
  //
  //  DOUBLE-TAP: an opportunity gets ONE active application invitation. If this
  //  conversion already has one that's been sent (manually_sent /
  //  provider_dispatched) and is still live (not consumed/revoked/expired), a
  //  second tap does NOT create a second invitation or a second text — it
  //  returns that existing send idempotently. They're already in Applicants.
  async function sendApplication({ property_id, person_id, unit_id, conversion_id = null, created_by_user_id = null, intended_move_in = null }) {
    // 1) DOUBLE-TAP GUARD — an already-sent, still-live invitation on this
    //    conversion means the application is already out. No second send.
    if (conversion_id) {
      const existing = (await pool.query(
        `select id, status, provider_message_id from application_invitations
          where conversion_id=$1 and status in ('manually_sent','provider_dispatched')
          order by sent_at desc nulls last limit 1`, [conversion_id])).rows[0];
      if (existing) {
        return { sent: true, idempotent: true, invitation_id: existing.id, status: existing.status,
                 provider_message_id: existing.provider_message_id || null,
                 receipt: "Application already sent — no second text." };
      }
    }
    // 2) DISPATCH — the proven primitive (validates person+unit belong to the
    //    property, creates the prepared invitation, sends via the ONE comms
    //    gate, records the SID on acceptance; on refusal, revokes honestly).
    const out = await createAndDispatchApplicationInvitation({
      property_id, person_id, unit_id, conversion_id, created_by_user_id });
    if (!out || !out.dispatched) return out;   // honest failure passes straight through — NO advance
    // 3) ADVANCE — only on provider acceptance. One shared transition helper,
    //    its own txn. The SMS is already out; an advance hiccup is a follow-up
    //    reconciliation, not a dispatch failure.
    if (conversion_id) {
      try {
        await runTx(async (client) => {
          out.applicant_followup = await advanceOpportunityToApplicants(client, {
            conversion_id, invitation_id: out.invitation_id, by_user_id: created_by_user_id || null });
        });
      } catch (e) {
        out.applicant_followup = { advance_error: e.publicMessage || e.message };
      }
    }
    out.sent = true;
    return out;
  }

  router._service = { sendApplication, createAndDispatchApplicationInvitation, createPreparedInvitation, attestInvitationSent, submitApplicationService, closeApprovalGate, spawnApprovalGate, approvalGateRole, resolveTenantContext };
  return router;
};
