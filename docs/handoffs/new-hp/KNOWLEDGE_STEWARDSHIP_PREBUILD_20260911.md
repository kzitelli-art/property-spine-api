# Knowledge stewardship: pre-build receipt

Read-only investigation on API 24f4482140bed554185fe4fdcbb7c2366a5d3c07, paired released app b00cf4993e4f699cd174a7ef5c8a27ca4b5507c4. No product changes, database/provider actions, publication or deployment. Isolated branch codex/knowledge-stewardship-20260911.

## Intention and present mechanism

Designated staff keep descriptive property answers current inside Spine; the editor, Ask Spine and prospect conversations read the same approved record. Accountability for future upkeep must remain distinct from the human who confirmed a prior answer.

- `src/identity/operator.js:482` reads agent_facts and the canonical coverage projection. Lines 535, 551 and 570 expose create, retire and replace. All require a resolved staff session and leasing-module access. Creation/replacement writes approved_by_user_id from that session and immediately publishes active wording. This is not a draft/approval queue.
- `migrations/053_agent_supervised_drafts.sql:111` owns facts, confirmation, expiry, source record field and approval actor. Its fact status is active/retired. Unique indexes protect one active property/key or property/space/key. Prior wording survives replacement. No review obligation or review schedule is represented there.
- `src/leasing/leasing_knowledge.js:39` projects current/missing/expired/retired. Expiry removes the answer from current reads; the returned note explicitly says confirmation and expiry are not a review schedule. owner_notice in the checklist is explanatory domain-boundary guidance, not an assigned human.
- `src/leasing/ai_leasing_operating_context.js` and migration121 own actual policies, SOPs and guardrails with immutable replacement/retirement provenance. `src/identity/operator.js:310` separately requires can_manage_roles for those writes. Descriptive knowledge must not become a second policy authority.
- `src/identity/staff_session_service.js` derives current allowed_modules and primary_for_modules from active property assignment. Neither proves a designated knowledge reviewer.

## Existing work creation versus assignment

`src/shared/obligation_engine.js:43` exports spawnObligationFromEvent. It accepts related_type/id, due_at, assigned_user_id, owner_eligibility_state and a dedupe key. It is an internal primitive, not a generic operator creation or delegation authorization check. Domain callers must establish the event and eligible owner before calling it. Initial assignment is possible at birth when a domain has that contract; the leasing conversion rail already does this for its own work.

No generic authenticated operator route to create arbitrary review work was found. `src/baseline/baseline_routes.js:427` deliberately explains event-derived creation rather than direct obligation insertion. Existing domain-specific creation routes cannot truthfully be used to manufacture a leasing-knowledge event.

`POST /operator/obligations/:id/claim` in `src/obligations/operator_obligation_actions.js:75` can claim an EXISTING obligation as the signed-in user, scoped to that user's property and allowed modules. It refuses another client actor, and returns409 rather than stealing another user's work. This is initial self-claim of unowned existing work, not task creation, designation of another reviewer, or reassignment.

The same module explicitly records why manager delegation was not built: can_manage_roles governs role administration; the internal reassignObligation function reassigns by ROLE for money callers, not arbitrary operator delegation. Therefore a role administrator is not automatically entitled to assign Mike review work.

The model tool create_staff_obligation still has a handler in `src/agent/agent.js:1572`, but activeTools at1376 excludes it. Its historical operational-escalation path is dormant and role-only, not a current operator-facing review creation route. Do not reactivate it as a shortcut.

## History, run and stop

The September10 KNOWLEDGE_WORKSPACE receipt already identified this authority boundary. Current source confirms it. Migration053 deliberately curated facts without a new task system; migration121 preserved that fact owner alongside governed rules. Obligation actions document the retirement of body-supplied user assignment after the old shared-key path allowed impersonation.

Fresh local runs on September11 both pass:

```
node tests/unit/leasing_knowledge_coverage.test.js
node tests/unit/leasing_knowledge.test.js
```

Used bundled Node with NODE_PATH pointing to the existing api-leasing-knowledge/node_modules. These exercise coverage/expiry/history and shared Ask/SMS routing, scoped reads, entitlement, media references and failure behavior. A direct coverage call with an expired photo answer returned expired, current:null and preserved prior approver; it projected no review assignee or due date. This is an observed read contract, not a full-server failure or evidence that the prior approver owns renewal.

Last green: existing maintenance of approved answers and expiry reads. No runnable designated-review caller exists to fail. Classification: descriptive maintenance is implemented; knowledge-specific responsibility and review scheduling are unestablished product/authority contracts. This is not a broken caller to reconnect.

## Smallest decision before implementation

Specify the narrow knowledge-review assignment contract: which existing actor may request a review, whether the reviewer self-claims or may be explicitly designated by another entitled actor, and what recorded event/date creates the review obligation. Keep direct publication under current leasing access unless a separate approval requirement is deliberately chosen. A review request must retain the exact fact/version or topic being reviewed and its explicit due date, if supplied; expiry is not that date.

Once ruled, use one domain event through the existing obligation engine, current property/module eligibility, and the existing queue/Ask reads. Completion must refer to the reviewed or successor fact and preserve attribution. A new general delegation system, knowledge-owner column, parallel review inbox, automatic expiry reminders, inferred primary/approver ownership, and silent publication-permission changes are forbidden second paths for this bounded slice.

QB owns the next product ruling and CURRENT_STATE promotion. This receipt does not claim HTTP/browser or production proof for a new stewardship workflow.
