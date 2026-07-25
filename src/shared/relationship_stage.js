// ════════════════════════════════════════════════════════════════════
//  relationship_stage.js — THE ONE PERSON × PROPERTY STAGE RESOLVER
//
//  There were four different answers to "what stage is this person in":
//    · leasing_leads.status          (advance-only ladder, cosmetic)
//    · leasing_conversions.current_stage
//    · the Person Card's inline 'prospect' | 'applicant'
//    · person_contexts.context_type  (built; holds only 'staff' in live data)
//
//  This module is the single answer, and the answer is: DERIVE IT, STORE
//  NOTHING. Stage is a read computed from evidence against an as_of date.
//  A stored stage word rebuilds the advance-only ladder that already bit us
//  (a cancelled tour left leads reading 'tour_scheduled' forever).
//
//  THE LADDER — most advanced evidence wins:
//    resident         an ACTIVE lease at this property lists this person
//    future_resident  a PENDING lease at this property lists this person
//    applicant        a lease_applications row exists for this person here
//    prospect         any presence at all (lead / conversation / attrs / conversion)
//
//  DELIBERATELY ABSENT — former_resident.
//  It is NOT derivable from current truth and this module will not fake it.
//  leases.lease_status admits only 'active' | 'pending' | 'commercial' in live
//  data; there is no ended/expired/moved-out state, and `turnovers` is empty.
//  REMOVAL CONDITION for this gap: when a lease end/move-out state exists,
//  add the branch here — in this file only, because every reader shares it.
//
//  Lease → person linkage note: `leases` carries NO person foreign key. The
//  linkage is leases.tenant_ids, an untyped array. It is compared as text
//  because the column is not FK-constrained to persons(id). Verified live
//  2026-07-25: all 340 populated tenant_ids on Demo Building resolve to real
//  persons rows. leases.application_id is populated on 3 of 347 and is NOT a
//  reliable path.
//
//  Returns { stage, basis } — `basis` names the evidence so a surface can
//  explain WHY without re-deriving it. Honest blank beats confident wrong:
//  a person with no presence returns stage null, never a default word.
//
//  Class 1 — permanent product primitive. One resolver, many readers
//  (Person Card today; People Index next). Nothing here writes.
// ════════════════════════════════════════════════════════════════════

const STAGES = ["prospect", "applicant", "future_resident", "resident"];

// db: a pg Pool or a checked-out Client — both expose .query().
async function resolveRelationshipStage(db, { personId, propertyId, asOf = null }) {
  if (!personId || !propertyId) return { stage: null, basis: null };

  // One round trip. Each flag is independent evidence; the ladder is applied
  // in JS so the precedence is readable rather than buried in SQL.
  const r = (await db.query(
    // Every use of $1/$2 is cast explicitly. Postgres infers a parameter's
    // type from its uses, so a single bare `$1` next to `$1::text` makes the
    // whole param text and every uuid comparison fails with 42883.
    `select
       exists (select 1 from leases l
                where l.property_id = $2::uuid
                  and l.lease_status = 'active'
                  and l.tenant_ids is not null
                  and exists (select 1 from unnest(l.tenant_ids) t(pid)
                               where t.pid::text = $1::text)
                  and ($3::timestamptz is null
                       or l.start_date is null
                       or l.start_date <= $3::timestamptz)
              ) as has_active_lease,
       exists (select 1 from leases l
                where l.property_id = $2::uuid
                  and l.lease_status = 'pending'
                  and l.tenant_ids is not null
                  and exists (select 1 from unnest(l.tenant_ids) t(pid)
                               where t.pid::text = $1::text)
              ) as has_pending_lease,
       exists (select 1 from lease_applications a
                where a.person_id = $1::uuid and a.property_id = $2::uuid) as has_application,
       (exists (select 1 from leasing_leads where person_id = $1::uuid and property_id = $2::uuid)
        or exists (select 1 from conversations where person_id = $1::uuid and property_id = $2::uuid)
        or exists (select 1 from person_attributes where person_id = $1::uuid and property_id = $2::uuid)
        or exists (select 1 from leasing_conversions where person_id = $1::uuid and property_id = $2::uuid)
       ) as has_presence`,
    [personId, propertyId, asOf]
  )).rows[0];

  if (r.has_active_lease)  return { stage: "resident",        basis: "active_lease" };
  if (r.has_pending_lease) return { stage: "future_resident", basis: "pending_lease" };
  if (r.has_application)   return { stage: "applicant",       basis: "application" };
  if (r.has_presence)      return { stage: "prospect",        basis: "presence" };
  return { stage: null, basis: null };   // no presence — the caller decides (404 wall, honest blank)
}

module.exports = { resolveRelationshipStage, STAGES };
