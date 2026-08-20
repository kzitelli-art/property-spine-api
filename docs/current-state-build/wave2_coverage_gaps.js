export const meta = {
  name: 'current-state-wave-2',
  description: 'Close the coverage gaps: teams, management door, rent-roll intake, money/pricing, the whole app repo, server.js inline routes, tools/ — then a completeness critic',
  phases: [
    { title: 'Inventory', detail: 'seven uncovered areas, evidence-cited' },
    { title: 'Completeness', detail: 'critic sweeps for anything still unlisted' },
  ],
}

const API = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-api'
const APP = '/tmp/claude-0/-home-user/35ef8d61-d4f6-594f-9fd5-4adbc648960d/scratchpad/main-app'

const COMMON = `
You are inventorying evidence for a "current state" ledger for Property Spine, a real-estate ops platform.
THE ONE RULE: report only what repo evidence supports. Never infer, never recall, never fill a gap with a
plausible guess. Where you cannot find evidence, write exactly NOT_FOUND.

Two git worktrees, both at CURRENT main. Read ONLY these paths:
  API repo: ${API}   (main = 9e09a64, includes PR #123/#124: docs/CURRENT_STATE.md now exists — read it first to see what prior waves already found, so this pass adds to it rather than re-deriving)
  APP repo: ${APP}   (main = c6769ba)

DO NOT IMPROVE THE TAXONOMY. Describe what exists at the grain the evidence supports. If a directory holds
nine distinguishable capabilities, report nine rows. Do not merge them into a tidier three because three
reads better. Premature normalization is how intent sneaks into current-state reporting.

PROOF RUNG is a controlled vocabulary. Pick the HIGHEST rung you find real evidence for, and name that evidence:
  REPORTED | LOCALLY_EXERCISED | BUILT_BUT_DORMANT | HTTP_PROVEN | BROWSER_VERIFIED | DEPLOYED | PRODUCTION_PROVEN
Definitions that decide most cases:
  - LOCALLY_EXERCISED = unit assertions, NO real database.
  - HTTP_PROVEN = ONE test that connects to REAL Postgres AND drives REAL HTTP through the actual router.
    OPEN THE FILE. Look for require('pg') / receipt.harnessConnectionString() / http.createServer / listen().
    A filename ending .db.js proves nothing. A test that passes a hand-built fake pool object to a real router
    is NOT HTTP_PROVEN — that pattern is already confirmed present in this repo (utility_http.test.js,
    contracted_service_http.test.js) and you must catch it wherever else it appears.
  - BROWSER_VERIFIED = a *.browser.js driving real Chromium via Playwright. CHECK WHETHER IT USES A REAL
    DATABASE — several in this repo use a fakePool() stub behind the browser. Say which.
  - BUILT_BUT_DORMANT = code exists, nothing in src/ or server.js requires it. PROVE IT with a repo-wide grep.
  - PRODUCTION_PROVEN = someone OBSERVED it working in production. Rare. "Merged" is NOT production-proven.

For each capability also determine:
  - CANONICAL OWNER (file paths), HTTP ROUTE (grep server.js AND src/surfaces/), MIGRATION (migrations/NNN_*.sql)
  - ASK SPINE: check ${API}/tests/gate_ask_spine_readers.js REGISTRY for a key, and grep
    ${API}/src/agent/ask_spine_answer.js for a real 'facts.<name> =' branch. Report both. Note that the gate's
    STANDING_READ_DIRS is ["src/asset","src/tenancy"] only, so most areas are structurally undiscoverable by it.
  - KNOWN GAP: quote verbatim any "blocked on"/"not established"/"pending"/"DORMANT"/"NOT yet"/"never" language
    from file headers, docs/, or commit messages. Quote, never paraphrase.

Most files carry a doctrine header stating what the file is and its CLASS/release status. Read those headers —
they are the most reliable single source, and they frequently self-declare dormancy.

=== ALSO VERIFY THESE CLAIMS FROM AN INTERNAL ARCHITECTURE MAP ===
The owner maintains a map of believed state. It is INTENT, never a source for a row. Treat each claim below as a
QUESTION to answer from code, and report which of three buckets it lands in:
  CONFIRMED (map right) · NEVER_BUILT (map claims it, code lacks it) · BUILT_UNMAPPED (code has it, map missed it)
The map has already been proven wrong in BOTH directions, so do not defer to it and do not dismiss it.

Claims relevant to your assignment (skip any outside your area):
 · "Non-KZ staff invite -> session -> correct property: MISSING (unproven). Mike has never passed through it."
 · "Exclusion wall (a user WITHOUT Skyline is kept out): UNPROVEN, gate only tested from inside."
 · "beginDemoSession / 2026letsgo bootstrap: RETIRE-ON-ACTIVATION, class 2 adapter."
 · "13+ raw comm_events insert sites vs 1 canonical: write-path sprawl is the root condition."
 · "Operations line campaign: PARTIAL, rejected twice."
 · "COMMITMENT_LEDGER_MODE=enabled: OPEN RISK, write surface open while doctrine says fail-closed."
 · "Money Inbox: MISSING, 3 phantom endpoints, unbuilt cluster."
 · "Marketing (pricing/survey/listings): BUILT/fixtures, likely fixture-only, no API calls."
 · "Renewals front end: BUILT/fixtures, full 3-bucket dash, no renewal service on API."
 · "Rent Roll (current): PARTIAL, legacy operator-key routes -> fixture fallback, no session-scoped live read."
 · "28 phantom endpoints, 4 unbuilt clusters" — COUNT the phantom endpoints you can actually find in your area
    (an app call to a route the API does not define, or a route defined but unreachable).
 · "Field search + reach-the-tenant: MISSING, residents have ~0 phones."
`

