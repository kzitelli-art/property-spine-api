# Phase 1 — conversational seam extraction · PROOF RECEIPT

**Status: extracted and proven against everything locally executable.**
**NOT merged. NOT deployed. NOT production-active.**

> Two full-schema resident proofs have never run against these changes and are
> **required before merge**. See §8.

| | |
|---|---|
| Branch | `claude/conversational-seams-and-technician-loop` (stacked on Slice A tip `1454330`) |
| Extracted from | `1454330` (intent) and `bf84eb4` (clarification, receipt) |
| Run at | the commit this document is committed in — **re-prove at whatever SHA merges** |
| Seams | `src/conversation/{intent,clarification,receipt}.js` |
| Harnesses | `conversation_intent_extraction.test.js` · `conversation_clarification_and_receipt.test.js` |
| Result | **45/45** and **150/150**, exit 0 |
| `npm run verify` | **5/5 gates**, exit 0 |

---

## 1. What moved, and what deliberately did not

| Seam | Moved out of `tenantlink.js` | Class (§18) |
|---|---|---|
| `intent.js` | `classifyMessage`, `recognizeAnswer` | 1 — permanent |
| `clarification.js` | the §7.1–7.6 ladder and the §7.4 confirmation decision | 1 — permanent |
| `receipt.js` | every resident-facing sentence the conversational path emits | 1 — permanent |

**The canonical write did not move.** `workOrderService.createWorkOrder` and
`appendClarification` are untouched. The seams interpret and acknowledge; they
never write. `insert into work_orders` still appears in exactly one file in
`src/`, asserted over the whole tree.

**Nothing was extracted from the structured maintenance form**
(`POST /tenant/maintenance`). The resident has already declared "this is
maintenance" there; it runs no classification and no clarification ladder, and
its wording is its own. It is a different surface, not a second copy of this
one. Replacement condition: if a second *conversational* caller ever needs the
form's acknowledgment wording, it joins `receipt.js` then — not before.

---

## 2. The load-bearing separation

> A successful operating action does not prove that a text was delivered.
> A provider SID does not prove that the operating action occurred.

`composeReceipt` returns exactly two keys — `operating` and `delivery` — and the
result is frozen. There is no field in which to merge them and no way to add
one. Both directions are proven:

| Proven | How |
|---|---|
| A committed work order whose acknowledgment failed on the wire | `operating.committed === true`, full text intact, `delivery.delivered === false` with its reason |
| A delivered message where nothing was committed | `delivery.delivered === true`, `operating.committed === false`, `operating.text === null` |
| A provider sid on a **failed** send | carried on the record, and `delivered` is still `false` — it is derived from `state` alone |
| The portal door, which has no transport at all | `not_attempted` — neither delivered nor failed |

`not_attempted` is a third honest state, not a synonym for either.

---

## 3. What the clarification seam may never do

Each prohibition is structural, not documented:

| Prohibition | Why it cannot happen |
|---|---|
| Invent property context | The module holds no property list, opens no connection and has no candidate set. It *verifies* the caller's rows against the caller's own scope and refuses a mismatch. |
| Infer staff authority from a message | No actor, role, assignment or entitlement crosses the boundary in either direction — asserted over comment-stripped source. |
| Create new work when the clarification belongs to an existing one | `propose_new_action` is unreachable while a clarification is outstanding. Proven exhaustively over the four verdicts plus seven junk values: exactly one — `separate_problem` — can reach it. |
| Treat `obligations.person_id` as the reporter | No person identifier is an input. The query is still keyed on `ce.person_id`, never `o.person_id`. |
| Silently convert ambiguity into a default | Every ambiguous state terminates in `hold_for_human`. An unreadable open set, an out-of-scope row, a row with nothing to append to, and an unquotable question all **refuse**; none degrades to "open a new request". |

**Duplicate answers cannot duplicate the action.** With nothing outstanding, the
only route to a terminal decision is `resolvePriorResolution`, and it requires
an explicit `true`/`false`. `undefined`, `null`, `"no"` and `0` are all refused:
a check nobody performed is not a negative result. A caller that skips it gets
no action to take at all.

---

## 4. What the receipt seam may never do

`operatingReceipt` is pure over the **committed** canonical result and its input
keys are whitelisted. Proven: the resident's message cannot be passed as `body`,
`message`, `inbound`, `text`, `classification`, `personId` or `smsSid`, nor
hidden inside `context`, nor inside the result — every one is refused by name.

