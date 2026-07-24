#!/usr/bin/env node
"use strict";
const assert = require("assert");
const path = require("path");
const apiDir = process.argv[2];
if (!apiDir) throw new Error("usage: node leasing_stage_tabs_api.test.js <api-dir>");

const desk = require(path.join(apiDir, "leasing_desk.js"));

function app(id, conversion, code, state="available", label=code) {
  return {
    application_id:id,
    conversion_id:conversion,
    person_id:`person-${conversion}`,
    applicant_name:`Person ${conversion}`,
    unit_label:"304",
    next_action:{ code, state, label },
    created_at:"2026-07-20T12:00:00Z",
  };
}
function follow(id, conversion, extra={}) {
  return {
    obligation_id:id,
    conversion_id:conversion,
    person_id:`person-${conversion}`,
    person_name:`Person ${conversion}`,
    origin_tour_id:extra.origin_tour_id || null,
    applicant_substatus:extra.applicant_substatus || null,
    rung:extra.rung || "leasing_task",
    label:extra.label || "Follow up",
    next_move_code:extra.next_move_code || "send_application",
    next_move_label:extra.next_move_label || "Send application",
    due_state:extra.due_state || "upcoming",
    due_at:extra.due_at || "2026-07-25T12:00:00Z",
    created_at:extra.created_at || "2026-07-20T12:00:00Z",
  };
}

const out = desk.composeLeasingDesk({
  propertyId:"property-1",
  applicationRows:[
    app("app-wait","c-wait","await_resident_acknowledgment","waiting","Waiting for resident"),
    app("app-review","c-review","review_application","available","Review submitted application"),
    app("app-lease","c-lease","executed_lease_required","available","Executed lease required"),
    app("app-term","c-term","confirm_term","available","Confirm term"),
    app("app-multi-review","c-multi","review_application","available","Review application"),
    app("app-multi-lease","c-multi","executed_lease_required","available","Executed lease required"),
    app("app-active","c-active","active","complete","Active"),
  ],
  followupRows:[
    follow("o-post","c-post",{origin_tour_id:"tour-1"}),
    follow("o-nosource","c-pre",{}),
    follow("o-invite","c-invite",{origin_tour_id:"tour-2",applicant_substatus:"application_sent",next_move_code:"send_follow_up"}),
    follow("o-shadow","c-review",{origin_tour_id:"tour-3",applicant_substatus:"submitted",rung:"application_lifecycle_followup"}),
    follow("o-active-shadow","c-active",{origin_tour_id:"tour-active",applicant_substatus:"approved",rung:"application_lifecycle_followup"}),
    follow("o-dup-1","c-dup",{origin_tour_id:"tour-4",due_state:"overdue",due_at:"2026-07-20T10:00:00Z"}),
    follow("o-dup-2","c-dup",{origin_tour_id:"tour-4",due_state:"upcoming",due_at:"2026-07-27T10:00:00Z"}),
  ],
});

assert.deepStrictEqual(Object.keys(out.stages), ["post_tour","application","lease_sent"]);
assert.strictEqual(out.stages.post_tour.length, 2, "post-tour should include c-post and one c-dup row");
assert.strictEqual(out.stages.application.length, 3, "waiting, review, and invitation-only rows");
assert.strictEqual(out.stages.lease_sent.length, 3, "executed lease, confirm term, and downstream winner");
assert.ok(!JSON.stringify(out.stages).includes("c-active"), "active application and its rail shadow must leave Leasing Work");
assert.ok(!JSON.stringify(out.stages).includes("c-pre"), "pre-tour work must not enter Leasing Work");
assert.strictEqual(out.stages.post_tour.find(r=>r.conversion_id==="c-dup").related_open_count, 2, "duplicate open work must collapse to one relationship");
assert.strictEqual(out.stages.application.filter(r=>r.conversion_id==="c-review").length, 1, "application authority suppresses rail duplicate");
assert.strictEqual(out.stages.application.find(r=>r.conversion_id==="c-wait").primary_action.label, "Open application");
assert.strictEqual(out.stages.lease_sent.find(r=>r.conversion_id==="c-lease").primary_action.label, "Record executed lease");
assert.strictEqual(out.stages.lease_sent.find(r=>r.conversion_id==="c-term").primary_action.label, "Confirm lease term");
assert.strictEqual(out.stage_counts.total, 8);
assert.strictEqual(out.stages.application.filter(r=>r.conversion_id==="c-multi").length, 0, "one relationship cannot appear in two tabs");
assert.strictEqual(out.stages.lease_sent.filter(r=>r.conversion_id==="c-multi").length, 1, "furthest lifecycle stage wins");

// Rolling deploy compatibility: the old bands are still present, and waiting work
// remains excluded from the old actionable contract.
assert.ok(out.bands && Array.isArray(out.bands.ready_to_advance));
assert.ok(!out.bands.ready_to_advance.some(r=>r.conversion_id==="c-wait"));

console.log("leasing stage API: 16/16");
