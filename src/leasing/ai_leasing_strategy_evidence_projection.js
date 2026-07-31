// ════════════════════════════════════════════════════════════════════
// AI LEASING STRATEGY EVIDENCE PROJECTION
//
// One canonical read over existing operating truth. The experimental unit is
// leasing_leads.id — one property-scoped opportunity — while the prospect's
// conversation remains continuous. A row enters the denominator only when:
//   • it has an initial weighted assignment tied to that exact opportunity;
//   • a message attributed to that initial strategy was confirmed delivered;
//   • the Person × Property record is currently production, not internal QA;
//   • the full observation window has elapsed since first delivered exposure.
//
// Unsupported outcomes are returned as null, never false. That prevents a
// missing canonical event source from looking like a successful zero rate.
// ════════════════════════════════════════════════════════════════════
"use strict";

const evidence = require("./ai_leasing_strategy_evidence");

const DEFAULT_OBSERVATION_WINDOW_DAYS = 30;

const CANONICAL_EVIDENCE_SQL = `
with initial_assignment as (
  select distinct on (e.leasing_lead_id)
         e.id as assignment_event_id,
         e.leasing_lead_id,
         e.conversation_id,
         e.person_id,
         e.property_id,
         e.strategy_profile_id,
         e.strategy_version_id,
         e.assignment_basis,
         e.assignment_policy_fingerprint,
         e.source_context,
         e.cohort_key,
         e.occurred_at as assigned_at
    from conversation_ai_leasing_strategy_events e
   where e.property_id = $1
     and e.event_type = 'assigned'
   order by e.leasing_lead_id, e.event_sequence asc, e.id asc
), first_delivered_exposure as (
  select ia.leasing_lead_id,
         min(ce.occurred_at) as first_delivered_at
    from initial_assignment ia
    join ai_leasing_message_attributions ma
      on ma.leasing_lead_id = ia.leasing_lead_id
     and ma.assignment_event_id = ia.assignment_event_id
     and ma.strategy_version_id = ia.strategy_version_id
    join comm_events ce on ce.id = ma.comm_event_id
   where lower(coalesce(ce.provider_status, ce.sms_status, '')) = 'delivered'
   group by ia.leasing_lead_id
), opportunity as (
  select ia.*,
         l.received_at,
         l.status as leasing_lead_status,
         exposure_class.record_class,
         fde.first_delivered_at,
         reply.prospect_replied_at,
         booked.tour_booked_at,
         held.tour_held_at,
         app.application_submitted_at,
         handoff.human_handoff_at,
         stop.opt_out_at
    from initial_assignment ia
    join leasing_leads l on l.id = ia.leasing_lead_id
    left join first_delivered_exposure fde on fde.leasing_lead_id = ia.leasing_lead_id
    left join lateral (
      select ppc.record_class
        from person_property_classifications ppc
       where ppc.person_id = ia.person_id
         and ppc.property_id = ia.property_id
         and fde.first_delivered_at is not null
         and ppc.classified_at <= fde.first_delivered_at
         and (ppc.superseded_at is null or ppc.superseded_at > fde.first_delivered_at)
       order by ppc.classified_at desc, ppc.id desc
       limit 1
    ) exposure_class on true
    left join lateral (
      select min(ce.occurred_at) as prospect_replied_at
        from comm_events ce
       where ce.conversation_id = ia.conversation_id
         and ce.direction = 'inbound'
         and ce.sender_role = 'prospect'
         and ce.occurred_at > fde.first_delivered_at
         and ce.occurred_at <= $2::timestamptz
    ) reply on fde.first_delivered_at is not null
    left join lateral (
      select min(lt.created_at) as tour_booked_at
        from leasing_tours lt
       where lt.lead_id = ia.leasing_lead_id
         and lt.status in ('scheduled','confirmed_by_prospect','checked_in','completed','no_show')
         and lt.created_at > fde.first_delivered_at
         and lt.created_at <= $2::timestamptz
    ) booked on fde.first_delivered_at is not null
    left join lateral (
      select min(te.event_at) as tour_held_at
        from leasing_tours lt
        join tour_events te on te.tour_id = lt.id
       where lt.lead_id = ia.leasing_lead_id
         and te.event_type in ('checked_in','completed')
         and te.event_at > fde.first_delivered_at
         and te.event_at <= $2::timestamptz
    ) held on fde.first_delivered_at is not null
    left join lateral (
      select min(la.created_at) as application_submitted_at
        from lease_applications la
       where la.leasing_lead_id = ia.leasing_lead_id
         and la.created_at > fde.first_delivered_at
         and la.created_at <= $2::timestamptz
    ) app on fde.first_delivered_at is not null
    left join lateral (
      select min(le.event_at) as human_handoff_at
        from lead_events le
       where le.lead_id = ia.leasing_lead_id
         and le.event_type = 'human_takeover'
         and le.event_at > fde.first_delivered_at
         and le.event_at <= $2::timestamptz
    ) handoff on fde.first_delivered_at is not null
    left join lateral (
      select min(ce.occurred_at) as opt_out_at
        from comm_events ce
       where ce.conversation_id = ia.conversation_id
         and ce.direction = 'inbound'
         and ce.classification = 'consent_signal'
         and lower(btrim(coalesce(ce.body,''))) in ('stop','stopall','unsubscribe','cancel','end','quit')
         and ce.occurred_at > fde.first_delivered_at
         and ce.occurred_at <= $2::timestamptz
    ) stop on fde.first_delivered_at is not null
)
select *,
       case
         when record_class is distinct from 'production' then false
         when first_delivered_at is null then false
         when first_delivered_at > $2::timestamptz - make_interval(days => $3::int) then false
         else true
       end as qualified,
       case
         when record_class is distinct from 'production' then 'not_production_at_exposure'
         when first_delivered_at is null then 'no_delivered_strategy_exposure'
         when first_delivered_at > $2::timestamptz - make_interval(days => $3::int) then 'observation_window_open'
         else null
       end as exclusion_reason
  from opportunity
 order by assigned_at asc, leasing_lead_id asc`

