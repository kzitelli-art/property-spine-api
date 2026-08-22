# Property Spine — consultant brief

**Subject:** four database rows compete for one property's identity. We need a ruling.
**Date:** 22 Aug 2026 · **Status:** evidence gathered, decision blocked on you.
**Rev 2** — Q5 answered (fix exists, five callers bypass it), Q4 re-prioritised, arithmetic
and proof-rung vocabulary corrected. Changes credited to review, marked *(revised)* inline.
**Full detail:** `docs/PROPERTY_IDENTITY_INVENTORY.md` (branch `claude/github-docs-review-5hr4jt`)

---

## 1 · The situation in one paragraph

Property Spine is a property-operations system (Node/Express + Postgres on Neon,
deployed to Render). One physical property — "Solo on Chestnut", 4233 Chestnut St,
Philadelphia — exists as **four separate rows** in the `properties` table. The row that
actually has data behind it, and that the operator screens display, is named
*"Property Spine Demo Building"* at address *"1 Demo Way"*. The row that carries the
correct address and canonical key holds almost nothing. Three of the four rows literally
share the display name "Solo on Chestnut", so any code that looks a property up by name
is picking one of three by creation order.

Nothing is on fire. Nothing is being deleted. But we cannot cleanly onboard the next
property, publish pricing, or trust name-based lookups until someone decides which row
*is* the property and what happens to the others.

**We have deliberately not made that decision.** This brief is the evidence, the open
questions, and the things we think are weak.

---

## 2 · What we established (and how confident we are)

All of this was derived from the source code and from a **throwaway local database** we
built, used, and destroyed. **We did not touch production.**

Each item is marked with this project's proof ladder rather than a loose confidence word,
because they are different claims. `LOCALLY_EXERCISED` means *reproduced on a real
Postgres that is not production* — it deliberately does **not** assert that production's
schema or data match. Nothing in this brief reaches `HTTP_PROVEN`, `BROWSER_VERIFIED`,
`DEPLOYED`, or `PRODUCTION_PROVEN`, and nothing here should be quoted as if it does.

### 2a · The blast radius is large and uneven

**154 foreign keys are DECLARED against `properties`. 152 are LIVE** — the other two are
on `scheduled_charges`, a table dropped by migration 059. An earlier draft of this brief
used 154 as the headline over a table of live counts; the two numbers are now labelled.

If you delete one property row, the **152 live** relationships behave as:

| Behaviour | Count | What it means |
|---|---|---|
| CASCADE | 75 | child rows are destroyed silently |
| RESTRICT / NO ACTION | 71 | the delete is refused while any row exists |
| SET NULL | 6 | the row survives, its property pointer is silently blanked |
| **total** | **152** | |

*Rung: `LOCALLY_EXERCISED`.* Derived from the migration files by a parser with 24
falsification tests. **Cross-check re-run after the parser bug in W7 was fixed**, because
a check run before a fix proves nothing about the code after it: a crude independent grep
and the parser now both return 154 declared / 77 cascade / 42 restrict / 6 set null. The
rename fix could not have changed these counts — it renames tables, it does not add or
remove relationships — but that is now demonstrated rather than asserted.

**The practical read:** a naive `DELETE` almost certainly gets refused rather than
destroying anything, because 71 walls have to be empty first. That is reassuring. The
flip side is that if a delete ever *does* succeed, 75 cascades fire at once.

### 2b · Two "immutable" records are not actually immutable

The system has ~57 database triggers whose job is to refuse deletion of records that
must never be destroyed. **53 refuse unconditionally. 4 can be silently bypassed.**

The bypass is subtle and worth understanding, because it is a design pattern, not a typo.
Those 4 triggers decide whether to refuse by *looking up a parent record*. When a delete
cascades down from the property, the parent is already gone by the time the trigger runs,
so the lookup returns nothing, the check quietly passes, and the record is destroyed.

Two consequences we proved on the throwaway database:

- **Published pricing terms can be destroyed** by deleting the property, even though a
  direct delete is correctly refused with *"the terms of a published pricing version are
  immutable."* This was a known issue internally; we confirmed the mechanism and found
  it also applies to a second table nobody had listed.
- **Release 0 proof-of-completion evidence can be destroyed.** This is maintenance work
  evidence, and it is one of the very few things in this system that has been verified
  working in real production. It carries a delete-refusal trigger and is destroyed anyway.

*Rung: `LOCALLY_EXERCISED` — reproduced experimentally on a throwaway database, not
inferred. That rung is the point: it does **not** cover production, where neither the
schema nor the data has been checked.*

