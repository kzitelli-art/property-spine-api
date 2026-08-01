// ════════════════════════════════════════════════════════════════════
//  application_lifecycle.js — THE ONE CANONICAL APPLICATION LIFECYCLE WRITER
//
//  Slice 9, Deployment A. Every write that moves lease_applications.status —
//  and every milestone instant that must ride in that same statement — lives
//  here and nowhere else. Migration 125 turns the milestone rules into
//  database refusals; this module is the writer that satisfies them, so the
//  refusals never fire in normal operation.
//
//  ── WHAT THIS MODULE IS / IS NOT ─────────────────────────────────────
//    IS:  the canonical, transaction-focused lifecycle write. Each operation
//         receives an ALREADY-OPEN database client from its caller, reads the
//         row FOR UPDATE inside that caller's transaction, decides, and issues
//         exactly ONE statement.
//    NOT: an authority boundary. There is NO request parsing, NO session
//         resolution, NO property wall, NO connection lifecycle. It never
//         calls pool.connect(), never begins, never commits, never rolls back
//         and never releases. The ROUTE owns the transaction; the SERVICE
//         owns the business decision; this owns the lifecycle statement.
//    NOT: a generic status setter. There is deliberately no setStatus() and no
//         arbitrary-column update. Each operation is named for the real-world
//         fact it records and owns the exact columns that fact authors.
//
//  ── THE STATEMENT RULE (why this module exists at all) ───────────────
//  Migration 125's ps_application_authors_milestones() fires BEFORE INSERT OR
//  UPDATE and refuses a crossing that does not carry its milestone in the SAME
//  statement. Insert-then-update-the-timestamp is rejected twice over: once by
//  that trigger and again by the write-once trigger. So:
//    · birth at 'submitted' is ONE insert carrying submitted_at;
//    · the live approval jump to 'lease_ready' authors approved_at in the same
//      update as the status;
//    · a terminal disposition authors status + terminal_code + terminal_at +
//      the decision trail atomically, with terminal_code = status.
//
//  ── HONEST BLANK BEATS CONFIDENT WRONG (PHILOSOPHY §5) ───────────────
//  A milestone is authored ONLY at the transition that genuinely crosses its
//  boundary. Consequences, all deliberate:
//    · a historical row with submitted_at NULL approves, becomes lease_ready,
//      is countersigned, admitted and activated with submitted_at STILL NULL.
//      125 tests the OLD STATUS, not the old timestamp, so nothing demands it
//      and nothing here invents it. That row is honestly untrackable for a
//      submission-origin cohort — it is not backdated into one.
//    · a row already at 'approved' whose approved_at is NULL keeps it NULL
//      when it advances to lease_ready. The approval happened before this
//      writer existed; now() would be a fabricated instant, not a recovered
//      one. Only the transition that actually crosses into approval writes it.
//    · a draft withdrawal authors terminal truth and leaves submitted_at NULL.
//      Terminal status never implies submission.
//    · the clock is the DATABASE's. now() (= transaction_timestamp()) is the
//      instant Postgres witnesses the transition, and it agrees with 124's
//      temporary compatibility trigger to the microsecond. No Node clock, no
//      caller-supplied "when this really happened" for a milestone.
//
//  ── IDEMPOTENT REPLAY IS SAFE, AND IT IS A NO-WRITE ──────────────────
//  Every operation reads the row FOR UPDATE first. If the row is already AT
//  the target — or already BEYOND it on the ladder — the operation issues NO
//  statement and returns a receipt with already_in_state true. Re-issuing the
//  write would either move a write-once milestone (125 raises) or silently
//  regress a lifecycle that has moved on. Callers that must know the
//  difference read the receipt; the current row is returned unchanged.
//
//  ── MILESTONE WRITE-ONCE, BY WHOM ────────────────────────────────────
//    submitted_at, approved_at, terminal_at, terminal_code
//        → write-once ENFORCED BY THE DATABASE (125's write-once trigger).
//    countersigned_at, activated_at, applicant_signed_at, guarantor_signed_at
//        → write-once BY THIS CONTRACT ONLY. The database will happily let
//          them churn (executed-lease re-verification used to rewrite
//          countersigned_at on every replay). Here they are written with
//          coalesce(col, …) so the FIRST instant survives.
//
//  ── ERROR CONTRACT ───────────────────────────────────────────────────
//  Controlled refusals throw an Error carrying every shape the repo's route
//  translators already read, so no caller needs a new catch line:
//        e.httpStatus / e.publicMessage / e.code      (applicationSubmission's tx(), agent.js)
//        e.httpStatus / e.body                        (applications.js appErr)
//        e.svc / e.http / e.body                      (tenancy_anchor_service svcErr)
//  A refusal is an invariant BACKSTOP, not a replacement for the caller's own
//  operator-facing guard: services keep their hand-written 409 receipts (they
//  say what to do next); this says what the truth would not allow.
//
//  ── FOR CALLERS THAT MUST NOT THROW (executed_lease_service Phase 1) ──
//  evaluateExecutedLeaseAdmission must never roll back the executed-lease
//  evidence Phase 1 already recorded, so it cannot discover an inadmissible
//  transition by attempting one. assessTransition() answers the same question
//  with NO write and NO throw, from the row it has already read:
//        const a = assessTransition(app.status, STATUS.ACCEPTED_TERM_REQUIRED);
//        if (!a.admissible && !a.already_in_state) blockers.push({ code: a.code, detail: a.reason });
//  Terminal rows and never-approved rows become BLOCKERS that way, and the
//  200-with-blocked contract survives.
//
//  ── CLASSIFICATION (PHILOSOPHY §18) ──────────────────────────────────
//    Class 1 (permanent): this module and all eight operations.
//      · markTenantSigned / markCountersigned are permanent but DORMANT — v3
//        retired the signature door (/applications/:id/sign is 410 Gone) and
//        the executed-lease path goes lease_ready → accepted_term_required.
//        They exist because the status vocabulary the database still permits
//        must have exactly ONE writer, not because a caller is pending. No
//        removal condition: if the vocabulary is retired, the migration that
//        retires it removes them.
//    Nothing here is temporary; there is no scaffolding to remove.
//
//  ── KNOWN GAPS, STATED RATHER THAN PAPERED OVER ──────────────────────
//    · There is no draft → submitted operation. Birth at 'submitted' is the
//      only submission writer, because no proven promote-a-draft path exists
//      and a promotion would have to author a submission instant for a row
//      whose submission this module did not witness. When such a path is
//      proven, it becomes a named operation here — not a coalesce somewhere.
//    · Non-lifecycle companion updates stay with their callers (e.g. the
//      approval-gate back-link `set approval_obligation_id=…` written after
//      the gate is spawned, which cannot ride the birth INSERT because the
//      gate needs the new application id). Those updates MUST leave every
//      milestone column alone; 125's write-once trigger enforces that.
//
//  Usage — no deps, no factory:
//      const lifecycle = require("./application_lifecycle");
//      const r = await lifecycle.markLeaseReady(client, { applicationId, termsReviewObligationId });
// ════════════════════════════════════════════════════════════════════

