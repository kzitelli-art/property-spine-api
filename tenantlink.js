// ════════════════════════════════════════════════════════════════════
//  TENANT LINK MODULE — tenantlink.js  (the building text line)
//
//  The product sentence: tenants text their building; the system turns
//  messages into the right operating action. Link-only pilot — the
//  browser thread is the first door; SMS becomes the second door into
//  the SAME machinery when a vendor lands. One spine, two doors.
//
//  PHASE 1 — CONNECTION (027):
//    GET  /properties/:propertyId/tenant-communications  — connection board
//    POST /occupants/:personId/phone                     — save/normalize phone
//    POST /occupants/:personId/invite                    — create setup link
//    GET  /t/setup/:token        — tenant-facing PAGE (served HTML)
//    GET  /tenant/setup/:token   — setup state (JSON behind the page)
//    POST /tenant/setup/verify   — link-only verify: typed phone must match
//    GET  /tenant/me             — session-scoped self view
//
//  PHASE 2+3 — MESSAGE LOOP (028):
//    POST /tenant/messages                       — tenant sends a message
//    GET  /tenant/thread                         — tenant reads the thread
//    GET  /properties/:propertyId/inbox          — manager inbox
//    GET  /conversations/:conversationId/messages — manager reads a thread
//    POST /conversations/:conversationId/reply   — manager replies
//
//  THE RULE THIS RUNG ENFORCES: a message can never silently disappear.
//  Every inbound is SAVED FIRST, then classified; classification failure
//  degrades to needs_human, never to a lost message. The inbox shows what
//  the system did with every single message.
//
//  AI boundaries (in code, not vibes):
//    • AI opens work orders (reversible operating objects) and they ALWAYS
//      carry needs_pm_review = true — the human gate.
//    • AI answers balance questions from the LIVE lease — never invents.
//    • AI NEVER books money events. No code path exists for it.
//    • Emergencies + sensitive topics (legal/disputes/habitability) ALWAYS
//      set needs_human — hard regex overrides run BEFORE and AFTER the AI,
//      so the model cannot talk its way past them.
//    • Low confidence (<0.7) or unknown → human queue, honest reply.
//
//  FLAGGED FOLLOW-UP (deliberate, not forgotten): tenant emergencies top
//  the inbox + get the honest 911-caveat reply + open a work order, but do
//  NOT auto-spawn the escalation obligation chain — no on-call notification
//  channel exists yet, and an obligation nobody is told about is activity
//  masquerading as escalation. Wire it when the on-call decision is made.
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");

