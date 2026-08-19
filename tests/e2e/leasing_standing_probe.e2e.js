/*  CROSS-SURFACE PROBE — build real lifecycle states, then ask every read
    the same questions and print what each one says. No assertions yet:
    this is the instrument that shows whether the surfaces agree.        */
const { pool, q, api, ctx, toPacket, residentSigns } = require("./leasing_e2e_lib.js");
const { resolveRelationshipStage } = require("../../src/shared/relationship_stage.js");

const row = (label, vals) => console.log("  " + label.padEnd(26) + vals);

async function askSurfaces(C, S) {
  const app = (await q(`select id, status, person_id, space_id from lease_applications where id=$1`, [S.appId])).rows[0];
  const conv = (await q(`select id from leasing_conversions where person_id=$1 and property_id=$2
                          order by created_at desc limit 1`, [app.person_id, C.prop])).rows[0];
  const rev  = await api("GET", `/operator/leasing/application-review?application_id=${S.appId}`, { token: C.token, key: "e2e-key" });
  const card = await api("GET", `/operator/leasing/person-card?person_id=${app.person_id}`, { token: C.token, key: "e2e-key" });
  const nxt  = conv ? await api("GET", `/operator/leasing/application-next?conversion_id=${conv.id}`, { token: C.token, key: "e2e-key" }) : { status: 0, body: null };
  const stage = await resolveRelationshipStage(pool, { personId: app.person_id, propertyId: C.prop });
  const stand = await api("GET", `/operator/leasing/standing?person_id=${app.person_id}`, { token: C.token, key: "e2e-key" });
  const S2 = stand.body && stand.body.leasing_standing;
  const cardLs = card.body && card.body.leasing_standing;
  const pkt = (await q(`select status, superseded_at from lease_packets where id=$1`, [S.packetId])).rows[0];
  const elr = (await q(`select verification_basis from executed_lease_records where source_lease_packet_id=$1`, [S.packetId])).rows[0];
  const lease = (await q(`select lease_status from leases where application_id=$1`, [S.appId])).rows[0];

  const rvNext = rev.body && rev.body.next_action;
  const rvExec = rev.body && rev.body.execution_primary_action;
  return {
    app_status: app.status,
    packet: pkt ? pkt.status + (pkt.superseded_at ? " (superseded)" : "") : "-",
    executed: elr ? elr.verification_basis : "none",
    tenancy: lease ? lease.lease_status : "none",
    stage: stage.stage || "(null)",
    card_stage: card.body && card.body.stage,
    card_app: card.body && card.body.application && card.body.application.status,
    review_next: rvNext ? `${rvNext.code}/${rvNext.state}${rvNext.blocker_code ? " ⛔" + rvNext.blocker_code : ""}` : `(review ${rev.status})`,
    exec_action: rvExec ? `${rvExec.action}` : "(none)",
    standing: S2 ? `${S2.lease ? S2.lease.packet_status : "-"} · resident ${S2.lease && S2.lease.resident_executed_at ? "SIGNED" : "-"} · company ${S2.lease && S2.lease.company_executed_at ? "SIGNED" : "-"} · exec ${S2.lease && S2.lease.executed_lease.present ? S2.lease.executed_lease.admission_status : "none"} · tenancy ${S2.tenancy.state}` : `(${stand.status})`,
    standing_unc: S2 ? (S2.uncertainty.length ? S2.uncertainty.map(u=>u.kind+":"+u.subject).join(",") : "settled") : "-",
    card_has_standing: cardLs ? (cardLs.lease ? `${cardLs.lease.packet_status} · exec ${cardLs.lease.executed_lease.present}` : "no lease band") : "ABSENT",
  };
}

function report(name, r) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 56 - name.length))}`);
  row("application.status", r.app_status);
  row("packet", r.packet);
  row("executed lease", r.executed);
  row("tenancy", r.tenancy);
  row("relationship_stage", r.stage);
  row("Person Card stage", String(r.card_stage));
  row("Person Card application", String(r.card_app));
  row("Review → next action", r.review_next);
  row("Review → execution button", String(r.exec_action));
  row("Leasing standing", String(r.standing));
  row("  uncertainty", String(r.standing_unc));
  row("Person Card → standing", String(r.card_has_standing));
}

(async () => {
  const C = await ctx();

  const A = await toPacket(C, { bed: C.bedB });
  report("STATE 1 · packet sent, resident has not signed", await askSurfaces(C, A));

  await residentSigns(A.rawTok);
  report("STATE 2 · RESIDENT EXECUTED, company has not", await askSurfaces(C, A));

  await api("POST", `/operator/leasing/lease-packets/${A.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
  report("STATE 3 · fully executed, tenancy pending", await askSurfaces(C, A));

  const B = await toPacket(C, { bed: C.bedB });      // bedB now occupied
  await residentSigns(B.rawTok);
  await api("POST", `/operator/leasing/lease-packets/${B.packetId}/company-sign`, { token: C.token, key: "e2e-key", body: {} });
  report("STATE 4 · executed but admission BLOCKED", await askSurfaces(C, B));

  const D = await toPacket(C, { bed: C.bedA });
  await api("POST", `/operator/leasing/applications/${D.appId}/lease-packet`, { token: C.token, key: "e2e-key", body: { create_new_version: true } });
  report("STATE 5 · packet superseded", await askSurfaces(C, D));

  await pool.end();
})().catch(async (e) => { console.log("DIED: " + e.stack); try { await pool.end(); } catch(_){} process.exit(1); });
