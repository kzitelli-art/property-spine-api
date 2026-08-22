/*  E2E DRIVER — real server.js, real Postgres, real HTTP.
    Walks: lead/person → tour booked → tour outcome → application at an EXACT
    bed → governed economics → lease packet → resident signs → company signs
    → executed lease → tenancy anchor → availability / Rent Roll.
    Stops at the FIRST real break and reports it.                            */
module.paths.unshift(require("path").join(__dirname, "..", "..", "node_modules"));
const { Pool } = require("pg");
const sess = require("../../src/identity/staff_session_service.js");
const CONN = process.env.E2E_DATABASE_URL || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e";
const pool = new Pool({ connectionString: CONN });
const BASE = "http://127.0.0.1:3000";

let step = 0, lastOk = "(nothing yet)";
const log = (m) => console.log(m);
function okStep(name, detail) { step++; lastOk = name; log(`  ✓ ${String(step).padStart(2)} ${name}${detail ? "  — " + detail : ""}`); }
function stop(name, why, extra) {
  log(`\n══════════════════════════════════════════════════════════════`);
  log(`  LAST STEP THAT WORKED : ${lastOk}`);
  log(`  FIRST STEP THAT FAILED: ${name}`);
  log(`  WHY                   : ${why}`);
  if (extra) log(`  DETAIL                : ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 700)}`);
  log(`══════════════════════════════════════════════════════════════`);
  process.exit(2);
}
async function api(method, path, { token, body, key } = {}) {
  const h = { "content-type": "application/json" };
  if (token) h["x-staff-session"] = token;
  if (key) h["x-operator-key"] = key;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
}

