# Pricing & Concessions — Evidence Inventory

**Read-only. Nothing was built, changed, or written.** 2026-07-27.

> ## ⚠️ CORRECTIONS — second pass, same day, live Neon + live Render
>
> A follow-up audit re-verified this file against the database rather than against source
> and prior sessions. Four claims below did not survive. Read these before the body.
>
> **1. Q1's concession finding is wrong. `current_concession` does not exist.** Not
> retired — **absent**. 38 `agent_facts` rows live, all on Demo Building, no such key at any
> status, and zero facts whose text matches month-free / concession / special. It exists only
> in `src/shared/facts-seed.js:165`, which was evidently never applied for this key. **The
> agent has never quoted a concession** — its prompt forbids stating one not in the facts.
> The line "a text string I seeded into `agent_facts` on 2026-07-25" should be read as
> describing the seed file, not the database.
>
> **2. The follow-up runner never read it.** `followup_runner.js` references `agent_facts`
> **zero times**. Its rung 3 was a hardcoded literal — "a month free right now on a one year
> lease ending July 2027" — in deployed source, so retiring a fact could never have reached
> it. Never fired: no comm_event matches. **Removed 2026-07-27** by owner decision;
> harness-proven in `tests/pricing_guards_proof.js`.
>
> **3. Q4's interpretation is refuted.** `units.market_rent` is **not** "a mix of asking and
> in-place rents." Across 114 studios with active leases it equals the in-place lease rent in
> only **9** cases, and in-place is consistently *lower*. It is a third thing: a per-unit
> number that mostly matches the sheet ($1,450 ×75, $1,600 ×32) with an unexplained scatter
> above it ($1,475 · $1,505 · $1,555 · $1,605 · $1,655 · $1,687, plus one $1,045). **Every
> off-sheet studio is occupied except 530.** Unit 530 is 363 sq ft — identical to 30 peers all
> at $1,450 — and is the highest studio number in the building. A population of one.
>
> **4. Q3's open question is answered.** The seven routes are behind the global
> `x-operator-key` gate (`server.js:147`, mounted `:3385`) — **not public**. The real defect is
> attribution, not access: actor *and* property arrive in the **request body**
> (`published_by_person_id`, `granted_by_person_id`), so a key-holder acts as any authorized
> person with nothing recording who did it — a §21 violation of the same shape as the comms
> attribution defect. Practical reach is contained **by emptiness, not by design**:
> `concession_authority_grants` is 0 rows and no-grant = HARD fail-closed, and `canPublish`
> reads the **`assignments`** table (*not* `property_team_assignments`, so migration 090's
> portfolio admin grants do not apply) where exactly **one** publish-capable identity exists —
> Jordan Avery (demo), `owner`, Demo Building. Real Solo has none.
>
> **Also established:** the ledger cannot work for three independent reasons, so populating
> the tables would not start it — tables empty · `computeScheduleLines` is a throw-only stub
> with `IMPLEMENTED_TIMING_PROFILES = []` · `lockLeaseEconomics`, `computeScheduleLines` and
> `findEligibleOfferForApplication` have **zero callers repo-wide**, and `countersign` appears
> in no `.js` file. `ledgerService` is passed into `applications.js:41` and
> `tenancy_anchor_service.js:53` and never invoked.
>
> **And the live concession nobody was looking at:** `move_in_credits` — $500 first
> responders, $500 military/veterans, $300 Penn Dental/Vet, "applied as a one-time credit
> after lease execution." Undated, unversioned, no authority. Owner ruling 2026-07-27:
> **these are concessions.**

Answers the four questions asked before any build. Claim level on every item, per the vocabulary: `Proven` (real DB / real HTTP, with receipt) · `Built` (source exists and boots) · `Reported` (unverified claim).

---

## Q1 — What does the agent actually read when it quotes a price?

**`units.market_rent`. Nothing else. `Proven`.**

`src/agent/agent.js:294`:
```sql
select unit_number, bedrooms, bathrooms, square_feet, market_rent from units where id = $1
```
That single row becomes `unitLine` (`:397`) and is interpolated into the system prompt at `:702`. When `market_rent` is null the prompt literally says *"rent not on the unit record"* — an honest blank, correctly.

**The agent has no connection to the pricing module. `Proven`** — `grep` for `pricing_terms|concession_policies|lease_offers` across `src/agent/` and `src/leasing/` returns nothing.

**Concessions are worse. `Proven`.** The agent's only concession knowledge is `current_concession`, a **text string I seeded into `agent_facts` on 2026-07-25**, transcribed by hand from a marketing PDF. It is not a governed object, carries no version, no authority, no dates, and no economic meaning. It is exactly the mutable pricing that migration 062's doctrine D9 exists to forbid. **I wrote it without knowing this module existed. It should be retired the moment a governed source can answer.**

---

## Q2 — Does a pricing object exist in schema?

**Yes. Seven tables, all empty. `Proven`** (counted against live Neon):

```
property_pricing_versions      0
pricing_terms                  0
concession_policies            0
concession_authority_grants    0
lease_offers                   0
lease_economic_schedules       0
lease_economic_lines           0
```

**Built, never populated, effectively invisible.** The only reader anywhere in `src/` is `src/money/commitmentledger.js`. This matches the reconstruction exactly: the economics shipped, the surface never did.

---

## Q3 — What is reachable on the open ledger write surface, and by whom?

**`COMMITMENT_LEDGER_MODE = enabled` in production. `Proven`** — read from the Render API for the live service, not inferred. Locally the var is absent, so local runs default to `dormant`; **production and local disagree.**

