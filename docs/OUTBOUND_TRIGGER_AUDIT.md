# What event can put a text on a real phone?

**Asked before wiring a carrier**, because `property_facing` carries
`outbound_policy = 'proactive'` and the concern was that attaching a provider
would let activation accidentally initiate resident texts.

Answered from source, not from the column name. Kept true by
`tests/gate_outbound_senders.js` (10/10, every substantive assertion falsified).

---

## The short answer

**Nothing in the deployed server originates a resident message on its own.**
Every resident-facing send is either a human pressing a control or a reply to
something that person themselves just did. Exactly one proactive originator
exists in the codebase, and **nothing calls it** — no route, no scheduler, no
startup timer. It runs only when a human types `--send` on a command line.

## Two corrections to the premise, and they matter more than the answer

### 1. `outbound_policy` on `property_facing` restrains nothing today

`guard_line_outbound_policy` (migration 132) is a `before insert or update`
trigger on `comm_events`. Its first statement:

```sql
  if new.communication_line_id is null then
    return new;
  end if;
```

**No resident-path writer sets `communication_line_id`.** Only
`src/technician/conversation.js` and `src/technician/operator_actions.js` do —
the operations line. The resident writers (`agent.js`, `tenantlink.js`,
`leasingleads.js`, `leasinginteractions.js`, `applicationSubmission.js`,
`followup_runner.js`) never set it, so **the trigger returns early on every
resident send and never reads the policy at all.**

And even if it did fire, `proactive` is the branch that imposes nothing: the
guard constrains `disabled` and `reply_only`, then checks `person_id` only for
operations lines. `proactive` does not *enable* anything — it *declines to
restrain*, which is a different thing and reads the same in a column.

**Consequence: setting `property_facing.outbound_policy = 'reply_only'` would
refuse nothing and would create a false belief that a control exists.** That is
worse than leaving it alone. Asserted by S6.

### 2. The resident line does not come from `communication_lines` at all

```js
  async function propertyLine(q, propertyId) {
    const r = await q.query(`select sms_number from properties where id = $1`, [propertyId]);
    return r.rows.length ? r.rows[0].sms_number : null;
  }
```

The resident `from` number is `properties.sms_number`. The resident send path
**never reads `communication_lines`** — not its `provider_config`, not its
`status`, not its `outbound_enabled`, not its policy.

**Consequence: populating `provider_config` on the `property_facing` row does
not, by itself, enable resident sending.** Asserted by S7.

---

## So what actually arms resident messaging?

Three conditions, all of which must hold. None of them is the line row.

```text
1  SMS_SEND_MODE = customer_care     the master switch
     default when unset ............ disabled
     unknown / retired value ....... disabled  (fails closed, loudly)
     proof_only .................... only purpose='proof_text' to the single
                                     SMS_PROOF_CELL, plus credential purposes
                                     behind SMS_ALLOW_CREDENTIAL_SENDS=1

2  Twilio credentials present        smsReady() → sms.enabled()
     This is GLOBAL, not per line. Configuring Twilio for the operations
     line makes it true for the resident path in the same instant.

3  properties.sms_number populated   no number → no send, and never a
                                     Messaging Service default fallback
```

**Condition 2 is the one that couples Step 4 to resident messaging**, and it is
the real version of the concern that prompted this audit. It is not the policy
column — it is that there is one Twilio account behind both lanes.

### The isolation that makes Step 4 safe

`sendOperationsReply` **does not consult `sendMode()`** and does not call
`canSendSmsForRecord` (deliberately — there is no resident in a staff reply, and
passing a staff user through a resident consent gate answers the wrong question).
It resolves its line through `resolveOutboundLine`, which enforces `reply_only`,
and the database trigger refuses the row independently.

**Therefore `SMS_SEND_MODE=disabled` darkens every resident send while leaving
the technician reply path fully working.** That is the configuration Release 0
Step 4 should run in, and it is structural rather than remembered. Asserted by
S9, so it cannot be refactored away without the gate going red.

```text
STEP 4 RECOMMENDED POSTURE
  SMS_SEND_MODE                 unset, or explicitly `disabled`
  TWILIO_*                      configured
  operations line               created, provider_config populated
  property_facing               provider_config LEFT NULL
  properties.sms_number         whatever it already is — irrelevant while
                                the mode is disabled
```

Under that posture, the handset proof runs and **no resident send can succeed**,
because `canSendSmsForRecord` refuses at `send_mode_disabled` before it reads a
consent row. This does not depend on getting the line row right.

---

## Every way a message reaches a phone

