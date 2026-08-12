// ════════════════════════════════════════════════════════════════════
//  meeting_transcript_parser.js — THE ONLY THING THAT READS A TRANSCRIPT
//
//  A meeting transcript arrives as a structured file, not as prose to be
//  interpreted. So this is a PARSER, and there is no model anywhere in
//  the ingest path. That is the ruling, not an optimisation: the moment a
//  model segments the record, the record is the model's reading of the
//  meeting rather than the meeting.
//
//  ── THE GRAMMAR ─────────────────────────────────────────────────────
//
//      BLOCK  := HEADER "\n" BODY
//      HEADER := ^(M:SS | H:MM:SS) " - " SPEAKER$
//      BODY   := every line until the next HEADER or end of file
//
//  Rigid header, free body. Anything that does not fit refuses the WHOLE
//  FILE — see "WHY REFUSAL IS TOTAL" below.
//
//  ── FOUR PROPERTIES OF THE REAL SPECIMEN THAT SHAPE THIS FILE ───────
//
//  MEASURED against the Weekly Solo transcript of 2026-08-11 by running
//  this parser over it: 96 turns, 4 speaker labels, 2,624 words, running
//  to 17:16. Every property below was found in that file, not imagined:
//
//  1. THE TIMESTAMP IS NOT UNIQUE. FIVE collisions in one meeting —
//     1:00, 6:41, 12:26, 15:09 and 16:14 each carry two different
//     speakers. (Counted by eye first, which found four and missed
//     15:09 — which is rather the point: a human skimming a transcript
//     under-counts exactly the thing a citation would get wrong.)
//     `sequence` is therefore the identity of a segment and the timestamp
//     is a display fact. Nothing may key, sort-tiebreak or mint a
//     reference from the timestamp.
//
//  2. THERE IS NO DATE IN THE FILE. Timestamps are relative to the start
//     of the meeting. The meeting date cannot be parsed out and must be
//     supplied by whoever uploads it — enforced by the caller and by the
//     database, not here.
//
//  3. CONSECUTIVE BLOCKS FROM ONE SPEAKER ARE ORDINARY, AND ARE NEVER
//     MERGED. 12:26 → 12:34 → 12:38 is three blocks from one person.
//     Merging is an editorial act and it destroys the timestamp
//     granularity that a citation exists to provide.
//
//  4. "Unidentified Speaker" IS A LEGITIMATE SPEAKER LABEL — twelve of
//     the 96 turns, and the interesting one sits mid-discussion
//     between two turns from the same person, where any human reader
//     would infer who it was. Spine does not infer. The label is stored
//     exactly as written and is never resolved to anyone.
//
//  ── VERBATIM MEANS VERBATIM ─────────────────────────────────────────
//
//  Nothing here corrects, normalises, spell-checks, case-folds, expands
//  or tidies anything. Not the speaker label, not the text.
//
//  The specimen contains "$29.97" where the room plainly meant $2,997,
//  "route" where they said grout, and the same colleague spelled two
//  different ways in one meeting. Every one of those is a repair that a
//  reasonable person would make and that Spine has no standing to make:
//  the transcript is demonstrably lossy in places Spine cannot locate,
//  which makes a correct repair indistinguishable from a corruption.
//
//  Later authority may state a corrected value as its own dated fact
//  beside the segment. The segment itself reads $29.97 forever.
//
//  ── WHY REFUSAL IS TOTAL ────────────────────────────────────────────
//
//  A partially-parsed transcript is the worst outcome available. It
//  looks ingested, it answers questions, and the passages it is missing
//  are invisible — which converts "we could not read the record" into
//  "the meeting did not discuss it". Those are different facts and
//  confusing them is the specific failure this whole surface exists to
//  avoid. So: every block parses, or the file is refused and nothing is
//  written.
//
//  CLASS 1 — permanent. Pure: no database, no clock, no network, no
//  model. Its output is a function of its input and nothing else.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  M:SS, MM:SS, H:MM:SS or HH:MM:SS. The hour group is optional because
//  the specimen has none — but refusing every meeting that runs past an
//  hour would be an obvious defect, and the ambiguity is nil: two parts
//  is minutes and seconds, three is hours, minutes and seconds.
const HEADER = /^(\d{1,2}:\d{2}(?::\d{2})?) - (.+)$/;

//  A cap on one file, not on the format. It exists so a pathological or
//  concatenated file is refused by name rather than by exhausting memory
//  somewhere further down. The specimen is ~110 blocks.
const MAX_SEGMENTS = 20000;

function refusal(reason, receipt, extra = {}) {
  const e = new Error(receipt);
  e.transcriptRefusal = true;
  e.reason = reason;
  e.receipt = receipt;
  Object.assign(e, extra);
  return e;
}

//  "5:07" → 307. Used for ordering-independent display and for the
//  monotonicity check below. It is DERIVED; `relative_timestamp` keeps
//  what the file actually said, because that is what a citation shows.
function toSeconds(stamp) {
  const parts = String(stamp).split(":").map((n) => Number(n));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, s] = parts;
    if (s > 59) return null;
    return m * 60 + s;
  }
  const [h, m, s] = parts;
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Parse a meeting transcript into ordered, immutable segments.
 *
 * @param   {string} text  the file, already decoded as UTF-8
 * @returns {{ segments: Array, block_count: number, speaker_labels: string[],
 *             duplicate_timestamp_count: number, last_relative_seconds: number }}
 * @throws  a refusal whose `receipt` is sayable to the person who chose
 *          the file — every one names what is wrong and what to do next.
 */
