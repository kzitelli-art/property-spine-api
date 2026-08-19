# Release ceremony — migrations 182 → 187

**Schema release only.** This lands six migrations. It does **not** activate
Skyline. Pricing, lease configuration, the real Skyline instrument, legal
sufficiency and company-signing authority are separate gates, and the system
must keep refusing the leasing journey until those business facts exist.
Do not bypass `no_published_pricing_version` to make anything demo.

---

## ⛔ THE FINDING THAT SET THIS RELEASE'S SHAPE

Migrations 182–187 are **runtime-compatible with the already-running old
process, and restart-incompatible with the old build.**

Measured, not reasoned. A database was built to production's exact position
and `main`'s **own** prestart verifier run against it after the release:

```
185  the ledger says: spine_execution_basis
     -> migrations/185_*.sql does not exist in this build.
The database contains changes this codebase cannot describe
EXIT 1
```

The verifier checks the ledger in **both** directions, so entries whose
files a build does not carry stop it. Then `main`'s server was booted
directly against the same 187 database and served `/health` normally.

Both halves matter:

| | after 182–187 land |
|---|---|
| the process already running | keeps serving — the guard is at startup, not per-request |
| that same build, restarted | **cannot start**, ever again |
| reverting to that build | blocked by the same guard |

So a schema-first release **with a gap** leaves production alive on borrowed
time: no restart recovery, no code rollback. Any deploy, manual restart,
host migration, OOM kill — or, on a Free instance, an idle period — ends it.

**That is why this release runs as a pre-deploy gate rather than as two
steps.** The gap is not shortened; it is removed. The schema moves and the
build that understands it starts, inside one deploy.

### The write side, which does hold — checked at source boundaries

The old build keeps *writing* correctly against 187, and that is not an
assumption:

| # | why old code cannot trip it |
|---|---|
| 182 | `main`'s own source says so: *"lease_applications — property_id, unit_id, NO space_id."* Never writes the column, so the trigger short-circuits. |
| 183 | Both of main's `pricing_terms` inserts write default scope only; `override_scope` is read and filtered, never written. Write-neutral. |
| 184 | No writer on main sets `resident_executed` or `executed`; `submitted` is documented there as terminal. |
| 185 | `executed_lease_service.js:169` validates the channel against exactly `paper|external_esign|other` and 400s anything else. `spine_esign` is **unwritable** by old code, so the lineage constraint cannot be violated. |

### Forward recovery, deliberately — no down-migrations

Discovering there is no rollback is not a reason to write six hurried
reverse migrations for constraint and execution-semantics changes; that
would add risk we could not trust under pressure. The recovery model is
**forward**: rehearse the exact upgrade, have the verified build ready,
collapse schema and code into one deploy, and fix forward from a known
deployed SHA.

---

## The release architecture

```
exact reviewed commit
  → build succeeds
  → PRE-DEPLOY GATE  (tools/release/predeploy_release_gate.js)
        read the production ledger
        assert ceiling exactly 181 and 169 entries
        assert none of 182–187 already present
        run the six preflights against real rows — every one 0
        apply 182–187 through migrate.js --apply, pinned to RENDER_GIT_COMMIT
        run verify_release_182_187 --after
  → only on exit 0 does the new build start
  → its own startup verifier now agrees with the ledger it just moved
  → /health proves the deployed SHA
```

A non-zero exit aborts the deploy: the new build never starts, the old one
keeps serving, and **the schema was not changed**.

### Three facts to establish in the Render dashboard first

1. **Is this service paid or Free?** Free web services spin down after
   ~15 minutes without traffic and may be restarted at any time — which
   makes any borrowed-time window unacceptable, and makes the pre-deploy
   architecture mandatory rather than merely preferable.
2. **Is auto-deploy enabled?** It must be **off** before a pinned release.
   Pinning a commit through the API does not disable it; Render treats them
   as separate settings, so a later push could replace what was pinned.
3. **Is a pre-deploy command available on this service?** It is offered on
   paid web services, private services and background workers.

Configure the gate as the pre-deploy command for **this release only**, then
remove it. It is safe if left in place by accident — a second run finds the
release already applied, re-verifies the shape and exits 0 — but a deploy
step that silently migrates is not the standing arrangement we want.

### The gate, falsified before being trusted

