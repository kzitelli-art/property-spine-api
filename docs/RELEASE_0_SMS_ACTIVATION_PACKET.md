# Release 0 — SMS evidence-ingress activation packet

**Disposition: SMS ACTIVATION PACKET STOPPED.**

```text
production mutation performed   NO
provider configuration changed  NO
real SMS sent                   NO
carrier webhook configured      NO
operations line created         NO
property-facing line touched    NO
```

**Two stop conditions are hit. One is an implementation prerequisite that no
amount of configuration can work around.**

```text
STOP  media can arrive without durable digest/size metadata      §1.4
STOP  work order 1006 cannot be resolved from a handset message  §4.2
```

The rest of the packet is complete and is preserved, because the audit is
worth keeping and everything except those two items is ready.

---

## 1. Provider contract

### 1.1 Supported provider — Twilio, and only Twilio

`src/comms/sms.js` is the whole transport module. It `require("twilio")`
(`^5.3.0`, already a dependency) and exports **exactly three** things:

```text
enabled()          → !!client
sendSms({to,from,body})
validateWebhook(req)
```

**There is no second provider path and no provider abstraction.** A provider
other than Twilio would be a new integration, which this authorization
excludes.

### 1.2 Environment variables

```text
TWILIO_ACCOUNT_SID            required to enable    owner must provision
TWILIO_AUTH_TOKEN             required to enable    owner must provision
                              ALSO signs webhooks — one secret, two jobs
TWILIO_MESSAGING_SERVICE_SID  optional              not required for Release 0
APP_BASE_URL                  see §1.3              developer must configure
```

No secret value appears in this packet or in any command it contains.

### 1.3 Inbound signature validation — present, fail-closed, and it has a trap

`src/comms/sms.js:62`, called at `src/comms/tenantlink.js:1206` **before any
domain work**.

```text
algorithm      Twilio HMAC-SHA1 over URL + sorted POST params
               (twilio.validateRequest)
header         x-twilio-signature          absent → false
body encoding  application/x-www-form-urlencoded, parsed by
               express.urlencoded({extended:false, limit:"100kb"}) BEFORE the
               handler — validateRequest needs the parsed body
replay window  NONE. Twilio's scheme has no timestamp. Replay protection comes
               from MessageSid idempotency downstream, not from the signature.
failure mode   403 "Invalid signature", zero rows written
no token       returns false — fails closed, never open
```

**⚠ THE URL TRAP.** The signature is computed over the request URL. The code
prefers `APP_BASE_URL` and falls back to `${req.protocol}://${req.get("host")}`.
Behind Render's proxy the fallback can reconstruct a URL the carrier never
signed — most often `http` instead of `https` — and **every inbound message
fails validation** with a correct-looking 403.

```text
APP_BASE_URL must be set to the EXACT public https origin Twilio is
configured to call, with no trailing slash, or the negative control (§5 C)
will pass for the wrong reason and the positive control will never fire.
```

Classified: **developer must configure**, before activation, not during.

### 1.4 ⛔ MEDIA INGESTION — THE ROUTE HAS NO WAY TO FETCH IT

This is the blocking finding.

`src/technician/evidence_service.js` is well built. `ingestProviderMedia`
records a `referenced` row first, then tries to preserve the bytes:

```js
// evidence_service.js:80
if (typeof fetchMedia !== "function" || !provider_media_url) {
  //  No way to preserve it. Say so rather than implying we have it.
  return { outcome: "referenced", attachment: row };
}
```

`fetchMedia` is **injected**, deliberately, so the module never opens a socket.
The route supplies it here:

```js
// tenantlink.js:1273
{ fetchMedia: sms && typeof sms.fetchMedia === "function" ? sms.fetchMedia : null }
```

**`sms.fetchMedia` does not exist.** §1.1 lists the module's complete export
surface. A repo-wide search finds `fetchMedia` in exactly three files — the two
that consume it and the one line that passes `null`. Nothing implements it.

