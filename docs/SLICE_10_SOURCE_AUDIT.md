# Slice 10A — Forward Rent Roll Authority Audit

**Final classification: BLOCKED — live migration ledger and production schema not
independently verified.** Additional blockers listed in §17.

The headline finding is not what this packet expected to find. **Forward Rent Roll
already exists in source** — as a canonical dated-position service, a facts-only
future read, and a live route. The question is therefore not "can it be built"
but "where is the existing authority sound, and where does it stop being true."
Three places, named in §6, §9 and §12.

---

## 1. Runtime identities and evidence limits

| fact | value | evidence |
|---|---|---|
| API main SHA | `590f2c9823110d1be46d91d204382dc6a3d0b9c4` | SOURCE PROVEN |
| App main SHA | `3be139970bf85429955799fd3219cae6c3640c69` | SOURCE PROVEN |
| API worktree | clean, audited on `main` | SOURCE PROVEN |
| App worktree | clean, audited on `main` | SOURCE PROVEN |
| Deployed API identity | `d3698d3` (Slice 9 merge) | REPORTED — Render dashboard, owner-supplied |
| Deployed app identity | `3be1399` | REPORTED — owner-supplied, browser verified |
| Open API PRs | #35 (docs, Slice 9 receipt), #33 (draft, baseline migration evidence) | SOURCE PROVEN |
| Open app PRs | none | SOURCE PROVEN |
| Migration files in runner | 129 files incl. `000_` ledger; versions 001–129 **except 125** | SOURCE PROVEN |
| Staged outside runner | `docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql` | SOURCE PROVEN |
| Duplicate version prefixes | none | SOURCE PROVEN |
| Highest repository version | 129 `property_line_uniqueness` | SOURCE PROVEN |

**Live Neon ledger: NOT INDEPENDENTLY VERIFIED.**
The build environment's network policy denies Neon and the production origin
(`403` to `CONNECT`), and no production credential exists here. The owner ran
`select version, name from schema_migrations order by version desc limit 8` and
supplied: ceiling **128**, rows 128, 127, 126, 124, 123, 122, 121, 120. **125 and
129 absent.** Confidence: **REPORTED**. Rows below 120 have never been seen by
this thread.

**Production schema was never dumped.** No column, type, index, constraint or row
count in this document is RUNTIME PROVEN. Every schema statement below is SOURCE
DECLARED — read from migration files, which prove repository intent and nothing
about the running database. §15 makes that verification mechanical.

**Repository-side collision scan:** no migration was created, reserved, renamed
or edited. Version 130 is the next free number; this packet does not claim it.

---

## 2. Existing Forward Rent Roll paths

The vocabulary search surfaced a substantial existing implementation, not a
greenfield.

| path | classification | evidence |
|---|---|---|
| `src/tenancy/position_classifier.js` | **canonical authority** — pure, no I/O; the shared meaning of a rentable position | SOURCE PROVEN |
| `src/tenancy/dated_positions.js` | **canonical projection** — "the canonical dated property-position read" | SOURCE PROVEN |
| `src/tenancy/space_position.js` | **canonical authority** — dated space position, possession recording | SOURCE PROVEN |
| `src/surfaces/future_rent_roll_facts.js` | **canonical projection** — Future Rent Roll, contractual facts only | SOURCE PROVEN |
| `src/surfaces/rent_roll_canonical.js` | canonical projection — current rent roll | SOURCE PROVEN |
| `src/money/future_rent_roll_pricing_contract.js` | separate lane — governed pricing, explicitly NOT facts | SOURCE PROVEN |
| `GET /operator/rent-roll/future-facts` (`src/identity/operator.js:1924`) | live route | SOURCE DECLARED — route exists in source; not verified on the deployed process |
| `GET /operator/rent-roll/canonical` (`:1323`) | live route | SOURCE DECLARED |
| `GET /operator/rent-roll/institutional` (`:1897`) | live route | SOURCE DECLARED |
| `GET /operator/pricing/future-rent-roll-preview` (`:1879`) | live route | SOURCE DECLARED |
| `GET /operator/leasing/renewals` (`:1952`), `availability-canonical` (`:1344`) | live routes, same position truth | SOURCE DECLARED |
| `POST /operator/rent-roll/import` (`src/shared/snapshot_loader.js:1001`) | import staging — attributes and disputes canonical rows, does not define them | SOURCE PROVEN |
| `app/solo-rent-roll-data.js` | **stale or unreachable** — see §12; contains real resident names and financials | SOURCE PROVEN with residual uncertainty |
| `app/index.html` browser occupancy math (`:5109`, `:5343`) | **browser-authored business meaning** — see §12 | SOURCE PROVEN |

`dated_positions.js` states its own scope in its header: *"One service. Four
interpretations: Current Rent Roll · Renewals · **Future Rent Roll (as_of = a
selected date, facts only)** · Availability."* The architecture already
anticipates this slice.

**Not traced:** I did not enumerate every consumer of every route above. Where I
say "live route" I mean the route is defined in source at the cited line. Whether
the deployed process exposes it is UNKNOWN — REQUIRES PROOF.

---

## 3. Canonical grain and lineage

**CURRENT FACT.** The canonical leaseable position is **`spaces.id`**.
`migrations/001_baseline.sql:105` defines `spaces`, and its comment states the
invariant directly: *"every unit has ≥1 space, and a lease attaches to a SPACE,
never directly to a unit. This is what lets whole-unit and by-the-bed leasing
share one code path."*

Confirmed by the schema rather than the comment:

- `leases.space_id uuid not null references spaces(id) on delete restrict` (`001:133`)
- `executed_lease_records.space_id uuid not null references spaces(id)` (`088`)
- `lease_economic_schedules.space_id uuid not null references spaces(id)` (`063`), annotated *"D5: ALWAYS exact"*

All three contractual rails attach at space grain, not unit grain. Evidence:
**SOURCE DECLARED** (migration files).

**Lineage:**

```
properties.id
  → units.property_id            (units.id, unit_number, market_rent)
    → spaces.unit_id             (spaces.id ← THE POSITION)
      → leases.space_id                       — operational lease account
      → executed_lease_records.space_id       — admitted contractual claim
      → lease_economic_schedules.space_id     — dated economics
      → possession events (space_position.js)
      → notice (src/tenancy/notice.js)
```

**CONFLICT OR GAP.** `spaces` carries **no `property_id`**. Property lineage for a
position is `space → unit → property`, a two-hop join on every property-scoped
read. That is a correctness-neutral but scale-relevant fact (§11).

**No inference is required, and the code already refuses it.**
`space_position.js:recordEffectivePossession` resolves a space from a unit only
when the unit has exactly one space, and otherwise throws `AMBIGUOUS_SPACE`:
*"cannot resolve space: lease has no space_id and unit is not single-space."*
That is the no-inference doctrine already enforced in source rather than
promised. Evidence: **SOURCE PROVEN**.

**One attested seam.** `lease_economic_schedules.space_resolution` permits
`caller_attested_segment`, where the property wall is verified but segment match
is *attested by a locking human* because *"units carry no unit_type column
today."* That is a human attestation, not an inference by code — but it is a
weaker proof class than `exact_offer_bound`, and Forward Rent Roll must not treat
the two as equivalent without a ruling. See §16-R4.

**SMALLEST PROPOSED RULE.** Forward Rent Roll rows are keyed on `spaces.id`, one
row per space, property-scoped through `units.property_id`. No unit-grain row is
ever emitted, and no unit-grain record is bridged to a space except where a
governed `space_id` column already carries it.

**AUTHORITY REQUIRED.** None. Current doctrine and current schema settle this.

---

## 4. Contractual authority map

