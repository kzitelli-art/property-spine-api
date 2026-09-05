"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const b = require("./proof_boundary");

(async () => {
  const admitted = { E2E_DATABASE_URL: "postgres://proof:fixture@127.0.0.1:5432/disposable", E2E_DISPOSABLE_POSTGRES: "1" };
  assert.equal(b.validateInputs(admitted).port, 3000);
  for (const url of ["postgres://u:p@production.example/db", "postgres://u:p@localhost/db",
    "postgres://u:p@127.0.0.1/db?host=production.example", "postgres://u:p@127.0.0.1/db?options=-csearch_path=other",
    "postgres://u:p@127.0.0.1/bad-name", "postgres://u:p@127.0.0.1/db#fragment"]) {
    assert.throws(() => b.validateInputs({ ...admitted, E2E_DATABASE_URL: url }));
  }
  for (const input of [{ E2E_DISPOSABLE_POSTGRES: "0" }, { DATABASE_URL: admitted.E2E_DATABASE_URL },
    { HARNESS_DATABASE_URL: admitted.E2E_DATABASE_URL }, { NODE_OPTIONS: "--require=ambient.js" },
    { E2E_API_BASE: "http://127.0.0.1:9999" }, { E2E_BASE_URL: "https://production.example" }]) {
    assert.throws(() => b.validateInputs({ ...admitted, ...input }));
  }
  console.log("PASS: remote/ambiguous databases, URL overrides, API mismatch and ambient operating configuration refused");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-boundary-test-"));
  const saved = { ...process.env };
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("impostor"); });
  try {
    const m = { url: "postgres://proof:fixture@127.0.0.1:5432/spine_proof_" + "a".repeat(24), nonce: "b".repeat(32), port: 3000 };
    process.env.E2E_PROOF_MANIFEST = path.join(dir, "identity.json");
    process.env.E2E_DATABASE_URL = m.url;
    Object.assign(process.env, { DATABASE_URL: "", HARNESS_DATABASE_URL: "" });
    fs.writeFileSync(process.env.E2E_PROOF_MANIFEST, JSON.stringify(m));
    process.env.E2E_EGRESS_LOG = path.join(dir, "egress.log");
    process.env.TWILIO_AUTH_TOKEN = "must-not-inherit";
    process.env.ANTHROPIC_API_KEY = "must-not-inherit";
    process.env.NODE_OPTIONS = "must-not-inherit";
    const childEnv = b.serverEnvironment();
    assert.equal(childEnv.TWILIO_AUTH_TOKEN, undefined);
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.NODE_OPTIONS, undefined);
    const fence = path.join(__dirname, "proof_fence_preload.js");
    for (const code of [
      "new (require('pg').Pool)({connectionString:'postgres://u:p@production.example/db'})",
      "require('net').connect({host:'provider.example',port:443})",
    ]) {
      const result = spawnSync(process.execPath, ["--require", fence, "-e", code], { env: childEnv, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Proof PostgreSQL client attempted an unowned target|Proof transport refused nonloopback/);
    }
    console.log("PASS: inherited credentials omitted; PostgreSQL redirection and provider egress refused before connection");
    await new Promise(resolve => server.listen(0, "::", resolve));
    const port = server.address().port;
    await assert.rejects(b.portFree(port));
    await assert.rejects(b.waitServer(`http://127.0.0.1:${port}`), /different server/);
    await assert.rejects(b.waitServer(`http://127.0.0.1:${port}`, () => false), /Owned server exited/);
    console.log("PASS: an occupied port and healthy impostor are refused; exited child is not adopted");
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith("spine-boundary-test-") && !relative.includes(path.sep));
    fs.rmSync(dir, { recursive: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
