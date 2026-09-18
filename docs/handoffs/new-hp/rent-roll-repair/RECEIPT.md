# Rent Roll repair — the order of repair, worked

2026-09-18 · owned PostgreSQL 16 · real HTTP · reads only against the governed
Greenery establishment. **No production data was mutated.**

CURRENT_STATE rows **140–149**. This receipt is the arc, not a restatement of
the rows — it records the order things were done in, what each step
**disproved**, and the decisions that are owed rather than taken.

```
API  ecd6ab28  claude/rentroll-grain-refusal-20260918
CI   698 · 699 · 700 · 701 · 702 · 703 · 704  all success
     705 · 706  pending at the time of writing
```

---

## The order of repair, and where it came from

Row 134 had recorded an explicit order of repair after measuring the signed-in
desk: **fix `row.status` first, because everything downstream inherits it; then
point the desk at the canonical read; then `/units`.** Row 137 did the second.
This thread started at the first and followed the list rather than picking.

That mattered: two of the three items turned out not to be what row 134 said
they were, and the order is what made that visible instead of theoretical.

| # | Row | What it was | What it turned out to be |
|---|---|---|---|
| 1 | 140 | `status` carries the resident id | **Deeper**: ingest and read are the same defect run twice |
| 2 | 141 | `/units` is not a dated read | **Wrong diagnosis**: it *is* dated; `occupied` is a collapsing word |
| 3 | 143 | — | Ask Spine's projection had the same collapse, where it costs most |
| 4 | 144–145 | — | CI-defending 143; the collapse pinned on a fixture that already existed |
| 5 | 146 | `management_read` is a second definition | Vacancy was a **remainder** |
| 6 | 147 | — | **Disproved my own framing**: the two derivations agree *on Greenery* — then disproved again: they diverge on claim-backed buildings |
| 7 | 148 | — | A renewal counted twice; I had deferred it for a ruling it never needed |
| 8 | 149 | — | **Row 146 broke a ratio** it fed, and I had dismissed it as prose |

## The one product statement worth carrying out of this

`occupied` is a collapsing word. It sums `contractually_occupied` and
`occupied_terms_not_established`, and the two move independently:

```
Greenery          2026-09-18   occupied 95 = 94 contractual +  1 without terms
                  2027-08-01   occupied 95 =  0 contractual + 95 without terms

claim fixture     2026-07-31   occupied 4  =  1 contractual +  3 without terms
                  2028-01-01   occupied 5  =  0 contractual +  5 without terms
```

On Greenery the headline sits still while the truth collapses. On the claim
fixture it **rises, 4 → 5, at the moment contractual occupancy reaches zero** —
a reader watching `occupied` alone watches the building appear to improve as
Spine loses the ability to prove a single term on it.

That is §40.5's truth wall stated as a measurement rather than a principle:
**`occupied ≠ contractually occupied`**, the family of `escrow funded ≠ City
paid` and `filed ≠ paid`. It is also why the split had to travel with the count
on the conversational surface (§40.4): a screen commits to an altitude and a
person can open the row; **a sentence cannot be opened.**

## Five corrections of my own earlier claims

Recorded as a set because they share one cause, not because each is
interesting.

1. **`/units` is not a dated read** (rows 134, 138) — it is. A frozen number
   looks exactly like a read that ignores its date.
2. **The two occupancy derivations disagree** (rows 138, 146) — they agree on
   Greenery. I was comparing `occupied` against `contractually_occupied`: the
   exact category error this work exists to stop, made in the sentence
   describing it.
   **And then the correction itself was over-general.** On the claim-backed
   fixture they diverge — `occupied 2` here, `4` canonical — and
   `agrees_with_canonical` reads `false`. Agreement was a fact about Greenery,
   not about the code. *Agreement is not convergence*, caught twice in one
   thread on the same field.
3. **`upcoming_pct` needs a ruling before it can be fixed** (row 146) — it
   needed arithmetic. Under either reading, a renewed bed is one bed.
4. **`riskReason` is prose, not a published number** (row 146) — the same ratio
   drives a focus card's severity.
