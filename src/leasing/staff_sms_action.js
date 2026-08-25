"use strict";

const staffThread = require("../comms/staff_thread");
const { operatingReceipt } = require("../conversation/receipt");
const applicationTargetRead = require("../applications/application_target_read");
const applicationTargetAuthority = require("../applications/application_target_authority");
const applicationSendCommand = require("../applications/application_send_command");
const capability = require("../identity/capability");

const STANDING_LABEL = Object.freeze({
  ready_to_apply: "Ready to Apply",
  hot_lead: "Hot Lead",
  possible: "Possible",
  not_moving_forward: "Not Moving Forward",
});

function words(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fullNameMatches(text, name) {
  const message = ` ${words(text)} `;
  const full = words(name);
  return !!full && message.includes(` ${full} `);
}

function nameMatches(text, name) {
  const message = ` ${words(text)} `;
  const full = words(name);
  if (!full) return false;
  const meaningful = full.split(" ").filter((part) => part.length >= 3);
  return meaningful.some((part) => message.includes(` ${part} `));
}

function chooseNamedCandidate(text, candidates) {
  const exact = candidates.filter((candidate) => fullNameMatches(text, candidate.prospect_name));
  if (exact.length === 1) return { candidate: exact[0], reason: "full_name" };
  if (exact.length > 1) return { candidate: null, reason: "ambiguous_name", candidates: exact };
  const named = candidates.filter((candidate) => nameMatches(text, candidate.prospect_name));
  if (named.length === 1) return { candidate: named[0], reason: "named" };
  if (named.length > 1) return { candidate: null, reason: "ambiguous_name", candidates: named };
  if (candidates.length === 1) return { candidate: candidates[0], reason: "only_open" };
  return { candidate: null, reason: candidates.length ? "ambiguous_open" : "none", candidates };
}

function candidateLabel(candidate) {
  const unit = candidate.unit_number ? `, Unit ${candidate.unit_number}` : "";
  return `${candidate.prospect_name || "Unnamed prospect"}${unit}`;
}

function candidatePrompt(kind, candidates, standing = null) {
  if (!candidates.length) {
    return kind === "tour"
      ? "I couldn't find an unfinished tour assigned to you at this property. Nothing was recorded."
      : "I couldn't find an open post-tour application follow-up assigned to you at this property. Nothing was sent.";
  }
  const options = candidates.slice(0, 4).map(candidateLabel).join("; ");
  if (kind === "tour") {
    const label = STANDING_LABEL[standing] || "Ready to Apply";
    return `Which tour do you mean: ${options}? Reply like "Jane's tour: ${label}."`;
  }
  return `Which application follow-up do you mean: ${options}? Reply like "Send Jane the application."`;
}

async function openToursForStaff(q, { propertyId, userId }) {
  return (await q.query(
    `select t.id as tour_id, t.property_id, t.unit_id,
            coalesce(t.checked_in_at, t.scheduled_for, t.requested_for, t.created_at) as tour_at,
            p.id as person_id, p.name as prospect_name, u.unit_number
       from leasing_tours t
       join leasing_leads l on l.id = t.lead_id and l.property_id = t.property_id
       join persons p on p.id = l.person_id
       left join units u on u.id = t.unit_id and u.property_id = t.property_id
      where t.property_id = $1
        and t.leasing_agent_id = $2
        and t.status not in ('completed','no_show','cancelled','rescheduled')
        and coalesce(t.checked_in_at, t.scheduled_for, t.requested_for, t.created_at)
              <= now() + interval '15 minutes'
      order by coalesce(t.checked_in_at, t.scheduled_for, t.requested_for, t.created_at) desc,
               t.id desc
      limit 12`,
    [propertyId, userId]
  )).rows;
}

async function openApplicationFollowups(q, { propertyId, userId }) {
  return (await q.query(
    `select lc.id as conversion_id, lc.person_id, p.name as prospect_name,
            coalesce(lc.preferred_unit_id, t.unit_id) as unit_id,
            u.unit_number, lco.obligation_id
       from leasing_conversions lc
       join persons p on p.id = lc.person_id
       join leasing_conversion_obligations lco
         on lco.conversion_id = lc.id and lco.rung = 'tour_followup'
       join obligations o on o.id = lco.obligation_id
       left join leasing_tours t on t.id = lc.origin_tour_id
       left join units u on u.id = coalesce(lc.preferred_unit_id, t.unit_id)
      where lc.property_id = $1
        and lc.status = 'active'
        and o.status = 'open'
        and o.assigned_user_id = $2
      order by o.due_at asc nulls last, o.created_at asc, o.id asc
      limit 20`,
    [propertyId, userId]
  )).rows;
}

function targetLabel(target) {
  const space = String(target.space_label || "").trim();
  const whole = !space || space === "(whole unit)";
  const home = whole ? `Unit ${target.unit_number}` : `Unit ${target.unit_number}, ${space}`;
  return target.intended_move_in ? `${home} (target ${target.intended_move_in})` : home;
}

function targetMatches(text, target) {
  const message = ` ${words(text)} `;
  const namesAUnit = /\bunit\s*[#-]?\s*[a-z0-9][a-z0-9-]*\b/i.test(String(text || ""));
  const namesASpace = /\b(bed|space|room)\s*[#-]?\s*[a-z0-9][a-z0-9-]*\b/i.test(String(text || ""));
  const unit = words(target.unit_number);
  const space = words(target.space_label);
  const hasUnit = unit && message.includes(` ${unit} `);
  const whole = !space || space === "whole unit";
  const hasSpace = !whole && message.includes(` ${space} `);
  if (whole && namesASpace) return false;
  if (hasUnit && (whole || Number(target.rentable_space_count) === 1 || hasSpace)) return true;
  return !namesAUnit && !hasUnit && hasSpace;
}

function chooseTarget(text, allTargets, hintedUnitId = null) {
  const matches = allTargets.filter((target) => targetMatches(text, target));
  if (matches.length === 1) return { target: matches[0], candidates: matches };
  if (matches.length > 1) return { target: null, candidates: matches, reason: "ambiguous_target" };

  const hinted = hintedUnitId
    ? allTargets.filter((target) => String(target.unit_id) === String(hintedUnitId))
    : allTargets;
  if (hinted.length === 1) return { target: hinted[0], candidates: hinted, reason: "only_exact_target" };
  return { target: null, candidates: hinted, reason: hinted.length ? "target_required" : "no_targets" };
}

function targetPrompt(candidates, prospectName = null) {
  if (!candidates.length) {
    return "There is no currently offerable unit or bed to attach to the application, so nothing was sent.";
  }
  const options = candidates.slice(0, 6).map(targetLabel).join("; ");
  const suffix = candidates.length > 6 ? " Ask with the exact unit and bed." : "";
  const person = String(prospectName || "the prospect").trim();
  return `Which home should get the application: ${options}? Reply like "Send ${person} the application for Unit 302, Bed B."${suffix}`;
}

function leasingAllowed(propertyContext) {
  return (propertyContext && propertyContext.allowedModules || [])
    .some((moduleName) => String(moduleName).toLowerCase() === "leasing");
}

function makeStaffLeasingAction({
  getLeasingTourService,
  getConversionService,
  getApplicationInvitations,
} = {}) {
  getLeasingTourService = typeof getLeasingTourService === "function"
    ? getLeasingTourService : () => null;
  getConversionService = typeof getConversionService === "function"
    ? getConversionService : () => null;
  getApplicationInvitations = typeof getApplicationInvitations === "function"
    ? getApplicationInvitations : () => null;

  async function run(pool, {
    organizationId, userId, lineId, body, providerMessageId,
    propertyContext, clarification = null, intent,
  }) {
    const recorded = await staffThread.inTransaction(pool, (client) => staffThread.recordInbound(client, {
      organizationId, userId, lineId, body, providerMessageId,
    }));

    async function finish(outcome, result, classification, createdObject = null) {
      const operating = operatingReceipt({ outcome, result });
      if (operating.text === null) {
        throw new Error(`staff leasing receipt refused (${operating.refusal})`);
      }
      const outbound = await staffThread.inTransaction(pool, (client) => staffThread.recordReply(client, {
        threadId: recorded.threadId,
        inboundId: recorded.inbound.id,
        userId,
        lineId,
        providerMessageId,
        body: operating.text,
        replyReason: outcome === "leasing_clarification" ? "clarification" : "execution_receipt",
        classification,
        createdObject: createdObject || operating.object,
      }));
      return {
        inbound: recorded.inbound,
        outbound,
        threadId: recorded.threadId,
        operating,
        residentIntent: null,
        residentEvent: null,
      };
    }

    if (!propertyContext || !["one", "explicit_reference"].includes(propertyContext.outcome)) {
      const names = (clarification && clarification.options || [])
        .map((option) => option.name).filter(Boolean);
      const answer = names.length
        ? `Which property is this about: ${names.join(" or ")}? Please resend with the property name.`
        : "I couldn't find an active property assignment for you. Ask a manager to check your access.";
      return finish("leasing_clarification", {
        answer,
        reasonCode: "property_context_required",
        isQuestion: names.length > 0,
      }, "leasing_property_context_required");
    }

    if (!leasingAllowed(propertyContext)) {
      return finish("leasing_clarification", {
        answer: "Your assignment at this property does not include Leasing, so I did not record or send anything.",
        reasonCode: "leasing_module_required",
        isQuestion: false,
      }, "leasing_module_required");
    }

    const propertyId = propertyContext.propertyId;
    const parsed = intent || {};
    let capture = null;
    let conversion = null;

    if (["capture_tour", "clarify_tour_standing"].includes(parsed.intent)) {
      const tours = await openToursForStaff(pool, { propertyId, userId });
      const choice = chooseNamedCandidate(body, tours);
      if (!choice.candidate) {
        return finish("leasing_clarification", {
          answer: candidatePrompt("tour", choice.candidates || [], parsed.standing),
          reasonCode: choice.reason,
          isQuestion: choice.reason !== "none",
        }, `leasing_tour_${choice.reason}`);
      }

      if (parsed.intent === "clarify_tour_standing" || !parsed.standing) {
        return finish("leasing_clarification", {
          answer: `Where did ${choice.candidate.prospect_name} land: Ready to Apply, Hot Lead, Possible, or Not Moving Forward? Reply like "${choice.candidate.prospect_name}'s tour: Ready to Apply."`,
          reasonCode: "standing_required",
          isQuestion: true,
        }, "leasing_tour_standing_required");
      }

      const tourService = getLeasingTourService();
      if (!tourService || typeof tourService.completeTour !== "function") {
        throw new Error("canonical tour completion service is unavailable");
      }
      const completed = await staffThread.inTransaction(pool, (client) => tourService.completeTour(client, {
        tourId: choice.candidate.tour_id,
        recordedByUserId: userId,
        enforcePropertyId: propertyId,
        b: {
          actual_tour_host_user_id: userId,
          follow_up_owner_user_id: userId,
          idempotency_key: `staff-sms-tour:${providerMessageId || recorded.inbound.id}`,
          feedback: {
            tour_given: true,
            standing: parsed.standing,
          },
        },
      }));
      capture = {
        tourId: completed.tour_id,
        conversionId: completed.conversion_id,
        prospectName: choice.candidate.prospect_name,
        standing: parsed.standing,
        standingLabel: STANDING_LABEL[parsed.standing],
        unitId: choice.candidate.unit_id,
      };
      conversion = {
        conversion_id: completed.conversion_id,
        person_id: choice.candidate.person_id,
        prospect_name: choice.candidate.prospect_name,
        unit_id: choice.candidate.unit_id,
      };
    }

    if (!parsed.sendApplication) {
      return finish("tour_outcome_recorded", {
        tourId: capture.tourId,
        conversionId: capture.conversionId,
        prospectName: capture.prospectName,
        standingLabel: capture.standingLabel,
        nextPrompt: null,
      }, "leasing_tour_outcome_recorded");
    }

    if (!conversion) {
      const followups = await openApplicationFollowups(pool, { propertyId, userId });
      const choice = chooseNamedCandidate(body, followups);
      if (!choice.candidate) {
        return finish("leasing_clarification", {
          answer: candidatePrompt("application", choice.candidates || []),
          reasonCode: choice.reason,
          isQuestion: choice.reason !== "none",
        }, `leasing_application_${choice.reason}`);
      }
      conversion = choice.candidate;
    }

    const targetMenu = await applicationTargetRead.leaseableApplicationTargets(pool, {
      property_id: propertyId,
    });
    const targetChoice = chooseTarget(
      body,
      targetMenu.eligible_targets,
      conversion.unit_id || null
    );
    if (!targetChoice.target) {
      const prompt = targetPrompt(targetChoice.candidates || [], conversion.prospect_name);
      if (capture) {
        return finish("tour_outcome_recorded", {
          tourId: capture.tourId,
          conversionId: capture.conversionId,
          prospectName: capture.prospectName,
          standingLabel: capture.standingLabel,
          nextPrompt: prompt,
        }, "leasing_tour_recorded_target_required");
      }
      return finish("leasing_clarification", {
        answer: prompt,
        reasonCode: targetChoice.reason,
        isQuestion: targetChoice.reason !== "no_targets",
      }, `leasing_${targetChoice.reason}`);
    }

    const conversionService = getConversionService();
    const applicationInvitations = getApplicationInvitations();
    if (!conversionService || !applicationInvitations) {
      throw new Error("canonical application send services are unavailable");
    }

    let staged;
    let gateRefusal = null;
    await staffThread.inTransaction(pool, async (client) => {
      const locked = (await client.query(
        `select lc.id, lc.property_id, lc.person_id
           from leasing_conversions lc
           join leasing_conversion_obligations lco
             on lco.conversion_id = lc.id and lco.rung = 'tour_followup'
           join obligations o on o.id = lco.obligation_id
          where lc.id = $1 and lc.property_id = $2
            and o.status = 'open' and o.assigned_user_id = $3
          for update of lc`,
        [conversion.conversion_id, propertyId, userId]
      )).rows[0];
      if (!locked) {
        gateRefusal = "That post-tour application follow-up is no longer open and assigned to you. Nothing was sent.";
        return;
      }

      const birth = await capability.evaluateApplicationLinkBirth(client, {
        property_id: propertyId,
        person_id: locked.person_id,
      });
      if (!birth.allowed) {
        gateRefusal = birth.display_reason || "Application sending is not active for this property yet.";
        return;
      }

      staged = await applicationSendCommand.stageApplicationSend(
        client,
        { conversionService, applicationInvitations },
        {
          conversionId: locked.id,
          actorUserId: userId,
          unitId: targetChoice.target.unit_id,
          spaceId: targetChoice.target.space_id,
          intendedMoveIn: targetChoice.target.intended_move_in,
          idempotencyKey: `staff-sms-application:${providerMessageId || recorded.inbound.id}`,
          unitOfferable: async (q, { property_id, unit_id, space_id, intended_move_in }) =>
            applicationTargetAuthority.resolveApplicationTarget(q, {
              property_id,
              unit_id,
              space_id,
              intended_move_in,
              require_offerable: true,
            }),
        }
      );
    });

    if (!staged) {
      if (capture) {
        return finish("tour_outcome_recorded", {
          tourId: capture.tourId,
          conversionId: capture.conversionId,
          prospectName: capture.prospectName,
          standingLabel: capture.standingLabel,
          nextPrompt: `I did not send the application. ${gateRefusal}`,
        }, "leasing_tour_recorded_application_refused");
      }
      return finish("leasing_clarification", {
        answer: gateRefusal,
        reasonCode: "application_birth_refused",
        isQuestion: false,
      }, "leasing_application_birth_refused");
    }

    let dispatched;
    try {
      dispatched = await applicationSendCommand.dispatchApplicationSend(
        { applicationInvitations },
        staged,
        { actorUserId: userId }
      );
    } catch (error) {
      dispatched = { dispatched: false, error: error.publicMessage || error.message };
    }

    return finish("application_invitation_prepared", {
      invitationId: staged.invitation_id,
      prospectName: conversion.prospect_name,
      targetLabel: targetLabel(targetChoice.target),
      dispatched: !!(dispatched && dispatched.dispatched),
      capture: capture ? {
        tourId: capture.tourId,
        standingLabel: capture.standingLabel,
      } : null,
    }, "leasing_application_prepared");
  }

  return Object.freeze({
    run,
    _private: {
      openToursForStaff,
      openApplicationFollowups,
      chooseNamedCandidate,
      candidatePrompt,
      chooseTarget,
      targetLabel,
      targetPrompt,
      leasingAllowed,
    },
  });
}

module.exports = { makeStaffLeasingAction };
