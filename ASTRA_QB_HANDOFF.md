# Astra QB Handoff

Prepared September 6, 2026 for Kameron to start a **new QB task on his desktop**. This packet is intended to stand on its own; prior task memory and the Pennsylvania laptop are not prerequisites for understanding the work.

## Start here

Read this file, then [EXECUTION_RECEIPT.md](docs/handoffs/astra-qb-20260906/EXECUTION_RECEIPT.md). The receipt is the final authority for which checks actually finished before shutdown. Use [START_NEW_QB.md](docs/handoffs/astra-qb-20260906/START_NEW_QB.md) as the opening prompt for the desktop task.

**The new onboarding candidate is pushed but is not a release approval.** The immediate milestone is real July source → retained evidence → canonical review → restart, without confirming actual resident claims. At this packet's initial publication, that final successor browser run was still in progress. Do not confuse the successful first-red proof with successful onboarding.

## Exact custody

| Repository / role | Branch | Exact commit |
|---|---|---|
| API: last completed pre-onboarding checkpoint | `codex/qb-proof-checkpoint-20260905` | `e09c5411e2c072c3452e48b434a9f8a8250ce1bb` |
| API: new onboarding candidate | `codex/canonical-onboarding-rehearsal-20260905` | `cc896dcd791793f01f832ccd596898770a4fc6da` |
| App: new onboarding candidate | `codex/canonical-onboarding-rehearsal-20260905` | `180c6d10accb3b0033e20129f07ce4e5e585c0de` |
| App baseline | pinned baseline | `4849545118fc422177bc604389608cdbb55df458` |
| This transfer packet | `codex/astra-qb-handoff-20260906` | Documentation and archived recovery patches, based on e09c541 |

Both new candidate branches were successfully pushed September 6. No merge, rebase or force-push was used. This handoff branch deliberately carries documentation and archived patches, not the new product files in their live locations. **Check out the candidate branches to continue engineering.**

