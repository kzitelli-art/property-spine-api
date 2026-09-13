#!/usr/bin/env node
// DB-free guard for the bounded 195 operation. Behavioural proof lives on the
// nonce-owned Postgres rehearsal; this prevents the critical boundaries from
// disappearing before that rehearsal is next run.
"use strict";

const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "release", "migration_195_predeploy.js"), "utf8");
let pass = 0, fail = 0;
function ok(label, condition) {
  if (condition) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.error(`  FAIL  ${label}`); }
}

console.log("\nMIGRATION 195 PREDEPLOY CONTRACT\n");
ok("the reviewed migration source digest is pinned", /REVIEWED_195_SHA256\s*=\s*"e5c8f9bdb382b3a36e56e9b514db25734639500be9579171762d37c7e28b02bb"/.test(source));
ok("all four public CHECK definitions are compared as whole normalized definitions",
  (source.match(/"check\(/g) || []).length >= 7 && /stripped\(row\.definition\) !== definition/.test(source) && /n\.nspname='public'/.test(source));
ok("apply accepts only an exactly sole pending 195", /pending\.length !== 1 \|\| pending\[0\] !== FILE_195/.test(source));
ok("repeated --apply at validated 195 is no-write and unknown arguments refuse",
  /before\.state === "post"/.test(source) && /unknown command arguments/.test(source) && /REPEAT APPLY/.test(source));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
