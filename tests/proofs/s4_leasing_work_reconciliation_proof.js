#!/usr/bin/env node
"use strict";
// ════════════════════════════════════════════════════════════════════
//  s4_leasing_work_reconciliation_proof.js — Slice 4 population proof.
//
//  PROOF-ONLY artifact (ruled): the per-record reconciliation between the
//  Applications Review population and the Leasing Work projection is a
//  handback deliverable, not permanent operator-screen content. The
//  permanent API returns the correct active population; THIS file proves
//  it and prints the ruled report.
//
//  It runs the REAL loader (loadLeasingDesk) and the REAL review list
//  (buildReviewList) against a REAL Postgres carrying a fixture property
//  built to cover every omission/ inclusion class:
//
//    included   : available, blocked, waiting (RESTORED by S4), lease
//                 stage, uncorrelated (no person), rail rows, tour capture
//    omitted    : exited (active / declined) — server-authored lifecycle
//                 exits, the ONLY legitimate omissions
//    counted    : untrackable tours (not shown as owed, never silent)
//
//  Classification is EXECUTED through the module's own exported
//  functions (stageForApplicationNext), never re-derived by this proof.
//
//  Run:  DATABASE_URL=postgres://... node tests/proofs/s4_leasing_work_reconciliation_proof.js
//  The final line prints COUNTED totals; exit code is the verdict.
// ════════════════════════════════════════════════════════════════════
const path = require("path");
const { Pool } = require("pg");

const ROOT = path.join(__dirname, "..", "..");
const desk = require(path.join(ROOT, "src", "leasing", "leasing_desk.js"));
const loader = require(path.join(ROOT, "src", "leasing", "leasing_desk_loader.js"));
const { buildReviewList, buildReviewDetail } = require(path.join(ROOT, "src", "applications", "application_review.js"));
const staffIdentity = require(path.join(ROOT, "src", "identity", "staff_identity_resolver.js"));
const applicationsModule = require(path.join(ROOT, "src", "applications", "applications.js"));

const url = process.env.DATABASE_URL;
if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(2); }

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("   PASS  " + m); } else { failed++; console.log("   FAIL  " + m); } };

