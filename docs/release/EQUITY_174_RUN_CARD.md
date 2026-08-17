# Release Run Card — Migration 174 (Equity & Preferred Equity)

**Drafted 2026-08-15 as a template. EXECUTED 2026-08-15 by the account owner**
**directly through Neon's staged-migration tooling — not by this session,**
**which never had production `DATABASE_URL`.** The staging/approval step
below (Neon's own migration-branch workflow) substitutes for the
`migrate.js --apply` path this card originally described; the ledger and
safety outcomes are the same.

```text
ledger (production, confirmed)   174 — migration 174 present exactly once
Equity tables                    7, all live in production, all empty
Neon project                     RE Intelligence Spine
production branch                br-old-math-aqvwd76d
production database              neondb
migration id                     7e4503ac-3e7a-40e0-9d96-4c2e448da469
staging branch (temporary)       mcp-migration-2026-08-15T18-31-38
                                  (br-winter-resonance-aqqm0oau) — staged,
                                  verified, then committed to production
retained declaration sources     0 — NO real Equity documents have been
                                  confirmed as retained in production yet
canonical positions               0 — nothing has been established for real,
                                  and that is the correct, honest state
```

---

## ⚠ THIS RELEASE WAS EXECUTED OUTSIDE THIS SESSION

This session drafted the card, refreshed the branch, reran every proof, and
merged the code that reads this schema — it did **not** run the migration.
The account owner staged migration 174 on a temporary Neon branch, verified
it there, and committed it to production directly through Neon's own
tooling, which serves the same safety role the `EXPECTED_LEDGER_CEILING`
check below describes (a release cannot be approved by someone who has not
looked at what is staged). The renumbering-risk and release-procedure
sections below are kept as real reference material for the next migration
in this domain, not as an outstanding to-do for this one.

---

## ⚠ RENUMBERING RISK — CHECK BEFORE ANYTHING ELSE

Debt's own migration was renumbered **twice** before it released (168 → 171
→ 173) because other lanes merged migrations into the gap while Debt's
branch sat unmerged. The exact same risk applies here: if any other lane has
merged a migration numbered 174 (or higher) into `main` since this branch
was cut, `migrations/174_equity_positions.sql` must be renumbered to the
next free slot before release — **do not release a colliding number.**

```sql
-- Read this FIRST, against production, before trusting the "174" in this
-- file's own name. Adapt the build list below to whatever this branch's
-- migrations/ directory actually contains at release time — do not reuse
-- Debt's own list verbatim (see DEBT_173_RUN_CARD.md for why: a build
-- list must be generated from the ACTUAL branch tree, not copied).
select
  (select max(version) from schema_migrations) as ledger_ceiling,
  (select string_agg(version, ', ' order by version) from schema_migrations
    where version::int > 172) as versions_above_debt;
```

If `versions_above_debt` names anything other than `173` (Debt) and
whatever this branch's own equity migration is currently numbered,
**stop** — another lane has taken ground in this range, and
`174_equity_positions.sql` likely needs renumbering to the next free slot,
exactly as Debt's file was renamed twice. Renumbering is a filename and a
self-referential comment change only — no table, column, constraint or
index changes with it (same discipline Debt's second renumbering
documents).

---

## ⚠ THE ORDER IS RELEASE FIRST, MERGE SECOND

Same trap as Debt's, stated in `CLAUDE.md` §3: `prestart` runs
`migrations/migrate.js` in **verify-only** mode. Merging this branch to
`main` while 174 is still pending is a **failed production deploy** — Render
keeps the previous instance live, so the API looks fine while the schema is
simply absent. Release from the branch first; the deploy that follows the
merge then boots clean because 174 is already in the ledger.

```text
1  read the ledger                 confirm the renumbering check above
2  confirm pending = ONLY this equity migration (whatever it is numbered)
3  apply the release               ledger N → N+1
4  verify the new ceiling
5  THEN merge branch → main        deploy boots clean
```

---

## THE RELEASE

### ⚠ THIS CARD PINS NO SHA, DELIBERATELY

Same reasoning as Debt's card: the sha that matters is the build actually
running, not this document's commit. `migrate.js` only consults
`EXPECTED_SHA` when `RENDER_GIT_COMMIT` is set.

### Path A — from a checkout of the release branch (recommended)

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what the query above PRINTED — never from this document> \
  node migrations/migrate.js --apply
```

### Path B — from a Render shell

Only valid if the running instance is a build that actually contains this
migration file.

```bash
MIGRATION_RELEASE=1 \
EXPECTED_LEDGER_CEILING=<what the query above PRINTED> \
EXPECTED_SHA=<read $RENDER_GIT_COMMIT ON THAT INSTANCE — not from here> \
  node migrations/migrate.js --apply
```

**Then re-run the ledger query.** Expect the new ceiling and `pending` empty.

---

## WHAT IS BEING RELEASED

```text
migrations/174_equity_positions.sql   7 tables · additive only
```

Seven new tables — `capital_stack_positions`, `common_equity_class_terms`,
`common_equity_position_overrides`, `preferred_equity_terms`,
`capital_stack_pledges`, `capital_amount_claims`, `capital_stack_conflicts`
— no ALTER on anything existing, no data migration, no backfill. Nothing in
production reads them at release time beyond the establishment probe
already live in `asset_management.js` (which fails soft to "not
established" against an empty table, exactly like Debt's own probe did
before real data existed).

Proven against real PostgreSQL 16, before release:

```text
46/46   equity_position_falsification.db.js   E1–E10 + the 5 Round-4 rulings
14/14   equity_routes_http.db.js              real HTTP, real authority checks
92/92   gate_funding_boundary.js              cross-domain isolation
62/62   gate_ask_spine_readers.js             registry coverage
54/54   asset_management_shell.db.js          no regression in the shell
42/42   debt_position_falsification.db.js     no cross-domain regression
```

Re-run every one of these **at whatever number the migration ends up with**
after the renumbering check above, before releasing — the same discipline
Debt's card required after its own second renumbering.

## ROLLBACK

There is no down-migration, and none should be written. This migration is
**purely additive**: seven tables nothing reads until Equity's route and UI
deploy behind it. If something is wrong, the fix is to not deploy the code
that reads them — the tables sit empty and inert.

## AFTER THE RELEASE

```text
merge branch → main                    deploy boots clean, ledger already updated
prove the production standing read     GET /operator/equity/standing
prove Capital Stack → Equity in the authenticated browser
```

### Real establishment is a SEPARATE, later step — do not skip the gate

Releasing this schema does **not** establish MSC's or any other real
position. That requires:

```text
1  the real governing documents (Interest Holder LLC OA, Holdings LLC OA,
   and MSC's HoldCo Pay Schedule) retained as source_artifacts in
   production, each hashed. The actual §1.49 clause is additionally
   required before resolving the Minimum Dividend relationship; its
   absence does not prevent an honest `not_established` position.
2  a declaration file under tools/equity/declarations/, written the way
   tools/debt/declarations/4125_480010465.json was — one retained artifact
   per canonical row, real sha256 hashes, real locators
3  tools/equity/establish_position.js run --declaration ... (dry-run
   first, then --apply) — it refuses any hash not already retained. Both
   the tool preflight and canonical writer REFUSE to set minimum_dividend_
   relationship_to_preferred_return to anything other than
   'not_established' unless the row has governed-read authority, a
   non-secondary term source, and a retained source artifact. This is
   Round 4's frozen ruling enforced mechanically, not just documented.
```

Ask Spine now follows the same governed reader as the Equity screen. Its
registration proves one read path, not that any production property has
been established; an empty production read must remain `NOT_ESTABLISHED`.
