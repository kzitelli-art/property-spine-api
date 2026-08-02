# Assertion boundary audit — Phase 1 (source-only)

**Deliverable as scoped:** a map of every path by which Property Spine produces
a green test result, every way that result can be false, and the minimum
structural controls required to make green mean the claimed behavior actually
ran.

**No test file was edited. No enforcement code was written.** Source and
execution-semantics inspection only. Where a claim required running something,
what was run is stated.

Companion: [`DB_CONNECTION_INVENTORY.md`](DB_CONNECTION_INVENTORY.md) — Appendix
G3-B ruled this work part of the S2 proof foundation, not housekeeping.

---

## Headline — there is no runner, so there is no boundary to strengthen

The instruction was to identify the common runner or enforcement boundary before
proposing floors. **Source answers it: none exists.**

| Entry point | Present? | Evidence |
|---|---|---|
| `npm test` or any test script | **No** | `package.json` declares exactly two scripts: `prestart` and `start` |
| CI configuration | **No** | no `.github/`, `.circleci`, `.travis.yml`, `.gitlab-ci.yml`, `Jenkinsfile` |
| Suite aggregator (a file that runs other test files) | **No** | see below |
| Shell script looping over `tests/` | **No** | no `*.sh` references `tests/*` |
| One test file requiring another | **No** | no `require("./test…")` or `require("./prove…")` in `tests/` |

**Every one of the 120 files in `tests/` is invoked individually as
`node tests/<file>.js`.** There are 120 entry points and no convergence.

### The aggregator question, answered precisely

20 files call `spawn`/`execSync`/`execFile`/`fork`. Classifying every call:

- **The overwhelming majority are `git` provenance commands** inside proofs —
  `git show HEAD:<file>`, `git diff --name-only <sha>`, `git rev-parse HEAD`,
  `git ls-files`. These read repository history to assert a change landed; they
  do not run tests.
- **Two spawn `node <path>`**, both in `tests/test_identity_bridge.db.js:586,592`
  — and they are **not** an aggregator. They are a **negative control**: J1 runs
  `gate_no_raw_bridge_joins.js` and requires it to pass; J2 plants a violating
  file, requires the gate to **fail**, then removes it (`:588–596`).
- **Two invoke a seed** (`node seed_demo_inventory.js --confirm`).

**This matters twice.** First, the consultant's child-process propagation
questions (ruling §5) are **largely not applicable today** — there is no
parent/child proof chain to break, because there is no chain. Second, the
negative-control pattern the ruling asks for in §6 **already exists in this
repository**, at `test_identity_bridge.db.js:588–596`. It is the correct model
and should be the template, not a new invention.

**Consequence for the design ruling:** an enforcement boundary cannot be
*strengthened* here. One would have to be **created**, and creating a runner is a
larger and more disruptive change than adding floors. That trade-off is §5 below
and is the decision this report exists to inform.

---

## A. How can tests be invoked?

| Path | Count | Notes |
|---|---|---|
| `node tests/<file>.js` directly | **120** | the only real invocation path |
| Via `package.json` | 0 | no test script exists |
| Via CI | 0 | no CI exists |
| Via an aggregator | 0 | none exists |
| Via shell wrapper | 0 for `tests/`; **2 root scripts** | `setup_clean_qa_record.sh`, `setup_fresh_record_and_prove.sh` — operational setup, not assertion harnesses; guarded as of Appendix G3-A |
| Documented manual commands | present, unenumerated | `docs/` and file headers carry `HARNESS_DATABASE_URL=… node tests/…` invocations; the Phase 1 inventory already records the operational invocation set as a **lower bound** |

**Every file is directly executable, so any proposed central runner is bypassed
by the invocation everyone already uses.** This is the single most important
input to the design ruling.

---

## B. What makes each family return exit code 0?

### Family split

| Family | Count | Mechanism |
|---|---|---|
| **Receipt-based** (`require("./_run_receipt.js")`) | **6 of 120** | `receipt.complete()` computes the code |
| **Ad-hoc** | **114 of 120** | each file computes its own exit |
| Of the receipt family, passing `expectedAtLeast` | **3** | `test_conversion_rail.db.js:486` (15), `test_identity_bridge.db.js:600`, `test_release3.db.js:463` |

### The existing floor is correct, and its default defeats it

`tests/_run_receipt.js:126–129`:

```js
function complete({ harness, passed, failed, expectedAtLeast = 1 }) {
  const run = passed + failed;
  const code = run < expectedAtLeast ? 1 : (failed === 0 ? 0 : 1);
```

The logic is right: fewer assertions than expected is a **failure**, not a pass,
and it prints *"A harness that executes no assertions has proven nothing."*

**But `expectedAtLeast` defaults to `1`.** A harness that runs one setup
assertion and then skips every meaningful case satisfies the default. **This is
the semantic-floor gap already latent inside the mechanism that exists** — the
three files that pass a real number are protected; the other three receipt users
inherit a floor of one.

