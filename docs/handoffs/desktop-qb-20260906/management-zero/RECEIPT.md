# Management preserves a reconciled zero — QB receipt

Candidate base: API 3df9ed97e65abfd8c2ac06a50f8290355dc141bc /
app 22d705d8d5f35408fc5ae3abd7f2d1bbcd05fee5.
Root reread the full paired API philosophy before product edits. This is a repair
of the existing app count selection, not a new domain, writer or read owner.

## Intention and observed defect

An operator reading a reconciled count must see its literal zero. The existing
rentRollStats calculation uses the signed-in rent-roll summary ahead of source
rows, but truthiness fallback discarded zero. Six selections now use nullish
fallback, preserving existing precedence and missing-field behavior. No API
product changes. Source-summary versus contractual-occupancy meaning remains a
separate question; this change does not establish leases or reconcile bad input.

The synthetic fixture intentionally supplies inconsistent reconciliation evidence:
two occupied source rows, inventory2, source occupied0. A second property supplies
one occupied row and one vacant row with source occupied1. Both enter through the
existing authorized POST /operator/rent-roll/import, then GET /operator/rent-roll.
Direct source-row insertion and browser response injection are not used.

Root first exercised the shipped function in a VM: occupied0 became2. The expanded
existing app contract test failed on parent inventory0 becoming8. After correction,
51 assertions passed, including explicit/legacy zero, absent/null fallback,
nonzero precedence, future separation and unreconciled behavior. Related app
checks: server classification67, row semantics37, cutover152, all passing.
All21 inline scripts parsed.

## Real browser first red

Unchanged parent app index.html at22d705d in isolated app-zero-parent-20260907,
with only the successor browser verifier copied into that worktree. API business
source remained3df9ed9. Owned Windows wrapper applied the real migration chain,
validated its server, and passed10 HTTP fixture assertions. Clicking Management
then failed ZERO_MANAGEMENT_DISCARDED_RECONCILED_COUNT: API summary occupied0,
visible screen100% and '2 of 2 occupied'. Root visually inspected the captured
cell screenshot. Database dropped, cluster stopped, owned data removed.

## Successor acceptance

Full owned July/Skyline rehearsal passed. All eight browser phases passed: zero,
source-auth, holds, spaces, relay, stage, restart and mixed. Real-source lineage,
server restart and synthetic mixed Add All database assertions passed. The zero
phase displayed0% / 0 of2 and the control50% / 1 of2. Root visually inspected both
cell screenshots. Source authority77, retirement41, holds86 and mixed writer35
remained green. Database dropped, cluster stopped, owned data removed; SMS,
Anthropic and egress logs all empty. Browser actual-source confirmations0.

CI now schedules the ten HTTP assertions in the successful owned-server block,
after startup/identity wait. This runner edit was made after local runtime
completion; full CI on the resulting commit is the acceptance check for wiring.
The product, fixture, browser verifier and local runner were frozen during both
runs. See tested-custody.json for their hashes and browser-receipt.json for the
scrubbed zero/nonzero observations. Parent browser failure is retained separately.
No new deployment, production migration, provider operation or actual-source
confirmation. Fable's availability candidate8222c29 is not part of this change.

## Scope and proof ownership

Root owns product correction, browser verifier, runner integration and acceptance.
The cheaper helper drafted only management_zero_counts.db.js; root caught and
fixed its omitted zero override, pool cleanup coverage and missing scope check
before execution. Proof files are Class3 test infrastructure outside the operator
workflow. Existing session, property authority, source writer and reader survive.
Forbidden second path: a new occupancy store/calculator/endpoint or fabricated
live browser response to manufacture a passing demonstration.

## Commands and delivery

App delivered on6c8346609bf373fea4b8e495b4c18a1a92e98d39,
codex/claim-relay-ui-20260907. API product files are unchanged.

Both runs used tests/e2e/onboarding_review_local.ps1 with private July/Skyline
inputs, local PostgreSQL17.11 and Chrome. Parent run set
PROOF_FOCUSED_NAME=management_zero_counts and PROOF_ZERO_BROWSER=1 against
app-zero-parent-20260907. Successor cleared PROOF_FOCUSED_NAME, set
ONBOARDING_SPACE_PROOF_ONLY=0, PROOF_ZERO_BROWSER=1, PROOF_SPACE_BROWSER=1,
PROOF_RELAY_BROWSER=1, PROOF_SOURCE_AUTH_BROWSER=1 and PROOF_HOLDS_BROWSER=1.
PROOF_EXPECT_DEFECT=0 in both: the parent was required to satisfy the successor
contract and failed, rather than switching expected output to match its defect.
ONBOARDING_PARENT_ROOT pointed at the unchanged owned e09c541 worktree.

Final source verification: all50 source-governance gates and8 current-state
coverage checks passed. App contract51 and related67+37+152 passed. Bash runner
syntax and git diff checks passed. CI exact-head result will be recorded by QB.
