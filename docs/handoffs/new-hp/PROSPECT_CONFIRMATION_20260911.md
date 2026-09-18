# Historical prospect confirmation correction — September 11

Baseline: API `24f4482140bed554185fe4fdcbb7c2366a5d3c07`, isolated branch `codex/exact-home-selection-20260911`. No app change, schema change, push or deployment.

## Existing mechanism first

Intention: a prospect's actual choice can become durable property-scoped interest; mentioning, questioning or rejecting a home must not select it. Unit interest is not a reservation, exact-bed assignment or agreement to commercial terms.

Current mechanism: `agent.processInbound` loads the latest dispatched offered set and calls `leasing_inventory.matchConfirmationToOffer`, then `attachSelectedUnit`. The attachment updates the existing `leasing_leads.unit_id`. Migration 038 defines the lead as a property/unit interest, not a commercial commitment. Existing source preserves previous interest with coalesce. This legacy path remains reachable against historical dispatched offers without `selection_eligible:false`.

History: `docs/archive/PROSPECT_INVENTORY_CUTOVER.md` preserved the attachment while replacing date-blind inventory. The September 9 date connection and September 10 matching successor deliberately disabled selection on new informational exact-space results. `PROSPECT_MATCHING_FIRST_RED.md` explicitly forbids re-enabling them against the unit-only writer. That containment survives.

Observed stop: the real agent service, using uniquely owned Postgres, attached unit 101 for `not 101`, `101 or 102?`, `is 101 available?`, `I do not want 101`, and `yes, but not 101`. Five negative cases failed; explicit `I will take 101` and `101` and ambiguous two-offer `yes` were positive controls.

Smallest correction: the existing matcher now requires one unambiguous label/affirmative choice and refuses negative, conditional, comparative and question replies. A single bare affirmative remains eligible only as the whole reply against one historical unit offer; the existing agent freshness check remains in place. Multiple labels and duplicate label identities refuse. Any space-bearing offer refuses, even if incorrectly marked selectable, because this writer cannot preserve space identity. Unrecognized language stays in conversation and needs clarification.

Forbidden second path: no selection table, new workflow or parallel terms store. Existing `lease_offers` / `prepareApplicationOffer` already own exact-space complete terms, identity, authority, immutable snapshots and app/Ask reads. Authorized negotiated/manual rent is deliberate; this change does not impose published-price equality.

## Fresh local evidence

- Deterministic first red reproduced before modification; real agent/DB first red: 5 false attachments across the original 8 cases.
- Successor: 12 real agent-service/Postgres cases, including one-offer yes, multiple-label refusal, question without question mark, and stale space-bearing offers explicitly marked `selection_eligible:true`.
- 42 focused matcher unit controls; existing prospect matching and inventory date unit suites pass.
- All 56 configured source-governance gates pass, parent exit 0. New focused unit/DB proofs were invoked explicitly; they are not yet registered in CI orchestration.
- `git diff --check` passes.
- Owned PostgreSQL 17: loopback port 55441, database `spine_proof_2de22b4a6c8ade45608aa82c`, nonce `82fcc85502f4623ecdde30b12e653d92`, migration ceiling 194 / 182 ledger entries. Real migration SQL and checked-in preconditions applied using a local PowerShell/psql adapter. Fixtures included historical outbound rows; no provider dispatch was invoked.
- Owned database drop verified by `proof_boundary`; the lane's own cluster stopped. No HTTP server started and no provider egress attempted.

Logs remain outside Git in workspace `tmp/selection-first-red.log`, `tmp/selection-successor.log`, `tmp/selection-gates.log`.

## Limits and continuation

This repairs historical unit confirmation. It does **not** complete durable exact-home selection, published-price binding, readiness planning, staff browser flow, real HTTP or production/provider acceptance. New exact-space matching remains informational. The existing attachment's legacy vacancy predicate and its lack of immutable selection provenance are unchanged; do not treat it as exact-space/current-term commercial authority.

Next coherent vertical slice: carry an explicitly chosen informational match into the existing staff terms review and `prepareApplicationOffer`, with a visible distinction between published-price provenance and authorized negotiated terms. Preserve current target revalidation and applicant terms review. Do not infer deposit/fees, a pricing term from dates, or exact bed identity from a unit number.

Proposed CURRENT_STATE entry for QB: September 11 historical unit confirmation first red reproduced five false durable attachments through real agent/owned DB. Existing matcher corrected; 42 units and 12 agent/DB cases pass, owned runtime cleaned. Exact-space informational candidates remain disabled; no new selection owner, schema or deployment. See this receipt.
