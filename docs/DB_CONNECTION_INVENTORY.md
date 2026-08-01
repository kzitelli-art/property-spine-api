# DB Connection Inventory — Phase 1 guard coverage audit

**Audit only. Nothing here is fixed, and no remediation is proposed.**
Read-only pass over `property-spine-api` at commit `81b444d`
(branch `claude/new-build-git-setup-o5l93r`, identical to `origin/main`),
2026-08-01.

**No database was contacted.** `HARNESS_DATABASE_URL` was not supplied and not
requested. Every statement below is derived from committed repository source.
Claims about what a file *would* do at runtime are marked as such.

Companion documents: [`DB_HARNESS_ISOLATION.md`](DB_HARNESS_ISOLATION.md) (the
requirement), [`PROOF_OBLIGATION_ENGINE.md`](PROOF_OBLIGATION_ENGINE.md) (the
proof run that motivated it).

---

## Headline

The guard shipped and works as designed. **It covers 6 of 107 database-capable
files.**

| | Count |
|---|---|
| Files that construct a `pg` `Pool`/`Client` | **107** |
| Route through `receipt.harnessConnectionString()` | **6** |
| Reach Postgres without the guard | **101** |
| Of the 6 "guarded", actually functional | **5** — see FINDING 1 |
| Carry an assertion floor (cannot report a pass having proven nothing) | **3** |

The guard is not weak. It is **narrow**: it was applied to the five `.db.js`
harnesses named in `DB_HARNESS_ISOLATION.md` §4 and to the preflight, and to
nothing else. The other 101 files predate it and were never migrated onto it.
Every one of them still reads `process.env.DATABASE_URL` directly — which on
Render is production.

---

## FINDING 1 — `test_adapter_seam.db.js` is dead, and the guard commit killed it

**Severity: high. This is the third occurrence of the repository's signature defect.**

`tests/test_adapter_seam.db.js:13`:

```js
const CONN = receipt.harnessConnectionString();
```

`receipt` is **never declared, never required, and never imported** anywhere in
that file. Its only `require` statements are at lines 9, 10, 11 and 113 — `pg`,
`outlookAcuitySync.js`, `schedulingAdapterSeam.js`. There is no
`require("./_run_receipt.js")`.

Executing the file therefore raises `ReferenceError: receipt is not defined` at
module load, before the pool is constructed and before any assertion runs.

**Provenance.** `faaaec2` — the commit that shipped the guard — rewrote the line:

```diff
-const pool = new Pool({ connectionString: process.env.DATABASE_URL });
+const CONN = receipt.harnessConnectionString();
+const pool = new Pool({ connectionString: CONN });
```

…without adding the import. Its sibling `test_scheduling_interactions.db.js`
received the same edit *and* the `require` at line 8, so only this one file is
affected. The commit body states *"All five .db.js harnesses … now route through
receipt.harnessConnectionString()"*, and lists re-runs for `test_release3`,
`test_identity_bridge`, the conversion rail, one-implementation and import-smoke.
**`test_adapter_seam` and `test_scheduling_interactions` were not among the
re-runs.** The claim covered five files; the evidence covered three.

**Why this is the same shape as before.** `test_conversion_rail.db.js` was dead
for 204 commits for exactly this reason — a throw at construction, zero
assertions, no failing assertion to notice, only an absence. The receipt
mechanism in `_run_receipt.js` exists specifically to make that absence visible.
This file throws *before* it can reach the receipt, so the receipt cannot report
it.

**Honest qualifier:** a load-time `ReferenceError` exits non-zero. Anyone
checking `$?` sees a failure. It is invisible only to a reader eyeballing piped
output — which is precisely the reading pattern under review.

*Not verified by execution:* `pg` is not installed in this container, so a
runtime probe was not possible. The finding rests on static analysis, which for
an undeclared identifier in non-strict module scope is conclusive.

---

## A. Guard coverage audit

### The guard

`tests/_run_receipt.js:80–103`, `harnessConnectionString()`:

- requires `HARNESS_DATABASE_URL`; **no fallback** to `DATABASE_URL` (`:81–92`);
- refuses when the harness URL resolves to the **same target** as `DATABASE_URL`,
  compared on host + port + database rather than string equality, so a differing
  password or trailing `sslmode` cannot slip past (`:61–67`, `:93–101`);
