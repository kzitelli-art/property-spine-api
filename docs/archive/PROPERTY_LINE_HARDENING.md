# Property-line ambiguity hardening

**Status: implemented and proven — real Postgres + real HTTP. §33 rung: Proven.**
Base `main` @ `6238d48` · migration **129** · PostgreSQL 16.13 · 2026-08-03.

---

## 1. What was wrong

```sql
select id, name, address, sms_number
  from properties where sms_number = $1 limit 1
```

`limit 1`, no `order by`. Two properties holding one number bound a resident's
message to an **arbitrary** one — their claim landing on another building's
ledger, confidently, with no signal. `properties.sms_number` had no unique
index; migration 030 is only `add column if not exists sms_number text`. One
guarded route (`tenantlink.js`, 409 on clash) was the entire defence: application
code with no database backstop, bypassed by any seed, migration, admin tool or
direct SQL.

**The asymmetry is the finding.** The same function already refuses to guess the
*sender*: zero or more than one eligible person is `needs_human`, *"never a
silent pick between two different humans."* So the system declined to guess which
human texted, then silently guessed which building they texted.

**A second defect, found while building.** The write path normalized
(`normalizePhone`) and the read path did not — inbound compared the **raw** `To`
against a normalized store. A line stored in any other format was therefore not
mis-routed but **silently unreachable**. Three readings of one rule were in play:
`tenantlink.js:117 normalizePhone`, `identity/phone_identity normalizeE164` (same
plus a `+` passthrough), and the inbound lookup (none).

---

## 2. The resolver contract

```text
0 eligible properties  → unknown line
                       → no property-scoped work order, event, obligation, outbound

1 eligible property    → resolve normally

2+ eligible properties → ambiguous line
                       → fail closed
                       → no property-scoped work order, event, obligation, outbound
```

A fourth outcome, `unresolvable`, covers a `To` that is not a normalizable phone
number. It fails closed identically to `none`; it is named separately because the
repair differs — malformed input, not an unconfigured line.

`property` is **null** for every outcome except `one`, so a caller that forgets to
branch on `outcome` gets a null rather than an arbitrary building. Failing closed
must not depend on the caller having read the documentation.

### Ambiguous line is NOT ambiguous sender

| | ambiguous **sender** | ambiguous **line** |
|---|---|---|
| Property | known | **unknown — the wall itself** |
| Claim | preserved on that property, person-less, `needs_human` | **nothing attached to any property** |
| Field | `ambiguous: true` | `ambiguousLine: true` |

They are never collapsed. With an ambiguous sender a human can still pick up a
real message on the right ledger. With an ambiguous receiving line there is no
ledger the message can honestly belong to, and writing it to one of the
candidates would be the arbitrary bind this slice removes — performed one layer
later.

**No new intake record system was created.** The message is not lost: the provider
retains it, and the boundary logs every candidate property id so an operator can
resolve the collision. That is the existing honest behaviour for `unknownLine`,
extended — not a parallel store.

---

## 3. Normalization

**Owner ruling 2026-08-03: the existing `normalizePhone` output is the canonical
stored and compared form.** US numbers only; anything else returns null and fails
the lookup rather than matching the wrong thing.

That function now lives once, in `src/comms/property_line.js`, and is used by all
three places that had disagreed:

| Site | Before | After |
|---|---|---|
| Write (`tenantlink`) | local `normalizePhone` copy | imports the shared one |
| Inbound resolution | raw exact match | normalizes `To` first |
| Preflight tool | did not exist | imports the shared one |
| Migration 129 CHECK | did not exist | pins the same canonical form |

Moved, not changed — `tenantlink`'s behaviour is identical, and the invite-phone
caller at `:349` is unaffected.

---

## 4. Migration 129

Order is the design. Duplicates are detected **before** anything is mutated.

1. **Refuse** if any stored line cannot be normalized — naming the exact property ids.
2. **Refuse** if two properties normalize to the same line — naming the exact property ids, **choosing no winner**. Picking one would be the same silent bind, moved from read time to migration time.
3. **Backfill** non-canonical values (one-time).
4. **CHECK** `sms_number ~ '^\+1[0-9]{10}$'` — this is what stops a direct write bypassing uniqueness with alternate formatting.
5. **UNIQUE** index on `sms_number where sms_number is not null` — the **same eligibility predicate** `resolvePropertyByLine` uses.

If `properties` ever gains an archived/inactive flag, the index and the resolver
must change in the same commit or the guarantee silently decouples.

**On the SQL normalization inside 129.** It mirrors `normalizePropertyLine()`.
That is a one-time historical transform, not a parallel implementation of a live
rule: after step 4 no non-canonical value can be stored again, so the expression
never governs another write. The ongoing rule has exactly one implementation, in
JavaScript.

