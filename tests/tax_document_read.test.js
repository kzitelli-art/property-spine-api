/* ════════════════════════════════════════════════════════════════════
   tax_document_read.test.js — THE TAX PROPOSAL ADAPTER, AGAINST REAL
   CITY DOCUMENTS.

   `tax_document_read.js` is pure, so it is tested pure and runs on every
   build. The two fixtures are the extracted text of ACTUAL documents
   from the portfolio — a City Real Estate Tax bill and a filed
   Philadelphia BIRT return — because a reader proven against an invented
   format is proven against nothing. Both taught the parser something no
   imagined layout would have:

     · the bill prints "OPA Number:" twice and only the second has its
       value beside it, so every occurrence has to be tried;
     · a filed BIRT return showing $0.00 is ordinary and true, so zero
       must be readable where an insurance premium of zero would not be.

   ── AND WHAT IT MUST REFUSE ─────────────────────────────────────────
   A proposal that looks like a reading but is a guess is worse than a
   blank form, because a human is about to press confirm on it. So the
   refusals get as many assertions as the readings.

   Run:  node tests/tax_document_read.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const doc = require("../src/asset/tax_document_read.js");

const EXPECTED_ASSERTIONS = 34;
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
const fixture = (n) =>
  fs.readFileSync(path.join(__dirname, "fixtures", "tax", n), "utf8");

console.log("════════════════════════════════════════════════════════");
console.log("  TAX DOCUMENT READER — real City documents, no database");
console.log("════════════════════════════════════════════════════════");

console.log("\n── 1. A REAL CITY REAL ESTATE TAX BILL ───────────────");

const bill = doc.propose(fixture("2116_chestnut_ret_bill_2023.txt"), "tax_bill");
ok("the bill is readable", bill.available === true, JSON.stringify(bill));
ok("⚠ the OPA number is read despite the label appearing twice",
   bill.fields.account_identifier === "881566975", bill.fields.account_identifier);
ok("the tax year comes from the bill's own masthead",
   bill.fields.period_year === "2023", bill.fields.period_year);
ok("the due date is read through the weekday that precedes it",
   bill.fields.due_date === "2023-03-31", bill.fields.due_date);
ok("the amount is the AMOUNT TO PAY, not the pre-reduction figure",
   bill.fields.annual_liability === "201512.97", bill.fields.annual_liability);
ok("…which matters: the bill also prints $2,015,129.68 before reductions",
   bill.fields.annual_liability !== "2015129.68");
ok("nothing on the bill was left unread",
   bill.unknown.length === 0, JSON.stringify(bill.unknown));
ok("the receipt tells the operator to check every field before confirming",
   /Check every one before confirming/.test(bill.reason), bill.reason);
ok("⚠ the ASSESSMENT is not proposed — its labels and values are separated",
   bill.fields.assessment === undefined);

console.log("\n── 2. A REAL FILED BIRT RETURN ───────────────────────");

const birt = doc.propose(fixture("onefive_4233_birt_2023.txt"), "tax_return");
ok("the return is readable", birt.available === true, JSON.stringify(birt));
ok("the Philadelphia tax ID is read",
   birt.fields.account_identifier === "2000179694", birt.fields.account_identifier);
ok("the tax year comes from the filing period, not the submission date",
   birt.fields.period_year === "2023", birt.fields.period_year);
ok("⚠ the SUBMITTED date is read — the one an operator hunts for",
   birt.fields.filed_at === "2024-03-29", birt.fields.filed_at);
ok("⚠ $0.00 is read as a real figure, not discarded as falsy",
   birt.fields.annual_liability === "0.00", String(birt.fields.annual_liability));
ok("⚠ the MANDATORY next-year estimate is proposed as its OWN field",
   birt.fields.estimate_next_year === "0.00", String(birt.fields.estimate_next_year));
ok("…because it satisfies a DIFFERENT requirement from the balance",
   Object.prototype.hasOwnProperty.call(birt.fields, "annual_liability")
   && Object.prototype.hasOwnProperty.call(birt.fields, "estimate_next_year"));
ok("a return proposes no DUE DATE, because it does not carry one",
   birt.fields.due_date === undefined);

console.log("\n── 3. WHAT IT REFUSES TO PROPOSE ─────────────────────");

//  ⚠ THE ONE THAT MATTERS MOST. A document mentioning a tax is not a
//  finding that the tax applies.
for (const kind of Object.keys(doc.KIND_FIELDS)) {
  const keys = doc.KIND_FIELDS[kind].map((f) => f.key).join(",");
  if (/applicab|determination|basis|filer_profile/.test(keys)) {
    ok(`${kind} proposes no applicability or filer profile`, false, keys);
  }
}
ok("⚠ NO document kind may propose applicability, a basis or a filer profile",
   !Object.keys(doc.KIND_FIELDS).some((k) =>
     doc.KIND_FIELDS[k].some((f) =>
       /applicab|determination|basis|filer_profile/.test(f.key))));

const clr = doc.propose("CITY OF PHILADELPHIA TAX CLEARANCE CERTIFICATE\nAmount to Pay: $500.00",
  "tax_clearance_certificate");
ok("a clearance certificate proposes nothing at all",
   clr.available === false && Object.keys(clr.fields).length === 0);
ok("…and says why, rather than looking broken",
   /compliance evidence/.test(clr.reason), clr.reason);
ok("…even though the text it was given contained a money figure",
   clr.fields.annual_liability === undefined);

const appeal = doc.propose("BOARD OF REVISION OF TAXES — APPEAL FILED", "tax_appeal_document");
ok("an appeal document proposes nothing, and says an appeal changes nothing owed",
   appeal.available === false && /does not change what is currently owed/.test(appeal.reason));

const empty = doc.propose("", "tax_bill");
ok("an unreadable document is honest about it",
   empty.available === false && /could not read any text/.test(empty.reason));
ok("…and still names every field it would have wanted",
   empty.unknown.length === 4, JSON.stringify(empty.unknown));

const nothing = doc.propose("A letter from the City about nothing in particular.", "tax_bill");
ok("a document with none of the labels proposes nothing",
   nothing.available === false && Object.keys(nothing.fields).length === 0);
ok("…and tells the operator to enter what it says",
   /Enter what it says/.test(nothing.reason), nothing.reason);

console.log("\n── 4. THE PARSERS REFUSE WHAT THEY CANNOT BE SURE OF ──");

ok("⚠ an ambiguous numeric date is refused — 03/04/2026 is two dates",
   doc.parseDate("03/04/2026") === null);
ok("an ISO date is accepted", doc.parseDate("2026-03-31") === "2026-03-31");
ok("the City's DD-Mon-YYYY is accepted", doc.parseDate("31-Dec-2023") === "2023-12-31");
ok("a written month is accepted through a leading weekday",
   doc.parseDate("FRIDAY, MARCH 31, 2023") === "2023-03-31");
ok("a bare integer is not money — 'Line 4' is not $4.00",
   doc.parseMoney("Line 4") === null);
ok("…but $0.00 is", doc.parseMoney("$0.00") === "0.00");
ok("a short number is not an account identifier",
   doc.parseIdentifier("Bill Item 001") === null);
ok("…a nine-digit OPA number is", doc.parseIdentifier("881566975") === "881566975");

console.log("\n════════════════════════════════════════════════════════");
console.log(`  ${pass + fail} assertions · ${pass} passed · ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.log(`  ✗ RUN INVALID — expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}.`);
  process.exit(1);
}
if (fail) { console.log("  ✗ FAIL"); process.exit(1); }
console.log("  ✓ PASS — it reads what the City wrote, and refuses the rest.");
console.log("════════════════════════════════════════════════════════");
