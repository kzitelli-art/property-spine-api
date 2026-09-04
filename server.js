// ════════════════════════════════════════════════════════════════════
//  PROPERTY SPINE — API server v1
//  Intentionally tiny. Two real endpoints prove the round trip:
//    POST /properties  → create a property
//    GET  /properties  → read them back
//    GET  /health      → is the server + db alive
//  Every other endpoint later is THIS pattern repeated.
// ════════════════════════════════════════════════════════════════════
const express = require("express");
//  A rejected async handler becomes an honest 500 instead of a dead process.
//  Installed before any Router exists — see src/shared/async_route_safety.js.
const { installAsyncRouteSafety, terminalErrorHandler } = require("./src/shared/async_route_safety");
installAsyncRouteSafety();
const cors = require("cors");
const { Pool } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");
const multer = require("multer");          // handles file uploads (rent roll .xlsx/.csv)
const leasingIntelModule = require("./src/leasing/leasing_intel");
const leasePacketsModule = require("./src/applications/lease_packets");
const applicationsModule = require("./src/applications/applications");
const { createConversionClosureAuthority } = require("./src/leasing/conversion_obligation_closure");
// created ONCE; handed ONLY to the conversion rail below — never to the engine,
// never to any other module. That exclusivity IS the structural guarantee.
const __conversionClosureAuthority = createConversionClosureAuthority();
const XLSX = require("xlsx");              // parses the spreadsheet to rows
const maintenanceModule = require("./src/maintenance/maintenance");  // isolated maintenance routes
const { makeWorkOrderService } = require("./src/maintenance/work_order_service"); // the ONE work-order create path
const downUnitsModule = require("./src/tenancy/down_units");      // isolated down-units routes
const orgchartModule = require("./src/surfaces/orgchart");
const roomOwnersModule = require("./src/surfaces/roomowners"); // thin room-owner API over assignments (041); six rooms → owners
const moneyModule = require("./src/money/money");
const turnoversModule = require("./src/maintenance/turnovers");
const moveinModule = require("./src/tenancy/movein");
const { recordEffectivePossession, spacePosition } = require("./src/tenancy/space_position"); // canonical dated space position — shared possession writer + read
const noticeModule = require("./src/tenancy/notice");        // Availability Slice A: resident notice → future supply
const onboardingModule = require("./src/onboarding/onboarding");   // isolated onboarding (takeover) routes
const onboardingFunnel = require("./src/onboarding/onboarding_funnel"); // six-step NOI-goal onboarding funnel (revenue/roles/noi-goal; honest mode)
const registryModule = require("./src/identity/registry");        // property alias registry (canonical key / bridge step zero)
const identifyModule = require("./src/identity/identify");        // property-agnostic front door: fast identity-first pass (read-only) + confirm-write
const ownerModule = require("./src/surfaces/owner");              // owner-facing aggregate endpoints (property cards + needs-attention queue)
const bankIntakeModule = require("./src/money/bank_intake");   // bank intake: onboarding/training pass (012)
const exposureModule = require("./src/money/exposure");
const reportingModule = require("./src/money/reporting");
const chargesModule = require("./src/money/charges"); // income rung slice 2A: charge generation (the claim side)
const paymentsModule = require("./src/money/payments"); // income rung slice 3: payment proof (apply + cash proof)
const bankBridgeModule = require('./src/money/bank_bridge');
const autoConfirmModule = require('./src/applications/autoconfirm');
const moneyBoardModule = require('./src/money/money_board');
const attributionsModule = require('./src/money/attributions');
const portfolioModule = require('./src/surfaces/portfolio');
const snapshotLoaderModule = require('./src/shared/snapshot_loader');
const seedEndpointModule = require('./src/shared/seed_endpoint');
const managementReadModule = require('./src/surfaces/management_read');
const propertySurfaceModule = require('./src/surfaces/property_surface');
const plaidModule = require('./src/money/plaid'); // Plaid: second feed into bank_transactions (031); fail-soft when unconfigured
const compareModule = require("./src/money/compare");   // report comparison layer (the hook)
const explainModule = require("./src/money/explain");
const tenantLinkModule = require("./src/comms/tenant_link"); // tenant text line Phase 1: connection (invite link → verify → session)
const legalRoutesModule = require("./src/identity/legal_routes_block"); // A2P 10DLC public legal pages (privacy + SMS terms) — carrier-reachable
const teamAccessModule = require("./src/identity/team_access");
const staffSessions = require("./src/identity/staff_session_service");        // the ONE session resolver
const propertyCreation = require("./src/identity/property_creation_service"); // Build 1A-1: THE property write
const superAdminModule = require("./src/identity/super_admin");
const orgAdminModule   = require("./src/identity/org_admin");
const smsTransport = require("./src/comms/sms"); // SMS transport (Twilio) — fail-soft when unconfigured
const communicationsBoundary = require("./src/comms/communications_boundary"); // the permanent communications boundary — one inbound resolver, one outbound gate
const meetingEvidenceModule = require("./src/meeting_evidence/meeting_evidence_routes");
// uploads held in memory; 25mb cap — OMs are image-heavy and run large, but a
// runaway file still can't choke the box. Oversize returns a clean 413 below.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// The AI client. ANTHROPIC_API_KEY is set as an environment variable in
// Render — never hardcoded. This is the "rent the model" piece: the model
// lives at Anthropic; our server calls it and feeds it our data.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
// ── CORS ──────────────────────────────────────────────────────────────
// /operator/ gets its OWN fail-closed CORS policy. It is NEVER reflective and NEVER
// wildcard: it allows EXACTLY the configured OPERATOR_APP_ORIGIN and nothing else. If
// OPERATOR_APP_ORIGIN is unset, cross-origin /operator/ requests are DENIED (the
// surface is permissive only when correctly configured — the opposite of a reflective
// fallback). CORS is not authorization, but it stops an arbitrary site from using a
// browser that holds the in-memory staff token to drive the operator surface.
const OPERATOR_APP_ORIGIN = String(process.env.OPERATOR_APP_ORIGIN || "").trim();
function isOperatorPath(p) { return p === "/operator" || p.startsWith("/operator/"); }
//  Deal Setup. SESSION-GATED, not public: every route runs requireHuman
//  (x-staff-session → a real users row) before it does anything, and every
//  write records the human it resolved. It skips the operator-KEY gate for
//  the same reason /operator/*, /admin/* and /org/* do — the surface is
//  driven by a browser holding a session, not a key.
//  Exact-boundary, so '/deal-setups' does NOT bypass the gate.
//
//  `/asset/*` is the TEMPORARY alias for the app currently in production;
//  it is rewritten inside deal_setup.js and carries its removal condition
//  there. Both must pass this gate or the alias would 401 instead of
//  working, which is the opposite of what a compatibility bridge is for.
function isDealSetupPath(p) {
  return p === "/deal-setup" || p.startsWith("/deal-setup/")
      || p === "/asset" || p.startsWith("/asset/");   // ⏳ alias — see deal_setup.js
}