// Fixed fixture ids — idempotent re-runs. All rows hang off P.
const U = (n) => `f4f4f4f4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = U(1);                    // property
const USER_KATIE = U(10);
const PEOPLE = { appr: U(21), wait: U(22), block: U(23), lease: U(24), dec: U(25), act: U(26), draft: U(27), qa: U(28), post: U(31), una: U(32), owed: U(41), untrk: U(42), done: U(43), futr: U(44) };
const APPS = { appr: U(101), wait: U(102), block: U(103), lease: U(104), dec: U(105), act: U(106), draft: U(107), orph: U(108), qa: U(109) };
const TOURS = { owed: U(201), untrk: U(202), done: U(203), futr: U(204), conv1: U(205), conv2: U(206) };
const SLOTS = { owed: U(211), futr: U(212) };
const LEADS = { owed: U(221), untrk: U(222), done: U(223), futr: U(224), conv1: U(225), conv2: U(226) };
const CONVS = { post: U(301), una: U(302) };
const OBLS = { post: U(311), una: U(312), gwait: U(321), gblock: U(322), glease: U(323) };
const PACKETS = { wait: U(331), block: U(332) };

async function resetFixture(c) {
  // children → parents; persons/users are global, so delete by fixed id.
  await c.query(`delete from staff_sessions where property_id = $1`, [P]);
  await c.query(`delete from person_property_classifications where property_id = $1`, [P]);
  await c.query(`delete from lease_packets where property_id = $1`, [P]);
  await c.query(`delete from lease_applications where property_id = $1`, [P]);
  await c.query(`delete from leasing_conversion_obligations where conversion_id in (select id from leasing_conversions where property_id = $1)`, [P]);
  await c.query(`delete from obligations where property_id = $1`, [P]);
  await c.query(`delete from leasing_conversions where property_id = $1`, [P]);
  await c.query(`delete from leasing_tours where property_id = $1`, [P]);
  await c.query(`delete from tour_availability where property_id = $1`, [P]);
  await c.query(`delete from leasing_leads where property_id = $1`, [P]);
  await c.query(`delete from conversations where property_id = $1`, [P]);
  await c.query(`delete from property_team_assignments where property_id = $1`, [P]);
  await c.query(`delete from persons where id = any($1::uuid[])`, [[...Object.values(PEOPLE)]]);
  await c.query(`delete from users where id = $1`, [USER_KATIE]);
  await c.query(`delete from properties where id = $1`, [P]);
}

async function buildFixture(c) {
  await c.query(`insert into properties (id, name) values ($1, 'S4 Proof Property')`, [P]);
  await c.query(`insert into users (id, name, role, is_active, status) values ($1, 'Katie Host', 'leasing_agent', true, 'active')`, [USER_KATIE]);
  await c.query(`insert into property_team_assignments (property_id, user_id, role_title, scope_type, allowed_modules, primary_for_modules, can_manage_roles, active)
                 values ($1, $2, 'Leasing Agent', 'property', '{leasing}', '{leasing}', false, true)`, [P, USER_KATIE]);
  for (const [k, id] of Object.entries(PEOPLE)) {
    await c.query(`insert into persons (id, name, lifecycle_status) values ($1, $2, 'prospect')`, [id, `Person ${k}`]);
    const cls = k === "qa" ? "internal_qa" : "production";
    await c.query(`insert into person_property_classifications (property_id, person_id, record_class, classification_source) values ($1, $2, $3, 'system')`, [P, id, cls]);
  }

  // conversations for the waiting + owed-tour people (deterministic join proof)
  await c.query(`insert into conversations (property_id, person_id, last_message_at) values ($1, $2, now() - interval '1 hour')`, [P, PEOPLE.wait]);
  await c.query(`insert into conversations (property_id, person_id, last_message_at) values ($1, $2, now() - interval '2 hours')`, [P, PEOPLE.owed]);

  // ── applications (the AR population: 8 rows) ──────────────────────
  const app = (id, person, status, extra = {}) => c.query(
    `insert into lease_applications (id, property_id, person_id, status, applicant_name, unit_label,
                                     terms_review_obligation_id, applicant_signed_at)
     values ($1, $2, $3, $4, $5, '304', $6, $7)`,
    [id, P, person, status, person ? `App ${status}` : "Orphan Applicant", extra.gate || null, extra.signed_at || null]);

  // gates (terms_review obligations) for the resolver's middle/late branches
  const gate = (id, status) => c.query(
    `insert into obligations (id, property_id, module, type, label, status, required_inputs)
     values ($1, $2, 'leasing', 'terms_review', 'Terms review', $3, '{}')`, [id, P, status]);
  await gate(OBLS.gwait, "open");
  await gate(OBLS.gblock, "open");
  await gate(OBLS.glease, "complete");

  await app(APPS.appr, PEOPLE.appr, "submitted");                                  // → approve (available, application)
  await app(APPS.wait, PEOPLE.wait, "approved", { gate: OBLS.gwait, signed_at: null }); // → awaiting (WAITING, lease stage)
  await app(APPS.block, PEOPLE.block, "approved", { gate: OBLS.gblock });          // → blocked (packet w/o confirmation)
  await app(APPS.lease, PEOPLE.lease, "approved", { gate: OBLS.glease });          // gate closed → executed_lease_required
  await app(APPS.dec, PEOPLE.dec, "declined");                                     // → exited
  await app(APPS.act, PEOPLE.act, "active");                                       // → exited
  await app(APPS.draft, PEOPLE.draft, "draft");                                    // → review_application (available)
  await app(APPS.orph, null, "draft");                                             // → uncorrelated, still visible
  await app(APPS.qa, PEOPLE.qa, "submitted");                                      // → QA person: rail hides, records mirror AR

  // packets: issued one for WAIT (status 'sent' ⇒ awaiting), draft one for BLOCK
  const packet = (id, appId, status, sent) => c.query(
    `insert into lease_packets (id, property_id, application_id, version, status, terms_json, rendered_snapshot, is_placeholder, sent_at)
     values ($1, $2, $3, 1, $4, '{}', '{}', false, $5)`, [id, P, appId, status, sent]);
  await packet(PACKETS.wait, APPS.wait, "sent", new Date().toISOString());
  await packet(PACKETS.block, APPS.block, "draft", null);

  // ── follow-up rail (2 rows, both post-tour) ───────────────────────
  const lead = (id, person) => c.query(
    `insert into leasing_leads (id, property_id, person_id, status) values ($1, $2, $3, 'tour_scheduled')`, [id, P, person]);
  const tour = (id, leadId, status, extra = {}) => c.query(
    `insert into leasing_tours (id, lead_id, property_id, status, slot_id, leasing_agent_id, origin, scheduled_for)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, leadId, P, status, extra.slot || null, extra.host || null, extra.origin || "scheduled", extra.scheduled_for || null]);

  await lead(LEADS.conv1, PEOPLE.post);
  await lead(LEADS.conv2, PEOPLE.una);
  await tour(TOURS.conv1, LEADS.conv1, "completed", { scheduled_for: "2026-07-20T15:00:00Z" });
  await tour(TOURS.conv2, LEADS.conv2, "completed", { scheduled_for: "2026-07-21T15:00:00Z" });

  const conversion = (id, person, tourId) => c.query(
    `insert into leasing_conversions (id, person_id, property_id, origin_tour_id, actual_tour_host_user_id,
                                      conversation_owner_user_id, handoff_required, current_stage, status)
     values ($1, $2, $3, $4, $5, $5, false, 'tour_followup', 'active')`, [id, person, P, tourId, USER_KATIE]);
  await conversion(CONVS.post, PEOPLE.post, TOURS.conv1);
  await conversion(CONVS.una, PEOPLE.una, TOURS.conv2);

  const railObl = (id, label, due) => c.query(
    `insert into obligations (id, property_id, module, type, label, status, due_at)
     values ($1, $2, 'leasing', 'lead_response', $3, 'open', $4)`, [id, P, label, due]);
  await railObl(OBLS.post, "Follow up after tour", new Date(Date.now() + 864e5).toISOString());
  await railObl(OBLS.una, "Send application", new Date(Date.now() - 864e5).toISOString());

  const lco = (conv, obl, owner) => c.query(
    `insert into leasing_conversion_obligations (conversion_id, obligation_id, rung, owner_user_id, next_move_code)
     values ($1, $2, 'tour_followup', $3, 'send_follow_up')`, [conv, obl, owner]);
  await lco(CONVS.post, OBLS.post, USER_KATIE);
  await lco(CONVS.una, OBLS.una, null);

  // ── tours for the capture set ─────────────────────────────────────
  await c.query(`insert into tour_availability (id, property_id, starts_at, ends_at, capacity, status)
                 values ($1, $2, now() - interval '4 hours', now() - interval '3 hours', 1, 'open'),
                        ($3, $2, now() + interval '20 hours', now() + interval '21 hours', 1, 'open')`,
    [SLOTS.owed, P, SLOTS.futr]);
  await lead(LEADS.owed, PEOPLE.owed);
  await lead(LEADS.untrk, PEOPLE.untrk);
  await lead(LEADS.done, PEOPLE.done);
  await lead(LEADS.futr, PEOPLE.futr);
  await tour(TOURS.owed, LEADS.owed, "scheduled", { slot: SLOTS.owed, scheduled_for: new Date(Date.now() - 4 * 36e5).toISOString() }); // ended 3h ago → capture OWED
  await tour(TOURS.untrk, LEADS.untrk, "requested", {});                                    // no slot, no time → UNTRACKABLE
  await tour(TOURS.done, LEADS.done, "completed", { scheduled_for: "2026-07-22T15:00:00Z" }); // terminal → settled
  await tour(TOURS.futr, LEADS.futr, "scheduled", { slot: SLOTS.futr, scheduled_for: new Date(Date.now() + 72e6).toISOString() }); // future → nothing owed
}

