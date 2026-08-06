# Neon credential rotation — runbook and receipt

**Status: REQUIRED and urgent.**

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

## 2. What I cannot do

**I cannot perform this rotation.** It requires:

- Neon console access — no Neon API key or console session exists in this
  environment;
- Render dashboard access — no Render API key or dashboard session either;
- and the rotation touches live production configuration, which is outside
  every authorization granted on this branch.

This runbook is the part I can do. Steps 1–5 are the owner's.

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

## 4. Rotation receipt — fill from the real run

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
implementation plan (revision 2, corrected against the design review).

What rotation unblocks is implementation itself — and rotation is **not the only
gate**:

```text
gate 1  this plan correction committed and reviewed   revision 3
gate 2  credential rotated                            this runbook §3
gate 3  old credential proven dead                    this runbook §3 step 4
gate 4  SMS technician evidence + completion path
        phone-verified                                plan §5.1 step 4
```

Gates 1–3 precede any product code, migration, deployment, or merge of #43.
Gate 4 is a release-step gate: it precedes removal of the legacy app completion
control (plan step 5) and everything after it.

The §5.0 evidence-source question is **closed** — Option A, the technician SMS
lane, ruled 2026-08-06.

**Ask Spine Build 1 does not start. No Release 0 product migration is written
and nothing under `src/` changes until the implementation plan is reviewed
against the four rulings.**

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
