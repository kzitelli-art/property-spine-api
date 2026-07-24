// leasing_lifecycle_service.js — the WRITE PATH for the leasing-lead lifecycle rail (054).
//
// AUTHORITY (locked): leasing_leads.status owns opportunity existence + exits; THESE
// functions own the append-only history of explicit decisions; the queue projection
// owns current position. Every write here:
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

  // Compute the current lifecycle position from latest-RELEVANT events (a close with no
  // later reopen = closed). Used to guard illegal transitions.
  async function currentClosureState(client, conversationId) {
    const r = (await client.query(
      `select
         max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
         max(event_sequence) filter (where event_type='reopened')       as reopen_seq
       from leasing_lead_lifecycle_events where conversation_id=$1`,
      [conversationId]
    )).rows[0];
    const closed = r.close_seq !== null &&
      (r.reopen_seq === null || Number(r.reopen_seq) < Number(r.close_seq));
    return { closed };
  }

  // Load a tour and assert it matches the conversation's property AND person.
  async function assertTourMatches(client, tourId, conv) {
    const t = (await client.query(
      "select id, property_id, person_id, status from scheduled_tours where id=$1",
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
  async function closeNotFit({ conversationId, propertyId, actorUserId, reasonCode, reasonNote, idempotencyKey }) {
    if (!VALID_CLOSE_REASONS.has(reasonCode)) throw httpErr(400, "Invalid or missing reason_code.");
    if (reasonCode === "other" && (!reasonNote || !reasonNote.trim()))
      throw httpErr(400, "reason_note is required when reason_code is 'other'.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      const { closed } = await currentClosureState(client, conversationId);
      if (closed) throw httpErr(409, "Conversation is already closed.");
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `close:${conversationId}:${seq}`;
      const row = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, property_id, event_sequence, event_type, actor_type,
            actor_id, reason_code, reason_note, idempotency_key, occurred_at)
         values ($1,$2,$3,'closed_not_fit','operator',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, reasonCode, reasonNote || null, idem]
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
  async function reopen({ conversationId, propertyId, actorType = "operator", actorUserId, sourceCommEventId, idempotencyKey }) {
    if (!["operator","system","agent"].includes(actorType)) throw httpErr(400, "Invalid actor_type.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      const { closed } = await currentClosureState(client, conversationId);
      if (!closed) throw httpErr(409, "Conversation is not closed; nothing to reopen.");
      const seq = await nextSequence(client, conversationId);
      const idem = idempotencyKey || `reopen:${conversationId}:${seq}`;
      const row = (await client.query(
        `insert into leasing_lead_lifecycle_events
           (conversation_id, property_id, event_sequence, event_type, actor_type,
            actor_id, source_comm_event_id, idempotency_key, occurred_at)
         values ($1,$2,$3,'reopened',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorType, actorUserId || null, sourceCommEventId || null, idem]
      )).rows[0];
      if (!row) throw httpErr(409, "Duplicate reopen (idempotency key already used).");
      return { ok: true, event: row };
    });
  }

  // ── LINK TOUR ─────────────────────────────────────────────────────────────
  // Explicit origin: caller passes the tour_id. NEVER person-matched. Writes the link
  // AND the lifecycle event in one transaction. Asserts property+person match.
  async function linkTour({ conversationId, propertyId, tourId, relationshipType = "originated_from", linkedByUserId, idempotencyKey }) {
    if (!["originated_from","rescheduled_to","follow_up_tour"].includes(relationshipType))
      throw httpErr(400, "Invalid relationship_type.");
    return tx(async (client) => {
      const conv = await lockConversation(client, conversationId, propertyId);
      await assertTourMatches(client, tourId, conv);           // property + person
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
           (conversation_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, idempotency_key, occurred_at)
         values ($1,$2,$3,'tour_linked','operator',$4,$5,$6, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, linkedByUserId || null, tourId, idem]
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
           (conversation_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, idempotency_key, occurred_at)
         values ($1,$2,$3,'tour_cancelled','operator',$4,$5,$6, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, tourId, idem]
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
           (conversation_id, property_id, event_sequence, event_type, actor_type,
            actor_id, tour_id, correction_reason, idempotency_key, occurred_at)
         values ($1,$2,$3,'tour_link_corrected','operator',$4,$5,$6,$7, now())
         on conflict (conversation_id, idempotency_key) do nothing
         returning *`,
        [conversationId, conv.property_id, seq, actorUserId || null, tourId, correctionReason, idem]
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
  async function maybeReopenOnQualifyingInbound(client, { conversationId, sourceCommEventId }) {
    // lock the conversation row (the universal serialization point) — NOT agent_thread_state
    const c = (await client.query(
      "select id from conversations where id=$1 for update", [conversationId]
    )).rows[0];
    if (!c) return { reopened: false }; // conversation vanished; nothing to do
    const { closed } = await currentClosureState(client, conversationId);
    if (!closed) return { reopened: false };
    const seq = await nextSequence(client, conversationId);
    // idempotency key ties the reopen to the specific inbound; if the same inbound is
    // somehow processed twice, the unique (conversation_id, idempotency_key) makes the
    // second a clean no-op.
    const idem = sourceCommEventId ? `reopen_inbound:${sourceCommEventId}` : `reopen_inbound:${conversationId}:${seq}`;
    const row = (await client.query(
      `insert into leasing_lead_lifecycle_events
         (conversation_id, property_id, event_sequence, event_type, actor_type,
          source_comm_event_id, idempotency_key, occurred_at)
       select $1, c.property_id, $2, 'reopened', 'system', $3, $4, now()
         from conversations c where c.id=$1
       on conflict (conversation_id, idempotency_key) do nothing
       returning id`,
      [conversationId, seq, sourceCommEventId || null, idem]
    )).rows[0];
    return { reopened: !!row };
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

  return { closeNotFit, reopen, linkTour, cancelTour, correctTourLink,
           maybeReopenOnQualifyingInbound, assertNotSoftClosedForTour,
           // exported for testing / reuse
           _internals: { lockConversation, nextSequence, currentClosureState, assertTourMatches } };
};
