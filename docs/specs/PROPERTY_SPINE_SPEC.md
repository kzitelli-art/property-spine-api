# PROPERTY SPINE — COMPREHENSIVE SPECIFICATION & DESIGN DOCUMENT

### Written memory-first, then validated against live source. July 24, 2026.

**Method:** every claim below was stated first from accumulated project knowledge — doctrine, rulings, decisions, and hard-won operational lessons — and *then* checked against live `main` of `kzitelli-art/property-spine-api` and `kzitelli-art/property-spine-app`, pulled this session. Where the two disagree, both are shown. Where a claim exists only as a decision and has no code to check, it is marked **memory-only** and carries no false proof.

> Rule 11 still governs: nothing here is deploy authority. Re-pull live source and query the Neon ledger before building.

---

# PART 0 — THE VALIDATION LEDGER

The point of the memory-first pass. Claim on the left, live source on the right.

## 0.1 Memory confirmed by source

| Memory claim | Source verdict |
|---|---|
| The live loader exposes **exactly 18** operator resources; everything else returns honest blanks | ✅ **Exact.** `PRODUCTION_LIVE_RESOURCES` at `index.html:6102` holds 18 keys (enumerated in §2.6) |
| `window.__psLive` is **frozen** and non-reconfigurable | ✅ `Object.defineProperty(window,'__psLive',{ value: Object.freeze(_publicApi), writable:false, configurable:false })` |
| `__draftIsLiveContext` patch landed; `grep -c` should return **4** | ✅ Returns exactly 4 |
| 089 v2 refuses a **zero-dollar first period** | ✅ `first_period_amount_invalid` — *"A zero-dollar first period requires a future governed concession path; it cannot silently satisfy the first-rent gate."* |
| **STOP is global per person**, not property-scoped | ✅ `contact_preferences` is keyed `(person_id, channel)` — **no property column** (migration 048) |
| `POST /operator/session` takes body field **`proof`** only | ✅ *"browser submits ONLY { proof }. user_id / property_id / role"* are server-derived |
| Send-application requires a **`prepare_application_link`** obligation | ✅ `applicationSubmission.js:1946` refuses any other type |
| Conversion-obligation closure columns are `resolution` / `resolution_basis` / `closed_at` / `closed_by_user_id` | ✅ Present; not `resolved_by_user_id` |
| `persons` name column is `name`, not `full_name` | ✅ Baseline schema |
| A lease attaches to a **space**, never a unit; trigger guarantees ≥1 space per unit | ✅ `ensure_unit_space` trigger + `leases.space_id NOT NULL` |

## 0.2 Memory corrected by source — fixes that landed since

| Memory claim | Source verdict |
|---|---|
| The `scheduled_for` bug (TS_COL stamping the booking moment into the appointment time) — fix delivered, upload uncertain | ⬆️ **Deployed.** `leasingleads.js:1308` reads `scheduled: null, // appointment time, NOT an occurrence time` |
| `normalizeStageApplicationAction` still overrides CTA vocabulary with stage labels | ⬆️ **Fixed.** It now delegates to `normalizeApplicationAction` and returns the canonical navigation verb "Open" |
| `/operator/me` reads no server-authoritative module entitlement (module-visibility bug) | ⬆️ **Backend fixed.** `operator.js:238` returns `allowed_modules` from the assignment; a second gate at `:1623` refuses on missing leasing entitlement. *Frontend seeding still needs browser proof.* |
| Migration ceiling 088 | ⬆️ **089** — `089_economic_tenancy_and_move_in_handoff` is on `main` |
| Agent prompt `stage-a-v5` | ⬆️ **`stage-a-v7.1`** |
| `property-spine-app` is private | ⬆️ **Public**, fetchable by raw curl |
| The app is one `index.html` | ⬆️ Still the shell (23,159 lines / 1.68 MB) but **seven modules extracted** |
| Comms Boundary Phase A is a spec | ⬆️ **Built** — `communications_boundary.js`, 37 KB, plus two proof harnesses |
| S2 (property scope drives the shell) is open | ⬆️ **Substantially closed in source.** `offlinePid()` now reads the live session first and falls back to the picker *only when there is no live session*. Needs browser proof, not a rebuild. |

## 0.3 Memory-only — real, but nothing in the repo can confirm it

