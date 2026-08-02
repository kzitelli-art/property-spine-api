# APPOINTMENT ATTRIBUTION — MIGRATION CONTRACT (UNNUMBERED)

**This is a migration CONTRACT, not migration authority.**

It is deliberately **not** named with a number. The Neon ledger is deployment
authority, and the unresolved `121` history — two different migrations numbered
`121` on 2026-08-01, one renumbered to `122` sixteen minutes later, and a
production ledger row whose identity cannot be resolved from the repository —
proves the all-branch reservation scan is not sufficient to claim a number.

**Nothing in this file may be placed in `migrations/` until the Neon ledger is
supplied and a number is assigned from it.**

---

## 1 · THE DDL, EXACTLY

```sql
-- ── THE DURABLE OPPORTUNITY BRIDGE ──────────────────────────────────
--  Additive only. No column is dropped, no constraint tightened, no data
--  rewritten. Every existing row keeps working with conversion_id NULL.

alter table leasing_tours
  add column if not exists conversion_id uuid
    references leasing_conversions(id) on delete set null;

alter table scheduled_tours
  add column if not exists conversion_id uuid
    references leasing_conversions(id) on delete set null;

-- Partial: the overwhelming majority of historical rows stay NULL and must not
-- be indexed. These support "every appointment for this opportunity", which is
-- the projector's only access path.
create index if not exists idx_leasing_tours_conversion
  on leasing_tours (conversion_id) where conversion_id is not null;

create index if not exists idx_scheduled_tours_conversion
  on scheduled_tours (conversion_id) where conversion_id is not null;
```

### FK target and delete behaviour

`references leasing_conversions(id) **on delete set null**`.

Not `cascade`: deleting an opportunity must never delete the appointment. The
appointment **happened** — it is observed history, and its `tour_events` remain
truthful evidence regardless of what becomes of the opportunity record. Losing
the link is a demotion to `unattributed`, which the projector already models.

Not `restrict`: an opportunity's lifecycle is not the appointment's to veto.

### Property consistency — writer-enforced, NOT structural

A composite FK `(property_id, conversion_id)` would enforce same-property
structurally, but requires a unique key on `leasing_conversions(property_id,
id)` — a **new constraint on a table this cut is not authorised to reshape**,
and `scheduled_tours` has no `lead_id` to make the pairing natural.

Therefore: **the canonical writer validates that the opportunity's
`property_id` equals the appointment's**, refusing cross-property attribution
with a controlled refusal. The analyzer and projector both re-check it on read
and report `wrong_property` rather than trusting the column.

Recorded as a deliberate weaker-enforcement choice, not an oversight.
**Promotion condition:** if `leasing_conversions` ever gains a
`(property_id, id)` unique key for another reason, promote this to a composite
FK and delete the writer-side check.

---

## 2 · WHAT THE MIGRATION DOES **NOT** DO

- **No inference-based backfill.** The migration writes no `conversion_id`
  values at all. Backfill is a separate, exact-links-only act (phase 6),
  measured first by the analyzer.
- **No NOT NULL.** Null is indefinitely valid — see §4.
- **No status change, no new vocabulary, no new table, no trigger.**
- **No touching of `leasing_conversions`**, including the four flattened fields.

---

## 3 · WRITE-SIDE CONTRACT THE MIGRATION ASSUMES

| Act | Requirement |
|---|---|
| native creation in an opportunity-bound workflow | `conversion_id` set from the server-resolved opportunity UUID |
| native creation outside such a workflow | stays NULL — **explicitly unattributed, never guessed later** |
| **native reschedule successor insert** | **MUST copy `conversion_id` from the predecessor row** |
| external creation | set when the ingesting workflow carries an opportunity; else NULL |
| external reschedule | row persists, `conversion_id` untouched — preserved by construction |
| cancellation | never clears `conversion_id`; prior scheduling truth is preserved |
| completion / no-show / check-in | never writes `conversion_id`; reads it |
| correction / reopen | never rewrites `conversion_id` |

The native successor insert is the **only** place attribution can silently
disappear mid-chain, because it is the only act that creates a new row
representing a continuing attempt.

---

## 4 · WHEN NULL REMAINS VALID — INDEFINITELY

`conversion_id IS NULL` is a truthful state, valid indefinitely, for:

1. every historical appointment with no exact link (the analyzer's honest
   opening population);
2. appointments created outside an opportunity-bound workflow — walk-ins with
   no conversation, external calendar rows imported before any opportunity
   existed;
3. appointments whose only possible association is lead / person / property /
   time inference. **No automated pass may ever "improve" these**, because the
   inference that would fill them is forbidden.

Null therefore means **"not attributable from the evidence available"**, never
"not yet processed". The projector reports it as `unattributed`, never as
missing data awaiting a batch fix.

**It does not mean the appointment can never be attributed.** A later
*explicit* correction — one that carries its own proof and names its
attribution — may resolve any of these. `conversion_id IS NULL` may remain valid
indefinitely without that being a permanent verdict on the appointment. What is
forbidden is closing the gap automatically.

---

## 5 · ROLLBACK AND ENFORCEMENT SEQUENCE

**Rollback** (additive, so trivially reversible):

```sql
drop index if exists idx_leasing_tours_conversion;
drop index if exists idx_scheduled_tours_conversion;
alter table leasing_tours   drop column if exists conversion_id;
alter table scheduled_tours drop column if exists conversion_id;
```

Safe at any point before writers are cut over. **After** cutover, rolling back
the column is a code rollback too — the writers must be reverted in the same
step, or they will error on an absent column. The migration and the writer
cutover are one deployable unit.

**Enforcement sequence** — deliberately staged, never all at once:

1. migration applied · column exists · everything NULL · no behaviour change
2. writers cut over · **new** rows attributed · historical rows untouched
3. analyzer re-run · measures the attributed population against the opening
   baseline
4. exact-links-only backfill · no inference
5. projector reads `conversion_id` as the primary basis, with the flattened
   pointers demoted to secondary bases
6. **no NOT NULL is ever added** — see §4

---

## 6 · LEDGER-DEPENDENT ACTIONS STILL BLOCKED

- assigning the number
- creating the file under `migrations/` or the staged deployment directory
- pushing any branch state whose production source references `conversion_id`

Migration 125 is not amended or moved by any of this.
