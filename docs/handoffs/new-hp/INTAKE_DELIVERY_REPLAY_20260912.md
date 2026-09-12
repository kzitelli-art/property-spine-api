# Authenticated intake delivery replay

Local candidate on API base `992a8db`. No production/provider action, migration or new public route. Prior worker's untracked setup files were preserved, not reused as ownership authority.

## Intention and existing owner

A website relay may redeliver one submission after a timeout. That is one captured inquiry, not another attribution touch or another automatic response. A genuinely different submission by the same person remains another touch on their existing property opportunity.

Migration 038 and `src/leasing/leasing_leads.js` already give `lead_source_touches` attribution custody, `lead_events` the funnel history, and `intakeProspect` the canonical capture path. `source_lead_id` can identify the provider's lead entity across multiple submissions. It was never an exactly-once delivery contract and remains unchanged. Existing tour, agent-run, timezone and communications delivery idempotency records belong to their own domains, not website intake.

The correction stays inside that intake owner. An optional **HTTP `Idempotency-Key` header on authenticated `POST /leasing/intake`** opts into delivery replay protection. The demo path and headerless callers retain their existing behavior. A key in an untrusted JSON body does not activate the feature.

## Contract for the prepared relay

- Keep `source: "Website"`, `attempt_sms: false` as a JSON boolean, and the provider's `source_lead_id` provenance. Supply a stable form/submission identity in `Idempotency-Key`; a random key per retry would name a different delivery.
- Key is 1–256 printable ASCII non-space characters. A supplied blank, whitespace-containing or oversized header returns 400. The new relay should refuse its own missing-key configuration; absence is still allowed for legacy API callers.
- Scope is property + trimmed/lowercased original source label + key, hashed server-side. Two unmapped providers remain distinct even if attribution resolves both into the `Unmapped` source bucket. Different properties remain distinct.
- The entire parsed JSON body is fingerprinted with recursively sorted object keys. Object key order may change; changed contact, message, consent, `attempt_sms` or other payload value under the same key returns 409. Retry the same payload rather than treating a delivery key as an editable lead ID.
- Authentication and property allowlist checks run before replay lookup. The body cannot grant authority, and the key does not bypass the existing property wall.

First keyed success returns the existing fields plus `conversation_id`, `replayed:false`, and `capture:{state:"captured",lead_event_id,response_state}`. Repeat success returns the same durable person/lead/conversation/capture event with `replayed:true`. Response states read existing evidence: `prepared`, `sent`, `not_sent`, `not_required` or `not_established`.

`not_established` means capture committed but automatic-response completion was not recorded. Its `first_response_sent` is **null**, not a false claim of delivery or nondelivery. The receipt directs staff to check the conversation; the retry does not attempt another draft/send. This is deliberately at-most-once automatic continuation after capture, not a new background retry queue or a guarantee that an interrupted automatic response completes.

## Persistence and concurrency

The existing immutable `lead_received.metadata.intake_delivery` carries server-generated key digest, payload fingerprint, original creation flag and whether a response was requested. Original source and repeat-touch flags remain beside it; raw source payload and `source_lead_id` are unchanged. Existing prepared/sent events carry the same digest to establish completion without editing the capture event.

A transaction advisory lock on the namespaced digest serializes initial captures. Under the lock, replay lookup happens before identity resolution, touch, event, consent/classification, model or transport work. The capture event commits atomically with the person/opportunity/conversation. If the process dies after that commit, its durable event remains the replay anchor. A concurrent retry may see capture before the first response finishes and honestly return `not_established`.

No side ledger or migration was needed. This does not claim an indexed high-volume lookup benchmark, database-wide uniqueness for unrelated writers, exactly-once external carrier delivery or repair of old duplicate arrivals. The optional route contract coordinates this existing writer.

## First red and final proof

Fresh full-server HTTP first red on unmodified `992a8db`: two identical authenticated POSTs with one explicit delivery header produced **2 touches, 2 lead_received events, 2 comm_events**. Expected 1/1/1 failed. The old `source_lead_id` was left intact in the reproduction.

`tests/proofs/intake_delivery_idempotency.db.js`: **33/33 local owned HTTP/Postgres checks passed**. Coverage includes:

- Same key and recursively reordered JSON: same identities, one touch/capture/preparation, no second model call.
- Changed contact/attempt-SMS/message conflicts; invalid/blank keys refuse.
- Five concurrent retries: one capture and one comm event.
- A distinct key on the same provider lead creates a genuine second touch; headerless legacy repeats remain unchanged.
- Two original unmapped source labels and two authorized properties preserve separate delivery scopes.
- A response-write fault after capture commits returns 500 initially; retry reads capture, reports unestablished completion and does not regenerate/send.
- `intake_delivery_crash_child.js` executes the **existing authenticated route handlers** against the owned database, then exits 86 immediately after the real capture COMMIT resolves. HTTP retry on the running API proves one capture, zero drafts/model/send and unknown completion. It does not expose another operating route or production fault hook.
- Both observation log paths are required. A uniquely identified synthetic returning-user `/auth/sms/start` send proves this server's fake transport log before the no-send baseline, and the first successful draft increases the model sentinel log. All capture-only requests and conflicts then made zero additional fake SMS calls. The crash child has a 15-second timeout and owned-child termination if its crash hook is missed.

Registered in the existing activated-intake phase of `tests/e2e/verify_all.sh`, after the classification proof. This receipt does not claim the full DB/HTTP suite, browser, remote CI or production acceptance.

Regression: existing `real_intake_classification.db.js` **18/18**, all **56 source-governance gates**, and final harness isolation **8/8** passed. During positive-control setup the schema correctly rejected a direct `properties.sms_number` write, then the communications boundary refused a reply-only line without inbound evidence. The fixture was corrected to the established `communication_lines` owner and explicit synthetic proactive line; no product guard was bypassed or changed.

## Reproduction custody

Run only with `tests/e2e/proof_boundary.js` ownership and the three existing server preloads (transport fence, fake SMS, fake Anthropic). It requires the normal `Skyline E2E` fixture plus the allowlisted inactive property used by the existing real-intake CI phase.

```text
node tests/proofs/intake_delivery_idempotency.db.js
```

HP used a **new** cluster on `127.0.0.1:55444` and API `127.0.0.1:3344`; no other worker's 55441/55442 cluster was touched. Canonical boundary created database `spine_proof_fb0d9e192e2d8c7d9ae3b8e6`, nonce `c212f12e689e1a6006623b57754bcd97`. Real sorted migrations plus existing preconditions produced ceiling 194 / 182 ledger entries. Windows adapter is workspace `tmp/intake-delivery-replay.js`, consumed via stdin from this API worktree after canonical boundary bootstrap. Private runtime path is recorded in workspace `tmp/intake-delivery-runpath.txt`; those files are not production configuration.

Canonical boundary cleanup verified removal of this owned database; its cluster was stopped. The previous worker's untracked files remain untouched. No production/provider traffic occurred.