Four rails carry lease-shaped facts. They are **not peers**.

| rail | class | identity | position lineage | dates | proof/correction |
|---|---|---|---|---|---|
| `leases` (`001:131`) | operational lease account / **system of record for spanning** | `leases.id` | `space_id` NOT NULL | `start_date`, `end_date`, `lease_status` | none — no supersession column |
| `executed_lease_records` (`088`) | **admitted contractual claim** | `id`, `supersedes_record_id` | `space_id` NOT NULL | `lease_start_date`, `lease_end_date`, `executed_at`, `effective_date` | `record_state`, `verified_by_user_id`, `event_id`, `payload_hash`, `document_sha256` |
| `lease_economic_schedules` + `_lines` (`063`) | **dated economics** | `schedule_id` | `space_id` NOT NULL | `effective_month` per line | `status: locked/active/cancelled/superseded`; rows never edited |
| `lease_applications` / `lease_offers` | pipeline, pre-contractual | — | via conversion/offer | submission and approval milestones | Slice 9 rails |

`executed_lease_records.lease_id` is **nullable** — an admitted contractual record
need not point at a `leases` row. Conversely `leases` has no pointer to its
admitting record. The join between the operational account and the admitted claim
is therefore optional in both directions. Evidence: **SOURCE DECLARED**.

**CONFLICT OR GAP.** The existing projection reads **`leases` only**.
`position_classifier.js:classifyPosition` receives `row.leases[]` and derives
everything from `lease_status` plus `start_date`/`end_date`.
`executed_lease_records` is consumed by `src/tenancy/` and `src/evidence/` but is
**not** the input to the dated position read. So the admitted, verified,
supersession-aware rail is not what decides whether a term covers the selected
date; the operational account is. Whether every admitted record has a
corresponding `leases` row is **UNKNOWN — REQUIRES PROOF** (§15-Q7).

**SMALLEST PROPOSED RULE.** Forward Rent Roll continues to read `leases` for
coverage, and reports a position as `conflict` when an `executed_lease_records`
row exists for the same space whose dates disagree with the `leases` row, rather
than silently preferring either.

**AUTHORITY REQUIRED.** **Owner ruling** — see §16-R1. This is precedence between
two rails that both look authoritative, and no code currently governs it.

---

## 5. Claim classes

**CURRENT FACT — and this is the strongest existing answer in the audit.** The
claim-class distinction is already governed in code, not merely documented.

`position_classifier.js:126–128`:

```js
const current            = leases.find(l => CURRENT_ECONOMIC_STATUSES.has(status(l)) && datesSpan(l, asOf));
const activationPending  = leases.find(l => status(l) === "pending" && datesSpan(l, asOf));
const future             = leases.find(l => isFuture(l, asOf));
```

with `CURRENT_ECONOMIC_STATUSES = {active, commercial}` and
`TERMINAL_LEASE_STATUSES = {cancelled, terminated, rescinded, void, expired, superseded}`.

`space_position.js` states the rule plainly: *"A pending lease is never promoted
into current rent-roll truth merely because its start date arrived. Required
move-in funds must first activate the lease."*

`future_rent_roll_facts.js` restates it as a contract:

- a successor is locked **only** under the governed executed-and-funded rule;
- *"a 'pending' lease_status never closes an economic position"*;
- *"pending successors contribute ZERO locked rent and ZERO projected rent"*;
- *"open and contested positions contribute ZERO locked rent"*;
- *"no pricing assumption fills an uncovered position."*

So: **date arrival is not commitment, and funding is.** Approved applications,
unsigned renewals and verbally accepted renewals never appear in this rail at all
— they are `lease_applications` / `renewal_cases`, and no code path promotes them
into a lease position. Evidence: **SOURCE PROVEN** for the classifier logic;
**SOURCE DECLARED** for the funding rule (I did not trace the activation writer).

**CONFLICT OR GAP.** Two classes are unresolved:

1. **Imported future leases.** `snapshot_loader.js` ingests rent-roll documents.
   Whether an imported future term can reach `leases` with a `pending` or
   `active` status — and therefore count — is **UNKNOWN — REQUIRES PROOF**.
   `dated_positions.js` says the import *"attributes and disputes"* the canonical
   row set rather than defining it, which is the right inversion, but I did not
   trace the writer to confirm no import path sets `lease_status='active'`.
2. **`caller_attested_segment` economics** (§3) — weaker proof, same treatment.

**AUTHORITY REQUIRED.** None for the core rule; it is already governed and should
be frozen as-is. **Owner ruling** for imported terms — §16-R2.

---

## 6. Contractual economics — THE CENTRAL GAP

**CURRENT FACT.** Two rent rails exist, and Forward Rent Roll reads the weaker one.

`future_rent_roll_facts.js:106`:

```js
contractual_rent: p.lease && p.lease.rent != null ? Number(p.lease.rent) : null,
```

`dated_positions.js:94–97`:

```js
function economicsState(p) {
  const lease = p.current_lease_position;
  ...
  return (lease.rent == null || Number(lease.rent) === 0) ? "unavailable" : "available";
}
```

That is **`leases.rent numeric(10,2)`** — a single, **undated** amount on the
lease row (`001:131`). Meanwhile `lease_economic_lines` (`063`) models economics
properly: one row per `effective_month`, with `line_type` in
`{base_rent, recurring_fee, one_time_fee, concession_credit, fee_waiver}`, a sign
constraint forcing credits negative, and a `reconciliation_state`. **That rail is
not consulted by the position read.** Evidence: **SOURCE PROVEN** — I grepped
`dated_positions.js` and `future_rent_roll_facts.js` for `economic` and found no
reference.

**Why this is load-bearing rather than cosmetic.** Forward Rent Roll asks for
contractual rent *on a selected future date*. A single undated `leases.rent`
cannot express:

- a dated rent step inside the term (month 7 differs from month 1);
- a concession that begins after start or ends before end;
- free-rent months;
- any economics attached to a future term that has no `leases` row yet.

On today's date the two rails usually agree, because month 1 is the whole story.
**On a future date they can disagree silently**, and the surface would report a
confident number sourced from a field that does not know about the step. That is
precisely the Slice 9 failure shape — two individually correct numbers, no stated
population — promoted from labelling to arithmetic.

**What the current code gets right, and should be preserved:** zero is treated as
*unavailable*, not as a rent (`Number(lease.rent) === 0 → "unavailable"`);
economics is a **separate axis** from occupancy, so *"a locked position with
unavailable rent stays locked; its rent simply is not known and is never coerced
to $0"*; and `units.market_rent` (`001:88`) is never read by either projection —
market rent is correctly not treated as contractual rent.

**CONFLICT OR GAP.** Whether `lease_economic_lines` is populated in production at
all is **UNKNOWN — REQUIRES PROOF** (§15-Q8). If it is sparse, promoting it to
authority would convert working rows into `unavailable`. If it is populated, the
current read is under-reporting dated truth. The audit cannot choose without row
counts.

**SMALLEST PROPOSED RULE.** For a selected date D, contractual rent is:

1. the `base_rent` line of the governing schedule whose `effective_month`
   contains D, plus any `concession_credit`/`fee_waiver` lines effective in that
   month, when a schedule exists and its `status` is `locked` or `active`;
2. otherwise `leases.rent` **only when the term has no economic schedule at all**;
3. otherwise `null` — never zero, never carried forward from a prior month, never
   substituted from `units.market_rent`.

A position whose rent resolves to `null` stays counted in occupancy and is
excluded from the rent total, and its exclusion makes the rent total **partial**.

**AUTHORITY REQUIRED.** **Owner ruling** — §16-R3. Rule 2 is a precedence choice
between two rails, and rule 1's treatment of one-time fees (excluded from a
monthly rent figure, in my reading) is a product decision, not a schema fact.