It reads facts **back from the committed row**, not from what was requested. A
row that differs from the decision that produced it is described **as
committed**, the divergence is stated on the receipt, and it forces a human. An
idempotent create reports itself as `deduped`, not as `created`.

**A refused canonical write produces no success receipt.** Eight refusal paths
are proven to return `text: null` with a named refusal code, and `tenantlink`
throws on a null text — rolling T2 back, so the claim is preserved and flagged
and no reply is sent.

---

## 5. One implementation

Asserted against **comment-stripped** source, over the conversational region
only (`processInboundClaim` → the end of the inbound-SMS route):

- no copy of any of the seven fixed resident sentences;
- no copy of any of the seven interpolated sentence templates;
- no local clarification ladder, no local §7.4 override;
- the wire result is read exactly once, only to build a delivery receipt;
- both seams are imported *and* called;
- `src/conversation/` holds exactly the three seams;
- neither seam `require`s anything at all — no transport, no database, no model.

> The scoping is deliberate and was earned. The first cut matched on a
> 40-character prefix and reported a duplicate that was really the maintenance
> form's near-identical emergency line. A second assertion matched
> `convo.person_id` while looking for `o.person_id`. Both were false defects;
> both are recorded in the harness at the point of the fix.

---

## 6. ⚠ The harness was proven able to fail

150/150 on a suite you wrote yourself is not evidence until it can go red. Nine
deliberate mutations were introduced one at a time and reverted:

| # | Mutation | Failures raised |
|---|---|---|
| 1 | Reword one resident sentence | 2 |
| 2 | `unclear` verdict proposes new work | 10 |
| 3 | `delivered` derived from `providerRef` | 2 |
| 4 | Drop the scope-mismatch refusal | 2 |
| 5 | Prior-resolution check accepts `undefined` | 1 |
| 6 | `composeReceipt` gains a merged `ok` field | 3 |
| 7 | Receipt reads urgency from the decision, not the row | 3 |
| 8 | `tenantlink` keeps a local copy of a reply string | 2 |
| 9 | Remove the unknown-key whitelist | 10 |

Every one was caught. The tree was restored and re-verified byte-identical
against git before the clean run was recorded.

---

## 7. Two harness defects fixed in this work

1. **`conversation_intent_extraction.test.js` reported an unavailable check as
   `ok`.** When the prior revision could not be read it printed a passing
   assertion. That is the harness declaring a check it never ran to be green.
   Unavailable is now `NOT PROVEN` — counted, printed, and it sets a non-zero
   exit so the run cannot read as clean.
2. **The same harness compared against `HEAD~1`.** One more commit on this
   branch and it would have compared against a revision that already has the
   extraction, inverting the check. Both harnesses now pin explicit SHAs
   (`1454330`, `bf84eb4`).

---

## 8. What must still happen before this merges

1. **`resident_sms_work_order_proof.js` and `resident_sms_route_proof.js` must
   run against these changes.** They build no schema of their own and need the
   provisioned full-schema database of
   `docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md`. Their previous green
   predates every line of this work.

   > Wording identity and exhaustive branch coverage are strong evidence about
   > the composed text. They are not evidence that the route still runs.

2. Everything Slice A already requires, unchanged: migration **129** activated
   (`docs/UNBLOCK_1_MIGRATION_129_ACTIVATION.md`), **130** confirmed still free,
   and every proof re-run at the exact SHA that merges.

Until then the honest statement is: **extracted, delegated, and proven for
everything that can be proven without a database — on one branch, merged
nowhere, not production-active.**

---

## 9. Behaviour changes, declared

Two, both narrow, both argued rather than smuggled:

1. **`unusable_question_context`** — an outstanding clarification whose question
   text is missing or blank now holds for a human instead of being sent to the
   model as the literal string `"null"`. The honest reading of a question we
   cannot quote is that we cannot judge the answer against it. Same terminal
   state as before, reached deterministically and without a model call.
2. **`divergedFromDecision`** — a committed row that disagrees with the decision
   that produced it is described as committed, flagged, and routed to a human.
   Previously the acknowledgment was composed from the *inputs*, so this case
   could describe something that was not written. Unreachable in the ordinary
   flow; it exists so that if it ever happens, it is visible.

Everything else is a move. Resident wording is byte-identical, cross-checked
against `bf84eb4` rather than asserted from memory.
