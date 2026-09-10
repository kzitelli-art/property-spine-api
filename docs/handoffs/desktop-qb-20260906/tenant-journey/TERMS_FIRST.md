# Application terms before applicant work

Owner ruling, 2026-09-08: show the terms first so everyone agrees what the
applicant is applying for, and carry those terms into the lease. This supersedes
the old application copy that defers commercial terms until lease preparation.

Inspected API9f2acff with recorded local changes, appc05ae68. Live trial d55dae9.
CURRENT_STATE and complete PHILOSOPHY were read. Pre-build reasoning is retained
below; the implementation receipt at the end records current evidence and limits.
No deployment has occurred.

## Intention and observed stop

The tenant first sees the exact unit/bed, rent, deposit, start/end dates,
applicable recurring and one-time fees, and concessions. Unknown is not zero.
The tenant explicitly acknowledges that version before entering/submitting their
personal application. A changed commercial proposal is shown as a change and
requires a new acknowledgement. Application approval is still a separate decision;
acknowledging terms does not approve credit, reserve inventory, or execute a lease.

The actual test application was carrier-delivered and submitted. The authenticated
review then returned null rent, deposit, start and end; concessions were unknown.
Invitation context has only target/date/person prefill. The first screen explicitly
says final terms come later. This is the first observed red and contradicts the
owner's newly explicit order. Lease generation/send is held; no values backfilled.

## Existing owners to preserve

- `effective_pricing.resolveSpaceEconomics` supplies exact-position rent and
  pricing-version authority. It must not be replaced with units.market_rent or
  a sibling bed's price. Its transitional deposit/fee facts may be text, so
  their presence is not evidence of a structured payable amount or cadence.
- `governed_charges` and the application/admin-fee decision owners govern native
  fees; their cutover state must be respected. A stale agent fact must not
  override an activated governed charge.
- `commitment_ledger.createLeaseOffer` already stores pre-application offers,
  exact or scoped targets, terms snapshots, pricing authority and communication
  evidence. Its present snapshot covers rent, term months and concessions;
  it does not yet contain all the application terms above. Its current sources
  are concession-oriented; ordinary offers without a concession policy need an
  explicit authority treatment, not a fabricated discretionary grant.
- `application_submission` owns invitation send, token-bound context and atomic
  submission. It currently has no commercial-offer binding or acknowledgement.
  Public submission currently takes rent/deposit from the request; that must not
  become authority for accepted commercial terms.
- `proposed_terms_service` owns management confirmation with supersession and
  immutable normalized economics. Its current window is lease_ready after
  approval, and its concession writer supports none only. Keep approval meaning.
- Lease packet/execution already retain and check confirmation lineage. Fees
  currently come from property configuration separately; those must not drift
  from what was presented to the applicant.

Historical Slice8 documents explain missing pricing lineage, but they are not
current schema authority: migration122 ALREADY adds pricing_version_id to
application_proposed_terms_confirmations and executed_lease_records. Reuse those
columns; do not add duplicates based on the old audit.

## Smallest coherent extension and forbidden second path

Extend the existing offer fact to retain the complete structured commercial
proposal and its source references. Bind invitation, applicant acknowledgement,
application, management confirmation and packet to that version. Resolve fees
and concessions through their existing owners before presenting a complete offer.
Reuse existing staff authority and communications. Preserve draft, dispatched,
acknowledged, approved and executed as separate events.

Do not add browser-owned pricing, a second quote store, applicant-supplied rent
authority, early fake approval, a second application, a shadow lease generator,
or a generic fallback that presents missing fees/concessions as none.

## Acceptance checks required before release

1. Missing rent/deposit/dates or unresolved applicable charges prevents a new
   terms-bearing invitation from being sent, with an actionable operator read.
2. Mobile first screen and final review show the same exact target and commercial
   version, including explicit zero, recurring cadence and one-time amounts.
3. Tampered body economics or another person's/property's offer cannot alter
   the application. Tenant acknowledgement binds the server-held version.
4. Offer changes while the form is open require renewed review; refusal leaves
   the invitation unconsumed and preserves the applicant's draft.
5. Retrying an unchanged submission returns the original application, with one
   acknowledgement and no second message or application.
6. Management confirmation and lease generation preserve the acknowledged terms;
   an intentional change has a visible successor and renewed applicant review.
7. Fee-policy changes after acknowledgement do not silently change the packet.
8. Exact bed identity, approval entitlement, concessions, source retention,
   lease execution and move-in invariants remain independently enforced.

## Implemented and verified locally, September 8