// ── THE VOCABULARY ──────────────────────────────────────────────────
// Mirrors migration 051's status CHECK plus 072's accepted_term_required.
const STATUS = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  LEASE_READY: "lease_ready",
  TENANT_SIGNED: "tenant_signed",
  COUNTERSIGNED: "countersigned",
  ACCEPTED_TERM_REQUIRED: "accepted_term_required",
  ACTIVE: "active",
  DECLINED: "declined",
  WITHDRAWN: "withdrawn",
  EXPIRED: "expired",
};

// The progressive ladder, in order. Terminal dispositions are OFF the ladder
// on purpose: they are not "further along", they are elsewhere.
const LADDER = [
  STATUS.DRAFT,
  STATUS.SUBMITTED,
  STATUS.APPROVED,
  STATUS.LEASE_READY,
  STATUS.TENANT_SIGNED,
  STATUS.COUNTERSIGNED,
  STATUS.ACCEPTED_TERM_REQUIRED,
  STATUS.ACTIVE,
];

// declined | withdrawn | expired. accepted_term_required is NOT terminal —
// it is blocked/waiting work (migration 124 header, ruling A).
const TERMINAL_CODES = [STATUS.DECLINED, STATUS.WITHDRAWN, STATUS.EXPIRED];

// ── GROUP MIRRORS OF 125's SQL FUNCTIONS ────────────────────────────
// The SQL functions are authoritative; these are exact mirrors so this module
// can predict a refusal instead of provoking one. If a status is ever added to
// a group in SQL, it is added here in the same commit.
const SUBMISSION_GROUP = [
  STATUS.SUBMITTED, STATUS.APPROVED, STATUS.LEASE_READY, STATUS.TENANT_SIGNED,
  STATUS.COUNTERSIGNED, STATUS.ACCEPTED_TERM_REQUIRED, STATUS.ACTIVE,
];
const APPROVAL_GROUP = [
  STATUS.APPROVED, STATUS.LEASE_READY, STATUS.TENANT_SIGNED,
  STATUS.COUNTERSIGNED, STATUS.ACCEPTED_TERM_REQUIRED, STATUS.ACTIVE,
];

