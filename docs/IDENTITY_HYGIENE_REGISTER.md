# Identity hygiene register

Latent identity defects: real, recorded, **not currently reachable by any
production resolver**, and therefore not repaired under time pressure inside an
unrelated release. Each entry states its operating consequence honestly — a
defect with no current consequence is still a defect, and saying it is urgent
when it is not is its own dishonesty.

Nothing here is repaired by editing production identity data to make a checker
pass. Each item is removed by a governed identity-cleanup slice that builds a
proper writer, falsifies it, and records a receipt.

---

## H-1 · Latent duplicate identity — `boardroom_demo` person holding a staff mobile

| | |
|---|---|
| **Recorded** | 2026-08-08, during Release 0 Gate 4 preflight |
| **Kind** | latent duplicate identity |
| **Source** | `persons.source = 'boardroom_demo'`, created 2026-07-17 |
| **Reachable today** | **No** |
| **Current operating consequence** | **None** |
| **Removal** | retire via a governed identity-cleanup slice (migration 104 primitives) |

### What it is

A `persons` row created during a boardroom demo, carrying a real staff member's
mobile number. The same number is also the staff member's `users.phone`, which
is how it surfaced: the Gate 4 tester fixture flagged the phone as owned by two
identities.

### Why it is not reachable

`communications_boundary.js` resolves a person from an inbound number through
exactly two tiers, and this row satisfies neither:

```text
TIER 1  resident  an ACTIVE lease naming the person in tenant_ids,
                  AND a tenant_invite with status='used' for that property
TIER 2  prospect  a leasing_leads row whose status is not 'leased' or 'lost'
```

Measured against production: **67 foreign keys in the database point at
`persons(id)`; zero rows anywhere reference this record.** No lease, no invite,
no lead, and no `users.person_id` bridge (`users.person_id` is a declared FK —
migration 067 — so the scan covered it).

The staff identity is a `users` row. Different table, no bridge between them.
Retiring or keeping this person record changes nothing about the staff member's
authority, assignments, or ability to be resolved on the operations line.

### Why it was not repaired during Release 0

The first version of the Gate 4 check asked *"does any `persons` row share this
phone"*, which is not the question production asks. It failed a real fixture on
a row the system could never resolve. Two responses were possible:

1. Retire the row so the check turns green.
2. Correct the check to match the identities production can actually reach.

**Option 2 was chosen.** Writing to production identity data to satisfy a
checker inverts the order of trust — it changes the truth to fit the model
rather than correcting the model. The check now tests reachability, and the
dormant row is *reported* on every run rather than blocking or being hidden.

The record still deserves to go. It is a trap waiting for the day someone gives
it a lease or an open lead, at which point it becomes a genuine collision on a
live resident rail. That is a governed slice, not a footnote in a transport
release.

### Controls that keep the distinction honest

In `tools/activation/gate_tools_falsify.sh`, proven on the isolated baseline:

```text
G4-3a  dormant same-phone person, no reachable relationship   → fixture PASSES
G4-3b  ...and the dormant row is still REPORTED, not hidden
G4-3c  same person given an OPEN lead (prospect path)         → fixture REFUSES
G4-3d  that lead closed as 'lost'                             → fixture PASSES
G4-3e0 the seeded active lease provably exists                (anti-vacuum check)
G4-3e  active lease but NO used invite                        → fixture PASSES
G4-3f  active lease + USED invite (resident path)             → fixture REFUSES
```

`G4-3e0` exists because the first version of this seed silently inserted
nothing — `spaces` requires a `unit_id` and `units` was empty, and a
`psql … || psql …` fallback reported success either way. `G4-3e` then passed
while describing a lease that did not exist. A seed that quietly does nothing
turns every control built on it into decoration, so the seed is now asserted
before the controls that depend on it run.

### When this is repaired

A governed identity-cleanup slice should:

- build a writer that retires by primary key, re-proving inertness **inside**
  the transaction against the live FK catalog rather than a prior inventory;
- require a written `retired_reason` (`ck_persons_retirement_is_explained`
  enforces it, and the tool should refuse first, with an explanation);
- leave `superseded_by_person_id` null — a demo artefact is not a duplicate of
  a canonical person, and the staff identity is not a person row;
- keep the name and source intact. Migration 104: *"A record should still say
  what it was; a separate field says what happened to it."*

A draft of that writer was built during Release 0 and **deliberately not
shipped**: an unused production-identity writer sitting in the deployed
checkout is the same class of latent hazard as the row it was meant to remove.
