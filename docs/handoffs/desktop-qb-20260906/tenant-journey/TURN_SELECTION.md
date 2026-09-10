# Forward home selection and turn planning — 2026-09-08

## Intention and custody

The owner wants Spine to choose an appropriate exact home/bed from prospect needs,
future tenancy and feasible turn windows before application terms are sent, and
have the same facts guide maintenance. This is larger than terms lineage.
API inspected: 9f2acff97af311e6ebdcd5e2219f8cf873894748 plus existing dirty work;
paired app c05ae68. CURRENT_STATE then complete PHILOSOPHY read. No deployment,
provider action, actual-source confirmation or live application change.

## Existing mechanism and history

- `person_facts` and `prospect_capture` retain attributed preferences. Current
  keys are move_month, budget, unit_type, occupants, pets and reason; they are
  text, not a normalized hard/soft matching policy. Tour preferred_unit_id is
  preference only. High-floor matching is not established by those keys.
- `leasing_inventory.availableUnits` filters by requested contractual interval
  after a conservative legacy whole-unit filter. It sorts by asking rent/unit
  number and cannot promise physical availability. Its confirmation matcher
  matches the prospect's own choice; it is not an optimizing home selector.
- `intervalPropertyPositions` owns dated rights; `availabilityRead` owns
  operating readiness. `application_target_authority` owns exact target checks.
- `turn_priority` ranks existing active physical turns by canonical future lease
  commitments, with pending, locked and conflict distinct. Commit4b34775 removed
  application-status priority because an application holds no inventory.
- `turnover_service`, scope, work and readiness services already own maintenance.
  There is no established automatic preference-to-turn-plan composition.
  Root inspected `turnover_service.js:131-211`: the current start writer records
  a move_out event, attempts effective possession end, spawns the initial walk,
  and updates the vacancy cache. It must NOT be called merely to plan a future
  turn for an applicant. A prospective plan must preserve current possession;
  prove that boundary before extending this existing owner.

Forbidden second paths: no separate availability calculation in the UI/agent,
no copied applicant preferences, no new turn task store, no unsigned application
masquerading as a committed move-in, no invented NOI score or scheduling buffer.

## First observed red and bounded repair

Owned real Postgres proof `tests/proofs/application_turn_window.db.js` reproduced
an outgoing active lease covering the proposed dates while an early turn-ready
estimate made application targeting report offerable=true. The canonical interval
reader returned term_blocked on that exact space. Notice does not terminate rights.
First-red private run: spine-onboarding-proof-653ccccc737d485d879954c7b3787b3a.

Repair is a Class1 composition inside the existing target authority: physical
offerability AND the canonical exact-space interval must permit the dates. Known
offer end dates are passed at invitation creation, first submission, reacceptance
and the staff offer door. A turn estimate cannot release an outgoing lease.
Menu future targets use the same check on their advertised available-from day.
Per-call interval caching avoids repeating the same property/date read in a menu.
No new durable object or inventory reservation is introduced.

Owned successor spine-onboarding-proof-358df419be734ef88b2650bddd774aac passed seven
real-Postgres/service assertions: contradictory rights rejected in target/menu,
explicitly corrected outgoing term permits the same home, submission agrees,
move-in before readiness still refuses. Owned database and cluster data removed.
This is service/DB proof, not HTTP/browser/deployment of the new negative case.

The old future-target DB fixture assumed an early notice released a long active
lease; it now asserts refusal first and explicitly corrects the synthetic lease
end for its positive control. The legacy application E2E fixture now runs before
the main lease executes: its former placement after move-in tried to offer the
same occupied bed to another applicant. Existing submitted answers remain intact.

## Remaining work — do not call this an automatic selector

### Date-first conversation picker follow-up

`tests/unit/application_target_dates.test.js` first went red: a home ready Oct10
was still listed for a prospect asking to start Oct5. The legacy menu evaluated
each home's own ready date instead of the prospect's interval. Successor7 passes.
The existing leaseable-units route now accepts a validated start/end pair, uses
one cached full-term interval, and echoes selection_basis and the exact dates.
Undated callers retain a labelled discovery response; it is not a complete-term
promise. Existing physical/rights refusals still apply.

