// One-shot move-in beat proof. Run in Render shell: node movein_beat.js
// Finds a clean empty space, runs the full canonical flow, prints the result.
const { Client } = require("pg");

const PROP = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const PERSON = "16b442ee-0ec5-425a-90f3-ab8708a15b77";
const KEY = "2026letsgo";
const BASE = "http://localhost:" + (process.env.PORT || "10000");

async function api(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "x-operator-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { ok: r.ok, json: JSON.parse(text) }; }
  catch { return { ok: r.ok, raw: text.slice(0, 200) }; }
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    // 1. clean empty space
    const sp = await db.query(
      `select s.id as space_id, u.id as unit_id, u.unit_number
       from spaces s join units u on u.id=s.unit_id
       where u.property_id=$1
         and not exists (select 1 from leases l where l.space_id=s.id)
         and not exists (select 1 from unit_events e where e.unit_id=u.id and e.event_type='move_in_scheduled' and e.status='scheduled')
       limit 1`, [PROP]);
    if (!sp.rows.length) { console.log("No clean empty space available."); return; }
    const { space_id, unit_id, unit_number } = sp.rows[0];
    console.log("Space:", unit_number, space_id);

    // 2. lease dated today
    const lease = (await db.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,'{}',1500,current_date,current_date+365,'pending') returning id`,
      [PROP, space_id])).rows[0].id;
    console.log("Lease:", lease);

    // 3. schedule
    const today = new Date().toISOString().slice(0, 10);
    const sched = await api(`/units/${unit_id}/schedule-move-in`, { move_in_date: today, lease_id: lease });
    if (!sched.ok) { console.log("Schedule FAILED:", sched.json || sched.raw); return; }
    console.log("Scheduled ✓");

    // 4. spawn obligation
    await api("/unit-events/process-due", { window_days: 1, property_id: PROP });
    const ob = (await db.query(
      `select id from obligations where unit_id=$1 and module='movein' order by id desc limit 1`,
      [unit_id])).rows[0].id;
    console.log("Obligation:", ob);

    // 5. gates
    for (const g of ["readiness_checklist", "appliances_checked", "unit_condition_photos", "keys_access_ready"]) {
      await api(`/movein/${ob}/satisfy`, { gate: g });
    }
    console.log("Gates satisfied ✓");

    // 6. APPROVE
    const appr = await api(`/movein/${ob}/approve`, { approved_by_person_id: PERSON });
    console.log("\n=== APPROVE RESULT ===");
    console.log("approved:", appr.json?.approved);
    console.log("possession_note:", appr.json?.possession_note);
    console.log("unit_note:", appr.json?.unit_note);

    // 7. verify the position read
    const posR = await fetch(BASE + `/properties/${PROP}/space-position`, { headers: { "x-operator-key": KEY } });
    const pos = (await posR.json()).positions.find(p => p.space_id === space_id);
    console.log("\n=== SPACE POSITION (this space) ===");
    console.log("current_lease_position:", JSON.stringify(pos?.current_lease_position));
    console.log("current_possession:", JSON.stringify(pos?.current_possession));
    console.log("_compat_occupancy:", pos?._compat_occupancy);
    console.log("next_required_action:", pos?.next_required_action);

    const win = pos?.current_lease_position && pos?.current_possession && pos?._compat_occupancy === "occupied";
    console.log("\n" + (win ? "✓✓✓ BEAT PROVEN: current + possessed + cache matches" : "✗ not fully proven — see above"));
  } finally {
    await db.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
