# Two-step leasing — AUTHOR and EXECUTE — receipt (2026-09-13)

Returned to HP QB. Base: API `24007ebfff314a9edec16300b74ff9343b89ab82`
(receipt-only successor of the deployed `dab19b6a84493093911427dfe2de29ee91451ac9`)
and app `e23a36a4588cdeda10eb3d902cea4b917f68dbe9`, both on
`codex/hp-release-integration-20260911`. Isolated worktrees and branches
`claude/two-step-leasing-20260913` in both repositories. Owned nonce-verified
databases from the real migration chain (ceiling 195 after this branch's
migration; 194 for the baseline witness), owned servers, fake SMS and model
transports. No production read or write, no provider action, no real message,
no deployment, no merge, rebase, reset or force push. No SQL after a business
action; every fixture write precedes the first business action and is labelled
in the proof. Doctrine read: `CLAUDE.md`, `docs/PHILOSOPHY.md`, the assignment
`docs/handoffs/new-hp/TWO_STEP_LEASING_CLAUDE_OVERNIGHT_20260912.md`, and the
four QB documents under `docs/handoffs/new-hp/no-consent-two-person-journey/`.

No retirement-door work had been started before this assignment; there was
nothing to checkpoint.

## Answer

**The ordinary lease now carries exactly two commercial decisions, and the
candidate proves it on real HTTP, a real database and the real staff shell.**

```text
AUTHOR    KZ approves the complete immutable offer for one person, one
          property, one exact bed                      (existing door, unchanged)
          … Mike prepares and attests the application link, the applicant
            acknowledges the exact terms and applies, Mike prepares the
            signing package FROM THE ACKNOWLEDGED OFFER and issues the links,
            the applicant and guarantor sign …           (no decision)
EXECUTE   KZ approves the application AND signs for the company in one
          deliberate action → the existing pending tenancy   (new door)
```

- Baseline witness on unmodified `24007eb`: **134 passed, 32 failed**. Every
  failure is the released rule: Application Review answers a submitted,
  offer-bound application with `approve_application`; Mike's packet
  preparation is refused `403 not_permitted` (perimeter:
  `application_state_ineligible:submitted`); `POST …/execute` is 404.
  Everything before the packet — inquiry, ownership, email attestation, tour,
  authored offer with draft correction, manual-email preparation, attestation,
  acknowledged application — passes on the released source.
- Successor on this branch, fresh owned database: **410 passed, 0 failed,
  4 observations.** Four journeys on four separately established beds, one
  database, first lease never cancelled, no shared bed reset.
- Real Chromium against the actual staff shell (`apptwo` at this branch):
  **17/17** — a Mike-shaped session sees the server-authored Execute control
  and is refused through the real door with the server's own copy visible on
  the page; the KZ-shaped session executes with one click and one explicit
  confirmation naming both consequences; the page rereads the tenancy.
- Existing suites on this branch, fresh owned databases: no-consent two-person
  journey 155/0; draft offer correction; leasing clean path; hostile
  falsifications; cross-surface reconciliation; standing vs review; Ask Spine
  facts; resident signs (Chromium) — all green. Unit and no-database gates:
  packet eligibility contract (68 of 69; the one failure — a `properties`
  write census in `slice9_lease_packet_proof.js` — fails identically on the
  unmodified baseline and is not in CI), next-action oracle, application
  review action contract 14/14, review offer projection, offer writer read
  locks, source governance, Ask Spine reader gate. App harnesses on the
  patched shell: **67 harnesses, 2,253 assertions, 0 failed.**

## The two decisions, counted

Server evidence per executed lease (asserted in J1, J2 and the browser slice):

| record                                              | count | actor |
|-----------------------------------------------------|------:|-------|
| `events.type = 'application_approved'`              | 1     | KZ (`managed_role_override`) |
| company signature field (`sign_company`, completed) | 1     | KZ (configured company signer) |
| `application_proposed_terms_confirmations` with `source = 'operator_proposed_terms'` | **0** | — |
| `application_proposed_terms_confirmations` with `source = 'authored_offer_acknowledged'` | 1 | system-derived; actor = the preparer (Mike); economics and authority = the offer author's, via `application_offer_id` |
| `lease_offers` (`application_proposal`) for the person | 2 | KZ: draft + explicit draft correction |
| leases on the bed (non-cancelled)                   | 1     | pending; no activation, no possession |

The staff browser flow makes the same count: one Execute click, one
confirmation dialog, one `POST …/execute`; the browser sends no separate
approve, confirm-terms or company-sign request (asserted by intercepting every
write).

## What changed, and why it is the smallest honest change

**The rule that permits packet preparation without a false approval.**
`assessLeasePacketEligibility` (`src/applications/lease_packet_eligibility.js`)
admits a `submitted` application when — and only when — it is bound to the
applicant's acknowledged, **current** (unsuperseded) authored offer: the
application's `application_offer_id` equals the offer, the acknowledged hash
equals the offer's hash, and `application_terms_acknowledged_at` is set. The
verdict names its basis (`preparation_basis: 'authored_offer'` vs
`'operator_confirmation'`). A submitted application without that lineage takes
the released refusal byte-for-byte (the released contract proof still passes).
The operator perimeters for generate and issue now admit `submitted` so that
the one predicate decides; the perimeter remains the property and module wall.

