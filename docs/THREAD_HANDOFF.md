# Property Spine — Thread Handoff

**Current as of `main` @ `8290adf` · 2026-08-01.**
Rewritten from the repository and from executed runs, not from the prior
handoff — which had gone 33 commits stale and was being read by every new
session as current truth.

---

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

## MIGRATION LEDGER — there is a GAP at 121

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
