// ════════════════════════════════════════════════════════════════════
//  PHASE A ACCEPTANCE HARNESS — comms_boundary_phase_a_proof.js
//
//  Self-isolating proof of the permanent communications boundary against a
//  REAL Postgres. Class 3 test infrastructure (KEEP — the reusable Phase A
//  proof; it writes only tagged throwaway fixtures and removes them in a
//  finally). Injects a FAKE transport (enabled, records sends, never touches
//  the network) so the gate's DECISION logic — modes, purposes, consent,
//  classification, scope, property line — is exercised end-to-end.
//
//  COVERED HEADLESSLY:
//    • OUTBOUND gate (sendPropertySms/canSendSmsForRecord): every send-mode ×
//      purpose × consent × line combination, incl. fail-closed refusals.
//    • INBOUND resolver safety cases: unknown line (zero rows), ambiguous /
//      unmatched sender (person-less needs_human), duplicate sid (idempotent),
//      malformed (zero rows).
//
//  NOT COVERED HEADLESSLY (needs active-lease + used-invite + space chain;
//  source-verified, exercised live post-activation when a real resident texts):
//    • inbound RESOLVED-sender happy path
//    • STOP/START consent-keyword interception
//
//  RUN (local mirror): PGHOST/PGPORT/PGUSER/PGDATABASE set → `node comms_boundary_phase_a_proof.js`
//  RUN (Neon, Render Shell): DATABASE_URL set → same command. Exit 0 = pass.
// ════════════════════════════════════════════════════════════════════

const { Pool } = require("pg");
const communicationsBoundary = require("../src/comms/communications_boundary.js");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /sslmode=require|neon\.tech/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    })
  : new Pool(); // reads PGHOST/PGPORT/PGUSER/PGDATABASE

// ── fake transport: enabled, records sends, never hits the network ──
let sent = [];
const fakeSms = {
  enabled: () => true,
  sendSms: async ({ to, from, body }) => { sent.push({ to, from, body }); return { sent: true, sid: "SMx" + (sent.length), status: "queued" }; },
  validateWebhook: () => true,
};
const cb = communicationsBoundary({ pool, sms: fakeSms });

let pass = 0, fail = 0; const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? "  [" + detail + "]" : "")); console.error("  FAIL " + name + (detail ? "  [" + detail + "]" : "")); }
}

// env knobs (gate reads process.env fresh per call)
const mode = (m) => { process.env.SMS_SEND_MODE = m; };
const setProofCell = (c) => { if (c === null) delete process.env.SMS_PROOF_CELL; else process.env.SMS_PROOF_CELL = c; };
const setQaProp = (p) => { if (p === null) delete process.env.SMS_QA_PROPERTY_ID; else process.env.SMS_QA_PROPERTY_ID = p; };
const setCred = (on) => { if (on) process.env.SMS_ALLOW_CREDENTIAL_SENDS = "1"; else delete process.env.SMS_ALLOW_CREDENTIAL_SENDS; };

const TAG = "PHASEA_" + Date.now();
const LINE = "+1500" + String(Math.floor(Math.random() * 9000000) + 1000000); // unique fake E.164 property line
const PROOF_CELL = "+15005550999";
const RANDO = "+15005550123";
const created = { props: [], persons: [] };

const q = async (sql, params) => (await pool.query(sql, params)).rows;

async function mkProperty(name, sms_number) {
  const r = await q(`insert into properties (name, sms_number) values ($1,$2) returning id`, [name, sms_number]);
  created.props.push(r[0].id); return r[0].id;
}
async function mkPerson(phone) {
  const r = await q(`insert into persons (name, phone) values ($1,$2) returning id`, [TAG, phone]);
  created.persons.push(r[0].id); return r[0].id;
}
async function relate(person_id, property_id) { // lightest relationship_exists: a conversation row
  await q(`insert into conversations (property_id, person_id) values ($1,$2) on conflict (property_id,person_id) do nothing`, [property_id, person_id]);
}
async function classify(person_id, property_id, cls) {
  await q(`update person_property_classifications set superseded_at=now() where person_id=$1 and property_id=$2 and superseded_at is null`, [person_id, property_id]);
  await q(`insert into person_property_classifications (person_id, property_id, record_class, classification_source) values ($1,$2,$3,'operator')`, [person_id, property_id, cls]);
}
async function consent(person_id, state) {
  await q(`insert into contact_preferences (person_id, channel, consent_state, source) values ($1,'text',$2,'harness')
           on conflict (person_id, channel) do update set consent_state=$2, source='harness', updated_at=now()`, [person_id, state]);
}
const commCount = async (property_id) => Number((await q(`select count(*)::int c from comm_events where property_id=$1`, [property_id]))[0].c);
const send = async (opts) => { sent = []; return cb.sendPropertySms(opts); };

