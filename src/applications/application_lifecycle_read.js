// ════════════════════════════════════════════════════════════════════
//  application_lifecycle_read.js — THE CANONICAL READ AUTHORITY
//
//  CLASS 1 — permanent.
//
//  Slice 9 made application_lifecycle.js the only WRITER of
//  lease_applications.status and made it author milestones at the moment each
//  transition happens. This module is the matching READ side, and it exists
//  because of one fact:
//
//      Current status is a single mutable label. It can only describe where an
//      application is NOW. Every "did this ever reach X" question is
//      unanswerable from it, because reaching X and then moving on OVERWRITES
//      the evidence.
//
//  The live example this was written for: an application approved and later
//  withdrawn currently reads as `declined` in two separate operator surfaces.
//  The approval happened. The label no longer says so.
//
//  ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────
//  It is NOT inventory authority. Lifecycle groups establish PROGRESSION, not
//  marketability, not a unit hold, not a reservation. "approved" is not a
//  signed lease. Which fact reserves a unit is a separate governing question
//  and is deliberately NOT answered here — do not reach for these predicates
//  to decide whether a unit is available.
//
//  ── NO SECOND COPY OF THE VOCABULARY ────────────────────────────────
//  LADDER, SUBMISSION_REACHED, APPROVAL_REACHED and TERMINAL are imported from
//  the writer module and re-exported by reference. They are never restated
//  here. A second copy is how the nine private ladders this module replaces
//  came to exist in the first place.
// ════════════════════════════════════════════════════════════════════
"use strict";

const {
  STATUS, LADDER, SUBMISSION_REACHED, APPROVAL_REACHED, TERMINAL, TERMINAL_ORIGINS,
  reachedSubmission, reachedApproval, isTerminal,
} = require("./application_lifecycle");

// ── PRESENT-TENSE PREDICATES ────────────────────────────────────────
//  Every name begins with `isCurrent` on purpose. These answer "what is true
//  of this row RIGHT NOW" and nothing else. A caller reaching for history must
//  use classifyApplicationHistory below; the naming is the guardrail.
const isCurrentTerminalStatus = (status) => isTerminal(status);
const isCurrentOpenApplicationStatus = (status) =>
  typeof status === "string" && LADDER.includes(status) && !isTerminal(status);
const isCurrentSubmissionReachedStatus = (status) => reachedSubmission(status);
const isCurrentApprovalReachedStatus = (status) => reachedApproval(status);

// A status the vocabulary does not contain is not "open" and not "closed" — it
// is unrecognized, and every caller must be able to tell that apart from a
// known answer rather than having it silently bucketed.
const isKnownStatus = (status) =>
  typeof status === "string" && (LADDER.includes(status) || TERMINAL.includes(status));