- exits non-zero from **inside** the guard rather than returning, so a caller
  cannot proceed by ignoring a return value (`:74`).

The design is sound. Nothing below is a criticism of the guard's logic.

### Classification

| Class | Meaning | Count |
|---|---|---|
| **R** | Runtime. The web service's own connection. May legitimately reach production. | **1** |
| **B** | Both requireable and self-executing. Behaviour differs by invocation. | **4** |
| **S** | Standalone. Executed as its own process. The guarded population. | **102** |

#### Class R — runtime (not part of the guarded population)

| File | Pool | Connection |
|---|---|---|
| `server.js` | `:165` | `process.env.DATABASE_URL` |

`server.js` owns the web service's pool and passes it into every domain module.
No `src/` module downstream constructs its own — they receive the pool by
injection. This is correct and is the reason the runtime population is one file
rather than 186.

#### Class B — both entry paths

| File | Pool | Require path | Self-execution | Separate pool? |
|---|---|---|---|---|
| `migrations/migrate.js` | `:42` | `package.json` `prestart` → production boot | shebang, direct `node` | yes — builds its own from `DATABASE_URL` |
| `src/shared/seed_snapshot.js` | `:211` | `src/shared/seed_endpoint.js:26` | `require.main === module`, `process.argv` | yes |
| `seeds/seed_demo_slots.js` | `:151` | (no requirer found in source) | `require.main === module`, `process.argv` | yes |
| `tools/seed_solo_facts.js` | `:359` | (no requirer found in source) | `require.main === module`, `process.argv` | yes |

**`migrations/migrate.js` is the expected exception and is treated as such.** Its
production access is not a finding. `package.json:7` runs
`node migrations/migrate.js` as `prestart`, so the Render boot path must reach
production Neon or deploys stop applying migrations. Its two contexts:

1. **Boot (authorized).** `npm start` → `prestart`. Must keep production access.
2. **Standalone (unguarded).** Direct `node migrations/migrate.js` in any shell,
   including the Render Shell, with whatever `DATABASE_URL` that shell carries.

These are indistinguishable from inside the file — it reads the same variable in
both. Any boundary applied here must preserve path 1 while constraining path 2,
and the file cannot currently tell them apart.

**`src/shared/seed_snapshot.js` is the sharpest Class B case.** It is reachable
from the running web service through `seed_endpoint.js`, *and* self-executes on
`require.main`. A file that both serves HTTP and runs as a seeding script is the
one place where a guard applied naively would break a live endpoint.

#### Class S — standalone (the guarded population)

**Guarded — 6 files** (all reach the guard at the line shown):

| File | Guard call | Pool | Receipt import | Assertion floor |
|---|---|---|---|---|
| `tests/db_preflight.js` | `:25` | `:27` | `:21` | own fatal logic |
| `tests/test_conversion_rail.db.js` | `:20` | `:21` | yes | **yes** |
| `tests/test_identity_bridge.db.js` | `:27` | `:33` | yes | **yes** |
| `tests/test_release3.db.js` | `:17` | `:21` | yes | **yes** |
| `tests/test_scheduling_interactions.db.js` | `:13` | `:14` | `:8` | no |
| `tests/test_adapter_seam.db.js` | `:13` | `:14` | **MISSING** | no |

**Unguarded — 96 files.** Every one constructs its own pool from
`process.env.DATABASE_URL`. Enumerated in full:

