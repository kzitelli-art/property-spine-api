# Availability basis repair — Fable acting lead, 2026-09-06

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Priority 1 of
`FABLE_ACTING_LEAD.md`. Candidate branches, both named
`claude/read-side-basis-protection-20260906`:

| Repo | Base | Candidate commits |
|---|---|---|
| API | `daf7e99` (product identical to `77d6156`) | `81a8ec5` guard + unit test + proof modes + verify_all wiring · `586da32` second browser fixture · docs commit carrying this receipt |
| App | `0785cf8` | `9bf6ea3` groups, notes, app test, browser proof population check |

No PR, no merge, no rebase, no force-push, no migration allocation, no
production or provider action, zero actual-source confirmations. The pending
claim-index DDL was applied only to the nonce-owned proof database.

## Question

Which actual rooms can I market, and what remains unknown? Concretely: a
position with no established occupancy basis was advertised as
`marketable_now` while the Rent Roll refused to bucket it and Ask Spine
counted it as not established.

## Competing explanations, before touching code

1. The marketing classifier never consults the basis axis (QB's theory).
2. The basis axis is consulted upstream and the fixture merely lacks a
   use type or turnover row, so the defect is a fixture artefact.
3. The defect is real but the Rent Roll agrees with availability, so this
   is one surface's ruling, not a reconcile failure.

Source reading at `77d6156` supported 1: `marketingState` reads
`conflict_state`, `is_down`, `operating_use`, `evidence_state === "disagrees"`,
`availability_state`, `successor`, `future_commitment`, `lease`,
`possession_state`, `physical_readiness`, `triage`, `use_type` and nothing
named `basis_state`, `bucket`, `inconclusive` or `unreconciled`. 2 and 3 were
falsified by running the product, below.

## Falsifier, and what it showed

`tests/proofs/onboarding_space_availability.db.js` with
`PROOF_HISTORICAL_READER_CHALLENGE=1` (QB's parked extension, applied from
`fable-reset/api-proof.patch` with `--ignore-space-change` after `--check`),
run on Linux against an owned disposable database and an owned server on
loopback. Every read is real HTTP except the Ask Spine gather, which uses the
proof's read-only transaction.

| Product | Case | Positions | Not established | Ask open | marketable_now |
|---|---|---|---|---|---|
| unrepaired `77d6156` | historical bare-unit vacancy, 2 rooms | 2 | 2 | 0 | **2** |
| unrepaired | single room, source never confirmed | 1 | 1 | 0 | **1** |
| unrepaired | single room, confirmed (control) | 1 | 0 | 1 | 1 |
| repaired `81a8ec5` | same three | 2 · 1 · 1 | 2 · 1 · 0 | 0 · 0 · 1 | **0 · 0 · 1** |

The witness passes on the unrepaired product (`historical-reader-witness.json`)
and fails on the repaired product at the assertion that names the defect,
`actual 0, expected 2`. That failure is the evidence the repair changed the
observed outcome; the witness is kept as mode `1` and not weakened.

Unit check `tests/unit/availability_occupancy_basis.test.js` (QB's text,
copied verbatim): 2 fail / 2 pass before, 4 pass after. The whole unit glob
was run before and after: the same 20 files fail both times for environment
reasons (`DATABASE_URL is not set`, stale paths under `tests/src/`); only the
two new assertions moved. Lists: `unit-suite-failures-{before,after}.txt`.

## What changed, exactly

`src/surfaces/availability_read.js` — two guards, placed **below** the
operative-lease, future-commitment, activation-pending, possession and
turnover guards and **above** the triage overlay and use-type checks:

```text
basis_state !== "established"      → occupancy_unknown      (no basis at all)
evidence_state === "unreconciled"  → evidence_unreconciled  (a claim reached
                                                              the reader and
                                                              could not be
                                                              reconciled)
```

Strict on purpose: a position that does not carry an established basis is
unknown whether the field says so or is missing. Both states: no date
(`available_from: null`, `blocking_fact` names the silence), a human label,
an entry in `states` and in `headline`, and the row now carries
`basis_state`, `basis_type`, `basis_ref` so the state is explainable without
reading English. QB's proposed names were kept; no existing contract served
the distinction better.

Every consumer of `marketing_state` in `src/` was read before the change:
application targeting is an allowlist (`OFFERABLE_NOW`) so an unknown state
is not offerable; unit-turn and readiness reads relay `blocking_label`;
pricing packets count `marketable_now` only. Slice 9's classifier proof
(57/57) resolves above the new guards.

## Preserved invariants, observed not inferred

Successor mode of the same proof (`historical-reader-successor.json`), real
HTTP unless stated:

- unknown rooms read `occupancy_unknown`, keep `space_id · unit · room`, carry
  no date, name `occupancy_basis_not_established`; `headline.occupancy_unknown`
  equals the count; `states` sum to `count`;
- the Rent Roll unit view (`/operator/rent-roll/units`) reports the same
  `not_established` count and `open` 0 or 1; Ask Spine's tenancy position
  agrees;
- control 1: a lease in force beside an unknown room → `occupied` /
  `occupancy_unknown`; the lease is never hidden;
- control 2: a lease starting after the as-of date on an unknown room →
  `successor_pending`, `basis_state` still `not_established`;
- control 3: a confirmed named vacancy replayed as a held row under an
  established baseline → `evidence_unreconciled`, Rent Roll bucket
  `needs_review`, Ask `needs_review` 1, `headline.occupancy_unknown` 0 — unresolved
  evidence is not counted as absence of evidence;
- every proposal record byte-identical before and after each read.

Wider suites on the repaired tree, owned server on port 3000 with the boot
script's environment: leasing clean path, hostile falsifications (16/16),
cross-surface reconciliation, standing vs review, Ask Spine facts — all PASS.
Space-availability successor proof PASS.

## App

`PS_AV_GROUPS`: `occupancy_unknown` and `evidence_unreconciled` join
"Contested or unresolved" (QB's parked hunk). Adjacent, same class, fixed:
`not_ready_confirmed` and `readiness_unknown` matched no group and were
silently dropped from the page; they join Blocked. The app test now pins that
every server state except `occupied` lands in exactly one group, renders an
unknown row (identity, reason, no date, no Person Card), and checks both
renderers state the two shared conditions. 67/67.

Browser proof `canonical_onboarding_review.browser.js`, spaces phase: the
filtered visible-row comparison QB flagged is replaced by a complete
displayed-population check by exact identity (`Unit N · Room`), an
explained-and-undated check per unresolved row, a no-blocker check per
marketable row, and the existing occupied exclusion and price checks. A
second fixture (API `586da32`) carries an unconfirmed Room3 under an
established baseline. Run in Chromium against the owned server: both
fixtures PASS (`browser-spaces.json`, `browser-spaces-unknown-room.png`).

## Recorded, not repaired

1. **App navigation race** (`index.html`, `renderDesk('leasing')`): the desk
   paints, awaits its condition and tour-schedule reads, then calls
   `renderDailyLeasingSurface` again. A Market & Pricing click inside that
   window opens the workspace, which the late repaint then covers. Observed
   deterministically on the second fixture (failure screenshot showed the
   desk with the summary "1 marketable now" already populated). The proof
   now waits for the desk to settle; the defect is its own slice.
2. **Three stale proofs outside CI** (`availability_canonical_proof.js`,
   `scenarios/cross_surface_invariants.js`,
   `slice9_application_target_authority_proof.js`): already red on the
   unmodified tree against the e2e fixture (2, 2, 16 failures); after the
   guard 4, 2, 24. Every added red is a fixture position with no opening
   claim and no lease that the proof expected to be marketable or offerable,
   which is the defect itself. CI runs only `verify_all.sh`, which does not
   invoke them. Not weakened, not deleted. They need an established basis in
   their fixture, or retirement.
3. **Production-visible change to expect.** Any property whose positions
   were never established through onboarding (no opening claim, no lease)
   will now read *Occupancy not established* on availability instead of
   *Marketable now*. The Rent Roll already said Not Established for those
   positions; availability now agrees. QB should count them on the owned
   database before release.
4. **Readiness beside an unknown.** The unknown room shows "Ready" in the
   readiness column because the classifier defaults `ready` with no turn in
   progress. Priority 4.
5. `onboarding_space_availability.db.js` is not in `verify_all.sh`; CI never
   runs it. It ran here through a Linux twin of the owned-server portion of
   `onboarding_review_local.js` (scratch, not committed) because the wrapper
   is Windows-bound and the boundary's port probe binds IPv6, which this
   container lacks.

## Proof rung

Unit → real Postgres → real HTTP → Chromium against the owned server, on
Linux. Not browser-verified on the desktop wrapper, not deployed, no CI run
read for these commits at the time of writing.

## Cleanup

Owned server stopped after every run; the owned database is a nonce-named
disposable on loopback and is dropped with the session. Egress, SMS and
Anthropic logs stayed empty. No private originals, rows, tokens or runtime
identifiers are in this directory; the browser receipt carries none.

## Next

Priority 2 (identity of historical claims) and Priority 3 (unattached claims
stay intelligible). Protection 1 from the earlier review — surfacing a
bare-unit claim as `unreconciled` on every bed — was **not** implemented:
Priority 3 rules out broadcasting one claim to N beds, and with the
availability guard in place the beds already read unknown on all three
readers. What remains is intelligibility of the retained claim, which is
Priority 3's question.

---

# Priority 2 — a historical claim never acquires a new identity (same day)

API `857cf34` on the same candidate branch. Reader only: `src/tenancy/space_position.js`,
proof `tests/proofs/opening_claim_identity.db.js`, wired into `verify_all.sh`.

## Question

Does an old opening claim follow a replaced unit with the same number, a
changed room label, or a multi-room set that later becomes single-room? Tested
with linked lineage (an `import_source_rows` row carrying
`produced_unit_id`/`produced_space_id`) and null lineage (no evidence row)
separately, each case on its own synthetic property.

## What the unrepaired reader did (witness mode, 17/17 on `586da32`)

| Case | Lineage | Observed on the unrepaired reader |
|---|---|---|
| A replaced unit, same number | null | claim re-attached to the replacement unit by number text |
| B replaced unit, same number | linked to the retired space | lineage ignored; claim followed the number |
| C room relabelled | linked | claim lost; the bed read not established |
| C room relabelled | null | unknown (correct; labels are not identity) |
| D 3 beds shrunk to 1 (synthetic; no product writer deletes a space) | unit-linked, no space | bare-unit claim attached to the remaining bed |
| B downstream | linked | Rent Roll open 1 · availability marketable_now 1 · Ask open 1 on the retired unit's claim |

Two facts learned on the way: `uq_unit_per_property` forbids two live rows
with one number, so a replacement requires the retired row to be renamed
first (the retirement row keeps `original_unit_number`); and the baseline
table admits one current baseline per property with a deferred shape guard,
so the proof supersedes exactly the way `establishOpeningPosition` does.

## The rule now

```text
1. produced_space_id          → that position only (survives a relabel;
                                 never follows a number onto new inventory)
2. produced_unit_id, no space → inside THAT unit only: named key by label;
                                 bare key only for the unit's whole-unit
                                 position — never a bed
3. no lineage (legacy rows)   → text: exact unit|label, or bare key for a
                                 whole-unit position; and never once a
                                 retired unit has carried this number
```

No creation timestamp, no count of one. The `count(*) = 1` rule is gone;
grain (`position_kind`, or the whole-unit label when unset, derived exactly
as `dated_positions` does) replaces it.

## Successor (17/17) and controls

A and B: the replacement unit inherits nothing. C linked: the claim follows
its durable space through the relabel; C null: stays unknown. D: a bare-unit
claim never attaches to a bed. E: linked whole-unit, legacy whole-unit with
no retirement history, and a bed confirmed by bed all still resolve. F: a
read between two baselines answers from the earlier one, after the later
one from it; an operative lease outranks either at every date. Downstream
on B: Rent Roll `not_established 1 / open 0`, availability
`marketable_now 0 / occupancy_unknown 1`, Ask `not_established 1 / open 0`.
No proposal row rewritten. The witness re-run on the fixed reader fails at
exactly the five defect assertions and at nothing else.

Regression on the fixed reader over real HTTP: space-availability successor,
historical successor challenge, leasing clean path, hostile (16/16),
reconciliation, standing, Ask Spine — PASS. Unit gates 4/4 and 4/4.

## What this changes for existing data, and one count QB should take

A historical **unlinked** bare-unit confirmation on a unit whose single
position is a bed (label not "(whole unit)", `position_kind` not `unit`)
used to resolve by count-of-one and now reads not established. New
confirmations are unaffected: QB's writer records `produced_space_id`, which
rule 1 honours regardless of grain. QB should count rows of that historical
shape on the owned database before release; if the count is material, the
decision is whether to backfill `produced_space_id` for them by a governed
correction, not to reinstate count-of-one in the reader.

## Recorded, not changed

- The legacy `/operator/rent-roll` projection (`snapshot_loader.js`,
  `sourceRowPosition`) prefers `produced_space_id` but for null-lineage rows
  still resolves by text with `matches.length === 1` — the same class, one
  reader over. Out of this slice; the canonical readers are the ones the
  signed-in app uses.
- Case D cannot occur through any product writer (retirement is unit-level;
  only `seed_snapshot.js` deletes spaces). It is asserted anyway because the
  rule is about grain, not about reachability.
- `opening_claim_identity.db.js` is database-level: it calls the same
  `unitRentRoll`, `availabilityRead` and `readTenancyStanding` the routes
  call, not the routes. HTTP agreement for the same basis is covered by the
  space-availability successor proof.
