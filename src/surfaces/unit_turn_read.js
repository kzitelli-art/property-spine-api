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
    //  Safe metadata only. Bytes never pass through this read — they leave
    //  through GET /operator/turn-work/:workId/proof/:attachmentId.
    workProofAttachmentService,
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

  //  Plain operating language for the agent's internal intent names, FORWARDED
  //  from the module that defines those names. Re-declaring the map here would
  //  let the thread and the page drift into two different vocabularies for one
  //  message. (BUILD 6B: it was declared here in 6A; it is imported now.)
  const {
    INTENT_PLAIN, needsClarification, statusLabel, CLARIFICATION_LABEL,
  } = require("../agent/staff_agent_intent");

  //  BUILD 6B: `stage_decision_required` is our column name, not a sentence. An
  //  operator sees a place in the turn flow, not a decision record.
  const PLACEMENT_LABEL = "Needs placement in the turn flow";

  //  `allowed_modules` is SERVER-DERIVED — it comes from the session's active
  //  property_team_assignments row, never from the request. It arrives here so
  //  the SERVER decides which controls exist; the browser renders that decision
  //  and reproduces none of the rule.
  async function readUnitTurn(db, { property_id, unit_id, user_id, allowed_modules = null }) {
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

    // The sequence engine already decided which items are unplaced. Indexed,
    // never recomputed.
    const flowItems = new Map(
      (((workFlow.flow && workFlow.flow.items) || [])).map((i) => [String(i.work_id), i]));

    // Per-item acceptance and proof state, from the layer that owns it.
    const workStates = [];
    const proofByWork = new Map();
    for (const w of workFlow.work) {
      if (w.status === "withdrawn" || w.status === "superseded") continue;
      workStates.push(await workAcceptanceService.readWorkState(db, { work_id: w.id }));
      if (workProofAttachmentService && typeof workProofAttachmentService.metadataForWork === "function") {
        proofByWork.set(String(w.id), await workProofAttachmentService.metadataForWork(db, { work_id: w.id }));
      }
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
          // ONE operator concept: `clarification_required` and `unclear` are
          // the same situation with the same response — answer one question.
          needs_clarification: needsClarification(p),
          status_label: statusLabel(p),
        })),
        // The three things a message may do. Stated by the server so the app
        // cannot advertise a fourth.
        message_purposes: [
          "Report a condition",
          "Add or correct turn scope",
          "Report completed work",
        ],
        message_excludes: [
          "Taking on work is a tap on the work item, not a sentence.",
          "Readiness comes from the final readiness walk, not from a message.",
        ],
        clarification_label: CLARIFICATION_LABEL,
      };
    }

    //  Server-derived modules. Never from the request body.
    const mods = Array.isArray(allowed_modules) ? allowed_modules.filter(Boolean) : [];

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
        //  BUILD 6B: `marketable_now` is a state name, not a sentence. The
        //  availability read already computes the operator label — the page was
        //  printing the enum next to it. A failed read says so; it never reads
        //  as an empty answer.
        marketability_label: availability
          ? (availability.error
              ? "Availability could not be read"
              : (availability.marketing_label || availability.marketing_state || null))
          : null,
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
      work: workStates.map((s) => {
        // FORWARDED from the sequence flow, which decided it. Nothing here
        // re-derives whether an item is placed.
        const fi = flowItems.get(String(s.work.id));
        const needsPlacement = !!(fi && fi.requires_scope_decision);
        return {
          work_id: s.work.id, work_text: s.work.work_text, stage: s.work.stage,
          status: s.status, accepted: s.accepted,
          owner_user_id: s.owner_user_id, owner: s.owner_user_id ? "assigned" : "UNASSIGNED",
          due_at: s.due_at,
          proof_requirement: s.requirement,
          latest_outcome: s.latest_claim ? s.latest_claim.outcome : null,
          proof_satisfied: s.latest_claim ? s.latest_claim.proof_satisfied : null,
          proof_shortfall: s.latest_claim ? s.latest_claim.proof_shortfall : null,
          reopened_count: s.reopened_count,
          // BUILD 6B: plain language for the same underlying field. The column
          // is unchanged; only what the operator reads changed.
          needs_placement: needsPlacement,
          placement_label: needsPlacement ? PLACEMENT_LABEL : null,
          placement_action: needsPlacement
            ? `Place "${s.work.work_text}" in the turn sequence` : null,
          placement_explanation: fi ? fi.placement_explanation || null : null,
          placement_note: fi ? fi.stage_decision_note || null : null,
          //  The completion photo, as metadata and a path. No bytes, no host,
          //  no signature — the governed read decides who may see it.
          proof_photos: proofByWork.get(String(s.work.id)) || [],
        };
      }),

      // 4. WHAT THE OPERATOR MAY DO — every one delegates to a Build 1-5 service.
      actions: {
        accept: "POST /operator/turn-work/:workId/accept",
        complete: "POST /operator/turn-work/:workId/claim",
        reopen: "POST /operator/turn-work/:workId/reopen",
        message: "POST /operator/staff-agent/message",
        final_walk: "POST /operator/units/:id/readiness/walk",
      },

      // 4b. CAPABILITIES — WHAT THIS OPERATOR MAY ACTUALLY DO
      //
      //  The doors do not agree on who may operate a turn: Builds 1-3 require
      //  `maintenance`, Builds 4-6A accept `maintenance` OR `management`. So a
      //  management-only operator could open this page and be shown Accept,
      //  Complete, Unable and Reopen — every one of which the write door would
      //  refuse. A surface offering an action the server will reject is the
      //  same class of defect as a fake number.
      //
      //  The read now states each capability explicitly. FAIL CLOSED: with no
      //  modules resolved, nothing is offered. Hiding a control is NOT the
      //  enforcement — every write route still enforces for itself, and must.
      //  ── THE RULED MATRIX, IN ONE PLACE ──────────────────────────────
      //
      //    maintenance only                       read ✓  operate ✓  proof ✓  certify ✗
      //    management only, no manager authority  read ✓  operate ✗  proof ✓  certify ✗
      //    management only, manager or delegated  read ✓  operate ✗  proof ✓  certify ✓ (gate actionable)
      //    maintenance + management, delegated    read ✓  operate ✓  proof ✓  certify ✓ (gate actionable)
      //    neither                                read ✗  operate ✗  proof ✗  certify ✗
      //
      //  READING PROOF IS NOT OPERATING. A manager reviewing a closed job must
      //  be able to look at the photo; they may not record that work was done.
      //  CERTIFYING IS NOT OPERATING EITHER, and it runs the other way — it is
      //  a management authority the maintenance module does not confer.
      capabilities: {
        //  Operating work needs maintenance AND an active assignment at this
        //  property. `allowed_modules` only exists when the session resolved an
        //  active assignment here, so the module test carries both.
        may_operate_work: mods.includes("maintenance"),
        //  Maintenance OR management — the same test the governed read route
        //  applies, stated here so the page never renders a thumbnail whose
        //  bytes the server would refuse.
        may_read_proof: mods.includes("maintenance") || mods.includes("management"),
        //  Unchanged implementation. Certification needs management authority
        //  the module list alone does not settle: an eligible manager
        //  assignment or an explicit delegation, AND an actionable gate.
        may_perform_readiness_walk: gate.gate.actionable && authority.authorized && !gate.certification,
        may_view_management_attention: mods.includes("management"),
        basis: mods.length
          ? `modules at this property: ${mods.join(", ")}`
          : "no active assignment resolved for this operator at this property",
        //  Said plainly so the page can explain a missing control rather than
        //  silently omitting it.
        why_no_work_controls: mods.includes("maintenance") ? null
          : "Accepting, completing and reopening turn work requires maintenance-module access at this property. " +
            "Management access can read this turn and view completion photos.",
        why_no_readiness_walk: (gate.gate.actionable && authority.authorized && !gate.certification)
          ? null
          : (authority.authorized
              ? "The readiness gate is not actionable yet."
              : "Certifying readiness requires an eligible manager assignment or an explicit delegation at this property."),
        enforcement_note:
          "These are server decisions about what to SHOW. Every write route enforces its own authority independently, " +
          "and recording a completion is refused inside the canonical service itself — not only at the door.",
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
