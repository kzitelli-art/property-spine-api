# Release 0 — app closeout call-site audit

**Source audit of `property-spine-app` at `main` `6220ca5`. No database read, no
runtime change.** Closes review finding 8.

Companion to [`RELEASE_0_COMPLETION_WRITER_MATRIX.md`](RELEASE_0_COMPLETION_WRITER_MATRIX.md),
which established the API side.

---

## 1. Every call site that reaches `PATCH /work-orders/:id/closeout`

| # | Location | Body sent | Completion? | Reachable how |
|---|---|---|---|---|
| 1 | `index.html:14780` — `closeoutDone(id)` | `{done:true, completion_photo, completion_note}` | **YES — the legacy completion writer** | drawer → `workOrderPanel` → **"Mark done — close"** |
| 2 | `index.html:14793` — `closeoutNotDone(id)` | `{done:false, not_done_reason, completion_note}` | **NO** — API routes to `needs_followup` + follow-up obligation | same drawer → "Not 100% done" → **"Log reason — keep chain alive"** |
| 3 | `index.html:10472` | in-memory demo interceptor `^/work-orders/([^/]+)/closeout$` | n/a — **DEMO only** | demo toggle; never production |

**Call site 1 is the only one that completes work.** Call site 2 shares the
route but is a not-done path and must survive Release 0 — retiring the route
wholesale would take the follow-up lane with it.

## 2. The user path to call site 1

```text
maintenance desk row
  → renderDetail(r)                      index.html:14457
  → r.kind === 'work_order'              :14460
  → workOrderPanel(r.raw)                :14464  → :14646
  → closeout block                       :14703
  → "Mark done — close"                  :14710
  → closeoutDone(id)                     :14774
  → PATCH /work-orders/:id/closeout      :14780
```

`renderDetail` is reached from seven places, all maintenance-desk row
renderers: `index.html:11525` (`openDetail`), `:11701`, `:11746`, `:12030`,
`:12080`, `:12156`, `:12260`.

**Every one of them lands in the same drawer, so there is one panel to change,
not seven.**

---

## 3. ⚠ Finding: the completion photo is a stub string

`index.html:14745`:

```js
// Stubbed photo: proves the gate without a real upload pipeline (per scope).
const woStubPhotos={};
function attachStubPhoto(id){
  woStubPhotos[id]=`stub://closeout-photo/${id}/${Date.now()}`;
  const el=$(`woPhotoState_${id}`);
  if(el){el.textContent='Photo attached ✓ (stub)'; …}
}
```

`closeoutDone` then sends that string as `completion_photo`, and the API's gate
(`maintenance.js:541`) accepts it because it only tests non-empty.

**There is no upload pipeline in the app.** The operator presses "📷 Attach
photo", the UI says *"Photo attached ✓ (stub)"*, and a synthetic URI is sent. No
bytes ever exist, no MIME type, no digest, no storage state.

This materially strengthens §19c **Ruling C**. The column is not merely
*unverified* evidence — in the app's own flow it is **provably not evidence at
all**. The ruling's prohibition on manufacturing attachment rows from
`completion_photo` is not a precaution; it is the only correct treatment, and
anything derived from that column would be derived from a timestamp with a
prefix.

The audit deliberately read `completion_photo IS NOT NULL` and never its
contents, so **whether production's single `closed` row holds a `stub://` value
is not established by the audit.** Given this is the only app path that writes
the column, it is the likely content — but that is inference, and the receipt
does not claim it.

---

## 4. ⚠ Finding: the live door cannot complete a work order

`work-lifecycle-door.js` (`window.__psWorkOrders`) is the live Work Orders
surface. Every `__psLive` method it calls:

```text
__psLive.hasSession                 read
__psLive.workOrderLifecycleList     read
__psLive.workOrderLifecycle         read
__psLive.workOrderTechnicians       read
__psLive.workOrderAssign            WRITE — assignment only
```

**There is no completion write.** The door renders `d.proof.satisfied` and
displays *"Photo required before close."* — it reports the gate; it cannot pass
it.

### 4.1 What this does to deployment step 1

The plan's step 1 said *"the app stops calling the legacy completion path
first."* Taken literally, that would leave a signed-in operator with **no way to
complete any work order**, because the canonical service has no app surface.

That is not an acceptable intermediate state on a live operator surface (§19–20).

Under the Option A ruling (§4.2) the resolution is not to give the app a
completion surface but to **keep the legacy control working until the technician
lane is phone-verified, then remove it**. See
[`RELEASE_0_IMPLEMENTATION_PLAN.md`](RELEASE_0_IMPLEMENTATION_PLAN.md) §5.1
steps 3–5: the legacy done-path stays untouched through step 3, phone
verification is step 4, and removal is step 5.

### 4.2 The deeper dependency

`claimCompletion` evaluates **preserved attachments**. Attachments are created
by the technician SMS lane (`work_order_proof_attachments.source_comm_event_id`
ties each to an inbound message), not by the operator app — which, per §3, has
no upload pipeline at all.

So canonical completion depends on the SMS technician lane, which
`THREAD_HANDOFF.md` records as **deployed and browser-verified but NOT
phone-verified**. Production holds **zero** attachment rows, which is consistent
with that lane never having been exercised against a real handset.

**Release 0 cannot deliver a working canonical completion path on the operator
surface unless one of these is true**, and choosing between them is an owner
decision, not an engineering one:

```text
a  the SMS technician lane is phone-verified and becomes the evidence source,
   with the operator completing from evidence the technician texted in;

b  the app gains a real upload pipeline, so an operator can produce a genuine
   classified attachment;

c  Release 0 ships the schema, writer and reader, and the operator-facing
   completion surface follows in a named later slice — during which no new
   completion occurs through any path.
```

**RULED 2026-08-06 — OPTION A.** The technician SMS lane is the canonical
completion-evidence source for Release 0. No operator-app upload pipeline is
built in this release, and the app does not independently declare a repair
complete. The SMS lane must be phone-verified before the legacy app completion
control is removed. See `RELEASE_0_IMPLEMENTATION_PLAN.md` §5.0 and deployment
steps 4–5.

Consequence for §5 below: call site 1 is **removed**, not redirected. There is
no canonical completion surface in the app to route it to.

---

## 5. What must change in the app, by call site

| Call site | Change | Deployment step |
|---|---|---|
| 1 `closeoutDone` | **Removed**, with its "Mark done — close" control. Not redirected — under Option A the app does not declare completion. | step 5 |
| 2 `closeoutNotDone` | **No change.** Not a completion. Must keep working after the route's done-path fails closed. | — |
| 3 demo interceptor | Update alongside 1, so demo and live keep identical product meaning (§17). | with 1 |
| `attachStubPhoto` + `woStubPhotos` | **Removed.** No replacement in this release — evidence comes from the technician exchange. | step 5 |
| `workOrderPanel` closeout block | One panel serves all seven entry points, so there is one change, not seven. Keeps the not-done controls; loses the done control. | step 5 |

---

## 6. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This audit | 1 — permanent record | Never removed. It is the source-derived basis for the app half of the retirement sequence. |
| `attachStubPhoto` + `woStubPhotos` | **4 — retired** | Removed at deployment step 5, after phone verification. Must never feed a proof evaluation. |
