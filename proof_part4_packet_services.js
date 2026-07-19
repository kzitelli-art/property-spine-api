/**
 * PART 4 — PACKET SERVICES INTEGRATION PROOF (real-module, rollback-only)
 *
 * Proves the ACTUAL leasepackets.js factory + closure-bound helpers + router._service,
 * not a copy. Every case runs begin → … → ROLLBACK on ONE client. No fixture is ever
 * committed. Run from the Render Web Shell:
 *
 *     node proof_part4_packet_services.js
 *
 * Scope (per ruling): the packet SERVICES only. Does NOT prove requireOperator,
 * requireLeasingModuleAccess, server DI, the HTTP paths, or the legacy 410s —
 * those are a separate Part 5 HTTP smoke.
 *
 * P6 (locked-schedule conflict) is deferred: it needs a deep source-offer FK chain
 * and no offers exist. Not manufactured here.
 */

const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── real module construction (throwing stubs — these deps must NOT be touched) ──
const leasePacketsModule = require("../../leasepackets");
const router = leasePacketsModule({
  pool,
  satisfyObligation: async () => { throw new Error("unexpected satisfyObligation call"); },
  completeObligation: async () => { throw new Error("unexpected completeObligation call"); },
});
if (!router || !router._service) throw new Error("leasepackets._service missing");
const { generateTermsReviewPacket, issueTermsReviewPacketLink } = router._service;
if (typeof generateTermsReviewPacket !== "function") throw new Error("generateTermsReviewPacket missing");
if (typeof issueTermsReviewPacketLink !== "function") throw new Error("issueTermsReviewPacketLink missing");

// the proven confirmation service — used to create the governed confirmation the
// RIGHT way (never hand-injected classification/state).
const proposedTerms = require("../../proposed_terms_service");

// ── standing real IDs (FK-valid) ──
const DEMO_PROPERTY = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const PROPERTY_B    = "971c51ab-be96-4e5f-81df-0e59804c879b";
const QA_OPERATOR   = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";

