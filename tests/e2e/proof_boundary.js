"use strict";

// Test infrastructure only. Never reset an existing database or adopt a server.
const fs = require("fs");
const crypto = require("crypto");
const net = require("net");

function target(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error("Invalid proof PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(u.protocol) ||
      !["127.0.0.1", "[::1]"].includes(u.hostname) || u.search || u.hash ||
      !/^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(u.pathname)) {
    throw new Error("Proof database requires literal loopback, a plain database name, and no URL options");
  }
  return u;
}

function origin(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new Error("Proof API requires one loopback HTTP origin");
  }
  return u;
}

function validateInputs(env) {
  if (env.E2E_DISPOSABLE_POSTGRES !== "1") throw new Error("A separately provisioned disposable PostgreSQL instance must be explicitly admitted");
  const db = target(env.E2E_DATABASE_URL);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid proof port");
  for (const key of ["E2E_API_BASE", "E2E_BASE_URL"]) {
    if (env[key] && Number(origin(env[key]).port || 80) !== port) throw new Error(`${key} disagrees with the owned server port`);
  }
  // An ambient operating target is not a source of defaults or credentials.
  if (env.DATABASE_URL || env.HARNESS_DATABASE_URL || env.NODE_OPTIONS) throw new Error("Unset ambient DATABASE_URL, HARNESS_DATABASE_URL and NODE_OPTIONS before verification");
  return { db, port };
}

function manifest(checkEnvironment = true) {
  const file = process.env.E2E_PROOF_MANIFEST;
  if (!file) throw new Error("Missing owned proof-run manifest");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const u = target(m.url);
  if (!/^spine_proof_[a-f0-9]{24}$/.test(u.pathname.slice(1)) || !/^[a-f0-9]{32}$/.test(m.nonce)) throw new Error("Invalid owned proof identity");
  if (checkEnvironment && process.env.E2E_DATABASE_URL !== m.url) throw new Error("Database differs from owned proof target");
  for (const name of ["DATABASE_URL", "HARNESS_DATABASE_URL"]) {
    if (checkEnvironment && process.env[name] && process.env[name] !== m.url) throw new Error(`${name} differs from owned proof target`);
  }
  return m;
}

async function assertDatabase(m = manifest()) {
  const { Client } = require("pg");
  const c = new Client({ connectionString: m.url, ssl: false });
  try {
    await c.connect();
    const r = await c.query("select nonce from proof_run_identity");
    if (r.rows.length !== 1 || r.rows[0].nonce !== m.nonce) throw new Error("Database ownership marker does not match");
  } finally { await c.end(); }
}

async function portFree(port) {
  // Attempt an exclusive bind, independent of /health and availability of ss.
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen({ port: Number(port), host: "::", ipv6Only: false, exclusive: true }, () => s.close(resolve));
  });
}

async function waitServer(base, childAlive = () => true) {
  const m = manifest();
  origin(base);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!childAlive()) throw new Error("Owned server exited before readiness");
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok && r.headers.get("x-proof-run") === m.nonce) {
        await assertDatabase(m);
        return;
      }
      if (r.ok) throw Object.assign(new Error("A different server answered the proof port"), { impostor: true });
    } catch (e) { if (e.impostor) throw e; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("Owned server readiness was not proven");
}

async function create() {
  const { db, port } = validateInputs(process.env);
  await portFree(port);
  const { Client } = require("pg");
  const admin = new URL(db); admin.pathname = "/postgres";
  const name = `spine_proof_${crypto.randomBytes(12).toString("hex")}`;
  db.pathname = `/${name}`;
  const m = { url: db.href, admin: admin.href, nonce: crypto.randomBytes(16).toString("hex"), port };
  const c = new Client({ connectionString: m.admin, ssl: false });
  await c.connect();
  try { await c.query(`CREATE DATABASE "${name}"`); } finally { await c.end(); }
  // Only a successful CREATE confers ownership. Never drop a pre-existing name.
  fs.writeFileSync(process.env.E2E_PROOF_MANIFEST, JSON.stringify(m), { mode: 0o600 });
  const owned = new Client({ connectionString: m.url, ssl: false });
  try {
    await owned.connect();
    await owned.query("create table proof_run_identity (nonce text not null)");
    await owned.query("insert into proof_run_identity values ($1)", [m.nonce]);
  } finally { await owned.end(); }
  const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const values = { E2E_DATABASE_URL: m.url, E2E_API_BASE: `http://127.0.0.1:${port}`, E2E_BASE_URL: `http://127.0.0.1:${port}`, PORT: port, E2E_SERVER_APPLICATION_NAME: `spine_proof_${m.nonce}` };
  for (const [k, v] of Object.entries(values)) console.log(`export ${k}=${quote(v)}`);
  console.error(`Owned proof database: ${db.hostname}:${db.port || 5432}/${name}`);
}

async function cleanup() {
  const file = process.env.E2E_PROOF_MANIFEST;
  if (!file || !fs.existsSync(file)) return;
  const m = manifest(false);
  // Never FORCE disconnect anyone. A leftover connection makes cleanup fail.
  await assertDatabase(m);
  const { Client } = require("pg");
  const admin = target(m.admin);
  const u = target(m.url);
  if (admin.host !== u.host || admin.pathname !== "/postgres") throw new Error("Invalid cleanup administrator target");
  const c = new Client({ connectionString: admin.href, ssl: false });
  try { await c.connect(); await c.query(`DROP DATABASE "${u.pathname.slice(1)}"`); }
  finally { await c.end(); }
  fs.unlinkSync(file);
  console.error(`Cleanup verified: dropped owned database ${u.pathname.slice(1)}`);
}

function serverEnvironment(overrides = {}) {
  const m = manifest();
  const env = {};
  for (const key of ["PATH", "HOME", "SystemRoot", "TEMP", "TMP", "LANG", "TZ",
    "E2E_PROOF_MANIFEST", "E2E_SMS_LOG", "E2E_ANTHROPIC_LOG", "E2E_EGRESS_LOG", "E2E_SESSION_LOG", "E2E_SERVER_APPLICATION_NAME"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, DATABASE_URL: m.url, E2E_DATABASE_URL: m.url, NODE_ENV: "test", ...overrides };
}
module.exports = { target, origin, validateInputs, manifest, assertDatabase, portFree, waitServer, serverEnvironment };
if (require.main === module) {
  const command = process.argv[2];
  Promise.resolve().then(() => {
    if (command === "create") return create();
    if (command === "check") return assertDatabase();
    if (command === "cleanup") return cleanup();
    if (command === "port-free") return portFree(process.argv[3]);
    if (command === "wait") return waitServer(process.argv[3], () => {
      try { process.kill(Number(process.argv[4]), 0); return true; } catch (_) { return false; }
    });
    throw new Error("Unknown proof-boundary command");
  }).catch(e => { console.error(`PROOF BOUNDARY REFUSED: ${e.message}`); process.exitCode = 1; });
}