const reachedSubmission = (status) => SUBMISSION_GROUP.includes(status);
const reachedApproval   = (status) => APPROVAL_GROUP.includes(status);
const isTerminal        = (status) => TERMINAL_CODES.includes(status);
const rank              = (status) => LADDER.indexOf(status);   // -1 = off-ladder

// ── ADMISSIBLE FROM-STATES, PER TARGET ──────────────────────────────
// Single source of truth for both the write operations and the read-only
// assessTransition(). Every from-state listed has already reached submission,
// which is what makes it impossible for a forward transition to be asked for
// submitted_at — and therefore impossible for one to invent it.
const ADVANCES = {
  [STATUS.APPROVED]: {
    from: [STATUS.SUBMITTED],
    why: "an application is approved from 'submitted'",
  },
  [STATUS.LEASE_READY]: {
    from: [STATUS.SUBMITTED, STATUS.APPROVED],
    why: "the live approval path advances 'submitted' straight to 'lease_ready'",
  },
  [STATUS.TENANT_SIGNED]: {
    from: [STATUS.APPROVED, STATUS.LEASE_READY],
    why: "the tenant side signs after approval",
  },
  [STATUS.COUNTERSIGNED]: {
    from: [STATUS.LEASE_READY, STATUS.TENANT_SIGNED],
    why: "a manager countersigns a lease-ready or tenant-signed application",
  },
  [STATUS.ACCEPTED_TERM_REQUIRED]: {
    from: [STATUS.APPROVED, STATUS.LEASE_READY, STATUS.TENANT_SIGNED, STATUS.COUNTERSIGNED],
    why: "an executed lease is admitted for term confirmation from an approved application",
  },
  [STATUS.ACTIVE]: {
    from: [STATUS.COUNTERSIGNED, STATUS.ACCEPTED_TERM_REQUIRED],
    why: "a tenancy activates once the term is confirmed",
  },
};

// ── ERRORS ──────────────────────────────────────────────────────────
// One Error object, every translator shape the repo already uses.
function lifecycleErr(status, code, message, detail = {}) {
  const e = new Error(message);
  e.httpStatus = status;
  e.publicMessage = message;
  e.code = code;
  e.svc = true;                       // tenancy_anchor / executed_lease route line
  e.http = status;
  e.body = { receipt: message, error: code, ...detail };
  e.lifecycle = { code, ...detail };  // structured, for callers building blockers
  return e;
}

