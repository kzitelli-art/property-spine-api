# The compliance gather branch gets the module guard its four siblings have

Lane `claude-opus/compliance-guard-20260914`, over board `571892df`.
App pin `b0be9f4` unchanged. **One product change, one condition, one place.**
No schema, no deployment, no production read.

## What was wrong — and what it was not

`gatherFacts` held no `allowed_modules` check on `if (subject === "compliance")`,
while utility, contracted_service, debt and equity — the four domains sharing
this exact `asset_management` entitlement — each carry one.

**This was defence-in-depth, not a live leak, and saying so is part of the
finding.** `answer()` has always refused a compliance question from a session
without `asset_management`, with a sayable refusal: *"Compliance is not
available in your current access for this property."* Nothing was disclosed
through the door. What was wrong is that `gatherFacts` is **exported and
independently callable** — and this module already states that rule about the
leasing guard:

> *"The inner NOT_AUTHORIZED envelope in gatherFacts is KEPT. It is not
> redundant: gatherFacts is exported and independently callable."*

The reasoning was applied to leasing and not to compliance.

## First red — already on the board

`witness/first_red.txt`, run bare at `571892df`. The entitlement matrix pinned
the divergence as today's behaviour rather than letting it pass silently:

```
compliance    · READ_FAILED  · READ_FAILED  · READ_FAILED  · READ_FAILED  E READ_FAILED  E READ_FAILED

ok  compliance · []          · UNENTITLED but divergence is DECLARED (open gap, pinned)
ok  compliance · leasing     · UNENTITLED but divergence is DECLARED (open gap, pinned)
ok  compliance · management  · UNENTITLED but divergence is DECLARED (open gap, pinned)
ok  compliance · maintenance · UNENTITLED but divergence is DECLARED (open gap, pinned)
ok  gatherFacts called directly with ZERO modules DOES disclose compliance facts (the gap, pinned)
134/134 passed
```

**The pin worked as designed.** Applying the guard turned it red —
`"the gap no longer reproduces — update the registry declaration"`, 137/138,
EXIT 1 — which is how the fix announced itself and forced the registry
declaration to be retired in the same commit. That assertion is not deleted:
it is **inverted**, so it is now the wall that stops the guard being removed.

## The correction

```diff
-  if (subject === "compliance") {
+  if (subject === "compliance"
+      && (allowed_modules || []).includes("asset_management")) {
```

`answer()`'s pre-gate, every other branch and the reader are untouched.

## ⚠ Deviation from the assignment, with the measurement behind it

The assignment asked for two things that **conflict with each other**, and I
could not satisfy both inside one branch:

1. *"give the unentitled path the same inner envelope leasing_person has:
   `facts.compliance = { read_state: "NOT_AUTHORIZED", note }`"*
2. *"assert the NOT_AUTHORIZED envelope is not counted by composite_silence
   as pending or unread"*

Measured on the board, not assumed:

```
leasing_person    = {"read_state":"NOT_AUTHORIZED","note":"This session does not hold …"}
composite_silence = {"state":"BLIND","unread":[{"domain":"leasing_person",
                     "read_state":"NOT_AUTHORIZED"}],
                     "why":"at least one required reader did not return, so
                            silence cannot mean health"}
```

`composite_silence` classifies every fact whose `read_state !== "OK"` as BLIND.
So the envelope tells an unentitled session that the property's silence cannot
mean health — **about a property where nothing is unknown.** Only the caller's
authority is limited. That is the §40.7 collapse: *a reader you MAY NOT read is
not a reader that DID NOT RETURN*, and it is not a property-level unknown at
all.

Copying that envelope into compliance would have propagated the defect to a
second domain and failed requirement 2 in the same stroke. So:

- **compliance uses ABSENCE**, which is what its four sibling domains do and
  what `composite_silence` reads correctly. The other half of the same
  instruction — *"matching the shape of the utility/debt/equity branches
  exactly"* — is satisfied precisely by this choice.
- **The leasing_person defect is PINNED, not propagated and not silently
  skipped**, in the matrix proof (§4b). Three assertions record that the
  envelope exists, that it still reads BLIND, and that the stated reason is
  false for an entitlement refusal. Delete the block and the defect goes quiet
  again; fix the silence computation and the block goes red, which is how that
  fix will announce itself.

The real fix is `composite_silence` excluding `NOT_AUTHORIZED` from `blind` —
outside a lane scoped to one branch, and a behaviour change to a domain this
lane was not given. **Owner decision below.**

## The compliance row, before and after

```
before   · READ_FAILED   · READ_FAILED   · READ_FAILED   · READ_FAILED   E READ_FAILED   E READ_FAILED
after    · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
utility  · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
```

Compliance now reads exactly like utility's row. `READ_FAILED` in an entitled
cell is the proof's hostile db doing its job — the branch ran and the read was
attempted, which is what an entitled cell must show.

## Proof

| rung | result |
|---|---|
| entitlement matrix | **143 run · 143 passed · 0 failed · EXIT 0** (was 134; +3 for the pinned §40.7 finding, +2 for the closed divergence, +4 net from the inverted pin) |
| same, at the moment the guard landed | 137/138 · EXIT 1 — the pin announcing the fix |
| Ask Spine reader gate, bare | **161/161 · EXIT 0** · 14 domains / 8 registered / 6 pending / 0 waived |
| reachability falsification | **30/30 · EXIT 0** — red 8 ways and green again |
| `node tests/verify_source_governance.js; echo EXIT=$?` | `✓ PASS — all 56 source-governance gates exited 0` · `PARENT EXIT 0` · **EXIT=0** |

Regressions at head, all EXIT 0: `skyline_ask_spine_sms_matrix`,
`ask_spine_answer`, `personal_attention_convergence`, `debt_vocabulary_subject`,
and all seven `tests/unit/compliance_*.test.js` (`compliance_contracts`,
`compliance_document_read`, `compliance_evidence_intake`,
`compliance_extended_semantics`, `compliance_owner_rulings`,
`compliance_semantics`, `compliance_user_journey`).

**`compliance_ask_spine` does not exist in this repository.** The assignment
named it as a regression target; `node tests/unit/compliance_ask_spine.test.js`
is `MODULE_NOT_FOUND` at head and at the board sha alike. The compliance
db-backed proofs that do exist (`compliance_http.db.js`,
`compliance_persistence.db.js`, `compliance_extended_persistence.db.js`) need
Postgres and run in CI.

## Lane #5's receipt

Given a **dated pointer only**. The matrix table there is left exactly as it
was measured — it is the evidence that found the defect, and rewriting it
would destroy the record of why this lane exists.

## What this would miss

- **One entitlement, one branch.** This proves compliance now refuses
  unentitled callers. It does not prove the projection an *entitled* caller
  receives is correct or minimal — the matrix's hostile db flattens entitled
  cells to `READ_FAILED`.
- **Fact-level entitlement (§40.4) is still unproven.** Entitlement rides on
  each fact into the composer; both layers here gate the *branch*.
- **The sweep was the 8 registered domains.** `facts.attention`,
  `facts.person`, `facts.tour_schedule` and the other non-registered keys were
  not crossed against module sets by this lane or the last one.
- **Cross-domain composition authorization** remains declared UNSOLVED.
