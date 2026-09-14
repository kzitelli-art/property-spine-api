# Tuesday 15 September — walkthrough runsheet for Kameron and Mike

Goal for the day: show Skyline and Greenery, and take a **live** website
inquiry through to a signed lease with every step in between.

Prepared 2026-09-14 by Claude from the repo's own receipts. Every
"verify" item below is a read; every "do" item is yours. I cannot see
production, so the state column says what the receipts last recorded and
how you confirm it in the morning. Nothing here was executed against
production.

## The one-paragraph truth

The website-inquiry-to-signed-lease chain **already exists in production**
(API `d15c968`, app `336c82f`); it was proven end to end on the
Skyline-shaped fixture (84 checks) and the no-consent two-person variant is
in that build (`fd588e5`). Whether it runs *live* tomorrow is decided by
configuration and content on Render and in the property, not by code.
Skyline was last recorded as nearly complete; Greenery has none of it.
The pending release (195–198, corrected pin `03550a8`) is **not** needed
for the lead-to-lease demo. It is needed only if you also want to show
the current rent-roll reconciliation door and two-step Execute.

## Skyline — what must be true, and how you check it (30 minutes, morning)

Last recorded state (staff-assisted-journey QB review, 12 Sept): bed
basis, 160 classified spaces, 1 established opening position, 210 lease
rows, 1 published pricing version from 20 Aug with 3 terms on 3 unit
types, saved lease configuration with required terms, property-scoped
template with matching hash, 1 active company signer, 1 property-facing
text line, 2 leasing assignments. Remaining blocker then: **production
configuration**, not code.

| # | must be true | how to verify (read-only) | if not |
|---|---|---|---|
| 1 | Skyline's property id is in all five Render allowlists: `LEASING_INTAKE_PROPERTY_IDS`, `PROSPECT_ACTIVATION_PROPERTY_IDS`, `APPLICATION_INTENT_PROPERTY_IDS` (+ `APPLICATION_INTENT_PREPARE_ENABLED=true`), `EXECUTED_LEASE_PROPERTY_IDS`, `ACTIVATION_PROPERTY_IDS` | Render → API service → Environment | intake and application birth refuse (`PROPERTY_NOT_ACTIVATED`). Add the id, redeploy the **same** commit (env change only) |
| 2 | `COMMITMENT_LEDGER_MODE=enabled` | same page | offers, grants, pricing publication and countersign refuse while dormant |
| 3 | Texting is real: `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN` set, `SMS_SEND_MODE` not `customer_care`, Skyline's line active | Render env; app → property text line | invitations cannot be texted; use the manual-email path (below) |
| 4 | Website form posts to the intake endpoint with `LEASING_INTAKE_SECRET` | Netlify site (propertyspine.com) form action + secret matches Render | inquiries never arrive; capture the lead by hand in the app instead |
| 5 | Lease configuration `ready_to_generate` and `ready_to_execute` | app, Management → lease configuration (or `GET /operator/leasing/lease-configuration`) | packet cannot be generated/executed; Mike posts the template with `confirm_company_signer=true` |
| 6 | Published pricing covers the bed you will offer (its unit type and term) | app, Pricing → published version | `no_published_pricing_version`; agent cannot quote; authoring refuses |
| 7 | At least one bed reads `marketable_now` with a governed ready date | app, Leasing desk → exact-home selector (`leaseable-units` read) | `application_ready_date_not_governed` / `not_offerable`; pick a bed whose turn is certified, or record readiness first |
| 8 | Mike's account: active leasing assignment at Skyline; you hold pricing/authoring authority or `can_manage_roles`; the company signer is active | app, Team | agent-role users get 403 on authoring; only the recorded signer executes |

**Send one test inquiry before Mike arrives** (your own details, clearly
named "Test lead"): it proves 1, 4 and, if you tick consent, 3 in one
move. It is a production write and it is yours to make.

## The live script on Skyline (the order the proof runs; the app door for each)

1. **Website inquiry** arrives with positive consent recorded, nothing
   sent. Leasing desk shows it. (No consent → the whole chain still works,
   but the application link goes by email attestation, never by text.)
