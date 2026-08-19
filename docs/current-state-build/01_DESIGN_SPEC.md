# docs/CURRENT_STATE.md — LOCKED DESIGN SPEC
Working spec. Not the artifact. Settled with the owner 2026-08-19, before any
row was written. Nothing here is negotiable by a later thread without the
owner reopening it.

## THE THREE LOCKED RULES

**RULE 1 — PRESENT TENSE ONLY.**
Answers only "what is true now?" No history, no rationale, no "we intend to,"
no supersession narrative. A capability unsupported by current source/runtime
evidence reads `NOT ESTABLISHED`, `BUILT BUT DORMANT`, `MERGED / NOT DEPLOYED`.
**Never `live` unless the production rung was actually observed.**

**RULE 2 — EVERY ROW CARRIES ITS OWN EVIDENCE AND FRESHNESS.**
Intent stays out of the row except as a link to the governing spec. Current
state and intended state may never blend in one sentence.

```text
DOMAIN / CAPABILITY
CURRENT OBSERVED BEHAVIOR
CANONICAL OWNER
PROOF RUNG
DEPLOYMENT STATE
PRODUCTION OBSERVED?   yes / no / unknown
EVIDENCE               file paths + tests + relevant commit
LAST VERIFIED          commit SHA + date
KNOWN GAP / BLOCKER
```

**RULE 3 — THREAD_HANDOFF.md BECOMES HISTORY, NOT AUTHORITY.**
Do not rewrite its 4,000 lines. Preserve rulings and narrative. Change its
top-level instruction so present-tense questions resolve in this order:

```text
CURRENT SOURCE / RUNTIME
→ CURRENT_STATE.md
→ PHILOSOPHY / DOCTRINE   for meaning
→ THREAD_HANDOFF.md       for history and why
```

Handoff gains, at its top: *"Historical sections below may contain stale
present-tense claims. Do not use them as current-state authority."*

## THE STALENESS TRIGGER

Beyond CODEBASE_STATE.md's census stamp: the file must make its own staleness
visible rather than silently impersonating freshness.

```text
STATE SNAPSHOT
Verified against API commit: <sha>
Verified against app commit: <sha>
Schema observation: <proof level / ceiling if actually observed>
Generated/verified: <date>

If current HEAD differs, this document is navigation until affected rows are
reverified.
```

That last line is what prevents a repeat of the 2026-08-05 CODEBASE_STATE.md
failure (stamped `8330aec`, silently stale ~2 weeks later).

## THE ACCEPTANCE TEST

A brand-new thread asks, and gets ONE unambiguous answer with a proof rung and
evidence, **without reading a single historical banner**:

1. "Is Equity live?"
2. "Can Leasing execute a lease?"
3. "Can Ask Spine read Utilities?"

If the file cannot do that across the platform, it has not shipped.

## THE PROTECTIVE RULE (keeps the map from becoming the next false authority)

> **Absence from this map does not mean the capability is missing. It means its
> current state has not yet been established here. Search and run before
> designing.**

## CURRENT-STATE-ONLY, NOT APPEND-ONLY

When evidence changes, UPDATE the row. Git is the history. Otherwise this
becomes another 4,000-line archaeology document.

## WHY THIS EXISTS — the measured failure it replaces

docs/THREAD_HANDOFF.md, measured 2026-08-19:
- 3,992 lines, 50 banner sections
- 34 instances of supersession language ("SUPERSEDES", "THIS SECTION WINS",
  "THIS SECTION SAID 'UNRELEASED' AND WAS WRONG", "THAT SENTENCE IS NOW FALSE")
- Banners claim PARTIAL authority ("wins on Asset Management, no longer wins on
  release state"), so a present-tense question requires running a precedence
  algorithm across 50 dated banners.
- Its top banner reads "EQUITY IS LIVE." Equity is merged and NOT
  production-verified. Debt's banner 200 lines below states the honest standard
  ("MERGE/DEPLOY/PRODUCTION-BROWSER PROOF REMAIN"). One file, two standards for
  "live," 200 lines apart.

A historical narrative was being asked to answer a current-state question.
That is the structural error this file corrects.

## OPEN TAXONOMY QUESTIONS — settle with owner BEFORE writing rows

1. Row granularity: domain-level (matches gate_ask_spine_readers.js discovery,
   so a gate can enforce coverage mechanically) vs capability/lifecycle-step
   level (more useful for Leasing, harder to gate). Possibly both, two-tier.
2. Does every row need a governing-spec link, or only where one exists?
3. Does the file cover BOTH repos in one table, or api rows + app rows?
   (Browser proof always lives in the app repo; HTTP/DB proof in the api repo.)
