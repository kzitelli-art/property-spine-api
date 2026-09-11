# Greenery launch readiness — source trace and isolated rehearsal (2026-09-11)

Returned to HP QB. **Test and documentation only.** No production read or
write, no live message, no deployment, no product source change, no edit to
the selection or readiness lanes. The real Greenery property
(`a29181cd-…`) was not touched, and no replacement property was created
anywhere: the rehearsal property keeps one durable id from the first row to
the last.

Source: API `932c9afafccd31f75385b1a7fc17c41deda48b32`; app
`b00cf4993e4f699cd174a7ef5c8a27ca4b5507c4` read for the property selector
only (no browser rung). Doctrine read: `CLAUDE.md`, `docs/PHILOSOPHY.md`
(unchanged since 24f4482), `docs/CURRENT_STATE.md`,
`docs/DB_HARNESS_ISOLATION.md`, `docs/handoffs/new-hp/TEMPLE_IDENTITY_READ_20260911.md`,
`docs/LEGACY_INGESTION_RETIREMENT_2026-09-05.md`.

## 1. What the production read established, and what it did not

The September 11 read (raw table counts, read-only) found Greenery
`a29181cd` with 171 units, 171 spaces, 0 leases, 0 active team or work
assignments, 3 aliases, 1 activation, organization null, `leasing_basis`
unknown, `canonical_key` null (`predates_canonical_identity_requirement`).
Those are findings, not permission to rebuild. The trace below says which
service owns each gap and what closes it. None of the raw counts is
rentable inventory: on this source a position with no established
occupancy basis is `occupancy_unknown` and is never offered
(`src/surfaces/availability_read.js`, `src/tenancy/dated_positions.js`
`positionBasis`). One space per unit is the placeholder the unit trigger
creates; it is not a bed.

## 2. Source trace — the doors Greenery would pass through

| Need | Owner in source | Door | Authority | Status for Greenery (from the read) |
|---|---|---|---|---|
| Organization | `property_hierarchy_service.assignPropertyToOrganization` (adoption only, reparenting refused; migration 151 trigger) | `POST /admin/organizations/:id/properties {property_id}` | `super_admin` session; org admins are refused (`adoption_requires_platform_repair_authority`) | **Missing.** Which organization is an owner decision. |
| Deal container | `deal_service.createDeal` / `addProperty` | `POST /deal-setup/deals`, `POST /deal-setup/deals/:id/properties` | org_admin or super_admin creates; property must not belong to another client | Unknown whether Greenery sits in a current deal; the legacy activation has no deal. |
| Staff (Mike) | `super_admin.js` `/admin/organizations/:orgId/invite`, `org_admin.js` `/org/users/invite`, governed `POST /properties/:id/team-invites` + OTP accept | see findings 2–5 | super_admin / org_admin / an existing role-managing assignment **at Greenery** | **Missing.** The governed invite needs a session at Greenery, which needs an assignment at Greenery: the first assignment must come from an admin door. |
| Leasing basis | `activation_service.ingestRentRoll` (`leasing_basis` on read-source) or the retained key-only setter `POST /properties/:id/leasing-basis` | Deal Setup read-source | staff session with leasing/management at the property | **Unknown → bed** per `src/onboarding/deal_registry.js`; owner to confirm the workbook is by the bed. |
| Inventory / opening position | `activation_service` (open → read-source → confirm each row → establish); beds materialised by `inventory_materialization` from the source rows | `/deal-setup/...` | as above | **Not established.** Needs the real Greenery rent roll, retained as a source artifact; never a fixture. |
| Position use | `spaces.use_type` (migration 100) | **none** — see finding 6 | — | Blocker after materialisation. |
| Pricing / terms | `pricing_lifecycle` draft → review → publish; unit types; `lease_config` + governing instrument via `POST /operator/leasing/lease-configuration/template` | operator routes | pricing authority; management module for the instrument | Not established; all owner inputs. |
| Text lines | `POST /properties/:id/sms-number` (property line), `POST /admin/organizations/:id/operations-line` (staff line) | operator key / super_admin | see finding 7 | Not established; numbers are provider inputs. |
| Per-property environment | `LEASING_INTAKE_PROPERTY_IDS`, `PROSPECT_ACTIVATION_PROPERTY_IDS`, `APPLICATION_INTENT_PROPERTY_IDS` (+`APPLICATION_INTENT_PREPARE_ENABLED`), `EXECUTED_LEASE_PROPERTY_IDS`, `ACTIVATION_PROPERTY_IDS`, optional `AGENT_TOUR_BOOKING_PROPERTY_IDS`, `AGENT_AUTO_DISPATCH_PROPERTY_IDS` | Render environment | deploy-time, human | Greenery's id must be added; off the list, intake and application birth refuse. |
| Knowledge | `POST /operator/agent-facts` | Mike's Greenery session | leasing module | 0 facts; ten cards prepared in `docs/content/temple/leasing-content.json` (`prepared_not_loaded`). |
| Mike's SMS authority | `communication_lines.resolveStaffSenderForOrganization` (by `users.phone` within the org) and `resolvePropertyContextForStaff` (his assignments, or the property named in the text) | operations line webhook | — | Works once he holds a Greenery assignment; with two properties an unscoped text gets a clarification. |

