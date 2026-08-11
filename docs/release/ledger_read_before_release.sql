-- Generated from the ACTUAL migration files on main @ 3c3084d.
-- Not a hand-typed range: that is exactly how migration 140 was missed.
with build(version) as (values ('001'),('002'),('003'),('004'),('005'),('006'),('007'),('008'),('009'),('010'),('011'),('012'),('013'),('014'),('015'),('016'),('017'),('018'),('019'),('020'),('021'),('022'),('023'),('024'),('025'),('026'),('027'),('028'),('029'),('030'),('031'),('032'),('033'),('034'),('035'),('036'),('037'),('038'),('039'),('040'),('041'),('042'),('043'),('044'),('045'),('046'),('047'),('048'),('049'),('050'),('051'),('052'),('053'),('054'),('055'),('056'),('057'),('058'),('059'),('060'),('061'),('062'),('063'),('064'),('065'),('066'),('067'),('068'),('069'),('070'),('071'),('072'),('073'),('074'),('075'),('076'),('077'),('078'),('079'),('080'),('081'),('082'),('083'),('084'),('085'),('086'),('087'),('088'),('089'),('090'),('091'),('092'),('093'),('094'),('095'),('096'),('097'),('098'),('099'),('100'),('101'),('102'),('103'),('104'),('105'),('106'),('107'),('108'),('109'),('110'),('111'),('112'),('113'),('114'),('115'),('116'),('117'),('118'),('119'),('120'),('121'),('122'),('123'),('124'),('126'),('127'),('128'),('129'),('130'),('131'),('132'),('133'),('134'),('135'),('136'),('137'),('140'),('150'),('151'),('152'),('153'),('154'),('155'),('156'),('157'),('158'),('159'))
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

-- ────────────────────────────────────────────────────────────────────
--  HOW TO READ THE RESULT
--
--  pending                       must list ONLY the migrations you meant
--                                to release. If it names anything else,
--                                STOP — a release applies everything
--                                pending, not just yours.
--  in_ledger_but_not_in_build    must be empty. A version the database
--                                has and this build cannot account for
--                                means the code and the schema disagree.
--  ledger_ceiling                the value EXPECTED_LEDGER_CEILING must
--                                be given. It exists so a release cannot
--                                be run by someone who has not looked.
--
--  REGENERATE THIS FILE, do not edit it by hand:
--    git ls-tree --name-only origin/main migrations/ \
--      | grep -oE '^migrations/[0-9]{3}' | sed 's|migrations/||' \
--      | grep -v '^000$' | sort -n
--
--  A hand-typed range is how migration 140 was missed: the query asserted
--  a `pending` list narrower than the build it was checking, and reported
--  a clean answer for a set it had never looked at.
-- ────────────────────────────────────────────────────────────────────
