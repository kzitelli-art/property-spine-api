#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const admin = fs.readFileSync(path.join(root, "src", "identity", "super_admin.js"), "utf8");
const lines = fs.readFileSync(path.join(root, "src", "comms", "communication_lines.js"), "utf8");

const route = admin.slice(
  admin.indexOf('router.post("/admin/organizations/:id/operations-line"'),
  admin.indexOf("// ── POST /admin/organizations/:id/properties", admin.indexOf('operations-line'))
);

assert.match(route, /requireSuperAdmin/);
assert.match(route, /activateOperationsLine/);
assert.match(route, /req\.operator\.id/);
assert.match(route, /phone_number/);
assert.doesNotMatch(route, /OPERATOR_KEY|organization_id\s*:\s*req\.body/);
assert.match(admin, /communicationLines\.readOperationsLineForOrganization\(pool, org\.id\)/);
assert.doesNotMatch(admin, /from communication_lines/);

const command = lines.slice(
  lines.indexOf("async function activateOperationsLine"),
  lines.indexOf("/*  resolveStaffSenderForOrganization")
);
assert.match(command, /normalizePropertyLine\(phoneNumber\)/);
assert.match(command, /platform_role !== "super_admin"/);
assert.match(command, /organization\.has_property/);
assert.match(command, /operations_line_already_active/);
assert.match(command, /phone_number_already_active/);
assert.match(command, /'operations'/);
assert.match(command, /'operational'/);
assert.match(command, /'staff'/);
assert.match(command, /'reply_only'/);
assert.doesNotMatch(command, /'proactive'/);

console.log("PASS Staff texting activation has one super-admin command and one fixed safe posture.");
