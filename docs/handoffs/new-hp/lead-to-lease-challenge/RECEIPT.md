# Lead-to-lease challenge — independent test receipt (2026-09-11)

Returned to HP QB for integration. **Test-only.** No product source was
edited; nothing was merged, deployed, migrated or run against a shared
database, live user or provider.

## What was compared

| Tree | Commit | Role |
|---|---|---|
| Released API | `24f4482140bed554185fe4fdcbb7c2366a5d3c07` | baseline (branch `codex/hp-release-integration-20260911`) |
| Candidate API | `932c9afafccd31f75385b1a7fc17c41deda48b32` | candidate (same branch; CI run 34630999277 passed; not deployed) |
| App | `b00cf4993e4f699cd174a7ef5c8a27ca4b5507c4` | read only; no browser rung was run here |

Runtime: owned loopback Postgres 16 built from the real migration chain
(ledger ceiling 194 / 182 rows), nonce-owned disposable database, one owned
HTTP server per tree booted with the same environment `tests/e2e/boot.sh`
uses, fake SMS transport, Anthropic sentinel (every model call refuses, so
every agent case is a **scripted-model** test). The unrelated `spine_proofs`
database was not touched. The disposable database was dropped at the end.

## The earlier expected-ready harness is not recoverable

`fable_bed_expected_ready.db.js`, its fixtures and a `RUN_RECEIPT.log` do not
exist in either repository's full history (`git log --all --name-only` and a
`-S` content search over API and app), on this machine, or earlier in this
session. The only expected-readiness artifacts that exist are on the candidate
commit: `docs/handoffs/new-hp/EXPECTED_READY_SCOPE_20260911.md` and
`tests/proofs/availability_turn_date_scope.db.js`. A "35/35" report cannot be
matched to a harness, so it is **not** treated as evidence. What is reported
below was run here.

## Candidate proofs re-run independently (exact tested source)

| Proof (candidate file, run from each tree) | Baseline 24f4482 | Candidate 932c9af |
|---|---|---|
| `tests/unit/prospect_confirmation.test.js` (42 unit controls) | first red: `not 101` attached unit 101 | `PASS 42` |
| `tests/proofs/prospect_confirmation.db.js` (12 real agent/DB cases, scripted model) | 8 false confirmations: `not 101; 101 or 102?; is 101 available?; I do not want 101; yes, but not 101; is 101 available; 101 (space-bearing offer); yes (space-bearing offer)` | `PASS 12` |
| `tests/proofs/availability_turn_date_scope.db.js` (owned server per tree) | first red: `a sibling cannot inherit another bed expected-ready date` — actual `2026-10-01`, expected `null` | 14 domain assertions + 7 staff HTTP reconciliations passed |

Neither candidate proof is in `verify_all.sh` orchestration on 932c9af.

## Last green reference

`tests/e2e/tour_application_lease.e2e.js` on the baseline server: **151/151**
(`==== 151 full-path assertions passed; no real SMS sent ====`, exit 0), after
the three CI fixtures were applied to the owned database. Two earlier attempts
were harness-environment reds, not product reds: the server had been booted
without the CI environment (`send_mode_disabled` at the staff invite) and with
`APP_BASE_URL` on the wrong port (`fetch failed` on the join link).

## New harness

`tests/proofs/lead_to_lease_challenge.db.js` — Class 3, owned DB + owned HTTP,
scripted model. Sections run independently and every assertion is recorded,
so one run reports the whole matrix; exit is non-zero if any check failed.
It requires the Skyline-shaped fixture (the server allowlists that property)
and creates only nonce-named synthetic units, people and staff inside it.

Run (from the tree under test, with the owned server already up):

```
E2E_API_BASE=<owned server> E2E_SMS_LOG=<fake transport log> \
  node tests/proofs/lead_to_lease_challenge.db.js
```

The server was booted the way `tests/e2e/boot.sh` boots it (same allowlists,
`SMS_SEND_MODE=customer_care`, `APP_BASE_URL` pointing at the owned port).

**Not registered in `verify_all.sh`.** It is red today on findings 1–3 below
and would take CI red with it; registering it is QB's call once the rulings
land. Rung: **locally exercised** on both trees (real DB, real HTTP). No
browser rung, no provider rung.

## Results

| Tree | Checks | Exit |
|---|---|---|
| Baseline 24f4482 | 121 passed, 7 failed | 1 |
| Candidate 932c9af | 125 passed, 3 failed | 1 |

Per-check evidence, scrubbed of identifiers: `evidence.baseline.json`,
`evidence.candidate.json` beside this receipt.

The full journey went end to end on **both** trees: intake → scripted
matching → tour booked, checked in, captured as ready to apply → offer → Ask
Spine send proposal → agent confirmation → application text in the fake
transport → public terms acknowledgement → submission → approval → confirmed
terms → lease packet → resident signing → company execution → tenancy on the
exact bed at the acknowledged rent, with the sibling bed and the leased bed
both off the market afterwards.

### Findings (red on the tree named)

