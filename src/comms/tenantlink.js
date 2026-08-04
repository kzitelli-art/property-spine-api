// ════════════════════════════════════════════════════════════════════
//  TENANT LINK MODULE — tenantlink.js  (the building text line)
//
//  The product sentence: tenants text their building; the system turns
//  messages into the right operating action. The browser thread was the
//  first door; SMS (030) is the second door into the SAME machinery.
//  One spine, two doors — both doors call runInbound(); neither owns a
//  private copy of the classify/act logic.
//
//  PHASE 1 — CONNECTION (027):
//    GET  /properties/:propertyId/tenant-communications  — connection board
//    POST /occupants/:personId/phone                     — save/normalize phone
//    POST /occupants/:personId/invite                    — create setup link (auto-texts it when SMS is live)
//    GET  /t/setup/:token        — tenant-facing PAGE (served HTML)
//    GET  /tenant/setup/:token   — setup state (JSON behind the page)
//    POST /tenant/setup/request-code — text a one-time code to the phone ON FILE (030)
//    POST /tenant/setup/verify   — OTP verify when SMS is live; link-only phone-match fallback when it isn't
//    GET  /tenant/me             — session-scoped self view
//
//  PHASE 2+3 — MESSAGE LOOP (028):
//    POST /tenant/messages                       — tenant sends a message (browser door)
//    GET  /tenant/thread                         — tenant reads the thread
//    GET  /properties/:propertyId/inbox          — manager inbox
//    POST /conversations/:conversationId/reply   — manager replies (texts the tenant when SMS is live)
//    GET  /conversations/:conversationId/messages — manager reads a thread
//
//  SMS DOOR (030):
//    POST /communications/inbound-sms            — Twilio webhook (signature-gated, NOT operator-gated;
//                                                  Twilio can't send headers — the signature IS the gate)
//    POST /properties/:propertyId/sms-number     — operator sets the property's text line
//
//  THE RULE THIS RUNG ENFORCES: a message can never silently disappear.
//  Every inbound is SAVED FIRST, then classified; classification failure
//  degrades to needs_human, never to a lost message. A failed SMS send is
//  a RECORDED failure (sms_status + sms_error) on a message that already
//  exists. Webhook retries can never duplicate (unique sms_sid index).
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
//    • Emergencies keep the 911 line — the caveat reply is identical on
//      both doors because both doors share the same reply text.
//
//  OTP rules (030):
//    • The code goes ONLY to the phone already on file. A typed phone is
//      never an identity input in OTP mode — phone on file IS identity.
//    • Only a salted hash is stored; codes expire in 10 minutes; resends
//      rate-limited to one per 60s; wrong codes share the existing
//      5-strikes-revokes-the-link counter. Codes are NEVER written to the
//      conversation thread (a secret is not a message).
//    • If the SMS transport or the property line isn't configured, verify
//      falls back to the original link-only phone-match — production
//      behavior is unchanged until Twilio is actually live.
//
//  FLAGGED FOLLOW-UP (deliberate, not forgotten): tenant emergencies top
//  the inbox + get the honest 911-caveat reply + open a work order, but do
//  NOT auto-spawn the escalation obligation chain — no on-call notification
//  channel exists yet, and an obligation nobody is told about is activity
//  masquerading as escalation. Wire it when the on-call decision is made.
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const { classifyUrgency } = require("../maintenance/maintenance_urgency.js"); // narrow urgency decision for tenant maintenance
const { normalizePropertyLine } = require("./property_line"); // the one canonical property-line normalizer
//  SHARED CONVERSATIONAL SEAMS — transport-independent, one implementation.
//  Extracted out of this file so a second conversational caller uses the SAME
//  logic rather than a copy. Do not reintroduce local copies here.
const clarification = require("../conversation/clarification");
const { operatingReceipt, deliveryReceipt, composeReceipt } = require("../conversation/receipt");
const technicianConversation = require("../technician/conversation");

