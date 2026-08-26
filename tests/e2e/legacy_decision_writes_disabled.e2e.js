/*  ════════════════════════════════════════════════════════════════════
    MONEY BUILD 0.5 — THE LEGACY DECISION WRITER IS CLOSED, AND STAYS CLOSED.

    Migration 059 shipped a decision rail that WRITES economic decisions:
    createDecision and resolveDecision insert events, decision_cases rows and
    obligations. The canonical money sequence is

        occurrence → obligation → economic decision → cash →
        recognition → certification → issuance

    and until each 059 decision type has a ruled canonical-domain owner, that
    writer is a SECOND authority over economic decisions. This proof exists so
    the closure is a fact about running code rather than a claim in a header.

    ── WHAT THIS PROVES ────────────────────────────────────────────────
      1-3  the three HTTP mutation routes answer 410 with the exact
           code and reason, through the REAL booted server and the REAL
           x-operator-key gate;
      4-5  a DIRECT _service call throws the same typed refusal — the
           service is the boundary, not the route;
      6    the refusal PRECEDES ordinary validation: an empty payload and a
           nonexistent decision id both get the closed-writer refusal, not
           400 and not 404;
      7-9  nothing durable moved — no event, no obligation, no
           decision_cases row, measured as a before/after delta;
      10   reads and history are untouched, including a decision_cases row
           this harness seeds DIRECTLY (never through the closed writer)
           and then reads back through the real route.

    ── WHAT IT DELIBERATELY DOES NOT CLAIM ─────────────────────────────
    Nothing about production. Nothing about whether a canonical owner has
    been ruled. It proves one boundary refuses, on this schema, today.

    ── WHY THE EXPECTED STRINGS ARE LITERALS HERE ──────────────────────
    Importing the constants from the module under test would make every
    assertion tautological — the test would agree with whatever the source
    said, including a silent change. They are typed out on purpose.

    CLASS 3 — test infrastructure. Runs against the disposable e2e database
    built by tests/e2e/verify_all.sh; it seeds narrowly-named fixture rows and
    deletes exactly those rows, and it touches no production identifier.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
module.paths.unshift(path.join(__dirname, "..", "..", "node_modules"));
const { Pool } = require("pg");

//  ── THE CONTRACT, TYPED OUT ────────────────────────────────────────
const EXPECT_CODE = "LEGACY_DECISION_WRITES_DISABLED";
const EXPECT_REASON =
  "Migration 059 decision writes are closed pending canonical-domain reassignment.";
const EXPECT_STATUS = 410;

const CONN = process.env.E2E_DATABASE_URL
  || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e";
const BASE = "http://127.0.0.1:3000";
const KEY = "e2e-key";                         // the same global operator key boot.sh sets
const STAMP = "MB05-" + Date.now().toString(36);

const pool = new Pool({ connectionString: CONN });
const q = (s, p) => pool.query(s, p);

let bad = 0;
const must = (name, cond, detail) => {
  if (cond) { console.log("  ✓ " + name); return; }
  bad++; console.log("  ✗ " + name + (detail ? "\n      " + detail : ""));
};

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", "x-operator-key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

//  Every durable surface the legacy writer can touch, counted for THIS
//  property only. `money_decision_%` is the writer's own event vocabulary
//  (recorded / escalated / granted / denied).
async function durableCounts(prop) {
  const ev = await q(
    `select count(*)::int n from events
      where property_id = $1 and type like 'money_decision_%'`, [prop]);
  const ob = await q(
    `select count(*)::int n from obligations
      where property_id = $1 and type = 'decision_grant'`, [prop]);
  const dc = await q(
    `select count(*)::int n from decision_cases where property_id = $1`, [prop]);
  const dcState = await q(
    `select coalesce(string_agg(id::text || ':' || state, ',' order by id::text), '')
       s from decision_cases where property_id = $1`, [prop]);
  return { events: ev.rows[0].n, obligations: ob.rows[0].n,
           decisions: dc.rows[0].n, decisionStates: dcState.rows[0].s };
}

//  Captures a typed throw without letting a PASS happen by accident: if the
//  call RESOLVES, that is recorded as the failure it is.
async function captureThrow(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (e) { return { threw: true, error: e }; }
}

(async () => {
  console.log("\n══ MONEY BUILD 0.5 — LEGACY DECISION WRITER CLOSED ══");
  console.log("  database :", CONN.replace(/:[^:@/]*@/, ":***@"));
  console.log("  fixture  :", STAMP);

  const prop = (await q(
    "select id from properties where name='Skyline E2E' order by created_at desc limit 1"
  )).rows[0].id;

  //  ── HARNESS FIXTURES · narrowly named, deleted in teardown ────────
  const person = (await q(
    "insert into persons (name, lifecycle_status) values ($1,'lead') returning id",
    [STAMP + " Decider"])).rows[0].id;

  //  HISTORY, seeded DIRECTLY — never through the closed writer. This is what
  //  proof 10 reads back: closing the writer must not close the history.
  const historic = (await q(
    `insert into decision_cases
       (property_id, person_id, type, amount, reason_code, note, state,
        decided_by_person_id)
     values ($1,$2,'writeoff',250.00,'hardship',$3,'closed_recorded',$2)
     returning id`, [prop, person, STAMP + " pre-existing history row"])).rows[0].id;

  //  Snapshot AFTER seeding, so the harness's own rows are not counted as
  //  writer activity. The delta below is the writer's, or nobody's.
  const before = await durableCounts(prop);
  console.log("  before   :", JSON.stringify(before));

  //  A payload that WOULD write. The decider holds no assignment on this
  //  property, so readAuthority resolves cap 0 and any positive amount takes
  //  the CLEAR-AND-PASS branch — an event, a decision_cases row AND an
  //  obligation. That is what makes proofs 7-9 falsifiable rather than
  //  vacuous: re-open the writer and all three move.
  const VALID = {
    property_id: prop, decided_by_person_id: person,
    type: "writeoff", amount: 1234.56, reason_code: "hardship",
    note: STAMP + " would-write payload",
  };
  const NONEXISTENT = "00000000-0000-4000-8000-000000000059";

  // ── 1-3 · THE THREE HTTP MUTATION ROUTES ──────────────────────────
  console.log("\n── HTTP MUTATION ROUTES (real server, real operator key) ──");
  const create = await api("POST", "/decisions", VALID);
  const grant = await api("POST", `/decisions/${NONEXISTENT}/grant`,
    { granted_by_person_id: person });
  const deny = await api("POST", `/decisions/${NONEXISTENT}/deny`,
    { denied_by_person_id: person, note: STAMP + " deny note" });

  for (const [label, r] of [["POST /decisions", create],
                            ["POST /decisions/:id/grant", grant],
                            ["POST /decisions/:id/deny", deny]]) {
    console.log(`  ${label} -> ${r.status} ${JSON.stringify(r.body)}`);
    must(`${label} answers ${EXPECT_STATUS} Gone`,
      r.status === EXPECT_STATUS, `got ${r.status}`);
    must(`${label} carries the exact code`,
      r.body && r.body.code === EXPECT_CODE, `got ${r.body && r.body.code}`);
    must(`${label} carries the exact reason`,
      r.body && r.body.reason === EXPECT_REASON, `got ${r.body && r.body.reason}`);
  }

  // ── 6 · THE REFUSAL PRECEDES ORDINARY VALIDATION ──────────────────
  //  An empty body would have failed BAD_INPUT 400 at the old first line, and
  //  a nonexistent id would have failed NOT_FOUND 404 after a lookup. Both
  //  must now be refused by the wall instead — that is the difference between
  //  a closed writer and a writer that merely validates strictly.
  console.log("\n── REFUSAL PRECEDES VALIDATION ──");
  const empty = await api("POST", "/decisions", {});
  const junk = await api("POST", "/decisions", { type: "not_a_type", amount: -5 });
  console.log(`  empty payload      -> ${empty.status} ${empty.body && empty.body.code}`);
  console.log(`  invalid payload    -> ${junk.status} ${junk.body && junk.body.code}`);
  console.log(`  nonexistent id     -> ${grant.status} ${grant.body && grant.body.code}`);
  must("an EMPTY payload is refused by the wall, not BAD_INPUT",
    empty.status === EXPECT_STATUS && empty.body.code === EXPECT_CODE,
    `got ${empty.status} ${empty.body && empty.body.code}`);
  must("an INVALID payload is refused by the wall, not BAD_INPUT",
    junk.status === EXPECT_STATUS && junk.body.code === EXPECT_CODE,
    `got ${junk.status} ${junk.body && junk.body.code}`);
  must("a NONEXISTENT decision id is refused by the wall, not NOT_FOUND",
    grant.status === EXPECT_STATUS && grant.body.code === EXPECT_CODE,
    `got ${grant.status} ${grant.body && grant.body.code}`);

  // ── 4-5 · DIRECT _service CALLS ───────────────────────────────────
  //  The service is the authority boundary. A caller holding _service — which
  //  server.js hands to commitmentledger — must be refused identically, with
  //  no HTTP skin anywhere in the path.
  console.log("\n── DIRECT _service CALLS (no HTTP) ──");
  let spawnCalls = 0, completeCalls = 0;
  const rail = require("../../src/leasing/decisions.js")({
    pool,
    spawnObligationFromEvent: async () => { spawnCalls++; return { id: null }; },
    completeObligation: async () => { completeCalls++; },
  });
  const svc = rail._service;

  must("_service still exposes createDecision", typeof svc.createDecision === "function");
  must("_service still exposes resolveDecision", typeof svc.resolveDecision === "function");
  must("_service still exposes pendingDecisions", typeof svc.pendingDecisions === "function");
  must("_service still exposes readAuthority", typeof svc.readAuthority === "function");

  const dCreate = await captureThrow(() => svc.createDecision(null, VALID));
  const dResolve = await captureThrow(() => svc.resolveDecision(null,
    { decision_id: historic, verb: "grant", resolved_by_person_id: person }));
  //  The signature trap: a destructuring PARAMETER LIST runs at call time,
  //  before the first statement. If the payload were still destructured in the
  //  signature these would be a bare TypeError, not a governed refusal.
  const dCreateBare = await captureThrow(() => svc.createDecision());
  const dResolveBare = await captureThrow(() => svc.resolveDecision());

  for (const [label, r] of [["_service.createDecision()", dCreate],
                            ["_service.resolveDecision()", dResolve],
                            ["_service.createDecision() with NO payload", dCreateBare],
                            ["_service.resolveDecision() with NO payload", dResolveBare]]) {
    console.log(`  ${label} -> ${r.threw ? r.error.code + " / " + r.error.message : "RESOLVED (no throw)"}`);
    must(`${label} throws`, r.threw, "it resolved instead of refusing");
    must(`${label} throws the exact code`,
      r.threw && r.error.code === EXPECT_CODE, r.threw ? `got ${r.error.code}` : "no throw");
    must(`${label} carries the exact reason`,
      r.threw && r.error.reason === EXPECT_REASON,
      r.threw ? `got ${r.error.reason}` : "no throw");
  }
  must("the injected obligation writer was never invoked", spawnCalls === 0,
    `spawnObligationFromEvent called ${spawnCalls}x`);
  must("the injected obligation completer was never invoked", completeCalls === 0,
    `completeObligation called ${completeCalls}x`);

  // ── 7-9 · NOTHING DURABLE MOVED ───────────────────────────────────
  console.log("\n── DURABLE STATE (before vs after) ──");
  const after = await durableCounts(prop);
  console.log("  after    :", JSON.stringify(after));
  must("no money_decision event row was written",
    after.events === before.events, `${before.events} -> ${after.events}`);
  must("no decision_grant obligation row was created or changed",
    after.obligations === before.obligations, `${before.obligations} -> ${after.obligations}`);
  must("no decision_cases row was created",
    after.decisions === before.decisions, `${before.decisions} -> ${after.decisions}`);
  must("no decision_cases row changed state",
    after.decisionStates === before.decisionStates,
    `${before.decisionStates} -> ${after.decisionStates}`);

  // ── 10 · READS AND HISTORY SURVIVE ────────────────────────────────
  console.log("\n── READS AND HISTORY ──");
  const pending = await api("GET", `/decisions/pending?property_id=${prop}`);
  const readOne = await api("GET", `/decisions/${historic}`);
  const readMissing = await api("GET", `/decisions/${NONEXISTENT}`);
  console.log(`  GET /decisions/pending    -> ${pending.status} count=${pending.body && pending.body.count}`);
  console.log(`  GET /decisions/:id        -> ${readOne.status} state=${readOne.body && readOne.body.decision && readOne.body.decision.state}`);
  console.log(`  GET /decisions/:missing   -> ${readMissing.status} ${readMissing.body && readMissing.body.code}`);
  must("GET /decisions/pending still answers 200", pending.status === 200,
    `got ${pending.status}`);
  must("GET /decisions/pending returns a governed list",
    pending.body && Array.isArray(pending.body.pending), JSON.stringify(pending.body));
  must("history seeded outside the writer is still readable",
    readOne.status === 200 && readOne.body.decision
      && readOne.body.decision.id === historic
      && readOne.body.decision.state === "closed_recorded",
    JSON.stringify(readOne.body));
  //  The wall must not have leaked into the read path: a missing decision is
  //  still an honest 404, not a 410.
  must("a missing decision still reads 404 NOT_FOUND, not the wall",
    readMissing.status === 404 && readMissing.body.code === "NOT_FOUND",
    `got ${readMissing.status} ${readMissing.body && readMissing.body.code}`);

  //  the preserved SERVICE reads, directly
  const c = await pool.connect();
  try {
    const rows = await svc.pendingDecisions(c, { property_id: prop });
    const auth = await svc.readAuthority(c, prop, person);
    console.log(`  _service.pendingDecisions -> ${rows.length} row(s)`);
    console.log(`  _service.readAuthority    -> cap=${auth.cap} role=${auth.role}`);
    must("_service.pendingDecisions still reads", Array.isArray(rows));
    must("_service.readAuthority still reads and fails closed at cap 0",
      auth && auth.cap === 0 && auth.role === null, JSON.stringify(auth));
  } finally { c.release(); }

  // ── TEARDOWN · only rows this harness created ─────────────────────
  await q("delete from decision_cases where id = $1", [historic]);
  await q("delete from persons where id = $1", [person]);
  const leftover = await q(
    "select count(*)::int n from persons where name like $1", [STAMP + "%"]);
  must("harness fixtures removed", leftover.rows[0].n === 0);

  console.log("\n════════════════════════════");
  console.log(bad === 0
    ? "  ✓ PASS — the legacy migration-059 decision writer is closed."
    : `  ✗ FAIL — ${bad} assertion(s) failed.`);
  console.log("════════════════════════════\n");
  process.exitCode = bad ? 2 : 0;
  await pool.end();
})().catch(async (e) => {
  console.log("DIED " + e.stack);
  process.exitCode = 1;
  try { await pool.end(); } catch (_) {}
});