const SCHEMA = {
  type: 'object',
  required: ['capabilities'],
  properties: {
    area_note: { type: 'string', description: 'anything about this area the row list cannot carry' },
    capabilities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'observed_behavior', 'canonical_owner', 'proof_rung', 'evidence', 'gap'],
        properties: {
          name: { type: 'string' },
          observed_behavior: { type: 'string', description: 'what it ACTUALLY does today. Present tense. No intent.' },
          canonical_owner: { type: 'string' },
          proof_rung: { type: 'string', enum: ['REPORTED', 'LOCALLY_EXERCISED', 'BUILT_BUT_DORMANT', 'HTTP_PROVEN', 'BROWSER_VERIFIED', 'DEPLOYED', 'PRODUCTION_PROVEN', 'NOT_FOUND'] },
          proof_rung_evidence: { type: 'string', description: 'exact file(s) and what you saw INSIDE them — note fake pools' },
          http_route: { type: 'string' },
          migration: { type: 'string' },
          ask_spine: { type: 'string' },
          production_observed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
          evidence: { type: 'array', items: { type: 'string' } },
          gap: { type: 'string', description: 'verbatim quote, or NOT_FOUND' },
        },
      },
    },
  },
}

const CLUSTERS = [
  {
    key: 'teams_access',
    prompt: `Inventory TEAMS, ACCESS, INVITES, ROLES AND ENTITLEMENT. Start at ${API}/src/identity/teamaccess.js and
follow it. Cover: team invites (creation, acceptance, expiry), property_team_assignments, role assignment, module
entitlement (allowed_modules), staff onboarding/enrollment, and any admin surface that grants or revokes access.
Also grep ${APP}/index.html for team/invite callers — CLAUDE.md warns that gating team-invites once broke the live
invite flow because nobody grepped the app first. Report whether the app still calls these routes. Check
migrations for the team/assignment tables. This area is the authority spine — be exhaustive about which routes
mutate access and what authenticates them.`,
  },
  {
    key: 'management_door',
    prompt: `Inventory the MANAGEMENT DOOR and the operator reverse-funnel surfaces in ${API}/src/surfaces/:
management.js, management_read.js, board.js, desks.js, portfolio.js, property_surface.js, owner.js, orgchart.js,
roomowners.js. These are one of the four operating doors (Leasing · Management · Maintenance · Asset Management)
and got only one shallow line in a prior pass. Treat each file as potentially its own capability. For each: what
does it read, is it mounted, what proves it. Note especially any file that self-declares an honesty rule (e.g.
desks.js reportedly returns status 'unavailable' rather than a fake number) and whether that rule is tested.
Also check ${APP} for the matching doors and any *.browser.js proof.`,
  },
  {
    key: 'onboarding_intake',
    prompt: `Inventory ONBOARDING AND RENT ROLL INTAKE — the path by which a rent roll becomes Spine truth.
Sweep ALL of ${API}/src/onboarding/. Known files include deal_setup.js, deal_service.js, activation_service.js,
source_artifact_service.js, rent_roll_field_map.js, onboarding.js, onboarding_funnel.js, intake.js,
public_review.js — list the directory yourself and cover everything in it. Cover: file upload and retention,
hashing, parsing/field mapping, the proposal→review→confirm chain, import batches, and what makes a rent roll
row become a canonical lease/tenancy. Check migrations 153 (source_artifacts), 154-159 (deal authority,
membership, lineage, opening positions). Distinguish carefully: Deal Setup (the container) vs rent roll INTAKE
(the parsing/mapping) vs ACTIVATION (proposal→canonical) — these may be separate capabilities with different
proof levels. Also check ${APP} for deal setup / rent roll upload surfaces and browser proofs.`,
  },
  {
    key: 'money_pricing',
    prompt: `Inventory MONEY, PRICING AND CHARGES at real grain — a prior pass lumped ~26 files into one row, which
is exactly the premature normalization we must avoid. Sweep ALL of ${API}/src/money/. Cover as separate rows at
minimum: money events/accounting truth (money.js), bank bridge + Plaid (bankbridge.js, bankintake.js, plaid.js),
charges and payments, attributions, reporting.js, exposure.js, moneyboard.js, the governed-charge chain
(governed_charges.js, governed_charge_cutover.js, economic_classes.js), the pricing chain (pricing_authority.js,
pricing_lifecycle.js, pricing_publication_contract.js, effective_pricing.js, pricing_decision_packet.js),
concessions (concession_schedule_compiler.js, concessions_read.js), and the adapters (economic_adapter.js,
pricing_adapter.js). Several self-declare dormancy — quote them. Determine which pricing/charge records actually
EXIST as published governed terms versus which machinery is merely built. Check docs/PRICING_*.md and
docs/GOVERNED_ECONOMIC_TERMS.md and quote status language verbatim, noting each doc's date.`,
  },
  {
    key: 'app_repo',
    prompt: `Inventory THE ENTIRE APP REPO (${APP}) — no prior pass covered it systematically. It is half of every
browser proof and no ledger row is complete without it.
(a) List every *-door.js / surface file (asset-management-door.js, contracted-services-door.js,
conversations-board.js, followups-door.js, leasing-experience.js, moveins-door.js, person-card-information.js,
readiness-door.js, staff-agent-door.js, turn-scope-door.js, unit-triage-door.js, unit-turn-page.js,
utilities-door.js, work-acceptance-door.js, work-lifecycle-door.js, and any others). For each: what API resource
does it read, is it reachable in index.html, and is there a *.browser.js proof for it.
(b) List every *.browser.js and report for each: does it launch real Chromium, does it use a REAL database or a
fakePool() stub, roughly how many assertions, and does it take screenshots.
(c) Report which doors have NO browser proof at all.
(d) Check index.html for PRODUCTION_LIVE_RESOURCES / loadResource registrations and report which resources are
declared liveRequired.
This is a large sweep — prioritise breadth (cover every door) over depth on any one.`,
  },
  {
    key: 'server_inline',
    prompt: `Inventory ROUTES AND CAPABILITIES DEFINED DIRECTLY IN ${API}/server.js. CLAUDE.md warns explicitly:
"server.js is 3,000+ lines at the root and defines routes. A src/-only search silently misses it — that is
exactly how Build 0 reported four property-creation doors when there were five." Every prior pass in this
inventory searched src/ only.
Report: (a) every route defined inline in server.js rather than in a mounted module, with its auth guard;
(b) every module mounted, in order, so we have the definitive mount map; (c) any route with NO authentication
or with only a shared-key guard; (d) health/diagnostic/admin endpoints; (e) anything that looks like a fixture,
seed, demo or repair door reachable over HTTP. Quote the guard for each. Also check ${API}/src/shared/ for
seed_endpoint.js / seed_snapshot.js / snapshot_loader.js and report whether they are HTTP-reachable and what
gates them — doctrine says "Demo data may exist. Demo paths may not."`,
  },
  {
    key: 'tools_ops',
    prompt: `Inventory the ${API}/tools/ directory and any root-level operational scripts. These are how releases,
repairs and establishments actually happen, so the ledger needs truthful rows for them. Sweep the directory tree
(it has subdirectories such as tools/debt, tools/equity, tools/repair, tools/step7). For each meaningful tool:
what it does, whether it is dry-run by default, whether it writes to a database, and — critically — whether there
is any RECEIPT or evidence in the repo that it was ever actually RUN (look for docs/*RECEIPT*, docs/release/*,
committed output files, screenshots). A tool that has never been run is a different current-state fact from one
that has. Note especially tools/step7/prove_guard_active.js (reportedly run against live production instance
kbtb6, 16/16) — verify what evidence backs that. Also report any tool that targets PRODUCTION by default.`,
  },
]

