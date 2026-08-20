#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   MEETING TRANSCRIPT — STORAGE HALF, ASSERTED

   A transcript is the first evidence in Spine with NO OTHER SURFACE
   behind it. Everything Ask Spine can cite today is already visible on a
   desk the operator can open; a passage is not. So if a segment is
   wrong, nothing else in the product disagrees with it, and nobody finds
   out.

   That makes these properties load-bearing rather than nice:

     · verbatim survives — the wrong number stays wrong
     · sequence is the identity — the timestamp collides, four times in
       the real specimen
     · an unidentified speaker stays unidentified
     · a file that cannot be fully read is refused whole, so a partial
       ingest can never read as "the meeting did not discuss it"
     · every refusal is sayable to the person holding the file

   DB-free and model-free by construction: the parser is pure and the
   service is exercised against a stub client. What is under test is the
   SEAM — what gets stored, what is refused, and what the projection
   claims about evidence level.

       node tests/meeting_transcript.test.js
       node tests/meeting_transcript.test.js --file /path/to/real.txt

   The second form runs every structural assertion against a REAL
   transcript. The real Weekly Solo specimen is deliberately NOT in this
   repo: it contains a resident's health information and a compensation
   dispute, and committing it would put both in git forever for the sake
   of a fixture. The committed specimen reproduces every structural
   property of it — duplicate timestamps, an unidentified speaker,
   consecutive turns from one person, a multi-line turn, a suspicious
   number and a misspelling — and none of its content.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const parser = require(path.join(__dirname, "..", "src/meetings/meeting_transcript_parser.js"));
const service = require(path.join(__dirname, "..", "src/meetings/meeting_transcript_service.js"));

let pass = 0, fail = 0;
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; console.log("  FAIL  " + l + (d ? "\n        " + d : "")); }
  return c;
};

//  A refusal is expected: return it rather than throw past the test.
function refusalOf(fn) {
  try { fn(); return null; } catch (e) { return e && e.transcriptRefusal ? e : { unexpected: e }; }
}

const FIXTURE = path.join(__dirname, "fixtures", "meeting_transcript_specimen.txt");
const specimen = fs.readFileSync(FIXTURE, "utf8");

console.log("\n══ PARSE — the committed specimen ══");
const out = parser.parse(specimen);

ok("nine blocks parse", out.block_count === 9, `got ${out.block_count}`);

// ── SEQUENCE IS THE IDENTITY ────────────────────────────────────────
ok("sequence is 1-based and contiguous",
  out.segments.every((s, i) => s.sequence === i + 1));

//  The reason sequence exists. In the real specimen four timestamps
//  carry two different speakers each; here 0:34 does.
const collided = out.segments.filter((s) => s.relative_timestamp === "0:34");
ok("a duplicated timestamp yields two distinct segments", collided.length === 2);
ok("the collided segments differ by sequence, not by timestamp",
  collided.length === 2 && collided[0].sequence !== collided[1].sequence
    && collided[0].raw_speaker_label !== collided[1].raw_speaker_label);
ok("the collision is counted and reported", out.duplicate_timestamp_count === 1,
  `got ${out.duplicate_timestamp_count}`);

// ── THE FIELD NAMES ARE A CONTRACT ──────────────────────────────────
//  Read by name, on purpose. A blunt identifier sweep once renamed an
//  API response key and not the app that read it; nothing threw and a
//  browser caught it days later. A rename is a contract change.
const KEYS = ["sequence", "relative_timestamp", "relative_seconds",
              "raw_speaker_label", "verbatim_text"];
ok("every segment carries exactly the contracted keys",
  out.segments.every((s) => KEYS.every((k) => k in s) && Object.keys(s).length === KEYS.length),
  JSON.stringify(Object.keys(out.segments[0])));

// ── VERBATIM MEANS VERBATIM ─────────────────────────────────────────
const quote = out.segments.find((s) => s.verbatim_text.includes("412. The vendor"));
ok("a suspicious amount is preserved exactly, not normalised",
  quote && quote.verbatim_text.includes("$18.40"));

const typo = out.segments.find((s) => s.raw_speaker_label === "Priya Raghunathan");
ok("a misspelling in the body is preserved, not corrected",
  typo && typo.verbatim_text.includes("vender"),
  "the fixture says 'vender'; a parser that tidies it has repaired the record");

