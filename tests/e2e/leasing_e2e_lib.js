/*  Shared harness: builds a fresh prospect → ... → signed packet on demand,
    so hostile cases attack a real path rather than a hand-built row.        */
module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const { Pool } = require("pg");
const sess = require("../../src/identity/staff_session_service.js");
const CONN = process.env.E2E_DATABASE_URL || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e";
const BASE = "http://127.0.0.1:3000";
const pool = new Pool({ connectionString: CONN });
const q = (s, p) => pool.query(s, p);

async function api(method, path, { token, body, key } = {}) {
  const h = { "content-type": "application/json" };
  if (token) h["x-staff-session"] = token;
  if (key) h["x-operator-key"] = key;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

async function ctx({ wipe = true } = {}) {
  const prop = (await q("select id from properties where name='Skyline E2E' order by created_at desc limit 1")).rows[0].id;
  const unit = (await q("select id from units where property_id=$1 order by created_at limit 1", [prop])).rows[0].id;
  const beds = (await q("select id, space_label from spaces where unit_id=$1 order by space_label", [unit])).rows;
  if (wipe) {
    await q(`update lease_applications set executed_lease_record_id=null where property_id=$1`, [prop]);
    await q(`delete from executed_lease_admission_evaluations
              where executed_lease_record_id in (select id from executed_lease_records where property_id=$1)`, [prop]);
    await q(`delete from executed_lease_records where property_id=$1`, [prop]);
    await q(`delete from leases where property_id=$1`, [prop]);
  }
  const mike = (await q("select id from users where name='Mike Grivna' limit 1")).rows[0].id;
  const c = await pool.connect();
  let token;
  try {
    await c.query("begin");
    const s = await sess.issueStaffSession(c, { userId: mike, propertyId: prop, purpose: "bootstrap_invite" });
    token = s.session_token || s.token;
    await c.query("commit");
  } finally { c.release(); }
  return { prop, unit, bedA: beds[0].id, bedB: (beds[1] || beds[0]).id, mike, token };
}

/*  Drives lead → application@bed → approve → terms → packet → send.
    Returns { appId, packetId, rawTok }.  Stops before the resident signs.  */
async function toPacket(C, { bed, rent = 1025 } = {}) {
  const phone = "+1215555" + String(Math.floor(1000 + Math.random() * 8999));
  const intake = await api("POST", "/leasing/intake", { key: "e2e-key", body: {
    intake_secret: "e2e-intake", property_id: C.prop, name: "Hostile Tester",
    phone, email: `h${Date.now()}${Math.floor(Math.random()*999)}@example.com`, source: "e2e" }});
  if (intake.status >= 400) throw new Error("intake: " + JSON.stringify(intake.body));
  const person = intake.body.person_id;
  const unitOf = (await q("select unit_id from spaces where id=$1", [bed])).rows[0].unit_id;
  const sub = await api("POST", `/properties/${C.prop}/applications`, { token: C.token, key: "e2e-key", body: {
    applicant_name: "Hostile Tester", person_id: person, unit_id: unitOf, space_id: bed,
    rent, deposit: rent }});
  if (sub.status >= 400) throw new Error("apply: " + JSON.stringify(sub.body));
  const appId = sub.body.application && sub.body.application.id;
  const ap = await api("POST", `/operator/leasing/applications/${appId}/approve`, { token: C.token, key: "e2e-key", body: {} });
  if (ap.status >= 400) throw new Error("approve: " + JSON.stringify(ap.body));
  const pt = await api("POST", `/operator/leasing/applications/${appId}/proposed-terms`, { token: C.token, key: "e2e-key", body: {
    rent, security_deposit: rent, lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
    concession_status: "none", idempotency_key: "h-" + appId }});
  if (pt.status >= 400) throw new Error("terms: " + JSON.stringify(pt.body));
  const gen = await api("POST", `/operator/leasing/applications/${appId}/lease-packet`, { token: C.token, key: "e2e-key", body: {} });
  if (gen.status >= 400) throw new Error("packet: " + JSON.stringify(gen.body));
  const packetId = gen.body.packet.id;
  const snd = await api("POST", `/operator/leasing/lease-packets/${packetId}/send`, { token: C.token, key: "e2e-key", body: { idempotency_key: "hs-" + packetId } });
  if (snd.status >= 400) throw new Error("send: " + JSON.stringify(snd.body));
  const rawTok = (snd.body.tenant_url || "").split("/t/lease/")[1];
  return { appId, packetId, rawTok, person };
}

/*  The resident completes every required field and submits.  */
async function residentSigns(rawTok) {
  const view = await api("GET", `/t/lease/${rawTok}/data`);
  const required = ((view.body.packet && view.body.packet.fields) || []).filter((f) => f.required);
  for (const f of required) {
    const r = await api("POST", `/t/lease/${rawTok}/fields/${f.id}/complete`, {
      body: { value: f.field_type === "signature" ? "Hostile Tester" : "HT", session_id: "hostile" } });
    if (r.status >= 400) throw new Error("field: " + JSON.stringify(r.body));
  }
  return api("POST", `/t/lease/${rawTok}/submit`, { body: {} });
}

module.exports = { pool, q, api, ctx, toPacket, residentSigns };
