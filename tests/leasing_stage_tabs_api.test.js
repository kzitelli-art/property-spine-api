#!/usr/bin/env node
"use strict";
// ════════════════════════════════════════════════════════════════════
//  leasing_stage_tabs_api.test.js — the stage projection contract.
//
//  Updated for Slice 4 (Unified Leasing Work), which changed this
//  contract by ruling:
//    · waiting-on-prospect rows are ACTIVE work: they keep their precise
//      canonical state_code (never the generic "waiting"), carry
//      operating_state:"waiting" + waiting_on:"prospect", and sit in the
//      third stage because the resolver emits them only after the packet
//      was actually issued;
//    · the third machine stage keeps code lease_sent but is displayed
//      with the server-authored label "Lease";
//    · tour_capture is a third row source (owed outcome captures);
//    · operating_counts derive from the same deduped rail rows the
//      destination renders;
//    · primary_action labels use the ruled CTA vocabulary (navigation →
//      "Open") — the labels this file pinned before ("Open application",
//      "Record executed lease") predated that ruling and were red
//      against the deployed source.
//
//  The final line prints COUNTED totals, never a fixed number.
// ════════════════════════════════════════════════════════════════════
const assert = require("assert");
const path = require("path");
const apiDir = process.argv[2];
if (!apiDir) throw new Error("usage: node leasing_stage_tabs_api.test.js <api-dir>");

const desk = require(path.join(apiDir, "leasing_desk.js"));

let passed = 0, failed = 0;
function ck(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log("   FAIL  " + name + "\n         " + (e.message || e).split("\n")[0]); }
}

function app(id, conversion, code, state = "available", label = code, extra = {}) {
  return {
    application_id: id,
    conversion_id: conversion,
    person_id: `person-${conversion}`,
    applicant_name: `Person ${conversion}`,
    unit_label: "304",
    next_action: { code, state, label, blocker_code: extra.blocker_code || null, packet_id: extra.packet_id || null },
    created_at: "2026-07-20T12:00:00Z",
    unit_id: extra.unit_id || null,
    lease_id: extra.lease_id || null,
    conversation_id: extra.conversation_id || null,
    activity_candidates: extra.activity_candidates || [],
  };
}
function follow(id, conversion, extra = {}) {
  return {
    obligation_id: id,
    conversion_id: conversion,
    person_id: `person-${conversion}`,
    person_name: `Person ${conversion}`,
    origin_tour_id: extra.origin_tour_id || null,
    applicant_substatus: extra.applicant_substatus || null,
    rung: extra.rung || "leasing_task",
    label: extra.label || "Follow up",
    next_move_code: extra.next_move_code || "send_application",
    next_move_label: extra.next_move_label || "Send application",
    due_state: extra.due_state || "upcoming",
    due_at: extra.due_at || "2026-07-25T12:00:00Z",
    created_at: extra.created_at || "2026-07-20T12:00:00Z",
    owner_user_id: extra.owner_user_id || null,
    owner_name: extra.owner_name || null,
    unit_id: extra.unit_id || null,
    conversation_id: extra.conversation_id || null,
    activity_candidates: extra.activity_candidates || [],
  };
}

const out = desk.composeLeasingDesk({
  propertyId: "property-1",
  applicationRows: [
    app("app-wait", "c-wait", "await_resident_acknowledgment", "waiting", "Awaiting the resident's terms acknowledgment.",
      { packet_id: "packet-9", conversation_id: "conv-wait",
        activity_candidates: [
          { at: "2026-07-21T09:00:00Z", label: "application_signed" },
          { at: "2026-07-23T10:00:00Z", label: "conversation_message" },
        ] }),
    app("app-review", "c-review", "review_application", "available", "Review submitted application"),
    app("app-blocked", "c-blocked", "issue_terms_review_link", "blocked", "Issue the terms-review link.",
      { blocker_code: "packet_stale" }),
    app("app-lease", "c-lease", "executed_lease_required", "available", "Executed lease required"),
    app("app-term", "c-term", "confirm_term", "available", "Confirm term"),
    app("app-multi-review", "c-multi", "review_application", "available", "Review application"),
    app("app-multi-lease", "c-multi", "executed_lease_required", "available", "Executed lease required"),
    app("app-active", "c-active", "active", "complete", "Active"),
  ],
  followupRows: [
    follow("o-post", "c-post", { origin_tour_id: "tour-1", owner_user_id: "user-9", owner_name: "Katie" }),
    follow("o-nosource", "c-pre", {}),
    follow("o-invite", "c-invite", { origin_tour_id: "tour-2", applicant_substatus: "application_sent", next_move_code: "send_follow_up" }),
    follow("o-shadow", "c-review", { origin_tour_id: "tour-3", applicant_substatus: "submitted", rung: "application_lifecycle_followup" }),
    follow("o-active-shadow", "c-active", { origin_tour_id: "tour-active", applicant_substatus: "approved", rung: "application_lifecycle_followup" }),
    follow("o-dup-1", "c-dup", { origin_tour_id: "tour-4", due_state: "overdue", due_at: "2026-07-20T10:00:00Z" }),
    follow("o-dup-2", "c-dup", { origin_tour_id: "tour-4", due_state: "upcoming", due_at: "2026-07-27T10:00:00Z" }),
  ],
  tourCaptureRows: [
    { tour_id: "tour-owed", unit_id: "unit-7", unit_number: "207",
      leasing_agent_id: null, host_name: null,
      person_id: "person-tour", person_name: "Walked In",
      conversation_id: "conv-tour", capture_state: "overdue",
      capture_due_at: "2026-07-19T15:15:00Z",
      created_at: "2026-07-19T12:00:00Z",
      activity_candidates: [{ at: "2026-07-19T15:00:00Z", label: "tour_completed" }] },
  ],
  tourCaptureUntrackable: 2,
});

