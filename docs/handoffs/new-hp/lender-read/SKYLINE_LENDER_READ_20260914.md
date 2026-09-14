# Skyline lender read — `currentRentRoll` over an established Skyline-shaped position, 2026-09-14

**What this is.** The rent roll is a read, not a table: `currentRentRoll`
derives it from `datedPropertyPositions` at a date and writes nothing. A
tracker can never be the truth; it is evidence that establishes opening
positions, after which every fact is authored live. This receipt loads the
Skyline-shaped rehearsal tracker through the real Deal Setup doors on an
owned database built from board `571892d` (ledger 198), then reads the
property back through `currentRentRoll` as of today and asks the only
question that matters: **is this read what Kameron would hand a lender, and
if not, which line must be caveated and why.**

**What it is not.** The shape is Skyline's (72 units, 160 bed positions, bed
basis, the tracker's real column vocabulary); every person, rent and lease in
it is synthetic, and the 13 contested positions come from the synthetic July
legacy load the proof seeds first, not from the tracker. The real numbers
exist only when the real tracker is loaded, which is a production act. No
production read or write happened here.

## How it was produced

1. Owned nonce database from the board tree, migrated to ledger 198 and
   seeded (`spine_proof_<scrubbed>`); owned server on the loopback port.
2. `tests/proofs/current_rent_roll_reconciliation.db.js` run against it:
   63 passed, 0 failed. Its own dated read after establishment:
   `total 160 · occupied 122 · activation_pending 12 · open 0 ·
   needs_review 26 · occupied_by_accepted_claim_terms_unknown 92`; lease-based
   occupancy `31 of 160`.
3. A read-only script called `currentRentRoll(pool, { property_id })` on the
   same database. Output, scrubbed of record ids:

```text
══════════════════════════════════════════════════════════════════════
  SKYLINE (rehearsal) · leasing_basis=bed · as_of 2026-09-14 · read: currentRentRoll
══════════════════════════════════════════════════════════════════════
  inventory 160 · leasable 160 · down 0
  opening_truth: {"sources":[{"batch_id":"<id>","source_type":"rent_roll_ledger","source_file":"Temple Tracker 2026-2027 Skyline RR (rehearsal).csv","source_as_of_date":"2026-09-13","confidence":"extracted","status":"committed","operating_published":true,"leasing_model":"bed","attribution":{"loaded_at":"2026-09-14T17:26:19.722Z","notes":"Established through Asset Management activation <id> by user <id>. Evidence only at this stage: no person or lease was created here."}},{"batch_id":"<id>","source_type":"rent_roll_ledger","source_file":"RentRoll07_1417 (rehearsal).csv","source_as_of_date":"2026-07-31","confidence":"extracted","status":"committed","operating_published":false,"leasing_model":"bed","attribution":{"loaded_at":"2026-09-14T17:26:18.560Z","notes":"fixture: legacy July activation, established 2026-08-17"}}],"latest_confirmed_source":{"batch_id":"<id>","source_type":"rent_roll_ledger","source_file":"Temple Tracker 2026-2027 Skyline RR (rehearsal).csv","source_as_of_date":"2026-09-13","confidence":"extracted","status":"committed","operating_published":true,"leasing_model":"bed","attribution":{"loaded_at":"2026-09-14T17:26:19.722Z","notes":"Established through Asset Management activation <id> by user <id>. Evidence only at this stage: no person or lease was created here."}},"latest_reconciliation":null}

  TENANCY   {"contractually_occupied":31,"vacant":0,"unresolved":102,"contested":13,"total":160}
  EVIDENCE  {"confirmed":28,"disagrees":0,"inconclusive":13,"total":160}
  ECONOMICS {"available":31,"unavailable":0,"not_applicable":129,"total":160}
  PROOF     {"native_verified":0,"confirmed_opening_import":0,"unproven":31,"no_lease":129,"total":160}

  contractual_rent_trusted        $26,350.00  (positions_contributing_rent 31)
  occupied_without_known_rent     0
  contractual_rent_excluded_contested $26,250.00
  confirmed_contractual_occupancy {"occupied":31,"of_leasable_resolved":147,"pct":21.09,"excluded_from_denominator":{"down":0,"contested":13},"reported_beside":{"unresolved_positions":102,"evidence_disagrees":0,"evidence_inconclusive":13}}

  CONTESTED {"spaces":13,"lease_claims":30,"implicated_rent":26250,"claims":[<30 pending claims, each rent 875, dates rendered by this raw-connection script as weekday strings — see finding 3>]}
  EXCEPTIONS {"evidence_disagrees":0,"evidence_inconclusive":13,"contested":13,"economics_unavailable":0,"unresolved_tenancy":102,"resident_not_linked":0}

  row fields: space_id, unit_id, unit_number, space_label, position_kind, square_feet, unit_type, unit_type_code, use_type, tenancy_state, evidence_state, economics_state, contributes_trusted_rent, basis_state, basis_type, basis_ref, contractual_terms_state, bucket, bucket_label, bucket_reason_code, bucket_reason, supporting_refs, conflicting_refs, imported_occupancy_claim, occupancy_claim, occupancy_claim_basis, lease, resident, current_rent, proof_basis, notice_state, notice_date, successor, future_commitment, activation_pending_lease_position, current_lease_position, other_spanning_lease_positions, conflict_state, conflicting_lease_ids, is_down, physical_readiness, possession_state, current_possession, availability_state, available_from, next_required_action, reason, balance, balance_source, balance_as_of, balance_unavailable_reason

  POSITIONS BY (tenancy|evidence|economics|proof):
      92  unresolved|uncorroborated|not_applicable|no_lease
      28  contractually_occupied|confirmed|available|unproven
      12  activation_pending|uncorroborated|not_applicable|no_lease
      11  contested|inconclusive|not_applicable|no_lease
      10  unresolved|unreconciled|not_applicable|no_lease
       2  contested|unreconciled|not_applicable|no_lease
       2  contractually_occupied|inconclusive|available|unproven
       2  activation_pending|unreconciled|not_applicable|no_lease
       1  contractually_occupied|unreconciled|available|unproven

  positions the source never names (unresolved tenancy): 102
    sample: [{"unit":"1417-118","label":"Room2","basis":"established","why":null},{"unit":"1417-201","label":"Room1","basis":"established","why":null},{"unit":"1417-202","label":"Room1","basis":"established","why":null},{"unit":"1417-202","label":"Room2","basis":"established","why":null},{"unit":"1417-203","label":"Room1","basis":"established","why":null}]

```

