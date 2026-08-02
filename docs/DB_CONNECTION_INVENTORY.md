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

## Document map

Sections A–C are the original Phase 1 mandate. Appendices A090/B–E were added
later and are separated deliberately so this report does not become a general
source audit. **Appendix D carries the governing ruling; start there.**

| Section | Contents | Proof level |
|---|---|---|
| **Headline, FINDING 1, A–C** | Phase 1 guard coverage audit, fixture/phone inventory, property classification | Locally exercised |
| **Appendix (A090-1…4)** | Source findings from tracing migration 090 — missing role transition, false-green enum handler, blanket portfolio grants, non-deterministic property selection | Locally exercised |
| **Appendix B** | Post-ruling additions — repo-wide exception-handler scan, whether the number split retires the defect, alternate login path, candidate-set limits | Locally exercised |
| **Appendix C** | Amendments — the defect split, S2 framing, activation gate, **escalation trigger answered (C4)**, conformance set, evidence set | Locally exercised |
| **Appendix D** | **Revised consultant ruling. 4A/4B canonical labels, P1 reclassification, sequencing, S2 acceptance conditions.** Governing. | Reported |
| **Appendix E** | S2 surface audit — is 4B the only gap? (No pattern; one write.) | Locally exercised |

**Terminology:** A090-4 was split by the ruling into **4A** (credential-delivery
routing, retires with the operations-line split) and **4B** (staff-session scope,
P1, not retired by it). Appendices before D use the older label; D1 maps them.

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

**Row 5 is recorded in the appendix**, not inline: `migrations/090_admin_users.sql`
suppresses an enum alter with `exception when others then null`, and the ledger
then records the version as applied. See *Appendix — A090-2*, which also states
the general consequence for `db_preflight.js`: a ledger maximum is not evidence
of applied schema.

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
| `+17243098434` | `migrations/090_admin_users.sql:25,39`; `src/identity/phone_identity.js:8`; `src/comms/communications_boundary.js:688`; `src/leasing/leasingleads.js:201`; `tests/qa_lifecycle_arc.js:35`; `tests/night_harness.js:224`; `tests/demo_authority_ruling_proof.js:64` | R, S | **The expected occurrence — Kameron's real cell, intentionally present.** Its exposure is not the identity but the *placement*: `090_admin_users.sql:39` inserts it as a real `users` row — `role='property_manager'`, `auth_provider='phone_otp'`, `is_active=true`, `status='active'`. That is a migration, so it was written through the authorized path. **Correction (see Appendix — A090-3):** it does *not* run on every production boot — `migrate.js:178–181` skips applied versions, so 090 executes **once per database** and the row is durable thereafter. This is a live operator account with a live phone, not a fixture. Whether that is intended is an owner question; it is reported here because a migration-created account is durable, reachable by any outbound path that selects active property managers, and cannot be removed by fixture cleanup. |
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

**A second unguarded Solo path is recorded in the appendix.**
`migrations/090_admin_users.sql` writes portfolio-scope assignment rows with
`can_manage_roles=true` to **every property that existed when it ran**, Solo
included, with no exclusion list — and unlike `accept_brick_one.js`, no
environment variable overrides it. It executes once per database, not per boot.
See *Appendix — A090-3*.

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

---

# Appendix — Source findings discovered while tracing migration 090

**Why this appendix is separated.** These four findings surfaced while tracing
`migrations/090_admin_users.sql` to answer a question about admin provisioning.
They are outside the Phase 1 guard-coverage mandate. They are kept here, apart
from Sections A–C, so this report does not quietly widen into a general source
audit. Two of them extend an existing section; where they do, that section
carries a pointer back here rather than absorbing the row inline.

**Nothing in this appendix was executed.** No database was contacted, no
migration applied, no harness run. Proof level is stated per finding and is
never higher than *Locally exercised*.

| # | Finding | Extends | Proof level |
|---|---|---|---|
| A090-1 | Promised `property_manager → admin` update does not exist; `role_name='admin'` has no consumer | — | Locally exercised (source-verified) |
| A090-2 | `exception when others then null` + ledger skip = durable false green | Section A false-green table, as row 5 | Locally exercised (source-verified) |
| A090-3 | One-time durable portfolio grants across all then-existing properties, Solo included | Section C | Locally exercised (source-verified) |
| A090-4 | Non-deterministic active-property selection on staff re-login | — | Locally exercised (source-verified) |

---

## A090-1 — The promised role transition does not exist, and the new enum value has no consumer

The file header states the intended design (`migrations/090_admin_users.sql:17–21`):

> *ACTUAL SOLUTION: avoid the new enum value in the INSERT entirely. We insert
> with `role='property_manager'` (existing value), then UPDATE to `'admin'`
> after the enum alter is committed.*

**No such UPDATE exists.** The file is 99 lines and contains exactly three
operations: the enum alter in a DO block (`:29–31`), the `users` INSERT
(`:36–45`), and two `property_team_assignments` INSERTs (`:50–73`, `:76–99`).
There is no `update users set role`.

Two reinforcing details:

- The conflict path at `:40–45` sets `phone`, `auth_provider`, `is_active`,
  `status` and `updated_at`. **`role` is not in the set list**, so a re-run
  would also preserve the existing role rather than correct it.
- No other migration assigns the value. The only other `'admin'` string under
  `migrations/` is `006_unit_occupancy_state.sql:55`, an unrelated
  `operating_use` check constraint (`'standard','model','employee','admin','unknown'`)
  — a different column with a different meaning.

**No repository consumer of `role_name='admin'` was found.** Every apparent hit
belongs to a different vocabulary:

| Site | What it actually is |
|---|---|
| `src/shared/snapshot_loader.js:56` | `IMPORT_ROLES`, a JS `Set` used for spreadsheet-import matching. Contains `"admin"` and `"manager"` — neither is a `role_name` value at all. |
| `src/identity/super_admin.js` | Reads `users.platform_role`, a **different column** with its own vocabulary (`super_admin`, `org_admin`, `member`). |
| `src/identity/staffbridge.js:10,21` | Comments only; the bridge-admin roles it names are `owner \| asset_manager \| …`. |

So on current source the enum carries a member that no row is written with and
no code reads.

**Scope limit — read this before acting on it.** This is a *current-source*
finding. It is not proof of the live enum's exact contents, and not proof of
what the two admin rows presently hold in production. A prior manual correction,
a hand-run statement, or a later migration applied outside this tree would not
appear here. Note also that `THREAD_HANDOFF.md`'s trap list enumerates
`role_name` as `owner, asset_manager, property_manager, leasing_agent,
maintenance, accountant, ai, system` — omitting both `admin` (090) *and*
`leasing_manager` (047). Whether that reflects the live enum or an incomplete
note cannot be settled from source. Establishing the live values requires the
read-only database pass.

---

## A090-2 — Swallowed enum failure recorded as applied (extends the Section A false-green table)

**This is row 5 of the false-green inventory in Section A.** It is recorded here
rather than inline so the appendix boundary holds.

| # | Source | Mechanism | Live? |
|---|---|---|---|
| 5 | **`migrations/090_admin_users.sql:29–31`** | `alter type role_name add value if not exists 'admin'` is wrapped in `do $$ … exception when others then null; end $$`. `ADD VALUE IF NOT EXISTS` **already** handles the intended duplicate case, so the handler adds nothing but suppression — and `when others` swallows every unrelated class: insufficient privilege, lock timeout, and the in-transaction restriction the header itself spends `:7–15` worrying about. On failure the DO block still returns success, the file continues, and `migrations/migrate.js` commits the transaction (`:192`) and records version 090. | **Yes.** Compare `001_baseline.sql:52`, which catches the *named* `duplicate_object`. `when others` is the unbounded form of the same idiom. |

