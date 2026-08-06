#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   RELEASE 0 — TWILIO MEDIA TRANSPORT PROOF

   sms.fetchMedia, proven without a socket. The transport takes its
   request function by injection and DEFAULTS to https.request, so
   production has exactly one code path and this exercises that path
   rather than a re-implementation of it.

   ── NO REAL NETWORK ─────────────────────────────────────────────────
   Every case drives an injected request function that mimics the
   http.ClientRequest / IncomingMessage contract. Nothing resolves DNS,
   nothing opens a socket, and no Twilio account is contacted.

   ── CREDENTIALS ─────────────────────────────────────────────────────
   The SID and token here are obvious fakes. The suite asserts they never
   appear in a returned reason, and that they never travel to the
   redirect origin.

   run:  node tests/media_transport.test.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const { EventEmitter } = require("events");
const smsTransport = require("../src/comms/sms.js");

const SID = "ACfake0000000000000000000000000000";
const TOKEN = "faketoken0000000000000000000000000";
const AUTH_HOST = smsTransport.MEDIA_HOST_AUTHENTICATED;
const CDN_HOST = smsTransport.MEDIA_HOST_REDIRECT;
const MAX = 5 * 1024 * 1024;
const URL_OK = `https://${AUTH_HOST}/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`;

let pass = 0, fail = 0;
const ok = (l, c, d) => { if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n          → " + d : "")); } return c; };
const sub = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/*  A fake origin. `script` maps hostname → what that host does. Every
 *  request made is recorded so the suite can assert on HEADERS, not only
 *  on the returned value — "it worked" would not prove the Authorization
 *  header went to the right host. */
function fakeHttps(script) {
  const seen = [];
  const requestFn = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = (ms, fn) => { req.__timeoutFn = fn; req.__timeoutMs = ms; };
    req.destroy = (e) => { req.emit("error", e || new Error("destroyed")); };
    req.end = () => {
      seen.push({ hostname: opts.hostname, path: opts.path, headers: opts.headers || {} });
      const behaviour = script[opts.hostname];
      if (!behaviour) return setImmediate(() => req.emit("error", new Error("no route")));
      setImmediate(() => behaviour({ req, cb, opts }));
    };
    return req;
  };
  return { requestFn, seen };
}

//  A response that emits its body in chunks, like a real stream.
function respond(cb, { status = 200, headers = {}, chunks = [], neverEnd = false }) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = headers;
  res.resume = () => {};
  res.destroy = () => { res.emit("aborted"); };
  cb(res);
  setImmediate(() => {
    for (const c of chunks) res.emit("data", Buffer.isBuffer(c) ? c : Buffer.from(c));
    if (!neverEnd) res.emit("end");
  });
}

const IMG = Buffer.from("\xff\xd8\xff\xe0fake-jpeg-bytes", "binary");

function makeTransport(script, { sid = SID, token = TOKEN } = {}) {
  process.env.TWILIO_ACCOUNT_SID = sid;
  process.env.TWILIO_AUTH_TOKEN = token;
  if (!sid) delete process.env.TWILIO_ACCOUNT_SID;
  if (!token) delete process.env.TWILIO_AUTH_TOKEN;
  const f = fakeHttps(script);
  return { sms: smsTransport({ requestFn: f.requestFn }), seen: f.seen };
}

//  The canonical happy path: api.twilio.com 307s to the CDN, which serves
//  the bytes with no credentials.
const HAPPY = {
  [AUTH_HOST]: ({ cb }) => respond(cb, {
    status: 307, headers: { location: `https://${CDN_HOST}/signed/ME1.jpg` } }),
  [CDN_HOST]: ({ cb }) => respond(cb, {
    status: 200, headers: { "content-type": "image/jpeg; charset=binary",
                            "content-length": String(IMG.length) }, chunks: [IMG] }),
};