---

## 7. Position, resolution and denominator vocabularies

**CURRENT FACT.** A vocabulary already exists and is deliberately multi-axis.
`position_classifier.js` returns, among others:

- `availability_state`: `unavailable` · `on_notice` · `committed_activation_pending` · `vacant_turning` · `committed_future` · `ready_now`
- `conflict_state`: `conflicted` | `clear`, with `conflicting_lease_ids`
- `next_required_action` + `reason` (see §9 — these are *not* obligations)

`future_rent_roll_facts.js` collapses those into a future state by precedence,
beginning `contested` when `p.conflict_state === "conflicted"`, then
`contractually_locked`.

`dated_positions.js` adds `tenancyState` (`contractually_occupied`) and
`economicsState` (`available` | `unavailable` | `not_applicable`) as **separate
axes**, with the header warning that *"collapsing them is how a disagreement
becomes a clean-looking number."*

The three-axis model this packet asked for therefore already exists in substance.
The mapping is close but not identical:

| requested | existing | mapping |
|---|---|---|
| `current_term_covers` | `current` + `tenancyState=contractually_occupied` | exact |
| `future_term_covers` | `committed_future` / `contractually_locked` via successor | exact |
| `notice_uncovered` | `on_notice` (availability axis) | **not exact** — `on_notice` describes a *covered* position with notice given; "uncovered" is a different claim |
| `vacant_uncovered` | `ready_now`, `vacant_turning` | requires merge; `vacant_turning` adds physical state |
| `non_revenue` | **absent from the classifier** | see gap |
| `conflict` | `conflict_state=conflicted` | exact |
| `unavailable` | `economics_state=unavailable` is a *different* meaning | **collision of the word** |

**CONFLICT OR GAP.** Three real ones.

1. **`unavailable` means two things.** In `economicsState` it means "rent not
   known." In the requested position vocabulary it means "the position's state
   could not be determined." Shipping both under one word would reproduce the
   Slice 9 defect in the state machine itself.
2. **Non-revenue classification is not in the position classifier.**
   `src/tenancy/down_units.js` exists and `property_unit_types` is a table, but
   whether either yields a governed non-revenue flag per space is **UNKNOWN —
   REQUIRES PROOF**. Without it the denominator class cannot be computed, and
   the denominator is what every rate depends on.
3. **`notice_uncovered` is a composite** of notice + absence of a successor term.
   It is derivable from existing facts but is not currently a named state.

**SMALLEST PROPOSED RULE.** Freeze the position axis as the seven states
requested, but rename the economics axis value to `rent_unknown` so one word
never carries two meanings. Derive `non_revenue` from a single governed source
once §16-R5 is ruled; until then every position is `denominator_class = unknown`,
which by §8 forces the occupancy rate to `null`.

**AUTHORITY REQUIRED.** Owner ruling for non-revenue source (§16-R5). The rename
is doctrine, not preference.

---

## 8. Reconciliation and withholding rules

**CURRENT FACT.** `future_rent_roll_facts.js` already implements the zero-rules
this packet asks for: pending successors contribute zero locked rent, contested
positions contribute zero locked rent, no pricing assumption fills an uncovered
position, and a locked position with unknown rent is *"reported as a split WITHIN
locked"* rather than dropped or zeroed. Evidence: **SOURCE PROVEN** (header
contract + `:103–108`).

The invariant `projected_occupied = current_terms_covering + future_terms_covering`
is **structurally supported**: the classifier derives `current` and `future` from
the same filtered lease list at one `asOf`, so the two are disjoint by
construction (a lease spanning `asOf` is not `isFuture`).

**CONFLICT OR GAP — the reconciliation breakers.** Each of these is real against
the current source:

| breaker | current behaviour | evidence |
|---|---|---|
| two overlapping non-terminal leases | detected — pairwise `rangesOverlap`, `conflict_state=conflicted` | SOURCE PROVEN |
| two *future* terms covering the date | `leases.find(isFuture)` returns **the first**; if they overlap, `conflict_state` catches it; if they do **not** overlap, the second is silently unreported | SOURCE PROVEN |
| missing `end_date` | `datesSpan` treats a null `end_date` as **spanning forever** | SOURCE PROVEN |
| missing position lineage | impossible — `leases.space_id` is NOT NULL | SOURCE DECLARED |
| unit-grain / space-grain double count | impossible in this rail — everything is space-keyed | SOURCE DECLARED |
| non-revenue overlapping a lease | **UNKNOWN — REQUIRES PROOF** (§7 gap 2) | — |
| duplicate imported lease | **UNKNOWN — REQUIRES PROOF** — depends on whether import writes `leases` | — |
| correction that did not supersede | `leases` has **no supersession column**; only `executed_lease_records` does | SOURCE DECLARED |

The two that would change published numbers are **missing `end_date`** (an
open-ended term covers every future date, so it inflates `projected_occupied` at
every horizon) and **non-overlapping multiple future terms**.

**SMALLEST PROPOSED RULE.** Adopt the Slice 9 metric contract verbatim:

```
zero denominator                                          → rate = null (state: empty)
any conflict capable of changing numerator or denominator → rate = null (state: partial)
any position with denominator_class = unknown             → rate = null (state: partial)
missing economics on a counted position                   → rent total is partial, occupancy unaffected
```

and add one Forward-Rent-Roll-specific rule: **a spanning lease with a null
`end_date` is `unresolved_expiration`, not `current_term_covers`.** It is an
open-ended claim, and treating it as covering an arbitrarily distant date is an
inference the record does not support.

**AUTHORITY REQUIRED.** The null-`end_date` rule is an **owner ruling** (§16-R6)
— it changes historical numbers. The rest follows Slice 9 doctrine directly.

Carrying the Slice 9 lesson forward explicitly: **every summary must state its
population, its selected date, its denominator, its filter scope, whether
conflicts are included, and whether evidence is complete** — because Forward Rent
Roll will place a window-scoped rate beside a whole-property row count, which is
the exact adjacency that produced the Slice 9 acceptance defect.

---

## 9. Existing actions and destinations

**CURRENT FACT — and this is the second load-bearing gap.**
`position_classifier.js` produces `next_required_action` values:

```
economic_tenancy_activation_required
possession_outstanding
review_early_possession
turn_before_committed_start
possession_without_current_lease
```

each with a human-readable `reason`. `src/surfaces/management_read.js:228–235`
consumes them as `issue: p.next_required_action`.

**These are computed strings, not obligations.** They have no `obligations` row,
no `id`, no owner, no due state, no closing act and no canonical destination. A
sixth is *invented at the read*: `snapshot_loader.js:490` supplies
`"confirm_physical_readiness"` when the position state is
`vacant_readiness_unknown` and the classifier returned nothing.

Under this packet's own rule — an action may be shown only when correlation is
exact (same property, same canonical object, same unresolved condition, one
governed destination) — **none of these five qualifies today.** Evidence:
**SOURCE PROVEN**.

**CONFLICT OR GAP.** Whether any *real* obligation type correlates exactly to an
unresolved position is **UNKNOWN — REQUIRES PROOF**. Candidate rails exist —
`obligations` (`001:309`), `leasing_conversion_obligations`, `renewal_cases`,
`unit_turn_scopes`, `unit_readiness_*`, `turnovers` — but I did not trace whether
any carries a `space_id`. That is the decisive question: **an obligation that
cannot name a space cannot correlate exactly to a position.** §15-Q9.

