"use strict";

const http = require("http");
const express = require("express");
const staffSessions = require("../../src/identity/staff_session_service");

let passed = 0;
const ok = (message, condition) => {
  if (!condition) throw new Error(message);
  passed++;
  console.log("PASS " + message);
};

(async () => {
  const originalResolver = staffSessions.resolveStaffSession;
  staffSessions.resolveStaffSession = async () => ({
    id: "user-1",
    property_id: "property-1",
    allowed_modules: ["maintenance"],
  });

  const priorityRows = [
    {
      turnover_id: "turn-committed", unit_id: "unit-2", unit_label: "202",
      status: "in_progress", ready_date: null, needs: ["paint"], demand_tier: 3,
      demand_tier_key: "committed_start", priority_label: "Committed move-in 2026-09-01",
      reason: "Executed and funded.", commitment_start_date: "2026-09-01",
      deadline_known: true, commitment_conflict: false,
      contributing_commitments: [{ lease_id: "lease-2", start_date: "2026-09-01", state: "locked" }],
    },
    {
      turnover_id: "turn-vacant", unit_id: "unit-1", unit_label: "101",
      status: "in_progress", ready_date: null, needs: [], demand_tier: 1,
      demand_tier_key: "raw_vacancy", priority_label: "No incoming lease attached",
      reason: "No lease attached.", commitment_start_date: null,
      deadline_known: false, commitment_conflict: false, contributing_commitments: [],
    },
  ];

  let rankCalls = 0;
  const rankTurnPriority = async (_pool, propertyId) => {
    rankCalls++;
    ok("turn priority is scoped to the session property", propertyId === "property-1");
    return { property_id: propertyId, count: priorityRows.length, note: "canonical order", turns: priorityRows };
  };

  const reads = [];
  const unitTurnRead = {
    readUnitTurn: async (_pool, input) => {
      reads.push(input);
      return {
        status: {
          readiness_label: "Not ready",
          marketability: "turnover_required",
          certified: false,
          next_move_in: input.turn_priority && input.turn_priority.deadline_known
            ? { move_in_date: input.turn_priority.commitment_start_date } : null,
        },
        work: [], scope: { inspection_completeness: "complete" },
        triage_confirmation: {}, controlling_next_action: null,
      };
    },
  };

  // Deliberately no pool.query: the route must not rebuild its population from
  // historical triage/scope tables. Its only population is rankTurnPriority.
  const pool = {};
  const router = require("../../src/surfaces/unit_turn")({ pool, unitTurnRead, rankTurnPriority });
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const all = await fetch(base + "/operator/turns", { headers: { "x-staff-session": "proof" } });
    const body = await all.json();
    ok("the primary turn list responds", all.status === 200);
    ok("only active canonical turns populate the list", body.count === 2);
    ok("canonical priority order survives", body.turns[0].unit_id === "unit-2" && body.turns[1].unit_id === "unit-1");
    ok("the committed tier reaches the client", body.turns[0].demand_tier_key === "committed_start");
    ok("the operator label reaches the client", body.turns[0].priority_label === "Committed move-in 2026-09-01");
    ok("the canonical row is passed into the unit composition", reads[0].turn_priority.turnover_id === "turn-committed");
    ok("maintenance access is sufficient", all.status !== 403);

    const attention = await fetch(base + "/operator/turns?attention=true", { headers: { "x-staff-session": "proof" } });
    const attentionBody = await attention.json();
    ok("attention is a filter over the same ranked list", attentionBody.count === 1);
    ok("a locked unfinished move-in is named as the risk", attentionBody.turns[0].attention_reasons.includes("committed move-in at risk"));

    const detail = await fetch(base + "/operator/units/unit-2/turn", { headers: { "x-staff-session": "proof" } });
    ok("unit detail responds", detail.status === 200);
    ok("list and detail both call the same ranking read", rankCalls === 3);
    ok("detail receives the same canonical commitment", reads[reads.length - 1].turn_priority.turnover_id === "turn-committed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    staffSessions.resolveStaffSession = originalResolver;
  }

  console.log(`\n${passed} unit-turn priority bridge assertions passed`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
