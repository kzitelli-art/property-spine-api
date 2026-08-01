# Blocking design items

Defects found by evidence, whose repair requires a ruling this thread does not
have the authority to make. Nothing here is fixed. Nothing here is folded into
the branch that exposed it.

Both items below were surfaced by repairing `tests/test_conversion_rail.db.js`,
which had been **dead for 204 commits** — it threw at build time before any
assertion ran, and reported nothing an eye would flag. Neither defect is caused
by the branch that found them; both predate it on `main`. The dead harness was
not merely failing to prove things. It was concealing these.

---

## ITEM 1 — `obligations.status = 'missed'` is unwritable

**Status: BLOCKING. Requires a migration. Not written.**

### The fact

`conversion_obligation_closure.js:109` closes a missed conversion rung with:

```js
update obligations set status='missed', updated_at=now() where id=$1
```

The live constraint refuses it:

```
ck_obl_status :: CHECK (status = ANY (ARRAY['open','in_progress','complete','escalated']))
```

Measured on the live database 2026-08-01, across all 523 obligations:

```
complete      326
open          197
missed          0
in_progress     0
escalated       0
```

Zero `missed` rows. **This path has never once succeeded** — not in production,
not in test. It is the only site in the codebase that writes `status='missed'`
(verified by grep across `src/` and `server.js`), so the blast radius is exactly
one call path: the conversion rail's missed-window closure.

The failure is not silent-and-partial. The `update` throws, rolling back the
whole transaction — taking the link stamp and the `069` ledger append with it.
So a crossed follow-up window records nothing at all.

### Why it stayed invisible

`tests/test_conversion_rail.db.js` scenario 8 is the only thing that exercises
the missed path, and that harness had not run since the closure-authority guard
was introduced. Absence of red was mistaken for green.

### The system disagrees with itself about whether `missed` exists

| Surface | Accepts `missed`? |
|---|---|
| `leasing_conversion_obligations.outcome` | yes |
| `leasing_conversion_obligation_events.resolution_code` (069) | yes — `check in ('completed','released','missed')` |
| `conversion_obligation_closure.js:106,109,128` | assumes yes |
| `obligations.status` / `ck_obl_status` | **no** |

Three layers model a missed obligation. The shared status column does not.

### Two constraints that narrow the repair

- `ck_oblig_resolution_code` allows `satisfied | superseded | revoked |
  dispatch_refused | expired`. There is no `missed` here either, so "close it
  complete and record the reason in `resolution_code`" needs its own migration
  or has to reuse `expired`.
- `ck_oblig_resolution_requires_complete` — `resolution_code IS NULL OR status =
  'complete'`. A `missed` status can therefore never carry a resolution code
  unless this is widened in the same migration.

### Options

| | Approach | Migration | Cost |
|---|---|---|---|
| A | Widen `ck_obl_status` to include `missed` | yes | shared constraint; `099` set a precedent against widening it |
| B | Leave the obligation `open`; record missed on the link + ledger only | no | link says `closed_at` set and `outcome='missed'` while the obligation says open — two records disagreeing, the exact shape `work_order_service.js` documents as having already misclassified money once |
| C | Close as `complete` | no | asserts work was done that was not. §5 violation. **Reject.** |

### RULING 2026-08-01 — DERIVE the miss. Do NOT widen `ck_obl_status`.

My analysis above framed this as "A is the only option that neither lies nor
leaves two records disagreeing." **That framing was wrong, and the ruling
rejects it.** I treated `missed` as a fourth lifecycle value competing with the
existing three. It is not the same KIND of fact.

Lifecycle status is mutually exclusive. Missedness is not — it is orthogonal to
it. An obligation may be:

- open **and** missed;
- in progress **and** missed;
- escalated **because** it was missed;
- complete now, **having been** missed earlier.

Putting `missed` into the lifecycle enum erases every one of those distinctions
and creates another overloaded field — the exact defect ITEM 2 documents for
`conversation_owner_user_id`. Option A would have traded one overloaded column
for another.

**The durable model is two axes, not one:**

```
lifecycle status        →  open | in_progress | complete | escalated
timeliness / recovery   →  on_time | due | missed
```

When the recovery window is crossed the system must:

1. preserve an immutable `obligation_missed` (recovery-window-missed) event;
2. record the exact threshold and the time it was crossed;
3. escalate, reassign or surface the obligation **through the canonical engine**;
4. leave the lifecycle status intact;
5. let projections render `missed` from the durable event or an explicit
   `missed_at` fact.

**`now() > due_at` must not remain the only source.** A purely computed read
makes historical truth shift with the clock and never records WHEN the system
recognised the miss. The current-state read may be derived; the first missed
transition must become durable history.

### Next step (separate governed slice, not started)

Audit every read and write of `status='missed'` and the intent behind scenario 8
first. Then propose the SMALLEST design that records the miss durably without
overloading lifecycle status.

### Removal condition

Closed when a crossed recovery window writes durable history — event plus
threshold plus timestamp — the lifecycle status is left intact, and
`tests/test_conversion_rail.db.js` scenario 8 asserts the two-axis model rather
than a `missed` lifecycle value. **Scenario 8's current assertion
(`ob.status === "missed"`) encodes the rejected model and must itself be
rewritten as part of that slice.**

---

## ITEM 2 — `conversation_owner_user_id` conflates attribution with ownership

**Status: BLOCKING for conversion-rail activation. Requires a ruling. May
require a migration. Not patched, not renamed, not routed through
`eligibleOwner`.**

### The fact

Property Spine deliberately keeps four things separate: attribution, eligible
assignment, task ownership, and authenticated authority. This column straddles
them. It is written from a host *claim* without eligibility resolution, and then
read by operating logic and labelled as ownership on the desk.