The **conversation** picker in index.html now asks dates before fetching homes,
keeps the exact selected dates in offer review, makes those dates read-only there,
and preserves them when going Back to recheck homes. Session adapter refuses a
response that did not echo the requested term. No new offer/turn writer exists.
Root also reproduced a stale-request DOM race (old request released the new
picker button) and fixed it with request-element identity; red/green DOM control.

Owned run spine-onboarding-proof-b01bd7ee653b438ea2d5541fcfef5e26 passed the extended
real Postgres/HTTP date controls and Chromium390x844 proof: actual conversation
picker/review functions fetched the real owned API and carried the same dates to
review and back. Test transport and host were supplied by the harness; **not full
app-shell navigation and no send**. Database/cluster cleanup complete. The later
small stale-request repair is covered by its DOM red/green test, not a rerun of
the owned API browser proof. Existing application target app28, offer review15,
offer review mobile DOM and inline44 script syntax checks pass.

**Important remaining UI seam:** followups-door.js `openSend`/`sendNow` still has
the older undated post-tour picker and direct composite send, without the complete
terms-review step. Source inspection only; do not claim all application entry
paths improved. Next falsification should enter that actual door and consolidate
onto the existing review rather than copy the conversation review into a second
implementation. Server terms/availability guards remain authoritative meanwhile.

- Full tenant journey passed163 at owned private run
  spine-onboarding-proof-44650ca5d1b74d98b1433d0b06861c56, including real mobile
  form/reacceptance/signatures and move-in/rent-roll assertions. Cleanup complete.
  Source governance50 then passed sequentially. The authenticated HTTP menu
  negative/positive extension passed11 total assertions at
  spine-onboarding-proof-7a1c6951e4864ef1bd973e53142655cd. Both feasible and
  contradictory target states reached the real operator route with a canonical
  staff session. This remains a synthetic fixture, not an actual-source proof.
- Menu without prospect dates is a discovery menu, not evidence that the whole
  intended term works. Carry known prospect/term context before ranking candidates.
- Prove the new refusal through the real staff offer door and browser, and include
  changed-date/read-failure/foreign-property/exact-sibling controls.
- Define selection from available governed preference facts and explicit policy;
  no arbitrary weighted score, assumed floor, turn duration, capacity or NOI.
- Prospective demand may guide planning as prospective demand. Retain separate
  commitment tiers and preserve maintenance's existing work/assignment authority.
- No claim of automatic turn creation, preference optimization, full forward NOI
  optimization or deployment. The immediate repair prevents an impossible handover.

## Shared application review checkpoint — 2026-09-08, local only

Inspected API 9f2acff97af311e6ebdcd5e2219f8cf873894748 and app c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88, with uncommitted changes (see SHARED_REVIEW_CODE_CUSTODY.json). Root owns integration; tour_handoff_gap independently inspected retry identity, no worker edits. Philosophy previously read in full, unchanged candidate. No deployment/provider action.

Operating question: after a successful tour, choose a home for the actual requested dates and review complete terms before sending. The existing conversation review was the owner; the post-tour door still used an undated picker/direct send. Smallest missing piece: extract that review into application-offer-review.js and mount it from both doors. Removed the duplicate conversation body and post-tour picker. Forbidden second path: a second terms, availability or turn writer. Existing canonical target read, offer action and composite send remain authoritative.

Falsification and successors:
- Actual post-tour controller DOM first red: date fields absent (0 versus1). Successor reaches the shared date-first picker, complete terms and exact composite send. Stub adapters, Chromium390x844; later successor also loads all actual index.html inline styles.
- Cancel while createApplicationOffer is pending first red: one send occurred after closing. Successor zero sends. Active controller cancellation and connected-host guard prevent dispatch from a closed review; an already-established draft is not erased.
- Back while offer preparation is pending first red: late response attempted to update a replaced review (null disabled TypeError). Successor checks current review-element identity and records no page errors or sends. No claim that an already-dispatched send can be cancelled.
- Both entry points reused a conversion-only send key after a changed offer: executable first reds. Successors retain identity for retry of the same offer and choose a new identity for a changed offer. Server intent/delivery reconciliation remains unchanged; no new server fingerprint enforcement claimed.

Owned evidence: spine-onboarding-proof-2295156e13c04af6a2f3032b473a0cba passed real Postgres/HTTP date controls and actual post-tour controller -> shared picker -> real canonical HTTP -> same dates in terms and Back, read-only synthetic navigation context. It did not create a tour, send, or navigate the full app shell. Owned DB dropped, cluster stopped and data removed. Earlier run 0efb7614ae9941eb813623f663abee77 timed out on button visibility, cleaned up; diagnostic rerun passed without a product change addressing that timeout. A separate DOM run also had a visibility timeout; do not call reliability settled from a successful rerun.

