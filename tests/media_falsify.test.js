#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — MEDIA PRESERVATION FALSIFICATION

   Five protections, each deliberately removed, each proven to make the
   corresponding check go red FOR THE INTENDED REASON, each restored.

   The source files are NEVER edited. Each case loads the module source,
   applies one surgical removal in memory, and evaluates that variant —
   so a failure here cannot leave a broken file behind, and the real
   sources are byte-identical before and after.

   run:  node tests/media_falsify.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { EventEmitter } = require("events");

const SMS_PATH = path.join(__dirname, "..", "src", "comms", "sms.js");
const SMS_SRC = fs.readFileSync(SMS_PATH, "utf8");
const SMS_SHA_BEFORE = crypto.createHash("sha256").update(SMS_SRC).digest("hex");

const SID = "ACfake0000000000000000000000000000";
const TOKEN = "faketoken0000000000000000000000000";
let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

//  Compile a VARIANT of sms.js in memory. Nothing is written to disk.
function loadVariant(src) {
  const m = new Module(SMS_PATH, null);
  m.filename = SMS_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(SMS_PATH));
  m._compile(src, SMS_PATH);
  return m.exports;
}

function fakeHttps(script, seen) {
  return (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = (ms, fn) => { req.__timeoutFn = fn; };
    req.destroy = (e) => req.emit("error", e || new Error("destroyed"));
    req.end = () => {
      seen.push({ hostname: opts.hostname, headers: opts.headers || {} });
      const b = script[opts.hostname];
      if (!b) return setImmediate(() => req.emit("error", new Error("no route")));
      setImmediate(() => b({ req, cb, opts }));
    };
    return req;
  };
}
function respond(cb, { status = 200, headers = {}, chunks = [] }) {
  const res = new EventEmitter();
  res.statusCode = status; res.headers = headers;
  res.resume = () => {}; res.destroy = () => res.emit("aborted");
  cb(res);
  setImmediate(() => { for (const c of chunks) res.emit("data", c); res.emit("end"); });
}

