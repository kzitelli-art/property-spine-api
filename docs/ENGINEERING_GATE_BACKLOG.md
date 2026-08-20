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

---

## G2 · Notice when a removal condition has come true

**Status:** backlog. Recorded when PHILOSOPHY.md was tightened to say it:

> *A removal condition without a mechanism that notices when it has become
> true is a promise, not a control.*

**The failure that produced it.** `properties.lease_config` was named, in
writing, as the exact replacement condition for the Class-2
`EXTERNAL_LEASE_CONFIG` map — a hardcoded list holding one property. Nobody
executed it, nothing noticed, and the adapter quietly became the
architecture: no property but the internal demo could generate a resident
lease packet at all. The condition was written correctly and read by no one.

**What the gate should do.** Collect declared Class 2 / Class 4 removal
conditions, and report which are now SATISFIED — the named column exists, the
named table is populated, the named integration is live — so the adapter is
due for deletion. Conditions too vague to check are themselves the finding:
a removal condition that cannot be evaluated is not a control either.

**Related but distinct from G1.** G1 asks whether a proof is reachable. G2
asks whether a temporary thing has outlived its reason. Both are gates about
the verification system rather than the product, and both came from the same
root cause — this codebase produces unverified intent faster than it verifies
it.

---

## W-4 · The migration runner tells its operator the opposite of the truth

**Status: OPEN. Deliberately not closed by the release verifier.**

Five migrations — 076, 077, 079, 083, 084 — record themselves into
`schema_migrations` inside their own transaction. The runner then reports:

> FAILED — rolled back. Nothing from this file was applied

while the objects were in fact created and persist. An operator is told the
opposite of the truth at the moment they most need accuracy: mid-release,
deciding whether to retry.

**The release verifier does not fix this.** `tests/e2e/verify_release_182_187.js`
protects ONE release by making the database, rather than the runner's prose,
the verdict. The runner still lies to everyone else, on every other release.

**This violates the same doctrine the product is held to.** A release tool
that reports confident failure over a successful commit is exactly the
"confident wrong" the product refuses to emit. We do not accept it from
`applicationNext` or from Ask Spine; we should not accept it from the thing
that changes the schema.

**The fix, after 182–187 have safely landed:** correct the EXISTING runner's
reporting so its message agrees with database reality — distinguish "the
file's work did not land" from "the file recorded itself and the ledger
insert conflicted". **Do not build a second migration mechanism.** One
canonical runner, telling the truth.