## 3. Rehearsal — `tests/proofs/greenery_launch_rehearsal.db.js`

Owned loopback Postgres built from the real migration chain (ceiling 194 /
182 rows), nonce-owned disposable database, owned server for 932c9af booted
with the rehearsal property id in every per-property allowlist (as the real
id would be on Render), fake SMS transport, model sentinel. The unrelated
`spine_proofs` database was not touched; the disposable database was
dropped afterwards.

Result on 932c9af: **51 checks passed, 0 failed, 20 observations** —
`evidence.rehearsal.json` beside this receipt (identifiers scrubbed).

Sequence exercised, in order, through HTTP where a door exists:

1. Reproduced the shape (171 units, 171 placeholder spaces, 3 aliases, 1
   deal-less activation, no org, no team, basis unknown). Canonical reads:
   171 × `occupancy_unknown`; occupancy by basis unavailable
   (`leasing_basis_unsupported`); Mike cannot hold a session at the
   property; a member cannot create a deal; an org admin cannot adopt.
2. **Adopt** — super admin places the property with the organization
   (idempotent; a second organization is refused 409).
3. **Staff** — the admin invite attaches the existing Mike account to
   Greenery as `property_admin` (matched by his exact email; see findings
   2–4); Mike's Greenery session then invites a leasing agent through the
   governed door, the OTP arrives in the fake transport, the teammate
   accepts with a fully resolved staff identity; Mike's own phone login
   lands on one property and the property selector switches him.
4. **Deal** — the org admin creates the deal and adds the existing
   property; Mike (member) still cannot create deals.
5. **Opening position** — Mike uploads a synthetic bed-grain rent roll for
   20 of the 171 units (40 rows), opens the setup, reads the source with
   `leasing_basis: bed`, confirms all 40 rows, establishes. Beds are
   materialised on those 20 units; the other 151 keep their placeholder and
   stay `occupancy_unknown`. After the use-type repair write (finding 6),
   availability reads 13 `marketable_now`, 27 `occupied`, 151
   `occupancy_unknown`, and the selector offers exactly the 13 vacant beds.
6. **Lines and SMS** — property line recorded; operations line active for
   the organization; Mike's unscoped text gets "Which property is this
   about: …"; a text naming Greenery is answered without clarification.
7. **Lease configuration** — a governing form and the six required terms
   are retained through the operator route with Mike confirmed as company
   signer; the read reports `ready_to_generate` and `ready_to_execute`.
8. **Gates and knowledge** — intake accepted and application birth
   `ALLOWED` with the property allowlisted; `PROPERTY_NOT_ACTIVATED` without
   it. Nine of the ten prepared Greenery cards load through the fact writer
   (`dimensions` is a `measurement_gap`, correctly left blank) and Ask Spine
   answers an amenities question from them. Without published pricing, exact-
   space discovery finds the 13 targets and reports every one
   `unit_type_not_established`.

## 4. Findings (each reproduced in the rehearsal)

1. **Deal membership does not require ownership.** An org admin can add the
   still-unowned property to their own deal before adoption
   (`deal_service.addProperty` only refuses when both sides carry different
   organizations). Adoption must come first in the checklist, or the
   unowned building sits inside a client's deal.
2. **The admin invite door 500s for a phone-only account.**
   `POST /admin/organizations/:orgId/invite` (and `/org/users/invite`) use
   `ON CONFLICT (phone)`; `users` has no plain unique constraint on `phone`,
   only the partial expression index `uq_users_phone_normalized`. Postgres
   refuses the statement. Exercised: 500 "no unique or exclusion constraint".
3. **The same door 500s when the email does not match the existing
   account.** With an email present it upserts on `email`; a new email for
   an existing phone inserts a second user and hits
   `uq_users_phone_normalized`. So the door attaches an existing account
   only when the exact email on that account is supplied.
