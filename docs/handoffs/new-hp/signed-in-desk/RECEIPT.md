# The signed-in Management desk, against canonical Greenery

2026-09-18 · owned disposable PostgreSQL 16 + real HTTP + real Chromium.
**No production writes.** Everything below is a measurement, not an argument.

```
API   3111edb13e3bb61669ab3ce7d011a0d36a624a80   (claude/rentroll-grain-refusal-20260918)
app   15d8bffe7f41a344a2e11cc85328a297d518ab4c   (claude/leasing-basis-asked-not-assumed-20260918)
DB    spine_proof_e54051f7b4a1e6720322e249 · ledger ceiling 200
```

## How the runtime was built

Organization, property **shell**, staff user and assignment were seeded in SQL —
environment only. **No position, space, unit or lease was written by hand.**
Every one of them came through the governed Deal Setup path over real HTTP:

```
200  POST /auth/sms/start                          real OTP, fake carrier transport
200  POST /auth/sms/verify                         → staff session
200  GET  /deal-setup/deals                        find the deal by MEMBERSHIP
200  POST /deal-setup/deals/:d/properties/:p/source    the real August CSV, 12,996 bytes
200  POST /deal-setup/deals/:d/properties/:p/activation
200  POST /deal-setup/activations/:a/preview-source     105 rows · basis bed · 105 identities
201  POST /deal-setup/activations/:a/read-source        staged 105 · needs_review 0 · vacant 10
     POST /deal-setup/proposals/:id/confirm  × 105      the human review, one per position
201  POST /deal-setup/activations/:a/establish          positions_established 105 · unresolved 0
```

The property was created with `leasing_basis = 'bed'`. `properties.sms_number`
refused a direct write ("READ-ONLY PROJECTION") and had to be written through
`communication_lines` — the schema defending its own model, correctly.

## 1 · The signed-in path, not preview

The app is **never edited**. It stays sealed to `https://property-spine-api.onrender.com`;
only the transport is redirected (`--host-resolver-rules` → a loopback TLS front →
the owned API), which is what `tools/browser_stack.js` exists to allow.

Sign-in was driven through the real gate: type the number, click **Send code**,
read the six digits out of the fake carrier log, type them, click **Verify**.

```
entry gate showing before sign-in          yes  (no ?preview=1 door)
gate closed after verify                   yes
_rrSignedIn()                              true      → every fixture path is closed by it
_rrTruthDoc()                              null      → the spreadsheet cannot be the spine
__RENT_ROLL_LIBRARY.greenery                97 rows  → present in the page, NOT the source
rentRollFor() under the session            105 rows
sessionMeta().property_id                  22222222-…-222222222222   (server-derived)
```

**Every API call the signed-in app made**, captured from the browser:

```
200  POST /auth/sms/start
200  POST /auth/sms/verify
200  GET  /operator/properties        (×2)
200  GET  /operator/obligations?status=open
200  GET  /operator/rent-roll
```

That list is itself a finding — see §4.

## 2 · The row spine (asserted before any percentage)

```
/operator/rent-roll/units   rentable_positions  105    units 64
opening baseline            positions_established 105  unresolved 0
browser rentRollFor()                            105 rows
browser rentRollStats().residential              105
```

**105 canonical rentable positions reach the signed-in desk.** Not 97, not 64,
not 171. The stop condition is satisfied.

## 3 · Current occupancy — ⛔ THE FIRST DISAGREEMENT

Four answers to one question, all from the same runtime at the same instant:

| source | occupied |
|---|---|
| `/operator/rent-roll/units` | **95** (+ open 10) |
| `/operator/rent-roll/canonical` | **94** contractually_occupied (+ vacant 10 + occupied_terms_not_established 1) |
| `/operator/rent-roll` — *the route the app actually calls* — its own `summary` | **0** (`current_occupancy_pct: 0`, `canonical_rows: 94`) |
| the Management desk | **95 of 105 = 90%** |

**The desk does not read a canonical state. It computes `total − vacant`.**
Proven by executing the app's own helpers against the live rows:

```
rows                                         105
browser "occupied" (not vacant, not non-rev)  95
browser "vacant"                              10
browser occupied === total − vacant           TRUE
server rows carrying canonical.current         94
```

**The mechanism.** On `/operator/rent-roll`, `row.status` carries the
**resident id**, not a lifecycle word:

```
row.status distinct values        96
rows whose .status is "s0004577"-shaped   95 of 105
rows whose .status is a lifecycle word    10   (the vacant ones)
_rrStatus() returns                ["s0004577","s0004657","s0006329", …]
```

So `_rrStatus()` can never return `current` or `notice`. The browser's status
vocabulary is dead: it can only detect *vacant*, and everything else falls
through to "occupied." **A notice position would be counted as occupied.** The
server's own summary on that same route reads `occupied: 0` for exactly the
same reason — it cannot match a word either.

One underlying defect (a column carrying a resident code) produces three wrong
numbers. The desk's 95 *looks* right only because 105 − 10 happens to equal
`/units`' answer today.

**Named instance:** `1325-107 Room2` — the desk counts it occupied; the server
has **no `canonical.current` lease** for it. It is the one
`occupied_terms_not_established` position, silently absorbed into Occupied.

Also recorded: **Needs Review 0 and Not Established 0** — nothing is hiding in
those buckets, so this is a classification defect, not a silent-vacancy one.
Trusted contractual rent reconciles to the source document exactly: **$101,200**.

