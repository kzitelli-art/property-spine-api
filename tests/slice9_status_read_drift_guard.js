/* ══════════════════════════════════════════════════════════════════════════
   slice9_status_read_drift_guard.js — the corrected read surfaces stay correct.

   Pass 1 replaced hand-maintained status ladders with the canonical read
   authority in four files. Nothing stops the next edit from pasting a literal
   list straight back in — that is exactly how nine private ladders accumulated
   in the first place, each one reasonable on the day it was written.

   SCOPE IS DELIBERATELY NARROW. This guards the corrected application-read
   surfaces only. It is not a repository-wide framework, and it deliberately
   does NOT police availability.js, turn_priority.js or leasepackets.js —
   those are Pass 2, where the governing question is which fact actually holds
   a unit, not which statuses look progressed.

   Run: node tests/slice9_status_read_drift_guard.js
   ══════════════════════════════════════════════════════════════════════════ */
"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const R = require(path.join(REPO, "src/applications/application_lifecycle_read.js"));

let pass = 0, fail = 0;
const ok = (m, c, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 56 - t.length)));

// The four files Pass 1 corrected.
const GUARDED = [
  "src/identity/operator.js",
  "src/leasing/leasing_desk_loader.js",
  "src/leasing/leasing_desk.js",
  "src/leasing/leasingconversion.js",
  "src/applications/applicationSubmission.js",
];
// Explicitly NOT guarded — Pass 2 owns these.
// src/tenancy/availability.js was listed here and is now DELETED (Commit E):
// its two internal decision consumers moved to canonical availability, and the
// bare public GET /availability route it mounted had zero repository callers.
// A file that no longer exists cannot be guarded; its removal is asserted by
// slice9_route_retirement_proof.js instead.
// Pass 2 is COMPLETE. turn_priority.js was corrected in Commit G and
// leasepackets.js in Commit H, so no file remains in the "known-defective,
// owned by a later pass" set. The list stays as an empty declaration rather
// than being deleted: it is the record that the set is now empty by
// correction, not by never having existed.
const PASS_2 = [];

const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
// Strip comments so documentation naming a defect is not mistaken for the defect.
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

section("A  dead 'denied' vocabulary stays gone");
for (const f of GUARDED) {
  ok(`${f} has no 'denied' status literal`, !/'denied'/.test(code(f)),
    "the CHECK constraint forbids it; no row can hold it");
}

section("B  no hand-maintained TERMINAL array");
// A literal list of terminal codes in a status predicate is the drift.
const TERMINAL_RE = /not\s+in\s*\(\s*'(?:denied|declined|withdrawn|expired)'/i;
for (const f of GUARDED) {
  ok(`${f} builds no literal terminal exclusion`, !TERMINAL_RE.test(code(f)));
}

section("C  no UNANNOTATED hand-maintained submission / approval ladder");
// The signature of a private progression ladder: a status IN-list naming two
// or more mid-ladder states.
//
// A blanket ban would be wrong. Some lists genuinely are domain-specific and
// must NOT be mapped onto a lifecycle group — "has a signature been taken"
// resembles APPROVAL_REACHED but mapping it there would treat a merely
// approved application as signed. So the rule is not "no lists", it is "no
// UNEXPLAINED lists": every surviving one must carry the DOMAIN-SPECIFIC
// marker naming the question it answers. Silence is the defect.
const LADDER_RE = /status\s+in\s*\([^)]*'(?:lease_ready|tenant_signed|countersigned)'[^)]*'(?:lease_ready|tenant_signed|countersigned|active)'/i;
const MARKER = "DOMAIN-SPECIFIC (not a lifecycle group)";
for (const f of GUARDED) {
  const src = read(f);
  const stripped = code(f);
  const hasLadder = LADDER_RE.test(stripped);
  if (!hasLadder) { ok(`${f} carries no inline lifecycle ladder`, true); continue; }
  // Count ladders vs markers so a second, undocumented one cannot hide behind
  // the first one's annotation.
  const ladders = (stripped.match(new RegExp(LADDER_RE.source, "gi")) || []).length;
  const markers = (src.match(new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  ok(`${f} — every surviving ladder is annotated DOMAIN-SPECIFIC (${ladders} ladder(s), ${markers} marker(s))`,
    markers >= ladders, `${ladders - markers} unannotated ladder(s)`);
}

section("D  no historical approval inferred from current status alone");
// The exact defect: deciding "approved" from a set of current statuses.
const INFER_RE = /status\s+in\s*\([^)]*'approved'[^)]*\)\s*\)?\s*(?:then\s*)?'approved'/i;
for (const f of GUARDED) {
  ok(`${f} does not infer approval from a status list`, !INFER_RE.test(code(f)));
}
for (const f of ["src/identity/operator.js", "src/leasing/leasing_desk_loader.js"]) {
  ok(`${f} consumes the canonical substatus fragment`,
    /lifecycleRead\.SQL_APPLICANT_SUBSTATUS/.test(read(f)));
}

