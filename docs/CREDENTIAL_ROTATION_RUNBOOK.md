# Neon credential rotation — runbook and receipt

**Status: COMPLETE — rotated and verified 2026-08-06. See §4 for the receipt.**

**What rotation blocks** (owner ruling, 2026-08-06):

```text
BLOCKED until rotated
  ·  any production connection
  ·  any production configuration change beyond the rotation itself
  ·  anything under src/, migrations/, or app product code
  ·  deployment
  ·  any runtime-changing merge
  ·  Release 0 implementation

NOT BLOCKED
  ·  preservation of the audit record
  ·  governing-document amendments
  ·  design and implementation planning
```

Audit preservation, governing-document amendments, and design planning may
continue **because they do not use the exposed credential and do not alter
production behaviour.** An earlier version of this file said rotation blocked
*all* further Release 0 work; that was corrected because it would have left the
governing decisions trapped in a chat transcript, which is the failure mode this
repository's handoff discipline exists to prevent.

**This runbook contains no secret value and the receipt in §4 must not acquire
one.**

---

## 1. What happened, stated plainly

During the Release 0 production audit the `DATABASE_URL` for the Neon database
`neondb` was pasted into an agent conversation in order to attempt the audit
from the agent container. The attempt did not succeed — that environment cannot
reach TCP 5432 — and the audit was ultimately run from the Render web shell
using Render's own environment variable.

**The credential was never written to the repository.** Verified at
2026-08-06:

```text
grep over the working tree                  no match
git log --all -S over the branch history    no match
agent scratchpad copy                       shredded
```

That does not make it safe. **It exists in a conversation transcript, and a
transcript cannot be un-shared.** Treat the credential as compromised.

## 2. What the agent could not do — resolved

The rotation was performed by the owner on 2026-08-06 (§4). This section records
why it could not be done from the agent container, which remains true of any
future rotation from here:

- Neon console access — no Neon API key or console session exists in this
  environment;
- Render dashboard access — no Render API key or dashboard session either;
- and the rotation touches live production configuration, which is outside
  every authorization granted on this branch.

Steps 1–5 are the owner's. §3.6 is the measured attempt log.

## 3. The rotation

### Step 1 — replace the database credential

In the Neon console for the project containing `neondb`:

**Preferred — reset the role password.** Roles → `neondb_owner` → *Reset
password*. This invalidates the exposed password immediately and keeps the role
and all grants intact.

**Alternative — create a replacement role.** If you would rather retire
`neondb_owner` from application use entirely, create a new role, grant it what
the application needs, and treat step 2 as a switch to that role. More work,
and it changes what appears in future audit receipts as `current_user`.

Note the pooled vs direct hostnames differ (`-pooler` in the host). Whichever
the service uses today, keep using; do not switch host style during a rotation
— one change at a time.

### Step 2 — update Render

Render dashboard → the API service → **Environment** → `DATABASE_URL` → paste
the new connection string → save.

Check whether any other service, cron job, or environment group carries its own
copy. A rotation that misses one leaves a broken service that fails at the next
restart rather than immediately, which is the worst way to find out.

### Step 3 — restart the affected services

Saving an environment variable on Render triggers a restart, but confirm it
actually happened rather than assuming. Watch the deploy/restart complete, then:

```bash
curl -s https://<api-host>/health
```

`/health` returns `{ok, db_time}` — a real `db_time` means the new credential
reached the database. That is the cheapest positive proof the rotation worked.

### Step 4 — prove the OLD credential no longer connects

**This is the step that makes the rotation real, and it is the one most often
skipped.** From anywhere with 5432 egress — your machine, not the agent
container:

```bash
psql "<OLD connection string>" -c "select 1"
```

Expected: authentication failure. Record the error class in the receipt —
**never the string itself.**

If it still connects, the rotation did not take. Do not proceed.

### Step 5 — fill in the receipt below

---

## 3.6 Attempt log — agent container, 2026-08-06T15:31:36Z

**ROTATION NOT PERFORMED. Attempted; every required surface is unreachable from
the agent container.** Recorded so no later session assumes the rotation was
never tried.

```text
Neon credential present            NO   — no NEON_* var, no ~/.neon, no neonctl
Render credential present          NO   — no RENDER_* var, no ~/.render, no CLI
Neon API   console.neon.tech       BLOCKED  curl (56) CONNECT tunnel failed, 403
Render API api.render.com          BLOCKED  curl (56) CONNECT tunnel failed, 403
HTTPS control api.github.com       HTTP 200 — egress works; the block is
                                   host-specific, not general
Postgres 5432 to the prod host     TIMEOUT — no wire-protocol egress
```

**Consequence, step by step.** Runbook steps 1–6 need the Neon console or its
API and the Render dashboard or its API; both hosts are refused at the proxy and
no key exists for either. Step 7 — the independent old-credential refusal test —
needs TCP 5432, which times out. **There is no step of this runbook the agent
container can perform.**

This is an access boundary, not a defect, and it is not worked around: widening
it would mean changing production configuration to make a credential rotation
possible, which is the opposite of the point. Steps 1–9 are the owner's, from a
machine with console access and Postgres egress.

---

## 4. Rotation receipt — COMPLETED 2026-08-06

**GATES 2 AND 3 CLOSED.** All five required facts are established, each by
independent evidence. **No credential value appears anywhere in this receipt.**

