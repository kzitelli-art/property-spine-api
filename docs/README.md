# Docs index

142 documents were one flat pile (141 markdown + 1 audit text). Two questions answer where anything lives:

1. **Is it about NOW or ABOUT THEN?** Now → root. Then → `archive/`.
2. **Which door does it belong to?** Check `../CLAUDE.md` (doctrine, doors, reserved names) first — most questions are already answered there.

## Living docs — read these, trust these

| File | What it is |
|---|---|
| `CURRENT_STATE.md` | **What exists now, and at what proof level.** The present-tense authority. Every thread closes into it. Enforced by `tests/gates/gate_current_state.js` |
| `PHILOSOPHY.md` | Doctrine — what the product means, whether a feature belongs. Numbered sections (§) are citable rulings |
| `THREAD_HANDOFF.md` | **History only.** 50 dated banners of what happened and why — its present-tense claims may be stale, and it says so itself |
| `architecture.md` | The monolith's shape: organ pattern, request flow, auth layers, the one loop |
| `domains.md` | What each `src/` domain does, per file |
| `data-model.md` | Core schema: property → unit → space → lease |
| `auth.md` | Staff sessions, phone OTP, CORS |
| `deployment.md` | Render, env vars, the migration release ceremony |
| `DB_HARNESS_ISOLATION.md` | How real-Postgres proofs isolate from production (read before running any `tests/proofs/*.db.js`) |
| `EQUITY_READ_CONTRACT_AND_SCHEMA.md` | The one-canonical-equity-domain ruling (preferred/common are a navigation split) |
| `CODEBASE_STATE.md` | **Superseded by CURRENT_STATE.md.** Kept only as the cautionary record of how a state doc silently rots |
| `CREDENTIAL_ROTATION_RUNBOOK.md` | Ops runbook for rotating the Neon credential |
| `BUILD_1A_CLOSEOUT.md` | The deal-container close-out CLAUDE.md points at before designing above the property |

## Historical subdirectories — kept in place, dated by name

| Dir | Contents |
|---|---|
| `build1/` | Build 1 integrity gaps (cited from CLAUDE.md) |
| `current-state-build/` | The wave-by-wave survey machinery behind CURRENT_STATE.md |
| `specs/` | DOCTRINE.md and the full product spec |
| `release0/`, `release-0-audit/`, `release/` | Release 0 and the 182–187 release records |
| `slices-6-to-10/` | Slice session handoffs |
| `screenshots_work_orders/`, `screenshots_work_order_visibility/` | Browser-proof screenshots |

## archive/ — 128 dated receipts, close-outs, candidates, audits

Everything else that was loose in this directory: `RELEASE_0_*` steps and
receipts, `SLICE_*`, `BUILD_*`, `PRICING_*`, `ASK_SPINE_*`, `PERSON_*`,
traces, audits, candidates and session notes. **They are kept, not deleted** —
this repo's threads repeatedly needed to know what was already built, what was
already ruled, and what a proof observed at the time. Search them before
deciding something they already decided:

```bash
grep -rin "renewal\|turnover\|pricing" docs/archive/ | head
```

Path rule: `git log --follow docs/archive/<file>` shows its full history,
including the years it spent at the directory root. Citations to these files
from living docs were rewritten to `docs/archive/…` in the same change that
moved them, so nothing dangles.