**Why the failure becomes durable rather than transient.** `migrate.js:178–181`
skips any version already present in the ledger (`applied.has(version)` →
`continue`). Once 090 is recorded, it is never retried. A swallowed enum failure
is therefore **permanently misreported as applied**, and every subsequent boot
skips it — there is no self-healing path short of editing the ledger.

Today's blast radius is small only because nothing consumes the value
(A090-1). That is a coincidence of the missing UPDATE, not a property of the
design.

### General consequence — a ledger max is not evidence of applied schema

Three mechanisms already catalogued in this report compose:

1. `exception when others then null` — a statement can fail without failing its file.
2. `applied.has(version)` skip (`migrations/migrate.js:178–181`) — a recorded version is never re-attempted.
3. Root `migrate.js` green exit (false-green row 1) — a run can exit 0 having applied nothing at all.

Together they mean **the ledger can record a version as applied when no work was
performed.** `max(version)` from `schema_migrations` therefore proves only that
a row was written, not that the schema it names exists.

This is the specific correspondence `db_preflight.js` must establish when a
connection string arrives: not the ledger maximum alone, but **ledger entries
against observed schema objects** — for 090, that means checking `pg_enum` for
the `admin` member and the two `users` rows' actual `role` values, not
inferring either from the presence of version 090.

**Proof level: Locally exercised (source-verified).** The mechanism is read from
source. It has not been reproduced against a real isolated database, and must
not be described as *Proven* until it is, with a preserved run receipt.

---

## A090-3 — One-time durable portfolio grants across all then-existing properties (extends Section C)

**Extends Section C.** Recorded here rather than inline, per the appendix boundary.

The two assignment statements partition on `p.sms_number is null` (`:65`) and
`p.sms_number is not null` (`:91`). **Together these exhaust the `properties`
table** — every row satisfies exactly one. There is no exclusion list, no
`NEVER_DELETE` check, and no Solo guard.

Each matched property receives one row per admin with `scope_type='portfolio'`,
all four modules in **both** `allowed_modules` and `primary_for_modules`,
`can_manage_roles=true`, `active=true` — the strongest shape
`property_team_assignments` can express.

**Real Solo `9e2bb96e-08e2-41db-81c2-91055ceb50a3` is included with no
exclusion.** Section C records that Solo access is otherwise read-and-guard: the
two seed tools that name it both `throw` (`tools/seed_demo_inventory.js:71`,
`tools/seed_demo_agent_facts.js:43`). This migration checks nothing. It is a
second unguarded Solo path alongside `tools/accept_brick_one.js:26` already
noted in Section C.1 — and unlike that one, it is not overridable by an
environment variable.

**Correction to preserve — this is not a per-boot write.** `migrate.js:178–181`
skips applied versions, so **090 executes once per database**, at the boot where
it is first applied. It creates durable rows and is never re-run. The
`ON CONFLICT DO UPDATE` branches (`:66–73`, `:92–99`) would re-assert the grants,
but the ledger prevents them from ever executing again.

Three consequences follow from that, and they change how this should be
remediated:

- It is a **one-time durable grant**, not a recurring writer. Removing or
  editing the migration file changes nothing about rows already written.
- **Properties created after 090 was applied do not inherit the grants.** New
  properties get no admin assignment from this path.
- It is therefore a **point-in-time blanket grant, not an ongoing policy.** The
  portfolio-wide authority it describes is true of the property set as it stood
  at one moment and drifts out of date from that moment onward.

Whether the rows are presently in production, and which properties existed when
090 ran, cannot be settled from source.

---

## A090-4 — Non-deterministic active-property selection on staff re-login

Recorded as its own named finding rather than filed under connection plumbing:
the defect is in the login path, and it is not a connection-configuration issue.

### The chain

```text
both assignment batches use transaction_timestamp()
→ can_manage_roles ties
→ updated_at ties
→ query has no deterministic third key
→ arbitrary property row may win
→ invite/session is scoped using that property_id
```

**Step 1 — the timestamps are identical.** `property_team_assignments.updated_at`
defaults to `now()` (`migrations/035_phone_first_team.sql:81`), and both conflict
branches set `updated_at = now()` explicitly (`:73`, `:99`). `now()` is
`transaction_timestamp()` — transaction start, not statement time — and
`migrate.js` wraps **the entire file** in one transaction (`:186` begin → `:192`
commit). Both batches therefore receive the **same** `updated_at`.

This makes the comments at `:48–49` and `:75` — *"Demo Building inserted last so
its sms_number wins the login OTP routing"*, *"SMS-capable properties last (wins
updated_at → picked for OTP login)"* — **inert**. The intended ordering is not
represented durably in the data. Statement order within a transaction does not
produce distinguishable `now()` values.

This is the trap `THREAD_HANDOFF.md` already documents, appearing in a migration
rather than a test harness: *"`now()` is TRANSACTION time. Any harness that wraps
a run in one transaction gives every row an identical `occurred_at`, so
`order by occurred_at desc limit 1` returns an arbitrary row."*

**Steps 2–4 — no deterministic tiebreak exists.** `src/identity/teamaccess.js:207–211`:

```sql
select property_id from property_team_assignments
 where user_id=$1 and active=true
 order by can_manage_roles desc, updated_at desc
 limit 1
```

Two sort keys, and for these two accounts **both tie on every candidate row** —
090 wrote `can_manage_roles=true` everywhere, and `updated_at` is identical per
step 1. There is no third key: no `created_at`, no `property_id`, no
deterministic fallback. Postgres returns whichever row the plan emits first,
which can change across plan changes or after vacuum. The surrounding comment
concedes the design is provisional, but its *"preferring one where they can
manage roles"* clause does no work here, because every candidate ties on it.

**Step 5 — the arbitrary pick scopes the session.** `a.property_id` is used for
the prior-invite lookup (`:220–224`), for superseding prior invites (`:235–238`),
and as the `property_id` of the newly minted login invite (`:240–246`). The OTP
body and the outbound send both read from that same invite row (`:272–283`).

### Severity

**No privilege escalation is evidenced.** Both users already hold portfolio-scope
authority on every property 090 touched, so an arbitrary pick does not grant
access they lack.

**The risk is wrong operating context.** The login path can select an arbitrary
*authorized* property as the active session context. If that property scopes
subsequent reads and writes, an admin can be operating against a different
property than they believe they are — a wrong-context risk, not an authority
breach.

**Real Solo `9e2bb96e-…` is in the candidate set** (per A090-3, Solo receives a
grant with no exclusion). An admin session can therefore land on Solo by plan
choice alone.

### Open question answered — does `teamaccess` filter to properties with an `sms_number`?

**No. It does not.**

The query at `src/identity/teamaccess.js:207–211` selects from
`property_team_assignments` with no join to `properties` and no predicate on
`sms_number`. The only filters are `user_id` and `active=true`. **A property
with no line is fully eligible to win the pick.**

The downstream behaviour when that happens is silent, which is what makes it
hard to diagnose:

1. The OTP is sent via `commBoundary.sendPropertySms` scoped to the picked
   `property_id` (`teamaccess.js:277–281`).
2. `src/comms/communications_boundary.js:396` returns
   `{ allowed: false, reason: "no_property_line" }` when the property has no
   `from` line; `:546–548` stamps the refusal and returns
   `{ sent: false, reason: "no_property_line" }`.
3. `teamaccess.js:285` lists `no_property_line` among the **tolerated** reasons,
   so `delivery` stays `"link_only"` rather than becoming `"sms_failed"`.
4. The endpoint returns **HTTP 200** with `receipt: "SMS transport not active."`

For a staff re-login the client holds no link, only the echoed token
(`:301`, `isRelogin` → `out.token`). In non-production the code is surfaced as
`dev_code` (`:304`), so the flow still completes and the defect is invisible.
**In production `dev_code` is withheld**, so the caller receives a 200 and a
token but no code, and the login cannot complete.

