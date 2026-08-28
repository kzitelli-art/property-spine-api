"use strict";

const assert = require("assert");
const equityRoutes = require("../../src/asset/equity_routes.js");
const service = require("../../src/asset/equity_position_service.js");
const read = require("../../src/asset/equity_position_read.js");

function standingHandler() {
  const pass = (_req, _res, next) => next();
  const router = equityRoutes({
    pool: {}, requireOperator: pass, refuseClientAuthority: pass,
    requireAssetManagementModule: pass,
  });
  const route = router.stack.find((layer) => layer.route && layer.route.path === "/operator/equity/standing");
  return route.route.stack[route.route.stack.length - 1].handle;
}

async function invoke(handler) {
  let body = null;
  const res = {
    status() { return this; },
    json(value) { body = value; return this; },
  };
  await handler({ operator: { property_id: "property-a" } }, res);
  return body;
}

(async () => {
  const handler = standingHandler();
  service.loadHistory = async () => ({ positions: [] });
  const empty = await invoke(handler);
  assert.strictEqual(empty.ownership_reconciliation.truth_state, "NOT_ESTABLISHED");
  assert.strictEqual(empty.ownership_reconciliation.current_total_percent, null);

  const reconciliation = {
    truth_state: "INCOMPLETE", target_percent: 100, current_total_percent: 77.57,
    issuer_groups: [], why: "one or more issuer ownership schedules are incomplete",
  };
  service.loadHistory = async () => ({ positions: [{ id: "position-a" }] });
  read.position = () => ({ positions: [], conflicts: [], coverage_gaps: [],
    ownership_reconciliation: reconciliation });
  read.standingProjection = () => ({ truth_state: "PARTIALLY_ESTABLISHED" });
  const populated = await invoke(handler);
  assert.strictEqual(populated.ownership_reconciliation, reconciliation);
  assert.strictEqual(populated.ownership_reconciliation.current_total_percent, 77.57);

  console.log("Equity route contract: 5/5");
})().catch((error) => { console.error(error); process.exit(1); });
