// ════════════════════════════════════════════════════════════════════
//  slice9_journey_fixture.js — APPOINTMENT JOURNEY FIXTURES
//
//  Transaction-scoped. Seeds one scratch property with every appointment shape
//  the attribution analyzer and the journey projector must answer for, then the
//  caller rolls back. Never touches Demo Building.
//
//  EVERY FIXTURE IS NAMED. now() is transaction time, so every row shares one
//  created_at and time-ordering is arbitrary — assertions key on identity.
//
//  REQUIRES the attribution bridge (leasing_tours.conversion_id,
//  scheduled_tours.conversion_id). Until the numbered migration exists that is
//  supplied locally by scratch DDL, which is proof scaffolding and NOT
//  deployment authority.
// ════════════════════════════════════════════════════════════════════

"use strict";

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

async function seedJourney(c) {
  const one = async (sql, a) => (await c.query(sql, a)).rows[0];
  const now = Date.now();
  const past = (d) => iso(now - d * DAY);
  const future = (d) => iso(now + d * DAY);

  const prop = await one(
    `insert into properties (name, leasing_basis) values ('Journey scratch property','unknown') returning id`);
  const P = prop.id;
  const other = (await one(
    `insert into properties (name, leasing_basis) values ('Journey other property','unknown') returning id`)).id;

  const host = await one(
    `insert into users (name, email, role, is_active, status, account_kind)
     values ('Journey host', $1, 'leasing_agent', true, 'active', 'internal_qa') returning id`,
    [`journey.host.${now}@local.invalid`]);
  const recorder = await one(
    `insert into users (name, email, role, is_active, status, account_kind)
     values ('Journey recorder', $1, 'property_manager', true, 'active', 'internal_qa') returning id`,
    [`journey.rec.${now}@local.invalid`]);

  const person = await one(
    `insert into persons (name, lifecycle_status) values ('Journey prospect','lead') returning id`);
  const person2 = await one(
    `insert into persons (name, lifecycle_status) values ('Journey prospect two','lead') returning id`);

  const unit = await one(
    `insert into units (property_id, unit_number) values ($1,'J-101') returning id`, [P]);
  const otherUnit = await one(
    `insert into units (property_id, unit_number) values ($1,'X-1') returning id`, [other]);

  // ONE lead carrying TWO opportunities over time — the case that makes
  // lead_id unusable as a journey key.
  const lead = await one(
    `insert into leasing_leads (person_id, property_id, unit_id, status)
     values ($1,$2,$3,'tour_scheduled') returning id`, [person.id, P, unit.id]);
  const lead2 = await one(
    `insert into leasing_leads (person_id, property_id, status)
     values ($1,$2,'tour_scheduled') returning id`, [person2.id, P]);

  const opp = {};
  const opportunity = async (name, { status = "active", personId = person.id, propId = P } = {}) => {
    // actual_tour_host_user_id and conversation_owner_user_id are NOT NULL
    // (migration 047: "actual_tour_host_user_id is the relationship truth and is
    // immutable"). An opportunity is born FROM a tour that was actually given,
    // so it cannot exist without naming who gave it. That is by design — and it
    // is exactly why the column is the ORIGINATING host, not a per-occurrence one.
    const row = await one(
      `insert into leasing_conversions
         (person_id, property_id, lead_id, status, current_stage, opened_at,
          actual_tour_host_user_id, conversation_owner_user_id)
       values ($1,$2,$3,$4,'tour_followup',now(),$5,$5) returning id`,
      [personId, propId, personId === person.id ? lead.id : lead2.id, status, host.id]);
    opp[name] = row.id;
    return row.id;
  };

  // TWO opportunities for the SAME lead. Only one may be 'active' — the partial
  // unique index enforces it — so the earlier one is closed.
  const oppOld = await opportunity("old", { status: "released" });
  const oppCurrent = await opportunity("current");
  const oppOther = await opportunity("other_property", { personId: person2.id, propId: P });

  const T = {};
  const tour = async (name, {
    conversionId = null, status = "scheduled", scheduledFor, rescheduledFrom = null,
    completedAt = null, noShowAt = null, cancelledAt = null, checkedInAt = null,
    leadId = lead.id, propId = P, unitId = unit.id, origin = "scheduled",
  }) => {
    const row = await one(
      `insert into leasing_tours
         (lead_id, property_id, unit_id, leasing_agent_id, scheduled_for, status,
          rescheduled_from, completed_at, no_show_at, cancelled_at, checked_in_at,
          origin, conversion_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [leadId, propId, unitId, host.id, scheduledFor, status, rescheduledFrom,
       completedAt, noShowAt, cancelledAt, checkedInAt, origin, conversionId]);
    T[name] = row.id;
    return row.id;
  };

  // tour_events is the SOURCE OF TRUTH; status columns are its projection.
  const event = async (tourId, type, at, metadata = {}) => one(
    `insert into tour_events (tour_id, lead_id, event_type, event_at, actor_type, actor_id, metadata)
     values ($1,$2,$3,$4,'human',$5,$6) returning id`,
    [tourId, lead.id, type, at, recorder.id, JSON.stringify(metadata)]);

  // ── 1 · ATTRIBUTED NATIVE COMPLETED APPOINTMENT ────────────────────
  //  actual host + outcome recorded against the EXACT occurrence.
  const a1 = await tour("A-completed", {
    conversionId: oppCurrent, status: "completed",
    scheduledFor: past(10), completedAt: past(10), checkedInAt: past(10) });
  await event(a1, "scheduled", past(14));
  await event(a1, "checked_in", past(10));
  await event(a1, "completed", past(10), {
    actual_tour_host_user_id: host.id, tour_outcome: "interested",
    recorded_by_user_id: recorder.id, capture_idempotency_key: "cap-a1" });

  // ── 13 · CORRECTED OUTCOME — prior truth preserved ─────────────────
  await event(a1, "completed", past(9), {
    actual_tour_host_user_id: host.id, tour_outcome: "very_interested",
    recorded_by_user_id: recorder.id, correction_of: "cap-a1", is_correction: true });

  // ── 2 · RESCHEDULE CHAIN carrying ONE opportunity through EVERY successor
  const b1 = await tour("B-chain-root", {
    conversionId: oppCurrent, status: "rescheduled", scheduledFor: past(30) });
  const b2 = await tour("B-chain-mid", {
    conversionId: oppCurrent, status: "rescheduled", scheduledFor: past(20), rescheduledFrom: b1 });
  const b3 = await tour("B-chain-tail", {
    conversionId: oppCurrent, status: "completed", scheduledFor: past(5),
    rescheduledFrom: b2, completedAt: past(5) });
  await event(b3, "completed", past(5), {
    actual_tour_host_user_id: host.id, tour_outcome: "applied", recorded_by_user_id: recorder.id });

  // ── 3 · CANCELLED CHAIN + SEPARATELY BOOKED COMPLETED CHAIN ────────
  //  Two chains, same opportunity. They must NOT collapse into one.
  const c1 = await tour("C-cancelled-root", {
    conversionId: oppCurrent, status: "cancelled", scheduledFor: past(40), cancelledAt: past(41) });
  const c2 = await tour("C-separate-completed", {
    conversionId: oppCurrent, status: "completed", scheduledFor: past(3), completedAt: past(3) });
  await event(c2, "completed", past(3), {
    actual_tour_host_user_id: host.id, tour_outcome: "interested", recorded_by_user_id: recorder.id });

  // ── 7 · UNATTRIBUTED appointment for the SAME lead → untrackable ────
  //  Associable ONLY by lead/person/property/time, which is forbidden.
  await tour("D-unattributed", { conversionId: null, status: "completed",
    scheduledFor: past(60), completedAt: past(60) });

  // ── 9 · CONFLICTING OPPORTUNITY LINKS WITHIN ONE CHAIN ─────────────
  const e1 = await tour("E-conflict-root", {
    conversionId: oppOld, status: "rescheduled", scheduledFor: past(50) });
  await tour("E-conflict-tail", {
    conversionId: oppCurrent, status: "scheduled", scheduledFor: past(45), rescheduledFrom: e1 });

  // ── 10 · RESCHEDULE CYCLE → untrackable ────────────────────────────
  const f1 = await tour("F-cycle-a", { conversionId: oppCurrent, status: "rescheduled", scheduledFor: past(70) });
  const f2 = await tour("F-cycle-b", { conversionId: oppCurrent, status: "rescheduled",
    scheduledFor: past(69), rescheduledFrom: f1 });
  await c.query(`update leasing_tours set rescheduled_from=$1 where id=$2`, [f2, f1]);

  // ── 11 · WRONG-PROPERTY ATTRIBUTION ────────────────────────────────
  //  A tour at ANOTHER property pointed at this property's opportunity.
  await tour("G-wrong-property", { conversionId: oppCurrent, status: "scheduled",
    scheduledFor: past(2), propId: other, unitId: otherUnit.id });

  // ── 5 · PAST NATIVE APPOINTMENT, NO OBSERVATION → unknown ──────────
  await tour("H-past-no-observation", { conversionId: oppCurrent, status: "scheduled",
    scheduledFor: past(1) });

  // ── FUTURE SCHEDULED — pending, never "occurred" ────────────────────
  await tour("I-future-scheduled", { conversionId: oppCurrent, status: "scheduled",
    scheduledFor: future(7) });

  // ── EXTERNAL APPOINTMENTS ──────────────────────────────────────────
  const S = {};
  const ext = async (name, { conversionId = null, status = "scheduled", start, propId = P }) => {
    const row = await one(
      `insert into scheduled_tours
         (property_id, person_id, prospect_name, source_system, scheduled_start,
          scheduled_host_user_id, status, authority, conversion_id)
       values ($1,$2,'Journey prospect','outlook',$3,$4,$5,'individual',$6) returning id`,
      [propId, person.id, start, host.id, status, conversionId]);
    S[name] = row.id;
    return row.id;
  };
  const revision = async (tourId, change, prev, next) => c.query(
    `insert into scheduled_tour_revisions
       (scheduled_tour_id, change_type, prev_scheduled_start, prev_status,
        new_scheduled_start, new_status)
     values ($1,$2,$3,$4,$5,$6)`,
    [tourId, change, prev.start || null, prev.status || null, next.start || null, next.status || null]);

  // ── 4 · EXTERNAL WITH TWO+ REVISIONS ───────────────────────────────
  //  The row holds only the LAST move. Intermediate occurrences exist ONLY in
  //  the revision log — reading the row alone loses them.
  const x1 = await ext("X-multi-revision", { conversionId: oppCurrent, status: "rescheduled", start: past(4) });
  await revision(x1, "created",     {},                                   { start: past(30), status: "scheduled" });
  await revision(x1, "rescheduled", { start: past(30), status: "scheduled" },   { start: past(15), status: "rescheduled" });
  await revision(x1, "rescheduled", { start: past(15), status: "rescheduled" }, { start: past(4),  status: "rescheduled" });
  await c.query(`update scheduled_tours set previous_start=$1, reschedule_count=2 where id=$2`,
    [past(15), x1]);

  // ── 6 · EXTERNAL PAST, NO OBSERVATION → unknown, never no-show ─────
  const x2 = await ext("X-past-unobserved", { conversionId: oppCurrent, start: past(6) });
  await revision(x2, "created", {}, { start: past(6), status: "scheduled" });

  // ── EXTERNAL UNATTRIBUTED ──────────────────────────────────────────
  await ext("X-unattributed", { conversionId: null, start: past(8) });

  // ── 8 · EXACT HISTORICAL POINTER (no conversion_id, legacy shape) ───
  //  A tour claimed only by leasing_conversions.origin_tour_id — the exact
  //  pointer the analyzer must find and the backfill may safely use.
  const legacy = await tour("L-legacy-pointer", { conversionId: null, status: "completed",
    scheduledFor: past(80), completedAt: past(80) });
  await c.query(`update leasing_conversions set origin_tour_id=$1 where id=$2`, [legacy, oppOld]);
  const legacyExt = await ext("L-legacy-external", { conversionId: null, start: past(85) });
  await c.query(`update leasing_conversions set scheduled_tour_id=$1 where id=$2`, [legacyExt, oppOld]);

  return {
    property_id: P, other_property_id: other,
    lead_id: lead.id, person_id: person.id,
    host_user_id: host.id, recorder_user_id: recorder.id,
    unit_id: unit.id,
    opportunities: opp, tours: T, external: S,
  };
}

module.exports = { seedJourney };
