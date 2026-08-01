-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 123 — PROPERTY OPERATING TIMEZONE (Slice 9, step 1)
--
--  Until now a property's operating timezone lived in a HARDCODED ALLOWLIST
--  of one UUID inside src/shared/property_timezone.js, plus an env map for
--  QA rigs. Every other property resolved to null, so no dated metric —
--  "tours completed today", "no-shows this week" — was definable anywhere
--  except Demo Building. This column is the prerequisite for every metric
--  Slice 9 ships.
--
--  ── OWNER RULING 1 (2026-08-01) ──────────────────────────────────────
--   · nullable;
--   · valid IANA timezone only;
--   · NO UNIVERSAL DEFAULT — a property with no configured timezone has no
--     operating day, and its dated metrics must report unavailable rather
--     than borrow someone else's midnight;
--   · backfill Demo Building to America/New_York ONLY, because that fact is
--     already explicitly encoded in the allowlist and is therefore a
--     migration of existing configuration, not a guess;
--   · do not guess for any other property.
--
--  Resolver order after this lands:
--      properties.operating_timezone
--        → explicit QA/test override (non-production only)
--        → null
--
--  The hardcoded property-UUID map is REMOVED in the same change. Hidden
--  production configuration is not preserved indefinitely as a fallback —
--  that is how a "temporary" allowlist becomes permanent shadow config.
--
--  VALIDATION: pg_timezone_names is the authority. A CHECK constraint cannot
--  call it (not immutable), so validity is enforced by a trigger on write.
--  That still makes the DATABASE the enforcement point rather than a service
--  promise — an invalid zone cannot be stored by any path.
--
--  IDEMPOTENT: add-column-if-not-exists throughout; migrate.js owns the
--  transaction — no BEGIN/COMMIT here.
-- ════════════════════════════════════════════════════════════════════

alter table properties add column if not exists operating_timezone text;

comment on column properties.operating_timezone is
  'IANA operating timezone. NULL = not configured; dated metrics must report '
  'state=unavailable, reason=property_operating_timezone_not_configured. '
  'There is deliberately no default (Slice 9 ruling 1).';

-- ── validity is enforced, not promised ──────────────────────────────
create or replace function ps_validate_operating_timezone() returns trigger as $$
begin
  if new.operating_timezone is not null then
    if btrim(new.operating_timezone) = '' then
      raise exception 'operating_timezone must be a valid IANA name, not blank';
    end if;
    if not exists (select 1 from pg_timezone_names where name = new.operating_timezone) then
      raise exception 'operating_timezone % is not a valid IANA timezone name', new.operating_timezone;
    end if;
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_validate_operating_timezone on properties;
create trigger trg_validate_operating_timezone
  before insert or update of operating_timezone on properties
  for each row execute function ps_validate_operating_timezone();

-- ── migrate the ONE already-encoded fact ────────────────────────────
--  This is the allowlist's own value for the Demo Building, moved from code
--  into data. It is not a guess, and no other property is touched.
--  Guarded on IS NULL so a later operator correction is never overwritten by
--  a re-run.
update properties
   set operating_timezone = 'America/New_York'
 where id = 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'
   and operating_timezone is null;

create index if not exists idx_properties_operating_timezone
  on properties (operating_timezone)
  where operating_timezone is not null;

-- ── AUDIT: every timezone change, with actor and reason ─────────────
--  Ruling 1B. A column with no authoring path leaves every property except
--  the backfilled one permanently unavailable, and an authoring path with no
--  audit is an unattributable change to what "today" means at a property.
create table if not exists property_operating_timezone_changes (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  before_timezone   text,                       -- null = first configuration
  after_timezone    text not null,
  -- person = canonical business actor; user = authentication provenance.
  -- The same distinction Slice 8 ruling 4 settled for pricing approval.
  actor_person_id   uuid references persons(id),
  actor_user_id     uuid not null references users(id),
  reason            text,
  idempotency_key   text,
  changed_at        timestamptz not null default now()
);

create index if not exists idx_pot_changes_property
  on property_operating_timezone_changes (property_id, changed_at desc);

-- A retried command returns the original receipt instead of writing a second
-- history row. Partial so rows without a key are unconstrained.
create unique index if not exists uq_pot_changes_idempotency
  on property_operating_timezone_changes (property_id, idempotency_key)
  where idempotency_key is not null;