Because the property pick is arbitrary (steps 2–4 above), this presents as an
**intermittent login failure with no obvious cause** — the same user, the same
number, succeeding or failing depending on which assignment row the planner
returned. `src/leasing/demo_preflight.js:100` already names the underlying
refusal: *"Property has no `sms_number`. The outbound gate refuses with
`no_property_line` and never falls back to the Messaging Service default."*

**What source does not establish:** whether Real Solo currently has an
`sms_number`. Migration 090's two branches split on exactly that column, but the
value is not fixed in source. So *whether* landing on Solo specifically produces
`no_property_line` is not determinable here. The structural finding stands
independently: the pick is unfiltered, an unlined property can win, and the
resulting failure is silent.

**Proof level: Locally exercised (source-verified).** The chain is read from
source across four files. No login was exercised, no database contacted.

---

**Proof level of this appendix: Locally exercised.** Source inspection and static
analysis only. No claim in this appendix is Proven. In particular, nothing here
establishes the live enum contents, the live `role` values of the two admin
rows, which properties received grants, or any property's current `sms_number`.

---

# Appendix B — Post-ruling read-only additions (2026-08-02)

Consultant ruling received and ordering accepted: **A090-4 P1**, **A090-2
high-severity integrity**, **A090-3 governance, inventory first**, **A090-1
low**. The hold stands — no connection string, no Phase 2, no fixes. The four
additions below are source-only and change no behavior.

---

## B1 — Blanket exception-handler scan across all 122 migrations

090 was not treated as isolated. Every file in `migrations/` was scanned for
handlers that suppress rather than catch a named condition.

**Result: nine handlers in total across 122 files. Eight name a specific
condition. `090_admin_users.sql:31` is the only `when others` in the
repository.**

| File:line | Guarded statement | Catches | Shape | Would still record as applied on failure? |
|---|---|---|---|---|
| `001_baseline.sql:43` | `create type prov as enum (…)` | `duplicate_object` | **Acceptable — the reference shape.** The named condition is exactly what a repeat `CREATE TYPE` raises. | Yes, and correctly — the only suppressed case is the benign re-run. |
| `001_baseline.sql:52` | `create type role_name as enum (…)` | `duplicate_object` | **Acceptable.** Same shape. | Yes, correctly. |
| `093_organizations.sql:39` | `alter table users add column platform_role …` | `duplicate_column` | **Acceptable.** Condition matches the statement exactly. (`add column if not exists` would be cleaner but is equivalent.) | Yes, correctly. |
| `093_organizations.sql:44` | `alter table properties add column organization_id …` | `duplicate_column` | **Acceptable.** | Yes, correctly. |
| `093_organizations.sql:50` | `alter table users add column organization_id …` | `duplicate_column` | **Acceptable.** | Yes, correctly. |
| `095_staff_roles.sql:85` | `alter table property_team_assignments add column role_key …` | `duplicate_column` | **Acceptable.** | Yes, correctly. |
| `095_staff_roles.sql:18` | `alter table users drop constraint if exists users_platform_role_check` | `undefined_object` | **Redundant but bounded.** `drop constraint if exists` already handles absence, so the handler catches nothing reachable. Narrow condition, so no blast radius — but it is the same "handler adds nothing" reasoning that made 090 dangerous, applied to a safe condition. | Yes; nothing suppressible occurs. |
| `077_agent_auto_dispatch.sql:29` | `alter table agent_drafts alter column dispatched_by_user_id drop not null` | `undefined_column` | **Named, but suppresses a structural absence — worth a second look.** `DROP NOT NULL` on an existing column is already idempotent, so the only case this catches is *the column not existing at all*. That is not a benign re-run; it means the schema is not what the migration assumes. No postcondition is asserted afterward. | **Yes — and this one is not obviously correct.** If `dispatched_by_user_id` is absent, 077 records as applied having silently skipped its own change. |
| `090_admin_users.sql:31` | `alter type role_name add value if not exists 'admin'` | **`others`** | **The defect.** `IF NOT EXISTS` already supplies idempotency, so the handler adds only suppression — of permissions failures, lock timeouts, and the in-transaction restriction the file's own header discusses at `:7–15`. | **Yes, and incorrectly.** See A090-2. |

### The acceptable shape, stated

`001_baseline.sql:52` is the reference: **a handler is acceptable when the named
condition is the exact error the guarded statement raises on a benign re-run, and
nothing else.** Under that rule, seven of the nine pass cleanly, `095:18` passes
as redundant, and two do not sit comfortably — `090:31` (unbounded) and `077:29`
(named, but the named condition indicates schema drift rather than a re-run).

### The opposite discipline already exists in this repository

Seven migrations abort loudly rather than suppress, using `raise exception` in a
preflight block: `053:31,34`, `054:52,55`, `070:192`, `080:50`, `081:68`,
`084:132`, `087:38`. Several assert ledger head position before proceeding
(`053`, `054`), one blocks on duplicate active assignment pairs (`070:192`), one
aborts on conflicting active invitations (`084:132`). **The house style for
"this must be true before I run" is therefore already established and is
correct.** 090 is a departure from it, not an absence of it.

---

## B2 — Does the replacement flow inherit the defect?

**Read: `docs/COMMUNICATION_LINE_ARCHITECTURE.md` (318 lines). It is the only
document in `docs/` that mentions the operations line** — no other related design
doc exists.

### What the spec does address

It addresses A090-4 explicitly, and by file and line:

- **FLAG 4** (`:157–169`) names the exact behavior: *"`teamaccess.js:273-282`
  sends staff login OTPs out over the property's `sms_number` … 
  `090_admin_users.sql:47-48` deliberately orders assignment inserts so an
  SMS-capable property 'wins the login OTP routing.'"* It concludes: *"When the
  operations line exists, staff OTP is the first traffic that should move to it —
  and `090`'s ordering hack becomes unnecessary rather than load-bearing."*
- **Ruling 5** (`:244–254`) classifies staff OTP over the property line a
  **temporary transport adapter** with a stated replacement condition: *"once an
  active operations line exists for the management organization, staff OTP and
  internal operational messaging no longer select a property line through
  assignment ordering (`090_admin_users.sql:47-48`)."*

So the **delivery** half of A090-4 is squarely covered and scheduled.

### What the spec does not address

**The spec is silent on active-property selection.** Searching the full document
for `session`, `scope`, `active property`, `property_team_assignments` and
`which property` returns two hits, neither on this subject: `:198` uses
"property-scope" about *inbound message binding*, and `:207` uses "scope" to mean
the scope of a build slice.

The "Future canonical line model" runtime chain (`:284–307`) is an **inbound**
resolution path — `To number → communication-line record → property or
organization context → line posture and authority ceiling → sender identity →
permitted canonical action`. It describes how an arriving message finds its
context. It says nothing about how a staff **session** acquires a property scope
at login.

### Consequence — A090-4 splits, and only one half retires

| Half | Mechanism | Retired by the split? |
|---|---|---|
| **Delivery** — an unlined property wins the pick, the gate refuses `no_property_line`, the endpoint returns 200 and no code arrives | OTP routed over `properties.sms_number` | **Yes.** Ruling 5's replacement condition removes property-line selection from staff OTP entirely. |
| **Session scoping** — an arbitrary property becomes the session's operating context | `teamaccess.js:207–211` `ORDER BY can_manage_roles DESC, updated_at DESC LIMIT 1`, whose result becomes the invite's `property_id` and hence the session scope | **No. Untouched.** Nothing in the spec replaces or removes this query, and a session still needs a property scope after OTP delivery moves off the property line. |

**Stated plainly: the number split retires the lockout symptom, not the
wrong-context risk.** The spec has no successor mechanism for deciding which
property scopes a staff session, and does not acknowledge that the question
exists. That gap should be closed in the operations-line slice's design, or
A090-4's second half will survive the change that was expected to retire it.

---

## B3 — Alternate login path, independent of SMS OTP

**Confirmed from source.** `tools/issue_operator_invite.js` mints a single-use
login proof redeemable at the login screen without any SMS involvement.

