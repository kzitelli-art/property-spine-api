--  ════════════════════════════════════════════════════════════════
--   SKYLINE LEGACY INVENTORY — THE FULL REFERENCE PERIMETER
--
--   57 referencing columns across 52 tables.
--   Generated from migrations/*.sql (the definitive statement of what
--   production ran), cross-checked against a live schema with ZERO
--   parser gaps. Do not hand-maintain this list — regenerate it.
--
--   THREE classes, not two — production taught the third:
--     EXPECTED            provenance, demo harness, structural parent.
--                         Non-zero is normal.
--     PROVENANCE BLOCKER  non-zero BLOCKS deletion rather than
--                         permitting it. ingest_candidates
--                         .promoted_unit_id is ON DELETE SET NULL, so a
--                         delete succeeds and silently nulls the pointer
--                         from each promotion receipt to what it
--                         created. RETIRE, do not delete.
--     must be 0           everything else, before anything is touched.
--  ════════════════════════════════════════════════════════════════

with legacy_units as (
  --  ▼ YOUR predicate — the one that counted 159. Not guessed here.
  select id from units
   where property_id = '14e41b7c-e91c-49e8-9651-10c4908a8f6a'
     and /*  e.g. unit_number ~ '^[0-9]+ - [A-Z]$'  */ true
), legacy_spaces as (
  --  ▼ YOUR predicate — the one that counted 231.
  select s.id from spaces s join units u on u.id = s.unit_id
   where u.property_id = '14e41b7c-e91c-49e8-9651-10c4908a8f6a'
     and /*  e.g. s.space_label = '(whole unit)'  */ true
)
select 'agent_facts.space_id                        must be 0' as ref, count(*) as n
  from agent_facts t join legacy_spaces g on g.id = t.space_id
union all
select 'contracted_service_locations.space_id       must be 0' as ref, count(*) as n
  from contracted_service_locations t join legacy_spaces g on g.id = t.space_id
union all
select 'demo_runs.space_id                          EXPECTED' as ref, count(*) as n
  from demo_runs t join legacy_spaces g on g.id = t.space_id
union all
select 'executed_lease_records.space_id             must be 0' as ref, count(*) as n
  from executed_lease_records t join legacy_spaces g on g.id = t.space_id
union all
select 'import_source_rows.produced_space_id        EXPECTED' as ref, count(*) as n
  from import_source_rows t join legacy_spaces g on g.id = t.produced_space_id
union all
select 'lease_economic_schedules.space_id           must be 0' as ref, count(*) as n
  from lease_economic_schedules t join legacy_spaces g on g.id = t.space_id
union all
select 'lease_offers.space_id                       must be 0' as ref, count(*) as n
  from lease_offers t join legacy_spaces g on g.id = t.space_id
union all
select 'leases.space_id                             must be 0' as ref, count(*) as n
  from leases t join legacy_spaces g on g.id = t.space_id
union all
select 'renewal_cases.space_id                      must be 0' as ref, count(*) as n
  from renewal_cases t join legacy_spaces g on g.id = t.space_id
union all
select 'unit_events.space_id                        must be 0' as ref, count(*) as n
  from unit_events t join legacy_spaces g on g.id = t.space_id
union all
select 'utility_service_points.space_id             must be 0' as ref, count(*) as n
  from utility_service_points t join legacy_spaces g on g.id = t.space_id
union all
select 'agent_runs.selected_unit_id                 must be 0' as ref, count(*) as n
  from agent_runs t join legacy_units g on g.id = t.selected_unit_id
union all
select 'application_invitations.unit_id             must be 0' as ref, count(*) as n
  from application_invitations t join legacy_units g on g.id = t.unit_id
union all
select 'bids.unit_id                                must be 0' as ref, count(*) as n
  from bids t join legacy_units g on g.id = t.unit_id
union all
select 'comm_events.unit_id                         must be 0' as ref, count(*) as n
  from comm_events t join legacy_units g on g.id = t.unit_id
union all
select 'contracted_service_locations.unit_id        must be 0' as ref, count(*) as n
  from contracted_service_locations t join legacy_units g on g.id = t.unit_id
union all
select 'conversations.unit_id                       must be 0' as ref, count(*) as n
  from conversations t join legacy_units g on g.id = t.unit_id
union all
select 'demo_runs.unit_id                           EXPECTED' as ref, count(*) as n
  from demo_runs t join legacy_units g on g.id = t.unit_id