(async () => {
  try {
    // ── fixtures ──
    const P = await mkProperty(TAG + "_line", LINE);
    const Pnoline = await mkProperty(TAG + "_noline", null);
    const qaP = await mkPerson("+15001110001"); await relate(qaP, P); await classify(qaP, P, "internal_qa"); await consent(qaP, "opted_in");
    const prodP = await mkPerson("+15001110002"); await relate(prodP, P); await classify(prodP, P, "production"); await consent(prodP, "opted_in");
    const unclP = await mkPerson("+15001110003"); await relate(unclP, P); await consent(unclP, "opted_in"); // no classification
    const outP = await mkPerson("+15001110004"); await relate(outP, P); await classify(outP, P, "internal_qa"); await consent(outP, "opted_out");

    let r;
    // ══ disabled ══
    mode("disabled");
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: qaP });
    check("disabled: refuses agent", r.sent === false && r.reason === "send_mode_disabled", r.reason);
    check("disabled: transport not reached", sent.length === 0);

    // ══ proof_only ══
    mode("proof_only"); setProofCell(PROOF_CELL); setCred(false);
    r = await send({ property_id: P, recipient: PROOF_CELL, body: "proof", purpose: "proof_text" });
    check("proof_only: proof_text→cell allowed", r.sent === true, r.reason);
    check("proof_only: transport got property line + cell", sent.length === 1 && sent[0].from === LINE && sent[0].to === PROOF_CELL, JSON.stringify(sent[0] || {}));
    r = await send({ property_id: P, recipient: RANDO, body: "proof", purpose: "proof_text" });
    check("proof_only: proof_text→non-cell refused", r.sent === false && r.reason === "proof_only_recipient_not_proof_cell", r.reason);
    check("proof_only: non-cell not sent", sent.length === 0);
    r = await send({ property_id: P, recipient: PROOF_CELL, body: "x", purpose: "agent", person_id: qaP });
    check("proof_only: agent purpose blocked", r.sent === false && r.reason === "send_mode_proof_only_blocks_this_purpose", r.reason);
    r = await send({ property_id: P, recipient: RANDO, body: "code", purpose: "otp", person_id: qaP });
    check("proof_only: otp blocked without flag", r.sent === false && r.reason === "credential_sends_disabled_in_proof_only", r.reason);
    setCred(true);
    r = await send({ property_id: P, recipient: RANDO, body: "code", purpose: "otp", person_id: qaP });
    check("proof_only: otp allowed with credential flag", r.sent === true, r.reason);
    setCred(false);

    // ══ no property line ══
    mode("proof_only"); setProofCell(PROOF_CELL);
    r = await send({ property_id: Pnoline, recipient: PROOF_CELL, body: "proof", purpose: "proof_text" });
    check("no line: refused no_property_line", r.sent === false && r.reason === "no_property_line", r.reason);
    check("no line: transport not reached", sent.length === 0);

    // ══ consent opted_out blocks everything ══
    mode("customer_care");
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: outP });
    check("opted_out: blocks agent outright", r.sent === false && r.reason === "consent_opted_out", r.reason);

    // ══ the retired mode is not a live mode ══
    //  internal_qa_autonomous was removed on 2026-07-26. This block used to
    //  exercise it and would now have run against a mode that silently
    //  resolves to `disabled` — six checks passing because nothing happened.
    //  It asserts the RETIREMENT instead, which is the thing that could
    //  regress: if the string ever behaves like a live mode again, the
    //  opposite-direction class gate is back.
    mode("internal_qa_autonomous");
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: qaP });
    check("retired mode sends NOTHING — an unknown mode falls to disabled, never to a live one",
      r.sent === false && r.reason === "send_mode_disabled", r.reason);

    // ══ customer_care — consent and property, no class ══
    mode("customer_care"); setQaProp(null);
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: prodP });
    check("customer_care: opted_in agent allowed", r.sent === true, r.reason);
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: qaP });
    check("customer_care: CLASS IS NOT CONSULTED — an internal_qa record with consent is allowed",
      r.sent === true, r.reason);
    r = await send({ property_id: P, recipient: RANDO, body: "x", purpose: "agent", person_id: unclP });
    check("customer_care: an unclassified record with consent is allowed — class gates nothing here",
      r.sent === true, r.reason);
    r = await send({ property_id: P, recipient: RANDO, body: "code", purpose: "otp", person_id: qaP });
    check("customer_care: credential send inside property scope allowed", r.sent === true, r.reason);

    // ══ INBOUND resolver — safety-critical cases ══
    let ic;
    ic = await cb.resolveInboundSmsContext({ To: "+19998887777", From: "+15005551111", MessageSid: TAG + "_u1", body: "hi" });
    check("inbound: unknown line flagged, not malformed", ic.unknownLine === true && ic.malformed !== true, JSON.stringify(ic));

    const beforeAmb = await commCount(P);
    ic = await cb.resolveInboundSmsContext({ To: LINE, From: "+15005552222", MessageSid: TAG + "_a1", body: "is my rent due?" });
    const afterAmb = await commCount(P);
    check("inbound: ambiguous flagged", ic.ambiguous === true, JSON.stringify(ic));
    check("inbound: ambiguous wrote exactly one comm_event", afterAmb - beforeAmb === 1, `${beforeAmb}->${afterAmb}`);
    const ev = (await q(`select person_id, needs_human, classification, direction, channel from comm_events where sms_sid=$1`, [TAG + "_a1"]))[0];
    check("inbound: ambiguous row person-less + needs_human + 'unknown' + inbound sms",
      ev && ev.person_id === null && ev.needs_human === true && ev.classification === "unknown" && ev.direction === "inbound" && ev.channel === "sms",
      JSON.stringify(ev || {}));

    const beforeDup = await commCount(P);
    ic = await cb.resolveInboundSmsContext({ To: LINE, From: "+15005552222", MessageSid: TAG + "_a1", body: "again" });
    const afterDup = await commCount(P);
    check("inbound: duplicate sid → idempotentReplay", ic.idempotentReplay === true, JSON.stringify(ic));
    check("inbound: duplicate wrote no new row", afterDup - beforeDup === 0, `${beforeDup}->${afterDup}`);

    const beforeMal = await commCount(P);
    ic = await cb.resolveInboundSmsContext({ From: "+15005552222", MessageSid: TAG + "_m1", body: "x" });
    const afterMal = await commCount(P);
    check("inbound: malformed (missing To) flagged", ic.malformed === true, JSON.stringify(ic));
    check("inbound: malformed wrote nothing", afterMal - beforeMal === 0, `${beforeMal}->${afterMal}`);

    console.log(`\nPHASE A (outbound gate + inbound safety) — ${pass}/${pass + fail} passed`);
    if (fail) console.error("\nFAILURES:\n - " + fails.join("\n - "));
  } catch (e) {
    console.error("HARNESS ERROR:", e.stack || e.message); fail++;
  } finally {
    try {
      if (created.persons.length) await pool.query(`delete from person_property_classifications where person_id = any($1)`, [created.persons]);
      if (created.props.length) await pool.query(`delete from properties where id = any($1)`, [created.props]); // cascades comm_events + conversations
      if (created.persons.length) await pool.query(`delete from persons where id = any($1)`, [created.persons]); // cascades contact_preferences
      console.log("teardown: fixtures removed");
    } catch (e) { console.error("teardown error:", e.message); }
    await pool.end();
    process.exit(fail ? 1 : 0);
  }
})();