*`tests/` (74)* — `agent_booking_xturn_proof.js:14` · `application_submission.test.js:30` ·
`authority_resolution_proof.js:31` · `availability_canonical_proof.js:26` ·
`billback_decision_proof.js:42` · `birth_guard.test.js:74` ·
`capability_contract.test.js:177` · `capture_chase_proof.js:122` ·
`comms_boundary_phase_a_proof.js:31,35` · `consent_and_scope_proof.js:37,41` ·
`cross_surface_invariants.js:33` · `demo_authority_ruling_proof.js:32` ·
`demo_book_route_proof.js:16` · `demo_enrollment_dry_run.js:48` ·
`establish_qa_staff_session.js:26` · `executed_lease_overlap_concurrency.test.js:40` ·
`fact_write_resilience_proof.js:29` · `full_lifecycle_arc.js:86` ·
`governed_economics_proof.js:27` · `http_negative_smoke.js:58` ·
`identity_authority_proof.js:30` · `inbound_prospect_resolution_proof.js:27` ·
`intake_source_fallback_proof.js:26` · `lead_source_attribution_proof.js:25` ·
`lease_void_contract.test.js:40` · `legacy_agent_routes_removed_proof.js:31` ·
`movein_arc.js:70` · `movein_beat.js:22` · `never_delete_guard_proof.js:74` ·
`night_harness.js:10` · `owner_eligibility_contract.test.js:44` ·
`ownership_reachability_check.js:47` · `person_facts_proof.js:50,69` ·
`position_classifier_characterization.js:101` · `presence_wall_lease_proof.js:33` ·
`pricing_decision_packet_proof.js:25` · `pricing_foundation_proof.js:26` ·
`pricing_governance_proof.js:29` · `pricing_guards_proof.js:53` ·
`proof_proposed_terms.js:49` · `property_capability_proof.js:32` ·
`prove_confirm_term_concurrency.js:40` · `prove_escalate_move.js:18` ·
`prove_one_in_one_out.js:22` · `prove_persona_v6.js:22` · `qa_lifecycle_arc.js:74` ·
`readiness_certification_proof.js:407` · `relationship_stage_proof.js:18` ·
`renewals_r1_proof.js:31` · `renewals_slice6_proof.js:157` ·
`rent_roll_canonical_proof.js:32` · `rent_roll_institutional_proof.js:26` ·
`resident_sms_route_proof.js:88` · `resident_sms_work_order_proof.js:182` ·
`s4_leasing_work_reconciliation_proof.js:171` · `send_action_basis_contract.test.js:50` ·
`shadow_import.test.js:35,42` · `slice8_governed_economics_proof.js:70` ·
`smoke_proposed_terms_route.js:41` · `smoke_release2.deployed.js:22` ·
`smoke_release3.deployed.js:20` · `staff_agent_proof.js:385` ·
`standing_context_proof.js:97` · `tour_booking_proof.js:21` · `tour_chips_proof.js:21` ·
`tour_outcome_capture_proof.js:30` · `tour_scheduled_for.test.js:88` ·
`tours_conveyor.test.js:298` · `unit_triage_proof.js:343` · `unit_turn_scope_proof.js:476` ·
`walk_in_tour_proof.js:30` · `work_acceptance_proof.js:324` ·
`work_order_authority_proof.js:54` · `work_order_canonical_path_proof.js:60`

*`tools/` (16)* — `accept_brick_one.js:96` · `apply_unit_type_mapping.js:72` ·
`enroll_demo_participants.js:57` · `enroll_internal_qa.js:41` · `followup_dry_run.js:28` ·
`issue_operator_invite.js:55` · `proof_lease_packet_operator_service.js:29` ·
`qa_provision.js:62` · `remove_duplicate_walkins.js:43` · `repair_invalid_task_owners.js:36` ·
`retire_hollow_leases.js:39` · `run_followups.js:24` · `seed_demo_agent_facts.js:40` ·
`seed_demo_inventory.js:68` · `validate_ai_leasing_strategy_replay.js:53` ·
(plus `seed_solo_facts.js`, listed as Class B)

*`seeds/` (2)* — `seed_bridge_demo_staff.js:43` · `seed_demo_live_tour.js:44`
(plus `seed_demo_slots.js`, Class B)

*`src/` standalone (4)* — `identity/enroll_qa.js:18` · `leasing/demo_preflight.js:232` ·
`onboarding/import_rent_roll_truth.js:61` · `shared/no076_failclosed_check.js:18`
— none has any requirer anywhere in source; each builds its own pool. They live
under `src/` but are standalone scripts, not runtime modules.

*root (1)* — `migrate.js:42` — see FINDING 3.

### The three audit questions

**1. Does the shipped guard intercept them?** No. For 101 of 107 files execution
never touches `_run_receipt.js`. The guard is a function that must be called; it
installs no process-level hook, monkey-patch, or `pg` wrapper, so a file that
does not call it is simply unaffected.

**2. What are the bypasses?**

