// ════════════════════════════════════════════════════════════════════
//  turn_priority.js — the shared Turn-Priority ranking (one source of truth).
//
//  A READ. Ranks in_progress turnovers for a property by WHY each matters,
//  with a plain-language reason shown verbatim — NEVER a score. The demand
//  tier is numeric ONLY for sorting; it is never surfaced as points.
//
//    tier 3  hard_delivery   an open move_in_delivery obligation on a PENDING
//                            lease whose space is in this unit — a signed lease
//                            is waiting on this turn. (2nd sort: soonest due_at)
//    tier 2  applicant_demand an OPEN application references this unit.
//    tier 1  raw_vacancy      neither — frees supply with no demand attached.
//
//  Extracted so the query-param route (turnovers.js) and the session-scoped
//  operator route (operator.js /operator/leasing/turn-priority) share ONE
//  ranking, never two copies that could drift.
//
//  rankTurnPriority(pool, property_id) → { property_id, count, note, turns }
//  CLASSIFICATION: Class 1 permanent primitive (the ranking read). No writes.
// ════════════════════════════════════════════════════════════════════

async function rankTurnPriority(pool, property_id) {
  const r = await pool.query(
    `select
        t.id                as turnover_id,
        t.unit_id,
        t.status,
        t.ready_date,
        t.needs,
        t.moveout_photos,
        t.deposit_review,
        u.unit_number       as unit_label,
        d.delivery_obligation_id,
        d.delivery_due_at,
        d.delivery_priority,
        d.delivery_severity,
        d.incoming_applicant,
        ap.open_application_id
     from turnovers t
     left join units u on u.id = t.unit_id
     left join lateral (
        select ob.id as delivery_obligation_id, ob.due_at as delivery_due_at,
               ob.priority as delivery_priority, ob.severity as delivery_severity,
               la.applicant_name as incoming_applicant
          from leases l
          join spaces s on s.id = l.space_id and s.unit_id = t.unit_id
          join obligations ob on ob.related_id = l.id and ob.related_type='lease'
               and ob.type='move_in_delivery' and ob.status in ('open','in_progress')
          left join lease_applications la on la.id = l.application_id
         where l.lease_status = 'pending'
         order by ob.due_at asc nulls last limit 1
     ) d on true
     left join lateral (
        select la.id as open_application_id
          from lease_applications la
         where la.unit_id = t.unit_id
           and la.status in ('submitted','tenant_signed','lease_ready','accepted_term_required')
         order by la.created_at desc nulls last limit 1
     ) ap on true
     where t.property_id = $1 and t.status = 'in_progress'`,
    [property_id]);

  const fmtDate = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

  const ranked = r.rows.map(row => {
    let tier, tier_key, reason;
    if (row.delivery_obligation_id) {
      tier = 3; tier_key = "hard_delivery";
      const due = fmtDate(row.delivery_due_at);
      const who = row.incoming_applicant ? ` for ${row.incoming_applicant}` : "";
      reason = `A signed lease is waiting on this turn${who}${due ? ` — move-in ${due}` : ""}. Finishing this releases a committed unit.`;
    } else if (row.open_application_id) {
      tier = 2; tier_key = "applicant_demand";
      reason = "An open application wants this unit. Demand is real but not yet a signed lease.";
    } else {
      tier = 1; tier_key = "raw_vacancy";
      reason = "Turn frees available supply — no application or lease attached yet.";
    }
    return {
      turnover_id: row.turnover_id,
      unit_id: row.unit_id,
      unit_label: row.unit_label,
      status: row.status,
      ready_date: fmtDate(row.ready_date),
      needs: row.needs,
      gates: { moveout_photos: row.moveout_photos, deposit_review: row.deposit_review },
      demand_tier: tier,                 // numeric ONLY for sort; not shown as a score
      demand_tier_key: tier_key,         // the machine label
      delivery: row.delivery_obligation_id ? {
        obligation_id: row.delivery_obligation_id,
        due_at: fmtDate(row.delivery_due_at),
        priority: row.delivery_priority,
        severity: row.delivery_severity,
        incoming_applicant: row.incoming_applicant,
      } : null,
      reason,                            // plain-language, shown verbatim
    };
  });

  ranked.sort((a, b) => {
    if (b.demand_tier !== a.demand_tier) return b.demand_tier - a.demand_tier;
    const ad = a.delivery && a.delivery.due_at ? a.delivery.due_at : "9999-12-31";
    const bd = b.delivery && b.delivery.due_at ? b.delivery.due_at : "9999-12-31";
    if (ad !== bd) return ad < bd ? -1 : 1;
    const ar = a.ready_date || "9999-12-31", br = b.ready_date || "9999-12-31";
    return ar < br ? -1 : ar > br ? 1 : 0;
  });

  return {
    property_id,
    count: ranked.length,
    note: "In-progress turns ranked by why each matters: a committed lease waiting beats open demand beats raw vacancy. The order is a demand tier, not a score — the reason on each turn says why it sits where it does.",
    turns: ranked,
  };
}

module.exports = { rankTurnPriority };
