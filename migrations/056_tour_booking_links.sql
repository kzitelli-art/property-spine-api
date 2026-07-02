-- ════════════════════════════════════════════════════════════════════
--  056_tour_booking_links.sql
--
--  WHY: the boardroom demo needs a PUBLIC "book a tour" door that a prospect
--  can use straight from the /demo/intake receipt — with NO operator key and
--  WITHOUT ever exposing a raw database id (lead_id / conversation_id) to the
--  browser. Every existing tour/booking route is requireOperator; there is no
--  public booking path today. This table is the signed continuation authority
--  for that new public door (leasingleads.js POST /demo/book).
--
--  PATTERN: identical security model to application_invitations (051) and
--  lease_packets (034): we store ONLY a non-recoverable sha256 digest of the
--  bearer token. The raw token exists solely in the receipt handed to the
--  prospect. /demo/book hashes the presented token and matches the digest.
--  A DB leak yields no working links. Reuses the codebase's established
--  randomBytes(base64url) → sha256(digest) → timingSafeEqual convention.
--
--  SCOPE WALL: property_id is captured at MINT time (always the Demo Building,
--  server-derived). /demo/book verifies the resolved property is the Demo
--  Building and refuses anything else — a booking link can NEVER be aimed at a
--  live property even if the row were tampered with. The phone on the booking
--  request is a CONSISTENCY CHECK only, never write authority.
--
--  IDEMPOTENT: create table / index if not exists. Safe to re-run. The
--  authenticated /leasing/slots/:slotId/book path is untouched — it does not
--  use this table.
-- ════════════════════════════════════════════════════════════════════

create table if not exists tour_booking_links (
  id                    uuid primary key default gen_random_uuid(),

  -- SECURITY: store ONLY the digest. Raw token lives solely in the issued
  -- receipt. /demo/book matches sha256(presented) against this.
  token_digest          text not null unique,

  -- who/where this booking link is for. All captured at mint time so /demo/book
  -- never re-derives identity from the browser. conversation_id is the thread
  -- the booked tour attaches to; the projection derives commercial_state=
  -- booked_tour from the resulting live tour (no status is mutated).
  conversation_id       uuid not null references conversations(id) on delete cascade,
  person_id             uuid references persons(id) on delete set null,
  lead_id               uuid references leasing_leads(id) on delete set null,

  -- SCOPE WALL: always the Demo Building at mint. /demo/book re-verifies.
  property_id           uuid not null references properties(id) on delete cascade,

  -- CONSISTENCY (not authority): the phone captured at intake. /demo/book may
  -- compare a presented phone against this, but the token is the sole authority.
  phone_snapshot        text,

  -- filled when the link is consumed by a successful booking (the consume step).
  booked_tour_id        uuid references leasing_tours(id) on delete set null,

  -- lifecycle. 'issued' at mint; 'consumed' on successful book; 'expired' past
  -- the window; 'revoked' if a demo reset invalidates outstanding links.
  status                text not null default 'issued'
                          check (status in ('issued','consumed','expired','revoked')),

  -- demo linkage (optional): ties a link to the demo run/attempt that minted it,
  -- so a demo reset can revoke outstanding links for that run.
  demo_run_id           uuid,

  expires_at            timestamptz,                 -- short window; null = no auto-expiry
  consumed_at           timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- fast lookup by digest on every /demo/book call (unique already indexes it,
-- but name it explicitly for clarity of intent).
create index if not exists tour_booking_links_digest_idx
  on tour_booking_links(token_digest);

-- find outstanding links for a conversation or demo run (revoke on reset).
create index if not exists tour_booking_links_conversation_idx
  on tour_booking_links(conversation_id);
create index if not exists tour_booking_links_demo_run_idx
  on tour_booking_links(demo_run_id) where demo_run_id is not null;
