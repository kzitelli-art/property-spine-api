# Slice 9 — Production Acceptance Receipt

**Classification: BLOCKED — the live Neon ledger cannot be queried from the build
environment, and the production origin is denied by the environment's network
policy, so no production proof can be run and no merge may proceed.**

Date: 2026-08-03. This receipt records Big Build 1 up to the point where it
stopped, and exactly why it stopped.

---

## 1. Migration authority

The gate is a direct query against the live ledger:

```sql
select version, name from schema_migrations order by version desc limit 15;
```

**It was not run.** Two independent reasons, both verified rather than assumed:

1. **No credential exists in this environment.** There is no `DATABASE_URL` in the
   process environment, no `.env` in either repository (only `.env.example`, which
   carries the placeholder `postgresql://...`), and no deploy configuration
   containing a connection string. Render's dashboard, where the value lives, is
   not reachable either.
2. **The network policy denies the hosts.** `property-spine-api.onrender.com`,
   `console.neon.tech`, a representative `*.neon.tech` compute endpoint, and
   `dashboard.render.com` all fail. The agent proxy answers `403` to `CONNECT` and
   logs `connect_rejected — gateway answered 403 to CONNECT (policy denial or
   upstream failure)`. A direct TCP attempt to port 5432 has no route.

Everything that does not require the ledger was completed:

**Branch rescan — every remote branch, migrations 123–128.** Results:

| version | where it exists |
|---|---|
| 123 `property_operating_timezone` | this branch, `claude/slice-9-demand-evidence` , `scratch/slice-9-appointment-foundation-ledger-blocked`, `archive/slice-9-pre-main-sync-fc23869`. **Not on `main`.** |
| 124 `application_lifecycle_milestones` | same four branches. **Not on `main`.** |
| 125 `application_lifecycle_enforcement` | staged only, `docs/slices-6-to-10/deployment_b/`, outside the runner |
| 126 `obligation_missed_recognition` | `main` and fifteen branches — the shared, already-applied one |
| 127 `appointment_attribution_bridge` | **this branch only** |
| 128 `lifecycle_event_opportunity_attribution` | **this branch only** |

No other branch claims 127 or 128. No unexpected migration exists above the
ceiling — 128 is the highest number anywhere in the repository.

**Migration 125 is unchanged and outside the runner.** md5
`b4b817a5c3d65a01fef0783ccdc968b4`, in `docs/slices-6-to-10/deployment_b/`. The
runner globs `migrations/` for `NNN_*.sql`; a file in `docs/` cannot be picked up.

**A finding that changes the shape of the gate.** The build was authorised on the
understanding that 127 and 128 were the two unspent numbers. The rescan shows this
branch introduces **four** migration files absent from `main`: 123, 124, 127 and
128. 123 and 124 sit *below* the highest number known applied in production (126).

That is not necessarily a conflict. `migrations/migrate.js` applies any unapplied
version regardless of numeric order, so 123 and 124 running after 126 is expected
and safe *if the ledger does not already hold those numbers under other names*. If
it does, the runner's "MIGRATION NUMBER ALREADY SPENT" guard hard-stops the deploy
and applies **nothing** — including 127 and 128. Which of those two worlds we are
in is unknowable without the ledger. It is directly plausible that 123 and 124 are
already applied from the earlier Slice 9 lane, because production is already known
to carry `121 = ai_leasing_operating_context`, a migration whose file exists only
on branches. The gate must therefore cover four numbers, not two:

| version | ledger name that is safe |
|---|---|
| 123 | absent, or `property_operating_timezone` |
| 124 | absent, or `application_lifecycle_milestones` |
| 127 | absent, or `appointment_attribution_bridge` |
| 128 | absent, or `lifecycle_event_opportunity_attribution` |

Any of those numbers present under a different name means renumbering — and the
renumbering must be derived from the ledger, never from assumption.

## 2. Freshness and integration

