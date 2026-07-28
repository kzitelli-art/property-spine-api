// ════════════════════════════════════════════════════════════════════
//  turn_sequence.js — THE ORDER A NORMAL TURN ACTUALLY HAPPENS IN
//
//  Class 1, permanent product primitive. PURE: no database, no I/O, no
//  clock, no randomness. Same shape as tour_outcome.js and
//  unit_triage_interpreter.js — one definition so the board, the unit read,
//  the management exceptions list and any later surface cannot invent four
//  slightly different answers to "what happens next".
//
//  ── THIS IS AN OPERATING DEPENDENCY, NOT A DISPLAY ORDER ────────────
//
//      1 repair  →  2 paint  →  3 final_clean  →  4 readiness_walk
//
//  · repair/replacement is eligible to begin first
//  · paint follows repair work that would damage, open, disturb or dirty
//    painted surfaces — NOT every repair
//  · final cleaning follows ALL repair, replacement and paint work
//  · the readiness walk stays blocked until everything else is resolved AND
//    the inspection is complete
//
//  ── WHAT THIS IS NOT ────────────────────────────────────────────────
//  Not a workflow engine. There are four stages, one dependency rule each,
//  and a per-item exception. There is no DAG, no scheduler, no state machine
//  registry, and deliberately no way to express a dependency this turn flow
//  does not have.
//
//  ── BUILD 2 NEVER CERTIFIES READINESS ───────────────────────────────
//  `readiness_walk` can become UNBLOCKED. It can never be completed here, and
//  nothing in this file emits a readiness verdict. An unblocked readiness
//  walk means "a human may now go and do this", not "the unit is ready".
// ════════════════════════════════════════════════════════════════════

"use strict";

// ── STAGES, in the order the work physically happens ────────────────
const STAGE = Object.freeze({
  REPAIR: "repair",
  PAINT: "paint",
  FINAL_CLEAN: "final_clean",
  READINESS_WALK: "readiness_walk",
});
const STAGE_ORDER = Object.freeze([STAGE.REPAIR, STAGE.PAINT, STAGE.FINAL_CLEAN, STAGE.READINESS_WALK]);
const STAGE_VALUES = Object.freeze(Object.values(STAGE));

const STAGE_LABEL = Object.freeze({
  [STAGE.REPAIR]: "Repairs and replacements",
  [STAGE.PAINT]: "Paint",
  [STAGE.FINAL_CLEAN]: "Final cleaning",
  [STAGE.READINESS_WALK]: "Final readiness walk",
  unstaged: "Other work",
});

// An item counts as OPEN when it is still required. Withdrawn and superseded
// work does not block anything — a correction that withdrew a repair must not
// leave paint blocked behind it forever.
const isOpen = (w) => w && w.status === "required";

// NULL stage is BUILD 1 unstaged work: always actionable, never a blocker and
// never blocked. It predates sequencing and must not be retro-fitted into it.
const isStaged = (w) => !!w && !!w.stage && STAGE_VALUES.includes(w.stage);

/**
 * computeTurnFlow — the ordered read over one unit's confirmed scope.
 *
 * @param {object}  scope   latest non-superseded unit_turn_scopes row (or null)
 * @param {Array}   work    unit_triage_required_work rows for this unit
 * @returns {object} stages, items with blocked/actionable + reason, and the
 *                   ONE controlling next action
 */
