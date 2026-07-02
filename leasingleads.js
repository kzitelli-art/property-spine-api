// ════════════════════════════════════════════════════════════════════
//  LEASING LEAD INTAKE — leasingleads.js  (re-rooted onto persons)
//
//  ONE HUMAN, MANY PROPERTY-SPECIFIC OPPORTUNITIES.
//   • Identity is GLOBAL: a lead resolves-or-creates a persons row (dedup on
//     normalized phone, else email, across the WHOLE portfolio). Same human
//     across Solo and Felix = ONE person.
//   • Opportunity is PROPERTY-SCOPED: leasing_leads is one (person, property)
//     interest. Sarah on Zillow-for-Solo and web-for-Felix = two opportunities,
//     separate funnels, separate reporting.
//   • Attribution lives in lead_source_touches; persons.source is first-touch
//     acquisition credit only and is never overwritten.
//   • Events are truth; leasing_leads.status is a projection of lead_events.
//   • Messaging reuses comm_events / conversations + the existing sms.js Twilio
//     transport (injected, not rebuilt). Tours and takeover are real objects.
//   • A person is created at intake even for a ghost — a dead lead is still
//     truth (wasted spend, wasted attention), and must be countable.
//
//  Deps mirror tenantlink.js: { pool, anthropic, INGEST_MODEL, sms }.
//  Operator routes gated by shared OPERATOR_KEY (x-operator-key), fail-closed.
//  Public intake door carries its own shared secret (x-intake-secret).
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");

