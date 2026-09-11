// ════════════════════════════════════════════════════════════════════
//  LEASING INVENTORY — leasing_inventory.js
//  Class 1 permanent primitive: grounded available-unit discovery and
//  governed unit attachment.
//  2026-09-10: exact_spaces mode is the prospect path. It composes the
//  existing application target and space-economics readers, then projects
//  preferences and budget. Results are informational, never selections.
//  legacy_units remains the compatibility default for historical direct
//  callers/tests. Class 2: remove that predicate when those callers have
//  migrated and the containment proof is replaced at the release checkpoint.
//  There is no fallback from exact-space failure into legacy inventory.
//
//  Offered != selected. Server-derived property scope applies to every read.
//  Exact selection is a separate correction to the existing attachment owner;
//  it is not enabled by returning an informational exact-space candidate.
// ════════════════════════════════════════════════════════════════════

module.exports = function leasingInventoryModule({ pool }) {

  //  availableUnits — the ONE query that answers "what could we offer?"
  //  property_id is SERVER-DERIVED by the caller (the conversation's
  //  property) — never model output, never client input.
  async function availableUnits({
    property_id, bedrooms = null, max_rent = null, bathrooms = null, limit = 5,
    requested_start = null, requested_end = null, lease_term_months = null,
    discovery_mode = "legacy_units",
  }, clientArg = null) {
    const q = clientArg || pool;
    if (!property_id) return { units: [], qualification: "no_property" };

    /*  ══ CONTAINMENT — FAIL CLOSED WITHOUT A TERM ═══════════════════
     *
     *  HISTORICAL LEGACY CONTAINMENT (exact_spaces branches below):
     *  This was the prospect-facing path: what came back was offered to a
     *  real person by the leasing agent. The predicate below is
     *  date-blind — it asks whether a unit is flagged vacant and carries
     *  no live lease at all — and a date-blind answer cannot know whether
     *  a position can support the term the prospect actually wants.
     *
     *  Measured, on constructed cases:
     *    · a unit flagged `vacant` with NO lease rows is offered with no
     *      dated check whatsoever — absence of lease data reads as
     *      availability
     *    · a by-bed unit with ONE leased bed is withheld entirely, so a
     *      genuinely free bed beside it is never offered
     *    · a bed free Aug–Dec with a January commitment is withheld for
     *      every term, including the ones it could serve
     *
     *  The blanket exclusion is the right patch over a missing date
     *  model. It is the wrong thing to keep now that the date model
     *  exists — and the wrong thing to REPLACE carelessly, because
     *  ANDing this with availability_read ("marketable NOW") would
     *  reject a unit that legitimately turns before a future start.
     *
     *  So until contractual interval + future operating readiness can
     *  compose into one governed prospect answer, this door FAILS
     *  CLOSED: no term, no inventory. Not an empty list — a REFUSAL with
     *  a sentence, because "nothing matches" and "I need your dates" are
     *  different facts and conflating them is the failure this whole
     *  slice exists to prevent.
     *
     *  FROZEN NO-DATE RULE. No default interval. Not today, not today
     *  for one day, not an implied school year. A named cycle is
     *  configuration resolved to dates ABOVE this function.
     *
     *  REMOVAL CONDITION for the whole date-blind predicate below:
     *  delete it once contractual interval + governed future operating
     *  readiness compose into the prospect-facing answer. See
     *  docs/archive/PROSPECT_INVENTORY_CUTOVER.md.  */
    if (!requested_start || !requested_end) {
      return {
        units: [],
        qualification: "term_required",
        may_promise: false,
        note: "Ask the prospect for their move-in and move-out dates. Inventory cannot be "
            + "discussed until the term is known — do not describe this as nothing being "
            + "available, because it is not an answer about inventory.",
      };
    }

    const { isValidYmd } = require("../applications/application_target_authority");
    if (typeof requested_start !== "string" || typeof requested_end !== "string"
        || !isValidYmd(requested_start) || !isValidYmd(requested_end)
        || requested_end <= requested_start) {
      return {
        units: [], qualification: "invalid_term", may_promise: false,
        note: "Ask for valid lease start and end dates, with the end after the start. These dates could not be checked; this is not an answer about availability.",
      };
    }

    if (discovery_mode === "exact_spaces") {
      const term = { requested_start, requested_end };
      const refused = (qualification, note) => ({ units: [], term, may_promise: false, qualification, note });
      if (lease_term_months == null) return refused("pricing_term_required",
        "The dates are recorded. Ask which published pricing term in months the prospect wants; do not infer it by rounding the dates or describe this as no homes matching.");
      if (typeof lease_term_months !== "number" || !Number.isInteger(lease_term_months) || lease_term_months <= 0) {
        return refused("invalid_pricing_term", "Ask for a valid pricing term in whole months. This is not an answer about inventory.");
      }
      for (const [value, whole] of [[bedrooms,true],[bathrooms,false],[max_rent,false]]) {
        if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (whole && !Number.isInteger(value)))) {
          return refused("invalid_preferences", "Clarify the bedroom count, bathroom count or monthly budget before matching homes.");
        }
      }
      // Existing application target owner composes contractual rights and
      // governed readiness. This projection owns no availability policy.
      let targets, shapes;
      try {
        targets = await require("../applications/application_target_read").leaseableApplicationTargets(q, { property_id, ...term });
        shapes = (await q.query(`select u.id, u.bedrooms, u.bathrooms, u.square_feet, s.id as space_id
          from units u join spaces s on s.unit_id=u.id
          where u.property_id=$1 and s.use_type='residential'`, [property_id])).rows;
      } catch (_) {
        return refused("term_check_unavailable", "Spine could not read the homes and check those dates. Confirm the inventory before discussing matches; this is not an empty inventory result.");
      }
      const bySpace = new Map(shapes.map(s => [String(s.space_id),s]));
      const matches = [], unresolved = [];
      for (const target of targets.eligible_targets) {
        const shape = bySpace.get(String(target.space_id));
        if (!shape) continue;
        if (bedrooms != null && (shape.bedrooms == null || Number(shape.bedrooms) !== bedrooms)) continue;
        if (bathrooms != null && (shape.bathrooms == null || Number(shape.bathrooms) < bathrooms)) continue;
        let economics;
        try {
          economics = await require("../money/effective_pricing").resolveSpaceEconomics(q, {
            property_id, space_id: target.space_id, lease_term_months,
          });
        } catch (_) {
          // No partial result may turn a failed pricing read into a claim that
          // all eligible homes were compared successfully.
          return refused("pricing_read_unavailable", "Spine could not read the published prices. Confirm pricing before quoting or claiming that nothing fits the budget.");
        }
        if (!economics.resolved) {
          unresolved.push({unit_number:target.unit_number,space_label:target.space_label,
            position_kind:target.position_kind,reason:economics.reason,published_terms:economics.published_terms || []});
          continue;
        }
        const rent = economics.rent.new_lease_rent;
        if (max_rent != null && rent > max_rent) continue;
        matches.push({id:target.unit_id,space_id:target.space_id,unit_number:target.unit_number,
          space_label:target.space_label,position_kind:target.position_kind,
          bedrooms:shape.bedrooms,bathrooms:shape.bathrooms,square_feet:shape.square_feet,
          dimensions_basis:"whole_unit",rent,rent_basis:target.position_kind === "bed" ? "per_bed_monthly" : "per_unit_monthly",
          pricing_intent:"new_lease",lease_term_months,authority:economics.authority,
          pricing_as_of:economics.as_of,pricing_status:"governed_published_pricing",
          marketing_state:target.marketing_state,availability_confidence:target.availability_confidence,
          available_from:target.available_from,requested_start,requested_end,selection_eligible:false});
      }
      matches.sort((a,b)=>a.rent-b.rent || String(a.unit_number).localeCompare(String(b.unit_number)) || String(a.space_label).localeCompare(String(b.space_label)));
      return {units:matches.slice(0,Math.min(Math.max(Number(limit)||5,1),10)),term,may_promise:false,
        qualification:unresolved.length ? "matching_incomplete_pricing_unresolved" : "exact_space_matches_informational",
        pricing_unresolved:unresolved,
        note:(unresolved.length ? "Some eligible homes lack resolved pricing for this term; this is an incomplete budget comparison. " : "")
          + (matches.length ? "These exact homes meet the recorded dates and monthly base-rent budget. Bed rent is per bed, not the whole apartment; bedroom count and dimensions describe the containing unit. " : "No priced home matched these criteria. ")
          + "These are informational options, not reservations or selections. Do not promise, hold or attach a home; staff must confirm the exact choice. Fees and concessions are not included in the base-rent budget comparison."};
    }

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
    /*  ══ THE CANONICAL TERM FILTER ══════════════════════════════════
     *  Every surviving unit is now put through the SAME interval read the
     *  operator's Forward Leasing surface uses. A unit stays only if it
     *  holds at least one rentable position that can support the WHOLE
     *  requested term. One truth, two projections (§40) — the agent does
     *  not get its own availability logic, and if it needed one, Slice 2
     *  was built wrong.
     *
     *  This runs AFTER the legacy predicate rather than replacing it, on
     *  purpose: the legacy predicate is over-suppressive, so composing
     *  them can only ever withhold more, never offer more. Removing it is
     *  step 4 of the cutover, not something to do inside a containment.  */
    const { intervalPropertyPositions } = require("../tenancy/dated_positions");
    let iv;
    try {
      iv = await intervalPropertyPositions(q, {
        property_id, requested_start, requested_end,
      });
    } catch (e) {
      //  A FAILED READ IS NOT AN EMPTY BUILDING AND NOT AN OFFER. If Spine
      //  cannot check the term, nothing may be offered for it.
      return {
        units: [], qualification: "term_check_unavailable", may_promise: false,
        note: "Spine could not check those dates just now. Do not offer or describe any unit; "
            + "tell the prospect you will confirm and come back to them.",
      };
    }
    const freeUnitIds = new Set(iv.positions
      .filter((p) => p.interval_state === "contractually_free")
      .map((p) => String(p.unit_id)));
    const survivors = rows.filter((u) => freeUnitIds.has(String(u.id)));

    return {
      units: survivors,
      //  ⚠ THE QUALIFICATION IS THE PRODUCT. It says exactly what was
      //  checked, and the name no longer claims availability.
      qualification: "contractually_free_for_term_readiness_unconfirmed",
      term: { requested_start, requested_end },
      /*  ⚠ may_promise IS FALSE, AND STAYS FALSE UNTIL READINESS IS
       *  GOVERNED. A surviving position is contractually open for those
       *  dates. Whether it will be PHYSICALLY ready by the requested start
       *  is not established anywhere in Spine — availability_read answers
       *  "marketable now" and deliberately refuses to infer readiness
       *  after a lease ends, because turnover duration is not a governed
       *  fact. So the agent may say the dates are open and must not say
       *  the unit is available.  */
      may_promise: false,
      note: survivors.length
        ? "These positions are contractually open for the requested dates. Physical readiness "
        + "by the move-in date is NOT confirmed — say the dates are open and that you will "
        + "confirm the unit itself. Do not promise, hold, or describe any unit as available."
        : "No position can support that entire term. Say so plainly and offer to note their "
        + "preferences or discuss different dates.",
      //  Carried so a receipt can show what the filter actually did.
      checked: {
        positions_examined: iv.count,
        positions_free_for_the_term: iv.positions.filter(
          (p) => p.interval_state === "contractually_free").length,
        units_before_term_filter: rows.length,
      },
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
  //    · one exact unit label, or an unambiguous affirmative choice of it;
  //    · if EXACTLY ONE unit was offered, a bare affirmative
  //      ("yes", "sure", "sounds good", "i'll take it", "book it",
  //       "interested") selects it;
  //    · anything else (ordinals against multiple options, vague
  //      interest) → null: the agent asks for explicit confirmation
  //      rather than the system guessing.
  function matchConfirmationToOffer(inboundText, offeredUnits) {
    const text = String(inboundText || "").trim().toLowerCase().replace(/[’]/g, "'");
    const offers = Array.isArray(offeredUnits) ? offeredUnits.filter(u => u.selection_eligible !== false) : [];
    if (!text || offers.length === 0) return null;
    // A mention is not a selection. Questions, negatives and conditional or
    // comparative replies need clarification; never let the first label win.
    // This remains the historical UNIT-interest writer, not exact-bed authority.
    if (/[?]/.test(text) || /\b(no|not|never|neither|don't|dont|do not|can't|cannot|won't|wouldn't|isn't|isnt|aren't|arent|without|except|unless|if|maybe|perhaps|or|but|instead)\b/.test(text)) return null;
    const cited = offers.filter(u => {
      const num = String(u.unit_number || "").toLowerCase();
      if (!num) return false;
      const re = new RegExp(`(^|[^a-z0-9])${num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
      return re.test(text);
    });
    if (cited.length > 1) return null;
    if (cited.length === 1) {
      const choice = cited[0];
      if (choice.space_id) return null; // unit attachment cannot preserve this identity
      const label = String(choice.unit_number).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exact = `(?:unit\\s+)?${label}`;
      // Deliberately a small explicit grammar. Unrecognized free language stays
      // in the conversation as evidence and is clarified, not guessed.
      const affirmative = new RegExp(`^(?:(?:yes|yeah|yep|sure)[, ]+)?(?:(?:i(?:'ll| will)? (?:take|choose|select|want)|let's (?:choose|select)|please (?:select|choose))\\s+)?${exact}[.!]*$`);
      return affirmative.test(text) ? choice : null;
    }
    // bare affirmative — only when exactly one option is on the table
    if (offers.length === 1 && !offers[0].space_id &&
        /^(yes|yeah|yep|sure|sounds good|works for me|i'?ll take it|book it|interested|let'?s do it)[.!]*$/.test(text)) {
      return offers[0];
    }
    return null;
  }

  return { availableUnits, attachSelectedUnit, matchConfirmationToOffer };
};
