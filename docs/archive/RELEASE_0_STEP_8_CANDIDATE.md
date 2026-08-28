# Release 0 — Step 8 candidate: the four-state proof reader

**⛔ BUILD-AHEAD. Deploys ONLY after activation and inventory exist (Step 7).**

The reader is where every earlier step becomes visible to a human. If it
collapses legacy history into *"proof failed"*, the release has rebuilt the exact
ambiguity it exists to remove: a closed work order with nothing behind it,
indistinguishable from a real one.

---

## The four states, and the fifth thing that is not one

```text
satisfied · not_satisfied · legacy_indeterminate · missing_evaluation_defect
```

`unavailable` is **not** a state. It is the **read failing** (§3.2.1). Without an
activation there is no inventory, so legacy cannot be told from defect and the
derivation *cannot run*. The reader says so and **omits `state` and `satisfied`
entirely** — absent, not null, not `"unavailable"`.

**It must not fall back to `missing_evaluation_defect`.** That would raise a
writer-defect on every terminal work order the moment the reader shipped, before
the inventory that distinguishes them even exists. `falsify_step8.js
--variant defect-fallback` shows exactly that happening with the guard removed.

---

## Terminality and legitimacy are two different questions (§3.2.0)

```text
TERMINAL, for defect detection:   status in ('complete','closed')
LEGITIMATE historical closed:     closed AND in the cutover inventory
```

Revision 3 defined terminal as *"complete, or closed **for an inventoried
row**"*, and that left the hole the release exists to close:

```text
closed + NOT inventoried + no evaluation
  → not "terminal" under that definition
  → escapes missing_evaluation_defect
  → escapes the defect sweep
  → renders as if the work were merely unstarted
```

That is precisely the row a surviving legacy writer or an in-flight request
creates **after** activation — the case the release exists to catch, silently
exempted by the definition meant to catch it.

**Inventory membership decides whether a `closed` row is legitimate legacy
history. It does not decide whether it is visible to defect detection.**

`falsify_step8.js --variant inventoried-terminal` restores revision 3 and shows
the escapee reading as not-yet-due.

**No timestamp comparison appears anywhere.** Membership is the discriminator,
which closes the missing-`completed_at` gap without a fifth state. `H4` asserts
that against the *live code* — its first version matched the module's own header
prose explaining the absence, and reported a comparison that does not exist.

---

## One engineering decision, made from doctrine

The plan places the derivation *"in `work_order_status_read.js`"*. **It lives in
`src/release0/proof_state.js` instead**, called from exactly one place.

The plan supplies the reason itself: §3.2.0 requires that *"the same predicate
governs the §4.2 defect sweep, so the reader and the sweep cannot disagree about
which rows are visible."* A predicate that must be shared by two consumers and
must never differ between them is a module, not a paragraph inside one of them.

*One canonical derivation* is the requirement. A single file is one way to get
it, and the weaker way once a second consumer exists. `isTerminal` and
`deriveProofState` are exported so the sweep imports them rather than restating
them.

---

## What changed for existing consumers

**`satisfied` used to mean "preserved evidence exists".** It now means what §3.4
says, derived from the evaluation head and the inventory:

```text
satisfied                  → satisfied = true
not_satisfied              → satisfied = false
legacy_indeterminate       → satisfied = null
missing_evaluation_defect  → satisfied = null
read_status "unavailable"  → BOTH keys absent
```

`null` is deliberate. `C5`/`C6` prove the consequence that makes §3.3 necessary:
**legacy and defect are indistinguishable by `satisfied` alone**, and are told
apart only by `state`. That is why both shapes carry it.

### §3.1 — the corrected classification array, finally applied to the reader

`PROOF_REQUIRED_CLASSIFICATIONS` in the reader still carried `unclassified`,
while the Step 3 evidence gate had already dropped it. **The reader and the
writer disagreed about what counts as proof.** Now both use
`["repair_photo", "condition"]`. Production impact: zero rows (audit B2 = 0).