const operatorCors = cors({
  origin: function (origin, cb) {
    // server-to-server / curl (no Origin header) is allowed (CORS only governs browsers).
    if (!origin) return cb(null, true);
    if (OPERATOR_APP_ORIGIN && origin === OPERATOR_APP_ORIGIN) return cb(null, true);
    return cb(null, false); // unset OR mismatch → denied (fail closed)
  },
  allowedHeaders: ["content-type", "x-staff-session"],
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false,
});

// general CORS for everything else (tenant/demo/public pages). Permissive origin is
// fine here because those routes carry their own per-door secrets; the operator
// surface above does NOT rely on this.
const generalCors = cors({
  allowedHeaders: ["content-type", "x-operator-key", "x-staff-session", "accept"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

app.use((req, res, next) => {
  if (isOperatorPath(req.path)) return operatorCors(req, res, next);
  return generalCors(req, res, next);
});
app.set("trust proxy", 1); // Render = one proxy hop: makes req.ip the real client so per-IP rate limits actually bind per client

// The database connection. DATABASE_URL is set as an environment variable
// in Render — NEVER hardcoded here. Neon requires SSL.
//
//  ── SSL IS ON EVERYWHERE EXCEPT A LOCAL HOST ────────────────────────
//  The rule used to live here as a private function, which meant nothing
//  else could reach it — and a tool that needed the same rule hardcoded
//  SSL instead and took CI red. It now lives in src/shared/database_ssl.js,
//  once, with the full account of why. Behaviour here is unchanged.
const { databaseSsl } = require("./src/shared/database_ssl");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSsl(process.env.DATABASE_URL),
});
//  pg emits 'error' on the POOL when an IDLE client fails (Neon closes idle
//  connections; a network reset arrives on a client nobody is using). With
//  no listener that is an unhandled 'error' event, which terminates the
//  process. The client is already discarded by the pool; the next checkout
//  gets a fresh one. Log it and stay up.
pool.on("error", (err) => {
  console.error("[pg pool] idle client error (connection discarded, service continues):", err && err.message);
});

// ── READ AI WEBHOOK — raw bytes before JSON middleware ───────────────
//  This route is mounted before global express.json() so X-Read-Signature
//  is checked against the exact provider bytes. The route itself verifies
//  the configured connection and HMAC before parsing JSON.
app.use("/integrations/read-ai/webhook", meetingEvidenceModule.readAiWebhook({ pool }));
app.use("/integrations/read-ai/webhook", meetingEvidenceModule.readAiWebhookErrorHandler({ pool }));

app.use(express.json({ limit: "1mb" }));  // body-size cap — stops oversized payloads

// ── operator gate (Phase 0 auth centralization) ──────────────────────
// ONE shared gate for the whole operator data surface. Replaces the old
// optional API_KEY floor. Rules:
//   • Public doors are allowlisted EXPLICITLY (they carry their own auth):
//       /health                  — uptime checks
//       /tenant/* and /t/*       — tenant portal (session/token auth)
//       /public/*                — public review door (its own password)
//       /intake/*                — field capture door incl. the Twilio
//                                  webhook (its own INTAKE_PASSWORD)
//   • EVERYTHING else requires OPERATOR_KEY sent as x-operator-key.
//   • Fail closed: if OPERATOR_KEY is unset, locked routes return 503,
//     never silently open.
// The per-module copies of requireOperator (board/desks/tenant_link) still
// run after this and check the SAME key — redundant but harmless; slated
// for removal in a later cleanup, not worth a 3-file deploy today.
const OPERATOR_KEY = process.env.OPERATOR_KEY;
const PUBLIC_EXACT = new Set([
  "/health", "/leasing/intake", "/communications/inbound-sms",
  // The applicant's browser POSTs here from the public /t/application page.
  // It carries its OWN auth — the invitation token, digest-matched and
  // row-locked inside the route; invalid/expired/never-sent tokens fail
  // closed. Discovered the first time a real applicant reached submit:
  // the page was public, the submit it calls was behind the key gate.
  "/applications/submit-public",
]); // every entry carries its OWN auth (intake-secret / Twilio signature / invitation token) — these callers can't send an operator key
// NOTE: "/agent/" is public ONLY for the two-phone browser DEMO (synthetic data,
// operator-controlled). The agent operates on real records and proposes outbound
// messages — so before any REAL lead touches this, "/agent/" MUST be removed from
// this allowlist and the browser views moved behind real auth (token→session).
//  "/legal/" — the A2P 10DLC privacy policy and SMS terms. Public by
//  REQUIREMENT, not convenience: a carrier reviewer fetches these during
//  campaign vetting with no session and no key, and a 401 fails the
//  campaign. They are static text and read nothing.
//
//  ⚠ MOUNTING IS NOT REACHABILITY. The routes were mounted below on
//  2026-08-08 and still answered "Missing or wrong x-operator-key",
//  because this gate runs first and allowlists by path. The harness did
//  not catch it: it mounted the legal router into a BARE express app,
//  which has no gate — a test modelling a server production does not
//  have. Anything added here must be proven through the real stack.
const PUBLIC_PREFIXES = ["/tenant/", "/t/", "/public/", "/intake/", "/intake", "/auth/", "/demo/", "/agent/", "/legal/"];
// SESSION-GATED (NOT public): these routes enforce their OWN staff-session auth
// (x-staff-session → real users row, property-scoped) inside the route handlers, so
// they must skip the operator-KEY gate — we never put the raw OPERATOR_KEY in a
// browser. Skipping the key gate here does NOT mean unauthenticated: every /operator/
// route is behind requireOperator. (operator.js)
// SESSION-GATED (NOT public): /operator/* enforces its OWN staff-session auth
// (x-staff-session → real users row, property-scoped) inside the route handlers, so it
// skips the operator-KEY gate — we never put the raw OPERATOR_KEY in a browser.
// Matching is EXACT-boundary (isOperatorPath): '/operator' or '/operator/...', so a
// lookalike like '/operatorial' or '/operatorX' does NOT bypass the key gate.
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next(); // CORS preflight carries no custom headers
  const p = req.path;
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIXES.some((x) => p === x || p.startsWith(x))) return next();
  if (isOperatorPath(p)) return next(); // /operator/* applies its own staff-session auth
  if (isDealSetupPath(p)) return next(); // /deal-setup/* applies its own staff-session auth (requireHuman)
  if (p === "/admin" || p.startsWith("/admin/")) return next(); // /admin/* enforces its own super-admin session auth
  if (p === "/org" || p.startsWith("/org/")) return next();     // /org/* enforces its own org-admin session auth
  if (!OPERATOR_KEY) {
    return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header." });
  }
  if (req.get("x-operator-key") !== OPERATOR_KEY) {
    return res.status(401).json({ receipt: "Missing or wrong x-operator-key." });
  }
  next();
});

