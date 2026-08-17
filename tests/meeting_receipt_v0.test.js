#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const receipt = require("./_run_receipt.js");

const statusModel = require("../src/governance/status_model");
const contract = require("../src/meeting_evidence/meeting_receipt_contract");
const transcript = require("../src/meeting_evidence/transcript_segments");
const validator = require("../src/meeting_evidence/meeting_receipt_validator");
const projection = require("../src/meeting_evidence/meeting_receipt_projection");
const renderer = require("../src/meeting_evidence/meeting_receipt_renderer");
const service = require("../src/meeting_evidence/meeting_receipt_service");

const EXPECTED = 96;
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

function segment(id, ordinal, speaker_label, text) {
  return {
    segment_id: id,
    transcript_version_id: "tv1",
    ordinal,
    provider_timestamp: `0:${String(ordinal).padStart(2, "0")}`,
    speaker_label,
    text,
    normalized_text: transcript.normalizeText(text),
  };
}

function q(seg, text) {
  const at = seg.text.indexOf(text);
  if (at < 0) throw new Error(`quote text not found in ${seg.segment_id}: ${text}`);
  return {
    segment_id: seg.segment_id,
    speaker_label: seg.speaker_label,
    char_start: at,
    char_end: at + text.length,
  };
}

const s = {
  lead: segment("s1", 1, "Jessica", "We had eight new leads today and seven remaining units."),
  pricing: segment("s2", 2, "Morgan", "No, and really, we should have like a scaled-up pricing for the, if it's going to be shorter, so that we kind of offset the difference."),
  occupancy: segment("s3", 3, "Taylor", "We are 95% occupied, but I've got about like six more to do for today. Get our accurate number."),
  decisionA: segment("s4", 4, "Morgan", "Okay. If they're pay the rent, then they can take whatever one they want."),
  decisionB: segment("s5", 5, "Morgan", "But there's no guarantees that we fill that spot and they're on the hook."),
  claim204: segment("s6", 6, "Taylor", "They are saying they can't fit a full-size bed."),
  clarify204: segment("s7", 7, "Morgan", "Clarify what they're saying."),
  elevator: segment("s8", 8, "Avry", "I'll put in the LiftCo ticket for the freight elevator."),
  turns: segment("s9", 9, "Taylor", "Sam is handling most of the turns, but maintenance is carrying a lot."),
  office: segment("s10", 10, "Taylor", "We're short in the office with Saturday move-ins."),
  creator: segment("s11", 11, "Morgan", "Maybe we should have her do a resident event."),
  garage: segment("s12", 12, "Morgan", "That's something that we can do ourselves."),
  personal: segment("s13", 13, "Morgan", "I need to move my travel bags after my flight."),
};

