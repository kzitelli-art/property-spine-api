# Release 0 — the production run card

**The sequence is `docs/RELEASE_0_ACTIVATION_RUNBOOK.md` §5.1. This card reorders
nothing and decides nothing.** It exists because the run has to be executed from a
session that holds production credentials, and this one does not. What follows is
the ordered command sequence, the environment each command needs **named but never
valued**, and the stop condition attached to each step.

```text
RC        claude/release-0-rc   f6873d7b3dd21a63d82dbca0d96da8840a774e14
frozen    docs/release0/FROZEN_ARTIFACTS.json   revision 5
instrument  node tools/release0/where_are_we.js      — where are we, from the DB
preflight   node tools/release0/preflight_production.js — is it safe to move
receipt     node tools/release0/acceptance_receipt.js   — what actually happened
```

All three are proven read-only before they read: `BEGIN TRANSACTION READ ONLY`,
enforced by the server, rolled back. None of them can write to production.

---

## §0 — Why this card exists instead of a completed run

The session asked to execute this sequence has **no production access**. Probed by
name, expanding nothing:

```text
DATABASE_URL                 absent
PRODUCTION_DATABASE_URL      absent
NEON_DATABASE_URL            absent
RENDER_GIT_COMMIT            absent
GIT_SHA                      absent
TWILIO_ACCOUNT_SID           absent
TWILIO_AUTH_TOKEN            absent
TWILIO_MESSAGING_SERVICE_SID absent
R0_CENSUS_AUTHORIZATION      absent
API_BASE_URL                 absent
```

*(Presence computed in JS/`[ -n ]` on the variable name — never `${VAR:-no}`. That
expansion once put a live Twilio auth token in a screenshot.)*

Three consequences, in order of how much they cost:

1. **Step 1 cannot run.** `preflight_production.js` exits 2 with *"REFUSED:
   DATABASE_URL is not set. This reads the real database and will not invent an
   answer."* That refusal is the tool working.
2. **Step 2 cannot run.** Twilio credentials are absent here, and the blocker is
   larger than credentials anyway — see §2.
3. **Steps 3–5 depend on 1–2.**

**The credential is not requested, and must not be.** Standing instruction: *"Do
not send, paste or request a production connection."* A production run card is the
correct output of this session; a production connection inside it is not.

**Nothing was simulated.** No step below is marked done, green, or rehearsed-as-run.
The rehearsal evidence that exists (`rehearse_release_train.js` 53/53,
`prove_boundary_reversibility.js` 20/20, `falsify_release_transitions.js` 26/26,
`prove_migration_sequencing.js` 15/15) is isolated-Postgres evidence and is named
as such wherever it appears.

---

## §1 — The production preflight

**Run it ON the deployed instance**, not from a laptop pointed at the database.
The running SHA is a property of the *process*; off-instance it reports `UNKNOWN`
with the reason rather than reporting the local checkout as though it were
production's. This release has already paid twice for a deploy whose running SHA
was not the one assumed.

```bash
#  environment: DATABASE_URL → production
#               RENDER_GIT_COMMIT (or GIT_SHA) → set by the platform, do not fake
node tools/release0/preflight_production.js
```

```text
exit 0   every check green
exit 1   a contradiction — DO NOT PROCEED
exit 2   could not read
```

It answers all eleven questions this step owes, from the runtime:

| # | question | where it comes from |
|---|---|---|
| 1 | exact running API SHA | the process env; `UNKNOWN` if absent |
| 2 | frozen artifact drift | digests in `FROZEN_ARTIFACTS.json` vs the tree |
| 3 | Step 3 writer present | `recordEvaluation(` in the running `lifecycle_service.js` |
| 4 | migration ledger ceiling | the ledger table, plus per-migration APPLIED/not |
| 5 | activation absent/present | `release_0_activation_history` |
| 6 | epoch, and agreement | the singleton row vs the activation |
| 7 | guard triggers | existence · `DEFERRABLE INITIALLY DEFERRED` · **ENABLED** |
| 8 | guard predicates | the four SQL function bodies carry their clauses |
| 9 | terminal / pre-cutover population | the validator, plus inventory row count |
| 10 | invariant audit set | `release_0_completion_invariant_violations` |
| 11 | legacy done-path · status vocabulary · activation window | Step 6 route state · `select status, count(*)` · in-flight writers and idle-in-transaction |

