// prove_followup_ladder.js — proof for the follow-up ladder and the send window.
//
//   node tools/prove_followup_ladder.js
//
// Class 3 (test-only). Removal condition: delete with followup_ladder.js.

const path = require("path");
const { nextFollowup, LADDER, HOUR, DAY } =
  require(path.join(__dirname, "..", "src", "leasing", "followup_ladder.js"));
const commsBoundary = require(path.join(__dirname, "..", "src", "comms", "communications_boundary.js"))({
  pool: { query: async () => ({ rows: [] }) }, sms: null,
});
const { withinSendWindow } = commsBoundary;

let pass = 0, fail = 0;
function check(name, actual, predicate, expectation) {
  const ok = predicate(actual);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      expected: ${expectation}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

const T0 = 1_800_000_000_000; // injected clock; the module never reads its own

// ── The ladder ───────────────────────────────────────────────────────────────
check("nothing sent yet → no follow-up", nextFollowup({}, T0),
  r => !r.send, "silent until we have spoken once");

check("not yet due → holds", nextFollowup({ lastOutboundAt: T0, rungsSent: 0 }, T0 + HOUR),
  r => !r.send && r.reason === "not due", "rung 1 is at +2h");

check("due → sends rung 1", nextFollowup({ lastOutboundAt: T0, rungsSent: 0 }, T0 + 2 * HOUR),
  r => r.send && r.rung === 1 && r.job === "answer_their_thing",
  "first touch answers their thing, no new pitch");

// The rung Kameron asked for: "if they dont answer, the second message has the matterport"
const rung2 = nextFollowup(
  { lastOutboundAt: T0, rungsSent: 1, askedAboutLayout: "one_bedroom" }, T0 + DAY);
check("rung 2 is the Matterport rung", rung2,
  r => r.send && r.rung === 2 && r.job === "show_the_place",
  "second message carries the 3D tour");
check("rung 2 knows which layout to send", rung2,
  r => r.layout === "one_bedroom", "layout threaded through for tour selection");

check("ladder ends, does not loop",
  nextFollowup({ lastOutboundAt: T0, rungsSent: LADDER.length }, T0 + 30 * DAY),
  r => !r.send && /finished/.test(r.reason), "no seventh message, ever");

// ── Stops are permanent ──────────────────────────────────────────────────────
for (const stopped of ["opted_out", "said_no", "leased_elsewhere", "human_owns"]) {
  check(`stop: ${stopped} ends the ladder`,
    nextFollowup({ lastOutboundAt: T0, rungsSent: 0, stopped }, T0 + 30 * DAY),
    r => !r.send, "permanent, not a pause");
}

// Both of these come from the FIRST dry run against live data, which would
// have selected an opted-out number and eight leads two-to-three weeks cold.
check("opted out never gets a rung",
  nextFollowup({ lastOutboundAt: T0, rungsSent: 0, stopped: "opted_out" }, T0 + 2 * HOUR),
  r => !r.send && /opted out/.test(r.reason),
  "the ladder must not select who the send gate would refuse");

check("a cold lead does not get a ladder STARTED on it",
  nextFollowup({ lastOutboundAt: T0, rungsSent: 0 }, T0 + 21 * DAY),
  r => !r.send && /cold/.test(r.reason),
  "rung 1 three weeks late is a robot waking up, not persistence");

check("a ladder already running is NOT killed by the cold-start rule",
  nextFollowup({ lastOutboundAt: T0, rungsSent: 2 }, T0 + 21 * DAY),
  r => r.send && r.rung === 3,
  "cold-start guards the START only; a live sequence continues");

check("a reply means we owe THEM, not a follow-up",
  nextFollowup({ lastOutboundAt: T0, lastInboundAt: T0 + HOUR, rungsSent: 0 }, T0 + 10 * DAY),
  r => !r.send && /replied/.test(r.reason), "answering an inbound is a reply, never a follow-up");

check("a booked tour is not a quiet lead",
  nextFollowup({ lastOutboundAt: T0, rungsSent: 0, tourBooked: true }, T0 + 10 * DAY),
  r => !r.send && /booked/.test(r.reason), "conversion ladder owns that, not this");

// ── The send window ──────────────────────────────────────────────────────────
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe"; // America/New_York
const at = (h) => new Date(Date.UTC(2026, 6, 27, h + 4, 0, 0)); // EDT = UTC-4

check("4am proactive send is refused", withinSendWindow(DEMO, "followup", at(4)),
  r => !r.allowed && r.reason === "outside_send_window", "quiet hours hold");
check("10pm proactive send is refused", withinSendWindow(DEMO, "followup", at(22)),
  r => !r.allowed, "21:00 is the cutoff");
check("10am proactive send is allowed", withinSendWindow(DEMO, "followup", at(10)),
  r => r.allowed, "inside the window");
check("8am boundary is open", withinSendWindow(DEMO, "followup", at(8)),
  r => r.allowed, "start hour inclusive");

// The distinction the whole guard exists for.
check("a REPLY at 4am is never held", withinSendWindow(DEMO, "agent", at(4)),
  r => r.allowed, "someone texted us; replying is not a proactive send");
check("an OTP at 4am is never held", withinSendWindow(DEMO, "sms_otp", at(4)),
  r => r.allowed, "a person locked out at 4am needs their code");

check("unknown timezone refuses a proactive send",
  withinSendWindow("00000000-0000-0000-0000-000000000000", "followup", at(10)),
  r => !r.allowed && /timezone/.test(r.reason),
  "cannot prove it is a decent hour there, so do not send");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