function normalizeAsOf(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError("asOf must be a valid date");
  return date.toISOString();
}

function rowToEvidence(row, { asOf, observationWindowDays }) {
  const afterExposure = (value) => {
    if (!value || !row.first_delivered_at) return false;
    return new Date(value).getTime() >= new Date(row.first_delivered_at).getTime() &&
      new Date(value).getTime() <= new Date(asOf).getTime();
  };
  return {
    leasing_lead_id: String(row.leasing_lead_id),
    conversation_id: String(row.conversation_id),
    property_id: String(row.property_id),
    cohort_key: String(row.cohort_key),
    strategy_version_id: String(row.strategy_version_id),
    assignment_basis: String(row.assignment_basis),
    assignment_policy_fingerprint: String(row.assignment_policy_fingerprint),
    analysis_population: "initial_opportunity_assignment_itt_v2",
    as_of: asOf,
    observation_window_days: observationWindowDays,
    qualified: row.qualified === true,
    exclusion_reason: row.exclusion_reason || null,
    first_delivered_at: row.first_delivered_at || null,
    prospect_replied: row.qualified === true ? afterExposure(row.prospect_replied_at) : false,
    tour_booked: row.qualified === true ? afterExposure(row.tour_booked_at) : false,
    tour_held: row.qualified === true ? afterExposure(row.tour_held_at) : false,
    application_started: null, // no canonical application-open/start event yet
    application_submitted: row.qualified === true ? afterExposure(row.application_submitted_at) : false,
    lease_signed: null,        // no accepted lease-signature timestamp linked to the opportunity yet
    human_handoff: row.qualified === true ? afterExposure(row.human_handoff_at) : false,
    opt_out: row.qualified === true ? afterExposure(row.opt_out_at) : false,
    complaint: null,           // no canonical complaint event yet
  };
}

async function loadCanonicalStrategyEvidence(client, {
  propertyId,
  asOf = new Date(),
  observationWindowDays = DEFAULT_OBSERVATION_WINDOW_DAYS,
} = {}) {
  if (!client || typeof client.query !== "function") throw new TypeError("loadCanonicalStrategyEvidence requires a database client");
  if (!propertyId) throw new TypeError("propertyId is required");
  if (!Number.isInteger(observationWindowDays) || observationWindowDays <= 0 || observationWindowDays > 365) {
    throw new TypeError("observationWindowDays must be an integer from 1 to 365");
  }
  const asOfIso = normalizeAsOf(asOf);
  const rows = (await client.query(CANONICAL_EVIDENCE_SQL, [propertyId, asOfIso, observationWindowDays])).rows;
  const all = rows.map((row) => rowToEvidence(row, { asOf: asOfIso, observationWindowDays }));
  return Object.freeze({
    as_of: asOfIso,
    observation_window_days: observationWindowDays,
    qualified: Object.freeze(all.filter((row) => row.qualified)),
    excluded: Object.freeze(all.filter((row) => !row.qualified)),
    metric_support: Object.freeze({
      prospect_replied: true,
      tour_booked: true,
      tour_held: true,
      application_started: false,
      application_submitted: true,
      lease_signed: false,
      human_handoff: true,
      opt_out: true,
      complaint: false,
    }),
  });
}

function summarizeCanonicalEvidence(projection) {
  if (!projection || !Array.isArray(projection.qualified)) {
    throw new TypeError("canonical evidence projection is required");
  }
  const groups = new Map();
  for (const row of projection.qualified) {
    const key = [
      row.property_id, row.cohort_key, row.strategy_version_id,
      row.assignment_basis, row.assignment_policy_fingerprint,
      row.analysis_population, row.as_of, row.observation_window_days,
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((rows) => evidence.summarizeStrategyEvidence(rows));
}

module.exports = {
  DEFAULT_OBSERVATION_WINDOW_DAYS,
  CANONICAL_EVIDENCE_SQL,
  normalizeAsOf,
  rowToEvidence,
  loadCanonicalStrategyEvidence,
  summarizeCanonicalEvidence,
};