module.exports = function tenantLinkModule({ pool, anthropic, INGEST_MODEL, sms, commBoundary, workOrderService, getAgentService }) {
  const router = express.Router();

  // ── DEPENDENCY ASSERTION (symmetric with maintenance.js) ──────────────
  //  POST /tenant/maintenance and /tenant/maintenance/:id/add delegate every
  //  create and every append to the canonical work-order service. This module
  //  used to accept its absence: server.js never built the service, so
  //  workOrderService arrived undefined, every resident maintenance request
  //  threw TypeError inside the route, and the catch answered "Could not open
  //  your maintenance request." A resident was told the building had failed,
  //  the building was told nothing, and the API booted perfectly green.
  //
  //  Assert at CONSTRUCTION instead. A failed deploy is loud, caught by the
  //  health check, and leaves the previous version serving. A resident route
  //  that boots successfully and silently refuses every request is the more
  //  dangerous failure: nothing anywhere reports it.
  if (!workOrderService || typeof workOrderService.createWorkOrder !== "function") {
    throw new Error(
      "tenantlink module requires workOrderService (build it with " +
      "makeWorkOrderService({ spawnObligationFromEvent }) in server.js and inject it)"
    );
  }

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
  //  normalizePhone WAS DEFINED HERE. It is now the shared
  //  normalizePropertyLine in src/comms/property_line.js — same function,
  //  moved rather than changed, so this file's behaviour is identical.
  //
  //  Why it moved: the property line is compared at three places — this
  //  write path, the inbound resolver, and the preflight tool — and until
  //  now only this one normalized at all. The inbound lookup compared the
  //  RAW `To` against a normalized store, so a line stored in any other
  //  format was not mis-routed but silently UNREACHABLE. One rule needs one
  //  implementation; owner ruling 2026-08-03 made this function's output
  //  the canonical stored and compared form.
  const normalizePhone = normalizePropertyLine;
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

  // ── RESIDENT MAINTENANCE — narrow urgency path → canonical work-order service.
  //    Auth: person/property from the session; unit from placeOf. Body ids are
  //    never trusted. Every create/append flows through workOrderService.
  router.post("/tenant/maintenance", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const place = await placeOf(sess.person_id, sess.property_id);
      if (!place) return res.status(404).json({ receipt: "No active lease found for your account. Contact your manager." });
      const description = ((req.body && req.body.description) || "").trim();
      if (!description) return res.status(400).json({ receipt: "Please describe the maintenance issue." });
      const c = classifyUrgency(description);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { workOrder, deduped } = await workOrderService.createWorkOrder(client, {
          property_id: sess.property_id, unit_id: place.unit_id,
          // migration 098: the resident who texted is BOTH the reporter and the
          // affected resident. Both are named explicitly — passing the old
          // single `person_id` here would now be silently dropped, leaving a
          // resident-reported work order with nobody attached to it.
          reported_by_person_id: sess.person_id, affected_person_id: sess.person_id,
          title: (c.urgency === "emergency" ? "EMERGENCY: " : "") + "Maintenance request",
          description, source: "tenant",
          urgency_status: c.urgency, urgency_basis: c.basis, urgency_decided_by: "system",
          emergency_type: c.emergency_type, idempotency_key: (req.body && req.body.idempotency_key) || null,
        });
        await client.query("commit");
        const receipt = c.urgency === "emergency"
          ? "Emergency received — management has been notified in the system. If anyone is in immediate danger, call 911 first."
          : c.urgency === "needs_confirmation"
          ? "Got it — one quick question so we route this right: " + c.clarifying_question
          : "Got it — your maintenance request is in, and we'll keep you updated right here.";
        res.status(201).json({ receipt, work_order_id: workOrder.id, urgency: c.urgency,
          clarifying_question: c.urgency === "needs_confirmation" ? c.clarifying_question : null, deduped: !!deduped });
      } catch (e) {
        try { await client.query("rollback"); } catch (_) {}
        res.status(e.httpStatus || 500).json({ receipt: "Could not open your maintenance request." });
      } finally { client.release(); }
    } catch (e) { console.error("tenant/maintenance:", e); res.status(500).json({ receipt: "Could not open your maintenance request." }); }
  });

  router.post("/tenant/maintenance/:id/add", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const place = await placeOf(sess.person_id, sess.property_id);
      if (!place) return res.status(404).json({ receipt: "No active lease found for your account." });
      const text = ((req.body && req.body.text) || "").trim();
      if (!text) return res.status(400).json({ receipt: "Please add a detail or answer." });
      const client = await pool.connect();
      try {
        await client.query("begin");
        await workOrderService.assertTenantOwnsWorkOrder(client, {
          work_order_id: req.params.id, person_id: sess.person_id, property_id: sess.property_id, unit_id: place.unit_id });
        const { escalated } = await workOrderService.appendClarification(client, {
          work_order_id: req.params.id, person_id: sess.person_id, text, classifyUrgency });
        await client.query("commit");
        res.status(200).json({ receipt: escalated
          ? "Thanks — based on that we've flagged this as urgent and notified management."
          : "Thanks — added to your request.", escalated: !!escalated });
      } catch (e) {
        try { await client.query("rollback"); } catch (_) {}
        res.status(e.httpStatus || 500).json({ receipt: e.httpStatus === 403 ? "That request isn't on your account." : "Could not add to your request." });
      } finally { client.release(); }
    } catch (e) { console.error("tenant/maintenance/add:", e); res.status(500).json({ receipt: "Could not add to your request." }); }
  });

  // ── SMS helpers (030) ────────────────────────────────────────────────
  const smsReady = () => !!(sms && sms.enabled());

  // COMMUNICATIONS BOUNDARY: propertyLine + smsForEvent moved into
  // communications_boundary.js (sendPropertySms). The line is derived
  // server-side inside the gate; save-first is preserved (pass eventId
  // and the gate stamps the wire's answer onto the existing comm_event).
  // This module never calls raw sms.sendSms.

  // ════════════════════════════════════════════════════════════════════
  //  1. MANAGER CONNECTION BOARD
  // ════════════════════════════════════════════════════════════════════
  router.get("/properties/:propertyId/tenant-communications", requireOperator, async (req, res) => {
    try {
      const { propertyId } = req.params;
      const propQ = await pool.query(
        `select id, name, address, leasing_basis, sms_number from properties where id = $1`,
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
        property: {
          id: prop.id, name: prop.name, address: prop.address,
          leasing_basis: prop.leasing_basis,
          sms_number: prop.sms_number,                       // 030: the property line (null = link-only)
          sms_transport: smsReady() ? "configured" : "not_configured",
        },
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
  //  2b. SET THE PROPERTY TEXT LINE (030)
  //  The Twilio number this property speaks from. Identity for inbound
  //  routing: webhook "To" → exactly one property. Operator-gated.
  // ════════════════════════════════════════════════════════════════════
  router.post("/properties/:propertyId/sms-number", requireOperator, async (req, res) => {
    try {
      const { propertyId } = req.params;
      const raw = req.body && req.body.sms_number;
      const number = raw === null || raw === "" ? null : normalizePhone(raw);
      if (raw && !number) {
        return res.status(400).json({ receipt: "That doesn't look like a valid US phone number. Use 10 digits or +1 format." });
      }
      if (number) {
        //  Checked against the CANONICAL model, not the projection. The
        //  database enforces this too (uq_communication_lines_active_e164);
        //  this exists to answer with a sentence instead of a constraint
        //  violation.
        const clash = await pool.query(
          `select p.id, p.name, p.address
             from communication_lines cl
             join properties p on p.id = cl.property_id
            where cl.e164 = $1 and cl.status = 'active'
              and cl.line_type = 'property_facing' and cl.property_id <> $2`,
          [number, propertyId]);
        if (clash.rows.length) {
          return res.status(409).json({
            receipt: `That number is already the text line for ${clash.rows[0].name || clash.rows[0].address}. One line, one property — inbound routing depends on it.`,
          });
        }
      }
      //  CANONICAL CONFIGURATION WRITE (migration 130). communication_lines
      //  is the only writable source of line configuration;
      //  properties.sms_number is a read-only projection maintained by a
      //  trigger, and a direct write to it is refused by the database.
      //
      //  Supersession, not mutation: the previous line is RETIRED rather
      //  than overwritten, so a number moving between properties stays
      //  auditable (§6 — corrections do not erase history).
      await pool.query("begin");
      try {
        await pool.query(
          `update communication_lines
              set status = 'retired', superseded_at = now(), updated_at = now()
            where property_id = $1 and line_type = 'property_facing' and status = 'active'`,
          [propertyId]);

        if (number) {
          await pool.query(
            `insert into communication_lines
               (e164, line_type, property_id, authority_ceiling, permitted_audience,
                inbound_enabled, outbound_enabled, status, notes)
             values ($1, 'property_facing', $2, 'external', 'residents_and_prospects',
                true, false, 'active', 'configured via operator property-line route')`,
            [number, propertyId]);
        }
        await pool.query("commit");
      } catch (e) {
        await pool.query("rollback");
        throw e;
      }

      const r = await pool.query(
        `select id, name, address, sms_number from properties where id = $1`,
        [propertyId]);
      if (!r.rows.length) return res.status(404).json({ receipt: "No property with that id." });
      const p = r.rows[0];
      res.json({
        receipt: number
          ? `${p.name || p.address} text line set to ${number}. Invites, replies, and OTP codes now go out as real texts from this number.`
          : `${p.name || p.address} text line cleared — back to link-only behavior.`,
        property: { id: p.id, name: p.name, sms_number: p.sms_number },
        sms_transport: smsReady() ? "configured" : "not_configured (set Twilio env vars in Render)",
      });
    } catch (e) {
      console.error("sms-number:", e);
      res.status(500).json({ receipt: "Could not set the text line.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  3. CREATE SETUP LINK (supersedes old active links; opens the thread)
  //  030: when the transport + property line are live, the invite text
  //  goes out AS A REAL TEXT from the property line. When they're not,
  //  the manager copies it from the receipt — exactly as before.
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

      // 030: put it on the wire if we can. Save-first already happened —
      // a failed send is a recorded failure, and the manager still gets
      // the copyable text as the fallback.
      const wire = await commBoundary.sendPropertySms({
        property_id: propertyId, recipient: person.phone, body: sms_text,
        purpose: "agent", person_id: personId, eventId: msg.id,
      });

      res.json({
        receipt: wire.sent
          ? `Setup text sent to ${firstName(person.name)} at ${maskPhone(person.phone)} from the property line.`
          : `Setup link created for ${firstName(person.name)} in unit ${place.unit_number}. Copy the text below and send it from your phone.${wire.reason === "send_failed" ? " (Automatic text failed — recorded on the message.)" : ""}`,
        person_id: personId, conversation_id: convo.id, invite_id: inv.id,
        link, sms_text, expires_at: inv.expires_at, first_message_id: msg.id,
        sms_sent: !!wire.sent, sms_reason: wire.sent ? null : wire.reason,
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
              p.name as property_name, p.address as property_address,
              p.sms_number as property_sms_number
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
  // OTP mode requires BOTH a live transport and a property line to send
  // the code from. Anything less degrades honestly to link-only matching.
  const otpAvailable = (inv) => smsReady() && !!inv.property_sms_number && !!inv.person_phone;

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
      const otp = otpAvailable(inv);
      res.json({
        status,
        verify_mode: otp ? "otp" : "phone_match",
        masked_phone: otp ? maskPhone(inv.person_phone) : null,
        property: { name: inv.property_name || inv.property_address },
        tenant: { first_name: firstName(inv.person_name), unit_number: place ? place.unit_number : null },
        message: status === "already_verified"
          ? (otp ? "You're already connected. Verify with a code to open your thread."
                 : "You're already connected. Verify your phone again to open your thread.")
          : (otp ? `We'll text a code to your phone on file to connect you to ${theName(inv.property_name)} tenant line.`
                 : `Confirm your phone to connect to ${theName(inv.property_name)} tenant line.`),
      });
    } catch (e) {
      console.error("setup state:", e);
      res.status(500).json({ status: "error", message: "Could not load this link." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  4b. REQUEST A ONE-TIME CODE (030)
  //  The code goes ONLY to the phone on file — never to a typed number.
  //  Only a salted hash is stored. 10-minute expiry, 60s resend limit.
  //  The code is NOT written to the conversation thread: a secret is not
  //  a message.
  // ════════════════════════════════════════════════════════════════════
  const otpHash = (code, token) =>
    crypto.createHash("sha256").update(`${code}:${token}`).digest("hex");

  router.post("/tenant/setup/request-code", async (req, res) => {
    try {
      const { token } = req.body || {};
      const inv = await loadInvite(token);
      const status = inviteState(inv);
      if (status === "invalid") return res.status(404).json({ receipt: "This link isn't recognized." });
      if (status === "expired" || status === "revoked") {
        return res.status(410).json({ receipt: "This link expired or was replaced. Ask your manager for a fresh link." });
      }
      if (!otpAvailable(inv)) {
        return res.status(503).json({ receipt: "Text verification isn't available for this property yet — confirm your phone number instead." });
      }
      if (inv.otp_sent_at && (Date.now() - new Date(inv.otp_sent_at).getTime()) < 60 * 1000) {
        return res.status(429).json({ receipt: "A code was just sent — give it a minute, then try again." });
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      await pool.query(
        `update tenant_invites
            set otp_hash = $1, otp_expires_at = now() + interval '10 minutes', otp_sent_at = now()
          where id = $2`,
        [otpHash(code, inv.token), inv.id]);

      const body = `Your ${theName(inv.property_name)} tenant line code is ${code}. It expires in 10 minutes. Never share this code.`;
      // COMMUNICATIONS BOUNDARY: OTP is explicitly classified credential
      // transport (purpose='otp'), never an informal raw-transport
      // exception. No eventId — a secret is not a message.
      const wire = await commBoundary.sendPropertySms({
        property_id: inv.property_id, recipient: inv.person_phone, body,
        purpose: "otp", person_id: inv.person_id,
      });
      if (!wire.sent) {
        // Honest failure — clear the hash so a stale code can't linger.
        await pool.query(`update tenant_invites set otp_hash = null, otp_expires_at = null where id = $1`, [inv.id]);
        return res.status(502).json({ receipt: "Could not send the code right now — try again in a moment." });
      }
      res.json({
        receipt: `Code sent to ${maskPhone(inv.person_phone)}. It expires in 10 minutes.`,
        masked_phone: maskPhone(inv.person_phone),
      });
    } catch (e) {
      console.error("request-code:", e);
      res.status(500).json({ receipt: "Could not send a code. Try again." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  5. VERIFY — OTP when SMS is live; link-only phone-match fallback.
  //  Both paths share one connect step and the SAME 5-strikes lockout.
  // ════════════════════════════════════════════════════════════════════
  async function connectInvite(inv) {
    await pool.query(
      `update tenant_invites
          set status='used', used_at = coalesce(used_at, now()),
              otp_hash = null, otp_expires_at = null
        where id = $1`, [inv.id]);
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
    return { sess, place };
  }

  async function strike(inv, res, message) {
    const attempts = inv.failed_attempts + 1;
    if (attempts >= 5) {
      await pool.query(`update tenant_invites set failed_attempts=$1, status='revoked' where id=$2`,
        [attempts, inv.id]);
      return res.status(401).json({ receipt: "Too many attempts — this link is now locked. Ask your manager for a fresh one." });
    }
    await pool.query(`update tenant_invites set failed_attempts=$1 where id=$2`, [attempts, inv.id]);
    return res.status(401).json({ receipt: message });
  }

  router.post("/tenant/setup/verify", async (req, res) => {
    try {
      const { token, code } = req.body || {};
      const inv = await loadInvite(token);
      const status = inviteState(inv);
      if (status === "invalid") return res.status(404).json({ receipt: "This link isn't recognized." });
      if (status === "expired" || status === "revoked") {
        return res.status(410).json({ receipt: "This link expired or was replaced. Ask your manager for a fresh link." });
      }

      if (otpAvailable(inv)) {
        // ── OTP path. A typed phone is NOT accepted as identity here. ──
        const typedCode = String(code || "").replace(/\D/g, "");
        if (!typedCode || typedCode.length !== 6) {
          return res.status(400).json({ receipt: "Enter the 6-digit code we texted you." });
        }
        if (!inv.otp_hash) {
          return res.status(409).json({ receipt: "Request a code first — tap “Text me a code.”" });
        }
        if (new Date(inv.otp_expires_at) < new Date()) {
          return res.status(410).json({ receipt: "That code expired. Request a fresh one." });
        }
        if (otpHash(typedCode, inv.token) !== inv.otp_hash) {
          return strike(inv, res, "That code isn't right. Check the text and try again.");
        }
      } else {
        // ── Link-only fallback: typed phone must match the record. ──
        const typed = normalizePhone(req.body && req.body.phone);
        if (!typed) {
          return res.status(400).json({ receipt: "That doesn't look like a valid phone number. Use 10 digits." });
        }
        if (typed !== inv.person_phone) {
          return strike(inv, res, "That phone does not match this invite.");
        }
      }

      // Verified — connect. Mark used (idempotent for already_verified
      // re-entry), issue a 30-day session, log the connection on the thread.
      const { sess, place } = await connectInvite(inv);
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
  // ── INTENT INTERPRETATION — EXTRACTED ──────────────────────────────
  //  classifyMessage and recognizeAnswer used to live here as private
  //  closures, reachable only through the SMS route. They are now
  //  src/conversation/intent.js, transport-independent, so a second
  //  conversational caller uses the SAME implementation rather than a copy.
  //  See docs/AGENT_CAPABILITY_SEAMS.md for the extraction trigger.
  //
  //  ONE IMPLEMENTATION. Do not reintroduce a local copy here; the
  //  tests/_engine.js drift is the standing counter-example.
  const { classifyMessage, recognizeAnswer, FIELD_CATEGORIES, ANSWER_VERDICTS } =
    require("../conversation/intent")({ anthropic, model: INGEST_MODEL });

  // ════════════════════════════════════════════════════════════════════
  //  7. THE INBOUND CORE — runInbound(): one spine, two doors.
  //  EVERY inbound tenant message — browser or SMS — runs through this
  //  exact function. Save-first → classify → act → audit → reply. The
  //  doors differ ONLY in how the reply travels back (HTTP vs SMS wire);
  //  the objects created are identical, by construction.
  // ════════════════════════════════════════════════════════════════════
  // ── THE ANSWER-RECOGNITION GATE (§7.2) ────────────────────────────
  //  Given the exact question we asked and what the resident said back,
  //  decide ONE of four verdicts. Identity plus one open question is NOT
  //  evidence that a message answers it — a resident with a pending question
  //  is still perfectly capable of reporting something unrelated.
  //  FAIL-SOFT DEFAULT IS 'unclear': if the model is absent or errors, the
  //  message is preserved and flagged, never guessed onto a work order.

  // Find the clarification question WE ASKED THIS PERSON, joined to the
  // still-open confirm_urgency obligation for that exact work order (§7.1).
  //
  // NOT keyed on obligations.person_id — that column holds
  // affected_person_id ?? reported_by_person_id, i.e. whose home it is, not
  // who we texted. Those differ whenever a neighbour reports a problem, and
  // keying on it would classify a reporter's own answer as a new problem.
  //
  // A question whose delivery DEFINITIVELY failed was never asked. NULL
  // sms_status is not a failure — the browser door never sends an SMS at all,
  // so its questions must stay eligible.
  async function pendingClarifications(client, { propertyId, personId }) {
    return (await client.query(
      `select o.id as obligation_id, o.related_id as work_order_id,
              ce.property_id,                 -- carried so the seam can VERIFY scope, never derive it
              ce.id as question_event_id, ce.body as question_body
         from comm_events ce
         join obligations o
           on o.related_type = 'work_order'
          and o.related_id   = ce.created_object_id
          and o.property_id  = ce.property_id   -- scope is explicit, never implied by uuid uniqueness
          and o.status       = 'open'
          and o.type         = 'confirm_urgency'
        where ce.property_id = $1
          and ce.person_id   = $2
          and ce.direction   = 'outbound'
          and ce.created_object_type = 'work_order'
          and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')
        order by ce.occurred_at desc`,
      [propertyId, personId])).rows;
  }

  // A clarification QUESTION is marked as one when it is sent. Every outbound
  // reply about a work order carries created_object_type='work_order' —
  // including the ordinary "request opened" acknowledgment — so that column
  // alone cannot distinguish "we asked you something" from "we told you
  // something." Scoping §7.6 on it would have matched every resident who has
  // ever had ANY work order, and suppressed all their future requests.
  const CLARIFICATION_QUESTION = "clarification_question";

  // §7.6 — a zero result has two meanings. "We asked a question, and someone
  // else resolved it before the reply landed" must not become a duplicate work
  // order for an issue already in hand. Narrow by construction: only a real
  // clarification question counts, and only while its work order still has no
  // newer question outstanding.
  async function hasAnsweredQuestionAlreadyResolved(client, { propertyId, personId }) {
    const r = (await client.query(
      `select 1 from comm_events ce
        where ce.property_id = $1 and ce.person_id = $2
          and ce.direction = 'outbound'
          and ce.classification = $3
          and ce.created_object_type = 'work_order'
          and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')
          -- the question was answered by someone else: its work order carries a
          -- resident_clarification decision, but no open question remains.
          and exists (select 1 from work_orders w
                       where w.id = ce.created_object_id
                         and w.property_id = ce.property_id
                         and w.urgency_decided_by = 'resident_clarification')
        limit 1`, [propertyId, personId, CLARIFICATION_QUESTION])).rows[0];
    return !!r;
  }

  // ── THE PROCESSING STEP (T2 body) ─────────────────────────────────
  //  Runs entirely inside ONE transaction owned by the caller. Every write
  //  that represents "we did something about this claim" lives here, so a
  //  failure leaves the claim preserved and flagged and nothing half-done.
  async function processInboundClaim(client, { personId, propertyId, body, place, smsSid }) {
    const context = { unitLabel: place ? `Unit ${place.unit_number}` : "your unit" };
    const c = await classifyMessage(body);

    // Every return below carries the OPERATING receipt itself, not only its
    // text. Delivery is a separate fact, decided later by the transport, and
    // the two are never merged into one "it worked".
    const speak = (r, { createdType = null, createdId = null, needsHuman }) => {
      if (r.text === null) {
        // The composer refused: it had no committed fact to describe. Failing
        // here rolls T2 back — the claim is preserved and flagged and no reply
        // is sent — rather than acknowledging something that may not exist.
        throw new Error(`receipt refused (${r.refusal}) — no reply composed for outcome ${r.outcome}`);
      }
      return { c, createdType, createdId, reply: r.text, needsHuman,
               askedClarification: r.isClarificationQuestion, receipt: r };
    };
    const held = (reasonCode) => {
      c.needs_human = true;
      return speak(operatingReceipt({ outcome: "held_for_human", result: { reasonCode }, context }),
                   { needsHuman: true });
    };

    // 1) Is this an answer to a question we asked? (§7.1–7.6)
    //    The seam owns the ladder; this file owns the two determinations it
    //    names, because both need this database.
    let step = clarification.assessOpenClarification({
      scope: { property_id: propertyId },
      open: await pendingClarifications(client, { propertyId, personId }),
    });
    if (step.needs === "answer_verdict") {
      step = clarification.resolveAnswerVerdict({
        pending: step,
        answerVerdict: await recognizeAnswer({ question: step.question, reply: body }),
      });
    } else if (step.needs === "prior_resolution_check") {
      step = clarification.resolvePriorResolution({
        pending: step,
        priorAnsweredResolved: await hasAnsweredQuestionAlreadyResolved(client, { propertyId, personId }),
      });
    }

    if (step.action === "hold_for_human") return held(step.state);

    if (step.action === "append_to_existing") {
      const out = await workOrderService.appendClarification(client, {
        work_order_id: step.target.work_order_id, person_id: personId, text: body, classifyUrgency,
      });
      const r = operatingReceipt({ outcome: "clarification_appended", result: out, context });
      // The SERVICE decided this, both directions — not the interpreter.
      c.needs_human = r.requiresHuman === true;
      return speak(r, { createdType: "work_order", createdId: step.target.work_order_id,
                        needsHuman: c.needs_human });
    }

    // 2) Normal path (step.action === 'propose_new_action'). Work orders go
    //    through THE canonical service, so every one produces an event and a
    //    routing obligation.
    const isMaintenanceClaim = c.classification === "emergency"
      || (c.classification === "maintenance" && c.confidence >= 0.7 && !c.needs_human);

    if (isMaintenanceClaim) {
      // §7.4 — a consequential reading may not be acted on when the fact that
      // makes it actionable is missing. The seam decides; nothing is invented.
      const decision = clarification.assessConsequentialInterpretation({
        classification: c.classification, urgency: classifyUrgency(body),
      });

      const created = await workOrderService.createWorkOrder(client, {
        property_id: propertyId, unit_id: place ? place.unit_id : null,
        reported_by_person_id: personId, affected_person_id: personId,
        title: decision.urgency_status === "emergency"
          ? "EMERGENCY: " + (c.suggested_title || c.field_category || "tenant report")
          : (c.suggested_title || `${c.field_category} request`),
        description: body,                 // stored VERBATIM by the service
        field_category: c.field_category,
        source: "tenant",
        urgency_status: decision.urgency_status, urgency_basis: decision.basis,
        urgency_decided_by: "system",
        emergency_type: decision.emergency_type,
        // The provider's own message id makes a redelivery idempotent at the
        // service layer too, not only at the boundary dedupe.
        idempotency_key: smsSid || null,
      });

      // §7.5 — truthful acknowledgment only, composed from the row that was
      // COMMITTED rather than from what we asked for. No response time, no
      // technician, no dispatch or assignment claim.
      const r = operatingReceipt({ outcome: "work_order_opened",
                                   result: { workOrder: created.workOrder, decision, deduped: !!created.deduped },
                                   context });
      if (r.requiresHuman === true) c.needs_human = true;
      return speak(r, { createdType: "work_order", createdId: created.workOrder.id,
                        needsHuman: c.needs_human });
    }

    if (c.classification === "balance" && c.confidence >= 0.7 && !c.needs_human && place) {
      const r = operatingReceipt({ outcome: "balance_read",
                                   result: { balance: place.balance, rent: place.rent }, context });
      return speak(r, { createdType: "balance_inquiry", needsHuman: c.needs_human });
    }

    // document / lease_question / general / unknown / low confidence /
    // sensitive — the honest human queue. No pretending.
    return held("not_actionable");
  }

  async function runInbound({ personId, propertyId, body, channel, smsSid }) {
    const place = await placeOf(personId, propertyId);

    // ══ T1 ══ The claim is durable AND VISIBLE before any processing.
    //  needs_human starts TRUE deliberately. The column defaults to false, so
    //  the previous save-first left a resident's message committed and
    //  INVISIBLE to the exception queue whenever anything downstream threw.
    //  Starting true and clearing on success inverts that: the only way a
    //  message becomes unflagged is that its processing actually committed.
    const t1 = await pool.connect();
    let convo, inbound;
    try {
      await t1.query("begin");
      convo = (await t1.query(
        `insert into conversations (property_id, person_id, unit_id, lease_id)
         values ($1,$2,$3,$4)
         on conflict (property_id, person_id) do update set last_message_at = now()
         returning id`,
        [propertyId, personId, place ? place.unit_id : null, place ? place.lease_id : null])).rows[0];
      inbound = (await t1.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, sms_sid, needs_human)
         values ($1,$2,$3,$4,$5,'inbound',$6,$7,true) returning id`,
        [propertyId, personId, place ? place.unit_id : null, convo.id, channel, body, smsSid || null])).rows[0];
      await t1.query("commit");
    } catch (e) {
      await t1.query("rollback").catch(() => {});
      throw e;
    } finally { t1.release(); }

    // ══ T2 ══ Everything that represents acting on the claim, atomically.
    //  On failure: the claim stands, stays flagged, no reply is sent, and no
    //  work order is represented as created. No replay-resume in this slice.
    const t2 = await pool.connect();
    let result, out;
    try {
      await t2.query("begin");
      result = await processInboundClaim(t2, { personId, propertyId, body, place, smsSid });

      await t2.query(
        `update comm_events set classification=$1, created_object_type=$2,
                created_object_id=$3, needs_human=$4, ai_summary=$5 where id=$6`,
        [result.c.classification, result.createdType, result.createdId,
         !!result.needsHuman, result.c.summary, inbound.id]);

      // The outbound reply INTENT. created_object_* is what makes a future
      // reply recognisable as an answer to THIS question about THIS work
      // order — the linkage the whole gate depends on.
      out = (await t2.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, created_object_type, created_object_id)
         values ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9) returning id, occurred_at`,
        [propertyId, personId, place ? place.unit_id : null, convo.id, channel,
         result.reply,
         result.askedClarification ? CLARIFICATION_QUESTION : "auto_reply",
         result.createdType, result.createdId])).rows[0];
      await t2.query(`update conversations set last_message_at = now() where id = $1`, [convo.id]);
      await t2.query("commit");
    } catch (e) {
      await t2.query("rollback").catch(() => {});
      console.error("runInbound T2 failed — claim preserved and flagged, no reply sent:", e.message);
      throw e;
    } finally { t2.release(); }

    //  `operating` is the receipt for what was COMMITTED here. Whether the
    //  resident was actually told is a separate fact that this function does
    //  not know and must not imply — each door composes it from its own
    //  transport outcome.
    return { inbound, out, reply: result.reply, c: result.c, operating: result.receipt,
             createdType: result.createdType, createdId: result.createdId, convo, place };
  }

  // §15.2 — a committed claim whose acknowledgment never reached the resident
  //  must not read as handled. The outbound row carries the delivery failure
  //  (sendPropertySms stamps it), but BOTH exception-queue readers filter
  //  direction='inbound' (surfaces/desks.js, surfaces/board.js) — so flagging
  //  the outbound row would surface to nobody. Re-flag the INBOUND row: the
  //  resident sent something and, from their side, got nothing back.
  //  Deliberately separate from T2 and never able to roll it back: a failed
  //  re-flag must not un-create a valid work order.
  async function flagUndeliveredReply({ inboundEventId, reason }) {
    if (!inboundEventId) return;
    try {
      await pool.query(
        `update comm_events set needs_human = true where id = $1`, [inboundEventId]);
      console.error(`resident reply undelivered (${reason}) — inbound ${inboundEventId} re-flagged for a human.`);
    } catch (e) {
      console.error("flagUndeliveredReply FAILED — delivery failure may be invisible:", e.message);
    }
  }

  // ── Browser door: thin wrapper over the shared core. Same response
  //    shape as before, to the byte. ─────────────────────────────────────
  router.post("/tenant/messages", async (req, res) => {
    try {
      const sess = await sessionOf(req);
      if (!sess) return res.status(401).json({ receipt: "Session expired. Open your setup link again." });
      const body = (req.body && req.body.body || "").trim();
      if (!body) return res.status(400).json({ receipt: "Type a message first." });
      if (body.length > 4000) return res.status(400).json({ receipt: "That message is too long — keep it under 4000 characters." });

      const r = await runInbound({
        personId: sess.person_id, propertyId: sess.property_id, body, channel: "portal",
      });

      //  The portal door has NO transport: the reply is the HTTP response
      //  itself. `not_attempted` is the honest delivery state — it is not
      //  "delivered" (no message was sent) and not "failed" (nothing failed).
      //  Composed rather than assumed so the two axes stay distinguishable on
      //  both doors; the response body is unchanged.
      const composed = composeReceipt({
        operating: r.operating, delivery: deliveryReceipt({ state: "not_attempted" }),
      });

      res.json({
        receipt: composed.operating.text,
        message_id: r.inbound.id, reply_id: r.out.id, conversation_id: r.convo.id,
        classification: r.c.classification, confidence: r.c.confidence,
        created_object_type: r.createdType, created_object_id: r.createdId,
        needs_human: r.c.needs_human,
      });
    } catch (e) {
      console.error("tenant message:", e);
      res.status(500).json({ receipt: "Your message hit an error — try sending it again." });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  7b. SMS DOOR — the Twilio webhook (030)
  //  NOT operator-gated (Twilio can't send our headers) — the
  //  X-Twilio-Signature check IS the gate, and it's fail-closed.
  //  Flow: validate → dedupe → resolve property (To) + person (From) →
  //  shared runInbound → ack Twilio → put the reply on the wire.
  //  Twilio sends application/x-www-form-urlencoded, so this one route
  //  carries its own parser.
  // ════════════════════════════════════════════════════════════════════
  const emptyTwiml = (res) => res.type("text/xml").send("<Response></Response>");

  router.post("/communications/inbound-sms",
    express.urlencoded({ extended: false, limit: "100kb" }),
    async (req, res) => {
      try {
        if (!smsReady()) {
          console.error("inbound-sms: webhook hit but transport not configured.");
          return res.status(503).type("text/plain").send("SMS transport not configured");
        }
        if (!sms.validateWebhook(req)) {
          console.error("inbound-sms: signature validation FAILED — rejected.");
          return res.status(403).type("text/plain").send("Invalid signature");
        }

        const { MessageSid, From, To } = req.body || {};
        const body = String(req.body && req.body.Body || "").trim().slice(0, 4000);
        if (!MessageSid || !From || !To) return emptyTwiml(res);

        // COMMUNICATIONS BOUNDARY: the route owns transport authentication
        // (signature + payload shape, above); the boundary owns domain
        // resolution. To → property FIRST, sender resolved inside that
        // property, idempotent on MessageSid, unknown line writes nothing.
        const ctx = await commBoundary.resolveInboundSmsContext({ To, From, MessageSid, body });

        // Retry / duplicate sid → already handled. Ack and stop.
        if (ctx.idempotentReplay) return emptyTwiml(res);

        // Unknown receiving line → zero rows written (no property ledger
        // exists). Boundary logged it; Twilio's logs keep the raw message.
        if (ctx.unknownLine) return emptyTwiml(res);

        // AMBIGUOUS receiving line → more than one property holds this
        // number, so the property wall itself is unknown. Zero rows
        // written, nothing attached to any property ledger, no outbound.
        //
        // This is deliberately NOT the ctx.ambiguous branch below. That one
        // has a KNOWN property and preserves the claim on it. Here there is
        // no property we could honestly attach to, and picking one of the
        // candidates would reintroduce the arbitrary bind — the boundary
        // already logged every candidate id for an operator to resolve.
        if (ctx.ambiguousLine) return emptyTwiml(res);

        // A configured line that is suspended or retired. Fails closed
        // exactly like unknown; named separately so a real operator action
        // (or a reassigned number) is not reported as "we've never heard of
        // this number".
        if (ctx.inactiveLine) return emptyTwiml(res);

        // ══ OPERATIONS LINE — THE TECHNICIAN TURN (Phase 2) ═════════════
        //  The boundary resolved the organization, the authority ceiling and
        //  the staff sender. An organization number never chooses a building,
        //  so property scope comes from the sender's OWN assignments, derived
        //  again inside the turn.
        //
        //  UNRESOLVED SENDER → ZERO ROWS AND NO REPLY. We do not know who
        //  this is; replying would be the operations number messaging an
        //  unknown handset, which the reply_only policy exists to prevent.
        //  The boundary already logged it.
        if (ctx.operationsLine) {
          if (ctx.staffOutcome !== "one" || !ctx.staffUserId) return emptyTwiml(res);

          //  Ack the provider first — the reply travels by REST, and a slow
          //  turn must not become a provider timeout and a redelivery.
          emptyTwiml(res);

          let turn;
          const t = await pool.connect();
          try {
            await t.query("begin");
            turn = await technicianConversation.runOperationsTurn(t, {
              organizationId: ctx.organizationId, userId: ctx.staffUserId,
              lineId: ctx.lineId, body: body || "(empty message)",
              providerMessageId: MessageSid,
            });
            await t.query("commit");
          } catch (e) {
            await t.query("rollback").catch(() => {});
            //  A redelivery that lost the correlation-key race has already
            //  been answered. Nothing to do, and nothing wrong.
            if (e.code === "23505") {
              console.error(`inbound-sms: operations turn already answered (${MessageSid}) — duplicate suppressed.`);
              return;
            }
            console.error("inbound-sms: operations turn failed — inbound preserved, no reply sent:", e.message);
            return;
          } finally { t.release(); }

          //  TRANSPORT, AFTER THE COMMIT. The operating action is done and
          //  is not revised by anything the carrier does.
          let wire;
          try {
            wire = await commBoundary.sendOperationsReply({
              organization_id: ctx.organizationId, recipient: From, body: turn.operating.text,
              replyToCommEventId: turn.inbound.id, eventId: turn.outbound.id,
              actor_user_id: ctx.staffUserId,
            });
          } catch (sendErr) {
            wire = { sent: false, reason: `transport_threw: ${sendErr.message}`, sid: null };
          }

          const composed = composeReceipt({
            operating: turn.operating,
            delivery: deliveryReceipt(wire.sent
              ? { state: "delivered", providerRef: wire.sid || null }
              : { state: "failed", providerRef: wire.sid || null, failureReason: wire.reason || "unknown" }),
          });
          if (!composed.delivery.delivered) {
            //  The acceptance STANDS. Only the telling failed, and that is
            //  flagged on the inbound so a human can see the technician was
            //  never answered — never by undoing the committed action.
            await flagUndeliveredReply({ inboundEventId: turn.inbound.id,
                                         reason: composed.delivery.failureReason });
          }
          return;
        }

        // Unknown or ambiguous sender → the boundary saved the message on
        // the PROPERTY (person-less, needs_human). Phase A dispatches ZERO
        // outbound on ambiguity: a clarification reply is a real send and
        // ships only under a future explicit policy through the gate.
        if (ctx.ambiguous) return emptyTwiml(res);

        // Consent keyword (STOP/START): the boundary already recorded the
        // event once and updated contact_preferences — the one canonical
        // consent truth. Dispatch NOTHING: no AI turn, no reply text
        // (replying to a STOP is itself a carrier violation; Twilio's
        // compliance layer sends the required confirmation).
        if (ctx.consentSignal) return emptyTwiml(res);

        const person = ctx.person;
        const prop = ctx.property;

        // ── ROUTE BY RESOLVED RELATIONSHIP (one door, two brains) ──────────
        // The resolver resolved this sender as a RESIDENT or a LEAD and wrote
        // NOTHING on either resolved path. The receiving line already fixed the
        // property; here we only pick the brain.
        if (ctx.relationship === "lead") {
          // PROSPECT inbound → the leasing AGENT owns the SINGLE canonical
          // inbound write AND the governed auto-dispatch. We call the agent's
          // SHARED IN-PROCESS service (processInbound) — the SAME function the
          // public /agent/inbound route runs — so there is one code path and
          // NO loopback HTTP boundary. We do NOT call runInbound and do NOT
          // write here. Idempotency across the handoff: sms_sid = MessageSid
          // (the agent dedups the RECORD, incl. a concurrent-insert 23505
          // catch) and idempotency_key = MessageSid (the agent dedups the
          // agent_run, so a retry never produces a second REPLY).
          //
          // Ack Twilio immediately — the agent's reply leaves by REST (through
          // sendPropertySms) exactly like the tenant path, not via TwiML.
          emptyTwiml(res);
          try {
            const agentSvc = typeof getAgentService === "function" ? getAgentService() : null;
            if (!agentSvc || typeof agentSvc.processInbound !== "function") {
              console.error("inbound-sms: lead route — agent service unavailable; prospect inbound not processed (will retry on Twilio redelivery).");
            } else {
              await agentSvc.processInbound({
                property_id: prop.id,
                person_id: person.id,
                body: body || "(empty message)",
                idempotency_key: MessageSid,
                sms_sid: MessageSid,
              });
            }
          } catch (e) {
            // Handoff failure is non-fatal to Twilio (already acked). The
            // prospect's inbound is not lost: on Twilio's retry the whole
            // resolve→handoff runs again, and the agent's idempotency makes the
            // eventual success exactly-once. Loud log so it's visible.
            console.error("inbound-sms: lead → agent processInbound failed:", e.message);
          }
          return;
        }

        // RESIDENT inbound (unchanged): ONE SPINE, TWO DOORS — the exact same
        // core the browser uses. runInbound records the inbound comm_event
        // (exactly once — the resolver wrote nothing on the resolved path).
        const r = await runInbound({
          personId: person.id, propertyId: prop.id, body: body || "(empty message)",
          channel: "sms", smsSid: MessageSid,
        });

        // Ack Twilio (empty TwiML — the reply travels by REST, not TwiML,
        // so it carries a sid + status receipt like every other text).
        emptyTwiml(res);
        // §15.2 — the work order is valid, but if the resident was never told,
        // that must be ACTIONABLE, not silent.
        //
        // SELF-REVIEW FIX: the first cut only handled `sent:false`. But
        // sendPropertySms awaits sms.sendSms, which can THROW rather than
        // return — and the outer catch below merely logs. T2 has already
        // cleared needs_human by then, so a throwing transport produced
        // exactly the invisible "captured, never acknowledged" state this
        // ruling forbids. A throw is a failed delivery like any other.
        let wire;
        try {
          wire = await commBoundary.sendPropertySms({
            property_id: prop.id, recipient: person.phone, body: r.reply,
            purpose: "ai_reply", person_id: person.id, eventId: r.out.id,
          });
        } catch (sendErr) {
          wire = { sent: false, reason: `transport_threw: ${sendErr.message}`, sid: null };
        }

        //  TWO RECEIPTS, NEVER ONE. The operating receipt above already
        //  describes what was committed and is not revised by anything the
        //  carrier does. This describes only what the wire did. A provider sid
        //  on a failed send stays on the record and still does not make it
        //  delivered.
        const composed = composeReceipt({
          operating: r.operating,
          delivery: deliveryReceipt(wire.sent
            ? { state: "delivered", providerRef: wire.sid || null }
            : { state: "failed", providerRef: wire.sid || null, failureReason: wire.reason || "unknown" }),
        });
        if (!composed.delivery.delivered) {
          await flagUndeliveredReply({ inboundEventId: r.inbound.id,
                                       reason: composed.delivery.failureReason });
        }
      } catch (e) {
        console.error("inbound-sms:", e);
        // Ack anyway if we still can — a 500 makes Twilio retry, and if the
        // save already happened the dedupe turns the retry into a no-op.
        if (!res.headersSent) emptyTwiml(res);
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
      const rawMessages = (await pool.query(
        `select id, direction, channel, body, classification, sender_role,
                created_object_type, created_object_id, needs_human, occurred_at
           from comm_events
          where conversation_id = $1
          order by occurred_at asc, id asc
          limit 500`, [conversationId])).rows;
      // Who said it. Explicit sender_role wins; otherwise derive from the
      // columns we already have so historical rows still render correctly.
      // 'contact' = the other party (prospect or tenant) — the inbound bubble.
      const senderTypeOf = (m) => {
        if (m.sender_role) return m.sender_role;
        if (m.direction === "inbound") return "contact";
        if (["ai_reply", "ai_leasing", "auto_reply"].includes(m.classification)) return "ai";
        return "agent";
      };
      const messages = rawMessages.map((m) => ({ ...m, sender_type: senderTypeOf(m) }));
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
  //  030: when the line is live and the tenant has a phone, the reply
  //  also goes out as a real text from the property line.
  // ════════════════════════════════════════════════════════════════════
  router.post("/conversations/:conversationId/reply", requireOperator, async (req, res) => {
    try {
      const { conversationId } = req.params;
      const body = (req.body && req.body.body || "").trim();
      if (!body) return res.status(400).json({ receipt: "Type a reply first." });
      const convoQ = await pool.query(
        `select c.*, per.name as person_name, per.phone as person_phone, u.unit_number
           from conversations c
           left join persons per on per.id = c.person_id
           left join units u on u.id = c.unit_id
          where c.id = $1`, [conversationId]);
      if (!convoQ.rows.length) return res.status(404).json({ receipt: "No conversation with that id." });
      const convo = convoQ.rows[0];
      const out = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role)
         values ($1,$2,$3,$4,'portal','outbound',$5,'manager_reply','agent') returning id`,
        [convo.property_id, convo.person_id, convo.unit_id, conversationId, body])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [conversationId]);
      // Replying IS handling it — clear the human flag on this thread's inbounds.
      await pool.query(
        `update comm_events set needs_human = false
          where conversation_id = $1 and direction = 'inbound' and needs_human = true`,
        [conversationId]);

      // 030: put it on the tenant's phone if we can. Save-first held above.
      const wire = await commBoundary.sendPropertySms({
        property_id: convo.property_id, recipient: convo.person_phone, body,
        purpose: "agent", person_id: convo.person_id, eventId: out.id,
      });

      res.json({
        receipt: `Message sent to ${firstName(convo.person_name)}${convo.unit_number ? ` in unit ${convo.unit_number}` : ""}${wire.sent ? " — delivered by text" : ""}.`,
        message_id: out.id,
        sms_sent: !!wire.sent,
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
  //  030: the note also rides the wire when the line is live.
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

      // migration 098: the reporter and the affected resident are separate
      // facts. This route notifies the person WAITING on the update — the one
      // who raised it — falling back to the affected resident when staff filed
      // it on someone's behalf. The join follows the same person.
      const woQ = await pool.query(
        `select w.*,
                coalesce(w.reported_by_person_id, w.affected_person_id) as notify_person_id,
                per.name as person_name, per.phone as person_phone, u.unit_number
           from work_orders w
           left join persons per
                  on per.id = coalesce(w.reported_by_person_id, w.affected_person_id)
           left join units u on u.id = w.unit_id
          where w.id = $1`, [workOrderId]);
      if (!woQ.rows.length) return res.status(404).json({ receipt: "No work order with that id." });
      const wo = woQ.rows[0];
      if (!wo.notify_person_id) {
        return res.status(409).json({ receipt: "This work order has no reporting tenant attached — there's nobody to notify." });
      }
      const convoQ = await pool.query(
        `select id from conversations where property_id = $1 and person_id = $2`,
        [wo.property_id, wo.notify_person_id]);
      if (!convoQ.rows.length) {
        return res.status(409).json({ receipt: "That tenant isn't connected to the tenant line yet — send them a setup link first." });
      }

      if (status && status !== wo.status) {
        await pool.query(`update work_orders set status=$1, updated_at=now() where id=$2`, [status, workOrderId]);
      }
      const noteEvt = (await pool.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification)
         values ($1,$2,$3,$4,'portal','outbound',$5,'work_order_update') returning id`,
        [wo.property_id, wo.notify_person_id, wo.unit_id, convoQ.rows[0].id, note])).rows[0];
      await pool.query(`update conversations set last_message_at = now() where id = $1`, [convoQ.rows[0].id]);

      // 030: ride the wire when we can. Save-first held above.
      const wire = await commBoundary.sendPropertySms({
        property_id: wo.property_id, recipient: wo.person_phone, body: note,
        purpose: "agent", person_id: wo.notify_person_id, eventId: noteEvt.id,
      });

      res.json({
        receipt: `Work order ${status && status !== wo.status ? `marked ${status} ` : ""}and ${firstName(wo.person_name)} was notified${wo.unit_number ? ` (unit ${wo.unit_number})` : ""}${wire.sent ? " by text" : ""}.`,
        work_order: { id: workOrderId, status: status || wo.status },
        sms_sent: !!wire.sent,
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
  //  030: the page reads verify_mode from the setup JSON — OTP shows
  //  "Text me a code" + a code input; phone_match keeps the original form.
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
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--ink-dim)}
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
  <h1 id="su-title" class="serif">Connect</h1>
  <div class="sub" id="su-msg"></div>

  <div id="mode-phone" class="hidden">
    <label class="lbl">Your mobile number</label>
    <input id="su-phone" type="tel" inputmode="tel" placeholder="215-555-1212" autocomplete="tel"/>
    <button class="btn full" id="su-go">Connect</button>
  </div>

  <div id="mode-otp" class="hidden">
    <button class="btn full" id="otp-send">Text me a code</button>
    <div id="otp-entry" class="hidden">
      <label class="lbl">6-digit code</label>
      <input id="su-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"/>
      <button class="btn full" id="otp-go">Connect</button>
      <button class="btn full ghost" id="otp-resend" style="margin-top:8px">Resend code</button>
    </div>
  </div>

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
    <div class="section">Report a maintenance issue</div>
    <textarea id="wo-desc" placeholder="Describe the problem — e.g. kitchen faucet won't stop dripping"></textarea>
    <button class="btn" id="wo-go" onclick="reportIssue()">Report issue</button>
    <div id="wo-result" class="sub"></div>
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
      if (d.verify_mode === "otp") {
        $("mode-otp").classList.remove("hidden");
        if (d.masked_phone) $("otp-send").textContent = "Text a code to "+d.masked_phone;
      } else {
        $("mode-phone").classList.remove("hidden");
      }
      show("setup");
    } else { $("dead-msg").textContent = d.message||"Ask your manager for a fresh link."; show("dead"); }
  }catch(e){ $("dead-msg").textContent="Could not load this link. Check your connection."; show("dead"); }
}

async function finishConnect(d){
  SESSION = d.session; localStorage.setItem(SKEY, SESSION);
  const me = await fetch("/tenant/me",{headers:{"x-tenant-session":SESSION}});
  if (me.ok) enterHome(await me.json());
}

// ── link-only fallback path ──
$("su-go").onclick = async ()=>{
  const btn=$("su-go"); btn.disabled=true; btn.textContent="Connecting…";
  try{
    const r = await fetch("/tenant/setup/verify",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:TOKEN, phone:$("su-phone").value})});
    const d = await r.json();
    if(r.ok && d.session) await finishConnect(d);
    else receipt("su-receipt", d.receipt||"That didn't work.", false);
  }catch(e){ receipt("su-receipt","Connection problem — try again.",false); }
  btn.disabled=false; btn.textContent="Connect";
};

// ── OTP path ──
async function sendCode(btn){
  btn.disabled=true; const orig=btn.textContent; btn.textContent="Sending…";
  try{
    const r = await fetch("/tenant/setup/request-code",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:TOKEN})});
    const d = await r.json();
    if(r.ok){ $("otp-entry").classList.remove("hidden"); $("su-code").focus(); receipt("su-receipt", d.receipt, true); }
    else receipt("su-receipt", d.receipt||"Could not send a code.", false);
  }catch(e){ receipt("su-receipt","Connection problem — try again.",false); }
  btn.disabled=false; btn.textContent=orig;
}
$("otp-send").onclick = ()=>sendCode($("otp-send"));
$("otp-resend").onclick = ()=>sendCode($("otp-resend"));
$("otp-go").onclick = async ()=>{
  const btn=$("otp-go"); btn.disabled=true; btn.textContent="Connecting…";
  try{
    const r = await fetch("/tenant/setup/verify",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:TOKEN, code:$("su-code").value})});
    const d = await r.json();
    if(r.ok && d.session) await finishConnect(d);
    else receipt("su-receipt", d.receipt||"That didn't work.", false);
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
async function reportIssue(){
  const desc = ($("wo-desc").value||"").trim();
  if(!desc){ $("wo-result").textContent = "Please describe the issue."; return; }
  $("wo-go").disabled = true;
  try{
    const r = await fetch("/tenant/maintenance",{method:"POST",
      headers:{"Content-Type":"application/json","x-tenant-session":SESSION},
      body:JSON.stringify({description:desc})});
    const d = await r.json();
    if(r.ok){
      $("wo-desc").value = "";
      if(d.urgency==="needs_confirmation" && d.work_order_id){
        $("wo-result").innerHTML = escapeHtml(d.receipt||"") +
          '<div style="margin-top:8px"><textarea id="wo-ans" placeholder="Your answer"></textarea>'+
          '<button class="btn" onclick="answerIssue(\''+d.work_order_id+'\')">Send answer</button></div>';
      } else {
        $("wo-result").textContent = d.receipt || "Request received.";
      }
      const me = await fetch("/tenant/me",{headers:{"x-tenant-session":SESSION}});
      if(me.ok) renderWos((await me.json()).open_work_orders);
    } else {
      $("wo-result").textContent = (d && d.receipt) || "Could not submit.";
    }
  } catch(_){ $("wo-result").textContent = "Could not submit — try again."; }
  finally { $("wo-go").disabled = false; }
}
async function answerIssue(id){
  const ans = ($("wo-ans").value||"").trim();
  if(!ans) return;
  try{
    const r = await fetch("/tenant/maintenance/"+id+"/add",{method:"POST",
      headers:{"Content-Type":"application/json","x-tenant-session":SESSION},
      body:JSON.stringify({text:ans})});
    const d = await r.json();
    $("wo-result").textContent = (d && d.receipt) || "Added.";
    const me = await fetch("/tenant/me",{headers:{"x-tenant-session":SESSION}});
    if(me.ok) renderWos((await me.json()).open_work_orders);
  } catch(_){ $("wo-result").textContent = "Could not add — try again."; }
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
