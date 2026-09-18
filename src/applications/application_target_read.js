"use strict";

const applicationTargetAuthority = require("./application_target_authority");
const { availabilityRead } = require("../surfaces/availability_read");

const ymd = (value) => value ? String(value).slice(0, 10) : null;
/**
 * One exact application-target menu for every staff surface.
 *
 * This is a read adapter over the canonical availability and application-
 * target authorities. It owns no availability rule and makes no choice from
 * a multi-space menu.
 */
async function leaseableApplicationTargets(q, { property_id, requested_start = null, requested_end = null }) {
  if (!q || typeof q.query !== "function") {
    throw new Error("application target read requires a query client");
  }
  if (!property_id) {
    throw new Error("property_id is required");
  }
  const hasTerm = requested_start != null || requested_end != null;
  if (hasTerm && (typeof requested_start !== "string" || typeof requested_end !== "string"
      || !applicationTargetAuthority.isValidYmd(requested_start)
      || !applicationTargetAuthority.isValidYmd(requested_end) || requested_end <= requested_start)) {
    throw Object.assign(new Error("Provide valid lease start and end dates, with the end after the start."), {httpStatus:400});
  }

  const shapes = (await q.query(
    `select u.id as unit_id, u.unit_number,
            s.id as space_id, coalesce(s.space_label, '(whole unit)') as space_label,
            count(s.id) over (partition by u.id)::int as space_count
       from units u
       join spaces s on s.unit_id = u.id
      where u.property_id = $1
      order by u.unit_number asc, s.space_label asc nulls first, s.id asc`,
    [property_id]
  )).rows;

  const availability = await availabilityRead(q, { property_id });
  const bySpace = new Map(
    availability.rows.map((row) => [String(row.space_id), row])
  );

  const eligible_targets = [];
  const excluded_targets = [];
  const eligible_units = [];
  const intervalCache = new Map();

  for (const target of shapes) {
    const row = bySpace.get(String(target.space_id));
    if (!row) continue;
    const intendedMoveIn = requested_start || (applicationTargetAuthority.FUTURE_DATED_STATES.has(row.marketing_state)
      ? ymd(row.available_from)
      : null);
    const verdict = await applicationTargetAuthority.evaluateDatedOfferability(q, row, {
      property_id, interval_cache: intervalCache,
      intended_move_in: intendedMoveIn,
      requested_end,
    });
    const item = {
      unit_id: row.unit_id,
      unit_number: row.unit_number,
      space_id: row.space_id,
      rentable_space_count: target.space_count,
      position_kind: row.position_kind,
      space_label: row.space_label,
      marketing_state: row.marketing_state,
      available_from: row.available_from,
      intended_move_in: intendedMoveIn,
      requested_end,
      availability_confidence: row.availability_confidence,
      turnover: row.turnover || null,
      resolution_basis: target.space_count === 1 ? "sole_space_unit" : "chosen_space",
    };
    if (!verdict.offerable) {
      excluded_targets.push({
        ...item,
        offerable: false,
        refusal_code: verdict.refusal_code,
        refusal_reason: applicationTargetAuthority.REFUSAL_TEXT[verdict.refusal_code] || null,
        blocking_reason: row.blocking_reason || null,
      });
      continue;
    }
    item.resolved_space_id = row.space_id;
    eligible_targets.push(item);
    if (target.space_count === 1) eligible_units.push(item);
  }

  return {
    property_id,
    requested_start, requested_end,
    selection_basis: hasTerm ? "requested_term" : "discovery_without_prospect_term",
    eligible_target_count: eligible_targets.length,
    eligible_count: eligible_units.length,
    eligible_targets,
    excluded_targets,
    excluded_target_count: excluded_targets.length,
    eligible_units,
    unsupported_count: 0,
    unsupported_multi_space_units: [],
  };
}

module.exports = { leaseableApplicationTargets };
