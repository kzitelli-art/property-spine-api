# MONEY THINKING — INDEX

**Read this first if you are picking money work back up.**

Money design is **paused**, not abandoned. Nothing here is implemented, and no
money code, table or migration exists anywhere in the repository. The pause is
deliberate: the product-boundary question came before the design questions, and
was reached only after the design work had run ahead of it.

**Status of everything below: EXPLORATORY.** None of it is an owner ruling, an
accounting policy, or an implementation contract.

---

## Start here

| # | document | what it is |
|---|---|---|
| **1** | `MONEY_INTEGRATION_DISCOVERY_QUESTIONS.md` | **The live document.** Ten groups of questions, none answered. Begins with the product boundary, because every other answer depends on it. |

Everything else is prior thinking, kept because it is useful, and kept clearly
labelled so nobody mistakes it for a decision.

## The exploratory work, in the order it was produced

| # | document | what it explored | why keep it |
|---|---|---|---|
| **2** | `MONEY_TRUTH_MAINTENANCE_EXPENSE_VERTICAL_SLICE.md` | one real expense — a water heater — traced from work order to T-12 | the concrete story that surfaced everything else; the inventory of what the maintenance domain already records is accurate and independently useful |
| **3** | `MONEY_TRUTH_OWNER_RULINGS_01.md` *(retitled EXPLORATORY QUESTIONS 01)* | eight product questions with options and effects | the options and their consequences hold regardless of which model wins |
| **4** | `MONEY_TRUTH_CANONICAL_OBJECTS_01.md` *(retitled CANDIDATE OBJECTS — EXPLORATORY)* | seven candidate objects, stopping before recognition | a worked hypothesis of one shape the money layer could take — evaluate it, do not inherit it |
| **5** | `MONEY_TRUTH_ACCOUNTING_QUESTIONS_ARCHIVE.md` | seven accounting-policy areas | **stood down and restored.** A list of what will eventually need asking, not questions we are ready to ask |

## Related, and NOT exploratory — these are findings, not proposals

| document | status |
|---|---|
| `IMMUTABLE_ACTION_AUTHORITY.md` | **frozen finding.** Property Spine records current lifecycle state well and immutable action history unevenly. Independent of the money question. |
| `RECEIPTS_PACKET_FROZEN.md` | **frozen.** One recoverable operation implemented; eleven blocked or withheld, each with a measured reason. |
| `TOUR_LEDGER_VERB_SCHEMA_REPAIR.md` | **frozen brief.** Two schema dependencies, no SQL, no migration number. |
| `MONEY_THESIS.md` | the owner's own strategic document. Predates all of the above. |

---

## What is actually true today

**Real, in the product, unchanged by any of this:**

```
work_orders · work_completion_claims · work_acceptances ·
work_proof_attachments · work_reopenings · work_order_billback_decisions ·
vendors · vendor_property_categories · money_events (0 rows) ·
money_event_attributions · ledger_entries (0 rows) · ledger_claims
```

**Does not exist anywhere:**

```
vendor invoice · service period distinct from spend date ·
expense recognition · vendor payment · credit or reversal ·
financial entitlement · general ledger · chart of accounts ·
period close · T-12 · any money migration
```

---

## The findings most likely to survive whatever gets decided

These came out of the exploratory work but do not depend on it. They are
observations about the existing system, and they would still be true if Spine
never touches accounting at all.

1. **The maintenance domain already records work with unusual rigour** —
   immutable completion claims, separate acceptances, content-hashed evidence,
   supersession lineage, and a resident dispute path authored by the resident.
   It is materially stronger than leasing on exactly the axis a money layer
   would need.

2. **Operational acceptance may not prove final cost.** In the working example,
   work was accepted Monday and the amount was not known until Wednesday.

3. **Invoice date, service date and payment date may differ**, and may fall in
   different months.

4. **Recording and treatment are separable.** Recording a fact — who claimed,
   who confirmed, when, against what, with what evidence — is a different act
   from assigning it an accounting treatment. This is probably the most durable
   idea in the whole exploration, and it would hold even under "Spine is not
   the accounting system."

5. **Property Spine currently lacks clear vendor-invoice, payment and
   expense-recognition authority.** Whether it *should* have them is an open
   product question, not a gap to be filled.

---

## If you are resuming this work

1. Answer the product boundary first —
   `MONEY_INTEGRATION_DISCOVERY_QUESTIONS.md` §1. Several of the exploratory
   documents may become irrelevant depending on the answer, and that is a good
   outcome, not wasted work.
2. Talk to whoever actually does the books before designing anything. Several
   questions in the discovery note are about people rather than schema, on
   purpose.
3. Treat documents 2–5 as **evidence and hypotheses**, never as requirements.
   Re-derive; do not inherit.
4. Nothing money-related can be built until **migration 129** leaves the ledger
   contested — the same wall that blocks the four receipts dependencies. That
   is a hard constraint independent of any design decision.

**No product code. No migration. No implementation plan.**
