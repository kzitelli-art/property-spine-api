# Real website inquiry is not permission to text — September 11

Baseline `f72b81a1b426ff6caeb8e0f030a883ccc9f2b7c8`; isolated `codex/real-intake-classification-20260911`. Scope: existing authenticated intake classification only. No new endpoint, schema, site/relay change, or provider action.

## Intent → existing mechanism → observed stop

Skyline's live Squarespace contact form collects name, email, phone and graduation year, with no observed SMS-consent field. The owner wants real leads entering Spine for staff handling now, with no fabricated consent or autonomous send. Public-page/source ingress map is in workspace `handoffs/new-hp/SKYLINE_WEBSITE_INGRESS_20260911.md`.

`POST /leasing/intake` already validates a secret and its property allowlist before calling private `intakeProspect`. The service owns person, open lead, source touch, lead event and conversation. Existing prospect activation requires both property activation and positive consent before writing production classification/opt-in. Its birth guard otherwise fills missing classification with `internal_qa`; it intentionally never overwrites an existing classification there. This protected the historical demo/QA perimeter but misclassified a new real non-consenting inquiry.

Owned full-server HTTP first red: missing consent and false consent both became internal_qa despite successful authenticated, activated property intake; 12/14 original controls passed. The staff conversation itself was visible, but the production classification was wrong and QA exclusion could suppress real demand in downstream metrics. Do not overstate the bug as all staff reads hiding the lead.

## Smallest correction

Only the authenticated route passes a server-only options argument `authenticatedRealIntake:true` to the existing private service. A body field cannot grant this authority. For an absent classification, authenticated source plus activated property creates production through existing `commBoundary.reclassify`, with reason `authenticated_property_bound_intake`, actor null (service source, not an invented staff person).

This branch does not create an opt-in record. Actual positive-consent behavior remains unchanged. Unactivated intake still defaults internal_qa. Existing deliberate classification is not overwritten by consent-free intake. Public/demo service calls retain their old provenance/default. The captured source touch and classification reason retain why this birth was admitted.

`attempt_sms:false` still prepares the existing AI opening response but does not invoke transport or claim delivery. It does not mean zero outbound-shaped comm_event records: those retain the prepared draft; `ai_response_prepared` distinguishes it from sent. No caller may mistake that draft for provider delivery.

## Fresh evidence

- `tests/proofs/real_intake_classification.db.js`: 18/18 real HTTP/Postgres checks. Missing/false consent creates production without opted_in; true consent positive control; unactivated-but-intake-authorized property remains QA despite forged body flags; anonymous401, unbound-property403, disabled-demo403; opted_out survives consent-free repeat; prior explicit QA decision survives; real nonconsenting inquiry appears in the scoped staff conversation read; zero fake transport sends with attempt_sms:false.
- Run requires owned Skyline E2E property in both `LEASING_INTAKE_PROPERTY_IDS` and `PROSPECT_ACTIVATION_PROPERTY_IDS`, a second owned property in the intake list but not activation list, supplied to the proof as `E2E_INTAKE_INACTIVE_PROPERTY_ID`; server's intake secret is the ordinary proof value `e2e-intake`. Standard proof-boundary/fake SMS/Anthropic fencing. CI registration added in the isolated successor described below; remote execution remains unclaimed.
- PostgreSQL17 on loopback55441; database `spine_proof_c95b4c60545c70477e10fc2e`, nonce `577a8c6cc755af6f85c41d085f35680e`; real migration chain194 /182 entries. Migration SQL/preconditions ran sequentially through pg; standard psql fixtures used their required psql metacommands. Server3341 used the existing boot environment via local Windows adapter.
- Logs outside Git: workspace `tmp/real-intake-first-red.log`, `real-intake-final.log`, `real-intake-gates.log`.
- All56 configured source-governance gates pass (parent0); diff check passes. Cleanup verified: nonce checked before stopping owned HTTP listener; owned database dropped by proof_boundary; lane's PostgreSQL cluster stopped.

## Retry finding, not silently fixed

Re-delivery with the same source_lead_id reuses the same person and open opportunity but appends another touch: observed count2. This path stores source_lead_id; it does not make it an exactly-once key. Do not collapse real repeated inquiries by guessed phone/time/content. Inspect the actual Squarespace Storage integration payload for a stable provider submission identity and retry semantics before adding bounded delivery idempotency within this owner.

## Remaining launch prerequisites

Squarespace admin/form Storage access, actual source relay mapping, canonical Skyline config/activation, and first real operator-visible receipt are separate. No fake live lead or real message was sent. No browser, provider or deployed proof is claimed. Deliberate existing QA classifications require explicit governed review, not silent migration by a new web submission.

Suggested CURRENT_STATE entry for QB: real nonconsenting activated website intake first red reproduced through authenticated HTTP; existing birth guard now distinguishes server-authenticated real source from text opt-in.18 controls pass; existing QA decisions, unactivated/demo/property walls and opted_out preserved. No new endpoint/schema/site connection. Stable-ID delivery retry remains open pending actual source payload.

## CI registration successor

Product source remains exactly `77e22b2d81bdf6c9e0382722f1f5c2bc7cd3ba06`. Existing `.github/workflows/verify.yml` invokes `tests/e2e/verify_all.sh`; the runner now creates `Real Intake Inactive E2E` using `tests/e2e/real_intake_fixture.sql` and boots a separate final server phase. Both fixture properties are intake-authorized; only Skyline E2E is prospect-activated. Earlier QA/historical phases retain their prior activation configuration. The same required 18-check HTTP proof runs through the runner's ordinary failing `step` and owned-server cleanup, without a skip/pass fallback.

Fresh local registration-contract proof: all 18 checks pass on PostgreSQL17 loopback55441 / HTTP3341, database `spine_proof_d81958d8a0f53c5bd16f5812`, nonce `464e6b4688eabd1fed6d8ce2847c2cf3`, migrated through194 (182 migration entries). The new SQL fixture and boot environment values were exercised against the real server using the Windows adapter. The Linux Bash parent and remote GitHub workflow were not run here; this is registration plus owned real HTTP execution, not a claim of green remote CI. Logs: workspace `tmp/real-intake-ci-proof.log` and `tmp/real-intake-ci-gates.log`. Nonce-verified HTTP shutdown, boundary-owned database deletion and lane PostgreSQL shutdown completed.
All 56 configured source-governance gates passed again (parent exit 0). No source files changed in this registration successor.