**SMALLEST PROPOSED RULE.** Slice 10B renders `resolution_state` from real
obligations only, joined on `space_id`. Where no obligation carries the position,
the row reads **`no_canonical_action`** and the plain sentence is *"No canonical
action is recorded yet."* The five classifier strings are **not** rendered as
actions; they may be rendered as *reasons* beside `no_canonical_action`, because
they explain the condition without claiming work exists.

**AUTHORITY REQUIRED.** None if the join exists. If no obligation carries
`space_id`, then every unresolved position is `no_canonical_action` in 10B and
the gap register below becomes the input to a later, separately ruled build.

**Gap register — unresolved position classes with no proven operating representation:**

| class | representation | status |
|---|---|---|
| activation pending past start date | `economic_tenancy_activation_required` string | no obligation proven |
| possession outstanding on active lease | string | no obligation proven |
| early possession before committed start | string | no obligation proven |
| turn incomplete before committed start | `unit_turn_scopes` exists | correlation UNKNOWN |
| possession without current lease | string | no obligation proven |
| unresolved expiration (null `end_date`) | none | **no representation at all** |
| conflicting overlapping leases | none | **no representation at all** |
| missing economics on a counted position | none | **no representation at all** |

The last three have no operating representation anywhere. They belong to later
builds, not to Forward Rent Roll.

---

## 10. Property timezone authority

**CURRENT FACT.** `properties.operating_timezone text` — migration
`123_property_operating_timezone.sql`, applied in production (ledger row 123,
REPORTED). Nullable by ruling, **no universal default**, validity enforced by a
trigger against `pg_timezone_names` so an invalid zone cannot be stored by any
path. The migration removed the prior hardcoded property-UUID allowlist in
`src/shared/property_timezone.js` in the same change, explicitly to prevent a
temporary allowlist becoming permanent shadow config.

Resolver order: `properties.operating_timezone` → explicit QA/test override
(non-production only) → `null`. When null, dated metrics must report
`state = unavailable`, `reason = property_operating_timezone_not_configured`.

This was built and proven in Slice 9 (`tests/slice9_operating_timezone_proof.js`,
22 assertions; `slice9_timezone_command_proof.js`, 20). Evidence: **LOCALLY
EXERCISED** — both suites re-run green during this audit on a populated baseline
database.

**CONFLICT OR GAP.** Whether the *selected production property* has a non-null
`operating_timezone` is **UNKNOWN — REQUIRES PROOF** (§15-Q10). Solo on Chestnut
rendered a correct property-local window in the Slice 9 evidence surface on
2026-08-03, which is strong indirect evidence it is configured — but that is
inference from a rendered window, not a read of the column.

**SMALLEST PROPOSED RULE.** No new rule. Forward Rent Roll resolves the selected
date in the property operating timezone via the existing resolver, and returns
`state = unavailable` for a property with no configured zone. The selected date
is a **calendar date**, not a timestamp; day boundaries and DST are the
resolver's existing concern.

**AUTHORITY REQUIRED.** None. A missing zone on an activated property is a
blocker at run time, not a design question.

---

## 11. Transport and scale readiness

**CURRENT FACT.** The bounded transport pattern is proven and reusable.
`src/evidence/conversion.js:101` `pageSupportingRows` provides: whitelisted
server-side filters, deterministic sort, a base64url cursor carrying a filter
fingerprint (`fhash`) that invalidates a cursor minted under different filters,
`PAGE_DEFAULT = 100`, `PAGE_MAX = 250`, and a returned shape of
`{page, page_size, total_matching, total_rows, cursor, filters, sort, as_of_utc}`.
Measured at 10,000 opportunities: **144KB**. Evidence: **LOCALLY EXERCISED**
(`slice9_scale_proof.js`, 15 assertions, re-run green during this audit).

The snapshot contract is already stated honestly in that shape:
*"Each page is its own coherent repeatable-read response at its own as_of. One
database snapshot does NOT persist across HTTP requests."* `withCoherentSnapshot`
opens `REPEATABLE READ, READ ONLY` per request. **No code in this repository
claims a transaction spans requests.** Evidence: **SOURCE PROVEN**.

Slice 10 can adopt this pattern unchanged: complete-population summaries computed
server-side, one bounded page on the wire, stable opaque cursor, changed-filter
invalidation, one coherent snapshot per request.

**CONFLICT OR GAP — index readiness is SOURCE DECLARED only.** From migration
files:

| need | index present in source | note |
|---|---|---|
| units by property | `idx_units_property on units(property_id)` (`001`) | yes |
| spaces by unit | `idx_spaces_unit on spaces(unit_id)` (`001`) | yes |
| leases by space | `idx_leases_space on leases(space_id)` (`001`) | yes |
| leases by property | `idx_leases_property on leases(property_id)` (`001`) | yes |
| **leases by date range** | **none found** | the selected-date filter has no supporting index |
| **economic lines by month** | **none found** | `lease_economic_lines(schedule_id, effective_month)` |
| obligations by space | **UNKNOWN** — depends on §15-Q9 | — |

The two missing date indexes are the likely scan risk: every position read filters
leases by `start_date <= D and (end_date is null or end_date >= D)`. At Solo's
283 positions this is irrelevant; at 10,000 it may not be. **No index was added,
and none is proposed as required** until an `EXPLAIN` against production schema
says so (§15-Q11).

Note the Slice 9 precedent: its scale proof initially reported a false missing-index
STOP because the planner seq-scans small tables regardless of available indexes.
Any Slice 10 scale detector must check `pg_class` size and index existence, not
plan shape alone.

**No materialized snapshot or shadow truth store is required.** The read is a
recomputation from canonical rows — `future_rent_roll_facts.js` states *"Facts at
a later date replace facts at an earlier one by RECOMPUTATION — never by stored
cleanup."* That stop condition is not triggered.

---

## 12. Current Management renderer

**CURRENT FACT.** The app computes occupancy in the browser.
`index.html:5102–5113` and `:5330–5343`:

```js
const denominator = Number(doc.inventory && doc.inventory.residential_units
                    || positions.filter(p => !p.excludedFromResidentialProjection).length);
...
projectedPct: denominator ? 100 * projectedOccupied / denominator : null,
```

with `:5330` computing `denominator = Math.max(0, positions.length - nonRevenue)`.
Both return `null` on a zero denominator — the right instinct is already present —
but **the denominator itself is browser-derived**, from a filter over
client-held positions, with a fallback to an imported document's
`inventory.residential_units`. Two different denominator definitions exist in one
file. Evidence: **SOURCE PROVEN**.

`index.html:4571–4894` contains `future_rent_roll:{count:'—'}` headline
placeholders alongside hardcoded occupancy strings (`'92.4%'`, `'59.6%'`,
`'59.4%'`, `'60.0%'`, `'55.3%'`) inside what appear to be fixture objects. Whether
any of those can reach a signed-in operator surface is **UNKNOWN — REQUIRES
PROOF** — I did not trace their consumers, and under Slice 9 doctrine a fixture
percentage reaching a live surface would be a live-first violation. This is the
single most important app-side item to resolve before 10B renders anything.

`solo-rent-roll-data.js` (32 lines) contains a hardcoded `propertyId`, is headed
*"Reconciled operating snapshot through 2026-07-15… contains resident names and
property financial information… Do not publish this file in a public repository,"*
and **I found no `<script>` reference to it in `index.html`**. Classification:
**stale or unreachable — with residual uncertainty**. The repository is flat and
this packet's own warning applies: a zero-consumer claim from one grep is not
proof. It should not be deleted on this evidence, and it should not be trusted as
authority either.

**What can be retained.** The date control, the row list shell, the Management
navigation path, and the null-on-zero-denominator instinct.

