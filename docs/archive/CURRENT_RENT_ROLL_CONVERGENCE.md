# Current Rent Roll — convergence contract

**Read-only. No implementation.** 2026-07-27, grounded against live source and live Neon.

**Ruling this serves:** Current Rent Roll and Future Rent Roll are not separate systems. They
are the same canonical property position and economic truth viewed at different dates.

```
Today                               → Current Rent Roll
Upcoming expirations                → Renewals
Selected future date                → Locked Future Rent Roll
Locked facts + approved assumptions → Expected Future Rent Roll
```

**The long-term rule:** canonical positions and leases drive the operating read. Imports
remain provenance, opening truth and reconciliation evidence. Import history is never
deleted, and disagreements are never automatically overwritten.

---

## The finding that changes the shape of this work

**The opening import already created attributed canonical records.**

| | |
|---|---|
| Leases carrying `import_batch_id` | **337 of 348** |
| `units` provenance columns | `import_batch_id`, `source_type`, `source_as_of_date`, `confidence` |
| Governed intake | `import_batches` (046): `status='committed'`, `confidence`, `source_as_of_date`, `leasing_model` |
| Demo batches | `historical_snapshot` (confirmed, as-of 2026-06-30, 386 rows) · `rent_roll_reconciliation` (manually_reviewed, as-of 2026-07-15, 1 document) |

Opening truth is **not** trapped in the snapshot. It is already canonical *and* attributed.
`/operator/rent-roll` is a **second rendering of the same import**, not a separate source of
facts.

The read already does more than expected: `readLatestSnapshot` overlays `spacePosition` per
row and emits a `conflicts[]` array — *"disagreement is surfaced, never resolved silently."*
The instinct is right. **The precedence is inverted.**

## The defect, precisely

1. **Imported rows are the row spine; canonical is the overlay.** Backwards.
2. **The join is `unit_number` string equality**, explicitly by-unit
   (`"by-unit model: one space per unit"`). Safe today — 283 units, 283 distinct numbers,
   0 nulls, every unit single-space — and **structurally unable to express by-bed**.
3. **Headline economics come from the spreadsheet document**:
   `summary.current_contract_rent_residential = doc.september_1.current_occupied_monthly_rent`.
4. **The app renders `reconciliation.unit_truth`** — the spreadsheet rows — so the canonical
   overlay largely goes unread by the view it was built for.

## Field-by-field contract

| Field | Canonical source | Opening-import source | Precedence | Proof basis | Disagreement behaviour | Correction path | Consumers |
|---|---|---|---|---|---|---|---|
| Rentable position | `spaces` + `units` | `units.import_batch_id` | Canonical only — an import never introduces a position at read time | structural | position absent from import → `opening truth incomplete` | property configuration | all four |
| Occupancy / tenancy | `space_position` (lease spanning the date) | `units.occupancy_status` | **Canonical lease evidence leads**; `occupancy_status` is reported verbatim as the contracted axis and never reinterpreted | lease proof basis | **52 occupied-without-lease → `evidence disagrees`**; 2 active-lease-on-`unknown`. **Never auto-converted to vacant** | human resolution | all four |
| Resident identity | `leases.tenant_ids` → `persons` | import name string | Canonical person leads; an import name is a display-only claim | bridged / claimed | no tenant → **`Resident not linked`** (0 today) | identity bridge | Current RR, Renewals, Person Card |
| Current rent | `leases.rent` | `raw.actual_rent` | **Canonical leads**; a differing import raises a `rent` conflict (already implemented) | lease proof basis | 3 active leases with no rent → **`Economics unavailable`** | operator correction | all four |
| Lease start / end | `leases.start_date` / `end_date` | import dates | Canonical | lease proof basis | missing `end_date` → excluded from Renewals, never inferred from term length | correction | Renewals, Future RR |
| Notice | `unit_events.notice_given` (`scheduled`) | none | Canonical only | event exists | **0 events ever** → all `unresolved`, never "waiting for a response" | `notice.js` | Renewals, Availability, Future RR |
| Successor state | `space_position.successor` | none | Canonical only | the successor's own proof basis | `pending` ≠ locked; contested ≠ successor | execute + fund | Renewals, Future RR |
| Deposit / execution proof | `executed_lease_records` + `scheduled_charges` | none | Canonical only | `native_verified` | absent → `confirmed_opening_import`, never silently upgraded | verify + fund | Future RR, reporting |
| Fees & concessions | `pricing_terms.fee_terms`, `lease_economic_lines` | import misc columns | Canonical when it exists; **honest blank otherwise** | pricing version id | 0 rows → blank, never `market_rent` | publish pricing | Future RR, reporting |
| Conflict / exclusion | `space_position.conflict_state` | none | Canonical only | overlapping non-terminal leases | **6 contested** → excluded with reason, in neither open nor pending | human resolution | Renewals, Future RR |

### Independent axes — "canonical leads" is not "canonical silently wins"

The read must retain, separately: structural rentable position · canonical lease evidence ·
imported occupancy claim · proof basis · conflict state · availability state · successor state.

An imported `occupied` claim with no active canonical lease stays **`evidence disagrees`**
until a human resolves it. It is **not** converted to vacant merely because the lease read is
absent.

### The six states the canonical read must be able to say

`contractual position confirmed` · `opening truth confirmed` · `evidence disagrees` ·
`position contested` · `resident not linked` · `economics unavailable`

**No source wins by loading first.** Today the import wins by being the row spine. That is the
inversion to remove.

## What is preserved, what retires

**Preserved, in a different role:** `import_batches` / `import_source_rows` as governed
intake and audit trail · batch attribution and `confidence` · the `conflicts[]` disagreement
mechanism (already correct) · the reconciliation document as the **counterpart canonical is
checked against**, retained as evidence.

**Retires from the signed-in runtime:** imported rows as the row spine · `summary.*`
economics sourced from `doc.september_1` · the `unit_number` string bridge as the join ·
client-side `_rrTruthDoc()` / `_rrTruthUnitMap()` / `__RENT_ROLL_TRUTH_LIBRARY` as operating
data — the same retirement R1 performed for Renewals.

## Is `space_position` sufficient as the shared derivation?

**Sufficient in scope; it should be decomposed before a third and fourth surface depend on
it.** It now owns spanning, successor, notice, conflict, availability and proof basis —
correct — but returns one large shape assembled in a single loop with per-space subqueries,
and is untestable without a database.

**Smallest decomposition that prevents drift:** extract a **pure** `classifyPosition(...)`
that takes already-loaded data and returns the shared facts, leaving SQL and assembly where
they are. Every surface and every test then exercises one classifier.

Two scaling notes, not blockers: no pagination or projection (fine at 283 spaces, not at
portfolio scale), and the by-bed path is written but unproven — every unit on Demo has
exactly one space.

## Operator experience

The page still reads as a rent roll: unit or bed · resident · current contractual rent ·
lease expiration · the exception needing attention. Shared issues appear **once above the
rows**:

> 52 positions have conflicting occupancy evidence.
> 6 positions have overlapping leases.

Reconciliation happens underneath. The operator is interrupted only where a real judgment or
correction is required. The page is not a source-reconciliation audit, and identical warning
badges are never repeated down every row.

**Design standard:** one property truth, viewed at different times and for different
decisions. The user sees the situation and the next action; they never have to understand
which source table won.
