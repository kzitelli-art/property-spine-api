# ⛔ SUPERSEDED — DO NOT EXECUTE

**Migration 129 is applied. This packet cleared a blocker that no longer
exists, and running it against production would be acting on a false premise.**

Verified in the Render shell, 2026-08-05:

```text
echo $RENDER_GIT_COMMIT     a04a1df…      main tip, deployed and booting
node tools/ledger_reconcile.js
  ledger rows        135
  applied ceiling    136        ← 129 and 130–136 all applied
  repository ceiling 136
  ✓ RECONCILED — both directions agree across the WHOLE ledger.  EXIT 0
```

The premise below — *"`main` cannot boot… production deployed `d3698d3`…
applied ledger ceiling 128"* — described the state before the merges of
2026-08-05. It is retained for history only.

**Remaining work is in `ACTIVATION_SMS_WORK_ORDER_HANDOFF.md`, Part B.**

---

# UNBLOCK PACKET 1 — migration 129 production activation

**For an authorized operator with Render / Neon access. Self-contained: you do
not need the thread that produced this.**

Neither Claude thread can run any of it — no `DATABASE_URL`, no Render access.

---

## What this clears

`main` currently **cannot boot**. `129_property_line_uniqueness.sql` is in the
build and in no ledger, so the verify gate refuses to start and Render keeps
serving the previous build. **Production looks healthy while running older
code.** That is deliberate, not a fault. This packet ends it.

## Required identity

| | |
|---|---|
| Source `main` | `8330aec` or later |
| Production deployed | `d3698d3` |
| Applied ledger ceiling | **128** |
| Releasing | **129** only |

Confirm deployed identity with `echo $RENDER_GIT_COMMIT` in the Render shell —
**not** the dashboard branch label.

---

## Step 1 — whole-ledger verification (read-only)

```bash
DATABASE_URL="<prod>" node tools/ledger_reconcile.js
```

Imports the same `classifyLedger` the boot gate uses, so it cannot disagree with
what the deploy will decide. It proves it cannot write before it reads anything.

**Expected — safe output:**

```text
  READ-ONLY proven — a write was attempted and refused before any read.
  applied ceiling                    128
  ✓  repository files missing from the ledger      1
  ✓  ledger rows missing from the repository       0
  ✓  genuine version/name conflicts                0
  •  documented legacy naming exceptions           1
  ── pending: in this build, not yet applied ──
     · 129_property_line_uniqueness.sql
  ✓ RECONCILED
  EXIT  0
```

**Required: `EXIT 0` and `✓ RECONCILED`.** The single pending file must be
`129` and nothing else. The one legacy exception (`012 property_noi_goals`) is
expected and documented.

**STOP if** any ledger row is missing from the repository, any name conflict
appears, or more than `129` is pending.

---

## Step 2 — property-line preflight (read-only)

```bash
DATABASE_URL="<prod>" node tools/property_line_preflight.js
```

Uses the same `normalizePropertyLine` the resolver and migration 129 use.

**Expected — safe output:**

```text
  READ-ONLY proven — a write was attempted and refused before any read.
  COLLIDING LINES                    0
  unnormalizable                     0
  ✓ CLEAN — every line normalizes and none collide.
  EXIT  0
```

Numbers are masked (`+1***1001`) and no connection string is printed. A
non-canonical-but-fixable value is listed and is **not** a failure — 129
backfills it.

**STOP if it reports a collision.** It prints the exact property ids and exits
1. **Do not apply 129 and do not repair the numbers opportunistically** — which
building owns a number is an owner ruling. Clear the line on whichever
properties should not hold it, then re-run.

---

## Step 3 — release 129

Only after both steps above are clean.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=128 \
EXPECTED_SHA=<deployed sha> \
node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING=128` exists so a release cannot be run by someone who
has not read the ledger. If it refuses on the ceiling, something applied
migrations since you looked — **re-inspect, do not override**.

Preserve the sanitized command and the **actual exit code**.

---

## Step 4 — post-release verification

| # | Check | Command / expectation |
|---|---|---|
| 1 | 129 recorded exactly once | `select version, name, applied_at from schema_migrations where version='129'` → one row, `property_line_uniqueness` |
| 2 | backfill complete | `select count(*) from properties where sms_number is not null and sms_number !~ '^\+1[0-9]{10}$'` → **0** |
| 3 | uniqueness exists | `select indexname from pg_indexes where indexname='uq_properties_sms_number'` → one row |
| 4 | canonical-form check exists | `select conname from pg_constraint where conname='ck_properties_sms_number_canonical'` → one row |
| 5 | no duplicate lines remain | `select sms_number, count(*) from properties where sms_number is not null group by 1 having count(*)>1` → **0 rows** |
| 6 | verify mode passes | `DATABASE_URL="<prod>" node migrations/migrate.js` → `✓ SCHEMA VERIFIED … Ledger ceiling 129`, exit 0 |
| 7 | API starts | Render deploy reaches live and the service responds |
| 8 | deployed identity | `echo $RENDER_GIT_COMMIT` matches the released sha |
| 9 | nothing else applied | ledger ceiling is exactly **129** |

Check 6 is the one proving both directions of the gate agree with production
after the change, and it is genuinely read-only — verify no longer issues DDL.

---

## Stop conditions

Stop and report rather than improvise if:

- `ledger_reconcile.js` reports a ledger row with no file in the repository;
- the preflight reports a collision or an unnormalizable value;
- the release refuses on `EXPECTED_LEDGER_CEILING`;
- more than `129` is pending;
- post-release verify does not reach ceiling 129 with exit 0;
- the service does not start.

**Do not force, do not skip, do not repair data to make a step pass.**

---

## Sanitized receipt

```text
LEDGER RECONCILE   tools/ledger_reconcile.js          exit ____  RECONCILED? ____
                     applied ceiling ____   pending ____________________
PREFLIGHT          tools/property_line_preflight.js   exit ____  CLEAN? ____
                     properties holding a line ____   collisions ____
RELEASE            migrate.js --apply                 exit ____
                     EXPECTED_LEDGER_CEILING=128   EXPECTED_SHA=__________
VERIFY             migrate.js (verify)                exit ____  ceiling ____

ledger 129 rows ____ (expect 1)     non-canonical stored lines ____ (expect 0)
uq_properties_sms_number ____       ck_properties_sms_number_canonical ____
duplicate normalized numbers ____ (expect 0)

source SHA ________   released SHA ________   deploy action ________
deployed identity (RENDER_GIT_COMMIT) ________   verified at ________
```

Source SHA, released SHA, deploy action, deployed identity and verification time
are **five separate facts**. Recording them as one is how "merged" became
"deployed" became "working" in earlier receipts.

---

## After this clears

Proof language may become:

> Production schema and startup verified. Resident property-line routing is
> enforced in production. The complete real-phone resident-to-maintenance loop
> remains unverified.

**Not before.** And this unblocks Slice A's merge sequence only in combination
with Packet 2.
