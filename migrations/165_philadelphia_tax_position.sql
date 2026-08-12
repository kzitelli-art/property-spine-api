-- ════════════════════════════════════════════════════════════════════
--  165_philadelphia_tax_position.sql — THE GOVERNED TAX DOMAIN.
--  Philadelphia is the first jurisdiction. It is not the only shape.
--
--  FOUR OBLIGATIONS IN V1:
--      real_estate · birt · npt · uo
--  Commercial Trash is deliberately NOT here. It is a municipal fee with
--  its own exemption machinery and it belongs to a broader property-
--  obligations area if it ever earns governed treatment.
--
--  ── THE LIABLE SUBJECT IS THE WHOLE DESIGN ──────────────────────────
--  These are NOT the same kind of obligation and must not be keyed alike:
--
--      real_estate   the PROPERTY owes it. OPA-based.
--      uo            tied to business USE of the property.
--      birt / npt    the TAXPAYER owes it — a legal entity, which may
--                    hold several properties.
--
--  So an obligation names exactly one subject, and PostgreSQL enforces
--  which of the two shapes it is. A loose `subject_type text` +
--  `subject_id uuid` would let a typo point an obligation at nothing and
--  no constraint would notice.
--
--  ⚠ BIRT/NPT ATTACH TO legal_entities, NEVER TO organizations.
--  organizations (093) is the SaaS TENANT — plan starter|growth|
--  enterprise. It is the Spine customer, not the taxpayer. There is no
--  column here that could reach it.
--
--  ── ONE ENTITY OBLIGATION IS ONE OBLIGATION ─────────────────────────
--  An entity holding two properties has ONE BIRT obligation, related to
--  both. It must never become two. That is why the property relationship
--  is a separate table rather than a column: a column would force a row
--  per property and duplicate the tax truth silently.
--
--  ── APPLICABILITY IS FIRST-CLASS, AND NEVER INFERRED ────────────────
--  Absence of an applicability row means NOT ESTABLISHED. It does not
--  mean "does not apply". Philadelphia exempts corporations from NPT —
--  and `entity_type = 'corporation'` is a REASON to go establish that
--  finding, never the finding. A residential property does not prove U&O
--  is inapplicable if commercial space exists.
--
--  ── FILING AND PAYMENT ARE DIFFERENT CLOCKS ─────────────────────────
--  A filed BIRT return does not make BIRT paid. A BIRT payment does not
--  mean the return was filed. Two tables, two dated facts, two evidence
--  chains. Collapsing them into one `status` is how a filed-but-unpaid
--  obligation comes to read CURRENT.
--
--  ── AND ESCROW IS NOT PAYMENT ───────────────────────────────────────
--  Nothing in this file knows escrow exists. Funding lives behind
--  `gate_funding_boundary.js`, which fails the build if anything here
--  reaches it. A fully funded escrow is not a paid tax; only City
--  payment evidence is.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

--  ── THE OBLIGATION ─────────────────────────────────────────────────
create table if not exists tax_obligations (
  id                     uuid primary key default gen_random_uuid(),

  --  Philadelphia is first, not only. Another jurisdiction implements its
  --  own rules module against the same shape.
  jurisdiction           text not null default 'philadelphia_pa',
  tax_type               text not null check (tax_type in
                           ('real_estate','birt','npt','uo')),

  --  EXACTLY ONE SUBJECT, enforced by the database rather than by care.
  liable_property_id     uuid references properties(id) on delete restrict,
  liable_legal_entity_id uuid references legal_entities(id) on delete restrict,

  --  The span this obligation is FOR. A tax year for real_estate/birt/npt,
  --  a month for uo. One shape carries every cadence, so nothing needs a
  --  second table when a rhythm differs.
  period_start           date not null,
  period_end             date not null,

  --  How this jurisdiction names the account. An OPA number for real
  --  estate, a City tax account for BIRT/NPT/U&O. It is EVIDENCE of how
  --  the City refers to this obligation, not the obligation's identity —
  --  same rule 161 applies to policy numbers.
  account_identifier     text,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_tax_obl_period check (period_end > period_start),
  --  One subject. Not zero, not two.
  constraint ck_tax_obl_one_subject check (
    (liable_property_id is not null)::int
    + (liable_legal_entity_id is not null)::int = 1),
  --  The property taxes are property-subject; the entity taxes are
  --  entity-subject. Enforced, because attaching BIRT to a property is
  --  exactly the mistake this domain exists to prevent.
  constraint ck_tax_obl_subject_matches_type check (
    (tax_type in ('real_estate','uo') and liable_property_id is not null)
    or (tax_type in ('birt','npt') and liable_legal_entity_id is not null)),
  constraint ck_tax_obl_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);

--  One obligation per subject per type per period. A second BIRT 2025 for
--  the same entity is the same obligation stated twice.
create unique index if not exists uq_tax_obl_entity_period
  on tax_obligations (tax_type, liable_legal_entity_id, period_start)
  where liable_legal_entity_id is not null;
