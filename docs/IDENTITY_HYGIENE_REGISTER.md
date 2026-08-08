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

> ## ⚠ CORRECTED 2026-08-08 — THIS ENTRY WAS WRONG WHEN FIRST WRITTEN
>
> It originally read **"Reachable today: No"** and **"Current operating
> consequence: None."** Both were false. The record carries an **open leasing
> lead at the same property as work order 1006**, which makes it a reachable
> prospect identity under Tier 2 of the production inbound resolver — a live
> collision, not a latent one.
>
> The error came from the evidence, not the reasoning: an inventory built on
> `information_schema` foreign-key views reported "67 tables checked, 0 rows
> attached" and I published that as proof of inertness. The corrected Gate 4
> check, which queries the production reachability predicates **directly**
> instead of walking FK metadata, found the lead immediately.
>
> The lesson is the one this project keeps re-learning: **a catalog is a
> description of the world, not the world.** Ask the question production asks,
> against the rows production reads. See H-2 for the method defect itself.

| | |
|---|---|
| **Recorded** | 2026-08-08, during Release 0 Gate 4 preflight |
| **Kind** | duplicate identity, **reachable** |
| **Source** | `persons.source = 'boardroom_demo'`, created 2026-07-17 |
| **Reachable today** | **YES — open leasing lead (Tier 2 prospect)** |
| **Current operating consequence** | an inbound SMS from that number to the property-facing line can resolve to this demo person |
| **Blocks** | Release 0 Gate 4 — correctly |
| **Removal** | close the lead through a governed leasing path, then retire the person in a governed identity-cleanup slice |

### What it is

A `persons` row created during a boardroom demo, carrying a real staff member's
mobile number. The same number is also the staff member's `users.phone`, which
is how it surfaced: the Gate 4 tester fixture flagged the phone as owned by two
identities.

### How it is reachable

`communications_boundary.js` resolves a person from an inbound number through
exactly two tiers:

```text
TIER 1  resident  an ACTIVE lease naming the person in tenant_ids,
                  AND a tenant_invite with status='used' for that property
TIER 2  prospect  a leasing_leads row whose status is not 'leased' or 'lost'
```

**This record satisfies Tier 2.** It holds an open (non-terminal) leasing lead
at property `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` — the same property that
owns work order 1006. So an inbound message from that number to that property's
line resolves to this demo person as a prospect.

The staff identity remains a `users` row: different table, no
`users.person_id` bridge. Nothing about the staff member's authority or
assignments depends on this record. The collision is not "which record is the
staff member" — it is that **one phone number is simultaneously a staff
identity on the operations rail and a prospect identity on the resident rail.**

### Why the check that found it was still the right check

The first version of Gate 4's `T3` asked *"does any `persons` row share this
phone"*. It failed — for a reason that turned out to be right, by a test that
was asking the wrong question. Had the response been to retire the row so the
check went green, the **real** defect (a live prospect identity on a staff
member's number) would have been erased along with the symptom, unexamined.

Correcting the check to test *reachability* did two things at once: it stopped
dormant rows from blocking proofs they have no bearing on, and it produced a
failure that names the actual operating consequence — *"prospect … at property
… — an inbound could genuinely resolve to this person"*. That is the difference
between a test that blocks and a test that explains.

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

Note that retiring the person is now the **second** step, not the first. The
open lead is what makes the record reachable, and a lead is leasing state — it
should be closed through a governed leasing path, by a human who can say what
outcome it had. Retiring the person while an open opportunity still points at
it would leave the leasing pipeline referencing a retired identity.

---

## H-3 · A second staff phone is also a reachable prospect identity

| | |
|---|---|
| **Recorded** | 2026-08-08, by the Release 0 collision-free tester search |
| **Kind** | duplicate identity, **reachable** |
| **Who** | the staff user whose phone ends ****3053 — **identifier deliberately not transcribed here** (see note) |
| **Reachable today** | **YES — open prospect identity at property `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`** |
| **Current operating consequence** | an inbound SMS from that number to the property-facing line can resolve to a prospect rather than to the staff member |
| **Removal** | close the opportunity through the governed leasing path if it is not a real one; otherwise this is a genuine dual identity and needs a product answer, not a cleanup |

> **Correction, same day.** This entry first named a user id read off a
> screenshot, and it was the wrong one — that id belongs to a different staff
> member entirely. The identifier is now omitted rather than restated: the
> phone suffix and the tool that found it are enough to re-derive the row, and
> a UUID copied by eye is exactly the failure this project has now hit three
> times. Re-derive identifiers; never transcribe them.

Found the same way H-1 was: by running the production reachability tiers,
not by inventorying foreign keys. It was not looked for — the tester search
enumerated every technician the Assign picker would offer and checked each
one, and this fell out.

**Two independent instances is a pattern, not a coincidence.** The staff
directory and the leasing pipeline both key on a phone number, and nothing
prevents one number from carrying an identity in each. H-1 came from a
boardroom demo; this one's origin is not yet established and should not be
guessed at.

The register did not assume this was demo residue. The owner has since
stated that the environment carries no real counterparties yet — every
resident, prospect and opportunity in it is dummy data — which settles the
origin question that this entry deliberately left open.

That determination changes what closing the opportunity would *mean*, and
nothing else. Marking a fabricated lead "lost" records something true. It
does not make phone-keyed dual identity a non-problem: the moment real
counterparties exist, a staff mobile that also carries a prospect identity
is a live ambiguity on the resident rail, and nothing in the schema
prevents it. H-1 and H-3 are two instances found in one afternoon without
looking for either.

**The removal condition is therefore unchanged**, and it is not "close the
lead". It is a product answer to phone-keyed identity collision between the
staff directory and the leasing pipeline. Cleaning these two rows would
remove today's symptoms and leave the mechanism intact.

### What the same search also surfaced

Two of the four technicians the Assign picker offers — `Demo Leasing
Manager` and `Solo QA Operator [INTERNAL]` — carry **no phone at all** on
their staff record. They are assignable but cannot receive an attributed
inbound message. That is not a defect in itself; it is recorded because it
means the pool of staff who can carry a transport proof is much smaller
than the pool of staff who can be assigned work.

---

## H-2 · Method defect — `information_schema` FK walk under-reports

| | |
|---|---|
| **Recorded** | 2026-08-08, on discovering H-1 was mis-classified |
| **Kind** | measurement method, not data |
| **Status** | method abandoned; superseded by direct predicate queries |

An ad-hoc inventory walked `information_schema.table_constraints` joined to
`key_column_usage` and `constraint_column_usage` on `constraint_name` alone, to
find every foreign key pointing at `persons(id)`. It reported **67 tables
checked, 0 rows attached**, and that result was published as proof that the H-1
record was inert.

It was not. `leasing_leads.person_id` is a plainly declared foreign key
(migration 038: `uuid not null references persons(id)`) and the row existed the
whole time.

**No shipped tool used this method.** It appeared in a throwaway diagnostic and
in an unshipped draft writer, both discarded. The Gate 4 check that found the
truth does not walk metadata at all — it runs the production predicates against
the production rows.

Two rules follow:

- **Ask the question production asks.** Reachability is defined by the
  resolver's own joins, not by the existence of a foreign key. Even a perfect
  FK inventory would have answered a different question than the one that
  mattered.
- **A negative result from a metadata query is weak evidence.** "Nothing
  references this" is exactly the shape of claim that a lossy join returns for
  free. If a zero is load-bearing, get it from the catalog (`pg_constraint`)
  or, better, from the predicate itself.
