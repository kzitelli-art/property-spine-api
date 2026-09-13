# Governed inventory correction in the staff app — receipt (2026-09-13)

Returned to HP QB. Base: API `7cb245ead0ad02e35e29b7adebde05b2c10d1e25` and
app `e8fe8e9c9db9df7edcf50b935cd1fb81e173eed1`, both fetched from
`codex/hp-two-step-review-20260913` and verified as the exact starting
commits (no different starting point, no local dirty files, no newer
commits folded in). Isolated worktrees `api-fable-review-20260907` and
`app-fable-review-20260907`, branch `claude/inventory-correction-20260913`
in both repositories. Owned nonce-verified databases from the real
migration chain (ceiling 195; **no new migration**), owned servers, fake
transports. No production read or write, no provider action, no
deployment, no merge, rebase, reset or force push. Every fixture write
precedes the first business action; no SQL after a business action
manufactures an outcome. No retirement-door work existed before this
assignment; nothing to continue.

## Answer

**An authorized staff member can now, in the existing Rent Roll page,
open "Inventory records", review one unit record (label, positions,
source and promotion lineage, current-representation claim, retirement
state and history, every relationship Spine holds), see why it is eligible
or blocked, retire it as an obsolete representation with a rationale and an
explicit confirmation, read the correction history, and reinstate it later
with a reason. The write is the existing owner
(`inventory_retirement.js`), the meaning of the one reason
(`superseded_by_corrected_inventory_grain`, never separate real inventory,
excluded at every as-of date) is unchanged, and every canonical reader that
already imported the retirement predicate agrees the moment the transaction
commits.**

