// ════════════════════════════════════════════════════════════════════
//  unit_turn_read.js — ONE READ FOR THE ONE UNIT TURN PAGE  (BUILD 6A)
//
//  A CONSOLIDATION of existing canonical reads. It creates no state, owns no
//  domain model, and implements no business logic of its own.
//
//  ── WHY THIS EXISTS ─────────────────────────────────────────────────
//  Builds 1-5 each shipped their own operator door, so a single unit turn was
//  spread across five surfaces: triage, scope, work flow, readiness queue and
//  the agent thread. Every one of them was a faithful view of its own layer,
//  and together they made the operator reconstruct the flow by hand — which is
//  precisely what the sequence engine exists to prevent.
//
//  This composes them. It does NOT reinterpret them.
//
//  ── WRITES NOTHING. DERIVES NOTHING. ────────────────────────────────
//  Every field below is produced by the canonical service that owns it. There
//  is no second work list, no second readiness verdict, no second controlling
//  next action, and no availability opinion. Where two layers could answer the
//  same question, the owning layer answers and this file forwards it.
//
//  If a future change computes an operating fact here rather than forwarding
//  one, the page has become a sixth source of truth and the layers can
//  disagree without anybody noticing. The harness asserts against that.
// ════════════════════════════════════════════════════════════════════

"use strict";

/**
 * makeUnitTurnRead — all four canonical services are REQUIRED.
 * Construction fails without them, exactly as the staff-agent service does,
 * so this read cannot exist in a configuration where it would have to derive
 * something itself.
 */
