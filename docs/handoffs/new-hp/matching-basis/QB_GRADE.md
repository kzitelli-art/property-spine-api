# QB grade — Opus lane #2 `claude-opus/matching-basis-20260914`

Graded 2026-09-14 against the ruling
`docs/handoffs/new-hp/rulings/MATCHING_BASIS_RULING_20260914.md` (MB-1..MB-9)
and the lane's own receipt (`RECEIPT.md` at `13381cf`). Lane head `13381cf`,
four commits over board `0e10ef8`: `aafe963` (product + proof + gate),
`39b405e` (receipt, row 76), `4c8e062` (proof owns its inventory),
`13381cf` (receipt records the CI red). Every verdict below was formed by
reading the lane's diff and its CI log directly, not from the packet.

**Verdict: NOT INTEGRATED. Returned for one correction round.** The shape is
right — retrieval on a declared basis, violated homes returned, the seam
extended in its owner, no schema, no score — and the CI red was diagnosed
honestly and for the right reason. Three findings block integration; none
of them is a rewrite.

## CI

Read directly from the GitHub Actions logs, not from the packet.

| run | sha | conclusion | what the log shows |
|---|---|---|---|
| 539 | `aafe963` | failure | `prospect_match_basis.db.js` 40 run · 30 passed · 10 failed, every failure `{"violated":0,"satisfying":0}` — the borrowed-Skyline fixture order |
| 540 | `39b405e` | failure | docs-only over `aafe963`; same red |
| 541 | `4c8e062` | **success** | `── prospect match basis               PASS` · `ASSERTIONS COMPLETE · 41 run · 41 passed · 0 failed` · `── browser: coupled rent-roll (app b0be9f4) PASS` · `operator app: matched at b0be9f46…` · zero `SKIPPED` lines · `ALL REQUIRED ASSERTIONS PASSED` |
| 542 | `13381cf` | **success** | docs-only over `4c8e062` |

The local "41/41" claim is CONFIRMED by CI 541. The gate's own count line
(87/87, 10 domains) was not extracted from the log; the receipt's figure is
carried as PLAUSIBLE.

## Claims graded

| claim | grade | evidence |
|---|---|---|
| First red on the baseline (3/6, 404 door, no registry entry, seam drops the over-budget home) | CONFIRMED | `first_red.witness.txt` names commit `0e10ef8`; the `exact_spaces` `continue` is in the baseline source |
| CI 539 red was a fixture-order dependency, not a product defect | CONFIRMED | run 539 log: every failure `{"violated":0,"satisfying":0}`; the step is registered directly after the rent-roll reconciliation proof that consumes Skyline's eligible target; `4c8e062` builds owned inventory through import batch → activation → source rows → promoted proposals → one opening position |
| MB-1 retrieval declared, no score/weight/rank key anywhere in the payload | CONFIRMED | `capability_class`, `claims_not_made`, proof walks the payload |
| MB-3 violated homes are returned, never filtered | CONFIRMED | `matchProspectHomes` never `continue`s on a constraint; the proof asserts the over-budget home is present and `violated` |
| MB-4 governed sources only (published pricing, application-target read, `person_attributes`) | CONFIRMED | no read of `units.occupancy_status`; the legacy-only unit case is asserted absent |
| MB-5 one named deterministic rule | CONFIRMED | `MATCH_ORDER_RULE` is data, carried in every payload, asserted equal across two calls |
| MB-6 coverage reported per family; unpriced property does not answer "no matches" | CONFIRMED | `constraint_coverage`, separate unpriced fixture property |
| MB-7 term refusal inherited verbatim | CONFIRMED | `refusal_inherited_from: "availableUnits(exact_spaces)"` |
| MB-9 no schema | CONFIRMED | diffstat touches no migration |
| Gate change is not a weakening | CONFIRMED | `owner` branch demands the exact require path AND the `facts.<domain> =` assignment; entries without `owner` keep the original rule; three self-tests cover both directions |
| "Registered and gathered by `ask_spine_answer`" (MB-8) | PLAUSIBLE only | the proof checks this with a **source regex** (`/readProspectMatchStanding/` and `/facts\.prospect_match\s*=/`) and then calls the projection **directly with a term**. `gatherFacts` itself is never called, so what the composer actually gathers is unproven — and by reading, it is a refusal (finding 3) |
| MB-2 every constraint carries the fact it was **compared** against | REJECTED for readiness | finding 2 |
| MB-8 budget disclosed only where the staff reader already may see it | REJECTED | finding 1 |
| Committed evidence scrubbed | CONFIRMED | no UUIDs, tokens, phones, hostnames, scratch paths or database names in the added lines; fixture phones and emails are synthetic |

