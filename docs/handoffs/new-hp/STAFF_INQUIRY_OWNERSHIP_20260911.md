# Website inquiry → accountable staff work

September 11, 2026. Isolated `codex/staff-intake-acceptance-20260911`, based on integration `385a9ded37b5468a385bcf546b66dbfaafd69047`, with the already-reviewed intake CI registration `6f4a3b9` replayed as `ab63d69`. No migration, provider configuration, external message, push or deployment in this lane.

## First observed failures

An authenticated, property-bound, consent-free `POST /leasing/intake` creates a person, opportunity and conversation and records its prepared opening without dispatch. The existing signed-in staff detail is `GET /operator/leasing/conversations/:id`; the existing takeover action is `POST /operator/conversations/:id/take-over`.

On the baseline, Mike's real scoped session received takeover HTTP200 with `by: <Mike user id>`. The stored thread only became `human_takeover`: `current_review_obligation_id` was null. Two independently issued, property-scoped staff sessions read exactly the same human mode with no persisted owner. A mode is not a named accountable actor. Source and initial real HTTP evidence are in workspace `tmp/staff-intake-first-red.log`.

After connecting the existing obligation owner, the canonical scoped work collection correctly contained the assigned item, but real HTTP Ask Spine `What needs my attention?` omitted it. The shared obligation reader's attention methods forced `status='open'`; the canonical self-claim convention advances open work to `in_progress`. The failure is retained in `tmp/staff-takeover-ask-first-red.log`.

## Existing owners, smallest corrections

`src/agent/agent.js` keeps the existing thread-state pointer to the existing obligations ledger. Under the thread lock, takeover creates a `leasing` / `human_thread_reply` obligation when none is active, or claims the linked existing work. It records `assigned_user_id` from the authenticated staff actor. Existing label, type, deadline and escalation/blocking status survive; an ordinary open item advances to in_progress. Two concurrent claimants produce one owner and one refusal. Repeating your own claim reuses the same work.

An active different owner causes409; handback and draft approval cannot complete that person's linked work. A completed historical item is preserved and a subsequent staff claim creates a new obligation. Linked work must match the thread's property and any recorded person/conversation scope. A foreign or wrong-person link is neither displayed as current ownership nor mutated by takeover.

The existing detail read returns `human_owner: { obligation_id, user_id, name, status, label, type, due_at }` from the linked active obligation. Missing, completed or incompatible work yields null. An active unassigned obligation can have null user/name; consumers must not invent ownership. This is conversation work ownership, not post-tour conversion custody or a general relationship owner.

`src/obligations/operator_obligations_service.js` remains the shared operator/Ask reader. Attention includes exactly the existing unfinished states open, in_progress, blocked and escalated. Complete and unknown states remain excluded; explicit collection `?status=open` remains exact. Existing scope, ranking, personal assignment/escalation predicates and cap are retained. The reader joins the name of the recorded assigned user; Ask carries that same ID/name and status, and its answer facts include the name/status. No alternate owner resolver or new Ask domain was introduced.

## Actual response boundary

The existing staff reply is `POST /operator/leasing/conversations/:id/reply`, delegating to `leasing_interactions.recordOutboundText`. Consent-free reply is saved with the authenticated sender but returns `sent:false` and a not-delivered receipt. This is an expected communications refusal, not a lost draft or successful delivery. The positive opted-in control reaches the fenced fake carrier. This change does not make website consent true and does not automatically contact a prospect.

## Fresh proof

- `tests/proofs/conversation_takeover_owner.db.js`: **35/35 real HTTP/Postgres checks**, including two independent leasing-only staff sessions, canonical scoped queue and personal Ask agreement, concurrency, existing escalated work preservation, later inbound without AI reentry, competing draft-send refusal, owner handback, completed-history successor, foreign/wrong-person links, all four attention states and exclusions, explicit status filtering, property authority and consent-negative/positive reply controls.
- Registered as a required step immediately after the intake-classification proof in the existing final activated server phase of `tests/e2e/verify_all.sh`. It uses actual SQL fixtures and the canonical session issuer; there is no skip/pass fallback.
- Owned PostgreSQL17 loopback55441, database `spine_proof_7ebcb104b14ed7cc0f51c003`, nonce `efc07dc8ff53c5ef71cea86b68292ead`. Schema194 /182 migration entries. Full actual server on3341 with carrier, model and outbound-network proof fences. Manifest is workspace `tmp/staff-intake-manifest.json`.
- Local migration/precondition SQL ran sequentially through pg and standard psql fixtures. A Windows launcher mirrors the existing boot environment. This receipt does not claim the Linux full runner or remote GitHub CI ran locally.
- Final HTTP log: `tmp/staff-takeover-successor.log`. Source-gate rerun log: `tmp/staff-takeover-gates-final2.log`. The existing personal-attention unit expectation was updated for the new active predicate and shifted SQL parameter positions, preserving its actor/module authority checks and adding an active-state assertion.
- QB owns separate actual-app browser evidence against this retained runtime; this lane has not changed app source. The actual staff app was initially served from app `b00cf49` on localhost5173. QB identified its sealed production API origin and used local-only browser transport forwarding to the real owned API, not fake API responses.

Runtime remains alive for QB's final browser inspection until explicit cleanup coordination. Local synthetic session metadata is outside Git in `tmp/staff-intake-session.json`; it is not production access.

## Remaining limits

This completes a bounded captured-inquiry → named staff work → honest response receipt path. It does not connect Squarespace Storage, prove real source delivery identity/retries, approve Temple content, establish a production staff roster, or prove an entire automated lead-to-lease journey. The original intake-only classification correction is unchanged. An actual reply does not silently complete the human work; explicit handback closes it through the existing obligation engine.

Proposed CURRENT_STATE entry for QB: authenticated website inquiry ownership first red reproduced with two scoped staff sessions. Existing takeover now retains a named actor in its canonical linked obligation and exposes the same work through detail, scoped queue and Ask. Claimed/blocked/escalated work remains in attention; explicit list filtering unchanged.35 owned HTTP controls; fake transport only; CI registration added. Actual app browser and production acceptance remain separately attributed.

Final verification: all56 configured source-governance gates passed (parent exit0), including29 personal-attention convergence assertions; git diff --check passed. Runtime intentionally retained for QB per coordination; cleanup is not yet claimed.
