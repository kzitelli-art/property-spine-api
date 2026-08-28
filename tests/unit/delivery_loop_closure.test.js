#!/usr/bin/env node
/**
 * DELIVERY LOOP CLOSURE PROOF
 *
 * The move_in_delivery obligation (born at confirm-term) has two hard gates:
 * unit_ready and keys_access_ready. Maintenance readiness approval feeds
 * unit_ready; before this build, NOTHING fed keys_access_ready and NOTHING
 * called completeDeliveryIfReady — the PM's delivery promise was born
 * uncompletable. This harness proves the closure:
 *
 *   PART 1 — behavioral: delivery.js's REAL code run against a stub pg
 *            client (satisfy → idempotent replay → refuse-complete-while-
 *            gated → complete-when-cleared → no-op safety).
 *   PART 2 — static: the operator keys-ready door exists, is session-authed,
 *            walls the property, fails closed without the helper, and
 *            server.js injects the SAME helper instance movein.js uses.
 *
 * Claim ceiling: PART 1 is locally-exercised (real module, stub Postgres).
 * PART 2 is static wiring proof. Neither is proven-live; the live proof is
 * a real keys-ready POST after a real confirm-term.
 *
 * Run from the repo root:  node delivery_loop_closure.test.js
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
};

console.log("\nDELIVERY LOOP CLOSURE PROOF\n");

// ═══════════════ PART 1 — delivery.js behavioral (real code, stub pg) ═══════════════
console.log("1. delivery.js behavior (real module against a stub client)");

// stub obligation store — one row, mutated the way satisfy/complete would
const store = {
  row: null,
  reset(inputs) {
    this.row = {
      id: "OB-1", related_id: "LEASE-1", related_type: "lease",
      type: "move_in_delivery", status: "open",
      required_inputs: inputs.slice(),
    };
  },
};

const stubSatisfy = async (_c, { obligation_id, input }) => {
  if (!store.row || store.row.id !== obligation_id) throw new Error("no such obligation");
  const i = store.row.required_inputs.indexOf(input);
  if (i < 0) { const e = new Error("not outstanding"); e.code = "NOT_OUTSTANDING"; throw e; }
  store.row.required_inputs.splice(i, 1);
};
const stubComplete = async (_c, { obligation_id }) => {
  if (!store.row || store.row.id !== obligation_id) throw new Error("no such obligation");
  if (store.row.required_inputs.length > 0) { const e = new Error("gated"); e.code = "GATED"; throw e; }
  if (store.row.status === "complete") { const e = new Error("done"); e.code = "ALREADY_COMPLETE"; throw e; }
  store.row.status = "complete";
};
// 089: delivery cannot complete before a real possession event. The stub
// answers the possession lookup; tests flip it to prove both sides.
let POSSESSION = null;   // null = keys never handed over
const stubClient = {
  query: async (sql, params) => {
    if (/from unit_events/.test(sql)) {
      return { rows: POSSESSION ? [POSSESSION] : [] };
    }
    if (/from obligations/.test(sql)) {
      const open = store.row && ["open", "in_progress"].includes(store.row.status)
        && store.row.related_id === params[0];
      return { rows: open ? [JSON.parse(JSON.stringify(store.row))] : [] };
    }
    return { rows: [] };
  },
};

(async () => {
  const helper = require(path.join(__dirname, "..", "..", "src", "comms", "delivery.js"))({
    satisfyObligation: stubSatisfy, completeObligation: stubComplete,
  });

  // the exact production sequence: confirm-term births both gates
  store.reset(["unit_ready", "keys_access_ready"]);

  // maintenance readiness approval feeds unit_ready (movein.js hook)
  let r = await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-1", input_key: "unit_ready", source: "rent_ready_approval" });
  ok("readiness approval satisfies unit_ready", r.satisfied === true);

  // completing now must refuse — keys gate still open
  r = await helper.completeDeliveryIfReady(stubClient, { lease_id: "LEASE-1" });
  ok("complete refuses while keys_access_ready is outstanding",
    r.completed === false && (r.remaining || []).includes("keys_access_ready"));

  // the PM door feeds keys_access_ready
  r = await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-1", input_key: "keys_access_ready", source: "operator_keys_ready" });
  ok("the PM action satisfies keys_access_ready", r.satisfied === true);

  // 089 RULING: clearing the gates is no longer sufficient. Preparation and
  // handoff are different truths — delivery cannot complete until an
  // authenticated human actually handed over keys.
  POSSESSION = null;
  r = await helper.completeDeliveryIfReady(stubClient, { lease_id: "LEASE-1" });
  ok("all gates cleared but NO possession → refuses (089)",
    r.completed === false && r.reason === "possession_outstanding" &&
    (r.remaining || []).includes("keys_handed_over"));
  ok("…and the obligation stays open", store.row.status === "open");

  // keys handed over → a real possession event exists
  POSSESSION = { id: "ue-1", space_id: "sp-1", effective_date: "2026-07-22" };
  r = await helper.completeDeliveryIfReady(stubClient, { lease_id: "LEASE-1", completed_by: "PM-1" });
  ok("gates cleared + possession recorded → delivery completes",
    r.completed === true && r.obligation_id === "OB-1" && r.possession_event_id === "ue-1");
  ok("obligation left in complete state", store.row.status === "complete");

  // replay safety: the obligation is closed, so a re-fire is a clean no-op
  r = await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-1", input_key: "keys_access_ready" });
  ok("replay after completion is a safe no-op", r.noop === true);
  POSSESSION = null;
  r = await helper.completeDeliveryIfReady(stubClient, { lease_id: "LEASE-1" });
  ok("re-complete after completion is a safe no-op", r.completed === false && r.noop === true);

  // idempotency mid-flight: same input twice
  store.reset(["unit_ready", "keys_access_ready"]);
  POSSESSION = null;
  await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-1", input_key: "keys_access_ready" });
  r = await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-1", input_key: "keys_access_ready" });
  ok("double-tap on the same input is idempotent", r.noop === true && /not outstanding/.test(r.reason));

  // legacy/no-lease path
  r = await helper.satisfyDeliveryInput(stubClient, { lease_id: null, input_key: "unit_ready" });
  ok("missing lease link is a safe no-op (legacy path)", r.noop === true);
  r = await helper.satisfyDeliveryInput(stubClient, { lease_id: "LEASE-NONE", input_key: "unit_ready" });
  ok("no open delivery obligation is a safe no-op", r.noop === true);

  // ═══════════════ PART 2 — static wiring of the door ═══════════════
  console.log("\n2. Operator door wiring (static)");
  const op = fs.readFileSync(path.join(__dirname, "..", "..", "src", "identity", "operator.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");

  const doorAt = op.indexOf('"/operator/leasing/leases/:leaseId/delivery/keys-ready"');
  ok("the keys-ready door exists", doorAt > 0);
  const door = doorAt > 0 ? op.slice(doorAt, doorAt + 3600) : "";
  ok("session-authed (requireOperator + module access)",
    /requireOperator,\s*requireLeasingModuleAccess/.test(op.slice(doorAt - 120, doorAt + 200)));
  ok("no birth gate on a drain door (no activation perimeter middleware)",
    !/Perimeter/.test(op.slice(doorAt - 200, doorAt + 120)));
  ok("fails closed 503 when the helper is not injected",
    /503[\s\S]{0,200}?deploy delivery\.js, operator\.js, and server\.js together/i.test(door));
  ok("property wall: the lease row decides, before any write",
    door.indexOf("select id, property_id from leases") >= 0 &&
    door.indexOf("select id, property_id from leases") < door.indexOf("satisfyDeliveryInput(client") &&
    /403[\s\S]{0,120}different property/.test(door));
  ok("feeds keys_access_ready with server-derived actor",
    /input_key:\s*"keys_access_ready"/.test(door) && /actor:\s*req\.operator\.id/.test(door));
  ok("attempts completion in the same transaction",
    door.indexOf("completeDeliveryIfReady") > door.indexOf("satisfyDeliveryInput") &&
    door.indexOf('client.query("commit")') > door.indexOf("completeDeliveryIfReady"));
  ok("honest 404 when no open delivery exists (rollback, no ghost write)",
    /no open move_in_delivery obligation[\s\S]{0,220}rollback|rollback[\s\S]{0,220}No open move-in delivery obligation/.test(door));
  ok("plain-language receipt names remaining gates",
    /remaining_gates/.test(door) && /Remaining gate/.test(door));

  ok("operator.js accepts the deliveryHelper dep", /deps\.deliveryHelper \|\| null/.test(op));
  ok("server.js injects deliveryHelper into the operator module",
    /operatorModule\(\{[\s\S]{0,2500}deliveryHelper,/.test(srv));
  // Line-ending agnostic: the repo has no .gitattributes, so a Windows checkout
  // is CRLF while Render builds LF. A literal "\n" match here passed in CI and
  // failed locally on Windows — a false negative, not a real defect.
  const declLine = srv.indexOf("const deliveryHelper = require");
  const injLine = srv.search(/deliveryHelper,\r?\n\s*leasePacketsService/);
  ok("same helper instance as movein.js (declared before both mounts)",
    declLine > 0 && injLine > declLine && /moveinModule\(\{[^\r\n]*deliveryHelper/.test(srv));

  console.log("\n" + "-".repeat(52));
  console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("harness error:", e); process.exit(1); });
