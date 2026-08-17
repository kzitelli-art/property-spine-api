/* ════════════════════════════════════════════════════════════════════
   forward_leasing_http.db.js — THE FORWARD LEASING ROUTE, FOR REAL.
   REAL server.js · REAL Postgres · REAL session · REAL socket.

     GET /operator/leasing/positions-for-period
         ?requested_start=&requested_end=

   Boots the actual server.js against the harness database rather than
   mounting a router by hand, because the route's authority comes from
   middleware the mount order supplies — requireOperator, the leasing
   module gate, and the server-derived property. A hand-mounted router
   proves the handler and not the door.

   ── WHAT THIS ROUTE MAY NEVER DO ────────────────────────────────────
   Default the interval. There is no "today", no "today for one day" and
   no implied school year: each is a second time model smuggled in as a
   convenience, and the one-day default would re-offer the 91 committed
   beds Slice 2 exists to exclude. Both dates are required and a missing
   one is refused with a sentence naming which.

   And it may never claim marketability. It answers the contractual
   question only; readiness, turnover, possession and out-of-service are
   availability_read's answer and composing them is a deliberate later
   step — NOT an AND, because availability answers "marketable NOW".

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spine_full \
       node tests/forward_leasing_http.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const path = require("path");

const API_REPO = path.join(__dirname, "..");
const PORT = Number(process.env.API_PORT || 3041);

let pass = 0, fail = 0, ran = 0; const failures = [];
function ok(l, c, d) {
  ran++;
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
}
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");

function get(path_, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: path_, method: "GET",
      headers: headers || {} }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) { /* stated by the test */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function startApi() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: API_REPO,
      env: { ...process.env, DATABASE_URL: CONN, PORT: String(PORT), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b) => { out += String(b); if (/listening|running|port/i.test(out)) resolve(child); });
    child.stderr.on("data", (b) => { out += String(b); });
    child.on("exit", (c) => reject(new Error(`server.js exited ${c}\n${out.slice(-1200)}`)));
    setTimeout(() => (out ? resolve(child) : reject(new Error("server.js never started\n" + out))), 20000);
  });
}

receipt.begin(__filename, { url: CONN, expected: 20 });

