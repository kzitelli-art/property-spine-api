// ════════════════════════════════════════════════════════════════════
//  CONSENT AND SCOPE — the two claims we had never actually run.
//
//  The Phase A harness says so in its own header: the resolved-sender path
//  and STOP/START interception are "NOT COVERED HEADLESSLY", because they
//  need an active lease + a used invite + a space chain. So the two most
//  expensive things this system can get wrong were the two things nothing
//  had exercised:
//
//    A.  a person who texts STOP is never texted again — every send mode,
//        every purpose, including credential sends
//    B.  a person at one property cannot be reached through another
//        property's line, in either direction
//
//  Getting A wrong is a TCPA violation per message. Getting B wrong is
//  someone else's resident receiving your property's mail. Neither shows
//  up as an error — both look like a successful send.
//
//  This builds the full chain (property, unit, space, active lease, used
//  invite) so the REAL resolver runs against a REAL sender, and asserts
//  the refusals rather than the happy path.
//
//  SAFETY: every write happens inside ONE transaction that ALWAYS ROLLS
//  BACK, and every call is handed that transaction's client. No real
//  person's consent is read, written, or touched. The transport is a fake
//  that records instead of sending, so a bug here cannot put a message on
//  a wire. Nothing is deleted by property_id; nothing is deleted at all.
//
//  RUN:  DATABASE_URL=... node tests/consent_and_scope_proof.js
// ════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { Pool } = require("pg");
const communicationsBoundary = require("../src/comms/communications_boundary.js");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /sslmode=require|neon\.tech/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    })
  : new Pool();

// A transport that is "enabled" so the gate reaches its real decisions,
// but records instead of sending. If any assertion below is wrong, the
// message lands in this array — not on a phone.
const wire = [];
const fakeSms = {
  enabled: () => true,
  sendSms: async ({ to, from, body }) => { wire.push({ to, from, body }); return { sent: true, sid: "SM_fake", status: "queued" }; },
  validateWebhook: () => true,
};
const cb = communicationsBoundary({ pool, sms: fakeSms });

let pass = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fails.push(name + (detail ? `  [${detail}]` : "")); console.log(`  FAIL  ${name}${detail ? `  [${detail}]` : ""}`); }
}
const mode = (m) => { process.env.SMS_SEND_MODE = m; };
const uuid = () => crypto.randomUUID();

// The purposes the gate treats differently. Credential purposes are the
// interesting ones: they are the sends allowed to bypass classification,
// so they are where an opt-out is most likely to leak through.
const CREDENTIAL = "otp";
const AUTONOMOUS = "ai_reply";

