# Work order × person — handoff to the maintenance thread

**Written 2026-07-26. Not a build. A stand-down note plus the rule, so the
thinking is not lost and the same thing is not built twice.**

## What happened

This thread was about to build `work_order_people` — a table with roles,
sources, claim strength and correction lineage — to answer "which human is
this repair about?"

Checking live first found it already answered. The maintenance thread had
shipped migration **098 `work_order_operational_facts`**, which added to
`work_orders`:

| column | live comment |
|---|---|
| `reported_by_person_id` | *The person who REPORTED the issue. NULL when staff-originated. May differ from `affected_person_id` — a neighbour can report a leak in someone else's unit.* |
| `affected_person_id` | *The person whose home or tenancy is AFFECTED. NULL when unknown or when the work is on common area.* |

Same distinction, same worked example, already live. Building a parallel
table would have been two canonical architectures for one fact (§17), so
this thread deleted its own migration and module rather than ship them.
**Nothing here was built.** The maintenance thread owns this.

## Two things the maintenance thread should know

**1. Live schema is ahead of `main`.** The 098 migration is applied to the
Neon database but the file is not in the `api` repo — `origin/main` is 0
ahead / 0 behind local and contains no `098_*.sql`. Anyone else adding a
098 gets a number the ledger has already spent. `migrate.js` now hard-stops
on that (see below), but the real fix is committing the migration file.

**2. Nothing reads or writes the columns.** `grep` over `src/` and `tests/`
returns zero references, and 1 of 6 work orders has either filled. This is
the same built-not-connected shape found elsewhere in the codebase — the
columns are correct and inert.

## The rule, if it's useful

The columns are nullable and nothing derives them, so in practice they stay
empty and John still sees a work order with no name on it. What was designed
here to fill them, offered as-is:

- **an explicit reporter is named** → set `reported_by_person_id`
- **exactly one active-lease resident on the unit, no explicit choice** →
  set `affected_person_id` from the lease
- **more than one resident, nothing to distinguish them** → set NOTHING
- **vacant unit, common area, or no active lease** → set NOTHING

Deriving is worth doing because the answer is usually sitting there: the
Phase-0 inventory found the join clean at the activation property — 254
units, one named person each, zero ambiguous. Leaving the field blank when
the lease already says who lives there is the honest-blank rule misapplied.
Honest blank is for when you do not know, not for when you declined to look.

The refusals matter more than the derivation. The cost of guessing is a
maintenance text to the wrong member of a household, and picking the first
row of two is a coin flip wearing a lease id.

**What the derivation still lacks, and what a "does the resident know?"
question would need:** the columns record *who* but not *how we know*. A
derived contact and a confirmed one are indistinguishable once written. If
a surface ever needs certainty — auto-texting a resident about entry, say —
it will need that distinction before it can be trusted. A nullable
`affected_person_basis` (`stated` / `derived_from_lease` / `confirmed`)
would carry it without a new table.

## Related fix that came out of this

`migrations/migrate.js` gained a second guard: a file whose number is
already in the ledger **under a different name** is now a hard stop. The
existing guard only compared files to each other; it could not catch a new
file taking a number the ledger had already spent, which is exactly what
098 was. Verified live — it named the collision and refused to run.

It also surfaced five historical name mismatches, all checked and harmless:
062/063/064 recorded with a Windows ` (1)` suffix, 083/084 recorded with the
whole filename. Those are normalised, not waved through. One real exception
remains documented in the code: ledger `012` is labelled `property_noi_goals`
(renumbered to 029 and never corrected) while the folder's 012 is
`bank_intake` — which did run, confirmed against live: `vendors` 51 rows,
`vendor_aliases` 121, `bank_accounts` 2, `bank_transactions` 160,
`check_register_orphans` 4. **Correcting that one ledger row to `bank_intake`
is a one-line owner decision, not taken here.**