```text
grep -rn "fetchMedia" src/
  src/technician/conversation.js:144      consumes
  src/technician/evidence_service.js:80   consumes
  src/comms/tenantlink.js:1273            passes null
```

Confirmed against **deployed `origin/main`**, not just this branch:
`src/comms/sms.js` on `origin/main` contains zero occurrences of `fetchMedia`.

The same gap is acknowledged elsewhere in the codebase, which is what makes it
a known state rather than an oversight:

```js
// src/onboarding/intake.js:339
"Media lives at the carrier and isn't fetched yet."
```

**The consequence, traced to the end:**

```text
technician sends a real photo
  → ingestProviderMedia writes storage_state = 'referenced'
     content NULL · byte_size NULL · sha256 NULL · stored_at NULL
       (the table's CHECK forbids those being set unless state='stored',
        so a partial store is not even representable)
  → preservedEvidenceFor counts ONLY storage_state='stored'  → 0
  → claimCompletion: COMPLETION_REQUIRES.evidence && preserved.length === 0
  → closed: false, missing: "repair_photo"
```

**The evidence-ingress proof cannot pass.** The system would behave *honestly*
— it would say a photo was referenced but not preserved — and that honest
answer is exactly the wrong outcome for a proof whose subject is durable
evidence.

**This is an implementation prerequisite, not a configuration step.** It is new
code (an authenticated media fetch with size cap, MIME re-check and digest),
and this authorization does not cover writing it.

### 1.5 Inbound media fields the carrier does send

Present and already parsed — `tenantlink.js` `twilioAttachments()`:

```text
NumMedia          count
MediaUrl{n}       provider URL      → provider_media_url
MediaContentType{n}  MIME           → mime_type, checked against ALLOWED_MIME
provider media id the trailing path segment of MediaUrl — kept so a
                  redelivery is idempotent on the PROVIDER's identity
MessageSid        provider message identifier → provider_message_id
```

So MIME does arrive. **Digest and byte size cannot**, because there are no
bytes.

### 1.6 Delivery / retry

```text
inbound   Twilio redelivers on non-2xx. The route ACKs with empty TwiML before
          slow work and suppresses duplicates on MessageSid (23505 →
          "duplicate suppressed"). Idempotency is on the provider's identity.
outbound  sendSms returns a receipt and never throws; delivery status arrives
          separately and is never inferred from the send.
```

---

## 2. Route and runtime audit

Every stage, with its source and its honest status.

| # | Stage | Source | Status |
|---|---|---|---|
| 1 | carrier webhook → route | `tenantlink.js:1198` `POST /communications/inbound-sms` | **implemented and reachable** — in `PUBLIC_EXACT`, correctly not operator-gated |
| 2 | transport-ready check | `tenantlink.js:1202` `smsReady()` | **implemented** — 503 when unconfigured |
| 3 | signature validation | `tenantlink.js:1206` → `sms.js:62` | **implemented, fail-closed** — see the §1.3 URL trap |
| 4 | line resolution | `communication_lines.js:118` | **implemented** — `e164 = $1 and status = 'active'` |
| 5 | property / organization resolution | `communications_boundary.resolveInboundSmsContext` | **implemented** — an operations line establishes ORGANIZATION only, never property |
| 6 | technician identity resolution | `ctx.staffOutcome !== "one"` → zero rows, no reply | **implemented** — unresolved or ambiguous sender writes nothing |
| 7 | work-order resolution | `conversation.js:82` `candidateWork` + `work_reference.resolveWorkReference` | **implemented but unusable for 1006** — see §4.2 |
| 8 | media ingestion | `evidence_service.js:47` `ingestProviderMedia` | **implemented but dormant** — `fetchMedia` is never supplied |
| 9 | durable storage | `evidence_service.js:105` | **MISSING** — unreachable without stage 8 |
| 10 | attachment metadata | `work_order_proof_attachments` | **partial** — MIME + provider ids yes; digest, size, bytes no |

### 2.1 Production deployment status