What remains blocked, and why: a record with ANY lease (the owner's wall),
a scheduled or actioned unit event, an application that is not terminal,
a current application offer, a prepared or sent invitation, an executed
lease record, an open renewal, open work, an open turnover, a future tour
or published slot, or a confirmed source row of the CURRENT representation
(it is the corrected grain, not superseded by it). Reviewing tells the
person which; the decision is refused server-side too, for the whole
submission, with nothing written.

What Kameron or Mike must provide before using it on real Greenery
records: a physical-identity decision per record, made by a person and
written into the rationale. Eligibility here is a statement about
relationships Spine holds, not about whether a record is physically real.
The 107 unresolved legacy records are an investigation set; absence from a
workbook, matching a total, or adding a prefix does not establish physical
identity, and this tool does not infer it. Only Kameron's override at
Greenery can decide; Mike's `property_manager` assignment reviews and
cannot decide, and nothing here changes that.

## First red on the unchanged baseline

`INVENTORY_CORRECTION_WITNESS=1` on `7cb245e`: an authorized session's
list, review and retire requests all answer **404** — the owner is
reachable only from proofs; no staff route and no app control exist.
6 checks, exits red by design (`evidence.witness.json`).

## The door

| what | where | authority |
|---|---|---|
| list every unit record at the session's property with its correction state | `GET /operator/inventory/corrections` | session + management module |
| review one record (lineage, relationships, eligibility, `review_token`) | `GET /operator/inventory/corrections/review?unit_id=` | session + management module; custody from the unit's own `property_id` |
| history (the owner's `retirementProvenance`) | `GET /operator/inventory/corrections/history` | session + management module |
| retire one or more reviewed records | `POST /operator/inventory/corrections/retire` `{unit_ids, review_tokens, rationale, confirmed:true, superseded_by_import_batch_id?, idempotency_key?}` | session + management module + **governed override** (`can_manage_roles`, the same `requireGovernanceAuthority` the AI-rules governance routes use), re-verified inside the transaction |
| reinstate one retired record | `POST /operator/inventory/corrections/reinstate` `{unit_id, review_token, reason, confirmed:true}` | same |

Service: `src/tenancy/inventory_correction.js` (review read, transactional
apply and reversal). Owner unchanged: `src/tenancy/inventory_retirement.js`.
Readers touched: `tenancy_position_read.js` now carries
`unit_records_retired_from_current_inventory` and
`tenancy_attached_to_retired_inventory` in the standing projection Ask
Spine reads; `rent_roll_unit_view.js` now returns the loader's
`retired_excluded` so the screen can label current inventory and retained
records as two different counts. App: `index.html` — resources, two write
adapters, and the Inventory records panel on the Rent Roll page.

**Existing authority reused, and the ruling it leaves open.** The governed
override on the property assignment is the only existing authority that is
narrower than "leasing" and broader than "actor present". It fits: the
same people who may change roles may correct inventory. A dedicated
inventory-correction authority does not exist in the source; if QB wants
one narrower than the override, that is a product ruling, not something
this branch invents.

## Safety inside the transaction

- **Bound to the review.** `review_token` = hash of unit id and label,
  property, every space id/label/use/kind, live retirement id, history
  count, every relationship count, the current-representation claim and
  activation. Apply recomputes it after taking the locks; a mismatch is
  refused as `stale_review`. A repeat of an already-taken decision is named
  `ALREADY_RETIRED` (the owner's word), never re-written.
- **Authority re-verified** from the assignment row inside the transaction
  (`authority_changed` 403 when removed after the review was rendered).
- **Custody** from the unit's own row on every call; `not_permitted` 403
  for another property's unit, for both retire and reinstate.
- **Concurrent writers.** A unit-row lock excludes nothing that matters,
  so apply locks the unit's SPACES `FOR UPDATE`: a lease, application,
  offer or event insert holds KEY SHARE on the space and must wait.
  Proven: an uncommitted lease on the record's space made the retirement
  WAIT (checked after 1.2 s), and after that writer committed the decision
  was refused (`unit_carries_leases` / `stale_review`) with no row written.
  In the other order, the owner's 180 trigger refuses a lease on the
  retired record.
- **All or nothing.** Every selected record is re-loaded, re-tokened and
  re-assessed; one refusal refuses the submission before the owner writes.
- **Reinstatement** revalidates the token and the label among current
  units, keeps the retirement row and records who reversed it, when and
  why; its receipt says it restores participation only and establishes no
  opening position, use, availability or readiness.

## Proof

- HTTP successor (`tests/e2e/inventory_correction.e2e.js`), fresh owned
  database: **82 passed, 0 failed, 4 observations.** Greenery-shaped
  fixture (the retained legacy vocabulary read from
  `greenery_legacy_inventory.db.js`: 64 prefixed parents + 107 other
  records, one placeholder each, identities retained) plus an unrelated
  property with different labels (`Apt 2F`, `Suite 300`, `PH-1`). Retained
  source vocabulary: the unit labels. Synthetic: identities, authority,
  the older bed-as-unit batch, the current bed-basis batch and its
  established opening position, the expired lease, open work order,
  submitted application, scheduled move-in, tour slots, rents and dates.
  Designated examples (fixture choices, not findings): `101 - 1`,
  `101 - 2`, `109 - 2`, `111 - 1` as retirable; five blocked examples; one
  parent claimed by the current representation; 100+ records left
  unresolved and untouched.
  Covered: authorized success (two records in one decision, owner rows
  name the admin, reason and cited superseding batch, identity retained);
  Mike 403; leasing-only 403 (cannot even read); foreign-property session
  403 for review, retire and reinstate; foreign superseding batch 409;
  unsupported reason 400 from the owner's vocabulary; short rationale 409;
  unconfirmed 400; mixed selection with no partial write; the any-lease
  refusal; every relationship blocker; the current-representation claim;
  stale review after a real business action (a slot published through the
  real door) and a tampered token; concurrent writer; repeat submission;
  removed assignment (deactivated through the governed door) refused, then
  restored; reinstatement with preserved history, stale token, not-retired;
  reads: Rent Roll unit view excludes and reports the exclusion, the list
  labels 171 retained / 169 current / 2 retired, tenancy standing carries
  the exclusion, the unrelated property is untouched.
- Browser (`tests/e2e/inventory_correction.browser.js`, real Chromium,
  the actual shell at app `HEAD` of this branch): **17 checks.** Mike sees
  the verdict and blockers, is offered no decision and is told why; the
  admin's unconfirmed click sends nothing; one confirmed retirement
  carries the review token; the dialog names the record and consequence;
  counts reread; blocked record offers no decision; history visible;
  reinstatement recorded with who and why. Visibility asked of the
  document after scrolling into view.
- Source contract (`tests/unit/inventory_correction_contract.test.js`):
  the owner writes, no second writer, no delete/relabel/reparent, live
  authority = override + management module, token covers relationships,
  spaces locked, all-or-nothing, route gating, standing keys.
- Registered in `verify_all.sh` after the two-step proof (browser step by
  name, skipped without Chromium and an app checkout).
- Existing suites on this tree, owned database: opening claim identity
  17/0, opening claim unattached 14/0, import retirement resolution pass,
  Ask Spine reader gate, source governance, application review action
  contract 14/14. App suite on the patched shell: **68 harnesses, 2,291
  assertions, 0 failed.** Three database proofs
  (`inventory_retirement.db.js` 44/45, `ledger_grain_reconciliation.db.js`,
  `leasing_occupancy_retirement.db.js`) fail **identically on the unchanged
  baseline** in this container (a source-scan assertion, the real July
  workbook artifact, a fixture prerequisite); CI runs them under its own
  setup and is the authority for them.
- Ask Spine: the standing projection it reads carries the exclusion
  (asserted directly and through the door's `read_state`); the harness's
  model sentinel refuses the wording step, so the sentence itself is not
  produced here.

## Repeatable staff steps

1. Management → Rent Roll → **Inventory records** (counts: current
   inventory · retired · retained records).
2. **Review** a record. Read its positions, lineage, current-representation
   claim, relationships and the verdict.
3. If eligible and you hold the override: write why it never was separate
   real inventory (≥ 20 characters), tick the confirmation, **Retire from
   current inventory**, confirm the dialog. The list and counts reread.
4. **History** lists every retirement and reversal.
5. To put a record back: Review → reason → confirm → **Reinstate to
   current inventory**. The original decision stays as history.

## Remaining business decisions

- Whether a narrower inventory-correction authority than the governed
  override should exist.
- The physical-identity decision for each real Greenery record, and who
  records it (this tool records the decision; it does not make it).
- Whether a cited superseding source should be required rather than
  optional on the retire decision.
- Date-sensitive reasons (demolition, conversion) stay outside this
  reason's scope and outside this tool until the loader's exclusion is
  date-aware (the owner's existing wall).

## Evidence and cleanup

`evidence.witness.json` (baseline), `evidence.successor.json`,
`browser.receipt.json` — scrubbed of identifiers. Screenshots inspected,
kept out of the repository. Owned databases for runs 20–23 dropped with
`proof_boundary.js cleanup`; the baseline worktree removed.

## CI

- Run 495 on `0c70179` (first push): **failed** one existing proof,
  `opening_claim_relay_edges.db.js` — carrying the retirement exclusion had
  turned the no-baseline branch's `unknowns` from `null` into a bag of
  zeroes. Fixed in `5be5c1c`: no baseline remains an unknown; the exclusion
  rides only with a completed retained-claims read.
- Run 496 on `5be5c1c` (the exact final API source commit): **success** —
  full `verify_all.sh`, the inventory-correction proof included.
  https://github.com/kzitelli-art/property-spine-api/actions/runs/34757746671
- App commit `0450247` on `claude/inventory-correction-20260913`; validated
  by the sanctioned app suite (68 harnesses, 2,291 assertions, 0 failures)
  and the Chromium slice above. The browser slice is reported as skipped by
  name in CI (no operator-app checkout there).