// ── HISTORY CLASSIFICATION ──────────────────────────────────────────
//  Tri-state on purpose: true | false | null.
//
//  null means UNKNOWN, and it is a real answer, not a failure. Migration 124
//  backfilled approved_at only where current status still proves approval was
//  reached, so a row that was approved under the old writer and has since gone
//  terminal genuinely has no recoverable approval instant. Reporting that as
//  `false` would be a fabricated negative — the confident-wrong failure this
//  whole slice exists to remove.
//
//  Callers MUST render null as unknown. They must not coerce it into false,
//  into "no application", or into a default bucket.
function classifyApplicationHistory(application) {
  const app = application || {};
  const current_status = app.status == null ? null : String(app.status);
  const submitted_at = app.submitted_at == null ? null : app.submitted_at;
  const approved_at = app.approved_at == null ? null : app.approved_at;
  const terminal_at = app.terminal_at == null ? null : app.terminal_at;
  const terminal_code = app.terminal_code == null ? null : String(app.terminal_code);
  const reason_codes = [];

  if (!isKnownStatus(current_status)) {
    reason_codes.push("unrecognized_status");
    return {
      submission_reached: null, approval_reached: null, terminal_state: null,
      terminal_code, submitted_at, approved_at, terminal_at, current_status, reason_codes,
    };
  }

  const currentlyTerminal = isCurrentTerminalStatus(current_status);
  const isDraft = current_status === STATUS.DRAFT;
  // "Progressed" = the row moved past draft while non-terminal. Together with
  // the terminal case this is what makes a missing milestone historical rather
  // than simply not-yet-happened.
  const progressed = !isDraft && !currentlyTerminal;

  // ── SUBMISSION ────────────────────────────────────────────────────
  let submission_reached;
  if (submitted_at != null) {
    submission_reached = true;
    reason_codes.push("submitted_at_present");
  } else if (isDraft) {
    // A draft has not submitted. That is a fact, not an absence.
    submission_reached = false;
    reason_codes.push("draft_without_submission");
  } else {
    // Progressed or terminal with no instant: it happened at a time we cannot
    // name, OR (for withdrawn, whose origins include draft) it may never have
    // happened at all. Either way the honest answer is unknown.
    submission_reached = null;
    reason_codes.push(currentlyTerminal
      ? "terminal_without_submitted_at"
      : "progressed_without_submitted_at");
  }

  // ── APPROVAL ──────────────────────────────────────────────────────
  let approval_reached;
  if (approved_at != null) {
    // Survives later withdrawal or expiry. The application DID reach approval.
    approval_reached = true;
    reason_codes.push("approved_at_present");
  } else if (isDraft || current_status === STATUS.SUBMITTED) {
    // Pre-approval current state and no instant: genuinely not approved. This
    // is the one negative that is safe to assert, because these states sit
    // BELOW approval on the ladder and nothing was overwritten to get here.
    approval_reached = false;
    reason_codes.push("pre_approval_state_without_approval");
  } else if (progressed) {
    // lease_ready / countersigned / active with no approved_at is a pre-124
    // row: approval certainly happened, but the instant is unrecoverable, and
    // callers that need the instant must treat it as unknown.
    approval_reached = null;
    reason_codes.push("progressed_without_approved_at");
  } else {
    // Terminal with no approval instant. TERMINAL_ORIGINS allows declined and
    // expired to come from `submitted` (never approved) OR from `approved` /
    // `lease_ready` (approved), and withdrawn additionally from `draft`. The
    // current label cannot separate those, which is precisely the defect this
    // module replaces — so it stays unknown rather than guessing either way.
    approval_reached = null;
    reason_codes.push("terminal_without_approved_at");
  }

  // ── TERMINAL ──────────────────────────────────────────────────────
  let terminal_state;
  if (currentlyTerminal) {
    const codeValid = terminal_code != null && TERMINAL.includes(terminal_code);
    const codeAgrees = codeValid && terminal_code === current_status;
    if (codeAgrees && terminal_at != null) {
      terminal_state = true;
      reason_codes.push("terminal_pair_present");
    } else {
      // Terminal label with missing or contradictory metadata. Do NOT bless it
      // as a clean terminal: a code with no instant cannot be placed in a
      // reporting window, and a code that disagrees with status means one of
      // the two is wrong and we cannot tell which.
      terminal_state = null;
      if (!codeValid) reason_codes.push("terminal_code_missing_or_invalid");
      else if (!codeAgrees) reason_codes.push("terminal_code_contradicts_status");
      if (terminal_at == null) reason_codes.push("terminal_at_missing");
    }
  } else if (terminal_at != null || terminal_code != null) {
    // Non-terminal row carrying terminal metadata — no correct writer produces
    // this, so it is a defect, not a state.
    terminal_state = null;
    reason_codes.push("nonterminal_carrying_terminal_metadata");
  } else {
    terminal_state = false;
    reason_codes.push("nonterminal_without_terminal_metadata");
  }

  return {
    submission_reached, approval_reached, terminal_state,
    terminal_code, submitted_at, approved_at, terminal_at,
    current_status, reason_codes,
  };
}

// ── SQL SUPPORT ─────────────────────────────────────────────────────
//  NO caller-supplied alias or identifier ever reaches SQL text. The birth
//  surface in the writer module was closed for exactly this reason; opening a
//  new interpolation hole on the read side would undo that.
//
//  Callers bind these arrays as ordinary query PARAMETERS:
//
//      where la.status <> all($1)                       -- STATUS_GROUP_PARAMS.terminal
//      where la.status = any($1)                        -- STATUS_GROUP_PARAMS.approvalReached
//
//  and express milestone questions with fixed, source-owned SQL that names no
//  variable identifier:
//
//      where la.approved_at is not null                 -- SQL.reachedApproval
//
//  The alias belongs to the calling query's own literal text, which the caller
//  already controls and never derives from input.
const STATUS_GROUP_PARAMS = Object.freeze({
  terminal: TERMINAL,
  submissionReached: SUBMISSION_REACHED,
  approvalReached: APPROVAL_REACHED,
  ladder: LADDER,
});

