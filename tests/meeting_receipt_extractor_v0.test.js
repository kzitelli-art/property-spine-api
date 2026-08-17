#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt.js");

const contract = require("../src/meeting_evidence/meeting_receipt_contract");
const transcript = require("../src/meeting_evidence/transcript_segments");
const extractorPrompt = require("../src/meeting_evidence/meeting_receipt_extractor_prompt");
const extractor = require("../src/meeting_evidence/meeting_receipt_extractor_runner");
const validator = require("../src/meeting_evidence/meeting_receipt_validator");
const projection = require("../src/meeting_evidence/meeting_receipt_projection");
const renderer = require("../src/meeting_evidence/meeting_receipt_renderer");
const service = require("../src/meeting_evidence/meeting_receipt_service");
const release = require("../src/meeting_evidence/meeting_receipt_release_readiness");

const EXPECTED = 65;
let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ok    " + label);
  } else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(label, haystack, needle) {
  ok(label, String(haystack).includes(needle), `missing ${needle}`);
}

function notIncludes(label, haystack, needle) {
  ok(label, !String(haystack).includes(needle), `unexpected ${needle}`);
}

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

function deidentifiedMeetingTranscript() {
  return [
    "Weekly Operations Review",
    "Mon, Feb 3, 2025",
    "",
    "2:02 - Morgan Vale",
    "No, and really, we should have like a scaled-up pricing for the, if it's going to be shorter, so that we kind of offset the difference.",
    "",
    "4:01 - Morgan Vale",
    "You give them the two bedrooms that share the common bathroom and reserve. You'd be like, we can keep the one month free.",
    "",
    "4:46 - Morgan Vale",
    "Right. Right. But maybe that's the solution. Maybe it's like, hey, we can honor the one month free, but you guys have to take these the two bedrooms and we got to try to lease the one with the bathroom.",
    "",
    "5:07 - Taylor Reed",
    "Okay. Another issue I wanted to bring up before we get into all the other stuff. 204 is a two bedroom. And they're saying they can't fit a full-size bed there. And so they're seeking compensation.",
    "",
    "6:38 - Morgan Vale",
    "Correct. See, clarify what they're saying.",
    "",
    "6:55 - Taylor Reed",
    "Um, okay, so let's go over numbers really quickly. I don't have the final report. All good, um, but we are still occupied at 95%.",
    "",
    "8:51 - Taylor Reed",
    "Avery Lane is putting in a ticket for that today with LiftCo. Could get fixed as soon as possible.",
    "",
    "10:59 - Taylor Reed",
    "We're averaging about 10 to 15 move-ins every Saturday. So we've been taking turns covering Saturdays. Avry did this Saturday. We also lose Jorden next week for about two weeks. So a little short in the office here throughout this week and next week.",
    "",
    "12:43 - Morgan Vale",
    "Maybe like the first resident event that we have with like the new kind of residents, we try to team up with her and do something.",
    "",
    "13:48 - Taylor Reed",
    "Yeah. I'm going to get back to these move-ins. I've got about like six more to do for today. Get our accurate occupancy.",
    "",
    "14:54 - Morgan Vale",
    "So if they want to do that, I'm okay with that. I would still say, well, if they're pay the rent, then they can take whatever one they want. If they weren't going to pay the rent and leave that, like take the two without the bathroom and leave the third.",
    "",
    "15:09 - Morgan Vale",
    "But if they're pay it, it's tough to exactly. Yeah, just as long as they there's no guarantees that we fill that spot and they're on the hook for the full rent for the for the 10 months.",
    "",
    "16:29 - Morgan Vale",
    "I put the extra travel bags by the chair in the living room. The top one's mine.",
  ].join("\n");
}

function segmentContaining(segments, phrase) {
  const found = segments.find((segment) => String(segment.text).includes(phrase));
  if (!found) throw new Error(`de-identified fixture missing phrase: ${phrase}`);
  return found;
}

