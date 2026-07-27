# Forward Rent Roll — evidence inventory

**Read-only. Nothing was designed, built, or written.** 2026-07-27.
Source at live commit `aebc4c1`; data from live Neon via transaction-scoped read-only sessions.

Claim vocabulary is used exactly: `Proven` (real DB / real source, with receipt) ·
`Reported` (a claim not verified against current source) · `Dormant` (built, not exercised) ·
`Missing` (does not exist).

---

## The headline

**Two forward rent rolls exist, and they share no source.**

1. A **governed server read** — dated, per-space, derived from leases. **Nothing in the UI calls it.**
2. A **client-side projection in `app/index.html`** — computed from an imported rent-roll
   spreadsheet, with a fixture fallback. It holds the only renewal concept and the only
   assumption logic in the product.

There is no `forward_rent_roll` table, module, or route. The phrase appears in migration 063
and in `commitmentledger.js` as the intended *destination* of `lease_economic_lines` — which
are still 0 rows.

**Owner ruling, 2026-07-27:** the larger build converges these into one canonical Future
Rental system. Neither parallel path is to be improved independently. The client-side
projection is **useful product evidence, not authority.**

---

## The nine questions

### Q1 — What source tables and services construct it?

**Server (canonical).** `src/tenancy/space_position.js` → `spacePosition(pool, { property_id, as_of })`,
exposed as `GET /properties/:id/space-position?as_of=YYYY-MM-DD` (`server.js:3271`). Derives
from `leases` + `spaces` + `units` + `unit_events` (`move_in` / `move_out` / `notice_given`) +
`turnovers`. **Writes nothing.** Its own comment: *"One shared truth for current rent roll /
forward rent roll / availability — distinct fields, never one status."* `Proven`.

**Server (current-only).** `src/tenancy/availability.js` → `GET /availability?property_id=`.
Read-only forward-supply projection, one row per space. **Takes no `as_of`** — it answers
"now". `Proven`.

**App (parallel).** `rentRollForwardStats()` · `_rrForwardPageHtml()` · `_rrForwardSnapshotAt()`
in `index.html`, sourced from `_rrTruthDoc()` → the loaded rent-roll snapshot when signed in,
or `window.__RENT_ROLL_TRUTH_LIBRARY` (a fixture library) when not. `Proven`.

### Q2 — What currently qualifies a future lease as real?

`Proven` in `space_position.js`:

- **Terminal, excluded:** `cancelled`, `terminated`, `rescinded`, `void`, `expired`, `superseded`.
- **Current economic tenancy:** `active` or `commercial` **and** dates span `as_of`.
- **`pending` + dates span `as_of` → `committed_activation_pending`** — explicitly **not**
  promoted into rent-roll truth. The file states it: *"A pending lease is never promoted into
  current rent-roll truth merely because its start date arrived. Required move-in funds must
  first activate the lease."*
- **`start_date > as_of` → `committed_future`.**

Promotion requires `economic_tenancy_activated_at`, set by `attemptEconomicTenancyActivation`
only when the term has commenced **and** required move-in charges are fully applied.

**Live: 1 of 348 leases has economic tenancy activated.** The rule is `Proven`; in practice the
activation path is `Dormant`.

### Q3 — Can the system prove lease executed **and** deposit paid?

**Both — yes.** `Proven` as a capability.

- **Executed:** `executed_lease_records` with `record_state = 'verified'` (migration 088),
  joined in `loadLease` with document reference, SHA-256, provider and version ids.
  **Live: 2 rows, both `verified`.**
- **Deposit:** `scheduled_charges` with `is_move_in_required = true` and
  `move_in_requirement_key = 'deposit'`, expected whenever `lease.security_deposit > 0`, and
  cleared only when `status = 'paid'` with zero outstanding. Charge sets live in
  `lease_move_in_charge_sets`. **Live: 2 move-in charges, both paid, $3,282.26.**
- **Graded proof, not a boolean** — `proof_strength`:
  `cash_proven` (bank-proven cash ≥ required) · `staff_attested_collected` (fully applied but
  attested) · `incomplete`.

**This supersedes the older note that the security deposit is "just a number with no gate."**
There is a gate, and it distinguishes proven cash from staff attestation. Deposit
*disposition* at move-out was not examined.

### Q4 — Can it distinguish renewals from new leases?

**Not in governed data. `Missing`.**

- No renewal-ish column on `leases` (scan for `%renew%` / `%prior%` / `%previous%` → none).
- Inferable renewal chains (same tenant, consecutive leases, same space) → **0**.