### 2c · Two records make a property delete outright impossible

The inverse also exists, and matters more for costing the work. Two tables carry an
*unconditional* refusal **and** a cascade relationship: `ai_leasing_operating_rules` and
`governed_charge_rulings`. A single row in either and the delete doesn't cascade — it
throws an error and aborts.

**Why this matters to you:** any cost estimate built by reading the foreign keys alone
will classify these two as "would be destroyed." They are the exact opposite — absolute
walls. *Rung: `LOCALLY_EXERCISED` — reproduced experimentally.*

### 2d · Merging two rows is governed by uniqueness, not by delete rules

The decision here is a **migration**, not a deletion — moving one row's records onto
another. Delete rules say nothing about that. What refuses a merge is uniqueness.

**Four constraints allow only one row per property.** If both rows have one, a merge
collides with certainty — no coincidence required:

- the active property-facing phone line
- the published pricing version
- the established opening tenancy position
- the current deal membership

**A merge fails part-way through**, and there is no transaction boundary defined anywhere
for this operation. Half-migrated is a real possible outcome. *Rung: `LOCALLY_EXERCISED`.*

### 2e · Documents cannot be moved at all

Uploaded source documents (rent rolls, loan docs, invoices) are stored in a table that
has **no property column and no foreign key to properties** — it uses a generic
"scope type + scope id" pair. Three consequences:

1. It is **invisible** to the relationship analysis above. Any estimate derived from
   that analysis omits documents entirely.
2. The database **actively refuses** to change a document's binding. There is no
   rebinding path anywhere in the codebase, for any level of admin. The designed remedy
   is "re-upload the corrected file and re-establish"; the wrong record stays forever.
3. **Nothing validates a document's contents against the property it is filed under.** A
   document is bound to whichever property the uploader's session was pointed at.

*Rung: `LOCALLY_EXERCISED` (source-read; no data queried).*

Point 3 explains a separate observation — a "4125 Otis" document appearing under the
displayed Solo property. **That needs no identity confusion to explain it.** We
deliberately kept these as two questions so one doesn't mask the other.

---

## 3 · QUESTIONS FOR YOU

These are the decisions. We have costed them; we have not chosen.

### Q1 — Which row is the property? *(the actual ruling)*

Three options. Full costs in `PROPERTY_IDENTITY_INVENTORY.md`; the short version:

| | Approach | Cheapest part | Most expensive part |
|---|---|---|---|
| **A** | Rename the populated demo row to be the canonical property | Real lease economics are already keyed to it, so they become correct | ~91 code references; every "this is demo data" safety guard inverts and starts protecting production data under a demo name |
| **B** | Move the demo row's records onto the canonical row | Ends with a correct, clean identity | Unknown row count across up to 152 tables; 6 columns silently blank instead of moving; 4 guaranteed collision points; **documents cannot move at all** |
| **C** | Keep both rows, model them as aliases / supersession | No row moves; nothing is at risk | Every read that assumes one row per property must learn about aliases, or you get two properties that are sometimes one |

**Our observation, not a recommendation:** option C is closest to a mechanism that already
exists in the codebase — there is already an identity registry that refuses ambiguous
name lookups and asks the caller to disambiguate.

### Q2 — Is a half-completed merge acceptable, and if not, who builds the guard?

If you choose B, the merge can fail part-way through with records split across two
identities. Nothing in the system currently defines a transaction boundary for this.
**Is building that boundary in scope, or is that a reason to prefer A or C?**

### Q3 — What happens to documents under option B?

The database refuses to move them. The options are (a) leave them on the old row
permanently, (b) re-upload everything and re-establish, or (c) change the immutability
rule — which was a deliberate design decision we would not reverse without you.
**Which?**

### Q4 — The immutability holes are real. The urgency framing was wrong. *(revised twice)*

Published pricing and Release 0 completion evidence can both be destroyed by a property
delete despite carrying guards that say otherwise (§2b). **That finding stands, proven.**

Rev 2 of this brief raised the urgency on review's synthesis — *W5's harness owns the
production UUID, so nobody needs to plan a delete; the harness is the delete path.* It is
a good inference. **We then checked the harness, and it does not hold.** Correcting it
here rather than letting it circulate:

