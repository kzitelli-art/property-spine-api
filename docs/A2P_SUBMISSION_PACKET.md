# A2P 10DLC — the submission packet, and who has to press submit

**Phase 0's only remaining blocker is a clock that does not start until a human
submits a form.** This is everything that can be prepared without credentials or
carrier approval, so that the person who does hold the Twilio account is filling
in fields rather than inventing answers.

**Nothing here needs engineering. Two fields need a decision, one needs a small
fix, and the rest is already true.**

---

## 1. The exact external action, in order

```text
A  Twilio Console → Messaging → Regulatory Compliance → A2P 10DLC
     submit the BRAND (the legal entity)                 ← starts the clock
B  submit the CAMPAIGN against that brand                ← $15 vetting fee
C  buy / assign a phone number to the operations line
D  attach the number to the approved campaign's Messaging Service
E  point the number's inbound webhook at
     POST {API_BASE_URL}/communications/inbound-sms
F  write provider_config on the operations communication_lines row
```

**A is the clock.** Brand approval is typically fast — The Campaign Registry
often returns a brand within minutes, and Twilio documents brand approval as
roughly 1–3 days. **Campaign vetting is the long pole**: Twilio documents up to
5 business days for standard use cases, and has recently reported 10–15 days
under load. Every one of those days is calendar time nobody can compress, and
none of it starts until step A is submitted.

**C–F are ours and take minutes.** They are not the blocker and should not be
scheduled as though they were.

## 2. Who must perform it

Not answerable from the codebase, and it should be named explicitly rather than
assumed. What the code does tell us:

- **The legal entity is `Virtus Management LLC`.** It is in the consent copy
  the resident actually agrees to (`src/comms/tenantlink.js`). The brand
  registration must match that entity, because the consent text already
  commits to it.

**So the owner is whoever can supply, for Virtus Management LLC:** the EIN
exactly as filed with the IRS, the registered legal name and address, and a
contact email on the company domain — and who has admin access to the Twilio
account. That is one person or two, and **naming them is the action item.**

A mismatch between the EIN and the legal name is the single most common cause
of brand rejection, and a rejected brand restarts the clock rather than pausing
it.

## 3. What is already true — verified in source, not assumed

### ✅ The two fields that became mandatory on 2026-06-30

Twilio now requires `PrivacyPolicyUrl` and `TermsAndConditionsUrl` on every
campaign registration, and **fetches both as part of the check** — they must be
publicly reachable HTTPS pages. Ours are ready:

```text
Privacy Policy URL        {APP_BASE_URL}/legal/privacy
Terms & Conditions URL    {APP_BASE_URL}/legal/sms-terms
```

Verified on **deployed `main`**, all three conditions that make them work:

- `src/identity/legal_routes_block.js` is present on `main`
- it is mounted in `server.js`
- `/legal/` is in `PUBLIC_PREFIXES`, so a vetting bot reaches it **without
  authentication**

It even ships `/legal/privacy.txt` and `/legal/sms-terms.txt` as plain-text
fallbacks, with the reason in its own header: *"in case a vetting bot dislikes
styled HTML."*

**Substitute the real host for `{APP_BASE_URL}` and open both in a private
window before submitting.** A page that renders for a logged-in operator and
404s for everyone else fails the fetch, and that failure reads as a rejected
campaign rather than a routing bug.

### ✅ STOP is handled in code

`communications_boundary.js` maps `stop · stopall · unsubscribe · cancel · end ·
quit` to `opted_out`, and `start · unstop · yes` back to `opted_in`. Opt-out
blocks **every** send, in every mode, for every purpose, ahead of all other
gates — including credential sends.

### ✅ Consent is explicit, written, and specific

The verified opt-in is a checkbox at tenant setup, tied to a phone number the
resident verifies. Its wording — quote this verbatim in the campaign's opt-in
description, because it is what the recipient actually agreed to:

> I agree to receive text messages from **[property]**, operated by Virtus
> Management LLC, about my tenancy — maintenance updates, account questions and
> building notices — at the mobile number I verify here. Message frequency
> varies. Message & data rates may apply. Reply STOP to opt out, HELP for help.
> See the SMS Terms and Privacy Policy.