**What carries incorrect business meaning and must be replaced by server truth.**
Browser-computed `projectedPct`; both competing denominator definitions;
`excludedFromResidentialProjection` as a client-side non-revenue rule; any
fixture-sourced percentage; and any action label not backed by an obligation.

Forward Rent Roll stays inside Management. Nothing found here justifies a new
navigation door.

---

## 13. Historical fixture status

The reported 2026-09-01 snapshot (279 revenue positions, 233 projected occupied,
83.51%, 130 current terms, 103 future terms, 22 unresolved expirations, 19 notice
uncovered, 5 vacant uncovered, 3 non-revenue, $220,785.83 scheduled rent) was not
located as a stored artifact during this audit. `leasing_snapshots` exists as a
table and `solo-rent-roll-data.js` is a reconciled snapshot through 2026-07-15 —
neither is the September 1 extract, and neither carries the projection rules that
produced those totals.

**Historical snapshot not recoverable as a governed regression fixture** on
current evidence. It was **not** reconstructed from current records, and no
production data was touched. If the exact extract exists outside these
repositories, §15-Q12 states how to check.

The totals remain useful as a **shape** check — 130 + 103 = 233 reconciles
against the stated `projected_occupied`, which is consistent with the §8
invariant — but they must not be used as expected values.

---

## 14. Adversarial fixture plan

Slice 9's lesson was that a complete local suite missed a real-data arrangement
because every fixture put opportunities inside the window. The fixtures and the
assertions came from the same hand. This plan is written to break that.

| # | geometry | position row | summary effect | rate | rent total |
|---|---|---|---|---|---|
| 1 | empty selected-date cohort, large property population | rows present | cohort 0 **and population N stated separately** | `null` (empty) | partial |
| 2 | no current term, valid future term | `future_term_covers` | counts toward projected_occupied | ok | included |
| 3 | current term ends D−1 | `vacant_uncovered` | not counted | ok | excluded |
| 4 | future term begins D+1 | `vacant_uncovered` at D | not counted | ok | excluded |
| 5 | current and future overlap | `conflict` | numerator withheld | `null` | excluded |
| 6 | two future terms cover D, non-overlapping in range but both spanning | **must be `conflict`, not first-wins** | numerator withheld | `null` | excluded |
| 7 | current term + notice, no successor | `notice_uncovered` | counted now, uncovered later | ok | included |
| 8 | vacant position + stale resident relationship | `vacant_uncovered` | resident not rendered | ok | excluded |
| 9 | non-revenue position carrying a lease record | `conflict` on denominator class | denominator withheld | `null` | excluded |
| 10 | known occupancy, missing economics | `current_term_covers` + `rent_unknown` | occupancy ok, rent partial | ok | **partial** |
| 11 | known economics, uncertain occupancy | `conflict` | withheld | `null` | excluded |
| 12 | null `end_date` spanning term | `unresolved_expiration` (§8 rule) | withheld from covering | `null` | excluded |
| 13 | conflict changes numerator only | — | numerator withheld | `null` | unaffected |
| 14 | conflict changes denominator | — | denominator withheld | `null` | partial |
| 15 | page 1 clean, page 3 conflicted | page 1 rows ok | **summary must already say partial on page 1** | `null` | partial |
| 16 | filter removes all rows | zero rows | population still stated | `null` (empty) | partial |
| 17 | zero revenue denominator | — | `empty` | `null` | n/a |
| 18 | all positions untrackable | — | `partial` | `null` | partial |
| 19 | dated rent step crossing D | rent from the month containing D | — | ok | **step value, not month-1 value** |
| 20 | concession active at D | rent net of credit | — | ok | reduced |
| 21 | 10k selected-property + 100k neighbouring positions | — | same query count | ok | ok |

### Cases the implementation author is likely to forget

Written adversarially against my own likely implementation:

1. **`.find()` returns the first match.** The existing classifier uses
   `leases.find(...)` three times. An implementer reusing that shape will silently
   drop a second qualifying term whenever the two do not overlap in range. Fixture 6
   exists specifically to fail that.
2. **Null `end_date` spans forever.** `datesSpan` returns true for any future date.
   An implementer will not notice until a horizon far enough out shows implausible
   occupancy.
3. **Summary partiality must be known before the page is built.** Slice 9 computed
   all rows server-side and paged the wire precisely so aggregates could reconcile.
   An implementer optimising by paging the *query* will report a clean summary on
   page 1 and a conflict on page 3. Fixture 15.
4. **`unavailable` already means "rent unknown."** Reusing it for "state
   undeterminable" will produce a state machine where one word means two things —
   the Slice 9 defect, one layer deeper.
5. **Month-1 rent is not D's rent.** Every local fixture will likely have a flat
   term, so `leases.rent` and the dated line will agree, and the wrong rail will
   look right. Fixture 19 is the only thing that catches it.
6. **Zero is not a rent, and zero positions is not 0%.** Both already handled in
   source; both easy to lose in a rewrite.
7. **The denominator is the whole claim.** A rate over trackable rows presented as
   the property is the failure this doctrine most consistently forbids.
8. **Two properties, one query.** `spaces` has no `property_id`; a join written
   through `units` and then filtered late will leak or double-count. Fixture 21.

---

## 15. Runtime verification appendix

Copy-paste, read-only. Each states what it verifies, what clears, what blocks.

**Q1 — ledger and ceiling.** *Verifies: applied schema state.*
```sql
select version, name from schema_migrations order by version;
```
Clears: every version has a file in `migrations/` (001–129 except 125).
Blocks: any row whose version is not a zero-padded 3-digit string, or any version
this repository lacks. Prefer `node tools/ledger_reconcile.js`, which uses the
same `classifyLedger` the boot gate uses.

**Q2 — duplicate versions.** *Verifies: applied-once.*
```sql
select version, count(*) from schema_migrations group by version having count(*) > 1;
```
Clears: zero rows. Blocks: any row.

**Q3 — position grain exists.** *Verifies: §3.*
```sql
select count(*) spaces, count(distinct unit_id) units_with_spaces from spaces;
select u.property_id, count(*) positions from spaces s join units u on u.id=s.unit_id group by 1 order by 2 desc limit 10;
```

**Q4 — multi-space units (by-the-bed).** *Verifies: whether unit≠position.*
```sql
select unit_id, count(*) n from spaces group by 1 having count(*) > 1 order by 2 desc limit 20;
```
Clears: either result is fine — but if zero, every unit is one position **today**,
and any code assuming that must still not hardcode it.

**Q5 — overlapping leases (fixture 5/6 in production).**
```sql
select a.space_id, a.id, b.id, a.start_date, a.end_date, b.start_date, b.end_date
  from leases a join leases b
    on b.space_id=a.space_id and b.id > a.id
 where a.lease_status not in ('cancelled','terminated','rescinded','void','expired','superseded')
   and b.lease_status not in ('cancelled','terminated','rescinded','void','expired','superseded')
   and a.start_date <= coalesce(b.end_date,'9999-12-31') and b.start_date <= coalesce(a.end_date,'9999-12-31')
 limit 50;
```
Clears: zero rows. Non-zero is not a blocker — it is the expected `conflict`
population, and its size sets how visible §8's withholding will be.

**Q6 — open-ended terms (§8 rule).**
```sql
select count(*) from leases where end_date is null
  and lease_status not in ('cancelled','terminated','rescinded','void','expired','superseded');
```
Blocks R6 if large: the null-`end_date` ruling changes that many positions.

