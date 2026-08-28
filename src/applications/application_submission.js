// TENANT APPLICATION V2 DROP-IN
// Source anchor: kzitelli-art/property-spine-api main
// application_submission.js blob 6aa2c47753329874c7442793a580a405ba87f148.
// Backend lifecycle/services retained; the tenant page and V2-scoped validation
// are the intentional changes.
//
// =============================================================
// application_submission.js — the SHARED submission service + the
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
//   app.use("/", application_submission({ pool, spawnObligationFromEvent,
//                                        completeObligation,
//                                        conversionService: convMod._service }));
// =============================================================

const express = require("express");
const crypto = require("crypto");
// The canonical lifecycle authority. Status and its milestone are authored
// together in one insert — migration 125 refuses a row that reaches submission
// without submitted_at, so insert-then-update is rejected by the database.
const lifecycle = require("./application_lifecycle");
// Slice 9: canonical application READ authority (TERMINAL group, status vocabulary).
const lifecycleRead = require("./application_lifecycle_read");
// Slice 9 Commit A/B: the ONE application-target authority. Required directly
// rather than injected — an injected `unitOfferable` that defaulted to null
// meant any caller which simply did not pass it created an invitation with NO
// target validation at all. Possessing a unit_id is not permission to skip
// resolution.
const applicationTarget = require("./application_target_authority");

// Non-recoverable digest of a bearer token. We store ONLY this; the raw token
// lives solely in the issued URL. SHA-256 is sufficient for a high-entropy
// (192-bit) random token — there is nothing to brute-force.
function digestToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

