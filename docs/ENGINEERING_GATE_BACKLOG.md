# Engineering gate backlog

Recorded, not built. Each entry is a gate we know we want because a specific
failure got past us — not a speculative idea.

---

## G1 · Detect proof files unreachable from the test runner

**Status:** backlog. Deliberately NOT built — recorded during the leasing
reconciliation work and postponed so that work could finish.

**The failure that produced it.** `src/shared/proof_next_action_resolver.js`
is the regression oracle for `applicationNext`, the canonical next-action
authority. It had been throwing on `require` since the repository was
reorganised into `src/` — its path still pointed at the old repo-root
`applications.js`. It guarded nothing, for months, and nothing said so,
because it is not matched by `run_harnesses.sh`'s `*.test.js` glob and no
other runner invokes it. When the path was repaired it immediately ran 84
assertions and passed, which is exactly the point: it was a good oracle that
had been silently absent from verification.

**The systemic lesson.** *A test that is never invoked is functionally not a
test.* This is the same class of failure as the rest of what the leasing
audit found — `executeSpineLease` with 24 passing tests and no caller,
`leases.security_deposit` written by a service and created by no migration,
`properties.lease_config` read-first by design and created by nothing. This
codebase produces unverified intent faster than it verifies it, and every one
of those was invisible until something was actually run.

**What the gate should do.**

- Enumerate files that *intend* to be verification: `proof_*.js`,
  `*_proof.js`, `gate_*.js`, `*.test.js`, `tests/**`.
- Determine which are reachable from a real runner — `run_harnesses.sh`,
  `tests/verify_source_governance.js`, or an explicit documented command.
- Report any that are unreachable, AND any that are reachable but fail to
  load (a require error is not a test failure today; it is silence).
- Distinguish the honest cases from the accidents. A file deliberately
  outside the glob — the `*.browser.js` harnesses, `tests/e2e/*` — is
  correct and documented, and must be declarable rather than flagged
  forever. The gate is looking for files that believe they are wired and
  are not.

**Why it is worth building.** Every other gate we have asserts something
about the product. This one asserts something about the *verification
system itself*, which is currently the least-verified part of the repo.

**Do not** turn this into a general test-framework project. It is one
report: which proofs are unreachable, and which are reachable but broken.