### Exit-code production across all 120

Counted mechanically:

| Pattern | Files |
|---|---|
| `process.exit(<failure-expression>)` | 70 |
| Contains `process.exit(1)` somewhere | 58 |
| **No `process.exit` at all** | **3** |

The 3 with no explicit exit depend entirely on Node's default behavior for an
unhandled rejection or a thrown error.

**Verified by execution on this container (Node v22.22.2):**

```text
node -e 'Promise.reject(new Error("boom"))'        → exit 1
node -e '(async()=>{throw new Error("boom")})()'   → exit 1
```

So those 3 do fail correctly **today**. But:

- **`package.json` declares no `engines` field.** The failure semantics of 3
  harnesses rest on an undeclared runtime version. On Node < 15 an unhandled
  rejection warns and the process exits **0**.
- **No file in `tests/` installs an `unhandledRejection` or `uncaughtException`
  handler** (0 of 120), so there is no in-repo safety net independent of the
  Node default.

### One inconsistency inside the protected three

`test_conversion_rail.db.js:485` sets `process.exitCode = receipt.complete(…)`,
while `test_identity_bridge.db.js:599` and `test_release3.db.js:462` use
`process.exit(receipt.complete(…))`. `process.exitCode` only takes effect when
the event loop drains; `process.exit()` is immediate. The two forms differ if
anything keeps the loop alive (an unclosed pool). Not asserted to be a live
defect — flagged as a variance that a boundary design must not assume away.

---

## C. The four floors, and which are covered today

| Floor | Question | Covered today? |
|---|---|---|
| **1. Process** | did the intended process load and finish normally? | **Partly.** 117/120 exit explicitly; 3 rely on undeclared Node semantics. A load-time `ReferenceError` does exit non-zero — this is why FINDING 1's dead harness is invisible to a reader but not to `$?`. |
| **2. Execution** | did any assertion execute? | **3 of 120.** Only the files passing a real `expectedAtLeast`. The default of 1 means three more receipt users have a floor that one setup assertion clears. |
| **3. Dataset / case** | did the population this harness needs exist? | **0 of 120.** Nothing declares an expected population. |
| **4. Semantic** | did the specific claimed behavior run? | **0 of 120**, with one partial exception: the negative control at `test_identity_bridge.db.js:588–596` proves a gate **fails** when it should, which is a semantic assertion about the guard itself. |

The worked example from the ruling is reachable in this repository today:

```text
one setup assertion executes      → execution floor passes (default 1)
query returns zero rows           → every loop assertion is skipped
process exits 0                   → semantic proof absent, result reported green
```

---

## D. Bypass inventory

Ranked by how likely each is to be used in practice:

| # | Bypass | Status |
|---|---|---|
| 1 | **Direct `node tests/<file>.js`** | **Universal.** All 120 are directly executable and this is the documented invocation. Any runner-based enforcement is bypassed by the normal workflow, not by a workaround. |
| 2 | **`expectedAtLeast` omitted** | 117 of 120 files never pass it; 3 of the 6 receipt users rely on the default of 1. |
| 3 | **Assertions inside data-driven loops** | Population not enumerated here — identifying it reliably needs per-file reading, and a regex would produce exactly the confident-wrong output this audit exists to prevent. **Recorded as the largest unmeasured quantity in this report.** The conversion-rail defect was this shape. |
| 4 | **Printed totals computed separately from the exit code** | In the receipt family the printed line and the returned code come from the **same** function (`complete()`), so they cannot diverge. In the other 114 the printed summary and the exit expression are independent statements — divergence is possible per file and is not measured here. |
| 5 | **Environment flags changing data source or skipping work** | `HARNESS_DATABASE_URL` gates 6 files; `PSPINE_ALLOW_NON_TTY` and the new `PSPINE_WRITE_ACK_*` gate operational scripts. Not audited for test-skipping flags. |
| 6 | **Child-process status ignored** | **Not applicable today** — no aggregator exists. Becomes applicable the moment one is created, which is why §5 raises it as a cost. |

---

## E. What artifact is treated as proof?

**Both an exit code and printed totals, with no mechanical tie between them
outside the receipt family.**

- The receipt prints a structured block — harness, commit, branch, database
  identity, isolation statement, `EXPECTED n assertions`, then
  `ASSERTIONS COMPLETE · n run · n passed · n failed` and `EXIT <code>`
  (`_run_receipt.js:108–140`). Here the total and the code are **the same
  computation**, which is the correct design.
- Elsewhere, "N assertions passed" is a `console.log` a human reads, and the exit
  code is a separate expression.
