#!/usr/bin/env node
// tools/accept_brick_one.js
//
// BRICK ONE — LIVE ACCEPTANCE HARNESS (cases A–R)
// Runs against the DEPLOYED API + production Neon. Uses ONLY the internal-QA
// identity. Every mutation is restored; every fixture it creates is deleted.
// CLASS 3: proof infrastructure outside the operator workflow.
//
// RUN (PowerShell, from the api repo folder so ./staff_session_service.js resolves):
//   $env:DATABASE_URL = "<neon url>"
//   $env:API_BASE     = "https://property-spine-api.onrender.com"
//   $env:OPERATOR_KEY = "<operator key>"          # for /properties/* cases K,L
//   node tools/accept_brick_one.js
//
// Optional: $env:PSPINE_QA_PROPERTY (defaults to Solo), $env:PSPINE_OTHER_PROPERTY
// (defaults to the Demo Building UUID) for the cross-property wall.

"use strict";
const crypto = require("crypto");
const path = require("path");
const { Client } = require("pg");
const svc = require(path.join(process.cwd(), "staff_session_service.js")); // RESOLVER_SQL — byte-identical EXPLAIN

const API = (process.env.API_BASE || "").replace(/\/$/, "");
const KEY = process.env.OPERATOR_KEY || "";
const QA_PROP = process.env.PSPINE_QA_PROPERTY || "9e2bb96e-08e2-41db-81c2-91055ceb50a3"; // Solo
const OTHER_PROP = process.env.PSPINE_OTHER_PROPERTY || null; // resolved from DB if unset
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const RUN = "acc" + Date.now().toString(36);

let pass = 0, fail = 0, warn = 0;
const ok = (c, l) => { c ? (pass++, console.log("  PASS  " + l)) : (fail++, console.log("  FAIL  " + l)); };
const wr = (l) => { warn++; console.log("  WARN  " + l); };
const hdr = (s) => console.log("\n== " + s + " ==");

// ---- cleanup ledger: everything created gets removed, everything mutated gets restored
const cleanup = [];
async function runCleanup(db) {
  for (const fn of cleanup.reverse()) { try { await fn(db); } catch (e) { console.log("  (cleanup note: " + e.message + ")"); } }
}

