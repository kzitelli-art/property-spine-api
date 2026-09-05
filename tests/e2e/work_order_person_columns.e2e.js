/*  ════════════════════════════════════════════════════════════════════
    work_order_person_columns.e2e.js — READS OF A COLUMN MIGRATION 098 DROPPED.

    098 split work_orders.person_id into reported_by_person_id and
    affected_person_id and dropped the old column. Four queries kept the
    old name:

      src/comms/tenant_link.js   GET /tenant/me            → 500 for EVERY resident
      src/surfaces/desks.js      maintenance-dashboard and the operator-home
                                 maintenance section → "Maintenance board
                                 unreadable", headline unavailable, no items

    One class, one definition of "the resident of a work order" — the person
    its updates go to, affected first then reporter, the precedent
    src/technician/conversation.js already uses — and, for the resident's
    own view, both of the resident's relationships to a work order.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const crypto = require("crypto");
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
async function get(p, headers = {}) {
  const r = await fetch(API + p, { headers });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

(async () => {
  const tag = "WOP" + Math.floor(Math.random() * 1e6);
  const prop = (await one("insert into properties (name,address) values ($1,'9 Column Ct') returning id", [tag + " Columns"])).id;
  const unit = (await one("insert into units (property_id, unit_number) values ($1,'12') returning id", [prop])).id;
  const space = (await one("select id from spaces where unit_id=$1 order by created_at limit 1", [unit])).id;
  const resident = (await one("insert into persons (name, phone) values ($1,'+12155551212') returning id", [tag + " Resident"])).id;
  const neighbour = (await one("insert into persons (name) values ($1) returning id", [tag + " Neighbour"])).id;
  await pool.query(`insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
                    values ($1,$2,$3,'active', current_date - 30, current_date + 300, 1500)`, [prop, space, [resident]]);
  const token = "ts-" + tag + "-" + crypto.randomBytes(8).toString("hex");
  await pool.query(`insert into tenant_sessions (person_id, property_id, token, expires_at) values ($1,$2,$3, now() + interval '1 hour')`, [resident, prop, token]);
  const wo = async (title, cols) => (await one(
    `insert into work_orders (property_id, unit_id, title, status, source, reported_by_person_id, affected_person_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`, [prop, unit, title, cols.status || "open", cols.source || "staff", cols.reported || null, cols.affected || null])).id;
  const reported  = await wo("Sink leak (resident reported)", { source: "tenant", reported: resident });
  const affected  = await wo("Hall light (staff opened, affects resident)", { source: "staff", affected: resident });
  const finished  = await wo("Old repair (complete)", { source: "tenant", reported: resident, status: "complete" });
  const someone   = await wo("Neighbour's window (not this resident)", { source: "tenant", reported: neighbour });

  console.log("\n── 1 · GET /tenant/me: the resident's open work is what they reported or what affects their home ──");
  const me = await get("/tenant/me", { "x-tenant-session": token });
  const ids = me.body && Array.isArray(me.body.open_work_orders) ? me.body.open_work_orders.map((w) => w.id).sort() : null;
  check("/tenant/me → 200 (was 500 'Could not load your view.' — selected the dropped work_orders.person_id)", me.status === 200, `${me.status} ${J(me.body).slice(0, 120)}`);
  check("…lists exactly the reported one and the affected one; not the complete one, not the neighbour's",
        ids && ids.join(",") === [reported, affected].sort().join(","), J(ids));

  console.log("\n── 2 · the maintenance desk reads again, with the resident of each work order and who is waiting ──");
  const desk = await get(`/properties/${prop}/maintenance-dashboard`, { "x-operator-key": KEY });
  const head = desk.body && desk.body.headline;
  const items = desk.body && desk.body.items || [];
  const rep = items.find((i) => i.id === reported);
  check("maintenance-dashboard → 200 with a readable headline (was: 'Maintenance board unreadable', headline unavailable)",
        desk.status === 200 && head && head.open_work_orders && head.open_work_orders.status === "ok" && !/unreadable/.test(desk.body.receipt || ""),
        `${desk.status} ${J(head && head.emergencies)} ${desk.body && desk.body.receipt}`);
  check("…tenant_waiting counts the two tenant-sourced open orders with no update sent (resident's and neighbour's)",
        head && head.tenant_waiting && head.tenant_waiting.count === 2, J(head && head.tenant_waiting));
  check("…the resident-reported item carries the resident's name and tenant_waiting true",
        rep && rep.tenant_name === tag + " Resident" && rep.tenant_waiting === true && rep._details && rep._details.person_id === resident, J(rep));
  check("…the complete order is not on the board", !items.some((i) => i.id === finished));

  console.log("\n── 3 · operator-home: the maintenance section is readable, same definition ──");
  const home = await get(`/properties/${prop}/operator-home`, { "x-operator-key": KEY });
  const mx = home.body && home.body.desks && home.body.desks.maintenance;
  //  operator-home compresses each desk to a headline STRING of its ok facts;
  //  when every fact was unavailable it fell back to "maintenance board unreadable".
  check("operator-home → 200 and the maintenance card carries real facts, not the 'unreadable' fallback",
        home.status === 200 && mx && typeof mx.headline === "string" && /3 open/.test(mx.headline) && !/unreadable/.test(mx.headline),
        `${home.status} ${J(mx)}`);

  await pool.end();
  console.log(`\n══ work order person columns: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