**Stop on any contradiction — this is the instruction, not a preference.** In
particular:

- **A status value outside `open · scheduled · needs_followup · closed · complete`.**
  Classify it before boundary 8. If it means the work is finished it belongs in
  migration 140's terminal set and in the reader's `TERMINAL_STATUSES`, or that
  completion escapes Release 0 entirely.
- **A non-empty invariant audit** — the guard was dropped, deployed late, or
  bypassed by DDL. Investigate; it is not a queue to work through.
- **`PRESENT BUT NOT PROTECTING`** — a trigger disabled by `ALTER TABLE … DISABLE
  TRIGGER` keeps its name, timing and definition and simply does not fire. A
  presence check passes. This does not.
- **Frozen artifact drift** — whatever is deploying is not the RC.

---

## §2 — Step 4, the transport blocker, worked directly

**Do not build a product feature while transport is the only thing holding Release
0 open.** The blocker is not code and there is nothing to design: it is
provisioning, and it is **two independent blockers**, recorded read-only on
2026-08-06 in `docs/RELEASE_0_SMS_PREREQUISITE.md`:

```text
operations line present               NO   — there is no 'operations' row at all
property-facing provider configured   NO   — provider_config is null on the only
                                             line that exists
```

Nothing routes in or out today, in either direction. That is the safe state and it
is a complete block on any real-handset test.

### ⚠ THE ORDER WITHIN STEP 2 IS ITSELF A RULING

**Verify the posture BEFORE credentials are introduced, not after.** Twilio
credentials are global — one account behind both lanes — so the instant they
exist, the resident path's only remaining gate is `SMS_SEND_MODE`.

```text
1  read production SMS_SEND_MODE                    ← §1 preflight scores this
2  read whether properties.sms_number is populated  ← §1 preflight reports this
3  if the mode is anything but disabled/unset, CHANGE IT FIRST
4  only then add Twilio credentials
5  provision ONLY the operations line the technician path needs
6  leave property_facing.provider_config NULL unless something
     independently requires it — do not configure it to make the line
     "look" configured
7  node tests/gate_outbound_senders.js
8  then the handset proof
```

**The invariant being preserved:**

```text
Twilio credentials live + SMS_SEND_MODE disabled
  → technician operations replies CAN work
  → resident outbound sends remain structurally refused
```

Source-proved (`tests/gate_outbound_senders.js` S9, `docs/OUTBOUND_TRIGGER_AUDIT.md`):
with the mode disabled, current code cannot originate a resident SMS while
technician replies remain available. **Production must still prove that the
deployed environment actually holds that configuration** — which is what the §1
preflight's `SMS posture` line reads, and why it reports UNKNOWN and goes red
when run anywhere other than the deployed instance.

**Do not rely on `outbound_policy='reply_only'` as protection.** It is not on
that path — measured, not assumed.

### The activation packet — the actual work items

Ordinary data, created through governed paths. **Not a migration, not a script
from `tests/`.**

