// ════════════════════════════════════════════════════════════════════
//  CAPTURE RECEIPT — proof.
//
//  Fable lock 4: the operator sees what changed in the RELATIONSHIP and
//  what happens next. Not "Capture created. Conversion updated.
//  Obligation inserted."
//
//  The hard part is not writing nice sentences — it is writing nice
//  sentences that still refuse to hide a gap. A receipt that reads well
//  because it omitted the missing owner is the confident-wrong this
//  product exists to refuse.
//
//  Pure module. No database, no writes.
// ════════════════════════════════════════════════════════════════════
const R = require("../src/leasing/capture_receipt");
const TO = require("../src/leasing/tour_outcome");

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const show = (title, r) => {
  console.log(`\n  ${title}`);
  console.log("  ┌──────────────────────────────────────────────────────┐");
  r.receipt.split("\n").forEach(l => console.log("  │ " + l.padEnd(52) + "│"));
  console.log("  └──────────────────────────────────────────────────────┘");
  if (r.technical) console.log(`    technical: ${r.technical}`);
};

const NOW = "2026-07-26T12:00:00Z";
const inDays = d => new Date(new Date(NOW).getTime() + d * 86400000).toISOString();

(async () => {
  console.log("CAPTURE RECEIPT — consequence, not mechanics\n");

  // ── [1] the target sentence from the ruling ───────────────────────
  const good = R.composeCaptureReceipt({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.HOT_LEAD,
    whatMattered: ["Quiet", "Price"],
    nextMoveSummary: "Follow up tomorrow with quieter one-bedroom options",
    ownerName: "Kandice", dueAt: inDays(1), now: NOW,
    ids: { tour_id: "e3a7fe5d", conversion_id: "82ceab01", obligation_id: "82f76434" },
  });
  show("[1] the ruling's own example", good);
  check(/^Tour saved/.test(good.receipt), "leads with what happened");
  check(/Hot Lead · Quiet and Price mattered\./.test(good.receipt),
        "the read and what mattered, in one line");
  check(/Kandice will follow up tomorrow/.test(good.receipt),
        "who does what, and when — in words");
  check(!/tomorrow.*tomorrow/s.test(good.receipt), "the date is never stated twice");

  // ── [2] no machinery words, anywhere ──────────────────────────────
  console.log("\n[2] the machinery never speaks");
  //  Word boundaries matter: the first version of this check matched "row"
  //  inside "tomorrow" and failed a perfectly good receipt. A test that
  //  cries wolf on correct output is worse than no test.
  const banned = /\b(conversion|obligation|rail|rung|row|inserted|projection|uuid)\b/i;
  check(!banned.test(good.receipt), "no conversion / obligation / rail / rung in the receipt");
  check(/82ceab01/.test(good.technical) && !/82ceab01/.test(good.receipt),
        "ids exist in the technical receipt, not the operator one",
        "available, not recited");

  // ── [3] IT STILL REFUSES TO HIDE A GAP ────────────────────────────
  const unowned = R.composeCaptureReceipt({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.POSSIBLE,
    whatMattered: ["Commute"],
    nextMoveSummary: "Follow up next week with a second-floor option",
    ownerUnassigned: true, now: NOW,
  });
  show("[3] nobody owns it", unowned);
  check(/Nobody owns/.test(unowned.receipt),
        "an unowned follow-up is STATED, not omitted",
        "the line most likely to rot is the line most likely to be dropped");

  // ── [4] the honest escape survives into the receipt ───────────────
  const unclear = R.composeCaptureReceipt({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.POSSIBLE,
    whatMattered: [], nothingClear: true,
    nextMoveSummary: "Check back in a few days", ownerName: "Kandice",
    dueAt: inDays(3), now: NOW,
  });
  show("[4] the agent could not read it", unclear);
  check(/nothing clear yet/i.test(unclear.receipt),
        "'nothing clear' reaches the receipt intact",
        "not silently upgraded into a signal nobody gave");

  // ── [5] a no-show is not a tour ───────────────────────────────────
  const noShow = R.composeCaptureReceipt({
    attendance: TO.ATTENDANCE.NO_SHOW,
    nextMoveSummary: "Reach out today — a no-show is not a no",
    ownerName: "Kandice", dueAt: NOW, now: NOW,
  });
  show("[5] no-show", noShow);
  check(/^No-show recorded/.test(noShow.receipt), "headline matches what happened");
  check(!/mattered/.test(noShow.receipt), "and it does not ask what mattered on a tour that never happened");

  // ── [6] English, not a comma-separated list ───────────────────────
  console.log("\n[6] it reads like a person wrote it");
  check(R.listPhrase(["Quiet"]) === "Quiet", "one thing");
  check(R.listPhrase(["Quiet", "Price"]) === "Quiet and Price", "two things");
  check(R.listPhrase(["Quiet", "Price", "Light"]) === "Quiet, Price and Light", "three things");
  check(R.whenPhrase(inDays(0), NOW) === "today", "today");
  check(R.whenPhrase(inDays(1), NOW) === "tomorrow", "tomorrow");
  check(/^[A-Z]/.test(R.whenPhrase(inDays(3), NOW)), "a weekday name inside the week",
        R.whenPhrase(inDays(3), NOW));
  check(/\w+ \d+/.test(R.whenPhrase(inDays(20), NOW)), "a real date beyond a week",
        `${R.whenPhrase(inDays(20), NOW)} — "in 20 days" is not a plan`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch(e => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; });
