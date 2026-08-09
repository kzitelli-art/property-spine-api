#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GATE — EXACTLY THE EXPECTED OUTBOUND SENDERS, AND WHAT ARMS THEM

   The question this exists to keep answered: **what event can put a text
   on the wire to a resident?** It was asked before wiring a carrier to a
   line whose `outbound_policy` says `proactive`, and the answer is only
   worth having if it stays true after the next commit.

   A prose audit goes stale silently. This does not.

   ── WHAT IT ASSERTS, AND WHY EACH ONE MATTERS ───────────────────────

   S2  raw transport is reachable from ONE file. A module that calls
       sms.sendSms directly has no consent gate, no send mode, no quiet
       hours and no double-send guard.
   S3  every send site is registered with the door that fires it. A new
       unregistered site is a new way to text a resident that nobody
       decided to build.
   S5  exactly one PROACTIVE-purpose sender exists, and nothing in the
       server calls it. "Autonomous outreach is not wired" is a claim
       about the call graph, so it is checked against the call graph.
   S6  the outbound-policy trigger cannot fire on a resident send,
       because no resident-path writer sets communication_line_id.
   S7  the resident `from` number comes from properties.sms_number, NOT
       from communication_lines — so that table's policy column does not
       gate resident sending, whatever it says.
   S9  the operations reply path does not consult SMS_SEND_MODE, so
       SMS_SEND_MODE=disabled darkens resident messaging while leaving
       the technician reply path working. Release 0 Step 4 depends on
       that isolation being structural rather than remembered.

   S6 and S7 are the ones to read twice. Together they say the
   `property_facing` line row is DESCRIPTIVE, not load-bearing: setting
   its policy to `reply_only` would refuse nothing and would create a
   false belief that a control exists. If either flips, the audit's
   central claim has changed and the doc must be re-read, not patched.

   run:  node tests/gate_outbound_senders.js
   see:  docs/OUTBOUND_TRIGGER_AUDIT.md
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const BOUNDARY = "src/comms/communications_boundary.js";

/*  Files that stand in for transport in a proof harness rather than
 *  being product code. Named, not pattern-matched. */
const HARNESS = new Set(["src/shared/no076_failclosed_check.js"]);

/*  THE REGISTER. Keyed by file + purpose, never by line number — line
 *  numbers churn on every edit above them and a register that fails on
 *  formatting teaches people to update it without reading it.
 *
 *  `trigger` is the real-world event. `class` is what that event is:
 *
 *    REACTIVE   the recipient themselves just did something — sent a
 *               message, requested a code, opened their own link,
 *               submitted their own details
 *    OPERATOR   an authenticated human pressed a control
 *    PROACTIVE  the system originated it with nobody watching */
const REGISTER = [
  { file: "src/agent/agent.js", purpose: "ai_reply", cls: "REACTIVE",
    door: "POST /agent/inbound",
    trigger: "an inbound message from that person" },

  { file: "src/comms/tenantlink.js", purpose: "ai_reply", cls: "REACTIVE",
    door: "POST /communications/inbound-sms",
    trigger: "an inbound message from that resident" },
  { file: "src/comms/tenantlink.js", purpose: "work_order_update", cls: "REACTIVE",
    door: "POST /communications/inbound-sms",
    trigger: "an inbound message that the turn read as work-order intent" },
  { file: "src/comms/tenantlink.js", purpose: "otp", cls: "REACTIVE",
    door: "POST /tenant/setup/request-code",
    trigger: "the resident asked for their own sign-in code (credential)" },
  { file: "src/comms/tenantlink.js", purpose: "agent", cls: "OPERATOR",
    door: "POST /occupants/:personId/invite · POST /conversations/:id/reply · " +
          "POST /work-orders/:id/notify-status",
    trigger: "an authenticated operator invited an occupant, typed a reply, " +
             "or pressed notify-status" },

  { file: "src/applications/applicationSubmission.js", purpose: "application_link", cls: "OPERATOR",
    door: "POST /leasing/application-invitations · GET /t/application/:token",
    trigger: "an operator invited an applicant; or the applicant opened their own link" },

  { file: "src/identity/teamaccess.js", purpose: "staff_invite", cls: "OPERATOR",
    door: "POST /properties/:id/team-invites",
    trigger: "an operator invited a staff member (credential, staff recipient)" },
  { file: "src/identity/teamaccess.js", purpose: "staff_otp", cls: "REACTIVE",
    door: "POST /auth/sms/start",
    trigger: "a staff member asked for their own sign-in code (credential)" },

  { file: "src/leasing/leasinginteractions.js", purpose: 'ai_drafted ? "ai_reply" : "agent"', cls: "OPERATOR",
    door: "POST /interactions/text · POST /operator/leasing/conversations/:id/reply",
    trigger: "an operator sent a message from the Person Card. An AI-drafted body " +
             "still requires the human to send it — the flag records authorship, " +
             "not autonomy" },

  { file: "src/leasing/leasingleads.js", purpose: "leasing_first_response", cls: "REACTIVE",
    door: "POST /leasing/intake (secret-gated) · POST /demo/intake (DEMO_MODE only)",
    trigger: "a prospect submitted their own details" },

  { file: "src/maintenance/maintenance.js", purpose: "work_order_update", cls: "OPERATOR",
    door: "the four operator work-order actions — assignWork, askForPhoto, " +
          "coordinateEntry, prepareRetry",
    trigger: "an authenticated operator pressed one of the four controls" },

  { file: "src/leasing/followup_runner.js", purpose: "followup", cls: "PROACTIVE",
    door: "NONE — no server-side caller exists (S5)",
    trigger: "a human running `node tools/run_followups.js --send`. dryRun " +
             "defaults true and --send must be typed" },

  /*  Operations line. Staff recipient, never a resident: the database
   *  refuses an operations-line outbound carrying person_id. */
  { file: "src/comms/tenantlink.js", purpose: "(operations reply)", cls: "REACTIVE",
    fn: "sendOperationsReply",
    door: "POST /communications/inbound-sms",
    trigger: "an inbound message from the technician on the operations line" },
  { file: "src/maintenance/maintenance.js", purpose: "(operations reply)", cls: "OPERATOR",
    fn: "sendOperationsReply",
    door: "the four operator work-order actions",
    trigger: "an operator action whose derived send spec addresses the technician" },
];

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE  gate_outbound_senders.js");
console.log("  checks: exactly the expected outbound senders, and what arms them");
console.log("════════════════════════════════════════════════════════════════");
console.log("  ASSERTIONS STARTED\n");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, "utf8") }));
const read = (rel) => (FILES.find((f) => f.rel === rel) || { text: "" }).text;

