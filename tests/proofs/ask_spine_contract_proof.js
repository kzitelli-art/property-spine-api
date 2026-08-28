#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  ask_spine_contract_proof.js — ASK SPINE SLICE 1, SOURCE RUNG
//
//  WHAT THIS PROVES AND WHAT IT DOES NOT
//  This is the FIRST rung of the ladder, not the last. It proves the
//  service's contract against a stub `db` (the service takes db as a
//  parameter, so its query and mapping are testable without Postgres)
//  plus structural facts about the route module.
//
//  It does NOT prove: real Postgres behaviour, real HTTP status codes,
//  session resolution, or browser rendering. Per §33 this harness alone
//  can never make the slice "Proven" — that needs isolated Postgres,
//  authenticated real HTTP, and browser verification. Do not cite a
//  green run here as more than the source rung.
//
//  ASSERTION FLOOR: set explicitly below, NOT left at the default of 1.
//  The default would let one setup assertion satisfy the whole file —
//  the exact gap recorded in docs/archive/ASSERTION_BOUNDARY_AUDIT.md. Every
//  required semantic case is exercised by name, and the data-driven
//  cases assert on a NON-EMPTY fixture so an empty stub cannot pass.
// ════════════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const receipt = require("../_run_receipt.js");
const svc = require("../../src/agent/ask_spine_service.js");

const EXPECTED_ASSERTIONS = 24;

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ""} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(v, m) { if (!v) throw new Error(m || "expected truthy"); }

//  A stub db that records what it was asked and replays a fixture.
function stubDb(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return { rows }; },
  };
}
function row(over = {}) {
  return Object.assign({
    id: "ob-1", label: "Call the lead back", module: "leasing", type: "lead_response",
    status: "open", due_at: new Date(Date.now() - 3600e3).toISOString(),
    person_id: null, unit_id: null, related_type: null, related_id: null,
    assigned_user_id: null, is_overdue: true, is_unassigned: true, total_open: "1",
  }, over);
}

const PROP = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";

