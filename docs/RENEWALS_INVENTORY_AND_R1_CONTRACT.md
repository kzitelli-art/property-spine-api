# Renewals — current-source inventory and the R1 live-read contract

**Read-only evidence. 2026-07-27.** App read from `origin/main`; API from the live commit;
data from live Neon via transaction-scoped read-only sessions.

Renewals is the **operating feeder** into Future Rental:

```
Renewals              → actual leases coming due and renewal work
Pricing & Concessions → approved renewal and new-lease economics
Future Rental         → building-level projected result
Forward Rent Roll     → contractual future truth as leases become locked
```

---

## Part 1 — Inventory

| # | Question | Answer | Claim |
|---|---|---|---|
| 1 | Renewals command card and dashboard still present? | **Yes.** "Renewals" appears 29× in `index.html`; the leaf renders under `openLeasingDash`, bucketed by month | `Proven` |
| 2 | `buildRenewalWork`, `leasingRenewalMonths`, `leasingRenewalsDashBody`? | **All three present** (×9, ×3, ×3) | `Proven` |
| 3 | `__RENEWALS_LIBRARY`, `__RENEWAL_THREADS`? | **Both present.** Library keyed by property id — **only `9e2bb96e` (real Solo) and `skyline-1417`** — with inline fallbacks `_SOLO_RENEWALS_FB` / `_SKY_RENEWALS_FB`. `__RENEWAL_THREADS` merges into `DEMO_TOUR_THREADS` | `Proven` |
| 4 | Any canonical renewal API or service? | **None.** No renewal routes, no renewal service. **The API never emits `renewals_due` or `upcoming_expirations`** — the two fields `buildRenewalWork` reads | `Missing` |
| 5 | Visible surface: live or fixtures? | **Neither, strictly.** Signed in it calls `renewalsFromReconciliation()`, an adapter over `_rrTruthDoc()` — the **imported rent-roll snapshot**. Signed out, the fixture library. Snapshot-derived client-side with a fixture fallback — the same pattern as Forward Rent Roll | `Proven` |
| 6 | Session-scoped read for upcoming expirations and current rent? | **No such endpoint.** The data is fully readable: **234 active leases carry rent + end_date + ≥1 tenant** | endpoint `Missing`; data `Proven` |
| 7 | What real fact produces `on_notice` today? | **Nothing.** Requires `unit_events` with `event_type='notice_given'`, `status='scheduled'`. **Live count across the whole database: 0.** Demo has only 2 `move_in` + 2 `move_in_scheduled`. No lease-level notice column. The producer (`notice.js`, Availability Slice A) is built and never used | producer `Built`; fact `Missing` |
| 8 | Leases expiring in Demo's next 90 days? | **92 active leases, $151,370.00/mo.** 0–30 days: **69** · 30–60: **22** · 60–90: **1** | `Proven` |
| 9 | Can any canonical record distinguish signed renewal from signed new lease? | **No.** No renewal marker on `leases`, no type column on `lease_applications`. Only `executed_lease_records.supersedes_record_id` — document supersession within one lease | `Missing` |

**The shape of it.** The Renewals surface was built well and then disconnected: three intact
renderers, an honest-blank path (*"No upcoming expirations loaded… Wire the Leasing Log to
populate"*), and no server feeding it. Its fixtures are keyed to **real Solo**, so on Demo
Building the surface is empty regardless — while 92 real expirations sit in the database,
readable, with rent and residents attached.

The `renewed / on_notice / waiting` buckets came from Solo's weekly tracker. **Two of the three
have no governed producer:** `on_notice` has zero source events, and `renewed` requires the
lease-origin classification that does not exist.

---

## Part 2 — The R1 live-read contract

Read-only. No renewal decisions, no offers, no economic writes, no ledger activation.

```
lease approaching expiration
  → resident and Person Card
  → current rent
  → expiration date
  → notice or unresolved state
  → accountable owner or UNASSIGNED
```

| Element | Type | Canonical source | Available today | When missing |
|---|---|---|---|---|
| **Lease approaching expiration** | Fact | `leases.end_date` inside the fixed 90-day window, non-terminal status, resolved per position server-side | **Yes — 92 on Demo** | Empty window renders honest-blank, never fixtures |
| **Resident + Person Card** | Fact | `leases.tenant_ids` → `persons`. Person Card is a **read projection — no composer, no send path** (standing Gate C ruling) | **Yes — 234 leases carry ≥1 tenant** | **`Resident not linked`** — never `UNASSIGNED` |
| **Current rent** | Fact | `leases.rent` | **Yes — 231 of 234 populated** | Show as missing; **never** substitute `units.market_rent` |
| **Expiration date** | Fact | `leases.end_date` | **Yes** | No end date → not in the cohort. Never inferred from term length |
| **Notice state** | Fact | `unit_events` `notice_given` / `scheduled` — the only governed producer | **No — 0 events exist** | **`unresolved` is the honest default.** Never infer notice from a spreadsheet column or from silence |
| **Accountable owner** | Fact | Canonical eligible-assignment resolver | To be confirmed against source | **`UNASSIGNED`, declared not absent** |

### Vocabulary ruling (owner, 2026-07-27)

- **`Resident unavailable` / `Resident not linked`** — missing *identity*.
- **`UNASSIGNED`** — reserved for the accountable **work owner**, and nothing else.

Conflating them is what made the `agent_review` failure unreadable: "nobody was eligible" and
"nobody asked" became indistinguishable. Identity and accountability are different absences.

### Rules R1 must hold

1. **Server-authored.** Cohort, window and state computed once on the server. The renderer
   displays the decision — no client-side re-derivation, no `renewalsFromReconciliation()`
   adapter, no fixture fallback.
2. **Two states only: `unresolved` and `on_notice`.** `renewed` is deliberately **not**
   available — it requires lease origin, which does not exist. Showing it would be a
   confident wrong. R1 is the **open renewal-work cohort**, not completed-renewal history.
3. **Session-scoped and property-authorized.** Property comes from the server-confirmed
   grant, never a client-supplied id.
4. **Read-only.** R1 records no decision, sends nothing, writes nothing.
5. **Ownership is resolved, never inferred** from role, name or property membership alone.
6. **Proof basis is carried** in the response even if the first UI does not emphasise it.
7. **Reuse, don't rebuild.** `buildRenewalWork` already accepts `{renewals_due:[…]}`; the
   existing renderers and their honest-blank path can stand once a governed read fills that
   contract.

### Explicitly outside R1

Renewal decisions · renewal offer generation · renewal pricing writes · lease-origin
inference · historical renewal-rate calculation · forward economic schedules · Commitment
Ledger activation · Future Rental projections · pending-lease, application, lead or tour
analytics.

**What R1 unblocks:** stage 3 of `FUTURE_RENTAL_V1_CONTRACT.md` — the unresolved cohort that
defines the unit mix. It does **not** unblock stage 4; the historical baseline still requires
lease origin declared at creation.
