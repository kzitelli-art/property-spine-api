-- ════════════════════════════════════════════════════════════════════
--  167_tax_payment_identity.sql — A PAYMENT PROVES THE SPECIFIC
--  REQUIREMENT IT SATISFIES, AND NOTHING ELSE.
--
--  ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────
--  165 gave a payment an obligation and an amount. The standing read
--  then asked "does a payment exist on this obligation?" and treated the
--  answer as satisfying EVERY payment milestone on it. Three real wrong
--  answers came out of that one line:
--
--      a $50,000 payment against a $122,259.93 Real Estate Tax bill
--        read as PAID
--      an NPT FIRST estimate closed out the SECOND estimate
--      a BIRT balance payment closed out the mandatory estimate for the
--        following year — the two the City's own return prints as
--        separate lines (5 and 6) on the same due date
--
--  A tax read that says PAID when $72,259.93 is outstanding is the exact
--  confident-wrong this domain exists to prevent, and it is worse than
--  the escrow defect because nothing about it looks suspicious.
--
--  ── THE SMALLEST DURABLE IDENTITY THAT FIXES IT ─────────────────────
--  One column: the milestone key the payment is made against.
--  `philadelphia_tax_rules.milestonesFor()` is the only place those keys
--  are minted, and the set is small and stable:
--
--      real_estate   payment:annual
--      birt          payment:balance · payment:estimate_next_year
--      npt           payment:estimate_1 · payment:estimate_2 ·
--                    payment:balance
--      uo            payment:monthly
--
--  ⚠ A MILESTONE KEY IS A CONTRACT. Renaming one orphans every payment
--  recorded against the old name, and the read would then report an
--  unpaid bill that was paid — the same class of silent breakage as the
--  migration-159 response-key rename. Change one only with a data
--  migration that moves the rows with it.
--
--  ── NULLABLE, AND THE NULL MEANS SOMETHING ──────────────────────────
--  NULL is "not allocated to a requirement". It is not a wildcard and it
--  never satisfies anything by itself.
--
--  The writer fills it automatically when the obligation has exactly ONE
--  payment milestone — Real Estate Tax and U&O — because with one
--  requirement there is no ambiguity to resolve. Where an obligation
--  carries several, the writer REFUSES a payment that does not name one,
--  rather than guessing. The read surfaces any unallocated payment it
--  finds so the money is visible even when its purpose is not.
--
--  ── AND WHY PARTIAL PAYMENT IS NOT A COLUMN ─────────────────────────
--  There is no `is_full_payment` flag, deliberately. Whether a bill is
--  covered is a comparison between the payments allocated to a
--  requirement and the governed liability, and both already exist. A
--  stored flag would be a second opinion able to drift from the numbers
--  underneath it — the same reason no tax status is persisted anywhere.
--
--  CLASS 1 — permanent product primitive.
-- ════════════════════════════════════════════════════════════════════

alter table tax_payments
  add column if not exists satisfies_requirement text;

--  Shaped, not enumerated. The jurisdiction module owns the vocabulary
--  and a second jurisdiction will bring its own keys; what the database
--  enforces is that the value is a payment-requirement key rather than
--  free text somebody typed into an API.
alter table tax_payments drop constraint if exists ck_tax_payment_requirement_shape;
alter table tax_payments add constraint ck_tax_payment_requirement_shape
  check (satisfies_requirement is null
         or satisfies_requirement ~ '^payment:[a-z][a-z0-9_]*$');

create index if not exists idx_tax_payment_requirement
  on tax_payments (obligation_id, satisfies_requirement);

--  ── THE BIRT FILER PROFILE ─────────────────────────────────────────
--  The City's BIRT return carries a MANDATORY estimated payment for the
--  following year (Line 6), and grants relief to businesses in their
--  first year in Philadelphia. So the estimate requirement is NOT the
--  same for every taxpayer, and a clock that assumed it was would either
--  invent an obligation a new filer does not have or hide one an
--  established filer does.
--
--  ⚠ IT IS A DETERMINATION, NOT AN INFERENCE. Not from entity_type, not
--  from a formation date, not from the absence of a prior return in
--  Spine — a portfolio that has filed in Philadelphia for a decade can
--  still be new to Spine. Same rule as applicability, and the basis is
--  mandatory for the same reason: without one nobody can re-examine it.
--
--  On the OBLIGATION rather than the entity, because it is a fact about
--  a taxpayer IN A TAX YEAR — second-year status is true exactly once.
alter table tax_obligations
  add column if not exists birt_filer_profile text,
  add column if not exists birt_filer_profile_basis text;

alter table tax_obligations drop constraint if exists ck_tax_obl_birt_profile;
alter table tax_obligations add constraint ck_tax_obl_birt_profile
  check (birt_filer_profile is null
         or (tax_type = 'birt'
             and birt_filer_profile in ('first_year', 'second_year', 'established')));

--  A determination with no stated basis cannot be re-examined, and this
--  one decides whether a mandatory payment exists.
alter table tax_obligations drop constraint if exists ck_tax_obl_birt_profile_basis;
alter table tax_obligations add constraint ck_tax_obl_birt_profile_basis
  check (birt_filer_profile is null
         or (birt_filer_profile_basis is not null
             and length(btrim(birt_filer_profile_basis)) > 0));
