# Release 0 production audit — AUTHORIZED, NOT RUN

**Status: the authorized sequence could not be executed from this environment.**
**No production connection was opened. No production query was run. No result
is reported, estimated, or inferred.**

```text
authorization      Open Ruling 4, granted against
                   c0d995966cc24f52a20416f84c97a1244e92828a
attempt recorded   2026-08-06T11:23:50Z
API branch SHA     67d6e26ea5ec0fcc59359af9e4910254cbe3de6f
                   (branch tip; the authorized artifacts are unchanged — see §1)
outcome            BLOCKED before step 1. Nothing was attempted against
                   production.
```

This file exists so that no later session can mistake an unexecuted audit for
an empty result. **An audit that did not run is not an audit that found
nothing.**

---

## 1. Authorization integrity — intact

The void clause covers the plan, the query set, and either tool. Verified at
the moment of the attempt:

```text
git diff --stat c0d9959..HEAD
  docs/RELEASE_0_MORNING_HANDOFF.md   (documentation only)

UNCHANGED  tools/release0_proof_audit.js
UNCHANGED  tools/ledger_reconcile.js
UNCHANGED  docs/RELEASE_0_AUDIT_PLAN.md
UNCHANGED  tests/fixtures/release0_audit_schema.sql
UNCHANGED  tests/fixtures/release0_audit_populations.sql

working tree      clean
```

Digests of the exact instruments the authorization covers:

```text
sha256  1f556f98b645fc0c078e1fd42dff717f64fdc754503bf023fc736a717d836c9b
        tools/ledger_reconcile.js
sha256  539a0685eb98bcac493964f7ca858835843929ee239aa2869dcba361b26b437d
        tools/release0_proof_audit.js
```

**The authorization is live and remains valid.** The blocker is environmental,
not a change to what was approved.

---

## 2. Why it could not run — two independent blockers

### 2.1 No production credential in this environment

```text
DATABASE_URL          NOT SET
PG* / NEON* / POSTGRES*   none present
.env                  absent (.env.example only; .env is gitignored)
```

This is correct and expected. A production credential should not be sitting in
an agent session by default. It is recorded here as a fact, not a complaint.

### 2.2 PostgreSQL wire-protocol egress is blocked

This is the harder blocker, and it would stop the run even if the credential
were supplied. Measured, not assumed:

```text
DNS resolution                       WORKS
  github.com                         -> 140.82.114.4
  *.us-east-2.aws.neon.tech          -> 3.131.64.200  (wildcard)

raw TCP to github.com:443            CONNECTED
raw TCP to console.neon.tech:5432    TIMEOUT
raw TCP to *.neon.tech:5432          TIMEOUT
```

Egress is **not** blocked wholesale — port 443 connects on a raw socket. Port
5432 specifically does not. The session's proxy is an HTTP/HTTPS proxy
(`selective: false`, no TCP relay), so the Postgres wire protocol has no route
out of this environment.

**A first measurement was inconclusive and is recorded as such.** The initial
probe used a hostname invented for the test; its timeout proved nothing, since
a nonexistent host times out too. The conclusion above rests on the later
measurements against real hosts, with a working control on port 443.

---

## 3. ⚠ A real gap this exposed, which is NOT fixed here

Pointed at an unroutable host, **neither tool refuses — both hang.**

```text
DATABASE_URL="postgresql://…@ep-nonexistent…neon.tech:5432/db" \
  node tools/ledger_reconcile.js
  → no output, no exit; killed by an external 30s timeout (exit 124)
```

The guarded `client.connect()` added this morning handles a connection that is
**refused** (`ECONNREFUSED`) and reports cleanly. It does not help when packets
are **silently dropped**, because neither tool sets `connectionTimeoutMillis`,
so `pg` waits indefinitely. An operator running the authorized sequence against
a host they cannot reach would watch a terminal do nothing, with no message and
no exit code.

**This has deliberately not been fixed.** Adding a connection timeout changes
`tools/ledger_reconcile.js` and `tools/release0_proof_audit.js`, and the
authorization is void if either tool changes after `c0d9959`. It is reported
for the owner to decide:

- accept it for this run — the operator knows the host is reachable; or
- authorize a follow-up commit adding `connectionTimeoutMillis`, which moves
  the authorization SHA again.

It is a hang, not a safety failure: nothing is read and nothing is written
while it waits.

---

## 3a. Render web-shell attempt, 2026-08-06 — also no production read

The owner ran the sequence in the Render web shell. **Production was still
never contacted.** Three distinct causes, all visible in the output:

```text
✗ reconciliation could not run: getaddrinfo ENOTFOUND base
exit=2
Error: Cannot find module '/opt/render/project/src/tools/release0_proof_audit.js'
exit=1
```

**1. The placeholder was pasted literally.** `DATABASE_URL="<production>"` was
not substituted. Reproduced exactly:

```text
new Client({connectionString:"<production>"})
  → host: base    database: <production>    user: undefined
```

`pg` parsed the angle-bracket string as a hostname `base`, hence
`ENOTFOUND base`. **No connection to production was attempted.**