```text
rotated at                  2026-08-06, between 15:31:36Z (rotation not yet
                            performed, agent attempt log §3.6) and 15:43:03Z
                            (first database-backed health response)
performed by                owner, Neon console + Render dashboard

FACT 1  the database credential changed
        method              password reset on the existing role
        role                neondb_owner — name UNCHANGED
        evidence            facts 4 and 5 together: the new value authenticates
                            and the old one no longer does

FACT 2  every known legitimate runtime received the replacement
        services in account 2
          API service       UPDATED — sole holder of DATABASE_URL
          app (static site) NOT APPLICABLE — no environment, never held a
                            credential
        env groups/workers/
          crons/preview     none present
        unresolved holders  NONE

FACT 3  the production API restarted using the replacement
        trigger             Render environment save
        confirmation        service answered on $PORT after restart

FACT 4  a real database query succeeded through the production runtime
        command             curl -sS "http://localhost:$PORT/health"
        response            {"ok":true,"db_time":"2026-08-06T15:43:03.729Z"}
        why it counts       db_time is a Postgres-derived value; the route
                            cannot return it without reaching the database

FACT 5  the old credential can no longer authenticate
        tested from         owner's workstation (PowerShell + node-postgres),
                            OUTSIDE the production runtime, so the result is
                            independent of the new credential
        tested at           2026-08-06 ~11:59 local (workstation clock)
        result              REFUSED: password authentication failed for user
                            'neondb_owner'          — SQLSTATE 28P01 class
        NOT a network error — the server answered and rejected the credential

no credential value in this receipt      CONFIRMED
```

### 4.1 A false pass was caught before it was accepted

The first two attempts at fact 5 ran with the placeholder strings
`OLDPASSWORD` and `REALOLDPASSWORD` rather than the real leaked value. Both
printed `REFUSED: password authentication failed` — **and proved nothing**, because
a password that never existed is rejected whether or not a rotation occurred.

Only the third run, using the actual leaked value, is evidence. This is
recorded because it is the precise failure this release exists to prevent: a
green-looking result that does not mean what it appears to mean. **A refusal is
only proof when the credential being refused is the one that leaked.**

### 4.2 Not captured, and why

```text
production API SHA after restart    NOT READ
```

The API exposes no `/version` route and `/health` returns only `{ok, db_time}`,
so the deployed SHA is not readable over HTTP — the Render Events page is the
only source. Recorded as an honest blank rather than inferred. This is the same
gap noted in §6, and it is unchanged by the rotation.

### 4.3 Residual hygiene, owner-side

The leaked value now also sits in the workstation's PowerShell history and in
the scratch folder used for the test. It is **inert** — proven dead by fact 5 —
but worth clearing:

```powershell
Remove-Item Env:OLD
cd $HOME; Remove-Item -Recurse -Force $HOME\rotcheck
Clear-History
```

---

## 4b. Receipt template — retained for any future rotation

**No field in this receipt may contain a connection string, password, host, or
any fragment of one.** Record classes and outcomes, not values.

```text
rotated at                  <UTC timestamp>
performed by                <who>

step 1  credential replaced
        method              <password reset | replacement role>
        role name changed?  <yes/no>

step 2  Render updated
        services updated    <count and names>
        other copies found  <count — env groups, crons, other services>

step 3  services restarted
        restart confirmed   <yes/no — how>
        /health db_time     <present / absent>

step 4  OLD credential verified dead
        command             psql "<redacted>" -c "select 1"
        result              <e.g. FATAL: password authentication failed>
        still connects?     <MUST be no>

step 5  transcript exposure acknowledged
        the exposed value cannot be un-shared; rotation is the only remedy
        repository checked  no match in working tree or git history
```

## 5. After rotation

The three documentation tracks are **complete** and did not require rotation:
the audit record (PR #43), the four frozen rulings (contract §19c), and the
implementation plan (revision 3, corrected across three design reviews).

What rotation unblocks is implementation itself — and rotation is **not the only
gate**:

```text
gate 1  revision 3 chain-integrity guard            CLOSED 2026-08-06
        architecture frozen at 4f25f73
gate 2  credential rotated                        CLOSED 2026-08-06  §4
gate 3  old credential proven dead                CLOSED 2026-08-06  §4 fact 5
gate 4  SMS technician evidence + completion path
        phone-verified                            OPEN — release step 4
```

**Gates 2 and 3 are now the only things in front of implementation.** Once both
are receipted, implementation may begin at deployment step 1, and PR #43 may
merge.
Gate 4 is a release-step gate: it precedes removal of the legacy app completion
control (plan step 5) and everything after it.

The §5.0 evidence-source question is **closed** — Option A, the technician SMS
lane, ruled 2026-08-06.

**Implementation does not begin until gates 1–3 are complete.** Gate 4 is the
release-step condition before the legacy completion control is removed.
**Ask Spine Build 1 does not start.**

## 6. Worth doing while you are in there

Not required, not part of the rotation, and explicitly not being done without
instruction — noted so it is not lost:

- **`/version` endpoint.** `THREAD_HANDOFF.md` records that the deployed API
  SHA is unreadable over HTTP and that the Render Events page is the only way
  to read it. Roughly ten lines returning `RENDER_GIT_COMMIT` and the applied
  ledger ceiling would retire that question permanently, and this audit needed
  exactly that fact.
- **`connectionTimeoutMillis`.** Pointed at an unroutable host, both read-only
  tools hang rather than refusing — no message, no exit code. Documented in
  `docs/release-0-audit/PRODUCTION_RUN_BLOCKED.md` §3. Changing the tools would
  have voided the audit authorization, so it was deliberately left alone; the
  audit is now complete, so it is safe to fix.

## 7. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This runbook | 1 — permanent record | Never removed. It is the record of a credential exposure and its remedy. The §4 receipt is completed once and preserved. |