// single shared registry instance — created AFTER pool exists; mounted below
// AND used by ingest for identity resolution (the ONE identity path).
const registryInstance = registryModule({ pool });

// ════════════════════════════════════════════════════════════════════
//  SHARED CORE SERVICE — spawnObligationFromEvent
//
//  THE single obligation-creation path. Every obligation in the system is
//  born from an event and written here. The leasing tour, the delinquency
//  collections item, and the maintenance emergency all call this — so the
//  business logic lives in ONE place and modules (option-1 injection) never
//  duplicate it. Must be called inside an open transaction (pass `client`).
//
//  spec carries the full column set; priority/severity default to null so
//  callers that don't set them behave exactly as before.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  SHARED CORE SERVICE — satisfyObligation / completeObligation
//
//  The back half of the loop, made shared the same way the front half is.
//  Every module that closes an obligation — leasing, maintenance, money, and
//  the move-in/move-out/deposit obligations to come — goes through THESE, so
//  "how a required input is satisfied" and "how an obligation completes" each
//  live in exactly ONE place. The HTTP routes below call these too.
//
//  Both take an open transaction `client` (like spawnObligationFromEvent) so a
//  caller can satisfy/complete inside its own atomic unit. They THROW typed
//  errors for the gate cases (err.code) so each caller maps them to the right
//  HTTP status without re-implementing the rules:
//    NOT_FOUND       — no such obligation
//    NOT_OUTSTANDING — the input isn't an outstanding required input
//    ALREADY_COMPLETE— completing one that's already complete
//    INPUTS_OUTSTANDING — completing while required_inputs remain (the gate)
// ════════════════════════════════════════════════════════════════════

// The obligation TYPE-CHANGE service and its shared error factory live in
// src/shared/obligation_transitions.js so that the harness can exercise the
// REAL implementation instead of a hand-copied one (tests/_engine.js is a
// verbatim copy of the older engine functions, kept in sync by discipline —
// a pattern this deliberately does not extend).
const {
  OBLIGATION_TRANSITIONS, transitionObligation, obligationError,
} = require("./src/shared/obligation_transitions");
// The obligation engine itself. Previously defined inline here and hand-copied
// into tests/_engine.js, where it silently drifted PERMISSIVE — see that
// module's header. One implementation now; the harness re-exports this file.
const {
  RESERVED_APPLICATION_INPUTS, __APP_INPUT_CAPABILITY,
  spawnObligationFromEvent, satisfyObligation, completeObligation, reassignObligation,
} = require("./src/shared/obligation_engine");

// Satisfy ONE required input: record proof as a durable event, remove the
// input from required_inputs. Returns { obligation, satisfied_input, remaining }.
//
// RESERVED INPUTS (v2.5-r1): the two application-invitation proof codes may be
// satisfied ONLY by the application input authority (a module-private
// capability created once below and injected into the invitation service).
// The generic path CATEGORICALLY refuses them — no argument can override.


// Complete an obligation — the proof gate. Refuses (throws) if required_inputs
// remain or it's already complete. Returns the completed obligation row.

// Reassign an OPEN obligation to a different role — the staged-approval hop.
// Used by money.js to advance an approval chain (e.g. property_manager →
// accountant): the obligation stays open, but the role that owes it changes.
// Takes an open transaction `client`, throws the same typed errors as the
// other helpers, and writes a durable event so the hop is auditable. Only
// touches columns the existing helpers already write — assigned_role,
// escalates_to_role, updated_at — so it invents nothing the schema lacks.
//    NOT_FOUND        — no such obligation
//    ALREADY_COMPLETE — refuses to reassign one that's already complete


// ── RELEASE-0 BASELINE ROUTES (health, build, properties, units, persons, events, ──
// ── legacy obligations, users) — extracted verbatim; mounted at the same position. ──
app.use("/", require("./src/baseline/baseline_routes")({ pool, spawnObligationFromEvent }));
// ── LEASE LIFECYCLE (leases, schedule, payments, delinquency, approval, tenants) — ──
// ── extracted verbatim; mounted at the same position, routes unchanged. ──
app.use("/", require("./src/tenancy/lease_lifecycle_routes")({ pool, spawnObligationFromEvent }));
// ── AI DOCUMENT INGESTION — pipeline + prompts, extracted verbatim (organ module). ──
const __documentIngest = require("./src/agent/document_ingest")({ pool, anthropic, registryInstance });
const { INGEST_MODEL, fileToText, runIngestAuto, ingestPrompt } = __documentIngest;

