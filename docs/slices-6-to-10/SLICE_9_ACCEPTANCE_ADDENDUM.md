# SLICE 9 — ACCEPTANCE ADDENDUM

Four acceptance items. **No product functionality is added here.** Nothing was
implemented in response to item 2; it is reported and escalated.

---

## 1 · MIGRATION 125 CUSTODY — RESOLVED, NO CONTRADICTION IN THE ARTEFACT

The contradiction was in **my wording, not in the repository.** "0 files under
`deployment_b`" was a count of files **changed by my commits**, not a count of
files existing. Stated as an existence claim it was wrong. Git evidence:

| Question | Evidence |
|---|---|
| Path | `docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql` |
| Blob SHA at `795e461` (pre-work) | `7c3f011bbd7c91df1dea39879ab5281bc5e44112` |
| Blob SHA at final HEAD `b62976a` | `7c3f011bbd7c91df1dea39879ab5281bc5e44112` |
| Exists at final HEAD? | **Yes** |
| Differs from `795e461`? | **No — identical blob** |
| Moved / modified / deleted? | **None of the three** |

```
git log 795e461..HEAD --name-status -- docs/slices-6-to-10/deployment_b/ migrations/
  → no output (zero commits touched either path)
git diff 795e461..HEAD -- docs/slices-6-to-10/deployment_b/ migrations/ | wc -l
  → 0
```

**125 is where it was, byte-for-byte. Nothing was restored, moved or edited.**

---

## 2 · INTENDED-MOVE-IN AUTHORITY — A REAL SEMANTIC HOLE. STOP CONDITION 1.

### Where submission receives the governed date

**It does not.** Proven, not asserted:

- `resolveSubmissionTarget` does not accept `intended_move_in` — it has no
  parameter for one and passes none onward.
- `application_invitations` has **27 columns and none of them holds an
  intended move-in date** (`id, token_digest, conversion_id, person_id,
  property_id, unit_id, lease_application_id, progress_obligation_id,
  dispatch_source, channel, recipient_snapshot, provider_message_id,
  sent_by_user_id, sent_at, sent_note, status, revoked_by_user_id, revoked_at,
  revoked_reason, expires_at, consumed_at, created_by_user_id, created_at,
  updated_at, dispatch_comm_event_id, superseded_by_invitation_id,
  leasing_lead_id`).

The date exists only as a **request parameter at preparation time**. It reaches
no durable row. I did not hide it in captured JSON, notes, events, metadata or
labels — verified by the drift guard and by the Commit B assertion that no
column on the invitation holds the resolved space either.

### The exact implemented behaviour, measured

| Case | Preparation | Submission |
|---|---|---|
| `marketable_now`, no date | **PERMITTED** | **PERMITTED** |
| `upcoming`, **no** date | **REFUSED** `intended_move_in_required` | **PERMITTED** |
| `upcoming`, date **after** `available_from` | **PERMITTED** | **PERMITTED** |
| `upcoming`, date **before** `available_from` | **REFUSED** `not_ready_by_intended_move_in` | **PERMITTED** |
| `turnover_required`, date supplied | **REFUSED** `availability_date_not_governed` | **PERMITTED** |
| target taken between prep and submit | REFUSED `not_offerable` | **REFUSED** `application_target_no_longer_offerable` |
| target became multi-space between prep and submit | REFUSED `space_grain_not_supported` | **REFUSED** `application_target_became_ambiguous` |

### The finding

**Submission applies a strictly weaker offerability standard than preparation,
in three of the six cases above.** This is visible in the matrix in §3: six of
twenty rows read `refused` at preparation and `permitted` at submission.

A consequence worth naming: `turnover_required` can **never** be prepared —
`availableFrom()` returns `null` for that state by design, so
`availability_date_not_governed` always fires — yet submission permits it
unconditionally. A state that is unreachable at preparation is reachable at
submission.

My Commit C reasoning ("one allowlist used twice, not a second ladder") was a
fair description of the *mechanism* and an **inadequate description of the
consequence**. Two boundaries applying different standards is exactly what the
brief forbids, whatever the shared code path.

### Why it cannot be closed inside this cut

Closing it truthfully requires submission to reproduce preparation's governed
decision. That needs the governed `intended_move_in` to survive on
`application_invitations` — **new durable lineage, therefore a migration**,
which this cut forbids.

> **STOP CONDITION 1 TRIGGERED** — *"A targeted application path cannot call the
> resolver without a new schema field or migration."*
>
> The forward-offer path can call the resolver at preparation but cannot
> reproduce its governed decision at submission without a new schema field.

### RULING TAKEN — option 1, narrowing (owner, after this addendum)

Targeted application invitations are supported **only** when the canonical
marketing state is `marketable_now`. Implemented in the corrective commit; the
truth table below is superseded by §2A.

### Rulings that were available

Reported for your decision, not improvised:

