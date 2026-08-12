# Property Spine — Thread Handoff

## ══════════════════════════════════════════════════════════════════
##  ASK SPINE IS NOW AN INTERFACE CONTRACT, NOT A FEATURE.
##  2026-08-12 (latest). THIS SECTION WINS ON DOCTRINE AND ON
##  WHAT "DONE" MEANS FOR A DOMAIN. DOCS + ONE GATE. NO PRODUCT CODE.
## ══════════════════════════════════════════════════════════════════

A docs-only doctrine pass, run **before Debt starts**, so the conversational
rule is something the architecture forces rather than something a builder
remembers.

**`PHILOSOPHY.md` §40 now freezes eleven numbered rulings** — citable as §40.1
… §40.11. New since the last pass: every domain has **two primary readers**
(40.1), conversation is **role-independent architecture** (40.3), every domain
exposes a **compact standing projection** (40.6), and **retrieval ≠ causal
explanation** (40.10).

**The Definition of Done gained a rung, and it is a rung.**

```text
canonical truth → writer → canonical read → compact standing projection
                → operator UI → Ask Spine registration → browser proof
```

A domain browser-verified in the operator UI but unreadable by Ask Spine is
done as a **screen** and not done as a **domain**. Say it that way in receipts.

**`CLAUDE.md` carries it as architecture, not a sidebar** — the two-reader
diagram, the eleven rulings in brief, and Eight-Question **6 extended** to
demand the standing projection by name. §31 was NOT renumbered: six documents
cite "the Eight Questions" and several are historical receipts.

**`tests/gate_ask_spine_readers.js` enforces it (§40.11).** It **discovers**
domains from `src/asset/*_{position_read,establishment}.js` rather than from a
hand-maintained list, so a domain that lands without registering goes red on
its own — a list only knows what someone remembered to add.

```text
20/20 · exit 0 · insurance and tax both `pending`, both with owner + exit
FALSIFIED BOTH WAYS   a stub debt_position_read.js  → RED (undeclared)
                      `registered` without wiring   → RED (claim ≠ implementation)
```

⚠ **The gate is green because the gap is DECLARED, not closed. ZERO domains
are conversationally readable today** — Ask Spine gathers `attention` and
`work_orders` only. Insurance and Tax are browser-verified screens and are not
done as domains. The gate prints this in its own output. Do not cite its exit
code as coverage.

**Two documentation defects fixed, both live traps:**

```text
U&O said "25th of the FOLLOWING month" in the four-obligation summary while
the same document recorded the same-month correction. The summary would have
reintroduced the defect. Authority is philadelphia_tax_rules.js.

The release block said NOT merged · 162–167 pending · ceiling 161. All four
lines were stale — merged (#97/#57) and released; ceiling 167.
```

**Also flagged, not fixed:** `release/ledger_read_before_release.sql` has a
`build` list ending at **159**. It cannot see 160–167 and will report a clean
`pending` for a set it never looked at. Regenerate before the next release.

**Where this lands for Debt.** The first schema conversation now has to answer:
*what must Debt expose so an entitled person can text Spine from a meeting and
ask what we owe, the rate, the maturity, and what needs their attention?*
§40.6 makes that a schema constraint — Debt must answer it **without** walking
its payment or amendment history. §40.10 caps Debt Build 1 at retrieval with
causal hooks preserved, not causal explanation.

## ══════════════════════════════════════════════════════════════════
##  ASK SPINE ANSWERS TYPED QUESTIONS. IT NEVER COULD BEFORE.
##  2026-08-12. THIS SECTION WINS ON ASK SPINE IMPLEMENTATION STATE.
##  NEXT SLICE IS MEETING INTELLIGENCE — DESIGN DOC WRITTEN, NOT BUILT.
## ══════════════════════════════════════════════════════════════════

```text
LIVE   api main 7ebb400 · app main bf86673
       POST /operator/ask-spine/ask     answers, scoped, server-derived property
       the composer                     shipped, browser-verified in production

ON A BRANCH, NOT MERGED, NOT DEPLOYED
       api  bcc5446   claude/ask-spine-conversational-dash-97bwcx
                      adds `references[]` to the ask response
       app  ddfa59c   claude/ask-spine-conversational-dash-97bwcx
                      pins the proof verdict to `state` by name
```

**⚠ `references[]` IS NOT IN PRODUCTION.** It is written, tested and pushed, and
`origin/main` does not contain it. Anyone building a UI against that field today
gets `undefined` from the live API. Merge the branch before, or alongside, the
visual patch — not after.

### The bug that mattered, and why nothing caught it

Ask Spine had **never once answered a question.** Every typed question returned
`unavailable`. The cause was one line:

```text
{ role: "assistant", content: "{" }      an answer-shape prefill
→ 400 invalid_request_error
  "This model does not support assistant message prefill."
```

The catch block rendered that as `unavailable` — indistinguishable from a real
model outage, which is exactly the state the surface is designed to report
honestly. It looked like correct behaviour.

**The test suite asserted the prefill was present, and passed the whole time.**
It pinned the *mechanism* (there is a prefill) instead of the *guarantee* (the
reply parses as a decision). A stub cannot return a 400, so no stub-backed
assertion could ever have failed. The fix removes the prefill entirely and uses
`output_config.format` / `json_schema`, so the API enforces the shape rather than
the prompt hoping for it.

Worth carrying forward as method: **an assertion about how something is done
cannot detect that it does not work.** Pin the outcome, and ask what would have
to break for the green to go red.

### Traps this slice paid for

- **`innerText` applies `text-transform`.** The browser gate reported the
  grounding line missing on a working surface: `.as-ground` is
  `text-transform: uppercase`, `innerText` returned `READ 1 OPEN ITEM`, and the
  assertion was `/Read /`, case-sensitive. This is the *inverse* of the
  `innerText` trap already in CLAUDE.md — there it read too much, here it read a
  true thing in a form the assertion did not recognise. Proved with a standalone
  Playwright run before changing the assertion, because "the gate is wrong" is
  the most expensive thing to be wrong about.
- **A scope rule that depends on a judgement has no edge.** Check 3 passed one
  run and failed the next, unchanged. The prompt made `out_of_scope` depend on
  whether the facts were *sufficient* — a call with no boundary. Scope is now
  about the **subject only**: an on-subject question is always `answered`, and
  "nothing is overdue right now" is an answer, not a refusal.
- **A contract pin can be blind twice.** The first version searched the whole
  file and passed on an identical read in a different function; the second used
  `indexOf("function proofLine")`, which prefix-matches `proofLineX(`. Both were
  found by trying to make them fail. A pin that has never been falsified is a
  claim about nothing.
- **Stale local `main` nearly produced a false ancestry claim** in both repos.
  `git ls-remote` / `git fetch --prune` before saying anything is or is not
  merged. Shallow clones also make `npm run verify` skip gates silently —
  `git rev-parse --is-shallow-repository` before believing a green run.

### Recorded, not fixed

```text
1  `COULD NOT READ: WORK_ORDERS` appears in live production answers. A real
   read failure, honestly surfaced by the grounding line rather than hidden.
   Not diagnosed.
2  The browser gate's fault-injection checks 6/6b run ONLY when the API key is
   absent, so a keyed receipt carries `fault_injection_proven.model_unavailable:
   false` — which deployed mode's D3 then consumes. The gate under-proves
   exactly the failure path the prefill bug hid in.
```

### The app side is with the owner's UI developer

A written brief covers the conversational redesign, the DOM contracts the
browser gate enforces (`#askSpineMount`, `#askSpineInput`, `.as-send`,
`#askSpineBody`, `[data-as]`, `.as-ground`, `.as-unavail`, `askSpineTyped()`),
the response shape, and the `innerText` trap above. Do not rename those without
moving the gate with them — a rename is a contract change.

The one instruction that matters for the next slice: the renderer switches on
`references[].kind` with a fallback, rather than branching over the two kinds
visible today. Meeting citations arrive in that same array.

### ▶ WHICH ASK SPINE DOCUMENT GOVERNS — there are seven, and five are history

`docs/` carries seven Ask Spine documents. Only two govern new work. The rest are
dated receipts and audits, now stamped with status headers at the top of each so
nobody builds against one by accident.

```text
GOVERNING
  PHILOSOPHY.md §40                            what Ask Spine IS — doctrine
  PHILOSOPHY.md §33                            not done until it can be asked
  ASK_SPINE_CANONICAL_READ_LAYER.md            next build — Taxes + Insurance
  ASK_SPINE_SLICE_3_MEETING_INTELLIGENCE.md    second — transcript evidence

HISTORY — stamped, do not build against
  ASK_SPINE_BUILD_CONTRACT.md          PARKED maintenance charter. Never shipped.
                                       ⚠ opened with "read before writing any Ask
                                       Spine code" — that sentence is now false.
                                       §19 open rulings ARE still frozen.
  ASK_SPINE_SLICE_2_DESIGN_INPUT.md    premortem for the parked charter
  ASK_SPINE_SLICE_1_RECEIPT.md         dated receipt; its status line is stale
  ASK_SPINE_SOURCE_AUDIT.md            stale SHAs; findings need re-checking
  BUILD_1_ASK_SPINE_SOURCE_CLASSIFICATION.md   stale counts; do not quote them
```

### ▶ NEXT — TWO DESIGNS, AND THE ORDER IS LOAD-BEARING

```text
1  docs/ASK_SPINE_CANONICAL_READ_LAYER.md      Taxes + Insurance. LANDS FIRST.
2  docs/ASK_SPINE_SLICE_3_MEETING_INTELLIGENCE.md   transcript evidence.
```

Both converge on the same composer. **Canonical reads first** — governed truth,
one authority level, no tier machinery. Reversed, transcript passages arrive into
a composer that has only ever known one kind of fact, and *"I think the taxes got
paid last week"* ends up beside `city_payment: NOT_ESTABLISHED` with nothing
structural separating them.

The rule the canonical-read design establishes, headed for `PHILOSOPHY.md` §33:

> **A canonical Spine domain is not complete until its governed standing state is
> available to Ask Spine for entitled users.**

Every governed domain needs conversational *reads*. Not every module needs
conversational *writes*. Three collisions with things already frozen in source
are recorded in §1a of that document — read them before designing:

```text
the read door does NOT become the write door — ask_spine.js says so
"I'm done" already has a canonical writer: lifecycle_service.claimCompletion,
   via the technician SMS path, proven single by gate_completion_writers.js.
   A conversational write ROUTES THROUGH it or the gate fails, correctly.
Owner is a RESERVED name — a different audience, possibly a different login.
   It must not reuse the Asset Management entitlement.
```

### ▶ AND — meeting intelligence. FOUR RULINGS ARE FROZEN.

Read **`docs/ASK_SPINE_SLICE_3_MEETING_INTELLIGENCE.md`** before designing any of
it. Nothing is built. It carries the owner's framing verbatim, four rulings the
owner froze on 2026-08-12, the assertion ladder as an actual data contract, and
one correction that a real transcript forced on the premise:

> A transcript is not evidence of what was said. It is evidence of what a
> machine rendered from a recording of what was said.

In the owner's own demo transcript a three-bedroom rent appears as `$29.97`, one
staff member appears under two spellings, and eight turns are `Unidentified
Speaker`. The phrasing rule that follows is frozen: **until a passage is
human-confirmed, Ask Spine says "the transcript records Robert as saying…", not
"Robert said…"** Quote passages; never paraphrase a number or name out of one.

```text
R1 retention        transcript kept while the account is active, as an explicit
                    ORG POLICY. Promoted decisions/obligations/confirmed facts
                    survive independently of the transcript.
R2 consent          Spine does NOT record meetings. It ingests from an approved
                    source under the org's recording policy. Do not build a
                    second consent mechanism inside Spine.
R3 retrievability   full transcript preserved; only OPERATIONALLY RELEVANT
                    segments enter conversational retrieval. Personal chatter
                    stays out unless the source transcript is asked for directly.
R4 unmapped speakers  allowed in generic answers as `Unidentified Speaker` with
                    meeting + timestamp. Never infer identity. An unidentified
                    segment CANNOT satisfy "what did Kandice say".
```

The ladder now has a contract rather than prose — Tier 1 transcript claim,
Tier 2 confirmed statement, Tier 3 governed operating truth, and **no tier is
ever inferred from the one below it.** Tier 2 carries `as_recorded` alongside
`as_confirmed`, which is where `$29.97` becomes `$2,997` while the segment still
reads `$29.97` forever. Slice 1 stays read-only and builds Tier 1 only.

**§4 is the seam that keeps conversational ease from dissolving all of it**, and
it is one rule wearing seven hats:

```text
THE MODEL GETS FLUENCY OVER WORDING. IT NEVER GETS AUTHORITY OVER
ATTRIBUTION, TIER, CURRENT STATE, RELEVANCE, OR CONFLICT.
```

The four that will be got wrong by default:

```text
attribution   the server hands the model a PRE-BUILT attribution string. Told
              to be conversational, a model smooths "the transcript records"
              into "said" every time, because the second is better English.
current state a state question answers from the operating reads; meeting
              evidence is additive and labelled, never substitutive. And if the
              state read FAILS, meeting memory does not fill the hole — that is
              fixture-fallback in a new costume. Do NOT implement this as a
              routing classifier; that is the judgement-with-no-edge that made
              check 3 flaky in the first place.
relevance     a segment is retrievable because it references an operating
              OBJECT, not because its text scored well. Plus a second axis:
              sensitivity overrides relevance. The sample's hospitalization is
              attached to a real leasing fact, so entity linkage alone lets it
              straight in.
retrieval     the unit is a THREAD, not a chunk, presented chronologically. The
              roommate ruling lands at 13:56, twelve minutes after the
              discussion opens. Top-one RAG misses the conclusion by design.
```

Conflict is an output, never something the model resolves — the sample reports
the elevator fixed and broken inside one meeting.

**Release order is now a dependency, not cleanup.** The meeting slice must not
pretend citation UI is live: `references[]` is on the branch, not in `main`.
Build against the branch contract or merge it first — never against production
behavior that does not yet exist.

Migration files exist through **161**; the ledger ceiling was **not confirmed**
from that session (no `DATABASE_URL` present). Confirm it against production
before writing 162 — see §3 of this file for why that has already cost time
twice.

---

## ══════════════════════════════════════════════════════════════════
##  ASSET MANAGEMENT REORGANISED TO FOUR DOORS. 2026-08-12.
##  THIS SECTION WINS ON ASSET MANAGEMENT. IT NO LONGER WINS ON
##  RELEASE STATE — 162–167 ARE RELEASED, CEILING 167. SEE
##  "PHILADELPHIA TAXES V1 IS BUILT AND RELEASED" BELOW.
## ══════════════════════════════════════════════════════════════════

> The section immediately below — **the completion guard is ON** — is separate,
> live production truth about Maintenance. It is not superseded by this one.
> Two different domains, both current. Read both.

Asset Management is now **four durable doors**, replacing the old
REVENUE / CAPITAL / PROPERTY OBLIGATIONS / OPERATING COSTS set:

```text
CAPITAL STACK        Debt · Equity · Reserves & Escrows
PROPERTY EXPENSES    Taxes · Insurance · Payroll · Utilities · Contracted
                     Services · Repairs · Management · Marketing · Other  (nine)
PROJECTS & CAPEX     Projects · Unit Improvements · Building Systems ·
                     Equipment / FF&E · Capital Reserves & Draws
COMPLIANCE           Licenses · Inspections · Certificates · Violations ·
                     Recurring Requirements
```

**The door is navigation; the module underneath owns the truth.** The AM
surface writes NO domain table — pinned by `gate_funding_boundary.js` (the
NAVIGATION assertion). It reads the canonical domain reads and renders.

**Taxes and Insurance moved intact.** Re-homed from Property Obligations to
Property Expenses with nothing rewritten — the four-row tax position and the
four-section insurance dashboard are unchanged. This build moved doors; it
did not touch either HTTP house beyond the room key.

**`room` is a contract key, and it moved.** The tax compartment payload now
returns `room: "property_expenses"` (was `property_obligations`), pinned by
name in `philadelphia_tax_http.db.js`. Migration 159's silent key rename is
the precedent that assertion exists to prevent.

