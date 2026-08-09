# Build 1 / Build 2 — the release candidate

**One API tree, one app tree.** Not merged to production.

```text
API   claude/build-1-2-rc              d68cc1ddbe79ffbc754913e9e0e83dd6793e6eec
APP   claude/build-2-ask-spine-rc      e867dd8c27f8a1bb4e75040bf277ef03d85fc130
```

Recorded in the commit that follows the one they name — a commit cannot contain
its own hash, the same two-step used for `FROZEN_ARTIFACTS.json` and the Release
0 RC. Both are docs-only commits on top; the SOURCE is what the SHAs identify.

## Proven against these exact tips

```text
gates                                  17/17
prove_completion_proof_intent          59/59   Capability 1, unchanged in meaning
falsify_completion_proof_intent        53/53   Capability 1, unchanged
attack_obligation_ownership_rail       32/32   the rail Capability 2 consumes
prove_ownership_intent                 47/47   Capability 2, no Release 0 gate
prove_self_claim_acceptance            40/40   claim ruling, composed with 142
prove_ask_spine_turn                   49/49   conversation, read-only boundary
ask_spine_turn.browser                 20/20   browser, both capabilities
ask_spine_entry_to_answer.browser      27/27   REAL sign-in to answer
leaked database clones                     0
```

## What is in it

| | |
|---|---|
| **Release 0 RC dependency** | cut from `f6873d7`; every frozen Release 0 artifact byte-identical |
| **Capability 1** | `maintenance.completion_without_valid_proof`, contract 1.2.0, frozen |
| **Capability 2** | `maintenance.ownership_and_acceptance`, contract 1.0.0, over the obligations rail |
| **Migration 141** | Ask Spine read receipts, append-only |
| **Migration 142** | an acceptance may not outlive its assignment, `NOT VALID` + preflight |
| **Migration 143** | interpretations and correction lineage, append-only |
| **Claim semantics** | a self-claim records assignment **and** acceptance atomically |
| **Conversation** | deterministic resolver, ask service, receipt replay, composer routes |

## What the candidate proof establishes

Run against these exact tips, each in its own disposable database:

```bash
tools/build1/run_isolated.sh BUILD1_DATABASE_URL     node tools/build1/prove_completion_proof_intent.js
tools/build1/run_isolated.sh FALSIFYB1_DATABASE_URL  node tools/build1/falsify_completion_proof_intent.js
tools/build1/run_isolated.sh OWNERSHIP_DATABASE_URL  node tools/build1/attack_obligation_ownership_rail.js
tools/build1/run_isolated.sh OWNERSHIP2_DATABASE_URL node tools/build1/prove_ownership_intent.js
tools/build1/run_isolated.sh CLAIM_DATABASE_URL      node tools/build1/prove_self_claim_acceptance.js
tools/build1/run_isolated.sh TURN_DATABASE_URL       node tools/build1/prove_ask_spine_turn.js
tools/build1/run_isolated.sh BROWSER_DATABASE_URL    node ../property-spine-app/ask_spine_turn.browser.js
tools/build1/run_isolated.sh ENTRY_DATABASE_URL      node ../property-spine-app/ask_spine_entry_to_answer.browser.js
npm run verify
```

## Boundaries this candidate holds

**Ask Spine mutates nothing.** No work order, obligation, assignment, acceptance,
proof, progress or resident communication. Its only writes are its own audit
history — a read receipt and an interpretation. The claim-path fix is foundation
work on the obligations rail, exercised separately; it is **not** an Ask Spine
action, and Ask Spine has no authority to assign anything.

**No production activation.** Release 0 has still never run in production, and
Capability 1 is honestly `unavailable` until it does.

## Known unsupported, deliberately

- **Accepted-obligation reassignment** — no governed path exists. Ask Spine
  reports the current state truthfully and promises nothing.
- **Blocked work** — onset is governed, resolution is not. The resolver refuses
  the question by name and says why.
- **Accountability** — assignment and acceptance are not accountability. The
  resolver refuses, and that is the product behaviour, not a gap in it.
- **Natural-language breadth** — bounded deterministic resolution, by decision.
