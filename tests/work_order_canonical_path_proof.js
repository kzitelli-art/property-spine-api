// ════════════════════════════════════════════════════════════════════
//  work_order_canonical_path_proof.js
//
//  WHAT THIS PROTECTS
//  ------------------
//  work_order_service.js carries a signed-off ruling in its own header:
//  "every work order — tenant, operator, or future channel — flows through
//  this service." The code did not honour it. `makeWorkOrderService` was
//  defined and exported and never constructed anywhere in the repo, while
//  BOTH consumers destructured `workOrderService` out of their injected
//  deps and called it:
//
//    maintenance.js:26  const { pool, spawnObligationFromEvent, workOrderService } = deps
//    maintenance.js:232 await workOrderService.createWorkOrder(...)
//    server.js:3243     maintenanceModule({ pool, spawnObligationFromEvent })   ← no service
//
//    tenantlink.js:72   function tenantLinkModule({ ..., workOrderService, ... })
//    tenantlink.js:158  await workOrderService.createWorkOrder(...)
//    server.js:3339     tenantLinkModule({ pool, anthropic, ..., getAgentService })  ← no service
//
//  So every POST /work-orders threw TypeError on undefined, was swallowed by
//  the route's own catch, and returned 500. Demo Building has zero work
//  orders; the only six in existence predate the refactor. The module also
//  asserted `pool` and `spawnObligationFromEvent` at construction but NOT
//  `workOrderService` — so it booted green and failed only when pressed.
//  Green boot is not a proven route.
//
//  The second defect is the one that makes fixing the first dangerous alone.
//  TWO functions named deriveCategories existed and disagreed:
//    maintenance.js:148        the real three-layer engine (billback/capex/turn)
//    work_order_service.js:44  a stub — always resident_repair, never capex,
//                              never billback, ignores unit_state and cause
//  The stub is the one inside createWorkOrder, so it is what runs. The real
//  engine was reachable only through GET /maintenance/preview-category.
//  An operator would preview "tenant billback", save, and get an ordinary
//  resident repair — money that belongs on a resident silently expensed to
//  the property. Wiring the service without collapsing these two turns a
//  dead route into a quietly wrong one, which is worse.
//
//  Layer C is therefore an AGREEMENT test, not a policy test. The policy may
//  change; preview and write agreeing may not.
//
//  SCOPE SAFETY
//  ------------
//  This harness creates its OWN scratch property and deletes only tracked
//  ids behind a name guard. It never touches Demo Building. (Precedent:
//  agent_booking_xturn_proof.js, after a property-wide DELETE destroyed 19
//  real demo tour slots on 2026-07-25.)
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/work_order_canonical_path_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PROP = crypto.randomUUID();
const PROP_NAME = `__WOPROOF__P ${PROP.slice(0, 8)}`;
const PROP_SMS = "+1555" + Math.floor(1e6 + Math.random() * 8e6);

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`); }

// ── Tracked ids. Cleanup deletes ONLY these, behind a name guard. ──
const track = { work_orders: [], events: [], obligations: [] };

// ── A faithful-enough stand-in for server.js's obligation engine.
//    server.js owns the real ownership resolver (role → eligible assignment →
//    coverage → one accountable human or honest UNASSIGNED). That resolver is
//    NOT under test here. What IS under test is the SPEC the service composes
//    and hands it. So this inserts every field the spec carries, verbatim, and
//    the assertions below read those fields back.
async function spawnObligationFromEvent(client, o) {
  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id, source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role, status, priority, severity,
        due_at, required_inputs, related_id, related_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [o.property_id, o.person_id ?? null, o.unit_id ?? null, o.source_event_id ?? null,
     o.module, o.type, o.label, o.owner_type ?? "human",
     o.assigned_role ?? null, o.escalates_to_role ?? null,
     o.status ?? "open", o.priority ?? "normal", o.severity ?? "normal",
     // required_inputs is NOT NULL. server.js:196 defaults it to [] and always
     // writes an array literal; this stand-in must do the same or it invents a
     // failure the real engine would never produce.
     o.due_at ?? null, o.required_inputs ?? [],
     o.related_id ?? null, o.related_type ?? null]
  );
  track.obligations.push(r.rows[0].id);
  return r.rows[0];
}

let srv, base;

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function woRow(id) {
  return (await pool.query("select * from work_orders where id=$1", [id])).rows[0];
}

// ════════════════════════════════════════════════════════════════════
async function main() {
  // Mount the maintenance router with EXACTLY the dependency set server.js
  // passes it today. If that set is insufficient, this harness must fail —
  // that is the whole point. Nothing here is allowed to "help" the module by
  // injecting something server.js does not.
  const maintenanceModule = require("../src/maintenance/maintenance.js");

  await pool.query(
    `insert into properties (id,name,sms_number) values ($1,$2,$3)`,
    [PROP, PROP_NAME, PROP_SMS]
  );
  lines.push(`  scratch property ${PROP} (${PROP_NAME})`);

  section("A · the module cannot boot half-wired");
  // Construct with EXACTLY the dependency set server.js:3243 passes today.
  // Nothing here is allowed to "help" the module by injecting something
  // server.js does not — that is the whole point of this layer.
  let halfWired = null, ctorThrew = null;
  try {
    halfWired = maintenanceModule({ pool, spawnObligationFromEvent });
  } catch (e) {
    ctorThrew = e.message;
  }
  ok("A1. constructing without workOrderService throws at BOOT, not at first POST",
    ctorThrew !== null && /workOrderService|work_order_service/i.test(ctorThrew || ""),
    ctorThrew === null
      ? "constructed cleanly with no service — the green-boot / dead-route trap is open"
      : `threw, but not about the service: ${ctorThrew}`);

  // A2 — the cost of that trap, proven by execution rather than inferred.
  //
  //  A2 ALWAYS RUNS AND ALWAYS COUNTS. It has two valid shapes and asserts in
  //  both, because "an assertion disappeared once the bug was fixed" is
  //  indistinguishable from an assertion that was quietly skipped:
  //
  //    constructor refused    → assert the half-wired router does not EXIST,
  //                             i.e. the failure mode is unenterable
  //    constructor succeeded  → assert the route it exposes does not 500
  //
  //  Either way the total assertion count is identical pre-fix and post-fix,
  //  so a regression cannot hide inside a shrinking denominator.
  if (halfWired) {
    const deadApp = express();
    deadApp.use(express.json());
    deadApp.use("/", halfWired);
    const deadSrv = http.createServer(deadApp);
    await new Promise((r) => deadSrv.listen(0, r));
    const deadBase = `http://127.0.0.1:${deadSrv.address().port}`;
    let st = null, bd = null;
    try {
      const res = await fetch(`${deadBase}/work-orders`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          property_id: PROP, title: "half-wired probe",
          is_emergency: true, emergency_type: "active_leak",
        }),
      });
      st = res.status;
      bd = JSON.stringify(await res.json().catch(() => ({}))).slice(0, 160);
    } catch (e) {
      st = `threw: ${e.message}`;
    }
    await new Promise((r) => deadSrv.close(r));
    ok("A2. the half-wired failure mode is unreachable (no router exists to serve it)",
      st !== 500,
      `a half-wired router EXISTS and its create route returns status=${st} body=${bd}` +
      ` — as mounted by server.js:3243, the canonical work-order path is DEAD`);
  } else {
    // Same assertion, other shape: prove there is no half-wired router to
    // enter, rather than reporting the check as skipped.
    ok("A2. the half-wired failure mode is unreachable (no router exists to serve it)",
      halfWired === null && ctorThrew !== null,
      `expected no router and a construction error; got router=${halfWired} err=${ctorThrew}`);
  }

  // Now build the router the way a FIXED server.js must: with the service.
  const { makeWorkOrderService } = require("../src/maintenance/work_order_service.js");
  const workOrderService = makeWorkOrderService({ spawnObligationFromEvent });
  const router = maintenanceModule({ pool, spawnObligationFromEvent, workOrderService });

  const app = express();
  app.use(express.json());
  app.use("/", router);
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;

  // ════════ B · THE ROUTE ACTUALLY CREATES A WORK ORDER ══════════════
  section("B · POST /work-orders over real HTTP");
  const em = await post("/work-orders", {
    property_id: PROP,
    title: "Water pouring from ceiling in 304",
    description: "Resident reports active leak, water coming through light fixture.",
    field_category: "plumbing",
    unit_state: "occupied",
    is_emergency: true,
    emergency_type: "active_leak",
  });
  if (em.json && em.json.work_order) track.work_orders.push(em.json.work_order.id);
  if (em.json && em.json.event) track.events.push(em.json.event.id);

  ok("B1. THE ONE THAT MATTERS — an emergency work order is created, not 500",
    em.status === 201 && !!(em.json && em.json.work_order),
    `status=${em.status} body=${JSON.stringify(em.json).slice(0, 300)}`);

  ok("B2. the description is stored VERBATIM — never rewritten",
    !!em.json.work_order &&
      em.json.work_order.description === "Resident reports active leak, water coming through light fixture.");

  ok("B3. urgency truth is recorded with its provenance, not just a boolean",
    !!em.json.work_order &&
      em.json.work_order.urgency_status === "emergency" &&
      em.json.work_order.is_emergency === true &&
      em.json.work_order.urgency_decided_by === "operator" &&
      em.json.work_order.urgency_decided_at !== null,
    JSON.stringify(em.json.work_order && {
      s: em.json.work_order.urgency_status,
      by: em.json.work_order.urgency_decided_by,
      at: em.json.work_order.urgency_decided_at,
    }));

  ok("B4. a trigger event exists — the obligation is born only from an event",
    !!em.json.event && em.json.event.type === "emergency_work_order",
    JSON.stringify(em.json.event && { type: em.json.event.type }));

  ok("B5. every work order gets a routing obligation (owner or honest UNASSIGNED)",
    !!em.json.obligation && em.json.obligation.related_type === "work_order" &&
      em.json.obligation.related_id === (em.json.work_order || {}).id,
    JSON.stringify(em.json.obligation && {
      type: em.json.obligation.type, rel: em.json.obligation.related_type,
    }));

  ok("B6. the emergency obligation carries emergency severity and the escalation role",
    !!em.json.obligation && em.json.obligation.type === "emergency_repair" &&
      em.json.obligation.severity === "emergency" &&
      em.json.obligation.priority === "high" &&
      em.json.obligation.escalates_to_role === "property_manager",
    JSON.stringify(em.json.obligation && {
      t: em.json.obligation.type, sev: em.json.obligation.severity,
      pri: em.json.obligation.priority, esc: em.json.obligation.escalates_to_role,
    }));

  // active_leak is the `immediate` tier → due now, not in 24h.
  ok("B7. an immediate-tier emergency is due NOW, not on the default clock",
    !!em.json.obligation && em.json.obligation.due_at !== null &&
      (new Date(em.json.obligation.due_at).getTime() - Date.now()) < 5 * 60 * 1000,
    JSON.stringify(em.json.obligation && { due_at: em.json.obligation.due_at }));

  // ── an emergency with no type must be refused, with the vocabulary ──
  const bad = await post("/work-orders", {
    property_id: PROP, title: "something urgent", is_emergency: true,
  });
  ok("B8. an emergency with no emergency_type is refused and names the allowed set",
    bad.status === 400 && Array.isArray(bad.json.allowed) && bad.json.allowed.includes("active_leak"),
    `status=${bad.status} body=${JSON.stringify(bad.json).slice(0, 200)}`);

  // ── a regular work order routes differently ──
  const reg = await post("/work-orders", {
    property_id: PROP, title: "Closet door off track",
    field_category: "general", unit_state: "occupied",
  });
  if (reg.json && reg.json.work_order) track.work_orders.push(reg.json.work_order.id);
  if (reg.json && reg.json.event) track.events.push(reg.json.event.id);

  ok("B9. a regular work order is created and routed as normal, not emergency",
    reg.status === 201 && reg.json.work_order.urgency_status === "regular" &&
      reg.json.obligation.type === "maintenance_repair" &&
      reg.json.obligation.severity === "normal",
    `status=${reg.status} ${JSON.stringify(reg.json.obligation && {
      t: reg.json.obligation.type, sev: reg.json.obligation.severity })}`);

  ok("B10. a regular work order still gets an event trail",
    !!reg.json.event && reg.json.event.type === "work_order_opened",
    JSON.stringify(reg.json.event && { type: reg.json.event.type }));

  // ════════ C · PREVIEW AND WRITE AGREE ═════════════════════════════
  //  The assertions here are about AGREEMENT, not about any particular
  //  category policy. If the policy changes, these still hold.
  section("C · the category shown equals the category saved");

  const cases = [
    { label: "tenant damage bills back to the resident",
      q: { field_category: "drywall", unit_state: "occupied", cause: "tenant_damage" },
      expect: { operating_category: "tenant_billback", billback: true, is_capex: false } },
    { label: "renovation work is capital, not an expense",
      q: { field_category: "flooring", unit_state: "renovation", cause: "wear" },
      expect: { operating_category: "capital", is_capex: true, billback: false } },
    { label: "work in a vacant unit is turn cost",
      q: { field_category: "paint", unit_state: "vacant", cause: "wear" },
      expect: { operating_category: "turn", is_capex: false, billback: false } },
    { label: "ordinary occupied repair stays a resident repair",
      q: { field_category: "plumbing", unit_state: "occupied", cause: "wear" },
      expect: { operating_category: "resident_repair", is_capex: false, billback: false } },
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const qs = new URLSearchParams(c.q).toString();
    const pv = await get(`/maintenance/preview-category?${qs}`);

    const saved = await post("/work-orders", {
      property_id: PROP, title: `Category case ${i + 1}`, ...c.q,
    });
    if (saved.json && saved.json.work_order) track.work_orders.push(saved.json.work_order.id);
    if (saved.json && saved.json.event) track.events.push(saved.json.event.id);

    const row = saved.json.work_order ? await woRow(saved.json.work_order.id) : null;
    const d = pv.json && pv.json.derived;

    ok(`C${i + 1}a. preview derives it right — ${c.label}`,
      !!d && d.operating_category === c.expect.operating_category &&
        d.is_capex === c.expect.is_capex && d.billback === c.expect.billback,
      JSON.stringify(d));

    ok(`C${i + 1}b. THE SAVED ROW MATCHES THE PREVIEW — ${c.label}`,
      !!row && !!d &&
        row.operating_category === d.operating_category &&
        row.gl_category === d.gl_category &&
        row.is_capex === d.is_capex &&
        row.billback === d.billback,
      `preview=${JSON.stringify(d)} saved=${JSON.stringify(row && {
        operating_category: row.operating_category, gl_category: row.gl_category,
        is_capex: row.is_capex, billback: row.billback })}`);
  }

  // ════════ D · THE PROOF GATE AND THE CONTINUITY ENGINE ════════════
  section("D · closeout cannot lie");
  const target = track.work_orders[track.work_orders.length - 1];

  const noProof = await fetch(`${base}/work-orders/${target}/closeout`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: true, completion_note: "fixed it" }),
  });
  const noProofJson = await noProof.json().catch(() => ({}));
  ok("D1. a work order cannot close without photo proof",
    noProof.status === 409 && Array.isArray(noProofJson.required_inputs) &&
      noProofJson.required_inputs.includes("completion_photo"),
    `status=${noProof.status} body=${JSON.stringify(noProofJson).slice(0, 200)}`);

  const badReason = await fetch(`${base}/work-orders/${target}/closeout`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: false, not_done_reason: "because_i_said_so" }),
  });
  const badReasonJson = await badReason.json().catch(() => ({}));
  ok("D2. an unknown not-done reason is REJECTED, never silently coerced",
    badReason.status === 400 && Array.isArray(badReasonJson.allowed) &&
      badReasonJson.allowed.includes("need_vendor"),
    `status=${badReason.status} body=${JSON.stringify(badReasonJson).slice(0, 200)}`);

  const stalled = await fetch(`${base}/work-orders/${target}/closeout`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ done: false, not_done_reason: "need_vendor" }),
  });
  const stalledJson = await stalled.json().catch(() => ({}));
  if (stalledJson.followup_obligation) track.obligations.push(stalledJson.followup_obligation.id);

  ok("D3. a stalled job stays open and produces a NAMED next step with an owner",
    stalled.status === 200 &&
      stalledJson.work_order.status === "needs_followup" &&
      stalledJson.work_order.needs_pm_review === true &&
      stalledJson.work_order.not_done_reason === "need_vendor" &&
      !!stalledJson.followup_obligation &&
      stalledJson.followup_obligation.type === "vendor_quote" &&
      stalledJson.followup_obligation.assigned_role === "property_manager",
    `status=${stalled.status} ${JSON.stringify({
      wo: stalledJson.work_order && stalledJson.work_order.status,
      reason: stalledJson.work_order && stalledJson.work_order.not_done_reason,
      ob: stalledJson.followup_obligation && stalledJson.followup_obligation.type,
      role: stalledJson.followup_obligation && stalledJson.followup_obligation.assigned_role })}`);

  ok("D4. the stall reason lives in its own column, not jammed into the completion note",
    stalledJson.work_order && stalledJson.work_order.completion_note === null,
    JSON.stringify(stalledJson.work_order && { note: stalledJson.work_order.completion_note }));
}

