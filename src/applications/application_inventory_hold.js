// ════════════════════════════════════════════════════════════════════
//  application_inventory_hold.js — A BED AN APPLICANT HAS SIGNED FOR IS
//  SPOKEN FOR, AND EVERY AVAILABILITY READER MUST SAY SO.
//
//  An applicant signs the package Spine prepared. Nothing in the system
//  changed: the bed still read `marketable_now`, the matcher still offered
//  it, a second application could still be aimed at it, and the rent roll
//  still counted it open. Two people could sign for one bed and the first
//  anyone learned of it was at move-in.
//
//  ── NO NEW STATE IS STORED. THE FACT ALREADY EXISTS. ────────────────
//  `lease_packets.tenant_submitted_at` is stamped by the ONE signer-
//  submission writer the moment the tenant signer submits, on both packet
//  shapes — a governing instrument (status → `tenant_in_progress`) and a
//  terms acknowledgment (status → `submitted`). That column IS the
//  applicant's signature, and it is already canonical.
//
//  So this file adds NO table, NO column and NO migration. It is a READ:
//  one predicate, in one place, that every availability reader consumes
//  rather than re-deriving. A second copy of this predicate is exactly how
//  the rent roll and the matcher come to disagree about the same bed.
//
//  ── WHAT A HOLD IS NOT ──────────────────────────────────────────────
//  It is not a lease, and it does not claim one. It says: a named person
//  has signed for this bed and Spine cannot honestly offer it to somebody
//  else while that stands. If the application goes terminal the hold is
//  gone by the same read that created it — nothing has to be released by
//  hand, because nothing was reserved by hand.
//
//  It also never OUTRANKS an occupancy fact. It is consulted last, on a
//  bed that would otherwise read marketable, so a contested or occupied
//  position keeps the description its own evidence earned.
//
//  ── WHY THE PACKET AND NOT THE APPLICATION ──────────────────────────
//  An application is an ask. A signed package is a commitment to exact
//  terms on an exact bed. Holding inventory on submission would take beds
//  off the market for every enquiry; holding on signature takes them off
//  for the person who actually committed.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════
"use strict";

//  THE PREDICATE. One SQL fragment, shared by both reads below, so the
//  per-property sweep and the single-space check cannot drift apart.
//
//    tenant_submitted_at   the applicant signed (the only signal used)
//    superseded_at is null a superseded version's signature is history; the
//                          current version carries the live commitment
//    status <> 'void'      a voided package holds nothing
//    la.status not terminal a declined / withdrawn / expired application
//                          releases its bed by this read alone
const HOLD_SQL = `
  select la.space_id, la.unit_id, la.id as application_id, la.applicant_name,
         lp.id as lease_packet_id, lp.status as packet_status,
         lp.tenant_submitted_at as signed_at
    from lease_packets lp
    join lease_applications la on la.id = lp.application_id
   where lp.tenant_submitted_at is not null
     and lp.superseded_at is null
     and coalesce(lp.status,'') <> 'void'
     and la.status not in ('declined','withdrawn','expired')
     and la.space_id is not null`;

function shape(r) {
  return {
    application_id: String(r.application_id),
    applicant_name: r.applicant_name || null,
    lease_packet_id: String(r.lease_packet_id),
    packet_status: r.packet_status || null,
    signed_at: r.signed_at ? new Date(r.signed_at).toISOString() : null,
  };
}

/*  Every held bed at one property, keyed by space id.
 *
 *  ⚠ A SPACE CAN ONLY BE HELD ONCE, and if two rows ever come back for one
 *  space that is a REAL defect — two people signed for one bed — not a
 *  rendering problem. The later signature does not silently overwrite the
 *  earlier one: both are carried, and `contested` says so, so a reader can
 *  show it rather than pick a winner (§5).                               */
async function heldSpacesForProperty(q, property_id) {
  if (!property_id) throw new Error("heldSpacesForProperty requires a property_id");
  const rows = (await q.query(
    `${HOLD_SQL} and la.property_id = $1 order by lp.tenant_submitted_at asc`,
    [property_id])).rows;
  const bySpace = new Map();
  for (const r of rows) {
    const key = String(r.space_id);
    const prior = bySpace.get(key);
    if (!prior) { bySpace.set(key, { ...shape(r), contested_by: [] }); continue; }
    prior.contested_by.push(shape(r));
  }
  return bySpace;
}

/*  One bed. Used where loading a whole property would be the wrong cost. */
async function holdForSpace(q, space_id) {
  if (!space_id) return null;
  const rows = (await q.query(
    `${HOLD_SQL} and la.space_id = $1 order by lp.tenant_submitted_at asc`,
    [space_id])).rows;
  if (!rows.length) return null;
  const [first, ...rest] = rows;
  return { ...shape(first), contested_by: rest.map(shape) };
}

//  The state name availability readers publish. Named for the FACT — a
//  person signed — not for the mechanism, because an operator reading
//  "held" needs to know who and since when, and both travel with it.
const HELD_STATE = "held_for_signed_applicant";

module.exports = { heldSpacesForProperty, holdForSpace, HELD_STATE, HOLD_SQL };
