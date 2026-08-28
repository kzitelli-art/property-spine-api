# Activation runbook — migration 129 / property-line enforcement

**Status: NOT YET PRODUCTION-ACTIVE.**

> Merged and proven against isolated real PostgreSQL and real HTTP.
> Not yet production-active.

That sentence is the honest proof statement until every step below is
complete. Do not upgrade it early.

---

## 1. The current state, as separate facts

Merging is not deploying. Deploying is not activating. These are four facts and
they currently disagree — deliberately.

| Fact | Value |
|---|---|
| Source SHA on `main` | `a08c1da` |
| Production deployed identity | `d3698d3` (Slice 9) |
| Applied ledger ceiling | **128** |
| Repository migration ceiling | **129** (`129_property_line_uniqueness.sql`, unreleased) |

```text
applied:                       120, 121, 122, 123, 124, 126, 127, 128
unused historical gap:         125   (never applied, never in the runner)
repository migration ceiling:  129
applied migration ceiling:     128 until release
```

### `main` cannot boot right now, by design

129 is in the build and in no ledger, so the verify gate refuses:

```text
✗ REFUSING TO START — 129_property_line_uniqueness.sql not applied. Ledger ceiling 128.
```

**Consequence for everyone merging to `main`: any deploy is red until 129 is
released.** Render keeps serving the previous build, so production looks healthy
while running older code. That is silent staleness, and it is the reason the
release is the critical path for every thread, not just this one.

Holding unrelated merges does **not** fix this — the red is caused solely by 129
already being on `main`. Releasing 129 is what fixes it.

### Who runs this

**The owner.** Neither Claude thread has production access: this session has no
`DATABASE_URL` and no Render access, and the Slice 9/10 thread's network policy
denies Neon and the production origin (403 on CONNECT). Every production fact in
this repository was read by the owner in the Neon console and pasted back.

---

## 2. Reconcile the whole ledger (read-only)

The gate evaluates the **entire** ledger, so the check must too.

```bash
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

This imports `classifyLedger` from `migrations/ledger_verdict.js` — the same
module `migrate.js` runs at boot — so it cannot disagree with what the deploy
will decide. Do **not** hand-write a `where version not in (...)` list instead:
that is a second implementation of the comparison, typed by hand, at the moment
it matters most.

It reports all four conditions, including the clean ones:

- repository file missing from the ledger — *expected: `129` only*
- ledger row missing from the repository — **must be 0**
- genuine version/name conflict — **must be 0**
- documented legacy naming exception — *expected: `012 property_noi_goals`*

**Required: `EXIT 0` and `✓ RECONCILED`.**

### What the residual risk actually is

`main` carries a file for every version `001`–`129` **except `125`**, and `125`
was never applied. Independently verified from both threads. So no ledger row
with a zero-padded three-digit version in that range can be orphaned.

The only remaining way this trips is a ledger row whose `version` string is not
zero-padded three digits — `'12'`, `'baseline'`. The gate keys on that prefix, so
such a row can never match a file even when its migration demonstrably ran.
`ledger_reconcile.js` reports that case **separately**, because the repair is
different: **correct the ledger's version string. Do not author a new migration
file to satisfy the gate** — that would apply a change the database already has.

**If anything is reported: STOP.** Do not continue to step 3.

---

## 3. Property-line preflight (read-only)

```bash
DATABASE_URL="<prod>" node tools/property_line_preflight.js
```

Uses `normalizePropertyLine` — the same function the resolver and the migration's
CHECK use.

**Required: `EXIT 0` and `✓ CLEAN`.** The output must show:

- no normalized duplicate eligible property numbers;
- no mutation (the tool proves it cannot write before it reads);
- no selected winner;
- sanitized output only — numbers are masked, connection strings never printed.

**If it reports a collision it prints the exact property ids and exits 1. STOP.**
Do not apply 129. Do not repair the numbers opportunistically. Which building
owns a number is an owner ruling — clear the line on whichever properties should
not hold it, then re-run.

---

## 4. Release 129

Only after **both** checks above are clean.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=128 \
EXPECTED_SHA=a08c1da \
node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who has
not read the ledger. If it does not match, the release refuses — that means
something applied migrations since you looked, and you re-inspect rather than
override.

Preserve the sanitized command and the **actual exit code**.

---

## 5. Verify activation

| # | Check | How |
|---|---|---|
| 1 | ledger contains `129` exactly once under the expected name | `select version, name, applied_at from schema_migrations where version='129'` → exactly one row, `property_line_uniqueness` |
| 2 | normalization/backfill completed | `select count(*) from properties where sms_number is not null and sms_number !~ '^\+1[0-9]{10}$'` → **0** |
| 3 | uniqueness enforcement exists | `select indexname from pg_indexes where indexname='uq_properties_sms_number'` → one row; and `select conname from pg_constraint where conname='ck_properties_sms_number_canonical'` → one row |
| 4 | no duplicate eligible normalized numbers remain | `select sms_number, count(*) from properties where sms_number is not null group by 1 having count(*)>1` → **0 rows** |
| 5 | normal verify mode exits 0 | `DATABASE_URL="<prod>" node migrations/migrate.js` → `✓ SCHEMA VERIFIED … Ledger ceiling 129`, exit 0 |
| 6 | the API starts successfully | Render deploy reaches live, service responds |
| 7 | deployed source identity is `a08c1da` | `echo $RENDER_GIT_COMMIT` in the Render shell — **not** the dashboard's branch label |
| 8 | no unrelated migration applied | ledger ceiling is exactly **129**; `select version from schema_migrations where version > '129'` → 0 rows |

Check 5 is the one that proves both directions of the gate agree with production
after the change, and it is now genuinely read-only — verify no longer issues DDL.

---

## 6. Only then, upgrade the proof statement

> Production schema and startup verified. Resident property-line routing is
> enforced in production. The complete real-phone resident-to-maintenance loop
> remains unverified.

The second sentence stays until a real resident texts a real line and a real
technician closes the work order from a real phone. Enforcing the property wall
is not the same as proving the loop.

---

## 7. Receipt to fill in

```text
RECONCILE      tools/ledger_reconcile.js          exit ____   RECONCILED? ____
PREFLIGHT      tools/property_line_preflight.js   exit ____   CLEAN? ____
                 properties holding a line ____   collisions ____
RELEASE        migrate.js --apply                 exit ____
                 EXPECTED_LEDGER_CEILING=128  EXPECTED_SHA=a08c1da
VERIFY         migrate.js (verify)                exit ____   ceiling ____

ledger 129 rows ____ (expect 1)      non-canonical stored lines ____ (expect 0)
uq_properties_sms_number ____        ck_properties_sms_number_canonical ____
duplicate normalized numbers ____ (expect 0)

source SHA ________   merge SHA ________   deploy action ________
deployed identity (RENDER_GIT_COMMIT) ________   verified at ________
```

Source SHA, merge SHA, deploy action, deployed identity and verification time are
**five separate facts**. Recording them as one is how "merged" became "deployed"
became "working" in earlier receipts.
