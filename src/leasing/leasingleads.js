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
const staffSessions = require("../identity/staff_session_service.js"); // BRICK ONE: the ONE issuer/resolver/revoke
const staffIdentity = require("../identity/staff_identity_resolver.js"); // 067: the ONE canonical users↔persons↔assignments read
const { recordPersonFact } = require("../identity/person_facts.js"); // 092: the ONE person × property fact write
const crypto = require("crypto");
const aiLeasingStrategy = require("./ai_leasing_strategy");
// Slice 9 attribution foundation: the ONE place an appointment binds to an opportunity.
const attribution = require("./appointment_attribution");
const aiLeasingStrategyRuntime = require("./ai_leasing_strategy_runtime");
const aiLeasingOperatingContext = require("./ai_leasing_operating_context"); // GOVERNED OPERATING CONTEXT LEASING v1
const AI_FIRST_RESPONSE_PROMPT_REVISION = "leasing-first-response-v2";
// Rule-0 capture-first attribution buckets (Fable ruling): two materially different
// truths, never folded together. A MISSING/blank tag = no channel data arrived.
// A SUPPLIED-but-unrecognized tag = a real source-mapping gap (raw value preserved
// so the channel can be identified and added). Folding unmapped into unattributed
// would make an integration defect look like genuine direct demand.
const SOURCE_UNATTRIBUTED = "Unattributed"; // caller supplied no source
const SOURCE_UNMAPPED     = "Unmapped";     // caller supplied a source we don't recognize