Both `main` branches had moved to pick up the Ask Spine Slice 1 lane.

| | API | app |
|---|---|---|
| `main` before | `10c43b3` | `89a968c` |
| `main` after | `efb8c71` (PR #31) | `5cbe948` (PR #25) |
| branch before | `2c38ca3` | `3181049` |
| branch after | `c3bc0ba` | `ab29637` |
| behind `main` | 0 | 0 |
| ahead | 60 | 9 |
| working tree | clean | clean |
| overlapping file | `server.js` | `index.html` |

Integrated by **merge**, not rebase. No pushed history was rewritten. Both
overlapping files auto-merged with both lanes intact: Ask Spine's mount survives at
`server.js:3047`, and the app's Ask Spine composer coexists with
`openInboundDecision` and `psMkEvidence`.

## 3. Proof on the merged tree

| lane | suites | assertions |
|---|---|---|
| Slice 9 DB suites (real Postgres) | 24 | 1164 passed, 0 failed |
| Ambient-fixture suites | 4 | 149 passed, 0 failed |
| Harness suites — scale, evidence HTTP, inbound-decision HTTP | 3 | 91 passed, 0 failed |
| Ask Spine — contract, HTTP, DB | 3 | 81 passed, 0 failed |
| App harness suite | 18 | 779 passed, 0 failed |
| Browser — inbound decision, market evidence, Ask Spine e2e | 3 | 71 passed, 0 failed |
| **Total** | **55** | **2335 passed, 0 failed** |

`server.js` boots on the merged tree; `/health` answers `{"ok":true}`.

Two honest notes about how that number was reached. The scale proof and four
ambient-fixture suites failed on first run against reused databases — a duplicate
`users_email_key` left by an earlier seeding run, and suites reading
`select id from properties limit 1` against a regression database deliberately kept
empty. Both are green on fresh databases and neither involves product code.

One real defect was found and fixed. The market-evidence browser proof asserts
(M22) that a signed-in operator entitled to maintenance only gets the forbidden
state; the committed seeder never created that operator, so the assertion had only
ever passed against a session file seeded by hand. It could not reproduce from
committed artifacts. `ab29637` repairs the seeder. Proof-harness only.

## 4. Pull requests

- API: https://github.com/kzitelli-art/property-spine-api/pull/34 — open, non-draft, `mergeable_state: clean`, 0 behind
- App: https://github.com/kzitelli-art/property-spine-app/pull/29 — open, non-draft, `mergeable_state: clean`, 0 behind

Both bodies lead with the merge gate. **Neither was merged.**

## 5. What was NOT done, and why

Steps 4, 5 and 6 of Big Build 1 — deploy the API, deploy the app, verify in
production — were not attempted. Merging is what runs migrations against
production, and the gate that authorises it could not be closed. Beyond that,
every production verification the build requires (deployed SHA, health, ledger
shows 127/128 applied exactly once, Ask Spine answers, obligation queue secure,
decision detail and resolution, bounded evidence route, honest empty and partial
states, desktop and 390px screenshots *from the deployed product*) requires
reaching `property-spine-api.onrender.com`, which this environment cannot do.

Merging without that would produce a deployment that could not be verified and
could not be rolled back on evidence — and the build's own instruction is explicit
that merge and health alone do not constitute acceptance.

## 6. What unblocks this

Either one is sufficient to resume:

1. The Neon connection string, or the output of
   `select version, name from schema_migrations order by version desc limit 15;`
   run against production — **and** network access to
   `property-spine-api.onrender.com` for the production proofs; or
2. Running Steps 4–6 from an environment that already has both.

If the ledger comes back with 123, 124, 127 and 128 all absent or all matching the
names above, the merge is safe and the sequence resumes at Step 4 unchanged.

---

**Classification: BLOCKED — live production ledger unreadable and production origin
unreachable from the build environment; no migration may be spent and no
production proof may be claimed.**
