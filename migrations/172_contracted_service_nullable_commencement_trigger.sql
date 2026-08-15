-- 172_contracted_service_nullable_commencement_trigger.sql
--
-- Migration 171 declared commencement_trigger nullable, but its column check
-- evaluated NULL AND FALSE for a null value and therefore rejected every term
-- without an event trigger. Calendar and month-to-month terms must be able to
-- leave this field unknown while still refusing blank or overlong triggers.

alter table contracted_service_terms
  drop constraint if exists contracted_service_terms_commencement_trigger_check;

alter table contracted_service_terms
  add constraint contracted_service_terms_commencement_trigger_check
  check (
    commencement_trigger is null
    or (
      length(commencement_trigger) <= 500
      and nullif(btrim(commencement_trigger), '') is not null
    )
  );
