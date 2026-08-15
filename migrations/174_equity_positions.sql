-- ════════════════════════════════════════════════════════════════════
--  174_equity_positions.sql — THE GOVERNED EQUITY & PREFERRED EQUITY
--  DOMAIN. Forced by a 15-deal portfolio survey, not by one clean
--  specimen — see docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md, walls E1–E10.
--
--  ── THIS DOMAIN'S DEFAULT FACT IS ABSENCE, AND THAT IS THE POINT ─────
--  Debt's specimen (4125's first mortgage) was well-governed by one
--  clean monthly statement. Equity's own specimen property shows a
--  well-governed preferred position (MSC) sitting beside a common tier
--  whose Schedule I literally reads "[OWNERSHIP/INVESTOR INFORMATION
--  MAINTAINED BY MANAGING MEMBER]" for 100% of $9,048,350 — and that
--  redaction is the norm across the surveyed portfolio, not the
--  exception. This schema is built to make that absence a first-class,
--  visible fact (equity_exposure), never a blank nobody notices and
--  never a gap silently filled with a plausible-looking name.
--
--  ── NOTHING ACCRUES IN ANY GENERAL LEDGER, ANYWHERE (E3) ────────────
--  Not one deal in the survey books a preferred-return accrual, at any
--  rate, at any deal. There is no accrued_balance column anywhere in
--  this file. Accrual is a READING of position(as_of) applied to dated
--  preferred terms, exactly like Debt's projected balance — never a
--  stored number, so it can never be read back as though someone had
--  actually computed and recorded it.
--
--  ── SOURCES DISAGREE, AND THAT DISAGREEMENT IS ITSELF A FACT (E2,E4) ─
--  Every tracker the survey found disagrees with its own governing
--  document — different rate, different compounding convention,
--  different contributed-capital total. equity_preferred_terms and
--  equity_contribution_claims are APPEND-ONLY, one row PER SOURCE, on
--  purpose: this schema has no "the rate is X" column to fight over,
--  because there routinely is no single X that all real sources agree
--  on. position() returns every sourced claim, attributed, never a
--  reconciliation nobody performed.
--
--  ── A MEMBER LOAN IS DEBT, EVEN WHEN FUNDED BY EQUITY HOLDERS (E5) ──
--  No interest rate, no maturity, no lien position, no payment schedule
--  column exists anywhere in this file. A member loan cannot be entered
--  here no matter who funded it or how entangled it is with the same
--  people's equity — mirrors the funding-boundary discipline that
--  already keeps Capital Stack from importing Tax/Insurance funding
--  truth (gate_funding_boundary.js covers this file too).
create table if not exists equity_capital_entities (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete restrict,

  --  One row per TIER in the property's ownership chain — e.g. 4125 has
  --  "4125 Chestnut Interest Holder LLC" and, one tier up,
  --  "4125 Chestnut Holdings LLC". Flat, not a recursive graph: deep
  --  enough because each tier is named in a real document, not a
  --  generalised company-structure engine (see the read contract's
  --  "not built" list).
  entity_kind            text not null check (entity_kind in
                           ('tic_interest','llc_membership','lp_interest',
                            'condo_interest','other')),

  --  The tier itself is always a named entity in every surveyed deal,
  --  even at deals where that entity's OWN members are redacted (E1) —
  --  so no attributed-name escape hatch here, unlike parties below.
  legal_entity_id        uuid not null references legal_entities(id) on delete restrict,

  --  Display ordering only — 1 nearest the property, increasing moving
  --  up the stack. Never used for any economic derivation.
  tier_order             int check (tier_order >= 1),

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint equity_entity_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_equity_entities_property
  on equity_capital_entities (property_id, tier_order);

--  ── POSITIONS ──────────────────────────────────────────────────────
--  One row per holder-at-an-entity. Append-only, effective-dated, POINTS
--  BACKWARD on transfer — same discipline as debt_instrument_parties:
--  no superseded_by, an assignment inserts a row naming the row it
--  replaces, the earlier row is never UPDATEd.
--
--  ⚠ W1/E1 — a party row is only superseded by ANOTHER PARTY ROW citing
--  an actual transfer/assignment instrument. A K-1 or tracker later
--  naming a different holder, with no assignment on file, does NOT
--  supersede this row — it becomes an equity_conflicts row instead
--  (E7). Skyline Minority's 2024 K-1s go to Aryeh Lightstone in Joel
--  Shafran's Schedule I slot with no assignment, no GP consent, no
--  amended schedule anywhere, and the governing LPA itself says such a
--  transfer is "deemed void and of no force or effect" — that fact
--  pattern is a conflict, never a silent supersession.
create table if not exists equity_positions (
  id                     uuid primary key default gen_random_uuid(),
  capital_entity_id      uuid not null references equity_capital_entities(id) on delete restrict,

  --  E1.2 — two kinds, not three. A pro-rata preferred RETURN shared by
  --  a common holder (shape 1) and a stepped/paid-accrued return
  --  (shape 3) are both just dated rows in equity_preferred_terms
  --  attached to a `common` position — never a third position_kind.
  position_kind          text not null check (position_kind in
                           ('common','preferred_class')),

  --  EXACTLY ONE of these, enforced below — same rule as Debt's
  --  guarantors. Reading an operating agreement or a K-1 filename must
  --  never mint a durable Spine person (PHILOSOPHY §12).
  legal_entity_id        uuid references legal_entities(id) on delete restrict,
  party_name_text        text,

  effective_from         date not null,
  effective_to           date,

  supersedes_position_id uuid references equity_positions(id),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint equity_position_exactly_one_subject check (
    (legal_entity_id is not null and party_name_text is null) or
    (legal_entity_id is null and party_name_text is not null
       and length(btrim(party_name_text)) > 0)
  ),
  constraint equity_position_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_equity_positions_entity
  on equity_positions (capital_entity_id, position_kind, effective_from);

--  ── ENCUMBRANCE (E9) ───────────────────────────────────────────────
--  A pledge is its own dated fact, APPEND-ONLY, never a column on
--  equity_positions. Absence of a row means NOT_ESTABLISHED — "nobody
--  has recorded whether this is pledged" — never "confirmed
--  unencumbered". Skyline Apartments GP LLC's interest, and the
--  Retaining Partners' interests, were pledged to a lender in September
--  2025; Exhibit A alone would never have shown that.
create table if not exists equity_position_pledges (
  id                     uuid primary key default gen_random_uuid(),
  position_id            uuid not null references equity_positions(id) on delete restrict,

  pledgee_name_text      text not null check (length(btrim(pledgee_name_text)) > 0),
  pledge_description     text,

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint equity_pledge_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_equity_pledges_position
  on equity_position_pledges (position_id, effective_from);

--  ── PREFERRED TERMS (E2, E8) ───────────────────────────────────────
--  APPEND-ONLY, one row PER SOURCE'S STATEMENT of the terms — never one
--  "the rate is X" column. 4125's MSC HoldCo Pay Schedule computes
--  MONTHLY compounding; the Interest Holder OA §1.60 states QUARTERLY,
--  actual/360. Both real, both current, disagreeing — both get a row,
--  distinguished by source_authority, and position() returns both.
--
--  ⚠ Convention is stored AS WRITTEN (rate_convention_as_stated), not
--  forced into a rigid enum — the survey shows "compounded monthly",
--  "compounded quarterly, actual/360", "added to unreturned Capital
--  Contributions" with no compounding word at all, and no convention
--  stated whatsoever (Tower Place). Normalising that variance into one
--  clean enum before it is understood is exactly the premature
--  confidence this domain exists to refuse.
--
--  A side letter (E8) is its own row, term_source='side_letter',
--  layered over — never replacing — the position's deal-level terms.
create table if not exists equity_preferred_terms (
  id                     uuid primary key default gen_random_uuid(),
  position_id            uuid not null references equity_positions(id) on delete restrict,

  term_source            text not null check (term_source in
                           ('governing_document','side_letter','amendment')),

  --  Passive representation, like Debt's floating-rate columns — a rate
  --  is recorded as STATED, never computed or verified against a feed.
  rate_bp                int check (rate_bp >= 0),
  rate_convention_as_stated  text,
  compounding            text check (compounding in
                           ('monthly','quarterly','annual','simple','unstated')),

  --  Free text, not a tier calculator — a waterfall calculator is
  --  explicitly out of scope (see the read contract). Recording the
  --  clause is in scope; computing a distribution from it is not.
  waterfall_priority_text   text,
  redemption_terms_text     text,
  make_whole_text           text,

  --  §40.4's authority vocabulary, extended by the two source kinds
  --  this domain's survey actually found and Debt's four values don't
  --  cover: an internally-maintained operating spreadsheet is neither a
  --  transcript, an email, nor a user assertion.
  source_authority       text not null check (source_authority in
                           ('governed_read','accounting_record',
                            'tracker_claim','verbal_claim')),

  effective_from         date not null,
  effective_to           date,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now(),

  constraint equity_terms_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_equity_terms_position
  on equity_preferred_terms (position_id, source_authority, effective_from);

--  ── CONTRIBUTION CLAIMS (E4) ───────────────────────────────────────
--  APPEND-ONLY, one row PER SOURCE'S CLAIM of an amount contributed —
--  never a single contributed_amount column. Skyline's GL account 3110
--  carries $1,006,580 against a $23,313 Exhibit A commitment (43×);
--  Greenery's contributed equity is $3,701,824 in QuickBooks, $4,091,501
--  in the tracker, $4,100,000 on Schedule I — a $389,677 gap nobody has
--  reconciled. position() returns every claim, dated and attributed;
--  it does not pick a winner and it does not average.
create table if not exists equity_contribution_claims (
  id                     uuid primary key default gen_random_uuid(),
  position_id            uuid not null references equity_positions(id) on delete restrict,

  claim_source           text not null check (claim_source in
                           ('governing_document','accounting_record','tracker')),

  amount_cents           bigint not null check (amount_cents >= 0),
  as_of_date             date not null,

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

create index if not exists idx_equity_contrib_position
  on equity_contribution_claims (position_id, claim_source, as_of_date desc);

--  ── CONFLICTS (E6, E7) ─────────────────────────────────────────────
--  Two recorded claims about the SAME fact, disagreeing, BOTH retained,
--  neither deleted to make room for the other. Distinct from
--  equity_exposure below: a conflict is two positive statements that
--  contradict each other; Exposure is the absence of a statement at
--  all. `1417 Note Purchase - Summary.docx` says $338,050 was
--  "re-contributed as equity in Skyline Note Owner LLC"; the Carlisle
--  trial balance carries the same dollars (off by $50) as
--  `2525 Loan from Shafran`, a liability — a debt-vs-equity
--  characterization conflict on the same money, not resolved by
--  picking a side.
create table if not exists equity_conflicts (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete restrict,

  --  Nullable — a characterization conflict (E6) may not yet have an
  --  equity_positions row on either side of it to attach to.
  position_id            uuid references equity_positions(id) on delete restrict,

  conflict_kind          text not null check (conflict_kind in
                           ('characterization_debt_vs_equity','holder_identity',
                            'contribution_amount','rate_or_convention','other')),

  claim_a_text           text not null check (length(btrim(claim_a_text)) > 0),
  claim_a_source_artifact_id  uuid references source_artifacts(id),

  claim_b_text           text not null check (length(btrim(claim_b_text)) > 0),
  claim_b_source_artifact_id  uuid references source_artifacts(id),

  noted_as_of            date not null,
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

create index if not exists idx_equity_conflicts_property
  on equity_conflicts (property_id, conflict_kind, noted_as_of desc);

--  ── EXPOSURE (E10) ─────────────────────────────────────────────────
--  CLAUDE.md's Exposure contract, structural — the six parts as
--  columns, not a table to backfill with a guess. 4233 GP Holdco's
--  Class A is 100% redacted, zero names, zero amounts by name; 1417
--  Note Owner's Schedule I lists ONE member at $0 / 0.000% and then
--  asserts TOTALS $1,550,000.00 / 100.000%. Both are Exposure, not a
--  cap table Spine should attempt to reconstruct.
create table if not exists equity_exposure (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references properties(id) on delete restrict,
  capital_entity_id      uuid references equity_capital_entities(id) on delete restrict,

  what_text              text not null check (length(btrim(what_text)) > 0),

  --  Nullable ON PURPOSE — "if known", never zero. A null here means
  --  Spine does not even have an estimate of scale, which is a
  --  different fact from a zero-dollar exposure.
  magnitude_cents        bigint check (magnitude_cents >= 0),
  magnitude_basis_text   text,

  why_unresolved_text    text not null check (length(btrim(why_unresolved_text)) > 0),
  resolution_text        text,

  as_of_date             date not null,

  --  Null reads as UNASSIGNED, never as silently missing.
  owner_user_id          uuid references users(id),

  source_artifact_id     uuid references source_artifacts(id),
  provenance_note        text,

  recorded_by_user_id    uuid not null references users(id),
  recorded_at            timestamptz not null default now()
);

create index if not exists idx_equity_exposure_property
  on equity_exposure (property_id, as_of_date desc);
