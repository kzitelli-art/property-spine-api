# Slice 9 — Production Acceptance Receipt

**Classification: DEPLOYMENT ACCEPTED — with one named evidence gap: the
production decision-door happy path is unproven because no inbound decision
currently exists.**

Date: 2026-08-03. This receipt supersedes the BLOCKED classification this file
carried before the live ledger could be read; that history is preserved in §1.

---

## 1. Migration authority

The gate was a direct query against the live Neon ledger:

```sql
select version, name from schema_migrations order by version desc limit 15;
```

**It could not be run from the build environment.** No Neon credential exists
there (no `DATABASE_URL`, no `.env`, no deploy config — only `.env.example` with
a placeholder), and the network policy denies `property-spine-api.onrender.com`,
`*.neon.tech` and `dashboard.render.com`; the proxy answers `403` to `CONNECT`.
The build therefore stopped at Step 1 and classified itself BLOCKED rather than
merge on inference. **The owner ran the query and supplied the result**, which is
what unblocked the deploy.

A finding the branch rescan surfaced, worth keeping: the build was authorised on
the understanding that 127 and 128 were the two unspent numbers. In fact the
branch introduced **four** migration files absent from `main` — 123, 124, 127 and
128 — with 123 and 124 sitting *below* the 126 ceiling already applied in
production. Had either been spent under a different name, `migrate.js` would have
hard-stopped the deploy and applied nothing, 127 and 128 included.

**Pre-merge ledger:** ceiling 126, jumping 126 → 122. All of 123, 124, 125, 127
and 128 absent. Nothing above 126. No number spent under another name.

**Post-deploy ledger:**

| version | name | verdict |
|---|---|---|
| 123 | `property_operating_timezone` | applied exactly once |
| 124 | `application_lifecycle_milestones` | applied exactly once |
| 126 | `obligation_missed_recognition` | pre-existing, untouched |
| 127 | `appointment_attribution_bridge` | applied exactly once |
| 128 | `lifecycle_event_opportunity_attribution` | applied exactly once |

Migration **125 is absent**, still staged at `docs/slices-6-to-10/deployment_b/`
(md5 `b4b817a5c3d65a01fef0783ccdc968b4`), outside the runner. The duplicate-version
query returned zero rows. No renumbering was required.

## 2. Deploy

| | |
|---|---|
| **T0** | 2026-08-03T10:57:42Z — API PR #34 merged |
| API source SHA | `00c7891` → merge commit `d3698d3` |
| API deployed SHA | `d3698d3`, Render auto-deploy, live |
| **T1** | 2026-08-03T11:06:08Z — app PR #29 merged |
| App deployed SHA | `5b3be36`, **manually deployed** |
| **T2** | app PR #30 (acceptance fix) merged → `3be1399`, **manually deployed**, verified live |

The app is a Render **static site and does not auto-deploy**. Both app releases
required Manual Deploy from the dashboard. Merging is not deploying for that
service — a distinction worth carrying into future slices.

## 3. Source proof

| lane | suites | assertions |
|---|---|---|
| Slice 9 DB suites (real Postgres) | 24 | 1164 passed, 0 failed |
| Ambient-fixture suites | 4 | 149 passed, 0 failed |
| Harness suites — scale, evidence HTTP, inbound-decision HTTP | 3 | 91 passed, 0 failed |
| Ask Spine — contract, HTTP, DB | 3 | 81 passed, 0 failed |
| App harness suite | 18 | 779 passed, 0 failed |
| Browser — inbound decision, market evidence, Ask Spine e2e | 3 | 75 passed, 0 failed |
| **Total** | **55** | **2339 passed, 0 failed** |

Market evidence browser rose from 32 to 36 assertions with the acceptance fix in §5.

Two honest notes on how that total was reached. The scale proof and four
ambient-fixture suites failed on first run against reused databases — a duplicate
`users_email_key` from an earlier seeding run, and suites reading
`select id from properties limit 1` against a regression database deliberately
kept empty. Both are green on fresh databases; neither involved product code.

One defect was found in the proof harness itself: the market-evidence proof
asserts that a maintenance-only operator gets the forbidden state, but the
committed seeder never created that operator, so the assertion had only ever
passed against a session file seeded by hand. It could not reproduce from
committed artifacts. Repaired before merge.

## 4. Production verification

Every check below was run against the deployed product. The build environment
cannot reach the production origin, so these were executed by the repository
owner against a supplied read-only checklist and are recorded as **owner-supplied
evidence**, not machine-observed.

**API** — health answers ok · Ask Spine unregressed · `market_evidence_v2` served
· bounded page (12 of 12, default capped at 100, `limit=9999` clamped to max 250)
· cursor honest · withheld count server-authored · a client-supplied
`property_id` is ignored in favour of server-derived scope · obligation queue
single-property · a non-decision obligation returns 404, not 403.

Deliberately excluded: the decision **resolution** action. It writes real leasing
history, and a smoke test is not a reason to reopen someone's opportunity.

**App** — PARTIAL state with the withheld sentence above every number · the
generic wording correctly selected because `unresolved_opportunity_count` is 0 ·
four funnels in sequence, `PERCENTAGE UNAVAILABLE`, no 0% anywhere · honest
source disclosure ("recorded for the lead and inherited as context … not
independently recorded for each opportunity") · server-filtered, paged rows ·
"What changes the answer" below the funnels on desktop and **above** them at
phone width · no horizontal overflow · no UUID rendered anywhere.

## 5. Acceptance defect found in production, and closed

On a property whose current window held no newly opened opportunities, the page
rendered `0 of 0 leasing opportunities` directly above `12 matching · showing 12`.
Both numbers were correct — the funnel cohort is window-scoped, the supporting
rows are the property's population observed through `as_of` — but nothing said
they counted different things, so the pairing invited one reading and it was the
wrong one. That is an acceptance defect, not a documentation gap.

It never appeared locally because every fixture put opportunities inside the
window. Real data with an empty current month exposed it.

Fixed with labels only: the funnel states `… in this window`; the supporting
count states `12 property opportunities`, or `2 of 12 property opportunities`
when filtered. Both totals remain the server's. No calculation, filtering, API
contract or hierarchy changed. Proven by M12b/M12c (the labels) and M17b/M17c,
which reproduce the production condition directly rather than asserting around
it. Verified live at `3be1399` on desktop and at phone width.

## 6. The named evidence gap

**The inbound decision door's happy path is unproven in production.** No
`resolve_inbound_opportunity` obligation exists on any live property, so only the
refusal posture could be verified: an out-of-scope obligation returns 404, and
another property's operator cannot read a decision.

The full path — a qualifying inbound reply opening a decision, candidates offered
unranked, an operator selecting one, exactly one opportunity reopening while its
siblings stay terminal, a duplicate confirm proving idempotent — is proven at
**28/0 in a real browser** against a real API branch and real Postgres. It becomes
production-proven the first time a genuine inbound reply lands on a closed
opportunity. It is not claimed as production-proven before then.

## 7. Rollback position

127 and 128 are additive, write no values, and each carries its rollback DDL in
its file header. 123 and 124 likewise added columns and a validation trigger
rather than rewriting data. The migrations and their writers are one deployable
unit: rolling back the code without the columns is safe; rolling back the columns
without the code is not.

---

**Classification: DEPLOYMENT ACCEPTED — with one named evidence gap: the
production decision-door happy path is unproven because no inbound decision
currently exists.**
