// ════════════════════════════════════════════════════════════════════
//  async_route_safety.js — A REJECTED HANDLER IS A 500, NOT A DEAD PROCESS.
//
//  Express 4 calls a route handler and forgets the return value. An `async`
//  handler returns a promise; when that promise rejects — a database connect
//  refused, a ReferenceError before the first `try` — nothing catches it.
//  Under Node 22 an unhandled rejection terminates the process (the default
//  `--unhandled-rejections=throw`). The caller gets no answer, and every
//  other in-flight request dies with the process.
//
//  This was not theoretical. Two routes lost a `require` in the 2026-08-27
//  split and threw `ReferenceError` outside their try; each call took the
//  API down. Separately, 190 of 226 `await pool.connect()` calls sit outside
//  any try block, so a Neon blip converts to a crash loop on almost every
//  write route.
//
//  ── WHAT THIS DOES ───────────────────────────────────────────────────
//  The same thing `express-async-errors` does, written here so the mechanism
//  is in this repository and can be read: Express's Layer invokes the
//  handler and ignores its return value. This wraps that invocation so a
//  returned promise's rejection is handed to `next(err)` — the ordinary
//  Express error path — where the terminal handler below answers with an
//  honest JSON 500. Handlers that already try/catch are untouched; the
//  wrapper only sees what escaped them.
//
//  ── WHAT THIS DOES NOT DO ────────────────────────────────────────────
//  It does not swallow anything. The error still reaches a log with its
//  stack. It does not touch rejections outside the request path (a boot
//  hook, a background seed); those still crash loudly, which is the
//  correct outcome for code that has no caller to answer. And it is not a
//  reason to leave the 190 sites as they are — it is the floor under them.
//
//  Class 1 — permanent product primitive. Removal condition: none. If the
//  server moves to Express 5 (which awaits handlers natively) this becomes
//  a no-op and may be deleted then.
// ════════════════════════════════════════════════════════════════════
"use strict";

let installed = false;

function installAsyncRouteSafety() {
  if (installed) return;
  //  Resolve Express's own Layer so the patch lands on the prototype every
  //  Router in this process actually uses.
  const Layer = require("express/lib/router/layer");
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handle_request(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // an error handler — Express's own rule
    let out;
    try {
      out = fn(req, res, next);
    } catch (err) {
      return next(err);
    }
    if (out && typeof out.then === "function") {
      out.then(undefined, (err) => next(err));
    }
    return undefined;
  };
  Layer.prototype.handle_request.__wrapped_original = original;
  installed = true;
}

//  THE TERMINAL HANDLER. Mounted last. Answers in the repo's own receipt
//  vocabulary and never publishes a stack trace to the caller — the stack
//  goes to the log, where the person fixing it will look.
//
//  Errors that already carry an HTTP meaning keep it: body-parser's 400 for
//  malformed JSON, multer's 413, and this repo's own `httpStatus` /
//  `status` conventions. Everything else is a 500.
function terminalErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.httpStatus || err.status || err.statusCode)) || 500;
  const code = err && (err.code || err.type) || null;
  if (status >= 500) {
    console.error(`[unhandled route error] ${req.method} ${req.originalUrl}:`, err && err.stack || err);
    return res.status(500).json({
      error: "internal_error",
      receipt: "Something went wrong on the server and this request was not completed. Nothing was recorded for it. Try again; if it repeats, tell the operator what you were doing.",
    });
  }
  return res.status(status).json({
    error: code || "request_refused",
    receipt: err.publicMessage || err.receipt || err.message || "The request could not be accepted.",
  });
}

module.exports = { installAsyncRouteSafety, terminalErrorHandler };
