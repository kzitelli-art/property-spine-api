#!/usr/bin/env node
/**
 * TENANT LEASE PAGE PROOF  —  /t/lease/:token
 *
 * The acknowledgment token travels IN THE URL. That single fact drives most of
 * what this harness checks: a page carrying a live credential in its path must
 * not leak it through a Referer header, must not sit in a shared cache, and
 * must not be framable by a third party who wants the Acknowledge click.
 *
 * It also guards the page/server contract. The page is a static file and the
 * routes live in lease_packets.js; nothing in the build fails if they drift
 * apart, so it is checked here explicitly.
 *
 * Run from the repo root:  node tenant_lease_page.test.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "lease_packets.js");
const PAGE = path.join(__dirname, "tenant_lease_packet.html");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  → " + detail : "")); }
};

for (const f of [SERVER, PAGE]) {
  if (!fs.existsSync(f)) { console.error("Missing required file: " + f); process.exit(1); }
}
const server = fs.readFileSync(SERVER, "utf8");
const page = fs.readFileSync(PAGE, "utf8");

console.log("\nTENANT LEASE PAGE PROOF");
console.log("page bytes: " + page.length + "\n");

// isolate the route so headers set elsewhere cannot create a false pass
const rStart = server.indexOf('router.get("/t/lease/:token"');
const rEnd = server.indexOf('router.get("/t/lease/:token/data"');
const route = rStart >= 0 && rEnd > rStart ? server.slice(rStart, rEnd) : "";

console.log("1. Token-in-URL protection");
ok("route located", route.length > 0);
ok("Referrer-Policy: no-referrer — the token cannot leak via Referer",
  /"Referrer-Policy":\s*"no-referrer"/.test(route));
ok("Cache-Control: no-store — proposed terms do not persist in shared caches",
  /"Cache-Control":\s*"no-store"/.test(route));
ok("X-Frame-Options: DENY — the Acknowledge click cannot be framed",
  /"X-Frame-Options":\s*"DENY"/.test(route));
ok("X-Content-Type-Options: nosniff", /"X-Content-Type-Options":\s*"nosniff"/.test(route));

console.log("\n2. Content Security Policy");
const cspBlock = /Content-Security-Policy[\s\S]{0,900}?\.join\("; "\)|"Content-Security-Policy":\s*"[^"]+"/.exec(route);
const csp = cspBlock ? cspBlock[0] : "";
ok("CSP present on the route", csp.length > 0);
ok("default-src 'none'", /default-src 'none'/.test(csp));
ok("frame-ancestors 'none'", /frame-ancestors 'none'/.test(csp));
ok("base-uri 'none'", /base-uri 'none'/.test(csp));
ok("connect-src 'self' (the page talks only to its own origin)", /connect-src 'self'/.test(csp));

// the CSP must permit precisely what the page genuinely loads
const needsGoogleFonts = /fonts\.googleapis\.com/.test(page);
const needsGstatic = /fonts\.gstatic\.com/.test(page);
const hasInlineStyle = /<style/.test(page);
const hasInlineScript = /<script(?![^>]*\bsrc=)/.test(page);
ok("CSP allows the font stylesheet the page actually requests",
  !needsGoogleFonts || /style-src[^;]*fonts\.googleapis\.com/.test(csp));
ok("CSP allows the font files the page actually requests",
  !needsGstatic || /font-src[^;]*fonts\.gstatic\.com/.test(csp));
ok("CSP allows the page's inline style block",
  !hasInlineStyle || /style-src[^;]*'unsafe-inline'/.test(csp));
ok("CSP allows the page's inline script block",
  !hasInlineScript || /script-src[^;]*'unsafe-inline'/.test(csp));

console.log("\n3. Injection surface");
ok("no inline event handlers (no nested HTML/JS context)", !/\son\w+\s*=\s*"/.test(page));
ok("esc() escapes single quote and backtick", /replace\(\/\[&<>"'`\]\/g/.test(page));
ok("interactive elements use data attributes", /data-complete=/.test(page) && /data-jump=/.test(page));
ok("handlers read values via dataset, not string-built JS",
  /dataset\.complete/.test(page) && /dataset\.jump/.test(page));

console.log("\n4. Page / server contract");
const routes = [...server.matchAll(/router\.(?:get|post)\("(\/t\/lease[^"]*)"/g)].map((m) => m[1]);
const calls = [];
if (/api\(DATA_BASE\s*\+\s*['"`]\/data/.test(page)) calls.push("/t/lease/:token/data");
if (/api\(DATA_BASE\s*\+\s*`\/fields\/\$\{[^}]+\}\/complete/.test(page)) calls.push("/t/lease/:token/fields/:field_id/complete");
if (/api\(DATA_BASE\s*\+\s*['"`]\/submit/.test(page)) calls.push("/t/lease/:token/submit");
ok("page calls three endpoints", calls.length === 3, "found " + calls.length);
calls.forEach((c) => ok("server exposes " + c, routes.includes(c)));
ok("field completion sends {value, session_id}", /body:JSON\.stringify\(\{value,\s*session_id:/.test(page));
ok("server reads req.body.value", /req\.body\?\.value/.test(server));
ok("server reads req.body.session_id", /req\.body\?\.session_id/.test(server));

console.log("\n5. Honest failure behaviour");
ok("initial load has a rejection handler", /load\(\)\.catch\(/.test(page));
ok("field completion has a rejection handler", /completeField[\s\S]{0,400}catch\s*\(/.test(page));
ok("submit has a rejection handler", /submitPacket[\s\S]{0,400}catch\s*\(/.test(page));
ok("a missing token is stated, not blank", /Lease link is missing/.test(page));
ok("a missing page file 404s loudly rather than silently", /Lease page not found/.test(route));

console.log("\n6. Script integrity");
let parses = false;
try {
  const s = page.indexOf("<script"); const b = page.indexOf(">", s) + 1;
  const e = page.indexOf("</script>", b);
  new Function(page.slice(b, e));
  parses = true;
} catch (err) { parses = false; }
ok("page script parses", parses);
ok("acknowledgment is not overstated as lease execution",
  /does <b>not<\/b> activate a lease|not activate a lease/.test(page));

console.log("\n" + "-".repeat(52));
console.log((fail === 0 ? "ALL PASS" : "FAILURES PRESENT") + `   ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