**Q7 — admitted-claim vs operational-account divergence (§4).**
```sql
select count(*) filter (where lease_id is null) unlinked, count(*) total from executed_lease_records;
select e.id, e.space_id, e.lease_start_date, e.lease_end_date, l.start_date, l.end_date
  from executed_lease_records e join leases l on l.id = e.lease_id
 where e.lease_start_date <> l.start_date or coalesce(e.lease_end_date,'9999-12-31') <> coalesce(l.end_date,'9999-12-31')
 limit 50;
```
Clears R1: zero divergent rows means the rails agree and precedence is academic.
Blocks: any divergence makes R1 load-bearing.

**Q8 — is the dated economics rail populated? (§6, decisive).**
```sql
select count(*) schedules, count(distinct space_id) spaces from lease_economic_schedules where status in ('locked','active');
select count(*) lines, count(distinct schedule_id) sched, min(effective_month), max(effective_month) from lease_economic_lines;
select schedule_id, count(*) months from lease_economic_lines where line_type='base_rent' group by 1 having count(*) > 1 limit 20;
```
Clears R3 toward the dated rail: schedules exist for a material share of leased
spaces **and** the third query returns rows (real multi-month schedules).
Blocks: near-zero rows means promoting the rail would convert working rows to
`rent_unknown`, and `leases.rent` must remain primary with the step limitation
documented on the surface.

**Q9 — can any obligation name a position? (§9, decisive).**
```sql
select table_name, column_name from information_schema.columns
 where column_name in ('space_id','unit_id','related_id','related_type') and table_name like '%obligation%';
select type, count(*) from obligations group by 1 order by 2 desc limit 40;
```
Clears: an obligation table carrying `space_id`.
Blocks exact correlation: only `unit_id`, or neither — then every unresolved
position is `no_canonical_action` in 10B, and bridging by unit label is forbidden.

**Q10 — timezone on the activated property (§10).**
```sql
select id, name, operating_timezone from properties order by name;
```
Blocks: null `operating_timezone` on any property Slice 10 will serve.

**Q11 — index readiness (§11).**
```sql
select relname, n_live_tup from pg_stat_user_tables
 where relname in ('spaces','units','leases','lease_economic_lines','executed_lease_records','obligations');
select tablename, indexname, indexdef from pg_indexes
 where tablename in ('leases','lease_economic_lines','spaces','units','obligations') order by 1,2;
```
Clears: date-range indexes exist, or the tables are small enough that their
absence is irrelevant. Blocks: large `leases` with no date index → §11 proposal.

**Q12 — historical snapshot (§13).**
```sql
select id, property_id, created_at from leasing_snapshots order by created_at desc limit 20;
```
Clears: a row dated on or about 2026-09-01 for the reported property.

**Q13 — non-revenue source (§7 gap 2).**
```sql
select tablename, indexname from pg_indexes where tablename in ('property_unit_types');
select * from property_unit_types limit 20;
```

---

## 16. Required owner rulings

Six. Each is a product decision that reading more code cannot settle.

**R1 — Rail precedence.** When `executed_lease_records` and `leases` disagree
about the dates of a term on the same space, which governs — or is the position
`conflict`? *Recommendation: `conflict`. Neither rail is subordinate today, and
picking one silently would hide a real disagreement.* Gated by Q7: if divergence
is zero in production, this can be deferred with the rule "conflict" as the safe
default.

**R2 — Imported future terms.** May a future term that arrived through
`POST /operator/rent-roll/import` count toward `future_term_covers`, or does it
require the executed-and-funded proof the native rail requires?
*Recommendation: it does not count without that proof.* Otherwise an imported
spreadsheet becomes contractual authority, which §4's classification forbids.

**R3 — Contractual rent authority.** Adopt the §6 rule (dated schedule wins;
`leases.rent` only where no schedule exists; else `null`)? Gated by Q8. Also:
are `one_time_fee` lines excluded from a monthly contractual rent figure?
*Recommendation: yes, excluded — a one-time fee is not monthly rent.*

**R4 — `caller_attested_segment` economics.** Does a schedule whose space was
resolved by human attestation rather than exact offer binding carry the same
weight as `exact_offer_bound`? *Recommendation: yes for rent, but the position is
flagged so the attestation is visible — a human took responsibility and that
should not be invisible.*

**R5 — Non-revenue source.** What single governed source classifies a position as
non-revenue (down unit, model, employee, admin)? Until this is answered every
position is `denominator_class = unknown` and **every occupancy rate is `null`**.
This is the single most consequential unanswered question in the audit.

**R6 — Open-ended terms.** Does a spanning lease with a null `end_date` count as
covering an arbitrarily distant selected date, or is it `unresolved_expiration`?
*Recommendation: `unresolved_expiration`.* Gated by Q6 for blast radius.

---

## 17. Blockers

```
BLOCKED — live migration ledger and production schema not independently verified
```

Additional blockers found during the audit:

```
BLOCKED — non-revenue denominator source unproven (§7, §16-R5)
          Until one governed source classifies a position as non-revenue, the
          denominator class is unknown for every position and every occupancy
          rate must be null. A rate is the primary deliverable of this surface.

BLOCKED — contractual rent authority unresolved on a future date (§6, §16-R3)
          leases.rent is undated; lease_economic_lines is dated and unwired.
          On today's date they agree; on a selected future date they can
          disagree silently. Gated by Q8.

BLOCKED — exact existing-action correlation unproven (§9, §15-Q9)
          The five next_required_action values are computed strings, not
          obligations. Whether any obligation rail carries space_id is unknown.
          Until proven, resolution_state can only be no_canonical_action.

UNRESOLVED — app fixture reachability (§12)
          Hardcoded occupancy percentages exist in index.html and an orphan
          solo-rent-roll-data.js carries real resident data. Whether either can
          reach a signed-in operator surface was not traced. Not a schema
          blocker; it is a live-first blocker for any 10B renderer.
```

---

## 18. Proposed Slice 10B contract

Only if the gate is released, and only after Q7–Q10 are answered.

**Scope: a pure forward-position service. No route, no renderer.**

1. `forwardPositions(pool, {property_id, as_of})` returning one row per
   `spaces.id`, property-scoped through `units.property_id`, built on the
   **existing** `classifyPosition` — extended, not replaced.
2. Three frozen axes: `position_state` (7 values), `resolution_state`,
   `denominator_class`. `unavailable` on the economics axis renamed
   `rent_unknown` (§7).
3. Summary invariants proven, not asserted:
   `projected_occupied = current_terms_covering + future_terms_covering`, and
   revenue positions reconciling across all five position classes.
4. Provenance per row: which rail supplied coverage, which supplied rent, which
   proof basis, and every conflicting record id.
5. Withholding per §8, with the Slice 9 metric-contract states.
6. Negative-geometry fixtures 1–21 from §14, written **before** the assertions,
   and an adversarial review pass by a reader who did not write the fixtures.
7. Real Postgres proof. No route, no app change, no migration.

**Not in 10B:** transport, pagination, the renderer, obligations correlation
beyond reading what exists, and the Expected Future Rent Roll (pricing +
assumptions), which `future_rent_roll_facts.js` correctly holds as a separate
later calculation.

---

### Safe to build on after runtime verification

- `spaces.id` as the canonical position, with property lineage through `units`.
- The claim-class rule: pending never counts; funding, not date arrival, commits.
- Conflict detection by pairwise range overlap.
- Economics as a separate axis; zero is not a rent; market rent is not contract rent.
- Bounded transport, cursor, filter fingerprint, per-request snapshot honesty.
- The property operating timezone resolver.
- Recomputation rather than stored projection — no shadow store required.

### Owner rulings still required

R1 rail precedence · R2 imported terms · R3 rent authority · R4 attested segments ·
R5 non-revenue source · R6 open-ended terms.

---

## 19. Final classification

```
BLOCKED — live migration ledger and production schema not independently verified
```

