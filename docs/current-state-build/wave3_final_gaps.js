export const meta = {
  name: 'audit-wave-3-final',
  description: 'Close the last real gaps: migrations 001-119 schema audit, src/shared + governance, and a census of all 292 test files against what CI actually runs',
  phases: [
    { title: 'Survey', detail: 'four never-covered areas' },
    { title: 'Critic', detail: 'after three waves, what is STILL unlisted' },
  ],
}

const API = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-api'
const APP = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-app'

const COMMON = `
You are closing the LAST gaps in a capability audit of Property Spine, a real-estate ops platform.
Three waves already ran. docs/CURRENT_STATE.md on main is the live result — READ IT FIRST so you add
to it rather than re-deriving what is already there. Full prior detail is in
docs/current-state-build/03_WAVE1_RESULTS.md and 05_WAVE2_RESULTS.md.

THE ONE RULE: report only what repo evidence supports. Never infer, never recall, never fill a gap with a
plausible guess. Where you cannot find evidence, write exactly NOT_FOUND.

Worktrees, both at current main:
  API: ${API}   (main = b7720b2)
  APP: ${APP}

DO NOT IMPROVE THE TAXONOMY. Describe what exists at the grain the evidence supports.

PROOF RUNG vocabulary (pick the HIGHEST with real evidence, and name that evidence):
  REPORTED | LOCALLY_EXERCISED | BUILT_BUT_DORMANT | HTTP_PROVEN | BROWSER_VERIFIED | DEPLOYED | PRODUCTION_PROVEN
  - HTTP_PROVEN = ONE test with real Postgres AND a real router. OPEN THE FILE. A .db.js name proves nothing.
    A hand-built fake pool passed to a real router is NOT HTTP_PROVEN — that pattern is CONFIRMED PRESENT in
    this repo (utility_http.test.js, contracted_service_http.test.js, teamaccess_sms_delivery.test.js).
  - BUILT_BUT_DORMANT = exists, nothing in src/ or server.js requires it. PROVE with a repo-wide grep.
  - PRODUCTION_PROVEN = OBSERVED working in production. Rare. Merged/deployed is NOT proven.

Quote blocker language verbatim. Never paraphrase a gap.
`

const SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    headline: { type: 'string', description: 'the single most important thing found, one sentence' },
    method_note: { type: 'string', description: 'exactly what you searched and what you did NOT — a bounded scope is fine, an unstated one is a false claim' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'detail', 'evidence'],
        properties: {
          what: { type: 'string' },
          detail: { type: 'string', description: 'present tense, what IS, no intent' },
          proof_rung: { type: 'string', enum: ['REPORTED','LOCALLY_EXERCISED','BUILT_BUT_DORMANT','HTTP_PROVEN','BROWSER_VERIFIED','DEPLOYED','PRODUCTION_PROVEN','NOT_APPLICABLE','NOT_FOUND'] },
          severity: { type: 'string', enum: ['critical','notable','minor','informational'] },
          evidence: { type: 'string', description: 'file paths, line numbers, verbatim quotes' },
        },
      },
    },
  },
}

