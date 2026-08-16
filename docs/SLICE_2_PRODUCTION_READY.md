# Slice 2 — Production Ready, and the one thing blocking the rung

**Status: PRODUCTION READY. Not deployed, not established, not verified in
production.** 2026-08-16.

Everything in steps 1–11 of the ship sequence is built and proven locally,
including the browser rung. Step 12 cannot start, for one reason, stated
below and nowhere padded with more architecture.

---

## 1 · The blocker, named exactly

```text
OUTBOUND HTTPS TO THE DEPLOYED API IS DENIED BY NETWORK POLICY

  curl https://property-spine-api.onrender.com/
    → CONNECT tunnel failed, response 403

  agent proxy status, recentRelayFailures:
    connect_rejected  property-spine-api.onrender.com:443
    "gateway answered 403 to CONNECT (policy denial or upstream failure)"

PRODUCTION DATABASE CREDENTIALS ARE NOT PRESENT IN THIS SESSION

  DATABASE_URL   unset
  no Render, Neon, or deploy credentials in the environment
```

That is infrastructure, not architecture. There is no code change that
makes it go away, and writing one would be replacing a blocker with work.

**What it prevents, precisely:** reading the live migration ledger,
releasing 175–177, deploying, establishing Skyline through the production
path, staging the tracker there, signing in as a real operator, and
verifying 144 / 16 / 90.0% and $130,532 against production. Steps 1–12 of
the ship sequence, all of them.

**What it does not prevent, and what is therefore done:** every rung below
production. The full local suite, the DB proofs against real Postgres, and
the browser proof driving the real app against the real server on the real
Skyline import and Mike's real tracker.

---

## 2 · What is ready to release

Three migrations, in this order. **A deploy does not migrate** — `prestart`
verifies and refuses to start on a pending file, so releasing schema is a
separate, deliberate act before the code deploy.

```text
175_person_ingress_resolution_kind.sql     already written, not yet released
176_property_leasing_cycles.sql            new — the named cycle
177_activation_source_supersession.sql     new — which tracker version is current
```

### The release command

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who
has not read the ledger. **Read it first; do not copy a number from this
document** — it is a snapshot of an assumption, and the trap it guards has
already cost time twice (`docs/THREAD_HANDOFF.md` §3).

```sh
#  1. READ the live ceiling. This is the step the variable exists to force.
psql "$DATABASE_URL" -c "select max(version) from schema_migrations;"

#  2. Release, with what you just read.
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 printed> \
EXPECTED_SHA=<the sha being deployed> \
  node migrations/migrate.js --apply

#  3. Verify the ceiling moved to 177, then deploy API and app.
```

### What 176 and 177 do to a live database

```text
176   CREATE TABLE property_leasing_cycles. New table only. Nothing reads
      it until a cycle is established, and every forward read still accepts
      explicit dates, so the deploy changes no existing answer.

177   ALTER TABLE activations — six nullable columns and one PARTIAL unique
      index on (property_id, source_kind) where status='activated' and
      superseded_by_id is null and source_kind is not null.

      ⚠ THE INDEX IS THE ONLY THING THAT CAN BITE. Existing activations
      have source_kind NULL and are therefore OUTSIDE the index entirely —
      by design, so no historical row is retro-classified into a lane it
      was never told about. Confirm before releasing:

        select count(*) from activations where source_kind is not null;
        -- expected: 0 on any database that has not run the new intake
```

---

## 3 · The production sequence, once access exists

Unchanged from the ruling, with the one addition that the cycle must be
established before the surface can default to it.

```text
 1  read the live ledger ceiling
 2  release 175, 176, 177
 3  deploy API + app together
 4  establish Skyline through the canonical production path
 5  establish the 2026–27 cycle          2026-08-01 → 2027-07-31
 6  stage Mike's tracker through stageTrackerClaims — the SAME seam,
    no production-only loader
 7  real operator login, server-issued property scope
 8  open Forward Leasing
 9  prove 144 committed / 16 remaining / 90.0%
10  prove Forward Rent: $113,687 + $3,500 = $117,187 CLAIMED,
    $13,345 ASSUMED, $130,532 run rate, contractual NOT_ESTABLISHED
11  prove the monthly schedule steps down in January from real lease ends
12  prove Rent Roll · Person · Forward Leasing · Ask Spine all resolve to
    the same canonical property truth
```

**Step 6 is the one to watch.** The temptation under time pressure is a
production-only script that inserts claims directly. That would make the
production numbers unfalsifiable — they would prove the loader, not the
seam. The seam is `stageTrackerClaims`, it is the same function the browser
proof drives, and it must be what runs.

---

## 4 · What is proven, and at which rung

```text
PROVEN (real Postgres)
  forward_rent.db.js               33/33
  forward_leasing_ledger.db.js     20/20
  tracker_intake.db.js             18/18
  gate_ask_spine_readers.js        73/73
  gate_person_ingress.js           10/10

BROWSER VERIFIED (real app, real server, real import, real tracker)
  forward_leasing_ledger.browser.js  65/65
  screenshots: docs/screenshots_forward_ledger/ (property-spine-app)

NOT VERIFIED
  anything in production. No step of §3 has been attempted.
```

`gate_harness_isolation.js` remains red on
`tools/equity/establish_position.js`, inherited from `21e6812` and outside
this lane by instruction. It listed that one consumer before this build and
lists that one consumer after it.

---

## 5 · Still parked, deliberately

```text
pace vs prior cycle              the historical commitment clock was never
                                 recorded and cannot be reconstructed
future physical readiness        contractually free is not offerable
prospect promise / offerable     needs governed future readiness
dated open-bed forecast          needs a stated term assumption per open bed
pricing optimisation             not a Pricing platform
concessions · screening ·        untouched
applications · e-sign
NOI · NCF · debt service ·       not built, not designed
valuation · owner sensitivity
```
