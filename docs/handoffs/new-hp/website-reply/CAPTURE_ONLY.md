# Explicit capture-only intake — bounded API successor

September 12, 2026. Base live API `b4a494c`, with the independent first-red
checkpoint `6fe956b5cc0c0d519fc3f63af95d40f57b028e2c`. See
[the original witness and separate email gap](FIRST_RED.md).

## Result and scope

The existing authenticated `intakeProspect` owner now treats explicit
`attempt_sms:false` as capture-only. It still captures identity, source touch,
lead event, original website question and thread version. It does not request
the first-response model, insert an outbound text, or emit a prepared-response
event. Its existing receipt reports `response_state=not_required` and
`first_response_sent=false`; prose says the inquiry is saved for staff follow-up.

The response-requested fact is retained on the same canonical capture event.
Replay reads that fact, with no additional capture, drafting or transport.
Historical completion receipts are not rewritten. Existing human/review control
and website-question capture remain in their owners.

This is limited to authenticated intake. The omitted/true attempt flag retains
the existing response-requested mode, including the communications boundary's
consent refusal. The public demo's deliberate prepared-without-dispatch mode is
unchanged in source. The latter is not claimed as a fresh runtime proof here.
No new route, table, migration, provider call, application action or independent
workflow is introduced.

## Verification

`tests/proofs/website_capture_only.db.js`: **26 passed, zero failed** on the
real owned API and PostgreSQL. It covers absent, false and positive consent;
capture-only receipts; exact inbound/source preservation; no model, outbound or
response-event creation; independent staff detail; reordered and conflicting
retry; five simultaneous deliveries; retained human ownership and a new website
question; and the unchanged no-consent default response-requested mode. The
default-mode control reaches only the fake model and is refused by the
communications boundary, with no SMS transport send.

`tests/proofs/website_inquiry_state.db.js`: **42/42 passed**, unchanged. Existing
human/review control, repeated question capture, identity, property/module
authority, Person Card, Ask and lifecycle boundaries remain covered.

All 56 source-governance gates passed. Syntax and diff checks passed. No full CI,
browser, production or external-email capability is claimed. The original witness
still intentionally fails its external-email requirement until that separate gap
is implemented; it is evidence, not a passing CI registration.

The first run of the new focused proof compared PostgreSQL bigint thread versions
directly to JavaScript numbers. Two assertions were corrected to normalize those
observed bigint strings. The passing successor uses that correction; neither
business predicate nor product behavior was changed to accommodate it. The
original independent first red remains unchanged.

## Required CI integration work

Root QB owns runner and shared-test changes. This lane changed only
`src/leasing/leasing_leads.js`, its new focused proof and these receipts.

- Register `tests/proofs/website_capture_only.db.js` in the existing activated
  intake phase.
- `tests/proofs/intake_delivery_idempotency.db.js` currently expects explicit
  capture-only requests to call the model, emit `ai_response_prepared` and create
  one outbound. Change those capture-only assertions to no model,
  `not_required`, zero prepared and zero outbound while preserving identity,
  source-touch, conflict and concurrency checks. Keep the post-capture response
  failure challenge by making that case explicitly response-requested with
  `attempt_sms:true`; its retry must remain `not_established`/null. A worker
  crash after a capture-only commit now truthfully replays `not_required`/false;
  retain a separate response-requested crash control if testing unknown response
  completion too.
- `tests/proofs/availability_uncorroborated_claim.db.js` picker setup around
  line 272 currently expects one model attempt from explicit capture-only
  intake. It must instead require an unchanged model log and retain the later
  no-generation guards. Do not enable SMS merely to satisfy that old assertion.

## Reproduction and cleanup

Use the canonical nonce-owned harness with the real migration chain, existing
property fixtures, activated intake property allowlists, and fake model/SMS
preloads plus egress fence. Run both proofs above and the source governance
runner. Fixture setup precedes business actions; all subsequent SQL in the
focused proof observes results, never rescues them.

Owned schema: 182 applied migrations through boundary 194. Runtime used dedicated
loopback PostgreSQL 55446 and HTTP 3347. Cleanup verified: the nonce-owned database
was dropped, the dedicated cluster stopped, and both ports have no listeners.
No production, shared database, provider or real customer message action occurred.
