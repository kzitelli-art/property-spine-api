/* ════════════════════════════════════════════════════════════════════
   technician/acceptance_service.js — THE canonical work-acceptance write.

   One place records "this technician has taken this work on." Every
   surface that ever offers acceptance — SMS, dashboard, a future app —
   calls this. There is no second path, and the eligibility decision is
   not re-implemented here: it imports the same pure module the offer used.

   ── SERVER-DERIVED AUTHORITY (§21) ──────────────────────────────────

   The caller passes a user id and an obligation id. It does NOT pass the
   property, the assignment, or the scope. This function reads the
   obligation and then reads the actor's OWN active assignments for that
   obligation's property, inside the same transaction, and refuses if the
   two do not meet. A caller that already resolved the scope cannot supply
   it here as authority — a scope that arrives as an argument is a request,
   not a fact.

   ── REPLAY SAFETY, IN TWO LAYERS ────────────────────────────────────

   `acceptance_key` is the inbound provider message id. A redelivery finds
   the obligation already accepted and returns `replayed` without writing.
   A CONCURRENT redelivery loses on uq_obligations_acceptance_key (23505)
   and is converted to the same `replayed` outcome. The second layer is
   the one that matters: the first depends on having read before the other
   transaction committed.

   ── WHAT IT RECORDS ─────────────────────────────────────────────────

   The obligation moves open -> in_progress with the accepter as its owner,
   and an immutable `events` row states who took it, when, and through
   which channel. The work order itself is NOT touched: acceptance is a
   fact about who owes the work, and work_orders.assigned_to is a free-text
   column this slice will not start writing meaning into.

   ── WHAT IT DOES NOT DO ─────────────────────────────────────────────

   It sends nothing. Operations lines carry outbound_enabled = false under
   ck_cl_outbound_disabled_slice_a. Recording an acceptance and telling the
   technician about it are two facts; this records the first and states
   plainly that the second did not happen.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { acceptanceEligibility, WorkSelectionError } = require("./work_selection");

const ACCEPTANCE_OUTCOMES = ["accepted", "replayed", "refused"];

function acceptanceError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/*  The actor's OWN active assignments for one property, inside this
 *  organization. Read here, never accepted as an argument. */
async function actorScopeFor(client, { userId, organizationId, propertyId }) {
  const { rows } = await client.query(
    `select p.id
       from property_team_assignments pta
       join properties p
         on p.id = pta.property_id and p.organization_id = $3
      where pta.user_id = $1 and pta.active = true and pta.property_id = $2`,
    [userId, propertyId, organizationId]);
  return rows.map((r) => r.id);
}

/*  acceptWork — the whole of it. Runs inside a transaction the caller owns,
 *  so an acceptance and whatever the caller records alongside it commit or
 *  roll back together.
 */
async function acceptWork(client, { obligation_id, user_id, organization_id, acceptance_key = null, channel = null } = {}) {
  if (!obligation_id) throw acceptanceError("BAD_INPUT", "obligation_id is required");
  if (!user_id) throw acceptanceError("BAD_INPUT", "user_id is required");
  if (!organization_id) {
    throw acceptanceError("BAD_INPUT",
      "organization_id is required — acceptance is always scoped to the organization the line established");
  }

  //  LOCK FIRST. Everything below decides against the row as it is now, not
  //  as it was when the technician was offered it.
  const o = await client.query("select * from obligations where id = $1 for update", [obligation_id]);
  if (o.rows.length === 0) throw acceptanceError("NOT_FOUND", "obligation not found");
  const ob = o.rows[0];

  //  An already-recorded key on THIS obligation, from THIS actor, is the same
  //  message arriving twice. Nothing to do, and nothing wrong.
  if (acceptance_key && ob.acceptance_key === acceptance_key && ob.accepted_by_user_id === user_id) {
    return { outcome: "replayed", obligation: ob, event: null, refusal: null };
  }

  //  SERVER-DERIVED SCOPE. Read, not accepted.
  const assignedPropertyIds = await actorScopeFor(client,
    { userId: user_id, organizationId: organization_id, propertyId: ob.property_id });

  const verdict = acceptanceEligibility({
    actor: { userId: user_id, organizationId: organization_id, assignedPropertyIds },
    row: {
      obligation_id: ob.id,
      work_order_id: ob.related_type === "work_order" ? ob.related_id : null,
      related_type: ob.related_type,
      property_id: ob.property_id,
      assigned_user_id: ob.assigned_user_id,
      accepted_by_user_id: ob.accepted_by_user_id,
      status: ob.status,
    },
  });

  //  The same person, again. Report it as a replay rather than a refusal:
  //  the world already matches what they asked for.
  if (verdict.isNoop) return { outcome: "replayed", obligation: ob, event: null, refusal: verdict.verdict };
  if (!verdict.eligible) return { outcome: "refused", obligation: null, event: null, refusal: verdict.verdict };

  let updated;
  try {
    updated = (await client.query(
      `update obligations
          set status = 'in_progress',
              assigned_user_id     = $2,
              accepted_by_user_id  = $2,
              accepted_at          = now(),
              acceptance_key       = $3,
              ownership_origin     = 'accepted_by_owner',
              updated_at           = now()
        where id = $1 and status = 'open' and accepted_at is null
      returning *`,
      [obligation_id, user_id, acceptance_key])).rows[0];
  } catch (e) {
    //  A concurrent redelivery got there first. The database refused the
    //  duplicate key; the honest report is that this message changed nothing.
    if (e.code === "23505") {
      const now = (await client.query("select * from obligations where id = $1", [obligation_id])).rows[0];
      return { outcome: "replayed", obligation: now, event: null, refusal: "acceptance_key_already_used" };
    }
    throw e;
  }

  //  The guarded UPDATE matched nothing: someone accepted between the lock
  //  and the write. Impossible under `for update` on this row, and refused
  //  rather than assumed away if it ever becomes possible.
  if (!updated) {
    return { outcome: "refused", obligation: null, event: null, refusal: "state_changed_before_write" };
  }

  const event = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'work_accepted',$4) returning id, occurred_at`,
    [ob.property_id, ob.person_id, ob.unit_id,
     JSON.stringify({
       obligation_id,
       work_order_id: ob.related_type === "work_order" ? ob.related_id : null,
       accepted_by_user_id: user_id,
       organization_id,
       channel: channel || null,
       acceptance_key: acceptance_key || null,
       from_status: "open", to_status: "in_progress",
     })])).rows[0];

  return { outcome: "accepted", obligation: updated, event, refusal: null };
}

module.exports = { ACCEPTANCE_OUTCOMES, acceptWork, acceptanceError, WorkSelectionError };
