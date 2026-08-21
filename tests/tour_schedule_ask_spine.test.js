#!/usr/bin/env node
"use strict";

const ask = require("../src/agent/ask_spine_answer");

let pass = 0;
let fail = 0;
function ok(label, condition, detail = "") {
  if (condition) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`); }
}

const db = { query: async () => ({ rows: [] }) };
function ai(spy, answer = "Mike is hosting the next openings Tuesday at 9:00 and 10:00 AM.") {
  return { messages: { create: async request => {
    spy.request = request;
    return { content: [{ type: "text", text: JSON.stringify({ outcome: "answered", answer }) }] };
  } } };
}

function factsFrom(spy) {
  return JSON.parse(spy.request.messages[0].content
    .replace(/^QUESTION SUBJECT:[^\n]+\nFACTS:\n/, "")
    .replace(/\n\nOPERATOR ASKED:[\s\S]*$/, ""));
}

(async () => {
  console.log("\nTOUR SCHEDULE ASK SPINE\n");
  ok("plain tour availability routes to the native schedule",
    ask.questionSubject("What tour times are open this week?") === "tour_schedule");
  ok("a named person's leasing journey remains person-scoped",
    ask.questionSubject("Where is Jane's tour application?") === "leasing_person");
  ok("tour scheduling plus published pricing remains an explicit composition refusal",
    ask.questionSubject("What tour times are open and what is the published pricing?") === "composition_unavailable");

  let readerCalls = 0;
  const denied = await ask.answer(db, ai({}), {
    property_id: "11111111-1111-4111-8111-111111111111",
    allowed_modules: ["maintenance"],
    question: "Who is hosting tours this week?",
    tourScheduleReader: async () => { readerCalls += 1; return {}; },
  });
  ok("tour schedule entitlement is checked before the read",
    denied.outcome === "not_authorized" && readerCalls === 0, JSON.stringify(denied));

  const standing = {
    read_state: "ESTABLISHED",
    operating_timezone: "America/New_York",
    policy: {
      weekly_hours: { monday: { start: "09:00", end: "17:00" }, saturday: { start: "10:00", end: "15:00" } },
      slot_duration_minutes: 60,
      minimum_notice_minutes: 120,
      holiday_calendar: "us_federal_observed",
      default_host_name: "Mike Grivna",
      horizon_days: 45,
    },
    next_open_times: [
      { starts_local: "2026-08-25T09:00", ends_local: "2026-08-25T10:00", host_name: "Mike Grivna" },
      { starts_local: "2026-08-25T10:00", ends_local: "2026-08-25T11:00", host_name: "Mike Grivna" },
    ],
    future_adjustments: [{ command_type: "day_reassigned", local_date: "2026-08-28", changed_count: 8, booked_unchanged: 1, new_host_name: "Elena Ruiz" }],
    coverage_attention: [{ command_type: "day_closed", local_date: "2026-08-28", changed_count: 8, booked_unchanged: 1 }],
  };
  const spy = {};
  const answered = await ask.answer(db, ai(spy), {
    property_id: "11111111-1111-4111-8111-111111111111",
    allowed_modules: ["leasing"],
    question: "What tour times are open and does anything need coverage?",
    tourScheduleReader: async (_db, input) => { readerCalls += 1; return { ...standing, requested_property_id: input.propertyId }; },
  });
  const facts = factsFrom(spy);
  ok("Ask Spine receives the canonical schedule standing without deriving slots",
    answered.outcome === "answered" && facts.tour_schedule.next_open_times.length === 2
      && facts.tour_schedule.policy.default_host_name === "Mike Grivna");
  ok("booked callout coverage remains visible to the narrator",
    facts.tour_schedule.coverage_attention[0].booked_unchanged === 1
      && facts.tour_schedule.future_adjustments[0].new_host_name === "Elena Ruiz");
  ok("the grounding receipt reports schedule and coverage counts",
    answered.grounded_on.tour_schedule_read_state === "ESTABLISHED"
      && answered.grounded_on.tour_schedule_open_count === 2
      && answered.grounded_on.tour_schedule_coverage_attention_count === 1);
  ok("the prompt forbids expanding weekly hours into invented openings",
    /actual bookable rows/.test(spy.request.system) && /never by expanding the weekly policy/.test(spy.request.system));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