Existing lease_offers holds one immutable application proposal, authored by
server-resolved staff authority with exact Person/property/space. Migration193
adds the invitation/application/confirmation/packet relationships and immutable
offer terms protection. Stable hashing survives JSONB ordering; explicit zero,
fees and no-concessions choices remain distinct from missing information.
Active governed charges cannot be omitted/contradicted; unrepresentable charge
scope/cadence/conditions and structured concessions refuse with reasons.
Generic concession qualify/lock/read paths refuse application proposals.

The existing staff send picker now prepares terms before dispatch. Retrying a
failed dispatch freezes the reviewed fields and reuses the same offer. Tenant
mobile terms review and acknowledgement precede personal questions. Submission
uses the server offer, persists acknowledgement and refuses missing/stale hashes
or supplied conflicting money. Management confirmation and packet generation
require the same accepted offer. Signed packet fees come from that offer rather
than mutable configuration. The scoped application detail read exposes the offer.

Command: `work/application-content/run-tenant-journey.ps1` from the workspace.
Final result: **134 full-path assertions passed**, real owned Postgres migration
chain through193, HTTP and Chromium mobile form/signing. The same synthetic Bed B
retained1025 through application, lease, activation, key handover and rent roll.
Tenant/guarantor token isolation, staff approval/signing entitlements, no duplicate
send, payment/readiness/possession separation and original Person lineage passed.
SMS was locally captured; model calls were refused by the sentinel. This is not
live AI quality, real delivery, actual-source onboarding or deployment proof.
Owned database dropped and cluster data removed; private evidence retained.

First reds retained in private run receipts: unbridged fixture manager refused403
(preserved as negative, explicit synthetic bridge added); PG date comparison at
submission; old browser button selector; PG date comparison at packet confirmation;
incorrect test fee snapshot path. Successor tests retain the independent guards.
Operator mobile DOM proof executes the actual review function with stubbed adapters:
zero values, missing concession acknowledgement, freeze after preparation, retry
without duplicate offer all passed. Focused tests: offer helper, five lease-lineage
cases, nine packet source contracts, scoped review, ledger source gate; existing
page render24 and future-target8 passed. Legacy application_submission.test.js
does not pass: its stale module wiring lacks conversion closure authority; it is
not counted as acceptance. Do not run that legacy test against a live database.

## Successor review verified after the134 baseline

**Final successor run:145 full-path assertions passed, September8:** existing
offer preparation now records a predecessor relationship, and the same invitation
points to replacement terms. The application keeps its prior acknowledgement
until the token holder accepts the successor through the existing submit door.
An append-only application_terms_acknowledgements relation records acceptance
history without copying economics. This is a Class1 acceptance fact, not a second
quote store. Packet existence prohibits this revision path; lease confirmation
and generation require a current acknowledged offer. The existing application
detail exposes pending review and provides the revision action. No application
birth, approval, provider send or new lease is implied by proposing a change.
Owned Postgres/HTTP/Chromium tests changed rent while the mobile form was open,
preserved personal answers, required fresh review, then revised again after
submission and accepted through the same token/application. The original
acknowledgement remained byte-identical; a direct rewrite was refused by Postgres.
Old-hash acceptance, duplicate acceptance and revision after packet creation were
tested. Re-acceptance kept approval status/captured answers and created no second
application. The final accepted1025 continued through signatures, move-in and
rent roll. SMS/model fences and owned cleanup remained intact. All50 source-
governance gates passed. This extends §§6,29,33 with executable history/identity
and stale-acceptance checks. App revision UI has a mobile DOM behavior proof with
stubbed adapters: nested pending offer, zero, exact target and retry predecessor.

The first successor runtime caught an INSERT parameter-number error in the helper;
corrected before the141 and final145 successor successes. Focused mocks were not
sufficient to prove SQL correctness. Source fingerprints are in
TERMS_FIRST_CODE_CUSTODY.json. No product files were edited after the final run
except the scoped app DOM fixes, which have their own separate proof rung.

## Remaining release limits

### Application terms in Ask — 163-check local successor

Question: what are this person's application terms, and which terms have they
actually acknowledged? The existing leasing standing reader already selects the
property-scoped person's latest application. The canonical proposed-terms owner
already returns historical accepted terms and the invitation-linked proposal.
The missing piece was projecting that existing read into standing and answering
an explicit application-terms request; no new offer store, identity selection,
pricing writer or assistant-specific business rule is needed. This is Class 1
reader/composer integration, claiming retrieval of current recorded states only.