```
tools/scale/activation_proof.js:36   reads SCALE_DATABASE_URL, defaulting to
                                     localhost:5433 — and has NO fallback to
                                     DATABASE_URL, so a production URL in the
                                     environment cannot be picked up
tools/scale/setup_baseline.sh:60     OVERWRITES DATABASE_URL with a hardcoded
                                     localhost URL before any seed runs
assert_isolated_environment.sql      refuses unless current_database() = 'r0scale',
                                     plus a sentinel-table check
```

The scale harness is, in fact, one of the better-guarded things in this repository. Two
further corrections to W5 as first written: the inserts are `on conflict (id) do nothing`,
so they **cannot rename or overwrite** an existing row, and the harness does not delete
properties at all — its deletes are scoped to its own Release 0 fixture tables.

**What remains true about W5, and it is smaller:** the production UUID is present in a
`.sql` file, and its own comment says so. The residual risk is a human copying that
`INSERT` out of the file, or running the `.sql` by hand against a non-isolated database
with `psql` — which bypasses all three guards, since they live in the runner rather than
in the file.

**So Q4 returns to its original shape, with better evidence:** the guards in §2b are worth
fixing on their own merits, no clock attached. It is a schema-level change, so it is your
call. **Fix before the ruling, after it, or accept and document?**

**Method note, because it cost us:** we adopted the harness synthesis from review without
opening the harness. It was a well-reasoned inference from two true findings, and it was
still wrong. Nothing in this brief should be treated as verified unless it names the file
that was read.

### Q5 — ANSWERED, and it is not part of the ruling *(revised)*

An earlier draft asked whether to fold the name-resolution problem into the ruling. That
was wrong, and the correction came from review. **The fix already exists in this codebase
and five callers bypass it.**

`src/identity/property_resolution_service.js` does exactly the right thing: on an exact
name match it returns `ambiguous` with every candidate rather than choosing one. Its own
comment states the doctrine — *"One row resolves; more than one is ambiguous rather than
'the oldest'."* It is not theoretical and not dormant: the import and seed paths
(`snapshot_loader.js`, `seed_endpoint.js`, `seed_snapshot.js`) already route through it.

Five call sites do the thing it forbids, verified line by line:

```
src/identity/operator.js:195     order by created_at asc limit 1
src/leasing/demo_reset.js:80     order by created_at asc limit 1
src/leasing/leasingleads.js:900  order by created_at asc limit 1
src/leasing/leasingleads.js:1051 no limit at all — takes rows[0]
src/leasing/demo_preflight.js:106 order by created_at asc limit 1
```

Three rows share that name, so *"oldest wins"* is a coin flip wearing a `limit 1`. The
missing piece is not new code — it is routing five callers through a service that already
refuses correctly. **This is cheap, independent of the ruling, and can be done now.**

**One engineering caveat before anyone starts:** the exported function is named
`resolvePropertyForImport`, and `leasingleads.js:1051` is a booking authorization wall,
not an import. Either the function is renamed to reflect a broader contract or a sibling
is extracted for the authorization case — the doctrine is right, the name is scoped
narrower than the five new callers. **Which do you want?**

### Q6 — We need two UUIDs that only exist in production.

Two of the four competing rows appear nowhere in the codebase except as truncated
prefixes copied from a production log. **We cannot get them without someone running a
query.** See §5 — the query is written and waiting.

---

## 4 · WEAK SPOTS — things we think are fragile

Ordered by how much they'd cost if ignored. These are findings, recorded and **not**
fixed, because fixing them was out of scope for an evidence-gathering pass.

| # | Weak spot | Why it matters |
|---|---|---|
| **W1** | **Five call sites resolve a property by a *name* three rows share**, four with `order by created_at asc limit 1` and one — a booking authorization wall — with no limit at all. **A correct resolver already exists** (`property_resolution_service.js`) and is live in the import path; these five bypass it. The same codebase tells its AI model the opposite rule: *"the ADDRESS is the stable identity of a property — NOT its name."* | Highest-risk item found, **and the cheapest to fix** — see Q5. It is five call sites, not one, and the fix is routing rather than new code. |
| **W2** | **The one irreplaceable record in the system — a real completed customer tour from 5 July 2026 — is protected only indirectly.** It has exactly two mentions in the entire codebase, one of which is a *comment*. Nothing is keyed to the record itself; it survives only because its parent property is on a do-not-delete list, and that list guards *deletion*, not *moves*. | Option B would move this record with nothing in the code protecting it by name. |
| **W3** | **Release 0 completion evidence is destroyable** (see §2b) despite carrying a guard, and it is one of the few things verified working in real production. | Silent data loss with no error. |
| **W4** | **Two of the system's domains (Debt and Equity) cite source documents with no check that the document belongs to that property**, unlike five sibling domains that all check. One offline tool matches documents by file hash with no property filter at all. | A financial position could be established from another property's document. |
| **W5** | **A test-harness SQL file inserts the production property's exact UUID under a different name.** Its own comment acknowledges this. | Run against production it would collide with the row holding the irreplaceable tour. |
| **W6** | **Production and the main branch have diverged again** — production runs 43 commits ahead of `main`, and deploying is blocked until a human reconciles them. This has now recurred within 48 hours of being marked resolved. | Not our scope, but it blocks shipping any fix from this work. |
| **W7** | **We found a bug in our own analysis tool mid-build.** It reported a table that was renamed away nine migrations ago, because the rename was hidden inside a code block our parser skipped. Caught only by comparing against a real database. | Stated plainly because it is the honest caveat on everything in §2: source analysis is a description of the system, not the system. |

