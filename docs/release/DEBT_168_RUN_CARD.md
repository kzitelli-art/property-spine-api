# Release Run Card — Migration 168 (Debt)

**Prepared 2026-08-13 against `claude/philosophy-doctrine-essence-ae6xni`.**
**One migration. Release BEFORE merge. Read the ledger; never type a ceiling.**

---

## ⚠ THE ORDER IS RELEASE FIRST, MERGE SECOND

`prestart` verifies rather than applies. Merging 168 to `main` while it is
pending is a **failed production deploy** — Render keeps the previous instance
live, so the API looks fine while the new schema is simply absent. That trap has
already cost time twice.

Releasing from the branch first avoids it entirely, and the deploy that follows
the merge boots clean because 168 is already in the ledger.

```text
1  read the ledger            expect ceiling 167
2  confirm pending = ONLY 168
3  apply the release          ceiling 167 → 168
4  verify ceiling 168
5  THEN merge branch → main   deploy boots clean
```

---

## ⚠ DO NOT USE `ledger_read_before_release.sql` FOR THIS RELEASE

That file's build list is generated **from `origin/main`**, and `main` has no
168. Run it as-is and `pending` comes back **empty** — a clean answer for a set
that does not contain the file being released. That is the migration-140 failure
mode wearing this release's clothes.

Its regeneration command hardcodes `origin/main`; for a branch-first release the
ref must be the ref being released. **Use the query below instead**, generated
from the release ref (156 versions, ending 167, 168).

```sql
with build(version) as (values ('001'),('002'),('003'),('004'),('005'),('006'),('007'),('008'),('009'),('010'),('011'),('012'),('013'),('014'),('015'),('016'),('017'),('018'),('019'),('020'),('021'),('022'),('023'),('024'),('025'),('026'),('027'),('028'),('029'),('030'),('031'),('032'),('033'),('034'),('035'),('036'),('037'),('038'),('039'),('040'),('041'),('042'),('043'),('044'),('045'),('046'),('047'),('048'),('049'),('050'),('051'),('052'),('053'),('054'),('055'),('056'),('057'),('058'),('059'),('060'),('061'),('062'),('063'),('064'),('065'),('066'),('067'),('068'),('069'),('070'),('071'),('072'),('073'),('074'),('075'),('076'),('077'),('078'),('079'),('080'),('081'),('082'),('083'),('084'),('085'),('086'),('087'),('088'),('089'),('090'),('091'),('092'),('093'),('094'),('095'),('096'),('097'),('098'),('099'),('100'),('101'),('102'),('103'),('104'),('105'),('106'),('107'),('108'),('109'),('110'),('111'),('112'),('113'),('114'),('115'),('116'),('117'),('118'),('119'),('120'),('121'),('122'),('123'),('124'),('126'),('127'),('128'),('129'),('130'),('131'),('132'),('133'),('134'),('135'),('136'),('137'),('140'),('150'),('151'),('152'),('153'),('154'),('155'),('156'),('157'),('158'),('159'),('160'),('161'),('162'),('163'),('164'),('165'),('166'),('167'),('168'))
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
ledger_ceiling              167
pending                     168        ← and NOTHING else. If it names another
                                         version, STOP: a release applies every
                                         pending file, not just yours.
in_ledger_but_not_in_build  (empty)    ← anything here means code and schema disagree
```

---

## THE RELEASE

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 PRINTED — never from this document> \
EXPECTED_SHA=9c552dc \
  node migrations/migrate.js --apply
```

`EXPECTED_LEDGER_CEILING` exists so a release cannot be run by someone who has
not looked. Typing `167` because this card says so defeats the only control on
the operation.

**Then re-run the query above.** Expect `ledger_ceiling 168` and `pending`
empty.

---

## WHAT IS BEING RELEASED

```text
migrations/168_debt_instruments.sql    426 lines · 7 tables · additive only
```

Seven new tables, no ALTER on anything existing, no data migration, no backfill.
Nothing in production reads them yet — the Debt service and read code deploy
**after** this release, which is the point of doing it in this order.

Proven before release, against real PostgreSQL 16:

```text
17/17   debt_schema_falsification.db.js      the walls the schema refuses
42/42   debt_position_falsification.db.js    W1–W9 + 120/120 published schedule
13/13   debt_institutional_acceptance.db.js  the ten institutional questions
11/11   source-governance gates
```

## ROLLBACK

There is no down-migration, and none should be written. 168 is **purely
additive**: seven tables nothing reads. If the Debt code is wrong, the fix is to
not deploy it — the tables sit empty and inert. Dropping them would be a
destructive act against a ledger entry, which is a larger operation than the
problem it solves.

## AFTER THE RELEASE

```text
merge branch → main            deploy boots clean, 168 already in ledger
establish 4125                 through the canonical writers, in production
prove the standing read        against production data
then the simple Debt UI
```

Ask Spine follows the same governed read after that. Debt's registry entry stays
`pending` until it does.
