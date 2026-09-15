// ════════════════════════════════════════════════════════════════════
//  lease_handoff.js — THE APPLICATION-TO-LEASE HANDOFF, OWED DURABLY.
//
//  An eligible application was completed and then nothing happened until a
//  person opened a screen and pressed a button. `generateLeasePacket` has
//  exactly one caller in the product (`src/identity/operator.js`), a staff
//  route. The applicant finished; the next step waited on somebody
//  remembering it.
//
//  ── WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT ────────────────
//  It adds ONE thing: a durable record, written in the submission
//  transaction, that the handoff is OWED — and an executor that discharges
//  it after commit.
//
//  It builds no second sender, no second workflow engine, no second
//  eligibility rule and no second packet writer. Every guard this needs
//  already exists and is proven:
//
//    still owed        assessLeasePacketEligibility refuses a packet that
//                      is already issued (PACKET_ISSUED_STATES), so a
//                      retry cannot produce a second one.
//    still authorized  generateLeasePacket locks the application `for
//                      update` and runs THE ONE eligibility predicate
//                      itself. This module never re-decides it.
//    current agreement readBoundApplicationOffer is read fresh INSIDE that
//                      call and THROWS on a superseded or unacknowledged
//                      offer — so an agreement that moved between
//                      submission and execution cannot be sent.
//    reachable         issueLeasePacketLink returns `already_issued` for a
//                      packet already sent instead of minting a second
//                      token.
//
//  This module's whole job is to make those calls happen without a person,
//  and to survive a restart between them.
//
//  ── WHY AN OBLIGATION AND NOT AN OUTBOX TABLE ────────────────────────
//  The work is owed BY SOMEONE, is visible on the board, escalates, and is
//  already how this system says "this is outstanding". An outbox would be a
//  second mechanism for the same sentence. `obligations.type` carries no
//  vocabulary CHECK, so this needs no migration; the per-type shape
//  constraints in 084/086 name other types and do not reach this one.
//
//  ── WHAT FAILURE MEANS HERE ──────────────────────────────────────────
//  The application is COMPLETE the moment its transaction commits. Nothing
//  in this file may undo that. An execution failure leaves the obligation
//  open and the application untouched, which is recoverable work rather
//  than a lost step. Each obligation is discharged in its OWN transaction
//  so one refusal cannot roll back another's packet.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════
"use strict";

//  The durable statement that the handoff is owed. One type, named for the
//  work rather than the mechanism.
const HANDOFF_TYPE = "lease_packet_preparation";

//  Owed work is not an unknown. These are the refusals that mean "not yet"
//  — the obligation stays open and a later run may succeed. Anything else
//  is unexpected and is reported as such rather than being swallowed into
//  a tidy "pending".
const NOT_YET = Object.freeze([
  "application_status_not_eligible",
  "no_open_terms_or_activation_gate",
  "no_current_proposed_terms_confirmation",
  "offer_superseded",
  "offer_not_acknowledged",
]);

//  These mean the work will NEVER be owed again. The obligation is closed
//  rather than left to rot on a board as a permanent false attention item.
const NEVER = Object.freeze([
  "application_terminal",
  "packet_already_submitted",
]);