2. **Take ownership** of the inquiry (a second staff member is refused
   409). Reply from the conversation.
3. **Book the tour** from the conversation onto a native slot (replay
   returns the same tour). Check-in. **Record the outcome** as ready to
   apply — this opens the conversion.
4. **Choose the exact home** from the selector: a `marketable_now` bed.
   A leased sibling bed is refused; a bare apartment on a by-the-bed unit
   asks for the bed. Same `space_id` rides through every later step.
5. **Author the offer** (you, not the agent role). Ask Spine "send the
   application for Unit X, Bed Y" also works and mints a confirmation.
6. **Send** the application: one text with one link (or manual email +
   attestation if no consent). Replays are receipts, never duplicates.
7. **Applicant submits** with guarantor against the current terms hash.
8. **Approve**, confirm terms, **generate the governing packet**, issue
   resident and guarantor signing links.
9. **Both sign**, then the **company signer executes**. Result: one
   pending lease on that bed at the acknowledged rent and dates; the bed
   leaves the selector; Person Card and Application Review read the same
   tenancy. Activation and move-in are separate, later facts.

Refusals you may meet and what they mean: `NO_APPLICATION_OFFER_AUTHORITY`
(wrong role authoring), `NOT_OFFERABLE` (sibling leased),
`APPLICATION_READY_DATE_NOT_GOVERNED` (readiness not recorded),
`PERSON_HAS_NOT_CONSENTED` (no text without consent — use email),
`STAFF_SESSION_PROPERTY_MISMATCH` (wrong property in the picker).

## Greenery — show, do not promise

Last recorded state: 171 legacy units/spaces with **no** use
classification, **no** established opening position, no pricing, no lease
configuration, no signer, no text line, no leasing assignments. Every
one is an input nobody can infer.

What you *can* show live and safely: Deal Setup → Greenery → upload the
real workbook → **preview** (writes nothing) → the source-home review
screen. Stop before "Apply" unless you decide to establish today.
Exact-home offers, pricing and signing are not possible on Greenery
tomorrow; say so, and show them on Skyline. The path to get there is
`greenery-launch/LAUNCH_CHECKLIST.md` §3–§8 (workbook with bed column,
reviewed unit-type mapping with a Greenery ruling block, lease form and
terms, pricing, text line, Render allowlists).

## The release question, settled for tomorrow

- Lead-to-lease on Skyline: **no release needed.**
- Current rent-roll reconciliation door and two-step Execute: **release
  needed** — runbook `combined-194-198-release/RELEASE_RUNBOOK_20260914.md`,
  API pin `03550a8` (not `e808199`, which refuses on Render), app
  `1a5f257`. Allow 45 minutes and do it before Mike arrives or not at all;
  never during the session.
- If you do not release, show the rent-roll door from the coupled
  acceptance screenshots
  (`current-rent-roll-reconciliation/coupled-browser-acceptance/`).

## Fallback deck

Screenshots from owned rehearsals at the candidate, for any step that
blocks live: the coupled rent-roll acceptance (property choice → review
homes → recognised resident → established), and the journey rehearsal set
recorded in `walkthrough-20260915/` beside this file once run.

## Do not

Do not use `dab19b6` or any pre-195 build as a rollback after a release.
Do not accept Skyline tracker mappings during the session. Do not enable
autonomous dispatch, booking or signing allowlists for the demo; the
rehearsals ran with all allowlists on a synthetic server and that is not
a production instruction.

## Rehearsal evidence at the candidate (2026-09-14, owned database at ledger 198)

- `evidence/skyline_journey_03550a8.log` — `staff-assisted journey (skyline): 88 passed, 0 failed, 8 observations; chain complete`; "Skyline completes the chain with an executed lease and no configuration stop".
- `evidence/two_step_leasing_03550a8.log` — `two-step leasing: 508 passed, 0 failed, 4 observations`.
- Two-step Execute in the **browser** on the combined app `1a5f257`: the shipped proof timed out at the new "Choose a property" layer (never run in CI; skipped unless an app checkout is named). Adapted on `claude/two-step-browser-picker-20260914` (`140cf35`, proof only) to make the visible selection; its rerun and screenshots are recorded here when done.
