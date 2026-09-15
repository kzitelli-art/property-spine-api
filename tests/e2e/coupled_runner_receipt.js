#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   coupled_runner_receipt.js — CLASS 3 harness check, never product.

   The coupled browser rung runs the APP's proof through the APP's
   transport runner (tools/coupled_browser_runner.cjs). That runner is
   the thing that claims "every non-loopback host is aborted". A claim in
   a comment is not evidence, and this repository has been caught before
   by a proof that reached past the product to assert the product.

   So after the rung passes, this reads the receipt the runner actually
   wrote and asserts the transport behaved:

     · the receipt exists at all (a rung that wrote no receipt did not
       run the transport we think it ran)
     · at least one request was re-addressed to the loopback TLS front
     · EVERY host the runner allowed through was loopback — any allowed
       non-loopback origin fails here, loudly, naming it
     · the screenshots the rung claims are on disk

   It does NOT re-judge the proof's own assertions; those are the app
   proof's to make and it already exited non-zero if they failed.

   REMOVAL CONDITION: delete when the two repositories merge and the
   transport runner is no longer a cross-repository seam.

     node tests/e2e/coupled_runner_receipt.js <shots-dir>
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2];
if (!dir) { console.error("usage: coupled_runner_receipt.js <shots-dir>"); process.exit(2); }

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n        " + detail : "")); }
};

const receiptPath = path.join(dir, "coupled-runner.receipt.json");
ok("the transport runner wrote its receipt", fs.existsSync(receiptPath), receiptPath);
if (!fs.existsSync(receiptPath)) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

let r;
try { r = JSON.parse(fs.readFileSync(receiptPath, "utf8")); }
catch (e) { ok("the receipt is readable JSON", false, String(e)); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const stats = r.stats || {};
ok("the receipt names the origin it re-addressed and the loopback front it used",
  typeof r.api_origin_routed === "string" && /127\.0\.0\.1/.test(String(r.tls_front || "")),
  JSON.stringify({ origin: r.api_origin_routed, front: r.tls_front }));
ok("at least one request was re-addressed to the loopback TLS front",
  Number(stats.routed_to_tls_front) > 0, `routed_to_tls_front=${stats.routed_to_tls_front}`);

//  The load-bearing one. `aborted` is what the runner BLOCKED, so a
//  non-loopback host appearing there is the transport working. What must
//  never happen is a non-loopback host being ALLOWED — that is counted as
//  direct_loopback, so the name has to be true.
const allowedHosts = new Set();
for (const u of stats.allowed_hosts || []) allowedHosts.add(String(u));
const nonLoopbackAllowed = [...allowedHosts].filter((h) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
ok("no non-loopback host was allowed through the transport",
  nonLoopbackAllowed.length === 0, JSON.stringify(nonLoopbackAllowed));

//  WHAT THIS WOULD MISS, stated rather than implied: the runner at the
//  pinned app commit records aborted URLs but does not yet record the
//  hosts it ALLOWED. Until it does, the check above is vacuous on an
//  empty set, so the count below is the honest fallback — it proves the
//  transport was exercised, not that nothing escaped. The API's own
//  E2E_EGRESS_LOG is the independent guard that a non-loopback request
//  leaving the proof fails the whole run; see verify_all.sh cleanup().
const recordsAllowedHosts = Array.isArray(stats.allowed_hosts);
console.log(`    · runner records allowed hosts: ${recordsAllowedHosts ? "yes" : "NO — see FOUND, NOT FIXED in the receipt"}`);
console.log(`    · routed=${stats.routed_to_tls_front} direct_loopback=${stats.direct_loopback} aborted=${(stats.aborted || []).length}`);

ok("the property-selection precondition was performed visibly",
  stats.property_selection && stats.property_selection.layer_closed === true
    && stats.property_selection.covered === false,
  JSON.stringify(stats.property_selection));

const shots = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
ok("the rung left screenshots on disk", shots.length > 0, `${shots.length} png in ${dir}`);
console.log(`    · screenshots: ${shots.sort().join(", ")}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