- **What it writes:** one row in `operator_session_invites` (`:84–89`) —
  `crypto.randomBytes(32)` base64url token (`:81`), of which **only the
  sha256 digest is stored** (`:82`), plus `issuance_reason='bootstrap_invite'`
  and `issuance_source='cli'`.
- **How it is redeemed:** the recipient submits the token at the Invite Access
  screen, `POST /operator/session` (`:100–101`), implemented at
  `src/identity/operator_session_bootstrap.js:81`, which exchanges the proof for
  a canonical staff session and retires the invite (`:141`). **This path never
  touches `team_invites`, `sms_number`, or the outbound gate.**

**What it requires:**

| Requirement | Source |
|---|---|
| `DATABASE_URL` in the environment | `:40` — dies without it |
| `--user <uuid>` and `--property <uuid>`, both mandatory | `:41` |
| Shell access to run the CLI | `#!/usr/bin/env node`, `:22–23` |
| **An interactive TTY** — refuses non-interactive stdout so the token cannot be captured by logs or pipelines; override only via `PSPINE_ALLOW_NON_TTY=1` | `:45–50` |
| The target user already `is_active` **and** `status='active'` | `:63–67` |
| An **already-active assignment** for that exact property — *"This tool never creates authority."* | `:69–74` |
| TTL: `--minutes`, **default 60, hard-capped at 24h** (`Math.min(…, 24*60)`) | `:35` |

**Bearing on A090-4 severity.** This materially lowers the lockout ceiling: an
admin who cannot receive an OTP is recoverable without a database edit, provided
someone has shell access and an interactive terminal. Two qualifications worth
carrying into the ruling:

1. **It requires `--property` explicitly**, so it bypasses the arbitrary
   selection entirely and lands the session on a chosen property. It is therefore
   a workaround for *both* halves of A090-4, not just the lockout.
2. **It is a bootstrap tool, not a user-facing fallback.** It needs a second
   person with shell access, an interactive terminal, and out-of-band delivery
   (`:92–93`). It does not help a locked-out admin acting alone, and it is not
   reachable from the login screen without someone running it first.

---

## B4 — Candidate-set composition, as far as source allows

The arbitrary pick spans every active assignment row regardless of `sms_number`
(A090-4). How often that lands on an unlined property depends on how many
properties carry a line.

**Source cannot establish either count, and the reason is specific:**

- `migrations/030_sms_transport.sql:34` adds `sms_number` as a plain nullable
  `text` column — **no default, no backfill, no `not null`.**
- **No migration ever writes it.** Grepping all 122 files for `sms_number`
  alongside `set|insert|update|values|default` returns exactly one hit, and it is
  the comment at `090_admin_users.sql:48`. 090 *reads* the column to partition on
  (`:65`, `:91`); it never assigns it.
- The only durable runtime writer is the operator config route
  `src/comms/tenantlink.js:394` (`update properties set sms_number = $1 where id = $2`).
  **Values set through that route leave no trace in source at all.**
- The remaining writers create synthetic rows, not real ones:
  `src/shared/no076_failclosed_check.js:40` (`'__CB_NO076__P'`, `+15550076001`)
  and the harness-created properties already catalogued in Section C.3.

So: **zero properties are known from source to carry an `sms_number`**, and that
number is an artifact of where the value is written, not evidence that none do.
Section C names four real property rows (Solo, UNO, The Felix, Demo Building);
the true denominator is also unestablished.

**Two source signals point in opposite directions and neither settles it.**
`migrations/094_property_channel_capabilities.sql:36–39` states Demo Building is
*"currently sending successfully (167 accepted comm_events)"*, so **at least one**
property has a working line. Meanwhile `COMMUNICATION_LINE_ARCHITECTURE.md`
Ruling 1 (`:201`) treats **duplicate** property numbers as a live safety defect,
which implies more than one — but a stated concern is not a count.

### The implication, stated explicitly

**If few properties carry a line, an arbitrary pick lands on a no-line property
most of the time.** That would make A090-4's delivery half **an already-live
intermittent login failure**, not a latent risk — the two admins would be failing
to receive codes at roughly the rate of unlined properties in the candidate set,
with the failure presenting as a silent HTTP 200.

Conversely, if nearly all properties carry a line, the delivery half is latent
and the wrong-context half (B2) is the whole of the finding.

**This is the single highest-value thing for the first live query to settle.**
It is the difference between a scheduled cleanup and an active incident, and it
is one count:

```sql
select count(*) as total,
       count(sms_number) as with_line,
       count(*) - count(sms_number) as without_line
  from properties;
```

Paired with the candidate set actually in play:

```sql
select p.id, p.name, (p.sms_number is not null) as has_line,
       a.can_manage_roles, a.updated_at
  from property_team_assignments a
  join properties p on p.id = a.property_id
  join users u on u.id = a.user_id
 where u.email in ('tmysl@me.com', 'kz8434@gmail.com')
   and a.active = true
 order by p.name;
```

---

## B5 — Recorded for when a connection string arrives (destination only)

**`db_preflight.js` must establish ledger-to-schema correspondence, not the
ledger maximum.** A090-2 shows the maximum can be recorded without the
corresponding work having occurred; `COMMUNICATION_LINE_ARCHITECTURE.md:271–281`
independently warns against assuming a migration number rather than querying it.
A ceiling number is trustworthy only when each entry is checked against an
observed schema object.

**Minimum postconditions to check for 090:**

1. **Does the `admin` enum member exist?** Query `pg_enum` joined to `pg_type`
   for `role_name`. Presence of ledger row 090 is not evidence of it (A090-2).
2. **What roles do the two users actually hold?** Read `role` for
   `tmysl@me.com` and `kz8434@gmail.com`. Source predicts `property_manager`
   (A090-1); confirm rather than assume, since a manual correction would not
   appear in this repository.
3. **Which assignment rows exist, and in what state?** For those two users, the
   set of `property_team_assignments` rows with `scope_type`, `allowed_modules`,
   `primary_for_modules`, `can_manage_roles`, `active` — and whether Real Solo
   `9e2bb96e-…` is among them (A090-3). This doubles as the B4 candidate-set
   count.

**Not now — destination only, do not build in this phase:** per-migration
postconditions, a verified ledger state, and migration file checksums. Recorded
here so the shape is not re-derived later; none of it is authorized work today.

---

**Proof level of Appendix B: Locally exercised.** Source and documentation
inspection only. No database was contacted, no tool run, no login exercised. B4
in particular establishes what source *cannot* determine; it is not a count.

---

# Appendix C — Post-ruling amendments (2026-08-02)

Consultant ruling accepted. Amendments below are report-only; nothing is built,
no connection string was supplied or requested.

---

## C1 — A090-4 is two defects sharing one arbitrary query

**The line split can no longer be credited as resolving A090-4.** Per B2 the
finding separates, and the halves have different retirement conditions, different
severities, and different owners.

| | **Delivery defect** | **Session-scoping defect** |
|---|---|---|
| **What goes wrong** | An unlined property wins the pick; the gate refuses `no_property_line`; the endpoint returns HTTP 200 and no code arrives | An arbitrary property becomes the session's operating context |
| **Mechanism** | OTP routed over `properties.sms_number` for the picked property | `teamaccess.js:207–211` result becomes the invite's `property_id`, and hence the session scope |
| **Retirement condition** | **Retired by the number split.** `COMMUNICATION_LINE_ARCHITECTURE.md` Ruling 5 — once an active operations line exists, staff OTP no longer selects a property line through assignment ordering | **Not retired by anything currently scheduled.** Requires a server-authoritative property scope at login (C2). No successor mechanism exists in any spec |
| **Failure mode** | **Stops the user.** Loud to the person affected, silent to the system | **Lets the user proceed.** They confidently do the wrong work and discover it later |
| **Priority** | Follows the line split | **P1 independently** |

