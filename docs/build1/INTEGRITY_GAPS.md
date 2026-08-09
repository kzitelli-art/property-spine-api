# Build 1 / Build 2 — open integrity gaps

Findings that are **real, reachable, and not fixed**. Each one is written so that
the next person can decide it without re-deriving it. Nothing here is a Release 0
blocker; nothing here is scheduled.

A gap earns a place on this list by being **reachable in the shipped code against
a database the shipped code can actually produce**. "Theoretically possible if
someone runs DDL by hand" is a note, not a gap.

---

## GAP 1 · An orphaned `related_id` splits Capability 2 into two populations

**Status** OPEN · **Found** adversarial pass on the obligation rail ·
**Capability** `maintenance.ownership_and_acceptance` only ·
**Class** truthfulness of a governed answer

### The structural fact

`obligations.related_id` is polymorphic and carries **no foreign key**
(`migrations/001_baseline.sql`):

```sql
  related_id      uuid,
  related_type    text,   -- work_order|turnover|lease|property_control|...
```

So nothing in the database prevents a row with `related_type = 'work_order'`
whose `related_id` names no work order — or names one in a different property.
`on delete cascade` does not apply to a column that references nothing.

### Where the two populations diverge

`src/askspine/intent_executor.js`, the ownership population reader, answers one
question with two different populations:

```sql
-- the RECORD lane: inner join, property-scoped on BOTH sides
   from public.obligations o
   join public.work_orders w
     on w.id = o.related_id and w.property_id = o.property_id
  where o.property_id = $1 and o.related_type = 'work_order' ...
```

```sql
-- the FACET counts: no join at all
   from public.obligations o
  where o.property_id = $1 and o.related_type = 'work_order' ...
  group by ownership_state
```

`total_matching` comes from the **joined** set. `facets.ownership_state` comes
from the **unjoined** set. They are equal only while every obligation resolves.

### What the operator is told

`renderer.js :: ownership_mixed` composes the sentence from both:

```js
return `${laneTotal(t)} current maintenance obligations: ${parts.join(", ")}.`;
//       ^ joined total                                    ^ unjoined facets
```

With three orphaned obligations the answer reads:

```text
70 current maintenance obligations: 8 unassigned, 14 assigned but not yet
accepted, 51 assigned and accepted.
```

**8 + 14 + 51 = 73.** The sentence does not add up, and nothing in the answer,
the boundedness note, or the receipt explains the difference. That is a confident
wrong number on a governed surface — the failure mode the doctrine names first.

### The worse direction

`CONCLUSION_MAPPERS["maintenance.ownership_and_acceptance"]` reads both
populations in the same decision:

```js
if (lane.total === 0) return "ownership_none_current";     // joined
const unowned = (f.unassigned || 0) + (f.assigned_not_accepted || 0);   // unjoined
```

Two reachable outcomes, and the second is the one that matters:

1. **Over-report.** Every resolving obligation is accepted, one orphan is
   unassigned → conclusion is `ownership_mixed`, the operator is told an
   unassigned obligation exists, and **no record for it appears in the list**.
   Visible, confusing, arguably safe.

2. **Silent under-report.** Every resolving obligation is gone but an orphan
   remains → `lane.total === 0` → `"There are no current maintenance obligations
   on work orders here."` An obligation that exists in the database is reported
   as not existing. **This is the dangerous direction**: honest-blank language
   used to state a false negative.

### Not affected

**Capability 1 is untouched.** `maintenance.completion_without_valid_proof` reads
`release_0_completion_invariant_violations` and `release_0_legacy_cutover_inventory`,
both keyed on `work_orders` directly. It never traverses `related_id`.

**The obligations board is untouched** by this finding. `operator_obligations.js`
does not use the facet/record split; this is a defect in how the Ask Spine answer
is composed, not in the rail beneath it.

**Migration 142 does not cover it.** 142 says an acceptance may not outlive its
assignment. It says nothing about whether the obligation points at a real work
order — a different orphan, in a different direction.

### Why it is not fixed today

Because the fix is a product decision, not a patch, and picking one silently
would write a story instead of recording one:

- **Join the facets too** — the counts then describe only obligations that
  resolve. Truthful and self-consistent, but an orphaned obligation becomes
  invisible everywhere, which is how it stayed unnoticed in the first place.
- **Drop the join from the records** — then a record renders with no
  `work_order_ref` and no unit, and the answer starts showing rows the operator
  cannot act on.
- **Report the divergence as a coverage state** — `partial`, with a named
  reason: *"N obligations reference work orders that could not be resolved."*
  This is the one that matches doctrine, because it makes the defect visible
  instead of choosing which half of it to hide. It also needs the executor's
  coverage machinery to carry a reason, which is a contract change, which moves
  a frozen digest.

The third is the recommendation. It is not the ruling.

### What is owed before any fix

**Cardinality first, as with every other rail decision here.** Nobody has
measured whether the orphan population is zero, three, or thousands in any real
database. A read-only count against production answers it:

```sql
select count(*)                                          as work_order_obligations,
       count(*) filter (where w.id is null)              as orphaned
  from public.obligations o
  left join public.work_orders w
    on w.id = o.related_id and w.property_id = o.property_id
 where o.related_type = 'work_order' and o.module = 'maintenance';
```

If it returns zero everywhere, the gap is a latent defect and the fix is
prophylactic. If it returns rows, the fix is urgent and the rows are also a
data-integrity finding in their own right — separate from Ask Spine.

### Boundary

**Not a Release 0 blocker.** Release 0 governs work-order completion proof and
never reads `obligations.related_id` for that purpose. Do not let this into the
activation decision.