function parse(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw refusal("empty_transcript",
      "That transcript is empty. Choose the transcript file your meeting tool exported.");
  }

  //  Normalise line endings ONLY. A CRLF file is the same transcript as
  //  an LF file; this is not content repair, it is decoding.
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  //  ── PASS 1: find every header line ────────────────────────────────
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m) heads.push({ line: i, stamp: m[1], speaker: m[2] });
  }

  if (heads.length === 0) {
    throw refusal("no_recognisable_blocks",
      "Spine could not find any timed speaker blocks in that file. It reads transcripts " +
      'written as "0:03 - Name" followed by what they said. Export the transcript with ' +
      "timestamps and speaker names included.");
  }
  if (heads.length > MAX_SEGMENTS) {
    throw refusal("too_many_blocks",
      `That file holds ${heads.length} speaker blocks, which is more than one meeting. ` +
      "Upload a single meeting rather than a combined export.");
  }

  //  ── ANYTHING BEFORE THE FIRST HEADER IS UNACCOUNTED-FOR CONTENT ───
  //  A title line, an attendee list, a tool's preamble. Each is real
  //  content that would be silently discarded, and silently discarding
  //  part of a record is how a transcript comes to be missing a passage
  //  nobody knows is missing.
  const preamble = lines.slice(0, heads[0].line).find((l) => l.trim() !== "");
  if (preamble !== undefined) {
    throw refusal("content_before_first_block",
      `That file begins with text that is not a timed speaker block ("${preamble.trim().slice(0, 60)}"). ` +
      "Spine stores transcripts exactly as they are and will not drop part of one. " +
      "Remove the header lines above the first timestamp, or export without them.");
  }

  //  ── PASS 2: one segment per header, body to the next header ───────
  const segments = [];
  const speakerLabels = new Set();
  let previousSeconds = -1;
  let duplicateTimestamps = 0;

  for (let h = 0; h < heads.length; h++) {
    const head = heads[h];
    const endLine = h + 1 < heads.length ? heads[h + 1].line : lines.length;

    const seconds = toSeconds(head.stamp);
    if (seconds === null) {
      throw refusal("unreadable_timestamp",
        `"${head.stamp}" is not a time Spine can read (line ${head.line + 1}). ` +
        "Transcripts are read as minutes and seconds, or hours, minutes and seconds. " +
        "Re-export the transcript from your meeting tool rather than editing the times by hand.");
    }

    //  Equal timestamps are NORMAL — see property 1 above. Going
    //  BACKWARDS is not, and it is the reliable tell that two files were
    //  concatenated or that a block was mis-detected. Refuse rather than
    //  store a meeting whose order we cannot vouch for.
    if (seconds < previousSeconds) {
      throw refusal("timestamps_go_backwards",
        `The timestamps stop moving forwards at "${head.stamp}" (line ${head.line + 1}). ` +
        "That usually means two recordings were combined into one file. " +
        "Upload each meeting separately.");
    }
    if (seconds === previousSeconds) duplicateTimestamps++;
    previousSeconds = seconds;

    //  The label, exactly as written, minus surrounding whitespace. No
    //  case folding, no spelling correction, no mapping to a person.
    const speaker = head.speaker.trim();
    if (speaker === "") {
      throw refusal("missing_speaker_label",
        `The block at "${head.stamp}" (line ${head.line + 1}) has no speaker name. ` +
        "Export the transcript with speaker labels included.");
    }

    //  The body, exactly as written. Leading and trailing blank lines go;
    //  everything inside stays, newlines included.
    const body = lines.slice(head.line + 1, endLine).join("\n").replace(/^\n+|\s+$/g, "");
    if (body === "") {
      throw refusal("empty_block",
        `The block at "${head.stamp}" (line ${head.line + 1}) has a speaker but nothing said. ` +
        "Spine stores what was said and cannot store a blank turn. Re-export the transcript.");
    }

    speakerLabels.add(speaker);
    segments.push({
      //  1-BASED AND CONTIGUOUS. This is the identity of the segment and
      //  half of every citation Spine will ever mint. It is assigned by
      //  position in the file, so re-parsing the same bytes produces the
      //  same references — which is what makes a stored reference stable.
      sequence: segments.length + 1,
      relative_timestamp: head.stamp,   // as written
      relative_seconds: seconds,        // derived
      raw_speaker_label: speaker,       // as written
      verbatim_text: body,              // as written
    });
  }

  return {
    segments,
    block_count: segments.length,
    //  Sorted for a stable receipt. Sorting the REPORT of the labels does
    //  not touch the labels stored on the segments.
    speaker_labels: Array.from(speakerLabels).sort(),
    duplicate_timestamp_count: duplicateTimestamps,
    last_relative_seconds: previousSeconds,
  };
}

module.exports = { parse, toSeconds, MAX_SEGMENTS, HEADER, refusal };