**The asymmetry drives the sequencing.** A lockout halts work and is
self-announcing to the operator. Wrong context does not halt anything — it
permits confident work against the wrong property, discovered downstream if at
all. Under §5 (*honest blank beats confident wrong*) the second is the worse
failure, and it is the one no scheduled remedy addresses.

---

## C2 — The successor is S2, and this is not new architecture

`PHILOSOPHY.md:598–620` defines the four live-first seams and states the order is
mandatory:

```text
S1 — identity                     Who is the operator?
S2 — authoritative property scope What property may they operate?
```

**The session-scoping defect is a missing S2 on the login path.** The successor
therefore has a home in existing doctrine rather than needing invention — this is
building a seam the architecture already names, not designing a new mechanism.

**It also explains how it slipped.** The login path shipped S1 — identity is
established properly, by phone, by OTP, against a real user row. S2 was assumed
to follow from it, and instead an ordering heuristic was substituted for an
authority decision. The seam was in the doctrine and was skipped when the invite
path shipped.

One corroborating detail: `src/identity/staff_identity_resolver.js:290–291`
already aggregates a user's full active property set
(`array_agg(distinct t.property_id) … as team_properties_035`) rather than
choosing one. **The set-shaped read S2 would need already exists.** What is
missing is the authority decision over that set, not the data to make it.

---

## C3 — Activation gate, registered as a gate

Recorded as a constraint on activation, not as a style note:

> **Broader real operator use is not authorized while session scope remains
> planner-selected.**

This bears directly on Solo activation and on any expansion of real operator
accounts beyond the current two. It is not a code comment and should not be
carried as one.

---

## C4 — Escalation trigger answered: the ambiguous path is shared by all staff

The ruling names *"ordinary users beyond the two founders can enter through the
same ambiguous path"* as the escalation trigger. **Source answers it now, and the
answer is yes.**

### Which code path resolves active property at login

`src/identity/teamaccess.js:207–211`, inside the `else` branch of
`POST /auth/sms/start` — the no-token re-login branch.

### Is it shared, or admin-specific? — Shared

The query filters on `user_id=$1 and active=true` and nothing else. **There is no
admin check, no email filter, no role or scope predicate.** It is the re-login
path for every staff member who signs in by phone without an invite token.
**This is a login-path defect, not a two-person defect.**

It is also the *only* such site. Across `src/`, it is the sole read that selects a
property from assignments with an ordering and `limit 1` and no `property_id`
predicate. Every other assignment read either supplies the property explicitly —
`src/leasing/leasingconversion.js:1012–1016` and
`src/identity/staff_identity_resolver.js:201–202` are membership checks — or
returns the whole set without choosing (`staff_identity_resolver.js:290–291`).

The deterministic login paths, for contrast: **invite-accept** scopes from
`inv.property_id`, and **`POST /operator/session`** (`operator_session_bootstrap.js:81`)
scopes from the invite row's explicit property. Only the phone re-login path
picks.

### Who can hold multiple active assignments

**Multi-property assignment is designed, not accidental.** The uniqueness
guarantee is `uq_pta_one_active on property_team_assignments (property_id, user_id)
where active = true` (`migrations/070_operator_session_bootstrap.sql:194`) — one
active row per user **per property**, which explicitly permits many properties per
user.

Reachable through three production writers, none admin-only:

| Writer | How multiplicity arises |
|---|---|
| `teamaccess.js:419` | Invite-accept provisioning, one assignment per accepted invite. A staff member who accepts invites for two properties holds two active assignments. |
| `super_admin.js:347` | Direct upsert, `scope_type='property'`. |
| `org_admin.js:192` | Direct upsert, `scope_type='property'`. |

`090_admin_users.sql` is the only **migration** that inserts assignments, and it
grants both admins on every property (A090-3).

**How many users actually hold two or more: source cannot say.** Runtime-created
assignments leave no trace in the repository — the same limitation as `sms_number`
in B4. What source establishes is that the capability is universal, designed, and
reachable by ordinary staff through the normal invite flow.

### Does a deterministic key exist for them? — No

- **For the two admins**, both sort keys tie exactly and no third key exists
  (A090-4). The result is arbitrary.
- **For ordinary staff the keys usually do not tie.** `can_manage_roles` may
  differ, and `updated_at` on runtime-created rows is genuine per-statement
  wall-clock across separate transactions. A row usually wins outright.

**But winning outright is not the same as being chosen.** The effective rule is
*"prefer a property where you can manage roles; otherwise the most recently
updated assignment wins."* Neither clause expresses which property the person
should be operating. It is incidental, not deliberate — the same defect as the
admins' case, merely less visible because it is stable between edits rather than
arbitrary within a query.

**And it is mutable by unrelated administration.** `teamaccess.js:614` sets
`updated_at = now()` on every assignment PATCH. So a manager editing someone's
modules or role title **on a different property** silently changes which property
that person lands on at their next login. The landing context is a side effect of
the most recent edit to their access, which no one performing that edit would
expect.

**Conclusion for the escalation trigger: met.** The ambiguous path is the shared
staff login path; ordinary multi-property staff are subject to it; and no
deterministic key governs their outcome either.

---

## C5 — `077_agent_auto_dispatch.sql` joins the conformance-audit set

Added alongside `090` per the ruling. Same trust defect, second file:
`077:29` catches `undefined_column` around a `DROP NOT NULL` that is already
idempotent on an existing column, so the only reachable case is the column being
absent — and nothing asserts a postcondition afterward. **If that handler ever
fired, the ledger recorded 077 as applied while its change did not happen.**

The conformance set is therefore **two migrations, not one**:

| Migration | Postcondition that must hold if the ledger says applied |
|---|---|
| `090` | `admin` present in `role_name` (`pg_enum`); the two users' actual `role`; the assignment rows, with scope, modules, `can_manage_roles`, `active` |
| `077` | `agent_drafts.dispatched_by_user_id` exists **and** is nullable |

---

## C6 — First read-only evidence set (scoped, NOT authorized)

Recorded so the shape is settled before a connection exists. **No part of this is
authorized work today.**

| | Evidence | Settles |
|---|---|---|
| **A** | Actual candidate assignment rows per admin — property, `scope_type`, `can_manage_roles`, `updated_at`, `active`, and whether the property carries an SMS line | Whether the sort keys tie in production; the real candidate set for A090-4 |
| **B** | Property and line inventory across the three property classes (real operating / Demo Building / harness-created) | B4's count — delivery half already-live vs latent |
| **C** | Manual proof issuance and redemption history — `operator_session_invites`, filterable by `issuance_reason='bootstrap_invite'` and `issuance_source='cli'` (`tools/issue_operator_invite.js:84–89`) | Whether reliance on the shell bootstrap is itself the behavioral symptom of the delivery half |
| **D** | SMS request / refusal / dispatch records and sessions minted with their property scopes | Whether `no_property_line` refusals correlate with staff OTP attempts; which property scopes real sessions received |

**When a connection string arrives, this evidence set and the `db_preflight.js`
ledger-to-schema conformance pass (B5, C5) are ONE read-only pass with committed
output — not two sessions.** The evidence and the conformance checks read the
same database at the same moment; splitting them would produce two snapshots that
cannot be reconciled, and would spend two authorizations where one is needed.

---

## C7 — Recorded as agreed, not built

- **CI ban on `EXCEPTION WHEN OTHERS` in migrations.** Agreed and scoped; **not
  built in this phase.** B1 establishes the norm already exists — eight of nine
  handlers name a condition, and seven migrations abort loudly via `raise
  exception` — so this is enforcement of an existing convention, not
  establishment of a new one.
- **Per-migration postconditions, verified ledger state, migration file
  checksums** (B5). Destination only.

---

**Proof level of Appendix C: Locally exercised.** Source and doctrine inspection
only. C4 answers the escalation trigger from source; it does not establish how
many users actually hold multiple assignments, which requires evidence set A/B.

---

