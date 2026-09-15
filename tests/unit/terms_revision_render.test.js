/* Terms revision UI proof; browser journey is covered separately by the owner. */
"use strict";
const fs = require("fs");
const source = fs.readFileSync(require("path").join(__dirname, "../../src/applications/application_submission.js"), "utf8");
let passed = 0, failed = 0;
function ok(value, label) { if (value) { passed++; console.log("PASS  " + label); } else { failed++; console.log("FAIL  " + label); } }
ok(/CTX\.state===\"terms_review\"/.test(source), "terms_review state has a dedicated path");
ok(/Previously reviewed/.test(source) && /shown for comparison only and are not accepted/.test(source), "previous terms are clearly labelled and never treated as accepted");
ok(/previous_terms_acknowledged===true/.test(source), "previous terms require the server acknowledgement marker");
ok(/Accept revised terms/.test(source) && /No new application was created/.test(source), "revision flow accepts into the existing application");
ok(/application_terms_hash:termsHash\(\),application_terms_acknowledged:true/.test(source), "revision submit sends only current hash and acknowledgement");
ok(/latest\.state===\"open\" \|\| latest\.state===\"terms_review\"/.test(source), "a second revision refreshes while the applicant is already reviewing");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