1. **Naming an occupied sibling bed re-aims the proposal at a different bed — both trees.**
   `Send <prospect> the application for Unit C7, Bed A.` (Bed A under a live
   lease, Bed B free with an offer) returns `application_send_proposed` with
   `target.label = "Unit C7, Bed B"`. `chooseTarget` in
   `src/leasing/staff_sms_action.js` finds no target matching "Bed A" and falls
   back to the only offerable target in the hinted unit (`only_exact_target`).
   The proposal shows the substituted label and still needs confirmation, but
   the operator asked for one bed and was offered another. The authority's own
   comment for `space_not_in_unit` says a caller aiming at the wrong bed "must
   learn that, not be redirected to a bed it did not name." Expected: a
   clarification or refusal naming Bed A; actual: a proposal for Bed B.

2. **A turn plan on the outgoing sibling still withdraws the free bed — candidate.**
   Bed A's lease ended, turnover in progress with `ready_date` +45d. Baseline:
   Bed B becomes `turnover_required`, `available_from` +45d, `expected`,
   with Bed A's turnover as provenance (the inheritance the candidate set out to
   fix). Candidate: Bed B no longer carries the date or the provenance
   (`available_from null`, `turnover null`) but is still `turnover_required`,
   `incomplete`, and the selector drops it. Before the turn was added the same
   bed was `marketable_now` / `confirmed` on both trees. The unit-scoped
   `turn_status` in `src/tenancy/space_position.js` still marks the sibling as
   turning even though the candidate scoped the date to the outgoing space.
   Whether a shared-apartment turn should hold the other bed is a product
   ruling; today the read says "turnover required" for a bed no turn names.

3. **Historical unit confirmation from a Matterport/negation/question — baseline only.**
   `I saw the Matterport of C7, I'll take C7` (space-bearing offers), `not C7,
   the other one`, `C7 or W1?`, `is W1 still available` all attach a unit on
   the baseline. All four are clarified (no attachment) on the candidate.
   Observation on the candidate: `W1 please` also attaches nothing (outside
   its explicit grammar); the baseline attached W1. Recorded, not asserted.

### Held on both trees (green)

- Wrong-property access: a manager session at another property gets 404 on
  the case, its selector and availability read show none of these homes, a
  client-supplied `property_id` changes nothing, Ask Spine at the other
  property cannot propose the send, the scoped confirmation is refused
  (`confirmation_property_mismatch`, `confirmation_actor_mismatch`), another
  property's approval is 403, another property's knowledge read is
  `not_established`.
- Occupied sibling: not marketable, never in the selector, offer refused
  `not_offerable`, still occupied after the sibling lease executes, and the
  bed just leased cannot be offered to the second prospect.
- Changed prices: replacement offer before acceptance → same link shows new
  terms and hash; old hash 409; form-supplied rent 400; unit `market_rent`
  change does not touch negotiated terms; refused submissions create no
  application; post-submission rent change 409; a prepared packet blocks a
  later revision.
- Uncertain readiness: expected date is `expected`, not confirmed, and
  `physical_readiness` stays `turning`; start before the expected date →
  `application_move_in_before_expected_ready`; notice date →
  `application_ready_date_not_governed`; turn with task deadlines and no
  ready date → `application_ready_date_not_governed`; at submission an
  extended outgoing lease refuses as no longer offerable, a slipped ready
  date refuses with the readiness sentence, no application is born, the link
  stays unconsumed, and the restored date lets the same link submit.
- Representative media: a Matterport fact that names a unit still answers
  `scope: property_wide`, `exact_home_association: NOT_ESTABLISHED`, with the
  representative caveat; an unrecorded floor plan is `not_established` with
  `missing_topics: ["floor_plans"]`; the follow-up rung wording says recorded
  tours "may show representative layouts" (source-level check).

### Observations for ruling (recorded green, not asserted)

- An offer and an application may be born on an **expected** ready date; the
  applicant-facing context (`/t/application/:token/context`) carries no
  readiness-confidence field, so the prospect cannot tell expected from
  confirmed.
- The tour records the apartment at unit grain only; the exact bed enters the
  durable record with the offer and the invitation, never from the tour.
- The public submit door returns the refusal sentence as `error`; stable codes
  (`APPLICATION_TERMS_TAMPERED`, target refusal codes) are not surfaced there.
- With the shared operator key present, the legacy `/leasing/leads/:id` door
  answers regardless of the session's property; without the key the session
  alone is refused.

## Deliberately unavailable here (not broken)

- Prospect-facing wording about media, prices or readiness: model output
  under the Anthropic sentinel → provider test, not run.
- Browser rung for the app at `b00cf49`: not run.
- Durable exact-bed selection from a prospect reply, prospective readiness
  planning, price binding at the prospect conversation: the candidate's own
  handoffs list these as not built; nothing here claims them.
- Production acceptance: nothing in this receipt is a statement about the
  deployed service.

## Commands (from the scratch runner; each proof spawned with the tree's own `server.js`)

```
node tests/e2e/proof_boundary.js create            # owned nonce DB
./tests/e2e/apply_migrations.sh                    # ceiling 194 / 182 rows
psql -f tests/e2e/property_fixture.sql; psql -f tests/e2e/fixtures.sql; node tests/e2e/instrument_fixture.js
# owned server per tree with boot.sh's environment, then:
E2E_DISPOSABLE_DATABASE=true node tests/e2e/tour_application_lease.e2e.js   # 151/151 on 24f4482
node tests/proofs/lead_to_lease_challenge.db.js     # 121/7 on 24f4482 · 125/3 on 932c9af
node tests/e2e/proof_boundary.js cleanup
```
