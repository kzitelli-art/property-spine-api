-- ════════════════════════════════════════════════════════════════════
--  174_equity_positions.sql — THE GOVERNED EQUITY & PREFERRED EQUITY
--  DOMAIN. Rebuilt after four owner correction rounds against a real
--  15-deal portfolio survey — see docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md
--  for the walls (E1–E10) and the rulings this shape now carries.
--
--  ── NOT RELEASED. NOT WIRED TO ANY ROUTE. DRAFT SQL ONLY ─────────────
--  Round 4 explicitly withheld a migration number, a route and UI:
--  "You may now draft the structural SQL and read contract... No
--  migration number, route, or UI yet." This file exists so the shape
--  can be proven against real Postgres; it is not a release.
--
--  ── ONE SHARED IDENTITY, NOT TWO BASE TABLES (Round-4 Ruling 1) ──────
--  Round 2 tried splitting Common and Preferred into their own base
--  tables and Round 3 reversed that: "I was pushing too hard toward a
--  theoretically clean split." One holder-at-an-issuer is one KIND of
--  fact regardless of what it holds — capital_stack_positions is that
--  shared identity. position_class is an identity TAG, not a table
--  split. Common and Preferred economics live in SEPARATE tables
--  UNDERNEATH this shared identity (common_equity_class_terms /
--  common_equity_position_overrides / preferred_equity_terms) —
--  separate READINGS, not separate holders.
--
--  ── TIER_ORDER IS GONE. THE GRAPH IS POSITIONS, NOT A DISPLAY FIELD ──
--  The old equity_capital_entities.tier_order was display-only and had
--  been standing in for real ownership facts nobody had recorded (e.g.
--  "Holdings LLC owns 77.57% of Interest Holder LLC" existed nowhere as
--  data). There is no entities table any more. A tier is now just
--  another capital_stack_positions row: issuer_legal_entity_id names
--  the entity whose capital table this is, and the holder of one tier
--  can itself be the issuer of the next. The ownership chain EMERGES
--  from real position rows, never from a hierarchy column.
--
--  ── PRO-RATA PREFERRED RETURN BELONGS TO THE ISSUER, NOT A HOLDER
--     (Round-4 Ruling 2) ────────────────────────────────────────────
--  Skyline's 7.5% and Greenery's 7% preferred returns are shared by
--  EVERY common holder of that entity pro rata — they are a term of
--  the issuer's common class, stated once, never copied onto each
--  holder's own position. common_equity_class_terms exists for exactly
--  this and is keyed by issuer, not by position.
--
--  ── A SIDE LETTER IS A HOLDER-SPECIFIC OVERRIDE, AND AN UNEXECUTED
--     ONE MUST NEVER READ AS SETTLED (Round-4 Ruling 3) ───────────────
--  Lincoln's side letter at Skyline Note Owner is the opposite scope
--  from a class term: it exempts ONE holder from the promote. It lives
--  in common_equity_position_overrides, scoped to one position_id, and
--  carries execution_status — the reader (equity_position_read.js) must
--  refuse to apply an override whose execution_status is not 'executed'
--  to the current economic read, even though it stays visible.
--
--  ── STEPPED PAID/ACCRUED MECHANICS ARE REAL. THE NUMBERS ARE NOT YET
--     GOVERNED (Round-4 Ruling 4) ───────────────────────────────────
--  Tower Place proves a preferred position can carry a genuinely
--  stepped structure — a paid rate and a separately accruing rate,
--  changing over dated steps. preferred_equity_terms carries
--  current_pay_rate_bp and accrued_rate_bp as two distinct columns for
--  exactly this shape. Tower's own specific numbers (the survey's
--  paraphrased "4/4 → 6/2") are NOT written into this migration or any
--  fixture — the structural columns exist because the shape is real;
--  the specific figures stay out until read from the governing document
--  itself, the same discipline MSC's Minimum Dividend gets below.
--
--  ── MSC'S MINIMUM DIVIDEND IS DELIBERATELY LEFT NOT_ESTABLISHED ──────
--  MSC's 12.5% preferred return is well governed (Interest Holder OA
--  §1.60, §1.42). The survey ALSO paraphrases a separate "Minimum
--  Dividend" schedule stepping 8% → 9% → 10% → 11% → 12% → 12.5% — but
--  only paraphrases it; the actual governing clause is OA §1.49, which
--  has not been read. Whether the Minimum Dividend is ADDITIVE to the
--  12.5% preferred return, an OFFSET against it, or something else
--  entirely is genuinely unknown, and minimum_dividend_relationship_
--  to_preferred_return exists specifically to hold NOT_ESTABLISHED
--  rather than a guessed mechanic. This is §38's line, applied at the
--  first schema conversation: a recorded fact (12.5%, from the OA) and
--  a derived attribution (what the Minimum Dividend DOES to it) are
--  different kinds of thing, and only the first is governed here.
--
--  ── STILL TRUE FROM THE FIRST DRAFT, CARRIED FORWARD ──────────────────
--  no accrued_balance column anywhere (E3) · claims are append-only,
--  one row per source (E2, E4) · a member loan is Debt's shape, never
--  representable here (E5) · a K-1/tracker naming a different holder
--  with no assignment is a conflict, never a silent supersession (E7) ·
--  no capital_stack_evidence shared-provenance table — one source-
--  backed observation per row is disciplined enough at this scale · no
--  capital_stack_exposure table — coverage gaps (an entity with zero
--  positions, a claim with no ownership_percent recorded, and so on)
--  are DERIVED by the reader from what is absent, never manually
--  maintained as a parallel ledger of blanks.
create table if not exists capital_stack_positions (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete restrict,

  --  The entity whose capital table this position sits in. A tier one
  --  level up is just another row where THIS row's holder becomes THAT
  --  row's issuer — the chain is data, never a tier_order column.
  issuer_legal_entity_id  uuid not null references legal_entities(id) on delete restrict,

  --  An IDENTITY TAG, not a base-table split (Round-4 Ruling 1). Common
  --  and Preferred share this one table; their economics diverge only
  --  in the terms tables underneath.
  position_class          text not null check (position_class in ('common','preferred')),

  --  EXACTLY ONE of these — same rule as Debt's guarantors. Reading an
  --  operating agreement or a K-1 filename must never mint a durable
  --  Spine person (PHILOSOPHY §12).
  holder_legal_entity_id  uuid references legal_entities(id) on delete restrict,
  holder_name_text        text,

  effective_from          date not null,
  effective_to            date,

  --  ⚠ E1/E7 — superseded ONLY by another position row citing an actual
  --  transfer/assignment instrument. A K-1 or tracker later naming a
  --  different holder, with no assignment on file, is NEVER written as
  --  a supersession here — it becomes a capital_stack_conflicts row.
  supersedes_position_id  uuid references capital_stack_positions(id),

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint capital_stack_position_exactly_one_holder check (
    (holder_legal_entity_id is not null and holder_name_text is null) or
    (holder_legal_entity_id is null and holder_name_text is not null
       and length(btrim(holder_name_text)) > 0)
  ),
  constraint capital_stack_position_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_capital_stack_positions_property
  on capital_stack_positions (property_id, effective_from);
create index if not exists idx_capital_stack_positions_issuer
  on capital_stack_positions (issuer_legal_entity_id, position_class, effective_from);

--  ── COMMON CLASS TERMS (Round-4 Ruling 2) ────────────────────────────
--  "Skyline/Greenery's pro-rata pref belongs once at the entity/
--  WATERFALL level, not per-holder" — the ruling names both in one
--  breath, so this table carries both: a pro-rata preferred RETURN
--  shared by every common holder of ONE issuer (Skyline's 7.5%,
--  Greenery's 7%) AND that issuer's default waterfall priority (the
--  Skyline deal's own 65/35 GP split), each recorded ONCE at the
--  issuer, never duplicated onto each holder's own position. This is
--  NOT a position-scoped table; it is issuer-scoped on purpose — the
--  opposite scope from common_equity_position_overrides below, which
--  is how ONE holder (Lincoln) can read differently from this default
--  without this table ever being touched.
create table if not exists common_equity_class_terms (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete restrict,
  issuer_legal_entity_id  uuid not null references legal_entities(id) on delete restrict,

  term_source             text not null check (term_source in
                            ('governing_document','amendment')),
  source_authority        text not null check (source_authority in
                            ('governed_read','accounting_record',
                             'tracker_claim','verbal_claim','secondary_summary')),

  rate_bp                 int check (rate_bp >= 0),
  rate_convention_as_stated  text,
  compounding             text check (compounding in
                            ('monthly','quarterly','annual','simple','unstated')),
  waterfall_priority_text text,

  effective_from          date not null,
  effective_to            date,

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint common_class_terms_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_common_class_terms_issuer
  on common_equity_class_terms (issuer_legal_entity_id, effective_from);

--  ── HOLDER-SPECIFIC OVERRIDES (Round-4 Ruling 3) ─────────────────────
--  A side letter overrides ONE holder's terms, never the class's. This
--  is a position-scoped table on purpose — the opposite scope from
--  common_equity_class_terms above.
--
--  ⚠ execution_status IS THE WHOLE POINT OF THIS TABLE. The Lincoln
--  side letter at Skyline Note Owner exists only as counsel's draft
--  framing ("consistent with how we've handled this in the past") —
--  no signature, no execution date found in the survey. A row here
--  with execution_status != 'executed' is returned by the reader as a
--  visible, dated fact — a real thing that exists — but is NEVER
--  applied to the current economic read as though it were settled.
--  'status_unknown' is a THIRD state, not folded into either extreme:
--  a source describing a side letter with no statement about whether
--  it was signed is a different fact from one explicitly still in
--  draft, and both are different from a confirmed execution date.
create table if not exists common_equity_position_overrides (
  id                      uuid primary key default gen_random_uuid(),
  position_id             uuid not null references capital_stack_positions(id) on delete restrict,

  override_kind           text not null check (override_kind in
                            ('waterfall_priority','promote_exemption','other')),
  override_text           text not null check (length(btrim(override_text)) > 0),

  execution_status        text not null check (execution_status in
                            ('executed','draft_unexecuted','status_unknown')),
  execution_date          date,

  term_source             text not null default 'side_letter' check (term_source in
                            ('side_letter','amendment')),
  source_authority        text not null check (source_authority in
                            ('governed_read','accounting_record',
                             'tracker_claim','verbal_claim','secondary_summary')),

  effective_from          date not null,
  effective_to            date,

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint position_override_effective_order check (
    effective_to is null or effective_to >= effective_from
  ),
  --  An executed override without an execution date is a contradiction
  --  in terms — if the fact "it executed" is known, the date belongs
  --  with it. draft_unexecuted / status_unknown carry no date, because
  --  there is nothing to date yet.
  constraint position_override_execution_date_iff_executed check (
    (execution_status = 'executed' and execution_date is not null) or
    (execution_status <> 'executed' and execution_date is null)
  )
);

create index if not exists idx_position_overrides_position
  on common_equity_position_overrides (position_id, effective_from);

--  ── PREFERRED TERMS (E2, E3, Round-4 Rulings 4 & the MSC deferral) ───
--  APPEND-ONLY, one row PER SOURCE'S STATEMENT of the terms, attached
--  ONLY to a position_class = 'preferred' position (enforced by the
--  writer, not a cross-table check — same discipline Debt applies to
--  its own party-role writers).
--
--  current_pay_rate_bp / accrued_rate_bp are TWO columns, not one,
--  because Tower Place proves a preferred position can carry a
--  genuinely stepped paid-vs-accruing structure. Tower's own specific
--  numbers are not written anywhere in this schema or its fixtures —
--  the columns exist because the SHAPE is real; the FIGURES stay out
--  until read from the governing document (Round-4 Ruling 4).
--
--  minimum_dividend_schedule_text / minimum_dividend_relationship_to_
--  preferred_return exist for MSC's shape and MSC's shape only: a
--  preferred return that is well governed (current_pay_rate_bp = 1250,
--  source_authority = governed_read) sitting beside a SEPARATE
--  Minimum Dividend schedule the survey paraphrases but does not
--  quote from source. The relationship field defaults to
--  'not_established' and MUST stay there until OA §1.49 itself is
--  read — this is the one deliberately unfrozen piece of Round 4.
create table if not exists preferred_equity_terms (
  id                      uuid primary key default gen_random_uuid(),
  position_id             uuid not null references capital_stack_positions(id) on delete restrict,

  term_source             text not null check (term_source in
                            ('governing_document','side_letter','amendment','secondary_summary')),
  source_authority        text not null check (source_authority in
                            ('governed_read','accounting_record',
                             'tracker_claim','verbal_claim','secondary_summary')),

  --  Passive representation, like Debt's floating-rate columns — a rate
  --  is recorded as STATED, never computed or verified against a feed.
  current_pay_rate_bp     int check (current_pay_rate_bp >= 0),
  accrued_rate_bp         int check (accrued_rate_bp >= 0),
  rate_convention_as_stated  text,
  compounding             text check (compounding in
                            ('monthly','quarterly','annual','simple','unstated')),
  step_schedule_text      text,

  --  ⚠ MSC's shape. Left deliberately open — see the file header and
  --  docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md.
  minimum_dividend_schedule_text  text,
  minimum_dividend_relationship_to_preferred_return  text
                          not null default 'not_established' check (
                            minimum_dividend_relationship_to_preferred_return in
                            ('additive','offset','other','not_established')),

  waterfall_priority_text   text,
  redemption_terms_text     text,
  make_whole_text           text,
  control_rights_text       text,
  redemption_or_maturity_date  date,

  effective_from          date not null,
  effective_to            date,

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint preferred_terms_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_preferred_terms_position
  on preferred_equity_terms (position_id, source_authority, effective_from);

--  ── ENCUMBRANCE (E9) ───────────────────────────────────────────────
--  A pledge is its own dated fact, APPEND-ONLY, never a column on
--  capital_stack_positions. Absence of a row means NOT_ESTABLISHED —
--  never "confirmed unencumbered".
create table if not exists capital_stack_pledges (
  id                      uuid primary key default gen_random_uuid(),
  position_id             uuid not null references capital_stack_positions(id) on delete restrict,

  pledgee_name_text       text not null check (length(btrim(pledgee_name_text)) > 0),
  pledge_description      text,

  effective_from          date not null,
  effective_to            date,

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint capital_stack_pledge_effective_order check (
    effective_to is null or effective_to >= effective_from
  )
);

create index if not exists idx_capital_stack_pledges_position
  on capital_stack_pledges (position_id, effective_from);

--  ── CAPITAL AMOUNT CLAIMS (E4) ─────────────────────────────────────
--  Narrower than the first draft's "contribution claims"/"capital
--  movements": this table holds STANDING TOTALS a source states as of
--  a date, never individual cash transactions — no source in the
--  survey evidences movement-by-movement history, only period totals
--  (a GL balance, a tracker's running figure, a Schedule I percentage).
--
--  ⚠ EXACTLY ONE OF amount_cents / ownership_percent PER ROW. Ownership
--  percentage is kept a SEPARATE economic fact from contribution
--  amount, even though both are per-source claims about the same
--  position — a row claiming "43.2%" and a row claiming "$1,006,580"
--  are two different KINDS of fact and are never merged into one
--  record, even when the same source states both.
--
--  ⚠ claim_source includes 'internal_note' — the fix for a real bug:
--  Rob Vernicek's verbal "$3.7MM" estimate was originally forced into
--  'tracker' for lack of anywhere else to put it, because the first
--  draft's enum had no slot for a spoken/internal estimate. asserted_
--  by_text exists so that kind of claim carries who said it, not just
--  that it was said — necessary precisely because 'internal_note' is
--  the WEAKEST source_authority this table accepts and a reader must
--  be able to see whose estimate it is, not just that it disagrees.
create table if not exists capital_amount_claims (
  id                      uuid primary key default gen_random_uuid(),
  position_id             uuid not null references capital_stack_positions(id) on delete restrict,

  claim_source            text not null check (claim_source in
                            ('governing_document','accounting_record','tracker','internal_note')),
  asserted_by_text        text,

  amount_cents            bigint check (amount_cents >= 0),
  ownership_percent       numeric(7,4) check (ownership_percent >= 0 and ownership_percent <= 100),

  as_of_date              date not null,

  source_artifact_id      uuid references source_artifacts(id),
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now(),

  constraint capital_amount_claim_exactly_one_value check (
    (amount_cents is not null and ownership_percent is null) or
    (amount_cents is null and ownership_percent is not null)
  )
);

create index if not exists idx_capital_amount_claims_position
  on capital_amount_claims (position_id, claim_source, as_of_date desc);

--  ── CONFLICTS (E6, E7) ─────────────────────────────────────────────
--  Two recorded claims about the SAME fact, disagreeing, BOTH retained,
--  neither deleted to make room for the other. Kept as its own durable
--  table on purpose (Round-3 ruling): these are genuine unresolved
--  facts about the world, not a UI state to be dismissed.
create table if not exists capital_stack_conflicts (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references properties(id) on delete restrict,

  --  Nullable — a characterization conflict (E6) may not yet have a
  --  capital_stack_positions row on either side of it to attach to.
  position_id             uuid references capital_stack_positions(id) on delete restrict,

  conflict_kind           text not null check (conflict_kind in
                            ('characterization_debt_vs_equity','holder_identity',
                             'contribution_amount','ownership_percent',
                             'rate_or_convention','other')),

  claim_a_text            text not null check (length(btrim(claim_a_text)) > 0),
  claim_a_source_artifact_id  uuid references source_artifacts(id),

  claim_b_text            text not null check (length(btrim(claim_b_text)) > 0),
  claim_b_source_artifact_id  uuid references source_artifacts(id),

  noted_as_of             date not null,
  provenance_note         text,

  recorded_by_user_id     uuid not null references users(id),
  recorded_at             timestamptz not null default now()
);

create index if not exists idx_capital_stack_conflicts_property
  on capital_stack_conflicts (property_id, conflict_kind, noted_as_of desc);

--  ── DELIBERATELY ABSENT ────────────────────────────────────────────
--  no capital_stack_evidence — a shared multi-source provenance table
--    was proposed and withdrawn (Round 3): one source-backed
--    observation per row is disciplined enough until two or three real
--    cases prove a shared evidence model is actually needed.
--  no capital_stack_exposure — the first draft's six-part Exposure
--    table was withdrawn (Round 3): coverage gaps (an issuer with zero
--    positions, a position with no ownership_percent claim, a
--    preferred position with no minimum_dividend_relationship
--    established) are DERIVED by equity_position_read.js from what is
--    absent, never separately authored and never allowed to drift from
--    what the rest of this schema actually holds.
--  no accrued_balance column, anywhere — E3, unchanged from the first
--    draft: nothing accrues in any surveyed general ledger.
--  no interest_rate_bp / maturity_date / lien_position column on any
--    table here — E5, unchanged: a member loan is Debt's shape.
