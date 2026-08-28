export const meta = {
  name: 'current-state-new-domains',
  description: 'Inventory the six domains that landed on main since this thread last looked, then adversarially verify every proof-rung claim',
  phases: [
    { title: 'Inventory', detail: 'one agent per uncovered domain cluster, evidence-cited' },
    { title: 'Verify', detail: 'adversarial skeptic per domain: refute the claimed proof rung' },
  ],
}

const API = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-api'
const APP = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-app'

const RUNGS = `REPORTED | LOCALLY_EXERCISED | BUILT_BUT_DORMANT | HTTP_PROVEN | BROWSER_VERIFIED | DEPLOYED | PRODUCTION_PROVEN`

const COMMON = `
You are inventorying evidence for a "current state" ledger for Property Spine, a real-estate ops platform.
THE ONE RULE: report only what repo evidence supports. Never infer, never recall, never fill a gap with a
plausible guess. Where you cannot find evidence, write exactly NOT_FOUND.

Two git worktrees, both checked out at CURRENT main. Read ONLY these paths:
  API repo: ${API}   (main = 77f93f5)
  APP repo: ${APP}   (main = c6769ba)

PROOF RUNG is a controlled vocabulary. Pick the HIGHEST rung you find real evidence for, and name that evidence:
  ${RUNGS}
Definitions that matter:
  - LOCALLY_EXERCISED = a plain .test.js with unit assertions, NO real database.
  - HTTP_PROVEN = a test that starts a REAL Postgres connection AND drives REAL HTTP through the actual router.
    Verify by opening the file and looking for require('pg') / receipt.harnessConnectionString() / real server
    instantiation. A filename ending .db.js is NOT sufficient evidence — open it.
  - BROWSER_VERIFIED = a *.browser.js in the APP repo that drives the surface through Playwright. Name the file.
  - DEPLOYED = merged to main AND evidence the deploy actually happened.
  - PRODUCTION_PROVEN = someone OBSERVED it working in production. This is rare. Do not award it without a
    document or commit that records an actual production observation. "Merged" is NOT production-proven.

Also determine, for each capability:
  - CANONICAL OWNER: the service/read file(s) that own this truth
  - HTTP ROUTE: is one mounted? grep server.js and src/surfaces/ in the API worktree
  - ASK SPINE: check ${API}/tests/gates/gate_ask_spine_readers.js REGISTRY for a matching key and report its exact
    'state' value; then grep ${API}/src/agent/ask_spine_answer.js for a real gatherFacts branch. Report both.
  - MIGRATION: which migrations/NNN_*.sql file(s) create this domain's schema
  - KNOWN GAP/BLOCKER: quote verbatim any "blocked on" / "not established" / "pending" / "NOT yet" language
    from the code headers, docs/, or the commit messages. Quote it; never paraphrase.

Many files in this repo carry a doctrine header comment stating what the file is and its CLASS/release status.
Read those headers - they are the most reliable single source.
`

const SCHEMA = {
  type: 'object',
  required: ['capabilities'],
  properties: {
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'observed_behavior', 'canonical_owner', 'proof_rung', 'evidence', 'ask_spine', 'gap'],
        properties: {
          name: { type: 'string', description: 'domain / capability name' },
          observed_behavior: { type: 'string', description: 'what it ACTUALLY does today, present tense, no intent' },
          canonical_owner: { type: 'string', description: 'owning service/read file path(s), or NOT_FOUND' },
          proof_rung: { type: 'string', enum: ['REPORTED', 'LOCALLY_EXERCISED', 'BUILT_BUT_DORMANT', 'HTTP_PROVEN', 'BROWSER_VERIFIED', 'DEPLOYED', 'PRODUCTION_PROVEN', 'NOT_FOUND'] },
          proof_rung_evidence: { type: 'string', description: 'the exact file(s) that justify the rung, and what you saw inside them' },
          http_route: { type: 'string', description: 'mounted route path + file, or NOT_FOUND' },
          migration: { type: 'string', description: 'migrations/NNN_*.sql, or NOT_FOUND' },
          ask_spine: { type: 'string', description: 'registry key + exact state value + whether a real gatherFacts branch exists, or NOT_FOUND' },
          production_observed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          production_evidence: { type: 'string', description: 'what document/commit records the production observation, or NOT_FOUND' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'all file paths + commits supporting this row' },
          gap: { type: 'string', description: 'verbatim-quoted blocker language, or NOT_FOUND' },
        },
      },
    },
  },
}