Repositories: [API](https://github.com/kzitelli-art/property-spine-api), [App](https://github.com/kzitelli-art/property-spine-app). The packet may have later documentation commits; the execution receipt records any later candidate changes.

## Operating doctrine and what the product is for

Read [PHILOSOPHY](docs/PHILOSOPHY.md), especially the north star, honest blanks, inventory grain, shared reads and existing-mechanism rules, and [DOCTRINE](docs/specs/DOCTRINE.md).

Kameron's rule is: **capture reality once, preserve its evidence and uncertainty, and let the application and Ask Spine read the same canonical truth.** The practical outcome is that Mike and Kameron can bring a property's real source into Deal Setup once, inspect every claim and missing fact, leave and return, and establish only supported facts through governed decisions.

Greenery is the second-property portability test because Mike manages both Greenery and Skyline. It must expose and repair generic platform assumptions. No Greenery-specific architecture, branch in product logic, parallel importer, private frontend state or alternate Ask Spine dataset is acceptable.

Use VERIFIED FACT for inspected/executed evidence; STRONG INFERENCE for a source-supported mechanism not yet exercised; UNKNOWN for missing observations; OWNER DECISION for consequences that require Kameron. A model recommendation does not supply owner authority.

## Authorization and hard holds

Kameron authorized bounded generic candidate repairs, isolated disposable local proofs, commits/pushes, and retirement of the legacy ingestion door. The battery update prioritizes a clean desktop handoff.

Still held: production/database/provider changes, Render, Twilio, deployment, merge, rebase, force-push, production migration allocation/application, real-user actions, production Greenery onboarding, and actual-source resident/lease confirmations in this rehearsal. Do not resend Mike's invitation. No new paid usage, usage reset or scheduled continuation was authorized. Fable's old conditional extra-usage allowance applied only to its specified run.

The pending claim index is intentionally **not a numbered production migration**. The candidate requires that schema change for repeated spatial keys. CI/local proof may apply it only to the owned disposable database. It must not be released as-is with an assumption that the production schema already matches.

## Production and completed engineering history

Last supplied production observations: API `d55dae960a52c762187c94e5f48e348fccc0c964`; app `4849545118fc422177bc604389608cdbb55df458`. This work did not contact production to refresh them or deploy a successor.

Mike's accepted invitation, one active user, one Skyline Property Manager assignment and two active Skyline staff sessions were dated observations. Do not present those counts as perpetually current.

Fable's branch `claude/d55-defect-porting` remained `f95344977b6c7cacacd40f503bed452f501227a0`. Its [CI run391](https://github.com/kzitelli-art/property-spine-api/actions/runs/33939873696) covered the descendant tree, including the approval-timestamp repair; the lack of a standalone run for that earlier commit was not missing descendant coverage. Seventeen repaired classes were reported across the overnight sequence. Selected CI coverage is not proof of the entire defect backlog.

The donor `fd574aa61da55614470d855ce11351eca96556d4` remains donor-only. Do not wholesale merge/cherry-pick it. Re-derive findings on the production-descended candidate.

Three review gaps after f953449 were independently falsified and repaired at `1283f40ed058d78ec271e2b05f077cc7fb618502`:

1. Notice correction preserves original space/lease identity and refuses contradictions.
2. Shared deposit allocation locks the deposit row before reading capacity; concurrent competitors and visibility were exercised.
3. The optional cross-property economics comparison was removed rather than retaining a reader that could falsely deny published pricing.

See [QB checkpoint](docs/QB_CHECKPOINT_2026-09-05.md). [Run396](https://github.com/kzitelli-art/property-spine-api/actions/runs/33965775886) passed at1283f40.

Kameron then authorized retiring nine legacy ingestion method/path pairs. The unchanged1283 parent positively allowed key-only approval/promotion and created a unit without a staff actor. The successor requires authenticated410, anonymous401, unset-key503, no mutation/provider work, preserved history and useful canonical Deal Setup guidance. The global key gate still runs first; shared services and the independent leasing-basis setter remain. See [retirement scope](docs/LEGACY_INGESTION_RETIREMENT_2026-09-05.md).

The resulting e09c541 checkpoint is pushed and [run398](https://github.com/kzitelli-art/property-spine-api/actions/runs/33969376533) passed; success metadata was refreshed September6. September5 work inspected the underlying logs. **No governed source caller was found; external traffic was not measured.** Kameron authorized retirement knowing that distinction.

## What was interrupted, and what has now been implemented

September5 ended while building the safe real-browser first-red. Earlier timeouts, multipart/setup issues and harness errors were not accepted product witnesses. September6 finally proved both real retained workbooks reached upload201/download200 with matching bytes, then read-source422 `no_unit_column`, visibly reporting the title `Rent Roll` as the header, on unchanged e09c541/API and4849545/app.

The new candidate uses the existing owners:

| Seam | Implemented candidate behavior |
|---|---|
| Retained source adapter | One pure CSV/XLSX/XLS adapter recognizes supported headers/sections, preserves physical source row, resident code and dates, and refuses ambiguous layouts. It reuses the existing field vocabulary. Terminal subtotal recognition is narrow; interior incomplete evidence is retained. |
| `ingestRentRoll` | Reads and verifies retained bytes; requires property scope, rent-roll kind and consistent request/artifact/content dates. Contradictory caller rows are refused. |
| Source dedup | Identical bytes cannot silently acquire a contradictory source date. |
| Proposal identity | Keeps spatial natural keys but uses existing source-row identity for claims. Current and future claims on the same bed survive separately; counts reflect actual inserts. Pending DDL narrows the older natural-key index to legacy rows lacking source-row identity. |
| Inventory | Existing ledger/materialization helpers create inventory only from current rows. Future-only unknown units/rooms remain evidence/discrepancies, never invented inventory. |
| Money and occupancy | Actual rent remains null or literal zero. Asking rent cannot become contract rent. Future claims cannot pass generic Add. An unnamed occupied/unknown row cannot be promoted as vacancy. |
| Identity continuity | Reuses the existing prior-produced-person lookup as candidate evidence. No name/room/code auto-merge. A held person candidate is displayed; an explicit decision uses the existing person-proposal confirmation mechanism, then lease confirmation resumes with that person. |
| Lifecycle | Confirm/reject/identity resolution/establish lock the activation before proposals. Established setups refuse later decision changes. Unconfirmed staged leases count as unresolved; person proposals do not inflate lease totals. |
| Canonical reads | Opening occupancy excludes explicit future/person proposals and exposes conflicting current claims. Activation-bound evidence cannot publish itself as the operating snapshot or latest confirmed source. Promoted decisions alone affect the published activation projection; held claims stay labeled. Legacy unbound history retains its earlier semantics. |
| Existing app | Uploads once, asks the server to interpret the artifact/date, shows actual versus asking rent and current/future/unassigned counts, provides explicit identity decisions, and reports real Add All successes/refusals/remaining-ready rows. |

The first successor DB runs passed29 source/identity assertions. The ledger run initially stopped on a **proof field-selection error**, not a failed occupancy result: the public proposal reference is `basis_ref.proposal_id`; an internal field and then a descriptive string field were incorrectly assumed to hold it. The final candidate fixes that assertion without removing the proposal-ID check. Its executed result belongs in the execution receipt.

Independent review also caught a substantive leak: staging committed evidence could replace the operating Rent Roll and create future availability commitments before approval. Fifteen positive parent assertions now reproduce that class. The candidate publication boundary was added in response, rather than labeling retained-file success as canonical truth.

## Actual source controls and private access

These files were readable on the laptop; hashes were rechecked September6. **Original workbooks, raw resident rows, screenshots, tokens and private runtime identifiers are not in Git.** The desktop QB must verify access and hashes before claiming real-source proof. A Windows path in an old task is not source access.

| Input | Bytes | SHA256 |
|---|---:|---|
| July `RentRoll07_1325a.xlsx` | 35849 | `96B901AF41A17D8268D218604F3D15D7AB018BC60F86F2825E9080B654853CDA` |
| Skyline `RentRoll07_1417.xlsx` | 40859 | `51AE5893B43A80308F88696156E9538972E8EA0212900F1FD71C5A068CAA9F4A` |
| August `GPR_Report_08_1325.xlsx` | 333615 | `CB00E65299E5DFCF64B5A248C9F53CAABC63B901BA7CF0F199EC7F7814947CD3` |

**July, as of2026-07-31:**64 physical units,105 current rentable positions (23 one-position and41 two-position units);105 current rows,59 future rows;164 total evidence/claims,145 assigned and19 unassigned future. Current occupancy52/53 vacant. Forty assigned future claims share current bed keys. Forty-six current occupied rows and all40 assigned future rows lack actual rent despite market rent. Expected statuses59 staged,86 needs_review,19 blocked. Keep all59 future records and every blank.

**Skyline control, also July31:** same15-column split-header format;72 units/160 current positions;262 rows=160 current+102 future;251 assigned/11 unassigned future. Current37 occupied/123 vacant. Expected160 staged,91 needs_review,11 blocked; no missing actual rent among current occupied or assigned future records. This is a regression control, not a custom parser.

**August is not started.** Its September5 source controls describe a different22-column hierarchical GPR report:64 Unit,105 Room and105 structural Bed rows;96 occupied/9 vacant; eight occupied actual rents are literal zero. Market117800.00, potential110900.00, vacancy11402.80, actual99497.20. It lacks lease-from/to dates. A physical-unit-only tenant directory cannot supply a fabricated room/bed identity join.

## Restore and resume on the desktop

1. Fetch the API and app repositories; use separate checkouts of the candidate SHAs above. Read the execution receipt and current CI result first.
2. Create a separate unchanged API parent worktree at e09c541. The local wrapper defaults to a sibling named `qb-proof-checkpoint`; alternatively set `ONBOARDING_PARENT_ROOT`.
3. Install dependencies from the lockfiles. This laptop used Node24, PostgreSQL17.10, installed Chrome and Playwright1.62.1; CI uses Node22/PostgreSQL16. The laptop's `node_modules` junction is not portable.
4. Obtain authorized private originals and verify the hashes. Supply paths through environment variables; do not add them to Git.
5. Run the owned proof wrapper from the API candidate:

```powershell
& ./tests/e2e/onboarding_review_local.ps1 `
  -AppRoot $env:PROOF_APP_ROOT `
  -JulySource $env:JULY_SOURCE_PATH `
  -SkylineSource $env:SKYLINE_SOURCE_PATH
```

It creates a fresh loopback-only PostgreSQL cluster/database with ownership nonce, applies the real migration chain, runs positive parent witnesses, applies pending DDL only there, runs candidate synthetic/HTTP proofs, drives the shipped app through source review, stops/restarts the real API, reopens the same review, verifies retained bytes/lineage/counts/no actual-source confirmations, and runs a separate synthetic mixed-success Add All. It cleans the owned database/server/cluster on exit.

`-ExpectShippedHeaderFailure` is a separate first-red mode: use the unchanged app4849545 and e09 parent; it is not successor acceptance. The archived first-red browser script exists in the app candidate.

The browser fences external requests and uses local replacements for known libraries/fonts/decorative assets. Unknown external requests fail the proof. This is operating-flow verification, not a visual/font fidelity claim. Real source confirmation requests are blocked in stage/restart; only the separate synthetic phase may confirm.

API CI now includes the adapter and synthetic parent/successor source, lifecycle, ledger and publication proofs, plus the existing selected suite. The private-workbook browser milestone is **not** supplied by API CI. The app's existing workflow is pinned to an older branch/API and does not automatically prove the new pair. Do not dispatch that old workflow and call it new candidate coverage.

## Immediate next bounded sequence

The final execution receipt may complete some of these; do not redo finished checks.

1. Resolve the actual last failing proof, preserving positive-parent and successor assertions. Establish a clean July/Skyline review-and-restart checkpoint on the paired candidate SHAs.
2. Require zero actual-source persons/leases/opening positions,105/160 rentable positions, exact164/262 claims, immutable artifact hashes and unchanged review after restart. Require ordinary reads/Ask Spine source receipts to avoid presenting open review as established truth.
3. Review the paired candidate and pending schema separately. No release is authorized.
4. Next, implement the generic August hierarchy adapter with parent falsifications, Room-level grain, literal-zero preservation, child-row provenance, truthful aggregate totals and no invented lease dates or joins.
5. Then run synthetic cross-property switching and governed reads; make real operating/source decisions only with authorized evidence. The entire historical backlog need not be exhausted before this milestone.

Use Sol for bounded proof/adapter/UI/custody tasks, Astra for integration and adversarial judgment. Reserve expensive Fable work for a coherent substantive review. Verify every worker can access instructions **and** actual private inputs before dispatch.

## Local-only work and recovery

The new API/app changes are pushed, rather than left as laptop-only edits. The handoff includes [recovery material for the older divergent lane](docs/handoffs/astra-qb-20260906/unpushed-legacy-lane/README.md): six plain source/test patches and a manifest of ten local commits, with curated dated summaries of four documentation-only commits.

That older checkout remains unchanged at `c1622e2af0865d998579d377c5fa9455c9ae9e69`, branch `codex/skyline-guarantor-agent-20260822`,65 behind/10 ahead of upstream `91690eade84355461615aacb1af94a8fac7c1f77`. Its exact branch history was not pushed or merged into this candidate. Its code changes are recoverable from the archive, but must not be blindly applied; they concern invitation/signing/guarantor evidence and need lineage review.

Still private/local: original workbooks, private diagnostic logs/screenshots and exact historical runtime identifiers. They are excluded intentionally. The main packet includes the mission and controls, so the old local-only Greenery instruction failure is not repeated. A private local custody note on the laptop gives optional diagnostic/input locators; it is not required to restore the code.

## Five largest risks and remaining weaknesses

1. **Overstating completion:** a green selected suite, retained upload, or first-red witness is not successful onboarding, release readiness or production verification. The execution receipt must state the remaining rung exactly.
2. **Evidence becoming invented truth:** actual/asking rent, future/current claims, identity decisions and source publication are now explicitly separated. Additional consumers and older projections still need scrutiny before real confirmations.
3. **Legacy reader limits:** unbound historical imports retain prior semantics; the older snapshot/availability projection still contains unit-grain behavior. This slice does not certify bed-level operating behavior after actual-source establishment across every legacy consumer.
4. **Financial/release debt:** deposit locking does not fix partial `amount_matched` reading as full cash proof. The unit-wide notice sibling guard remains. Pending onboarding index DDL, boot-time ALTER TABLE policy, Ask Spine reader-gate scope and other historical findings remain distinct review/release work.
5. **Custody and portability:** private inputs may not be available on the desktop; Windows proof orchestration requires its runtime dependencies; local PostgreSQL17 differs from CI16; cancellation under every possible failure is not proven. The older divergent lane is recovery material, not an accepted successor.

Other precise limitations: storage accepts some formats the new adapter explicitly refuses at interpretation; lifecycle sequential proofs do not by themselves execute a two-connection race; no fresh production/session counts were collected; August parsing, synthetic second-property switching and actual-source confirmation are not completed by this packet.

## Corrections to earlier quarterbacks

Greenery did not run overnight because instructions were inaccessible remotely. f953449 descendant CI covered the approval repair. Initial notice creation did not prove correction. An empty-property comparison did not prove published-pricing semantics. No governed caller found did not mean zero external usage. Ingestion retirement is now on the candidate but not deployed. Early browser timeouts and test-field mistakes are harness failures, not product falsifications. Retaining/interpreting a file is not authority to publish its claims.

The desktop QB should ask Kameron only for genuinely missing source access, source/identity authority, or a consequential release decision. Do not ask him to reauthorize the reversible generic work already authorized. The first operational dependency to establish is **access to the original private workbooks on the desktop**.