section("E  the canonical fragment answers history from milestones");
const frag = R.SQL_APPLICANT_SUBSTATUS;
ok("approval is decided by approved_at, not by a status list",
  /approved_at is not null[\s\S]{0,80}then 'approved'/.test(frag));
ok("approval is tested BEFORE terminal, so it survives withdrawal/expiry",
  frag.indexOf("approved_at is not null") < frag.indexOf("terminal_code is not null"));
ok("submission is decided by submitted_at", /submitted_at is not null/.test(frag));
ok("an explicit 'unknown' state exists", /then 'unknown'/.test(frag));
ok("the terminal literals are generated from the canonical TERMINAL group",
  R.TERMINAL.every((s) => R.TERMINAL_SQL_LITERALS.includes(`'${s}'`))
  && R.TERMINAL_SQL_LITERALS.split(",").length === R.TERMINAL.length);
ok("the fragment interpolates nothing but that generated list",
  (frag.match(/\$\{/g) || []).length === 0);
ok("and it carries no bind placeholder that could renumber a caller's params",
  !/\$\d/.test(frag));

section("F  Pass 2 files are UNTOUCHED by this pass");
// Asserting their known-defective lists are still present is the honest way to
// prove this pass did not quietly widen inventory authority.
// Files are named EXPLICITLY, not indexed. These were PASS_2[0..2] positional
// lookups, so deleting availability.js in Commit E shifted every assertion onto
// the wrong file and ran the third off the end of the array. A list whose
// meaning depends on its order is a trap the next edit springs.
ok("availability.js is DELETED — Commit E retired it, list and all",
  !fs.existsSync(path.join(REPO, "src/tenancy/availability.js")));
// CORRECTED by Commit G. turn_priority.js no longer reads application status at
// all: an application holds no space, so it cannot create an incoming-resident
// deadline. The assertion flips from "still defective" to "now corrected" —
// the guard's job is to state what is true, not to preserve a defect.
ok("turn_priority.js NO LONGER carries an application status list (Commit G)",
  !/status in \('submitted','tenant_signed','lease_ready','accepted_term_required'\)/
    .test(read("src/maintenance/turn_priority.js")));
ok("and never queries lease_applications at all",
  !/lease_applications/.test(code("src/maintenance/turn_priority.js")));
// CORRECTED by Commit H. The private list existed TWICE in this file -- the
// generate path and the issue path -- and both now use the one derived set.
ok("leasepackets.js NO LONGER carries a private status list (Commit H)",
  !/\["lease_ready", "tenant_signed", "approved"\]/
    .test(code("src/applications/leasepackets.js")));
ok("and asks the named eligibility predicate instead",
  /assessLeasePacketEligibility/.test(code("src/applications/leasepackets.js")));
ok("no file remains in the Pass 2 known-defective set", PASS_2.length === 0);
for (const f of PASS_2) {
  ok(`${f} does NOT yet consume the read authority`,
    !/application_lifecycle_read/.test(read(f)));
}

section("G  the read authority never re-declares the vocabulary");
const readSrc = code("src/applications/application_lifecycle_read.js");
ok("no local SUBMISSION_REACHED array literal",
  !/SUBMISSION_REACHED\s*=\s*\[/.test(readSrc));
ok("no local APPROVAL_REACHED array literal", !/APPROVAL_REACHED\s*=\s*\[/.test(readSrc));
ok("no local TERMINAL array literal", !/TERMINAL\s*=\s*\[/.test(readSrc));
ok("no local LADDER array literal", !/LADDER\s*=\s*\[/.test(readSrc));
ok("it requires the writer module", /require\(".\/application_lifecycle"\)/.test(readSrc));

console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
process.exit(fail === 0 ? 0 : 1);
