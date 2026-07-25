#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const queue = require(path.resolve(process.argv[2] || path.join(__dirname, "..", "src", "tenancy", "move_in_queue.js")));
const routeFile = process.argv[3] || path.join(__dirname, "..", "src", "tenancy", "movein.js");
// Fail loudly if the route source is missing. It previously degraded to "" —
// every route assertion then failed for the wrong reason, saying nothing about
// why. A test that cannot find its subject must say so, not report a defect.
if (!fs.existsSync(routeFile)) {
  console.error("CANNOT LOCATE ROUTE SOURCE: " + routeFile);
  process.exit(2);
}
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name); } }

(async () => {
  const q = queue._internal;
  ok("window clamps high", q.boundedInt(9999, 60, 0, 365) === 365);
  ok("limit clamps low", q.boundedInt(0, 100, 1, 200) === 1);
  ok("handoff outranks forward", q.priorityFor("ready_for_handoff") < q.priorityFor("forward_lease"));
  ok("unknown states fail to bottom", q.priorityFor("unknown_future_state") === 999);
  ok("completed class exact", q.queueClass("possession_delivered") === "completed");
  ok("forward class exact", q.queueClass("forward_lease") === "forward");

  const sqlCalls = [];
  const client = { query: async (sql, params) => {
    sqlCalls.push({ sql, params });
    return { rows: [
      { lease_id: "lease-forward", application_id: "app-forward" },
      { lease_id: "lease-ready", application_id: "app-ready" },
      { lease_id: "lease-done", application_id: "app-done" },
    ] };
  }};
  const states = {
    "lease-forward": { lease:{ id:"lease-forward", property_id:"p1", start_date:"2026-09-01", unit_number:"3" }, state:"forward_lease", primary_action:{code:"none_until_start"}, blockers:[] },
    "lease-ready": { lease:{ id:"lease-ready", property_id:"p1", start_date:"2026-07-20", unit_number:"2" }, state:"ready_for_handoff", primary_action:{code:"keys_handed_over",method:"POST"}, blockers:[] },
    "lease-done": { lease:{ id:"lease-done", property_id:"p1", start_date:"2026-07-01", unit_number:"1" }, state:"possession_delivered", primary_action:{code:"view_completed_move_in"}, blockers:[] },
  };
  const compose = async (_client, id) => states[id];
  const out = await queue.readMoveInQueue(client, { propertyId:"p1", windowDays:60, limit:50, composeMoveInState:compose });
  ok("completed excluded by default", out.items.length === 2 && !out.items.some(x => x.state === "possession_delivered"));
  ok("actionable sorts first", out.items[0].state === "ready_for_handoff");
  ok("application correlation retained", out.items[0].application_id === "app-ready");
  ok("summary counts attention", out.summary.needs_attention === 1 && out.summary.forward === 1);
  ok("query bound to property", sqlCalls[0].params[0] === "p1" && /l\.property_id=\$1/.test(sqlCalls[0].sql));
  ok("historical active leases fenced", sqlCalls[0].sql.includes("economic_tenancy_activated_at"));
  const withDone = await queue.readMoveInQueue(client, { propertyId:"p1", includeCompleted:true, composeMoveInState:compose });
  ok("completed opt-in works", withDone.items.some(x => x.state === "possession_delivered"));

  const route = fs.existsSync(routeFile) ? fs.readFileSync(routeFile, "utf8") : "";
  ok("canonical queue route present", route.includes('router.get("/operator/leasing/move-ins"'));
  ok("route uses session property only", route.includes("propertyId: req.operator.property_id") && !route.includes("propertyId: req.query.property_id"));
  ok("queue read is repeatable-read", route.includes("repeatable read read only"));
  ok("route is session authenticated", route.includes('requireOperator(["leasing", "management", "maintenance"])'));

  console.log(`${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
