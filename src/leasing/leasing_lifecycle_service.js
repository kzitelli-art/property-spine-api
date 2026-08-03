// leasing_lifecycle_service.js — the WRITE PATH for the leasing-lead lifecycle rail (054).
//
// AUTHORITY (CORRECTED, migration 128): THESE EVENTS own opportunity terminal
// truth. leasing_leads.status and leasing_conversions.status are DISPLAY/COMPATIBILITY
// fields — mutable, latest-wins, no reason code, no actor, no history — and are no
// longer historical evidence of an exit. The prior header claimed "leasing_leads.status
// owns opportunity existence + exits"; that was the mutable-label authority this
// migration exists to replace. The queue projection still owns current position.
//
// GRAIN: every act that changes ONE opportunity's terminal state carries an exact
// conversion_id and REFUSES without it. conversation_id remains relationship/channel
// context but is not sufficient authority — `conversations` is unique per
// (property_id, person_id), so one conversation spans every opportunity that person
// ever has at that property.
//
// Every write here:
//   • locks the canonical conversation row (SELECT ... FOR UPDATE) — the UNIVERSAL
//     serialization point. agent_thread_state is NOT the lock (it is lazily created and
//     not guaranteed per lead) and is NEVER created as a side effect of a lifecycle write.
//   • assigns the next per-conversation event_sequence UNDER that lock (gap-tolerant,
//     strictly increasing) — deterministic chronology, not timestamp-ordered.
//   • asserts cross-row invariants FKs can't express (lifecycle.property = conversation
//     .property; a tour's property AND person match the conversation's) — a mismatch
//     raises and rolls the whole transaction back.
//   • writes the lifecycle event (+ the tour link, for link/correct) on ONE client, so
//     they commit together or both roll back.
//
// Scope is enforced by the caller (operator.js requireOperator + property_id); these
// functions additionally verify the conversation belongs to the passed property_id.
//
// Deps: { pool }. No obligation engine needed for the rail itself (obligations are a
// later slice); kept dependency-free so it is trivially testable.

//  Required directly rather than injected: the inbound path receives this
//  service from server.js, which this cut may not modify. A module-level
//  require adds the capability without touching that wiring.
const { openInboundOpportunityDecision, DECISION_DETAIL } =
  require("./inbound_opportunity_decision");

