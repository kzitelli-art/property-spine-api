-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 064 — THE DECISION RAIL LEARNS 'concession'
--
--  J3: an over-authority discretionary concession (soft mode, over the
--  grant's escalation threshold) routes through the EXACT existing
--  Decision Rail machinery — same createDecision, same pending inbox,
--  same grant/deny, same obligation type ('decision_grant', module
--  'accounting') so NO obligation-counting surface changes anywhere.
--  The only thing the rail needs to learn is the new decision noun.
--
--  AWAY-DECISION (one line to reverse): the doc's Part 14 asked whether
--  the name should be 'concession_grant'. Chosen: 'concession' — it
--  names the money event, matching the existing noun vocabulary
--  (rent_forgiveness · writeoff · waiver · capex_recat); the GRANT is
--  the obligation, which already has a name. Rename here + in
--  decisions.js DECISION_TYPES if preferred.
--
--  IDEMPOTENT: drop-and-re-add of a named check constraint converges.
-- ════════════════════════════════════════════════════════════════════

alter table decision_cases
  drop constraint if exists decision_cases_type_check;

alter table decision_cases
  add constraint decision_cases_type_check
  check (type in ('rent_forgiveness','writeoff','waiver','capex_recat','concession'));
