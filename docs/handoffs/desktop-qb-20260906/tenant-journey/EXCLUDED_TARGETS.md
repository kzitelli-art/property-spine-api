# Excluded application homes — New HP checkpoint

2026-09-09. Inspected API base 9f2acff97af311e6ebdcd5e2219f8cf873894748 and app base c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88, with existing working changes. CURRENT_STATE and complete PHILOSOPHY read. Final committed custody is in docs/handoffs/new-hp/CHECKPOINT.md.

Intent: an operator choosing a home for requested dates must see why other exact homes cannot be offered. Existing availability and application target authority already decide the dated verdict. The target menu discarded non-offerable rows; the shared component never received their explanations. This is a Class 1 read/UI repair, not a new matcher, writer, table, workflow or eligibility rule. History: abcb28e introduced the unified application/lease rail; subsequent local term checks remain in the existing authority. Forbidden second path: browser eligibility or independent availability/rights logic.

## First red and successor

- Unit: node tests/unit/application_target_dates.test.js failed on missing excluded_targets, then passed 15 assertions after repair.
- Owned DB first red c5b4774b09a14f65bd6ce9b7e69ef31f: existing application_turn_window proof established contractual refusal, then failed accessing the missing excluded collection. Owned database dropped and cluster data removed.
- Owned successor bd4749d0733543f4a51f3bb59a9fc57b: application_turn_window DB + authenticated leaseable-units HTTP + actual post-tour controller/shared picker Chromium path passed. Exact rejected rows preserve refusal vocabulary, expected date/confidence and no actionable target; existing offer HTTP controls preserved rights, unknown readiness, scope, retry and unchanged maintenance commitment priority. Owned database dropped and cluster data removed.
- Browser component first red: application_excluded_targets.browser.test.js showed only generic no-homes message. Successor shows exact unit/bed labels, canonical reasons and expected dates, escapes markup, and has zero target buttons/write calls for excluded homes.
- Adjacent browser checks application_target_dates_dom.test.js and application_offer_review_dom.test.js passed; inline_js_syntax.test.js parsed 45 script blocks.

Reproduction uses existing tests/e2e/onboarding_review_local.ps1 with PROOF_FOCUSED_NAME=application_turn_window and ONBOARDING_SPACE_PROOF_ONLY=1, explicit AppRoot, private JulySource/SkylineSource paths, PostgresBin and Chrome. Clear tenant-journey/phone flags. The wrapper owns the disposable DB and provider fences. The required pending claim index remains owned-proof-only, not production migration authority.

The API now returns excluded_targets separately from eligible_targets and unsupported_multi_space_units. Canonical REFUSAL_TEXT supplies operator wording; original exact identity, readiness confidence and turnover context are retained. Excluded rows have offerable:false and no resolved_space_id. Eligible membership is unchanged. The shared picker renders exclusions as text, not selectable buttons. Existing rolling-deploy unsupported-shape compatibility is preserved.

## Limits

Fable's external contract was reviewed, not independently run verbatim. Root reproduced the defect using the existing owned proof above. These are local service/HTTP and controller/component browser proofs, not full-shell navigation, provider delivery or deployment. No recommendation/ranking, prospect budget filtering, floor fact owner, future-turn creation, Ask matching composition or complete leasing optimization is established by this change. Earlier phone journey evidence remains in PHONE_TERMS.md; it was not rerun by this focused repair.

Final sequential verification: all 54 source-governance gates passed after the owned runtime stopped. No product changes after that check.
