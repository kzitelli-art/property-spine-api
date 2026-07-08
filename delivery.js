// ════════════════════════════════════════════════════════════════════
//  delivery.js — Slice D shared helper (the completion-feed).
//
//  The ONE place that feeds maintenance readiness into the PM-owned
//  move_in_delivery obligation. Lives OUTSIDE movein.js by ruling — the
//  movein.js hook is one thin call to satisfyDeliveryInput; all delivery
//  logic is here.
//
//  CONTRACT (ruling #4):
//    satisfyDeliveryInput(client, {
//      lease_id, input_key, source, source_obligation_id, actor, timestamp
//    })
//    → finds the OPEN move_in_delivery obligation for the lease
//      (related_id = lease_id, related_type='lease')
//    → satisfies the named input via the shared satisfyObligation helper
//    → IDEMPOTENT: re-fire does not double-satisfy
//    → NO-OP if no delivery obligation exists (legacy/manual move-in) — ruling #3
//    → DOES NOT mutate occupancy
//    → DOES NOT complete the delivery obligation (other gates may be open)
//
//  It never throws into the caller's transaction for a missing obligation —
//  a missing delivery obligation is a legitimate legacy state, not an error.
//
//  Also exposes spawnDeliveryObligation (used by confirm-term, Slice D 2B)
//  and completeDeliveryIfReady (completes only when ALL hard gates cleared).
//
//  CLASSIFICATION: Class 1 permanent primitive (the delivery correlation).
//
//  deps: { satisfyObligation, completeObligation, spawnObligationFromEvent, recordEvent }
//        — the same obligation helpers injected elsewhere; no pool needed
//        (all calls run inside the caller's client/transaction).
// ════════════════════════════════════════════════════════════════════

module.exports = function deliveryHelper(deps) {
  const { satisfyObligation, completeObligation } = deps || {};
  if (!satisfyObligation || !completeObligation) {
    throw new Error("delivery helper requires satisfyObligation + completeObligation");
  }

  // ── find the single open delivery obligation for a lease ──
  async function findOpenDelivery(client, lease_id) {
    const q = await client.query(
      `select * from obligations
        where related_id = $1 and related_type = 'lease'
          and type = 'move_in_delivery' and status in ('open','in_progress')
        order by created_at desc limit 1
        for update`,
      [lease_id]);
    return q.rows[0] || null;
  }

  // ── satisfy one delivery input; safe no-op when nothing to satisfy ──
  async function satisfyDeliveryInput(client, { lease_id, input_key, source = null,
                                                source_obligation_id = null, actor = null, timestamp = null }) {
    if (!lease_id || !input_key) {
      // nothing to resolve against — caller passed no lease link (legacy). No-op.
      return { satisfied: false, reason: "no lease_id/input_key", noop: true };
    }
    const delivery = await findOpenDelivery(client, lease_id);
    if (!delivery) {
      // legacy/manual move-in, or no delivery obligation for this lease. No-op,
      // nothing fatal — the caller's flow (readiness approval) must complete cleanly.
      return { satisfied: false, reason: "no open move_in_delivery obligation", noop: true };
    }
    const outstanding = delivery.required_inputs || [];
    if (!outstanding.includes(input_key)) {
      // already satisfied (or never a required input). Idempotent no-op.
      return { satisfied: false, reason: "input not outstanding (already satisfied or not required)",
               obligation_id: delivery.id, noop: true };
    }
    // satisfy via the shared obligation helper — records the input event.
    const proof = { source, source_obligation_id, actor, at: timestamp || new Date().toISOString() };
    await satisfyObligation(client, { obligation_id: delivery.id, input: input_key, proof });
    return { satisfied: true, obligation_id: delivery.id, input: input_key };
  }

  // ── complete the delivery obligation IF all hard gates are cleared ──
  // (called after a satisfy, or by a PM action; completes through the normal
  //  obligation path, which itself refuses if any required_input remains.)
  async function completeDeliveryIfReady(client, { lease_id, completed_by = null }) {
    const delivery = await findOpenDelivery(client, lease_id);
    if (!delivery) return { completed: false, reason: "no open delivery obligation", noop: true };
    const outstanding = delivery.required_inputs || [];
    if (outstanding.length > 0) {
      return { completed: false, reason: "hard gates remain", remaining: outstanding, obligation_id: delivery.id };
    }
    try {
      await completeObligation(client, { obligation_id: delivery.id, completed_by });
      return { completed: true, obligation_id: delivery.id };
    } catch (e) {
      if (e.code === "ALREADY_COMPLETE") return { completed: false, reason: "already complete", obligation_id: delivery.id };
      throw e;
    }
  }

  return { satisfyDeliveryInput, completeDeliveryIfReady, findOpenDelivery };
};
