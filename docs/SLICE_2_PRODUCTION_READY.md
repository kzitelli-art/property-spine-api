# Slice 2 — Production Ready, and the one thing blocking the rung

**Status: RECONCILED WITH MAIN · PRODUCTION READY. Not deployed, not
established, not verified in production.** 2026-08-16, reconciled 2026-08-17.

> ⚠ **The migration numbers in the first draft of this document were wrong by
> the time it was written down, and that is the whole lesson of §3.**
> Production moved: Meeting Evidence merged to `main` and took **175 and
> 176**, so the three Slice 2 files are now **177 · 178 · 179**, and the live
> ledger ceiling is **176**, not 174. Reconciled in `3b21a73`. Numbers in a
> document are a snapshot of an assumption — the ceiling is read from the
> database at release time or it is not read at all.

No further architecture, UI expansion or financial modelling. The next
action is the release rail in §3, and nothing else. If production access
stays unavailable, this stays where it is — the blocked time is not to be
spent inventing more product.

Everything in steps 1–11 of the ship sequence is built and proven locally,
including the browser rung. Step 12 cannot start, for one reason, stated
below and nowhere padded with more architecture.

---

## 1 · The blocker, named exactly

```text
OUTBOUND HTTPS TO THE DEPLOYED API IS DENIED BY NETWORK POLICY

  curl https://property-spine-api.onrender.com/
    → CONNECT tunnel failed, response 403

  agent proxy status, recentRelayFailures:
    connect_rejected  property-spine-api.onrender.com:443
    "gateway answered 403 to CONNECT (policy denial or upstream failure)"

PRODUCTION DATABASE CREDENTIALS ARE NOT PRESENT IN THIS SESSION

  DATABASE_URL   unset
  no Render, Neon, or deploy credentials in the environment
```

That is infrastructure, not architecture. There is no code change that
makes it go away, and writing one would be replacing a blocker with work.

**The blocker is asymmetric, and saying so is the point.** Kameron has Neon
and Render access and has already released 175–176 and deployed `e5497a4`
from outside this container. This container does not, and does not need
credentials pasted into it to be useful — it produces the release rail, the
migrations and the proofs; the release itself is run where the access
already is. Nothing below assumes this session ever reads production.

**What it prevents, precisely:** reading the live migration ledger,
releasing 177–179, deploying, establishing Skyline through the production
path, staging the tracker there, signing in as a real operator, and
verifying 144 / 16 / 90.0% and $130,532 against production. Steps 1–12 of
the ship sequence, all of them.

**What it does not prevent, and what is therefore done:** every rung below
production. The full local suite, the DB proofs against real Postgres, and
the browser proof driving the real app against the real server on the real
Skyline import and Mike's real tracker.

---

## 2 · What is ready to release

Three migrations, in this order. **A deploy does not migrate** — `prestart`
verifies and refuses to start on a pending file, so releasing schema is a
separate, deliberate act before the code deploy.

```text
LIVE LEDGER CEILING AT RECONCILIATION   176   (175 + 176 are Meeting Evidence,
                                               released and deployed on main)

177_person_ingress_resolution_kind.sql     already written, not yet released
178_property_leasing_cycles.sql            new — the named cycle
179_activation_source_supersession.sql     new — which tracker version is current
```

The classifier that `migrations/migrate.js` uses was run with that same input
shape against a ledger simulated at 176: `duplicateFileNumbers []`,
`versionNameConflicts []`, `ledgerVersionMissingFromRepo []`, `ceiling 176`,
`structurallySound true`, and pending = exactly these three files and nothing
else.

### The release command

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who
has not read the ledger. **Read it first; do not copy a number from this
document** — it is a snapshot of an assumption, and the trap it guards has
already cost time twice (`docs/THREAD_HANDOFF.md` §3).

```sh
#  1. READ the live ceiling. This is the step the variable exists to force.
psql "$DATABASE_URL" -c "select max(version) from schema_migrations;"

#  2. Release, with what you just read.
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 printed> \
EXPECTED_SHA=<the sha being deployed> \
  node migrations/migrate.js --apply

#  3. Verify the ceiling moved to 179, then deploy API and app.
```

`EXPECTED_SHA` is **the sha actually being deployed**, so read it the same way
you read the ceiling — from the thing itself, not from here. A doc-only commit
moves the head without moving the product, which is exactly how a pinned sha
in a document goes quietly wrong.

```sh
git rev-parse origin/claude/code-philosophy-review-xoiz8f   # in each repo
```

