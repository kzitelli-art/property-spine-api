# SLICE CLOSURE — Resident SMS → Canonical Work Order

**Status: PROOF COMPLETE, MERGE NOT RECOMMENDED AS-IS.** See §0.

| | |
|---|---|
| Governing contract | `docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md` @ **`5eef41f`** (v3, owner-signed) |
| Final implementation | **`45cc561`** |
| Branch | `claude/getting-up-to-speed-nyf4ww` |
| Base | `origin/main` @ `421168f` (Slice 8 merged in cleanly) |
| Migration | **none** for this slice |
| App repo | **untouched** |

---

## 0. STOP — THIS BRANCH CARRIES TWO SLICES, AND ONLY ONE IS PROVEN

Everything below proves the **resident-SMS slice**. The same branch also carries
the **Governed Operating Context** slice, which has a materially weaker proof
level and would merge alongside it:

| Slice | Proof level |
|---|---|
| Resident SMS → work order | **Proven** — real Postgres + real HTTP |
| Governed Operating Context (migration **121**) | **Locally exercised only.** Migration 121 has never been applied to any database. Its harness (`tests/ai_leasing_operating_context_proof.js`) contains zero `DATABASE_URL` references — it is pure/mock only. Its two DB triggers (`protect_ai_leasing_operating_rule_lineage`, the retirement-audit transition rule) have **never executed**. Its routes have never been called over authenticated HTTP. Its UI is explicitly not approved design. |

**Merging this branch merges an unapplied, never-executed migration.** That is
not what the SMS proof gate was about, and it should not ride in on its
coattails.

**Recommended:** split before merge — land the SMS slice, hold the governed
operating context until it gets its own real-DB and HTTP proof (its own
`HANDOFF.md` lists eight preconditions, of which the DB/HTTP ones remain open).

Files by slice:

```text
SMS SLICE (proven)
  src/comms/tenantlink.js                    T1/T2, gate, canonical creation
  src/maintenance/work_order_service.js      appendClarification rewritten
  src/shared/obligation_transitions.js       NEW — transitionObligation
  src/comms/communications_boundary.js       double-send guard
  server.js                                  engine import + injection
  tests/resident_sms_work_order_proof.js     NEW
  tests/resident_sms_route_proof.js          NEW
  docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md   NEW

GOVERNED OPERATING CONTEXT (NOT proven — see above)
  migrations/121_ai_leasing_operating_context.sql
  src/leasing/ai_leasing_operating_context.js
  tests/ai_leasing_operating_context_proof.js
  src/identity/operator.js                   ai-settings / ai-rules routes
  src/agent/agent.js                         operating-context injection
  src/leasing/leasingleads.js                first-response context
```

---

## 1. WHAT CHANGED (SMS slice)

- `runInbound` is now **two transactions**. T1 commits the inbound claim already
  flagged `needs_human=true`; T2 does all processing atomically and clears the
  flag **only on commit**. A failed T2 preserves the claim, flagged, sends no
  reply, and represents no work order as created.
- The **two raw `work_orders` inserts are gone.** Tenant work orders now flow
  through `createWorkOrder`, so every one produces an event and a routing
  obligation. The raw inserts produced neither.
- `appendClarification` repaired in the **shared canonical service**, not
  wrapped at the SMS caller — the browser door carried the identical latent
  defect and now gets the fix too.
- **`transitionObligation`** added to the shared obligation engine: exactly two
  whitelisted transitions, required expected type + status so stale state fails
  closed, every type-coupled field mandatory, one UPDATE, event type taken from
  the table so history cannot be mislabelled by its own writer.
- Clarification association keys on **the outbound question we sent**, never
  `obligations.person_id` (which holds the *affected* person, not the person we
  texted).
- `sendPropertySms` **double-send guard**.
- Delivery failure **re-flags the inbound row** — the only direction either
  exception-queue reader counts.

## 2. PROOF MATRIX

| Layer | Command | Result |
|---|---|---|
| Pure | `node tests/resident_sms_work_order_proof.js` (Part A) | **15/15** |
| Real Postgres | same file, Part B — 22 cases | **75 passed / 1 failed → fixed at `45cc561`** |
| Real Postgres + real HTTP | `node tests/resident_sms_route_proof.js` | **29/29** |
| Regression (DB-free) | 35 harnesses | **28 green / 8 red — identical to baseline** |
| App suite | `./run_harnesses.sh` | **753/753** |

> **PENDING:** raw output at exact head `45cc561` is not yet captured. The
> numbers above for Part B are from `dd698ec` plus the single fix. **This
> document is not final until the exact-head run is pasted in below.**
>
> ```text
> [ awaiting raw output — node tests/resident_sms_work_order_proof.js @ 45cc561 ]
> [ awaiting raw output — node tests/resident_sms_route_proof.js       @ 45cc561 ]
> ```

**All 22 contract cases accounted for:** 17 at service level, 5 (cases 5, 9, 10,
11, 14) at the HTTP boundary. None reported as proven that was not.

## 3. EVIDENCE LEVEL PER CLAIM

