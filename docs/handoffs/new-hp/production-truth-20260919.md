# Production truth before #147 lands — 2026-09-19

**READ-ONLY. §46 honoured: no production data was mutated, no fixture was
created on production, no migration was run, nothing was written anywhere but
this file and an owned disposable database.**

Subject: PR `kzitelli-art/property-spine-api#147`
(`claude/rentroll-grain-refusal-20260918` @ `bbebb31a`) going to `main`.

> ## ⛔ THE HEADLINE, BEFORE THE DETAIL
>
> **Production could not be read from this session.** The organisation's egress
> policy denies both Render hosts, and there is no production database
> credential here. Sections 1, 2, 3 and 4 below therefore report **recorded
> claims, clearly separated from live observation** — not live truth.
>
> **What IS verifiable from source, and matters most:** the deployed API
> (`ecfc9af4`) does **not** contain `src/tenancy/link_resident.js`, and the
> deployed app (owner-reported `2e8199a`) contains **zero** occurrences of
> `linkResident`. Deploying #147 **without also deploying the app** gives
> Greenery the link-resident endpoint and **no control that calls it.**

---

## 1 · Deployed API

### 1a · The commit the live API reports — NOT READ

```console
$ curl -sS --max-time 30 https://property-spine-api.onrender.com/health
curl: (56) CONNECT tunnel failed, response 403
```

```console
$ curl -sS "$HTTPS_PROXY/__agentproxy/status"   # .recentRelayFailures
{
  "kind": "connect_rejected",
  "detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
  "host": "property-spine-api.onrender.com:443"
}
```

`/root/.ccr/README.md`: *"403 / 407 from the proxy — the destination host is
not allowed by your organization's egress policy for this session. Do not
retry or route around it — report the blocked host."* So this is a **policy
denial, not a misconfiguration**, and it was not worked around.
`/operator/build` is behind the same host and equally unreachable; it would
also have needed a real staff session, which this session does not hold.

### 1b · Migration ledger ceiling on the production database — NOT READ

No production credential exists in this environment:

```console
$ for v in DATABASE_URL PROD_DATABASE_URL OPERATOR_KEY RENDER_API_KEY NEON_API_KEY; do
    printf "%-20s %s\n" "$v" "${!v:+SET}"; done
DATABASE_URL
PROD_DATABASE_URL
OPERATOR_KEY
RENDER_API_KEY
NEON_API_KEY          # all empty — none set
$ ls -a | grep '^\.env'
.env.example          # the template only; no .env on disk
```

### 1c · Does it equal `ecfc9af4` / 200? — RECORDED, NOT OBSERVED

`docs/CURRENT_STATE.md` **STATE SNAPSHOT** already records the same
limitation, and this session reproduces it independently:

```text
API verified against    ecfc9af4    2026-09-17 13:38 UTC — RELEASE-LANE RECORD
                        (row 117). NOT re-read from this session: no production
                        credential here, and the proxy refuses the Render host.
LEDGER AFTER DEPLOY     188 rows, ceiling 200  2026-09-17 (row 117 …)
                        MIGRATIONS 199 AND 200 ARE RELEASED.
```

**What source can prove without production**, and does:

```console
$ git ls-tree -r --name-only ecfc9af4 migrations/ | grep -cE 'migrations/[0-9]+.*\.sql'
189
$ git ls-tree -r --name-only ecfc9af4 migrations/ | grep -E '[0-9]+.*\.sql' | sort | tail -1
migrations/200_unresolved_inquiry_evidence.sql
$ git ls-tree -r --name-only bbebb31a migrations/ | grep -cE 'migrations/[0-9]+.*\.sql'
189
$ git ls-tree -r --name-only bbebb31a migrations/ | grep -E '[0-9]+.*\.sql' | sort | tail -1
migrations/200_unresolved_inquiry_evidence.sql
```

