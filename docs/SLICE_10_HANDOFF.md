# Slice 10 — Forward Rent Roll Authority. Thread Handoff.

> ## SUPERSEDED IN PART — 2026-08-03, later the same day.
>
> **§1 and §5 are stale.** They say 10E is OPEN and its browser acceptance has
> not started. It has been run: **95 assertions, 0 failed**, desktop and 390px,
> against real Postgres, real HTTP and canonical staff sessions on synthetic
> data. Slice 10 is **BROWSER VERIFIED — not merged, not deployed, not
> production accepted.**
>
> **They are kept as written, not rewritten**, because §5's claim that *"the
> renderer is done… the browser proof that has not been run"* turned out to be
> the load-bearing error of this lane, and deleting it would delete the
> evidence for why §33 exists. Six real defects sat in that gap, two of which
> made pagination inoperative.
>
> Current state, contracts, measurements and remaining blockers:
> **[`SLICE_10_RECEIPT.md`](SLICE_10_RECEIPT.md)** and
> **[`SLICE_10_RELEASE_READINESS.md`](SLICE_10_RELEASE_READINESS.md)** on
> `claude/slice-10e-browser-acceptance-t0zk33`.
>
> Everything else in this file — §2's branch map (as corrected below), §3's
> frozen contracts, §4's server proof totals, §6's traps, §7's blockers — was
> re-verified on 2026-08-03 and stands.

**Written 2026-08-03. API `main` @ `47ed0f0`. App `main` @ `357fb15`.**

Read this alongside [`THREAD_HANDOFF.md`](THREAD_HANDOFF.md), not instead of it.
That file is the **SMS / work-order lane**. This file is the **leasing /
forward-rent-roll lane**. Both were live in parallel on 2026-08-03. Where they
describe different things they are both correct; §9 below records the one place
`THREAD_HANDOFF.md` has gone stale.

Everything here was re-verified against the repository and against executed runs
on the day it was written. Nothing in it is remembered.

---

## 1. Where Slice 10 stands

| | Slice | State | Rung (§33) |
|---|---|---|---|
| **10A** | Forward Rent Roll authority audit (+ Pass 2) | **Complete** | Document |
| **10B** | Canonical dated position rows | **Accepted, frozen** | Proven (real Postgres) |
| **10C** | Summary authority | **Accepted, frozen** | Proven (real Postgres) |
| **10D** | Scale, pagination, transport | **Accepted, frozen** | Proven (real Postgres + real HTTP) |
| **10E** | Renderer and browser acceptance | **OPEN** | Renderer proven at harness level. **Browser acceptance not started.** |
| **10F** | Reactivation | Not started; blocked — see §7 | — |

**The single sentence that matters:** *10E remains open — renderer complete and
green, browser acceptance outstanding.* Do not describe Slice 10 as done, live,
or deployed. Per §33, for an operator workflow browser verification **is** part
of done, and it has not happened.

---

## 2. Branch and commit map

Nothing from Slice 10 is on either `main`. All of it is on branches.

### `property-spine-api`

