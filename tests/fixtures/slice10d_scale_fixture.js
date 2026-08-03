// ════════════════════════════════════════════════════════════════════
//  slice10d_scale_fixture.js — 10,000 selected + 100,000 neighbouring
//  canonical spaces, SYNTHETIC ONLY.
//
//  The manifest is computed FROM THE GENERATOR'S OWN RULES, never by calling
//  the code under test. If the fixture and the production aggregation both
//  derived expectations from the same function, the proof would only be
//  asserting that a function equals itself.
//
//  ADVERSARIAL ORDERING. Ordering is unit_number then spaces.id. The unit
//  numbers are zero-padded so ordering is deterministic, and every adverse
//  condition is deliberately placed in the HIGH range — beyond the first
//  several pages — so a page-one summary cannot look clean by accident.
// ════════════════════════════════════════════════════════════════════
"use strict";

const SELECTED = 10000;
const NEIGHBOUR = 100000;

//  Deterministic shape assignment by index. Adverse shapes live at the END.
//  Everything below LATE is ordinary; everything at or above it is adverse.
const LATE = 9900;

function shapeFor(i) {
  if (i >= LATE) {
    const k = (i - LATE) % 6;
    return ["unknown_denominator", "lease_conflict", "econ_conflict",
            "qualified_legacy", "two_obligations", "no_destination"][k];
  }
  const k = i % 5;
  return ["dated", "dated_step", "commercial", "non_revenue", "obligation"][k];
}

//  THE MANIFEST — counted from the rules above, in plain arithmetic.
function manifest() {
  const m = { total: SELECTED, byShape: {} };
  for (let i = 0; i < SELECTED; i++) {
    const s = shapeFor(i);
    m.byShape[s] = (m.byShape[s] || 0) + 1;
  }
  m.revenue = m.byShape.dated + m.byShape.dated_step + m.byShape.commercial
            + m.byShape.obligation + m.byShape.lease_conflict + m.byShape.econ_conflict
            + m.byShape.qualified_legacy + m.byShape.two_obligations + m.byShape.no_destination;
  m.non_revenue = m.byShape.non_revenue;
  m.unknown_denominator = m.byShape.unknown_denominator;
  m.late_adverse_first_index = LATE;
  return m;
}

