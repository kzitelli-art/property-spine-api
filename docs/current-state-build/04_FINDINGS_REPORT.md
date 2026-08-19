# Property Spine — Current State Findings
### An evidence-based audit of what is built, what is proven, and what is at risk

**Date:** 19 August 2026
**Scope:** `property-spine-api` @ `77f93f5` · `property-spine-app` @ `c6769ba`
**Method:** automated source inventory with independent adversarial verification
**Status:** interim — roughly 60% of the codebase surveyed

---

## 1 · Why this audit exists

Property Spine is built across many parallel work threads over several months. Each
thread ships real capability, but no single document records what actually exists at
what level of proof. The governing handoff document has grown to **3,992 lines across
50 dated sections**, containing **34 instances of supersession language** — *"this
section wins," "that sentence is now false."* Answering a simple present-tense
question ("is this feature live?") requires running a precedence algorithm across
fifty dated banners.

The concrete symptom: that document's top banner states **"EQUITY IS LIVE."** Two
hundred lines below, the Debt section states the honest standard — merged, not
production-verified. One file, two definitions of "live," and no way to tell which
applies without reading both.

**A historical narrative was being asked to answer a current-state question.** This
audit is the first half of correcting that; the second half is a standing
`CURRENT_STATE.md` ledger that replaces recollection with evidence.

---

## 2 · Method, and why the numbers can be trusted

Nothing in this report comes from memory, documentation, or prior conversation.
Every finding traces to source code read at a specific commit.

**Two-stage process.** Research agents inventoried the codebase in parallel,
each producing capability rows with cited file paths and line numbers. Every claim
then went to an **independent adversarial verifier** instructed to *refute* it —
to open the cited files and prove the claim too generous, defaulting to rejection
when uncertain.

**That verification is not a formality.** Of 44 capabilities in the most recent
batch, **40 had a claim reduced or corrected.** Most were downgraded one level
rather than thrown out — but two were reversed outright, in both directions.

**A controlled vocabulary** replaces words like *done*, *built*, *working* and
*live*, which blend intent with evidence:

| Level | Meaning |
|---|---|
| `REPORTED` | A document asserts it; no code evidence located |
| `LOCALLY_EXERCISED` | Unit-tested logic, no real database |
| `BUILT_BUT_DORMANT` | Code exists; nothing in the running system calls it |
| `HTTP_PROVEN` | One test drives real HTTP against a real database |
| `BROWSER_VERIFIED` | A real browser drives the real interface |
| `DEPLOYED` | Confirmed present in the deployed build |
| `PRODUCTION_PROVEN` | **Observed working in production** |

The distinction between the last two carries most of the weight in this report.

---

## 3 · Headline findings

### 3.1 Two capabilities are proven in production. Not two categories — two.

Across roughly 114 capabilities surveyed, exactly two have been *observed working
in production* rather than merely deployed:

- **The work-order completion guard.** A database-level constraint refusing to mark
  work complete without grounded proof. Measured on the live instance: 16/16 checks,
  exit 0, activation irreversible. Found independently by two researchers.
- **The migration release gate.** Runs on every deploy; refuses to start the service
  if the database schema doesn't match the code. Confirmed enforcing in the deployed
  build.

Both are *safety* mechanisms. Notably, **neither is a customer-facing feature.**

### 3.2 The distribution

```
PRODUCTION_PROVEN     2      observed working in production
BROWSER_VERIFIED    ~12      real browser + real interface (3 use a simulated database)
HTTP_PROVEN         ~18      real request against real database
LOCALLY_EXERCISED   ~45      logic tested; never exercised end-to-end
BUILT_BUT_DORMANT   ~25      written; nothing calls it
DEAD / REPORTED      ~8      unreachable, or asserted without evidence
```

**Roughly 65% of surveyed capability has never been exercised end-to-end.** This is
not unusual for a system in active construction. It is only dangerous when it is
*unrecorded* — which, until now, it was.