// ── FRONT DOOR: fast identity-first pass (read-only) + confirm-write. ──
// Mounted HERE (not up top) because it needs fileToText + INGEST_MODEL, which
// are declared above this line. Reuses registryInstance.resolveOnly — the ONE
// identity path — so the glance never reimplements matching and never writes.
const identifyInstance = identifyModule({
  pool, anthropic, registryInstance, INGEST_MODEL, fileToText, upload,
});
app.use("/", identifyInstance);

// ── AI DOCUMENT INGEST ROUTES — extracted verbatim, mounted at the same position. ──
app.use("/", require("./src/agent/document_ingest_routes")({ pool, upload, runIngestAuto, fileToText }));

// ── THE ONE CANONICAL WORK-ORDER SERVICE ──
//  Built once, here, and injected into EVERY consumer. Its own header carries
//  the ruling: "every work order — tenant, operator, or future channel — flows
//  through this service." It was never constructed anywhere, while both
//  maintenance.js and tenant_link.js destructured `workOrderService` out of
//  their deps and called it — so every create threw TypeError on undefined and
//  returned a bare 500. One service instance, two mounts, no second path.
const workOrderService = makeWorkOrderService({
  spawnObligationFromEvent, satisfyObligation, transitionObligation,
});

// ── MAINTENANCE MODULE (isolated; injected pool + shared obligation path) ──
app.use("/", maintenanceModule({ pool, spawnObligationFromEvent, workOrderService }));

// ── UNIT TRIAGE (BUILD 1: post-move-out initial triage) ──────────────────
//  One service instance, one mount, one door. Same injection discipline as
//  workOrderService above, and asserted at construction for the same reason.
const unitTriageService = require("./src/maintenance/unit_triage_service")
  .makeUnitTriageService({ spawnObligationFromEvent });
app.use("/", require("./src/maintenance/unit_triage")({ pool, unitTriageService }));

// ── MOVE-OUT -> TURNOVER (one write, two adapters) ─────────────────────
//  The staff-session door and the older operator-key route both call this
//  service. Management authority and actor attribution come from the staff
//  session; neither HTTP body can choose a property or write domain rows.
const turnoverService = require("./src/maintenance/turnover_service")
  .makeTurnoverService({ spawnObligationFromEvent, recordEffectivePossession, unitTriageService });
app.use("/", require("./src/maintenance/operator_turnover")({ pool, turnoverService }));

// ── UNIT TURN SCOPE (BUILD 2: normal turn scope + ordered flow) ──────────
//  Extends a confirmed BUILD 1 triage. Same injection discipline, same single
//  authority-scoped door, asserted at construction.
const unitTurnScopeService = require("./src/maintenance/unit_turn_scope_service")
  .makeUnitTurnScopeService({ spawnObligationFromEvent });
app.use("/", require("./src/maintenance/unit_turn_scope")({ pool, unitTurnScopeService, unitTriageService }));

// ── WORK ACCEPTANCE / PROOF / PROGRESSION (BUILD 3) ──────────────────────
// ── ONE COMPLETION PHOTO (unit-turn closure slice, migration 118) ────────
//  The attachment CONTRACT is permanent; the `bytea` storage behind it is a
//  Class 2 adapter, replaceable without touching ids, authority or the
//  completion API. It is injected into the acceptance service so the photo and
//  the claim commit in ONE transaction.
const workProofAttachmentService = require("./src/maintenance/work_proof_attachment_service")
  .makeWorkProofAttachmentService();

const workAcceptanceService = require("./src/maintenance/work_acceptance_service")
  .makeWorkAcceptanceService({ spawnObligationFromEvent, attachmentService: workProofAttachmentService });
//  `proofUpload` is this workflow's own multer instance: ONE file, 5 MB. The
//  shared 25 MB `upload` above serves other surfaces and is deliberately not
//  reused — a completion photo has its own limit.
const proofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
app.use("/", require("./src/maintenance/work_acceptance")({
  pool, upload: proofUpload, workProofAttachmentService, workAcceptanceService, unitTriageService,
}));

// ── FINAL READINESS WALK AND CERTIFICATION (BUILD 4) ─────────────────────
//  The only path in the system that may establish `ready`, and only from an
//  explicit human certification. Reopening prior work goes through
//  workAcceptanceService so there is one canonical reopen path, not two.
const readinessService = require("./src/maintenance/readiness_service")
  .makeReadinessService({ spawnObligationFromEvent, workAcceptanceService });
app.use("/", require("./src/maintenance/readiness")({ pool, readinessService }));

// ── AUTHENTICATED STAFF AGENT CAPTURE (BUILD 5) ──────────────────────────
//  A capture DOOR into Builds 1-4, not a second maintenance system. All four
//  canonical services are REQUIRED — construction fails without any of them,
//  so the agent cannot exist in a configuration where it would fall back to a
//  raw insert.
const staffAgentService = require("./src/agent/staff_agent_service")
  .makeStaffAgentService({ unitTriageService, unitTurnScopeService, workAcceptanceService, readinessService });
app.use("/", require("./src/agent/staff_agent")({ pool, staffAgentService }));

// ── OBLIGATIONS (authenticated) — replaces the shared-key GET /obligations ──
//  Property, modules and actor all come from the resolved staff session.
app.use("/", require("./src/obligations/operator_obligations")({ pool }));
app.use("/", require("./src/obligations/operator_obligation_actions")({ pool }));

// ── ASSET MANAGEMENT — the FOURTH operating door ────────────────────────
//  Beside Leasing, Management and Maintenance. Staff/operator side, where
//  the economic structure and performance of a property become operable.
//  NOT the Owner / Investor surface, and it does NOT reuse /asset/* (that
//  prefix is Deal Setup's legacy alias and keeps its own retirement path).
//
//  This is a SHELL: four rooms, establishment state only, no amounts.
//  `fileToText` is injected, not imported: it is declared in this file and a
//  module requiring server.js back would be circular. Same shape identify.js
//  is mounted with. Insurance uses it to PROPOSE fields off an uploaded
//  policy — a suggestion the human confirms, never a write.
app.use("/", require("./src/surfaces/asset_management")({ pool, fileToText }));

