# AI Leasing Strategy — Hardened Build Handoff

## Ruling

The feature remains a governed strategy-and-evidence rail. The visible characters are labels only and still have not earned a dedicated module.

## Concern 1 correction — real behavioral separation

V1 described Maya, James, and Claire mostly through tone. V2 defines a testable next-move contract.

| Situation | Maya | James | Claire |
|---|---|---|---|
| Normal turn | Discover one preference | Advance the smallest decision | Resolve material questions |
| Clear intent | Confirm fit, then offer tour | Offer tour now | Confirm constraints, then offer tour |
| Hesitation | Lower commitment | Isolate the blocker | Separate tradeoffs |
| Tour gate | Value delivered | Clear intent | Material questions resolved |
| Follow-up | Gentle contextual reminder | One direct action | Open-items summary |
| Detail | One relevant detail | Minimum needed to advance | Structured complete answer |
| Question | One open preference | Only blocking question | One precision question |

The strategy set is rejected if pairwise operating differences fall below five or if the critical move families converge.

A database deployment gate now requires a passed replay artifact. Source existence is not enough.

## Concern 2 correction — canonical evidence

Assignment is now pinned to the exact leasing opportunity. The Person × Property conversation stays continuous, but the evidence population does not.

```text
leasing_lead
→ initial validated strategy assignment
→ first confirmed delivered attributed message
→ fixed observation window
→ canonical outcomes tied to that leasing_lead
```

Qualification is fail-closed:

- internal QA is excluded;
- prepared, refused, failed, queued, or merely dispatched messages do not qualify;
- no delivered exposure means no denominator entry;
- a still-open observation window means excluded for now;
- applications without direct `leasing_lead_id` lineage receive no strategy credit.

## Honest unsupported outcomes

Current source supports a trustworthy read for replies, booked tours, held tours, submitted applications, human handoffs, and opt-outs.

It does not yet expose a canonical opportunity-linked event for:

- application opened/started;
- accepted lease signature;
- complaint.

Those remain null. The evaluator will not manufacture a zero.

## Remaining proof debt

This build has not run against Postgres. The replay gate has not been fed real model outputs. The evidence SQL has not been reconciled against live records. The patch has not been applied to the repository because GitHub branch creation remains unavailable to this integration. The unified patch parses and its anchors apply against preserved source-context excerpts, but the three modified junction files still require full-checkout syntax and repository-test validation before deployment.

Current claim: **source-complete, structurally hardened, dormant**.