```text
LINE ROW      line_type          'operations'
              authority_ceiling  operational
              permitted_audience staff
              inbound_enabled    true
              outbound_enabled   true
              outbound_policy    'reply_only'   ← ck_cl_outbound_policy_by_type
                                                  ENFORCES disabled|reply_only
              status             'active'
              property_id        the granted property

CARRIER       a provisioned inbound number for the operations line
              provider_config populated on that row
              A2P 10DLC registration for the sending brand/campaign
              LEAVE property_facing.provider_config NULL

              ⚠ THE CONTROL IS NOT THE POLICY COLUMN. Measured in
                docs/OUTBOUND_TRIGGER_AUDIT.md and held by
                tests/gate_outbound_senders.js: the resident send path
                resolves its number from properties.sms_number and never
                reads communication_lines, and the outbound-policy trigger
                returns early on every resident event because no
                resident-path writer sets communication_line_id. So
                property_facing.outbound_policy = 'proactive' restrains
                nothing, and changing it to 'reply_only' would refuse
                nothing while creating a false belief that it had.

                What actually arms resident messaging is SMS_SEND_MODE
                (default and unknown-value both → disabled) plus GLOBAL
                Twilio credentials plus properties.sms_number. Credentials
                are global: wiring Twilio for the operations line makes
                smsReady() true for the resident path in the same instant.

SEND MODE     ⚠ LEAVE SMS_SEND_MODE UNSET (or explicitly `disabled`)
                THROUGH STEP 4. sendOperationsReply does not consult the
                mode, so the technician reply path works while every
                resident send refuses at send_mode_disabled before it
                reads a consent row. That isolation is structural and is
                asserted by gate S9. Setting the mode is a separate,
                deliberate act — not part of configuring transport.

WEBHOOK       POST /communications/inbound-sms reachable from the carrier
              signature validation configured — the route rejects unsigned calls
              routing proven to reach the correct property

FIXTURES      technician tester identity + property assignment + eligibility

CONTROLS      POSITIVE  a signed inbound message reaches the route, is preserved
              NEGATIVE  an UNSIGNED call is rejected — proves the gate is live and
                        the positive result is not a dead-open route

ROLLBACK      set the operations row status to superseded, or clear
              provider_config. Neither requires a deploy.

RECEIPT       line id · line_type · provider_configured (boolean only)
              the inbound number is NEVER recorded in the receipt
```

A2P 10DLC registration is a carrier review with a turnaround measured in days.
**It is the long pole and it is not an engineering task.** Start it before
anything else on this card, because §1 can run in parallel with it and §3 cannot
finish without it.

### Then run the already-packaged proof — no new test design

```bash
#  environment: TEST_FROM → the tester handset, E.164
TEST_FROM='+1XXXXXXXXXX' node tools/step4/preflight.js
#     ↑ chooses the target work order and prints T0. READ WHAT IT CHOSE.

#  … the human sends ONE MMS: repair photo, completion language, naming the WO …

TEST_FROM='+1XXXXXXXXXX' node tools/step4/prove_completion.js --wo <ref> --t0 '<T0>'
```

The eight facts and the four no-parallel-writer checks are already proven and
falsified in isolation (`tools/step4/rehearse.js` 48/48). **A receipt is emitted
only if every named fact holds. One absent fact, no receipt.**

**Stop conditions**

- **Never target work order 1006** — it carries the Gate 8 evidence photo, so a
  bare "done" closes it instantly. The preflight excludes it by number.
- **Never target a work order that already has a stored photo** — it would close
  before the tester sent a picture, proving the writer but never exercising MMS
  ingress, which under Option A is the point.
- The proof is read-only. **The completion it proves is not**: a real work order
  closes, with a real evaluation, permanently. Choose the target deliberately.

**§7.4's surface clause may not be dischargeable yet.** With no activation the
reader correctly reports `read_status: "unavailable"` and omits `state`, so *"the
operator surface reflects it"* cannot be closed. `prove_completion.js` reports
`surface_clause_discharged: false` rather than accepting it. **Either run boundary
8 first, or re-run Step 4 afterwards.** That is a sequencing decision and it is the
owner's.

---

## §3 — The frozen release train, boundary by boundary

**One boundary at a time: apply → verify → receipt → stop-condition check → only
then continue. Do not batch irreversible boundaries because the rehearsal is
green.** The rehearsal is isolated-Postgres evidence about the *sequence*; it is
not evidence about *this* database.

Before and after every boundary:

```bash
node tools/release0/where_are_we.js     # exit 1 when any stop condition holds
```

It reports each boundary LANDED / not from the database and the running checkout,
so a script cannot chain past a stop condition without noticing. **`where_are_we`,
not the boundary list, is the authority on where you actually are.**

### The operational fact that bites first

