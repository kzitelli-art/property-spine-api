#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  pg-launch.js — RUN A POSTGRESQL TOOL WITHOUT PUTTING THE CONNECTION
//  STRING IN ITS ARGUMENTS.
//
//    node pg-launch.js [--url-env NAME] <pg_dump|psql> [tool args…]
//
//  ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────
//
//      pg_dump "$DATABASE_URL"
//
//  puts the whole connection string — password included — into the process's
//  argument vector. On Linux /proc/<pid>/cmdline is world-readable by default,
//  so every user on that machine can read it for as long as the dump runs. A
//  schema dump of a real database is not a short command.
//
//  /proc/<pid>/environ is NOT world-readable — it is restricted to the process
//  owner and root. So moving the secret from argv to the environment is a real
//  reduction in exposure, not a cosmetic one. It is not zero: root, and the
//  owner's own other processes, can still read it. That is stated rather than
//  glossed, because the honest claim is "narrower", not "safe".
//
//  ── WHAT IT DOES ────────────────────────────────────────────────────
//    1. reads the connection string from the environment, never from argv
//    2. parses it with the standard URL parser (or as a libpq keyword string)
//    3. translates it into PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD
//       / PGSSLMODE and a short allow-list of other non-secret parameters
//    4. spawns the tool with ONLY the arguments it was given — no URL
//    5. deletes the connection string from the child's environment, so the
//       secret exists in exactly one place and in one shape
//    6. never prints a credential, and redacts anything URL-shaped that the
//       tool itself emits
//
//  ── AND IT WRITES NOTHING ───────────────────────────────────────────
//  There is no temporary password file, no .pgpass, no service file — so
//  there is no temporary credential material to clean up, on success, on
//  failure, or on an interrupt. The file that is never written cannot be left
//  behind. The harness asserts that no file anywhere gains the secret.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { spawn } = require("child_process");

const ALLOWED_TOOLS = new Set(["pg_dump", "psql", "pg_restore", "pg_isready"]);

function die(msg) {
  process.stderr.write(`\n  ✗ pg-launch: ${msg}\n\n`);
  process.exit(2);
}

// ── arguments ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let urlEnv = "DATABASE_URL";
while (argv.length && argv[0] === "--url-env") {
  argv.shift();
  urlEnv = argv.shift();
  if (!urlEnv) die("--url-env needs an environment variable name");
}
const tool = argv.shift();
if (!tool) die("a tool is required, e.g. `node pg-launch.js pg_dump --schema-only`");
if (!ALLOWED_TOOLS.has(tool)) die(`refusing to launch "${tool}" — allowed: ${[...ALLOWED_TOOLS].join(", ")}`);

//  A connection string must never arrive as an argument to this launcher
//  either — that would defeat the entire point.
for (const a of argv) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a) || /(^|[\s&?])password=/i.test(a)) {
    die("refusing a connection string in the tool arguments. " +
        `Set ${urlEnv} in the environment instead — arguments are world-readable in the process list.`);
  }
}

const raw = process.env[urlEnv];
if (!raw || !String(raw).trim()) die(`${urlEnv} is not set.`);

// ── parse ───────────────────────────────────────────────────────────
//
//  Two shapes are legitimate and both are supported:
//    postgresql://user:pass@host:5432/db?sslmode=require
//    host=example.com port=5432 dbname=db user=u password=p
//
//  Query parameters are honoured because libpq honours them, including the
//  `host=/var/run/postgresql` form that selects a unix socket.
const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

//  Non-secret libpq parameters worth carrying across, so a real-world URL
//  behaves the same through the launcher as it did on the command line.
const PARAM_TO_ENV = Object.freeze({
  sslmode: "PGSSLMODE",
  sslrootcert: "PGSSLROOTCERT",
  sslcert: "PGSSLCERT",
  sslkey: "PGSSLKEY",
  options: "PGOPTIONS",
  application_name: "PGAPPNAME",
  connect_timeout: "PGCONNECT_TIMEOUT",
  channel_binding: "PGCHANNELBINDING",
  target_session_attrs: "PGTARGETSESSIONATTRS",
});

//  WHATWG URL rejects `scheme://user@/db` — userinfo with an empty host. That
//  is a legitimate libpq form: an empty host selects a unix socket, and the
//  socket directory arrives as `?host=/var/run/postgresql`. Refusing it would
//  break exactly the local, credential-free case this kit runs against most.
//  So a sentinel host is substituted for parsing and discarded afterwards.
const EMPTY_HOST_SENTINEL = "pg-launch-empty-host.invalid";