4. **The admin door rewrites `platform_role` when omitted.** Default
   `member`; an org admin invited to a second property without the field
   is demoted. Exercised: `org_admin → member`.
5. **The admin door writes no person-level assignment.** It creates the
   team assignment but not the `assignments` row `resolveStaffIdentity`
   requires, so Mike's identity at Greenery stays `not_assigned_here`
   (no tour hosting, no offer authorship) until the governed invite path
   or another writer supplies it. The governed invite + OTP path writes
   both (proved for the new teammate).
6. **Materialised beds have no governed use until the reviewed mapping tool runs — and Greenery has no ruling block.**
   `inventory_materialization` is called by the ledger loader without
   `use_type`; `availability_read` refuses `use_not_configured`; the
   selector offers nothing. No HTTP route or service writes
   `spaces.use_type`. The governed door is `tools/apply_unit_type_mapping.js`
   (human-run with `DATABASE_URL`, `--property <id>`, dry run by default,
   `--apply`): it maps `import_source_rows.raw->>'unit_type'` codes to
   `property_unit_types` through `produced_space_id` and writes
   `units.unit_type_id` and `spaces.use_type` with a receipt. It selects
   one owner-approved `RULINGS` block by coverage of the source codes and
   refuses when none covers them. Two rulings exist (an apartment
   vocabulary, 2026-07-27; Skyline's `STU0001x` codes, 2026-08-20). **Greenery
   needs (a) a source whose rows carry a unit-type code and (b) its own
   ruling block added to the tool — a reviewed source change, then a
   human production run.** Open question for QB: the tool's space update
   sets `position_kind='unit'` on every mapped space (line 372); on a
   bed-grain property that would re-kind materialised beds. Not exercised.
7. **A newly recorded property line cannot text.** `/properties/:id/sms-number`
   creates the line `outbound_enabled=false, outbound_policy='disabled'`
   and no door changes that. The governed invite goes `link_only` with no
   line and `sms_failed` with the new line. The e2e suite also fixes this in
   SQL.
8. **The prospect agent's dated inventory ignores the canonical position.**
   `leasing_inventory.availableUnits` (legacy discovery mode) keys on
   `units.occupancy_status='vacant'` and `units.bedrooms`, neither written
   by Deal Setup; it reported nothing for the 13 established vacant beds.
   Exact-space discovery does find them (then waits on pricing).
9. **Pricing needs unit types.** Every eligible bed is
   `unit_type_not_established` (`effective_pricing.js`); the same mapping
   run in finding 6 supplies them. Publication itself is
   `tools/release/skyline_publish_pricing.js`-shaped (saveDraft →
   submitReview → publishVersion with `previewPublication` first) and
   needs a pricing authority grant, which has no HTTP route: it is
   conferred by `src/identity/authority_resolution.js` through
   `tools/release/skyline_grant_authority.js` with a second reviewer.
10. **The legacy activation stays open with no deal.** Deal Setup neither
    sees nor closes it; whether to abandon it is an owner decision.
11. **Login has no property picker.** With two assignments Mike lands on
    the property that is SMS-ready and role-managing first; the app's
    property selector switches afterwards. Expect this the first day.

Repair-class writes used only so later steps could be exercised, each
labelled in the evidence: `spaces.use_type='residential'` on the sourced
beds (finding 6 — the governed path is the mapping tool, which the
synthetic source could not feed because its rows carry no type code) and
outbound enabled on the Greenery line (finding 7 — no door found).

## 5. Not established here

- Whether the real Greenery sits in a deal, what its legacy activation
  read, what its three aliases resolve, and whether Mike's real account
  carries an email or a person bridge: production reads, not run here.
- Whether the real rent roll names beds: the workbook is private and was
  not used. The rehearsal rows are synthetic and cover 20 units only, by
  design, to show that the established position is the rows the source
  establishes, never the 171.
- Browser rung on `b00cf49`, provider delivery, published pricing, model
  wording: not run.

## 6. Commands (scratch runner; owned server booted like `tests/e2e/boot.sh` with the rehearsal id in every allowlist)

```
node tests/e2e/proof_boundary.js create && ./tests/e2e/apply_migrations.sh
PROOF_GREENERY_ID=<allowlisted id> E2E_API_BASE=<owned server> E2E_SMS_LOG=<fake log> \
  node tests/proofs/greenery_launch_rehearsal.db.js     # 51 passed, 0 failed, 20 observations on 932c9af
node tests/e2e/proof_boundary.js cleanup
```

Not registered in `verify_all.sh`: it needs the server booted with a
proof-chosen property id in its allowlists, which the current runner does not
do. QB decides whether to add a boot variant.
