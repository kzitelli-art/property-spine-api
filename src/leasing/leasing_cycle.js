/* ════════════════════════════════════════════════════════════════════
   leasing_cycle.js — A NAMED CYCLE IS CONFIGURATION OVER DATES

       "2026–27"  →  2026-08-01 → 2027-07-31

   That is the whole job. It exists so Mike does not retype two dates
   every time he opens the surface, and NOTHING below it learns the word
   "cycle": the resolver turns a label into an interval ABOVE the reads,
   and `src/tenancy` keeps receiving a pair of dates exactly as before
   (PHASE_1_NORTH_STAR forbidding-clause 2).

   ── IT REFUSES RATHER THAN CHOOSING ─────────────────────────────────
   Which cycle is current is `cycle_start <= today <= cycle_end`, computed,
   never a stored flag that can rot. If that matches more than one live
   cycle the resolver REFUSES and names them. A property mid-transition
   between term structures is a real situation and picking the newest row
   would answer a question nobody asked.

   ── IT STORES NO DERIVED FIGURE ─────────────────────────────────────
   No committed count, no preleased percentage, no `semester`. Every one
   of those is computed from `leases` on read; storing one creates a
   second answer that goes stale the moment a lease moves.

   READ + a narrow governed writer. No lease is ever touched here.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function refuse(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  e.publicMessage = message;
  Object.assign(e, extra);
  return e;
}

/*  ── ESTABLISH ───────────────────────────────────────────────────────
 *  A cycle is a decision, so it records who made it. Correcting one
 *  SUPERSEDES rather than overwrites: every figure ever derived from the
 *  old dates stays explainable. */
async function establishLeasingCycle(client, {
  property_id, cycle_label, cycle_start, cycle_end,
  established_by_user_id = null, supersedes_cycle_id = null, note = null,
} = {}) {
  if (!property_id) throw refuse("property_required", "A leasing cycle belongs to a property.");
  if (!cycle_label || !String(cycle_label).trim()) {
    throw refuse("label_required", "A leasing cycle needs the name a person calls it.");
  }
  for (const [n, v] of [["cycle_start", cycle_start], ["cycle_end", cycle_end]]) {
    if (!v || !ISO.test(String(v))) {
      throw refuse("invalid_cycle_date", `${n} must be a real calendar date in YYYY-MM-DD form.`);
    }
  }
  if (String(cycle_end) <= String(cycle_start)) {
    throw refuse("invalid_cycle", "cycle_end must be after cycle_start.");
  }

  if (supersedes_cycle_id) {
    const prior = (await client.query(
      `select id, state from property_leasing_cycles where id=$1 and property_id=$2`,
      [supersedes_cycle_id, property_id])).rows[0];
    if (!prior) throw refuse("supersedes_not_found", "The cycle being superseded is not on this property.");
    if (prior.state !== "active") {
      throw refuse("supersedes_not_active", "Only a live cycle can be superseded.");
    }
  }

  const row = (await client.query(
    `insert into property_leasing_cycles
       (property_id, cycle_label, cycle_start, cycle_end,
        supersedes_cycle_id, established_by_user_id, note)
     values ($1,$2,$3::date,$4::date,$5,$6,$7)
     returning id, cycle_label,
               to_char(cycle_start,'YYYY-MM-DD') as cycle_start,
               to_char(cycle_end,'YYYY-MM-DD')   as cycle_end, state`,
    [property_id, String(cycle_label).trim(), cycle_start, cycle_end,
      supersedes_cycle_id, established_by_user_id, note])).rows[0];

  if (supersedes_cycle_id) {
    //  Same transaction as the insert, so there is never a window with
    //  two live cycles carrying the same meaning.
    await client.query(
      `update property_leasing_cycles
          set state='superseded', superseded_by_id=$1, updated_at=now()
        where id=$2`, [row.id, supersedes_cycle_id]);
  }
  return row;
}

/*  ── LIST ─────────────────────────────────────────────────────────── */
async function listLeasingCycles(client, { property_id, include_retired = false } = {}) {
  if (!property_id) throw refuse("property_required", "listLeasingCycles requires property_id");
  const { rows } = await client.query(
    `select id, cycle_label, state,
            to_char(cycle_start,'YYYY-MM-DD') as cycle_start,
            to_char(cycle_end,'YYYY-MM-DD')   as cycle_end,
            established_at, note
       from property_leasing_cycles
      where property_id = $1 ${include_retired ? "" : "and state = 'active'"}
      order by cycle_start desc`, [property_id]);
  return rows;
}

/*  ── RESOLVE ─────────────────────────────────────────────────────────
 *  label → interval, or (with no label) the cycle covering `as_of`.
 *
 *  Returns a shape carrying WHY these dates were chosen, so a surface can
 *  say "2026–27 (configured)" rather than presenting two dates as if the
 *  operator typed them. */
async function resolveCycle(client, { property_id, cycle_label = null, as_of = null } = {}) {
  if (!property_id) throw refuse("property_required", "resolveCycle requires property_id");
  const today = as_of && ISO.test(String(as_of)) ? String(as_of) : new Date().toISOString().slice(0, 10);

  if (cycle_label) {
    const { rows } = await client.query(
      `select id, cycle_label,
              to_char(cycle_start,'YYYY-MM-DD') as cycle_start,
              to_char(cycle_end,'YYYY-MM-DD')   as cycle_end
         from property_leasing_cycles
        where property_id=$1 and state='active'
          and lower(trim(cycle_label)) = lower(trim($2))`, [property_id, cycle_label]);
    if (!rows.length) {
      throw refuse("cycle_not_found",
        `This property has no leasing cycle named "${cycle_label}".`);
    }
    return { ...rows[0], resolved_by: "label" };
  }

  const { rows } = await client.query(
    `select id, cycle_label,
            to_char(cycle_start,'YYYY-MM-DD') as cycle_start,
            to_char(cycle_end,'YYYY-MM-DD')   as cycle_end
       from property_leasing_cycles
      where property_id=$1 and state='active'
        and cycle_start <= $2::date and cycle_end >= $2::date
      order by cycle_start`, [property_id, today]);

  if (!rows.length) {
    throw refuse("no_current_cycle",
      "No leasing cycle is configured for this date. Choose the dates, or establish a cycle.",
      { as_of: today });
  }
  if (rows.length > 1) {
    /*  ⚠ REFUSE, DO NOT PICK. Overlapping live cycles is a real state for
     *  a property changing its term structure, and answering it by taking
     *  the newest row would silently choose which business the operator
     *  is running. */
    throw refuse("ambiguous_cycle",
      `More than one leasing cycle covers ${today}: ` +
      rows.map((r) => `${r.cycle_label} (${r.cycle_start} → ${r.cycle_end})`).join(", ") +
      ". Name the one you mean.",
      { candidates: rows, as_of: today });
  }
  return { ...rows[0], resolved_by: "current_date", as_of: today };
}

module.exports = { establishLeasingCycle, listLeasingCycles, resolveCycle };