// ════════════════════════════════════════════════════════════════════
//  assessTransition — THE READ-ONLY VERDICT (no client, no write, no throw)
//
//  Returns { admissible, already_in_state, code, reason }.
//    admissible=true       → a write may be issued now.
//    already_in_state=true → the row is AT or BEYOND the target; the correct
//                            action is no write at all. This is NOT a failure
//                            and must not become a blocker.
//    otherwise             → a refusal, with the code the write op would throw.
// ════════════════════════════════════════════════════════════════════
function assessTransition(currentStatus, targetStatus) {
  const at = (code, reason) => ({ admissible: false, already_in_state: true, code, reason });
  const no = (code, reason) => ({ admissible: false, already_in_state: false, code, reason });
  const ok = () => ({ admissible: true, already_in_state: false, code: null, reason: null });

  // ── terminal target ──
  if (isTerminal(targetStatus)) {
    if (currentStatus === targetStatus) {
      return at("already_in_state", `This application is already ${targetStatus}.`);
    }
    if (isTerminal(currentStatus)) {
      return no("lifecycle_terminal_immutable",
        `This application is already ${currentStatus}. A disposition is permanent — a later pursuit is a new application record, never a second disposition on this one.`);
    }
    if (currentStatus === STATUS.ACTIVE) {
      return no("lifecycle_transition_refused",
        "An active tenancy is not ended by an application disposition. End the tenancy through the tenancy path; the application record keeps the truth that it activated.");
    }
    if (rank(currentStatus) < 0) {
      return no("lifecycle_unknown_status",
        `Unrecognised application status '${currentStatus}'. This writer will not guess where that row sits in the lifecycle.`);
    }
    return ok();
  }

  // ── forward target ──
  const rule = ADVANCES[targetStatus];
  if (!rule) {
    return no("lifecycle_unknown_status",
      `'${targetStatus}' is not a lifecycle target this authority writes.`);
  }
  if (isTerminal(currentStatus)) {
    return no("lifecycle_terminal_immutable",
      `This application is ${currentStatus}. A terminal application cannot re-enter the lifecycle — a later pursuit is a new application record.`);
  }
  if (currentStatus === targetStatus) {
    return at("already_in_state", `This application is already ${targetStatus}.`);
  }
  if (rank(currentStatus) < 0) {
    return no("lifecycle_unknown_status",
      `Unrecognised application status '${currentStatus}'. This writer will not guess where that row sits in the lifecycle.`);
  }
  if (rank(currentStatus) > rank(targetStatus)) {
    // Beyond the target. Writing would silently regress a lifecycle that has
    // moved on — worse than refusing, because it would look like it worked.
    return at("already_beyond_target",
      `This application is at '${currentStatus}', already beyond '${targetStatus}'. No write was issued.`);
  }
  if (!rule.from.includes(currentStatus)) {
    // The honest half of the message names the milestone problem when that is
    // what it really is: nothing here will author a submission that was never
    // witnessed just to satisfy the database.
    const milestone = !reachedSubmission(currentStatus)
      ? " An application that has not been submitted cannot skip to it: a submission instant is recorded when it happens, never invented afterwards."
      : "";
    return no("lifecycle_transition_refused",
      `Cannot reach '${targetStatus}' from '${currentStatus}' — ${rule.why}.${milestone}`);
  }
  return ok();
}

// ── the row this authority decides on, locked inside the caller's tx ──
// Re-locking a row this same transaction already locked is free; taking the
// lock here means the authority never decides from a snapshot someone else
// can move underneath it.
async function loadForUpdate(client, applicationId) {
  if (!applicationId) {
    throw lifecycleErr(400, "application_id_required", "applicationId is required.");
  }
  const app = (await client.query(
    "select * from lease_applications where id=$1 for update", [applicationId]
  )).rows[0];
  if (!app) {
    throw lifecycleErr(404, "application_not_found", "No application with that id.",
      { application_id: applicationId });
  }
  return app;
}

