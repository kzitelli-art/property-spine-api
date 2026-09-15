# Ruling — "automatic matching" is retrieval on a declared basis (2026-09-14, QB: Fable)

Governs the Opus lane that builds prospect-to-home matching. Written before
the build, per PHILOSOPHY §31 (question 1 first) and §40.10 (retrieval ≠
comparison ≠ causal explanation). Cite it as MB-1 … MB-9.

## What exists today (read before building; nothing here is rebuilt)

- `src/leasing/leasing_inventory.js` `availableUnits()` — filters homes by
  property, bedroom count, rent ceiling and the required date term, and
  **fails closed without a term** (its containment proof is 18 assertions and
  carries a removal condition for the date-blind predicate). This is the
  retrieval seam; matching extends it, it does not replace it.
- Prospect essentials — tour completion records `budget`, `move_month`,
  `unit_type` through `recordPersonFact` with provenance (savepoint-isolated).
  These are the prospect's **recorded** constraints. Nothing else counts.
- `src/leasing/tour_chips.js` — ranks *signal strength* (stated > asked >
  contextual) for what mattered on a tour. It ranks evidence, not homes.
- `budget_mismatch` — a reactive close reason when staff close an opportunity.
- Governed price comes only from the published pricing version resolved per
  unit type and term (`effective_pricing`; unresolved reason
  `no_published_pricing_version`). Readiness comes only from the availability
  and leaseable-units reads (`marketable_now`, governed ready date).
- The legacy date-only inventory branch reads `units.occupancy_status` and
  `units.bedrooms`, which Deal Setup never writes (Greenery checklist finding
  8). **Matching may not read it.**

## The rulings

**MB-1 · Class.** Automatic matching is **retrieval**: "which exact homes
satisfy this prospect's recorded constraints, and on what basis." It is not
comparison ("best fit", "outlier", a score) and not causal explanation. A
build that claims more must say so in its receipt and will be refused at
review unless the basis is recorded (§40.10).

**MB-2 · Every match carries its basis.** For each home returned, the
payload names each constraint compared, the prospect fact it came from (key,
value, provenance, as-of) and the home fact it was compared against (read,
value, as-of). A match without a basis is not a match; it is a guess.

**MB-3 · Three states per constraint, never two.** `satisfied`, `violated`,
`not_established`. A missing prospect fact or a missing home fact is
`not_established` and stays visible (§5, §40.7). It is never treated as
satisfied, never averaged away, never hidden by a filter. "Budget matching is
incomplete" must be readable as exactly that.

**MB-4 · Governed sources only.** Price: the published pricing version for
the home's unit type and the prospect's term. Readiness and offerability:
the availability / leaseable-units reads. Occupancy: the canonical dated
position. Prospect facts: `recordPersonFact` keys. Never legacy `units.*`
columns, never free text, never a model's paraphrase.

**MB-5 · Ordering is a named rule, not a score.** If results are ordered, the
order is deterministic and its rule is named in the payload, e.g.
`all_recorded_constraints_satisfied → fewest_not_established →
earliest_governed_ready_date → lowest_governed_price`. No weights, no learned
ranking, no numeric score. Changing the rule is a ruling, not a tweak.

**MB-6 · Floor fact coverage is reported, not assumed.** The read states
which constraint families it can evaluate for this property today (price,
readiness, unit type, term, bedrooms) and which it cannot, per home. A
property with no published pricing returns every home `not_established` on
price and says why; it does not return "no matches".

**MB-7 · Term is required.** Matching without a term inherits
`availableUnits`' refusal. "I need your dates" and "nothing available" stay
distinct answers.

**MB-8 · Two readers from day one.** The result is a canonical read with a
compact standing projection ("N homes satisfy every recorded constraint;
M are unknown on price; basis: …") registered for Ask Spine
(`tests/gates/gate_ask_spine_readers.js`) before the screen. Staff surface
first; the prospect-facing altitude is a separate, later decision (Tenant
Agent is reserved). Entitlement rides on each fact into the composed answer
(§40.8); a prospect's recorded budget is disclosed only where the staff
reader already may see it.

**MB-9 · No schema in the first slice.** Compute at read time from the
canonical reads above. If an audit trail of "what was offered on what basis"
is needed, it attaches to the existing offer/invitation record that already
carries the exact `space_id`; propose it as a follow-up with a migration
number, do not add a table to make the read easier.

## First red the lane must show

On the baseline, no read answers "which homes satisfy this prospect's
recorded constraints and on what basis": a new proof asks it over HTTP and
through Ask Spine and gets no governed answer (`NOT_ESTABLISHED` or no
route). That is the red. The correction is one canonical read extending the
`availableUnits` seam, its projection, its registration, and a screen only
after those.

## Acceptance (the proof must falsify each)

- A prospect with recorded budget below every governed price: every home
  `violated` on price, none hidden, basis named.
- No budget recorded: every home `not_established` on price; ordering rule
  still deterministic; projection says "unknown on price".
- No published pricing: price family reported unavailable for the property;
  readiness still evaluated.
- No term: refused with the existing reason.
- Legacy `units.bedrooms` populated but no Deal Setup position: the home
  does not appear (governed inventory only).
- Ask Spine returns the projection without ids, entitled, and the gate is
  green with the new domain registered.
