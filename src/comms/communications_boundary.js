// ════════════════════════════════════════════════════════════════════
//  COMMUNICATIONS BOUNDARY — communications_boundary.js
//
//  THE PERMANENT COMMUNICATIONS BOUNDARY for Property Spine.
//  Class 1 permanent product primitive.
//
//  One line, one property, one continuous communication history, one safe
//  way to send. The person feels only "I text the property." Behind the
//  glass this module guarantees:
//    • the RECEIVING line determines the property (never the sender,
//      never a client/body-supplied property_id)
//    • the sender is resolved INSIDE that property
//    • every property-facing send derives its `from` server-side and
//      refuses without it — never a Messaging Service default fallback
//    • one central eligibility decision (consent / classification /
//      scope / purpose / send-mode) gates every outbound, with exactly
//      one refusal reason
//    • raw Twilio (sms.js) is transport only; NO business module calls it
//
//  Broader than SMS by intent: SMS is today's transport; the boundary is
//  the primitive. Property, identity, consent, classification,
//  attribution, and continuous history keep one meaning when future
//  channels attach here.
//
//  ── THE TWO CANONICAL FACTS THIS MODULE READS (kept separate) ──
//  1) RECORD CLASSIFICATION — person_property_classifications (076).
//     Property-scoped: the same person can be internal_qa in one property
//     and production in another. ABSENCE = UNCLASSIFIED, never silently
//     production. Append-only supersession; record_class never updated
//     in place.
//  2) CHANNEL CONSENT — contact_preferences.consent_state.
//     The one canonical consent truth. Never duplicated onto the
//     classification row (a STOP must have exactly one place to land).
//  canSendSmsForRecord REQUIRES both; it never stores both in one row.
//
//  Factory: injected with { pool, sms }. Instantiate ONCE in server.js,
//  inject into every business module that sends. Business modules call
//  commBoundary.sendPropertySms(...) and never sms.sendSms.
// ════════════════════════════════════════════════════════════════════