(async () => {
  const c = await pool.connect();
  let rolledBack = false;
  try {
    await c.query("begin");
    const Q = (sql, params) => c.query(sql, params).then(r => r.rows);

    // ── the chain, twice: two properties that must stay separate ───────
    async function property(label, line) {
      const id = uuid();
      await Q(`insert into properties (id, name, sms_number) values ($1,$2,$3)`, [id, `CONSENT_PROOF ${label}`, line]);
      const u = uuid();
      await Q(`insert into units (id, property_id, unit_number, bedrooms, bathrooms, market_rent, occupancy_status)
               values ($1,$2,'CP-1',1,1,1500,'occupied')`, [u, id]);
      const s = uuid();
      await Q(`insert into spaces (id, unit_id, space_label) values ($1,$2,'(whole unit)')`, [s, u]);
      return { id, spaceId: s, line };
    }
    async function resident(prop, phone, name) {
      const p = uuid();
      await Q(`insert into persons (id, name, phone, primary_phone_e164) values ($1,$2,$3,$3)`, [p, name, phone]);
      await Q(`insert into leases (id, property_id, space_id, tenant_ids, lease_status)
               values ($1,$2,$3,ARRAY[$4]::uuid[],'active')`, [uuid(), prop.id, prop.spaceId, p]);
      await Q(`insert into tenant_invites (id, person_id, property_id, token, status, expires_at)
               values ($1,$2,$3,$4,'used', now() + interval '30 days')`,
        [uuid(), p, prop.id, "cp_" + crypto.randomBytes(8).toString("hex")]);
      await Q(`insert into conversations (property_id, person_id) values ($1,$2)
               on conflict (property_id, person_id) do nothing`, [prop.id, p]);
      await Q(`insert into person_property_classifications (person_id, property_id, record_class, classification_source)
               values ($1,$2,'internal_qa','operator')`, [p, prop.id]);
      await Q(`insert into contact_preferences (person_id, channel, consent_state, source)
               values ($1,'text','opted_in','consent_proof')
               on conflict (person_id, channel) do update set consent_state='opted_in'`, [p]);
      return p;
    }

    const A = await property("A", "+15005557001");
    const B = await property("B", "+15005557002");
    process.env.SMS_QA_PROPERTY_ID = A.id;

    const sarah = await resident(A, "+15005558001", "CONSENT_PROOF Sarah");
    const marcus = await resident(B, "+15005558002", "CONSENT_PROOF Marcus");

    const can = (o) => cb.canSendSmsForRecord(o, c);
    const consentOf = async (p) =>
      (await Q(`select consent_state from contact_preferences where person_id=$1 and channel='text'`, [p]))[0]?.consent_state;

    // ════════════════════════════════════════════════════════════════
    console.log("\n[A] STOP — the claim that a person who opts out is never texted again\n");

    mode("customer_care");
    let r = await can({ property_id: A.id, recipient: "+15005558001", person_id: sarah, purpose: AUTONOMOUS, from: A.line });
    check("BEFORE the STOP, this send is allowed", r.allowed === true, r.reason);

    // The real resolver, on the real chain. This is the line the Phase A
    // harness could not reach.
    const stop = await cb.resolveInboundSmsContext(
      { To: A.line, From: "+15005558001", MessageSid: "CP_stop_1", body: "STOP" }, c);

    check("the sender is RESOLVED, not dumped as unknown",
      stop.person && stop.person.id === sarah && !stop.ambiguous && !stop.unknownLine,
      stop.ambiguous ? "ambiguous" : stop.unknownLine ? "unknown line" : "no person");
    check("it is read as a consent signal, not a conversation",
      stop.consentSignal === "opted_out", String(stop.consentSignal));
    check("the message is kept, classified 'consent_signal'",
      stop.comm_event && stop.comm_event.classification === "consent_signal",
      stop.comm_event && stop.comm_event.classification);
    check("it is NOT flagged for a human — a STOP needs no triage",
      stop.comm_event && stop.comm_event.needs_human === false);
    check("nothing was put on the wire in reply", wire.length === 0, `${wire.length} sent`);
    check("the canonical consent truth is now opted_out",
      (await consentOf(sarah)) === "opted_out", await consentOf(sarah));

    // ── THE POINT. Every mode, every purpose. ──────────────────────────
    console.log("\n  ...and now every door is shut:\n");
    for (const m of ["disabled", "proof_only", "customer_care"]) {
      mode(m);
      process.env.SMS_PROOF_CELL = "+15005558001";     // she IS the proof cell — still no
      process.env.SMS_ALLOW_CREDENTIAL_SENDS = "1";    // the flag is ON — still no
      for (const purpose of [AUTONOMOUS, CREDENTIAL, "proof_text", "staff_invite"]) {
        const d = await can({ property_id: A.id, recipient: "+15005558001", person_id: sarah, purpose, from: A.line });
        check(`${m} / ${purpose} refuses`, d.allowed === false, d.reason);
        check(`${m} / ${purpose} says WHY it refused`,
          d.allowed === false && d.reason === "consent_opted_out", d.reason);
      }
    }
    delete process.env.SMS_PROOF_CELL;
    delete process.env.SMS_ALLOW_CREDENTIAL_SENDS;

    // ── the keyword set, and its honest edges ──────────────────────────
    console.log("\n  the keyword set, including what it deliberately does NOT catch:\n");
    let n = 0;
    for (const word of ["stop", "STOP", "  StopAll  ", "unsubscribe", "CANCEL", "end", "quit"]) {
      await Q(`update contact_preferences set consent_state='opted_in' where person_id=$1 and channel='text'`, [sarah]);
      const res = await cb.resolveInboundSmsContext(
        { To: A.line, From: "+15005558001", MessageSid: "CP_kw_" + (n++), body: word }, c);
      check(`"${word.trim()}" opts out`, res.consentSignal === "opted_out", String(res.consentSignal));
    }

    // A phrase is not a keyword. This is the carrier standard and it is
    // the right call — "stop by the office" must not silence a resident —
    // but it means a plain-English request to stop is NOT caught here. It
    // lands as an ordinary message a human has to read. Asserting it makes
    // the limit visible instead of leaving it as an assumption.
    for (const phrase of ["stop by the office tomorrow", "please stop texting me"]) {
      await Q(`update contact_preferences set consent_state='opted_in' where person_id=$1 and channel='text'`, [sarah]);
      const res = await cb.resolveInboundSmsContext(
        { To: A.line, From: "+15005558001", MessageSid: "CP_ph_" + (n++), body: phrase }, c);
      check(`"${phrase}" is NOT a keyword — it stays a message for a human`,
        res.consentSignal == null && (await consentOf(sarah)) === "opted_in", String(res.consentSignal));
    }

    // START puts it back, or an opt-out would be permanent by accident.
    const start = await cb.resolveInboundSmsContext(
      { To: A.line, From: "+15005558001", MessageSid: "CP_start_1", body: "START" }, c);
    check("START re-opts in", start.consentSignal === "opted_in" && (await consentOf(sarah)) === "opted_in",
      await consentOf(sarah));

    // A retried webhook must not re-open a closed door.
    await Q(`update contact_preferences set consent_state='opted_out' where person_id=$1 and channel='text'`, [sarah]);
    const replay = await cb.resolveInboundSmsContext(
      { To: A.line, From: "+15005558001", MessageSid: "CP_start_1", body: "START" }, c);
    check("a REPLAYED webhook is idempotent and does not re-open consent",
      replay.idempotentReplay === true && (await consentOf(sarah)) === "opted_out",
      `${replay.idempotentReplay} / ${await consentOf(sarah)}`);

    // ════════════════════════════════════════════════════════════════
    console.log("\n[B] SCOPE — the claim that a property's line reaches only its own people\n");

    await Q(`update contact_preferences set consent_state='opted_in' where person_id=$1 and channel='text'`, [sarah]);

    mode("customer_care");
    r = await can({ property_id: A.id, recipient: "+15005558001", person_id: sarah, purpose: AUTONOMOUS, from: A.line });
    check("Sarah is reachable at her OWN property", r.allowed === true, r.reason);

    // The same person, the same phone, through the wrong property.
    for (const m of ["customer_care"]) {
      mode(m);
      const d = await can({ property_id: B.id, recipient: "+15005558001", person_id: sarah, purpose: AUTONOMOUS, from: B.line });
      check(`${m}: Sarah is NOT reachable through property B`, d.allowed === false, d.reason);
    }

    // Credential sends skip classification, which makes them the likeliest
    // hole. They must still respect the property wall.
    mode("customer_care");
    let d = await can({ property_id: B.id, recipient: "+15005558001", person_id: sarah, purpose: CREDENTIAL, from: B.line });
    check("even a CREDENTIAL send refuses across the property wall",
      d.allowed === false && d.reason === "recipient_not_in_property_scope", d.reason);

    // Classification is property-scoped: internal_qa at A is not internal_qa at B.
    const ctxB = await cb.resolvePersonPropertyContext(sarah, B.id, c);
    check("her internal_qa standing at A does not follow her to B",
      !ctxB.classification && !ctxB.relationship_exists,
      `${ctxB.classification && ctxB.classification.record_class} / rel=${ctxB.relationship_exists}`);

    // ── inbound: the wall holds in the other direction too ─────────────
    const wrongLine = await cb.resolveInboundSmsContext(
      { To: B.line, From: "+15005558001", MessageSid: "CP_xprop_1", body: "when is my rent due?" }, c);
    check("Sarah texting property B's line is NOT resolved as Sarah",
      wrongLine.person === null, wrongLine.person && wrongLine.person.id);
    check("...the message is kept on B, person-less, flagged for a human",
      wrongLine.ambiguous === true && wrongLine.comm_event
        && wrongLine.comm_event.property_id === B.id
        && wrongLine.comm_event.person_id === null
        && wrongLine.comm_event.needs_human === true);
    check("...and B's own resident is untouched by it",
      (await Q(`select count(*)::int c from comm_events where person_id=$1`, [marcus]))[0].c === 0);

    // A STOP shouted at the wrong property must NOT silence her at her own.
    const stopWrong = await cb.resolveInboundSmsContext(
      { To: B.line, From: "+15005558001", MessageSid: "CP_xprop_2", body: "STOP" }, c);
    check("a STOP to the WRONG property does not opt her out",
      stopWrong.consentSignal == null && (await consentOf(sarah)) === "opted_in",
      await consentOf(sarah));
    // This is correct — an unresolved sender has no person to record consent
    // against — but it means that STOP is only honoured by Twilio's carrier
    // layer, not by us. Worth knowing rather than assuming.

    check("nothing reached the wire in this entire run", wire.length === 0, `${wire.length} sent`);

    // ════════════════════════════════════════════════════════════════
    //  [C] IS ANY OF THIS LOAD-BEARING?
    //
    //  A green harness proves nothing if it would stay green against
    //  broken code. Section A's 32 refusals could all be passing because
    //  the send mode blocked them anyway, with the opt-out check never
    //  doing a thing.
    //
    //  So: run the SAME gate against a client that lies about consent —
    //  every consent read comes back 'opted_in' while the database says
    //  otherwise. That is exactly what a regression in the consent lookup
    //  would look like. If nothing changes, section A was decorative.
    console.log("\n[C] the assertions are load-bearing — blind the consent read and watch them break\n");

    await Q(`update contact_preferences set consent_state='opted_out' where person_id=$1 and channel='text'`, [sarah]);
    const blind = {
      query: (sql, params) =>
        /consent_state\s+from\s+contact_preferences/i.test(String(sql))
          ? Promise.resolve({ rows: [{ consent_state: "opted_in" }] })
          : c.query(sql, params),
    };

    // The door count is DERIVED, not asserted as a literal. It used to be a
    // hardcoded 16 (four modes x four purposes); retiring
    // internal_qa_autonomous made it 12 and the mutation test failed for a
    // reason that had nothing to do with consent. A number baked into a
    // safety assertion turns an unrelated change into a false alarm — and
    // the next person's instinct is to edit the number, which is exactly
    // how a mutation test quietly stops mutating.
    const MODES = ["disabled", "proof_only", "customer_care"];
    const PURPOSES = [AUTONOMOUS, CREDENTIAL, "proof_text", "staff_invite"];
    const doors = MODES.length * PURPOSES.length;

    let opened = 0, stillClosedByConsent = 0;
    for (const m of MODES) {
      mode(m);
      for (const purpose of PURPOSES) {
        const dd = await cb.canSendSmsForRecord(
          { property_id: A.id, recipient: "+15005558001", person_id: sarah, purpose, from: A.line }, blind);
        if (dd.reason !== "consent_opted_out") opened++;
        else stillClosedByConsent++;
      }
    }
    check("blinding the consent read changes the answer — the opt-out gate is the thing doing the work",
      opened === doors && stillClosedByConsent === 0,
      `${opened} of ${doors} doors behaved differently`);

    mode("customer_care");
    const wouldSend = await cb.canSendSmsForRecord(
      { property_id: A.id, recipient: "+15005558001", person_id: sarah, purpose: AUTONOMOUS, from: A.line }, blind);
    check("...and with consent blinded, an opted-out person WOULD have been texted",
      wouldSend.allowed === true,
      `${wouldSend.reason} — if this fails, section A is passing for the wrong reason`);

  } catch (e) {
    fails.push("HARNESS ERROR: " + (e.stack || e.message));
    console.error("\nHARNESS ERROR:", e.stack || e.message);
  } finally {
    try { await c.query("rollback"); rolledBack = true; } catch (e) { console.error("ROLLBACK FAILED:", e.message); }
    c.release();
  }

  // The rollback is itself part of the proof: if it did not happen, this
  // harness left fixtures in a live database.
  const left = Number((await pool.query(
    `select count(*)::int c from properties where name like 'CONSENT_PROOF %'`)).rows[0].c);
  check("the transaction rolled back — nothing was left behind", rolledBack && left === 0, `${left} properties`);

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) console.log("\nFAILURES:\n - " + fails.join("\n - "));
  await pool.end();
  process.exit(fails.length ? 1 : 0);
})();
