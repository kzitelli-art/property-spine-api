/*  Shared harness: builds a fresh prospect → ... → signed packet on demand,
    so hostile cases attack a real path rather than a hand-built row.        */
module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const { Pool } = require("pg");
const sess = require("../../src/identity/staff_session_service.js");
const { normalizeE164 } = require("../../src/identity/phone_identity.js");
const CONN = process.env.E2E_DATABASE_URL || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e";
const BASE = "http://127.0.0.1:3000";
const pool = new Pool({ connectionString: CONN });
const q = (s, p) => pool.query(s, p);
//  A DISTINGUISHABLE person per run. Reusing one name made every harness
//  person literally the same human, and leasing addressing correctly
//  refused all of them as ambiguous — the right answer to a wrong fixture.
let __n = 0;
const HOSTILE_NAME = () => `Probe Tester ${Date.now().toString(36)}${(++__n)}`;

// Intake resolves identity by phone before email. Randomly drawing four digits
// from the shared 555 fixture range can therefore adopt an earlier suite person
// and retain that person's name. Allocate from the same range only after
// checking both canonical and legacy phone columns in this owned database.
async function unclaimedFixturePhone() {
  const rows = (await q(
    `select phone, primary_phone_e164
       from persons
      where phone is not null or primary_phone_e164 is not null`)).rows;
  const claimed = new Set();
  for (const row of rows) {
    for (const raw of [row.primary_phone_e164, row.phone]) {
      const normalized = normalizeE164(raw);
      if (normalized) claimed.add(normalized);
    }
  }
  for (let suffix = 1000; suffix <= 9999; suffix++) {
    const candidate = `+1215555${suffix}`;
    if (!claimed.has(candidate)) return candidate;
  }
  throw new Error("fixture: no unclaimed phone remains in +1 215-555-xxxx");
}

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
  //  ⚠ SPACES ARE CHOSEN BY NAME, NEVER BY SORT POSITION.
  //  This took `order by space_label` and then beds[0] / beds[1], which
  //  makes the identity of "the bed" depend on COLLATION. "(whole unit)"
  //  and "Bed B" order differently under different glibc versions, so the
  //  local run picked Bed B and CI picked the whole unit — and the Ask
  //  Spine proof failed on `the bed is named` for a reason that had
  //  nothing to do with the product. Found by CI; no local run could show
  //  it, because locally the collation happened to be favourable.
  const beds = (await q("select id, space_label from spaces where unit_id=$1", [unit])).rows;
  const byLabel = (want) => {
    const hit = beds.find((b) => String(b.space_label).trim() === want);
    if (!hit) throw new Error(`fixture: no space labelled "${want}" — found: ${beds.map((b) => b.space_label).join(", ")}`);
    return hit.id;
  };
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
  //  bedA is the whole-unit position, bedB the named bed. Both by label, so
  //  the harness means the same thing on every machine.
  return { prop, unit, bedA: byLabel("(whole unit)"), bedB: byLabel("Bed B"), mike, token };
}

/*  Drives lead → application@bed → approve → terms → packet → send.
    Returns { appId, packetId, rawTok }.  Stops before the resident signs.  */
async function toPacket(C, { bed, rent = 1025, name = null } = {}) {
  const __name = name || HOSTILE_NAME();
  const phone = await unclaimedFixturePhone();
  const intake = await api("POST", "/leasing/intake", { key: "e2e-key", body: {
    intake_secret: "e2e-intake", property_id: C.prop, name: __name,
    phone, email: `h${Date.now()}${Math.floor(Math.random()*999)}@example.com`, source: "e2e" }});
  if (intake.status >= 400) throw new Error("intake: " + JSON.stringify(intake.body));
  const person = intake.body.person_id;
  const durablePerson = (await q("select name from persons where id=$1", [person])).rows[0];
  if (!durablePerson || durablePerson.name !== __name) {
    throw new Error("fixture identity: intake did not retain the requested person name "
      + JSON.stringify({ requested: __name, durable: durablePerson && durablePerson.name }));
  }
  const unitOf = (await q("select unit_id from spaces where id=$1", [bed])).rows[0].unit_id;
  const sub = await api("POST", `/properties/${C.prop}/applications`, { token: C.token, key: "e2e-key", body: {
    applicant_name: __name, person_id: person, unit_id: unitOf, space_id: bed,
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
  const signerName = view.body.packet && view.body.packet.current_signer
    && view.body.packet.current_signer.display_name;
  if (!signerName) throw new Error("packet: current signer name is missing");
  for (const f of required) {
    const r = await api("POST", `/t/lease/${rawTok}/fields/${f.id}/complete`, {
      body: {
        value: f.field_type === "signature" ? signerName : "HT",
        consent: f.field_type === "signature",
        session_id: "hostile",
      } });
    if (r.status >= 400) throw new Error("field: " + JSON.stringify(r.body));
  }
  return api("POST", `/t/lease/${rawTok}/submit`, { body: {} });
}

module.exports = { pool, q, api, ctx, toPacket, residentSigns, HOSTILE_NAME };
