-- ════════════════════════════════════════════════════════════════════
--  164_legal_entities.sql — "1850 N 18TH HOLDINGS LLC IS A REAL LEGAL
--  ENTITY RELATED TO THIS PROPERTY." THAT FACT, AND NOTHING ELSE.
--
--  ── WHY IT IS NOT OWNED BY TAXES ────────────────────────────────────
--  BIRT and NPT are obligations of the TAXPAYER, not of the property, so
--  Taxes needs a subject to attach them to. But the taxpayer is the same
--  real-world object the later ownership and debt work will need, and a
--  `tax_taxpayers` table would guarantee two tables for one fact — §17,
--  which counts that as a defect even while the two agree.
--
--  So this lives outside Taxes, in its own module, and Taxes REFERENCES
--  it. When ownership/debt onboarding lands it EXTENDS this rather than
--  minting a rival.
--
--  ── ⚠ `organizations` IS NOT THIS, AND IT LOOKS LIKE IT ─────────────
--  organizations (093) is the SaaS TENANT: plan starter|growth|enterprise,
--  slug, status, owner_email. It is "The Felix Group as a Spine customer".
--  Migration 154's "owner" means WHICH SPINE ORG HOLDS THE DEAL — an
--  authority fact.
--
--  Neither is "1850 N 18th Holdings LLC as a BIRT taxpayer". Hanging a
--  tax obligation off organizations would conflate the customer with the
--  taxpayer, and it would look correct for a long time.
--
--  ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────
--  No ownership percentages. No waterfalls. No cap table. No beneficial
--  ownership. No signatures. No org charts. No deal-setup flow. Those are
--  the later onboarding stage CLAUDE.md reserves, and this must not spend
--  that ground by arriving early and half-built.
--
--  Also absent: EIN and Philadelphia tax account numbers. A tax
--  identifier is how ONE JURISDICTION names this entity, not what the
--  entity IS — the same distinction 161 draws between a policy number and
--  a coverage's identity. Tax identifiers stay in Taxes unless later
--  source work proves a canonical identifier belongs here.
--
--  ── entity_type IS EVIDENCE, NEVER A RULE ENGINE ────────────────────
--  It is recorded because it is a real attribute of the entity and it is
--  supporting evidence for questions like NPT applicability — Philadelphia
--  exempts corporations from NPT.
--
--  ⚠ IT MUST NEVER DECIDE APPLICABILITY BY ITSELF. `entity_type =
--  'corporation'` is not a governed finding that NPT does not apply; it is
--  a reason to go and establish one. Inferring the conclusion from the
--  attribute is precisely the healthy-state-from-absence this repo keeps
--  paying for, and Taxes requires governed applicability evidence instead.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

create table if not exists legal_entities (
  id                     uuid primary key default gen_random_uuid(),

  --  The name on the formation document. Not a display name, not a
  --  trading name — those may follow later if something needs them.
  legal_name             text not null check (length(btrim(legal_name)) > 0),

  --  Evidence about the entity, not a switch anything branches on.
  entity_type            text check (entity_type in
                           ('llc','lp','llp','corporation','s_corporation',
                            'trust','partnership','individual','other')),

  --  Where it was formed. A Delaware LLC operating in Philadelphia is
  --  ordinary, and the two jurisdictions answer different questions.
  formation_jurisdiction text,

  --  Provenance, on the same rule every governed fact in this repo
  --  follows: a document, or a stated account of where this came from.
  --  Never neither.
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  created_at             timestamptz not null default now(),

  constraint ck_legal_entity_provenance
    check (source_artifact_id is not null
           or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

--  ── THE RELATIONSHIP, AND IT IS NAMED ──────────────────────────────
--  NOT an ambiguous "entity belongs to property" edge. An entity that
--  OWNS a property and an entity that OPERATES it are different facts
--  with different consequences, and a tax obligation may attach to one
--  and not the other. An unnamed edge would force every later reader to
--  guess which was meant.
--
--  EFFECTIVE-DATED, because ownership and operating arrangements change
--  and last year's tax position must stay explainable afterwards. Same
--  slice discipline as insurance allocations and funding.
create table if not exists legal_entity_properties (
  id                     uuid primary key default gen_random_uuid(),
  legal_entity_id        uuid not null references legal_entities(id) on delete restrict,
  property_id            uuid not null references properties(id) on delete restrict,

  relationship_type      text not null check (relationship_type in
                           ('owner','operating_entity','other')),

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_lep_slice check (effective_to is null or effective_to > effective_from),
  constraint ck_lep_provenance
    check (source_artifact_id is not null
           or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

create index if not exists idx_lep_property
  on legal_entity_properties (property_id, effective_from);
create index if not exists idx_lep_entity
  on legal_entity_properties (legal_entity_id);

--  ONE live relationship of a given KIND per (entity, property). An
--  entity can be both owner and operating entity — that is two rows and
--  two truths. What it cannot be is the owner twice over the same dates.
create unique index if not exists uq_lep_live_relationship
  on legal_entity_properties (legal_entity_id, property_id, relationship_type)
  where effective_to is null;

--  Entity formation documents and operating agreements, so the entity can
--  point at what established it.
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule',
                           'insurance_finance_agreement','insurance_escrow_statement',
                           'entity_formation_document','operating_agreement'));
