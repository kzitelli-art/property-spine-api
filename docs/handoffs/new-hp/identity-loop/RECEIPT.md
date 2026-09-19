# Identity loop closes — receipt

**2026-09-19 · `tests/proofs/identity_loop_closes.db.js` · 38/38 on an owned
proof database + real HTTP · registered in `verify_all.sh`**

CURRENT_STATE row **160**. Reads rows 156 → 158 → 159 and asserts the seams
between them. Part B retires the second door onto "who is on this lease".

---

## Part A — the loop, walked by one resident

Three rows built three pieces and each was proven alone. **Three green proofs
of three pieces is not a proof that the loop closes**, so this walks ONE
resident all the way round and asserts at every seam.

```text
rent roll row (name only) → lease, no tenant, claim staged
  → screen AND Ask Spine both say resident_not_linked          seam 1  ✅
  → management links by phone (real HTTP)
  → screen AND Ask Spine both say linked, same read            seam 2  ✅
     …but the person still reads lifecycle 'lead'              seam 2  ⛔
  → that phone texts the property line                         seam 3  ⛔
  → Person Card shows the tenancy                              seam 4  ✅
  → Ask Spine entitled names it; unentitled gets nothing       seam 5  ✅
  → and the OLD door onto the same lease refuses               seam 7  ✅
```

### Where each seam is entered, said precisely

- Deal Setup, link-resident and the Person Card go through **real HTTP or
  their real services**. The lease is established through
  `activation.confirmProposal`, not inserted.
- The inbound SMS enters at **`resolveInboundSmsContext`** — the canonical
  resolver the `/communications/inbound-sms` webhook calls, and the seam that
  *decides attribution*. The transport above it (Twilio signature, provider
  ack, work-order dispatch) is exercised by `resident_sms_route_proof.db.js`
  and is **not** re-proven here.
- **No model is invoked.** The Ask Spine client is a stub that **throws** if
  called, so a passing tenancy answer is a governed read and not a sentence
  someone generated.

---

## ⛔ FINDING 1 — seam 3. The loop does NOT close.

**A resident an operator linked is not recognised when they text.**

`resolveInboundSmsContext` (`src/comms/communications_boundary.js`) resolves a
known resident at tier 1 through:

```sql
join tenant_invites ti on ti.person_id = per.id and ti.property_id = $1
                      and ti.status = 'used'
```

— a resident who has **accepted an invite**. A rent-roll resident linked by an
operator through row 159's door has no such row. Their first text lands as an
**UNMATCHED sender**: saved on the property, `needs_human`, zero outbound.

Observed in the run:

```text
communications_boundary: UNMATCHED sender +1215561XXXX at idloop-… —
  saved …, needs_human, zero outbound.
  ok  ⛔ FINDING: the linked resident is NOT recognised — tier 1 needs a USED tenant invite
  ok  the text is preserved on the property for a human, not guessed at
  ok  and the gap is exactly the invite: this resident has no used tenant_invite
```

**The finding is an assertion, not a note.** If someone widens tier 1 later,
that assertion goes red and they have to say so.

### Why it was reported and not fixed

Two different evidence classes wear the same word "resident":

| | what it establishes |
|---|---|
| operator link (row 159) | *a person with authority claims this phone belongs to that resident* |
| used tenant invite | *the holder of this phone proved it by accepting an invite* |

Widening tier 1 to accept an operator link widens **who Spine will speak to as
a known resident** on the strength of a claim rather than a proof. That is a
product ruling about trust, not a bug fix, and it is outside this slice's
blast radius.

**So row 159's door links a resident for the rent roll and for Ask Spine, and
does NOT yet make them recognised on the phone.** Said that way in row 160.

---

## ⛔ FINDING 2 — seam 2. The linked resident never leaves lifecycle `lead`.

Found by reading what the retired door did, then **measuring** what the
replacement does.

The retired `POST /leases/:id/tenants` advanced the person to
`lifecycle_status = 'tenant'` and wrote a `lifecycle_change` event.
**`link_resident.js` does not.** It passes no `lifecycle_status` to
`ingestPerson`, which defaults to `'lead'`.

Measured on the proof database — a Person named as the tenant of an **active
lease**:

```text
lifecycle_status = lead
leasing_stage    = lead
```

### The consequence, stated precisely

`src/identity/authority_resolution.js`:

```js
const HARD_COUNTERPARTY = new Set(["tenant","resident","past_resident","applicant","vendor"]);
const lifecycleOk = person && (
  HARD_COUNTERPARTY.has(lifecycle) ? false          // a staff context cannot override this
    : hasStaffContext ? true
    : !NON_STAFF_LIFECYCLES.has(lifecycle));
```

`lead` is **not** in `HARD_COUNTERPARTY`. So for a resident linked through row
159's door, the guard that exists to stop *a real counterparty being granted
staff authority* **does not fire** once a staff context exists. Had their
lifecycle advanced to `tenant`, it would block unconditionally.

