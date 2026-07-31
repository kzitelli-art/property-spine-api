# Slice 7 — Commercial-Source Audit (first deliverable)

**Date:** 2026-07-31
**Scope:** What each Market & Pricing section supports today, before building the
workspace. Grounded in the real routes/services and a live query of the deployed
DB + authenticated API (Demo Building, session-scoped).

> Per `07_MARKET_AND_PRICING_WORKSPACE.md`, no workspace UI is built until this
> audit is accepted.

---

## Section maturity matrix

| Section | Endpoint / service | Data source | Prop scope | Live/fixture | Read | Write | As-of | Classification |
|---|---|---|---|---|---|---|---|---|
| **Availability** | `GET /operator/leasing/availability-canonical` → `availability_read` over `space_position` | canonical positions/classifier | session | **live** | ✅ | n/a | `as_of` in payload | **live and canonical** |
| **Pricing** | `GET /operator/pricing/effective` → `effective_pricing` | `property_pricing_versions` + `pricing_terms` | session | **live** (empty for Demo) | ✅ | preview-only (dry run) | `as_of` in payload | **live but incomplete** |
| **Concessions** | `concession_policies` / `concession_authority_grants` (no dedicated operator read yet) | governed concession tables | session (by property) | **live** (empty for Demo) | partial | n/a | — | **live but incomplete** |
| **Rent Survey** | — | — | — | — | — | — | — | **not implemented** |
| **Listings** | — | — | — | — | — | — | — | **not implemented** |
| **Demand** | — | — | — | — | — | — | — | **not implemented** |

---

## Section-by-section

### Availability — **live and canonical** ✅
- Route `GET /operator/leasing/availability-canonical` (session-scoped, `requireLeasingModuleAccess`), reads the shared `space_position` classifier via `availability_read`.
- **Live payload (Demo, 2026-07-31):** `count: 283`, `headline: { marketable_now: 1, expected_within_horizon: 0, blocked_by_evidence: 54, contested: 7 }`, plus a full `states` breakdown (occupied 165, successor_pending 49, down 4, evidence_disagrees 54, …).
- Provenance: canonical positional derivation — the same one Renewals (Slice 6) and Current Rent Roll read. Do **not** change the classifier (spec rule) absent a separately-proven defect.
- **This is the workspace's live foundation.** Home summary `marketable now / coming open` come straight from `headline`.

### Pricing — **live but incomplete** ⚠️
- Rich route set already exists: `/operator/pricing/effective`, `/authority`, `/decision-packet`, `/publication-preview` (dry-run, writes nothing), `/history`, `/draft`, `/review`, `/shadow-quote`, `/future-rent-roll-preview`.
- Tables: `property_pricing_versions` (status/effective_from/effective_until/authority_basis/…), `pricing_terms`, `pricing_review_receipts`.
- **Live state (Demo):** `published_version: null`, `absence: { reason: "no_published_pricing_version", detail: "No governed pricing version is published and effective for this property on this date." }`. **0 pricing versions for Demo.**
- So the honest **"Pricing is not yet governed for this property"** state the spec asks for is **already authored at the API** — the workspace renders the `absence` verbatim. No fixture rents, no inferred asking rents.
- Write maturity: only a **dry-run preview** exists (no publish route in the runtime). Slice 8 matures governed asking-rent policy.

### Concessions — **live but incomplete** ⚠️
- Tables: `concession_policies` (scope/lease_type/concession_type/value/timing_profile/valid_from/valid_until/active/…), `concession_authority_grants`, `concession_incidents`.
- **Live state (Demo):** **0 concession policies**, **0 authority grants**. (Note from THREAD_HANDOFF: Kameron holds `may_manage_concession_authority` on Demo, but no policy is published.)
- There is no dedicated operator concessions **read** endpoint yet — concessions surface today only inside pricing/offer context. Slice 7 needs a thin read (or to project from `concession_policies`) to show effective dates / eligible units / type / amount / approval / source, and an honest **not-configured** state otherwise.
- Slice 8 owns concession approval machinery. Slice 7 only displays what's governed.

### Rent Survey — **not implemented** ⛔
- No table, service, or route (`%survey%`, `%comp%` → none). Section renders **"Not yet connected"**. No sample competitors, no fabricated rents. Slice 9.

### Listings — **not implemented** ⛔
- No table/service/route (`%listing%` → none). **"Not yet connected."** No implied syndication. Slice 9.

### Demand — **not implemented** ⛔
- No table/service/route (`%demand%` → none). **"Not yet connected."** No invented demand analytics. Slice 9.

---

## What Slice 7 builds (workspace contract)

One stable destination `Market & Pricing` with six sections, **not** six new Leasing-home cards:

1. **Availability** — render the live `availability-canonical` payload (marketable now, coming open, blocked by evidence, horizon, records). Maturity label: **Live**.
2. **Pricing** — render `/operator/pricing/effective`; when `published_version==null` show the server `absence.detail` verbatim. Maturity: **Live** (data present) or an honest not-governed state.
3. **Concessions** — project active `concession_policies` for the property; honest **not-configured** when none. Maturity: **Live** / not-configured.
4. **Rent Survey / Listings / Demand** — static **Not connected** panels. Maturity: **Not connected**.

Every section carries a visible maturity label (**Live / Advisory / Not connected / Unavailable**). One section's failed read must not erase the others (per-section Retry). No whole-workspace fixture fallback.

### Cross-link map
- Availability → Pricing context (per unit type)
- Pricing → eligible Concessions
- **Renewal / Follow-Up blocker → Market & Pricing** (Slice 6's `set_renewal_economics` already routes here — the target exists)
- Market & Pricing → supporting evidence (inert until Slice 9)
Navigation only — no writes added for convenience.

### Home-summary reconciliation
Leasing-home Market & Pricing strip continues to read the live workspace/availability projection: at minimum `marketable now` + `coming open` (today: 1 / 0). Add more facts only when their sources are live and governed.

---

## Recommendation

1. **Accept this audit.** All six sections are classified against real state; the honest not-governed / not-connected states already exist or are trivial to render.
2. Build the workspace as **composition, not new economics**: one destination, six labelled sections, Availability live, Pricing/Concessions render governed truth-or-honest-absence, Survey/Listings/Demand as Not-connected panels.
3. Hold the boundaries: no governed asking-rent policy, no concession approval machinery, no survey/listing/demand ingestion (Slices 8–9). No fixture commercial facts signed in.
4. Reuse the Slice-6 proof rig (pure render assertions + live authenticated capture) for the browser proof, including one-section-failed and all-sections-failed isolation.
