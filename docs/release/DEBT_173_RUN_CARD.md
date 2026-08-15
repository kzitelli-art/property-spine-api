# Release Run Card — Migration 173 (Debt)

**Regenerated 2026-08-15 against `claude/philosophy-doctrine-essence-ae6xni`.**
**One migration. Release BEFORE merge. Read the ledger; never type a ceiling.**

---

## ⚠ RENUMBERED TWICE. READ THIS FIRST.

Debt was originally built as migration `168`, then renumbered to `171` when
Compliance and Utilities took `168`–`170` on `main` while Debt was paused. This
is the **second** renumbering: between that release plan and this one, a third
lane — Contracted Services — merged to `main` and took `171` **and** `172`:

```text
171  migrations/171_contracted_services_canonical_truth.sql            Contracted Services
172  migrations/172_contracted_service_nullable_commencement_trigger.sql  Contracted Services (fix)
```

Debt's own migration was renumbered again, to the next free slot on its own
unmerged branch:

```text
migrations/171_debt_instruments.sql  →  migrations/173_debt_instruments.sql
```

**Debt's migration content is byte-identical except the self-referential
filename comment on line 2.** No table, column, constraint or index changed.
Every proof (schema falsification, W1–W9, the 120-row derivation, the HTTP
seam) was re-run at the new number before this card was regenerated:

```text
17/17   debt_schema_falsification.db.js
42/42   debt_position_falsification.db.js
23/23   debt_routes_http.db.js
13/13   debt_institutional_acceptance.db.js
```

`debt_establishment_tool.db.js` was also re-run and still refuses to complete
— correctly. That failure is unrelated to the renumbering: every
`source_sha256` in `tools/debt/declarations/4125_480010465.json` is still a
placeholder, and the tool refuses to establish anything from a document Spine
does not hold. See "AFTER THE RELEASE" below — that is the actual remaining
blocker, not this renumbering.

**If a fourth lane takes 173 before this releases, renumber again. Do not
renumber backward to reclaim 171 or 172 — those are real, merged, and not
Debt's.**

---

## ⚠ THE ORDER IS RELEASE FIRST, MERGE SECOND

`prestart` verifies rather than applies. Merging 173 to `main` while it is
pending is a **failed production deploy** — Render keeps the previous instance
live, so the API looks fine while the new schema is simply absent. That trap
has already cost time twice.

Releasing from the branch first avoids it entirely, and the deploy that follows
the merge boots clean because 173 is already in the ledger.

```text
1  read the ledger              expect ceiling somewhere in 167–172 — see below
2  confirm pending = ONLY 173
3  apply the release            <ceiling> → 173
4  verify ceiling 173
5  THEN merge branch → main     deploy boots clean
```

### ⚠ THE CEILING IS UNVERIFIED FROM THIS ENVIRONMENT

The last confirmed production ceiling was 167. Whether Compliance's `168`/`170`,
Utilities' `169`, or Contracted Services' `171`/`172` have since been RELEASED
(not merely merged to `main`) is **unverified from this environment** — no
`DATABASE_URL` access here. Step 1 below is not a formality; its result
determines everything after it.

```text
IF ceiling reads anywhere    None of 168–172 belong to Debt, and Debt's own
   from 167 through 172      build list (below) never claims them. Whatever
                             subset has actually been released, Debt's
                             release is still just "apply 173 on top" — the
                             pending query still returns 173 only. Proceed.

IF ceiling is below 167,     STOP. Something applied — or failed to apply —
   above 172, or otherwise   that this card does not account for. Do not
   does not look like a      guess why. Read what actually happened before
   clean prefix of 001–172   releasing anything.
```

Either way, only the second outcome requires a human to stop and investigate
before running anything below.

---

## ⚠ DO NOT USE `ledger_read_before_release.sql` FOR THIS RELEASE

That file's build list is generated **from `origin/main`**, and `main` now has
168 through 172 — none of which are Debt's. Running it as-is would report
`pending` including all five, which is not what this release is meant to
touch. **Use the query below instead**, generated from Debt's own branch tree:
160 real versions from `main` (001–172, with the real gaps at 125, 138, 139,
and 141–149 preserved) plus Debt's own pending 173.

```sql
with build(version) as (values ('001'),('002'),('003'),('004'),('005'),('006'),('007'),('008'),('009'),('010'),('011'),('012'),('013'),('014'),('015'),('016'),('017'),('018'),('019'),('020'),('021'),('022'),('023'),('024'),('025'),('026'),('027'),('028'),('029'),('030'),('031'),('032'),('033'),('034'),('035'),('036'),('037'),('038'),('039'),('040'),('041'),('042'),('043'),('044'),('045'),('046'),('047'),('048'),('049'),('050'),('051'),('052'),('053'),('054'),('055'),('056'),('057'),('058'),('059'),('060'),('061'),('062'),('063'),('064'),('065'),('066'),('067'),('068'),('069'),('070'),('071'),('072'),('073'),('074'),('075'),('076'),('077'),('078'),('079'),('080'),('081'),('082'),('083'),('084'),('085'),('086'),('087'),('088'),('089'),('090'),('091'),('092'),('093'),('094'),('095'),('096'),('097'),('098'),('099'),('100'),('101'),('102'),('103'),('104'),('105'),('106'),('107'),('108'),('109'),('110'),('111'),('112'),('113'),('114'),('115'),('116'),('117'),('118'),('119'),('120'),('121'),('122'),('123'),('124'),('126'),('127'),('128'),('129'),('130'),('131'),('132'),('133'),('134'),('135'),('136'),('137'),('140'),('150'),('151'),('152'),('153'),('154'),('155'),('156'),('157'),('158'),('159'),('160'),('161'),('162'),('163'),('164'),('165'),('166'),('167'),('168'),('169'),('170'),('171'),('172'),('173'))
select
  (select max(version) from schema_migrations)                         as ledger_ceiling,
  (select count(*) from build)                                         as files_in_build,
  (select string_agg(b.version, ', ' order by b.version) from build b
     where not exists (select 1 from schema_migrations m where m.version = b.version))
    as pending,
  (select string_agg(m.version, ', ' order by m.version) from schema_migrations m
     where m.version <> '000'
       and not exists (select 1 from build b where b.version = m.version))
    as in_ledger_but_not_in_build;
```

