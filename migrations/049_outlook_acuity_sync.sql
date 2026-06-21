-- PROPERTY SPINE — 049 OUTLOOK / ACUITY SYNC STATE
--
-- This migration stores integration operational state only. It does NOT store
-- canonical tour truth. Canonical source events and tours remain in the 048
-- scheduling tables via leasingscheduling.js.
--
-- Assumes 048_interaction_ledger_and_scheduling.sql is already applied.


CREATE TABLE IF NOT EXISTS integration_sync_states (
  integration_key              text PRIMARY KEY,
  provider                     text NOT NULL CHECK (provider IN ('microsoft_graph')),
  mailbox_address              text NOT NULL,
  mail_folder_id               text NOT NULL,
  delta_link                   text,
  initial_sync_after           timestamptz,
  last_successful_sync_at      timestamptz,
  last_successful_message_at   timestamptz,
  last_error_at                timestamptz,
  last_error_summary           text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id                           bigserial PRIMARY KEY,
  integration_key              text NOT NULL REFERENCES integration_sync_states(integration_key) ON DELETE CASCADE,
  started_at                   timestamptz NOT NULL DEFAULT now(),
  finished_at                  timestamptz,
  status                       text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  messages_seen                integer NOT NULL DEFAULT 0,
  messages_forwarded           integer NOT NULL DEFAULT 0,
  messages_skipped             integer NOT NULL DEFAULT 0,
  messages_unmapped            integer NOT NULL DEFAULT 0,
  error_summary                text,
  created_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_sync_runs_integration_started_idx
  ON integration_sync_runs (integration_key, started_at DESC);

