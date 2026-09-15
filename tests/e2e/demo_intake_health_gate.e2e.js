/*  ════════════════════════════════════════════════════════════════════
    demo_intake_health_gate.e2e.js — THE DEMO DIAGNOSTIC SHARES THE DEMO
    WALL.

    GET /demo/intake/health (src/leasing/leasing_leads.js, "TEMP
    DIAGNOSTIC") sits under the key-exempt /demo/ prefix and answered
    anyone with database reachability, the lead_events check-constraint
    definition state and the boot-time self-heal outcome — a string that
    can carry a raw database error message. Its sibling POST /demo/intake
    fails closed unless DEMO_MODE=true. Proven here, on a server booted
    WITHOUT DEMO_MODE: the diagnostic answers 403 with the same receipt
    and none of the diagnostic keys; the sibling's wall is pinned beside it.
    The DEMO_MODE=true side is not measured here — this parent boots one
    server, outside the demo.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const DIAGNOSTIC_KEYS = ["database", "lead_events_check", "self_heal", "build"];

(async () => {
  if (String(process.env.DEMO_MODE || "").toLowerCase() === "true") {
    console.log("  ! DEMO_MODE=true in this harness environment; this proof measures the closed side and cannot run here.");
    process.exit(1);
  }

  console.log("\n── 1 · the diagnostic, with no credentials, outside the demo ──");
  const r = await fetch(`${API}/demo/intake/health`);
  const body = await r.json().catch(() => null);
  check("GET /demo/intake/health → 403", r.status === 403, `${r.status} ${J(body).slice(0, 200)}`);
  check("…with the demo wall's receipt", !!(body && /demo is not enabled/i.test(body.receipt || "")), J(body));
  check("…and none of the diagnostic keys (database, lead_events_check, self_heal, build)", !!body && DIAGNOSTIC_KEYS.every((k) => !(k in body)), J(body));

  console.log("\n── 2 · the sibling write door has the same wall ──");
  const w = await fetch(`${API}/demo/intake`, { method: "POST", headers: { "content-type": "application/json" }, body: J({ phone: "+15555550100", message: "hi" }) });
  const wb = await w.json().catch(() => null);
  check("POST /demo/intake → 403 with the same receipt", w.status === 403 && !!(wb && /demo is not enabled/i.test(wb.receipt || "")), `${w.status} ${J(wb).slice(0, 200)}`);

  console.log(`\n══ demo intake health gate: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