function deidentifiedModelOutput(segments, mutate = null) {
  const seg = (phrase) => segmentContaining(segments, phrase);
  const pricing = seg("scaled-up pricing");
  const bed204 = seg("full-size bed");
  const clarify = seg("clarify what they're saying");
  const occupied = seg("occupied at 95%");
  const elevator = seg("LiftCo");
  const staff = seg("Avry did this Saturday");
  const creator = seg("team up with her and do something");
  const accurate = seg("Get our accurate occupancy");
  const decision = seg("If they weren't going to pay the rent");
  const guarantee = seg("there's no guarantees");
  const personal = seg("travel bags");

  const output = {
    extraction_coverage: "full",
    coverage_notes: null,
    read_gaps: [],
    speaker_resolutions: [
      {
        speaker_label: "Avry",
        resolved_label: "Avery Lane",
        resolution_status: "probable",
        resolution_basis: "operator spelling review needed",
      },
      {
        speaker_label: "Jorden",
        resolved_label: "Jordan Park",
        resolution_status: "probable",
        resolution_basis: "provider transcript likely garbled a staff name",
      },
    ],
    candidates: [
      {
        candidate_key: "occupancy_95",
        candidate_type: "observation",
        subject: "95% occupancy read",
        summary: "The meeting reported 95% occupied, with a same-meeting caveat that move-ins still needed accurate entry.",
        source_class: "provider_transcript",
        epistemic_status: "unconfirmed",
        owner_status: "none",
        material_qualifiers: ["Get our accurate occupancy"],
        material: true,
        personal: false,
        support: [
          { segment_ordinal: occupied.ordinal, support_role: "observation_basis" },
          { segment_ordinal: accurate.ordinal, support_role: "qualifier" },
        ],
        quotes: [
          { segment_ordinal: occupied.ordinal, speaker_label: occupied.speaker_label, quote_text_exact: "occupied at 95%" },
          { segment_ordinal: accurate.ordinal, speaker_label: accurate.speaker_label, quote_text_exact: "Get our accurate occupancy" },
        ],
        measurements: [{
          measurement_label: "occupied",
          value: 95,
          unit: "%",
          segment_ordinal: occupied.ordinal,
          qualifiers: ["Get our accurate occupancy"],
        }],
      },
      {
        candidate_key: "three_br_ruling",
        candidate_type: "decision",
        subject: "3BR roommate matching ruling",
        summary: "Morgan approved the free-rent path only with rent coverage and no guarantee that the third room would be filled.",
        source_class: "provider_transcript",
        epistemic_status: "unconfirmed",
        owner_status: "none",
        material_qualifiers: ["no guarantees that we fill that spot"],
        material: true,
        personal: false,
        support: [
          { segment_ordinal: decision.ordinal, support_role: "decision_basis" },
          { segment_ordinal: guarantee.ordinal, support_role: "qualifier" },
        ],
        quotes: [
          { segment_ordinal: decision.ordinal, speaker_label: decision.speaker_label, quote_text_exact: "If they weren't going to pay the rent" },
          { segment_ordinal: guarantee.ordinal, speaker_label: guarantee.speaker_label, quote_text_exact: "there's no guarantees that we fill that spot" },
        ],
        branches: [
          {
            condition_summary: "the two residents pay the full apartment rent",
            outcome_summary: "they can take whichever bedrooms they want",
            segment_ordinal: decision.ordinal,
            ordinal: 1,
          },
          {
            condition_summary: "the two residents do not pay the full apartment rent",
            outcome_summary: "they take the two rooms without the bathroom and leave the third open",
            segment_ordinal: decision.ordinal,
            ordinal: 2,
          },
        ],
      },
      {
        candidate_key: "step_up_pricing_open",
        candidate_type: "proposal",
        subject: "short-term step-up pricing",
        summary: "Scaled-up pricing for shorter leases was raised but not decided in the meeting.",
        source_class: "provider_transcript",
        epistemic_status: "stated",
        owner_status: "none",
        material_qualifiers: [],
        material: true,
        personal: false,
        support: [{ segment_ordinal: pricing.ordinal, support_role: "proposal_basis" }],
        quotes: [{ segment_ordinal: pricing.ordinal, speaker_label: pricing.speaker_label, quote_text_exact: "scaled-up pricing" }],
      },
      {
        candidate_key: "unit_204_bed_claim",
        candidate_type: "reported_claim",
        subject: "Unit 204 bed fit",
        summary: "Taylor relayed that residents said a full-size bed did not fit; Spine does not treat that as confirmed property fact.",
        source_class: "provider_transcript",
        epistemic_status: "reported",
        owner_status: "none",
        material_qualifiers: [],
        material: true,
        personal: false,
        support: [
          { segment_ordinal: bed204.ordinal, support_role: "claim_basis" },
          { segment_ordinal: bed204.ordinal, support_role: "attribution" },
        ],
        quotes: [{ segment_ordinal: bed204.ordinal, speaker_label: bed204.speaker_label, quote_text_exact: "they're saying they can't fit a full-size bed there" }],
      },
      {
        candidate_key: "unit_204_clarify",
        candidate_type: "instruction",
        subject: "Clarify Unit 204 bed complaint",
        summary: "Morgan instructed the team to clarify what the residents were saying about the bed fit before treating it as a compensation issue.",
        source_class: "provider_transcript",
        epistemic_status: "stated",
        owner_status: "named",
        owner_label: "Taylor",
        owner_resolution_status: "confirmed",
        material_qualifiers: [],
        material: true,
        personal: false,
        support: [
          { segment_ordinal: clarify.ordinal, support_role: "instruction_basis" },
          { segment_ordinal: clarify.ordinal, support_role: "ownership_basis" },
        ],
        quotes: [{ segment_ordinal: clarify.ordinal, speaker_label: clarify.speaker_label, quote_text_exact: "clarify what they're saying" }],
      },
      {
        candidate_key: "elevator_vendor_ticket",
        candidate_type: "instruction",
        subject: "Freight elevator vendor ticket",
        summary: "Avery Lane was putting in a LiftCo ticket for the freight elevator.",
        source_class: "provider_transcript",
        epistemic_status: "stated",
        owner_status: "named",
        owner_label: "Avery Lane",
        owner_resolution_status: "probable",
        material_qualifiers: [],
        material: true,
        personal: false,
        support: [
          { segment_ordinal: elevator.ordinal, support_role: "instruction_basis" },
          { segment_ordinal: staff.ordinal, support_role: "ownership_basis" },
        ],
        quotes: [{ segment_ordinal: elevator.ordinal, speaker_label: elevator.speaker_label, quote_text_exact: "Avery Lane is putting in a ticket" }],
      },
      {
        candidate_key: "resident_creator",
        candidate_type: "proposal",
        subject: "Resident creator collaboration",
        summary: "A resident creator collaboration was floated without assigning an owner.",
        source_class: "provider_transcript",
        epistemic_status: "stated",
        owner_status: "unassigned",
        material_qualifiers: [],
        material: true,
        personal: false,
        support: [{ segment_ordinal: creator.ordinal, support_role: "proposal_basis" }],
        quotes: [{ segment_ordinal: creator.ordinal, speaker_label: creator.speaker_label, quote_text_exact: "team up with her and do something" }],
      },
      {
        candidate_key: "personal_travel_chatter",
        candidate_type: "observation",
        subject: "personal travel aside",
        summary: "Personal travel logistics were discussed but are excluded from the owner receipt.",
        source_class: "provider_transcript",
        epistemic_status: "stated",
        owner_status: "none",
        material_qualifiers: [],
        material: false,
        personal: true,
        support: [{ segment_ordinal: personal.ordinal, support_role: "observation_basis" }],
        quotes: [{ segment_ordinal: personal.ordinal, speaker_label: personal.speaker_label, quote_text_exact: "travel bags" }],
      },
    ],
  };
  if (mutate) mutate(output, { pricing, bed204, clarify, occupied, elevator, staff, creator, accurate, decision, guarantee, personal });
  return output;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasError(promise, code) {
  return promise.then(() => false).catch((e) => e.code === code || (Array.isArray(e.detail) && e.detail.some((d) => d.code === code)));
}

function fakeDb() {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/meeting_receipt_missed_items/i.test(sql)) {
        return { rows: [{ missed_id: uuid(90), supporting_segment_ids: params[2], description: params[1] }] };
      }
      if (/meeting_receipt_manual_edit_deltas/i.test(sql)) {
        return { rows: [{ edit_id: uuid(91), field_name: params[3], spine_text: params[4], human_text: params[5] }] };
      }
      if (/meeting_receipt_candidate_reviews/i.test(sql)) {
        return { rows: [{ review_id: uuid(92), review_target: params[3], review_class: params[4], receipt_item_id: params[1] }] };
      }
      return { rows: [{ ok: true }] };
    },
  };
}