| Bypass | Files | Reaches production? |
|---|---|---|
| Self-built `new Pool({connectionString: process.env.DATABASE_URL})` | 96 Class S + 4 Class B | **Yes**, whenever the shell carries production `DATABASE_URL` — which the Render Shell does |
| Hardcoded local fallback via `\|\|` | 2 — `tests/night_harness.js:10`, `src/shared/no076_failclosed_check.js:18` | No, but silently retargets to a local database when the variable is unset, so a run can appear to work against the wrong target |
| `psql "$DATABASE_URL"` in shell | 2 — `setup_clean_qa_record.sh` (`:25,34,40,65`), `setup_fresh_record_and_prove.sh` (`:13,23,31,54`) | **Yes** — and no JavaScript guard can ever intercept these; they never enter Node |
| Boot path | `migrations/migrate.js` via `prestart` | **Yes, authorized** |

**No `PG*` environment bypass exists.** A sweep for `PGHOST`, `PGUSER`,
`PGPASSWORD`, `PGDATABASE`, `PGPORT` found exactly one hit — `PGSSL` in
`src/shared/no076_failclosed_check.js`, which controls TLS, not the target. Every
file names its target explicitly. The `PG*` implicit-connection risk anticipated
in the Phase 1 framing **is not present in this repository.**

**3. Is the guard reachable but skippable?** Yes, for all 96 unguarded Class S
files — importing `./_run_receipt.js` is all that separates them from coverage.
One structural note: the guard lives in `tests/`, so `tools/`, `seeds/` and
`src/` scripts would each need `../tests/_run_receipt.js`. A test-directory
import from a production tools directory is an awkward dependency, and its
location is part of why adoption stopped at the `.db.js` files.

### False-green inventory

Catalogued, not fixed.

| # | Source | Mechanism | Live? |
|---|---|---|---|
| 1 | **root `migrate.js`** | `MIGRATIONS_DIR = __dirname` (`:32`) is the repo root, which holds no `NNN_*.sql`. `readdirSync` filtered by `/^\d{3}_.*\.sql$/` (`:62–65`) matches nothing — `schema.sql` fails the pattern — so it prints `"No migration files found. Nothing to do."` (`:68`) and returns normally. **Exit 0, zero migrations applied.** | **Yes.** `package.json:7` correctly calls `migrations/migrate.js`, so boot is safe; the trap is anyone running `node migrate.js` from the repo root, which is the natural guess. |
| 2 | **`tests/test_adapter_seam.db.js`** | `ReferenceError` at load; zero assertions. Exits non-zero, so `$?` catches it — invisible only under piped/eyeballed output. | **Yes.** See FINDING 1. |
| 3 | **No assertion floor on 104 of 107 files** | Only `test_conversion_rail`, `test_identity_bridge` and `test_release3` pass `expectedAtLeast` to `receipt.complete()`, which fails a run that executed fewer assertions than expected (`_run_receipt.js:128–133`). Everywhere else the pattern is `process.exit(fail ? 1 : 0)` — correct for failures, but **exit 0 when zero assertions ran**. Any harness whose assertions sit inside a loop over query results reports success on an empty result set. | **Yes.** This is the conversion-rail defect generalised; the floor was built but applied to three files. |
| 4 | **`psql` pipes in shell setup scripts** | `setup_clean_qa_record.sh:31,45,51,56,61` and `setup_fresh_record_and_prove.sh:18,50` pipe `curl` into `head`/`grep`, so `$?` reports the **last** command in the pipeline, not `curl`. `setup_fresh_record_and_prove.sh` sets `set -e`; **`setup_clean_qa_record.sh` does not**, so a failed step there continues silently with an empty variable. | **Yes.** |

**Reviewed and found benign:** 15 empty `catch (_) {}` blocks across `tests/`.
Every one wraps a `rollback`, `pool.end()`, `res.json()` or cleanup call in a
`finally`/error path — swallowing a secondary failure while an error is already
propagating. Standard practice, not a false green.

**Corrected during this audit:** an initial heuristic flagged
`tests/shadow_import.test.js` as unable to fail. It exits correctly at `:232`
(`process.exit(FAIL === 0 ? 0 : 1)`); the detector missed the uppercase
identifier. No such file exists — the exit-code discipline across the proof
suite is sound. The gap is the assertion floor, not the exit code.

### Migrations staged outside `migrations/`

**One.** `docs/slices-6-to-10/deployment_b/125_application_lifecycle_enforcement.sql`,
present only on branch `claude/slice-9-demand-evidence`.

**It has never been applied through the runner, and cannot have been.**
`migrate.js` reads only its own `__dirname`, so a file under `docs/` is invisible
to it. The branch is unmerged, so the file is not on `main` at all.

