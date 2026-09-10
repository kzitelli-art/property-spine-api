# Tenant journey — local review, 2026-09-08

Latest local turn-selection follow-up: see TURN_SELECTION.md and
DATE_PICKER_CODE_CUSTODY.json. Conversation picker now checks the requested full
term before offering homes and carries the same dates into review. Owned HTTP and
actual picker-function Chromium proof passed; stale-request DOM red/green passed;
source gates50 then passed sequentially. Post-tour followups-door.js remains an
older entry path requiring consolidation; no automatic optimizer/deployment claim.

Latest September 8 update: terms-first, successor, legacy and Ask review passed 163 full-path
assertions through owned Postgres/HTTP/mobile Chromium, plus all 50 source gates.
The same application retains prior acknowledgements and requires fresh acceptance
before revised terms reach its lease. Submitted applications missing an offer can
now review their first terms through the same link. Staff form DOM checks also
cover initially null offers, unknown versus zero and explicit fee choices.
Ask now reads the same accepted/pending terms and refuses silent selection among
multiple applications. Final source checks and journey ran sequentially because
the source falsification suite temporarily mutates files. No new live send or
deployment. The live
legacy application remains untouched and lease held. See TERMS_FIRST.md and
TERMS_FIRST_CODE_CUSTODY.json for current evidence and remaining limits. Earlier
pending-sign-in/tour notes below are historical; QB_OPERATING_BOARD governs the
current completed live trial actions and prevents repeating them.

Owner question: can a prospective tenant move through the existing lead, conversation, tour, outcome, application, lease, move-in and rent-roll path? Improve that path; do not rebuild it.

Inspected API 9f2acff97af311e6ebdcd5e2219f8cf873894748 and paired app c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88. Root read CURRENT_STATE and complete PHILOSOPHY. Existing changes in other proof files remain preserved.

## Existing owners and evidence recovered

Canonical intake and tour booking/outcome remain in leasing_leads.js. The existing SMS prospect conversation enters agent.processInbound through communications/inbound-sms. Application context and submission remain in application_submission.js; lease generation, source retention, signer fields and submission remain in lease_packets.js and tenant_lease_packet.html. Company execution creates the existing tenancy anchor. Move-in uses economic_tenancy_service.js, movein.js, existing payments/application writers, readiness obligations and the existing possession writer. Rent roll reads datedPropertyPositions.

CURRENT_STATE rows 23, 29 and 37 already record the exact-bed application-to-tenancy journey. Skyline's retained original DOCX hash matches the OneDrive original; a separate Repaired file does not invalidate that prior source decision. These historical deployment claims are not a fresh production inspection. No lease master was replaced.

## Fresh evidence

### Owner-authorized restart and application delivery,18:33 UTC

Owner explicitly accepted the proposed close-and-simulated-tour action. Existing
staff-session resolve released the prior conversion with no_longer_needed and
test-restart provenance. Historical application and lease preserved. Existing
walk-in service captured a clearly labelled simulated outcome on the current lead,
same Person/property, and opened a fresh conversion. No physical tour asserted.
The canonical current availability read selected Demo Unit227, a whole-unit
position; this is NOT a by-bed Temple lease proof. Existing send-application
command returned200 and advanced follow-up only after dispatch. Text explicitly
labels internal TEST and requests sample details. Twilio independently returned
delivered/error_code=null; actual token-bound context returned200/open/unit227.
No submitted application yet, no lease generated or sent. All identifiers/tokens
and provider receipt remain private. This supersedes the earlier restart blocker.

### Bounded live first-text trial, after explicit owner authorization

The owner supplied his phone for the previously requested controlled live trial,
then identified propertyspine.com and the original Demo Building as the prior
working entry. Live health identifies d55dae9, not the local candidate above.
The public page still calls /demo/intake; that route returned403 with the explicit
receipt that the live demo is not enabled. Render configuration read confirmed
DEMO_MODE=false. Reenabling it also invokes a startup source-data routine, so no
configuration was changed under this phone-only authorization.

The existing Demo Person/property relationship was classified internal_qa using
communications_boundary.enrollInternalQa (unchanged between live and candidate).
Prior classification was superseded, not erased. Reason records the owner's
authorization and QB task; actor_user_id remains unknown/null rather than inventing
an authenticated staff identity. Existing opted-in consent was verified beforehand.
The existing entitled /leasing/intake accepted one synthetic inquiry with HTTP200,
reused the Person and opened a new opportunity after the prior lost opportunity.
No new web-consent signal was submitted: its activation writer would reclassify
the synthetic trial as production. Post-read confirmed internal_qa remained.

The intake returned first_response_sent=true. A separate read of the exact Twilio
message reported delivered, error_code=null. This is carrier delivery evidence,
not merely the intake's sent claim. Canonical comm_events.provider_status was still
null on that read: carrier-status reflection remains an observed gap. Private
message IDs, phone, DB rows and the once-only receipt remain outside Git.
The read helper initially selected the wrong timestamp field; corrected to the
schema's occurred_at. Provider lookup uses canonical sms_sid. No resend occurred.

Subsequent live read confirmed inbound replies and carrier-delivered AI responses.
The owner's request for3pm arrived, but there were zero future open tour slots,
no tour for the new lead, and no takeover-queue row for it. The reply promised
human follow-up without evidence of a corresponding scheduling handoff. A generic
agent-review obligation is not proof that this handoff was recorded.