module.exports = function applicationSubmissionModule(deps) {
  const { pool, spawnObligationFromEvent, completeObligation, conversionService, commBoundary = null, applicationInputAuthority = null } = deps;
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
  function httpErr(status, msg, code = null) {
    const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg;
    // Stable refusal identity travels beside the sentence so a client can
    // branch on the reason without parsing operator copy.
    if (code) e.code = code;
    return e;
  }

  // Evidence lineage is opportunity-scoped. Resolve the one canonical open
  // leasing opportunity for this Person × Property pair. Absence remains null:
  // an internal application may exist without a leasing lead, but it can never
  // be credited to an AI strategy after the fact.
  async function resolveOpenLeasingLeadId(client, { property_id, person_id }) {
    if (!property_id || !person_id) return null;
    const row = (await client.query(
      `select id from leasing_leads
        where property_id=$1 and person_id=$2 and status not in ('leased','lost')
        order by received_at desc, id desc limit 1`,
      [property_id, person_id]
    )).rows[0];
    return row ? row.id : null;
  }
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
    property_id, person_id = null, unit_id = null, space_id = null, unit_label = null,
    intended_move_in = null,
    applicant_name, rent = null, deposit = null, guarantor_name = null,
    captured = {}, source = "applicant",
    conversion_id = null,
    progress_obligation_id = null,   // the applicant_followup rung to close (public path)
    leasing_lead_id = null,          // optional caller hint; verified below
    submitted_by = null,             // staff actor for internal path
  }) {
    if (!property_id) throw httpErr(400, "property_id is required.");
    if (!applicant_name) throw httpErr(400, "applicant_name is required.");

    // ── BIRTH GUARD — an application must reference a durable person ───
    // person_id defaulted to null here, so an application could be created
    // holding an applicant NAME and no identity. One such record was found
    // in the Demo Building on 2026-07-24 sitting at status 'lease_ready':
    // a string on a row, linked to no conversation, no tour history, no
    // Person Card. Nothing downstream can recover an identity that was
    // never written — the operator app correctly rendered the name as
    // plain text, three layers from the cause.
    //
    // The person is REQUIRED, never INFERRED. A name, an email or a phone
    // is evidence of identity and never permission to create or merge one.
    // A caller without a person resolves or creates it through the canonical
    // intake path first, then submits with the id. Refusing here is the
    // honest failure; guessing would be the confident-wrong one.
    if (!person_id) {
      throw httpErr(400,
        "person_id is required. An application must reference a durable person — " +
        "resolve or create the person through the canonical intake path first, then submit. " +
        "Identity is never inferred from an applicant name.");
    }

    const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
    if (!prop) throw httpErr(404, "No property with that id.");

    // ── GRAIN FLOOR FOR EVERY APPLICATION BIRTH ───────────────────────
    //  This is the ONE service that creates an application record, so it is
    //  where the grain boundary is enforced for every door that reaches it —
    //  public token submission, internal staff entry and import alike.
    //
    //  require_offerable is FALSE by design. An application record is not an
    //  offer: the internal path exists partly to record applications that
    //  ALREADY happened (source 'import'), and refusing those because the unit
    //  is no longer marketable would make historical truth unrecordable.
    //  What is NOT negotiable is the grain — a multi-space unit produces an
    //  application nobody can attribute to a space, and lease_applications has
    //  no space_id to attribute it with. Offerability for the public token
    //  door is enforced by its own submission-time revalidation.
    //  (182) The bed travels with the aim. A single-space unit resolves
    //  exactly as it did before and now records the space it always derived;
    //  a multi-space unit resolves the CHOSEN bed, or refuses because the
    //  request never said which. Historical import keeps working: source
    //  'import' passes no space and lands with space_id null, which is the
    //  honest record of an application whose bed was never stated.
    let resolvedSpaceId = null;
    let resolvedUnitId = unit_id;
    if (unit_id || space_id) {
      const target = await applicationTarget.resolveApplicationTarget(client, {
        property_id, unit_id, space_id, intended_move_in, require_offerable: false });
      if (!target.ok) {
        throw httpErr(target.httpStatus || 409,
          target.refusal_reason || "That unit cannot carry an application.",
          target.refusal_code);
      }
      resolvedSpaceId = target.resolved_space_id;
      resolvedUnitId = target.unit_id;
    }

    let resolvedLeasingLeadId = leasing_lead_id || await resolveOpenLeasingLeadId(client, { property_id, person_id });
    if (resolvedLeasingLeadId) {
      const lead = (await client.query(
        `select id from leasing_leads where id=$1 and property_id=$2 and person_id=$3`,
        [resolvedLeasingLeadId, property_id, person_id]
      )).rows[0];
      if (!lead) {
        throw httpErr(409,
          "The application leasing opportunity does not match this person and property. " +
          "Application evidence is never inferred across opportunities.");
      }
    }

    // 1) the application RECORD — 'submitted', through the canonical authority.
    //    Same columns, same values, same transaction. What changes is that
    //    submitted_at is now authored in the SAME statement as the status
    //    rather than left null for evidence to reconstruct from created_at.
    //    The payload is a closed allowlist: this caller cannot name a
    //    lifecycle column, and unknown keys are refused rather than ignored.
    const born = await lifecycle.createSubmittedApplication(client, {
      property_id, unit_id: resolvedUnitId, space_id: resolvedSpaceId,
      intended_move_in,
      person_id, leasing_lead_id: resolvedLeasingLeadId,
      applicant_name, unit_label, rent, deposit, guarantor_name,
      captured: captured || {}, source, conversion_id,
    });
    const app = born.application;

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
    space_id = null, intended_move_in = null, expires_at = null, created_by_user_id = null,
  }) {
    if (!property_id) throw httpErr(400, "property_id is required.");
    const prop = (await client.query("select id from properties where id=$1", [property_id])).rows[0];
    if (!prop) throw httpErr(404, "No property with that id.");

    // ── THE ONE CHOKE POINT FOR INVITATION BIRTH ──────────────────────
    //  Every prepared invitation is created here, so the target is resolved
    //  here. The old check was a property wall only: it proved the unit was at
    //  this property and nothing else, so an invitation could be prepared for
    //  a unit that was occupied, down, committed to another resident, or
    //  carried two spaces with no way to say which one the application meant.
    //
    //  REFUSAL HAPPENS BEFORE THE INSERT. No invitation row, no token, no
    //  comm_event follows a refused target.
    let target = null;
    if (unit_id || space_id) {
      target = await applicationTarget.resolveApplicationTarget(client, {
        property_id, unit_id, space_id, intended_move_in, require_offerable: true,
      });
      if (!target.ok) {
        throw httpErr(target.httpStatus || 409, target.refusal_reason || "That unit cannot be used for an application.",
          target.refusal_code);
      }
    }
    const rawToken = crypto.randomBytes(24).toString("base64url");
    const tokenDigest = digestToken(rawToken);
    const inv = (await client.query(
       `insert into application_invitations
         (token_digest, conversion_id, person_id, property_id, unit_id, space_id, intended_move_in, status, expires_at, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9) returning *`,
      //  THE RESOLVED BED IS WHAT IS WRITTEN (182) — not the caller's request.
      //  A single-space unit therefore persists the derived space with no
      //  behaviour change; a chosen bed persists the one availability was
      //  actually evaluated against.
      [tokenDigest, conversion_id, person_id, property_id,
       target ? target.unit_id : unit_id,
       target ? target.resolved_space_id : null,
       target ? target.intended_move_in : intended_move_in,
       expires_at, created_by_user_id]
    )).rows[0];
    return {
      receipt: "Invitation prepared. Send it through the real channel, then call /mark-sent to attest the send.",
      invitation_id: inv.id,
      token: rawToken,          // RAW token returned ONCE — digest-only at rest.
      status: inv.status,
      // LINEAGE as of 182. This is now written to application_invitations
      // .space_id above, and carried forward to the application at submission,
      // so the bed availability was checked against is the bed on the record.
      resolved_space_id: target ? target.resolved_space_id : null,
      intended_move_in: target ? target.intended_move_in : intended_move_in,
      resolution_basis: target ? target.resolution_basis : null,
    };
  }

  // RETIRED (v2.5-r1 Corr 1): shared-key invitation doors bypass actor identity,
  // property authority, and module entitlement. The governed door is the
  // staff-session /operator/ adapter. Services remain internal.
  router.post("/leasing/application-invitations", requireOperator, (req, res) => {
    return res.status(410).json({ error: "retired", receipt: "This route is retired. Application links are prepared through the staff-session operator surface, against the exact prepare commitment." });
  });


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
    property_id, person_id, unit_id = null, space_id = null, conversion_id = null,
    intended_move_in = null,
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

      // ── RESUME REVALIDATES THE GRAIN, NOT THE MARKET ────────────────
      //  An invitation can sit prepared while inventory changes underneath it.
      //  Before re-attempting the wire, the ORIGINAL target must still be
      //  resolvable: same property, still exactly one space. A unit that has
      //  since been split into two spaces is ambiguous, and a link that would
      //  produce an application nobody can attribute to a space must not go
      //  out.
      //
      //  require_offerable is FALSE deliberately. This is crash recovery, not
      //  a new offer — the unit may well have become unmarketable BECAUSE of
      //  this very applicant, and demanding marketability would make a
      //  legitimate resume impossible. Only structural grain failures refuse.
      if (inv.unit_id || inv.space_id) {
        const still = await applicationTarget.resolveApplicationTarget(pool, {
          property_id: inv.property_id, unit_id: inv.unit_id, space_id: inv.space_id,
          intended_move_in: inv.intended_move_in,
          require_offerable: false });
        if (!still.ok) {
          return { dispatched: false, reason: still.refusal_code, invitation_id: inv.id,
                   status: inv.status, receipt: still.refusal_reason };
        }
      }
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
      // ── TARGET RESOLUTION BEFORE ANY SIDE EFFECT ────────────────────
      //  Provider dispatch must not bypass resolution just because it holds a
      //  unit_id. The refusal lands BEFORE the invitation insert, before the
      //  comm_event insert, and therefore before any wire attempt. The prior
      //  check was a property wall only.
      let dispatchTarget = null;
      if (unit_id || space_id) {
        dispatchTarget = await applicationTarget.resolveApplicationTarget(client, {
          property_id, unit_id, space_id, intended_move_in, require_offerable: true });
        if (!dispatchTarget.ok) {
          throw httpErr(dispatchTarget.httpStatus || 409,
            dispatchTarget.refusal_reason || "That unit cannot be used for an application.",
            dispatchTarget.refusal_code);
        }
      }
      const rawToken = crypto.randomBytes(24).toString("base64url");
      const inv = (await client.query(
       `insert into application_invitations
           (token_digest, conversion_id, person_id, property_id, unit_id, space_id, intended_move_in, status, expires_at, created_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9) returning *`,
        [digestToken(rawToken), conversion_id, person_id, property_id,
         dispatchTarget ? dispatchTarget.unit_id : unit_id,
         dispatchTarget ? dispatchTarget.resolved_space_id : null,
         dispatchTarget ? dispatchTarget.intended_move_in : intended_move_in,
         expires_at, created_by_user_id]
      )).rows[0];
      const url = `${base}/t/application/${rawToken}`;
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
  router.post("/leasing/application-invitations/dispatch", requireOperator, (req, res) => {
    return res.status(410).json({ error: "retired", receipt: "This route is retired. Provider dispatch runs through the staff-session operator surface in the same action that prepares the link." });
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

  router.post("/leasing/application-invitations/:id/mark-sent", requireOperator, (req, res) => {
    return res.status(410).json({ error: "retired", receipt: "This route is retired. Sends are attested through the staff-session operator surface (finalize), which closes the exact send commitment." });
  });

  // 2b) REVOKE — a CORRECTION fact (e.g. wrong number, sent in error). Does NOT
  //     rewrite the original send record; stamps a separate revocation. A revoked
  //     invitation can no longer be consumed.
  router.post("/leasing/application-invitations/:id/revoke", requireOperator, (req, res) => {
    return res.status(410).json({ error: "retired", receipt: "This route is retired. Revocation runs through the staff-session operator surface, which reconciles dispatch state before any correction." });
  });

  // Tenant form validation is scoped by the version marker so legacy/import
  // callers keep their contract. V3 adds conditional questions and consent,
  // but V2 links remain submittable during a rolling deployment.
  function validateTenantCapture(captured, {
    intended_move_in = null,
    application_options = null,
  } = {}) {
    const fail = (message) => { throw httpErr(400, message); };
    if (!captured || !["tenant_v2", "tenant_v3"].includes(captured.application_form_version)) {
      fail("This application form is out of date. Reload the application link and submit the current form.");
    }
    const isV3 = captured.application_form_version === "tenant_v3";
    const requiredText = (value, label, max = 300) => {
      const s = value == null ? "" : String(value).trim();
      if (!s) fail(`${label} is required.`);
      if (s.length > max) fail(`${label} is too long.`);
      return s;
    };
    const optionalText = (value, label, max = 1000) => {
      if (value == null || value === "") return null;
      const s = String(value).trim();
      if (s.length > max) fail(`${label} is too long.`);
      return s || null;
    };
    const oneOf = (value, allowed, label) => {
      if (!allowed.includes(value)) fail(`${label} is invalid.`);
    };
    const validDate = (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
      const [year, month, day] = String(value).split("-").map(Number);
      const d = new Date(Date.UTC(year, month - 1, day));
      return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
    };

    requiredText(captured.date_of_birth, "Date of birth", 10);
    if (!validDate(captured.date_of_birth) || new Date(captured.date_of_birth + "T00:00:00Z") >= new Date()) {
      fail("Date of birth must be a valid date in the past.");
    }
    const email = requiredText(captured.email, "Email", 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Email is invalid.");
    const phone = requiredText(captured.phone, "Phone", 40);
    if (phone.replace(/\D/g, "").length < 10) fail("Phone is invalid.");

    const address = captured.address || {};
    requiredText(address.line1, "Street address", 200);
    optionalText(address.line2, "Address line 2", 100);
    requiredText(address.city, "City", 100);
    if (!/^[A-Za-z]{2}$/.test(String(address.state || ""))) fail("State must be a two-letter abbreviation.");
    if (!/^\d{5}(-\d{4})?$/.test(String(address.postal_code || ""))) fail("ZIP code is invalid.");
    if (!/^\d{4}-\d{2}$/.test(String(captured.current_since || ""))) fail("Current residence start month is invalid.");
    oneOf(captured.housing_status, ["rent", "own", "other"], "Current housing");

    oneOf(captured.income_status, ["employed", "self_employed", "student", "retired", "not_working", "other"], "Income situation");
    if (captured.income_amount == null || !Number.isFinite(Number(captured.income_amount)) || Number(captured.income_amount) < 0) {
      fail("Income amount is invalid.");
    }
    oneOf(captured.income_frequency, ["monthly", "annual", "weekly", "biweekly"], "Income frequency");
    const employer = optionalText(captured.employer, "Employer", 200);
    optionalText(captured.job_title, "Job title", 200);
    optionalText(captured.income_notes, "Income notes", 2000);
    if (isV3 && ["employed", "self_employed"].includes(captured.income_status) && !employer) {
      fail("Employer or business is required for this income situation.");
    }
    if (isV3 && captured.income_status === "student") {
      requiredText(captured.school_name, "School", 200);
      const graduationYear = Number(captured.graduation_year);
      const thisYear = new Date().getUTCFullYear();
      if (!/^\d{4}$/.test(String(captured.graduation_year || ""))
          || graduationYear < thisYear - 1 || graduationYear > thisYear + 10) {
        fail("Graduation year is invalid.");
      }
      optionalText(captured.student_id, "Student ID", 100);
    }

    if (!validDate(captured.desired_move_in)) fail("Preferred move-in date is invalid.");
    if (intended_move_in && String(captured.desired_move_in) < String(intended_move_in).slice(0, 10)) {
      fail("Preferred move-in date cannot be before the targeted move-in date.");
    }
    oneOf(captured.move_flexibility, ["exact", "plus_minus_7", "plus_minus_30", "flexible"], "Move-in flexibility");
    const occupants = Number(captured.occupants);
    if (!Number.isInteger(occupants) || occupants < 1 || occupants > 20) fail("Occupant count is invalid.");
    oneOf(captured.has_pets, ["yes", "no"], "Pets or assistance animals");
    oneOf(captured.guarantor_needed, ["yes", "no", "unsure"], "Guarantor selection");
    const householdNames = optionalText(captured.household_names, "Other adult occupants", 2000);
    if (isV3 && occupants > 1 && !householdNames) {
      fail("List the other adult occupants or explain that the additional occupants are minors.");
    }
    optionalText(captured.pets, "Pets or assistance animals", 2000);
    optionalText(captured.additional_notes, "Additional notes", 3000);
    if (isV3) {
      if (captured.guarantor_needed === "yes") {
        const contact = captured.guarantor_contact || {};
        requiredText(contact.name, "Guarantor name", 300);
        const guarantorPhone = requiredText(contact.phone, "Guarantor phone", 40);
        if (guarantorPhone.replace(/\D/g, "").length < 10) fail("Guarantor phone is invalid.");
        const guarantorEmail = requiredText(contact.email, "Guarantor email", 254);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guarantorEmail)) fail("Guarantor email is invalid.");
      }
      optionalText(captured.lead_source, "Lead source", 100);
      const options = application_options || {};
      if (options.ask_parking_interest) {
        oneOf(captured.parking_interest, ["none", "interested", "unsure"], "Parking preference");
      }
      if (options.ask_utility_payment_preference) {
        oneOf(captured.utility_payment_preference, ["upfront", "monthly", "unsure"], "Utility-fee preference");
      }
      if (captured.applicant_accuracy_certified !== true) fail("Application accuracy certification is required.");
      if (captured.electronic_delivery_consent !== true) fail("Electronic delivery consent is required.");
    }
  }

  // V3 captures the guarantor identity once, inside the conditional contact
  // block that validation just proved complete. The legacy top-level field is
  // still accepted for V2 callers, but it cannot become a second authority for
  // V3 packet composition. A contradictory duplicate is refused rather than
  // silently choosing one claimant; an omitted duplicate is the normal V3
  // shape and the captured contact supplies the persisted name.
  function resolvePublicGuarantorName(captured, suppliedName) {
    if (!captured || captured.application_form_version !== "tenant_v3") {
      return suppliedName;
    }
    const capturedName = captured.guarantor_needed === "yes"
      ? String(captured.guarantor_contact.name).trim()
      : null;
    const duplicateName = suppliedName == null || String(suppliedName).trim() === ""
      ? null
      : String(suppliedName).trim();
    if (duplicateName !== null && duplicateName !== capturedName) {
      throw httpErr(400,
        "Guarantor name conflicts with the guarantor contact on this application. " +
        "Correct the application and submit one identity.");
    }
    return capturedName;
  }

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
    const validationProperty = (await client.query(
      "select lease_config from properties where id=$1", [inv.property_id]
    )).rows[0] || {};
    validateTenantCapture(captured, {
      intended_move_in: inv.intended_move_in,
      application_options: validationProperty.lease_config && validationProperty.lease_config.application_options,
    });
    const canonicalGuarantorName = resolvePublicGuarantorName(captured, guarantor_name);

    // resolve the applicant name: explicit, else the person on file
    let name = applicant_name;
    if (!name && inv.person_id) {
      const p = (await client.query("select name from persons where id=$1", [inv.person_id])).rows[0];
      name = p && p.name;
    }
    if (!name) throw httpErr(400, "applicant_name is required (none on file for this link).");

    // ── SUBMISSION-TIME TARGET REVALIDATION ───────────────────────────
    //  An invitation stays open while inventory moves. Preparation-time truth
    //  is not submission-time truth, and accepting against the stale one is
    //  how an application is born for a unit somebody else already took.
    //
    //  PLACED HERE DELIBERATELY — after the idempotency return, before the
    //  atomic consume. Two consequences, both intended:
    //
    //   · A previously completed submission has ALREADY returned above. Current
    //     availability is never re-run against an application that is durably
    //     born; revalidation applies before FIRST birth only.
    //   · A refusal leaves the invitation UNCONSUMED. The token is not burned
    //     by a condition the applicant did not cause and cannot fix — correct
    //     the unit configuration and the same link still works.
    //
    //  On refusal nothing downstream happens: no lease_application, no
    //  application_submitted event, no progression obligation closed, no
    //  approval obligation spawned. All of those live below the consume.
    //
    //  The invitation is NOT converted to another unit and no new space is
    //  selected. A target that no longer holds is refused, never re-aimed.
    if (inv.unit_id || inv.space_id) {
      const still = await applicationTarget.resolveSubmissionTarget(client, {
        property_id: inv.property_id, unit_id: inv.unit_id, space_id: inv.space_id,
        intended_move_in: inv.intended_move_in });
      if (!still.ok) {
        throw httpErr(still.httpStatus || 409,
          still.refusal_reason || "This application link can no longer be used.",
          still.refusal_code);
      }
    }

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
      //  (182) THE LINEAGE LINK. The bed the invitation was aimed at becomes
      //  the bed the application carries. Without this line the aim would be
      //  recorded at the invitation and lost at the application, which is the
      //  gap this build exists to close.
      space_id: inv.space_id,
      intended_move_in: inv.intended_move_in,
      applicant_name: name, rent, deposit, guarantor_name: canonicalGuarantorName, captured,
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

    // PATH C — through the canonical authority. The raw write moved status and
    // decided_at but authored no terminal_code / terminal_at pair, so a
    // terminal application could not be placed in a reporting window or
    // classified without re-deriving both from current status. It also had no
    // guard against terminal-to-terminal rewriting: a declined application
    // could be silently overwritten as withdrawn, erasing which decision was
    // actually made. A terminal disposition is immutable here — a later
    // pursuit is a NEW application, never a rewritten one.
    const ended = await lifecycle.markTerminal(client, {
      applicationId: app.id, terminalCode: reason,
      decisionReason: note || reason, actorUserId: decided_by_user_id,
    });

    return { receipt: `Application ${reason}.`, application: ended.application };
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
      ? (await client.query("select id, name, address, lease_config from properties where id=$1", [inv.property_id])).rows[0]
      : null;
    let unitLabel = null;
    if (inv.unit_id) {
      const u = (await client.query(
        `select u.unit_number, s.space_label
           from units u
           left join spaces s on s.id=$2 and s.unit_id=u.id
          where u.id=$1`,
        [inv.unit_id, inv.space_id]
      )).rows[0];
      if (u) {
        const spaceLabel = u.space_label == null ? "" : String(u.space_label).trim();
        unitLabel = spaceLabel && spaceLabel !== "(whole unit)"
          ? `${u.unit_number} · ${spaceLabel}`
          : u.unit_number;
      }
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
    const intendedMoveIn = inv.intended_move_in instanceof Date
      ? [inv.intended_move_in.getFullYear(),
         String(inv.intended_move_in.getMonth() + 1).padStart(2, "0"),
         String(inv.intended_move_in.getDate()).padStart(2, "0")].join("-")
      : (inv.intended_move_in ? String(inv.intended_move_in).slice(0, 10) : null);
    return {
      state: "open",
      property_name: prop ? prop.name : null,
      property_address: prop ? prop.address : null,
      unit_label: unitLabel,
      intended_move_in: intendedMoveIn,
      application_options: prop && prop.lease_config && prop.lease_config.application_options
        ? prop.lease_config.application_options
        : null,
      person, prefill,
    };
  }

  // Context the page reads. Read-only; the page renders `state` honestly.
  router.get("/t/application/:token/context", (req, res) => tx(async (client) => {
    return await resolveTenantContext(client, req.params.token);
  }, res));

  // Tenant-facing rental application V2. Self-contained, mobile-first, and
  // contract-compatible with /applications/submit-public. All property, unit,
  // person, and lifecycle authority remains server-derived from the invitation.
  router.get("/t/application/:token", (req, res) => {
    const token = String(req.params.token).replace(/[^A-Za-z0-9_\-]/g, "");
    const dobMax = new Date().toISOString().slice(0, 10);
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    }).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="color-scheme" content="light"/>
  <title>Rental application</title>
  <style>
    :root{
      --ink:#171a18;--muted:#626b66;--faint:#87918c;--line:#d7ded9;
      --soft:#f3f6f4;--paper:#fff;--canvas:#edf1ef;--warm:#edf5f1;
      --green:#245b47;--red:#9c3026;--blue:#1e5c91;
    }
    *{box-sizing:border-box}
    html{background:var(--canvas)}
    body{
      margin:0;background:var(--canvas);color:var(--ink);
      font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      -webkit-font-smoothing:antialiased;
    }
    button,input,select,textarea{font:inherit}
    button{cursor:pointer}
    .shell{
      max-width:1120px;min-height:100vh;margin:0 auto;background:var(--paper);
      display:grid;grid-template-columns:340px minmax(0,1fr);
    }
    .rail{
      position:sticky;top:0;height:100vh;padding:42px 34px;
      display:flex;flex-direction:column;background:#171714;color:#fff;
    }
    .brand{font-size:12px;font-weight:750;letter-spacing:0;text-transform:uppercase;opacity:.72}
    .property-card{margin-top:56px}
    .eyebrow{font-size:11px;font-weight:750;letter-spacing:.13em;text-transform:uppercase;color:#b7b1a5}
    .property-card h1{
      margin:12px 0 10px;font-family:Georgia,serif;font-size:38px;
       font-weight:500;line-height:1.03;letter-spacing:0;
    }
    .property-card p{margin:0;color:#c9c4b9;font-size:14px;line-height:1.55}
    .target-summary{margin-top:22px;border-top:1px solid rgba(255,255,255,.18);border-bottom:1px solid rgba(255,255,255,.18)}
    .target-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;padding:11px 0;border-top:1px solid rgba(255,255,255,.1);font-size:13px}
    .target-row:first-child{border-top:0}
    .target-row span{color:#9ea8a2}
    .target-row strong{color:#fff;font-weight:700;overflow-wrap:anywhere}
    .unit-note{margin:14px 0 0;color:#aeb8b2;font-size:12.5px;line-height:1.55}
    .rail-note{margin-top:auto;padding-top:22px;border-top:1px solid rgba(255,255,255,.14);color:#bdb8ad;font-size:12px;line-height:1.6}
    .rail-note strong{display:block;margin-bottom:6px;color:#fff}
    .main{min-width:0;padding:38px 56px 56px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:34px}
    .step-label{font-size:12px;font-weight:750;letter-spacing:0;text-transform:uppercase;color:var(--muted)}
    .save-state{font-size:12px;color:var(--faint)}
    .progress{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;margin-bottom:42px}
    .progress span{height:4px;border-radius:999px;background:#e8e4db}
    .progress span.on{background:var(--ink)}
    .screen{display:none;max-width:720px}
    .screen.on{display:block}
    .screen h2{
      margin:0 0 10px;font-family:Georgia,serif;font-size:38px;
       font-weight:500;line-height:1.08;letter-spacing:0;
    }
    .screen h2:focus{outline:none}
    .lede{max-width:650px;margin:0 0 30px;color:var(--muted);font-size:15px;line-height:1.6}
    .info-card{margin-bottom:26px;padding:20px 22px;border:1px solid var(--line);border-radius:8px;background:var(--warm)}
    .info-card h3{margin:0 0 9px;font-size:14px}
    .info-card p,.info-card li{color:#555248;font-size:13px;line-height:1.55}
    .info-card ul{margin:8px 0 0;padding-left:18px}
    .intro-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:28px}
    .intro-tile{padding:18px;border:1px solid var(--line);border-radius:8px}
    .intro-tile strong{display:block;margin-bottom:5px;font-size:13px}
    .intro-tile span{color:var(--muted);font-size:12px;line-height:1.5}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 20px}
    .field{min-width:0}
    .field.full{grid-column:1/-1}
    .field label,.legend{display:block;margin-bottom:7px;font-size:13px;font-weight:750}
    .hint{margin:-2px 0 8px;color:var(--muted);font-size:12px;line-height:1.45}
    input,select,textarea{
      width:100%;padding:13px 14px;border:1px solid #c5cec9;border-radius:8px;
      background:#fff;color:var(--ink);font-size:16px;line-height:1.25;
    }
    textarea{min-height:88px;resize:vertical}
    input:focus,select:focus,textarea:focus{outline:3px solid rgba(30,92,145,.16);border-color:var(--blue)}
    .input-wrap{position:relative}
    .currency input{padding-left:32px}
    .currency:before{content:"$";position:absolute;left:14px;top:13px;color:var(--muted);font-weight:700}
    fieldset{margin:0;padding:0;border:0}
    .date-parts{display:flex;align-items:flex-end;gap:10px}
    .date-parts .month{width:180px}.date-parts .day{width:88px}.date-parts .year{width:120px}
    .date-parts label{margin-bottom:5px;color:var(--muted);font-size:11px;font-weight:700}
    .choice-row{display:flex;flex-wrap:wrap;gap:9px}
    .choice{position:relative}
    .choice input{position:absolute;opacity:0;pointer-events:none}
    .choice label{
      display:block;margin:0;padding:10px 14px;border:1px solid #c5cec9;
      border-radius:999px;background:#fff;font-size:13px;font-weight:700;
    }
    .choice input:focus+label{outline:3px solid rgba(30,92,145,.16);border-color:var(--blue)}
    .choice input:checked+label{border-color:var(--ink);background:var(--ink);color:#fff}
    .conditional{display:none}
    .conditional.on{display:block}
    .divider{margin:30px 0;border:0;border-top:1px solid var(--line)}
    .error-summary{display:none;margin-bottom:24px;padding:15px 16px;border:1px solid #dfb7b1;border-left:5px solid var(--red);border-radius:8px;background:#fff2f0}
    .error-summary.on{display:block}
    .error-summary h3{margin:0 0 7px;color:var(--red);font-size:14px}
    .error-summary ul{margin:0;padding-left:18px}
    .error-summary a{color:var(--red);font-size:13px;font-weight:650}
    .field.error input,.field.error select,.field.error textarea,.field.error .date-parts input,.field.error .date-parts select{border-color:var(--red);background:#fff8f7}
    .error-text{display:none;margin-top:6px;color:var(--red);font-size:12px;font-weight:650}
    .field.error .error-text{display:block}
    .actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:36px;padding-top:24px;border-top:1px solid var(--line)}
    .primary{min-width:146px;padding:13px 22px;border:0;border-radius:999px;background:var(--ink);color:#fff;font-size:14px;font-weight:750}
    .primary:hover{background:#30302b}
    .primary:disabled{cursor:default;opacity:.45}
    .secondary{padding:12px 0;border:0;background:transparent;color:var(--muted);font-size:14px;font-weight:700}
    .review-section{margin-bottom:16px;overflow:hidden;border:1px solid var(--line);border-radius:8px}
    .review-head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;background:var(--soft)}
    .review-head h3{margin:0;font-size:13px}
    .edit{border:0;background:transparent;color:var(--blue);font-size:12px;font-weight:750}
    .review-body{padding:6px 16px}
    .review-row{display:grid;grid-template-columns:190px 1fr;gap:18px;padding:10px 0;border-top:1px solid #ece8df;font-size:13px}
    .review-row:first-child{border-top:0}
    .review-row span{color:var(--muted)}
    .review-row b{font-weight:650;overflow-wrap:anywhere}
    .attest{display:flex;align-items:flex-start;gap:10px;margin-top:20px;padding:15px 16px;border:1px solid var(--line);border-radius:8px}
    .attest input{width:18px;height:18px;margin:1px 0 0}
    .attest label{margin:0;font-size:13px;font-weight:600;line-height:1.5}
    .privacy{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.55}
    .message{max-width:620px;margin:0 auto;padding:90px 30px;text-align:center}
    .message-mark{display:grid;width:58px;height:58px;margin:0 auto 20px;place-items:center;border-radius:50%;background:#e8f1ec;color:var(--green);font-size:28px}
    .message h2{margin:0 0 10px;font-family:Georgia,serif;font-size:38px;font-weight:500}
    .message p{color:var(--muted);line-height:1.6}
    .server-error{display:none;margin-top:16px;padding:13px 14px;border:1px solid #dfb7b1;border-radius:8px;background:#fff2f0;color:var(--red);font-size:13px;line-height:1.45}
    .server-error.on{display:block}
    @media(max-width:800px){
      .shell{display:block}
      .rail{position:static;height:auto;padding:26px 22px 24px}
      .property-card{margin-top:24px}
      .property-card h1{font-size:30px}
      .rail-note{display:none}
      .main{padding:24px 20px 42px}
      .topbar{margin-bottom:22px}
      .progress{margin-bottom:30px}
      .screen h2{font-size:32px}
      .form-grid,.intro-grid{grid-template-columns:1fr}
      .field.full{grid-column:auto}
      .date-parts .month{flex:1;min-width:0}
      .review-row{grid-template-columns:1fr;gap:4px}
      .actions{position:static;margin-right:0;margin-left:0;padding:24px 0 0;background:transparent}
    }
  </style>
</head>
<body>
<div class="shell">
  <aside class="rail">
    <div class="brand">Property Spine</div>
    <div class="property-card">
      <div class="eyebrow">Rental application</div>
      <h1 id="propertyName">Your next home</h1>
      <p>A secure application prepared for you by the leasing team.</p>
       <div class="target-summary" aria-label="Application target">
         <div class="target-row"><span>Home</span><strong id="unitPill">Application</strong></div>
         <div class="target-row" id="targetMoveRow" hidden><span>Target date</span><strong id="targetMoveIn"></strong></div>
       </div>
       <p class="unit-note">This application stays tied to this exact home. Final rent, deposit, and lease terms are reviewed before lease preparation.</p>
    </div>
    <div class="rail-note">
      <strong>Private by design</strong>
      This form does not run a credit or background check. If screening is needed,
      you will receive a separate disclosure and authorization.
    </div>
  </aside>

  <main class="main" id="main">
    <div class="topbar">
      <div class="step-label" id="stepLabel">Before you begin</div>
      <div class="save-state">Secure application</div>
    </div>
    <div class="progress" id="progress" aria-label="Application progress">
      <span></span><span></span><span></span><span></span><span></span>
    </div>
    <div id="errorSummary" class="error-summary" tabindex="-1" aria-live="assertive">
      <h3>Check the information below</h3>
      <ul></ul>
    </div>

    <section class="screen on" data-step="0">
       <h2>Apply in a few minutes.</h2>
       <p class="lede">This form is already connected to the exact home selected with the leasing team. Answer only what applies, then review everything before submitting.</p>
      <div class="info-card">
        <h3>What you will need</h3>
        <ul>
          <li>Your current address and approximate move-in date</li>
          <li>Income information from any lawful sources you want considered</li>
          <li>The names of everyone who will live in the home</li>
        </ul>
      </div>
      <div class="intro-grid">
        <div class="intro-tile"><strong>No fee in this step</strong><span>You will see any future fee or screening request before agreeing to it.</span></div>
         <div class="intro-tile"><strong>About 5 minutes</strong><span>Your progress stays on this device until you submit.</span></div>
         <div class="intro-tile"><strong>Exact home</strong><span>The unit or bed shown here travels with the application and lease.</span></div>
        <div class="intro-tile"><strong>Human review</strong><span>Submitting is not an approval or a lease. The leasing team reviews it next.</span></div>
      </div>
      <div class="actions"><span></span><button class="primary" type="button" data-next>Start application</button></div>
    </section>

    <section class="screen" data-step="1">
      <h2>About you</h2>
      <p class="lede">Use your legal name and the contact information where the leasing team can reach you.</p>
      <div class="form-grid">
        <div class="field full" data-field="legal_name">
          <label for="legal_name">Full legal name</label>
          <input id="legal_name" autocomplete="name"/>
          <div class="error-text"></div>
        </div>
        <div class="field full" data-field="date_of_birth">
          <label for="dob_input">Date of birth</label>
          <input id="dob_input" type="date" autocomplete="bday" max="${dobMax}" aria-describedby="dob_hint"/>
          <div id="dob_hint" class="error-text"></div>
        </div>
        <div class="field" data-field="email">
          <label for="email">Email</label>
          <input id="email" type="email" autocomplete="email" inputmode="email"/>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="phone">
          <label for="phone">Mobile phone</label>
          <input id="phone" type="tel" autocomplete="tel" inputmode="tel"/>
          <div class="error-text"></div>
        </div>
        <div class="field full">
          <label for="lead_source">How did you hear about us? <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <select id="lead_source">
            <option value="">Choose one</option>
            <option value="friend_or_resident">Friend or current resident</option>
            <option value="search">Web search</option>
            <option value="listing_site">Rental listing site</option>
            <option value="social">Social media</option>
            <option value="sign_or_walk_by">Sign or walked by</option>
            <option value="school">School or campus resource</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div class="actions"><button class="secondary" type="button" data-back>Back</button><button class="primary" type="button" data-next>Continue</button></div>
    </section>

    <section class="screen" data-step="2">
      <h2>Your current home</h2>
      <p class="lede">Residence history helps the leasing team verify the application without asking you to repeat information later.</p>
      <div class="form-grid">
        <div class="field full" data-field="address_line1">
          <label for="address_line1">Street address</label>
          <input id="address_line1" autocomplete="address-line1"/>
          <div class="error-text"></div>
        </div>
        <div class="field full">
          <label for="address_line2">Apartment, unit, or floor <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <input id="address_line2" autocomplete="address-line2"/>
        </div>
        <div class="field" data-field="city">
          <label for="city">City</label>
          <input id="city" autocomplete="address-level2"/>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="state">
          <label for="state">State</label>
          <input id="state" autocomplete="address-level1" maxlength="2" style="text-transform:uppercase"/>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="postal_code">
          <label for="postal_code">ZIP code</label>
          <input id="postal_code" autocomplete="postal-code" inputmode="numeric" maxlength="10"/>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="current_since">
          <label for="current_since">Living there since</label>
          <input id="current_since" type="month"/>
          <div class="error-text"></div>
        </div>
        <div class="field full" data-field="housing_status">
          <fieldset>
            <legend class="legend">Current housing</legend>
            <div class="choice-row">
              <div class="choice"><input type="radio" name="housing_status" id="hs_rent" value="rent"/><label for="hs_rent">Rent</label></div>
              <div class="choice"><input type="radio" name="housing_status" id="hs_own" value="own"/><label for="hs_own">Own</label></div>
              <div class="choice"><input type="radio" name="housing_status" id="hs_other" value="other"/><label for="hs_other">Other</label></div>
            </div>
          </fieldset>
          <div class="error-text"></div>
        </div>
        <div class="field">
          <label for="housing_payment">Monthly housing payment <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <div class="input-wrap currency"><input id="housing_payment" inputmode="decimal"/></div>
        </div>
        <div class="field">
          <label for="landlord_contact">Landlord or property contact <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <input id="landlord_contact" placeholder="Name, phone, or email"/>
        </div>
      </div>
      <div id="priorResidence" class="conditional">
        <hr class="divider"/>
        <h3 style="margin:0 0 7px;font-family:Georgia,serif;font-size:24px;font-weight:500">Previous address</h3>
        <p class="hint">Because you have lived at your current address for less than two years.</p>
        <div class="form-grid">
          <div class="field full"><label for="prior_address">Previous street address</label><input id="prior_address"/></div>
          <div class="field"><label for="prior_city">City</label><input id="prior_city"/></div>
          <div class="field"><label for="prior_state">State</label><input id="prior_state" maxlength="2"/></div>
          <div class="field"><label for="prior_postal">ZIP code</label><input id="prior_postal" inputmode="numeric"/></div>
          <div class="field"><label for="prior_landlord_contact">Previous landlord contact <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="prior_landlord_contact"/></div>
        </div>
      </div>
      <div class="actions"><button class="secondary" type="button" data-back>Back</button><button class="primary" type="button" data-next>Continue</button></div>
    </section>

    <section class="screen" data-step="3">
      <h2>Income</h2>
      <p class="lede">Include employment, self-employment, benefits, assistance, support, or any other lawful income you want considered.</p>
      <div class="info-card"><p style="margin:0">This form asks for the amount and only enough context to verify it later. Supporting documents are not uploaded here.</p></div>
      <div class="form-grid">
        <div class="field full" data-field="income_status">
          <label for="income_status">Primary income situation</label>
          <select id="income_status">
            <option value="">Choose one</option>
            <option value="employed">Employed</option>
            <option value="self_employed">Self-employed</option>
            <option value="student">Student</option>
            <option value="retired">Retired</option>
            <option value="not_working">Not currently working</option>
            <option value="other">Other</option>
          </select>
          <div class="error-text"></div>
        </div>
        <div id="employmentFields" class="conditional full" style="grid-column:1/-1">
          <div class="form-grid">
            <div class="field"><label for="employer">Employer or business</label><input id="employer" autocomplete="organization"/></div>
            <div class="field"><label for="job_title">Job title or type of work</label><input id="job_title" autocomplete="organization-title"/></div>
            <div class="field"><label for="employment_start">Working there since <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="employment_start" type="month"/></div>
          </div>
        </div>
        <div id="studentFields" class="conditional full" style="grid-column:1/-1">
          <div class="form-grid">
            <div class="field" data-field="school_name"><label for="school_name">School</label><input id="school_name" autocomplete="organization"/></div>
            <div class="field" data-field="graduation_year"><label for="graduation_year">Expected graduation year</label><input id="graduation_year" inputmode="numeric" maxlength="4"/></div>
            <div class="field full"><label for="student_id">Student ID number <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="student_id" autocomplete="off"/></div>
          </div>
        </div>
        <div class="field" data-field="income_amount">
          <label for="income_amount">Gross income before taxes</label>
          <div class="input-wrap currency"><input id="income_amount" inputmode="decimal"/></div>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="income_frequency">
          <label for="income_frequency">How often?</label>
          <select id="income_frequency">
            <option value="">Choose one</option>
            <option value="monthly">Per month</option>
            <option value="annual">Per year</option>
            <option value="weekly">Per week</option>
            <option value="biweekly">Every two weeks</option>
          </select>
          <div class="error-text"></div>
        </div>
        <div class="field">
          <label for="additional_income">Additional lawful income <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <div class="input-wrap currency"><input id="additional_income" inputmode="decimal"/></div>
        </div>
        <div class="field">
          <label for="additional_income_frequency">How often? <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <select id="additional_income_frequency">
            <option value="">Choose one</option>
            <option value="monthly">Per month</option>
            <option value="annual">Per year</option>
            <option value="weekly">Per week</option>
            <option value="biweekly">Every two weeks</option>
          </select>
        </div>
        <div class="field full">
          <label for="income_notes">Income notes <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <textarea id="income_notes" placeholder="Anything the leasing team should know about how this income can be verified."></textarea>
        </div>
      </div>
      <div class="actions"><button class="secondary" type="button" data-back>Back</button><button class="primary" type="button" data-next>Continue</button></div>
    </section>

    <section class="screen" data-step="4">
      <h2>Household and move-in</h2>
      <p class="lede">Tell us who will live in the home and when you would like to move.</p>
      <div id="moveMonthHint" class="info-card" style="display:none"><p style="margin:0"></p></div>
      <div class="form-grid">
        <div class="field" data-field="desired_move_in">
          <label for="desired_move_in">Preferred move-in date</label>
          <input id="desired_move_in" type="date"/>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="move_flexibility">
          <label for="move_flexibility">Date flexibility</label>
          <select id="move_flexibility">
            <option value="">Choose one</option>
            <option value="exact">That date is important</option>
            <option value="plus_minus_7">Within about one week</option>
            <option value="plus_minus_30">Within about one month</option>
            <option value="flexible">Flexible</option>
          </select>
          <div class="error-text"></div>
        </div>
        <div class="field" data-field="occupants">
          <label for="occupants">Total number of occupants</label>
          <input id="occupants" type="number" inputmode="numeric" min="1" max="20"/>
          <div class="error-text"></div>
        </div>
        <div class="field full" data-field="household_names">
          <label for="household_names">Other adult occupants <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <textarea id="household_names" placeholder="Names only. The leasing team will explain whether each adult needs a separate application."></textarea>
          <div class="error-text"></div>
        </div>
        <div class="field full" data-field="has_pets">
          <fieldset>
            <legend class="legend">Pets or assistance animals?</legend>
            <div class="choice-row">
              <div class="choice"><input type="radio" name="has_pets" id="pets_no" value="no"/><label for="pets_no">No</label></div>
              <div class="choice"><input type="radio" name="has_pets" id="pets_yes" value="yes"/><label for="pets_yes">Yes</label></div>
            </div>
          </fieldset>
          <div class="error-text"></div>
        </div>
        <div id="petFields" class="conditional full" style="grid-column:1/-1">
          <div class="field full">
            <label for="pets_description">Tell us about them</label>
            <textarea id="pets_description" placeholder="Number and type. Do not include disability or medical information."></textarea>
          </div>
        </div>
        <div class="field full" data-field="guarantor_needed">
          <fieldset>
            <legend class="legend">Will you use a guarantor or co-signer?</legend>
            <div class="choice-row">
              <div class="choice"><input type="radio" name="guarantor_needed" id="guarantor_no" value="no"/><label for="guarantor_no">No</label></div>
              <div class="choice"><input type="radio" name="guarantor_needed" id="guarantor_yes" value="yes"/><label for="guarantor_yes">Yes</label></div>
              <div class="choice"><input type="radio" name="guarantor_needed" id="guarantor_unsure" value="unsure"/><label for="guarantor_unsure">Not sure</label></div>
            </div>
          </fieldset>
          <div class="error-text"></div>
        </div>
        <div id="guarantorFields" class="conditional full" style="grid-column:1/-1">
          <div class="form-grid">
            <div class="field" data-field="guarantor_name"><label for="guarantor_name">Guarantor's full name</label><input id="guarantor_name" autocomplete="off"/><div class="error-text"></div></div>
            <div class="field" data-field="guarantor_phone"><label for="guarantor_phone">Guarantor's mobile phone</label><input id="guarantor_phone" type="tel" inputmode="tel" autocomplete="off"/><div class="error-text"></div></div>
            <div class="field full" data-field="guarantor_email"><label for="guarantor_email">Guarantor's email</label><input id="guarantor_email" type="email" inputmode="email" autocomplete="off"/><div class="error-text"></div></div>
          </div>
        </div>
        <div class="field full" id="parkingField" data-field="parking_interest" hidden>
          <label for="parking_interest">Parking</label>
          <select id="parking_interest">
            <option value="">Choose one</option>
            <option value="none">No parking needed</option>
            <option value="interested">I am interested in parking</option>
            <option value="unsure">Not sure yet</option>
          </select>
          <p class="hint" id="parkingNote"></p>
        </div>
        <div class="field full" id="utilityChoiceField" data-field="utility_payment_preference" hidden>
          <label for="utility_payment_preference">Utility-fee payment preference</label>
          <select id="utility_payment_preference">
            <option value="">Choose one</option>
            <option value="upfront">Pay with lease or move-in charges</option>
            <option value="monthly">Pay monthly over the lease term</option>
            <option value="unsure">Decide with the leasing team</option>
          </select>
          <p class="hint" id="utilityChoiceNote"></p>
        </div>
        <div class="field full">
          <label for="vehicles">Vehicle details <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <input id="vehicles" placeholder="Year, make, model, and plate if known"/>
        </div>
        <div class="field full">
          <label for="additional_notes">Anything else the leasing team should know? <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <textarea id="additional_notes"></textarea>
        </div>
      </div>
      <div class="actions"><button class="secondary" type="button" data-back>Back</button><button class="primary" type="button" data-next>Review</button></div>
    </section>

    <section class="screen" data-step="5">
      <h2>Review your application</h2>
      <p class="lede">Nothing is submitted until you select the confirmation and press Submit application.</p>
      <div id="review"></div>
      <div class="attest">
        <input id="certify" type="checkbox"/>
        <label for="certify">I certify that the information in this application is complete and accurate to the best of my knowledge.</label>
      </div>
      <div class="attest">
        <input id="electronicConsent" type="checkbox"/>
        <label for="electronicConsent">I agree to receive application, lease, and move-in notices at the mobile number and email above. Message and data rates may apply; reply STOP to stop texts.</label>
      </div>
      <p class="privacy">Submitting this application is not an approval, a screening authorization, or a lease. The leasing team will contact you about the next step.</p>
      <div id="serverError" class="server-error" role="alert"></div>
      <div class="actions"><button class="secondary" type="button" data-back>Back</button><button class="primary" id="submitButton" type="button">Submit application</button></div>
    </section>
  </main>
</div>

<script>
(function(){
  "use strict";
  var TOKEN = ${JSON.stringify(token)};
  var CTX = null;
  var step = 0;
  var stepNames = ["Before you begin","Your information","Residence","Income","Household","Review"];
  var state = {
    legal_name:"",dob_input:"",email:"",phone:"",lead_source:"",
    address_line1:"",address_line2:"",city:"",state_code:"",postal_code:"",
    current_since:"",housing_status:"",housing_payment:"",landlord_contact:"",
    prior_address:"",prior_city:"",prior_state:"",prior_postal:"",prior_landlord_contact:"",
    income_status:"",employer:"",job_title:"",employment_start:"",
    school_name:"",graduation_year:"",student_id:"",
    income_amount:"",income_frequency:"",additional_income:"",additional_income_frequency:"",
    income_notes:"",desired_move_in:"",move_flexibility:"",occupants:"",
    household_names:"",has_pets:"",pets_description:"",guarantor_needed:"",
    guarantor_name:"",guarantor_phone:"",guarantor_email:"",
    parking_interest:"",utility_payment_preference:"",vehicles:"",additional_notes:""
  };
  var STORAGE_KEY = "ps_tenant_application_v2_"+TOKEN;

  function restoreDraft(){
    try{
      var saved=JSON.parse(sessionStorage.getItem(STORAGE_KEY)||"null");
      if(!saved||typeof saved!=="object") return;
      Object.keys(state).forEach(function(key){
        if(Object.prototype.hasOwnProperty.call(saved,key) && saved[key]!=null) state[key]=String(saved[key]);
      });
      if(!state.dob_input && saved.dob_month && saved.dob_day && saved.dob_year){
        state.dob_input=String(saved.dob_year).padStart(4,"0")+"-"+String(saved.dob_month).padStart(2,"0")+"-"+String(saved.dob_day).padStart(2,"0");
      }
      // any legacy slashed draft becomes ISO, or the native date input drops it
      if(state.dob_input && !/^\\d{4}-\\d{2}-\\d{2}$/.test(state.dob_input)){
        state.dob_input=isoDob();
      }
    }catch(_){}
  }
  function persistDraft(){
    try{sessionStorage.setItem(STORAGE_KEY,JSON.stringify(state));}catch(_){}
  }
  function clearDraft(){
    try{sessionStorage.removeItem(STORAGE_KEY);}catch(_){}
  }

  function byId(id){ return document.getElementById(id); }
  function esc(value){
    return String(value == null ? "" : value).replace(/[&<>"']/g,function(ch){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
    });
  }
  function radioValue(name){
    var node = document.querySelector('input[name="'+name+'"]:checked');
    return node ? node.value : "";
  }
  function setRadio(name,value){
    if(!value) return;
    var node = document.querySelector('input[name="'+name+'"][value="'+value+'"]');
    if(node) node.checked = true;
  }
  function normalizeMoney(value){
    var n = Number(String(value || "").replace(/[$,\\s]/g,""));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function monthlyAmount(amount,frequency){
    var n = normalizeMoney(amount);
    if(n == null) return null;
    if(frequency === "annual") return Math.round((n/12)*100)/100;
    if(frequency === "weekly") return Math.round((n*52/12)*100)/100;
    if(frequency === "biweekly") return Math.round((n*26/12)*100)/100;
    return n;
  }
  function dobParts(){
    var raw=String(state.dob_input||"").trim();
    if(!raw) return null;
    var iso=raw.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);
    if(iso) return {year:Number(iso[1]),month:Number(iso[2]),day:Number(iso[3])};
    var separated=raw.split(/\\D+/).filter(Boolean);
    if(separated.length===3 && separated[2].length===4){
      return {month:Number(separated[0]),day:Number(separated[1]),year:Number(separated[2])};
    }
    var digits=raw.replace(/\\D/g,"");
    if(digits.length!==8) return null;
    return {month:Number(digits.slice(0,2)),day:Number(digits.slice(2,4)),year:Number(digits.slice(4,8))};
  }
  function isoDob(){
    var parts=dobParts();
    if(!parts) return "";
    return String(parts.year).padStart(4,"0")+"-"+String(parts.month).padStart(2,"0")+"-"+String(parts.day).padStart(2,"0");
  }
  function validDob(){
    var parts=dobParts();
    if(!parts || parts.year<1900 || parts.month<1 || parts.month>12 || parts.day<1 || parts.day>31) return false;
    var date=new Date(Date.UTC(parts.year,parts.month-1,parts.day));
    if(date.getUTCFullYear()!==parts.year || date.getUTCMonth()!==parts.month-1 || date.getUTCDate()!==parts.day) return false;
    return date < new Date();
  }
  function currentAddress(){
    return [state.address_line1,state.address_line2,state.city,state.state_code,state.postal_code].filter(Boolean).join(", ");
  }
  function monthsAtCurrent(){
    if(!state.current_since || !/^\\d{4}-\\d{2}$/.test(state.current_since)) return null;
    var p = state.current_since.split("-").map(Number);
    var now = new Date();
    return (now.getFullYear()-p[0])*12 + ((now.getMonth()+1)-p[1]);
  }
  function capture(){
    var ids = [
      "legal_name","dob_input","email","phone","lead_source",
      "address_line1","address_line2","city","postal_code","current_since",
      "housing_payment","landlord_contact","prior_address","prior_city","prior_state",
      "prior_postal","prior_landlord_contact","income_status","employer","job_title",
      "employment_start","school_name","graduation_year","student_id",
      "income_amount","income_frequency","additional_income",
      "additional_income_frequency","income_notes","desired_move_in","move_flexibility",
      "occupants","household_names","pets_description","guarantor_name","vehicles",
      "guarantor_phone","guarantor_email","parking_interest",
      "utility_payment_preference","additional_notes"
    ];
    ids.forEach(function(id){ var node=byId(id); if(node) state[id]=node.value.trim(); });
    state.state_code = (byId("state").value || "").trim().toUpperCase();
    state.housing_status = radioValue("housing_status");
    state.has_pets = radioValue("has_pets");
    state.guarantor_needed = radioValue("guarantor_needed");
    persistDraft();
  }
  function hydrate(){
    Object.keys(state).forEach(function(key){
      var id = key === "state_code" ? "state" : key;
      var node = byId(id);
      if(node && node.type !== "radio") node.value = state[key] || "";
    });
    setRadio("housing_status",state.housing_status);
    setRadio("has_pets",state.has_pets);
    setRadio("guarantor_needed",state.guarantor_needed);
    updateConditionals();
  }
  function updateConditionals(){
    var months = monthsAtCurrent();
    byId("priorResidence").classList.toggle("on",months != null && months < 24);
    byId("employmentFields").classList.toggle("on",state.income_status === "employed" || state.income_status === "self_employed");
    byId("studentFields").classList.toggle("on",state.income_status === "student");
    byId("petFields").classList.toggle("on",state.has_pets === "yes");
    byId("guarantorFields").classList.toggle("on",state.guarantor_needed === "yes");
  }
  function clearErrors(){
    document.querySelectorAll(".field.error").forEach(function(node){
      node.classList.remove("error");
      var text = node.querySelector(".error-text");
      if(text) text.textContent = "";
    });
    var summary = byId("errorSummary");
    summary.classList.remove("on");
    summary.querySelector("ul").innerHTML = "";
  }
  function fieldError(key,message,focusId){
    var wrap = document.querySelector('[data-field="'+key+'"]');
    if(wrap){
      wrap.classList.add("error");
      var text = wrap.querySelector(".error-text");
      if(text) text.textContent = message;
    }
    return {key:key,message:message,focusId:focusId || key};
  }
  function validateStep(which){
    capture();
    clearErrors();
    var errors = [];
    if(which === 1){
      if(!state.legal_name) errors.push(fieldError("legal_name","Enter your full legal name."));
      if(!validDob()) errors.push(fieldError("date_of_birth","Enter your date of birth.","dob_input"));
      if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(state.email)) errors.push(fieldError("email","Enter a valid email address."));
      if(state.phone.replace(/\\D/g,"").length < 10) errors.push(fieldError("phone","Enter a valid phone number."));
    }
    if(which === 2){
      if(!state.address_line1) errors.push(fieldError("address_line1","Enter your street address."));
      if(!state.city) errors.push(fieldError("city","Enter your city."));
      if(!/^[A-Za-z]{2}$/.test(state.state_code)) errors.push(fieldError("state","Enter a two-letter state abbreviation.","state"));
      if(!/^\\d{5}(-\\d{4})?$/.test(state.postal_code)) errors.push(fieldError("postal_code","Enter a valid ZIP code."));
      if(!/^\\d{4}-\\d{2}$/.test(state.current_since)) errors.push(fieldError("current_since","Enter the month and year you moved in."));
      if(!state.housing_status) errors.push(fieldError("housing_status","Choose your current housing situation.","hs_rent"));
    }
    if(which === 3){
      if(!state.income_status) errors.push(fieldError("income_status","Choose your primary income situation."));
      if((state.income_status === "employed" || state.income_status === "self_employed") && !state.employer) errors.push(fieldError("income_status","Enter your employer or business.","employer"));
      if(state.income_status === "student"){
        if(!state.school_name) errors.push(fieldError("school_name","Enter your school."));
        var gy=Number(state.graduation_year);
        var thisYear=new Date().getFullYear();
        if(!/^\\d{4}$/.test(state.graduation_year) || gy < thisYear-1 || gy > thisYear+10) errors.push(fieldError("graduation_year","Enter a reasonable four-digit graduation year."));
      }
      if(normalizeMoney(state.income_amount) == null) errors.push(fieldError("income_amount","Enter your gross income amount."));
      if(!state.income_frequency) errors.push(fieldError("income_frequency","Choose how often you receive this income."));
    }
    if(which === 4){
      if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(state.desired_move_in)) errors.push(fieldError("desired_move_in","Choose a preferred move-in date."));
      else if(CTX&&CTX.intended_move_in&&state.desired_move_in<CTX.intended_move_in) errors.push(fieldError("desired_move_in","Choose the targeted move-in date or a later date."));
      if(!state.move_flexibility) errors.push(fieldError("move_flexibility","Choose how flexible the move-in date is."));
      var occ = Number(state.occupants);
      if(!Number.isInteger(occ) || occ < 1 || occ > 20) errors.push(fieldError("occupants","Enter the total number of occupants."));
      if(occ > 1 && !state.household_names) errors.push(fieldError("household_names","Enter the names of the other adult occupants, or explain that the additional occupants are minors."));
      if(!state.has_pets) errors.push(fieldError("has_pets","Choose yes or no.","pets_no"));
      if(!state.guarantor_needed) errors.push(fieldError("guarantor_needed","Choose yes, no, or not sure.","guarantor_no"));
      if(state.guarantor_needed === "yes"){
        if(!state.guarantor_name) errors.push(fieldError("guarantor_name","Enter the guarantor's full name."));
        if(state.guarantor_phone.replace(/\\D/g,"").length < 10) errors.push(fieldError("guarantor_phone","Enter the guarantor's mobile phone."));
        if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(state.guarantor_email)) errors.push(fieldError("guarantor_email","Enter the guarantor's email."));
      }
      var options=(CTX&&CTX.application_options)||{};
      if(options.ask_parking_interest && !state.parking_interest) errors.push(fieldError("parking_interest","Choose a parking preference.","parking_interest"));
      if(options.ask_utility_payment_preference && !state.utility_payment_preference) errors.push(fieldError("utility_payment_preference","Choose a utility-fee payment preference.","utility_payment_preference"));
    }
    if(errors.length){
      var list = byId("errorSummary").querySelector("ul");
      errors.forEach(function(error){
        var li=document.createElement("li");
        var a=document.createElement("a");
        a.href="#"+error.focusId;
        a.textContent=error.message;
        a.onclick=function(event){
          event.preventDefault();
          var target=byId(error.focusId);
          if(target) target.focus();
        };
        li.appendChild(a);list.appendChild(li);
      });
      byId("errorSummary").classList.add("on");
      byId("errorSummary").focus();
      return false;
    }
    return true;
  }
  function showStep(next){
    step = Math.max(0,Math.min(5,next));
    document.querySelectorAll(".screen").forEach(function(node){
      node.classList.toggle("on",Number(node.getAttribute("data-step"))===step);
    });
    byId("stepLabel").textContent = stepNames[step];
    document.querySelectorAll("#progress span").forEach(function(node,index){
      node.classList.toggle("on",index < Math.max(1,step));
    });
    byId("errorSummary").classList.remove("on");
    if(step===5) renderReview();
    window.scrollTo(0,0);
    var heading=document.querySelector('.screen.on h2');
    if(heading){heading.setAttribute("tabindex","-1");heading.focus();}
  }
  function display(value,fallback){
    return value ? esc(value) : esc(fallback || "Not provided");
  }
  function moneyDisplay(amount,frequency){
    var n=normalizeMoney(amount);
    if(n==null) return "Not provided";
    var label={annual:"per year",monthly:"per month",weekly:"per week",biweekly:"every two weeks"}[frequency] || "";
    return "$"+n.toLocaleString()+ (label ? " "+label : "");
  }
  function dateDisplay(value){
    var parts=String(value||"").match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
    if(!parts) return value||"";
    return new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"})
      .format(new Date(Date.UTC(Number(parts[1]),Number(parts[2])-1,Number(parts[3]))));
  }
  function choiceDisplay(value,labels){
    return (value&&labels[value])||value||"";
  }
  function row(label,value){
    return '<div class="review-row"><span>'+esc(label)+'</span><b>'+display(value)+'</b></div>';
  }
  function section(title,editStep,body){
    return '<section class="review-section"><div class="review-head"><h3>'+esc(title)+'</h3><button class="edit" type="button" data-edit="'+editStep+'">Edit</button></div><div class="review-body">'+body+'</div></section>';
  }
  function renderReview(){
    capture();
    var dob=isoDob();
    var residence=currentAddress();
    var pets=state.has_pets==="yes" ? (state.pets_description || "Yes") : "No";
    var guarantor=state.guarantor_needed==="yes" ? (state.guarantor_name || "Yes") : (state.guarantor_needed==="unsure" ? "Not sure" : "No");
    var options=(CTX&&CTX.application_options)||{};
    var html="";
    html+=section("Applicant",1,
      row("Legal name",state.legal_name)+row("Date of birth",dateDisplay(dob))+row("Email",state.email)+row("Phone",state.phone)+
      row("How you heard",choiceDisplay(state.lead_source,{referral:"Friend or current resident",search:"Web search",listing:"Rental listing site",social:"Social media",sign:"Sign or walked by",school:"School or campus resource",other:"Other"})));
    html+=section("Residence",2,
      row("Current address",residence)+row("Living there since",state.current_since)+
      row("Housing",choiceDisplay(state.housing_status,{rent:"Renting",own:"Owning",other:"Other"}))+
      row("Monthly payment",state.housing_payment ? "$"+state.housing_payment : ""));
    var incomeBody=row("Situation",choiceDisplay(state.income_status,{employed:"Employed",self_employed:"Self-employed",student:"Student",retired:"Retired",not_working:"Not currently working",other:"Other"}));
    if(state.income_status==="employed"||state.income_status==="self_employed"){
      incomeBody+=row("Employer or business",state.employer)+row("Job title or work",state.job_title);
    }
    if(state.income_status==="student"){
      incomeBody+=row("School",state.school_name)+row("Graduation year",state.graduation_year);
    }
    incomeBody+=row("Primary income",moneyDisplay(state.income_amount,state.income_frequency))+
      row("Additional income",state.additional_income ? moneyDisplay(state.additional_income,state.additional_income_frequency) : "");
    html+=section("Income",3,incomeBody);
    var householdBody=row("Preferred move-in",dateDisplay(state.desired_move_in))+
      row("Date flexibility",choiceDisplay(state.move_flexibility,{exact:"That date is important",plus_minus_7:"Within about one week",plus_minus_30:"Within about one month",flexible:"Flexible"}))+
      row("Total occupants",state.occupants)+
      (Number(state.occupants)>1?row("Other adult occupants",state.household_names):"")+
      row("Pets or assistance animals",pets)+row("Guarantor or co-signer",guarantor)+
      (state.guarantor_needed==="yes"?row("Guarantor contact",[state.guarantor_phone,state.guarantor_email].filter(Boolean).join(" · ")):"")+
      (options.ask_parking_interest?row("Parking",choiceDisplay(state.parking_interest,{interested:"Interested",none:"Not needed",unsure:"Not sure"})):"")+
      (options.ask_utility_payment_preference?row("Utility-fee preference",choiceDisplay(state.utility_payment_preference,{monthly:"Monthly",upfront:"Up front",unsure:"Not sure"})):"")+
      row("Vehicles",state.vehicles);
    html+=section("Household and move-in",4,householdBody);
    byId("review").innerHTML=html;
    document.querySelectorAll("[data-edit]").forEach(function(button){
      button.onclick=function(){showStep(Number(button.getAttribute("data-edit")));};
    });
  }
  function capturedPayload(){
    var primaryMonthly=monthlyAmount(state.income_amount,state.income_frequency);
    var additionalMonthly=monthlyAmount(state.additional_income,state.additional_income_frequency);
    return {
      application_form_version:"tenant_v3",
      date_of_birth:isoDob(),
      email:state.email||null,
      phone:state.phone||null,
      lead_source:state.lead_source||null,
      current_address:currentAddress()||null,
      address:{
        line1:state.address_line1||null,line2:state.address_line2||null,
        city:state.city||null,state:state.state_code||null,postal_code:state.postal_code||null
      },
      current_since:state.current_since||null,
      housing_status:state.housing_status||null,
      housing_payment:normalizeMoney(state.housing_payment),
      landlord_contact:state.landlord_contact||null,
      prior_residence:monthsAtCurrent()!=null && monthsAtCurrent()<24 ? {
        address:state.prior_address||null,city:state.prior_city||null,
        state:state.prior_state||null,postal_code:state.prior_postal||null,
        landlord_contact:state.prior_landlord_contact||null
      } : null,
      income_status:state.income_status||null,
      employer:state.employer||null,
      job_title:state.job_title||null,
      employment_start:state.employment_start||null,
      school_name:state.school_name||null,
      graduation_year:state.graduation_year||null,
      student_id:state.student_id||null,
      income_amount:normalizeMoney(state.income_amount),
      income_frequency:state.income_frequency||null,
      monthly_income:primaryMonthly,
      additional_income_amount:normalizeMoney(state.additional_income),
      additional_income_frequency:state.additional_income_frequency||null,
      total_monthly_income:(primaryMonthly||0)+(additionalMonthly||0),
      income_notes:state.income_notes||null,
      desired_move_in:state.desired_move_in||null,
      move_flexibility:state.move_flexibility||null,
      occupants:Number(state.occupants)||null,
      household_names:state.household_names||null,
      has_pets:state.has_pets||null,
      pets:state.has_pets==="yes" ? (state.pets_description||"Yes") : "None",
      guarantor_needed:state.guarantor_needed||null,
      guarantor_contact:state.guarantor_needed==="yes" ? {
        name:state.guarantor_name||null,phone:state.guarantor_phone||null,email:state.guarantor_email||null
      } : null,
      parking_interest:state.parking_interest||null,
      utility_payment_preference:state.utility_payment_preference||null,
      vehicles:state.vehicles||null,
      additional_notes:state.additional_notes||null
    };
  }
  async function submit(){
    capture();
    var error=byId("serverError");
    error.classList.remove("on");
    if(!byId("certify").checked){
      error.textContent="Confirm that the information is complete and accurate before submitting.";
      error.classList.add("on");
      byId("certify").focus();
      return;
    }
    if(!byId("electronicConsent").checked){
      error.textContent="Confirm how the leasing team may send application and lease updates.";
      error.classList.add("on");
      byId("electronicConsent").focus();
      return;
    }
    var button=byId("submitButton");
    button.disabled=true;button.textContent="Submitting…";
    try{
      var response=await fetch("/applications/submit-public",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          token:TOKEN,
          applicant_name:state.legal_name||null,
          guarantor_name:state.guarantor_needed==="yes" ? (state.guarantor_name||null) : null,
          captured:Object.assign(capturedPayload(),{
            applicant_accuracy_certified:true,
            electronic_delivery_consent:true
          })
        })
      });
      var out=await response.json().catch(function(){return null;});
      if(!response.ok){
        button.disabled=false;button.textContent="Submit application";
        error.textContent=(out&&out.receipt)||"The application could not be submitted. Please try again.";
        error.classList.add("on");
        return;
      }
      clearDraft();
      byId("main").innerHTML='<div class="message"><div class="message-mark">✓</div><h2>Application submitted</h2><p>The leasing team has your application. Submitting is not an approval or a lease; they will contact you about the next step.</p></div>';
    }catch(e){
      button.disabled=false;button.textContent="Submit application";
      error.textContent="Please check your connection and try again.";
      error.classList.add("on");
    }
  }
  async function boot(){
    try{
      var response=await fetch("/t/application/"+encodeURIComponent(TOKEN)+"/context",{cache:"no-store"});
      CTX=await response.json();
    }catch(e){
      byId("main").innerHTML='<div class="message"><h2>Could not open the application</h2><p>Please try again or contact the leasing office.</p></div>';
      return;
    }
    if(!CTX || CTX.state!=="open"){
      var messages={
        invalid:["This link is not valid",CTX&&CTX.receipt],
        revoked:["This link was revoked",CTX&&CTX.receipt],
        expired:["This link expired",CTX&&CTX.receipt],
        not_sent:["This link is not active yet",CTX&&CTX.receipt],
        already_submitted:["Application already submitted",CTX&&CTX.receipt],
        unavailable:["Application unavailable",CTX&&CTX.receipt]
      };
      var chosen=messages[(CTX&&CTX.state)||"unavailable"]||messages.unavailable;
      byId("main").innerHTML='<div class="message"><h2>'+esc(chosen[0])+'</h2><p>'+esc(chosen[1]||"Contact the leasing office.")+'</p></div>';
      return;
    }
    byId("propertyName").textContent=CTX.property_name||"Rental application";
    byId("unitPill").textContent=CTX.unit_label ? "Unit "+CTX.unit_label : "Rental application";
    if(CTX.intended_move_in){
      byId("targetMoveRow").hidden=false;
      byId("targetMoveIn").textContent=dateDisplay(CTX.intended_move_in);
    }
    var options=CTX.application_options||{};
    if(options.ask_parking_interest){
      byId("parkingField").hidden=false;
      byId("parkingNote").textContent=options.parking_note||"Interest is not a reservation. The leasing team confirms availability and terms.";
    }
    if(options.ask_utility_payment_preference){
      byId("utilityChoiceField").hidden=false;
      byId("utilityChoiceNote").textContent=options.utility_payment_note||"This records your preference. The lease states the final fee and schedule.";
    }
    restoreDraft();
    if(CTX.person){
      state.legal_name=state.legal_name||CTX.person.name||"";
      state.email=state.email||CTX.person.email||"";
      state.phone=state.phone||CTX.person.phone||"";
    }
    if(CTX.intended_move_in){
      state.desired_move_in=state.desired_move_in||CTX.intended_move_in;
      var targetHint=byId("moveMonthHint");
      targetHint.style.display="block";
      targetHint.querySelector("p").textContent="The leasing team targeted "+dateDisplay(CTX.intended_move_in)+" for this home. You may request a later date here.";
    }else if(CTX.prefill&&CTX.prefill.move_month){
      var hint=byId("moveMonthHint");
      hint.style.display="block";
      hint.querySelector("p").textContent="You previously discussed a move around "+CTX.prefill.move_month+". Choose the specific date that works best.";
    }
    var today=new Date();
    var localToday=new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,10);
    byId("desired_move_in").min=CTX.intended_move_in||localToday;
    hydrate();
    showStep(0);
  }

  document.addEventListener("click",function(event){
    var next=event.target.closest("[data-next]");
    if(next){
      capture();
      if(step>0 && step<5 && !validateStep(step)) return;
      showStep(step+1);
      return;
    }
    var back=event.target.closest("[data-back]");
    if(back){capture();showStep(step-1);}
  });
  document.addEventListener("input",function(event){
    if(event.target && event.target.matches("input,select,textarea")){capture();}
  });
  document.addEventListener("change",function(event){
    if(event.target.matches("input,select,textarea")){capture();updateConditionals();}
  });
  byId("submitButton").addEventListener("click",submit);
  boot();
})();
</script>
</body>
</html>`);
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
  async function sendApplication({
    property_id, person_id, unit_id, space_id = null, intended_move_in = null,
    conversion_id = null, created_by_user_id = null,
  }) {
    // 1) DOUBLE-TAP GUARD — an already-sent, still-live invitation on this
    //    conversion means the application is already out; we do NOT send a second
    //    text. BUT "already sent" is not the same as "already in Applicants":
    //    the opportunity may have lost its applicant rung (a revoke/resend
    //    cycle, or an earlier advance that never landed). So we still ENSURE the
    //    advance here (idempotent — a no-op if the open rung already exists).
    //    This is the reconciling path: it can never double-text, but it can
    //    always correct a stranded position.
    if (conversion_id) {
      const existing = (await pool.query(
        `select id, status, provider_message_id from application_invitations
          where conversion_id=$1 and status in ('manually_sent','provider_dispatched')
          order by sent_at desc nulls last limit 1`, [conversion_id])).rows[0];
      if (existing) {
        let applicant_followup = null;
        try {
          await runTx(async (client) => {
            applicant_followup = await advanceOpportunityToApplicants(client, {
              conversion_id, invitation_id: existing.id, by_user_id: created_by_user_id || null });
          });
        } catch (e) {
          applicant_followup = { advance_error: e.publicMessage || e.message };
        }
        return { sent: true, idempotent: true, invitation_id: existing.id, status: existing.status,
                 provider_message_id: existing.provider_message_id || null,
                 applicant_followup,
                 receipt: "Application already sent — no second text. Position reconciled." };
      }
    }
    // 2) DISPATCH — the proven primitive (validates person+unit belong to the
    //    property, creates the prepared invitation, sends via the ONE comms
    //    gate, records the SID on acceptance; on refusal, revokes honestly).
    //  The target is one durable tuple: property + unit + bed + intended date.
    //  Future targeting is accepted only when canonical availability can prove
    //  the turn-ready date, and submission rechecks the same persisted tuple.
    const out = await createAndDispatchApplicationInvitation({
      property_id, person_id, unit_id, space_id, intended_move_in,
      conversion_id, created_by_user_id });
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

  // ════════════════════════════════════════════════════════════════════
  //  APPLICATION LINK LIFECYCLE (v2.5-r1) — prepare / send / correct
  //
  //  The correction gate NEVER touches the wire. It classifies durable DB
  //  evidence only, and every state-changing correction RE-CLASSIFIES UNDER
  //  the invitation FOR UPDATE lock (never acts on an unlocked preliminary
  //  read). Provider Phase 1 takes the same lock before binding
  //  dispatch_comm_event_id. Whichever transaction wins the lock controls
  //  the result — no revoked-before-send fiction, no duplicate text.
  // ════════════════════════════════════════════════════════════════════
  const SENT_STATUSES = ["manually_sent", "provider_dispatched"];
  const ACTIVE_STATUSES = ["prepared", "manually_sent", "provider_dispatched"];

  function requireInputAuthority() {
    if (!applicationInputAuthority) throw httpErr(500, "application input authority not wired.");
    return applicationInputAuthority;
  }

  // ── shared DB-only classifier (works on an already-loaded invitation row) ──
  async function classifyDispatch(q, inv) {
    if (!inv.dispatch_comm_event_id) return { state: "no_attempt", comm_event_id: null };
    const evt = (await q.query(
      "select id, sms_sid, sms_status from comm_events where id=$1",
      [inv.dispatch_comm_event_id])).rows[0];
    if (!evt) return { state: "indeterminate", comm_event_id: inv.dispatch_comm_event_id };
    if (evt.sms_sid) return { state: "accepted", comm_event_id: evt.id, sms_sid: evt.sms_sid };
    if (["refused", "failed"].includes(evt.sms_status || "")) {
      return { state: "refused", comm_event_id: evt.id, sms_status: evt.sms_status };
    }
    return { state: "indeterminate", comm_event_id: evt.id };
  }

  // pool-level READ — never sends, never locks, never mutates
  async function inspectDispatchState(invitation_id) {
    const inv = (await pool.query(
      "select * from application_invitations where id=$1", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    const cls = await classifyDispatch(pool, inv);
    return { invitation_id, status: inv.status, ...cls };
  }

  // the exact open send child for an invitation (locked when for_update)
  async function openSendChild(client, invitation_id, { for_update = false } = {}) {
    return (await client.query(
      `select * from obligations
        where related_type='application_invitation' and related_id=$1
          and type='send_application_link' and status='open'
        limit 1 ${for_update ? "for update" : ""}`, [invitation_id])).rows[0] || null;
  }

  // ── PREPARE composite: the exact-obligation door ──────────────────────
  //  Locks the EXACT prepare child, verifies everything a stale client could
  //  have wrong, revalidates the unit, creates the invitation (one-active
  //  index guards duplicates), closes the prepare child through the input
  //  authority, opens the invitation-specific send child. Parent untouched,
  //  stage NOT advanced.
  async function prepareApplicationLinkForObligation(client, {
    prepare_obligation_id, unit_id = null, space_id = null, intended_move_in = null, expires_at = null,
    actor_user_id, unitOfferable = null,
  }) {
    if (!prepare_obligation_id) throw httpErr(400, "prepare_obligation_id is required.");
    if (!actor_user_id) throw httpErr(400, "actor_user_id is required.");
    const ob = (await client.query(
      "select * from obligations where id=$1 for update", [prepare_obligation_id])).rows[0];
    if (!ob) throw httpErr(404, "No obligation with that id.");
    if (ob.type !== "prepare_application_link" || ob.related_type !== "leasing_conversion") {
      throw httpErr(409, "That obligation is not a prepare-application-link commitment.");
    }
    if (ob.status !== "open") throw httpErr(409, "That prepare commitment is no longer open — refresh and use the current action.");
    if (!ob.parent_obligation_id) throw httpErr(500, "prepare child has no parent linkage — data fault.");
    const conversion_id = ob.related_id;
    const conv = (await client.query(
      "select * from leasing_conversions where id=$1 for update", [conversion_id])).rows[0];
    if (!conv) throw httpErr(404, "conversion not found.");

    // authority on the child: owner or role coverage (server-derived)
    const basis = await conversionService.resolveSendActionBasis(client, {
      actor_user_id, property_id: conv.property_id, stored_owner_user_id: ob.assigned_user_id,
    });
    if (!basis.allowed) throw httpErr(403, "You are not the owner of this commitment and hold no covering role for it.");

    // CURRENT TERMINAL STATE — "does a live application already exist on this
    // conversation right now?" Present tense, so a status read is correct; what
    // was wrong is the list. It omitted 'expired', so an expired application
    // read as LIVE and permanently blocked a new one, and it filtered 'denied',
    // which the CHECK constraint does not permit and no row can hold.
    // The canonical TERMINAL group is bound as a parameter — no literal ladder.
    const nonterminal = (await client.query(
      `select status from lease_applications where conversion_id=$1
        and status <> all($2::text[]) limit 1`,
      [conversion_id, lifecycleRead.STATUS_GROUP_PARAMS.terminal])).rows[0];
    // An unrecognized status is not silently "live": it is surfaced as its own
    // refusal, because we cannot say what it means.
    if (nonterminal && !lifecycleRead.isKnownStatus(nonterminal.status)) {
      throw httpErr(409, `This conversation has an application in an unrecognized state ('${nonterminal.status}'). Resolve it before continuing.`);
    }
    if (nonterminal) throw httpErr(409, "A live application already exists on this conversation.");

    // ── UNIT REVALIDATION AT PREPARATION (eligibility, never a hold) ──
    //  The injected `unitOfferable` seam is kept ONLY as a caller-supplied
    //  override; when absent this now falls back to the canonical authority
    //  rather than skipping validation entirely. Preparation cannot proceed
    //  on an unresolved target.
    if (unit_id || space_id) {
      const verdict = unitOfferable
        ? await unitOfferable(client, {
            property_id: conv.property_id, unit_id, space_id, intended_move_in,
          })
        : await applicationTarget.resolveApplicationTarget(client, {
            property_id: conv.property_id, unit_id, space_id, intended_move_in,
            require_offerable: true });
      if (!verdict || verdict.offerable === false || verdict.ok === false) {
        const why = verdict && (verdict.refusal_reason || verdict.reason);
        throw httpErr(
          (verdict && verdict.httpStatus) || 409,
          why || "That unit is no longer offerable. Choose a current unit.",
          verdict && verdict.refusal_code);
      }
    }

    let made;
    try {
      made = await createPreparedInvitation(client, {
        conversion_id, person_id: conv.person_id, property_id: conv.property_id,
        unit_id, space_id, intended_move_in, expires_at, created_by_user_id: actor_user_id,
      });
    } catch (e) {
      if (e && e.code === "23505") {
        throw httpErr(409, "An active invitation already exists for this conversation — regenerate or revoke it instead of preparing another.");
      }
      throw e;
    }

    // close the prepare child through the RESERVED input authority (structured proof)
    const currentIntent = (await client.query(
      `select ai.id from application_intents ai where ai.conversion_id=$1
          and not exists (select 1 from application_intents s where s.supersedes_intent_id=ai.id)
        order by ai.recorded_at desc limit 1`, [conversion_id])).rows[0];
    await requireInputAuthority().satisfyApplicationInput(client, {
      obligation_id: prepare_obligation_id,
      input_code: "application_invitation_prepared",
      invitation_id: made.invitation_id,
      intent_id: currentIntent ? currentIntent.id : null,
      parent_obligation_id: ob.parent_obligation_id,
      unit_id, actor_user_id,
      expected_invitation_status: "prepared",
    });
    await client.query(
      "update obligations set resolution_code='satisfied' where id=$1 and status='complete'",
      [prepare_obligation_id]);

    const sendChild = await conversionService.openSendObligationOnPrepare(client, {
      invitation_id: made.invitation_id, conversion_id,
      parent_obligation_id: ob.parent_obligation_id,
      candidate_owner_user_ids: [ob.assigned_user_id, actor_user_id],
    });

    return {
      receipt: "Application link prepared. Copy it and send it through the real channel, then attest the send — the follow-up stays open until the link is actually sent.",
      invitation_id: made.invitation_id, token: made.token,
      space_id: made.resolved_space_id || null,
      intended_move_in: made.intended_move_in || null,
      send_obligation_id: sendChild.id,
      parent_obligation_id: ob.parent_obligation_id,
      conversion_id, prepared_by_basis: basis.basis,
    };
  }

  // ── FINALIZE: the ONE final-send transaction (manual + provider) ──────
  //  r1: PERFORMS the sent-state transition itself under the locks. Never
  //  called with a pre-written sent status. Idempotent on matching evidence;
  //  conflicting evidence → controlled 409 (one authoritative send fact).
  async function finalizeInvitationSent(client, {
    invitation_id, send_obligation_id, dispatch_source,
    actor_user_id = null, provider_message_id = null,
    recipient_snapshot = null, channel = null, note = null,
  }) {
    if (!["manual", "provider"].includes(dispatch_source)) {
      throw httpErr(400, "dispatch_source must be 'manual' or 'provider'.");
    }
    const inv = (await client.query(
      "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    const child = (await client.query(
      "select * from obligations where id=$1 for update", [send_obligation_id])).rows[0];
    if (!child || child.type !== "send_application_link" || child.related_id !== invitation_id) {
      throw httpErr(409, "That obligation is not the send commitment for this invitation.");
    }
    if (!child.parent_obligation_id) throw httpErr(500, "send child has no parent linkage — data fault.");

    // idempotent vs conflict on an already-sent invitation
    if (SENT_STATUSES.includes(inv.status)) {
      const sameSource = (dispatch_source === "provider") === (inv.status === "provider_dispatched");
      const sameEvidence = dispatch_source === "provider"
        ? (inv.provider_message_id && provider_message_id && inv.provider_message_id === provider_message_id)
        : (inv.status === "manually_sent");
      if (sameSource && sameEvidence && child.status === "complete" && child.resolution_code === "satisfied") {
        return { finalized: false, idempotent: true, invitation_id, status: inv.status,
                 receipt: "Already finalized — the send fact stands; nothing re-run." };
      }
      throw httpErr(409, `Invitation already carries a ${inv.status} send fact with different evidence — one authoritative send fact wins; record a correction instead.`);
    }
    if (inv.status !== "prepared") {
      throw httpErr(409, `Invitation is '${inv.status}' — a send cannot be finalized from that state.`);
    }
    if (child.status !== "open") throw httpErr(409, "The send commitment is not open.");

    // authority + evidence
    let basisWord = null;
    if (dispatch_source === "manual") {
      if (!actor_user_id) throw httpErr(400, "manual send requires the attesting user.");
      if (!["sms", "email", "other"].includes(channel || "")) {
        throw httpErr(400, "channel must be 'sms', 'email', or 'other'.");
      }
      if ((channel === "sms" || channel === "email") && !recipient_snapshot) {
        throw httpErr(400, `manual ${channel} send requires recipient_snapshot (the destination as sent).`);
      }
      const basis = await conversionService.resolveSendActionBasis(client, {
        actor_user_id, property_id: inv.property_id, stored_owner_user_id: child.assigned_user_id,
      });
      if (!basis.allowed) throw httpErr(403, "You are not the owner of this send commitment and hold no covering role for it.");
      basisWord = basis.basis;
    } else {
      if (!provider_message_id) throw httpErr(400, "provider finalization requires provider_message_id (the accepted transport evidence).");
    }

    // r1: THE TRANSITION HAPPENS HERE, under the locks
    if (dispatch_source === "manual") {
      await client.query(
        `update application_invitations
            set status='manually_sent', dispatch_source='manual', channel=$1,
                recipient_snapshot=$2, sent_by_user_id=$3, sent_at=now(),
                sent_note=$4, updated_at=now()
          where id=$5`,
        [channel, recipient_snapshot, actor_user_id, note, invitation_id]);
    } else {
      await client.query(
        `update application_invitations
            set status='provider_dispatched', dispatch_source='provider', channel='sms',
                provider_message_id=$1, sent_by_user_id=$2, sent_at=now(),
                sent_note=$3, updated_at=now()
          where id=$4`,
        [provider_message_id, actor_user_id, note, invitation_id]);
    }

    // structured proof + reserved-input satisfaction + child completion
    await requireInputAuthority().satisfyApplicationInput(client, {
      obligation_id: send_obligation_id,
      input_code: "application_invitation_sent",
      invitation_id,
      parent_obligation_id: child.parent_obligation_id,
      unit_id: inv.unit_id || null, actor_user_id,
      expected_invitation_status: dispatch_source === "manual" ? "manually_sent" : "provider_dispatched",
    });
    await client.query(
      "update obligations set resolution_code='satisfied' where id=$1 and status='complete'",
      [send_obligation_id]);

    // close the EXACT parent through the RAIL (write-once). Rail basis
    // vocabulary: 'coverage' only when an identified human closes a parent
    // rung they don't own; owner/service closes resolve without a basis.
    const parentLink = (await client.query(
      "select owner_user_id from leasing_conversion_obligations where obligation_id=$1",
      [child.parent_obligation_id])).rows[0];
    const closerOwnsParent = actor_user_id != null && parentLink && parentLink.owner_user_id != null
      && String(parentLink.owner_user_id) === String(actor_user_id);
    await conversionService.closeParentViaRail(client, {
      parent_obligation_id: child.parent_obligation_id,
      by_user_id: actor_user_id,
      resolution_basis: (actor_user_id != null && !closerOwnsParent) ? "coverage" : null,
      proof: { application_invitation_sent: invitation_id, dispatch_source,
               provider_message_id: provider_message_id || undefined },
    });
    if (inv.conversion_id) {
      await conversionService.ensureApplicantFollowup(client, { conversion_id: inv.conversion_id });
    }
    return {
      finalized: true, invitation_id,
      status: dispatch_source === "manual" ? "manually_sent" : "provider_dispatched",
      send_obligation_id, parent_obligation_id: child.parent_obligation_id,
      receipt: dispatch_source === "manual"
        ? "Send attested. The post-tour follow-up is closed and the applicant follow-up is open."
        : "Application link dispatched (transport accepted). Follow-up advanced to applicant.",
    };
  }

  // ── LOST-TOKEN regeneration (correction/drain; not birth-gated) ───────
  async function regenerateInvitation(client, { invitation_id, actor_user_id }) {
    if (!actor_user_id) throw httpErr(400, "actor_user_id is required.");
    const inv = (await client.query(
      "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (inv.status !== "prepared") {
      throw httpErr(409, `Only a 'prepared' invitation can be regenerated (this one is '${inv.status}').`);
    }
    // RE-CLASSIFY UNDER THE LOCK — a bound dispatch changes everything
    const cls = await classifyDispatch(client, inv);
    if (cls.state === "accepted") throw httpErr(409, "This link was already accepted by the provider — reconcile the send first (it cannot be regenerated as unsent).");
    if (cls.state === "indeterminate") throw httpErr(409, "A dispatch attempt for this link is unresolved — reconciliation is required before any correction. No resend will be attempted automatically.");
    if (cls.state === "refused") throw httpErr(409, "The dispatch was refused — use the refusal correction, then prepare a fresh link.");
    const child = await openSendChild(client, invitation_id, { for_update: true });
    if (!child) throw httpErr(409, "No open send commitment for this invitation — regeneration does not apply.");
    if (inv.lease_application_id) throw httpErr(409, "An application already exists on this invitation.");

    // revoke old FIRST (one-active-invitation index), supersede its child,
    // then create the replacement + its send child under the SAME parent.
    await client.query(
      `update application_invitations
          set status='revoked', revoked_by_user_id=$1, revoked_at=now(),
              revoked_reason='superseded_lost_token', updated_at=now()
        where id=$2`, [actor_user_id, invitation_id]);
    await conversionService.terminateChildObligation(client, {
      obligation_id: child.id, resolution_code: "superseded", by_user_id: actor_user_id });

    const made = await createPreparedInvitation(client, {
      conversion_id: inv.conversion_id, person_id: inv.person_id,
      property_id: inv.property_id, unit_id: inv.unit_id, space_id: inv.space_id,
      intended_move_in: inv.intended_move_in,
      expires_at: inv.expires_at, created_by_user_id: actor_user_id,
    });
    await client.query(
      "update application_invitations set superseded_by_invitation_id=$1, updated_at=now() where id=$2",
      [made.invitation_id, invitation_id]);
    const newChild = await conversionService.openSendObligationOnPrepare(client, {
      invitation_id: made.invitation_id, conversion_id: inv.conversion_id,
      parent_obligation_id: child.parent_obligation_id,
      candidate_owner_user_ids: [child.assigned_user_id, actor_user_id],
    });
    return {
      receipt: "Fresh link generated. The old link is dead — nothing already sent will work twice.",
      invitation_id: made.invitation_id, token: made.token,
      send_obligation_id: newChild.id, parent_obligation_id: child.parent_obligation_id,
      superseded_invitation_id: invitation_id,
    };
  }

  // ── EXPIRY (branched pre-send / post-send; classification under lock) ──
  async function expireInvitationService(client, { invitation_id, actor_user_id = null }) {
    const inv = (await client.query(
      "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (!ACTIVE_STATUSES.includes(inv.status)) {
      throw httpErr(409, `Invitation is '${inv.status}' — expiry applies to active invitations.`);
    }
    if (!inv.expires_at || new Date(inv.expires_at) > new Date()) {
      throw httpErr(409, "This invitation has not passed its expiry time.");
    }
    if (inv.status === "prepared") {
      const cls = await classifyDispatch(client, inv); // UNDER the lock
      if (cls.state === "accepted") throw httpErr(409, "This link was accepted by the provider — reconcile the send first; post-send expiry then applies.");
      if (cls.state === "indeterminate") throw httpErr(409, "A dispatch attempt is unresolved — reconciliation is required before expiry. No resend will be attempted.");
      // no_attempt (or durably refused) → branch A: pre-send expiry
      await client.query(
        "update application_invitations set status='expired', updated_at=now() where id=$1",
        [invitation_id]);
      const child = await openSendChild(client, invitation_id, { for_update: true });
      if (child) {
        await conversionService.terminateChildObligation(client, {
          obligation_id: child.id,
          resolution_code: cls.state === "refused" ? "dispatch_refused" : "expired",
          by_user_id: actor_user_id });
      }
      return { expired: true, branch: "pre_send", invitation_id,
               receipt: "Link expired before any send. The post-tour follow-up stays open — prepare a fresh link when ready." };
    }
    // branch B: post-send — invitation only; send fact, child, parent, stage untouched
    await client.query(
      "update application_invitations set status='expired', updated_at=now() where id=$1",
      [invitation_id]);
    return { expired: true, branch: "post_send", invitation_id,
             receipt: "Sent link expired. The send fact stands; the applicant follow-up is unchanged. A replacement link is applicant-stage work." };
  }

  // ── REVOCATION (branched by state; classification under lock) ─────────
  async function revokeInvitationCorrection(client, { invitation_id, actor_user_id, reason = null }) {
    if (!actor_user_id) throw httpErr(400, "actor_user_id is required.");
    const inv = (await client.query(
      "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
    if (!inv) throw httpErr(404, "No invitation with that id.");
    if (inv.status === "consumed") throw httpErr(409, "This link was already used to open an application — it cannot be revoked; work the application instead.");
    if (["revoked", "expired"].includes(inv.status)) {
      return { revoked: false, idempotent: true, invitation_id, status: inv.status };
    }
    if (inv.status === "prepared") {
      const cls = await classifyDispatch(client, inv); // UNDER the lock (M34)
      if (cls.state === "accepted") throw httpErr(409, "This link was accepted by the provider — reconcile the send first; the revoke then applies as a post-send correction.");
      if (cls.state === "indeterminate") throw httpErr(409, "A dispatch attempt is unresolved — reconciliation is required before revoking. No resend will be attempted.");
      await client.query(
        `update application_invitations
            set status='revoked', revoked_by_user_id=$1, revoked_at=now(),
                revoked_reason=$2, updated_at=now()
          where id=$3`,
        [actor_user_id, reason || (cls.state === "refused" ? "dispatch_refused" : "operator_revoked"), invitation_id]);
      const child = await openSendChild(client, invitation_id, { for_update: true });
      if (child) {
        await conversionService.terminateChildObligation(client, {
          obligation_id: child.id,
          resolution_code: cls.state === "refused" ? "dispatch_refused" : "revoked",
          by_user_id: actor_user_id });
      }
      return { revoked: true, branch: "pre_send", invitation_id,
               resolution: cls.state === "refused" ? "dispatch_refused" : "revoked",
               receipt: "Link revoked before any send. The post-tour follow-up stays open — retry is available." };
    }
    // sent states: post-send correction — the send fact is history, not fiction
    await client.query(
      `update application_invitations
          set status='revoked', revoked_by_user_id=$1, revoked_at=now(),
              revoked_reason=$2, updated_at=now()
        where id=$3`,
      [actor_user_id, reason || "post_send_correction", invitation_id]);
    return { revoked: true, branch: "post_send", invitation_id,
             receipt: "Sent link revoked as a correction. The original send fact, the completed follow-up, and the applicant stage all stand." };
  }

  // ── RECONCILE-THEN-CORRECT orchestrator (pool-level; SHORT txns; NEVER sends) ──
  async function reconcileCorrection({ invitation_id, requested_action, actor_user_id, reason = null }) {
    if (!["revoke", "expire"].includes(requested_action)) {
      throw httpErr(400, "requested_action must be 'revoke' or 'expire'.");
    }
    // txn 1: classify UNDER the lock; if not accepted, perform the correction
    // in this same locked transaction (the services re-classify internally).
    const first = await runTx(async (client) => {
      const inv = (await client.query(
        "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
      if (!inv) throw httpErr(404, "No invitation with that id.");
      if (inv.status !== "prepared") return { path: "direct" };
      const cls = await classifyDispatch(client, inv);
      if (cls.state === "accepted") return { path: "reconcile_first", sms_sid: cls.sms_sid };
      return { path: "direct" }; // no_attempt / refused / indeterminate — services enforce
    });

    if (first.path === "reconcile_first") {
      // the send already happened on the wire — record it (its OWN locked txn,
      // pure DB), then apply the requested action with post-send semantics.
      await runTx(async (client) => {
        const child = await openSendChild(client, invitation_id, { for_update: true });
        if (child) {
          await finalizeInvitationSent(client, {
            invitation_id, send_obligation_id: child.id,
            dispatch_source: "provider", provider_message_id: first.sms_sid,
            actor_user_id: actor_user_id || null,
            note: "Reconciled: provider acceptance recorded during correction.",
          });
        }
      });
    }
    // the requested action re-locks and applies (post-send semantics if reconciled)
    return runTx(async (client) => {
      return requested_action === "revoke"
        ? revokeInvitationCorrection(client, { invitation_id, actor_user_id, reason })
        : expireInvitationService(client, { invitation_id, actor_user_id });
    });
  }

  // ── RETRY with the dispatch gate (prior invitation must be provably unsent) ──
  async function beginRetryWithDispatchGate(client, { parent_obligation_id, prior_invitation_id, prior_send_obligation_id, by_user_id = null }) {
    const prior = (await client.query(
      "select * from application_invitations where id=$1 for update", [prior_invitation_id])).rows[0];
    if (!prior) throw httpErr(404, "No prior invitation with that id.");
    const cls = await classifyDispatch(client, prior);
    if (cls.state === "accepted") throw httpErr(409, "The prior link was accepted by the provider — it was sent; retry would create a duplicate. Reconcile the send instead.");
    if (cls.state === "indeterminate") throw httpErr(409, "The prior dispatch is unresolved — reconciliation is required before retry. No resend will be attempted.");
    return conversionService.beginApplicationLinkRetry(client, {
      parent_obligation_id, prior_invitation_id, prior_send_obligation_id, by_user_id });
  }

  // ── PROVIDER DISPATCH of a just-prepared link (three phases, lock invariant) ──
  //  Phase 1 takes the invitation FOR UPDATE, REVERIFIES prepared + open send
  //  child + no prior dispatch binding, composes the body from the raw token
  //  the caller still holds, and binds dispatch_comm_event_id. Phase 2 is the
  //  ONE wire gate. Phase 3 finalizes; refusal takes the correction path.
  async function dispatchPreparedLinkProvider({ invitation_id, raw_token, actor_user_id = null, message_prefix = "" }) {
    if (!commBoundary) throw httpErr(409, "Communications boundary is not wired — provider dispatch is unavailable; send manually and attest.");
    if (!raw_token) throw httpErr(400, "raw_token is required (provider dispatch happens in the same action that prepared the link).");
    const base = (process.env.PUBLIC_APPLY_BASE_URL || "").trim().replace(/\/$/, "");
    if (!base) throw httpErr(409, "PUBLIC_APPLY_BASE_URL is not configured — provider dispatch is unavailable.");

    // Phase 1 (txn): LOCK + REVERIFY + bind the save-first comm_event
    const made = await runTx(async (client) => {
      const inv = (await client.query(
        "select * from application_invitations where id=$1 for update", [invitation_id])).rows[0];
      if (!inv) throw httpErr(404, "No invitation with that id.");
      if (inv.status !== "prepared") throw httpErr(409, `Invitation is '${inv.status}' — dispatch requires a prepared link (a correction may have won the race).`);
      if (digestToken(raw_token) !== inv.token_digest) throw httpErr(403, "That token does not match this invitation.");
      if (inv.dispatch_comm_event_id) throw httpErr(409, "A dispatch attempt is already bound to this link — reconcile it; no second attempt will be made automatically.");
      const child = await openSendChild(client, invitation_id, { for_update: true });
      if (!child) throw httpErr(409, "No open send commitment for this invitation — dispatch does not apply.");
      const per = (await client.query("select id, phone from persons where id=$1", [inv.person_id])).rows[0];
      const url = `${base}/t/application/${raw_token}`;
      const body = `${message_prefix ? message_prefix + " " : ""}Here's your secure application link: ${url}`;
      const evt = (await client.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role, sent_by_user_id)
         values ($1,$2,$3,null,'text','outbound',$4,'leasing','agent',$5) returning id`,
        [inv.property_id, inv.person_id, inv.unit_id, body, actor_user_id])).rows[0];
      await client.query(
        "update application_invitations set dispatch_comm_event_id=$1, updated_at=now() where id=$2",
        [evt.id, invitation_id]);
      return { inv, child, body, evt_id: evt.id, phone: per ? per.phone : null };
    });

    if (!made.phone) {
      // refusal correction (its own txn, re-locking; classification will read 'refused' once stamped)
      await runTx(async (client) => {
        await client.query("update comm_events set sms_status='refused', sms_error='no_phone_on_person' where id=$1", [made.evt_id]);
        await revokeInvitationCorrection(client, { invitation_id, actor_user_id: actor_user_id || made.inv.created_by_user_id, reason: "dispatch refused: no_phone_on_person" });
      });
      return { dispatched: false, reason: "no_phone_on_person", invitation_id, status: "revoked",
               receipt: "Dispatch refused — the person has no phone on file. The link is revoked; the follow-up stays open for a fresh attempt." };
    }

    // Phase 2: the ONE wire gate (outside any txn)
    const wire = await commBoundary.sendPropertySms({
      property_id: made.inv.property_id, recipient: made.phone, body: made.body,
      purpose: "application_link", person_id: made.inv.person_id,
      eventId: made.evt_id, actor_user_id,
    });

    if (!wire.sent) {
      await runTx(async (client) => {
        // durable refusal evidence FIRST (idempotent with the boundary's own
        // stamp) so the under-lock classification reads 'refused', not
        // 'indeterminate' — this path witnessed the refusal first-hand.
        await client.query(
          "update comm_events set sms_status=coalesce(sms_status,'refused'), sms_error=coalesce(sms_error,$1) where id=$2 and sms_sid is null",
          [String(wire.reason || "gate_refused"), made.evt_id]);
        await revokeInvitationCorrection(client, { invitation_id, actor_user_id: actor_user_id || made.inv.created_by_user_id, reason: `dispatch refused by communications gate: ${wire.reason}` });
      });
      return { dispatched: false, reason: wire.reason, invitation_id, status: "revoked",
               receipt: `Dispatch refused (${wire.reason}). The link is revoked; the follow-up stays open — retry is available.` };
    }

    // Phase 3 (txn): finalize — the transition + closures happen HERE
    const fin = await runTx(async (client) => {
      return finalizeInvitationSent(client, {
        invitation_id, send_obligation_id: made.child.id,
        dispatch_source: "provider", provider_message_id: wire.sid,
        actor_user_id,
      });
    });
    return { dispatched: true, ...fin };
  }

  router._service = {
    sendApplication, createAndDispatchApplicationInvitation, createPreparedInvitation,
    attestInvitationSent, submitApplicationService, closeApprovalGate, spawnApprovalGate,
    approvalGateRole, resolveTenantContext,
    // v2.5-r1 application-link lifecycle
    inspectDispatchState, prepareApplicationLinkForObligation, finalizeInvitationSent,
    regenerateInvitation, expireInvitationService, revokeInvitationCorrection,
    reconcileCorrection, beginRetryWithDispatchGate, dispatchPreparedLinkProvider,
  };

  return router;
};
