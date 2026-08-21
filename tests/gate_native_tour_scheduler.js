#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt");

const ROOT = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const service = read("src/leasing/tour_availability_service.js");
const leads = read("src/leasing/leasingleads.js");
const operator = read("src/identity/operator.js");
const server = read("server.js");
const migration = read("migrations/188_native_tour_scheduler.sql");
const runtimeFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".js")) runtimeFiles.push(full);
  }
}
walk(path.join(ROOT, "src"));

let passed = 0;
let failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

receipt.begin(__filename, { expected: 20 });

const slotInsertSites = runtimeFiles.filter(file => /insert\s+into\s+tour_availability\b/i.test(fs.readFileSync(file, "utf8")));
ok("one runtime file may insert native tour slots", slotInsertSites.length === 1,
  slotInsertSites.map(file => path.relative(ROOT, file)).join(", "));
ok("the one slot writer is the canonical service", path.basename(slotInsertSites[0] || "") === "tour_availability_service.js");
ok("the service requires the governed property timezone", /assertPropertyTimezone/.test(service) && /property_operating_timezone_not_configured/.test(service));
ok("the service refuses ambiguous wall-clock timestamps", /must include a timezone offset/.test(service));
ok("the service walls optional units and hosts to the property", /tour_unit_property_mismatch/.test(service) && /tour_host_property_mismatch/.test(service));
ok("the service de-duplicates an exact open or booked slot", /is not distinct from/.test(service) && /status in \('open','booked'\)/.test(service));
ok("the history is insert-only through the canonical service",
  /create table if not exists tour_availability_events/.test(migration) &&
  !/(?:update\s+tour_availability_events|delete\s+from\s+tour_availability_events)/i.test(service));
ok("the native policy owns hours, duration, notice, holidays, host, and horizon",
  ["weekly_hours", "slot_duration_minutes", "minimum_notice_minutes", "holiday_calendar", "default_host_user_id", "horizon_days"]
    .every(column => migration.includes(column)));
ok("policy publication materializes exact native availability", /publishSchedulePolicy/.test(service) && /policyCandidates/.test(service));
ok("day-level callout commands change only open times", /adjustDay/.test(service) && /status='open'/.test(service) && /booked_unchanged/.test(service));
ok("agent offers and bookings both enforce the governed notice window",
  (leads.match(/minimum_notice_minutes/g) || []).length >= 2 && /minimum notice window/.test(leads));

const legacyOpen = leads.slice(leads.indexOf('router.post("/leasing/availability"'), leads.indexOf('// ── LIST OPEN SLOTS'));
ok("the legacy slot door defers to the canonical command", /nativeTourAvailability\.publishSlot/.test(legacyOpen) && !/insert into tour_availability/.test(legacyOpen));

const legacyBook = leads.slice(leads.indexOf('router.post("/leasing/slots/:slotId/book"'), leads.indexOf("// ── PROSPECT CONFIRMS"));
ok("the legacy booking door defers to bookTourIntoSlot", /bookTourIntoSlot\(client/.test(legacyBook));
ok("the legacy booking door owns no tour or slot SQL", !/(?:insert into leasing_tours|update leasing_tours|update tour_availability)/i.test(legacyBook));

const staffRoutes = operator.slice(operator.indexOf("// NATIVE TOUR SCHEDULER"), operator.indexOf("// GET /operator/leasing/availability-canonical"));
ok("the staff door derives property scope from the session", /propertyId: req\.operator\.property_id/.test(staffRoutes));
ok("the staff door derives actor identity from the session", /actorUserId: req\.operator\.id/.test(staffRoutes));
ok("the staff door exposes policy, day adjustment, publish, block, reopen, and list", [
  'router.get("/operator/leasing/tour-slots"',
  'router.post("/operator/leasing/tour-slots"',
  'router.post("/operator/leasing/tour-schedule"',
  'router.post("/operator/leasing/tour-schedule/adjust-day"',
  'tour-slots/:slotId/block',
  'tour-slots/:slotId/reopen',
].every(token => staffRoutes.includes(token)));

ok("server constructs the native service exactly once", (server.match(/makeTourAvailabilityService\(\{ pool \}\)/g) || []).length === 1);
ok("the same service instance is injected into legacy and staff adapters",
  /leasingLeadsModule\([^\n]+tourAvailabilityService/.test(server) && /operatorModule\(\{[\s\S]{0,400}tourAvailabilityService/.test(server));
ok("the public booking page and agent share one offerable-slot reader",
  /const slots = await readOfferableSlots\(pool/.test(leads));

process.exit(receipt.complete({ harness: __filename, passed, failed, expectedAtLeast: 20 }));