(async () => {
  const pool = new Pool({ connectionString: url });
  const c = await pool.connect();
  try {
    await resetFixture(c);
    await buildFixture(c);
  } finally { c.release(); }

  const appsRouter = applicationsModule({ pool });
  const applicationsService = appsRouter._service;
  const deps = {
    pool,
    applicationReview: { buildReviewList, buildReviewDetail },
    applicationsService,
    conversionService: null,
    staffIdentity,
  };

  // ── the two real reads ────────────────────────────────────────────
  const clientA = await pool.connect();
  let review;
  try { review = await buildReviewList(clientA, P); } finally { clientA.release(); }
  const out = await loader.loadLeasingDesk(deps, P);

  const railRows = [...out.stages.post_tour, ...out.stages.application, ...out.stages.lease_sent];
  const railAppIds = new Set(railRows.map((r) => r.application_id).filter(Boolean).map(String));

  // ── population reconciliation (ruled report) ──────────────────────
  // Re-classify every AR record by EXECUTING the same resolver bridge the
  // loader uses, then the module's own stage function — no re-derivation.
  const clientB = await pool.connect();
  const included = [], omitted = [];
  try {
    for (const summary of review.applications) {
      const detail = await buildReviewDetail(clientB, summary.application_id, P,
        { loadGate: applicationsService.outstanding, resolveNext: applicationsService.applicationNext });
      const next = detail && detail.next_action;
      if (!next || !next.code) { omitted.push({ id: summary.application_id, reason: "no_supported_next_action" }); continue; }
      const stage = desk.stageForApplicationNext(next);
      if (!stage) { omitted.push({ id: summary.application_id, reason: `exited_lifecycle (${next.code})` }); continue; }
      included.push({ id: summary.application_id, stage, state: next.state || "available", code: next.code });
    }
  } finally { clientB.release(); }

  console.log("\n══ POPULATION RECONCILIATION (ruled handback report) ══");
  console.log(`Applications Review records : ${review.applications.length}`);
  console.log(`Leasing Work rail records   : ${railRows.length}  (stages ${out.stage_counts.post_tour}/${out.stage_counts.application}/${out.stage_counts.lease_sent})`);
  console.log(`included application ids    : ${included.map((i) => i.id.slice(-4) + ":" + i.stage).join(", ")}`);
  console.log(`omitted application ids     : ${omitted.map((o) => o.id.slice(-4) + " — " + o.reason).join("; ") || "none"}`);
  const correlated = railRows.filter((r) => r.person_id || r.conversion_id).length;
  console.log(`correlated relationships    : ${correlated}`);
  console.log(`uncorrelated (still shown)  : ${railRows.length - correlated}`);
  console.log(`waiting restored by S4      : ${railRows.filter((r) => r.operating_state === "waiting").length}`);
  console.log(`genuinely exited            : ${omitted.filter((o) => o.reason.startsWith("exited")).length}`);
  console.log(`no supported next action    : ${omitted.filter((o) => o.reason === "no_supported_next_action").length}`);
  console.log(`tour capture owed / untrack : ${out.tour_capture.owed_shown} / ${out.tour_capture.untrackable_not_shown}`);

  console.log("\n══ assertions ══");
  ok(review.applications.length === 9, "AR population is the full 9-record lease_applications set");
  // every AR record is on the rail, omitted for a server-authored lifecycle
  // reason, or hidden from the RAIL ONLY by the declared internal_qa hygiene
  // (in which case it must still be mirrored in Application Records — S5).
  const onRail = included.filter((i) => railAppIds.has(String(i.id))).length;
  const qaHiddenFromRail = included.filter((i) => !railAppIds.has(String(i.id)));
  const explained = onRail + qaHiddenFromRail.length + omitted.length;
  ok(explained === review.applications.length,
    `every AR record is on the rail, lifecycle-exited, or QA-hidden with a receipt (${onRail}+${qaHiddenFromRail.length}+${omitted.length}/${review.applications.length})`);
  ok(qaHiddenFromRail.length === 1 && String(qaHiddenFromRail[0].id) === APPS.qa && out.internal_qa_hidden === 1,
    "the ONLY rail-hygiene omission is the declared internal_qa record, receipted on the envelope");
  ok(omitted.every((o) => o.reason.startsWith("exited_lifecycle")),
    "the ONLY lifecycle omissions are genuine exits (active/closed) — nothing else may disappear");
  ok(omitted.length === 2, "exactly the declined and active applications exited");

  // ── S5: APPLICATION RECORDS — exact Applications Review parity ──────
  const rec = out.application_records;
  const recIds = rec.records.map((r) => String(r.application_id)).sort();
  const arIds = review.applications.map((a) => String(a.application_id)).sort();
  ok(JSON.stringify(recIds) === JSON.stringify(arIds) && new Set(recIds).size === recIds.length,
    `every AR record appears in Application Records EXACTLY once (${recIds.length}/${arIds.length})`);
  ok(rec.counts.total === 9 && rec.counts.active === 7 && rec.counts.exited === 2 && rec.counts.unresolved === 0,
    `records counts server-authored: ${JSON.stringify(rec.counts)}`);
  const qaRec = rec.records.find((r) => String(r.application_id) === APPS.qa);
  ok(!!qaRec && !railAppIds.has(APPS.qa),
    "the QA-classified application is mirrored in records while the rail keeps its hygiene");
  const decRec = rec.records.find((r) => String(r.application_id) === APPS.dec);
  const actRec = rec.records.find((r) => String(r.application_id) === APPS.act);
  ok(!!decRec && decRec.record_state === "exited" && decRec.exit_code === "closed" && !!decRec.exit_label,
    "the declined application remains accessible as an exited RECORD with its exit label");
  ok(!!actRec && actRec.record_state === "exited" && actRec.exit_code === "active",
    "the activated application remains accessible as an exited RECORD");
  const arWait = review.applications.find((a) => String(a.application_id) === APPS.wait);
  const recWait = rec.records.find((r) => String(r.application_id) === APPS.wait);
  ok(!!recWait && recWait.completeness === arWait.completeness
    && recWait.packet_status === arWait.packet_status && recWait.main_blocker === arWait.main_blocker
    && recWait.missing_count === arWait.missing_count,
    "record facts mirror the review list verbatim (completeness · packet · blocker)");
  ok(recWait.record_state === "active" && recWait.active_stage === "lease_sent" && recWait.waiting_on === "prospect",
    "an active record names its rail stage — active-here ⇔ on-the-rail");
  const orphRec = rec.records.find((r) => String(r.application_id) === APPS.orph);
  ok(!!orphRec && orphRec.person_id === null, "the personless application is a record with honest nulls");
  ok(rec.records.every((r) => r.primary_action && r.primary_action.kind === "navigation"
      && r.primary_action.target.type === "application" && String(r.primary_action.target.id) === String(r.application_id)),
    "every record — active or exited — opens the SAME canonical review detail");
  ok(out.operating_counts.total_active === out.stage_counts.total,
    "Active Work counts remain active-only — records never inflate the rail");

  const wait = railRows.find((r) => String(r.application_id) === APPS.wait);
  ok(!!wait, "the waiting-on-prospect application IS on the rail (restored)");
  ok(wait && wait.stage === "lease_sent", "waiting row sits in the third stage (packet was issued)");
  ok(wait && wait.state_code === "await_resident_acknowledgment", "waiting row keeps its precise canonical state_code");
  ok(wait && wait.operating_state === "waiting" && wait.waiting_on === "prospect", "operating_state waiting · waiting_on prospect");
  ok(wait && String(wait.lease_packet_id) === PACKETS.wait, "resolver's packet id passes through");
  ok(wait && !!wait.conversation_id, "deterministic conversation correlation projected");
  ok(wait && wait.latest_activity_label === "conversation_message", "latest activity picks the semantic conversation timestamp");

  const block = railRows.find((r) => String(r.application_id) === APPS.block);
  ok(!!block && block.operating_state === "blocked" && block.blocker_code === "inconsistent_application_state",
    "blocked row carries machine-stable blocker_code");
  ok(!!block && block.blocker_label === desk.BLOCKER_LABELS.inconsistent_application_state,
    "blocker_label is the server-owned mapping");

  const orph = railRows.find((r) => String(r.application_id) === APPS.orph);
  ok(!!orph && orph.person_id === null, "uncorrelated application (no person) remains visible with honest nulls");

  const capRows = railRows.filter((r) => r.source === "tour_capture");
  ok(capRows.length === 1 && String(capRows[0].tour_id) === TOURS.owed, "exactly the ended-uncaptured tour becomes an owed capture row");
  const cap = capRows[0];
  ok(cap.stage === "post_tour" && cap.primary_action.kind === "navigation" && cap.primary_action.target.type === "tour",
    "capture row navigates to the canonical tour destination");
  ok(cap.accountable_user_id === null && cap.assignment_state === "unassigned",
    "hostless capture row is honestly unassigned (confirmed_by is never treated as owner)");
  const slotEnd = (await pool.query(`select ends_at from tour_availability where id=$1`, [SLOTS.owed])).rows[0].ends_at;
  const expectedDue = new Date(new Date(slotEnd).getTime() + 15 * 60000).toISOString();
  ok(cap.due_at === expectedDue && cap.due_state === "overdue",
    `overdue carries the resolver's OWN deadline (slot end + grace): ${cap.due_at}`);
  ok(out.tour_capture.owed_shown === 1 && out.tour_capture.untrackable_not_shown === 1,
    "untrackable tour is counted, not shown, never silent");

  const railPost = railRows.filter((r) => r.source === "followup_rail");
  ok(railPost.length === 2 && railPost.every((r) => r.stage === "post_tour"), "both rail follow-ups project post_tour");
  const una = railPost.find((r) => String(r.obligation_id) === OBLS.una);
  ok(!!una && una.assignment_state === "unassigned" && una.accountable_user_id === null, "ownerless rail row is unassigned");
  const post = railPost.find((r) => String(r.obligation_id) === OBLS.post);
  ok(!!post && String(post.accountable_user_id) === USER_KATIE && post.assignment_state === "assigned",
    "owned rail row carries accountable_user_id (passthrough)");
  ok(!!post && String(post.tour_id) === TOURS.conv1 && !!post.unit_id === false,
    "rail row passes origin tour through as tour_id (no unit on this tour → honest null)");

  // home/destination reconciliation by construction
  ok(out.operating_counts.total_active === out.stage_counts.total,
    `operating_counts.total_active reconciles with stage_counts.total (${out.operating_counts.total_active})`);
  ok(out.operating_counts.waiting === 1 && out.operating_counts.blocked === 1,
    "waiting/blocked operating counts match the rows");
  const overdueRows = railRows.filter((r) => r.due_state === "overdue").length;
  ok(out.operating_counts.overdue === overdueRows, `overdue count matches rail rows (${overdueRows})`);
  const unassignedRows = railRows.filter((r) => r.assignment_state === "unassigned").length;
  ok(out.operating_counts.unassigned === unassignedRows, `unassigned count matches rail rows (${unassignedRows})`);
  ok(out.stage_labels && out.stage_labels.lease_sent === "Lease", "third stage presents with server-authored label 'Lease'");
  ok(out.stage_counts.total === 9, `rail total is 9 (4 application + 2 lease + 2 rail post-tour + 1 capture): ${out.stage_counts.total}`);

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED:", e); process.exit(1); });
