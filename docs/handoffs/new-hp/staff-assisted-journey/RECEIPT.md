# Staff-assisted lead-to-lease journey — receipt (2026-09-12, overnight)

Returned to HP QB for review and integration. No production read or write,
no provider action, no real message, no deployment, no merge, rebase, reset
or force push. Everything below ran on nonce-owned loopback databases built
from the real migration chain (ceiling 194 / 182 rows) and owned servers of
the unmodified API `d45d7687ba11aa8b624bfbce9150cee8733f6eec`
(`codex/hp-release-integration-20260911`). App baseline
`5d6a10dcfc340a01cd98b96ad619499b56b0241b` was checked out but its operator
shell was not driven (see "Not exercised"). Isolated worktree and branch
`claude/staff-assisted-journey-20260912`. Doctrine read: `CLAUDE.md`,
`docs/PHILOSOPHY.md`, `docs/DB_HARNESS_ISOLATION.md` (unchanged since
0f5dccca), `docs/CURRENT_STATE.md`, and the rulings named in the packet. A
workspace `AGENTS.md` does not exist in either repository.

**No product source was changed.** The chain completed on the unmodified
baseline for the Skyline shape; the Greenery shape stops at a configuration
boundary, not a code defect. This branch adds one proof, one CI registration
line and this handoff.

## Morning answer

### What Mike can complete now

