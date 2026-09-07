# Retained-source authority — desktop candidate receipt

An active same-organization member could review another property's rent roll and
download its retained file without a target-property assignment. Maintenance-only
access also admitted lease/occupancy setup. The existing activation scope owner
now requires a live target-property Leasing or Management assignment for members.
Same-organization administrators and platform administrators retain their existing
authority. An authorized assignment at B works with a valid session at A.

The property source download and opening-position read use that same owner.
Utility and Contracted Services downloads now enforce their existing upload-kind
lists; Deal Setup downloads require rent_roll. This closes the alternate file
routes in both directions. The duplicate Utility kind list was consolidated.
No new role, permission store, source store, dependency or workflow was introduced.

## Custody and philosophy

Inspected API c8dc7d1c011de50cbca9417491e88e36d61c3d1e and paired app
93d37d6d027d145c1bb78b4e7b23e605819c2c8c. Read CURRENT_STATE then the complete
PHILOSOPHY, SHA256 977b30a4c41b0f8c1511da3521d030e031ab13b9d1897eea5970f011f487fc28.
Sections21/40.8 map to live actor/property/module HTTP assertions; sections30–34/41
map to existing scope/kind owners and falsification before acceptance. Source
retention and zero actual-source confirmations preserve sections4–8/29.

[Tested custody](tested-custody.json) records the frozen base heads, diffs and all
11 changed file hashes. Root verified every hash again after the successful run.
API changes include four product files and proof/wiring; app changes only the
browser proof. No app product code changed.

## Falsification

The initial outside-property observation was valid. A subsequent module matrix
reused one user and overwrote its assignment; its maintenance label was invalid.
Root caught the flaw. Distinct actors now have executable live assignment/module
assertions. Corrected strict successor checks against clean detached c8 produced
63 passes and9 expected failures across outside-property, maintenance-only and
inactive-target reads/opening actions. Admin/relevant-module, cross-org refusal
and invalid-session controls remained green.

After the core permission repair, the expanded proof produced73 passes and4
failures for wrong-domain file downloads. The corresponding Express unit tests
also failed before the kind checks. Existing same-property valid-kind and
cross-property negative controls were preserved. This supersedes the flawed
module-label evidence; it does not erase that correction.

## Successor verification

- `node tests/unit/utility_http.test.js`:28 passed.
- `node tests/unit/contracted_service_http.test.js`:22 passed.
- `npm run verify`: all50 source-governance gates passed.
- `tests/e2e/onboarding_review_local.ps1` with space, relay and source-auth browser
  phases enabled: completed successfully against the owned disposable cluster.
  API source-authority77 and mixed-grain35 passed; established Deal Setup HTTP31,
  source/lifecycle/identity/space controls passed. All six browser phases passed.
- Browser authority: two unauthorized actors visibly refused, no stale review;
  Management, Leasing and administrator controls opened the exact target property.
  A first attempt stopped on a test's case-sensitive name comparison against CSS
  uppercase headings; root inspected the correct painted property. The test now
  normalizes presentation case/whitespace while preserving exact API scope and
  visible-heading assertions. The complete rerun passed.
- July164 rows and Skyline262 rows remain review-only. Fixed counts, exact retained
  bytes/hashes, missing-versus-zero facts, lineage, restart, mixed Add All and
  containment controls passed. Actual-source confirmations, persons, leases and
  opening positions remain0. The existing retained-claim/Ask and availability
  regression checks also passed; no new Ask reader was introduced.
- Owned database dropped, cluster stopped, data removed. SMS/model/egress logs0.

[Browser authority evidence](browser-auth-receipt.json) and
[full rehearsal controls](full-rehearsal-receipt.json) contain aggregate evidence;
private originals, rows, actor/runtime IDs, sessions and screenshots stay local.
The source-authority proof is now part of the standard post-boot CI suite too.

## Limits

The new opening-position authority matrix uses an explicitly unestablished
fixture; the existing full HTTP lifecycle proves established source composition
for its authorized actor. Activation refusal checks preserve row count, not every
possible table/field. Broader deal-summary visibility and permission taxonomy are
not claimed to have been exhaustively audited. Source-only independent review
does not substitute for the observed HTTP results above.

This is local candidate proof, not deployment or whole-product acceptance.
Retained-file discovery and Fable's historical mixed-inventory correction/hold
question remain separate. Pending claim-index DDL was used only inside the owned
disposable proof; no production migration, actual-source confirmation or real-user
action occurred.