First falsifications: an injected-reader Ask test returned unavailable despite
complete canonical terms; a standing test showed terms_review was absent; a
timeout test showed the existing uncertainty wrapper lost the timeout code.
The successor reads the same owner and preserves timeout versus read failure,
unknown versus zero, and accepted versus pending. Existing person addressing and
server entitlements run first; generic property application-fee questions remain
Economics questions. No message send or lease action is added. An owned full-run
extension compares both Ask HTTP doors, staff detail and tenant acceptance.
Final result: **163 full-path assertions pass**, with all 50 source-governance
gates completed first and an isolated full journey afterward. Source and browser
checks are not deployment or live-phone evidence. Owned cleanup completed.

Independent review caught a second-application ambiguity: the standing reader
already selected the latest application, but that choice was not visible to Ask.
The canonical read now carries its count/basis. Ask requires clarification when
several applications exist, unless the request explicitly says latest; answered
prose names that selection. Real HTTP tests insert an older migrated application
and prove both refusal and explicit selection. A request mixing terms with
separately classified pricing remains an unsupported composition, never a silent
switch to property pricing. Generic application-fee pricing remains unchanged.

Intermediate evidence: the first HTTP addition used the wrong test payload key
and was refused400; the harness was corrected to the existing message contract.
A later browser acceptance response timed out. Its unawaited response promise
prevented the failure screenshot; the harness now awaits click/response together
and waits for the existing hydrated opening screen. The underlying timeout cause
was not established; the successor passed twice, including the final isolated
run. No product behavior was weakened or acceptance bypassed.

Operational finding: source governance includes a falsifier that temporarily
rewrites ask_spine_answer.js and renames tenancy_position_read.js. It is not a
read-only suite and must run before, never concurrently with, the owned journey
or other source edits. The final isolated163 run followed the completed50 gates.

### September 8 follow-up: submitted applications without an offer

Intent: the applicant who already submitted without terms must review complete
terms through that same application link, without repeating personal information
or being treated as having accepted terms in the past. Existing owners are the
conversion's application-offer route, its consumed invitation, the immutable
lease_offers snapshot and the existing public submit/acknowledgement writer.
History: these applications predate the uncommitted terms-first candidate; the
older submission writer legitimately has no offer relationship. This is an
extension of the existing Class 1 owner, not another invitation or quote service.

Observed first red: all 145 canonical journey assertions passed, followed by a
migrated-shape baseline. Proposing complete terms returned success but did not
attach the offer to the existing consumed invitation. A separate focused test
also showed that an unbound application could pass management confirmation while
an initial offer was pending. The successor adds explicit application identity
to the same manager action, validates it against the server-owned invitation and
conversion, and extends the canonical pending read to prohibit that bypass.
No application acknowledgement is written until the tenant explicitly accepts.
Offer retry identity now includes application identity in both retry branches.

Forbidden second paths: creating another application to avoid the old record,
backfilling acceptance, guessing economics, or calling a separate lease writer.
The new legacy fixture is explicitly Class 3 migration-shape evidence in the
owned disposable database, not a claim that a real application was submitted or
an actual tour occurred. The successor passed **155 full-path assertions**:
the prior 145 plus ten legacy-shape checks, including real mobile acceptance,
same application identity, retained answers, one first acknowledgement, zero
deposit, retry identity and negative stale/incorrect requests. The consumed link
was reused and no personal questions were repeated. All 50 source-governance
gates also passed. Owned server/database/cluster data cleanup completed.

Separate operator UI rung: actual form functions ran in Playwright with stubbed
adapters. Root's final null-offer test rejected the first empty-fee-row guard:
an editable empty row was incorrectly sufficient to skip the no-fees choice.
The successor requires explicit none or complete fee rows, rejects contradictory
choices, preserves zero rent/deposit/fee values, supports multiple initial fees
with the established fee-row styling, and carries application identity through
the existing action. The null-before-any-proposal shape is covered, not only a
pending offer. All 44 inline scripts parse. These app-only fixes followed the
155 HTTP/tenant-browser run and have this separate DOM rung, not full operator
browser-through-HTTP proof. No API product edits followed that successful run.

Revision is deliberately blocked once any packet exists; amendment/void/reissue
remains in its existing owner, not a side door here. An exact existing submitted
application can now receive its first explicit proposal in the local candidate;
the live legacy application has not been changed or silently acknowledged.

Ask's signer standing and latest application terms are covered; explicit older
application selection, broad question coverage and causal explanation are not.
Accepted fees remain in the signed packet; executed tenancy retains packet
lineage and economics, without a separate new fee ledger. Conditional and unit-
assessed catalog charges and structured concessions remain unsupported rather
than guessed. No production migration/deployment or live terms backfill occurred.
The owner's previously submitted live application remains intact, lease held.