module.exports = function leasingLeadsModule({ pool, anthropic, INGEST_MODEL, sms, leasingLifecycle, conversionServices, commitmentLedger = null, commBoundary }) {
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
  // ── SERVER-DERIVED RECORDER (attribution the system CAN verify today) ──
  // The operator app carries a real per-user staff session (x-staff-session).
  // When present, the recorder is derived from it SERVER-SIDE — never from the
  // request body. b.actor_id is accepted ONLY as a fallback on the shared-key-
  // only path (no session), and never overrides a resolved session identity.
  async function resolveRecorderUserId(req) {
    // BRICK ONE: shared live resolver. Same null-on-anything contract 
    // no session (or a session whose authority lapsed) degrades to the
    // documented shared-key b.actor_id fallback, exactly as before.
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      return op ? op.id : null;
    } catch (_) { return null; }
  }
  // ── service-error: carries the EXACT http status + json body the route
  //    should send. Lets the completion tx live in ONE service both the
  //    operator-key door and the staff-session door call (no fork). ──
  function svcErr(status, body) {
    const e = new Error((body && (body.receipt || body.error)) || ("HTTP " + status));
    e.svc = true; e.http = status; e.body = body; return e;
  }
  function requireIntakeSecret(req, res, next) {
    const expected = process.env.LEASING_INTAKE_SECRET || process.env.INTAKE_PASSWORD;
    if (!expected) return res.status(503).json({ receipt: "Lead intake is locked: set LEASING_INTAKE_SECRET in Render's environment." });
    const got = req.headers["x-intake-secret"] || (req.body && req.body.intake_secret);
    if (got !== expected) return res.status(401).json({ receipt: "Intake secret missing or wrong." });

    // COMMUNICATIONS/PROPERTY WALL: the secret proves possession, not
    // property entitlement. The body property_id is a REQUEST — it is
    // validated against the property set this credential is bound to
    // (LEASING_INTAKE_PROPERTY_IDS, comma-separated UUIDs). Unbound
    // credential → fail closed. A credential for property A can never
    // create a lead in property B.
    const allowedRaw = (process.env.LEASING_INTAKE_PROPERTY_IDS || "").trim();
    if (!allowedRaw) {
      return res.status(503).json({ receipt: "Lead intake is locked: bind the intake credential to its properties (set LEASING_INTAKE_PROPERTY_IDS)." });
    }
    const allowed = allowedRaw.split(",").map(s => s.trim()).filter(Boolean);
    const requested = req.body && req.body.property_id;
    if (!requested || !allowed.includes(String(requested))) {
      return res.status(403).json({ receipt: "This intake credential is not entitled to that property." });
    }
    next();
  }

  // ── helpers ──────────────────────────────────────────────────────────
  // Canonical phone normalization is the SHARED module (phone_identity.js) —
  // one implementation for all identity dedup, not a per-module copy.
  const { normalizeE164: __normalizeE164 } = require("../identity/phone_identity");
  function normalizePhone(raw) { return __normalizeE164(raw); }

  // ── PROSPECT ACTIVATION (Path A) ──────────────────────────────────────
  //  A permanent CAPABILITY allowlist: only properties whose id is listed in
  //  PROSPECT_ACTIVATION_PROPERTY_IDS may have a web-form prospect promoted to
  //  a 'production' classification + 'opted_in' consent at intake — the two
  //  facts communications_boundary.js requires for a customer_care autonomous
  //  send. Absent/empty env = today's behavior (no promotion; a bug cannot
  //  accidentally activate an unlisted property, e.g. real Solo). This is
  //  config (Class 2), NOT a property-id branch in business logic — the code
  //  path is identical for every property; the allowlist is data.
  const PROSPECT_ACTIVATION_PROPERTY_IDS = new Set(
    String(process.env.PROSPECT_ACTIVATION_PROPERTY_IDS || "")
      .split(",").map(s => s.trim()).filter(Boolean)
  );
  function propertyIsActivated(propertyId) {
    return PROSPECT_ACTIVATION_PROPERTY_IDS.has(String(propertyId));
  }
  //  Consent read defensively across the field names a web form might send.
  //  Truthy boolean, or a string in {"yes","true","on","1","checked"}, counts
  //  as consent. Anything else (including absent) = NO consent signal → the
  //  person is still captured as a lead, but stays un-textable (honest). No
  //  form change is required if consent is already collected under any of
  //  these names; a miss shows in the Render log line below as
  //  "activated but NO consent signal" and is a one-line field-name add.
  function extractConsentSignal(body) {
    const raw = body || {};
    const candidates = [
      raw.sms_consent, raw.text_consent, raw.consent, raw.tcpa_consent,
      raw.agreed_to_texts, raw.agree_to_texts, raw.opt_in, raw.opted_in,
      (raw.raw_payload || {}).sms_consent, (raw.raw_payload || {}).consent,
      (raw.raw_payload || {}).agreed_to_texts,
    ];
    for (const c of candidates) {
      if (c === true || c === 1) return true;
      if (typeof c === "string" && ["yes","true","on","1","checked"].includes(c.trim().toLowerCase())) return true;
    }
    return false;
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
  // ── CANONICAL PERSON RESOLVER (phone-based leasing intake identity) ──────
  //  ONE door for turning an inbound name/phone/email into a durable person,
  //  for the LEASING domain (prospect intake). Enforces the one-phone-one-
  //  person rule that forked before: the bug was deduping on the raw `phone`
  //  string, so the same human in a different format ("7243098434" vs
  //  "+17243098434") minted a NEW person. Fix: normalize to a canonical E.164
  //  and dedup on primary_phone_e164 FIRST.
  //
  //  SCOPE NOTE (doctrine): phone is an identity SIGNAL for prospect intake, not
  //  a universal "same phone = same human everywhere" merge. This resolver
  //  governs leasing-domain person intake only. The staff-user durable-person
  //  bridge (staffbridge.js) remains a SEPARATE identity fact and does NOT route
  //  through here.
  //
  //  Lookup order:
  //    1. canonical primary_phone_e164 (the real identity key)
  //    2. legacy exact `phone` match (finds old rows written before this key
  //       existed) — and when found, BACKFILL primary_phone_e164 so the row
  //       joins the canonical index going forward
  //    3. email (lowercased)
  //  On CREATE: write BOTH phone (display/current) AND primary_phone_e164
  //  (canonical). On MATCH: backfill only what's missing; identity stays put.
  async function resolveOrCreatePerson(client, { name, phone, email, source }) {
    const canon = normalizePhone(phone); // canonical E.164 or null
    const emailNorm = normalizeEmail(email);
    let person = null;

    // 1) canonical key
    if (canon) {
      person = (await client.query(
        `select * from persons where primary_phone_e164=$1 order by created_at limit 1`,
        [canon])).rows[0] || null;
    }
    // 2) legacy phone rows: match where the STORED phone, once normalized to
    //    E.164, equals our canonical — so a row stored in ANY raw format
    //    ("7243098888", "724-309-8888", etc.) is found and adopted. We compare
    //    normalized-to-normalized rather than raw string equality (the original
    //    bug). Bounded scan: only rows whose digits could match.
    if (!person && canon) {
      const tail10 = canon.replace(/\D/g, "").slice(-10);
      const candidates = (await client.query(
        `select * from persons
          where phone is not null and regexp_replace(phone,'\\D','','g') like $1
          order by created_at`,
        ["%" + tail10])).rows;
      person = candidates.find(p => normalizePhone(p.phone) === canon) || null;
    }
    // 3) email
    if (!person && emailNorm) {
      person = (await client.query(
        `select * from persons where lower(email)=lower($1) order by created_at limit 1`,
        [emailNorm])).rows[0] || null;
    }

    if (person) {
      // backfill missing fields; CANONICALIZE the identity key if absent.
      await client.query(
        `update persons
            set name = coalesce(name,$1),
                phone = coalesce(phone,$2),
                email = coalesce(email,$3),
                primary_phone_e164 = coalesce(primary_phone_e164,$4),
                updated_at = now()
          where id=$5`,
        [name || null, phone || canon || null, emailNorm, canon, person.id]);
      return { person, createdPerson: false };
    }

    // create: write BOTH the display phone and the canonical identity key.
    person = (await client.query(
      `insert into persons (name, phone, email, primary_phone_e164, lifecycle_status, leasing_stage, source)
       values ($1,$2,$3,$4,'lead','lead',$5) returning *`,
      [name || null, phone || canon || null, emailNorm, canon, source || null])).rows[0];
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

  // COMMUNICATIONS BOUNDARY: smsForEvent + propertyLine moved into
  // communications_boundary.js (sendPropertySms). The property line is
  // derived server-side inside the gate; save-first is preserved via
  // eventId. This module never calls raw sms.sendSms.

  // AI's first response: speed + clarity. Surface the unit, offer REAL tour
  // slots when we have them, and NEVER invent a time. `slots` is the output of
  // readOfferableSlots (real tour_availability rows in the property tz); a
  // null/empty list means we have nothing offerable, so we ask the prospect for
  // their preferred timing instead of fabricating one. Honest blank beats
  // confident wrong (§5): an invented tour time is a prospect-facing lie.
  // If pricing/availability is unknown, the AI says so rather than inventing it.
  // Deterministic fallback if the model is unavailable.
  // OPERATING-CONTEXT READ-FAILURE RULING (mandatory corrections #6, #7).
  //
  // #7 — what happens when governed rules cannot be verified: this path has no
  // draft/review step (unlike ongoing/regenerated replies) — it sends
  // immediately, by design, so "prepare but don't send" isn't available without
  // building a whole new review gate, a materially bigger change than this
  // correction. The safe alternative that's already available: if the
  // property's governed policies/SOPs/guardrails cannot be verified, do NOT
  // let a free-text model call run ungoverned — skip the model call entirely
  // and use the SAME deterministic, fact-only fallback this function already
  // sends when the model is unavailable or errors (a fixed template with only
  // verified unit/rent data, never free text). That fallback is guardrail-safe
  // by construction: nothing it can say is something a guardrail would need to
  // constrain. "Fail open" (send an ungoverned model reply as if zero rules
  // existed) was rejected — an unverified governance state is not the same
  // fact as a verified empty one (PHILOSOPHY.md §5).
  //
  // #6 — provenance: this surface has no agent_runs row (that table only
  // exists for the ongoing/regenerated draft flow), so exact-rule-snapshot
  // persistence the way agent.js does it doesn't apply here. Rather than
  // stay silent about that gap, the caller (intakeProspect) records
  // ai_operating_context_hash and ai_operating_context_unavailable on the
  // SAME lead_events row it already writes for this send — real, durable,
  // queryable provenance using the existing event trail, narrower than a full
  // snapshot but honest about what it is.
  async function draftFirstResponse({ name, unitLabel, propertyName, propertyId = null, rent, slots, strategyEnvelope = null }) {
    const slotList = Array.isArray(slots) ? slots.filter(s => s && s.label) : [];
    const haveSlots = slotList.length > 0;
    const slotPhrase = haveSlots ? slotList.slice(0, 2).map(s => s.label).join(" or ") : null;
    const known = unitLabel && rent;

    // Deterministic fallback — real slots when we have them, an honest ask when
    // we don't. No hardcoded times in either branch.
    // OPENER SHAPE (docs/AI_VOICE.md §5 Case G). The prior opener listed two
    // specific slots and asked "which works better for you?" — a CLOSED question
    // whose only answers are two commitments. A real prospect answered it with
    // "why so pushy for tour i just filled out form". Offering a tour early is
    // NOT the defect; forcing a choice between two times is. Every branch below
    // makes an OPEN offer and gives an explicit lower-commitment path ("or
    // anything I can answer first"), which hands control back to the prospect.
    // Real slots are still never invented; they are simply not led with.
    let fallback;
    if (known) {
      fallback = `Hi ${firstName(name)}, thanks for the inquiry! ${unitLabel} at ${propertyName || "the property"} is available at $${rent}. I'd love to show you around, or is there anything I can answer first?`;
    } else {
      fallback = `Hi ${firstName(name)}, thanks for the inquiry! I'm confirming current availability and pricing now. I'd love to show you around, or is there anything I can answer first?`;
    }
    // `slotPhrase` stays available for the model branch below, which may offer
    // real times if the prospect's message already signalled tour intent.
    void slotPhrase;
    if (!anthropic) return { body: fallback, strategyApplied: false, operatingContextApplied: false, operatingContextHash: null, operatingContextUnavailable: false };

    let operatingRules = [];
    let operatingDirective = "";
    let operatingContextHash = null;
    try {
      operatingRules = propertyId ? await aiLeasingOperatingContext.loadActiveRules(pool, propertyId) : [];
      operatingDirective = aiLeasingOperatingContext.buildOperatingContextDirective(operatingRules);
      operatingContextHash = aiLeasingOperatingContext.snapshotHash(operatingRules);
    } catch (e) {
      // Read (or over-budget) failure: see the ruling above the function.
      // Never call the model without a verified governance state.
      console.error("leasing operating context unavailable for first response:", e.message);
      return { body: fallback, strategyApplied: false, operatingContextApplied: false, operatingContextHash: null, operatingContextUnavailable: true };
    }

    try {
      const runtimeStrategyEnvelope = strategyEnvelope
        ? aiLeasingStrategyRuntime.validatedEnvelopeForRuntime(strategyEnvelope, {
            surface: "first_response", model: INGEST_MODEL,
            promptRevision: AI_FIRST_RESPONSE_PROMPT_REVISION,
          })
        : null;
      const strategyDirective = runtimeStrategyEnvelope ? aiLeasingStrategy.buildStrategyDirective(runtimeStrategyEnvelope) : "";
      const slotInstruction = haveSlots
        ? `We DO have real tour times available (${slotPhrase}), but DO NOT list them in this first message and DO NOT ask the prospect to pick one. Make an open offer to show them around instead. They just filled out a form seconds ago; naming two specific times and asking "which works better" reads as pushy and has driven a real prospect away. Save the specific times for when they say yes.`
        : `We have NO confirmed tour times to offer right now. DO NOT invent, guess, or imply any tour time.`;
      const prompt =
        `You are the leasing assistant for ${propertyName || "an apartment community"}. Write ONE short, warm SMS (under 320 chars) to a prospect named ${firstName(name)} who submitted a web inquiry about 30 seconds ago. ` +
        `Sound like a sharp, helpful person texting between showings. Not a brochure. Two sentences, warm and brief. ` +
        `Goal: thank them for the inquiry, confirm the unit and rent IF known, and offer to show them around. ` +
        `${slotInstruction} ` +
        `END by giving them BOTH paths: offer the tour AND an easy way to just ask questions first, e.g. "or is there anything I can answer first?". The lower-commitment option is required; it hands them control and is the whole point of this message. ` +
        `AT MOST ONE exclamation mark in the entire message. Never use an em dash or en dash. Never use markdown. ` +
        `If unit or rent is unknown, DO NOT invent it — say you're confirming. Never invent a tour time, price, or availability. ` +
        `Do NOT try to close a lease, ask for an application, or request documents. ` +
        (strategyDirective ? `${strategyDirective} ` : "") +
        (operatingDirective ? `${operatingDirective} ` : "") +
        `Unit: ${unitLabel || "(unknown — confirming)"}. Rent: ${rent ? "$" + rent : "(unknown — confirming)"}. Reply with ONLY the message text.`;
      const r = await anthropic.messages.create({ model: INGEST_MODEL, max_tokens: 200, messages: [{ role: "user", content: prompt }] });
      const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      return {
        body: text || fallback, strategyApplied: !!(text && runtimeStrategyEnvelope),
        operatingContextApplied: !!text, operatingContextHash, operatingContextUnavailable: false,
      };
    } catch (e) {
      console.error("leasing draftFirstResponse:", e.message);
      // Model failure, not a governance-read failure — operating rules WERE
      // verified, they just were never used because no model reply exists.
      return { body: fallback, strategyApplied: false, operatingContextApplied: false, operatingContextHash: null, operatingContextUnavailable: false };
    }
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
    let person, createdPerson, lead, reusedOpportunity, prop, strategyEnvelope = null;
    try {
      await client.query("begin");

      prop = (await client.query(`select id, name, coalesce(display_name, name) as display_name from properties where id=$1`, [propertyId])).rows[0];
      if (!prop) { await client.query("rollback"); const e = new Error("No property with that id."); e.httpStatus = 404; e.publicReceipt = e.message; throw e; }

      let sourceId = null;
      let claimedButUnmapped = false;
      if (sourceName) {
        const s = (await client.query(`select id from lead_sources where lower(name)=lower($1)`, [sourceName])).rows[0];
        if (s) sourceId = s.id; else claimedButUnmapped = true; // supplied, but not a source we map
      }

      // Capture-first: never lose a real prospect over attribution. Assign the
      // honest bucket — 'Unmapped' if a source was supplied but unrecognized (the
      // raw claim is preserved in raw_payload below), else 'Unattributed'. We do
      // NOT mint arbitrary sources from untrusted input. Savepoint-guarded so a
      // concurrent first-create cannot poison this transaction.
      if (!sourceId) {
        const bucket = claimedButUnmapped ? SOURCE_UNMAPPED : SOURCE_UNATTRIBUTED;
        let fb = (await client.query(`select id from lead_sources where lower(name)=lower($1) order by id limit 1`, [bucket])).rows[0];
        if (!fb) {
          await client.query("savepoint ensure_house_source");
          try {
            fb = (await client.query(`insert into lead_sources (name, source_type) values ($1,'system') returning id`, [bucket])).rows[0];
            await client.query("release savepoint ensure_house_source");
          } catch (_) {
            await client.query("rollback to savepoint ensure_house_source");
            fb = (await client.query(`select id from lead_sources where lower(name)=lower($1) order by id limit 1`, [bucket])).rows[0];
          }
        }
        sourceId = fb.id;
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

      // ── PROSPECT ACTIVATION (Path A) — write the two facts the comms boundary
      //    requires for a customer_care autonomous send, IFF this property is on
      //    the capability allowlist AND the form carried a consent signal. Both
      //    writes are INSIDE this transaction (reclassify accepts our client), so
      //    activation is atomic with the person/lead — a lead is never left
      //    half-activated. Append-only (reclassify supersedes prior class; consent
      //    upserts the one canonical row). Unlisted property or no consent → skip
      //    entirely (honest: captured, not textable). A STOP later still lands in
      //    contact_preferences and overrides this, exactly as the boundary expects.
      const _activated = propertyIsActivated(propertyId);
      const _consentSignal = extractConsentSignal(b);
      if (_activated && _consentSignal) {
        await commBoundary.reclassify(
          { person_id: person.id, property_id: propertyId, record_class: "production",
            actor_user_id: null, reason: "canonical_web_intake" },
          client
        );
        await client.query(
          `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
           values ($1, 'text', 'opted_in', 'canonical_intake', now())
           on conflict (person_id, channel)
           do update set consent_state = 'opted_in', source = 'canonical_intake', updated_at = now()`,
          [person.id]
        );
        console.log(`[intake] activated prospect person=${person.id} property=${propertyId} lead=${lead.id} (production + opted_in)`);
      } else if (_activated && !_consentSignal) {
        // Property IS activated but the form sent no recognized consent field —
        // the person is captured but stays un-textable. This log line is the
        // signal that a consent field-name may need adding to extractConsentSignal.
        console.log(`[intake] activated property but NO consent signal person=${person.id} property=${propertyId} lead=${lead.id} — captured, not textable`);
      }

      // ── BIRTH GUARD — no person leaves this service ungoverned ────────
      // Classification is the single fact every central exclusion keys on:
      // outbound messaging, prospect outreach, reporting, leasing metrics,
      // AI prompts, automated decision rules. Until now it was written ONLY
      // on the activation path above, so every other arrival left the person
      // classified as NOTHING.
      //
      // Nothing is not neutral. A policy written as `record_class !==
      // 'internal_qa'` does not exclude a record that is neither, so an
      // ungoverned person lands on the PERMISSIVE side of every filter —
      // fail-closed on messaging, fail-open on reporting. Seventeen such
      // people were found in the Demo Building on 2026-07-24.
      //
      // FILL THE ABSENCE; NEVER OVERWRITE A DECISION. reclassify() supersedes
      // unconditionally, so a blind call here would downgrade an already
      // production person on their next un-consented submission. Only a person
      // holding no current classification is classified.
      //
      // Outside the activation perimeter `internal_qa` is the honest value:
      // the record is created through the real architecture and centrally
      // excluded from outreach, reporting, metrics and AI — which is exactly
      // what that classification means. If it is wrong for a given person it
      // is wrong in the SAFE direction (excluded, not wrongly counted), and a
      // deliberate attributed supersession corrects it. Inside this same
      // transaction, so a lead is never committed ungoverned.
      const _existingClass = (await client.query(
        `select 1 from person_property_classifications
          where person_id=$1 and property_id=$2 and superseded_at is null limit 1`,
        [person.id, propertyId])).rows[0];
      if (!_existingClass) {
        await commBoundary.reclassify(
          { person_id: person.id, property_id: propertyId, record_class: "internal_qa",
            actor_user_id: null, reason: "birth_default_outside_activation" },
          client
        );
        console.log(`[intake] birth-guard classified person=${person.id} property=${propertyId} internal_qa (outside activation perimeter)`);
      }

      // ── THREAD IT (memo §2.2: never an orphaned event). The conversation-queue
      //    projection inner-joins conversations — without this row an intake lead is
      //    INVISIBLE to the operator door. Upsert on (property, person): a repeat
      //    submit reuses the same conversation (idempotent by the natural key). ──
      conversationId = await ensureConversation(client, {
        propertyId: propertyId, personId: person.id, unitId: lead.unit_id || null,
      });
      const strategyAssignment = await aiLeasingStrategyRuntime.assignForConversationWithoutBlockingCapture(client, {
        conversationId,
        leasingLeadId: lead.id,
        propertyId,
        source: sourceName,
        assignmentKey: `${propertyId}:${lead.id}`,
        actorUserId: null,
      });
      strategyEnvelope = strategyAssignment.envelope || null;

      await client.query("commit");

      // ── SLICE 2 (form side): the stated move-month is a first-party captured fact —
      //    record it in the typed person_attributes store (source='form', the lead is
      //    the receipt). Fail-soft AFTER the commit: if the store isn't migrated yet,
      //    the intake still succeeds and vitals fall back to raw_payload. ──
      try {
        const _rp = b.raw_payload || {};
        const _mm = _rp.desired_move_month;
        if (_mm === "flexible" || (typeof _mm === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(_mm))) {
          // ATOMIC. Retire and insert are ONE transaction on ONE connection. As two
          // bare pool.query() calls they could land on different pooled connections
          // with no transaction around them, so a failure or a crash between them
          // left the person with the old value retired and no new value written —
          // an active move_month silently deleted rather than replaced.
          const _c = await pool.connect();
          try {
            await _c.query("begin");
            await recordPersonFact(_c, {
              personId: person.id, propertyId,
              attrKey: "move_month", attrValue: _mm,
              source: "form",                          // the capture CHANNEL
              sourceRecordType: "leasing_lead",        // the receipt, TYPED
              sourceRecordId: lead.id,
              // the prospect stated this when they submitted, not when we stored it
              occurredAt: lead.received_at || null,
              occurredAtBasis: lead.received_at ? "source_record" : null,
              // a human typed it themselves — the public door has no users row,
              // so this is 'prospect', not 'operator' and not 'system'
              actorType: "prospect",
              claimStrength: "asserted",
              verb: "captured",
              idempotencyKey: `captured:leasing_lead:${lead.id}:move_month`,
            });
            await _c.query("commit");
          } catch (e) { try { await _c.query("rollback"); } catch (_) {} throw e; }
          finally { _c.release(); }
        }
      } catch (e) {
        // FAIL-SOFT, BUT NEVER SILENT. The intake is already committed and a lost
        // fact must never lose a real prospect, so this does not rethrow. But the
        // previous bare `catch (_) {}` meant move_month capture could stop working
        // entirely with no exception, no log, and a 200 still returned to the
        // caller — the one failure mode nothing in the system could observe.
        console.error("[intake] move_month fact not recorded (non-fatal):", (e && e.message) || "unknown");
      }

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
        // Real availability only — readOfferableSlots returns open tour_availability
        // rows in the property tz, or null when the tz is unconfigured. Either way,
        // draftFirstResponse never fabricates a time: it offers real slots or asks
        // for preferred timing.
        const offerSlots = await readOfferableSlots(pool, { propertyId, limit: 2 });
        const drafted = await draftFirstResponse({
          name: person.name, unitLabel, propertyName: prop.display_name, propertyId,
          rent, slots: offerSlots, strategyEnvelope,
        });
        const body = drafted.body;
        const authoredAt = new Date();
        draftBody = body;

        // THREADED outbound: conversation_id + sender_role so the message lives on the
        // person's one thread (the door reads it). provider_status stays NULL — the
        // projection treats that as NOT delivered, which is the truth until a carrier
        // confirms dispatch.
        const messageClient = await pool.connect();
        let commEvent;
        try {
          await messageClient.query("begin");
          commEvent = (await messageClient.query(
            `insert into comm_events (property_id, person_id, unit_id, conversation_id, channel, direction, body, classification, sender_role)
             values ($1,$2,$3,$4,'text','outbound',$5,'leasing','ai') returning id`,
            [propertyId, person.id, lead.unit_id, conversationId, body])).rows[0];
          if (conversationId) await messageClient.query(`update conversations set last_message_at = now() where id=$1`, [conversationId]);
          if (drafted.strategyApplied && strategyEnvelope) {
            await aiLeasingStrategy.recordAiMessageAttribution(messageClient, {
              commEventId: commEvent.id, conversationId, leasingLeadId: lead.id, propertyId,
              assignmentEventId: strategyEnvelope.assignment_event_id,
              authorshipScope: "full_message", humanModified: false,
              authoredAt,
            });
          }
          await messageClient.query("commit");
        } catch (e) {
          await messageClient.query("rollback");
          throw e;
        } finally { messageClient.release(); }

        if (attemptSms) {
          const wire = await commBoundary.sendPropertySms({
            property_id: propertyId, recipient: phone, body,
            purpose: "leasing_first_response", person_id: person.id, eventId: commEvent.id,
          });
          firstResponseSent = wire.sent;

          const c2 = await pool.connect();
          try {
            await c2.query("begin");
            await recordLeadEvent(c2, {
              leadId: lead.id, type: "ai_text_sent", actorType: "ai", commEventId: commEvent.id,
              metadata: {
                sent: wire.sent, reason: wire.reason || null,
                ai_operating_context_hash: drafted.operatingContextHash || null,
                ai_operating_context_applied: !!drafted.operatingContextApplied,
                ai_operating_context_unavailable: !!drafted.operatingContextUnavailable,
              },
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
              metadata: {
                sent: false, prepared: true, channel: b.response_channel || "demo_browser",
                ai_operating_context_hash: drafted.operatingContextHash || null,
                ai_operating_context_applied: !!drafted.operatingContextApplied,
                ai_operating_context_unavailable: !!drafted.operatingContextUnavailable,
              },
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
      return res.status(500).json({ receipt: "Could not capture the lead." });
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
      if (!_rateOk(_demoRate.phone, phone, 20, 10 * 60 * 1000)) {
        return res.status(429).json({ receipt: "That number just signed up — the manager workspace already has your inquiry." });
      }

      // ── SERVER-DERIVED demo property (client property_id ignored entirely) ──
      const prop = (await pool.query(
        "select id, name, coalesce(display_name, name) as display_name from properties where name=$1 order by created_at asc limit 1",
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
      //  attempt_sms is env-gated: DEMO_INTAKE_LIVE_SMS=true turns this door into
      //  a LIVE-texting door (for real end-to-end testing from a real phone).
      //  Absent/false → the original boardroom behavior (prepared, never sent) is
      //  preserved exactly. The actual send still passes through the comms boundary
      //  (mode + production classification + opted_in consent), so turning this on
      //  is necessary-but-not-sufficient — SMS_SEND_MODE and activation still gate it.
      const _demoLiveSms = String(process.env.DEMO_INTAKE_LIVE_SMS || "").toLowerCase() === "true";
      //  Consent for this controlled door: honor an explicit consent field if the
      //  form sends one (any of the names extractConsentSignal knows); otherwise,
      //  when live SMS is deliberately enabled, submission through this gated demo
      //  door is itself the opt-in (the operator turned the door on knowingly).
      //  When live SMS is OFF, no consent is asserted (nothing sends anyway).
      const _formConsent = (b.sms_consent ?? b.text_consent ?? b.consent ?? b.tcpa_consent ?? b.agreed_to_texts ?? b.opt_in ?? b.opted_in);
      const _consentForDemo = _formConsent !== undefined ? _formConsent : (_demoLiveSms ? "yes" : undefined);

      const out = await intakeProspect({
        property_id: prop.id,                    // server-derived, never from the browser
        name: name, phone: phone,
        source: DEMO_INTAKE_SOURCE,              // person first-touch + lead source tag
        attempt_sms: _demoLiveSms,               // env-gated: live only when DEMO_INTAKE_LIVE_SMS=true
        sms_consent: _consentForDemo,            // drives activation (production + opted_in) when present
        response_channel: "demo_browser",
        raw_payload: {
          channel: "demo_public_intake", idempotency_key: b.idempotency_key || null,
          sms_consent: _consentForDemo || null,
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

      // 8-11) CORE BOOKING via the shared canonical service — the SAME
      //    transaction the agent uses. It re-reads+locks the slot, re-verifies
      //    property/lead/slot authority, writes leasing_tours, flips the slot,
      //    and advances the funnel with split (system-execution) attribution.
      //    The link path's authority (token → link → lead/slot) was already
      //    verified above (steps 1-7); this performs the governed write.
      //    Idempotency for the LINK path stays keyed on the single-use token
      //    (steps 2 & 12), so no per-action key is passed here.
      const { tour } = await bookTourIntoSlot(client, {
        leadId: lead.id,
        slotId,
        subjectPersonId: lead.person_id,
        via: "public_demo_booking",
        // link path is already scope-walled to the Demo Building above; it does
        // not require the separate agent-booking capability gate.
        requireAgentBookingCapability: false,
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
    //
    // ── WHY 'scheduled' STAMPS NOTHING ────────────────────────────────────
    // Every other entry in this map is an OCCURRENCE time: completed_at,
    // no_show_at, checked_in_at all mean "when this happened", so writing
    // ev.event_at into them is correct.
    //
    // scheduled_for is NOT an occurrence time. It is the APPOINTMENT time —
    // the moment the tour is FOR — written by the booking service from
    // tour_availability.starts_at. Treating it like its siblings stamped the
    // booking moment over the appointment on every tour ever booked: the
    // INSERT wrote the correct slot time, and this UPDATE (same transaction,
    // milliseconds later) replaced it with now(). RETURNING looked right;
    // the stored row was wrong; updated_at matched created_at because both
    // resolved to the same transaction timestamp. Nothing in the plumbing
    // was broken — the map asserted a meaning the column does not have.
    //
    // WHEN scheduling happened is not lost: it lives in tour_events.event_at,
    // which is the source of truth and is written above, untouched by this.
    // ('rescheduled' already stamps nothing for the same class of reason.)
    const TS_COL = {
      scheduled: null,             // appointment time, NOT an occurrence time — see above
      confirmed_by_prospect: "confirmed_at",
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

  // ════════════════════════════════════════════════════════════════════
  //  SHARED CANONICAL BOOKING SERVICE — bookTourIntoSlot
  //
  //  The ONE transaction that turns an eligible slot into a live tour in
  //  leasing_tours (the Tours module's table). BOTH the public /demo/book link
  //  route AND the agent's book_tour tool call this — one code path, one
  //  double-booking wall, one funnel advance. No caller may reimplement it.
  //
  //  GOVERNED WRITE (not a consequence of being allowed to converse). Every
  //  authority fact is re-verified HERE, server-side, under lock — a model- or
  //  client-supplied lead/slot/property relationship is NEVER trusted:
  //    · the slot is RE-READ and LOCKED (for update) — a slot id the model saw
  //      in a prompt is proof of nothing; only a currently-open row books.
  //    · the slot's property must equal the lead's property (no cross-property).
  //    · the lead must belong to that property and still be eligible.
  //    · soft-closed conversations are refused (dormant guard) when wired.
  //
  //  IDEMPOTENCY is per CONFIRMATION ACTION, not per lead (a lead may
  //  legitimately book/reschedule more than one tour over its life):
  //    · idempotencyKey (agent path: the inbound MessageSid) → same key retried
  //      converges on the SAME tour. The partial-unique index on
  //      leasing_tours.booking_idempotency_key (mig 079) is the race backstop:
  //      a concurrent retry raises 23505, which the caller catches and resolves
  //      to the existing tour — never a 500, never a duplicate.
  //    · the slot lock INDEPENDENTLY stops two DIFFERENT people taking one slot.
  //
  //  ATTRIBUTION stays split (authenticated actor ≠ subject ≠ host ≠ completer):
  //    · EXECUTION actor = 'system' (the platform performed the write).
  //    · the SUBJECT/confirming prospect is recorded as subject_person_id in the
  //      tour_event metadata (never collapsed into the execution actor).
  //    · the ORIGINATING cause (comm_event id / agent run) is recorded too.
  //
  //  Returns { tour, alreadyBooked }. Throws typed-ish errors with .publicMessage
  //  and .httpStatus for the caller to map. Runs INSIDE the caller's client/txn.
  // ════════════════════════════════════════════════════════════════════
  async function bookTourIntoSlot(client, {
    leadId,
    slotId,
    subjectPersonId = null,     // the prospect who confirmed (subject, NOT executor)
    sourceCommEventId = null,   // the inbound comm_event that carried the confirmation
    sourceAgentRunId = null,    // the agent run that caused the booking (if any)
    idempotencyKey = null,      // per-ACTION key (agent: the MessageSid)
    via = "agent_book_tour",    // provenance label
    requireAgentBookingCapability = false, // when true, property must be agent-booking-enabled
  }) {
    if (!leadId || !slotId) {
      const e = new Error("leadId and slotId are required."); e.httpStatus = 400; e.publicMessage = e.message; throw e;
    }

    // ── ACTION IDEMPOTENCY (pre-check): a retried confirmation returns the same
    //    tour without booking again. The unique index is the concurrent backstop.
    if (idempotencyKey) {
      const prior = (await client.query(
        `select id, scheduled_for from leasing_tours where booking_idempotency_key=$1 limit 1`,
        [idempotencyKey])).rows[0];
      if (prior) return { tour: prior, alreadyBooked: true };
    }

    // ── LEAD authority: re-read; must exist and still be eligible (not lost). ──
    const lead = (await client.query(`select * from leasing_leads where id=$1`, [leadId])).rows[0];
    if (!lead) { const e = new Error("Could not find the inquiry for this booking."); e.httpStatus = 404; e.publicMessage = e.message; throw e; }
    if (lead.status === "lost" || lead.status === "leased") {
      const e = new Error("This inquiry is no longer eligible for a tour."); e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    // ── CAPABILITY: property must be enabled for agent booking (governed). This
    //    is a PERMANENT capability check, distinct from any demo flag. ──
    if (requireAgentBookingCapability && !propertyAgentBookingEnabled(lead.property_id)) {
      const e = new Error("Tour booking isn't enabled for this property yet."); e.httpStatus = 403; e.publicMessage = e.message; throw e;
    }

    // ── SLOT authority: RE-READ + LOCK. Never trust a slot id from the model. ──
    const slot = (await client.query(`select * from tour_availability where id=$1 for update`, [slotId])).rows[0];
    if (!slot) { const e = new Error("No slot with that id."); e.httpStatus = 404; e.publicMessage = e.message; throw e; }
    if (slot.status !== "open") { const e = new Error("That time was just taken. Please pick another."); e.httpStatus = 409; e.publicMessage = e.message; throw e; }
    // CROSS-PROPERTY WALL: the slot must belong to the lead's property.
    if (slot.property_id !== lead.property_id) {
      const e = new Error("That slot isn't at this property."); e.httpStatus = 409; e.publicMessage = e.message; throw e;
    }

    // ── soft-closed conversation guard (when the lifecycle service is present) ──
    if (leasingLifecycle && typeof leasingLifecycle.assertNotSoftClosedForLead === "function") {
      await leasingLifecycle.assertNotSoftClosedForLead(client, { leadId: lead.id });
    }

    // ── create the tour on this slot (status 'scheduled'). Execution is SYSTEM;
    //    the confirming prospect + originating cause are recorded, not conflated.
    const tour = (await client.query(
      `insert into leasing_tours
         (lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status, booking_idempotency_key)
       values ($1,$2,$3,$4,$5,$6,'scheduled',$7) returning *`,
      [lead.id, lead.property_id, slot.unit_id, slot.leasing_agent_id, slotId, slot.starts_at, idempotencyKey || null])).rows[0];

    // flip the slot to booked (partial unique index is the concurrent backstop)
    await client.query(
      `update tour_availability set status='booked', booked_tour_id=$1, updated_at=now() where id=$2`,
      [tour.id, slotId]);

    // tour_events: EXECUTION actor is 'system'; the prospect is the SUBJECT
    // (recorded in metadata), the originating comm_event/run is the CAUSE.
    await recordTourEvent(client, {
      tourId: tour.id, leadId: lead.id, type: "scheduled",
      actorType: "system", actorId: null, slotId,
      metadata: {
        scheduled_for: slot.starts_at, slot_id: slotId, via,
        subject_person_id: subjectPersonId || lead.person_id,
        source_comm_event_id: sourceCommEventId,
        source_agent_run_id: sourceAgentRunId,
        execution_actor: "system",
      },
    });

    // funnel advance — SAME recordLeadEvent the operator/link paths use.
    await recordLeadEvent(client, {
      leadId: lead.id, type: "tour_scheduled", actorType: "system",
      commEventId: sourceCommEventId || null,
      metadata: {
        tour_id: tour.id, slot_id: slotId, scheduled_for: slot.starts_at, via,
        subject_person_id: subjectPersonId || lead.person_id,
        source_agent_run_id: sourceAgentRunId,
      },
      statusPatch: { tour_scheduled_at: slot.starts_at },
    });

    return { tour, alreadyBooked: false };
  }

  // Property capability for AGENT tour booking. PERMANENT gate (not a demo flag):
  // a property is agent-booking-enabled iff its id is in
  // AGENT_TOUR_BOOKING_PROPERTY_IDS (comma-separated). Absent = OFF everywhere.
  // Conversation permission and booking authority are SEPARATE activations —
  // being allowed to reply never implies being allowed to book.
  function propertyAgentBookingEnabled(propertyId) {
    const perim = (process.env.AGENT_TOUR_BOOKING_PROPERTY_IDS || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    return perim.includes(String(propertyId));
  }

  // Property operating timezone — resolved through the ONE shared resolver
  // (property_timezone.js), the SAME truth operator.js uses. Honest null for an
  // unconfigured property; booking/offers refuse rather than invent local times.
  const { loadPropertyOperatingTimeZone } = require("../shared/property_timezone");
  // Slice 9 ruling 1A: the name says ASYNC. A sync-looking name returning a
  // Promise already cost one regression in a proof fixture; the next caller
  // does not get to make that mistake.
  // DECLARED async, not merely Promise-returning. A sync function that hands
  // back a Promise reads as sync to every shape check and to every human
  // skimming it — the exact trap ruling 1A was written to close.
  async function loadPropertyOperatingTimezone(propertyId) {
    return loadPropertyOperatingTimeZone(pool, propertyId); // null = unconfigured
  }

  // ── OFFERABLE SLOTS READER — the slots the agent may OFFER this turn,
  //    formatted in the property's OPERATING timezone. If the property's tz is
  //    UNCONFIGURED, returns null: no labels, and the caller must not offer or
  //    book (honest refusal, never an invented local time). Returns real open,
  //    future slots with a stable id + human label.
  async function readOfferableSlots(client, { propertyId, limit = 4 }) {
    const tz = await loadPropertyOperatingTimezone(propertyId);
    if (!tz) return null; // unconfigured tz → no offer set (honest)
    const rows = (await (client || pool).query(
      `select id, starts_at, ends_at, unit_id
         from tour_availability
        where property_id=$1 and status='open' and starts_at > now()
        order by starts_at
        limit $2`, [propertyId, limit])).rows;
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    return rows.map(r => ({
      slot_id: r.id,
      unit_id: r.unit_id,
      starts_at: r.starts_at,
      label: fmt.format(new Date(r.starts_at)), // e.g. "Thu, Jul 16, 2:00 PM"
    }));
  }

  // ── DURABLE OFFER RECORD ─────────────────────────────────────────────
  //  A slot is confirmable later ONLY because it was actually PRESENTED to the
  //  prospect in an outbound message — recorded here, connecting the exact
  //  stated slot ids + the outbound comm_event + the run + freshness. NOT the
  //  whole context pool. recordTourOffer SUPERSEDES prior active offers for the
  //  conversation by default (a new availability offer replaces the old set),
  //  so contradictory offers never stay simultaneously bookable.
  const OFFER_TTL_MINUTES = 60 * 48; // 48h freshness on an offer
  // The OFFER RECORD owns the active→superseded transition — the conversation
  // (agent turn) never decides it. The algorithm is atomic by construction:
  //   BEGIN → mark current active offer superseded → insert new active → COMMIT
  // so there is EXACTLY ONE active offer per conversation, guaranteed. The
  // partial unique index (agent_tour_offers_one_active_per_conv) makes that a
  // hard DB invariant: a concurrent second writer raises 23505 rather than
  // leaving two active offers. resolveActiveOfferedSlotIds is then trivial —
  // there is one active offer, not "the newest by ordering."
  //
  // Runs in its OWN transaction on its OWN connection (decoupled from any caller
  // tx and from the dispatch path). supersede=false would supplement instead of
  // replace, but the default and only current caller is supersede=true.
  async function recordTourOffer(clientIgnored, { conversationId, leadId, propertyId, agentRunId, outboundCommEventId, slotIds, supersede = true }) {
    if (!conversationId || !propertyId || !Array.isArray(slotIds) || !slotIds.length) return null;
    const expires = new Date(Date.now() + OFFER_TTL_MINUTES * 60 * 1000);
    const c = await pool.connect();
    try {
      await c.query("begin");
      if (supersede) {
        await c.query(
          `update agent_tour_offers set status='superseded'
            where conversation_id=$1 and status='active'`, [conversationId]);
      }
      const row = (await c.query(
        `insert into agent_tour_offers
           (conversation_id, lead_id, property_id, agent_run_id, outbound_comm_event_id, slot_ids, expires_at, status)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,'active') returning *`,
        [conversationId, leadId || null, propertyId, agentRunId || null, outboundCommEventId || null,
         JSON.stringify(slotIds.map(String)), expires.toISOString()]
      )).rows[0];
      await c.query("commit");
      return row;
    } catch (e) {
      try { await c.query("rollback"); } catch (_) {}
      // 23505 on the one-active-per-conv index = a concurrent offer already won.
      // The active offer is whatever committed first; surface it rather than
      // leaving a contradictory state or throwing into the reply loop.
      if (e && e.code === "23505") {
        const existing = (await pool.query(
          `select * from agent_tour_offers where conversation_id=$1 and status='active' limit 1`, [conversationId])).rows[0];
        if (existing) return existing;
      }
      throw e;
    } finally { c.release(); }
  }

  // Trivial by construction: there is at most ONE active offer per conversation
  // (recordTourOffer's atomic supersede+insert + the DB unique index guarantee
  // it). So this is a single-row lookup, not a "newest by ordering" heuristic.
  // A superseded or expired offer authorizes nothing.
  async function resolveActiveOfferedSlotIds(client, { conversationId }) {
    if (!conversationId) return { ids: new Set(), offerId: null };
    const row = (await (client || pool).query(
      `select id, slot_ids from agent_tour_offers
        where conversation_id=$1 and status='active' and expires_at > now()
        limit 1`, [conversationId])).rows[0];
    if (!row) return { ids: new Set(), offerId: null };
    let arr = row.slot_ids;
    if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch (_) { arr = []; } }
    const ids = new Set((Array.isArray(arr) ? arr : []).map(String));
    return { ids, offerId: row.id };
  }

  // Mark an offer consumed once its slot is booked (bookkeeping; the tour's own
  // idempotency key is the real exactly-once guard).
  async function consumeTourOffer(client, { offerId }) {
    if (!offerId) return;
    await (client || pool).query(`update agent_tour_offers set status='consumed' where id=$1 and status='active'`, [offerId]).catch(() => {});
  }

  // Best-effort provenance: after the presenting reply actually dispatches,
  // link its outbound comm_event to the offer row. This is PROVENANCE, not
  // authority — the offer already exists and already authorizes confirmation
  // (recorded when the model stated the slots). A dispatch hiccup must never
  // un-authorize a stated offer, so this is fire-and-forget.
  async function attachOutboundToOffer(client, { offerId, outboundCommEventId }) {
    if (!offerId || !outboundCommEventId) return;
    await (client || pool).query(
      `update agent_tour_offers set outbound_comm_event_id=$2 where id=$1 and outbound_comm_event_id is null`,
      [offerId, outboundCommEventId]
    ).catch(() => {});
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
  // ════════════════════════════════════════════════════════════════════
  // completeTourService — the ONE tour-completion transaction. Extracted
  // (byte-faithful) from the operator-key route so the session-authed
  // /operator door calls the SAME canonical service (no fork — the
  // intakeProspect precedent). Caller owns client + begin/commit/rollback.
  // enforcePropertyId: the staff-session door passes the session's property;
  // the tour must belong to it (server-derived wall). The key door passes null.
  // Throws svcErr(status, body) — the exact response the route should send.
  // ════════════════════════════════════════════════════════════════════
  async function completeTourService(client, { tourId, b, recordedByUserId, enforcePropertyId = null }) {
      const fb = b.feedback || {};
      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { throw svcErr(404, { receipt: "No tour with that id." }); }
      if (enforcePropertyId && tour.property_id !== enforcePropertyId) {
        throw svcErr(403, { receipt: "That tour belongs to another property." });
      }
      // OUTCOME IS RECORDED ONCE. A terminal tour keeps its truth; corrections
      // go through explicit lifecycle actions, never a silent re-submit.
      if (["completed", "no_show", "cancelled", "rescheduled"].includes(tour.status)) {
        // ── ALREADY CAPTURED. Two very different situations. ────────────
        //  A REPLAY — the same save arriving twice because the phone lost
        //  signal, the operator pressed twice, or the request was retried —
        //  must return the ORIGINAL result and look like success. It was
        //  successful; the operator has no idea their tap went out twice
        //  and should never be shown an error for it.
        //
        //  A DIFFERENT capture on a settled tour is a correction, which has
        //  its own deliberate lane (/correct-outcome, which never mutates
        //  the original). That still refuses — but in words a person can
        //  act on, not a status code.
        const prior = (await client.query(
          `select id, event_at, metadata from tour_events
            where tour_id=$1 and event_type in ('completed','no_show','cancelled')
            order by event_at asc limit 1`, [tourId])).rows[0];
        const priorKey = prior && prior.metadata && prior.metadata.capture_idempotency_key;
        const incomingKey = (typeof b.idempotency_key === "string" && b.idempotency_key.trim())
          ? b.idempotency_key.trim() : null;

        // the relationship this tour belongs to — found by PERSON, not by
        // origin_tour_id, because a second tour reuses the first tour's
        // conversion and origin_tour_id would miss it entirely.
        const personRow = tour.lead_id
          ? (await client.query(`select person_id from leasing_leads where id=$1`, [tour.lead_id])).rows[0]
          : null;
        const conv = personRow ? (await client.query(
          `select id, current_stage, status from leasing_conversions
            where person_id=$1 and property_id=$2 and status='active' limit 1`,
          [personRow.person_id, tour.property_id])).rows[0] : null;

        if (incomingKey && priorKey && incomingKey === priorKey) {
          return {
            ok: true, replayed: true,
            tour_id: tourId,
            conversion_id: conv ? conv.id : null,
            receipt: "Already saved — nothing changed.",
          };
        }

        throw svcErr(409, {
          receipt: "This tour was already saved. To change what was recorded, use Correct outcome — the original stays on the record.",
          tour_id: tourId, conversion_id: conv ? conv.id : null,
        });
      }

      // ── attendance truth (the same one-door event write as always) ──
      // v2: the event metadata carries the FULL structured outcome + the
      // tri-attribution (scheduled / actual-claim / recorder). The event row
      // is the record; conversions/board are projections of it.
      // ── #4: the RECORDER is server-derived from the staff session when
      //    present; the body value is only a shared-key-path fallback and can
      //    never override a resolved session identity.

      // ── #3: the ACTUAL-HOST claim has exactly two honest shapes:
      //    (A) a roster-selected active property-staff user → asserted staff
      //        claim, eligible to be considered for ownership; or
      //    (B) a free-text name → stored/rendered as free text ONLY, never
      //        dereferenced to a user, never eligible to own.
      //    An arbitrary id that is not an active assignment at THIS property is
      //    NOT accepted as a staff identity — it degrades to a free-text claim.
      let actualHostUserId = null;      // a real, roster-validated staff user
      let actualHostNameClaim = null;   // free-text only
      const rawHostId = b.actual_tour_host_user_id || null;
      if (rawHostId) {
        // 067: roster validation goes through the CANONICAL resolver — the
        // same eligibility the obligation owner gate uses (active-eligible
        // account + deliberate bridge + human_staff + no conflict + active
        // assignment HERE). No raw users.person_id join in this module.
        const hostRes = await staffIdentity.resolveStaffIdentity(client,
          { user_id: rawHostId, property_id: tour.property_id });
        if (hostRes.state === "resolved") actualHostUserId = rawHostId; // path A — verified roster
        else actualHostNameClaim = String(b.actual_tour_host_name || rawHostId).slice(0, 120); // arbitrary/unresolvable id → free text only
      } else if (b.actual_tour_host_name) {
        actualHostNameClaim = String(b.actual_tour_host_name).slice(0, 120); // path B — free text
      }
      // legacy default: if nothing supplied, the scheduled agent is the presumed host claim
      const actualHostEarly = actualHostUserId || (actualHostNameClaim ? null : (b.actor_id || null));
      const v2outcome = (fb.disposition || fb.what_landed || fb.whats_in_way || fb.next_move) ? {
        disposition: fb.disposition || null,               // start_application|keep_working|needs_change|close_watch
        sub_read: fb.sub_read || null,                     // hot|warm|exploring (keep_working only)
        what_landed: Array.isArray(fb.what_landed) ? fb.what_landed.slice(0, 9) : [],
        whats_in_way: Array.isArray(fb.whats_in_way) ? fb.whats_in_way.slice(0, 8) : [],
        next_move: fb.next_move || null,
        future_fit: fb.future_fit || null,                 // close_watch: keep|close
        note: fb.notes || null,
      } : null;

      // ── STANDING (v3) — the ONE judgment only the agent can supply ──────
      //  Three vocabularies have accumulated here (v1 free text, v2
      //  disposition+sub_read, v3 the four words). normalizeStanding is the
      //  single bridge; it resolves what was genuinely captured and REFUSES
      //  what was not. 'interested' does not become 'hot_lead' because
      //  somebody wanted a tidier column — that distinction was never
      //  recorded and inventing it would manufacture a judgment.
      //  ATTRIBUTION: a standing is only a standing if a human who was there
      //  supplied it. recordedByUserId is SERVER-DERIVED from the session, so
      //  a body value can never forge it. The decision itself lives in
      //  tour_outcome.js — one place, directly testable, not copied here.
      const TOUT = require("./tour_outcome");
      const _cap = TOUT.resolveCapturedStanding({ fb, recordedByUserId });
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "completed",
        actorType: "human", actorId: recordedByUserId,
        metadata: {
          scheduled_for: tour.scheduled_for, tour_given: fb.tour_given !== false,
          actual_tour_host_user_id: actualHostEarly,           // roster-validated user OR null
          actual_tour_host_name_claim: actualHostNameClaim,    // #3: free-text only, never dereferenced
          recorded_by_user_id: recordedByUserId,               // #4: SERVER-DERIVED from the session
          outcome: v2outcome,
          // ── v3 standing, recorded on the immutable event ──────────────
          //  The event is the record; conversions and the board are
          //  projections of it. When the standing could NOT be resolved the
          //  reason is recorded too — an honest blank that explains itself
          //  beats a silent null nobody can account for later.
          // the key that made this capture, so a replay of the SAME save can
          // be recognised as a replay rather than refused as a conflict
          capture_idempotency_key: (typeof b.idempotency_key === "string" && b.idempotency_key.trim())
            ? b.idempotency_key.trim().slice(0, 200) : null,
          standing: _cap.standing,
          standing_source: _cap.source,
          standing_unresolved_reason: _cap.unresolved_reason,
          judged_by: _cap.judged_by,
          next_move_key: _cap.next_move ? _cap.next_move.key : null,
        },
      });

      // ── actual units shown (1..5; every unit must belong to THIS property) ──
      const unitsShown = Array.isArray(b.units_shown) ? b.units_shown.filter(Boolean).slice(0, 5) : [];
      for (let i = 0; i < unitsShown.length; i++) {
        const u = (await client.query(`select id from units where id=$1 and property_id=$2`, [unitsShown[i], tour.property_id])).rows[0];
        if (!u) { throw svcErr(409, { receipt: "One of the units shown isn't at this property." }); }
        await client.query(
          `insert into tour_units_shown (tour_id, unit_id, shown_order) values ($1,$2,$3)
           on conflict (tour_id, unit_id) do nothing`, [tourId, unitsShown[i], i + 1]);
      }

      // ── preferred unit: a PREFERENCE record only — never a hold, never a
      //    reservation, creates no turnover priority (asset-protection rule) ──
      let preferredUnitId = null;
      if (b.preferred_unit_id) {
        const pu = (await client.query(`select id from units where id=$1 and property_id=$2`, [b.preferred_unit_id, tour.property_id])).rows[0];
        if (!pu) { throw svcErr(409, { receipt: "The preferred unit isn't at this property." }); }
        preferredUnitId = pu.id;
      }

      // ── open the conversion rail (047's single door) when a tour was GIVEN.
      //    Assignment is not authorship: the ACTUAL host is who gave it. ──
      let conversion = null;
      const bitsExtra = [];   // concession-capture receipt lines (built in-tx, joined after commit)
      if (fb.tour_given !== false) {
        if (!conversionServices || typeof conversionServices.createConversionFromTour !== "function") {
          throw svcErr(503, { receipt: "Outcome rail is not wired on this server yet — deploy the wave-3 server.js, then retry." });
        }
        // The conversion needs SOME actual-host anchor. Use the roster-validated
        // host if we have one; otherwise fall back to the scheduled agent (a real
        // user) so the rail can open — the free-text name claim is NOT a user and
        // is carried separately on the event, never as the host user id.
        const actualHost = actualHostUserId || tour.leasing_agent_id || recordedByUserId || null;
        // (the service itself 422s without an actual host — its rule, kept)
        const opened = await conversionServices.createConversionFromTour(client, {
          person_id: tour.lead_id ? (await client.query(`select person_id from leasing_leads where id=$1`, [tour.lead_id])).rows[0].person_id : null,
          property_id: tour.property_id,
          origin_tour_id: tourId, lead_id: tour.lead_id,
          scheduled_tour_host_user_id: tour.leasing_agent_id || null,
          actual_tour_host_user_id: actualHost,
          feedback_recorded_by_user_id: recordedByUserId,      // #4: server-derived
          // #1: the operator may explicitly choose the follow-up owner from the
          // active-eligible roster. It is honored ONLY if eligible (the service
          // re-validates); absent it, ownership falls to eligible actual/scheduled.
          explicit_owner_user_id: (b.follow_up_owner_user_id || null),
          //  Prefer the resolved four-word standing; fall back to the raw
          //  value when it could not be resolved, so nothing the agent
          //  supplied is ever silently discarded. New captures get a word
          //  that routes; legacy shapes keep working untouched.
          tour_outcome: _cap.tour_outcome_value,
          tour_notes: fb.notes || null,
          // v2: the RECOMMENDATION is the content of the follow-up obligation —
          // never a soft word that can rot unowned. Carried into the rung label.
          recommendation: fb.next_move || null,
          // multi-move: the frontend may send next_moves[] (ordered). First is
          // primary; the rest become sibling task obligations.
          recommendations: Array.isArray(fb.next_moves) && fb.next_moves.length ? fb.next_moves : null,
        });
        conversion = opened.conversion;

        // ── SOURCED OBSERVATIONS (v2) — recognition over re-entry, with the
        //    061 supersede model: retire-then-insert, one active per key,
        //    every fact carries its receipt (source_ref = this tour).
        //    The frontend sends only what was confirmed/edited on a live lead;
        //    a dead lead sends nothing (never forced).
        const ess = b.essentials || {};
        const OBS_KEYS = { budget: "budget", move_month: "move_month", unit_type: "unit_type" };
        for (const [k, attrKey] of Object.entries(OBS_KEYS)) {
          const v = ess[k] && typeof ess[k].value === "string" ? ess[k].value.trim() : null;
          if (!v) continue;
          // skip a no-op confirm of the identical active value (still a real
          // confirm? — a confirm IS knowledge; write it only when changed OR
          // explicitly flagged confirmed, so the lineage stays meaningful)
          // SAVEPOINT. This loop runs inside the CALLER's transaction. Any error
          // here — most likely 23505 from a concurrent capture (an inbound text
          // racing this tour close on the same person+key) — aborts that whole
          // transaction, so every later statement fails with 25P02 and the tour
          // completion returns 500. The operator then cannot close the tour at
          // all because a prospect happened to text at the wrong moment.
          // An observation is enrichment; it must never block recording that the
          // tour happened. The savepoint scopes the failure to one observation.
          await client.query("savepoint pa_obs");
          try {
            const u = await recordPersonFact(client, {
              personId: conversion.person_id, propertyId: tour.property_id,
              attrKey, attrValue: v,
              source: "human",                       // the capture CHANNEL
              // THE RECEIPT, TYPED — and this is the live provenance bug being
              // closed. tourId is a leasing_tours id, and it has been going into
              // source_ref under source='human' while 061 declares that column
              // holds a comm_event or a lead id. Anything resolving the receipt
              // by branching on `source` looked in the wrong table and found
              // nothing. Now the row says which table it is.
              sourceRecordType: "leasing_tour",
              sourceRecordId: tourId,
              // a tour close carries no separate statement time — the operator is
              // recording it as they close. Labelled as the proxy it is.
              occurredAt: new Date().toISOString(),
              occurredAtBasis: "recorded_proxy",
              // THE ACTOR — already in scope as a parameter of this service and
              // simply never written down. The machine door can supply no user at
              // all, and the service normalizes that to 'unattributed' rather than
              // inventing one or rejecting the row.
              actorType: recordedByUserId ? "operator" : "unattributed",
              actorUserId: recordedByUserId || null,
              // staff transcribing a prospect's self-report is still a self-report
              claimStrength: "asserted",
              verb: "captured",
              // NO idempotency key: a tour close is an operator command, not a
              // retried webhook, and the same tour legitimately re-completes with
              // corrected values.
            });
            await client.query("release savepoint pa_obs");
            if (!u.written) continue;                 // unchanged → nothing to report
            bitsExtra.push(`${attrKey} ${u.superseded_id ? "updated" : "captured"}: ${v}.`);
          } catch (e) {
            await client.query("rollback to savepoint pa_obs").catch(() => {});
            console.error(`[tour_capture] observation '${attrKey}' not written (non-fatal):`, (e && e.message) || "unknown");
          }
        }
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

        // ── STRUCTURED CONCESSION CAPTURE (Commitment Ledger, Stream 2) ──
        // The promise is born WHERE it happens — on the tour, not later
        // through a developer endpoint. If the host captured a concession,
        // it leaves the soft-reactions junk drawer and becomes a first-class
        // guardrail-checked claim, with the tour itself as the evidence of
        // communication (host attestation: a claim, attributed and timed).
        //   · in-scope / soft  → a real lease_offer, in THIS transaction
        //   · hard-blocked     → NO offer, but the spoken promise is
        //     RECORDED as an incident + resolution obligation — and the
        //     tour outcome itself is never rolled back by the block
        //     (blocked concession and completed tour commit together).
        if (b.concession && commitmentLedger && typeof commitmentLedger.createLeaseOffer === "function") {
          // dormant gate: the capture hook invokes the ledger DIRECTLY (not via
          // an HTTP route), so the fail-closed check must run HERE too — an
          // internal caller must not bypass dormancy to mint an offer/incident.
          const { resolveMode } = require("../identity/dormant_gate");
          if (resolveMode() !== "enabled") {
            throw svcErr(403, {
              error: "commitment_ledger_dormant", code: "LEDGER_DORMANT",
              receipt: "Concession capture is disabled: the Commitment Ledger is in DORMANT mode. No offer or incident can be created until it is explicitly enabled.",
            });
          }
          const cSpec = b.concession || {};
          // grants/offers key on PERSONS; tour actors are USERS — the
          // users↔persons identity bridge is an open ask, so the promiser's
          // person identity is explicit here (flagged, not papered over).
          if (!cSpec.granted_by_person_id) {
            throw svcErr(400, { receipt: "concession.granted_by_person_id is required — the promise must be attributed to the person who made it." });
          }
          const prospectPersonId = tour.lead_id
            ? (await client.query(`select person_id from leasing_leads where id=$1`, [tour.lead_id])).rows[0].person_id
            : null;
          // #2 EVIDENCE HONESTY. A scheduled appointment time is NOT proof the
          // tour occurred then, nor that the promise was communicated then.
          // So we do NOT auto-manufacture a tour window from tour.scheduled_for
          // and feed it to an attestation as if it were observed. The caller
          // must supply the real observed window (actual attendance / recorded
          // start-end) when it exists; otherwise the host attestation stands on
          // an attributable late_capture_reason. The scheduled time is passed
          // ONLY as an explicit, labeled fallback boundary the ledger may use
          // for sanity, never as verified actual communication time.
          const observedWindowStart = cSpec.tour_window_start || null;
          const observedWindowEnd = cSpec.tour_window_end || null;
          const scheduledFallback = tour.scheduled_for || null;   // planned, NOT observed
          const ledgerOut = await commitmentLedger.createLeaseOffer(client, {
            property_id: tour.property_id,
            granted_by_person_id: cSpec.granted_by_person_id,
            recorded_by_person_id: cSpec.recorded_by_person_id || cSpec.granted_by_person_id,
            person_id: prospectPersonId,
            application_id: null,
            promise_state: cSpec.promise_state || "communicated",
            // target: an exact quoted space OR an eligibility scope —
            // either way the offer NEVER holds a room.
            space_id: cSpec.space_id || null,
            scope: cSpec.space_id ? null : (cSpec.scope || "property"),
            scope_ref: cSpec.space_id ? null : (cSpec.scope_ref || null),
            max_economic_value: cSpec.max_economic_value || null,
            source: cSpec.source || "discretionary",
            unit_type: cSpec.unit_type,
            lease_term_months: cSpec.lease_term_months,
            published: cSpec.published || null,
            discretionary: cSpec.discretionary || null,
            // the host attestation IS the communication evidence — an
            // attributed claim, not a recording. communicated_at is the host's
            // stated time; recorded_at is stamped now by the ledger.
            communicated_at: cSpec.communicated_at || new Date().toISOString(),
            evidence_type: "tour_host_attestation",
            evidence_ref: String(tourId),
            source_tour_id: tourId,
            // observed window ONLY if the caller actually captured it; the
            // scheduled time is passed separately as a labeled planned fallback.
            tour_window_start: observedWindowStart,
            tour_window_end: observedWindowEnd,
            scheduled_reference: scheduledFallback,
            late_capture_reason: cSpec.late_capture_reason || null,
          });
          if (ledgerOut.blocked && ledgerOut.exploratory) {
            bitsExtra.push(`Concession was exploratory and outside guardrails — nothing promised, nothing recorded.`);
          } else if (ledgerOut.blocked) {
            const incId = ledgerOut.incident ? ledgerOut.incident.id : "(recording)";
            bitsExtra.push(`Concession OUTSIDE guardrails (${ledgerOut.why}) — offer NOT created; the spoken promise was recorded as incident ${incId}${ledgerOut.deduped ? " (already recorded)" : ""} and routed for resolution.`);
          } else {
            bitsExtra.push(`Concession captured as a real offer (${ledgerOut.band}) · value $${Number(ledgerOut.concession_authority_value).toLocaleString()}${ledgerOut.offer.guardrail_flag ? " · FLAGGED for review" : ""}.`);
          }
        }
      }

      const bits = [`Outcome recorded — tour ${fb.tour_given === false ? "marked complete (no tour given)" : "given"}.`];
      if (unitsShown.length) bits.push(`${unitsShown.length} unit${unitsShown.length > 1 ? "s" : ""} shown.`);
      if (conversion) bits.push(`Follow-up rail opened — ${fb.interest_level || "outcome"} · owner set to the actual host.`);
      bits.push(...bitsExtra);
      return { receipt: bits.join(" "), tour_id: tourId, conversion_id: conversion ? conversion.id : null };
  }

  // ── the operator-KEY door: identical external contract to before the
  //    extraction (same auth, same statuses, same bodies). ──
  router.post("/leasing/tours/:tourId/complete", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const sessionRecorderId = await resolveRecorderUserId(req);
      const recordedByUserId = sessionRecorderId || b.actor_id || null;
      const out = await completeTourService(client, { tourId, b, recordedByUserId, enforcePropertyId: null });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      if (e.svc) return res.status(e.http).json(e.body);
      if (e.http === 422 || e.httpStatus === 422) return res.status(422).json({ receipt: e.message });
      console.error("leasing complete:", e);
      return res.status(500).json({ receipt: "Could not complete the tour.", error: e.message });
    }
    finally { client.release(); }
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /leasing/tours/:tourId/correct-outcome — THE MINIMUM CORRECTION LANE (#2).
  //
  // A staff member WILL sometimes record the wrong disposition, host, next move,
  // or no-show flavor. Without a deliberate correction action, the only recourse
  // is back-channel work or DB repair — the exact rot this product replaces. This
  // is the bounded, honest correction primitive: it NEVER mutates the original.
  //
  // Requires:  reason (non-empty) · authenticated correction actor (server-derived)
  //            · the prior tour outcome exists · revised fields
  // Writes:    an append-only 'outcome_corrected' tour_event carrying
  //            { corrects_event, reason, prior, revised, corrected_by, corrected_at }
  //            · updates the conversion's tour_outcome projection to the revised value
  //            · the card's HISTORY renders it as a distinct "tour outcome corrected"
  //              entry (tour_events are already projected), original preserved above it.
  // The original completed event and its outcome remain byte-unchanged.
  // ══════════════════════════════════════════════════════════════════
  router.post("/leasing/tours/:tourId/correct-outcome", requireOperator, async (req, res) => {
    const { tourId } = req.params; const b = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("begin");
      const correctedBy = (await resolveRecorderUserId(req)) || b.actor_id || null;
      const reason = (typeof b.reason === "string") ? b.reason.trim() : "";
      if (!reason) { await client.query("rollback"); return res.status(400).json({ receipt: "A correction needs a reason — the person who recorded it deserves to know why it changed." }); }

      const tour = (await client.query(`select * from leasing_tours where id=$1`, [tourId])).rows[0];
      if (!tour) { await client.query("rollback"); return res.status(404).json({ receipt: "No tour with that id." }); }

      // the prior outcome we are correcting must exist (the original completed event)
      const original = (await client.query(
        `select id, metadata, event_at from tour_events
          where tour_id=$1 and event_type='completed' order by event_at asc limit 1`, [tourId])).rows[0];
      if (!original) { await client.query("rollback"); return res.status(409).json({ receipt: "There's no recorded tour outcome to correct yet." }); }

      const priorOutcome = (original.metadata && original.metadata.outcome) || null;
      // revised fields — only the outcome-shaped ones, validated against the frozen vocab shape
      const rev = b.revised || {};
      const revised = {
        disposition: rev.disposition || (priorOutcome && priorOutcome.disposition) || null,
        sub_read: rev.sub_read !== undefined ? rev.sub_read : (priorOutcome && priorOutcome.sub_read) || null,
        what_landed: Array.isArray(rev.what_landed) ? rev.what_landed.slice(0, 9) : (priorOutcome && priorOutcome.what_landed) || [],
        whats_in_way: Array.isArray(rev.whats_in_way) ? rev.whats_in_way.slice(0, 8) : (priorOutcome && priorOutcome.whats_in_way) || [],
        next_move: rev.next_move || (priorOutcome && priorOutcome.next_move) || null,
        future_fit: rev.future_fit !== undefined ? rev.future_fit : (priorOutcome && priorOutcome.future_fit) || null,
        note: rev.note !== undefined ? rev.note : (priorOutcome && priorOutcome.note) || null,
      };

      // APPEND the correction event — the original is never touched.
      await recordTourEvent(client, {
        tourId, leadId: tour.lead_id, type: "outcome_corrected",
        actorType: "human", actorId: correctedBy,
        metadata: {
          corrects_event: original.id,
          reason,
          prior: priorOutcome,
          revised,
          corrected_by_user_id: correctedBy,     // server-derived
          corrected_at: new Date().toISOString(),
        },
      });

      // update the conversion's projection (current truth) — the correction event
      // is the audit trail; the conversion reflects the revised current disposition.
      const conv = (await client.query(
        `select id from leasing_conversions where origin_tour_id=$1 order by opened_at asc limit 1`, [tourId])).rows[0];
      if (conv && revised.disposition) {
        await client.query(
          `update leasing_conversions set tour_outcome=$1, updated_at=now() where id=$2`,
          [revised.disposition, conv.id]);
      }

      await client.query("commit");
      return res.json({
        receipt: `Outcome corrected — the original is preserved and the change is on the record with your reason.`,
        tour_id: tourId, conversion_id: conv ? conv.id : null,
        prior_disposition: priorOutcome ? priorOutcome.disposition : null,
        revised_disposition: revised.disposition,
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      return res.status(e.httpStatus || 500).json({ receipt: e.publicMessage || e.message });
    } finally { client.release(); }
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
        actorType: b.actor_id ? "human" : "system", actorId: (await resolveRecorderUserId(req)) || b.actor_id || null,
        // #5: attendance truth and NOTICE are SEPARATE facts — a person who told
        // us they couldn't come is not operationally a silent no-show. Storing
        // one flat "notified no-show" would lose the distinction future
        // reliability/conversion analysis needs. Persist both axes.
        //   attendance_status: showed_up | did_not_attend | rescheduled
        //   notice_status:     none | notified
        metadata: {
          scheduled_for: tour.scheduled_for,
          attendance_status: "did_not_attend",
          notice_status: (b.notified === true || b.attendance === "no_show_notified" || b.notice_status === "notified")
            ? "notified" : "none",
          // legacy compound kept for back-compat readers; new readers use the two axes above
          attendance: (b.notified === true || b.attendance === "no_show_notified" || b.notice_status === "notified")
            ? "no_show_notified" : "no_show_no_contact",
          reason: (typeof b.reason === "string" && b.reason.trim()) ? b.reason.trim().slice(0, 300) : null,
        },
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
      // ── NEW TOUR ONTO THE NEW SLOT — ATTRIBUTION MUST SURVIVE ────────
      //  A reschedule successor CONTINUES an attempt; it does not begin one.
      //  This insert copied lead_id, property_id, unit_id, leasing_agent_id,
      //  slot_id, scheduled_for, status and rescheduled_from — and NOT
      //  conversion_id. A chain that began attributed became unattributed at its
      //  second occurrence, silently, and no later pass could repair it because
      //  the inference that would have to fill it is forbidden.
      //
      //  The successor INHERITS verbatim: no re-resolution, no lookup, no
      //  re-validation against current state. Whatever the predecessor was
      //  attributed to, the continuation is attributed to.
      const inherited = attribution.inheritAttribution(oldTour);
      const newTour = (await client.query(
        `insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id, slot_id, scheduled_for, status, rescheduled_from, conversion_id)
         values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8) returning *`,
        [oldTour.lead_id, oldTour.property_id, newSlot.unit_id, newSlot.leasing_agent_id,
         b.new_slot_id, newSlot.starts_at, tourId, inherited.conversion_id])).rows[0];
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

  // ONE canonical completion service, exposed for the staff-session door
  // in operator.js — the same no-fork handoff as agentApp._service.
  router._service = {
    //  The ONE canonical intake. Exposed so a door that cannot live in this
    //  file — the public site door, which a browser reaches with no secret —
    //  calls this service rather than building a second one. Same no-fork
    //  handoff as the entries below it.
    intakeProspect,
    completeTour: completeTourService,
    bookTourIntoSlot,          // the ONE canonical booking transaction
    readOfferableSlots,        // slots the agent may offer this turn (property tz; null if tz unconfigured)
    recordTourOffer,           // durable offer record (atomic supersede+insert; owns the transition)
    resolveActiveOfferedSlotIds, // the single active offer's slot ids (booking authority)
    consumeTourOffer,          // mark an offer consumed on booking
    attachOutboundToOffer,     // best-effort provenance link to the dispatched outbound
    propertyAgentBookingEnabled, // permanent per-property booking capability
    loadPropertyOperatingTimezone,  // ASYNC — governed column read, honest null
  };
  // TEST-ONLY (Class 3, inert at runtime): exposes the opener drafter so the
  // voice harness asserts against the REAL emitted text, not a copy. No route,
  // no side effect. Removal condition: delete with prove_voice_v8.js.
  router.__test__ = { draftFirstResponse };

  return router;
};
