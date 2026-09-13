#!/usr/bin/env node
"use strict";
// Source-level contract for the governed inventory-correction door. The
// runtime behaviour is proven by tests/e2e/inventory_correction.e2e.js on a
// real database; this keeps the load-bearing shape reviewable without one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..", "..");
const svc = fs.readFileSync(path.join(ROOT, "src/tenancy/inventory_correction.js"), "utf8");
const op = fs.readFileSync(path.join(ROOT, "src/identity/operator.js"), "utf8");
const standing = fs.readFileSync(path.join(ROOT, "src/tenancy/tenancy_position_read.js"), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const S = strip(svc), O = strip(op);

// 1 — the existing owner writes; this module never inserts a retirement row itself.
assert.match(S, /require\("\.\/inventory_retirement"\)/, "the door requires the existing owner");
assert.match(S, /retireInventoryUnits\(client, \{/, "retirement goes through retireInventoryUnits");
assert.match(S, /reinstateInventoryUnit\(client, \{/, "reinstatement goes through reinstateInventoryUnit");
assert.doesNotMatch(S, /insert into inventory_retirements/, "no second retirement writer");
assert.doesNotMatch(S, /update inventory_retirements/, "no second reversal writer");
assert.doesNotMatch(S, /delete from/, "nothing is deleted");
assert.doesNotMatch(S, /update units set|update spaces set|update leases set/, "identity is not relabelled, reparented or moved");

// 2 — authority is re-verified inside the transaction, from the assignment row, requiring the override AND the management module.
assert.match(S, /can_manage_roles !== true \|\| !\(a\.allowed_modules \|\| \[\]\)\.includes\("management"\)/, "live authority = override + management module");
assert.match(S, /await assertLiveAuthority\(client/, "authority is asserted on the transaction client");

// 3 — the decision is bound to the reviewed facts, and the review token covers every relationship count.
assert.match(S, /relationships: facts\.relationships/, "the token covers relationship counts");
assert.match(S, /live_retirement: facts\.live_retirement \? facts\.live_retirement\.id : null/, "the token covers retirement state");
assert.match(S, /"stale_review"/, "a mismatched token is refused by name");

// 4 — concurrent writers: the unit's SPACES are locked FOR UPDATE (KEY SHARE exclusion), not just the unit row.
assert.match(S, /select id from spaces where unit_id = any\(\$1::uuid\[\]\) order by id for update/, "apply locks the unit's spaces");
assert.match(S, /select id from spaces where unit_id = \$1 order by id for update/, "reinstate locks the unit's spaces");

// 5 — all-or-nothing: refusals are collected and thrown before the owner writes.
assert.match(S, /if \(refused\.length\) \{\s*throw refuse\("retirement_refused"/, "one refused unit refuses the whole submission before any write");

// 6 — the routes: reads need the management module; writes need the governed override; property comes from the session.
for (const r of ["corrections\", requireOperator, requireManagementModuleAccess",
                 "corrections/review\", requireOperator, requireManagementModuleAccess",
                 "corrections/history\", requireOperator, requireManagementModuleAccess"]) {
  assert.ok(O.includes(`"/operator/inventory/${r}`), `read route gated by management module: ${r}`);
}
for (const r of ["retire", "reinstate"]) {
  assert.ok(O.includes(`"/operator/inventory/corrections/${r}", requireOperator, requireManagementModuleAccess, requireGovernanceAuthority`), `write route gated by the governed override: ${r}`);
}
assert.match(O, /property_id: req\.operator\.property_id,\s*actor: \{ user_id: req\.operator\.id \}/, "property and actor are server-derived");
assert.doesNotMatch(O, /inventoryCorrection\.\w+\(pool, \{[^}]*property_id: (req\.body|b)\./, "the browser never names the property");

// 7 — the reason vocabulary is the owner's; no new reason is authored here.
assert.doesNotMatch(S, /REASONS_DATE_SENSITIVE\s*=|physically_removed|converted_to/, "no new reason vocabulary");
assert.match(S, /ALL_REASONS\.includes\(reason_code\)/, "reasons are validated against the owner's list");

// 8 — the standing read carries the exclusion for Ask Spine.
assert.match(strip(standing), /unit_records_retired_from_current_inventory/, "tenancy standing names retired records");
assert.match(strip(standing), /tenancy_attached_to_retired_inventory/, "tenancy standing names tenancy attached to retired inventory");

console.log("inventory_correction_contract: PASS (source contracts)");