module.exports = function tenantLinkModule({ pool, anthropic, INGEST_MODEL }) {
  const router = express.Router();

  // ── OPERATOR AUTH (fail-closed) ──────────────────────────────────────
  // The moment outbound tenant messaging existed, these routes stopped
  // being data plumbing — they can speak AS the building and read tenant
  // data. Gate: shared OPERATOR_KEY env var, sent as x-operator-key.
  // No env var set → 503 with instructions, NEVER silently open.
  // Tenant-side routes are untouched: they carry their own invite-token /
  // session auth and never accept an identity parameter.
  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) {
      return res.status(503).json({
        receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header.",
      });
    }
    const got = req.headers["x-operator-key"];
    if (got !== expected) {
      return res.status(401).json({ receipt: "Operator key missing or wrong. Set it in the operator page header." });
    }
    next();
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    return null; // not a US number we can normalize — reject honestly
  }
  function maskPhone(e164) {
    if (!e164 || e164.length < 4) return "***";
    return `(***) ***-${e164.slice(-4)}`;
  }
  const newToken = () => crypto.randomBytes(18).toString("base64url");
  const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "there";
  const theName = (n) => !n ? "the building" : (/^the\s/i.test(n) ? n : "the " + n);

  // Active lease + place for a person at a property (or any property).
  async function placeOf(personId, propertyId) {
    const params = [personId];
    let where = `l.lease_status = 'active' and $1 = any(l.tenant_ids)`;
    if (propertyId) { params.push(propertyId); where += ` and l.property_id = $2`; }
    const r = await pool.query(
      `select l.id as lease_id, l.property_id, l.rent, l.balance,
              l.start_date, l.end_date,
              s.id as space_id, s.space_label,
              u.id as unit_id, u.unit_number,
              p.name as property_name, p.address as property_address,
              p.leasing_basis
         from leases l
         join spaces s on s.id = l.space_id
         join units u  on u.id = s.unit_id
         join properties p on p.id = l.property_id
        where ${where}
        order by l.start_date desc nulls last
        limit 1`, params);
    return r.rows[0] || null;
  }

  async function sessionOf(req) {
    const token = req.headers["x-tenant-session"] || req.query.session;
    if (!token) return null;
    const r = await pool.query(
      `select * from tenant_sessions
        where token = $1 and revoked = false and expires_at > now()`, [token]);
    return r.rows[0] || null;
  }

  // ════════════════════════════════════════════════════════════════════
  //  1. MANAGER CONNECTION BOARD
  // ════════════════════════════════════════════════════════════════════
  router.get("/properties/:propertyId/tenant-communications", requireOperator, async (req, res) => {
    try {
      const { propertyId } = req.params;
      const propQ = await pool.query(
        `select id, name, address, leasing_basis from properties where id = $1`,
        [propertyId]);
      if (!propQ.rows.length) {
        return res.status(404).json({ receipt: "No property with that id." });
      }
      const prop = propQ.rows[0];

      // Occupants = persons on active leases at this property.
      const occQ = await pool.query(
        `select per.id as person_id, per.name, per.phone,
                u.unit_number, s.space_label, l.id as lease_id
           from leases l
           join spaces s on s.id = l.space_id
           join units u  on u.id = s.unit_id
           cross join lateral unnest(l.tenant_ids) as t(pid)
           join persons per on per.id = t.pid
          where l.property_id = $1 and l.lease_status = 'active'
          order by u.unit_number, per.name`, [propertyId]);

      const personIds = occQ.rows.map(r => r.person_id);
      let invites = [], sessions = [];
      if (personIds.length) {
        invites = (await pool.query(
          `select distinct on (person_id) person_id, status, expires_at,
                  created_at, conversation_id
             from tenant_invites
            where property_id = $1 and person_id = any($2)
            order by person_id, created_at desc`,
          [propertyId, personIds])).rows;
        sessions = (await pool.query(
          `select distinct person_id from tenant_sessions
            where property_id = $1 and person_id = any($2)
              and revoked = false and expires_at > now()`,
          [propertyId, personIds])).rows;
      }
      const inviteBy = Object.fromEntries(invites.map(i => [i.person_id, i]));
      const liveSession = new Set(sessions.map(s => s.person_id));

      const tenants = occQ.rows.map(r => {
        const inv = inviteBy[r.person_id];
        let status;
        if (liveSession.has(r.person_id) || (inv && inv.status === "used")) status = "connected";
        else if (!r.phone) status = "missing_phone";
        else if (!inv || ["revoked", "superseded"].includes(inv.status)) status = "not_invited";
        else if (inv.status === "active" && new Date(inv.expires_at) < new Date()) status = "expired";
        else if (inv.status === "active") status = "invited";
        else status = "not_invited";
        return {
          person_id: r.person_id, name: r.name, phone: r.phone,
          unit_number: r.unit_number, space_label: r.space_label,
          lease_id: r.lease_id, connection_status: status,
          last_invited_at: inv ? inv.created_at : null,
          conversation_id: inv ? inv.conversation_id : null,
        };
      });

      const count = (s) => tenants.filter(t => t.connection_status === s).length;
      const summary = {
        total_tenants: tenants.length,
        connected: count("connected"),
        invited: count("invited"),
        missing_phone: count("missing_phone"),
        not_invited: count("not_invited"),
        expired: count("expired"),
      };

      let next = { action: "none", person_id: null, label: "All occupants are connected." };
      const pick = (s, action, verb) => {
        const t = tenants.find(x => x.connection_status === s);
        if (t && next.action === "none") {
          next = { action, person_id: t.person_id, label: `${verb} ${firstName(t.name)} (unit ${t.unit_number}).` };
        }
      };
      pick("missing_phone", "add_phone", "Add a phone for");
      pick("not_invited", "send_invite", "Send a setup link to");
      pick("expired", "send_invite", "Send a fresh link to");
      if (!tenants.length) next = { action: "none", person_id: null, label: "No occupants on active leases yet — link tenants to leases first." };

      res.json({
        receipt: tenants.length
          ? `${summary.connected} of ${summary.total_tenants} occupants connected at ${prop.name || prop.address}.`
          : `No occupants on active leases at ${prop.name || prop.address}.`,
        property: { id: prop.id, name: prop.name, address: prop.address, leasing_basis: prop.leasing_basis },
        summary, next, tenants,
      });
    } catch (e) {
      console.error("tenant-communications:", e);
      res.status(500).json({ receipt: "Could not load the connection board.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  2. SAVE / FIX PHONE
  // ════════════════════════════════════════════════════════════════════
  router.post("/occupants/:personId/phone", requireOperator, async (req, res) => {
    try {
      const { personId } = req.params;
      const phone = normalizePhone(req.body && req.body.phone);
      if (!phone) {
        return res.status(400).json({
          receipt: "That doesn't look like a valid US phone number. Use 10 digits, like 215-555-1212.",
        });
      }
      const r = await pool.query(
        `update persons set phone = $1, updated_at = now()
          where id = $2 returning id, name`, [phone, personId]);
      if (!r.rows.length) return res.status(404).json({ receipt: "No person with that id." });
      const place = await placeOf(personId, null);
      res.json({
        receipt: `Phone saved for ${firstName(r.rows[0].name)}${place ? ` in unit ${place.unit_number}` : ""}.`,
        person_id: personId, phone,
      });
    } catch (e) {
      console.error("occupant phone:", e);
      res.status(500).json({ receipt: "Could not save the phone.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  3. CREATE SETUP LINK (supersedes old active links; opens the thread)
  // ════════════════════════════════════════════════════════════════════
  router.post("/occupants/:personId/invite", requireOperator, async (req, res) => {
    try {
      const { personId } = req.params;
      const propertyId = req.body && req.body.property_id;
      if (!propertyId) return res.status(400).json({ receipt: "property_id is required." });

      const perQ = await pool.query(`select id, name, phone from persons where id = $1`, [personId]);
      if (!perQ.rows.length) return res.status(404).json({ receipt: "No person with that id." });
      const person = perQ.rows[0];
      if (!person.phone) {
        return res.status(409).json({
          receipt: `Add a phone for ${firstName(person.name)} first — the setup link verifies against it.`,
          fix: "add_phone",
        });
      }
      const place = await placeOf(personId, propertyId);
      if (!place) {
        return res.status(409).json({
          receipt: `${firstName(person.name)} isn't on an active lease at this property — link them to a lease first.`,
        });
      }

      // One conversation per (property, person). The invite is message #1.
      const convo = (await pool.query(
        `insert into conversations (property_id, person_id, unit_id, lease_id)
         values ($1, $2, $3, $4)
         on conflict (property_id, person_id)
         do update set unit_id = excluded.unit_id, lease_id = excluded.lease_id
         returning id`,
        [propertyId, personId, place.unit_id, place.lease_id])).rows[0];

      // Supersede any still-active links — never two live links for one person.
      const token = newToken();
      const inv = (await pool.query(
        `insert into tenant_invites (person_id, property_id, conversation_id, token, expires_at)
         values ($1, $2, $3, $4, now() + interval '7 days')
         returning id, expires_at`,
        [personId, propertyId, convo.id, token])).rows[0];
      await pool.query(
        `update tenant_invites
            set status = 'superseded', superseded_by = $1
          where person_id = $2 and property_id = $3
            and status = 'active' and id <> $1`,
        [inv.id, personId, propertyId]);

      const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const link = `${base}/t/setup/${token}`;
      const propName = place.property_name || place.property_address || "your building";
      const theProp = /^the\s/i.test(propName) ? propName : `the ${propName}`;
      const sms_text =
        `Hi ${firstName(person.name)} — this is ${theProp} tenant line. ` +
        `Save this number for rent, maintenance, and building questions. ` +
        `Set up your secure link here: ${link}`;

      // Message #1 of the official thread.
      const msg = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id,
                                  channel, direction, body)
         values ($1, $2, $3, $4, 'text', 'outbound', $5)
         returning id`,
        [propertyId, personId, place.unit_id, convo.id, sms_text])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [convo.id]);

      res.json({
        receipt: `Setup link created for ${firstName(person.name)} in unit ${place.unit_number}. Copy the text below and send it from your phone.`,
        person_id: personId, conversation_id: convo.id, invite_id: inv.id,
        link, sms_text, expires_at: inv.expires_at, first_message_id: msg.id,
      });
    } catch (e) {
      console.error("invite:", e);
      res.status(500).json({ receipt: "Could not create the setup link.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  4. SETUP STATE (JSON behind the tenant page)
  // ════════════════════════════════════════════════════════════════════
  async function loadInvite(token) {
    const r = await pool.query(
      `select i.*, per.name as person_name, per.phone as person_phone,
              p.name as property_name, p.address as property_address
         from tenant_invites i
         join persons per on per.id = i.person_id
         join properties p on p.id = i.property_id
        where i.token = $1`, [token]);
    return r.rows[0] || null;
  }
  function inviteState(inv) {
    if (!inv) return "invalid";
    if (inv.status === "used") return "already_verified";
    if (inv.status === "revoked" || inv.status === "superseded") return "revoked";
    if (inv.status === "active" && new Date(inv.expires_at) < new Date()) return "expired";
    return "valid";
  }

  router.get("/tenant/setup/:token", async (req, res) => {
    try {
      const inv = await loadInvite(req.params.token);
      const status = inviteState(inv);
      if (status !== "valid" && status !== "already_verified") {
        return res.json({
          status,
          message: status === "invalid"
            ? "This link isn't recognized."
            : "This link expired or was replaced. Ask your manager for a fresh link.",
        });
      }
      const place = await placeOf(inv.person_id, inv.property_id);
      res.json({
        status,
        property: { name: inv.property_name || inv.property_address },
        tenant: { first_name: firstName(inv.person_name), unit_number: place ? place.unit_number : null },
        message: status === "already_verified"
          ? "You're already connected. Verify your phone again to open your thread."
          : `Confirm your phone to connect to ${theName(inv.property_name)} tenant line.`,
      });
    } catch (e) {
      console.error("setup state:", e);
      res.status(500).json({ status: "error", message: "Could not load this link." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  5. LINK-ONLY VERIFY — typed phone must match the record
  //     (OTP step slots in here when an SMS vendor lands.)
  // ════════════════════════════════════════════════════════════════════
  router.post("/tenant/setup/verify", async (req, res) => {
    try {
      const { token } = req.body || {};
      const typed = normalizePhone(req.body && req.body.phone);
      const inv = await loadInvite(token);
      const status = inviteState(inv);
      if (status === "invalid") return res.status(404).json({ receipt: "This link isn't recognized." });
      if (status === "expired" || status === "revoked") {
        return res.status(410).json({ receipt: "This link expired or was replaced. Ask your manager for a fresh link." });
      }
      if (!typed) {
        return res.status(400).json({ receipt: "That doesn't look like a valid phone number. Use 10 digits." });
      }
      if (typed !== inv.person_phone) {
        const attempts = inv.failed_attempts + 1;
        if (attempts >= 5) {
          await pool.query(`update tenant_invites set failed_attempts=$1, status='revoked' where id=$2`,
            [attempts, inv.id]);
          return res.status(401).json({ receipt: "Too many attempts — this link is now locked. Ask your manager for a fresh one." });
        }
        await pool.query(`update tenant_invites set failed_attempts=$1 where id=$2`, [attempts, inv.id]);
        return res.status(401).json({ receipt: "That phone does not match this invite." });
      }

      // Match — connect. Mark used (idempotent for already_verified re-entry),
      // issue a 30-day session, log the connection on the thread.
      await pool.query(
        `update tenant_invites set status='used', used_at = coalesce(used_at, now()) where id = $1`,
        [inv.id]);
      const sess = (await pool.query(
        `insert into tenant_sessions (person_id, property_id, token, expires_at)
         values ($1, $2, $3, now() + interval '30 days') returning token`,
        [inv.person_id, inv.property_id, newToken()])).rows[0];
      const place = await placeOf(inv.person_id, inv.property_id);
      await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification)
         values ($1, $2, $3, $4, 'portal', 'inbound', $5, 'general')`,
        [inv.property_id, inv.person_id, place ? place.unit_id : null, inv.conversation_id,
         `${firstName(inv.person_name)} verified their phone and connected.`]);

      res.json({
        receipt: `${firstName(inv.person_name)} is connected to ${theName(inv.property_name)} tenant line.`,
        session: sess.token,
        tenant: {
          person_id: inv.person_id, property_id: inv.property_id,
          unit_id: place ? place.unit_id : null, lease_id: place ? place.lease_id : null,
          conversation_id: inv.conversation_id,
        },
      });
    } catch (e) {
      console.error("verify:", e);
      res.status(500).json({ receipt: "Verification hit an error. Try again." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  6. TENANT SELF VIEW — session-scoped, own data ONLY
  // ════════════════════════════════════════════════════════════════════
  router.get("/tenant/me", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });

      const perQ = await pool.query(`select name, phone from persons where id = $1`, [sess.person_id]);
      const place = await placeOf(sess.person_id, sess.property_id);
      if (!place) return res.status(404).json({ receipt: "No active lease found for your account. Contact your manager." });

      const ledger = (await pool.query(
        `select label, kind, amount, occurred_at from ledger_entries
          where lease_id = $1 order by occurred_at desc limit 10`, [place.lease_id])).rows;
      const workOrders = (await pool.query(
        `select id, title, issue_type, description, status, created_at
           from work_orders
          where person_id = $1 and property_id = $2 and status <> 'complete'
          order by created_at desc`, [sess.person_id, sess.property_id])).rows;

      res.json({
        receipt: `Here's your place, ${firstName(perQ.rows[0].name)}.`,
        tenant: { name: perQ.rows[0].name, phone: maskPhone(perQ.rows[0].phone) },
        property: { name: place.property_name, address: place.property_address },
        place: {
          unit_number: place.unit_number, space_label: place.space_label,
          leasing_basis: place.leasing_basis,
          lease_start: place.start_date, lease_end: place.end_date,
          rent_amount: place.rent == null ? null : Number(place.rent),
        },
        balance: { current_balance: place.balance == null ? null : Number(place.balance), ledger },
        open_work_orders: workOrders,
      });
    } catch (e) {
      console.error("tenant/me:", e);
      res.status(500).json({ receipt: "Could not load your view." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 2 — CLASSIFICATION
  //  Hard overrides run before AND after the AI. The model suggests;
  //  the code decides what it's allowed to do.
  // ════════════════════════════════════════════════════════════════════
  const FIELD_CATEGORIES = ["plumbing","electric","heat_ac","appliance","lock_key",
                            "pest","paint_walls","internet","noise","cleaning","other"];
  const EMERGENCY_RX = /\b(fire|smoke|gas leak|smell gas|smells? like gas|carbon monoxide|water (pouring|gushing)|flood(ing)?|sewage|sewer back|sparking|burst pipe|broke(n)? in|break.?in|no heat)\b/i;
  const SENSITIVE_RX = /\b(evict|lawyer|attorney|legal action|sue|suing|court|harass|discriminat|unsafe|uninhabitable|habitab|mold|lead paint|withhold(ing)? rent|dispute)\b/i;

  const CLASSIFY_PROMPT =
`You classify ONE tenant message for a property operating system. Respond with ONLY a JSON object, no markdown, no preamble:
{"classification":"maintenance|balance|document|lease_question|emergency|general|unknown",
"field_category":"plumbing|electric|heat_ac|appliance|lock_key|pest|paint_walls|internet|noise|cleaning|other",
"urgency":"normal|high|emergency",
"confidence":0.0,
"needs_human":false,
"summary":"one short line describing the issue",
"suggested_title":"3-6 word work order title"}
Rules: classification "emergency" only for active danger or major damage in progress (fire, gas, flooding, sewage, electrical hazard, security breach, no heat in cold weather). Legal threats, payment disputes, anger, harassment, habitability claims => needs_human true. If you are not sure what the tenant wants => classification "unknown", needs_human true. confidence is YOUR honest certainty 0-1.`;

  async function classifyMessage(body) {
    const hardEmergency = EMERGENCY_RX.test(body);
    const hardSensitive = SENSITIVE_RX.test(body);
    let ai = null;
    if (anthropic) {
      try {
        const resp = await anthropic.messages.create({
          model: INGEST_MODEL || "claude-sonnet-4-6",
          max_tokens: 300,
          messages: [{ role: "user", content: CLASSIFY_PROMPT + "\n\nTenant message:\n" + String(body).slice(0, 2000) }],
        });
        const text = (resp.content || []).filter(c => c.type === "text").map(c => c.text).join("");
        ai = JSON.parse(text.replace(/```json|```/g, "").trim());
      } catch (e) {
        console.error("classify AI failed (degrading to human queue):", e.message);
        ai = null; // fail-soft: the message is already saved; it goes to a human
      }
    }
    // Merge: hard overrides beat the model, both directions.
    const out = {
      classification: ai ? ai.classification : "unknown",
      field_category: ai && FIELD_CATEGORIES.includes(ai.field_category) ? ai.field_category : "other",
      urgency: ai ? ai.urgency : "normal",
      confidence: ai && typeof ai.confidence === "number" ? ai.confidence : 0,
      needs_human: ai ? !!ai.needs_human : true,
      summary: ai && ai.summary ? String(ai.summary).slice(0, 200) : null,
      suggested_title: ai && ai.suggested_title ? String(ai.suggested_title).slice(0, 80) : null,
    };
    if (hardEmergency) {
      out.classification = "emergency"; out.urgency = "emergency"; out.needs_human = true;
      // AI down or vague? Infer the trade from the words — honest, keyword-derived.
      if (out.field_category === "other") {
        if (/water|flood|pipe|sewage|sewer|leak|toilet/i.test(body)) out.field_category = "plumbing";
        else if (/spark|electrical|outlet|wires?\b/i.test(body)) out.field_category = "electric";
        else if (/no heat|heat\b|furnace|boiler/i.test(body)) out.field_category = "heat_ac";
        else if (/break.?in|broke(n)? in|door|lock/i.test(body)) out.field_category = "lock_key";
      }
    }
    if (hardSensitive) { out.needs_human = true; }
    if (out.classification === "emergency") out.needs_human = true; // AI-called emergencies too
    return out;
  }

  // ════════════════════════════════════════════════════════════════════
  //  7. TENANT SENDS A MESSAGE — saved first, then classified, then acted
  // ════════════════════════════════════════════════════════════════════
  router.post("/tenant/messages", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const body = (req.body && req.body.body || "").trim();
      if (!body) return res.status(400).json({ receipt: "Type a message first." });
      if (body.length > 4000) return res.status(400).json({ receipt: "That message is too long — keep it under 4000 characters." });

      const place = await placeOf(sess.person_id, sess.property_id);
      const convo = (await pool.query(
        `insert into conversations (property_id, person_id, unit_id, lease_id)
         values ($1,$2,$3,$4)
         on conflict (property_id, person_id) do update set last_message_at = now()
         returning id`,
        [sess.property_id, sess.person_id, place ? place.unit_id : null, place ? place.lease_id : null])).rows[0];

      // ① SAVE FIRST. Whatever happens after this, the message exists.
      const inbound = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body)
         values ($1,$2,$3,$4,'portal','inbound',$5) returning id`,
        [sess.property_id, sess.person_id, place ? place.unit_id : null, convo.id, body])).rows[0];

      // ② Classify (fail-soft to human queue).
      const c = await classifyMessage(body);

      // ③ Act — the matrix. AI may open work orders (needs_pm_review always
      //    true) and answer balance from the live lease. Nothing else.
      let createdType = null, createdId = null, reply;
      const unitLabel = place ? `Unit ${place.unit_number}` : "your unit";

      if (c.classification === "emergency") {
        const wo = (await pool.query(
          `insert into work_orders (property_id, unit_id, person_id, title, description,
                                    status, source, field_category, operating_category, gl_category,
                                    needs_pm_review)
           values ($1,$2,$3,$4,$5,'open','tenant',$6,'resident_repair',$7,true) returning id`,
          [sess.property_id, place ? place.unit_id : null, sess.person_id,
           "EMERGENCY: " + (c.suggested_title || c.field_category || "tenant report"),
           body, c.field_category, `${c.field_category}_repairs`])).rows[0];
        createdType = "work_order"; createdId = wo.id;
        reply = "Emergency received — management has been notified in the system. If there is immediate danger to anyone, call 911 first.";
      } else if (c.classification === "maintenance" && c.confidence >= 0.7 && !c.needs_human) {
        const wo = (await pool.query(
          `insert into work_orders (property_id, unit_id, person_id, title, description,
                                    status, source, field_category, operating_category, gl_category,
                                    needs_pm_review)
           values ($1,$2,$3,$4,$5,'open','tenant',$6,'resident_repair',$7,true) returning id`,
          [sess.property_id, place ? place.unit_id : null, sess.person_id,
           c.suggested_title || `${c.field_category} request`,
           body, c.field_category, `${c.field_category}_repairs`])).rows[0];
        createdType = "work_order"; createdId = wo.id;
        reply = `Got it — ${c.field_category.replace("_", "/")} request opened for ${unitLabel}. We'll keep you updated right here.`;
      } else if (c.classification === "balance" && c.confidence >= 0.7 && !c.needs_human && place) {
        createdType = "balance_inquiry";
        const bal = place.balance == null ? null : Number(place.balance);
        reply = bal == null
          ? "Your balance isn't loaded in the system yet — your manager will confirm it here."
          : bal <= 0
            ? `You're all paid up — current balance $${bal.toFixed(2)}.${place.rent ? ` Rent is $${Number(place.rent).toFixed(2)}/month.` : ""}`
            : `Your current balance is $${bal.toFixed(2)}.${place.rent ? ` Rent is $${Number(place.rent).toFixed(2)}/month.` : ""}`;
      } else {
        // document / lease_question / general / unknown / low confidence /
        // sensitive — the honest human queue. No pretending.
        c.needs_human = true;
        reply = "Got it — your manager will follow up with you right here.";
      }

      // ④ Record what the system did ON the inbound message (the audit).
      await pool.query(
        `update comm_events set classification=$1, created_object_type=$2,
                created_object_id=$3, needs_human=$4, ai_summary=$5 where id=$6`,
        [c.classification, createdType, createdId, c.needs_human, c.summary, inbound.id]);

      // ⑤ Reply on the same thread.
      const out = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification)
         values ($1,$2,$3,$4,'portal','outbound',$5,'auto_reply') returning id, occurred_at`,
        [sess.property_id, sess.person_id, place ? place.unit_id : null, convo.id, reply])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [convo.id]);

      res.json({
        receipt: reply,
        message_id: inbound.id, reply_id: out.id, conversation_id: convo.id,
        classification: c.classification, confidence: c.confidence,
        created_object_type: createdType, created_object_id: createdId,
        needs_human: c.needs_human,
      });
    } catch (e) {
      console.error("tenant message:", e);
      res.status(500).json({ receipt: "Your message hit an error — try sending it again." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  8. TENANT READS THE THREAD
  // ════════════════════════════════════════════════════════════════════
  router.get("/tenant/thread", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const convoQ = await pool.query(
        `select id from conversations where property_id=$1 and person_id=$2`,
        [sess.property_id, sess.person_id]);
      if (!convoQ.rows.length) return res.json({ messages: [] });
      const msgs = (await pool.query(
        `select id, direction, body, classification, created_object_type, occurred_at
           from comm_events where conversation_id = $1
          order by occurred_at asc limit 200`, [convoQ.rows[0].id])).rows;
      res.json({ conversation_id: convoQ.rows[0].id, messages: msgs });
    } catch (e) {
      console.error("tenant thread:", e);
      res.status(500).json({ receipt: "Could not load your thread." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  9. MANAGER INBOX — what came in, what the system did, who needs a human
  // ════════════════════════════════════════════════════════════════════
  router.get("/properties/:propertyId/inbox", requireOperator, async (req, res) => {
    try {
      const { propertyId } = req.params;
      const items = (await pool.query(
        `select ce.id as message_id, ce.conversation_id, ce.body, ce.classification,
                ce.created_object_type, ce.created_object_id, ce.needs_human,
                ce.ai_summary, ce.occurred_at,
                per.name as person_name, u.unit_number
           from comm_events ce
           left join persons per on per.id = ce.person_id
           left join units u on u.id = ce.unit_id
          where ce.property_id = $1 and ce.direction = 'inbound'
            and ce.conversation_id is not null
          order by ce.needs_human desc, ce.occurred_at desc
          limit 100`, [propertyId])).rows;
      const humanCount = items.filter(i => i.needs_human).length;
      res.json({
        receipt: items.length
          ? `${items.length} inbound message${items.length === 1 ? "" : "s"} · ${humanCount} need${humanCount === 1 ? "s" : ""} a human.`
          : "No tenant messages yet.",
        needs_human_count: humanCount,
        items,
      });
    } catch (e) {
      console.error("inbox:", e);
      res.status(500).json({ receipt: "Could not load the inbox.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  9B. MANAGER READS A CONVERSATION — the level-3 detail view's read.
  //  The inbox shows inbound messages; THIS shows the whole thread, both
  //  directions, oldest-first — same field names the tenant thread and
  //  inbox already use (one vocabulary per object, never two).
  //  READ-ONLY: does not clear needs_human — replying does that already.
  // ════════════════════════════════════════════════════════════════════
  router.get("/conversations/:conversationId/messages", requireOperator, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const convoQ = await pool.query(
        `select c.id, c.property_id, c.unit_id, c.status, c.last_message_at,
                per.name as person_name, u.unit_number
           from conversations c
           left join persons per on per.id = c.person_id
           left join units u on u.id = c.unit_id
          where c.id = $1`, [conversationId]);
      if (!convoQ.rows.length) return res.status(404).json({ receipt: "No conversation with that id." });
      const convo = convoQ.rows[0];
      const messages = (await pool.query(
        `select id, direction, channel, body, classification,
                created_object_type, created_object_id, needs_human, occurred_at
           from comm_events
          where conversation_id = $1
          order by occurred_at asc, id asc
          limit 500`, [conversationId])).rows;
      const humanCount = messages.filter(m => m.needs_human).length;
      res.json({
        receipt: `Conversation with ${convo.person_name || "unknown person"}${convo.unit_number ? ` in unit ${convo.unit_number}` : ""} · ${messages.length} message${messages.length === 1 ? "" : "s"}${humanCount ? ` · ${humanCount} still need${humanCount === 1 ? "s" : ""} a human` : ""}.`,
        conversation: {
          id: convo.id,
          person_name: convo.person_name,
          unit_number: convo.unit_number,
          property_id: convo.property_id,
          status: convo.status,
          last_message_at: convo.last_message_at,
        },
        messages,
      });
    } catch (e) {
      console.error("conversation messages:", e);
      res.status(500).json({ receipt: "Could not load the conversation.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  10. MANAGER REPLIES — same thread, the tenant sees it
  // ════════════════════════════════════════════════════════════════════
  router.post("/conversations/:conversationId/reply", requireOperator, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const body = (req.body && req.body.body || "").trim();
      if (!body) return res.status(400).json({ receipt: "Type a reply first." });
      const convoQ = await pool.query(
        `select c.*, per.name as person_name, u.unit_number
           from conversations c
           left join persons per on per.id = c.person_id
           left join units u on u.id = c.unit_id
          where c.id = $1`, [conversationId]);
      if (!convoQ.rows.length) return res.status(404).json({ receipt: "No conversation with that id." });
      const convo = convoQ.rows[0];
      const out = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification)
         values ($1,$2,$3,$4,'portal','outbound',$5,'manager_reply') returning id`,
        [convo.property_id, convo.person_id, convo.unit_id, conversationId, body])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [conversationId]);
      // Replying IS handling it — clear the human flag on this thread's inbounds.
      await pool.query(
        `update comm_events set needs_human = false
          where conversation_id = $1 and direction = 'inbound' and needs_human = true`,
        [conversationId]);
      res.json({
        receipt: `Message sent to ${firstName(convo.person_name)}${convo.unit_number ? ` in unit ${convo.unit_number}` : ""}.`,
        message_id: out.id,
      });
    } catch (e) {
      console.error("reply:", e);
      res.status(500).json({ receipt: "Could not send the reply.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  11. WORK ORDER STATUS → TENANT NOTIFIED ON THE THREAD
  //  The communication half of a status change. Allowed transitions here:
  //  'scheduled' and back to 'open'. 'complete' is REFUSED — completion
  //  belongs to maintenance's closeout proof gate (PATCH /work-orders/:id/
  //  closeout); this route will not be a side door around the proof.
  //  A note ALWAYS posts to the reporting tenant's conversation.
  // ════════════════════════════════════════════════════════════════════
  router.post("/work-orders/:workOrderId/notify-status", requireOperator, async (req, res) => {
    try {
      const { workOrderId } = req.params;
      const status = req.body && req.body.status;
      const note = (req.body && req.body.note_to_tenant || "").trim();
      if (!note) return res.status(400).json({ receipt: "Write the note to the tenant — that's the point of this action." });
      if (status === "complete") {
        return res.status(409).json({
          receipt: "Completion goes through the closeout proof gate, not here. Use the maintenance closeout (it requires a completion note), then send the tenant a reply from the inbox.",
        });
      }
      if (status && !["open", "scheduled"].includes(status)) {
        return res.status(400).json({ receipt: "Status here can only be 'scheduled' or 'open'. Completion has its own gate." });
      }

      const woQ = await pool.query(
        `select w.*, per.name as person_name, u.unit_number
           from work_orders w
           left join persons per on per.id = w.person_id
           left join units u on u.id = w.unit_id
          where w.id = $1`, [workOrderId]);
      if (!woQ.rows.length) return res.status(404).json({ receipt: "No work order with that id." });
      const wo = woQ.rows[0];
      if (!wo.person_id) {
        return res.status(409).json({ receipt: "This work order has no reporting tenant attached — there's nobody to notify." });
      }
      const convoQ = await pool.query(
        `select id from conversations where property_id = $1 and person_id = $2`,
        [wo.property_id, wo.person_id]);
      if (!convoQ.rows.length) {
        return res.status(409).json({ receipt: "That tenant isn't connected to the tenant line yet — send them a setup link first." });
      }

      if (status && status !== wo.status) {
        await pool.query(`update work_orders set status=$1, updated_at=now() where id=$2`, [status, workOrderId]);
      }
      await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification)
         values ($1,$2,$3,$4,'portal','outbound',$5,'work_order_update')`,
        [wo.property_id, wo.person_id, wo.unit_id, convoQ.rows[0].id, note]);
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [convoQ.rows[0].id]);

      res.json({
        receipt: `Work order ${status && status !== wo.status ? `marked ${status} ` : ""}and ${firstName(wo.person_name)} was notified${wo.unit_number ? ` (unit ${wo.unit_number})` : ""}.`,
        work_order: { id: workOrderId, status: status || wo.status },
      });
    } catch (e) {
      console.error("notify-status:", e);
      res.status(500).json({ receipt: "Could not update and notify.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  THE TENANT PAGE — served by the API itself (link-only pilot needs
  //  zero hosting). Brand system: Fraunces + IBM Plex on the dark palette.
  //  After connecting, the THREAD is the product; "My place" is the tab.
  // ════════════════════════════════════════════════════════════════════
  router.get("/t/setup/:token", (req, res) => {
    const token = String(req.params.token).replace(/[^A-Za-z0-9_-]/g, "");
    res.set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Tenant Line</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
:root{--bg:#0e1116;--panel:#161a21;--panel2:#1c212b;--line:#262c38;--ink:#e7e4dd;--ink-dim:#9aa0ab;--ink-faint:#5f6672;
--accent:#d4a056;--confirmed:#6fae7e;--danger:#c97a6d;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',sans-serif;line-height:1.5;
display:flex;justify-content:center;padding:20px 14px 40px;-webkit-font-smoothing:antialiased}
.wrap{width:100%;max-width:440px}
.serif{font-family:'Fraunces',serif}
.card{background:linear-gradient(180deg,var(--panel),#13171e);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:12px}
.kicker{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
h1{font-family:'Fraunces',serif;font-size:21px;font-weight:600;margin-bottom:4px}
.sub{color:var(--ink-dim);font-size:14px}
.lbl{display:block;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin:14px 0 6px}
input,textarea{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--ink);padding:12px;border-radius:8px;font-size:16px;font-family:inherit;outline:none;resize:none}
input:focus,textarea:focus{border-color:var(--accent)}
.btn{background:var(--accent);color:#1a1407;border:none;padding:12px 16px;border-radius:8px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer}
.btn:disabled{opacity:.5}.btn.full{width:100%;margin-top:14px}
.receipt{margin-top:12px;font-size:14px;padding:11px 13px;border-radius:8px;border:1px solid var(--line);display:none}
.receipt.ok{display:block;color:var(--confirmed);border-color:#2c4536;background:#1a2a20}
.receipt.bad{display:block;color:var(--danger);border-color:#4a2e29;background:#241a18}
.tabs{display:flex;gap:6px;margin-bottom:12px}
.tabs button{flex:1;padding:9px;font-size:13px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink-dim);font-family:inherit;cursor:pointer}
.tabs button.active{border-color:var(--accent);color:var(--ink);background:var(--panel2)}
.thread{display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow-y:auto;padding:4px 2px}
.msg{max-width:85%;padding:10px 13px;border-radius:12px;font-size:14px;word-break:break-word}
.msg.in{align-self:flex-end;background:#2a2417;border:1px solid #473a1f}
.msg.out{align-self:flex-start;background:var(--panel2);border:1px solid var(--line)}
.msg .t{display:block;font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--ink-faint);margin-top:4px}
.composer{display:flex;gap:8px;margin-top:10px}
.composer textarea{height:48px}
.row{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid #1e232d;font-size:14px}
.row:last-child{border-bottom:none}
.row .k{color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;font-size:12px}
.section{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-faint);margin:16px 0 6px}
.bal{font-family:'Fraunces',serif;font-size:32px;font-weight:600}
.hidden{display:none}
</style></head><body><div class="wrap">
<div class="kicker">Tenant Line</div>
<div id="loading" class="card"><div class="sub">Loading…</div></div>

<div id="setup" class="card hidden">
  <h1 id="su-title" class="serif">Confirm your phone</h1>
  <div class="sub" id="su-msg"></div>
  <label class="lbl">Your mobile number</label>
  <input id="su-phone" type="tel" inputmode="tel" placeholder="215-555-1212" autocomplete="tel"/>
  <button class="btn full" id="su-go">Connect</button>
  <div class="receipt" id="su-receipt"></div>
</div>

<div id="dead" class="card hidden">
  <h1 class="serif">This link isn't usable</h1>
  <div class="sub" id="dead-msg"></div>
</div>

<div id="home" class="hidden">
  <div class="card" style="padding:14px 18px">
    <h1 class="serif" id="h-prop" style="font-size:18px"></h1>
    <div class="sub" id="h-unit" style="font-size:13px"></div>
  </div>
  <div class="tabs">
    <button id="tab-thread" class="active" onclick="showTab('thread')">Messages</button>
    <button id="tab-place" onclick="showTab('place')">My place</button>
  </div>

  <div id="pane-thread" class="card">
    <div class="thread" id="thread"></div>
    <div class="composer">
      <textarea id="compose" placeholder="Maintenance, rent, questions — type it here"></textarea>
      <button class="btn" id="send" onclick="sendMsg()">Send</button>
    </div>
    <div class="receipt" id="t-receipt"></div>
  </div>

  <div id="pane-place" class="card hidden">
    <div class="section" style="margin-top:0">Balance</div>
    <div class="bal" id="me-bal"></div>
    <div class="sub" id="me-rent"></div>
    <div class="section">Lease</div>
    <div class="row"><span class="k">start</span><span id="me-start"></span></div>
    <div class="row"><span class="k">end</span><span id="me-end"></span></div>
    <div class="section">Open maintenance</div>
    <div id="me-wos" class="sub"></div>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
const SKEY = "ps_tenant_session";
const $ = id => document.getElementById(id);
const money = v => v==null ? "—" : "$" + Number(v).toLocaleString(undefined,{minimumFractionDigits:2});
const day = v => v ? new Date(v).toLocaleDateString() : "—";
const when = v => new Date(v).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
let SESSION = null, pollTimer = null;
function show(id){["loading","setup","dead","home"].forEach(x=>$(x).classList.add("hidden"));$(id).classList.remove("hidden");}
function showTab(t){
  $("pane-thread").classList.toggle("hidden", t!=="thread");
  $("pane-place").classList.toggle("hidden", t!=="place");
  $("tab-thread").classList.toggle("active", t==="thread");
  $("tab-place").classList.toggle("active", t==="place");
}
function receipt(el,msg,ok){const e=$(el);e.className="receipt "+(ok?"ok":"bad");e.textContent=msg;setTimeout(()=>{e.className="receipt"},6000);}

async function init(){
  // Returning tenant with a live session skips setup entirely.
  const saved = localStorage.getItem(SKEY);
  if (saved) {
    const r = await fetch("/tenant/me",{headers:{"x-tenant-session":saved}}).catch(()=>null);
    if (r && r.ok) { SESSION = saved; return enterHome(await r.json()); }
    localStorage.removeItem(SKEY);
  }
  try{
    const r = await fetch("/tenant/setup/"+TOKEN); const d = await r.json();
    if(d.status==="valid"||d.status==="already_verified"){
      $("su-title").textContent = "Hi "+(d.tenant&&d.tenant.first_name||"there")+" 👋";
      $("su-msg").textContent = d.message;
      show("setup");
    } else { $("dead-msg").textContent = d.message||"Ask your manager for a fresh link."; show("dead"); }
  }catch(e){ $("dead-msg").textContent="Could not load this link. Check your connection."; show("dead"); }
}

$("su-go").onclick = async ()=>{
  const btn=$("su-go"); btn.disabled=true; btn.textContent="Connecting…";
  try{
    const r = await fetch("/tenant/setup/verify",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:TOKEN, phone:$("su-phone").value})});
    const d = await r.json();
    if(r.ok && d.session){
      SESSION = d.session; localStorage.setItem(SKEY, SESSION);
      const me = await fetch("/tenant/me",{headers:{"x-tenant-session":SESSION}});
      if (me.ok) enterHome(await me.json());
    } else receipt("su-receipt", d.receipt||"That didn't work.", false);
  }catch(e){ receipt("su-receipt","Connection problem — try again.",false); }
  btn.disabled=false; btn.textContent="Connect";
};

function enterHome(me){
  $("h-prop").textContent = me.property.name || me.property.address;
  $("h-unit").textContent = "Unit "+me.place.unit_number + (me.place.leasing_basis==="bed" && me.place.space_label ? " · "+me.place.space_label : "");
  $("me-bal").textContent = money(me.balance.current_balance);
  $("me-rent").textContent = me.place.rent_amount!=null ? "Rent "+money(me.place.rent_amount)+" / month" : "";
  $("me-start").textContent = day(me.place.lease_start);
  $("me-end").textContent = day(me.place.lease_end);
  renderWos(me.open_work_orders);
  show("home"); loadThread();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadThread, 15000);
}
function renderWos(wos){
  $("me-wos").innerHTML = wos && wos.length
    ? wos.map(w=>'<div class="row"><span>'+(w.title||w.issue_type||"request")+'</span><span class="k">'+w.status+'</span></div>').join("")
    : "No open requests.";
}
async function loadThread(){
  const r = await fetch("/tenant/thread",{headers:{"x-tenant-session":SESSION}}).catch(()=>null);
  if(!r||!r.ok) return;
  const d = await r.json();
  const el = $("thread");
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = (d.messages||[]).map(m=>
    '<div class="msg '+(m.direction==="inbound"?"in":"out")+'">'+escapeHtml(m.body||"")+
    '<span class="t">'+when(m.occurred_at)+'</span></div>').join("")
    || '<div class="sub">No messages yet — say hi, report an issue, or ask about your balance.</div>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function escapeHtml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
async function sendMsg(){
  const body = $("compose").value.trim(); if(!body) return;
  const btn=$("send"); btn.disabled=true;
  try{
    const r = await fetch("/tenant/messages",{method:"POST",
      headers:{"Content-Type":"application/json","x-tenant-session":SESSION},
      body:JSON.stringify({body})});
    const d = await r.json();
    if(r.ok){ $("compose").value=""; await loadThread(); $("thread").scrollTop=$("thread").scrollHeight;
      const me = await fetch("/tenant/me",{headers:{"x-tenant-session":SESSION}});
      if (me.ok) renderWos((await me.json()).open_work_orders);
    } else receipt("t-receipt", d.receipt||"Could not send.", false);
  }catch(e){ receipt("t-receipt","Connection problem — try again.",false); }
  btn.disabled=false;
}
init();
</script></div></body></html>`);
  });

  return router;
};
