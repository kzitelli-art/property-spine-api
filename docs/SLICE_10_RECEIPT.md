# Slice 10 — Forward Rent Roll Authority. Receipt.

**Written 2026-08-03. Corrected and re-proven the same day.**

```
API   claude/slice-10e-browser-acceptance-t0zk33   contracts at d1279de,
      fast-forwarded from claude/slice-10b-dated-position-rows, then MERGED
      with origin/main @ 4983e5d (PRs #33 and #35 — documentation only, no
      migrations, no source). origin/main is an ancestor. No force-push, no
      rewrite, no rebase of a pushed branch.
APP   claude/slice-10e-browser-acceptance-t0zk33   the ACCEPTED app head.
      Distinct from ab856b7, the historical 10E renderer state, which was
      harness green and had never been through a browser.
```

Every number in this file was produced by a run on the day it was written.
Nothing is transcribed from a prior handoff.

The exact final SHAs, the branch state, the PRs and the remaining deployment
gates are in **[`SLICE_10_RELEASE_READINESS.md`](SLICE_10_RELEASE_READINESS.md)**,
which is the release document. This file is the slice receipt.

---

## 1. The one sentence

**Slice 10 is complete through browser verification.** 10A audit, 10B rows, 10C
summary, 10D transport and 10E renderer are proven against real Postgres, real
HTTP and a real browser at desktop and 390px. 10F reactivation remains blocked
and is not this slice's to unblock.

**It is not deployed.** Nothing from Slice 10 is on either `main`, and `main`
cannot boot until migration 129 is released (SMS lane, §8). Proven and browser
verified is the rung. Live is not.

---

## 2. Proof, at its rung

| Component | Harness | Result | §33 rung |
|---|---|---|---|
| 10B canonical dated position rows | `tests/slice10b_dated_position_rows_proof.js` | **90 passed, 0 failed** | Proven |
| 10C complete-property summary | `tests/slice10c_summary_authority_proof.js` | **36 passed, 0 failed** | Proven |
| 10D scale and bounded transport | `tests/slice10d_scale_transport_proof.js` | **58 passed, 0 failed** | Proven |
| route guards + strict `as_of` | `tests/hotfix_future_rent_roll_guards_proof.js` | **62 passed, 0 failed** | Proven |
| app harness suite | `run_harnesses.sh` | **18 harnesses · 779 passed · 0 failed** | Locally exercised |
| **10E Future Rent Roll surface** | `slice10e_future_rent_roll_browser_proof.browser.js` | **96 passed, 0 failed** | **Browser verified** |
| publish-boundary artifact | `slice10e_publish_dir.js` | allowlist built · **19 globals measured, 19 stubbed, 0 divergent** | Proven |

The four server numbers reproduce the 2026-08-03 baseline exactly — `90 / 36 /
58 / 62` — from a database built from scratch in this environment, which is
the point: they are not the same run reported twice.

Artifacts: `property-spine-app/docs/slice10e-browser/` — seven screenshots and
the full acceptance log. Synthetic data only; no production resident data
appears in any of them, and the log carries no UUID and no person name.

---

## 3. What the browser acceptance actually asserted

The owner's seven requirements, and where each is discharged.

| # | Requirement | Where |
|---|---|---|
| 1 | Desktop **and** 390px · no horizontal dead end · no clipped primary action | A0a, A2b, G0a, H1b–H4 |
| 2 | No console error · no hidden failed request | A21–A24, B5, H7, and the boot-noise disclosure below |
| 3 | Ten contract states rendered | section C — reported as **7 of 7 currently reachable**, not 10 of 10. Three declared states are reserved and not producible. §4 |
| 4 | Seventeen position states rendered | section D — **17 of 17** |
| 5 | Pagination: bounded · next page loads · no duplication · summary unchanged · late blocker suppresses page one · malformed cursor fails honestly | E1–E16 |
| 6 | The browser never downloads all 10,000 rows | F1–F3 — **300 rows, 703 KB over 8 requests** |
| 7 | 390px hierarchy: space → position → rent or withheld → conflict or blocker → the exact existing action | H5, H6 |

**Ten and seventeen, resolved from the contract rather than guessed.**

