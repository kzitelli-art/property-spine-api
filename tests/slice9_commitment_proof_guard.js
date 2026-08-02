/* ══════════════════════════════════════════════════════════════════════════
   slice9_commitment_proof_guard.js — no availability state may outrank proof.

   Pass 2A removed an unconditional committed_future → successor_locked
   mapping. This guards that specific regression and the shared helper it
   depends on. Scope is the corrected commitment surfaces ONLY — it is not a
   repository-wide framework, and it deliberately does not police the legacy
   availability module, turn_priority or leasepackets, which Pass 2A/2B have
   not yet reached.
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.join(__dirname, "..");
const PC = require(path.join(REPO, "src/tenancy/position_classifier.js"));

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); } };
const src = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n── commitment proof guard ─────────────────────────────");

// THE regression: committed_future returning locked with no proof test.
const av = code("src/surfaces/availability_read.js");
const m = av.match(/availability_state === "committed_future"[\s\S]{0,400}/);
ok("availability_read still handles committed_future", !!m);
ok("it does NOT map committed_future straight to successor_locked",
  !!m && !/availability_state === "committed_future"\)\s*\n\s*return \{ state: "successor_locked"/.test(av));
ok("the committed_future branch consults future_commitment",
  !!m && /future_commitment/.test(m[0]));
ok("and can still return successor_pending from it",
  !!m && /successor_pending/.test(m[0]));

// The shared helper must remain the single definition of locked.
const pc = code("src/tenancy/position_classifier.js");
ok("classifyFutureCommitment exists and is exported",
  typeof PC.classifyFutureCommitment === "function");
ok("the successor path uses the shared helper, not its own rule",
  /successor = classifyFutureCommitment\(/.test(pc));
ok("there is exactly ONE executed/funded locked rule in the classifier",
  (pc.match(/executed_verified && [a-z.]*move_in_funds_cleared/g) || []).length === 1,
  "the rule is duplicated — extract it into isNativelyProven");
ok("both proofBasis and the commitment helper ask that one rule",
  (pc.match(/isNativelyProven\(/g) || []).length >= 3);
ok("the position carries future_commitment", /future_commitment: classifyFutureCommitment\(/.test(pc));

// dated_positions must carry it — otherwise availability is guessing again.
ok("dated_positions carries future_commitment forward",
  /future_commitment: p\.future_commitment/.test(code("src/tenancy/dated_positions.js")));

// availability_read must not re-derive commitment from leases itself.
ok("availability_read does not query leases directly",
  !/from\s+leases/i.test(av));
ok("availability_read does not read lease_applications",
  !/lease_applications/i.test(av));

// Runtime: no unlocked input may yield a locked answer.
const { marketingState } = require(path.join(REPO, "src/surfaces/availability_read.js"));
const base = { availability_state: "committed_future", successor: { state: "none", lease_id: null, proof_basis: null },
  lease: null, notice_state: "none", conflict_state: "clear" };
ok("runtime: pending/none/absent commitment never yields successor_locked",
  [{ state: "pending", locked: false }, { state: "none", locked: false }, null].every((fc) =>
    marketingState({ ...base, future_commitment: fc }, true).state !== "successor_locked"));
ok("runtime: only a locked commitment yields successor_locked",
  marketingState({ ...base, future_commitment: { state: "locked", locked: true,
    lease_id: "X", start_date: null, proof_basis: "native_verified" } }, true).state === "successor_locked");

// Proof basis must survive to the response.
ok("availability_read exposes commitment_proof_basis",
  /commitment_proof_basis:/.test(av));
ok("...and commitment_state", /commitment_state:/.test(av));

console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail === 0 ? 0 : 1);