union all
select 'deposit_claims.unit_id                      must be 0' as ref, count(*) as n
  from deposit_claims t join legacy_units g on g.id = t.unit_id
union all
select 'documents.unit_id                           must be 0' as ref, count(*) as n
  from documents t join legacy_units g on g.id = t.unit_id
union all
select 'events.unit_id                              must be 0' as ref, count(*) as n
  from events t join legacy_units g on g.id = t.unit_id
union all
select 'import_source_rows.produced_unit_id         EXPECTED' as ref, count(*) as n
  from import_source_rows t join legacy_units g on g.id = t.produced_unit_id
union all
select 'ingest_candidates.promoted_unit_id          PROVENANCE BLOCKER' as ref, count(*) as n
  from ingest_candidates t join legacy_units g on g.id = t.promoted_unit_id
union all
select 'lease_applications.unit_id                  must be 0' as ref, count(*) as n
  from lease_applications t join legacy_units g on g.id = t.unit_id
union all
select 'lease_packets.unit_id                       must be 0' as ref, count(*) as n
  from lease_packets t join legacy_units g on g.id = t.unit_id
union all
select 'leasing_conversions.preferred_unit_id       must be 0' as ref, count(*) as n
  from leasing_conversions t join legacy_units g on g.id = t.preferred_unit_id
union all
select 'leasing_leads.unit_id                       must be 0' as ref, count(*) as n
  from leasing_leads t join legacy_units g on g.id = t.unit_id
union all
select 'leasing_tours.unit_id                       must be 0' as ref, count(*) as n
  from leasing_tours t join legacy_units g on g.id = t.unit_id
union all
select 'ledger_claims.unit_id                       must be 0' as ref, count(*) as n
  from ledger_claims t join legacy_units g on g.id = t.unit_id
union all
select 'money_events.unit_id                        must be 0' as ref, count(*) as n
  from money_events t join legacy_units g on g.id = t.unit_id
union all
select 'obligation_input_proofs.unit_id             must be 0' as ref, count(*) as n
  from obligation_input_proofs t join legacy_units g on g.id = t.unit_id
union all
select 'obligations.unit_id                         must be 0' as ref, count(*) as n
  from obligations t join legacy_units g on g.id = t.unit_id
union all
select 'persons.interested_unit_id                  must be 0' as ref, count(*) as n
  from persons t join legacy_units g on g.id = t.interested_unit_id
union all
select 'reclean_rulings.unit_id                     must be 0' as ref, count(*) as n
  from reclean_rulings t join legacy_units g on g.id = t.unit_id
union all
select 'scheduled_charges.unit_id                   must be 0' as ref, count(*) as n
  from scheduled_charges t join legacy_units g on g.id = t.unit_id
union all
select 'spaces.unit_id                              EXPECTED' as ref, count(*) as n
  from spaces t join legacy_units g on g.id = t.unit_id
union all
select 'staff_agent_messages.unit_id                must be 0' as ref, count(*) as n
  from staff_agent_messages t join legacy_units g on g.id = t.unit_id
union all
select 'staff_agent_proposals.unit_id               must be 0' as ref, count(*) as n
  from staff_agent_proposals t join legacy_units g on g.id = t.unit_id
union all
select 'supply_requests.unit_id                     must be 0' as ref, count(*) as n
  from supply_requests t join legacy_units g on g.id = t.unit_id
union all
select 'tour_availability.unit_id                   must be 0' as ref, count(*) as n
  from tour_availability t join legacy_units g on g.id = t.unit_id
union all
select 'tour_units_shown.unit_id                    must be 0' as ref, count(*) as n
  from tour_units_shown t join legacy_units g on g.id = t.unit_id
union all
select 'turnovers.unit_id                           must be 0' as ref, count(*) as n
  from turnovers t join legacy_units g on g.id = t.unit_id
union all
select 'unit_events.unit_id                         must be 0' as ref, count(*) as n
  from unit_events t join legacy_units g on g.id = t.unit_id
union all
select 'unit_observations.unit_id                   must be 0' as ref, count(*) as n
  from unit_observations t join legacy_units g on g.id = t.unit_id
union all
select 'unit_readiness_certifications.unit_id       must be 0' as ref, count(*) as n
  from unit_readiness_certifications t join legacy_units g on g.id = t.unit_id