plus the three additional blockers in §17 (non-revenue denominator source;
contractual rent authority on a future date; exact existing-action correlation)
and one unresolved app-side item (fixture reachability).

Slice 10B is **not** authorized. The audit's useful finding is that Forward Rent
Roll is further along than expected — the grain is settled, the claim classes are
already governed, conflicts are already detected, and the transport is already
proven. What is not settled is what a rate is divided by, where a future date's
rent comes from, and whether any action shown would be real.

---

# AUDIT PASS 2 — corrections and closures

Pass 1 was discovery. This pass traces. **Two Pass-1 conclusions were wrong, and
both were wrong the same way: I concluded absence from a search that was too
narrow.** Both corrections make Slice 10 smaller, not larger.

## P2.1 — CORRECTION: the non-revenue denominator authority EXISTS

**Pass 1 said:** *"No governed non-revenue source… every position is
`denominator_class = unknown`… the single most consequential unanswered question."*

**That was wrong.** `migrations/100_durable_position_classification.sql` creates
exactly the authority Pass 1 said was missing, at exactly the right grain:

```sql
alter table spaces add column if not exists use_type text;
alter table spaces add constraint ck_spaces_use_type
  check (use_type is null or use_type in ('residential','commercial','non_revenue','other'));
alter table spaces add column if not exists classification_source  text;
alter table spaces add column if not exists classified_by_user_id  uuid references users(id);
alter table spaces add column if not exists classified_at          timestamptz;
```

Migration 100's own header states the ruling that put it on the space rather
than the unit (2026-07-27): *"Current Rent Roll, Availability, Renewals and
Future Rent Roll all operate per rentable position, and **leasable denominators
are position-based**. A by-bed property must not depend on a unit-level
assumption, and a position-level exception (one bed taken out of residential
use) must be expressible without reclassifying its siblings."*

It is classified **Class 1 permanent primitive**, carries provenance
(`classification_source`, `classified_by_user_id`, `classified_at`), and
deliberately populates nothing: *"Every column is nullable and every existing row
stays NULL, which the surfaces render as 'Not configured'… NO INFERENCE from
occupancy_status, unit_type text, or any status string. The previous
`is_commercial` was a regex over a status field; reproducing that in a column
would make a guess permanent."*

Evidence: **SOURCE PROVEN** (migration text) · **SOURCE DECLARED** for the
production column state.

**It is already loaded, and already consumed correctly elsewhere.**

- `dated_positions.js:157` selects `s.use_type, s.position_kind`; `:186` carries
  `use_type` onto every position row.
- `availability_read.js:199–202` consumes it honestly: no `use_type` yields
  `{state:"use_not_configured", reason:"no_governed_use_type"}`, and a
  non-marketable use yields `not_marketable_use`. That is the honest-blank
  pattern already implemented against this exact column.

**The real gap is narrower and different from what Pass 1 claimed.**
`future_rent_roll_facts.js` and `dated_positions.js` contain **no `non_revenue`
handling at all** — `use_type` is carried on the row and never turned into a
denominator class. So:

```
CURRENT FACT       the governed denominator authority exists, at position grain,
                   with provenance, and is already loaded onto every row.
CONFLICT OR GAP    it is not wired into the Forward Rent Roll surface, and its
                   production population is UNKNOWN — REQUIRES PROOF (§15-Q13).
SMALLEST RULE      denominator_class = revenue when use_type in
                   ('residential','commercial'); non_revenue when 'non_revenue';
                   unknown when NULL or 'other'. Any unknown in the population
                   withholds the rate (null), exactly as Slice 9 withholds a rate
                   under unresolved evidence.
AUTHORITY          NO owner ruling needed on the model — ruling 2026-07-27
                   already settled grain and vocabulary. The only open question
                   is population, which is an operational act (a reviewed
                   mapping receipt), not a schema change.
```

**Consequence: no migration is required for the denominator.** Pass 1's proposed
"smallest durable source" would have rebuilt a Class 1 primitive that already
exists. Recommended sequencing changes accordingly (P2.6).

## P2.2 — CORRECTION: exact transitive obligation lineage EXISTS

**Pass 1 said:** *"an obligation that cannot name a space cannot correlate
exactly to a position."* That framed direct `space_id` as the only exact
lineage. It is not — relational traversal is not inference.

`obligations` carries, across baseline and later migrations:

| column | origin | path to a space | exact? |
|---|---|---|---|
| `related_id` + `related_type='lease'` | `001_baseline` | `obligations.related_id → leases.id → leases.space_id` | **YES — one-to-one.** `leases.space_id` is NOT NULL, so a lease resolves to exactly one space. Written by `activation.js:434`, read by `move_in_queue.js:106` |
| `unit_id` | `001_baseline` | `obligations.unit_id → units → spaces` | **only when the unit has exactly one space**; otherwise ambiguous and forbidden |
| `application_id` | post-baseline | → `lease_applications` → conversion | needs tracing; not required for 10B |
| `conversion_id` | post-baseline | → `leasing_conversions` | opportunity grain, not position grain |
| `related_id` + `related_type` | `001_baseline` | generic pointer; `related_type` includes `lease` | exact **only** when `related_type='lease'` |
| `person_id` | `001_baseline` | — | never a position bridge |

> **CORRECTED 2026-08-03 during Slice 10B implementation.** This section
> originally stated the path was `obligations.lease_id`. **That column does not
> exist.** The `add column if not exists lease_id` matches cited belong to
> `lease_economic_schedules` (`071_bridge_prep.sql`) and `unit_events`
> (`074_unit_events_lease_link.sql`) — a column name was matched without
> confirming its table. The conclusion (exact transitive lineage exists) stands;
> the path does not. The real path is `related_id` + `related_type='lease'`,
> proven by implementation and 84 local assertions.
>
> **Standing rule adopted from this error:** a schema-lineage conclusion
> requires all three of a table-qualified column, a writer, and an existing
> reader. A grep match without table context is discovery evidence, not a
> conclusion.

```
CURRENT FACT     obligations.related_id (related_type='lease') → leases.id →
                 leases.space_id is an exact, one-to-one, same-property
                 transitive path to a canonical position.
CONFLICT OR GAP  which obligation TYPES actually populate lease_id, and whether
                 any represents an unresolved Forward Rent Roll condition, is
                 UNKNOWN — REQUIRES PROOF (§15-Q9, revised below).
SMALLEST RULE    resolution_state = existing_action only via related_id with
                 related_type='lease', same property (BOTH obligation and lease
                 walls), same unresolved condition, one destination. unit_id is
                 unit grain and is NOT used: a multi-space unit cannot resolve
                 to one position without inference.
AUTHORITY        none — owner ruling 5 already permits exact transitive lineage.
```

## P2.3 — The five `next_required_action` strings, classified

All five are computed in `position_classifier.js` and consumed by
`management_read.js:228–235` as `issue:`. None is an obligation record.

| string | condition | classification | disposition in 10B |
|---|---|---|---|
| `economic_tenancy_activation_required` | pending lease whose dates span as_of | **noncanonical recommendation** — names work ("confirm and collect required move-in charges") | replace with exact obligation projection if one exists on that lease; else `no_canonical_action` + keep the sentence as explanation |
| `possession_outstanding` | active lease, no move-in event | **noncanonical recommendation** | same |
| `review_early_possession` | possession before committed start | **unsupported operating instruction** — "review" names no closing act | remove as an action; retain the fact as explanation |
| `turn_before_committed_start` | future term + turn in progress | **exact existing action projection candidate** — `unit_turn_scopes` exists and may carry the work | project the real turn obligation if lineage resolves; else `no_canonical_action` |
| `possession_without_current_lease` | possession, no current/pending/future lease | **plain explanation** — states a condition, names no work | retain as explanation |

