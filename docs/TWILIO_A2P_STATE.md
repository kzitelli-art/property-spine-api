# Twilio A2P 10DLC — state, and the three facts that took a day to find

**Current as of 2026-08-08.** Everything here was read from the Twilio
console and the owner's email archive, not inferred. Where something is
unverified it says so.

This file exists because the answers were not in the code. They were in a
month of support tickets nobody had re-read, and two of them reversed
decisions this session had already started acting on.

---

## The one-line state

**The campaign is approved. One number is not provisioned at the carrier.
That is the only thing blocking the SMS loop.**

```text
Brand      BN8b2e8b9ced62fad99229b3b2ef3cd3b8   Virtus Management LLC   APPROVED
Campaign   CM3bf1305946ba7ae088279e398fb8d738                           APPROVED 2026-07-14
Campaign   CM009d0800a10ec3cdb6af9fc2d8604349   CUSTOMER_CARE           REJECTED
```

---

## FACT 1 — there are TWO campaigns on one Brand, and only one matters

This is the trap. The console shows a **Rejected** campaign with two
scary error banners, and it is easy to conclude the program is blocked.
It is not.

`CM3bf1305946ba7ae088279e398fb8d738` was **approved and made fully active
on 2026-07-14**, Twilio ticket **#27984104**:

> "We are pleased to share that your campaign use case has been approved
> by the carrier ecosystem and it's now fully active. From now on, all
> SMS sent/received from the phone numbers **in the Twilio Messaging
> Service you used to register the campaign** will be routed as
> registered A2P messaging traffic."

The second campaign, `CM009d0800a10ec3cdb6af9fc2d8604349`, is assigned to
Messaging Service **Property Spine Operations**
(`MGc0a28adb7ea218bdc345db770fe94a1c`) and is rejected on:

- **30896** — opt-in information insufficient
- **30907** — provided website URL does not match the Brand and Campaign

**DO NOT RESUBMIT THE REJECTED ONE TO UNBLOCK MESSAGING.** It buys
nothing and costs a five-business-day review. Move numbers onto the
approved campaign's Messaging Service instead. Fix and resubmit the
second campaign only if the operations line genuinely needs its own.

---

## FACT 2 — 30024 and 30034 are different problems

Both look like "the number can't send" and both are fixed by Twilio
Support, but they are not the same and the distinction saves a day.

| Error | Means | Fix |
|---|---|---|
| **30034** | Sending from an **unregistered 10DLC number** — the number is not in a Messaging Service with a verified campaign | Move the number into the approved campaign's Messaging Service |
| **30024** | **Numeric sender ID not provisioned on carrier** — the number is in the right place but the carrier never provisioned it | Twilio Support must manually submit it for carrier registration |

**Precedent, ticket #28079259 (2026-07-12):** `+17243098434` failed the
same way. Twilio Support: *"the number was previously stuck in pending
carrier registration. I've taken the necessary steps to manually submit
it for registration, and it's now showing as registered."*

Moving a number between Messaging Services appears to be able to reset
its carrier provisioning — `+15413058509` was moved and then failed
30024 on every outbound.

---

## FACT 3 — how to tell where a failure actually is, in one look

`Twilio Console → Monitor → Logs → Messaging`, then read the pair:

```text
inbound Received, outbound attempted ~2s later   → the app is healthy;
                                                   the failure is the carrier
inbound Received, NO outbound at all             → the app declined to reply
                                                   (unresolved sender — see below)
no inbound at all                                → webhook/routing, not the app
```

The middle case is **by design**, not a bug. The operations line replies
only to a phone that resolves to an active user with an active
`property_team_assignments` row at a property in the line's organization
(`resolveStaffSenderForOrganization`, `communication_lines.js:195`). An
unknown handset gets silence, because the operations number must never
text someone it cannot identify.

---

## Numbers

```text
+12154452021   property-facing, Demo Building   delivering
+15413058509   operations line                  BLOCKED — 30024, ticket #28079259 reopened
+17243098434   test recipient                   carrier-registered manually 2026-07-12
```

---

## What is proven, and what is not

**Proven on real Twilio + real Neon** (Tom's session, 2026-08-06, and
this session's log reads): resident SMS → resident resolved → work order
created → auto-reply delivered. Operations line → staff resolved →
intent classified → reply generated and accepted by Twilio. PM
assignment through the canonical operator action. Inbound to the
operations line received and answered within two seconds.

**Not proven:** anything past the carrier on the operations line. No
technician has received a reply. Real-phone acceptance cannot complete
until 30024 clears.

---

## The A2P legal pages — live, and where they are

```text
https://property-spine-api.onrender.com/legal/privacy
https://property-spine-api.onrender.com/legal/sms-terms
```

Public and unauthenticated by requirement; a carrier reviewer fetches
them during vetting with no session and no key. They took **three**
fixes to become reachable, and the sequence is the lesson:

```text
1. file existed, never required by server.js     → 404
2. required, never in the public allowlist       → 401
3. allowlisted                                   → 200
```

Each fix was correct in isolation and each left the pages unreachable.
Only a request from outside the process proves a route is reachable —
both failures were found by the owner clicking a link, not by a test.

**These URLs are on `onrender.com`, which is why error 30907 fires.** A
carrier reviewer checks that brand name, website, email domain, campaign
description and sample messages all connect to one business, and an
infrastructure hostname connects to nothing. Twilio's own guidance
(Isa Bell, 2026-07-02) is to make the relationship obvious on
`onefivecap.com`. There are also older pages at
`propertyspine.com/sms-privacy.html` and `/sms-terms.html`.

**This only matters if the rejected campaign is resubmitted.** The
approved campaign does not depend on it.

---

## Open

1. **`+15413058509` carrier provisioning** — ticket #28079259, reopened
   2026-08-08. Everything else waits on this.
2. **`fix/technician-list-work-intent` (`797c1f9`) is UNMERGED.** The
   technician `list_work` regex does not match "what **work** do I
   have" — the natural phrasing, and the first thing anyone will text.
   It answers *"Which work order is this about?"* instead of listing the
   queue. **Merge before the acceptance run, not after.**
3. **The consent screen has never been loaded in production.** The page
   is confirmed to run (it rendered its error card for a bad token), but
   nobody has opened a real setup link and seen the checkbox.
4. **App `build-info.js` still stamps `9422d45`** (2026-07-30) while app
   `main` is `5f7ecf7`. A stamp branch was made on 08-06 and never
   pushed.
