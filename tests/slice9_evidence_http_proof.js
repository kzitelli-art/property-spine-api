// ════════════════════════════════════════════════════════════════════
//  slice9_evidence_http_proof.js — THE FROZEN EVIDENCE API, THROUGH THE
//  REAL SERVER.
//
//  Boots the ACTUAL server.js as a child process and calls the canonical
//  GET /operator/pricing/evidence with real staff sessions — requireOperator
//  and requireLeasingModuleAccess exactly as deployed. No express re-mount, no
//  route copy.
//
//  DB DISCIPLINE: fixtures COMMIT (the server uses its own pool), so this runs
//  only against a disposable harness database.
//
//  Run: HARNESS_DATABASE_URL=... node tests/slice9_evidence_http_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");

const CONN = process.env.HARNESS_DATABASE_URL;
if (!CONN) { console.error("FATAL: HARNESS_DATABASE_URL required (fixtures COMMIT)."); process.exit(1); }
if (process.env.DATABASE_URL && CONN === process.env.DATABASE_URL) {
  console.error("FATAL: HARNESS_DATABASE_URL must differ from DATABASE_URL."); process.exit(1);
}

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const TAG = "s9ev" + Math.floor(Math.random() * 1e6);
const PORT = 3400 + Math.floor(Math.random() * 200);

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(REPO, "src/identity/staff_session_service.js"));
  let child = null;
  try {
    // ── FIXTURE (committed) ───────────────────────────────────────────
    const c = await pool.connect();
    let F = {};
    try {
      await c.query("begin");
      const one = async (q, a = []) => (await c.query(q, a)).rows[0];
      //  A: fully RESOLVED data. B: EMPTY. C: PENDING (partial).
      const A = (await one(`insert into properties (name, operating_timezone) values ($1,'America/New_York') returning id`, [TAG + "-A"])).id;
      const B = (await one(`insert into properties (name, operating_timezone) values ($1,'America/New_York') returning id`, [TAG + "-B"])).id;
      const C = (await one(`insert into properties (name, operating_timezone) values ($1,'America/New_York') returning id`, [TAG + "-C"])).id;
      const mkUser = async (n) => (await one(
        `insert into users (name,email,phone,role,is_active,status)
         values ($1,$2,$3,'property_manager',true,'active') returning id`,
        [n, `${n}@${TAG}.test`, "+1724777" + Math.floor(Math.random() * 9000 + 1000)])).id;
      const uA = await mkUser(TAG + "-uA"), uB = await mkUser(TAG + "-uB"),
            uC = await mkUser(TAG + "-uC"), uNoLease = await mkUser(TAG + "-uNoLease"),
            host = await mkUser(TAG + "-host");
      const assign = (u, p, m) => c.query(
        `insert into property_team_assignments
          (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
         values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, u, m]);
      await assign(uA, A, ["leasing"]); await assign(uB, B, ["leasing"]);
      await assign(uC, C, ["leasing"]); await assign(uNoLease, A, ["maintenance"]);

      const seed = async (prop, { resolved }) => {
        const person = (await one(`insert into persons (name, lifecycle_status) values ($1,'lead') returning id`,
          [`${TAG}-${resolved ? "resolved" : "pending"}-person`])).id;
        const lead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
          values ($1,$2,'new','2026-08-05T12:00:00Z') returning id`, [person, prop])).id;
        const opp = (await one(
          `insert into leasing_conversions (person_id,property_id,lead_id,status,current_stage,opened_at,
             actual_tour_host_user_id, conversation_owner_user_id)
           values ($1,$2,$3,'active','touring','2026-08-05T12:00:00Z',$4,$4) returning id`,
          [person, prop, lead, host])).id;
        if (resolved) {
          await c.query(`insert into leasing_tours (lead_id, property_id, leasing_agent_id,
              scheduled_for, status, completed_at, conversion_id)
            values ($1,$2,$3,'2026-08-08T15:00:00Z','completed','2026-08-08T15:00:00Z',$4)`,
            [lead, prop, host, opp]);
          await c.query(`insert into lease_applications (property_id, person_id, conversion_id, status,
              created_at, submitted_at, approved_at)
            values ($1,$2,$3,'approved','2026-08-10T12:00:00Z','2026-08-10T12:00:00Z','2026-08-12T12:00:00Z')`,
            [prop, person, opp]);
        } else {
          await c.query(`insert into leasing_tours (lead_id, property_id, leasing_agent_id,
              scheduled_for, status, conversion_id)
            values ($1,$2,$3,'2026-10-01T15:00:00Z','scheduled',$4)`, [lead, prop, host, opp]);
        }
        return { person, lead, opp };
      };
      F.a = await seed(A, { resolved: true });
      F.c = await seed(C, { resolved: false });
      await c.query("commit");
      Object.assign(F, { A, B, C, uA, uB, uC, uNoLease });
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }

    // ── BOOT THE REAL SERVER ──────────────────────────────────────────
    child = spawn("node", ["server.js"], {
      cwd: REPO, env: { ...process.env, DATABASE_URL: CONN, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("server did not listen in 20s")), 20000);
      child.stdout.on("data", (d) => { if (/listening/i.test(String(d))) { clearTimeout(to); resolve(); } });
      child.stderr.on("data", () => {});
      child.on("exit", (code) => reject(new Error("server exited " + code)));
    });
    console.log(`  (REAL server.js on :${PORT}, real Postgres, real sessions)`);

    const mkSession = async (u, p) => {
      const cc = await pool.connect();
      try { await cc.query("begin");
        const s = await svc.issueStaffSession(cc, { userId: u, propertyId: p, purpose: "sms_otp" });
        await cc.query("commit"); return s.session_token;
      } finally { cc.release(); }
    };
    const tokA = await mkSession(F.uA, F.A), tokB = await mkSession(F.uB, F.B),
          tokC = await mkSession(F.uC, F.C), tokNoLease = await mkSession(F.uNoLease, F.A);

    const GET = async (qs, token) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/operator/pricing/evidence${qs || ""}`, {
        headers: token ? { "x-staff-session": token } : {} });
      let json = null; try { json = await r.json(); } catch (_) {}
      return { status: r.status, json, raw: JSON.stringify(json) };
    };
    const WINDOW = "?start_local=2026-08-01&end_local=2026-08-31&as_of=2026-09-15T00:00:00Z";

    console.log("\n── AUTHORITY ────────────────────────────────────────────");
    ok((await GET(WINDOW, null)).status === 401, "unauthenticated → 401");
    ok((await GET(WINDOW, tokNoLease)).status === 403, "missing leasing module → 403");
    const rB = await GET(WINDOW + "&property_id=" + F.A, tokB);
    ok(rB.status === 200 && String(rB.json.property_id) === String(F.B),
      "property scope is SERVER-DERIVED — a client property_id cannot select another property");
    ok(!rB.raw.includes(String(F.a.opp)) && !rB.raw.includes(TAG + "-resolved-person"),
      "and nothing of property A leaks into B's response");

    console.log("\n── THE FROZEN CONTRACT SHAPE ────────────────────────────");
    const rA = await GET(WINDOW, tokA);
    ok(rA.json.contract && rA.json.contract.version === "market_evidence_v2",
      `contract block with version (${rA.json.contract && rA.json.contract.version})`);
    for (const f of ["property_id", "window", "as_of_utc", "generated_at", "state", "coverage"]) {
      ok(f in rA.json, `top-level '${f}' present`);
    }
    ok(rA.json.sections.conversion.contracts
       && rA.json.sections.conversion.contracts.f1.contract_version === "c1",
      "the four frozen funnel contracts ride the response");
    ok(rA.json.coverage.source_attribution
       && rA.json.coverage.source_attribution.basis === "originating_lead_source",
      "the source-attribution basis is a top-level coverage fact");
    ok(JSON.stringify(rA.json.contract.response_states)
       === JSON.stringify(["ok", "partial", "empty", "unavailable", "error"]),
      "one state vocabulary is declared on the wire");

    console.log("\n── COMPLETE · PARTIAL · EMPTY ───────────────────────────");
    ok(rA.json.state === "ok", `resolved evidence ⇒ state ok (${rA.json.state})`);
    const m = rA.json.sections.conversion.metrics;
    ok(m.f1all.rate === 1 && m.f2.rate === 1, "with real rates published");
    ok(m.f3.numerator === 1 && m.f3.denominator === 1,
      "f3 cohorts on durable submitted_at through real HTTP");
    const rC = await GET(WINDOW, tokC);
    ok(rC.json.state === "partial", `pending evidence ⇒ state partial (${rC.json.state})`);
    ok(rC.json.sections.conversion.metrics.f1all.rate === null,
      "with the affected rate suppressed");
    ok(rC.json.coverage.funnels.f1all.suppression_reason !== null,
      "and the suppression reason on the wire");
    const rEmpty = await GET(WINDOW, tokB);
    ok(rEmpty.json.state === "empty", `an empty property ⇒ state empty (${rEmpty.json.state})`);
    ok(["f1all", "f2", "f3", "f4"].every((k) =>
        rEmpty.json.sections.conversion.metrics[k].state === "empty"
        && rEmpty.json.sections.conversion.metrics[k].rate === null),
      "all four funnels: zero denominator ⇒ empty, rate null — never 0%");
    ok(!/sample|demo|fixture/i.test(rEmpty.json.sections.conversion.state || "") &&
       rEmpty.json.sections.conversion.supporting_rows.total_rows === 0,
      "no fixture fallback — an empty property is an HONEST empty, not sample data");

    console.log("\n── BOUNDED TRANSPORT ────────────────────────────────────");
    const sr = rA.json.sections.conversion.supporting_rows;
    ok(sr.default_page_size === 100 && sr.max_page_size === 250,
      "the frozen page sizes travel on the wire (100 default, 250 max)");
    ok(sr.page.length <= 100 && sr.total_rows >= sr.page.length,
      `one bounded first page with a total count (${sr.page.length} of ${sr.total_rows})`);
    ok(/opened_at asc, opportunity_id asc/.test(sr.sort),
      "the sort is server-authored and deterministic");
    ok(!!sr.as_of_utc && /own as_of/.test(sr.snapshot_note),
      "each page carries its own as_of and does NOT claim a cross-request snapshot");
    const rLim = await GET(WINDOW + "&limit=9999", tokA);
    ok(rLim.json.sections.conversion.supporting_rows.page.length <= 250,
      "a client cannot exceed the hard maximum of 250");
    const rFilt = await GET(WINDOW + "&evidence_state=observed_visit", tokA);
    const srF = rFilt.json.sections.conversion.supporting_rows;
    ok(srF.filters.evidence_state === "observed_visit"
       && srF.page.every((r) => r.appointment_evidence_state === "observed_visit"),
      "server-side filtering — the browser never loads the full population to filter");
    ok(srF.total_matching <= srF.total_rows, "with the matching total stated");

    console.log("\n── WINDOWS AND STABLE as_of ─────────────────────────────");
    const rDefault = await GET("", tokA);
    ok(rDefault.status === 200 && rDefault.json.window.start_local !== null,
      "the standard window (no params) resolves property-locally");
    const again = await GET(WINDOW, tokA);
    const strip = (j) => { const { generated_at, ...rest } = j; return JSON.stringify(rest); };
    ok(strip(again.json) === strip(rA.json),
      "two reads at one as_of are identical apart from generated_at");
    ok(rA.json.as_of_utc === "2026-09-15T00:00:00.000Z"
       || rA.json.as_of_utc === "2026-09-15T00:00:00Z",
      `the server-authored as_of governs the response (${rA.json.as_of_utc})`);

    console.log("\n── REASON CODES ON THE WIRE ─────────────────────────────");
    const ct = rA.json.sections.conversion.contracts;
    ok(/attribution|chain|duplicate/i.test(ct.f2.conflict_conditions)
       && /cycle|parents outside|without exact attribution/i.test(ct.f2.untrackable_conditions),
      "conflict and untrackable conditions are stated as concrete contract text");
    ok(["f1","f2","f3","f4"].every((k) => !/same as f\d/i.test(JSON.stringify(ct[k]))),
      "every contract is self-contained — no field defers to another funnel's");
    ok(/never 0%/.test(ct.f1.zero_denominator_rule), "the zero-denominator rule travels with the data");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    if (child) child.kill("SIGKILL");
    await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   evidence HTTP: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
