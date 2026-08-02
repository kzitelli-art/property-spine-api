// operator.js — THE FIRST LIVE PROPERTY SPINE OPERATOR SURFACE.
//
// This is the first brick of the eventual live operator app — NOT a demo page and
// NOT a renamed agent-manager. The page is small; the /operator/ CONTRACTS and the
// IDENTITY BOUNDARY are what must be durable. The eventual main app consumes these.
//
// HARD RULES (locked):
//   • Every /operator/ route requires a REAL staff session (x-staff-session header),
//     resolved to a real users row. No session → 401. The browser NEVER claims
//     identity — approved_by_user_id / sent_by_user_id are derived server-side.
//   • Every route is PROPERTY-SCOPED to the session. A conversation/draft/fact/space
//     must belong to session.property_id, verified on every read AND write. Route
//     params (:conversationId, :factId) are NEVER trusted on their own — the server
//     verifies ownership against the session. This closes the IDOR class.
//   • No free :propertyId read route — the property is INFERRED from the session.
//   • The draft send/regenerate/takeover logic is REUSED from agent.js's service —
//     /operator/ is the authenticated front door, never a reimplementation of the
//     locked two-transaction / stale-draft / obligation machinery.
//
// THE DEMO BOOTSTRAP (the one demo-only piece, hardened):
//   POST /demo/operator-session mints a REAL scoped staff session for the seeded
//   leasing_manager so the operator surface uses the real session machinery without
//   the SMS-OTP login (which needs Twilio, not yet live). It is fail-closed:
//     • enabled ONLY when DEMO_MODE=true (absent/false → disabled, 403)
//     • mints ONLY for the seeded demo manager, ONLY for the dedicated demo property
//     • short expiry (6h), revokes prior demo-manager sessions on mint
//     • rate-limited, Cache-Control: no-store
//     • never accepts user_id/property_id/role from the browser
//   It is a development BRIDGE, never the product auth boundary.
//
// Deps: { pool, agentService } where agentService = agentModule(...)._service plus
//       the operator-facing actions agent.js exposes. Mounted under "/".

const crypto = require("crypto");
const staffSessions = require("./staff_session_service.js"); // BRICK ONE: the ONE issuer/resolver/revoke
const staffIdentity = require("./staff_identity_resolver.js"); // 067: the ONE canonical users↔persons↔assignments read
const proposedTerms = require("../applications/proposed_terms_service"); // Part 3: governed proposed-terms confirmation (Part 2 service)
// Slice 9: the canonical application READ authority. One definition of
// "did this ever reach approval", shared with the leasing desk.
const lifecycleRead = require("../applications/application_lifecycle_read");
const applicationSendCommand = require("../applications/application_send_command"); // composite Send-application command (intent→prepare→dispatch)
const applicationTargetAuthority = require("../applications/application_target_authority"); // Slice 9 Commit A: the ONE application-target resolver