union all
select 'unit_readiness_walks.unit_id                must be 0' as ref, count(*) as n
  from unit_readiness_walks t join legacy_units g on g.id = t.unit_id
union all
select 'unit_triage_confirmations.unit_id           must be 0' as ref, count(*) as n
  from unit_triage_confirmations t join legacy_units g on g.id = t.unit_id
union all
select 'unit_triage_findings.unit_id                must be 0' as ref, count(*) as n
  from unit_triage_findings t join legacy_units g on g.id = t.unit_id
union all
select 'unit_triage_required_work.unit_id           must be 0' as ref, count(*) as n
  from unit_triage_required_work t join legacy_units g on g.id = t.unit_id
union all
select 'unit_turn_appliances.unit_id                must be 0' as ref, count(*) as n
  from unit_turn_appliances t join legacy_units g on g.id = t.unit_id
union all
select 'unit_turn_scopes.unit_id                    must be 0' as ref, count(*) as n
  from unit_turn_scopes t join legacy_units g on g.id = t.unit_id
union all
select 'utility_service_points.unit_id              must be 0' as ref, count(*) as n
  from utility_service_points t join legacy_units g on g.id = t.unit_id
union all
select 'work_acceptances.unit_id                    must be 0' as ref, count(*) as n
  from work_acceptances t join legacy_units g on g.id = t.unit_id
union all
select 'work_completion_claims.unit_id              must be 0' as ref, count(*) as n
  from work_completion_claims t join legacy_units g on g.id = t.unit_id
union all
select 'work_orders.unit_id                         must be 0' as ref, count(*) as n
  from work_orders t join legacy_units g on g.id = t.unit_id
union all
select 'work_proof_attachments.unit_id              must be 0' as ref, count(*) as n
  from work_proof_attachments t join legacy_units g on g.id = t.unit_id
union all
select 'work_reopenings.unit_id                     must be 0' as ref, count(*) as n
  from work_reopenings t join legacy_units g on g.id = t.unit_id
order by 2 desc, 1;


--  ════════════════════════════════════════════════════════════════
--   RUN THIS FIRST. It decomposes the 391 by ORIGIN.
--
--   001_baseline.sql creates trg_unit_space: an AFTER INSERT trigger on
--   units that unconditionally inserts a '(whole unit)' space for every
--   unit, with import_batch_id NULL and position_kind NULL. So a
--   bed-grained property gets one whole-unit space per unit ON TOP of
--   its beds, and the arithmetic closes exactly:
--
--        160 labelled bed spaces   source-backed import
--      +  72 whole-unit            trigger, on the 72 REAL units
--      + 159 whole-unit            trigger, on the 159 LEGACY units
--      = 391
--
--   ⚠ count(*) HERE WAS A BUG, AND IT MATTERED. The left join to leases
--   multiplies a space row once per attached lease, so the 160 good bed
--   spaces reported as 202 on production purely because they carry 179
--   leases. count(distinct …) is the fix. The diagnosis was right and the
--   diagnostic was not — which is exactly why the receipt says where each
--   number came from.
--  ════════════════════════════════════════════════════════════════

select coalesce(s.position_kind, '(null)')            as grain,
       case when s.space_label = '(whole unit)' then 'whole unit' else 'labelled' end as label_class,
       case when s.import_batch_id is null then 'no batch' else 'source-backed' end   as space_origin,
       case when u.import_batch_id is null then 'no batch' else 'source-backed' end   as unit_origin,
       count(distinct s.id) as spaces,
       count(distinct u.id) as units,
       min(u.unit_number)   as example_unit,
       count(distinct l.id) as leases_on_them
  from spaces s
  join units u on u.id = s.unit_id
  left join leases l on l.space_id = s.id
 where u.property_id = '14e41b7c-e91c-49e8-9651-10c4908a8f6a'
 group by 1,2,3,4
 order by spaces desc;

--  The trigger, still armed:
select tgname, tgenabled from pg_trigger where tgname = 'trg_unit_space';

--  And the promotion lineage the retirement must preserve, not erase:
select ic.run_id, count(*)::int as candidates,
       count(ic.promoted_unit_id)::int as still_pointing_at_a_unit,
       min(ic.promoted_at) as promoted_at
  from ingest_candidates ic
  join units u on u.id = ic.promoted_unit_id
 where u.property_id = '14e41b7c-e91c-49e8-9651-10c4908a8f6a'
 group by ic.run_id order by candidates desc;