const multi = out.segments.find((s) => s.relative_timestamp === "0:12");
ok("a multi-line turn keeps its internal newline",
  multi && multi.verbatim_text.includes("\n") && multi.verbatim_text.endsWith("Friday."));
ok("a turn carries no leading or trailing whitespace",
  out.segments.every((s) => s.verbatim_text === s.verbatim_text.trim()));

// ── SPEAKERS ARE LABELS, NOT PEOPLE ─────────────────────────────────
ok("'Unidentified Speaker' survives as a speaker label",
  out.segments.some((s) => s.raw_speaker_label === "Unidentified Speaker"));
ok("an unidentified turn is never attributed to the speaker around it",
  (() => {
    const u = out.segments.find((s) => s.raw_speaker_label === "Unidentified Speaker");
    return u && u.raw_speaker_label === "Unidentified Speaker";
  })());
ok("speaker labels are reported, sorted, without inventing any",
  out.speaker_labels.join("|") ===
    ["Dana Whitfield", "Marcus Bell", "Priya Raghunathan", "Unidentified Speaker"].sort().join("|"),
  out.speaker_labels.join("|"));

// ── CONSECUTIVE TURNS ARE NOT MERGED ────────────────────────────────
const marcus = out.segments.filter((s) => s.raw_speaker_label === "Marcus Bell");
ok("consecutive turns from one speaker stay separate", marcus.length === 3,
  `got ${marcus.length} — merging destroys the timestamp a citation needs`);

// ── DERIVED SECONDS ─────────────────────────────────────────────────
ok("relative_seconds is derived correctly", parser.toSeconds("12:30") === 750);
ok("hours are supported", parser.toSeconds("1:02:03") === 3723);
ok("an impossible seconds value is not a time", parser.toSeconds("5:75") === null);

// ── PURITY ──────────────────────────────────────────────────────────
ok("parsing is deterministic — same bytes, same references",
  JSON.stringify(parser.parse(specimen)) === JSON.stringify(out));

console.log("\n══ REFUSAL — a file that cannot be fully read is refused WHOLE ══");

const cases = [
  ["an empty file", "", "empty_transcript"],
  ["prose with no timed blocks", "We talked about the elevator.\nIt is fixed.", "no_recognisable_blocks"],
  //  A real Read AI export opens with exactly title + date, so that shape
  //  is now READ. A THIRD line above the first block is a format nobody
  //  has observed, and it still refuses rather than guessing.
  ["a third unexplained line above the first block",
    "Title\nThu, Aug 20, 2026\nExtra line\n\n0:03 - Robert\nMorning.",
    "content_before_first_block"],
  ["timestamps that go backwards",
    "0:03 - A\nOne.\n\n5:00 - B\nTwo.\n\n1:00 - C\nThree.", "timestamps_go_backwards"],
  ["a block with a speaker and nothing said",
    "0:03 - A\nOne.\n\n0:09 - B\n\n0:12 - C\nThree.", "empty_block"],
  ["an impossible timestamp", "0:03 - A\nOne.\n\n0:75 - B\nTwo.", "unreadable_timestamp"],
];

for (const [label, text, reason] of cases) {
  const r = refusalOf(() => parser.parse(text));
  ok(`refuses ${label} · ${reason}`, r && r.reason === reason,
    r && r.unexpected ? "threw something else: " + r.unexpected.message
                      : "got " + (r && r.reason));
}

//  Equal timestamps must NOT be refused — they are ordinary.
ok("equal consecutive timestamps are accepted, not refused",
  parser.parse("0:03 - A\nOne.\n\n0:03 - B\nTwo.").block_count === 2);

// ── A REFUSAL A USER CAN SEE IS PRODUCT COPY ────────────────────────
//  It must be sayable and must name a next step — our machinery's
//  vocabulary shown to someone holding a file is a defect, and JSON
//  always looks fine.
const receipts = cases.map(([, text]) => {
  const r = refusalOf(() => parser.parse(text));
  return (r && r.receipt) || "";
});
ok("every refusal carries a receipt", receipts.every((r) => r.length > 20));
ok("no refusal receipt leaks an internal identifier",
  receipts.every((r) => !/[a-z]+_[a-z]+/.test(r)),
  receipts.find((r) => /[a-z]+_[a-z]+/.test(r)));
ok("every refusal receipt names something to do",
  receipts.every((r) => /Choose|Export|Upload|Remove|Re-export|Enter/.test(r)),
  receipts.find((r) => !/Choose|Export|Upload|Remove|Re-export|Enter/.test(r)));