/*  Comments describe; they do not send. Every scan below runs over
 *  code with comments stripped, because a gate that matches its own
 *  documentation is a gate that cannot fail. (gate A8 learned this by
 *  matching its own header.) */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── S1 · the scan works at all ─────────────────────────────────────
const CALL = /\b(sendPropertySms|sendOperationsReply)\s*\(\s*\{/g;
const sites = [];
for (const f of FILES) {
  if (f.rel === BOUNDARY || HARNESS.has(f.rel)) continue;
  const code = strip(f.text);
  for (const m of code.matchAll(CALL)) {
    const seg = code.slice(m.index, m.index + 400);
    const raw = ((seg.match(/purpose:\s*([^,\n]+)/) || [])[1] || "?").trim();
    /*  Unquote only a whole string literal. A first version stripped a
     *  leading and trailing quote unconditionally, which turned the
     *  ternary `ai_drafted ? "ai_reply" : "agent"` into a value ending
     *  mid-token and reported it as both unregistered and vanished —
     *  one edit, two confident wrong findings. */
    const purpose = /^"[^"]*"$/.test(raw) ? raw.slice(1, -1) : raw;
    sites.push({ rel: f.rel, fn: m[1],
      purpose: m[1] === "sendOperationsReply" ? "(operations reply)" : purpose });
  }
}
ok("S1  the send-site scan found call sites at all", sites.length > 0,
   "zero found — the scan is broken and everything below would pass vacuously");
console.log(`        ${sites.length} send site(s) outside the boundary\n`);

// ── S2 · one file may touch raw transport ──────────────────────────
const rawCallers = FILES
  .filter((f) => !HARNESS.has(f.rel) && /\bsms\.sendSms\s*\(/.test(strip(f.text)))
  .map((f) => f.rel);
ok("S2  raw transport (sms.sendSms) is reachable from the boundary alone",
   rawCallers.length === 1 && rawCallers[0] === BOUNDARY,
   "callers: " + (rawCallers.join(", ") || "none") +
   " — a direct caller has no consent gate, no send mode, no quiet hours, no double-send guard");

// ── S3/S4 · the register is exact in both directions ───────────────
const key = (s) => `${s.rel}|${s.purpose}`;
const registered = new Set(REGISTER.map((r) => `${r.file}|${r.purpose}`));
const seen = new Set(sites.map(key));

const unregistered = [...seen].filter((k) => !registered.has(k));
ok("S3  every send site is registered with the door that fires it",
   unregistered.length === 0,
   "unregistered: " + unregistered.join(", ") +
   "\n        A new send site is a new way to reach a real phone. Register it with " +
   "its door and its trigger class, or remove it.");

const vanished = [...registered].filter((k) => !seen.has(k));
ok("S4  no registered site has vanished — the register is not stale",
   vanished.length === 0,
   "registered but not found in source: " + vanished.join(", "));

// ── S5 · the one proactive originator is not wired ─────────────────
const proactive = REGISTER.filter((r) => r.cls === "PROACTIVE");
ok("S5a exactly one PROACTIVE-purpose sender exists", proactive.length === 1,
   "found: " + proactive.map((r) => `${r.file}:${r.purpose}`).join(", ") +
   " — a second autonomous originator is a product decision, not a refactor");

const RUNNER = "src/leasing/followup_runner.js";
const runnerCallers = FILES
  .filter((f) => f.rel !== RUNNER && /followup_runner|runFollowups/.test(strip(f.text)))
  .map((f) => f.rel);
const serverCalls = /followup_runner|runFollowups/.test(strip(fs.readFileSync(path.join(ROOT, "server.js"), "utf8")));
ok("S5b nothing in the server calls the follow-up runner",
   runnerCallers.length === 0 && !serverCalls,
   "callers: " + [...runnerCallers, serverCalls ? "server.js" : null].filter(Boolean).join(", ") +
   "\n        Autonomous outreach became wired. That is a product decision and this " +
   "gate is where it gets noticed.");

// ── S6 · the policy trigger cannot fire on a resident send ─────────
const lineIdWriters = FILES
  .filter((f) => /communication_line_id/.test(strip(f.text)))
  .map((f) => f.rel)
  .filter((r) => r !== BOUNDARY);
const allOps = lineIdWriters.every((r) => r.startsWith("src/technician/"));
ok("S6  only operations-line writers set comm_events.communication_line_id",
   lineIdWriters.length > 0 && allOps,
   "writers: " + lineIdWriters.join(", ") +
   "\n        guard_line_outbound_policy returns early when communication_line_id is " +
   "NULL, so it never sees a resident send. If a resident-path writer starts " +
   "setting it, the trigger begins to fire on resident messages and " +
   "docs/OUTBOUND_TRIGGER_AUDIT.md must be re-read, not patched.");

// ── S7 · the resident `from` does not come from communication_lines ─
const boundary = strip(read(BOUNDARY));
const propertyLineFn = (boundary.match(/async function propertyLine[\s\S]{0,400}?\n  \}/) || [""])[0];
ok("S7  the resident line resolves from properties.sms_number, not communication_lines",
   /from\s+properties\b/i.test(propertyLineFn) && !/communication_lines/i.test(propertyLineFn),
   "propertyLine():\n" + propertyLineFn.split("\n").map((l) => "        " + l).join("\n") +
   "\n        If this starts reading communication_lines, then that table's policy " +
   "and provider_config DO gate resident sending and the audit's conclusion inverts.");

// ── S8 · the master switch fails closed ────────────────────────────
ok("S8  SMS_SEND_MODE defaults to disabled and an unknown value fails closed",
   /SMS_SEND_MODE\s*\|\|\s*"disabled"/.test(boundary) &&
   /VALID_MODES\.includes\(m\)\s*\?\s*m\s*:\s*"disabled"/.test(boundary),
   "the one global kill switch must fail closed; a retired or mistyped mode " +
   "string must send nothing rather than behave like a live mode");

// ── S9 · resident dark, technician live — structurally ─────────────
const opsReply = (boundary.match(/async function sendOperationsReply[\s\S]*?\n  \}\n/) || [""])[0];
ok("S9  the operations reply path does not consult SMS_SEND_MODE",
   opsReply.length > 0 && !/sendMode\s*\(/.test(opsReply) && !/canSendSmsForRecord/.test(opsReply),
   "SMS_SEND_MODE=disabled must darken resident messaging while leaving the " +
   "technician reply path working — Release 0 Step 4 runs in exactly that " +
   "configuration. If this path starts reading the mode, Step 4 can no longer " +
   "be run with resident SMS off.");

// ── the inventory, printed ─────────────────────────────────────────
console.log("\n  ── WHAT CAN PUT A MESSAGE ON THE WIRE ─────────────────────────");
for (const cls of ["PROACTIVE", "OPERATOR", "REACTIVE"]) {
  const rows = REGISTER.filter((r) => r.cls === cls);
  console.log(`\n  ${cls}  (${rows.length})`);
  for (const r of rows) {
    console.log(`    ${r.file}  ${r.purpose}`);
    console.log(`      door     ${r.door}`);
    console.log(`      trigger  ${r.trigger}`);
  }
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ${fail === 0 ? "✓ PASS" : "✗ FAIL"} — ${pass} passed, ${fail} failed`);
console.log("════════════════════════════════════════════════════════════════\n");
process.exit(fail === 0 ? 0 : 1);
