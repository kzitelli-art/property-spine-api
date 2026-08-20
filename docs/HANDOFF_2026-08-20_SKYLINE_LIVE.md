# HANDOFF — SKYLINE IS LIVE, AND WHAT THE BUILD DOES NEXT

**2026-08-20.** Read this with `docs/CURRENT_STATE.md`, which is the register of
what exists at what proof rung. This is the narrative: what changed today, what
it cost to learn, and what the next person should pick up.

---

## PART 1 · WHERE THINGS STAND

### The arc that closed today

This morning the leasing agent read `units.market_rent` — an ungoverned column
with no publish step, no version and no review — and put it in a prospect's
quote. It had already been wrong in production: $237 off on unit 530, to nine
real phones.

Tonight the agent reads a published, reviewed, dated pricing version and says so:
`basis=published_pricing_version`.

Four things had to be true, in order, and none of them were this morning:

| | | proved by |
|---|---|---|
| 1 | the fix is in `main` | PR #128 |
| 2 | `main` is deployed | owner deployed `bcd3089` from Render |
| 3 | Skyline has governed unit types | mapping applied, 72 units, 160 positions |
| 4 | Skyline has published pricing | `quotablePricing` returns $850 / $750 / $775 |

### What is live in production right now

```text
Skyline Apartments · 1417 N 15th Street, Philadelphia PA 19121
72 units · 160 beds · leasing basis: bed

unit types      2BR (56 units) · 3BR-1BA (14) · 3BR-1.5BA (2 — 1417-116, 1417-416)
pricing         $850 / $750 / $775 per bed per month
term            12 months ONLY — effective 2026-08-20
renewal         equals new lease
authority       Kameron Zitelli, asset_manager, granted through resolveAuthority
```

Ask the agent about a 5- or 7-month lease and it returns `term_not_published` —
an honest handoff. The +$150 short-term premium exists in
`docs/SKYLINE_OPERATING_FACTS.md` and in the leasing team's heads, and **nowhere
the software can reach.** For a discretionary price that is the correct
containment, not a gap.

### The one thing not yet observed

Everything above was verified **through the adapter, from a CLI, against
production data**. That proves the data and the adapter path.

**Nobody has asked the deployed agent for a price and watched what it says.**
That is a five-minute test, not a build, and it is the last rung. Until someone
does it, do not write `PRODUCTION_PROVEN` for the end-to-end path.

---

## PART 2 · THE CLEANUP THAT JUST SHIPPED — DEFECT #14

### What was wrong

`pricing_adapter.js` read `terms[0]` when a prospect named no lease term.
`effective_pricing.js:99` sorts terms by month ascending, so `terms[0]` is
**deterministically the shortest published term** — and short is dearest,
because that is the economics of short-term housing.

So *"how much is a 2 bedroom?"* — the commonest question in leasing — was
answered with the **highest number on the sheet**, returned as `quotable: true`
with `proof.basis = "published_pricing_version"`. A wrong-for-the-question number
wearing a governance receipt.

### Why it was interesting rather than just wrong

`effective_pricing.js:399` had already ruled on this exact case, 300 lines away:
with no term supplied it refuses `lease_term_not_selected` and hands back the
published **menu**. Its own comment says *"With no term supplied the answer is
the published menu."*

The adapter made the opposite call on the one path that speaks to prospects. Two
answers to one question, with the weaker one prospect-facing.

### What it does now

- **One published term → quotes it, states the term.** Nothing is being guessed,
  so refusing would hand off on a question with exactly one answer. Skyline's
  behaviour is unchanged.
- **Two or more → returns the menu and a question:** *"We have 2 Bedroom on 5 and
  12-month terms, and the rent depends on which you want — which length are you
  looking for?"*

That is better leasing than a single number, not worse.

**The agent needed no change.** Its not-quotable branch already forbids a figure
and hands the model `say` verbatim.

### Proof

`tests/e2e/agent_pricing_wall.e2e.js` — **22/22**, in `verify_all.sh`, in CI.

Proving it needed a **second property**. A published version's terms are frozen,
so a second term cannot be added to one already published — the trigger refuses
the INSERT, correctly. Two terms therefore means a version published *with* two,
rather than a rule bent to make a test convenient.

> **Not deployed.** The fix is on `claude/property-spine-orientation-cso2ao`.
> Production runs `bcd3089`, which still has `terms[0]`. It is dormant there —
> Skyline publishes one term — but it ships with the next deploy.

---

## PART 3 · WHAT THIS BUILD LEARNED TODAY

Five things cost real time and will recur. They are worth more than the code.

**A canonical mechanism existing is not proof the real path uses it.**
`pricing_adapter.js` was built to stop the `market_rent` leak and then sat
dormant while the defect kept running. The wall existed; the source read as
though the problem were solved.

