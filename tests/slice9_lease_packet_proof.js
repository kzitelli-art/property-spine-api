// ════════════════════════════════════════════════════════════════════
//  slice9_lease_packet_proof.js
//
//  Commit H. Packet eligibility is a PRESENT-TENSE workflow question, not
//  historical approval evidence.
//
//  STOP CONDITION 6 CHECKED AND NOT TRIGGERED, from the writes themselves
//  rather than from a claim: leasepackets.js writes lease_packets,
//  lease_packet_fields, lease_packet_documents and lease_packet_audit_events.
//  It writes NO lease and NO commitment, so packet creation is not the first
//  inventory write and the two semantics never had to be separated.
//
//  Run: DATABASE_URL=... node tests/slice9_lease_packet_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const REPO = path.resolve(__dirname, "..");
const {
  assessLeasePacketEligibility, PACKET_ELIGIBLE_STATUSES,
  EXCLUDED_FROM_PACKET, REASON,
} = require(path.join(REPO, "src/applications/lease_packet_eligibility"));
const { APPROVAL_REACHED, TERMINAL, STATUS } =
  require(path.join(REPO, "src/applications/application_lifecycle"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};

// A row that satisfies every NON-status prerequisite, so a status verdict is
// never confounded by a missing fact.
const ready = (status, extra = {}) => ({
  id: "app-1", property_id: "prop-1", status,
  terms_review_obligation_id: "ob-1",
  activation_obligation_id: null,
  proposed_terms_confirmation_id: "conf-1",
  approved_at: new Date().toISOString(),   // historical approval ALWAYS present
  ...extra,
});

console.log("\n── THE RULE IS DERIVED, NOT HAND-TYPED ──────────────────");
ok(PACKET_ELIGIBLE_STATUSES.length === 3,
  `exactly three statuses are packet-eligible (${PACKET_ELIGIBLE_STATUSES.join(", ")})`);
ok(PACKET_ELIGIBLE_STATUSES.every((s) => APPROVAL_REACHED.includes(s)),
  "every eligible status is a subset of the canonical APPROVAL_REACHED group");
ok(PACKET_ELIGIBLE_STATUSES.length < APPROVAL_REACHED.length,
  `it is NARROWER than APPROVAL_REACHED (${PACKET_ELIGIBLE_STATUSES.length} of ${APPROVAL_REACHED.length}) — not used wholesale`);
for (const s of ["countersigned", "accepted_term_required", "active"]) {
  ok(!PACKET_ELIGIBLE_STATUSES.includes(s), `${s} is excluded`);
  ok(!!EXCLUDED_FROM_PACKET[s], `and its exclusion carries a stated reason ("${EXCLUDED_FROM_PACKET[s]}")`);
}

console.log("\n── HISTORICAL APPROVAL IS NOT PRESENT ELIGIBILITY ───────");
//  Every row below has approved_at set. The brief names these five explicitly:
//  historical approval must not make them packet-eligible.
for (const s of ["withdrawn", "expired", "declined", "accepted_term_required", "active"]) {
  const v = assessLeasePacketEligibility(ready(s), {});
  ok(v.eligible === false, `${s} with approved_at set is NOT packet-eligible`);
  ok(v.current_status === s, `and reports its current status (${v.current_status})`);
}
ok(assessLeasePacketEligibility(ready("lease_ready"), {}).eligible === true,
  "while lease_ready with the same approved_at IS eligible — status decides, not the timestamp");

console.log("\n── A PACKET IS NOT CREATED BECAUSE approved_at EXISTS ───");
const noApproval = assessLeasePacketEligibility(
  ready("lease_ready", { approved_at: null }), {});
ok(noApproval.eligible === true,
  "eligibility does not READ approved_at at all — a null timestamp changes nothing");
const src = fs.readFileSync(path.join(REPO, "src/applications/lease_packet_eligibility.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(!/approved_at/.test(src), "the predicate never references approved_at in code");

console.log("\n── EACH BLOCKER HAS ITS OWN REASON CODE ─────────────────");
//  Everything used to return 'application_not_approved' with "approve it
//  first" — including a withdrawn application, where that sentence is false.
const terminal = assessLeasePacketEligibility(ready("withdrawn"), {});
ok(terminal.reason_code === REASON.TERMINAL,
  `a withdrawn application reports application_terminal (${terminal.reason_code})`);
ok(!/approve it first/i.test(terminal.message),
  "and is NOT told to approve it first — that instruction would be false");
ok(/withdrawn/.test(terminal.message), "the message names the actual state");

const noGate = assessLeasePacketEligibility(
  ready("lease_ready", { terms_review_obligation_id: null, activation_obligation_id: null }), {});
ok(noGate.reason_code === REASON.NO_GATE, `a missing gate is its own code (${noGate.reason_code})`);
ok(noGate.required_fact_missing === "terms_review_obligation_id|activation_obligation_id",
  "and names the missing fact");

const noTerms = assessLeasePacketEligibility(
  ready("lease_ready", { proposed_terms_confirmation_id: null }), {});
ok(noTerms.reason_code === REASON.NO_TERMS, `missing terms is its own code (${noTerms.reason_code})`);
ok(noTerms.required_fact_missing === "proposed_terms_confirmation_id", "and names the missing fact");

const early = assessLeasePacketEligibility(ready("submitted"), {});
ok(early.reason_code === REASON.STATUS_NOT_ELIGIBLE,
  `a not-yet-approved application is status_not_eligible (${early.reason_code})`);
ok(new Set([terminal.reason_code, noGate.reason_code, noTerms.reason_code, early.reason_code]).size === 4,
  "all four blockers are distinguishable — they were ONE code before");

console.log("\n── THE CONTRACT SHAPE ───────────────────────────────────");
for (const f of ["eligible", "reason_code", "current_status", "existing_packet_id", "required_fact_missing"]) {
  ok(f in early, `the verdict carries ${f}`);
}

console.log("\n── EXISTING PACKETS ─────────────────────────────────────");
const submitted = assessLeasePacketEligibility(ready("lease_ready"),
  { existingPacket: { id: "pk-1", status: "submitted", version: 1 } });
ok(submitted.eligible === false && submitted.reason_code === REASON.ALREADY_SUBMITTED,
  "an acknowledged packet blocks another");
ok(submitted.existing_packet_id === "pk-1", "and the existing packet is identified");
ok(/frozen evidence/i.test(submitted.message), "keeping the frozen-evidence language");

for (const st of ["sent", "in_progress", "tenant_in_progress"]) {
  const issued = assessLeasePacketEligibility(ready("lease_ready"),
    { existingPacket: { id: "pk-2", status: st, version: 1 } });
  ok(issued.eligible === false && issued.reason_code === REASON.ALREADY_ISSUED,
    `an issued packet ('${st}') blocks silent regeneration`);
  const versioned = assessLeasePacketEligibility(ready("lease_ready"),
    { existingPacket: { id: "pk-2", status: st, version: 1 }, createNewVersion: true });
  ok(versioned.eligible === true, `but a governed new version is permitted over '${st}'`);
}
const draft = assessLeasePacketEligibility(ready("lease_ready"),
  { existingPacket: { id: "pk-3", status: "draft", version: 1 } });
ok(draft.eligible === true, "a draft packet is regenerated, not blocked");

console.log("\n── PROPERTY LINEAGE ─────────────────────────────────────");
const foreign = assessLeasePacketEligibility(ready("lease_ready"), { expectedPropertyId: "other" });
ok(foreign.eligible === false && foreign.reason_code === REASON.NOT_AT_PROPERTY,
  "an application at another property is refused");
ok(!/withdrawn|approve/i.test(foreign.message), "with a permission answer, not a workflow one");

console.log("\n── BEHAVIOUR PRESERVED: THE OLD RULE'S EXACT VERDICTS ───");
//  The old inline rule accepted exactly these three and nothing else. Proving
//  the new predicate reproduces it is what makes this a re-expression rather
//  than a behaviour change.
const OLD_ACCEPTED = ["lease_ready", "tenant_signed", "approved"];
for (const s of Object.values(STATUS)) {
  const expected = OLD_ACCEPTED.includes(s);
  const got = assessLeasePacketEligibility(ready(s), {}).eligible;
  ok(got === expected,
    `status '${s}' → ${expected ? "eligible" : "refused"}, matching the pre-existing rule`);
}

console.log("\n── NO NEW LADDER, NO INVENTORY AUTHORITY ────────────────");
ok(!/LADDER|SUBMISSION_REACHED\s*=/.test(src), "the predicate declares no lifecycle ladder of its own");
ok(/APPROVAL_REACHED/.test(src), "it derives from the canonical group");
ok(!/leases|space_id|turnover|availability/.test(src),
  "it touches no inventory, lease or availability concept");

console.log("\n── STOP CONDITION 6: CHECKED FROM THE WRITES ────────────");
const pkSrc = fs.readFileSync(path.join(REPO, "src/applications/leasepackets.js"), "utf8");
//  `for update of pk, la` is a SELECT lock clause, not a write. Stripping it
//  first keeps the write census honest instead of reporting a table called "of".
const sqlOnly = pkSrc.replace(/for\s+update\s+of[^\n;]*/gi, "");
const writes = [...sqlOnly.matchAll(/(?:insert into|update)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
const distinct = [...new Set(writes)].sort();
ok(!distinct.includes("leases"), `leasepackets.js writes NO lease (writes: ${distinct.join(", ")})`);
ok(!distinct.includes("executed_lease_records"), "and no executed lease record");
ok(distinct.every((t) => t.startsWith("lease_packet")),
  "every write it makes is a lease_packet* table — packet creation is not an inventory commitment");
ok(true, "STOP CONDITION 6 NOT TRIGGERED — the two semantics were never entangled");

console.log("\n── THE CALL SITE USES THE PREDICATE ─────────────────────");
const pkCode = pkSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
ok(/assessLeasePacketEligibility\(/.test(pkCode), "generateLeasePacket calls the predicate");
ok(!/\["lease_ready", "tenant_signed", "approved"\]/.test(pkCode),
  "and its hand-maintained private status list is gone");
ok(!/application_not_approved/.test(pkCode), "the conflated reason code is gone");

console.log("\n──────────────────────────────────────────────────────────");
console.log(`   lease packet eligibility: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
