# MONEY INTEGRATION — DISCOVERY QUESTIONS

**Purpose: to help think, not to decide.** These are the questions that come
before any money design. None of them is answered here, and no model is
recommended.

Everything previously produced under "Money Truth" is **exploratory** and has
been reclassified as such. Nothing in it is a requirement.

**What is real today, and unchanged by any of this:** work orders, completion
claims, work acceptances, proof attachments, billback decisions, vendors,
`money_events`, `ledger_entries`. Everything beyond those is under
consideration.

---

## 1. Product boundary

The first question, because every other answer depends on it.

- What role should Property Spine play in accounting? Is it the accounting
  system, an operational subledger, a source-of-truth layer feeding another
  system, a reconciliation and reporting layer, or some combination?
- If it is not the accounting system, what is the *smallest* useful role it
  could play, and would that role alone be worth building?
- Is there a version where Spine never holds a monetary amount at all, and
  only supplies the operational facts another system needs?
- Which of these roles would Kameron actually want to be responsible for
  operationally — and which would he rather someone else own?
- Where should the boundary sit between "what happened at the property" and
  "what it means financially"? Does that boundary move as the portfolio grows?
- What would make Spine's money layer worth trusting more than the tool it
  would sit beside?

## 2. Existing accounting-system relationship

- What accounting platform is in use today, and by whom?
- Who currently does the books — the operator, a bookkeeper, an outside firm,
  a fractional controller?
- What is that person's month actually like? Where does their time go?
- Which system is authoritative today when two disagree?
- What does Spine currently duplicate, and what does it uniquely hold?
- If Spine produced a number that disagreed with the accounting platform,
  which would be believed, and who would adjudicate?
- Is there an appetite to replace the existing platform, or only to feed it
  better?
- What integrations already exist or would be expected — file export, API,
  manual re-entry?

## 3. Revenue flow

- Where does rent revenue currently get recorded, and by whom?
- Does Spine already know enough to state what was billed, versus what was
  collected, versus what is owed?
- `ledger_entries` is resident-side and currently empty. Was it intended for
  this, and what became of that intention?
- How are concessions, prorations, late fees and credits handled today?
- Is delinquency an operational question, a financial one, or both?
- Where does the money physically arrive, and does Spine see it?
- Should Spine ever originate a resident charge, or only observe one?

## 4. Expense flow

- Who enters property expenses today, and into what?
- How does a vendor invoice reach the person who records it?
- How much of an operator's expense volume is vendor invoices versus cards,
  reimbursements, recurring bills and owner draws?
- `money_events` exists and is empty. What was it for, and why was it not used?
- Does anyone currently connect an expense back to the work that caused it?
  Would that be valuable, or is it detail nobody asks for?
- What expense questions does an operator ask that they currently cannot
  answer?

## 5. Cash versus accrual

- Which basis does the operator actually use today?
- Which basis do their lenders and investors ask for?
- Are both needed, or is one a nice-to-have?
- If both, must they reconcile to each other, and who would notice if they
  did not?
- How is the difference explained today, if at all?
- Would an operator recognize an accrual view as more true, or as more
  confusing?

## 6. Vendor and invoice handling

- Where do vendor invoices originate — email, paper, a portal, a text message
  photo?
- Does a vendor ever interact with a system, or only with a person?
- Who verifies that an invoice matches the work performed? Does that happen
  today at all?
- What happens now when an invoice does not match the estimate?
- Are duplicate invoices a real problem in practice, or a theoretical one?
- Would vendors tolerate submitting through a system, or is staff capture the
  only realistic path?
- How much does the operator care about vendor-level history and spend?

## 7. Payment handling

- Do payments happen inside any system today, or through a bank portal?
- Should payment ever happen inside Spine, or should Spine only ever know that
  a payment occurred?
- Who authorizes payment today, and is that the same person who approves the
  work?
- How does a bank transaction currently get matched to what it paid for — and
  by whom?
- What would go wrong if Spine knew about payments but could not make them?
- Is there a compliance, banking or trust-accounting constraint that decides
  this for us?

## 8. Corrections and period close

- Does the operator close the books, formally or informally?
- What happens today when something is discovered after a month is reported?
- Has a number ever had to be restated after it went to a lender? What did
  that cost?
- Who would be allowed to change a reported figure?
- Is there a sign-off moment today, or does the month simply pass?
- How much correction volume is realistic — is this an edge case or a weekly
  occurrence?

## 9. Reporting outputs

- What reports are produced today, by whom, and how long do they take?
- What is actually sent to lenders and investors, and how often?
- What does a lender ask for that is hardest to produce?
- Which numbers get questioned most often?
- Is the value in producing the report faster, or in the report being more
  trustworthy?
- What would an operator stop doing if Spine produced this well?

## 10. Institutional customer expectations

- How do institutional operators close their books today?
- What do they expect a property system to do versus their accounting system?
- What would disqualify Spine in an institutional evaluation?
- Which of them would tolerate a partial money layer, and which need
  completeness before they will look?
- Is the buyer the operator, the owner, the asset manager, or the accountant —
  and do they want different things?
- What does an auditor need to see, and has anyone asked one?

---

## Observations carried forward

Findings from the exploratory work that seem worth keeping regardless of where
the design lands. **None of these is a ruling.**

- Operational acceptance **may not** prove final cost. In the working example,
  work was accepted on Monday and the amount was not known until Wednesday.
- Invoice date, service date and payment date **may** differ, and **may** fall
  in different months.
- Operational records **may need** durable actor, property, object, date and
  evidence lineage **if** financial reporting later relies on them. The
  maintenance domain already has much of this; other domains have less.
- Property Spine currently lacks clear vendor-invoice, payment and
  expense-recognition authority. Whether it should have them is an open
  product question.
- Cash and accrual reporting **may need** different reads over related
  underlying facts — which **would** be a design constraint if both views are
  wanted.

## What stays frozen and useful regardless

The receipts and authority findings are **independent of the money question**
and remain valid whatever is decided here:

- server-derived actor and property on every active staff write
- the `operation_receipt_v1` contract and the one implemented recoverable
  operation
- the four schema dependencies in `RECEIPTS_PACKET_FROZEN.md`
- the immutable-action-authority finding: this system records current
  lifecycle state well and immutable action history unevenly

Those hold whether Spine becomes an accounting system, a subledger, a feed, or
none of the above.

---

**No product code. No migration. No implementation plan. No recommended model.
No Slice 10 changes.**