### 3.3 One live defect where the failure mode reaches a real customer

Most gaps in this report cause a screen to show a blank. **One causes a wrong number
to be told to a real prospect**, and it is currently active.

The AI leasing agent reads `units.market_rent` — a legacy per-unit column — directly
when composing facts for a prospect conversation. Two purpose-built modules exist to
prevent exactly this. Both are self-declared *"DARK BY CONSTRUCTION. Nothing calls
this yet."* They are wired into an internal operator endpoint and a preview tool —
**not into the prospect-facing path that causes the problem.**

The incident this was built to prevent is recorded in the code's own header:

> *"the agent quotes `units.market_rent` directly … a legacy per-unit column that
> disagreed with the sheet on unit 530 by $237 and went to nine real phones."*

The fix exists, in the same repository, unused by the code path that caused the
incident. **This is the single highest-severity finding in the audit.**

---

## 4 · Where documentation actively contradicts the system

These are more dangerous than missing documentation, because they instruct
confidently and wrongly.

**The deployment guide describes behavior the deployed code does not have.** It
states that startup *"runs any unapplied migrations."* It does not — it *verifies*
and **refuses to start** on mismatch. A deploy with pending schema fails, and the
previous instance keeps serving, so the system looks healthy while the new schema
is simply absent. The project's own notes record this trap as having *"cost time
twice."* It is now encoded as an instruction.

**A release document was staged as production evidence for something its own text
says has not happened.** A rent-roll correction packet records a production
recompute — but its own proof table reads *"Deployed runtime · HTTP · session ·
browser — **NOT PROVEN**,"* and its header states *"Production untouched. Nothing
deployed."* The supporting recompute is single-source: the script that produced the
numbers is committed nowhere, and the corroborating commit modifies only that same
document. **Claim withdrawn on verification.**

**The internal state document contradicts itself within one section** on whether
tax schema reached production — *"APPLIED… ceiling 167"* and *"nothing is in
production"* appear paragraphs apart, both present tense.

---

## 5 · Capability gaps worth knowing before planning

**There is no electronic signature capability.** Stated plainly in two files: the
system *"does NOT capture a legally-binding signature."* The tenant-facing signing
page produces an acknowledgment that terms were reviewed. The door for recording a
genuinely executed lease exists but is **switched off** behind an environment flag
plus an allowlist, with no evidence either is enabled in production.

**"Pending tenancy" does not exist as a concept in the code.** Confirming a
rent-roll row writes the lease as **`active`** immediately — the status is
hard-coded in the insert statement. Any design assuming a pending intermediate step
on that path is assuming something the system does not do. *(The reverse transition
— activating a pending lease — does exist and works.)*

**An operator screen calls routes that return 404.** An entire activation flow was
written and never connected to the server. Verified at current `main`: zero
references from the server entry point.

**Two Asset Management domains that appear shipped have never been tested end to
end.** Utilities and Contracted Services are registered as available to the
conversational interface, but their request-level tests use a *simulated* database
and their database tests bypass the request layer. The two halves never meet. Their
browser tests also run against a simulated database. *Compliance, by contrast, does
this correctly* — real request, real database, real browser, in one test.

**Insurance and Tax cannot be asked about.** Both are built, both released, neither
has a conversational reader. Confirmed absent at current `main`.

**The rule-enforcement gate covers 2 of roughly 15 domain directories.** The
automated check meant to catch unregistered domains scans only two folders. Leasing,
applications, maintenance, technician, communications, obligations, money and
onboarding are structurally invisible to it — they cannot fail it, because it cannot
see them. The project's own guidance names this failure mode: *"a gate that scans
less than it asserts is worse than no gate, because it launders the gap into
evidence."*

---

## 6 · What is genuinely solid

This audit is not a catalogue of problems. Several areas are strong, and the
verification pass *confirmed* them rather than reducing them.