async function build(pool, { log = () => {} } = {}) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const one = async (q, a = []) => (await c.query(q, a)).rows[0];
    const A = (await one(`insert into properties (name, operating_timezone)
      values ('10D Selected','America/New_York') returning id`)).id;
    const N = (await one(`insert into properties (name, operating_timezone)
      values ('10D Neighbour','America/New_York') returning id`)).id;
    const person = (await one(`insert into persons (name, lifecycle_status)
      values ('10D Synthetic','tenant') returning id`)).id;
    const user = (await one(`insert into users (name,email,phone,role,is_active,status)
      values ('10D User',$1,$2,'property_manager',true,'active') returning id`,
      [`d10-${Date.now()}@s.test`, "+1727" + String(Date.now()).slice(-7)])).id;

    log("  generating units and spaces…");
    //  Units in bulk; the trigger creates one space per unit.
    await c.query(
      `insert into units (property_id, unit_number)
       select $1, 'S' || lpad(g::text, 6, '0') from generate_series(0, $2 - 1) g`, [A, SELECTED]);
    await c.query(
      `insert into units (property_id, unit_number)
       select $1, 'N' || lpad(g::text, 6, '0') from generate_series(0, $2 - 1) g`, [N, NEIGHBOUR]);

    //  Index the selected spaces by their generated ordinal.
    await c.query(`create temporary table t10d as
      select s.id as space_id, u.unit_number,
             (substring(u.unit_number from 2))::int as ord
        from spaces s join units u on u.id = s.unit_id
       where u.property_id = $1`, [A]);

    log("  classifying use_type…");
    //  non_revenue for its shape; NULL for the unknown-denominator shape;
    //  commercial for its shape; residential otherwise.
    await c.query(`update spaces s set use_type = 'residential',
        classified_by_user_id = $1, classified_at = now(), classification_source = 'fixture'
      from t10d t where t.space_id = s.id`, [user]);
    await c.query(`update spaces s set use_type = 'non_revenue' from t10d t
      where t.space_id = s.id and t.ord < ${LATE} and t.ord % 5 = 3`);
    await c.query(`update spaces s set use_type = 'commercial' from t10d t
      where t.space_id = s.id and t.ord < ${LATE} and t.ord % 5 = 2`);
    await c.query(`update spaces s set use_type = null, classified_by_user_id = null,
        classified_at = null, classification_source = null
      from t10d t where t.space_id = s.id and t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 0`);

    log("  leases…");
    //  One covering lease everywhere. qualified_legacy starts in the target
    //  month so its undated amount is provable there.
    await c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       select $1, t.space_id, array[$2::uuid], 1000,
              case when t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 3
                   then date '2026-12-01' else date '2026-01-01' end,
              date '2027-12-31', 'active'
         from t10d t`, [A, person]);
    //  ADVERSARIAL: a second overlapping lease only on the conflict shape.
    await c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       select $1, t.space_id, array[$2::uuid], 2000, date '2026-06-01', date '2027-06-30', 'active'
         from t10d t where t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 1`, [A, person]);
    //  Neighbour leases, so the neighbouring property is not trivially cheap.
    await c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       select $1, s.id, array[$2::uuid], 900, date '2026-01-01', date '2027-12-31', 'active'
         from spaces s join units u on u.id = s.unit_id where u.property_id = $1`, [N, person]);

    log("  economics…");
    const off = (await one(
      `insert into lease_offers (property_id, person_id, status, source, scope,
         offered_terms_snapshot, authority_basis_snapshot, granted_by_person_id)
       values ($1,$2,'draft','discretionary','property','{}'::jsonb,'{}'::jsonb,$3) returning id`,
      [A, person, person])).id;
    //  One application per schedule (uq_les_application_live), generated in bulk.
    await c.query(`create temporary table t10d_sched as
      select t.space_id, t.ord from t10d t
       where (t.ord < ${LATE} and (t.ord % 5 = 0 or t.ord % 5 = 1 or t.ord % 5 = 2))
          or (t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 2)`);
    await c.query(
      `insert into lease_applications (property_id, person_id, status)
       select $1, $2, 'approved' from t10d_sched`, [A, person]);
    await c.query(`create temporary table t10d_appmap as
      select s.space_id, s.ord, a.id as application_id
        from (select space_id, ord, row_number() over (order by ord) rn from t10d_sched) s
        join (select id, row_number() over (order by created_at, id) rn
                from lease_applications where property_id = $1) a on a.rn = s.rn`, [A]);
    await c.query(
      `insert into lease_economic_schedules (property_id, application_id, space_id, status,
         source_offer_id, locked_by_person_id)
       select $1, m.application_id, m.space_id, 'locked', $2, $3 from t10d_appmap m`,
      [A, off, person]);
    //  base_rent for the target month; the step shape differs from its opening.
    await c.query(
      `insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
       select les.id, date '2026-12-01', 'base_rent',
              case when m.ord % 5 = 1 then 1200 else 1000 end
         from lease_economic_schedules les join t10d_appmap m on m.space_id = les.space_id
        where les.property_id = $1`, [A]);
    await c.query(
      `insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
       select les.id, date '2026-08-01', 'base_rent', 1000
         from lease_economic_schedules les join t10d_appmap m on m.space_id = les.space_id
        where les.property_id = $1`, [A]);
    //  ADVERSARIAL: a SECOND base rent in the target month for econ_conflict.
    await c.query(
      `insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
       select les.id, date '2026-12-01', 'base_rent', 2600
         from lease_economic_schedules les join t10d_appmap m on m.space_id = les.space_id
        where les.property_id = $1 and m.ord >= ${LATE} and (m.ord - ${LATE}) % 6 = 2`, [A]);

    log("  obligations…");
    await c.query(
      `insert into obligations (property_id, module, type, status, related_id, related_type,
         due_at, assigned_user_id, label)
       select $1, 'leasing', 'resolve_inbound_opportunity', 'open', l.id, 'lease',
              now() + interval '30 days', $2, 'Synthetic obligation'
         from leases l join t10d t on t.space_id = l.space_id
        where l.property_id = $1 and t.ord < ${LATE} and t.ord % 5 = 4`, [A, user]);
    //  Two active obligations on the two_obligations shape (late range).
    for (const st of ["open", "in_progress"]) {
      await c.query(
        `insert into obligations (property_id, module, type, status, related_id, related_type,
           due_at, assigned_user_id, label)
         select $1, 'leasing', 'resolve_inbound_opportunity', $3, l.id, 'lease',
                now() + interval '30 days', $2, 'Synthetic conflict'
           from leases l join t10d t on t.space_id = l.space_id
          where l.property_id = $1 and t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 4`, [A, user, st]);
    }
    //  An obligation type with NO governed destination (late range).
    await c.query(
      `insert into obligations (property_id, module, type, status, related_id, related_type,
         due_at, assigned_user_id, label)
       select $1, 'leasing', 'lease_review', 'open', l.id, 'lease',
              now() + interval '30 days', $2, 'No destination'
         from leases l join t10d t on t.space_id = l.space_id
        where l.property_id = $1 and t.ord >= ${LATE} and (t.ord - ${LATE}) % 6 = 5`, [A, user]);

    //  market_rent populated everywhere and never usable as contract rent.
    await c.query(`update units set market_rent = 9876 where property_id = $1`, [A]);
    await c.query("commit");
    return { selected_property_id: A, neighbour_property_id: N, user, person, manifest: manifest() };
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

module.exports = { build, manifest, SELECTED, NEIGHBOUR, LATE, shapeFor };
