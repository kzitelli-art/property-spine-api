// ════════════════════════════════════════════════════════════════════
//  renewal_lifecycle.js — SLICE 6: the renewal state machine (PURE)
//
//  Maps CANONICAL FACTS about one expiring position to the server-authored
//  renewal vocabulary the destination renders:
//
//      renewal_stage        approaching → decision_required → offer_preparation
//                           → offer_sent → resident_decision → execution
//      operating_state      available | waiting | blocked | complete
//      waiting_on           resident | staff | external_evidence   (or null)
//      blocker_code         a real cause, e.g. 'no_governed_economics'
//      due_state            ok | due_soon | due_today | overdue | none
//      primary_action       { code, label, kind, target }
//
//  ── WHY PURE ────────────────────────────────────────────────────────
//  Every value here is a FUNCTION of inputs the caller already fetched from
//  canonical sources (space_position, renewal_cases, lease_offers,
//  obligations, governed economics). No I/O, no clock except the explicit
//  `as_of` the caller passes. That makes the whole machine unit-testable
//  without a database (proof Part A) and guarantees the browser never has to
//  infer any of it.
//
//  ── THE ONE RULE THIS MACHINE OBEYS ─────────────────────────────────
//  A value is emitted ONLY when a fact authorises it. No guessed stage, no
//  "pending" decision from silence, no overdue without a timestamp, no owner
//  from a role default. Absence stays absent (null), and absence is honest.
// ════════════════════════════════════════════════════════════════════

"use strict";

const STAGES = Object.freeze([
  "approaching",
  "decision_required",
  "offer_preparation",
  "offer_sent",
  "resident_decision",
  "execution",
]);

const OPERATING_STATES = Object.freeze(["available", "waiting", "blocked", "complete"]);
const WAITING_PARTIES = Object.freeze(["resident", "staff", "external_evidence"]);
const DUE_STATES = Object.freeze(["none", "ok", "due_soon", "due_today", "overdue"]);

// Days-to-expiration below which a position without a recorded case is no
// longer merely "approaching" but "decision_required". Authored, not magic:
// 60 days is a standard renewal decision window. Purely a stage hint; it never
// invents a due timestamp.
const DECISION_WINDOW_DAYS = 60;

function daysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return null;
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// ── DUE STATE ───────────────────────────────────────────────────────
//  Derived ONLY from an authored due_at. No due_at ⇒ 'none'. Never overdue
//  without a real timestamp (§5, and the spec's due rule).
function deriveDueState(dueAtYmd, asOfYmd) {
  if (!dueAtYmd) return "none";
  const d = daysBetween(asOfYmd, dueAtYmd);
  if (d == null) return "none";
  if (d < 0) return "overdue";
  if (d === 0) return "due_today";
  if (d <= 7) return "due_soon";
  return "ok";
}

// ── STAGE ───────────────────────────────────────────────────────────
//  Server-authored. If a renewal_case exists, its authored stage wins — the
//  desk recorded where the work is. With NO case, the stage is derived from
//  the position alone: 'approaching' until inside the decision window, then
//  'decision_required'. We never fabricate offer/decision/execution stages
//  from a position that has no offer or decision recorded.
function deriveStage({ hasCase, caseStage, daysUntilExpiration }) {
  if (hasCase && caseStage && STAGES.includes(caseStage)) return caseStage;
  if (daysUntilExpiration != null && daysUntilExpiration <= DECISION_WINDOW_DAYS) {
    return "decision_required";
  }
  return "approaching";
}

