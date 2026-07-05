// ════════════════════════════════════════════════════════════════════
//  gate_closure_boundary.js — THE ARCHITECTURAL CLOSURE-BOUNDARY GATE
//
//  The conversion closure capability is an ARCHITECTURAL boundary enforced
//  by import discipline and static gates — not claimed as an absolute
//  runtime-security boundary (this is one JS process). This gate IS the
//  enforcement. It fails the build when:
//    1. any production module other than server.js imports/creates the
//       conversion closure authority factory;
//    2. any module other than leasingconversion.js references the injected
//       capability name;
//    3. the generic engine grows a linked-obligation bypass token;
//    4. any production module other than the rail or the capability mutates
//       conversion-linked terminal state (update ... leasing_conversion_
//       obligations ... set ... outcome/resolution) directly.
//  Exits 1 with the offending file:line list on any hit.
// ════════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") && !f.startsWith("dbg"));
const offenses = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    const at = `${f}:${i + 1}`;
    // 1. only server.js may import/create the authority factory
    if (/require\(["'].\/conversion_obligation_closure(\.js)?["']\)/.test(line) && f !== "server.js") {
      offenses.push(`${at}  imports the closure authority factory (only server.js may): ${line.trim().slice(0, 90)}`);
    }
    if (/createConversionClosureAuthority\s*\(/.test(line) && f !== "server.js" && f !== "conversion_obligation_closure.js") {
      offenses.push(`${at}  creates a closure authority (only server.js may): ${line.trim().slice(0, 90)}`);
    }
    // 2. only leasingconversion.js consumes the injected capability
    if (/closureAuthority\s*\./.test(line) && f !== "leasingconversion.js" && f !== "conversion_obligation_closure.js") {
      offenses.push(`${at}  invokes the closure capability (only the conversion rail may): ${line.trim().slice(0, 90)}`);
    }
    // 3. the engine must carry no bypass token
    if (/via_conversion_rail/.test(line)) {
      offenses.push(`${at}  bypass token resurfaced: ${line.trim().slice(0, 90)}`);
    }
    // 4. terminal-state mutation of the link table outside the rail/capability
    if (/update\s+leasing_conversion_obligations[\s\S]{0,120}set[\s\S]{0,120}(outcome|resolution)\s*=/i.test(line)
        && f !== "leasingconversion.js" && f !== "conversion_obligation_closure.js") {
      offenses.push(`${at}  mutates conversion terminal state outside the rail: ${line.trim().slice(0, 90)}`);
    }
  });
}

// self-test: the gate must be able to see (plant a violation in-memory and match it)
const planted = 'const x = require("./conversion_obligation_closure.js");';
if (!/require\(["'].\/conversion_obligation_closure(\.js)?["']\)/.test(planted)) {
  console.log("GATE SELF-TEST FAILED — the import pattern no longer matches its own plant.");
  process.exit(1);
}

if (offenses.length) {
  console.log("GATE FAIL — the closure boundary is breached:");
  for (const o of offenses) console.log("  " + o);
  process.exit(1);
}
console.log("GATE PASS — closure authority created only in server.js, consumed only by the rail, no bypass token, no external terminal-state mutation.");
process.exit(0);