| Fact | Why it has no source proof |
|---|---|
| **Fable / "buddy" is an external human advisor.** Claude cannot run Fable and must never simulate a ruling. | A governance relationship, not code |
| **Person Card as canonical send surface** — reverses the prior Gate C read-only ruling. Six downstream backend items depend on ratification. | Awaiting ratification; unbuilt |
| **Money band reframe** — approval and countersigning are *money actions*, good-news work, surfaced as a revenue band at the top of Follow-Ups, weighted as opportunity not workload. Applications are a **state**, not a door. Explicitly deferred. | Product decision, deliberately unbuilt |
| **STOP global-vs-property-scoped** must be decided before real multi-property use. Current behavior is the conservative direction (over-blocks, never under-blocks). | A recorded decision point |
| **Generate/Issue perimeter question** — should packet generation sit behind the heavier `internal_qa` perimeter or the lighter approve/confirm wall? Buddy's call, not built either way. | Open ruling |
| `2026letsgo` is both the intake secret and the operator key | A credential value, correctly absent from source |
| The near-term event is a **walkthrough with Tom**, a lifelong coder, processing a real lead through the operator app | Not a code fact |

## 0.4 Memory that corrects the *documents*, including my own prior draft

| Correction |
|---|
| **`raw.githubusercontent.com` serves stale cached content for minutes, even with a cache-bust parameter.** It is unreliable for deploy verification. The reliable check is the **GitHub file view** (size + commit header) or the API. A prior draft of this document recommended cache-busted curl as the verification method — that is wrong for *verification*, though still fine for *fetching a base*. |
| **GitHub web upload: "replace" can silently fail while "add new file" succeeds.** Check the resulting file size every time. |
| **`git fetch origin` fails in the Render shell.** Use `curl`. |
| **`__OFFLINE_MODE = true` is permanent and never overridden.** It is not a switch waiting to be flipped — the live path was built *around* it via the 18-resource frozen loader. Any plan premised on "flip the flag" is premised on a misreading. |

---

# PART 1 — THE THESIS AND THE DOCTRINE

*Memory-led. This part is timeless and has no source to validate against; it is the standard everything else is measured by.*

## 1.1 The line the system is built around

> **Record the truth at the moment of the event, and reporting becomes a read, not a project.**

A middle-market operator — several hundred units, institutional reporting obligations, mom-and-pop staffing — runs on five subscriptions that do not talk to each other and a month-end **reconstruction**: a bookkeeper archaeologically rebuilding what happened from receipts, emails, and memory, weeks after the fact. That reconstruction is where the lag, the errors, and the lying-by-accident live.

Property Spine **replaces** the owner/manager operating stack. It is not another system of record beside one.

## 1.2 The one epistemic rule — claim before truth

Every fact enters as a **claim**. Nothing — parse quality, plausibility, even human approval of the parse — upgrades it to **truth** except a structural tie a human signed.

```
Revenue   parsed ≠ promoted. Supported revenue = promoted rent only (a real tie
          to a real unit). Everything else is held-out exposure.
Deposits  the prior owner's claim is nothing until cash_tie — the ungameable gate.
Money     not report_ready until the last approver signs.
Identity  name is not identity. The registry resolves a string to one canonical
          property or surrenders it to a human. It never guesses.
Intake    a captured field event is a claim. It becomes real only when a human
          routes it through the real endpoint from the review queue.
```

**AI can suggest the fact. A human, event, or proof source confirms the fact. Only confirmed facts hit reporting.**

## 1.3 Two headline numbers

```
NOI       → proven operating result
Exposure  → how much of the money story remains unproven
```

Exposure is honesty, not failure. It must never become a vague score. Wherever it appears it answers: what specifically is unproven · how much money is implicated · who owns the next action · what proof would resolve it · how long it has been unresolved · whether it changes reported NOI or only confidence in it.

**A badge people learn to manage cosmetically is failure.**

## 1.4 Structural honesty, not policy honesty

Walls live in the schema, not in guidelines:

- The public parsing bench takes no `propertyId` and writes only to isolated tables — it *cannot* touch supported revenue.
- Double promotion is blocked by a unique constraint, not code discipline.
- Intake's `routed_id` is a recorded tie, **not a foreign key** — intake cannot block, cascade into, or mutate institutional tables.
- One active tour offer per conversation — partial unique index (079).
- One lease per `application_id` — partial unique index (080).
- One live move-in / move-out per `(lease, space)` — partial unique indexes (081).
- AI never moves money. No auto-approve.

> Policy honesty depends on people remembering. **Structural honesty survives turnover, bad days, and future contributors.**

## 1.5 Collapse the seams

```
application link  → application + authentication + identity
form              → conversation channel
normal work       → operating record
capture           → durable truth
```

A phone number is a contact and an identity **signal**. Never by itself: permission to merge two humans · proof of staff identity · proof of property authority.

