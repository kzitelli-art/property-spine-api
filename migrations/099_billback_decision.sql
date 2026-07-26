-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 099 — THE BILLBACK DECISION
--
--  `work_orders.tenant_caused = true` records that a human OBSERVED the
--  resident caused the damage. It is not a billback and must never become one
--  on its own. Whether the property CHARGES a resident is a decision: it has
--  an owner, an actor, a time, a reason, and it must be reversible by a
--  correction that preserves what it corrected. A recommendation is not a
--  dispatch.
--
--  Two objects, deliberately not one:
--
--    obligation  type='billback_decision'   the ACCOUNTABILITY rail —
--                                           someone owes an answer
--    work_order_billback_decisions          the DURABLE FACT — what was
--                                           decided, by whom, when, why
--
--  Keeping them separate is what lets "disputed" exist without widening
--  ck_obl_status, which is shared by every obligation in the system. A
--  dispute is derived from decision history; it is never an obligation state.
--
--  DESIGNED AGAINST THE LAST PRIMITIVE THAT FAILED. Live `agent_review` rows,
--  measured on this database 2026-07-26:
--      272 rows
--       19 born complete (completed_at within 2s of created_at)
--      173 complete with resolution_code NULL — no record of HOW they closed
--      272 with ownership_origin NULL and owner_eligibility_state NULL, so
--          "nobody was eligible" and "nobody asked" are indistinguishable
--  The three constraints below make each of those impossible for this type.
--
--  Idempotent. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. the durable decision record — APPEND ONLY ──
--  No row is ever updated or deleted. A reversal is a NEW row pointing at the
--  one it supersedes. Current state is a READ of the latest non-superseded
--  entry, never a stored status — reporting reads truth, it does not hold it.
create table if not exists work_order_billback_decisions (
  id                  uuid primary key default gen_random_uuid(),
  work_order_id       uuid not null references work_orders(id) on delete cascade,
  property_id         uuid not null references properties(id),

  entry_kind          text not null,           -- decision | correction | dispute
  decision            text,                    -- bill_back | do_not_bill_back; NULL only for a dispute

  -- NULLABLE AND NORMALLY NULL. At decision time the repair frequently has no
  -- final cost, and "bill back: yes, amount not yet known" is the honest
  -- record. A zero here would be a fabricated number. The amount arrives later
  -- as a correction entry carrying it.
  amount_cents        bigint,

  reason              text not null,           -- every entry says why. no silent charges.
  actor_user_id       uuid references users(id),    -- the staff human who decided
  actor_person_id     uuid references persons(id),  -- the resident, for a dispute
  supersedes_id       uuid references work_order_billback_decisions(id),
  source_obligation_id uuid references obligations(id),
  created_at          timestamptz not null default now()
);

create index if not exists ix_wobd_work_order on work_order_billback_decisions(work_order_id, created_at);
create index if not exists ix_wobd_property   on work_order_billback_decisions(property_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='ck_wobd_entry_kind') then
    alter table work_order_billback_decisions add constraint ck_wobd_entry_kind
      check (entry_kind in ('decision','correction','dispute'));
  end if;
  if not exists (select 1 from pg_constraint where conname='ck_wobd_decision') then
    alter table work_order_billback_decisions add constraint ck_wobd_decision
      check (decision is null or decision in ('bill_back','do_not_bill_back'));
  end if;
  -- A decision or correction MUST name a staff actor and MUST carry a decision.
  -- A dispute MUST name the resident and carries no decision — filing a
  -- contest does not decide anything.
  if not exists (select 1 from pg_constraint where conname='ck_wobd_actor_shape') then
    alter table work_order_billback_decisions add constraint ck_wobd_actor_shape
      check (
        (entry_kind in ('decision','correction')
           and actor_user_id is not null and decision is not null)
        or
        (entry_kind = 'dispute'
           and actor_person_id is not null and decision is null)
      );
  end if;
  -- An amount is never negative, and is never stored as a placeholder zero.
  if not exists (select 1 from pg_constraint where conname='ck_wobd_amount') then
    alter table work_order_billback_decisions add constraint ck_wobd_amount
      check (amount_cents is null or amount_cents > 0);
  end if;
  -- A correction must say what it corrects. An original must not.
  if not exists (select 1 from pg_constraint where conname='ck_wobd_supersedes') then
    alter table work_order_billback_decisions add constraint ck_wobd_supersedes
      check ((entry_kind = 'correction') = (supersedes_id is not null));
  end if;
