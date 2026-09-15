/* coupled-browser-runner.cjs — harness transport for the coupled browser
 * acceptance of the current rent-roll flow. CLASS 3 harness; never part of
 * the product. Loaded with `node --require` in front of the app's pinned
 * proof (current_rent_roll_reconciliation.browser.js), which is NOT edited.
 *
 * What it does, and only this:
 *  1. TRANSPORT. The app's sealed live loader (sign-in, session verify,
 *     property list, property choice) calls the production origin. Every
 *     request to that origin is re-addressed to the existing streaming TLS
 *     front from tools/browser_stack.js (serveTls → http://127.0.0.1:API_PORT)
 *     with route.continue({url}). continue() forwards the browser's own
 *     request — headers and body untouched — so a multipart upload is never
 *     rebuilt in Node (route.fetch was: it kept JSON and dropped the file).
 *     Loopback requests (the app's static server, the owned API the proof
 *     names in ps_api_base) continue unchanged. EVERYTHING ELSE IS ABORTED:
 *     no provider, no font CDN, no analytics, no other host.
 *  2. PROPERTY SELECTION. The combined app shows "Choose a property" after
 *     entry (z-index 3900, above Deal Setup). Before the proof opens Deal
 *     Setup it must be chosen visibly: the runner waits for the layer, asks
 *     the DOCUMENT (elementFromPoint) that the choice is visible, clicks the
 *     choice the server marked as the current session's property, waits for
 *     the layer to close, and screenshots it. A failure here throws — it is
 *     a precondition, not one of the proof's 14 assertions.
 *  3. RECEIPT. Counts of routed / direct / aborted requests and the upload's
 *     observed content-type and body size are written beside the proof's
 *     own receipt so the transport claim is evidence, not prose.
 *
 * Nothing here touches the API's CORS or authentication. The TLS front's
 * permissive CORS headers exist only at the harness layer, exactly as in the
 * other browser proofs that use serveTls. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const PROD = "https://property-spine-api.onrender.com";
const SP = process.env.SP, APP_ROOT = process.env.APP_ROOT, API = (process.env.API || "http://127.0.0.1:3111").replace(/\/$/, "");
const TLS_PORT = Number(process.env.TLS_PORT || 8443);
const OUT = process.env.SHOTS;
if (!SP || !APP_ROOT || !OUT) throw new Error("coupled-browser-runner: SP, APP_ROOT and SHOTS are required");
const apiPort = Number(new URL(API).port || 80);
const { serveTls } = require(path.join(APP_ROOT, "tools/browser_stack.js"));
const pw = require(path.join(SP, "node_modules/playwright"));

const stats = { routed_to_tls_front: 0, direct_loopback: 0, aborted: [], uploads: [], property_selection: null };
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
let tlsServer = null;

async function routeHandler(route) {
  const req = route.request(); const url = req.url();
  if (url.startsWith(PROD + "/")) {
    stats.routed_to_tls_front++;
    return route.continue({ url: url.replace(PROD, "https://127.0.0.1:" + TLS_PORT) });
  }
  if (LOOPBACK.test(url)) {
    stats.direct_loopback++;
    const ct = req.headers()["content-type"] || "";
    if (/multipart\/form-data/i.test(ct)) {
      const buf = req.postDataBuffer();
      stats.uploads.push({ url: url.replace(/^https?:\/\/[^/]+/, ""), method: req.method(), content_type: ct.replace(/boundary=.*/, "boundary=<…>"), body_bytes: buf ? buf.length : 0, carries_file_part: !!buf && /filename=/.test(buf.toString("latin1")) });
    }
    return route.continue();
  }
  stats.aborted.push(url.slice(0, 120));
  return route.abort("blockedbyclient");
}

async function selectPropertyVisibly(page) {
  const layer = page.locator("#livePropertyLayer.show");
  await layer.waitFor({ timeout: 15000 });
  const choice = page.locator("#livePropertyLayer.show .live-property-choice:has(.live-property-current)");
  await choice.first().waitFor({ timeout: 15000 });
  const seen = await page.evaluate(() => {
    const el = document.querySelector("#livePropertyLayer.show .live-property-choice");
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const title = document.getElementById("livePropertyTitle");
    return { found: true, covered: !(hit === el || el.contains(hit)), title: title ? title.innerText.trim() : null,
      name: (el.querySelector(".live-property-name") || {}).innerText || null, choices: document.querySelectorAll("#livePropertyLayer.show .live-property-choice").length };
  });
  await page.screenshot({ path: path.join(OUT, "00-choose-a-property.png"), fullPage: true });
  if (!seen.found || seen.covered) throw new Error("property selection is not visible to the document: " + JSON.stringify(seen));
  await choice.first().click();
  //  A closed layer is display:none, so ask for the class change, not visibility.
  await page.waitForFunction(() => { const l = document.getElementById("livePropertyLayer"); return !!l && !l.classList.contains("show"); }, null, { timeout: 30000 });
  stats.property_selection = Object.assign({ chosen_by: "the choice the server marked as this session's current property", layer_closed: true }, seen);
  await page.screenshot({ path: path.join(OUT, "00b-property-opened.png"), fullPage: true });
}

function wrapPage(page) {
  const origEvaluate = page.evaluate.bind(page);
  page.evaluate = async function (fn, arg) {
    if (typeof fn === "function" && /dsShow\(/.test(fn.toString()) && !stats.property_selection) await selectPropertyVisibly(page);
    return origEvaluate(fn, arg);
  };
}

const origLaunch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async function (opts = {}) {
  tlsServer = await serveTls(apiPort, TLS_PORT);
  const browser = await origLaunch(Object.assign({}, opts, { args: [...(opts.args || []), "--ignore-certificate-errors"] }));
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async function (o = {}) {
    const ctx = await origNewContext(Object.assign({}, o, { ignoreHTTPSErrors: true }));
    await ctx.route("**/*", routeHandler);
    const origNewPage = ctx.newPage.bind(ctx);
    ctx.newPage = async function () { const page = await origNewPage(); wrapPage(page); return page; };
    return ctx;
  };
  const origClose = browser.close.bind(browser);
  browser.close = async function () {
    try { await origClose(); } finally {
      if (tlsServer) await new Promise((r) => tlsServer.close(r));
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, "coupled-runner.receipt.json"), JSON.stringify({
        api_origin_routed: PROD, tls_front: "https://127.0.0.1:" + TLS_PORT + " → http://127.0.0.1:" + apiPort,
        transport: "route.continue on every allowed request; no request is rebuilt in Node", stats }, null, 2));
    }
  };
  return browser;
};