// ── the lifecycle receipt ───────────────────────────────────────────
// The receipt IS the return value. It carries `application` (the full row —
// every surveyed call site depends on `returning *`) alongside the four facts
// that describe what the lifecycle actually did. On already_in_state the row
// is the UNCHANGED current row and milestones_authored is empty.
function receipt(app, { from_status, to_status, milestones_authored = [], already_in_state = false }) {
  return {
    application_id: app.id,
    from_status,
    to_status,
    milestones_authored,
    already_in_state,
    application: app,
  };
}

// ── the single-statement advance ────────────────────────────────────
// PRIVATE. Named operations below decide which columns a real-world fact
// authors and hand them here; this assembles ONE update. It is not exported
// and must not grow a caller-supplied column list — that would be the generic
// setter this module exists to prevent.
//
// An extraSet is either a pure SQL fragment ({ sql }) or a parameterised
// assignment ({ sql, value, tail }) where the placeholder is appended to `sql`
// and `tail` closes anything the fragment opened (a coalesce paren).
async function advance(client, { app, target, extraSets = [], milestones = [] }) {
  const sets = ["status=$1"];
  const values = [target];
  for (const s of extraSets) {
    if (s.value === undefined) { sets.push(s.sql); continue; }   // pure SQL fragment
    values.push(s.value);
    sets.push(`${s.sql}$${values.length}${s.tail || ""}`);
  }
  sets.push("updated_at=now()");
  values.push(app.id);

  const upd = await client.query(
    `update lease_applications set ${sets.join(", ")} where id=$${values.length} returning *`,
    values
  );
  return receipt(upd.rows[0], {
    from_status: app.status,
    to_status: target,
    milestones_authored: milestones,
  });
}

// Shared entry for every forward operation: lock, assess, refuse or report
// already-in-state. Returns { app } to write, or { done: receipt } to return.
async function gate(client, applicationId, target) {
  const app = await loadForUpdate(client, applicationId);
  const verdict = assessTransition(app.status, target);
  if (verdict.already_in_state) {
    return { done: receipt(app, { from_status: app.status, to_status: target, already_in_state: true }) };
  }
  if (!verdict.admissible) {
    throw lifecycleErr(409, verdict.code, verdict.reason, {
      application_id: app.id, from_status: app.status, to_status: target,
    });
  }
  return { app };
}

// ════════════════════════════════════════════════════════════════════
//  1. createSubmittedApplication — BIRTH AT 'submitted'
//
//  ONE insert. status is the authority's own literal (never an argument) and
//  submitted_at rides in the same statement, which is exactly what 125
//  demands of a birth that crosses into the submission group.
//
//  Serves BOTH intake doors identically — applicationSubmission's canonical
//  submitApplicationService and applications.js's legacy direct-create route —
//  so the Rule 10 second door cannot drift from the first while it awaits its
//  retirement decision. The payload is the union of what those doors carry;
//  a column absent from the payload is OMITTED from the insert so the
//  schema's own defaults (source, captured) still apply.
//
//  `captured` is accepted either as an object or as the already-stringified
//  JSON both doors happen to pass today; it is normalised here so neither
//  caller has to remember which.
//
//  NOT idempotent, deliberately: an insert always creates. Duplicate
//  suppression belongs to the invitation/conversion rung guards upstream,
//  which know whether a second submission is a retry or a second application.
// ════════════════════════════════════════════════════════════════════
const BIRTH_COLUMNS = [
  "property_id", "unit_id", "person_id", "leasing_lead_id", "applicant_name",
  "unit_label", "rent", "deposit", "guarantor_name", "captured", "source",
  "conversion_id",
];