module.exports = function leasingLifecycleService(deps) {
  const { pool } = deps;
  if (!pool) throw new Error("leasing_lifecycle_service requires { pool }");

  function httpErr(status, msg) {
    const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; return e;
  }

  // Lock the conversation, verify property scope, return its row. THE lock point.
  async function lockConversation(client, conversationId, propertyId) {
    const c = (await client.query(
      "select id, property_id, person_id, status from conversations where id=$1 for update",
      [conversationId]
    )).rows[0];
    if (!c) throw httpErr(404, "Conversation not found.");
    if (propertyId && c.property_id !== propertyId) throw httpErr(403, "Not in your property scope.");
    return c;
  }

  // Next per-conversation sequence, assigned under the conversation lock.
  async function nextSequence(client, conversationId) {
    const r = (await client.query(
      "select coalesce(max(event_sequence),0)+1 as n from leasing_lead_lifecycle_events where conversation_id=$1",
      [conversationId]
    )).rows[0];
    return Number(r.n);
  }

  // ── EXACT OPPORTUNITY IDENTITY, OR THE ACT IS REFUSED (migration 128) ────
  //  The caller must ALREADY hold the opportunity UUID because its workflow is
  //  opportunity-bound. This function does not find one. There is deliberately
  //  no lookup by active conversion, latest conversion, event time, lead,
  //  person+property or conversation — one conversation spans every opportunity
  //  a person has at a property, so any of those would be a guess dressed as a
  //  fact. Missing identity REFUSES before any event is written.
  async function requireOpportunity(client, { conversionId, conv, propertyId }) {
    if (!conversionId) {
      throw httpErr(400,
        "This act changes one opportunity's terminal state, so it requires an exact opportunity id. " +
        "The conversation alone cannot identify it — one conversation covers every opportunity this person has at this property.");
    }
    const o = (await client.query(
      `select id, property_id, person_id from leasing_conversions where id=$1`, [conversionId]
    )).rows[0];
    if (!o) throw httpErr(404, "That opportunity does not exist.");
    if (String(o.property_id) !== String(conv.property_id)
        || (propertyId && String(o.property_id) !== String(propertyId))) {
      throw httpErr(403, "That opportunity belongs to another property.");
    }
    //  The opportunity must belong to the SAME person as the conversation.
    //  This is a consistency CHECK on an id the caller supplied — never a way
    //  to derive one.
    if (String(o.person_id) !== String(conv.person_id)) {
      throw httpErr(409, "That opportunity does not belong to this conversation's person.");
    }
    return o;
  }

  // Compute the current lifecycle position from latest-RELEVANT events (a close with no
  // later reopen = closed).
  //
  // SCOPED BY OPPORTUNITY when one is given. Closing one opportunity must not
  // close another that happens to share the conversation, and reopening one must
  // not reopen the other. The per-conversation event_sequence is KEPT as the
  // durable chronology — it is not rewritten — and simply filtered by exact
  // conversion_id.
  async function currentClosureState(client, conversationId, conversionId = null) {
    const scope = conversionId ? "and conversion_id = $2" : "";
    const args = conversionId ? [conversationId, conversionId] : [conversationId];
    const r = (await client.query(
      `select
         max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
         max(event_sequence) filter (where event_type='reopened')       as reopen_seq
       from leasing_lead_lifecycle_events where conversation_id=$1 ${scope}`,
      args
    )).rows[0];
    const closed = r.close_seq !== null &&
      (r.reopen_seq === null || Number(r.reopen_seq) < Number(r.close_seq));
    return { closed };
  }

  // Load a tour and assert it matches the conversation's property AND person.
  async function assertTourMatches(client, tourId, conv) {
    const t = (await client.query(
      "select id, property_id, person_id, status, conversion_id from scheduled_tours where id=$1",
      [tourId]
    )).rows[0];
    if (!t) throw httpErr(404, "Tour not found.");
    if (t.property_id !== conv.property_id)
      throw httpErr(422, "Tour property does not match the conversation's property.");
    if (t.person_id !== conv.person_id)
      throw httpErr(422, "Tour person does not match the conversation's person.");
    return t;
  }

  const VALID_CLOSE_REASONS = new Set([
    "budget_mismatch","program_mismatch","move_timing","location",
    "duplicate","no_longer_interested","other",
  ]);

  async function tx(fn) {
    const client = await pool.connect();
    try { await client.query("begin"); const out = await fn(client); await client.query("commit"); return out; }
    catch (e) { await client.query("rollback"); throw e; }
    finally { client.release(); }
  }

  // ── CLOSE AS NOT-FIT ──────────────────────────────────────────────────────
  // Operator decision. Requires a reason_code ('other' ⇒ reason_note). Idempotent by
  // a caller-supplied key (default: one close per current-open span).
  async function closeNotFit({ conversationId, propertyId, conversionId, actorUserId, reasonCode, reasonNote, idempotencyKey }) {
    if (!VALID_CLOSE_REASONS.has(reasonCode)) throw httpErr(400, "Invalid or missing reason_code.");
    if (reasonCode === "other" && (!reasonNote || !reasonNote.trim()))
      throw httpErr(400, "reason_note is required when reason_code is 'other'.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      //  REFUSES BEFORE ANY WRITE when identity is missing.
      const opp = await requireOpportunity(client, { conversionId, conv, propertyId });
      const { closed } = await currentClosureState(client, conversationId, opp.id);
      if (closed) throw httpErr(409, "This opportunity is already closed.");
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `close:${conversationId}:${opp.id}:${seq}`;
      const row = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
            actor_id, reason_code, reason_note, idempotency_key, occurred_at)
         values ($1,$8,$2,$3,'closed_not_fit','operator',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, reasonCode, reasonNote || null, idem, opp.id]
      )).rows[0];
      if (!row) throw httpErr(409, "Duplicate close (idempotency key already used).");
      // FIX-FORWARD (BL-3): a plain-language receipt, matching the house pattern
      // every other proven write returns (completeTour, attestApplicationSent).
      // The client displays this verbatim rather than inventing success language
      // client-side for a fact only the server can confirm.
      const readableReason = String(reasonCode).replace(/_/g, " ");
      return { ok: true, event: row, receipt: `Closed — not a fit (${readableReason}).` };
    });
  }

  // ── REOPEN ────────────────────────────────────────────────────────────────
  // From an operator action OR a genuine qualifying inbound (source_comm_event_id set).
  //  ONE reopen implementation, usable inside a caller's transaction. The
  //  public reopen() is this function wrapped in tx(), so an operator reopen and
  //  a decision-resolution reopen cannot diverge.
  async function reopenInTransaction(client, { conversationId, propertyId, conversionId,
      actorType = "operator", actorUserId, sourceCommEventId, idempotencyKey }) {
    if (!["operator","system","agent"].includes(actorType)) throw httpErr(400, "Invalid actor_type.");
    {
      const conv = await lockConversation(client, conversationId, propertyId);
      const opp = await requireOpportunity(client, { conversionId, conv, propertyId });
      const { closed } = await currentClosureState(client, conversationId, opp.id);
      if (!closed) throw httpErr(409, "This opportunity is not closed; nothing to reopen.");
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `reopen:${conversationId}:${opp.id}:${seq}`;
      const row = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
            actor_id, source_comm_event_id, idempotency_key, occurred_at)
         values ($1,$8,$2,$3,'reopened',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorType, actorUserId || null, sourceCommEventId || null, idem, opp.id]
      )).rows[0];
      if (!row) throw httpErr(409, "Duplicate reopen (idempotency key already used).");
      return { ok: true, event: row };
    }
  }

  async function reopen(args) {
    return tx(async (client) => reopenInTransaction(client, args));
  }

  // ── LINK TOUR ─────────────────────────────────────────────────────────────
  // Explicit origin: caller passes the tour_id. NEVER person-matched. Writes the link
  // AND the lifecycle event in one transaction. Asserts property+person match.
  async function linkTour({ conversationId, propertyId, tourId, relationshipType = "originated_from", linkedByUserId, idempotencyKey }) {
    if (!["originated_from","rescheduled_to","follow_up_tour"].includes(relationshipType))
      throw httpErr(400, "Invalid relationship_type.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      const linkTourRow = await assertTourMatches(client, tourId, conv);   // property + person
      const link = (await client.query(
        `insert into leasing_conversation_tour_links
           (conversation_id, tour_id, relationship_type, linked_by)
         values ($1,$2,$3,$4)
         on conflict (conversation_id, tour_id) do nothing
         returning *`,
        [conversationId, tourId, relationshipType, linkedByUserId || null]
      )).rows[0];
      if (!link) throw httpErr(409, "This conversation is already linked to that tour.");
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `tour_linked:${tourId}`;
      const evt = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, idempotency_key, occurred_at)
         values ($1,$7,$2,$3,'tour_linked','operator',$4,$5,$6, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, linkedByUserId || null, tourId, idem,
         linkTourRow.conversion_id || null]
      )).rows[0];
      return { ok: true, link, event: evt };
    });
  }

  // ── CANCEL TOUR ───────────────────────────────────────────────────────────
  // Cancellation is a STATUS change on the tour and KEEPS the link (history stays true;
  // the prospect re-enters active by projection). Writes tour.status='cancelled' + the
  // tour_cancelled lifecycle event. Does NOT set unlinked_at.
  async function cancelTour({ conversationId, propertyId, tourId, actorUserId, idempotencyKey }) {
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      const tour = await assertTourMatches(client, tourId, conv);
      // require the link to exist (can't "cancel via this conversation" a tour it isn't linked to)
      const link = (await client.query(
        "select id from leasing_conversation_tour_links where conversation_id=$1 and tour_id=$2 and unlinked_at is null",
        [conversationId, tourId]
      )).rows[0];
      if (!link) throw httpErr(422, "Tour is not currently linked to this conversation.");
      await client.query("update scheduled_tours set status='cancelled', updated_at=now() where id=$1", [tourId]);
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `tour_cancelled:${tourId}:${seq}`;
      const evt = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, idempotency_key, occurred_at)
         values ($1,$7,$2,$3,'tour_cancelled','operator',$4,$5,$6, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, tourId, idem,
         tour.conversion_id || null]
      )).rows[0];
      return { ok: true, event: evt, tour_status: "cancelled", link_kept: true };
    });
  }

  // ── CORRECT TOUR LINK ─────────────────────────────────────────────────────
  // Explicit mis-attribution fix ONLY: sets unlinked_at + reason on the link, writes a
  // tour_link_corrected event with correction_reason. Does NOT touch tour.status.
  async function correctTourLink({ conversationId, propertyId, tourId, correctionReason, actorUserId, idempotencyKey }) {
    if (!correctionReason || !correctionReason.trim()) throw httpErr(400, "correction_reason is required.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      const correctTour = await assertTourMatches(client, tourId, conv);
      const link = (await client.query(
        "select id from leasing_conversation_tour_links where conversation_id=$1 and tour_id=$2 and unlinked_at is null",
        [conversationId, tourId]
      )).rows[0];
      if (!link) throw httpErr(422, "No active link between this conversation and tour to correct.");
      await client.query(
        "update leasing_conversation_tour_links set unlinked_at=now(), unlink_reason=$3 where id=$1 and $2=$2",
        [link.id, tourId, correctionReason]
      );
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `tour_link_corrected:${tourId}:${seq}`;
      const evt = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, correction_reason, idempotency_key, occurred_at)
         values ($1,$8,$2,$3,'tour_link_corrected','operator',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, tourId, correctionReason, idem,
         correctTour.conversion_id || null]
      )).rows[0];
      return { ok: true, event: evt, link_corrected: true };
    });
  }

  // ── GENUINE-INBOUND REOPEN (transaction-aware; called BY the inbound writers) ──
  // THE INVARIANT: a qualifying prospect inbound is persisted → the SAME transaction
  // locks the conversation → if latest-relevant lifecycle state is closed_not_fit,
  // append exactly one 'reopened' with source_comm_event_id = that inbound → they
  // commit together or both roll back.
  //
  // This takes an ALREADY-OPEN client (it does NOT open its own transaction) so it
  // joins the inbound-write transaction. Idempotent BY CONSTRUCTION: the conversation
  // lock serializes the decision, so a concurrent/second call that finds the thread
  // already reopened becomes a clean no-op (no duplicate reopened event). Callers must
  // only invoke this for a QUALIFYING prospect inbound — the same definition the queue
  // projection uses: direction='inbound', sender_role='prospect', non-empty body. Do
  // NOT call it for provider-status callbacks, webhook replays (already deduped by
  // (provider, provider_event_id)), system/AI/agent events, blank payloads, or notes.
  //
  // Returns { reopened: boolean }. reopened=false when the thread wasn't closed (the
  // common case) OR when an earlier call in a race already reopened it.
  //  ── CONTROLLED REFUSAL (migration 128) ────────────────────────────────
  //  This path is the ONE caller that cannot supply exact opportunity identity.
  //  An inbound text arrives on a CONVERSATION. It carries no opportunity, and
  //  one conversation spans every opportunity the person has at the property.
  //  Reopening "the active one" would be precisely the silent guess the rail is
  //  being corrected to stop making.
  //
  //  So it now REFUSES instead of writing: no event, no mutation, and — this
  //  matters — NO THROW. It runs inside the inbound-persistence transaction, so
  //  throwing would roll back the prospect's message. The message is the real
  //  fact and must survive; only the unattributable reopen is withheld.
  //
  //  BEHAVIOUR CHANGE, STATED PLAINLY: a closed opportunity no longer reopens
  //  automatically when the prospect replies. The reply is still recorded and
  //  still surfaces on the conversation; an operator reopens explicitly, naming
  //  the opportunity. Restoring automatic reopen requires the inbound path to
  //  carry an opportunity, which is a separate, governed piece of work.
  async function maybeReopenOnQualifyingInbound(client, { conversationId, sourceCommEventId, conversionId = null }) {
    const c = (await client.query(
      "select id from conversations where id=$1 for update", [conversationId]
    )).rows[0];
    if (!c) return { reopened: false, refused: false };

    if (!conversionId) {
      //  Is there anything to reopen at all? Reported so the refusal is
      //  visible as a real withheld act rather than a silent nothing.
      const { closed } = await currentClosureState(client, conversationId);
      if (!closed) return { reopened: false, refused: false };

      //  ── THE OPERATING SEAM ──────────────────────────────────────────
      //  Refusing is not enough. Without this, the reply is durable and
      //  INVISIBLE: the queue classifies the conversation closed_not_fit with
      //  waiting_on='none', so nobody owns the next action. Open an explicit,
      //  owned decision IN THIS SAME TRANSACTION, so the message and the
      //  decision commit together or not at all.
      //  SAVEPOINT: the prospect's message must survive regardless. Without
      //  one, a failed decision insert aborts the WHOLE inbound transaction in
      //  Postgres, so catching the error in JavaScript would not be enough —
      //  every later statement would fail too.
      let decision = null;
      await client.query("savepoint s9_inbound_decision");
      try {
        const conv = (await client.query(
          `select id, property_id, person_id from conversations where id=$1`, [conversationId])).rows[0];
        decision = await openInboundOpportunityDecision(client, {
          property_id: conv.property_id, person_id: conv.person_id,
          conversation_id: conversationId, source_comm_event_id: sourceCommEventId,
        });
        await client.query("release savepoint s9_inbound_decision");
      } catch (e) {
        await client.query("rollback to savepoint s9_inbound_decision");
        decision = { ok: false, error: e.message };
      }

      return {
        reopened: false,
        refused: true,
        refusal_code: "opportunity_identity_required",
        refusal_reason: "A closed opportunity exists on this conversation, but an inbound message does not identify WHICH opportunity. Reopening requires an explicit opportunity id; it is never chosen automatically.",
        decision_opened: !!(decision && decision.ok),
        decision_obligation_id: decision && decision.obligation_id ? decision.obligation_id : null,
        operator_prompt: DECISION_DETAIL,
      };
    }

    const { closed } = await currentClosureState(client, conversationId, conversionId);
    if (!closed) return { reopened: false, refused: false };
    const seq = await nextSequence(client, conversationId);
    // idempotency key ties the reopen to the specific inbound; if the same inbound is
    // somehow processed twice, the unique (conversation_id, idempotency_key) makes the
    // second a clean no-op.
    const idem = sourceCommEventId ? `reopen_inbound:${sourceCommEventId}` : `reopen_inbound:${conversationId}:${seq}`;
    const row = (await client.query(
      `insert into leasing_lead_lifecycle_events
         (conversation_id, conversion_id, property_id, event_sequence, event_type, actor_type,
          source_comm_event_id, idempotency_key, occurred_at)
       select $1, $5, c.property_id, $2, 'reopened', 'system', $3, $4, now()
         from conversations c where c.id=$1
       on conflict (conversation_id, idempotency_key) do nothing
       returning id`,
      [conversationId, seq, sourceCommEventId || null, idem, conversionId]
    )).rows[0];
    return { reopened: !!row, refused: false };
  }

  // ── TRANSITION GUARD (transaction-aware) ──
  // NOT YET WIRED / NOT ENFORCED: this function is implemented and tested at the service
  // boundary, but NO canonical tour-creation call site invokes it yet, so it currently
  // blocks nothing. When the tour-creation flow is wired to call it (a future domain-
  // service patch), it will prevent silently creating a live tour for a prospect whose
  // conversation is projected as closed_not_fit — throwing 409 to force an explicit
  // reopen first. The caller must invoke it under its own transaction. (Later,
  // application-submission and other strong re-engagement events may also become
  // explicit reopen triggers — NAMED as future integration points, not wired now.)
  async function assertNotSoftClosedForTour(client, { conversationId }) {
    const { closed } = await currentClosureState(client, conversationId);
    if (closed) throw httpErr(409,
      "Conversation is closed-not-fit; an explicit reopen is required before creating a tour.");
    return { ok: true };
  }

  return { closeNotFit, reopen, reopenInTransaction, linkTour, cancelTour, correctTourLink,
           maybeReopenOnQualifyingInbound, assertNotSoftClosedForTour,
           // exported for testing / reuse
           _internals: { lockConversation, nextSequence, currentClosureState, assertTourMatches } };
};
