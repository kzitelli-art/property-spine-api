# Can the current onboarding writer create '(whole unit)' beside a real bed? — Fable, 2026-09-07

Return to QB task 01a076e5-512c-70c3-a237-e8ca01c528f0. Evidence branch
`claude/writer-shape-evidence-20260907`, cut from QB's `01fac5f`
(`codex/claim-relay-20260907`). **No product file edited. No patch proposed
as code.** One proof file plus this directory.

**Answer: yes.** The retained-source activation ingest, through real HTTP,
turns two current rows naming `(whole unit)` and `Room1` on the same unit
into two established, marketable, application-offerable positions, in either
row order, with no refusal and no discrepancy note. Both positions are
governed `position_kind = 'bed'`. QB's reading of the source was right: the
mixed-kind hold I proposed on `904c768` would not fire on this shape.

```text
. run1/env_all.sh                      # nonce-owned DB (migrated to ledger 192, NO pending DDL this time)
node run1/multi.js '[["mixed grain writer","tests/proofs/mixed_grain_writer_challenge.db.js"]]'
  → PASS  mixed grain writer   43 passed, 0 failed
```

Rung for section 1 and section 4: **real HTTP** against the owned server
(`POST …/source` multipart → `POST …/activation` → `POST …/read-source` →
`POST …/proposals/:id/confirm` ×2 → `POST …/establish`, then
`GET /operator/leasing/availability-canonical`, `GET /operator/leasing/leaseable-units`,
`GET /operator/rent-roll/units`). Sections 2 and 3 use the same services
directly, except the C5 and C6 controls, which also went through HTTP.
No browser. Synthetic rows only; no July or Skyline data.

---

## 1. The writer, both orders (positive witness, HTTP)

Fresh by-bed property, rows `401,(whole unit),VACANT,900` then `401,Room1,VACANT,900`;
second property with the order reversed on `402`.

| Step | Observed, both orders |
|---|---|
| read-source | 201. Two `import_source_rows`, each with `produced_unit_id` **and** `produced_space_id` set to its own label. Parse notes: "current ledger row — evidence only". No discrepancy |
| spaces after ingest | `(whole unit)` and `Room1`, **both `position_kind = 'bed'`** |
| confirm | 200 on both proposals (`401|(whole unit)`, `401|Room1`): the named label exists, so the current writer links it |
| establish | 201 |
| `datedPropertyPositions` | two positions, both `established` / `opening_claim_vacant`, both derived kind `bed` |
| Rent Roll, standing | `rentable_positions = 2` for the unit, on both readers and over the wire |
| availability | both `marketable_now` (after use type configured, see limits) |
| application authority | both `offerable`; `leaseable-units` lists both as eligible targets |

### Why the writer does this (source, confirmed by the run)

`snapshot_loader.js:928–936` builds `labelsByUnit` from the source's own
labels, including Spine's placeholder sentinel when a row names it.
`inventory_materialization.js` then sees `wantsPlaceholder = true`, skips
consumption, creates `Room1`, and the align step stamps `kind` (`'bed'`)
onto **every** wanted label, sentinel included. `INVENTORY_COUNT_MISMATCH`
cannot fire: total equals `wanted.length` by construction. The
"as many positions as the source says exist" invariant is satisfied because
the source said two.

## 2. Materialization directly

`materializeRentableSpaces(client, { labels: ['(whole unit)','Room1'], kind: 'bed' })`
on a fresh unit: accepted. Receipt
`{ consumed_placeholder: null, created: ['Room1'], kept: ['(whole unit)'], total: 2 }`.
Reverse order: same. Both rows `position_kind = 'bed'`. **No earlier
refusal exists** for this shape in the writer. Control: `['Room1']` alone
consumes the placeholder, one position.

So a hold keyed on mixed `position_kind` within a unit is defeated: the
kinds are not mixed. The label is mixed, and the label is not identity.

## 3. Controls (nonzero, all through the same writer)

| Control | Observed |
|---|---|
| C1 by-unit property, `501` | one `(whole unit)` position, governed kind **null**, confirms, establishes |
| C2 sole bed, ledger-style label `3B,Bed B` | placeholder consumed, one `Bed B` position, kind `bed`, confirms |
| C2b the e2e fixture shape pre-existing (`(whole unit)` + `Bed B`), then `3B,Bed B` read | reconciles to `Bed B`, creates nothing; the **unclaimed** placeholder reads `occupancy_unknown`. The readers already hold an unclaimed phantom; the defect needs a claim |
| C3 `701` Room1/Room2/Room3 | placeholder consumed as Room1, three positions, all `bed`, all confirm |
| C4 bed property with `801,(whole unit)` and `802,Room1`/`Room2` | accepted; 801 one position, 802 two, all confirm. **801's placeholder never passed through materialization** (its label already existed), so its governed kind is null and readers derive `unit`. Valid mixed inventory; any assertion must leave it alone |
| C5 `901` with a lease on its whole-unit position, then `901,Room1` | read-source **refused 409**: "Unit already has history recorded at whole-unit grain … Held by: leases.space_id (1)". Nothing written. Over HTTP the code arrives as `refused`; the message carries the reason |
| C6 current `1001,Room1`, then `Future Residents/Applicants`, `1001,Room9`, `1002,Room1` | one position. Room9 and unit 1002 create nothing; both rows retained with discrepancy notes |

