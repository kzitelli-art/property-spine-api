/*  ════════════════════════════════════════════════════════════════════
    movein_lease_on_unit.e2e.js — A MOVE-IN IS SCHEDULED ON THE LEASE'S UNIT.

    POST /units/:id/schedule-move-in wrote whatever lease_id the body named
    into unit_events.lease_id without asking whether that lease's space is
    on the unit. Two consequences on the untouched parent: readiness
    approval of THIS unit fed unit_ready into the OTHER lease's delivery,
    and uq_unit_events_one_movein_per_lease (migration 074) then refused the
    lease's real unit with a raw MOVE_IN_FAILED. Proven here: a lease on
    another unit is refused (409, nothing written), an unknown lease is
    refused (404), the lease's own unit still schedules, and the
    no-lease legacy shape is unchanged.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

const API = (process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const post = async (url, body) => {
  const r = await fetch(`${API}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-operator-key": KEY }, body: J(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  const tag = "MLU" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'9 Move-in Ct') returning id", [tag + " MoveIn"])).id;
  const unitA = (await one("insert into units (property_id, unit_number) values ($1,'A1') returning id", [prop])).id;
  const unitB = (await one("insert into units (property_id, unit_number) values ($1,'B2') returning id", [prop])).id;
  const spaceB = (await one("select id from spaces where unit_id=$1 order by created_at limit 1", [unitB])).id;
  const resident = (await one("insert into persons (name) values ($1) returning id", [tag + " Resident"])).id;
  const leaseB = (await one(`insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
                             values ($1,$2,$3,'active', current_date + 10, current_date + 375, 1500) returning id`, [prop, spaceB, [resident]])).id;
  const moveIn = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);

  console.log("\n── 1 · unit A is offered unit B's lease ──");
  const wrong = await post(`/units/${unitA}/schedule-move-in`, { move_in_date: moveIn, lease_id: leaseB });
  check("POST /units/A/schedule-move-in with a lease on unit B → 409 LEASE_NOT_ON_UNIT", wrong.status === 409 && wrong.body && wrong.body.error === "LEASE_NOT_ON_UNIT", `${wrong.status} ${J(wrong.body).slice(0, 200)}`);
  check("…the refusal is sayable: it names the unit and says nothing was scheduled", !!(wrong.body && /unit A1/.test(wrong.body.receipt || "") && /nothing was scheduled/i.test(wrong.body.receipt || "")), J(wrong.body));
  const strayA = await one("select id from unit_events where unit_id=$1 and event_type='move_in_scheduled'", [unitA]);
  check("…and no move_in_scheduled event was written on unit A", !strayA, J(strayA));

  console.log("\n── 2 · an unknown lease ──");
  const ghost = await post(`/units/${unitA}/schedule-move-in`, { move_in_date: moveIn, lease_id: "00000000-0000-4000-8000-000000000000" });
  check("POST with a lease id that does not exist → 404 LEASE_NOT_FOUND", ghost.status === 404 && ghost.body && ghost.body.error === "LEASE_NOT_FOUND", `${ghost.status} ${J(ghost.body).slice(0, 200)}`);

  console.log("\n── 3 · the lease's own unit still schedules (was MOVE_IN_FAILED on the parent once the wrong unit held the lease) ──");
  const right = await post(`/units/${unitB}/schedule-move-in`, { move_in_date: moveIn, lease_id: leaseB });
  check("POST /units/B/schedule-move-in with its own lease → 201", right.status === 201 && right.body && right.body.unit_event && right.body.unit_event.lease_id === leaseB, `${right.status} ${J(right.body).slice(0, 200)}`);
  const evB = await one("select unit_id, lease_id from unit_events where lease_id=$1 and event_type='move_in_scheduled'", [leaseB]);
  check("…the one move_in_scheduled event for that lease is on unit B", evB && evB.unit_id === unitB, J(evB));

  console.log("\n── 4 · the legacy no-lease shape is unchanged ──");
  const bare = await post(`/units/${unitA}/schedule-move-in`, { move_in_date: moveIn, tenant_name: tag + " Walk-in" });
  check("POST /units/A/schedule-move-in without a lease → 201", bare.status === 201 && bare.body && bare.body.unit_event && bare.body.unit_event.lease_id === null, `${bare.status} ${J(bare.body).slice(0, 200)}`);

  await pool.end();
  console.log(`\n══ move-in lease on unit: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
