// ════════════════════════════════════════════════════════════════════
//  meeting_transcript_service.js — THE CANONICAL WRITER FOR MEETING EVIDENCE
//
//  One meeting transcript becomes: the retained file, plus its ordered
//  turns, each addressable. That is the whole job.
//
//  ── IT WRITES EVIDENCE. IT NEVER WRITES TRUTH. ──────────────────────
//
//  Nothing in this file creates an obligation, a work order, a
//  concession, a person, a link to a person, or a fact about the
//  property. A meeting is a SOURCE at strictly lower authority than any
//  governed read, and the only thing storing it may change is that Spine
//  now holds the source.
//
//  The promotion path — "the transcript records X" becoming a governed
//  obligation — is a separate, later, human-confirmed act. If this file
//  ever grows a write to another domain's table, that boundary has been
//  crossed by accident.
//
//  ── WHY THE PARSE HAPPENS BEFORE THE STORE ──────────────────────────
//
//  A refused transcript writes NOTHING — not the artifact, not a partial
//  segment set, not a row saying an attempt happened. So the file is
//  fully parsed before the first insert, and both inserts share the
//  caller's transaction.
//
//  A stored artifact with no segments would be the worst state available:
//  a meeting Spine says it holds and cannot quote. That reads as "nothing
//  was discussed" while actually meaning "we could not read the record",
//  and those are different facts.
//
//  ── SCOPE IS PROPERTY, AND ONLY PROPERTY ────────────────────────────
//
//  153 allows an artifact to be about a deal OR a property. A transcript
//  is stored against a PROPERTY here, deliberately: a deal may hold
//  several properties, so a deal-scoped meeting reachable from a
//  property session is an implicit traversal from one property to
//  another's material. Cross-deal authority is a later, deliberate
//  design. Until then this service will not create the traversal.
//
//  ── TRANSACTION ─────────────────────────────────────────────────────
//  The CALLER owns begin/commit — same convention as
//  executed_lease_service and proposed_terms_service. This service
//  writes on the client it is passed and never commits.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════

"use strict";

const artifacts = require("../onboarding/source_artifact_service");
const parser = require("./meeting_transcript_parser");

const ARTIFACT_KIND = "meeting_transcript";

