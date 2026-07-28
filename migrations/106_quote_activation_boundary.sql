-- ════════════════════════════════════════════════════════════════════
--  106_quote_activation_boundary.sql
--
--  PUBLICATION IS NOT ACTIVATION. The application-fee cutover exposed the
--  gap: publishing set record_state='active', and the only thing standing
--  between that and a live quote was the legacy fact still existing. For a
--  moment two rows both looked authoritative. The customer-facing answer
--  stayed correct because the assistant read the fact, but the SEAM was
--  luck, not design, and luck does not survive reuse.
--
--  So the two ideas are separated into two columns:
--
--    record_state  — is this approved economic truth?
--                    draft | active | superseded | retired
--    quote_state   — may the live assistant quote it?
--                    inactive | live
--
--  A term can be published, reviewed and shadowed while quote_state stays
--  'inactive'. The operator read may show it as cutover-ready; the live
--  adapter must not see it. Activation is a separate, explicit act.
--
--  ── WHY A COLUMN AND NOT MORE record_state VALUES ────────────────────
--  Because they answer different questions and change on different days. A
--  superseded term was once live; a live term is also active. Folding them
--  into one enum forces every consumer to know which values imply which, and
--  that is exactly the ambiguity that produced the unsafe window.
--
--  ── THE INVARIANT ────────────────────────────────────────────────────
--  At most ONE live quotable owner per charge code per property, enforced by
--  a partial unique index rather than by service discipline.
--
--  CLASSIFICATION: Class 1 permanent primitive. Additive. The one existing
--  published row (fee.application) is set live because it IS live today —
--  its legacy fact is already retired, so leaving it inactive would create
--  the silent gap this migration exists to prevent.
-- ════════════════════════════════════════════════════════════════════

alter table property_governed_charges
  add column if not exists quote_state text not null default 'inactive';

alter table property_governed_charges drop constraint if exists ck_gc_quote_state;
alter table property_governed_charges add constraint ck_gc_quote_state
  check (quote_state in ('inactive', 'live'));

-- Only an ACTIVE term with a RESOLVED amount may ever be live. A draft or an
-- unresolved amount cannot be quoted, so it cannot be activated either.
alter table property_governed_charges drop constraint if exists ck_gc_live_requires_active_amount;
alter table property_governed_charges add constraint ck_gc_live_requires_active_amount
  check (quote_state <> 'live' or (record_state = 'active' and amount is not null));

alter table property_governed_charges add column if not exists activated_at timestamptz;
alter table property_governed_charges add column if not exists activated_by_person_id uuid
  references persons(id);
alter table property_governed_charges add column if not exists cutover_receipt jsonb;

alter table property_governed_charges drop constraint if exists ck_gc_live_is_receipted;
alter table property_governed_charges add constraint ck_gc_live_is_receipted
  check (quote_state <> 'live' or (activated_at is not null and activated_by_person_id is not null));

-- ONE live owner per code per property, enforced by the database.
create unique index if not exists uq_gc_one_live_owner
  on property_governed_charges (property_id, charge_code)
  where quote_state = 'live';

comment on column property_governed_charges.quote_state is
  'inactive | live. PUBLICATION (record_state) establishes approved economic truth; ACTIVATION (quote_state) decides what the live assistant may quote. A published, cutover-ready term is visible to operators and invisible to the adapter until activated.';

-- ── reconcile the one existing row ───────────────────────────────────
-- fee.application is genuinely live: its legacy fact retired on 2026-07-27
-- and the assistant already answers from it. Marking it live records the
-- truth; marking it inactive would open the silent gap.
update property_governed_charges c
   set quote_state = 'live',
       activated_at = coalesce((c.publication_receipt->'cutover'->>'cutover_at')::timestamptz, c.published_at),
       activated_by_person_id = c.published_by_person_id,
       cutover_receipt = coalesce(c.publication_receipt->'cutover', '{}'::jsonb) || jsonb_build_object(
         'sequence_correction',
         'HISTORICAL RECORD: publication and legacy retirement were TWO separate committed actions, '
         || 'not one transaction. Between them the database held two authoritative-looking rows. The '
         || 'live assistant read only the legacy fact throughout, so no customer-facing answer was '
         || 'wrong — but the seam was not transactional and is not reusable in that form. Migration '
         || '106 adds the quote-activation boundary so every later cutover activates and retires in a '
         || 'single transaction.')
 where c.charge_code = 'fee.application'
   and c.record_state = 'active'
   and c.quote_state <> 'live'
   and exists (select 1 from agent_facts f
                where f.property_id = c.property_id
                  and f.fact_key = 'pricing_application_fee'
                  and f.status = 'retired');
