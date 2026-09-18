# SMS original feedback survives outcome clarification

## Follow-up: immutable event notes, 2026-09-09

The v3 history omission below is now repaired in the existing completeTour writer. It records feedback.notes as metadata.notes on the completed tour event regardless of whether v2 outcome fields were supplied. Existing v2 outcome, standing, actor and conversion projection remain intact; no historical rows are backfilled.

First red owned39f34645: completed conversion held the text but immutable tour event did not. Successor ownedf7dcb69a passed the same real HTTP flow and a database assertion that exactly one completed event retains original notes, ready_to_apply standing and the original staff actor. Both databases dropped and cluster data removed. All54 source-governance gates passed sequentially before the successor. Source changed: src/leasing/leasing_leads.js; assertion added to existing tests/e2e/staff_sms_partial_capture.js. Same API HEAD and philosophy hash below.

Worker sms_reader_trace completed read-only review. Person Card emits outcome entries only from legacy metadata.outcome; Leasing standing reads conversion id/current_stage only. Their v3 standing/notes exposure remains OPEN. Do not expose private pending staff-thread text via broad property-only reads. This checkpoint proves historical capture, not Person Card/Ask rendering or full phone-only application completion.

2026-09-09. API HEAD 9f2acff97af311e6ebdcd5e2219f8cf873894748 plus working changes. CURRENT_STATE and board inspected; complete prior PHILOSOPHY read retained, unchanged SHA256 977B30A4C41B0F8C1511DA3521D030E031AB13B9D1897EEA5970F011F487FC28.

Intent: after staff texts the owner acceptance sentence and then replies Ready to Apply, the completed outcome must retain the original feedback, not just the standing. Existing permanent owner completeTour already accepts feedback.notes and writes conversion.tour_notes. The SMS caller omitted that input. Preserve this owner; do not add another notes store or complete a partial tour early.

Correction after further source inspection: the original receipt also claimed an event note. That only holds for v2 outcomes; v3 standing-only captures set metadata.outcome to null, so their notes do not reach that immutable event field. The conversion assertion and HTTP result remain valid. Event-note history and Person Card v3 rendering are separate open seams, now being traced before any further repair.

First red: extended tests/e2e/staff_sms_partial_capture.js to read the resulting conversion and require its tour_notes to equal the original inbound body. Real owned Postgres/HTTP run 41053307 failed precisely that assertion after 27 prerequisite checks. Database dropped and cluster data removed.

Repair: staff_sms_action passes matchedPrompt.original_body into the existing feedback.notes field; without a prompt continuation it passes the current body. Existing prompt scope/lock, raw message history and standing semantics remain intact. No reinterpretation of feedback as readiness.

Successor: owned run 1f083a03 passed STAFF_SMS_PARTIAL_HTTP_PASSED, including preferences, write-failure recovery, prompt scope, replay, original send intent and zero new application invitations. Owned database dropped and cluster data removed. All 54 source-governance gates passed before this successor, sequentially without active server proof or edits.

Command: tests/e2e/onboarding_review_local.ps1 with PROOF_STAFF_SMS_PARTIAL=1, PROOF_TENANT_JOURNEY=1, ONBOARDING_SPACE_PROOF_ONLY=1 and the established private workbook/app/Postgres/Chrome inputs. No whole-wrapper stdout redirection: an earlier redirected launch stalled after cluster start, was stopped, and supplied no product proof. Its private stopped cluster data remains retained because manual cleanup was rejected by tool policy. No shared database or live provider was used.

Rung: real owned DB + inbound HTTP, providers fenced; conversion notes verified by database read. Not browser or Person Card/Ask rendering proof, not deployment, and not full phone-only terms/application completion. Original partial feedback visibility before standing, home matching, complete phone terms and confirmation remain open.