**This is deliberate, and the reasoning is sound.** Per `368a037`: `migrate.js`
applies every `NNN_*.sql` physically present and has no Deployment-A/B selector,
so shipping 124 and 125 together would apply both during Deployment A and reject
live prospect applications from old instances still serving traffic. 125 is
staged where the runner cannot see it — *"physical absence rather than an
environment-controlled ceiling, which would be a weaker gate."*

The commit body records that it was executed in deployment order against real
Postgres (assertions B1, B1b, B1c, B2). That is a rehearsal, not a production
application, and **which database served that rehearsal cannot be established
from source** — no receipt was preserved.

**Residual risk, recorded not fixed:** at Deployment B the file must be *manually
moved* into `migrations/`. That step is guarded only by a README. If it is
missed, 124's compatibility trigger — Class 3, whose stated removal condition is
*"dropped by 125"* — remains installed indefinitely, and the database keeps
auto-authoring milestones through a mechanism designed to be temporary. §18 asks
for a testable removal condition; this one is a human remembering to move a file.

**Ledger arithmetic.** `migrations/` holds 122 `.sql` files, highest number 122,
one gap at **121** (parked on `claude/getting-up-to-speed-nyf4ww`), no duplicates.
Counting files *including* `000_schema_migrations.sql` gives 122 = max 122 and so
reports "no gaps" — the ledger bootstrap file, which `migrate.js:64` explicitly
skips, exactly offsets the missing 121. The correct count is **121 real
migrations against a max of 122**. Numbers claimed on unmerged branches: 123, 124
(`claude/slice-9-demand-evidence`) and the staged 125. **126 is the next free
number** — but per `COMMUNICATION_LINE_ARCHITECTURE.md:274` that must be
confirmed against the live ledger before it is claimed, because the deployed
ceiling has been below the repository's highest file before.

### Inventory ceiling

**This report cannot establish operational completeness.** It sees repository
source, `package.json`, checked-in shell scripts, `Dockerfile`,
`docker-compose.yml` and committed documentation. **There is no CI configuration
in this repository at all** — no `.github/`, no CircleCI, Travis, GitLab or
Jenkins config — so there are no CI invocation paths to inventory.

Not visible, and therefore not covered:

- undocumented shell usage, including anything run in the Render Shell;
- operator command history;
- Render dashboard configuration, environment variables, cron jobs and job definitions;
- external schedulers or one-off commands run outside the repository;
- any invocation whose only record is a chat transcript.

Several files carry documented invocations in their own headers
(`HARNESS_DATABASE_URL="..." node test_adapter_seam.db.js`), and
`setup_clean_qa_record.sh:69` documents `node prove_confirm_term_concurrency.js`.
These confirm that direct invocation happens; they do not bound it. **Treat the
invocation inventory as a lower bound.**

### Section A conclusion

**1. The population the guard must cover.** 106 files — every database-capable
file except `server.js` (Class R). In practice: 102 Class S plus the standalone
mode of 4 Class B, minus the authorized boot path of `migrations/migrate.js`.

**2. The population it actually covers today.** 6 files, of which 5 function.
All six are `.db.js` harnesses or the preflight, all in `tests/`.

**3. Gaps, ranked by whether they can reach production.**

| Rank | Gap | Files | Why it ranks here |
|---|---|---|---|
| 1 | `psql "$DATABASE_URL"` in shell scripts | 2 | Reaches production and **no JavaScript boundary can ever intercept it** |
| 2 | Self-built pool in `tools/` | 16 | Reaches production; these are repair, cleanup, seeding and enrollment scripts that **write by design** — `retire_hollow_leases`, `repair_invalid_task_owners`, `remove_duplicate_walkins` |
| 3 | Self-built pool in `tests/` | 74 | Reaches production; commits fixtures and never cleans up — the exact population `DB_HARNESS_ISOLATION.md` was written about |
| 4 | Self-built pool in `seeds/` and `src/` standalone | 6 | Reaches production; writes demo and QA corpora |
| 5 | `test_adapter_seam.db.js` dead | 1 | Cannot reach production — it dies first. Ranked low for exposure, high for proof integrity |
| 6 | Local hardcoded fallback | 2 | Cannot reach production, but silently retargets |