```text
route deployed on origin/main                    YES
signature validation deployed                    YES
media fetch deployed                             NO — does not exist anywhere
```

**Activation would NOT require an API deploy to accept a signed inbound
message.** It WOULD require one to preserve media, because that code has to be
written first.

### 2.2 Completion safety — the route cannot complete without a command

`conversation.js` maps intent → action. `claimCompletion` is called at
`:259` **only** under `intent === "complete"`. Media ingestion (`:236`) and
completion (`:259`) are separate branches: a photo alone records evidence and
nothing else.

```text
route can alter completion state without a completion command   NO
```

And `claimCompletion` still refuses to close without preserved evidence, so
even a completion command would leave the work order open under §1.4.

---

## 3. Operations-line specification — NOT CREATED

### 3.1 The intended row

```text
line_type          'operations'
authority_ceiling  'operational'
permitted_audience 'staff'
inbound_enabled    true
outbound_enabled   true
outbound_policy    'reply_only'      ← ck_cl_outbound_policy_by_type ENFORCES
                                       disabled|reply_only for operations.
                                       The database carries the ruling.
status             'active'
property_id        a50fbdd0-3642-431e-b532-0dcd6ab8a4fe   (1006's property)
organization_id    derived from the property — MUST be read, never typed
e164               owner-provisioned, canonical +1XXXXXXXXXX
provider_config    see §3.3
```

### 3.2 The governing constraints, read from migration 130

```text
uq_communication_lines_active_e164
  unique (e164) where status='active'
  → one active line per number, globally

uq_cl_one_active_ops_line_per_org
  unique (organization_id) where line_type='operations' and status='active'
  → ⚠ ONE ACTIVE OPERATIONS LINE PER ORGANIZATION, NOT PER PROPERTY
```

**Answering the questions directly:**

```text
May two active operations lines exist for one property?
  NO — and the constraint is stricter than the question. Scope is
  ORGANIZATION. One active operations line per organization, full stop.

What uniqueness governs the row?
  uq_cl_one_active_ops_line_per_org, plus global active-e164 uniqueness.

How is supersession represented?
  status moves off 'active' (superseded_at is recorded alongside). Both
  partial indexes are `where status='active'`, so a superseded row stops
  competing for uniqueness and a replacement can be inserted.

Does clearing provider_config safely disable routing?
  NO. Inbound resolution reads `e164 = $1 and status = 'active'`
  (communication_lines.js:118). provider_config is NOT consulted. Clearing it
  would leave the line fully routable for inbound.

Does status <> 'active' alone prevent inbound resolution?
  YES. The line falls to the `inactive` branch, the route returns empty TwiML
  and ZERO rows are written.

Which disable operation is authoritative?
  ⇒ status. It is the only field the runtime honours.
```

**The rollback must move `status`.** A packet that told the owner to clear
`provider_config` would leave the number live and read as safe.

### 3.3 provider_config schema — NOT ESTABLISHED FROM SOURCE

Searched: migration 130, `communication_lines.js`, `communications_boundary.js`,
`sms.js`. `provider_config` is a `jsonb` column that is **stored and read for
presence only**. No code parses its keys; the transport reads
`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` from the environment instead.

```text
provider_config schema established from source   NO
```

That is not a stop on its own — presence is all the column is used for — but
**inventing a key layout would be fabricating a contract.** It must be ruled,
not guessed. Recommended minimum, to be confirmed by the owner:

```text
{"provider":"twilio","configured_at":"<iso8601>","configured_by":"<name>"}
```

No SID, token, or number in the column. Credentials belong in the environment,
which is where the code already reads them.

---

## 4. Technician tester fixture

### 4.1 What I can and cannot answer

**I have no production database or API egress from this container.** The
fixture questions require a read against production, which is an owner action.

```text
technician fixture ready       UNKNOWN — owner must run §7 D-1
identity resolution unique     UNKNOWN — owner must run §7 D-1
property assignment valid      UNKNOWN — owner must run §7 D-1
work order 1006 eligible       NO — determined from source, see §4.2
```