**#147 ships no new migration — identical file set, identical ceiling 200.**
That is a source fact, independent of the blocked reads. And `prestart` runs
`migrations/migrate.js` in verify-only mode, so **a deploy of #147 that starts
is itself proof the production ledger already satisfies it**; if the ledger
were short, the deploy would fail and Render would keep the previous instance.

```console
$ git merge-base --is-ancestor ecfc9af4 bbebb31a && echo yes
yes            # #147 CONTAINS production — nothing deployed is lost
```

---

## 2 · Deployed app

### The deploy cannot be identified from outside — said plainly

The app is a **static site**. It exposes no build stamp, no `/health`, no
commit header. `CURRENT_STATE` records this as a standing condition:

```text
APP deployed            2e8199a     2026-09-17 — OWNER-REPORTED, not verified from
                        any session: a static site exposes no build identity.
```

And the host is blocked anyway:

```console
$ curl -sS --max-time 30 -I https://property-spine-app.onrender.com/
curl: (56) CONNECT tunnel failed, response 403
```

**So the deployed app commit is owner-reported and cannot be confirmed by
anyone from outside. That is a property of the deploy, not of this session.**

### What the two candidate commits actually are

```console
$ git log -1 --format='%h %ad %s' --date=short 2e8199a
2e8199a 2026-09-17 prove the panel is reachable in the real page, not just in the test
$ git log -1 --format='%h %ad %s' --date=short 7f9a58f
7f9a58f 2026-09-19 Merge lane claude-opus/link-resident-app-20260919: Link resident control
$ git merge-base --is-ancestor 2e8199a 7f9a58f && echo "pin is AHEAD of deployed"
pin is AHEAD of deployed
$ git rev-list --count 2e8199a..7f9a58f
17
```

`tests/e2e/app_pin.txt` @ `bbebb31a`:

```text
sha    7f9a58f40bbdfa76621a2772bb678bfc30693294
branch claude/app-convergence-20260919
```

**The pin is 17 commits ahead of the deployed app.** The pin says what CI
exercises; it is not a statement that anything shipped.

### ⚠ The consequence that matters on day one

```console
$ git grep -c "linkResident" 2e8199a -- index.html     # the DEPLOYED app
0
$ git grep -c "linkResident" 7f9a58f -- index.html     # the PINNED app
7f9a58f:index.html:4
```

```console
$ git ls-tree ecfc9af4 src/tenancy/link_resident.js | wc -l   # DEPLOYED API
0
$ git ls-tree bbebb31a src/tenancy/link_resident.js | wc -l   # #147
1
```

**Neither half of the link-resident door is live today, and #147 ships only
the API half.** Deploying #147 alone leaves the endpoint reachable with no
operator control that calls it.

### One stale line worth correcting in passing — not a contradiction

The snapshot says *"the API's pin moved AHEAD of the deployed app, to
`475b3e1`"*. The pin file now reads `7f9a58f`. `475b3e1` **is an ancestor of**
`7f9a58f`, so the substance of that line (pin ahead of deployed) still holds
and only the named sha is superseded. **No CURRENT_STATE row was added** — no
read in this session contradicts an existing row.

---

## 3 · Skyline and Greenery — NOT READ

**All eight numbers require the production database. There is no credential
here (§1b), and §46 forbids creating anything on production to enable a read.
So none of the following was observed; every figure below is a RECORDED claim
from `docs/CURRENT_STATE.md`, cited so it can be checked by someone who has
access.**

`CURRENT_STATE` records that this specific read has been outstanding for some
time — it is not new to this session:

