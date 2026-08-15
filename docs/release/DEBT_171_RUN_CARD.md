# Release Run Card — Migration 171 (Debt)

**Regenerated 2026-08-15 against `claude/philosophy-doctrine-essence-ae6xni`.**
**One migration. Release BEFORE merge. Read the ledger; never type a ceiling.**

---

## ⚠ RENUMBERED FROM 168. READ THIS FIRST.

Debt was originally built as migration `168`. Between design and release, two
other lanes merged to `main` and took `168`, `169` and `170`:

```text
168  migrations/168_compliance_canonical_truth.sql   Compliance
169  migrations/169_utilities_canonical_truth.sql     Utilities
170  migrations/170_compliance_extended_truth.sql     Compliance (extended)
```

That happened in direct conflict with an explicit coordination agreement that
Debt keeps `168`. Rather than block on renegotiating three lanes' numbering,
Debt's own migration was renumbered to the next free slot on its own unmerged
branch — a unilateral but low-risk move, since nothing else references `168`
as Debt's number outside this repo's own docs/tests, all of which were updated
in the same commit.

```text
migrations/168_debt_instruments.sql  →  migrations/171_debt_instruments.sql
```

**Debt's migration content is byte-identical except the self-referential
filename comment on line 2.** No table, column, constraint or index changed.
Every proof (schema falsification, W1–W9, the 120-row derivation, the HTTP
seam, the establishment tool) was re-run at the new number before this card
was regenerated.

---

## ⚠ THE ORDER IS RELEASE FIRST, MERGE SECOND

`prestart` verifies rather than applies. Merging 171 to `main` while it is
pending is a **failed production deploy** — Render keeps the previous instance
live, so the API looks fine while the new schema is simply absent. That trap has
already cost time twice.

Releasing from the branch first avoids it entirely, and the deploy that follows
the merge boots clean because 171 is already in the ledger.

```text
1  read the ledger            expect ceiling 167 — see the caveat below
2  confirm pending = ONLY 171
3  apply the release          167 → 171
4  verify ceiling 171
5  THEN merge branch → main   deploy boots clean
```

### ⚠ THE CEILING MAY NOT BE 167 ANYMORE

The last confirmed production ceiling was 167. Whether Compliance's `168`/`170`
or Utilities' `169` have since been RELEASED (not merely merged to `main`) is
**unverified from this environment** — no `DATABASE_URL` access here. Step 1
below is not a formality; its result determines everything after it.

```text
IF ceiling reads 167   Debt's build list (this card) does not reference
                       168/169/170 at all — they are absent from Debt's own
                       migrations/ directory, not merely skipped. Releasing
                       171 from THIS branch touches nothing of theirs.
                       Proceed as below.

IF ceiling reads 170   168/169/170 were released between the last check and
                       now. Debt's release is still just 171 on top — the
                       query below still returns pending=171 only, because
                       schema_migrations already has 168-170 and Debt's build
                       list never claims them. Proceed as below.

IF ceiling is anything  STOP. Something applied that this card does not
   else                account for. Do not guess why — read what actually
                       happened before releasing anything.
```

Either of the first two outcomes is safe to proceed on. Only the third requires
a human to stop and investigate before running anything below.

---

## ⚠ DO NOT USE `ledger_read_before_release.sql` FOR THIS RELEASE

That file's build list is generated **from `origin/main`**, and `main` now has
168, 169 and 170 — none of which are Debt's. Running it as-is would report
`pending` including those three, which is not what this release is meant to
touch. **Use the query below instead**, generated from Debt's own branch tree
(156 versions, the real 125/138/139 gaps preserved, ending 167, 171 — with
168–170 deliberately absent because they belong to other lanes).

