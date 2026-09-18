#!/usr/bin/env node
"use strict";

// The same property has three independent facts: stable identity, a mutable
// human label, and a stored leasing model. This guard makes their ownership
// structural so a future reader cannot silently let registry metadata win the
// label again.

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

let passed = 0;
let failed = 0;
function ok(label, condition) {
  if (condition) { passed++; console.log("  ok   " + label); }
  else { failed++; console.error("  FAIL " + label); }
}

const surface = read("src/surfaces/property_surface.js");
const leasing = read("src/leasing/leasing_detail.js");
const reporting = read("src/money/reporting.js");
const exposure = read("src/money/exposure.js");
const registry = read("src/onboarding/deal_registry.js");
const resolver = read("src/identity/property_resolution_service.js");
const identify = read("src/identity/identify.js");
const admin = read("src/identity/super_admin.js");

for (const [label, source] of [["property surface", surface], ["leasing detail", leasing]]) {
  ok(`${label} selects display_name`, /select id, name, display_name, canonical_key from properties/.test(source));
  ok(`${label} gives the property row naming authority`, /propRow\?\.display_name \|\| propRow\?\.name \|\| "Property"/.test(source));
  ok(`${label} does not let registry metadata win the label`, !/deal\?\.name \|\| propRow/.test(source));
  ok(`${label} still reads the model from the registry`, /const model = deal\?\.model \|\| null/.test(source));
  ok(`${label} returns the canonical property key`, /canonical_key: canonicalKey/.test(source));
}

ok("reporting renders the display label and keeps identity plus model separate",
  /property: \{ id: prop\.id, name: prop\.display_name \|\| prop\.name, canonical_key: prop\.canonical_key, model \}/.test(reporting));
ok("reporting reads the model from the registry",
  /const model = deal\?\.model \|\| null/.test(reporting));
ok("exposure preserves the response key and renders the display label",
  /property: \{ id: prop\.id, name: prop\.display_name \|\| prop\.name, canonical_key: prop\.canonical_key \}/.test(exposure));
ok("the registry header no longer claims naming authority",
  !/what to call the property/.test(registry) && /Registry names are metadata, not UI labels/.test(registry));

ok("identity resolution remains keyed on internal name",
  /where name = \$1/.test(resolver) && !/display_name/.test(resolver));
ok("identity confirmation remains outside this presentation change",
  /select id, name, canonical_key from properties where id=\$1/.test(identify));

ok("the route derives the actor from the authenticated session",
  /actor_user_id: req\.operator\.id/.test(admin));
ok("the route never accepts actor_user_id from the body",
  !/actor_user_id:\s*b\./.test(admin));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