---

## 5. Release sequence

129 is in the build and in no ledger, so a deploy now correctly refuses:

```text
  ✗ REFUSING TO START — the schema does not match this code.
    1 migration(s) in this build are NOT applied to the target database:
      · 129_property_line_uniqueness.sql
    Ledger ceiling is 128.
EXIT=1
```

The order is therefore mandatory, not advisory:

```bash
# 1. read-only, safe against production; proves it cannot write before reading
DATABASE_URL="<prod>" node tools/property_line_preflight.js      # must exit 0

# 2. release 129 deliberately
MIGRATION_RELEASE=1 EXPECTED_LEDGER_CEILING=128 EXPECTED_SHA=<sha> \
  node migrations/migrate.js --apply

# 3. deploy
```

If the preflight reports a collision it prints the exact property ids and stops.
**A human decides which building owns the number.** Neither the tool nor the
migration will pick.

---

## 6. Proof

`tests/proofs/property_line_hardening.db.js` — **41 run · 41 passed · 0 failed · exit 0**.
PostgreSQL 16.13, isolated scratch database, `HARNESS_DATABASE_URL` only, no
fallback, no production contact.

Two phases, because they protect against different failures and each must stand
alone:

- **Phase 1 — the code fails closed on a database that still permits the
  ambiguity.** Deliberately run *before* 129 is applied. Run after, the ambiguous
  case could not be constructed at all and "the code fails closed" would be an
  untested claim resting on the constraint.
- **Phase 2 — the database makes the ambiguity unreachable.** Migration 129
  executed verbatim.

| Required coverage | Where |
|---|---|
| canonical E.164 resolves to the correct property | Phase 1 |
| formatting-equivalent inbound numbers resolve identically | Phase 1 — parenthesised, dashed, 11-digit |
| non-canonical existing values handled by the migration | Phase 2c |
| normalized duplicates detected before any mutation | Phase 2a — asserts nothing changed and no index installed |
| unknown line creates no property-bound records | Phase 1, real HTTP |
| ambiguous line creates no property-bound records | Phase 1, real HTTP |
| no cross-property binding possible | Phase 1 — both directions, incl. a formatting variant |
| uniqueness cannot be bypassed by alternate formatting | Phase 2d — refused by `ck_properties_sms_number_canonical` |
| no real SMS sent | Safety — zero sends asserted across the whole run |
| harness-controlled numbers and provider ids | Safety — `+1 555 01xx` reserved range, `HARNESSSID_` prefix, both asserted |

Real HTTP: the actual router mounted exactly as `server.js` mounts it, driven
over a real socket. Zero-write is asserted as a **full row-count vector across
every table in the schema**, not a named-table spot check.

Regression, unchanged: migration release gate 11/11 · inverse ledger gate 24/24 ·
ledger verdict 40/40 · one-implementation 14/14 · import smoke · closure boundary
PASS · no-raw-bridge-joins PASS. All exit 0.

### Schema scope, stated plainly

The harness builds `properties` and `comm_events` from the verbatim definitions in
migrations 001 and 030, plus row-count sentinels for `work_orders` and
`obligations`. It does **not** build the full production schema, because the
migration chain cannot rebuild from an empty database — `012_bank_intake.sql`
fails on `yardi_code` (PR #33). That is a known, owned defect outside this slice.

What that costs: the zero-write assertions cover every table this code path can
reach before it returns. They prove nothing about tables the path never touches.

---

## 7. Known debt this slice creates

**Two phone normalizers now exist, deliberately.**

- `property_line.normalizePropertyLine` — US-only, canonical for property lines.
- `identity/phone_identity.normalizeE164` — same, plus a `+` passthrough that
  accepts already-prefixed international strings. Canonical for **person**
  identity, and untouched here.

A resident's phone and a property's line are different facts with different
rules, and this slice does not get to change person identity. **Removal
condition:** closed when the canonical communication-line model defines line
identity for both inbound and outbound, at which point property lines stop being
a `properties` column at all.

**`properties.sms_number` remains a TEMPORARY ADAPTER (§18).** One
property-facing line per property; cannot express an organisation-owned
operations line. Retired by the canonical communication-line model.

---

## 8. Not in this slice

Canonical communication-line model · operations number · technician SMS loop ·
ITEM 2 · signing configuration · production fixture cleanup · rebuild-from-empty
(PR #33). The staged `docs/slices-6-to-10/deployment_b/125_*.sql` artifact is
untouched and was **not** moved into the runner — 129 was used precisely so a
newly authored 125 could not backfill the historical sequence behind live
126–128.