# Appendix D — Revised consultant ruling (2026-08-02)

Ruling received after C4 answered the escalation trigger. **Finding 4 is
reclassified from a founder-specific defect to a systemic S2 defect on the normal
staff login path.** Recorded as governing, not advisory. Hold stands.

---

## D1 — Canonical renaming: A090-4 becomes 4A and 4B

The consultant's labels are adopted as canonical. Earlier appendices are not
rewritten; the mapping is:

| Consultant label | This report | Status |
|---|---|---|
| **4A — credential-delivery routing defect** | A090-4 delivery half (C1 left column) | Retires with the operations-line split and corrected delivery truth |
| **4B — staff-session scope defect** | A090-4 session-scoping half (C1 right column) | **Not retired by the split.** Must be resolved as S2 before broader real-operator activation |

**4A** — assignment ordering chooses the outbound property line; can silently
refuse SMS while returning HTTP 200.

**4B** — the normal phone re-login path infers active property from assignment
ordering; affects **every multi-property staff member** using that path; can
change after unrelated assignment administration (D3).

---

## D2 — Revised classification and sequencing

> **P1 — systemic operator-context integrity defect and activation blocker.**

**Affected population**, as established by C4: every current or future
multi-property staff member who uses phone re-login without a property-bound
invite proof. Not an edge case — the authority model deliberately permits one
user to hold active assignments at multiple properties
(`uq_pta_one_active`, `070:194`), so the login path contains a general defect
**in a supported operating state**.

### 4B precedes all of the following

- Broader activation of the real operating property.
- Routine phone re-login for multi-property staff.
- Expanding property access for existing staff.
- Any workflow where the active property is not unmistakably visible before a
  consequential write.

### P0 reserved, and for what

**P0 remains reserved for evidence of actual wrong-property writes,
communications, money actions, or other irreversible consequences.** 4B is not
P0 today. It is also no longer something that can wait behind the operations-line
work.

Evidence set D (C6) is what would move this to P0 — sessions minted with their
property scopes, checked against what those sessions then wrote. Recorded so the
promotion condition is explicit rather than a judgment call later.

### The sequencing ruling

```text
S1 phone identity may remain
→ S2 must be completed
→ then phone re-login can be considered safe for multi-property staff
```

**Until S2 is complete, the deterministic invite and shell-proof routes are not
conveniences — they are the only described login paths that bind identity proof
to an intentional authorized property.** That reframes B3: the shell bootstrap
tool is currently load-bearing for correctness, not just for recovery.

---

## D3 — The assignment-edit side effect is accepted, and it worsens the defect

C4's finding (`teamaccess.js:614` stamps `updated_at = now()` on every assignment
PATCH) is accepted as changing the character of the defect, not merely its
detail:

| Without this fact | With this fact |
|---|---|
| *The login path chooses the wrong concept for deciding the property.* | ***Unrelated access administration can silently change a user's future operating context.*** |

The hidden coupling:

```text
manager edits modules or role on Property B
→ assignment.updated_at changes
→ Property B becomes the preferred login row
→ staff member's next session lands on Property B
```

The administrator making the edit is not choosing a landing property. The staff
member logging in is not choosing one either. **The operating context changes
anyway.** Three derived risks, recorded as ruled:

1. **Context drift.** The result is not fixed at account creation. It can change
   throughout the user's employment, whenever assignments are maintained.
2. **Poor auditability.** A later investigation sees a valid assignment edit and a
   valid session, with no event stating *"active operating property changed from
   A to B."* The causal link exists only because two unrelated features share
   `updated_at`.
3. **False stability.** Ordinary users may receive the same property repeatedly,
   making the behavior look deliberate — until an unrelated access edit changes
   it. **A stable wrong rule is harder to detect than a visibly random one.**

**Effect on severity:** no new label. It makes containment more urgent and
**rules out treating the current behavior as a tolerable temporary default.**

### One precision worth carrying into the S2 build

§21 (`PHILOSOPHY.md:649–658`) names the forbidden state as:

```text
Solo chrome
→ another property's data
```

**4B does not produce that state, and that is what makes it harder to catch.**
The shell, the property name, the modules and the reads all agree — they simply
agree on a property the operator did not choose. It is coherent and wrong rather
than visibly inconsistent, which is the same shape as risk 3 above and the reason
detection cannot rely on a chrome/data mismatch.

---

## D4 — S2 acceptance conditions (recorded as the ruling's, not proposed)

The fix **must not repair the ordering.** *"A third tiebreak would only make the
wrong decision rule deterministic."*

The correct starting primitive is the set-shaped read that already exists
(`staff_identity_resolver.js:290–291`, C2):

```text
verified staff user
→ full active authorized-property set
→ explicit scope decision
→ server validates the chosen scope
→ property-scoped canonical session
```

**Acceptance conditions:**

1. With **zero** authorized properties, **no operating session is minted.**
2. With **one** authorized property, the server may establish that scope directly.
3. With **multiple** authorized properties, the system makes an **explicit scope
   decision** rather than inferring one from role-management authority,
   assignment recency, row order, or phone configuration.
4. The selected property is **validated against the user's active assignment
   set.**
5. The resulting session **carries the active server-authorized property.**
6. The shell **clearly reflects that same property.**
7. All subsequent reads and writes **use that same scope.**
8. Changing modules, role labels, or unrelated assignment metadata **must not
   silently change the user's next operating property** (D3).

Condition 3 is the one that distinguishes this from the current behavior:
`can_manage_roles desc, updated_at desc` is precisely an inference from
role-management authority and assignment recency, and is named as disallowed.

**In-repo doctrine support** — §21 (`PHILOSOPHY.md:632–650`) requires the server
to derive and validate *authenticated actor, role, authorized property,
property-team membership, module entitlement, task eligibility, session
validity*, and states *"A client-provided property ID is never authority"* and
*"The app shell, property name, modules, reads, and writes must all agree with
the same server-authoritative context."* Conditions 4–7 are that paragraph
applied to login.

---

## D5 — The next decision, restated

The hold remains correct. **The open question is not "which tiebreak should
win?"** It is:

> **What explicit S2 scope decision completes phone re-login using the
> authorized-property set that already exists?**

That is a design decision requiring a ruling, not a code change, and it is not
authorized in this phase.

---

## D6 — Citation provenance

The ruling cites **`Operator App Audit.docx`** twice. **That document is not in
this repository** — `find` over the working tree returns no match, and
`docs/specs/` contains `DOCTRINE.md`, `HOOK_COMPARISON_SPEC.md`,
`MONEY_INBOX_SPEND_CONTROL_SPEC.md`, `NEXT_RUNG_REVIEW_UX_SPEC.md`,
`PROPERTY_SPINE_SPEC.md` and `WORK_ORDER_PERSON_HANDOFF.md`, none of which is it.

Its claims are therefore recorded as **external and unverified from source.**
Where the ruling's architectural points could be checked in-repo, they were, and
they hold: the mandatory `S1 → S2` order at `PHILOSOPHY.md:598–620` (C2) and the
server-derived authority requirements at `PHILOSOPHY.md:632–658` (D4). No claim
in this appendix rests on the external document alone.

---

**Proof level of Appendix D: Reported** — this appendix records a ruling and its
reasoning. It is the only section of this report at that level; every finding it
governs remains *Locally exercised*. Nothing here was verified against a
database, and the ruling's population estimate for 4B is bounded by C4's limit —
source establishes that the capability is universal, not how many users currently
exercise it.

---

# Appendix E — S2 surface audit: is 4B the only gap?

**Question.** D5 leaves the S2 design decision open. Before that decision can be
scoped, one thing is source-answerable now: **is 4B the only place a staff
operating property is inferred rather than server-authorized, or is it one
instance of a pattern?** This bounds the S2 build.

**Answer: 4B is a single defective write, not a pattern. The surrounding
architecture is sound, and that is what makes 4B hard to detect.**

---

## E1 — What is already correct