```
TEN CONTRACT STATES   = EVIDENCE_STATE (6) + RESULT_STATE (4)
SEVENTEEN POSITION    = position_state 5 · denominator_class 3
STATES                  rent_authority 4 · resolution_state 3 · conflict_state 2
```

The first three vocabularies are `require()`d from
`src/tenancy/dated_position_rows.js` by the harness itself, so the acceptance
cannot drift from the contract it is checking. The four the contract does not
export are pinned in the harness with their deciding source, and a guard
(A3.\*) fails if the server ever returns a value outside the pinned set — an
unpinned value fails loudly rather than passing unnoticed.

**Scope of read, stated rather than implied.** Five boot-time `403`s appear on
every signed-in page load: `readiness/queue`, `unit-triage/risk`,
`unit-triage/open-walks`, `turn-scope/exceptions`, `staff-agent/thread`. They
are *correct* fail-closed module refusals for an operator entitled to leasing
only, they belong to those doors, and they are printed by URL in the run log
before the harness's buffers are scoped to this surface. Nothing is suppressed;
it is attributed.

---

## 4. Three declared contract states cannot be produced

This is the finding the acceptance was most at risk of papering over, because
reporting "ten of ten" would have read better and been false.

```
EVIDENCE_STATE.UNTRACKABLE   declared · never returned by evidenceStateFor()
                             (src/tenancy/dated_position_rows.js:124-133)
EVIDENCE_STATE.UNAVAILABLE   declared · never returned by evidenceStateFor()
RESULT_STATE.UNAVAILABLE     declared · never returned by datedPositionRows()
```

`forward_rent_roll_summary.js` **consumes all three** — it filters on
`untrackable` and `unavailable` at lines 53–54 and 108–109, and raises typed
blockers for both. So the summary is written against a vocabulary the row
engine cannot emit. That is not a defect in the summary: an untrackable
position is a real category and the summary is right to be ready for it. It
means the engine has no producer yet.

Consequence, and this is the form the number is reported in (owner ruling,
2026-08-03):

```
10  declared in the shared vocabulary
 7  currently emitted by the Slice 10 row/result engine
 3  reserved — defensively consumed by the summary, not producible
```

The receipt therefore says **7 of 7 currently reachable evidence/result states
rendered** and **17 of 17 position states rendered**. It does not say 10 of 10,
because that would be true only of the declaration and false of the surface.
**No producer was manufactured and no fixture was faked** to make a declared
constant appear live; the defensive handling in `forward_rent_roll_summary.js`
is harmless and typed and stays exactly as it is. The renderer nonetheless carries
a distinct operator label for all six evidence states (C4), so a value that
becomes reachable renders as itself rather than as a blank — and a blank is
indistinguishable from "nothing is wrong", which is the failure this surface
exists to refuse.

**Not fixed here.** Giving `untrackable` a producer is a product decision about
when lineage counts as unresolvable, not a rendering choice.

---

## 5. Six real defects the browser found

All six were **restorations of meaning the server already carried**. None was
resolved by deleting an assertion, weakening one, replacing content with a
generic label, or moving a missing fact into browser logic.

**1 · Pagination did not work, in two independent ways.**
`LIVE_RESOURCES.futureRentRollFacts.path()` built its URL from `as_of` only.
The renderer sent a cursor; the manifest discarded it; the server answered with
**page one again**. Separately, the Load more button interpolated the cursor
through `JSON.stringify` into a **double-quoted `onclick` attribute**, so the
cursor's own quotes closed the attribute and the button carried no handler at
all. Both failures are silent — one re-serves rows already held, the other does
nothing — and neither is visible from source review of the renderer alone,
because each looks correct in its own file.

**2 · Four different rent facts printed one sentence.** `no contractual rent
stated` was shown for: no dated schedule and no lease amount; an undated amount
that cannot prove the selected month; two base rents effective in one month;
and a contested position. The contract types these as `missing`,
`legacy_lease_rent` beyond its provable period, `conflict` and a conflicted
position, and carries a distinct `rent_note` for each. The row now renders the
server's own sentence.

**3 · Typed row `blockers[]` never reached the screen.** The contract types
them with `code`, `affects` and `detail`; the renderer dropped the array.

**4 · A contested row named no conflicting claims.** It said `conflict` and
nothing else. It now states how many records overlap and that no governing
lease is selected — which is 10B's conflict-integrity rule made visible.

