# Inventory correction hardening — successor receipt (2026-09-13)

Successor to `RECEIPT.md` (kept unchanged, as history). Start point: API
`89fd43da761c38a52bf28095259f947ee4a78172` (product source `5be5c1c`),
app `045024755b7391c2c8dbb763667e889829166fbe`, both on
`claude/inventory-correction-20260913`. Isolated worktrees, nonce-owned
loopback databases, fake transports; no production, provider, deploy,
merge, rebase, reset or force-push in this lane.

## Commits

| repo | commit | what |
|---|---|---|
| API | `e65dfb2` | policy + migration 197 + coverage gate, lock-then-authority, identity reinstatement, command receipts, standing explanation, bounded reads, two writer doors map the wall to 409, the three proofs and the contract test |
| API | this commit | receipt, migration description, scrubbed evidence, CURRENT_STATE row 72 |
| app | `0d035c8` | reread everything after a decision, drop late responses, server paging, frozen command keys, identity decision controls, explanation in history |

## What was wrong on the delivered candidate, shown red first

`hardening.witness.json` — the hardening proof run unchanged against
`5be5c1c` on a fresh owned database (ledger 195): **58 passed, 35 failed by
design.** The reds an operator would have met:

- **Future writes revived retired inventory.** `POST /operator/work-orders`
  on a retired unit answered **201** and attached a work order *and* its
  obligation. A new child position, a reopen of a declined application and
  a re-target of an open application onto a retired unit were all accepted.
  The occupancy read then disagreed with the retired count by exactly the
  bypassed child position (22 → 15 rentable for 8 retired positions).
- **The authority race was real.** With the correction blocked on its
  inventory lock, admin2 revoked the actor's override through the governed
  PATCH door; when the lock cleared the retirement was **written (201)**.
  Same with the actor suspended through the org door: **written (201).**
  `assertLiveAuthority` read the assignment before the locks and never
  rechecked.
- **Reinstatement double-counted.** A legacy record whose position the
  bed-basis source had established under its parent was reinstated over
  it (**201**); no identity read existed, and the "label among current
  units" check could never fire (`uq_unit_per_property` already forbids a
  duplicate label).
- **No command identity.** A retry of the same command was refused
  `ALREADY_RETIRED`; a changed payload under the same key was not a
  conflict; nothing recorded the command.
- **Conflicts were not named.** The staff history and the standing read
  carried two counts and no explanation; the Ask path had nothing to hand
  the model beyond those counts.

## What the successor does (proven green on `e65dfb2`, fresh database)