**A vendor code is not a fact about a building.** `STU00017` was mapped to
3BR-1.5BA. Physical inspection found only 116 and 416 are 1.5 bath, while the
code covers four units. The first receipt said the source was *silent* on the
bath distinction; it is now known to *contradict* it. A silence invites a careful
inference. A contradiction forbids one.

**A refusal that only says "no" leaves the work undone.** The mapping refused
both named overrides and stopped. Once it printed what inventory actually held,
the answer was immediate — and it exposed the phantom units as a bonus.

**`effective_from` is when the sheet is in force, not when the lease starts.**
Publishing effective 2027-01-01 because the spring lease begins then would have
silenced the agent for four months, through the pre-leasing season the rents
exist for.

**A stale number repeated without its as-of date is the same defect as the one
being fixed.** I quoted 71.88% occupancy from a May 31 rent roll on August 20,
having used that same document's forward-looking section minutes earlier.

---

## PART 4 · WHAT'S NEXT, IN ORDER

### Immediately — cheap, and closes today's loop

**A. Ask the live agent for a price.** The only unobserved rung. Someone runs a
prospect conversation against production and confirms it says $850 and cites its
basis. Five minutes. Do this before anything else.

**B. Deploy the branch.** #14's fix, plus four release tools. No migrations —
pure code. Same manual Render deploy as `bcd3089`.

### Next — the business facts that are still blank

`docs/SKYLINE_OPERATING_FACTS.md` carries eight unresolved items. Three block
real work:

1. **Spring lease start date** — needed before a spring lease can be generated
2. **Parking: rate is $150/month, but the space count is unknown**, and the lease
   grants no parking right at all
3. **Renters-insurance rule** — the lease recommends, does not require

Plus the three things done in practice that the paperwork does not cover:
**furnished** (no furniture clause, no inventory schedule), **parking** (charged,
not granted), **fee amortization** ($500 payable monthly, no schedule in the
lease). None blocks pricing. Each is real exposure, and the pattern repeats at
every property.

### Then — the second property

`docs/PROPERTY_ONBOARDING_QUESTIONNAIRE.md` is the reusable framework, derived
from the schema's own controlled vocabularies rather than from experience of what
usually gets asked. Order: **A → B → C → J → D → E → F → G → H → I → K**.

**Two answers govern everything after them:** `leasing_basis` (bed vs unit) and
who binds the company. Get those wrong and the rework reaches every table.

The four release tools generalize with a property id and a person id:
`skyline_grant_staff_context` · `skyline_grant_authority` ·
`apply_unit_type_mapping` · `skyline_publish_pricing`. The mapping tool needs a
new ruling per property; the other three do not. **Renaming them off `skyline_`
is the honest first step** — they were written for one property and are not
specific to it.

### Open defects, ranked by what they actually cost

| # | what | cost to fix | why it waits |
|---|---|---|---|
| 17 | 159 phantom unit rows | investigation, then a careful delete | production delete, unknown FK reach; harmless today |
| 12 | immutability cascade hole | one `ALTER`, but a migration + release + deploy | needs someone to delete a property, which does not happen by accident. **It is also a policy question**: should deleting a property with published pricing be possible at all? |
| 13 | four dead pinning tests | a rewrite, not a cleanup | 1,200 lines carrying **eleven hardcoded production UUIDs**, including live person and login ids. They can only pass against production. **Decide revive-or-delete before spending anything.** |

### One governance question nobody has ruled on

`resolveAuthority`'s precondition 9 asks only that a reviewer and a reason
*exist*. **It does not require the reviewer to differ from the person receiving
the authority, nor to hold any standing of their own.**

Tonight's `asset_manager` grant was therefore self-reviewed, and the tool warns
about it rather than letting it read as "reviewed by a named human." At a
bootstrap that is unavoidable — nobody else held authority yet.

Ownership named **two** people who may approve pricing, which implies separation.
Making that real means precondition 9 requires an *authorized* reviewer. That is
a deliberate change to a governed rule, and it is the owner's call.

---

## PART 5 · HOW TO PICK THIS UP

```bash
git checkout claude/property-spine-orientation-cso2ao
git pull
./tests/e2e/verify_all.sh          # everything green, browser rung included
```

Read in this order:

1. `docs/CURRENT_STATE.md` — the register. Rungs, defects, what is proven
2. `docs/SKYLINE_OPERATING_FACTS.md` — governing business answers
3. `docs/PROPERTY_ONBOARDING_QUESTIONNAIRE.md` — the reusable framework
4. this file

**Production writes are the owner's call, every time.** Deploys are manual by
design. Every release tool is dry-run by default and verifies itself with
something other than its own report — keep it that way.