---

## 5 · What is ready to run (needs someone with database access)

We wrote a **read-only census script** that answers the questions we cannot:
`tools/identity/property_census.sql` — paste into the Neon SQL editor.

**We deliberately did not run it.** The session doing this work was unattended and had no
production credentials; we took the view that an unattended session is not where you find
out a credential was broader than advertised.

Safety properties, all verified:

- `SELECT` statements only — no writes, no DDL, no temp tables, no functions.
- Wrapped in `BEGIN TRANSACTION READ ONLY … ROLLBACK`, so **the database enforces it**,
  not a comment. We confirmed an `INSERT` inside that wrapper is rejected.
- Executed end-to-end against a throwaway local database built from the real migration
  history. Exit code 0.

**It answers six things, in order:**

1. The two missing UUIDs (a discovery query — run this first, paste results into step 1).
2. How many rows each candidate row actually has, per table — **this is the entire cost
   of option B**, and we cannot supply it.
3. Whether more than one candidate holds each of the four collision points — **this
   decides whether a merge can run as one transaction at all.**
4. Whether the two "delete is impossible" records exist on either row.
5. How many immovable documents sit under each.
6. Which property currently owns the irreplaceable tour.

**Nothing in §3 can be costed in rows until this is run.** Everything above is counted in
*tables*, not *records*.

---

## 6 · What we could NOT establish

Stated explicitly so nobody reads silence as zero:

- **Any row count.** No production database was contacted. Every number in this brief
  counts schema definitions, not data.
- **Whether production's schema matches the code.** We compared code against a rebuilt
  local schema, not against production.
- **The current values of eight property-scoped feature flags.** They live in the Render
  dashboard; the codebase records none of them. (Also: the count is eight, not the seven
  previously believed — one was invisible to the obvious search.)
- **The two unknown UUIDs.** Prefixes only.

---

## 6b · Process compliance — stated, because review asked

- **The `CURRENT_STATE.md` closeout ritual ran.** The row is at
  `docs/CURRENT_STATE.md:354` and was committed with the work. This brief did not
  mention it, which is why it read as missing — the ritual happened, the reporting of it
  did not.
- **§18 component classification: now stamped, and it was genuinely absent before.**
  All three tools carry **Class 3 — inventory / evidence infrastructure**, outside the
  signed-in operator workflow, shipping to no user, making no product decision.
  **Removal condition: none, deliberately — this is not Class 4.** The ruling is a
  one-time decision and this tooling is the record of how it was made; the evidence has
  to outlive the ruling or the ruling cannot be re-examined.
- **Rungs, not confidence words.** Corrected throughout §2. Everything here is
  `LOCALLY_EXERCISED` and nothing is above it.

---

## 7 · Suggested next step

0. **Q5 needs no ruling and can start immediately** — route five call sites through the
   resolver that already refuses ambiguity. Tell us which way you want the naming caveat
   resolved and it is a contained change.
1. Someone with Neon access runs `tools/identity/property_census.sql` and returns the
   output — 10 minutes, read-only. **We cannot run this**: this session has no production
   credentials, and that is the design, not an obstacle to route around.
2. You answer **Q1** (which row) and **Q4** (the guards / the harness, and by when).
3. We turn the chosen option into a costed, reversible migration plan with an explicit
   transaction boundary — as a plan, not an execution.

Everything is on branch `claude/github-docs-review-5hr4jt`, branched from the deployed
production commit. **No pull request has been opened** and nothing has been merged, because
the production/main reconciliation in W6 is a human step that hasn't happened yet.