### ⚠ The sha pin only started being enforced off Render on 2026-08-17

Until then `EXPECTED_SHA` was read **inside** `if (RENDER_GIT_COMMIT)`. Release
from a laptop, a container or another agent's environment and the variable was
compared to nothing and printed no error, while this runbook told you to pin
the exact code. The document asserted more than the executable measured.

The contract now, stated exactly so the runbook and the guard say the same
thing:

```text
ON A RENDER INSTANCE      EXPECTED_SHA is REQUIRED, compared to RENDER_GIT_COMMIT
ANYWHERE ELSE             OPTIONAL — but if you pin, it is CHECKED against this
                          repository's git HEAD, and the release also refuses
                          when tracked files are modified, because then the sha
                          is not the code
UNTRACKED MIGRATION       refused. This runner executes migrations/NNN_*.sql
                          from the FILESYSTEM, not from the commit, so a
                          migration no commit contains was invisible to the
                          tracked-file check and fully executable. Other
                          untracked files — .env, screenshots, notes, even
                          inside migrations/ — are still ignored
CANNOT BE RESOLVED        a pin that cannot be verified is REFUSED, never
                          accepted — unknown is answered as unknown
SHORTER THAN 7 HEX        refused; a prefix that matches many commits pins
                          nothing
OMITTED OFF RENDER        still allowed, and the banner prints
                          "NOT PINNED — no build was authorised"
```

### ⚠ And the second hole the first fix opened

Scoping the dirty-tree check with `--untracked-files=no` is right for `.env`
and screenshots and **wrong for a migration**, because the runner runs the
directory rather than the commit. That produced precisely the state the pin
exists to make impossible:

```text
git HEAD                     471f2e0…
EXPECTED_SHA                 471f2e0…
tracked files                clean
untracked                    migrations/180_something.sql
                             ↓
banner                       "VERIFIED against git HEAD"
actually executed            schema that commit does not contain
```

The guard now compares the migration files **on disk** against the migration
files **in the pinned commit**, discovered with the same `MIGRATION_FILE_RE`
the runner executes with — one definition, so the guard cannot drift into
scanning less than it asserts. `git ls-tree` is deliberately **non-recursive**:
a tracked `migrations/archive/181_decoy.sql` must not vouch for an untracked
`migrations/181_decoy.sql` sitting where the runner will find it.

**Pin with the full 40 characters at release.** Abbreviations of 7+ still work
and there is no reason to forbid normal git behaviour, but if the doctrine is
*exact build*, the release command should say the exact build:

```text
EXPECTED_SHA=471f2e0c797fc5eff2eae73c2436fa6ed32766f9   (re-read before release —
                                                         this commit is not it)
```

It stays optional off Render because four Class-3 seeding tools
(`tools/release0/prove_out_of_order_release.js`, `tools/scale/setup_baseline.sh`,
`tools/steps23/prove_step2_boundary.js` and the scale baseline replay) release
unpinned by design. Making it mandatory would have broken them — which is worth
knowing, because "just require it everywhere" is the obvious fix and it is
wrong.

**Release Slice 2 pinned.** `tests/migration_release_gate.test.js` refuses a
deliberately wrong sha off Render, accepts the exact HEAD, and refuses a
verified pin with an untracked migration on disk — and it is registered in
`verify_source_governance.js` so it runs without anyone remembering.

Falsified twice, against each runner it replaced:

```text
vs the ORIGINAL runner        10 of 33 fail, incl. "nothing was applied on the
                             way to that refusal" — it applied the pending
                             migration under a WRONG pin and exited 0

vs the FIRST SHA FIX          5 of 33 fail, incl. "it refuses BEFORE anything
                             is applied" — a MATCHING pin with an untracked
                             migration printed VERIFIED, applied it, exited 0
```

Both numbers come from running this file against those exact runners, not from
reasoning about them.

For orientation only, the commit that reconciled the code with `main`:

```text
API   3b21a73   the merge + renumber + gate scope
APP   5964848   browser proof re-run on the merged surfaces
```

### What 178 and 179 do to a live database

```text
178   CREATE TABLE property_leasing_cycles. New table only. Nothing reads
      it until a cycle is established, and every forward read still accepts
      explicit dates, so the deploy changes no existing answer.

179   ALTER TABLE activations — six nullable columns and one PARTIAL unique
      index on (property_id, source_kind) where status='activated' and
      superseded_by_id is null and source_kind is not null.

      ⚠ THE INDEX IS THE ONLY THING THAT CAN BITE. Existing activations
      have source_kind NULL and are therefore OUTSIDE the index entirely —
      by design, so no historical row is retro-classified into a lane it
      was never told about.
```

