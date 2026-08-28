# Production verification — pricing safety guards

**2026-07-27. Commit `562e9f6`, live on Render.** Owner-authorised route 2: temporarily
disable auto-dispatch, run one real HTTP agent turn in review mode, restore immediately.

Claim vocabulary is used exactly. Nothing below is called Proven that was not exercised
against real Postgres over real HTTP.

---

## 1. Environment handling — before · temporary · restored

| Stage | `AGENT_AUTO_DISPATCH_PROPERTY_IDS` | Deploy |
|---|---|---|
| **Before** | `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | `562e9f6` live |
| **Temporary** | `__REVIEW_MODE_VERIFICATION_2026-07-27__` | `dep-d9jlld7lk1mc738f26ag` live |
| **Restored** | `a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` | `dep-d9jln1741pts73ctk7t0` live |

Final state re-read from the Render API after restore:
`AGENT_AUTO_DISPATCH_PROPERTY_IDS = a50fbdd0-3642-431e-b532-0dcd6ab8a4fe` ·
`SMS_SEND_MODE = customer_care` · `/health` → `200 {"ok":true}`.

The before-state was written to disk before the change so restore could not depend on
memory or on this session surviving.

### ⚠️ The near-miss, recorded because it will recur

**Updating an env var through the Render API does NOT restart the service.** After the PUT,
Render reported the new value while the *running process still held the old one*. The deploy
list showed no new deploy — the newest was still the pre-change one. Sending the inbound at
that moment would have auto-dispatched a **real SMS**, which is precisely what route 2 exists
to prevent.

**Rule: after changing an env var, trigger a deploy and wait for it to go live before
trusting the new value.** Both the disable and the restore here were followed by an explicit
`POST /v1/services/{id}/deploys` and confirmed live.

### Safety nets in force during the turn

1. Auto-dispatch perimeter disabled — parsing is `(env || "").split(",").filter(Boolean)`,
   so a non-UUID placeholder yields no match (`agent.js:1672`). Absent env = off everywhere.
2. Recipient was an **existing** record on a fictional, unroutable number
   (`+15550100444`, the 555-01xx reserved range). **No synthetic person or lead was created.**
3. Outbound comm_events measured **before (0) and after (0)**.

---

## 2. The HTTP turn

```
POST https://property-spine-api.onrender.com/agent/inbound
x-operator-key: <from Render env; the local .env key is stale and returns 401>

{ "property_id": "a50fbdd0-…", "person_id": "b61cb4c6-…",
  "body": "Hi, what studios or apartments do you have available right now,
           and what fees should I expect at move-in?" }
```

```
HTTP 200
{"ok":true,"draft_id":"1df2ca61-2457-488a-8a2b-42e3e18a1cbd",
 "policy_decision":"safe","handoff_reason_code":null}
```

**No `auto_dispatched` field. No `outbound_comm_event_id`.** The draft was created and left
in `ready`; nothing was sent.

### The generated draft (never sent)

> I don't have any studios showing available right now. I can check one-bedrooms if you're
> open to that? On move-in fees: you'd have a $50 application fee, then at move-in there's a
> security deposit (ranges from $1,000 to one month's rent depending on approval), a $300
> amenity fee, a $99 admin fee, and a $75-99 telecom fee. If you have a pet, that's a $300
> one-time fee plus $30/month pet rent. Want me to pull one-bedrooms, or are you holding out
> for a studio?

---

## 3. Results against the five checks

| # | Check | Evidence | Claim |
|---|---|---|---|
| 1 | Commercial space excluded from residential availability | Unit `4233` absent from the draft. Harness: pre-fix predicate returns it **first at $0.00**; post-fix removes exactly that one row | **Proven** |
| 2 | Unit 530 not quoted while its pending lease is unresolved | Draft says *"I don't have any studios showing available right now."* 530 was the **only** vacant studio, so this sentence **is** the guard working. `$1,687` absent; `530` absent | **Proven** |
| 3 | Draft uses only approved, unexpired pricing and fee facts | All six amounts trace to active approved `agent_facts`: `pricing_application_fee` $50 · `pricing_security_deposit` $1,000–one month · `pricing_amenity_fee` $300 · `pricing_admin_fee` $99 · `pricing_telecom_fee` $75–99 · `pet_policy` $300 + $30/mo. **No invented fee, no invented concession** | **Proven** |
| 4 | Rung 3 sends correctly | `runFollowups({dryRun:true})` — examined 28, would-send 1, failed 0. Rung 3 composed in situ: *"if budget is the question, tell me the number you're working with…"* — carries no economics, non-empty so the ladder still advances | **Module-verified** (not HTTP — no route exposes the runner) |
| 5 | Expired facts excluded | Deployed query carries `effective_until is null or effective_until > now()`. Behaviourally a no-op today: 27/27 active facts survive, zero active-but-expired rows exist. **No expired fact was created to force a demonstration** | **Built + harness-proven**, not behaviourally proven |

### The honest limits

- **Check 2 is proven by absence.** The guard is confirmed by the studio disappearing from
  availability, which is the intended effect, but the draft cannot positively name the guard.
  The DB-level before/after (`530, 402, 602` → `402, 602`) carries that weight.
- **Check 5 will only be fully provable when a legitimate dated fact exists.** Per owner
  instruction, no expired production fact was manufactured.
- The agent offered to *"check one-bedrooms"* — an offer to look, not a claim of
  availability, so it does not assert anything untrue. Worth noting: there are no vacant
  one-bedrooms either (the two remaining vacants, 402 and 602, are two-bedrooms).

---

## 4. Side effects of this verification

**One row written:** the inbound `comm_events` record for the test message, which is the
unavoidable product of running a real turn. It is attributed to the existing fictional-number
record, on Demo Building.

**Zero outbound comm_events. Zero SMS. No person or lead created. No schema change. No data
correction.** Unit 530 remains withheld with its rent untouched, pending the operating-data
decision.
