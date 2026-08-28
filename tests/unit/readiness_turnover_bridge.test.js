"use strict";

const fs = require("fs");
const path = require("path");
const { closeActiveTurnoversForReadiness } = require("../../src/maintenance/readiness_service");

let passed = 0;
const ok = (label, condition) => {
  if (!condition) throw new Error("FAIL " + label);
  passed++;
  console.log("PASS " + label);
};

(async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: "turn-1", property_id: "property-1", unit_id: "unit-1", status: "ready" }] };
    },
  };

  const rows = await closeActiveTurnoversForReadiness(db, {
    property_id: "property-1",
    unit_id: "unit-1",
  });
  const write = calls[0];
  ok("readiness closes an active turnover", rows.length === 1 && rows[0].status === "ready");
  ok("the closure is scoped by durable property and unit ids",
    write.params[0] === "property-1" && write.params[1] === "unit-1");
  ok("only an in-progress turnover can be closed", /status='in_progress'/.test(write.sql));
  ok("the closure records a real ready date", /ready_date=coalesce\(\$3::date,current_date\)/.test(write.sql));

  const src = fs.readFileSync(path.join(__dirname, "../../src/maintenance/readiness_service.js"), "utf8");
  const readyBlock = src.slice(src.indexOf("async function finishReady"), src.indexOf("async function finishNotReady"));
  ok("the authorized ready branch invokes the turnover closure",
    /closeActiveTurnoversForReadiness\(client/.test(readyBlock));
  ok("the certification event records which turnovers were closed",
    /closed_turnover_ids/.test(readyBlock));
  ok("the not-ready branch cannot close a turnover",
    !/closeActiveTurnoversForReadiness\(client/.test(src.slice(src.indexOf("async function finishNotReady"))));

  console.log(`\n${passed} readiness-turnover bridge assertions passed`);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