⚠ **The confirmation query in the first draft could not run, and would have
looked like a database problem.** It selected `activations.source_kind` —
the column 179 is what *creates*. Before the migration, ask whether the
column exists; only after it exists is counting rows a meaningful question.

```sh
#  BEFORE releasing 179 — expected: f
psql "$DATABASE_URL" -c "select exists (select 1 from information_schema.columns
  where table_schema='public' and table_name='activations'
    and column_name='source_kind');"

#  AFTER releasing 179 — expected: 0. Every historical activation sits
#  OUTSIDE the partial index, by design, so none is retro-classified into
#  a lane it was never told about.
psql "$DATABASE_URL" -c "select count(*) from activations where source_kind is not null;"
```

---

## 3 · The production sequence, once access exists

Unchanged from the ruling, with the one addition that the cycle must be
established before the surface can default to it.

```text
 1  read the live ledger ceiling
 2  release 177, 178, 179
 3  deploy API + app together
 4  establish Skyline through the canonical production path
 5  establish the 2026–27 cycle          2026-08-01 → 2027-07-31
 6  stage Mike's tracker through stageTrackerClaims — the SAME seam,
    no production-only loader
 7  real operator login, server-issued property scope
 8  open Forward Leasing
 9  prove 144 committed / 16 remaining / 90.0%
10  prove Forward Rent: $113,687 + $3,500 = $117,187 CLAIMED,
    $13,345 ASSUMED, $130,532 run rate, contractual NOT_ESTABLISHED
11  prove the monthly schedule steps down in January from real lease ends
12  prove Rent Roll · Person · Forward Leasing · Ask Spine all resolve to
    the same canonical property truth
```

**Step 6 is the one to watch.** The temptation under time pressure is a
production-only script that inserts claims directly. That would make the
production numbers unfalsifiable — they would prove the loader, not the
seam. The seam is `stageTrackerClaims`, it is the same function the browser
proof drives, and it must be what runs.

---

## 4 · What is proven, and at which rung

Re-run after the merge, not carried over from before it.

```text
PROVEN (real Postgres)
  forward_rent.db.js               42/42
  forward_leasing_ledger.db.js     20/20
  tracker_intake.db.js             18/18
  gate_ask_spine_readers.js        72/72
  gate_person_ingress.js           10/10
  gate_harness_isolation.js          8/8
  tenancy_ask_spine.test.js        43/43
  migration_release_gate.test.js   33/33   (was 12. The 21 new ones are the
                                            off-Render sha pin and the
                                            untracked-migration case, run in a
                                            scratch git repo the test builds,
                                            so the result is a fact about the
                                            guard and not about whatever tree
                                            the suite happened to run in)
  verify_source_governance.js      all 35 gates exit 0

BROWSER VERIFIED (real app, real server, real import, real tracker)
  forward_leasing_ledger.browser.js  85/85   on the MERGED app + MERGED API
  screenshots: docs/screenshots_forward_ledger/ (property-spine-app)

NOT VERIFIED
  anything in production. No step of §3 has been attempted.
```

**The inherited Equity red is gone, and not because I touched it.** `main`
registered `tools/equity/establish_position.js`, so `gate_harness_isolation.js`
went 7/8 → 8/8 on the merge. It listed that one consumer before and lists none
after.

Two reds surfaced during reconciliation and neither was a Slice 2 defect:

```text
conversation_intent_extraction   exit 3 — NOT PROVEN, not FAIL. It pins a
                                 byte comparison against commit 1454330,
                                 absent from this container's shallow clone.
                                 `git fetch --unshallow` made it reachable.
                                 The harness was right: an unproven check is
                                 not a passing check.

technician_work_selection        FAIL — a gate scanning WIDER than its own
                                 claim. "Acceptance is written in exactly
                                 one place" matched the column name
                                 accepted_by_user_id anywhere under src/,
                                 and `activations` carries one too, meaning
                                 "a human accepted this source document
                                 version". Each write now resolves to the
                                 table its UPDATE targets. Provoked for real
                                 with a second `update obligations set
                                 accepted_by_user_id` — red on it, green
                                 when removed. Not an allowlist; an
                                 allowlist is where a genuine second door
                                 would hide.
```

