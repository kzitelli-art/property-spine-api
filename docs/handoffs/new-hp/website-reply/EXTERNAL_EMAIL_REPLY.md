# External email reply recording — local successor

September 12, 2026. Isolated branch `codex/external-email-reply-20260912`, based on integration `fd8fe0b72f670cb0e0be55b73930d51a81d61747`. No migration, provider integration, application-invitation change, deployment or production write.

## Intention and existing owners

Staff needs to record an email already sent outside Spine in the same initial website-inquiry conversation. This is not an email-sending feature and not a declaration that the prospect's issue was resolved.

The preceding owned witness on `b4a494c` is retained in the separate `qb-website-reply-20260912` checkout at `docs/handoffs/new-hp/website-reply/FIRST_RED.md`: the real staff `/reply` action returned 409, requiring a verified text number despite an explicit email channel. The inspected `fd8fe0b` reply path retained that same text-only condition. Its takeover action assigned accountable work but did not answer the inquiry.

Current source, relevant CURRENT_STATE entries and the governing philosophy were read before edits (PHILOSOPHY SHA256 `977b30a4c41b0f8c1511da3521d030e031ab13b9d1897eea5970f011f487fc28`, unchanged from the prior complete reading). `leasing_interactions` already owns `comm_events`; migration 048 provides the channel, actor, occurrence, provider identity, obligation link and status-log provenance. `agent` owns takeover and explicit handback. The source shows ordinary replies do not complete the takeover obligation; handback does. QB confirmed retaining this custody contract rather than completing/recreating work for every message.

## Staff command

The same authenticated `POST /operator/leasing/conversations/:conversationId/reply` accepts:

```json
{
  "channel": "email",
  "already_sent": true,
  "body": "The email I already sent externally.",
  "recipient": "prospect@example.invalid",
  "occurred_at": "2026-09-12T12:00:00.000Z",
  "idempotency_key": "stable-staff-recording-key",
  "external_reference": "optional-mailbox-reference"
}
```

The server derives property, person and actor from scoped conversation/session. Recipient must match that person's current recorded email. Active human takeover assigned to the actor is required under the existing state lock and ownership check. The ordinary lifecycle refusal remains. Blank/nonprintable/oversized keys, missing explicit attestation, invalid/future occurrence and mismatched recipient refuse. Body uses the existing 1,500-character limit; optional reference is at most 500 characters. No phone or SMS-consent fact is created.

The writer inserts one `comm_events` email linked to the existing obligation, with `provider=manual` and `provider_status=recorded_external`. The existing `comm_event_status_log.raw` retains the explicit staff claim, recipient, actual occurrence, external reference and actor; its received time is exposed separately as `captured_at`. This is neither a provider callback nor provider-confirmed delivery. No parallel ledger is created.

The existing `(provider, provider_event_id)` uniqueness and locked thread serialize recording. Provider identity namespaces property, conversation, actor and supplied key. Exact retry returns the same event with `replayed:true`; changed body, recipient, occurrence or reference conflicts. Current scope/ownership are checked before replay: a former owner cannot replay after handback. A new key represents another staff assertion; it is not permission for a retrying client to change identity.

HTTP 200 returns `recorded:true`, `replayed`, `dispatched:false`, `provider_delivery:"not_verified"`, `comm_event`, and `external_email_reply` provenance. It never returns a successful send claim. Existing omitted-channel text behavior still delegates `recordOutboundText` and the communications boundary.

## Reads and control

- Conversation messages expose the email with direct `external_email_reply` metadata, actor and occurrence. Agent context includes the same body explicitly labeled as a recorded external email with unverified delivery.
- Person history uses `claim_strength:"asserted"`, an explicit external-email recording verb, recipient/actor provenance and distinct occurrence/capture times. Existing other history entries are unchanged.
- Leasing standing and Ask retain `external_replies` separately from prospect `inquiry_history`. The deterministic website-inquiry answer clearly attributes staff replies and states delivery is unverified. A failed external-reply read is not an empty history claim.
- Queue qualification reads the same explicit ledger marker and exposes a separate `last_manual_reply_at`; it does not fill `last_delivered_outbound_at`. A qualifying manual occurrence can put the conversation in `waiting_on:prospect` with reason `recorded_external_reply_is_latest`; provider delivery remains unknown. An older occurrence cannot answer newer inbound.
- Recording leaves the exact existing `human_thread_reply` in progress and preserves its owner and human-control mode. A later inbound immediately requires staff again under that same custody. Only the existing explicit handback releases control/completes custody; no unrelated obligation or conversation resolution is completed here.

## Proof and cleanup

`tests/proofs/external_email_reply.db.js`: **36/36**, real authenticated HTTP and owned Postgres. Covers unclaimed/other-owner/property refusals; matching recipient and explicit attestation; future/invalid dates and bad key; concurrent capture once; retry/body/time conflicts; exact actor/work; conversation/Person/Ask agreement; separate staff versus prospect claims; foreign Person/Ask nondisclosure; later inbound and stale external occurrence; unchanged custody; explicit handback; and unchanged SMS behavior. An actual owned OTP positive control establishes the fake transport log. External recording/read checks leave both fake SMS/model logs unchanged, followed by an explicit default-SMS positive control through the existing writer/transport.

Existing website inquiry state proof: **42/42**. Existing leasing-standing application-offer unit: passed pending/accepted/legacy/failed cases. Source governance: **56/56**, parent exit 0. Browser and final combined CI belong to QB/staff UI lane and are not claimed here. No mailbox send was observed or attempted.

Windows helper outside Git: `tmp/external-email-runtime.js`, derived from the already verified canonical boundary launcher. Owned PG `127.0.0.1:55447`, HTTP `127.0.0.1:3348`; unique manifest database `spine_proof_3a940b74ae10a0151795fa3f`. Real migration SQL/preconditions produced 182 applied versions through boundary 194. The runner used canonical `serverEnvironment`, fence and fake SMS/model preloads. Commands from the outer workspace: `node tmp/external-email-runtime.js init`, then `run tests/proofs/external_email_reply.db.js` and `run tests/proofs/website_inquiry_state.db.js`.

Initial OTP-control setup lacked a canonical line and refused; an attempted legacy property projection write was correctly refused before change. The fixture was corrected to seed `communication_lines` before operational actions. An initial Ask question without the existing explicit prospect/website routing vocabulary hit the fenced model refusal; the proof uses the established prospect inquiry question, without widening routing. These setup failures are not product pass evidence.

Cleanup succeeded through the nonce boundary: the owned database was dropped; only the dedicated PG 55447 cluster was stopped. No listeners remained on 55447/3348. Original setup files/logs remain outside Git; no other cluster was stopped. No runner registration or CURRENT_STATE edit in this worker lane; QB owns combined integration records and CI registration.
