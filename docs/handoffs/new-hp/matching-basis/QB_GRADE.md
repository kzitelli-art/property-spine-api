# QB grade — Opus lane #2 `claude-opus/matching-basis-20260914`

> **Re-graded 2026-09-14 at lane head `d2669353`** (second packet). Opus found
> and fixed finding 2 (readiness compared, not assumed) on its own before
> reading this grade: `0eaabb4` product + proof, `d266935` receipt/row. CI 544
> and 545 green with the step executed, **44/44**. Verified here: the
> comparison is string-on-ISO-date (the availability read produces
> `available_from` through `ymd()`, and the CI log's own note line prints
> `governed ready 2026-09-14`), so `String(available_from) <= monthEnd` is
> sound. What the new proof would miss: there is no **satisfied** readiness
> case (ready date on or before the month end) and no
> `recorded_move_month_not_a_month` case, so `violated` is proven reachable
> but `satisfied` is not. **Findings 1 and 3 still stand and still block.**
> The correction round below is revised to those two plus the proof gap.
> Rulings on the packet's owner decisions are at the end.

Graded 2026-09-14 against the ruling
`docs/handoffs/new-hp/rulings/MATCHING_BASIS_RULING_20260914.md` (MB-1..MB-9)
and the lane's own receipt. First grade at lane head `13381cf` (four commits
over board `0e10ef8`: `aafe963` product + proof + gate, `39b405e` receipt and
row 76, `4c8e062` proof owns its inventory, `13381cf` receipt records the CI
red); re-grade at `d2669353` (adds `0eaabb4`, `d266935`). Every verdict was
formed by reading the lane's diff and its CI log directly, not from the
packet.

**Verdict: NOT INTEGRATED. Returned for one correction round.** The shape is
right — retrieval on a declared basis, violated homes returned, the seam
extended in its owner, no schema, no score — and both CI reds were diagnosed
honestly and for the right reason. Two findings block integration; neither is
a rewrite.
## CI

Read directly from the GitHub Actions logs, not from the packet.

| run | sha | conclusion | what the log shows |
|---|---|---|---|
| 539 | `aafe963` | failure | `prospect_match_basis.db.js` 40 run · 30 passed · 10 failed, every failure `{"violated":0,"satisfying":0}` — the borrowed-Skyline fixture order |
| 540 | `39b405e` | failure | docs-only over `aafe963`; same red |
| 541 | `4c8e062` | **success** | `── prospect match basis               PASS` · `ASSERTIONS COMPLETE · 41 run · 41 passed · 0 failed` · `── browser: coupled rent-roll (app b0be9f4) PASS` · `operator app: matched at b0be9f46…` · zero `SKIPPED` lines · `ALL REQUIRED ASSERTIONS PASSED` |
| 542 | `13381cf` | **success** | docs-only over `4c8e062` |
| 544 | `0eaabb4` | **success** | readiness compared; proof 44 |
| 545 | `d266935` | **success** | `── prospect match basis               PASS` · `COMMIT    d2669353…` · `EXPECTED  44 assertions` · `MB-3 [DB] readiness against the recorded move month` · `· recorded move_month 2026-08 vs governed ready 2026-09-14` · `ASSERTIONS COMPLETE · 44 run · 44 passed · 0 failed` · `operator app: matched at b0be9f46…` · no `── … FAIL` line · `ALL REQUIRED ASSERTIONS PASSED` |

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
| MB-2 every constraint carries the fact it was **compared** against | CONFIRMED at `d2669353` (was REJECTED at `13381cf`) | finding 2, fixed by the lane itself in `0eaabb4`; `violated` proven reachable in CI 545; `satisfied` not yet proven |
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

**2. FIXED AT `d2669353` — kept for the record. The readiness constraint
reported `satisfied` without comparing anything to the prospect's recorded
move month (MB-2, MB-3, §5).** The basis entry
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

- The readiness proof (`0eaabb4`) asserts `violated` and `no_recorded_move_month`
  only. Add the `satisfied` case (ready on or before the last day of the
  recorded month, including the last day itself) and the
  `recorded_move_month_not_a_month` case, so both directions of the new
  comparison are pinned. Small; part of the correction round.
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

## Rulings on the packet's owner decisions (QB, 2026-09-14)

1. **Do the `exact_spaces` callers migrate to the new read?** Not in this
   lane and not before tomorrow. It changes what a prospect hears from the
   agent path, which is prose in a model-facing surface; QB recommends
   option (a) as a successor lane with its own first red, and it is
   Kameron's call. `exact_spaces` stays as it is (option c is refused: it is
   a different question's answer with 18 assertions built on the filter).
2. **Does the Ask Spine gate widen to `src/leasing`?** Yes. A gate that scans
   less than it asserts launders the gap into evidence, and the gate's own
   vocabulary exists for exactly this: the four discovered domains
   (`forward_leasing`, `leasing_standing`, `opportunity_lifecycle`,
   `renewals`) are declared `pending` with an owner and a clearing
   condition, not `registered`. That is a declaration, not other lanes'
   work. Added to the correction round as a bounded item; if any of the
   four turns out to already be gathered, declare it `registered` only when
   the detector proves it.
3. **The screen.** After this lane integrates, as a separate assignment to
   the app lane with the door as its contract. Not before the person wall
   exists, and not for the 15 Sept walkthrough.
4. **`CURRENT_STATE.md` snapshot commit stale.** Carried; the QB re-stamps
   it on the board at the next integration. Not this lane's.