- **The Phase 1 inventory already establishes that no proof run in this
  repository has ever preserved a receipt**, so `PROOF_OBLIGATION_ENGINE.md`'s
  ceiling claim sits at proof level *Reported*. The artifact most often trusted
  in practice is therefore **a transcript a human read**, which is the weakest
  link in the chain and the one that made FINDING 1 invisible for the length of
  time it was.

---

## Proposed minimum enforcement set — for ruling, not for building

Three candidate boundaries. **None is recommended over the others here**; each is
stated with what it cannot do, as directed.

### Option 1 — Floors at the harness, no runner

Extend the receipt to all 120 files; require an explicit `expectedAtLeast`;
remove the default of 1 so omission is an error rather than a weak pass.

- **Covers:** execution floor everywhere; process floor uniformly; keeps the
  printed total mechanically tied to the exit code.
- **Cannot cover:** dataset and semantic floors without per-harness declarations.
- **Bypassed by:** nothing new — it rides the invocation people already use.
- **Cost:** touches 114 files. The ruling forbids hand-adding floors before this
  report; this report is that prerequisite.

### Option 2 — Create a runner, enforce there

Add a real runner plus `npm test`, and enforce floors centrally.

- **Covers:** central policy; one place to change; enables CI later.
- **Cannot cover:** **direct `node tests/<file>.js`, which is the documented and
  universal invocation.** Every file stays executable, so the runner is advisory
  unless direct execution is also closed.
- **Introduces:** the entire child-process propagation surface from ruling §5
  that does not exist today — spawn failure, signal termination, throw before
  totals, PASS-then-exit-1, exit-0-with-no-output. **This option creates the
  problem it would then have to solve.**
- **Would additionally require:** a repository rule closing direct execution —
  e.g. harnesses exporting a function rather than self-executing, so running the
  file directly does nothing.

### Option 3 — Both, in order: floors first, runner only if CI arrives

Floors at the harness now (Option 1); defer the runner until something actually
needs one.

- **Covers:** the real gap now, without inventing a propagation chain.
- **Cannot cover:** central policy change; a single place to raise the bar.
- **Honest note:** with no CI, a runner's main benefit is unrealised, so Option 2's
  cost currently buys little.

---

## Required failure cases, mapped to real history

Per ruling §6, the enforcement must be proven against defects that **actually
occurred here**:

| # | Case | Real instance |
|---|---|---|
| 1 | Loads with an error, executes zero assertions | `tests/test_adapter_seam.db.js:13` — `receipt` undeclared. **Still dead; verified this session.** |
| 2 | Data-driven harness receives an empty dataset | `test_conversion_rail.db.js` — the defect that ran for 204 commits |
| 3 | Child prints success text but exits non-zero | no instance today (no aggregator) — synthetic |
| 4 | Producer fails, consumer succeeds in a pipeline | the two root shell scripts, false-green row 4 — **fixed and proven this session** |
| 5 | Direct-run path bypasses a central runner | applies only under Option 2 |
| 6 | One irrelevant setup assertion, all semantic cases skipped | reachable now via `expectedAtLeast` defaulting to 1 |

**Per the ruling, the dead harness must not be fixed first.** It is the only real
red case for #1 and should stay broken until a boundary demonstrably rejects it,
then be corrected. Recorded here so that intent is not lost to a future tidy-up.

---

## What this report does not establish

- **How many harnesses are data-driven** (bypass 3) — the largest unmeasured
  quantity here. Needs per-file reading, not pattern matching.
- **Whether printed totals and exit codes diverge** in any of the 114 ad-hoc
  files — possible per file, unmeasured.
- **Whether any environment flag skips tests or switches data sources.**
- **Anything about runtime behavior beyond the Node exit semantics actually
  executed above.** No harness was run.

**Proof level: Locally exercised.** Source inspection plus directly executed Node
exit-semantics checks. No harness was run, no database contacted.

---

## Ruling on this report (2026-08-02)

Recorded as governing. **This lane is closed; no enforcement work follows from
it in this branch.**

| Decision | Status |
|---|---|
| **Do not build a test runner** | Ruled. Option 2 above is rejected. |
| **`_run_receipt.js` defaulting `expectedAtLeast` to 1** | **Registered as a proof-integrity gap.** Not fixed here. A harness that runs one setup assertion and skips every semantic case satisfies the default and reports green. |
| **The dead harness stays broken** | `tests/test_adapter_seam.db.js:13` remains the real negative control for the load-time-error case. **It must not be tidied up.** Correct it only after a boundary demonstrably rejects it. |
| **Node-version exposure** (no `engines`; 3 harnesses on default rejection semantics) | **Parked.** Recorded, not actioned. |
| **Per-harness semantic / dataset floors** | **Parked.** Recorded, not actioned. |
| **Unmeasured: how many harnesses are data-driven** | Remains open and deliberately uncounted (see *What this report does not establish*). |

**Do not expand this branch into test-infrastructure implementation.**