**Recognition over re-entry.** Nothing opens blank. The Person Card grows accretively. Spine feels like a relationship continuing, not a form restarting.

## 1.6 The product integrity test

1. Does this reduce the time between real work and recorded truth?
2. Does it reveal uncertainty rather than hide it behind a status?
3. Does it preserve context so the user does not re-enter what Spine should know?
4. Does it ask for human judgment only where judgment is actually needed?
5. Does it identify one accountable next action without inventing ownership?
6. Can the user understand the situation in three seconds without learning the schema?
7. Does this make the eventual report more of a read and less of a reconstruction?

**Hard rejection:** if a feature makes Spine look more like conventional property software but does not make the building more truthful, do not build it.

## 1.7 The operating funnel

```
CAPTURE                        PROVE (a layer)      OUTPUT              TRANSMIT
Management ┐
Leasing    ├─→ captured once ─→ money confirmed ──→ Reporting ──────→ Investor Relations
Maintenance┘                     in context          (sign-off →
                                                      GENERATE)
```

**Money is not a room.** Reporting reads confirmed truth; it never authors it. Investor Relations is strictly downstream.

## 1.8 Navigation doctrine

The north star is not "four doors." It is: **the building should make sense to the person responsible for it in under three seconds.** The system sorts before the human arrives.

Four is the ceiling for an unprioritized decision screen. More is allowed when one item is clearly primary or the items form a sequence. Five equal choices means the hierarchy is wrong.

```
Property Spine
└── Choose Deal / Property
    └── Property Home
        ├── Management     Rent Roll · Delinquency & Evictions · Tenant Relations · Forward Rent Roll
        ├── Leasing        Pre-Tour AI Conversations · Tours · Follow-Ups · Renewals · Marketing
        ├── Maintenance    Work Orders · Turnover · Materials · Vendors & Projects
        └── Reporting      manager sign-off → GENERATE
```

Availability is a fact and a layer, not another Leasing door.

## 1.9 The thirteen load-bearing rules

| # | Rule |
|---|---|
| 0 | **Human attention is the scarce resource.** Capture much; interrupt only for judgment. |
| 1 | **Claim before truth.** |
| 2 | **One accountable human** — or explicitly UNASSIGNED. Never fake ownership. |
| 3 | **Report is a read**, closed by sign-off and Generate. |
| 4 | **Simple handle, complex engine.** Confirm · Assign · Fix · Escalate · Sign · Generate. |
| 5 | **Honest blank beats confident wrong.** |
| 6 | **Money decisions run through the obligation engine.** |
| 7 | **Every operational entry is attributed** — six distinct roles, never collapsed. |
| 8 | **Capture writes facts once; reads update everywhere.** |
| 9 | **No phantom dispatch or promise.** Recommendation ≠ dispatch. |
| 10 | **Canonical architecture.** Demo data may exist; demo paths may not. |
| 11 | **Live-first operator rule.** Live failure → unavailable/retry, never fixtures. |
| 12 | **Solo-first, never Solo-special.** Configuration, never `if (property === SOLO_ID)`. |
| 13 | **Foundations before features.** Build-once-vs-twice is determined by **order**, not quality. |

## 1.10 Stop-sign phrases

```
"it only works in demo mode"
"we will wire it to the real path later"
"this is just a temporary alternate endpoint"
"it falls back to sample data when the API has a problem"
"we can clean up history after the demo"
"we only need this special case for Solo"
```

## 1.11 The delete-or-keep test

Before proposing anything: **when we go live for real, do we delete this or keep it?**

```
Class 1  permanent product primitive
Class 2  temporary adapter with an explicit replacement condition
Class 3  test/demo infrastructure outside the operator workflow
Class 4  delete-on-activation scaffolding
```

Unclear classification → the component does not proceed. **A resettable operating demo is forbidden** — a demo that erases its own history disproves the thesis.

---

# PART 2 — ARCHITECTURE

## 2.1 The shape

```
property-spine-api                property-spine-app             propertyspine.com
Node/Express on Render            operator app (static)          tenant intake site
  → Neon Postgres                   index.html + 7 modules         static Netlify
  → Anthropic API                   + logos.js                     separate origin
  → Twilio SMS                      + fixtures (preview only)
  → Plaid
  → Microsoft Graph (Outlook)
```

**The operator app origin is not the tenant site origin.** This drives CORS, credential scope, and the rule that a demo credential is never baked into a public page.

## 2.2 The one loop

```
Event → Obligation → Required Input → Clock → Escalation → Proof → Completed Record
```

Every module is that loop pointed at a different domain. This is why the obligation engine is the most load-bearing piece in the system.

## 2.3 The organ pattern

