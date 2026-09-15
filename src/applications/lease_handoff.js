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
  const { pool, spawnObligationFromEvent, completeObligation, leasePackets } = deps;
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
      try {
        await client.query("begin");
        //  generateLeasePacket locks the application and runs the one
        //  eligibility predicate, reading the authored offer fresh. If the
        //  agreement moved since submission, this is where it refuses.
        const gen = await svc.generateLeasePacket(client, {
          applicationId: row.application_id,
          expectedPropertyId: row.property_id,
        });
        const packetId = gen && (gen.packet_id || (gen.packet && gen.packet.id));
        //  REACHABILITY IS THE POINT, not packet creation. A packet nobody
        //  can open is the same unfinished handoff in a tidier state.
        const link = await svc.issueLeasePacketLink(client, {
          packetId, expectedPropertyId: row.property_id,
        });
        /*  ⚠ THE ENGINE TAKES { obligation_id, completed_by } AND NOTHING
         *  ELSE. An earlier draft of this call passed resolution_code and a
         *  note; both would have been silently dropped, and a parameter a
         *  function never reads is worse than no parameter, because it
         *  reads as a record that was never written. The outcome is
         *  returned to the caller instead, and the packet itself is the
         *  durable evidence.                                             */
        await completeObligation(client, { obligation_id: row.id });
        await client.query("commit");
        results.push({ application_id: row.application_id, obligation_id: row.id,
          outcome: "prepared", packet_id: packetId,
          already_issued: !!(link && link.already_issued) });
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
    }
    return { considered: owed.length, results };
  }

  return { HANDOFF_TYPE, NOT_YET, NEVER, recordHandoffOwed, runOwedHandoffs };
};
module.exports.HANDOFF_TYPE = HANDOFF_TYPE;
