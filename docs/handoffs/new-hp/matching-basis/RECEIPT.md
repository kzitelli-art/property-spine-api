# Prospect-to-home matching — retrieval on a declared basis

Lane `claude-opus/matching-basis-20260914` (API only). Governed by
`docs/handoffs/new-hp/rulings/MATCHING_BASIS_RULING_20260914.md`; every
section below cites the ruling it satisfies.

Baseline: API `0e10ef84e6b858ed2b35e132af2f50ee208fb5d0` on
`claude/board-20260914` · app `b0be9f46b5dc0240a1b6c2cb898ecca4fc85a09c`
(**no app change; the pin was not moved**). No schema. No deployment. No
production read or write. `tour_chips.js` and pricing untouched.

## The first red, on the baseline

`docs/handoffs/new-hp/matching-basis/first_red.witness.txt` — the proof run
against the unmodified baseline with an owned server, 3 passed / **6 failed**:

| ruling | failing assertion | observed |
|---|---|---|
| MB-1 | the leasing owner exposes a canonical prospect-match read | exports are `availableUnits, attachSelectedUnit, matchConfirmationToOffer` |
| MB-8 | and a compact standing projection beside it | absent |
| MB-8 | a staff-session door answers the match question | `GET /operator/leasing/prospect-match` → **404** |
| MB-2 | the HTTP payload carries a per-home basis | `{}` |
| MB-8 | the Ask Spine registry declares the domain | no `prospect_match` entry |
| MB-8 | `ask_spine_answer` gathers the projection | never calls it |

The two that PASSED are the substantive red, and they are why this is a
defect rather than an absence. With a recorded budget of 900 against a
governed price of 1025, today's `exact_spaces` seam returns **zero homes**
with `qualification=exact_space_matches_informational` — "No priced home
matched these criteria." The one eligible home is dropped by `continue`, and
nothing in the answer names it or says by how much it missed. "Nothing fits"
and "one home fits except on price" are different facts, and an operator
needs the second one (MB-3, §5).

## The correction

One canonical read **extending** the `availableUnits` seam in the same owner
— not a second inventory path, and the legacy date-only branch is never
reached.

- **MB-1 · retrieval, declared.** The payload carries
  `capability_class: "retrieval"` and `claims_not_made: ["comparison",
  "causal_explanation", "best_fit", "score"]`. Asserted by walking the whole
  payload for any key matching `score|weight|rank|ranking|fit` — zero.
- **MB-2 · every match carries its basis.** Per constraint:
  `{constraint, state, prospect_fact{key,value,source,recorded_at},
  home_fact{read,value,as_of,authority}, why}`.
- **MB-3 · three states.** `satisfied | violated | not_established`. A
  violated home is **returned**, named, with the comparison shown. A missing
  prospect fact and a missing home fact are both `not_established` and are
  distinguished by `why` (`no_recorded_budget` vs the economics reason).
  A recorded budget that cannot be parsed is `recorded_budget_not_numeric`,
  which is neither zero nor missing.
- **MB-4 · governed sources only.** Price from
  `effective_pricing.resolveSpaceEconomics` with its authority; inventory
  membership and readiness from `application_target_read
  .leaseableApplicationTargets`; prospect facts from `person_attributes`
  active rows for the three `recordPersonFact` keys. No legacy
  `units.occupancy_status`.
- **MB-5 · one named rule, no score.** `all_recorded_constraints_satisfied →
  fewest_not_established → earliest_governed_ready_date →
  lowest_governed_price → unit_number`, named in every payload and asserted
  deterministic across two identical calls.
- **MB-6 · coverage reported.** `constraint_coverage` per family. A property
  with no published pricing reports price `unavailable_for_this_property`,
  still evaluates readiness, and keeps `qualification: match_basis_recorded`
  — it never answers "no matches".
- **MB-7 · term required, refusal inherited.** The read asks the seam for one
  home and passes its refusal through verbatim, tagged
  `refusal_inherited_from: "availableUnits(exact_spaces)"`. `term_required`
  and `pricing_term_required` stay distinct refusals.
- **MB-8 · two readers from day one.** `readProspectMatchStanding` returns
  counts, unknowns, missing prospect facts, coverage and the ordering rule,
  and **no record ids** (asserted with a UUID scan). Registered in the gate
  and gathered by `ask_spine_answer`. Staff surface only; the door is
  session-scoped and a query-string `property_id` is ignored.