const AREAS = [
  {
    key: 'schema_001_119',
    prompt: `Audit MIGRATIONS 001-119 — the 120 migrations NEVER schema-audited (a prior wave covered 120-181 only).
Extract every CREATE TABLE across all of them. For each table, determine which capability owns it by grepping
${API}/src/ and server.js for REAL callers — not by matching names. Report:
 (a) every table with NO owning capability — a domain that exists in the database and in nobody's map;
 (b) any table created then later renamed or dropped by a subsequent migration (a literal-name grep gives a
     false orphan — a prior wave hit exactly this with opening_positions, renamed by migration 159, so CHECK
     for renames before declaring an orphan);
 (c) missing/skipped migration numbers in 001-119;
 (d) any table whose only writer is a tool/ script or a test rather than a live src/ service.
This is the largest single uncovered surface in the audit. Be systematic and state your method.`,
  },
  {
    key: 'shared_governance',
    prompt: `Inventory ${API}/src/shared/ (21 files) and ${API}/src/governance/ — NEVER assigned to any wave.
src/shared/ holds the canonical obligation engine (obligation_engine.js, obligation_transitions.js) and
database_ssl.js among others; it has only ever surfaced incidentally. Treat each file as potentially its own
capability. For each: what it is, who requires it (repo-wide grep), is it live-wired or dormant, what proves it.
Flag especially: anything cross-cutting that many domains depend on (a shared primitive failing silently is
worse than a leaf failing), anything with no caller, and any seed/fixture/demo machinery reachable at runtime —
doctrine says "Demo data may exist. Demo paths may not."`,
  },
  {
    key: 'test_census',
    prompt: `Census ALL ~292 files in ${API}/tests/. Every proof rung in the whole audit rests on these and nobody
has ever checked them as a body. 292 is too many to open individually, so:
 STEP 1 — classify ALL of them mechanically by grep: real Postgres (require('pg') / harnessConnectionString),
   real HTTP (http.createServer / listen( / fetch against a local port), fake pool (a hand-built object with
   .query/.connect passed where a pool belongs), browser (playwright/chromium), pure unit (none of the above).
 STEP 2 — OPEN A SAMPLE of at least 12 spanning every category and verify your grep classification was right.
   Report where grep misclassified, if anywhere. A classification you did not verify is a guess.
 STEP 3 — report counts per category, and NAME every file in the fake-pool category (the known ones are
   utility_http.test.js, contracted_service_http.test.js, teamaccess_sms_delivery.test.js — find the rest).
 STEP 4 — find DEAD tests: files that cannot pass as written (hardcoded UUIDs that no longer exist, missing
   fixtures, referencing deleted modules). A prior finding says four are pinned to a hardcoded demo UUID and
   nothing runs them — find those four by name and any others like them.
The deliverable is a truthful census, not a list of every file.`,
  },
  {
    key: 'ci_reality',
    prompt: `Determine WHAT ACTUALLY RUNS IN CI versus what merely exists. Read ${API}/.github/workflows/verify.yml
and trace exactly which test files it executes — follow any script it calls (tests/e2e/verify_all.sh,
package.json scripts, any runner). Then compare that executed set against the ~292 files in ${API}/tests/.
Report:
 (a) how many test files CI actually executes, and how many exist;
 (b) NAME the significant proofs that exist but CI never runs — a proof nothing runs is documentation, not proof,
     and this repo's own doctrine says "Green is a claim about what was measured";
 (c) whether any gate/guard files (tests/gate_*.js) are skipped by CI;
 (d) what CI does on failure — does it block a merge, or just report;
 (e) any test CI runs that requires a real database, and how CI provides one.
This directly determines how much every "CI green" claim in the audit is actually worth.`,
  },
]

phase('Survey')
const results = await parallel(AREAS.map((a) => () =>
  agent(`${COMMON}\n\n=== YOUR ASSIGNMENT ===\n${a.prompt}`,
    { label: `survey:${a.key}`, phase: 'Survey', schema: SCHEMA })
    .then((r) => ({ key: a.key, ...r }))
))

const found = results.filter(Boolean)
const all = found.flatMap((r) => (r.findings || []).map((f) => ({ area: r.key, ...f })))
log(`wave 3 surveyed ${all.length} findings across ${found.length} areas`)

phase('Critic')
const critic = await agent(`${COMMON}

=== YOUR ASSIGNMENT: THE FINAL COMPLETENESS CRITIC ===
Four survey waves have now run over this repo. Your only job is to find what they STILL missed.

Already covered across waves 1-3: Asset Management (compliance/utility/contracted_service/insurance/tax/debt/
equity), the full leasing lifecycle, operations (maintenance/technician/comms/obligations), platform core
(identity/entity/money/evidence/conversation/agent/release0/surfaces), meeting evidence, person ingress,
forward leasing, rent-roll grain, tenancy, the release rail, teams/access/roles, the management door,
onboarding intake, money/pricing at grain, the app repo, server.js inline routes, tools/, migrations 001-181,
src/shared, src/governance, and the test suite.

Find what is STILL unaccounted for. Look specifically at things that are not source files and not tables:
 · ${API} root-level files (scripts, configs, .sh, .json) and what they do
 · ${APP} beyond its doors — its build/deploy path, any config, any generated artifact
 · package.json scripts in BOTH repos — which are real entry points, which are dead
 · any .env.example / config template and whether every documented variable actually has a code reader
   (a prior wave found TWILIO_FROM_NUMBER documented but read by nothing)
 · docs/ itself — name any doc that makes a present-tense claim CONTRADICTED by current source
 · anything in either repo that would surprise a new engineer

Report ONLY things no prior wave listed. If you find nothing material, say so plainly — an honest empty
result is worth more than padding.`,
  { label: 'critic:final', phase: 'Critic', schema: SCHEMA })

return {
  api_main: 'b7720b2',
  finding_count: all.length,
  headlines: found.map((r) => ({ area: r.key, headline: r.headline })),
  method_notes: found.map((r) => ({ area: r.key, note: r.method_note })),
  findings: all,
  critic: critic || null,
}