---

## Proof

```text
tools/step8/prove_step8_reader.js    41 / 41   exit 0
tools/step8/falsify_step8.js         3 variants, each exit 0
npm run verify (10 gates)            PASS      exit 0
```

```bash
bash tools/steps23/baseline_136.sh
PROVE_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/steps23/apply_137.js
STEP8_DATABASE_URL='postgresql://postgres@127.0.0.1:5433/r0scale?sslmode=disable' \
  node tools/step8/prove_step8_reader.js

for V in collapse-legacy defect-fallback inventoried-terminal; do
  bash tools/steps23/baseline_136.sh
  PROVE_DATABASE_URL='...' node tools/steps23/apply_137.js
  FALSIFY8_DATABASE_URL='...' node tools/step8/falsify_step8.js --variant $V
done
```

```text
U1–U6   before activation: read_status unavailable, state and satisfied
        ABSENT, no fallback to defect, legacy_evidence still travels
E1–E6   each of the four states from real rows; an evaluation head
        OUTRANKS inventory membership; every value is one of four
N1–N4   not terminal is never a defect; an UNCLASSIFIED photo does not
        make the read satisfied (§3.1)
H1–H5   closed + NOT inventoried is terminal and reads as a defect; no
        timestamp comparison in the live code, and the check is not vacuous
C1–C7   the frozen mapping, including that `satisfied` no longer means
        "evidence exists"
B1–B5   both shapes carry state; every list row AGREES with its detail
        read; the list shows ≥3 distinct states, so it is not uniform by
        accident
W1–W2   a full list read and a detail read change NO row count, and the
        derivation contains no INSERT/UPDATE/DELETE
X0–X5   the API never emits any of the three conditions the app's
        normalizer classes as a CONTRACT FAILURE — checked over every
        proof block on both shapes
```

### The compatibility boundary, from the emitting side

§3.4 names four conditions for the app's normalizer: one expected, three contract
failures. The app already proves it **handles** all four
(`proof_normalizer_contract.test.js`, step 1). **Nothing proved the API cannot
produce the three failures.** `X1`–`X4` assert that over every proof block both
shapes emit, because a contract failure that appears on one work order in
production is exactly the one nobody catches.

### The reader writes nothing, ever (§4.2)

`W1` measures it — six table counts before and after a full list read and a
detail read. `W2` asserts the derivation contains no write statement, **so that
nobody later helpfully adds §4.2's obligation insert to the reader.** Raising the
obligation is the *sweep's* job; the sweep is a separate governed writer and is
**not built here**. A read that writes cannot be run twice, cached, or executed
on a replica.

### What this does NOT establish

```text
NOT proven   HTTP or a browser. Every assertion calls the reader directly.
NOT proven   production. No production row was read.
NOT proven   the §4.2 defect sweep and its obligation lifecycle — NOT BUILT.
             The reader reports the defect state; nothing yet raises the
             obligation, and that gap is deliberate, not an oversight.
NOT proven   the app rendering any of this. Step 1 proved the normalizer
             handles the shapes; no browser has seen a real one.
proven       the derivation against a real PostgreSQL at schema 137, across
             every state and both emitted shapes.
```

---

## Sequencing

Step 8 deploys **only after** activation and inventory exist. If it shipped
first, every terminal work order would read `unavailable` — which is honest and
harmless, and is the safety net rather than the plan (§5.1 sequences it after
activation so the case does not arise).

```text
Step 7   activation + inventory exist
Step 8   the reader emits proof.state on BOTH shapes      ← this
Step 9   HTTP acceptance · browser acceptance · the app consumer-proof
         release · then the cleanup release that removes proof.satisfied
         after a repo-wide consumer search
```

## Rollback

Code only, revertible. Reverting restores the old evidence-presence `satisfied`
and drops `state`; the app normalizer accepts both shapes by construction
(step 1), so a revert renders the old way rather than failing.

Nothing written, nothing to unwind.