```js
module.exports = function moduleName(deps) {     // { pool, anthropic, sms, helpers }
  const router = express.Router();
  router._service = { /* the canonical service, shared — never forked */ };
  return router;
};
app.use("/", moduleName({ pool, spawnObligationFromEvent, satisfyObligation }));
```

- Injected dependencies; an organ cannot reach into another organ's tables.
- Where two doors need the same behavior, the **instance is captured and `._service` handed over** — never re-implemented. `__leasePackets`, `__leasingLeads`, `__applicationSubmission` all do this in `server.js`.
- The registry's resolver is the **one identity path**.
- Migrations are numbered, idempotent, ledger-recorded, applied on deploy.

*Validated: 148 modules on `main`; the `_service` handoff pattern is present at all three sites.*

## 2.4 The canonical architecture invariant (Rule 10)

**One canonical operating architecture, many isolated data contexts, no parallel business logic.**

Contexts may differ in **data** and **deployment**. They may not differ in:
```
domain model · staff identity model · property authority model · canonical service layer
event and audit history · ownership resolver · API semantics · read projections
signed-in operator behavior
```

Forbidden: a tour meaning one thing in Solo and another in Demo Building · a demo login creating a different authority model · a live API failure becoming believable sample data · Solo chrome over Demo Building data · a second service path "for now."

**The test:** could we remove the fixtures tomorrow and have the workflow behave identically for a real Solo operator?

## 2.5 The four live-first seams

```
S1 identity → S2 property scope → S3 live source (per surface) → S4 honest-empty (per surface)
```

Partial order: S1 before S2; S2 before S3 per surface; S3 before S4 for that surface. S3/S4 complete **one surface at a time**. The global offline default retires as a *consequence*, never as the first move.

```
live data exists    → render live property-scoped read
live data is empty  → honest empty state
live request fails  → unavailable / retry
never               → fixtures · a new demo session · a silent property change
```

## 2.6 The live loader — how live-first was actually achieved

**This is the single most misunderstood part of the system, and memory had it right.**

`window.__OFFLINE_MODE = true` is set at `index.html:3626` and **never overridden**. It is not a switch awaiting a flip. Instead, a frozen live loader carries the operating path:

```js
Object.defineProperty(window, '__psLive', {
  value: Object.freeze(_publicApi),
  writable: false, configurable: false, enumerable: true
});
```

`PRODUCTION_LIVE_RESOURCES` holds **exactly 18** resources. These bypass the offline shim entirely and route to the live Render API. **Surfaces outside these 18 return honest blanks — not fixture data.**

```
operatorMe                      leasingCondition            rentRoll
eligibleStaff                   personCard                  operatorLeasingConversations
leasingConversationDetail       leaseableUnits              conversationQueue
taskQueue                       taskRecentlyClosed          leasingDesk
toursToday                      turnPriority                applicationsReview
applicationReviewDetail         moveInState                 moveInQueue
```

**S2 is substantially closed in source.** `offlinePid()` now reads the live session *first*:

> *"a signed-in operator session is AUTHORITATIVE over the offline picker. If the live session names a property, the shell scopes to THAT property — never a stale picker value or the SOLO_ID default. The picker fallback applies only when there is no live session."*

**Consequence for planning:** the remaining live-first work is **adding resources to the 18 and browser-proving them**, not flipping a flag or rewriting the shell. Any plan that says "turn off offline mode" is premised on a misreading.

## 2.7 Frontend files

| File | Role |
|---|---|
| `index.html` | shell, routing, most doors, the frozen live loader — **1.68 MB / 23,159 lines** |
| `conversations-board.js` · `followups-door.js` · `moveins-door.js` | extracted doors |
| `person-card-information.js` · `leasing-experience.js` | extracted surfaces |
| `policy.js` · `preview_build.js` | client policy; preview assembly |
| `property-spine-data.js` · `*_seed.json` · `solo-rent-roll-data.js` | **fixtures — preview harness only** |
| `logos.js` | images |

> A 23k-line file is **not itself an architecture violation.** A rewrite for cleanliness would be a vanity project. Extract only where a live product boundary demands it.

**Standing hazard:** `index.html` deploys by whole-file replacement. Two threads handing over complete copies from different bases will silently overwrite each other with no merge and no conflict. **One thread owns `index.html` at a time.** Whichever thread edits it pulls live `main` as its base first and re-verifies after.

---

# PART 3 — THE DATA MODEL

*Memory holds the invariants and the reasons. Source confirms the shapes. **132 tables** across 90 numbered migrations plus the baseline.*

## 3.1 The spine

