"use strict";

const express = require("express");
const http = require("http");
const staffSessions = require("../src/identity/staff_session_service");

let passed = 0;
const ok = (label, condition) => {
  if (!condition) throw new Error("FAIL " + label);
  passed++;
  console.log("PASS " + label);
};

(async () => {
  const originalResolver = staffSessions.resolveStaffSession;
  let operator = {
    id: "manager-1",
    property_id: "property-1",
    allowed_modules: ["management", "maintenance"],
  };
  staffSessions.resolveStaffSession = async () => operator;

  const calls = [];
  const tx = [];
  const client = {
    query: async (sql) => { tx.push(String(sql).toLowerCase()); return { rows: [] }; },
    release: () => tx.push("release"),
  };
  const pool = { connect: async () => client };
  const turnoverService = {
    openTurnover: async (_client, input) => {
      calls.push(input);
      if (input.unit_id === "duplicate") {
        throw Object.assign(new Error("this unit already has an in-progress turnover"), {
          httpStatus: 409,
          code: "TURNOVER_ALREADY_ACTIVE",
          turnover_id: "turn-1",
        });
      }
      return { turnover: { id: "turn-1", unit_id: input.unit_id, status: "in_progress" } };
    },
  };

  const router = require("../src/maintenance/operator_turnover")({ pool, turnoverService });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const created = await fetch(base + "/operator/units/unit-1/move-out", {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "proof" },
      body: JSON.stringify({ needs: ["paint"], expected_ready_date: "2026-09-01" }),
    });
    const createdBody = await created.json();
    ok("the authenticated move-out door responds", created.status === 201);
    ok("property authority comes from the staff session", calls[0].property_id === "property-1");
    ok("actor attribution comes from the staff session", calls[0].actor_user_id === "manager-1");
    ok("the unit id comes from the route", calls[0].unit_id === "unit-1");
    ok("the response states its authority basis", createdBody.authority.basis.includes("staff session"));
    ok("the route owns begin and commit", tx.includes("begin") && tx.includes("commit"));

    const beforeClaim = calls.length;
    const claimed = await fetch(base + "/operator/units/unit-1/move-out", {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "proof" },
      body: JSON.stringify({ property_id: "property-2" }),
    });
    ok("a client cannot select another property", claimed.status === 403);
    ok("refused property authority never reaches the write", calls.length === beforeClaim);

    operator = { ...operator, allowed_modules: ["maintenance"] };
    const maintenanceOnly = await fetch(base + "/operator/units/unit-1/move-out", {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "proof" },
    });
    ok("maintenance access alone cannot make a possession ruling", maintenanceOnly.status === 403);

    operator = { ...operator, allowed_modules: ["management"] };
    const duplicate = await fetch(base + "/operator/units/duplicate/move-out", {
      method: "POST",
      headers: { "content-type": "application/json", "x-staff-session": "proof" },
    });
    const duplicateBody = await duplicate.json();
    ok("service conflicts survive the HTTP adapter", duplicate.status === 409);
    ok("the existing turnover identity reaches the operator", duplicateBody.turnover_id === "turn-1");
    ok("a failed write rolls back", tx.includes("rollback"));

    operator = null;
    const unsigned = await fetch(base + "/operator/units/unit-1/move-out", {
      method: "POST",
      headers: { "x-staff-session": "bad" },
    });
    ok("an invalid staff session is refused", unsigned.status === 401);
  } finally {
    staffSessions.resolveStaffSession = originalResolver;
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} operator-turnover bridge assertions passed`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
