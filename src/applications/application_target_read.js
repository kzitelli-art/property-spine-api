"use strict";

const applicationTargetAuthority = require("./application_target_authority");
const { availabilityRead } = require("../surfaces/availability_read");

const ymd = (value) => value ? String(value).slice(0, 10) : null;
function dateGapDays(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(ymd(from) + "T00:00:00Z");
  const b = Date.parse(ymd(to) + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * One exact application-target menu for every staff surface.
 *
 * This is a read adapter over the canonical availability and application-
 * target authorities. It owns no availability rule and makes no choice from
 * a multi-space menu.
 */
async function leaseableApplicationTargets(q, { property_id }) {
  if (!q || typeof q.query !== "function") {
    throw new Error("application target read requires a query client");
  }
  if (!property_id) {
    throw new Error("property_id is required");
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
  const eligible_units = [];

  for (const target of shapes) {
    const row = bySpace.get(String(target.space_id));
    if (!row) continue;
    const intendedMoveIn = applicationTargetAuthority.FUTURE_DATED_STATES.has(row.marketing_state)
      ? ymd(row.available_from)
      : null;
    const verdict = applicationTargetAuthority.evaluateOfferability(row, {
      intended_move_in: intendedMoveIn,
    });
    if (!verdict.offerable) continue;

    const item = {
      unit_id: row.unit_id,
      unit_number: row.unit_number,
      space_id: row.space_id,
      resolved_space_id: row.space_id,
      rentable_space_count: target.space_count,
      position_kind: row.position_kind,
      space_label: row.space_label,
      marketing_state: row.marketing_state,
      available_from: row.available_from,
      intended_move_in: intendedMoveIn,
      availability_confidence: row.availability_confidence,
      turnover: row.turnover ? {
        ...row.turnover,
        turn_gap_days: dateGapDays(
          row.turnover.outgoing_lease_end_date,
          intendedMoveIn
        ),
      } : null,
      resolution_basis: target.space_count === 1 ? "sole_space_unit" : "chosen_space",
    };
    eligible_targets.push(item);
    if (target.space_count === 1) eligible_units.push(item);
  }

  return {
    property_id,
    eligible_target_count: eligible_targets.length,
    eligible_count: eligible_units.length,
    eligible_targets,
    eligible_units,
    unsupported_count: 0,
    unsupported_multi_space_units: [],
  };
}

module.exports = { leaseableApplicationTargets };