(async () => {
  const started = receipt.begin(__filename, { expected: EXPECTED_ASSERTIONS });

  const routeSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "agent", "ask_spine.js"), "utf8");
  const svcSrc = fs.readFileSync(path.join(__dirname, "..", "..", "src", "agent", "ask_spine_service.js"), "utf8");

  // ── CASE 1 — the session's property determines the read ────────────
  {
    const db = stubDb([row()]);
    const out = await svc.attention(db, { property_id: PROP, allowed_modules: ["leasing"] });
    eq(db.calls.length, 1, "one round trip:");
    T("1a  property_id is bound as a parameter, not interpolated", () => {
      eq(db.calls[0].params[0], PROP);
    });
    T("1b  the query filters on property_id", () => {
      ok(/o\.property_id\s*=\s*\$1/.test(db.calls[0].sql), "expected `o.property_id = $1`");
    });
    T("1c  a non-empty fixture actually produced an item", () => {
      eq(out.items.length, 1);   // guards against an empty-stub false green
    });
    //  attention() is async, so the refusal surfaces as a REJECTION, not a
    //  synchronous throw. Awaiting it is the difference between proving the
    //  guard and proving nothing.
    let threwNoProp = false;
    try { await svc.attention(db, { property_id: null, allowed_modules: ["leasing"] }); }
    catch (_) { threwNoProp = true; }
    T("1d  the service refuses to run without a server-derived property", () => {
      ok(threwNoProp, "expected a rejection when property_id is absent");
    });
  }

  // ── CASE 2 — the client cannot choose another property ─────────────
  T("2a  the route refuses a mismatched client property_id", () => {
    ok(/refuseClientProperty/.test(routeSrc), "gate function missing");
    ok(/property authority is server-derived/.test(routeSrc), "refusal message missing");
    ok(/status\(403\)/.test(routeSrc), "expected a 403 refusal");
  });
  T("2b  the route passes ONLY req.operator values into the service", () => {
    ok(/property_id:\s*req\.operator\.property_id/.test(routeSrc), "property must come from the session");
    ok(/allowed_modules:\s*req\.operator\.allowed_modules/.test(routeSrc), "modules must come from the session");
  });
  T("2c  the service reads property from its argument only — no req/query/body", () => {
    ok(!/req\.|req\b|query\.property_id|body\./.test(svcSrc.replace(/\/\/.*$/gm, "")),
      "service source must not reference request objects");
  });
  T("2d  the echoed property_id is the session's, not the request's", () => {
    ok(/property_id:\s*req\.operator\.property_id,\s*\/\//.test(routeSrc) ||
       /property_id:\s*req\.operator\.property_id/.test(routeSrc));
  });

  // ── CASE 3 — capped at five ────────────────────────────────────────
  {
    const nine = Array.from({ length: 9 }, (_, i) => row({ id: `ob-${i}`, total_open: "9" }));
    const db = stubDb(nine);
    const out = await svc.attention(db, { property_id: PROP, allowed_modules: ["leasing"] });
    T("3a  MAX_ITEMS is 5", () => eq(svc.MAX_ITEMS, 5));
    T("3b  the SQL carries a LIMIT 5", () => ok(/limit\s+5/i.test(db.calls[0].sql)));
    T("3c  a 9-row result is capped to 5 items", () => eq(out.items.length, 5));
    T("3d  total_open still reports the true total, not the capped count", () => eq(out.total_open, 9));
  }

  // ── CASE 4 — valid empty and unavailable are DISTINCT ──────────────
  {
    const db = stubDb([]);
    const out = await svc.attention(db, { property_id: PROP, allowed_modules: ["leasing"] });
    T("4a  a genuine empty result returns items:[] and total_open:0", () => {
      eq(out.items.length, 0); eq(out.total_open, 0);
    });
    T("4b  a genuine empty result does NOT throw", () => ok(out && Array.isArray(out.items)));

    const boom = { async query() { throw new Error("connection reset"); } };
    let threw = false;
    try { await svc.attention(boom, { property_id: PROP, allowed_modules: ["leasing"] }); }
    catch (_) { threw = true; }
    T("4c  a failed read THROWS — it never returns an empty result", () => ok(threw));
    T("4d  the route maps failure to 500, not to an empty payload", () => {
      ok(/status\(500\)/.test(routeSrc));
      ok(/Could not read the work queue/.test(routeSrc));
    });
    T("4e  no module entitlement is an honest empty, not everything", async () => {
      ok(/no_module_entitlement/.test(svcSrc));
    });
  }

  // ── CASE 5 — only SUPPORTED navigation metadata is returned ────────
  {
    const db = stubDb([
      row({ id: "p", person_id: "person-1" }),
      row({ id: "a", related_type: "application", related_id: "app-1" }),
      row({ id: "d", module: "maintenance" }),
      row({ id: "n", module: "accounting" }),
      row({ id: "u", unit_id: "unit-9", module: "accounting" }),
    ]);
    const out = await svc.attention(db, { property_id: PROP, allowed_modules: ["leasing", "maintenance", "accounting"] });
    const by = Object.fromEntries(out.items.map((i) => [i.obligation_id, i]));
    T("5a  a person-backed item opens the verified person opener", () => {
      eq(by.p.open.kind, "person"); eq(by.p.open.id, "person-1");
    });
    T("5b  an application-backed item opens the verified application opener", () => {
      eq(by.a.open.kind, "application"); eq(by.a.open.id, "app-1");
    });
    T("5c  a module with a real desk maps to that desk", () => {
      eq(by.d.open.kind, "desk"); eq(by.d.open.id, "maintenance");
    });
    T("5d  a module with NO desk emits no navigation rather than a guess", () => {
      eq(by.n.open, null);
    });
    T("5e  a unit is returned as context but NEVER as a link (no unit opener exists)", () => {
      eq(by.u.unit_id, "unit-9");
      eq(by.u.open, null);
      ok(!/kind:\s*["']unit["']/.test(svcSrc), "service must not emit a unit navigation kind");
    });
  }

  // ── CASE 6 — no write, no staff-agent proposal ─────────────────────
  T("6a  the route registers GET only — no POST/PUT/PATCH/DELETE", () => {
    ok(/router\.get\(/.test(routeSrc));
    ok(!/router\.(post|put|patch|delete)\(/.test(routeSrc), "a non-GET verb appeared");
  });
  T("6b  neither module requires staff_agent", () => {
    ok(!/require\(["'].*staff_agent["']\)/.test(routeSrc));
    ok(!/staff_agent_service/.test(routeSrc + svcSrc));
  });
  T("6c  the service issues no INSERT/UPDATE/DELETE and opens no transaction", () => {
    const sqlish = svcSrc.replace(/\/\/.*$/gm, "").replace(/^\s*--.*$/gm, "");
    ok(!/\binsert\s+into\b/i.test(sqlish), "INSERT found");
    ok(!/\bupdate\s+\w+\s+set\b/i.test(sqlish), "UPDATE found");
    ok(!/\bdelete\s+from\b/i.test(sqlish), "DELETE found");
    ok(!/\bbegin\b|\bcommit\b/i.test(sqlish), "transaction control found");
  });
  T("6d  the operator's question is not recorded anywhere", () => {
    ok(!/captureMessage|team_messages|agent_messages/.test(routeSrc + svcSrc));
  });

  // ── CASE 7 — cross-property obligations are excluded ───────────────
  {
    const db = stubDb([row()]);
    await svc.attention(db, { property_id: PROP, allowed_modules: ["leasing"] });
    T("7a  only the session property is bound — the other property never appears", () => {
      const flat = JSON.stringify(db.calls[0].params);
      ok(flat.includes(PROP), "session property missing from params");
      ok(!flat.includes(OTHER), "a second property reached the query");
    });
    T("7b  the query has no path that omits the property predicate", () => {
      const sql = db.calls[0].sql;
      ok(/where[\s\S]*o\.property_id\s*=\s*\$1/i.test(sql), "property predicate is not unconditional");
      ok(!/property_id\s*=\s*any/i.test(sql), "property must be a single bound value");
    });
    T("7c  module entitlement is applied as a bound array, not interpolated", () => {
      ok(/o\.module\s*=\s*any\(\$2::text\[\]\)/.test(db.calls[0].sql));
      ok(Array.isArray(db.calls[0].params[1]));
    });
  }

  // ── ranking tiers are the documented ones ──────────────────────────
  T("8a  the four documented tiers are the only ranking, and there is no score", () => {
    ok(/overdue_unassigned/.test(svcSrc));
    ok(/["']overdue["']/.test(svcSrc));
    ok(/["']unassigned["']/.test(svcSrc));
    ok(/due_soonest/.test(svcSrc));
    ok(!/score|weight|rank_value/i.test(svcSrc.replace(/\/\/.*$/gm, "")), "a score-like concept appeared");
  });
  T("8b  no money, proof, blockage or waiting inference exists", () => {
    const body = svcSrc.replace(/\/\/.*$/gm, "");
    ok(!/money|amount|dollar|at_risk/i.test(body), "money inference found");
    ok(!/blocked_reason|waiting_on|missing_proof/i.test(body), "unsupported inference found");
  });

  process.exit(receipt.complete({
    harness: __filename, passed: pass, failed: fail,
    expectedAtLeast: EXPECTED_ASSERTIONS,
  }));
})().catch((e) => { receipt.died(__filename, e, pass + fail); process.exit(1); });