module.exports = function communicationsBoundary({ pool, sms }) {
  const smsReady = () => !!(sms && typeof sms.enabled === "function" && sms.enabled());

  // ── SEND MODE ──────────────────────────────────────────────────────
  //  Env-driven, SAFE code default: absent/unset/unknown ⇒ "disabled".
  //  Read fresh per send so flipping the env is an immediate kill switch.
  //
  //    disabled               → refuse ALL sends. Phase A default.
  //    proof_only             → ONLY purpose='proof_text' to the single
  //                             designated proof cell (SMS_PROOF_CELL).
  //                             Credential sends (otp/staff_otp/
  //                             staff_invite) refuse UNLESS the named
  //                             flag SMS_ALLOW_CREDENTIAL_SENDS=1 is set.
  //                             proof_only never silently means
  //                             "proof plus whatever calls SMS".
  //    customer_care          → the one autonomous mode. Requires a person
  //                             record, a relationship at THIS property,
  //                             and consent_state='opted_in'. No row =
  //                             refuse. Unknown consent = refuse.
  //                             Credential sends allowed (opted_out always
  //                             blocks, everywhere, first).
  //
  //  RETIRED 2026-07-26 — internal_qa_autonomous. It sent only to
  //  internal_qa records while customer_care sent only to production ones:
  //  two gates on one field pointing opposite ways, so a person could be
  //  textable or leasable and never both. Class left eligibility entirely,
  //  which left that mode as customer_care plus an extra refusal.
  //  An unrecognised value resolves to 'disabled', so the retired string
  //  fails closed rather than behaving like a live mode. If a deploy goes
  //  silent, check SMS_SEND_MODE for it first.
  const VALID_MODES = ["disabled", "proof_only", "customer_care"];
  function sendMode() {
    const m = (process.env.SMS_SEND_MODE || "disabled").trim();
    return VALID_MODES.includes(m) ? m : "disabled";
  }
  const proofCell = () => (process.env.SMS_PROOF_CELL || "").trim() || null;
  const qaPropertyId = () => (process.env.SMS_QA_PROPERTY_ID || "").trim() || null;
  const credentialSendsAllowed = () => process.env.SMS_ALLOW_CREDENTIAL_SENDS === "1";

  // Purposes that are credential transport (user-requested codes/links),
  // not autonomous outreach. Explicitly named — no informal exceptions.
  const CREDENTIAL_PURPOSES = new Set(["otp", "staff_otp", "staff_invite"]);
  // Purposes that are autonomous/agent outreach.
  const AUTONOMOUS_PURPOSES = new Set([
    "agent", "ai_reply", "leasing_first_response", "followup", "customer_care",
    // application_link: sending a prospect their application is legitimate
    // autonomous leasing outreach — same class as first-response/followup. In
    // QA mode it still requires a QA-classified, opted-in recipient in scope.
    "application_link",
  ]);

  // ── PROPERTY LINE (server-derived `from`) ──────────────────────────
  //  The ONLY place a property's SMS line is resolved for sending.
  //  Internal detail of the boundary; business modules never call it.
  async function propertyLine(q, propertyId) {
    const r = await q.query(`select sms_number from properties where id = $1`, [propertyId]);
    return r.rows.length ? r.rows[0].sms_number : null;
  }

  // ── PROPERTY OPERATING AUTHORITY (094) ─────────────────────────────
  //  propertyHasCapability — the ONE reader of property_channel_capabilities.
  //
  //  Fable ruling 2026-07-25: AGENT_AUTO_DISPATCH_PROPERTY_IDS is an
  //  acceptable deployment kill switch but is NOT operating authority.
  //  Authority is a durable, attributed record. This is how it is read.
  //
  //  FAIL-CLOSED, and every branch of that matters:
  //    no row              → false   (never activated)
  //    status suspended    → false   (paused, deliberately)
  //    status revoked      → false   (ended, deliberately)
  //    table absent        → false   (pre-094 database, or rollback)
  //    query error         → false   (an unreadable authority is no authority)
  //  Absence is refusal. There is no code path here that returns true
  //  without an `active` row naming this exact property, channel and
  //  capability.
  //
  //  THE FIVE CAPABILITIES ARE NOT INTERCHANGEABLE. Holding
  //  send_customer_care_human grants nothing about send_ai_autodispatch or
  //  send_marketing. Callers must ask for the precise thing they intend to
  //  do; this function will never widen a grant on their behalf.
  //
  //  NOT YET IN THE GATE — see migration 094's DELIBERATE OMISSION note.
  //  Wiring it into canSendSmsForRecord today would refuse every send at
  //  the one property that currently works, because no property holds a
  //  row yet. The AND-clause goes in when a real property is activated by
  //  a named human. Exported and harness-tested so it cannot rot.
  const CAPABILITIES = Object.freeze([
    "receive_inbound",
    "send_customer_care_human",
    "send_ai_assisted_approved",
    "send_ai_autodispatch",
    "send_marketing",
  ]);

  async function propertyHasCapability(q, { property_id, capability, channel = "sms" }) {
    if (!property_id || !capability) return false;
    // an unknown capability name is a caller bug; refuse rather than guess
    if (!CAPABILITIES.includes(capability)) {
      console.error(`propertyHasCapability: unknown capability '${capability}' — refusing.`);
      return false;
    }
    try {
      const r = await q.query(
        `select 1 from property_channel_capabilities
          where property_id = $1::uuid and channel = $2 and capability = $3
            and status = 'active'
          limit 1`,
        [property_id, channel, capability]
      );
      return r.rows.length > 0;
    } catch (e) {
      // undefined_table (42P01) on a pre-094 database, or anything else:
      // an authority we cannot read is an authority we do not have.
      console.error(`propertyHasCapability: refusing (${e.code || "err"}: ${e.message})`);
      return false;
    }
  }

  // ── PERSON × PROPERTY CONTEXT RESOLVER ─────────────────────────────
  //  resolvePersonPropertyContext — ONE read/projection over the REAL
  //  distributed relationship sources plus the classification fact.
  //  It does not invent relationships: a classification row alone does
  //  not create a lease, lead, invite, or conversation.
  //
  //  Live relationship semantics (verified against current source):
  //    leases        → person is a tenant via tenant_ids ARRAY
  //                    (per.id = any(l.tenant_ids)), property_id scoped
  //    leasing_leads → (person_id, property_id) opportunity rows
  //    tenant_invites→ (person_id, property_id)
  //    conversations → (person_id, property_id)
  //
  //  Returns:
  //    {
  //      relationship_exists: bool,
  //      relationship_sources: { lease, lead, invite, conversation },
  //      classification: { record_class, classified_at,
  //                        classification_source } | null,   // null = UNCLASSIFIED
  //      is_qa: bool,
  //    }
  async function resolvePersonPropertyContext(person_id, property_id, clientArg = null) {
    const q = clientArg || pool;
    const src = (await q.query(
      `select
         exists (select 1 from leases l
                  where l.property_id = $2 and $1 = any(l.tenant_ids)) as lease,
         exists (select 1 from leasing_leads ll
                  where ll.person_id = $1 and ll.property_id = $2)     as lead,
         exists (select 1 from tenant_invites ti
                  where ti.person_id = $1 and ti.property_id = $2)     as invite,
         exists (select 1 from conversations c
                  where c.person_id = $1 and c.property_id = $2)       as conversation`,
      [person_id, property_id]
    )).rows[0];

    // FAIL-CLOSED READ: if the classification table is unavailable (e.g.
    // new code deployed before migration 076 lands, or a rolling
    // instance), the read failure becomes an explicit refusal signal —
    // never a crash, never a bypass of the classification gate.
    let cls = null, clsError = false;
    try {
      cls = (await q.query(
        `select record_class, classified_at, classification_source
           from person_property_classifications
          where person_id = $1 and property_id = $2 and superseded_at is null
          limit 1`,
        [person_id, property_id]
      )).rows[0] || null;
    } catch (e) {
      clsError = true;
      console.error(`resolvePersonPropertyContext: classification read FAILED (${e.code || e.message}) — treating as classification_unavailable (fail closed).`);
    }

    return {
      relationship_exists: !!(src.lease || src.lead || src.invite || src.conversation),
      relationship_sources: {
        lease: !!src.lease, lead: !!src.lead,
        invite: !!src.invite, conversation: !!src.conversation,
      },
      classification: cls,
      classification_unavailable: clsError,
      is_qa: !!(cls && cls.record_class === "internal_qa"),
    };
  }

  // ── QA ENROLLMENT — one governed operation, two canonical facts ────
  //  enrollInternalQa writes, in ONE transaction:
  //    1. a current internal_qa classification row (superseding any
  //       existing current row for the pair, append-only), and
  //    2. contact_preferences.consent_state = 'opted_in' for text,
  //  each with attribution. The facts remain distinct rows in their own
  //  canonical tables; the OPERATION is governed and atomic.
  //
  //  Testers enter through the canonical relationship/intake path first —
  //  enrollment classifies an existing person, it does not create one.
  async function enrollInternalQa({ person_id, property_id, actor_user_id, reason = null }, clientArg = null) {
    if (!person_id || !property_id) throw new Error("enrollInternalQa: person_id and property_id are required.");
    const ownClient = !clientArg;
    const client = clientArg || await pool.connect();
    try {
      if (ownClient) await client.query("begin");

      // The person must already have a REAL relationship in this property
      // (canonical intake first). Classification never invents one.
      const ctx = await resolvePersonPropertyContext(person_id, property_id, client);
      if (!ctx.relationship_exists) {
        throw new Error("enrollInternalQa: no Person × Property relationship exists — intake the tester through the canonical path first.");
      }

      // Supersede any current classification for the pair (append-only).
      await client.query(
        `update person_property_classifications
            set superseded_at = now(), superseded_by_user_id = $3
          where person_id = $1 and property_id = $2 and superseded_at is null`,
        [person_id, property_id, actor_user_id || null]
      );
      const row = (await client.query(
        `insert into person_property_classifications
           (person_id, property_id, record_class, classified_by_user_id,
            classification_source, classification_reason)
         values ($1, $2, 'internal_qa', $3, 'operator', $4)
         returning *`,
        [person_id, property_id, actor_user_id || null, reason]
      )).rows[0];

      // Consent: the separate canonical fact, written explicitly.
      await client.query(
        `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
         values ($1, 'text', 'opted_in', 'internal_qa_enrollment', now())
         on conflict (person_id, channel)
         do update set consent_state = 'opted_in', source = 'internal_qa_enrollment', updated_at = now()`,
        [person_id]
      );

      if (ownClient) await client.query("commit");
      return {
        receipt: `Enrolled as internal_qa for property ${property_id}: classification row ${row.id}, text consent opted_in.`,
        classification: row,
      };
    } catch (e) {
      if (ownClient) { try { await client.query("rollback"); } catch (_) {} }
      throw e;
    } finally {
      if (ownClient) client.release();
    }
  }

  // Revoke / reclassify (append-only): supersede current, insert new.
  async function reclassify({ person_id, property_id, record_class, actor_user_id, reason = null }, clientArg = null) {
    if (!["production", "internal_qa"].includes(record_class)) throw new Error("reclassify: record_class must be production or internal_qa.");
    const ownClient = !clientArg;
    const client = clientArg || await pool.connect();
    try {
      if (ownClient) await client.query("begin");
      await client.query(
        `update person_property_classifications
            set superseded_at = now(), superseded_by_user_id = $3
          where person_id = $1 and property_id = $2 and superseded_at is null`,
        [person_id, property_id, actor_user_id || null]
      );
      const row = (await client.query(
        `insert into person_property_classifications
           (person_id, property_id, record_class, classified_by_user_id,
            classification_source, classification_reason)
         values ($1, $2, $3, $4, 'operator', $5)
         returning *`,
        [person_id, property_id, record_class, actor_user_id || null, reason]
      )).rows[0];
      if (ownClient) await client.query("commit");
      return { classification: row };
    } catch (e) {
      if (ownClient) { try { await client.query("rollback"); } catch (_) {} }
      throw e;
    } finally {
      if (ownClient) client.release();
    }
  }

  // ── CENTRAL OUTBOUND ELIGIBILITY ───────────────────────────────────
  //  canSendSmsForRecord — the ONE decision point. Consent, record
  //  classification, property/recipient scope, purpose, and send mode.
  //  Returns exactly one decision and one refusal reason:
  //    { allowed: true, reason: "ok" | <aperture> }
  //    { allowed: false, reason }
  //
  //  Eligibility law (ruling, revised 2026-07-26):
  //    · opted_out ALWAYS blocks, every mode, every purpose, first.
  //    · customer_care agent sends require a person record, a relationship
  //      at THIS property, and consent 'opted_in'. No row = refuse.
  //      Unknown consent = refuse.
  //    · record_class gates NOTHING here. It gated sending in one direction
  //      and admission in the other, which is the deadlock this replaced.
  //      Class now marks replay and metrics only.
  //    · proof_only permits only the exact proof aperture (+ credential
  //      sends only behind the named SMS_ALLOW_CREDENTIAL_SENDS flag).
  //    · unclassified never silently means production.
  async function canSendSmsForRecord({
    property_id, recipient, person_id = null, purpose, from,
  }, clientArg = null) {
    const q = clientArg || pool;
    const mode = sendMode();

    // 0. Structural preconditions.
    if (!smsReady()) return { allowed: false, reason: "transport_not_configured" };
    if (!property_id) return { allowed: false, reason: "no_property" };
    if (!from) return { allowed: false, reason: "no_property_line" };
    if (!recipient) return { allowed: false, reason: "no_recipient" };
    if (!purpose) return { allowed: false, reason: "no_purpose" };

    // 1. Consent — read once; opted_out blocks EVERYTHING, every mode.
    let consent = "unknown";
    if (person_id) {
      const pref = (await q.query(
        `select consent_state from contact_preferences where person_id = $1 and channel = 'text'`,
        [person_id]
      )).rows[0];
      consent = pref ? String(pref.consent_state).toLowerCase() : "unknown";
      if (["opted_out", "stop", "revoked"].includes(consent)) {
        return { allowed: false, reason: "consent_opted_out" };
      }
    }

    // 2. Mode gates.
    if (mode === "disabled") {
      return { allowed: false, reason: "send_mode_disabled" };
    }

    if (mode === "proof_only") {
      if (purpose === "proof_text") {
        const cell = proofCell();
        if (!cell) return { allowed: false, reason: "proof_cell_not_configured" };
        if (recipient !== cell) return { allowed: false, reason: "proof_only_recipient_not_proof_cell" };
        return { allowed: true, reason: "proof_aperture" };
      }
      if (CREDENTIAL_PURPOSES.has(purpose)) {
        if (!credentialSendsAllowed()) return { allowed: false, reason: "credential_sends_disabled_in_proof_only" };
        return { allowed: true, reason: "credential_aperture" };
      }
      return { allowed: false, reason: "send_mode_proof_only_blocks_this_purpose" };
    }

    // `internal_qa_autonomous` is RETIRED (owner ruling 2026-07-26).
    //
    //  Its entire reason to exist was the class check: it sent to
    //  internal_qa records and refused everyone else, while customer_care
    //  did the mirror image. That was the deadlock — one person could be
    //  textable or leasable, never both, depending on a setting nobody
    //  could see from the board. It cost a full afternoon: a real prospect
    //  arrived through the website, was correctly classified production,
    //  and the AI went silent on him twice because the mode was still QA.
    //
    //  With class out of eligibility there is nothing left for it to do —
    //  it would be customer_care with an extra refusal. So it is gone
    //  rather than kept as a synonym, and the value now falls through
    //  VALID_MODES to `disabled`, which fails closed and loudly.
    //
    //  ⚠ OPERATIONAL: if SMS_SEND_MODE is still set to this string
    //  anywhere, that deploy now sends NOTHING. That is deliberate — a
    //  retired mode must not silently behave like a live one — but it is
    //  the failure someone will hit first, so check the env when a deploy
    //  goes quiet.

    if (mode === "customer_care") {
      if (CREDENTIAL_PURPOSES.has(purpose)) {
        // Credential sends allowed; opted_out already blocked above.
        if (person_id) {
          const ctx = await resolvePersonPropertyContext(person_id, property_id, q);
          if (!ctx.relationship_exists) return { allowed: false, reason: "recipient_not_in_property_scope" };
        }
        return { allowed: true, reason: "credential" };
      }
      // CLASS NO LONGER GATES SENDING (owner ruling 2026-07-26).
      //
      //  This used to require a current 'production' classification, while
      //  internal_qa_autonomous required 'internal_qa' for the same person.
      //  Two gates, opposite directions, one field — the deadlock.
      //
      //  What remains is what actually protects someone: they must exist as
      //  a record, they must belong to THIS property, and they must have
      //  said yes. Absence of consent is refusal, unchanged. A STOP still
      //  short-circuits above this block before any of it runs.
      //
      //  This is a real widening and worth naming: anyone opted in at a
      //  property the product operates can now receive autonomous outreach,
      //  where before a classification stood between them and it. That
      //  classification was never a consent signal though — it was a
      //  deployment marker doing a safety job it was never designed for.
      //  Consent is the signal, and it is the one the person actually gave.
      if (!person_id) return { allowed: false, reason: "customer_care_requires_person_record" };
      const ctx = await resolvePersonPropertyContext(person_id, property_id, q);
      if (!ctx.relationship_exists) return { allowed: false, reason: "recipient_not_in_property_scope" };
      if (consent !== "opted_in") return { allowed: false, reason: "customer_care_requires_opted_in_consent" };
      return { allowed: true, reason: "customer_care" };
    }

    return { allowed: false, reason: "send_mode_unknown" };
  }

  // ── CANONICAL OUTBOUND GATE ────────────────────────────────────────
  //  sendPropertySms — the ONE place a property-facing text goes out.
  //  Derives the line server-side → runs canSendSmsForRecord → records
  //  the attempt/refusal → raw transport → records the provider result.
  //  Save-first is preserved: the CALLER owns the comm_event (the message
  //  is real whether or not the wire cooperates); pass eventId and the
  //  gate stamps the wire's answer onto it.
  //
  //  Returns: { sent, reason, sid }
  async function sendPropertySms({
    property_id, recipient, body, purpose = "agent",
    person_id = null, eventId = null, actor_user_id = null,
  }, clientArg = null) {
    const q = clientArg || pool;

    async function stamp(status, detail) {
      if (!eventId) return;
      try {
        await q.query(
          `update comm_events set sms_status = $1, sms_error = $2 where id = $3`,
          [status, detail || null, eventId]
        );
      } catch (e) { console.error("sendPropertySms stamp:", e.message); }
    }

    // Server-derived property line. No line → NO SEND, never a
    // Messaging Service default fallback.
    const from = await propertyLine(q, property_id);
    if (!from) {
      await stamp("refused", "gate:no_property_line");
      console.error(`sendPropertySms REFUSED property=${property_id} purpose=${purpose} reason=no_property_line`);
      return { sent: false, reason: "no_property_line", sid: null };
    }

    const elig = await canSendSmsForRecord(
      { property_id, recipient, person_id, purpose, from }, q
    );
    if (!elig.allowed) {
      await stamp("refused", `gate:${elig.reason}`);
      console.error(`sendPropertySms REFUSED property=${property_id} purpose=${purpose} reason=${elig.reason}`);
      return { sent: false, reason: elig.reason, sid: null };
    }

    // Raw transport — the boundary is the ONLY business-side caller.
    const result = await sms.sendSms({ to: recipient, from, body });

    if (result.sent) {
      await stamp(result.status || "queued", null);
      if (eventId) {
        try { await q.query(`update comm_events set sms_sid = $1 where id = $2`, [result.sid, eventId]); }
        catch (e) { console.error("sendPropertySms sid record:", e.message); }
      }
    } else {
      await stamp("failed", result.reason + (result.error ? `: ${result.error}` : ""));
    }

    return { sent: !!result.sent, reason: result.sent ? "sent" : result.reason, sid: result.sid || null };
  }

  // ── CANONICAL INBOUND RESOLVER ─────────────────────────────────────
  //  resolveInboundSmsContext — To-number-FIRST domain resolution.
  //  The ROUTE owns transport authentication (Twilio signature + payload
  //  shape) and calls this only with a verified request (T1).
  //
  //  Live conventions preserved (verified against current source):
  //    · idempotency key is comm_events.sms_sid (unique-indexed)
  //    · sender = verified resident: active lease via tenant_ids array
  //      JOIN tenant_invites status='used', phone match, THIS property
  //    · channel 'sms' on this path
  //
  //  Event-writing contract (no double-write): the resolver records the
  //  inbound comm_event for the UNRESOLVED cases (ambiguous/unmatched
  //  sender — person-less, property-scoped, needs_human). For the
  //  RESOLVED case it returns context and writes nothing — the canonical
  //  inbound core (runInbound) records the event exactly once, same as
  //  the browser door. One spine, two doors, one write per message.
  //
  //  Outcomes:
  //    unknown To line  → { unknownLine:true }, ZERO rows written (T2),
  //                       server log only
  //    duplicate sid    → { idempotentReplay:true }, existing event id,
  //                       zero new rows
  //    resolved sender  → { property, person }, no event written here
  //    0 or >1 senders  → { ambiguous:true, comm_event }, person-less
  //                       property-scoped record; NO outbound (Phase A)
  // ── CONSENT KEYWORDS (Twilio-standard) ─────────────────────────────
  //  A STOP is a consent signal, not a conversation. When a RESOLVED
  //  sender texts one, the boundary: records the inbound event
  //  (classification 'consent_signal'), updates the ONE canonical
  //  consent truth (contact_preferences.consent_state), and tells the
  //  route to dispatch NOTHING — no AI reply, no confirmation text
  //  (replying to a STOP is itself a carrier violation; Twilio's own
  //  compliance reply covers it). START/UNSTOP/YES re-opts in.
  const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
  const START_KEYWORDS = new Set(["start", "unstop", "yes"]);
  function consentKeyword(body) {
    const w = String(body || "").trim().toLowerCase();
    if (STOP_KEYWORDS.has(w)) return "opted_out";
    if (START_KEYWORDS.has(w)) return "opted_in";
    return null;
  }
  async function applyConsent(q, { person_id, consent_state, source }) {
    await q.query(
      `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
       values ($1, 'text', $2, $3, now())
       on conflict (person_id, channel)
       do update set consent_state = $2, source = $3, updated_at = now()`,
      [person_id, consent_state, source]
    );
  }

  // Phone → E.164: the SHARED canonical normalizer from phone_identity.js —
  // the same function the duplicate-person identity fix standardized on. The
  // previous local copy here was a byte-identical duplicate (verified before
  // removal); importing the shared one removes the parallel implementation the
  // comms-boundary spec forbids. Returns null when the input can't be
  // normalized (null never matches a stored phone, so a bad input simply fails
  // the tier — never a false match). Twilio's own `From` is already E.164.
  const { normalizeE164 } = require("../identity/phone_identity");

  async function resolveInboundSmsContext({ To, From, MessageSid, body = null }, clientArg = null) {
    const q = clientArg || pool;

    if (!MessageSid || !From || !To) {
      // Malformed at the domain layer (route should have rejected).
      // Write nothing.
      return { property: null, person: null, ambiguous: false, unknownLine: false, comm_event: null, idempotentReplay: false, malformed: true };
    }

    // Idempotency FIRST — a Twilio retry must never create a second event.
    const dup = (await q.query(
      `select id, property_id, person_id from comm_events where sms_sid = $1 limit 1`,
      [MessageSid]
    )).rows[0];
    if (dup) {
      return {
        property: dup.property_id ? { id: dup.property_id } : null,
        person: dup.person_id ? { id: dup.person_id } : null,
        ambiguous: false, unknownLine: false,
        comm_event: dup, idempotentReplay: true,
      };
    }

    // TO → PROPERTY. The receiving line is the property wall; resolve it
    // before touching the sender.
    const prop = (await q.query(
      `select id, name, address, sms_number from properties where sms_number = $1 limit 1`,
      [To]
    )).rows[0];

    if (!prop) {
      // No property owns this line → no property ledger exists. Write
      // NOTHING to operating history (T2). Loud server log; Twilio's own
      // logs retain the raw message.
      console.error(`communications_boundary: UNKNOWN LINE ${To} — message ${MessageSid} from ${From} NOT attached; zero rows written.`);
      return { property: null, person: null, ambiguous: false, unknownLine: true, comm_event: null, idempotentReplay: false };
    }

    // SENDER resolution inside this property. Phone is RELATIONSHIP EVIDENCE,
    // not identity — we resolve only when there is exactly ONE eligible durable
    // PERSON, and we route by that person's strongest relationship:
    //   · exactly one resident, and no DIFFERENT person is an open lead → resident
    //   · exactly one open lead, and no resident                        → lead
    //   · a resident AND a lead that are the SAME durable person        → resident
    //   · a resident AND a lead that are DIFFERENT people (same phone)   → needs_human
    //   · zero eligible, or >1 distinct eligible person, at either tier  → needs_human
    // Never a silent pick between two different humans, never a merge.
    //
    // TIER 1 — active resident. Matches the CANONICAL identity field
    // (primary_phone_e164 — the durable leasing phone identity), the legacy
    // raw `phone` exactly, or a bounded last-ten-digits fallback for legacy
    // formatted rows like "(724) 309-8434". The fallback compares digits only
    // and requires a full 10-digit tail, so it cannot false-match short or
    // malformed values. Ambiguity discipline below is unchanged: >1 distinct
    // person still refuses.
    const fromNorm = normalizeE164(From);
    const fromTail = String(From).replace(/\D/g, "").slice(-10);
    const residents = (await q.query(
      `select distinct per.id, per.name, per.phone
         from persons per
         join leases l on l.lease_status = 'active' and l.property_id = $1
                      and per.id = any(l.tenant_ids)
         join tenant_invites ti on ti.person_id = per.id and ti.property_id = $1
                      and ti.status = 'used'
        where per.primary_phone_e164 = $2
           or per.phone = $3
           or (length($4) = 10 and right(regexp_replace(coalesce(per.phone,''), '\\D', '', 'g'), 10) = $4)`,
      [prop.id, fromNorm || From, From, fromTail]
    )).rows;

    // TIER 2 — open leasing lead. Matched by NORMALIZED phone (E.164) so a lead
    // stored with different formatting still matches; scoped to THIS property.
    // "Open" = a leasing_leads opportunity that is not terminally closed.
    // Terminal = 'leased' | 'lost' — the SAME predicate the DB's own
    // one-open-per-person-property partial unique index uses (verified against
    // live schema: leasing_leads_status_check allows new / ai_responded /
    // tour_requested / tour_scheduled / human_takeover / applied / leased /
    // lost). We ALWAYS run this lookup (even when a resident matched) so a
    // resident-vs-different-person-lead CONFLICT is detected rather than hidden
    // by resident precedence. A person may hold leads across properties; here
    // we count only this-property, non-terminal leads for this phone.
    const leads = (await q.query(
      `select distinct per.id, per.name, per.phone
         from persons per
         join leasing_leads ll on ll.person_id = per.id and ll.property_id = $1
        where ll.status not in ('leased','lost')
          and (per.primary_phone_e164 = $2
               or per.phone = $3
               or per.phone = $4
               or (length($5) = 10 and right(regexp_replace(coalesce(per.phone,''), '\\D', '', 'g'), 10) = $5))`,
      [prop.id, fromNorm || From, From, fromNorm, fromTail]
    )).rows;

    // Distinct durable persons across BOTH tiers, keyed by person id.
    const byId = new Map();
    for (const r of residents) byId.set(r.id, { ...r, isResident: true, isLead: false });
    for (const l of leads) {
      const ex = byId.get(l.id);
      if (ex) ex.isLead = true;
      else byId.set(l.id, { ...l, isResident: false, isLead: true });
    }
    const distinct = [...byId.values()];

    // Resolve ONLY when exactly one distinct eligible person exists. Zero, or
    // more than one distinct person (whether two residents, two leads, or a
    // resident and a DIFFERENT-person lead), is ambiguous → needs_human.
    let relationship = null; // 'resident' | 'lead'
    let senders = [];
    if (distinct.length === 1) {
      const only = distinct[0];
      // Same durable person may be both; resident is the stronger relationship.
      relationship = only.isResident ? "resident" : "lead";
      senders = [{ id: only.id, name: only.name, phone: only.phone }];
    }

    if (!relationship || senders.length !== 1) {
      // Unknown or ambiguous sender. The message never silently
      // disappears: save it on the PROPERTY, person-less, human-flagged.
      // NO outbound is dispatched (Phase A: zero sends on ambiguity; a
      // future clarification policy must route through sendPropertySms).
      const saved = (await q.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id,
                                  channel, direction, body, sms_sid, classification, needs_human)
         values ($1, null, null, null, 'sms', 'inbound', $2, $3, 'unknown', true)
         returning *`,
        [prop.id, body || "(empty message)", MessageSid]
      )).rows[0];
      const residentIds = new Set(residents.map(r => r.id));
      const leadOnlyDifferent = leads.some(l => !residentIds.has(l.id));
      const why = distinct.length === 0 ? "UNMATCHED"
                : (residents.length >= 1 && leadOnlyDifferent) ? "AMBIGUOUS_RESIDENT_VS_LEAD"
                : residents.length > 1 ? "AMBIGUOUS_RESIDENT"
                : "AMBIGUOUS_LEAD";
      console.error(`communications_boundary: ${why} sender ${From} at ${prop.name || prop.address} — saved ${saved.id}, needs_human, zero outbound.`);
      return {
        property: { id: prop.id, name: prop.name, sms_number: prop.sms_number },
        person: null, ambiguous: true, unknownLine: false,
        comm_event: saved, idempotentReplay: false,
      };
    }

    // RESOLVED (as resident or as lead). Consent keywords are intercepted
    // HERE for EITHER relationship: the boundary records the message once
    // (classification 'consent_signal'), updates contact_preferences — the
    // one canonical consent truth — and the route dispatches nothing. Twilio
    // may also block at the carrier layer; the application's own gate must
    // never reason from stale institutional truth.
    const person = senders[0];
    const consentSignal = consentKeyword(body);
    if (consentSignal) {
      const saved = (await q.query(
        `insert into comm_events (property_id, person_id, unit_id, conversation_id,
                                  channel, direction, body, sms_sid, classification, needs_human)
         values ($1, $2, null, null, 'sms', 'inbound', $3, $4, 'consent_signal', false)
         returning *`,
        [prop.id, person.id, body, MessageSid]
      )).rows[0];
      await applyConsent(q, { person_id: person.id, consent_state: consentSignal, source: "inbound_sms_keyword" });
      console.error(`communications_boundary: CONSENT SIGNAL ${consentSignal} from ${person.id} at ${prop.name || prop.address} — canonical consent updated, event ${saved.id}, zero outbound.`);
      return {
        property: { id: prop.id, name: prop.name, sms_number: prop.sms_number },
        person, ambiguous: false, unknownLine: false,
        comm_event: saved, idempotentReplay: false,
        consentSignal, relationship,
      };
    }

    // RESOLVED conversation message: return context AND the resolved
    // relationship type so the ROUTE can pick the correct brain (resident →
    // tenant inbound core; lead → leasing agent inbound). The canonical
    // inbound write is owned DOWNSTREAM (exactly once — same discipline as
    // the browser door): this resolver writes NOTHING on the resolved path,
    // for a resident OR a lead.
    return {
      property: { id: prop.id, name: prop.name, sms_number: prop.sms_number },
      person, ambiguous: false, unknownLine: false,
      comm_event: null, idempotentReplay: false, consentSignal: null,
      relationship,
    };
  }

  // ── PROVIDER STATUS (delivery callbacks) — status-only by design ───
  //  recordProviderStatus updates delivery state for an EXISTING
  //  communication and appends to comm_event_status_log. It NEVER creates
  //  a communication, never accepts a property, never accepts body text
  //  into history. Unknown (provider, provider_event_id) → logged no-op.
  async function recordProviderStatus({ provider = "twilio", provider_event_id, provider_status, raw = null }, clientArg = null) {
    const q = clientArg || pool;
    if (!provider_event_id) return { updated: false, reason: "no_provider_event_id" };

    const existing = (await q.query(
      `select id from comm_events
        where (provider = $1 and provider_event_id = $2) or sms_sid = $2
        limit 1`,
      [provider, provider_event_id]
    )).rows[0];

    if (!existing) {
      console.error(`recordProviderStatus: unknown ${provider} event ${provider_event_id} — status ignored, zero rows.`);
      return { updated: false, reason: "unknown_provider_event" };
    }

    if (provider_status) {
      await q.query(
        `update comm_events set provider_status = $1, provider_status_updated_at = now() where id = $2`,
        [provider_status, existing.id]
      );
    }
    await q.query(
      `insert into comm_event_status_log (comm_event_id, provider, provider_event_id, provider_status, raw)
       values ($1, $2, $3, $4, $5)`,
      [existing.id, provider, provider_event_id, provider_status || null, raw ? JSON.stringify(raw) : null]
    );
    return { updated: true, comm_event_id: existing.id };
  }

  return {
    // the three core primitives
    resolveInboundSmsContext,
    canSendSmsForRecord,
    sendPropertySms,
    // the relationship/classification read
    resolvePersonPropertyContext,
    // property operating authority (094). The ONE reader of
    // property_channel_capabilities. Fail-closed: no active row → false.
    // Not yet an AND-clause in canSendSmsForRecord — see 094's header.
    propertyHasCapability,
    CAPABILITIES,
    // governed classification operations
    enrollInternalQa,
    reclassify,
    // status-only provider callback landing
    recordProviderStatus,
    // introspection (harness/ops only)
    _sendMode: sendMode,
    _validModes: VALID_MODES,
  };
};
