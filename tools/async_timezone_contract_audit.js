#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   async_timezone_contract_audit.js — Slice 9 async-signature contract.

   Slice 9 made the property operating timezone a governed column, which turned
   three functions asynchronous:

     withinSendWindow              (communications_boundary)
     localHourAtProperty           (communications_boundary, internal)
     loadPropertyOperatingTimeZone (property_timezone)

   resolvePropertyOperatingTimeZone stayed SYNC on purpose — it is only the
   non-production env override, and it must keep returning null rather than a
   Promise, or "unconfigured" starts reading as "configured".

   A grep for "await" cannot answer this. A Promise is truthy, has no useful
   properties, and survives every boolean test — so an un-awaited call does not
   crash, it silently reports the wrong answer. That is exactly how
   tools/prove_followup_ladder.js came to report FAIL on every window check
   while looking like a working harness.

   So this audits TWO ways:

     STATIC   every call site, classified — awaited · returned-from-async ·
              deliberate Promise handling · DEFECTIVE
     RUNTIME  the exported functions are actually AsyncFunction where the
              contract says async and NOT Promise-returning where it says sync

   Exit 1 on any defect. Run: node tools/async_timezone_contract_audit.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const ASYNC_FNS = ["withinSendWindow", "localHourAtProperty", "loadPropertyOperatingTimeZone"];
const SYNC_FNS = ["resolvePropertyOperatingTimeZone"];
const ROOTS = ["src", "tools", "tests"];

let defects = [], rows = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// Classify one call site from its line and a little surrounding context.
function classify(fn, line, prevLine) {
  const t = line.trim();
  const joined = (prevLine || "") + " " + t;

  // A definition, not a call.
  if (new RegExp(`(async\\s+)?function\\s+${fn}\\s*\\(`).test(t)) {
    return { kind: /async\s+function/.test(t) ? "definition:async" : "definition:sync", ok: true };
  }
  // An export/property reference or an object-literal stub, not an invocation.
  if (new RegExp(`${fn}\\s*[,:}]`).test(t) && !new RegExp(`${fn}\\s*\\(`).test(t)) {
    return { kind: "reference", ok: true };
  }
  // A comment.
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
    return { kind: "comment", ok: true };
  }
  if (!new RegExp(`${fn}\\s*\\(`).test(t)) return null;

  if (new RegExp(`await\\s+[\\w.\\[\\]"']*${fn}\\s*\\(`).test(joined)) {
    return { kind: "awaited", ok: true };
  }
  // `return fn(...)` inside an async function is a legitimate Promise return.
  if (/^return\s/.test(t)) return { kind: "returned (Promise passes through)", ok: true };
  // Explicit Promise handling.
  if (/\.then\s*\(|Promise\.(all|allSettled|race)/.test(joined)) {
    return { kind: "explicit Promise handling", ok: true };
  }
  return { kind: "DEFECTIVE — un-awaited call", ok: false };
}

for (const root of ROOTS) {
  for (const file of walk(path.join(REPO, root))) {
    const rel = path.relative(REPO, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    // Track block-comment state. Without this the tool flags its own header —
    // a documentation line naming a function is not a call site, and a scanner
    // that cannot tell prose from code produces exactly the false confidence
    // it exists to prevent.
    const inBlock = [];
    let block = false;
    for (const line of lines) {
      const opens = (line.match(/\/\*/g) || []).length;
      const closes = (line.match(/\*\//g) || []).length;
      inBlock.push(block || opens > 0);
      block = block ? !(closes > 0) : opens > closes;
    }
    for (const fn of ASYNC_FNS) {
      lines.forEach((line, i) => {
        if (!line.includes(fn)) return;
        if (inBlock[i]) return;
        const c = classify(fn, line, lines[i - 1]);
        if (!c) return;
        rows.push({ rel, line: i + 1, fn, kind: c.kind });
        if (!c.ok) defects.push({ rel, line: i + 1, fn, text: line.trim().slice(0, 110) });
      });
    }
  }
}

// ── RUNTIME SHAPE ───────────────────────────────────────────────────
//  Static reading cannot catch a sync wrapper that now returns a Promise by
//  accident. Ask the objects themselves.
const runtime = [];
function assertShape(label, fn, wantAsync) {
  if (typeof fn !== "function") { runtime.push([label, "MISSING", false]); defects.push({ rel: label, line: 0, fn: label, text: "export missing" }); return; }
  const isAsync = fn.constructor && fn.constructor.name === "AsyncFunction";
  const ok = isAsync === wantAsync;
  runtime.push([label, isAsync ? "AsyncFunction" : "sync", ok]);
  if (!ok) defects.push({ rel: label, line: 0, fn: label,
    text: `contract says ${wantAsync ? "async" : "sync"} but runtime says ${isAsync ? "async" : "sync"}` });
}

const tz = require(path.join(REPO, "src/shared/property_timezone.js"));
assertShape("property_timezone.loadPropertyOperatingTimeZone", tz.loadPropertyOperatingTimeZone, true);
assertShape("property_timezone.resolvePropertyOperatingTimeZone", tz.resolvePropertyOperatingTimeZone, false);

const boundary = require(path.join(REPO, "src/comms/communications_boundary.js"))({
  pool: { query: async () => ({ rows: [] }) }, sms: null });
assertShape("communications_boundary.withinSendWindow", boundary.withinSendWindow, true);

// The sync override must return a VALUE, never a Promise — an unconfigured
// property has to read as null, and a Promise would read as configured.
const overrideResult = tz.resolvePropertyOperatingTimeZone("00000000-0000-0000-0000-000000000000");
const overrideOk = !(overrideResult instanceof Promise);
runtime.push(["resolvePropertyOperatingTimeZone returns a value, not a Promise",
  overrideOk ? "value" : "PROMISE", overrideOk]);
if (!overrideOk) defects.push({ rel: "property_timezone.js", line: 0,
  fn: "resolvePropertyOperatingTimeZone", text: "sync override returned a Promise" });

// ── REPORT ──────────────────────────────────────────────────────────
const byKind = {};
for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

console.log("\n══ STATIC CALL-SITE INVENTORY ══");
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${k}`);
}
console.log("\n══ INVOCATIONS (definitions/references/comments excluded) ══");
for (const r of rows.filter((r) => /awaited|DEFECTIVE|returned|explicit/.test(r.kind))) {
  console.log(`  ${r.kind.startsWith("DEFECTIVE") ? "✗" : "·"} ${r.rel}:${r.line}  ${r.fn}  [${r.kind}]`);
}
console.log("\n══ RUNTIME SHAPE ══");
for (const [l, s, ok] of runtime) console.log(`  ${ok ? "ok  " : "FAIL"}  ${l.padEnd(56)} ${s}`);

if (defects.length) {
  console.log("\n══ DEFECTS ══");
  for (const d of defects) console.log(`  ✗ ${d.rel}:${d.line}  ${d.fn}\n      ${d.text}`);
  console.log(`\n${defects.length} defective call site(s). A Promise is truthy — these do not crash, they lie.\n`);
  process.exit(1);
}
console.log(`\nZero defective call sites across ${ROOTS.join(", ")}. Async contract holds.\n`);
process.exit(0);