```
properties → units → spaces → leases
                ↘ persons ↗
                     ↓
        events · comm_events · obligations · ledger_entries
```

### `spaces` — the canonical leased atom

```sql
spaces (id, unit_id → units, space_label default '(whole unit)')
```

> **The invariant, enforced at the data layer:** every unit has ≥1 space, auto-created by the `ensure_unit_space` trigger. **A lease attaches to a space, never to a unit.** This one decision is what lets whole-unit and by-the-bed leasing share a single code path. **By-unit vs. by-bed is property configuration, never a code branch.**

Migration 081 made possession space-anchored. Migration 088's `executed_lease_records.space_id NOT NULL` fixed a latent by-bed defect where the old code took the first space in the unit *by creation date*.

### `persons` — durable across the lifecycle

```sql
persons (id, name, email, phone, lifecycle_status default 'lead',
         leasing_stage, source, interested_unit_id)
```

> **Status changes; the record is never replaced.** The name column is **`name`**, not `full_name` — a repeatedly-rediscovered fact that has broken scripts more than once.

Phone normalization runs through the shared `normalizeE164` in `phone_identity.js`; dedup keys on `primary_phone_e164`. **A phone number is an identity signal, never a universal silent merge.** The inbound resolver must match `primary_phone_e164` *and* the raw `phone` field with a bounded last-ten-digits fallback — matching only the raw field once caused a real person to resolve as ambiguous and silently receive no reply.

### `leases`

```sql
leases (id, property_id, space_id → spaces ON DELETE RESTRICT,
        tenant_ids uuid[], rent, balance, start_date, end_date, lease_status)
-- accreted:
application_id                                  (080, partial unique — one lease per application)
source_type · source_as_of_date · import_batch_id · confidence   (shadow-import provenance)
economic_tenancy_activated_at / _by_user_id / _activation_event_id   (089)
```

### `obligations` — the engine

```sql
related_id · related_type · source_event_id       -- polymorphic tie
module · type · label
owner_type · assigned_role · assigned_user_id (NULLABLE)
escalates_to_role · escalates_to_user_id (NULLABLE)
status · required_inputs text[] · priority · severity
due_at · completed_at · escalated_at
notification_channel · requires_acknowledgment · escalation_interval_minutes  -- reserved, no behavior
```

> One event can spawn **multiple obligations for different roles**. A Unit 304 conflict creates separate obligations for leasing, maintenance, the PM, and — only if it goes material — the owner. **`assigned_user_id` being nullable is what makes honest UNASSIGNED possible instead of fake ownership.**

The clock is real and read-time only: `now() > due_at` means overdue; an AI-owned obligation that goes overdue escalates to a human. **No background jobs.**

### `property_controls` — first-class

Rental license · CoO · lead-safe · tax · insurance · lender report · permit · inspection · utility · service contract · vendor insurance · compliance. A control coming due is an **event** that spawns an **obligation** through the same loop. **This is what turns "property management software" into a control system.** Shape exists; behavior largely unbuilt.

### `documents` — more than a file

`satisfies_obligation_id → obligations` plus `effective_date` / `expiration_date`. A document can satisfy a required input, close an obligation, and update a control.

## 3.2 Locked principles

```
Inventory-first rent roll     the rentable unit or bed is the primary atom
By-unit vs by-bed             property configuration, never a code branch
Eight-state inventory model   tenancy status × physical readiness, never collapsed
Future-resident rows          lease intent only; excluded from current-occupancy denominators
Gross never net               AR, delinquency, exposure stay gross; credits shown separately
Identity is address not name  stable ID + display name; survives rebrands and collisions
Operational truth             current = DATE-DERIVED against an as_of date,
                              NEVER a stored status word, NEVER a move-in side effect
lease_status                  reserved for LEGAL OPERATIVENESS only
```

**The occupancy ruling in full.** The codebase once had three disconnected occupancy axes — `leases.lease_status`, `units.occupancy_status` as contracted status, and the same column as physical possession — none derived from possession events, and a KPI counting `lease_status='active'` **that nothing ever wrote**. `space_position.js` replaced all of it with one canonical dated position per `space_id` emitting seven fields:

```
current_lease_position · future_lease_position · current_possession
physical_readiness · availability_state · available_from · next_required_action
```

**The three-axis conversation model must never collapse:**
```
commercial_state → new | active | booked_tour | closed_not_fit
waiting_on       → prospect | ai | manager | none
control_mode     → agent thread mode
delivery_state   → a delivery FACT, separate from intent
```

**Authority split:**
```
leasing_leads.status  terminal opportunity state
lifecycle events      reopenable close/reopen history
queue projection      current operating position
```

