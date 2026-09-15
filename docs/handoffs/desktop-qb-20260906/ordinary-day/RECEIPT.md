# Ordinary-day rehearsal — 2026-09-08

User question: can staff actually use the application through ordinary work,
including an interruption, rather than merely pass isolated checks?

Inspected API 9f2acff97af311e6ebdcd5e2219f8cf873894748 and paired app
c05ae68f6f8bc49ca4b5bd752adc928e1f4e0d88. Read CURRENT_STATE then the complete
PHILOSOPHY. Product source is unchanged. The successor adds proof infrastructure
only; tested executable hashes are in tested-custody.json.

## Results

- Fresh full July/Skyline rehearsal: all nine browser phases passed (zero,
  claim, source-auth, holds, spaces, relay, stage, restart, mixed). Retained
  source lineage, restart, correction and mixed Add All controls passed.
  July 164 proposals and Skyline 262 proposals; real-source confirmations zero.
- Hold/resolve: 101 DB/service/HTTP assertions passed. Rent remains 1750;
  native leases and contractual occupancy survive the physical holds. Operational
  occupancy changes with the eligible population and returns to baseline.
  Ask's actual gatherFacts tenancy projection stays unchanged through all five
  phases. This is service evidence, not an Ask HTTP or model answer. Ask reads
  today's date; the direct comparison uses July 31. This fixture's leases span
  both dates, so the comparison does not establish arbitrary date equivalence.
- Synthetic prospect: 23 setup/DB/HTTP assertions passed. Browser opened the
  current Conversations board's exact person, recorded a walk-in, selected an
  assigned host and Ready to Apply, entered feedback, received an injected 503,
  retained its note and disposition, retried successfully and received a
  canonical conversion and application picker. After fresh navigation the exact
  saved follow-up reopened the picker. All server space identities matched;
  occupied 303 Room2 was absent and vacant 301 Room2 remained available.
- No send-application request was made. This stops at the picker: selecting a
  target explicitly sends by text. Application preparation/delivery is unproved.
- All 50 source-governance gates passed after runtime cleanup.

## Falsification and corrections

The first two browser stops were obsolete test selectors: a sign-in gate absent
from an already signed-in board, then an old board's person attribute. Current
conversations-board.js supplies data-pscb-person; no product change was justified.

The next run recorded the walk-in but exposed an empty host selector. The fixture
had team access but no person/property assignment. Successor proves the roster
omits that account before assignment and includes it after assignment; the browser
then selects the host. No guessed identity or fixture UI fallback was introduced.

The next failure injection matched only the loopback URL and missed the browser's
configured origin. The successor intercepts both supported origins, as existing
proofs do, and explicitly requires 503 before accepting the recovery result.
Earlier failed runs do not establish successful retry behavior.

## Remaining gaps

The empty host selector says to choose someone but supplies neither an explanation
nor a next action. The immediate handoff also calls the named person “Prospect.”
Both are observed usability gaps, left unchanged in this testing task.

This is local rehearsal, not deployment or whole-product acceptance. Intake uses
the canonical HTTP door with synthetic data, not a browser intake form. Holds
are written over HTTP, not through a newly claimed hold UI. No actual-source
confirmation, real-user action or external transport was exercised.

## Reproduction and containment

Use tests/e2e/onboarding_review_local.ps1 with existing private July/Skyline
originals, the paired AppRoot, PostgreSQL 17.11 and Chrome. Focused flags:
ONBOARDING_SPACE_PROOF_ONLY=1, PROOF_SPACE_EXPECT_DEFECT=0,
PROOF_EXPECT_DEFECT=0, PROOF_FOCUSED_NAME=availability_uncorroborated_claim,
PROOF_CLAIM_BROWSER=1, PROOF_PICKER_BROWSER=1, PROOF_DAY_JOURNEY=1.
Then run node tests/verify_source_governance.js outside the owned runtime.

Focused intake attempted exactly one locally refused model draft; no subsequent
model attempt, SMS or external egress. Full workbook rehearsal retains zero
provider attempts. Every run dropped its owned database, stopped its server and
removed cluster data. Pending index DDL stayed in the owned disposable proof.
Private originals, identifiers and failure screenshots remain outside Git.