**4. Class B files requiring special treatment.** Four.
`migrations/migrate.js` is the explicit exception — its boot path must retain
production access. `src/shared/seed_snapshot.js` is the hardest case, being
reachable from a live HTTP endpoint *and* self-executing.
`seeds/seed_demo_slots.js` and `tools/seed_solo_facts.js` are self-executing with
no requirer found in source; their dual nature is latent rather than active.

**5. The smallest structural boundary.** One module, outside `tests/`, exporting
the only supported way to obtain a connection string, with two named entry
points: an unguarded one reserved for `server.js` and the `migrations/migrate.js`
boot path, and a guarded one — today's `harnessConnectionString()` — for
everything else. Coverage becomes checkable rather than habitual: *no file
outside a named allowlist constructs `pg.Pool` directly.* That is a static,
greppable invariant, which is what the current arrangement lacks. The guard's
present home in `tests/` is itself an obstacle, since `tools/` and `src/` scripts
must reach across directories to adopt it. **Identified, not proposed** — the
design and its migration path are out of scope here.

**6. Class R components that must remain outside the guard.** `server.js:165`
only. Plus the boot execution context of `migrations/migrate.js`, which is a
context rather than a file.

**7. Standalone database-capable paths that cannot be forced through a shared
boundary.** Two, both shell:
`setup_clean_qa_record.sh` and `setup_fresh_record_and_prove.sh` invoke `psql`
directly against `$DATABASE_URL` and never enter a Node process. **No JavaScript
guard can constrain them by construction.** Any coverage here must come from a
different mechanism — a wrapper, an environment discipline, or removal.
`migrations/migrate.js` is a third, partial case: constrainable in its standalone
mode only if its authorized boot path is preserved, and the file cannot presently
distinguish the two.

---

## B. Fixture and script phone-number inventory

Reserved fictional block, per contract: **exchange `555` + line `0100`–`0199`,
any area code.** All NANP-shaped digit runs were normalized to `+1XXXXXXXXXX`
before evaluation.

### Inside the reserved block — compliant

`+12155550101` · `+12155550142` (6) · `+12155550188` · `+12155550189` ·
`+12675550148` (2) · `+12675550199` · `+15005550101` (2) · `+15005550102` (2) ·
`+15005550123`

Note: `+12155550101` is the `'Larry Lead'` number that
`DB_HARNESS_ISOLATION.md` flags as *"a plausible real number in a live area
code."* Under this contract's rule it is **inside** the reserved block and
compliant. The two documents disagree; this one applies the stated rule.

### Outside the reserved block — reportable

**Real, dialable numbers belonging to identifiable people:**

| Number | Location | Class | Exposure |
|---|---|---|---|
| `+17243098434` | `migrations/090_admin_users.sql:25,39`; `src/identity/phone_identity.js:8`; `src/comms/communications_boundary.js:688`; `src/leasing/leasingleads.js:201`; `tests/qa_lifecycle_arc.js:35`; `tests/night_harness.js:224`; `tests/demo_authority_ruling_proof.js:64` | R, S | **The expected occurrence — Kameron's real cell, intentionally present.** Its exposure is not the identity but the *placement*: `090_admin_users.sql:39` inserts it as a real `users` row — `role='property_manager'`, `auth_method='phone_otp'`, `is_active=true`, `status='active'`. That is a migration, so it runs on **every production boot** through the authorized path. This is a live operator account with a live phone, not a fixture. Whether that is intended is an owner question; it is reported here because a migration-created account is durable, reachable by any outbound path that selects active property managers, and cannot be removed by fixture cleanup. |
| `+18626683053` | `migrations/090_admin_users.sql:24,38` | R | Second real number in the same migration, same row shape, `tmysl@me.com` (Tom). Identical exposure. **This one is not covered by the contract's expected-occurrence note.** |
| `+12153591082` | `tools/seed_solo_facts.js:132` | S | Written into `agent_facts` as an office contact — *"(215) 359-1082. Office hours are Monday–Friday, 9:00 AM–4:30 PM ET."* Agent facts are **AI-quotable**, so this number can be spoken to a real prospect. A real-looking Philadelphia number in a prospect-facing fact is materially different from one in a fixture. |
| `+12154452021` | `tests/demo_book_route_proof.js:47`; `tests/prove_escalate_move.js:100`; `tests/prove_one_in_one_out.js:99`; `tests/prove_persona_v6.js:75`; `tests/tour_booking_proof.js:193`; `tests/http_negative_smoke.js:67`; +1 more | S | Inserted as `properties.sms_number` for `'Property Spine Demo Building'` across seven harnesses. Real-looking 215 number. If this is the live Demo Building line, these harnesses are writing a **production inbound-routing value** — and `properties.sms_number` has no unique index (ITEM 4), so a duplicate is not refused. |