(async () => {
  receipt.begin(__filename, { expected: EXPECTED });

  const root = path.join(__dirname, "..");
  const runnerSrc = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_extractor_runner.js"), "utf8");
  const promptSrc = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_extractor_prompt.js"), "utf8");
  const serviceSrc = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_service.js"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "176_meeting_receipt_v0.sql"), "utf8");

  includes("extractor prompt says invalid output is rejected, not repaired", promptSrc, "rejected by the server, not repaired");
  includes("extractor prompt forbids database ids", promptSrc, "database ids");
  includes("extractor schema references segment ordinals, not ids", JSON.stringify(extractorPrompt.EXTRACTOR_OUTPUT_SCHEMA), "segment_ordinal");
  notIncludes("extractor schema does not ask for candidate ids", JSON.stringify(extractorPrompt.EXTRACTOR_OUTPUT_SCHEMA), "candidate_id");
  notIncludes("extractor runner does not import Ask Spine", runnerSrc, "ask_spine");
  notIncludes("extractor runner does not own an Anthropic client", runnerSrc, "@anthropic");
  includes("release readiness query checks migration ceiling", release.releaseReadinessSql(), "ledger_ceiling");
  includes("release readiness query checks meeting_extraction_runs", release.releaseReadinessSql(), "has_meeting_extraction_runs");
  includes("release readiness query checks manual edit deltas", release.releaseReadinessSql(), "has_meeting_receipt_manual_edit_deltas");

  const live174 = release.evaluateReleaseReadiness({
    ledger_ceiling: "174",
    migration_count: 162,
    has_meeting_extraction_runs: false,
    has_candidate_support: false,
    has_meeting_speaker_resolutions: false,
  });
  ok("release readiness refuses live ceiling 174", live174.ok === false);
  includes("release readiness names ceiling problem", live174.problems.join("\n"), "below required 181");
  const row181 = { ledger_ceiling: "181", migration_count: 168 };
  for (const table of release.REQUIRED_TABLES) row181[`has_${table}`] = true;
  ok("release readiness accepts ceiling 181 with all governed relations", release.evaluateReleaseReadiness(row181).ok);
  includes("migration creates manual edit delta ledger", migration, "meeting_receipt_manual_edit_deltas");
  includes("manual edit delta ledger is append-only", migration, "trg_meeting_receipt_manual_edit_deltas_append_only");
  includes("service writes extraction run and candidates from validated record", serviceSrc, "persistExtractionResult");

  const payload = transcript.buildTranscriptVersionPayload(deidentifiedMeetingTranscript());
  ok("de-identified transcript produces addressable segments", payload.segments.length >= 12, String(payload.segments.length));
  ok("regression fixture is deterministic and self-contained", payload.segments.length === 13, String(payload.segments.length));

  const segments = payload.segments.map((segment) => ({
    ...segment,
    segment_id: extractor.stableUuid("deidentified", "segment", segment.ordinal),
    transcript_version_id: uuid(10),
  }));
  const meeting = {
    meeting_id: uuid(1),
    property_id: uuid(2),
    property_name: "Example Property",
    meeting_occurred_at: "2025-02-03T14:00:00.000Z",
    occurred_at_source: "provider_recorded",
  };
  const transcriptVersion = {
    transcript_version_id: uuid(10),
    meeting_id: meeting.meeting_id,
    source_digest: payload.source_digest,
    source_kind: "provider_transcript",
  };
  const speakerPeople = [
    { person_id: uuid(51), label: "Avery Lane" },
    { person_id: uuid(52), label: "Jordan Park" },
    { person_id: uuid(53), label: "Taylor" },
  ];
  const compilerContext = { meeting, transcriptVersion, segments, speakerPeople };
  let extractorCalled = false;
  const run = await extractor.runMeetingReceiptExtractor({
    meeting,
    transcriptVersion,
    segments,
    model: "scripted-deidentified-extractor",
    modelVersion: "fixture",
    speakerPeople,
    extractor: async ({ prompt, schema, input }) => {
      extractorCalled = true;
      includes("runner prompt carries transcript segment text", prompt, "scaled-up pricing");
      includes("runner passes output schema to extractor", JSON.stringify(schema), "quote_text_exact");
      notIncludes("runner input does not send segment ids to extractor", JSON.stringify(input), "segment_id");
      return deidentifiedModelOutput(segments);
    },
  });

  ok("extractor function was invoked", extractorCalled);
  ok("runner compiled extractor output", run.ok === true);
  ok("compiled record passes validator", validator.validateRecord(run.record).ok, JSON.stringify(validator.validateRecord(run.record).errors));
  ok("compiled candidate ids are server-created UUIDs", run.candidates.every((candidate) => /^[0-9a-f-]{36}$/.test(candidate.candidate_id)));
  ok("compiled quotes have server-resolved character ranges", run.candidates.every((candidate) =>
    candidate.quotes.every((quote) => Number.isInteger(quote.char_start) && Number.isInteger(quote.char_end))));
  ok("compiled candidates do not persist quote text", run.candidates.every((candidate) =>
    candidate.quotes.every((quote) => !("quote_text_exact" in quote) && !("text" in quote))));

  const byKeySubject = new Map(run.candidates.map((candidate) => [candidate.subject, candidate]));
  eq("95% remains unconfirmed with caveat", byKeySubject.get("95% occupancy read").epistemic_status, "unconfirmed");
  includes("95% caveat survives", byKeySubject.get("95% occupancy read").material_qualifiers.join("\n"), "Get our accurate occupancy");
  eq("3BR ruling is decision", byKeySubject.get("3BR roommate matching ruling").candidate_type, "decision");
  eq("3BR ruling keeps both branches", byKeySubject.get("3BR roommate matching ruling").branches.length, 2);
  eq("step-up pricing stays open, not decision", byKeySubject.get("short-term step-up pricing").candidate_type, "proposal");
  eq("resident bed-fit report stays a reported claim", byKeySubject.get("Unit 204 bed fit").candidate_type, "reported_claim");
  eq("resident bed-fit clarification is an instruction", byKeySubject.get("Clarify Unit 204 bed complaint").candidate_type, "instruction");
  eq("resident creator proposal stays unassigned", byKeySubject.get("Resident creator collaboration").owner_status, "unassigned");
  ok("personal chatter is retained only as excluded evidence", byKeySubject.get("personal travel aside").personal === true);

  const projected = projection.projectOwnerReceipt(run.record);
  ok("projector accepts runner record", projected.ok, JSON.stringify(projected.errors));
  eq("step-up pricing projects to raised unanswered", projected.items.find((item) =>
    item.candidate_id === byKeySubject.get("short-term step-up pricing").candidate_id).section, "RAISED, NOT ANSWERED");
  const rendered = renderer.renderOwnerReceipt(run.record);
  ok("runner record renders owner receipt", rendered.ok, JSON.stringify(rendered.errors));
  includes("receipt renders 3BR first branch", rendered.rendered_body, "the two residents pay the full apartment rent");
  includes("receipt renders 3BR second branch", rendered.rendered_body, "the two residents do not pay the full apartment rent");
  includes("receipt renders reported bed-fit claim", rendered.rendered_body, "Unit 204 bed fit");
  includes("receipt renders bed-fit clarification instruction", rendered.rendered_body, "Clarify Unit 204 bed complaint");
  includes("receipt discloses first probable speaker resolution", rendered.rendered_body, "identity: read Avry as Avery Lane");
  includes("receipt discloses second probable speaker resolution", rendered.rendered_body, "identity: read Jorden as Jordan Park");
  notIncludes("receipt excludes personal chatter", rendered.rendered_body, "travel bags");

  const partialBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.extraction_coverage = "partial"; }),
    compilerContext
  )), "coverage_not_full");
  ok("partial model output is rejected before receipt", partialBad);
  const cleanedQuoteBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.candidates[1].quotes[0].quote_text_exact = "If they were not going to pay the rent"; }),
    compilerContext
  )), "extractor_quote_not_exact");
  ok("cleaned quote is rejected, not repaired", cleanedQuoteBad);
  const segmentIdBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.candidates[0].support[0].segment_id = segments[0].segment_id; }),
    compilerContext
  )), "extractor_forbidden_key");
  ok("model-supplied segment_id is rejected", segmentIdBad);
  const charRangeBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.candidates[0].quotes[0].char_start = 0; }),
    compilerContext
  )), "extractor_forbidden_key");
  ok("model-supplied character range is rejected", charRangeBad);
  const confidenceBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.candidates[0].confidence_score = 0.9; }),
    compilerContext
  )), "extractor_forbidden_key");
  ok("model confidence field is rejected", confidenceBad);
  const duplicateKeyBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out) => { out.candidates[1].candidate_key = out.candidates[0].candidate_key; }),
    compilerContext
  )), "extractor_candidate_key_duplicate");
  ok("duplicate candidate keys are rejected", duplicateKeyBad);
  const ambiguousBad = await hasError(Promise.resolve().then(() => extractor.compileExtractorOutput(
    deidentifiedModelOutput(segments, (out, refs) => {
      out.candidates[0].quotes[0] = {
        segment_ordinal: refs.guarantee.ordinal,
        speaker_label: refs.guarantee.speaker_label,
        quote_text_exact: "the",
      };
    }),
    compilerContext
  )), "extractor_quote_ambiguous");
  ok("ambiguous exact quote is rejected", ambiguousBad);

  const invalidRecord = clone(run.record);
  invalidRecord.candidates[0].confidence_score = 0.2;
  const noDb = fakeDb();
  const rejectedBeforeDb = await service.persistExtractionResult(noDb, invalidRecord)
    .then(() => false)
    .catch((e) => e.code === "meeting_receipt_validation_failed");
  ok("invalid extraction result is rejected before DB writes", rejectedBeforeDb && noDb.queries.length === 0);

  const feedbackDb = fakeDb();
  const missing = await service.recordReceiptFeedback(feedbackDb, {
    feedbackKind: "missing",
    receiptId: uuid(30),
    description: "missed leasing follow-up",
    supportingSegmentIds: [segments[0].segment_id],
    reviewSource: "manual_entry",
    reviewerUserId: uuid(31),
  });
  eq("missing feedback routes to missed item ledger", missing.destination, "meeting_receipt_missed_items");
  const wrongOwner = await service.recordReceiptFeedback(feedbackDb, {
    feedbackKind: "assigned_wrong_person",
    receiptId: uuid(30),
    receiptItemId: uuid(32),
    candidateId: run.candidates[5].candidate_id,
    reviewSource: "manual_entry",
    reviewerUserId: uuid(31),
    note: "wrong owner",
  });
  eq("wrong-person feedback routes to interpretation", wrongOwner.review_target, "interpretation");
  eq("wrong-person feedback uses wrong review class", wrongOwner.row.review_class, "wrong");
  const shouldNotRender = await service.recordReceiptFeedback(feedbackDb, {
    feedbackKind: "should_not_have_rendered",
    receiptId: uuid(30),
    receiptItemId: uuid(33),
    candidateId: run.candidates[6].candidate_id,
    reviewSource: "manual_entry",
    reviewerUserId: uuid(31),
  });
  eq("should-not-render feedback routes to projection", shouldNotRender.review_target, "projection");
  eq("should-not-render feedback uses not_material", shouldNotRender.row.review_class, "not_material");
  const shouldHaveRendered = await service.recordReceiptFeedback(feedbackDb, {
    feedbackKind: "should_have_rendered",
    receiptId: uuid(30),
    receiptItemId: uuid(34),
    candidateId: run.candidates[7].candidate_id,
    reviewSource: "manual_entry",
    reviewerUserId: uuid(31),
  }).then(() => false).catch((e) => e.code === "should_have_rendered_item_must_be_null");
  ok("should-have-rendered refuses receipt item id", shouldHaveRendered);

  const editDb = fakeDb();
  const edit = await service.appendManualEditDelta(editDb, {
    receiptId: uuid(40),
    editedByUserId: uuid(41),
    editSource: "manual_preview",
    fieldName: "rendered_body",
    spineText: "Spine produced X",
    humanText: "Reviewer changed it to Y",
    receiptDigestAtEdit: "a".repeat(64),
    changeNote: "manual receipt preview edit",
  });
  eq("manual edit delta stores field name", edit.field_name, "rendered_body");
  const unchangedEdit = await service.appendManualEditDelta(editDb, {
    receiptId: uuid(40),
    editedByUserId: uuid(41),
    editSource: "manual_preview",
    fieldName: "rendered_body",
    spineText: "same",
    humanText: "same",
    receiptDigestAtEdit: "b".repeat(64),
  }).then(() => false).catch((e) => e.code === "manual_edit_delta_required");
  ok("manual edit delta refuses unchanged text", unchangedEdit);

  notIncludes("extractor service still does not write work orders", serviceSrc, "insert into work_orders");
  notIncludes("extractor service still does not write obligations", serviceSrc, "insert into obligations");
  notIncludes("extractor service still does not write leases", serviceSrc, "insert into leases");
  notIncludes("extractor service still does not call Ask Spine", serviceSrc, "ask_spine");

  process.exit(receipt.complete({
    harness: __filename,
    passed,
    failed,
    expectedAtLeast: EXPECTED,
  }));
})().catch((err) => {
  receipt.died(__filename, err, passed + failed);
  process.exit(1);
});
