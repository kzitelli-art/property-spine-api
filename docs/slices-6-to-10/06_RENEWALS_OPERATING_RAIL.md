# SLICE 6 — COMPLETE RENEWALS OPERATING RAIL

## Objective

Turn Renewals from an expiration cohort into a complete operating workflow:

```text
expiration approaches
→ accountable owner
→ governed economics
→ offer prepared
→ offer sent
→ waiting on resident
→ negotiation / decision
→ accepted / declined / notice
→ executed renewal
```

Slice 6 completes the operating rail. Slice 8 owns governed rent and concession policy.

## First deliverable — Renewals contract audit

Before implementation, return:

```text
current row population
current inclusion and exclusion rules
current stages and states
current owner fields
current due fields
current economics fields
current waiting-party fields
current actions
current correlations
current exit behavior
current home counts
```

Classify required fields as already canonical, available but not projected, requires canonical derivation, or unsupported/unresolved. Do not begin broad UI work until the audit is accepted.

## Required record contract

Each renewal relationship needs server-authored support for:

```text
renewal_id or stable relationship key
lease_id
resident_id / person_id
resident_name / person_name
unit_id
unit_number
current_lease_start
current_lease_end
days_to_expiration
renewal_stage
renewal_state_code
renewal_state_label
operating_state
accountable_user_id
accountable_user_name
assignment_state
responsibility_role
due_at
due_state
waiting_on
blocker_code
blocker_label
current_rent
proposed_rent
effective_change_amount
effective_change_percent
concession_summary
economics_source
economics_as_of
offer_id
offer_status
offer_sent_at
offer_expires_at
decision_status
notice_status
renewal_lease_id
primary_action { code, label, kind, target }
latest_activity_at
latest_activity_label
```

Unknown values remain null. Do not infer.

## Stage vocabulary

Recommended machine stages:

```text
approaching
decision_required
offer_preparation
offer_sent
resident_decision
execution
```

Use an existing canonical state machine if one already governs the domain. Do not create a second machine merely to match these labels. The API may return server-authored display labels.

## Operating states

Support explicit server-authored states:

```text
available
waiting
blocked
complete
```

Waiting-party vocabulary:

```text
resident
staff
external_evidence
```

Only emit values with a real authoring site.

## Ownership

Ownership must come from a canonical assignment. Do not present a role default as a named owner.

When unassigned:

```text
accountable_user_id: null
accountable_user_name: null
assignment_state: "unassigned"
```

A responsibility role may be shown separately.

## Due logic

Use one canonical renewal clock. Possible deadlines include decision deadline, notice deadline, offer preparation deadline, offer expiration, and execution deadline. Never emit overdue without an authored timestamp.

## Economics boundary

Slice 6 may display existing governed renewal economics. It may not invent a renewal price.

When no governed economics exist:

```text
proposed_rent: null
economics_source: null
```

The record remains visible with a blocker or action such as `Set renewal economics`. That action may route to Market & Pricing. It must not create browser-local pricing.

## Required actions

Use canonical commands or destinations for assign owner, review renewal, set/request economics, prepare offer, send/resend offer, record resident response, record notice, accept/decline renewal, prepare renewal documents, open renewal packet, and verify execution.

Do not duplicate pricing, lease, packet, or communication writes in the renderer.

## Home reconciliation

The Renewals card and Today in Leasing briefing must read the same projection as the destination. Server counts should include, when supported:

```text
total_active
due_today
overdue
unassigned
waiting
blocked
offer_sent
decision_required
```

Completed renewals must not remain in active totals.

## UI intent

The default screen answers:

```text
What needs action?
Who owns it?
When is it due?
Who are we waiting on?
What economics are proposed?
What is the next canonical action?
```

Do not lead with charts or cohort analytics. Filters are secondary.

## Exit behavior

A renewal exits active work only through a server-authored terminal state such as executed, declined, notice_received, moved_to_turnover, or closed. No optimistic browser disappearance.

## Excluded

Do not include full Market & Pricing, new pricing governance, rent survey, listing channels, Forward Rent Roll redesign, cross-domain ranking, application changes, or migration cleanup.

## Completion gate

Slice 6 closes only when:

1. Full active renewal population is represented.
2. Every row has a server-authored stage and state.
3. Ownership, due condition, waiting party, blocker, and action are explicit.
4. Existing economics are shown honestly.
5. Missing economics remain null and actionable.
6. Offer and resident-decision states remain visible while waiting.
7. Terminal states exit through the server.
8. Home and destination counts reconcile.
9. Failed reads and writes are browser-proven.
10. Production SHAs are confirmed.

## Required handback

```text
projection audit
API contract before and after
state-machine mapping
population reconciliation
economics-source audit
action-routing matrix
API branch and commit
App branch and commit
merged and deployed SHAs
test totals
real-Postgres proof
authenticated HTTP proof
desktop proof
390px proof
failed-read proof
failed-action proof
unsupported states
recommendation for Slice 7
```
