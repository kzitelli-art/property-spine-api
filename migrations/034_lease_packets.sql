-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 034 — LEASE PACKETS (tenant-side input collector)
--
--  This table is NOT an activation engine. It is the tenant-facing surface
--  that collects initials/signature and, on final submit, satisfies the
--  ONE tenant input (`applicant_signature`, + `guarantor_signature`) on the
--  application's EXISTING activation obligation. It cannot set a lease
--  active. Only applications.js / completeObligation can do that.
--
--  Deliberately MISSING from this schema (by doctrine):
--    • no `active` status value — there is no terminal state here that
--      means "bound." The packet's life ends at `submitted`.
--    • no manager_countersigned_at / activated_at — countersign and
--      activation are owned by applications.js + the obligation row.
--    • no second status machine that mirrors lease_applications.
--
--  A packet is a CLAIM (tenant intent). The obligation it feeds is where
--  proof accrues; the application row is where truth is set, elsewhere.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── the packet: one per application (versioned), tenant-facing ─────────
create table if not exists lease_packets (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  application_id uuid not null references lease_applications(id) on delete cascade,
  unit_id       uuid references units(id) on delete set null,
  version       integer not null default 1,

  -- The packet's OWN lifecycle. Note what is absent: no 'active'. The
  -- furthest a packet goes is 'submitted' — tenant intent captured and
  -- handed to the obligation. Activation is not a packet concept.
  status        text not null default 'draft'
    check (status in (
      'draft',              -- generated, not yet sent
      'sent',               -- tenant link issued
      'tenant_in_progress', -- at least one field completed
      'submitted',          -- all required tenant fields done; obligation input satisfied
      'voided'
    )),

  -- terms used to render the packet. PLACEHOLDER-AWARE: a packet generated
  -- without a real template is flagged so it can never be mistaken for a
  -- real lease (see is_placeholder).
  terms_json        jsonb not null default '{}'::jsonb,
  rendered_snapshot jsonb not null default '{}'::jsonb,
  rendered_snapshot_hash text,

  -- TRUE until a real lease template fills the body. The tenant UI renders
  -- a loud placeholder banner while this is true. Generation refuses to
  -- pretend otherwise.
  is_placeholder    boolean not null default true,

  -- tenant access (hashed token; raw token only ever returned once, on send)
  tenant_token_hash       text,
  tenant_token_expires_at timestamptz,

  sent_at            timestamptz,
  tenant_submitted_at timestamptz,
  voided_at          timestamptz,
  void_reason        text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (application_id, version)
);

create index if not exists lease_packets_property_status_idx
  on lease_packets (property_id, status);
create index if not exists lease_packets_application_idx
  on lease_packets (application_id);
create index if not exists lease_packets_token_idx
  on lease_packets (tenant_token_hash);

-- ── packet fields: the section-level initials + the tenant signature ──
--  These are INTERNAL EVIDENCE of tenant review. They are NOT obligation
--  inputs. The whole set being complete is the precondition for the packet
--  to satisfy the single `applicant_signature` input on the obligation.
create table if not exists lease_packet_fields (
  id            uuid primary key default gen_random_uuid(),
  lease_packet_id uuid not null references lease_packets(id) on delete cascade,
  field_key     text not null,
  section_key   text not null,
  label         text not null,
  field_type    text not null
    check (field_type in ('initial','signature','acknowledgment')),
  -- v1 is tenant-only. guarantor/manager fields are a later concern; the
  -- guarantor's obligation input is satisfied by a separate future step,
  -- NOT by this table pretending to own it.
  signer_role   text not null default 'tenant'
    check (signer_role in ('tenant')),
  required      boolean not null default true,
  completed     boolean not null default false,
  completed_at  timestamptz,
  -- captured intent metadata (audit, not legal proof — see counsel note)
  field_value   text,
  session_id    text,
  ip_address    inet,
  user_agent    text,
  clause_hash   text,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (lease_packet_id, field_key)
);

create index if not exists lease_packet_fields_order_idx
  on lease_packet_fields (lease_packet_id, display_order);
create index if not exists lease_packet_fields_required_idx
  on lease_packet_fields (lease_packet_id, required, completed);

-- ── required city / property documents tracked in the packet ──────────
create table if not exists lease_packet_documents (
  id            uuid primary key default gen_random_uuid(),
  lease_packet_id uuid not null references lease_packets(id) on delete cascade,
  document_type text not null
    check (document_type in (
      'lease_body','rental_license','rental_suitability',
      'lead_disclosure','tenant_handbook','other'
    )),
  title         text not null,
  file_url      text,
  document_hash text,
  required_acknowledgment boolean not null default false,
  acknowledged_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists lease_packet_documents_packet_idx
  on lease_packet_documents (lease_packet_id);

-- ── packet audit trail (durable, append-only) ────────────────────────
create table if not exists lease_packet_audit_events (
  id            uuid primary key default gen_random_uuid(),
  lease_packet_id uuid not null references lease_packets(id) on delete cascade,
  actor_role    text not null,   -- 'operator' | 'tenant'
  event_type    text not null,
  event_json    jsonb not null default '{}'::jsonb,
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index if not exists lease_packet_audit_packet_time_idx
  on lease_packet_audit_events (lease_packet_id, created_at desc);