module.exports = function leasingLeadsModule({ pool, anthropic, INGEST_MODEL, sms, leasingLifecycle, conversionServices }) {
  const router = express.Router();

  // ── PHASE B: signed public booking continuation (tour_booking_links, mig 056) ──
  // Store ONLY the digest; the raw token lives solely in the /demo/intake receipt.
  // Reuses the codebase's randomBytes(base64url) → sha256(digest) convention
  // (applicationSubmission.js, lease_packets.js, tenantlink.js).
  function digestBookingToken(raw){ return crypto.createHash("sha256").update(String(raw)).digest("hex"); }
  const DEMO_BOOKING_TTL_MIN = 60; // short window; a demo run is minutes, not days

  // ── SELF-HEAL (runs once at boot; idempotent; never blocks startup) ────
  // The demo door records the honest event 'ai_response_prepared' (prepared,
  // never claimed sent). The lead_events.event_type CHECK from migration 038
  // predates that type, so on an unmigrated database the write fails and the
  // demo door 500s AFTER the lead has already committed. This block widens
  // the CHECK by exactly that one value if — and only if — it's missing.
  // Re-running is a no-op; migration 055 records the same change in the
  // ledger for environments that migrate properly. Failure here is logged
  // and swallowed: a boot must never die on bookkeeping.
  let _selfHealStatus = "starting";
  (async () => {
    try {
      const con = (await pool.query(
        `select con.conname, pg_get_constraintdef(con.oid) as def
         from pg_constraint con join pg_class rel on rel.oid = con.conrelid
         where rel.relname = 'lead_events' and con.contype = 'c'
           and pg_get_constraintdef(con.oid) ilike '%event_type%'`)).rows[0];
      if (con && !con.def.includes("ai_response_prepared")) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query(`alter table lead_events drop constraint "${con.conname}"`);
          await client.query(
            `alter table lead_events add constraint lead_events_event_type_check
             check (event_type in (
               'lead_received','ai_text_sent','ai_response_prepared','prospect_replied',
               'tour_requested','tour_scheduled','human_takeover',
               'application_started','lease_signed','lost'))`);
          await client.query("commit");
          console.log("self-heal: lead_events event_type CHECK widened to accept ai_response_prepared");
          _selfHealStatus = "widened the check just now";
        } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
        finally { client.release(); }
      } else {
        _selfHealStatus = con ? "check already accepts ai_response_prepared" : "no check constraint found on lead_events";
      }
    } catch (e) { console.error("self-heal (lead_events check):", e.message); _selfHealStatus = "FAILED: " + e.message; }
  })();

  // ── AUTH ──────────────────────────────────────────────────────────────
  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header." });
    if (req.headers["x-operator-key"] !== expected) return res.status(401).json({ receipt: "Operator key missing or wrong. Set it in the operator page header." });
    next();
  }
  function requireIntakeSecret(req, res, next) {
    const expected = process.env.LEASING_INTAKE_SECRET || process.env.INTAKE_PASSWORD;
    if (!expected) return res.status(503).json({ receipt: "Lead intake is locked: set LEASING_INTAKE_SECRET in Render's environment." });
    const got = req.headers["x-intake-secret"] || (req.body && req.body.intake_secret);
    if (got !== expected) return res.status(401).json({ receipt: "Intake secret missing or wrong." });
    next();
  }

  // ── helpers ──────────────────────────────────────────────────────────
  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    if (String(raw).startsWith("+")) return String(raw).trim();
    return null;
  }
  function normalizeEmail(raw) {
    if (!raw) return null;
    const e = String(raw).trim().toLowerCase();
    return e.includes("@") ? e : null;
  }
  function firstName(name) { return name ? String(name).trim().split(/\s+/)[0] : "there"; }
  function smsReady() { return !!(sms && sms.enabled()); }

  // Resolve-or-create the HUMAN. Global dedup: phone first, then email, across
  // the whole portfolio. On create, set lifecycle_status='lead' and stamp
  // first-touch source (acquisition credit). On match, NEVER overwrite source;
  // only backfill blank contact fields. Returns { person, createdPerson }.
  async function resolveOrCreatePerson(client, { name, phone, email, source }) {
    let person = null;
    if (phone) person = (await client.query(`select * from persons where phone=$1 order by created_at limit 1`, [phone])).rows[0] || null;
    if (!person && email) person = (await client.query(`select * from persons where lower(email)=lower($1) order by created_at limit 1`, [email])).rows[0] || null;
    if (person) {
      // backfill only what's missing; identity stays put, source is untouched.
      await client.query(
        `update persons set name=coalesce(name,$1), phone=coalesce(phone,$2), email=coalesce(email,$3), updated_at=now() where id=$4`,
        [name || null, phone, email, person.id]);
      return { person, createdPerson: false };
    }
    person = (await client.query(
      `insert into persons (name, phone, email, lifecycle_status, leasing_stage, source)
       values ($1,$2,$3,'lead','lead',$4) returning *`,
      [name || null, phone, email, source || null])).rows[0];
    return { person, createdPerson: true };
  }

  // Write a lead_event AND refresh the opportunity's status projection together
  // so the log and the cached status never drift. statusPatch carries the
  // timestamp columns the funnel pins to events.
  // ── PERSON-SCOPED THREAD (memo §1–2): leasing messaging is NOT a separate
  //    store. A lead is a person at a property, and conversations are keyed
  //    (property_id, person_id) — the exact same grain. This upsert guarantees
  //    the one thread for this human at this property exists, then hands back
  //    its id so every leasing comm_event can attach to it. Idempotent: the
  //    unique (property_id, person_id) index means re-opening a drawer never
  //    spawns a second thread. Mirrors the tenant-line upsert in tenantlink.js
  //    so prospect history and tenant history are literally the same row after
  //    a prospect signs.
  async function ensureConversation(client, { propertyId, personId, unitId = null }) {
    if (!propertyId || !personId) return null;
    await client.query(
      `insert into conversations (property_id, person_id, unit_id, channel_primary, status)
       values ($1,$2,$3,'sms','open')
       on conflict (property_id, person_id) do nothing`,
      [propertyId, personId, unitId]);
    const c = (await client.query(
      `select id from conversations where property_id=$1 and person_id=$2`,
      [propertyId, personId])).rows[0];
    return c ? c.id : null;
  }

  async function recordLeadEvent(client, { leadId, type, actorType, actorId = null, commEventId = null, metadata = null, statusPatch = null }) {
    const ev = (await client.query(
      `insert into lead_events (lead_id, event_type, actor_type, actor_id, comm_event_id, metadata)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [leadId, type, actorType, actorId, commEventId, metadata ? JSON.stringify(metadata) : null])).rows[0];

    const STATUS_FOR = {
      lead_received: "new", ai_text_sent: "ai_responded", ai_response_prepared: "ai_responded", prospect_replied: null,
      tour_requested: "tour_requested", tour_scheduled: "tour_scheduled",
      human_takeover: "human_takeover", application_started: "applied",
      lease_signed: "leased", lost: "lost",
    };
    const RANK = ["new","ai_responded","tour_requested","tour_scheduled","human_takeover","applied","leased","lost"];
    const target = STATUS_FOR[type];
    if (target) {
      const cur = (await client.query(`select status from leasing_leads where id=$1`, [leadId])).rows[0];
      const curStatus = cur ? cur.status : "new";
      const advance = (target === "lost" || target === "leased") ? true : RANK.indexOf(target) > RANK.indexOf(curStatus);
      const sets = []; const vals = []; let i = 1;
      if (advance) { sets.push(`status=$${i++}`); vals.push(target); }
      if (statusPatch) for (const [col, val] of Object.entries(statusPatch)) { sets.push(`${col}=$${i++}`); vals.push(val); }
      if (sets.length) { sets.push(`updated_at=now()`); vals.push(leadId); await client.query(`update leasing_leads set ${sets.join(", ")} where id=$${i}`, vals); }
    } else if (statusPatch) {
      const sets = Object.keys(statusPatch).map((c, idx) => `${c}=$${idx + 1}`);
      const vals = Object.values(statusPatch);
      await client.query(`update leasing_leads set ${sets.join(", ")}, updated_at=now() where id=$${vals.length + 1}`, [...vals, leadId]);
    }
    return ev;
  }

  // Send an SMS for a comm_event that ALREADY EXISTS, then record the wire's
  // answer on the event. Save-first: the message is real even if the wire fails.
  async function smsForEvent({ eventId, to, from, body }) {
    if (!smsReady()) return { sent: false, reason: "transport_not_configured" };
    if (!from) return { sent: false, reason: "no_property_line" };
    if (!to) return { sent: false, reason: "no_phone" };
    const result = await sms.sendSms({ to, from, body });
    try {
      if (result.sent) await pool.query(`update comm_events set sms_sid=$1, sms_status=$2 where id=$3`, [result.sid, result.status || "queued", eventId]);
      else await pool.query(`update comm_events set sms_status='failed', sms_error=$1 where id=$2`, [result.reason + (result.error ? `: ${result.error}` : ""), eventId]);
    } catch (e) { console.error("leasing smsForEvent record:", e.message); }
    return result;
  }

  async function propertyLine(propertyId) {
    try { const r = await pool.query(`select sms_number from properties where id=$1`, [propertyId]); return r.rows.length ? r.rows[0].sms_number : null; }
    catch { return null; }
  }

  // AI's first response: speed + clarity. Surface the unit, offer tour slots,
  // stop. If pricing/availability is unknown, the AI says so rather than
  // inventing it. Deterministic fallback if the model is unavailable.
  async function draftFirstResponse({ name, unitLabel, propertyName, rent }) {
    const slots = "today at 3:00 or tomorrow at 11:00"; // placeholder; real availability plugs in via tours
    const known = unitLabel && rent;
    const fallback = known
      ? `Hi ${firstName(name)} — ${unitLabel} at ${propertyName || "the property"} is available. Rent is $${rent}. We have tours ${slots}. Want either of those?`
      : `Hi ${firstName(name)} — thanks for your interest in ${propertyName || "the property"}! I'm confirming current availability and pricing now. In the meantime, we have tours ${slots} — want to grab one?`;
    if (!anthropic) return fallback;
    try {
      const prompt =
        `You are the leasing assistant for ${propertyName || "an apartment community"}. Write ONE short, warm SMS (under 320 chars) to a prospect named ${firstName(name)}. ` +
        `Goal: confirm the unit is available if known, state rent if given, and offer two concrete tour times (${slots}). ` +
        `If unit or rent is unknown, DO NOT invent it — say you're confirming and still offer the tour. ` +
        `Do NOT try to close a lease, ask for an application, or request documents. End by asking which tour time works. ` +
        `Unit: ${unitLabel || "(unknown — confirming)"}. Rent: ${rent ? "$" + rent : "(unknown — confirming)"}. Reply with ONLY the message text.`;
      const r = await anthropic.messages.create({ model: INGEST_MODEL, max_tokens: 200, messages: [{ role: "user", content: prompt }] });
      const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      return text || fallback;
    } catch (e) { console.error("leasing draftFirstResponse:", e.message); return fallback; }
  }

  // ════════════════════════════════════════════════════════════════════
  //  1. INTAKE — every source lands here.
  //     resolve-or-create PERSON (global) → resolve-or-create OPPORTUNITY
  //     (property-scoped) → touch + lead_received → immediate AI response.
  // ════════════════════════════════════════════════════════════════════
  // ── THE CANONICAL INTAKE SERVICE — one implementation, two doors. ──
  // Called by the authenticated /leasing/intake AND the demo-only /demo/intake.
  // Person creation, phone normalization, lead reuse-or-create, attribution touch,
  // conversation threading, event writing: ONE system. attemptSms=false prepares
  // the AI opening response with NO transport call and NO sent claim
  // ('ai_response_prepared', not 'ai_text_sent').
  // Returns a result object; throws { httpStatus, publicReceipt } on known failures.
  async function intakeProspect(b) {
    const propertyId = b.property_id;
    if (!propertyId) { const e = new Error("property_id is required."); e.httpStatus = 400; e.publicReceipt = e.message; throw e; }

    const phone = normalizePhone(b.phone);
    const email = normalizeEmail(b.email);
    if (!phone && !email) { const e = new Error("A phone or email is required to identify the prospect."); e.httpStatus = 400; e.publicReceipt = e.message; throw e; }
    const sourceName = b.source || b.source_name || null;
    const attemptSms = b.attempt_sms !== false;   // default true (authenticated path unchanged)

    let conversationId = null;
    const client = await pool.connect();
    let person, createdPerson, lead, reusedOpportunity, prop;
    try {
      await client.query("begin");

      prop = (await client.query(`select id, name from properties where id=$1`, [propertyId])).rows[0];
      if (!prop) { await client.query("rollback"); const e = new Error("No property with that id."); e.httpStatus = 404; e.publicReceipt = e.message; throw e; }

      let sourceId = null;
      if (sourceName) {
        const s = (await client.query(`select id from lead_sources where lower(name)=lower($1)`, [sourceName])).rows[0];
        sourceId = s ? s.id : null;
      }

      // ── GLOBAL identity: one human across the portfolio ──
      const rp = await resolveOrCreatePerson(client, { name: b.name, phone, email, source: sourceName });
      person = rp.person; createdPerson = rp.createdPerson;

      // ── PROPERTY-SCOPED opportunity: reuse the open one for this (person,
      //    property), else open a new one. Repeat touch ≠ new opportunity. ──
      lead = (await client.query(
        `select * from leasing_leads where person_id=$1 and property_id=$2 and status not in ('leased','lost') order by created_at limit 1`,
        [person.id, propertyId])).rows[0] || null;

      reusedOpportunity = !!lead;
      if (lead) {
        if (b.unit_id) await client.query(`update leasing_leads set unit_id=coalesce(unit_id,$1), updated_at=now() where id=$2`, [b.unit_id, lead.id]);
      } else {
        lead = (await client.query(
          `insert into leasing_leads (person_id, property_id, unit_id, source_id, source_lead_id, source_listing_id, message, raw_payload)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [person.id, propertyId, b.unit_id || null, sourceId, b.source_lead_id || null, b.source_listing_id || null, b.message || null,
           b.raw_payload ? JSON.stringify(b.raw_payload) : JSON.stringify(b)])).rows[0];
      }

      // every arrival is a touch (attribution).
      await client.query(
        `insert into lead_source_touches (lead_id, person_id, source_id, source_lead_id, source_listing_id, raw_payload)
         values ($1,$2,$3,$4,$5,$6)`,
        [lead.id, person.id, sourceId, b.source_lead_id || null, b.source_listing_id || null, JSON.stringify(b)]);

      await recordLeadEvent(client, {
        leadId: lead.id, type: "lead_received", actorType: "prospect", actorId: person.id,
        metadata: { source: sourceName, repeat: reusedOpportunity },
      });

      // ── THREAD IT (memo §2.2: never an orphaned event). The conversation-queue
      //    projection inner-joins conversations — without this row an intake lead is
      //    INVISIBLE to the operator door. Upsert on (property, person): a repeat
      //    submit reuses the same conversation (idempotent by the natural key). ──
      conversationId = await ensureConversation(client, {
        propertyId: propertyId, personId: person.id, unitId: lead.unit_id || null,
      });

      await client.query("commit");

      // ── Immediate AI first response (outside the txn; lead is durable). ──
      let responseReceipt = "Opportunity saved. No phone on file, so no text sent — the team can follow up by email.";
      let firstResponseSent = false;
      let draftBody = null;
      if (phone) {
        let unitLabel = null, rent = null;
        if (lead.unit_id) {
          const u = (await pool.query(`select unit_number, market_rent from units where id=$1`, [lead.unit_id])).rows[0];
          if (u) { unitLabel = u.unit_number ? `Unit ${u.unit_number}` : null; rent = u.market_rent || null; }
        }
        const body = await draftFirstResponse({ name: person.name, unitLabel, propertyName: prop.name, rent });
        draftBody = body;

        // THREADED outbound: conversation_id + sender_role so the message lives on the
        // person's one thread (the door reads it). provider_status stays NULL — the
        // projection treats that as NOT delivered, which is the truth until a carrier
        // confirms dispatch.
        const commEvent = (await pool.query(
          `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role)
           values ($1,$2,$3,$4,'text','outbound',$5,'leasing','ai') returning id`,
          [propertyId, person.id, lead.unit_id, conversationId, body])).rows[0];
        if (conversationId) await pool.query(`update conversations set last_message_at = now() where id=$1`, [conversationId]);

        if (attemptSms) {
          const line = await propertyLine(propertyId);
          const wire = await smsForEvent({ eventId: commEvent.id, to: phone, from: line, body });
          firstResponseSent = wire.sent;

          const c2 = await pool.connect();
          try {
            await c2.query("begin");
            await recordLeadEvent(c2, {
              leadId: lead.id, type: "ai_text_sent", actorType: "ai", commEventId: commEvent.id,
              metadata: { sent: wire.sent, reason: wire.reason || null },
              statusPatch: { first_response_at: new Date().toISOString() },
            });
            await c2.query("commit");
          } catch (e) { await c2.query("rollback"); throw e; } finally { c2.release(); }

          responseReceipt = wire.sent
            ? `AI texted ${firstName(person.name)} from the property line. Draft: "${body}"`
            : `Opportunity saved and AI reply drafted, but the text didn't go out (${wire.reason}). Draft is on the message for the team: "${body}"`;
        } else {
          // NO transport call, NO sent claim. The truthful facts: inquiry received,
          // person/conversation created, AI opening response PREPARED. The event type
          // says exactly that ('ai_response_prepared' — never 'ai_text_sent').
          firstResponseSent = false;
          const c2 = await pool.connect();
          try {
            await c2.query("begin");
            await recordLeadEvent(c2, {
              leadId: lead.id, type: "ai_response_prepared", actorType: "ai", commEventId: commEvent.id,
              metadata: { sent: false, prepared: true, channel: b.response_channel || "demo_browser" },
              statusPatch: { first_response_at: new Date().toISOString() },
            });
            await c2.query("commit");
          } catch (e) { await c2.query("rollback"); throw e; } finally { c2.release(); }
          responseReceipt = `AI opening response prepared (no message dispatched). Draft: "${body}"`;
        }
      }

      const who = createdPerson ? "New prospect" : "Known prospect";
      const what = reusedOpportunity ? `added a ${sourceName || "new"} touch to their open ${prop.name} opportunity` : `opened a new ${prop.name} opportunity`;
      return {
        receipt: `${who} — ${what}. ${responseReceipt}`,
        person_id: person.id, lead_id: lead.id, conversation_id: conversationId,
        new_person: createdPerson, reused_opportunity: reusedOpportunity,
        first_response_sent: firstResponseSent, status: lead.status, draft_body: draftBody,
        property_name: prop.name,
      };
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      throw e;
    } finally { client.release(); }
  }

  // ── 1. AUTHENTICATED INTAKE (unchanged contract) — thin wrapper on the service. ──
  router.post("/leasing/intake", requireIntakeSecret, async (req, res) => {
    try {
      const out = await intakeProspect(req.body || {});
      return res.json({
        receipt: out.receipt, person_id: out.person_id, lead_id: out.lead_id,
        new_person: out.new_person, reused_opportunity: out.reused_opportunity,
        first_response_sent: out.first_response_sent, status: out.status,
      });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ receipt: e.publicReceipt || e.message });
      console.error("leasing intake:", e);
      return res.status(500).json({ receipt: "Could not capture the lead.", error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  PUBLIC DEMO INTAKE — POST /demo/intake  (Boardroom Live Mode, entry 1)
  //  A constrained public door into the SAME intakeProspect service — not a
  //  second implementation. Fail-closed controls:
  //    • DEMO_MODE=true required (absent/false → 403, same as /demo/operator-session)
  //    • property is SERVER-DERIVED: always the property named DEMO_INTAKE_PROP_NAME
  //      (the identical constant operator.js uses to mint the door's session, so the
  //      form and the door are guaranteed to agree). A client-supplied property_id
  //      is IGNORED — an env typo cannot redirect public lead creation into a live
  //      asset because no env var carries the property at all.
  //    • rate-limited BEFORE any DB work, by IP AND by normalized phone — a limited
  //      request creates no partial person/lead/conversation.
  //    • honeypot: bots that fill the hidden 'company' field get a generic success
  //      and NOTHING is created.
  //    • tight validation on name + phone.
  //    • records are tagged source='boardroom_demo' (lead source + person first-touch
  //      + raw_payload.channel) so a boardroom session can be reset without touching
  //      seeded-sandbox or production records.
  //    • attempt_sms=false: the AI opening response is PREPARED, never claimed sent
  //      ('ai_response_prepared'). No transport call is made.
  // ════════════════════════════════════════════════════════════════════
  const DEMO_INTAKE_PROP_NAME = "Property Spine Demo Building"; // MUST match operator.js DEMO_PROP_NAME
  const DEMO_INTAKE_SOURCE = "boardroom_demo";
  const _demoRate = { ip: new Map(), phone: new Map() };
  function _rateOk(map, key, max, windowMs) {
    const now = Date.now();
    let e = map.get(key);
    if (!e || now - e.start > windowMs) { e = { start: now, n: 0 }; map.set(key, e); }
    e.n += 1;
    if (map.size > 5000) { for (const [k, v] of map) { if (now - v.start > windowMs) map.delete(k); } }
    return e.n <= max;
  }

  // TEMP DIAGNOSTIC — GET status page, viewable in a normal browser.
  router.get("/demo/intake/health", async (req, res) => {
    res.set("Cache-Control", "no-store");
    let db = "unknown", checkdef = null;
    try {
      await pool.query("select 1");
      db = "connected";
      const c = (await pool.query(
        `select pg_get_constraintdef(con.oid) as def
         from pg_constraint con join pg_class rel on rel.oid = con.conrelid
         where rel.relname = 'lead_events' and con.contype = 'c'
           and pg_get_constraintdef(con.oid) ilike '%event_type%'`)).rows[0];
      checkdef = c ? (c.def.includes("ai_response_prepared") ? "ACCEPTS ai_response_prepared" : "STILL OLD — missing ai_response_prepared") : "no constraint found";
    } catch (e) { db = "ERROR: " + e.message; }
    return res.json({
      build: "diag-1 (self-heal + verbose errors)",
      demo_mode: String(process.env.DEMO_MODE || "").toLowerCase() === "true",
      database: db,
      lead_events_check: checkdef,
      self_heal: _selfHealStatus,
    });
  });

  router.post("/demo/intake", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      // ── fail-closed: demo mode only ──
      if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true") {
        return res.status(403).json({ receipt: "The live demo is not enabled on this deployment." });
      }
      const b = req.body || {};

      // ── honeypot: the public form carries a hidden 'company' field no human sees.
      //    A filled honeypot gets a bland success and creates NOTHING. ──
      if (typeof b.company === "string" && b.company.trim() !== "") {
        return res.json({ ok: true, receipt: "Your inquiry was received." });
      }

      // ── tight validation (public door) ──
      //    The form now sends first_name + last_name; a legacy single `name`
      //    still works. Same 2..80 human-name rule applies to the built name.
      const _fn = typeof b.first_name === "string" ? b.first_name.trim().slice(0, 40) : "";
      const _ln = typeof b.last_name  === "string" ? b.last_name.trim().slice(0, 40)  : "";
      const name = (typeof b.name === "string" && b.name.trim()) ? b.name.trim() : [_fn, _ln].filter(Boolean).join(" ");
      if (name.length < 2 || name.length > 80 || !/[a-zA-Z]/.test(name)) {
        return res.status(400).json({ receipt: "Please enter your name." });
      }
      const phone = normalizePhone(b.phone);
      if (!phone || !/^\+1\d{10}$/.test(phone)) {
        return res.status(400).json({ receipt: "Please enter a valid US mobile number." });
      }

      // ── rate limits BEFORE any DB touch: nothing partial is ever created ──
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim();
      if (!_rateOk(_demoRate.ip, ip, 10, 10 * 60 * 1000)) {
        return res.status(429).json({ receipt: "Too many requests — please wait a few minutes." });
      }
      if (!_rateOk(_demoRate.phone, phone, 3, 10 * 60 * 1000)) {
        return res.status(429).json({ receipt: "That number just signed up — the manager workspace already has your inquiry." });
      }

      // ── SERVER-DERIVED demo property (client property_id ignored entirely) ──
      const prop = (await pool.query(
        "select id, name from properties where name=$1 order by created_at asc limit 1",
        [DEMO_INTAKE_PROP_NAME]
      )).rows[0];
      if (!prop) {
        return res.status(409).json({ receipt: "The demo property is not seeded yet — start the demo first." });
      }

      // ── ensure the tagging source exists (demo-scope only; the authenticated
      //    intake's source behavior is unchanged) ──
      await pool.query(
        `insert into lead_sources (name, source_type) values ($1, 'manual') on conflict do nothing`,
        [DEMO_INTAKE_SOURCE]
      );

      // ── the ONE canonical intake, constrained ──
      const out = await intakeProspect({
        property_id: prop.id,                    // server-derived, never from the browser
        name: name, phone: phone,
        source: DEMO_INTAKE_SOURCE,              // person first-touch + lead source tag
        attempt_sms: false,                      // prepared, never claimed sent
        response_channel: "demo_browser",
        raw_payload: {
          channel: "demo_public_intake", idempotency_key: b.idempotency_key || null,
          // stated preference captured AT THE SOURCE (first-party, not inferred):
          // a YYYY-MM within the next 12 months, or 'flexible'. Anything else → null.
          desired_move_month: (function (v) {
            if (v === "flexible") return "flexible";
            if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return null;
            const now = new Date(); const cur = now.getFullYear() * 12 + now.getMonth();
            const [y, m] = v.split("-").map(Number); const tgt = y * 12 + (m - 1);
            return (tgt >= cur && tgt <= cur + 12) ? v : null;
          })(b.desired_move_month),
          first_name: _fn || null, last_name: _ln || null,
        },
      });

      // PHASE B: mint a signed, short-lived booking continuation. The prospect can
      // book a tour straight from this receipt with NO operator key and WITHOUT any
      // raw db id crossing to the browser — only the opaque bearer token does. The
      // property is pinned to the Demo Building here (server-derived) and re-verified
      // in /demo/book. A best-effort insert: if it fails, the demo still captured the
      // lead — booking just isn't offered (honest degrade, never a 500 for the lead).
      let bookingToken = null;
      try {
        if (out.conversation_id) {
          const rawTok = crypto.randomBytes(24).toString("base64url");
          const expiresAt = new Date(Date.now() + DEMO_BOOKING_TTL_MIN * 60000).toISOString();
          await pool.query(
            `insert into tour_booking_links
               (token_digest, conversation_id, person_id, lead_id, property_id, phone_snapshot, expires_at)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [digestBookingToken(rawTok), out.conversation_id, out.person_id || null,
             out.lead_id || null, prop.id, phone || null, expiresAt]
          );
          bookingToken = rawTok;
        }
      } catch (mintErr) {
        console.error("demo booking-link mint (non-fatal):", mintErr.message);
      }

      // constraint 5's honest confirmation — no text has gone out.
      return res.json({
        ok: true,
        receipt: "Your inquiry was received. In this demo, it will now appear in the manager workspace.",
        person_id: out.person_id, conversation_id: out.conversation_id,
        new_person: out.new_person, reused: out.reused_opportunity,
        booking_token: bookingToken,                 // null if minting was skipped/failed
        booking_expires_in_min: bookingToken ? DEMO_BOOKING_TTL_MIN : null,
      });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ receipt: e.publicReceipt || e.message });
      console.error("demo intake:", e);
      // TEMP DIAGNOSTIC — revert to the plain receipt once the demo path is proven.
      return res.status(500).json({ receipt: "Could not capture the inquiry. [diagnostic: " + (e.message || "unknown error") + "]" });
    }
  });

  // ── 1b. PUBLIC TOUR BOOKING (boardroom demo) ──────────────────────────
  //  The ONLY public tour-creation door. No operator key. Authority is the
  //  signed booking token minted at /demo/intake (tour_booking_links, mig 056):
  //  the browser presents the opaque token + a slot_id — never a raw lead or
  //  conversation id. Every wall the authenticated /leasing/slots/:id/book has,
  //  plus three more:
  //    • DEMO_MODE required (403 if absent) — same fail-closed as /demo/intake.
  //    • SCOPE WALL: the link's property MUST be the Demo Building; a booking can
  //      never land on a live property even if the row were tampered with.
  //    • CLOSED-NOT-FIT GUARD: assertNotSoftClosedForTour runs inside the txn
  //      (this is what finally WIRES that dormant guard) — a closed conversation
  //      cannot be booked without an explicit reopen.
  //  Idempotent: a link is single-use (status flips to 'consumed'); a double-tap
  //  returns the SAME tour, never a second one. The structural double-booking
  //  wall (for-update + status check + partial unique index) is unchanged.
  router.post("/demo/book", async (req, res) => {
    // KILL SWITCH (distinct from DEMO_MODE): public booking is OFF unless the
    // operator deliberately sets DEMO_BOOKING_ENABLED=true in the server env.
    // Server-owned only — no browser request, query param, localStorage value, or
    // UI state can flip it. DEMO_MODE gates intake; this SEPARATELY gates writes.
    if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true" ||
        String(process.env.DEMO_BOOKING_ENABLED || "").toLowerCase() !== "true") {
      return res.status(403).json({ receipt: "The demo booking door is not enabled." });
    }
    const b = req.body || {};
    const rawToken = b.booking_token || b.token;
    const slotId = b.slot_id;
    if (!rawToken) return res.status(400).json({ receipt: "A booking token is required." });
    if (!slotId)   return res.status(400).json({ receipt: "A slot_id is required to book." });

    const DEMO_INTAKE_PROP_NAME = "Property Spine Demo Building"; // MUST match /demo/intake + operator.js
    const client = await pool.connect();
    try {
      await client.query("begin");

      // 1) resolve the link by DIGEST (raw token never stored). Lock it so two
      //    taps can't both consume it.
      const link = (await client.query(
        `select * from tour_booking_links where token_digest=$1 for update`,
        [digestBookingToken(rawToken)])).rows[0];
      if (!link) { await client.query("rollback"); return res.status(404).json({ receipt: "That booking link is not valid." }); }

      // 2) IDEMPOTENCY: if already consumed, return the same tour (no second tour).
      if (link.status === "consumed" && link.booked_tour_id) {
        const existing = (await client.query(`select scheduled_for from leasing_tours where id=$1`, [link.booked_tour_id])).rows[0];
        await client.query("commit");
        return res.json({ receipt: `You're already booked${existing && existing.scheduled_for ? " for " + existing.scheduled_for : ""}.`, tour_id: link.booked_tour_id, already_booked: true });
      }
      if (link.status === "revoked") { await client.query("rollback"); return res.status(409).json({ receipt: "This booking link is no longer active." }); }
      if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
        await client.query(`update tour_booking_links set status='expired', updated_at=now() where id=$1`, [link.id]);
        await client.query("commit");
        return res.status(409).json({ receipt: "This booking link has expired." });
      }

      // 3) SCOPE WALL: the link's property must be the Demo Building. Re-verify by
      //    name, so a tampered property_id can't aim a booking at a live property.
      const demoProp = (await client.query(`select id, name from properties where name=$1`, [DEMO_INTAKE_PROP_NAME])).rows[0];
      if (!demoProp || demoProp.id !== link.property_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "This booking link is not valid for this property." });
      }

      // 4) OPTIONAL consistency check: if a phone is presented, it must match the
      //    snapshot. The token is the authority; this only catches obvious misuse.
      if (b.phone && link.phone_snapshot) {
        const norm = normalizePhone(b.phone);
        if (norm && norm !== link.phone_snapshot) {
          await client.query("rollback");
          return res.status(409).json({ receipt: "That phone number doesn't match this booking link." });
        }
      }

      // 5) CLOSED-NOT-FIT GUARD (this WIRES the dormant guard). Refuses a booking
      //    on a conversation that was closed-not-fit without an explicit reopen.
      if (leasingLifecycle && typeof leasingLifecycle.assertNotSoftClosedForTour === "function") {
        await leasingLifecycle.assertNotSoftClosedForTour(client, { conversationId: link.conversation_id });
      }

      // 6) lock the slot; only book if STILL open — the structural wall.
      const slot = (await client.query(`select * from tour_availability where id=$1 for update`, [slotId])).rows[0];
      if (!slot) { await client.query("rollback"); return res.status(404).json({ receipt: "No slot with that id." }); }
      if (slot.status !== "open") { await client.query("rollback"); return res.status(409).json({ receipt: "That time was just taken. Please pick another." }); }
      if (slot.property_id !== link.property_id) { await client.query("rollback"); return res.status(409).json({ receipt: "That slot isn't at this property." }); }

      // 7) resolve the lead behind this conversation (server-side; never from browser).
      const lead = (await client.query(
        `select * from leasing_leads where id=$1`, [link.lead_id])).rows[0]
        || (await client.query(
             `select l.* from leasing_leads l
                join conversations c on c.person_id=l.person_id and c.property_id=l.property_id
               where c.id=$1 and l.status not in ('lost') order by l.created_at limit 1`,
             [link.conversation_id])).rows[0];
      if (!lead) { await client.query("rollback"); return res.status(404).json({ receipt: "Could not find the inquiry for this booking." }); }
      // SCOPE WALL (same threat model as step 3): the resolved lead must belong to
      // the link's (Demo Building) property. Under normal mint this always holds;
      // this closes the tampered-lead_id row case so a tour can NEVER be created
      // with a live property's lead through this door.
      if (lead.property_id !== link.property_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "This booking link is not valid for this inquiry." });
      }

      // 7.5) CONVERSATION-GRAIN IDEMPOTENCY: re-inquiry mints a fresh token for the
      //      SAME open lead (038's one-open-opportunity-per-person-property index).
      //      If a live tour already exists for this lead, a second token must NOT
      //      create a duplicate — it converges on the existing tour and this link
      //      is consumed pointing at it. (Rescheduling stays an operator action.)
      const liveTour = (await client.query(
        `select id, scheduled_for from leasing_tours
          where lead_id=$1 and status in ('scheduled','confirmed_by_prospect','checked_in')
          order by created_at asc limit 1`, [lead.id])).rows[0];
      if (liveTour) {
        await client.query(
          `update tour_booking_links set status='consumed', booked_tour_id=$1, consumed_at=now(), updated_at=now() where id=$2`,
          [liveTour.id, link.id]);
        await client.query("commit");
        return res.json({ receipt: `You're already booked${liveTour.scheduled_for ? " for " + liveTour.scheduled_for : ""}.`, tour_id: liveTour.id, already_booked: true });
      }

      // 8) create the tour on this slot (status 'scheduled'). commercial_state=
      //    booked_tour is DERIVED by the queue projection from this live tour —
      //    no lead status is mutated here (D-6).
      const tour = (await client.query(
        `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status)
         values ($1,$2,$3,$4,$5,$6,'scheduled') returning *`,
        [lead.id, lead.property_id, slot.unit_id, slot.leasing_agent_id, slotId, slot.starts_at])).rows[0];

      // 9) flip the slot to booked (partial unique index is the race backstop).
      await client.query(
        `update tour_availability set status='booked', booked_tour_id=$1, updated_at=now() where id=$2`,
        [tour.id, slotId]);

      // 10) tour_events: scheduled — actor is the prospect (they booked it).
      await recordTourEvent(client, {
        tourId: tour.id, leadId: lead.id, type: "scheduled",
        actorType: "prospect", actorId: lead.person_id, slotId,
        metadata: { scheduled_for: slot.starts_at, slot_id: slotId, via: "public_demo_booking" },
      });

      // 11) funnel advances via the SAME recordLeadEvent the operator path uses.
      await recordLeadEvent(client, {
        leadId: lead.id, type: "tour_scheduled", actorType: "system",
        metadata: { tour_id: tour.id, slot_id: slotId, scheduled_for: slot.starts_at, via: "public_demo_booking" },
        statusPatch: { tour_scheduled_at: slot.starts_at },
      });

      // 12) consume the link (single-use).
      await client.query(
        `update tour_booking_links set status='consumed', booked_tour_id=$1, consumed_at=now(), updated_at=now() where id=$2`,
        [tour.id, link.id]);
      // 12b) revoke any SIBLING issued links for this conversation (e.g. from a
      //      re-inquiry): once booked, outstanding public booking authority for
      //      this conversation collapses to zero. Read paths already show
      //      'already booked' for consumed; revoked siblings can't book at all.
      await client.query(
        `update tour_booking_links set status='revoked', updated_at=now()
          where conversation_id=$1 and status='issued' and id<>$2`,
        [link.conversation_id, link.id]);

      await client.query("commit");
      return res.json({
        receipt: `You're booked for ${slot.starts_at}. See you then!`,
        tour_id: tour.id, slot_id: slotId, scheduled_for: slot.starts_at,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.httpStatus === 409) return res.status(409).json({ receipt: e.publicMessage || e.message || "This conversation needs to be reopened before booking." });
      if (e.code === "23505") return res.status(409).json({ receipt: "That time was just taken. Please pick another." });
      console.error("demo book:", e);
      // TEMP DIAGNOSTIC (revert with the /demo/intake diagnostic, D-9): e.message
      // is exposed on this PUBLIC route only during the proving phase.
      return res.status(500).json({ receipt: "Could not complete the booking.", error: e.message });
    } finally { client.release(); }
  });

  // ── 1c. PUBLIC OPEN-SLOT LIST (boardroom demo) ────────────────────────
  //  The booking UI needs to show the prospect open times. Token-gated (not an
  //  open enumeration of the calendar) and Demo-Building-scoped: a valid booking
  //  token is required, and only OPEN slots at the Demo Building are returned.
  router.get("/demo/slots", async (req, res) => {
    // Same distinct kill switch as /demo/book — the slot list is part of the
    // booking door and must be dark unless DEMO_BOOKING_ENABLED=true (server env).
    if (String(process.env.DEMO_MODE || "").toLowerCase() !== "true" ||
        String(process.env.DEMO_BOOKING_ENABLED || "").toLowerCase() !== "true") {
      return res.status(403).json({ receipt: "The demo booking door is not enabled." });
    }
    const rawToken = req.query.booking_token || req.query.token;
    if (!rawToken) return res.status(400).json({ receipt: "A booking token is required to see open times." });
    try {
      const link = (await pool.query(
        `select property_id, status, expires_at from tour_booking_links where token_digest=$1`,
        [digestBookingToken(rawToken)])).rows[0];
      if (!link) return res.status(404).json({ receipt: "That booking link is not valid." });
      if (link.status === "consumed") return res.json({ receipt: "You're already booked.", already_booked: true, slots: [] });
      if (link.status === "revoked" || (link.expires_at && new Date(link.expires_at).getTime() < Date.now())) {
        return res.status(409).json({ receipt: "This booking link is no longer active.", slots: [] });
      }
      // only OPEN, FUTURE slots at THIS (demo) property.
      const slots = (await pool.query(
        `select id, starts_at, ends_at, unit_id from tour_availability
          where property_id=$1 and status='open' and starts_at > now()
          order by starts_at asc limit 24`,
        [link.property_id])).rows;
      return res.json({ receipt: `${slots.length} open time(s).`, slots });
    } catch (e) {
      console.error("demo slots:", e);
      // TEMP DIAGNOSTIC (revert with the /demo/intake diagnostic, D-9): e.message
      // is exposed on this PUBLIC route only during the proving phase.
      return res.status(500).json({ receipt: "Could not load open times.", error: e.message });
    }
  });

  // ── 2. PROSPECT REPLY (transport-agnostic; SMS webhook or operator UI) ──
  router.post("/leasing/leads/:leadId/reply", requireOperator, async (req, res) => {
    const { leadId } = req.params;
    const text = (req.body && req.body.body) || "";
    const client = await pool.connect();
    try {
      await client.query("begin");
      const lead = (await client.query(`select * from leasing_leads where id=$1`, [leadId])).rows[0];
      if (!lead) { await client.query("rollback"); return res.status(404).json({ receipt: "No opportunity with that id." }); }
      // Attach to the person's one thread (memo §2.2): never an orphaned event.
      const conversationId = await ensureConversation(client, {
        propertyId: lead.property_id, personId: lead.person_id, unitId: lead.unit_id,
      });
      const commEvent = (await client.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role)
         values ($1,$2,$3,$4,'text','inbound',$5,'leasing','prospect') returning id`,
        [lead.property_id, lead.person_id, lead.unit_id, conversationId, text])).rows[0];
      if (conversationId) await client.query(`update conversations set last_message_at = now() where id = $1`, [conversationId]);
      await recordLeadEvent(client, { leadId, type: "prospect_replied", actorType: "prospect", actorId: lead.person_id, commEventId: commEvent.id, metadata: { body: text } });
      // GENUINE-INBOUND REOPEN: this is a qualifying prospect inbound. If the conversation
      // is soft-closed (closed_not_fit), reopen it in THIS transaction. No-op otherwise;
      // idempotent under the conversation lock. (Foundation 054.)
      if (leasingLifecycle && conversationId && text && String(text).trim() !== "") {
        await leasingLifecycle.maybeReopenOnQualifyingInbound(client, {
          conversationId, sourceCommEventId: commEvent.id,
        });
      }
      await client.query("commit");
      return res.json({ receipt: "Reply logged.", lead_id: leadId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing reply:", e); return res.status(500).json({ receipt: "Could not log the reply.", error: e.message }); }
    finally { client.release(); }
  });

  // ── 3. TOUR — request, then confirm (confirm opens the takeover queue) ──
  router.post("/leasing/leads/:leadId/tour/request", requireOperator, async (req, res) => {
    const { leadId } = req.params;
    const requestedFor = req.body && req.body.requested_for ? req.body.requested_for : null;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const lead = (await client.query(`select * from leasing_leads where id=$1`, [leadId])).rows[0];
      if (!lead) { await client.query("rollback"); return res.status(404).json({ receipt: "No opportunity with that id." }); }
      const tour = (await client.query(
        `insert into leasing_tours (lead_id, property_id, unit_id, requested_for, status) values ($1,$2,$3,$4,'requested') returning *`,
        [leadId, lead.property_id, lead.unit_id, requestedFor])).rows[0];
      await recordLeadEvent(client, { leadId, type: "tour_requested", actorType: "prospect", actorId: lead.person_id, metadata: { tour_id: tour.id, requested_for: requestedFor } });
      await client.query("commit");
      return res.json({ receipt: `Tour requested${requestedFor ? " for " + requestedFor : ""}. Confirm it to put it on the team's queue.`, tour_id: tour.id });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing tour request:", e); return res.status(500).json({ receipt: "Could not request the tour.", error: e.message }); }
    finally { client.release(); }
  });

  router.post("/leasing/tours/:tourId/confirm", requireOperator, async (req, res) => {
    const { tourId } = req.params;
    const scheduledFor = req.body && req.body.scheduled_for ? req.body.scheduled_for : null;
    const confirmedBy = req.body && req.body.confirmed_by ? req.body.confirmed_by : null;
    if (!scheduledFor) return res.status(400).json({ receipt: "scheduled_for is required to confirm a tour." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      // NOTE: this legacy route confirms WITHOUT a real availability slot (it
      // takes a hand-typed scheduled_for). It stamps confirmed_by and scheduled_for,
      // then goes through the new door so status='confirmed_by_prospect' and a
      // tour_event is written — never the deleted 038 word 'confirmed'.
      await client.query(`update leasing_tours set scheduled_for=$1, confirmed_by=$2, updated_at=now() where id=$3`, [scheduledFor, confirmedBy, tourId]);
      await recordTourEvent(client, { tourId, leadId: tour.lead_id, type: "confirmed_by_prospect", actorType: "human", actorId: confirmedBy, metadata: { scheduled_for: scheduledFor, via: "legacy_confirm" } });
      await recordLeadEvent(client, { leadId: tour.lead_id, type: "tour_scheduled", actorType: "human", actorId: confirmedBy, metadata: { tour_id: tourId, scheduled_for: scheduledFor }, statusPatch: { tour_scheduled_at: scheduledFor } });
      await client.query(`insert into lead_takeover_queue (lead_id, property_id, reason, status) values ($1,$2,$3,'open')`, [tour.lead_id, tour.property_id, "Tour confirmed — on-site team to run the tour and close."]);
      await recordLeadEvent(client, { leadId: tour.lead_id, type: "human_takeover", actorType: "system", metadata: { trigger: "tour_confirmed", tour_id: tourId }, statusPatch: { human_takeover_at: new Date().toISOString() } });
      await client.query("commit");
      return res.json({ receipt: `Tour confirmed for ${scheduledFor}. Opportunity handed to the on-site team's queue.`, tour_id: tourId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing tour confirm:", e); return res.status(500).json({ receipt: "Could not confirm the tour.", error: e.message }); }
    finally { client.release(); }
  });

  // ── 4. TAKEOVER QUEUE ──
  router.get("/properties/:propertyId/leasing/queue", requireOperator, async (req, res) => {
    try {
      const r = await pool.query(
        `select q.*, p.name, p.phone, p.email, l.status as lead_status,
                l.person_id, c.id as conversation_id
           from lead_takeover_queue q
           join leasing_leads l on l.id = q.lead_id
           join persons p on p.id = l.person_id
           left join conversations c
                  on c.property_id = l.property_id and c.person_id = l.person_id
          where q.property_id=$1 and q.status <> 'resolved' order by q.created_at`,
        [req.params.propertyId]);
      return res.json({ receipt: `${r.rows.length} item(s) waiting for the on-site team.`, items: r.rows });
    } catch (e) { console.error("leasing queue:", e); return res.status(500).json({ receipt: "Could not load the queue.", error: e.message }); }
  });

  router.post("/leasing/queue/:itemId/claim", requireOperator, async (req, res) => {
    const assignee = req.body && req.body.assignee_id ? req.body.assignee_id : null;
    if (!assignee) return res.status(400).json({ receipt: "assignee_id is required to claim." });
    try {
      const r = await pool.query(`update lead_takeover_queue set status='claimed', assignee_id=$1, claimed_at=now() where id=$2 and status='open' returning *`, [assignee, req.params.itemId]);
      if (!r.rows.length) return res.status(409).json({ receipt: "That item is already claimed or resolved." });
      return res.json({ receipt: "Claimed.", item: r.rows[0] });
    } catch (e) { console.error("leasing claim:", e); return res.status(500).json({ receipt: "Could not claim the item.", error: e.message }); }
  });

  router.post("/leasing/queue/:itemId/resolve", requireOperator, async (req, res) => {
    try {
      const r = await pool.query(`update lead_takeover_queue set status='resolved', resolved_at=now() where id=$1 and status <> 'resolved' returning *`, [req.params.itemId]);
      if (!r.rows.length) return res.status(409).json({ receipt: "That item is already resolved." });
      return res.json({ receipt: "Resolved.", item: r.rows[0] });
    } catch (e) { console.error("leasing resolve:", e); return res.status(500).json({ receipt: "Could not resolve the item.", error: e.message }); }
  });

  // ── 5. LOST — manual for v1 ──
  router.post("/leasing/leads/:leadId/lost", requireOperator, async (req, res) => {
    const { leadId } = req.params;
    const reason = (req.body && req.body.reason) || null;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const lead = (await client.query(`select id from leasing_leads where id=$1`, [leadId])).rows[0];
      if (!lead) { await client.query("rollback"); return res.status(404).json({ receipt: "No opportunity with that id." }); }
      await recordLeadEvent(client, { leadId, type: "lost", actorType: "human", metadata: { reason } });
      await client.query("commit");
      return res.json({ receipt: "Opportunity marked lost.", lead_id: leadId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing lost:", e); return res.status(500).json({ receipt: "Could not mark lost.", error: e.message }); }
    finally { client.release(); }
  });

  // ── 6. READS — one opportunity's funnel; the human's portfolio of opportunities; the source report ──
  router.get("/leasing/leads/:leadId", requireOperator, async (req, res) => {
    try {
      const lead = (await pool.query(
        `select l.*, p.name, p.phone, p.email, p.lifecycle_status from leasing_leads l join persons p on p.id=l.person_id where l.id=$1`,
        [req.params.leadId])).rows[0];
      if (!lead) return res.status(404).json({ receipt: "No opportunity with that id." });
      const events = (await pool.query(`select * from lead_events where lead_id=$1 order by event_at`, [req.params.leadId])).rows;
      const touches = (await pool.query(`select t.*, s.name as source_name from lead_source_touches t left join lead_sources s on s.id=t.source_id where t.lead_id=$1 order by t.arrived_at`, [req.params.leadId])).rows;
      const tours = (await pool.query(`select * from leasing_tours where lead_id=$1 order by created_at`, [req.params.leadId])).rows;
      return res.json({ receipt: `${lead.name || "Prospect"} — status ${lead.status}, ${events.length} event(s), ${touches.length} touch(es).`, lead, events, touches, tours });
    } catch (e) { console.error("leasing get lead:", e); return res.status(500).json({ receipt: "Could not load the opportunity.", error: e.message }); }
  });

  // The same human across the portfolio: every opportunity they have.
  router.get("/leasing/persons/:personId/opportunities", requireOperator, async (req, res) => {
    try {
      const person = (await pool.query(`select id, name, phone, email, lifecycle_status, source from persons where id=$1`, [req.params.personId])).rows[0];
      if (!person) return res.status(404).json({ receipt: "No person with that id." });
      const opps = (await pool.query(
        `select l.id, l.property_id, pr.name as property_name, l.unit_id, l.status, l.received_at, l.tour_scheduled_at
           from leasing_leads l left join properties pr on pr.id=l.property_id where l.person_id=$1 order by l.received_at desc`,
        [req.params.personId])).rows;
      return res.json({ receipt: `${person.name || "Prospect"} has ${opps.length} opportunity(ies) across the portfolio. First-touch source: ${person.source || "unknown"}.`, person, opportunities: opps });
    } catch (e) { console.error("leasing person opps:", e); return res.status(500).json({ receipt: "Could not load opportunities.", error: e.message }); }
  });

  // Source report: by_source = RAW touches (marketing view, cost-per-tour);
  // totals = DEDUPED humans through the funnel (conversion truth). Both true.
  router.get("/properties/:propertyId/leasing/report", requireOperator, async (req, res) => {
    const pid = req.params.propertyId;
    try {
      const bySource = (await pool.query(
        `with lead_tour as (
           select lead_id, min(scheduled_for) as scheduled_for from leasing_tours where status in ('scheduled','confirmed_by_prospect','checked_in','completed') group by lead_id
         )
         select s.id as source_id, s.name as source, s.monthly_cost,
           count(distinct t.lead_id)                                          as leads,
           count(distinct t.person_id)                                        as people,
           count(distinct case when l.first_response_at is not null then t.lead_id end) as responded,
           count(distinct case when l.first_response_at is not null and l.first_response_at <= l.received_at + interval '1 minute' then t.lead_id end) as responded_within_1m,
           count(distinct lt.lead_id)                                         as tours,
           count(distinct case when l.status='human_takeover' then t.lead_id end) as takeovers,
           avg(extract(epoch from (l.first_response_at - l.received_at)))     as avg_response_secs,
           avg(extract(epoch from (lt.scheduled_for - l.received_at)))        as avg_lead_to_tour_secs
         from lead_source_touches t
         join leasing_leads l on l.id = t.lead_id and l.property_id = $1
         left join lead_sources s on s.id = t.source_id
         left join lead_tour lt on lt.lead_id = t.lead_id
         group by s.id, s.name, s.monthly_cost order by leads desc nulls last`,
        [pid])).rows;

      const totals = (await pool.query(
        `with lead_tour as (
           select lead_id, min(scheduled_for) as scheduled_for from leasing_tours where status in ('scheduled','confirmed_by_prospect','checked_in','completed') group by lead_id
         )
         select count(*) as leads, count(distinct l.person_id) as people,
           count(*) filter (where first_response_at is not null) as responded,
           count(*) filter (where first_response_at is not null and first_response_at <= received_at + interval '1 minute') as responded_within_1m,
           count(lt.lead_id) as tours,
           count(*) filter (where status='human_takeover') as takeovers,
           count(*) filter (where status='lost') as lost,
           avg(extract(epoch from (first_response_at - received_at))) as avg_response_secs
         from leasing_leads l left join lead_tour lt on lt.lead_id = l.id where l.property_id = $1`,
        [pid])).rows[0];

      const rows = bySource.map(r => {
        const leads = Number(r.leads) || 0, tours = Number(r.tours) || 0, responded = Number(r.responded) || 0;
        return {
          source: r.source || "(unknown)",
          raw_leads: leads, deduped_people: Number(r.people) || 0,
          ai_response_pct: leads ? Math.round((responded / leads) * 100) : 0,
          avg_response_secs: r.avg_response_secs != null ? Math.round(r.avg_response_secs) : null,
          tours, lead_to_tour_pct: leads ? Math.round((tours / leads) * 100) : 0,
          responded_within_1m: Number(r.responded_within_1m) || 0,
          human_takeovers: Number(r.takeovers) || 0,
          avg_lead_to_tour_secs: r.avg_lead_to_tour_secs != null ? Math.round(r.avg_lead_to_tour_secs) : null,
          monthly_cost: Number(r.monthly_cost) || 0,
          cost_per_tour: (Number(r.monthly_cost) > 0 && tours > 0) ? +(Number(r.monthly_cost) / tours).toFixed(2) : null,
        };
      });

      const tLeads = Number(totals.leads) || 0, tTours = Number(totals.tours) || 0;
      return res.json({
        receipt: `${Number(totals.people) || 0} deduped people / ${tLeads} opportunity(ies), ${tTours} tour(s) — overall lead→tour ${tLeads ? Math.round((tTours / tLeads) * 100) : 0}%.`,
        by_source: rows,
        totals: {
          raw_leads: tLeads, deduped_people: Number(totals.people) || 0,
          responded: Number(totals.responded) || 0, responded_within_1m: Number(totals.responded_within_1m) || 0,
          tours: tTours, lead_to_tour_pct: tLeads ? Math.round((tTours / tLeads) * 100) : 0,
          human_takeovers: Number(totals.takeovers) || 0, lost: Number(totals.lost) || 0,
          avg_response_secs: totals.avg_response_secs != null ? Math.round(totals.avg_response_secs) : null,
        },
      });
    } catch (e) { console.error("leasing report:", e); return res.status(500).json({ receipt: "Could not build the leasing report.", error: e.message }); }
  });

  // ════════════════════════════════════════════════════════════════════
  //  TOUR SCHEDULING — the show-rate instrument (migration 039)
  //
  //  A scheduled tour is a CLAIM. A completed tour is PROOF. A no_show is
  //  EXPOSURE. tour_events is the per-tour source of truth; leasing_tours.status
  //  is only its projection. This block is the ONLY writer of tour status.
  // ════════════════════════════════════════════════════════════════════

  // ── THE DOOR ──────────────────────────────────────────────────────────
  //  Write a tour_event AND refresh the tour's status projection together, in
  //  the caller's transaction, so the log and the cached status never drift.
  //  Mirrors recordLeadEvent one grain down. statusPatch carries the timestamp
  //  column for this transition (confirmed_at, checked_in_at, ...). Nothing
  //  outside this function writes leasing_tours.status.
  //
  //  TRUTH-POINT GUARD: 'checked_in' may ONLY be written by an actor_type of
  //  'human' (the on-site queue). The system asserting arrival would make show
  //  rate fiction, so it is refused here, structurally.
  async function recordTourEvent(client, { tourId, leadId, type, actorType, actorId = null, slotId = null, metadata = null }) {
    if (type === "checked_in" && actorType !== "human") {
      throw new Error("checked_in is a truth point: only a human (on-site) may assert arrival.");
    }
    // event row FIRST (source of truth)
    const ev = (await client.query(
      `insert into tour_events (tour_id, lead_id, event_type, actor_type, actor_id, slot_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [tourId, leadId, type, actorType, actorId, slotId, metadata ? JSON.stringify(metadata) : null])).rows[0];

    // projection SECOND — status + the matching timestamp column
    const TS_COL = {
      scheduled: "scheduled_for", confirmed_by_prospect: "confirmed_at",
      reminder_sent: "reminded_at", checked_in: "checked_in_at",
      completed: "completed_at", no_show: "no_show_at",
      cancelled: "cancelled_at", rescheduled: null, // rescheduled stamps no own col; successor tour carries on
    };
    const tsCol = TS_COL[type];
    const sets = [`status=$1`]; const vals = [type]; let i = 2;
    if (tsCol) { sets.push(`${tsCol}=$${i++}`); vals.push(ev.event_at); }
    sets.push(`updated_at=now()`); vals.push(tourId);
    await client.query(`update leasing_tours set ${sets.join(", ")} where id=$${i}`, vals);
    return ev;
  }

  // ── OPEN A SLOT — operator opens real availability (the truth source) ──
  //  The AI later offers ONLY rows this creates. property-scoped; agent optional.
  router.post("/leasing/availability", requireOperator, async (req, res) => {
    const b = req.body || {};
    if (!b.property_id || !b.starts_at || !b.ends_at) {
      return res.status(400).json({ receipt: "property_id, starts_at and ends_at are required to open a slot." });
    }
    try {
      const slot = (await pool.query(
        `insert into tour_availability (property_id, unit_id, leasing_agent_id, starts_at, ends_at, capacity, created_by)
         values ($1,$2,$3,$4,$5,coalesce($6,1),$7) returning *`,
        [b.property_id, b.unit_id || null, b.leasing_agent_id || null, b.starts_at, b.ends_at, b.capacity || null, b.created_by || null])).rows[0];
      return res.json({ receipt: `Slot opened ${b.starts_at} → ${b.ends_at}.`, slot });
    } catch (e) { console.error("leasing availability open:", e); return res.status(500).json({ receipt: "Could not open the slot.", error: e.message }); }
  });

  // ── LIST OPEN SLOTS — what the AI is allowed to offer, and what the dash shows
  router.get("/properties/:propertyId/leasing/availability", requireOperator, async (req, res) => {
    try {
      const r = await pool.query(
        `select * from tour_availability
          where property_id=$1 and status='open' and starts_at > now()
          order by starts_at`, [req.params.propertyId]);
      return res.json({ receipt: `${r.rows.length} open slot(s).`, slots: r.rows });
    } catch (e) { console.error("leasing availability list:", e); return res.status(500).json({ receipt: "Could not load availability.", error: e.message }); }
  });

  // ── BLOCK / REOPEN a slot (operator housekeeping) ──
  router.post("/leasing/availability/:slotId/block", requireOperator, async (req, res) => {
    try {
      const r = await pool.query(
        `update tour_availability set status='blocked', updated_at=now()
          where id=$1 and status='open' returning *`, [req.params.slotId]);
      if (!r.rows.length) return res.status(409).json({ receipt: "Slot is not open (already booked or blocked)." });
      return res.json({ receipt: "Slot blocked.", slot: r.rows[0] });
    } catch (e) { console.error("leasing availability block:", e); return res.status(500).json({ receipt: "Could not block the slot.", error: e.message }); }
  });

  // ── BOOK A TOUR ONTO A REAL SLOT — the CLAIM ──────────────────────────
  //  This is the seam: writing a tour onto a real slot ALSO advances the funnel
  //  (lead_events 'tour_scheduled'). The double-booking wall lives in the slot
  //  flip: we only proceed if the slot is still 'open' at write time, under a
  //  row lock, so two prospects cannot take the same slot. A tour row is created
  //  here if no tour_id is given (the AI path), or an existing requested tour is
  //  promoted onto the slot (the request→schedule path).
  router.post("/leasing/slots/:slotId/book", requireOperator, async (req, res) => {
    const { slotId } = req.params;
    const b = req.body || {};
    if (!b.lead_id) return res.status(400).json({ receipt: "lead_id is required to book a slot." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // lock the slot row; only book if STILL open — this is the wall
      const slot = (await client.query(
        `select * from tour_availability where id=$1 for update`, [slotId])).rows[0];
      if (!slot) { await client.query("rollback"); return res.status(404).json({ receipt: "No slot with that id." }); }
      if (slot.status !== "open") { await client.query("rollback"); return res.status(409).json({ receipt: "That slot is no longer open." }); }

      const lead = (await client.query(`select * from leasing_leads where id=$1`, [b.lead_id])).rows[0];
      if (!lead) { await client.query("rollback"); return res.status(404).json({ receipt: "No opportunity with that id." }); }

      // create or promote the tour onto this slot
      let tour;
      if (b.tour_id) {
        tour = (await client.query(
          `update leasing_tours set slot_id=$1, scheduled_for=$2, unit_id=coalesce(unit_id,$3),
                  leasing_agent_id=coalesce(leasing_agent_id,$4), updated_at=now()
            where id=$5 returning *`,
          [slotId, slot.starts_at, slot.unit_id, slot.leasing_agent_id, b.tour_id])).rows[0];
        if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id to promote." }); }
      } else {
        tour = (await client.query(
          `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status)
           values ($1,$2,$3,$4,$5,$6,'scheduled') returning *`,
          [b.lead_id, lead.property_id, slot.unit_id, slot.leasing_agent_id, slotId, slot.starts_at])).rows[0];
      }

      // flip the slot to booked, pointed at this tour (the wall: partial unique
      // index guarantees one booking; the for-update + status check guarantee
      // we got here first)
      await client.query(
        `update tour_availability set status='booked', booked_tour_id=$1, updated_at=now() where id=$2`,
        [tour.id, slotId]);

      // tour_events: scheduled (the claim)
      await recordTourEvent(client, {
        tourId: tour.id, leadId: b.lead_id, type: "scheduled",
        actorType: b.actor_type || "human", actorId: b.actor_id || null, slotId,
        metadata: { scheduled_for: slot.starts_at, slot_id: slotId },
      });

      // SEAM → funnel advances. Reuse 038's recordLeadEvent so leasing_leads.status
      // projects 'tour_scheduled' exactly as the confirm path does.
      await recordLeadEvent(client, {
        leadId: b.lead_id, type: "tour_scheduled", actorType: "system",
        metadata: { tour_id: tour.id, slot_id: slotId, scheduled_for: slot.starts_at },
        statusPatch: { tour_scheduled_at: slot.starts_at },
      });

      await client.query("commit");
      return res.json({ receipt: `Tour scheduled for ${slot.starts_at}. Slot booked; funnel advanced to tour_scheduled.`, tour_id: tour.id, slot_id: slotId });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      // the partial unique index is the backstop if two requests race past the
      // status check (shouldn't, with for-update, but the wall is structural)
      if (e.code === "23505") return res.status(409).json({ receipt: "That slot was just booked by someone else." });
      console.error("leasing slot book:", e);
      return res.status(500).json({ receipt: "Could not book the slot.", error: e.message });
    } finally { client.release(); }
  });

  // ── PROSPECT CONFIRMS — TRUTH INPUT #1 ────────────────────────────────
  //  The prospect affirming they're coming. actor_type 'prospect' (inbound
  //  reply) or 'human' (staff logging a call-back). NOT something the system
  //  asserts on its own.
  router.post("/leasing/tours/:tourId/confirm-prospect", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      if (!tour.scheduled_for) { await client.query("rollback"); return res.status(409).json({ receipt: "Tour has no scheduled time yet — book a slot first." }); }
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "confirmed_by_prospect",
        actorType: b.actor_type === "prospect" ? "prospect" : "human",
        actorId: b.actor_id || tour.confirmed_by || null,
        metadata: { via: b.via || "manual" },
      });
      await client.query("commit");
      return res.json({ receipt: "Prospect confirmed. This is a truth input to show rate.", tour_id: tourId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing confirm-prospect:", e); return res.status(500).json({ receipt: "Could not record confirmation.", error: e.message }); }
    finally { client.release(); }
  });

  // ── REMINDER SENT — schema records it; sms.js does the wire (env-gated) ──
  router.post("/leasing/tours/:tourId/reminder", requireOperator, async (req, res) => {
    const { tourId } = req.params;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "reminder_sent",
        actorType: "system", metadata: { scheduled_for: tour.scheduled_for },
      });
      await client.query("commit");
      // actual outbound text reuses sms.js like 038 intake; left to the wiring task
      return res.json({ receipt: "Reminder recorded. (Outbound text reuses sms.js once the property line is pointed at leasing.)", tour_id: tourId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing reminder:", e); return res.status(500).json({ receipt: "Could not record the reminder.", error: e.message }); }
    finally { client.release(); }
  });

  // ── CHECK IN — TRUTH POINT #2 (on-site only) ──────────────────────────
  //  The single most important honest input. recordTourEvent refuses this for
  //  any actor_type other than 'human', so the system can never fake an arrival.
  //  The on-site queue is the caller; actor_id is the staff user who tapped it.
  router.post("/leasing/tours/:tourId/check-in", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    if (!b.actor_id) return res.status(400).json({ receipt: "actor_id (the on-site staff user) is required — check-in is a human truth point." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "checked_in",
        actorType: "human", actorId: b.actor_id,
        metadata: { scheduled_for: tour.scheduled_for },
      });
      await client.query("commit");
      return res.json({ receipt: "Checked in — the prospect physically showed. This is the proof the instrument exists to capture.", tour_id: tourId });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      console.error("leasing check-in:", e);
      return res.status(500).json({ receipt: e.message.includes("truth point") ? e.message : "Could not check in the tour.", error: e.message });
    } finally { client.release(); }
  });

  // ── COMPLETE — PROOF. Optional seam back to the funnel toward application.
  router.post("/leasing/tours/:tourId/complete", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const fb = b.feedback || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      // OUTCOME IS RECORDED ONCE. A terminal tour keeps its truth; corrections
      // go through explicit lifecycle actions, never a silent re-submit.
      if (["completed", "no_show", "cancelled", "rescheduled"].includes(tour.status)) {
        const existing = (await client.query(
          `select id, current_stage, status from leasing_conversions where origin_tour_id=$1 order by opened_at asc limit 1`, [tourId])).rows[0];
        await client.query("rollback");
        return res.status(409).json({ receipt: `Outcome already recorded — this tour is ${tour.status}.`, tour_id: tourId, conversion_id: existing ? existing.id : null });
      }

      // ── attendance truth (the same one-door event write as always) ──
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "completed",
        actorType: "human", actorId: b.actor_id || null,
        metadata: { scheduled_for: tour.scheduled_for, tour_given: fb.tour_given !== false },
      });

      // ── actual units shown (1..5; every unit must belong to THIS property) ──
      const unitsShown = Array.isArray(b.units_shown) ? b.units_shown.filter(Boolean).slice(0, 5) : [];
      for (let i = 0; i < unitsShown.length; i++) {
        const u = (await client.query(`select id from units where id=$1 and property_id=$2`, [unitsShown[i], tour.property_id])).rows[0];
        if (!u) { await client.query("rollback"); return res.status(409).json({ receipt: "One of the units shown isn't at this property." }); }
        await client.query(
          `insert into tour_units_shown (tour_id, unit_id, shown_order) values ($1,$2,$3)
           on conflict (tour_id, unit_id) do nothing`, [tourId, unitsShown[i], i + 1]);
      }

      // ── preferred unit: a PREFERENCE record only — never a hold, never a
      //    reservation, creates no turnover priority (asset-protection rule) ──
      let preferredUnitId = null;
      if (b.preferred_unit_id) {
        const pu = (await client.query(`select id from units where id=$1 and property_id=$2`, [b.preferred_unit_id, tour.property_id])).rows[0];
        if (!pu) { await client.query("rollback"); return res.status(409).json({ receipt: "The preferred unit isn't at this property." }); }
        preferredUnitId = pu.id;
      }

      // ── open the conversion rail (047's single door) when a tour was GIVEN.
      //    Assignment is not authorship: the ACTUAL host is who gave it. ──
      let conversion = null;
      if (fb.tour_given !== false) {
        if (!conversionServices || typeof conversionServices.createConversionFromTour !== "function") {
          await client.query("rollback");
          return res.status(503).json({ receipt: "Outcome rail is not wired on this server yet — deploy the wave-3 server.js, then retry." });
        }
        const actualHost = b.actual_tour_host_user_id || b.actor_id || null;
        // (the service itself 422s without an actual host — its rule, kept)
        const opened = await conversionServices.createConversionFromTour(client, {
          person_id: tour.lead_id ? (await client.query(`select person_id from leasing_leads where id=$1`, [tour.lead_id])).rows[0].person_id : null,
          property_id: tour.property_id,
          origin_tour_id: tourId, lead_id: tour.lead_id,
          scheduled_tour_host_user_id: tour.leasing_agent_id || null,
          actual_tour_host_user_id: actualHost,
          feedback_recorded_by_user_id: b.actor_id || null,
          tour_outcome: fb.interest_level || null,
          tour_notes: fb.notes || null,
        });
        conversion = opened.conversion;
        // reactions (what landed) — durable person knowledge with tour provenance
        const reactions = {
          cared_about: Array.isArray(b.cared_about) ? b.cared_about.slice(0, 12) : [],
          objection: fb.objection || null,
          next_step: fb.next_step || null,
          unusual: b.unusual || null,
        };
        await client.query(
          `update leasing_conversions set reactions=$1, preferred_unit_id=$2, updated_at=now() where id=$3`,
          [JSON.stringify(reactions), preferredUnitId, conversion.id]);
      }

      await client.query("commit");
      const bits = [`Outcome recorded — tour ${fb.tour_given === false ? "marked complete (no tour given)" : "given"}.`];
      if (unitsShown.length) bits.push(`${unitsShown.length} unit${unitsShown.length > 1 ? "s" : ""} shown.`);
      if (conversion) bits.push(`Follow-up rail opened — ${fb.interest_level || "outcome"} · owner set to the actual host.`);
      return res.json({ receipt: bits.join(" "), tour_id: tourId, conversion_id: conversion ? conversion.id : null });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.http === 422 || e.httpStatus === 422) return res.status(422).json({ receipt: e.message });
      console.error("leasing complete:", e);
      return res.status(500).json({ receipt: "Could not complete the tour.", error: e.message });
    }
    finally { client.release(); }
  });

  // ── NO-SHOW — EXPOSURE. A booked tour that never happened, tracked honestly,
  //  never silently dropped. Frees the slot back? No — the slot was consumed;
  //  the no_show is the record that the spend bought nothing. Slot stays booked
  //  to that tour as the honest history.
  router.post("/leasing/tours/:tourId/no-show", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "no_show",
        actorType: b.actor_id ? "human" : "system", actorId: b.actor_id || null,
        metadata: { scheduled_for: tour.scheduled_for },
      });
      // ── RECOVERY (wave 3): no-show is a recovery opportunity, not a dead end.
      //    One server-owned attempt record, linked to the canonical person/
      //    conversation/tour. Variant = least-used ACTIVE approved variant for
      //    this property (deterministic, explainable). PREPARED only — no
      //    dispatch; transport stays dormant. Zero approved variants = honest
      //    blank: nothing is prepared and the receipt says so.
      let recoveryNote = "";
      try {
        const lead = tour.lead_id ? (await client.query(`select person_id, property_id from leasing_leads where id=$1`, [tour.lead_id])).rows[0] : null;
        const variant = (await client.query(
          `select v.id, v.variant_key, v.body_template,
                  (select count(*) from recovery_attempts a where a.variant_id=v.id) as used
             from recovery_variants v
            where v.property_id=$1 and v.status='active'
            order by used asc, v.created_at asc limit 1`, [tour.property_id])).rows[0];
        if (variant && lead) {
          const person = (await client.query(`select id, name from persons where id=$1`, [lead.person_id])).rows[0];
          const conv = (await client.query(
            `select id from conversations where person_id=$1 and property_id=$2 order by created_at asc limit 1`,
            [lead.person_id, tour.property_id])).rows[0];
          const first = person && person.name ? String(person.name).trim().split(/\s+/)[0] : "there";
          const body = String(variant.body_template).replace(/\{\{\s*first_name\s*\}\}/g, first);
          await client.query(
            `insert into recovery_attempts (tour_id, person_id, conversation_id, variant_id, prepared_body, created_by)
             values ($1,$2,$3,$4,$5,$6)`,
            [tourId, lead.person_id, conv ? conv.id : null, variant.id, body, b.actor_id || null]);
          recoveryNote = ` Recovery: prepared "${variant.variant_key}" for review — nothing was sent.`;
        } else if (!variant) {
          recoveryNote = " Recovery: no approved variants yet — nothing prepared.";
        }
      } catch (recErr) {
        // 058 not applied yet, or a data edge: the no-show truth still commits.
        console.error("no-show recovery attempt (non-fatal):", recErr.message);
        recoveryNote = " Recovery: rail unavailable (see server log) — no attempt prepared.";
      }
      await client.query("commit");
      return res.json({ receipt: "Marked no_show — exposure recorded honestly. This is the number that separates a 30%-show source from an 85% one." + recoveryNote, tour_id: tourId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing no-show:", e); return res.status(500).json({ receipt: "Could not mark no_show.", error: e.message }); }
    finally { client.release(); }
  });

  // ── CANCEL — called off before the slot. Frees the slot back to 'open'.
  router.post("/leasing/tours/:tourId/cancel", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }
      // a cancel before the slot frees the slot for someone else
      if (tour.slot_id) {
        await client.query(
          `update tour_availability set status='open', booked_tour_id=null, updated_at=now() where id=$1`,
          [tour.slot_id]);
        await client.query(`update leasing_tours set slot_id=null where id=$1`, [tourId]);
      }
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "cancelled",
        actorType: b.actor_type === "prospect" ? "prospect" : "human", actorId: b.actor_id || null,
        metadata: { freed_slot: tour.slot_id || null },
      });
      await client.query("commit");
      return res.json({ receipt: "Tour cancelled; slot released back to open.", tour_id: tourId });
    } catch (e) { try { await client.query("rollback"); } catch {} console.error("leasing cancel:", e); return res.status(500).json({ receipt: "Could not cancel the tour.", error: e.message }); }
    finally { client.release(); }
  });

  // ── RESCHEDULE — move a tour to a new slot. The honest model: the old tour is
  //  marked 'rescheduled' (its lifecycle ends), a NEW tour object is booked onto
  //  the new slot carrying rescheduled_from = old. Two tours, two clean
  //  histories — exactly why tour_events is per-tour, not per-opportunity.
  router.post("/leasing/tours/:tourId/reschedule", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    if (!b.new_slot_id) return res.status(400).json({ receipt: "new_slot_id is required to reschedule." });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const oldTour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!oldTour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }

      const newSlot = (await client.query(`select * from tour_availability where id=$1 for update`, [b.new_slot_id])).rows[0];
      if (!newSlot) { await client.query("rollback"); return res.status(404).json({ receipt: "No new slot with that id." }); }
      if (newSlot.status !== "open") { await client.query("rollback"); return res.status(409).json({ receipt: "The new slot is no longer open." }); }

      // free the old slot
      if (oldTour.slot_id) {
        await client.query(`update tour_availability set status='open', booked_tour_id=null, updated_at=now() where id=$1`, [oldTour.slot_id]);
        await client.query(`update leasing_tours set slot_id=null where id=$1`, [tourId]);
      }
      // close the old tour's lifecycle
      await recordTourEvent(client, {
        tourId, leadId: oldTour.lead_id, type: "rescheduled",
        actorType: b.actor_type === "prospect" ? "prospect" : "human", actorId: b.actor_id || null,
        metadata: { to_slot: b.new_slot_id },
      });
      // new tour onto the new slot
      const newTour = (await client.query(
        `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status, rescheduled_from)
         values ($1,$2,$3,$4,$5,$6,'scheduled',$7) returning *`,
        [oldTour.lead_id, oldTour.property_id, newSlot.unit_id, newSlot.leasing_agent_id, b.new_slot_id, newSlot.starts_at, tourId])).rows[0];
      await client.query(`update tour_availability set status='booked', booked_tour_id=$1, updated_at=now() where id=$2`, [newTour.id, b.new_slot_id]);
      await recordTourEvent(client, {
        tourId: newTour.id, leadId: oldTour.lead_id, type: "scheduled",
        actorType: b.actor_type === "prospect" ? "prospect" : "human", actorId: b.actor_id || null, slotId: b.new_slot_id,
        metadata: { scheduled_for: newSlot.starts_at, rescheduled_from: tourId },
      });
      await client.query("commit");
      return res.json({ receipt: `Rescheduled. Old tour closed; new tour ${newTour.id} booked for ${newSlot.starts_at}.`, old_tour_id: tourId, new_tour_id: newTour.id });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.code === "23505") return res.status(409).json({ receipt: "The new slot was just booked by someone else." });
      console.error("leasing reschedule:", e);
      return res.status(500).json({ receipt: "Could not reschedule.", error: e.message });
    } finally { client.release(); }
  });

  // ── TODAY'S TOURS — the on-site operating view (what the dash/iOS reads) ──
  // ── RECOVERY VISIBILITY (wave 3) — managers see: approach used, message
  //    state, response, rebooked. Attended/applied/leased are read from their
  //    canonical tables when needed; nothing here duplicates outcome truth. ──
  router.get("/properties/:propertyId/leasing/recovery", requireOperator, async (req, res) => {
    const pid = req.params.propertyId;
    try {
      const rows = (await pool.query(
        `select a.id, a.state, a.prepared_body, a.created_at, a.voided_at, a.void_reason,
                v.variant_key, p.name as person_name, a.tour_id, a.conversation_id,
                exists (select 1 from comm_events ce
                         where ce.conversation_id = a.conversation_id
                           and ce.direction='inbound' and ce.occurred_at > a.created_at) as replied,
                exists (select 1 from leasing_tours t2
                         join leasing_leads l2 on l2.id = t2.lead_id
                        where l2.person_id = a.person_id and t2.property_id = $1
                          and t2.created_at > a.created_at
                          and t2.status in ('scheduled','confirmed_by_prospect','checked_in','completed')) as rebooked
           from recovery_attempts a
           join recovery_variants v on v.id = a.variant_id
           left join persons p on p.id = a.person_id
          where v.property_id = $1
          order by a.created_at desc limit 100`, [pid])).rows;
      return res.json({ property_id: pid, attempts: rows });
    } catch (e) { console.error("recovery list:", e); return res.status(500).json({ receipt: "Could not load recovery attempts.", error: e.message }); }
  });
  // Variants are HUMAN-approved. Creating one IS the approval act.
  router.post("/leasing/recovery-variants", requireOperator, async (req, res) => {
    const b = req.body || {};
    if (!b.property_id || !b.variant_key || !b.body_template) return res.status(400).json({ receipt: "property_id, variant_key, and body_template are required." });
    if (!b.approved_by) return res.status(400).json({ receipt: "approved_by (your user id) is required — variants are human-approved." });
    try {
      const row = (await pool.query(
        `insert into recovery_variants (property_id, variant_key, body_template, approved_by)
         values ($1,$2,$3,$4) returning id, variant_key, status`,
        [b.property_id, b.variant_key, b.body_template, b.approved_by])).rows[0];
      return res.json({ receipt: `Variant "${row.variant_key}" approved and active.`, variant: row });
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ receipt: "A variant with that key already exists for this property." });
      console.error("variant create:", e); return res.status(500).json({ receipt: "Could not create the variant.", error: e.message });
    }
  });
  router.post("/leasing/recovery-variants/:id/retire", requireOperator, async (req, res) => {
    try {
      const row = (await pool.query(
        `update recovery_variants set status='retired', retired_at=now() where id=$1 and status='active' returning variant_key`,
        [req.params.id])).rows[0];
      if (!row) return res.status(404).json({ receipt: "No active variant with that id." });
      return res.json({ receipt: `Variant "${row.variant_key}" retired — no new attempts will use it.` });
    } catch (e) { console.error("variant retire:", e); return res.status(500).json({ receipt: "Could not retire the variant.", error: e.message }); }
  });
  // Every automatic behavior is reversible: voiding an attempt keeps the record.
  router.post("/leasing/recovery-attempts/:id/void", requireOperator, async (req, res) => {
    const reason = (req.body && req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ receipt: "A reason is required to void an attempt." });
    try {
      const row = (await pool.query(
        `update recovery_attempts set state='voided', voided_at=now(), void_reason=$2 where id=$1 and state='prepared' returning id`,
        [req.params.id, reason])).rows[0];
      if (!row) return res.status(404).json({ receipt: "No prepared attempt with that id." });
      return res.json({ receipt: "Attempt voided — recorded with your reason." });
    } catch (e) { console.error("attempt void:", e); return res.status(500).json({ receipt: "Could not void the attempt.", error: e.message }); }
  });

  router.get("/properties/:propertyId/leasing/tours/today", requireOperator, async (req, res) => {
    try {
      const r = await pool.query(
        `select t.*, p.name as prospect_name, p.phone as prospect_phone,
                l.person_id, c.id as conversation_id
           from leasing_tours t
           join leasing_leads l on l.id = t.lead_id
           join persons p on p.id = l.person_id
           left join conversations c
                  on c.property_id = l.property_id and c.person_id = l.person_id
          where t.property_id=$1
            and t.scheduled_for::date = (now() at time zone 'utc')::date
            and t.status not in ('cancelled','rescheduled')
          order by t.scheduled_for`, [req.params.propertyId]);
      return res.json({ receipt: `${r.rows.length} tour(s) on the board today.`, tours: r.rows });
    } catch (e) { console.error("leasing tours today:", e); return res.status(500).json({ receipt: "Could not load today's tours.", error: e.message }); }
  });

  // ── ONE TOUR, full lifecycle — the tour's own honest history ──
  router.get("/leasing/tours/:tourId", requireOperator, async (req, res) => {
    try {
      const tour = (await pool.query(
        `select t.*, l.person_id, l.property_id as lead_property_id, l.unit_id as lead_unit_id,
                p.name as prospect_name, p.phone as prospect_phone, p.email as prospect_email
           from leasing_tours t
           join leasing_leads l on l.id = t.lead_id
           join persons p on p.id = l.person_id
          where t.id=$1`, [req.params.tourId])).rows[0];
      if (!tour) return res.status(404).json({ receipt: "No tour with that id." });
      // Opening the tour drawer guarantees the person's thread exists (memo §2.4):
      // the drawer opens the person conversation, with this tour as context.
      const conversationId = await ensureConversation(pool, {
        propertyId: tour.property_id || tour.lead_property_id,
        personId: tour.person_id,
        unitId: tour.unit_id || tour.lead_unit_id,
      });
      tour.conversation_id = conversationId;
      const events = (await pool.query(`select * from tour_events where tour_id=$1 order by event_at`, [req.params.tourId])).rows;
      return res.json({ receipt: `Tour is '${tour.status}'; ${events.length} lifecycle event(s).`, tour, conversation_id: conversationId, events });
    } catch (e) { console.error("leasing tour get:", e); return res.status(500).json({ receipt: "Could not load the tour.", error: e.message }); }
  });

  return router;
};
