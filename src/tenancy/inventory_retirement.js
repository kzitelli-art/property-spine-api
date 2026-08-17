// ════════════════════════════════════════════════════════════════════
//  inventory_retirement.js — RETAINED AS HISTORY, NOT CURRENT INVENTORY.
//
//  ── THE ONE RULE THIS MODULE OWNS ───────────────────────────────────
//  Retired inventory does not participate in current property position
//  reads. Historical provenance stays queryable.
//
//  Both halves matter. A unit promoted under an obsolete inventory
//  interpretation is wrong as current inventory and real as promotion
//  history, and the correction has to say both things at once. Deleting it
//  says only the first, and destroys the identity of what a recorded
//  promotion produced.
//
//  ── WHY THE PREDICATE LIVES HERE AND NOWHERE ELSE ───────────────────
//  `NOT_RETIRED_SQL` is exported and imported by the canonical tenancy
//  loader. One definition, because the moment "is it retired?" is written
//  twice the two answers drift, and they drift silently — a reader that
//  forgot the clause reports phantom inventory and looks perfectly fine
//  doing it.
//
//  ── WHAT THIS IS NOT ────────────────────────────────────────────────
//  Not a delete. Not a move to another property. Not `operating_use`.
//  Not a property, batch or address filter. Not anything Forward Leasing
//  knows about. The loader learns ONE general rule and every reader above
//  it inherits it.
//
//  CLASSIFICATION: Class 1 — permanent product primitive.
//  TRANSACTION: the CALLER owns begin/commit, matching
//  inventory_materialization.js and tenancy_anchor_service.
// ════════════════════════════════════════════════════════════════════

"use strict";

const REASON_SUPERSEDED_GRAIN = "superseded_by_corrected_inventory_grain";
const MIN_RATIONALE = 20;

/*  The one predicate. Correlates on a unit alias the caller names, so a
 *  loader can drop it into an existing FROM without restructuring.
 *
 *  Written as a NOT EXISTS rather than a LEFT JOIN deliberately: a join
 *  against a table with one live row per unit is safe today and would
 *  silently multiply rows the day retirement history is joined instead of
 *  the live view. This cannot.
 */
const NOT_RETIRED_SQL = (unitAlias = "u") =>
  `not exists (select 1 from inventory_retirements ir
                where ir.unit_id = ${unitAlias}.id and ir.reversed_at is null)`;

function err(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = (extra && extra.httpStatus) || 409;
  e.publicMessage = message;
  if (extra) Object.assign(e, extra);
  return e;
}

/*  retireInventoryUnits — record that these units are superseded.
 *
 *    client        an open pg client inside the caller's transaction
 *    property_id   server-derived; the units must belong to it
 *    unit_ids      the units to retire
 *    reason_code   governed vocabulary (one value today)
 *    rationale     why the current representation supersedes the old one
 *    superseded_by_import_batch_id  the batch that established the correct
 *                  representation — the citation, never a read predicate
 *    actor         { user_id } or { system } — one is required
 *
 *  REFUSES rather than guessing:
 *    · a unit that is not on this property (§21 — scope is not an argument
 *      the caller gets to be wrong about)
 *    · a unit that still carries a lease at ANY grain. A retired unit must
 *      not take live tenancy truth out of the reads with it.
 *    · a unit already live-retired (the replay is named, not silently
 *      duplicated into a second live row)
 *    · a rationale too short to be one
 *
 *  Idempotent by refusal, not by silence: re-running names the units that
 *  were already retired.
 */