function baseRecord(overrides = {}) {
  const candidates = [
    {
      candidate_id: "c1",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "observation",
      subject: "occupancy position",
      summary: "Meeting reported 95% occupied while several move-ins still needed entry.",
      source_class: "provider_transcript",
      epistemic_status: "unconfirmed",
      owner_status: "none",
      material_qualifiers: ["six move-ins still unentered"],
      material: true,
      personal: false,
      support: [
        { segment_id: s.occupancy.segment_id, support_role: "observation_basis" },
        { segment_id: s.occupancy.segment_id, support_role: "qualifier" },
      ],
      quotes: [q(s.occupancy, "We are 95% occupied")],
      measurements: [{
        measurement_label: "occupied",
        value: 95,
        unit: "%",
        stated_by_segment_id: s.occupancy.segment_id,
        qualifiers: ["six move-ins still unentered"],
      }],
    },
    {
      candidate_id: "c2",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "decision",
      subject: "3BR roommate concession",
      summary: "Morgan allowed the one-month-free roommate deal with different bedroom handling depending on rent coverage.",
      source_class: "provider_transcript",
      epistemic_status: "unconfirmed",
      owner_status: "none",
      material_qualifiers: ["no guarantees"],
      material: true,
      personal: false,
      support: [
        { segment_id: s.decisionA.segment_id, support_role: "decision_basis" },
        { segment_id: s.decisionB.segment_id, support_role: "qualifier" },
      ],
      quotes: [
        q(s.decisionA, "If they're pay the rent"),
        q(s.decisionB, "there's no guarantees"),
      ],
      branches: [
        {
          condition_summary: "full apartment rent is covered",
          outcome_summary: "roommates can choose bedrooms",
          supporting_segment_id: s.decisionA.segment_id,
          ordinal: 1,
        },
        {
          condition_summary: "full apartment rent is not covered",
          outcome_summary: "two non-en-suite rooms are used and the third room remains open",
          supporting_segment_id: s.decisionB.segment_id,
          ordinal: 2,
        },
      ],
    },
    {
      candidate_id: "c3",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "question",
      subject: "short-term pricing",
      summary: "Shorter lease pricing was raised but not answered.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [{ segment_id: s.pricing.segment_id, support_role: "proposal_basis" }],
      quotes: [q(s.pricing, "we should have like a scaled-up pricing")],
    },
    {
      candidate_id: "c4",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "reported_claim",
      subject: "Unit 204 bed fit",
      summary: "Taylor relayed a resident complaint about the bed fit; it is not a property fact.",
      source_class: "provider_transcript",
      epistemic_status: "reported",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [
        { segment_id: s.claim204.segment_id, support_role: "claim_basis" },
        { segment_id: s.claim204.segment_id, support_role: "attribution" },
      ],
      quotes: [q(s.claim204, "They are saying")],
    },
    {
      candidate_id: "c5",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "instruction",
      subject: "clarify 204 claim",
      summary: "Morgan asked for clarification of what the residents were claiming.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "named",
      owner_label: "Taylor",
      owner_resolution_status: "confirmed",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [
        { segment_id: s.clarify204.segment_id, support_role: "instruction_basis" },
        { segment_id: s.clarify204.segment_id, support_role: "ownership_basis" },
      ],
      quotes: [q(s.clarify204, "Clarify what they're saying")],
    },
    {
      candidate_id: "c6",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "instruction",
      subject: "freight elevator ticket",
      summary: "Spine read the garbled speaker label as Avery Lane and captured the LiftCo follow-up.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "named",
      owner_label: "Avery Lane",
      owner_resolution_status: "probable",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [
        { segment_id: s.elevator.segment_id, support_role: "instruction_basis" },
        { segment_id: s.elevator.segment_id, support_role: "ownership_basis" },
      ],
      quotes: [q(s.elevator, "LiftCo ticket")],
    },
    {
      candidate_id: "c7",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "constraint",
      subject: "turn capacity",
      summary: "Maintenance and turn capacity were under load.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [{ segment_id: s.turns.segment_id, support_role: "observation_basis" }],
      quotes: [q(s.turns, "maintenance is carrying a lot")],
    },
    {
      candidate_id: "c8",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "constraint",
      subject: "office staffing",
      summary: "Office coverage was tight during Saturday move-ins.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [{ segment_id: s.office.segment_id, support_role: "observation_basis" }],
      quotes: [q(s.office, "short in the office")],
    },
    {
      candidate_id: "c9",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "proposal",
      subject: "Resident creator event",
      summary: "A resident-content opportunity was floated without an owner.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "unassigned",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [{ segment_id: s.creator.segment_id, support_role: "proposal_basis" }],
      quotes: [q(s.creator, "resident event")],
    },
    {
      candidate_id: "c10",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "observation",
      subject: "garage door lesson",
      summary: "The garage-door sensor issue produced a maintenance lesson.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: false,
      support: [{ segment_id: s.garage.segment_id, support_role: "observation_basis" }],
      quotes: [q(s.garage, "something that we can do ourselves")],
    },
    {
      candidate_id: "c11",
      meeting_id: "m1",
      extraction_run_id: "r1",
      candidate_type: "observation",
      subject: "personal travel aside",
      summary: "Personal travel chatter is not part of the owner receipt.",
      source_class: "provider_transcript",
      epistemic_status: "stated",
      owner_status: "none",
      material_qualifiers: [],
      material: true,
      personal: true,
      support: [{ segment_id: s.personal.segment_id, support_role: "observation_basis" }],
      quotes: [q(s.personal, "travel bags")],
    },
  ];

  return {
    meeting: {
      meeting_id: "m1",
      property_id: "p1",
      property_name: "Example Property",
      meeting_occurred_at: "2025-02-03T14:00:00.000Z",
      occurred_at_source: "manual_entry",
    },
    transcript_version_id: "tv1",
    run: {
      extraction_run_id: "r1",
      meeting_id: "m1",
      transcript_version_id: "tv1",
      model: "fixture-extractor",
      model_version: "v0",
      extractor_contract_revision: contract.CONTRACT_REVISION,
      prompt_revision: contract.PROMPT_REVISION,
      extraction_coverage: "full",
    },
    segments: Object.values(s),
    speaker_resolutions: [
      {
        speaker_label: "Avry",
        resolved_label: "Avery Lane",
        resolution_status: "probable",
        resolution_basis: "operator review",
      },
    ],
    candidates,
    read_gaps: [],
    ...overrides,
  };
}

