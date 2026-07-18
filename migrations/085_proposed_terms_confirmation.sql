-- ════════════════════════════════════════════════════════════════════
--  085_proposed_terms_confirmation.sql
--
--  The governed "management confirmed these proposed economics for resident
--  review" fact — Part 1 of the proposed-terms slice (FROZEN SPEC r2).
--
--  Closes four gaps that live source had:
--   (a) applicant-supplied rent/deposit could reach a packet (no provenance);
--   (b) coarse x-operator-key packet writes with no session/property wall;
--   (c) a partially-acknowledged packet (tenant_in_progress) escaping the
--       immutability guard that only knew 'in_progress' (code read-fix, not here);
--   (d) silent token reissuance on an already-sent packet (durable issuance id).
--
--  This migration is the SCHEMA object only. Services/routes/gate/adapters and
--  the code read-fix ship in later parts. No status change, no lease creation,
--  no backfill (pre-slice applications legitimately have null proposed terms).
--
--  GROUND TRUTH (verified live this session, head cff332fa, ceiling 084):
--   · events(id uuid, property_id, person_id, unit_id, type text, note text,
--     occurred_at) — NO json column → the CONFIRMATION ROW is the authoritative
--     record; events.id is linked via confirmation.event_id; the event note
--     carries a human-readable trace only.
--   · lease_applications + lease_packets both carry id, application_id (packets),
--     property_id → composite-FK exact lineage is buildable.
--   · gen_random_uuid() available.
--   · 075 columns present + unwritten: term_source (CHECK), terms_completed_at,
--     terms_completed_by (bare uuid, no FK → safe for operator user id).
--
--  ADDITIVE + IDEMPOTENT: create-if-not-exists / add-if-not-exists; every
--  constraint guarded by name so re-run is a no-op.
-- ════════════════════════════════════════════════════════════════════

-- ── composite candidate keys on the TARGET/PARENT tables (needed so the
--    composite foreign keys below have a unique to reference) ──
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lease_applications_id_property_uq') then
    alter table lease_applications add constraint lease_applications_id_property_uq unique (id, property_id);
  end if;
end $$;

-- ── the immutable confirmation record ──
create table if not exists application_proposed_terms_confirmations (
  id                         uuid primary key default gen_random_uuid(),
  application_id             uuid not null references lease_applications(id),
  property_id                uuid not null references properties(id),
  actor_user_id              uuid not null references users(id),
  event_id                   uuid not null unique references events(id),
  rent                       numeric not null,
  security_deposit           numeric not null,
  lease_start_date           date not null,
  lease_end_date             date not null,
  concession_status          text not null,
  source                     text not null,
  authority_basis            text not null,
  idempotency_key            text not null,
  payload_hash               text not null,
  supersedes_confirmation_id uuid null,
  created_at                 timestamptz not null default now(),
  -- r1: server-scoped idempotency (browser key not authoritative across operators)
  constraint aptc_app_actor_key_uq unique (application_id, actor_user_id, idempotency_key),
  -- r2: composite candidate key so child composite FKs can reference exact lineage
  constraint aptc_id_app_prop_uq   unique (id, application_id, property_id),
  -- r2: composite candidate key for successor-same-application FK
  constraint aptc_id_app_uq        unique (id, application_id),
  constraint aptc_dates_ck         check (lease_end_date > lease_start_date),
  constraint aptc_source_ck        check (source = 'operator_proposed_terms'),
  constraint aptc_authority_ck     check (authority_basis in ('owner','role_authority','managed_role_override')),
  -- r2: none-only in SCHEMA this slice; 'structured' + its offer/schedule reference is a later migration
  constraint aptc_concession_ck    check (concession_status = 'none')
);

-- r2: successor must belong to the SAME application (DB fact, not service promise)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'aptc_successor_same_app_fk') then
    alter table application_proposed_terms_confirmations
      add constraint aptc_successor_same_app_fk
      foreign key (supersedes_confirmation_id, application_id)
      references application_proposed_terms_confirmations (id, application_id);
  end if;
end $$;

-- r1: at most one successor per confirmation (no forked supersession chains)
create unique index if not exists proposed_terms_one_successor
  on application_proposed_terms_confirmations (supersedes_confirmation_id)
  where supersedes_confirmation_id is not null;

-- ── current pointer on the application, with COMPOSITE-FK exact lineage ──
alter table lease_applications add column if not exists proposed_terms_confirmation_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'la_proposed_terms_lineage_fk') then
    alter table lease_applications
      add constraint la_proposed_terms_lineage_fk
      foreign key (proposed_terms_confirmation_id, id, property_id)
      references application_proposed_terms_confirmations (id, application_id, property_id);
  end if;
end $$;

-- ── current pointer on the packet, with COMPOSITE-FK exact lineage ──
alter table lease_packets add column if not exists proposed_terms_confirmation_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lp_proposed_terms_lineage_fk') then
    alter table lease_packets
      add constraint lp_proposed_terms_lineage_fk
      foreign key (proposed_terms_confirmation_id, application_id, property_id)
      references application_proposed_terms_confirmations (id, application_id, property_id);
  end if;
end $$;

-- ── durable issuance identity on the packet (r2 #3 — makes one-time-issue /
--    honest retry real; without it P16 is not implementable) ──
alter table lease_packets add column if not exists issue_actor_user_id  uuid references users(id);
alter table lease_packets add column if not exists issue_idempotency_key text;
alter table lease_packets add column if not exists issued_at             timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lp_issue_identity_all_or_none') then
    alter table lease_packets
      add constraint lp_issue_identity_all_or_none check (
        (issue_idempotency_key is null and issue_actor_user_id is null and issued_at is null)
        or
        (issue_idempotency_key is not null and issue_actor_user_id is not null and issued_at is not null)
      );
  end if;
end $$;

-- ── extend term_source vocabulary: the governed operator-confirmed value ──
--    (075 allowed application_capture | confirm_term_repair | null; the packet
--     gate will REQUIRE operator_proposed_terms so applicant seeds can't pass.)
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'la_term_source_ck') then
    alter table lease_applications drop constraint la_term_source_ck;
  end if;
  alter table lease_applications
    add constraint la_term_source_ck
    check (term_source is null or term_source in
      ('application_capture','confirm_term_repair','operator_proposed_terms'));
end $$;