// ── ECONOMICS PRESENCE ──────────────────────────────────────────────
//  Slice 6 does NOT author a renewal price. It only reports whether GOVERNED
//  economics exist for this renewal. proposed_rent stays null until Slice 8's
//  governed economics produce one.
function economicsView({ governedProposedRent, economicsSource, economicsAsOf, currentRent }) {
  const has = governedProposedRent != null && economicsSource != null;
  const proposed = has ? Number(governedProposedRent) : null;
  let changeAmount = null, changePercent = null;
  if (has && currentRent != null && Number(currentRent) > 0) {
    changeAmount = Number((proposed - Number(currentRent)).toFixed(2));
    changePercent = Number((((proposed - Number(currentRent)) / Number(currentRent)) * 100).toFixed(1));
  }
  return {
    has_governed_economics: has,
    proposed_rent: proposed,                       // null ⇒ no governed economics yet
    economics_source: has ? economicsSource : null,
    economics_as_of: has ? economicsAsOf : null,
    effective_change_amount: changeAmount,
    effective_change_percent: changePercent,
  };
}

// ── OPERATING STATE + WAITING PARTY + BLOCKER ───────────────────────
//  The single most important derivation: what is this work DOING?
//   complete  — a terminal state has been reached.
//   blocked   — something must be resolved before progress (e.g. no governed
//               economics to make an offer, or no owner to act).
//   waiting   — we have acted and are waiting on a named party.
//   available — actionable now by staff.
function deriveOperating({
  terminalState,
  offerStatus,          // 'sent' | 'expired' | null ...
  decisionStatus,       // 'accepted' | 'declined' | 'counter_requested' | 'notice_received' | null
  hasGovernedEconomics,
  ownerAssigned,        // boolean — a real accountable owner exists
  stage,
}) {
  if (terminalState) return { operating_state: "complete", waiting_on: null, blocker_code: null };

  // Waiting on the resident after an offer has gone out and no decision yet.
  if (offerStatus === "sent" && !decisionStatus) {
    return { operating_state: "waiting", waiting_on: "resident", blocker_code: null };
  }
  if (decisionStatus === "counter_requested") {
    // Ball is back with staff to re-offer.
    return { operating_state: "available", waiting_on: null, blocker_code: null };
  }

  // Blocked: to prepare an offer we need governed economics. Missing economics
  // is a real, actionable blocker (route to Market & Pricing), not a silent gap.
  if (
    (stage === "offer_preparation" || stage === "decision_required") &&
    !hasGovernedEconomics
  ) {
    return { operating_state: "blocked", waiting_on: null, blocker_code: "no_governed_economics" };
  }

  // Blocked: no accountable owner to act on decision-required work.
  if (stage === "decision_required" && !ownerAssigned) {
    return { operating_state: "blocked", waiting_on: null, blocker_code: "unassigned_owner" };
  }

  return { operating_state: "available", waiting_on: null, blocker_code: null };
}

// ── PRIMARY ACTION ──────────────────────────────────────────────────
//  Exactly one canonical next action per row. Every action is a canonical
//  command code or a navigation target — the renderer dispatches it, it never
//  performs the write itself. Selection follows the operating state and stage.
function derivePrimaryAction({
  operating_state,
  blocker_code,
  stage,
  ownerAssigned,
  hasGovernedEconomics,
  offerStatus,
  decisionStatus,
  terminalState,
}) {
  if (terminalState) return null; // complete rows carry no action

  if (blocker_code === "unassigned_owner" || (!ownerAssigned && stage === "decision_required")) {
    return { code: "assign_renewal_owner", label: "Assign owner", kind: "command", target: "renewal.assign_owner" };
  }
  if (blocker_code === "no_governed_economics") {
    // Routes to Market & Pricing to SET economics — never a browser-local price.
    return { code: "set_renewal_economics", label: "Set renewal economics", kind: "navigate", target: "leasing.market_pricing" };
  }
  if (decisionStatus === "counter_requested") {
    return { code: "prepare_renewal_offer", label: "Re-prepare offer", kind: "command", target: "renewal.prepare_offer" };
  }
  if (operating_state === "waiting" && offerStatus === "sent") {
    return { code: "record_resident_response", label: "Record response", kind: "command", target: "renewal.record_response" };
  }
  if (decisionStatus === "accepted") {
    return { code: "prepare_renewal_documents", label: "Prepare documents", kind: "command", target: "renewal.prepare_documents" };
  }

  switch (stage) {
    case "approaching":
      return { code: "review_renewal", label: "Review renewal", kind: "navigate", target: "renewal.detail" };
    case "decision_required":
      return hasGovernedEconomics
        ? { code: "prepare_renewal_offer", label: "Prepare offer", kind: "command", target: "renewal.prepare_offer" }
        : { code: "set_renewal_economics", label: "Set renewal economics", kind: "navigate", target: "leasing.market_pricing" };
    case "offer_preparation":
      return { code: "prepare_renewal_offer", label: "Prepare offer", kind: "command", target: "renewal.prepare_offer" };
    case "offer_sent":
      return { code: "record_resident_response", label: "Record response", kind: "command", target: "renewal.record_response" };
    case "resident_decision":
      return { code: "record_resident_response", label: "Record response", kind: "command", target: "renewal.record_response" };
    case "execution":
      return { code: "verify_execution", label: "Verify execution", kind: "command", target: "renewal.verify_execution" };
    default:
      return { code: "review_renewal", label: "Review renewal", kind: "navigate", target: "renewal.detail" };
  }
}