**Two shapes of sourced knowledge:**
```
scalar facts → provenance-aware values with supersession lineage
signals      → append-only; may resolve or expire; NEVER latest-wins fields
```

**Corrections preserve truth:** actor · time · reason · prior reference · revised fact. Current reads update; history retains the correction.

## 3.3 Schema facts that cost time to rediscover

```
persons.name                          NOT full_name
events                                has NO JSON column (note is text; the row is authoritative)
leasing_conversion_obligations         resolution · resolution_basis · closed_at · closed_by_user_id
                                       (NOT resolved_at / resolved_by_user_id)
contact_preferences                    unique on (person_id, channel) — NO property column
unit_events                            status 'actioned' (not 'effective'); type constrained by
                                       ck_unit_events_type (082 added move_in/move_out)
lease_id on unit_events                may live in payload->>'lease_id' —
                                       read coalesce(lease_id, payload->>'lease_id')
obligations.assigned_user_id           has an FK to users — fixtures must use a REAL user id
```

## 3.4 Domain groupings

**Spine** `properties · units · spaces · persons · leases · ledger_entries · events · comm_events · work_orders · turnovers · vendors · bids · inventory · documents · obligations · property_controls · users`

**Identity & authority** `staff_sessions · property_team_assignments · assignments · team_invites · tenant_invites · tenant_sessions · operator_session_invites · user_person_bridge_audit · person_property_classifications (076) · person_identity_conflicts · person_contact_discrepancies · identity aliases (050) · property_aliases`

**Leasing funnel** `leasing_leads · lead_events · lead_sources · lead_source_touches · lead_takeover_queue · conversations · leasing_conversation_handoffs / tour_links · leasing_lead_lifecycle_events · leasing_conversions · leasing_conversion_obligations (+ events, 069) · leasing_snapshots · leasing_coverage_exceptions (087)`

**Tours & scheduling** `leasing_tours · scheduled_tours (+revisions, sources, source_links) · tour_availability · tour_booking_links · tour_events · tour_units_shown · agent_tour_offers (079) · scheduling_source_mappings · property_leasing_calendar · recovery_attempts · recovery_variants`

**Applications & execution** `lease_applications · application_invitations · application_intents (084) · application_proposed_terms_confirmations (085) · lease_packets (+documents, fields, audit_events) · lease_offers · executed_lease_records (088) · executed_lease_admission_evaluations (088)`

**Tenancy & move-in** `unit_events · lease_move_in_charge_sets (089) · lease_economic_lines · lease_economic_schedules · deposit_claims · down_units · turnovers`

**Pricing & commitments** `pricing_terms · property_pricing_versions · concession_policies · concession_authority_grants · concession_incidents · guardrail_incidents · incident_dedupe · decision_cases`

**Money** `money_events · money_event_attributions · bank_accounts · bank_transactions · plaid_item · plaid_account · payments · payment_applications · payment_bank_links · scheduled_charges · charges · ledger_claims · check_register_orphans · rc_pairings · category_report_map · vendor_property_categories · vendor_aliases · property_noi_goals`

**Reporting & onboarding** `report_imports (+lines, aliases) · variance_explanations · import_batches · import_source_rows · onboarding_runs · deal_intakes (+files, properties) · public_rent_roll_feedback · public_upload_sessions · mapping_memory · proposed_records`

**AI** `agent_runs · agent_drafts · agent_facts · agent_thread_state · agent_tour_offers`

**Comms** `comm_events · comm_event_status_log · contact_preferences · intake_events · intake_media`

**Integrations & demo** `integration_sync_runs · integration_sync_states · demo_runs · demo_events · demo_attempts · activations · supply_requests · ingest_runs · ingest_candidates · schema_migrations`

## 3.5 Projection discipline

```
domain action → writes the domain object
board · Person Card · report → READ projections
```

**No generic timeline writer.** The Person × Property Card is a projection, not a table anyone writes rows into. Every rendered entry carries: stable source · source ID · occurred time · recorded time · actor · verb · claim strength where relevant. History sorts by `occurred_at` with deterministic tie-breaks.

Past, planned, and due are **different truths**:
```
observed event   occurred_at + recorded_at
scheduled work   scheduled_for
open obligation  owner + due_at + status
resolved work    completion actor + resolved_at
```
**NEXT is never fake future history.**

> **The `scheduled_for` lesson.** Every tour ever created stored the *booking moment* in `scheduled_for` because `recordTourEvent`'s `TS_COL` map contained `scheduled: "scheduled_for"`, stamping `event_at` milliseconds after a correct insert, in the same transaction. `RETURNING` was honest; the stored row was wrong. **An appointment time is not an occurrence time.** When-scheduling-happened belongs in `tour_events.event_at`. *Fix validated deployed.*

