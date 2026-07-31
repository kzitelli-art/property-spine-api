# Slice 7 — Market & Pricing Workspace: CLOSURE

**Date:** 2026-07-31
**Status:** `SLICE 7: CLOSED` · `SLICE 8: AUTHORIZED`

Slice 7 built the permanent commercial-control workspace as **composition, not
new economics** — every fact is a server read rendered as-is. Live-proven
end-to-end against production.

## Build identity

| | API | App |
|---|---|---|
| Work | **none needed** — audit found concessions already ride on `/operator/pricing/effective` | Market & Pricing workspace |
| PR | — | #22 (merged) |
| Merged SHA | — | `5a2c7ac` (main) |
| Deployed | — | ✅ Render live (`ps-mk-nav` present) |

## Section maturity matrix (as shipped, live-verified)

| Section | Maturity | Live state (Demo Building, 2026-07-31) |
|---|---|---|
| **Availability** | **Live** | 1 marketable now · 0 expected within 90d · 283 total; 54 blocked-by-evidence, 7 contested |
| **Pricing** | **Live** | honest absence: "Pricing is not yet governed for this property — No governed pricing version is published…" (server verbatim) |
| **Concessions** | **Live** | "No concessions in effect — A concession becomes dated economic schedule lines…" (server detail) |
| **Rent Survey** | **Not connected** | honest panel — "Nothing here is estimated or sampled" |
| **Listings** | **Not connected** | honest panel — "No listings are implied or shown" |
| **Demand** | **Not connected** | honest panel — "No demand is modeled or invented" |

## Proof ladder — met

| Rung | Evidence |
|---|---|
| Source audit | `SLICE_7_COMMERCIAL_SOURCE_AUDIT.md` (accepted) — grounded in live DB/API |
| Render assertions | 26/26 over section renderers: pricing absence+present, concessions unavailable+present, availability, not-connected panels, per-section failure→Unavailable+Retry |
| **Browser verified** | live authenticated session drove the deployed app to Market & Pricing; all six sections captured with correct maturity labels (`Live · Live · Live · Not connected ×3`); Pricing showed the server absence verbatim; Availability showed live headline. Screenshots captured. |
| Section isolation | switching sections after one rendered leaves others intact (availability rendered after pricing); the failure→Unavailable+Retry path is proven in the render assertions (live cache prevented re-triggering the fetch in-browser, which is the loader working as designed) |
| Home reconciliation | Leasing-home Market & Pricing strip continues to read the live availability projection (marketable now / coming open) |

## Boundaries held

- **Composition, not new economics.** No governed asking-rent policy, no concession approval machinery, no survey/listing/demand ingestion (Slices 8–9).
- No fixture commercial facts signed in. Failed read = Unavailable, never empty.
- Replaced the old signed-in "Marketing is not yet connected" stub.

## Carried forward

- **Slice 8** matures governed rents + concessions. When a pricing version is published for a property, the Pricing section fills with governed asking rents (the render path already exists) and the Concessions section shows advertised policies. Slice 6's `Set renewal economics` cross-link then produces a real `proposed_rent`.
- **Slice 9** connects Rent Survey / Listings / Demand — the three honest "Not connected" panels become live.
