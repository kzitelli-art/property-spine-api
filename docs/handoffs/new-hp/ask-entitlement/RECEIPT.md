# Entitlements precede intelligence — the unentitled path, proven per domain

Lane `claude-opus/ask-entitlement-proof-20260914`, over board `0ae2602d`.
App pin `b0be9f4` unchanged. **PROOF ONLY — `git status --porcelain -- src/
migrations/ server.js` is empty and `git diff -- src/` against the board is
empty.** No schema, no deployment, no production read.

## What was unproven

The reachability detector (row 77) proves a question *reaches* a domain's
gather branch. It said nothing about what an **unentitled** session gets once
it arrives — the stated weakness (c) of that lane. §40.8: *unentitled facts
never enter model context; a prompt is not a security boundary.*

## The matrix — 8 domains × 6 module sets

One sentence per domain, taken from that domain's own declared `reached_by`
so the two proofs cannot drift. `gatherFacts` called directly with a db whose
every use throws, so a read that needs the database announces itself as
`READ_FAILED` rather than quietly succeeding against a fixture.

```
domain              []              leasing         management      maintenance     asset_mgmt      all five
prospect_match      · absent        E OK            E OK            · absent        · absent        E OK
maintenance         · absent        · absent        E READ_FAILED   E READ_FAILED   · absent        E READ_FAILED
compliance          · READ_FAILED   · READ_FAILED   · READ_FAILED   · READ_FAILED   E READ_FAILED   E READ_FAILED
utility             · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
contracted_service  · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
debt                · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
equity              · absent        · absent        · absent        · absent        E READ_FAILED   E READ_FAILED
tenancy             · absent        E READ_FAILED   E READ_FAILED   · absent        · absent        E READ_FAILED
```

`E` = entitled by the declaration. `READ_FAILED` in an entitled cell is the
hostile db doing its job — the branch ran and the read was attempted, which is
what an entitled cell must show. `OK` on `prospect_match` is the term-less
refusal projection, which needs no database.

**47 of 48 cells behave.** Every unentitled cell is `absent`. No unentitled
cell produced a fact, and no unentitled absence was counted by
`composite_silence` as pending or unread (§40.7 — not knowing because you may
not ask is not the property being unreadable).

## FOUND — the compliance row

**`gatherFacts` holds no module guard on the compliance branch at all.**
Every other registered domain guards in two places; compliance guards in one.

```js
if (subject === "compliance") {          // ← no allowed_modules check
```

Called directly with **zero modules**, it returns the full compliance
projection — licence label, standing, evidence labels, next milestone. Proven,
not inferred, with a complete synthetic standing shape:

```
modules=[]  readerReached=1  LEAKS SYNTHETIC-LICENCE-0001 = true
```

**The blast radius is bounded, and I checked rather than assumed.** `answer()`
refuses first:

```js
if (["compliance","utility","contracted_service","debt","equity"].includes(subject)
    && !modules.includes("asset_management")) { return { outcome: "not_authorized", … } }
```

Exercised in the proof: through `answer()` with zero modules the outcome is
`not_authorized`, the synthetic label does not appear, and the refusal is
sayable — *"Compliance is not available in your current access for this
property."*

So this is a **defence-in-depth gap, not a live leak through the door**. It
matters because this module's own comment says exactly why:

> *"The inner NOT_AUTHORIZED envelope in gatherFacts is KEPT. It is not
> redundant: gatherFacts is exported and independently callable."*

That reasoning was applied to leasing and not to compliance. `gatherFacts` is
exported, and this proof is itself a caller of it.

**Not fixed — this was a proof lane and the fix is product code.**

### How the gap is tracked instead of hidden

`compliance` declares `entitled_by: ["asset_management"]` — taken from the
door, which is the real contract — plus an explicit `composer_divergence`
block naming the four unguarded cells. The proof reads that declaration and
**pins today's behaviour**: delete the declaration and the proof goes red;
*fix the composer* and it also goes red, which is how a fix announces itself
and forces the declaration to be retired with it.

