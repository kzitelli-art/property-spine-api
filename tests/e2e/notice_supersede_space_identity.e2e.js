/*  ════════════════════════════════════════════════════════════════════
    notice_supersede_space_identity.e2e.js — A NOTICE CORRECTION STAYS
    ON THE ORIGINAL BED AND TENANCY.

    This proof drives the real server. Legacy notice writes and the raw
    canonical space-position read use the configured operator key; the
    leasing Availability read uses a real property-scoped staff session
    with leasing module access. SQL is used only to establish fixtures and
    inspect durable receipts.

    PROOF_EXPECT_DEFECT=1 is the pinned-parent receipt mode. It exits zero
    only when the old implementation accepts a Bed-A → Bed-B correction,
    binds its payload to Bed B's lease, omits unit_events.space_id, and the
    canonical readers consequently lose the live notice. Setup/read errors
    and any other behavior still fail.
    ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const boundary = require("./proof_boundary");
boundary.manifest();
const ROOT = path.join(__dirname, "..", "..");
module.paths.unshift(path.join(ROOT, "node_modules"));
const { Pool } = require("pg");
const staffSessions = require(path.join(ROOT, "src/identity/staff_session_service.js"));

const API = (process.env.E2E_API_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const KEY = process.env.E2E_OPERATOR_KEY || "e2e-key";
const CONN = process.env.E2E_DATABASE_URL || "postgres://postgres:spineproof@127.0.0.1:5432/spine_e2e";
const EXPECT_DEFECT = process.env.PROOF_EXPECT_DEFECT === "1";
const AS_OF = "2026-09-05";
const FIRST_DATE = "2026-10-15";
const REPLACEMENT_DATE = "2026-11-20";
const pool = new Pool({ connectionString: CONN });

let passed = 0;
let failed = 0;
const json = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const ymd = (v) => v == null ? null : String(v).slice(0, 10);

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}${detail ? " — " + detail : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? " — " + detail : ""}`);
  }
}

function required(condition, label, detail = "") {
  if (!condition) throw new Error(`${label}${detail ? ": " + detail : ""}`);
  check(label, true, detail);
}

async function api(method, route, { token = null, body = null, key = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-staff-session"] = token;
  if (key) headers["x-operator-key"] = KEY;
  const response = await fetch(API + route, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function noticeRows(unitId) {
  return (await pool.query(
    `select id, status, effective_date::text, space_id, lease_id, payload
       from unit_events
      where unit_id=$1 and event_type='notice_given'
      order by created_at, id`, [unitId])).rows;
}

async function canonicalReads(propertyId, token) {
  const suffix = `?as_of=${AS_OF}`;
  const [space, availability] = await Promise.all([
    api("GET", `/properties/${propertyId}/space-position${suffix}`, { key: true }),
    api("GET", `/operator/leasing/availability-canonical${suffix}&horizon_days=180`, { token }),
  ]);
  required(space.status === 200 && Array.isArray(space.body && space.body.positions),
    "operator-key canonical space-position read is live", `${space.status} ${json(space.body).slice(0, 180)}`);
  required(availability.status === 200 && Array.isArray(availability.body && availability.body.rows),
    "staff-session canonical Availability read is live", `${availability.status} ${json(availability.body).slice(0, 180)}`);
  return { space: space.body.positions, availability: availability.body.rows };
}

function bySpace(rows, spaceId) {
  return rows.find((row) => String(row.space_id) === String(spaceId));
}

function assertPosition(reads, ids, expected, label) {
  const rawA = bySpace(reads.space, ids.bedA);
  const rawB = bySpace(reads.space, ids.bedB);
  const avA = bySpace(reads.availability, ids.bedA);
  const avB = bySpace(reads.availability, ids.bedB);
  check(`${label}: both beds remain in canonical space-position`, !!rawA && !!rawB,
    json({ rawA, rawB }).slice(0, 260));
  check(`${label}: both beds remain in canonical Availability`, !!avA && !!avB,
    json({ avA, avB }).slice(0, 260));
  check(`${label}: Bed A space-position notice state/date`, rawA && rawA.notice_state === expected.aNotice
    && ymd(rawA.notice_date) === expected.aDate, json(rawA).slice(0, 220));
  check(`${label}: Bed A Availability classification/date`, avA && avA.marketing_state === expected.aMarketing
    && avA.notice_state === expected.aNotice && ymd(avA.available_from) === expected.aAvailable,
  json(avA).slice(0, 240));
  check(`${label}: Bed B keeps its lease and classification`, rawB && avB
    && rawB.current_lease_position && String(rawB.current_lease_position.lease_id) === String(ids.leaseB)
    && avB.current_lease && String(avB.current_lease.lease_id) === String(ids.leaseB)
    && rawB.notice_state === "none" && ymd(rawB.notice_date) === null
    && avB.marketing_state === "occupied" && avB.notice_state === "none",
  json({ rawB, avB }).slice(0, 320));
}

(async () => {
  await boundary.assertDatabase();
  const tag = `NSI${Date.now()}${Math.floor(Math.random() * 1000)}`;
  console.log(`\nPROOF_SOURCE=tests/e2e/notice_supersede_space_identity.e2e.js mode=${EXPECT_DEFECT ? "expected-defect" : "repair"}`);

  const property = await one(
    `insert into properties (name,address,leasing_basis)
     values ($1,'19 Identity Way','bed') returning id`, [tag]);
  const unit = await one(
    `insert into units (property_id,unit_number,operating_use)
     values ($1,'2B','standard') returning id`, [property.id]);
  const bedA = await one(
    `update spaces set space_label='Bed A',use_type='residential',position_kind='bed'
      where id=(select id from spaces where unit_id=$1 order by created_at,id limit 1)
      returning id`, [unit.id]);
  const bedB = await one(
    `insert into spaces (unit_id,space_label,use_type,position_kind)
     values ($1,'Bed B','residential','bed') returning id`, [unit.id]);
  const residentA = await one("insert into persons (name) values ($1) returning id", [`${tag} Resident A`]);
  const residentB = await one("insert into persons (name) values ($1) returning id", [`${tag} Resident B`]);
  const leaseA = await one(
    `insert into leases (property_id,space_id,tenant_ids,lease_status,start_date,end_date,rent)
     values ($1,$2,$3,'active','2026-01-01','2027-03-31',1100) returning id`,
    [property.id, bedA.id, [residentA.id]]);
  const leaseB = await one(
    `insert into leases (property_id,space_id,tenant_ids,lease_status,start_date,end_date,rent)
     values ($1,$2,$3,'active','2026-01-01','2027-03-31',1150) returning id`,
    [property.id, bedB.id, [residentB.id]]);

  const user = await one(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'property_manager',true,'active','human_staff') returning id`,
    [`${tag} Operator`, `${tag.toLowerCase()}@example.com`]);
  await pool.query(
    `insert into property_team_assignments
       (property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
     values ($1,$2,'Proof Manager','property','{leasing}','{leasing}',false,true)`,
    [property.id, user.id]);

  const client = await pool.connect();
  let token;
  try {
    await client.query("begin");
    token = (await staffSessions.issueStaffSession(client, {
      userId: user.id, propertyId: property.id, purpose: "sms_otp",
    })).session_token;
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  required(!!token, "canonical staff-session service issued a token");

  const build = await api("GET", "/operator/build", { token });
  required(build.status === 200 && build.body && build.body.build,
    "runtime build receipt is readable through the staff session", `${build.status} ${json(build.body).slice(0, 180)}`);
  const runtimeCommit = build.body.build.commit || build.body.build.commit_short || "unknown";
  console.log(`PROOF_RUNTIME=${runtimeCommit} resolved_from=${build.body.build.resolved_from || "unknown"}`);
  if (process.env.E2E_EXPECT_SERVER_COMMIT) {
    required(String(runtimeCommit).startsWith(process.env.E2E_EXPECT_SERVER_COMMIT),
      "runtime commit matches E2E_EXPECT_SERVER_COMMIT", String(runtimeCommit));
  }

  const ids = { bedA: bedA.id, bedB: bedB.id, leaseA: leaseA.id, leaseB: leaseB.id };
  const before = await canonicalReads(property.id, token);
  assertPosition(before, ids, {
    aNotice: "none", aDate: null, aMarketing: "occupied", aAvailable: null,
  }, "before notice");

  console.log("\n── give Bed A notice through the legacy operator-key writer ──");
  const given = await api("POST", `/units/${unit.id}/notice`, {
    key: true, body: { move_out_date: FIRST_DATE, given_by: tag, space_id: bedA.id },
  });
  required(given.status === 201 && given.body && given.body.unit_event
      && String(given.body.resolved_tenancy && given.body.resolved_tenancy.space_id) === String(bedA.id)
      && String(given.body.resolved_tenancy && given.body.resolved_tenancy.lease_id) === String(leaseA.id),
  "initial notice resolves Bed A's live tenancy", `${given.status} ${json(given.body).slice(0, 240)}`);
  const originalId = given.body.unit_event.id;
  const initialRows = await noticeRows(unit.id);
  required(initialRows.length === 1 && String(initialRows[0].space_id) === String(bedA.id)
      && String(initialRows[0].payload.lease_id) === String(leaseA.id),
  "initial durable notice is anchored to Bed A", json(initialRows));
  const afterGive = await canonicalReads(property.id, token);
  assertPosition(afterGive, ids, {
    aNotice: "on_notice", aDate: FIRST_DATE, aMarketing: "upcoming", aAvailable: FIRST_DATE,
  }, "after initial notice");

  console.log("\n── cross-bed correction attempt ──");
  const beforeCross = json(await noticeRows(unit.id));
  const cross = await api("POST", `/units/${unit.id}/notice/supersede`, {
    key: true, body: { move_out_date: REPLACEMENT_DATE, given_by: tag, space_id: bedB.id },
  });

  if (EXPECT_DEFECT) {
    const defectRows = await noticeRows(unit.id);
    const oldRow = defectRows.find((row) => String(row.id) === String(originalId));
    const replacement = defectRows.find((row) => String(row.id) !== String(originalId));
    const defectReads = await canonicalReads(property.id, token);
    const rawA = bySpace(defectReads.space, bedA.id);
    const rawB = bySpace(defectReads.space, bedB.id);
    const avA = bySpace(defectReads.availability, bedA.id);
    const avB = bySpace(defectReads.availability, bedB.id);
    const exactDefect = cross.status === 201
      && defectRows.length === 2
      && oldRow && oldRow.status === "superseded"
      && replacement && replacement.status === "scheduled"
      && replacement.space_id == null
      && String(replacement.payload.space_id) === String(bedB.id)
      && String(replacement.payload.lease_id) === String(leaseB.id)
      && String(replacement.payload.supersedes_event_id) === String(originalId)
      && String(oldRow.payload.superseded_by_event_id) === String(replacement.id)
      && rawA && rawA.notice_state === "none" && rawB && rawB.notice_state === "none"
      && avA && avA.marketing_state === "occupied"
      && avB && avB.marketing_state === "occupied";
    required(exactDefect,
      "pinned parent exhibits the exact accepted-retarget plus null-column reader loss",
      json({ status: cross.status, body: cross.body, defectRows, rawA, rawB, avA, avB }).slice(0, 1200));
    console.log(`EXPECTED_DEFECT_OBSERVED cross_bed_accepted=201 replacement_space_column=null payload_space=${bedB.id} canonical_notice_lost=true`);
    await pool.end();
    process.exit(0);
  }

  check("cross-bed supersede is rejected with the identity mismatch receipt",
    cross.status === 409 && cross.body && cross.body.detail === "space_identity_mismatch",
    `${cross.status} ${json(cross.body)}`);
  check("cross-bed refusal makes zero notice mutation", json(await noticeRows(unit.id)) === beforeCross,
    json(await noticeRows(unit.id)));
  const afterCross = await canonicalReads(property.id, token);
  assertPosition(afterCross, ids, {
    aNotice: "on_notice", aDate: FIRST_DATE, aMarketing: "upcoming", aAvailable: FIRST_DATE,
  }, "after cross-bed refusal");

  console.log("\n── malformed predecessor identities fail closed ──");
  await pool.query("update unit_events set payload=jsonb_set(payload,'{space_id}',to_jsonb($2::text)) where id=$1",
    [originalId, bedB.id]);
  const contradictoryBefore = json(await noticeRows(unit.id));
  const contradictory = await api("POST", `/units/${unit.id}/notice/supersede`, {
    key: true, body: { move_out_date: REPLACEMENT_DATE, given_by: tag },
  });
  check("contradictory column/payload space identity is rejected",
    contradictory.status === 409 && contradictory.body
      && contradictory.body.detail === "prior_space_id_contradicts_snapshot",
    `${contradictory.status} ${json(contradictory.body)}`);
  check("contradictory predecessor refusal makes zero mutation",
    json(await noticeRows(unit.id)) === contradictoryBefore, json(await noticeRows(unit.id)));
  await pool.query("update unit_events set payload=jsonb_set(payload,'{space_id}',to_jsonb($2::text)) where id=$1",
    [originalId, bedA.id]);

  await pool.query("update unit_events set payload=payload-'lease_id', lease_id=null where id=$1", [originalId]);
  const missingBefore = json(await noticeRows(unit.id));
  const missing = await api("POST", `/units/${unit.id}/notice/supersede`, {
    key: true, body: { move_out_date: REPLACEMENT_DATE, given_by: tag },
  });
  check("missing original lease identity is rejected",
    missing.status === 409 && missing.body && missing.body.detail === "prior_lease_id_missing",
    `${missing.status} ${json(missing.body)}`);
  check("missing predecessor refusal makes zero mutation",
    json(await noticeRows(unit.id)) === missingBefore, json(await noticeRows(unit.id)));
  await pool.query(
    "update unit_events set lease_id=$2::uuid, payload=jsonb_set(payload,'{lease_id}',to_jsonb($2::uuid)) where id=$1",
    [originalId, leaseA.id]);

  console.log("\n── same bed with a different active lease is still a different tenancy ──");
  await pool.query("update leases set lease_status='past' where id=$1", [leaseA.id]);
  const replacementLease = await one(
    `insert into leases (property_id,space_id,tenant_ids,lease_status,start_date,end_date,rent)
     values ($1,$2,$3,'active','2026-01-01','2027-03-31',1200) returning id`,
    [property.id, bedA.id, [residentA.id]]);
  const beforeLeaseMismatch = json(await noticeRows(unit.id));
  const leaseMismatch = await api("POST", `/units/${unit.id}/notice/supersede`, {
    key: true, body: { move_out_date: REPLACEMENT_DATE, given_by: tag, space_id: bedA.id },
  });
  check("same-space changed-lease supersede is rejected",
    leaseMismatch.status === 409 && leaseMismatch.body
      && leaseMismatch.body.detail === "lease_identity_mismatch",
    `${leaseMismatch.status} ${json(leaseMismatch.body)}`);
  check("changed-lease refusal makes zero notice mutation",
    json(await noticeRows(unit.id)) === beforeLeaseMismatch, json(await noticeRows(unit.id)));
  await pool.query("delete from leases where id=$1", [replacementLease.id]);
  await pool.query("update leases set lease_status='active' where id=$1", [leaseA.id]);

  console.log("\n── valid date correction preserves column-only legacy identity ──");
  await pool.query(
    "update unit_events set lease_id=$2, payload=payload-'space_id'-'lease_id' where id=$1",
    [originalId, leaseA.id]);
  const corrected = await api("POST", `/units/${unit.id}/notice/supersede`, {
    key: true, body: { move_out_date: REPLACEMENT_DATE, given_by: `${tag} corrected` },
  });
  check("valid correction is accepted", corrected.status === 201 && corrected.body && corrected.body.unit_event,
    `${corrected.status} ${json(corrected.body).slice(0, 240)}`);
  const replacementId = corrected.body && corrected.body.unit_event && corrected.body.unit_event.id;
  const correctedRows = await noticeRows(unit.id);
  const prior = correctedRows.find((row) => String(row.id) === String(originalId));
  const replacement = correctedRows.find((row) => String(row.id) === String(replacementId));
  check("correction leaves exactly one superseded original and one scheduled replacement",
    correctedRows.length === 2 && prior && prior.status === "superseded"
      && replacement && replacement.status === "scheduled", json(correctedRows));
  check("replacement preserves original space and lease in columns and normalized payload",
    replacement && String(replacement.space_id) === String(bedA.id)
      && String(replacement.lease_id) === String(leaseA.id)
      && String(replacement.payload.space_id) === String(bedA.id)
      && String(replacement.payload.lease_id) === String(leaseA.id)
      && ymd(replacement.effective_date) === REPLACEMENT_DATE,
    json(replacement));
  check("supersession pointers link both directions",
    prior && replacement
      && String(prior.payload.superseded_by_event_id) === String(replacement.id)
      && String(replacement.payload.supersedes_event_id) === String(prior.id),
    json({ prior, replacement }));
  const afterCorrection = await canonicalReads(property.id, token);
  assertPosition(afterCorrection, ids, {
    aNotice: "on_notice", aDate: REPLACEMENT_DATE, aMarketing: "upcoming", aAvailable: REPLACEMENT_DATE,
  }, "after valid correction");

  console.log("\n── cancel only the live replacement ──");
  const cancelled = await api("POST", `/unit-events/${replacementId}/cancel-notice`, {
    key: true, body: { reason: "resident renewed", cancelled_by: tag },
  });
  check("replacement cancellation is accepted", cancelled.status === 200,
    `${cancelled.status} ${json(cancelled.body).slice(0, 220)}`);
  const finalRows = await noticeRows(unit.id);
  const finalPrior = finalRows.find((row) => String(row.id) === String(originalId));
  const finalReplacement = finalRows.find((row) => String(row.id) === String(replacementId));
  check("cancellation retains exactly two notice rows with terminal states",
    finalRows.length === 2 && finalPrior && finalPrior.status === "superseded"
      && finalReplacement && finalReplacement.status === "cancelled", json(finalRows));
  check("cancellation retains both supersession pointers",
    finalPrior && finalReplacement
      && String(finalPrior.payload.superseded_by_event_id) === String(replacementId)
      && String(finalReplacement.payload.supersedes_event_id) === String(originalId),
    json({ finalPrior, finalReplacement }));
  const afterCancel = await canonicalReads(property.id, token);
  assertPosition(afterCancel, ids, {
    aNotice: "none", aDate: null, aMarketing: "occupied", aAvailable: null,
  }, "after replacement cancellation");

  await pool.end();
  console.log(`\n══ notice supersede space identity: ${passed} passed, ${failed} failed ══`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error("HARNESS ERROR:", e && e.stack ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