---

## 4a · Three semantic corrections made before freeze

Each closes a place where a correct number could still have been read as a
different, stronger claim.

**The schedule is a RATE, not earned rent.** `$815/mo` plus `starts
2026-08-03` does not establish what August earns, and `ends 2027-07-26`
does not establish a full July. Months in which a contributing term starts
or ends part-way through are marked *rate only* and report
`earned_rent_state: NOT_ESTABLISHED`; the figure is still shown, because it
is the run rate the active terms genuinely support. On Skyline that flags
August (87 terms start on the 3rd), December (40 end on the 28th), March,
May and July (69 end on the 26th). The panel is titled *Forward rent
schedule — scheduled rent run-rate by active term*, and says on the page
that it is not recognised revenue and not GPR. Proration, billing
convention, concessions and first/last-month treatment stay Money's.

**One decomposition, no residue.** The panel used to say *"142 committed
positions carry no established rent"* under a headline of 144, and nothing
let a person reconcile them. Both numbers were right and neither said which
question it answered. The set being partitioned is now the one the headline
counts — the tracker's commitments — and it is shown adding up:

```text
Of the 144 committed
  contractual rent established        0
  rent claimed only                 142
  rent missing                        0
  claims not attached to a bed        2
                                    ---
                                    144
```

Zero buckets are printed, because *0 with contractual rent established* is
the most important line on the panel today. Positions Spine holds a lease
for that the tracker never mentions are real, are outside the 144, and get
their own named line rather than being dropped — the same residue problem
pointing the other way.

**The two sixteens are two populations.** On this property both happen to
number 16 and they are entirely different things. They are now side by side
with the count and the reason on the same line:

```text
REMAINING BEDS                          COMMITTED CLAIMS · TERM NOT ESTABLISHED
16                                      16
inventory still to sell —               already counted inside the 144 committed —
$13,345/mo at stated asking rents       $12,200/mo of claimed rent that cannot yet
                                        be placed into months
```

---

## 4b · The language pass — glass only, reads untouched

`git status src/ migrations/` is empty after this pass: **no API file changed.**
The doctrine words are exactly where they were, in the payload, where they
are precise and where nobody has to read them. Only the glass moved.

```text
PAYLOAD (unchanged)          GLASS
per_tracker_committed        144 Signed & Pending, under 90.0% PRELEASED
lease_tied                   Lease on File
tracker_claim                Leasing Tracker
needs_review                 Needs Review
term_shape full_cycle        Full Year
term_shape first_half_only   Fall Only
contractual_rent_established Lease Rent in Spine
rent_claimed_only            Rent from Leasing Tracker
claims_not_attached_to_a_bed Bed Match Needed
open_bed_assumption          Remaining at Asking
full_sell_out_run_rate       Projected GPR
earned_rent_state            partial month
awaiting_contractual_tie     from the leasing tracker
```

**PRELEASED, not COMMITTED, and never OCCUPANCY.** Preleased is how much of
the cycle has been sold; occupancy is who is in the building today. The word
occupancy does not appear on this surface at all, and the browser proof
asserts its absence from the headline.

Forward Rent now reads in the reporting shape — Beds and Monthly Rent,
Signed then Pending, a rule, **Total Rent**; then Remaining with its asking
lines, a rule, **Remaining at Asking**; then **Projected GPR**. The rent
source block is four lines that answer "how much of this is on paper?"
without a paragraph of epistemology, and the browser proof asserts that the
words CLAIMED, ASSUMED, epistemic, run-rate and NOT_ESTABLISHED appear
nowhere on the panel.

**The machinery did not soften to make the language natural.** Every
distinction still holds in the payload and in the DB proofs: Signed ≠
Pending, lease evidence ≠ tracker evidence, tracker rent ≠ proven lease rent,
asking ≠ lease rent, preleased ≠ occupancy, missing dates ≠ invented Full
Year dates, partial month ≠ earned revenue, failed bed matching ≠ Remaining.

---

## 5 · Still parked, deliberately

```text
pace vs prior cycle              the historical commitment clock was never
                                 recorded and cannot be reconstructed
future physical readiness        contractually free is not offerable
prospect promise / offerable     needs governed future readiness
dated open-bed forecast          needs a stated term assumption per open bed
pricing optimisation             not a Pricing platform
concessions · screening ·        untouched
applications · e-sign
NOI · NCF · debt service ·       not built, not designed
valuation · owner sensitivity
```