```text
tenancy_state counts: {"contractually_occupied":31,"contested":13,"unresolved":102,"activation_pending":14}

ONE unresolved row: {
 "unit": "1417-118",
 "label": "Room2",
 "tenancy": "unresolved",
 "bucket": "occupied",
 "bucket_reason_code": "OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN",
 "contractual_terms_state": "not_established",
 "basis_type": "opening_claim_occupied",
 "economics": "not_applicable",
 "current_rent": null,
 "imported_claim": "unknown",
 "claim": "occupied",
 "claim_basis": "opening_position_space_claim",
 "next": null,
 "reason": null
}

ONE activation_pending row: {
 "unit": "1417-205",
 "label": "Room2",
 "tenancy": "activation_pending",
 "bucket": "needs_review",
 "bucket_reason_code": "OPENING_POSITION_UNRECONCILED",
 "contractual_terms_state": "not_applicable",
 "basis_type": "commenced_lease_pending_activation",
 "economics": "not_applicable",
 "current_rent": null,
 "imported_claim": "unknown",
 "claim": "unreconciled",
 "claim_basis": "opening_position_space_claim",
 "next": "economic_tenancy_activation_required",
 "reason": "Lease commenced 2026-08-01, but economic tenancy is not active — confirm and collect required move-in charges before current rent-roll activation."
}

ONE contested row: {
 "unit": "1417-101",
 "label": "Room2",
 "tenancy": "contested",
 "bucket": "needs_review",
 "bucket_reason_code": "OVERLAPPING_OPERATIVE_LEASES",
 "contractual_terms_state": "not_applicable",
 "basis_type": "contested_rights",
 "economics": "not_applicable",
 "current_rent": null,
 "imported_claim": "unknown",
 "claim": "unreconciled",
 "claim_basis": "opening_position_space_claim",
 "next": "economic_tenancy_activation_required",
 "reason": "Lease commenced 2026-08-01, but economic tenancy is not active — confirm and collect required move-in charges before current rent-roll activation."
}

unresolved (102): claimed rent present on 0 rows summing $0.00; 102 with no claimed rent field found
positions with NO claim and NO lease (the source never names them): 0
  by bucket: {}
bucket counts: {"occupied":122,"needs_review":26,"activation_pending":12}

```

