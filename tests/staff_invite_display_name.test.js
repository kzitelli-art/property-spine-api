/* ════════════════════════════════════════════════════════════════════
 *  THE INVITE PATH SPEAKS THE OPERATOR'S NAME FOR THE BUILDING
 *
 *  operator.js already states the rule: display_name (migration 060) is
 *  what humans call the property; the internal name is load-bearing
 *  plumbing. The staff invite path did not follow it, and that is not
 *  cosmetic in this database.
 *
 *  Production, read 2026-08-18:
 *
 *      id           a50fbdd0-3642-431e-b532-0dcd6ab8a4fe
 *      name         'Property Spine Demo Building'
 *      display_name 'Solo on Chestnut'          283 units
 *
 *  So a new operator's FIRST contact with Property Spine was a text
 *  reading "Your Property Spine Demo Building access code is ......".
 *  An SMS a person can see is product copy, and that one carried demo
 *  vocabulary into the live onboarding path (§17: demo data may exist,
 *  demo paths may not).
 *
 *  Source-level, deliberately. The SMS body is composed from a query
 *  result, so what has to be asserted is that the QUERY asks for the
 *  display name — a runtime test with a fixture property would pass
 *  while production still texted the demo name.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "src", "identity", "teamaccess.js");
const src = fs.readFileSync(FILE, "utf8");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

/*  ── STRIPPING COMMENTS IS ITSELF A SCAN, AND THE FIRST ONE WAS WRONG ──
 *
 *  A MENTION IS NOT A GUARD, so comments have to come out: the header
 *  above names both the right and the wrong pattern and would satisfy a
 *  naive scan on its own.
 *
 *  The first version did it with /\/\*[\s\S]*?\*\//g and QUIETLY ATE REAL
 *  CODE — it lost one of the two SMS bodies entirely and two of the five
 *  properties reads, then reported three cheerful ok's about a file with
 *  holes in it. A gate that scans less than it asserts launders the gap
 *  into evidence.
 *
 *  So: strip only comments that START A LINE, which is this repo's style
 *  throughout, and never anything mid-line where a string could live.
 *  Then PROVE the stripper did not eat code, below.                     */
const code = src
  .split("\n")
  .reduce((acc, line) => {
    const t = line.trim();
    if (acc.inBlock) { if (t.endsWith("*/") || t.includes("*/")) acc.inBlock = false; acc.out.push(""); return acc; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) acc.inBlock = true; acc.out.push(""); return acc; }
    if (t.startsWith("*") || t.startsWith("//")) { acc.out.push(""); return acc; }
    acc.out.push(line);
    return acc;
  }, { out: [], inBlock: false })
  .out.join("\n");

/*  THE STRIPPER MUST NOT REMOVE WHAT IT IS ABOUT TO MEASURE. Counted on
 *  the RAW file and again on the stripped one: any properties read that
 *  disappears was inside what the stripper called a comment, and this
 *  test would then be asserting over a file it had damaged.  */
const rawReads = (src.match(/from properties/gi) || []).length;
const cutReads = (code.match(/from properties/gi) || []).length;

console.log("\n── every properties read in the invite path ──");

ok(cutReads === rawReads,
   "comment-stripping removed no properties read (" + cutReads + " of " + rawReads + ")",
   "the stripper ate code — every assertion below is over a damaged file");

const reads = [...code.matchAll(/select[^;]*?from properties[^;]*/gi)].map((m) => m[0].replace(/\s+/g, " ").trim());
ok(reads.length === rawReads,
   "every properties read was parsed into a statement (" + reads.length + " of " + rawReads + ")",
   "the statement regex matched fewer than exist");

const naming = reads.filter((r) => /\bname\b/.test(r));
console.log("     " + naming.length + " read(s) select a name");

naming.forEach((r) => {
  const short = r.length > 96 ? r.slice(0, 96) + "…" : r;
  ok(/coalesce\(\s*display_name\s*,\s*name\s*\)/i.test(r),
     "uses coalesce(display_name, name): " + short);
});

console.log("\n── the two messages a person actually receives ──");

const otp = code.match(/const body = `Your \$\{([^}]+)\} access code/);
ok(!!otp, "the OTP SMS body is still recognisable to this test",
   "the template changed — re-read it before trusting this file");
ok(otp && /prop\.name/.test(otp[1]), "the OTP SMS interpolates the property row's name field", otp && otp[1]);

const added = code.match(/You've been added to \$\{([^}]+)\} on Property Spine/);
ok(!!added, "the invite SMS body is still recognisable to this test");
ok(added && /prop\.name/.test(added[1]), "the invite SMS interpolates the property row's name field", added && added[1]);

/*  THE POINT OF THE WHOLE FILE. Both messages read `prop.name`, so the
 *  only thing that decides which name a human sees is what the QUERY
 *  aliased into that field.  */
const bareNameRead = reads.find((r) => /\bselect\b[^;]*?(^|[ ,(])name\b/i.test(r)
                                    && !/coalesce\(\s*display_name/i.test(r));
ok(!bareNameRead, "no read in this file aliases the INTERNAL name into `name`",
   bareNameRead);

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS COMPLETE · " + (pass + fail) + " run · " + pass + " passed · " + fail + " failed");
console.log(fail ? "  ✗ FAIL" : "  ✓ PASS — the invite path speaks the operator's name for the building.");
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
