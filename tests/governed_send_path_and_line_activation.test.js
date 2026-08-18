/* ════════════════════════════════════════════════════════════════════
 *  GOVERNED SEND PATH · REMOVED WRITER · CANONICAL ACTIVATION SHAPE
 *
 *  Three source-level guarantees, asserted where they are decided rather
 *  than at runtime — a runtime test with a fixture property would pass
 *  while production still read the projection or still exposed the route.
 *
 *  1  sendPropertySms resolves its line through the CANONICAL model
 *     (resolveOutboundLine), not the properties.sms_number projection.
 *     This is the seam being closed: one file had two outbound paths and
 *     only one was governed.
 *
 *  2  POST /properties/:propertyId/sms-number is GONE. It wrote a row that
 *     satisfied ck_cl_outbound_flag_matches_policy while being the only
 *     property line that could not send (outbound_enabled=false, policy
 *     defaulting to 'disabled'), and sat behind the legacy OPERATOR_KEY.
 *
 *  3  tools/activate_property_line.js writes the row every other property
 *     line has — outbound_policy='proactive' — and refuses any property id
 *     that is not the canonical Skyline UUID.
 * ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const ok = (c, l, d) => { if (c) { pass++; console.log("  ok    " + l); }
                          else { fail++; console.log("  FAIL  " + l + (d ? "\n          " + d : "")); } };

//  Line-leading comment strip only. A block-comment regex ate real code in
//  a sibling gate; this counts what it strips, below, so a stripper that
//  eats code goes red rather than measuring less than it asserts.
function strip(src) {
  return src.split("\n").reduce((a, line) => {
    const t = line.trim();
    if (a.b) { if (t.includes("*/")) a.b = false; a.o.push(""); return a; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) a.b = true; a.o.push(""); return a; }
    if (t.startsWith("*") || t.startsWith("//")) { a.o.push(""); return a; }
    a.o.push(line); return a;
  }, { o: [], b: false }).o.join("\n");
}

const boundary = fs.readFileSync(path.join(__dirname, "..", "src", "comms", "communications_boundary.js"), "utf8");
const bcode = strip(boundary);
const tenant = fs.readFileSync(path.join(__dirname, "..", "src", "comms", "tenantlink.js"), "utf8");
const tcode = strip(tenant);
const tool = fs.readFileSync(path.join(__dirname, "..", "tools", "activate_property_line.js"), "utf8");
const toolcode = strip(tool);

console.log("\n── 1 · sendPropertySms is governed ──");

//  isolate the sendPropertySms body so an assertion about "this function"
//  cannot be satisfied by sendOperationsReply, which already resolves.
const spStart = bcode.indexOf("async function sendPropertySms");
const orStart = bcode.indexOf("async function sendOperationsReply");
ok(spStart > 0 && orStart > spStart, "both send functions are still present and ordered");
const spBody = bcode.slice(spStart, orStart);

ok(/resolveOutboundLine\s*\(\s*q\s*,\s*\{\s*propertyId/.test(spBody),
   "sendPropertySms resolves via resolveOutboundLine({propertyId})");
ok(!/propertyLine\s*\(/.test(spBody),
   "sendPropertySms no longer calls propertyLine()",
   "the projection-reading helper is back in the send path");
ok(/resolved\.line\.e164/.test(spBody),
   "the from-number is the canonical line's e164");
ok(/gate:\$\{resolved\.refusal\}/.test(spBody),
   "a resolver refusal is stamped, exactly as sendOperationsReply does");

//  the helper itself is gone from the whole file, not just unused
ok(!/async function propertyLine\b/.test(bcode),
   "the propertyLine() helper is deleted, not left dormant",
   "a projection-reading helper left in the file is the next caller's footgun");
ok(!/select\s+sms_number\s+from properties/i.test(bcode),
   "communications_boundary.js reads properties.sms_number nowhere");

console.log("\n── 2 · the stale writer is removed ──");

ok(!/router\.(post|put)\([`'"]\/properties\/:propertyId\/sms-number/.test(tcode),
   "POST /properties/:propertyId/sms-number is removed",
   "the route that wrote the operationally-false row is back");
//  the specific defect: an insert that names outbound_enabled without a
//  policy, defaulting the row to 'disabled'
ok(!/insert into communication_lines[\s\S]{0,400}?outbound_enabled[\s\S]{0,120}?values[\s\S]{0,400}?,\s*false\s*,\s*'active'/i.test(tcode),
   "no insert writes a property line with outbound_enabled=false",
   "the bad-row insert shape is still present");
ok(/REMOVED: POST \/properties\/:propertyId\/sms-number/.test(tenant),
   "a tombstone explains where line configuration went");

console.log("\n── 3 · the activation tool writes the right shape ──");

ok(/SKYLINE_PROPERTY_ID\s*=\s*["']14e41b7c-e91c-49e8-9651-10c4908a8f6a["']/.test(toolcode),
   "the tool pins the canonical Skyline UUID");
ok(/!==\s*SKYLINE_PROPERTY_ID/.test(toolcode),
   "and refuses any property id that is not it");
ok(/outbound_policy:\s*["']proactive["']/.test(toolcode),
   "the canonical row is proactive — matching every other property line");
ok(/outbound_enabled:\s*true/.test(toolcode),
   "with outbound_enabled true (forced by ck_cl_outbound_flag_matches_policy)");
ok(/status:\s*["']active["']/.test(toolcode) && !/status:\s*["']inactive["']/.test(toolcode),
   "status is 'active' — not 'inactive', which ck_cl_status would refuse");
ok(/status\s*=\s*['"]retired['"]/.test(toolcode),
   "the rollback path retires the line (the vocabulary the DB permits)");
ok(/pg_constraint|pg_indexes|pg_trigger/.test(toolcode),
   "the tool verifies live schema before writing, from the catalog");
//  HARD BOUNDARY — the tool must not reach into the provider side
ok(!/twilio|messages\.create|TWILIO_|messagingService/i.test(toolcode),
   "the tool never touches Twilio — provider config stays external");

console.log("\n════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS COMPLETE · " + (pass + fail) + " run · " + pass + " passed · " + fail + " failed");
console.log(fail ? "  ✗ FAIL" : "  ✓ PASS — send path governed, stale writer gone, activation shape correct.");
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
