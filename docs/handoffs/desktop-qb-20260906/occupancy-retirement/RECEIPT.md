# Leasing occupancy and retired inventory

Status: local successor service/HTTP and full onboarding rehearsal passed.

The operator needs current leasing counts to exclude inventory that a recorded
retirement decision established was never valid inventory. The existing owner is
`inventory_retirement.js`; its predicate is already used by canonical inventory
reads. The smallest missing piece is its use in the leasing occupancy primitive
and the leasing desk's available-unit query. A second retirement workflow, a new
hold meaning, or a replacement occupancy formula is outside this correction.

Inspected API candidate: `139e6968f14bf43c944c3b2c2fdfd1a3535f6a4a`.
Paired app: `8d1da846c7954036325afc0e30ea63e026f4c36c`.
CURRENT_STATE and the full PHILOSOPHY were read. Relevant boundaries are physical
identity versus tenancy (§29), canonical ownership (§§30–34, 41), and evidence
appropriate to the claimed reader (§33).

Fable's `53d3117` is source-reviewed reported evidence, not a QB rerun of its
33 assertions. Its current lease of 850 is a nonzero current-rent control;
zero future monetary controls do not prove general future financial invariance.
Different occupancy denominators under a down hold remain a separate question.

The first local run stopped before assertions because the proof fixture tried
to insert an unsupported leasing basis forbidden by the real schema. This is
a test defect, not the required product failure. The disposable database was
dropped, its cluster stopped, and its owned data removed. No product code had
changed. Migration 026 requires the legal `unknown` value, not null; the initial
null replacement suggestion was corrected before rerunning. Healthy
condition payloads omit status; tests must match that existing contract.

Required falsification: retire an unleased unit beside a leased sibling, observe
the stale bed and unit counts and available-unit list through the existing
services and HTTP, then require exclusion after the correction. Preserve the
850 sibling rent, label-derived exclusions, missing-basis uncertainty, retirement
refusal on a leased unit, database refusal of a later lease on retired inventory,
and reinstatement. Any browser claim must identify an actual visible reader.

No production action, deployment, migration authority, actual-source confirmation,
or whole-product acceptance is claimed.

## Root-observed failure and correction

The corrected strict successor proof on unchanged API 139e696 returned 33 passed
and 8 failed. All eight failures were the retired bed/unit counts in the direct
primitive, condition HTTP, dashboard ratio, and dashboard availability. The
leased sibling, retirement/late-lease refusals, label exclusions, restoration,
and legal unknown-basis controls passed. Owned database and cluster cleanup
completed. Proof SHA256:
`83970AF7FBE443431745D9B70C9FEAE071CE3512C7DD2DAC5EB9DF0611DE80AA`.

The successor reuses `NOT_RETIRED_SQL` in the space inventory query, both sides
of unit occupancy, and the leasing desk's availability query. No new retirement
owner, formula, status rule, table, route, or UI component was added. Existing
label exclusion counts retain their meaning within current inventory. Syntax
and diff checks passed before the full owned rehearsal began.

The first successor rehearsal passed 43 retirement checks (41 behavioral checks
plus two browser fixture checks), 77 source-authority checks, 35 mixed-grain
writer checks, and the source-authority browser phase. It then failed because
the new browser assertion expected a condition strip on authenticated Leasing.
The current operating home deliberately does not render that strip, although
it fetches the condition response. Market & Pricing uses separate reads.
This was an obsolete proof target, not evidence of a displayed correction.
Owned database/cluster cleanup completed. The proposed browser phase and its
private fixture emitter were removed; all 41 behavioral assertions remain.
App product and browser runner return unchanged to 8d1da84. Visible occupancy
presentation is now an explicit independent Fable question, not claimed closed.

## Commands and scope

- `node --check` on both changed product files, the new proof, and the local
  orchestrator; `bash -n tests/e2e/verify_all.sh`; `git diff --check`: passed.
- `node tests/verify_source_governance.js`: all 50 gates passed after the product
  correction. These are source/unit gates, not deployment evidence.
- Strict parent observation used the existing PowerShell local wrapper with
  `PROOF_FOCUSED_NAME=leasing_occupancy_retirement`, `PROOF_EXPECT_DEFECT=0`,
  and `ONBOARDING_SPACE_PROOF_ONLY=1`. No product code was changed at that point.
- Full successor uses the same wrapper with `ONBOARDING_SPACE_PROOF_ONLY=0`,
  no focused proof, and `PROOF_SPACE_BROWSER=1`, `PROOF_RELAY_BROWSER=1`,
  `PROOF_SOURCE_AUTH_BROWSER=1`. Local workbook paths are supplied privately.
  The existing wrapper owns cluster allocation, migration chain, pending-index
  proof scope, server boundary, provider containment, restart, and cleanup.

The new proof is wired into the existing CI `verify_all.sh` after its owned HTTP
server starts. No browser phase or parallel product owner was retained. The
test harness is a proof component, not an operating workflow or truth store.

Independent review found the same retirement predicate on both sides of unit
occupancy and throughout bed inventory. The strongest remaining counterexample
would be pre-existing or bypassed leases on retired inventory: these readers
exclude them, while conflict provenance belongs to `retiredExclusion` and
`retirementProvenance`. Supported retirement and later-lease writes are refused
by the existing service and database guard; this proof does not bypass either.

## Final local result

The final frozen candidate passed all 41 retirement behavioral assertions,
77 retained-source authority assertions, 35 mixed-grain writer assertions, and
the existing source, ledger, lifecycle, snapshot, claim-index, identity, relay,
and availability checks in the complete local wrapper. All six existing browser
phases passed: source-auth, spaces, relay, stage, restart, and mixed. Real-source
database lineage and restart assertions and synthetic mixed Add All passed.
Actual-source confirmations stayed zero. Provider/egress logs stayed empty;
the owned database was dropped, cluster stopped, and cluster data removed.

`tested-custody.json` binds the final product and proof bytes to the inspected
bases. The app remains unchanged at 8d1da84. The new correction's proof rung is
service and HTTP; the six browser phases are onboarding regression evidence,
not evidence that a visible occupancy panel displays the corrected value.
