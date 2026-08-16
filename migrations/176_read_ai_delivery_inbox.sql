-- ════════════════════════════════════════════════════════════════════
--  176 — READ AI CONNECTION AUTHORITY + IMMUTABLE DELIVERY INBOX
--
--  A meeting arrives from a machine, not a person. That is a new
--  authority class in this system and it needs saying out loud.
--
--  ── AN INTEGRATION IS NOT A HUMAN ───────────────────────────────────
--  Every retained source until now carried `uploaded_by_user_id NOT NULL`
--  and the service refuses without one: "a shared key is not an uploader."
--  A webhook has no session. The temptation is to write the authorizing
--  human into that column, which would be a lie of exactly the kind §5
--  forbids — it would say a person uploaded a thing at a moment they were
--  not present.
--
--  So the integration is its own authority class. It is source authority
--  FOR DELIVERY and nothing else:
--
--      NOT an operating human      NOT a decision-maker
--      NOT a property owner        NOT a task owner
--
--  A named human authorizes the connection once, and that fact is durable.
--  Every delivery points at the CONNECTION, never at the human.
--
--  ── THE INBOX IS NOT PROPERTY EVIDENCE ──────────────────────────────
--  A verified delivery is authenticated. It is not yet ABOUT anything:
--  Read does not know Spine's property authority model and must never be
--  allowed to assert into it. So there is no property_id here, and none
--  is inferred from a title. "Weekly SOLO Meeting" is a string.
--
--      verified delivery → UNBOUND INBOX → governed binding
--                                        → property-scoped evidence
--
--  `source_artifacts` is NOT weakened to allow an unscoped artifact. The
--  inbox is a different table for a different thing, and Ask Spine cannot
--  read it.
--
--  ── TWO IDENTITIES, TWO JOBS ────────────────────────────────────────
--      request_id   identifies a DELIVERY. Read retries on non-2xx, so
--                   the same request_id may arrive many times. Unique.
--      session_id   identifies the MEETING. A manual re-push of the same
--                   meeting arrives with a NEW request_id, so dedup on
--                   request_id alone would create a second August 10.
--
--  Two deliveries of one meeting is a legitimate state: two immutable
--  delivery rows, one provider meeting. If their bytes differ that is a
--  provider revision, preserved and flagged, never silently replaced.
--
--  ── UNVERIFIED BYTES ARE NOT EVIDENCE ───────────────────────────────
--  A missing or bad signature is refused BEFORE storage. What survives is
--  a security receipt — when, what hash, which connection, why refused —
--  and never the body. Storing unverified payloads beside verified ones is
--  how a corpus gets poisoned by anyone who learns the URL.
--
--  ── SAFETY CONTRACT ─────────────────────────────────────────────────
--    · three NEW tables, referenced by nothing that exists
--    · no existing column, constraint or index altered or dropped
--  OLD CODE against NEW SCHEMA is therefore safe.
--
--  CLASS 1 — permanent.
-- ════════════════════════════════════════════════════════════════════