## 4. The correction path that exists, and its first stop

On the section-1 shape after establishment:

| Attempt | Observed |
|---|---|
| 4a `materializeRentableSpaces(['Room1'])` to make the unit what the source should have said | **refused `PLACEHOLDER_NOT_PRISTINE`, held by `import_source_rows.produced_space_id (1)`.** The ingest's own lineage is the holder. Writing `position_kind` cannot resolve this; the row is referenced |
| 4b same file name, same as-of, corrected bytes | refused `already_established_from_this_file`. The idempotency key is (property, file name, as-of), not content. A same-bytes re-upload is also deduplicated by the artifact store to its first name |
| 4b corrected file under a new name, new setup | 201 read, 200 confirm, 201 establish. Second baseline supersedes the first. **The phantom is not removed**: still two positions. Under the new baseline it reads `occupancy_unknown` and `not_offerable`; Room1 stays `marketable_now`. The earlier promoted claim and the superseded baseline remain as history |

**No position-level removal writer exists** in `src/` or `server.js`
(searched for space deletion and retirement; the only delete is
`seed_snapshot.js` by batch, a seed path). `retireInventoryUnits` is
unit-level and would retire Room1 with the phantom. So today the authorized
correction is: correct the file, start a new setup, and live with a held
`occupancy_unknown` position in the denominator. That preserves history
and unknowns and creates nothing; it does not restore the count.

## Suspected overlap versus proven denominator

The proof shows the writer creates **two positions from two rows**. It does
not show that `(whole unit)` and `Room1` are the same physical space. Nothing
recorded can: labels are not physical identity, and a source that names
both has made a statement Spine cannot verify from the rows. "Five beds not
seven" for the earlier constructed case is a **suspected overlap**, not a
proven denominator. The proven fact is narrower and enough: the source
named Spine's own provisional sentinel beside a named room in one current
section, which is a grain contradiction inside the source's statement about
one unit at one as-of.

## Strongest competing explanation

The source is right and the building really has a whole-unit position and a
room in the same unit at the same time. I could not construct a lease
structure where that is true: a unit is leased whole or by position in one
as-of, and a common room is not a rentable position. If such a property
exists, the rows below reject it at read time with a named reason and the
operator can restate the grain; nothing is destroyed.

## Smallest existing-owner correction (proposed, not implemented)

Owner: `inventory_materialization.js`, which already owns
`PLACEHOLDER_LABEL` and every other refusal about this shape.

```text
in materializeRentableSpaces, after `wanted` is computed:
  if wanted includes PLACEHOLDER_LABEL and wanted.length > 1
    → refuse MIXED_GRAIN_LABELS, naming the unit and the labels:
      "The source names both the whole unit and a room for unit N.
       A unit is leased whole or by position, not both. Nothing was written."
```

Why this is the smallest and why it is not a label-as-identity rule:

- It keys on **Spine's own sentinel** (the trigger's provisional label,
  exported as a constant), not on any label a source might use. `Bed B`,
  `Room1`, `(bed)` are untouched.
- It fires **before any lineage is written**, so the C5-style holder never
  forms and the 4a dead end never arises for new loads.
- It does not fire on C1, C2, C2b, C3, C4 (801 never reaches
  materialization; `['(whole unit)']` alone has length 1), C5 or C6.
- It surfaces through the existing read-source refusal path (as C5 does),
  so the operator sees it in Deal Setup and corrects the file.
- No new writer, no reconciliation store, no row removed.

Proposed assertion for the witness/successor pair: section 1 and section 2
of this proof flip from "accepted" to "refused `MIXED_GRAIN_LABELS`, zero
spaces created, zero lineage rows", while every row in section 3 stays
green. Existing data with the shape is **not** addressed by this; that is
the read-side question QB deferred, and it now has the exact conditions:
a claimed sentinel-labelled position beside named positions in the same
unit, with governed kind `bed` or null.

## Limits

- Use type: availability refuses any position with no governed use
  (`use_not_configured`), and the ingest writes none. The proof sets
  `use_type = 'residential'` directly before the reads so they answer the
  inventory question; that is setup, stated here, not the writer.
- The proof pins current behaviour including the defect, so it is **not in
  `verify_all.sh`**; QB's repair should split it into witness/successor as
  `opening_claim_identity.db.js` is split.
- Pending claim-index DDL not applied this run; the writer path did not
  need it.
- Where I looked for a removal writer: `src/`, `server.js`. Not the app.
- The CI green on `34115475028` and the Windows July/Skyline proof were not
  re-run here and are not claimed.