Commands/results: shared_application_review.test.js PASS; application_send_retry.test.js PASS both doors; application_offer_review_dom.test.js PASS zero/frozen retry; application_target_dates_dom.test.js PASS stale request; application_target_app.test.js30 PASS; application_offer_review_app.test.js15 PASS; node syntax checks and45 inline scripts PASS. Source-governance50 passed sequentially after owned proof, before the last conversation-only retry-key change (covered by its executable test). Full163 tenant journey remains the earlier API proof, not rerun on this UI extraction. No production claim.

Preserved boundaries (§§1,6–8,12,29,31–34,40–41): exact bed/date/offer identity reaches existing writer; zero remains zero; missing terms stay blank; stale reads/responses do not authorize a send; provider success remains required; no new inventory, price, turn or Ask truth store. Product component Class1; test fixtures Class3.

Next: investigate the visibility flake with the complete operator shell; prove real offer/write refusals for a changed future term through the integrated door. Then govern preference-based home ranking and prospective maintenance planning through existing canonical owners. Do not promote an unsigned application into a move-in commitment or call startTurn merely to plan a future turn. Automatic preference/NOI optimization and automatic future-turn creation remain unbuilt/unproven. Live legacy submitted application remains held for complete terms and lease review.

## Competing homes HTTP follow-up
See COMPETING_HOMES.md: real offer refusal/acceptance and maintenance priority reconciliation passed on owned Postgres/HTTP; separate actual picker browser read passed. No new product source or optimizer.

## Turn dates, not presumed vacancy — 2026-09-08

Local API9f2acff97af311e6ebdcd5e2219f8cf873894748/appc05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88 dirty. Philosophy unchanged hash977b30a4c41b0f8c1511da3521d030e031ab13b9d1897eea5970f011f487fc28, reread fully at preceding checkpoint. Root owns edits.

Question: can the agent see what is actually known about the turn before offering a home? Existing menu derived turn_gap_days from lease dates and UI called it a vacancy window. First-red DOM control showed 'Target2026-10-01 ·1-day vacancy window' for lease end2026-09-30, with no vacant-possession proof. Successor renders canonical outgoing lease-end and expected-ready dates instead. Removed dateGapDays and turn_gap_days from the menu adapter; it passes the existing turnover projection through. No new scheduling calculation, fields, writer or readiness meaning. Older app falls back to target date when the removed derived field is absent. New app ignores that field from an older API.

DOM tests preserve late-request ownership and prove changed-date responses produce no choices (already correctly implemented). Recorded-date labels have red/green. App target30, shared post-tour cancel/Back/send and frozen retry/zero DOM passed; API requested-date unit7 passed. Owned run spine-onboarding-proof-c6411c068a8f4a9398d9821b58320901 passed Postgres/HTTP offer competing-home/maintenance controls plus actual shared picker browser reads with labels checked against the known outgoing lease and expected readiness. Fixture explicitly links turnover.outgoing_lease_id so the date is evidence-linked. Owned DB/cluster cleanup complete. Source governance50 passed afterward, sequentially. No deployment/provider actions. Full-shell visibility reliability remains unproven.

Next pre-build: worker located existing prospectVitals in operator.js, used by both conversation detail and Person Card. Root inspection confirms property-scoped active person_attributes overlay lead move-month fallback. It currently catches EVERY attribute-read failure and silently returns fallback/nulls, and exposes values without source/claim-strength metadata. Do not build a recommendation on that apparent healthy silence. First falsify failure/unknown separation and preserve attribution through this existing reader before showing needs in shared review. PersonCard and conversation should consume that same reader, no copied preference store. No governed floor attribute or high-floor matching policy found. Text preferences must not silently become exact dates, hard filters or verified terms. Ask does not currently consume prospectVitals; domain-completion/Ask coverage must stay explicit.

## Prospect-needs failure boundary repaired
See PROSPECT_VITALS_FAILURE.md: existing reader now refuses lookup failure; real conversation/Card reconciliation and recovery passed, followed by51 source gates. Next is carrying attributed existing needs into shared selection.