```console
$ grep -o "leasing_basis. of [^.|]\{0,70\}" docs/CURRENT_STATE.md | sort -u
leasing_basis` of Skyline and Greenery was **not read** — no database access from t…
leasing_basis` of Skyline and Greenery is **still unread**
leasing_basis` of the real Skyline and Greenery is **still unread**
```

| | Skyline | Greenery |
|---|---|---|
| activation state | **NOT READ** | **NOT READ** |
| `leasing_basis` | **NOT READ** — recorded as *unread*, repeatedly | **NOT READ** — recorded operating basis *"honestly `unknown`"* |
| units / spaces | **NOT READ** — see the 231-vs-72 row below | **NOT READ** — 105 beds is the doctrinal row spine (CLAUDE.md §42); 171 legacy unit rows appear in proof-shape assertions, not a production read |
| leases with / without `tenant_ids` | **NOT READ** | **NOT READ** — row 156 records *"Greenery's existing 95 handle-less Persons"* as untouched |

### The 231-vs-72 question, as `CURRENT_STATE` states it

```console
$ grep -n "231" docs/CURRENT_STATE.md
879:| 17 | **159 phantom unit rows at Skyline, shaped like beds.** …
```

> **159 phantom unit rows at Skyline, shaped like beds.** Alongside `1417-116`
> production carries separate `units` rows named `116 - A`, `116 - B`,
> `116 - C` — null bed, no source code, not reachable from any import row.
> They are why `count(*)` reports **231 units for a 72-unit property**, and why
> the mapping tool reports 159 positions "Not configured" after a correct run.
> **Not a blocker and deliberately untouched**: the canonical loader sees 160
> … Cleaning them is a production delete with unknown FK reach.

Recorded **2026-08-20**, a month before this report. **It was not re-verified
here and should not be quoted as current** without a fresh read. The query a
credentialed reader should run is one statement per property:

```sql
-- READ-ONLY. Run by someone holding production credentials; not run here.
select p.name, p.leasing_basis,
       (select count(*) from units u where u.property_id = p.id)  as unit_rows,
       (select count(*) from spaces s join units u on u.id = s.unit_id
         where u.property_id = p.id)                              as space_rows,
       (select count(*) from leases l where l.property_id = p.id
          and l.lease_status = 'active' and cardinality(l.tenant_ids) > 0) as leases_with_tenant,
       (select count(*) from leases l where l.property_id = p.id
          and l.lease_status = 'active' and cardinality(l.tenant_ids) = 0) as leases_without_tenant
  from properties p
 where p.id in ('14e41b7c-e91c-49e8-9651-10c4908a8f6a',   -- Skyline
                'a29181cd-3ba1-461c-aead-cd989add1d11');  -- Greenery
```

The two property ids are themselves recorded facts from `CURRENT_STATE` row
113, not read from production here.

---

## 4 · Callers of the two doors being retired

**NO LOGS AVAILABLE — that is the finding, and it is a "no logs" finding, not
a "zero calls" finding.**

Render request logs are reachable only through the Render dashboard or the
Render API. Neither is available: `RENDER_API_KEY` is unset (§1b) and
`property-spine-api.onrender.com` is egress-denied (§1a). **No production
request log for `POST /persons` or `POST /leases/:id/tenants` was read, over
any window.**

### What is available instead, and it is a different class of evidence

A **static caller search** across both repositories — source evidence, which
can prove a consumer exists and can never prove one does not:

```console
$ # property-spine-app, EVERY tracked file on EVERY remote branch:
$ for b in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do
      git grep -n -I "/persons" "$b"; git grep -n -I "/tenants" "$b"; done
(no output — zero occurrences on all 109 remote branches)

$ # property-spine-api, outside the routes' own definitions:
$ grep -rn -I "/persons\b\|leases/[^\"' ]*/tenants" --exclude-dir=node_modules \
      --exclude-dir=.git . | grep -v baseline_routes.js | grep -v lease_lifecycle_routes.js
(only comments, the unrelated /leasing/persons/:personId/opportunities route,
 and the two retirement proofs themselves)