create unique index if not exists uq_tax_obl_property_period
  on tax_obligations (tax_type, liable_property_id, period_start)
  where liable_property_id is not null;

create index if not exists idx_tax_obl_property on tax_obligations (liable_property_id);
create index if not exists idx_tax_obl_entity on tax_obligations (liable_legal_entity_id);

--  ── WHICH PROPERTIES AN OBLIGATION TOUCHES ─────────────────────────
--  An entity obligation surfaces on each related property's screen while
--  remaining ONE obligation. A property-subject obligation relates to its
--  own property so one read serves both shapes.
create table if not exists tax_obligation_properties (
  id                     uuid primary key default gen_random_uuid(),
  obligation_id          uuid not null references tax_obligations(id) on delete cascade,
  property_id            uuid not null references properties(id) on delete restrict,
  constraint uq_tax_obl_prop unique (obligation_id, property_id)
);
create index if not exists idx_tax_obl_prop_property
  on tax_obligation_properties (property_id);

--  ── APPLICABILITY ──────────────────────────────────────────────────
--  A STANDING determination, not a per-period one: "does U&O apply to
--  this property" is answered once and re-answered when the world
--  changes, so it is dated rather than tied to a tax year.
--
--  ⚠ ABSENCE IS `NOT ESTABLISHED`, AND THE READ MUST SAY SO. There is no
--  `unknown` value here on purpose: an unknown is the LACK of a row, and
--  storing it would let somebody write "unknown" and then treat the row's
--  existence as an answer.
create table if not exists tax_obligation_applicability (
  id                     uuid primary key default gen_random_uuid(),
  jurisdiction           text not null default 'philadelphia_pa',
  tax_type               text not null check (tax_type in
                           ('real_estate','birt','npt','uo')),

  --  Same two-shape subject rule as the obligation.
  subject_property_id    uuid references properties(id) on delete restrict,
  subject_legal_entity_id uuid references legal_entities(id) on delete restrict,

  determination          text not null check (determination in ('applies','not_applicable')),
  --  WHY. A determination with no reason cannot be re-examined later,
  --  and "not applicable" is the one that will be questioned.
  basis                  text not null check (length(btrim(basis)) > 0),

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  --  Applicability is a HUMAN determination. It is never derived from an
  --  attribute, so it always has a confirming person.
  confirmed_by_user_id   uuid not null references users(id),
  confirmed_at           timestamptz not null default now(),

  supersedes_id          uuid references tax_obligation_applicability(id),
  revision_reason        text,

  constraint ck_tax_appl_one_subject check (
    (subject_property_id is not null)::int
    + (subject_legal_entity_id is not null)::int = 1),
  constraint ck_tax_appl_slice check (effective_to is null or effective_to > effective_from),
  constraint ck_tax_appl_revision check (
    supersedes_id is null or (revision_reason is not null
    and length(btrim(revision_reason)) > 0)),
  constraint ck_tax_appl_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
--  ⚠ ONE LIVE DETERMINATION PER SUBJECT PER TAX TYPE.
--  Without this, two determinations sharing an effective_from both stay
--  open and the read picks one by row order — so a property could be
--  simultaneously `applies` and `not_applicable` and the screen would
--  show whichever arrived first. Contradictory institutional truth is
--  worse than no truth, and this makes it unrepresentable.
--
--  Restating on the SAME day is a CORRECTION and carries supersedes_id,
--  which drops the predecessor out of the live set. Changing on a LATER
--  day is a new slice and closes the prior one.
create unique index if not exists uq_tax_appl_one_live_property
  on tax_obligation_applicability (tax_type, subject_property_id)
  where subject_property_id is not null and effective_to is null
        and supersedes_id is null;
create unique index if not exists uq_tax_appl_one_live_entity
  on tax_obligation_applicability (tax_type, subject_legal_entity_id)
  where subject_legal_entity_id is not null and effective_to is null
        and supersedes_id is null;

create index if not exists idx_tax_appl_property
  on tax_obligation_applicability (subject_property_id, tax_type);
create index if not exists idx_tax_appl_entity
  on tax_obligation_applicability (subject_legal_entity_id, tax_type);

--  ── THE GOVERNED LIABILITY ─────────────────────────────────────────
--  What the CITY says is owed. Not what an assessment implies, and not
--  what a rate would compute.
--
--  ⚠ SPINE DOES NOT CALCULATE A TAX BILL. assessment_cents is a
--  SUPPORTING FACT recorded because it appears on the document and
--  explains the number. The governed liability is the City's figure. An
--  assessment × rate computation would produce a plausible number that
--  nobody owes, at the altitude where the number goes to a lender.
create table if not exists tax_liabilities (
  id                     uuid primary key default gen_random_uuid(),
  obligation_id          uuid not null references tax_obligations(id) on delete restrict,

  annual_liability_cents bigint not null check (annual_liability_cents >= 0),
  --  Supporting, never generative.
  assessment_cents       bigint check (assessment_cents >= 0),
  --  What the City's account shows outstanding as of the evidence date.
  --  Distinct from the liability: a paid bill has a liability and a zero
  --  balance, and an unpaid one has both.
  city_balance_cents     bigint check (city_balance_cents >= 0),
  balance_as_of          date,

  due_date               date not null,
  currency_code          text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  --  A CORRECTION restates the same claim — an adjusted City bill, a
  --  transcription fixed. The predecessor stays readable so "what did we
  --  think the tax was, and when did it change" is answerable.
  supersedes_id          uuid references tax_liabilities(id),
  revision_reason        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint ck_tax_liab_revision check (
    supersedes_id is null or (revision_reason is not null
    and length(btrim(revision_reason)) > 0)),
  constraint ck_tax_liab_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
create index if not exists idx_tax_liab_obligation on tax_liabilities (obligation_id);
create unique index if not exists uq_tax_liab_one_successor
  on tax_liabilities (supersedes_id) where supersedes_id is not null;

--  ── FILING — ITS OWN FACT ──────────────────────────────────────────
create table if not exists tax_filings (
  id                     uuid primary key default gen_random_uuid(),
  obligation_id          uuid not null references tax_obligations(id) on delete restrict,
  filed_at               date not null,
  --  A return, an estimate, or an extension are different filings against
  --  one obligation, and an extension is emphatically not a return.
  filing_kind            text not null default 'return' check (filing_kind in
                           ('return','estimate','extension','amended_return')),
  confirmation_reference text,
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),
  constraint ck_tax_filing_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
create index if not exists idx_tax_filing_obligation on tax_filings (obligation_id);

--  ── PAYMENT — ITS OWN FACT, AND THE CITY IS THE AUTHORITY ──────────
--  ⚠ THIS IS WHAT `PAID` MEANS. Not a funded escrow, not a lender saying
--  they escrow taxes, not a healthy balance. Evidence that the City was
--  paid. Funding cannot write this table and the boundary gate enforces
--  it structurally.
create table if not exists tax_payments (
  id                     uuid primary key default gen_random_uuid(),
  obligation_id          uuid not null references tax_obligations(id) on delete restrict,
  paid_at                date not null,
  amount_cents           bigint not null check (amount_cents > 0),
  --  Who actually remitted. A lender paying from escrow is still a City
  --  payment; recording WHO paid keeps the story explainable without
  --  making the escrow the proof.
  paid_by                text check (paid_by in ('property','lender_escrow','other')),
  confirmation_reference text,
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),
  constraint ck_tax_payment_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
create index if not exists idx_tax_payment_obligation on tax_payments (obligation_id);

--  ── ASSESSMENT APPEAL ──────────────────────────────────────────────
--  An open appeal is a real operating fact and it changes NOTHING about
--  the current liability. Recording it as a flag on the liability would
--  invite exactly that mistake.
create table if not exists tax_appeals (
  id                     uuid primary key default gen_random_uuid(),
  obligation_id          uuid not null references tax_obligations(id) on delete restrict,
  opened_on              date not null,
  closed_on              date,
  outcome                text check (outcome in ('withdrawn','denied','reduced','other')),
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);
create index if not exists idx_tax_appeal_obligation on tax_appeals (obligation_id);

--  ── TAX CLEARANCE — COMPLIANCE EVIDENCE, NOT A FIFTH TAX ───────────
--  It may strengthen a standing read. It may NEVER manufacture a missing
--  liability, filing, payment or applicability. Where it disagrees with
--  obligation-level evidence, the read surfaces the CONFLICT rather than
--  quietly preferring one.
create table if not exists tax_clearances (
  id                     uuid primary key default gen_random_uuid(),
  jurisdiction           text not null default 'philadelphia_pa',
  subject_property_id    uuid references properties(id) on delete restrict,
  subject_legal_entity_id uuid references legal_entities(id) on delete restrict,
  issued_on              date not null,
  verified_through       date not null,
  certificate_reference  text,
  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,
  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),
  constraint ck_tax_clear_one_subject check (
    (subject_property_id is not null)::int
    + (subject_legal_entity_id is not null)::int = 1),
  constraint ck_tax_clear_window check (verified_through >= issued_on),
  constraint ck_tax_clear_provenance check (
    source_artifact_id is not null
    or (provenance_note is not null and length(btrim(provenance_note)) > 0))
);
create index if not exists idx_tax_clear_property on tax_clearances (subject_property_id);
create index if not exists idx_tax_clear_entity on tax_clearances (subject_legal_entity_id);

--  ── EVIDENCE KINDS ─────────────────────────────────────────────────
alter table source_artifacts drop constraint if exists source_artifacts_artifact_kind_check;
alter table source_artifacts add constraint source_artifacts_artifact_kind_check
  check (artifact_kind in ('rent_roll','other',
                           'insurance_policy','insurance_binder',
                           'insurance_invoice','insurance_allocation_schedule',
                           'insurance_finance_agreement','insurance_escrow_statement',
                           'entity_formation_document','operating_agreement',
                           'tax_bill','tax_balance_statement','tax_return',
                           'tax_payment_receipt','tax_clearance_certificate',
                           'tax_account_statement','tax_appeal_document'));