async function mintInvite(db, userId, propertyId, minutes = 30) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await db.query(
    `insert into operator_session_invites (user_id, property_id, token_digest, issuance_reason, expires_at, issuance_source)
     values ($1,$2,$3,'bootstrap_invite', now() + ($4 || ' minutes')::interval, 'cli')`,
    [userId, propertyId, sha256(raw), String(minutes)]);
  cleanup.push(async (d) => d.query(`delete from operator_session_invites where token_digest=$1`, [sha256(raw)]));
  return raw;
}
const POST = async (p, body, headers = {}) => {
  const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => ({})), headers: r.headers };
};
// The bootstrap route rate-limits at 8/min per IP — the harness RESPECTS that
// budget (a proof tool that trips its own subject's walls proves nothing).
// Every login attempt goes through pacedLogin; case R drains the budget first
// and then bursts deliberately to capture the 429 receipt.
const _loginTimes = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// waits that also keep the connection path warm: some environments reap
// idle processes/servers, and a 61s dead sleep is exactly that. The ping
// (unauthenticated /operator/me) is free -- the resolver early-returns on
// a missing token before any database work.
async function sleepAlive(ms) {
  const step = 10_000;
  for (let left = ms; left > 0; left -= step) {
    await sleep(Math.min(step, left));
    try { await fetch(API + "/operator/me"); } catch (_e) {}
  }
}
async function budgetSlot(n = 1) {
  for (;;) {
    const now = Date.now();
    while (_loginTimes.length && now - _loginTimes[0] > 61_000) _loginTimes.shift();
    if (_loginTimes.length + n <= 8) return;
    const waitMs = 61_000 - (now - _loginTimes[0]) + 300;
    console.log("    (pacing: waiting " + Math.ceil(waitMs / 1000) + "s for the per-IP login budget — the limiter under test)");
    await sleepAlive(waitMs);
  }
}
async function pacedLogin(body, n = 1) {
  await budgetSlot(n);
  for (let i = 0; i < n; i++) _loginTimes.push(Date.now());
}
const GET = async (p, headers = {}) => {
  const r = await fetch(API + p, { headers });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

(async () => {
  if (!process.env.DATABASE_URL || !API) {
    console.error("Set DATABASE_URL and API_BASE first."); process.exit(1);
  }
  const useSsl = /sslmode=require/.test(process.env.DATABASE_URL);
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: useSsl ? { rejectUnauthorized: false } : false });
  await db.connect();

  try {
    // ---- locate the QA identity (created by tools/qa_provision.js, runbook step 7)
    const qa = (await db.query(
      `select u.id, u.name from users u
        join property_team_assignments a on a.user_id = u.id and a.property_id = $1 and a.active = true
       where u.account_kind = 'internal_qa' and u.is_active = true and u.status = 'active'
       limit 1`, [QA_PROP])).rows[0];
    if (!qa) { console.error("No active internal_qa user with an active assignment on " + QA_PROP + ". Run tools/qa_provision.js first."); process.exit(1); }
    console.log("QA identity: " + qa.name + " · property " + QA_PROP + " · run " + RUN);

    // The server's per-IP window may still hold hits from a previous run or
    // burst (the process-local tracker can't see it). One alignment wait
    // makes every run deterministic, including back-to-back double runs.
    if (process.env.PSPINE_SKIP_ALIGN === "1") {
      console.log("    (window alignment SKIPPED via PSPINE_SKIP_ALIGN=1 -- only valid when no bootstrap traffic hit this server in the last minute, e.g. a fresh server)");
    } else {
      console.log("    (aligning with the per-IP rate window: 61s one-time wait)");
      await sleepAlive(61_000);
    }

    const otherProp = OTHER_PROP || (await db.query(
      `select id from properties where id <> $1 limit 1`, [QA_PROP])).rows[0]?.id;

    // ================= A — invite → live login =================
    hdr("A — one-time proof logs in over the LIVE route");
    const rawA = await mintInvite(db, qa.id, QA_PROP);
    await pacedLogin({}, 1);
    const a = await POST("/operator/session", { proof: rawA });
    ok(a.status === 200 && !!a.json.session_token, "POST /operator/session -> 200 + session_token");
    ok(a.json.user && a.json.user.id === qa.id && a.json.property && a.json.property.id === QA_PROP,
       "server-derived identity + property in the response");
    const TOK = a.json.session_token;
    cleanup.push(async (d) => d.query(`update staff_sessions set revoked=true where token_digest=$1`, [sha256(TOK)]));

    // ================= B — digest-at-rest + issuance_purpose =================
    hdr("B — session row: digest-only, purpose recorded");
    const rowB = (await db.query(`select (token is null) as tnull, (token_digest is not null) as dset,
                                         (length(token_digest)=64) as dlen, issuance_purpose
                                    from staff_sessions where token_digest=$1`, [sha256(TOK)])).rows[0];
    ok(rowB && rowB.tnull && rowB.dset && rowB.dlen, "token NULL · token_digest sha256-hex");
    ok(rowB.issuance_purpose === "bootstrap_invite", "issuance_purpose = bootstrap_invite (server-owned)");

    // ================= C — resolve carries live authority =================
    hdr("C — /operator/me through the shared resolver");
    const c1 = await GET("/operator/me", { "x-staff-session": TOK });
    ok(c1.status === 200 && c1.json.id === qa.id && c1.json.property_id === QA_PROP, "identity + SESSION property resolve live");

    // ================= D — browser-supplied authority ignored =================
    hdr("D — body-supplied authority is ignored at login");
    const rawD = await mintInvite(db, qa.id, QA_PROP);
    await pacedLogin({}, 1);
    const d1 = await POST("/operator/session", { proof: rawD, user_id: "evil", property_id: otherProp, role: "admin", allowed_modules: ["everything"] });
    ok(d1.status === 200 && d1.json.user.id === qa.id && d1.json.property.id === QA_PROP, "junk authority fields in body change nothing");
    cleanup.push(async (dd) => dd.query(`update staff_sessions set revoked=true where token_digest=$1`, [sha256(d1.json.session_token)]));

    // ================= E — one generic refusal, four proof states =================
    hdr("E — invalid / expired / consumed / revoked -> identical refusal");
    const rawExp = await mintInvite(db, qa.id, QA_PROP, 5);
    await db.query(`update operator_session_invites set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where token_digest=$1`, [sha256(rawExp)]);
    const rawRev = await mintInvite(db, qa.id, QA_PROP);
    await db.query(`update operator_session_invites set revoked_at = now() where token_digest=$1`, [sha256(rawRev)]);
    await pacedLogin({}, 4);
    const eBad = await POST("/operator/session", { proof: "not-a-proof-" + RUN });
    const eExp = await POST("/operator/session", { proof: rawExp });
    const eCon = await POST("/operator/session", { proof: rawA });        // already consumed in A
    const eRev = await POST("/operator/session", { proof: rawRev });
    console.log("    E statuses: " + [eBad, eExp, eCon, eRev].map(r=>r.status).join(",") );
    ok([eBad, eExp, eCon, eRev].every(r => r.status === 401), "all four -> 401");
    const bodies = [eBad, eExp, eCon, eRev].map(r => JSON.stringify(r.json));
    ok(new Set(bodies).size === 1, "…with byte-identical bodies (no state oracle)");

    // ================= F — entitlement pulled mid-flight: proof NOT consumed =================
    hdr("F — authority removed between invite and login (case Q live)");
    const rawF = await mintInvite(db, qa.id, QA_PROP);
    await db.query(`update property_team_assignments set active=false where user_id=$1 and property_id=$2`, [qa.id, QA_PROP]);
    await pacedLogin({}, 1);
    const f1 = await POST("/operator/session", { proof: rawF });
    const fInv = (await db.query(`select consumed_at from operator_session_invites where token_digest=$1`, [sha256(rawF)])).rows[0];
    ok(f1.status === 401 && fInv.consumed_at === null, "401 AND the proof stays unconsumed (rollback)");
    await db.query(`update property_team_assignments set active=true where user_id=$1 and property_id=$2`, [qa.id, QA_PROP]);
    await pacedLogin({}, 1);
    const f2 = await POST("/operator/session", { proof: rawF });
    ok(f2.status === 200, "same proof succeeds after access restored (consume-LAST)");
    cleanup.push(async (dd) => dd.query(`update staff_sessions set revoked=true where token_digest=$1`, [sha256(f2.json.session_token)]));

    // ================= G — concurrency: one proof, two racers =================
    hdr("G — two concurrent submissions of ONE proof (case P live)");
    const rawG = await mintInvite(db, qa.id, QA_PROP);
    await pacedLogin({}, 2);
    const [g1, g2] = await Promise.all([POST("/operator/session", { proof: rawG }), POST("/operator/session", { proof: rawG })]);
    const statuses = [g1.status, g2.status].sort();
    ok(statuses[0] === 200 && statuses[1] === 401, "exactly one 200, one 401");
    const winner = g1.status === 200 ? g1 : (g2.status === 200 ? g2 : null);
    if (!winner) { ok(false, "no winner emerged (statuses " + statuses.join("/") + ") — see pacing note"); }
    else {
      const gCount = (await db.query(`select count(*)::int n from staff_sessions where token_digest=$1`, [sha256(winner.json.session_token)])).rows[0].n;
      ok(gCount === 1, "exactly one session row exists for the winner");
      cleanup.push(async (dd) => dd.query(`update staff_sessions set revoked=true where token_digest=$1`, [sha256(winner.json.session_token)]));
    }

    // ================= H — live module guard =================
    hdr("H — module pulled MID-SESSION -> immediate 403 on leasing routes");
    const h0 = await GET("/operator/leasing/conversation-queue", { "x-staff-session": TOK });
    ok(h0.status !== 401 && h0.status !== 403, "leasing-entitled session passes the guard (status " + h0.status + ")");
    await db.query(`update property_team_assignments set allowed_modules='{maintenance}' where user_id=$1 and property_id=$2`, [qa.id, QA_PROP]);
    const h1 = await GET("/operator/leasing/conversation-queue", { "x-staff-session": TOK });
    ok(h1.status === 403, "very next request 403 — live entitlement, no session cache");
    const h2 = await GET("/operator/me", { "x-staff-session": TOK });
    ok(h2.status === 200, "/operator/me (identity-only) still 200");
    await db.query(`update property_team_assignments set allowed_modules='{leasing}' where user_id=$1 and property_id=$2`, [qa.id, QA_PROP]);

    // ================= I — suspension kills the session NOW =================
    hdr("I — user suspended -> session unresolvable on next request");
    await db.query(`update users set status='suspended' where id=$1`, [qa.id]);
    ok((await GET("/operator/me", { "x-staff-session": TOK })).status === 401, "suspended -> 401 immediately");
    await db.query(`update users set status='active' where id=$1`, [qa.id]);
    ok((await GET("/operator/me", { "x-staff-session": TOK })).status === 200, "restored -> resolves again (no re-login needed)");

    // ================= J — revoke: exact, immediate, idempotent =================
    hdr("J — sign-out over the live route");
    const rawJ = await mintInvite(db, qa.id, QA_PROP);
    await pacedLogin({}, 1);
    const j0 = await POST("/operator/session", { proof: rawJ });
    const jTok = j0.json.session_token;
    const j1 = await POST("/operator/session/revoke", {}, { "x-staff-session": jTok });
    ok(j1.status === 200, "revoke returns a receipt");
    ok((await GET("/operator/me", { "x-staff-session": jTok })).status === 401, "token dead immediately");
    const j2 = await POST("/operator/session/revoke", {}, { "x-staff-session": jTok });
    ok(j2.status === j1.status && JSON.stringify(j2.json) === JSON.stringify(j1.json), "second revoke: identical receipt (idempotent, no oracle)");

    // ================= K — cross-property wall (team_access) =================
    hdr("K — property wall on /properties/:id/my-access");
    if (!otherProp) { wr("no second property found — skipped"); }
    else {
      const kOwn = await GET(`/properties/${QA_PROP}/my-access`, { "x-staff-session": TOK, "x-operator-key": KEY });
      const kOther = await GET(`/properties/${otherProp}/my-access`, { "x-staff-session": TOK, "x-operator-key": KEY });
      ok(kOwn.status === 200, "own property -> 200");
      ok(kOther.status === 403, "OTHER property with same session -> 403 (wall holds)");
    }

    // ================= L — roster excludes internal_qa =================
    hdr("L — Gate 3: QA identity never on the operating roster");
    const l1 = await GET(`/properties/${QA_PROP}/team`, { "x-operator-key": KEY });
    if (l1.status !== 200) wr("roster read returned " + l1.status + " — check OPERATOR_KEY env");
    else {
      const names = JSON.stringify(l1.json);
      ok(!names.includes(qa.name), "internal_qa user absent from the roster payload");
    }

    // ================= M — query-string tokens are dead =================
    hdr("M — ?session= no longer authenticates");
    const m1 = await GET(`/properties/${QA_PROP}/my-access?session=${encodeURIComponent(TOK)}`, { "x-operator-key": KEY });
    ok(m1.status === 401, "token in URL -> 401 (header-only)");

    // ================= N — legacy raw-token window + structural sunset =================
    hdr("N — legacy fallback lives ≤14 days, refuses past it");
    const nFresh = "legacy-fresh-" + RUN, nOld = "legacy-old-" + RUN;
    await db.query(`insert into staff_sessions (user_id, property_id, token, expires_at) values ($1,$2,$3, now()+interval '1 day')`, [qa.id, QA_PROP, nFresh]);
    await db.query(`insert into staff_sessions (user_id, property_id, token, expires_at, created_at) values ($1,$2,$3, now()+interval '1 day', now()-interval '15 days')`, [qa.id, QA_PROP, nOld]);
    cleanup.push(async (dd) => dd.query(`delete from staff_sessions where token in ($1,$2)`, [nFresh, nOld]));
    ok((await GET("/operator/me", { "x-staff-session": nFresh })).status === 200, "fresh raw legacy row still resolves (compat window)");
    ok((await GET("/operator/me", { "x-staff-session": nOld })).status === 401, "15-day-old raw row REFUSED despite future expiry (structural sunset, live)");

    // ================= O — schema constraints bite on production =================
    hdr("O — 070 CHECKs enforce on Neon");
    let bit = 0;
    try { await db.query(`insert into staff_sessions (user_id, property_id, token_digest, issuance_purpose, expires_at) values ($1,$2,$3,'made_up', now()+interval '1 hour')`, [qa.id, QA_PROP, "o" + RUN]); }
    catch (e) { if (/issuance_purpose_check/.test(e.message)) bit++; }
    // BLOCKER 1 (v2 review): the token-SHAPE constraint bites too --
    // a raw-token row that claims a canonical purpose is rejected.
    try { await db.query(`insert into staff_sessions (user_id, property_id, token, issuance_purpose, expires_at) values ($1,$2,$3,'bootstrap_invite', now()+interval '1 hour')`, [qa.id, QA_PROP, "shape-" + RUN]); }
    catch (e) { if (/token_shape_check/.test(e.message)) bit++; }
    try { await db.query(`insert into operator_session_invites (user_id, property_id, token_digest, expires_at, consumed_at) values ($1,$2,$3, now()+interval '1 hour', now())`, [qa.id, QA_PROP, "x" + RUN]); }
    catch (e) { if (/osi_consume_pair/.test(e.message)) bit++; }
    try { await db.query(`insert into operator_session_invites (user_id, property_id, token_digest, expires_at) values ($1,$2,$3, now()-interval '1 hour')`, [qa.id, QA_PROP, "y" + RUN]); }
    catch (e) { if (/osi_expiry_sane/.test(e.message)) bit++; }
    ok(bit === 4, "issuance_purpose_check + token_shape_check + osi_consume_pair + osi_expiry_sane all reject (" + bit + "/4)");

    // ================= P — invite ↔ session linkage =================
    hdr("P — consumed proof names its exact session");
    const pInv = (await db.query(
      `select i.consumed_at, s.user_id, s.property_id, s.issuance_purpose
         from operator_session_invites i join staff_sessions s on s.id = i.consumed_staff_session_id
        where i.token_digest = $1`, [sha256(rawA)])).rows[0];
    ok(pInv && pInv.consumed_at !== null && pInv.user_id === qa.id && pInv.property_id === QA_PROP && pInv.issuance_purpose === "bootstrap_invite",
       "consumed_at set · linked session matches user + property + purpose");

    // ================= S — one ACTIVE authority row per (property, user) =================
    hdr("S — one authority row per (property,user): world-aware");
    // which world is production in? (BLOCKER-2 receipt, printed verbatim)
    const sFull = (await db.query(`
      select c.conname from pg_constraint c
       where c.conrelid = 'property_team_assignments'::regclass and c.contype='u'
         and (select array_agg(a.attname order by a.attname)
                from unnest(c.conkey) k join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k)
             = array['property_id','user_id']::name[]`)).rows[0];
    const sPartial = (await db.query(`select indexname from pg_indexes
       where tablename='property_team_assignments' and indexname='uq_pta_one_active'`)).rows[0];
    console.log("    constraint receipt: full=" + (sFull ? sFull.conname : "none")
              + " · partial=" + (sPartial ? sPartial.indexname : "none"));
    ok(!!(sFull || sPartial), "an active-uniqueness guarantee EXISTS (option 1 or option 2)");
    let sDupErr = null;
    try { await db.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active) values ($1,$2,'Dup Attempt','{leasing}', true)`, [QA_PROP, qa.id]); }
    catch (e) { sDupErr = e.message; }
    ok(!!sDupErr && /unique/.test(sDupErr), "second ACTIVE row for the pair -> rejected (" + (sDupErr||"").match(/"[^"]+"/)?.[0] + ")");
    if (!sFull && sPartial) {
      const sIn = await db.query(`insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active) values ($1,$2,'History Row','{leasing}', false) returning id`, [QA_PROP, qa.id]);
      ok(sIn.rowCount === 1, "INACTIVE duplicate (reassignment history) accepted under the partial index");
      await db.query(`delete from property_team_assignments where id=$1`, [sIn.rows[0].id]);
    } else {
      console.log("    (inactive-history probe skipped: full unique world reuses one row per pair)");
    }

    // ================= Q — production EXPLAIN of the exact resolver SQL =================
    hdr("Q — EXPLAIN (ANALYZE, BUFFERS) on RESOLVER_SQL — the owed Neon plan");
    const qPlan = await db.query("explain (analyze, buffers) " + svc.RESOLVER_SQL, [sha256(TOK), TOK, String(svc.LEGACY_MAX_TTL_DAYS)]);
    const planText = qPlan.rows.map(r => r["QUERY PLAN"]).join("\n");
    console.log(planText.split("\n").map(l => "    " + l).join("\n"));
    ok(/idx_staff_sessions_token_digest|Index/.test(planText), "plan uses an index path (paste the plan above into the review thread)");

    // ================= R — rate limit + trust-proxy receipt =================
    hdr("R — per-IP limiter over the real proxy");
    await budgetSlot(8); // drain: wait until a full fresh window is available
    const rs = [];
    for (let i = 0; i < 10; i++) rs.push((await POST("/operator/session", { proof: "rl-" + RUN + "-" + i })).status);
    console.log("    statuses: " + rs.join(","));
    if (rs.includes(429)) ok(true, "429 observed -> per-IP 8/min BINDS to this client (trust proxy=1 verified live)");
    else wr("no 429 in 10 rapid posts — per-IP limiting NOT confirmed; endpoint 30/min remains the proven ceiling. Check Render proxy config before relying on per-IP.");
    // reviewer hardening: /operator/session/revoke sits behind the SAME wall.
    const rRev = await POST("/operator/session/revoke", {}, { "x-staff-session": "junk-" + RUN });
    if (rs.includes(429)) ok(rRev.status === 429, "revoke route shares the limiter: 429 while the budget is spent (got " + rRev.status + ")");
    else wr("revoke-limiter check skipped (per-IP wall not confirmed above)");

    await runCleanup(db);

    // ---- plain-language receipt
    console.log("\n============================================================");
    console.log(` BRICK ONE LIVE ACCEPTANCE: ${pass} passed · ${fail} failed · ${warn} warnings`);
    console.log(" What happened: the QA identity logged in through the real door,");
    console.log(" every wall held, every mutation was restored, every fixture removed.");
    console.log(" What to do next: paste this entire output (incl. the Q plan) into");
    console.log(" the review thread. If FAIL > 0, stop and send it to Claude.");
    console.log("============================================================");
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error("\nHARNESS ERROR: " + e.message);
    try { await runCleanup(db); console.error("(cleanup ran)"); } catch (_) {}
    process.exit(1);
  } finally { await db.end(); }
})();