18 send sites. Raw transport (`sms.sendSms`) is reachable from exactly one file
— `communications_boundary.js` — so no module can bypass consent, send mode,
quiet hours or the double-send guard (S2).

### PROACTIVE — the system originates it, nobody watching

| site | purpose | door |
|---|---|---|
| `src/leasing/followup_runner.js` | `followup` | **NONE** |

**It has no server-side caller.** No route mounts it, no scheduler exists in the
API, and `server.js` does not reference it (S5b). The only invocation is
`tools/run_followups.js`, where `dryRun` defaults true and `--send` must be
typed. Every send still passes the boundary.

It is also the only sender subject to **quiet hours** — `PROACTIVE_PURPOSES` is
`{followup, nudge, reengagement, campaign, tour_reminder}`, and the window is
08:00–21:00 local at the property, refused outright if the property's timezone
is unconfigured. The other four purposes in that set have no send site at all.

### OPERATOR — an authenticated human pressed a control

| site | purpose | door |
|---|---|---|
| `tenantlink.js` | `agent` | `POST /occupants/:personId/invite` · `POST /conversations/:id/reply` · `POST /work-orders/:id/notify-status` |
| `applicationSubmission.js` | `application_link` | `POST /leasing/application-invitations` |
| `teamaccess.js` | `staff_invite` | `POST /properties/:id/team-invites` |
| `leasinginteractions.js` | `ai_reply` \| `agent` | `POST /interactions/text` · `POST /operator/leasing/conversations/:id/reply` |
| `maintenance.js` | `work_order_update` | the four operator work-order actions |
| `maintenance.js` | *(operations reply)* | the four operator work-order actions |

An AI-drafted body on the Person Card still requires the human to press send.
The `ai_drafted` flag records **authorship, not autonomy**.

### REACTIVE — the recipient themselves just did something

| site | purpose | door |
|---|---|---|
| `agent.js` | `ai_reply` | `POST /agent/inbound` |
| `tenantlink.js` | `ai_reply` | `POST /communications/inbound-sms` |
| `tenantlink.js` | `work_order_update` | `POST /communications/inbound-sms` |
| `tenantlink.js` | `otp` | `POST /tenant/setup/request-code` |
| `teamaccess.js` | `staff_otp` | `POST /auth/sms/start` |
| `leasingleads.js` | `leasing_first_response` | `POST /leasing/intake` (secret-gated) · `POST /demo/intake` (`DEMO_MODE` only) |
| `applicationSubmission.js` | `application_link` | `GET /t/application/:token` — the applicant opened their own link |
| `tenantlink.js` | *(operations reply)* | `POST /communications/inbound-sms` |

---

## What every resident send must clear, in order

```text
0   already on the wire?          an event carrying a provider SID, or a
                                  completed send status, is never re-sent
0b  transport configured?         no → transport_not_configured
0c  property line resolvable?     no → no_property_line. Never a fallback.
1   quiet hours                   proactive purposes only, before consent —
                                  a 2am send never even reads a consent row
2   consent                       opted_out / stop / revoked blocks
                                  EVERYTHING, every mode, every purpose
3   send mode                     disabled → refuse all
                                  proof_only → the proof aperture only
4   customer_care                 person record must exist
                                  relationship at THIS property required
                                  consent must be exactly `opted_in`
                                  (unknown consent = refusal; no row = refusal)
```

Credential purposes (`otp`, `staff_otp`, `staff_invite`) skip the opt-in
requirement — a person who asked for their own sign-in code has asked — but
`opted_out` still blocks them at step 2, ahead of everything.

---

## What is NOT proven here

- **Nothing about production data.** This is a source audit. Whether
  `properties.sms_number` is populated, what `SMS_SEND_MODE` is set to on
  Render, and whether any person is `opted_in` are production reads, and this
  session has no production access.
- **Nothing about the app repo.** The browser cannot originate a send except
  through these API doors, but that is an inference from the route list, not a
  measurement of the app.
- **Nothing about `property_channel_capabilities`.** Migration 094's five
  capabilities are read by `propertyHasCapability` and are **deliberately not
  yet an AND-clause** in the eligibility gate — wiring them today would refuse
  every send at the one property that works, because no property holds a row.
  It is a governed authority rail that is built and not yet load-bearing.

## The one thing to decide before configuring a carrier

Not the policy column — it does nothing. The decision is:

> **Do we set `SMS_SEND_MODE` at the same time we configure Twilio?**

If the answer is no — and for Step 4 it should be no — then resident messaging
stays dark through the entire handset proof, by a gate that fails closed, and
the `property_facing` line row can be left exactly as it is.