const CLUSTERS = [
  {
    key: 'meeting_evidence',
    prompt: `Inventory MEETING EVIDENCE. Schema: migrations 175_meeting_evidence_provider_inbox.sql,
176_meeting_receipt_v0.sql, 181_meeting_evidence_binding_finality_lineage.sql. Tests to open:
tests/proofs/meeting_evidence_hardening.db.js, meeting_evidence_ingress.test.js, meeting_receipt_extractor_v0.test.js,
meeting_receipt_runtime_v0.test.js, meeting_receipt_v0.test.js. Find the owning src/ files (look in src/evidence,
src/conversation, src/agent). Relevant commits: 2de23cd, f6317b9, 9a6a347, a127a48. Treat "meeting receipt
pipeline", "evidence ingress", and "binding finality/lineage" as potentially SEPARATE capabilities - report each
one you can distinguish with its own row.`,
  },
  {
    key: 'person_ingress',
    prompt: `Inventory the PERSON INGRESS BOUNDARY / person spine. Schema: migrations/177_person_ingress_resolution_kind.sql.
Tests: tests/proofs/person_ingress_hostile.db.js, tests/proofs/person_spine_import_audit.db.js, tests/scenarios/resident_id_evidence_study.js.
Relevant commits: feef925, 03b0248, d62e791, 20e2356, b4556c7. Find the owning src/ files (look in src/entity,
src/identity, src/tenancy). Note carefully whether "external resident identity" is BUILT or only PROPOSED - the
commit messages distinguish proposing from building, and that distinction must survive into the row.`,
  },
  {
    key: 'forward_leasing',
    prompt: `Inventory FORWARD LEASING / leasing cycles (called "Slice 2"). Schema: migrations/178_property_leasing_cycles.sql.
API: tools/leasing_basis_discovery.js, and find the interval-read service/read files (commits 11b0bb1, 4cf6e54,
0a5fe2b, 237a266, 2191215, c7a1f70). APP: forward_leasing_ledger.browser.js (933 lines) - OPEN IT and report how
many assertions it makes and what it actually drives. Commits ee8d1e5 ("route + operator surface (NOT yet
browser-verified)"), 21dfee0 ("browser-verified, 42/42"), 5964848 ("Re-run the Forward Leasing browser proof after
the main merge"), 1974c62, 07519c0. The NOT-yet-browser-verified commit is EARLIER than the browser-verified one -
determine the CURRENT state, and quote the vocabulary ruling in 42470df (term_blocked / term_partially_blocked).`,
  },
  {
    key: 'rent_roll_grain',
    prompt: `Inventory the RENT ROLL / inventory grain work. Schema: migrations/179_activation_source_supersession.sql,
migrations/180_inventory_retirement.sql. API tests: tests/proofs/rent_roll_occupancy_correction.db.js (719 lines),
tests/proofs/skyline_rent_roll_model.db.js, tests/proofs/skyline_rent_roll_read.db.js, tests/proofs/skyline_bed_grain_activation.db.js,
tests/proofs/inventory_retirement.db.js, tests/proofs/ledger_grain_reconciliation.db.js, tests/proofs/surplus_placeholder_repair.db.js,
tests/proofs/tracker_intake.db.js. APP: skyline_rent_roll_units.browser.js (1734 lines) - OPEN IT, report assertion count.
Also tests/rent_roll_row_semantics.test.js, rent_roll_server_classification.test.js, rent_roll_cutover_app.test.js.
Commits: 750335d, e16fe4d, b8ec878, 408c8e6, 38500a5, 812065e, bd3ac15, 3ba8180, 3efffb6.
CRITICAL: docs/RENT_ROLL_CORRECTION_RELEASE_PACKET.md exists in the APP repo and commit 72c7a8e says "production
accepted the corrected reader". READ THAT DOCUMENT CAREFULLY. It may be the ONLY genuine PRODUCTION_PROVEN evidence
anywhere in either repo. Report exactly what it claims was observed in production, and what it does NOT claim.
Distinguish "Current Rent Roll" from "Forward Leasing" - they are different capabilities.`,
  },
  {
    key: 'tenancy',
    prompt: `Inventory TENANCY. Tests: tests/proofs/tenancy_standing_read.db.js, tests/unit/tenancy_ask_spine.test.js,
tests/proofs/tenancy_ask_spine_http.db.js. Commit 234e347 "Tenancy: register the domain with Ask Spine, and make the gate
that enforces 40.2 go red". Find the owning src/tenancy/ files. CRITICAL DISTINCTION the doctrine insists on:
"pending tenancy" and "active/current resident" may be DIFFERENT capabilities with DIFFERENT proof levels. Do not
conflate them. If the evidence proves pending-tenancy creation but NOT active-resident transition, say so with two
separate rows, one of which may be NOT_ESTABLISHED. Also check ad24fab "Hold the one-space-one-tenancy wall in
confirmProposal too" and report what that wall is and where it is enforced.`,
  },
  {
    key: 'release_rail',
    prompt: `Inventory the RELEASE / DEPLOY MACHINERY itself - this is a capability like any other and the ledger needs
a truthful row for it. Read: ${API}/migrations/migrate.js, tests/unit/migration_release_gate.test.js,
docs/release/*.md, and commits 9cbdc11 ("Correct the release rail and the handoff ceiling - both documents were
stale"), 35cf732 ("EXPECTED_SHA is read from git, not copied from a document"), 471f2e0, ed8b7ac ("Close the
untracked-migration hole the SHA fix opened"), 2577f81 ("Document deliberate Render release flow").
Report: (a) how a migration actually gets released, (b) what the CURRENT production ledger ceiling is claimed to be
and by which document, quoted, (c) migrations present on main but NOT released - list them by number, (d) whether
any document states an OBSERVED production ceiling versus an asserted one. This repo's CLAUDE.md warns "a deploy
does NOT migrate" and that this trap has cost time twice - determine whether the seven migrations 175-181 are
released or pending, and what evidence settles it either way.`,
  },
]

