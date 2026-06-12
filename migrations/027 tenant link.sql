-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 027 — TENANT LINK (Phase 1 of the building text line)
--
--  The product is "I text my building." Phase 1 is only the CONNECTION:
--  a tenant gets an invite link, proves they are the person on the lease,
--  and gains a scoped session. No SMS vendor yet (link-only pilot) — the
--  manager sends the link from their own phone; the API serves the
--  tenant-facing setup page itself.
--
--  Three new tables + one column:
--
--  conversations — the thread anchor. ONE per (person, property). Created
--    at invite time because the invite IS the first message of the
--    official thread. Messaging routes come in Phase 2; the anchor and
--    the attach rule are laid down now so nothing floats loose later.
--
--  tenant_invites — single-tenant, expiring, revocable setup links.
--    Resending supersedes the old active link (status 'superseded' +
--    superseded_by pointer) — never two live links for one person.
--    failed_attempts guards the link-only verification (phone match):
--    5 misses revokes the link. Phone is identity; no usernames/passwords.
--
--  tenant_sessions — browser session issued after verification. Scoped
--    to one person at one property. Expiring, revocable.
--
--  comm_events.conversation_id — comm_events (baseline 001) becomes the
--    message store going forward. Existing rows keep null (honest:
--    pre-conversation history was never threaded).
--
--  NOTE: migrate.js wraps each file in its own begin/commit and records
--  the ledger row. NO transaction control, NO ledger insert here.
-- ════════════════════════════════════════════════════════════════════

create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id) on delete cascade,
  person_id       uuid not null references persons(id) on delete cascade,
  unit_id         uuid references units(id) on delete set null,
  lease_id        uuid references leases(id) on delete set null,
  channel_primary text not null default 'sms',
  status          text not null default 'open',   -- open | archived
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (property_id, person_id)
);
create index if not exists idx_conversations_property on conversations(property_id);

create table if not exists tenant_invites (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references persons(id) on delete cascade,
  property_id     uuid not null references properties(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  token           text not null unique,
  status          text not null default 'active',
                  -- active | used | expired | revoked | superseded
  expires_at      timestamptz not null,
  used_at         timestamptz,
  superseded_by   uuid,                            -- newer invite id
  failed_attempts integer not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists idx_tenant_invites_person on tenant_invites(person_id);

create table if not exists tenant_sessions (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references persons(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  token       text not null unique,
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tenant_sessions_token on tenant_sessions(token);

alter table comm_events
  add column if not exists conversation_id uuid references conversations(id) on delete set null;
create index if not exists idx_comm_conversation on comm_events(conversation_id);