`src/identity/dormant_gate.js:32` — anything other than the literal `"enabled"` is dormant. Production is the one environment where it is open.

Write routes behind that gate (`src/money/commitmentledger.js`), all currently reachable:

| Route | What it writes |
|---|---|
| `/pricing/:propertyId/publish` | a new published pricing version |
| `/pricing/:propertyId/active` | active pricing selection |
| `/lease-offers` | an offer |
| `/lease-offers/:id/qualify` | offer qualification |
| `/lease-offers/:id` | offer mutation |
| `/concessions/incidents` | a concession incident |
| `/concessions/incidents/:id/resolve` | incident resolution |

The gate's own refusal text says enabling *"requires an explicit COMMITMENT_LEDGER_MODE change and a separate release decision."* **Whether that separate release decision was ever made is not something I can determine from the repo. `Reported`.**

**"By whom" is NOT answered. `Reported`.** I did not trace the auth middleware on these routes, so I cannot say who can reach them. That is the one question in this inventory I am leaving open rather than guessing at, and it is the one that decides whether the exposure is theoretical or real.

**Also found while reading production env, not asked for but material:**
- `SMS_SEND_MODE = customer_care` — sends to real customers are live, not proof-only.
- `DEMO_MODE = true` in production.

---

## Q4 — Where did $1,687 and $1,450–1,600 come from?

**Both sources identified. `Proven`.**

- **$1,687** — `units.market_rent` for unit 530 (studio, 363 sq ft, Demo Building). Read from live Neon.
- **$1,450 / $1,600** — `Current Pricing & Specials July 2026.pdf`, rows `S.1UN` and `S.1FN`.

**Neither is "wrong." They are different concepts, and that is the actual finding.**

Reading all 283 unit rows: most studios sit at **exactly $1,450 or $1,600**, matching the sheet precisely. The disagreements are scattered one-offs — $1,687, $1,655, $1,605, $1,555, $1,505, $1,475 — plus two that cannot be asking rents at all: **unit 438 at $1,045** and **unit 316 at $1,200**.

Sheet premiums do not explain 530. It is on the 5th floor and its number is even, so no premium applies; the sheet says it should be $1,450, or $1,600 furnished.

**Interpretation — `Reported`, not proven:** `units.market_rent` is a rent-roll-derived column carrying a mix of asking rents and in-place/legacy rents. The sheet is a published asking price. They are two different things sharing one column, which is precisely the gap `property_pricing_versions` was designed to close. **This is why "which source wins" was the wrong question** — I asked it in `SOLO_FACTS_PACK.md` §1, and it has no good answer. The right answer is a published price object neither of them currently is.

**Separately: `units` contains a non-apartment row.** Unit `4233`, 7391 sq ft, `market_rent = 0.00` — the building/retail record. The agent reads `units` unfiltered, so this is quotable in principle.

---

## Q5 — the commercial unit (found while tracing Q4)

Unit `4233` is **not bad data**: it is the property's commercial space, a Pennsylvania state liquor store. 7,391 sq ft, `market_rent = 0.00`.

**It is not offerable today. `Proven`** — its `occupancy_status` is `unknown`, and `availableUnits()` requires `'vacant'`:

```sql
property_id = $1 and occupancy_status = 'vacant' and coalesce(is_down,false) = false
```

**But it is excluded by accident, not by design.** Nothing in that filter says "residential." Results are ordered `market_rent asc nulls last`, so at `$0.00` this row sorts **first**. If anyone sets that status to `vacant`, or an import normalizes `unknown` → `vacant`, a state liquor store becomes the top unit the agent offers a residential prospect — and it passes any `max_rent` filter ever applied.

**Also `Proven`: only three vacant units exist** on Demo Building — 530, 402, 602. That is the entire offerable inventory. 530 sorts first at $1,687, which closes the trace: it is the unit quoted in a live SMS, and the same row whose price disagrees with the sheet.

Candidate guard, **not built**: `and bedrooms is not null` in `availableUnits()`, which excludes commercial rows and anything else lacking residential shape.

---

## The finding

The AI states prices and concession terms to real prospects, unattended, from:
- a rent-roll column that mixes asking and in-place rents, and
- a concession string typed by hand from a PDF two days ago.

Meanwhile a governed, versioned, authority-scoped pricing system sits fully built, empty, and unreachable by the surface that talks to prospects. The follow-up runner now composes copy from that same hand-typed concession, which makes this load-bearing in an unattended send path.

**The exposure is not that the numbers are wrong.** Most of them are right. It is that nothing makes them right — there is no object that could be audited, versioned, or corrected once, and no path by which a pricing change reaches the agent at all.

---

## What I did NOT do

No build. No writes. No seeding. No changes to the pricing tables, the ledger flag, or `units`.

## Open, in the order I would ask them

1. **Who can reach the open ledger write routes?** Unanswered above. Decides whether `COMMITMENT_LEDGER_MODE=enabled` is a live risk or a latent one.
2. **Was the release decision for enabling the ledger ever made?** The gate's own text says one is required.
3. **What drives a price** — where does an asking rent come from, who changes it, what proof does a change carry? Unanswered since the original build stalled.
4. **What is an offered concession before anyone signs?** The economic lines exist at execution; nothing models the offer.
5. **Should `units.market_rent` keep serving two masters,** or does published asking price move to `property_pricing_versions` and leave `units` holding in-place rent only?