### Writers

| Site | Writes | Eligibility resolved? |
|---|---|---|
| `leasingconversion.js:269-274` (create) | `actual_tour_host_user_id` verbatim | **no** |
| `leasingconversion.js:392` (`handoffConversation`) | `to_user_id` | **no** |

### Readers

Gated through `eligibleOwner` — ineligible resolves to null, honest UNASSIGNED.
**Safe:** `746`, `798`, `825`, `940`, `957`, `1081`, `1152`.

Two of these already carry comments naming the problem: *"an attribution pointer
is not proof of eligibility."* The conclusion was reached at the read sites and
never applied at the write sites.

**Ungated:**

- **`leasingconversion.js:385`** —
  ```js
  if (from_user_id && from_user_id !== conv.conversation_owner_user_id) {
    throw httpErr(409, "handoff 'from' does not match the current conversation owner.");
  }
  ```
  A staleness guard, not a grant — it confers no power on an ineligible user. But
  it treats the column as the authoritative statement of current ownership, and
  it is **optional**: a caller omitting `from_user_id` skips it entirely.
- `389` — read as `prev`, written as `from_user_id` into immutable handoff history.
- `422` — returned in the `flagHandoffRequired` payload.

App (`property-spine-app/index.html`): `21558` shapes it into `owner_name`;
`21806` is the offline fallback shaper, not the live wire.

### Desk labels

- `index.html:21832` — `owned by <b>{owner_name}</b> · {stage}`
- `index.html:21867` — `owned by <b>{owner_name}</b> · toured by {toured_by}`

`21867` is the sharp one. The UI has a **separate** `toured_by` field for
attribution, so for an ineligible host the desk renders *"owned by Drew Halloran
· toured by Drew Halloran"* with an unassigned rung directly beneath it. The
field is not presented as host context. It is presented as a distinct ownership
claim standing next to the host.

### Why `NOT NULL` prevents an honest blank

`migrations/047_leasing_conversion_rail.sql:66` —

```sql
conversation_owner_user_id uuid not null references users(id)
```

The column cannot hold null, so §5's honest blank is **unrepresentable by
construction**. Every conversion must name someone.

`047:91` also indexes it `where status='active'` — built for owner-filtered queue
reads. Nothing filters on it today, but the schema anticipates it, which is how a
semantic defect becomes a routing defect later.

### Options

| | Approach | Migration | Changes live behavior |
|---|---|---|---|
| A | Rename to `actual_host_attribution_user_id`; relabel desk to "toured by" | **yes** | display only |
| B | Keep the column; fix only the two desk labels; project true ownership from the open rung's `owner_user_id` | **no** | display only |
| C | Drop `NOT NULL`, route both writers through `eligibleOwner`, render UNASSIGNED when null | **yes** | yes — queue and desk |
| D | Split into two columns: attribution (NOT NULL) + owner (nullable, resolved) | **yes** | yes — queue and desk |

**B is the only option needing no migration** and is the smallest honest step:
the desk stops claiming ownership it cannot substantiate, while the durable field
keeps meaning what it currently means. It does not resolve the collision — it
stops the collision reaching the operator.

C and D need a ruling on whether `385` should authorize against attribution or
against resolved ownership.

### Pinned, not certified

`tests/test_conversion_rail.db.js` scenario 4b pins the observed value as
**attribution only**, with an explicit comment that downstream ownership
semantics remain unresolved. It does not certify current behavior as correct.

### Removal condition

Closed when a ruling selects an option and the desk no longer labels an
unresolved-eligibility user as the owner.

---

## ITEM 3 — adjacent, same write path

**Status: recorded, not acted on. Belongs with ITEM 2.**

`handoffConversation:405-411` moves open-rung `owner_user_id` with **no
eligibility check and no ledger event**:

```js
update leasing_conversion_obligations lco set owner_user_id=$1 ...
```

Compare `reassignRungOwner:668-677`, which resolves through `eligibleOwner`,
updates `obligations.assigned_user_id` in step, and appends a closure event —
with a comment stating exactly why leaving one column stale *"would replace one
false owner with a quieter one."*

Handoff does none of the three. So `eligibleOwner` guards the spawn paths while
the handoff path walks around it. This is a task-ownership defect rather than a
`conversation_owner_user_id` defect, but it shares the writer.

Related, weaker: `spawnRung` never sets `obligations.assigned_user_id` for any
rung, so the shared obligations row reads unassigned from birth even when the
link table names an eligible owner.

---

## ITEM 4 — an ambiguously configured SMS line does not fail honestly

**Status: BLOCKING before a second line type exists. Latent, not live. Requires
a migration. Not written.** Full context in
[`COMMUNICATION_LINE_ARCHITECTURE.md`](COMMUNICATION_LINE_ARCHITECTURE.md).

`properties.sms_number` has **no unique index** — migration `030` is only
`add column if not exists sms_number text`. The inbound lookup is:

```sql
select id, name, address, sms_number from properties where sms_number = $1 limit 1
```

`limit 1`, no `order by`. If two properties ever share a number, inbound binds to
an arbitrary one and a resident's message lands on another property's ledger —
confidently, with no signal. Unknown lines fail honestly; **ambiguous ones do
not**.

Currently latent: the guarded route (`tenantlink.js:383-391`, 409 on clash) is
the only production writer, verified by grep. It is one row of defense in
application code with no database backstop, bypassed by any seed, migration,
admin tool, or direct SQL.

**Repair:** unique index on `sms_number where sms_number is not null`, plus a
count-based refusal replacing `limit 1`. Small, but a migration.

**Removal condition:** closed when the database refuses duplicate lines and
inbound refuses to guess between them.