**Skyline shape — the whole chain, on one prospect, with the exact bed held
throughout.** Authenticated website inquiry (idempotent relay, positive
consent recorded, nothing sent) → the agent takes accountable ownership
(second staff member refused 409) → native tour slot booked from the
conversation (replay returns the same tour) → check-in → actual outcome
recorded as ready to apply (replay is a replay; the follow-up is the agent's)
→ exact home chosen from the leaseable-units read (`3B · Bed B`,
`marketable_now`, `confirmed`) → manager-authored offer (agent refused 403;
leased sibling bed 409 `not_offerable`; home with no governed ready date 409
`application_ready_date_not_governed`) → Ask Spine "send the application for
Unit 3B, Bed B" proposal with a server-minted confirmation (naming the
occupied sibling bed or the bare apartment clarifies, never re-aims) →
confirm sends one text with one link (used receipt on replay; manager cannot
redeem the agent's confirmation) → manager revises the offer on the existing
invitation (no message; the applicant must review; the superseded hash cannot
submit) → applicant submits with a guarantor against the current hash
(replay idempotent) → manager approves (agent 403, foreign-property manager
403) → terms confirmed → governing packet → resident and guarantor links
(re-issue is a replay; cross-role signature refused; company blocked until
the resident signs) → both sign → the recorded company signer executes →
**one pending lease on Bed B at the acknowledged rent and dates**, the bed
leaves the selector, Person Card and Application Review read the same
tenancy. Removing the agent's assignment kills the live session and the send
door at once. 84 checks, 0 failures.

The applicant form and both signer pages were separately driven in real
Chromium against the same owned server by the existing full-path suite
(`tour_application_lease.e2e.js` with `PROOF_TENANT_BROWSER=1`, 151/151,
`BROWSER_APPLICATION_SUBMITTED`, `BROWSER_SIGNER_SUBMITTED` guarantor and
tenant). Those are the resident-facing pages, not the staff shell.

**Greenery shape — through the tour outcome, then a configuration stop.**
Adoption through the super-admin door, first assignment through the admin
invite door, manager and agent through the governed Team invite and OTP,
inquiry, ownership, native slot, booking, check-in, outcome, conversion,
follow-up and access removal all behave exactly as at Skyline (30 checks, 0
failures). The chain stops at the exact home: the leaseable-units read
returns nothing because no established, use-configured position exists. That
is the product refusing honestly, not failing.

### Exact remaining blocker per property

| Property | Blocker | Kind | Next accountable action |
|---|---|---|---|
| Skyline | None in code on this chain. What remains is production configuration already listed for launch: Skyline's ids in the five allowlists, a published pricing version, lease configuration `ready_to_execute`, and the operator shell rung on the deployed app. | configuration / owner input | HP QB: release configuration per `greenery-launch/LAUNCH_CHECKLIST.md` §8 (same env keys); Kameron: confirm Skyline pricing and lease form inputs are in production. |
| Greenery | No established inventory: the rent roll has not been read and established through Deal Setup, beds carry no `use_type` (mapping run needs a Greenery ruling block), no lease configuration, no pricing, no real text line. Every one is an input nobody can infer. | configuration + owner input | Kameron: supply the Greenery rent roll with a bed column, the lease form and terms, the Twilio number; HP QB: run the Deal Setup establishment and the reviewed unit-type mapping. Checklist: `docs/handoffs/new-hp/greenery-launch/LAUNCH_CHECKLIST.md` §3–§7. |

No launch percentage is offered; assertion counts measure what the proof
looked at, not readiness.

## Rulings the proof holds to

- **Exact target.** A named occupied bed never becomes the free sibling; a
  bare apartment on a by-the-bed unit asks for the bed
  (`EXACT_TARGET_REFUSAL`). The invitation, application, packet and lease all
  carry the same `space_id`.
- **Offer terms.** Only server-established pricing authority or
  `can_manage_roles` may author terms. The applicant reads server-owned terms
  and must acknowledge the current hash; a superseded hash cannot submit; a
  prepared packet blocks a further offer change (409).
- **Distinct facts.** After company execution the lease is `pending`,
  `economic_tenancy_activated_at` is null and there is no move-in event:
  availability, certification, execution, activation and possession stay
  separate. Nothing here infers that a shared area is clear.
- **Retries never duplicate.** One person, one lead, one conversation, one
  tour, one conversion, one invitation, one text, one application, one packet,
  one lease. Every repeat is a replay or a used receipt.
- **Authority.** Wrong-property manager 403 on approval; leasing access is
  not company signing authority (403); a removed assignment revokes the live
  session (401).

## Observations recorded, not changed

1. **Changing an offer before it is sent has no door.** The revision route
   requires one current invitation (409 "One current invitation is required
   to revise these terms"), and a second draft offer with a new idempotency
   key would leave two current offers, which the send path refuses as
   `APPLICATION_TERMS_REQUIRED`. The governed way to change terms is
   therefore send first, then revise on the invitation. Whether a draft offer
   should be retirable before send is a ruling for QB; the proof asserts the
   refusal, not a preference.
2. **The confirm-time terms guard was not reachable.** After the invitation
   exists, a second "send the application" request returns
   `leasing_clarification` rather than a proposal, so no stale confirmation
   could be minted for the changed offer. The applicant-side guard (superseded
   hash refused at submit) was exercised instead.
3. **Ask Spine after execution** answers the person read with
   `leasing_opportunity_stage = applicant_followup` while the lease is
   pending. That is consistent with "execution is not activation", but QB
   should confirm it is the vocabulary intended for an executed, unactivated
   tenancy.
4. **Fixture reruns.** `tour_application_lease.e2e.js` selects its company
   signer by `name='Mike Grivna' limit 1` and deletes leases on the fixture
   property; on a reused database it finds the leasing-agent Mike it created
   on its first run (403) and the delete hits `executed_lease_records`. The
   suite is designed for a fresh database and CI gives it one; recorded only
   so nobody reads a rerun 403 as a product defect. The new proof selects the
   manager by role-managing assignment and retires prior leases with the
   inventory vocabulary instead of deleting them.
5. **Greenery text line and admin accounts are fixtures** here (line policy
   and organization creation are outside this lane); everything after them is
   HTTP through the governed doors.

## Not exercised

- The **operator shell** (`property-spine-app`) for the staff steps. The
  existing browser mechanisms cover the resident-facing pages only; the shell
  boot is pinned to the production origin and is on the hands-off list. Staff
  UI reads were checked through the same HTTP reads the shell calls
  (conversation detail, leaseable-units, application review, Person Card).
- Any real carrier, provider, or production identity.
- Prospective planning, pricing publication, knowledge, and homepage —
  out of scope by the packet.

## Proof — `tests/e2e/staff_assisted_journey.e2e.js`

Class 3. `JOURNEY_SHAPE=skyline` (default) runs on the CI fixture property
and is registered in `tests/e2e/verify_all.sh` inside the final
prospect-activated server block after "staff inquiry native tour booking".
`JOURNEY_SHAPE=greenery` requires `PROOF_GREENERY_ID` and a server whose
allowlists carry that id; it is run by hand (command below) and is not in
CI. A configuration stop ends the chain with every later section recorded
as "not exercised", never as a failure.

| Shape | Server | Result |
|---|---|---|
| skyline | unmodified `d45d768`, owned DB A | 84 passed, 0 failed, 10 observations, chain complete |
| greenery | unmodified `d45d768`, owned DB A, allowlists = Greenery id | 30 passed, 0 failed, 11 observations, chain stopped at exact-home |
| full-path suite with browser pages | unmodified `d45d768`, owned DB B (fresh) | 151 passed |

Evidence: `evidence.skyline.json`, `evidence.greenery.json` (identifiers,
phones, emails, tokens, hashes and codes scrubbed).

Harness corrections made while getting to first green (test file only):
prior executed leases on the fixture bed are retired, not deleted; the
manager is the role-managing "Mike Grivna"; the changed-offer case follows
the route's invitation rule (observation 1).

## Commands

```
node tests/e2e/proof_boundary.js create && ./tests/e2e/apply_migrations.sh
psql "$E2E_DATABASE_URL" -f tests/e2e/property_fixture.sql
psql "$E2E_DATABASE_URL" -f tests/e2e/fixtures.sql
node tests/e2e/instrument_fixture.js
# owned server booted like tests/e2e/boot.sh with the fixture property id in
# every *_PROPERTY_IDS allowlist and APP_BASE_URL on the owned port, then:
JOURNEY_SHAPE=skyline node tests/e2e/staff_assisted_journey.e2e.js            # 84/0
PROOF_TENANT_BROWSER=1 E2E_DISPOSABLE_DATABASE=true \
  CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  node tests/e2e/tour_application_lease.e2e.js                               # 151 (fresh DB)
# second server: allowlists = a fresh uuid G, PROOF_GREENERY_ID=G, then:
JOURNEY_SHAPE=greenery PROOF_GREENERY_ID=$G node tests/e2e/staff_assisted_journey.e2e.js   # 30/0, stop at exact-home
node tests/verify_source_governance.js                                        # 56/56 gates
node tests/e2e/proof_boundary.js cleanup                                      # both owned DBs dropped
```

Cleanup: both owned databases were dropped and verified; `spine_proofs` was
not touched. No production connection string was used.
