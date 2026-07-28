# Build 6B — deferred display-language items

**Status: recorded, not fixed. Deliberately deferred to live browser review.**

Build 6B removed the redundant conversational doors and corrected the operator
language that carried architectural meaning: `stage_decision_required`,
`clarification_required` / `unclear`, the raw agent intent names, and the raw
marketing-state enum.

Four display-language leaks remain. Each prints an internal value where a
sentence belongs. **None of them affects what a governed action means** — they
are render-layer only, and no operating decision reads them.

They are deferred on purpose: choosing the right words for each needs a person
looking at a real screen with real data, and inventing a label map before that
would be a guess dressed as a fix. Review them during browser verification,
once live runtime proof is unblocked.

---

## 1. Work status labels

**Where:** `property-spine-app/unit-turn-page.js`, `renderWork()`

Prints `complete` / `blocked` / `actionable` — derived from `w.status` plus the
stage's `blocked` flag. Legible English, but they are state names rather than
sentences, and "blocked" does not say *by what* without reading the stage
blocker line above it.

**Open question for review:** does the operator want the state word, or the
consequence ("waiting on repairs")? The blocker detail is already on screen
directly above, so the answer may be that the word is fine as a chip.

## 2. Generic receipt-key rendering

**Where:** `property-spine-app/unit-turn-page.js`, the `S.receipt` block

Receipt keys are de-snaked generically (`k.replace(/_/g, " ")`), so any key a
server response adds reaches the operator unreviewed. Current worst case:
"recorded via".

**Open question for review:** an explicit label map, or a server-supplied
`receipt.lines` of finished sentences. The second is more consistent with how
every other label on this page works — the server decides, the page renders —
but it changes the receipt shape, so it should not be done blind.

## 3. Diagnostic proposal-key rendering

**Where:** `property-spine-app/staff-agent-door.js`, `renderProposal()`

The same generic de-snaking, applied to `p.proposed` keys — "paint level",
"cleaning level", "work id".

**Lower priority:** the Build 5 door is a diagnostic route, not the primary
operator path. Worth confirming during review that it is still reached only
diagnostically before spending any effort here.

## 4. Raw vacancy values

**Where:** `property-spine-app/unit-turn-page.js`, the status block

`t.status.vacancy` prints the stored `vacancy_observation` value directly. The
*unknown* case is already handled honestly ("Unknown — no confirmed walk"); it
is the known values that print as stored.

**Open question for review:** whether the stored vocabulary already reads as
operator language on screen, or needs a label the way readiness does.

---

## What must NOT happen to these

Fixing them by adding a client-side label map would put operator meaning back
in the browser, which is the thing Builds 6A and 6B moved out of it. If any of
these is corrected, the label comes from the server — the same rule as
`readiness_label`, `marketability_label`, `placement_label`, `plain_label` and
`status_label`.