**The system-derived preparation record is distinguished from a human
confirmation.** Downstream lineage — packet ↔ confirmation ↔ offer, issue
checks, review currency, the admission engine's terms comparison — reads one
record type. So the two-step path writes that record **derived** from the
acknowledged offer (`deriveConfirmationFromAuthoredOffer` in
`proposed_terms_service.js`, the module that already owns confirmation writes)
with `source = 'authored_offer_acknowledged'` and
`authority_basis = 'authored_offer'`, the preparer as `actor_user_id`, the
offer's canonical terms and hash, and `idempotency_key = authored_offer:<offer>`
so a regenerate reuses it. `lease_applications.term_source` reads
`'authored_offer_acknowledged'` and `terms_completed_by` is the offer's author.
Nothing here approves: `status`, `approved_at`, `approval_obligation_id` and
`terms_review_obligation_id` are untouched (asserted after every preparation).

**Migration 195** widens three CHECK constraints (`aptc_source_ck`,
`aptc_authority_ck`, `la_term_source_ck`) and adds one
(`aptc_derived_names_offer_ck`: a derived record must name its offer and hash).
Rationale: 085 froze the vocabularies; writing `'operator_proposed_terms'` for a
system-derived record would be a false attribution, and a parallel table would
break the one lineage every reader uses. No column added, no row rewritten.

**Resident signing on an unapproved application.** `/t/lease/:token/submit`
accepts a tenant signature when the packet carries the application's own
offer lineage and the application is still `submitted` (previously refused as
`legacy_application_pre_terms_review`). The acknowledgment evidence is frozen
on the packet's `tenant_submitted` audit row (`two_step_preparation: true`).
No obligation is satisfied at that moment because none exists yet.

