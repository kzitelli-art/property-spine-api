// ════════════════════════════════════════════════════════════════════
//  meeting_transcript_ingest.js — THE UPLOAD DOOR, DEFAULT OFF
//
//  POST /operator/meetings/transcript
//
//  One route. It stores a transcript against the operator's own
//  property. It reads nothing back, answers no questions, and is not
//  wired to Ask Spine — retrieval is a later slice behind the canonical
//  fact envelope.
//
//  ── TWO INDEPENDENT CONTROLS, AND THEY ANSWER DIFFERENT QUESTIONS ───
//
//    ENTITLEMENT   may this person operate this property?
//                  Already answered by the staff session (§21).
//
//    COHORT GATE   may meeting evidence exist for this user AT ALL?
//                  Answered here, and by nothing else in the system.
//
//  Entitlement does not solve the second question, and this is not
//  theoretical. In the specimen, one passage carries an occupancy
//  confirmation and a resident's hospitalisation in the same breath.
//  There is no module mapping that separates them: answering "are we
//  full in September?" from that meeting hands over the health
//  information. A maintenance technician correctly assigned to this
//  property has no business hearing it.
//
//  So the gate is on the USER, not on the property. Activating a
//  property would open the transcript to everyone assigned to it, which
//  is the exact outcome the gate exists to prevent. Same two-key shape
//  as executed_lease_service — the kill switch cannot be bypassed by the
//  allowlist and the allowlist alone cannot open the feature — with the
//  subject changed from property to person.
//
//  DEFAULT IS DENY. Both variables unset means the door is shut, which
//  is what stops "we only stored it" from becoming a live production
//  pipeline before retrieval controls exist.
//
//  CLASSIFICATION:
//    · the route, the service, the parser, the table   Class 1 permanent
//    · MEETING_TRANSCRIPT_INGEST_ENABLED + the user    Class 2, retired
//      allowlist                                        when meeting
//                                                       visibility is
//                                                       designed and the
//                                                       audience model
//                                                       replaces it
//
//  Convenience is not a replacement condition, so the condition is
//  named: this pair comes out when a meeting-level audience model exists
//  and can answer who may hear a given meeting. Not before.
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function meetingTranscriptIngest(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const transcripts = require("./meeting_transcript_service");

  const { pool, upload } = deps || {};
  if (!pool) throw new Error("meeting_transcript_ingest requires a pool");
  if (!upload) throw new Error("meeting_transcript_ingest requires the multer upload instance");

  //  Read at call time, not at module load: a deploy that flips the
  //  switch should not need a code change to have been in the build.
  function gateState() {
    const enabled = process.env.MEETING_TRANSCRIPT_INGEST_ENABLED === "true";
    const users = String(process.env.MEETING_TRANSCRIPT_INGEST_USER_IDS || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    return { enabled, users };
  }

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  //  §21: the browser may REQUEST; it may not determine authority. A
  //  client-supplied property_id is refused outright rather than quietly
  //  ignored, so a caller cannot believe it chose the scope.
  //
  //  ⚠ THIS MUST RUN AFTER MULTER, NOT BEFORE IT.
  //  Copied from ask_spine.js, where it sits in front of the handler and
  //  works because express.json() has already populated req.body. On a
  //  MULTIPART route nothing has parsed the body at that point, so
  //  `req.body.property_id` is undefined, the check passes vacuously and
  //  a cross-property property_id reaches the handler unchallenged.
  //
  //  It shipped that way here for one commit and the HTTP proof caught
  //  it: "a client-supplied property_id is refused" returned 201. The
  //  guard was real, the ordering made it inert — which is worse than no
  //  guard, because the route reads as protected.
  function refuseClientProperty(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  function requireCohort(req, res, next) {
    const { enabled, users } = gateState();
    //  The refusal a user can see is product copy: it must be sayable and
    //  must name a next step. "Feature flag disabled" is our machinery
    //  shown to someone holding a file.
    if (!enabled) {
      return res.status(503).json({
        error: "meeting_transcript_ingest_disabled",
        receipt: "Meeting transcripts are not switched on for Spine yet. " +
                 "Nothing was stored. Ask the Spine team when this opens.",
      });
    }
    if (users.length === 0 || !users.includes(String(req.operator.id))) {
      return res.status(503).json({
        error: "operator_not_in_meeting_cohort",
        receipt: "Meeting transcripts are limited to a named group while Spine works out " +
                 "who may hear what was said in a meeting. Nothing was stored. " +
                 "Ask the Spine team to be added.",
      });
    }
    return next();
  }

  const uploadOne = upload.single("file");

  //  ORDER IS LOAD-BEARING:
  //    session   → who is this, and what property is theirs
  //    cohort    → may meeting evidence exist for them at all (before we
  //                buffer 25 MB for somebody who is refused)
  //    multer    → parse the multipart body
  //    property  → NOW req.body exists, so a claimed property_id can be
  //                refused rather than vacuously passed
  router.post("/operator/meetings/transcript",
    requireOperator, requireCohort,
    (req, res, next) => {
      uploadOne(req, res, (err) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ error: "file_too_large",
              receipt: "That transcript is over 25 MB. Upload a single meeting." });
          }
          return res.status(400).json({ error: "upload_failed", receipt: err.message });
        }
        next();
      });
    },
    refuseClientProperty,
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "no_file",
          receipt: "Choose the transcript file to upload." });
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await transcripts.ingest(client, {
          //  Both server-derived. Neither is readable from the request.
          property_id: req.operator.property_id,
          uploaded_by_user_id: req.operator.id,
          authority_basis: "staff_session:" + (req.operator.role_title || "unstated"),
          meeting_date: (req.body && req.body.meeting_date) || null,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
        });
        await client.query("commit");

        return res.status(out.deduplicated ? 200 : 201).json({
          property_id: req.operator.property_id,   // echoed from the session
          artifact_id: out.artifact_id,
          filename: out.filename,
          meeting_date: out.meeting_date,
          segment_count: out.segment_count,
          speaker_labels: out.speaker_labels,
          duplicate_timestamp_count: out.duplicate_timestamp_count,
          deduplicated: out.deduplicated,
          receipt: out.receipt,
        });
      } catch (e) {
        //  A refused transcript writes NOTHING. The rollback is what makes
        //  "whole-file refusal" true rather than aspirational.
        try { await client.query("rollback"); } catch (_) { /* the error below is the real one */ }

        if (e && (e.transcriptRefusal || e.artifactRefusal)) {
          return res.status(400).json({ error: e.reason, receipt: e.receipt });
        }
        console.error("meetings/transcript ingest error", e && e.message);
        return res.status(500).json({
          error: "ingest_failed",
          receipt: "Spine could not store that transcript just then. Nothing was saved. Try again.",
        });
      } finally {
        client.release();
      }
    });

  return router;
};