// ── tiny assert plumbing ──
let PASS = 0, FAIL = 0; const FAILURES = [];
function ok(name, cond, detail) {
  if (cond) { PASS++; console.log(`  PASS  ${name}`); }
  else { FAIL++; FAILURES.push(name); console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
async function expectCode(name, fn, code) {
  try { await fn(); ok(name, false, `expected throw ${code}, got success`); }
  catch (e) { ok(name, e.code === code, `expected ${code}, got ${e.code || e.message}`); }
}

const ACTX = { ip: "127.0.0.1", user_agent: "proof-harness" };
const actorFor = (over = {}) => ({
  user_id: QA_OPERATOR, property_id: DEMO_PROPERTY,
  role: "leasing_manager", role_title: "leasing_manager", can_manage_roles: false, ...over,
});

// ════════════════════════════════════════════════════════════════════
//  SCHEMA PREFLIGHT — abort before fixtures if anything expected is missing
// ════════════════════════════════════════════════════════════════════
async function preflight(client) {
  console.log("\n── SCHEMA PREFLIGHT ──");
  const need = {
    application_proposed_terms_confirmations: ["id","application_id","property_id","rent","security_deposit","lease_start_date","lease_end_date","concession_status","source","payload_hash"],
    lease_packets: ["id","property_id","application_id","unit_id","version","status","terms_json","rendered_snapshot","rendered_snapshot_hash","proposed_terms_confirmation_id","tenant_token_hash","issue_actor_user_id","issue_idempotency_key","issued_at","superseded_at","voided_at"],
    lease_packet_fields: ["id","lease_packet_id","field_key","section_key","clause_hash","display_order"],
    lease_packet_documents: ["id","lease_packet_id","document_type","title","required_acknowledgment"],
    lease_packet_audit_events: ["lease_packet_id","actor_role","event_type","event_json","ip_address","user_agent"],
    lease_applications: ["id","property_id","status","term_source","proposed_terms_confirmation_id","terms_review_obligation_id","rent","deposit","lease_start_date","lease_end_date","concession_status"],
    obligations: ["id","type","status","assigned_role","assigned_user_id","required_inputs"],
  };
  let bad = 0;
  for (const [table, cols] of Object.entries(need)) {
    const { rows } = await client.query(
      `select column_name from information_schema.columns where table_name=$1`, [table]);
    const have = new Set(rows.map(r => r.column_name));
    const missing = cols.filter(c => !have.has(c));
    if (missing.length) { bad++; console.log(`  MISSING ${table}: ${missing.join(", ")}`); }
    else console.log(`  ok  ${table} (${cols.length} cols)`);
  }
  if (bad) throw new Error("PREFLIGHT FAILED — schema drift; fix before proving.");
  // a real space for FK-valid unit_id
  const sp = (await client.query(`select unit_id from spaces where unit_id is not null limit 1`)).rows[0];
  console.log(`  space unit_id sample: ${sp ? sp.unit_id : "(none)"}`);
  return { spaceUnitId: sp ? sp.unit_id : null };
}

// ════════════════════════════════════════════════════════════════════
//  FIXTURE — build a lease_ready application with a terms_review obligation,
//  then a REAL confirmation via the proven service. All on `client`, uncommitted.
// ════════════════════════════════════════════════════════════════════
async function buildFixture(client, { property_id = DEMO_PROPERTY, unit_id = null, applicant = "Proof Applicant" } = {}) {
  // person + application in the governed window
  const person = (await client.query(
    `insert into persons (name) values ($1) returning id`, [applicant])).rows[0];

  // terms_review obligation owned by the QA operator (so 'owner' authority resolves)
  const ob = (await client.query(
    `insert into obligations (property_id, type, status, assigned_user_id, required_inputs, label)
     values ($1,'terms_review','open',$2, array['terms_acknowledged'], 'Terms review (proof)')
     returning id`, [property_id, QA_OPERATOR])).rows[0];

  // application: lease_ready, projection columns seeded to the SAME economics we'll confirm
  const app = (await client.query(
    `insert into lease_applications
       (property_id, status, applicant_name, unit_id, terms_review_obligation_id,
        rent, deposit, lease_start_date, lease_end_date, concession_status, captured)
     values ($1,'lease_ready',$2,$3,$4, 1850, 1850, '2026-09-01','2027-08-31','none', '{}'::jsonb)
     returning *`, [property_id, applicant, unit_id, ob.id])).rows[0];

  return { person, ob, app };
}

async function confirmTerms(client, app, over = {}) {
  const out = await proposedTerms.confirmProposedTerms(client, {
    application_id: app.id,
    rent: over.rent ?? 1850,
    security_deposit: over.security_deposit ?? 1850,
    lease_start_date: over.lease_start_date ?? "2026-09-01",
    lease_end_date: over.lease_end_date ?? "2027-08-31",
    concession_status: over.concession_status ?? "none",
    idempotency_key: over.idempotency_key ?? ("proof-conf-" + Math.random().toString(36).slice(2)),
    actor: actorFor(),
  });
  // reload app to pick up proposed_terms_confirmation_id + term_source projection
  const app2 = (await client.query(`select * from lease_applications where id=$1`, [app.id])).rows[0];
  return { out, app: app2 };
}

// run one case in its own rolled-back savepoint-free transaction
async function inTx(client, fn) {
  await client.query("begin");
  try { await fn(); } finally { await client.query("rollback"); }
}

async function countChildren(client, packetId) {
  const f = (await client.query(`select count(*)::int n from lease_packet_fields where lease_packet_id=$1`, [packetId])).rows[0].n;
  const d = (await client.query(`select count(*)::int n from lease_packet_documents where lease_packet_id=$1`, [packetId])).rows[0].n;
  const a = (await client.query(`select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_generated'`, [packetId])).rows[0].n;
  return { fields: f, docs: d, gen_audits: a };
}

// ════════════════════════════════════════════════════════════════════
async function main() {
  const client = await pool.connect();
  let prefl;
  try {
    // preflight in its own rolled-back tx (reads only)
    await client.query("begin"); prefl = await preflight(client); await client.query("rollback");

    // ── GENERATION ──────────────────────────────────────────────────
    console.log("\n── GENERATION ──");

    // G1: no confirmation → refused
    await inTx(client, async () => {
      const { app } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      await expectCode("G1 no confirmation → proposed_terms_not_confirmed",
        () => generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX }),
        "proposed_terms_not_confirmed");
    });

    // G2: valid confirmation → economics EQUAL confirmation, children created, one audit
    await inTx(client, async () => {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { out: conf, app } = await confirmTerms(client, app0);
      const { packet, idempotent } = await generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX });
      ok("G2 not idempotent on first gen", idempotent === false);
      ok("G2 packet stores confirmation_id", packet.proposed_terms_confirmation_id === conf.confirmation_id,
         `${packet.proposed_terms_confirmation_id} vs ${conf.confirmation_id}`);
      const t = packet.terms_json;
      ok("G2 rendered rent == confirmation rent (1850)", Number(t.monthly_rent) === 1850, `got ${t.monthly_rent}`);
      ok("G2 rendered deposit == confirmation deposit (1850)", Number(t.security_deposit) === 1850, `got ${t.security_deposit}`);
      ok("G2 rendered start == confirmation start", String(t.lease_start_date).slice(0,10) === "2026-09-01", `got ${t.lease_start_date}`);
      ok("G2 rendered end == confirmation end", String(t.lease_end_date).slice(0,10) === "2027-08-31", `got ${t.lease_end_date}`);
      const c = await countChildren(client, packet.id);
      // 4 base fields (no guarantor on this fixture)
      ok("G2 field count == requiredFieldsFor length (4)", c.fields === 4, `got ${c.fields}`);
      ok("G2 exactly 3 documents", c.docs === 3, `got ${c.docs}`);
      ok("G2 exactly 1 generation audit", c.gen_audits === 1, `got ${c.gen_audits}`);
      // audit attributes the operator + basis
      const au = (await client.query(
        `select actor_role, event_json from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_generated'`, [packet.id])).rows[0];
      ok("G2 audit actor_role=operator", au.actor_role === "operator", `got ${au.actor_role}`);
      ok("G2 audit records authority_basis", !!au.event_json.authority_basis, JSON.stringify(au.event_json));
      ok("G2 audit records actor_user_id", au.event_json.actor_user_id === QA_OPERATOR);
    });

    // G3: projection drifted after confirmation → refused
    await inTx(client, async () => {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { app } = await confirmTerms(client, app0);
      // deliberately drift the application projection (the forbidden direct UPDATE)
      await client.query(`update lease_applications set rent = 9999 where id=$1`, [app.id]);
      await expectCode("G3 projection drift → proposed_terms_projection_drift",
        () => generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX }),
        "proposed_terms_projection_drift");
    });

    // G4: same confirmation generated twice → same packet, unchanged children, audit stays 1
    await inTx(client, async () => {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { app } = await confirmTerms(client, app0);
      const first = await generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX });
      const c1 = await countChildren(client, first.packet.id);
      const second = await generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX });
      ok("G4 second gen is idempotent", second.idempotent === true);
      ok("G4 same packet id", second.packet.id === first.packet.id);
      const c2 = await countChildren(client, first.packet.id);
      ok("G4 field count unchanged", c2.fields === c1.fields, `${c1.fields}→${c2.fields}`);
      ok("G4 doc count unchanged", c2.docs === c1.docs, `${c1.docs}→${c2.docs}`);
      ok("G4 generation audit remains 1", c2.gen_audits === 1, `got ${c2.gen_audits}`);
    });

    // ── ISSUANCE ────────────────────────────────────────────────────
    console.log("\n── ISSUANCE ──");

    // helper: fixture → confirm → generate, return packet id
    async function genPacket(client) {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { app } = await confirmTerms(client, app0);
      const { packet } = await generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX });
      return { app, packet };
    }

    // I1: first issue → one token, status sent, durable identity, one audit
    await inTx(client, async () => {
      const { packet } = await genPacket(client);
      const r = await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-1", audit_context: ACTX });
      ok("I1 not already_issued", r.already_issued === false);
      ok("I1 returns a tenant_url once", typeof r.tenant_url === "string" && r.tenant_url.includes("/t/lease/"));
      ok("I1 token present once", typeof r.token === "string" && r.token.length > 0);
      const row = (await client.query(`select status, tenant_token_hash, issue_actor_user_id, issue_idempotency_key, issued_at from lease_packets where id=$1`, [packet.id])).rows[0];
      ok("I1 status sent", row.status === "sent", `got ${row.status}`);
      ok("I1 durable issuance identity stored", !!row.issue_actor_user_id && !!row.issue_idempotency_key && !!row.issued_at);
      ok("I1 token digest stored (not raw)", !!row.tenant_token_hash && row.tenant_token_hash !== r.token);
      const a = (await client.query(`select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_sent'`, [packet.id])).rows[0].n;
      ok("I1 exactly 1 packet_sent audit", a === 1, `got ${a}`);
    });

    // I2: same actor + same key retry → already_issued, no token, no second audit
    await inTx(client, async () => {
      const { packet } = await genPacket(client);
      await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-2", audit_context: ACTX });
      const r2 = await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-2", audit_context: ACTX });
      ok("I2 already_issued true", r2.already_issued === true);
      ok("I2 token_recoverable false", r2.token_recoverable === false);
      ok("I2 no token returned", r2.token === undefined);
      const a = (await client.query(`select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_sent'`, [packet.id])).rows[0].n;
      ok("I2 audit still 1 (no second)", a === 1, `got ${a}`);
    });

    // I3: different key after issuance → packet_link_already_issued
    await inTx(client, async () => {
      const { packet } = await genPacket(client);
      await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-3a", audit_context: ACTX });
      await expectCode("I3 different key after issue → packet_link_already_issued",
        () => issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-3b", audit_context: ACTX }),
        "packet_link_already_issued");
    });

    // I4: stale packet confirmation → proposed_terms_changed_packet_stale
    // Simulate the application pointer moving off the packet's confirmation.
    await inTx(client, async () => {
      const { app, packet } = await genPacket(client);
      // move the application's current confirmation pointer to null → packet now stale vs app
      await client.query(`update lease_applications set proposed_terms_confirmation_id = null where id=$1`, [app.id]);
      await expectCode("I4 stale confirmation → proposed_terms_changed_packet_stale",
        () => issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "iss-4", audit_context: ACTX }),
        "proposed_terms_changed_packet_stale");
    });

    // I5: forced audit-write failure → the service's packet mutation and audit
    // must be ONE atomic unit. We pass a query-proxy client that throws when the
    // service attempts the packet_sent audit insert, then assert (via the REAL
    // client, after rollback to savepoint) that NOTHING was persisted: status
    // still draft, no token digest, no issuance identity, no packet_sent audit.
    await inTx(client, async () => {
      const { packet } = await genPacket(client);
      await client.query("savepoint before_issue");

      // proxy: forwards every query to the real client EXCEPT the audit insert,
      // which it fails — simulating an audit-write error mid-issue.
      const failingAuditClient = {
        query(text, params) {
          if (/insert\s+into\s+lease_packet_audit_events/i.test(String(text))) {
            const err = new Error("forced_audit_failure");
            err.code = "FORCED_AUDIT_FAILURE";
            return Promise.reject(err);
          }
          return client.query(text, params);
        },
      };

      let threw = null;
      try {
        await issueTermsReviewPacketLink(failingAuditClient, {
          packet_id: packet.id, actor: actorFor(), expires_days: 14,
          idempotency_key: "iss-5", audit_context: ACTX });
      } catch (e) { threw = e; }
      ok("I5 forced audit failure propagates", threw && threw.code === "FORCED_AUDIT_FAILURE",
         threw ? threw.message : "no error thrown");

      // the packet UPDATE ran on the real connection before the audit threw, so
      // the connection now holds an uncommitted mutation — rollback to savepoint
      // is exactly what the adapter's catch→rollback does. Prove it erases the write.
      await client.query("rollback to savepoint before_issue");

      const row = (await client.query(
        `select status, tenant_token_hash, issue_actor_user_id, issue_idempotency_key, issued_at
           from lease_packets where id=$1`, [packet.id])).rows[0];
      ok("I5 status still draft after rollback", row.status === "draft", `got ${row.status}`);
      ok("I5 no token digest", row.tenant_token_hash === null);
      ok("I5 no issue_actor_user_id", row.issue_actor_user_id === null);
      ok("I5 no issue_idempotency_key", row.issue_idempotency_key === null);
      ok("I5 issued_at null", row.issued_at === null);
      const a = (await client.query(
        `select count(*)::int n from lease_packet_audit_events where lease_packet_id=$1 and event_type='packet_sent'`, [packet.id])).rows[0].n;
      ok("I5 no packet_sent audit persisted", a === 0, `got ${a}`);
    });

    // ── AUTHORITY & LIFECYCLE ───────────────────────────────────────
    console.log("\n── AUTHORITY & LIFECYCLE ──");

    // A1: cross-property actor refused (actor.property_id != application.property_id)
    await inTx(client, async () => {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { app } = await confirmTerms(client, app0);
      await expectCode("A1 cross-property generate → property_mismatch",
        () => generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor({ property_id: PROPERTY_B }), audit_context: ACTX }),
        "property_mismatch");
    });

    // A1b: unauthorized actor (not owner, wrong role, not managing) refused
    await inTx(client, async () => {
      const { app: app0 } = await buildFixture(client, { unit_id: prefl.spaceUnitId });
      const { app } = await confirmTerms(client, app0);
      await expectCode("A1b unauthorized actor → not_authorized_for_packet",
        () => generateTermsReviewPacket(client, { application_id: app.id,
          actor: actorFor({ user_id: "00000000-0000-0000-0000-000000000000", role: "leasing_agent", role_title: "leasing_agent" }),
          audit_context: ACTX }),
        "not_authorized_for_packet");
    });

    // A2: tenant_in_progress → application_next = awaiting_acknowledgment
    // (proves the widened reader against the REAL applications.js resolver text)
    // NON-SKIPPABLE: this is demo-critical. If the applications module cannot be
    // constructed or applicationNext is absent, that is a FAILURE, not a skip.
    await inTx(client, async () => {
      const { app, packet } = await genPacket(client);
      await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "a2", audit_context: ACTX });
      // model the tenant completing one field: flip to tenant_in_progress
      await client.query(`update lease_packets set status='tenant_in_progress' where id=$1`, [packet.id]);
      // load the real applicationNext via the applications module's _service
      // (closure-bound, exposed on router._service — same pattern as leasepackets)
      let appNext = null, constructErr = null;
      try {
        const appsRouter = require("../../applications")({ pool,
          satisfyObligation: async () => { throw new Error("unexpected satisfyObligation"); },
          completeObligation: async () => { throw new Error("unexpected completeObligation"); },
          spawnObligationFromEvent: async () => { throw new Error("unexpected spawn"); } });
        appNext = appsRouter && appsRouter._service && appsRouter._service.applicationNext;
      } catch (e) { constructErr = e.message; }
      ok("A2 applications module constructs + exposes applicationNext",
         typeof appNext === "function", constructErr || "applicationNext not on _service");
      if (typeof appNext === "function") {
        const gate = { gate_kind: "terms_review", obligation_status: "in_progress",
          packet: { id: packet.id, version: packet.version, status: "tenant_in_progress" } };
        const next = appNext((await client.query(`select * from lease_applications where id=$1`, [app.id])).rows[0], gate);
        ok("A2 tenant_in_progress → awaiting_acknowledgment", next.action_code === "awaiting_acknowledgment", `got ${next.action_code}`);
      } else {
        ok("A2 tenant_in_progress → awaiting_acknowledgment", false, "resolver unavailable — cannot prove demo-critical NEXT");
      }
    });

    // A3: tenant_in_progress cannot regenerate or reissue
    await inTx(client, async () => {
      const { app, packet } = await genPacket(client);
      await issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "a3", audit_context: ACTX });
      await client.query(`update lease_packets set status='tenant_in_progress' where id=$1`, [packet.id]);
      await expectCode("A3 regenerate on tenant_in_progress → packet_immutable",
        () => generateTermsReviewPacket(client, { application_id: app.id, actor: actorFor(), audit_context: ACTX }),
        "packet_immutable");
      await expectCode("A3 reissue on tenant_in_progress (already issued) → packet_link_already_issued",
        () => issueTermsReviewPacketLink(client, { packet_id: packet.id, actor: actorFor(), expires_days: 14, idempotency_key: "a3b", audit_context: ACTX }),
        "packet_link_already_issued");
    });

  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { console.log("  FAILURES: " + FAILURES.join("; ")); process.exit(1); }
  console.log("  ALL PASS — packet services proven against production schema (rolled back).");
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