Freeze projection response contracts before joining new live reads or writes.

## 3.6 The Person Card

An attributed relationship read between **one person and one property**: what was said · what happened · what is known · what must happen next.

It is **not** a generic profile form, a generic timeline writer, a surveillance record, or everything the company knows about a person.

```
Relationship → live conversation and working context
Next         → one or two open obligations or decisions that matter now
History      → attributed events in chronological order
```

Each rendered object remains its own system-of-record object underneath. **NEXT appears before full History.**

**The open ruling (memory-only):** the Person Card should become the **canonical send surface** — "the iMessage of Property Spine." The reasoning: staff must be able to message a tenant *inside the app* as easily as texting. If they cannot, they fall back to personal phones and Spine never captures the truth of that communication — which defeats the entire premise. **This reverses the prior Gate C ruling** that the Person Card is a read projection with no composer and no send path. Doctrine requires a reversed ruling be surfaced explicitly, never merged silently. **Six downstream backend items depend on ratification.**

**The dedup lesson.** Marlow Walkthrough and Jordan Avery appeared as two deals because dedup keyed `conversion:C` and `application:A` separately. The fix required an **alias map** — rows carrying both IDs establish `application → conversion` — so every row resolves to the conversion key (the deal) and stage rank picks one survivor. Re-application (one conversion, two applications) is the edge case that proves the map.

---

# PART 4 — IDENTITY, SESSION & AUTHORITY

## 4.1 The six things that must never collapse

```
user account · durable person · property assignment
authenticated actor · task owner · scheduled host / actual-host claim / completion actor
```

## 4.2 `staff_session_service.js` — the one canonical service

**Class 1.** Every mint, resolve, and revoke goes through this file. **No other module touches `staff_sessions`.**

```js
issueStaffSession(client, { userId, propertyId, purpose })
resolveStaffSession(db, token)      // validity + live user status + live assignment, EVERY call
revokeCurrentStaffSession(db, token)
```

### The authority law

> The `property_team_assignments` row **is** the authority. Not `account_kind`, not global role, not the invite that bound the login, not the caller.

No property branch, no user branch, no `DEMO_MODE` inside the service. Demo is a *caller* that resolves its server-pinned user and property and calls in. **The caller never supplies role, modules, TTL, or entitlement.** Authority is re-derived on every call — a revoked assignment takes effect on the next request, never a login-time snapshot.

### Server-owned issuance policy

```js
demo:             { ttlHours: 6 }        // fenced Demo Building presentation sessions
bootstrap_invite: { ttlHours: 12 }       // Class 2 interim proof
sms_otp:          { ttlHours: 24 * 14 }  // preserves teamaccess's 14-day policy
```

A trusted caller names its **purpose**; the service maps it to a duration. **The browser never chooses.**

### Token-at-rest

New sessions store `sha256(raw)`; the raw token returns **once** and is never persisted or logged. Legacy raw-token rows resolve for their remaining TTL, max 14 days. **Replacement condition:** `SESSION-DIGEST-CLEANUP` drops the legacy branch and the raw column once every pre-digest session has expired.

## 4.3 `POST /operator/session` — Brick One

*Validated against source.*

```
browser submits ONLY { proof }
user_id / property_id / role / modules are ALL server-derived
one generic refusal for invalid / expired / consumed / revoked
proof consumption and session mint share ONE transaction;
  any failure rolls back — no session, and the proof is NOT falsely consumed
returns: session_token
```

**Classification:** the route and the canonical session are Class 1. **The invite-proof method is Class 2** — replacement condition is SMS OTP or another approved proof. The proof method is replaceable; the session and server-derived authority are not.

## 4.4 `activation_perimeter.js`

```
mode enabled
  AND property activated (approved set)
  AND record is internal_qa (person × THAT property, CURRENT)
  AND authenticated staff session has property/action authority
  AND application state is eligible
→ otherwise refuse, deterministically and NON-REVEALINGLY
```

### Operator authority is not a shared key

> "Authorized operator" is **NOT** a shared header key. Identity, property entitlement, and role authority come from the authenticated staff session. A shared activation secret **may** be an additional Class-2 release control, but it can **never** determine identity, property, or role. If a route does not yet receive canonical operator context, that is a **dependency, not an excuse** to fall back to a header key — the perimeter fails closed.

### Two layers, in order

```
Layer 1 — MODE       no DB, runs FIRST (dormantWriteGuard)
Layer 2 — PERIMETER  session → server-derived entitlement at the application's property
                     → current internal_qa classification → eligible application state
```

