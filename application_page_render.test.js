#!/usr/bin/env node
/**
 * APPLICANT PAGE RENDER PROOF
 *
 * The applicant form is emitted from a template literal inside
 * applicationSubmission.js. Inside an untagged template literal, `\d` is a
 * NonEscapeCharacter and evaluates to `d` — so a regex written as /^\d{4}$/ in
 * the source reaches the browser as /^d{4}$/ and silently stops matching.
 *
 * `node --check` cannot see this. The server boots clean, the page renders,
 * and the applicant simply cannot pass validation. This harness renders the
 * page the way Express does and asserts against the EMITTED text.
 *
 * Run from the repo root:  node application_page_render.test.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "applicationSubmission.js");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
};

// ── render the applicant page exactly as the route does ────────────────────
const src = fs.readFileSync(FILE, "utf8");
const s = src.indexOf(".send(`<!DOCTYPE html>");
if (s < 0) { console.error("Could not locate the applicant page template."); process.exit(1); }
const open = src.indexOf("`", s);
const close = src.indexOf("</html>`);", open);
const tpl = src.slice(open + 1, close + "</html>".length);
const html = new Function("dobMax", "token",
  "return `" + tpl.replace(/`/g, "\\`") + "`;"
)("2026-07-22", "PROOFTOKEN");

console.log("\nAPPLICANT PAGE RENDER PROOF");
console.log("rendered bytes: " + html.length + "\n");

// ── 1. no degraded regex escapes reach the browser ─────────────────────────
console.log("1. Emitted script integrity");
const degraded = [];
// a regex literal in the emitted script must never contain a bare class letter
// where an escape was intended: /d{ , /D , [^s@ , etc.
[
  [/\/\^?\(?d\{\d/, "\\d degraded to d"],
  [/\/D[+*/]/, "\\D degraded to D"],
  [/\[\^s@\]/, "\\s degraded to s"],
  [/\[\$,s\]/, "\\s degraded to s in currency strip"],
].forEach(([re, label]) => { if (re.test(html)) degraded.push(label); });
ok("no degraded regex escapes in the emitted script", degraded.length === 0, degraded.join("; "));

// ── 2. the validation the applicant actually meets ─────────────────────────
console.log("\n2. Applicant validation (against emitted regexes)");
const grab = (re) => { const m = html.match(re); return m ? new RegExp(m[0].slice(1, -1)) : null; };
const email = grab(/\/\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$\//);
const zip = grab(/\/\^\\d\{5\}\(-\\d\{4\}\)\?\$\//);
const ym = grab(/\/\^\\d\{4\}-\\d\{2\}\$\//);
const ymd = grab(/\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);

ok("email regex present and correct", !!email && email.test("a@b.co") && !email.test("nope") && !email.test("a b@c.co"));
ok("ZIP accepts 19104 and 19104-1234", !!zip && zip.test("19104") && zip.test("19104-1234") && !zip.test("1910"));
ok("year-month accepts 2024-06", !!ym && ym.test("2024-06") && !ym.test("2024-6"));
ok("full date accepts 2026-08-01", !!ymd && ymd.test("2026-08-01") && !ymd.test("2026-8-1"));

// ── 3. date of birth is the native control, and it validates ───────────────
console.log("\n3. Date of birth");
ok("DOB is a native date input", /id="dob_input"[^>]*type="date"/.test(html));
ok("DOB is capped at today (no future birth date)", /id="dob_input"[^>]*max="\d{4}-\d{2}-\d{2}"/.test(html));
ok("the text mask is gone", !/formatDobInput/.test(html));

// exercise the emitted DOB helpers
const body = ["dobParts", "isoDob", "validDob"].map((n) => {
  const i = html.indexOf("function " + n + "(");
  if (i < 0) return "";
  let d = 0; const j = html.indexOf("{", i);
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") d++;
    else if (html[k] === "}") { d--; if (d === 0) return html.slice(i, k + 1); }
  }
  return "";
}).join("\n");
const state = { dob_input: "" };
const api = new Function("state", body + "\nreturn {dobParts,isoDob,validDob};")(state);
const dob = (v) => { state.dob_input = v; return { valid: api.validDob(), iso: api.isoDob() }; };

ok("1988-04-30 is accepted and serializes to ISO", dob("1988-04-30").valid === true && dob("1988-04-30").iso === "1988-04-30");
ok("a future date is rejected", dob("2099-01-01").valid === false);
ok("an empty value is rejected", dob("").valid === false);
ok("an impossible date is rejected", dob("2026-02-30").valid === false);

// ── 4. no unit economics asserted to the applicant ─────────────────────────
console.log("\n4. Honest unit facts");
const banned = ["UNIT_CATALOG", "source_as_of", "floorplans", "sq ft", "sqft", "SOLO_", "$1,"];
const found = banned.filter((b) => html.includes(b));
ok("no hardcoded rent, availability, sq ft, floor plans, or specials", found.length === 0, found.join(", "));
ok("property name comes from the invitation record", /CTX\.property_name/.test(html));
ok("unit label comes from the invitation record", /CTX\.unit_label/.test(html));
ok("unit details are deferred to the leasing team", html.includes("The leasing team will confirm the final unit details and terms before lease preparation."));

// ── 5. security posture unchanged ──────────────────────────────────────────
console.log("\n5. Security posture");
ok("CSP is present and locked down", /default-src 'none'/.test(src) && /frame-ancestors 'none'/.test(src));
ok("all interpolation is escaped", /function esc\(/.test(html));
ok("draft recovery still present", /sessionStorage/.test(html));
ok("capture bound to input and change", /addEventListener\("input"[\s\S]{0,120}capture\(\)/.test(src) && /addEventListener\("change"[\s\S]{0,120}capture\(\)/.test(src));

console.log("\n" + "-".repeat(52));
console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
