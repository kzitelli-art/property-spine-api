// ════════════════════════════════════════════════════════════════════
//  THE SERVED TENANT SETUP PAGE MUST PARSE, AND MUST CARRY ITS CONSENT
//
//  WHY THIS EXISTS. On 2026-08-08 the tenant setup page was found DEAD in
//  production. `/t/setup/:token` builds the whole document — markup, style
//  and script — inside one template literal, and one line read:
//
//      onclick="answerIssue(\''+d.work_order_id+'\')"
//
//  Inside a template literal `\'` is an escape that collapses to `'`, so the
//  browser received `answerIssue(''+id+'')`. That is a syntax error, and a
//  syntax error fails the ENTIRE inline script — not the one branch that
//  contained it. Nothing ran. The page sat on "Loading…" forever and no
//  tenant could complete a connection.
//
//  Nothing caught it because every check read the SOURCE, where the line
//  looks correct. The defect is created by the template literal at render
//  time. So this harness asserts on the SERVED BYTES: it makes the request
//  a browser makes and parses what comes back.
//
//  THE RULE: a page assembled by string interpolation is not verified until
//  something parses its output. Reading the source proves nothing about
//  what the browser receives.
//
//  Runs with no database and no network — the setup route is pure rendering.
//      node tests/tenant_setup_page_parses.test.js
// ════════════════════════════════════════════════════════════════════
const express = require("express");
const vm = require("vm");

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.error("  ✗ " + name + (detail ? " — " + detail : "")); }
};

const app = express();
app.use("/", require("../src/comms/tenantlink")({
  pool: { query: async () => ({ rows: [] }) },
  anthropic: null, INGEST_MODEL: "", sms: null, commBoundary: null,
  //  Construction guard only — no route exercised here calls it.
  workOrderService: { createWorkOrder: async () => ({}) },
  getAgentService: () => null,
}));
app.use("/", require("../src/identity/legal_routes_block")());

(async () => {
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = "http://127.0.0.1:" + srv.address().port;

  const html = await (await fetch(base + "/t/setup/parse-check-token")).text();

  // ── 1. THE SCRIPT THE BROWSER RECEIVES MUST PARSE ─────────────────
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  ok("the setup page serves at least one inline script", scripts.length > 0);

  scripts.forEach((src, i) => {
    let err = null;
    //  Parse only. new vm.Script compiles without executing, which is exactly
    //  the check a browser performs before running a line of it.
    try { new vm.Script(src); } catch (e) { err = e.message; }
    ok("inline script #" + (i + 1) + " parses as JavaScript", err === null, err);
  });

  // ── 2. THE CONSENT DISCLOSURE MUST BE IN THE SERVED HTML ──────────
  //  Static, not JS-injected: a carrier reviewer reading the served source
  //  must find it even if scripting never runs.
  const REQUIRED = [
    [/I agree to receive text messages/i, "an explicit agreement sentence"],
    [/message frequency varies/i, "message frequency varies"],
    [/message &amp; data rates may apply/i, "message & data rates may apply"],
    [/reply STOP to opt out/i, "Reply STOP to opt out"],
    [/HELP for help/i, "HELP for help"],
    [/href="\/legal\/sms-terms"/, "a link to the SMS terms"],
    [/href="\/legal\/privacy"/, "a link to the privacy policy"],
  ];
  REQUIRED.forEach(([re, what]) => ok("the served page states " + what, re.test(html)));

  // ── 3. CONSENT IS ACTIVE, AND THE GATE IS FAIL-CLOSED ─────────────
  ok("the consent checkbox is NOT pre-ticked in the markup",
    /id="su-consent"/.test(html) && !/id="su-consent"[^>]*\bchecked\b/.test(html));

  const gated = ["su-go", "otp-send", "otp-go", "otp-resend"];
  gated.forEach((id) => {
    const tag = (html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>')) || [""])[0];
    ok(id + " ships disabled in the markup (gate closed before JS runs)",
      /\bdisabled\b/.test(tag), tag.slice(0, 80));
  });

  // ── 4. THE LINKS IN THAT DISCLOSURE MUST RESOLVE ──────────────────
  //  A reviewer clicks these. They were 404 until 2026-08-08 because the
  //  legal module was never mounted — the file existed, the routes did not.
  for (const p of ["/legal/sms-terms", "/legal/privacy", "/legal/sms-terms.txt", "/legal/privacy.txt"]) {
    const r = await fetch(base + p);
    ok("GET " + p + " returns 200", r.status === 200, "got " + r.status);
  }
  //  Control: a path that never existed must 404, so the 200s above are real
  //  routes and not a catch-all answering everything.
  const ctrl = await fetch(base + "/legal/__never_existed__");
  ok("a never-existing /legal path still 404s (the 200s are real routes)",
    ctrl.status === 404, "got " + ctrl.status);

  srv.close();
  console.log("\nassertions passed: " + pass);
  console.log("assertions failed: " + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS DIED: " + (e && e.stack || e)); process.exit(2); });