```

⚠ **The shared operator key is held outside this repository.** Both doors sit
behind that key, so an external caller would be invisible to every search
above. This is exactly why both were retired with a **410 that names the
replacement** rather than deleted into a 404 — an unknown caller gets an
answer it can act on.

**What would close this properly:** one query of the Render request log for
`POST /persons` and `POST /leases/:id/tenants` over the longest retained
window, run by someone with dashboard access. Until then the honest statement
is *"no caller is visible in source, and no log was consulted."*

---

## 5 · The carrier / property-line proofs — RUN, on the owned runtime

Run against a **disposable local PostgreSQL 16 proof database** built by
replaying this branch's migrations (189 files, 187 applied, 2 data migrations
that legitimately refuse on an empty database). **Production and the SMS
carrier were not contacted; the SMS transport is the local append-only fake.**

I could not identify a single file named "the Skyline carrier test", so all
five carrier- and property-line proofs in the tree were run. **None of them is
registered in `verify_all.sh`** — which is what "written but unrun" means
here: they are not part of any automated run.

```console
$ . /tmp/spine-rung/env.sh
$ export HARNESS_DATABASE_URL="${E2E_DATABASE_URL}?sslmode=disable"
$ for f in resident_sms_route_proof resident_sms_work_order_proof \
           property_line_hardening.db communication_lines_slice_a.db \
           operations_line_activation.db; do node "tests/proofs/$f.js"; done

resident_sms_route_proof.js            61 passed, 0 failed
resident_sms_work_order_proof.js       78 passed, 0 failed
property_line_hardening.db.js          41 passed,  0 failed
communication_lines_slice_a.db.js      61 passed,  0 failed
operations_line_activation.db.js       40 passed,  0 failed
                                      ─────────────────────
                                      281 passed,  0 failed
```

**The closest thing to "the Skyline carrier test" is
`resident_sms_route_proof.js` (61/61)** — the route-level proof of the carrier
inbound path: `POST /communications/inbound-sms` → webhook signature →
`resolveInboundSmsContext` → resident routing → work order. It covers
transport auth, unknown-line handling and sender ambiguity, which is the
carrier seam.

### What they needed

**Three of the five refused on first run**, with `Cause: The server does not
support SSL connections` and **0 assertions executed** — they build their own
`Pool` assuming a Neon-style disposable branch. Appending `?sslmode=disable`
to `HARNESS_DATABASE_URL` was the whole fix; no source change. Worth knowing
before anyone reports them as broken.

### What would still be missing

`CURRENT_STATE` line 1005 stands unchanged: **"No controlled live-carrier
proof has run."** Nothing here changes that. A real Skyline carrier proof
would need Skyline's production line (`+12157708837`, recorded in row 113) and
a real carrier send — both out of scope under §46 and not attempted.

---

## What a deploy of #147 changes for Greenery on day one

Nothing in Greenery's existing records moves, and no schema changes — but
**onboarding a rent roll starts behaving differently the moment the API
restarts**. Today, a rent-roll row carrying only a resident's name creates a
person record for that name. After #147 it does not: the lease is still
established and the unit still reads as occupied, but the resident's name
appears beside it as an **unlinked claim**, and the rent roll counts it under
"resident not linked". That count will be large and it will be true — the real
rent-roll parser maps no phone and no email, so **every resident on a new
onboarding is unlinked until someone reaches them on a phone number or an
email address**. The way to link one is the new door,
`POST /operator/leases/:leaseId/link-resident` — **but the operator control
that calls it is not in the deployed app** (`linkResident` appears zero times
in `2e8199a`), so until the app is deployed too there is no button for it and
the count only goes up. Greenery's 95 existing people are untouched and keep
reading as linked. Two old back doors stop working and now explain
themselves instead of failing: creating a person directly (`POST /persons`)
and adding a resident to a lease directly (`POST /leases/:id/tenants`) both
answer *"this has been retired"* and name where the work goes instead. Both
had no visible caller in either repository, but **no production request log
was consulted**, so if an outside integration was using either one it will
start getting that message on day one — it will be told exactly which door to
use, and nothing it sent will have been written.

---

### Provenance of this document

Written on branch `claude-opus/production-truth-20260919` from `bbebb31a`.
Every command above was run in this session except those marked NOT READ or
explicitly attributed to a credentialed reader. Live production was neither
read nor written.
