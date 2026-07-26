// ════════════════════════════════════════════════════════════════════
//  LEGACY /agent/ ADAPTER LAYER — REMOVED (Fable ruling, 2026-07-25)
//
//  FALSIFIABLE BY CONSTRUCTION. This harness BUILDS THE REAL ROUTER from
//  src/agent/agent.js and walks its actual Express route table. It is not
//  a source-text grep and not a copy: if the routes come back, this fails.
//
//  Proves:
//    1. The four legacy adapter routes are GONE from the live route table:
//         POST /agent/drafts/:id/send      (faked the human approver)
//         POST /agent/thread/takeover      (faked the human approver)
//         POST /agent/thread/regenerate    (unauth'd model run)
//         GET  /agent/thread               (unauth'd read of message bodies)
//    2. POST /agent/inbound SURVIVES — three harnesses depend on it, and
//       over-deleting is as much a defect as under-deleting.
//    3. demoManagerUserId is gone from the module source, along with its
//       "oldest leasing_manager" fallback.
//    4. sendDraftService no longer stamps human_approved_at when there is
//       no approver — executed against REAL Postgres inside a transaction
//       that ALWAYS ROLLS BACK. Nothing is written.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/legacy_agent_routes_removed_proof.js
// ════════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SRC = path.join(__dirname, "..", "src", "agent", "agent.js");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Build the REAL router. Only the route table is under test, so the
// collaborators are inert stubs — none of them is called here.
function buildRouter() {
  const agentModule = require(SRC);
  return agentModule({
    pool,
    anthropic: null,
    INGEST_MODEL: "test",
    spawnObligationFromEvent: async () => null,
    completeObligation: async () => null,
    leasingLifecycle: null,
    commBoundary: null,
    leasingBookingService: null,
  });
}

// Walk Express's actual stack → [{ method, path }]
function routeTable(router) {
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    const p = layer.route.path;
    for (const m of Object.keys(layer.route.methods || {})) {
      if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path: p });
    }
  }
  return out;
}

