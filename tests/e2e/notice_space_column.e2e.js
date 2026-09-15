/*  ════════════════════════════════════════════════════════════════════
    notice_space_column.e2e.js — A NOTICE THE CANONICAL READER CAN SEE.

    POST /units/:id/notice resolves WHICH space the notice is on (a by-bed
    unit must name it), then wrote the space only into the JSON payload.
    The canonical space reader (src/tenancy/space_position.js) finds a
    notice by the COLUMN unit_events.space_id (migration 081), so a notice
    succeeded here — 201, receipt and all — and was invisible to
    availability, the future rent roll and every surface that reads
    space_position. Proven here: the column carries the resolved space and
    the reader's own predicate finds the notice.

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

(async () => {
  const tag = "NSC" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'5 Notice Ln') returning id", [tag + " Notice"])).id;
  const unit = (await one("insert into units (property_id, unit_number) values ($1,'7') returning id", [prop])).id;
  const space = (await one("select id from spaces where unit_id=$1 order by created_at limit 1", [unit])).id;
  const resident = (await one("insert into persons (name) values ($1) returning id", [tag + " Resident"])).id;
  await pool.query(`insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
                    values ($1,$2,$3,'active', current_date - 60, current_date + 120, 1400)`, [prop, space, [resident]]);
  const moveOut = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);

  console.log("\n── 1 · give notice on the unit ──");
  const r = await fetch(`${API}/units/${unit}/notice`, { method: "POST",
    headers: { "content-type": "application/json", "x-operator-key": KEY }, body: J({ move_out_date: moveOut, given_by: tag }) });
  const body = await r.json().catch(() => null);
  check("POST /units/:id/notice → 201 with the resolved tenancy", r.status === 201 && body && body.resolved_tenancy && body.resolved_tenancy.space_id === space, `${r.status} ${J(body).slice(0, 160)}`);

  console.log("\n── 2 · the notice is a COLUMN the canonical reader can see, not only a payload key ──");
  const ev = await one("select space_id, status, payload->>'space_id' as payload_space from unit_events where unit_id=$1 and event_type='notice_given' order by created_at desc limit 1", [unit]);
  check("unit_events.space_id is the resolved space (was NULL — the space lived only in payload)", ev && ev.space_id === space, J(ev));
  const seen = await one(
    `select ue.effective_date::text as d from unit_events ue
      where ue.space_id=$1 and ue.event_type='notice_given' and ue.status='scheduled'
      order by ue.effective_date desc limit 1`, [space]);
  check("…the space reader's own predicate (space_position.js: ue.space_id = s.id) finds the notice on that space", seen && seen.d === moveOut, J(seen));

  await pool.end();
  console.log(`\n══ notice space column: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