**Execute** — `POST /operator/leasing/lease-packets/:id/execute`
`{ application_decision: "approve", idempotency_key? }`
(`executeLeasePacketDecision` in `lease_packets.js`, exposed on the module
service for the rollback proof). In order: session and module wall → packet
locked, property wall → application locked → **both authorities resolved
before any write** (approval: the approval obligation's owner/role or the
governed override, exactly as the released `/approve` door; signature: the
property's configured signer list) → idempotent replay if already executed →
terminal / status / packet-state / instrument / lineage / exact-bed refusals →
**decision 1** `approveApplication` (the one released service; it records
`application_approved`, closes the approval obligation, spawns the
terms-review obligation, authors `approved_at`), then that obligation is
satisfied from the packet's frozen acknowledgment evidence and completed →
**decision 2** `companySignCore` (the released company-signature core,
refactored out of the route unchanged in effect) → `executeSpineLease` →
`executed_by_decision` audit naming both decisions with their own actors,
timestamps and event ids. One transaction; any failure rolls all of it back.

**Alternative route closed.** The released `…/company-sign` door refuses a
submitted, unapproved application with `409 application_not_approved` and
points at Execute. Before this branch a configured signer could have reached
`executeSpineLease` on an unapproved application only to be blocked at
admission; the refusal is now explicit and early.

**Reads.** `applicationNext` answers a submitted, offer-bound application with
`prepare_lease_packet` → `issue_terms_review_link` → `await_resident_acknowledgment`
→ `execute_lease` (with `commercial_decisions_remaining`) → the released
post-execution codes; `application_review` passes the acknowledged offer to
the resolver and its `execution_primary_action` authors `execute_lease`
("Approve the application and sign for the company") with the endpoint and
body. Ask Spine reads the same review and standing (asserted after execution:
no `read_failed`). Execute is **not** a conversational action: reads required,
actions granted (§40.9); no new Ask verb was added.

**App** (`index.html`): `executeLeasePacket` write adapter; `execute_lease`
execution panel and button; `psArExecute` with a confirmation naming both
consequences and a per-packet retry key; `prepare_lease_packet` primary action
("Prepare signing package"); progress ladder shows "Authored offer
acknowledged by the applicant" instead of a confirmation step and one Execute
step; hero copy for `prepare_lease_packet`, `execute_lease`,
`executed_lease_recorded`, `active`, `closed`.

## Actor / permission matrix (as exercised, all through real sessions)

| actor (real preset, joined by governed invite + OTP) | author offer | prepare / attest link, packet, links | approve | company-sign | **Execute** |
|---|---|---|---|---|---|
| Mike · `property_manager`, no override, no grant | 403 `NO_APPLICATION_OFFER_AUTHORITY` | **yes** | 403 | 403 | 403 `execute_not_authorized`, `missing: [application_approval, company_signature]` |
| Signer-only · `leasing_agent` placed on the signer list | — | — | — | (signer) | 403 `application_approval_not_authorized`, `missing: [application_approval]` |
| Approver-only · `property_admin` override, not on the signer list | — | — | yes | 403 | 403 `company_signer_not_authorized`, `missing: [company_signature]` |
| KZ · override + configured signer | yes | yes | yes | 409 `application_not_approved` on the two-step packet | **201**, two decisions |
| KZ at another property | — | 403 | 403 | — | 403 `packet_not_at_your_property` |

Signer-list entry alone never confers approval; approval authority alone never
confers signature; Execute holds authority for every consequence.

## Exceptions retained (each exercised)

- Before every resident-side signature: 409 `resident_has_not_executed`
  naming the outstanding signer.
- Wrong or empty decision: 400 before any write.
- Withdrawal before Execute (J3, through the existing disposition door): 409
  `application_terminal`; no approval, no signature, no lease; the bed
  returns to the selector.
- Withdrawal after execution: refused.
- Double click / three concurrent Execute requests: exactly one 201; the
  others replay (200 `idempotent: true` with the recorded decisions and the
  same tenancy) or refuse; one lease.
- Lost-response retry, and a different retry key on an executed packet: the
  one recorded decision, never a second.
- Released doors after Execute: `company-sign` 409 `packet_already_executed`;
  `approve` 409 idempotent.
- Changed terms: a prepared packet blocks a further offer change (409); a
  stale packet (offer id or hash ≠ current acknowledged offer) is refused at
  Execute with `packet_terms_stale`; the signed snapshot must name the
  application's exact bed (`packet_space_mismatch`). Neither of the latter two
  states can be produced through the released doors today (an offer cannot
  change once a packet exists), so they are guarded, not exercised.
- Rollback: `executeLeasePacketDecision` on the real J1 packet with an
  injected failing approval dependency that writes an event and then throws —
  the error surfaces, the partial event is gone, the packet stays
  `resident_executed`, the application stays `submitted`, no lease.
- Second property shape (no governing instrument, no timezone): the lease
  configuration read answers with empty terms; publishing a tour time is
  refused `422 property_operating_timezone_not_configured`; that property's
  session cannot execute the first property's packet. **Honest limit:** the
  second shape was not walked to a packet; a full Greenery-shaped journey
  needs an established, use-configured bed and an intake allowlist entry for
  a runtime-created property.

## Rereads after every transition

Leasing desk, conversation queue and Application Review are reread after
every state change in every journey (`operatingReads`), Person Card and Ask
Spine after execution; every read is a required 200 with no concealed
`read_failed`. The desk retains the earlier executed lease while later
journeys run.

## Compatibility and recovery

- The released path (approve → confirm → packet → sign → company-sign) is
  unchanged and still proven by the existing suites; both bases coexist and
  the verdict names which one admitted a packet.
- An application already approved when Execute runs records
  `application_already_approved` and only signs.
- A derived record for an offer that is later corrected (only possible after a
  voided packet) is superseded by a new derived record; a human confirmation
  found on a still-submitted application refuses
  (`application_terms_lineage_conflict`) rather than being silently
  superseded.
- Migration 195 must be released before this code serves a two-step packet
  (the derived insert would violate `aptc_source_ck`); the migration is
  additive and safe to apply ahead of the code.
- The older `company_execute_lease` app path remains for approved
  applications.

## Unapplied production configuration (proposal, not applied)

Nothing new is required for the two-step path itself. What the released path
already required still holds: the company signer list
(`properties.lease_config.execution_authority.company_signer_user_ids`) must
name Kameron's user; the approval obligation's role (`leasing_manager`) or the
override must be held by the executing person; `operating_timezone` set; a
retained governing instrument on the property. Mike's production assignment
stays `property_manager` without override or grant; nothing here grants him
more. If a second executing person is ever wanted, they need **both** the
signer-list entry and approval authority — one alone is refused by design.

## What still needs a third commercial decision

None on the ordinary path. Two situations still need a human act outside the
two decisions, and both are real exceptions rather than the ordinary path:
(1) a decline or withdrawal (its own disposition door, unchanged); (2) an
executed lease whose admission is blocked (`tenancy_error`): the lease stands
and the conflict is named, and resolving it is the released correction path.

## Evidence

- `evidence.witness.json` — baseline `24007eb`, 134/32, scrubbed.
- `evidence.successor.json` — this branch, 410/0, scrubbed.
- `browser_execute.receipt.json` — real Chromium, 17/17, intercepted writes and
  the dialog text, scrubbed. Screenshots (`execute_mike_before`,
  `execute_mike_refused`, `execute_kz_before`, `execute_kz_after`) were
  inspected and are kept out of the repository (they carry runtime
  identifiers).
- Owned databases: `spine_proof_*` created and dropped for runs 10–18 of this
  session (`proof_boundary.js cleanup`); no shared database touched.

## Observations for QB (not changed)

- After execution the released `active` next-action and the app's move-in
  panel show "cannot be displayed / does not understand" copy for the
  post-execution state; this predates the branch (the earlier journeys never
  opened the review after execution). Hero copy for `active` was added; the
  move-in panel was left as found.
- `staff_invite_acceptance.browser.js` failed only in this container's
  mixed-port harness run (join URL built for the server's configured base);
  it is unrelated to this change and runs unchanged in CI.
- CI: recorded below once the run on the exact final commit completes.
