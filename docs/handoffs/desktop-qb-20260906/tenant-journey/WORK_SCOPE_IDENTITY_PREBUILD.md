# Work-scope identity pre-build

QB review at dec88db on 2026-09-10: referenced owner files and read entry points verified. This is the next build proposal, not a completed capability. Use `unspecified` for unresolved scope in both old and new records; calling newly captured unresolved work `unspecified_legacy` would misstate its provenance. Preserve all existing conservative unit-readiness gates during the identity extension. A space-specific task may still block certification of the entire unit; do not remove it from that gate merely because its scope is now explicit. A separate bed-ready projection must be independently proved before claiming the sibling can be cleared. The illustrative names and broader desired acceptance outcomes below remain a proposal.

**Inspection receipt:** API `api-fable-review-20260907`, base `48a85ab`; `docs/CURRENT_STATE.md` read on 2026-09-10; philosophy hash unchanged at `977B30A4`. This is a source-only pre-build proposal. No database, provider, runtime, browser, or source-gate proof was run.

## Existing owner path

The smallest vertical slice begins at the existing operator triage door:

- `src/maintenance/unit_triage.js`: `POST /operator/units/:id/triage/propose`, `POST /operator/units/:id/triage/confirm`, and the triage read.
- `src/maintenance/unit_triage_service.js`: `confirmTriage()` writes one confirmation, its findings, and one row per required work in `unit_triage_required_work`. Each work row already has the durable `confirmation_id`, `finding_id`, `property_id`, and `unit_id` relationship.
- `src/maintenance/work_acceptance.js` and `src/maintenance/work_acceptance_service.js`: acceptance, completion claim, reopen, `readWorkState()`, and `readUnitFlow()`. These resolve the work row by `work_id` and retain property/unit authorization.
- `src/surfaces/unit_turn_read.js`: the composed Unit Turn read. It consumes `readUnitTriageState()`, `readUnitFlow()`, each `readWorkState()`, proof metadata, and readiness state.
- `src/maintenance/readiness_service.js` / `readiness.js`: the canonical readiness walk and gate. A completed work item is not itself readiness.

The existing relationship is sufficient for the first extension: the required-work row is the one durable work identity, and all dependent readers inherit its scope through `work_id`. Do not create a second work table or a parallel space-location record.

## Three meanings that must remain distinct

1. **Explicitly unit-wide work.** The operator confirms that the work applies to the whole unit. Its target is `unit_id`; no `space_id` is needed.
2. **Explicitly chosen rentable-space work.** The operator selects a particular rentable position. Its target is `space_id`, with a server-side check that `spaces.id` belongs to the same property and `spaces.unit_id` as the work row.
3. **Legacy unspecified location.** Existing rows lack an explicit scope decision. They remain `unspecified_legacy`; prose such as “repair the bedroom” cannot be used to infer a bed or space, and missing `space_id` cannot silently mean unit-wide.

A nullable `space_id` alone loses the distinction between cases 1 and 3. The one-row recommendation is therefore a scope discriminator on `unit_triage_required_work` (exact names/types remain an implementation decision), with values equivalent to `unit_wide`, `rentable_space`, and `unspecified_legacy`, plus nullable `space_id` only when the value is `rentable_space`. Existing rows must backfill to `unspecified_legacy` unless their source explicitly established unit-wide scope. There must be a constraint preventing `rentable_space` without a valid same-unit space, and preventing a space id on the other two values.

This is an explicit target, not a reverse join from lease aggregation and not a parser over `work_text`. The confirmed finding remains the evidence relationship; it does not become a second scope authority.

## Reader inheritance and boundaries

`work_acceptance_service.readWorkState()` and `readUnitFlow()` should return the stored scope and target as part of the work object. `unit_turn_read.js`, the operator Unit Turn page (`src/surfaces/unit_turn.js`), and proof routes should display/use that same value. Unit-wide work can contribute to the unit readiness gate. Space-specific work must contribute only to the selected rentable space's operational/readiness composition, while the unit-level turn read may summarize that a space-scoped blocker exists. Unspecified legacy work must remain an explicit unknown and must not be treated as either scope.

The browser acceptance path must cover the existing triage capture through the Unit Turn page, work acceptance/completion, and readiness walk. Before completion, the browser must show the chosen target and the unresolved legacy state. Ask Spine must consume the governed Unit Turn/work/readiness projection through its existing reader boundary (`src/agent/ask_spine_answer.js` and `src/agent/ask_spine_service.js`); it must not join raw work text or invent a space target. The Ask answer must distinguish unit-wide, named space, and unspecified work and preserve failed/unknown reads.

Exact rentable identity remains owned by tenancy space readers (`src/tenancy/space_position.js`, `src/tenancy/dated_positions.js`) and canonical availability/turn composition. A unit turn may summarize exact-space contributors, but no reader may infer a bed from a unit number, room label, name, or a lease joined only by `unit_id`.

## Hostile acceptance tests

- A two-bed unit with one explicit space-scoped repair and one unit-wide clean must return both rows with different scope values; the repair cannot block or certify a different bed.
- A work description containing “bedroom” or “Bed B” with no explicit selected `space_id` remains `unspecified_legacy`; it cannot be auto-targeted.
- A legacy row with `space_id = NULL` remains unknown after read, acceptance, completion, and readiness; it cannot be silently backfilled as unit-wide.
- A `space_id` from another property or another unit is rejected at the canonical write and cannot pass acceptance, proof attachment, or readiness.
- Reopening a completed space-scoped work item preserves its target and re-blocks only the governed target composition; a later unit-wide work row does not overwrite it.
- Readiness remains blocked when any applicable required work is unresolved and becomes certified only through the canonical readiness walk. `due_at`, `max(due_at)`, notices, names, or imported occupancy cannot create readiness.
- Ask and browser reads agree with the Unit Turn read for all three scope states, including a failed reader and an unknown legacy row.
- A live canonical possession on sibling Bed A remains visible when Bed B work is read; an imported occupied claim without canonical move-in remains evidence/unresolved and cannot become possession, target scope, or readiness.

This proposal extends the existing required-work owner once. It does not establish a product rule that every current turn is whole-unit, and it does not add a new workflow or scheduling system.