Reporting these as "ready" without the read would be the exact false pass this
release keeps finding. The read-only query is in §7 D-1 and returns booleans
and counts only — **no phone number in output**.

### 4.2 ⛔ WORK ORDER 1006 IS NOT ELIGIBLE

Determined from source and from 1006's own creation receipt.

```js
// conversation.js:82 — candidateWork
where o.assigned_user_id = $1 and o.related_type = 'work_order'
  and o.property_id = any($2::uuid[]) and o.status in ('open','in_progress')
  and w.status <> 'complete'
```

Work order 1006's routing obligation `5505f4c6-a523-4995-afe0-57c92c74b864`
was created with:

```text
assigned_role      maintenance
assigned_user_id   NULL          ← honest UNASSIGNED, by design
```

**`assigned_user_id = NULL` matches no technician**, so `candidateWork` returns
an empty list and the handset message resolves to nothing. The technician would
get the "no work assigned" path, not work order 1006.

**This is fixable through an existing governed product path** — the Work Orders
door's `Assign` control (`data-act="assign"` → `workOrderAssign`), which is
exactly how a real work order gets an owner. It is a prerequisite, not a
defect.

---

## 5. Positive and negative controls — DESIGNED, NOT RUN

Order is fixed. **The negative control runs first**, so a dead-open route
cannot masquerade as success.

```text
A  pre-activation truth read      counts + line inventory, read-only
B  create/configure operations line   ONE mutation, with read-back
C  ⚠ NEGATIVE FIRST — unsigned webhook must be REJECTED (403)
      and must write ZERO rows
D  signed NON-media inbound accepted and attributed
      → comm_event exists, staff identity resolved, correct property
E  real handset IMAGE against work order 1006
F  durable attachment + metadata      ← CANNOT PASS TODAY (§1.4)
G  no completion command was issued
H  no work-order completion facts changed
I  disable transport — status off 'active'
J  prove inbound no longer routes (repeat D, expect zero new rows)
K  restore only if the release sequence requires the line to remain active
```

### 5.1 The handset message format — no completion language

The message must identify 1006 without claiming work was performed.

```text
SEND EXACTLY:      ref 1006 photo
```

`ref <n>` is a work reference, not an intent. It must **not** contain "done",
"finished", "complete", "fixed" or "closed" — `conversation.js` maps those to
`intent === "complete"`, which calls `claimCompletion` and records a technician
claim that nobody performed. §5 G/H exist to prove that did not happen; the
message format exists so it cannot.

### 5.2 What F would actually show today

```text
expected today   storage_state = 'referenced'
                 byte_size NULL · sha256 NULL · stored_at NULL
required to pass storage_state = 'stored' with all four facts present
```

---

## 6. Evidence-ingress receipt template

**Record:**

```text
API deployed SHA · activation timestamp · line id · property id
provider configured (boolean only) · operations policy (reply_only)
signature negative control result · signed positive control result
provider message id · communication event id
work_order_id · attachment_id · storage_state · MIME type · byte size · digest
technician identity resolved (boolean) · completion command sent: no
status before and after
completed progress-event count before and after
proof-evaluation count before and after
resident communication produced: no
rollback/disable result
```

**NEVER record:**

```text
inbound phone number · provider token · webhook secret
full provider_config · image contents · technician personal phone
```

---

## 7. Owner run sheet — BLOCKED AT B, USABLE THROUGH A AND D-1

Each section is separately stoppable. Nothing is combined into one opaque
script. **Secrets are referenced from the environment and never echoed.**

### OWNER ACTION — before anything

```text
O-1  provision a Twilio number for the OPERATIONS line
O-2  set in Render, without echoing:
       TWILIO_ACCOUNT_SID · TWILIO_AUTH_TOKEN
       APP_BASE_URL = the exact public https origin, no trailing slash  (§1.3)
O-3  rule the provider_config key layout (§3.3) — do not let it be guessed
O-4  assign work order 1006 to the technician tester using the Work Orders
     door's Assign control (§4.2). A governed product action, not SQL.
```