phase('Inventory')
const results = await parallel(CLUSTERS.map((c) => () =>
  agent(`${COMMON}\n\n=== YOUR ASSIGNMENT ===\n${c.prompt}`,
    { label: `inventory:${c.key}`, phase: 'Inventory', schema: SCHEMA })
    .then((r) => ({ key: c.key, area_note: r && r.area_note, capabilities: (r && r.capabilities) || [] }))
))

const found = results.filter(Boolean)
const all = found.flatMap((r) => (r.capabilities || []).map((c) => ({ area: r.key, ...c })))
log(`wave 2 inventoried ${all.length} capabilities across ${found.length} areas`)

const covered = `
ALREADY INVENTORIED (do not re-report these unless you find something materially wrong):
 Asset Management: compliance, utility, contracted_service, insurance, tax, debt, equity
 Leasing lifecycle: lead intake, tours/attribution, conversion rail, AI leasing strategy, leasing desk,
   application submission/lifecycle, application target authority, proposed terms, lease packet, executed
   lease intake, tenancy anchor, move-in/economic tenancy, lease void, notice to vacate, dated positions,
   renewals, deal setup
 Operations: work orders, not-done routing, unit triage, turn scope, work acceptance, proof evaluation chain,
   readiness, turnover, turn priority, technician SMS loop, acceptance, lifecycle, evidence/MMS, operator
   actions, resident-safe updates, comms boundary, tenantlink, prospect capture, movein delivery, obligations door
 Platform: legal entity, staff session, property creation, identity resolution, identity graph, capability
   evaluator, org/super admin, activation.js (dead), A2P legal pages, money events, pricing catalog, slice 9
   evidence, conversational seams, ask spine, staff agent, leasing agent, adapters, release 0, asset mgmt shell,
   board/desks/management, rent roll reads, availability, unit turn, work order status read, portfolio
 New domains (separate pass): meeting evidence, person ingress, forward leasing, rent roll grain/inventory
   retirement, tenancy, release rail
 Wave 2 (this run): ${found.map((r) => r.key).join(', ')}
`

