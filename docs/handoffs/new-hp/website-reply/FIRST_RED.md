# Website inquiry reply boundaries — owned first red

September 12, 2026. Unmodified live API source
`b4a494c3a2407bb12698ad0c48a61d5c59896b6b`, isolated branch
`codex/website-reply-witness-20260912`. This is synthetic local HTTP/PostgreSQL
evidence, not a production journey or a browser observation.

`tests/proofs/website_reply_first_red.db.js` finished with **12 passing controls
and two first reds**, exit 1. It deliberately asserts the two desired behaviors
and is not registered in the passing CI suite. [Captured output](FIRST_RED.log).

## 1. Capture-only phone inquiry creates an outbound-looking opening message

The authenticated website inquiry supplies email, phone, original question and
`attempt_sms:false`; it supplies no SMS consent field, matching the owner's
description of the current website form. The real intake returns 200 and
`first_response_sent:false`, but `capture.response_state` is `prepared`.

The conversation detail contains the original website inbound and a second
`comm_events` row with `channel=text`, `direction=outbound`, `sender_role=ai`,
`provider_status=null`. There is no actionable `agent_drafts` record. The fake
model sentinel intercepted one generation attempt; no model provider was
contacted. There were zero fake SMS transport sends and no text opt-in write.

The canonical queue remains honest: `waiting_on=manager`,
`bucket_reason_code=website_inquiry_pending_human`, `delivery_state=unknown`,
and no delivered outbound timestamp. This is unnecessary drafting/history
pollution, not evidence that the current queue falsely treats it as answered.

Source: `src/leasing/leasing_leads.js:intakeProspect` initializes
`responseRequested=!!phone`. `attempt_sms` only controls the later transport
branch. The first-response block generates and inserts the text before that
branch. Existing demo documentation intentionally describes preparation without
dispatch, so a correction must preserve unrelated historical/demo contracts.

## 2. An external email reply has no governed staff capture door

The email-only inquiry is captured with its question and reaches staff.
Governed takeover assigns one `human_thread_reply` obligation to the current
staff user. Takeover correctly leaves the question unanswered.

A synthetic staff assertion of an already-sent external email, submitted through
the existing staff reply action with `channel=email`, body, occurrence time and
external reference, returns 409: `This person has no verified text number.`
No reply row is created. Detail and queue still wait on the manager, with the
same in-progress accountable work. No mailbox or messaging provider is used.
This proves the staff door cannot record that assertion; it does not claim an
actual mailbox response was observed by the proof.

### Existing owners and proposed bounded correction, not implemented here

- `src/identity/operator.js` staff `/operator/leasing/conversations/:id/reply`
  derives person/property/actor, checks lifecycle, then requires a phone and
  calls `leasing_interactions.recordOutboundText`. Its extra body fields are
  currently ignored. Keep the existing text dispatch semantics distinct.
- `src/leasing/leasing_interactions.js` owns the unified `comm_events` ledger.
  It has text and call writers and a channel-inclusive `readThread`, but no
  external-email writer. Migration 048 already supplies email-capable channel,
  actor, occurrence time, provider provenance, idempotency and obligation fields.
  Extend this owner with an explicit external-email record action, using a
  scoped staff-session adapter and server-derived person/property/recipient and
  actor. Retain the actual occurrence time separately from capture time and a
  namespaced idempotency key with payload-conflict refusal. No application,
  conversion or invitation action should be involved.
- A staff declaration of an external send is recorded evidence from that staff
  member. It must not be stamped as provider-confirmed delivery. Use an explicit
  manual provenance/status and receipt rather than reusing `sent`/`delivered`
  to trick the current projection. Include retained recipient/source reference
  without overloading an unrelated application field.
- `src/identity/operator.js:PROJECTION_CTE` currently qualifies an answered
  outbound only when `provider_status in ('sent','delivered')`. Define a shared
  qualifying reply predicate that can also recognize that explicit, attributed
  external-email event while keeping provider delivery a separate fact. An
  older email occurrence must not answer a newer inbound. Capture is not proof
  that the question was substantively resolved.
- `src/agent/agent.js:getConversationStateService` and its two conversation
  context queries filter to `channel in ('text','website')`. Email capture
  requires connecting the same canonical event to these reads and verifying
  entitled Ask/Person Card agreement. A writer-only change would hide the reply.
- `takeOverConversationService` and `handBackConversationService` own the
  linked human work and AI-control transition. Recording external email must
  not silently return the conversation to AI or complete unrelated work.
  Keep the assigned owner unless an explicit governed action changes it.

The expected staff flow is: open the actual inquiry, record the email they
already sent, read its attributed receipt in the same thread. Phone presence
and text consent should not be prerequisites for recording an email. Direct
email sending/integration is outside this proposal.

## Isolation and limitations

All staff/source fixtures were created before prospect actions. Thereafter SQL
only observed state; every inquiry, takeover and reply attempt used HTTP. The
canonical nonce-owned boundary and egress fence were active, with fake SMS and
model preloads. Schema: 182 applied migrations through boundary 194. The first
bootstrap attempt targeted the wrong local port and was refused before database
creation; the dedicated cluster was restarted explicitly on loopback 55446.
The successful witness used that port and HTTP 3347 only.

Cleanup verified: the nonce-owned database was dropped, the dedicated cluster
stopped, and 55446/3347 have no listeners. No production/provider/shared database
action or real customer message occurred. No product source changed in this
first-red checkpoint; no passing CI or UI result is claimed.
