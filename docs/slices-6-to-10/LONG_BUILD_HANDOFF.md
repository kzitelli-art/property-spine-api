# SLICE 9 — LONG BUILD HANDOFF (decision door → contracts → scale → API freeze)

Halted, as ruled, at the renderer ruling. No renderer built.

## Identity

| | |
|---|---|
| API `main` | `10c43b3` (security-obligations lane) |
| branch | `claude/slice-9-demand-evidence-mcxvav` — see final SHA in git |
| Ask Spine | `ask-spine-slice-1` @ `17c5a68` (7 ahead, NOT landed) · `ask-spine-source-audit` @ `d2f14c5` (landed). Untouched; zero source/migration overlap. |
| migrations | ceiling **128**; 125 staged and untouched; main added none |

## Phase 0 — integration

`origin/main` **merged** into the branch as a whole (no cherry-picks). Merge,
not rebase, stated plainly: rebasing 53 pushed commits and force-pushing would
contradict the standing no-rewrite rulings; the merge integrates the identical
landed tree. The only both-lanes file (`server.js`) auto-merged with zero
conflicts. Obligation authority, property scope, module scope and queue
semantics unchanged — stop condition 5 not triggered. Main's security proofs
pass post-merge on a disposable harness DB (they refuse to run otherwise —
their own guard). Post-merge regression 923/0.

## Phase 1 — the decision door

`GET /operator/obligations/:id/inbound-decision` (reads family) and
`POST /operator/obligations/:id/inbound-decision/resolve` (actions family) —
both inside the routers `server.js` already mounts. Detail contract: obligation
(owner or `UNASSIGNED`, due state, plain instruction), safe person identity,
the exact reply, candidates (opened date · event-derived state · plain close
reason · exact unit), the action descriptor, `blocked_reason`. Dedupe key
parsed server-side only and never exposed — the **temporary adapter**, removal
condition: a governed comm-event reference on the obligation model (no
migration in this cut). Resolution transaction: lock → validate open →
validate lineage → attributed reopen → structured proof → commit. Failed
reopen leaves the decision open with the exact reason. Replay idempotent by the
deterministic reopen key; different-selection-after-resolution is explicitly
stale; the ALREADY-OPEN case resolves with proof and **no duplicate reopen
event**. Proven over real HTTP with real staff sessions: **40/0**.

## Phase 2 — the four frozen metric contracts

`FUNNEL_CONTRACTS` in `metric_contract.js`: every ruled field per funnel, all
four **self-contained** (a proof caught two "same as fN" deferrals and they
were removed), all four referencing ONE frozen source-attribution basis
(`originating_lead_source`, grain lead, counted unit opportunity, never
independently recorded). Shared states `ok · partial · empty · unavailable ·
error`. Mechanical rules in `buildMetric`: rate null under unresolved /
conflicting / untrackable / inherited-attribution pressure with counts kept;
**denominator 0 ⇒ state `empty`, rate null, never 0%**; an empty cohort that
could still grow is `partial`. Contract proof **42/0** including: an empty
property returns `empty` from all four; one pending appointment + one ambiguous
application suppress f1 and f2 consistently; aggregates reconcile
independently.

## Phase 3 — bounded snapshot at scale

Snapshot probes are now **proof-only** (`prove_snapshot`); the production path
keeps the same `REPEATABLE READ, READ ONLY` transaction with zero diagnostic
queries. Production query count: **10 material reads** (9 when a property has
no external tours — bounded conditional, not N+1).

Scale (disposable template DB, set-based fixture, ~12s build): 10,000
in-property opportunities + 100,000 neighbours across 10 properties, 54k tours.
**9 queries · 1.9s · 10,000 rows · 12MB · +34MB heap.** EXPLAIN ANALYZE
BUFFERS: `leasing_conversions` (110k) and `leasing_tours` (54k) INDEX-bounded;
remaining seq scans are on ≤1,500-row tables whose property indexes EXIST — a
correct planner choice, not a missing index (the detector was corrected rather
than the plan). Neighbour property: identical query count, exactly its own
rows, zero leakage. **10/0.** Stop condition 8 not triggered.

## Phase 4 — API freeze

The canonical route stays `GET /operator/pricing/evidence` — no second route.
`market_evidence_v2` adds: `contract` (version + state vocabulary + browser
non-derivation note), `generated_at`, deterministic top-level `state`
(unavailable → error → partial → empty → ok), `coverage` (per-funnel state,
pending/unknown/untrackable counts, suppression reasons, source-attribution
basis). The four frozen contracts ride the response. Proven through the REAL
`server.js` process with real staff sessions: **29/0** — 401 / 403 / server-
derived scope with client property_id refused-by-ignoring / zero cross-property
leakage / ok+partial+empty states / suppression reasons on the wire / stable
as_of / honest empty with no fixture fallback.

## Totals

| suite | result |
|---|---|
| DATABASE_URL regression (18 suites, ×2, clean DB) | **965/0 and 965/0**, zero properties before/after |
| main's obligation security proofs | PASS, PASS |
| inbound decision HTTP | 40/0 |
| evidence HTTP (real server.js) | 29/0 |
| scale | 10/0 |

## Proof classification — honest

| rung | status |
|---|---|
| service proofs | **done** |
| real Postgres | **done** (including 110k-row scale) |
| authenticated HTTP | **done** (decision door via mounted routers; evidence via the real server process) |
| browser verification | **not done** — no renderer exists yet |
| deployment acceptance | **not done** — nothing deployed; the Neon ledger re-query and reservation re-scan still gate any PR/merge |

## Confirmations

No renderer · no deployment · no Slice 10 · no generic analytics framework ·
no second task queue · no inferred opportunity anywhere · Migration 125
untouched · Ask Spine untouched · `server.js` and `src/agent/` untouched by
this cut's edits (server.js changed only by merging main's own landed lane).

## Remaining red baselines / gaps

- None red in the suites above. Funnel 1's source segmentation remains
  lead-keyed inherited context by frozen contract (not a defect — a disclosed
  basis). Historical lifecycle events without exact attribution remain
  `untrackable_from_existing_evidence`, permanently, absent governed correction.
- The temporary inbound-reference adapter (dedupe key) stands until the
  obligation model gains a governed comm-event reference.