### DEVELOPER READ-ONLY VERIFICATION

**A-1 — line inventory. Read-only. `e164` and `provider_config` NOT selected.**

```bash
psql "$DATABASE_URL" -c "
  select line_type, authority_ceiling, permitted_audience,
         inbound_enabled, outbound_enabled, outbound_policy,
         (provider_config is not null) as provider_configured, status
    from public.communication_lines order by line_type;"
```

```text
EXPECT   exactly one row, property_facing, provider_configured false
REFUSE   any operations row already present → STOP, §3.2 permits only one
         active per organization
```

**D-1 — technician fixture. Read-only. Booleans and counts only.**

```bash
psql "$DATABASE_URL" -c "
  select
    (select count(*) from public.users u
      where u.id = '<TESTER_USER_ID>' and u.is_active and u.status='active')
        as tester_active,
    (select count(*) from public.property_team_assignments pta
      where pta.user_id = '<TESTER_USER_ID>'
        and pta.property_id = 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'
        and pta.active) as property_assigned,
    (select count(*) from public.obligations o
      where o.related_type='work_order'
        and o.related_id = 'f9fd039d-6e91-46af-a5d5-57b671024a27'
        and o.assigned_user_id = '<TESTER_USER_ID>'
        and o.status in ('open','in_progress')) as wo_1006_eligible;"
```

```text
EXPECT   tester_active 1 · property_assigned 1 · wo_1006_eligible 1
TODAY    wo_1006_eligible will be 0 until O-4 is done (§4.2)
```

**A phone-uniqueness check is deliberately not scripted here**, because the
column that carries it must be confirmed first — writing a query against a
guessed column is the error class this release has already recorded twice.

### PRODUCTION MUTATION — ⛔ DO NOT RUN

```text
BLOCKED by §1.4. Creating the line and pointing a carrier at it would produce
a live inbound route that CANNOT preserve evidence. The proof would fail after
the mutation instead of before it.
```

The mutation, its precondition, read-back, refusal and rollback are drafted and
will be released **only** after the media-fetch prerequisite is closed and the
owner authorizes the session.

### REAL HANDSET ACTION · POST-ACTIVATION PROOF · ROLLBACK

Blocked by the same prerequisite. The rollback mechanism is settled and is
recorded now so it cannot be improvised later:

```text
ROLLBACK IS:      update communication_lines set status='superseded',
                  superseded_at = now() where id = <line id>
ROLLBACK IS NOT:  clearing provider_config — the runtime does not read it for
                  inbound resolution (§3.2) and the line would stay live
VERIFY:           re-run control D and prove ZERO new comm_events
```

---

## 8. What is required to reach READY

```text
1  IMPLEMENT sms.fetchMedia({url, mime_type}) → {ok, buffer, mime}
     · authenticated to Twilio (the media URL requires account credentials)
     · size cap enforced BEFORE buffering — evidence_service checks after,
       which is too late to protect memory
     · MIME re-checked from the response, not trusted from the webhook
     · returns {ok:false, reason} rather than throwing, per the contract
       evidence_service already expects
2  PROVE it against a real fetch in an isolated harness, with a negative
   control for an unauthenticated fetch and one for an oversized body
3  DEPLOY it — activation cannot preserve evidence until this is live
4  O-4: assign work order 1006 to the tester through the governed Assign
5  Re-run this packet's audit and re-issue it as READY
```

Item 1 is **new product code and is not authorized by this preparation gate.**

---

## 9. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This packet | 1 — permanent | Never. It is the record of what the transport contract actually was before activation. |
| The run sheet's blocked sections | 3 — temporary | Released when §8 closes and the owner authorizes the session. |

---

**SMS ACTIVATION PACKET STOPPED.**

The property-facing line was not touched. Resident outbound communication
remains impossible: no provider is configured on any line, and the operations
line does not exist.
