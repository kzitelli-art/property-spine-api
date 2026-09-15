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
  const { pool, spawnObligationFromEvent, completeObligation, leasePackets, commBoundary = null } = deps;
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
      return { delivered: false, per_signer: [],
        reason: link && link.already_issued ? "link_not_recoverable_after_issue" : "no_signing_url" };
    }
    if (!commBoundary || typeof commBoundary.sendPropertySms !== "function") {
      return { delivered: false, per_signer: [], reason: "no_communication_boundary" };
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
        per_signer.push({ signer_role: l.signer_role, delivered: false, reason: "signer_row_missing" });
        continue;
      }
      if (!signer.phone_e164) {
        //  EXPLICIT OUTSTANDING ITEM, not a substitution.
        per_signer.push({ signer_role: l.signer_role, delivered: false,
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
      per_signer.push({ signer_role: l.signer_role, comm_event_id: commId,
        delivered: !!(out && out.sent), reason: out && out.sent ? null : ((out && out.reason) || "send_refused"),
        to: String(signer.phone_e164).replace(/.(?=.{4})/g, "\u2022") });
    }
    //  Every required signer must be reachable. One delivered link out of
    //  two is an unfinished handoff, not a partial success.
    const delivered = per_signer.length > 0 && per_signer.every((r) => r.delivered);
    return { delivered, per_signer,
      reason: delivered ? null : (per_signer.find((r) => !r.delivered) || {}).reason || "delivery_failed" };
  }

  /*  ── DISCHARGED AFTER COMMIT, AND SAFE TO RE-RUN FOREVER ───────────
   *  Reads the owed work from the database rather than from a callback, so
   *  a process that died between submission and execution loses nothing —
   *  the next run finds the same rows.
   *
   *  One transaction PER obligation. A refusal on one application must not
   *  roll back a packet legitimately created for another.               */
  async function runOwedHandoffs({ property_id = null, application_id = null, limit = 25 } = {}) {
    const svc = leasePackets;
    if (!svc || typeof svc.generateLeasePacket !== "function") {
      throw new Error("lease_handoff requires the lease packets service");
    }

    const owed = (await pool.query(
      `select o.id, o.related_id as application_id, o.property_id
         from obligations o
        where o.type = $1 and o.status <> 'complete'
          and o.related_type = 'lease_application'
          and ($2::uuid is null or o.property_id = $2::uuid)
          and ($3::uuid is null or o.related_id = $3::uuid)
        order by o.created_at asc
        limit $4`,
      [HANDOFF_TYPE, property_id, application_id, limit]
    )).rows;

    const results = [];
    for (const row of owed) {
      const client = await pool.connect();
      let committed = null;
      try {
        await client.query("begin");
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
        if (!delivery.delivered) {
          /*  ⚠ A TECHNICAL DELIVERY FAILURE IS A SYSTEM FAILURE, NOT
           *  APPLICANT INACTION, and is reported as one. The work stays
           *  owed; the packet is not discarded.                        */
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "undelivered", packet_id: committed.packetId,
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
          await c3.query("commit");
        } catch (e) {
          await c3.query("rollback").catch(() => {});
          //  Delivered but not closed out: still owed, and the already-sent
          //  guard on each comm_events row stops a duplicate message.
          results.push({ application_id: row.application_id, obligation_id: row.id,
            outcome: "delivered_not_closed", packet_id: committed.packetId,
            per_signer: delivery.per_signer, reason_code: (e && e.message) || "complete_failed" });
          continue;
        } finally { c3.release(); }
        results.push({ application_id: row.application_id, obligation_id: row.id,
          outcome: "delivered", packet_id: committed.packetId,
          per_signer: delivery.per_signer,
          already_issued: !!(committed.link && committed.link.already_issued) });
      }
    }
    return { considered: owed.length, results };
  }

  /*  ── RECOVERY IS NORMAL EXECUTION, NOT A TEST CALLING THE RUNNER ───
   *  The after-commit call accelerates the FIRST attempt. It cannot be the
   *  only path, or work owed when a process died would wait for another
   *  applicant to submit something. This sweeps the owed work on boot and
   *  then periodically, which is what makes "a restart must not lose it"
   *  true rather than merely durable.
   *
   *  ⚠ OFF UNLESS EXPLICITLY ENABLED. Preparation working is not a reason
   *  to point automation at real applicants. LEASE_HANDOFF_RECOVERY_ENABLED
   *  turns it on, and it inherits every gate below it — the boundary's
   *  consent and stop controls, and the per-property send mode.        */
  function startHandoffRecovery({ intervalMs = 5 * 60 * 1000, enabled = null, log = console } = {}) {
    const on = enabled === null
      ? String(process.env.LEASE_HANDOFF_RECOVERY_ENABLED || "").toLowerCase() === "true"
      : !!enabled;
    if (!on) return { started: false, reason: "not_enabled" };
    let running = false;
    const sweep = async () => {
      if (running) return;               // never overlap a sweep with itself
      running = true;
      try {
        const out = await runOwedHandoffs({ limit: 50 });
        if (out.considered) {
          log.log(`[handoff] swept ${out.considered} owed; `
            + out.results.map((r) => `${r.outcome}`).join(","));
        }
      } catch (e) {
        log.error("[handoff] sweep failed, work remains owed:", (e && e.message) || "unknown");
      } finally { running = false; }
    };
    sweep();                              // on boot: this IS the restart recovery
    const timer = setInterval(sweep, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return { started: true, intervalMs, stop: () => clearInterval(timer) };
  }

  return { HANDOFF_TYPE, NOT_YET, NEVER, recordHandoffOwed, runOwedHandoffs, startHandoffRecovery };
};
module.exports.HANDOFF_TYPE = HANDOFF_TYPE;