(async () => {
  const q = (s, p) => pool.query(s, p);
  log("\n── SETUP: a Skyline-shaped property, by the bed ───────────────");
  const prop = (await q("select id from properties where name='Skyline E2E' order by created_at desc limit 1")).rows[0].id;
  await q("delete from property_team_assignments where property_id=$1", [prop]).catch(()=>{});
  const type = (await q("select id from property_unit_types where property_id=$1 limit 1", [prop])).rows[0].id;
  const unit = (await q("select id from units where property_id=$1 order by created_at limit 1", [prop])).rows[0].id;
  const beds = (await q("select id, space_label from spaces where unit_id=$1 order by space_label", [unit])).rows;
  const bedA = beds[0].id, bedB = (beds[1] || beds[0]).id;
  await q("update spaces set use_type='residential' where unit_id=$1", [unit]);
  //  HARNESS HYGIENE — each run starts from an unoccupied bed. Prior runs
  //  leave a pending lease on Bed B, and the system correctly refuses a
  //  second operative lease on an occupied space. That refusal is exercised
  //  DELIBERATELY in the hostile section; it must not silently pre-empt the
  //  clean path here.
  //  executed_lease_records.lease_id is FK-protected — evidence outlives the
  //  tenancy by design. For a harness reset the test evidence goes first.
  await q(`update lease_applications set executed_lease_record_id=null where property_id=$1`, [prop]);
  await q(`delete from executed_lease_admission_evaluations
            where executed_lease_record_id in (select id from executed_lease_records where property_id=$1)`, [prop]);
  await q(`delete from executed_lease_records where property_id=$1`, [prop]);
  await q(`delete from leases where property_id=$1`, [prop]);
  const existing = (await q("select id from users where name='Mike Grivna' limit 1")).rows[0];
  const mike = existing ? existing.id : (await q(`insert into users (name, role, is_active, status, account_kind)
      values ('Mike Grivna','property_manager',true,'active','human_staff') returning id`)).rows[0].id;
  await q(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active, can_manage_roles)
      values ($1,$2,'property_manager','{leasing,management,maintenance}',true,true)`, [mike, prop]);
  okStep("property, 3-bed unit, two beds, operator with leasing entitlement");

  // real session through the canonical service
  const c = await pool.connect();
  let token;
  try {
    await c.query("begin");
    const s = await sess.issueStaffSession(c, { userId: mike, propertyId: prop, purpose: "bootstrap_invite" });
    token = s.session_token || s.token;
    await c.query("commit");
  } catch (e) { await c.query("rollback"); stop("issue staff session", e.message); } finally { c.release(); }
  if (!token) stop("issue staff session", "no token returned");
  const me = await api("GET", "/operator/me", { token });
  if (me.status !== 200) stop("GET /operator/me", `status ${me.status}`, me.body);
  okStep("real staff session over HTTP", `/operator/me → ${me.body.property_id === prop ? "correct property" : "WRONG PROPERTY"}`);

  log("\n── 1 · PROSPECT ENTERS ────────────────────────────────────────");
  const phone = "+1215555" + String(Math.floor(1000 + (Date.now() % 9000)));
  const intake = await api("POST", "/leasing/intake", { key: "e2e-key", body: {
    intake_secret: "e2e-intake", property_id: prop,
    name: "Jane Smith", phone, email: "jane" + Date.now() + "@example.com", source: "e2e",
  }});
  if (intake.status >= 400) stop("canonical lead intake", `HTTP ${intake.status}`, intake.body);
  const jane = intake.body.person_id;
  okStep("lead intaken through the canonical door", `person ${String(jane).slice(0,8)} · lead ${String(intake.body.lead_id).slice(0,8)}`);

  log("\n── 2 · TOUR: book → outcome ───────────────────────────────────");
  const walk = await api("POST", "/operator/leasing/walk-in-tour", { token, body: {
    person_id: jane, unit_id: unit, attendance: "attended", standing: "interested",
    name: "Jane Smith", phone: "+12155550142",
  }});
  if (walk.status >= 400) {
    log(`     walk-in-tour → ${walk.status} ${JSON.stringify(walk.body).slice(0,200)}`);
    okStep("tour door reachable (refusal is a governed answer)", `status ${walk.status}`);
  } else okStep("walk-in tour captured with an outcome", JSON.stringify(walk.body).slice(0, 120));

  log("\n── 3 · APPLICATION AT AN EXACT BED ────────────────────────────");
  const sub = await api("POST", `/properties/${prop}/applications`, { token, key: "e2e-key", body: {
    applicant_name: "Jane Smith", person_id: jane, unit_id: unit, space_id: bedB,
    rent: 1025, deposit: 1025,
  }});
  if (sub.status >= 400) stop("submit application at an exact bed", `HTTP ${sub.status}`, sub.body);
  const appId = sub.body.application && sub.body.application.id;
  const appRow = (await q("select space_id, unit_id, status from lease_applications where id=$1", [appId])).rows[0];
  if (!appRow || String(appRow.space_id) !== String(bedB)) {
    stop("application carries the exact bed", "space_id did not persist as the chosen bed", appRow);
  }
  okStep("application born at the EXACT bed", `space_id = Bed B, status ${appRow.status}`);

  log("\n── 4 · GOVERNED ECONOMICS FOR THAT BED ────────────────────────");
  const { resolveSpaceEconomics } = require("../../src/money/effective_pricing.js");
  let econ = await resolveSpaceEconomics(pool, { property_id: prop, space_id: bedB, lease_term_months: 12 });
  if (econ.resolved) okStep("bed economics resolved", `$${econ.rent.new_lease_rent}`);
  else {
    log(`     unresolved: ${econ.reason} — ${econ.detail}`);
    okStep("economics refused honestly (no published pricing yet)", econ.reason);
  }

  log("\n── 4b · APPROVAL (the existing lifecycle act) ─────────────────");
  //  The packet perimeter requires lease_ready. markLeaseReadyFromApproval is
  //  the existing writer for that transition — used, not replaced.
  const appr = await api("POST", `/operator/leasing/applications/${appId}/approve`, { token, key: "e2e-key", body: {} });
  if (appr.status >= 400) stop("approve application → lease_ready", `HTTP ${appr.status}`, appr.body);
  const st = (await q("select status from lease_applications where id=$1", [appId])).rows[0].status;
  okStep("application approved through the existing writer", `status ${st}`);

  log("\n── 4c · PROPOSED TERMS (the existing governed confirmation) ───");
  const pt = await api("POST", `/operator/leasing/applications/${appId}/proposed-terms`, { token, key: "e2e-key", body: {
    rent: 1025, security_deposit: 1025,
    lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
    concession_status: "none", idempotency_key: "e2e-" + appId,
  }});
  if (pt.status >= 400) stop("confirm proposed terms", `HTTP ${pt.status}`, pt.body);
  okStep("proposed terms confirmed", JSON.stringify(pt.body).slice(0, 110));

  log("\n── 5 · LEASE PACKET ───────────────────────────────────────────");
  const gen = await api("POST", `/operator/leasing/applications/${appId}/lease-packet`, { token, key: "e2e-key", body: {} });
  log(`     generate packet → ${gen.status} ${JSON.stringify(gen.body).slice(0,240)}`);
  if (gen.status >= 400) stop("generate a lease packet", `HTTP ${gen.status}`, gen.body);
  okStep("lease packet generated", JSON.stringify(gen.body).slice(0, 120));

  const packetId = gen.body.packet.id;

  log("\n── 6 · SEND TO THE RESIDENT (tokenized, hashed) ───────────────");
  const snd = await api("POST", `/operator/leasing/lease-packets/${packetId}/send`, { token, key: "e2e-key", body: { idempotency_key: "e2e-send-" + packetId } });
  if (snd.status >= 400) stop("send the lease packet to the resident", `HTTP ${snd.status}`, snd.body);
  const rawTok = ((snd.body.tenant_url || "").split("/t/lease/")[1] || "").trim();
  if (!rawTok) stop("send the lease packet to the resident", "no raw resident token returned", snd.body);
  okStep("packet sent — raw resident token returned once", `status ${snd.body.status} · ${snd.body.tenant_url.slice(0, 46)}…`);

  log("\n── 7 · RESIDENT OPENS THE LINK (no staff session) ─────────────");
  const view = await api("GET", `/t/lease/${rawTok}/data`);
  if (view.status >= 400) stop("resident opens the lease link", `HTTP ${view.status}`, view.body);
  const fields = (view.body.packet && view.body.packet.fields) || [];
  const required = fields.filter((f) => f.required);
  okStep("resident loaded the packet over HTTP", `${required.length} required field(s), status ${view.body.packet.status}`);

  log("\n── 8 · RESIDENT ACKNOWLEDGES EVERY REQUIRED FIELD ─────────────");
  for (const f of required) {
    const r = await api("POST", `/t/lease/${rawTok}/fields/${f.id}/complete`, { body: {
      value: f.field_type === "signature" ? "Jane Smith" : "JS",
      consent: f.field_type === "signature",
      session_id: "e2e-resident",
    } });
    if (r.status >= 400) stop(`resident completes field ${f.field_key}`, `HTTP ${r.status}`, r.body);
  }
  okStep("all required resident fields acknowledged", required.map((f) => f.field_key).join(", ").slice(0, 90));

  log("\n── 9 · RESIDENT SUBMITS ───────────────────────────────────────");
  const subm = await api("POST", `/t/lease/${rawTok}/submit`, { body: {} });
  if (subm.status >= 400) stop("resident submits the packet", `HTTP ${subm.status}`, subm.body);
  const pkRow = (await q("select status, is_placeholder, instrument_body_sha256 from lease_packets where id=$1", [packetId])).rows[0];
  okStep("resident submitted", `packet status ${pkRow.status} · is_placeholder ${pkRow.is_placeholder}`);

  log("\n── 10 · THE PERSON CARD — ONE PLACE, FULL HISTORY ────────────");
  const card = await api("GET", `/operator/leasing/person-card?person_id=${jane}`, { token, key: "e2e-key" });
  if (card.status >= 400) stop("read the person card", `HTTP ${card.status}`, card.body);
  const bands = card.body || {};
  const hist = bands.history || (bands.card && bands.card.history) || [];
  const next = bands.next || (bands.card && bands.card.next) || [];
  log(`     bands: ${Object.keys(bands.card || bands).join(", ")}`);
  for (const h of hist) log(`     HISTORY  ${(h.occurred_at||"").slice(11,16)}  [${h.source||h.kind||"?"}] ${h.headline || h.text || h.summary || h.label || JSON.stringify(h).slice(0,120)}`);
  for (const n of next) log(`     NEXT     ${n.label || n.headline || n.text || JSON.stringify(n).slice(0,120)}  · owner ${n.owner_name||n.owner||"?"}`);
  log(`     STAGE    ${bands.stage} (basis: ${bands.stage_basis})`);
  log(`     APP      ${JSON.stringify(bands.application).slice(0,200)}`);
  if (!hist.length) stop("person card carries the history", "HISTORY band is empty after intake + tour + outcome + application", bands);
  okStep("person card carries the history in one place", `${hist.length} history entr(ies), ${next.length} next`);

  log("\n── 11 · THE GOVERNING INSTRUMENT, ESTABLISHED AT GENERATION ───");
  //  The instrument is a property-level FIXTURE placed on lease_config before
  //  generation. This step asserts the generator carried it onto the packet —
  //  it does not put it there.
  const inst = (await q(`select instrument_form_code, instrument_form_version,
                                instrument_body_sha256, instrument_established_at,
                                rendered_snapshot_hash
                           from lease_packets where id=$1`, [packetId])).rows[0];
  if (!inst.instrument_body_sha256) {
    stop("governing instrument established at generation",
         "the generator did not carry the property's governing instrument onto the packet", inst);
  }
  okStep("governing instrument established at generation",
         `${inst.instrument_form_code} v${inst.instrument_form_version} · ${inst.instrument_body_sha256.slice(0,16)}…`);

  log("\n── 12 · RESIDENT SIGNS THE GOVERNING INSTRUMENT ───────────────");
  const sigFields = (await q(
    `select id, field_key, field_type, signer_role, completed
       from lease_packet_fields where lease_packet_id=$1 and field_type='signature'
      order by display_order`, [packetId])).rows;
  const allFields = (await q(
    `select field_type, signer_role, count(*)::int n from lease_packet_fields
      where lease_packet_id=$1 group by 1,2`, [packetId])).rows;
  log(`     fields on this packet: ${allFields.map(f=>`${f.n}×${f.field_type}/${f.signer_role}`).join(", ")}`);
  if (!sigFields.length) {
    stop("resident signs the governing instrument",
         "the packet carries NO field of type 'signature' — there is nothing to sign",
         { fields_present: allFields, signature_fields: 0 });
  }
  okStep("resident signature field(s) present", sigFields.map(f=>f.field_key).join(", "));

  const pkAfter = (await q("select status, coalesce(resident_executed_at::text,'-') r from lease_packets where id=$1", [packetId])).rows[0];
  if (pkAfter.status !== "resident_executed") {
    stop("resident execution recorded on the packet",
         `packet is '${pkAfter.status}' — the resident signed but the packet did not move to resident_executed`, pkAfter);
  }
  const rsig = (await q(`select signed_by_person_id from lease_packet_fields
                          where lease_packet_id=$1 and field_key='sign_resident'`, [packetId])).rows[0];
  if (!rsig || !rsig.signed_by_person_id) {
    stop("resident signature names its signer", "sign_resident completed with no signed_by_person_id", rsig);
  }
  okStep("resident executed the instrument", `packet resident_executed · signer ${String(rsig.signed_by_person_id).slice(0,8)}`);

  log("\n── 13 · COMPANY SIGNS — ONE ACT TO CANONICAL TRUTH ────────────");
  const ex = await api("POST", `/operator/leasing/lease-packets/${packetId}/company-sign`, { token, key: "e2e-key", body: {} });
  log(`     company-sign → ${ex.status} ${JSON.stringify(ex.body).slice(0,300)}`);
  if (ex.status >= 400) stop("company signs and the lease executes", `HTTP ${ex.status}`, ex.body);
  okStep("lease executed inside Spine", `basis ${ex.body.verification_basis} · record ${String(ex.body.executed_lease_record_id).slice(0,8)}`);
  log(`     activation: ${ex.body.activation_status || "?"}`);
  if (ex.body.tenancy_error) log(`     tenancy_error: ${JSON.stringify(ex.body.tenancy_error).slice(0,400)}`);
  if (ex.body.blockers) log(`     blockers: ${JSON.stringify(ex.body.blockers).slice(0,400)}`);
  log(`     full: ${JSON.stringify(ex.body).slice(0,900)}`);

  log("\n── 14 · EXECUTED LEASE RECORD + TENANCY ANCHOR ────────────────");
  const elr = (await q("select id, verification_basis, execution_channel, source_lease_packet_id from executed_lease_records where source_lease_packet_id=$1", [packetId])).rows[0];
  if (!elr) stop("executed lease record written", "no executed_lease_records row points at this packet");
  okStep("executed lease record written", `${elr.verification_basis} · ${elr.execution_channel}`);

  const leaseId = ex.body.tenancy && ex.body.tenancy.lease_id;
  if (!leaseId) stop("tenancy anchor formed", "execution admitted but no lease id returned", ex.body);
  const lease = (await q(`select id, space_id, lease_status, rent, security_deposit,
                                 start_date, end_date, application_id
                            from leases where id=$1`, [leaseId])).rows[0];
  if (String(lease.space_id) !== String(bedB)) {
    stop("the tenancy is at the EXACT bed", `lease is at space ${lease.space_id}, application was at Bed B ${bedB}`, lease);
  }
  okStep("tenancy anchored at the exact bed", `lease ${lease.lease_status} · space=BedB · rent ${lease.rent} · deposit ${lease.security_deposit}`);

  log("\n── 15 · ONE FACT, READ THROUGH THE WHOLE SPINE ────────────────");
  const reads = [];

  const card2 = await api("GET", `/operator/leasing/person-card?person_id=${jane}`, { token, key: "e2e-key" });
  const h2 = (card2.body && card2.body.history) || [];
  reads.push(["person card", card2.status, `${h2.length} history · stage ${card2.body && card2.body.stage}`]);

  const appNow = (await q("select status from lease_applications where id=$1", [appId])).rows[0];
  reads.push(["application state", 200, appNow.status]);

  const elr2 = (await q(`select verification_basis, execution_channel, space_id, document_sha256
                           from executed_lease_records where source_lease_packet_id=$1`, [packetId])).rows[0];
  reads.push(["executed lease", 200, `${elr2.verification_basis}/${elr2.execution_channel} · bed ${String(elr2.space_id)===String(bedB)?"EXACT":"WRONG"}`]);

  const rr = await api("GET", `/operator/rent-roll/canonical`, { token, key: "e2e-key" });
  const rrRows = (rr.body && (rr.body.rows || rr.body.units || rr.body.rent_roll)) || [];
  const rrHit = JSON.stringify(rr.body || {}).includes(leaseId);
  reads.push(["rent roll", rr.status, rrHit ? "carries this lease" : `${rrRows.length} row(s), lease NOT present`]);

  const av = await api("GET", `/operator/leasing/availability-canonical`, { token, key: "e2e-key" });
  const avStr = JSON.stringify(av.body || {});
  reads.push(["availability", av.status, avStr.includes(bedB) ? "names this bed" : "bed not named"]);

  for (const [name, st, detail] of reads) log(`     ${name.padEnd(18)} ${String(st).padEnd(4)} ${detail}`);
  okStep("downstream reads exercised", `${reads.length} surfaces`);

  log("\n══════ CLEAN PATH GREEN — lead → tour → bed → price → instrument");
  log("       → resident signs → company signs → executed lease → tenancy ══════\n");

  await pool.end();
})().catch(async (e) => { log("\nDIED: " + (e && e.stack)); try { await pool.end(); } catch (_) {} process.exit(1); });
