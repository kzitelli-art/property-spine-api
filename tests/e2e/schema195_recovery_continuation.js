"use strict";
// Proof-only continuation for an already resident-executed two-step packet.
// Phase before-stop executes through the canonical HTTP door; phase after-restart
// replays that executed packet and rereads every canonical surface.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const boundary = require("./proof_boundary");
const sessions = require("../../src/identity/staff_session_service");
require("./proof_fence_preload");

const BASE = process.env.E2E_API_BASE;
const OUT = process.env.PROOF_OUTPUT_DIR;
assert(BASE && OUT, "E2E_API_BASE and PROOF_OUTPUT_DIR are required");
const handoff = JSON.parse(fs.readFileSync(path.join(OUT, "two_step_handoff.json"), "utf8"));
const stateFile = path.join(OUT, "schema195_recovery_state.json");
const phase = process.argv[2];
assert(["--before-stop", "--after-restart"].includes(phase) && process.argv.length === 3,
  "exactly one supported phase is required: --before-stop or --after-restart");
const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const all = async (sql, args = []) => (await pool.query(sql, args)).rows;
const api = async (method, route, token, body) => {
  const headers = token ? { "x-staff-session": token } : {};
  if (body !== undefined) { headers["content-type"] = "application/json"; }
  const r = await fetch(BASE + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const snapshot = async () => {
  const app = await one("select id,status,approved_at,person_id,space_id,application_offer_id,application_terms_hash,term_source,terms_completed_by from lease_applications where id=$1", [handoff.application_id]);
  const packet = await one("select id,status,application_id,application_offer_id,application_terms_hash,company_executed_at,instrument_package_sha256 from lease_packets where id=$1", [handoff.packet_id]);
  const offer = await one("select id,property_id,person_id,space_id,offered_terms_snapshot->>'rent' as rent,offered_terms_snapshot->>'application_terms_hash' as terms_hash,authority_basis_snapshot->>'actor_user_id' as author from lease_offers where id=$1", [app.application_offer_id]);
  const leases = await all("select id,lease_status,space_id,rent,application_id,economic_tenancy_activated_at from leases where application_id=$1 and lease_status not in ('cancelled','void','superseded') order by created_at", [handoff.application_id]);
  const decisions = await all("select event_json,created_at from lease_packet_audit_events where lease_packet_id=$1 and event_type='executed_by_decision' order by created_at", [handoff.packet_id]);
  const signers = (await all("select signer_role,display_name,person_id,submitted_at from lease_packet_signers where lease_packet_id=$1 order by signer_role", [handoff.packet_id])).map((x) => ({ ...x, submitted_at: x.submitted_at ? new Date(x.submitted_at).toISOString() : null }));
  const fields = (await all("select field_key,signer_role,completed,completed_at,field_value,signed_by_user_id,signed_by_person_id,signed_by_packet_signer_id from lease_packet_fields where lease_packet_id=$1 order by display_order,field_key", [handoff.packet_id])).map((x) => ({ ...x, completed_at: x.completed_at ? new Date(x.completed_at).toISOString() : null }));
  const history = await one("select count(*)::int as n from lease_packet_audit_events where lease_packet_id=$1", [handoff.packet_id]);
  return { app, packet, offer, leases, decisions, signers, fields, audit_events: history.n };
};
const expectPacket = (s, label) => {
  assert.equal(s.app.id, handoff.application_id, label + ": application identity");
  assert.equal(s.packet.id, handoff.packet_id, label + ": packet identity");
  assert.equal(s.app.person_id, handoff.person_id, label + ": person identity");
  assert.equal(s.app.space_id, handoff.bed_id, label + ": exact bed identity");
  assert.equal(s.packet.application_offer_id, s.app.application_offer_id, label + ": offer linkage");
  assert.equal(s.packet.application_terms_hash, s.app.application_terms_hash, label + ": terms hash");
  assert.equal(s.offer.id, s.app.application_offer_id, label + ": offer identity");
  assert.equal(s.offer.space_id, handoff.bed_id, label + ": offer exact bed");
  assert.equal(s.offer.author, handoff.kz_user_id, label + ": offer attribution");
  assert.equal(s.leases.length, 1, label + ": exactly one pending tenancy");
  assert.equal(s.leases[0].lease_status, "pending", label + ": tenancy pending");
  assert.equal(s.leases[0].space_id, handoff.bed_id, label + ": tenancy exact bed");
  assert.equal(s.leases[0].economic_tenancy_activated_at, null, label + ": no economic activation");
};
const issue = async () => (await sessions.issueStaffSession(pool, { userId: handoff.kz_user_id, propertyId: handoff.property_id, purpose: "bootstrap_invite" })).session_token;
const reads = async (token) => {
  const review = await api("GET", `/operator/leasing/application-review?application_id=${handoff.application_id}`, token);
  assert.equal(review.status, 200, "Application Review survives restart");
  assert.equal(review.body.application_id, handoff.application_id, "Application Review preserves application id");
  assert.equal(review.body.space.space_id, handoff.bed_id, "Application Review preserves exact bed");
  const desk = await api("GET", "/operator/leasing/desk", token);
  assert.equal(desk.status, 200, "Leasing desk survives restart");
  const record = (desk.body.application_records.records || []).find((r) => r.application_id === handoff.application_id);
  assert(record && record.lease_id, "Leasing desk preserves tenancy identity");
  const card = await api("GET", `/operator/leasing/person-card?person_id=${handoff.person_id}`, token);
  assert.equal(card.status, 200, "Person Card survives restart");
  assert.equal(card.body.leasing_standing.tenancy.space_id, handoff.bed_id, "Person Card preserves exact bed");
  assert.equal(card.body.leasing_standing.tenancy.state, "pending", "Person Card preserves pending state");
  return { review: review.body, desk: { lease_id: record.lease_id }, card: card.body };
};
(async () => {
  await boundary.assertDatabase();
  const before = await snapshot();
  if (phase === "--before-stop") {
    assert.equal(before.packet.status, "resident_executed", "packet is the signed pre-Execute handoff");
    assert.equal(before.leases.length, 0, "handoff has no tenancy before Execute");
    const token = await issue();
    const key = "schema195-recovery-execute-" + handoff.packet_id;
    const executed = await api("POST", `/operator/leasing/lease-packets/${handoff.packet_id}/execute`, token, { application_decision: "approve", idempotency_key: key });
    assert.equal(executed.status, 201, "first Execute after schema195 restart decides");
    assert.equal(executed.body.tenancy.lease_status, "pending", "Execute returns pending tenancy");
    assert.equal(executed.body.decisions.length, 2, "Execute returns exactly two commercial decisions");
    assert.deepEqual(executed.body.decisions.map((d) => d.decision), ["application_approved", "company_signed"], "Execute decisions are approval then company signature");
    const same = await api("POST", `/operator/leasing/lease-packets/${handoff.packet_id}/execute`, token, { application_decision: "approve", idempotency_key: key });
    assert.equal(same.status, 200, "same key replays idempotently before second restart");
    assert.equal(same.body.idempotent, true, "same key is explicitly idempotent");
    const other = await api("POST", `/operator/leasing/lease-packets/${handoff.packet_id}/execute`, token, { application_decision: "approve", idempotency_key: key + "-other" });
    assert.equal(other.status, 200, "different key replays the existing executed packet");
    assert.equal(other.body.idempotent, true, "different key cannot create a second decision");
    const after = await snapshot(); expectPacket(after, "before-stop");
    const canonical = await reads(token);
    fs.writeFileSync(stateFile, JSON.stringify({ handoff, before, executed: executed.body, after, canonical, provider_log_bytes: { sms: fs.statSync(process.env.E2E_SMS_LOG).size, model: fs.statSync(process.env.E2E_ANTHROPIC_LOG).size } }, null, 2));
    console.log(JSON.stringify({ phase: "before-stop", application_id: handoff.application_id, packet_id: handoff.packet_id, offer_id: after.app.application_offer_id, terms_hash: after.app.application_terms_hash, offer_author: after.offer.author, lease_id: after.leases[0].id, lease_status: after.leases[0].lease_status, audit_events: after.audit_events, decisions: after.decisions.length }, null, 2));
  } else if (phase === "--after-restart") {
    assert.equal(before.packet.status, "executed", "packet remains executed across restart");
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const token = await issue();
    const key = "schema195-recovery-execute-" + handoff.packet_id;
    const replay = await api("POST", `/operator/leasing/lease-packets/${handoff.packet_id}/execute`, token, { application_decision: "approve", idempotency_key: key });
    assert.equal(replay.status, 200, "executed packet replays after restart");
    assert.equal(replay.body.idempotent, true, "post-restart replay is idempotent");
    assert.equal(replay.body.tenancy.lease_id, saved.after.leases[0].id, "post-restart replay preserves lease id");
    const replayOther = await api("POST", `/operator/leasing/lease-packets/${handoff.packet_id}/execute`, token, { application_decision: "approve", idempotency_key: key + "-post-restart" });
    assert.equal(replayOther.status, 200, "post-restart different key replays existing packet");
    assert.equal(replayOther.body.tenancy.lease_id, saved.after.leases[0].id, "different post-restart key preserves lease id");
    const canonical = await reads(token);
    const after = await snapshot(); expectPacket(after, "after-restart");
    assert.deepEqual(after.signers, saved.before.signers, "tenant and guarantor signer identities/history survive restart");
    assert.deepEqual(after.fields.filter((f) => f.signer_role !== "company"), saved.before.fields.filter((f) => f.signer_role !== "company"), "tenant and guarantor signature fields survive restart");
    assert.deepEqual(after.fields.find((f) => f.signer_role === "company"), saved.after.fields.find((f) => f.signer_role === "company"), "company signature field survives restart");
    for (const key of ["application_offer_id", "application_terms_hash", "instrument_package_sha256"]) {
      assert.equal(after.app[key] || after.packet[key], saved.after.app[key] || saved.after.packet[key], `immutable ${key} survives restart`);
    }
    assert.equal(after.offer.author, saved.before.offer.author, "offer author attribution survives restart");
    assert.equal(after.leases[0].id, saved.after.leases[0].id, "exact lease identity survives restart");
    assert.deepEqual(after.decisions[0].event_json, saved.after.decisions[0].event_json, "decision history survives restart exactly");
    assert.equal(after.audit_events, saved.after.audit_events, "replay adds no decision audit event");
    assert.deepEqual(after.decisions[0].event_json.decisions.map((d) => d.decision), ["application_approved", "company_signed"], "history preserves both decisions");
    assert.equal(fs.statSync(process.env.E2E_SMS_LOG).size, saved.provider_log_bytes.sms, "Execute/replay does not send SMS");
    assert.equal(fs.statSync(process.env.E2E_ANTHROPIC_LOG).size, saved.provider_log_bytes.model, "Execute/replay does not call model");
    fs.writeFileSync(path.join(OUT, "schema195_recovery_final.json"), JSON.stringify({ saved, replay: replay.body, replayOther: replayOther.body, after, canonical }, null, 2));
    console.log(JSON.stringify({ phase: "after-restart", replay_status: replay.status, replay_other_status: replayOther.status, application_id: handoff.application_id, packet_id: handoff.packet_id, offer_id: after.app.application_offer_id, terms_hash: after.app.application_terms_hash, offer_author: after.offer.author, lease_id: after.leases[0].id, lease_status: after.leases[0].lease_status, audit_events: after.audit_events, decisions: after.decisions.length }, null, 2));
  } else throw new Error("pass --before-stop or --after-restart");
  await pool.end();
})().catch(async (e) => { console.error(e.stack || e); await pool.end().catch(() => {}); process.exitCode = 1; });
