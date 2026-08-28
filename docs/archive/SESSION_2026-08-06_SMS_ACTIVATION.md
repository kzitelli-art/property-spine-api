# Session record — 2026-08-06 (late) → 2026-08-07

**SMS work-order loop exercised end-to-end on Demo Building; the app-broken
handoff was retracted; the Render static-site publish root was purged.**

This file is a durable record of production changes made in this session. Most
were **data/config changes on production Neon and Twilio** — not code — so they
do not appear in any PR. Read this alongside `THREAD_HANDOFF.md`.

> Authority note: everything below was read from `origin/main`, the Render API,
> the Twilio API, and production Neon at the time of writing. Where a claim is
> `Proven` vs `Browser/phone-verified` (§33) it is labelled. Do not upgrade a
> rung without the matching evidence.

---

## 1. Item #1 — the "broken app" was already fixed and deployed

The `THREAD_HANDOFF.md` "⛔ DEPLOYED APP IS BROKEN" section was **stale**.

- `work-lifecycle-door.js` at app `main` (`5f7ecf7`) already defines `proofOf`
  (l.96) and `proofSentence` (l.110) at IIFE top level — the repair described by
  `44379d5`. `git diff 44379d5 HEAD -- work-lifecycle-door.js` is empty.
- Render's deploy list shows `5f7ecf7` **live** (finished 2026-08-06 18:30Z) and
  the broken `8cbfd1a` **deactivated**.

**Action taken:** added a winning "✅ THE APP IS FIXED AND DEPLOYED" section to
`THREAD_HANDOFF.md` (commit `cf2a73f`, API branch `docs/handoff-app-fixed-deployed`)
and stamped `build-info.js` to `5f7ecf7` (app branch
`chore/stamp-build-info-5f7ecf7`). **Still NOT browser-verified** — clicking a
real work-order detail on the live app remains the honest completion bar.

---

## 2. Item #2 — Render static-site publish root PURGED

Nine deleted seed/rent-roll files were still served (HTTP 200, real payloads)
from `property-spine-app.onrender.com` even though absent from git — the
handoff's "worst trap" (repo absence ≠ deployed absence).

**Verified live** with a never-existed control path (404) proving the 200s were
real files, not a catch-all rewrite.

**Fix (permanent).** The static site had `buildCommand: ''` / `publishPath: '.'`,
so deploys never pruned deleted files. Changed via the Render API to:

```
buildCommand : rm -rf dist && mkdir dist && git archive HEAD | tar -x -C dist
publishPath  : dist
```

The publish dir is now rebuilt from the git-tracked tree every deploy, so any
file deleted in git disappears from the served site. Triggered a cache-cleared
deploy. **Verified:** all 9 paths now return 404; control path 404; app + all
door modules still 200.

> ⚠ The reclassification worth carrying: the handoff called these files
> "synthetic fixtures, not a breach." The *live* rent-roll file self-labels
> "contains resident names and property financial information… do not publish,"
> and held 843 realistic names. Treated as **potentially live PII** and purged
> on that basis. Do not downgrade to "synthetic" without inspecting contents.

---

## 3. Item #3 — SMS loop exercised on Demo Building (NOT Solo)

The activation packet targets **Solo on Chestnut**, but its `communication_lines`
are empty and it has no carrier wiring. **Demo Building** is the only property
with SMS scaffolding, and `ACTIVATION_PROPERTY_IDS` / `SMS_QA_PROPERTY_ID` both
already point at it. So this session exercised the loop on **Demo Building
(`a50fbdd0-…`)** as the live test context — a §17 tension (resident on the demo
property) accepted deliberately for the test and marked in the data.

### 3.1 Production DATA created (Neon) — all reversible

| What | Detail |
|---|---|
| Person **Michele Aweeky** | `4b755cb1-…` · phone `+19085103158` · created via the real funnel lead→applicant→tenant (genuine `inquiry` + two `lifecycle_change` events) |
| Text consent | `contact_preferences` text = `opted_in` (staff-controlled handset) |
| Property relocation | her `inquiry` event repointed Solo on Chestnut → Demo Building; a `note` event records the relocation |
| Active lease | `8a903d01-…` · space in **unit 631** (was unleased) · Michele in `tenant_ids` |
| Used tenant-invite | `3122941c-…` · `status='used'` |
| Organization wiring | **Tom** (`5ee50499-…`) and **Demo Building** attached to **Demo ORG** (`6c580972-…`); Tom now resolves as staff-sender by phone `+18626683053` |
| Operations line | `be0d860b-…` · `operations / operational / staff / reply_only / active` · org-owned · number `+15413058509` |
| PM assignment | work order **`9053599d` "Broken Toilet Repair"** assigned to Tom via the real `assignWork` action (`ownership_origin=operator_assigned`) |

> The lease + used tenant-invite were required because the inbound resolver
> (`communications_boundary.js` ~l.800) recognises a resident ONLY through an
> active lease + a `used` tenant_invite — a `persons.lifecycle_status='tenant'`
> flag alone does NOT make someone resolvable. This is correct §12 behaviour.

### 3.2 Twilio CONFIG changed

- `+12154452021` — property-facing line for Demo Building. Inbound webhook
  already → `/communications/inbound-sms`. **Registered / delivers.**
- `+15413058509` — was pointed at Twilio's demo URL (0 prior messages, safe
  spare). **Repointed** inbound webhook → `/communications/inbound-sms` and
  adopted as the **operations line** number.

### 3.3 What is PROVEN vs BLOCKED

**Proven working (real HTTP + real Twilio + real Neon):**

- Resident SMS (`+12154452021`) → resident resolved → **work order created** →
  auto-reply to resident **`delivered`**.
- Operations line (`+15413058509`) → **staff resolved** (Tom, via Demo ORG) →
  intent classified → reply generated and accepted by Twilio.
- PM assignment through the canonical operator action.

**Blocked at the CARRIER — not code, schema, or wiring:**

- Operations-line **outbound is `undelivered`, Twilio error `30034`** (US A2P
  10DLC: sending from an **unregistered** 10DLC number). The property line
  `+12154452021` delivers because it is registered in the A2P campaign /
  Messaging Service; `+15413058509` is not. Registering it (or adding it to the
  registered Messaging Service sender pool) is Twilio-console work. Until then,
  the technician receives no replies even though every app-side step succeeds.

**Design finding (not a bug):** assigning a work order sends **no** text. The
operations line is `reply_only` (DB-enforced: `ck_cl_outbound_policy_by_type`),
so the model is pull-not-push — the technician texts in (`what do I have`) and
the system replies. There is no dispatch push by design.

---

## 4. Code finding → the one code change in the PR

The technician `list_work` intent regex in
`src/conversation/technician_intent.js` does **not** match the natural phrasing
**"what work do I have"** (the noun "work" between "what" and "do i" breaks
`/\bwhat\s*(?:do\s*i|am\s*i)\s*(?:have|working)/i`). The system replied "Which
work order is this about?" instead of listing the queue. The packet's exact
"what do I have" does match. Widened the pattern to accept the natural variants.
This is the only product-code change; see the PR.

Also hardened `.gitignore` (`.env.*`) after a live-secret `.env.fresh` was
created locally and found not to be ignored.

---

## 5. Reversal / cleanup notes

All §3.1 rows are ordinary data and reversible by id. The org attachments
(Tom, Demo Building → Demo ORG) have portfolio-scope implications and should be
reviewed if Demo Building is not meant to carry org context. The Twilio webhook
repoint on `+15413058509` can be reverted to the demo URL. None of this touched
the API service, migrations, or schema.