## 4 · Forward occupancy — the browser RE-DERIVES, it does not present

Desk, signed in: **`≥86.7%` · "Contracted as of 120 days · 4 of 105 unresolved,
not yet projectable"**, horizon **2026-12-29**.

```
browser snapshot @ 2026-12-29   projectedOccupied 91 · uncovered 14 · unresolved 4 · denominator 105
server /future-facts @ same     covered_unproven  91 · open_or_uncovered 14
```

The numbers agree. **But the browser never called the canonical forward read.**
`did the browser call /future-facts? — false`, and the network log above shows
it: the signed-in app calls `/operator/rent-roll` and nothing else. It
re-aggregates the per-row `canonical` blocks with its own
`_rrForwardPosition` / `_rrForwardSnapshotAt`.

**Fairness requires the rest of the measurement.** The derivation was checked
against the canonical server at three further dates spanning the whole
lease-expiry cliff:

| as_of | browser occupied / uncovered / unresolved | server covered / open / terms-not-est | |
|---|---|---|---|
| 2026-12-01 | 94 / 11 / 1 | 94 / 11 / 1 | AGREE |
| 2027-02-01 | 85 / 20 / 10 | 85 / 20 / 10 | AGREE |
| 2027-08-01 | 0 / 105 / 95 | 0 / 105 / 95 | AGREE |

So the acceptance condition **fails structurally, not numerically**: the headline
is an independently derived answer that agrees at every date tested. The
accurate characterisation is that the **server owns the per-position facts and
the browser owns the aggregation** — two implementations of one model, which is
the thing "one truth, multiple surfaces" forbids, even while they agree.

The server is also explicit that a *projection* is not on offer:

```
/future-facts note: "Contractual facts only. Expected projections are unavailable
                     until governed pricing and assumptions are published."
projections_unavailable: { reason: "no_governed_pricing_or_assumptions",
  requires: [published property pricing version, approved assumption set,
             lease origin classification] }
```

The desk nonetheless renders a forward occupancy percentage.

## 5 · Unknown is distinct from zero — all three cases, on real data

```
partially projectable   ≥86.7%   4 of 105 unresolved, not yet projectable   ← the live desk
fully projectable       88.4%    no ≥, no unresolved claim                  ← unit-proven
nothing projectable     ≥0.0%    97 of 97 unresolved                        ← the demo shape
```

**Called out as required:** `≥0.0%` is a lower bound and **not a useful occupancy
measurement**. When the entire denominator is unresolved the honest render is
probably *Not projectable*. Presentation deliberately NOT reopened in this rung —
the real data produced the partial case, not the empty one, so nothing forced it.

## 6 · One real dated transition

Position **1325-101 Room1** (Zenia Mitchell), lease 2026-07-27 → **2026-12-31**,
read from the same canonical position at four dates:

| as_of | that position's tenancy_state | portfolio contractually_occupied | vacant |
|---|---|---|---|
| 2026-09-18 | contractually_occupied · evidence confirmed | 94 | 10 |
| 2026-12-01 | contractually_occupied | 94 | 10 |
| **2027-02-01** | **occupied_terms_not_established** · evidence uncorroborated · contributes_trusted_rent **false** | **85** | 10 |
| 2027-08-01 | occupied_terms_not_established | **0** | 10 |

**This is the student-housing thesis working on the server.** The same position
changes state as its term runs out; the portfolio walks 94 → 85 → 0 across the
school year; and **vacant stays 10 at every date** — Open is a positive
classification, never a residual.

The browser's forward aggregation respects the transition (table in §4).

### ⛔ A SECOND SERVER-SIDE FINDING

`/operator/rent-roll/units` **is not a dated read.** It echoes `as_of` and
returns the same numbers forever:

```
as_of        /units occupied  open   |  /canonical occupied  terms_not_est
2026-09-18        95        10       |       94             1
2026-12-01        95        10       |       94             1
2027-02-01        95        10       |       85            10
2027-08-01        95        10       |        0            95
```

`/canonical` and `/future-facts` move together and agree. `/units` does not move
at all. Any consumer that treats `/units` as the dated answer gets today's
picture at every horizon.

## 7 · NOI stays blank, and does

```
Current NOI    —   "Current financials not connected"
Trending NOI   —   "Not yet supplied · contracted rent + market rent on uncovered
                    stock at a stated occupancy, less in-place expenses"
```

Both cells are `cell(label, null, note)` in source — hardcoded null, so they can
never be populated by accident. Nothing was estimated from rent-roll data.
Untouched by this rung.

## What this rung changed in the product

**Nothing.** One harness-infrastructure fix was required to run it at all:
`tools/browser_stack.js` answered a CORS preflight by destroying the upstream
request, which emits `error`, and the handler then wrote a 502 over a sent
response — `ERR_HTTP_HEADERS_SENT` took the whole TLS front down on the app's
first cross-origin POST. An error handler that cannot run after the response has
begun is not an error handler. Fixed; class 3, harness only.

## The first disagreement, and where to stop

**Current occupancy.** The desk's 95 is `total − vacant`, not a canonical state,
because `/operator/rent-roll` ships the resident id in `row.status`. Fix the
column before anything downstream, and do not patch toward visual agreement —
the number is right today by arithmetic coincidence.

The forward finding is structural and second in line: the desk should read
`/operator/rent-roll/canonical` or `/future-facts` at the horizon it displays
instead of re-aggregating, and `/units` should either honour `as_of` or stop
accepting it.
