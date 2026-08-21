#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const team = fs.readFileSync(path.join(root, "src", "identity", "teamaccess.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "189_unified_staff_onboarding.sql"), "utf8");

assert.match(server, /function isTeamAccessPath\(p\)/);
assert.match(server, /isOperatorPath\(req\.path\) \|\| isTeamAccessPath\(req\.path\)/);
assert.match(server, /if \(isTeamAccessPath\(p\)\) return next\(\)/);

const invite = team.slice(
  team.indexOf('router.post("/properties/:id/team-invites"'),
  team.indexOf('router.post("/auth/sms/start"')
);
assert.match(invite, /resolveStaffSession/);
assert.match(invite, /propertyId !== session\.property_id/);
assert.match(invite, /existing_person_confirmation_required/);
assert.match(invite, /if \(candidates\.length && !confirmedPersonId\)/);
assert.ok(invite.indexOf("existing_person_confirmation_required") < invite.indexOf("insert into team_invites"));
assert.doesNotMatch(invite, /process\.env\.OPERATOR_KEY/);

const acceptance = team.slice(
  team.indexOf("// ── INVITE-ACCEPT branch"),
  team.indexOf('// ── GET /properties/:id/team')
);
assert.match(acceptance, /classifyAccount/);
assert.match(acceptance, /linkBridge/);
assert.match(acceptance, /establishStaffContext/);
assert.match(acceptance, /insert into assignments/);
assert.match(acceptance, /insert into property_team_assignments/);
assert.match(migration, /add column if not exists role_key/);
assert.match(migration, /add column if not exists person_id/);

const roster = team.slice(
  team.indexOf('router.get("/properties/:id/team"'),
  team.indexOf('router.get("/properties/:id/my-access"')
);
assert.match(roster, /const me = await currentUser\(req\)/);
assert.match(roster, /propertyId !== me\.property_id/);

const patchRoute = team.slice(
  team.indexOf('router.patch("/property-team-assignments/:id"'),
  team.indexOf("return router;")
);
assert.match(patchRoute, /const me = await currentUser\(req\)/);
assert.match(patchRoute, /target\.property_id !== me\.property_id/);
assert.match(patchRoute, /!me\.can_manage_roles/);
assert.doesNotMatch(patchRoute, /process\.env\.OPERATOR_KEY|isOperator/);

console.log("PASS Team's legacy URLs use one staff-session and property authority boundary.");