## Findings that block integration

**1. The new door has no person wall (MB-8, §40.8).** `GET
/operator/leasing/prospect-match` takes `person_id` from the query string and
`readProspectFacts` reads `person_attributes` where `property_id = <session
property> OR property_id IS NULL`. The sibling door
`/operator/leasing/person-card` refuses unless the person has presence at
THIS property (lead, conversation, attribute, conversion or lease). Nothing
like that exists here, and person-level facts with a null property are real:
`prospect_capture.js` writes `propertyId || null`. So a leasing user at
property A can read the recorded budget, move month and unit type of a
prospect known only to property B, and can confirm which fact keys any
person id carries. The ruling's own sentence — "a prospect's recorded budget
is disclosed only where the staff reader already may see it" — is the
sentence this violates. **Smallest fix:** apply the same presence predicate
the person-card route uses (one shared helper, not a second copy), and
refuse with a sayable reason; the projection through Ask Spine already
derives the person from an entitled lookup and needs nothing.

**2. The readiness constraint reports `satisfied` without comparing anything
to the prospect's recorded move month (MB-2, MB-3, §5).** The basis entry
attaches `prospect_fact = move_month` when recorded and sets `satisfied`
whenever the home has any governed ready date. Move month `2027-03` against
`available_from = 2027-06-01` reads `satisfied`, and that home then counts
as `all_recorded_constraints_satisfied`. The ruling names `move_month` as one
of the three recorded constraints and MB-3 forbids treating an uncompared
fact as satisfied. This is a labelled basis that says "compared" for a
comparison that never happened. **Smallest fix:** compare the recorded month
against the governed ready date (ready on or before the end of that month →
`satisfied`, after → `violated`, no recorded month or no ready date →
`not_established` with the reason), and add the violated case to the proof.
Do not rename the family to dodge the comparison.

**3. The composer gathers with a null term, so every leasing question now
carries a manufactured `ATTENTION_REQUIRED` (§40.7).** `gatherFacts` calls
`readProspectMatchStanding` with `requested_start/end/lease_term_months =
null`. That is always the inherited `term_required` refusal, which the
projection renders as `truth_state: NOT_ESTABLISHED, attention_state:
ATTENTION_REQUIRED`. `composite_silence` then reports `ATTENTION` naming
`prospect_match` on every leasing question, whatever the property's state.
The composer's own missing input is not a property condition. **Smallest
fix:** a term-less gather is `read_state: OK`, `truth_state: NOT_ESTABLISHED`,
`attention_state: null` (or `QUIET`) with `why: term_required`, so the
projection says "ask with dates" without claiming something needs attention;
and prove the composer path by calling `gatherFacts` in the proof instead of
grepping the source. Also: `subject === "match"` is never produced by
`questionSubject`; drop it or produce it.

## Findings recorded, not blocking

- `tests/e2e/verify_all.sh` step comment still says the proof "needs the
  established Skyline fixture" — stale after `4c8e062`.
- `RECEIPT.md` says "40 passed / 0 failed" under "What was proven" while the
  proof, the commit and row 76 say 41. One number.
- The HTTP door requires the leasing module; the Ask gather accepts leasing
  OR management. The projection carries fact keys only, no values, so the
  asymmetry discloses nothing today; say it in the receipt.
- The ordering rule's ready-date and price tiebreaks are exercised over two
  homes. Fine for this round; the receipt already says so.

## What the QB did not do

No product code was changed on the lane or the board. Nothing was pushed to
the Opus lane. The board's `app_pin.txt` is unchanged. No database outside
an owned nonce was touched; no production read.
