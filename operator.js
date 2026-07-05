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
const staffIdentity = require("./staff_identity_resolver.js"); // 067: the ONE canonical users↔persons↔assignments read

module.exports = function operatorModule(deps) {
  const { pool, agentService, conversionService = null } = deps;
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
  const leasingLifecycle = require("./leasing_lifecycle_service")({ pool });

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
    return res.json({ id: o.id, name: o.name, role: o.role, property_id: o.property_id, property_name: propertyName });
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
  // leads   = distinct opportunities by source (leasing_leads.source_id)
  // tours   = of those, leads whose person has a scheduled tour at this property
  // leases  = of those, leads whose status reached 'leased'
  // Rates are computed by the CALLER (the UI), from raw counts — the API ships
  // counts only, so no rounding opinion is baked into the truth. Fail-soft: any
  // error returns [] (the UI simply shows nothing) — never breaks the queue.
  async function sourceConversion(propertyId) {
    try {
      return (await pool.query(
        `select coalesce(ls.name,'(no source)') as source,
                count(ll.id)::int as leads,
                count(ll.id) filter (where exists (
                  select 1 from scheduled_tours st
                   where st.person_id = ll.person_id and st.property_id = ll.property_id
                ))::int as tours,
                count(ll.id) filter (where ll.status = 'leased')::int as leases
           from leasing_leads ll
           left join lead_sources ls on ls.id = ll.source_id
          where ll.property_id = $1
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
  router.get("/operator/leasing/conversations/:conversationId", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      let vitals;
      const client = await pool.connect();
      try {
        const conv = await scopedConversation(client, req.params.conversationId, req.operator.property_id);
        vitals = await prospectVitals(client, { personId: conv.person_id, propertyId: req.operator.property_id });
      } finally { client.release(); }
      const state = await agentService.getConversationStateService({ conversationId: req.params.conversationId });
      // also include this property's facts so the page shows what the agent may use
      const facts = (await pool.query(
        `select id, fact_key, category, rendered_text, source_type, confirmed_at, effective_until, status
           from agent_facts where property_id=$1 and status='active' order by fact_key asc`,
        [req.operator.property_id]
      )).rows;
      return res.json({ ...state, facts, vitals });
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

  const QUEUE_LIMIT = 50;
  const ACTIVE_STATES = ["new", "active"];

  // The proven queue_projection_v1 logic, parameterized by property ($1). One row per
  // ELIGIBLE conversation (open lead, not applied/leased/lost, conversation open).
  const PROJECTION_CTE = `
    with eligible as (
      select c.id as conversation_id, c.property_id, c.person_id, ll.status as lead_status
      from leasing_leads ll
      join conversations c on c.property_id = ll.property_id and c.person_id = ll.person_id
      where ll.status not in ('applied','leased','lost') and c.status = 'open'
        and c.property_id = $1
    ),
    life as (
      select conversation_id,
             max(event_sequence) filter (where event_type='closed_not_fit') as close_seq,
             max(event_sequence) filter (where event_type='reopened')       as reopen_seq
      from leasing_lead_lifecycle_events group by conversation_id
    ),
    close_reason as (
      select distinct on (e.conversation_id) e.conversation_id, e.reason_code
      from leasing_lead_lifecycle_events e where e.event_type='closed_not_fit'
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
    base as (
      select e.conversation_id, e.person_id, e.property_id, e.lead_status,
        pr.name as person_name,
        coalesce(ats.mode,'ai_active') as control_mode,
        qi.at as last_inbound_at, qo.at as last_delivered_outbound_at,
        ao.at as last_any_outbound_at, ao.provider_status as last_outbound_status,
        greatest(coalesce(qi.at,'epoch'::timestamptz), coalesce(ao.at,'epoch'::timestamptz),
                 coalesce(c.last_message_at,'epoch'::timestamptz)) as last_meaningful_activity_at,
        lt.tour_id, lt.tour_status, cr.reason_code as closure_reason,
        (qi.at is not null and (qo.at is null or qi.at >= qo.at)) as inbound_unanswered,
        (li.close_seq is not null and (li.reopen_seq is null or li.reopen_seq < li.close_seq)) as is_closed,
        (lt.conversation_id is not null) as is_booked,
        (qi.at is not null or ao.at is not null) as has_engagement
      from eligible e
      join conversations c on c.id = e.conversation_id
      join persons pr on pr.id = e.person_id
      left join life li on li.conversation_id = e.conversation_id
      left join close_reason cr on cr.conversation_id = e.conversation_id
      left join live_tour lt on lt.conversation_id = e.conversation_id
      left join qual_in qi on qi.conversation_id = e.conversation_id
      left join qual_out qo on qo.conversation_id = e.conversation_id
      left join any_out ao on ao.conversation_id = e.conversation_id
      left join agent_thread_state ats on ats.conversation_id = e.conversation_id
    ),
    projected as (
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
               when last_delivered_outbound_at is not null and (last_inbound_at is null or last_delivered_outbound_at > last_inbound_at) then 'delivered_outreach_is_latest'
               when has_engagement then 'engaged_no_clear_owner'
               else 'open_lead_no_qualifying_engagement' end,
          'projection_version','queue_projection_v2') as derivation
      from base
    )`;

  // GET /operator/leasing/conversation-queue — the ACTIVE WORK QUEUE (working states),
  // cursor-paginated, with server-side counts across ALL commercial states.
  router.get("/operator/leasing/conversation-queue", requireOperator, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const propertyId = req.operator.property_id;
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

      const params = [propertyId, ACTIVE_STATES];
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
               tour_id, tour_status, closure_reason, derivation
        from projected
        -- The active queue is new/active. PLUS [D-7]: a booked tour that has a
        -- new unanswered inbound (waiting_on='manager') surfaces here too — and
        -- ONLY those booked tours, never all of them — so a question asked after
        -- booking is answered before the tour instead of being buried. Its
        -- commercial_state stays 'booked_tour', so the UI renders it as
        -- tour-context ("needs your answer before this tour"), not a fresh lead.
        where (commercial_state = any($2::text[])
               or (commercial_state = 'booked_tour' and waiting_on = 'manager')) ${cursorClause}
        order by last_meaningful_activity_at desc, conversation_id desc
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

      return res.json({
        property_id: propertyId, as_of: asOf, projection_version: "queue_projection_v1",
        counts, sources, today, conversations: rows, next_cursor: nextCursor, limit,
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
  router.get("/operator/leasing/follow-ups", requireOperator, async (req, res) => {
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
  router.get("/operator/leasing/person-card", requireOperator, async (req, res) => {
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
             or exists (select 1 from leasing_conversions where person_id=$1 and property_id=$2)`,
        [personId, propertyId])).rows[0];
      if (!presence) return res.status(404).json({ error: "person not found" }); // no presence here → the name does not leak across the wall

      const userName = async (uid) => {
        if (!uid) return null;
        const u = (await client.query(`select name from users where id=$1`, [uid])).rows[0];
        return u ? u.name : null;
      };
      const entries = [];

      // ── conversation → message entries ─────────────────────────────
      const msgs = (await client.query(
        `select ce.id, ce.direction, ce.sender_role, ce.body, ce.created_at
           from comm_events ce
          where ce.person_id=$1 and ce.property_id=$2
          order by ce.created_at asc limit 200`,
        [personId, propertyId])).rows;
      for (const m of msgs) {
        const who = m.direction === "inbound" ? (p.name || "Prospect") : (m.sender_role || "Property");
        entries.push({
          occurred_at: m.created_at, recorded_at: m.created_at,
          source: "conversation", verb: "sent",
          actor: { id: null, name: who, kind: m.direction === "inbound" ? "person" : "user" },
          summary: `${who} sent: ${String(m.body || "").slice(0, 140)}`,
          claim_strength: "proven",
          detail: { direction: m.direction, body: m.body },
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
      const recent = msgs.slice(-8).map((m) => ({
        direction: m.direction, body: m.body, at: m.created_at,
        who: m.direction === "inbound" ? (p.name || "Prospect") : (m.sender_role || "Property"),
      }));

      return res.json({
        person: { id: p.id, name: p.name },
        property_id: propertyId,
        relationship: { vitals, recent_messages: recent },
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
  router.get("/operator/property/eligible-staff", requireOperator, async (req, res) => {
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
    try {
      const ok = (await pool.query(
        `select 1 from property_team_assignments
          where user_id=$1 and property_id=$2 and active=true
            and 'leasing' = any(allowed_modules) limit 1`,
        [req.operator.id, req.operator.property_id])).rows[0];
      if (!ok) return res.status(403).json({
        error: "leasing-module access required at this property (property_team_assignments.allowed_modules)." });
      return next();
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── TOUR FOLLOW-UPS AND LEASING TASKS — the queue read (contract §6) ──
  // Deterministic order: overdue → due today → upcoming → no due date, then
  // due_at, created_at, id (stable tie-break). Bounded: limit ≤ 200, keyset
  // cursor. A null owner, null due date, or sibling type NEVER hides a row.
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
  router.post("/operator/leasing/conversations/:conversationId/close-not-fit", requireOperator, async (req, res) => {
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
  router.post("/operator/leasing/conversations/:conversationId/reopen", requireOperator, async (req, res) => {
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
  router._internal = { resolveSession, requireOperator, scopedConversation, scopedFact, normalizeFactBody, insertActiveFact, assertDraftInScope, DEMO_MODE, leasingLifecycle };
  return router;
};