- **MB-9 · no schema.** Ledger unchanged at 198 / 186 rows; no table matching
  `%match%` exists.

### One shared-file change worth reading

`gate_ask_spine_readers.js` detected gathering by looking for the domain's
own name inside a require path. That cannot hold for a domain exposed from
an existing owner — nothing in `src/leasing/leasing_inventory.js` says
"prospect_match" — and it was also weaker than it looked the other way,
accepting a require of any path merely containing the domain word. A
registry entry may now declare `owner`, and when it does the detector demands
that exact path; entries without one keep the original rule, so nothing
already green moved. Three detector self-tests cover both directions, in the
gate's own "test your detectors every run" discipline.

The alternative — adding `src/leasing` to `STANDING_READ_DIRS` — would have
discovered four other domains (`forward_leasing`, `leasing_standing`,
`opportunity_lifecycle`, `renewals`) and demanded registry entries nobody has
decided. That is a scope change for other lanes, not a side effect of this
one; it is recorded as an owner decision, not taken.

## What was proven, and what each green would miss

`tests/proofs/prospect_match_basis.db.js` — **40 passed / 0 failed**, on an
owned nonce database built from the real migration chain (ledger 198 / 186
rows) with the owned server answering the real staff door. Registered in
`tests/e2e/verify_all.sh`.

- **Would miss:** no browser rung — this is proven as a domain and a door,
  not as a screen, and no screen was built. Ask Spine is proven registered,
  gathered and projected — **no provider answer was generated**, so the
  model's rendering of the projection is unproven. The fixture establishes
  two priced homes and one unpriced, so the ordering rule's later tiebreaks
  (ready date, price) are exercised over a small set; a property with many
  homes differing on each key is not covered.

### The proof failed in CI after passing locally, and why that mattered

CI 539 at `aafe963d`: **30 passed, 10 failed**, every failure the same shape —
`{"violated":0,"satisfying":0}` and each MB-2/MB-3/MB-4 assertion that needs a
home. Zero homes came back. The first version borrowed the shared Skyline
fixture, and this step is registered immediately after "current rent-roll
reconciliation into an onboarded property", which onboards into Skyline and
consumes its one eligible target. It passed locally only because nothing had
consumed it there. **A proof that depends on another proof's leftovers is
measuring the order of the suite**, and a green from it is a claim about
scheduling rather than about the product.

The proof now establishes its own governed inventory through the same objects
a real confirmation writes. Two product rules it had to learn on the way, both
correct, both now recorded in the fixture rather than worked around:
`uq_opening_tenancy_position_current_per_property` permits ONE opening
position per property, so every home is established under one activation; and
`materializeRentableSpaces` does not decide operating use, so without
`use_type` the target read answers `use_not_configured` and refuses the home.
- Gates: `gate_ask_spine_readers.js` 87/87 with 10 domains, 8 registered,
  2 pending; all 56 source-governance gates `PARENT EXIT 0`.
- Nearest regressions, same runtime: `leasing_path`, `leasing_hostile`,
  `leasing_ask_spine`, `leasing_reconciliation`, `leasing_standing_probe`,
  `prospect_confirmation.db`, `prospect_inventory_dates.db`,
  `prospect_inventory_dates.test`, `tour_application_lease` — all pass. Three
  failed first on my ad-hoc runtime and passed once
  `tests/e2e/instrument_fixture.js` and `E2E_SMS_LOG` were supplied; those
  were fixture-order artifacts of my runtime, not regressions.

## Runtime limits, stated

This container has no IPv6 loopback, so `proof_boundary.js`'s `portFree()`
(`host: "::"`) refuses with `EAFNOSUPPORT` and `create` cannot run. The owned
database was therefore created with the harness's own naming and manifest
format (`spine_proof_` + 24 hex, a 32-hex nonce, the `proof_run_identity`
marker) and the real `apply_migrations.sh` chain — every ownership guarantee
preserved, with only the TCP port probe skipped, which concerns the server
port and not the database. The server was booted directly with `boot.sh`'s
env rather than through `boot.sh`, for the same reason. CI runs the same proof
through the unmodified harness.