## 4. ⚠ The one gap — HELP is promised and not answered

The consent copy says *"Reply STOP to opt out, **HELP for help**."*
`consentKeyword()` handles STOP and START. **There is no HELP branch.**

```text
STOP_KEYWORDS   stop · stopall · unsubscribe · cancel · end · quit   ✅ handled
START_KEYWORDS  start · unstop · yes                                 ✅ handled
HELP            advertised in the consent text                       ❌ no handler
```

Carriers test HELP during vetting, and we have promised it in writing to every
resident who ticked that box.

**Two ways to close it, and the first needs no code:**

1. **Enable Twilio Advanced Opt-Out on the Messaging Service** and set the HELP
   response there. The carrier layer answers before the webhook, so the promise
   is kept without a deploy. **Recommended — it is configuration, it belongs to
   the same person doing steps C–F, and it is done in the same sitting.**
2. Add a HELP branch beside `consentKeyword`. Small, but it is a code change on
   a rail we just froze, and it would need its own proof.

**This does not block submitting the brand.** Do it before the campaign goes
live, not before step A.

## 5. Campaign fields — drafted from what the code actually sends

Two campaigns, because the audiences and the consent bases are different. **The
operations campaign is the only one Step 4 needs.**

### Campaign 1 — operations line · staff coordination *(Step 4 depends on this)*

```text
Use case            Customer Care  (staff/vendor operational coordination)
Audience            maintenance staff and vendors of the operating company
Opt-in              employment / engagement relationship; the technician texts
                    the operations line first. The line is reply_only by
                    DATABASE CONSTRAINT — it cannot originate a message, so
                    there is no unsolicited-message path to describe
Volume              low; one thread per work order
```

Sample messages, from `src/technician/` — these are the deterministic
phrasings, not invented copy:

```text
"What would you like me to record for that one?"
"The resident will be notified"
```

### Campaign 2 — property-facing line · resident communication

```text
Use case            Customer Care  (property management / tenancy)
Audience            residents on an active lease who ticked the consent box
Opt-in              verified checkbox at tenant setup, against a phone number
                    the resident verifies. Quote §3's wording verbatim
Volume              varies; reactive to resident-initiated contact
```

Sample messages, from `src/comms/tenantlink.js`:

```text
"Hi [name] — this is [property] tenant line. Save this number for rent,
 maintenance, and building questions. Set up your secure link here: [link]"
```

**The campaign description must be 40–4096 characters** and must say who the
sender is, who the recipients are, and why the messages are sent. Write it from
the consent wording in §3 rather than freshly — the two must not disagree.

## 6. What must NOT happen at the same time

**Do not treat this submission as permission to turn resident messaging on.**
Production currently runs `SMS_SEND_MODE=customer_care` with Twilio credentials
present, so resident outbound is already armed. The Step 4 handset proof is
supposed to run with resident outbound **structurally dark**
(`SMS_SEND_MODE=disabled`), which leaves the technician path working because
`sendOperationsReply` does not consult the send mode.

That is a separate decision, recorded in `docs/OUTBOUND_TRIGGER_AUDIT.md` and
`docs/release0/PRODUCTION_RUN_CARD.md` §2. It is named here only so the two do
not get done in one careless sitting.

## 7. The honest summary

```text
BLOCKING, and owned by nobody yet
  name the person who holds Virtus Management LLC's EIN + Twilio admin
  submit the BRAND                                    ← starts the clock
  submit the CAMPAIGN                                 ← 5–15 days

READY, no work required
  Privacy Policy URL · Terms & Conditions URL         verified public on main
  STOP / START keyword handling                       in code
  consent wording                                     verbatim in §3
  the operations communication_lines row              exists and is active

SMALL, before the campaign goes live
  HELP response                                       Twilio Advanced Opt-Out

OURS, minutes, after approval
  number · Messaging Service · webhook · provider_config
```

**The engineering is not the constraint. A form is.**