function computeTurnFlow({ scope = null, work = [] } = {}) {
  const open = work.filter(isOpen);

  // ── what blocks what ──────────────────────────────────────────────
  //  `disturbs_painted_surfaces === null` means NOT ASSESSED, and not-assessed
  //  is treated as BLOCKING. Getting this wrong the other way means painting
  //  over work that then has to be reopened, which costs the paint twice.
  const openRepairs = open.filter((w) => w.stage === STAGE.REPAIR);
  const paintBlockingRepairs = openRepairs.filter((w) => w.disturbs_painted_surfaces !== false);
  const openPaint = open.filter((w) => w.stage === STAGE.PAINT);
  const openClean = open.filter((w) => w.stage === STAGE.FINAL_CLEAN);

  const inspectionPartial = !!scope && scope.inspection_completeness === "partial";

  // Per-stage prerequisite, evaluated once and reused so every surface gives
  // the same answer.
  function blockersFor(stage) {
    if (stage === STAGE.REPAIR) return [];
    if (stage === STAGE.PAINT) {
      return paintBlockingRepairs.length
        ? [{
            reason: "repair_work_disturbs_painted_surfaces",
            detail: "Paint follows repair work that opens or dirties painted surfaces.",
            blocking_items: paintBlockingRepairs.map((w) => w.work_text),
          }]
        : [];
    }
    if (stage === STAGE.FINAL_CLEAN) {
      const b = [];
      if (openRepairs.length) b.push({
        reason: "repair_work_outstanding",
        detail: "Final cleaning follows all repair and replacement work.",
        blocking_items: openRepairs.map((w) => w.work_text),
      });
      if (openPaint.length) b.push({
        reason: "paint_work_outstanding",
        detail: "Final cleaning follows paint.",
        blocking_items: openPaint.map((w) => w.work_text),
      });
      return b;
    }
    // readiness walk
    const b = [];
    if (openRepairs.length) b.push({
      reason: "repair_work_outstanding", detail: "All required work must be resolved first.",
      blocking_items: openRepairs.map((w) => w.work_text),
    });
    if (openPaint.length) b.push({
      reason: "paint_work_outstanding", detail: "All required work must be resolved first.",
      blocking_items: openPaint.map((w) => w.work_text),
    });
    if (openClean.length) b.push({
      reason: "final_cleaning_outstanding", detail: "Final cleaning must be complete first.",
      blocking_items: openClean.map((w) => w.work_text),
    });
    if (inspectionPartial) b.push({
      reason: "inspection_incomplete",
      detail: "The turn-scope inspection is partial — unknown scope remains, so readiness cannot be reached.",
      blocking_items: [],
    });
    if (!scope) b.push({
      reason: "no_confirmed_turn_scope",
      detail: "No complete turn scope has been confirmed for this unit.",
      blocking_items: [],
    });
    return b;
  }

  // ── classify every open item ──────────────────────────────────────
  const items = open.map((w) => {
    const staged = isStaged(w);
    const blockers = staged ? blockersFor(w.stage) : [];

    // A DELIBERATE, ATTRIBUTED exception releases THIS item only. It never
    // becomes a global "ignore sequencing" switch, and the released item still
    // reports what it was released FROM so the decision stays visible.
    const released = !!w.sequence_exception && blockers.length > 0;

    return {
      work_id: w.id,
      work_text: w.work_text,
      stage: w.stage || null,
      stage_label: STAGE_LABEL[w.stage || "unstaged"],
      owner_user_id: w.owner_user_id || null,
      owner: w.owner_user_id ? { user_id: w.owner_user_id, name: w.owner_name || null } : "UNASSIGNED",
      disturbs_painted_surfaces: w.disturbs_painted_surfaces === undefined ? null : w.disturbs_painted_surfaces,
      actionable: released || blockers.length === 0,
      blocked: !released && blockers.length > 0,
      blocked_by: released ? [] : blockers,
      sequence_exception: !!w.sequence_exception,
      sequence_exception_reason: w.sequence_exception_reason || null,
      released_from: released ? blockers.map((b) => b.reason) : [],
    };
  });

  // ── the stage groups, in operating order ──────────────────────────
  const stages = STAGE_ORDER.map((s) => {
    const inStage = items.filter((i) => i.stage === s);
    const blockers = blockersFor(s);
    return {
      stage: s,
      label: STAGE_LABEL[s],
      items: inStage,
      open_count: inStage.length,
      blocked: blockers.length > 0,
      blocked_by: blockers,
    };
  });
  const unstaged = items.filter((i) => !i.stage);
  if (unstaged.length) {
    stages.push({
      stage: null, label: STAGE_LABEL.unstaged, items: unstaged,
      open_count: unstaged.length, blocked: false, blocked_by: [],
      note: "Recorded before turn staging existed — actionable, and not part of the sequence.",
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE ONE CONTROLLING NEXT ACTION
  //
  //  A property manager should never have to reconstruct which item controls
  //  the flow. Priority, most-controlling first:
  //
  //    1. actionable work with NO OWNER — it cannot start, and the fix is an
  //       assignment, not effort
  //    2. actionable work, earliest stage first — the thing that unblocks the
  //       most downstream work
  //    3. nothing actionable but work is blocked — name the blocker, because
  //       "nothing to do" would be a lie
  //    4. no open work, readiness walk unblocked — hand off, do not certify
  //    5. no open work, readiness walk blocked — say what still holds it
  // ══════════════════════════════════════════════════════════════════
  const stageRank = (i) => (i.stage ? STAGE_ORDER.indexOf(i.stage) : -1);
  const actionable = items.filter((i) => i.actionable)
    .sort((a, b) => stageRank(a) - stageRank(b));

  let controlling = null;
  const unowned = actionable.filter((i) => i.owner === "UNASSIGNED");

  if (unowned.length) {
    const i = unowned[0];
    controlling = {
      kind: "assign_owner",
      work_id: i.work_id,
      action: `Assign or accept ${lowerFirst(i.work_text)}`,
      why: "This work is actionable but has no accountable owner.",
      stage: i.stage, stage_label: i.stage_label,
    };
  } else if (actionable.length) {
    const i = actionable[0];
    const laterBlocked = stages
      .filter((s) => s.stage && s.blocked && STAGE_ORDER.indexOf(s.stage) > stageRank(i))
      .map((s) => s.label);
    controlling = {
      kind: "do_work",
      work_id: i.work_id,
      action: asAction("Complete", i.work_text),
      why: laterBlocked.length
        ? `${laterBlocked.join(" and ")} remain blocked until this is resolved.`
        : "This is the earliest actionable work in the turn.",
      stage: i.stage, stage_label: i.stage_label,
      blocks_downstream: laterBlocked,
    };
  } else {
    const blockedItems = items.filter((i) => i.blocked);
    if (blockedItems.length) {
      const first = blockedItems.sort((a, b) => stageRank(a) - stageRank(b))[0];
      controlling = {
        kind: "blocked",
        work_id: first.work_id,
        action: `Resolve what is blocking ${lowerFirst(first.work_text)}`,
        why: first.blocked_by.map((b) => b.detail).join(" "),
        stage: first.stage, stage_label: first.stage_label,
      };
    } else {
      const walkBlockers = blockersFor(STAGE.READINESS_WALK);
      controlling = walkBlockers.length
        ? {
            kind: "readiness_blocked",
            work_id: null,
            action: "Final readiness walk is not yet possible",
            why: walkBlockers.map((b) => b.detail).join(" "),
            stage: STAGE.READINESS_WALK, stage_label: STAGE_LABEL[STAGE.READINESS_WALK],
          }
        : {
            kind: "readiness_walk_available",
            work_id: null,
            action: "Schedule the final readiness walk",
            // Said explicitly, every time. An unblocked walk is permission to
            // go and look — it is not a readiness verdict, and BUILD 2 has no
            // way to produce one.
            why: "All confirmed turn work is resolved. The unit is NOT ready — readiness is established by the walk, which this build does not perform or certify.",
            stage: STAGE.READINESS_WALK, stage_label: STAGE_LABEL[STAGE.READINESS_WALK],
          };
    }
  }

  return {
    stages,
    items,
    open_count: items.length,
    actionable_count: items.filter((i) => i.actionable).length,
    blocked_count: items.filter((i) => i.blocked).length,
    unassigned_count: items.filter((i) => i.owner === "UNASSIGNED").length,
    inspection_complete: !!scope && scope.inspection_completeness === "complete_turn_scope",
    readiness_walk_blocked: blockersFor(STAGE.READINESS_WALK).length > 0,
    controlling_next_action: controlling,
  };
}

// "Paint full unit" → "paint full unit", so it reads inside a sentence.
// Left alone when the first word is an acronym or proper noun-ish (HVAC).
function lowerFirst(s) {
  const t = String(s || "");
  if (!t) return t;
  const first = t.split(/\s+/)[0];
  if (first.length > 1 && first === first.toUpperCase()) return t;
  return t.charAt(0).toLowerCase() + t.slice(1);
}

// Prefixing a verb blindly produces "Complete complete final deep clean".
// Work text is already imperative when it starts with a verb, so in that case
// the text IS the action. Operator-facing copy is the product here; a sentence
// that reads like a bug erodes trust in the surface that printed it.
const IMPERATIVE_START = /^(complete|paint|clean|diagnose|repair|replace|source|install|remove|treat|schedule|assign)\b/i;
function asAction(verb, text) {
  const t = String(text || "").trim();
  if (IMPERATIVE_START.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  return verb + " " + lowerFirst(t);
}

// ══════════════════════════════════════════════════════════════════
//  MANAGEMENT EXCEPTIONS — routine flow is QUIET
//
//  Ordinary paint → clean → repair work raises nothing. A manager who is
//  shown every routine turn stops reading the list, and then misses the one
//  that mattered. Only these six conditions surface.
// ══════════════════════════════════════════════════════════════════
function turnExceptions({ scope = null, work = [], flow = null, triage = null, nextMoveIn = null } = {}) {
  const f = flow || computeTurnFlow({ scope, work });
  const out = [];

  if (f.unassigned_count > 0) {
    out.push({
      code: "no_eligible_owner",
      label: "Work has no accountable owner",
      detail: `${f.unassigned_count} actionable item${f.unassigned_count === 1 ? "" : "s"} cannot start — nobody owns ${f.unassigned_count === 1 ? "it" : "them"}.`,
    });
  }

  // A prerequisite blocking later work is only an EXCEPTION when nothing is
  // actionable. Blocked-but-progressing is the normal shape of a turn: paint
  // is supposed to wait for repairs.
  if (f.blocked_count > 0 && f.actionable_count === 0) {
    out.push({
      code: "flow_stalled",
      label: "A prerequisite is blocking all remaining work",
      detail: f.controlling_next_action ? f.controlling_next_action.why : "Nothing is currently actionable.",
    });
  }

  if (scope && scope.inspection_completeness === "partial") {
    out.push({
      code: "inspection_partial",
      label: "Turn-scope inspection is partial",
      detail: "Unknown scope remains. Final readiness cannot be reached until the inspection is complete.",
    });
  }

  // Consequential unknowns: an unknown that would change what happens next.
  const unknowns = [];
  if (scope) {
    if (scope.paint_level === "unknown") unknowns.push("paint level");
    if (scope.cleaning_level === "unknown") unknowns.push("cleaning level");
    if (scope.keys_status === "unknown") unknowns.push("keys and access");
  }
  if (unknowns.length) {
    out.push({
      code: "consequential_unknown",
      label: "Required information is still unknown",
      detail: `Unresolved: ${unknowns.join(", ")}. These change what work the turn needs.`,
    });
  }

  // A severe or long-lead finding threatening a COMMITTED move-in. Both halves
  // are required — a long-lead item with no committed move-in is a schedule
  // note, not an exception, and ordinary turn work is never either.
  if (nextMoveIn && triage) {
    const severe = triage.initial_condition === "severe";
    const longLead = Array.isArray(triage.findings) && triage.findings.some((x) => !!x.long_lead_kind);
    if (severe || longLead) {
      out.push({
        code: "committed_move_in_at_risk",
        label: "A committed move-in may be at risk",
        detail: `Next move-in ${nextMoveIn.move_in_date} — ${nextMoveIn.days_remaining} days remaining, with ${severe ? "a severe condition" : "a long-lead blocker"} outstanding.`,
      });
    }
  }

  return out;
}

module.exports = {
  computeTurnFlow,
  turnExceptions,
  STAGE, STAGE_ORDER, STAGE_VALUES, STAGE_LABEL,
};
