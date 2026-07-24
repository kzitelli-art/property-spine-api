// ═══════════════════════════════════════════════════════════════════════════
// delivery.js — MOVE-IN DELIVERY CORRELATION
//
// One PM-owned delivery obligation carries readiness gates. Preparation and
// handoff are deliberately different truths:
//   unit_ready        — maintenance/PM proved the premises ready
//   keys_access_ready — PM proved keys/access were prepared
//   possession        — an authenticated human actually handed access over
//
// The obligation may complete only after BOTH hard gates are clear AND a live,
// space-anchored move_in event exists for the lease. This prevents the old
// sequence from declaring delivery complete before the resident took access.
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function deliveryHelper(deps) {
  const { satisfyObligation, completeObligation } = deps || {};
  if (typeof satisfyObligation !== "function" || typeof completeObligation !== "function") {
    throw new Error("delivery helper requires satisfyObligation + completeObligation");
  }

  async function findOpenDelivery(client, lease_id) {
    const q = await client.query(
      `select * from obligations
        where related_id=$1 and related_type='lease'
          and type='move_in_delivery' and status in ('open','in_progress')
        order by created_at desc limit 1
        for update`,
      [lease_id]
    );
    return q.rows[0] || null;
  }

  async function findLatestDelivery(client, lease_id) {
    const q = await client.query(
      `select * from obligations
        where related_id=$1 and related_type='lease'
          and type='move_in_delivery'
        order by created_at desc limit 1`,
      [lease_id]
    );
    return q.rows[0] || null;
  }

  async function hasEffectivePossession(client, lease_id) {
    const q = await client.query(
      `select ue.id, ue.space_id, ue.effective_date, ue.created_at, ue.payload, ue.source
         from unit_events ue
        where ue.lease_id=$1 and ue.event_type='move_in'
          and ue.status not in ('superseded','cancelled')
          and not exists (
            select 1 from unit_events out_ev
             where out_ev.lease_id=ue.lease_id
               and out_ev.space_id=ue.space_id
               and out_ev.event_type='move_out'
               and out_ev.status not in ('superseded','cancelled')
               and (out_ev.effective_date > ue.effective_date
                    or (out_ev.effective_date = ue.effective_date and out_ev.created_at > ue.created_at))
          )
        order by ue.effective_date desc, ue.created_at desc
        limit 1`,
      [lease_id]
    );
    return q.rows[0] || null;
  }

  async function satisfyDeliveryInput(client, {
    lease_id,
    input_key,
    source = null,
    source_obligation_id = null,
    actor = null,
    timestamp = null,
    proof_extra = null,
  }) {
    if (!lease_id || !input_key) {
      return { satisfied: false, reason: "no lease_id/input_key", noop: true };
    }
    const delivery = await findOpenDelivery(client, lease_id);
    if (!delivery) {
      return { satisfied: false, reason: "no open move_in_delivery obligation", noop: true };
    }
    const outstanding = Array.isArray(delivery.required_inputs) ? delivery.required_inputs : [];
    if (!outstanding.includes(input_key)) {
      return {
        satisfied: false,
        reason: "input not outstanding (already satisfied or not required)",
        obligation_id: delivery.id,
        noop: true,
      };
    }
    const proof = {
      source,
      source_obligation_id,
      actor,
      at: timestamp || new Date().toISOString(),
      ...(proof_extra && typeof proof_extra === "object" ? proof_extra : {}),
    };
    await satisfyObligation(client, { obligation_id: delivery.id, input: input_key, proof });
    return { satisfied: true, obligation_id: delivery.id, input: input_key };
  }

  async function completeDeliveryIfReady(client, { lease_id, completed_by = null }) {
    const delivery = await findOpenDelivery(client, lease_id);
    if (!delivery) {
      const latest = await findLatestDelivery(client, lease_id);
      if (latest && latest.status === "complete") {
        return { completed: false, reason: "already complete", obligation_id: latest.id, noop: true };
      }
      return { completed: false, reason: "no open delivery obligation", noop: true };
    }
    const outstanding = Array.isArray(delivery.required_inputs) ? delivery.required_inputs : [];
    if (outstanding.length > 0) {
      return {
        completed: false,
        reason: "hard gates remain",
        remaining: outstanding,
        obligation_id: delivery.id,
      };
    }

    const possession = await hasEffectivePossession(client, lease_id);
    if (!possession) {
      return {
        completed: false,
        reason: "possession_outstanding",
        obligation_id: delivery.id,
        remaining: ["keys_handed_over"],
      };
    }

    try {
      await completeObligation(client, { obligation_id: delivery.id, completed_by });
      return { completed: true, obligation_id: delivery.id, possession_event_id: possession.id };
    } catch (e) {
      if (e.code === "ALREADY_COMPLETE") {
        return { completed: false, reason: "already complete", obligation_id: delivery.id };
      }
      throw e;
    }
  }

  return {
    satisfyDeliveryInput,
    completeDeliveryIfReady,
    findOpenDelivery,
    findLatestDelivery,
    hasEffectivePossession,
  };
};