**5 · `denominator_class` was invisible per row.** The summary counted
non-revenue and unclassified positions; no row said which ones. A count the
operator cannot check is a number they are asked to trust.

**6 · A refusal lost its reason.** A malformed cursor, a refused date and a dead
connection all rendered "Future Rent Roll could not be read." The server types
seven distinct cursor refusals. A caller told only "could not read" retries
forever against a request that will never succeed.

Also restored, each from a field already on the wire: `destination_note` when
an obligation type has no governed destination; `closed_action_lineage` as
lineage rather than as work; `evidence_state` as a labelled sentence; and an
explicit *"No canonical positions exist on this property"* for a property with
none, which `0 of 0 · server-paged` did not say.

---

## 6. The trap that nearly produced a false green

**Every geometry assertion passed against a surface that was not displayed.**

The first harness called `psLiveFutureRentRoll()` directly. It rendered, its
text read correctly, and *no horizontal dead end · no element wider than 390px ·
the primary action is not clipped* all passed — because `MAIN#workspace` still
carried `display:none`, every element measured `0×0`, and a width assertion over
zero-width boxes is true of nothing. `textContent` reads hidden nodes perfectly
well, which is exactly why a text assertion cannot stand in for a visual one.

It surfaced only because a `click()` on the real Load more control timed out
with *"element is not visible"* — the one assertion that could not be satisfied
by a hidden element.

Fixed by (a) opening the surface through the real navigation,
`openDesk('management') → openManagementDoor('forward')`, and (b) proving
visibility **by measurement** before any geometric claim: A0a/A0b/A2b/G0a/H1b
require a non-zero body box and require every row to have a measurable one.
H3 additionally requires a population of more than fifty measurable nodes,
because a pass over an empty list proves nothing.

This is the same shape as the four vacuous assertions recorded in the 10A/10D
lane and the four unexecuted safety checks in the SMS lane. **A guard you have
not executed is a claim, not a control** — and a guard you have executed
against nothing is worse, because it has a green tick beside it.

### 6.1 It happened a second time, in the correction pass

Closing this slice added a reconciliation to `slice10e_publish_dir.js`: read the
two production data rails, extract the globals they declare, and refuse if the
stub list disagrees. It ran, and printed:

```
globals: the rails are absent from this tree — nothing to reconcile
```

**Both rails were sitting in the tree at 435 KB each.** The extraction pattern
required a declaration keyword or a non-word character before the name; the
rails assign through `window.__X =`, so the preceding character is a dot, which
the pattern explicitly excluded. It matched nothing, took the "absent" branch,
and reported a reassuring sentence about a file it had just failed to read.

It was caught only because the sentence was *implausible* — nothing else about
the run would have failed. So the empty case is now a **refusal**, not a
message: rails present with zero globals extracted exits non-zero and says the
extraction is broken. Falsified by breaking the pattern on purpose and reading
the exit code **by redirect, not through a pipe** — exit 1.

With it fixed: **19 measured, 19 stubbed, 0 divergent.** The count that this
receipt previously quoted from prose is now measured on every build.

Two instances in one slice, the same shape both times. The lesson is narrower
than "test your tests": **a guard whose negative result is a sentence rather
than an exit code will eventually print that sentence when it is wrong.**

---

## 7. The stack, and what it deliberately does not serve

Committed in the app repository so the next run is a command rather than an
archaeology. Slice 9's equivalent stack was never committed and had to be
reconstructed from a recipe.

```
slice10e_publish_dir.js                        build the publish directory
slice10e_browser_stack_serve.js                :8081 publish dir · :443 TLS front
slice10e_browser_stack_setup.js                seed synthetic data, mint sessions
slice10e_future_rent_roll_browser_proof.browser.js   the acceptance
slice10e_run_browser_acceptance.sh             the runner
```

```
Chromium   /opt/pw-browsers/chromium-1194/chrome-linux/chrome
flags      --host-resolver-rules=MAP property-spine-api.onrender.com 127.0.0.1:443
           (+ the two CDN hosts and the two font hosts)
           --ignore-certificate-errors --no-proxy-server
TLS front  :443, routed by Host — the API host proxies to :3000, every other
           host returns an empty asset
app        :8081
API        OPERATOR_APP_ORIGIN=http://127.0.0.1:8081 — operator CORS is
           fail-closed and denies silently otherwise
```