// ── stage placement ─────────────────────────────────────────────────
ck("stage keys unchanged", () =>
  assert.deepStrictEqual(Object.keys(out.stages), ["post_tour", "application", "lease_sent"]));
ck("post-tour holds c-post, one c-dup row, and the owed capture", () =>
  assert.strictEqual(out.stages.post_tour.length, 3));
ck("application holds review, blocked, and invitation-only rows", () =>
  assert.strictEqual(out.stages.application.length, 3));
ck("lease stage holds waiting, executed lease, confirm term, and downstream winner", () =>
  assert.strictEqual(out.stages.lease_sent.length, 4));
ck("active application and its rail shadow leave Leasing Work", () =>
  assert.ok(!JSON.stringify(out.stages).includes("c-active")));
ck("pre-tour work does not enter Leasing Work", () =>
  assert.ok(!JSON.stringify(out.stages).includes("c-pre")));
ck("duplicate open work collapses to one relationship", () =>
  assert.strictEqual(out.stages.post_tour.find((r) => r.conversion_id === "c-dup").related_open_count, 2));
ck("application authority suppresses rail duplicate", () =>
  assert.strictEqual(out.stages.application.filter((r) => r.conversion_id === "c-review").length, 1));
ck("one relationship cannot appear in two tabs", () =>
  assert.strictEqual(out.stages.application.filter((r) => r.conversion_id === "c-multi").length, 0));
ck("furthest lifecycle stage wins", () =>
  assert.strictEqual(out.stages.lease_sent.filter((r) => r.conversion_id === "c-multi").length, 1));
ck("stage total counts every rail row", () =>
  assert.strictEqual(out.stage_counts.total, 10));

// ── S4: the waiting row is active, precise, and third-stage ─────────
const wait = out.stages.lease_sent.find((r) => r.conversion_id === "c-wait");
ck("waiting row is on the rail (Lease stage — the packet was issued)", () =>
  assert.ok(wait, "c-wait missing from lease_sent"));
ck("waiting row keeps its PRECISE canonical state_code", () =>
  assert.strictEqual(wait.state_code, "await_resident_acknowledgment"));
ck("waiting row carries operating_state waiting", () =>
  assert.strictEqual(wait.operating_state, "waiting"));
ck("waiting row names the authored party: prospect", () =>
  assert.strictEqual(wait.waiting_on, "prospect"));
ck("waiting row passes the resolver's packet through", () =>
  assert.strictEqual(wait.lease_packet_id, "packet-9"));
ck("latest activity picks the greatest SEMANTIC timestamp with its label", () => {
  assert.strictEqual(wait.latest_activity_label, "conversation_message");
  assert.strictEqual(wait.latest_activity_at, "2026-07-23T10:00:00.000Z");
});

// ── S4: blockers are code + server-owned label ──────────────────────
const blocked = out.stages.application.find((r) => r.conversion_id === "c-blocked");
ck("blocked row keeps machine-stable blocker_code", () =>
  assert.strictEqual(blocked.blocker_code, "packet_stale"));
ck("blocker_label is the server-owned mapping, not a browser translation", () =>
  assert.strictEqual(blocked.blocker_label, desk.BLOCKER_LABELS.packet_stale));
ck("an unmapped blocker code yields an honest null label", () =>
  assert.strictEqual(desk.blockerLabelFor("some_future_code"), null));

// ── S4: tour_capture rows ───────────────────────────────────────────
const cap = out.stages.post_tour.find((r) => r.source === "tour_capture");
ck("owed capture is a post_tour rail row", () => assert.ok(cap, "tour_capture row missing"));
ck("capture row navigates to the canonical tour destination", () =>
  assert.deepStrictEqual(cap.primary_action.target, { type: "tour", id: "tour-owed" }));
ck("capture row with no canonical host is honestly unassigned", () => {
  assert.strictEqual(cap.accountable_user_id, null);
  assert.strictEqual(cap.accountable_user_name, null);
  assert.strictEqual(cap.assignment_state, "unassigned");
});
ck("capture row projects the resolver's OWN deadline beside its overdue", () => {
  assert.strictEqual(cap.due_at, "2026-07-19T15:15:00.000Z");
  assert.strictEqual(cap.due_state, "overdue");
});
ck("overdue is NEVER emitted without an authored deadline (ruled)", () => {
  const stray = desk.normalizeTourCaptureRow({ tour_id: "tour-x", person_id: "p-x", person_name: "X",
    capture_state: "overdue", capture_due_at: null, created_at: "2026-07-19T12:00:00Z" });
  assert.strictEqual(stray.due_at, null);
  assert.strictEqual(stray.due_state, "none");
});
ck("untrackable tours are counted, never silently calm", () =>
  assert.deepStrictEqual(out.tour_capture, { owed_shown: 1, untrackable_not_shown: 2 }));