I am flagging the judgment call: the assignment said the declaration follows
the composer as it is today. The composer's **two layers disagree with each
other**, so "as it is today" has two answers. I declared from the door and
recorded the `gatherFacts` divergence explicitly, rather than declaring
compliance readable by everyone — which is what following `gatherFacts`
literally would have produced, and would have written a defect into the
registry as though it were the contract. **Owner decision below.**

## First red

`witness/first_red.txt`. Throwaway mutation, working tree only, reverted,
never committed — `git diff -- src/` confirms byte-identical to the board:

```
-  if (subject === "debt" && (allowed_modules || []).includes("asset_management")) {
+  if (subject === "debt") {
```

```
FAIL  debt · [] · UNENTITLED, so no fact enters context
        read_state="READ_FAILED" — an unentitled session received a debt fact
FAIL  debt · [] · absence is not counted as a silence of the property
… 9 failures across 4 module sets …
125/134 passed — 9 failure(s)   EXIT 1
```

The silence assertion fails alongside the disclosure one, which is the point:
a leaked domain also corrupts `composite_silence`, turning an unentitled
session BLIND.

## What "no database" is, and is not

Asserted apart, because they are different claims. The unentitled **debt**
cell touches no database at all (`queries === 0`). The unentitled
**maintenance** cell *does* — subject `work` also gathers the attention queue,
which is scoped by module inside its own service. So "the db was untouched" is
**not** the §40.8 property and is not asserted as one; what matters is that no
maintenance fact appeared, which the cell assertion already covers. Claiming
the stronger thing would have been false for one row.

## Proof

| rung | result |
|---|---|
| `tests/proofs/ask_spine_entitlement_matrix.test.js` | **134 run · 134 passed · 0 failed · EXIT 0** |
| same, under the throwaway mutation | **125/134 · 9 failed · EXIT 1** |
| Ask Spine reader gate, bare | **161/161 · EXIT 0** · 14 domains / 8 registered / 6 pending / 0 waived |
| reachability falsification | **30/30 · EXIT 0** — red 8 ways and green again |
| `node tests/verify_source_governance.js; echo EXIT=$?` | `✓ PASS — all 56 source-governance gates exited 0` · `PARENT EXIT 0` · **EXIT=0** |

Nearest regressions at head, all EXIT 0: `skyline_ask_spine_sms_matrix`,
`ask_spine_answer`, `debt_vocabulary_subject`, `personal_attention_convergence`.
The SMS matrix already asserted one debt cell; this proof is built **beside**
it, not over it — that assertion is untouched.

Registered in `verify_all.sh` beside the other unit steps as
`step "ask spine entitlement matrix"`.

## Out of scope — stated, not silently skipped

- **Cross-domain composition authorization.** §40.8 records it UNSOLVED and
  this lane does not pretend otherwise. One question pulling two *individually
  entitled* domains into one answer that discloses what neither would alone is
  not tested here and is not claimed.
- **The HTTP `/ask` door and its session resolution.** This proves the
  composer's own gate, not the transport that feeds it — except at the one
  place where the two layers disagree, where the door's behaviour is
  exercised precisely because the disagreement makes it load-bearing.

## What this would miss

- **One sentence per domain.** A domain whose branch is entered by a second
  sentence under different conditions is not covered.
- **Module sets, not sessions.** `allowed_modules` is taken as given; how a
  real session comes to hold them (server-derived identity, §21) is the
  door's business and untested here.
- **No fact-level entitlement.** §40.4 says entitlement rides on each *fact*
  into the composer. This proves the *branch* gate. A domain that correctly
  refuses unentitled callers could still over-disclose within an entitled one.
- **The hostile db flattens entitled cells.** Most entitled cells read
  `READ_FAILED`, which proves the branch ran but not that the projection is
  correct or minimal. Proving *what* an entitled session gets needs a real
  database and is a different lane.
