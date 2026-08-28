/* ══════════════════════════════════════════════════════════════════════════
   slice9_lifecycle_read_authority_proof.js — PURE proof of the read authority.

   No database. classifyApplicationHistory is a pure function of one row, and
   proving it against fixtures is stronger than proving it against whatever
   rows a database happens to hold: every shape below can be constructed here,
   including the historical ones no correct writer produces any more.

   The assertion that matters most is the NEGATIVE one — that unknown is
   returned as null and never coerced into false. A fabricated `false` on
   "was this approved" is indistinguishable from a real answer at the call
   site, which is exactly how two operator surfaces came to report an approved
   application as declined.

   Run: node tests/proofs/slice9_lifecycle_read_authority_proof.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const R = require(path.join(__dirname, "..", "..", "src/applications/application_lifecycle_read.js"));
const W = require(path.join(__dirname, "..", "..", "src/applications/application_lifecycle.js"));

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));
const T = "2026-01-02T03:04:05.000Z";

section("A  the vocabulary is the writer's, not a second copy");
ok("LADDER is the SAME object as the writer's", R.LADDER === W.LADDER);
ok("SUBMISSION_REACHED is the same object", R.SUBMISSION_REACHED === W.SUBMISSION_REACHED);
ok("APPROVAL_REACHED is the same object", R.APPROVAL_REACHED === W.APPROVAL_REACHED);
ok("TERMINAL is the same object", R.TERMINAL === W.TERMINAL);
ok("STATUS is the same object", R.STATUS === W.STATUS);
// Identity, not equality: a structural copy would pass a deep-equal check and
// then drift independently. Reference identity is what makes drift impossible.

section("B  approved then withdrawn — the defect this exists for");
const approvedThenWithdrawn = R.classifyApplicationHistory({
  status: "withdrawn", submitted_at: T, approved_at: T,
  terminal_at: T, terminal_code: "withdrawn" });
ok("approval_reached is TRUE — the approval is not erased",
  approvedThenWithdrawn.approval_reached === true);
ok("submission_reached is TRUE", approvedThenWithdrawn.submission_reached === true);
ok("terminal_state is TRUE", approvedThenWithdrawn.terminal_state === true);
ok("terminal_code is withdrawn, NOT declined",
  approvedThenWithdrawn.terminal_code === "withdrawn");

section("C  approved then expired — must not vanish");
const approvedThenExpired = R.classifyApplicationHistory({
  status: "expired", submitted_at: T, approved_at: T,
  terminal_at: T, terminal_code: "expired" });
ok("approval_reached is TRUE", approvedThenExpired.approval_reached === true);
ok("terminal_code is expired", approvedThenExpired.terminal_code === "expired");
ok("terminal_state is TRUE — expired is a real terminal disposition",
  approvedThenExpired.terminal_state === true);
ok("expired is NOT an open application",
  R.isCurrentOpenApplicationStatus("expired") === false);
ok("expired IS a terminal status", R.isCurrentTerminalStatus("expired") === true);

section("D  submitted then declined");
const submittedThenDeclined = R.classifyApplicationHistory({
  status: "declined", submitted_at: T, approved_at: null,
  terminal_at: T, terminal_code: "declined" });
ok("submission_reached is TRUE", submittedThenDeclined.submission_reached === true);
ok("approval_reached is UNKNOWN, not false — declined may come from approved too",
  submittedThenDeclined.approval_reached === null);
ok("and the reason is stated", submittedThenDeclined.reason_codes.includes("terminal_without_approved_at"));
ok("terminal_state is TRUE", submittedThenDeclined.terminal_state === true);

section("E  submitted with no approval — the safe negative");
const submittedOnly = R.classifyApplicationHistory({ status: "submitted", submitted_at: T });
ok("submission_reached TRUE", submittedOnly.submission_reached === true);
ok("approval_reached is FALSE — submitted sits BELOW approval, nothing overwritten",
  submittedOnly.approval_reached === false);
ok("terminal_state FALSE", submittedOnly.terminal_state === false);

section("F  historical progressed row with approved_at NULL");
const historical = R.classifyApplicationHistory({
  status: "lease_ready", submitted_at: null, approved_at: null });
ok("approval_reached is UNKNOWN — never 'never approved'", historical.approval_reached === null);
ok("submission_reached is UNKNOWN too", historical.submission_reached === null);
ok("reason codes name both gaps",
  historical.reason_codes.includes("progressed_without_approved_at")
  && historical.reason_codes.includes("progressed_without_submitted_at"));
ok("this is NOT reported as false anywhere",
  historical.approval_reached !== false && historical.submission_reached !== false);

section("G  draft — the one place a negative is asserted");
const draft = R.classifyApplicationHistory({ status: "draft" });
ok("submission_reached FALSE", draft.submission_reached === false);
ok("approval_reached FALSE", draft.approval_reached === false);
ok("terminal_state FALSE", draft.terminal_state === false);
ok("draft is an OPEN application", R.isCurrentOpenApplicationStatus("draft") === true);

section("H  terminal row retaining earlier milestones");
const retained = R.classifyApplicationHistory({
  status: "declined", submitted_at: T, approved_at: T, terminal_at: T, terminal_code: "declined" });
ok("both milestones survive the terminal disposition",
  retained.submission_reached === true && retained.approval_reached === true);
ok("and the terminal pair is intact", retained.terminal_state === true);

section("I  malformed rows are UNKNOWN, never silently accepted");
const noTerminalMeta = R.classifyApplicationHistory({ status: "declined", submitted_at: T });
ok("terminal status with no metadata → terminal_state UNKNOWN",
  noTerminalMeta.terminal_state === null);
ok("and says why", noTerminalMeta.reason_codes.includes("terminal_code_missing_or_invalid"));

const contradicts = R.classifyApplicationHistory({
  status: "declined", terminal_at: T, terminal_code: "withdrawn" });
ok("terminal_code contradicting status → UNKNOWN", contradicts.terminal_state === null);
ok("and says why", contradicts.reason_codes.includes("terminal_code_contradicts_status"));

const noInstant = R.classifyApplicationHistory({
  status: "declined", terminal_at: null, terminal_code: "declined" });
ok("terminal code with no instant → UNKNOWN (cannot be placed in a window)",
  noInstant.terminal_state === null);
ok("and says why", noInstant.reason_codes.includes("terminal_at_missing"));

const strayMeta = R.classifyApplicationHistory({
  status: "submitted", submitted_at: T, terminal_code: "declined", terminal_at: T });
ok("NON-terminal row carrying terminal metadata → UNKNOWN, flagged as a defect",
  strayMeta.terminal_state === null
  && strayMeta.reason_codes.includes("nonterminal_carrying_terminal_metadata"));

section("J  unrecognized status is refused, not bucketed");
for (const bad of ["denied", "", null, undefined, "APPROVED", 42]) {
  const r = R.classifyApplicationHistory({ status: bad });
  const label = JSON.stringify(bad);
  ok(`${label} → all three tri-states UNKNOWN`,
    r.submission_reached === null && r.approval_reached === null && r.terminal_state === null);
}
ok("'denied' is not a known status — the DB CHECK forbids it",
  R.isKnownStatus("denied") === false);
ok("'denied' is not open", R.isCurrentOpenApplicationStatus("denied") === false);
ok("'denied' is not terminal either — unrecognized is its own answer",
  R.isCurrentTerminalStatus("denied") === false);

section("K  current-state predicates cover the whole vocabulary");
ok("accepted_term_required is OPEN (a live, occupied state)",
  R.isCurrentOpenApplicationStatus("accepted_term_required") === true);
ok("accepted_term_required has reached submission",
  R.isCurrentSubmissionReachedStatus("accepted_term_required") === true);
ok("accepted_term_required has reached approval",
  R.isCurrentApprovalReachedStatus("accepted_term_required") === true);
ok("active is OPEN", R.isCurrentOpenApplicationStatus("active") === true);
ok("active has reached approval", R.isCurrentApprovalReachedStatus("active") === true);
ok("every LADDER status is open", R.LADDER.every(R.isCurrentOpenApplicationStatus));
ok("no TERMINAL status is open", R.TERMINAL.every((s) => !R.isCurrentOpenApplicationStatus(s)));
ok("every TERMINAL status is terminal", R.TERMINAL.every(R.isCurrentTerminalStatus));
ok("open and terminal partition the known vocabulary exactly",
  [...R.LADDER, ...R.TERMINAL].every((s) =>
    R.isCurrentOpenApplicationStatus(s) !== R.isCurrentTerminalStatus(s)));

section("L  SQL support cannot carry a caller-controlled identifier");
ok("no exported SQL helper is a function taking an alias",
  Object.values(R.SQL).every((v) => typeof v === "string"));
ok("the fragments name no table alias", Object.values(R.SQL).every((v) => !v.includes(".")));
ok("status groups are exposed as ARRAYS for parameter binding",
  Array.isArray(R.STATUS_GROUP_PARAMS.terminal)
  && Array.isArray(R.STATUS_GROUP_PARAMS.approvalReached));
ok("and they are the writer's arrays, not copies",
  R.STATUS_GROUP_PARAMS.terminal === W.TERMINAL
  && R.STATUS_GROUP_PARAMS.approvalReached === W.APPROVAL_REACHED);

console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail === 0 ? 0 : 1);