**Property Expenses establishment is DERIVED and CAPPED.** It probes the tax
and insurance canonical reads and reports `partially_established` when either
is established; it can NEVER read `established`, because that would claim
payroll, utilities and five more are accounted for. The parent never
manufactures a CURRENT it cannot stand behind. (Desk chip reads
"PARTIALLY ESTABLISHED — Insurance is established. The other operating
expenses are not.")

**Proven** — asset_management_shell.db.js 54/54 · philadelphia_tax_http.db.js
106/106 · insurance_establishment.db.js 141/141 · gate_funding_boundary.js
51/51 · source-governance 16/16 · asset_management_shell.browser.js **260/260**
including the four-door journey, 390px and keyboard. Screenshots under
`/tmp/am-browser` (`02-asset-management-open.png`, `am-four-doors-narrow.png`).

**No new migrations.** This is a surface/navigation change. ⚠ The release
picture below said "162–167 still pending, ceiling still 161" and that is
**no longer true** — see the release section, corrected 2026-08-12.

**Doctrine still describes the OLD AM sub-hierarchy.** ⚠ **NO LONGER TRUE —
corrected 2026-08-12.** `CLAUDE.md` and `PHILOSOPHY.md` both carry the four
rooms now; neither mentions REVENUE / CAPITAL / PROPERTY OBLIGATIONS /
OPERATING COSTS anywhere. The paragraph below is kept as the record of what
was deliberately deferred, not as a live instruction. Original text follows.

`CLAUDE.md` → "Four
operating doors" and `PHILOSOPHY.md` still list REVENUE / CAPITAL / PROPERTY
OBLIGATIONS / OPERATING COSTS as AM's shape. The code has moved past that
text; the doctrine edit is the owner's call and is deliberately NOT made in
this build.

## ══════════════════════════════════════════════════════════════════
## ══════════════════════════════════════════════════════════════════
##  ⚠ THE COMPLETION GUARD IS **ON**. IT CUT OVER 2026-08-12 01:49 UTC.
##  THIS REPLACES "THE GUARD IS OFF" — THAT SENTENCE IS NOW FALSE.
##  2026-08-12. FOR WHOEVER IS WORKING IN MAINTENANCE.
## ══════════════════════════════════════════════════════════════════

```text
boundary 6   operator completion control retired (app)      LIVE
boundary 7   legacy done-path fails closed (409)            LIVE   e94cf0a
boundary 7b  migration 140 — the completion guard           APPLIED 22db7f6
boundary 8a  activation machinery, shipped dormant          LIVE   4aec686
boundary 8b  the cutover runner                             LIVE   e10133a
boundary 8   THE ACTIVATION ITSELF                          DONE   ← irreversible
boundary 8   closeout proof, 16/16 in production            DONE   3e47739 (PR #94)
```

```text
activation_id  d93b08dd-c682-46d2-acf9-78ab6b960827
activated_at   2026-08-12T01:49:57.866Z      the census instant, not a wall clock
legacy frozen  1 row, inventoried and immutable
```

**There is no supported way to un-activate.** The epoch is append-only; the
E1 freeze refuses `update release_0_activation_epoch set activation_id = null`
by name. Boundary 8 is the line.

### What this means for you, right now

**The database refuses any work order reaching a terminal status without a
grounded proof evaluation.** Not the app checking — the database, on commit,
through a deferred constraint trigger. No route, repair script or psql session
gets around it.

This is no longer a warning about a future day. It is live, and it has been
measured live — not inferred from the migration being applied:

```text
node tools/step7/prove_guard_active.js      instance kbtb6 · 16/16 · exit 0

R0001  terminal with no proof evaluation              REFUSED
R0004  `satisfied` citing non-qualifying evidence     REFUSED
R0001  a `not_satisfied` evaluation                   REFUSED
R0003  `closed` — even WITH grounded proof            REFUSED
       grounded `satisfied`                           PERMITTED
```

`not_done_service.js` and the work-order surfaces landed while the guard was
dormant, so **they have never felt it**. Anything that puts a work order into
`complete` or `closed` must go through the canonical writer or it will fail at
commit. `closed` in particular is now dead vocabulary: R0003 refuses it even
when the proof is perfect.

That tool is safe to re-run any time. Every state it builds is judged by
`SET CONSTRAINTS ALL IMMEDIATE` and rolled back; it leaves nothing behind.
Do NOT hand-write a probe instead — the proof tables are append-only with
`ON DELETE RESTRICT`, so a committed test completion is **permanent** and makes
its work order undeletable. That defect was caught in review, not in production.

Today there are exactly two completion writers and `gate_completion_writers.js`
proves there is no third:

```text
CANONICAL  src/technician/lifecycle_service.claimCompletion
           called only from src/technician/conversation.js (the SMS path)
LEGACY     src/maintenance/maintenance.js closeout — done=true returns 409
           done=false is untouched and still works
```

### What the cutover cost, and why the first attempt was refused

The first live attempt was **refused by one millisecond** and rolled back —
nothing changed. The runner took `activated_at` from `new Date()` on Render
while `now()` came from Neon, and the boundary must be strictly earlier than the
transaction that records it. Fixed in PR #91: the instant is the census's own
`taken_at`, which is what the service always documented it should be.

Worth keeping, because it is the reason to trust the rest: **the activation
refused itself over a millisecond of clock skew.** It was not being cautious
about something conceptual. It was reading its own precondition.

### What is left of Release 0

```text
ITEM 2  a canonical completion through claimCompletion, with real proof,
        end to end — needs a real technician SMS completion.        OPEN
```

The closeout proof establishes that the **database** permits a grounded
completion (D1). It does not establish that `claimCompletion` produces one.
Those are different claims and only the second finishes the release.

### If you are about to touch work-order completion

Read `docs/RELEASE_0_ACTIVATION_RUNBOOK.md` and
`tools/step7/activate.js` first. The activation is the one irreversible act in
the release: it draws a permanent line, and everything terminal after it must be
provable.

---

##  PHILADELPHIA TAXES V1 IS BUILT AND **RELEASED**. 2026-08-12.
##  CORRECTED 2026-08-12 — THIS SECTION SAID "UNRELEASED" AND WAS WRONG.
## ══════════════════════════════════════════════════════════════════

```text
API  merged to main                                7ebb400  (PR #97)
APP  merged to main                                bf86673  (PR #57)
migrations 162–167                                 APPLIED
production ledger ceiling                          167
```

**⚠ THIS BLOCK PREVIOUSLY READ "NOT merged · pending 162–167 · ceiling 161."**
All four lines were stale. The branch merged and the release ran. A handoff
that describes a release as pending after it has happened is worse than one
that says nothing: the merge warning below tells you to pause auto-deploy for
a release that is already done, and the next reader either repeats it or stops
trusting the file.

**The ceiling above is reported, not read by the author of this edit.** Per §3
and the standing rule, `EXPECTED_LEDGER_CEILING` is never typed from memory or
from this document — **read it from the ledger** before any release. The value
here orients you; it does not authorise anything.

**The merge warning that stood here is now HISTORY, not instruction.** It read:
*"auto-deploy is ON, `prestart` verifies rather than applies, and merging with
162–167 pending is a failed production deploy — pause auto-deploy first."*
That was correct while those six were pending. It no longer applies to them.
**The underlying trap is permanent and applies to the next migration**, so keep
the mechanism in mind and see §3; the run card is
[`release/INSURANCE_162_163_RUN_CARD.md`](release/INSURANCE_162_163_RUN_CARD.md).

⚠ **`release/ledger_read_before_release.sql` is stale for the next release.**
Its `build` list ends at **159** and does not know 160–167, so running it as-is
reports a clean `pending` for a set it never looked at — the migration-140
failure mode its own footer warns about. Regenerate it before use; the command
is in the file and must not be hand-edited.

### ⚠ THE CLOCKS AND THE STANDING MODEL WERE WRONG, AND WERE CORRECTED

A review of this branch found three wrong answers in the layer that turns
governed facts into "what is due now?". The facts underneath were sound;
the compression on top of them was not. Every one is now pinned by a
proof that fails if it returns.

```text
U&O was a MONTH late      modelled as "month M, due the 25th of M+1".
                          It is the SAME MONTH, shifted forward past
                          weekends and City holidays.
NPT estimates a YEAR late  the estimates for tax year Y are due Apr 15
                          and Jun 15 OF Y. Only the RETURN is Y+1.
any payment satisfied      `if (oblPayments.length) return true` made a
every requirement          $50,000 payment against a $122,259.93 bill
                          read PAID, and let an NPT first estimate close
                          out the second.
a row was ONE PERIOD       it could not hold 2025's BIRT return beside
                          the 2026 estimate that rides on it, nor July
                          U&O closed beside August open.
```

**The City's published 2026 U&O schedule is pinned in
`philadelphia_tax_rules.js` and the derivation must reproduce it.** Every
milestone carries `due`, `derived_due` and `date_source`, so a published
date can never mask a broken rule — which it did, once, during
falsification.

**A payment names the requirement it satisfies** (`satisfies_requirement`,
migration 167). The writer fills it where an obligation carries exactly
one requirement and REFUSES where it carries several. Where the amount is
governed, satisfaction is a comparison: part paid reads as part paid.

**BIRT's mandatory estimate depends on a FILER PROFILE.** The City grants
first-year filers relief, so the cadence is not the same for every
taxpayer. With no profile recorded the requirement is reported UNKNOWN —
never assumed present, never assumed absent.

### FOUR OBLIGATIONS. NOT FIVE.

```text
Real Estate Tax   PROPERTY subject · annual  · payment due Mar 31
BIRT              ENTITY   subject · annual  · return + balance Apr 15 (Y+1)
NPT               ENTITY   subject · annual  · return Apr 15, estimates
                                               Apr 15 and Jun 15
U&O               PROPERTY subject · monthly · filing + payment, 25th of
                                               the SAME month
```

**⚠ U&O IS SAME-MONTH.** This table said "the following month" until 2026-08-12,
which is the exact defect the correction above — *"U&O was a MONTH late"* — records
as fixed. One document asserting both is how a repaired defect gets reintroduced by
someone reading the summary instead of the correction. The authority is
`philadelphia_tax_rules.js`: *"U&O IS SAME-MONTH. The tax for month M is filed and
paid by the 25th of the SAME month"*, shifted forward past weekends and City
holidays, and the City's published 2026 schedule is pinned there so the derivation
must reproduce it.

**Commercial Trash was cut, deliberately.** It is a municipal fee with its
own exemption machinery, not one of these four. It may return later under a
broader municipal-fees area. Do not re-add it to the applicability model,
the clocks, the evidence kinds, the standing read, the UI or the proofs
without a ruling.

**U&O did not disappear in 2026.** The $2,000 ANNUAL EXEMPTION ended
2026-01-01; the tax remains active and monthly. `philadelphia_tax_rules.js`
answers this explicitly rather than leaving it to memory, and the screen
prints it — anyone reasoning "the exemption is gone, so U&O is gone" is
wrong in the direction that under-reports a live obligation.

### What was built

```text
164  legal_entities + dated legal_entity_properties. BIRT/NPT belong to the
     TAXPAYER. `organizations` is the SaaS tenant and is not a taxpayer.
165  tax_obligations · applicability · liabilities · filings · payments ·
     appeals · clearances. Subject is property XOR legal entity, enforced
     by check constraints, matched to the tax type.
166  tax funding — direct | lender_escrow, standing and dated, with escrow
     terms, balance OBSERVATIONS and servicer DISBURSEMENTS in their own
     tables.

philadelphia_tax_rules.js   every Philadelphia date, in one pure module.
                            It computes CLOCKS and never amounts.
tax_position_read.js        one property-facing read. Imports NOTHING.
                            Every state derived; no status column exists.
tax_establishment.js        7 economic routes. Filing and payment stay
                            separate verbs — there is no "mark handled".
tax_funding.js              5 funding routes, on the other side of the wall.
```

### THE TWO SENTENCES THE ARCHITECTURE MAKES UNWRITEABLE

```text
"the escrow is healthy, so the taxes are paid"
"the escrow contribution went up, so the tax went up"
```

`tax_payments` is an ECONOMIC table in `gate_funding_boundary.js`, so no
funding module can write it. PAID means the City was paid and there is
evidence; `tax_obligation_service.recordPayment` is the only writer, and
nothing on the funding side can reach it. A servicer's disbursement is a
funding fact and surfaces as `unevidenced_disbursements` — the disagreement
is shown, never resolved.

**The first version of that gate omitted `tax_payments`.** Every other tax
table was guarded while the one an escrow is most tempted to write was not.
If you extend this to a third domain, list the table that means DONE first.

### The invariant everything else serves

```text
tax accrual = governed annual liability ÷ months in the obligation's period
```

Never a contribution, never a balance, never a disbursement. Proven
byte-identical before and after a contribution change — with a guard
asserting the FUNDING read did change, so the comparison is not vacuous.

### Evidence at this build

```text
API  philadelphia_tax_http.db.js      106/106  real PG + real HTTP
     philadelphia_tax.db.js            64/64
     philadelphia_tax_standing.db.js   41/41   the corrected defects
     philadelphia_tax_funding.db.js    55/55
     legal_entity.db.js                28/28
     philadelphia_tax_clocks.test.js   44/44   PURE — a governance gate
     tax_document_read.test.js         35/35   PURE — a governance gate
     gate_funding_boundary.js          50/50   tax side no longer vacuous
     npm run verify                    16/16
APP  run_harnesses.sh                 1041 · 0 failed · 0 red
```

The two PURE tests are on the standard path deliberately. The clocks
shipped wrong twice with every surrounding proof green, because those
proofs asserted the implementation; these assert the City.

### The document reader

`tax_document_read.js` — upload → read/propose → human confirms →
canonical write, the same contract as Insurance, label-scan only, no
model call. Proven against the extracted text of TWO REAL PORTFOLIO
DOCUMENTS in `tests/fixtures/tax`:

```text
2116 Chestnut RET bill 2023   OPA 881566975 · 2023 · due 2023-03-31 ·
                              $201,512.97 — the AMOUNT TO PAY, not the
                              $2,015,129.68 printed before reductions
Onefive 4233 BIRT 2023        tax ID 2000179694 · 2023 · submitted
                              2024-03-29 · $0.00 due, and the mandatory
                              next-year estimate as its OWN field
```

⚠ Those fixtures contain real OPA and Philadelphia tax account numbers
for portfolio entities. They are here because a reader proven against an
invented format is proven against nothing — but it is a deliberate
choice, and it is reversible.

`available` means A READ HAPPENED in both adapters; `found_count` is what
a surface tests. They disagreed for one commit.

### Still open

```text
release 162–167        nothing is in production. Same run card, new ceiling.
BIRT/NPT amounts       no calculator, by design. Amount is evidenced or
                       unknown — never computed.
duplicate entities     the taxpayer capture route ESTABLISHES only; there
                       is no "pick an existing entity" picker, because
                       `legal_entities` carries no tenancy of its own and
                       listing candidates would read entities this
                       operator has no relationship to. The same LLC
                       entered from two properties becomes two rows.
                       Fixing it needs the primitive to know whose it is —
                       a decision, not a side effect of a capture form.
model fallback         the reader is the scan half only, as in Insurance.
                       A model pass is a separate deliberate act with its
                       own proof that a hallucinated liability cannot
                       reach a confirm screen looking like a reading.
```

---

## ══════════════════════════════════════════════════════════════════
##  INSURANCE V1 IS BUILT AND UNRELEASED. 2026-08-12.
##  FEATURE WORK ON INSURANCE IS CLOSED. SUPERSEDED ABOVE for the
##  release state; the WALL and the invariant here still govern.
## ══════════════════════════════════════════════════════════════════

```text
API  claude/philosophy-doctrine-reference-jv7s7r   f4d639a   NOT merged
APP  claude/philosophy-doctrine-reference-jv7s7r   4390db3   NOT merged
pending migrations                                 162, 163
production ledger ceiling                          161  (expected — READ IT)
```

**⚠ DO NOT MERGE THE API BRANCH UNTIL API AUTO-DEPLOY IS PAUSED.**
Auto-deploy is ON. Merging triggers a normal boot with 162/163 pending,
`prestart` refuses, and that is a failed production deploy — Path B, which
the 160/161 ruling explicitly REJECTED. Pausing first is step 1 of the run
card and it is the whole point of the card.

**The run card is [`release/INSURANCE_162_163_RUN_CARD.md`](release/INSURANCE_162_163_RUN_CARD.md).**
It carries the ordered steps, the production-pass checklist, and what is
still open from 159/160/161. Follow it; do not improvise the sequence.

### What was built

```text
162  participation, separated from allocation. Backfills from existing
     allocations BEFORE adding its FK, so release does not depend on the
     allocation table being empty.
163  funding — direct | lender_escrow | premium_financed, effective-dated,
     with finance-agreement and escrow detail in their own tables.

Add Current Insurance   evidence → label-scan proposal → human confirm →
                        canonical write → the dashboard populates
Good standing           CURRENT · RENEWAL APPROACHING (90/60/45/30) ·
                        COVERAGE NOT CONFIRMED · EXPIRED. ZERO SCHEMA —
                        a bound next term is just a later coverage.
Add Payment / Financing the funding capture sheet
```

### ⚠ THE WALL, AND IT IS EXECUTABLE

`tests/gate_funding_boundary.js` asserts, structurally and in
both directions:

```text
economics ↛ funding   transitive import graph, not just direct edges
economics ↛ funding   no economic file names a funding table
funding → economics   PERMITTED — reference, select, join, foreign key
funding ↛ economics   no insert/update/delete/alter on an economic table
```

The older `gate_insurance_economic_independence.js` reads VOCABULARY and
stays. It could not catch an economic file requiring a funding module whose
name is innocent, nor a funding module writing an economic table — so once
funding existed it would have kept passing while the seam rotted.

**The boundary gate tests its own detectors every run** and reports its own
coverage. Falsified four ways before being trusted, including reaching
funding transitively through an innocently-named intermediary, and including
the case that must NOT trip: an FK from funding to a coverage.

**Do not put funding routes in `insurance_establishment.js`.** That file is
in the economic chain and the gate will fail the build. The surface is the
composition point; the chain is not.

### The invariant everything else serves

```text
insurance accrual = allocated annual cost ÷ coverage term months
```

Never an installment, never a down payment, never a finance charge, never
an escrow withdrawal. `insurance_position_read.js` imports NOTHING and
cannot reach funding by any path. Proven behaviourally: the position is
BYTE-IDENTICAL before and after recording funding in every shape.

### Evidence at these SHAs

```text
API  insurance_establishment.db.js   141/141    real PG + real HTTP
     insurance_truth.db.js            52/52
     asset_management_shell.db.js     46/46
     npm run verify                   14/14
APP  asset_management_shell.browser  171/171    real Chromium
     run_harnesses.sh                1041 · 0 failed · 0 red
```

⚠ `npm run verify` silently runs a SUBSET on a shallow clone — the agent
container starts shallow. `git rev-parse --is-shallow-repository` before
believing green.

### NOT PROVEN, AND MUST NOT BE CLAIMED

```text
anything in production            no access from the build container
                                  (proxy 403 to onrender.com, no DATABASE_URL)
Insurance rendering real truth    NEVER seen on a production page by an
                                  entitled account. Only the fail-closed
                                  direction (401/403) is production-proven,
                                  and that predates this work.
PDF bytes → text                  server.js's existing fileToText, injected.
                                  The label scan over its output IS proven.
deal_setup_http.db.js             cannot run — needs the full schema, which
                                  cannot rebuild from empty (012/yardi_code)
```

### After the production pass

**Insurance is closed.** No more Insurance architecture until real usage
says something is missing. Next domain is **Taxes** — and the Standing
Obligation primitive is still NOT to be extracted. Insurance is one
specimen; the shared shape gets pulled out after a second obligation proves
what is actually shared, not before.

---

## ══════════════════════════════════════════════════════════════════
##  159 IS RELEASED. THE API SHIPS AGAIN. 2026-08-11.
##  SUPERSEDED BY THE SECTION ABOVE.
## ══════════════════════════════════════════════════════════════════

```text
API  main   8f29efa   (PR #90) DEPLOYED and running
ledger ceiling        159   ·  147 migrations, all applied
both directions       clean — every file in the ledger, every ledger row a file
```

Confirmed by `node migrations/migrate.js` on the new instance (`4bcd7`), not
inferred. The ceiling moved 158 → 159 and the instance changed, so the service
is running current `main` rather than the survivor.

### ▶ THE RELEASE SEQUENCE FOR 160/161 — DO NOT IMPROVISE IT

PRs are open and **feature work is stopped**. The risk from here is
operational, not conceptual.

```text
API  kzitelli-art/property-spine-api#92    a988ba8  (carries 160 + 161)
APP  kzitelli-art/property-spine-app#52    0a4ec39  (depends on the API PR)
```

**⚠ API #92 CONTAINS MIGRATIONS AND THE API REFUSES TO BOOT ON PENDING ONES.**
Merging it and letting an ordinary deploy discover 160/161 is exactly the
failure that cost days on 159. Merge is not release, and the deploy after the
merge will fail until the release is done deliberately.

### ⚖ RELEASE RULING — PATH A. PAUSE API AUTO-DEPLOY.

**Ruled 2026-08-11. This is decided; do not re-litigate it at the console.**

> Use Path A — pause API auto-deploy. There is no reason to deliberately
> manufacture a red production deploy just because Path B worked for 159.

**Path B is recorded below as rejected, not as an alternative.** It works, and
it is what happened with 159, and that is not a reason to choose it. A failed
production deploy in the history is a real cost: it teaches whoever reads the
deploy log next that a red deploy here is normal. It is not.

```text
B · REJECTED — let the first auto-deploy fail, then arm the release
    merge → auto-deploy fails (harmless: Render keeps the previous instance
    live) → set the env vars with the now-known SHA → redeploy → delete
    MIGRATION_RELEASE
    Rejected because it manufactures a red deploy we can simply avoid.
```

### ⚠ THE RACE THIS AVOIDS

**API auto-deploy is ON. APP auto-deploy is OFF.** Opposite postures, verified:
`CLAUDE.md:319`, `docs/deployment.md:7`, and this file at the 2026-08-05
section. The sequence depends on both and the asymmetry is easy to get wrong.

Left alone, **merging #92 immediately triggers a normal boot with 160/161
pending**, `prestart` refuses, and that is the 159 pattern recreated on purpose.
Pausing auto-deploy first is what removes the race — not care, not speed.

**The wrinkle Path A is built around: `EXPECTED_SHA` cannot be known until the
merge commit exists**, so the release cannot be armed in advance. Pausing
auto-deploy buys exactly the window needed to read the SHA and arm it.

**The invariant, whatever happens: the migration-release boot must be the FIRST
boot of the merged SHA that is allowed to succeed.**

### 🔴 THE POST-MERGE SHA IS THE RELEASE AUTHORITY — NOT THE PR HEAD

**Be obsessive about this one.** `EXPECTED_SHA` must be the SHA that is
**actually deployed**, which is the commit on `main` after the merge.

```text
6fcbb13   PR #92 head.  NOT automatically the release authority.
<merge>   the resulting main SHA.  THIS is EXPECTED_SHA.
```

A merge commit is a **new commit** — a squash or a merge-commit strategy both
produce a SHA that is not the PR head. They coincide only under fast-forward,
and coinciding by luck is not the same as being correct. **Read the SHA off
`main` after merging. Do not carry the PR-head SHA forward on the assumption
that it is the same.**

`EXPECTED_SHA` exists precisely so the release cannot be run against a tree
different from the one being released. Feeding it a guess disarms the only
guard that catches that.

### THE SEQUENCE — API #92, PATH A

```text
0  review only  ⚠ THERE IS NO CI. Neither repo has a .github/workflows/
                 file — measured, not assumed. No green check is coming and
                 nothing re-runs the gates on a PR. The suite results in the
                 PR bodies are the evidence, produced locally on the merged
                 trees.

1  PAUSE API auto-deploy.

2  RECONFIRM the production ledger:
       ceiling = 159
       both directions clean  (file → ledger, ledger → file)

3  MERGE API PR #92.

4  READ the actual resulting `main` SHA after the merge.
     Do NOT use the PR-head SHA unless it is literally the deployed commit.
     See the section above — this is the step that is easiest to fumble.

5  CONFIRM the merged tree has exactly these pending migrations:
       160
       161
     ✓ VERIFIED IN SOURCE: the PR head carries exactly
       160_asset_management_module.sql and 161_insurance_economic_truth.sql
       above 159, and main carries nothing above 159. Re-confirm against
       production at the time — a release applies EVERY pending file and
       there is no per-file selection.

6  SET:
       MIGRATION_RELEASE=1
       EXPECTED_LEDGER_CEILING=159
       EXPECTED_SHA=<actual merged main SHA from step 4>

7  MANUALLY DEPLOY that exact SHA.
     ← this deploy IS the migration-release boot.

8  CAPTURE the receipt:
       160 applied
       161 applied
       new ledger ceiling = 161
       file → ledger clean
       ledger → file clean
       running SHA = expected SHA

9  REMOVE MIGRATION_RELEASE.

10 NORMAL boot / redeploy. Confirm the service starts cleanly with no
     pending migration.

11 RESUME API auto-deploy.

── prove the API before touching the app ──────────────────────────────

    Confirm the new Asset Management / Insurance reads behave against
    production, and that entitlement still FAILS CLOSED where the module
    is not granted. Only then continue.

12 MERGE APP #52.

13 MANUALLY DEPLOY the app — app auto-deploy is OFF.

14 RUN the authenticated browser pass.
```

### THE BROWSER PASS CLOSES BOTH OLD AND NEW OPEN ITEMS

```text
OLD (159, still open)
  · established Deal Setup position → "Lease & occupancy established"
  · genuinely unestablished position → remains unestablished

NEW (160/161)
  · Asset Management appears ONLY for explicitly entitled staff/property
  · Insurance opens correctly
  · governed Insurance economic truth renders where established
  · Cash & Financing remains honestly unestablished
```

**No new product work until that chain is complete.**

### PR-HEAD STATE AT THE TIME OF THIS RULING

```text
API #92   6fcbb13   awaiting merge / release
APP #52   0a4ec39   waits behind the API
```

### THE RUNGS ARE SEPARATE STATUSES, NEVER COLLAPSED INTO ONE

**"PR merged", "migration released" and "surface proven" are different facts.**
Recording them as one is how a merge comes to be read as a shipped feature —
and this repo has already paid for a deploy that looked healthy while serving
older code.

**Record each rung separately.** Five, not one:

```text
source merged
schema released
API production proven
app deployed
authenticated surface proven
```

State the rung reached. Do not round up.

### 📌 PERMANENT INFRASTRUCTURE DEBT — NO PR CI

**Neither repo has PR CI.** No `.github/workflows/` in either. Release evidence
therefore depends on **locally run gates** — `npm run verify`, the `.db.js`
proofs and the browser proofs — executed by whoever prepared the change, on
their own machine, and reported in the PR body.

That is a real dependency on discipline rather than on machinery, and it is
worth naming as debt rather than leaving as an unremarked absence. It is also
the reason a PR here shows no green check and never will.

**Do NOT fix this inside a release.** Adding CI mid-release changes what
"proven" means in the middle of proving something. It is its own slice.

## ═══ NEXT BUILD · ADD CURRENT INSURANCE ═══

**The pre-build read is [`INSURANCE_ESTABLISHMENT_SOURCE_READ.md`](INSURANCE_ESTABLISHMENT_SOURCE_READ.md).
Read it first. It is a PROPOSAL — no code was written.**

Insurance has a complete, released economic architecture (161) and a working
read, and **zero HTTP write callers**. The missing seam is the human
establishment path: empty Insurance → ADD CURRENT INSURANCE → upload evidence →
Spine proposes → human confirms → canonical services write → the existing
dashboard populates.

**The one decision that gates the build:** both reads are allocation-gated, and
the only property↔policy link in the schema is an allocation carrying an amount.
So a coverage established without this property's stated share is invisible —
"establish what is known and surface the missing allocation honestly" is not
currently expressible. The source read lays out the two honest options and
recommends one narrow Insurance-specific table separating *participation* from
*allocation*. **Make that call before writing code.**

## ═══ 2026-08-11 · RELEASE 160/161 — WHERE IT ACTUALLY STOPPED ═══

**Released and live. Proven in production up to the entitlement wall, and
not one rung past it.**

```text
source merged                 ✓  API 30e1c1a · APP 713625a
schema released               ✓  ceiling 161, both directions clean, disarmed
API production proven         ◐  deployed; refuses with no session (401) and
                                 with no module (403). Correct reads NOT
                                 confirmed in production.
app deployed                  ✓  713625a, confirmed from Render's record
authenticated surface proven   ✗  BLOCKED — see below
```

**What IS proven in production, with a real account:** the Asset Management
card is **absent** for a signed-in operator who lacks the module, and the API
returns a clean 403 for that operator. That is the *fail-closed* direction,
and it is the half that proves the gate exists rather than proving a card can
render.

**What is NOT proven in production:** anything requiring an entitled account.
Insurance rendering governed truth, the accrual figures, Cash & Financing
staying unestablished — all 105/105 in the browser harness against the real
router, none of it seen on a production page. **Do not describe Insurance as
production-verified.**

### 🅿 PARKED 1 — TEAM IS OFFLINE/SNAPSHOT AND CANNOT MAKE LIVE PERMISSION CHANGES

```text
index.html:4901   window.__OFFLINE_MODE = true;     ← unconditional
index.html:11033  "Reads only; any write or unknown endpoint throws a clean 404"
```

The TEAM roster renders from baked demo config — it announces itself with
`DEMO/OFFLINE ROSTER` and `LOCAL STORAGE` chips, so it is labelled rather
than lying — and its invite POST cannot reach the API. Asset Management works
live because it uses the live-required loader that bypasses the snapshot;
TEAM does not.

**Consequence for migration 160:** adding `asset_management` to the TEAM
picker (APP #54) was necessary and is correct, but it is **built-but-dormant**
in production. It removed one of two blockers. There is currently no working
in-product path to grant the module to an existing person, because TEAM
cannot write at all.

**This is its own slice.** Do not treat "make TEAM live" as a defect fix
attached to an Asset Management release.

### 🅿 PARKED 2 — STAFF IDENTITY COULD NOT BE RESOLVED FROM THE ROSTER

Granting the module through the documented admin route
(`PATCH /property-team-assignments/:id`, operator-key authenticated — not a
DB edit and not a bypass) needs the caller's `assignment_id`. It could not be
found:

- a scan of **all 41 properties'** rosters matched no member against the
  operator's email
- the operator's chrome shows `ORGS ADMIN` / `DEAL SETUP`, which render only
  for `super_admin` / `org_admin` — so the account is a platform admin whose
  staff assignment, if any, is filed under a different name

`/operator/me` returns the session's `id` and `property_id` and would settle
it in one lookup. That was not run; the hunt was stopped deliberately rather
than expanded.

### 📌 RECORDED, NOT CHASED — DUPLICATE OPERATING NAMES

Three distinct properties are named **"Solo on Chestnut"**
(`21197bb1…`, `79a5a8d1…`, `a50fbdd0…`). The production boot log seeds
`a50fbdd0…` as `solo-qa-baseline`. Any script that resolves a property by
name is picking one of three by luck — one already did during this release.
Resolve Solo by **id**, never by name, until this is cleaned up.

Also seen and not chased: `[slots] boot seed: +21 new, 0 existed` on the
release boot, `+0 new, 21 existed` on the next — idempotent, so it writes
once and then recognises its own rows. A boot-time seed in production is
still worth a look against §19–20 someday.

### WHAT CLOSES THIS RELEASE

One authenticated production pass by an entitled operator:

```text
Asset Management card appears
Asset Management opens
Insurance opens
governed Insurance economic truth renders
Cash & Financing remains honestly unestablished
── and the old 159 pair, still open ──
established Deal Setup property → "Lease & occupancy established"
genuinely unestablished property → still unestablished
```

Until then: **schema released, surface unconfirmed.** Say it that way.

### ⚠ OPEN RELEASE ITEM — THE PRODUCTION SURFACE IS NOT CONFIRMED

**Classify this precisely, because the two halves are not the same claim:**

```text
159 schema                          RELEASED and verified (ceiling 159)
static app/API contract             PROVEN in source
authenticated production surface    STILL REQUIRES HUMAN CONFIRMATION
```

159's identifier sweep renamed an API response key and not the app reading it.
Nothing threw, and the deal page silently showed "Setup in progress" for a
property whose position *was* established. Only a browser caught it.

**What is proven in source, and it is not nothing:**

```text
API  deal read emits   p.opening_tenancy_position_id   ← pinned by H16b
                       (tests/deal_setup_http.db.js:411, by name)
APP  index.html:26227  if (p.opening_tenancy_position_id)
                         true  → "Lease & occupancy established"
                         false → "Setup in progress"
```

Same key both sides, and the app-side fix (`9f037bf`) is ten commits deep on
`main`. That de-risks it materially. **It does not replace the check** — it
proves the code agrees, not that a real page renders.

**What still has to happen, by a human with a real staff session:**

1. A property **with** an established position renders
   *"Lease & occupancy established."*
2. A property **genuinely without** one still renders the unestablished state —
   so we know the condition was not flipped globally.

The second is not ceremony. A change that made every property read
"established" would pass the first check perfectly.

**⚠ IF THAT CHECK FAILS, INSPECT THE DEPLOYED APP SHA FIRST.** APP auto-deploy
is **OFF** — every app deploy is manual — so a stale app is a more likely cause
than the rename. **Do not reopen the identifier work before ruling that out.**

Until someone has run both: **the schema is released and the surface is
unconfirmed.** Say it that way.

### What this cost, and it is worth reading before the next release

For several days **every API merge was unshipped** — Asset Management, the Work
Orders resident projection, all of it — while Render kept serving `7c3da79`
(PR #83) and `/health` answered normally. **The service looked healthy while
running code from before 159.** That is the documented trap doing exactly what
it exists to do: `prestart` verifies rather than applies, refuses to boot with
a migration in the build and not in the ledger, and Render keeps the previous
instance live.

### ⚠ TRAP 1 — THE WEB SHELL ATTACHES TO THE SURVIVING INSTANCE

Measured on 2026-08-11, not assumed.

The Render Web Shell attaches to the instance that is **running**, which is the
**old** build — the one that never had 159. It does not attach to the build
that is failing to start. So:

```text
shell instance     7c3da79   several merges behind main
migrations/159_*   ABSENT from that filesystem
```

The instance that HAS 159 was precisely the one `prestart` refused to start.
Chicken-and-egg, and there is no path through the Web Shell.

Staging the file by hand does not work either: the container's clone is
**grafted (shallow)** and `git fetch origin main` fails — there are no repo
credentials in the runtime container.

### ⚠ TRAP 2 — `--apply` EXITING 0 IS NOT EVIDENCE A MIGRATION LANDED

Run in that shell, `node migrations/migrate.js --apply` reports
**"Everything was already up to date"** and exits **0**, having changed
nothing. It ran three times and was honest every time — there genuinely was
nothing pending *in that build*.

**A clean exit says the files present in THIS build are all in the ledger. It
says nothing about the file you are trying to release.** Before believing a
release, check the file is actually on disk:

```bash
ls migrations/159*          # is the thing you are releasing even here?
echo "$RENDER_GIT_COMMIT"   # which build am I standing in?
```

This is the same class of error as an empty-state pass: a true statement about
the wrong subject.

### THE WAY OUT — `prestart` CAN RELEASE, AND THAT DISSOLVES THE DEADLOCK

`package.json` runs `prestart` as `node migrations/migrate.js` with no
`--apply`. But `migrations/migrate.js:66`:

```js
const APPLY = process.argv.includes("--apply") || process.env.MIGRATION_RELEASE === "1";
```

**`MIGRATION_RELEASE=1` as a SERVICE ENV VAR makes `prestart` itself release.**
So the build that HAS 159 — the one currently refusing to start — applies 159
on its own next boot attempt and then boots. The deadlock dissolves because the
build holding the file is the build running prestart.

This needs no laptop, and **the production connection string never leaves
Render**, which is better than the alternative on its own merits.

```text
1.  From the SURVIVING shell, read-only, get the true ledger ceiling:
        node migrations/migrate.js          (no --apply — verify-only)
    It prints the ceiling. Do not type a remembered number.

2.  On the API service, set three env vars:
        MIGRATION_RELEASE=1
        EXPECTED_LEDGER_CEILING=<what step 1 printed>
        EXPECTED_SHA=<the SHA of current main you are deploying>

3.  Deploy current main. prestart applies, then the service starts.

4.  DELETE MIGRATION_RELEASE IMMEDIATELY.

5.  Browser check, not SQL: the deal page must read
    "Lease & occupancy established" for a property that has one.
```

**Two independent guards make a second, accidental release refuse** — both
measured in `migrate.js:327–355`. `EXPECTED_LEDGER_CEILING` no longer matches
once 159 applies, and `EXPECTED_SHA` is pinned to one build. That is real
safety, and it is not a reason to leave `MIGRATION_RELEASE` set.

### SEQUENCING — SATISFIED, AND STILL LIVE FOR THE NEXT ONE

159 was released **before** the Asset Management branch merged, which was the
point: **a release applies EVERY pending file** and there is no per-file
selection. `claude/property-spine-thread-handoff-i7hj0u` carries migrations
**160** (asset-management module entitlement) and **161** (insurance economic
truth), neither of which has its own release receipt.

They are now the next pending pair. Merging that branch makes them pending on
`main`; releasing them is a **separate deliberate act** with its own ledger
read (ceiling will be **159**) and its own `EXPECTED_SHA`. Do not let a future
159-shaped emergency sweep them in as a side effect.

### Not a blocker for Asset Management, and it is worth being precise

Asset Management does **not** read `opening_positions` /
`opening_tenancy_positions`. Checked: nothing in `src/asset/`,
`src/surfaces/asset_management.js`, or migrations 160/161 references either
name; the chain queries `leases`, `deal_intake_properties` and its own
insurance tables. It is blocked the way *everything* is blocked — nothing has
shipped — not by a schema dependency, and it deploys correctly on either side
of the rename.

---

## ══════════════════════════════════════════════════════════════════
##  FOUR OPERATING DOORS. ASSET MANAGEMENT IS THE FOURTH.
##  2026-08-11. THIS SECTION WINS ON PRODUCT DIRECTION.
## ══════════════════════════════════════════════════════════════════

**This is a product-direction change and it retires a reserved name.** Every
older statement in this file, in `CLAUDE.md`, in `PHILOSOPHY.md` and in route
comments that said *"Asset Management is reserved for the owner surface"* is
**superseded**. Those statements have been corrected in place.

### The canonical product structure

```text
LEASING      MANAGEMENT      MAINTENANCE      ASSET MANAGEMENT
```

**Asset Management is a staff/operator-side OPERATING door**, parallel to the
other three. The asset manager is still operating the deal — economically:
revenue, debt and capital structure, taxes, insurance, payroll, management fees,
utilities, contracts, and later budgets and variances.

**It is NOT the Owner / Investor surface.** That is a later, different audience,
potentially a different login, and it is now its own reserved name.

```text
Property Management / Operations → Asset Management → Owner / Investment Team
```

Progressive economic context and compression — **not one screen with different
permissions.**

### The sequence, and the build strategy

```text
ONBOARDING                            establishes opening truth
    ↓
LEASING · MANAGEMENT · MAINTENANCE    operate and continuously update
· ASSET MANAGEMENT                    living property truth
    ↓
REPORTING                             reads and closes/compresses it
    ↓
OWNER / INVESTOR SURFACE              later, different audience
```

**Build the operating middle deeply enough to know what truth it requires. Then
make onboarding populate it. Then make reporting read it.** Do not pre-design
financial onboarding or reporting before the middle exists.

### Asset Management hierarchy — four parts

Sub-labels may evolve; the four-part structure is the product direction.

```text
REVENUE               Rent · Vacancy · Concessions · Other Income
CAPITAL               Senior Debt · Mezzanine Debt · Preferred Equity ·
                      Reserves / Escrows
PROPERTY OBLIGATIONS  Taxes · Insurance · Licenses & Registrations ·
                      Compliance · Other fixed / recurring
                      ↑ what the asset must maintain simply because we own
                        and operate it — financial AND regulatory. Later:
                        rental licences, registrations, filings, tax
                        compliance, inspections, renewals. Compliance sits
                        HERE rather than as a fifth room — a lapsed licence
                        and an unpaid tax bill are the same kind of fact
                        from the asset's point of view. NO COMPLIANCE LOGIC
                        EXISTS; this is navigation only.
OPERATING COSTS       Payroll · Management Fees · Utilities · Contracts ·
                      Repairs / other operating expense
```

### Naming, routes and entitlement — frozen

```text
canonical name          Asset Management
canonical route         /operator/asset-management/*
canonical entitlement   asset_management  (a MODULE, in allowed_modules)
```

**`/asset/*` is NOT reused.** It remains Deal Setup's ⏳ Class 4 legacy alias
with its original retirement condition (a deploy with no
`deal_setup_legacy_alias` log line). Sharing the prefix would have made that
condition permanently unobservable.

**Module entitlement and job title are different facts.** Access is gated on
`allowed_modules` containing `asset_management`, exactly like the leasing gate —
never on the `asset_manager` role name. The future Owner / Investor surface must
NOT reuse this entitlement merely because it consumes Asset Management truth.

### Standing economics vs operating consequence — both, not either

```text
STANDING ECONOMIC TRUTH   governed terms already known — leases, debt documents,
                          tax obligations, insurance policies, contracts
OPERATING CONSEQUENCE     arises from operations — unexpected repair, turn
                          delay, concession, vacancy loss

normal governed expectation + unexpected operating consequence
    = the actual economic story of the property
```

The `$1,840` maintenance-consequence work is **PARKED, not discarded** (see the
Deal Setup section below and `docs/STANDING_ECONOMIC_OBLIGATIONS_SOURCE_READ.md`).
Do not let it define the current build.

### What is stale scaffolding, and must not dictate the new surface

Measured, not assumed:

```text
index.html money/capital/reporting region   SNAPSHOT-ONLY. __OFFLINE_MODE is
                                            assigned true unconditionally and
                                            never set false; getJSON() checks it
                                            FIRST, so every read is the baked
                                            snapshot and every write throws 405.
index.html:24376  CAPITAL_DEMO              FIXTURE FALLBACK — renders demo rows
                                            when real rows are empty. §19–20
                                            violation shape. Do not carry it into
                                            the new door.
src/money/*_cutover.js, economic_shadow.js  Class 3/4 MIGRATION INSTRUMENTS for a
fact_migration_preview.js,                  legacy pricing problem. Not product
economic_decision_room.js, pricing_rehearsal architecture.
src/money/economic_picture.js,              LEASING economics — what a LEASE
effective_pricing.js, governed_charges.js   CHARGES. Not what the PROPERTY OWES.
                                            Do not let this vocabulary into the
                                            Asset Management door.
src/surfaces/owner.js                       Despite the name: onboarding property
                                            cards + attention queue from ingest
                                            runs. NOT the owner surface.
ORG_MODULES / KNOWN_DESKS containing        The four-door model consolidates
'money', 'capital', 'reporting'             these. Left live (see below) but they
                                            are not the product direction.
```

---

## ══════════════════════════════════════════════════════════════════
##  DEAL SETUP / OPENING TENANCY POSITION — ON `main`, NOT CONFIRMED
##  IN PRODUCTION. 2026-08-11.
## ══════════════════════════════════════════════════════════════════

**This supersedes every state claim below it.** The Work Orders section
beneath is still correct about Work Orders; it is silent about Deal Setup
because Deal Setup shipped after it, from `6c577dc`.

```text
API  main  d726188   (this commit moves it — see the standing +1 note below)
APP  main  60a489c
next free migration number: 160
```

### ⚠ TWO THINGS ARE NOT CONFIRMED. DO NOT ASSUME EITHER.

**1. Migration 159 may not be released.** It was merged. Nobody has seen
evidence it was applied. The thread that shipped it had no production access
— outbound to `onrender.com` is blocked by the agent proxy — and neither did
the thread that wrote this section. Released and confirmed by query: **150–158**.
Ledger ceiling was **158** at last reading.

```sql
select version, name, applied_at from schema_migrations where version = '159';
```

**2. The human production pass through Deal Setup has not been reported.**
Ask before treating Deal Setup as proven in production. On the §33 ladder it
is **Proven** (real DB + real HTTP) and **Browser verified** in a harness —
it is not production-verified.

`docs/release/ledger_read_before_release.sql` is **current through 159** and
was re-derived from `origin/main`'s actual migration files during this
session — version-for-version identical, including the `125` and `138/139`
gaps. Run it, do not retype it. A hand-typed range is how 140 was missed.

### What shipped

Create a Deal → add a Property → upload its rent roll → establish lease &
occupancy → exceptions surfaced → persists → visible on the existing staff
Rent Roll.

**The load-bearing design decision: ONE activation writes BOTH substrates.**

```text
retained artifact
   └─▶ loadLedgerSnapshot ─▶ import_batches
                             import_source_rows      EVIDENCE
                             units · spaces
                   │
                   └── FK ──▶ proposed_records       DECISION
                                   │
                             confirm ─▶ persons · leases
                                   └─▶ produced_person_id /
                                       produced_lease_id written back
                                       onto the evidence row
```

Why, and do not "simplify" it: `GET /operator/rent-roll` — the staff Rent
Roll — reads `import_batches` → `import_source_rows` and overlays canonical
positions. An activation that wrote only canonical leases would establish a
position **the operator's own rent roll cannot show.**

**The evidence writer is NOT new code.** It is `loadLedgerSnapshot`, the
existing importer, called inside the caller's transaction. There is no second
importer. Keep it that way.

New services, all under `src/onboarding/`:

| module | what it is |
|---|---|
| `deal_setup.js` | routes, `/deal-setup/*` |
| `deal_service.js` | canonical deal writer |
| `activation_service.js` | activation + opening tenancy position |
| `source_artifact_service.js` | retained file (bytes, sha256, scope) |
| `rent_roll_field_map.js` | header mapping, reports its own work |

Migrations **153–159**. Read their headers; they carry the reasoning.

### Reserved names — this surface already spent one and was corrected

```text
Deal Setup                 onboarding machinery (what shipped)
Asset Management           ⚠ SUPERSEDED 2026-08-11 — see the top section.
                           No longer "reserved for the owner surface"; it is
                           the fourth OPERATING door, /operator/asset-management/*
Owner / Investor Surface   RESERVED — the later, different audience
Opening Tenancy Position   lease + occupancy, from a rent roll, as of a date.
                           Shown to people as "Lease & occupancy established"
Opening Operating Position RESERVED — tenancy + bank + debt + taxes +
                           insurance + contracts
Opening Accounting Truth   RESERVED — opening GL / subledger balances
```

This shipped as "Asset Management" and was renamed the next day. **That rename
was still correct** — Deal Setup is onboarding, Asset Management is operating —
and the reason it worked still holds: **renaming rendered text reserves
nothing**, so the routes, the module, the DOM ids and the function prefix all
moved with it.

`/asset/*` survives as a ⏳ **Class 4** alias inside `deal_setup.js`. It
rewrites to `/deal-setup/*` and **logs every use** (`deal_setup_legacy_alias`,
`src/onboarding/deal_setup.js:132`). **Removal condition:** a deploy with no
such line in the logs. Delete it then. It is not architecture.

`asset_management_console` survives as a `creation_source` **enum value**
(`migrations/154`, `159`, `src/onboarding/deal_service.js:42`). That is a
historical fact about how existing rows were created, not a name spend, and
it is labelled as such at every site. **Do not sweep it.**

### Traps this thread paid for

**A DEPLOY DOES NOT MIGRATE.** `prestart` runs `migrate.js` in **verify-only**
mode and refuses to start while anything is pending. Render keeps the old
instance live, so **the API looks fine while the schema is simply absent.**
Release deliberately:

```bash
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<read it, do not type it> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

On Render, set those three as env vars for **one** deploy, then **DELETE
`MIGRATION_RELEASE`**. This trap has now cost time three times.

**A CONSTRAINT IS A CLAIM ABOUT EVERY WRITER.** Migration 158's first version
widened `import_batches.source_type` after reading **one** writer, reached
production, and was refused by a row from a second writer **260 lines below
the first, in the same file.** There is now a test (H1) that scans every
writer in the repo.

**RENDERED IS NOT VISIBLE.** Deal Setup shipped writing every message —
success, failure, refusal — into `#receipt`, which sits in the app shell
**underneath** a `position:fixed` overlay. Real element, real text,
`display:block`, and invisible. `innerText` read it perfectly. Two rent-roll
uploads in a row looked like they did nothing.

- assert with `document.elementFromPoint` at the element's centre
- **scope selectors to the surface** — an unscoped `button:has-text('Review')`
  matched a button in the shell beneath the panel
- **provoke a REAL refusal through the real path.** An earlier proof called
  the app's own toast function, found it was not on `window` (the surface is
  an IIFE), silently skipped, and reported the channel broken.

**AN API OUTPUT KEY IS A CONTRACT.** A blunt identifier sweep in 159 renamed
a response key and not the app reading it. Nothing threw; the deal page just
showed "Setup in progress" for a property whose position **was** established.
Only the browser caught it — the HTTP proof was asserting the database, not
the response shape. Pin renamed keys with an assertion that reads them by
name (**H16b**).

### Verified in source during this session

Reported facts re-checked against the tree at `d726188`, so the next session
does not have to. This is a claim about **these** greps, not about the tree:

```text
deal_setup_legacy_alias      warns at src/onboarding/deal_setup.js:132
                             rewrite at deal_setup.js:131-135
bare_lease_writer_contained  refuses 410 at server.js:948-955
                             asserted at tests/deal_setup_http.db.js:445
ledger read file             version-for-version == origin/main migrations/
five new onboarding modules  all present under src/onboarding/
```

**Not checked:** production, anything over HTTP, the H1/H16b harnesses as
runs rather than as files.

### ⚠ NEW TRAP — `npm run verify` silently ran 9 of its 12 gates

On a **shallow clone** — which is what the agent container starts with —
`npm run verify` fails like this, on a clean tree, with no local changes:

```text
NOT PROVEN  every extracted line appears verbatim in the tenantlink original
            → HEAD~1 is unreachable (shallow clone or first commit)
✗ PARENT VALIDATION FAILED — conversation_intent_extraction.test.js exited 3
  3 gate(s) NOT RUN.
```

**The runner stops at the first non-zero child.** So the visible failure names
`conversation_intent_extraction`, and the *actual* cost is the line under it:
**three gates never executed at all.** Somebody reading the banner goes and
debugs intent extraction — a product module that is fine — and does not notice
that a quarter of the gate set produced no evidence either way.

This is not a false green. It is worse in one specific way: **a red that
points at the wrong subject and conceals a coverage hole.** The check itself
is honest — it says `NOT PROVEN`, not `FAIL`, and refuses to guess without
`HEAD~1`. The environment was the defect.

```bash
git rev-parse --is-shallow-repository   # true ⇒ your verify run is partial
git fetch --unshallow                   # then re-run
```

After unshallowing: **12/12 gates exit 0.** Do this *before* trusting any
verify result in a fresh container, and read the `gate(s) NOT RUN` count on
every red run — it is the part that is easy to scroll past.

### NEXT BUILD — ECONOMIC CONSEQUENCE V1. DESIGN FIRST.

**Do not write code until the four questions below are answered by the human.**
Gated on the production pass being green.

`docs/PHILOSOPHY.md` **§36–39 are new** (`c74d355`) and are the governing
doctrine for this build. Read them before designing anything:

```text
36  the layered architecture, and THE FORK: economic consequence descends
    from standing truth AND operating events alike
37  four users, four compressions; observation → confirmation → recognition
    is three dated facts, never one row edited three times
38  the owner surface; the Exposure contract; recorded fact and derived
    attribution are different epistemic classes
39  economic consequence ACCUMULATES — the stages are readings of a dated
    history, not statuses on one row
```

**THE GAP.** money → work exists (`src/money/attributions.js`, migration 045,
*"CAUSALITY: money event → operating record"*). work → money does not. *"The
repair uncovered another $1,840"* originates at the work order, before any
bank transaction, and has nowhere to live.

**⚠ FINDING THAT KILLS A PLANNED MIGRATION: `work_orders` needs NO
`completed_at`.** `work_order_progress` (migration 134) already carries
governed completion with its own `occurred_at`, and already separates:

```text
'completion_claimed'   the technician says finished
'completed'            the governed service closed it
```

with `note` holding their verbatim words and `source_comm_event_id` tracing
to a real message. **The knower-records / authority-confirms pattern is
ALREADY BUILT, for a different fact. Mirror it; do not invent it.**

**Precision on §39's closing accusation, measured this session.** §39 says the
shipped surface *"can never become $1,840, because there is no hook the
vendor's invoice can attach to."* The *hook* exists —
`work_order_progress` gives every observation a durable id, `occurred_at`,
verbatim `note` and comm-event lineage, and migration 136 already made
`comm_events.derived_from_progress_id` reference it. What is missing is that
**no economic relation can address it**: `attributions.js` relates money to
`work_orders` (`related_type='work_order'`) — one altitude too coarse — and
proxies completion with `wo.updated_at`, saying so in its own comment at
`attributions.js:40`. So the defect is **granularity and direction, not
absence.** EC V1 should relate to the progress row and consume
`work_order_progress` instead of `updated_at`. That is a much smaller build
than "there is no hook."

**THE FOUR QUESTIONS TO ANSWER BEFORE CODING:**

1. What exactly is the source claim? (technician, natural language)
2. What exactly does economic authority confirm?
3. How is historical Deal membership stamped?
4. How does revision / supersession preserve history?

**RULINGS ALREADY MADE — do not relitigate:**

- **STAMP `deal_membership_id`** (the `deal_intake_properties` row current at
  origin), never derive the Deal at read time. Migration 155 makes membership
  historical, so deriving would rewrite old economics when a property changes
  deals. Null if no governed membership. **Never backfill later.**
- **Direction-neutral from day one.** Do not put "expense" in the primitive's
  ontology, even though the first case is a work-order cost.
- **⚠ PARENT-NEUTRAL from day one.** This is *not* the same ruling as
  direction-neutral and was added by §36 after the list above was written. A
  lease earns rent, a note accrues interest, a tax schedule produces a bill —
  none has an operating event. **`economic_consequence.work_order_id NOT NULL`
  violates §36 on day one.** An EC relates to whatever actually caused it.
- **NOT** one mutable row marching expected→incurred→billed→paid. One stable
  economic subject, multiple dated facts and links (§39).
- No `expected_cost` column on `work_orders`, turns, tax bills or loans.
- `amount_cents` **bigint** — matches migration 045, which V1 must converge
  with. Never floating point.
- **Exposure is a CONTRACT, not a table.** Six questions, in `CLAUDE.md` and
  §38. Unknown magnitude is valid Exposure, **never zero**.
- **Sequence:** completion-time attribution → EC / work-order cost → Bank
  Accounts → **REVENUE Consequence V1** → broaden. The roadmap was
  accidentally expense-heavy; revenue causality (turn delay → rent at risk)
  must not lag five expense rails.

**Carried from §38, with no enforcement anywhere yet:** recorded fact and
derived attribution must render as visibly different classes, and derived
attribution must name the model that produced it. Its failure mode is
invisible — a derived number rendered as recorded looks exactly right. If it
is going to hold, the assertion has to exist **before** the first derived
number ships.

### DO NOT

- **Do not do opportunistic work on Deal Setup.** It is frozen pending the
  production pass.
- **Do not build the owner Asset Management surface.** It cannot narrate a
  cause that has no recorded fact behind it, and the causal Money graph does
  not exist yet. **Connect, then compress.**
- Do not build legal entities, journals, accrual engines, AP, invoice
  ingestion, or Opening Accounting Truth.
- **Do not install any front-end patch bundle without checking every symbol
  it references against the source first.** One was sent that wrapped eleven
  functions, of which **zero** existed; it would have renamed one button and
  reported success.

### Known, recorded, not fixed

- `leases` has **no `security_deposit` column** in the migration-built schema,
  yet the dormant activation module and the old bare `POST /leases` both wrote
  to one. **Production may have columns the ledger never created.**
- `deal_intakes.status` is still `created` / `files_received` / `classified`.
  No deal lifecycle vocabulary (`active` / `closed`) exists, which is why "one
  active deal per property" is enforced on **membership currency** instead.
- **Duplicate building in production:** 4233 Chestnut and Solo on Chestnut,
  283 units each. Business decision, untouched.
- `POST /leases` is contained (**410**) with a retirement condition: delete it
  once a deploy passes with no `bare_lease_writer_contained` log line.
- `seeds/seed_demo_slots.js` required `../staff_identity_resolver.js` (repo
  root — the module is at `src/identity/`). **FIXED this session**; see the
  cleanup note below.

---

## 2026-08-11 · MAINTENANCE WORK ORDERS — H CLOSED. ONE PRODUCT.

**Merged:** API `6c577dc` (PR #77) · App `5dd2548` (PR #43).
**Production:** schema readiness READY. Original Work Orders release smoke
check passed. Subsequent visual and resident-projection changes are merged and
locally/proof verified; production browser verification pending. Migrated:
nothing. No schema change in this slice.

Smoke check, on `property-spine-app.onrender.com`, Solo on Chestnut, artifact
`code_sha 5dd25483`: board opened, 4 real property-scoped rows, every row
carrying its reference (`refs 4 / rows 4`), ownership reading `KZ · NOT
ACCEPTED` / `Tom · NOT ACCEPTED`, `unavailable false`, no fixture rows, no
console error. `Take job` rendered on KZ's row and **not** on Tom's — the
server-derived acceptance rail holding in production. Detail `#1006` opened
with the same handle line as its row, one `What is happening` statement, a
`Next`, `Still needs work`, and `History` folded.

**RECORDED, NOT CHASED — the detail has no acceptance verb.** `action()` at
`work-lifecycle-door.js:368` returns `Take job` when the server says
`may_accept`, and only the LIST calls it. `detailHtml` builds its `Next` band
from its own two cases — `ask_photo` and `coordinate` — so a row the list
offers `Take job` opens into a detail that does not. Both surfaces are honest;
they are not the same object seen twice, which is what the contract asks for.
Found by reading source during the smoke check, not by a failing assertion —
no test covers it, which is the more useful half of the finding. Work Orders is
frozen, so this is written down rather than fixed.

**RULED 2026-08-11, for the next maintenance pass. This is a frozen decision —
do not re-derive it.** Acceptance is **not** list-only. List and detail are two
views of the same work order, so the dominant action must agree: if KZ sees
`Take job` on the row because `may_accept` is true, opening that work order
must still offer `Take job` as the dominant `Next`. *A user must never lose a
valid next action merely by opening the object.*

Implement **by subtraction, not another branch**: `detailHtml` consumes the same
canonical `action()` resolver the list does, instead of independently
reconstructing its cases. This is a projection-consistency fix. It is not a new
acceptance feature and it changes **no backend authority** — `may_accept` stays
server-derived and the write keeps refusing what the surface hides.

Removal condition — the parity proof that does not exist yet, four cases:

| viewer / state | list | detail |
|---|---|---|
| KZ, assigned + unaccepted | `Take job` | `Take job` |
| manager viewing KZ's assignment | none | none |
| Tom viewing KZ's assignment | none | none |
| after KZ accepts | gone | gone |

### The correction this section exists to make

This file said the retired closeout drawer was **"stranded legacy —
`renderDetail` → `workOrderPanel` is unreachable from any live route."**

**That was false, and it was measured false.** The drawer was reachable and
suppressed:

```
renderMaintenance() → real kind:'work_order' rows → the shared .lanes
  → a lane row's onclick → renderDetail()
    → kind==='work_order' → workOrderPanel()
```

`body.maintenance-v6-mode .lanes{display:none}` was the entire separation
between an operator and a second, complete maintenance application — its own
detail grammar, its own closeout controls, and a not-done picker reading a
HARDCODED reason list which, because index.html's `getJSON` is offline-locked,
was the only thing it ever rendered.

The claim at item 7 below — the `work_*` nav keys "reachable only from the
retired dashboard's own markup" — was also wrong in the same direction:
`openMaintenanceModule` dispatched four of them to live renderers. They were
unreachable only because the code emitting those keys happened to sit inside
the dead dashboard. **Reachability by accident, not by design.**

**H removed the second runtime path entirely.** 556 lines from `index.html`,
114 from `policy.js` / `property-spine-data.js`. Unreachable was never the
goal; absent is.

### What is true now

| | |
|---|---|
| one way into a work order | the tile → `openWorkOrdersDoor()` → `work-lifecycle-door.js` |
| one not-done path | `POST /operator/work-orders/:id/not-done`, staff-session scoped |
| one acceptance fact | `POST /operator/work-orders/:id/accept` → `technician/acceptance_service.acceptWork` |
| one proof interpretation | `proof-normalizer.js`, single interpretation point |
| fixture rails in the signed-in maintenance surface | none |

`.lanes{display:none}` **stays, and is not a concealment**: `leasing-v6-mode`
and `management-doors-mode` carry the identical rule — it is how every v6 desk
turns off the shared legacy shell. The lanes keep their proven
obligations-unavailable behaviour. What left them is work orders.

TWO FIXTURE LIBRARIES EXISTED. `__WO_FLOW_LIBRARY` was read inside the
maintenance dashboard path and is gone from all three files. `__WO_LIBRARY`
feeds `DEMO_DB` in the offline preview snapshot — the preview product's own
data — and stays; the guards prove the live door can see neither it nor any
offline rail.

### Two dimensions, not one

`current.state` is the physical lifecycle. `current.attention` is what Spine is
waiting on. `work_order.is_emergency` is how consequential the condition is.
A routed blocker is **In progress**; an unowned one is **Needs action**; an
emergency sorts first inside its band and does not change the band at all —
asserted structurally (`band()` may not read `is_emergency`).

### Evidence

| rung | result |
|---|---|
| `work_lifecycle_browser_proof` | **145/145** — real Chromium + real Postgres |
| `work_order_operator_seams.db.js` | **42/42** — real Postgres + real `server.js` |
| `proof_presentation_contract.browser` | 43/0 |
| `work_orders_reachable_when_obligations_fail` | 30/0 |
| APP source suite · H absence guard · banding | 23/23 · 24/24 · 34/34 |
| API `npm run verify` | 11/11 |

Playwright is now a declared devDependency with a lockfile entry, and the
browser rungs were re-run from a clean `npm install`. They are release
evidence and must not depend on a manual install again.

### Traps this slice paid for

1. **A green harness can be standing up the wrong system.** Six defects, and
   only one was in the product: the page served no `proof-normalizer.js`; the
   migration list stopped at 136 so governed completion silently rolled back
   through all of section 5; the teardown fought migration 137's append-only
   evidence chain; a token swap was wiped by `page.goto` and read the wrong
   property's queue while claiming an honest empty. Every one of them ran its
   assertions. None of them was looking at the system.
2. **Migration 012 cannot replay from an empty database.**
   `001_baseline.sql:238` creates `vendors` without `yardi_code`, so
   `012_bank_intake.sql:33`'s `create table if not exists` is a no-op and its
   index fails. Use the scoped-schema fixtures. **This is not a Work Orders
   problem and must not be repaired inside one.**
3. **Production schema readiness is a SEPARATE check.** "Can migrations replay
   from zero" and "does the deployment target satisfy this release's schema
   contract" are different questions. The second is required before deploying
   this slice and has NOT been done.

---

**Current as of API `main` @ `a9f51da`+ · APP `main` @ `6220ca5` · 2026-08-05 (late).**

> **The API SHA above is ALWAYS one commit stale, by construction.** Editing
> this file changes API `main`, so the number it records is the commit
> *before* the one that recorded it. The `+` is that gap, and it is not a
> mistake to correct — chasing it is an infinite loop. **For the API,
> `origin/main` and Render Events are the authority; this file is not.**
> The APP SHA carries no such problem: this file does not live in that repo,
> so `6220ca5` is exact.
Read the top section first — it wins over everything below it. Each dated
section supersedes the ones under it; nothing is deleted, because the reasoning
in the older sections is still the clearest account of how each trap was found.

This file went 33 commits stale once and was read by every new session as
current truth. Re-date it whenever `main` moves materially.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASE 0 IS BLOCKED ON ONE PRODUCTION COMMAND. 2026-08-10.
## ══════════════════════════════════════════════════════════════════

**Everything below this section about Release 0 sequencing is superseded.**
The base moved underneath the campaign, and that changed the order of work.

### The one thing that has to happen next

On the running production instance:

```bash
node tools/release0/gate1_production_census.js
```

Read-only, applies nothing, prints nothing containing the connection string.
Bring back the **entire** output. It decides everything else.

Nothing moves until then: Boundary 7 held, no migration applied, no Release 0
branch deployed.

### Why it is needed, and it is not what it looks like

`prestart` **verifies** rather than applies. Main is now `90ab03d`, which
carries migrations **150/151/152**. So a build refuses to start when its
migration files are not all in the target ledger — and refuses **equally**
when the ledger holds a version the build has no file for. Boundary 7 is
code-only and can still fail to boot for reasons that have nothing to do
with Release 0. Both directions are unmeasured.

### What is held

| | |
|---|---|
| API | `claude/boundary-7-step-6` @ `1dffe72`, rebased on `90ab03d`, `npm run verify` 11/11 |
| APP | `claude/release-0-audit-plan-55r5kd` @ `6993913`, suite 22/22 |
| deployed | nothing |
| migrated | nothing |

### Facts established, so nobody re-derives them

- **140 is independent of 138/139.** 138 creates one index, 139 widens one
  check constraint, and 140 references neither. Its references resolve to
  001 / 134 / 137, all in main. `prove_140_dependencies.js` 8/8. All six
  branches carrying 138/139/140 hold byte-identical definitions, so *the
  intended 140* is unambiguous (`0d34c0f10799`).
- **The 137 → 150 gap is not a finding.** Migration numbers need not be
  contiguous. Whether 138/139 matter is now purely a ledger question.
- **A release applies EVERY pending file.** There is no per-file selection
  in `migrate.js`. From a ledger below 150, releasing 140 also releases the
  property-creation schema. `prove_out_of_order_release.js` 19/19.
- **Out-of-order IS permitted**, and **applying 140 does not move the
  ceiling** — it stays 152, because the ceiling is the ledger max. Someone
  who reasons "I just released 140, so the ceiling is 140" gets refused and
  will assume the database drifted. Both measured against the real migrator,
  copied and sha256-compared before running.
- **`/health/migrations` is documented and does not exist.** No route defines
  it. `docs/deployment.md` corrected.

### The hard gate for 7b

Not migration numbers. Immediately before the deliberate 140 release, and
**not** on the first census:

```bash
EXPECTED_PENDING=140_post_activation_completion_guard.sql \
  node tools/release0/gate1_production_census.js
```

`fileMissingFromLedger` must be exactly that file and nothing else.

### Sequence (owner-set)

1. neutral census · 2. classify A/B/C/other · 3. re-freeze Boundary 7 on the
verified base · 4. deploy + prove 7 · 5. merge the exact 140 · 6. census with
`EXPECTED_PENDING` · 7. explicit schema release only if 140 is sole pending ·
8. verify clean · 9. fresh Release 0 census · 10. **stop for Boundary 8
authorization.**

**Case B** (150/151/152 not applied): finish that release under its own
closeout first. Do **not** let Release 0 become its release vehicle. Cutting
from a stale production SHA is an emergency escape hatch, not the sequence.
**Case C** (ledger holds 138/139/140, main has no files): hard stop. Find
which commit applied them and restore the exact definitions. Do **not**
document them away to turn verify green.

### Closed, do not reopen

Boundary 6 is closed on source + reachability evidence. ⚠ **THE "STRANDED
LEGACY" VERDICT BELOW WAS WRONG — see the 2026-08-11 section at the top.** The
drawer was REACHABLE through the desk's lanes and suppressed by one CSS rule;
H has since deleted it entirely. The paragraph is kept because the reasoning
that produced the wrong answer is the clearest account of how the reachability
question was framed. ~~The closeout drawer is **stranded legacy** —
`renderDetail` → `workOrderPanel` is unreachable from any live route~~; the work-order door (`work-lifecycle-door.js`) never had that
control. Browser acceptance belongs on the live door, not on a resurrected
drawer. `closeout_surface_reachability.test.js` 19/19, falsified 11/11 (APP).
The who-line fix (`KZ · ACCEPTED` / `KZ · NOT ACCEPTED` / `UNASSIGNED`) is
display-only and approved; `who_line_agreement.test.js` 23/23.

### Parked, under existing ownership

The chain cannot rebuild from empty — `012_bank_intake` fails on `yardi_code`.
Known and owned (UNBLOCK_2 §1, Appendix H). Not part of this release decision.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASE 0 IS READY TO RUN AND CANNOT BE RUN FROM HERE. 2026-08-09.
## ══════════════════════════════════════════════════════════════════

**The frozen RC is `claude/release-0-rc` @ `f6873d7`.** The production
activation sequence was called for and **was not executed**, for one reason:
**this session holds no production credentials.**

```text
DATABASE_URL · RENDER_GIT_COMMIT · GIT_SHA · TWILIO_*      all ABSENT
```

Probed by name, expanding nothing. `tools/release0/preflight_production.js`
exits 2 — *"REFUSED: DATABASE_URL is not set. This reads the real database and
will not invent an answer."* That refusal is the tool working, and the
credential is **not** to be requested: *"Do not send, paste or request a
production connection."*

**Nothing was simulated, and no step is marked done.** The rehearsal evidence
(`rehearse_release_train` 53/53, `prove_boundary_reversibility` 20/20,
`falsify_release_transitions` 26/26, `prove_migration_sequencing` 15/15) is
isolated-Postgres evidence about the *sequence*, not about production.

**The run card is `docs/release0/PRODUCTION_RUN_CARD.md`** — the ordered
commands, every environment variable named and never valued, and the stop
condition on each step. It reorders nothing; the sequence is still the runbook's
§5.1.

**The long pole is not engineering.** Step 4 is blocked on transport, and
transport is **two** independent blockers recorded read-only on 2026-08-06
(`docs/RELEASE_0_SMS_PREREQUISITE.md`): there is no `operations` line row at
all, and `provider_config` is null on the only line that exists. Add A2P 10DLC
carrier review on top. **Start that first — §1 of the run card can run in
parallel with it; §3 cannot finish without it.**

**Wording that must stay correct:** earlier Release 0 work already reached
production. What has not is the activation. Say *"no build-ahead activation work
in this stack has been run against production"* — not *"production is
untouched."*

**THE SMS RAIL IS FROZEN.** Do not do more SMS architecture unless the
production preflight contradicts the proof. The governing distinction:

```text
SMS_SEND_MODE=disabled          resident INBOUND stays live
                                resident OUTBOUND refused
                                → this is the Step 4 posture

property_facing.status=retired  resident line down BOTH directions, one property
                                inbound during retirement is LOST, not queued
                                → emergency line shutdown only, NOT an
                                  outbound control
```

**⚠ THE SMS SAFETY CONTROL IS `SMS_SEND_MODE`, NOT `outbound_policy`.** Twilio
credentials are global — one account behind both lanes — so wiring transport for
the operations line arms the resident path in the same instant. The invariant to
preserve through Step 4:

```text
Twilio credentials live + SMS_SEND_MODE disabled
  → technician operations replies work
  → resident outbound sends structurally refused
```

Source-proved by `tests/gate_outbound_senders.js` (S9: `sendOperationsReply`
does not consult the mode) and `docs/OUTBOUND_TRIGGER_AUDIT.md`. **Verify the
deployed mode BEFORE adding credentials, not after** — the §1 preflight scores
it and the acceptance receipt records it. Do not treat
`property_facing.outbound_policy = 'reply_only'` as protection: the policy
trigger never fires on a resident event. A second lever exists and is NOT
interchangeable: retiring the active `property_facing` line NULLs
`properties.sms_number` (it is a projection) so `sendPropertySms` refuses — but
it also kills INBOUND, which resolves to `inactiveLine` with zero rows written
and the resident's message lost rather than queued. Proven 12/12 in
`tools/release0/prove_line_retirement_consequence.js`. It is an emergency
line-retirement control, both directions; for outbound only, use the send mode.

**Build 1/2 is parked, not merged.** API `claude/build-1-2-rc` @ `d68cc1d`,
APP `claude/build-2-ask-spine-rc` @ `e867dd8`. One open integrity gap logged at
`docs/build1/INTEGRITY_GAPS.md` (an orphaned `obligations.related_id` splits
Capability 2's answer into two populations). **Not a Release 0 blocker** —
Release 0 never reads that column. Migration 142 / claim-accept likewise stays
out of the activation decision; the train does not depend on it.

---

## ══════════════════════════════════════════════════════════════════
##  ⛔ THE DEPLOYED APP IS BROKEN. 2026-08-06 (historical — see above).
## ══════════════════════════════════════════════════════════════════

**This supersedes the APP SHA in the header above and every deployment claim
below it.** APP `main` moved to `8cbfd1a` (step 1), and **that build has a
runtime defect on the work-order detail surface.**

```text
APP main          8cbfd1a   DEPLOYED · BROKEN
code-bearing      b79f192   SUPERSEDED — do not deploy
REPAIRED          44379d5   deploy this
APP rollback      6220ca5   still valid
API main          unchanged. No API deploy, no migration, no schema change.
```

**The defect.** Step 1 landed `proofOf` and `proofSentence` *inside*
`stateLine`'s body in `work-lifecycle-door.js`. Both hoisted into that one
function's scope, so `detailHtml` — a sibling — could not see them. Every
work-order **detail** render throws `ReferenceError: proofSentence is not
defined`. It propagates out of `render()` and rejects unhandled.

**Why nobody saw it.** `stateLine` is the one caller that could still reach
them, so the **list renders normally and hides the break**. Clicking a work
order does nothing at all — no error, no blank, no unavailable. A silent dead
click.

**The trap worth carrying forward.** Step 1's production pass recorded three
honest PASSes over this defect, because the operator's property had no work
orders and there was no row to click. **An empty-state pass is a true statement
about the wrong subject.** It is why that receipt refused to call itself
progress, and refusing was correct.

**Found by** `property-spine-app/proof_presentation_contract.browser.js` on its
first run — real Chromium against the real deployed file. Not by review, and
not by any amount of reading.

Full record: `property-spine-app/docs/RELEASE_0_STEP_1_PACKET.md` §9.8–§9.12.
Step 1 acceptance is now **eleven checks in one pass**, with the legacy
completion controls split out into a named owed item
(`property-spine-app/docs/LEGACY_COMPLETION_CONTROL_REGRESSION.md`).

**Also recorded there, for step 2:** `readPropertyWorkOrderStatuses` narrows
the list projection to three proof fields. Harmless today. The moment the
canonical writer emits four states, `legacy_indeterminate` and
`missing_evaluation_defect` arrive as illegal old-shape payloads and every such
row renders unavailable in the list while the detail renders it correctly.
Proven, not predicted — §9.10.2.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASE 0 — BUILD-COMPLETE ON BRANCHES. NOT DEPLOYED. 2026-08-08.
## ══════════════════════════════════════════════════════════════════

**This supersedes the "DESIGN FROZEN, NOT IMPLEMENTED" section below it.**
It does **not** change any deployment claim.

**Say this precisely, and do not shorten it:** *no build-ahead activation work in
this stack has been run against production.* Earlier Release 0 work — the
read-only production audit under Open Ruling 4, the Gate 4/8/9 tools deploy —
**did** reach production, and the record below is the account of it. "Release 0
has not touched production" is false and would corrupt the historical record.

What is true of *this* stack: `main` has not moved for it, none of migrations
138/139/140 has been applied to production, and **the activation has never been
run anywhere but an isolated clone.**

```text
claude/release-0-rc         ← THE RELEASE CANDIDATE. See
                            docs/release0/RELEASE_CANDIDATE.md for the SHA.
claude/release0-composed    the rehearsal tree the RC was cut from
claude/completion-guard     migration 140 alone, for review of that PR
claude/next-build-…         read-only intelligence for what comes AFTER
production                  no build-ahead activation work from this stack has
                            been run against it: no deploy, no 138/139/140,
                            no activation.
```

**Read `docs/RELEASE_0_ACTIVATION_STACK.md` first** — it is the current state of
the release: what is proven, what each boundary costs, and §7 names the exact
remaining proof debt. `RELEASE_0_ACTIVATION_RUNBOOK.md` is the production order.

Evidence as of this section: 48 harness runs / 0 non-zero / 757 assertions ·
16/16 source-governance gates · train rehearsal 53/53 · boundary reversibility
20/20 · release transitions 26/26 · migration sequencing 15/15 · app 107 + 17.

### The three things a new session most needs to know

1. **`migration 140` is frozen at revision 5 and the freeze bites.**
   `docs/release0/FROZEN_ARTIFACTS.json` pins sha256 digests;
   `tests/gate_release0_frozen.js` turns red the moment any pinned byte moves.
   Changing one requires re-running the falsification package **and** updating
   the digest **in the same commit**. Do not update the digest alone — that is
   the single thing the gate exists to prevent, and it has already caught two
   real changes.

2. **Boundary 8 (the activation) is irreversible, and it is the only one.**
   Measured, not inherited: `prove_boundary_reversibility.js` attempts eight
   undo mechanisms and all eight are refused. Boundary 3 is also one-way in the
   direction that matters — reverting Step 3 returns the *writer*, never the
   *data*. "Everything before 8 is revertible" is true about code and false
   about meaning; the runbook now says so per boundary.

3. **`closed` is historical vocabulary.** After the cutover, `open → closed` is
   refused outright with `R0003`, proof or no proof. Future completion writes
   `complete`. A harness or script that writes `closed` will be refused by the
   database, and that is the design, not a bug.

### Traps that cost real time this round

- **A proof against a re-implementation is a proof about the re-implementation.**
  The Step 7 concurrency proof measured a *simulation* of the lock and passed
  after a lock was added that it never looked at. It now reads the lock
  statement out of the shipped service. The same class of error appeared twice
  more as hard-coded counts in prose ("four functions, five triggers", "all five
  guard triggers") that had drifted three revisions out of date. Counts are now
  read from the database.
- **A gate that fails the fix is worse than no gate.** The first epoch freeze
  (R0006) also refused Step 7's *governed supersession*, breaking a legitimate
  correction path. Two Step 7 harnesses went red and were right to.
- **Harnesses re-apply migration 140**, so drifting the SQL file to falsify
  something gets silently overwritten. Drift the JS side instead.
- **`ALTER TABLE … DISABLE TRIGGER`** leaves the row in `pg_trigger` looking
  perfect and simply never fires. A presence check passes. Check `tgenabled`.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASE 0 — DESIGN FROZEN, NOT IMPLEMENTED. 2026-08-06. (superseded)
## ══════════════════════════════════════════════════════════════════

**Nothing below this section's deployment claims has changed.** No product
code, no migration, no schema change, no deploy. The section beneath still
governs what is live.

```text
Release 0 architecture   FROZEN at 4f25f73408d90376f45ea0cf501ddebc7bbff131
PR                       #43, open, BLOCKED from merge
gate 1 design            CLOSED — architecture frozen, do not revise further
                         unless implementation reveals a factual contradiction
gate 2 rotate credential OPEN   ← the only thing in front of implementation
gate 3 prove old dead    OPEN   ←
gate 4 phone-verify SMS  OPEN — release-step gate at deployment step 4.
                         Does NOT block steps 1–3. Step 5 and everything
                         after it may not proceed until a real handset, a
                         real inbound image, a preserved attachment, canonical
                         completion, and operator readback are all proven.
```

A read-only production audit ran under charter Open Ruling 4 and its receipt is
preserved. Governing documents: `RELEASE_0_IMPLEMENTATION_PLAN.md` (rev 3),
`RELEASE_0_APP_CLOSEOUT_AUDIT.md`, `RELEASE_0_COMPLETION_WRITER_MATRIX.md`,
`ASK_SPINE_BUILD_CONTRACT.md` §19c, `release-0-audit/RECEIPT.md`,
`CREDENTIAL_ROTATION_RUNBOOK.md`.

**Scope fence.** Release 0 is proof correction and completion consolidation.
No Ask Spine Build 1. No other maintenance scope. No compliance, vendor,
attention, authority-map, backlog or payment expansion inside it.

### ⚠ TRAP — the agent container was reclaimed mid-session

Partway through 2026-08-06 the working container was reclaimed. The local clone
came back rolled to `f9914ce`, **five commits behind**, with the newer files
simply absent from disk.

Nothing was lost, and the reason is the whole lesson:

```text
the remote branch was the recovery authority
no PUSHED work was lost
no UNPUSHED work should ever be considered durable
local workspace state is never the governing record
```

Recovery was `git fetch origin <branch>` then `git reset --hard origin/<branch>`.
Total cost: one command, because every unit of work had been pushed as it
completed.

**This is an operational lesson, not a product task.** It generalises the rule
this file already carries in another form — repo absence is not deployed
absence, and now: *disk presence is not repository truth.* Push at every
coherent step; treat anything that exists only on the container as already gone.

---

## ══════════════════════════════════════════════════════════════════
##  DEPLOYED AND VERIFIED — 2026-08-05 (late). THIS SECTION WINS.
## ══════════════════════════════════════════════════════════════════

```text
API   main   a9f51dac521c54958f0b3bcb2959a5df14c3db91   docs-only; auto-deploys (see note above)
API   verified deployed at 62db770313c851783172a0c401ab235be532467a  live 17:53 · healthy
APP   main   6220ca5907137aa9036adaee23e8fee78a88a3f0   DEPLOYED · confirmed in browser
ledger ceiling 136 · granted property "Solo on Chestnut" a50fbdd0-3642-431e-b532-0dcd6ab8a4fe
```

Every API commit after `62db770` has been **documentation only**. No product
code, no migration, no schema change. If Render shows a later SHA it is one
of those; if it shows `62db770` the auto-deploy of a docs commit has not
landed yet. Neither case affects behaviour.

## ▶ RESUME HERE — work is PAUSED, not blocked

Stopped 2026-08-05 evening at the owner's call: real-phone acceptance needs
two handsets and an uninterrupted hour, and there was no bandwidth for it.
**Nothing is mid-flight.** No pending migration, no half-applied change, no
unmerged branch, no exposure. Both services are deployed, live, and agree
with their repositories. This is a resting state.

**The single next action** is Part B of
`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md` — steps 14–18, real-phone acceptance
on Solo on Chestnut. Its preflight is three read-only SQL queries; if any
returns empty, the missing fixture is created as ordinary data, never as a
migration and never from `tests/`.

Do **not** restart from the top of this file. Everything above the "Open,
ranked" list is finished and verified.

**Both services are deployed, live, and agree with their repositories.** The
deploy questions that were open since the release are closed. Two items
previously listed as unproven are now proven, and one assumption in the
section below is DISPROVEN.

The release is **deployed and browser-verified. It is NOT phone-verified** —
that is the only product proof outstanding, and it is Part B of
`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`. Nothing is mid-flight: no pending
migration, no half-applied change, no unmerged branch. This is a coherent
resting state, not a paused one.

### The ledger ceiling is established, not carried

`136` is not a number copied forward from the last release. The build's
highest migration is `136_one_resident_update_per_cause.sql`, and the
`62db770` deploy **went live** — which only happens if the verify gate
passed, and that gate refuses to boot when a migration is in the build and
not in the ledger (see the 2026-08-03 section). A live deploy therefore
proves applied == build == 136.

### How to read the deployed APP SHA — do this instead of guessing

`build-info.js` is a **manual stamp** and was six days stale (`code_sha`
`9422d45`, stamped 2026-07-30). It cannot identify the running build and
must not be used for it. The Render Events page works but needs dashboard
access.

The reliable probe costs one line in the browser console and reads the
**running code**:

```js
String(renderMaintenance).includes('oblFailed')   // true ⇒ 6220ca5 or later
```

Pick any string that exists only in the build you are looking for. This
beats every indirect signal, including Events, because it interrogates what
is actually executing.

**The same trick does NOT work on the API, and nothing else does either.**
`/health` returns only `{ok, db_time}`. There is no `/version`, no commit,
no build, and no migration-status route anywhere in `server.js`. **The
Render Events page is the only way to read the deployed API SHA**, and the
applied ledger ceiling is not readable over HTTP at all — it must be
inferred from a successful boot (above) or read from Neon.

If this question is tiresome by the next release, a `/version` returning
`RENDER_GIT_COMMIT` and the applied ceiling is roughly ten lines and would
retire it permanently.

### ⚠ NEW TRAP, AND THE WORST ONE IN THIS FILE
### Deleting a file from git does NOT remove it from the Render static site

On 2026-08-05, with the deployed SHA **confirmed** as `6220ca5`, all nine
datasets deleted on 2026-08-03 still returned **HTTP 200 with their real
payloads** — 40KB to 881KB, `content-type` not HTML:

```text
/1438_seed.json      /1439_seed.json         /berks_1850_seed.json
/emergency_calls.json /greenery_seed.json    /skyline_1417_seed.json
/solo_4233_seed.json /temple_nest_seed.json  /solo-rent-roll-data.js
```

They are absent from the tree at `6220ca5`. Nothing references them.
**The commit is correct and the files are still served.** The artifact is
not in the repository — it is on Render's published directory, which is not
purged between deploys. **Redeploying the same commit changes nothing.**
The publish root must be purged, or the static site deleted and recreated.

Three rules follow, and each one cost time to learn:

1. **Repo absence is not deployed absence.** Every check before this one
   confirmed the files were gone from git. They were. That measured the
   wrong thing. The check must go over HTTP against the production origin.
2. **A status code is not a payload.** Static hosts commonly rewrite
   `/*` → `/index.html` with status 200, which makes every path "exist."
   Always fetch a path that has NEVER existed as a control. If the control
   returns 404, the server really does 404 and your 200s are real files.
   If the control returns 200, your 200s mean nothing. Then read the body.
3. **The `deskObligationsUnavailable` lesson generalises:** a surface can be
   correct in the repository, correct in the commit, correct in the build,
   and still wrong in production. Only production answers for production.

### The Aug-3 "security" datasets are SYNTHETIC — do not re-escalate

Ruled by the owner, 2026-08-05: the seed and rent-roll files are **fixtures,
not resident data.** One `resident_name` in `solo_4233_seed.json` is
literally `eggw3rhn, fgagevx`.

This matters because the artifacts lie about themselves.
`solo-rent-roll-data.js` opens with *"This file contains resident names and
property financial information… Do not publish this file in a public
repository,"* and the removal commits (`005a9b2`, `9c3386e`) are titled
"security: remove private datasets". **The labels say private; the contents
are generated.** A future session reading only the headers and the commit
messages will conclude there is a live breach. There is not.

**Check the contents before calling anything a breach.** The serving bug
above is real and worth fixing on its own merits — the next thing left in
that directory may not be synthetic.

### Work Orders no longer depends on the obligations desk

APP `6220ca5` (fix `208d403`). A failed `/operator/obligations` read used to
make the **live work-order door unreachable**: `renderMaintenance` called
`deskObligationsUnavailable()` and returned, which cleared `#intelStrip` —
the element carrying the four door tiles — and returned *before*
`lastMaintenance` was assigned, so even a surviving tile would have hit
`openMaintenanceModule()`'s `if(!st)` guard and toasted "Open Maintenance
first." Wiring the tile back alone would have fixed nothing.

The other four composed desks keep the whole-desk treatment on purpose:
obligations are folded into their payloads. Maintenance is the one desk
where that is not true.

**Two defects the proof found that review did not:**

- `body.maintenance-v6-mode .lanes{display:none!important}` — **the lanes are
  hidden on the Maintenance desk.** The first version of the fix rendered the
  honest unavailable state into those lanes, passed every lane assertion, and
  left the operator looking at a desk that appeared perfectly healthy.
  **Presence is not visibility.** The assertion that catches this measures
  `getComputedStyle().display` and a bounding box, not `querySelector`.
- `renderRows()` never cleared the `data-ps-state` marker
  `renderObligationsUnavailable()` stamps, so a recovered lane kept
  announcing an outage that had ended — the confident-wrong pointed the
  other way.

```text
APP  work_orders_reachable_when_obligations_fail.browser.js   30 passed · 0 failed
APP  run_harnesses.sh (18 × *.test.js)                        779 passed · 0 failed
APP  re-entry cycle at 6220ca5 (desk→door→job→desk→door)         7 passed · 0 failed
```

The obligations failure in that harness is a **real HTTP 503** through the
app's own frozen `__psLive` loader — no page function is patched. The stub
implements only the API's *server* contract (`maintenance.js:651`,
`operator.js:235`) and is never the thing that unwraps the `{data, meta}`
envelope; the real loader does that. Navigation is real clicks. Falsified
against a copied tree with the fix reverted: red, exit 1, naming the
unreachable door. Receipts: `docs/work-orders-obligations-failure/`.

### CORS IS PROVEN — this supersedes "must not be claimed" below

Observed in a real browser against production on 2026-08-05. A signed-in
operator opened the Maintenance desk and saw four tiles and **no**
obligations-unavailable banner. `loadObligations` is an authenticated
`x-staff-session` GET from the app origin to
`https://property-spine-api.onrender.com/operator/obligations`. The policy
at `server.js:101` **fails closed** — a mismatched `OPERATOR_APP_ORIGIN`
would have thrown and painted the banner. It did not. **The healthy desk is
the CORS receipt.**

### Open, ranked — carried forward

1. **Purge the Render static-site publish root** (or delete and recreate the
   service) so it matches the commit. Then re-verify the nine paths return
   404 *and* that a never-existing control path also returns 404.
2. **Real-phone acceptance, which IS the real-row production proof.**
   `ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`; its stop conditions are binding.

   Earlier drafts of this list carried "open a property that has work orders"
   as a separate item. **That item was impossible and should never have been
   written.** §21 means the operator's property is server-derived from the
   session grant, and `renderProperties`/`refreshPropSwitcher` hard-scope the
   picker to *only* the granted property — every other option is removed
   (`index.html:10655`). A signed-in operator cannot switch to a property
   with existing work orders; there is no such control, by design.

   The only way to get real rows in front of the operator is to **create**
   them in the property the session already grants. The activation script
   does exactly that, so acceptance and the real-row proof are one task.
3. **Two back controls on the Work Orders route**, and **seven orphaned nav
   keys**. Cosmetic, deliberately deferred until after acceptance.
4. **A write returning 200 with an unparseable body reports "Done."**
   Pre-existing, low likelihood, still a confident-wrong if it fires.

**CLOSED 2026-08-05 (late), do not re-open:** the deployed APP SHA, the
deployed API SHA, the applied ledger ceiling, cross-origin, and "find a
property that has work orders" (which was never possible — see 2 above).

### Not proven, and must not be claimed

- Everything under "Open, ranked" above.
- **Real-phone acceptance.** Both services are deployed and browser-verified.
  Neither is phone-verified. "Deployed" and "accepted" are different rungs of
  the §33 ladder and must not be reported as one.

---

## ══════════════════════════════════════════════════════════════════
##  RELEASED — 2026-08-05 (evening). THIS SECTION WINS over everything below.
## ══════════════════════════════════════════════════════════════════

Both repositories are merged, pushed, and released. Migration 129 was
activated, 130–136 applied, and the ledger reconciled. **The 2026-08-03
"`main` cannot boot" section below is RESOLVED — do not act on it.**

```text
API   main   d0627ce3945e14f01ba47033372a0f454b0af860   live · ledger ceiling 136
APP   main   17823a1100f2b431e1559b935c1f978b67c60402   see "what is actually deployed"
```

**Resident SMS → canonical work order → technician lifecycle → operator
action** is live. The technician holds an ordinary text conversation; every
fact they report is written canonically; the operator sees one queue where
every control performs a governed write and returns a receipt.

### ⚠ THE LESSON THAT COST THIS RELEASE A DAY

The feature was **built, proven, and deployed while being completely
unreachable.** `index.html` referenced `window.__psWorkOrders` **zero times**.
`Maintenance → Work Orders` opened a fixture dashboard reading
`window.__WO_FLOW_LIBRARY` — a static per-property array with invented
`(215) 555-01xx` resident numbers and no network call at all. A signed-in
operator saw sample residents where live work belongs (§19–20 violation).

It passed 99 browser assertions because the proof called
`window.__psWorkOrders.open()` **directly**. That proved the door worked. It
never proved anything *opened* it.

> **RULE, from the owner, 2026-08-05:** a surface is not shipped until the
> proof enters it the way the operator enters it. "The component works" and
> "the component is reachable" are two facts and need two assertions.

That was break **one**. Behind it sat two more, each independently fatal —
wiring the route alone would have fixed nothing:

- **THE LIVE SEAM WAS NEVER REGISTERED.** The door calls seven `__psLive`
  methods. None were in `PRODUCTION_LIVE_RESOURCES` / `WRITE_ACTIONS`. Even
  a correctly wired route would have thrown on the first read and rendered
  unavailable forever.
- **THE DOOR READ THE ENVELOPE AS THE PAYLOAD.** `__psLive` returns
  `{ data, meta }` from every read *and every write*. The door used the
  envelope directly — invisible against a harness stub returning bare JSON,
  an empty queue against the real loader. **The stub was modelling a
  contract production never produces.** That is what let it through.

A fourth, found only once navigation was real: `render()` prefers
`state.detail` whenever set and `open()` left it standing, so leaving for the
Maintenance desk and re-entering Work Orders dropped the operator on the last
job they had opened instead of the queue. Fixed in `17823a1`.

### What is actually deployed — READ THIS BEFORE DEBUGGING

**APP auto-deploy is OFF.** Every deploy is manual. On 2026-08-05 the live
door was confirmed in the browser by screenshot — correct header, `0 NEED
ACTION`, honest empty, no fixture names. **The exact deployed SHA was not
read from the Render Events page.** It is `badd5ea` or `17823a1`; both carry
the route replace, only `17823a1` carries the re-entry fix. **Confirm in
Render Events before assuming.**

API deploys on merge to `main`. Last verified live and healthy at `d0627ce`
with ledger ceiling 136 earlier on 2026-08-05.

### Proof state at release

```text
API   database + HTTP suites                       399 assertions green
APP   run_harnesses.sh (18 × *.test.js)            779 passed · 0 failed · 0 red
APP   work_lifecycle_browser_proof.browser.js      144 passed · 0 failed
```

The browser proof now has **two** entry proofs and keeps both. Section 9c
drives the deployed `index.html` and every script it loads, a session
rehydrated the way a reload does it, and a real click on the real
`Maintenance → Work orders` tile — with the pinned production origin routed
to the harness API at the transport layer, so the app's own **frozen**
`__psLive` loader builds every path, header and body. Nothing in the page is
patched to make it pass. All four operator writes cross that real loader.

Run it:

```bash
HARNESS_DATABASE_URL="postgresql://<user>:<pw>@127.0.0.1:5432/postgres" \
  node work_lifecycle_browser_proof.browser.js      # in property-spine-app
```

### Traps this release created or exposed

1. **A harness that silenced its own death.** `work_lifecycle_browser_proof`
   intercepts `console.error` to keep expected route noise out of the log —
   and silenced `receipt.died()` with it. A harness that died printed
   *nothing* and read like a clean stop. It cost a full debug cycle. Now
   restored before reporting. **If you add a console.error sentinel to any
   harness, never let it swallow the receipt.**
2. **`window.__OFFLINE_MODE = true` is assigned unconditionally**
   (`index.html:4593`) and is never set false anywhere in the repo.
   `getJSON()` checks it *first*, so **every** `getJSON` read in `index.html`
   is answered from the baked snapshot and every write throws
   `405 read-only snapshot`. This is by design: `index.html` is a historical
   snapshot shell, and live operator work happens in the door modules through
   `__psLive`. **Do not "fix" `__OFFLINE_MODE`. Do route new live work
   through `__psLive`.**
3. **`__psLive` is frozen, non-writable, non-configurable, and pinned to the
   production origin.** You cannot override it from a test. Redirect the
   origin at the transport layer instead (Playwright `page.route`), and
   rehydrate a real session through `sessionStorage.__ps_staff_session__` —
   the loader's own reload path.
4. **A feature stylesheet was appended inside the shared `.wrap` frame's
   `<style>` block**, putting dozens of ordinary `padding:` shorthands into
   the slice `shared_frame_proof` reads. It was red on `main` from the
   moment the Work Orders release merged. Feature CSS gets its own `<style>`
   tag. Document order — and so the cascade — is unaffected.

### Known-and-accepted, NOT defects to re-litigate

- **The Coordinate entry control is absent once the resident has been asked.**
  That is the §7.1 ruling (migration 136), not a regression. Do not restore it.
- **`137` is the next free migration number.** Re-read the ledger and scan all
  branches before authoring it.
- **The full schema still cannot be rebuilt from empty** —
  `012_bank_intake.sql:44`, `column "yardi_code" does not exist`. Predates
  all of this and bounds every proof to the scoped schema.

### Open, ranked — carried into the next thread

1. **Confirm the deployed APP SHA in Render Events**, and redeploy `17823a1`
   if it is anything older.
2. **Verify rows render in production.** The 2026-08-05 confirmation was on
   Property Spine Demo Building, which has no work orders — an honest empty
   proves the read succeeds, not that it reads *right*. Open a property that
   has work orders.
3. **Confirm the private datasets 404.** Rent-roll and seed JSON were
   publicly served from 2026-08-03 because the security commits merged but
   were never deployed. Deploying the app should have closed it. **Unverified.**
4. **Real-phone acceptance** — `ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`, the
   script at the end. Stop conditions are listed there and are binding.
5. **A failed `/operator/obligations` read makes Work Orders unreachable.**
   `renderMaintenance` (`index.html:11534`) bails to a desk-wide unavailable
   banner with **no tiles at all**. The live door has no dependency on
   obligations; the *route* to it does. Real coupling, deliberately left
   outside the hotfix scope.
6. **Two back controls on the Work Orders route** — the app bar's
   `‹ BACK MAINTENANCE` and the door's own `‹ MAINTENANCE`. The Unit Turn
   route solved this with a header slot; this one has not. Cosmetic.
7. **Seven orphaned nav keys.** ⚠ **CORRECTED 2026-08-11 — this was wrong.**
   `openMaintenanceModule` dispatched `work_inprogress`, `work_done`, `proof`
   and `work_closed` to LIVE renderers; they were unreachable only because the
   code emitting those keys sat inside the dead dashboard. Reachability by
   accident. H routes every `work_*` key to the canonical door and deleted the
   renderers. ~~reachable only from the retired dashboard's own markup~~
8. **A write returning 200 with an unparseable body reports "Done."**
   `writeAction` yields `data: null`; the door falls back to `{}`. Pre-existing
   shape, low likelihood, but it is a confident-wrong if it ever fires.

### Not proven, and must not be claimed

- **CORS is not exercised by the browser proof.** Playwright's `route.fulfill`
  bypasses it entirely. It is covered *by construction* — `server.js:101`
  applies `operatorCors` to every `/operator/*` path with `x-staff-session`
  on GET/POST, and the app already signs in through that same middleware —
  but it **fails closed** if `OPERATOR_APP_ORIGIN` does not exactly match the
  app origin.
- Everything under "Open, ranked" above.

---

## ══════════════════════════════════════════════════════════════════
##  BRANCH STATE — 2026-08-05 (earlier). SUPERSEDED by the release section above.
## ══════════════════════════════════════════════════════════════════

`main` has NOT moved. It is still `8330aec` and it still cannot boot, for the
reason the 2026-08-03 section below explains: migration `129` is in the build
and in no ledger. Everything in that section is still true.

What is new is a complete, proven, **unmerged** feature branch.

```text
API   claude/conversational-seams-and-technician-loop   contains origin/main 8330aec
APP   claude/sms-work-order-handoff-qo3s8i    11193f4   origin/main 357fb15 MERGED IN
migrations added                                        130 – 136
```

**Resident SMS → canonical work order → technician lifecycle → operator
action.** The technician holds an ordinary text conversation; every fact they
report is written canonically; the operator sees one queue where all five
controls perform governed writes and return receipts.

**399 database-and-browser assertions green, re-run 2026-08-05**, including
`work_lifecycle_browser_proof.browser.js` at **99/99** — real Chromium, real
HTTP, real Postgres, every control clicked.

### Read these two documents before touching any of it

- [`RELEASE_SMS_WORK_ORDER_HANDOFF.md`](RELEASE_SMS_WORK_ORDER_HANDOFF.md) —
  what ships, what proves it, component classification, and **§7: the ruling
  that closed the duplicate-message defect, and the one limit that bounds what
  may be claimed.**
- [`ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`](ACTIVATION_SMS_WORK_ORDER_HANDOFF.md) —
  the 19-step operator packet and the real-phone acceptance script.
  Self-contained; no thread can run any of it.

### One ruling landed, one limit remains

1. **RULED AND CLOSED — never ask the resident the same thing twice.**
   Reporting no access already texts the resident the coordinate-entry
   sentence; the operator control sent byte-identical text and its guard could
   not see the first message. Migration **136** makes
   `comm_events.derived_from_progress_id` unique, so both writers now resolve
   against the same canonical cause and the database refuses the second
   message. The surface reports *"Asked resident at 10:04 AM · waiting for
   reply"* and the control only exists where nobody has asked. The index is
   SCOPED — outbound / sms / work_order_update / resident — so a field fact can
   still be referenced by other message types; widening it would block
   legitimate references. Full ruling and its proof: release package §7.1.

   **Do not "restore" the Coordinate entry button on a work order whose
   resident has been asked.** Its absence is the ruling, not a regression.
2. **The full schema still cannot be rebuilt from empty.** Re-verified
   2026-08-05: `012_bank_intake.sql:44` — `column "yardi_code" does not exist`.
   This bounds every proof to the scoped schema, and predates this work.

### Activation order is a gate, not a preference

`129` first (`UNBLOCK_1_MIGRATION_129_ACTIVATION.md`), **then** `130`–`136`.
Releasing onto a `128` ledger would sweep `129` in without its own receipt.

Reconcile with `main` by **merge**. Never rebase, never force-push — both
branches already carry merges from `main`.

---

## ══════════════════════════════════════════════════════════════════
##  STATE — 2026-08-03 (late). SUPERSEDED — `main` boots; 129 is released.
## ══════════════════════════════════════════════════════════════════

### ⚠ `main` CANNOT BOOT RIGHT NOW. That is deliberate.

Migration **129 is in the build and in no ledger**, so the verify gate refuses
to start and Render keeps serving the previous build. **Production looks healthy
while running older code.** This is expected, not a regression — the fix is to
release 129, not to revert.

```text
source  main        4983e5d      repository migration ceiling 130 (on the Slice A branch)
production          d3698d3      APPLIED ledger ceiling 128
divergence          deliberate, pending the 129 activation receipt
```

Merging anything to `main` does not make this worse; the red is caused solely by
129 already being there.

### The migration state, exactly

```text
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125   (never applied anywhere; staged outside the runner)
claimed, unreleased:           129 (property-line uniqueness, on main)
                               130 (communication lines, on the Slice A branch only)
next free number:              131 — RE-READ THE LEDGER AND SCAN ALL BRANCHES FIRST
```

**Do not reuse 125.** Authoring a new one behind live 126–128 backfills the
sequence and creates a second misleading migration story.

### There is now a required validation path — USE IT

```bash
npm run verify        # source-governance gates; DB-free; no credentials needed
```

Before this existed, the repository had **three gates and nothing invoked any of
them** — no CI, no `npm test`. `gate_closure_boundary.js` was blind since a
directory move and nothing noticed, because nothing ran it. `deploy.sh` now
invokes `verify` before triggering a deploy, under `set -e`.

### ⚠ THE HARNESS-ISOLATION FINDING — measured, contained, NOT repaired

An audit **by connection rather than by filename** found:

```text
87  scripts across tests/ and tools/ build a connection from DATABASE_URL
    with no guard  —  67 of them WRITE-CAPABLE
 5  more require HARNESS_DATABASE_URL but never perform its same-target refusal
 8  covered by the historical *.db.js convention
17  genuinely guarded harnesses
```

**On Render, `DATABASE_URL` is production.** These are unsafe **capabilities** —
not evidence any has run against production. `tools/` is the dangerous half: it
holds `retire_hollow_leases`, `repair_invalid_task_owners`,
`remove_duplicate_walkins`, `seed_*`.

`tests/gate_harness_isolation.js` freezes the inventory as a **debt register**
(path · measured write-class · provisional use · reason · removal condition) and
**fails on growth**. It does NOT make the existing inventory safe.

**Operational rule, effective now:** do not run any test, proof, seed or repair
script directly from a production Render shell unless it is explicitly
classified as structurally read-only. **`.db.js`, `_proof.js`, `smoke` and
`test` are names, not evidence of safety.**

Remediation is its own governed slice **after** Slice A. Do not mass-replace
`DATABASE_URL` across 87 files — that would create 87 unexecuted safety claims.

### Slice A — built and proven, NOT merged

The canonical communication-line model (migration 130) lives on
`claude/sms-work-order-handoff-qo3s8i`, proven **61/61** against isolated real
PostgreSQL 16.13 and real HTTP at SHA `95f13c7`.

**It is not on `main` and not in production.** Merge is blocked on: the 129
activation receipt; re-reconciliation with current `main`; repair of two unsafe
harnesses in its own proof set (`work_order_authority_proof.js`,
`work_order_canonical_path_proof.js`); and the five full-schema harnesses running
at the merge-candidate SHA. Full sequence: `docs/SLICE_A_MERGE_CHECKLIST.md`.

> **"Previously green before the resolver changed" is not evidence for the
> changed resolver.** Slice A changed `resolveInboundSmsContext`, which is the
> exact function `resident_sms_route_proof.js` exercises.

### Read these before building anything new

| Document | Why |
|---|---|
| `docs/PHILOSOPHY.md` | the specification, not preamble |
| `docs/MONEY_THESIS.md` | operations-first, accounting-derived; **cash vs accrual is an OUTPUT choice** — never force a basis at capture |
| `docs/AGENT_CAPABILITY_SEAMS.md` | the SMS path is the agent's first bounded capability; three of six seams are transport-co-located, with an exact extraction trigger |
| `docs/COMMUNICATION_LINE_MODEL_DESIGN.md` | approved design; org context is NOT property context |
| `docs/DB_HARNESS_ISOLATION.md` | the finding above, in full |

### The order

```text
129 activation receipt
→ reconcile Slice A with current main
→ repair and prove its two unsafe harnesses
→ full proof set at the merge-candidate SHA
→ merge and activate Slice A
→ Slice B: retire properties.sms_number
→ repository-wide harness-isolation remediation
→ operations-number activation and technician loop
```

### Open cleanup, oldest first

- **Production synthetic rows** — inventoried in `DB_HARNESS_ISOLATION.md`,
  **never deleted**. Under derived reporting these are not stray rows; they are
  fabricated operating events that become numbers. Needs an ID-based,
  dependency-ordered dry run and owner approval.
- **ITEM 2** — `conversation_owner_user_id` conflates attribution with
  ownership. Now in the money path: attribution is what makes a derived number
  auditable.
- **Migration 125** — staged outside the runner, never applied, unresolved.
- **`src/shared/no076_failclosed_check.js`** — dead, classified, not removed.
- **Stale paths from the reorg** — three found, "assume more". Nobody has swept.

---

## ══════════════════════════════════════════════════════════════════
##  HANDOFF — 2026-08-03 (earlier). Superseded in part by the section above.
## ══════════════════════════════════════════════════════════════════

Where this conflicts with anything further down this file, **this section wins.**
Everything below the marked history line describes an earlier state.

---

### 0. The doctrine is not preamble. It is the specification.

`docs/PHILOSOPHY.md` is not style guidance you skim before writing code. It is
the thing the code is judged against, and on this project it has repeatedly been
the *fastest* route to the right answer — not a tax on it.

Every significant decision recorded below was **derived** from a numbered
principle, not decorated with one afterwards. §6 in this handoff shows the
derivations in full, because the pattern matters more than any individual
outcome: **when we reasoned from doctrine we got it right the first time, and
every time we skipped that step we had to come back.**

The five that governed this session:

| | Principle | What it actually forces |
|---|---|---|
| **§5** | Honest Blank Beats Confident Wrong | A missing owner reads `UNASSIGNED`. A test that proves nothing reports `RUN INVALID`. A harness that cannot verify its own safety **refuses to run**. Silence is never evidence. |
| **§17** | One Canonical Architecture | One meaning per fact, one implementation per rule. Two copies of one engine is a defect even while they agree, because agreement is not a mechanism. |
| **§18** | Classify Every Component | Anything temporary carries an explicit class and an exact removal condition. `properties.sms_number` is a temporary adapter — say so, in writing, with what retires it. |
| **§21** | Server-Derived Identity and Authority | The browser requests; the server decides. A caller may never supply the fact that authorises it. This is why `recognizeObligationMissed` derives its own threshold. |
| **§33** | Definition of Done | Reported → Locally exercised → Built-but-dormant → **Proven** (real DB + real HTTP) → **Browser verified**. Naming your rung honestly is the whole discipline. |

And §32's stop-signs are live tripwires, not a list to nod at. *"We'll wire it to
the real path later"* and *"we can clean up the history after"* both appeared in
this session's work and both turned out to name a real defect.

---

### 1. The mission

```
resident texts the property line in their own words
  → Spine records the claim ONCE as a canonical work order
  → it routes to one accountable human, or stays honestly UNASSIGNED
  → the technician executes and proves it, by text
  → verified status returns to the resident
```

The resident never learns the system. The technician never opens an app. The
truth is captured at the moment of work and every surface reads the same record
(§7, §35).

**Roughly 60% complete.** The resident-facing half is live and proven. The staff
execution loop does not exist yet.

---

### 2. What is LIVE on `main` and honestly proven

`main` is at `a08c1da`.

**The migration state, exactly.** Read from the production ledger 2026-08-03,
not inferred from `ls migrations/`:

```text
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125
repository migration ceiling:  129
applied migration ceiling:     128  (until 129 is released)
```

**125 never ran.** It is absent from the production ledger *and* from
`migrations/` — it is staged at `docs/slices-6-to-10/deployment_b/`, outside the
runner. The sequence is NOT contiguous and nothing should be written as though
it were. An earlier version of this file said "120–128 unbroken"; that was
wrong, and it was wrong in the direction that matters — it implied a number had
been used when it had not.

**129 is CLAIMED** (`129_property_line_uniqueness.sql`, merged in `a08c1da`) and
**not yet released**. The next free number is **130**. Because 129 is in the
build and not in the ledger, a deploy of current `main` will correctly REFUSE TO
START until it is released — see `docs/PROPERTY_LINE_ACTIVATION.md`.

| Capability | Proof | §33 rung |
|---|---|---|
| Resident SMS → canonical work order | `resident_sms_work_order_proof.js` **78/0**, `resident_sms_route_proof.js` **31/0**, real Postgres + real HTTP, isolated DB | **Proven** |
| One obligation engine (`src/shared/obligation_engine.js`) | one-implementation **14/14**, import smoke **8/8** | **Proven** |
| Durable missed recognition (`src/shared/obligation_missed.js`, migration 126) | conversion rail **15/15**, production smoke **23/23** | **Proven**, live in production |
| Migration release gate (ITEM 5) | gate test **11/11** + real-Postgres verify, exit 0 | **Proven** |

**None of it is Browser verified.** Per §33 that matters and must not be blurred:
for operator workflows, browser verification is part of done. Say "proven at the
service layer" and stop there.

The two SMS harnesses are worth studying as a model. The work-order proof states
in its own output: *"17/22 exercised here; 5 require an HTTP-level harness (cases
5, 9, 10, 11, 14). Those five are NOT proven by this run and must not be reported
as such."* The route proof then proves exactly those five. **A harness that
polices its own claim is doing §5 in the only place it counts** — where nobody is
watching.

---

### 3. Traps, each with the principle it violates

**A deploy no longer migrates production — do not undo this.** `prestart` runs
`migrations/migrate.js` in VERIFY mode. Every migration file must already be in
the ledger, or the service **refuses to start** and names the pending file.

It does **not** skip and boot. Skipping would trade a silent schema *change* for
a silent schema *mismatch* — new code against an older database, which is §5's
confident-wrong wearing a hard hat. Releasing is deliberate:

```
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=<what you just read> \
  EXPECTED_SHA=<deployed sha> node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so **a release cannot be run by someone who has
not read the ledger.** That is §21 applied to deployment: the operator asserts
what they believe, and the system refuses if reality disagrees.

**No harness may target production.** Every `.db.js` requires
`HARNESS_DATABASE_URL`, with no fallback, and refuses when it resolves to the
same host/port/database as `DATABASE_URL`. The sole exception is
`tests/prod_smoke_missed_readonly.js`, which runs inside `BEGIN TRANSACTION READ
ONLY` and **proves** it cannot write before reading anything.

**`now()` inside a transaction is the transaction's start time.** This produced a
false green that survived review. Ordering by it is meaningless within one
transaction.

**Absence of red is not green.** `test_conversion_rail.db.js` threw at
construction and ran **zero assertions for 204 commits** while reading as
passing. Every critical harness now prints `ASSERTIONS STARTED`, an expected
count, a completed count and an exit code, and reports `RUN INVALID` when it runs
fewer than expected (§5).

**`$?` after a pipeline is the pipe's status, not the program's.** This misled
this session three times. Never pipe a harness whose exit code you intend to
read.

**The reorg left stale paths.** Three found so far — `test_release3.db.js` (two
`readFileSync` paths), `gate_closure_boundary.js` (a regex that made the gate
**blind** since the move), `seeds/seed_demo_slots.js` (still failing softly at
boot). Assume more. A gate that cannot see is worse than no gate, because it
reports safety it is not providing.

---

### 4. Open rulings — do not decide these alone

**ITEM 2 — `conversation_owner_user_id` conflates attribution with ownership.**
Written from a host claim without eligibility resolution, read by operating logic
at `leasingconversion.js:385`, and labelled **"owned by"** on two desk surfaces
next to a separate "toured by" field. The column is `NOT NULL`, so §5's honest
blank is *unrepresentable by construction*. Property Spine deliberately keeps
attribution, eligible assignment, task ownership and authenticated authority
separate (§10, §21); this column straddles all four. Full audit in
`BLOCKING_DESIGN_ITEMS.md`. **Blocks conversion-rail activation, not the SMS
loop.**

**Production fixture cleanup.** Earlier harness runs committed synthetic
properties, users, persons, prospects and obligations into production.
Inventoried read-only in `DB_HARNESS_ISOLATION.md`; **nothing has been deleted.**
The conversion-rail rows carry *no marker at all* — ordinary human names, no
email, and a property literally named `Solo on Chestnut`. **Never infer that a
row is synthetic from its name.** Cleanup needs an ID-based, dependency-ordered
dry run and explicit owner approval. Note `069` sets `ON DELETE RESTRICT`
deliberately: history is not cascade-deletable, and that is a feature.

**The missed-recognition human path is unexercised.** Migration 126 is live and
the primitive is proven, but no operator UI ever sends `result: 'missed'` — the
route accepts it, nothing calls it. Five eligible Demo Building candidates exist.
Do not manufacture one by backdating a `due_at` (§32: *"we can clean up the
history after"*).

**`RESOLUTION_BASES` has no vocabulary for "the window elapsed."** It offers
`coverage | manager_intervention | completed_together | no_longer_needed |
unassigned_pickup` — all written for *someone closing work*. A missed window is
not that. Recorded, not papered over.

---

### 5. The next slice: duplicate property-line hardening

Fully designed in `COMMUNICATION_LINE_ARCHITECTURE.md`, with the rulings already
made. Build exactly this and no more (§30 — one narrow, vertically complete
slice):

1. read-only duplicate-number preflight;
2. database uniqueness for active, non-null property-facing numbers;
3. an inbound resolver that treats **zero, one and multiple** matches explicitly;
4. multiple matches **fail closed with zero operating writes**;
5. tests proving a message can never bind arbitrarily to one property.

**Why this is next and not the technician loop.** `properties.sms_number` has no
unique index, and inbound does `where sms_number = $1 limit 1` with no `order
by`. Two properties sharing a number silently binds a resident's message to the
wrong property's ledger — §5's confident-wrong at the property boundary, which is
the one wall the system must never leak through (§12). Unknown lines already fail
honestly; ambiguous ones do not. It is latent today because one guarded route is
the only writer — one row of defence with no database backstop.

**The Eight Questions (§31), pre-answered where they already have answers:**

1. *Real-world fact?* Which physical phone line received this message.
2. *Canonical service?* The inbound resolver in `communications_boundary.js`.
3. *Authenticated actor and property?* Neither — resolution happens **before**
   identity, because the receiving line is the property wall (§21).
4. *Durable object?* None new. A uniqueness constraint on existing config.
5. *Immutable history?* Unchanged; the refusal path writes nothing by design.
6. *What reads it automatically?* Every inbound message, and every outbound
   `from`.
7. *When it is missing?* **Answer for ambiguity, not just absence** — that is the
   entire slice.
8. *Class and removal condition?* `properties.sms_number` is a **temporary
   adapter** (§18): current role, one property-facing line per property;
   limitation, cannot express an organisation-owned operations line; retired when
   a canonical communication-line model resolves both inbound and outbound.

**Migration number: query the ledger, never assume.** Applied ceiling is 128;
**129 is claimed and merged**, so the next free number is **130**. Other threads
hold unmerged numbers — scan every branch, not `ls migrations/`.

Do not reuse **125**. It is an unused historical gap, and authoring a new 125
after 126–128 are live would backfill the sequence behind applied migrations and
create a second misleading migration story. Resolve the staged
`docs/slices-6-to-10/deployment_b/125_*.sql` artifact separately.

---

### 6. How the doctrine actually earned its keep today

Read this part. It is the reason for the rest.

**§17 caught a live defect.** `tests/_engine.js` was a hand-maintained copy of
the obligation engine kept in sync "by discipline." It had drifted in three
places, **all permissive** — a missing `dedupe_key`, a missing reserved-input
guard, a missing conversion-rail guard. Every harness importing it asserted
against an engine *more permissive than production*. Doctrine said two
implementations of one rule is a defect **even while they agree**; the drift
proved why.

**§5 turned a dead test into a finding.** `test_conversion_rail.db.js` had run
zero assertions for 204 commits. Applying "absence is not evidence" surfaced a
product defect the silence had been hiding: `obligations.status='missed'` was
**unwritable** against `ck_obl_status`, so a crossed follow-up window recorded
*nothing at all*. Zero missed rows existed in production, and the path had never
once succeeded.

**Doctrine overruled my own analysis, correctly.** I concluded the fix was to
widen `ck_obl_status` to admit `missed` and called it the only honest option.
**That was wrong.** Lifecycle status is mutually exclusive; missedness is
orthogonal — an obligation can be open *and* missed, escalated *because* it was
missed, complete *having been* missed. Widening the enum erases all four truths
and creates another overloaded field — precisely the defect ITEM 2 documents one
section away. The two-axis model came from doctrine, not from me:

```
lifecycle status        open | in_progress | complete | escalated
timeliness / recovery   on_time | due | overdue | missed
```

**And it caught a second-order version of the same error.** My first projection
read `missed` from the durable fact *with the clock as fallback*. That quietly
reintroduced the conflation: with no sweeper, an obligation would become "missed"
**because someone opened a page after the deadline.** `overdue` is a clock-derived
operating condition; `missed` is a durable institutional fact with a recorded time
and actor. **`missed` is never derived from the clock.**

**§18 killed speculative schema.** A recovery-queue index was drafted for
migration 126 and removed: no query in the slice used that shape. Every read was
`where id = $1`. An index for a capability the slice explicitly excluded is
schema built for a query that does not exist.

**The recurring failure was mine, three times: shipping a safety check that had
never run.** A production smoke whose read-only probe aborted its own
transaction. A closure gate blind since the reorg. A probe testing DDL permission
when the property that mattered was write permission. All three *read* as
protection. **A guard you have not executed is a claim, not a control** — which
is §33's whole point, applied to the tools rather than the product.

**The largest finding came from connecting two things already written down.**
`prestart` ran migrations against the service's own `DATABASE_URL`, so deploying a
branch to test it and migrating production were the *same operation*. The
evidence had been sitting in this very file as "the migration GAP at 121" — a
migration applied in production whose file existed only on a branch. It was
recorded as a curiosity for weeks. Every guard built this session protected
against a *harness* writing to production; **none protected against a deploy
migrating it**, because that path went through no harness. The protection was one
layer short of the risk, and the proof of it was already in the handoff.

---

### 7. What "done" means for the technician loop

Not "the code exists." Not "the harness passes." **§33, in full**, and for
operator workflows that includes the browser.

The loop is done when a real resident texts a real property line, a real
technician replies `accept` / `on my way` / `no access` / findings / proof /
`complete` from a real phone, the work order and its obligation carry durable
history at every step, one accountable human owns it or it reads honestly
`UNASSIGNED`, verified status returns to the resident, and an operator sees the
same truth on the board — **from one canonical record, with no demo path, no
fixture fallback, no invented ownership, and no second meaning of truth** (§35).

Anything less, name by its actual rung and say what is missing.

---

## ══════════════════════════════════════════════════════════════════
##  EVERYTHING BELOW THIS LINE IS HISTORY (pre-2026-08-03)
##  Kept because the reasoning is still the clearest account of how each
##  trap was found. Where it conflicts with the handoff above, it is stale.
## ══════════════════════════════════════════════════════════════════


## What is LIVE on `main`

| Slice | Landed | Proof level |
|---|---|---|
| S4 unified leasing work · S5 application records | #17, #18 | real Postgres + authenticated HTTP |
| Unit turn (migrations 112–118) | #16 | see `UNIT_TURN_RELEASE_CANDIDATE.md` — built-but-dormant at the time |
| Slice 6 renewals operating rail (119) | #20/#21 | real DB + HTTP + browser |
| Slice 7 Market & Pricing workspace | #22 | see `slices-6-to-10/SLICE_7_CLOSURE.md` |
| AI leasing strategy foundation (120) | #23 | dormant runtime — activation gated on a replay corpus that has never run |
| AI leasing visible status | #24 | — |
| Slice 8 governed economics lineage (122) | #25 | see the Slice 8 branch's own proof |
| **Resident SMS → canonical work order** | **#27** | **real Postgres + real HTTP · `docs/SLICE_SMS_CLOSURE.md`** |

### What the SMS slice changed (read this before touching inbound messaging)

- `runInbound` is **two transactions**. T1 commits the inbound claim already
  flagged `needs_human=true`; T2 does all processing atomically and clears the
  flag only on commit. A failed T2 preserves the claim, flagged, and sends no
  reply.
- The two **raw `work_orders` inserts are gone**. Tenant work orders flow
  through `createWorkOrder`, so every one produces an event and a routing
  obligation. The raw inserts produced neither.
- `appendClarification` was repaired in the **shared canonical service**, so the
  browser door (`POST /tenant/messages`) got the same fix.
- **`src/shared/obligation_transitions.js`** is the canonical obligation retype.
  Two whitelisted transitions only; requires expected type + status so stale
  state fails closed. **Use it — do not hand-roll an obligation `UPDATE`.**
- Clarification association keys on the **outbound question we sent**, never
  `obligations.person_id` (that column holds the *affected* person, not the
  person we texted — they differ whenever a neighbour reports).

---

## MIGRATION LEDGER — the GAP at 121 (CLOSED 2026-08-03; kept for history)

```text
repo on main:  … 118, 119, 120, [121 MISSING], 122
```

**121 is not lost.** `121_ai_leasing_operating_context.sql` is parked on
`claude/getting-up-to-speed-nyf4ww` and was deliberately kept off `main`
because it has never been applied to a database or exercised over HTTP.
When it eventually merges it will apply **after** 122. They touch unrelated
tables, so that is harmless — but it must not be a surprise.

**Before claiming any migration number, scan every branch — not `ls migrations/`,
which only shows what is merged. That is how duplicate numbers get created.**

```bash
git fetch --all -q && for b in $(git branch -r | grep -v HEAD); do \
  git ls-tree -r --name-only $b migrations/; done \
  | grep -oE '^migrations/[0-9]{3}' | sort -u | tail -5
```

Claimed at time of writing: **123, 124** (Slice 9) · **125** (Slice 9, staged
*outside* `migrations/` at `docs/slices-6-to-10/deployment_b/`, so a scan of
`migrations/` will NOT see it). **126 is the next free number.**

Verify the *deployed* ledger separately — the repo is not the database:

```bash
node -e "const{Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query('select version,name from schema_migrations order by version desc limit 5').then(r=>{console.table(r.rows);p.end()})"
```

---

## What is PARKED (real work, unmerged)

- **`claude/getting-up-to-speed-nyf4ww`** — Governed Operating Context: migration
  121, `ai_leasing_operating_context.js`, operator ai-rules/ai-settings routes,
  agent.js + leasingleads.js wiring. **Never applied to a database, never called
  over HTTP.** Its companion UI is on the app repo's branch of the same name and
  is explicitly not approved design. Needs its own real-DB + HTTP proof.
- **`claude/slice-9-demand-evidence`** — migrations 123/124 (+125 staged), the
  evidence rail, and a timezone cutover that makes `withinSendWindow` and
  `localHourAtProperty` **async**.

---

## Traps that cost time

### A BRANCH DEPLOY MIGRATES PRODUCTION — see BLOCKING_DESIGN_ITEMS.md ITEM 5

`prestart` runs `migrate.js` against the service's own `DATABASE_URL`. Deploying
a branch to the production Render service to test it and applying that branch's
migrations to production are THE SAME OPERATION. That is how `121` reached
production while `main` still lacks the file — the very "GAP at 121" documented
below. **Until an isolated preview service or an explicit migration gate exists,
do not deploy a feature branch to the production service.**


### NEVER reset, rebase or force-push a shared branch without diffing origin first

2026-08-01: a design doc was committed onto `claude/getting-up-to-speed-nyf4ww`
after resetting it to `origin/main`. The push was rejected as non-fast-forward.
That branch held **19 unmerged commits** — the entire resident-SMS slice. A
`--force` would have destroyed them. The rejection was luck, not process.

Before touching any branch that is not exclusively yours:

```
git fetch origin <branch>
git log --oneline origin/main..origin/<branch>     # exactly what would be lost
```

Unrelated work gets its own branch. Two threads have been running in parallel all
week; assume every shared branch name is occupied until you have checked.


**New, learned the hard way on 2026-08-01:**

- **The Render Shell has no `.git`.** `git rev-parse HEAD`, `git fetch`, and
  `git worktree` all fail there with *"not a git repository"*. Use
  `echo $RENDER_GIT_COMMIT` to see what is deployed. To run a harness from an
  unmerged branch, point the service's **Settings → Branch** at it, Manual
  Deploy, run, then switch back.
- **`users.role` is a Postgres enum (`role_name`)**, not free text. Valid:
  `owner, asset_manager, property_manager, leasing_agent, maintenance,
  accountant, ai, system`. There is no `staff`.
- **`now()` is TRANSACTION time.** Any harness that wraps a run in one
  transaction gives every row an identical `occurred_at`, so
  `order by occurred_at desc limit 1` returns an arbitrary row. Key assertions
  by **identity**, never by timestamp. This produced a false green that passed
  while reading a different test case's row.
- **Outbound SMS requires `contact_preferences.consent_state='opted_in'`.**
  Without it every send is refused and stamped `sms_status='refused'` — which
  the clarification gate then correctly treats as *never asked*. A fixture that
  omits consent silently exercises the wrong branch.
- **The inbound-SMS route acks Twilio BEFORE it awaits the send** (so a slow
  carrier never causes a retry). An HTTP response returning does **not** mean the
  message was sent.
- **Both exception-queue readers filter `direction='inbound'`**
  (`surfaces/desks.js`, `surfaces/board.js`). Flagging an *outbound* row with
  `needs_human` surfaces to nobody.

**Still true from before:**

- **Migration numbers collide across contributors.** Two `106` files broke every
  API deploy until renumbered.
- The ledger keys on **version**; the runner refuses a different file reusing a
  recorded version.
- `POST /operator/session` body field is **`proof`**, not `token`.
- `DATABASE_URL` in `api/.env` is dead — pull it from the Render env per session.

**Corrected — the prior handoff was wrong about these:**

- `window.__psLive.beginOperatorSession(...)` **no longer exists.** The
  `__psLive` surface today exposes turn/triage/readiness/agent methods; verify
  against `property-spine-app/index.html` before relying on any of them.
- The app repo branch is **not** `r1/renewals-live-read`. Check `git branch -r`.
- The Solo property id **does** appear in source (four files:
  `identity/operator.js`, `leasing/demo_preflight.js`, `surfaces/owner.js`,
  `onboarding/deal_registry.js`) — all reads or delete-guards. The rule that it
  is never *written* still holds, but "appears in no code" was false and must not
  be used as a search heuristic.

---

## Known debt

- **`tests/_engine.js` is a hand-maintained verbatim copy** of
  `spawnObligationFromEvent` / `satisfyObligation` from `server.js`. Its own
  header says *"server.js is the SOURCE OF TRUTH… update this copy to match"* —
  a rule kept in sync by discipline, which is the shape of the documented
  `deriveCategories` incident. `transitionObligation` was deliberately **not**
  added to it; it lives in `src/shared/obligation_transitions.js` and is imported
  by both server and harness. Extracting the two older functions is the right fix.
- **A failed resident notification has visibility but no accountable owner.**
  It re-flags the inbound row; PHILOSOPHY §11 wants an obligation. Needs an
  obligation type and an owning role — an owner ruling, not an implementation
  choice.
- The AI leasing strategy replay corpus (migration 120) has still never run
  against real model output.

---

## Key documents

`docs/SLICE_SMS_CLOSURE.md` · `docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md` ·
`docs/slices-6-to-10/` (00_GOVERNING_HANDOFF, SLICE_6/7_CLOSURE,
ACCEPTANCE_CHECKLIST) · `docs/PHILOSOPHY.md` · `docs/PRICING_GOVERNANCE.md` ·
`docs/IDENTITY_AND_AUTHORITY.md`

---
---

# ⚠ EVERYTHING BELOW IS THE PRIOR HANDOFF, AS WRITTEN 2026-07-27

It is preserved because it is the only written record of the pricing,
governed-charge and administration-fee rulings, and deleting it would lose
them. **It has NOT been re-verified since, and it is 33 commits stale.**
Slice 8 (migration 122) has since changed governed economics, so treat the
economic sections in particular as historical rather than current. Where it
conflicts with anything above, the section above wins.


**Closing state: 2026-07-28** · api `eaa1bd9` (live) · app `ae7abe3` (live)
**Independently audited 2026-07-28** — see *Audit corrections* at the foot.
Start here. Nothing in this file requires reconstructing the prior conversation.

---

## What is LIVE

**One governed economic term.**

```
fee.application   $50   one-time · required · per applicant · NEW-LEASE APPLICATION ONLY
                        record_state=active  quote_state=live
                        renewal: false   transfer: false
Assistant says:   "The application fee is $50 — Per applicant on a new-lease application."
Source:           property_governed_charges   (NOT prose)
```

Everything else economic is **unpublished**: no pricing version, no recurring
charge, no deposit requirement, no active concession.

## What remains DRAFT

```
fee.administration  $99  record_state=draft  quote_state=inactive
                         BLOCKED on one ruling (below)
```

Its legacy fact `pricing_admin_fee` is **still the only live source**.

## Legacy source retired

`agent_facts.pricing_application_fee` → `status='retired'`, row retained and
historically visible. It is the **only** fact ever retired. 12 money-bearing
facts remain live.

## Exactly one live economic owner

```
governed_active 1 · legacy_active 0 · quotable_sources 1
verdict: one_canonical_truth
```

Enforced by `uq_gc_active_code` (one ACTIVE row per code) combined with
`ck_gc_live_requires_active_amount` (live implies active), plus an
inside-transaction owner recount in `cutOver()` that refuses to commit on two
owners *or* zero.

`uq_gc_one_live_owner` also exists but is **provably unreachable** — a second
live row is blocked by `uq_gc_active_code` first. It is defence in depth, not
the enforcer. An earlier draft of this document credited it wrongly.

## Demo authority

```
Kameron Zitelli — Staff  (person c1dedf39, login 78375274 kz8434@gmail.com)
asset_manager on Demo Building ONLY
may_prepare · may_review · may_publish · may_manage_concession_authority
```

**1 of 28 properties** has any pricing authority. The invalid `owner`
assignment on a demo-lead person is deactivated with its history intact.

---

## Browser-proofed UI states

| State | Proof |
|---|---|
| **live** ($50) | chip *"LIVE — ONE GOVERNED SOURCE"*, before/after reads *"said before / says now"*, legacy labelled retired, **0 buttons**, *"Changing it means superseding it with a new decision"* |
| **draft** ($99) | chip *"DRAFT — NOT IN USE"*, open question + 3 rulings, **0 buttons**, blocked on the ruling not on authority |
| **unauthorized** | 0 buttons, amount still visible, plain-English denial naming the *account-setup* step |
| **unavailable** | no amount shown; states a read failure is not the absence of a fee |
| audit disclosure | collapsed in every state; **no internal codes** in operator copy |
| approved / published-not-live / cutover-ready / rejected | **code-proven only** — cannot be produced without another publication |

## The reusable decision-card contract

`psEconomicDecisionCard(elId, resourceName)` renders any server read of this
shape. **Adding a governed term needs a server read, not new UI.**

```
truth        state chip · question · amount · 3 facts
decision     open_question { question, why_it_matters, rulings[], preselected: null }
consequence  today {label, source, the_ai_says} → after_cutover {label, source, the_ai_will_say}
next action  actions { may_approve/modify/reject, denied_reason, labels }
collapsed    audit { ids, digests, record_state, quote_state, provenance, authority }
```

Rules: the **server** decides state and labels; the browser renders. No
internal code appears in operator copy. `may_approve` is false when the
blocker is a *question*, not authority.

---

## The unresolved administration-fee ruling

> **Is the $99 administration fee charged only for a new lease, or again when
> an existing resident renews?**

| Ruling | Consequence |
|---|---|
| New lease only | Renewal quotes exclude it. |
| New lease **and** renewal | Renewal economics carry another one-time $99. |
| Conditional | The renewal condition must be governed before it can be quoted at all. |

### Evidence audit — reported, not weighed

**Supporting renewal (2 independently authored prose sources):**
- `agent_facts.pricing_admin_fee` *(active)*: "A $99 admin fee applies per
  unit, once at move-in and at renewal."
- `agent_facts.fee_policy` *(retired)*: "a $99 admin fee per unit (at move-in
  and renewal)" — written separately, same claim.

**Corroborating pattern (about a different fee):** `pricing_amenity_fee` —
"$300 ($250 upon renewal)". Shows the property charges *some* fees at renewal.
Says nothing about this one.

**Contradicting renewal:** none.

**Transactional evidence: NONE — and this is not evidence against.** Only 2
scheduled charges of *any* kind exist on the property, so nothing has been
posted for any fee. Zero ledger entries mention admin. No lease-document table
carries fee terms.

**Conclusion:** the prose is consistent but ambiguous — *"once at move-in and
at renewal"* reads either as one charge covering both events or one at each.
**This needs a human ruling, not a reading.**

---

## Remaining product primitives

| Primitive | State |
|---|---|
| Recurring-charge model | **not built** — blocks parking, pet rent, wifi, insurance |
| Approved projection assumptions | **not built** — blocks all Future Rent Roll revenue |
| Deposit-held ↔ deposit-required separation | contract only; underwriting owner unnamed |
| Market evidence / Rent Survey | interface contract only, no store |
| Six-section economic inventory surface | **not built** (decision cards deliberately prioritised) |
| Separate reviewer permission | not built — `asset_manager` approves *and* publishes |
| Concession activation UI | not built; compiler complete, nothing activated |
| Eight version-one rents | **undecided** — no pricing version can publish |
| 11 blocked money facts | each with a named missing determinant |

## Confirmed unchanged

No other economic value published or activated · no concession · no offer or
lease economic line · no projection · no other property received authority ·
no person merged or deleted · no `agent_facts` retired beyond the one ·
`units.market_rent` never an authority · retired client pricing store never
restored.

---

## Operational notes for the next thread

- **Migration numbers collide across contributors.** Two `106` files broke
  every API deploy until renumbered. Check `ls migrations/` before adding one.
- The migration ledger keys on **version**; the runner correctly refuses a
  different file reusing a recorded version.
- `POST /operator/session` body field is **`proof`**, not `token`.
- In the browser use `window.__psLive.beginOperatorSession(<invite>)`; setting
  `sessionStorage` directly does **not** sign you in.
- App repo local branch is `r1/renewals-live-read`; push with
  `git push origin HEAD:main`.
- `DATABASE_URL` in `api/.env` is dead; pull it from Render env per session.
- Harnesses: `governed_economics_proof`, `demo_authority_ruling_proof`,
  `authority_resolution_proof`, `identity_authority_proof`,
  `pricing_governance_proof`, `pricing_foundation_proof`,
  `pricing_decision_packet_proof` — **584 assertions**, run separately.

## Key documents

`PRICING_GOVERNANCE.md` · `IDENTITY_AND_AUTHORITY.md` ·
`GOVERNED_ECONOMIC_TERMS.md` · `ECONOMIC_CONVERGENCE.md` ·
`ECONOMIC_DECISION_ROOM.md` · `AUTHORITY_RULING_EXECUTION.md`

---

## Audit corrections (2026-07-28)

An independent verification pass re-proved the deployed state from scratch,
assuming this document was wrong. It was, in three places.

1. **The one-live-owner enforcer was misattributed.** `uq_gc_one_live_owner`
   cannot fire: `ck_gc_live_requires_active_amount` forces live ⇒ active, and
   `uq_gc_active_code` already forbids two active rows per code. The probe
   confirmed the duplicate is rejected by `uq_gc_active_code`. The invariant
   holds and is enforced — the mechanism named was wrong. Corrected above.
2. **The commit reference was stale by one.** It named the commit before the
   handoff commit itself. Now `eaa1bd9`, which is what Render serves.
3. **A harness assertion had been weakened.** `contradictions.length === 11`
   was relaxed to `11 || 10` during the cutover so it would keep passing. An
   assertion that accepts two answers is not an assertion. It is now pinned to
   the exact eleven fact keys **by name** — strictly stronger than the
   original count. The real value never moved.

### Code-proven, not data-proven

- **Cross-property composite FK** on `property_governed_charges` is
  structurally present but **cannot be violated in a test today** — only Demo
  Building has governed unit types, so there is no foreign type to reference.
- **`move_in_requirements` still mentions "application fee"** in prose (no
  amount) and is still live. It is not a competing *value*, so the
  one-quotable-owner invariant holds for the $50 — but the phrase survives and
  is known cleanup.
- **UI states approved / published-not-live / cutover-ready / rejected** cannot
  be produced without another publication. Code-proven only.
- **The live assistant was not asked live questions.** Doing so sends real SMS.
  What it *would* resolve was proven by reading its exact fact-resolution query
  against the live database instead.