| attempt | outcome |
|---|---|
| no `RENDER_GIT_COMMIT` / `EXPECTED_SHA` | REFUSED, exit 1, ledger untouched |
| ledger not at the expected start ceiling | REFUSED, exit 1, ledger untouched |
| a real duplicate that 183 would reject | REFUSED naming that check, exit 1, ledger untouched |
| clean 181 → 187 | applied and verified, exit 0 |
| re-run at 187 | already-released, shape re-verified, exit 0 |

### W-9 in miniature, three times in one afternoon

The dirty-preflight falsification above **silently passed twice before it
was real.** Its setup SQL failed on a wrong table name, then on a wrong
column name; each time the transaction rolled back, the gate ran against a
still-clean database, and printed a reassuring `✓ RELEASE VERIFIED`. A
third instance the same afternoon: a probe written specifically to test
whether old code could still write against the new schema reported
`✓ lease_applications row written by OLD code` while reading a row that was
**five hours old**, from an earlier run.

None of the three was caught by the test reporting a failure. Two were
caught because a *number* contradicted the analysis — a non-null column
that had to be null — and one because the setup's error scrolled past above
a green.

The rule that came out of it, and is now enforced in the falsification
harness: **a test must prove its own action created the state it then
measures**, and must abort rather than proceed when its setup did not take.
A test written specifically to detect false confidence produced false
confidence. That is exactly why §41 says run, observe, and believe the
actual first red.

---

## ✔ Rehearsed end to end against production's exact ledger position

Not a from-scratch build — a database **held at ceiling 181 with 169
entries**, production's exact position, then released:

```sh
./tests/e2e/release_rehearsal.sh 181 182,183,184,185,186,187
```

That is the whole rehearsal, as one command, and it exits non-zero if any
part of it fails. It used to stop after applying the set and *print* "now
seed fixtures and run the same proofs" — a sentence instructing a human to
verify something is not verification, and it also applied the set with raw
`psql`, rehearsing everything except the command production will actually
run. It now goes through `migrate.js --apply` with its pins and refusals,
and it runs the proofs itself.

```
preflight (six checks)                     all 0
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=181 EXPECTED_SHA=… --apply
                                           182…187 applied and recorded, exit 0
verify_release_182_187.js --after          RELEASE VERIFIED, exit 0
prestart (had been refusing)               SCHEMA VERIFIED — 175 migrations, ceiling 187
leasing path · hostile · standing · ask spine · reconciliation
                                           5 of 5 PASS
```

The last line is the one worth having. It shows a schema that arrived by
**upgrade from 181** carries the same proven behaviour as one built from
scratch — the two are not the same act, and only one of them is what
production will experience.

**Both verifier gates were deliberately falsified before being trusted**
(doctrine: a gate not falsified is a claim). `--before` against an
already-released database refused with `✗ NOT SAFE TO APPLY`, exit 2;
`--after` with a wrong start-entry count refused with `✗ RELEASE NOT
VERIFIED`, exit 2.

A rehearsal proves the *mechanism*. It cannot prove production's *data* —
that is what the six preflight checks did, against the real rows.

### What the rehearsal caught on its first run — in the harness, not the release

The first run failed four of five proofs, and the cause was not the
migrations. A server left over from an earlier run was still holding port
3000 against a **different database**; the newly booted one failed to bind
and died, and the caller — which only checked that *something* answered
`/health` — ran the whole suite against a schema it had never touched.

The failure mode that matters is the other direction: `leasing_ask_spine`
**PASSED** that way. A harness that can talk to a server it did not start
can manufacture a green, and `verify_all.sh` — the script CI runs — had
the identical hole.

Both now ask `tests/e2e/port_guard.sh` **before launching**. Polling
afterwards cannot close it: an impostor answers `/health` instantly, so
the first poll succeeds before a liveness check on the child can mean
anything. Falsified deliberately in both scripts — with a stale server
held on 3000, each refuses up front, runs no proof at all, and exits 1.

---

## The manual ceremony below is the FALLBACK

Sections 1–8 are the hand-run sequence, kept because it is what the
pre-deploy gate automates and because it is the only path if this service
cannot take a pre-deploy command. **Run by hand it reintroduces the gap**
described at the top — old build alive but unable to restart — so if it is
used, the verified new build must be ready to deploy immediately, and
nothing else may be deployed or restarted in between.

## Before you start

Production state as read on **19 August 2026**:

```
ceiling 181 · 169 ledger entries · preflight clean (all six checks returned 0)
```

Re-read it. State changes, and the whole point of this ceremony is that
nothing is assumed.

---

## 1 · Read the deployed build identity

```sh
curl -s "$PROD_API/health" | python3 -m json.tool
```

Record `build.commit_short` and `build.resolved_from`. If
`build_identified` is `false`, stop and fix that first — a release you
cannot attribute to a commit is not a release you can reason about later.

## 2 · Read the production ledger

```sh
psql "$DATABASE_URL" -tAX -c "select version from schema_migrations order by version::int" | tr '\n' ' '
psql "$DATABASE_URL" -tAX -c "select 'ceiling=' || max(version::int) || ' entries=' || count(*) from schema_migrations"
```

## 3 · Re-run the preflight

Every count must be **0**. The two that can genuinely fail are the pricing
duplicates — 183 drops an index 101 shipped and replaces it with two
stricter partial ones.

```sh
psql "$DATABASE_URL" -c "
select 'dup default terms' as check, count(*) from (
  select 1 from pricing_terms where unit_type_id is not null and override_scope is null
   group by pricing_version_id, unit_type_id, lease_term_months having count(*) > 1) x;
select 'dup override terms' as check, count(*) from (
  select 1 from pricing_terms where unit_type_id is not null and override_scope is not null
   group by pricing_version_id, unit_type_id, lease_term_months, override_scope, override_ref having count(*) > 1) x;
select 'signer_role outside new set' as check, count(*) from lease_packet_fields
 where signer_role not in ('tenant','guarantor','company');
select 'packet status outside new set' as check, count(*) from lease_packets
 where status not in ('draft','sent','tenant_in_progress','submitted','resident_executed','executed','voided');
select 'channel outside new set' as check, count(*) from executed_lease_records
 where execution_channel not in ('paper','external_esign','spine_esign','other');
select 'pre-existing spine_esign' as check, count(*) from executed_lease_records
 where execution_channel = 'spine_esign';"
```

## 4 · Confirm the exact starting state

```sh
node tests/e2e/verify_release_182_187.js --db "$DATABASE_URL" --before
```

Exit **0** means the ceiling is exactly 181 and none of 182–187 is already
present. **Any other exit: do not apply.**

## 5 · Apply, through the EXISTING mechanism

```sh
npm run release:migrate
```

No new migration mechanism is introduced for this release.

## 6 · Ignore what the runner says

> ⚠ Five migrations in this chain record themselves into
> `schema_migrations` inside their own transaction. The runner then prints
> **"FAILED — rolled back. Nothing from this file was applied"** while the
> objects were in fact created and persist.

The runner's prose — success **or** failure — is not evidence. Read it for
context, act on step 7.

## 7 · The database-derived verdict

```sh
EXPECTED_START_ENTRIES=169 node tests/e2e/verify_release_182_187.js --db "$DATABASE_URL" --after
```

This is the release verdict. It asserts the final ceiling is exactly 187,
all six versions are recorded, the entry count is right, and every column,
index, trigger, function and constraint the six migrations claim exists —
constraints checked by **what they admit**, not merely that they exist,
because a constraint can exist and still reject the values the release is
for. It also asserts the index 183 replaces is **gone**.

Exit **0** is the only acceptable outcome.

## 8 · Confirm the API starts

```sh
curl -s "$PROD_API/health" | python3 -m json.tool
```

`ok: true`, and the database reachable.

## 9 · Read the build identity again

```sh
curl -s "$PROD_API/health" | python3 -m json.tool
```

If the commit changed between steps 1 and 9, a deploy happened during the
release. Record it; do not assume it was unrelated.

## 10 · Record the receipt

```
date · operator
build identity BEFORE      commit_short / resolved_from
production ledger BEFORE   ceiling / entries
preflight                  six checks, all 0
--before verdict           exit 0
runner output              quoted verbatim, marked NOT EVIDENCE
--after verdict            exit 0, pasted in full
API health                 ok
build identity AFTER       commit_short / resolved_from
```

---

## Stop here

This ceremony ends at a landed schema. The next objective is **not** more
release — it is the actual milestone:

> Mike enters Property Spine as himself, with server-derived Skyline
> authority, and operates one real Skyline leasing relationship through
> governed property truth, with every surface agreeing and every unknown
> or failure staying honest.