end $$;

comment on table work_order_billback_decisions is
  'APPEND-ONLY history of the billback question for a work order. Never updated, never deleted. Current state = latest non-superseded entry, read not stored. Nothing here posts money.';

-- ── 2. the three structural guarantees, scoped to this obligation type ──
--  Each one closes a failure that actually happened on agent_review.
do $$
begin
  -- (defect 3) "unassigned" must be DECLARED, not merely absent. Copied from
  -- ck_oblig_child_ownership, which already does this for the application-link
  -- types. Without it, a null owner cannot be told apart from a resolver that
  -- was never asked.
  if not exists (select 1 from pg_constraint where conname='ck_oblig_billback_ownership') then
    alter table obligations add constraint ck_oblig_billback_ownership
      check (
        type <> 'billback_decision'
        or (ownership_origin is not null
            and owner_eligibility_state is not null
            and ((assigned_user_id is null) = (owner_eligibility_state = 'unassigned')))
      );
  end if;
  -- (defect 2) it cannot close without saying HOW. 173 agent_review rows are
  -- complete with a null resolution_code; nobody can now say how any of them
  -- ended.
  if not exists (select 1 from pg_constraint where conname='ck_oblig_billback_resolution') then
    alter table obligations add constraint ck_oblig_billback_resolution
      check (
        type <> 'billback_decision'
        or status <> 'complete'
        or resolution_code is not null
      );
  end if;
  -- (defect 1) it may not be BORN complete. "Born" is not expressible in a
  -- check, so this forbids the shape that made it visible — a completed row
  -- carrying no completion time — and the service refuses a create that
  -- arrives already complete. tests/billback_decision_proof.js asserts it.
  if not exists (select 1 from pg_constraint where conname='ck_oblig_billback_complete_shape') then
    alter table obligations add constraint ck_oblig_billback_complete_shape
      check (
        type <> 'billback_decision'
        or status <> 'complete'
        or completed_at is not null
      );
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════
--  NOT BUILT BY THIS MIGRATION — named so none of it can read as done:
--
--  1. THE DISPUTE HAS NO ENTRY POINT. The table accepts entry_kind='dispute'
--     so we do not migrate twice, but no route files one and the service has
--     no method for it. A dispute means: a resident contests a CURRENT
--     bill_back decision; filing does NOT reverse it; it spawns a
--     billback_dispute_review obligation; it resolves through a correction
--     that either re-affirms or reverses. Dormant Class 1. Activation
--     condition: a resident-facing surface exists and has been approved.
--
--  2. A LATER CORRECTION TO tenant_caused DOES NOT SPAWN. The spawn fires on
--     work-order CREATE, which is the only moment tenant_caused can be set
--     today. If an update path is built, it must spawn there too, and the
--     dedupe_key below is what will keep that from producing a second
--     decision for the same work order.
--
--  3. NOTHING HERE POSTS MONEY. No money_event, no charge, no ledger entry.
--     A decision to bill back is a decision; turning it into money is a
--     separate rung that does not exist.
--
--  4. NO OPERATOR SURFACE LISTS THIS OBLIGATION. Verified 2026-07-26: every
--     obligation-queue route is /operator/leasing/* and reads through
--     leasing_conversion_obligations by inner join, so a maintenance-module
--     obligation appears in NO list. It IS counted in the open/by-module
--     aggregates on board.js and desks.js. This is a missing surface, not a
--     missing clock — which is why due_at is honestly null rather than an
--     invented SLA.
-- ════════════════════════════════════════════════════════════════════