### One mint path, one resolve path

`src/identity/staff_session_service.js` is the sole issuer and sole authority
read — `issueStaffSession(client, { userId, propertyId, purpose })` (`:59`) and
`resolveStaffSession(db, token)` (`:169`), described in-file as *"the ONE mint
path"* (`:55`) and *"the ONE live authority read"* (`:130`). It rejects a mint
missing either id (`:62`).

### Every mint site supplies an explicit property from a durable record

All four call sites, and the provenance of `propertyId` at each:

| Call site | `propertyId` source | Deterministic? |
|---|---|---|
| `operator_session_bootstrap.js:125` | the operator invite row (`--property`, C4/B3) | **Yes** — explicitly chosen by the issuing human |
| `teamaccess.js:439` | `inv.property_id`, the accepted onboarding invite | **Yes** — the invite was minted for one property |
| `operator.js:205` | `prop.id`, the demo path's resolved property | **Yes** |
| `teamaccess.js:370` | `inv.property_id`, the **login** invite | **No — see E2** |

**No mint site accepts a client-supplied property id.** §21's *"a client-provided
property ID is never authority"* holds at the issuer.

### The resolver enforces S2 live, not just at login

`RESOLVER_SQL` (`:153–167`) joins
`property_team_assignments a on a.user_id = u.id and a.property_id = s.property_id
and a.active = true`. **A session whose assignment is revoked stops resolving
mid-life** — authority is re-derived on every request, not trusted from the token.
The returned `property_id` is annotated *"the SESSION's property — scope truth"*
(`:193`).

### The client half of §21 is defended explicitly

`refuseClientProperty` appears in six modules — `agent/staff_agent.js:43`,
`maintenance/work_acceptance.js:71`, `maintenance/unit_turn_scope.js`,
`maintenance/maintenance.js`, `maintenance/unit_triage.js`,
`maintenance/readiness.js` — each refusing with *"property authority is
server-derived; a client-supplied property_id cannot select a different
property."* `src/identity/actor_context.js:202` lists `request_body_property_id`
under `never_uses`, and `src/leasing/leasingleads.js:124–134` treats a body
`property_id` as *"a REQUEST"* subject to entitlement rather than as authority.

**This is a deliberate, repeated, correctly-reasoned defense.** It is not the
problem.

---

## E2 — The gap: one write, laundered into legitimacy

The arbitrary pick does not reach the issuer directly. It is **written into a
durable record first**, and read back as if chosen:

```text
teamaccess.js:207–211   arbitrary ORDER BY … LIMIT 1  →  a.property_id
teamaccess.js:240–246   INSERT INTO team_invites (property_id, …) VALUES (a.property_id, …)
teamaccess.js:371       issueStaffSession({ propertyId: inv.property_id })
```

By the time the value reaches the canonical issuer it is `inv.property_id` — a
column on a durable invite row, structurally identical to the onboarding-invite
path at `:439` that is genuinely deterministic. **The mint cannot tell them
apart, and neither can anything downstream.**

### Why this matters for the S2 acceptance tests (D4)

Three defenses that look like they would catch 4B do not:

1. **A test at the mint site** would see an explicit `propertyId` drawn from a
   durable record and pass.
2. **`refuseClientProperty`** compares the claimed value against
   `req.operator.property_id` — *the session's own scope*. It guarantees the
   client cannot **change** the property; it cannot detect that the property was
   **never chosen**. Every one of the six guards measures consistency with a
   value 4B may have set arbitrarily.
3. **The resolver's assignment join** confirms the operator *is authorized* for
   the session's property. 4B always picks an authorized property — that is the
   whole point. The join passes.

This is the same shape as D3's observation about §21's forbidden state: **every
consistency check passes, because the system is consistently pointed at the
wrong property.** An S2 acceptance suite written against the mint, the guards, or
the resolver would go green with 4B fully present.

### The remediation surface is one line

The only place the defect can be corrected is where the value originates —
**`/auth/sms/start`, the single write at `teamaccess.js:246`** that puts
`a.property_id` into the login invite. That is the entire blast radius of 4B's
scope half.

**This is good news for the S2 build.** D4's condition 3 (*"with multiple
authorized properties, the system makes an explicit scope decision"*) has exactly
one insertion point, not a diffuse refactor: the decision must happen before the
login invite is written, and everything downstream already honors whatever it
records.

---

## E3 — Not classified: client-scoped reads outside the guarded modules

Recorded as a lead, **not as a finding.** Several routes take `property_id` from
`req.query`, `req.body` or `req.params` without passing through
`refuseClientProperty`:

`src/money/commitmentledger.js:1430,1436` · `src/tenancy/availability.js:202` ·
`src/tenancy/movein.js:517,550` · `src/leasing/leasingscheduling.js:348` ·
`src/leasing/leasinginteractions.js:260` · `src/leasing/decisions.js:347,349` ·
`src/surfaces/roomowners.js:156,180` · `src/shared/snapshot_loader.js:1082–1083`

**These are not asserted to be defects.** Some are owner or public surfaces where
a different authority model legitimately applies; some may be filters within an
already-scoped session rather than scope selection. **Each needs its own
classification against §21, and that was not performed here** — it is a separate
audit with a different question, and doing it badly would produce exactly the
confident-wrong output this report exists to avoid.

It is recorded because the asymmetry is real: six modules defend this explicitly
and roughly ten touch client property ids without that guard. Three distinct
handling patterns are visible in source (`refuseClientProperty` refusal,
`leasingleads.js:124` entitlement-check-as-request, and unguarded read), which is
itself worth a ruling.

---

**Proof level of Appendix E: Locally exercised.** Source inspection only. E1 and
E2 are conclusive from source — the mint sites are enumerable and their arguments
traceable. E3 is explicitly unclassified and must not be cited as a finding.

---

# Appendix F — S2 design ruling (2026-08-02)

Ruling received in response to Appendix E. **Recorded as governing.** It settles
the D5 question, corrects one thing E2 got wrong, and defines the acceptance
surface. Nothing here is built; the hold stands.

---

## F1 — Correction to E2: the decision belongs AFTER S1, not at the origin write

E2 concluded that *"the remediation surface is one write —
`teamaccess.js:246`."* **That location is right and the timing is wrong, and
the ruling explains why.**

`teamaccess.js:246` sits inside `POST /auth/sms/start`, which runs **before the
phone credential is verified**. Deciding the property there — even by asking the
operator — would:

1. **Disclose a staff member's property affiliations to anyone who knows their
   phone number.** An unauthenticated caller could enumerate where a person
   works by starting a login they cannot finish. This is an information-
   disclosure defect, not a UX preference.
2. **Keep S1 and S2 blended**, which is the coupling the fix exists to remove.

**The ruling is explicit: do not put a pre-OTP property picker in front of the
current delivery mechanism.** *"That would make the interim behavior easier to
use while preserving the conceptual coupling you are trying to remove."*

### The corrected flow

```text
enter phone number
→ send property-neutral OTP through the operations line
→ verify OTP: S1 complete
→ resolve the user's current active property set
→ make the S2 decision
→ record the selected property on the durable login record
→ mint the existing canonical property-scoped session
```

**Amended remediation surface:** the login invite must be minted
**property-neutral** at `/auth/sms/start`, and the property attached at
`/auth/sms/verify` after S1 completes. E2's "one write" framing understated the
change — see F4, which establishes that the current schema cannot represent a
property-neutral login invite at all.

---

## F2 — The S2 decision: three cases

| Active set | Behavior |
|---|---|
| **Zero** | **No property-bearing invite and no session.** Show: *"Your account does not currently have access to a property. Contact your manager."* |
| **Exactly one** | **Select automatically.** No judgment is being asked of the user, so a chooser would be friction for no benefit. |
| **More than one** | **Require one explicit choice** — *"Where are you working?"* — listing only the server-returned active authorized properties. |

