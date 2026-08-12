// ════════════════════════════════════════════════════════════════════
//  gate_insurance_economic_independence.js — STATIC GATE
//
//  THE WALL BETWEEN INSURANCE ECONOMICS AND PREMIUM FINANCING.
//
//  The June 2026 Skyline workpaper computes the property's annual
//  insurance cost from the IPFS financing stream:
//
//      allocated down payment + allocated installments ÷ 12
//
//  The straight-line concept was fine. The DERIVATION made the payment
//  instrument the source of the economic fact. Prior-year sheets state
//  the intended concept directly — allocated annual insurance cost plus
//  brokerage fee, ÷ 12 — which needs no knowledge of how it was funded.
//
//  So the requirement is not "please keep these separate". It is:
//
//      THE INSURANCE ECONOMIC CHAIN MUST BE ABLE TO ANSWER A
//      PROPERTY'S INSURANCE EXPENSE WITHOUT KNOWING IPFS EXISTS.
//
//  This gate makes that structural. It scans the economic chain —
//  migration 161 and the three services — for any financing, escrow,
//  installment or payment vocabulary and fails the build on a hit.
//
//  Premium financing WILL be built, next to this and not inside it. When
//  it is, this gate is what stops the seam growing back: a developer
//  adding `finance_charge_cents` to insurance_coverages because IPFS
//  bills premium and finance charge on one invoice gets a red build and
//  this comment.
//
//      A finance charge is not insurance premium merely because IPFS
//      collects both through the same payment stream.
//
//  Run:  node tests/gate_insurance_economic_independence.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

//  THE ECONOMIC CHAIN. Exactly the files that answer "what does
//  insurance cost this property". Adding a file here is a deliberate act.
const CHAIN = [
  "migrations/161_insurance_economic_truth.sql",
  //  Participation — named on the policy, no amount. It is part of the
  //  chain because it is what the economic read now hangs off, and a
  //  financing reference could reach the chain through it just as easily.
  "migrations/162_insurance_coverage_participation.sql",
  "src/asset/insurance_program_service.js",
  "src/asset/insurance_allocation_service.js",
  "src/asset/insurance_position_read.js",
  //  THE WRITE PATH. Added when establishment shipped. Without it this
  //  gate asserted independence over the readers only, while the routes
  //  that actually CREATE insurance truth went unscanned — a gate that
  //  scans less than the claim it makes, which is worse than no gate
  //  because it launders the gap into evidence.
  //
  //  This is also why those routes are their own module rather than two
  //  more handlers in src/surfaces/asset_management.js: that file
  //  legitimately contains "Premium financing", "Down payment" and
  //  "Financed amount" in the Cash & Financing section's `reserved` spec
  //  — the description of a deliberately unbuilt section — so it cannot
  //  be scanned whole and the write path would have had no gate at all.
  "src/asset/insurance_establishment.js",
  //  The proposal adapter. It writes nothing, but it decides what an
  //  operator is SHOWN off a document — and a reader that started
  //  proposing installment or down-payment fields would be walking
  //  financing back into the chain through the confirm screen.
  "src/asset/insurance_document_read.js",
];

//  Financing / cash vocabulary. Word-boundary matched so ordinary English
//  ("payment schedule" in a comment about what this file does NOT do)
//  still trips it — that is intended. The gate is deliberately noisy in
//  the direction of safety; a legitimate mention belongs in a doc, not in
//  the chain.
const FORBIDDEN = [
  /\bipfs\b/i,
  /\bafco\b/i,
  /\binstallment/i,
  /\bdown[_ ]?payment/i,
  /\bfinance[_ ]?charge/i,
  /\bpremium[_ ]?financ/i,
  /\bfinanced[_ ]?amount/i,
  /\bescrow/i,
  /\bintercompany/i,
  /\bbank[_ ]?transaction/i,
  /\bmoney_events?\b/i,
  /\bpayment_applications?\b/i,
  /\bpayments\b/i,
];

//  Comments are stripped before scanning. A MENTION IS NOT A DEPENDENCY:
//  these files explain at length what they refuse to touch, and prose
//  saying "no escrow here" must not fail a gate about code. This is the
//  same discipline the repo's other static gates use.
function stripComments(src, isSql) {
  let out = src;
  if (isSql) {
    out = out.replace(/--[^\n]*/g, " ");
  } else {
    out = out.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  }
  return out;
}

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
};

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  GATE      insurance economic independence");
console.log("════════════════════════════════════════════════════════════════\n");

for (const rel of CHAIN) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    ok(`${rel} exists`, false, "the economic chain is missing a file this gate is meant to protect");
    continue;
  }
  const raw = fs.readFileSync(abs, "utf8");
  const code = stripComments(raw, rel.endsWith(".sql"));

  const hits = [];
  for (const re of FORBIDDEN) {
    const m = code.match(re);
    if (m) hits.push(`${re} → ${JSON.stringify(m[0])}`);
  }
  ok(`${rel} has no financing, escrow or payment dependency`,
     hits.length === 0, hits.join("\n          "));
}

//  A coverage's economics are premium + taxes + fees + broker fee. If a
//  finance charge ever becomes a component, the total silently stops
//  being an insurance cost.
const mig = fs.readFileSync(path.join(ROOT, CHAIN[0]), "utf8");
const gen = mig.match(/total_cents\s+bigint generated always as\s*\(([^)]*)\)/i);
ok("coverage total is generated from premium + taxes + fees + broker fee only",
   !!gen && /premium_cents/.test(gen[1]) && /taxes_cents/.test(gen[1])
         && /fees_cents/.test(gen[1]) && /broker_fee_cents/.test(gen[1])
         && !/financ/i.test(gen[1]),
   gen ? gen[1].trim() : "no generated total found");

//  The accrual divisor must be the coverage term, not anything cash.
const read = fs.readFileSync(path.join(ROOT, "src/asset/insurance_position_read.js"), "utf8");
ok("the accrual divides by the coverage term, not by a payment count",
   /allocated_amount_cents\s*\/\s*months|annual\s*\/\s*months/.test(read));

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
console.log(fail ? "  ✗ FAIL — the insurance economic chain has reached into financing."
                 : "  ✓ PASS — insurance economics can be answered without financing.");
console.log(`  EXIT      ${fail ? 1 : 0}`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
