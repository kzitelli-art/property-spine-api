# Current rent-roll reconciliation — receipt (2026-09-13)

Assignment: finish the governed path for accepting a **current** external
rent roll (the Temple Tracker shape: unit, room, name, monthly rent, key
pickup, semester — and **no lease dates**) into a property that is already
onboarded and has an established opening position. Skyline immediate,
Greenery / the next property through the same mechanism.

Start point: API `5765357d2933cce144ad1d9b74b79090f0580afe`
(`codex/launch-api-integration-20260913`), app
`cc5a100d18e5327c9dda2b049cd4cce95c6ad2c2`
(`codex/source-home-management-app-20260913`), both unreleased candidates.
Isolated worktrees, nonce-owned loopback databases, fake transports. No
production read or write, no shared database action, no provider action,
no deployment, no merge / rebase / reset / force-push, no production source
confirmation and no actual 148-bed acceptance was performed in this lane.

## Commits (branch `claude/current-rent-roll-reconciliation-20260913` in both repos)

| repo | commit | what |
|---|---|---|
| API | `be9ae71` | confirm accepts a dateless signed row as current occupancy with terms unknown, offers the home's right-holders as identity candidates, ties a recognised resident to the lease in force / pending without a second lease; ingress `home_tenant` candidates; `Pending` is not signed; unit-basis placeholder grain; tracker column spellings; proof `tests/proofs/current_rent_roll_reconciliation.db.js` (59) registered in `verify_all.sh` |
| API | this commit | receipt, scrubbed evidence, CURRENT_STATE row 74 |
| app | `4558460` | five isolated blocks in `index.html` (listed below), unit-test pin, browser proof `current_rent_roll_reconciliation.browser.js` (13) |

## The mechanism (nothing new was written beside it)

The path is the existing Deal Setup source-home review and confirmation:

```text
POST /deal-setup/deals/:id/properties/:pid/source        retained bytes, as-of date
POST /deal-setup/activations/:id/preview-source          groups the source's own labels; suggests only exact text
POST /deal-setup/activations/:id/read-source             the reviewed mapping (fingerprinted; stale / wrong-property refused)
POST /deal-setup/proposals/:id/confirm                   Add — one canonical writer, now four outcomes
POST /deal-setup/proposals/:id/resolve-resident          the human picks an offered candidate or creates
POST /deal-setup/activations/:id/establish               the current position supersedes the prior one (both retained)
```

`src/leasing/tracker_intake.js` (dormant; no HTTP caller; stages
forward-lease commitments) was recorded as an existing mechanism and not
used: a current tracker is a statement about who occupies today, not a
forward commitment.

## First red on the baseline, shown before any change

`evidence/current_rent_roll_reconciliation.witness.json` — the proof run
unchanged against `5765357` on a fresh owned database (ledger 197 + the
pending source-claim index): **45 passed, 8 failed by design.**

1. **The actual shape is refused.** All 160 Skyline rooms carry
   `position_kind='unit'`; `grainMatches` requires `'bed'` for a bed-basis
   selection, so `read-source` refused the reviewed mapping with
   `inventory_target_changed` and wrote nothing. **The requirement is
   right and the classification is wrong**: relaxing the grain rule would
   let a whole-unit position stand in for a bed. The correction is Codex
   Luna's governed mapping tool (`tools/apply_unit_type_mapping.js`,
   untouched here). The proof applies it as a *labelled fixture stand-in*
   (`update spaces set position_kind='bed'` on the rooms, before any
   business action) and records the dependency.
2. **A dateless signed row manufactured a lease.** Add on a tracker row
   created an **active lease with null start and end** (an unbounded
   term) from a source that carries no dates.
3. **No recognition.** A name-only row on a bed whose resident already
   holds a lease offered no candidate; the only choice was "create new
   resident" — a duplicate person, then a refused duplicate lease
   (`overlapping_operative_lease`). Same for a bed with a pending applicant.
4. **A held July claim could not be superseded** by the current signed row
   (consequence of 2).
5. **The unit shape aborted.** The whole-unit placeholder the units trigger
   creates has no `position_kind`; the unit-basis grain rule required
   `'unit'`, so the second property shape could not even be previewed
   into a selection.

