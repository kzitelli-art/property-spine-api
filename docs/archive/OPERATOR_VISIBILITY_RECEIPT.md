# Operator work-order visibility — PROOF RECEIPT

**Status: PROVEN through real PostgreSQL 16.13, real HTTP, and a real browser.**
Not merged, not deployed, not production-active, not real-phone verified.

| Proof | Result | Exit |
|---|---|---|
| `work_lifecycle_browser_proof.browser.js` — **real Chromium + real API + real DB** | **42/42** | 0 |
| `technician_lifecycle_proof.db.js` | 51/51 | 0 |
| `technician_route_proof.db.js` · `technician_acceptance.db.js` · `operations_reply_policy.db.js` | 48/48 · 32/32 · 32/32 | 0 |
| `communication_lines_slice_a.db.js` · `property_line_hardening.db.js` · `migration_ledger_inverse_gate.db.js` | 61/61 · 41/41 · 24/24 | 0 |
| `npm run verify` (7 source gates) | PASS | 0 |

Screenshots: `docs/screenshots_work_order_visibility/`

---

## 1. A read, not a second status layer

`src/surfaces/work_order_status_read.js` derives everything from rows that
already exist — `work_orders`, `obligations`, `work_order_progress`,
`work_order_proof_attachments`, `comm_events`. It writes nothing, stores no
status and maintains no timeline, so it cannot disagree with the technician's
own receipt.

It hangs off the **existing** surface: `GET /operator/work-orders/status` and
`GET /operator/work-orders/:id/status`, behind the same `operatorGate`. No new
dashboard, no conversational UI. Property scope is the session's and is passed
*into* every query rather than checked afterwards, so a work order at another
property returns 404 rather than a filtered row.

The list and the detail call the same derivation, so a board chip and a detail
panel can never disagree about what state a work order is in.

---

## 2. What the operator actually sees

**Screenshot 3 — completion refused for missing proof** is the one that shows
the whole discipline at once:

```
Unit 302 sink leak
  [Completion claimed]  Dana Reyes  [Proof needed]
  Obtain repair photo before completion

CURRENT
  [Completion claimed]  Dana Reyes
  No access reported · 12:54 AM
  Accepted 12:54 AM
  On the way 12:54 AM
  [UNVERIFIED CLAIM] the leak is stopped but it needs a valve — Dana Reyes
  Technician says finished · 12:54 AM — not closed

NEXT
  Obtain repair photo before completion

PROOF
  Photo still required before completion

RESIDENT UPDATES
  12:54 AM  Your technician is on the way for the sink leak.        [SENT]
  12:54 AM  The technician could not access the unit…               [SENT]

HISTORY
  12:54 AM · Dana Reyes said the work was finished
  12:54 AM · Dana Reyes reported: the leak is stopped but it needs a valve
  12:54 AM · Dana Reyes reported no access
  12:54 AM · Dana Reyes reported on the way
```

Four things that are never the same chip, and are not on this screen:
**Scheduled** (grey), **Completion claimed** (violet), **Proof** (green),
**Completed** (green + "Closed"). A finding carries a literal `UNVERIFIED
CLAIM` tag. `UNASSIGNED` is a word on the screen, in amber, not a blank.

**Screenshot 5** is the resident block on its own, and it is the point of the
whole receipt separation:

```
12:55 AM  Your technician is on the way for the sink leak.   [SENT]
12:55 AM  The technician could not access the unit…          [SENT]
12:55 AM  The repair has been completed.                     [FAILED]
```

The work completed. One resident text did not arrive. Both facts, side by side,
neither implying the other. `prepared` / `sent` / `delivered` / `failed` /
`unknown` are five distinct states, and `unknown` is never rounded up.

---

## 3. Everything that was required to be proven