### Not fixed, and not by restoring the retired door

The retired door had **zero callers**, so it was never performing the advance
for anyone. This is **row 159's gap, surfaced** — not something this
retirement caused.

A correct fix is a ruling, not a field: on `resolved_existing`, `ingestPerson`
does not update an existing person, so *who advances a person to tenant, and
when* has to be decided first. Asserted in the proof so that whoever fixes it
has to come here and say so.

---

## Negative controls (all green)

- A **stranger's** phone is not attributed to the linked resident; it is kept
  on the property for a human.
- The inbound text creates **no second Person**; exactly one Person carries
  the handle.
- A handle held by **two Persons** refuses **409 with the candidates and
  writes nothing** — lease untenanted, rent-roll counts unmoved.
- An **unentitled** Ask Spine session is refused with the resident's name
  nowhere in the response.

---

## Part B — the second door is closed

`POST /leases/:id/tenants` (`src/tenancy/lease_lifecycle_routes.js`) took an
already-known `person_id` straight onto a lease with **no property scope** (the
lease id alone chose the property), no staff session, no ingress, no claim
promotion and no evidence row.

It now answers **410** with a receipt a person can read, naming
`POST /operator/leases/:leaseId/link-resident` as the next step.

> Two doors onto one lease is how one lease ends up with two answers about the
> same resident.

### Callers, measured BEFORE closing: zero

Searched, and stated so the scope is not an unstated claim:

- **every tracked file on all 109 app remote branches** — not just
  `index.html`, not just the pinned branch
- this repo's `src/`, `server.js`, `tests/`, `tools/`, `migrations/`

⚠ **Source can prove a consumer exists; it cannot prove one does not.** The
shared operator key is held outside this repo. That is exactly why the path
answers a refusal that **names the replacement** instead of a 404 an external
caller would have to guess at.

**Class 3 (retired-in-place). Removal condition: one full release with zero
calls to this path in the access logs**, then the handler and its block
comment are deleted.

### Two things fixed on the way

1. The file's `TENANT LINKAGE` banner still described the endpoint in the
   **present tense** ("This endpoint links a person to a lease and advances
   their lifecycle"). Rewritten to name the live door — current source always
   wins, and a stale banner is a confident wrong answer to the next reader.
2. **A trap worth writing down.** The first attempt kept the old handler body
   "for reference" under `router.post("/__retired__/leases/:id/tenants", …)`.
   That is not a retirement — it is **a new live, ungated route doing the
   exact thing being retired**, reachable by anyone who reads the source. The
   body was deleted outright; git history holds it.

### Mutation-confirmed, because green is a claim about what was measured

| mutation | assertion that went red |
|---|---|
| `410` → `404` | the retired door answers 410 Gone |
| body reduced to `{error:"gone"}` | the refusal names the door to use instead |
| receipt says `person_id` / `tenant_ids` | the refusal does not leak machinery |
| handler writes the tenant, **then** refuses | wrote NOTHING · canonical read unchanged |

Four of the five new assertions were individually falsified; the fifth
(`canonical read unchanged`) went red under the write mutation too.

---

## FOUND AND NOT FIXED

**`DELETE /leases/:id/tenants`** — adjacent lines, same file, **same defect
class**: no property scope, no session, a client-supplied `person_id` removed
from `leases.tenant_ids`. Zero callers by the identical search.

**Not retired, deliberately.** There is no unlink door to name as a next step,
and a refusal that names none is worse product than the route. Gating a route
with unknown external callers is exactly the `team-invites` mistake this repo
already paid for.

**An unlink door through the same gates as link-resident is the next thing
someone should build** — and retiring this one is part of that slice, not a
separate cleanup.

**`gate_person_ingress` fails 2** — `src/baseline/baseline_routes.js` writes
`insert into persons` outside the boundary, and `server.js` is stale in the
DECLARED register. Pre-existing (recorded in row 159), verified unchanged, and
the gate names neither file touched here.

---

## Not reached

**No browser rung.** This proves the seams between canonical reads and one
refusal; nothing new renders. Said plainly rather than implied.

---

## Rules honoured

- **No production data was touched** (§46). Every fixture is built on an owned
  proof database through the real Deal Setup path.
- **No name matching**, ever. Attribution is by continuity handle only.
- **No new identity table and no second identity system.**
- **`person_ingress`'s staging rule is untouched** — this slice never calls
  `confirmPersonProposal` and never writes `persons`.
- **The app was not touched**, so the app suite was not run.

## Runtime

Owned proof database, migration ceiling **200**: 189 migration files, 187
applied, 2 data migrations that legitimately refuse on an empty database
(`087_internal_qa_leasing_coverage`, `110_governed_charge_assessed_per`).

Full run output: [`run.txt`](run.txt).