On selection, the server: (1) re-resolves the active set, (2) confirms the chosen
property is still in it, (3) writes that exact property to the login record,
(4) hands the record to the existing issuer.

**The browser expresses intent; it does not grant authority.** The server defines
and validates the allowed set, preserving §21.

### Explicitly disallowed as a default

Named in the ruling, all as *"proxies for intent"*: most recently updated
assignment · highest role · `can_manage_roles` · property phone configuration ·
database row order · most recently created assignment · the property the browser
already displays.

**The first two are exactly the current sort keys** (`can_manage_roles desc,
updated_at desc`), so this forecloses repairing the ordering rather than
replacing it.

### A remembered choice is a later, separate fact

Spine may eventually remember a last explicitly-chosen property, but as its own
durable fact, surfaced as *"Continue to Solo on Chestnut / Choose another
property."* **A remembered choice must never silently become permanent authority
or inferred current intent.** Not in scope for the first S2 completion.

---

## F3 — The controlling invariant

E's laundering finding is accepted: once an arbitrary property reaches a durable
invite, every later component sees a valid record. Therefore the invariant lives
at the origin, not downstream:

> **No phone re-login record may acquire a property unless the active assignment
> set contains exactly one property, or the verified operator explicitly selected
> one from that set.**

*"The invite/session issuer should remain boring. Its job is to honor a correctly
produced property-bound record. The decision point must prove how that property
got there."*

---

## F4 — Provenance and the schema: source answer to the ruling's conditional

The ruling asks for provenance values — `single_active_assignment`,
`explicit_staff_selection`, `onboarding_invite`, `shell_issued_proof` — *"where
the existing record supports a source or reason field,"* adding: *"I would not
add a schema change solely for that unless current source lacks any suitable
provenance field."*

**Source answers this: there is no suitable field, and two independent schema
constraints block the ruling's flow.**

### Constraint 1 — `team_invites` has no provenance field, and never has

Defined once at `migrations/035_phone_first_team.sql:89–114`. **There is no
`alter table team_invites` anywhere in the 122 migrations** — the table has never
been altered. Its columns are id, property_id, phone_number, invited_name,
role_title, allowed_modules, scope_type, backup_user_id, escalates_to_user_id,
can_manage_roles, invited_by_user_id, token, status, otp_hash, otp_expires_at,
otp_sent_at, failed_attempts, superseded_by, expires_at, accepted_at,
accepted_user_id, created_at. **No reason, source, purpose, or origin column.**

The current re-login marker is *derived*, not recorded: `accepted_user_id` set at
creation plus `allowed_modules = '{}'` (`teamaccess.js:186–192`). That
distinguishes a re-login invite from an onboarding invite — but it **cannot
express how the property was chosen**, which is the axis the ruling wants
preserved.

**There is an exact precedent to copy.** `operator_session_invites`
(`070_operator_session_bootstrap.sql`) already carries
`issuance_reason text not null default 'bootstrap_invite'` (`:48`) and
`issuance_source text not null default 'cli'` (`:64`). The pattern the ruling
describes is already modelled in this schema, one table over.

### Constraint 2 — a property-neutral login invite cannot currently be represented

`035:91` — `property_id uuid not null references properties(id) on delete
cascade`. **NOT NULL.**

The ruling's flow requires the OTP to be sent property-neutral and the property
attached only after verification. **The current schema forbids that**: a login
invite cannot exist without a property, which is precisely why the arbitrary pick
happens at `/auth/sms/start` in the first place. The defect is partly structural,
not only procedural.

Two resolutions are visible from source — making `property_id` nullable for
login-purpose rows, or holding login OTPs somewhere other than `team_invites`.
**Choosing between them is design and is not authorized here.** What source
establishes is that **the first S2 slice necessarily includes a migration on a
table that has never been altered**, and that migration can carry the provenance
columns at no extra cost, resolving both constraints together.

---

## F5 — Containment adapter (Class: temporary, §18)

A defensible containment exists that **invents no temporary tiebreak**. At the
current origin point:

| Active set | Containment behavior |
|---|---|
| 0 | refuse |
| 1 | continue with that property |
| **2+** | **refuse phone re-login before writing an invite**; direct the user to the deterministic invite or shell-proof path |

Message: *"This account has access to more than one property. Use your
property-specific sign-in link while we complete property selection."*

**Why it qualifies as a legitimate temporary adapter:** it fails closed; it
removes wrong-context risk; it creates no second authority model; and it has an
exact retirement condition.

> **Removal condition (§18):** replace the multi-property refusal with explicit
> post-OTP property selection.

**Most of it survives the final build.** Authorized-set resolution and the
zero/one/many branching are permanent; only the *many* branch changes from
`refuse` to `selection_required`.

---

## F6 — Sequencing ruling

- **If the operations-line split and full S2 are the next immediate release** —
  build the complete flow once. **Do not ship a separate containment release.**
- **If full S2 will wait beyond that release** — ship the multi-property refusal
  first. *"The P1 path should not remain open merely to avoid one small temporary
  branch."*
- **Never** — a pre-OTP property picker in front of the current property-line
  delivery (F1).

---

## F7 — Acceptance must target the decision point

**Explicitly insufficient**, confirming E2: a green session-mint test, a green
client-property-refusal test, and a green assignment-authority test. All three
pass with 4B present.

The decisive cases:

| # | Case | Required outcome |
|---|---|---|
| 1 | **Zero assignments** | verified user → no active assignments → no property-bearing login record → no session |
| 2 | **One assignment** | verified user → that exact property recorded → session carries it |
| 3 | **Multiple, no selection** | **no arbitrary property is written** → result is `selection_required` → no session minted |
| 4 | **Valid selection** | server returns set A+B → user selects B → server revalidates → record contains B → session contains B |
| 5 | **Invalid selection** | user submits C, not in the current active set → refusal → no property-bearing record → no session |
| 6 | **Revocation race** | B in the initial set → B revoked → user submits B → server re-resolves → refusal |
| 7 | **Assignment-edit regression** | user has A+B → unrelated modules/role edit changes `B.updated_at` → **login still requires explicit selection; no property becomes preferred** |

**Case 7 is the direct regression test for D3**, and case 3 is the one that
would have caught 4B.

**Proof ladder** — per §33 and `CLAUDE.md`, source assertions are not the
stopping point:

```text
isolated Postgres
→ real HTTP
→ browser: verify OTP · see property chooser · choose B ·
           shell shows B · scoped read uses B
```

---

## F8 — The other property-ID routes: registered, out of this build

E3's unclassified list is registered and **stays out of the S2 build.** After S2
settles, classify each into:

| Class | Rule |
|---|---|
| **Operator authority** | a client property must not determine scope |
| **Portfolio filtering** | an already-authorized operator may select a property to view, with server validation |
| **Public addressing** | a public request may legitimately identify the property being contacted |
| **Owner / administrative control** | separate authority model, requiring its own validation |

> *"Three patterns are not automatically a defect. Three unclassified patterns
> are the concern."*

---

## F9 — Citation provenance

The ruling cites **`Property Spine Master Document.docx`** three times. **It is
not in this repository** — `find` over the working tree returns no match. As with
`Operator App Audit.docx` (D6), its claims are recorded as **external and
unverified from source.**

The points that could be checked in-repo were, and hold: §21's server-derived
authority (`PHILOSOPHY.md:632–658`) supports the browser-expresses-intent model
in F2, and the proof ladder in F7 matches §33 and `CLAUDE.md`'s Definition of
Done. **Two governing rulings now rest partly on documents absent from the
repository**; if they are doctrine, they belong in `docs/`.

---

**Proof level of Appendix F: Reported** for the ruling itself (F1–F3, F5–F8);
**Locally exercised** for F4, which is source-derived and conclusive — the
`team_invites` definition, the absence of any `alter table team_invites`, the
`NOT NULL` on `property_id`, and the `operator_session_invites` precedent are all
read directly from the migrations.
