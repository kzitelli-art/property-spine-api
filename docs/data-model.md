# Data Model

## Core hierarchy

```
properties
  └── units
        └── spaces          (≥1 per unit, enforced by trigger)
              └── leases    (attach to spaces, never directly to units)
                    └── ledger_entries
```

A **property** is the top-level entity. It has **units** (physical spaces, e.g. "Apt 304"). Each unit has one or more **spaces** — the rentable subdivisions. A whole-unit lease occupies the one default space; a by-the-bed property has one space per bed. **Leases** bind to spaces. This is what lets both models share one code path.

The `ensure_unit_space` DB trigger guarantees every unit always has at least one space, even if written around the application layer.

---

## People

```
persons                      — durable, never replaced
  ├── contact_preferences    — STOP flags per channel (global, not property-scoped)
  └── leases (as resident)
users                        — staff members
  └── property_team_assignments  — which properties, which modules, what role
```

A `person` is durable across their full lifecycle: `lead → applicant → tenant → past_tenant`. The record is never replaced, only updated. `lifecycle_status` tracks state.

`users` are staff. Access is governed by `property_team_assignments`, not a global role. An admin user has assignments across all properties with `can_manage_roles = true`.

---

## Obligations engine

```
events
  └── obligations
        ├── assigned_role        — role-level ownership
        ├── assigned_user_id     — specific person (nullable)
        ├── escalates_to_role
        ├── escalates_to_user_id
        ├── due_at               — the clock
        └── proof_requirement    — what closes it
```

One event can spawn multiple obligations for different roles. The clock is real: `now() > due_at` = overdue. Overdue AI-owned obligations escalate to humans.

---

## Auth tables

```
team_invites             — OTP holder (both onboarding invites and re-login codes)
staff_sessions           — active browser sessions (token digest stored, never raw)
```

`team_invites` is dual-purpose: it handles both first-time staff onboarding (invite link + OTP) and re-login (system-minted row with `accepted_user_id` set at creation and empty `allowed_modules`). The verify endpoint reads the marker and branches accordingly.

---

## Money

```
charges                  — scheduled and one-time charges
payments                 — received payments
bank_transactions        — Plaid-sourced raw bank feed
ledger_entries           — the canonical money truth
```

Nothing is `report_ready` until a human approves it. Parsed bank transactions are claims. Matching to a charge + human approval promotes to truth.

---

## Key invariants

- `leases.space_id NOT NULL` — a lease always knows its space
- `ensure_unit_space` trigger — a unit always has ≥1 space
- `contact_preferences` keyed `(person_id, channel)` — STOP is global per person, not property-scoped
- Double promotion blocked by DB unique constraint, not code discipline
- `team_invites.allowed_modules = '{}'` + `accepted_user_id IS NOT NULL` = re-login invite (not onboarding)

---

## Properties table notable columns

| Column | Purpose |
|--------|---------|
| `sms_number` | Twilio number for this property; required for OTP SMS delivery |
| `timezone` | Used for all time-of-day calculations |
| `operator_id` | Links to the operating company |

Only properties with `sms_number` set can send staff OTP via SMS. The Demo Building (`a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`) is currently the only one configured.