1. **Narrow the slice to offerable-now.** Remove `upcoming` and
   `turnover_required` from the preparation allowlist. Preparation and
   submission then apply an identical standard with no stored date. Forward
   offers stop being supported until the bridge migration lands. *This is the
   only option that closes the hole without a migration.*
2. **Persist `intended_move_in` on `application_invitations`.** Requires the
   forbidden migration; naturally belongs with the parked
   invitation → submission → birth bridge.
3. **Accept the asymmetry explicitly**, with the weaker submission standard
   documented as governed product behaviour rather than an oversight.

---

## 2A · POST-RULING BEHAVIOUR — ONE RULE, BOTH BOUNDARIES

| Case | Preparation | Submission |
|---|---|---|
| `marketable_now` | **PERMITTED** | **PERMITTED** |
| `marketable_now`, still valid at first submission | — | **PERMITTED** |
| `upcoming`, **no** date | REFUSED `future_application_target_not_supported` | REFUSED `future_application_target_not_supported` |
| `upcoming`, **any** date | REFUSED `future_application_target_not_supported` | REFUSED `future_application_target_not_supported` |
| `turnover_required`, **any** date | REFUSED `future_application_target_not_supported` | REFUSED `future_application_target_not_supported` |
| ceased to be `marketable_now` before first birth | — | REFUSED `application_target_no_longer_offerable` |
| became multi-space before first birth | — | REFUSED `application_target_became_ambiguous` |
| multi-space / zero-space | unchanged | unchanged |
| previously completed birth | — | **idempotent, not re-evaluated** |
| untargeted | unchanged | unchanged |

**Two codes, deliberately distinct.** A future-dated state was never
supportable, so reporting it as *no longer* offerable would falsely imply the
target changed. A unit that was `marketable_now` and has since been taken
genuinely did change, and says so.

**The refusal describes the lineage limitation, never the position:**
*"Application links for a future availability date are not supported yet. This
unit is not available today, and an application record cannot yet carry a
future-dated target through to the lease."* The position may be genuinely coming
available on a governed date; claiming it is unavailable would be a
confident-wrong statement about supply.

**Submission may be stricter, never weaker** — asserted exhaustively over every
seeded position, not by inspection: no unit is refused at preparation and
permitted at submission.

`intended_move_in` is threaded nowhere and persisted nowhere. `upcoming` and
`turnover_required` remain canonical availability states;
`availability_read.js` is untouched by the correction.

---

## 3 · CROSS-DOMAIN MATRIX — ALL 20 × 9 CELLS

Produced by `tests/scenarios/slice9_cross_domain_matrix.js`, which now prints every
domain. `38/38` is the assertion count; **this table is the coverage.**

| # | Scenario | Application target | Invitation | Submission | Packet | Future commitment | Marketing | Turn priority | Economic tenancy | Refusal reason |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | sole-space marketable | eligible | permitted | permitted | N/A¹ | none | marketable_now | no_turn_in_progress | none | — |
| 2 | sole-space upcoming, governed date | intended_move_in_required | refused | **permitted** | N/A¹ | none | upcoming | no_turn_in_progress | active | intended_move_in_required |
| 3 | sole-space turnover, unknown date | intended_move_in_required | refused | **permitted** | N/A¹ | none | turnover_required | raw_vacancy | none | intended_move_in_required |
| 4 | multi-space unit | space_grain_not_supported | refused | application_target_became_ambiguous | N/A¹ | none | marketable_now | no_turn_in_progress | none | space_grain_not_supported |
| 5 | zero-space unit | application_target_unconfigured | refused | application_target_unconfigured | N/A¹ | N/A² | N/A² | no_turn_in_progress | N/A² | application_target_unconfigured |
| 6 | approved application, no lease | intended_move_in_required | refused | **permitted** | no_open_terms_or_activation_gate | none | turnover_required | raw_vacancy | none | intended_move_in_required |
| 7 | lease-ready application, no lease | intended_move_in_required | refused | **permitted** | no_open_terms_or_activation_gate | none | turnover_required | raw_vacancy | none | intended_move_in_required |
| 8 | packet-eligible application | N/A³ | N/A³ | N/A³ | **eligible** | N/A³ | N/A³ | no_turn_in_progress | N/A³ | — |
| 9 | packet-ineligible historical approval | N/A³ | N/A³ | N/A³ | application_terminal | N/A³ | N/A³ | no_turn_in_progress | N/A³ | — |
| 10 | pending future lease | intended_move_in_required | refused | **permitted** | N/A¹ | pending | turnover_required | pending_commitment | none | intended_move_in_required |
| 11 | locked future lease | not_offerable | refused | application_target_no_longer_offerable | N/A¹ | locked | successor_locked | committed_start | active | not_offerable |
| 12 | activation-pending lease | not_offerable | refused | application_target_no_longer_offerable | N/A¹ | none | activation_pending | no_turn_in_progress | none | not_offerable |
| 13 | active economic tenancy | not_offerable | refused | application_target_no_longer_offerable | N/A¹ | none | occupied | no_turn_in_progress | active | not_offerable |
| 14 | cancelled future lease | eligible | permitted | permitted | N/A¹ | none | marketable_now | no_turn_in_progress | none | — |
| 15 | overlapping leases | not_offerable | refused | application_target_no_longer_offerable | N/A¹ | pending | contested | conflicted_commitment | active | not_offerable |
| 16 | wrong-property lease | not_at_property | refused | not_at_property | N/A¹ | N/A² | N/A² | no_turn_in_progress | N/A² | not_at_property |
| 17 | wrong-space lease (sibling bed committed) | space_grain_not_supported | refused | application_target_became_ambiguous | N/A¹ | none | marketable_now | no_turn_in_progress | none | space_grain_not_supported |
| 18 | pending turn with pending successor | intended_move_in_required | refused | **permitted** | N/A¹ | pending | turnover_required | pending_commitment | none | intended_move_in_required |
| 19 | completed turn with locked successor | not_offerable | refused | application_target_no_longer_offerable | N/A¹ | locked | successor_locked | **no_turn_in_progress** | none | not_offerable |
| 20 | prepared sole-space, then became multi-space | space_grain_not_supported | refused | application_target_became_ambiguous | N/A¹ | pending | successor_pending | no_turn_in_progress | none | space_grain_not_supported |