function fromUrl(s) {
  let text = s, hostWasEmpty = false;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)(?=\/|\?|$)/i.exec(s);
  if (m) {
    hostWasEmpty = true;
    text = m[1] + m[2] + EMPTY_HOST_SENTINEL + s.slice(m[1].length + m[2].length);
  }

  const u = new URL(text);
  const out = {};

  // `?host=` wins over the authority, which is how a unix socket is expressed.
  const qHost = u.searchParams.get("host");
  const authorityHost = hostWasEmpty ? "" : (u.hostname ? dec(u.hostname) : "");
  const host = qHost || authorityHost;
  if (host) out.PGHOST = host;

  const qPort = u.searchParams.get("port");
  const port = u.port || qPort;
  if (port) out.PGPORT = String(port);

  const db = dec(String(u.pathname || "").replace(/^\//, ""));
  if (db) out.PGDATABASE = db;

  if (u.username) out.PGUSER = dec(u.username);
  if (u.password) out.PGPASSWORD = dec(u.password);

  for (const [param, envName] of Object.entries(PARAM_TO_ENV)) {
    const v = u.searchParams.get(param);
    if (v) out[envName] = v;
  }
  return out;
}

function fromKeywordString(s) {
  const out = {};
  const MAP = {
    host: "PGHOST", hostaddr: "PGHOSTADDR", port: "PGPORT", dbname: "PGDATABASE",
    user: "PGUSER", password: "PGPASSWORD",
  };
  //  key=value pairs, values optionally single-quoted.
  const re = /([a-z_]+)\s*=\s*('(?:[^'\\]|\\.)*'|[^\s]+)/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const k = m[1].toLowerCase();
    let v = m[2];
    if (v.startsWith("'")) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    if (MAP[k]) out[MAP[k]] = v;
    else if (PARAM_TO_ENV[k]) out[PARAM_TO_ENV[k]] = v;
  }
  return out;
}

let conn;
try {
  conn = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? fromUrl(raw.trim()) : fromKeywordString(raw.trim());
} catch (e) {
  //  The message must not quote the value back. `e.message` from URL parsing
  //  includes the input, so it is deliberately not used.
  die(`${urlEnv} could not be parsed as a PostgreSQL connection string. ` +
      "Expected postgresql://… or a libpq keyword string. The value is not shown.");
}
if (!conn.PGDATABASE && !conn.PGHOST) {
  die(`${urlEnv} did not yield a host or a database name. The value is not shown.`);
}

// ── redaction ───────────────────────────────────────────────────────
//  Everything the tool writes to stderr passes through here. With the URL out
//  of argv the tool has far less to quote back, but "far less" is not "none".
const SECRETS = [raw, conn.PGPASSWORD].filter(Boolean);
function redact(s) {
  let out = String(s == null ? "" : s);
  for (const secret of SECRETS) if (secret) out = out.split(secret).join("<redacted>");
  return out
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']*/g, "<connection string redacted>")
    .replace(/password=[^\s"']*/gi, "password=<redacted>");
}

//  If this launcher ever describes its own environment — for a diagnostic, a
//  crash report, a --describe flag added later — the secret values are removed
//  first. Kept as the single function that answers "what is safe to print".
function safeDiagnostic() {
  const shown = {};
  for (const [k, v] of Object.entries(conn)) {
    shown[k] = (k === "PGPASSWORD" || k === "PGSSLKEY") ? "<redacted>" : v;
  }
  return shown;
}

// ── spawn ───────────────────────────────────────────────────────────
const childEnv = Object.assign({}, process.env, conn);

//  The connection string exists in the child as PG* values and nowhere else.
//  Leaving the original variable in place would put the same secret in a
//  second shape, and a subprocess further down could pass it as an argument
//  all over again.
for (const name of ["DATABASE_URL", "TARGET_DATABASE_URL", "RESTORE_TARGET_URL",
                    "KIT_PROOF_ADMIN_URL", urlEnv]) {
  if (name) delete childEnv[name];
}

//  stdout is INHERITED, so a dump streams byte-for-byte to wherever the
//  caller redirected it. stderr is piped so it can be redacted.
const child = spawn(tool, argv, { env: childEnv, stdio: ["inherit", "inherit", "pipe"] });

let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

child.on("error", (e) => {
  if (e && e.code === "ENOENT") {
    die(`${tool} is not on PATH. Install the PostgreSQL client tools.`);
  }
  die(`could not start ${tool}: ${redact(e && e.message)}`);
});

child.on("close", (code, signal) => {
  //  The tool's own diagnostics are the useful part of a failure, so they are
  //  forwarded — redacted, never swallowed.
  if (stderrBuf) process.stderr.write(redact(stderrBuf));
  if (code !== 0 && !stderrBuf) {
    process.stderr.write(
      `  ! ${tool} exited ${code === null ? `on signal ${signal}` : code} without a message. ` +
      `Connection parameters used: ${JSON.stringify(safeDiagnostic())}\n`);
  }
  process.exit(code === null ? 1 : code);
});

//  An interrupt must reach the tool, not orphan it.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { try { child.kill(sig); } catch (_) {} });
}
