# Leasing read correction — verified release

**September 12, 16:17 UTC: API `dab19b6a84493093911427dfe2de29ee91451ac9` is live, paired with unchanged app `e23a36a4588cdeda10eb3d902cea4b917f68dbe9`.** API Render deployment `dep-dainlj67bikc739d9sd0` succeeded Live. Public health identifies dab19b6 and all 24 served app files byte-match e23a36a at 2026-09-12T16:17:15.554Z. Fresh read-only Neon observation at 16:17:16.499Z reports 182 applied migrations / ceiling 194. No migration was applied.

## Released behavior

A submitted application bound to an offer could break the whole property's Leasing desk: its read-only transaction called a shared reader that requested a row lock. Claude cfdd445 corrected the initial projection. Independent QB review reproduced two remaining paths: historical acknowledged terms with a pending successor, and the standing projection used by person-facing reads. All three projection paths now read without requesting writer locks. The mutation paths retain their default locks, authority checks, exact-home identity, currentness and acknowledgement checks.

The complete product delta from the previous live API1320c2c is four source files, 18 insertions and 8 deletions. Packages, schema and app source are unchanged by this API release. This does not grant Mike approval powers or change any actual property's configuration.

## Acceptance

- Exact combined [CI run 483 / 34704388244](https://github.com/kzitelli-art/property-spine-api/actions/runs/34704388244), verify job103581692529, completed success. All required proofs and cleanup passed, including all56 source-governance gates. Selected log lines are retained in CI_483.txt.
- The strengthened no-consent, two-person real HTTP journey passed155 checks /0 failures /3 observations locally and in full CI. It asserts Mike's terms/approval/company-signing refusals, KZ's confirmation authority, and Mike's own packet/link actions without fallback. Desk and queue are reread at ten material transitions; exact identities and hidden read failures are checked.
- Historical read regression passed6/0 both locally and in CI, with acknowledged1200 distinct from pending1350 and no acknowledgement rewrite. The unit branch/mode regression verifies nonlocking projection paths and default locking writers. These tests are registered in the ordinary verification runner.
- Independent agent reviewed the exact combined candidate and CI conclusion. Root verified integration source/proof equivalence to the owned tested tree, the source delta against live, and exact Render commit selection.

The historical fixture is a seeded reader regression, not a public-writer journey. The journey uses synthetic property, staff authority, instrument and fenced transports. Its fixture prelude cancels previous nonterminal standard-BedB leases, so this is not a twice-executed journey that preserves the first lease. Existing real-browser slices remain historical evidence on their recorded pair; no new production operator journey or provider delivery is claimed.

## Deployment and recovery

Render build remains `node --version && npm --version && npm ci --omit=dev`; pre-deploy command is empty; start is `npm start`. Live logs explicitly report verify-only startup and SCHEMA VERIFIED, 182 migrations /194 ceiling. Root manually selected the full reviewed SHA rather than the service's tracked branch head. The app's earlier onboarding release remains unchanged at deployment dep-dainbnrm8hqs73dimq8g.

Immediate recovery for this correction is the already-built API deployment `dep-dailaj7qj5pc73aj9o1g` at `1320c2c5a6e52caa15de967670ed826ea1d10a84`, keeping app e23a36a. No schema reversal is needed. Public release verification is DESK_READ_RELEASE_RELEASED_20260912.json. Receipt-only successor commits are documentation and are not the deployed SHA.

Root dropped its nonce-owned database, stopped its own PostgreSQL17 cluster55449, and verified no listeners on55449/3350. CI also verified its owned database drop. Other clusters, shared databases and retained research were preserved.

## Remaining launch and onboarding work

This closes the bounded screen-read defect. Actual Mike/KZ authority and signer setup, the staff Tour times writer, real eligible-home reads, website connections and operating acceptance remain separate. Greenery additionally needs approved custody, physical-identity mapping, classification and its remaining operating configuration. No blanket retirement of107 legacy rows is approved by this test.

The reusable onboarding framework and app improvements are recorded in [the framework](../REUSABLE_ONBOARDING_20260912.md) and [app release](../reusable-onboarding-release/RECEIPT.md). The next generic safeguard is human review of inventory identity before source reading materializes homes. It remains unimplemented; a label prefix or matching total cannot substitute for physical-identity approval. Existing retirement service review is a separate lane.
