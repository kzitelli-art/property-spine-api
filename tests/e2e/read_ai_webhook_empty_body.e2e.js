/*  ════════════════════════════════════════════════════════════════════
    read_ai_webhook_empty_body.e2e.js — A BODILESS DELIVERY IS REFUSED
    AND RECEIPTED, NOT THROWN.

    POST /integrations/read-ai/webhook parses its own raw body. When a
    POST carries no body at all — no Content-Length, no Transfer-Encoding
    — express.raw hands the route `{}`, and the receiver's
    Buffer.from({}) threw: 500 processing_failed, and NO
    meeting_webhook_security_receipts row, so the one class of probe that
    is cheapest to send left no trace. Proven here: the bodiless delivery
    reaches the governed refusal (a refusal_status the table admits, never
    500) and is receipted with byte_length 0 and the empty-body sha256;
    the Content-Length: 0 form is pinned beside it.

    Runs against the REAL server.js the verification parent booted.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const net = require("net");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));

const API = new URL((process.env.E2E_API_BASE || "http://localhost:3000").replace(/\/+$/, ""));
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const REFUSALS = ["refused_invalid_signature", "refused_missing_signature", "refused_unknown_connection", "refused_body_too_large"];

let pass = 0, fail = 0;
const ok  = (l, d = "") => { pass++; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d = "") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
const check = (l, cond, d) => (cond ? ok(l) : bad(l, d));
const J = (v) => JSON.stringify(v);
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

//  The wire form the harness cannot produce through fetch: a POST with no
//  Content-Length and no Transfer-Encoding, written straight to the socket.
function bodilessPost(pathname) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: API.hostname, port: Number(API.port || 80) }, () => {
      sock.write(`POST ${pathname} HTTP/1.1\r\nHost: ${API.host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => { buf += d; });
    sock.on("error", reject);
    sock.on("end", () => {
      const status = Number((buf.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      const bodyText = buf.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      let body = null; try { body = JSON.parse(bodyText.replace(/^[0-9a-f]+\r\n/i, "").replace(/\r\n0\r\n\r\n$/, "")); } catch (_) {}
      resolve({ status, body, raw: buf.slice(0, 200) });
    });
  });
}

const receipts = () => one("select count(*)::int as n from meeting_webhook_security_receipts where body_sha256=$1 and byte_length=0", [EMPTY_SHA256]);

(async () => {
  const WEBHOOK = "/integrations/read-ai/webhook";

  console.log("\n── 1 · a POST with no body at all ──");
  const before = (await receipts()).n;
  const r = await bodilessPost(WEBHOOK);
  check("POST with no Content-Length and no Transfer-Encoding is not a 500", r.status !== 500 && r.status >= 400 && r.status < 600, `${r.status} ${r.raw}`);
  check("…it is a governed refusal the receipts table admits", !!(r.body && r.body.ok === false && REFUSALS.includes(r.body.status)), J(r.body));
  const after = (await receipts()).n;
  check("…and a security receipt was recorded for the empty body (byte_length 0, sha256 of nothing)", after === before + 1, `before=${before} after=${after}`);
  const last = await one("select refusal_status, byte_length, body_sha256 from meeting_webhook_security_receipts where body_sha256=$1 order by attempted_at desc limit 1", [EMPTY_SHA256]);
  check("…whose refusal_status matches the response", !!(last && r.body && last.refusal_status === r.body.status), J(last));

  console.log("\n── 2 · a POST with Content-Length: 0 is the same refusal ──");
  const resp = await fetch(`${API.origin}${WEBHOOK}`, { method: "POST", headers: { "content-length": "0" } });
  const body = await resp.json().catch(() => null);
  check("POST with an empty body → the same governed refusal, receipted", resp.status !== 500 && !!(body && body.ok === false && REFUSALS.includes(body.status)) && (await receipts()).n === after + 1, `${resp.status} ${J(body)}`);

  await pool.end();
  console.log(`\n══ read ai webhook empty body: ${pass} passed, ${fail} failed ══`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