console.log("\n══ THE PROVIDER HEADER — observed, not assumed ══");
const withHeader = parser.parse(
  "Temple Properties - Weekly Update\nThu, Aug 20, 2026\n\n0:03 - A\nOne.\n");
ok("a real export's title+date header parses instead of refusing",
  withHeader.block_count === 1);
ok("the title is kept exactly as provided",
  withHeader.header.title_as_provided === "Temple Properties - Weekly Update");
ok("the provider's date string is kept verbatim",
  withHeader.header.date_as_provided === "Thu, Aug 20, 2026");
ok("and is offered as ISO for reconciliation, not substitution",
  withHeader.header.date_iso === "2026-08-20");
ok("a transcript with no header reports header:null rather than a guess",
  parser.parse("0:03 - A\nOne.").header === null);

console.log("\n══ THE MEETING DATE IS REQUIRED, AND IS NOT THE UPLOAD DATE ══");

ok("a real calendar date is accepted", service.validMeetingDate("2026-08-11") === "2026-08-11");
ok("a date that does not exist is refused", service.validMeetingDate("2026-02-31") === null);
ok("a missing date is refused rather than defaulted", service.validMeetingDate(null) === null);
ok("an empty date is refused rather than defaulted", service.validMeetingDate("") === null);
ok("a timestamp is not a meeting date", service.validMeetingDate("2026-08-11T09:00:00Z") === null);

console.log("\n══ THE PROJECTION — Tier 1 says so out loud ══");

//  A stub client. What is under test is what readSegments CLAIMS, not
//  whether Postgres can select.
const stubClient = {
  query: async () => ({ rows: [
    { id: "seg-1", sequence: 1, relative_timestamp: "5:07", relative_seconds: 307,
      raw_speaker_label: "Kandice Riley", verbatim_text: "So be $29.97 for a three-bed." },
    { id: "seg-2", sequence: 2, relative_timestamp: "6:53", relative_seconds: 413,
      raw_speaker_label: "Unidentified Speaker", verbatim_text: "Yes, yes." },
  ] }),
};

(async () => {
  const rows = await service.readSegments(stubClient, "artifact-1");

  ok("the projection carries person_id and speaker_confirmed from day one",
    rows.every((r) => "person_id" in r && "speaker_confirmed" in r),
    "absent-then-appearing fields are an API contract change later");
  ok("no transcript label is confirmed to be a person in Tier 1",
    rows.every((r) => r.person_id === null && r.speaker_confirmed === false));
  ok("a named label and an unidentified one are the SAME evidence level",
    rows[0].speaker_confirmed === rows[1].speaker_confirmed,
    "'Kandice Riley' in a transcript is not proof Spine's Kandice said it");
  ok("the projection does not repair the number it carries",
    rows[0].verbatim_text.includes("$29.97"));

  // ── OPTIONAL: THE REAL SPECIMEN ───────────────────────────────────
  const flag = process.argv.indexOf("--file");
  if (flag !== -1 && process.argv[flag + 1]) {
    const real = process.argv[flag + 1];
    console.log("\n══ REAL SPECIMEN — " + real + " ══");
    const text = fs.readFileSync(real, "utf8");
    const r = parser.parse(text);
    console.log(`  ${r.block_count} turns · ${r.speaker_labels.length} speaker labels · ` +
                `${r.duplicate_timestamp_count} timestamp collisions · ` +
                `runs to ${r.last_relative_seconds}s`);
    ok("the real transcript parses whole", r.block_count > 0);
    ok("sequence is contiguous across the real file",
      r.segments.every((s, i) => s.sequence === i + 1));
    ok("the real file's timestamp collisions are preserved as distinct turns",
      r.duplicate_timestamp_count > 0,
      "the real specimen has four; a parser reporting zero has merged or dropped turns");
    ok("'Unidentified Speaker' survives in the real file",
      r.speaker_labels.includes("Unidentified Speaker"));
    ok("no turn is empty", r.segments.every((s) => s.verbatim_text.trim().length > 0));
    ok("re-parsing the real file yields identical references",
      JSON.stringify(parser.parse(text)) === JSON.stringify(r));
  } else {
    console.log("\n  (real specimen not supplied — pass --file <path> to run against one)");
  }

  console.log(`\n  ${pass} passed · ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
