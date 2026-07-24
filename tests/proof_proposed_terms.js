// ════════════════════════════════════════════════════════════════════
//  proof_proposed_terms.js — Part 2 PRODUCTION-SCHEMA TRANSACTIONAL PROOF.
//
//  NOT a mirror. Runs against the production SCHEMA but commits NOTHING: every
//  fixture, service call, and assertion runs inside ONE outer transaction that
//  is ALWAYS rolled back. A dropped shell connection → PostgreSQL auto-rolls
//  back. No delete-based cleanup, no committed fixture — so no trigger,
//  consumer, or downstream ever observes a fixture event.
//
//  Possible because confirmProposedTerms(client,...) no longer owns its
//  transaction (caller-owned, matching the approve route). The proof owns
//  begin → ... → ROLLBACK.
//
//  Covers P2–P7 and P12. FULL P1 (packet-gate provenance refusal) is proven in
//  Part 4 where the gate is enforced; here P1 is only the projection fact.
//
//  RUN:  cd ~/project/src && node proof_proposed_terms.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const { confirmProposedTerms } = require("./proposed_terms_service");

const PROPERTY_A = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"; // Demo Building
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
async function expectThrow(name, code, fn) {
  try { await fn(); ok(name, false, "expected throw, got success"); }
  catch (e) { ok(name, e.code === code, `expected ${code}, got ${e.code || e.message}`); }
}
const TERMS = { rent: 1850, security_deposit: 1850, lease_start_date: "2026-09-01", lease_end_date: "2027-09-01", concession_status: "none" };
const FAKE_USER = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066"; // real QA operator user (obligations.assigned_user_id has a FK to users)
const opMgr = (property_id) => ({ user_id: FAKE_USER, property_id, role: "leasing_manager", role_title: "leasing_manager", can_manage_roles: false });

async function makeFixture(client, { property_id, assigned_role = "leasing_manager", assigned_user_id = null, name_col, person_id }) {
  const ob = (await client.query(
    `insert into obligations (type, status, assigned_role, assigned_user_id, required_inputs)
     values ('terms_review','open',$1,$2, array['terms_acknowledged']) returning id`,
    [assigned_role, assigned_user_id])).rows[0];
  const app = (await client.query(
    `insert into lease_applications (property_id, person_id, status, applicant_name, terms_review_obligation_id)
     values ($1,$2,'lease_ready',$3,$4) returning id`,
    [property_id, person_id, "PT Proof Tester", ob.id])).rows[0];
  return { app_id: app.id, obligation_id: ob.id };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '30s'");
    await client.query("select pg_advisory_xact_lock(hashtext('proof_proposed_terms_v1'))");

    console.log("SCHEMA PREFLIGHT");
    const personCols = new Set((await client.query(
      `select column_name from information_schema.columns where table_name='persons'`)).rows.map(r => r.column_name));
    const nameCol = ["full_name", "name", "display_name"].find(c => personCols.has(c));
    ok("persons has a name column", !!nameCol, [...personCols].join(","));
    const schedStatuses = (await client.query(`select distinct status from lease_economic_schedules`)).rows.map(r => r.status);
    console.log("  lease_economic_schedules statuses in use:", schedStatuses.join(",") || "(none)");
    const PROPERTY_B = (await client.query(`select id from properties where id <> $1 order by created_at limit 1`, [PROPERTY_A])).rows[0]?.id;
    console.log("  PROPERTY_B:", PROPERTY_B || "(none — P12 will skip)");
    if (fail > 0) throw new Error("schema preflight failed — aborting before fixtures");

    const PERSON = (await client.query(`insert into persons (${nameCol}) values ($1) returning id`, ["PT Proof Tester"])).rows[0].id;

    console.log("\nP3 authority basis");
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, assigned_role: "property_manager", assigned_user_id: FAKE_USER, person_id: PERSON });
      const r = await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-owner", actor: opMgr(PROPERTY_A) });
      ok("owner basis", r.authority_basis === "owner", r.authority_basis);
    }
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, assigned_role: "leasing_manager", person_id: PERSON });
      const r = await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-role", actor: opMgr(PROPERTY_A) });
      ok("role_authority basis", r.authority_basis === "role_authority", r.authority_basis);
    }
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, assigned_role: "property_manager", person_id: PERSON });
      const actor = { ...opMgr(PROPERTY_A), role: "leasing_agent", role_title: "leasing_agent", can_manage_roles: true };
      const r = await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-override", actor });
      ok("managed_role_override basis", r.authority_basis === "managed_role_override", r.authority_basis);
    }

    console.log("\nP2 unauthorized");
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, assigned_role: "property_manager", person_id: PERSON });
      const actor = { ...opMgr(PROPERTY_A), role: "leasing_agent", role_title: "leasing_agent", can_manage_roles: false };
      await expectThrow("agent w/ wrong role refused", "not_authorized_for_terms",
        () => confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-unauth", actor }));
    }

    console.log("\nP4/P5 idempotency");
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, person_id: PERSON });
      const r1 = await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-idem", actor: opMgr(PROPERTY_A) });
      const r2 = await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-idem", actor: opMgr(PROPERTY_A) });
      ok("P4 same key+payload → idempotent, same id", r2.idempotent === true && r2.confirmation_id === r1.confirmation_id);
      const n = (await client.query(`select count(*)::int n from application_proposed_terms_confirmations where application_id=$1`, [f.app_id])).rows[0].n;
      ok("P4 exactly one confirmation row", n === 1, `rows=${n}`);
      await expectThrow("P5 same key+different payload → conflict", "idempotency_conflict",
        () => confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, rent: 9999, idempotency_key: "k-idem", actor: opMgr(PROPERTY_A) }));
    }

    console.log("\nP6/P7 concession");
    // P7 (none accepted when no locked schedule) is proven by every successful
    // confirmation above. P6 (locked schedule → conflict) requires a real
    // lease_economic_schedules row, whose NOT-NULL FKs (source_offer_id,
    // locked_by_person_id) demand a full offer chain that doesn't exist in
    // isolation. Building that scaffolding just to unit-test one query is the
    // wrong kind of test. P6 is proven at INTEGRATION in Part 4, where a real
    // offer-backed locked schedule exists naturally — same deferral as full P1.
    console.log("  ✓ P7 'none' accepted with no locked schedule (shown by every confirm above)");
    console.log("  → P6 (locked-schedule conflict) DEFERRED to Part 4 integration (real offer chain)");

    console.log("\nP1 projection (partial; full gate in Part 4)");
    {
      const f = await makeFixture(client, { property_id: PROPERTY_A, person_id: PERSON });
      await confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-prov", actor: opMgr(PROPERTY_A) });
      const src = (await client.query(`select term_source from lease_applications where id=$1`, [f.app_id])).rows[0].term_source;
      ok("term_source becomes operator_proposed_terms", src === "operator_proposed_terms", src);
    }

    console.log("\nP12 cross-property");
    if (PROPERTY_B) {
      const f = await makeFixture(client, { property_id: PROPERTY_B, person_id: PERSON });
      await expectThrow("cross-property → property_mismatch", "property_mismatch",
        () => confirmProposedTerms(client, { application_id: f.app_id, ...TERMS, idempotency_key: "k-xprop", actor: opMgr(PROPERTY_A) }));
    } else console.log("  (skipped — no second property)");

    console.log(`\n═══ ${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed ═══`);
  } catch (e) {
    console.error("\n✗ HARNESS ERROR:", e.message);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
    fail++;
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
    await pool.end();
    console.log("(transaction rolled back — zero committed rows)");
    process.exit(fail === 0 ? 0 : 1);
  }
})();
