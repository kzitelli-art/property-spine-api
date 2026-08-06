# Release 0 — SMS transport prerequisite

**Read-only production check, 2026-08-06. Nothing was configured, created or
altered.** Disposition: **SMS PREREQUISITE ABSENT.**

---

## 1. What was actually read

The first check used a stale column name (`kind`) and failed before reading a
row: `ERR column "kind" does not exist`. **That proved nothing about the line
state** — it proved only that the query was wrong. Corrected against
`migrations/130_communication_lines.sql` and `132_outbound_line_policy.sql`
rather than against prose.

*Recorded because it is the same error class as the placeholder-password false
pass: a fact asserted without reading the source that governs it.*

### 1.1 Schema — confirmed present in production

```text
id · e164 · line_type · property_id · organization_id · authority_ceiling
permitted_audience · inbound_enabled · outbound_enabled · status
provider_config (jsonb) · created_at · updated_at · superseded_at · notes
outbound_policy
```

### 1.2 Line state — ONE row, redacted

`e164` and `provider_config` deliberately not selected; presence is enough.

```text
line_type          property_facing
authority_ceiling  external
permitted_audience residents_and_prospects
inbound_enabled    true
outbound_enabled   true
outbound_policy    proactive
provider_configured FALSE
status             active
```

**There is no `operations` row at all.**

---

## 2. Disposition

```text
operations line present               NO
operations provider configured        n/a — no row exists
operations inbound enabled            n/a — no row exists
property-facing provider configured   NO
property-facing inbound enabled       YES
```

**Two independent blockers, not one.** The handoff recorded the missing
operations row. It is worse than that: **`provider_config` is null on the only
line that exists**, so no carrier is wired to *either* lane. Nothing routes in
or out today, in either direction. That is the safe state, and it is also a
complete block on any real-handset test.

## 2.1 One thing to check at activation, not now

`property_facing` carries `outbound_policy = 'proactive'`. The database
constraint `ck_cl_outbound_policy_by_type` only restricts **operations** lines
to `disabled`/`reply_only`, so `proactive` on an external line is permitted.
With `provider_config` null nothing can send, so there is no live exposure —
but **the moment a provider is wired, that line may proactively text
residents.** Confirm that is intended before configuring, not after.

---

## 3. ⚠ Step 1 acceptance does NOT depend on this

The two things were coupled by an earlier assumption. They are separable, and
separating them unblocks the release.

```text
Step 1 acceptance needs   ONE work order visible to the operator
                          It does NOT need SMS.

SMS preflight needs       transport, which does not exist
                          It is a STEP 4 prerequisite, not a Step 1 one.
```

### 3.1 The supported creation path already exists

```text
POST /work-orders                     src/maintenance/maintenance.js:369
  → workOrderService.createWorkOrder  the canonical service
  → operator-gated (OPERATOR_KEY; not in server.js's public path list)
  → one transaction: work order + urgency truth + obligation + event
```

This is a **governed product path**, not a workaround. It is the same service
every other creation route calls. Creating the controlled acceptance work order
through it is not manufactured data — it is ordinary operator entry.

**It is explicitly none of the prohibited things:** not manual SQL, not a
temporary endpoint, not a hidden admin mutation, not a fixture loaded into
production, not direct status manipulation.

### 3.2 What it cannot prove

It proves the deployed app interprets a real current-API work-order payload.
It proves **nothing** about handset-to-attachment ingress. Those stay two
separate proofs with two separate receipts, and the SMS one is still owed
before step 4.

---

## 4. Activation packet — NOT AUTHORIZED, NOT PERFORMED

Required before any real-handset test. **No configuration was performed and
none should be until explicitly authorized.**

```text
LINE ROW
  line_type          'operations'
  authority_ceiling  operational
  permitted_audience staff
  inbound_enabled    true
  outbound_enabled   true
  outbound_policy    'reply_only'     ← ck_cl_outbound_policy_by_type ENFORCES
                                        disabled|reply_only for operations.
                                        The database carries the ruling.
  status             'active'
  property_id        the granted property
  Created as ORDINARY DATA. Not a migration. Not a script from tests/.

CARRIER / PROVIDER
  a provisioned inbound number for the operations line
  provider_config populated on that row
  provider_config populated on property_facing IF the resident lane is
    also to be used — confirm the 'proactive' policy first (§2.1)

WEBHOOK / ROUTING
  POST /communications/inbound-sms reachable from the carrier
  signature validation configured — the route rejects unsigned calls
  routing proven to reach the correct property

FIXTURES
  technician tester identity + property assignment + eligibility
  resident tester identity + SMS consent   (only if the resident lane is used)

CONTROLS
  POSITIVE  a signed inbound message reaches the route and is preserved
  NEGATIVE  an UNSIGNED call is rejected — proves the gate is live and the
            positive result is not a dead-open route

ROLLBACK / DISABLE
  set the operations row status to superseded, or clear provider_config
  neither requires a deploy

RECEIPT FIELDS
  line id · line_type · provider_configured (boolean only)
  inbound number NEVER recorded in the receipt
  webhook signature validation: proven yes/no
  positive control result · negative control result
```

---

## 5. Recommended sequence

```text
1  Create the controlled work order via POST /work-orders          ← unblocks now
     property: the operator's granted property
     description marker: RELEASE 0 CONTROLLED — DO NOT DISPATCH
     no emergency · no vendor · no billable · no resident identity
2  Run Step 1 browser checks 4-10 as ONE pass
3  STEP 1 COMPLETE, or STOPPED with the failure preserved
4  Isolated 100k-row scale and concurrency proof
5  SMS activation packet (§4) — separately authorized
6  SMS evidence-ingress preflight against the same work order
7  Only then: Step 2 / migration 137
```

Steps 1–4 are unblocked today. Steps 5–6 wait on transport that does not exist.

**Step 2 remains blocked** either way.

---

## 6. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This record | 1 — permanent | Never removed. It is the read-only production truth the transport decision was made from. |
| The controlled acceptance work order | 1 — real operating data | Not deleted, not cleaned up. Its disposition happens through a governed product path like any other work order. |