**A deploy does not migrate — and a build carrying an unapplied migration REFUSES
TO BOOT.** `migrations/migrate.js` runs on `prestart` in verify-only mode; a
migration file present in the build and missing from the ledger prints
`✗ REFUSING TO START` and exits 1. The service does not come up.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what the ledger says NOW — read it, do not recite it> \
EXPECTED_SHA=<the SHA that is ACTUALLY deploying> \
  node migrations/migrate.js --apply
```

`EXPECTED_SHA` must be the SHA actually deploying, not the one expected. That
mismatch already cost one retry — the guard refused and printed both values, which
is the guard working. And the ceiling is **140 after boundary 7b, not 137**;
`prove_migration_sequencing.js` S5 refuses the stale number verbatim.

### The order

| # | boundary | kind | reversible |
|---|---|---|---|
| 3 | Step 3 · canonical writer — **deploy verification owed** | verify only | code yes · **rows NO** |
| 4 | transport | §2 | n/a |
| 5 | Step 4 · handset completion | **GATE, nothing merges** | proof yes · **the completion NO** |
| 6 | Step 5 · app completion control removed | deploy + browser | yes |
| 7 | Step 6 · legacy done-path fails closed | deploy + **capture the instant** | in isolation only |
| 7b | **migration 140 · completion guard** | migration release, **BEFORE 8** | yes, measured both ways |
| 8 | Step 7 · census + activation | **RUN ONCE** | ❌ **NO** |
| 9 | Step 8 · four-state reader | deploy **after** activation | yes |
| 10 | migrations 138 + 139 · the §4.2 sweep | migration release + manual sweep | migrations & obligations **NO** |
| 11 | HTTP acceptance + `next_action` fix | deploy | yes |
| 12 | app consumer release | deploy | yes |
| 13a→13b→13c | retire `proof.satisfied` — app, app, API **in that order** | three deploys | yes |

The API stack is linear: `#59 → #60 → #61 → #62 → #63`. Each merges into the one
below it, so they land in order or not at all.

### ⚠ Capture the activation instant at boundary 7, and only there

Only after Step 6 lands can the legacy writer no longer create `closed` rows.
Capturing earlier leaves a window in which a legacy `closed` row would be terminal,
absent from the inventory, and rendered `missing_evaluation_defect` — **a defect
the system caused itself.** The instant is `$1` in the activation transaction and
is **never** `now()`.

### ⚠ Boundary 8 is the irreversible one

```bash
#  environment: R0_CENSUS_AUTHORIZATION → the name of the human who authorized
#               this census. It is printed into the receipt. The census must be
#               FRESH; the August 6 audit may NOT be used as the expected set.
node tools/step7/census.js
#  … then the activation transaction, with the captured instant as $1 …
```

It takes `SHARE ROW EXCLUSIVE … NOWAIT` on `work_orders` first. Not tidiness: a
transaction that *began before* the activation and commits after it reads through
its own frozen snapshot, never sees the activation row, and slips past the guard
entirely — proven at `REPEATABLE READ`. No `SELECT` escapes its own snapshot, so
it cannot be fixed inside the trigger. It is closed by refusing to open the window
underneath an in-flight writer.

**Stop conditions, each of which means stop and not retry-harder:**

```text
census ≠ expected, EITHER direction   re-census and find out what moved.
                                      Do NOT widen the comparison.
a legacy `closed` row after the        boundary 7 is not actually closed.
  captured instant
GUARD_ABSENT / GUARD_STALE             boundary 7b is not really in place.
WRITERS_IN_FLIGHT                      RETRY. Do NOT reduce the lock — NOWAIT
                                       fails in ~1ms and stalls nobody; a queued
                                       lock puts every new writer behind it.
POPULATION_NOT_EXPLAINABLE             terminal rows already violate the invariant
                                       and are invisible to the census. Resolve
                                       each named row, re-census, re-authorize.
                                       Activating past this makes them permanent
                                       and unexplainable.
```

`release_0_activation_history` and `release_0_legacy_cutover_inventory` are
append-only with `forbid_mutation` triggers. **A wrong inventory cannot be edited
out** — eight undo mechanisms were attempted against it and all eight refused.
Everything above this line exists to make sure it is right the first time.