**N/A justifications** — every one is a stated reason, not a blank:

- **¹ no application under test.** The scenario exercises a *position*; there is
  no application row whose packet eligibility could be assessed.
- **² no classified position at this property.** Row 5 has zero spaces, so the
  canonical read produces no position. Row 16's unit belongs to another
  property, so this property's availability read does not cover it — that
  absence *is* the property-wall answer.
- **³ scenario is about an application, not a position.** Rows 8–9 carry no
  `unit_id`; the position-shaped questions have no subject.

**What the table shows beyond the count:**

- Six rows (2, 3, 6, 7, 10, 18, in bold) refuse at preparation and permit at
  submission — **the §2 asymmetry, now visible per-scenario.**
- Row 19: a **completed** turn is absent from the ranking while its **locked**
  commitment is still reported. The domains are genuinely independent.
- Rows 12 and 13 separate commitment from tenancy: activation-pending is
  committed but economically inactive.
- 14 of 20 scenarios refuse. UNSUPPORTED, CONFLICT and N/A are ordinary
  outcomes, not gaps.

---

## 4 · PROOF CLASSIFICATION — HONEST LEVEL

### Acknowledged limitations

1. **The proof database required local-only intervention.** The canonical
   migration chain **cannot** build a database from empty. It stops at 012
   (`vendors` defined incompatibly in 001 and 012), then at 083/084
   (self-recording migrations carrying their own `commit;`), then at 087 and
   110 (data-correction migrations hardcoded to production UUIDs that no empty
   database can satisfy). Reaching 124 applied migrations required dropping one
   stale table, reconciling two ledger rows, and seeding a QA property, a QA
   user, a team assignment and two governed charges. **None of this is
   committed; the repository is unchanged.** The defect is pre-existing and
   documented; this cut did not repair it and was not asked to.
2. **Several required regression suites still crash**, all verified identical at
   `795e461` before my first commit: `slice9_lifecycle_authority_proof` (incl.
   `UNDER_125=1`), `slice9_lifecycle_concurrency_proof`,
   `slice9_operating_timezone_proof`, `rent_roll_institutional_proof`;
   `rent_roll_canonical_proof` 33/5; `resident_sms_route_proof` 23/8;
   `test_conversion_rail.db` refuses to run against this database by design.
3. **Deployed request logs were unavailable.** Route retirement rests on the
   repository census alone.
4. **No PR, merge, deployment or browser acceptance occurred.**

### Highest honest level per the project ladder

> Reported → Locally exercised → Built-but-dormant → **Proven** (real DB + real
> HTTP) → **Browser verified**

| Scope | Highest honest level | Why not higher |
|---|---|---|
| Source changes (A–I) | **Source-complete** | — |
| Real-Postgres service proofs | **Locally exercised** | real schema and real writes, but on a database the chain could not build unaided |
| API behaviour | **Locally exercised** | **no HTTP proof ran.** Every HTTP block skipped for want of `API_BASE` / `STAFF_SESSION`. Service functions were called directly. |
| App behaviour | **Locally exercised** | static source assertions only; no browser, no rendered surface |
| Route retirement | **Locally exercised** | repository census only; no deployed-log confirmation |
| **The complete A–I cut** | **Source-complete and locally exercised · NOT deployment accepted** | |

**No part of this cut is `Proven` under the project's formal vocabulary**, which
requires real DB **and** real HTTP. My earlier handoff used "proof" loosely for
harness totals; corrected here. **The repository is not green** and this cut is
not deployment-proven.

---

## STATUS

Items 1, 3 and 4 close cleanly. **Item 2 is open and requires an owner ruling**
— stop condition 1 is triggered and no option was taken unilaterally.

Migration 125 not moved · no migration · no PR · no merge · no deployment ·
Slice 10, the renderer and the appointment-journey builder untouched.