phase('Completeness')
const critics = await parallel([
  `Sweep ${API}/src/ and list EVERY subdirectory and, for each, every file. Compare against the covered list
   below. Report every file that is NOT accounted for by any covered capability, and for each say in one line
   what it appears to be (from its header) and whether anything requires it. Your output is a GAP LIST — the
   point is to find what the inventory missed, not to re-describe what it found.`,
  `Find capabilities that exist as SCHEMA but have no inventory row. List every table created by every file in
   ${API}/migrations/ (migrations 120-181), then for each table say which covered capability owns it. Report
   every table with NO owning capability — those are domains that exist in the database and in nobody's map.
   Also report any migration whose number is skipped or missing entirely.`,
  `Audit the covered list for DANGEROUS OMISSIONS of a different kind: things that are neither src/ files nor
   tables. Check ${API} and ${APP} for: cron/scheduled jobs, webhooks and their providers, external
   integrations (Twilio, Plaid, Acuity, Outlook, Anthropic/model calls, Render, Neon), environment flags that
   gate behavior (grep for process.env across src/ and report every flag that changes product behavior), and
   background/async processes. For each, report what it is, whether it is active, and what evidence says so.`,
].map((p, i) => () =>
  agent(`${COMMON}\n\n=== YOUR ASSIGNMENT: COMPLETENESS CRITIC ${i + 1} ===\n${p}\n\n${covered}`,
    { label: `critic:${['files', 'schema', 'external'][i]}`, phase: 'Completeness', schema: {
      type: 'object',
      required: ['missed'],
      properties: {
        missed: {
          type: 'array',
          items: {
            type: 'object',
            required: ['what', 'why_it_matters'],
            properties: {
              what: { type: 'string', description: 'the file, table, flag or integration nobody listed' },
              appears_to_be: { type: 'string' },
              has_caller: { type: 'string', description: 'what requires/uses it, or NOT_FOUND (= dormant)' },
              why_it_matters: { type: 'string' },
            },
          },
        },
        summary: { type: 'string' },
      },
    } })
))

const missed = critics.filter(Boolean).flatMap((c) => c.missed || [])
log(`completeness critics surfaced ${missed.length} unlisted items`)

return {
  api_main: '9e09a64',
  app_main: 'c6769ba',
  wave2_capability_count: all.length,
  wave2_capabilities: all,
  area_notes: found.map((r) => ({ area: r.key, note: r.area_note })).filter((x) => x.note),
  missed_count: missed.length,
  missed_items: missed,
  critic_summaries: critics.filter(Boolean).map((c) => c.summary).filter(Boolean),
}
