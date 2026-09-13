# Two-step attribution and recovery review

Candidate based on de9c3a50c6b015a18b6cf1cb58345052b275f840. This receipt is local source/unit evidence; the supplied database proofs have not been run by this worker. QB owns the nonce database and integration.

## Correction

The existing application review called the preparation actor a terms confirmer. The standing reader also selected the newest confirmation by application rather than the application's current pointer. The shared `readCurrentTermsConfirmation` now reads the scoped current pointer and retained offer authorship. Derived preparation returns null `confirmed_by`/`confirmed_at`, separate `prepared_by`/`prepared_at`, and `offer_author` from the original retained authority snapshot. Legacy human confirmation keeps its original confirmer fields. Missing pointed history is an explicit read failure; no newest-record fallback is allowed.

Application review and leasing standing consume the same reader. Person Card (`src/identity/operator.js`) and Ask Spine (`src/agent/ask_spine_answer.js`) already compose leasing standing, so they receive this attribution without a parallel record. This does not relabel the persisted historical row or change action authority. An original authored decision is retained history; later revocation of the author's role is not itself a reason to erase that decision. Current actors still pass the existing writer privileges; this patch does not alter them.

`application_review.execution_decision` is null unless the current non-superseded packet has an actual `executed_by_decision` audit. Otherwise it returns `{packet_id,event_id,actor_user_id,at,application_decision,decisions}`. It does not infer execution from an acknowledged offer or preparation record. Already-approved attribution is preserved exactly as the audit records it.

## Evidence and root-run commands

The new attribution unit failed before implementation because the canonical current-record reader was absent. Successors pass: `terms_confirmation_attribution.test.js`, `execution_decision_read.test.js`, and existing `application_review_offer.test.js` and `leasing_standing_application_offer.test.js`. Both new proof scripts pass Node syntax checking. No database or provider calls were made by this worker; no owned database needs cleanup here.

After the owned two-step journey has retained distinct author/preparer actors, with its existing `E2E_PROOF_MANIFEST` and proof log environment:

```text
node tests/proofs/two_step_attribution_read.db.js
```

The proof uses canonical review and standing readers in a real read-only transaction, demands current derived attribution, refuses swallowed standing read failures, and compares current-packet execution to its actual audit. It makes no fixture writes.

For migration compatibility, run the following separately on canonically prepared owned 194 and 195 manifests. Set `PROOF_EXPECTED_CEILING` to the actual fixture ceiling and `MIGRATION_BASELINE_ROOT` to the pre-195 checkout. No fixture or ledger is changed by the script:

```text
node tests/proofs/two_step_migration_recovery.db.js
```

It invokes each checkout's actual `migrations/migrate.js` with read-only session defaults: at 194, baseline must verify and candidate must refuse pending 195; at 195, candidate must verify and baseline must refuse the ledger version missing from its repository. It also verifies the ledger is unchanged. These expected outcomes remain unrun until QB executes them.

## Rollout and recovery boundary

Migration 195 adds allowed authored-offer source/authority values and requires offer identity/hash for the derived source; it does not replace existing rows. The actual prestart verifier checks both ledger-to-file and file-to-ledger membership. Therefore an ordinary restart of a pre-195 artifact after migration 195 is expected to refuse startup. Do not delete the ledger row or derived histories to make rollback start.

A recovery artifact must carry migration 195 and preserve the two-step resident submission and submitted packet issuance compatibility, as well as truthful attribution and current actor checks. Merely appending the migration file to old code is not sufficient to preserve outstanding two-step resident links. The cheapest safe recovery is a reviewed forward-compatible artifact retaining those branches, or a forward correction on this candidate; deployment and recovery acceptance remain QB-owned and pending.