async function createSubmittedApplication(client, payload = {}) {
  const { property_id, person_id, applicant_name } = payload;

  if (!property_id) throw lifecycleErr(400, "property_required", "property_id is required.");
  if (!applicant_name) throw lifecycleErr(400, "applicant_name_required", "applicant_name is required.");
  // BIRTH GUARD, held identically at both doors: an application without a
  // durable person is a name on a row. The person is REQUIRED, never
  // INFERRED — a name, an email or a phone is evidence of identity and never
  // permission to create one.
  if (!person_id) {
    throw lifecycleErr(400, "person_required",
      "person_id is required. An application must reference a durable person — resolve or create the person through the canonical intake path first, then submit. Identity is never inferred from an applicant name.");
  }

  const cols = [];
  const values = [];
  for (const col of BIRTH_COLUMNS) {
    let v = payload[col];
    if (v === undefined || v === null) continue;      // let the column default stand
    if (col === "captured") v = (typeof v === "string") ? v : JSON.stringify(v);
    cols.push(col);
    values.push(v);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`);

  // status and submitted_at are literals owned by this operation. now() is
  // transaction_timestamp(): the instant the database witnesses the birth.
  const ins = await client.query(
    `insert into lease_applications (${cols.join(", ")}, status, submitted_at)
     values (${placeholders.join(",")}, '${STATUS.SUBMITTED}', now())
     returning *`,
    values
  );

  return receipt(ins.rows[0], {
    from_status: null,                       // there was no row before this statement
    to_status: STATUS.SUBMITTED,
    milestones_authored: ["submitted_at"],
  });
}

// ════════════════════════════════════════════════════════════════════
//  2. approveApplication — 'submitted' → 'approved', authoring approved_at
//
//  The two-step door (approve now, clear to a lease packet later). The LIVE
//  path is markLeaseReady, which jumps straight past this state; this exists
//  so the 'approved' status the schema still permits has one writer and one
//  approval instant.
//
//  From 'submitted' this genuinely crosses into the approval group, so
//  approved_at is authored here and 125 requires exactly that. submitted_at
//  is NOT touched: 'submitted' has already reached the submission group, so
//  nothing demands it, and a historical row whose submitted_at is null
//  approves with it still null.
// ════════════════════════════════════════════════════════════════════
async function approveApplication(client, { applicationId } = {}) {
  const g = await gate(client, applicationId, STATUS.APPROVED);
  if (g.done) return g.done;

  return advance(client, {
    app: g.app,
    target: STATUS.APPROVED,
    // coalesce, not a bare now(): if an approval instant somehow already
    // exists, changing it is refused by 125's write-once trigger.
    extraSets: [{ sql: "approved_at=coalesce(approved_at, now())" }],
    milestones: ["approved_at"],
  });
}

// ════════════════════════════════════════════════════════════════════
//  3. markLeaseReady — THE LIVE APPROVAL PATH
//
//  'submitted' → 'lease_ready' in one statement, authoring approved_at with
//  it. This is the jump 125's group membership rules were written for: a rule
//  matching the literal string 'approved' would fire on neither side of it.
//
//  Compound by necessity: the terms-review gate link must ride the SAME
//  update as the status, because approved_at cannot be split off into a
//  second statement without being refused. The obligation is spawned by the
//  caller first (it needs the application id) and its id is passed in.
//
//  approved_at rule — the honest one:
//    from 'submitted' → this IS the approval; author it.
//    from 'approved'  → approval already happened, before this writer. If
//                       approved_at is null it STAYS null. now() would be a
//                       fabricated instant, and 125 does not ask for one
//                       because the old status had already reached approval.
// ════════════════════════════════════════════════════════════════════
async function markLeaseReady(client, { applicationId, termsReviewObligationId = null } = {}) {
  const g = await gate(client, applicationId, STATUS.LEASE_READY);
  if (g.done) return g.done;

  const crossingIntoApproval = !reachedApproval(g.app.status);
  const extraSets = [];
  const milestones = [];
  if (crossingIntoApproval) {
    extraSets.push({ sql: "approved_at=coalesce(approved_at, now())" });
    milestones.push("approved_at");
  }
  if (termsReviewObligationId) {
    extraSets.push({ sql: "terms_review_obligation_id=", value: termsReviewObligationId });
  }

  return advance(client, { app: g.app, target: STATUS.LEASE_READY, extraSets, milestones });
}

// ════════════════════════════════════════════════════════════════════
//  4. markTenantSigned — the tenant side has signed (DORMANT, see header)
//
//  Every admissible from-state has already reached approval, so no 125
//  milestone is authored here. The signature instants are EVIDENCE supplied
//  by whatever recorded the signature — they are written only when supplied
//  and only when currently null (coalesce), so a replay cannot move them, and
//  omitted entirely when the caller does not know them. A tenant_signed row
//  with no instant is honest; a now() stamped in its place is not.
// ════════════════════════════════════════════════════════════════════
async function markTenantSigned(client, { applicationId, applicantSignedAt = null, guarantorSignedAt = null } = {}) {
  const g = await gate(client, applicationId, STATUS.TENANT_SIGNED);
  if (g.done) return g.done;

  // The placeholder sits INSIDE the coalesce, so each fragment carries its
  // own closing paren as `tail`.
  const extraSets = [];
  if (applicantSignedAt) {
    extraSets.push({ sql: "applicant_signed_at=coalesce(applicant_signed_at, ", value: applicantSignedAt, tail: ")" });
  }
  if (guarantorSignedAt) {
    extraSets.push({ sql: "guarantor_signed_at=coalesce(guarantor_signed_at, ", value: guarantorSignedAt, tail: ")" });
  }

  return advance(client, { app: g.app, target: STATUS.TENANT_SIGNED, extraSets, milestones: [] });
}

// ════════════════════════════════════════════════════════════════════
//  5. markCountersigned — a manager countersigned (DORMANT, see header)
//
//  countersigned_at is authored write-once BY THIS CONTRACT (the database
//  does not protect it). No 125 milestone crosses here: every admissible
//  from-state has already reached approval.
// ════════════════════════════════════════════════════════════════════
async function markCountersigned(client, { applicationId } = {}) {
  const g = await gate(client, applicationId, STATUS.COUNTERSIGNED);
  if (g.done) return g.done;

  return advance(client, {
    app: g.app,
    target: STATUS.COUNTERSIGNED,
    extraSets: [{ sql: "countersigned_at=coalesce(countersigned_at, now())" }],
    milestones: [],           // no 125 milestone; countersigned_at is a contract instant
  });
}

// ════════════════════════════════════════════════════════════════════
//  6. markAcceptedTermRequired — AN EXECUTED LEASE IS ADMITTED
//
//  The executed-lease admission outcome: term confirmation is now required.
//  Operator-facing meaning is exactly that — never "accepted", never
//  "countersigned", which would imply a legal act after the lease was already
//  executed.
//
//  Two things this fixes at the surveyed call site:
//    · countersigned_at was rewritten with now() on EVERY idempotent
//      re-verification, churning a milestone-shaped column. Here it is
//      coalesce'd, and a replay does not reach the write at all.
//    · the update was unguarded: a terminal row was silently resurrected and
//      a never-approved row would raise under 125 — inside a transaction
//      holding Phase 1's executed-lease evidence. Both are now refusals the
//      caller can see BEFORE writing, via assessTransition(), so they become
//      blockers and the evidence still commits.
// ════════════════════════════════════════════════════════════════════
async function markAcceptedTermRequired(client, { applicationId } = {}) {
  const g = await gate(client, applicationId, STATUS.ACCEPTED_TERM_REQUIRED);
  if (g.done) return g.done;

  return advance(client, {
    app: g.app,
    target: STATUS.ACCEPTED_TERM_REQUIRED,
    extraSets: [{ sql: "countersigned_at=coalesce(countersigned_at, now())" }],
    milestones: [],
  });
}

// ════════════════════════════════════════════════════════════════════
//  7. markActive — THE TENANCY IS LIVE
//
//  status + activated_at + updated_at, and NOTHING else. The from-states have
//  all reached both groups, so 125 demands no milestone — and a defensive
//  coalesce of submitted_at or approved_at here would fabricate a submission
//  or approval instant for exactly the historical rows 124 deliberately left
//  null. activated_at is coalesce'd so a replay cannot move the activation
//  instant the database itself witnessed.
// ════════════════════════════════════════════════════════════════════
async function markActive(client, { applicationId } = {}) {
  const g = await gate(client, applicationId, STATUS.ACTIVE);
  if (g.done) return g.done;

  return advance(client, {
    app: g.app,
    target: STATUS.ACTIVE,
    extraSets: [{ sql: "activated_at=coalesce(activated_at, now())" }],
    milestones: [],
  });
}

// ════════════════════════════════════════════════════════════════════
//  8. markTerminal — THE DISPOSITION, AUTHORED ATOMICALLY
//
//  status + terminal_code + terminal_at + decision_reason + decision actor +
//  decided_at in ONE statement. 125 refuses a terminal status without
//  terminal_at and terminal_code, and ck_la_terminal_correspondence forces
//  terminal_code = status, so the code is written into both columns from one
//  argument — they can never disagree.
//
//  terminalCode and decisionReason are DIFFERENT facts and are never
//  collapsed: the code is the disposition ('declined' | 'withdrawn' |
//  'expired'); the reason is the free-text account of it. A caller with no
//  note passes the code as the reason, which is what the deny route does.
//
//  MILESTONES ARE LEFT ALONE. Denying from 'approved' keeps approved_at (the
//  application DID reach approval — that survives the withdrawal). Denying a
//  row whose submitted_at is null keeps it null: terminal status never
//  implies submission, and a draft withdrawal authors terminal truth with
//  submitted_at still null. Nothing is backfilled here, ever.
//
//  ACTOR HONESTY: decidedByUserId is frequently null on the shared-key door.
//  Null is persisted as null. An UNASSIGNED decision is the truth; a
//  substituted actor would be a fabricated one.
// ════════════════════════════════════════════════════════════════════
async function markTerminal(client, { applicationId, terminalCode, decisionReason = null, decidedByUserId = null } = {}) {
  if (!TERMINAL_CODES.includes(terminalCode)) {
    throw lifecycleErr(400, "lifecycle_invalid_terminal_code",
      `terminalCode must be one of ${TERMINAL_CODES.join(", ")} — these are distinct dispositions and are never collapsed into one.`,
      { application_id: applicationId || null, to_status: terminalCode || null });
  }

  const app = await loadForUpdate(client, applicationId);
  const verdict = assessTransition(app.status, terminalCode);

  if (verdict.already_in_state) {
    // Same disposition again: no write. terminal_at is write-once and re-issuing
    // would raise; the first disposition instant is the true one.
    return receipt(app, { from_status: app.status, to_status: terminalCode, already_in_state: true });
  }
  if (!verdict.admissible) {
    throw lifecycleErr(409, verdict.code, verdict.reason, {
      application_id: app.id, from_status: app.status, to_status: terminalCode,
      existing_terminal_code: app.terminal_code || null,
    });
  }

  const upd = await client.query(
    `update lease_applications
        set status=$1, terminal_code=$1, terminal_at=now(),
            decision_reason=$2, decision_by_user_id=$3, decided_at=now(),
            updated_at=now()
      where id=$4
      returning *`,
    [terminalCode, decisionReason == null ? terminalCode : decisionReason, decidedByUserId, app.id]
  );

  return receipt(upd.rows[0], {
    from_status: app.status,
    to_status: terminalCode,
    milestones_authored: ["terminal_at", "terminal_code"],
  });
}

module.exports = {
  // the eight lifecycle operations — the only writers of lease_applications.status
  createSubmittedApplication,
  approveApplication,
  markLeaseReady,
  markTenantSigned,
  markCountersigned,
  markAcceptedTermRequired,
  markActive,
  markTerminal,

  // read-only vocabulary + verdict, for callers that must decide WITHOUT writing
  STATUS,
  TERMINAL_CODES,
  LADDER,
  reachedSubmission,
  reachedApproval,
  isTerminal,
  assessTransition,
};
