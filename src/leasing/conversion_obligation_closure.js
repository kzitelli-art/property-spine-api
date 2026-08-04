// ════════════════════════════════════════════════════════════════════
//  conversion_obligation_closure.js — THE CONVERSION CLOSURE AUTHORITY
//
//  WHY THIS FILE EXISTS (reviewer ruling, Jul 4 2026):
//  "Only the conversion rail may close conversion-linked work" must be a
//  STRUCTURAL property, not a convention. A boolean argument, route flag,
//  header, or session marker is a bypass waiting for a forgetful caller.
//
//  THE CAPABILITY PATTERN — an ARCHITECTURAL closure boundary, enforced by
//  import discipline and static gates (this is JavaScript in one process;
//  we do not claim an absolute runtime-security boundary — the static gate
//  fails the build if any module other than server.js imports this factory):
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
const { recognizeObligationMissed } = require("../shared/obligation_missed.js");

const staffIdentity = require("../identity/staff_identity_resolver.js");

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
    //  D1-a: the close had NO replay identity at all, so the most consequential
    //  task operation -- closing work -- could not be replayed even though the
    //  ledger writer has supported it all along. Threaded through here.
    idempotency_key = null,
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
    if (ob && ob.status !== "complete") {
      if (resolution === "missed") {
        // ── THE WINDOW CLOSED. THE WORK DID NOT DISAPPEAR. ──────────────
        //  This used to write `status='missed'`. That write NEVER SUCCEEDED —
        //  ck_obl_status permits only open|in_progress|complete|escalated, so
        //  every attempt threw and rolled back the whole transaction, taking the
        //  link stamp and the 069 ledger append with it. A crossed window
        //  recorded nothing at all. Zero missed rows exist in production.
        //
        //  Ruled 2026-08-01: missedness is ORTHOGONAL to lifecycle, not a fourth
        //  value of it. The obligation KEEPS its status and stays visible,
        //  because the work still has not happened. The rung's window is closed
        //  as missed (the link stamp above); the obligation remains open and
        //  actionable. Those are different truths, not a contradiction.
        //
        //  The old `ob.status !== "missed"` half of the guard above was dead
        //  code — no row could ever hold that value — and is gone with it.
        await recognizeObligationMissed(client, {
          obligation_id: link.obligation_id,
          expected_status: ob.status,
          // the threshold is DERIVED inside the service from the obligation;
          // this is stale-state protection only, never authority.
          expected_threshold_at: ob.due_at,
          system_actor: "conversion_rail_window",
          reason: "conversion rung window closed as missed",
          source: "conversion_rail.resolveRung",
          // deterministic per rung: a retry recognises nothing new.
          idempotency_key: `conv_rung_missed:${link.id}`,
        });
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
    // R3 (069): the close is also an append-only ledger fact — written in the
    // SAME transaction as the terminal mutation. If 069 has not been applied
    // (pre-R3 deploy window), the ledger write is skipped rather than faked.
    const closeEv = await appendEvent(client, {
      conversion_obligation_id: link.id, event_type: "resolved",
      actor_user_id: by_user_id || null, actor_person: snapPerson, actor_assignment: snapAssignment,
      identity_resolution_basis: snapIdBasis,
      prior_status: "open", next_status: resolution === "missed" ? "missed" : "complete",
      resolution_code: resolution, resolution_basis,
      idempotency_key,
    });

    //  event_id / replayed are INTERNAL, for future receipt construction.
    //  They are NOT a receipt: nothing here binds the key to the payload, so
    //  `replayed` means only "an event exists under this key for this
    //  obligation" -- never "the operation you asked for is what happened".
    //  No caller may present these to a human as confirmation.
    return { outcome, resolution, closed_by_user_id: by_user_id || null,
             closed_identity_resolution_basis: snapIdBasis, resolution_basis,
             event_id: closeEv && closeEv.event_id, replayed: !!(closeEv && closeEv.replayed) };
  }

  // ── the append-only ledger write (069) — shared by close/reopen ──────
  async function appendEvent(client, e) {
    const has = (await client.query("select to_regclass('leasing_conversion_obligation_events') as t")).rows[0];
    if (!has || !has.t) return null; // 069 not applied yet — never fabricate
    if (e.idempotency_key) {
      // ── PROPERTY-SAFE DUPLICATE LOOKUP ────────────────────────────────
      //  This was `where idempotency_key=$1` with no scope at all. Two
      //  properties minting the same key would collide, and the SECOND caller
      //  would be handed the FIRST property's event id — which it would then
      //  treat as its own durable receipt. The protection was the caller's key
      //  format, which is not a server-side guarantee.
      //
      //  The lookup is now bound to the exact obligation as well as the key,
      //  and the obligation carries the property lineage. So:
      //    same property + same obligation + same key -> the original event
      //    different property + same key              -> no row (never theirs)
      //    same property + different obligation + key -> no row (not this
      //                                                  obligation's receipt)
      //
      //  The UNIQUE index on idempotency_key is still GLOBAL, so a genuine
      //  cross-property collision now fails loudly on insert instead of
      //  silently disclosing. That residual is
      //  BLOCKED — COMPOSITE IDEMPOTENCY SCOPE REQUIRES MIGRATION and is
      //  acceptable temporarily. Cross-property disclosure is not.
      const dup = (await client.query(
        `select id from leasing_conversion_obligation_events
          where idempotency_key = $1 and conversion_obligation_id = $2`,
        [e.idempotency_key, e.conversion_obligation_id])).rows[0];
      //  NOTE FOR THE READER: a duplicate found here is returned WITHOUT any
      //  comparison of the incoming operation against the original. That is a
      //  known and deliberate limit — there is nowhere durable to store a
      //  material payload hash. It is exactly why no task receipt is exposed:
      //  see docs/IMMUTABLE_ACTION_AUTHORITY.md. Callers of this function must
      //  not present its result to a human as confirmation of what they asked
      //  for, only as "an event under this key already exists".
      if (dup) return { event_id: dup.id, replayed: true }; // history appends nothing new
    }
    const r = await client.query(
      `insert into leasing_conversion_obligation_events
         (conversion_obligation_id, event_type, actor_user_id, actor_person_id_at_event,
          actor_assignment_id_at_event, identity_resolution_basis,
          prior_status, next_status, prior_owner_user_id, next_owner_user_id,
          ownership_origin, owner_eligibility_state,
          resolution_code, resolution_basis, reason, prior_due_at, next_due_at,
          prior_event_id, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       returning id`,
      [e.conversion_obligation_id, e.event_type, e.actor_user_id || null,
       e.actor_person || null, e.actor_assignment || null, e.identity_resolution_basis || null,
       e.prior_status || null, e.next_status || null,
       e.prior_owner_user_id || null, e.next_owner_user_id || null,
       e.ownership_origin || null, e.owner_eligibility_state || null,
       e.resolution_code || null, e.resolution_basis || null, e.reason || null,
       e.prior_due_at || null, e.next_due_at || null,
       e.prior_event_id || null, e.idempotency_key || null]);
    //  STRUCTURED, not a bare id. Callers need to know whether history was
    //  appended or an existing event was returned; a bare id cannot say.
    return { event_id: r.rows[0].id, replayed: false };
  }

  /**
   * REOPEN — the inverse terminal mutation. Same structural exclusivity as
   * close: only the rail (via this capability) can un-terminate a linked
   * obligation. POLICY (window, dependency check, ownership rule) lives in
   * the rail; this function performs the mutation + ledger append atomically,
   * given the rail's already-made decisions.
   *
   * The prior close is NOT erased: the 'reopened' event carries the prior
   * resolution facts; the link's closure columns are cleared so the row
   * re-enters the active queue (the queue reads `outcome is null`).
   */
  async function reopenLinkedConversionObligation(client, {
    link, property_id, by_user_id = null, reason, new_due_at,
    next_owner_user_id = null, owner_eligibility_state = null, idempotency_key = null,
  }) {
    if (!link || !link.id || !link.obligation_id) throw httpErr(500, "closure authority: link row required.");
    const fresh = (await client.query(
      `select * from leasing_conversion_obligations where id=$1 for update`, [link.id])).rows[0];
    if (!fresh) throw httpErr(404, "closure authority: link vanished.");
    if (fresh.outcome == null) throw httpErr(409, "task is already open — nothing to reopen.");

    let snapPerson = null, snapAssignment = null, snapIdBasis = "unbridged";
    if (by_user_id) {
      try {
        const idn = await staffIdentity.resolveStaffIdentity(client, { user_id: by_user_id, property_id });
        snapPerson = idn.person_id || null; snapAssignment = idn.assignment_id || null;
        snapIdBasis = idn.state || "unbridged";
      } catch (_) { /* honest unbridged snapshot */ }
    }

    const evRes = await appendEvent(client, {
      conversion_obligation_id: fresh.id, event_type: "reopened",
      actor_user_id: by_user_id || null, actor_person: snapPerson, actor_assignment: snapAssignment,
      identity_resolution_basis: snapIdBasis,
      prior_status: fresh.resolution === "missed" ? "missed" : "complete", next_status: "open",
      prior_owner_user_id: fresh.owner_user_id, next_owner_user_id,
      owner_eligibility_state,
      resolution_code: fresh.resolution, resolution_basis: fresh.resolution_basis,
      reason, prior_due_at: fresh.due_by, next_due_at: new_due_at, idempotency_key,
    });

    await client.query(
      `update leasing_conversion_obligations
          set outcome=null, resolution=null, proof=null, closed_at=null,
              closed_by_user_id=null, closed_by_person_id_at_close=null,
              closed_by_assignment_id_at_close=null, closed_identity_resolution_basis=null,
              resolution_basis=null, owner_user_id=$2, due_by=$3
        where id=$1`, [fresh.id, next_owner_user_id, new_due_at]);
    await client.query(
      `update obligations set status='open', completed_at=null, due_at=$2, updated_at=now() where id=$1`,
      [fresh.obligation_id, new_due_at]);

    return { reopened: true, event_id: evRes && evRes.event_id, replayed: !!(evRes && evRes.replayed), owner_user_id: next_owner_user_id,
             owner_eligibility_state, new_due_at };
  }

  return Object.freeze({ closeLinkedConversionObligation, reopenLinkedConversionObligation, appendEvent });
}

// The factory is the ONLY export. There is no raw helper to import.
module.exports = { createConversionClosureAuthority };
