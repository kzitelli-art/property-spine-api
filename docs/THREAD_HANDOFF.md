# Property Spine — Thread Handoff

**Current as of `main` @ `4983e5d` · 2026-08-03 (late).**
Read the top section first — it wins over everything below it. Each dated
section supersedes the ones under it; nothing is deleted, because the reasoning
in the older sections is still the clearest account of how each trap was found.

This file went 33 commits stale once and was read by every new session as
current truth. Re-date it whenever `main` moves materially.

---

## ══════════════════════════════════════════════════════════════════
##  STATE — 2026-08-03 (late). THIS SECTION WINS over everything below.
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
