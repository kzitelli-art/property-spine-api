ASSIGNMENT OPUS #7 — three lender-facing lines on the canonical rent roll read

Lane: claude-opus/rent-roll-lender-lines-20260914, branched from board
claude/board-20260914 at f680a36. App pin b0be9f4 unchanged. Reader only:
src/surfaces/rent_roll_canonical.js and, only if the state vocabulary needs
it, src/tenancy/dated_positions.js. No schema, no deployment, no production
read. Push only to your lane.

First red is already on the board: docs/handoffs/new-hp/lender-read/
SKYLINE_LENDER_READ_20260914.md and CURRENT_STATE row 80. Read both first.
Reproduce the read the same way (owned nonce DB, run
current_rent_roll_reconciliation.db.js, then currentRentRoll as of today) and
quote the three lines red before you change anything.

1. THE TENANCY SUMMARY BALANCES. tenancy_summary gains activation_pending
   so its buckets sum to total on every property. Assert it in a proof over
   the established Skyline-shaped fixture (146 -> 160) and over the
   "Other Shape" unit-basis property the same proof establishes.

2. UNVERIFIED REVENUE HAS A MAGNITUDE, COUNTED NOWHERE. For a position whose
   basis is an accepted opening occupancy with terms unknown, project the
   claimed rent from the accepted claim onto the row as claimed_rent (null
   when the source carried none — never 0), and add
   totals.claimed_rent_unverified beside contractual_rent_trusted, with the
   count behind it. It must never enter contractual_rent_trusted, occupancy,
   or any NOI figure. Mirror exactly how contested_claims.implicated_rent is
   "visible without being counted". Prove: trusted unchanged at $26,350 /
   31; claimed_rent_unverified equals the sum of the fixture's accepted
   claim rents over exactly the 92 positions; a claim with no rent stays
   null and is counted separately.

3. THE SUMMARY MUST NOT MERGE "CLAIM SAYS OCCUPIED" WITH "CLAIM SAYS
   NOTHING", AND DATES ARE DATES.
   (a) dated_positions.js defines `unresolved` as "no spanning lease, but
   the opening claim says occupied, OR says nothing conclusive". On the
   Skyline fixture that one value holds 92 accepted-occupied positions and
   10 genuinely unreconciled ones, and tenancy_summary reports them as one
   number, 102. A lender cannot tell claim-occupied from unknown. Do NOT
   collapse axes and do NOT redefine the four-plus-one tenancy values
   lightly: the smallest correct change is for tenancy_summary (and the
   unit view / standing that mirror it) to report the split beside the
   total — unresolved: {{ total, opening_claim_occupied, inconclusive }} —
   derived from basis_type / bucket_reason_code the row already carries.
   If you conclude a distinct tenancy value is the honest shape instead,
   say why in the receipt, update the header's axis list (it currently
   lists four values while the code yields five, activation_pending being
   the fifth), and find every consumer of tenancy_state === "unresolved"
   by grep and either update it or show it unaffected; list them.
   (b) contested_claims.claims[].start_date / end_date become ISO dates for
   JS Date and string inputs alike (one small helper, used in both places),
   witnessed over the real HTTP door: the rent roll route's payload shows
   2026-08-01, not "Sat Aug 01". Do not add a global pg type parser.

4. Regressions: rent_roll_canonical_proof, rent_roll_institutional_proof,
   rent_roll_occupancy_correction.db, skyline_rent_roll_model.db,
   skyline_rent_roll_read.db, current_rent_roll_reconciliation.db (must
   stay 63/0 or explain every changed assertion), the Rent Roll unit view
   and tenancy standing readers that consumed "unresolved", Ask Spine
   tenancy gather, governance bare with the exit code read.

5. Receipt under docs/handoffs/new-hp/rent-roll-lender-lines/RECEIPT.md
   with the read re-run after the change (same scrubbed format as the QB's
   receipt) and one CURRENT_STATE row (next contiguous number). CI at your
   head.

Rules unchanged: fixture SQL labelled and before any business action; no SQL
after a business action to manufacture an outcome; synthetic tenants only;
scrub every committed artefact; commit trailers as before; no model
identifiers in repo artefacts.

RETURN PACKET, same template: lane head sha · CI run and conclusion · the
three lines red then green, quoted · trusted rent before/after ·
claimed_rent_unverified and its count · the consumers of "unresolved" you
found and what you did with each · the HTTP witness for the dates · FOUND
items you did not fix · OWNER DECISIONS you need.