| proof | result |
|---|---|
| `tests/e2e/inventory_correction_hardening.e2e.js` (`hardening.successor.json`) | **101 passed, 0 failed** |
| `tests/e2e/inventory_correction.e2e.js`, adapted to replay + identity semantics (`evidence.successor.hardened.json`) | **85 passed, 0 failed** |
| `tests/gates/gate_inventory_relationship_policy.db.js` (`gate.successor.txt`) | PASS — 61 referencing columns, 61 policy entries, 24 blocking tables, 25 triggers (24 + 180's) |
| `tests/e2e/inventory_correction.browser.js` (`browser.receipt.hardened.json`, Chromium, app `0d035c8`) | **29 checks passed** |
| `tests/unit/inventory_correction_contract.test.js` | PASS |
| `tests/verify_source_governance.js` (harness isolation 8/8, Ask Spine reader gate, all) | PASS |
| app suite `run_harnesses.sh` on `0d035c8` | 68 harnesses, 2,291 assertions, 0 failed |
| regressions on this tree, owned DB: canonical_occupancy_holds 101/0 · availability_uncorroborated_claim 18/0 · opening_claim_relay_edges 12/0 · opening_claim_unattached 14/0 · opening_claim_identity 17/0 · leasing_ask_spine PASS · leasing_reconciliation PASS · tenancy_ask_spine unit PASS | green |
| `tenancy_standing_read.db.js`, `tenancy_ask_spine_http.db.js` | refuse to start without the real July workbook artifact — identical on the baseline; CI is their authority |

### 1. Relationship policy and the database wall

`src/tenancy/inventory_relationship_policy.js` is the one declaration:
61 entries covering every column that references `units` or `spaces`
(direct FKs and the named non-FK references), each with a treatment —
`blocks_while_operative` (31 entries, with the table's own status
vocabulary and what NULL means), `retained_history` (21: findings,
walks, scopes, acceptances, claims of work, proofs, observations,
rulings, documents, communications, events, agent messages/proposals,
demo runs), `interest_only` (5: leads, conversations, person interest,
preferred unit, agent-run selection), `source_lineage` (3),
`retirement_ledger` (1). Money and claims (`scheduled_charges`,
`ledger_claims`, `deposit_claims`, `money_events`) and configured
services block while they exist and are never zero by assumption.

The review's relationship counts, blockers and the property-wide conflict
read are generated from the policy (`operativeSql`), and migration 197's
24 triggers are generated from the same entries (`MIGRATION_197.md`). The
coverage gate reads the live catalog both ways and is in `verify_all.sh`;
it found one unclassified reference on first run (`agent_runs.selected_unit_id`,
classified interest-only) — which is the point of it.

Proven: ORDER A for an application writer and for a work-order writer
(the writer commits first → the retirement waits on the row lock, then
refuses); ORDER B for both (the retirement commits first → the
work-order door refuses **409 `retired_inventory`** naming the unit, no
work order and no obligation attached; the internal-application door
refuses 409 too — its own offerability guard answered first, and which
guard answered is recorded, not assumed). The wall by cause class,
directly: new child position refused (`new attachment`), reopen of a
declined application refused (`reopen`), re-target of an open application
refused (`re-target`); audit rows on retired inventory still write; the
180 any-lease wall still stands. A legacy-shaped conflict (an application
attached before the wall — the ONE labelled fixture written after a
business action, with the triggers held off for that statement) is named
in the staff history and in the standing read as `H-L05 · application × 1`,
its own review reports it, withdrawing it is allowed, and after that the
conflict is gone from the reads without any repair.

### 2. Concurrency and authority

Lock order is fixed and identical for retire and reinstate: units `FOR
UPDATE` → their spaces `FOR UPDATE` → the actor's assignment `FOR SHARE` →
the actor's user row `FOR SHARE`. Authority is read after the wait.
Proven with two real sessions: correction blocked on an external unit
lock → admin2 revokes the override through `PATCH
/property-team-assignments/:id` → lock released → **403
`authority_changed`, nothing written**; the same with the actor suspended
through `PATCH /org/users/:id` → **403 `actor_disabled`, nothing written.**
A mixed selection is refused whole with no retirement row and no
receipt. The `FOR SHARE` itself is asserted at source (contract test);
what the runtime proof shows is the ordering.

### 3. Reinstatement is an identity decision

`identityFacts` reads durable label evidence, never label shape: promoted
claims under the current established representation whose key or source
values name the label but produced a different unit/position; rows of
the cited superseding source that name the label and produced a
different record; a current position carrying the label. Status
`covered` → `409 identity_covered` with the covering records, and an
explicit correction cannot override it; `unresolved` (a superseding
source was cited and says nothing either way) → `409 identity_unresolved`
until the reinstatement carries
`identity_decision: position_not_covered_by_current_representation` and a
reason ≥ 20 characters, which is recorded on the reversal event and the
command receipt; `clear` (own claim by the current representation, or no
source cited) → proceeds. The token covers the identity read, and it is
recomputed inside the transaction.

Both Deal Setup shapes through the real door: deal → property → CSV with
one occupied and one vacant row → activation → read-source (bed basis) →
confirm both → establish. Both proposals wrote `status='promoted'`, each
with a produced unit and position; the occupied one produced a lease;
both parents review as `claimed_by_current_representation`; the legacy
record `H-P1-A`, whose position the source relabelled under `H-P1`, is
retirable and then **covered**; `H-P3-A` retired citing that source is
**unresolved**; `H-L01` retired without a citation is **clear**.
Reinstating establishes nothing: the returned position reads with its
own unestablished state, never `marketable_now`.

### 4. Command identity

`inventory_correction_commands`: same key + same canonical payload →
**200, `idempotent: true`, the recorded result, `replayed_from`, and a
separate `current_state`**; same key + changed payload → `409
command_payload_conflict`; a different key for already-retired units →
`ALREADY_RETIRED` (a new command, refused by name); the same key string
under `reinstate` is an independent identity (two receipts under one
key); a lost response after the reinstatement commit replays instead of
`NOT_RETIRED`/`stale_review`; two identical concurrent submissions →
one 201 and one 200, one retirement row, one receipt; a refused command
leaves no receipt; a replay by an actor whose override was removed, or
by Mike, is 403. Retry identity is resolved after authority and before
the stale-review and already-retired checks (asserted at source too).
The app derives the key from the reviewed record and the exact
submission, keeps what was typed when a request is lost, and the browser
proof shows the retry carrying the same key and payload.

### 5. Readers, Ask Spine, app

Exact contracts after the corrections (n retired records, s retired
positions): `occupancyByBasis.rentable_count` down by exactly s, occupied
unchanged; `availabilityRead.count` down by s and no retired unit in
`rows`; the Rent Roll unit view `totals.units` down by n,
`retired_excluded = {units: n, leases_on_retired_inventory: 0, conflict:
false}`; tenancy standing `position.units` down by n and
`unknowns.unit_records_retired_from_current_inventory = n`. The unrelated
property with no opening position: its explanation names its own one
excluded record and its missing citation; `unknowns` stays null or carries
the exact count.

`readTenancyStanding` now carries `inventory_correction` — the SAME
object the staff history returns as `explanation` (byte-identical in the
proof): excluded records by label with reason, reason meaning, rationale,
date, cited source and decider; reinstated count; operative work attached
to retired inventory by label and kind; provenance; what it does not
establish. Labels only, so `withoutDatabaseIds` changes nothing. Proven
through `gatherFacts` (management-entitled: present; maintenance-only:
absent) and `answer()` with a deterministic wording stub that builds the
sentence from the facts the server handed over — the model payload
carried the labels and no id; no paid model call.

App (`0d035c8`): after a decision the Rent Roll table and counts, the
records list, the open review and the history are reread together
(browser: one unit and one position fewer after retirement, back after
reinstatement, history reread while open); reads carry a generation and
per-kind sequence and a late review response is dropped (browser: the
first click's delayed response did not overwrite the newer selection);
the list is server-paged with whole-property totals (browser: 1–100 of
171, then 101–171); history paged with the explanation rendered.

## Corrections to the original receipt

- "*In the other order, the owner's 180 trigger refuses*" — true for
  leases only. Every other operative writer could attach to retired
  inventory; now 24 tables refuse.
- "*Authority re-verified inside the transaction*" — it was read before
  the inventory locks and never rechecked; the race QB described wrote a
  retirement on the candidate. Now read after the locks with row share
  locks, and actor disablement refuses.
- "*Reinstatement revalidates … the label among current units*" — that
  check could not fire; there was no identity read, and reinstating over
  a covering record double-counted. Now an identity decision.
- "*A repeat submission (same key, same body) is refused by name*" — now
  a replay of the recorded result; refusal by name is for a new command.
- "*Ask Spine: the standing projection carries the exclusion*" — only two
  counts. Now the bounded explanation, proven through the real gather and
  answer path with a stub, not only through the door's `read_state`.
- Relationship semantics: `current_offers` now means any offer not
  expired/superseded/cancelled (not only application proposals in
  draft/sent); lease packets, economic schedules, obligations, required
  work, readiness certifications, procurement, money and configured
  services block too. The `relationships` object is keyed by policy code.

## Recorded, not changed

- Other writer doors that meet the wall still answer 500 with the
  trigger's sentence; only the internal-application and work-order doors
  are mapped to 409 (the two proven through). Same class, out of this
  lane's blast radius.
- `tour_availability`'s trigger refuses any non-cancelled slot on a
  retired unit; the review counts only future ones (stricter wall than
  read, by design). A unit with an `actioned` unit event stays blocked
  from retirement, as delivered.
- Calls without an `idempotency_key` have no durable identity
  (`command_identity: "none"`); the app always sends one.
- Authority remains management + the existing governed override, coarse;
  no permission change for Mike, no new role system.
- Migration 197 is applied only to owned proof databases; no production
  migration is authorised; 196 untouched.

## Evidence and cleanup

`hardening.witness.json` (5be5c1c), `hardening.successor.json`,
`evidence.successor.hardened.json`, `browser.receipt.hardened.json`,
`gate.successor.txt` — scrubbed of identifiers; the original three
evidence files kept. Screenshots inspected, kept out of the repository.
Owned databases for runs 25–28 dropped with `proof_boundary.js cleanup`;
the baseline worktree removed. CI: see the line appended below after the
run completes.