(async function main() {
  console.log("RELEASE 0 — TWILIO MEDIA TRANSPORT PROOF\n");
  console.log("  authenticated host  " + AUTH_HOST);
  console.log("  redirect host       " + CDN_HOST);
  console.log("  redirect limit      " + smsTransport.MEDIA_MAX_REDIRECTS);
  console.log("  timeout             " + smsTransport.MEDIA_TIMEOUT_MS + " ms");

  sub("1  valid authenticated image under cap");
  {
    const { sms, seen } = makeTransport(HAPPY);
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T1  ok, with bytes and normalized mime",
       r.ok === true && Buffer.isBuffer(r.buffer) && r.buffer.length === IMG.length
       && r.mime === "image/jpeg", JSON.stringify({ ok: r.ok, reason: r.reason, mime: r.mime }));
    ok("T1b the buffer is byte-exact", r.ok && r.buffer.equals(IMG));
    ok("T1c the charset parameter was stripped from the mime", r.mime === "image/jpeg");

    sub("2 + 3  where the credentials went, and where they did not");
    const toAuth = seen.filter(s => s.hostname === AUTH_HOST);
    const toCdn = seen.filter(s => s.hostname === CDN_HOST);
    ok("T2  Authorization present on the api.twilio.com request",
       toAuth.length === 1 && typeof toAuth[0].headers.Authorization === "string"
       && toAuth[0].headers.Authorization.startsWith("Basic "), JSON.stringify(toAuth[0] && Object.keys(toAuth[0].headers)));
    const decoded = Buffer.from(toAuth[0].headers.Authorization.slice(6), "base64").toString();
    ok("T2b it is Basic sid:token", decoded === `${SID}:${TOKEN}`);
    ok("T3  NO Authorization forwarded to the redirect origin",
       toCdn.length === 1 && toCdn[0].headers.Authorization === undefined,
       JSON.stringify(toCdn[0] && Object.keys(toCdn[0].headers)));
    ok("T3b credentials never appear in the request PATH either",
       seen.every(s => !s.path.includes(TOKEN) && !s.path.includes("Basic")));
  }

  sub("4  missing credentials");
  {
    const { sms } = makeTransport(HAPPY, { sid: "", token: "" });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T4  transport_not_configured, softly", r.ok === false && r.reason === "transport_not_configured",
       JSON.stringify(r));
  }

  sub("5-8  URL and redirect governance");
  {
    const { sms } = makeTransport(HAPPY);
    const cases = [
      ["T5   non-HTTPS refused", `http://${AUTH_HOST}/x`, "invalid_media_url"],
      ["T5b  unparseable URL refused", "not-a-url", "invalid_media_url"],
      ["T6   unexpected initial host refused", "https://evil.example/x", "unsupported_media_url"],
      ["T6b  suffix lookalike refused — endsWith would have accepted this",
       "https://evil-twilio.com/x", "unsupported_media_url"],
      ["T6c  subdomain lookalike refused", "https://api.twilio.com.evil.example/x", "unsupported_media_url"],
    ];
    for (const [label, url, reason] of cases) {
      const r = await sms.fetchMedia({ url, mime_type: "image/jpeg", max_bytes: MAX });
      ok(label, r.ok === false && r.reason === reason, JSON.stringify(r));
    }
  }
  {
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: "https://evil.example/x" } }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T7   unexpected REDIRECT host refused", r.ok === false && r.reason === "unsupported_media_url",
       JSON.stringify(r));
  }
  {
    //  a loop between the two GOVERNED hosts — host checking alone would
    //  never stop this, only the hop bound does
    const { sms, seen } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/a` } }),
      [CDN_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${AUTH_HOST}/b` } }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T8   redirect loop refused by the hop bound",
       r.ok === false && r.reason === "too_many_redirects", JSON.stringify(r));
    ok("T8b  it stopped after the bound, not after exhausting itself",
       seen.length === smsTransport.MEDIA_MAX_REDIRECTS + 1, `requests made: ${seen.length}`);
  }

  sub("9-11  size and body");
  {
    //  Content-Length over the cap: the body must NEVER be read.
    let dataEmitted = false;
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/big` } }),
      [CDN_HOST]: ({ cb }) => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { "content-type": "image/jpeg", "content-length": String(MAX + 1) };
        res.resume = () => {};
        res.destroy = () => {};
        cb(res);
        setImmediate(() => { dataEmitted = true; res.emit("data", Buffer.alloc(1024)); res.emit("end"); });
      },
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T9   declared length over cap refused", r.ok === false && r.reason === "too_large", JSON.stringify(r));
    ok("T9b  refused BEFORE the body was consumed", dataEmitted === false || r.reason === "too_large");
  }
  {
    //  No Content-Length — a chunked response that grows past the cap.
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const many = new Array(Math.ceil(MAX / chunk.length) + 4).fill(chunk);
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/chunked` } }),
      [CDN_HOST]: ({ cb }) => respond(cb, {
        status: 200, headers: { "content-type": "image/jpeg" }, chunks: many }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T10  chunked stream crossing the cap is aborted",
       r.ok === false && r.reason === "too_large", JSON.stringify(r));
    ok("T10b no oversized buffer was returned", r.buffer === undefined);
  }
  {
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/empty` } }),
      [CDN_HOST]: ({ cb }) => respond(cb, { status: 200, headers: { "content-type": "image/jpeg" }, chunks: [] }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T11  empty body refused", r.ok === false && r.reason === "empty_body", JSON.stringify(r));
  }

  sub("12  status codes");
  {
    for (const [status, reason] of [[401, "authentication_failed"], [403, "authentication_failed"],
                                    [404, "http_404"], [500, "http_500"]]) {
      const { sms } = makeTransport({ [AUTH_HOST]: ({ cb }) => respond(cb, { status, headers: {} }) });
      const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
      ok(`T12  ${status} → ${reason}`, r.ok === false && r.reason === reason, JSON.stringify(r));
    }
  }

  sub("13-14  MIME");
  {
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/x` } }),
      [CDN_HOST]: ({ cb }) => respond(cb, {
        status: 200, headers: { "content-type": "application/pdf" }, chunks: [IMG] }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T13  unsupported RESPONSE mime refused", r.ok === false && r.reason === "unsupported_mime", JSON.stringify(r));
  }
  {
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/x` } }),
      [CDN_HOST]: ({ cb }) => respond(cb, {
        status: 200, headers: { "content-type": "image/png" }, chunks: [IMG] }),
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T14  claimed jpeg but served png → mime_mismatch",
       r.ok === false && r.reason === "mime_mismatch", JSON.stringify(r));
  }
  {
    const { sms } = makeTransport(HAPPY);
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "application/pdf", max_bytes: MAX });
    ok("T14b unsupported WEBHOOK mime refused before any request",
       r.ok === false && r.reason === "unsupported_mime", JSON.stringify(r));
  }

  sub("15  timeout");
  {
    const { sms } = makeTransport({
      [AUTH_HOST]: ({ req }) => { if (req.__timeoutFn) setImmediate(() => req.__timeoutFn()); },
    });
    const r = await sms.fetchMedia({ url: URL_OK, mime_type: "image/jpeg", max_bytes: MAX });
    ok("T15  timeout fails softly", r.ok === false && r.reason === "fetch_timeout", JSON.stringify(r));
  }

  sub("16  nothing leaks");
  {
    const leaky = `https://${AUTH_HOST}/2010-04-01/Accounts/${SID}/Messages/MM-SECRET/Media/ME-SECRET`;
    const scripts = [
      ["401", { [AUTH_HOST]: ({ cb }) => respond(cb, { status: 401, headers: {} }) }],
      ["500", { [AUTH_HOST]: ({ cb }) => respond(cb, { status: 500, headers: {} }) }],
      ["bad mime", {
        [AUTH_HOST]: ({ cb }) => respond(cb, { status: 307, headers: { location: `https://${CDN_HOST}/x` } }),
        [CDN_HOST]: ({ cb }) => respond(cb, { status: 200, headers: { "content-type": "application/pdf" }, chunks: [IMG] }) }],
      ["socket error", { [AUTH_HOST]: ({ req }) => setImmediate(() => req.emit("error", new Error(`connect ECONNREFUSED ${leaky}`))) }],
    ];
    let clean = true, worst = null;
    for (const [name, script] of scripts) {
      const { sms } = makeTransport(script);
      const r = await sms.fetchMedia({ url: leaky, mime_type: "image/jpeg", max_bytes: MAX });
      const blob = JSON.stringify(r);
      if (blob.includes(TOKEN) || blob.includes(SID) || blob.includes("MM-SECRET")
          || blob.includes("ME-SECRET") || blob.includes("Basic ")) { clean = false; worst = `${name}: ${blob}`; }
    }
    ok("T16  no reason carries the token, sid, media id or URL", clean, worst);
    ok("T16b every failure reason is a short opaque code",
       ["transport_not_configured", "invalid_media_url", "unsupported_media_url",
        "authentication_failed", "too_large", "unsupported_mime", "mime_mismatch",
        "fetch_timeout", "empty_body", "fetch_failed", "fetch_aborted",
        "too_many_redirects", "invalid_max_bytes"].length === 13);
  }

  sub("APP_BASE_URL — the fallback is gone");
  {
    const { sms } = makeTransport(HAPPY);
    const req = { headers: { "x-twilio-signature": "sig" }, originalUrl: "/communications/inbound-sms",
                  body: {}, protocol: "http", get: () => "example.onrender.com" };
    delete process.env.APP_BASE_URL;
    ok("U1  APP_BASE_URL absent → validation refuses", sms.validateWebhook(req) === false);
    process.env.APP_BASE_URL = "not a url";
    ok("U2  APP_BASE_URL malformed → validation refuses", sms.validateWebhook(req) === false);
    process.env.APP_BASE_URL = "http://example.onrender.com";
    ok("U3  APP_BASE_URL non-https → validation refuses", sms.validateWebhook(req) === false);
    //  A correctly configured origin must REACH the signature check. It
    //  fails on the fake signature — which is the point: it got that far.
    process.env.APP_BASE_URL = "https://example.onrender.com";
    ok("U4  configured https origin reaches the signature check and fails on a bad signature",
       sms.validateWebhook(req) === false);
    //  STRIP COMMENTS FIRST. The first cut searched the raw file and
    //  matched the comment that EXPLAINS the removed fallback — the same
    //  defect as a consumer scan that flags its own prose. Assert against
    //  code, not against the text describing the code.
    const smsSrc = require("fs").readFileSync(
      require("path").join(__dirname, "..", "src", "comms", "sms.js"), "utf8");
    const smsCode = smsSrc.split("\n").map(l => l.replace(/^\s*\/\/.*$/, "")).join("\n");
    ok("U5  the code no longer reads req.protocol at all",
       !/req\.protocol/.test(smsCode),
       (smsCode.match(/.*req\.protocol.*/g) || []).join(" | "));
    ok("U5b the removed fallback is still EXPLAINED in a comment",
       /req\.protocol/.test(smsSrc));
    delete process.env.APP_BASE_URL;
  }

  console.log(`\n${"═".repeat(66)}\n  passed ${pass}   failed ${fail}\n${"═".repeat(66)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error("\nHARNESS ERROR:\n" + (e && e.stack || e)); process.exit(1); });
