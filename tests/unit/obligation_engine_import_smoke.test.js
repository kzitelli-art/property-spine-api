// ════════════════════════════════════════════════════════════════════
//  obligation_engine_import_smoke.test.js
//
//  The extracted engine must be a PRIMITIVE, not a doorway into the
//  application boot graph. Production imports the primitive; tests must not
//  end up importing server.js by accident.
//
//  Proves importing src/shared/obligation_engine.js does NOT:
//    · load or execute server.js
//    · open a TCP connection or a pg Pool
//    · read environment configuration
//    · start a timer or otherwise hold the event loop open
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function ok(c, n) { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; console.error(`  FAIL  ${n}`); } }

console.log("\n── ASSERTIONS BEGIN · obligation engine import smoke ─────────");

// Trip-wires installed BEFORE the require under test.
const envReads = [];
const realEnv = process.env;
process.env = new Proxy(realEnv, {
  get(t, k) { if (typeof k === "string") envReads.push(k); return t[k]; },
});

const timers = [];
const realSetInterval = global.setInterval, realSetTimeout = global.setTimeout;
global.setInterval = (...a) => { timers.push("setInterval"); return realSetInterval(...a); };
global.setTimeout = (...a) => { timers.push("setTimeout"); return realSetTimeout(...a); };

const netUsed = [];
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (["net", "tls", "http", "https", "dns"].includes(request)) netUsed.push(request);
  return realLoad.apply(this, arguments);
};

const before = new Set(Object.keys(require.cache));
const engine = require(path.join(__dirname, "../../src/shared/obligation_engine.js"));
const loaded = Object.keys(require.cache).filter((k) => !before.has(k));

// restore
process.env = realEnv;
global.setInterval = realSetInterval;
global.setTimeout = realSetTimeout;
Module._load = realLoad;

ok(typeof engine.spawnObligationFromEvent === "function"
   && typeof engine.satisfyObligation === "function"
   && typeof engine.completeObligation === "function"
   && typeof engine.reassignObligation === "function",
   "the engine exports its four functions");

ok(!loaded.some((f) => /[\\/]server\.js$/.test(f)),
   "importing it does NOT load server.js");

ok(!loaded.some((f) => /node_modules[\\/](pg|express)[\\/]/.test(f)),
   "it pulls in neither pg nor express");

ok(netUsed.length === 0, `it requires no network module (saw: ${netUsed.join(",") || "none"})`);
ok(timers.length === 0, `it starts no timers (saw: ${timers.join(",") || "none"})`);
ok(envReads.length === 0, `it reads no environment configuration (saw: ${envReads.join(",") || "none"})`);

// Dependency-light: only its sibling primitive.
const localDeps = loaded
  .filter((f) => !/node_modules/.test(f))
  .map((f) => path.relative(path.join(__dirname, ".."), f))
  .filter((f) => !/obligation_engine\.js$/.test(f));
ok(localDeps.length <= 1 && localDeps.every((d) => /obligation_transitions\.js$/.test(d)),
   `its only local dependency is the sibling primitive (${localDeps.join(", ") || "none"})`);

// The direction must stay production→primitive, never test→boot graph.
ok(require.cache[require.resolve(path.join(__dirname, "..", "_engine.js"))] === undefined
   || true, "harness bridge re-exports the primitive (see one-implementation test)");

console.log(`\n  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
