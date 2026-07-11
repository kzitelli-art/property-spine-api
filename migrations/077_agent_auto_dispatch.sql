-- ════════════════════════════════════════════════════════════════════
--  077_agent_auto_dispatch.sql
--  ⚠ RULE 11: verify Neon ceiling = 076 before applying. Rename if not.
--
--  Two small, honest additions for the funnel-flow build:
--
--  1. agent_drafts.dispatch_mode — 'human' | 'auto'. Auto-dispatched
--     drafts are attributed to the SYSTEM, never to a human. We also
--     drop NOT NULL on dispatched_by_user_id if present (no-op if
--     already nullable) so auto dispatch never has to borrow a human
--     identity. Honest provenance: recommendation ≠ dispatch, and an
--     auto dispatch ≠ a human's dispatch.
--
--  2. agent_runs.offered_units_json / selected_unit_id — the durable
--     record of WHICH real units the agent offered in a given run, and
--     which one the prospect subsequently selected. offered ≠ selected:
--     presentation is recorded at generation; selection is recorded
--     only when the prospect's own words confirm a specific offered
--     unit (the attach moment).
-- ════════════════════════════════════════════════════════════════════
begin;

alter table agent_drafts
  add column if not exists dispatch_mode text
    check (dispatch_mode in ('human','auto'));

do $$ begin
  alter table agent_drafts alter column dispatched_by_user_id drop not null;
exception when undefined_column then null; end $$;

alter table agent_runs
  add column if not exists offered_units_json jsonb;

alter table agent_runs
  add column if not exists selected_unit_id uuid references units(id);

-- 3. application_invitations.dispatch_comm_event_id — the stable dispatch
--    identity: one invitation is bound to exactly one save-first outbound
--    comm_event; the gate's already-sent guard on that event makes
--    "one invitation ⇒ at most one accepted dispatch" enforceable and
--    crash-recoverable (resume re-reads the event's sid instead of
--    blindly creating another attempt).
alter table application_invitations
  add column if not exists dispatch_comm_event_id uuid references comm_events(id);

-- ledger receipt (adjust to live ledger shape):
-- insert into schema_migrations (version, name) values (77, 'agent_auto_dispatch');

commit;
