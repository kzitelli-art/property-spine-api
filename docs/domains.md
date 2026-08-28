# Domain Reference

Each directory under `src/` is a domain. Every domain module exports a factory `function({ pool, ...deps })` that returns an Express router.

---

## `src/identity/` — Auth & access

The full staff authentication stack.

| File | What it does |
|------|-------------|
| `staff_session_service.js` | Issues and validates staff session tokens (digest stored at rest, never raw token) |
| `team_access.js` | Phone OTP login: `POST /auth/sms/start` and `POST /auth/sms/verify` |
| `operator.js` | `/operator/*` router: session gate, `/operator/me`, property-scoped access |
| `operator_session_bootstrap.js` | Legacy invite-code bootstrap (`POST /demo/operator-session`) |
| `registry.js` | Property identity resolution — maps string inputs to canonical property records |
| `staff_identity_resolver.js` | Resolves staff identity from session tokens |
| `capability.js` | Capability contracts: what a user can do given their assignment |
| `phone_identity.js` | Phone normalization utilities |
| `activation.js` / `activation_perimeter.js` | Account activation flow |

---

## `src/leasing/` — Leasing desk

The full leasing funnel from lead to executed lease.

| File | What it does |
|------|-------------|
| `leasing_desk.js` | Main leasing surface router — mounts all leasing sub-routes |
| `leasing_desk_loader.js` | Loads and assembles leasing desk data for the operator |
| `leasing_lifecycle_service.js` | Lease state machine: lead → applicant → approved → executed → active |
| `leasing_leads.js` | Prospect capture, lead queue, tour scheduling |
| `leasing_conversion.js` | Lead-to-applicant conversion obligations |
| `leasing_scheduling.js` | Tour scheduling and calendar management |
| `leasing_interactions.js` | Conversation and interaction tracking |
| `leasing_intel.js` | Leasing intelligence: velocity, pricing signals |
| `leasing_detail.js` | Per-unit leasing detail surface |
| `leasing_inventory.js` | Available unit inventory for leasing |
| `leasing_occupancy_facts.js` | Occupancy fact computation |
| `leasing_condition_facts.js` | Unit condition facts for leasing |
| `decisions.js` | Leasing decision routing and obligation creation |
| `conversion_obligation_closure.js` | Closes conversion obligations on lease execution |
| `agent_capability.js` | AI agent capabilities within leasing context |
| `demo.js` / `demo_reset.js` / `demo_preflight.js` | Demo building data and reset |

---

## `src/applications/` — Applications & lease execution

| File | What it does |
|------|-------------|
| `applications.js` | Application submission, review queue, status |
| `application_submission.js` | Public application submit endpoint (invitation-token gated) |
| `application_review.js` | Operator review surface for applications |
| `application_send_command.js` | Sends application invitations |
| `application_terms.js` | Application terms and conditions |
| `lease_packets.js` | Generates and serves lease packet PDFs |
| `executed_lease_service.js` | Records executed lease evidence |
| `proposed_terms_service.js` | Manages proposed lease terms |
| `autoconfirm.js` | Auto-confirmation logic for standard terms |
| `execution_evidence.js` | Proof of lease execution |

---

## `src/tenancy/` — Active tenancy

| File | What it does |
|------|-------------|
| `movein.js` | Move-in process: key handover, checklist, activation |
| `move_in_queue.js` | Queue of upcoming move-ins |
| `notice.js` | Notice to vacate: receipt, processing, queue |
| `economic_tenancy_service.js` | Economic tenancy record (rent, deposits, term) |
| `tenancy_anchor_service.js` | Anchors tenancy to property/unit for reporting |
| `space_position.js` | Space occupancy state |
| `availability.js` | Unit availability computation |
| `down_units.js` | Units down for maintenance/turn |

---

## `src/maintenance/` — Work orders & turns

| File | What it does |
|------|-------------|
| `maintenance.js` | Work order creation, assignment, completion |
| `work_order_service.js` | Work order lifecycle and state machine |
| `maintenance_urgency.js` | Urgency scoring and escalation |
| `turnovers.js` | Unit turn management: scope, schedule, completion |
| `turn_priority.js` | Priority scoring for turn queue |

---

## `src/money/` — Financial layer

| File | What it does |
|------|-------------|
| `money.js` | Core charges, payments, ledger routes |
| `charges.js` | Charge scheduling and one-time charges |
| `payments.js` | Payment recording and matching |
| `bank_bridge.js` | Plaid bank feed integration surface |
| `bank_intake.js` | Raw bank transaction intake and classification |
| `plaid.js` | Plaid Link setup and token exchange |
| `reporting.js` | T-12, rent roll, financial report generation |
| `compare.js` | Budget vs. actual comparison |
| `explain.js` | AI-powered transaction explanation |
| `attributions.js` | Cost attribution across units/properties |
| `money_board.js` | Money dashboard surface |
| `commitment_ledger.js` | Forward commitment tracking |
| `exposure.js` | Financial exposure calculation |

---

## `src/comms/` — Communications

| File | What it does |
|------|-------------|
| `communications_boundary.js` | **The single outbound SMS gate.** All property SMS flows through here. Requires `sms_number` on the property. |
| `sms.js` | Twilio transport wrapper. Fail-soft: logs when unconfigured, never throws. |
| `tenant_link.js` | Tenant portal session provisioning and magic links |
| `delivery.js` | Delivery tracking and receipt |
| `prospect_capture.js` | Inbound prospect capture from public-facing forms |

---

## `src/agent/` — AI ingestion

| File | What it does |
|------|-------------|
| `agent.js` | Document ingestion via Anthropic Claude. Accepts PDF/Word/Excel uploads, extracts structured data, routes to the review queue as claims. Never writes directly to institutional tables. |

---

## `src/onboarding/` — Property & deal onboarding

| File | What it does |
|------|-------------|
| `onboarding.js` | Property onboarding wizard |
| `onboarding_funnel.js` | Onboarding step tracking |
| `deal_intake.js` | Deal intake from external sources |
| `intake.js` | Field event capture (Twilio webhook endpoint) |
| `deal_registry.js` | Deal identity and deduplication |
| `public_review.js` | Public-facing review/approval surface |
| `import_rent_roll_truth.js` | Import a verified rent roll as the truth file |

---

## `src/surfaces/` — Operator read surfaces

These are primarily read surfaces that aggregate data from multiple domains.

| File | What it does |
|------|-------------|
| `board.js` | Portfolio-level board: all properties at a glance |
| `desks.js` | Desk surface aggregator |
| `management.js` | Management desk: delinquency, forward rent roll, tenant relations |
| `management_read.js` | Read queries for the management surface |
| `portfolio.js` | Cross-property portfolio view |
| `property_surface.js` | Per-property surface data |
| `orgchart.js` | Team org chart and accountability routing |
| `owner.js` | Owner/investor-facing surface |
| `roomowners.js` | Room owner surface (by-the-bed properties) |

---

## `src/shared/` — Cross-domain utilities

| File | What it does |
|------|-------------|
| `conversation_operating_contract.js` | Defines the contract for conversation-based AI interactions |
| `proof_next_action_resolver.js` | Determines the next required proof action for an obligation |
| `snapshot_loader.js` | Loads property data snapshots |
| `seed_endpoint.js` / `seed_snapshot.js` / `facts-seed.js` | Development seed data |
| `property_timezone.js` | Timezone utilities for property-local time calculations |
| `tour_window.js` | Tour availability window computation |
| `scheduling_adapter_seam.js` | Scheduling system adapter interface |
| `outlook_acuity_sync.js` | Outlook/Acuity calendar sync |