(async () => {
  const pool = new Pool({ connectionString: CONN });
  //  Reuse the property the interval DB proof established — 72 units, 160
  //  beds, from the real 07/31 export. This harness proves the DOOR, not
  //  the loading; re-importing the workbook here would prove it twice.
  const prop = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id
      where o.name='Interval Positions' and p.name like 'Skyline%' limit 1`)).rows[0];
  if (!prop) {
    console.error("\n  REFUSED: run tests/interval_positions.db.js first — this harness reads the");
    console.error("  property it establishes, rather than importing the workbook a second time.\n");
    process.exit(2);
  }
  const P = prop.id;
  const other = (await pool.query(
    `select id from properties where id <> $1 limit 1`, [P])).rows[0].id;

  await pool.query(`delete from users where email like 'fwd-leasing-%@test'`);
  async function operator(email, modules) {
    const uid = (await pool.query(
      `insert into users (name,email,role,account_kind) values ($1,$2,'property_manager','human_staff') returning id`,
      [email, email])).rows[0].id;
    await pool.query(
      `insert into property_team_assignments (property_id,user_id,role_title,allowed_modules,active)
       values ($1,$2,'Operator',$3::text[],true)`, [P, uid, modules]);
    const token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      `insert into staff_sessions (user_id,property_id,token_digest,issuance_purpose,expires_at)
       values ($1,$2,$3,'bootstrap_invite',now() + interval '1 hour')`,
      [uid, P, digest(Buffer.from(token))]);
    return token;
  }
  const leasing = await operator("fwd-leasing-ok@test", ["leasing"]);
  const noLeasing = await operator("fwd-leasing-none@test", ["maintenance"]);

  const api = await startApi();
  const ROUTE = "/operator/leasing/positions-for-period";
  const TERM = "requested_start=2026-08-01&requested_end=2027-07-31";

  try {
    console.log("\n  ── the door ──");
    {
      const r = await get(`${ROUTE}?${TERM}`);
      ok("F1  no session is 401, never an empty term", r.status === 401, `${r.status} ${r.raw.slice(0, 120)}`);
    }
    {
      const r = await get(`${ROUTE}?${TERM}`, { "x-staff-session": noLeasing });
      ok("F2  an operator without the leasing module is refused",
        r.status === 401 || r.status === 403, `${r.status} ${r.raw.slice(0, 140)}`);
    }

    console.log("\n  ── the interval is REQUIRED, and refused honestly ──");
    for (const [label, qs, code] of [
      ["neither date", "", "interval_required"],
      ["only a start", "requested_start=2026-08-01", "interval_required"],
      ["only an end", "requested_end=2027-07-31", "interval_required"],
      ["an empty start", "requested_start=&requested_end=2027-07-31", "interval_required"],
    ]) {
      const r = await get(`${ROUTE}?${qs}`, { "x-staff-session": leasing });
      ok(`F3  ${label} → 400 ${code}`,
        r.status === 400 && r.json && r.json.code === code,
        `${r.status} ${JSON.stringify(r.json)}`);
    }
    {
      //  The refusal must NAME which date it could not read. "Invalid
      //  request" makes an operator guess, and a refusal a user can see is
      //  product copy.
      const r = await get(`${ROUTE}?requested_start=2026-08-01`, { "x-staff-session": leasing });
      ok("F4  …and the refusal names WHICH date is missing",
        /requested_end/.test(r.json.error || ""), r.json && r.json.error);
    }
    for (const [label, qs] of [
      ["a non-ISO date", "requested_start=08/01/2026&requested_end=2027-07-31"],
      ["a date that does not exist", "requested_start=2026-02-30&requested_end=2027-07-31"],
      ["junk", "requested_start=soon&requested_end=later"],
    ]) {
      const r = await get(`${ROUTE}?${qs}`, { "x-staff-session": leasing });
      ok(`F5  ${label} → 400 invalid_interval_date`,
        r.status === 400 && r.json && r.json.code === "invalid_interval_date",
        `${r.status} ${JSON.stringify(r.json)}`);
    }
    {
      const r = await get(`${ROUTE}?requested_start=2027-07-31&requested_end=2026-08-01`,
        { "x-staff-session": leasing });
      ok("F6  an inverted term → 400 invalid_interval",
        r.status === 400 && r.json && r.json.code === "invalid_interval",
        `${r.status} ${JSON.stringify(r.json)}`);
    }

    console.log("\n  ── the answer, over the wire ──");
    const r = await get(`${ROUTE}?${TERM}`, { "x-staff-session": leasing });
    ok("F7  200 for an entitled operator with a real term", r.status === 200, `${r.status}`);
    ok("F8  the property is the SESSION's, echoed back",
      String(r.json.property_id) === String(P), r.json && r.json.property_id);
    ok("F9  the term is echoed, so an answer is never orphaned from its question",
      r.json.requested_start === "2026-08-01" && r.json.requested_end === "2027-07-31",
      JSON.stringify({ s: r.json.requested_start, e: r.json.requested_end }));
    //  KEYS ARE A CONTRACT. A rename sweep broke one of these before and
    //  only a browser caught it.
    ok("F10 totals.contractually_free is present by name and is the real 32",
      r.json.totals && r.json.totals.contractually_free === 32,
      JSON.stringify(r.json.totals));
    ok("F11 …with the other three states beside it",
      ["term_blocked", "term_partially_blocked", "unresolved", "units"]
        .every((k) => Number.isInteger(r.json.totals[k])), JSON.stringify(r.json.totals));
    ok("F12 the whole building came back", r.json.count === 160, String(r.json.count));
    ok("F13 every position carries its state and its identity",
      r.json.positions.every((p) => p.space_id && p.unit_number && p.interval_state),
      JSON.stringify(r.json.positions[0] || {}).slice(0, 160));
    ok("F14 a conflicted position names the rights that took it, with proof basis",
      r.json.positions.filter((p) => p.interval_state !== "contractually_free")
        .every((p) => p.colliding_rights.length > 0
          && p.colliding_rights.every((c) => c.lease_id && c.proof_basis)));
    ok("F15 free spans travel with the partially conflicted ones",
      r.json.positions.filter((p) => p.interval_state === "term_partially_blocked")
        .every((p) => Array.isArray(p.free_spans) && p.free_spans.length > 0));
    //  THE LINE, ON THE WIRE.
    ok("F16 no position carries a marketability verdict",
      r.json.positions.every((p) =>
        !("marketing_state" in p) && !("marketable" in p) && !("available" in p)
        && !("physical_readiness" in p)),
      JSON.stringify(Object.keys(r.json.positions[0])));
    ok("F17 …and the payload says out loud that marketability is not its answer",
      Array.isArray(r.json.does_not_establish)
      && r.json.does_not_establish.some((s) => /marketed, shown or offered/i.test(s)),
      JSON.stringify(r.json.does_not_establish));
    ok("F18 is_down is carried BESIDE the answer, never folded into it",
      r.json.positions.every((p) => typeof p.is_down === "boolean"));

    console.log("\n  ── it is the term being asked about ──");
    const later = await get(
      `${ROUTE}?requested_start=2027-09-01&requested_end=2028-07-31`, { "x-staff-session": leasing });
    ok("F19 a different term is a different answer from the same door",
      later.status === 200 && later.json.totals.contractually_free === 160,
      String(later.json.totals && later.json.totals.contractually_free));
    console.log(`        2026-08-01 → 2027-07-31   ${r.json.totals.contractually_free} of 160 can support the whole term`);
    console.log(`        2027-09-01 → 2028-07-31   ${later.json.totals.contractually_free} of 160`);

    //  §21. The browser may REQUEST; it may not determine authority.
    const spoof = await get(`${ROUTE}?${TERM}&property_id=${other}`, { "x-staff-session": leasing });
    ok("F20 a client-supplied property_id does NOT change the scope",
      spoof.status === 200 && String(spoof.json.property_id) === String(P),
      `${spoof.status} ${spoof.json && spoof.json.property_id}`);
    ok("F21 …and returns the session property's own inventory, not the other's",
      spoof.json.count === 160, String(spoof.json.count));
  } finally {
    api.kill("SIGKILL");
    await pool.query(`delete from users where email like 'fwd-leasing-%@test'`).catch(() => {});
    await pool.end();
  }

  console.log("");
  process.exit(receipt.complete({ harness: __filename, passed: pass, failed: fail, expectedAtLeast: 20 }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(__filename, e, ran));
});
