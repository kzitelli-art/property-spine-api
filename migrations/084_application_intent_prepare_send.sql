-- ════════════════════════════════════════════════════════════════════
-- 084 — application intent → prepare child → send child (v2.5-r1 frozen)
--
-- ADDITIVE. One atomic transaction; ledger insert LAST (hand-paste safe).
-- ABORT-ON-CONFLICT: the active-invitation exception scan STOPS this
-- migration (with the offending ids) rather than silently choosing a winner.
--
-- What this adds:
--  · obligations.parent_obligation_id  — the EXACT durable parent key
--  · obligations.resolution_code       — frozen terminal vocabulary
--  · obligations.ownership_origin / owner_eligibility_state — durable ownership
--    (assigned_user_id already exists), with the biconditional CHECK scoped to
--    the two new child types only
--  · application_intents               — structured, append-only intent record
--  · obligation_input_proofs           — first-class proof (not JSON-in-note)
--  · application_invitations.superseded_by_invitation_id — recovery lineage
--  · dedup indexes: one OPEN prepare child per conversation; one OPEN send
--    child per invitation; one ACTIVE invitation per conversation (explicit
--    statuses — never time arithmetic)
-- ════════════════════════════════════════════════════════════════════

begin;

-- ── obligations: exact parent + resolution + ownership ─────────────────
alter table obligations add column if not exists parent_obligation_id uuid references obligations(id);
alter table obligations add column if not exists resolution_code text;
alter table obligations add column if not exists ownership_origin text;
alter table obligations add column if not exists owner_eligibility_state text;

-- self-parent guard
alter table obligations drop constraint if exists ck_oblig_not_self_parent;
alter table obligations add constraint ck_oblig_not_self_parent
  check (parent_obligation_id is null or parent_obligation_id <> id);

-- frozen resolution vocabulary; only a complete obligation may carry one
alter table obligations drop constraint if exists ck_oblig_resolution_code;
alter table obligations add constraint ck_oblig_resolution_code
  check (resolution_code is null
         or resolution_code in ('satisfied','superseded','revoked','dispatch_refused','expired'));
alter table obligations drop constraint if exists ck_oblig_resolution_requires_complete;
alter table obligations add constraint ck_oblig_resolution_requires_complete
  check (resolution_code is null or status = 'complete');

-- ownership consistency, scoped to the two new child types only
-- (existing rows of other types are untouched)
alter table obligations drop constraint if exists ck_oblig_child_ownership;
alter table obligations add constraint ck_oblig_child_ownership
  check (
    type not in ('prepare_application_link','send_application_link')
    or (owner_eligibility_state is not null
        and ((assigned_user_id is null) = (owner_eligibility_state = 'unassigned')))
  );

-- ── application_intents: structured, append-only, successor-only lineage ──
create table if not exists application_intents (
  id                                   uuid primary key default gen_random_uuid(),
  property_id                          uuid not null references properties(id),
  conversion_id                        uuid not null references leasing_conversions(id),
  person_id                            uuid not null references persons(id),
  parent_tour_followup_obligation_id   uuid not null references obligations(id),
  source                               text not null
                                         check (source in ('post_tour_outcome','operator_recorded')),
  source_identity                      text not null,
  recorded_by_user_id                  uuid not null references users(id),
  occurred_at                          timestamptz not null default now(),
  recorded_at                          timestamptz not null default now(),
  evidence_type                        text,
  evidence_ref                         text,
  supersedes_intent_id                 uuid references application_intents(id),
  event_id                             uuid not null unique references events(id)
);
-- idempotency: one intent per (property, source, identity)
create unique index if not exists uq_application_intents_identity
  on application_intents (property_id, source, source_identity);
-- one-successor lineage (no branching)
create unique index if not exists uq_application_intents_one_successor
  on application_intents (supersedes_intent_id) where supersedes_intent_id is not null;

-- ── obligation_input_proofs: first-class proof for the two reserved codes ──
create table if not exists obligation_input_proofs (
  id                    uuid primary key default gen_random_uuid(),
  obligation_id         uuid not null references obligations(id),
  input_code            text not null
                          check (input_code in
                            ('application_invitation_prepared','application_invitation_sent')),
  intent_id             uuid references application_intents(id),
  invitation_id         uuid references application_invitations(id),
  parent_obligation_id  uuid references obligations(id),
  unit_id               uuid references units(id),
  actor_user_id         uuid references users(id),
  occurred_at           timestamptz not null default now(),
  recorded_at           timestamptz not null default now(),
  event_id              uuid unique references events(id),
  unique (obligation_id, input_code)
);

-- ── invitation recovery lineage ────────────────────────────────────────
alter table application_invitations
  add column if not exists superseded_by_invitation_id uuid references application_invitations(id);

-- ── dedup guarantees ──────────────────────────────────────────────────
-- one OPEN prepare child per conversation
create unique index if not exists uq_one_open_prepare_child_per_conversion
  on obligations (related_id)
  where type = 'prepare_application_link'
    and related_type = 'leasing_conversion'
    and status = 'open';

-- one OPEN send child per invitation (send child is invitation-specific:
-- related_type='application_invitation', related_id=<invitation>)
create unique index if not exists uq_one_open_send_child_per_invitation
  on obligations (related_id)
  where type = 'send_application_link'
    and related_type = 'application_invitation'
    and status = 'open';

-- ── EXCEPTION SCAN before the active-invitation index ─────────────────
-- ABORTS (with ids) if any conversation already has >1 active invitation.
do $$
declare bad record; msg text := '';
begin
  for bad in
    select conversion_id, array_agg(id order by created_at) as invitation_ids
      from application_invitations
     where conversion_id is not null
       and status in ('prepared','manually_sent','provider_dispatched')
     group by conversion_id having count(*) > 1
  loop
    msg := msg || format(' conversion %s → invitations %s;', bad.conversion_id, bad.invitation_ids);
  end loop;
  if msg <> '' then
    raise exception '084 ABORT: conversations with multiple ACTIVE invitations —%s resolve (revoke/expire the losers) before applying.', msg;
  end if;
end $$;

-- one ACTIVE invitation per conversation (explicit statuses, no time arithmetic)
create unique index if not exists uq_one_active_invitation_per_conversion
  on application_invitations (conversion_id)
  where conversion_id is not null
    and status in ('prepared','manually_sent','provider_dispatched');

insert into schema_migrations (version, name)
  values ('084', '084_application_intent_prepare_send.sql')
  on conflict (version) do nothing;

commit;
