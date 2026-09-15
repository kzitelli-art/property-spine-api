# SMS outcome reaches the existing Person Card HTTP read

## Mobile history renderer follow-up

App HEADc05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88 plus dirty source. The actual pcLiveHistoryHtml renderer showed the outcome summary but discarded all detail notes. New app/person_card_outcome.browser.test.js reproduced missing original notes in Chromium at390x844 with the actual extracted renderer and stylesheet, using synthetic API-shaped input.

Repair stays in the existing renderer: display notes only for outcome entries, preserve line breaks and wrap long text, escape content with the existing helper, retain legacy detail.note compatibility, and show nothing when notes are absent. No new screen/read/store. Successor browser checks pass, including markup-as-text and no horizontal overflow; existing person_card_signal.test.js24/24 pass.

Proof ceiling: actual component browser rendering with synthetic data plus the separate owned Person Card HTTP proof below. NOT a combined live HTTP/browser session or full-shell navigation. Ask and partial pre-standing visibility remain open. No deployment or live outbound action.

2026-09-09. API HEAD9f2acff97af311e6ebdcd5e2219f8cf873894748 plus dirty candidate. Board/CURRENT_STATE inspected; full prior PHILOSOPHY read retained, unchanged SHA256977B30A4C41B0F8C1511DA3521D030E031AB13B9D1897EEA5970F011F487FC28.

Intent: staff records a tour by SMS; the same attributed outcome must appear in the existing Person Card without re-entry. Existing permanent owner operator.js already projects immutable tour_events, but emits an outcome entry only for metadata.outcome (v2). Current writer records v3 standing and notes separately. This is a missing read branch, not a missing writer or store.

First red owned2d5b2b13: exact SMS clarification flow succeeded, immutable event and conversion assertions passed, authorized Person Card HTTP returned200, but no matching outcome history entry existed. Existing tests/e2e/staff_sms_partial_capture.js extended; its caller supplies the same accepted staff session through the existing api helper.

Repair in src/identity/operator.js: v3 completed event produces one attributed outcome history entry. Uses existing tour_outcome.normalizeStanding and STANDING_LABEL; null/unknown standing remains unresolved. Detail retains event ID, tour ID, recorded notes and judgment attribution. Existing v2 detail fields survive when both forms exist; legacy-only outcomes and correction history retain their existing branches. Human judgment is asserted, not upgraded to proven. No generic read of private pending staff SMS, no new meaning resolver/store, no changes to capture, dates, dispatch or current-stage summaries.

Successor ownedd3cc9d92: same inbound SMS and Person Card HTTP proof passes with exactly one outcome entry containing ready_to_apply, original notes and the same staff actor. Full focused helper passed including replay, preference failure/recovery, prompt scope and no new invitation. Both owned DBs dropped and cluster data removed. Source-governance54 pass after the final source change, sequentially. Same wrapper command/settings as SMS_OUTCOME_NOTES.md, PROOF_STAFF_SMS_PARTIAL=1 and PROOF_TENANT_JOURNEY=1.

Rung: real owned Postgres and authenticated Person Card HTTP, not browser rendering or deployed capability. No claim of new legacy-correction or unknown-standing runtime coverage in this focused fixture; those branches remain source-reviewed. Ask Leasing standing still lacks this recorded tour result. Full phone-only matching, terms/confirmation and partial pre-standing visibility remain open. No deployment, push, migration or live send.