The app, run against the successor API with the shipped blocks
(`evidence/app_baseline_blocks_first_red.browser1.out` and the runs after
it): the picker filtered on `space.position_kind`, a field the preview
never sends (it sends `kind`), so **no existing home could be chosen**;
the "N of M current source identities have a reviewed target" counter
and the retained-claims notice with its Review-again button carried a
class with **no CSS rule** (`.sa-msg` is `display:none` unless `.ok` /
`.err`) — rendered, never visible; a refused Add did **not reload** the
setup, so the row kept showing Ready; and the identity candidate buttons
were gated on `identity_review.status === 'staged'` (the ingress writes
every candidate case as `needs_review`) **and then overwritten** by the
row's Add / Leave out — no candidate was ever reachable from the table.

## What the correction permits (successor: 59 passed, 0 failed)

`evidence/current_rent_roll_reconciliation.successor.json`, fresh owned
database at `be9ae71`.

- **Every source row is accounted for.** 160 rows → 160 evidence rows, one
  per source row, raw cells retained (the two identity conflicts keep
  `'212A - Reno'` / Room A/B and the `405A`/`405B` Room-A pair as distinct
  identities that each require an explicit reviewed choice). 148 signed
  rows stage; the 12 blank rows are needs review, never vacancy.
- **A dateless signed row is a dated observation.** It is compared from the
  source's as-of date forward; accepted as **current occupancy with
  contractual terms unknown**: the evidence row names the person and the
  exact home, no lease is created, the reported rent stays evidence. A row
  with dates still creates the lease (unchanged). An explicit VACANT row
  still records vacancy.
- **Recognition over re-entry.** The residents holding a right on the home
  (lease in force or pending) are offered as identity candidates; when the
  person picked already holds that right, Add ties the row to the existing
  lease (`tied_to_existing_lease`) — no second lease, **a pending lease is
  not activated and no possession is recorded** by a later as-of date.
- **A different claimant over a right in force is held** (needs review,
  `overlapping_operative_lease`); the prior tenancy is never ended.
  Overlapping pending rights hold the same way.
- **Blank / unchecked rows cannot be added as anything** (422
  `resident_identity_required`), on a July-occupied bed and on a
  July-vacant bed alike.
- **Authority and replay.** A replayed Add is refused by name
  (`already_promoted`); an actor without leasing/management access at the
  property cannot add; access revoked while the Add waits on the setup
  lock is refused after the wait; a suspended actor is refused.
- **Establish supersedes July** (both positions retained; the July one
  names its successor). Readers agree: dated rent roll, Rent Roll unit
  view, tenancy standing and entitled Ask gathering (no ids) — total 160,
  occupied 122 (92 by accepted claim with terms unknown, the rest by
  leases in force), activation pending 12, open **0**, needs review 26.
  Availability offers none of the unresolved or conflicting beds.
  `occupancyByBasis` (lease-based) still reads 31 — a stated basis, not a
  disagreement (see owner decisions).
- **Source integrity.** Re-uploading identical bytes is the same retained
  source (same sha256) and a new setup over them offers the earlier
  reviewed mapping for every home (`reuse`); a changed payload under the
  same identity → `source_rows_mismatch`; a different as-of date for the
  same bytes → `source_date_mismatch`; decisions carrying pre-correction
  fingerprints → `inventory_target_changed`; a decision naming another
  property's home is refused; re-reading the same file into the same setup
  is refused by name.
- **Second property shape** (unit basis, "Apt 1..3"): the same doors, no
  Skyline-specific branch — exact whole-unit homes auto-suggested, a dated
  row creates a lease, an undated row accepts occupancy with terms
  unknown, VACANT is vacant; 2 occupied / 1 open; Skyline unchanged.
- **Browser (13/13)**, `evidence/current_rent_roll_reconciliation.browser.receipt.json`,
  screenshots beside it: the tracker's labels shown as received; a visible
  0-of-4 counter (asserted with `elementFromPoint`, not `innerText`); every
  current row carries a picker offering `1417-101 · Room1 …`; a hand-picked
  mapping applies; Add on a new resident reads Added with "Contractual
  terms unknown" and no lease; Add on the bed with a lease in force offers
  **Use <resident>**, then Add reads "Already represented" with one lease
  on the bed; the blank row offers only Leave out; Establish.

## Proof counts at the delivered commits