// ── S4: server-authored stage display labels ────────────────────────
ck("third stage presents as Lease, not universally as Lease sent", () =>
  assert.deepStrictEqual(out.stage_labels, { post_tour: "Post-tour", application: "Application", lease_sent: "Lease" }));

// ── S4: operating counts derive from the same deduped rail rows ─────
ck("operating_counts reconcile with the rendered stages by construction", () => {
  assert.strictEqual(out.operating_counts.total_active, out.stage_counts.total);
  assert.strictEqual(out.operating_counts.waiting, 1);
  assert.strictEqual(out.operating_counts.blocked, 1);
  assert.strictEqual(out.operating_counts.overdue, 2); // c-dup winner + owed capture
});
ck("unassigned counts rows without an accountable user", () => {
  const un = [...out.stages.post_tour, ...out.stages.application, ...out.stages.lease_sent]
    .filter((r) => r.assignment_state === "unassigned").length;
  assert.strictEqual(out.operating_counts.unassigned, un);
});

// ── ruled CTA vocabulary (navigation → "Open") ──────────────────────
ck("waiting row's action uses the ruled navigation verb", () =>
  assert.strictEqual(wait.primary_action.label, "Open"));
ck("executed-lease row's action uses the ruled navigation verb", () =>
  assert.strictEqual(out.stages.lease_sent.find((r) => r.conversion_id === "c-lease").primary_action.label, "Open"));
ck("confirm-term row's action uses the ruled navigation verb", () =>
  assert.strictEqual(out.stages.lease_sent.find((r) => r.conversion_id === "c-term").primary_action.label, "Open"));

// ── S5: Application Records — the Applications Review mirror ────────
ck("every application appears in records exactly once — including exited", () => {
  const ids = out.application_records.records.map((r) => r.application_id).sort();
  assert.deepStrictEqual(ids,
    ["app-active", "app-blocked", "app-lease", "app-multi-lease", "app-multi-review", "app-review", "app-term", "app-wait"]);
});
ck("records counts are server-authored and internally consistent", () => {
  const c = out.application_records.counts;
  assert.deepStrictEqual(c, { total: 8, active: 7, exited: 1, unresolved: 0 });
});
ck("an exited record carries its exit code and server exit label", () => {
  const exited = out.application_records.records.find((r) => r.application_id === "app-active");
  assert.strictEqual(exited.record_state, "exited");
  assert.strictEqual(exited.exit_code, "active");
  assert.strictEqual(exited.exit_label, desk.EXIT_LABELS.active);
  assert.strictEqual(exited.active_stage, null);
});
ck("an active record names its stage — active-here ⇔ on-the-rail", () => {
  const activeRec = out.application_records.records.find((r) => r.application_id === "app-wait");
  assert.strictEqual(activeRec.record_state, "active");
  assert.strictEqual(activeRec.active_stage, "lease_sent");
  assert.strictEqual(activeRec.waiting_on, "prospect");
});
ck("every record opens the SAME canonical review detail", () =>
  assert.ok(out.application_records.records.every((r) =>
    r.primary_action.kind === "navigation" && r.primary_action.target.type === "application"
    && r.primary_action.target.id === r.application_id && r.primary_action.label === "Open")));
ck("Active Work counts remain ACTIVE-ONLY (records never inflate the rail)", () => {
  assert.strictEqual(out.operating_counts.total_active, out.stage_counts.total);
  assert.strictEqual(out.application_records.counts.active, 7);
  // 7 active records vs 6 rail application rows: c-multi holds TWO active
  // applications collapsing to ONE rail relationship — records count
  // applications, the rail counts relationships. Both are true.
});
ck("a duplicate application in the records source is refused loudly", () => {
  let threw = null;
  try {
    desk.composeLeasingDesk({ propertyId: "p", applicationRecordRows: [
      app("dup-1", "c-a", "review_application"), app("dup-1", "c-b", "review_application")] });
  } catch (e) { threw = e.message; }
  assert.ok(/same application twice/.test(threw || ""));
});
ck("a record with no resolver answer is honestly unresolved, never guessed", () => {
  const rec = desk.normalizeApplicationRecord({ application_id: "app-x", next_action: null, status: "draft" });
  assert.strictEqual(rec.record_state, "unresolved");
  assert.strictEqual(rec.active_stage, null);
  assert.strictEqual(rec.exit_code, null);
});

// ── rolling-deploy compatibility: legacy bands untouched ────────────
ck("legacy bands still present", () =>
  assert.ok(out.bands && Array.isArray(out.bands.ready_to_advance)));
ck("legacy bands still exclude waiting work (pre-S4 contract preserved)", () =>
  assert.ok(!out.bands.ready_to_advance.some((r) => r.conversion_id === "c-wait")));

console.log(`==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
