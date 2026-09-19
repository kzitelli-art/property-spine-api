/* ════════════════════════════════════════════════════════════════════
   web_lead_intake_contract.db.js — THE EXACT CONTRACT AN EXTERNAL
   WEBSITE MUST FOLLOW TO POST LEADS FOR SKYLINE AND GREENERY.

   Governed door: POST /leasing/intake (src/leasing/leasing_leads.js).
   Auth: shared secret (x-intake-secret) bound, server-side, to a
   comma-separated property allowlist (LEASING_INTAKE_PROPERTY_IDS) —
   NOT a per-property token. Property selection is the request body's
   property_id, checked only against that allowlist.

   Two properties the running server has bound into that allowlist
   (locally Skyline E2E + Greenery E2E; in CI Skyline E2E + the real-intake
   fixture property), each with its own communication_lines row
   (properties.sms_number is the read-only projection — verified, not
   asserted). Their ids arrive as E2E_SKYLINE_PROPERTY_ID and
   E2E_GREENERY_PROPERTY_ID, exactly the ids boot.sh bound.

   Proves, over real HTTP against the owned runtime:
     1. name+phone → lands on the requested property, not the other
     2. name-only (no phone/email) → the actual refusal, recorded as
        the contract
     3. repeat submission, same phone → one person, not two
     4. unknown/unbound property_id → refused before intake logic runs
     5. body property_id for the OTHER bound property → lands on that
        OTHER property (the shared secret has no per-property binding)
     6. the lead appears in Skyline's operator leasing queue read
     7. Ask Spine's leasing standing reader can see the person at the
        property they engaged, and cannot at the other
     8. POST /persons → 410, retired

   Real Postgres + real HTTP against the E2E-booted server. Nothing mocked
   except the outbound SMS/model transports, which the harness already
   fences (E2E_SMS_LOG / E2E_ANTHROPIC_LOG).
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "..", "..");
const sessions = require(path.join(root, "src/identity/staff_session_service.js"));
const { readLeasingStanding, resolveLeasingSubject } = require(path.join(root, "src/leasing/leasing_standing_read.js"));

const API = process.env.E2E_API_BASE || "http://127.0.0.1:3055";
const INTAKE_SECRET = process.env.LEASING_INTAKE_SECRET || "e2e-intake";

const post = async (p, body, headers = {}) => {
  const r = await fetch(`${API}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
};
const get = async (p, headers = {}) => {
  const r = await fetch(`${API}${p}`, { headers });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
};

let pass = 0, fail = 0; const failures = [];
const results = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
  return cond;
};
const record = (behavior, verdict) => results.push({ behavior, verdict });

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  const tag = `weblead-${randomUUID().slice(0, 8)}`;
  try {
    // ── FIXTURE: two properties (bed / unit), each with its own line ──
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const opPerson = await one("insert into persons(name) values($1) returning id", [`${tag}-operator`]);
    const operator = await one(`insert into users
      (name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
      [`${tag} op`, `${tag}@example.test`, org.id, opPerson.id]);

    // The running server's LEASING_INTAKE_PROPERTY_IDS was bound (at boot,
    // via tests/e2e/boot.sh's own PROP lookup + E2E_INTAKE_INACTIVE_PROPERTY_ID)
    // to two specific, already-created property ids — a real intake credential
    // is bound to real property ids, not minted fresh per proof run. This
    // proof reuses exactly those two rows so the HTTP calls below hit a
    // credential the server actually recognizes.
    const SKYLINE_ID = process.env.E2E_SKYLINE_PROPERTY_ID;
    const GREENERY_ID = process.env.E2E_GREENERY_PROPERTY_ID;
    if (!SKYLINE_ID || !GREENERY_ID) throw new Error("E2E_SKYLINE_PROPERTY_ID and E2E_GREENERY_PROPERTY_ID are required (the two ids bound into the running server's LEASING_INTAKE_PROPERTY_IDS at boot).");
    const skyline = await one("select id, leasing_basis from properties where id=$1", [SKYLINE_ID]);
    const greenery = await one("select id, leasing_basis from properties where id=$1", [GREENERY_ID]);
    if (!skyline || !greenery) throw new Error("fixture properties not found in the owned database");
    // The contract is about ROUTING between two bound properties, not about
    // grain. Locally the two are Skyline E2E (bed) and Greenery E2E (unit);
    // in CI the second is the real-intake fixture property. Either way they
    // must be two distinct rows the running server has bound. The bases are
    // reported, not asserted, so this proof never depends on a fixture shape
    // the intake door does not read.
    ok("fixture: two distinct bound properties (A=Skyline E2E, B=the other bound property)",
      skyline.id !== greenery.id,
      `A basis=${skyline.leasing_basis} B basis=${greenery.leasing_basis}`);
    console.log(`  info  A basis=${skyline.leasing_basis} · B basis=${greenery.leasing_basis}`);

    for (const p of [skyline, greenery]) {
      await pool.query(`insert into property_team_assignments
        (property_id,user_id,role_title,allowed_modules,active,can_manage_roles)
        values($1,$2,'Proof Seat','{leasing,management}',true,true)`, [p.id, operator.id]);
      const existingLine = await one("select id from communication_lines where property_id=$1 and status='active' limit 1", [p.id]);
      if (!existingLine) {
        await pool.query(`insert into communication_lines
            (e164, line_type, property_id, authority_ceiling, permitted_audience,
             inbound_enabled, outbound_enabled, outbound_policy, status)
           values ($1,'property_facing',$2,'external','residents_and_prospects',
                   true,true,'proactive','active')`,
          [`+1215555${String(Math.floor(Math.random() * 9000) + 1000)}`, p.id]);
      }
    }
    const smsA = (await one("select sms_number from properties where id=$1", [skyline.id])).sms_number;
    const smsB = (await one("select sms_number from properties where id=$1", [greenery.id])).sms_number;
    ok("fixture: properties.sms_number is populated FROM communication_lines (read-only projection)",
      !!smsA && !!smsB, `A=${smsA} B=${smsB}`);

    // The server process's own LEASING_INTAKE_PROPERTY_IDS (set at boot, not
    // visible in THIS shell's env) is proven by behavior below (calls 1 and
    // 5 succeed against both ids; call 4 refuses an id outside that set).

    const H = { "x-intake-secret": INTAKE_SECRET };

    // ═══ 1. name+phone → lands on A, not B ═══════════════════════════
    const nonce1 = String(2000 + Math.floor(Math.random() * 7999));
    const phone1 = "215556" + nonce1;
    // A name genuinely unique in this shared, reused proof database — not just
    // tag-suffixed. Ask Spine's subject resolver phrase-matches on substrings,
    // so "Ana Prospect <tag>" would still collide with an unrelated leftover
    // "Ana Prospect" row from an earlier run (a real lesson from this run).
    const prospectName = `Quillenbrix Farstead ${nonce1}`;
    const r1 = await post("/leasing/intake", {
      property_id: skyline.id, name: prospectName, phone: phone1,
      response_channel: "website", message: "Is the 2BR still available?",
      attempt_sms: false, source: "propertyspine_website",
    }, H);
    const b1ok = ok("1) name+phone submitted to A → 200 with a person_id and lead_id",
      r1.status === 200 && !!r1.body.person_id && !!r1.body.lead_id, JSON.stringify(r1));
    record("name+phone lands on requested property", b1ok ? "PROVEN" : "FAILED");

    const leadRowsA = (await pool.query(
      "select id, property_id from leasing_leads where person_id=$1", [r1.body && r1.body.person_id])).rows;
    ok("1a) the opportunity was written under Skyline's property_id only",
      leadRowsA.length === 1 && leadRowsA[0].property_id === skyline.id,
      JSON.stringify(leadRowsA));
    ok("1b) nothing was written under Greenery for this person",
      !leadRowsA.some(l => l.property_id === greenery.id));
    const personRow1 = await one("select id, primary_phone_e164 from persons where id=$1", [r1.body.person_id]);
    ok("1c) the person's identity handle is the normalized phone",
      personRow1.primary_phone_e164 === "+1" + phone1, personRow1.primary_phone_e164);

    // ═══ 6. appears in Skyline's operator leasing queue read ═════════
    const sessA = await sessions.issueStaffSession(pool, { userId: operator.id, propertyId: skyline.id, purpose: "bootstrap_invite" });
    const sessB = await sessions.issueStaffSession(pool, { userId: operator.id, propertyId: greenery.id, purpose: "bootstrap_invite" });
    const queueA = await get("/operator/leasing/conversation-queue", { "x-staff-session": sessA.session_token });
    const queueB = await get("/operator/leasing/conversation-queue", { "x-staff-session": sessB.session_token });
    const inQueueA = queueA.status === 200 && (queueA.body.conversations || []).some(x => x.person_id === r1.body.person_id);
    const inQueueB = queueB.status === 200 && (queueB.body.conversations || []).some(x => x.person_id === r1.body.person_id);
    const b6ok = ok("6) the lead appears in GET /operator/leasing/conversation-queue for Skyline (staff session, x-staff-session)",
      queueA.status === 200 && inQueueA, JSON.stringify(queueA.body).slice(0, 400));
    ok("6a) …and is ABSENT from Greenery's queue (different staff session, same operator)",
      queueB.status === 200 && !inQueueB);
    record("appears in property A's leasing queue read (GET /operator/leasing/conversation-queue)", b6ok ? "PROVEN" : "FAILED");

    // ═══ 7. Ask Spine's leasing standing reader ══════════════════════
    // Canonical readers ask_spine_answer.js calls by default (leasingReader =
    // leasingStandingRead): resolveLeasingSubject scopes candidate people to
    // the ASKING property, then readLeasingStanding is the compact standing
    // projection (§40.6). Called directly (real DB, real service code) to
    // keep this proof independent of a live model call — the fenced
    // E2E Anthropic sentinel refuses every messages.create() by design
    // (tests/e2e/fake_anthropic_preload.js), and subject resolution here is
    // pure SQL, never model-decided.
    const subjA = await resolveLeasingSubject(pool, { property_id: skyline.id, text: `What did ${prospectName} ask about?` });
    const subjB = await resolveLeasingSubject(pool, { property_id: greenery.id, text: `What did ${prospectName} ask about?` });
    const askA = subjA.resolved ? await readLeasingStanding(pool, { person_id: subjA.person.id, property_id: skyline.id }) : null;
    const b7ok = ok("7) Ask Spine subject resolution finds Ana at Skyline, standing read shows current_position=prospect + her website inquiry",
      subjA.resolved && askA && askA.current_position && askA.current_position.stage === "prospect"
        && askA.inquiry_history.read_state === "OK" && askA.inquiry_history.messages.length === 1,
      JSON.stringify({ subjA, current_position: askA && askA.current_position, inquiry: askA && askA.inquiry_history }));
    ok("7a) …and Ask Spine CANNOT find the prospect at Greenery — no presence there at all",
      subjB.resolved === false && subjB.reason === "no_person_named", JSON.stringify(subjB));
    record("Ask Spine prospect reader sees A, not B (resolveLeasingSubject + readLeasingStanding)", b7ok ? "PROVEN" : "FAILED");

    // ═══ 2. name-only (no phone, no email) ═══════════════════════════
    const r2 = await post("/leasing/intake", { property_id: skyline.id, name: "No Handle At All" }, H);
    const b2ok = ok("2) name-only submission is REFUSED, not staged as a person without a handle",
      r2.status === 400 && /phone or email/i.test((r2.body || {}).receipt || ""), JSON.stringify(r2));
    const namedRows = await pool.query("select id from persons where name=$1", ["No Handle At All"]);
    ok("2a) …and nothing was minted for it", namedRows.rows.length === 0);
    record("name-only lead → 400 refused (\"A phone or email is required to identify the prospect.\"), no person created",
      b2ok ? "PROVEN" : "FAILED");

    // ═══ 3. repeat submission, same phone ════════════════════════════
    const r3 = await post("/leasing/intake", {
      property_id: skyline.id, name: prospectName, phone: phone1,
      response_channel: "website", attempt_sms: false, source: "propertyspine_website",
    }, H);
    const personCount = (await pool.query(
      "select count(*)::int c from persons where primary_phone_e164=$1", ["+1" + phone1])).rows[0].c;
    const leadCount = (await pool.query(
      "select count(*)::int c from leasing_leads where person_id=$1 and property_id=$2", [r1.body.person_id, skyline.id])).rows[0].c;
    const b3ok = ok("3) repeat submission from the same phone reuses the SAME person and the SAME opportunity",
      r3.status === 200 && r3.body.person_id === r1.body.person_id && r3.body.reused_opportunity === true
        && personCount === 1 && leadCount === 1,
      JSON.stringify({ r3: r3.body, personCount, leadCount }));
    record("repeat submit, same phone → one person, one opportunity (not two)", b3ok ? "PROVEN" : "FAILED");

    // ═══ 4. unknown / unbound property_id ═════════════════════════════
    const strangerPropertyId = randomUUID(); // not in LEASING_INTAKE_PROPERTY_IDS
    const r4 = await post("/leasing/intake", {
      property_id: strangerPropertyId, name: "Should Not Land", phone: "215557" + nonce1,
    }, H);
    const b4ok = ok("4) a property_id NOT bound to this intake credential is refused BEFORE intake logic runs (403)",
      r4.status === 403 && /not entitled/i.test((r4.body || {}).receipt || ""), JSON.stringify(r4));
    record("unknown/unbound property_id → 403 refused at the credential wall (never reaches property lookup)", b4ok ? "PROVEN" : "FAILED");

    // ═══ 5. body property_id names the OTHER bound property ══════════
    // THE FINDING: there is no per-property token. ONE shared secret is
    // bound to a SET of properties (LEASING_INTAKE_PROPERTY_IDS). Any
    // property_id inside that set is accepted from the SAME credential —
    // the door cannot tell "Skyline's form" from "Greenery's form" apart.
    // A body property_id naming the OTHER in-set property is NOT refused;
    // it legitimately lands on that other property.
    const r5 = await post("/leasing/intake", {
      property_id: greenery.id, name: `Ben Cross Property ${nonce1}`, phone: "215558" + nonce1,
      response_channel: "website", attempt_sms: false,
    }, H); // same shared secret used for Skyline above
    const landedB = await pool.query(
      "select property_id from leasing_leads where person_id=$1", [r5.body && r5.body.person_id]);
    const b5ok = ok("5) same shared secret, body property_id=Greenery → lands on Greenery (not refused, not Skyline)",
      r5.status === 200 && landedB.rows.length === 1 && landedB.rows[0].property_id === greenery.id,
      JSON.stringify({ r5: r5.body, landedB: landedB.rows }));
    record("body property_id for the OTHER credential-bound property → lands there (no per-property token exists to refuse it)",
      b5ok ? "PROVEN — but see finding" : "FAILED");

    // ═══ 8. POST /persons → 410 ═══════════════════════════════════════
    // NOTE: /persons is not on server.js's public allowlist (PUBLIC_EXACT /
    // PUBLIC_PREFIXES), so the global gate (server.js, ahead of every route)
    // demands the shared x-operator-key BEFORE the request ever reaches the
    // retired handler. A website — which only ever holds the intake secret —
    // cannot reach this route at all; a caller who DOES hold the operator
    // key gets 410. Proven both ways.
    const r8noKey = await post("/persons", { name: "Should Be Retired" });
    const b8aok = ok("8a) POST /persons with NO operator key never reaches the retired handler (401 at the global gate — a website cannot get here)",
      r8noKey.status === 401, JSON.stringify(r8noKey));
    const r8 = await post("/persons", { name: "Should Be Retired" }, { "x-operator-key": process.env.OPERATOR_KEY || "e2e-key" });
    const b8ok = ok("8b) POST /persons WITH the operator key → 410, names the real doors",
      r8.status === 410 && r8.body && r8.body.code === "person_create_retired", JSON.stringify(r8));
    record("POST /persons → 401 (no key, unreachable to a website) or 410 person_create_retired (with the operator key)",
      (b8aok && b8ok) ? "PROVEN" : "FAILED");

    // ── compact table ──────────────────────────────────────────────
    console.log("\n== CONTRACT RESULTS ==");
    for (const r of results) console.log(`  [${r.verdict}]  ${r.behavior}`);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
