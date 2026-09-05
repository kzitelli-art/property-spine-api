"use strict";
// Loaded only by verification. Confines Node clients and identifies this server.
const boundary = require("./proof_boundary");
const m = boundary.manifest();
const pg = require("pg");
function checked(config) {
  if (!config || config.connectionString !== m.url || config.host || config.database || config.port || config.user || config.password) {
    throw new Error("Proof PostgreSQL client attempted an unowned target");
  }
  return { ...config, ssl: false, application_name: process.env.E2E_SERVER_APPLICATION_NAME || "spine_proof_client" };
}
const Pool = pg.Pool, Client = pg.Client;
Object.defineProperty(pg, "Pool", { value: class ProofPool extends Pool {
  constructor(c) {
    super(checked(c));
    this.on("connect", client => {
      client.query("show transaction_isolation").then(r => {
        if (process.env.E2E_SESSION_LOG) require("fs").appendFileSync(process.env.E2E_SESSION_LOG,
          JSON.stringify({ pid: client.processID, isolation: r.rows[0].transaction_isolation, run: m.nonce }) + "\n");
      }).catch(e => { console.error("Proof session identity failed:", e.message); process.exit(1); });
    });
  }
}, configurable: true });
pg.Client = class ProofClient extends Client { constructor(c) { super(checked(c)); } };

const net = require("net");
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let a = Array.isArray(args[0]) ? args[0] : args;
  const first = a[0];
  const options = first && typeof first === "object" ? first : { port: first, host: typeof a[1] === "string" ? a[1] : "localhost" };
  const host = options.host || options.hostname || "localhost";
  if (options.path || !["localhost", "127.0.0.1", "::1"].includes(host)) {
    require("fs").appendFileSync(process.env.E2E_EGRESS_LOG, "nonloopback connection refused\n");
    throw new Error("Proof transport refused nonloopback network access");
  }
  return originalConnect.apply(this, args);
};

const http = require("http");
const writeHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (...args) {
  this.setHeader("x-proof-run", m.nonce);
  return writeHead.apply(this, args);
};