async function retireInventoryUnits(client, {
  property_id, unit_ids = [], reason_code = REASON_SUPERSEDED_GRAIN,
  rationale = null, superseded_by_import_batch_id = null, actor = null,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("retireInventoryUnits requires a database client");
  }
  if (!property_id) throw new Error("retireInventoryUnits requires property_id");
  const ids = [...new Set((unit_ids || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("retireInventoryUnits requires at least one unit_id");

  const userId = actor && actor.user_id ? String(actor.user_id) : null;
  const system = actor && actor.system ? String(actor.system).trim() : null;
  if (!userId && !system) {
    throw err("RETIREMENT_ACTOR_REQUIRED",
      "A retirement must name who made the correction. Pass actor.user_id, or " +
      "actor.system for an automated correction that names itself.");
  }
  if (!rationale || String(rationale).trim().length < MIN_RATIONALE) {
    throw err("RETIREMENT_RATIONALE_REQUIRED",
      `A retirement must say why the current inventory supersedes the old ` +
      `representation, in at least ${MIN_RATIONALE} characters.`);
  }

  //  ── SCOPE IS DERIVED, NOT TRUSTED ────────────────────────────────
  const units = (await client.query(
    `select u.id, u.unit_number, u.property_id from units u where u.id = any($1::uuid[])`,
    [ids])).rows;
  const found = new Set(units.map((u) => String(u.id)));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) {
    throw err("UNIT_NOT_FOUND", `No such unit(s): ${missing.join(", ")}.`, { missing });
  }
  const foreign = units.filter((u) => String(u.property_id) !== String(property_id));
  if (foreign.length) {
    throw err("UNIT_NOT_ON_PROPERTY",
      `Unit(s) ${foreign.map((u) => u.unit_number).join(", ")} do not belong to this property. ` +
      `Retirement is scoped to the property it was authorised for.`,
      { unit_ids: foreign.map((u) => u.id) });
  }

  //  ── A RETIRED UNIT MUST NOT CARRY LIVE TENANCY TRUTH ─────────────
  //  If a lease is attached at any grain, retiring the unit would remove
  //  that lease's position from every current read. That is a tenancy
  //  question, not an inventory-representation question.
  const leased = (await client.query(
    `select u.unit_number, count(l.id)::int as leases
       from units u
       join spaces s on s.unit_id = u.id
       join leases l on l.space_id = s.id
      where u.id = any($1::uuid[])
      group by u.unit_number order by u.unit_number`, [ids])).rows;
  if (leased.length) {
    throw err("RETIREMENT_UNIT_CARRIES_LEASES",
      `Cannot retire inventory that still carries leases: ` +
      leased.map((r) => `${r.unit_number} (${r.leases})`).join(", ") +
      `. Resolve the tenancy first — retiring it would remove real lease positions ` +
      `from every current read.`,
      { held: leased });
  }

  const already = (await client.query(
    `select u.unit_number from inventory_retirements ir
       join units u on u.id = ir.unit_id
      where ir.unit_id = any($1::uuid[]) and ir.reversed_at is null
      order by u.unit_number`, [ids])).rows;
  if (already.length) {
    throw err("ALREADY_RETIRED",
      `Already retired: ${already.map((r) => r.unit_number).join(", ")}. ` +
      `Nothing was written.`, { already: already.map((r) => r.unit_number) });
  }

  //  ── LINEAGE CAPTURED AT RETIREMENT TIME ──────────────────────────
  //  ingest_candidates.promoted_unit_id is ON DELETE SET NULL, so it is
  //  not a durable record of what a promotion produced. Copy it now.
  const lineage = new Map((await client.query(
    `select ic.promoted_unit_id as unit_id, ic.id as candidate_id, ic.run_id
       from ingest_candidates ic
      where ic.promoted_unit_id = any($1::uuid[])`, [ids]))
    .rows.map((r) => [String(r.unit_id), r]));

  const written = [];
  for (const u of units) {
    const lin = lineage.get(String(u.id)) || {};
    const row = (await client.query(
      `insert into inventory_retirements
         (unit_id, property_id, retired_by_user_id, retired_by_system, reason_code,
          superseded_rationale, superseded_by_import_batch_id,
          promoted_from_candidate_id, promoted_from_ingest_run_id, original_unit_number)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       returning id, retired_at`,
      [u.id, property_id, userId, system, reason_code, String(rationale).trim(),
       superseded_by_import_batch_id, lin.candidate_id || null, lin.run_id || null,
       u.unit_number])).rows[0];
    written.push({
      retirement_id: row.id, unit_id: u.id, unit_number: u.unit_number,
      retired_at: row.retired_at,
      promoted_from_candidate_id: lin.candidate_id || null,
      promoted_from_ingest_run_id: lin.run_id || null,
    });
  }
  return { retired: written.length, rows: written, reason_code };
}

/*  reinstateInventoryUnit — undo one retirement, as history rather than by
 *  erasing it. The retirement row stays and records who reversed it.  */
async function reinstateInventoryUnit(client, { unit_id, actor = null, reason = null } = {}) {
  if (!unit_id) throw new Error("reinstateInventoryUnit requires unit_id");
  const userId = actor && actor.user_id ? String(actor.user_id) : null;
  if (!userId) {
    throw err("REINSTATEMENT_ACTOR_REQUIRED",
      "A reinstatement must name the person making it. A system actor is not " +
      "sufficient to put inventory back into current reads.");
  }
  if (!reason || !String(reason).trim()) {
    throw err("REINSTATEMENT_REASON_REQUIRED", "A reinstatement must say why.");
  }
  const r = await client.query(
    `update inventory_retirements
        set reversed_at = now(), reversed_by_user_id = $2, reversal_reason = $3
      where unit_id = $1 and reversed_at is null
      returning id`, [unit_id, userId, String(reason).trim()]);
  if (!r.rowCount) {
    throw err("NOT_RETIRED", "That unit has no live retirement to reverse.", { unit_id });
  }
  return { reinstated: true, retirement_id: r.rows[0].id };
}

/*  retirementProvenance — the second half of the rule, made reachable.
 *  "Historical provenance remains queryable" is only true if something
 *  queries it, so this is the read, not a comment promising one.  */
async function retirementProvenance(pool, { property_id }) {
  if (!property_id) throw new Error("retirementProvenance requires property_id");
  const rows = (await pool.query(
    `select ir.id, ir.unit_id, ir.original_unit_number, ir.retired_at,
            ir.retired_by_user_id, ir.retired_by_system, ir.reason_code,
            ir.superseded_rationale, ir.superseded_by_import_batch_id,
            ir.promoted_from_candidate_id, ir.promoted_from_ingest_run_id,
            ir.reversed_at,
            --  Proof the unit still exists. If this is ever null the
            --  ON DELETE RESTRICT was bypassed and the claim outlived its
            --  subject, which is the thing this table exists to prevent.
            u.id is not null as unit_still_exists,
            --  And proof the promotion receipt still points back.
            ic.id is not null as candidate_pointer_intact
       from inventory_retirements ir
       left join units u on u.id = ir.unit_id
       left join ingest_candidates ic
         on ic.id = ir.promoted_from_candidate_id and ic.promoted_unit_id = ir.unit_id
      where ir.property_id = $1
      order by ir.retired_at desc, ir.original_unit_number`, [property_id])).rows;

  const live = rows.filter((r) => !r.reversed_at);
  const runs = new Map();
  for (const r of live) {
    const k = String(r.promoted_from_ingest_run_id || "none");
    runs.set(k, (runs.get(k) || 0) + 1);
  }
  return {
    property_id,
    retired_now: live.length,
    reversed: rows.length - live.length,
    by_ingest_run: [...runs.entries()].map(([run_id, units]) => ({ run_id, units })),
    identity_preserved: live.every((r) => r.unit_still_exists),
    lineage_intact: live.every((r) => r.candidate_pointer_intact || !r.promoted_from_candidate_id),
    rows,
  };
}

module.exports = {
  retireInventoryUnits,
  reinstateInventoryUnit,
  retirementProvenance,
  NOT_RETIRED_SQL,
  REASON_SUPERSEDED_GRAIN,
};