**Required result before proceeding:**

```text
ledger_ceiling              somewhere in 167–172 — see the branching logic above
pending                     173        ← and NOTHING else. If it names another
                                         version, STOP: a release applies every
                                         pending file, not just yours.
in_ledger_but_not_in_build  any subset of 168, 169, 170, 171, 172 IS EXPECTED
                            AND FINE — Debt's build list never claims them, so
                            this is not "code and schema disagree", it is
                            "other lanes' schema, which this release does not
                            touch". Anything OTHER than a subset of
                            {168,169,170,171,172} here means stop.
```

---

## THE RELEASE

### ⚠ THIS CARD PINS NO SHA, DELIBERATELY

The sha that matters is the **build actually running**, not this document's
commit — any literal written here is stale the moment the file is edited again.

`migrate.js` only consults `EXPECTED_SHA` when `RENDER_GIT_COMMIT` is set:

```text
RENDER_GIT_COMMIT set        EXPECTED_SHA is REQUIRED, and must prefix-match
                             the running build, or the release is REFUSED
RENDER_GIT_COMMIT unset      EXPECTED_SHA is ignored entirely
```

### Path A — from a checkout of the release branch (recommended)

The branch contains 173; `main` does not. Releasing here is what makes
release-before-merge possible, and there is no `RENDER_GIT_COMMIT`, so no sha
pin applies.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 PRINTED — never from this document> \
  node migrations/migrate.js --apply
```

### Path B — from a Render shell

Only valid if the **running instance is a build that contains 173**. A shell on
the current `main` instance cannot release it — that build has no 173 file to
apply, and `migrate.js` would correctly report nothing pending.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 PRINTED> \
EXPECTED_SHA=<read $RENDER_GIT_COMMIT ON THAT INSTANCE — not from here> \
  node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who has
not looked. Typing whatever this card last said defeats the only control on the
operation — and the same reasoning is why no sha is written above.

**Then re-run the query above.** Expect `ledger_ceiling 173` and `pending`
empty.

### Already protected, so do not add a gate for it

`migrate.js:135` hard-stops on two files sharing a migration number, naming both
and refusing to run. That is exactly what would have caught this collision had
it reached `main` unrenumbered — it did not, because the renumbering happened
here, before any release was attempted. It remains the backstop if a fifth lane
ever tries to reuse 173 the way Contracted Services collided with Debt's prior
171. Two `094`s were merged from parallel branches on 2026-07-26, which is why
it exists. **No duplicate-number gate is needed.**

---

## WHAT IS BEING RELEASED

```text
migrations/173_debt_instruments.sql    426 lines · 7 tables · additive only
```

Seven new tables, no ALTER on anything existing, no data migration, no backfill.
Nothing in production reads them yet — the Debt service and read code deploy
**after** this release, which is the point of doing it in this order.

Proven at the new number before release, against real PostgreSQL 16:

```text
17/17   debt_schema_falsification.db.js      the walls the schema refuses
42/42   debt_position_falsification.db.js    W1–W9 + 120/120 published schedule
13/13   debt_institutional_acceptance.db.js  the ten institutional questions
23/23   debt_routes_http.db.js               the two-GET read seam, over real HTTP
```

## ROLLBACK

There is no down-migration, and none should be written. 173 is **purely
additive**: seven tables nothing reads. If the Debt code is wrong, the fix is to
not deploy it — the tables sit empty and inert. Dropping them would be a
destructive act against a ledger entry, which is a larger operation than the
problem it solves.

## AFTER THE RELEASE

```text
merge branch → main            deploy boots clean, 173 already in ledger
retain the 3 real 4125 documents as source_artifacts, get their sha256
fill tools/debt/declarations/4125_480010465.json with the real hashes
run tools/debt/establish_instrument.js --apply   (PRODUCTION_APPROVED, Class 4)
prove the production standing read     GET /operator/debt/standing
then the simple Debt UI
```

This is the actual remaining blocker, and it is an access problem, not a
schema or code problem: the Microsoft 365 connector available in this
environment returns extracted text for these documents, not raw bytes —
`downloadUrl` is null on every result. A real sha256 requires either a human
downloading these specific PDFs and uploading them through the app's real
document intake path (which hashes server-side), or direct file-storage access
this environment doesn't have.

Ask Spine follows the same governed read after that. Debt's registry entry in
`tests/gate_ask_spine_readers.js` stays `pending` until it does — deliberately,
per that file's own comment: Debt Build 1 stops at the canonical read, and this
is not something to wire early just to change that count.