### ⚠ Boundary 10 raises accountability facts about people

```bash
node tools/run_proof_defect_sweep.js            # DRY RUN — read what it WOULD do
node tools/run_proof_defect_sweep.js --raise    # only after reading that
```

**The sweep is an audit that the guard held, not routine cleanup.** With the guard
live at activation, ordinary DML can no longer add to the defect population, so a
non-empty result is a signal to investigate. There is no scheduler; until a human
runs it, a post-cutover defect is visible in the reader with no obligation against
it. The reader is honest either way. **The sweep cannot close what it raised, by
design.** Dry-run first, every time.

---

## §4 — Browser acceptance against the live API

**Signed in, against the deployed API. Not a fixture, not a capture.** The
fixture-based presentation proof (`proof_presentation_contract.browser.js`) is
already green and proves the *shapes*; it deliberately proves nothing about
production and does not discharge this.

What must be seen in a real browser, on the deployed app, against the deployed API:

```text
B1  a terminal work order renders its four-state proof result, and the state
    shown is the one the API emitted — not UNAVAILABLE-for-everything, which is
    what boundary 9 deployed before the activation looks like
B2  `next_action` does not contradict the proof state on the same payload
    (the boundary 9 defect: `satisfied` absent → falsy → "Obtain repair photo
    before completion" printed next to an unavailable proof read)
B3  no app path completes a work order — boundary 6
B4  the NOT-DONE path still works — `closeoutNotDone` is untouched and must
    stay that way
B5  a pre-cutover work order in the inventory reads as pre-cutover history,
    not as a defect
```

**B1 and B5 cannot be checked before boundary 8**, because before the activation
the reader correctly answers `unavailable` for everything. Do not read that as a
failure, and do not read it as a pass.

Preserve a screenshot per check. For operator workflows browser verification is
part of "done", and a described browser check is not a browser check.

---

## §5 — The final Release 0 receipt

```bash
#  environment: DATABASE_URL → production. Run ON the deployed instance.
node tools/release0/acceptance_receipt.js --json > release0_acceptance.json
node tools/release0/acceptance_receipt.js        # human
```

Every field is either a fact that run observed or the word `UNKNOWN` **with the
reason**. No field defaults to a hopeful value, and the last section names the
proof debt that is not dischargeable from a database read — the handset
completion, the browser verification. A receipt that quietly omitted those would
read as completeness.

Then classify Release 0 with one word per component, and no word without its
evidence:

```text
ACTIVATED   the activation and inventory exist in production, the guard was
            present and ENABLED at the moment it committed, and the invariant
            audit is empty afterwards
PROVEN      real DB + real HTTP + browser, with the receipt or screenshot to hand
LEGACY      inventoried pre-cutover history — known, bounded, not a defect
PARKED      built, proven in isolation, deliberately not run — say what unparks it
```

**Do not write ACTIVATED without the activation row, PROVEN without the receipt,
or LEGACY without the inventory.** The word without the evidence is the exact
failure this release was built to make impossible.

---

## What is explicitly NOT in this run

Boundaries, from the ruling that opened this sequence. None of these is started,
and none of them is a reason to delay the train:

```text
Intent 3 · blocked-work foundation · spend↔work-order · reassignment history ·
accountability expansion · Ask Spine polish · reopening migration 140 without
contradictory production evidence
```

**Build 1/2 is parked, not merged.** `docs/build1/BUILD_1_2_RELEASE_CANDIDATE.md`
is its own tree and does not ship ahead of this. Its one open integrity gap is
logged at `docs/build1/INTEGRITY_GAPS.md` and is **not** a Release 0 blocker —
Release 0 never reads `obligations.related_id`.

**Migration 142 / claim-accept stays out of the activation decision.** It is
composed and proven on the Build 1/2 tree, the frozen release train does not
depend on it, and its `VALIDATE` has its own read-only preflight
(`tools/build1/preflight_142_orphaned_acceptance.js`) for whenever that is taken
up separately.
