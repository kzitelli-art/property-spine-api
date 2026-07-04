// ════════════════════════════════════════════════════════════════════
//  conversion_obligation_closure.js — THE CONVERSION CLOSURE AUTHORITY
//
//  WHY THIS FILE EXISTS (reviewer ruling, Jul 4 2026):
//  "Only the conversion rail may close conversion-linked work" must be a
//  STRUCTURAL property, not a convention. A boolean argument, route flag,
//  header, or session marker is a bypass waiting for a forgetful caller.
//
//  THE CAPABILITY PATTERN:
//    createConversionClosureAuthority() → { closeLinkedConversionObligation }
//    · server.js creates the authority ONCE and hands it ONLY to the
//      conversion rail (leasingconversion.js).
//    · The generic obligation engine never receives it, and its public
//      completeObligation carries NO bypass parameter of any kind — it
//      categorically rejects conversion-linked obligations.
//    · The raw terminal mutation below is not exported; it exists only
//      inside the closure returned by the factory. A future generic route
//      cannot reach it by passing a flag, because there is no flag.
//
//  WHAT THE CAPABILITY OWNS (atomically, inside the caller's transaction):
//    · the write-once outcome stamp on the conversion link;
//    · the closure identity snapshots (raw session user + the resolver's
//      answer AT CLOSURE TIME — never recomputed later);
//    · the terminal mutation on the underlying obligations row
//      (complete / missed) + the completion event;
//    · terminal-state rules: already-closed → stable 409; missed never
//      masquerades as complete.
//
//  WHAT IT REFUSES TO KNOW: ladder advancement, basis policy, released-
//  closes-conversation, and signature-work creation live in resolveRung —
//  the rail's ONE closure operation. This module can never create
//  signature-followup work from applicant_followup because it creates
//  nothing at all; it only terminates.
//
//  DB-privilege hardening (dedicated roles + SECURITY DEFINER procedure)
//  is documented as a LATER option; a cosmetic session-marker trigger is
//  explicitly rejected as false confidence.
// ════════════════════════════════════════════════════════════════════
"use strict";

const staffIdentity = require("./staff_identity_resolver.js");

function httpErr(status, message) {
  const e = new Error(message);
  e.httpStatus = status; e.publicMessage = message;
  return e;
}

function createConversionClosureAuthority() {
  /**
   * The one terminal operation for a conversion-linked obligation.
   * Runs inside the CALLER'S transaction; commits/rolls back with it.
   *
   * @param client   pg client already inside a transaction
   * @param link     the leasing_conversion_obligations row, ALREADY locked
   *                 (select … for update) and verified outcome IS NULL by
   *                 the rail — this function re-verifies defensively.
   * @param property_id  the conversion's property (for the identity snapshot)
   * @param outcome      'kept' | 'missed'
   * @param resolution   'completed' | 'released' | 'missed'
   * @param proof        optional proof object
   * @param by_user_id   raw authenticated session fact (may be null)
   * @param resolution_basis  'owner' | coverage vocabulary — decided by the rail
   */
  async function closeLinkedConversionObligation(client, {
    link, property_id, outcome, resolution, proof = null, by_user_id = null, resolution_basis = null,
  }) {
    if (!link || !link.id || !link.obligation_id) throw httpErr(500, "closure authority: link row required.");
    // defensive re-check under the caller's lock: terminal state is write-once
    const fresh = (await client.query(
      "select outcome, resolution from leasing_conversion_obligations where id=$1", [link.id])).rows[0];
    if (!fresh) throw httpErr(404, "closure authority: link vanished.");
    if (fresh.outcome != null) throw httpErr(409, `rung already closed as ${fresh.outcome}/${fresh.resolution}.`);

    // IDENTITY SNAPSHOT AT CLOSE: raw user fact + the resolver's answer NOW.
    // Later bridge corrections never rewrite this history. Unbridged closer =
    // raw user retained, null snapshots, basis 'unbridged' — honest blank.
    let snapPerson = null, snapAssignment = null, snapIdBasis = "unbridged";
    if (by_user_id) {
      try {
        const idn = await staffIdentity.resolveStaffIdentity(client, { user_id: by_user_id, property_id });
        snapPerson = idn.person_id || null;
        snapAssignment = idn.assignment_id || null;
        snapIdBasis = idn.state || "unbridged";
      } catch (_) { /* unresolvable = honest unbridged snapshot */ }
    }

    // the write-once outcome stamp (what the Grade reads)
    await client.query(
      `update leasing_conversion_obligations
          set outcome=$1, resolution=$2, proof=$3, closed_at=now(), closed_by_user_id=$4,
              closed_by_person_id_at_close=$5, closed_by_assignment_id_at_close=$6,
              closed_identity_resolution_basis=$7, resolution_basis=$8
        where id=$9 and outcome is null`,
      [outcome, resolution, proof ? JSON.stringify(proof) : null, by_user_id || null,
       snapPerson, snapAssignment, snapIdBasis, resolution_basis, link.id]
    );

    // the terminal mutation on the underlying obligation — the mutation the
    // generic engine can never perform on linked rows.
    const ob = (await client.query(
      "select * from obligations where id=$1 for update", [link.obligation_id])).rows[0];
    if (ob && ob.status !== "complete" && ob.status !== "missed") {
      if (resolution === "missed") {
        await client.query(
          `update obligations set status='missed', updated_at=now() where id=$1`, [link.obligation_id]);
      } else {
        await client.query(
          `update obligations set status='complete', completed_at=now(), updated_at=now() where id=$1`,
          [link.obligation_id]);
        await client.query(
          `insert into events (property_id, person_id, unit_id, type, note)
           values ($1,$2,$3,'obligation_completed',$4)`,
          [ob.property_id, ob.person_id, ob.unit_id,
           `Closed through the conversion rail (${resolution}).`]);
      }
    }
    return { outcome, resolution, closed_by_user_id: by_user_id || null,
             closed_identity_resolution_basis: snapIdBasis, resolution_basis };
  }

  return Object.freeze({ closeLinkedConversionObligation });
}

// The factory is the ONLY export. There is no raw helper to import.
module.exports = { createConversionClosureAuthority };