| Claim | Evidence |
|---|---|
| Routine clarification → one open `maintenance_repair`, label and inputs moved, stale input gone | **Persisted rows, real Postgres** |
| Emergency clarification → one open `emergency_repair` with `due_at`, severity, escalation, and an event carrying `emergency_type` | **Persisted rows, real Postgres** |
| Duplicate `MessageSid` → one work order, one obligation | **Persisted rows, real Postgres** |
| Failed T2 → claim survives, `needs_human=true`, nothing created | **Persisted rows** (savepoint standing in for T2) |
| Failed delivery re-flags inbound | **Persisted rows**, and observed firing live in the Render log |
| Unknown sender → zero resident rows, zero outbound | **Real HTTP + persisted rows** |
| Browser door response shape unchanged, now yields an obligation | **Real HTTP + persisted rows** |
| Separate problem → new work order, original question untouched | **Real HTTP + persisted rows** |
| `both`/`unclear` and multi-pending → preserve + flag, nothing mutated | **Real HTTP + persisted rows** |
| Transition guards (whitelist, stale, coupled fields, complete) | **Real rows**, verified by error code, plus mutation-checked |
| No real SMS sent | **Asserted twice** — every send used this run's own fixture line; every provider SID harness-minted |

## 4. SAFETY

No migration for this slice. App repo untouched. Zero `DELETE`/`DROP`/`TRUNCATE`
in either harness. All fixtures created fresh, uniquely suffixed per run, inside
one transaction that always rolls back — nothing is deleted to clean up, so no
cleanup bug can reach durable history. Demo Building and every real property
untouched. Slice 8 governance pins verified intact (0 occurrences of
`pricing_adapter`/`quotablePricing` in `agent.js`).

## 5. THE THREE DATABASE FINDINGS

None was findable by reading source. This is the argument for the gate.

1. **`users.role` is a Postgres enum** (`role_name`), not free text — no `staff`
   value. Crashed fixture setup.
2. **SMS consent gates every outbound.** Without an `opted_in`
   `contact_preferences` row, sends refuse, the outbound is stamped `refused`,
   and §7.1 then *correctly* excludes that question from the gate as
   never-delivered. Cases 10 and 11 were silently exercising the *never-asked*
   branch. **The product was right; the fixture was wrong.**
3. **Guard ordering hid a gap.** The whitelist check runs *before* the row read,
   so case 15 was proving the whitelist twice while claiming to prove staleness
   — meaning the stale-state guard, which is what makes the §7.6 race safe, had
   only ever been proven against a mock. Now split into two cases hitting two
   guards, verified by error code.

## 6. DELIBERATE DEVIATION FROM THE CONTRACT

§10.5 specified injecting `satisfyObligation` into `tenantlink`. It is injected
into **`work_order_service`** instead, where `appendClarification` lives.
`tenantlink` calls the canonical service and never orchestrates obligation
internals. Same dependency, better seam — and closer to §6's own instruction to
repair the shared canonical path rather than compensate at the caller.

## 7. FOLLOW-ON DEBT (not fixed here, deliberately)

- **`tests/_engine.js` is a hand-maintained verbatim copy** of
  `spawnObligationFromEvent` / `satisfyObligation`. Its own header says
  "server.js is the SOURCE OF TRUTH… update this copy to match" — a rule kept in
  sync by discipline, the same shape as the documented `deriveCategories`
  incident. `transitionObligation` was deliberately **not** added to it; it lives
  in `src/shared/obligation_transitions.js` and is imported by both server and
  harness. Extracting the two older functions is the right fix and was judged
  too large to do unsupervised at the end of this slice.
- **A failed resident notification has visibility but no accountable owner.**
  §11 wants an obligation. That needs an obligation type and an owning role —
  an owner ruling, not an implementation choice.
- **Cosmetic:** the stale-draft copy says rules "changed" when a rule merely
  *lapsed*. One string in `agent.js`; left alone to avoid churning a contended
  file.

## 8. POST-MERGE SMOKE

Migrations run on deploy (`prestart`). After the deploy is live:

1. `echo $RENDER_GIT_COMMIT` — confirm the merge commit is what is serving.
2. `GET /health` returns `{ ok: true }`.
3. Confirm the ledger: `select version from schema_migrations order by version desc limit 3;`
   — expect `122`, and `121` only if the governed-context slice was merged too.
4. Send one real inbound SMS from a consented test resident to a property line.
   Expect: a work order via `createWorkOrder`, **one** routing obligation, an
   inbound `comm_events` row with `needs_human=false`, and a linked outbound.
5. Confirm no rise in `needs_human=true` inbound rows beyond normal.

## 9. ROLLBACK

Revert the merge commit. **No migration ships with this slice**, so there is no
schema to unwind and no data migration to reverse. Reverting restores the prior
`runInbound`, the prior `appendClarification`, and removes
`obligation_transitions.js`; no table, column, or row created by this slice
persists, because it creates none.

> If the governed-context slice is merged in the same commit, rollback is **not**
> symmetric: migration 121 will already have applied. That asymmetry is a second
> reason to split (§0).