The owner then requested application delivery and supplied the normal staff OTP.
Canonical authentication succeeded; canonical property selection switched from
the login-selected Skyline scope to entitled Demo scope. No identity or access
was minted outside those owners. Ask's application-send request refused because
no eligible post-tour application follow-up was assigned to this actor.
Fresh read-only verification found exactly one historical conversion for this
Person/property, created July17 with an active application and an unassigned
tour_followup. It belongs to the prior lead, not this trial. Thus merely picking
up that task cannot make a fresh application valid: recordApplicationIntent
independently refuses its nonterminal application. No old invitation is reusable
(consumed/revoked). No history was cleared and no completed tour was fabricated.

Application/lease delivery remains blocked on a valid application-bearing case;
staff sign-in itself is now proven. Local118 assertions below remain a separate
proof rung. No production deployment, source replacement, lease execution or
move-in was performed. Scheduled checks must not retry sends against the old case.

- Unchanged existing tour_application_lease.e2e.js passed 106 assertions against a fresh real migrated PostgreSQL database and actual server.
- The same test extended to actual 390px tenant application, guarantor and resident signing pages, then move-in, passed 118 assertions before the display repair below.
- Browser application submission persisted the same conversion, unit and exact Bed B. Both signer pages wrote and submitted through real HTTP endpoints. Cross-signer and unauthorized-company refusals stayed intact.
- The same executed lease continued through confirmed first rent/deposit, manual synthetic payments and applications, economic activation, readiness approval, access preparation and key handover. Repeated key handover was idempotent. Canonical rent roll named the exact lease, original lead person and bed, with trusted rent 1025 counted once.
- Signing alone did not establish active tenancy or possession. Activation refused missing applied funds; keys refused incomplete readiness. Payment claims were not presented as bank-proven cash.
- Every completed runtime stopped its server, dropped its owned database and removed its owned cluster data. External egress was zero. Private runtime identifiers, tokens, logs and screenshots remain outside Git.

## Smallest product repair

Follow-up correction from the live no-slot observation: agent.js's existing
bookingUsable/empty-slot instruction no longer orders a human follow-up promise.
It says no open times are available, requested time is not booked, and no staff
follow-up may be promised unless a durable handoff was recorded. QB rejected an
extra helper/export and wording-mirroring test; final change stays in the existing
branch. Unknown timezone and nonempty-slot branches remain intact. Syntax check
passed. Existing postGenerationPolicy still accepts the original bad sentence,
so this is only a local prompt correction: no deterministic output enforcement,
handoff implementation, model-behavior proof or deployment is claimed.

The rendered application showed an empty Target date row when invitation context had no established target date. The existing grid CSS overrode native hidden display. Browser assertion failed before repair (`true !== false` for visibility), then passed after one scoped `.target-row[hidden]{display:none}` rule. Known target date remains visible and applicant edits survive reload. No date, form schema, writer, provider or identity meaning changed. This preserves unknowns and follows the existing UI owner (PHILOSOPHY sections 4–6, 29, 33).

Application render checks passed 24/24 and all 50 source-governance gates passed after the repair. The final repaired full journey passed 118/118, including all three browser submissions, the hidden unknown-date check and the same exact-person/lease/bed rent-roll assertions. Wrapper exited zero after database drop, server stop and owned cluster data removal. See tested-custody.json for final file hashes.

## Test infrastructure and limits

Class 3 test infrastructure: Windows owned runner gains a separate synthetic tenant-journey mode, reusing the existing CI fixtures, migrations, boundary, fake transports and full journey. It returns through the same cleanup. Workbook rehearsal retains its unchanged zero-call contract. New browser/move-in helpers extend the existing journey, not product routes or data owners. These opt-in extensions are not yet added to the full CI command.

Two initial browser harness mistakes were corrected: click the visible radio label, and wait for the existing Done state rather than disappearance of its button. Neither was a product defect.

A later rerun timed out on the initial Start application click. No successful click or submission was claimed for that run. The helper now waits for the existing initialized opening screen before acting and retains a private screenshot on failure. The next complete run passed. The precise cause of the timeout was not established; one successor run does not prove absence of intermittent desktop timing issues.

Reproduction on this desktop: work/application-content/run-tenant-journey.ps1 invokes the existing onboarding_review_local.ps1 wrapper with PROOF_TENANT_JOURNEY=1, PROOF_TENANT_BROWSER=1, PROOF_TENANT_MOVE_IN=1, using a newly initialized owned local cluster. The default existing journey still uses a future lease start; the move-in extension uses today's synthetic lease start so it does not rewrite signed dates or bypass commencement checks. No clock or production row is altered.

This is real local DB/HTTP and tenant browser proof, not deployment or a personal live SMS test. All model generations were locally refused; deterministic Ask reads and workflow behavior do not prove AI conversation quality. SMS was captured locally; payments and the retained governing document were synthetic. Actual Greenery master selection, live provider behavior and legal sufficiency are not established by this test. No production/provider action, real application dispatch, actual-source confirmation, merge or deployment occurred.

Shared review follow-up: see SHARED_REVIEW.md and SHARED_REVIEW_CODE_CUSTODY.json. Both application entry points now reuse the same date-first complete-terms review; local evidence and remaining limits are recorded there.

Competing-home and turn-priority follow-up: COMPETING_HOMES.md records owned real HTTP checks and cleanup; no production actions.

Turn-date label repair: TURN_DATE_LABELS.md; red/green DOM and owned HTTP/browser/maintenance checks passed, then source gates50. No production action.

Prospect-needs lookup boundary: PROSPECT_VITALS_FAILURE.md records unit red/green, owned HTTP failure/recovery and51 source gates. No production actions.
