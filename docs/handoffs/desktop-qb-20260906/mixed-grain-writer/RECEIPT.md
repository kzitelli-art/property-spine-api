# Refuse contradictory new inventory through the existing writer

An import naming `(whole unit)` and `Room1` on the same by-bed unit could create,
confirm and establish both positions, then make both offerable. This proves a
contradiction in the source's inventory grain, not physical overlap inferred from
labels. The materialization writer now refuses that wanted-label combination
before inventory mutation and tells the operator which unit and labels need review.
No new writer, reader policy, store, workflow or historical deletion was added.

## Custody and first red

QB inspected Fable 1fda9b7 and reread CURRENT_STATE and complete PHILOSOPHY at
API 01fac5fb20317f310e2e62bc4e05439f076f39cf. App base:
a60550f02c627b96694a76fcce8963dee7fc1cce. Candidate branches:
codex/claim-relay-20260907 and codex/claim-relay-ui-20260907.

The adapted positive parent witness ran before the product edit, requiring exact
01fac5f and unchanged src/server/migrations. Real owned HTTP accepted both source
orders; both labels became governed beds with separate lineage and confirmed,
established, offerable positions. 27 assertions passed, including direct service
and legitimate controls. This independently reproduces Fable's reported defect.
It does not replay all 43 observations in Fable's original correction experiment.

## Repair and successor

The only product change is in materializeRentableSpaces. Preserve unit existence
and retirement refusal precedence, then reject normalized, deduplicated wanted
labels containing the owned PLACEHOLDER_LABEL plus another label. Service code:
MIXED_GRAIN_LABELS. Existing HTTP mapping deliberately returns generic `refused`
with the plain unit/labels/review message. Whole-import atomicity is asserted at
HTTP because earlier rows can be processed before materialization is invoked.

Successor 25 assertions passed: both HTTP source orders return409, retained
artifact metadata survives, units/spaces/lineage/proposals/leases/baselines stay
unchanged, direct service refuses both orders and preserves the placeholder.
Controls preserve single whole-unit inventory, a sole named bed, an existing
placeholder-plus-bed fixture, three beds, whole-unit and bed units on one property,
held whole-unit history and future-only rows. An explicit historical fixture
still refuses destructive reinterpretation through PLACEHOLDER_NOT_PRISTINE.

Both contradictory XLSX source orders were then uploaded through the actual
browser. Each produced a visibly painted refusal; retained bytes were downloaded
and hash-checked. Screenshot inspected privately. No app product edit was needed.

## Full regression and reproducibility

Run the existing tests/e2e/onboarding_review_local.ps1 wrapper with the owned
Postgres and Chrome, paired app, July and Skyline inputs. Successor settings:
PROOF_SPACE_EXPECT_DEFECT=0, PROOF_SPACE_BROWSER=1, PROOF_RELAY_BROWSER=1,
PROOF_HISTORICAL_READER_CHALLENGE=successor. Parent witness additionally uses
ONBOARDING_SPACE_PROOF_ONLY=1 and PROOF_MIXED_GRAIN_EXPECT_DEFECT=1 with unchanged
01fac5f product. The wrapper owns the fresh cluster, marker, server and cleanup.
The new HTTP proof is also wired after owned server readiness in verify_all.sh.

The full successor passed parent source/lifecycle/snapshot witnesses, pending
index negative and successor controls, source32, ledger16, lifecycle10, snapshot15,
Deal Setup HTTP31, mixed-grain25, relay21, identity17, unattached14, readiness13,
historical/space checks and browser spaces/relay/stage/restart/mixed.
App run_harnesses.sh via Git Bash: 44 harnesses, 1648 passed, zero failed.

July:164 rows/proposals,64 units,105 spaces. Skyline:262 rows/proposals,72 units,
160 spaces. Both retain zero actual-source confirmations, people, leases and
established opening positions. Exact bytes/hashes and lineage survive restart.
Ask fact gathering was checked; no Ask HTTP/model answer was exercised.
Owned database dropped, server/cluster stopped, data removed; SMS/model/egress
logs zero bytes. Safe final aggregates and all five changed-file hashes are in
the adjacent JSON receipts; those hashes were checked before commit.

## Competing explanation and limits

A source-only review initially claimed the fresh loader excluded the whole-unit
sentinel. It actually excludes only `(bed)`. Both parent and successor HTTP
observations refute that claim; direct materializer tests are a separate section.
The true existing-space reuse path remains outside this new-materialization guard.

Existing mixed inventory is not repaired or held by this change. Fable's next
independent question is whether existing governed correction/hold mechanisms can
protect publication while preserving history and agreeing across readers.
No production or provider action, deployment, merge/rebase, production migration
or actual-source confirmation was performed. Pending index DDL remains confined
to the owned disposable rehearsal. Browser verified is not deployed.
