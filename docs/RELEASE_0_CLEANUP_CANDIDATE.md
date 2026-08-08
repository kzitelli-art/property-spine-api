# Release 0 — cleanup candidate: retiring `proof.satisfied`

**⛔ NOTHING IS REMOVED HERE. This is the inventory and the removal conditions.**

§3.4 froze a compatibility mapping so consumers that had not moved to `state` kept
working:

```text
satisfied                 → true
not_satisfied             → false
legacy_indeterminate      → null
missing_evaluation_defect → null
```

The cleanup release removes it. **It cannot run yet**, and the point of this
document is to say exactly what has to be true first — and to make the inventory a
rule rather than a snapshot.

---

## The search, and one trap in it

`satisfied` is heavily overloaded in this codebase. An obligation is satisfied, a
readiness certification is satisfied, a delivery is satisfied. **A repo-wide search
for the word returns 80 files and almost none of them are this.**

### `proof_satisfied` is a different thing and must not be touched

```text
proof_satisfied          snake_case, a COLUMN on work_completion_claims
                         (migration 115) — the WORK ACCEPTANCE domain
proof.satisfied          the Release 0 proof block's compatibility field
```

They share four letters and nothing else. `work_acceptance_service.js`,
`readiness_service.js`, `readiness_gate.js`, `unit_turn_read.js` and
`unit_turn.js` all read `proof_satisfied` and **none of them is a consumer of this
release's contract.** They are named here so a future cleanup does not delete the
wrong thing on a grep.

---

## The inventory

### API — internal consumers: **ZERO**

```text
src/surfaces/work_order_status_read.js:418   PUBLISHES it (list projection)
src/release0/proof_state.js  SATISFIED_FOR   PUBLISHES it (the frozen mapping)
src/maintenance/maintenance.js:665, :711     passes the object to JSON, reads nothing
```

There was **one** consumer, and this release's own HTTP acceptance step found it:

```js
// nextActionFor, before
case "completion_claimed":
  return proof.satisfied ? "Close out the work order" : "Obtain repair photo before completion";
```

Step 8 made `satisfied` **absent** on a failed read, and `undefined` is falsy — so a
read that never completed answered *"Obtain repair photo before completion"*. Fixed
in the HTTP acceptance candidate; it now switches on `read_status` and `state`.

**That was the last one.** `satisfied` is now published for consumers and read by
nobody in this API.

### App — three consumers, all downstream of the normalizer

```text
proof-normalizer.js          reads proof.satisfied on BOTH contracts
work-lifecycle-door.js:134   pr.satisfied === true      (normalized output)
work-lifecycle-door.js:333   proofOf(d).satisfied !== true
work-lifecycle-door.js:345   pd.satisfied !== true
```

The three door reads are of the **normalizer's result**, not the wire, and each is
exactly equivalent to a `state` test: `build()` sets `satisfied =
EXPECTED_BOOLEAN[state]`, so `satisfied === true` ⟺ `state === "satisfied"`, and
`unavailable()` sets both to null. Moving them is mechanical and safe.

The normalizer is different. It reads `proof.satisfied`:

- on the **new** contract, as a **cross-check** — `state_boolean_mismatch` catches a
  server that sends a state and a boolean that disagree;
- on the **old** contract, as the *only* signal there is.

---

## The removal ladder

```text
1  DONE      the API has zero internal consumers, and a gate keeps it that way
2  next      the app door's three reads move from `satisfied` to `state`
3  BLOCKED   the normalizer's OLD-CONTRACT branch may not be removed while any
             deployed API can still emit the old shape
4  BLOCKED   only then may the API stop publishing `satisfied`
```

**Step 3 is the real gate, and it is not a code question.** The normalizer accepts
both contracts precisely so the app could ship before the API did, without a
coordinated deploy. It stops being needed when no API version in production can
emit a proof block without `read_status` — which is downstream of **Step 4
activation**, not of anything in this repo.

**Do not remove the compatibility field early.** A consumer built against §3.4 that
suddenly receives no `satisfied` gets `undefined`, and `undefined` is falsy — the
same shape as the defect this release just fixed, in every consumer at once.

---

## The inventory is enforced, not asserted

`tests/gate_proof_compatibility_field.js`, on the standard `npm run verify` path
(now 11 gates):

```text
G0    the sweep found the shipped source to search
G1    nothing in this API READS the compatibility field
G2    …and the pattern still finds the one place that PUBLISHES it
G3    nextActionFor exists and was found (so G4 is pointed at something)
G4    …and derives nothing from the `satisfied` FIELD
G4a   …while the state LITERAL is still allowed, and still used
G5    …it switches on read_status and state instead
G6    the compatibility field is STILL PUBLISHED — removing it early is the
      other way to break this contract, and the one a cleanup release will
      be tempted by
```

Falsified: a new file reading `status.proof.satisfied` turns `G1` red.

```text
gate_proof_compatibility_field.js   7 ok · G1 RED   with a probe consumer present
gate_proof_compatibility_field.js   8 ok · 0 failed  with it removed
npm run verify (11 gates)           PASS   exit 0
```

### G4 was wrong before it was right

The first version asserted `!/\bsatisfied\b/` inside `nextActionFor` — and **the
correct code fails that**, because comparing `state === "satisfied"` is the whole
point of the fix. The gate condemned the repair.

It now matches a **property read** (`\.\s*satisfied`), and `G4a` asserts the state
literal is still there — so `G4` cannot go green because the logic left rather than
moved. **A gate that fails the fix is worse than no gate**: the next person deletes
the gate, not the defect.

---

## What this candidate does NOT do

```text
NOT done     no field is removed, in either repo
NOT done     the app door still reads the normalized `satisfied` (step 2)
NOT possible the normalizer's old-contract branch — blocked on production
             activation, which is Step 4 and is the owner's call
NOT proven   production. Nothing here was run against it.
```

## Migration numbers

Unchanged. This candidate adds **no migration**. `138` and `139` remain Release 0's;
the next unrelated migration starts at `140`.
