# Release ceremony — migrations 182 → 187

**Schema release only.** This lands six migrations. It does **not** activate
Skyline. Pricing, lease configuration, the real Skyline instrument, legal
sufficiency and company-signing authority are separate gates, and the system
must keep refusing the leasing journey until those business facts exist.
Do not bypass `no_published_pricing_version` to make anything demo.

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
