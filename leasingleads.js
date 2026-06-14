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

module.exports = function leasingLeadsModule({ pool, anthropic, INGEST_MODEL, sms }) {
  const router = express.Router();

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
  async function recordLeadEvent(client, { leadId, type, actorType, actorId = null, commEventId = null, metadata = null, statusPatch = null }) {
    const ev = (await client.query(
      `insert into lead_events (lead_id, event_type, actor_type, actor_id, comm_event_id, metadata)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [leadId, type, actorType, actorId, commEventId, metadata ? JSON.stringify(metadata) : null])).rows[0];

    const STATUS_FOR = {
      lead_received: "new", ai_text_sent: "ai_responded", prospect_replied: null,
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
  router.post("/leasing/intake", requireIntakeSecret, async (req, res) => {
    const b = req.body || {};
    const propertyId = b.property_id;
    if (!propertyId) return res.status(400).json({ receipt: "property_id is required." });

    const phone = normalizePhone(b.phone);
    const email = normalizeEmail(b.email);
    if (!phone && !email) return res.status(400).json({ receipt: "A phone or email is required to identify the prospect." });
    const sourceName = b.source || b.source_name || null;

    const client = await pool.connect();
    try {
      await client.query("begin");

      const prop = (await client.query(`select id, name from properties where id=$1`, [propertyId])).rows[0];
      if (!prop) { await client.query("rollback"); return res.status(404).json({ receipt: "No property with that id." }); }

      let sourceId = null;
      if (sourceName) {
        const s = (await client.query(`select id from lead_sources where lower(name)=lower($1)`, [sourceName])).rows[0];
        sourceId = s ? s.id : null;
      }

      // ── GLOBAL identity: one human across the portfolio ──
      const { person, createdPerson } = await resolveOrCreatePerson(client, { name: b.name, phone, email, source: sourceName });

      // ── PROPERTY-SCOPED opportunity: reuse the open one for this (person,
      //    property), else open a new one. Repeat touch ≠ new opportunity. ──
      let lead = (await client.query(
        `select * from leasing_leads where person_id=$1 and property_id=$2 and status not in ('leased','lost') order by created_at limit 1`,
        [person.id, propertyId])).rows[0] || null;

      const reusedOpportunity = !!lead;
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

      await client.query("commit");

      // ── Immediate AI first response (outside the txn; lead is durable). ──
      let responseReceipt = "Opportunity saved. No phone on file, so no text sent — the team can follow up by email.";
      let firstResponseSent = false;
      if (phone) {
        let unitLabel = null, rent = null;
        if (lead.unit_id) {
          const u = (await pool.query(`select unit_number, market_rent from units where id=$1`, [lead.unit_id])).rows[0];
          if (u) { unitLabel = u.unit_number ? `Unit ${u.unit_number}` : null; rent = u.market_rent || null; }
        }
        const body = await draftFirstResponse({ name: person.name, unitLabel, propertyName: prop.name, rent });

        const commEvent = (await pool.query(
          `insert into comm_events (property_id, person_id, unit_id, channel, direction, body, classification)
           values ($1,$2,$3,'text','outbound',$4,'leasing') returning id`,
          [propertyId, person.id, lead.unit_id, body])).rows[0];
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
      }

      const who = createdPerson ? "New prospect" : "Known prospect";
      const what = reusedOpportunity ? `added a ${sourceName || "new"} touch to their open ${prop.name} opportunity` : `opened a new ${prop.name} opportunity`;
      return res.json({
        receipt: `${who} — ${what}. ${responseReceipt}`,
        person_id: person.id, lead_id: lead.id,
        new_person: createdPerson, reused_opportunity: reusedOpportunity,
        first_response_sent: firstResponseSent, status: lead.status,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      console.error("leasing intake:", e);
      return res.status(500).json({ receipt: "Could not capture the lead.", error: e.message });
    } finally { client.release(); }
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
      const commEvent = (await client.query(
        `insert into comm_events (property_id, person_id, unit_id, channel, direction, body, classification)
         values ($1,$2,$3,'text','inbound',$4,'leasing') returning id`,
        [lead.property_id, lead.person_id, lead.unit_id, text])).rows[0];
      await recordLeadEvent(client, { leadId, type: "prospect_replied", actorType: "prospect", actorId: lead.person_id, commEventId: commEvent.id, metadata: { body: text } });
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
      await client.query(`update leasing_tours set status='confirmed', scheduled_for=$1, confirmed_by=$2, updated_at=now() where id=$3`, [scheduledFor, confirmedBy, tourId]);
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
        `select q.*, p.name, p.phone, p.email, l.status as lead_status
           from lead_takeover_queue q
           join leasing_leads l on l.id = q.lead_id
           join persons p on p.id = l.person_id
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
           select lead_id, min(scheduled_for) as scheduled_for from leasing_tours where status in ('confirmed','completed') group by lead_id
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
           select lead_id, min(scheduled_for) as scheduled_for from leasing_tours where status in ('confirmed','completed') group by lead_id
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

  return router;
};
