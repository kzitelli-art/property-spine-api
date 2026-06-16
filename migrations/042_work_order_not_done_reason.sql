-- ════════════════════════════════════════════════════════════════════
--  MIGRATION 042 — WORK ORDER not_done_reason: structure the stall reason
--
--  THE PROBLEM THIS FIXES
--  The closeout proof gate (PATCH /work-orders/:id/closeout) has a not-done
--  path: when a tech marks a job NOT 100% done, the work order stays open,
--  needs_pm_review flips true, and a maintenance_followup event is written.
--  Good. But the *reason* the job stalled was being stuffed into
--  completion_note — the same free-text column meant for the eventual
--  completion proof. Two problems:
--    1) It collides: a not-done reason and a real completion note fight over
--       one column. A unit that stalls and is later finished loses its trail.
--    2) It cannot ROUTE: free text can't drive the continuity engine. "the
--       chain cannot break" requires a structured reason so need_part →
--       supply follow-up, need_vendor → vendor obligation, no_access →
--       reschedule. A string can't do that.
--
--  THE CHANGE
--  Add ONE nullable column: not_done_reason text. Captured from a fixed enum
--  (validated in maintenance.js, same pattern as down_units DOWN_REASONS).
--  completion_note goes back to meaning only one thing: the completion note.
--
--  Additive and safe: nullable, no default needed, existing rows unaffected.
--  No data backfill — historical not-done reasons that lived in completion_note
--  are left as-is (not worth a lossy migration; the column starts clean here).
-- ════════════════════════════════════════════════════════════════════

alter table work_orders
  add column if not exists not_done_reason text;