| what | result |
|---|---|
| `tests/proofs/current_rent_roll_reconciliation.db.js` on `5765357` (witness) | 45 / 8 by design |
| same on `be9ae71`, fresh owned DB | **59 / 0** |
| app `current_rent_roll_reconciliation.browser.js` (Chromium, staff shell) | **13 / 0** |
| app suite `run_harnesses.sh` | 70 harnesses · 2,395 passed · 0 failed |
| `tests/verify_source_governance.js` | PARENT EXIT 0 |
| `tests/unit/rent_roll_bridge` · `rent_roll_source_adapter` · `rent_roll_space_identity` | 19/19 · 13 · pass |
| `source_home_identity_review.db.js` · `deal_setup_http.db.js` · `canonical_onboarding_ledger.db.js` | PASS · PASS · PASS |
| `opening_claim_identity` · `relay_edges` · `unattached` | 17/0 · 12/0 · 14/0 |
| `onboarding_claim_index_dependency.db.js` (`PROOF_CLAIM_INDEX=pending`) | PASS |
| CI at the delivered API commit | recorded in CURRENT_STATE row 74 |

Pre-existing failures, **identical on the baseline** (witness pairs in
`evidence/`), none caused here and none of them registered in `verify_all.sh`:
`deal_setup_opening_tenancy.db.js` D6 / D7 / D11 / D13 (4, both trees);
`confirm_proposal_operative_overlap.db.js` 34 (its fixture rows carry no
actual rent, so confirm answers `actual_rent_required` before the overlap
check on both trees); `person_ingress_hostile.db.js` 4 and
`gate_person_ingress.js` 2 (undeclared human-minting path in
`src/baseline/baseline_routes.js`, stale register — both trees).

## Migration prerequisites

- **No schema change in this lane.** Migration 198 stays Terra's; 199 was
  not reserved.
- Harness prerequisite, recorded and never claimed deployed: the owned
  databases ran ledger 197 plus
  `migrations/pending/proposed_source_claim_identity.sql` (Terra's lane),
  exactly as the `verify_all.sh` step "pending source claim identity" does.
- Production is at 182 applied / 194 boundary. This path needs the Deal
  Setup source-home review (196) and the pending index released before it
  is usable there. Release is QB's act.

## App integration notes for QB (`index.html`, five isolated blocks, each commented "Isolated block")

1. CSS: `.sa-msg.warn{display:block;…}` after `.sa-msg.err`.
2. `dsRenderIdentityReview`: read `space.kind` (fallback `position_kind`);
   unit basis accepts the unclassified whole-unit placeholder.
3. `dsIdentityChoice`: `dsRender()` at the end.
4. `dsConfirmRow`: reload the setup in the catch path.
5. `dsIdentityActions`: accept `identity_review.status` `needs_review`;
   `dsRenderSetup`: `act +=` instead of `act =` for Add / Leave out.

## Owner decisions that remain (prepared, not taken)

1. **160 explicit picks.** Tracker labels (`101A` / `A`) are not the
   canonical labels (`1417-101` / `Room1`); by the frozen rule only exact
   text is suggested, so every Skyline home is an explicit reviewed choice.
   The reviewed mapping is reused for the same bytes on any later setup.
   A letter→room-ordinal convenience would be a new rule; not built.
2. **"Approve all unresolved as new homes"** on an onboarded property would
   create 160 duplicate units under the tracker's labels. Not changed here;
   a guard (hide or confirm when current inventory exists) is QB's call.
3. **The two identity conflicts** (`212A - Reno` A/B; `405A`/`405B` Room A)
   require an explicit reviewed mapping; no production identity claim.
4. **12 blank rows stay needs review.** Vacancy is stated by an explicit
   VACANT row or by inventory, never by omission.
5. **Rows tied to pending leases** stay pending; activation is a Leasing act.
6. **Rows whose claimant differs from the lease in force** (3 in the
   fixture) are held; ending the prior tenancy is a governed act, not
   an import.
7. **Luna dependency:** the 160 rooms must be reclassified by the governed
   mapping tool before the reviewed mapping can apply.
8. **Occupancy basis:** the dated read counts accepted claims (terms
   unknown) as occupied (122); the lease-based `occupancyByBasis` reads 31.
   Both are labelled; which the walkthrough quotes is a ruling.
9. **Authority is per-user assignment**, not session property: a session
   scoped to another property, held by a user assigned at this one, can
   preview this setup (existing design; recorded, unchanged).