module.exports = function leaseHandoffModule(deps = {}) {
  const { pool, spawnObligationFromEvent, satisfyObligation, completeObligation,
          leasePackets, commBoundary = null } = deps;
  if (!pool) throw new Error("lease_handoff requires a pool");

  /*  ── RECORDED WITH THE SUBMISSION, IN ITS TRANSACTION ──────────────
   *  Called with the submission's own client, so the statement that the
   *  handoff is owed commits with the application or not at all. A crash
   *  one instruction later loses nothing: the obligation is on disk.
   *
   *  GUARDED, NOT DEDUPE-KEYED. `obligations.dedupe_key` has a unique
   *  index, but migration 086 scoped it `WHERE type = 'operational_escalation'`
   *  — setting it on another type buys no uniqueness at all and would read
   *  as a guarantee that is not there. Instead the caller already holds the
   *  application row, so a check-then-insert is serialized by that lock.  */
  async function recordHandoffOwed(client, { application, source_event_id = null }) {
    if (!application || !application.id) throw new Error("recordHandoffOwed requires the application row");

    const open = (await client.query(
      `select id from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = $2 and status <> 'complete'
        limit 1`,
      [application.id, HANDOFF_TYPE]
    )).rows[0];
    if (open) return { owed: true, obligation_id: open.id, created: false };

    const ob = await spawnObligationFromEvent(client, {
      property_id: application.property_id,
      person_id: application.person_id,
      unit_id: application.unit_id,
      source_event_id,
      related_id: application.id, related_type: "lease_application",
      module: "applications", type: HANDOFF_TYPE,
      label: `Prepare the signing package — ${application.applicant_name}`,
      //  SYSTEM-OWNED. This is work Spine owes, not a decision a person
      //  makes. The countersignature is the human decision and it is a
      //  different obligation entirely.
      owner_type: "system", assigned_role: null,
      status: "open", priority: "normal", severity: "normal",
    });
    return { owed: true, obligation_id: ob.id, created: true };
  }

  /*  ════════════════════════════════════════════════════════════════
   *   APPLICATION COMPLETION — THE BOUNDARY THE HANDOFF WAITS ON
   *  ════════════════════════════════════════════════════════════════
   *
   *  SUBMITTING IS NOT COMPLETING. An earlier version owed the handoff in
   *  the submission transaction, which meant a background sweep would turn
   *  every unfinished application into a delivered lease the moment nobody
   *  was watching. A submitted application still missing something owes
   *  APPLICANT FOLLOW-UP WORK, not lease preparation.
   *
   *  ── WHERE "COMPLETE" COMES FROM, AND WHY IT IS NOT A NEW CONCEPT ──
   *  There is NO application-requirements table in this repo, and none is
   *  added here. `documents` is orphaned; `lease_config.application_options`
   *  declares two optional FORM QUESTIONS (parking, utility preference) and
   *  no requirement set. So a per-property document policy is a thing Spine
   *  has not been told, and inventing a fixed list of document names would
   *  be asserting a policy nobody recorded (§5).
   *
   *  What DOES exist is the obligation engine's own `required_inputs` text[]
   *  plus `satisfyObligation`, which removes one input and returns what
   *  REMAINS. Completion here is exactly that array being empty. No second
   *  state machine, no second table, no second vocabulary.
   *
   *  ── AND THE INPUTS ARE OBSERVED, NOT INVENTED ────────────────────
   *  Each input born below is a refusal the CANONICAL PACKET WRITER already
   *  raises, hoisted forward from 3am inside a sweep to the moment of
   *  submission where a person can act on it:
   *
   *    resident_identity   lease_packets.establishPacketSigners →
   *                        `resident_identity_not_established`
   *    guarantor_contact   lease_packets.establishPacketSigners →
   *                        `guarantor_contact_not_established`
   *                        ("Correct the application before generating the
   *                        governing packet.")
   *    applicant_contact   dispatchSigningLinks → `no_contact_for_this_signer`
   *                        — a package that cannot be delivered to the person
   *                        who must sign it is not a finished handoff.
   *
   *  Spine names what it can observe and stays silent about what it was
   *  never told. When a property's document policy gains an owner, its items
   *  append to THIS array through the same engine — the completion boundary
   *  does not move.                                                       */
  const COMPLETION_TYPE = "application_completion";

  //  RULING 2, FIRST CLOCK. An application that is never completed is not
  //  complete forever — it lapses. 30 days from submission, carried as the
  //  obligation's own due_at so the board escalates it like any other
  //  overdue work rather than through a private timer.
  const COMPLETION_WINDOW_DAYS = 30;

  const COMPLETION_INPUTS = Object.freeze({
    RESIDENT_IDENTITY: "resident_identity",
    GUARANTOR_CONTACT: "guarantor_contact",
    APPLICANT_CONTACT: "applicant_contact",
  });

  //  The SAME normalizer establishPacketSigners uses. A second phone rule
  //  here would let an application read complete and still refuse at the
  //  packet — the deriveCategories failure mode, one rule in two places.
  const { normalizeE164 } = require("../identity/phone_identity");

  /*  WHAT IS STILL OUTSTANDING, READ FROM THE APPLICATION ITSELF.
   *  Pure observation against the same facts the packet writer reads. It
   *  asserts nothing about documents Spine was never told to require.     */
  async function observeOutstanding(client, application) {
    const captured = (application && application.captured) || {};
    const out = [];

    if (!application.person_id) out.push(COMPLETION_INPUTS.RESIDENT_IDENTITY);

    let person = null;
    if (application.person_id) {
      person = (await client.query(
        `select id, name, email, phone, primary_phone_e164 from persons where id=$1`,
        [application.person_id])).rows[0] || null;
    }
    const applicantPhone = normalizeE164(
      captured.phone || (person && (person.primary_phone_e164 || person.phone)));
    if (!applicantPhone) out.push(COMPLETION_INPUTS.APPLICANT_CONTACT);

    //  guarantor_required is `!!app.guarantor_name` in lease_packets' terms
    //  read (its applicationTerms builder). Same predicate, same source.
    if (application.guarantor_name) {
      const contact = captured.guarantor_contact || {};
      const name = String(contact.name || application.guarantor_name || "").trim();
      const phone = normalizeE164(contact.phone);
      const email = String(contact.email || "").trim() || null;
      if (!name || !phone || !email) out.push(COMPLETION_INPUTS.GUARANTOR_CONTACT);
    }
    return out;
  }

  /*  ── RECORDED WITH THE SUBMISSION, IN ITS TRANSACTION ──────────────
   *  What is owed at submission is the APPLICANT'S remaining work. If
   *  nothing is outstanding, this obligation is born and closed in the same
   *  transaction and the handoff becomes owed immediately — which is the
   *  two-step leasing design (migration 195), not a shortcut: an applicant
   *  who acknowledged an authored offer and left nothing outstanding has
   *  completed, and the package follows.
   *
   *  Guarded, not dedupe-keyed, for the reason recordHandoffOwed documents. */
  async function recordCompletionOwed(client, { application, source_event_id = null }) {
    if (!application || !application.id) throw new Error("recordCompletionOwed requires the application row");

    const existing = (await client.query(
      `select id, status, required_inputs from obligations
        where related_type = 'lease_application' and related_id = $1 and type = $2
        order by created_at desc limit 1`,
      [application.id, COMPLETION_TYPE]
    )).rows[0];
    if (existing) {
      return { obligation_id: existing.id, created: false,
        required_inputs: existing.required_inputs || [],
        complete: existing.status === "complete",
        handoff: null };
    }

    const outstanding = await observeOutstanding(client, application);
    const submittedAt = application.submitted_at ? new Date(application.submitted_at) : new Date();
    const dueAt = new Date(submittedAt.getTime() + COMPLETION_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

    const ob = await spawnObligationFromEvent(client, {
      property_id: application.property_id,
      person_id: application.person_id,
      unit_id: application.unit_id,
      source_event_id,
      related_id: application.id, related_type: "lease_application",
      module: "applications", type: COMPLETION_TYPE,
      label: `Complete the application — ${application.applicant_name}`,
      //  A PERSON chases an applicant. This is not system work: Spine cannot
      //  supply a missing mobile number or resolve a contested identity.
      owner_type: "human", assigned_role: "leasing_agent",
      escalates_to_role: "leasing_manager",
      status: "open", priority: "normal", severity: "normal",
      due_at: dueAt,
      required_inputs: outstanding,
    });

    //  Nothing outstanding → complete now, in this transaction, and owe the
    //  handoff. completeObligation itself refuses a non-empty array, so this
    //  cannot close over outstanding work even if the check above drifted.
    let handoff = null;
    let approval = null;
    if (outstanding.length === 0) {
      await completeObligation(client, { obligation_id: ob.id });
      handoff = await recordHandoffOwed(client, { application, source_event_id });
      //  Completion makes TWO things live at once, not one after the other:
      //  the package Spine owes, and the decision the approver owes. The
      //  two-step design (195) is exactly this — packet-eligible without
      //  approval — so they run in parallel and neither waits on the other.
      approval = await raiseApprovalDecision(client, { application });
    }
    return { obligation_id: ob.id, created: true, required_inputs: outstanding,
      complete: outstanding.length === 0, due_at: dueAt, handoff, approval };
  }

  /*  ── ONE REQUIREMENT SATISFIED — AND THE HANDOFF AT THE LAST ONE ───
   *  THE ONLY PLACE THE HANDOFF BECOMES OWED after submission. It runs the
   *  engine's own satisfyObligation and reads the `remaining` it returns;
   *  it does not recompute completeness, and it does not decide what
   *  "complete" means. Empty remaining IS complete.
   *
   *  Both writes are in the caller's transaction: an application cannot be
   *  recorded complete without the handoff being owed, and cannot owe a
   *  handoff without being recorded complete.                             */
  async function completeApplicationRequirement(client, {
    application_id, input, proof = null, completed_by = null,
  }) {
    if (!application_id) throw new Error("completeApplicationRequirement requires application_id");
    if (!input) throw new Error("completeApplicationRequirement requires which input this satisfies");
    if (typeof satisfyObligation !== "function") {
      throw new Error("lease_handoff requires the obligation engine's satisfyObligation");
    }

    const ob = (await client.query(
      `select id from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = $2 and status <> 'complete'
        order by created_at asc limit 1`,
      [application_id, COMPLETION_TYPE]
    )).rows[0];
    if (!ob) {
      const err = new Error("This application has no open completion work.");
      err.code = "no_open_application_completion"; err.httpStatus = 409;
      err.publicMessage = err.message;
      throw err;
    }

    const satisfied = await satisfyObligation(client, {
      obligation_id: ob.id, input, proof });

    if (satisfied.remaining.length > 0) {
      return { obligation_id: ob.id, satisfied_input: input,
        remaining: satisfied.remaining, complete: false, handoff: null };
    }

    //  The application row is re-read under the same transaction rather than
    //  trusted from a caller's copy — the handoff obligation is stamped with
    //  its property, person and unit, and a stale copy would misfile it.
    const application = (await client.query(
      `select * from lease_applications where id=$1 for update`, [application_id])).rows[0];
    if (!application) {
      const err = new Error("That application no longer exists.");
      err.code = "application_not_found"; err.httpStatus = 404;
      throw err;
    }

    await completeObligation(client, { obligation_id: ob.id, completed_by });
    const handoff = await recordHandoffOwed(client, {
      application, source_event_id: null });
    const approval = await raiseApprovalDecision(client, { application });

    return { obligation_id: ob.id, satisfied_input: input, remaining: [],
      complete: true, handoff, approval };
  }

  /*  ── OBSERVED INPUTS CLOSE THEMSELVES, FROM THE FACT ───────────────
   *  There is deliberately NO "mark this application complete" button for
   *  the three observed inputs. A button would let someone assert a mobile
   *  number exists without one existing — the confident wrong §5 forbids,
   *  with a bearer link on the end of it.
   *
   *  Instead the FACT closes the input. When a correction supplies the
   *  missing phone, resolves the applicant's identity or completes the
   *  guarantor's contact, this re-observes the application and satisfies
   *  every input that is genuinely no longer outstanding — through the
   *  engine, one at a time, so each closure leaves its own
   *  `input_satisfied:` event. Nothing is satisfied that observation still
   *  finds missing.
   *
   *  Inputs Spine CANNOT observe — a document policy a property declares
   *  later — are untouched here and close through
   *  completeApplicationRequirement, where a person states the fact and is
   *  recorded as having stated it.
   *
   *  Safe to call from any writer that might have resolved one, and safe to
   *  call when it resolved nothing: no open completion work is a no-op, not
   *  a refusal.                                                           */
  async function reconcileApplicationCompletion(client, { application_id, completed_by = null }) {
    if (!application_id) throw new Error("reconcileApplicationCompletion requires application_id");

    const ob = (await client.query(
      `select id, required_inputs from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = $2 and status <> 'complete'
        order by created_at asc limit 1`,
      [application_id, COMPLETION_TYPE])).rows[0];
    if (!ob) return { reconciled: false, reason: "no_open_application_completion" };

    const application = (await client.query(
      `select * from lease_applications where id=$1 for update`, [application_id])).rows[0];
    if (!application) return { reconciled: false, reason: "application_not_found" };

    const stillOutstanding = await observeOutstanding(client, application);
    const observable = new Set(Object.values(COMPLETION_INPUTS));
    const nowSatisfied = (ob.required_inputs || []).filter(
      (i) => observable.has(i) && !stillOutstanding.includes(i));
    if (!nowSatisfied.length) {
      return { reconciled: false, reason: "nothing_resolved",
        remaining: ob.required_inputs || [] };
    }

    let last = null;
    for (const input of nowSatisfied) {
      last = await completeApplicationRequirement(client, {
        application_id, input, completed_by,
        proof: "observed on the application record" });
    }
    return { reconciled: true, satisfied: nowSatisfied,
      remaining: last ? last.remaining : [],
      complete: !!(last && last.complete),
      handoff: last ? last.handoff : null };
  }

  /*  ── THE COMPACT STANDING POSITION (§40.6) ─────────────────────────
   *  Current position · what is unknown · what happens next — cheap enough
   *  for a cross-domain read to gather routinely. No entitled reference is
   *  minted here; the caller owns disclosure.                             */
  async function readApplicationHandoffStanding(client, application_id) {
    const q = client || pool;
    const rows = (await q.query(
      `select type, status, required_inputs, due_at, completed_at
         from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = any($2::text[])
        order by created_at asc`,
      [application_id, [COMPLETION_TYPE, HANDOFF_TYPE, APPROVAL_TYPE, SIGNING_TYPE]])).rows;

    const completion = rows.filter((r) => r.type === COMPLETION_TYPE).pop() || null;
    const handoff = rows.filter((r) => r.type === HANDOFF_TYPE).pop() || null;
    const approvalRow = rows.filter((r) => r.type === APPROVAL_TYPE).pop() || null;
    const signingRow = rows.filter((r) => r.type === SIGNING_TYPE).pop() || null;

    /*  The two things beside the package, carried on every answer rather
     *  than reachable only by a second question. An approver asking "where
     *  is this?" needs the decision and the signature in the same sentence
     *  as the package (§40.6).
     *
     *  `approver_notified` is false wherever a decision is live, and it is
     *  stated rather than omitted: Spine cannot proactively text staff
     *  (migration 132), and a standing read that simply did not mention it
     *  would read as though someone had been told.                       */
    const decision = approvalRow ? {
      state: approvalRow.status === "complete" ? "decided" : "awaiting_decision",
      due_at: approvalRow.due_at || null,
      approver_notified: approvalRow.status === "complete" ? null : false,
      notification_blocked_by: approvalRow.status === "complete"
        ? null : "proactive_staff_messaging_unexpressable",
    } : { state: "NOT_ESTABLISHED", due_at: null,
          approver_notified: null, notification_blocked_by: null };

    const signature = signingRow ? {
      state: signingRow.status === "complete" ? "fully_signed" : "awaiting_signature",
      outstanding_signers: signingRow.status === "complete" ? [] : (signingRow.required_inputs || []),
      due_at: signingRow.due_at || null,
    } : { state: "NOT_ESTABLISHED", outstanding_signers: null, due_at: null };

    if (!completion) {
      //  NOT_ESTABLISHED, and said so. An application with no completion
      //  obligation predates this boundary; that is a fact about Spine's
      //  record, never an assertion that the application is complete.
      return { position: "NOT_ESTABLISHED", outstanding: null,
        completion_due_at: null, handoff_owed: null, decision, signature,
        note: "No completion record exists for this application." };
    }
    const outstanding = completion.required_inputs || [];
    if (completion.status !== "complete") {
      return { position: "awaiting_applicant", outstanding,
        completion_due_at: completion.due_at || null, handoff_owed: false,
        decision, signature,
        next: outstanding.length
          ? `Outstanding: ${outstanding.join(", ")}`
          : "Nothing outstanding — awaiting closure." };
    }
    if (!handoff) {
      return { position: "complete", outstanding: [],
        completion_due_at: completion.due_at || null, handoff_owed: false,
        decision, signature,
        next: "Application complete; no signing package is owed." };
    }
    return {
      position: handoff.status === "complete" ? "package_sent" : "package_owed",
      outstanding: [], completion_due_at: completion.due_at || null,
      handoff_owed: handoff.status !== "complete",
      decision, signature,
      next: handoff.status === "complete"
        ? "Signing package accepted by the transport; awaiting signature."
        : "Signing package owed.",
    };
  }


  /*  ── DISPATCH: EACH SIGNER'S OWN LINK, TO THEIR OWN NUMBER ────────
   *
   *  ⚠ THREE DEFECTS THIS REPLACES, ALL IN ONE EARLIER VERSION.
   *
   *  1. IT COULD SEND ONE PERSON'S BEARER LINK TO ANOTHER PERSON. It took
   *     `link.tenant_url`, then separately took the first signer row that
   *     happened to have a phone, ordered tenant-first. A tenant with no
   *     number and a guarantor with one paired the TENANT'S signing link
   *     with the GUARANTOR'S phone. A signing link is bearer access to a
   *     governing agreement; whoever opens it can sign as that signer.
   *     Links and destinations are now resolved together, per signer, by
   *     role, and a missing number is an explicit outstanding item for
   *     THAT signer — never a reason to use someone else's.
   *
   *  2. THE RECEIPT LANDED NOWHERE. It inserted a row into `events` and
   *     passed that id as `eventId`, but sendPropertySms records its
   *     outcome with `update comm_events set sms_status...` and reads
   *     `select sms_sid, sms_status from comm_events` for its already-sent
   *     guard. With an `events` id both statements touch zero rows: no
   *     delivery receipt, and no retry identity either. It now uses the
   *     canonical outbound pattern — insert the comm_events row FIRST
   *     ("the message is real whether or not the wire cooperates"), then
   *     send against that id.
   *
   *  3. THE SIGNING URL WENT INTO A GENERAL ACTIVITY NOTE. Bearer access
   *     material belongs in the message record that carries it, not in
   *     `events`, which is read all over the product. No `events` row is
   *     written here at all.
   *
   *  Called AFTER the packet transaction commits — see the runner.      */
  async function dispatchSigningLinks({ application_id, property_id, packetId, link }) {
    const links = Array.isArray(link && link.signing_links) ? link.signing_links : [];
    if (!links.length) {
      return { accepted: false, per_signer: [],
        reason: link && link.already_issued ? "link_not_recoverable_after_issue" : "no_signing_url" };
    }
    if (!commBoundary || typeof commBoundary.sendPropertySms !== "function") {
      return { accepted: false, per_signer: [], reason: "no_communication_boundary" };
    }
    const app = (await pool.query(
      `select person_id from lease_applications where id=$1`, [application_id])).rows[0] || {};

    const per_signer = [];
    for (const l of links) {
      //  Joined on the SIGNER ROLE this link was minted for. The role is
      //  unique per packet, so this cannot drift onto another signer.
      const signer = (await pool.query(
        `select id, person_id, phone_e164, display_name from lease_packet_signers
          where lease_packet_id=$1 and signer_role=$2 limit 1`,
        [packetId, l.signer_role])).rows[0];
      if (!signer) {
        per_signer.push({ signer_role: l.signer_role, accepted: false,
          transport_state: "signer_row_missing", reason: "signer_row_missing" });
        continue;
      }
      if (!signer.phone_e164) {
        /*  EXPLICIT OUTSTANDING ITEM FOR THIS SIGNER, not a substitution —
         *  and INDEPENDENT of every other signer. A tenant who is reachable
         *  is dispatched even when the guarantor is not; the guarantor's
         *  own line records why nothing went to them. Neither signer's
         *  state is inferred from the other's.                            */
        per_signer.push({ signer_role: l.signer_role, accepted: false,
          transport_state: "unreachable",
          reason: "no_contact_for_this_signer", display_name: signer.display_name });
        continue;
      }
      //  SAVE FIRST — the canonical outbound pattern. This row is both the
      //  delivery receipt target and the stable retry identity.
      const commId = (await pool.query(
        `insert into comm_events (property_id, person_id, channel, direction, body, occurred_at, sender_role)
         values ($1,$2,'sms','outbound',$3, now(), 'ai') returning id`,
        [property_id, signer.person_id || app.person_id || null,
         `Your lease is ready to sign: ${l.url}`])).rows[0].id;
      let out = null;
      try {
        out = await commBoundary.sendPropertySms({
          property_id, recipient: signer.phone_e164,
          body: `Your lease is ready to sign: ${l.url}`,
          purpose: "lease_signing", person_id: signer.person_id || app.person_id || null,
          eventId: commId,
        });
      } catch (e) { out = { sent: false, reason: (e && e.message) || "send_threw" }; }
      /*  ⚠ ACCEPTED, NOT DELIVERED. sendPropertySms returns `sent: true`
       *  when the TRANSPORT took the message — Twilio's queued/accepted.
       *  A provider SID is not proof the applicant received anything, and
       *  calling it delivery would be a confident wrong (§5). The ladder,
       *  and where each rung actually lives:
       *
       *    issued     lease_packet_signers.token_hash exists (migration 192)
       *    accepted   comm_events.sms_sid / sms_status — THIS function
       *    delivered  comm_events.provider_status, stamped by the carrier
       *               callback through recordProviderStatus
       *    opened     a signer resolved access to the packet
       *    signed     lease_packet_signers.submitted_at
       *
       *  This module owns exactly one of them. It does not collapse the
       *  other four into it, and it never reports a later rung it has not
       *  personally observed.                                            */
      per_signer.push({ signer_role: l.signer_role, comm_event_id: commId,
        accepted: !!(out && out.sent),
        transport_state: out && out.sent ? "accepted" : "refused",
        reason: out && out.sent ? null : ((out && out.reason) || "send_refused"),
        to: String(signer.phone_e164).replace(/.(?=.{4})/g, "\u2022") });
    }
    //  Every required signer must be reachable. One accepted link out of
    //  two is an unfinished handoff, not a partial success — but the two
    //  are recorded independently above, so the reason names WHICH signer.
    const accepted = per_signer.length > 0 && per_signer.every((r) => r.accepted);
    return { accepted, per_signer,
      reason: accepted ? null : (per_signer.find((r) => !r.accepted) || {}).reason || "dispatch_failed" };
  }

  /*  ── DISCHARGED AFTER COMMIT, AND SAFE TO RE-RUN FOREVER ───────────
   *  Reads the owed work from the database rather than from a callback, so
   *  a process that died between submission and execution loses nothing —
   *  the next run finds the same rows.
   *
   *  One transaction PER obligation. A refusal on one application must not
   *  roll back a packet legitimately created for another.               */
  async function runOwedHandoffs({
    property_id = null, application_id = null, limit = 25,
    property_ids = null, include_imported = false,
  } = {}) {
    const svc = leasePackets;
    if (!svc || typeof svc.generateLeasePacket !== "function") {
      throw new Error("lease_handoff requires the lease packets service");
    }

    /*  ── WHAT THIS SWEEP IS ALLOWED TO REACH ───────────────────────────
     *  A sweep with no scope is a sweep over every property Spine has ever
     *  held, including the historical applications an import carried in.
     *  Those were never live pipelines; texting their applicants a signing
     *  link years later is not recovery, it is a mistake with a bearer
     *  token attached.
     *
     *    property_ids       an EXPLICIT allowlist. The unattended sweep
     *                       passes one or does nothing (see startHandoffRecovery).
     *    include_imported   off. `source = 'import'` records an application
     *                       that ALREADY HAPPENED elsewhere; Spine did not
     *                       run it and does not now finish it.
     *
     *  A direct call naming one application_id is a person asking for this
     *  application, and is scoped by that id rather than by the allowlist. */
    const scoped = Array.isArray(property_ids) && property_ids.length
      ? property_ids.map(String) : null;

    const owed = (await pool.query(
      `select o.id, o.related_id as application_id, o.property_id
         from obligations o
         join lease_applications la on la.id = o.related_id
        where o.type = $1 and o.status <> 'complete'
          and o.related_type = 'lease_application'
          and ($2::uuid is null or o.property_id = $2::uuid)
          and ($3::uuid is null or o.related_id = $3::uuid)
          and ($5::uuid[] is null or o.property_id = any($5::uuid[]))
          and ($6::boolean or coalesce(la.source,'') <> 'import')
        order by o.created_at asc
        limit $4`,
      [HANDOFF_TYPE, property_id, application_id, limit, scoped, !!include_imported]
    )).rows;

    const results = [];
    for (const row of owed) {
      const client = await pool.connect();
      let committed = null;
      try {
        await client.query("begin");

        /*  ── CLAIM THE WORK, OR LEAVE IT TO WHOEVER HOLDS IT ───────────
         *  Two workers sweeping at once both read the same owed row. Without
         *  a claim they both generate a packet version, both supersede the
         *  other's, and the applicant gets two bearer links to two different
         *  agreements. `skip locked` means the second worker walks past the
         *  row instead of queuing behind it — this is a sweep, and blocking
         *  on a peer's transaction only converts a race into a stall.
         *
         *  The lock is held for the whole packet transaction below, so the
         *  claim covers exactly the work it protects and is released by the
         *  same commit.                                                    */
        const claim = (await client.query(
          `select id, status from obligations
            where id = $1 and status <> 'complete'
            for update skip locked`, [row.id])).rows[0];
        if (!claim) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "claimed_elsewhere" });
          continue;
        }

        /*  ⚠ COMPLETION IS THE BOUNDARY, AND IT IS CHECKED HERE TOO.
         *  recordCompletionOwed is the only writer that owes a handoff, so
         *  an open completion obligation should be impossible beside an owed
         *  handoff. This asserts it anyway: an unattended sweep preparing a
         *  lease for an application that is still missing something is the
         *  exact failure this whole boundary exists to prevent, and a guard
         *  that only lives in the writer is one edit from being gone.     */
        const incomplete = (await client.query(
          `select id, required_inputs from obligations
            where related_type = 'lease_application' and related_id = $1
              and type = $2 and status <> 'complete'
            limit 1`,
          [row.application_id, COMPLETION_TYPE])).rows[0];
        if (incomplete) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "deferred", reason_code: "application_completion_outstanding",
            outstanding: incomplete.required_inputs || [] });
          continue;
        }
        /*  ── RESUME BEFORE REGENERATING ────────────────────────────
         *  An existing package is a reason to RECOVER access to it, not a
         *  permanent stop. Only when there is no current package does this
         *  prepare one. Regenerating to obtain another link would create a
         *  different agreement to solve a delivery problem.            */
        const current = (await client.query(
          `select id, status from lease_packets
            where application_id=$1 and superseded_at is null
            order by version desc limit 1`, [row.application_id])).rows[0];

        let packetId = null;
        let link = null;
        if (current && ["sent", "in_progress", "tenant_in_progress"].includes(current.status)) {
          /*  ── RECOVERY IS A NEW VERSION, BECAUSE ACCESS IS FROZEN ────
           *  This obligation being open is the durable evidence that the
           *  package was never delivered. Access to it cannot be reissued:
           *  migration 192's signer guard freezes token_hash, expiry and
           *  link_issued_at once a packet leaves `draft`, and raw tokens are
           *  stored only as a hash — so an undelivered link is unrecoverable
           *  BY DESIGN, and that rule is not worked around.
           *
           *  The existing mechanism for this is a new VERSION of the SAME
           *  agreement: same application, same acknowledged offer, same
           *  terms. generateLeasePacket stamps `superseded_at` on the prior
           *  version, which resolveSignerAccess already refuses — so the
           *  obsolete access is invalidated at the same moment, and the
           *  prior version is preserved as evidence rather than deleted.  */
          const regen = await svc.generateLeasePacket(client, {
            applicationId: row.application_id,
            expectedPropertyId: row.property_id,
            createNewVersion: true,
            automatedPreparation: true,
          });
          packetId = regen && (regen.packet_id || (regen.packet && regen.packet.id));
          link = await svc.issueLeasePacketLink(client, {
            packetId, expectedPropertyId: row.property_id });
        } else {
          //  generateLeasePacket locks the application and runs the one
          //  eligibility predicate, reading the authored offer fresh. If the
          //  agreement moved since submission, this is where it refuses.
          const gen = await svc.generateLeasePacket(client, {
            applicationId: row.application_id,
            expectedPropertyId: row.property_id,
            //  Spine is the executor; the offer's author remains the
            //  commercial authority the record rests on. No staff session is
            //  minted and none is implied — see deriveConfirmationFromAuthoredOffer.
            automatedPreparation: true,
          });
          packetId = gen && (gen.packet_id || (gen.packet && gen.packet.id));
          link = await svc.issueLeasePacketLink(client, {
            packetId, expectedPropertyId: row.property_id });
        }
        /*  ⚠ COMMIT THE PACKAGE AND ITS ACCESS BEFORE ANY EXTERNAL SEND.
         *  An earlier version dispatched the SMS while this transaction was
         *  still open. A successful send followed by a rollback would leave
         *  the applicant holding a link to a packet that never existed —
         *  unusable bearer access, and no record of why. The durable work
         *  is committed first; dispatch happens below, outside it, and the
         *  obligation stays OPEN until the link has actually gone.      */
        await client.query("commit");
        committed = { packetId, link };
      } catch (e) {
        await client.query("rollback").catch(() => {});
        const code = (e && (e.code || e.reason_code)) || null;
        if (NEVER.includes(code)) {
          //  Closed deliberately, with the reason, rather than left open.
          try {
            const c2 = await pool.connect();
            try {
              await c2.query("begin");
              await completeObligation(c2, { obligation_id: row.id });
              await c2.query("commit");
            } finally { c2.release(); }
          } catch (_) { /* leaving it open is the safe failure */ }
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "not_owed", reason_code: code });
        } else {
          //  STILL OWED. The obligation stays open and the application is
          //  untouched — recoverable work, not a lost step.
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: NOT_YET.includes(code) ? "deferred" : "failed",
            reason_code: code, message: (e && e.message) || null });
        }
      } finally {
        client.release();
      }

      /*  ── DISPATCH, OUTSIDE THE TRANSACTION ─────────────────────────
       *  The package and its access are durable by now. Delivery is the
       *  finish line, so the obligation is completed only once every
       *  required signer has actually been reached.                    */
      if (committed) {
        const delivery = await dispatchSigningLinks({
          application_id: row.application_id, property_id: row.property_id,
          packetId: committed.packetId, link: committed.link });
        if (!delivery.accepted) {
          /*  ⚠ A TECHNICAL DISPATCH FAILURE IS A SYSTEM FAILURE, NOT
           *  APPLICANT INACTION, and is reported as one. The work stays
           *  owed; the packet is not discarded.                        */
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "not_accepted", packet_id: committed.packetId,
            failure_class: "system", reason_code: delivery.reason,
            per_signer: delivery.per_signer });
          continue;
        }
        const c3 = await pool.connect();
        try {
          await c3.query("begin");
          //  completeObligation takes { obligation_id, completed_by } and
          //  nothing else; a parameter it never reads would read as a
          //  record that was never written.
          await completeObligation(c3, { obligation_id: row.id });
          /*  ── THE 60-DAY SIGNING CLOCK STARTS HERE, AND ONLY HERE ─────
           *  Not at completion and not at packet generation: the window in
           *  which a lease must be signed cannot start before the link is
           *  on its way to the people who must sign it. Same transaction as
           *  the handoff's closure, so a package can never be dispatched
           *  without its clock or carry a clock it was never sent under.  */
          const appRow = (await c3.query(
            `select * from lease_applications where id=$1`, [row.application_id])).rows[0];
          if (appRow) await recordSigningOwed(c3, { application: appRow });
          await c3.query("commit");
        } catch (e) {
          await c3.query("rollback").catch(() => {});
          //  Delivered but not closed out: still owed, and the already-sent
          //  guard on each comm_events row stops a duplicate message.
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "accepted_not_closed", packet_id: committed.packetId,
            per_signer: delivery.per_signer, reason_code: (e && e.message) || "complete_failed" });
          continue;
        } finally { c3.release(); }
        /*  The HANDOFF is finished: every signer's link is on the wire. What
         *  happens next — carrier delivery, the signer opening it, signing —
         *  is the SIGNATURE follow-through, which already has an owner
         *  (lease_signature_followup). This obligation does not stay open
         *  waiting for a person to act; it closes when Spine has done the
         *  thing Spine owed.                                              */
        results.push({ application_id: row.application_id, obligation_id: row.id,
          outcome: "accepted", packet_id: committed.packetId,
          per_signer: delivery.per_signer,
          already_issued: !!(committed.link && committed.link.already_issued) });
      }
    }
    return { considered: owed.length, results };
  }


  /*  ════════════════════════════════════════════════════════════════
   *   RULING 3 · THE APPROVER'S DECISION BECOMES LIVE AT COMPLETION
   *  ════════════════════════════════════════════════════════════════
   *
   *  The `application_approval` gate (leasing_manager) is spawned by
   *  application_submission at SUBMIT, with the rail's 48-hour window. That
   *  is the right place for it to be BORN and the wrong moment for its
   *  clock: at submission the application may still be missing things, and a
   *  decision window that starts running against work the applicant has not
   *  finished expires on the applicant's delay rather than the approver's.
   *
   *  So the gate is RAISED, not re-created — there is exactly one decision
   *  obligation and this does not make a second. Raising means: the clock
   *  restarts from the moment the application actually became decidable, the
   *  priority says it is now live, and the engine's own escalation interval
   *  is set so it climbs to the escalation role on its own.
   *
   *  ⚠ WHAT IS *NOT* HERE, AND WHY — THE OUTBOUND TEXT TO THE APPROVER.
   *  Migration 132 permits an `operations` line only `disabled` or
   *  `reply_only` (`ck_cl_outbound_policy_by_type`), and says so in its own
   *  words: *"assignment pushes, reminder campaigns and staff broadcasts are
   *  not features that were left unbuilt — they are rows that cannot
   *  exist."* Spine CANNOT proactively text a staff member today, by
   *  construction, and the two credential purposes that can reach a phone
   *  (`staff_otp`, `staff_invite`) are named credential transport — routing
   *  a decision summary through one would be exactly the informal exception
   *  that list exists to refuse.
   *
   *  That wall is deliberate and it is not worked around here. Proactive
   *  staff messaging needs its own consent rail and a line policy that can
   *  express it — a doctrine decision with a migration behind it, not
   *  something this module may take by widening a purpose.
   *
   *  What it leaves: the decision is owed, dated, prioritised, escalating
   *  and READABLE the moment it is live. An approver who looks sees it at
   *  the top. An approver who does not look is not yet reachable, and this
   *  file does not pretend otherwise (§5).                                */
  const APPROVAL_TYPE = "application_approval";
  const APPROVAL_WINDOW_HOURS = 48;
  const APPROVAL_ESCALATION_MINUTES = 240;

  async function raiseApprovalDecision(client, { application, completed_at = null } = {}) {
    if (!application || !application.id) throw new Error("raiseApprovalDecision requires the application row");

    const gate = (await client.query(
      `select id, status, due_at, priority from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = $2 and status <> 'complete'
        order by created_at asc limit 1`,
      [application.id, APPROVAL_TYPE])).rows[0];
    //  No open gate is not an error. A two-step application may already have
    //  been decided, and an imported one never had a gate at all.
    if (!gate) return { raised: false, reason: "no_open_approval_gate" };

    const from = completed_at ? new Date(completed_at) : new Date();
    const due = new Date(from.getTime() + APPROVAL_WINDOW_HOURS * 3600 * 1000).toISOString();
    const raised = (await client.query(
      `update obligations
          set due_at = $2, priority = 'high',
              escalation_interval_minutes = coalesce(escalation_interval_minutes, $3),
              updated_at = now()
        where id = $1 returning id, due_at, priority, escalates_to_role`,
      [gate.id, due, APPROVAL_ESCALATION_MINUTES])).rows[0];

    //  The durable statement that the decision became live, and when. An
    //  approver asking "how long has this been waiting on me?" is answered
    //  from this, not from the submission timestamp.
    await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,'application_decision_became_live',$4)`,
      [application.property_id, application.person_id, application.unit_id,
       `Application complete — the leasing decision for ${application.applicant_name} is live`
       + ` and due ${String(due).slice(0, 10)}.`]);

    return { raised: true, obligation_id: raised.id, due_at: raised.due_at,
      priority: raised.priority, escalates_to_role: raised.escalates_to_role,
      //  Said out loud in the receipt rather than left to be discovered:
      //  nothing has been sent to this person.
      approver_notified: false, notification_blocked_by: "proactive_staff_messaging_unexpressable" };
  }

  /*  ════════════════════════════════════════════════════════════════
   *   RULING 4 · THE 60-DAY LEASE-SIGNING CLOCK
   *  ════════════════════════════════════════════════════════════════
   *
   *  The same machinery as the 30-day completion clock, deliberately — a
   *  second clock implemented a second way is two rules to keep in step.
   *  An obligation carrying the OUTSTANDING SIGNER ROLES as the engine's own
   *  required_inputs, due 60 days from the moment the package went out, and
   *  lapsing the application through the one lifecycle writer if it never
   *  gets signed.
   *
   *  ⚠ THIS IS NOT THE LINK'S EXPIRY. `lease_packet_signers.token_expires_at`
   *  is 14 days and is a BEARER-TOKEN security window: how long one secret
   *  URL may be redeemed. This is the DEAL window: how long the agreement
   *  stands before it lapses. Collapsing them would either give a signing
   *  link a 60-day life or expire a live deal in a fortnight.
   *
   *  TENANT AND GUARANTOR ARE INDEPENDENT INPUTS — `signature:tenant` and
   *  `signature:guarantor` — so a half-signed package reads as exactly that,
   *  and the outstanding list names WHO has not signed.                   */
  const SIGNING_TYPE = "lease_signing";
  const SIGNING_WINDOW_DAYS = 60;
  const signatureInput = (role) => `signature:${role}`;

  /*  Read from lease_packet_signers on the CURRENT packet — the same rows
   *  the public signer route stamps. The fact closes the input, exactly as
   *  it does for application completion.                                  */
  async function observeOutstandingSignatures(client, application_id) {
    const rows = (await client.query(
      `select s.signer_role, s.submitted_at
         from lease_packet_signers s
         join lease_packets p on p.id = s.lease_packet_id
        where p.application_id = $1 and p.superseded_at is null
          and coalesce(p.status,'') <> 'void'
        order by s.signer_role`, [application_id])).rows;
    return rows.filter((r) => !r.submitted_at).map((r) => signatureInput(r.signer_role));
  }

  async function recordSigningOwed(client, { application, source_event_id = null } = {}) {
    if (!application || !application.id) throw new Error("recordSigningOwed requires the application row");

    const existing = (await client.query(
      `select id, status, required_inputs from obligations
        where related_type = 'lease_application' and related_id = $1 and type = $2
        order by created_at desc limit 1`,
      [application.id, SIGNING_TYPE])).rows[0];
    if (existing) {
      return { obligation_id: existing.id, created: false,
        required_inputs: existing.required_inputs || [],
        complete: existing.status === "complete" };
    }

    const outstanding = await observeOutstandingSignatures(client, application.id);
    //  A package with no signer rows is not a signed package — it is a
    //  package whose signers were never established, and owing a signing
    //  clock on it would put a 60-day deadline on work nobody can do.
    if (!outstanding.length) return { obligation_id: null, created: false,
      reason: "no_outstanding_signers" };

    const due = new Date(Date.now() + SIGNING_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
    const ob = await spawnObligationFromEvent(client, {
      property_id: application.property_id,
      person_id: application.person_id,
      unit_id: application.unit_id,
      source_event_id,
      related_id: application.id, related_type: "lease_application",
      module: "applications", type: SIGNING_TYPE,
      label: `Lease signature — ${application.applicant_name}`,
      //  A person chases a signature. Spine sent the link; it cannot sign.
      owner_type: "human", assigned_role: "leasing_agent",
      escalates_to_role: "leasing_manager",
      status: "open", priority: "normal", severity: "normal",
      due_at: due, required_inputs: outstanding,
    });
    return { obligation_id: ob.id, created: true, required_inputs: outstanding,
      complete: false, due_at: due };
  }

  /*  The signatures that HAVE arrived close their own inputs. Same shape as
   *  reconcileApplicationCompletion, same reason: the public signer route
   *  has no business knowing a clock is waiting on it.                    */
  async function reconcileApplicationSignatures(client, { application_id, completed_by = null }) {
    if (!application_id) throw new Error("reconcileApplicationSignatures requires application_id");
    const ob = (await client.query(
      `select id, required_inputs from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = $2 and status <> 'complete'
        order by created_at asc limit 1`,
      [application_id, SIGNING_TYPE])).rows[0];
    if (!ob) return { reconciled: false, reason: "no_open_signing_obligation" };

    const stillOutstanding = await observeOutstandingSignatures(client, application_id);
    const nowSigned = (ob.required_inputs || []).filter((i) => !stillOutstanding.includes(i));
    if (!nowSigned.length) {
      return { reconciled: false, reason: "nothing_signed_yet",
        remaining: ob.required_inputs || [] };
    }
    let remaining = ob.required_inputs || [];
    for (const input of nowSigned) {
      const out = await satisfyObligation(client, { obligation_id: ob.id, input,
        proof: "signature recorded on the current lease package" });
      remaining = out.remaining;
    }
    if (remaining.length === 0) {
      await completeObligation(client, { obligation_id: ob.id, completed_by });
    }
    return { reconciled: true, obligation_id: ob.id, signed: nowSigned,
      remaining, complete: remaining.length === 0 };
  }

  async function reconcileOwedSignatures({ property_ids = null, application_id = null, limit = 50 } = {}) {
    const scoped = Array.isArray(property_ids) && property_ids.length
      ? property_ids.map(String) : null;
    const open = (await pool.query(
      `select o.id, o.related_id as application_id
         from obligations o
         join lease_applications la on la.id = o.related_id
        where o.type = $1 and o.status <> 'complete'
          and o.related_type = 'lease_application'
          and coalesce(cardinality(o.required_inputs), 0) > 0
          and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
          and ($3::uuid is null or o.related_id = $3::uuid)
          and coalesce(la.source,'') <> 'import'
        order by o.created_at asc limit $4`,
      [SIGNING_TYPE, scoped, application_id, limit])).rows;

    const results = [];
    for (const row of open) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const claim = (await client.query(
          `select id from obligations where id=$1 and status <> 'complete'
            for update skip locked`, [row.id])).rows[0];
        if (!claim) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, outcome: "claimed_elsewhere" });
          continue;
        }
        const out = await reconcileApplicationSignatures(client, { application_id: row.application_id });
        await client.query("commit");
        results.push({ application_id: row.application_id,
          outcome: out.reconciled ? (out.complete ? "fully_signed" : "partially_signed") : "unchanged",
          signed: out.signed || [], remaining: out.remaining || null });
      } catch (e) {
        await client.query("rollback").catch(() => {});
        results.push({ application_id: row.application_id, outcome: "failed",
          message: (e && e.message) || null });
      } finally { client.release(); }
    }
    return { considered: open.length, results };
  }

  /*  ── A DEAD APPLICATION OWES NOTHING ──────────────────────────────
   *  Found by walking the whole journey rather than the happy path: the
   *  deny route already releases `lease_signature_followup` for exactly this
   *  reason — *"so the team is not told to chase a signature on a dead
   *  application"* — and it knew nothing about the three obligations this
   *  module adds. A declined applicant would have kept a 60-day signing
   *  clock, an open completion chase and an owed package, all pointed at a
   *  decision that had already been made.
   *
   *  CLOSED AS `revoked`, NEVER AS `satisfied` OR `expired`. Migration 084's
   *  vocabulary already has the word: nothing was supplied and no window
   *  ran out — the work was called off. `completeObligation` is not used,
   *  because it refuses an obligation with outstanding inputs and
   *  outstanding inputs are exactly what a revoked obligation still has.
   *
   *  Runs in the CALLER'S transaction, so an application cannot go terminal
   *  without its work being released in the same commit.                  */
  const RELEASED_ON_TERMINAL = Object.freeze([COMPLETION_TYPE, HANDOFF_TYPE, SIGNING_TYPE]);

  async function releaseOnTerminal(client, { application_id, terminal_code = null } = {}) {
    if (!application_id) throw new Error("releaseOnTerminal requires application_id");
    const open = (await client.query(
      `select id, type from obligations
        where related_type = 'lease_application' and related_id = $1
          and type = any($2::text[]) and status <> 'complete'
        for update`,
      [application_id, RELEASED_ON_TERMINAL])).rows;
    if (!open.length) return { released: [] };

    //  A conversion-linked obligation closes through the conversion rail and
    //  nowhere else. None of these three is ever linked, which is why the
    //  assertion is cheap and worth keeping.
    for (const o of open) {
      const linked = (await client.query(
        `select 1 from leasing_conversion_obligations where obligation_id=$1 limit 1`,
        [o.id])).rows[0];
      if (linked) throw Object.assign(
        new Error("Conversion-linked obligations must resolve through the conversion rail."),
        { code: "CONVERSION_RAIL_REQUIRED", httpStatus: 409 });
    }
    await client.query(
      `update obligations
          set status='complete', resolution_code='revoked',
              completed_at=now(), updated_at=now()
        where id = any($1::uuid[])`,
      [open.map((o) => o.id)]);
    return { released: open.map((o) => ({ obligation_id: o.id, type: o.type })),
      terminal_code: terminal_code || null };
  }

  /*  ── THE FACTS MOVE ON WITHOUT ASKING THIS MODULE ─────────────────
   *  A missing mobile number is supplied by a correction somewhere else in
   *  the product, and that writer has no reason to know a completion
   *  obligation is waiting on it. Requiring every upstream writer to call
   *  reconcileApplicationCompletion would put this module's boundary inside
   *  six other people's code, where it would be forgotten once and then
   *  silently.
   *
   *  So the sweep READS instead. It re-observes every open completion
   *  obligation against the current facts and closes whatever is genuinely
   *  no longer outstanding — capture once, read everywhere (§7), rather
   *  than notify everywhere. An upstream writer MAY still call reconcile
   *  directly to make the handoff immediate; nothing depends on it doing so.
   *
   *  One transaction per application: a refusal on one must not roll back
   *  another's closure.                                                    */
  async function reconcileOwedCompletions({
    property_ids = null, application_id = null, limit = 50,
  } = {}) {
    const scoped = Array.isArray(property_ids) && property_ids.length
      ? property_ids.map(String) : null;

    const open = (await pool.query(
      `select o.id, o.related_id as application_id
         from obligations o
         join lease_applications la on la.id = o.related_id
        where o.type = $1 and o.status <> 'complete'
          and o.related_type = 'lease_application'
          and coalesce(cardinality(o.required_inputs), 0) > 0
          and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
          and ($3::uuid is null or o.related_id = $3::uuid)
          and coalesce(la.source,'') <> 'import'
        order by o.created_at asc
        limit $4`,
      [COMPLETION_TYPE, scoped, application_id, limit])).rows;

    const results = [];
    for (const row of open) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const claim = (await client.query(
          `select id from obligations where id=$1 and status <> 'complete'
            for update skip locked`, [row.id])).rows[0];
        if (!claim) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, outcome: "claimed_elsewhere" });
          continue;
        }
        const out = await reconcileApplicationCompletion(client, {
          application_id: row.application_id });
        await client.query("commit");
        results.push({ application_id: row.application_id,
          outcome: out.reconciled ? (out.complete ? "completed" : "advanced") : "unchanged",
          satisfied: out.satisfied || [], remaining: out.remaining || null });
      } catch (e) {
        await client.query("rollback").catch(() => {});
        results.push({ application_id: row.application_id, outcome: "failed",
          message: (e && e.message) || null });
      } finally { client.release(); }
    }
    return { considered: open.length, results };
  }

  /*  ── THE 30-DAY CLOCK HAS TEETH (RULING 2, FIRST CLOCK) ───────────
   *  A completion obligation nobody satisfied does not stay open forever
   *  pretending an applicant is still coming. At its due_at the application
   *  lapses — THROUGH THE EXISTING LIFECYCLE AUTHORITY, not by a status
   *  write of our own. application_lifecycle.markTerminal is the only
   *  writer of lease_applications.status, it already knows `expired` may be
   *  reached from submitted / approved / lease_ready, and it refuses
   *  anything else. This module supplies the clock, never the transition.
   *
   *  The obligation is closed as `resolution_code = 'expired'` — a value
   *  migration 084 already constrains and leasing_conversion already writes.
   *  completeObligation is deliberately NOT used: it refuses an obligation
   *  with outstanding inputs, and outstanding inputs are precisely what
   *  expired here. Closing it as satisfied would say the applicant supplied
   *  what they never supplied.                                            */
  async function expireStaleClock({
    type, window_days, event_type, what_lapsed,
    property_ids = null, application_id = null, limit = 50, now = null,
  } = {}) {
    const lifecycle = require("./application_lifecycle");
    const scoped = Array.isArray(property_ids) && property_ids.length
      ? property_ids.map(String) : null;
    const asOf = now ? new Date(now).toISOString() : new Date().toISOString();

    const stale = (await pool.query(
      `select o.id, o.related_id as application_id, o.property_id, o.due_at,
              o.required_inputs, la.status as application_status
         from obligations o
         join lease_applications la on la.id = o.related_id
        where o.type = $1 and o.status <> 'complete'
          and o.related_type = 'lease_application'
          and o.due_at is not null and o.due_at < $2::timestamptz
          and ($3::uuid[] is null or o.property_id = any($3::uuid[]))
          and ($4::uuid is null or o.related_id = $4::uuid)
          and coalesce(la.source,'') <> 'import'
        order by o.due_at asc
        limit $5`,
      [type, asOf, scoped, application_id, limit])).rows;

    const results = [];
    for (const row of stale) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const claim = (await client.query(
          `select id from obligations where id=$1 and status <> 'complete'
            for update skip locked`, [row.id])).rows[0];
        if (!claim) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "claimed_elsewhere" });
          continue;
        }
        //  A conversion-linked obligation closes through the conversion rail
        //  and nowhere else. This type is never linked, which is exactly why
        //  the assertion is cheap and worth keeping.
        const linked = (await client.query(
          `select 1 from leasing_conversion_obligations where obligation_id=$1 limit 1`,
          [row.id])).rows[0];
        if (linked) {
          await client.query("rollback");
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "refused", reason_code: "conversion_rail_required" });
          continue;
        }

        let lapsed = null;
        if (!lifecycle.isTerminal(row.application_status)) {
          lapsed = await lifecycle.markTerminal(client, {
            applicationId: row.application_id,
            terminalCode: "expired",
            decisionReason: `${what_lapsed} within ${window_days} days`
              + `${(row.required_inputs || []).length ? " — outstanding: " + row.required_inputs.join(", ") : ""}.`,
          });
        }
        await client.query(
          `update obligations
              set status='complete', resolution_code='expired',
                  completed_at=now(), updated_at=now()
            where id=$1`, [row.id]);
        /*  The clock that ran out closes as `expired`; everything ELSE this
         *  application owed is called off, not expired — a package nobody
         *  asked for again did not run out of time, it stopped being wanted.
         *  Without this a lapsed application kept an owed package and, in
         *  the completion case, a signing clock pointed at a dead deal.  */
        if (lapsed) await releaseOnTerminal(client, {
          application_id: row.application_id, terminal_code: "expired" });
        await client.query(
          `insert into events (property_id, person_id, unit_id, type, note)
           values ($1, (select person_id from lease_applications where id=$2),
                   (select unit_id from lease_applications where id=$2),
                   $4, $3)`,
          [row.property_id, row.application_id,
           `${what_lapsed} — lapsed after ${window_days} days`
           + `${(row.required_inputs || []).length ? " — never supplied: " + row.required_inputs.join(", ") : ""}.`,
           event_type]);
        await client.query("commit");
        results.push({ application_id: row.application_id, obligation_id: row.id,
          outcome: "expired", application_status_changed: !!lapsed,
          never_supplied: row.required_inputs || [] });
      } catch (e) {
        await client.query("rollback").catch(() => {});
        results.push({ application_id: row.application_id, obligation_id: row.id,
          outcome: "failed", reason_code: (e && (e.code || e.reason_code)) || null,
          message: (e && e.message) || null });
      } finally { client.release(); }
    }
    return { considered: stale.length, results };
  }

  //  TWO CLOCKS, ONE RULE. Both are thin wrappers so the expiry behaviour —
  //  lapse through the lifecycle authority, close the obligation `expired`
  //  and never `satisfied`, claim with skip-locked, skip imports — cannot
  //  drift between them.
  const expireStaleCompletions = (opts = {}) => expireStaleClock({
    ...opts, type: COMPLETION_TYPE, window_days: COMPLETION_WINDOW_DAYS,
    event_type: "application_completion_expired",
    what_lapsed: "Application not completed" });

  const expireStaleSignings = (opts = {}) => expireStaleClock({
    ...opts, type: SIGNING_TYPE, window_days: SIGNING_WINDOW_DAYS,
    event_type: "lease_signing_window_expired",
    what_lapsed: "Lease not signed" });

  /*  ── RECOVERY IS NORMAL EXECUTION, NOT A TEST CALLING THE RUNNER ───
   *  The after-commit call accelerates the FIRST attempt. It cannot be the
   *  only path, or work owed when a process died would wait for another
   *  applicant to submit something. This sweeps the owed work on boot and
   *  then periodically, which is what makes "a restart must not lose it"
   *  true rather than merely durable.
   *
   *  ⚠ TWO SWITCHES, AND BOTH ARE OFF.
   *
   *  LEASE_HANDOFF_RECOVERY_ENABLED=true    turns the sweep on at all.
   *  LEASE_HANDOFF_RECOVERY_PROPERTIES=...  the EXPLICIT property allowlist
   *                                         it is allowed to touch.
   *
   *  The allowlist is not a convenience. An unattended sweep with no scope
   *  reaches every property Spine has ever held, and the work it performs
   *  ends in a bearer link to a governing agreement arriving on a real
   *  person's phone. Enabling recovery without naming properties is far more
   *  likely to be an omission than an intention, so it is refused rather
   *  than interpreted as "all" — and the refusal says which variable is
   *  missing. Historical/imported applications are excluded inside the
   *  runner regardless of what the allowlist says.
   *
   *  THESE STAY OFF FOR LIVE PROPERTIES until the inventory hold and
   *  approver follow-through are connected. Preparation working is not a
   *  reason to point automation at real applicants.
   *
   *  The sweep also runs the 30-day completion clock, under the same scope:
   *  a clock that only ticks when someone opens a screen is not a clock.  */
  function startHandoffRecovery({
    intervalMs = 5 * 60 * 1000, enabled = null, propertyIds = null, log = console,
  } = {}) {
    const on = enabled === null
      ? String(process.env.LEASE_HANDOFF_RECOVERY_ENABLED || "").toLowerCase() === "true"
      : !!enabled;
    if (!on) return { started: false, reason: "not_enabled" };

    const scoped = Array.isArray(propertyIds) && propertyIds.length
      ? propertyIds.map(String)
      : String(process.env.LEASE_HANDOFF_RECOVERY_PROPERTIES || "")
          .split(",").map((v) => v.trim()).filter(Boolean);
    if (!scoped.length) {
      log.error("[handoff] recovery is enabled but LEASE_HANDOFF_RECOVERY_PROPERTIES "
        + "names no property — refusing to sweep every property. Work stays owed.");
      return { started: false, reason: "no_property_scope" };
    }

    let running = false;
    const sweep = async () => {
      if (running) return;               // never overlap a sweep with itself
      running = true;
      try {
        //  Reconcile FIRST: an input the facts resolved since the last tick
        //  owes the handoff, and the handoff pass below should see it in the
        //  same sweep rather than five minutes later.
        const fixed = await reconcileOwedCompletions({ limit: 50, property_ids: scoped });
        if (fixed.considered) {
          log.log(`[handoff] re-observed ${fixed.considered} open completion(s); `
            + fixed.results.map((r) => `${r.outcome}`).join(","));
        }
        const out = await runOwedHandoffs({ limit: 50, property_ids: scoped });
        if (out.considered) {
          log.log(`[handoff] swept ${out.considered} owed; `
            + out.results.map((r) => `${r.outcome}`).join(","));
        }
        //  Signatures that arrived since the last tick close their own
        //  inputs, for the same reason completions do: the public signer
        //  route has no business knowing a clock is waiting on it.
        const signed = await reconcileOwedSignatures({ limit: 50, property_ids: scoped });
        if (signed.considered) {
          log.log(`[handoff] re-observed ${signed.considered} open signing clock(s); `
            + signed.results.map((r) => `${r.outcome}`).join(","));
        }
        for (const [label, run] of [
          [`${COMPLETION_WINDOW_DAYS}-day completion`, expireStaleCompletions],
          [`${SIGNING_WINDOW_DAYS}-day signing`, expireStaleSignings],
        ]) {
          const lapsed = await run({ limit: 50, property_ids: scoped });
          if (lapsed.considered) {
            log.log(`[handoff] ${lapsed.considered} application(s) past the ${label} window; `
              + lapsed.results.map((r) => `${r.outcome}`).join(","));
          }
        }
      } catch (e) {
        log.error("[handoff] sweep failed, work remains owed:", (e && e.message) || "unknown");
      } finally { running = false; }
    };
    sweep();                              // on boot: this IS the restart recovery
    const timer = setInterval(sweep, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return { started: true, intervalMs, property_ids: scoped, stop: () => clearInterval(timer) };
  }

  return { HANDOFF_TYPE, COMPLETION_TYPE, COMPLETION_INPUTS, COMPLETION_WINDOW_DAYS,
    NOT_YET, NEVER,
    observeOutstanding, recordCompletionOwed, completeApplicationRequirement,
    reconcileApplicationCompletion, reconcileOwedCompletions,
    readApplicationHandoffStanding,
    APPROVAL_TYPE, SIGNING_TYPE, SIGNING_WINDOW_DAYS, signatureInput,
    raiseApprovalDecision,
    recordSigningOwed, observeOutstandingSignatures,
    reconcileApplicationSignatures, reconcileOwedSignatures,
    releaseOnTerminal, RELEASED_ON_TERMINAL,
    recordHandoffOwed, runOwedHandoffs,
    expireStaleCompletions, expireStaleSignings, startHandoffRecovery };
};
module.exports.HANDOFF_TYPE = HANDOFF_TYPE;