**Per-phase re-check.** Phase-1 permission does not carry into Phase-2. Each route mounts its own guard; each guard re-reads live state. The handler revalidates under `FOR UPDATE`. **The perimeter is early admission; the transaction is final authority.**

**Refusal:** one opaque 403 that does not disclose whether the application, person, or classification exists. The full decision is audited internally. Secrets are never logged.

**Open ruling (memory-only):** should `generate_lease_packet` / `issue_lease_packet_link` sit behind this heavier `internal_qa` perimeter, or the lighter approve/confirm wall? *Argument for lighter:* a packet is a document, closer to "confirm" than to "activate." *Argument for keeping:* issuing sends a link to a resident. **Not built either way.**

## 4.5 The three credentials — the most-confused thing in the system

| Credential | Mechanism | Minted by | Life | Accepted by |
|---|---|---|---|---|
| **Operator invite token** | Invite Access screen → `POST /operator/session` body `{ proof }` | `node tools/issue_operator_invite.js --user <uuid> --property <uuid> --minutes 120` | ≤ 1440 min | **the app login screen** |
| **Staff session token** | `x-staff-session` header | `node establish_qa_staff_session.js` | 12 h | curl / API |
| **Operator key** | `x-operator-key` header | `OPERATOR_KEY` env (`2026letsgo`) | n/a | non-`/operator/` routes |

> The login screen wants the **invite token** — not the session token, not `DEMO_ACCESS_CODE`. `issue_operator_invite.js` **blocks non-TTY output** so tokens cannot leak into logs; prefix `PSPINE_ALLOW_NON_TTY=1` if it refuses. It prints once; single-use; revocable.

## 4.6 Property scope

Derived from the authenticated session and validated against property-team membership and module entitlement on **every read and write**. The browser may *request*; it never determines who the actor is, what property they may operate in, what role they have, what module they may use, or what task they may own.

**Required session contract (S2):**
```
authenticated user ID · safe display name · role
authorized property ID(s) · active server-authorized property · property_name
module entitlements · session validity / expiration
```

**Source status:** `offlinePid()` reads the live session first and falls back to the picker only with no live session. `/operator/me` returns `allowed_modules` from the assignment. **Backend closed; browser proof owed.**

**The known bug (memory).** Logging in with an invite token showed only the Leasing desk; a hard refresh showed all desks. Invite login seeded `allowed_modules` from the token's embedded scope; hard refresh seeded an empty array which triggered a show-all default. **Neither path read server-authoritative entitlement.** The backend now exposes it — the frontend seeding still needs to be proven in a browser.

## 4.7 Record classification (076)

**Property-scoped.** The same person can be `internal_qa` in one property and `production` in another.

```
ABSENCE = UNCLASSIFIED, never silently production
Append-only supersession; record_class NEVER updated in place
```

Enforced centrally across reporting · leasing metrics · queues · the leasing desk · AI prompts. **Not** `is_test=true` scattered through screens.

> **REVISED 2026-07-26 — classification no longer gates eligibility.**
> This previously read: *"`internal_qa` is not `production`. With `SMS_SEND_MODE=customer_care`, `internal_qa` numbers receive no real texts."* That is no longer true, and the reason it changed matters more than the change.
>
> One field was deciding three independent things — whether someone could be **texted**, whether they were **application/activation eligible**, and whether they were **counted** — and two of those pointed in opposite directions. `customer_care` demanded `production`; `internal_qa_autonomous` demanded `internal_qa`. A person could be textable or leasable, never both, and every gate unjammed produced a new jam one step deeper.
>
> **Eligibility is now consent + property, everywhere.** Can we text them, send them an application, admit their tenancy — same two questions: did they say yes, and is this property switched on. `record_class` is consulted by none of those paths.
>
> **What `record_class` still does:** marks a record as a test context so it is excluded from metrics and hidden from the leasing desk. Bookkeeping, not permission. Reclassifying someone changes what they count toward; it does not silence or unsilence them.
>
> `internal_qa_autonomous` is **retired**. An unrecognised `SMS_SEND_MODE` falls to `disabled`, so the old value now silences a deploy entirely — check it first if sending goes quiet.

## 4.8 The staff ↔ person bridge (067)

A **separate identity fact**, Class 1. Used where the system must resolve actual-host attribution, task ownership, or relationship history to a durable person. `staffbridge.js` + `staff_identity_resolver.js`, audited in `user_person_bridge_audit`.

> A phone, name, or email may be **evidence** of identity. **None may silently create or merge that identity.**

