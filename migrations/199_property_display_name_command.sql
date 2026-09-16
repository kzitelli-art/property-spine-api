-- ════════════════════════════════════════════════════════════════════
-- 199 · GOVERNED PROPERTY DISPLAY NAME
--
-- `properties.name` is a load-bearing internal identity in legacy paths.
-- `display_name` is the human-facing label. Migration 060 created that
-- label but gave it no governed authoring path and no history. This table
-- records every change without turning the label into identity.
--
-- Additive. No property is renamed by this migration.
-- ════════════════════════════════════════════════════════════════════

create table if not exists property_display_name_changes (
  id                  uuid primary key default gen_random_uuid(),
  property_id         uuid not null references properties(id),
  before_display_name text,
  after_display_name  text not null,
  actor_person_id     uuid references persons(id),
  actor_user_id       uuid not null references users(id),
  authority_basis     text not null,
  reason              text,
  idempotency_key     text,
  changed_at          timestamptz not null default now(),

  constraint ck_pdnc_after_nonblank check (btrim(after_display_name) <> ''),
  constraint ck_pdnc_authority check (authority_basis = 'platform_role:super_admin')
);

create index if not exists idx_pdnc_property
  on property_display_name_changes (property_id, changed_at desc);

create unique index if not exists uq_pdnc_idempotency
  on property_display_name_changes (property_id, idempotency_key)
  where idempotency_key is not null;

create or replace function refuse_property_display_name_change_mutation()
returns trigger language plpgsql as $$
begin
  raise exception
    'property_display_name_changes is immutable: % refused. Record a new change instead.',
    tg_op
    using errcode = 'raise_exception';
end $$;

drop trigger if exists trg_pdnc_immutable on property_display_name_changes;
create trigger trg_pdnc_immutable
  before update or delete on property_display_name_changes
  for each row execute function refuse_property_display_name_change_mutation();