//  ISO calendar date, and a real one — `2026-02-31` parses in loose
//  checks and is not a day. Round-tripping through Date is what catches
//  it. No timezone: a meeting date is a calendar fact, not an instant.
function validMeetingDate(value) {
  const s = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

/**
 * Store one meeting transcript and its segments.
 *
 * @param client   a pg client inside the CALLER's transaction
 * @param property_id          server-derived. Never from the request body.
 * @param meeting_date         YYYY-MM-DD. Required — see below.
 * @param uploaded_by_user_id  server-derived.
 *
 * @returns { artifact_id, filename, meeting_date, segment_count,
 *            speaker_labels, duplicate_timestamp_count, deduplicated, receipt }
 */
async function ingest(client, {
  property_id,
  meeting_date,
  filename,
  mimetype,
  buffer,
  uploaded_by_user_id,
  authority_basis,
} = {}) {
  if (!client || typeof client.query !== "function") {
    throw new Error("meeting_transcript.ingest requires the caller's transaction client");
  }
  if (!property_id) {
    throw new Error("meeting_transcript.ingest requires a server-derived property_id");
  }
  if (!uploaded_by_user_id) {
    throw artifacts.refusal("no_authenticated_uploader",
      "Storing a meeting transcript requires a signed-in operator. A shared key is not an uploader.");
  }

  //  ── THE MEETING DATE IS REQUIRED, AND IT IS NOT THE UPLOAD DATE ───
  //  There is no date inside a transcript; the timestamps are relative to
  //  the start of the recording. Defaulting to today would silently make
  //  evidence age equal upload age forever after.
  const asOf = validMeetingDate(meeting_date);
  if (!asOf) {
    throw artifacts.refusal("meeting_date_required",
      "Spine needs the date this meeting took place. A transcript does not contain one — " +
      "its timestamps only count from the start of the recording — and the date it was " +
      "uploaded is not the date it happened. Enter the meeting date and upload again.");
  }

  //  1. THE BYTES. Shape, size and "is this actually what it claims to
  //     be" — judged before anything is read or written.
  artifacts.validateUpload({ filename, mimetype, buffer, artifact_kind: ARTIFACT_KIND });

  //  2. THE PARSE. Whole-file refusal; nothing is written on failure.
  const parsed = parser.parse(buffer.toString("utf8"));

  //  3. THE ARTIFACT. Dedup by (scope, sha256) lives in the artifact
  //     service: the same file offered twice returns the existing row
  //     rather than a second copy.
  const stored = await artifacts.store(client, {
    scope_type: "property",
    scope_id: property_id,
    filename,
    mimetype,
    buffer,
    uploaded_by_user_id,
    authority_basis: authority_basis || "unstated",
    source_as_of_date: asOf,
    artifact_kind: ARTIFACT_KIND,
  });

  if (stored.deduplicated) {
    //  ⚠ THE STORED KIND IS THE TRUTH, NOT THE REQUESTED ONE. Dedup is by
    //  bytes and says nothing about kind, so the same file previously
    //  stored as something else resolves to THAT row. Telling someone
    //  their transcript is on file as a transcript when Spine holds it as
    //  a rent roll would be a small lie in the one place the product is
    //  supposed to be exact about provenance.
    if (stored.kind_differs) {
      return {
        artifact_id: stored.id,
        filename: stored.original_filename,
        meeting_date: null,
        segment_count: 0,
        speaker_labels: [],
        duplicate_timestamp_count: 0,
        deduplicated: true,
        stored_as: stored.artifact_kind,
        receipt: stored.receipt,
      };
    }

    //  Same bytes, same kind: the segments were written with the artifact
    //  in one transaction, so they are already there. Count them rather
    //  than assert it — the count is what the receipt claims.
    const existing = await countSegments(client, stored.id);
    return {
      artifact_id: stored.id,
      filename: stored.original_filename,
      meeting_date: stored.source_as_of_date || asOf,
      segment_count: existing,
      speaker_labels: parsed.speaker_labels,
      duplicate_timestamp_count: parsed.duplicate_timestamp_count,
      deduplicated: true,
      receipt: `That transcript is already on file (${stored.original_filename}), ` +
               `${existing} turns. Nothing was stored twice.`,
    };
  }

  //  4. THE SEGMENTS. One statement, parameterised per row. `sequence` is
  //     unique per artifact, so a concurrent duplicate raises 23505 here
  //     rather than doubling the record.
  await insertSegments(client, stored.id, parsed.segments);

  return {
    artifact_id: stored.id,
    filename: stored.original_filename,
    meeting_date: asOf,
    segment_count: parsed.segments.length,
    speaker_labels: parsed.speaker_labels,
    duplicate_timestamp_count: parsed.duplicate_timestamp_count,
    deduplicated: false,
    //  A receipt says what happened, the durable id, the numbers that
    //  matter and what comes next (§28). "Not yet readable" is the
    //  honest part: storage landed, retrieval is a later slice, and a
    //  receipt implying Ask Spine can now answer from this would be a
    //  promise the product does not keep.
    receipt: `${stored.original_filename} is on file as the ${asOf} meeting — ` +
             `${parsed.segments.length} turns from ${parsed.speaker_labels.length} speaker ` +
             `labels. Spine keeps the exact wording. It is not yet readable in Ask Spine.`,
  };
}

async function insertSegments(client, artifact_id, segments) {
  //  Chunked to keep any single statement's parameter count well inside
  //  Postgres' 65535 limit — 5 parameters per row, so 500 rows is 2500.
  const CHUNK = 500;
  for (let i = 0; i < segments.length; i += CHUNK) {
    const slice = segments.slice(i, i + CHUNK);
    const values = [];
    const params = [artifact_id];
    for (const s of slice) {
      const base = params.length;
      params.push(s.sequence, s.relative_timestamp, s.relative_seconds,
                  s.raw_speaker_label, s.verbatim_text);
      values.push(`($1,$${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
    }
    await client.query(
      `insert into meeting_transcript_segments
         (artifact_id, sequence, relative_timestamp, relative_seconds,
          raw_speaker_label, verbatim_text)
       values ${values.join(",")}`,
      params
    );
  }
}

async function countSegments(client, artifact_id) {
  const r = await client.query(
    "select count(*)::int as n from meeting_transcript_segments where artifact_id = $1",
    [artifact_id]);
  return (r.rows[0] && r.rows[0].n) || 0;
}

/*  ── readSegments ───────────────────────────────────────────────────
 *  The turns back, in file order. Property scope is checked by the
 *  CALLER against the artifact's scope — this service knows what a
 *  transcript is, not who may hear it, exactly as the artifact service
 *  knows what a file is and not who may see it.
 *
 *  There is no person_id and no confirmed flag in this projection
 *  because there is no confirmation seam yet, and a field that always
 *  says `false` is more honest than a field that is absent and later
 *  appears — the response shape does not change when confirmation lands.
 */
async function readSegments(client, artifact_id) {
  const r = await client.query(
    `select id, sequence, relative_timestamp, relative_seconds,
            raw_speaker_label, verbatim_text
       from meeting_transcript_segments
      where artifact_id = $1
      order by sequence asc`,
    [artifact_id]);
  return (r.rows || []).map((row) => ({
    segment_id: row.id,
    sequence: row.sequence,
    relative_timestamp: row.relative_timestamp,
    relative_seconds: row.relative_seconds,
    raw_speaker_label: row.raw_speaker_label,
    //  Tier 1 only. No transcript label has ever been confirmed to be a
    //  Spine person, so both of these are constants today — and saying so
    //  is the point. "Robert" and "Unidentified Speaker" are the same
    //  evidence level; they differ in content, not in standing.
    person_id: null,
    speaker_confirmed: false,
    verbatim_text: row.verbatim_text,
  }));
}

module.exports = { ingest, readSegments, countSegments, validMeetingDate, ARTIFACT_KIND };
