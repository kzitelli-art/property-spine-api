# Website questions reach the existing conversation

QB successor to API 78efb93 (data-only preparation after deployed d45d768), paired with app 5d6a10d plus the website-inquiry UI change. Local proof receipt; exact CI and deployment belong in the workspace release receipt.

## First observed failure

An authenticated, email-only website submission stored its question in the lead and source touch, but created no communication. A distinct follow-up was retained only in source-touch provenance. Staff could see and claim the conversation while both questions were absent from conversation detail, Person Card and Ask's canonical gathered facts. The owned baseline witness reported 28/28 in explicit absence mode on unchanged 78efb93. This was an absence witness, not successful functionality. Its initial combined-text absence assertion was strengthened in the successor proof to check each question separately.

## Smallest shared mechanism

Authenticated website intake records each nonempty submitted message as an inbound `comm_events` row through the capture mechanism extracted from the existing SMS agent. The immutable lead event links it to the arrival; the source-touch ID preserves provider provenance. Header replay still returns before mutation. Blank questions stay raw capture provenance and do not invent messages.

The shared writer locks the existing thread, advances its version once, supersedes stale ready drafts and preserves control mode and accountable work. It delegates lifecycle interpretation to the existing owner; a lifetime conversation does not select a closed conversion. It neither selects a home nor creates consent. Existing staff-controlled/review/paused/closed modes suppress the intake opener, including phone-bearing repeated forms.

Conversation detail, Person Card history, agent context and entitled Ask read the same communication owner. Ask's deterministic website-inquiry answer shows recorded prospect words with source/time and bounded-history/truncation indicators; those words are not verified property facts. Property and Leasing entitlement remain server-derived. No historical backfill occurs.

Queue projection marks a website inquiry for staff when no current agent run or ready draft handles its version. The app uses that reason, displays website message labels, and shows recorded email contact with no SMS composer when the canonical person has no text number. Explicit takeover remains the way to become accountable. No email-sending workflow is introduced.

## Local evidence

- `website_inquiry_visibility.db.js`: 29/29 real owned HTTP/DB; first and repeat capture, exact replay/conflict, staff claim, detail, Person Card, actual Ask HTTP and gathered facts. Owned OTP positive control validates the fake transport observer before checking no sends.
- `website_inquiry_state.db.js`: 42/42 real owned HTTP/DB; source links, version/replay, draft supersession, human ownership, phone-bearing repeated capture with no model/SMS, awaiting-review supersession and consistent queue/detail, blank messages, entitlement and foreign-property refusal. Historical draft/assignment rows are pre-action fixtures; draft generation is not claimed.
- Existing intake delivery replay: 33/33 after updating expected communications to distinguish the new inbound capture from outbound response. Failure trigger still fails outbound persistence after capture; incomplete delivery remains unknown.
- Existing real inquiry classification: 18/18. Existing prospect confirmation: 12 real agent/DB controls, scripted model; not HTTP or provider proof.
- Actual sibling app in Chromium against the owned API: 16/16. Both website questions and staff attention visible, email-only composer unavailable, takeover persists work, exact-slot booking commits before simulated lost response, same-key UI retry creates only one tour, staff Ask retains work. Screenshot reviewed; no browser errors.
- Four focused app test files pass, including 22 conversation-board assertions. Five focused API Ask/application/economics/standing/tour-schedule test files pass. All 56 source-governance gates passed on the final source. The nonce-owned database was dropped and cleanup verified.

Owned runtime is loopback, provider/model transport fenced and synthetic, schema ceiling 194. No production lead, real message, migration, live-user acceptance, website relay activation or content publication is implied. The six Greenery content cards at 78efb93 remain source-attributed drafts; full CI 34665197557 passed that exact data/docs commit.

## Reproduction

Read `docs/DB_HARNESS_ISOLATION.md`. The two new DB proofs are registered in the existing activated-intake phase of `tests/e2e/verify_all.sh`. Use the canonical nonce-owned proof boundary and transport/model fences. The browser proof is `tests/e2e/staff_conversation_tour.browser.js`, with `E2E_APP_ROOT` naming the paired sibling app. Never point these proofs at shared or production data.