5. **Row 146's own fix was clean** — it silently broke `coverage`, which was
   self-cancelling only while committed beds sat inside `vacant`.

Every one surfaced the same way: **measuring instead of reasoning.** Not one
was found by reading code more carefully.

## Five instances of one method fault, in one sitting

`A check that cannot distinguish the state it is checking for from the state it
is checking against is not a check` (row 125), which appeared as:

- a bare equality comparing two **absent** fields — `undefined === undefined`
  is true (rows 141, 144, 146; three separate files)
- a **falsification that changed nothing**: `git stash -- <path>` on an
  already-committed file creates no stash, exits 0, and the proof re-runs green
  (row 144). Verify a revert by **reading the source**, not an exit code.
- a **shell glob spanning two records**, so a CI watcher reported one commit's
  run finished by matching another's (row 148)

It is not a coding slip. It is the default failure mode of **verifying by
pattern instead of by identity**, and it is worth a standing habit: an
assertion comparing two fields must prove both exist.

## The lesson from rows 146 → 149

**A fix that moves an item between buckets can silently break every ratio those
buckets feed.** Row 146 changed what `vacant` means; two dependent metrics were
computed from its old meaning and neither was named in row 146's own
"not fixed" note, because I had not looked for them.

After reclassifying anything, **enumerate what consumed the old classification
by search, not by memory.** That search was then run (every non-comment
reference to `vacant` in the file): two further consumers, both already
correct. Scope not covered, stated: consumers outside the file — the app.

## What is proven, and at what rung

| | rung |
|---|---|
| `status` no longer carries an identifier; summary withholds unknown occupancy | owned DB + real HTTP, witness/successor payloads; registered |
| `occupied` split on the Rent Roll (`/units`) | owned DB + real HTTP at four dates; registered |
| Same split on Ask Spine's standing projection | owned DB at two dates; **CI-defended via rows 144–145** |
| The collapse itself (occupied rises, contractual → 0) | registered DB proof, 5 red reverted → 32/0 |
| Vacancy is a classification, not a remainder | registered, 21/21, 10 red on the parent |
| Canonical occupancy published beside this surface's own | registered, failure path asserted on both branches |
| `upcoming` and `coverage` arithmetic | registered, 39/39, reds on both unmodified ratios |

**No browser rung in this thread.** The signed-in desk reads occupancy from
`/canonical` (row 137), so these changes are to payloads and to one operator
card's severity, not to a rendered headline.

## Owed — decisions, not code

1. **`standing.truth_state` reads `ESTABLISHED` at a date with zero contractual
   terms**, because `established` there means *has a basis*, not *has terms*.
   A second collapsing word on the same surface. Redefining a truth state
   unilaterally is what row 141's lesson forbids, and it ripples through every
   consumer of `truth_state`.
2. **What does `upcoming` mean** — "beds with someone in them or coming", or
   "beds spoken for"? The arithmetic is now sound under either; the label is
   not chosen.
3. **The ingest's identity routing** — *no candidate → no review → create*
   (row 136). The path with the least evidence mints the durable human, and
   Greenery's 95 Persons have no continuity handle.

## Owed — work, with its blocker named

4. **The Greenery collapse on the real building is not CI-pinned.** Rows
   144–145 pin the arithmetic and the collapse on two registered fixtures; the
   reader's own DB proof cannot be registered because it loads an xlsx from an
   external upload absent from the repo (the ENOENT row 125 recorded).
   Rebuilding it on `tests/fixtures/rent_roll/greenery_1325_2026-08-31.csv`
   is a slice of its own.
5. **`management_read`'s occupancy is still its own derivation.** The canonical
   answer now rides beside it and they agree; replacing the derivation would
   change nothing observable and would put the money, down and model logic at
   risk. Deliberately not done.
6. **Greenery's stored `raw` still contains the contaminated `status`.** Made
   *diagnosable* (`identifier_in_status_field`) rather than repaired; no data
   was rewritten.
7. **None of the G2/G3 app work is CI-defended**, because the declared app pin
   and the convergence app are two branches of the same repo, neither
   containing the other (rows 139, 143). That is the app-main integration, not
   a line in a test manifest.