phase('Inventory')
const inventories = await pipeline(
  CLUSTERS,
  (c) => agent(`${COMMON}\n\n=== YOUR ASSIGNMENT ===\n${c.prompt}`,
    { label: `inventory:${c.key}`, phase: 'Inventory', schema: SCHEMA })
    .then((r) => ({ key: c.key, capabilities: (r && r.capabilities) || [] })),
  (inv) => {
    if (!inv || !inv.capabilities.length) return inv
    return parallel(inv.capabilities.map((cap) => () =>
      agent(`${COMMON}

=== YOUR ASSIGNMENT: ADVERSARIAL VERIFICATION ===
Another researcher inventoried the capability "${cap.name}" and claims:

  PROOF RUNG:        ${cap.proof_rung}
  JUSTIFIED BY:      ${cap.proof_rung_evidence || 'NOT_FOUND'}
  OBSERVED BEHAVIOR: ${cap.observed_behavior}
  PRODUCTION:        ${cap.production_observed} (${cap.production_evidence || 'NOT_FOUND'})
  ASK SPINE:         ${cap.ask_spine}

YOUR JOB IS TO REFUTE THIS, NOT CONFIRM IT. Open the cited files yourself. Specifically try to prove:
 1. The proof rung is TOO HIGH. Most common failure: a test named *.db.js that never actually connects to
    Postgres, or an "HTTP" test that calls a function directly instead of going through the router, or a
    .browser.js that exists but is skipped / never asserts the surface actually rendered. This repo has a
    documented history of a browser proof passing 13/13 while the browser showed only the sign-in screen.
 2. PRODUCTION_PROVEN or DEPLOYED was awarded on the strength of a MERGE rather than an actual observation.
 3. The "observed behavior" sentence smuggles in INTENT - describing what the code is meant to do rather than
    what it demonstrably does.
 4. The Ask Spine claim is wrong - registered in the registry but with no real gatherFacts branch, or vice versa.

Default to REFUTED when uncertain. An honest lower rung is worth far more than a generous higher one.
Return the rung YOU can defend from evidence you personally opened.`,
        { label: `verify:${cap.name}`.slice(0, 60), phase: 'Verify', schema: {
          type: 'object',
          required: ['refuted', 'defensible_proof_rung', 'reasoning'],
          properties: {
            refuted: { type: 'boolean', description: 'true if the claimed rung or a material claim does not survive' },
            defensible_proof_rung: { type: 'string', enum: ['REPORTED', 'LOCALLY_EXERCISED', 'BUILT_BUT_DORMANT', 'HTTP_PROVEN', 'BROWSER_VERIFIED', 'DEPLOYED', 'PRODUCTION_PROVEN', 'NOT_FOUND'] },
            defensible_production_observed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
            corrected_observed_behavior: { type: 'string', description: 'present-tense, intent-free restatement you can defend' },
            reasoning: { type: 'string', description: 'what you opened and what it actually showed' },
          },
        } })
        .then((v) => ({ ...cap, verdict: v }))
    )).then((verified) => ({ key: inv.key, capabilities: verified.filter(Boolean) }))
  }
)

const all = inventories.filter(Boolean).flatMap((i) =>
  (i.capabilities || []).map((c) => ({ cluster: i.key, ...c })))

const downgraded = all.filter((c) => c.verdict && c.verdict.refuted)
log(`${all.length} capabilities inventoried; ${downgraded.length} had a claim refuted on verification`)

return {
  api_main: '77f93f5',
  app_main: 'c6769ba',
  capability_count: all.length,
  refuted_count: downgraded.length,
  capabilities: all,
}
