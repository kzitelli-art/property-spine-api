// ════════════════════════════════════════════════════════════════════
//  person_property_presence.js — ONE ANSWER TO "MAY THIS PROPERTY'S
//  STAFF SEE THIS PERSON AT ALL?"
//
//  Person × Property is the wall. A staff session is scoped to ONE
//  property, and a person who has never been seen at that property is
//  not that property's person — their name, their recorded budget and
//  even WHICH facts they carry stay on the other side.
//
//  This predicate was written inline in /operator/leasing/person-card
//  and lived there alone. When a second door began reading the same
//  person_attributes rows (/operator/leasing/prospect-match), copying
//  the query would have created two walls that drift — and a wall that
//  drifts is a wall with a gap nobody chose. §7: capture once, read
//  everywhere, and that applies to a refusal as much as to a fact.
//
//  ── WHAT COUNTS AS PRESENCE, AND WHY ────────────────────────────────
//  A lead, a conversation, a person × property attribute, a conversion,
//  or a lease at THIS property. The reasoning behind each clause was
//  earned at the card and is kept here because it is the same reasoning:
//
//   · A CONVERSION IS PRESENCE (R3). The card projects task events for
//     conversion-driven people, so the wall must recognise them.
//   · A LEASE IS PRESENCE (owner ruling, 2026-07-25). Before that clause
//     the wall tested leads/conversations/attributes/conversions but
//     never leases, so 621 of 623 active-lease residents got "person not
//     found" — a bug that failed closed, not a privacy control. No
//     lease_status filter, deliberately: 'active', 'pending' and
//     'commercial' all evidence presence, and a future historical status
//     must not silently drop a person off the card.
//   · Scoped to THIS property, never portfolio-wide — that would collide
//     with the locked cross-deal rule.
//   · A PRESENCE test, NOT an entitlement. Which projection a given
//     viewer gets is a separate question and stays open.
//
//  A person × property attribute counts; a person-level attribute with a
//  NULL property_id does NOT. prospect_capture.js writes
//  `propertyId || null`, so treating a null-property fact as presence
//  would make every such person visible from every property — which is
//  the hole this helper closes at the new door.
//
//  $1/$2 are cast explicitly: every other use here is uuid, so the
//  inference stays uuid (see relationship_stage.js:52 for the 42883 trap
//  when a bare $1 meets a cast $1).
//
//  `db` accepts a Pool OR a checked-out Client, so a caller inside a
//  transaction keeps its atomicity.
//
//  Class 1 — permanent product primitive.
// ════════════════════════════════════════════════════════════════════
"use strict";

async function hasPresenceAtProperty(db, { person_id, property_id } = {}) {
  if (!person_id || !property_id) return false;
  const r = await db.query(
    `select 1 where exists (select 1 from leasing_leads where person_id=$1 and property_id=$2)
         or exists (select 1 from conversations where person_id=$1 and property_id=$2)
         or exists (select 1 from person_attributes where person_id=$1 and property_id=$2)
         or exists (select 1 from leasing_conversions where person_id=$1 and property_id=$2)
         or exists (select 1 from leases
                     where property_id = $2::uuid
                       and tenant_ids is not null
                       and tenant_ids @> array[$1::uuid])`,
    [person_id, property_id]);
  return r.rows.length > 0;
}

module.exports = { hasPresenceAtProperty };