// Fixed fragments. Unqualified on purpose — a caller with one application
// table in scope uses them directly; a caller joining several writes the
// column reference in its own literal SQL. Neither path interpolates input.
// ── THE CANONICAL APPLICANT SUB-STATUS FRAGMENT ─────────────────────
//  ONE definition, consumed by operator.js and leasing_desk_loader.js, which
//  previously carried byte-identical copies of a CASE ladder that read a
//  status label to answer a history question.
//
//  Ordering is the whole correction:
//
//    1. approved_at is not null  → 'approved'. Checked FIRST so it SURVIVES a
//       later withdrawal or expiry. The old ladder tested terminal statuses
//       before approval, which is why approved-then-withdrawn reported
//       'declined' and the approval vanished.
//    2. a CLEAN terminal pair → the actual terminal_code, so withdrawn and
//       expired stop being flattened into 'declined'. Clean means all three:
//       the status is a canonical terminal status, terminal_code EQUALS it,
//       and terminal_at exists.
//    2b. a MALFORMED terminal shape → 'unknown'. An earlier revision accepted
//       "terminal_code is not null OR status is terminal" and answered with
//       coalesce(terminal_code, status), which blessed malformed lifecycle
//       data as a clean disposition — a code with no instant cannot be placed
//       in a reporting window, and a code contradicting status means one of
//       the two is wrong and we cannot tell which. The row classifier already
//       called those unknown; the SQL now matches it rather than the other way
//       round. It must NOT fall through to 'submitted' or to the raw label.
//    3. submitted_at is not null → 'submitted' (milestone, not label).
//    4. progressed with NO milestones → 'unknown'. A pre-124 historical row.
//       Explicitly unknown rather than coerced into submitted or no-application.
//    5. invitation dispatched → 'application_sent'.
//    6. otherwise null.
//
//  The terminal literal list is GENERATED from the canonical TERMINAL array at
//  module load, so it cannot drift from the writer. Those values are module
//  constants, never caller input — no request data reaches this SQL text.
//
//  Requires `lco.conversion_id` to be in scope. That alias is written in this
//  module's own literal SQL and in the two callers' own literal SQL; it is
//  never derived from a caller argument.
const TERMINAL_SQL_LITERALS = TERMINAL.map((s) => `'${s}'`).join(",");

const SQL_APPLICANT_SUBSTATUS = `
      select case
        when exists (select 1 from lease_applications la
                      where la.conversion_id = lco.conversion_id
                        and la.approved_at is not null)
          then 'approved'
        when exists (select 1 from lease_applications la
                      where la.conversion_id = lco.conversion_id
                        and la.status in (${TERMINAL_SQL_LITERALS})
                        and la.terminal_code = la.status
                        and la.terminal_at is not null)
          then (select la.terminal_code from lease_applications la
                 where la.conversion_id = lco.conversion_id
                   and la.status in (${TERMINAL_SQL_LITERALS})
                   and la.terminal_code = la.status
                   and la.terminal_at is not null
                 order by la.terminal_at desc, la.created_at desc nulls last limit 1)
        when exists (select 1 from lease_applications la
                      where la.conversion_id = lco.conversion_id
                        and ((la.status in (${TERMINAL_SQL_LITERALS})
                              and (la.terminal_code is distinct from la.status
                                   or la.terminal_at is null))
                          or (la.status not in (${TERMINAL_SQL_LITERALS})
                              and (la.terminal_code is not null or la.terminal_at is not null))))
          then 'unknown'
        when exists (select 1 from lease_applications la
                      where la.conversion_id = lco.conversion_id
                        and la.submitted_at is not null)
          then 'submitted'
        when exists (select 1 from lease_applications la
                      where la.conversion_id = lco.conversion_id
                        and la.status <> 'draft'
                        and la.status not in (${TERMINAL_SQL_LITERALS}))
          then 'unknown'
        when exists (select 1 from application_invitations ai
                      where ai.conversion_id = lco.conversion_id
                        and ai.status in ('manually_sent','provider_dispatched'))
          then 'application_sent'
        else null end as applicant_substatus`;

const SQL = Object.freeze({
  reachedSubmission: "submitted_at is not null",
  reachedApproval: "approved_at is not null",
  hasTerminalPair: "terminal_at is not null and terminal_code is not null",
});

module.exports = {
  // canonical vocabulary, BY REFERENCE from the writer module — never copied
  STATUS, LADDER, SUBMISSION_REACHED, APPROVAL_REACHED, TERMINAL, TERMINAL_ORIGINS,

  // history — the only correct answer to "did this ever reach X"
  classifyApplicationHistory,

  // present-tense only; the names say so
  isCurrentTerminalStatus,
  isCurrentOpenApplicationStatus,
  isCurrentSubmissionReachedStatus,
  isCurrentApprovalReachedStatus,
  isKnownStatus,

  // SQL support that cannot carry a caller-controlled identifier
  STATUS_GROUP_PARAMS,
  SQL,
  SQL_APPLICANT_SUBSTATUS,
  TERMINAL_SQL_LITERALS,
};