// ════════════════════════════════════════════════════════════════════
async function cleanup() {
  lines.push("");
  try {
    if (track.obligations.length)
      await pool.query("delete from obligations where id = any($1::uuid[])", [track.obligations]);
    if (track.work_orders.length)
      await pool.query("delete from work_orders where id = any($1::uuid[])", [track.work_orders]);
    if (track.events.length)
      await pool.query("delete from events where id = any($1::uuid[])", [track.events]);
    // Belt and braces: anything left on the scratch property, then the property
    // itself — tracked id AND a name guard, so this can never widen.
    await pool.query("delete from obligations where property_id=$1", [PROP]);
    await pool.query("delete from work_orders where property_id=$1", [PROP]);
    await pool.query("delete from events where property_id=$1", [PROP]);
    const gone = await pool.query(
      "delete from properties where id=$1 and name like '__WOPROOF__P %'", [PROP]);
    lines.push(`  cleanup complete. scratch property removed: ${gone.rowCount}`);
  } catch (e) {
    lines.push(`  CLEANUP FAILED — scratch property ${PROP} may remain: ${e.message}`);
  }
}

(async () => {
  try {
    await main();
  } catch (e) {
    failed++;
    lines.push(`\n  FAIL  harness threw: ${e.message}\n        ${(e.stack || "").split("\n")[1] || ""}`);
  } finally {
    await cleanup();
    try { if (srv) srv.close(); } catch (_) {}
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(70);
  console.log(`\n${bar}\nWORK ORDER — THE ONE CANONICAL PATH\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "The canonical work-order path is not whole. Fix the failures above and re-run."
    : "A work order can be created, is categorized as previewed, and cannot close without proof.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
})();