**`property-spine-data.js` and `policy.js` are never copied.** They are the two
REAL production data rails from `INCIDENT_STATIC_DATA_EXPOSURE.md` §3b and
they are still loaded by `index.html` for other surfaces. Serving them would put
real resident records one screenshot away from a proof artifact. The publish
directory is an **allowlist** — nothing arrives unless it is named — and it
**refuses to build** if a copied file *declares* one of the nineteen incident
globals — and, since this pass, if its own stub list and the two rails
disagree in either direction, which turns the count from a quoted sentence
into a measurement. The two rails are replaced by empty-global stubs, classified **Class 4,
delete-on-activation**: they are removed the moment the §7 reactivation gate
removes the rails from the artifact, at which point `index.html` no longer loads
them and there is nothing to stub.

The substitution is proven not to touch the surface under test rather than
argued: the Future Rent Roll renderer reads only
`window.__psLive.loadResource`, and B14 proves it makes zero requests without a
session while A21–A24 prove every request it does make is 2xx.

**An earlier version of that refusal was a keyword scan** and it refused
`index.html`, which mentions resident field names 76 times because it is the
code that *reads* those fields. A check that has to be switched off to let the
real work through is not a check. The rule is now **declaration**, which is
exact: the rails assign those globals, application code only reads them. The
keyword count is still computed and printed per file as disclosure.

---

## 8. Reproducing the database, and a finding that is not this lane's

The harness database was built by replaying `migrations/001…129` into an empty
local Postgres 16. **It does not replay.**

**THIS IS THE BASELINE LANE'S FINDING, NOT THIS ONE'S, AND ITS RECORD IS BETTER
THAN THE ONE THIS RECEIPT FIRST CARRIED.** `docs/DB_CONNECTION_INVENTORY.md`
Appendix H — merged to `main` in PR #33 as `4983e5d`, independently and against
its own empty Postgres — reproduces the same failure and decomposes it more
carefully:

```
1  genuine defect      012_bank_intake.sql
6  real cascade        017 · 021 · 022 · 023 · 031 · 037
8  method artifacts    053 · 054 · 087 (ledger-head preflight — these PASS
                       through the real runner) and 077 · 106 · 110 · 120
                       cascading from them
```

The mechanism, which both accounts agree on exactly: `001_baseline.sql:238`
creates `vendors` **without** `yardi_code`; `012_bank_intake.sql:33` declares
`vendors` again **with** it; `create table if not exists` **silently discards
every column** when the table already exists, and the failure surfaces only at
`012:43` where the index needs the column.

**Correction to this receipt's own first version.** It said *"eleven files do
not replay"* and listed `083`, `084`, `087` and `110` among them. Three of those
four were **artifacts of the provisioning method used here** — a probe that
applied each file individually and wrote its own ledger row, which collides with
`083`/`084`'s self-recorded rows and defeats `087`'s ledger-head preflight.
Through `migrate.js` they behave differently. Appendix H names that class
explicitly and this receipt did not. **The honest count is 1 genuine defect and
6 real cascades**; the rest depends on how the files are applied. An overstated
count of broken migrations is exactly the confident-wrong this document exists
to refuse, and it is corrected here rather than left standing.

**None of the affected files touches any table Slice 10 reads**, verified
empirically rather than asserted: 10B/10C/10D/hotfix reproduce their exact
baseline numbers on the resulting schema. Applied ledger: **120 rows**.

**Not fixed here.** `012` versus `001_baseline` is a migration-lineage question
owned by the money lane. It is recorded, not repaired.

Commands, exactly:

```bash
createdb spine_harness
DATABASE_URL=… MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=000 \
  node migrations/migrate.js --apply      # stops at 012; replay the rest
export HARNESS_DATABASE_URL=…  CURSOR_SECRET=<any value>
node tests/slice10d_build_fixture.js      # 10,000 + 100,000 synthetic spaces
node slice10e_browser_stack_setup.js      # the 10E states/clean/empty/none/no-zone set
SP=… API_DIR=… ./slice10e_run_browser_acceptance.sh
```

