// ════════════════════════════════════════════════════════════════════
//  obligation_engine_one_implementation.test.js
//
//  Pins the fix for a real incident: tests/_engine.js was a hand-maintained
//  COPY of the obligation engine and had drifted PERMISSIVE — missing the
//  reserved-input guard, the conversion-rail guard, and five columns including
//  dedupe_key. Harnesses were asserting against an engine weaker than
//  production, so a test could pass on behaviour the real system refuses.
//
//  This test fails the moment anyone reintroduces a second implementation.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.error(`  FAIL  ${n}`); } }

const engine = require(path.join(__dirname, "../src/shared/obligation_engine.js"));
const bridge = require(path.join(__dirname, "./_engine.js"));

console.log("\n── one implementation of the obligation engine ──────────────");

const FNS = ["spawnObligationFromEvent", "satisfyObligation", "completeObligation", "reassignObligation", "obligationError"];
for (const k of FNS) {
  ok(bridge[k] === engine[k], `${k}: the harness bridge IS the real function, not a copy`);
}

// The bridge must not define anything itself — it may only re-export.
const bridgeSrc = fs.readFileSync(path.join(__dirname, "./_engine.js"), "utf8");
ok(!/^\s*(async\s+)?function\s+/m.test(bridgeSrc),
   "tests/_engine.js declares NO functions of its own — re-export only");

// server.js must not redefine them inline either.
const serverSrc = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
for (const k of FNS.filter((f) => f !== "obligationError")) {
  ok(!new RegExp(`^(async )?function ${k}\\s*\\(`, "m").test(serverSrc),
     `server.js does not redefine ${k} inline`);
}

// The guards that went missing in the drift must be reachable FROM A HARNESS.
(async () => {
  const noRows = { query: async () => ({ rows: [] }) };
  try {
    await bridge.satisfyObligation(noRows, { obligation_id: "x", input: "application_invitation_sent" });
    ok(false, "reserved input is refused through the harness bridge");
  } catch (e) {
    ok(e.code === "RESERVED_INPUT", "reserved input is refused through the harness bridge");
  }

  const linked = { query: async (sql) => /leasing_conversion_obligations/.test(String(sql))
    ? { rows: [{ "?column?": 1 }] } : { rows: [] } };
  try {
    await bridge.completeObligation(linked, { obligation_id: "x" });
    ok(false, "conversion-linked obligation is refused through the harness bridge");
  } catch (e) {
    ok(e.code === "CONVERSION_RAIL_REQUIRED", "conversion-linked obligation is refused through the harness bridge");
  }

  // dedupe_key must survive into the INSERT — it was dropped by the old copy.
  let seen = null;
  await bridge.spawnObligationFromEvent(
    { query: async (sql, params) => { seen = { sql: String(sql), params }; return { rows: [{}] }; } },
    { property_id: "p", module: "m", type: "t", label: "l", dedupe_key: "abc123" });
  ok(/dedupe_key/.test(seen.sql) && seen.params.includes("abc123"),
     "dedupe_key reaches the INSERT — the idempotency column the copy had dropped");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
