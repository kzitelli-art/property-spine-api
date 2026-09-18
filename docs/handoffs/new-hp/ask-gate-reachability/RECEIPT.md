# The Ask Spine gate proves a domain is REACHABLE, not merely assigned

Lane `claude-opus/ask-gate-reachability-20260914`, over board `7dbfd5a9`.
**Harness only** — `git status` shows no file under `src/` or `migrations/`
touched, and `src/agent/ask_spine_answer.js` is byte-identical to the board.
No schema, no deployment, no production read. App pin `b0be9f4` untouched.

## The gap, and why it is not hypothetical

`gathersDomain` proved two things about `ask_spine_answer.js` **source**: that
`facts.<domain> =` appears, and that the right module is required. Neither
says a question can reach that line.

`prospect_match` shipped guarded by `subject === "leasing" || subject ===
"match"`. `questionSubject` yields neither — its leasing vocabulary resolves
to `leasing_person`. The branch was unreachable, the registry said
`registered`, and this gate passed it through **two CI runs**. A gate that
asserts less than it says launders the gap into evidence.

## First red

`witness/dead_branch.first_red.txt`. The dead branch was reintroduced as a
**throwaway mutation, never committed as product**, and the unchanged gate
was run on that tree:

```
  ok    prospect_match declared registered AND gathered in src/agent/ask_spine_answer.js
  ASSERTIONS COMPLETE · 115 run · 115 passed · 0 failed
  ✓ PASS — every domain with standing truth is classified.
  GATE EXIT = 0
```

The branch is unreachable. The gate calls it gathered, and passes.

With the detector landed, the same mutation on the same tree:

```
  ok    prospect_match declared registered AND gathered in src/agent/ask_spine_answer.js
  FAIL  prospect_match is reached by "which homes fit this prospect"
          questionSubject produced "leasing_person", but the branch is guarded by
          ["leasing","match"] — nothing an operator types this way reaches prospect_match.
  ASSERTIONS COMPLETE · 147 run · 145 passed · 2 failed
  GATE EXIT = 1
```

The old assertion still passes — which is the point. It was never wrong about
what it checked; it was wrong about what that proved.

## The detector

Every `registered` entry now declares `reached_by`: real questions an
operator might type. For each, the gate **calls the live `questionSubject`**
and demands the produced subject be one the domain's own gather branch is
guarded by. Runtime, not string matching, because the producer is the only
authority on what it produces.

Guards are found statically and narrowly: from the `facts.<domain> =`
assignment, walk back to the nearest `if (subject === …` and read every
`subject === "literal"` in that condition, comments stripped. An assignment
under **no** subject guard is reported as unguarded rather than passed —
"runs for every subject" is a different claim from "runs for this one", and
only the author knows which was meant.

| domain | guard | method |
|---|---|---|
| prospect_match | `leasing_person` | runtime `questionSubject` × 2 questions |
| maintenance | `work` | runtime × 2 |
| compliance | `compliance` | runtime × 2 |
| utility | `utility` | runtime × 2 |
| contracted_service | `contracted_service` | runtime × 2 |
| debt | `debt` | runtime × 2 |
| equity | `equity` | runtime × 2 |
| tenancy | `tenancy` | runtime × 2 |

**All eight are reachable. No registered domain had to move to `pending`.**
Static guard matching was used for the *guard side* only; every *subject*
side is a live call, so no domain rests on string matching alone.

### The producer is loaded lazily, and the scenario is why

The first version required the composer at gate load. The falsification
scenario caught it immediately: deleting the tenancy standing read made the
gate **die on import** instead of failing on the assertion that names it, so
a mutation that should fail loudly failed for an unreadable reason. A gate
that dies is worse than a gate that reports. The producer is now loaded once,
on first use, inside a try — and a load failure becomes a reported
reachability failure naming the error, never a crash and never a silent skip.

## Falsification

`tests/scenarios/ask_spine_reader_gate_falsification.js` gains two mutations
and now goes **red 8 ways and green again, 30/30**:

- a registered domain's gather branch is guarded by a subject nothing yields
  (the historical defect);
- a registered domain declares no `reached_by` question at all.

Every pre-existing mutation still goes red-then-green, and the tree is
asserted byte-identical afterwards.

## Counts

| | before | after |
|---|---|---|
| gate assertions | 115 run · 115 passed | **154 run · 154 passed** |
| domains | 14 | 14 |
| registered | 8 | 8 |
| pending | 6 | 6 |
| waived | 0 | 0 |
| falsification mutations | 6 (24/24) | **8 (30/30)** |

`node tests/verify_source_governance.js; echo EXIT=$?` → `EXIT=0`, all 56
gates, `PARENT EXIT 0`. Run bare, never through a pipe: a pipeline's exit
status is the last command's, and piping a gate to `tail` discards the only
thing a gate returns — that cost a CI run in the previous lane.

## What this proves, and what it would miss

**Proves:** for each registered domain, at least one real question produces a
subject that its gather branch is guarded by, and the branch assigns the
domain's fact key. A dead guard now goes red with a message naming the
produced subject and the guard it missed.

**Would miss:**
- `reached_by` is a *declared sample*, not a search of the question space. A
  domain reachable by the two declared questions but unreachable by the
  phrasing operators actually use would still pass. The gate proves the wire
  is connected, not that the vocabulary is good.
- The guard extractor takes the **nearest preceding** `if (subject === …`.
  A domain assigned inside a nested block under a different guard, or behind
  a computed condition, would be read against the wrong guard. Self-tested
  both ways, but it is a heuristic over text, not a parse.
- Reaching the branch is not reaching the reader: module entitlement
  (`allowed_modules`) and per-branch conditions beyond the subject are not
  evaluated here. `utility`, `equity` and `debt` all carry an
  `asset_management` module condition this gate does not check.
- It says nothing about whether the gathered projection is *correct* — only
  that a question can cause it to be gathered.
