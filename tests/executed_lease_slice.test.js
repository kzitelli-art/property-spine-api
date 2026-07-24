#!/usr/bin/env node
/**
 * EXECUTED LEASE SLICE — WIRING PROOF (088)
 *
 * The evidence service is proven behaviorally by executed_lease_evidence.test.js.
 * This proves the SLICE: confirm-term recomputes instead of trusting a stored
 * verdict, governing values no longer come from the browser, countersign is
 * retired everywhere, and a blocked lease is visible in Application Review.
 *
 * Run from the repo root:  node executed_lease_slice.test.js
 */
const fs = require("fs"), path = require("path");
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  → " + d : "")); } };
const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");

const anchor = read("tenancy_anchor_service.js");
const operator = read("operator.js");
const server = read("server.js");
const apps = read("applications.js");
const review = read("application_review.js");
const svc = read("executed_lease_service.js");

console.log("\nEXECUTED LEASE SLICE — WIRING PROOF\n");

console.log("1. confirm-term takes nothing governing from the browser");
const ct = anchor.slice(anchor.indexOf("async function confirmTermService"));
ok("signature accepts only applicationId + confirming human",
  /confirmTermService\(client, \{ applicationId, confirmed_by = null,\s*\n?\s*confirmed_by_user_id = null \}\)/.test(ct));
ok("no rent from the caller", !/rent: rentIn/.test(ct));
ok("no dates from the caller", !/start_date = null, end_date = null/.test(ct));
ok("rent comes from the executed record", /const rent = Number\(executed\.rent\)/.test(ct));
ok("dates come from the executed record", /const start_date = executed\.lease_start_date/.test(ct));

console.log("\n2. Recompute, not the stored verdict (requirement 3)");
ok("calls computeAdmissionBlockers inside the transaction", /executedLease\.computeAdmissionBlockers\(client/.test(ct));
ok("never reads admission_status as authorization", !/admission_status\s*===\s*['\"]admitted/.test(ct));
ok("writes the evaluation to append-only history under confirm_term",
  /recordAdmissionEvaluation\(client, \{[\s\S]{0,300}evaluation_context: "confirm_term"/.test(ct));
ok("blockers refuse with 409 activation_blocked", /error: "activation_blocked"/.test(ct));
ok("refusal happens BEFORE the lease insert",
  ct.indexOf('error: "activation_blocked"') < ct.indexOf("insert into leases"));
ok("fails closed 503 when the service is unwired", /Executed-lease service not wired/.test(ct));
ok("back-fills executed_lease_records.lease_id (arms the amendment boundary)",
  /update executed_lease_records set lease_id=\$1 where id=\$2/.test(ct) &&
  ct.indexOf('update executed_lease_records set lease_id') > ct.indexOf('insert into leases'));

console.log("\n3. Exact premises (by-bed defect fixed)");
ok("space comes from the executed record", /const spaceId = executed\.space_id/.test(ct));
ok("arbitrary first-space-in-unit lookup is gone",
  !/select id from spaces where unit_id=\$1 order by created_at asc limit 1/.test(ct));

console.log("\n4. Gate B retired");
ok("'locked economics WIN' is gone", !/locked economics WIN/.test(anchor));
ok("rent_source is the executed lease", /rent_source = "verified_executed_lease"/.test(ct));
ok("a conflicting offer blocks rather than overrides",
  /locked_offer_conflict/.test(svc) && !/rent = lockedRent/.test(anchor));

console.log("\n5. Countersign retired everywhere (no alias)");
ok("countersignService no longer exists", !/async function countersignService/.test(anchor));
ok("…and is not exported", !/return \{ countersignService/.test(anchor));
ok("legacy route answers 410", /countersign[\s\S]{0,400}?410[\s\S]{0,300}?countersign_retired/.test(apps));
ok("operator route answers 410", /countersign", async \(req, res\) => \{[\s\S]{0,200}410/.test(operator));
ok("both name the replacement", /executed-lease\/verify/.test(apps) && /executed-lease\/verify/.test(operator));

console.log("\n6. The verify door");
const vd = operator.slice(operator.indexOf('"/operator/leasing/applications/:id/executed-lease/verify"'));
ok("door exists and is session-authed",
  /executed-lease\/verify", requireOperator, requireLeasingModuleAccess/.test(operator));
ok("property wall precedes any write",
  vd.indexOf("belongs to a different property") < vd.indexOf("executedLease.verifyExecutedLease(client"));
ok("verifying user is server-derived", /verified_by_user_id: req\.operator\.id/.test(vd));
ok("no verified_by from the body", !/verified_by_user_id: b\./.test(vd));
ok("returns 200 even when activation is blocked", /the requested fact — recording/.test(vd));
ok("fails closed 503 when unwired", /Executed-lease intake is not wired/.test(vd));

console.log("\n7. Server wiring");
ok("executed-lease service required", /const __executedLease = require\("\.\/executed_lease_service"\)/.test(server));
ok("injected into the tenancy anchor", /tenancy_anchor_service"\)\(\{[\s\S]{0,600}executedLease: __executedLease/.test(server));
ok("injected into operator", /operatorModule\(\{[\s\S]{0,2500}executedLease: __executedLease/.test(server));
ok("declared before both consumers",
  server.indexOf("const __executedLease") < server.indexOf("operatorModule({"));

console.log("\n8. Application Review surfacing (requirement 1)");
ok("execution record is loaded", /async function loadExecutedLease/.test(review));
ok("blocked state is exposed", /activation_status: rec\.admission_status/.test(review));
ok("blockers are exposed", /blockers,/.test(review));
ok("one primary action authored server-side", /function executionPrimaryAction/.test(review));
ok("…all three states covered",
  /verify_executed_lease/.test(review) && /review_conflict/.test(review) && /confirm_term/.test(review));
ok("pre-088 deploy degrades honestly, never guesses", /unavailable: true/.test(review));
ok("surfaced on the detail payload", /execution_primary_action: executionPrimaryAction/.test(review));

console.log("\n9. Operator language corrected");
ok("no 'countersign acceptance' wording", !/follows countersign acceptance/.test(anchor));
ok("admitted event says term confirmation required", /term confirmation required/.test(svc));

console.log("\n" + "-".repeat(52));
console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