The only renewal concept lives outside the lease model: the app's `renewed` category and
`renewalsDue`, and `src/leasing/leasingintel.js`, both parsed from an imported **Renewal
Tracker spreadsheet** — which warns *"Renewal Tracker header not found — renewal counts
unavailable."* `Reported`.

### Q5 — Can it produce the rent roll for one selected future date?

**The dated read exists and works. `Proven`.** Measured live against the same rules the
canonical read applies:

| As of | Spaces contractually occupied | Monthly contracted rent |
|---|---|---|
| today | 223 | $373,910.83 |
| +90 days | 131 | $222,540.83 |

The decline is lease expiry.

**But the canonical server read returns positions and states, not money.** There is no revenue
summation in it — the figures above are an aggregate query mirroring its rules, not something
the endpoint emits. **Revenue rollup: `Missing` server-side.**

### Q6 — Does it operate by unit, bed, or both?

**Both, correctly. The atom is the SPACE (bed)**, with `unit_number` reported alongside.
`availability.js` documents independent per-bed classification: *"a by-bed unit (two beds, one
leased, one open) — the two beds MUST classify independently."* `Proven`.

**Live on Demo Building: 283 units, every one with exactly 1 space.** By-bed is built and
unexercised here — `Dormant`.

### Q7 — Cancelled, replaced, transferred, conflicting

| Case | State | Claim |
|---|---|---|
| Cancelled / terminal | Excluded from position by `TERMINAL_LEASE_STATUSES`. Live: 7 cancelled | `Proven` |
| Void | `src/tenancy/lease_void_service.js`; refuses once `economic_tenancy_activated_at` is set | `Built` |
| **New** conflicting lease | `executed_lease_service.js` runs a locked overlap check where **`pending` counts as operative**, blocking with `overlapping_operative_lease` and listing competing leases | `Proven` |
| **Existing** conflicts in data | **The read does not surface them.** `space_position` resolves with `leases.find(...)` — first match wins, silently | **Gap** |
| Transferred | No transfer concept in `src/tenancy/` or `src/applications/`. Only a `$750 / $1,000` fee in an agent fact | `Missing` |

**The conflict surface is 7, not 63.** 63 spaces carry more than one non-terminal lease, but
**56 are normal sequential handoffs** (active now, pending later) and correctly are not
conflicts. **7 spaces have two non-terminal leases whose dates genuinely overlap.**
Parked by owner ruling as a separate data-integrity issue.

### Q8 — What UI or API surface reads it?

**API:** `GET /properties/:id/space-position?as_of=` (operator-key gated) ·
`GET /availability?property_id=` · the management surface overlay in
`src/surfaces/management_read.js:227`, which does pass `as_of` through.

**App: calls none of them.** The only rent-roll fetch in `index.html` is `/operator/rent-roll`.
The Management → *Forward Rent Roll* door renders from the imported snapshot document
client-side.

**The canonical dated server read has no UI consumer. `Dormant`.**

### Q9 — Is any projection or assumption logic already present?

**Server: `Missing`.** No projection / forecast / assumption / budget / proforma table exists.
Only honesty markers — `date_confidence` (*"This read never fabricates certainty"*) and
`available_from`.

**App: present, and it is the only place it exists. `Reported`.**
Planning targets (`_rrPlanningTargets`, a `sep1` primary, rolling 60 / 120-day), plus
`projectedOccupied`, `projectedPct`, `residentialScheduledRent`, `commercialScheduledRent`,
a **120-day renewal cutoff**, and a category vocabulary:

```
unresolved_exposed · notice_uncovered · vacant_uncovered · future_leased
renewed · current_occupied · non_revenue
```

These categories are good product thinking and worth preserving as evidence. The assumptions
behind them are **implicit, client-side, unversioned and unapproved.**

---

## Two findings that sit underneath all of the above

**The forward book is economically empty.** Of 79 future `pending` leases, **77 carry
`rent = 0.00`**; only 2 have rent, totalling $5,800. Across all 107 pending leases, 104 are
zero. Even the governed path has almost no money in the forward book today.

**Provenance:** 337 of 348 leases arrived via `historical_snapshot` import at confidence
`confirmed`; 11 carry no `source_type` at all.

---

## The doctrine inversion, stated plainly

`availability.js` sets the rule in its own header:

> SERVER-AUTHORED, APP NEVER RE-DERIVES … every classification is computed HERE, once. The
> renderer displays the decision; it never reproduces the precedence client-side.

The Forward Rent Roll does the opposite. Precedence, categories, planning horizons and the
renewal cutoff all live in `index.html`, computed from a spreadsheet import with a fixture
fallback. This is the same shape as the pricing store described in
`PRICING_DESIGN_CURRENT.md` — a governed server design that was never connected, and a
client-side surface that filled the vacuum.