## The five lines Kameron asked for

| line | value on this fixture | what stands behind it |
|---|---|---|
| `contractual_rent_trusted` | **$26,350.00 from 31 positions** | 31 uncontested spanning leases with populated rent; nothing else contributes |
| `resolved_leasable` (the denominator) | **147** = 160 leasable − 13 contested; 0 down | unresolved positions stay inside the denominator and are reported beside it, never called vacant |
| `economics_unavailable` | **0** | see finding 2: the 92 claim-occupied positions read `not_applicable`, not `unavailable` |
| contested claims and the rent they implicate | **13 spaces · 30 pending claims · $26,250 implicated, counted nowhere** | overlapping operative leases from the synthetic July load |
| positions the source never names | **0** | every one of the 160 positions carries a claim or a lease from the tracker; blank rows are never vacancy |

Confirmed contractual occupancy: 31 of 147, **21.09%**, with 102 unresolved
positions reported beside it. The operating bucket on the same rows says
**occupied 122 of 160**. Both are true; they answer different questions, and
the read carries both on every row.

## Is this what I would hand a lender?

**Not yet, on three lines. None of them is the tracker's fault, and none
needs a schema change.**

**1. The tenancy summary does not balance (reader defect).**
`tenancy_summary` reports `contractually_occupied 31 · vacant 0 · unresolved
102 · contested 13 · total 160`. Those sum to 146. The other 14 positions
carry `tenancy_state = activation_pending` (a lease has commenced but economic
tenancy is not active) and the summary has no bucket for them. The header
says each summary balances within its own axis; this one does not. A lender
adding the column finds 14 positions missing. Fix: a fifth bucket.

**2. Unverified revenue has no magnitude on the read.** The 92 positions the
operator accepted as occupied with terms unknown carry `bucket: occupied`,
`tenancy_state: unresolved`, `economics_state: not_applicable`,
`current_rent: null`, `imported_claim: "unknown"`. The rent the tracker
asserts for them is retained as evidence on the proposal and is not projected
to the row, so nothing on the rent roll can say *"$X claimed, $0 verified"*.
The read is doctrine-correct: it refuses to count what has no instrument, and
an unknown Exposure is valid and never zero. But the contested claims already
show *visible without being counted* (`contested_claims.implicated_rent`), and
the 92 deserve the same treatment: a `claimed_rent_unverified` total beside
`contractual_rent_trusted`, sourced from the accepted claim, counted nowhere.
That is the line between verifiable and unverifiable revenue, and today the
read draws it with a count and no dollar figure.

**3. The word "unresolved" is wrong for an accepted occupancy, and contested
claim dates render as weekday strings.** A position the operator explicitly
accepted as occupied reads `unresolved` on the contractual axis, which to a
lender means "we do not know if anyone lives there". The truth is *occupied,
contract terms not established*, and the row already knows it
(`OPENING_OCCUPANCY_ACCEPTED_TERMS_UNKNOWN`). The contractual axis should say
that. Separately, `contested_claims.claims[].start_date` is produced by
`String(date).slice(0, 10)`; node-postgres returns `date` columns as JS Date
objects and no type parser is configured anywhere under `src/` or in the
server's pool (`server.js:147`, connection string and ssl only), so through
the live API those dates read as `Sat Aug 01`, not `2026-08-01`. Confirmed
by reading; not yet witnessed over HTTP.

**Lines that are lender-ready as they stand:** trusted rent and the count
behind it; the denominator and its exclusions, both named; the contested
money visible and uncounted, with the competing claims returned separately;
the proof axis (31 `unproven` here because the fixture's leases carry no
proof basis; a real opening import reads `confirmed_opening_import`).

## What follows

- The three findings go to one product lane (Opus #7), reader only, with
  this receipt as the first red and this read re-run as the acceptance.
- The cutover question stands and is now precise: opening positions are
  authored once from the tracker; after that date the tracker must stop
  being edited or Spine's rent roll diverges silently while every report
  still renders. Kameron names the date.
- Greenery's 171 legacy rows are retired through supersession
  (`179_activation_source_supersession.sql`), never deleted, whatever the
  answer about attachments.
- Grain is established per property and read through the one canonical
  service; no property-specific branch exists or may be added.

Cleanup: the owned database and server were stopped and dropped through the
proof boundary after the outputs above were captured; `spine_proofs`
untouched.