// ── THE ONE COMPOSER ────────────────────────────────────────────────
//  Given the canonical facts for a position, produce the complete
//  server-authored lifecycle view. Everything the destination needs to
//  render a row without inferring anything.
function renewalLifecycle(facts, asOfYmd) {
  const {
    days_until_expiration = null,
    renewal_case = null,            // { renewal_stage, decision_status, notice_status, terminal_state } | null
    offer = null,                   // { status, sent_at, expires_at } | null
    owner = null,                   // { user_id } | null
    due_at = null,                  // authored renewal-clock timestamp (ymd) | null
    current_rent = null,
    governed_proposed_rent = null,
    economics_source = null,
    economics_as_of = null,
  } = facts || {};

  const hasCase = !!renewal_case;
  const terminalState = renewal_case ? (renewal_case.terminal_state || null) : null;
  const decisionStatus = renewal_case ? (renewal_case.decision_status || null) : null;
  const offerStatus = offer ? (offer.status || null) : null;
  const ownerAssigned = !!(owner && owner.user_id);

  const stage = deriveStage({
    hasCase,
    caseStage: renewal_case ? renewal_case.renewal_stage : null,
    daysUntilExpiration: days_until_expiration,
  });

  const econ = economicsView({
    governedProposedRent: governed_proposed_rent,
    economicsSource: economics_source,
    economicsAsOf: economics_as_of,
    currentRent: current_rent,
  });

  const op = deriveOperating({
    terminalState,
    offerStatus,
    decisionStatus,
    hasGovernedEconomics: econ.has_governed_economics,
    ownerAssigned,
    stage,
  });

  const due_state = deriveDueState(due_at, asOfYmd);

  const primary_action = derivePrimaryAction({
    operating_state: op.operating_state,
    blocker_code: op.blocker_code,
    stage,
    ownerAssigned,
    hasGovernedEconomics: econ.has_governed_economics,
    offerStatus,
    decisionStatus,
    terminalState,
  });

  return {
    renewal_stage: stage,
    operating_state: op.operating_state,
    waiting_on: op.waiting_on,
    blocker_code: op.blocker_code,
    due_at: due_at || null,
    due_state,
    decision_status: decisionStatus,
    notice_status: renewal_case ? (renewal_case.notice_status || null) : null,
    terminal_state: terminalState,
    offer_status: offerStatus,
    offer_sent_at: offer ? (offer.sent_at || null) : null,
    offer_expires_at: offer ? (offer.expires_at || null) : null,
    ...econ,
    primary_action,
  };
}

module.exports = {
  renewalLifecycle,
  deriveStage,
  deriveOperating,
  deriveDueState,
  derivePrimaryAction,
  economicsView,
  STAGES,
  OPERATING_STATES,
  WAITING_PARTIES,
  DUE_STATES,
  DECISION_WINDOW_DAYS,
};