**2. The second command ran despite the first exiting 2.** The
`# ONLY IF THAT EXITED 0:` line in the instructions was a *comment*, not a
shell guard, so the shell executed the audit anyway. **That is a defect in the
instructions, not in the tools** — the authorization's ordering constraint was
being enforced by convention rather than by the shell. Corrected command block
in §5.1. No harm resulted, because of cause 3.

**3. The authorized instruments are not in that environment.** Render deploys
`main`, and `/opt/render/project/src` is a `main` checkout:

```text
tools/release0_proof_audit.js   ABSENT from main — exists only on this branch
tools/ledger_reconcile.js       PRESENT, but the PRE-AUTHORIZATION version
                                (39 lines differ from c0d9959: no statement
                                 reordering, no guarded connect)
```

So the reconciliation that ran was **not the authorized artifact**, and the
audit could not run at all. Any future attempt in that shell must first place
the `c0d9959` versions there and verify the digests in §1.

### 3b. Correction — the `ledger_reconcile.js` connect defect was overstated

This branch justified modifying a shipped tool partly on the grounds that its
unguarded `client.connect()` would produce an unhandled rejection and a stack
trace. **That was wrong, and the Render output is the evidence.**

`tools/ledger_reconcile.js` on `main` ends with:

```js
main().catch((e) => {
  console.error("\n  ✗ reconciliation could not run: " + (e && e.message ? e.message : e) + "\n");
  process.exit(2);
});
```

A connect failure was already caught and reported with exit 2 — which is
exactly what the screenshot shows. It was never an unhandled rejection.

`tools/release0_proof_audit.js` has **no** outer `.catch` (`main()` is called
bare at `:442`), so for that tool the unhandled rejection and stack trace were
real, and the fix was warranted.

What the `ledger_reconcile.js` change actually bought is narrower than claimed:
a specific message naming the connect, and the explicit "Nothing was read".
The statement-reordering fix in the same commit stands on its own and was not
overstated. **The owner may reasonably decide the `ledger_reconcile.js` connect
change was unnecessary**, which would shrink the authorization's footprint back
to one modified tool.

---

## 4. What was NOT done

```text
NOT RUN     tools/ledger_reconcile.js against production
NOT RUN     tools/release0_proof_audit.js against production
NOT WRITTEN docs/release-0-audit/RECEIPT.md
```

No number, count, identifier, or population size from production appears in
this branch. The four rulings remain open on exactly the terms they were left:

1. What proof state applies when no completion timestamp exists.
2. Whether `status='closed'` represents completed work.
3. How column-stored completion proof enters the canonical proof model.
4. Whether the closeout route is retired, redirected, or made canonical.

---

## 5. Two ways to complete the authorized sequence

Both stay inside the authorization. Neither changes the plan, the query set, or
either tool.

### 5.1 Run it where Postgres egress exists

Any environment that can reach the production host on 5432 — a Render shell,
the owner's machine, a session whose network policy permits it. The commands
are exactly:

**Step 0 — put the authorized instruments in place and verify them.** On
Render this is required, because `main` has neither (see §3a).

```bash
cd /opt/render/project/src
git rev-parse --is-inside-work-tree           # must print: true
git fetch origin claude/release-0-audit-plan-55r5kd
git checkout c0d9959 -- tools/ledger_reconcile.js tools/release0_proof_audit.js
sha256sum tools/ledger_reconcile.js tools/release0_proof_audit.js
```

Both digests must match §1 exactly. If either differs, **stop** — the
authorization does not cover what is on disk.

*What step 0 is and is not:* it writes two read-only tool files into an
ephemeral instance's working directory. It is not a deploy, changes no service
configuration, and no product code. It does modify a running production
instance's filesystem, so it is the owner's call; it is reversible with
`git checkout HEAD -- tools/`. If that is unwelcome, use §5.2 instead.

**Step 1 and 2 — with the gate enforced by the shell, not by a comment.**
Render already sets `DATABASE_URL` for the service, so no credential needs to
be pasted anywhere. Confirm it points where you expect, without printing the
password:

```bash
node -e 'const u=new URL(process.env.DATABASE_URL); console.log(u.hostname, u.pathname)'
```

Then:

```bash
node tools/ledger_reconcile.js; LEDGER=$?; echo "ledger exit=$LEDGER"

if [ "$LEDGER" -eq 0 ]; then
  node tools/release0_proof_audit.js --json > release0_audit.json; echo "audit exit=$?"
  sha256sum release0_audit.json
else
  echo "STOPPED — ledger exited $LEDGER. Audit NOT run, per the authorization."
fi
```

Prefer a `SELECT`-only role if one exists; the tools refuse a writable
transaction either way.

### 5.2 Send the raw outputs back

Step 3 of the authorization — *"completion of the approved receipt from those
exact outputs"* — does not require the credential. Paste both raw outputs and
both exit codes, and the receipt gets completed from them verbatim, with the
digest recorded.

**Facts needed for the receipt either way:** the production database name and
executing user (both printed by the tools themselves), timestamps, exit codes,
and the `sha256` of the `--json` output.

---

## 6. Classification (§18)

| Component | Class | Removal condition |
|---|---|---|
| This document | 1 — permanent record | Never removed. It is the record that an authorized audit did not run, so that its absence is never read as an empty result. |
