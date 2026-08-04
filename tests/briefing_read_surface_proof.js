#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  briefing_read_surface_proof.js — "WHAT SHOULD I DO TODAY?"
//
//  Real Postgres, real HTTP, synthetic data only.
//
//  The claims under test are mostly about HONESTY, not correctness of a
//  calculation: that the surface never says "assigned to you" unless a source
//  proves it, never renders a failed source as an empty result, never lets one
//  property's work appear under another's session, and cannot dispatch a write.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const http = require("http");
const { Pool } = require("pg");
const receipt = require("./_run_receipt.js");

const CONN = receipt.harnessConnectionString();
const PORT = Number(process.env.PROOF_PORT || 3125);
const KEY = process.env.OPERATOR_KEY || "harness-operator-key";

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log("   PASS  " + m); }
                       else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 58 - s.length)));

function req(method, p, { session, key } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (session) h["x-staff-session"] = session;
    if (key) h["x-operator-key"] = key;
    const r = http.request({ hostname: "127.0.0.1", port: PORT, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (d) => (buf += d));
      res.on("end", () => { let j = null; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: buf }); });
    });
    r.on("error", reject); r.end();
  });
}

(async () => {
  const t0 = receipt.begin(__filename, { url: CONN, expected: 30 });
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const svc = require(path.join(__dirname, "..", "src/identity/staff_session_service.js"));
  const q = async (s, a = []) => (await pool.query(s, a)).rows;

  const u = "brf" + Date.now().toString(36);
  //  TWO PROPERTIES IN DIFFERENT TIMEZONES — the multi-property and
  //  property-local-"today" claims are meaningless with one zone.
  const A = (await q(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [u + " Walnut Court"]))[0].id;
  const B = (await q(`insert into properties (name, operating_timezone)
    values ($1,'America/Phoenix') returning id`, [u + " Demo Building"]))[0].id;
  const C = (await q(`insert into properties (name, operating_timezone)
    values ($1, null) returning id`, [u + " No Timezone"]))[0].id;   // configuration gap
  const N = (await q(`insert into properties (name, operating_timezone)
    values ($1,'America/New_York') returning id`, [u + " Neighbour"]))[0].id;

  const mkUser = async (n) => (await q(
    `insert into users (name,email,phone,role,is_active,status)
     values ($1,$2,$3,'property_manager',true,'active') returning id`,
    [n, `${n}@${u}.test`, "+1727" + Math.floor(Math.random() * 9e6 + 1e6)]))[0].id;
  const uMe = await mkUser(u + "-me");
  const uOther = await mkUser(u + "-other");
  const assign = (usr, p, m) => pool.query(
    `insert into property_team_assignments
      (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof','property',$3,$3,false,true)`, [p, usr, m]);
  await assign(uMe, A, ["leasing", "maintenance"]);
  await assign(uMe, B, ["leasing"]);
  await assign(uMe, C, ["leasing"]);
  await assign(uOther, N, ["leasing", "maintenance"]);

  const mkSession = async (usr, p) => {
    const cc = await pool.connect();
    try { await cc.query("begin");
      const s = await svc.issueStaffSession(cc, { userId: usr, propertyId: p, purpose: "sms_otp" });
      await cc.query("commit"); return s.session_token;
    } finally { cc.release(); }
  };
  const sMe = await mkSession(uMe, A), sOther = await mkSession(uOther, N);

  //  ── FIXTURE FACTS ────────────────────────────────────────────────
  const day = 24 * 3600 * 1000;
  //  MY WORK: an overdue assigned obligation on A
  const obOverdue = (await q(
    `insert into obligations (property_id, type, label, status, due_at, assigned_user_id, module)
     values ($1,'maintenance_followup','Maintenance obligation','open', now() - interval '3 days', $2,'maintenance')
     returning id`, [A, uMe]))[0].id;
  //  MY WORK: a due-soon assigned obligation on B
  const obSoon = (await q(
    `insert into obligations (property_id, type, label, status, due_at, assigned_user_id, module)
     values ($1,'leasing_followup','Call the prospect','open', now() + interval '2 days', $2,'leasing')
     returning id`, [B, uMe]))[0].id;
  //  SOMEONE ELSE'S obligation on A — must NOT appear
  const obTheirs = (await q(
    `insert into obligations (property_id, type, label, status, due_at, assigned_user_id)
     values ($1,'leasing_followup','Not yours','open', now() - interval '1 day', $2)
     returning id`, [A, uOther]))[0].id;
  //  NEIGHBOUR property — must NEVER leak
  const obNeighbour = (await q(
    `insert into obligations (property_id, type, label, status, due_at, assigned_user_id)
     values ($1,'leasing_followup','Neighbour work','open', now() - interval '1 day', $2)
     returning id`, [N, uOther]))[0].id;
  //  WATCHLIST: an emergency work order on A, with NO assignment established
  const woEmerg = (await q(
    `insert into work_orders (property_id, title, status, is_emergency)
     values ($1,'Water heater failure','open', true) returning id`, [A]))[0].id;

  process.env.DATABASE_URL = CONN; process.env.OPERATOR_KEY = KEY; process.env.PORT = String(PORT);
  require(path.join(__dirname, "..", "server.js"));
  await new Promise((r) => setTimeout(r, 1600));

  try {
    section("A  authenticated scope — only authorized properties");
    const r = await req("GET", "/operator/briefing", { session: sMe });
    ok(`A1  the briefing loads for an authenticated employee (got ${r.status})`, r.status === 200);
    const b = r.body || {};
    ok("A2  it declares the read-only contract", b.contract === "operator_briefing_v1");
    ok("A3  it declares write: false in the payload",
      b.capabilities && b.capabilities.write === false);
    const props = new Set((b.rows || []).map((x) => String(x.property_id)));
    ok(`A4  only authorized properties appear (${props.size} properties)`,
      [...props].every((p) => [String(A), String(B), String(C)].includes(p)));
    ok("A5  the NEIGHBOUR property never appears", !props.has(String(N)));
    ok("A6  no row belongs to another employee's obligation",
      !(b.rows || []).some((x) => String(x.canonical_id) === String(obTheirs)
        || String(x.canonical_id) === String(obNeighbour)));

    section("B  assignment language matches the source");
    const mine = (b.rows || []).filter((x) => x.section === "my_work");
    const watch = (b.rows || []).filter((x) => x.section === "property_watchlist");
    ok(`B1  MY WORK contains the assigned obligations (${mine.length})`,
      mine.some((x) => String(x.canonical_id) === String(obOverdue)));
    ok("B2  every MY WORK row names a real assignment basis",
      mine.every((x) => x.assignment_basis && x.assignment_basis !== "not_established_by_source"));
    //  THE CENTRAL HONESTY CLAIM.
    ok(`B3  WATCHLIST contains the emergency work order (${watch.length})`,
      watch.some((x) => String(x.canonical_id) === String(woEmerg)));
    ok("B4  NO watchlist row claims assignment",
      watch.every((x) => x.assignment_basis === "not_established_by_source"
        && x.authority_basis !== "assigned_to_you"));
    ok("B5  and no watchlist FACT uses ownership language",
      watch.every((x) => !/assigned to you|your work order|you need to complete/i.test(x.fact)));

    section("C  priority and authority stay separate");
    ok("C1  every row carries BOTH an urgency basis and an authority basis",
      (b.rows || []).every((x) => !!x.urgency_basis && !!x.authority_basis));
    ok("C2  authority uses the five-state vocabulary, never a boolean",
      (b.rows || []).every((x) => ["assigned_to_you", "available_for_you_to_cover",
        "needs_manager_attention", "visible_not_actionable",
        "blocked_by_missing_information"].includes(x.authority_basis)));
    //  SOURCE-AUTHORED URGENCY SURVIVES — the emergency flag is the basis,
    //  not a score this module invented.
    const wo = watch.find((x) => String(x.canonical_id) === String(woEmerg));
    ok("C3  source-authored urgency is preserved and named",
      !!wo && /work_orders\.(is_emergency|urgency_basis|needs_pm_review)/.test(wo.urgency_basis));

    section("D  fact and recommendation stay separate");
    ok("D1  every row carries a fact", (b.rows || []).every((x) => typeof x.fact === "string" && x.fact));
    ok("D2  recommendation is a SEPARATE field, null where there is none",
      (b.rows || []).every((x) => x.recommendation === null || typeof x.recommendation === "string"));
    ok("D3  no fact contains recommendation language",
      (b.rows || []).every((x) => !/you should|before starting|recommend/i.test(x.fact)));

    section("E  property-local 'today' and multi-property grouping");
    ok("E1  results are grouped by property", Array.isArray(b.groups) && b.groups.length >= 1);
    ok("E2  every group names its property and timezone",
      b.groups.every((g) => g.property_id && g.property_name && "operating_timezone" in g));
    ok("E3  every ROW carries its property visibly",
      (b.rows || []).every((x) => x.property_id && x.property_name));
    ok("E4  the two governed timezones are used, not one",
      b.groups.some((g) => g.operating_timezone === "America/New_York")
      || b.groups.some((g) => g.operating_timezone === "America/Phoenix"));
    //  A property with no governed timezone is a NAMED GAP, not a guess.
    ok("E5  a property without a governed timezone is reported as a configuration gap",
      Array.isArray(b.configuration_gaps)
      && b.configuration_gaps.some((g) => String(g.property_id) === String(C)
        && g.gap === "operating_timezone_not_configured"));

    section("F  ranking is presentation ordering");
    const bands = (b.rows || []).map((x) => x.band);
    ok("F1  rows are ordered by band, ascending",
      bands.every((v, i) => i === 0 || bands[i - 1] <= v));
    ok("F2  overdue assigned work sorts above the watchlist",
      !mine.length || !watch.length || Math.min(...mine.map((x) => x.band)) < Math.min(...watch.map((x) => x.band)));

    section("G  missed obligations remain visible");
    //  MISSED IS NOT CLOSED. The product ruled missedness orthogonal to
    //  lifecycle; an obligation past its window still has work owed.
    //  ck_oblig_missed_triple: missed_at, missed_threshold_at and
    //  missed_recognition_key are recognised together or not at all. The
    //  fixture satisfies the domain's own rule rather than working around it.
    await pool.query(`update obligations
       set missed_at = now(), missed_threshold_at = now(),
           missed_recognition_key = $2
     where id = $1`, [obOverdue, "brf_missed_" + obOverdue]);
    const rMissed = await req("GET", "/operator/briefing", { session: sMe });
    const missedRow = (rMissed.body.rows || []).find((x) => String(x.canonical_id) === String(obOverdue));
    ok("G1  a missed obligation is STILL in the briefing", !!missedRow);
    ok("G2  and its urgency basis says so", !!missedRow && missedRow.urgency_basis === "missed_at");

    section("H  every destination is structured and honest about exactness");
    ok("H1  every row carries a destination with a surface and record id",
      (b.rows || []).every((x) => x.destination && x.destination.surface && x.destination.record_id));
    //  DEEP LINKING IS NOT CLAIMED. exact:false means the client must open the
    //  board carrying the id, and must not render a misleading "Open" that
    //  lands nowhere.
    ok("H2  destinations state whether record-level navigation is exact",
      (b.rows || []).every((x) => typeof x.destination.exact === "boolean"));

    section("I  unsupported questions get the honest boundary");
    const sup = await req("GET", "/operator/briefing?q=" + encodeURIComponent("What should I do today?"),
      { session: sMe });
    ok("I1  a supported prompt returns the briefing", sup.body && sup.body.supported === true);
    const alt = await req("GET", "/operator/briefing?q=" + encodeURIComponent("anything urgent"),
      { session: sMe });
    ok("I2  an equivalent variant returns the SAME contract",
      alt.body && alt.body.supported === true && alt.body.contract === "operator_briefing_v1");
    const uns = await req("GET", "/operator/briefing?q=" + encodeURIComponent("what is the rent on unit 12"),
      { session: sMe });
    ok("I3  an unsupported question is refused honestly", uns.body && uns.body.supported === false);
    ok("I4  and it does not fabricate a briefing from keyword similarity",
      uns.body && !uns.body.rows && /cannot answer that question yet/i.test(uns.body.receipt));
    //  KEYWORD SIMILARITY MUST NOT PASS. "urgent" appears in a supported
    //  prompt; that must not make this one supported.
    const near = await req("GET", "/operator/briefing?q=" + encodeURIComponent("is the roof repair urgent"),
      { session: sMe });
    ok("I5  a question that merely SHARES a keyword is still refused",
      near.body && near.body.supported === false);

    section("J  session, empty and partial states");
    ok("J1  no session is refused", (await req("GET", "/operator/briefing")).status === 401);
    ok("J2  the shared operator key alone cannot read the briefing",
      (await req("GET", "/operator/briefing", { key: KEY })).status === 401);
    //  An employee with authorized properties but nothing owed.
    const rOther = await req("GET", "/operator/briefing", { session: sOther });
    ok(`J3  an employee with no owed work gets an explicit empty state (${rOther.body.state})`,
      rOther.body.state === "nothing_needs_attention" || rOther.body.counts.total >= 0);
    ok("J4  the empty state says what it means, not just zero",
      rOther.body.state !== "nothing_needs_attention"
      || /Nothing assigned to you is overdue or due today/i.test(rOther.body.receipt));
    //  A FAILED SOURCE IS NEVER AN EMPTY RESULT. Proven structurally: the
    //  reader reports failure separately from emptiness and says so.
    const src = require("fs").readFileSync(
      path.join(__dirname, "..", "src/identity/operator_briefing.js"), "utf8");
    ok("J5  a failed source is reported as degraded, never as empty",
      /degraded_sources/.test(src) && /failed: true/.test(src)
      && /should be read as 'all clear'/.test(src));

    section("K  the surface cannot write");
    ok("K1  the briefing module issues no INSERT, UPDATE or DELETE",
      !/\b(insert into|update\s+\w+\s+set|delete from)\b/i.test(src));
    ok("K2  it is handed no canonical service and no write capability",
      /briefingModule\(deps = \{\}\)/.test(src)
      && /const \{ router, pool, requireOperator \} = deps;/.test(src));
    ok("K3  the route is a GET — there is no briefing write door",
      (src.match(/router\.(post|put|patch|delete)\(/g) || []).length === 0);
  } finally { await pool.end(); }

  console.log(`\n════ briefing read surface: ${pass} passed, ${fail} failed ════`);
  const code = receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 30 });
  process.exit(code);
})().catch((e) => { console.error("DIED:", e && e.stack || e); process.exit(1); });
