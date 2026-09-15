# Maintained leasing knowledge workspace

Owner intention: onboarding is the first fill of maintained property information. Deal onboarding remains the container. Extend the existing property-scoped agent_facts editor and shared reader; no second store or workflow.

## Implementation

API c7f5832 adds a reusable ten-topic question catalog and coverage projection to GET /operator/agent-facts. Unit first red: missing buildCoverage. Successor distinguishes current, expired, retired and missing using the same scoped rows snapshot. Excludes exact-space rows from property coverage; retains legacy fact reads. Current-answer counts are not verified completeness.

App extends its editor with checklist, guided prompts, source/history display, expired-answer correction, unsaved-change protection, read-failure retry and a Leasing-desk entry. Uses existing sealed loader/writers and server authority. Older API without the coverage contract shows a compatibility message. Expiry stops use in conversations; it is not a review reminder. No browser storage or signed-in fixture fallback.

## Fresh verification on September 10

- Coverage and existing knowledge unit tests pass; coverage registered in verify_all.sh.
- Owned PostgreSQL17 migration chain193, full server HTTP/SMS proof passes: coverage states/counts/history, scope isolation, replacement/stale409, expiry, retirement, prospect context and durable fake-provider staff SMS reply.
- Chromium against full server passes: checklist, expired wording, history, unsaved-edit cancellation, save and Ask clickable tour, mobile overflow check, read outage/retry, Leasing-desk entry and sign-out clearing. Desktop/mobile screenshots inspected.
- App authorization35 and live-first safety9 assertions pass. All56 API source-governance gates pass.

Browser proof requires the HTTP proof immediately beforehand for its fresh fixture/session. Repeating against its previously mutated fixture failed the initial retired-state assertion; fresh HTTP setup resolved it. A navigation test initially called renderDesk without opening the workspace; corrected to the real openDesk entry and passed. These were proof setup corrections.

Reproduce with the existing owned boundary setup in QB_INTEGRATION_20260910.md, then API tests/e2e/leasing_knowledge.e2e.js and app leasing_knowledge.browser.js with KNOWLEDGE_API_ROOT=api-qb-integration and the same manifest. Never point this harness at production. No deployment, production writes, real provider send, remote backup or exact-SHA CI claimed.

## Remaining lifecycle and one next action

QB owns the next canonical review-lifecycle slice. agent_facts has active/retired, confirmation, expiry and approval actor, but no draft state, review date, retirement actor/time or replacement link. source_record_id exists but the writer does not bind it; choosing a source type is not document attachment proof.

ai_leasing_operating_rules already owns policies/SOPs/guardrails with immutable replacement and retirement provenance. Do not create competing policy authority in FAQ text. The ten-topic checklist covers descriptive knowledge, not all operating onboarding requirements.

property_team_assignments already owns module access, primary, backup and escalation. These are not a designated knowledge reviewer. obligations owns assigned_user_id/due_at; operator_obligation_actions explicitly distinguishes can_manage_roles from delegation authority. Establish the assignment/approval contract there before adding review tasks, not a parallel owner field or reminder inbox.

Formal deal-onboarding completion, draft approval, review reminders and unanswered-conversation capture remain unimplemented. Current editing permissions remain existing leasing-module access. Temple identity/custody, compatible deployment, source reconciliation and approved content loading remain open.