const IMG = Buffer.from("\xff\xd8\xff\xe0falsify", "binary");
const A = "api.twilio.com", C = "mms.twiliocdn.com";
const URL_OK = `https://${A}/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`;
const HAPPY = {
  [A]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${C}/s/x.jpg` } }),
  [C]: ({ cb }) => respond(cb, { status: 200,
    headers: { "content-type": "image/jpeg", "content-length": String(IMG.length) }, chunks: [IMG] }),
};

async function run(src, script, args = {}) {
  process.env.TWILIO_ACCOUNT_SID = SID;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  const seen = [];
  const mod = loadVariant(src);
  const sms = mod({ requestFn: fakeHttps(script, seen) });
  const r = await sms.fetchMedia(Object.assign(
    { url: URL_OK, mime_type: "image/jpeg", max_bytes: 5 * 1024 * 1024 }, args));
  return { r, seen, mod, sms };
}

//  Apply exactly one removal, and REFUSE if the pattern did not match —
//  a falsification that silently changed nothing would report the
//  protection as unfalsifiable when it was simply never removed.
function breakIt(pattern, replacement, label) {
  if (!pattern.test(SMS_SRC)) throw new Error(`falsification "${label}" did not match its target`);
  return SMS_SRC.replace(pattern, replacement);
}

(async function main() {
  console.log("RELEASE 0 — MEDIA PRESERVATION FALSIFICATION\n");

  // ── 1. remove authentication ───────────────────────────────────────
  sub("1  the Authorization header is removed");
  {
    const { seen: good } = await run(SMS_SRC, HAPPY);
    ok("B1  intact: Authorization IS sent to the authenticated host",
       good[0] && typeof good[0].headers.Authorization === "string");

    const broken = breakIt(
      /if \(authed\) \{\s*headers\.Authorization = "Basic "[\s\S]*?\}\s*\n/,
      "// falsified: authentication removed\n", "remove authentication");
    const { seen: bad } = await run(broken, HAPPY);
    ok("B1b broken: NO Authorization is sent — T2 would go red",
       bad[0] && bad[0].headers.Authorization === undefined,
       JSON.stringify(bad[0] && Object.keys(bad[0].headers)));
  }

  // ── 2. remove the streaming size cap ───────────────────────────────
  sub("2  the streaming size cap is removed");
  {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const many = new Array(Math.ceil((5 * 1024 * 1024) / chunk.length) + 4).fill(chunk);
    //  no content-length, so ONLY the streaming counter can stop this
    const chunked = {
      [A]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${C}/big` } }),
      [C]: ({ cb }) => respond(cb, { status: 200, headers: { "content-type": "image/jpeg" }, chunks: many }),
    };
    const { r: good } = await run(SMS_SRC, chunked);
    ok("B2  intact: the stream is aborted at the cap", good.ok === false && good.reason === "too_large",
       JSON.stringify(good));

    const broken = breakIt(
      /if \(seen > cap\) \{[\s\S]*?\n            \}\n/,
      "// falsified: streaming cap removed\n", "remove streaming cap");
    const { r: bad } = await run(broken, chunked);
    ok("B2b broken: an OVERSIZED buffer is returned — T10 would go red",
       bad.ok === true && bad.buffer.length > 5 * 1024 * 1024,
       JSON.stringify({ ok: bad.ok, reason: bad.reason, len: bad.buffer && bad.buffer.length }));
  }

  // ── 3. ignore the actual response MIME ─────────────────────────────
  sub("3  the served MIME is no longer compared to the claim");
  {
    const png = {
      [A]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${C}/x` } }),
      [C]: ({ cb }) => respond(cb, { status: 200, headers: { "content-type": "image/png" }, chunks: [IMG] }),
    };
    const { r: good } = await run(SMS_SRC, png);
    ok("B3  intact: mime_mismatch", good.ok === false && good.reason === "mime_mismatch", JSON.stringify(good));

    const broken = breakIt(
      /if \(actual !== declared\) \{ res\.resume\(\); return \{ ok: false, reason: "mime_mismatch" \}; \}/,
      "// falsified: mime comparison removed", "ignore actual mime");
    const { r: bad } = await run(broken, png);
    ok("B3b broken: a png is accepted for a jpeg claim — T14 would go red",
       bad.ok === true && bad.mime === "image/png", JSON.stringify({ ok: bad.ok, mime: bad.mime, reason: bad.reason }));
  }

  // ── 4. forward credentials through the redirect ────────────────────
  sub("4  credentials are forwarded across the origin change");
  {
    const { seen: good } = await run(SMS_SRC, HAPPY);
    const gcdn = good.find(s => s.hostname === C);
    ok("B4  intact: the CDN request carries NO Authorization",
       gcdn && gcdn.headers.Authorization === undefined);

    const broken = breakIt(
      /const authed = target\.hostname === MEDIA_HOST_AUTHENTICATED;/,
      "const authed = true; // falsified: credentials forwarded everywhere",
      "forward credentials");
    const { seen: bad } = await run(broken, HAPPY);
    const bcdn = bad.find(s => s.hostname === C);
    ok("B4b broken: the CDN request DOES carry Authorization — T3 would go red",
       bcdn && typeof bcdn.headers.Authorization === "string",
       JSON.stringify(bcdn && Object.keys(bcdn.headers)));
  }

  // ── 5. restore the req.protocol signature fallback ─────────────────
  sub("5  the req.protocol signature fallback is restored");
  {
    const req = { headers: { "x-twilio-signature": "sig" }, originalUrl: "/communications/inbound-sms",
                  body: {}, protocol: "http", get: () => "example.onrender.com" };
    delete process.env.APP_BASE_URL;
    const { sms: goodSms } = await run(SMS_SRC, HAPPY);
    ok("B5  intact: no APP_BASE_URL → refuses", goodSms.validateWebhook(req) === false);

    //  The restored fallback reaches twilio.validateRequest with a GUESSED
    //  url. The proof is not that it returns true — a fake signature still
    //  fails — but that it stops REFUSING on the missing configuration and
    //  proceeds to judge a URL nobody signed.
    //  RETARGETED 2026-08-15. The refusal used to be inlined here. It now
    //  lives in resolveSignedOrigin(), shared with the sendSms statusCallback
    //  so the URL Twilio signs and the URL this rebuilds cannot drift apart.
    //  The falsification is unchanged in meaning: replace the refusal with a
    //  guess and prove the guess happens.
    const broken = breakIt(
      /const base = resolveSignedOrigin\("webhook validation"\);\n      if \(!base\) return false;\n      const url = base \+ req\.originalUrl;/,
      `const base = process.env.APP_BASE_URL
        ? process.env.APP_BASE_URL.replace(/\\/+$/, "")
        : \`\${req.protocol}://\${req.get("host")}\`;
      globalThis.__falsifiedGuessedUrl = base + req.originalUrl;
      const url = base + req.originalUrl;`,
      "restore protocol fallback");
    const { sms: badSms } = await run(broken, HAPPY);
    delete globalThis.__falsifiedGuessedUrl;
    badSms.validateWebhook(req);
    ok("B5b broken: it GUESSES a url from req.protocol instead of refusing — U1 would go red",
       globalThis.__falsifiedGuessedUrl === "http://example.onrender.com/communications/inbound-sms",
       String(globalThis.__falsifiedGuessedUrl));
    ok("B5c and the guessed url is http:// where Twilio signs https:// — the exact 403 trap",
       String(globalThis.__falsifiedGuessedUrl).startsWith("http://"));
    delete globalThis.__falsifiedGuessedUrl;
  }

  // ── the sources were never touched ─────────────────────────────────
  sub("the real sources are unchanged");
  {
    const after = crypto.createHash("sha256").update(fs.readFileSync(SMS_PATH, "utf8")).digest("hex");
    ok("B6  sms.js is byte-identical before and after falsification",
       after === SMS_SHA_BEFORE, `${SMS_SHA_BEFORE} → ${after}`);
  }

  console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nFALSIFY HARNESS ERROR:\n" + (e && e.stack || e)); process.exit(1); });