**Fictional-but-outside-block** — 555-shaped, wrong line range, or 555 in the
area-code position. Reachability is the same question for all: they are written
as `persons.phone` / `properties.sms_number` by Class S harnesses that commit and
never clean up, so they persist as person rows an outbound path could select.

`+15005550001` (`tour_scheduled_for.test.js:107`) · `+15005550002`
(`tours_conveyor.test.js:132`) · `+15005550009` (`resident_sms_work_order_proof.js:526,535`) ·
`+15005550999` (`comms_boundary_phase_a_proof.js:60`, `PROOF_CELL`) ·
`+15005551111`, `+15005552222` (`comms_boundary_phase_a_proof.js:160,164,174,180`) ·
`+15005557001`, `+15005557002` (`consent_and_scope_proof.js:104,105`) ·
`+15005558001` (16 occurrences, `consent_and_scope_proof.js`) · `+15005558002`
(`:109`) · `+15001110001`–`+15001110004` (`comms_boundary_phase_a_proof.js:93–96`) ·
`+12155550001` (`test_scheduling_interactions.db.js:52,78,184,235`) ·
`+12675550001`–`+12675550003` (`shadow_import.test.js:223,234,248,250`) ·
`+15551234001`–`+15551234006` (`night_harness.js`, six persons) ·
`+15550000010`, `+15550000011` (`night_harness.js:80,81`, as `sms_number`) ·
`+15550001111`, `+15550002222`, `+15550002223` (`http_negative_smoke.js:67,94,102`) ·
`+15550076001`, `+15550076002` (`src/shared/no076_failclosed_check.js:40,41`) ·
`+15550000000` (`tools/prove_followup_ladder.js:132`) · `+19998887777`
(`comms_boundary_phase_a_proof.js:160`, invalid NANP area code, used as an
unknown-line probe)

**Documentation/UI strings, not stored values:** `+12155551212`
(`src/comms/tenantlink.js:352,1578`) — the `215-555-1212` placeholder in an error
message and an input `placeholder` attribute. Class R, never written to a record.
`+17243098888` (`src/leasing/leasingleads.js:231`) — illustrative digits inside a
code comment about phone normalization.

**Excluded as false positives** (digit runs that match the NANP shape but are not
phone numbers): `+11721249919` — the Acuity appointment id `1721249919` in
`test_adapter_seam.db.js:45,82,97`. `+14775332987` — a fragment of the git blob
SHA in `src/applications/applicationSubmission.js:3`.

### Outbound reachability

Whether any of these could be *dialled* cannot be settled from source alone.
`DB_HARNESS_ISOLATION.md` records that outbound SMS requires
`contact_preferences.consent_state='opted_in'`, and several harnesses
(`consent_and_scope_proof.js:145` sets `SMS_PROOF_CELL`) deliberately establish
consent to exercise the send path. **A fixture number that has been granted
consent is materially closer to reachable than one that has not.** Establishing
which rows currently hold consent requires the read-only database pass, not this
audit.

---

## C. Source-derived property classification

**Source-derived only.** This is not an inventory of live database properties; it
is the input for the later read-only analysis.

### 1. Real operating properties

| Property | ID | Source | Access |
|---|---|---|---|
| Solo (4233 Chestnut) | `9e2bb96e-08e2-41db-81c2-91055ceb50a3` | `src/onboarding/deal_registry.js:16` | 23 references |
| UNO (4125 Chestnut) | `260b6bac-4738-47c4-b86d-511b726adc48` | `deal_registry.js:17` | `src/surfaces/owner.js:159` |
| The Felix | `971c51ab-be96-4e5f-81df-0e59804c879b` | `src/surfaces/owner.js` NEVER_DELETE | read-only |
| Greenery, Temple Nest, Skyline, 1850 Berks | **`property_id: null`** | `deal_registry.js:18–21` | registry entries with no property row; by-bed model |

