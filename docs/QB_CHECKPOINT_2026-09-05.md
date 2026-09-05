# Candidate repair and proof contract — 2026-09-05

This candidate descends from `f95344977b6c7cacacd40f503bed452f501227a0`.
It is not a deployment or a merge recommendation. Production observations remain
API `d55dae960a52c762187c94e5f48e348fccc0c964` and app
`4849545118fc422177bc604389608cdbb55df458`; this work does not refresh those observations.

## Separate changes

- Verification owns a freshly created database in an explicitly admitted,
  separately provisioned loopback PostgreSQL instance. Existing databases are
  never reset. Database marker, server PID and response nonce identify the run.
  Node server processes receive a restricted environment and provider fakes;
  nonloopback socket connections are refused and recorded. Setup failures,
  required-browser skips, attempted egress and cleanup failures are nonzero.
- Notice correction preserves the original space and lease, writes the canonical
  identity columns, and refuses missing/contradictory identities or retargeting.
  The existing unit-wide open-notice limit is not repaired here.
- Bank attribution takes `FOR NO KEY UPDATE OF t` on the shared deposit before
  reading attributed capacity. Partial-attribution/full-cash-proof semantics are
  unchanged and remain a separate correctness defect. No financial-readiness
  claim follows from the serialization proof.
- The economics shadow report uses the active property only. Supplying
  `other_property_id`, including an empty parameter, receives a named 400 refusal.
  A session on the target property retains its ordinary economics read.

## Behavioral evidence contract

`tests/e2e/verify_all.sh` first serves the unchanged f953449 source, archived
directly from git. Candidate test-only preloads identify/fence that process;
they do not alter its business handlers. The new proofs require positive
observations of the defect with `PROOF_EXPECT_DEFECT=1`. A setup error, missing
route, timeout or crash does not establish a defect. The same proofs then run
normally against the candidate server; these stages are labelled separately.

The source-history anchors are notice initial-column repair
`d2fed71386b3d3543df2f63d988ca779809949f7`, sequential deposit cap
`919c2c81e341f90da097fcc1c0d6d207d8872417`, and caller-selected comparison
`ee51c1a2d0c19dd6824803fa1972b045e3f6d990`. Runtime falsification in this runner
uses f953449, where all three defective implementations remain. It does not
claim to execute those three earlier revisions or a nonexistent d55 comparison.

The deposit proof observes the exact blocked server connection and its recorded
READ COMMITTED setting, inserts a competing attribution, and requires a 409
after lock release. A separate pair of HTTP requests tests the capacity result.
The notice proof uses both canonical mounted reads and durable event pointers;
give/correct/cancel leaves two historical notice events. The comparison proof
requires canonical published pricing before accepting the parent's false
absence as evidence, and checks the target session's ordinary read afterward.

The existing Deal Setup HTTP proof runs under the same ownership and provider
boundary, including its server restart. Its synthetic confirmation assertions
do not establish any real Greenery source record. Exact execution outcomes are
the workflow logs for the candidate SHA, not the presence of these test files.

## Holds and next milestone

Legacy ingestion consumer/disposition analysis remains a proposal. Source search
found no governed operating caller; external usage is unknown. No ingestion
retirement, provider action, production migration, deployment or real-user
change is performed. Partial cash proof and concurrent notices on different
rooms remain explicitly outside this repair checkpoint.

July Greenery begins with separately accessible, hash-verified real inputs and
durable review: 64 units, 105 positions, 164 evidence records, 145 assigned claims
and 19 unresolved applicants are expected source controls until executed.
Synthetic green does not certify those real-file counts. Future/current claims,
missing actual rent, source provenance and individual confirmation refusals
must remain explicit. August supplies no missing room-level lease dates.