**`CURSOR_SECRET` must be exported.** Without it `slice10d_scale_transport_proof`
and `hotfix_future_rent_roll_guards_proof` each report one honest failure —
the harness policing its own claim, not a regression.

---

## 9. The fixture, and why each shape exists

One property per response-level state, and one position per row-level state.
Twenty positions on the states property, five on the clean property, one
non-revenue position on the empty property, none on the fourth, and no
operating timezone on the fifth.

```
STATES     20 positions · every row axis · occupancy WITHHELD, rent WITHHELD
CLEAN       5 positions · every axis settled · occupancy PUBLISHED 60.0% (3/5)
                          rent PUBLISHED $6,499, disclosing a legacy amount
EMPTY       1 position, non-revenue · occupancy EMPTY — a zero denominator is
                          not the same fact as a withheld one
NO POSITIONS 0 positions · result_state no_qualifying_result
NO ZONE      no operating_timezone · state unavailable, result authority_missing
10D SCALE  10,000 positions, all adverse conditions at ordinal >= 9,900
```

The clean property exists because a surface that only ever refuses cannot be
told apart from a surface that refuses everything. Without a published rate in
the fixture, "the rate is correctly withheld" is unfalsifiable.

The scale property proves the assertion that matters most for transport: page
one is fifty clean rows, and its rate is **withheld by a blocker roughly 9,900
rows away** (E4, E5). A summary computed from the page would have looked
perfect. `complete_stats` is computed before slicing, and the browser proves it.

---

## 10. What remains open

**10F reactivation — blocked, not this slice's.** `index.html` still loads
`property-spine-data.js` and `policy.js` globally for other surfaces.
Reactivating the app republishes two real-data libraries. The Future Rent Roll
renderer is clean and reads live server contracts only; 10E should not be held
for 10F.

**Deployment — blocked, SMS lane.** Migration 129 is claimed on `main` and
unreleased, so `main` refuses to boot. Slice 10 is on branches and nothing here
changes that.

**Three unproducible contract states** (§4) — needs a product decision, not
code.

**Migration 012 replay divergence** (§8) — money lane.

**Two things this receipt does NOT claim.** Slice 10 has never run against
production data or a production database; and the acceptance ran against a
locally built schema, not a Neon branch cut from production. Where those differ,
this proof does not cover the difference.

### Addendum — 2026-08-04. A third thing it did not claim, and should have.

Everything above was proven at `4584991`. `main` then moved to `fbd7a3a`, which
changed **no Slice 10 file at all** — and turned this branch red anyway. That
commit gave `gate_harness_isolation.js` a second direction, and four Slice 10
harnesses that only *required* `HARNESS_DATABASE_URL` failed the new
requirement to *refuse* a same-target value.

So the sentence "no Slice 10 source or browser defect is open" was true and was
not the whole answer. **A proof is evidence for the tree it ran against.** This
receipt named the two gaps it could see and did not name the one it could not:
that its own green belonged to a SHA, not to the branch.

Repaired in-lane and re-proven at the integrated candidate; the totals in §2
were re-run rather than carried forward. Detail is in
[`SLICE_10_RELEASE_READINESS.md`](SLICE_10_RELEASE_READINESS.md).

---

## 11. Doctrine, where it decided something

Recorded because the derivation is worth more than the outcome.

**§5 refused a nicer number.** Ten declared contract states, seven producible.
The honest report is **7 of 7 reachable**, with the declared vocabulary and the
three reserved states named beside it — §4. Ten would have required either a
lie or a fake fixture.

**§5 again, at the row.** Four rent facts under one sentence, a contested row
with no named conflict, invisible denominator classes and a reason-less refusal
are all the same defect: a distinction the server took care to type, thrown
away by the last thirty pixels.

**§17 shaped the harness.** The acceptance imports the frozen vocabularies
instead of retyping them. A harness that keeps its own copy of a vocabulary is
a second implementation of it, and two copies of one rule is a defect even
while they agree.

**§19 decided the publish directory.** Not by asking whether stubbing is
allowed, but by asking what the substitution touches: the surface under test
reads only live server contracts, and that is proven, so an empty stub for two
libraries it never reads cannot change what it renders.

**§33 is why any of this exists.** The renderer was harness-green. Six real
defects, two of which made a core control inoperative, were between that and a
browser.

---

**One Property. One Truth State. One Next Action.**