**Solo access is read-and-guard, consistent with the constraint.** All 23
references are reads, delete-guards or refusals. The two seed tools that name it
carry hard walls: `tools/seed_demo_inventory.js:71` and
`tools/seed_demo_agent_facts.js:43` both `throw new Error("target equals Solo —
refusing.")` if the target resolves to Solo, and read Solo counts only as a
post-run check. `src/leasing/demo_preflight.js:72` and `src/surfaces/owner.js:160`
use it as a delete-guard entry.

**One exception worth naming:** `tools/accept_brick_one.js:26` —
`const QA_PROP = process.env.PSPINE_QA_PROPERTY || "9e2bb96e-…"` — **defaults to
Solo with no wall.** It reads (`:105`, `:120`) and mints operator invites scoped
to that property (`:124`). It is the one Class S tool that targets Solo by
default rather than by refusal. Not a write to business state, but an
authority-minting path pointed at the real property unless an environment
variable overrides it.

### 2. Demo Building — legitimate isolated demo context

**`a50fbdd0-3642-431e-b532-0dcd6ab8a4fe`** — 69 references, the most-referenced
constant in the repository. **Not harness-created, and deliberately not
collapsed into class 3.** It carries durable irreplaceable history: per
`src/surfaces/owner.js:161–168`, *"the ONLY irreplaceable record in the system
(Marlow's 2026-07-05 tour, `31ca5801-…`) plus the whole demo corpus: 344 leases,
431 comm_events, 15 tours."*

It is referenced by both runtime and standalone code — Class R
(`src/shared/property_timezone.js:17` as the sole timezone allowlist entry,
`src/applications/leasepackets.js`, `src/identity/demo_owner_ruling_packet.js`,
`src/surfaces/owner.js`), by migrations `073` and `087`, and by ~55 Class S
harnesses and tools that read *and write* it.

`owner.js` notes that until the NEVER_DELETE list existed it was spared only
because its name did not match the test-deletion patterns — *"a naming
coincidence, not a guard."*

### 3. Harness-created synthetic properties

Created by name at runtime, no fixed ID:

| Name | Creator | Note |
|---|---|---|
| **`'Solo on Chestnut'`** | `tests/test_conversion_rail.db.js` | **Collides with the real Solo property's name.** `DB_HARNESS_ISOLATION.md` §1.4 establishes that name alone can never prove a row is synthetic. |
| `'Bridge Proof Property'`, `'Other Property (the wall)'` | `tests/test_identity_bridge.db.js` | distinguishable |
| `'R3 Prop <ms>'`, `'R3 Prop2 <ms>'` | `tests/test_release3.db.js` | timestamped, distinguishable |
| `'Property Spine Demo Building'` | 7 harnesses, with `sms_number` `+12154452021` | **Also a name collision** — same name as the real Demo Building |
| `'Demo'` / `'Solo Real'` | `tests/night_harness.js:80,81` | `sms_number` `+15550000010` / `+15550000011` |
| `'__CB_NO076__P'` | `src/shared/no076_failclosed_check.js:40` | marker-prefixed, distinguishable |

### 4. Unknown from source

- The four `property_id: null` registry entries — real deals with no property row in source.
- `e9a7659f-ee1a-4bde-9e0c-02c6632ff066` — a **user**, not a property; the QA
  operator, hardcoded in `migrations/087_internal_qa_leasing_coverage.sql:27` and
  named `FAKE_USER` in `tests/proof_proposed_terms.js:33` while being described
  in the same line as a real QA operator. The naming contradicts itself; which it
  is cannot be settled from source.
- `16b442ee-…` (Jordan Avery, demo lead person), `ede3fe95-…` (tenant person) —
  persons, listed because they are hardcoded durable identities in the same
  pattern as the property constants.

---

## What this report does not establish

- **Nothing was executed.** No harness was run, no database contacted, no
  migration applied. FINDING 1 rests on static analysis because `pg` is not
  installed in the audit container.
- **Which database any past proof run targeted.** No receipt has ever been
  preserved. `PROOF_OBLIGATION_ENGINE.md`'s claim of migration ceiling 122 on
  `ep-small-morning-aqxjnmz9-pooler` remains at proof level *Reported*.
- **Whether production currently holds the rows** `DB_HARNESS_ISOLATION.md` §1
  anticipates. That requires the read-only database pass.
- **Whether any fixture number is presently reachable by an outbound path.**
  Requires reading live `contact_preferences`.
- **The operational invocation set.** See the inventory ceiling above.

**Proof level of this document: Locally exercised** — source inspection and
static analysis only. No claim here is Proven.