- **Forward Leasing** — four browser-level proofs survived adversarial verification
  untouched. The most rigorously proven feature area found.
- **Deal Setup / rent-roll onboarding** — the only capability where a test spawns the
  real server as a separate process and drives it over a real socket, including
  restart persistence. This is the model the rest of the system should follow.
- **Compliance** — real request, real database, real browser, plus a working
  conversational reader. Correctly built end to end. *(It has no entry at all in the
  main state document — the best-proven domain is the least documented.)*
- **The technician SMS operations loop** — proven at request, database and browser
  level, with preserved screenshots.
- **Work orders, obligations, turnovers** — all confirmed working at request level
  with real databases.
- **Doctrinal discipline is real and visible.** Dormant code consistently declares
  itself dormant. Modules refuse to fabricate values. Separation between recorded
  fact and derived interpretation is enforced structurally, not by convention. The
  discipline is genuinely unusual — the gap is between that discipline and the
  *tracking* of it.

---

## 7 · Confirmed against an internal architecture map

An internally maintained map was checked row by row against the code. It proved
accurate on several difficult calls — including independently identifying the
pricing defect in §3.3, and a configuration flag left open in production against
stated policy.

It was also **wrong in both directions**, which is the argument for evidence-linked
rows:

| Map said | Code says |
|---|---|
| Follow-up ladder: *code-proven* | *"DORMANT. Nothing calls this yet."* |
| Turnovers: *missing, unbuilt cluster* | Built, request-proven, authenticated |
| Maintenance obligations queue: *missing* | Built, request- and browser-proven |
| People index: *missing* | Confirmed absent |
| Company countersign: *retired* | Confirmed retired |

Maps drift in both directions. Optimistic drift produces false confidence;
pessimistic drift produces rebuilt work. Both are expensive.

---

## 8 · Immediate recommendations

**Fix now — hours, not days:**

1. **Route the leasing agent through the pricing adapter** (§3.3). The only finding
   whose failure reaches a customer.
2. **Correct the deployment guide** (§4). It currently instructs incorrectly about
   the one mechanism that protects production.

**Decide deliberately:**

3. **Five migrations are written and unreleased** (177–181). Production schema is at
   176. Any deploy before release fails to start — safely, but silently, since the
   prior instance keeps serving.
4. **Widen the enforcement gate** to cover all domain directories, or state
   explicitly what it does not cover.

**Structural, in progress:**

5. **Complete the survey.** Teams and access control, the management surface,
   rent-roll intake, money and pricing, the full client application, and operational
   tooling remain unsurveyed. Access control is the highest-value remaining gap: an
   internal note records that **no staff member other than the account owner has ever
   completed sign-in**, and that the exclusion path — verifying an unauthorized user
   is actually kept out — has only been tested from inside.
6. **Publish `CURRENT_STATE.md`** — one row per capability, each carrying its own
   evidence and verification date, with a mechanical check so it cannot silently go
   stale.

---

## 9 · Reading this report fairly

**What it establishes:** the proof level of roughly 114 capabilities, verified
against source at a named commit, with adversarial review of every claim.

**What it does not establish:** that any capability is broken. `BUILT_BUT_DORMANT`
means *not yet connected*, not *defective*. Most of what is listed as unproven is
probably fine — it simply has never been demonstrated, and that distinction is the
entire point.

**Coverage is partial.** Roughly 60% of the codebase has been surveyed. The
remaining areas may contain findings of equal weight. No conclusion here should be
read as complete.

**One finding is customer-facing and current** (§3.3). Everything else is a
tracking, documentation, or completeness gap — real, worth fixing, and not urgent
in the same way.

---

*Produced by automated source analysis with independent adversarial verification.
Every claim traces to a file path and line number at the commits named above.
Supporting detail, including the full capability tables and per-claim verification
reasoning, is in `docs/current-state-build/`.*