function clone(record) {
  return JSON.parse(JSON.stringify(record));
}

function withCandidateMutation(record, id, mutate) {
  const copy = clone(record);
  const c = copy.candidates.find((candidate) => candidate.candidate_id === id);
  mutate(c, copy);
  return copy;
}

function hasError(result, code) {
  return result.errors.some((e) => e.code === code);
}

function writeTargetsFromSource(src) {
  const targets = new Set();
  const re = /\b(?:insert\s+into|update)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(src)) !== null) targets.add(m[1]);
  return [...targets].sort();
}

(async () => {
  receipt.begin(__filename, { expected: EXPECTED });

  const root = path.join(__dirname, "..");
  const doctrine = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  const modelDoc = fs.readFileSync(path.join(root, "docs", "SOURCE_STATUS_MODEL_40_4.md"), "utf8");
  const migration = fs.readFileSync(path.join(root, "migrations", "176_meeting_receipt_v0.sql"), "utf8");
  const serviceSrc = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_service.js"), "utf8");
  const rendererSrc = fs.readFileSync(path.join(root, "src", "meeting_evidence", "meeting_receipt_renderer.js"), "utf8");

  includes("Gate 0 doctrine names source_class", doctrine, "source_class");
  includes("Gate 0 doctrine names epistemic_status", doctrine, "epistemic_status");
  includes("Gate 0 doctrine names read_status", doctrine, "read_status");
  notIncludes("Gate 0 old authority ladder removed from CLAUDE", doctrine, "governed_read` outranks `transcript_claim");
  includes("§40.4 correction doc exists", modelDoc, "SOURCE CLASS");
  includes("§40.4 correction doc names canonical source", modelDoc, "src/governance/status_model.js");
  ok("canonical source classes exported", statusModel.SOURCE_CLASSES.includes("provider_transcript"));
  ok("canonical epistemic statuses exported", statusModel.EPISTEMIC_STATUSES.includes("reported"));
  ok("canonical read statuses exported", statusModel.READ_STATUSES.includes("unavailable"));
  ok("canonical resolution status exported once", statusModel.RESOLUTION_STATUSES.includes("probable"));
  eq("meeting contract consumes canonical resolution status", contract.RESOLUTION_STATUSES, statusModel.RESOLUTION_STATUSES);

  for (const table of [
    "meeting_evidence_meetings",
    "transcript_versions",
    "transcript_segments",
    "meeting_speaker_resolutions",
    "meeting_extraction_runs",
    "meeting_interpretation_candidates",
    "candidate_support",
    "candidate_quotes",
    "candidate_branches",
    "candidate_measurements",
    "meeting_receipts",
    "meeting_receipt_items",
    "meeting_receipt_candidate_reviews",
    "meeting_receipt_missed_items",
  ]) {
    includes(`migration creates ${table}`, migration, `create table if not exists ${table}`);
  }
  includes("canonical meeting has meeting_occurred_at", migration, "meeting_occurred_at");
  includes("canonical meeting requires occurred_at_source", migration, "occurred_at_source");
  includes("transcript versions dedupe by meeting and digest", migration, "unique (meeting_id, source_digest)");
  includes("transcript segments hold provider speaker label", migration, "speaker_label");
  notIncludes("transcript segments do not carry speaker_person_id", migration, "speaker_person_id");
  includes("speaker resolutions use canonical resolution status", migration, "resolution_status in");
  includes("candidate model has no receipt section types", migration, "ck_candidate_no_receipt_types");
  notIncludes("candidate model has no read_status column", migration.match(/create table if not exists meeting_interpretation_candidates[\s\S]+?create index/)?.[0] || "", "read_status");
  ok("migration has no confidence field", !/\bconfidence(_pct|_score)?\b/i.test(migration));
  includes("candidate quote stores char_start", migration, "char_start");
  includes("candidate quote stores char_end", migration, "char_end");
  notIncludes("candidate quote table has no quote text column", migration.match(/create table if not exists candidate_quotes[\s\S]+?create table/)?.[0] || "", "\n  text");
  includes("measurement qualifiers are non-empty", migration, "jsonb_array_length(qualifiers) > 0");
  includes("receipt sent assertion fields exist", migration, "manually_marked_sent_by_user_id");
  includes("receipt item lineage exists", migration, "meeting_receipt_items");
  includes("interpretation and projection reviews share one ledger", migration, "review_target in ('interpretation','projection')");
  includes("missed items require supporting segments", migration, "cardinality(supporting_segment_ids) > 0");
  includes("receipt core immutability trigger exists", migration, "meeting_receipt_core_immutable_guard");
  includes("transcript segment append-only trigger exists", migration, "trg_transcript_segments_append_only");
  includes("review append-only trigger exists", migration, "trg_meeting_receipt_candidate_reviews_append_only");
  notIncludes("receipt table does not claim delivery", migration, "delivered");
  notIncludes("receipt table does not claim read confirmation", migration, "read_confirm");

  const writes = writeTargetsFromSource(serviceSrc);
  ok("service writes only allowlisted meeting namespace tables",
    writes.every((target) => contract.WRITE_ALLOWLIST.includes(target)),
    writes.join(", "));
  notIncludes("service never writes work orders", serviceSrc, "insert into work_orders");
  notIncludes("service never writes obligations", serviceSrc, "insert into obligations");
  notIncludes("service never writes leases", serviceSrc, "insert into leases");
  notIncludes("service never writes occupancy", serviceSrc, "insert into occupancy");
  notIncludes("service does not parse email replies", serviceSrc, "email");
  notIncludes("service does not call Ask Spine", serviceSrc, "ask_spine");
  includes("canonical meeting records binder from binding row", serviceSrc, "binding.bound_by_user_id");
  notIncludes("renderer does not call a model", rendererSrc, "anthropic");

  const raw = [
    "0:01 - Morgan",
    "First line.",
    "",
    "0:02 - Taylor",
    "Second line.",
  ].join("\n");
  const parsed = transcript.buildTranscriptVersionPayload(raw);
  eq("transcript parser produces two segments", parsed.segments.length, 2);
  eq("first segment speaker preserved", parsed.segments[0].speaker_label, "Morgan");
  eq("identical transcript digest is stable", parsed.source_digest, transcript.buildTranscriptVersionPayload(raw).source_digest);
  ok("changed transcript digest changes", parsed.source_digest !== transcript.buildTranscriptVersionPayload(raw + "\nChanged.").source_digest);

  const record = baseRecord();
  const valid = validator.validateRecord(record);
  ok("de-identified specimen passes structural validator", valid.ok, JSON.stringify(valid.errors));
  const projected = projection.projectOwnerReceipt(record);
  ok("owner projection succeeds", projected.ok, JSON.stringify(projected.errors));
  eq("projection renders ten owner-visible items", projected.items.length, 10);
  eq("measurement outranks observation into Property Pulse", projected.items.find((i) => i.candidate_id === "c1").section, "PROPERTY PULSE");
  eq("decision routes to YOU DECIDED", projected.items.find((i) => i.candidate_id === "c2").section, "YOU DECIDED");
  eq("question routes to RAISED, NOT ANSWERED", projected.items.find((i) => i.candidate_id === "c3").section, "RAISED, NOT ANSWERED");
  eq("proposal without owner routes to RAISED, NOT ANSWERED", projected.items.find((i) => i.candidate_id === "c9").section, "RAISED, NOT ANSWERED");
  eq("instruction routes to NEEDS FOLLOW-UP", projected.items.find((i) => i.candidate_id === "c5").section, "NEEDS FOLLOW-UP");
  eq("constraint routes to WATCHING", projected.items.find((i) => i.candidate_id === "c7").section, "WATCHING");
  eq("reported claim routes to ALSO HEARD", projected.items.find((i) => i.candidate_id === "c4").section, "ALSO HEARD");
  ok("personal item is retained but not projected", !projected.items.some((i) => i.candidate_id === "c11"));
  ok("within section order follows transcript order",
    projected.items.filter((i) => i.section === "WATCHING")[0].candidate_id === "c7" &&
    projected.items.filter((i) => i.section === "WATCHING")[1].candidate_id === "c8");

  const rendered = renderer.renderOwnerReceipt(record);
  ok("owner receipt renders", rendered.ok, JSON.stringify(rendered.errors));
  includes("receipt starts with frozen correction line", rendered.rendered_body, renderer.CORRECTION_LINE);
  includes("receipt subject computes decision count", rendered.rendered_subject, "1 decision");
  includes("receipt subject computes follow-up count", rendered.rendered_subject, "2 follow-ups");
  includes("receipt subject computes open item count", rendered.rendered_subject, "2 open items");
  includes("receipt has Property Pulse", rendered.rendered_body, "PROPERTY PULSE");
  includes("receipt has YOU DECIDED", rendered.rendered_body, "YOU DECIDED");
  includes("receipt has Raised section", rendered.rendered_body, "RAISED, NOT ANSWERED");
  includes("receipt has Needs Follow-Up", rendered.rendered_body, "NEEDS FOLLOW-UP");
  includes("receipt has Watching", rendered.rendered_body, "WATCHING");
  includes("receipt has Also Heard", rendered.rendered_body, "ALSO HEARD");
  includes("receipt renders exact transcript quote substring", rendered.rendered_body, '"If they\'re pay the rent"');
  includes("receipt preserves decision hedge", rendered.rendered_body, "no guarantees");
  includes("measurement qualifier renders beside value", rendered.rendered_body, "occupied: 95% (six move-ins still unentered)");
  includes("conditional decision renders first branch", rendered.rendered_body, "full apartment rent is covered");
  includes("conditional decision renders second branch", rendered.rendered_body, "full apartment rent is not covered");
  includes("probable owner renders as probable", rendered.rendered_body, "Avery Lane (probable)");
  includes("probable identity disclosed in read gaps", rendered.rendered_body, "identity: read Avry as Avery Lane");
  includes("read gaps render even when none besides identity", rendered.rendered_body, "READ GAPS");
  notIncludes("personal travel detail excluded from receipt", rendered.rendered_body, "travel bags");
  ok("receipt digest is 64 hex", /^[0-9a-f]{64}$/.test(rendered.rendered_digest));
  eq("deterministic re-render digest is stable", renderer.renderOwnerReceipt(record).rendered_digest, rendered.rendered_digest);
  eq("deterministic re-render body is stable", renderer.renderOwnerReceipt(record).rendered_body, rendered.rendered_body);
  ok("rendered receipt passes qualifier render check", validator.validateRenderedReceipt(record, rendered).ok);

  const partial = clone(record);
  partial.run.extraction_coverage = "partial";
  partial.run.coverage_notes = "audio failed after minute 12";
  ok("partial extraction blocks complete receipt", !renderer.renderOwnerReceipt(partial).ok);
  ok("partial extraction returns coverage error", hasError(renderer.renderOwnerReceipt(partial), "coverage_not_full"));

  const quoteTextFixture = withCandidateMutation(record, "c2", (c) => {
    c.quotes[0].text = "If they pay the rent";
  });
  ok("plausible cleaned quote text is refused", hasError(validator.validateRecord(quoteTextFixture), "quote_text_forbidden"));
  const wrongSpeaker = withCandidateMutation(record, "c2", (c) => {
    c.quotes[0].speaker_label = "Taylor";
  });
  ok("wrong speaker attribution is refused", hasError(validator.validateRecord(wrongSpeaker), "quote_speaker_mismatch"));
  const badRange = withCandidateMutation(record, "c2", (c) => {
    c.quotes[0].char_end = 9999;
  });
  ok("invalid quote range is refused", hasError(validator.validateRecord(badRange), "quote_range_invalid"));
  const stitched = withCandidateMutation(record, "c2", (c) => {
    c.quotes.push({
      segment_id: s.claim204.segment_id,
      speaker_label: s.decisionA.speaker_label,
      char_start: 0,
      char_end: 5,
    });
  });
  ok("two-speaker stitched quote is refused", hasError(validator.validateRecord(stitched), "quote_speaker_mismatch"));
  const decisionNoBasis = withCandidateMutation(record, "c2", (c) => {
    c.support = [{ segment_id: s.decisionA.segment_id, support_role: "proposal_basis" }];
  });
  ok("proposal promoted to decision is refused", hasError(validator.validateRecord(decisionNoBasis), "decision_without_basis"));
  const conditionalNoBranch = withCandidateMutation(record, "c2", (c) => {
    c.branches = [];
    c.material_qualifiers = ["conditional"];
  });
  ok("conditional decision with missing branch is refused", hasError(validator.validateRecord(conditionalNoBranch), "conditional_decision_without_branches"));
  const reportedAsObservation = withCandidateMutation(record, "c4", (c) => {
    c.candidate_type = "observation";
  });
  ok("reported resident assertion promoted to fact is refused", hasError(validator.validateRecord(reportedAsObservation), "reported_observation_forbidden"));
  const hedgeDropped = withCandidateMutation(record, "c1", (c) => {
    c.material_qualifiers = [];
  });
  ok("material hedge missing from unconfirmed candidate is refused", hasError(validator.validateRecord(hedgeDropped), "unconfirmed_without_qualifier"));
  const ownerInvented = withCandidateMutation(record, "c9", (c) => {
    c.owner_label = "Taylor";
  });
  ok("unassigned action with invented owner is refused", hasError(validator.validateRecord(ownerInvented), "unassigned_owner_named"));
  const branchOnObservation = withCandidateMutation(record, "c10", (c) => {
    c.branches = [{ condition_summary: "if fixed", outcome_summary: "watch", supporting_segment_id: s.garage.segment_id, ordinal: 1 }];
  });
  ok("branches on non-decisions are refused", hasError(validator.validateRecord(branchOnObservation), "branch_on_non_decision"));
  const badMeasurement = withCandidateMutation(record, "c1", (c) => {
    c.measurements[0].qualifiers = [];
  });
  ok("headline measurement without qualifier is refused", hasError(validator.validateRecord(badMeasurement), "measurement_without_qualifier"));
  const candidateReadStatus = withCandidateMutation(record, "c1", (c) => {
    c.read_status = "ok";
  });
  ok("candidate read_status is refused", hasError(validator.validateRecord(candidateReadStatus), "candidate_read_status_forbidden"));
  const confidence = withCandidateMutation(record, "c1", (c) => {
    c.confidence_score = 0.82;
  });
  ok("confidence field is refused", hasError(validator.validateRecord(confidence), "confidence_field_forbidden"));
  const supersededDecision = clone(record);
  supersededDecision.candidates.push({
    ...clone(record).candidates.find((c) => c.candidate_id === "c2"),
    candidate_id: "c12",
    subject: "final revised roommate decision",
    supersedes_candidate_id: "c2",
  });
  ok("abandoned intermediate decision cannot render as final", hasError(projection.projectOwnerReceipt(supersededDecision), "superseded_decision_cannot_render"));
  const supersededProposal = clone(record);
  supersededProposal.candidates.push({
    ...clone(record).candidates.find((c) => c.candidate_id === "c2"),
    candidate_id: "c12",
    supersedes_candidate_id: "c9",
  });
  const supersededProjection = projection.projectOwnerReceipt(supersededProposal);
  ok("proposal superseded by decision is retained as lineage not rendered",
    supersededProjection.ok && !supersededProjection.items.some((i) => i.candidate_id === "c9"));
  const idleProposal = withCandidateMutation(record, "c9", (c) => {
    c.material = false;
  });
  ok("idle brainstorming marked immaterial does not render", !projection.projectOwnerReceipt(idleProposal).items.some((i) => i.candidate_id === "c9"));

  const goldTypeExpectations = {
    "turn capacity": "constraint",
    "office staffing": "constraint",
    "garage door lesson": "observation",
    "Unit 204 bed fit": "reported_claim",
  };
  for (const [subject, expectedType] of Object.entries(goldTypeExpectations)) {
    const candidate = record.candidates.find((c) => c.subject === subject);
    eq(`gold corpus preserves ${subject} type`, candidate.candidate_type, expectedType);
  }
  const capacityWrong = withCandidateMutation(record, "c7", (c) => {
    c.candidate_type = "observation";
  });
  ok("capacity constraint typed as observation is caught by gold corpus",
    capacityWrong.candidates.find((c) => c.candidate_id === "c7").candidate_type !== goldTypeExpectations["turn capacity"]);

  const projectionReviewBad = service.appendCandidateReview({}, {
    receiptId: uuid(1),
    receiptItemId: uuid(2),
    candidateId: uuid(3),
    reviewTarget: "projection",
    reviewClass: "should_have_rendered",
    reviewSource: "manual_entry",
    reviewerUserId: uuid(4),
  }).then(() => false).catch((e) => e.code === "should_have_rendered_item_must_be_null");
  ok("projection should_have_rendered requires null receipt item", await projectionReviewBad);

  const missingWithoutEvidence = service.appendMissedItem({}, {
    receiptId: uuid(1),
    description: "missing important discussion",
    supportingSegmentIds: [],
    reviewSource: "manual_entry",
    reviewerUserId: uuid(4),
  }).then(() => false).catch((e) => e.code === "missing_supporting_segment_ids");
  ok("missed item without segment evidence is refused", await missingWithoutEvidence);

  const fakeDb = {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/select count/i.test(sql)) return { rows: [{ review_count: 1 }] };
      if (/update meeting_receipts/i.test(sql)) {
        return { rows: [{
          receipt_id: params[0],
          manually_marked_sent_by_user_id: params[1],
          manually_marked_sent_at: params[2],
          sent_channel_note: params[3],
        }] };
      }
      return { rows: [{ ok: true }] };
    },
  };
  const sent = await service.markReceiptSent(fakeDb, {
    receiptId: uuid(10),
    markedByUserId: uuid(11),
    sentAt: "2026-08-16T20:00:00.000Z",
    sentChannelNote: "human pasted draft into Outlook",
  });
  eq("sent assertion records who asserted send", sent.manually_marked_sent_by_user_id, uuid(11));
  ok("sent assertion SQL does not claim delivery/read/review",
    !/delivered|read_confirm|reviewed/i.test(fakeDb.queries[fakeDb.queries.length - 1].sql));
  const gate = await service.reissueGate(fakeDb, { meetingId: uuid(12) });
  ok("prior review blocks automatic reissue", gate.ok_to_auto_reissue === false);
  eq("reissue gate names reason", gate.reason, "prior_human_review_requires_reissue_review");

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
