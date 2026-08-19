# Release ceremony — migrations 182 → 187

**Schema release only.** This lands six migrations. It does **not** activate
Skyline. Pricing, lease configuration, the real Skyline instrument, legal
sufficiency and company-signing authority are separate gates, and the system
must keep refusing the leasing journey until those business facts exist.
Do not bypass `no_published_pricing_version` to make anything demo.

---

## ⛔ STOP — this ceremony cannot be run as written, and here is why

**The release files are not on `main`.** Migrations 182–187 exist only on
`claude/property-spine-orientation-cso2ao`. `main`'s migration ceiling is
181 — the same as production's.

```
$ git ls-tree -r --name-only origin/main -- migrations | grep -oP 'migrations/\K[0-9]+' | sort -n | tail -1
181
```

That matters because of a fact we read off the Render box directly: `git
rev-parse` **fails** there. The box is a built artifact, not a checkout.
Its `migrations/` directory contains exactly the files of the commit that
built it, and nothing else. So `npm run release:migrate` on the Render
shell today would find nothing to apply — not because the schema is
current, but because the files are absent.

### The order is settled; only the location is open

It is tempting to read this as "deploy the code first, then migrate."
**That is the one order that causes an outage**, and the codebase already
refuses it. Run the current build against production's schema and:

```
✗ REFUSING TO START — the schema does not match this code.
  6 migration(s) in this build are NOT applied to the target database:
    · 182_application_space_grain.sql … 187_lease_security_deposit.sql
  Ledger ceiling is 181. This code expects those migrations to exist.
```

Verified by running it, against a database held at ceiling 181. The guard
is doing its job: **schema goes first.**

### Schema-first is safe here — checked, not assumed

Applying 182–187 while production still runs `main` is the expand phase,
and it is safe for this particular six. Each claim below was checked
against `origin/main`'s source, not inferred from the DDL's shape:

| # | why it is safe under old code |
|---|---|
| 182 | Adds nullable `space_id` + indexes. Its trigger returns immediately when `space_id is null`, and old code cannot set a column it does not know. |
| 183 | Replaces one unique index with two partial ones. The default-scope index has the *same* columns as the one it drops, so old inserts behave identically. Production holds `pricing_terms = 0` regardless. |
| 184 | Widens two CHECKs (widening never rejects an existing row) and adds a trigger that returns unless status is `resident_executed`/`executed`. **No writer on `main` ever sets either** — the only writers are in `leasepackets.js`, and `submitted` is documented there as the terminal state. |
| 185 | `ck_elr_spine_instrument_lineage` **is validated against existing rows.** Production's 2 rows backfill to `staff_attestation` + NULL packet, so they must not be `spine_esign` — which is exactly what preflight check 6 asks, and it returned **0**. |
| 186 | `add column if not exists properties.lease_config`. |
| 187 | `add column if not exists leases.security_deposit`. |

So the remaining question is not *when* but **where** `--apply` can run,
given that the box holding the credential does not hold the files. That is
an infrastructure decision, and it is deliberately left to the operator.
`migrate.js` requires `EXPECTED_SHA` when it detects a deployed build, so
whichever site is chosen still has to name the code it is releasing.

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
