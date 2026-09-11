# The Greenery — launch checklist (drafted 2026-09-11 from API 932c9af)

Every step names its door, who may press it, and what it needs from the
owner. Steps marked **OWNER** need a decision or an input nobody can infer.
Steps marked **BLOCKED** have no product door on 932c9af today; they need
either a small product change (HP lane) or an authorised repair write, and
either choice is the owner's. Nothing below has been done in production.

The order is load-bearing. Adopt before the deal (finding 1); the text line
before invites (finding 7); use type before anyone expects the selector to
offer a bed (finding 6); unit types before pricing (finding 9).

## 0 · Read first (production, read-only)

- [ ] **Confirm identity.** Greenery `a29181cd-…` is the durable row (171
      units, 3 aliases, 1 activation). The two sparse "Greenery" rows are
      not to be used and not to be deleted from counts alone.
- [ ] Read the legacy activation (deal null, status), the three aliases,
      and whether the property already sits in a current deal
      (`deal_intake_properties`).
- [ ] Read Mike's real account: `users.email`, `users.phone`,
      `users.person_id`, `account_kind`, `platform_role`, `organization_id`.
      Findings 2–5 hinge on these.

## 1 · Organization — **OWNER**

- [ ] **Decide the organization.** Skyline's organization
      (`585ffce2-…`) or a separate Greenery entity. This also decides
      whose operations line Mike texts and which org admin runs Deal Setup.
- [ ] Super admin: `POST /admin/organizations/<org>/properties
      {property_id: a29181cd-…, reason}`. Idempotent; refuses if the
      property already has an organization.

## 2 · Staff — Mike at Greenery

- [ ] **First assignment** must come from an admin door (no session at
      Greenery exists yet). Use `POST /admin/organizations/<org>/invite`
      with `name`, `phone`, **the exact email on Mike's existing account**,
      `property_id`, `role_key` (`property_admin` gives management +
      leasing + role management), and **`platform_role` set to his current
      value**. Omitting the email or the platform role breaks or demotes
      the account (findings 2–4). If Mike's account has **no email**, this
      door cannot attach him: **BLOCKED** pending a product fix to the
      `ON CONFLICT (phone)` target or an authorised repair write.
- [ ] **Person-level assignment** (`assignments` row) — the admin door does
      not write it (finding 5). Without it Mike cannot host tours or author
      offers at Greenery. Options: the governed invite + OTP path for a
      fresh account, or a repair write on the existing one. **OWNER.**
- [ ] Any further teammates: Mike's Greenery session →
      `POST /properties/a29181cd-…/team-invites` (person confirmed by
      phone), OTP accept. This path writes everything identity needs.
- [ ] Expect: login lands on one property (SMS-ready, role-managing
      first); the app's property selector switches (finding 11).

## 3 · Text lines — provider inputs

- [ ] **Greenery's Twilio number** — **OWNER/provider.** Record it with
      `POST /properties/a29181cd-…/sms-number` (operator key). The line is
      created inbound-only.
- [ ] **Outbound policy** — **BLOCKED**: no door enables outbound on a
      property line (finding 7). Until then invites go link-only and
      prospect texts cannot be sent from Greenery's number.
- [ ] Operations (staff) line: exists per organization; super admin
      `POST /admin/organizations/<org>/operations-line` if the chosen
      organization has none.
- [ ] Mike with two properties: unscoped texts get "Which property is this
      about"; texts that name Greenery are scoped to it.

## 4 · Deal and opening position — the real workbook

- [ ] Org admin (or super admin): `POST /deal-setup/deals {deal_name}`,
      then `POST /deal-setup/deals/<deal>/properties {property_id:
      a29181cd-…}` (existing property; no `/properties/new`).
- [ ] **Confirm the leasing basis is by the bed** and that the workbook
      names the bed on every row (`Room`/`Bed` column). **OWNER.** Rows
      without a bed name are refused as ambiguous on a multi-bed unit.
- [ ] Mike (Greenery session): upload the real rent roll
      (`…/properties/a29181cd-…/source`, retained bytes, `source_as_of_date`),
      open the setup (`…/activation`), read it
      (`/deal-setup/activations/<id>/read-source` with
      `leasing_basis: "bed"`), review, confirm **each row**, establish.
      Beds are materialised from the rows; placeholders on units the
      workbook does not name stay `occupancy_unknown` and are never
      offered. **The established position is the rows the source
      establishes, not 171.**
- [ ] Decide the legacy deal-less activation: leave open or abandon
      (finding 10). **OWNER.**

## 5 · Position use — **BLOCKED**

- [ ] Materialised beds carry no `use_type`; availability reads
      `use_not_configured` and the selector offers nothing (finding 6). No
      route or service sets it. Needs a writer (HP lane) or an authorised
      repair write `spaces.use_type='residential'` for the established
      beds. **OWNER** decides which.

## 6 · Lease configuration and governing instrument — **OWNER inputs**

- [ ] Greenery's lease form (docx/pdf), `form_code`, `form_version`,
      landlord entity, application fee, amenity fee, utility
      responsibility, late fee, notice requirement, and who signs for the
      company. Mike (management module):
      `POST /operator/leasing/lease-configuration/template` with
      `confirm_company_signer=true` if he is the signer.
- [ ] Verify `GET /operator/leasing/lease-configuration` reports
      `ready_to_generate` and `ready_to_execute`.

## 7 · Pricing — **OWNER inputs**

- [ ] Assign unit types to Greenery's units (pricing resolves per unit
      type; every bed is `unit_type_not_established` today, finding 9).
- [ ] Draft → review → publish a pricing version for the terms offered
      (`/operator/pricing/draft`, `/review`, `/publish`), with the pricing
      authority grant in place. Until then the prospect agent cannot quote
      and budget matching is "incomplete".
- [ ] Note finding 8: the agent's legacy date-only inventory reads
      `units.occupancy_status`/`bedrooms`, which Deal Setup never writes.
      Prospect answers should rely on exact-space discovery, or the legacy
      branch needs the HP lane's attention.

## 8 · Render environment — deploy-time, human

- [ ] Add `a29181cd-…` to `LEASING_INTAKE_PROPERTY_IDS`,
      `PROSPECT_ACTIVATION_PROPERTY_IDS`, `APPLICATION_INTENT_PROPERTY_IDS`
      (with `APPLICATION_INTENT_PREPARE_ENABLED=true`),
      `EXECUTED_LEASE_PROPERTY_IDS`, `ACTIVATION_PROPERTY_IDS`; optionally
      `AGENT_TOUR_BOOKING_PROPERTY_IDS`, `AGENT_AUTO_DISPATCH_PROPERTY_IDS`.
      Off the list, intake and application birth refuse
      (`PROPERTY_NOT_ACTIVATED`).
- [ ] Deploys are manual and do not migrate; no migration is needed for
      this checklist on ceiling 194.

## 9 · Knowledge — **OWNER confirmation of wording**

- [ ] Nine of the ten prepared Greenery cards fit the fact writer;
      `dimensions` stays blank (measurement gap). Load through Mike's
      Greenery session `POST /operator/agent-facts` only after the owner
      confirms each card against the actual property.

## 10 · Acceptance before "live"

- [ ] Selector offers only established vacant beds; availability shows
      no `use_not_configured`, no `occupancy_unknown` on beds the workbook
      named.
- [ ] One governed invite texted from Greenery's number and accepted.
- [ ] One inquiry accepted through intake; application birth `ALLOWED`.
- [ ] Lease configuration `ready_to_execute`; pricing published.
- [ ] Browser rung on the deployed app for Greenery (not run here).
