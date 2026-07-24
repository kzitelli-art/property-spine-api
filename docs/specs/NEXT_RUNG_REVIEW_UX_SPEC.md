# NEXT RUNG — REVIEW UX BACKEND DELTAS
*Captured Jun 10 2026 from Kameron's review-flow spec. The review.html V1 ships
against the existing API tonight; everything below is what the spec asks for
that the backend does NOT yet support. Each is its own smallest-slice build.*

## What V1 (review.html) already delivers with zero backend change
- One-card-at-a-time review, vendor-specific plain-English buttons
- Progress bar / inbox feel ("Item 12 of 43 · $X left to review")
- Batch confirmation prompt ("Apply to all 3 PECO?") → bridge-vendor vs bridge-one
- Learning prompt ("Use this going forward?") → default_category teach
- Typed answers mapped client-side ("electric" → utilities)
- Guardrails: mgmt-co / insurance / bank vendors never offered batch; Virtus
  options route to review/exclude/split set-asides, never auto-post
- Backend language fully hidden
- Full ledger as secondary view

## Deltas that need backend work (in priority order)

### 1. SPLIT ALLOCATIONS — one bank transaction → many accounting lines
The Virtus case. Today money_event_id on bank_transactions is a single uuid;
the bridge is one-txn-one-event. Spec requires e.g. $52,870.29 → payroll
31,000 + mgmt fee 8,000 + R&M 6,500 + admin 7,370.29, with the hard rule that
allocations sum EXACTLY to the bank amount.
Design sketch: allocations live as MULTIPLE money_events sharing provenance
{bank_transaction_id, split_group}; bank_transactions gains a bridged-state
that isn't a single FK (either a join table bank_txn_allocations or
money_event_id becomes nullable + a bridged boolean derived from the join).
Sum-equals-total enforced in the route, gross never net. Unbridge must undo
the whole split group atomically.

### 2. SUBCATEGORIES — "Utilities → Electric"
confirmed_category today is the parent only. Spec wants parent + subcategory
persisted (electric/gas/telecom under utilities; pest/elevator under
contracted_services). Smallest slice: confirmed_subcategory text column on
money_events (app-layer vocabulary per the 007 §1b precedent) + optional
subcategory column on category_report_map later if report lines ever split.
V1 UI shows subcategory labels but only the parent posts — known gap.

### 3. PER-PROPERTY BOOKING PROFILE
vendors.default_category is GLOBAL per vendor. Spec: "how THIS property books
PECO." Wrong the moment two properties share a vendor and book it differently.
Smallest slice: property_vendor_rules (property_id, vendor_id,
default_category, default_subcategory, treatment) with vendors.default_category
as fallback. The learning prompt writes here.

REFINEMENT (Kameron, Jun 10 — the Verizon insight): for some vendors the rule
can't even live at the vendor level. Tower's six Verizon charges are six
amounts ($944.58 / $366.32 / $244.80 / $159 / $119 / $105.11) = six services
(elevator phone, internet, cells…) that may book to DIFFERENT categories.
Confidence belongs at the RECURRING-CHARGE level: vendor + stable-amount
pattern ("Verizon ~$119 monthly") is the learnable unit. Consequences:
(a) booking rules optionally keyed to vendor + amount band + cadence;
(b) the batch prompt ("apply to all N?") is SUPPRESSED for any vendor whose
charges don't cluster on one amount — heterogeneous amounts = heterogeneous
services = review each line. PECO-class (one service, one meter) batches;
Verizon-class never does. Suggestions can grow more confident forever;
confirmation is never removed — confidence changes the ORDERING, never the
CLICKING. No "confirm all suggested" mega-button, ever; one click per
vendor-service per month is the floor.

### 4. NEEDS-REVIEW AS A SERVER STATE
Today "needs review" = the line simply stays unbridged (honest but unlabeled).
Spec wants it as a marked state so the review queue is distinct from the
untouched queue. Smallest slice: review_flag text + review_note on
bank_transactions, set by a tiny route; board splits the queue accordingly.
Owner/affiliate "exclude from operating report" is a treatment in the same
column, not a deletion.

### 5. TYPED-ANSWER MAPPING SERVER-SIDE
Client-side regex map works tonight; long term the lazy-language → structured
mapping belongs server-side (one vocabulary, all clients, auditable).
Candidate: the alias-engine pattern, fourth instance.

### 6. HARD GUARDRAIL LIST AS DATA
Never-silently-auto-post list (omnibus mgmt payments, payroll reimbursements,
affiliate transfers, debt service, deposits, insurance, taxes, CapEx,
intercompany, escrows, large wires, no-vendor-proof) is encoded in the V1 UI.
Belongs in data (vendor_type + amount threshold + category class rules) so the
board, not the page, refuses to propose batching.

## Standing discipline applies
Smallest real slice · propose never silently create · gross never net ·
proven carries its receipt · Rule #11 before touching live shapes.