A sixth is invented at the read: `snapshot_loader.js:490` supplies
`confirm_physical_readiness` when the classifier returned nothing. That is a
**browser-adjacent invention of work** and must not survive into 10B.

## P2.4 — Economics: the two rails, traced

| question | `leases.rent` | `lease_economic_lines` |
|---|---|---|
| exact space lineage | via `leases.space_id` (NOT NULL) | via `lease_economic_schedules.space_id` (NOT NULL, *"D5: ALWAYS exact"*) |
| dated applicability | **none** — one undated amount | `effective_month date not null`, one row per month |
| concessions | **cannot express** | `concession_credit`, `fee_waiver`, sign-constrained negative |
| corrections | **none** — no supersession column | schedule `status: locked/active/cancelled/superseded`; rows never edited |
| claim class | operational account | locked/active governed schedule |
| current writers | `snapshot_loader` import paths, lease services | `executed_lease_service.js`, `application_review.js`, `proposed_terms_service.js`, `commitmentledger.js` |
| current consumers | `dated_positions.js:97`, `future_rent_roll_facts.js:106` | `commitmentledger.js`, `tenancy_anchor_service.js`, `application_terms.js` — **not the position read** |
| production population | UNKNOWN — §15-Q8 | UNKNOWN — §15-Q8 |

**Classification of `lease_economic_lines`: canonical, actively written by the
application/execution lane, but DORMANT with respect to the position read.**
Both rails are live; they simply do not meet.

**Owner options, with consequences:**

| option | truth consequence | coverage consequence | migration | production risk |
|---|---|---|---|---|
| **A. dated lines only** | correct on every date, including rent steps and concessions | any lease without a schedule reports `rent_unknown` — possibly most legacy leases | none | rent totals could collapse to mostly-partial overnight |
| **B. dated lines, `leases.rent` as governed fallback where no schedule exists** | correct where governed; legacy answers stay available and are labelled as fallback provenance | full coverage retained | none | a fallback row is silently wrong if a step exists but no schedule was written — mitigated by recording provenance per row |
| **C. keep `leases.rent`** | wrong on any date after a rent step; cannot express concessions | full | none | silent future-date error — the Slice 9 defect in arithmetic |

**Recommendation: B, with per-row provenance naming which rail supplied the
number, and the row marked partial when the fallback is used on a date later
than the lease start month.** A is honest but converts a working surface into
mostly-unavailable before anyone has been given a path to populate schedules;
C is not defensible on a future date. B is the only option that is both honest
today and convergent on A once schedules are populated. It requires no
migration. Gated on §15-Q8 for whether the dated rail is populated at all.

## P2.5 — Overlap conflict: the actual ceiling

Traced in `position_classifier.js`:

- Conflict detection is **complete for pairs**: nested loops over all valid
  leases, `rangesOverlap(leases[i], leases[j])`, collecting every participating
  id into `conflicting_lease_ids`. Three-way overlap is therefore fully
  represented — every pair among the three registers.
- Terminal leases are excluded first (`leases.filter(leaseIsValid)`), so a
  cancelled predecessor cannot manufacture a conflict.
- **But `current`, `activationPending` and `future` are each chosen with
  `.find()` — the first match wins**, and `conflict_state` does not suppress
  that selection. So a contested position still selects one governing lease,
  and `future_rent_roll_facts.js:106` reads `p.lease.rent` from it.
- `future_rent_roll_facts.js:69` maps `conflict_state === "conflicted"` to
  `contested` and contributes **zero locked rent**, which is what prevents the
  contested rent from reaching the total.

```
CURRENT FACT     conflict detection is complete; contested positions contribute
                 zero rent at the summary level.
CONFLICT OR GAP  the ROW still exposes a rent and a lease chosen by first-match
                 among conflicting records. Correct in the total, arbitrary in
                 the row.
SMALLEST RULE    when conflict_state is conflicted, the row's rent, lease id and
                 term dates are null and the row names the conflicting records.
                 Do not select a governing lease that the system cannot govern.
AUTHORITY        doctrine settles it — "honest blank beats confident wrong."
```

Boundary behaviour: `datesSpan` uses `start_date <= asOf && end_date >= asOf`,
so both ends are **inclusive**. A term ending on D and a term starting on D
therefore **overlap on D** and register as a conflict. That is defensible but is
a product decision worth stating explicitly, because same-day turnover is
ordinary. Fixture 4 in §14 covers it.

## P2.6 — Revised sequencing recommendation

Pass 1 proposed 10B as a forward-position service and flagged denominator and
economics as prerequisites needing new foundations. With P2.1 and P2.2, **no new
schema foundation is required for either.**

Recommended next packet: **Slice 10B — Canonical Dated Position Rows**, as the
owner has now scoped it. It is buildable today because:

- grain is settled and enforced (`spaces.id`);
- claim classes are governed and already implemented;
- the denominator authority exists and is already loaded — it needs wiring and
  an honest `unknown`, not a migration;
- exact transitive action lineage exists via `lease_id`;
- economics has a defensible option B needing no migration;
- conflicts are detected; the fix is to stop selecting inside a conflict.

Withheld until population and runtime verification: the occupancy percentage,
the revenue denominator, and any unqualified rent total.

## P2.7 — Revised runtime queries (priority order)

Supersedes the §15 ordering. First production pass, in dependency order:

1. **Q1/Q2** — ledger, ceiling, duplicates.
2. **Q13 (new, decisive)** — denominator population:
   `select use_type, count(*) from spaces group by 1;` and
   `select count(*) from spaces where use_type is null;`
   Clears the rate: zero NULLs on the served property. Any NULL ⇒ rate stays null.
3. **Q8** — is `lease_economic_lines` populated, and does any schedule carry more
   than one `base_rent` month? Decides option A vs B.
4. **Q14 (new)** — rail disagreement:
   compare `leases.rent` against the applicable `base_rent` line per space, count
   mismatches only.
5. **Q9 (revised)** — `select type, count(*) from obligations where related_type='lease' and related_id is not null group by 1;`
   Names which obligation types can reach a position exactly.
6. **Q5/Q6** — overlapping terms; open-ended terms.
7. **Q4** — multi-space units.
8. **Q10** — timezone on served properties.

## P2.8 — Route proof ceiling — NOT CLOSED

`GET /operator/rent-roll/future-facts` (`src/identity/operator.js:1924`) was
**not** exercised locally in this pass. Its middleware, property-scope
derivation, target-date parsing and response contract remain **SOURCE DECLARED**.

Reason stated plainly rather than omitted: this pass was interrupted by the
static-data exposure incident, and the local browser/API stack was not rebuilt
afterwards. The proof ceiling for that route is therefore **read, not run**.
Closing it requires only the existing disposable-Postgres harness and no code
change, and it is the first item of Slice 10B.

## P2.9 — Amended blockers

```
BLOCKED — live migration ledger and production schema not independently verified
          (unchanged; owner-supplied ledger is REPORTED, schema never dumped)

BLOCKED — contractual rent authority on a future date  (§P2.4, owner option B recommended)

WITHHELD, NOT BLOCKED — occupancy rate and revenue denominator
          The authority exists (spaces.use_type). Population is unknown. The rate
          is withheld as null until Q13 shows zero NULLs. This is no longer an
          architecture blocker.

RESOLVED — exact existing-action correlation
          obligations.lease_id → leases.space_id is exact and one-to-one.
          Which types populate it is a runtime question (Q9), not a design gap.

OPEN — route proof ceiling (§P2.8): read, not run.

OPEN — app fixture reachability. Superseded in urgency by the static-data
       exposure incident; the app is suspended and its production-data static
       libraries are the subject of a separate incident record.
```
