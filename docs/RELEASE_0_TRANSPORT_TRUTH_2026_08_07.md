# Release 0 — production transport truth, 2026-08-07

**Read-only. No mutation, no rotation, no deployment.** Captured while
executing Gate 0 of the final transport build, which stopped here.

---

## 1. Both lines are ACTIVE and both numbers are WIRED AT TWILIO

```text
operations       active  ****8509  be0d860b-95f5-4477-a723-a5562f2d7797
property_facing  active  ****2021  daeca96d-f844-4f6c-a30a-34bbbc261f91

Twilio: BOTH numbers have smsUrl → property-spine-api.onrender.com
                                   /communications/inbound-sms  (POST)
Messaging service MG0cb8830b9d5ee17021541f15d69371fa
  inbound_request_url → the same route
  senders: ****2021  (property_facing only)
```

**`provider_configured` is FALSE on both, and both are live anyway.** The
runtime resolves a line on `e164 + status='active'` and reads credentials from
the environment. `provider_config` is decorative metadata that no code path
consults. The earlier reading of "no provider configured" never meant
"transport inactive", and this is the evidence.

## 2. The operations line

```text
authority_ceiling    operational
permitted_audience   staff
inbound_enabled      true
outbound_enabled     true
outbound_policy      reply_only
provider_configured  false
organization_id      6c580072-8501-4a1e-90fc-624ec93fba15
property_id          NULL          ← correct by design, see below
created_at           2026-08-07T03:33:52.520Z
notes                null
```

**It matches the Gate 5 target specification exactly**, with one deliberate
difference: `property_id` is NULL. That is correct. Migration 130's own comment
governs it — *"An operations line establishes ORGANIZATION context only — never
property context."* Gate 5's draft asked for the work order's property on this
row; the schema says otherwise, and the schema wins.

**Gate 5 is therefore already satisfied.** Creating a second line is both
unnecessary and impossible — `uq_cl_one_active_ops_line_per_org` refuses it.

## 3. The contradiction, resolved by a timestamp rather than a guess

```text
RELEASE_0_SMS_PREREQUISITE.md (2026-08-06)  "There is no operations row at all."
pre-deploy capture, this session            active operations lines: 0
this capture                                one active operations line
operations line created_at                  2026-08-07T03:33:52.520Z
```

All three readings are consistent **if the row was created after the capture
ran**, which its `created_at` supports. I had flagged my own count query as a
possible defect; the evidence says it probably was not. The row is simply
newer than the reading.

**Provenance, supplied by the owner after this capture:**

```text
Twilio wiring of both numbers   the OWNER, "along the way"
the operations line DB row      TOM, closing out a separate
                                "SMS work order 2" build
Tom's Twilio access             NONE
```

`notes` is null on the row, so none of this is recorded in the database. It is
recorded here instead.

### 3.1 ⚠ THE LIVE RAIL WAS ASSEMBLED BY TWO PEOPLE, NEITHER OF WHOM BUILT IT

Neither half is wrong. Together they are a live inbound rail that nobody
decided to switch on:

```text
owner  wired ****8509 and ****2021 at Twilio     — no DB row implied
Tom    created the operations line in the DB     — no Twilio access, so from
                                                   his side the number is not
                                                   wired and provider_config
                                                   is false
```

**This is the exact shape of an accidental production exposure**, and it is
worth naming as a class rather than an incident: two correct, partial actions
by two people who each had reason to believe the other half did not exist.

## 4. ⚠ Real SMS traffic exists, and predates all of this

```text
sms comm_events   15
first             2026-07-13T13:58:47.939Z
last              2026-08-07T03:19:29.030Z   ← 14 minutes BEFORE the
                                               operations line was created
```

The property-facing rail has been carrying real messages for roughly four
weeks. Direction (inbound vs outbound) was not captured and should be.

## 5. ⚠ Standing exposure — proactive resident SMS is now possible

```text
property_facing  outbound_policy   proactive
                 outbound_enabled  true
                 number in a messaging service sender pool
                 credentials present in the environment
```

`RELEASE_0_SMS_PREREQUISITE.md` §2.1 flagged this as a thing to confirm *before*
a provider was wired. A provider is wired. **Nothing structural now prevents an
outbound resident message** — only the absence of a code path that sends one.

`ck_cl_outbound_policy_by_type` restricts only *operations* lines to
`disabled`/`reply_only`. It permits `proactive` on an external line, so the
database will not stop it.

This is not a Release 0 change to make. It is a standing fact the owner should
decide about deliberately.

## 5.1 ⛔ IMMEDIATE HAZARD — a concurrent build is testing against this

Tom is closing out an "SMS work order 2" build **with a final test**, on the
same operations line, **without Twilio access**.

From Tom's side the database says `provider_configured = false`, which is the
same reading that led this project to conclude transport was inactive. It is
reasonable for him to believe a test is inert.

**It is not inert. Both numbers are wired and the credentials are live.**

```text
risk   a test Tom expects to write rows and stop could reach the carrier
       property_facing additionally carries outbound_policy = proactive
```

**Tom should be told before he runs the final test.** This is the one item in
this record that is time-sensitive.

### 5.2 Two builds now share one fixture

The operations line is simultaneously Tom's in-flight test fixture and Release
0's intended evidence rail. Release 0 must not supersede, reconfigure or
roll back that row — doing so would break another build mid-flight — and Tom's
test may move state Release 0 later depends on.

**Sequencing between the two builds is an owner decision.** Release 0 has not
touched the row and will not without one.

## 6. What this does to the final transport build

```text
Gate 0  credential containment      STOPPED — rotation touches a LIVE rail
Gate 5  operations-line activation  ALREADY DONE by someone else
```

The build was scoped as "activate transport." Transport is already on. The
remaining honest work is **characterisation and controlled proof against
existing live transport**, which is a different and more careful thing than
activation, and needs its own ruling.

## 7. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This record | 1 — permanent | Never. It is the production truth the transport decision was made from, and it corrects two earlier readings. |