// ── ASK SPINE (SLICE 1) — read-only sibling of the staff agent ───────────
//  Answers "What needs attention?" from live obligations, property-scoped by
//  the operator session. No proposals, no confirmations, no writes, and the
//  question is not recorded as a staff-agent message. It shares the authority
//  seam above and nothing else.
app.use("/", require("./src/agent/ask_spine")({ pool, anthropic,
  //  A THUNK, read at request time. Ask Spine mounts here; the
  //  applications module is composed further down, so a value captured
  //  now would be undefined forever. Same reason as the lease-packet
  //  execution services above.
  applicationsService: () => __applications && __applications._service })); 

// ── MEETING EVIDENCE — governed capture binding/read surface ─────────
//  The provider webhook is mounted above express.json(); these operator
//  endpoints stay here with the rest of the staff-session surfaces. They
//  authorize the Read connection row, bind provider meetings to the
//  session property, and read only already-bound meeting evidence.
app.use("/", meetingEvidenceModule.operatorRoutes({ pool, anthropic }));

// ── THE ONE UNIT TURN PAGE (BUILD 6A) ────────────────────────────────────
//  READ-ONLY consolidation of the Build 1-5 canonical reads. Creates no state
//  and owns no domain model; every write action on the page posts to the
//  Build 1-5 door that owns it. All four services are required.
const unitTurnRead = require("./src/surfaces/unit_turn_read").makeUnitTurnRead({
  unitTriageService, unitTurnScopeService, workAcceptanceService, readinessService,
  staffAgentService, availabilityRead: require("./src/surfaces/availability_read").availabilityRead,
  workProofAttachmentService,
});
app.use("/", require("./src/surfaces/unit_turn")({
  pool,
  unitTurnRead,
  rankTurnPriority: require("./src/maintenance/turn_priority").rankTurnPriority,
}));
// applications module mounted lower (after the conversion + submission services exist,
// so /approve can close the leasing_manager application_approval gate). See below.
const __leasePackets = leasePacketsModule({
  pool, satisfyObligation, completeObligation,
  staffSessions: require("./src/identity/staff_session_service"),
  //  LATE-BOUND ON PURPOSE. This module mounts here, but the executed-lease
  //  service and the tenancy anchor are composed ~230 lines below. A value
  //  captured now would be undefined forever; a thunk reads them at request
  //  time, after composition. The mount order is not disturbed — legacy and
  //  operator doors still share this one packet service instance.
  executionServices: () => ({
    executedLease: __executedLease,
    confirmTerm: __tenancyAnchor && __tenancyAnchor.confirmTermService,
    spawnObligationFromEvent,
  }),
});
app.use("/", __leasePackets); // ONE packet service instance; legacy + operator doors share _service
// ── DOWN UNITS MODULE (isolated; same injection pattern) ──
app.use("/", downUnitsModule({ pool, spawnObligationFromEvent }));
// ── ORG CHART MODULE (isolated; same injection pattern) ──
app.use("/", moneyModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation, reassignObligation }));
app.use("/", orgchartModule({ pool }));
app.use("/", roomOwnersModule({ pool }));
app.use("/", turnoversModule({ pool, satisfyObligation, completeObligation, turnoverService }));
const deliveryHelper = require("./src/comms/delivery")({ satisfyObligation, completeObligation }); // Slice D shared completion-feed
app.use("/", moveinModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation, deliveryHelper, recordEffectivePossession }));
app.use("/", noticeModule({ pool }));   // Availability Slice A — notice writes unit_events only; no obligation spawns at notice
app.use("/", require("./src/tenancy/space_position_routes")({ pool }));
app.use("/", onboardingModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
// ── ONBOARDING FUNNEL (revenue/roles/NOI-goal; honest mode; only needs pool) ──
app.use("/api", onboardingFunnel({ pool }));
app.use("/", registryInstance);
app.use("/", bankIntakeModule({ pool }));
app.use('/', bankBridgeModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
app.use('/', autoConfirmModule({ pool }));
app.use('/', moneyBoardModule({ pool }));
app.use('/', attributionsModule({ pool }));
app.use('/api', portfolioModule({ pool }));
app.use('/', snapshotLoaderModule({ pool, upload }));
app.use('/', seedEndpointModule({ pool }));
app.use('/', managementReadModule({ pool, spacePosition })); // + canonical space-position overlay (surfaces owned-work conflicts on the rent roll)
app.use('/', propertySurfaceModule({ pool }));
app.use('/', plaidModule({ pool }));
app.use("/", exposureModule({ pool }));
app.use("/", reportingModule({ pool }));
app.use("/", chargesModule({ pool })); // income rung slice 2A: /properties/:id/charges[/generate|/summary]
app.use("/", paymentsModule({ pool })); // income rung slice 3: /properties/:id/payments, /payments/:id/apply|link-bank, /income-proof
app.use("/", require("./src/surfaces/board")({ pool })); // morning board: GET /properties/:id/today (read-only)
app.use("/", leasingIntelModule({ pool, upload }));
app.use("/", require("./src/surfaces/desks")({ pool })); // V3 three desks: operator-home + management/leasing/maintenance dashboards (read-only)
app.use("/", require("./src/surfaces/management")({ pool })); // Management reverse-funnel surface: GET /properties/:id/management-surface (Needs You primary, Collections/Operations secondary, Rent Roll reference)
app.use("/", compareModule({ pool }));
app.use("/", explainModule({ pool }));
// tenant link (text line: connection + message loop) — pool, AI for classification.
const sms = smsTransport(); // SMS transport (Twilio) — disabled until env vars are set; everything degrades to link-only
const commBoundary = communicationsBoundary({ pool, sms }); // every business send goes through this gate; raw sms.sendSms is transport only

app.use("/", require("./src/comms/sms_proof_route")({ commBoundary }));
app.use("/", tenantLinkModule({ pool, anthropic, INGEST_MODEL, sms, commBoundary, workOrderService, getAgentService: () => agentApp._service }));
//  A2P 10DLC legal pages — /legal/privacy and /legal/sms-terms, plus .txt
//  fallbacks. Public and unauthenticated by requirement: a carrier reviewer
//  must be able to fetch them during campaign vetting with no session.
//  These are the two URLs the campaign form asks for, and the two the tenant
//  consent checkbox links to. The module existed since June and was mounted
//  NOWHERE, so both returned 404 while the file sat in the repo looking done.
app.use("/", legalRoutesModule());
app.use("/", teamAccessModule({ pool, sms, commBoundary }));
app.use("/", superAdminModule({ pool }));
app.use("/", orgAdminModule({ pool }));
// owner-facing aggregate views (cards + attention queue). Only needs pool.
app.use("/", ownerModule({ pool }));
const publicReview = require("./src/onboarding/public_review");
   app.use("/", publicReview({ pool, anthropic, INGEST_MODEL, fileToText, ingestPrompt, upload }));
// ── INTAKE (Door 2: text/email/web field-event capture; claims only — routing
//    to real records happens through the existing module endpoints) ──
const intakeModule = require("./src/onboarding/intake");
app.use("/", intakeModule({ pool, anthropic, INGEST_MODEL, registryInstance, upload }));
const dealIntakeModule = require("./src/onboarding/deal_intake");
// ── Shared lifecycle write service (Foundation 054) — ONE instance, injected into
// every canonical inbound writer so a qualifying prospect inbound transactionally
// reopens a soft-closed conversation. Stateless over the pool; safe to share.
const leasingLifecycle = require("./src/leasing/leasing_lifecycle_service")({ pool });

const leasingLeadsModule = require("./src/leasing/leasing_leads"); // leasing lead intake: one-human/many-opportunities funnel + AI first response
app.use("/", dealIntakeModule({ pool, anthropic, INGEST_MODEL, registryInstance, fileToText, runIngestAuto, upload }));

// ── DEAL SETUP ───────────────────────────────────────────────────────
//  Establish the source truth Spine needs before it can operate a Deal.
//  Every route resolves a staff session first (requireHuman) and records
//  the human on every write; /deal-setup/* therefore skips the
//  operator-KEY gate the same way /operator/*, /admin/* and /org/* do.
//
//  NOT Asset Management. Deal Setup is ONBOARDING — it establishes opening
//  truth. Asset Management is one of the four OPERATING doors (Leasing,
//  Management, Maintenance, Asset Management) that run on that truth
//  afterwards, and it lives at /operator/asset-management/*.
//
//  The `/asset/*` alias below is Deal Setup's own legacy compatibility
//  rail and has nothing to do with the Asset Management door. It keeps its
//  original retirement condition; the new door deliberately does NOT reuse
//  that prefix, because sharing it would make that condition unobservable.
//
//  Mounted HERE, after `upload`, because the source-file route needs it.
//  MOUNTING IS NOT REACHABILITY (the /legal/ lesson): isDealSetupPath()
//  above is what actually lets these through the gate, and the HTTP proof
//  calls them through the real server for exactly that reason.
const dealSetupModule = require("./src/onboarding/deal_setup");
app.use("/", dealSetupModule({ pool, upload }));
// ── Post-tour leasing conversion rail + scheduling intake + interaction ledger ──
// (migrations 047/048/049). sms + the obligation engine fns are all in scope here.
// NOTE (wave 3): the conversion module is instantiated BEFORE the leads module so
// its single-door createConversionFromTour service can be injected into the
// tour-outcome seam (/leasing/tours/:id/complete). Route mounting order is
// unaffected (paths are disjoint).
const leasingConversionModule = require("./src/leasing/leasing_conversion");   // conversion case + immutable child obligations + explicit handoff
const leasingSchedulingModule = require("./src/leasing/leasing_scheduling");   // Acuity/Outlook source events -> canonical scheduled tours
const leasingInteractionsModule = require("./src/leasing/leasing_interactions"); // Twilio interaction ledger on extended comm_events
const __leasingConversion = leasingConversionModule({ pool, spawnObligationFromEvent, completeObligation, closureAuthority: __conversionClosureAuthority });
app.use("/", __leasingConversion);
const decisionsModule = require("./src/leasing/decisions");   // the Decision Rail (059)
const __decisions = decisionsModule({ pool, spawnObligationFromEvent, completeObligation });
app.use("/", __decisions);
const commitmentLedgerModule = require("./src/money/commitment_ledger");   // pricing authority + lease offers (062–065)
const __commitmentLedger = commitmentLedgerModule({ pool, spawnObligationFromEvent, completeObligation, decisionService: __decisions._service });
app.use("/", __commitmentLedger);
const __leasingLeads = leasingLeadsModule({ pool, anthropic, INGEST_MODEL, sms, leasingLifecycle, conversionServices: __leasingConversion.services, commitmentLedger: __commitmentLedger._service, commBoundary });
app.use("/", __leasingLeads); // instance captured: its ONE tour-completion service is handed to the operator door below (no fork)

// ── APPLICATION SUBMISSION SLICE (invitation front + shared submit service +
//    deny + gated approval→signature). Shares the conversion rail's service layer. ──
const applicationSubmissionModule = require("./src/applications/application_submission");

// ── APPLICATION INPUT AUTHORITY (v2.5-r1) ──────────────────────────────
// The ONE satisfier of the two reserved invitation-proof inputs. Mirrors the
// conversion closure authority pattern: created once here, injected only into
// the invitation service. Verifies authoritative invitation state under the
// caller's transaction, writes the FIRST-CLASS proof row (obligation_input_proofs
// — not JSON-in-note), then satisfies via the private capability and completes.
function createApplicationInputAuthority() {
  async function satisfyApplicationInput(client, {
    obligation_id, input_code, invitation_id,
    intent_id = null, parent_obligation_id = null, unit_id = null,
    actor_user_id = null, expected_invitation_status,
  }) {
    if (!RESERVED_APPLICATION_INPUTS.includes(input_code)) {
      throw obligationError("BAD_INPUT", `"${input_code}" is not a reserved application input.`);
    }
    const inv = (await client.query(
      "select id, status from application_invitations where id=$1", [invitation_id])).rows[0];
    if (!inv) throw obligationError("NOT_FOUND", "invitation not found for input proof.");
    const okStatus = input_code === "application_invitation_prepared"
      ? inv.status === "prepared"
      : ["manually_sent", "provider_dispatched"].includes(inv.status);
    if (!okStatus || (expected_invitation_status && inv.status !== expected_invitation_status)) {
      throw obligationError("STATE", `invitation state '${inv.status}' does not prove '${input_code}'.`);
    }
    const evId = (await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       select o.property_id, o.person_id, $2, 'input_satisfied:' || $3,
              $3 || ' proven by invitation ' || $4::text
         from obligations o where o.id=$1 returning id`,
      [obligation_id, unit_id, input_code, invitation_id])).rows[0].id;
    await client.query(
      `insert into obligation_input_proofs
         (obligation_id, input_code, intent_id, invitation_id, parent_obligation_id,
          unit_id, actor_user_id, event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (obligation_id, input_code) do nothing`,
      [obligation_id, input_code, intent_id, invitation_id, parent_obligation_id,
       unit_id, actor_user_id, evId]);
    await satisfyObligation(client, {
      obligation_id, input: input_code,
      proof: { invitation_id, proof_event_id: evId },
      __capability: __APP_INPUT_CAPABILITY,
    });
    return completeObligation(client, { obligation_id, completed_by: actor_user_id });
  }
  return { satisfyApplicationInput };
}
const __applicationInputAuthority = createApplicationInputAuthority();

const __applicationSubmission = applicationSubmissionModule({
  pool, spawnObligationFromEvent, completeObligation,
  conversionService: __leasingConversion._service, commBoundary,
  applicationInputAuthority: __applicationInputAuthority,
});
app.use("/", __applicationSubmission);

// ── THE ONE CANONICAL TENANCY-ANCHOR SERVICE (Fable ruling) ──────────────
// countersign + confirm-term extracted to ONE implementation, built ONCE here
// from the obligation engine + ledger service, then injected into BOTH route
// families (applications.js legacy routes AND operator.js /operator/leasing/*
// adapters). There is exactly one write path; the two route families are entry
// adapters that mount the SAME dormantWriteGuard + activationPerimeter and call
// THIS service. No route reimplements the transaction; no internal HTTP hop.
// EXECUTION SEAM (Path B implemented, migration 088). The ONLY door for
// "a governing lease was actually executed" is a verified executed_lease_records
// row, written by the canonical intake service behind its own activation gate.
// The resolver takes (client, applicationId) and nothing else — no body value
// can ever assert execution.
const __executedLease = require("./src/applications/executed_lease_service");
const __executionEvidence = require("./src/applications/execution_evidence")();

const __tenancyAnchor = require("./src/tenancy/tenancy_anchor_service")({
  spawnObligationFromEvent, satisfyObligation, completeObligation,
  ledgerService: __commitmentLedger._service,
  executionEvidence: __executionEvidence,
  // 088: confirm-term RECOMPUTES admission from live sources through this
  // service rather than trusting the stored verdict.
  executedLease: __executedLease,
});

// applications mounted HERE (moved down) so approve can close the
// application_approval gate via the submission service, then create the v3
// terms_review birth obligation (NOT the retired blended activation gate).
// Instance captured: operator.js and demo.js call THIS service — one
// approveApplication, three entry doors (R3).
const __applications = applicationsModule({
  pool, spawnObligationFromEvent, satisfyObligation, completeObligation,
  submissionService: __applicationSubmission._service,
  conversionService: __leasingConversion._service, // v3: approval is the ONLY creator of terms-review follow-up work
  ledgerService: __commitmentLedger._service,   // J1: countersign locks the economic schedule
  tenancyAnchor: __tenancyAnchor,               // the ONE canonical countersign/confirm-term service
});
app.use("/", __applications);
app.use("/", leasingSchedulingModule({ pool }));
// Build the interaction ledger ONCE. The legacy operator-key routes and the
// staff-session Person Card adapter both call this same service instance.
const __leasingInteractions = leasingInteractionsModule({ pool, sms, leasingLifecycle, commBoundary });
app.use("/", __leasingInteractions);

// ── Skyline ride-along shadow import (migration 050). Three-state phone identity
//    (new -> preview lead · known -> intent task, never a new lead · no/invalid ->
//    conflict). Preview rows are outreach-barred by construction; this module has
//    NO sms dependency and cannot send. ──
const leasingShadowImportModule = require("./src/leasing/leasing_shadow_import");
app.use("/", leasingShadowImportModule({ pool }));

// ── Two-sided live demo orchestration (migration 052). Reset/state/application-submit/
//    application-approve. Owns NO domain truth; calls the application submission SERVICE
//    inside its own transaction and appends an append-only demo_event. ──
const demoModule = require("./src/leasing/demo");
app.use("/", demoModule({ pool, submissionService: __applicationSubmission._service,
  applicationsService: __applications._service })); // R3: demo approve calls the ONE canonical approveApplication

// ── Rehearsal reset (demo-only). Empties the live boardroom Conversations queue by
//    closing every boardroom_demo conversation through the canonical close service —
//    no deletes, reversible, fail-closed to the Demo Building. (demo_reset.js) ──
app.use("/", require("./src/leasing/demo_reset")({ pool, leasingLifecycle }));

// ── Agent Stage 0: model capability proof (operator-gated, NO schema, NO secrets
//    exposed). One real generation to confirm the live model path works before any
//    agent architecture is built on it. GET /agent/capability → { ok, reachable, model }. ──
const agentCapabilityModule = require("./src/leasing/agent_capability");
app.use("/", agentCapabilityModule({ anthropic, INGEST_MODEL }));

// ── Agent Stage A: supervised, grounded, draft-first conversation loop. The agent
//    PROPOSES; nothing reaches a lead until a human dispatches it. Two-transaction
//    model call, monotonic thread versioning, obligation-backed review, server-derived
//    manager identity. (Migration 053.) ──
const agentModule = require("./src/agent/agent");
const agentApp = agentModule({ pool, anthropic, INGEST_MODEL, spawnObligationFromEvent, completeObligation, leasingLifecycle, commBoundary, leasingBookingService: __leasingLeads._service });
app.use("/", agentApp);

// ── THE FIRST LIVE OPERATOR SURFACE — Leasing Conversations. ──
// /operator/* is the authenticated, property-scoped manager interface. It reuses the
// agent's EXTRACTED shared services (one source of truth for dispatch/regenerate/
// takeover/obligation/stale-draft) — agentApp._service. Identity is a real staff
// session (x-staff-session → users row); the browser never claims identity. The
// demo-session bootstrap is fail-closed (DEMO_MODE=true only). (operator.js)
app.use("/", require("./src/identity/operator_session_bootstrap")({ pool })); // BRICK ONE: POST /operator/session + /revoke  the only /operator/* routes that self-protect (they create/end the session)
// PHASE ZERO: the real property boundary. GET /operator/properties (which
// properties may I operate?) + POST /operator/properties/select (issue me a
// session for this one). Both require a resolved session; the select route's
// body property_id is a REQUEST that issueStaffSession grants or refuses  it
// never selects scope for a read. See the module header.
app.use("/", require("./src/identity/operator_properties")({ pool }));
const operatorModule = require("./src/identity/operator");
app.use("/", operatorModule({ pool, agentService: agentApp._service,
  leasingTourService: __leasingLeads._service, // the ONE completion service (leasing_leads.js) — session door calls the same tx
  // the invitation service (application_submission) — the session-gated operator
  // route calls its create/attest services; no duplicate invitation logic.
  applicationInvitations: __applicationSubmission._service,
  // 067 follow-on: the session-authed leasing task queue resolves through the
  // conversion rail's ONE resolveRung service — no module reimplements closing.
  conversionService: __leasingConversion._service,
  // The ONE interaction ledger / communications-boundary service. The Person
  // Card reply route is only a session-scoped adapter over this implementation.
  interactionsService: __leasingInteractions._service,
  // the SAME canonical tenancy-anchor service applications.js gets — the two
  // /operator/leasing/applications/:id/{countersign,confirm-term} adapters call
  // it behind dormantWriteGuard + activationPerimeter. One implementation.
  tenancyAnchor: __tenancyAnchor,
  // v3: the walled operator approve adapter calls the ONE canonical
  // approveApplication service (R3) — never a second implementation.
  applicationsService: __applications._service,
  // 088: the canonical executed-lease intake + admission service. The verify
  // door calls it; confirm-term recomputes admission through it.
  executedLease: __executedLease,
  spawnObligationFromEvent,
  // Slice D completion feed — the SAME deliveryHelper instance movein.js uses
  // (built once at the movein mount). The operator keys-ready door is the PM
  // action delivery.js anticipated; without this injection it fails closed 503.
  deliveryHelper,
  leasePacketsService: __leasePackets._service }));

// ── STAFF IDENTITY BRIDGE (067) — the authorized point-and-confirm workflow:
// classify accounts, suggest candidates (exact verified email only, never
// applied), link/relink/unlink with an append-only effective-dated audit,
// and the coverage + 004↔035 divergence report. Bridges are deliberate,
// audited acts by an admin staff session — never inference, never capture
// flow. Eligibility resolution lives in staff_identity_resolver.js (the ONE
// module allowed to join users.person_id to assignments). (staff_bridge.js)
const staffBridgeModule = require("./src/identity/staff_bridge");
app.use("/", staffBridgeModule({ pool }));

// ── REMOVED 2026-07-28: the demo facts seed is no longer in the HTTP runtime.
// It was mounted here as POST /demo/seed-solo-facts. `/demo/` is in
// PUBLIC_PREFIXES above, so the route had NO authentication — its only guard
// was DEMO_MODE, which is true on the live service. It retired every active
// fact of 18 keys and wrote replacements, including `fee_policy` ("a $99 admin
// fee per unit (at move-in and renewal)"), so it could resurrect a retired
// economic claim AFTER a transactional cutover. A cutover cannot defend
// against a write that happens later.
// The capability survives as operations tooling with no HTTP surface:
//   tools/seed_solo_facts.js  (dry-run by default; --confirm --reason required;
//   refuses to supersede already-active facts without --supersede)
// Doctrine: §17 "Demo data may exist. Demo paths may not."; §32 stop-sign.
// Nothing in src/ may import that file.

// ── DEMO SLOT AUTO-SEED (fail-soft, boot-time) ───────────────────────
// Keeps the Demo Building's tour_availability populated so the SMS/agent
// booking flow always has real open slots to book into — without a manual
// re-seed before every demo and without a separate cron scheduler that can
// silently stop. Missing-only inserts (never wholesale-skips), DST-correct
// local wall-clock. NEVER awaited into the boot critical path and NEVER
// throws into boot: a seed failure logs a warning and the API still starts.
// CLASS 4 — delete-on-real-activation scaffolding: retires with
// seed_demo_slots.js when real staff-calendar availability feeds
// tour_availability. Gated to demo runtime only.
if (process.env.DEMO_MODE === "true") {
  const { seedDemoSlots } = require("./seeds/seed_demo_slots");
  seedDemoSlots(pool, { days: 7 })
    .then((r) => {
      if (r.skipped) console.warn(`[slots] boot seed skipped: ${r.reason}`);
      else console.log(`[slots] boot seed: +${r.created} new, ${r.existed} existed, ${r.openCount} open future slot(s)`);
    })
    .catch((err) => console.warn(`[slots] boot seed error (ignored, API still starting): ${err.message}`));
}

//  LAST. Anything a handler rejected or threw lands here and is answered as
//  JSON in the receipt vocabulary; the stack goes to the log, not the wire.
app.use(terminalErrorHandler);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Property Spine API listening on ${port}`));