module.exports = function operatorModule(deps) {
  const {
    pool, agentService, conversionService = null, leasingTourService = null,
    applicationInvitations = null, interactionsService = null,
    // v3 (R3): the ONE canonical approveApplication service from applications.js
    // — the walled operator approve adapter below calls THIS, never a second
    // implementation. Absent (older server.js) → the route fails closed 503.
    applicationsService = null,
    leasePacketsService = null,
  } = deps;
  const { rankTurnPriority } = require("../maintenance/turn_priority"); // shared Turn-Priority ranking (slice 1)
  const { buildReviewList, buildReviewDetail } = require("../applications/application_review"); // application review reads (slice 2)
  const { loadLeasingDesk } = require("../leasing/leasing_desk_loader"); // Leasing Desk composition (one repeatable-read snapshot)
  const { renewalsCohort, renewalsCohortEnriched } = require("../leasing/renewals_read"); // R1 cohort + Slice 6 operating rail
  const { loadAiLeasingStrategyProjection } = require("../leasing/ai_leasing_strategy_projection"); // read-only strategy status + conversation attribution
  const { currentRentRoll } = require("../surfaces/rent_roll_canonical");   // canonical Current Rent Roll (migration route)
  const { futureRentRollFacts } = require("../surfaces/future_rent_roll_facts"); // factual Future Rent Roll (migration route)
  const { institutionalRentRoll, institutionalCsv } = require("../surfaces/rent_roll_institutional"); // formal as-of schedule + CSV
  const { availabilityRead } = require("../surfaces/availability_read");   // Availability over the shared classifier
  const { effectivePropertyPricing } = require("../money/effective_pricing"); // the Pricing & Concessions truth sheet
  // ── THE ONE CANONICAL TENANCY-ANCHOR SERVICE (Fable ruling) ──────────
  // The SAME countersign + confirm-term implementation applications.js calls.
  // Injected from server.js (built once from the obligation engine). The two
  // new /operator/leasing/applications/:id/* routes below are ENTRY ADAPTERS
  // over this service — session-authed, server-derived actor — never a second
  // implementation. Absent (older server.js) → those two routes fail closed 503.
  const tenancyAnchor = deps.tenancyAnchor || null;
  // Slice D completion feed (delivery.js) — the SAME helper instance movein.js
  // uses; server.js builds it once. Absent (older server.js) → the keys-ready
  // door below fails closed 503. Never a second implementation here.
  const deliveryHelper = deps.deliveryHelper || null;
  // migration 088: the canonical executed-lease intake + admission service.
  // Absent (older server.js) → the verify door fails closed 503.
  const executedLease = deps.executedLease || null;
  // The activation perimeter + dormant gate — mounted as ROUTE middleware on the
  // two adapter routes, IDENTICALLY to the legacy applications.js routes, so the
  // operator door goes through the exact same authority (mode → authenticated
  // session → property-activated → leasing-module entitlement → session-property
  // == app-property → current internal_qa → eligible state). The perimeter is the
  // authority boundary; the shared service is transaction-only.
  const { dormantWriteGuard } = require("./dormant_gate");
  const { activationPerimeter } = require("./activation_perimeter");
  if (!pool) throw new Error("operator.js requires { pool }");
  const router = require("express").Router();

  const DEMO_MODE = String(process.env.DEMO_MODE || "").toLowerCase() === "true";
  const DEMO_ACCESS_CODE = process.env.DEMO_ACCESS_CODE || ""; // high-entropy, single-purpose; DISTINCT from OPERATOR_KEY
  const DEMO_PROP_NAME = "Property Spine Demo Building";
  const DEMO_MGR_EMAIL = "demo-manager@propertyspine.internal";
  const DEMO_SESSION_HOURS = 6;

  function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; return e; }

  // ── Pre-Tour AI Conversations: the lifecycle write service (054) ──
  // Instantiated once inside this closure. We expose only close-not-fit + reopen as
  // browser routes (below); linkTour/cancelTour/correctTourLink stay as internal
  // service functions to be called by the canonical tour-creation / scheduling-
  // cancellation / audited-repair paths — NOT general operator endpoints.
  const leasingLifecycle = require("../leasing/leasing_lifecycle_service")({ pool });

  // Compare a presented bearer credential against the configured one in constant time.
  // We SHA-256 BOTH sides first so the timingSafeEqual inputs are always equal fixed
  // length — a malformed or wrong-length code can never throw (no 500), and missing /
  // wrong-length / wrong all take the same path → identical 401 upstream.
  function safeEqual(presented, configured) {
    if (typeof configured !== "string" || configured.length === 0) return false;
    const ha = crypto.createHash("sha256").update(String(presented == null ? "" : presented)).digest();
    const hb = crypto.createHash("sha256").update(String(configured)).digest();
    return crypto.timingSafeEqual(ha, hb); // both 32 bytes, always
  }

  // ── the SHARED staff-session resolver (twin of teamaccess.currentUser) ──
  // Resolves x-staff-session → real users row. Returns null if absent/invalid/expired.
  // Returns { id, name, email, role, property_id } — property_id is the SESSION scope.
  async function resolveSession(req) {
    // BRICK ONE: THE shared live-authority read. Session validity + active
    // user (067 rule) + active assignment for the SESSION's property on
    // EVERY request; returns live role/modules. Legacy raw tokens honored
    // only inside the 14-day sunset (staff_session_service).
    return staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
  }

  // middleware: require a valid session; attach req.operator = { id, ..., property_id }
  async function requireOperator(req, res, next) {
    try {
      const op = await resolveSession(req);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      next();
    } catch (e) {
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  // ── rate limiter for the demo bootstrap (in-memory, per-process) ──
  // Both per-endpoint (global) AND per-IP, so one source can't exhaust attempts for all.
  const _bootstrapHits = [];
  const _bootstrapHitsByIp = new Map();
  function bootstrapRateOk(ip) {
    const now = Date.now();
    while (_bootstrapHits.length && now - _bootstrapHits[0] > 60_000) _bootstrapHits.shift();
    if (_bootstrapHits.length >= 30) return false; // endpoint ceiling 30/min
    const arr = _bootstrapHitsByIp.get(ip) || [];
    while (arr.length && now - arr[0] > 60_000) arr.shift();
    if (arr.length >= 8) return false; // per-IP ceiling 8/min
    _bootstrapHits.push(now); arr.push(now); _bootstrapHitsByIp.set(ip, arr);
    return true;
  }

  // ════════════════════════════════════════════════════════════════════
  //  DEMO-SESSION BOOTSTRAP — fail-closed, demo-only, property-scoped.
  // ════════════════════════════════════════════════════════════════════
  router.post("/demo/operator-session", async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!DEMO_MODE) {
      // disabled entirely outside the demo environment
      return res.status(403).json({ error: "Disabled. (Operator-session bootstrap is demo-only.)" });
    }
    if (!DEMO_ACCESS_CODE) {
      // fail-closed: DEMO_MODE alone is NOT enough — a high-entropy access code must be configured.
      return res.status(503).json({ error: "Demo bootstrap not configured (no access code set)." });
    }
    if (!bootstrapRateOk(req.ip || (req.connection && req.connection.remoteAddress) || "unknown")) {
      return res.status(429).json({ error: "Too many requests — slow down." });
    }
    // The ONLY thing read from the browser is the single-purpose access code. No
    // user_id, property_id, or role is ever accepted — identity + scope are derived
    // server-side. The code is compared constant-time and never logged or echoed.
    const presented = (req.body && typeof req.body.access_code === "string") ? req.body.access_code : "";
    if (!safeEqual(presented, DEMO_ACCESS_CODE)) {
      return res.status(401).json({ error: "Invalid demo access code." });
    }
    try {
      const out = await (async () => {
        const client = await pool.connect();
        try {
          await client.query("begin");

          // the dedicated demo property (must already exist — created by the demo seed)
          const prop = (await client.query(
            "select id from properties where name=$1 order by created_at asc limit 1",
            [DEMO_PROP_NAME]
          )).rows[0];
          if (!prop) throw httpErr(409, "No demo property yet — start the demo (it seeds the property) first.");

          // the seeded leasing_manager (created by the demo seed)
          let mgr = (await client.query("select id from users where email=$1 limit 1", [DEMO_MGR_EMAIL])).rows[0];
          if (!mgr) {
            mgr = (await client.query(
              "select id from users where role='leasing_manager'::role_name order by created_at asc limit 1"
            )).rows[0];
          }
          if (!mgr) throw httpErr(409, "No demo manager user — start the demo (it seeds the manager) first.");

          // revoke prior demo-manager sessions for THIS property (rotate)
          await client.query(
            "update staff_sessions set revoked=true where user_id=$1 and property_id=$2 and revoked=false",
            [mgr.id, prop.id]
          );

          // BRICK ONE: mint through the ONE canonical issuer. purpose:"demo"
          // = server-owned 6h policy; entitlement (the demo manager's real
          // Demo Building assignment) is verified inside  case R fails
          // honestly if the seed has not provisioned it.
          const issued = await staffSessions.issueStaffSession(client, {
            userId: mgr.id, propertyId: prop.id, purpose: "demo",
          });

          await client.query("commit");
          return { token: issued.session_token, property_id: prop.id, expires_in_hours: issued.expires_in_hours };
        } catch (e) {
          await client.query("rollback");
          throw e;
        } finally {
          client.release();
        }
      })();
      // the raw token is returned ONCE; the page holds it in MEMORY only (never localStorage/URL).
      return res.json({ ok: true, session_token: out.token, property_id: out.property_id, expires_in_hours: out.expires_in_hours });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || "bootstrap failed" });
    }
  });

  // ── a trivial "who am I" so the page can confirm its session resolved ──
  // property_name is included (additive) so the app's chrome can honestly label
  // the LIVE door with the session's property instead of the shell's active deal
  // ("SOLO ON CHESTNUT over Demo Building data" fix). Best-effort: a lookup
  // failure degrades to null, never a 500 — the identity fields still resolve.
  router.get("/operator/me", requireOperator, async (req, res) => {
    const o = req.operator;
    res.set("Cache-Control", "no-store");
    let propertyName = null;
    try {
      // display_name (migration 060) is what humans call the property; the
      // internal name is load-bearing plumbing. Honest chrome shows the former.
      const p = (await pool.query("select coalesce(display_name, name) as name from properties where id=$1", [o.property_id])).rows[0];
      propertyName = p ? p.name : null;
    } catch (_) { /* honest null beats a failed handshake */ }
    // allowed_modules is LIVE on req.operator from the shared resolveSession
    // (same source the leasing-module gate reads). Forwarding it here makes
    // /operator/me the AUTHORITATIVE module source the shell needs on every
    // boot path — closing the Runtime Map session-contract gap. Array always
    // (never null) so the client can trust it as truth, not guess from a token.
    // Include platform_role so the frontend can detect super admins and show the admin panel
    let platform_role = 'member';
    try {
      const pr = (await pool.query(`select platform_role from users where id=$1`, [o.id])).rows[0];
      platform_role = pr ? (pr.platform_role || 'member') : 'member';
    } catch (_) {}
    return res.json({ id: o.id, name: o.name, role: o.role, property_id: o.property_id, property_name: propertyName, allowed_modules: Array.isArray(o.allowed_modules) ? o.allowed_modules : [], platform_role });
  });

  // ── property-scope verification helpers (used by every read/write below) ──
  // verify a conversation belongs to the session's property; returns it or throws 403/404.
  async function scopedConversation(client, conversationId, propertyId) {
    const c = (await client.query("select * from conversations where id=$1", [conversationId])).rows[0];
    if (!c) throw httpErr(404, "Conversation not found.");
    if (c.property_id !== propertyId) throw httpErr(403, "Not in your property scope.");
    return c;
  }
  // verify a fact belongs to the session's property; returns it or throws.
  async function scopedFact(client, factId, propertyId) {
    const f = (await client.query("select * from agent_facts where id=$1", [factId])).rows[0];
    if (!f) throw httpErr(404, "Fact not found.");
    if (f.property_id !== propertyId) throw httpErr(403, "Not in your property scope.");
    return f;
  }

  // ════════════════════════════════════════════════════════════════════
  //  VERIFIED FACTS — property-scoped to the session. approved_by from session.
  //  NO free :propertyId route — the property is INFERRED from req.operator.
  // ════════════════════════════════════════════════════════════════════
  const FACT_KEYS = ["pet_policy","parking_rules","tour_window","fee_policy","required_documents","office_contact","communication_instructions"];
  const CATEGORY_FOR = {
    pet_policy:"pets", parking_rules:"parking", tour_window:"tours", fee_policy:"fees",
    required_documents:"documents", office_contact:"routing", communication_instructions:"routing",
  };
  const SOURCE_TYPES = ["management_policy","lease_or_addendum","verified_operator_confirmation","other_documented_source"];

  // GET /operator/agent-facts — active + retired facts for the SESSION's property.
  // ── TURN-PRIORITY (session-scoped) — GET /operator/leasing/turn-priority ──
  //  Property SERVER-DERIVED from the session. Calls the shared rankTurnPriority
  //  helper (one ranking, no second copy). READ-ONLY. (slice 1)
  router.get("/operator/leasing/turn-priority", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await rankTurnPriority(pool, req.operator.property_id);
      return res.json(out);
    } catch (e) {
      console.error("operator turn-priority error", e);
      return res.status(500).json({ error: "TURN_PRIORITY_FAILED", receipt: "The turn-priority read failed. Retry; if it persists the ranking service is unavailable." });
    }
  });

  // ── APPLICATION REVIEW (slice 2) — READ-ONLY. Makes Build A visible: structured
  //    terms, completeness, concession (governed dated lines if structured), and
  //    packet currency (not_generated | current | stale — drift is real because
  //    lease_packets.terms_json is persisted). Property SERVER-DERIVED; each
  // ── THE LEASING DESK ────────────────────────────────────────────────────
  // ONE read-only projection backing the operator Leasing home. NO
  // dormantWriteGuard: the read grants no write authority; every button's POST
  // enforces its own perimeter downstream. Property scope is SERVER-DERIVED
  // (req.operator.property_id, never client input). The loader composes
  // applications + follow-ups + recently-closed inside ONE repeatable-read
  // snapshot; a failure is ONE honest unavailable contract with no legacy or
  // fixture fallback.
  router.get("/operator/leasing/desk", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const desk = await loadLeasingDesk(
        {
          pool,
          applicationReview: { buildReviewList, buildReviewDetail },
          applicationsService,
          conversionService,
          staffIdentity,
        },
        req.operator.property_id
      );
      return res.json(desk);
    } catch (e) {
      console.error("leasing desk error", e);
      return res.status(503).json({
        error: "LEASING_DESK_UNAVAILABLE",
        receipt: "The Leasing desk could not be loaded. Retry; if it persists the desk service is unavailable.",
      });
    }
  });

  //    application verified to belong to the operator's property. NO write controls.
  router.get("/operator/leasing/applications-review", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      const out = await buildReviewList(client, req.operator.property_id);
      return res.json(out);
    } catch (e) {
      console.error("applications-review list error", e);
      return res.status(500).json({ error: "APPLICATIONS_REVIEW_FAILED", receipt: "The applications review failed to load. Retry; if it persists the review service is unavailable." });
    } finally { client.release(); }
  });

  router.get("/operator/leasing/application-review", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const applicationId = req.query.application_id;
    if (!applicationId) return res.status(400).json({ error: "MISSING_APPLICATION_ID", receipt: "application_id is required." });
    const client = await pool.connect();
    try {
      // Slice 1: pass the canonical lifecycle resolvers (composition seam).
      // buildReviewDetail loads the facts; applicationsService.applicationNext
      // interprets them; the response carries ONE precise next_action. Absent
      // applicationsService (older server.js) → next_action is an honest null.
      const out = await buildReviewDetail(client, applicationId, req.operator.property_id,
        applicationsService ? { loadGate: applicationsService.outstanding,
                                resolveNext: applicationsService.applicationNext } : null);
      if (out && out.notInScope) return res.status(404).json({ error: "APPLICATION_NOT_IN_SCOPE", receipt: "No such application for this property." });
      return res.json(out);
    } catch (e) {
      console.error("application-review detail error", e);
      return res.status(500).json({ error: "APPLICATION_REVIEW_FAILED", receipt: "The application review failed to load. Retry; if it persists the review service is unavailable." });
    } finally { client.release(); }
  });

  router.get("/operator/agent-facts", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const rows = (await pool.query(
        `select id, fact_key, category, rendered_text, source_type, source_record_id,
                confirmed_at, effective_until, status, approved_by_user_id, created_at
           from agent_facts where property_id=$1
          order by status asc, fact_key asc, created_at desc`,
        [req.operator.property_id]
      )).rows;
      return res.json({ property_id: req.operator.property_id, facts: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // validate + normalize a fact body. Returns {fact_key, category, rendered_text, source_type, confirmed_at, effective_until} or throws.
  function normalizeFactBody(b) {
    const fact_key = (b && b.fact_key || "").trim();
    if (!FACT_KEYS.includes(fact_key)) throw httpErr(400, `fact_key must be one of: ${FACT_KEYS.join(", ")}`);
    const rendered_text = (b && b.rendered_text || "").trim();
    if (!rendered_text) throw httpErr(400, "rendered_text (the approved wording) is required.");
    const source_type = (b && b.source_type || "").trim();
    if (!SOURCE_TYPES.includes(source_type)) throw httpErr(400, `source_type must be one of: ${SOURCE_TYPES.join(", ")}`);
    const confirmed_at = (b && b.confirmed_at) ? new Date(b.confirmed_at) : new Date();
    const effective_until = (b && b.effective_until) ? new Date(b.effective_until) : null;
    return { fact_key, category: CATEGORY_FOR[fact_key], rendered_text, source_type, confirmed_at, effective_until };
  }

  // insert a new ACTIVE fact within an open client. Enforces the one-active-per-key
  // rule by first retiring any existing active fact for that (property, fact_key).
  // (space_id null = property-wide for this first pass.)
  async function insertActiveFact(client, { property_id, approved_by, f }) {
    await client.query(
      "update agent_facts set status='retired' where property_id=$1 and fact_key=$2 and status='active' and space_id is null",
      [property_id, f.fact_key]
    );
    const row = (await client.query(
      `insert into agent_facts
         (property_id, space_id, fact_key, category, rendered_text, source_type,
          confirmed_at, effective_until, status, approved_by_user_id)
       values ($1, null, $2, $3, $4, $5, $6, $7, 'active', $8) returning *`,
      [property_id, f.fact_key, f.category, f.rendered_text, f.source_type, f.confirmed_at, f.effective_until, approved_by]
    )).rows[0];
    return row;
  }

  // POST /operator/agent-facts — add a verified fact. approved_by from SESSION.
  // If an active fact with the same key exists, it's retired (one active per key).
  router.post("/operator/agent-facts", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const f = normalizeFactBody(req.body);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = await insertActiveFact(client, { property_id: req.operator.property_id, approved_by: req.operator.id, f });
        await client.query("commit");
        return res.json({ ok: true, fact: row });
      } catch (e) { await client.query("rollback"); throw e; }
      finally { client.release(); }
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/agent-facts/:factId/retire — retire one active fact (scoped).
  router.post("/operator/agent-facts/:factId/retire", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const f = await scopedFact(client, req.params.factId, req.operator.property_id); // 403 if cross-property
        if (f.status !== "active") throw httpErr(409, `Fact is already '${f.status}'.`);
        await client.query("update agent_facts set status='retired' where id=$1", [f.id]);
        await client.query("commit");
        return res.json({ ok: true, retired_fact_id: f.id });
      } catch (e) { await client.query("rollback"); throw e; }
      finally { client.release(); }
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/agent-facts/:factId/replace — ATOMIC: retire the named active fact
  // AND create the replacement in ONE transaction. Prior wording/source/approver/dates
  // are preserved on the retired row (we never edit in place). approved_by from SESSION.
  router.post("/operator/agent-facts/:factId/replace", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const f = normalizeFactBody(req.body); // the replacement's fields (validated first)
      const client = await pool.connect();
      try {
        await client.query("begin");
        const old = await scopedFact(client, req.params.factId, req.operator.property_id); // 403 if cross-property
        if (old.status !== "active") throw httpErr(409, `Can only replace an active fact (this is '${old.status}').`);
        // retire the specific old fact (its history row stays intact)
        await client.query("update agent_facts set status='retired' where id=$1", [old.id]);
        // create the replacement active fact (insertActiveFact also retires any other
        // active fact of that key, keeping the one-active invariant even if key changed)
        const row = await insertActiveFact(client, { property_id: req.operator.property_id, approved_by: req.operator.id, f });
        await client.query("commit");
        return res.json({ ok: true, retired_fact_id: old.id, new_fact: row });
      } catch (e) { await client.query("rollback"); throw e; }
      finally { client.release(); }
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  LEASING CONVERSATIONS — session-scoped wrappers over the EXTRACTED agent
  //  services. The page calls ONLY these (never legacy /agent/*). Every route
  //  derives property from the session and verifies the target record's scope.
  // ════════════════════════════════════════════════════════════════════
  const CONV_LIST_LIMIT = 50;

  // GET /operator/leasing/conversations — active leasing convos for the SESSION's
  // property only. Property derived from session; NO browser filters; capped.
  router.get("/operator/leasing/conversations", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const rows = (await pool.query(
        `select c.id, c.person_id, p.name as person_name, c.last_message_at,
                ats.mode, ats.thread_version,
                (select count(*) from agent_drafts d
                   join agent_runs r on r.id=d.agent_run_id
                  where r.conversation_id=c.id and d.status='ready') as ready_drafts
           from conversations c
           join persons p on p.id = c.person_id
           left join agent_thread_state ats on ats.conversation_id = c.id
          where c.property_id = $1
          order by c.last_message_at desc nulls last, c.created_at desc
          limit $2`,
        [req.operator.property_id, CONV_LIST_LIMIT]
      )).rows;
      return res.json({ property_id: req.operator.property_id, conversations: rows, capped_at: CONV_LIST_LIMIT });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ── PROSPECT VITALS — the Person Card's permanent data contract. ──────────
  // Given a person + property, return the structured facts we know about a
  // prospect, in a FIXED shape the Person Card already renders. This is the
  // birth of the lifetime Person Record's prospect vitals: today only
  // `move_month` is fed from real data (captured at propertyspine.com and stored
  // on the lead's raw_payload); every other slot is an HONEST NULL. Slice 2 (the
  // typed person_attributes store + conversational AI capture) fills the SAME
  // slots — no re-plumbing, because the contract is fixed here once.
  //   Read-only. Never invents a value. Absence = null, never a guess.
  async function prospectVitals(client, { personId, propertyId }) {
    const empty = { move_month: null, budget: null, unit_type: null, occupants: null, pets: null, reason: null };
    if (!personId) return empty;
    const out = { ...empty };
    // 1) Form fallback: the intake's move-month on the most recent lead's raw_payload.
    const lead = (await client.query(
      `select raw_payload from leasing_leads
        where person_id=$1 and property_id=$2
        order by created_at desc limit 1`,
      [personId, propertyId]
    )).rows[0];
    try {
      const rp = lead && lead.raw_payload
        ? (typeof lead.raw_payload === "string" ? JSON.parse(lead.raw_payload) : lead.raw_payload)
        : null;
      const v = rp && rp.desired_move_month;
      if (v === "flexible" || (typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v))) out.move_month = v;
    } catch (_) { /* honest null beats a bad parse */ }
    // 2) The REAL store (migration 061): typed, sourced person_attributes OVERLAY the
    //    fallback — the newest confirmed capture wins. Fail-soft if the table is not
    //    migrated yet: vitals degrade to the form fallback, never a 500.
    try {
      const attrs = (await client.query(
        `select attr_key, attr_value from person_attributes
          where person_id=$1 and property_id is not distinct from $2 and status='active'`,
        [personId, propertyId]
      )).rows;
      for (const a of attrs) if (a.attr_key in out && a.attr_value != null) out[a.attr_key] = a.attr_value;
    } catch (_) { /* table may not exist yet — degrade to fallback */ }
    return out;
  }

  // ── SOURCE CONVERSION (slice 3) — the funnel per lead source, HONEST COUNTS. ──
  // leads   = distinct opportunities by source (leasing_leads.source_id),
  //           EXCLUDING internal_qa records (§23)
  // tours   = of those, leads with a tour in EITHER store — externally-ingested
  //           scheduled_tours OR the canonical internal leasing_tours (039).
  //           Same both-stores definition the board's live_tour CTE uses; a lead
  //           with a tour in both counts once because leads are counted, not tours.
  //           Previously this read scheduled_tours alone, of which Demo Building
  //           has ZERO, so every source reported 0 tours while 16 real tours sat
  //           in the other table.
  // leases  = of those, leads whose status reached 'leased'
  // NOT included yet: applications. lease_applications has no source linkage and
  // person_id is null on 8 of 14 rows, so an application column would be a guess.
  // Rates are computed by the CALLER (the UI), from raw counts — the API ships
  // counts only, so no rounding opinion is baked into the truth. Fail-soft: any
  // error returns [] (the UI simply shows nothing) — never breaks the queue.
  async function sourceConversion(propertyId) {
    try {
      return (await pool.query(
        `select coalesce(ls.name,'(no source)') as source,
                count(ll.id)::int as leads,
                count(ll.id) filter (where
                  exists (select 1 from scheduled_tours st
                           where st.person_id = ll.person_id and st.property_id = ll.property_id)
                  or exists (select 1 from leasing_tours lt
                              where lt.lead_id = ll.id)
                )::int as tours,
                count(ll.id) filter (where ll.status = 'leased')::int as leases
           from leasing_leads ll
           left join lead_sources ls on ls.id = ll.source_id
          where ll.property_id = $1
            -- §23: controlled QA records are excluded from leasing metrics and
            -- reporting. Without this the strip counted internal_qa fixtures as
            -- demand — 99 of 132 Demo leads were harness rows named 'T5 Handoff',
            -- 'B1 Retry' and the like, inserted directly by tests that bypass
            -- intake. An operator was reading test residue as a funnel.
            and not exists (
              select 1 from person_property_classifications c
               where c.person_id = ll.person_id
                 and c.property_id = ll.property_id
                 and c.superseded_at is null
                 and c.record_class = 'internal_qa')
          group by coalesce(ls.name,'(no source)')
          order by leads desc`,
        [propertyId]
      )).rows;
    } catch (e) {
      console.error("[operator] sourceConversion failed (non-fatal):", (e && e.message) || "unknown");
      return [];
    }
  }

  // ── TODAY COUNTS — Jessica's 7pm EOD email, computed instead of typed. ────────
  // The thin "TODAY · N new leads · N tours" strip at the top of the Leasing panel.
  // V1 ships the TWO counts we can prove against confirmed columns:
  //   new_leads = leasing_leads created today (created_at)
  //   tours     = tours BOOKED today across BOTH stores, deduped exactly like the
  //               live_tour CTE: external scheduled_tours (property-scoped) UNION the
  //               canonical internal leasing_tours (039), joined lead → (person,
  //               property). A tour that exists in both stores counts once.
  // Deliberately NOT included yet: applications-today and signed-today. There is no
  // confirmed created-timestamp for a lease_applications row, and lead.status='leased'
  // is a CURRENT-STATE filter, not a "flipped-today" fact — counting it would print the
  // same number every day regardless of activity (a confident-wrong number). Those two
  // ride the Commitment Ledger's real timestamps (locked_at / deposit_received_at) when
  // they exist; this resolver simply gains two fields then. Honest blank beats a guess.
  //
  // DAY BOUNDARY: the portfolio has no per-property timezone column, and every property
  // that exists is Philadelphia / Western PA (Eastern). "Today" is therefore bounded by
  // America/New_York, not the Render server clock (which is UTC and would flip the day at
  // 8pm local — wrong during a 7pm-referenced demo). Single-timezone assumption is stated
  // here on purpose: when a non-Eastern property lands, this is the line that must change.
  // Fail-soft to zeros: any error returns all-zero counts and never breaks the queue.
  async function todayCounts(propertyId) {
    const zero = { new_leads: 0, tours: 0 };
    try {
      const r = (await pool.query(
        `with today as (
           select (now() at time zone 'America/New_York')::date as d
         ),
         nl as (
           select count(*)::int as n
             from leasing_leads ll, today
            where ll.property_id = $1
              and (ll.created_at at time zone 'America/New_York')::date = today.d
         ),
         booked as (
           select st.id as tour_id
             from scheduled_tours st, today
            where st.property_id = $1
              and (st.created_at at time zone 'America/New_York')::date = today.d
           union
           select t.id as tour_id
             from leasing_tours t
             join leasing_leads ll on ll.id = t.lead_id, today
            where ll.property_id = $1
              and (t.created_at at time zone 'America/New_York')::date = today.d
         )
         select (select n from nl) as new_leads,
                (select count(*)::int from booked) as tours`,
        [propertyId]
      )).rows[0];
      return { new_leads: (r && r.new_leads) || 0, tours: (r && r.tours) || 0 };
    } catch (e) {
      console.error("[operator] todayCounts failed (non-fatal):", (e && e.message) || "unknown");
      return zero;
    }
  }

  // GET /operator/leasing/conversations/:conversationId — one convo, SCOPE-VERIFIED.
  // Returns the thread/draft via the shared getConversationStateService, PLUS the
  // prospect vitals for the Person Card (fixed contract; honest nulls).
  router.get("/operator/leasing/conversations/:conversationId", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      let vitals;
      const client = await pool.connect();
      try {
        const conv = await scopedConversation(client, req.params.conversationId, req.operator.property_id);
        vitals = await prospectVitals(client, { personId: conv.person_id, propertyId: req.operator.property_id });
      } finally { client.release(); }
      const state = await agentService.getConversationStateService({ conversationId: req.params.conversationId });
      // Human attribution belongs on the communication itself. The shared agent
      // service returns sent_by_user_id; this operator projection resolves the
      // display name without changing the canonical comm_event.
      if (Array.isArray(state.messages) && state.messages.length) {
        const senderIds = [...new Set(state.messages.map(m => m.sent_by_user_id).filter(Boolean))];
        const senderRows = senderIds.length
          ? (await pool.query("select id, name from users where id = any($1::uuid[])", [senderIds])).rows
          : [];
        const senderName = new Map(senderRows.map(u => [u.id, u.name]));
        state.messages = state.messages.map(m => ({
          ...m,
          sender_name: m.sent_by_user_id ? (senderName.get(m.sent_by_user_id) || null) : null,
        }));
      }
      // also include this property's facts so the page shows what the agent may use
      const facts = (await pool.query(
        `select id, fact_key, category, rendered_text, source_type, confirmed_at, effective_until, status
           from agent_facts where property_id=$1 and status='active' order by fact_key asc`,
        [req.operator.property_id]
      )).rows;
      // BL-3: the opened relationship must be able to render its TRUE lifecycle
      // state without inferring closure from disappearance elsewhere. Reuse the
      // SAME PROJECTION_CTE the queue derives commercial_state/closure from —
      // one canonical derivation, never a second copy. A null row here (rare
      // eligibility-boundary edge case shared with the queue) degrades to
      // honest nulls, never a crash.
      const proj = (await pool.query(
        PROJECTION_CTE + `
        select commercial_state, closure_reason, closure_note, closure_actor_id,
               closure_actor_name, closure_occurred_at, closure_recorded_at
        from projected where conversation_id=$2`,
        [req.operator.property_id, req.params.conversationId]
      )).rows[0] || null;
      const commercial_state = proj ? proj.commercial_state : null;
      const closure = (proj && proj.commercial_state === "closed_not_fit")
        ? { reason_code: proj.closure_reason, reason_note: proj.closure_note,
            actor_id: proj.closure_actor_id, actor_name: proj.closure_actor_name,
            occurred_at: proj.closure_occurred_at, recorded_at: proj.closure_recorded_at }
        : null;
      return res.json({ ...state, facts, vitals, commercial_state, closure });
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/leasing/conversations/:conversationId/reply
  // The Person Card's human-text door. This is a THIN staff-session adapter over
  // leasinginteractions.recordOutboundText — the one interaction ledger + the
  // one communications boundary. The browser supplies only body text. Property,
  // person, recipient, and actor are all server-derived and scope-verified.
  router.post("/operator/leasing/conversations/:conversationId/reply", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = (req.body && typeof req.body.body === "string") ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "Write a message first." });
    if (body.length > 1500) return res.status(400).json({ error: "Message is too long (1500 characters maximum)." });
    if (!interactionsService || typeof interactionsService.recordOutboundText !== "function") {
      return res.status(503).json({ error: "The canonical communications service is unavailable." });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const conv = await scopedConversation(client, req.params.conversationId, req.operator.property_id);

      // A soft-closed relationship is terminal until a deliberate reopen. The
      // conversation row remains open by design, so enforce lifecycle truth here.
      const life = (await client.query(
        `select max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
                max(event_sequence) filter (where event_type='reopened') as reopen_seq
           from leasing_lead_lifecycle_events
          where conversation_id=$1`, [conv.id]
      )).rows[0] || {};
      if (life.close_seq != null && (life.reopen_seq == null || Number(life.reopen_seq) < Number(life.close_seq))) {
        const e = httpErr(409, "Reopen the relationship before sending another message.");
        throw e;
      }

      const person = (await client.query(
        "select primary_phone_e164 from persons where id=$1", [conv.person_id]
      )).rows[0];
      if (!person || !person.primary_phone_e164) throw httpErr(409, "This person has no verified text number.");

      const out = await interactionsService.recordOutboundText(client, {
        person_id: conv.person_id,
        property_id: req.operator.property_id,
        body,
        actor_user_id: req.operator.id,
        to: person.primary_phone_e164,
      });
      await client.query("commit");
      return res.json({
        receipt: out.sent ? "Message sent and recorded." : `Message recorded but not delivered (${out.provider_status}).`,
        ...out,
      });
    } catch (e) {
      await client.query("rollback");
      return res.status(e.httpStatus || e.http || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // POST /operator/agent-drafts/:draftId/send — SCOPE-VERIFIED, actor=session user.
  router.post("/operator/agent-drafts/:draftId/send", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await assertDraftInScope(req.params.draftId, req.operator.property_id);
      const editedBody = (req.body && typeof req.body.body === "string") ? req.body.body : null;
      const out = await agentService.sendDraftService({
        draftId: req.params.draftId, editedBody, actorUserId: req.operator.id, // server-derived
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/agent-drafts/:draftId/edit-and-send — same service, editedBody required.
  router.post("/operator/agent-drafts/:draftId/edit-and-send", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const editedBody = (req.body && typeof req.body.body === "string") ? req.body.body.trim() : "";
      if (!editedBody) throw httpErr(400, "An edited body is required for edit-and-send.");
      await assertDraftInScope(req.params.draftId, req.operator.property_id);
      const out = await agentService.sendDraftService({
        draftId: req.params.draftId, editedBody, actorUserId: req.operator.id,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/agent-drafts/:draftId/regenerate — SCOPE-VERIFIED via the draft's
  // conversation; regenerate service resolves by the conversation's person+property.
  router.post("/operator/agent-drafts/:draftId/regenerate", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const conv = await assertDraftInScope(req.params.draftId, req.operator.property_id);
      const out = await agentService.regenerateDraftService({ property_id: conv.property_id, person_id: conv.person_id });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/conversations/:conversationId/take-over — SCOPE-VERIFIED.
  router.post("/operator/conversations/:conversationId/take-over", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const client = await pool.connect();
      try { await scopedConversation(client, req.params.conversationId, req.operator.property_id); }
      finally { client.release(); }
      const out = await agentService.takeOverConversationService({
        conversationId: req.params.conversationId, actorUserId: req.operator.id,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // HAND BACK: the explicit counterpart to take-over. Returns a human_takeover
  // thread to ai_active. Scope-verified against the session property; the actor
  // is server-derived. The no-silent-re-entry invariant holds -- only this
  // deliberate route (or an approved draft send) re-enters the AI.
  router.post("/operator/conversations/:conversationId/hand-back", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const client = await pool.connect();
      try { await scopedConversation(client, req.params.conversationId, req.operator.property_id); }
      finally { client.release(); }
      const out = await agentService.handBackConversationService({
        conversationId: req.params.conversationId, actorUserId: req.operator.id,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // verify a draft's conversation belongs to the session property; returns the conversation row.
  async function assertDraftInScope(draftId, propertyId) {
    const r = (await pool.query(
      `select c.* from agent_drafts d
         join agent_runs ar on ar.id = d.agent_run_id
         join conversations c on c.id = ar.conversation_id
        where d.id = $1`,
      [draftId]
    )).rows[0];
    if (!r) throw httpErr(404, "Draft not found.");
    if (r.property_id !== propertyId) throw httpErr(403, "Not in your property scope.");
    return r;
  }

  // ════════════════════════════════════════════════════════════════════
  //  PRE-TOUR AI CONVERSATIONS — the queue read + the two browser lifecycle writes
  //  (Foundation 054). Three axes: commercial_state / waiting_on / delivery_state.
  //  Scoped to the session property on read AND write via requireOperator. The write
  //  path locks the conversation row and asserts tour property+person match.
  //
  //  AUTHORITY (locked + tested): close_not_fit / reopen are a REOPENABLE disposition —
  //  they do NOT write leasing_leads.status. The lead stays in the open set (so reopen
  //  always works) and leaves/re-enters the ACTIVE queue purely by projection. Terminal
  //  'lost' remains owned by the lead module (leasingleads.recordLeadEvent), not here.
  // ════════════════════════════════════════════════════════════════════

  const conversationOperating = require("../shared/conversation_operating_contract");

  const QUEUE_LIMIT = 50;
  const ACTIVE_STATES = ["new", "active"];
  // BL-3: an EXPLICIT, separate closed-state contract — never merged into the
  // active universe. The active tabs' query is untouched; scope=closed is a
  // distinct, validated branch of the SAME canonical endpoint (one service,
  // no second copy of the routing precedence), requested only when the
  // Closed tab is opened.
  const CLOSED_STATES = ["closed_not_fit"];
  const QUEUE_SCOPES = { active: ACTIVE_STATES, closed: CLOSED_STATES };

  // The proven queue_projection_v1 logic, parameterized by property ($1). One row per
  // ELIGIBLE conversation (open lead, not applied/leased/lost, conversation open).
  const PROJECTION_CTE = `
    with eligible as (
      select c.id as conversation_id, c.property_id, c.person_id, ll.status as lead_status
      from leasing_leads ll
      join conversations c on c.property_id = ll.property_id and c.person_id = ll.person_id
      where ll.status not in ('applied','leased','lost') and c.status = 'open'
        and c.property_id = $1
        -- FLOW POSITION (Slice 3): one leasing opportunity, one position. Once
        -- this person+property's conversion has advanced to applicant_followup
        -- or beyond (an application was ACTUALLY SENT — the rail's authorized
        -- transition), they are no longer pre-tour work. The exclusion lives
        -- HERE, in the one shared CTE, so every consumer (counts, buckets,
        -- rows) reconciles by construction. The conversation itself stays open
        -- and reachable from the Follow-Ups row's Message action.
        and not exists (
          select 1 from leasing_conversions lc
          join leasing_conversion_obligations flo on flo.conversion_id = lc.id
          where lc.person_id = c.person_id and lc.property_id = c.property_id
            and flo.rung in ('applicant_followup','lease_signature_followup','terms_review_followup')
        )
    ),
    life as (
      select conversation_id,
             max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
             max(event_sequence) filter (where event_type='reopened')       as reopen_seq
      from leasing_lead_lifecycle_events group by conversation_id
    ),
    close_reason as (
      -- BL-3: the durable closure event is the SOURCE for all closure metadata
      -- surfaced anywhere (queue row, detail contract, Person Card history) —
      -- one derivation, no second copy. actor_name resolved here so every
      -- consumer gets a display-ready name, never a bare id to re-resolve.
      select distinct on (e.conversation_id) e.conversation_id, e.reason_code,
             e.reason_note, e.actor_id, e.occurred_at as closed_at, e.recorded_at as closed_recorded_at,
             cu.name as closed_by_name
      from leasing_lead_lifecycle_events e
      left join users cu on cu.id = e.actor_id
      where e.event_type='closed_not_fit'
      order by e.conversation_id, e.event_sequence desc
    ),
    live_tour as (
      -- A live tour for a conversation can come from EITHER store:
      --  (a) an externally-ingested scheduled_tours row explicitly linked via the
      --      054 lifecycle links (unchanged), or
      --  (b) the CANONICAL internal booking domain (039 leasing_tours), derived
      --      through the same lead → (person, property) → conversation join the
      --      Tours surface (/leasing/tours/today) already uses. Before this
      --      correction, internally-booked tours (operator slot-book AND
      --      /demo/book) never flipped commercial_state to booked_tour.
      --      Read-only projection fix: no schema, no second appointment record.
      select distinct on (conversation_id) conversation_id, tour_id, tour_status
      from (
        select l.conversation_id, t.id as tour_id, t.status as tour_status, t.created_at
          from leasing_conversation_tour_links l
          join scheduled_tours t on t.id = l.tour_id
         where l.unlinked_at is null and t.status in ('scheduled','rescheduled')
        union all
        select c.id as conversation_id, t.id as tour_id, t.status as tour_status, t.created_at
          from leasing_tours t
          join leasing_leads ll on ll.id = t.lead_id
          join conversations c on c.person_id = ll.person_id and c.property_id = ll.property_id
         where t.status in ('scheduled','confirmed_by_prospect','checked_in')
      ) u
      order by conversation_id, created_at asc
    ),
    qual_in as (
      select conversation_id, max(occurred_at) as at from comm_events
      where direction='inbound' and sender_role='prospect' and body is not null and btrim(body) <> ''
      group by conversation_id
    ),
    qual_out as (
      select conversation_id, max(occurred_at) as at from comm_events
      where direction='outbound' and sender_role in ('agent','ai') and provider_status in ('sent','delivered')
      group by conversation_id
    ),
    any_out as (
      select distinct on (conversation_id) conversation_id, occurred_at as at, provider_status
      from comm_events where direction='outbound' and sender_role in ('agent','ai')
      order by conversation_id, occurred_at desc
    ),
    attempts_since_inbound as (
      -- CADENCE FACT: delivered AI/agent outbound attempts since the prospect
      -- last spoke (all attempts, if they never have). Server-computed so
      -- cadence exhaustion is a projection fact, never client math.
      -- Threshold 3 below is a Class-2 adapter: replace with property-level
      -- cadence configuration before multi-market activation.
      select o.conversation_id, count(*)::int as n
      from comm_events o
      left join qual_in qi on qi.conversation_id = o.conversation_id
      where o.direction='outbound' and o.sender_role in ('agent','ai')
        and o.provider_status in ('sent','delivered')
        and o.occurred_at > coalesce(qi.at, 'epoch'::timestamptz)
      group by o.conversation_id
    ),
    base as (
      select e.conversation_id, e.person_id, e.property_id, e.lead_status,
        pr.name as person_name,
        coalesce(ats.mode,'ai_active') as control_mode,
        qi.at as last_inbound_at, qo.at as last_delivered_outbound_at,
        ao.at as last_any_outbound_at, ao.provider_status as last_outbound_status,
        greatest(coalesce(qi.at,'epoch'::timestamptz), coalesce(ao.at,'epoch'::timestamptz),
                 coalesce(c.last_message_at,'epoch'::timestamptz)) as last_meaningful_activity_at,
        lt.tour_id, lt.tour_status, cr.reason_code as closure_reason,
        cr.reason_note as closure_note, cr.actor_id as closure_actor_id,
        cr.closed_by_name as closure_actor_name, cr.closed_at as closure_occurred_at,
        cr.closed_recorded_at as closure_recorded_at,
        (qi.at is not null and (qo.at is null or qi.at >= qo.at)) as inbound_unanswered,
        (li.close_seq is not null and (li.reopen_seq is null or li.reopen_seq < li.close_seq)) as is_closed,
        (lt.conversation_id is not null) as is_booked,
        (qi.at is not null or ao.at is not null) as has_engagement,
        coalesce(asi.n, 0) as outreach_attempts
      from eligible e
      join conversations c on c.id = e.conversation_id
      join persons pr on pr.id = e.person_id
      left join life li on li.conversation_id = e.conversation_id
      left join close_reason cr on cr.conversation_id = e.conversation_id
      left join live_tour lt on lt.conversation_id = e.conversation_id
      left join qual_in qi on qi.conversation_id = e.conversation_id
      left join qual_out qo on qo.conversation_id = e.conversation_id
      left join any_out ao on ao.conversation_id = e.conversation_id
      left join attempts_since_inbound asi on asi.conversation_id = e.conversation_id
      left join agent_thread_state ats on ats.conversation_id = e.conversation_id
    ),
    staged as (
      select *,
        case when is_closed then 'closed_not_fit' when is_booked then 'booked_tour'
             when has_engagement then 'active' else 'new' end as commercial_state,
        -- waiting_on: a closed conversation waits on no one. A BOOKED conversation
        -- normally waits on no one EITHER — the tour is set — EXCEPT when a NEW
        -- qualifying inbound arrived after booking and is still unanswered: that
        -- is a real question the manager must answer BEFORE the tour, so it
        -- surfaces as 'manager' (never buried) while commercial_state stays
        -- booked_tour (the tour remains the primary context; the person is NOT
        -- returned to ordinary pre-tour work). [D-7]
        case when is_closed then 'none'
             when is_booked and inbound_unanswered then 'manager'
             when is_booked then 'none'
             when inbound_unanswered and control_mode in ('awaiting_review','human_takeover') then 'manager'
             when inbound_unanswered and control_mode = 'ai_active' then 'ai'
             when last_delivered_outbound_at is not null
                  and (last_inbound_at is null or last_delivered_outbound_at > last_inbound_at)
                  and outreach_attempts >= 3 then 'manager'
             when last_delivered_outbound_at is not null
                  and (last_inbound_at is null or last_delivered_outbound_at > last_inbound_at) then 'prospect'
             else 'none' end as waiting_on,
        case when last_any_outbound_at is null then 'none'
             when last_outbound_status in ('sent','delivered') then 'delivered'
             else 'unknown' end as delivery_state,
        jsonb_build_object('rule_code',
          case when is_closed then 'latest_relevant_lifecycle_is_close'
               when is_booked and inbound_unanswered then 'booked_tour_inbound_unanswered_pending_human'
               when is_booked then 'live_linked_tour'
               when inbound_unanswered and control_mode in ('awaiting_review','human_takeover') then 'qualifying_prospect_inbound_unanswered_pending_human'
               when inbound_unanswered then 'qualifying_prospect_inbound_unanswered'
               when last_delivered_outbound_at is not null and (last_inbound_at is null or last_delivered_outbound_at > last_inbound_at) and outreach_attempts >= 3 then 'cadence_exhausted_pending_human'
               when last_delivered_outbound_at is not null and (last_inbound_at is null or last_delivered_outbound_at > last_inbound_at) then 'delivered_outreach_is_latest'
               when has_engagement then 'engaged_no_clear_owner'
               else 'open_lead_no_qualifying_engagement' end,
          'projection_version','queue_projection_v3') as derivation
      from base
    ),
    projected as (
      -- THE ROUTING LAYER (Control Board). The bucket is a SERVER-AUTHORED fact
      -- derived once, here, from the truth axes. The browser renders this
      -- decision; it never reproduces the precedence. Buckets are mutually
      -- exclusive by construction: one case expression, one value per row.
      select *,
        case
          when control_mode = 'human_takeover' then 'you_own'
          when waiting_on = 'manager'          then 'needs_you'
          when waiting_on = 'ai'               then 'ai_working'
          when waiting_on = 'prospect'         then 'waiting_on_prospect'
          else 'exception'
        end as control_bucket,
        case
          when control_mode = 'human_takeover' then 'human_takeover'
          when waiting_on = 'manager' and (derivation->>'rule_code') = 'cadence_exhausted_pending_human' then 'cadence_exhausted_pending_human'
          when waiting_on = 'manager'          then 'draft_requires_review'
          when waiting_on = 'ai'               then 'ai_preparing_reply'
          when waiting_on = 'prospect'         then 'awaiting_prospect'
          when has_engagement                  then 'unowned_engaged'
          else 'unowned_no_engagement'
        end as bucket_reason_code
      from staged
    ),
    operating as (
      select *,
        ${conversationOperating.OPERATING_BUCKET_SQL} as operating_bucket,
        ${conversationOperating.OPERATING_REASON_SQL} as operating_reason_code,
        ${conversationOperating.OPERATING_PRIORITY_SQL} as operating_priority
      from projected
    )`;

  // GET /operator/leasing/conversation-queue — the ACTIVE WORK QUEUE (working states),
  // cursor-paginated, with server-side counts across ALL commercial states.
  router.get("/operator/leasing/conversation-queue", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
      // BL-3: an explicit, validated scope — 'active' (default, unchanged
      // behavior) or 'closed'. Anything else falls back to 'active' rather
      // than erroring, so a malformed param can never leak the wrong universe.
      const scope = Object.prototype.hasOwnProperty.call(QUEUE_SCOPES, req.query.scope) ? req.query.scope : "active";
      const STATES = QUEUE_SCOPES[scope];
      const limit = Math.min(Number(req.query.limit) || QUEUE_LIMIT, QUEUE_LIMIT);
      const beforeTs = req.query.before_activity_at || null;
      const beforeId = req.query.before_id || null;
      const asOf = (await pool.query("select now() as now")).rows[0].now;

      const counts = (await pool.query(
        PROJECTION_CTE + `
        select commercial_state, count(*)::int as n,
               count(*) filter (where waiting_on='ai')::int       as waiting_ai,
               count(*) filter (where waiting_on='manager')::int  as waiting_manager,
               count(*) filter (where waiting_on='prospect')::int as waiting_prospect
        from projected group by commercial_state`,
        [propertyId]
      )).rows.reduce((acc, r) => {
        acc.by_state[r.commercial_state] = r.n;
        acc.waiting.ai += r.waiting_ai; acc.waiting.manager += r.waiting_manager; acc.waiting.prospect += r.waiting_prospect;
        return acc;
      }, { by_state: {}, waiting: { ai:0, manager:0, prospect:0 } });

      // CONTROL BOARD bucket counts (ruling: server-authored, mutually exclusive,
      // reconciling exactly with the visible rows). Grouped on the SAME
      // control_bucket the rows return, over the SAME visible universe.
      const bucketRows = (await pool.query(
        PROJECTION_CTE + `
        select control_bucket, count(*)::int as n
        from projected
        where commercial_state = any($2::text[])
        group by control_bucket`,
        [propertyId, STATES]
      )).rows;
      const buckets = { needs_you: 0, you_own: 0, ai_working: 0, waiting_on_prospect: 0, exception: 0 };
      for (const b of bucketRows) { if (Object.prototype.hasOwnProperty.call(buckets, b.control_bucket)) buckets[b.control_bucket] = b.n; }
      counts.buckets = buckets;

      const operatingBucketRows = (await pool.query(
        PROJECTION_CTE + `
        select operating_bucket, count(*)::int as n
        from operating
        where commercial_state = any($2::text[])
        group by operating_bucket`,
        [propertyId, STATES]
      )).rows;
      const operatingBuckets = { ...conversationOperating.EMPTY_COUNTS };
      for (const b of operatingBucketRows) {
        if (Object.prototype.hasOwnProperty.call(operatingBuckets, b.operating_bucket)) {
          operatingBuckets[b.operating_bucket] = b.n;
        }
      }
      counts.operating_buckets = operatingBuckets;
      counts.operating_total = Object.values(operatingBuckets).reduce((n, value) => n + Number(value || 0), 0);

      const params = [propertyId, STATES];
      let cursorClause = "";
      if (beforeTs) {
        params.push(beforeTs);
        if (beforeId) { params.push(beforeId);
          cursorClause = ` and (last_meaningful_activity_at, conversation_id) < ($${params.length-1}::timestamptz, $${params.length}::uuid)`;
        } else { cursorClause = ` and last_meaningful_activity_at < $${params.length}::timestamptz`; }
      }
      params.push(limit + 1);
      const rows = (await pool.query(
        PROJECTION_CTE + `
        select conversation_id, person_id, person_name, lead_status,
               commercial_state, waiting_on, control_mode, delivery_state,
               last_inbound_at, last_delivered_outbound_at, last_meaningful_activity_at,
               tour_id, tour_status, closure_reason, closure_note, closure_actor_id,
               closure_actor_name, closure_occurred_at, closure_recorded_at, outreach_attempts,
               last_any_outbound_at, last_outbound_status,
               control_bucket, bucket_reason_code,
               operating_bucket, operating_reason_code, operating_priority, derivation
        from operating
        -- CONTROL BOARD universe: new/active only. A booked_tour conversation
        -- remains in Person history but is NOT an active board card and does not
        -- inflate bucket counts -- it transfers operationally to the Tours
        -- surface. ACKNOWLEDGED INTERIM HOLE: the prior [D-7] case (booked tour
        -- + new unanswered inbound) is no longer surfaced here; the Tours
        -- surface (next diff) must render it as its own exception with a named
        -- closure action. The underlying facts (waiting_on='manager') remain
        -- computed and queryable.
        where commercial_state = any($2::text[]) ${cursorClause}
        order by operating_priority asc, last_meaningful_activity_at desc, conversation_id desc
        limit $${params.length}`,
        params
      )).rows;

      let nextCursor = null;
      if (rows.length > limit) {
        const last = rows[limit - 1];
        nextCursor = { before_activity_at: last.last_meaningful_activity_at, before_id: last.conversation_id };
        rows.length = limit;
      }
      // SLICE 3: per-source funnel counts ride the queue response (no new loader
      // resource; the Pre-Tour page renders a compact source strip from this).
      const sources = await sourceConversion(propertyId);
      // TODAY STRIP: same pattern — today's counts ride the queue response so the
      // offline Leasing door can render them through the loader tile snapshot, with
      // no new loader resource and no session change.
      const today = await todayCounts(propertyId);

      // AI LEASING STRATEGIES — one additive, read-only projection. The queue
      // remains the operating surface; this supplies only governed identity,
      // validation/deployment state, and exact opportunity assignment. No
      // score, winner, recommendation, or traffic-changing control is exposed.
      const aiLeasingStrategy = await loadAiLeasingStrategyProjection(pool, {
        propertyId,
        conversationIds: rows.map((row) => row.conversation_id),
      });
      for (const row of rows) {
        row.ai_strategy = aiLeasingStrategy.conversation_assignments[String(row.conversation_id)] || null;
      }

      return res.json({
        property_id: propertyId, as_of: asOf, projection_version: "conversation_board_v1",
        scope, counts, sources, today,
        ai_leasing_strategies: {
          contract_version: aiLeasingStrategy.contract_version,
          state: aiLeasingStrategy.state,
          strategies: aiLeasingStrategy.strategies,
          performance: aiLeasingStrategy.performance,
        },
        conversations: rows, next_cursor: nextCursor, limit,
      });
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // GET /operator/leasing/follow-ups — THE CADENCE DUE-ENGINE (read side).
  // The rungs already exist and already carry due_by at spawn (24h → 72h →
  // 48h, leasingconversion.js); what never existed was anything that SURFACES
  // them. This is that surface: a rung is DUE when now() ≥ due_by — computed
  // server-side at read time (queue_projection pattern: the browser is never
  // the source of truth). DISPATCH deliberately does not live here — actually
  // sending the follow-up stays behind the Twilio wall; this read tells a
  // human what is due, it never texts anyone.
  // ══════════════════════════════════════════════════════════════════
  // GET /operator/rent-roll/canonical — MIGRATION ROUTE, NOT PERMANENT.
  //
  // The canonical Current Rent Roll read: positions ARE the rows, from the
  // shared classifier. Exists alongside /operator/rent-roll only so the new
  // response can be proven without breaking the running app.
  //
  // RETIREMENT CONDITION — this route does not survive the sequence:
  //   new service proven → Current Rent Roll switched → factual Future Rent
  //   Roll switched → Availability switched → legacy signed-in consumers
  //   removed → this path removed or promoted to the stable
  //   /operator/rent-roll contract.
  // Two rent-roll APIs are not architecture. Everything in the operating API
  // is meant to be canonical, so the word does not belong in a permanent path.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/rent-roll/canonical", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await currentRentRoll(pool, {
        property_id: req.operator.property_id,      // session only — never req.query
        as_of: req.query.as_of || null,
      });
      return res.json({ ...out, _migration_route: true });
    } catch (e) {
      // An error is an ERROR, never an empty rent roll.
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/leasing/availability-canonical?as_of=&horizon_days=
  //   Availability as the LEASING INTERPRETATION of canonical positions.
  //   Consumes lease, notice, successor, conflict, proof and down state;
  //   adds possession, readiness, turnover and the marketability decision.
  //   vacant != ready != marketable. MIGRATION ROUTE.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/leasing/availability-canonical", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await availabilityRead(pool, {
        property_id: req.operator.property_id,   // session only
        as_of: req.query.as_of || null,
        horizon_days: Number(req.query.horizon_days) || 90,
      });
      return res.json({ ...out, _migration_route: true });
    } catch (e) {
      // A failed live read is UNAVAILABLE. It must never render as vacancy
      // or as marketable inventory.
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/pricing/effective?as_of=
  //   The Pricing & Concessions truth sheet, READ-ONLY. There is no publish
  //   route here and there will not be one until the initial review receipt
  //   is approved. Today this returns a named absence for every property,
  //   which is the correct answer, not a placeholder.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/pricing/effective", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await effectivePropertyPricing(pool, {
        property_id: req.operator.property_id,   // session only, never the client
        as_of: req.query.as_of || null,
      });
      return res.json(out);
    } catch (e) {
      // A failed read is UNAVAILABLE. It must never render as "no pricing",
      // because "no pricing" is itself a governed statement.
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/pricing/decision-packet?as_of=&horizon_days=
  //   The ownership decision surface for version one. Read-only: it borrows
  //   every derivation from the canonical reads, recommends nothing, and
  //   writes nothing.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/pricing/decision-packet", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { pricingDecisionPacket } = require("../money/pricing_decision_packet");
      const out = await pricingDecisionPacket(pool, {
        property_id: req.operator.property_id,   // session only
        as_of: req.query.as_of || null,
        horizon_days: Number(req.query.horizon_days) || 90,
      });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /operator/pricing/publication-preview
  //   DRY RUN. Accepts a proposed sheet and returns what would happen.
  //   Deliberately a POST that WRITES NOTHING — the body is a proposal, not
  //   a command, and the response says `dry_run_no_write_performed`. There is
  //   no publish route to fall through to.
  // ══════════════════════════════════════════════════════════════════
  router.post("/operator/pricing/publication-preview", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { previewPublication } = require("../money/pricing_publication_preview");
      const out = await previewPublication(pool, {
        property_id: req.operator.property_id,   // session only, never the body
        proposal: (req.body && req.body.proposal) || {},
        as_of: (req.body && req.body.as_of) || null,
      });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // PRICING GOVERNANCE. Every route below is read-only or preview-only
  // EXCEPT save-draft and review, which write only draft/receipt rows that
  // no consumer reads. There is deliberately NO publish route mounted.
  // ══════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════
  // GET /operator/actor-context
  //   WHO THE SIGNED-IN OPERATOR IS AS A HUMAN ACTOR. The canonical read
  //   for every surface that needs to know whether a person may act.
  //   Internal ids are returned only where a client legitimately needs to
  //   correlate; display uses names and reasons.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/actor-context", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { resolveActorContext } = require("./actor_context");
      const ctx = await resolveActorContext(pool, {
        user_id: req.operator.id,                 // SESSION ONLY
        property_id: req.operator.property_id,    // SESSION ONLY
      });
      return res.json({
        signed_in_user: ctx.user ? { display_name: ctx.user.display_name,
          login_identifier: ctx.user.login_identifier, account_kind: ctx.user.account_kind } : null,
        linked_person: ctx.person
          ? { display_name: ctx.person.display_name, lifecycle_status: ctx.person.lifecycle_status }
          : null,
        link_status: ctx.link_status,
        property: { property_id: ctx.property_id, name: req.operator.property_name || null },
        property_entitlement: ctx.property_entitlement,
        assignments: (ctx.assignments || []).map((a) => a.role),
        capabilities: ctx.capabilities,
        denied_because: ctx.failure_reason,
        capability_denied_reason: Object.keys(ctx.capabilities || {}).reduce((o, k) => {
          if (!ctx.capabilities[k]) {
            o[k] = ctx.link_status !== "linked"
              ? "This login is not linked to a verified person, so no person-governed action is permitted."
              : "No active owner/asset-manager assignment or explicit grant for this verb on this property.";
          }
          return o;
        }, {}),
        reconciliation_required: ctx.reconciliation_required,
        identity_provenance: ctx.identity_provenance,
      });
    } catch (e) { return res.status(500).json({ error: "actor context unavailable" }); }
  });

  router.get("/operator/pricing/authority", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { pricingAuthority, authorityInventory } = require("../money/pricing_authority");
      const [mine, inventory] = await Promise.all([
        pricingAuthority(pool, { property_id: req.operator.property_id, user_id: req.operator.id }),
        authorityInventory(pool, { property_id: req.operator.property_id }),
      ]);
      return res.json({ mine, inventory });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // The ownership decision sheet. Read-only, and blank where ownership must
  // decide — it cannot populate a governed draft.
  router.get("/operator/pricing/version-one-worksheet", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { versionOneWorksheet } = require("../money/version_one_worksheet");
      return res.json(await versionOneWorksheet(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ── Management: identity & authority. Read-only. ────────────────
  router.get("/operator/authority-view", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { resolveActorContext } = require("./actor_context");
      const { authorityInventory } = require("../money/pricing_authority");
      const [ctx, inv] = await Promise.all([
        resolveActorContext(pool, { user_id: req.operator.id, property_id: req.operator.property_id }),
        authorityInventory(pool, { property_id: req.operator.property_id }),
      ]);
      // Which assignments on this property rest on a NON-STAFF person? That is
      // the row that made the whole inventory misleading, so it is surfaced.
      const suspect = (await pool.query(
        `select a.id assignment_id, a.role, pe.id person_id, pe.name, pe.lifecycle_status, pe.source,
                (select count(*)::int from person_contexts pc
                  where pc.person_id = pe.id and pc.context_type='staff') staff_contexts,
                (select count(*)::int from users u where u.person_id = pe.id) linked_logins
           from assignments a join persons pe on pe.id = a.person_id
          where a.property_id = $1 and a.is_active = true
            and a.role in ('owner','asset_manager')`, [req.operator.property_id])).rows
        .filter((r) => r.staff_contexts === 0 || r.linked_logins === 0);

      return res.json({
        signed_in_account: ctx.user ? {
          display_name: ctx.user.display_name, login_identifier: ctx.user.login_identifier,
          account_kind: ctx.user.account_kind } : null,
        verified_staff_identity: ctx.person
          ? { display_name: ctx.person.display_name, lifecycle_status: ctx.person.lifecycle_status }
          : null,
        link_status: ctx.link_status,
        missing_step: ctx.reconciliation_required
          ? (ctx.user && ctx.user.account_kind !== "human_staff"
              ? "classify_account_as_human_staff" : "link_login_to_verified_person")
          : null,
        property_assignments: (ctx.assignments || []).map((a) => a.role),
        pricing_capabilities: ctx.capabilities,
        authority_source: ctx.basis,
        temporary_grants: (ctx.grants || []).map((g) => ({
          expires: g.effective_until || "no expiry", grant_id: g.grant_id })),
        invalid_authority_on_non_staff_records: suspect.map((s) => ({
          role: s.role, display_name: s.name, lifecycle_status: s.lifecycle_status,
          source: s.source, staff_contexts: s.staff_contexts, linked_logins: s.linked_logins,
          why_invalid: s.staff_contexts === 0
            ? "No governed staff context — this is not a staff record."
            : "No linked login — the authority cannot be exercised by anyone.",
        })),
        purpose: "Make privileged operating authority understandable and auditable. " +
                 "Not a directory, not an HR system.",
      });
    } catch (e) { return res.status(500).json({ error: "authority view unavailable" }); }
  });

  // ── Governed economic terms. All READ-ONLY. ─────────────────────
  router.get("/operator/economics/charges", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { governedCharges } = require("../money/governed_charges");
      return res.json(await governedCharges(pool, {
        property_id: req.operator.property_id,
        as_of: req.query.as_of || null,
        include_drafts: req.query.include_drafts === "1",
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  router.get("/operator/economics/fact-migration-preview", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { factMigrationPreview } = require("../money/fact_migration_preview");
      return res.json(await factMigrationPreview(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // The dark economic adapter's answer, for REVIEW only. Nothing about this
  // route changes what the live agent says — it does not call the adapter.
  router.get("/operator/economics/adapter-preview", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { economicAnswer } = require("../agent/economic_adapter");
      return res.json(await economicAnswer(pool, {
        property_id: req.operator.property_id,
        unit_type_id: req.query.unit_type_id || null,
        intent: req.query.intent || "new_lease",
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // THE ONE DECISION. Read-only; approval is a separate explicit action that
  // is deliberately NOT mounted until ownership approves.
  // APPROVE + PUBLISH. Mounted on ownership approval 2026-07-27. Publishes
  // ONLY fee.application and leaves the assistant on the legacy source.
  router.post("/operator/economics/application-fee/approve", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { approveAndPublish } = require("../money/application_fee_cutover");
      return res.json(await approveAndPublish(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
        approved_digest: (req.body && req.body.approved_digest) || null,
        note: (req.body && req.body.note) || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // THE ATOMIC CUTOVER. Retires the legacy fact in one transaction.
  router.post("/operator/economics/application-fee/cutover", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { cutOver } = require("../money/application_fee_cutover");
      return res.json(await cutOver(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
        note: (req.body && req.body.note) || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  router.get("/operator/economics/application-fee/one-source", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { oneSourceProof } = require("../money/application_fee_cutover");
      return res.json(await oneSourceProof(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ── ADMINISTRATION FEE — the SAME generalized lifecycle as the $50 ────
  // Thin adapters only: each supplies charge_code fee.administration and its
  // declared legacy owner, and every rule executes in
  // governed_charge_cutover.js. Publication and activation remain SEPARATE
  // actions, exactly as they are for the application fee — publishing
  // establishes approved truth; only cutover makes a term quotable.
  router.post("/operator/economics/administration-fee/approve", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { approveAndPublish } = require("../money/administration_fee_cutover");
      return res.json(await approveAndPublish(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
        approved_digest: (req.body && req.body.approved_digest) || null,
        note: (req.body && req.body.note) || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  router.post("/operator/economics/administration-fee/cutover", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { cutOver } = require("../money/administration_fee_cutover");
      return res.json(await cutOver(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
        note: (req.body && req.body.note) || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  router.get("/operator/economics/administration-fee/one-source", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { oneSourceProof } = require("../money/administration_fee_cutover");
      return res.json(await oneSourceProof(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // READINESS EVIDENCE — what stands between the recorded ruling and a
  // publishable term. Read-only; runs the same publication contract that
  // approveAndPublish re-runs, so the operator cannot be told it is ready and
  // then refused.
  router.get("/operator/economics/administration-fee/readiness", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { governedCharges, checkChargePublishable } = require("../money/governed_charges");
      const { termsDigest } = require("../money/administration_fee_cutover");
      const cat = await governedCharges(pool, { property_id: req.operator.property_id, include_drafts: true });
      const row = (cat.one_time_fees || []).find((c) => c.charge_code === "fee.administration") || null;
      if (!row) return res.json({ charge_code: "fee.administration", state: "unavailable" });
      const ruling = (await pool.query(
        `select id, selected_answer, occurred_at, prior_terms_digest, resulting_terms_digest,
                changed_fields_json
           from governed_charge_rulings
          where property_id=$1 and governed_charge_id=$2
          order by occurred_at desc limit 1`,
        [req.operator.property_id, row.charge_id])).rows[0] || null;
      const check = checkChargePublishable({ ...row, property_id: req.operator.property_id },
        { property_id: req.operator.property_id, actor_may_publish: true });
      return res.json({
        charge_code: "fee.administration",
        record_state: row.record_state, quote_state: row.quote_state,
        current_terms_digest: termsDigest(row),
        ruling_recorded: !!ruling,
        ruling: ruling ? { answer: ruling.selected_answer, occurred_at: ruling.occurred_at,
                           changed_fields: ruling.changed_fields_json,
                           digest_after_ruling: ruling.resulting_terms_digest } : null,
        // A digest recorded by the ruling that no longer matches the row means
        // the draft moved again after the decision — the ruling would need
        // revisiting before publication.
        ruling_still_matches_row: ruling ? ruling.resulting_terms_digest === termsDigest(row) : null,
        publishable: check.publishable,
        blockers: check.blockers,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  router.get("/operator/economics/administration-fee-decision", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { administrationFeeDecision } = require("../money/administration_fee_decision");
      return res.json(await administrationFeeDecision(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
      }));
    } catch (e) { return res.status(500).json({ error: "decision unavailable" }); }
  });

  router.get("/operator/economics/application-fee-decision", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { applicationFeeDecision } = require("../money/application_fee_decision");
      return res.json(await applicationFeeDecision(pool, {
        property_id: req.operator.property_id, user_id: req.operator.id,
      }));
    } catch (e) { return res.status(500).json({ error: "decision unavailable" }); }
  });

  router.get("/operator/economics/decision-room", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { economicDecisionRoom } = require("../money/economic_decision_room");
      return res.json(await economicDecisionRoom(pool, {
        property_id: req.operator.property_id,
        include_shadow: req.query.shadow !== "0",
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Multi-class publication preview. Writes nothing; there is no publish route.
  router.post("/operator/economics/publication-preview", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { economicPublicationPreview } = require("../money/economic_publication_preview");
      return res.json(await economicPublicationPreview(pool, {
        property_id: req.operator.property_id,
        user_id: req.operator.id,
        proposal: (req.body && req.body.proposal) || {},
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  router.get("/operator/economics/picture", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { effectiveEconomicPicture } = require("../money/economic_picture");
      return res.json(await effectiveEconomicPicture(pool, {
        property_id: req.operator.property_id,
        as_of: req.query.as_of || null,
        unit_type_id: req.query.unit_type_id || null,
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Shadow comparison. Sends nothing, writes nothing, mutates nothing.
  router.get("/operator/economics/shadow", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { economicShadowReport } = require("../money/economic_shadow");
      return res.json(await economicShadowReport(pool, {
        property_id: req.operator.property_id,
        other_property_id: "9e2bb96e-08e2-41db-81c2-91055ceb50a3",
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  router.get("/operator/pricing/history", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { versionHistory } = require("../money/pricing_lifecycle");
      return res.json(await versionHistory(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  router.post("/operator/pricing/draft", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { saveDraft } = require("../money/pricing_lifecycle");
      const out = await saveDraft(pool, {
        property_id: req.operator.property_id,          // session only, never the body
        user_id: req.operator.id,                        // session only, never the body
        proposal: (req.body && req.body.proposal) || {},
        draft_version_id: (req.body && req.body.draft_version_id) || null,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message, code: e.code || null }); }
  });

  router.post("/operator/pricing/review", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { submitReview } = require("../money/pricing_lifecycle");
      const b = req.body || {};
      const out = await submitReview(pool, {
        property_id: req.operator.property_id,
        user_id: req.operator.id,
        draft_version_id: b.draft_version_id || null,
        proposal: b.proposal || {}, decision: b.decision, note: b.note || null,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message, code: e.code || null }); }
  });

  // ── SLICE 9 — MARKET EVIDENCE (demand + conversion) ─────────────────
  //  Read-only. Property scope from the session, never the query. The window
  //  is property-local and server-resolved: the browser cannot know when a
  //  day starts at a property, so it does not get to say.
  router.get("/operator/pricing/evidence", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { marketEvidenceProjection } = require("../evidence/evidence_projection");
      return res.json(await marketEvidenceProjection(pool, {
        property_id: req.operator.property_id,   // session only, never the query
        start_local: req.query.start_local || null,
        end_local: req.query.end_local || null,
        as_of: req.query.as_of || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message, code: e.code || null }); }
  });

  // ── SLICE 8 — GOVERNED CONCESSION READ ──────────────────────────────
  //  Slice 7's audit recorded that concessions had governed tables but no
  //  operator read. Read-only: authors nothing, approves nothing. Effective
  //  state is server-authored so no surface has to decide for itself whether
  //  a dated concession is live today.
  router.get("/operator/pricing/concessions", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { governedConcessions } = require("../money/concessions_read");
      return res.json(await governedConcessions(pool, {
        property_id: req.operator.property_id,   // session only, never the query
        as_of: req.query.as_of || null,
      }));
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message, code: e.code || null }); }
  });

  // ── SLICE 8 — PUBLISH A GOVERNED PRICING VERSION ────────────────────
  //  publishVersion() has existed and been complete since 062; it simply had
  //  no route, which is why every property reads published_version: null and
  //  the governed sheet has never been the thing anyone quotes from.
  //
  //  Authority is NOT this route's business: publishVersion calls
  //  pricingAuthority and throws 403 without may_publish_pricing, refuses an
  //  unapproved or mismatched review receipt (409), and refuses self-review by
  //  a grant holder (403). The route adds session scope and nothing else.
  //
  //  dry_run defaults TRUE. A malformed or accidental POST rehearses against
  //  real constraints and triggers, then rolls back. Publishing requires
  //  saying dry_run:false out loud.
  router.post("/operator/pricing/publish", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { publishVersion } = require("../money/pricing_lifecycle");
      const b = req.body || {};
      const out = await publishVersion(pool, {
        property_id: req.operator.property_id,   // session only, never the body
        user_id: req.operator.id,                // session only, never the body
        draft_version_id: b.draft_version_id || null,
        proposal: b.proposal || {},
        review_receipt_id: b.review_receipt_id || null,
        dry_run: b.dry_run !== false,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message, code: e.code || null }); }
  });

  // Shadow comparison. Sends nothing, writes nothing.
  router.post("/operator/pricing/shadow-quote", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { shadowQuoteReport } = require("../money/shadow_quote_simulator");
      return res.json(await shadowQuoteReport(pool, { property_id: req.operator.property_id }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Future Rent Roll integration CONTRACT preview. Not wired into the roll.
  router.get("/operator/pricing/future-rent-roll-preview", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { futureRentRollPricingPreview } = require("../money/future_rent_roll_pricing_contract");
      return res.json(await futureRentRollPricingPreview(pool, {
        property_id: req.operator.property_id,
        horizon_date: req.query.horizon_date || null,
      }));
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/rent-roll/institutional?as_of=&format=json|csv
  //   The formal as-of schedule for ownership, lenders and reporting. Same
  //   canonical read as the operating page — reshaped, never recomputed —
  //   so the page, the print view and the CSV cannot disagree.
  //   MIGRATION ROUTE, retires with the rest of the migration surface.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/rent-roll/institutional", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await institutionalRentRoll(pool, {
        property_id: req.operator.property_id,   // session only
        as_of: req.query.as_of || null,
      });
      if (String(req.query.format || "").toLowerCase() === "csv") {
        const name = `rent-roll_${(out.report.property_name || "property").replace(/[^a-z0-9]+/gi, "-")}_${out.report.as_of}.csv`;
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="${name}"`);
        return res.send(institutionalCsv(out));
      }
      return res.json({ ...out, _migration_route: true });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/rent-roll/future-facts?as_of=YYYY-MM-DD
  //   MIGRATION ROUTE. The same canonical positions read at a selected
  //   future date, CONTRACTUAL FACTS ONLY. No pricing, no assumptions, no
  //   projected occupancy, no renewal rate. The Expected Future Rent Roll
  //   is a later calculation over these same rows, not a change to them.
  //   Retires with the rest of the migration surface.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/rent-roll/future-facts", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const out = await futureRentRollFacts(pool, {
        property_id: req.operator.property_id,   // session only
        as_of: req.query.as_of || null,
      });
      return res.json({ ...out, _migration_route: true });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/leasing/renewals — R1: THE LIVE RENEWAL-WORK COHORT.
  //
  // Which leases need renewal attention in the next 90 days? Session-scoped,
  // server-authored, read-only. The property is the SESSION's property — a
  // client-supplied property_id is never authority (§21) and is ignored here.
  //
  // Fixed 90-day horizon for conventional multifamily V1: no date controls,
  // deliberately. The horizon is a product decision, not a user input, until
  // student-housing cycle dates arrive.
  //
  // The cohort, its ordering, its notice state and its proof basis are all
  // computed in the service (src/leasing/renewals_read.js). This route only
  // authorizes and returns. Nothing here writes.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/leasing/renewals", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // Slice 6: the enriched cohort — the same successor-aware population,
      // now with server-authored stage, operating state, waiting party,
      // blocker, owner, due, economics view, primary action, and reconciled
      // home counts. Property scope is the session's, never req.query.
      const out = await renewalsCohortEnriched(pool, {
        property_id: req.operator.property_id,
        horizon_days: 90,
      });
      const asOf = (await pool.query("select current_date as d")).rows[0].d;
      return res.json({ ...out, as_of: asOf instanceof Date ? asOf.toISOString().slice(0, 10) : String(asOf) });
    } catch (e) {
      // An error is an ERROR, never an empty cohort. "Could not look" must
      // never render as "nothing needs attention" (§5).
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });

  router.get("/operator/leasing/follow-ups", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
      const limit = Math.min(Number(req.query.limit) || 100, 100);
      const asOf = (await pool.query("select now() as now")).rows[0].now;

      const rows = (await pool.query(
        `select lco.rung, lco.due_by, lco.owner_user_id, lco.owner_role,
                lco.conversion_id, lco.obligation_id,
                lc.person_id, lc.current_stage, lc.tour_outcome, lc.origin_tour_id,
                p.name as person_name,
                (lco.due_by <= now()) as is_due,
                greatest(0, floor(extract(epoch from (now() - lco.due_by)) / 3600))::int as overdue_hours
           from leasing_conversion_obligations lco
           join obligations o        on o.id = lco.obligation_id and o.status = 'open'
           join leasing_conversions lc on lc.id = lco.conversion_id
           left join persons p       on p.id = lc.person_id
          where lc.property_id = $1 and lc.status = 'active'
          order by (lco.due_by <= now()) desc, lco.due_by asc
          limit $2`,
        [propertyId, limit]
      )).rows;

      const due = rows.filter(r => r.is_due);
      const upcoming = rows.filter(r => !r.is_due);
      return res.json({
        property_id: propertyId, as_of: asOf,
        counts: { due: due.length, upcoming: upcoming.length },
        due, upcoming,
      });
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/leasing/person-card — THE PERSON × PROPERTY CARD READ.
  //
  // The card is a LENS, not a table: it assembles attributed entries from
  // the real systems of record (comm_events, tour_events/leasing_tours,
  // conversion obligations, person_attributes) into three bands —
  // RELATIONSHIP / NEXT / HISTORY — per the frozen entry contract
  // (ENTRY_CONTRACT.md). Nothing here writes; editing a rendered line is
  // impossible by construction because there is nothing to edit.
  //
  // Rules enforced here:
  //  · Person × Property, always — the session's property is the wall.
  //  · HISTORY sorts by occurred_at (when it happened), never write time.
  //  · Every entry is verb-first with a named actor; actual-host entries
  //    carry claim_strength='asserted' (identity bridge pending).
  //  · Honest blank: empty sources contribute nothing; dark sources
  //    (offer/application/lease) do not exist here at all.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/leasing/person-card", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = await pool.connect();
    try {
      const propertyId = req.operator.property_id;
      let personId = req.query.person_id || null;
      // accept lead_id and resolve — the tour drawer only knows the lead
      if (!personId && req.query.lead_id) {
        const l = (await client.query(
          `select person_id from leasing_leads where id=$1 and property_id=$2`,
          [req.query.lead_id, propertyId])).rows[0];
        personId = l ? l.person_id : null;
      }
      if (!personId) return res.status(400).json({ error: "person_id or lead_id required" });
      // the property wall: the person must actually have presence at THIS property
      const p = (await client.query(`select id, name from persons where id=$1`, [personId])).rows[0];
      if (!p) return res.status(404).json({ error: "person not found" });
      const presence = (await client.query(
        `select 1 where exists (select 1 from leasing_leads where person_id=$1 and property_id=$2)
             or exists (select 1 from conversations where person_id=$1 and property_id=$2)
             or exists (select 1 from person_attributes where person_id=$1 and property_id=$2)
             -- R3: a conversion IS presence — the card projects task events for
             -- conversion-driven people, so the wall must recognize them.
             or exists (select 1 from leasing_conversions where person_id=$1 and property_id=$2)
             -- A LEASE IS PRESENCE (owner ruling, 2026-07-25). The card is
             -- Person × Property, and a lease is the strongest possible
             -- statement that a person has a relationship with a property.
             -- Before this clause the wall tested leads/conversations/attrs/
             -- conversions but NEVER leases, so 621 of 623 active-lease
             -- residents got "person not found" — a bug that failed closed,
             -- not a privacy control.
             --   · Scoped to THIS property. Never portfolio-wide — that would
             --     collide with the locked cross-deal rule.
             --   · No lease_status filter, deliberately: 'active', 'pending'
             --     and 'commercial' all evidence presence here, and a future
             --     historical status must not silently drop a person off the
             --     card. (relationship_stage.js still refuses to LABEL
             --     former_resident — presence and stage are different jobs.)
             --   · A PRESENCE test, not an entitlement. Which projection a
             --     given viewer gets is a separate question and stays open.
             -- $1/$2 are cast explicitly: every other use here is uuid, so the
             -- inference stays uuid (see relationship_stage.js:52 for the
             -- 42883 trap when a bare $1 meets a cast $1).
             or exists (select 1 from leases
                         where property_id = $2::uuid
                           and tenant_ids is not null
                           and tenant_ids @> array[$1::uuid])`,
        [personId, propertyId])).rows[0];
      if (!presence) return res.status(404).json({ error: "person not found" }); // no presence here → the name does not leak across the wall

      const userName = async (uid) => {
        if (!uid) return null;
        const u = (await client.query(`select name from users where id=$1`, [uid])).rows[0];
        return u ? u.name : null;
      };
      const entries = [];

      // ── conversation → message entries ─────────────────────────────
      const conversation = (await client.query(
        `select c.id, c.status, ats.mode
           from conversations c
           left join agent_thread_state ats on ats.conversation_id=c.id
          where c.person_id=$1 and c.property_id=$2
          order by c.created_at desc limit 1`,
        [personId, propertyId])).rows[0] || null;
      const msgs = (await client.query(
        `select ce.id, ce.conversation_id, ce.direction, ce.sender_role, ce.body,
                ce.occurred_at, ce.provider_status, ce.sent_by_user_id,
                su.name as sent_by_name
           from comm_events ce
           left join users su on su.id=ce.sent_by_user_id
          where ce.person_id=$1 and ce.property_id=$2
          order by ce.occurred_at asc limit 200`,
        [personId, propertyId])).rows;
      for (const m of msgs) {
        const who = m.direction === "inbound"
          ? (p.name || "Prospect")
          : (m.sent_by_name || (m.sender_role === "ai" ? "AI leasing agent" : "Property team"));
        entries.push({
          occurred_at: m.occurred_at, recorded_at: m.occurred_at,
          source: "conversation", verb: "sent",
          actor: { id: m.sent_by_user_id || null, name: who, kind: m.direction === "inbound" ? "person" : "user" },
          summary: `${who} sent: ${String(m.body || "").slice(0, 140)}`,
          claim_strength: "proven",
          detail: { conversation_id: m.conversation_id, direction: m.direction, body: m.body, provider_status: m.provider_status || null },
          supersedes: null,
        });
      }

      // ── tours → scheduled / gave / no-show entries ─────────────────
      const tours = (await client.query(
        `select t.id, t.scheduled_for, t.status, t.created_at, t.leasing_agent_id,
                t.completed_at, t.no_show_at
           from leasing_tours t
           join leasing_leads l on l.id = t.lead_id
          where l.person_id=$1 and t.property_id=$2
          order by t.created_at asc limit 50`,
        [personId, propertyId])).rows;
      for (const t of tours) {
        const schedName = (await userName(t.leasing_agent_id)) || "the team";
        entries.push({
          occurred_at: t.created_at, recorded_at: t.created_at,
          source: "tour", verb: "scheduled",
          actor: { id: t.leasing_agent_id, name: schedName, kind: "user" },
          summary: `Tour scheduled with ${schedName}`,
          claim_strength: "proven",
          detail: { tour_id: t.id, scheduled_for: t.scheduled_for }, supersedes: null,
        });
        // completed/no-show truth from tour_events (occurred = when it happened,
        // recorded = when the event row was written)
        const evs = (await client.query(
          `select event_type, actor_id, event_at, metadata
             from tour_events where tour_id=$1 and event_type in ('completed','no_show','outcome_corrected')
             order by event_at asc`, [t.id])).rows;
        for (const ev of evs) {
          const md = ev.metadata || {};
          if (ev.event_type === "outcome_corrected") {
            const who = (await userName(md.corrected_by_user_id || ev.actor_id)) || "staff";
            const priorD = md.prior && md.prior.disposition ? md.prior.disposition : "the prior outcome";
            const revD = md.revised && md.revised.disposition ? md.revised.disposition : "a revised outcome";
            entries.push({
              occurred_at: ev.event_at, recorded_at: ev.event_at,
              source: "outcome", verb: "corrected",
              actor: { id: md.corrected_by_user_id || ev.actor_id, name: who, kind: "user" },
              summary: `${who} corrected the tour outcome: ${priorD} → ${revD}${md.reason ? ` (${md.reason})` : ""}`,
              claim_strength: "proven",
              detail: { corrects_event: md.corrects_event, reason: md.reason, prior: md.prior, revised: md.revised },
              supersedes: md.prior ? { value: (md.prior.disposition || null), source: "prior tour outcome" } : null,
            });
            continue;
          }
          if (ev.event_type === "completed") {
            const hostId = md.actual_tour_host_user_id || ev.actor_id || null;
            const hostName = (await userName(hostId)) || "staff";
            entries.push({
              occurred_at: t.scheduled_for || ev.event_at, recorded_at: ev.event_at,
              source: "tour", verb: "gave",
              actor: { id: hostId, name: hostName, kind: "user" },
              summary: `${hostName} gave the tour`,
              claim_strength: "asserted",           // identity bridge pending
              detail: { tour_id: t.id }, supersedes: null,
            });
            // the outcome capture itself — recorded by whoever wrote it
            if (md.outcome) {
              const recId = md.recorded_by_user_id || ev.actor_id || null;
              const recName = (await userName(recId)) || "staff";
              entries.push({
                occurred_at: ev.event_at, recorded_at: ev.event_at,
                source: "outcome", verb: "recorded",
                actor: { id: recId, name: recName, kind: "user" },
                summary: `${recName} recorded the outcome — ${md.outcome.disposition || ""}${md.outcome.sub_read ? " · " + md.outcome.sub_read : ""}`,
                claim_strength: "proven",
                detail: md.outcome, supersedes: null,
              });
            }
          } else {
            // #5: prefer the split axes; fall back to the legacy compound flavor
            const notified = md.notice_status === "notified" || md.attendance === "no_show_notified";
            entries.push({
              occurred_at: t.scheduled_for || ev.event_at, recorded_at: ev.event_at,
              source: "tour", verb: "no_show",
              actor: { id: ev.actor_id, name: (await userName(ev.actor_id)) || "staff", kind: "user" },
              summary: notified
                ? `Did not attend — gave notice${md.reason ? " (" + md.reason + ")" : ""}`
                : `Did not attend — no contact`,
              claim_strength: "proven",
              detail: { tour_id: t.id, attendance_status: md.attendance_status || "did_not_attend",
                        notice_status: notified ? "notified" : "none", reason: md.reason || null },
              supersedes: null,
            });
          }
        }
      }

      // ── obligations → owns / closed entries + the NEXT band ────────
      const obls = (await client.query(
        `select lco.rung, lco.due_by, lco.owner_user_id, lco.created_at as spawned_at,
                o.id as obligation_id, o.status, o.label, o.completed_at
           from leasing_conversion_obligations lco
           join obligations o on o.id = lco.obligation_id
           join leasing_conversions lc on lc.id = lco.conversion_id
          where lc.person_id=$1 and lc.property_id=$2
          order by lco.created_at asc limit 50`,
        [personId, propertyId])).rows;
      const next = [];
      // the scheduled host for THIS person's tours — used to explain WHY the
      // owner is who it is (actual host wasn't eligible → fell to scheduled).
      for (const ob of obls) {
        const ownerName = (await userName(ob.owner_user_id)) || "Unassigned";
        // owner basis: the follow-up owner is the ELIGIBLE assignment, which may
        // differ from who GAVE the tour (an asserted attribution). Explain it.
        const ownerBasis = ob.owner_user_id ? "eligible assignment" : "unassigned";
        entries.push({
          occurred_at: ob.spawned_at, recorded_at: ob.spawned_at,
          source: "obligation", verb: "owns",
          actor: { id: ob.owner_user_id, name: ownerName, kind: "user" },
          summary: ob.owner_user_id ? `${ownerName} owns: ${ob.label}` : `Unassigned: ${ob.label}`,
          claim_strength: "proven",
          detail: { obligation_id: ob.obligation_id, rung: ob.rung, due_by: ob.due_by, owner_basis: ownerBasis },
          supersedes: null,
        });
        if (ob.status === "open") {
          next.push({ obligation_id: ob.obligation_id, label: ob.label, rung: ob.rung,
                      owner: { id: ob.owner_user_id, name: ownerName, basis: ownerBasis }, due_by: ob.due_by });
        } else if (ob.completed_at) {
          entries.push({
            occurred_at: ob.completed_at, recorded_at: ob.completed_at,
            source: "obligation", verb: "closed",
            actor: { id: ob.owner_user_id, name: ownerName, kind: "user" },
            summary: `${ownerName} closed: ${ob.label}`,
            claim_strength: "proven",
            detail: { obligation_id: ob.obligation_id, rung: ob.rung }, supersedes: null,
          });
        }
      }
      next.sort((a, b) => new Date(a.due_by || "2099-01-01") - new Date(b.due_by || "2099-01-01"));

      // ── observations → confirmed/updated entries WITH supersede lineage
      const attrs = (await client.query(
        `select attr_key, attr_value, source, source_ref, status, created_at
           from person_attributes
          where person_id=$1 and property_id is not distinct from $2
          order by created_at asc`, [personId, propertyId])).rows;
      const lastByKey = {};
      for (const a of attrs) {
        const prior = lastByKey[a.attr_key] || null;
        entries.push({
          occurred_at: a.created_at, recorded_at: a.created_at,
          source: "observation", verb: prior ? "updated" : "confirmed",
          actor: { id: null, name: a.source === "human" ? "staff" : a.source, kind: a.source === "human" ? "user" : "system" },
          summary: prior
            ? `${a.attr_key} updated: ${prior.attr_value} → ${a.attr_value}`
            : `${a.attr_key} confirmed: ${a.attr_value}`,
          claim_strength: "proven",
          detail: { key: a.attr_key, value: a.attr_value, source: a.source },
          supersedes: prior ? { value: prior.attr_value, source: prior.source } : null,
        });
        lastByKey[a.attr_key] = a;
      }

      // ── the canonical chronology: occurred_at ASC, never write order ─
      // ── R3 (069): task recovery + handoff events → History entries.
      // The ledger is the immutable record for conversion-linked obligations;
      // the card PROJECTS it (never writes it). Pre-069 closures still render
      // from their closure columns above — no fabricated past.
      const hasLedger = (await client.query("select to_regclass('leasing_conversion_obligation_events') as t")).rows[0];
      if (hasLedger && hasLedger.t) {
        const taskEvents = (await client.query(
          `select e.event_type, e.occurred_at, e.reason,
                  e.resolution_code, e.resolution_basis, e.next_due_at,
                  au.name as actor_name, po.name as prior_owner_name, no_.name as next_owner_name,
                  o.label as task_label
             from leasing_conversion_obligation_events e
             join leasing_conversion_obligations lco on lco.id = e.conversion_obligation_id
             join obligations o on o.id = lco.obligation_id
             join leasing_conversions c on c.id = lco.conversion_id
             left join users au  on au.id = e.actor_user_id
             left join users po  on po.id = e.prior_owner_user_id
             left join users no_ on no_.id = e.next_owner_user_id
            where c.person_id = $1 and c.property_id = $2
              and e.event_type in ('reassigned','reopened','due_changed')
            order by e.occurred_at asc`, [personId, propertyId])).rows;
        for (const ev of taskEvents) {
          const who = ev.actor_name || "The system";
          let text = null;
          if (ev.event_type === "reassigned") {
            text = ev.prior_owner_name
              ? `${who} reassigned ${ev.task_label} — ${ev.prior_owner_name} → ${ev.next_owner_name || "Unassigned"}`
              : `${who} picked up ${ev.task_label}`;
          } else if (ev.event_type === "reopened") {
            text = `${who} reopened ${ev.task_label}` + (ev.next_owner_name ? ` — ${ev.next_owner_name} owns it` : " — Unassigned");
          } else if (ev.event_type === "due_changed") {
            text = `${who} changed the follow-up time — ${ev.task_label}`;
          }
          if (text) entries.push({
            kind: "task_event", occurred_at: ev.occurred_at, text,
            reason: ev.reason || null, next_due_at: ev.next_due_at || null,
          });
        }
      }

      entries.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

      const vitals = await prospectVitals(client, { personId, propertyId });

      // ── APPLICATION SUMMARY — the card's Application band (compact, honest). ──
      // The person's most-recent application at THIS property. The card is the
      // operating SUMMARY: status + the reviewable facts only. Sensitive fields
      // (SSN, ID/selfie/verification artifacts) are NEVER surfaced here — the
      // full application lives behind the View-full-application action. Read-only;
      // absent application = null (no band), never a guess. Fail-soft: if the
      // table/columns differ, the card still returns without the application.
      let application = null;
      let stage = "prospect";                     // default lifecycle read for a card
      try {
        const app = (await client.query(
          `select id, status, unit_label, unit_id, applicant_name, captured,
                  created_at, updated_at
             from lease_applications
            where person_id=$1 and property_id=$2
            order by created_at desc limit 1`,
          [personId, propertyId])).rows[0];
        if (app) {
          let cap = app.captured || {};
          if (typeof cap === "string") { try { cap = JSON.parse(cap); } catch (_) { cap = {}; } }
          // map the raw disposition to a clean, human status the card renders.
          const statusMap = {
            submitted: "Submitted", under_review: "In review", in_review: "In review",
            approved: "Approved", denied: "Declined", declined: "Declined", withdrawn: "Withdrawn",
          };
          application = {
            application_id: app.id,
            status: statusMap[app.status] || app.status || null,
            raw_status: app.status || null,
            unit_label: app.unit_label || null,
            submitted_at: app.created_at || null,
            // compact, reviewable facts only — pulled from captured, honest nulls
            intended_move_in: cap.desired_move_in || cap.move_in || null,
            occupants: cap.occupants != null ? cap.occupants : null,
            pets: cap.pets != null ? cap.pets : null,
            employer: cap.employer || null,
            job_title: cap.job_title || null,
            monthly_income: cap.monthly_income != null ? cap.monthly_income : null,
            // the detail action — the summary card never dumps the full application
            view_full_application: `/operator/leasing/application-review?application_id=${app.id}`,
          };
          // lifecycle read: an application at any live stage makes this an Applicant.
          // (A declined/withdrawn application still means they applied — the card
          //  shows the status; the badge reflects the relationship reaching applicant.)
          stage = "applicant";
          // the submission is also a durable event on the relationship timeline —
          // same shape as every other history entry, so History shows the moment
          // they became an applicant.
          entries.push({
            occurred_at: app.created_at, recorded_at: app.created_at,
            source: "application", verb: "submitted",
            actor: { id: null, name: app.applicant_name || (p.name || "Applicant"), kind: "person" },
            summary: `Application submitted${app.unit_label ? ` — Unit ${app.unit_label}` : ""}`,
            claim_strength: "proven",
            detail: { application_id: app.id, status: app.status || null, unit_label: app.unit_label || null },
            supersedes: null,
          });
          // keep History in occurred_at order now that the application entry is in.
          entries.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
        }
      } catch (_) { /* table/columns may differ — card degrades to no application band */ }

      // BL-3 item 4: the closed_not_fit lifecycle event is durable, attributed
      // relationship truth — it belongs in History like every other domain
      // event, keyed to the SAME source table the queue/detail derive from
      // (one truth, three readers). Included whenever ANY conversation for
      // this person+property was closed, even if not the one currently open.
      try {
        const closures = (await client.query(
          `select e.conversation_id, e.reason_code, e.reason_note, e.actor_id,
                  e.occurred_at, e.recorded_at, cu.name as actor_name
             from leasing_lead_lifecycle_events e
             join conversations c on c.id = e.conversation_id
             left join users cu on cu.id = e.actor_id
            where c.person_id=$1 and c.property_id=$2 and e.event_type='closed_not_fit'
            order by e.occurred_at asc`,
          [personId, propertyId]
        )).rows;
        for (const cl of closures) {
          const who = cl.actor_name || "Staff";
          const readableReason = String(cl.reason_code || "").replace(/_/g, " ");
          entries.push({
            occurred_at: cl.occurred_at, recorded_at: cl.recorded_at,
            source: "conversation", verb: "closed_not_fit",
            actor: { id: cl.actor_id || null, name: who, kind: "user" },
            summary: `${who} closed the conversation — not a fit${readableReason ? ` (${readableReason})` : ""}`,
            claim_strength: "proven",
            detail: { conversation_id: cl.conversation_id, reason_code: cl.reason_code || null, reason_note: cl.reason_note || null },
            supersedes: null,
          });
        }
        if (closures.length) entries.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
      } catch (_) { /* table/columns may differ — card degrades to History without closure entries, never a crash */ }

      const recent = msgs.slice(-8).map((m) => ({
        direction: m.direction, body: m.body, at: m.occurred_at,
        who: m.direction === "inbound" ? (p.name || "Prospect") : (m.sender_role || "Property"),
      }));

      // ── STAGE — the ONE resolver (shared/relationship_stage.js) ──────
      // Derived from evidence, never stored. The card used to answer only
      // 'prospect' | 'applicant', so a person holding a lease at THIS
      // property read as an applicant. The resolver adds the two lease
      // rungs (future_resident, pending → resident, active). It does NOT
      // invent former_resident: no ended lease state exists to derive it.
      // Fail-soft: if the resolver errors, the card keeps the inline
      // application-derived value rather than 500ing.
      let stage_basis = null;
      try {
        const { resolveRelationshipStage } = require("../shared/relationship_stage");
        const rs = await resolveRelationshipStage(client, { personId, propertyId });
        if (rs && rs.stage) { stage = rs.stage; stage_basis = rs.basis; }
      } catch (_) { /* keep the inline stage — honest, just less specific */ }

      return res.json({
        person: { id: p.id, name: p.name },
        property_id: propertyId,
        conversation_id: conversation ? conversation.id : null,
        conversation: conversation ? { id: conversation.id, status: conversation.status, mode: conversation.mode || "ai_active" } : null,
        stage,                                 // 'prospect' | 'applicant' | 'future_resident' | 'resident'
        stage_basis,                           // the evidence behind it, or null
        relationship: { vitals, recent_messages: recent, conversation_id: conversation ? conversation.id : null },
        application,                           // compact Application band, or null (honestly not applied yet)
        next,                                  // empty array = honestly nothing pending
        history: entries,                      // occurred_at ASC; empty = honestly nothing yet
      });
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
    finally { client.release(); }
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /operator/property/eligible-staff — the active-eligible roster for
  // the follow-up-owner selector (#1). Only users who resolve to an active
  // assignment at THIS property (the same eligibility the obligation owner
  // gate uses). This is what the capture's "Change owner" selector reads —
  // never an arbitrary id. Requires the users↔persons bridge to return rows;
  // returns an honest empty list until then, which the UI states plainly.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/property/eligible-staff", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
      // 067: the roster reads through the CANONICAL resolver — only
      // classified human staff on active-eligible accounts, deliberately
      // bridged, unconflicted, with an active assignment HERE. No raw
      // users.person_id join lives in this module anymore.
      const client = await pool.connect();
      let rows;
      try { rows = await staffIdentity.listEligibleStaff(client, propertyId); }
      finally { client.release(); }
      return res.json({ property_id: propertyId, eligible_staff: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  THE LEASING TASK QUEUE — the visible home for every conversion-linked
  //  obligation (067 follow-on). tour_followup anchors appear TODAY; the
  //  moment Loop-B sibling generation is re-enabled, leasing_task siblings
  //  land in this SAME queue with owner, due state, source tour, and a
  //  completion path — the five-point visibility bar the suppression gates
  //  on. Items leave ONLY through the write-once resolve below; nothing
  //  silently disappears. UNASSIGNED renders honestly, never hidden.
  // ════════════════════════════════════════════════════════════════════
  // ── THE LEASING-MODULE ACCESS PLANE (reviewer ruling §3) ─────────────
  // Two planes, never merged:
  //   property_team_assignments (user-keyed)  → may this user READ/OPERATE the
  //     leasing queue at this property? (allowed_modules is the gate)
  //   users.person_id + assignments (person-keyed) → durable identity and
  //     AUTOMATIC ownership eligibility (the canonical resolver only)
  // Team access never makes someone an owner; the bridge never grants access.
  async function requireLeasingModuleAccess(req, res, next) {
    // BRICK ONE: req.operator.allowed_modules is LIVE from the shared
    // resolver (re-read this request)  no second assignment query.
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("leasing")) return res.status(403).json({
      error: "leasing-module access required at this property (property_team_assignments.allowed_modules)." });
    return next();
  }

  // ── TOUR FOLLOW-UPS AND LEASING TASKS — the queue read (contract §6) ──
  // Deterministic order: overdue → due today → upcoming → no due date, then
  // due_at, created_at, id (stable tie-break). Bounded: limit ≤ 200, keyset
  // cursor. A null owner, null due date, or sibling type NEVER hides a row.
  // ── resolvePropertyOperatingTimeZone ─────────────────────────────────
  //  Resolved through the ONE shared resolver (property_timezone.js) — the SAME
  //  truth leasingleads.js uses for agent tour-offer local times. An
  //  UNCONFIGURED property gets an honest null (never an invented day).
  const { loadPropertyOperatingTimeZone } = require("../shared/property_timezone");
  // The board's DAY CONTRACT — offsets, clamping, and the SQL fragments that
  // enforce them. Shared with tours_conveyor.test.js so the harness exercises
  // the real predicate rather than a re-typed copy. (tour_window.js)
  const TW = require("../shared/tour_window");
  // ONE evaluator per governed action, shared by the write route and the
  // read projection so a rendered action and an enforced action cannot
  // disagree. (capability.js)
  const capability = require("./capability");

  // ══════════════════════════════════════════════════════════════════
  //  LIVE TOUR SURFACE (session door) — the reads/writes that let the
  //  operator app complete a tour on the session's property through the
  //  ONE canonical completion service (leasingleads.js completeTourService).
  //  Same two-plane authz as the task queue: session + leasing module.
  // ══════════════════════════════════════════════════════════════════

  // Today's tours at the session's property — mirrors the operator-key
  // read (/properties/:id/leasing/tours/today) with the property SERVER-
  // DERIVED from the staff session, never from the client.
  router.get("/operator/leasing/tours/today", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // "Today" is the PROPERTY'S OPERATIONAL DAY — resolved, never assumed.
      const PROPERTY_TZ = await loadPropertyOperatingTimeZone(pool, req.operator.property_id);
      // ── DAY WINDOW (the conveyor) ───────────────────────────────────
      // The board reads a RANGE of operating days, not just forward from
      // today. Offsets are relative to the property's today, resolved
      // server-side; the caller never supplies a date, because what
      // "today" means here is property truth, not browser truth.
      //
      //   (nothing)        → today only          — every existing caller
      //   ?days=6          → today .. today+6    — legacy, unchanged
      //   ?from=-1&to=0    → yesterday .. today
      //   ?from=-7&to=-1   → last week, no today
      //
      // A reversed or over-wide window FAILS rather than being quietly
      // reinterpreted: returning days the caller did not ask for is the
      // same lie as returning a fixture.
      const WIN = TW.resolveTourWindow(req.query);
      if (WIN.error) {
        return res.status(400).json({ error: WIN.error.code, receipt: WIN.error.receipt });
      }
      const FROM_OFFSET = WIN.fromOffset;
      const TO_OFFSET = WIN.toOffset;
      const INCLUDE_TERMINAL = WIN.includeTerminal;
      const WINDOW_DAYS = TO_OFFSET;   // legacy echo, preserved for existing readers
      if (!PROPERTY_TZ) {
        return res.status(422).json({
          error: "PROPERTY_TIMEZONE_UNCONFIGURED",
          receipt: "This property has no configured operating timezone, so 'today' cannot be computed honestly. Configure it before using the live tour board here.",
        });
      }
      // ACTIVE tours only — the capture-candidate set. Completed / no-show /
      // cancelled / rescheduled tours are terminal: they leave this list the
      // moment their outcome is recorded (the same status set the queue
      // projection's live_tour CTE treats as live).
      //
      // ── TOURS-BOARD ROUTING (diff #3) ─────────────────────────────────
      // The board is not a flat list. Every tour carries SERVER-AUTHORED
      // routing facts derived once here — the app renders them and never
      // re-derives precedence (the same discipline the Control Board holds):
      //   phase              past | future | unknown   (TIME is the spine;
      //                        past outranks placement; NULL end -> unknown,
      //                        NEVER "overdue" — the building admits it does
      //                        not know when a tour ended)
      //   primary_bucket     outcomes_needing_capture | tours_needing_owner |
      //                        answer_before_tour | ready
      //                        (phase-first, then owner-first WITHIN future)
      //   primary_action_key capture_outcome | open_tour | reply
      //                        (assign_host is NOT a canonical write yet, so
      //                        tours_needing_owner HONESTLY degrades to
      //                        open_tour — never a phantom action; Rule 9)
      //   open_issues[]      every unresolved decision on the tour, NONE
      //                        erased just because another placed the card
      //   scheduled_end_at   the honest end time (tour_availability.ends_at
      //                        via slot_id); NULL -> phase can only be unknown
      // The D-7 signal (booked tour + a new unanswered inbound the manager
      // must answer BEFORE the tour) is read from the SAME PROJECTION_CTE the
      // conversation board uses — one server-authored derivation of waiting_on,
      // no second copy of the precedence. The Control Board removed this case
      // when booked_tour left its universe; Tours is now its home.
      const GRACE_MINUTES = 15; // Class-2 adapter: replace with property-level
                                // capture-grace config before multi-market.
      const r = await pool.query(
        PROJECTION_CTE + `,
        proj as ( select conversation_id, commercial_state, waiting_on from projected ),
        tours as (
          select t.*, p.name as prospect_name, p.phone as prospect_phone,
                 l.person_id, c.id as conversation_id,
                 u.name as scheduled_host_name,
                 av.ends_at as scheduled_end_at,
                 (u.id is null) as host_unassigned,
                 -- the day this tour belongs to, decided in the PROPERTY'S tz.
                 -- A 8pm Eastern tour is 00:00 UTC the next day; deciding day
                 -- membership in UTC puts it on the wrong page of the board.
                 ${TW.operatingDateExpr("$2")} as operating_date,
                 -- outcome recorded → the tour has left the capture set, but it
                 -- is still what happened that day.
                 ${TW.isTerminalExpr()} as is_terminal,
                 (proj.commercial_state='booked_tour' and proj.waiting_on='manager')
                   as booked_inbound_waiting_on_manager,
                 -- past = ended + grace < now, computed in the PROPERTY'S TZ.
                 -- NULL end time -> NULL (phase 'unknown'); never fabricates overdue.
                 case when av.ends_at is null then null
                      else (av.ends_at + ($3 || ' minutes')::interval)
                             < (now() at time zone $2) at time zone $2 end as is_past
            from leasing_tours t
            join leasing_leads l on l.id = t.lead_id
            join persons p on p.id = l.person_id
            left join conversations c
                   on c.property_id = l.property_id and c.person_id = l.person_id
            left join users u on u.id = t.leasing_agent_id
            left join tour_availability av on av.id = t.slot_id
            left join proj on proj.conversation_id = c.id
           where t.property_id=$1
             -- Ranged day window in the PROPERTY's operating timezone.
             -- Parameterised rather than forked into a second endpoint: two
             -- tour reads would drift, and the board must have one meaning.
             and ${TW.windowPredicate("$2", "$4", "$5")}
             and ${TW.statusPredicate("$6")}
        ),
        routed as (
          select *,
            case when is_past is null then 'unknown'
                 when is_past then 'past' else 'future' end as phase,
            -- a settled tour has no OPEN issue: its outcome is recorded, so
            -- neither a missing host nor a past end time is still actionable.
            case when is_terminal then array[]::text[]
                 else array_remove(array[
                   case when host_unassigned then 'host_unassigned' end,
                   case when booked_inbound_waiting_on_manager then 'booked_inbound_waiting_on_manager' end,
                   case when is_past is true then 'outcome_overdue' end
                 ], null) end as open_issues
          from tours
        ),
        final as (
          select *,
            case
              when is_terminal then 'settled'
              when phase='past' then 'outcomes_needing_capture'
              when host_unassigned then 'tours_needing_owner'
              when booked_inbound_waiting_on_manager then 'answer_before_tour'
              else 'ready' end as primary_bucket
          from routed
        )
        select *,
          case primary_bucket
            when 'outcomes_needing_capture' then 'capture_outcome'
            when 'answer_before_tour'       then 'reply'
            else 'open_tour' end as primary_action_key
        from final
        order by scheduled_for`,
        [req.operator.property_id, PROPERTY_TZ, GRACE_MINUTES, FROM_OFFSET, TO_OFFSET, INCLUDE_TERMINAL]);

      // ── CAPTURE STATE (v3) — what each tour actually owes ─────────────
      //  THE DEFECT THIS CLOSES: a tour with phase 'unknown' (no slot, so no
      //  honest end time) currently falls through every branch of the board's
      //  issue logic and renders CALM — indistinguishable from a tour that is
      //  genuinely fine. The server was already honest; the screen quietly
      //  turned "I cannot tell" into "nothing needed". On this property that
      //  is 9 of 17 tours.
      //
      //  Derived by the ONE resolver in tour_outcome.js, so the board and the
      //  end-of-day sweep cannot drift into two opinions about the same tour.
      //  Additive: existing fields are untouched, so no current reader changes
      //  behaviour. The board renders this once it reads the new field.
      const _TOUT = require("../leasing/tour_outcome");
      for (const row of r.rows) {
        const cs = _TOUT.resolveCaptureState({
          isTerminal:   !!row.is_terminal,
          // attendance/standing are not projected onto this read yet; the
          // terminal flag already covers "outcome recorded". Passing them as
          // null keeps this honest rather than guessing a half-state.
          attendance:   null,
          standing:     null,
          // already selected by the tours CTE as av.ends_at -> scheduled_end_at.
          // NULL means no slot, which is exactly the untrackable case.
          tourEndedAt:  row.scheduled_end_at || null,
          // A WALK-IN HAS NO SLOT AND THAT IS NOT A DEFECT. Its arrival is
          // recorded on the tour itself, and that is as honest an end time
          // as a slot's. Without these two the board called a walk-in
          // "No time on record" seconds after someone recorded its time —
          // caught by running the flow live, not by the harness, because
          // the harness proved the resolver while the READ never fed it.
          occurredAt:   row.checked_in_at || row.completed_at || null,
          origin:       row.origin || null,
          graceMinutes: GRACE_MINUTES,
        });
        row.capture_state       = cs.state;
        row.capture_state_label = cs.label;
        row.capture_is_work     = cs.is_work;
        row.capture_state_reason = cs.reason;
        // surfaced as an issue so a board that reads open_issues can pick it
        // up without a second rule. Unknown strings are ignored by the
        // current renderer, so this changes nothing until it is adopted.
        if (cs.state === _TOUT.CAPTURE_STATE.UNTRACKABLE && Array.isArray(row.open_issues)) {
          row.open_issues = row.open_issues.concat(["capture_untrackable"]);
        }
      }

      // The window's real dates, resolved by the DATABASE in the property's
      // timezone — never recomputed in Node, where a second date library
      // would be a second opinion about what day it is.
      const w = (await pool.query(
        `select (now() at time zone $1)::date + ($2)::int as from_date,
                (now() at time zone $1)::date + ($3)::int as to_date,
                (now() at time zone $1)::date            as today_date`,
        [PROPERTY_TZ, FROM_OFFSET, TO_OFFSET])).rows[0];
      const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

      // EVERY day in the window, including the empty ones. A day with no
      // tours is a real answer ("nothing was scheduled") and the board must
      // be able to land on it; omitting it makes an empty day look broken.
      const byDate = new Map();
      for (const row of r.rows) {
        const k = iso(row.operating_date);
        byDate.set(k, (byDate.get(k) || 0) + 1);
      }
      const days = [];
      for (let o = FROM_OFFSET; o <= TO_OFFSET; o++) {
        const d = new Date(`${iso(w.today_date)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + o);
        const k = d.toISOString().slice(0, 10);
        days.push({ offset: o, date: k, is_today: o === 0, tour_count: byDate.get(k) || 0 });
      }

      const settled = r.rows.filter((x) => x.is_terminal).length;
      const _span = TO_OFFSET - FROM_OFFSET + 1;
      const _dayLabel = (FROM_OFFSET === 0 && TO_OFFSET === 0) ? "today"
        : (FROM_OFFSET === 0) ? `over the next ${_span} days`
        : (TO_OFFSET === 0) ? `over the last ${_span} days`
        : `across ${_span} days`;

      return res.json({
        receipt: `${r.rows.length} tour(s) on the board ${_dayLabel}.`
          + (INCLUDE_TERMINAL && settled ? ` ${settled} already settled.` : ""),
        property_id: req.operator.property_id,
        timezone: PROPERTY_TZ,
        window: {
          from_offset: FROM_OFFSET, to_offset: TO_OFFSET,
          from_date: iso(w.from_date), to_date: iso(w.to_date), today_date: iso(w.today_date),
          include_terminal: INCLUDE_TERMINAL, mode: WIN.mode, days,
        },
        window_days: WINDOW_DAYS,     // legacy field, unchanged for existing readers
        settled_count: settled,
        tours: r.rows });
    } catch (e) { console.error("operator tours today:", e); return res.status(500).json({ receipt: "Could not load today's tours.", error: e.message }); }
  });

  // Session-authed tour completion. The SAME transaction the operator-key
  // door runs (no fork): leasingleads.js completeTourService, with
  //   • the RECORDER server-derived from the staff session (req.operator.id)
  //     — a body actor_id can never override it on this door, and
  //   • the property wall enforced from the session scope: the tour must
  //     belong to the session's property (checked inside the service).
  router.post("/operator/leasing/tours/:tourId/complete", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!leasingTourService || typeof leasingTourService.completeTour !== "function") {
      return res.status(503).json({ receipt: "Tour completion is not wired on this deploy (leasingTourService missing)." });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await leasingTourService.completeTour(client, {
        tourId: req.params.tourId,
        b: req.body || {},
        recordedByUserId: req.operator.id,            // SERVER-DERIVED — never the body
        enforcePropertyId: req.operator.property_id,  // the session's wall
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.svc) return res.status(e.http).json(e.body);
      if (e.http === 422 || e.httpStatus === 422) return res.status(422).json({ receipt: e.message });
      console.error("operator tour complete:", e);
      return res.status(500).json({ receipt: "Could not complete the tour.", error: e.message });
    } finally { client.release(); }
  });

  // ══════════════════════════════════════════════════════════════════
  //  POST /operator/leasing/walk-in-tour — capture a tour that was never
  //  scheduled.
  //
  //  Somebody is in the neighbourhood, walks in, gets toured. That is a
  //  real tour and until now it could not be recorded at all: the only
  //  capture door needs a tour row that already exists, and a walk-in has
  //  none. The Person Card is where an agent is already standing when
  //  this happens, so this is reachable from a person, not from a board.
  //
  //  IT CREATES ITS OWN TOUR ROW. The shortcut — capture the walk-in
  //  against whatever tour the person already has booked — would falsify
  //  WHEN it happened, claiming it occurred at tomorrow's slot time.
  //  "The tour we planned" and "the tour that happened" are two facts.
  //
  //  IT NEVER CANCELS THE SCHEDULED ONE. If a future tour exists it is
  //  RETURNED so the agent can decide, and left completely untouched.
  //  Both outcomes are real: they came early instead, or they saw the
  //  lobby today and still want the unit tour tomorrow. Only the human
  //  who was there knows which, so the system does not guess.
  //
  //  CAPTURE IS THE SAME CANONICAL SERVICE. It calls completeTour — the
  //  identical transaction the board's capture uses. No second outcome
  //  path, no fork; the walk-in differs only in that the tour row is
  //  created first, in the same transaction.
  // ══════════════════════════════════════════════════════════════════
  router.post("/operator/leasing/walk-in-tour", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!leasingTourService || typeof leasingTourService.completeTour !== "function") {
      return res.status(503).json({ receipt: "Tour completion is not wired on this deploy (leasingTourService missing)." });
    }
    const b = req.body || {};
    const propertyId = req.operator.property_id;          // SERVER-DERIVED
    const client = await pool.connect();
    try {
      await client.query("begin");

      // ── the person, and their lead AT THIS PROPERTY ──────────────────
      //  A tour hangs off a lead. The property wall is the session's, never
      //  the body's.
      let leadId = b.lead_id || null;
      if (!leadId) {
        if (!b.person_id) {
          await client.query("rollback");
          return res.status(400).json({ receipt: "person_id or lead_id is required." });
        }
        const lead = (await client.query(
          `select id from leasing_leads
            where person_id=$1 and property_id=$2
            order by created_at desc limit 1`, [b.person_id, propertyId])).rows[0];
        if (!lead) {
          await client.query("rollback");
          return res.status(409).json({
            receipt: "That person has no lead at this property yet — intake them through the canonical path first." });
        }
        leadId = lead.id;
      }
      const lead = (await client.query(
        `select * from leasing_leads where id=$1 and property_id=$2`, [leadId, propertyId])).rows[0];
      if (!lead) {
        await client.query("rollback");
        return res.status(404).json({ receipt: "No lead with that id at this property." });
      }

      // ── the time it ACTUALLY happened ────────────────────────────────
      //  Defaults to now, because the normal case is capturing it while the
      //  person is still in the lobby. An explicit time is accepted (an
      //  agent catching up an hour later) but never invented beyond now.
      const occurredAt = b.occurred_at ? new Date(b.occurred_at) : new Date();
      if (isNaN(occurredAt.getTime())) {
        await client.query("rollback");
        return res.status(400).json({ receipt: "occurred_at is not a readable time." });
      }
      if (occurredAt.getTime() > Date.now() + 60000) {
        await client.query("rollback");
        return res.status(400).json({ receipt: "A walk-in cannot have happened in the future." });
      }

      // ══════════════════════════════════════════════════════════════
      //  IDEMPOTENCY — two guards, because one of them was not enough.
      //
      //  Five walk-in rows were created on 2026-07-26 by repeated clicks.
      //  A disabled button is UX, not a safeguard: double-clicks, retries,
      //  latency and network replay all still arrive here.
      //
      //  GUARD 1 — the caller's key. Same mechanism the slot-booking path
      //  already uses (mig 079): pre-check, with the unique partial index
      //  on booking_idempotency_key as the race backstop. A replay returns
      //  the ORIGINAL row and a 200, not a duplicate and not an error.
      //
      //  GUARD 2 — the canonical duplicate guard, which is what would
      //  actually have stopped those five. The client that made them sent
      //  no key at all, so a key-only scheme protects nothing when the
      //  caller forgets. The real-world rule: a person cannot have two
      //  UNCAPTURED walk-ins at one property. If one is already open,
      //  clicking again returns it. A second genuine walk-in only makes
      //  sense once the first has an outcome.
      // ══════════════════════════════════════════════════════════════
      const idemKey = (typeof b.idempotency_key === "string" && b.idempotency_key.trim())
        ? b.idempotency_key.trim().slice(0, 200) : null;

      if (idemKey) {
        const prior = (await client.query(
          `select * from leasing_tours where booking_idempotency_key=$1 limit 1`, [idemKey])).rows[0];
        if (prior) {
          await client.query("rollback");
          return res.json({
            walk_in_tour_id: prior.id, tour_id: prior.id, person_id: lead.person_id,
            captured: !!prior.completed_at, replayed: true,
            occurred_at: prior.checked_in_at,
            scheduled_tours_still_open: [],
            receipt: "Already recorded — returning the walk-in from the first request.",
          });
        }
      }

      const openWalkIn = (await client.query(
        `select * from leasing_tours
          where lead_id=$1 and property_id=$2 and origin='walk_in'
            and completed_at is null
            and status not in ('completed','no_show','cancelled','rescheduled')
          order by checked_in_at desc limit 1`, [leadId, propertyId])).rows[0];
      if (openWalkIn) {
        await client.query("rollback");
        return res.json({
          walk_in_tour_id: openWalkIn.id, tour_id: openWalkIn.id, person_id: lead.person_id,
          captured: false, deduped: true,
          occurred_at: openWalkIn.checked_in_at,
          scheduled_tours_still_open: [],
          receipt: "This walk-in is already recorded and still needs its outcome.",
        });
      }

      // ── the scheduled tour we are NOT touching ───────────────────────
      const conflicting = (await client.query(
        `select t.id, t.scheduled_for, t.status
           from leasing_tours t
          where t.lead_id = $1
            and t.status not in ('completed','no_show','cancelled','rescheduled')
            and coalesce(t.scheduled_for, t.requested_for) > now()
          order by coalesce(t.scheduled_for, t.requested_for) asc`, [leadId])).rows;

      // ── the walk-in's own row ────────────────────────────────────────
      //  origin='walk_in' (097) is what tells the board this tour has no
      //  slot BY NATURE, not because the booking path was bypassed.
      //  checked_in_at is the honest arrival: they physically showed.
      const tour = (await client.query(
        `insert into leasing_tours
           (lead_id, property_id, unit_id, leasing_agent_id, scheduled_for,
            checked_in_at, status, origin, booking_idempotency_key)
         values ($1,$2,$3,$4,$5,$5,'scheduled','walk_in',$6) returning *`,
        [leadId, propertyId, b.unit_id || lead.unit_id || null,
         req.operator.id, occurredAt.toISOString(), idemKey])).rows[0];

      // ── the outcome is OPTIONAL here, on purpose ─────────────────────
      //  Two callers, one capture path:
      //
      //  · The Person Card taps "They toured just now" with no outcome. It
      //    gets a tour row back and opens the SAME capture sheet every other
      //    tour uses. Creating a half-finished tour is not a compromise —
      //    "toured, judgment still owed" is an explicitly valid state, and
      //    it is exactly what a walk-in is in the seconds after it happens.
      //
      //  · An API caller that already has the outcome sends it and gets both
      //    in one transaction.
      //
      //  Capturing here unconditionally would mark the tour terminal, and the
      //  capture sheet would then refuse it as already recorded — forcing a
      //  SECOND outcome path for walk-ins. One capture path is worth more
      //  than one round trip.
      const wantsCapture = !!(b.disposition || b.standing || b.interest_level
                              || b.tour_given !== undefined || b.feedback);
      let out = null;
      if (wantsCapture) {
        out = await leasingTourService.completeTour(client, {
          tourId: tour.id,
          b,
          recordedByUserId: req.operator.id,            // SERVER-DERIVED
          enforcePropertyId: propertyId,
        });
      }

      await client.query("commit");
      const heads = conflicting.length
        ? ` Heads up: this person still has ${conflicting.length} scheduled tour(s) on the books. Nothing was cancelled — decide whether they still stand.`
        : "";
      return res.json({
        ...(out || {}),
        walk_in_tour_id: tour.id,
        tour_id: tour.id,                 // what the capture sheet expects
        person_id: lead.person_id,
        captured: !!out,
        occurred_at: occurredAt.toISOString(),
        // Surfaced, NOT acted on. The agent decides whether the booked tour
        // still stands; nothing here cancels it.
        scheduled_tours_still_open: conflicting,
        receipt: (out && out.receipt ? out.receipt : "Walk-in recorded — now capture how it went.") + heads,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.svc) return res.status(e.http).json(e.body);
      if (e.http === 422 || e.httpStatus === 422) return res.status(422).json({ receipt: e.message });
      console.error("operator walk-in tour:", e);
      return res.status(500).json({ receipt: "Could not record the walk-in.", error: e.message });
    } finally { client.release(); }
  });

  router.get("/operator/leasing/task-queue", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      let cursorClause = "", params = [propertyId, limit];
      if (req.query.cursor) {
        try {
          const c = JSON.parse(Buffer.from(String(req.query.cursor), "base64url").toString("utf8"));
          params.push(c.b, c.d, c.c, c.id);
          cursorClause = `and (bucket, coalesce(due_at,'infinity'::timestamptz), created_at, obligation_id)
                            > ($3::int, coalesce($4::timestamptz,'infinity'::timestamptz), $5::timestamptz, $6::uuid)`;
        } catch (_) { return res.status(400).json({ error: "bad cursor." }); }
      }
      const rows = (await pool.query(
        `with q as (
           select o.id as obligation_id, lco.conversion_id, c.property_id,
                  p.id as person_id, p.name as person_name,
                  c.origin_tour_id, lco.rung,
                  tu.unit_id, un.unit_number,
                  subst.applicant_substatus,
                  case when lco.rung = 'leasing_task' then 'sibling' else 'anchor' end as anchor_or_sibling,
                  o.status, o.label, o.due_at, o.created_at,
                  o.due_at::text as due_at_cur, o.created_at::text as created_at_cur,
                  lco.owner_user_id, ou.name as owner_name,
                  lco.next_move_code,
                  case when o.due_at is null then 'none'
                       when o.due_at < now() then 'overdue'
                       when o.due_at < date_trunc('day', now()) + interval '1 day' then 'today'
                       else 'upcoming' end as due_state,
                  case when o.due_at is null then 3
                       when o.due_at < now() then 0
                       when o.due_at < date_trunc('day', now()) + interval '1 day' then 1
                       else 2 end as bucket
             from leasing_conversion_obligations lco
             join obligations o         on o.id = lco.obligation_id
             join leasing_conversions c on c.id = lco.conversion_id
             join persons p             on p.id = c.person_id
             left join users ou         on ou.id = lco.owner_user_id
             -- the tour's unit, when the opportunity has one (for Send application)
             left join lateral (
               select t.unit_id from leasing_tours t
                where t.id = c.origin_tour_id limit 1
             ) tu on true
             left join units un on un.id = tu.unit_id
             -- APPLICANT SUB-STATUS (Slice 2): event-backed only, minimal set.
             -- Application truth wins over invitation truth; honest null else.
             -- CANONICAL (Slice 9 read authority). This CASE ladder previously
             -- lived here AND byte-identically in leasing_desk_loader.js, and
             -- both answered a HISTORY question from a current status label:
             -- an application approved and later withdrawn reported 'declined'.
             left join lateral (${lifecycleRead.SQL_APPLICANT_SUBSTATUS}
             ) subst on true
            where c.property_id = $1 and lco.outcome is null
         )
         select q.*, t.total_open, t.total_overdue, t.total_due_today,
                t.total_unassigned, t.total_anchors, t.total_siblings
           from q
          cross join (
            select count(*) as total_open,
                   count(*) filter (where due_state='overdue')         as total_overdue,
                   count(*) filter (where due_state='today')           as total_due_today,
                   count(*) filter (where owner_user_id is null)       as total_unassigned,
                   count(*) filter (where anchor_or_sibling='anchor')  as total_anchors,
                   count(*) filter (where anchor_or_sibling='sibling') as total_siblings
              from q
          ) t
          where true ${cursorClause}
          order by bucket, coalesce(due_at,'infinity'::timestamptz), created_at, obligation_id
          limit $2`,
        params)).rows;
      // owner_basis through the ONE canonical resolver — never a forked raw
      // join (the static gate enforces this). One resolver read per DISTINCT
      // owner on the page.
      const ownerIds = [...new Set(rows.map((r) => r.owner_user_id).filter(Boolean))];
      const basisByOwner = {};
      for (const uid of ownerIds) {
        try {
          const idn = await staffIdentity.resolveStaffIdentity(pool, { user_id: uid, property_id: propertyId });
          basisByOwner[uid] = idn.state === "resolved" ? "eligible_assignment" : "eligibility_lapsed";
        } catch (_) { basisByOwner[uid] = "eligibility_lapsed"; }
      }
      const NEXT_MOVE_LABELS = {
        send_application: "Send the application", send_floor_plans: "Send floor plans",
        schedule_second_tour: "Schedule a second tour", send_follow_up: "Send a follow-up",
        call_prospect: "Call the prospect",
      };
      const items = rows.map((r) => ({
        obligation_id: r.obligation_id, conversion_id: r.conversion_id, property_id: r.property_id,
        person_id: r.person_id, person_name: r.person_name,
        origin_tour_id: r.origin_tour_id, rung: r.rung, anchor_or_sibling: r.anchor_or_sibling,
        unit_id: r.unit_id || null, unit_number: r.unit_number || null,
        applicant_substatus: r.applicant_substatus || null,
        status: r.status, label: r.label,
        owner_user_id: r.owner_user_id, owner_name: r.owner_name,
        owner_basis: r.owner_user_id ? basisByOwner[r.owner_user_id] : "unassigned",
        due_at: r.due_at, due_state: r.due_state,
        next_move_code: r.next_move_code,
        next_move_label: r.next_move_code ? (NEXT_MOVE_LABELS[r.next_move_code] || r.next_move_code.replace(/_/g, " ")) : null,
        created_at: r.created_at,
      }));
      const t = rows[0] || {};
      const counts = {
        open: Number(t.total_open || 0), overdue: Number(t.total_overdue || 0),
        due_today: Number(t.total_due_today || 0), unassigned: Number(t.total_unassigned || 0),
        anchors: Number(t.total_anchors || 0), siblings: Number(t.total_siblings || 0),
      };
      let next_cursor = null;
      if (rows.length === limit) {
        const last = rows[rows.length - 1];
        // cursor carries POSTGRES-precision text (::text), never a JS Date —
        // Date→ISO truncates microseconds and readmits the boundary row.
        next_cursor = Buffer.from(JSON.stringify({
          b: last.bucket, d: last.due_at_cur, c: last.created_at_cur, id: last.obligation_id,
        })).toString("base64url");
      }
      return res.json({
        name: "tour_followups_and_leasing_tasks",
        property_id: propertyId, counts, items, next_cursor,
        receipt: `${counts.open} open (${counts.anchors} follow-ups, ${counts.siblings} tasks): ${counts.overdue} overdue, ${counts.due_today} due today, ${counts.unassigned} unassigned.`,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // Session-authed completion for a queue item. Property wall enforced from
  // the CONVERSION row (the source of truth), never from client input; the
  // completion actor is SERVER-DERIVED from the staff session — a body-
  // supplied by_user_id is ignored. Write-once semantics live in the shared
  // resolveRung service (one door for anchors and future siblings alike).
  router.post("/operator/leasing/tasks/:obligationId/resolve", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!conversionService || !conversionService.resolveRung) {
      return res.status(503).json({ error: "task resolution is not wired on this deploy (conversionService missing)" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const wall = (await client.query(
        `select c.property_id from leasing_conversion_obligations lco
           join leasing_conversions c on c.id = lco.conversion_id
          where lco.obligation_id = $1`, [req.params.obligationId])).rows[0];
      if (!wall) { await client.query("rollback"); return res.status(404).json({ error: "no conversion task for that obligation." }); }
      if (wall.property_id !== req.operator.property_id) {
        await client.query("rollback");
        return res.status(403).json({ error: "that task belongs to another property." });
      }
      const b = req.body || {};
      const out = await conversionService.resolveRung(client, {
        obligation_id: req.params.obligationId,
        result: b.result || "completed",
        proof: b.proof || null,
        by_user_id: req.operator.id,                 // SERVER-DERIVED — never the body
        resolution_basis: b.resolution_basis || null, // required by the DOMAIN when closing unowned work
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || e.http || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // ── R3: shared property-wall + service-call shape for task actions ─────
  async function taskAction(req, res, fn) {
    if (!conversionService) return res.status(503).json({ error: "conversion service not wired on this deploy." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const wall = (await client.query(
        `select c.property_id from leasing_conversion_obligations lco
           join leasing_conversions c on c.id = lco.conversion_id
          where lco.obligation_id = $1`, [req.params.obligationId])).rows[0];
      if (!wall) { await client.query("rollback"); return res.status(404).json({ error: "no conversion task for that obligation." }); }
      if (wall.property_id !== req.operator.property_id) {
        await client.query("rollback");
        return res.status(403).json({ error: "that task belongs to another property." });
      }
      const out = await fn(client);
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || e.http || 500).json({ error: e.publicMessage || e.message, code: e.code });
    } finally { client.release(); }
  }

  // REASSIGN — task-only, eligible targets only, reason-bearing, in-tx
  // re-resolution of eligibility. The actor is SERVER-DERIVED.
  router.post("/operator/leasing/tasks/:obligationId/reassign", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    return taskAction(req, res, (client) => conversionService.reassignTask(client, {
      obligation_id: req.params.obligationId,
      by_user_id: req.operator.id,
      to_user_id: b.to_user_id || null,
      reason: b.reason || null, reason_detail: b.reason_detail || null,
      idempotency_key: b.idempotency_key || null,
    }));
  });

  // REOPEN — deliberate recovery of a TERMINAL task: dependency-aware,
  // 72h server-side window, reason + new_due_at required, stale owners
  // become UNASSIGNED. The prior close is preserved in the event ledger.
  router.post("/operator/leasing/tasks/:obligationId/reopen", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    return taskAction(req, res, (client) => conversionService.reopenRung(client, {
      obligation_id: req.params.obligationId,
      by_user_id: req.operator.id,
      reason: b.reason || null, reason_detail: b.reason_detail || null,
      new_due_at: b.new_due_at || null,
      idempotency_key: b.idempotency_key || null,
    }));
  });

  // CHANGE FOLLOW-UP TIME — any ACTIVE task: new due time + reason, no
  // terminal state, owner kept. (Not "reschedule": that word means a tour moved.)
  router.post("/operator/leasing/tasks/:obligationId/change-due", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    return taskAction(req, res, (client) => conversionService.changeDueTime(client, {
      obligation_id: req.params.obligationId,
      by_user_id: req.operator.id,
      reason: b.reason || null, reason_detail: b.reason_detail || null,
      new_due_at: b.new_due_at || null,
      idempotency_key: b.idempotency_key || null,
    }));
  });

  // RECENTLY CLOSED — the read that makes Reopen reachable. Same authz,
  // same wall; terminal tasks from the 72h recovery window, newest first.
  // Each row carries reopenability so the door never offers a dead button.
  router.get("/operator/leasing/tasks/recently-closed", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
      const rows = (await pool.query(
        `select o.id as obligation_id, lco.id as link_id, lco.conversion_id, lco.rung,
                case when lco.rung = 'leasing_task' then 'sibling' else 'anchor' end as anchor_or_sibling,
                o.label, p.id as person_id, p.name as person_name,
                lco.outcome, lco.resolution, lco.resolution_basis, lco.closed_at,
                lco.closed_by_user_id, cu.name as closed_by_name
           from leasing_conversion_obligations lco
           join obligations o         on o.id = lco.obligation_id
           join leasing_conversions c on c.id = lco.conversion_id
           join persons p             on p.id = c.person_id
           left join users cu         on cu.id = lco.closed_by_user_id
          where c.property_id = $1 and lco.outcome is not null
            and lco.closed_at >= now() - interval '72 hours'
          order by lco.closed_at desc
          limit 50`, [propertyId])).rows;
      const items = [];
      for (const r of rows) {
        let reopen = { reopenable: false, reason_code: "UNKNOWN" };
        if (conversionService && conversionService.assessReopenability) {
          try { const a = await conversionService.assessReopenability(pool, { obligation_id: r.obligation_id });
                reopen = { reopenable: a.reopenable, reason_code: a.reason_code || null }; }
          catch (_) {}
        }
        items.push({ obligation_id: r.obligation_id, conversion_id: r.conversion_id, rung: r.rung,
          anchor_or_sibling: r.anchor_or_sibling, label: r.label,
          person_id: r.person_id, person_name: r.person_name,
          resolution: r.resolution, resolution_basis: r.resolution_basis,
          closed_at: r.closed_at, closed_by_user_id: r.closed_by_user_id, closed_by_name: r.closed_by_name,
          reopenable: reopen.reopenable, not_reopenable_reason: reopen.reopenable ? null : reopen.reason_code });
      }
      return res.json({ name: "recently_closed_tasks", property_id: propertyId,
        window_hours: 72, items,
        receipt: `${items.length} task(s) closed in the last 72 hours.` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  // POST /operator/leasing/conversations/:conversationId/close-not-fit
  router.post("/operator/leasing/conversations/:conversationId/close-not-fit", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { reason_code, reason_note, idempotency_key } = req.body || {};
      const out = await leasingLifecycle.closeNotFit({
        conversationId: req.params.conversationId, propertyId: req.operator.property_id,
        actorUserId: req.operator.id, reasonCode: reason_code, reasonNote: reason_note,
        idempotencyKey: idempotency_key,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/leasing/conversations/:conversationId/reopen — manual manager
  // correction. (Genuine-inbound reopen is wired in the comm_event ingestion path,
  // not here.)
  router.post("/operator/leasing/conversations/:conversationId/reopen", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const { idempotency_key } = req.body || {};
      const out = await leasingLifecycle.reopen({
        conversationId: req.params.conversationId, propertyId: req.operator.property_id,
        actorType: "operator", actorUserId: req.operator.id, idempotencyKey: idempotency_key,
      });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // expose internals for headless proofs + for later route files
  // ══════════════════════════════════════════════════════════════════
  //  APPLICATION INVITATION — the PERMANENT live-operator entry point.
  //  Staff-session authenticated; actor SERVER-DERIVED (req.operator.id).
  //  Calls the existing applicationSubmission services — NO duplicate
  //  invitation logic. (The legacy shared-key /leasing/application-invitations
  //  route in applicationSubmission.js is marked for retirement.)
  //
  //  Two verbs, preserving prepared vs. manually_sent:
  //   POST /operator/leasing/application-invitations
  //        → create a 'prepared' invitation (returns applicant link). NOT a send.
  //   POST /operator/leasing/application-invitations/:id/sent
  //        → attest a manual send → 'manually_sent'. Only this moves the status.
  // ══════════════════════════════════════════════════════════════════
  // ── APPLICATION TARGET — ONE AUTHORITY, NOT A SECOND OPINION ────────
  //  This was a bespoke allowlist (ready_now | vacant_turning | on_notice)
  //  over the LEGACY availability projection, with its own date rule. It is
  //  now a thin adapter over the canonical application-target authority, so
  //  the selector, the prepare doors and the composite send command all ask
  //  ONE question and get ONE answer.
  //
  //  What the cutover changes, deliberately:
  //   · committed_future was already excluded, but the legacy module labelled
  //     EVERY standalone future lease 'locked' regardless of proof. The
  //     canonical read distinguishes pending from locked, and both refuse.
  //   · the old date rule compared a projected_ready_date derived from a
  //     five-day placeholder turn window. The authority requires a GOVERNED
  //     available_from and refuses when there is none, rather than offering
  //     against an assumed date.
  //   · multi-space units now refuse explicitly instead of being silently
  //     offered against whichever space the legacy projection listed first.
  //
  //  The return shape keeps `offerable` so existing call sites are untouched;
  //  callers that want to explain the refusal read refusal_code/refusal_reason.
  async function unitOfferableState(property_id, unit_id, intended_move_in, q = pool) {
    return applicationTargetAuthority.resolveApplicationTarget(q, {
      property_id, unit_id, intended_move_in, require_offerable: true,
    });
  }

    // ══════════════════════════════════════════════════════════════════
  //  APPLICATION LINK — GOVERNED STAFF-SESSION DOORS (v2.5-r1)
  //
  //  BIRTH (new intent / first preparation / provider send-at-prepare) is
  //  activation-gated: kill switch + property allowlist + the person's
  //  CURRENT eligible classification + this authenticated session. The
  //  eligible set now matches the one the comms boundary already requires
  //  to text a person at all; see capability.js.
  //  DRAIN/CORRECTION (finalize, revoke, expire, regenerate, retry) works
  //  when birth is disabled — but always property-authed via the session.
  //  Every correction re-classifies dispatch state UNDER the invitation
  //  lock inside the services; these adapters add no business logic.
  // ══════════════════════════════════════════════════════════════════
  // ── APPLICATION-LINK BIRTH GATE ───────────────────────────────────
  // The policy no longer lives here. It lives in capability.js, and the
  // BOARD PROJECTION asks the same function before it renders the Send
  // button — so an action that this route would refuse arrives already
  // disabled, carrying the reason, instead of being discovered by pressing
  // it and reading a red box.
  //
  // Two callers, one decision, by construction. If this route computed its
  // own verdict the two could drift, and the drift has a worst case: a
  // button that says available while the server refuses. Rule 9 — no
  // phantom dispatch — applies to what a screen PROMISES, not only to what
  // it sends.
  //
  // The HTTP shape is preserved exactly (ok / status / error / receipt) so
  // every existing call site is untouched.
  const HTTP_FOR_REASON = {
    APPLICATION_LINK_DISABLED: { status: 503, error: "application_intent_disabled" },
    PROPERTY_NOT_ACTIVATED:    { status: 403, error: "property_not_activated" },
    NO_CONSENT:                { status: 403, error: "person_has_not_consented" },
    PERSON_UNKNOWN:            { status: 403, error: "person_unknown" },
  };
  async function applicationBirthGate(req, person_id, q = pool) {
    const verdict = await capability.evaluateApplicationLinkBirth(q, {
      property_id: req.operator.property_id,
      person_id: person_id || null,
    });
    if (verdict.allowed) return { ok: true, capability: verdict };
    const http = HTTP_FOR_REASON[verdict.reason_code] || { status: 403, error: "not_permitted" };
    return { ok: false, status: http.status, error: http.error,
             receipt: verdict.display_reason, capability: verdict };
  }

  function svcGuard(res, fn) {
    if (!applicationInvitations || !applicationInvitations[fn]) {
      res.status(503).json({ error: "invitation service not wired." });
      return false;
    }
    return true;
  }

  // 1) RECORD INTENT (birth) — spawns the prepare child under the exact parent.
  router.post("/operator/leasing/application-intent", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!conversionService || !conversionService.recordApplicationIntent) {
      return res.status(503).json({ error: "conversion service not wired." });
    }
    const { conversion_id, idempotency_key, evidence_type = null, evidence_ref = null } = req.body || {};
    if (!conversion_id) return res.status(400).json({ error: "conversion_id is required." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const conv = (await client.query(
        "select id, property_id, person_id from leasing_conversions where id=$1", [conversion_id])).rows[0];
      if (!conv) { await client.query("rollback"); return res.status(404).json({ error: "conversion not found." }); }
      if (String(conv.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const gate = await applicationBirthGate(req, conv.person_id, client);
      if (!gate.ok) { await client.query("rollback"); return res.status(gate.status).json(gate); }
      const out = await conversionService.recordApplicationIntent(client, {
        conversion_id, source: "operator_recorded",
        recorded_by_user_id: req.operator.id,            // server-derived actor
        idempotency_key: idempotency_key || null,
        evidence_type, evidence_ref,
      });
      await client.query("commit");
      return res.json({ recorded: out.recorded, intent_id: out.intent ? out.intent.id : null,
        prepare_obligation_id: out.obligation.id, parent_obligation_id: out.obligation.parent_obligation_id,
        receipt: out.recorded ? "Intent recorded — the prepare commitment is open under the post-tour follow-up."
                              : "Already recorded — the existing prepare commitment stands." });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // 2) PREPARE (birth) — against the EXACT prepare commitment. Raw token once.
  router.post("/operator/leasing/application-invitations", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "prepareApplicationLinkForObligation")) return;
    const APPLICANT_ORIGIN = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    if (!APPLICANT_ORIGIN) {
      return res.status(503).json({ error: "applicant_link_origin_not_configured",
        receipt: "APP_BASE_URL is not set. Refusing to create an invitation whose applicant link cannot be built." });
    }
    const { prepare_obligation_id, unit_id, expires_at = null, intended_move_in = null } = req.body || {};
    if (!prepare_obligation_id) return res.status(400).json({ error: "prepare_obligation_id is required — prepare acts on the exact open commitment." });
    if (!unit_id) return res.status(400).json({ error: "A unit is required to send an application." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const ob = (await client.query(
        "select id, property_id, person_id from obligations where id=$1", [prepare_obligation_id])).rows[0];
      if (!ob) { await client.query("rollback"); return res.status(404).json({ error: "No obligation with that id." }); }
      if (String(ob.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const gate = await applicationBirthGate(req, ob.person_id, client);
      if (!gate.ok) { await client.query("rollback"); return res.status(gate.status).json(gate); }
      const out = await applicationInvitations.prepareApplicationLinkForObligation(client, {
        prepare_obligation_id, unit_id, expires_at,
        actor_user_id: req.operator.id,
        unitOfferable: async (c, { property_id, unit_id }) =>
          unitOfferableState(property_id, unit_id, intended_move_in, c),
      });
      await client.query("commit");
      out.link = `${APPLICANT_ORIGIN}/t/application/${out.token}`;
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // 3) PROVIDER SEND (birth) — prepare + text in ONE operator action.
  //    Phase 1 re-locks + reverifies inside the service (M34).
  router.post("/operator/leasing/application-invitations/send", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "dispatchPreparedLinkProvider")) return;
    const { prepare_obligation_id, unit_id, expires_at = null, intended_move_in = null, message_prefix = "" } = req.body || {};
    if (!prepare_obligation_id) return res.status(400).json({ error: "prepare_obligation_id is required." });
    if (!unit_id) return res.status(400).json({ error: "A unit is required to send an application." });
    const client = await pool.connect();
    let prepared;
    try {
      await client.query("begin");
      const ob = (await client.query(
        "select id, property_id, person_id from obligations where id=$1", [prepare_obligation_id])).rows[0];
      if (!ob) { await client.query("rollback"); return res.status(404).json({ error: "No obligation with that id." }); }
      if (String(ob.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const gate = await applicationBirthGate(req, ob.person_id, client);
      if (!gate.ok) { await client.query("rollback"); return res.status(gate.status).json(gate); }
      prepared = await applicationInvitations.prepareApplicationLinkForObligation(client, {
        prepare_obligation_id, unit_id, expires_at,
        actor_user_id: req.operator.id,
        unitOfferable: async (c, { property_id, unit_id }) =>
          unitOfferableState(property_id, unit_id, intended_move_in, c),
      });
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      client.release();
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
    client.release();
    try {
      const out = await applicationInvitations.dispatchPreparedLinkProvider({
        invitation_id: prepared.invitation_id, raw_token: prepared.token,
        actor_user_id: req.operator.id, message_prefix,
      });
      return res.status(out.dispatched ? 200 : 409).json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message,
        invitation_id: prepared.invitation_id,
        receipt: "The link was prepared but dispatch did not complete — its state is recorded; use the correction actions." });
    }
  });

  // 3b) COMPOSITE HUMAN COMMAND — "Send application" from a conversion.
  //     The browser supplies ONLY conversion + unit + one idempotency key.
  //     The server authors the lifecycle: record intent → obtain the exact
  //     server-created prepare child → prepare the invitation against it →
  //     commit intent+prepare together → dispatch OUTSIDE the transaction via
  //     the canonical save-first provider service. It does NOT accept
  //     person_id or prepare_obligation_id from the browser.
  router.post(
    "/operator/leasing/conversions/:conversionId/send-application",
    requireOperator,
    requireLeasingModuleAccess,
    async (req, res) => {
      res.set("Cache-Control", "no-store");

      if (!conversionService || typeof conversionService.recordApplicationIntent !== "function") {
        return res.status(503).json({
          error: "conversion service not wired.",
          receipt: "Application sending is unavailable because the conversion service is not wired.",
        });
      }
      if (!applicationInvitations ||
          typeof applicationInvitations.prepareApplicationLinkForObligation !== "function" ||
          typeof applicationInvitations.dispatchPreparedLinkProvider !== "function") {
        return res.status(503).json({
          error: "invitation service not wired.",
          receipt: "Application sending is unavailable because the invitation service is not wired.",
        });
      }

      const {
        unit_id,
        idempotency_key,
        expires_at = null,
        intended_move_in = null,
        message_prefix = "",
      } = req.body || {};

      if (!unit_id) {
        return res.status(400).json({
          error: "unit_id is required.",
          receipt: "Choose a current unit before sending the application.",
        });
      }
      if (!idempotency_key) {
        return res.status(400).json({
          error: "idempotency_key is required.",
          receipt: "The send attempt has no retry identity. Refresh and try again.",
        });
      }

      const conversionId = req.params.conversionId;
      const client = await pool.connect();
      let staged;

      try {
        await client.query("begin");

        const conv = (await client.query(
          "select id, property_id, person_id from leasing_conversions where id=$1 for update",
          [conversionId]
        )).rows[0];

        if (!conv) {
          await client.query("rollback");
          return res.status(404).json({
            error: "conversion_not_found",
            receipt: "This leasing conversation no longer exists. Refresh Leasing.",
          });
        }
        if (String(conv.property_id) !== String(req.operator.property_id)) {
          await client.query("rollback");
          return res.status(403).json({
            error: "outside_property_scope",
            receipt: "This leasing conversation belongs to another property.",
          });
        }

        const gate = await applicationBirthGate(req, conv.person_id, client);
        if (!gate.ok) {
          await client.query("rollback");
          return res.status(gate.status).json(gate);
        }

        staged = await applicationSendCommand.stageApplicationSend(
          client,
          { conversionService, applicationInvitations },
          {
            conversionId,
            actorUserId: req.operator.id,
            unitId: unit_id,
            idempotencyKey: idempotency_key,
            expiresAt: expires_at,
            unitOfferable: async (c, { property_id, unit_id: candidateUnitId }) =>
              unitOfferableState(property_id, candidateUnitId, intended_move_in, c),
          }
        );

        await client.query("commit");
      } catch (e) {
        await client.query("rollback").catch(() => {});
        return res.status(e.httpStatus || 500).json({
          error: e.code || e.publicMessage || e.message,
          receipt: e.publicMessage || e.message || "The application send could not be prepared.",
        });
      } finally {
        client.release();
      }

      try {
        const out = await applicationSendCommand.dispatchApplicationSend(
          { applicationInvitations },
          staged,
          {
            actorUserId: req.operator.id,
            messagePrefix: message_prefix,
          }
        );

        return res.status(out.dispatched ? 200 : 409).json(out);
      } catch (e) {
        return res.status(e.httpStatus || 500).json({
          sent: false,
          dispatched: false,
          error: e.code || e.publicMessage || e.message,
          invitation_id: staged.invitation_id,
          prepare_obligation_id: staged.prepare_obligation_id,
          receipt:
            e.publicMessage ||
            "The application link was prepared, but dispatch did not complete. Its state is recorded; use the invitation correction flow.",
        });
      }
    }
  );

  // 4) FINALIZE MANUAL SEND (drain) — the one final-send transaction.
  router.post("/operator/leasing/application-invitations/:id/sent", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "finalizeInvitationSent")) return;
    const { send_obligation_id, channel, recipient_snapshot = null, note = null } = req.body || {};
    if (!send_obligation_id) return res.status(400).json({ error: "send_obligation_id is required — attestation closes the exact send commitment." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inv = (await client.query(
        "select id, property_id from application_invitations where id=$1", [req.params.id])).rows[0];
      if (!inv) { await client.query("rollback"); return res.status(404).json({ error: "No invitation with that id." }); }
      if (String(inv.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const out = await applicationInvitations.finalizeInvitationSent(client, {
        invitation_id: req.params.id, send_obligation_id,
        dispatch_source: "manual", channel, recipient_snapshot, note,
        actor_user_id: req.operator.id,
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // 5) REVOKE / 6) EXPIRE (corrections) — reconcile dispatch state FIRST.
  async function correctionRoute(req, res, requested_action) {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "reconcileCorrection")) return;
    try {
      const inv = (await pool.query(
        "select id, property_id from application_invitations where id=$1", [req.params.id])).rows[0];
      if (!inv) return res.status(404).json({ error: "No invitation with that id." });
      if (String(inv.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "Not in your property scope." });
      }
      const out = await applicationInvitations.reconcileCorrection({
        invitation_id: req.params.id, requested_action,
        actor_user_id: req.operator.id, reason: (req.body && req.body.reason) || null,
      });
      return res.json(out);
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  }
  router.post("/operator/leasing/application-invitations/:id/revoke", requireOperator, requireLeasingModuleAccess,
    (req, res) => correctionRoute(req, res, "revoke"));
  router.post("/operator/leasing/application-invitations/:id/expire", requireOperator, requireLeasingModuleAccess,
    (req, res) => correctionRoute(req, res, "expire"));

  // 7) REGENERATE (lost-token correction; drain).
  router.post("/operator/leasing/application-invitations/:id/regenerate", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "regenerateInvitation")) return;
    const APPLICANT_ORIGIN = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    if (!APPLICANT_ORIGIN) {
      return res.status(503).json({ error: "applicant_link_origin_not_configured" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const inv = (await client.query(
        "select id, property_id from application_invitations where id=$1", [req.params.id])).rows[0];
      if (!inv) { await client.query("rollback"); return res.status(404).json({ error: "No invitation with that id." }); }
      if (String(inv.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const out = await applicationInvitations.regenerateInvitation(client, {
        invitation_id: req.params.id, actor_user_id: req.operator.id,
      });
      await client.query("commit");
      out.link = `${APPLICANT_ORIGIN}/t/application/${out.token}`;
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // 8) RETRY (correction) — restores a REAL prepare child under the same parent.
  router.post("/operator/leasing/application-link-retry", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!svcGuard(res, "beginRetryWithDispatchGate")) return;
    const { parent_obligation_id, prior_invitation_id, prior_send_obligation_id } = req.body || {};
    if (!parent_obligation_id || !prior_invitation_id || !prior_send_obligation_id) {
      return res.status(400).json({ error: "parent_obligation_id, prior_invitation_id, and prior_send_obligation_id are required." });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const parent = (await client.query(
        "select id, property_id from obligations where id=$1", [parent_obligation_id])).rows[0];
      if (!parent) { await client.query("rollback"); return res.status(404).json({ error: "No obligation with that id." }); }
      if (String(parent.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback"); return res.status(403).json({ error: "Not in your property scope." });
      }
      const out = await applicationInvitations.beginRetryWithDispatchGate(client, {
        parent_obligation_id, prior_invitation_id, prior_send_obligation_id,
        by_user_id: req.operator.id,
      });
      await client.query("commit");
      return res.json({ retry_child_obligation_id: out.retry_child.id,
        parent_obligation_id, intent_id: out.intent_id,
        receipt: "A fresh prepare commitment is open under the same post-tour follow-up." });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    } finally { client.release(); }
  });

  // 9) APPLICATION NEXT (read) — the rooted projection; the browser derives nothing.
  router.get("/operator/leasing/application-next", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!conversionService || !conversionService.resolveApplicationNext) {
      return res.status(503).json({ error: "conversion service not wired." });
    }
    const conversion_id = req.query && req.query.conversion_id;
    if (!conversion_id) return res.status(400).json({ error: "conversion_id is required." });
    try {
      const conv = (await pool.query(
        "select id, property_id from leasing_conversions where id=$1", [conversion_id])).rows[0];
      if (!conv) return res.status(404).json({ error: "conversion not found." });
      if (String(conv.property_id) !== String(req.operator.property_id)) {
        return res.status(403).json({ error: "Not in your property scope." });
      }
      const next = await conversionService.resolveApplicationNext(pool, { conversion_id });
      return res.json({ application_next: next });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message });
    }
  });


  // LEASEABLE UNITS for the send-application selector. Session-gated, read-only,
  // over the EXISTING availability projection (availability.js readAvailability)
  // — no second availability system. Returns only spaces that can be offered
  // (availability_state !== 'unavailable'); property is the session's scope.
  // ══════════════════════════════════════════════════════════════════
  //  LEASEABLE UNITS — the send-application selector.
  //
  //  Session-gated, read-only, over CANONICAL availability and the ONE
  //  application-target authority. The legacy availability projection is gone
  //  from this route, which is what makes the module deletable.
  //
  //  TWO LISTS, NOT ONE FILTERED LIST. A multi-space unit is not absent
  //  because it failed a marketing test — it is present and unselectable
  //  because the durable chain cannot carry a space choice. Dropping those
  //  rows silently would leave an operator hunting for a unit they can see in
  //  every other surface, with no statement of why it is missing here.
  //
  //  ONE ROW PER UNIT, NEVER ONE PER SPACE. The application segment is
  //  unit-grained; returning a selectable row per space would offer a choice
  //  the invitation cannot preserve.
  //
  //  resolved_space_id on an eligible row is a SERVER-AUTHORED VALIDATION
  //  RECEIPT — the space availability was evaluated against. It is not a
  //  "selected space" and the browser must not send it back.
  // ══════════════════════════════════════════════════════════════════
  router.get("/operator/leasing/leaseable-units", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const property_id = req.operator.property_id;         // SERVER-DERIVED, never the query string
      const intended_move_in = req.query.intended_move_in || null;

      // Space grain per unit, including units with none. LEFT JOIN so a
      // zero-space unit is a row rather than an absence.
      const shapes = (await pool.query(
        `select u.id as unit_id, u.unit_number, count(s.id)::int as space_count
           from units u
           left join spaces s on s.unit_id = u.id
          where u.property_id = $1
          group by u.id, u.unit_number
          order by u.unit_number asc`,
        [property_id]
      )).rows;

      // ONE canonical availability read for the whole property. The authority's
      // OWN policy function is then applied per row — resolveApplicationTarget
      // per unit would re-read availability for the entire property once per
      // unit, which is quadratic. Same rule, evaluated once per position.
      const avail = await availabilityRead(pool, { property_id });
      const byUnit = new Map(avail.rows.map((r) => [String(r.unit_id), r]));

      const eligible_units = [];
      const unsupported_multi_space_units = [];

      for (const u of shapes) {
        if (u.space_count > 1) {
          unsupported_multi_space_units.push({
            unit_id: u.unit_id,
            unit_number: u.unit_number,
            rentable_space_count: u.space_count,
            reason_code: applicationTargetAuthority.REFUSAL.MULTI_SPACE,
            reason: applicationTargetAuthority.REFUSAL_TEXT[applicationTargetAuthority.REFUSAL.MULTI_SPACE],
          });
          continue;
        }
        if (u.space_count === 0) continue;   // unconfigured: not eligible, not a grain refusal

        const row = byUnit.get(String(u.unit_id));
        if (!row) continue;                  // classified by nobody: not evidence of availability
        const verdict = applicationTargetAuthority.evaluateOfferability(row, intended_move_in);
        if (!verdict.offerable) continue;    // ordinary not-offerable, not a grain refusal

        eligible_units.push({
          unit_id: row.unit_id,
          unit_number: row.unit_number,
          resolved_space_id: row.space_id,   // validation receipt, NOT a selection
          position_kind: row.position_kind,
          space_label: row.space_label,
          marketing_state: row.marketing_state,
          available_from: row.available_from,
          availability_confidence: row.availability_confidence,
          resolution_basis: "sole_space_unit",
        });
      }

      return res.json({
        property_id,
        eligible_count: eligible_units.length,
        unsupported_count: unsupported_multi_space_units.length,
        eligible_units,
        unsupported_multi_space_units,
      });
    } catch (e) {
      return res.status(e.httpStatus || 500).json({ error: e.message || "leaseable-units read failed" });
    }
  });

  // ── LEASING CONDITION (Step 2 strip) — READ-ONLY, SESSION-SCOPED ──────────
  //  A THIN session-authorized wrapper around the ONE canonical facts builder
  //  (leasing_condition_facts.js). Property is SERVER-DERIVED from the session
  //  (req.operator.property_id) — the browser never supplies it; x-staff-session
  //  is enforced by requireOperator (401 on invalid/expired) +
  //  requireLeasingModuleAccess (403 without the module). No business logic
  //  lives here — the calculation is shared so it cannot drift from other views.
  const { leasingConditionFacts } = require("../leasing/leasing_condition_facts.js");
  router.get("/operator/leasing/condition", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const facts = await leasingConditionFacts(pool, req.operator.property_id);  // session scope only
      return res.json(facts);
    } catch (e) {
      console.error("operator leasing-condition error", e);
      return res.status(500).json({ error: "LEASING_CONDITION_FAILED",
        receipt: "The leasing condition read failed. Retry; if it persists the read is unavailable." });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  TENANCY-ANCHOR OPERATOR ADAPTERS (Fable ruling — the operator seam)
  //
  //  POST /operator/leasing/applications/:id/countersign
  //  POST /operator/leasing/applications/:id/confirm-term
  //
  //  These are ENTRY ADAPTERS over the ONE canonical tenancy-anchor service
  //  (tenancy_anchor_service.js) — the exact same implementation the legacy
  //  /applications/:id/* routes call. They add NOTHING to the write; they add
  //  the operator SESSION model so the frontend reaches the canonical write
  //  the same way it reaches every other Leasing action, instead of the
  //  client-side device journal it uses today.
  //
  //  AUTHORITY (identical to the legacy routes, per the ruling):
  //    dormantWriteGuard (Layer 1, no DB)
  //      → activationPerimeter (Layer 2): authenticated x-staff-session,
  //        property-activated, leasing-module entitlement, session-property ==
  //        application-property, current internal_qa, eligible application
  //        status. The perimeter is the authority boundary; it attaches the
  //        server-derived actor (req._perimeterActor). The handler opens the
  //        transaction and the SERVICE is final authority under FOR UPDATE.
  //
  //  ACTOR (the one operator-facing improvement the ruling allows — adapt
  //  ACCESS, never the write): the attestation is SERVER-DERIVED from the
  //  authenticated session (req._perimeterActor.name), never a body string.
  //  The J1 economics lock needs a real PERSON id (countersigned_by_person_id);
  //  we resolve the session user → its bridged person only when required. If a
  //  bound offer needs it and it can't be resolved, the service fails closed
  //  honestly (unchanged behavior).
  //
  //  loadApplication for the perimeter = the same one-row read applications.js
  //  uses; the perimeter derives property/person/status from the app row.
  // ══════════════════════════════════════════════════════════════════
  const _getAppForPerimeter = async (q, id) =>
    (await q.query("select * from lease_applications where id=$1", [id])).rows[0];

  // ══════════════════════════════════════════════════════════════════
  //  OPERATOR APPROVE (v3 §4) — the walled adapter over the ONE canonical
  //  approveApplication service. Authority is NOT merely the leasing module:
  //  the approval gate belongs to a ROLE (leasing_manager — read from the
  //  obligation row itself, never re-hardcoded here). Eligible iff the
  //  authenticated operator:
  //    · OWNS the approval obligation (assigned_user_id), or
  //    · holds the obligation's own required role (live role_title / role
  //      from the resolved session — server truth, not the browser), or
  //    · carries the explicit governed override (can_manage_roles).
  //  Application with NO approval gate (legacy direct-create): override only.
  //  Refusals are OPAQUE ({error:"not_permitted"}) with a full stderr audit —
  //  same posture as the activation perimeter. Actor is req.operator.id.
  // ══════════════════════════════════════════════════════════════════
  router.post("/operator/leasing/applications/:id/approve", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!applicationsService || typeof applicationsService.approveApplication !== "function") {
      return res.status(503).json({ receipt: "Approve service not wired on this deploy (applicationsService missing). Deploy applications.js + the updated server.js together." });
    }
    const op = req.operator;
    const refuse = (reason, appRow) => {
      console.error("[operator-approve refused]", JSON.stringify({
        reason, user_id: op.id, session_property: op.property_id,
        application_id: req.params.id, application_property: appRow ? appRow.property_id : null,
        role: op.role || null, role_title: op.role_title || null, at: new Date().toISOString(),
      }));
      return res.status(403).json({ error: "not_permitted" });
    };
    const client = await pool.connect();
    try {
      const app = await _getAppForPerimeter(client, req.params.id);
      if (!app) { return res.status(404).json({ receipt: "No application with that id." }); }
      // PROPERTY WALL — the session's property must match the application's.
      if (app.property_id !== op.property_id) { return refuse("property_mismatch", app); }
      // OBLIGATION-OWNERSHIP AUTHORITY — the gate's own row is the source of
      // the required role; this route performs no independent role literal.
      let eligible = op.can_manage_roles === true; // explicit governed override
      if (!eligible && app.approval_obligation_id) {
        const ob = (await client.query(
          "select assigned_role, assigned_user_id from obligations where id=$1",
          [app.approval_obligation_id])).rows[0];
        if (ob) {
          eligible = (ob.assigned_user_id && ob.assigned_user_id === op.id) ||
                     (ob.assigned_role && (ob.assigned_role === op.role_title || ob.assigned_role === op.role));
        }
      }
      if (!eligible) { return refuse(app.approval_obligation_id ? "not_gate_eligible" : "no_gate_and_no_override", app); }

      await client.query("begin");
      const out = await applicationsService.approveApplication(client, {
        applicationId: req.params.id,
        approvedByNote: op.name || `staff:${op.id}`,   // SERVER-DERIVED attestation
        actorUserId: op.id,                            // SERVER-DERIVED actor
      });
      await client.query("commit");
      const gate = await applicationsService.outstanding(pool, out.application);
      return res.json({
        receipt: `Approved. Terms-review next for ${out.application.applicant_name}. The resident acknowledges proposed terms; an executed lease is a separate, later fact.`,
        application: applicationsService.shape(out.application, gate),
        terms_review_obligation_id: out.obligation.id,
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e.httpStatus) return res.status(e.httpStatus).json(e.body);
      console.error("operator approve error", e);
      return res.status(500).json({ receipt: "Could not approve the application.", error: e.message });
    } finally { client.release(); }
  });


  // POST /operator/leasing/applications/:id/proposed-terms
  // Records the governed "management confirmed these proposed economics for
  // resident review" fact. Changes no status, creates no lease, satisfies no
  // terms-review input. Opaque refusal on authority/property (audited server-side).
  router.post("/operator/leasing/applications/:id/proposed-terms", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    const op = req.operator;
    const b = req.body || {};
    // server-derived actor context — the browser supplies NONE of this.
    const actor = {
      user_id: op.id,
      property_id: op.property_id,
      role: op.role,
      role_title: op.role_title,
      can_manage_roles: op.can_manage_roles,
    };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await proposedTerms.confirmProposedTerms(client, {
        application_id: req.params.id,
        rent: b.rent,
        security_deposit: b.security_deposit,
        lease_start_date: b.lease_start_date,
        lease_end_date: b.lease_end_date,
        concession_status: b.concession_status,
        idempotency_key: b.idempotency_key,
        actor,
      });
      await client.query("commit");
      return res.json({
        receipt: out.idempotent
          ? "Proposed terms already confirmed (idempotent) — nothing changed."
          : "Proposed terms confirmed for resident review. This is a proposal, not an executed lease.",
        idempotent: out.idempotent,
        confirmation_id: out.confirmation_id,
        authority_basis: out.authority_basis,
        supersedes_confirmation_id: out.supersedes_confirmation_id || null,
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      // service throws typed errors: e.httpStatus + e.code (+ message). Map to HTTP.
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.code || "refused" });
      console.error("operator proposed-terms error", e);
      return res.status(500).json({ error: "internal", receipt: "Could not confirm proposed terms." });
    } finally { client.release(); }
  });

  const operatorCountersignPerimeter = activationPerimeter({
    pool,
    loadApplication: _getAppForPerimeter,
    // countersign runs after approve (lease_ready) and typically after the tenant
    // signs (tenant_signed) — both legitimate pre-countersign states. The service
    // is final authority (re-checks obligation inputs under lock). Perimeter must
    // not be stricter than the handler; matches applications.js exactly.
    eligibleStatuses: ["lease_ready", "tenant_signed"],
    action: "countersign",
    requiredModule: "leasing",
  });
  const operatorConfirmTermPerimeter = activationPerimeter({
    pool,
    loadApplication: _getAppForPerimeter,
    eligibleStatuses: ["accepted_term_required"],
    action: "confirm_term",
    requiredModule: "leasing",
  });

  const _getAppForPacketPerimeter = async (q, packetId) =>
    (await q.query(
      `select la.*
         from lease_packets pk
         join lease_applications la on la.id=pk.application_id
        where pk.id=$1 and pk.superseded_at is null`,
      [packetId]
    )).rows[0];

  const operatorGeneratePacketPerimeter = activationPerimeter({
    pool,
    loadApplication: _getAppForPerimeter,
    eligibleStatuses: ["lease_ready", "tenant_signed", "approved"],
    action: "generate_lease_packet",
    requiredModule: "leasing",
  });

  const operatorIssuePacketPerimeter = activationPerimeter({
    pool,
    loadApplication: _getAppForPacketPerimeter,
    eligibleStatuses: ["lease_ready", "tenant_signed", "approved"],
    action: "issue_lease_packet_link",
    requiredModule: "leasing",
  });

  function operatorPacketAuditContext(req) {
    const f = req.headers && req.headers["x-forwarded-for"];
    return {
      ip_address: typeof f === "string" && f.length
        ? f.split(",")[0].trim()
        : (req.ip || null),
      user_agent: (req.headers && req.headers["user-agent"]) || null,
    };
  }

  // Resolve the authenticated session USER → its bridged PERSON id, if the
  // deliberate staff-user↔person bridge has one. Returns null otherwise (the
  // service then fails closed only if a bound offer actually requires it — the
  // internal_qa demo path carries no offer and never needs it).
  async function resolveActorPersonId(userId, propertyId) {
    if (!userId) return null;
    try {
      const idn = await staffIdentity.resolveStaffIdentity(pool, { user_id: userId, property_id: propertyId });
      return (idn && idn.state === "resolved" && idn.person_id) ? idn.person_id : null;
    } catch (_) { return null; }
  }

  // ── MOVE-IN DELIVERY: the PM keys/access attestation (Slice D closure) ──
  //  The move_in_delivery obligation is born at confirm-term with two hard
  //  gates: unit_ready (fed by maintenance readiness approval in movein.js)
  //  and keys_access_ready. delivery.js anticipated "a PM action" as the
  //  second feeder; this door IS that action. Without it the delivery
  //  promise can never close — an obligation nobody can act on violates
  //  the accountability rule. Drain-flow door: session-authed, no birth
  //  gate (it completes existing work; it creates none).
  //  Classification: Class 1 permanent primitive.
  router.post("/operator/leasing/leases/:leaseId/delivery/keys-ready", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!deliveryHelper || typeof deliveryHelper.satisfyDeliveryInput !== "function") {
      return res.status(503).json({ receipt: "Delivery helper is not wired on this deploy. Deploy delivery.js, operator.js, and server.js together." });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      // THE WALL: the lease must belong to the session's property. The
      // browser asserts nothing; the row decides.
      const lq = await client.query("select id, property_id from leases where id=$1", [req.params.leaseId]);
      const lease = lq.rows[0];
      if (!lease) { await client.query("rollback"); return res.status(404).json({ receipt: "No lease with that id." }); }
      if (String(lease.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback");
        return res.status(403).json({ receipt: "That lease belongs to a different property." });
      }
      const actorPersonId = await resolveActorPersonId(req.operator.id, req.operator.property_id);
      const fed = await deliveryHelper.satisfyDeliveryInput(client, {
        lease_id: lease.id, input_key: "keys_access_ready",
        source: "operator_keys_ready", actor: req.operator.id,
        timestamp: new Date().toISOString(),
      });
      if (fed.noop && fed.reason === "no open move_in_delivery obligation") {
        await client.query("rollback");
        return res.status(404).json({ receipt: "No open move-in delivery obligation for this lease. Either it was already completed, or the term has not been confirmed yet." });
      }
      const closed = await deliveryHelper.completeDeliveryIfReady(client, {
        lease_id: lease.id, completed_by: actorPersonId || req.operator.id,
      });
      await client.query("commit");
      // plain-language receipt: what happened, the id, what happens next
      const receipt = closed.completed
        ? "Keys and access confirmed. All delivery gates cleared — the move-in delivery promise is COMPLETE."
        : fed.satisfied
          ? `Keys and access confirmed. Delivery not yet complete — remaining gate(s): ${(closed.remaining || []).join(", ") || "unknown"}. The unit_ready gate clears when maintenance readiness is approved.`
          : "Keys and access were already confirmed. " + (closed.reason === "hard gates remain"
              ? `Remaining gate(s): ${(closed.remaining || []).join(", ")}.`
              : "Nothing further to do.");
      return res.json({
        receipt,
        lease_id: lease.id,
        obligation_id: fed.obligation_id || closed.obligation_id || null,
        keys_access_ready: fed.satisfied ? "satisfied_now" : "already_satisfied",
        delivery_complete: !!closed.completed,
        remaining_gates: closed.remaining || [],
      });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      console.error("operator delivery keys-ready:", e);
      return res.status(500).json({ receipt: "Could not record keys/access readiness.", error: e.message });
    } finally { client.release(); }
  });

  // LEASE-PACKET OPERATOR ADAPTERS — staff-session doors over
  // leasepackets.js's one canonical service.
  router.post(
    "/operator/leasing/applications/:id/lease-packet",
    dormantWriteGuard,
    requireOperator,
    requireLeasingModuleAccess,
    operatorGeneratePacketPerimeter,
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!leasePacketsService ||
          typeof leasePacketsService.generateLeasePacket !== "function") {
        return res.status(503).json({
          receipt: "Lease-packet generation is not wired on this deploy. Deploy leasepackets.js, operator.js, and server.js together.",
        });
      }
      const op = req.operator;
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await leasePacketsService.generateLeasePacket(client, {
          applicationId: req.params.id,
          actorUserId: op.id,
          expectedPropertyId: op.property_id,
          createNewVersion: !!(req.body && req.body.create_new_version === true),
          auditContext: operatorPacketAuditContext(req),
        });
        await client.query("commit");
        return res.json(out);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        if (e && e.httpStatus) {
          return res.status(e.httpStatus).json(e.body || {
            error: e.code || "packet_write_refused",
            receipt: e.message,
          });
        }
        console.error("operator lease-packet generate:", e);
        return res.status(500).json({
          error: "internal",
          receipt: "Could not generate the lease packet.",
        });
      } finally {
        client.release();
      }
    }
  );

  router.post(
    "/operator/leasing/lease-packets/:id/send",
    dormantWriteGuard,
    requireOperator,
    requireLeasingModuleAccess,
    operatorIssuePacketPerimeter,
    async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!leasePacketsService ||
          typeof leasePacketsService.issueLeasePacketLink !== "function") {
        return res.status(503).json({
          receipt: "Lease-packet issue is not wired on this deploy. Deploy leasepackets.js, operator.js, and server.js together.",
        });
      }
      const op = req.operator;
      const b = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await leasePacketsService.issueLeasePacketLink(client, {
          packetId: req.params.id,
          expiresDays: b.expires_days != null ? b.expires_days : 14,
          idempotencyKey: b.idempotency_key || null,
          actorUserId: op.id,
          expectedPropertyId: op.property_id,
          auditContext: operatorPacketAuditContext(req),
        });
        await client.query("commit");
        return res.json(out);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        if (e && e.httpStatus) {
          return res.status(e.httpStatus).json(e.body || {
            error: e.code || "packet_write_refused",
            receipt: e.message,
          });
        }
        console.error("operator lease-packet issue:", e);
        return res.status(500).json({
          error: "internal",
          receipt: "Could not issue the lease packet.",
        });
      } finally {
        client.release();
      }
    }
  );

  //  RETIRED (088). "Countersign" described a company signing ceremony that
  //  does not exist: the wall in front of it always required an ALREADY
  //  executed lease. One operator action replaces it — Verify Executed Lease
  //  — which records the governing document and attempts admission in the
  //  same command. A 410 tombstone, never a silent alias.
  router.post("/operator/leasing/applications/:id/countersign", async (req, res) => {
    return res.status(410).json({
      error: "countersign_retired",
      receipt: "Retired. There is no company countersignature step: the lease is already executed " +
               "before Property Spine sees it. Use POST /operator/leasing/applications/:id/executed-lease/verify " +
               "to record the governing lease, then confirm the term.",
      replacement: "/operator/leasing/applications/:id/executed-lease/verify",
    });
  });

  //  VERIFY EXECUTED LEASE — one operator action, two internal phases.
  //    Phase 1 records the governing evidence and PERSISTS regardless.
  //    Phase 2 attempts operational admission; a conflict is a verdict,
  //    not a failure, so this returns 200 with activation_status:'blocked'.
  //  Classification: Class 1 permanent primitive.
  router.post("/operator/leasing/applications/:id/executed-lease/verify", requireOperator, requireLeasingModuleAccess, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!executedLease || typeof executedLease.verifyExecutedLease !== "function") {
      return res.status(503).json({ receipt: "Executed-lease intake is not wired on this deploy. Deploy executed_lease_service.js, operator.js and server.js together." });
    }
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      // PROPERTY WALL: the application must belong to the session's property.
      const aq = await client.query(
        "select id, property_id from lease_applications where id=$1", [req.params.id]);
      const app = aq.rows[0];
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }
      if (String(app.property_id) !== String(req.operator.property_id)) {
        await client.query("rollback");
        return res.status(403).json({ receipt: "That application belongs to a different property." });
      }
      const out = await executedLease.verifyExecutedLease(client, {
        application_id: req.params.id,
        space_id: b.space_id || null,
        rent: b.rent, security_deposit: b.security_deposit,
        lease_start_date: b.lease_start_date, lease_end_date: b.lease_end_date,
        concession_status: b.concession_status || "none",
        concession_schedule_id: b.concession_schedule_id || null,
        document_reference: b.document_reference || null,
        document_sha256: b.document_sha256 || null,
        provider_name: b.provider_name || null,
        provider_document_id: b.provider_document_id || null,
        provider_version_id: b.provider_version_id || null,
        document_version: b.document_version || 1,
        executed_at: b.executed_at, effective_date: b.effective_date || null,
        signers: b.signers, execution_channel: b.execution_channel,
        // SERVER-DERIVED: the verifying staff user is never a body value.
        verified_by_user_id: req.operator.id,
        supersedes_record_id: b.supersedes_record_id || null,
        idempotency_key: b.idempotency_key || null,
      }, { spawnObligationFromEvent: deps.spawnObligationFromEvent || null });
      await client.query("commit");
      // 200 even when activation is blocked: the requested fact — recording
      // the executed lease — succeeded.
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.code, receipt: e.message, ...(e.extra || {}) });
      if (e.svc) return res.status(e.http).json(e.body);
      console.error("operator verify executed lease:", e);
      return res.status(500).json({ receipt: "Could not record the executed lease.", error: e.message });
    } finally { client.release(); }
  });

  // eslint-disable-next-line no-unreachable

  router.post("/operator/leasing/applications/:id/confirm-term", dormantWriteGuard, operatorConfirmTermPerimeter, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!tenancyAnchor || typeof tenancyAnchor.confirmTermService !== "function") {
      return res.status(503).json({ receipt: "Confirm-term service not wired on this deploy (tenancyAnchor missing). Deploy tenancy_anchor_service.js + the updated server.js together." });
    }
    const actor = req._perimeterActor || {};
    const confirmedByName = actor.name || (actor.user_id ? `staff:${actor.user_id}` : null);
    const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      // GOVERNING VALUES ARE NOT ACCEPTED FROM THE BROWSER (088). rent,
      // dates, deposit and premises come from the verified executed lease.
      // The body carries the command only; `b` is deliberately unused here.
      const out = await tenancyAnchor.confirmTermService(client, {
        applicationId: req.params.id,
        confirmed_by: confirmedByName,          // SERVER-DERIVED attestation (never a body name)
        confirmed_by_user_id: actor.user_id || null,
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e.svc) return res.status(e.http).json(e.body);
      console.error("operator confirm-term:", e);
      return res.status(500).json({ receipt: "Could not confirm the lease term.", error: e.message });
    } finally { client.release(); }
  });

  router._internal = { resolveSession, requireOperator, scopedConversation, scopedFact, normalizeFactBody, insertActiveFact, assertDraftInScope, DEMO_MODE, leasingLifecycle };
  return router;
};