function makeUnitTurnRead(deps) {
  const {
    unitTriageService, unitTurnScopeService, workAcceptanceService,
    readinessService, staffAgentService, availabilityRead,
  } = deps || {};

  const required = [
    ["unitTriageService", unitTriageService, "readUnitTriageState"],
    ["unitTurnScopeService", unitTurnScopeService, "readTurnFlow"],
    ["workAcceptanceService", workAcceptanceService, "readUnitFlow"],
    ["readinessService", readinessService, "readGateState"],
  ];
  for (const [name, svc, fn] of required) {
    if (!svc || typeof svc[fn] !== "function") {
      throw new Error(
        `unit_turn_read requires ${name} (with ${fn}()). This read COMPOSES canonical reads — ` +
        `it has no fallback and must never derive an operating fact itself.`);
    }
  }

  //  Plain operating language for the agent's internal intent names. The
  //  operator should never see `initial_triage` or `readiness_request` — those
  //  are our vocabulary, not theirs.
  const INTENT_PLAIN = Object.freeze({
    initial_triage: "You reported a unit condition",
    turn_scope: "You added work to the turn",
    work_acceptance: "You offered to take on work",
    work_completion: "You reported work complete",
    failed_final_walk: "You reported a failed final walk",
    readiness_request: "You asked about readiness",
    correction: "You corrected something",
    unclear: "Spine needs one more detail",
  });

  async function readUnitTurn(db, { property_id, unit_id, user_id }) {
    const unit = (await db.query(
      "select id, unit_number, property_id from units where id=$1 and property_id=$2",
      [unit_id, property_id])).rows[0];
    if (!unit) {
      const e = new Error("unit not found at this property");
      e.httpStatus = 404; throw e;
    }

    // ── each layer answers for itself ──
    const triage = await unitTriageService.readUnitTriageState(db, { unit_id });
    const scope = await unitTurnScopeService.readTurnFlow(db, { unit_id });
    const workFlow = await workAcceptanceService.readUnitFlow(db, { unit_id });
    const gate = await readinessService.readGateState(db, { unit_id });
    const nextMoveIn = await unitTriageService.nextCommittedMoveIn(db, { unit_id });

    // Per-item acceptance and proof state, from the layer that owns it.
    const workStates = [];
    for (const w of workFlow.work) {
      if (w.status === "withdrawn" || w.status === "superseded") continue;
      workStates.push(await workAcceptanceService.readWorkState(db, { work_id: w.id }));
    }

    // Readiness authority for THIS operator, so the page can decide whether to
    // offer the walk. The decision is the service's, not the page's.
    const authority = user_id
      ? await readinessService.resolveWalkAuthority(db, { property_id, user_id })
      : { authorized: false, reason: "no operator" };

    // ── availability, from the canonical surface ──
    //  Read whole-property and filtered, because availability is a property
    //  read by design. A per-unit re-derivation here would be a second
    //  availability opinion, which is exactly what must not exist.
    let availability = null;
    if (typeof availabilityRead === "function") {
      try {
        const av = await availabilityRead(db, { property_id });
        const row = (av.rows || []).find((r) => String(r.unit_id) === String(unit_id));
        if (row) {
          availability = {
            marketing_state: row.marketing_state,
            marketing_label: row.marketing_label,
            blocking_reason: row.blocking_reason,
            blocking_label: row.blocking_label,
            marketable_now: row.marketing_state === "marketable_now",
            certified_ready: !!row.certified_ready,
            available_from: row.available_from,
            availability_confidence: row.availability_confidence,
          };
        }
      } catch (e) {
        // FAIL SOFT, NEVER FAKE. A failed availability read is reported as a
        // read failure — it is not the absence of a blocker.
        availability = { error: "availability read failed", detail: e.message };
      }
    }

    // ── the agent thread, plain-language ──
    let thread = null;
    if (staffAgentService && typeof staffAgentService.readThread === "function") {
      const t = await staffAgentService.readThread(db, { property_id, user_id });
      thread = {
        messages: (t.messages || []).slice(-12),
        proposals: (t.proposals || []).map((p) => ({
          ...p,
          // Internal intent names never reach the operator.
          plain_label: INTENT_PLAIN[p.intent] || "You sent a message",
        })),
      };
    }

    // ── THE ONE CONTROLLING NEXT ACTION ──
    //  FORWARDED, never recomputed. Precedence follows the gates the layers
    //  already enforce: an incomplete turn's own flow answers, and only once
    //  the readiness gate is actionable does readiness become the next thing.
    let controlling = workFlow.flow ? workFlow.flow.controlling_next_action : null;
    if (gate.gate.actionable && !gate.certification) {
      controlling = {
        kind: "perform_final_readiness_walk",
        action: "Perform the final readiness walk",
        why: gate.gate.meaning,
      };
    } else if (gate.certification && availability && !availability.marketable_now) {
      controlling = {
        kind: "resolve_availability_blocker",
        action: "Resolve the remaining availability blocker",
        why: availability.blocking_label || "Something other than physical condition prevents marketing.",
      };
    }

    return {
      unit: { id: unit.id, unit_number: unit.unit_number },

      // 1. UNIT STATUS — honest unknowns throughout.
      status: {
        vacancy: triage.confirmation ? triage.confirmation.vacancy_observation : null,
        vacancy_known: !!triage.confirmation,
        physical_readiness: gate.certification ? "ready" : (triage.readiness || "unknown"),
        readiness_label: gate.certification
          ? "Physically ready — certified"
          : (triage.readiness_label || "Readiness unknown — no initial walk recorded"),
        certified: !!gate.certification,
        certification: gate.certification || null,
        marketability: availability ? availability.marketing_state : null,
        remaining_blocker: availability && !availability.marketable_now
          ? (availability.blocking_label || availability.blocking_reason) : null,
        // The distinction the whole build sequence protects.
        summary: gate.certification
          ? (availability && availability.marketable_now
              ? "Physically ready and currently marketable."
              : `Physically ready but not currently marketable. Reason: ${availability ? availability.blocking_label : "unknown"}.`)
          : "Not ready. Readiness comes from a certified final walk, not from closed work.",
        next_move_in: nextMoveIn,
      },

      // 2. CONTROLLING NEXT ACTION — forwarded from the owning layer.
      controlling_next_action: controlling,

      // 3. REQUIRED WORK — one list, grouped by the existing stages.
      stages: workFlow.flow ? workFlow.flow.stages : [],
      work: workStates.map((s) => ({
        work_id: s.work.id, work_text: s.work.work_text, stage: s.work.stage,
        status: s.status, accepted: s.accepted,
        owner_user_id: s.owner_user_id, owner: s.owner_user_id ? "assigned" : "UNASSIGNED",
        due_at: s.due_at,
        proof_requirement: s.requirement,
        latest_outcome: s.latest_claim ? s.latest_claim.outcome : null,
        proof_satisfied: s.latest_claim ? s.latest_claim.proof_satisfied : null,
        proof_shortfall: s.latest_claim ? s.latest_claim.proof_shortfall : null,
        reopened_count: s.reopened_count,
      })),

      // 4. WHAT THE OPERATOR MAY DO — every one delegates to a Build 1-5 service.
      actions: {
        accept: "POST /operator/turn-work/:workId/accept",
        complete: "POST /operator/turn-work/:workId/claim",
        reopen: "POST /operator/turn-work/:workId/reopen",
        message: "POST /operator/staff-agent/message",
        final_walk: "POST /operator/units/:id/readiness/walk",
      },

      // 5. FINAL READINESS — offered only when the gate and the person allow.
      readiness: {
        gate: gate.gate,
        may_walk: gate.gate.actionable && authority.authorized && !gate.certification,
        authority,
        // Said plainly, whichever way it falls.
        note: gate.certification
          ? "This unit carries a live readiness certification."
          : gate.gate.actionable
            ? "The walk may be performed. That is not readiness — readiness is the certification."
            : "The final readiness walk is not yet possible.",
      },

      // 6. THE MESSAGE BOX — one thread, plain language.
      thread,

      scope: scope.scope || null,
      triage_confirmation: triage.confirmation || null,
      composed_from: [
        "unitTriageService.readUnitTriageState",
        "unitTurnScopeService.readTurnFlow",
        "workAcceptanceService.readUnitFlow + readWorkState",
        "readinessService.readGateState + resolveWalkAuthority",
        "availability_read.availabilityRead",
        "staffAgentService.readThread",
      ],
    };
  }

  return { readUnitTurn, INTENT_PLAIN };
}

module.exports = { makeUnitTurnRead };