| Required | Proven by |
|---|---|
| acceptance appears without manual refresh or duplicate entry | the lifecycle is driven through the **real inbound-SMS route**; nothing is seeded into the projection |
| on-my-way and no-access appear in order | asserted on the rendered DOM's own ordering |
| findings remain visibly unverified claims | `UNVERIFIED CLAIM` tag asserted in the browser |
| failed photo preservation does not show proof | `proof-missing` present, `proof-ok` absent, and "1 photo received but not preserved" shown |
| stored evidence appears only after durable storage | `proof-ok` appears only after the fetch succeeds |
| completion remains open while proof is missing | state stays `Completion claimed`, "not closed" on screen |
| governed completion closes the same work order | `Closed … by Dana Reyes` on the same id |
| resident intent and delivery state remain separate | a genuine **mix** of SENT and FAILED is required |
| unauthorized read fails | 401 |
| cross-property read fails | 404, never a leaked row |
| a client-supplied `property_id` is refused | 400 |
| API failure shows unavailable, never fixtures | real content rendered first, then forced to fail: prior content **gone**, unavailable visible, no sample work, and not an honest-empty either |
| honest empty | "No work orders at this property" when the property genuinely has none |

---

## 4. ⚠ Three defects this round found in my own work

**1. The language rule you flagged was a real bug, not just wording.**
`residentUpdateQueued` was computed from the *derivation* decision, before the
intent row was inserted — a prediction. If the insert then failed, the
technician had already been told the resident would be notified. The intent is
now written first, inside a savepoint, and the receipt is told what actually
exists. A failed intent does not roll back the field fact; the technician is
told *"The work is recorded, but I couldn't prepare the resident update."*

**2. Every resident update showed FAILED, and my assertion passed anyway.**
The browser harness never set `SMS_SEND_MODE`, so every resident send was
refused by the eligibility gate before reaching the transport. "A failed
delivery is shown as failed" went green for entirely the wrong reason. The gate
is real and is now *satisfied* rather than bypassed, and the assertion requires
a genuine **mix** — a blanket refusal can no longer pass it.

**3. "No access reported" was still on screen for a completed work order.**
`current.blocked` was derived from the row existing rather than from the
current state, so a 2:14 no-access sat under a 4:40 completion. It is now tied
to the derived state, so the chip and the line cannot disagree. The history
still holds it, which is where it belongs.

Also fixed: screenshots 4 and 5 were byte-identical — two copies of one page
presented as two pieces of evidence. Screenshot 5 is now the resident block
itself.

---

## 5. The exact remaining path

Nothing below is shortened by anything above. In order:

### 1 · Full-schema resident proofs — **BLOCKED, needs an operator**
`resident_sms_work_order_proof.js` and `resident_sms_route_proof.js` build no
schema of their own. The chain still cannot rebuild from empty — re-confirmed
this session against real PostgreSQL 16.13:

```
STOPPED at 012_bank_intake.sql
   column "yardi_code" does not exist
```

**Needs:** a disposable branch of production.
**Packet:** `docs/UNBLOCK_2_FULL_SCHEMA_HARNESS_DATABASE.md` (also covers
repairing the two unguarded harnesses, a merge requirement).

### 2 · Migration activation sequence — **BLOCKED, needs an operator**
`main` cannot boot today: 129 is in the build and in no ledger.

| Step | Migration | Packet |
|---|---|---|
| a | **129** activated in production | `docs/UNBLOCK_1_MIGRATION_129_ACTIVATION.md` |
| b | Slice A merged, then **130** released | `docs/SLICE_A_COMMUNICATION_LINES_RECEIPT.md` |
| c | **131 → 132 → 133 → 134** released in order, each with a fresh `EXPECTED_LEDGER_CEILING` | this branch |

Re-verify 130–134 are still free across all branches immediately before merge.

### 3 · Merge
Requires 1 and 2 complete, the branch reconciled with current `main` **by
merge**, and **every** proof re-run at the exact SHA that merges — local, DB,
HTTP and browser. Proof does not transfer to a tip by assumption.

### 4 · Controlled real-phone acceptance
One operations line, one property line, one consenting technician, one
consenting resident. Not attempted, not scheduled, and the only rung after it
is production use.

---

## 6. Current proof statement

> Technician lifecycle and operator visibility built and proven through
> isolated PostgreSQL 16.13, real HTTP and a real browser on stacked branch
> `claude/conversational-seams-and-technician-loop`.
> **Not merged, not production-active, not real-phone verified.**

Browser verification is now genuine for the operator surface. It is *not*
production browser verification — the app was served locally against a scoped
schema, not the deployed artifact against production.
