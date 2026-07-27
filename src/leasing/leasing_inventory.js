// ════════════════════════════════════════════════════════════════════
//  LEASING INVENTORY — leasing_inventory.js
//  Class 1 permanent primitive: grounded available-unit discovery and
//  governed unit attachment.
//
//  THE DISTINCTIONS THIS MODULE EXISTS TO KEEP (the product):
//    available ≠ merely believed-available — availability here means the
//      canonical columns say vacant AND not down. If richer states exist
//      later (holds, pending applications, readiness), they join HERE.
//    offered   ≠ selected — this module never attaches a unit because the
//      agent mentioned it; attachment requires the prospect's own
//      confirming words matched against the durable offered set.
//    Demo-shaped ≠ Solo history — property scope is server-derived on
//      every query; no cross-property read or write can pass the wall.
//
//  CURRENT AVAILABILITY SEMANTICS (named, not overstated):
//    offerable_now = occupancy_status='vacant' AND is_down=false.
//    Reservation / hold / pending-application / readiness exclusions are
//    NOT yet modeled in the canonical schema — callers and receipts must
//    say "vacant and not down," never imply more. When those states gain
//    canonical columns, THIS function is where they are enforced.
// ════════════════════════════════════════════════════════════════════

module.exports = function leasingInventoryModule({ pool }) {

  //  availableUnits — the ONE query that answers "what could we offer?"
  //  property_id is SERVER-DERIVED by the caller (the conversation's
  //  property) — never model output, never client input.
  async function availableUnits({ property_id, bedrooms = null, max_rent = null, bathrooms = null, limit = 5 }, clientArg = null) {
    const q = clientArg || pool;
    if (!property_id) return { units: [], qualification: "no_property" };
    const params = [property_id];
    // RESIDENTIAL SHAPE GUARD (owner decision, 2026-07-27). `units` carries
    // non-apartment rows — the property's commercial space is one (7,391 sq ft,
    // market_rent 0.00). Nothing in the vacancy predicate says "residential", so
    // that row was excluded only by its occupancy_status happening to be
    // 'unknown'. If a status edit or an import normalized it to 'vacant', it
    // would sort FIRST (results order by market_rent asc) and become the top
    // unit offered to a residential prospect, passing any max_rent filter.
    // bedrooms IS the residential shape: on Demo Building the commercial row is
    // the ONLY row with a null bedrooms, so this guard excludes it and nothing
    // else. A leaseable apartment always knows its bedroom count.
    // COMMITTED-SPACE GUARD (owner decision, 2026-07-27). occupancy_status is
    // not proof a unit is free to promise. Unit 530 was quoted as available in
    // nine outbound texts while carrying a lease that had already STARTED
    // (status 'pending', start 2026-07-24, from a historical_snapshot import).
    // Either the lease or the vacancy flag is wrong, and we do not yet know
    // which — so the unit comes out of customer-facing availability until an
    // operator says which one is true. Its rent is deliberately NOT changed.
    //
    // Stated as a general rule, never `if unit = 530` (§22 Solo-first, never
    // Solo-special): a space that carries a live lease is not offerable.
    // The list is a NOT-IN of dead statuses rather than an IN of live ones, so
    // it FAILS CLOSED — a status nobody anticipated withholds the unit instead
    // of offering one that is already committed (§5 honest blank beats
    // confident wrong). Vocabulary matches application_review.js:261.
    let where = `property_id = $1 and occupancy_status = 'vacant' and coalesce(is_down,false) = false
                 and bedrooms is not null
                 and not exists (
                   select 1 from spaces sp
                     join leases lz on lz.space_id = sp.id
                    where sp.unit_id = units.id
                      and lz.lease_status not in
                          ('cancelled','rescinded','void','superseded','terminated','expired')
                 )`;
    if (bedrooms != null && Number.isFinite(Number(bedrooms))) {
      params.push(Number(bedrooms)); where += ` and bedrooms = $${params.length}`;
    }
    if (bathrooms != null && Number.isFinite(Number(bathrooms))) {
      params.push(Number(bathrooms)); where += ` and bathrooms >= $${params.length}`;
    }
    if (max_rent != null && Number.isFinite(Number(max_rent))) {
      params.push(Number(max_rent)); where += ` and market_rent <= $${params.length}`;
    }
    params.push(Math.min(Math.max(Number(limit) || 5, 1), 10));
    const rows = (await q.query(
      `select id, unit_number, bedrooms, bathrooms, square_feet, market_rent
         from units where ${where}
        order by market_rent asc nulls last, unit_number asc
        limit $${params.length}`, params
    )).rows;
    return {
      units: rows,
      // honest qualification: what "available" means TODAY
      qualification: "vacant_not_down",
    };
  }

  //  attachSelectedUnit — the governed write that turns the prospect's
  //  confirmed choice into operating truth on the lead.
  //  PROPERTY WALL: the unit must belong to the server-authorized
  //  property. A supplied UUID from another asset is refused, always.
  //  coalesce preserves an already-chosen unit (no silent overwrite).
  async function attachSelectedUnit({ property_id, person_id, unit_id }, clientArg = null) {
    const q = clientArg || pool;
    if (!property_id || !person_id || !unit_id) {
      return { attached: false, reason: "missing_required_context" };
    }
    // wall first
    const u = (await q.query(
      `select id, property_id, unit_number, occupancy_status, coalesce(is_down,false) as is_down
         from units where id = $1`, [unit_id]
    )).rows[0];
    if (!u) return { attached: false, reason: "unit_not_found" };
    // OFFERED EARLIER ≠ STILL AVAILABLE NOW: re-qualify at the moment of
    // attachment with the same test discovery used. A unit that went
    // occupied/down since the offer attaches nothing; the agent is told
    // honestly instead.
    if (u.occupancy_status !== "vacant" || u.is_down) {
      return { attached: false, reason: "unit_no_longer_available", unit_number: u.unit_number };
    }
    if (u.property_id !== property_id) {
      console.error(`leasing_inventory: PROPERTY WALL refused attach — unit ${unit_id} belongs to ${u.property_id}, not ${property_id}.`);
      return { attached: false, reason: "unit_outside_property" };
    }
    const lead = (await q.query(
      `select id, unit_id from leasing_leads
        where person_id = $1 and property_id = $2
        order by created_at desc limit 1`,
      [person_id, property_id]
    )).rows[0];
    if (!lead) return { attached: false, reason: "no_lead_for_person_property" };
    if (lead.unit_id) {
      // coalesce semantics: never silently overwrite a prior choice
      return { attached: false, reason: "lead_already_has_unit", existing_unit_id: lead.unit_id };
    }
    await q.query(
      `update leasing_leads set unit_id = coalesce(unit_id, $1), updated_at = now() where id = $2`,
      [unit_id, lead.id]
    );
    return { attached: true, lead_id: lead.id, unit_id, unit_number: u.unit_number };
  }

  //  matchConfirmationToOffer — deterministic offered→selected matcher.
  //  Given the prospect's inbound text and the durable offered set from
  //  the prior run, return the ONE unit their words confirm — or null.
  //  Rules (conservative by design; ambiguity never guesses):
  //    · a unit_number cited with word boundaries matches that unit;
  //    · if EXACTLY ONE unit was offered, a bare affirmative
  //      ("yes", "sure", "sounds good", "i'll take it", "book it",
  //       "interested") selects it;
  //    · anything else (ordinals against multiple options, vague
  //      interest) → null: the agent asks for explicit confirmation
  //      rather than the system guessing.
  function matchConfirmationToOffer(inboundText, offeredUnits) {
    const text = String(inboundText || "").toLowerCase();
    const offers = Array.isArray(offeredUnits) ? offeredUnits : [];
    if (!text || offers.length === 0) return null;
    // explicit unit-number citation
    for (const u of offers) {
      const num = String(u.unit_number || "").toLowerCase();
      if (!num) continue;
      const re = new RegExp(`(^|[^a-z0-9])${num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
      if (re.test(text)) return u;
    }
    // bare affirmative — only when exactly one option is on the table
    if (offers.length === 1 &&
        /\b(yes|yeah|yep|sure|sounds good|works for me|i'?ll take it|book it|interested|let'?s do it)\b/.test(text)) {
      return offers[0];
    }
    return null;
  }

  return { availableUnits, attachSelectedUnit, matchConfirmationToOffer };
};