(async () => {
  console.log("LEGACY /agent/ ADAPTER LAYER — removal proof\n");

  const router = buildRouter();
  const table = routeTable(router);
  const has = (method, p) => table.some(r => r.method === method && r.path === p);

  console.log(`[0] real route table built from src/agent/agent.js — ${table.length} routes`);
  check(table.length > 0, "router exposes routes", "if this is 0 the harness proves nothing");

  console.log("\n[1] the four legacy adapter routes are GONE");
  check(!has("POST", "/agent/drafts/:id/send"),   "POST /agent/drafts/:id/send removed");
  check(!has("POST", "/agent/thread/takeover"),   "POST /agent/thread/takeover removed");
  check(!has("POST", "/agent/thread/regenerate"), "POST /agent/thread/regenerate removed");
  check(!has("GET",  "/agent/thread"),            "GET  /agent/thread removed");

  console.log("\n[2] the door the harnesses depend on SURVIVES — but is no longer open");
  check(has("POST", "/agent/inbound"), "POST /agent/inbound still mounted",
        has("POST", "/agent/inbound") ? "not over-deleted" : "OVER-DELETED — harnesses will break");

  // Mounted is not the same as safe. Until 2026-07-26 anyone who could reach
  // the API could name a property_id and a person_id and inject a message
  // into a real conversation AS that person — words in a prospect's history
  // they never said. Drive the real handler and watch it refuse.
  const inboundRoute = router.stack.find(l => l.route
    && l.route.path === "/agent/inbound" && l.route.methods.post);
  const runGate = (headers) => new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    const stack = inboundRoute.route.stack;
    // Only the gate runs; `next` resolving means it let the request through.
    stack[0].handle({ headers, get: (h) => headers[String(h).toLowerCase()], body: {} }, res,
      () => resolve({ status: 200, passed: true }));
  });

  const savedKey = process.env.OPERATOR_KEY;
  process.env.OPERATOR_KEY = "proof-key";
  let g = await runGate({});
  check(g.status === 401 && !g.passed, "no key → 401, the request never reaches the agent", String(g.status));
  g = await runGate({ "x-operator-key": "wrong" });
  check(g.status === 401 && !g.passed, "wrong key → 401", String(g.status));
  g = await runGate({ "x-operator-key": "proof-key" });
  check(g.passed === true, "the right key passes the gate", String(g.status));

  // FAIL CLOSED. An unset key must lock the door, not open it — the failure
  // mode of "no key configured means no check" is how a gate becomes theatre.
  delete process.env.OPERATOR_KEY;
  g = await runGate({ "x-operator-key": "anything" });
  check(g.status === 503 && !g.passed, "OPERATOR_KEY unset → 503 LOCKED, never open", String(g.status));
  if (savedKey === undefined) delete process.env.OPERATOR_KEY;
  else process.env.OPERATOR_KEY = savedKey;

  console.log("\n[3] the borrowed-identity helper and its fallback are gone");
  const src = fs.readFileSync(SRC, "utf8");
  const live = src.split("\n").filter(l => !/^\s*(\/\/|--)/.test(l)).join("\n");
  check(!/async function demoManagerUserId/.test(live), "demoManagerUserId() defined nowhere");
  check(!/role='leasing_manager'::role_name order by created_at asc/.test(live),
        "the oldest-leasing_manager fallback query is gone");

  console.log("\n[4] no approval TIME without an approver — real Postgres, rolled back");
  const anchor = (await pool.query(
    `select c.id as conversation_id, c.property_id, c.person_id
       from conversations c
      where c.property_id is not null and c.person_id is not null
      limit 1`)).rows[0];

  if (!anchor) {
    check(false, "found a conversation to anchor the insert", "cannot prove the SQL shape");
  } else {
    // Anchor on a string unique to the dispatch INSERT, then take the whole
    // enclosing template literal. Newline-agnostic: the file is CRLF on Windows.
    const insertSql = (() => {
      const i = src.indexOf("human_approved_by_user_id, human_approved_at, sent_by_user_id");
      if (i === -1) return null;
      const start = src.lastIndexOf("`", i);
      const end = src.indexOf("`", i);
      if (start === -1 || end === -1) return null;
      const sql = src.slice(start + 1, end);
      return /insert into comm_events/i.test(sql) ? sql : null;
    })();
    check(!!insertSql, "extracted the dispatch INSERT from the shipping source");

    if (insertSql) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const withNoActor = (await client.query(insertSql,
          [anchor.property_id, anchor.person_id, anchor.conversation_id, "(proof) auto dispatch", null])).rows[0];
        const a = (await client.query(
          `select human_approved_at, human_approved_by_user_id, sent_by_user_id
             from comm_events where id=$1`, [withNoActor.id])).rows[0];
        check(a.human_approved_at === null,
              "auto dispatch (no actor) leaves human_approved_at NULL",
              a.human_approved_at === null ? "honest blank" : "STAMPED " + a.human_approved_at + " with no approver");

        const realUser = (await client.query("select id from users limit 1")).rows[0];
        const withActor = (await client.query(insertSql,
          [anchor.property_id, anchor.person_id, anchor.conversation_id, "(proof) human dispatch", realUser.id])).rows[0];
        const b = (await client.query(
          `select human_approved_at, human_approved_by_user_id from comm_events where id=$1`, [withActor.id])).rows[0];
        check(b.human_approved_at !== null && b.human_approved_by_user_id === realUser.id,
              "human dispatch DOES stamp approver + time",
              "the fix must not suppress genuine approvals");
      } finally {
        await client.query("rollback");   // ALWAYS. Nothing above is persisted.
        client.release();
      }
      const leaked = (await pool.query(
        `select count(*)::int c from comm_events where body like '(proof) %'`)).rows[0].c;
      check(leaked === 0, "rollback left nothing behind", leaked === 0 ? "0 rows" : leaked + " ROWS LEAKED");
    }
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; })
  .finally(() => pool.end());