```sql
with build(version) as (values ('001'),('002'),('003'),('004'),('005'),('006'),('007'),('008'),('009'),('010'),('011'),('012'),('013'),('014'),('015'),('016'),('017'),('018'),('019'),('020'),('021'),('022'),('023'),('024'),('025'),('026'),('027'),('028'),('029'),('030'),('031'),('032'),('033'),('034'),('035'),('036'),('037'),('038'),('039'),('040'),('041'),('042'),('043'),('044'),('045'),('046'),('047'),('048'),('049'),('050'),('051'),('052'),('053'),('054'),('055'),('056'),('057'),('058'),('059'),('060'),('061'),('062'),('063'),('064'),('065'),('066'),('067'),('068'),('069'),('070'),('071'),('072'),('073'),('074'),('075'),('076'),('077'),('078'),('079'),('080'),('081'),('082'),('083'),('084'),('085'),('086'),('087'),('088'),('089'),('090'),('091'),('092'),('093'),('094'),('095'),('096'),('097'),('098'),('099'),('100'),('101'),('102'),('103'),('104'),('105'),('106'),('107'),('108'),('109'),('110'),('111'),('112'),('113'),('114'),('115'),('116'),('117'),('118'),('119'),('120'),('121'),('122'),('123'),('124'),('126'),('127'),('128'),('129'),('130'),('131'),('132'),('133'),('134'),('135'),('136'),('137'),('140'),('150'),('151'),('152'),('153'),('154'),('155'),('156'),('157'),('158'),('159'),('160'),('161'),('162'),('163'),('164'),('165'),('166'),('167'),('171'))
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
ledger_ceiling              167 or 170 — see the branching logic above
pending                     171        ← and NOTHING else. If it names another
                                         version, STOP: a release applies every
                                         pending file, not just yours.
in_ledger_but_not_in_build  168, 169, 170 IS EXPECTED AND FINE if those were
                            released — Debt's build list never claims them, so
                            this is not "code and schema disagree", it is "two
                            other lanes' schema, which this release does not
                            touch". Anything OTHER than 168/169/170 here means
                            stop.
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

The branch contains 171; `main` does not. Releasing here is what makes
release-before-merge possible, and there is no `RENDER_GIT_COMMIT`, so no sha
pin applies.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what step 1 PRINTED — never from this document> \
  node migrations/migrate.js --apply
```

### Path B — from a Render shell

Only valid if the **running instance is a build that contains 171**. A shell on
the current `main` instance cannot release it — that build has no 171 file to
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

**Then re-run the query above.** Expect `ledger_ceiling 171` and `pending`
empty.

### Already protected, so do not add a gate for it

`migrate.js:135` hard-stops on two files sharing a migration number, naming both
and refusing to run. That is what caught nothing here, because the renumbering
happened before any release was attempted — but it is the backstop if a fourth
lane ever tries to reuse 171 the way three lanes collided on 168 in parallel
branches. Two `094`s were merged from parallel branches on 2026-07-26, which is
why it exists. **No duplicate-number gate is needed.**

---

## WHAT IS BEING RELEASED

```text
migrations/171_debt_instruments.sql    426 lines · 7 tables · additive only
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
18/18   debt_establishment_tool.db.js        the controlled establishment tool
11/11   source-governance gates
```

## ROLLBACK

There is no down-migration, and none should be written. 171 is **purely
additive**: seven tables nothing reads. If the Debt code is wrong, the fix is to
not deploy it — the tables sit empty and inert. Dropping them would be a
destructive act against a ledger entry, which is a larger operation than the
problem it solves.

## AFTER THE RELEASE

```text
merge branch → main            deploy boots clean, 171 already in ledger
retain the 3 real 4125 documents as source_artifacts, get their sha256
fill tools/debt/declarations/4125_480010465.json with the real hashes
run tools/debt/establish_instrument.js --apply   (PRODUCTION_APPROVED, Class 4)
prove the production standing read     GET /operator/debt/standing
then the simple Debt UI
```

Ask Spine follows the same governed read after that. Debt's registry entry in
`tests/gate_ask_spine_readers.js` stays `pending` until it does.