| Branch | Head | Contents |
|---|---|---|
| `claude/slice-10b-dated-position-rows` | `d1279de` | **10B + 10C + 10D — the whole server side.** Frozen. |
| `claude/slice-10a-forward-rent-roll-audit` | `3ee398b` | `docs/SLICE_10_SOURCE_AUDIT.md` — the audit and its Pass 2 corrections. |
| `claude/slice-10-handoff` | this commit | This document and the queued audit brief. |
| `claude/slice-9-demand-evidence-mcxvav` | `c726e3e` | **PR #35**, open: the Slice 9 production receipt. Receipt only — deliberately not carrying the audit. |
| `hotfix/future-rent-roll-route-guards` | `47fa1a7` | **Merged** as `47ed0f0` (PR #36). Leasing entitlement + strict `as_of` validation. |

The 10B branch name is now a misnomer: it carries 10B, 10C and 10D. It was kept
as one branch because 10C and 10D are pure consumers of 10B's frozen row shape
and splitting them would have produced three PRs that only merge in order.

`d1279de` touches eleven files:

```
src/tenancy/dated_position_rows.js         553   the row engine
src/tenancy/forward_rent_roll_summary.js   246   aggregation only, no re-derivation
src/tenancy/forward_rent_roll_page.js      237   bounded signed transport
src/identity/operator.js                  +103   the route
tests/slice10b_dated_position_rows_proof.js       489
tests/slice10c_summary_authority_proof.js         231
tests/slice10d_scale_transport_proof.js           249
tests/hotfix_future_rent_roll_guards_proof.js    +109
tests/fixtures/slice10d_scale_fixture.js          193
tests/slice10d_build_fixture.js                    21
.gitignore                                         +3
```

### `property-spine-app`

| Branch | Head | Contents |
|---|---|---|
| `claude/slice-10e-future-rent-roll-renderer` | `ab856b7` | The Future Rent Roll renderer, `docs/SLICE_10E_STATE.md` **and** `docs/INCIDENT_STATIC_DATA_EXPOSURE.md`. |
| `security/incident-receipt-static-exposure` | `261247f` | The incident receipt alone. |
| **`claude/slice-10e-browser-acceptance-t0zk33`** | **`0f3e17c`** | **The accepted app head.** Browser acceptance, the six renderer repairs it found, and the allowlisted publish artifact. |

> **Two SHAs on this branch line, and they are not interchangeable.**
> `a365381` was written here as the renderer branch head; the head was
> **`ab856b7`**, one commit further on, which added `docs/SLICE_10E_STATE.md`.
> Corrected 2026-08-03.
>
> `ab856b7` is the **historical 10E renderer state** — complete at harness
> level, never through a browser.
> `0f3e17c` is the **present accepted app head** — browser verified, 95/0.
> Do not read either as the other. §5 below describes `ab856b7`; it is kept as
> written and marked, because it is the record of what was believed before the
> browser was involved.

**Know this before you branch from it:** `claude/slice-10e-…` was cut from
`261247f`, so it carries the incident receipt as well as the renderer. It is not
a single-purpose branch. If 10E is ever PR'd separately from the incident
receipt, rebase it onto `main` first — the receipt commit is already reachable on
its own branch and does not need to travel twice.

---

## 3. The frozen contracts

These are the reusable server contracts the future governed staff agent will
speak through. They were designed to be consumed by a tool, not by one screen —
typed identity, typed lineage, typed evidence state, typed blockers, exact
references to *existing* actions, canonical destinations, and honest result
states. **They are frozen. Add fields; do not repurpose one.**

| Contract | Version string | Where |
|---|---|---|
| Row | `forward_rent_roll_rows_v1` | `src/tenancy/dated_position_rows.js` (`dated_position_rows_v1` internally) |
| Summary | `forward_rent_roll_summary_v1` | `src/tenancy/forward_rent_roll_summary.js` |
| Cursor | `frr_cur_v1` | `src/tenancy/forward_rent_roll_page.js` |

### The grain, and why

**One row per `spaces.id`.** One leaseable position, one row. `leases.space_id`,
`executed_lease_records.space_id` and `lease_economic_schedules.space_id` are all
`NOT NULL`, so the space is the only grain at which every economic fact is
addressable.

`spaces` has **no `property_id`**. Lineage is `space → unit → property`. Every
property-scoped query must go through `units`. There is no shortcut and adding
one would create a second, divergent definition of which property a space belongs
to (§17).

### Denominator authority

`spaces.use_type` (migration 100), CHECK-constrained to `residential |
commercial | non_revenue | other`, carrying `classification_source`,
`classified_by_user_id`, `classified_at`.

```
residential, commercial   → revenue
non_revenue               → non_revenue
other, null, unclassified → unknown        ← never silently counted either way
```

`unknown` is not a rounding error to be absorbed into a denominator. It is the
§5 honest blank, and the summary refuses to publish an occupancy rate while any
of it is outstanding.

### Economics precedence

```
dated lease_economic_lines   (monthly effective_month; base_rent, recurring_fee,
                              one_time_fee, concession_credit, fee_waiver)
      ↓ falls back only when absent, and says so
leases.rent                  (undated legacy — QUALIFIED, never silently equal)
      ↓
units.market_rent            NEVER. It is an asking price, not a contract.
```

`rent_authority` is one of `dated_economic_line | legacy_lease_rent | missing |
conflict`. A consumer that treats `legacy_lease_rent` as equivalent to
`dated_economic_line` has thrown away the distinction the field exists to carry.

### Obligation lineage — read this before you write a join

```sql
obligations.related_id  where related_type = 'lease'   →  leases.id  →  leases.space_id
```

**There is no `obligations.lease_id`.** An earlier version of the 10A audit said
there was; the grep hits belonged to `lease_economic_schedules` and `unit_events`.
`obligations.unit_id` does exist, is unit-grain, and is deliberately unused here —
joining through it would silently collapse multiple spaces in a unit into one
position.

### The typed vocabularies

```js
EVIDENCE_STATE  contractually_supported | qualified_legacy | incomplete
                | conflicting | untrackable | unavailable
RESULT_STATE    qualifying_result_exists | no_qualifying_result
                | unavailable | authority_missing
```

`no_qualifying_result` and `unavailable` are **different facts** and the
distinction is the whole point: *"we looked and there is nothing"* is not
*"we could not look."* Any consumer that renders them the same has reintroduced
confident-wrong.

### Action strings, classified

Five inherited action strings were classified (§18). Four were removed:

| String | Classification | Fate |
|---|---|---|
| `economic_tenancy_activation_required` | `noncanonical_recommendation` | removed |
| `possession_outstanding` | `noncanonical_recommendation` | removed |
| `turn_before_committed_start` | `noncanonical_recommendation` | removed |
| `review_early_possession` | `unsupported_instruction` | removed |
| `possession_without_current_lease` | `plain_explanation` | **retained** |

A surface may explain a fact. It may not invent an instruction the system has no
authority to issue. `existing_action` therefore references only obligations that
**already exist**, with `GOVERNED_DESTINATIONS` naming where an operator goes to
act on one. The row engine never proposes work.

### Transport

`PAGE_DEFAULT = 50`, `PAGE_MAX = 200` (clamped **with disclosure**, never
silently). Ordering `unit_number asc, space_id asc`.

The cursor is a stateless HMAC — base64url payload plus a 32-char signature —
bound to property, `as_of`, ordering and **both** contract versions. Typed
refusals, never a silent page one:

```
cursor_malformed  cursor_signature_invalid  cursor_version_mismatch
cursor_contract_mismatch  cursor_ordering_mismatch
cursor_property_mismatch  cursor_date_mismatch
```

**`unit_number` is mutable.** The cursor is therefore *best-effort live*, not a
snapshot, and the response says so in `page.concurrent_change_limitation`. An
earlier draft of this claimed snapshot consistency; it was wrong and the
correction is load-bearing — a caller that believes it has a snapshot will
mis-reconcile a rename mid-traversal.

**Signing secret.** `CURSOR_SECRET` from the environment when present; otherwise
an ephemeral per-process key, reported as `SECRET_SOURCE = ephemeral_process_key`.
In production with no `CURSOR_SECRET` the route refuses:
`{ error: "cursor_secret_not_configured" }`. It does not quietly mint cursors
that die on the next deploy.

**`as_of` defaults to the property's local today**, derived from the property's
operating timezone via `Intl.DateTimeFormat`. When no operating timezone is
recorded the route refuses rather than borrowing the server's clock — owner
ruling, and it is §21: the server decides, but it decides from the *property's*
recorded facts, not from where the container happens to run.

`complete_stats` is computed **before** slicing, so `totals` and `coverage`
describe the whole property on every page. A page-one summary can legitimately
withhold because of a blocker ~9,900 rows away; that is proven, not incidental.

---

## 4. What is proven, and at which rung

Re-run on 2026-08-03 against real Postgres, immediately before this document was
written. These are today's numbers, not transcribed ones.

| Harness | Result |
|---|---|
| `tests/slice10b_dated_position_rows_proof.js` | **90 passed, 0 failed** |
| `tests/slice10c_summary_authority_proof.js` | **36 passed, 0 failed** |
| `tests/slice10d_scale_transport_proof.js` | **58 passed, 0 failed** |
| `tests/hotfix_future_rent_roll_guards_proof.js` | **62 passed, 0 failed** |
| app `run_harnesses.sh` | **18 harnesses · 779 passed · 0 failed** |

Scale, measured rather than asserted:

```
response, unbounded          15,284 KB
response, default page (50)      95 KB
summary, unbounded              306 KB
summary, bounded                 18 KB
query count                18, flat at 10,000 and at 100,000 positions
full traversal        at limit 25 and at limit 200 — all 10,000 positions
                      returned exactly once, identical ordering both times
```

`CHANGE_SAMPLE = 25`: every change collection returns
`{count, sample, has_more, sample_note}`. **The count is always complete.** Only
the list is a sample, and the payload says which is which.

**Rung, stated honestly.** 10B/10C/10D are **Proven** — real Postgres, and for
the route, real HTTP through the operator guard. They are **not Browser
verified**. 10E's renderer is exercised by the app harness suite; that is
harness-level, not browser-level. Nothing in Slice 10 has been through a browser.

---

## 5. What is open — 10E browser acceptance

The renderer is done. `psLiveFutureRentRoll()` in `index.html` consumes
`summary` / `coverage` / `positions` / `page`. `_psFrrAnchor` holds **the
server's `as_of`** and horizons are computed from it by `psFrrHorizons()` — the
browser's clock is never an input. Five operator facts lost in the contract
migration were restored **from the new contract**, not by weakening assertions:

```
positions contractually locked
successor pending but not contractually locked
covered but unproven
open or uncovered
with overlapping lease claims
verified in Spine / confirmed opening truth
Contractual facts only.
```

All sourced from `d.totals`, which is whole-property, not page-scoped.

### The browser proof that has not been run

Start here. It is the entire remaining scope of 10E.

**Harness setup** — the Slice 9 recipe works and is known-good:

```
Chromium   /opt/pw-browsers/chromium-1194/chrome-linux/chrome
flags      --host-resolver-rules=MAP property-spine-api.onrender.com 127.0.0.1:443
           --ignore-certificate-errors --no-proxy-server
TLS front  :443
app        :8081
API        must start with OPERATOR_APP_ORIGIN=http://127.0.0.1:8081
           — operator CORS is fail-closed and will silently deny otherwise
```

**Data:** seeded **synthetic** disposable Postgres. No production resident data
in any screenshot or test artifact — this is not a preference, it is the standing
constraint from the security incident.

**Assertions required:**

1. Desktop **and** 390px. No horizontal dead end. No clipped primary action.
2. No console error. No hidden failed request.
3. Ten contract states rendered.
4. Seventeen position states rendered.
5. Pagination: default bounded; next page loads; **no duplication**; summary
   unchanged across pages; a late-page blocker correctly suppresses page one's
   rate; a malformed cursor fails honestly and visibly.
6. The browser never downloads all 10,000 rows.
7. At 390px the hierarchy holds: space → target position → rent or withheld →
   conflict or blocker → the exact existing action.

---

## 6. Traps this lane found

**`CURSOR_SECRET` must be exported to re-run the transport proofs.** Without it,
`slice10d_scale_transport_proof.js` and `hotfix_future_rent_roll_guards_proof.js`
each report **one honest failure** — the contract-version case refuses to claim a
result it cannot prove, and the cross-property cursor case fails because the
minting process and the server child generate *different* ephemeral keys. Both
are the harness policing its own claim (§5), not regressions. Export any value
and both go green. A future session re-running these cold will otherwise spend an
hour chasing a defect that is not there.

**Four vacuous assertions, all mine, all found by re-reading rather than by red.**
Recorded because the shape recurs:

1. A credential scan reported "clean" against a working tree where the files had
   already been deleted. It matched nothing and called that safety. Fixed by
   scanning the `git show <sha>:<file>` blobs, with presence confirmed first.
2. A contract-version cursor test string-replaced `forward_rent_roll_rows_v1`
   *inside a base64url payload* — a no-op. The cursor stayed valid and the test
   passed. Fixed by forging the payload and signing it properly.
3. `position_state` was **null on every non-conflicted row**, and 89 assertions
   never noticed because only the conflict case checked it. Fixed by reusing
   `futureState()`; a direct regression guard now runs first, as assertion A0.
4. A page-bound check `c.length <= 100` passed against an empty array, because it
   read `supporting_rows.rows` when the key is `page`.

All four *read* as proof. **§5 applies to your own harness before it applies to
the product**, and "it passed" is not evidence that it asserted anything.

**A grep match is discovery evidence, not a conclusion.** Standing rule, issued
by the owner after I claimed `obligations.lease_id` existed and, separately,
claimed a sequential-scan blocker without testing whether the planner adapts (it
does — index path, 0.061 ms when selective). Every schema-lineage conclusion must
now name all three:

> **table-qualified column · the writer · an existing reader or consumer**

**Two more, briefly.** A TDZ error — `cov` referenced `cs` before declaration —
500'd every request. And a broad force-push on a shared PR branch dropped the
commit PR #35 was built on; recovered by cherry-pick. Standing owner ruling:
**no broad force-pushes on a shared PR branch.**

---

## 7. Blockers this lane does not own

Do not "fix" these here. Each belongs to another lane or to a human.

**Migration 129 is on `main` and unapplied → `main` cannot boot.** A deploy
verifies the ledger bidirectionally and refuses to start when a file is not in
the ledger. Owned by the SMS lane. Releasing is deliberate:

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what you just read> \
  node migrations/migrate.js --apply
```

**Security containment, owner/manual.** The app was suspended and nine
unreferenced datasets removed (PRs #31 `48f5383`, #32 `357fb15`). Still
outstanding, all requiring a human: verify the Render suspension in a private
window; set **both** repositories private; check for forks; execute the prepared
git-history remediation. The incident record is
`docs/INCIDENT_STATIC_DATA_EXPOSURE.md` on the app repo — categories and counts
only, no resident data, and it must stay that way.

**The 10F reactivation blocker.** The Future Rent Roll renderer itself is clean —
it reads live server contracts and nothing else. But `index.html` still loads
`property-spine-data.js` and `policy.js` globally, at lines 4501 and 4503, for
*other* surfaces. Until those two are resolved, reactivating the app republishes
loaded real-data libraries. **This is what blocks 10F.** It is not a 10E defect
and 10E should not be held for it.

**`docs/SLICE_10_SOURCE_AUDIT.md` is not on `main`.** It is on
`claude/slice-10a-forward-rent-roll-audit` @ `3ee398b`. It is the source of
truth for every schema claim summarised in §3 and it should be merged before the
next thread relies on this file's summary of it.

---

## 8. Queued after Slice 10

[`AGENT_READINESS_AUDIT_BRIEF.md`](AGENT_READINESS_AUDIT_BRIEF.md) — the
**Conversational Staff Agent Readiness Audit, Slices 1–9**. Owner-authored,
preserved verbatim, and it is added here as its own document precisely so it is
not paraphrased into a summary.

**Do not begin it until Slice 10 is complete and its receipt is written.** Its
own terms: it performs **no writes anywhere**, it never writes to Solo
`9e2bb96e-08e2-41db-81c2-91055ceb50a3`, it produces **no code**, and it ends in a
document and a matrix.

The frozen contracts in §3 are the first input it will consume. They were shaped
for it on purpose — but shaping a contract for a future agent is not the same as
having audited whether the system is ready for one, and this build has done only
the first.

---

## 9. Where `THREAD_HANDOFF.md` has gone stale

Read as a whole it is still accurate and still the right first read. One
correction and one gap:

**Correction.** It states `main` is at `a08c1da`. `main` is at **`47ed0f0`** —
PR #36 merged the leasing-entitlement and strict-`as_of` hotfix. That merge added
**no migrations**, so every ledger statement in its §2 remains true exactly as
written:

```
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125
repository migration ceiling:  129   (claimed, unreleased — main cannot boot)
next free number:              130
```

**Gap.** It describes only the SMS / work-order lane and has no account of Slice
9, Slice 10, the app repository, or the security incident. That is not an error —
it was written by and for that lane. It is the reason this file exists, and the
reason `THREAD_HANDOFF.md` now carries a pointer to it at the top.
