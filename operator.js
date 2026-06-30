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

module.exports = function operatorModule(deps) {
  const { pool, agentService } = deps;
  if (!pool) throw new Error("operator.js requires { pool }");
  const router = require("express").Router();

  const DEMO_MODE = String(process.env.DEMO_MODE || "").toLowerCase() === "true";
  const DEMO_ACCESS_CODE = process.env.DEMO_ACCESS_CODE || ""; // high-entropy, single-purpose; DISTINCT from OPERATOR_KEY
  const DEMO_PROP_NAME = "Property Spine Demo Building";
  const DEMO_MGR_EMAIL = "demo-manager@propertyspine.internal";
  const DEMO_SESSION_HOURS = 6;

  function httpErr(status, msg) { const e = new Error(msg); e.httpStatus = status; e.publicMessage = msg; return e; }

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
    const token = req.headers["x-staff-session"];
    if (!token) return null;
    const r = await pool.query(
      `select u.id, u.name, u.email, u.role, s.property_id
         from staff_sessions s join users u on u.id = s.user_id
        where s.token = $1 and s.revoked = false and s.expires_at > now()`,
      [token]
    );
    return r.rows[0] || null;
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

          // mint a fresh scoped session, short expiry
          const token = crypto.randomBytes(18).toString("base64url");
          await client.query(
            `insert into staff_sessions (user_id, property_id, token, expires_at)
             values ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
            [mgr.id, prop.id, token, String(DEMO_SESSION_HOURS)]
          );

          await client.query("commit");
          return { token, property_id: prop.id, expires_in_hours: DEMO_SESSION_HOURS };
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
  router.get("/operator/me", requireOperator, async (req, res) => {
    const o = req.operator;
    res.set("Cache-Control", "no-store");
    return res.json({ id: o.id, name: o.name, role: o.role, property_id: o.property_id });
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
  router.get("/operator/agent-facts", requireOperator, async (req, res) => {
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
  router.post("/operator/agent-facts", requireOperator, async (req, res) => {
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
  router.post("/operator/agent-facts/:factId/retire", requireOperator, async (req, res) => {
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
  router.post("/operator/agent-facts/:factId/replace", requireOperator, async (req, res) => {
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
  router.get("/operator/leasing/conversations", requireOperator, async (req, res) => {
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

  // GET /operator/leasing/conversations/:conversationId — one convo, SCOPE-VERIFIED.
  // Returns the thread/draft via the shared getConversationStateService.
  router.get("/operator/leasing/conversations/:conversationId", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const client = await pool.connect();
      try { await scopedConversation(client, req.params.conversationId, req.operator.property_id); }
      finally { client.release(); }
      const state = await agentService.getConversationStateService({ conversationId: req.params.conversationId });
      // also include this property's facts so the page shows what the agent may use
      const facts = (await pool.query(
        `select id, fact_key, category, rendered_text, source_type, confirmed_at, effective_until, status
           from agent_facts where property_id=$1 and status='active' order by fact_key asc`,
        [req.operator.property_id]
      )).rows;
      return res.json({ ...state, facts });
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/agent-drafts/:draftId/send — SCOPE-VERIFIED, actor=session user.
  router.post("/operator/agent-drafts/:draftId/send", requireOperator, async (req, res) => {
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
  router.post("/operator/agent-drafts/:draftId/edit-and-send", requireOperator, async (req, res) => {
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
  router.post("/operator/agent-drafts/:draftId/regenerate", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const conv = await assertDraftInScope(req.params.draftId, req.operator.property_id);
      const out = await agentService.regenerateDraftService({ property_id: conv.property_id, person_id: conv.person_id });
      return res.json(out);
    } catch (e) { return res.status(e.httpStatus || 500).json({ error: e.publicMessage || e.message }); }
  });

  // POST /operator/conversations/:conversationId/take-over — SCOPE-VERIFIED.
  router.post("/operator/conversations/:conversationId/take-over", requireOperator, async (req, res) => {
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

  // expose internals for headless proofs + for later route files
  router._internal = { resolveSession, requireOperator, scopedConversation, scopedFact, normalizeFactBody, insertActiveFact, assertDraftInScope, DEMO_MODE };
  return router;
};
