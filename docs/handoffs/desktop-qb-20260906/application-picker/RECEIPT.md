# Application picker extension — QB pre-build receipt

Inspected API59bb82b and appa2dac2b; current state then full philosophy reread.
Intention: after an actual captured tour, authorized Leasing staff can open the
existing application target picker and see only the exact homes that may be
offered, with occupied retained claims excluded and vacancy controls present.

Existing mechanism: canonical intake -> walk-in/completeTour -> conversion and
follow-up -> leasing_desk -> followups-door openSend -> leaseableUnits. The
conversation shortcut lacks a conversion in its read, but the post-tour and
Leasing Work routes already carry that durable relationship. That is source
inspection, not a browser failure. Do not add a conversion lookup by guessed
person or arbitrary historical row merely to make that shortcut appear.

Current last green: occupied-claim HTTP18 and Availability/Rent Roll browser
on59bb82b/a2dac2b. Picker browser was unclaimed. New work is Class3 proof
infrastructure only until an actual failure identifies a product correction.
Root owns browser/runner; worker owns optional canonical fixture only.

The fixture uses existing synthetic301 Room2 as vacancy control and303 Room2
as withheld claim. Intake credential and application capability are scoped to
one preallocated disposable property; consent uses the canonical QA service.
No new inventory or property-specific product branch. No application is sent.
Browser compares exact server-space identities and watches for send requests.

Forbidden second path: browser-created conversion state, alternate availability
classification, duplicate intake writer or a fixture fallback in signed-in UI.
Run remains pending. Exact code custody and first actual stop will be recorded.

First owned run:23 assertions passed and1 failed; intake, QA consent and walk-in
conversion were HTTP/service green. The desk returned200 with no matching visible
row. Current loader intentionally hides internal_qa by default. Successor proof
configuration enables the existing LEASING_DESK_SHOW_INTERNAL_QA setting in this
owned server only. This is a Class2 visibility bridge already in product, not a
new filter or production configuration change; remove its proof dependency when
the existing bridge is retired and its successor QA visibility owner is chosen.
Root also adopted independent review's explicit target property equality and
rendered action key/label assertions. Successor run is frozen and underway.

Second run also23/1, after QA visibility. This falsified visibility as the whole
explanation. Source review at completeTour/createConversionFromTour showed the
fixture omitted feedback.next_move: a standing of ready_to_apply does not author
an instruction to send an application. Real capture sends C.nextMove separately.
Root corrected the fixture to record explicit next_move=send_application and
added scrubbed desk diagnostics. No product edit. Third run frozen and underway.

Third run:24/24 setup/service/HTTP assertions and the actual browser picker
passed. Root visually inspected its exact301 Room2,304 Room1,305 Room1 choices;
303 Room2 was absent. Cleanup succeeded, but global containment correctly failed:
one locally refused model attempt at canonical phone intake, SMS0 and egress0.
Current intake deliberately drafts even when attempt_sms=false. That flag governs
transport, not authorship. No provider call escaped the fake Anthropic sentinel.

Fourth successor separates this focused synthetic-intake contract explicitly:
exactly one locally refused intake model attempt, no additional browser/model
attempts, SMS0 and egress0. Full workbook rehearsal retains its zero-model-call
contract. Runner rejects picker mode without focused availability proof and claim
browser flags. No logs are reset after intake or hidden from the final checks.

## Accepted focused successor

25 assertions passed, including canonical intake, canonical QA enrollment,
walk-in capture/conversion, authored next move, Leasing Work row and unchanged
applications/leases. Browser clicked the real Follow Ups card, verified the
server row and rendered action key/label, opened the picker, compared all exact
space identities with the property-scoped target response, saw301 Room2 while
303 Room2 remained absent, and cancelled. Root inspected the screenshot.
No send request. No new product code, writer, lookup or alternative workflow.

Containment: exactly one locally refused model draft at canonical phone intake;
no later model attempt, SMS0, egress0. Owned database dropped, server stopped and
data removed. No real source confirmation or deployment. The earlier full
July/Skyline nine-phase result stands on59bb82b/a2dac2b; this successor adds a
focused proof and was not a fresh full-workbook rerun. Conversation shortcut
remains source-reviewed only; application dispatch is not claimed.

Run: onboarding_review_local.ps1 with ONBOARDING_SPACE_PROOF_ONLY=1,
PROOF_FOCUSED_NAME=availability_uncorroborated_claim, PROOF_CLAIM_BROWSER=1,
PROOF_PICKER_BROWSER=1 and both defect flags0. The wrapper received the retained
private workbooks and local PostgreSQL17/Chrome binaries. Tested executable
hashes and scrubbed browser receipt are adjacent. No runtime identifiers retained.
All50 source-governance gates exited0, including CURRENT_STATE8. App proof commit c05ae68 pushed; API CI to be recorded in root QB board after commit.