-- ── 1. THE CONNECTION — a named human authorised a machine ──────────
create table if not exists provider_connections (
  id                     uuid primary key default gen_random_uuid(),

  provider               text not null check (provider in ('read_ai')),

  --  WHO authorised this, and when. Server-derived at the time, and the
  --  reason this table exists rather than a config value.
  authorized_by_user_id  uuid not null references users(id),
  authorized_at          timestamptz not null default now(),

  --  A REFERENCE to the signing secret, never the secret. The secret
  --  lives in the environment; this records WHICH one, so rotation is a
  --  visible act rather than a silent one.
  signing_secret_ref     text not null,

  --  Provider-side identity of the connection, when the provider gives
  --  one. Nullable because we have not yet seen a real payload and will
  --  not invent a field shape for it (see 175's date lesson).
  provider_account_ref   text,

  status                 text not null default 'active'
                           check (status in ('active','revoked')),
  revoked_at             timestamptz,
  revoked_by_user_id     uuid references users(id),

  constraint ck_pc_revoked_is_complete check (
    (status = 'active'  and revoked_at is null and revoked_by_user_id is null) or
    (status = 'revoked' and revoked_at is not null)
  )
);

create index if not exists provider_connections_active_idx
  on provider_connections(provider) where status = 'active';


-- ── 2. THE DELIVERY — exact bytes, verified, unbound ────────────────
create table if not exists provider_deliveries (
  id                  uuid primary key default gen_random_uuid(),

  connection_id       uuid not null references provider_connections(id) on delete restrict,

  --  DELIVERY IDENTITY. Unique: a retry of the same delivery is the same
  --  row, which is what makes the endpoint idempotent under Read's
  --  retry policy.
  request_id          text not null,

  --  MEETING IDENTITY. Read only after the signature verifies and the
  --  body parses, which is why it is nullable at insert time in code but
  --  always present in practice for a well-formed delivery.
  session_id          text,

  --  THE BYTES, EXACTLY AS RECEIVED. Not re-serialised. The signature was
  --  computed over these and nothing else, so anything that reorders keys
  --  or normalises whitespace destroys the ability to re-verify.
  raw_body            bytea not null,
  raw_sha256          text not null check (raw_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size           integer not null check (byte_size > 0),

  --  THE VERIFICATION FACT. A row exists only if this is true; the column
  --  is here so the fact is recorded rather than implied by presence.
  signature_verified  boolean not null default true check (signature_verified),
  signature_header    text not null,

  received_at         timestamptz not null default now(),

  --  Nothing is processed inside the request. Read retries up to 25 times
  --  on a non-2xx, so a model call in the request path is a processing
  --  storm waiting for a slow day.
  processing_state    text not null default 'pending_processing'
                        check (processing_state in
                          ('pending_processing','transcript_read','bound','failed')),
  processing_note     text,

  constraint uq_pd_request unique (connection_id, request_id)
);

create index if not exists provider_deliveries_session_idx
  on provider_deliveries(connection_id, session_id) where session_id is not null;
create index if not exists provider_deliveries_pending_idx
  on provider_deliveries(processing_state) where processing_state = 'pending_processing';


-- ── 3. REFUSALS — the receipt, never the body ───────────────────────
--  A refused delivery leaves a trace, because an endpoint that silently
--  drops bad signatures cannot tell you it is under attack. The body is
--  NOT kept: it is unauthenticated input, and the only safe thing to
--  remember about it is that it arrived and did not verify.
create table if not exists provider_delivery_refusals (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,
  connection_id       uuid references provider_connections(id) on delete set null,
  reason              text not null
                        check (reason in ('missing_signature','bad_signature',
                                          'unknown_connection','revoked_connection',
                                          'body_too_large','empty_body')),
  --  A hash of what arrived, so a repeated attack is recognisable without
  --  retaining anything an attacker chose to send us.
  body_sha256         text check (body_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size           integer,
  received_at         timestamptz not null default now()
);

create index if not exists provider_delivery_refusals_recent_idx
  on provider_delivery_refusals(received_at desc);


-- ── 4. IMMUTABLE, ENFORCED BY THE DATABASE ──────────────────────────
--  Same mechanism as mts_immutable (175) and lcoe_append_only (069).
--  `processing_state` is the ONE thing that legitimately changes, so it
--  is excluded — everything about the delivery itself is frozen.
create or replace function pd_reject_mutation() returns trigger as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'provider_deliveries is append-only: DELETE is not permitted'
      using errcode = 'raise_exception';
  end if;
  if new.raw_body   is distinct from old.raw_body
     or new.raw_sha256    is distinct from old.raw_sha256
     or new.request_id    is distinct from old.request_id
     or new.session_id    is distinct from old.session_id
     or new.connection_id is distinct from old.connection_id
     or new.received_at   is distinct from old.received_at
     or new.signature_verified is distinct from old.signature_verified then
    raise exception 'provider_deliveries evidence is immutable: only processing_state may change'
      using errcode = 'raise_exception';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists pd_immutable on provider_deliveries;
create trigger pd_immutable
  before update or delete on provider_deliveries
  for each row execute function pd_reject_mutation();
