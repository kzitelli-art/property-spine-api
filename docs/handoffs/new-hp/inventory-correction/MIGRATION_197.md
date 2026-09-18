# Migration 197 — inventory correction hardening (description)

Lane: inventory-correction hardening (QB, 2026-09-13). 196 is reserved for
Sol and is not depended on. **No production migration is authorized by this
document or by the file.** The migration has been applied only to
nonce-owned proof databases (`spine_proof_*`) in this lane.

## Why a migration at all

180 refuses a LEASE on retired inventory. Nothing refused an application, an
offer, an invitation, a lease packet, an economic schedule, an executed
record, a renewal case, a scheduled unit event, a tour, a work order, a
turnover, an obligation, required work, a readiness certification, a bid, a
supply request, a scheduled charge, a ledger or deposit claim, a money event,
a utility service point, a contracted service location, or a NEW child
position under a retired unit — nor a re-target of an existing row onto one,
nor a reopen of a terminal row already on one. On the delivered candidate
the real work-order door attached a work order and its obligation to a
retired unit and answered 201 (`hardening.witness.json`). A wall in the
service layer alone would not hold: those writers do not go through the
correction door.

## What the file does

`migrations/197_inventory_correction_hardening.sql`

1. `refuse_operative_attachment_to_retired_inventory()` — one plpgsql
   trigger function, parameterised per table:
   `TG_ARGV[0]` status column (`''` = every row is operative),
   `TG_ARGV[1]` comma-separated terminal statuses,
   `TG_ARGV[2]` what a NULL status means (`operative` | `terminal`).
   It resolves **every populated** target: `NEW.unit_id` and, independently,
   `NEW.space_id → spaces.unit_id`. Existing tables that have a narrower
   unit/space grain rule retain it; this wall still checks both values when a
   table carries both. It asks whether NEW is operative, asks whether any
   target is live-retired, and then:
   - INSERT of an operative row → refused (`new attachment`)
   - UPDATE that adds or moves any target onto a retired unit → refused
     (`re-target`)
   - UPDATE of a row that was terminal and becomes operative on a retired
     unit → refused (`reopen`)
   - UPDATE of a row already operative on the same retired unit → allowed
     (a reported conflict stays editable; closing or resolving it, and
     moving it into a terminal status, always works)
   Refusals raise `check_violation` with a sentence naming the unit, the
   table and the cause; the two writer doors proven through map it to 409.
2. 24 triggers `trg_retired_inventory_<table>`, `before insert or update`,
   one per table the policy marks `blocks_while_operative` (leases keeps
   180's own trigger). The arguments are generated from
   `src/tenancy/inventory_relationship_policy.js`, and
   `tests/gates/gate_inventory_relationship_policy.db.js` asserts on the
   live catalog that every trigger carries exactly the policy's arguments
   and that every column referencing `units`/`spaces` is classified.
3. `inventory_correction_commands` — the durable identity of a correction
   command (the 188 tour-command pattern): `(property_id, command_type,
   idempotency_key)` unique, `payload_hash`, `input`, `result`,
   `actor_user_id`, `assignment_id`, `recorded_at`. Written inside the
   command's transaction, so a refused command leaves no receipt and a
   concurrent duplicate replays after the unique index serialises it.

## What it does not do

- It does not alter, delete or move any existing row. Rows already
  attached to retired inventory before the wall are left as they are and
  become *named conflicts* in the correction explanation.
- It does not widen or narrow retirement authority.
- It does not touch 180's lease trigger or the retirement ledger.

## Release

Same rule as every migration here: a deploy verifies the ledger and refuses
to start with 197 pending. Releasing it is a separate, deliberate act
(`MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<read from the ledger>
EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply`) that this
lane has not performed and is not authorised to perform.
