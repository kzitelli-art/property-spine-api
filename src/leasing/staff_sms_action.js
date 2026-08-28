"use strict";

const crypto = require("crypto");
const staffThread = require("../comms/staff_thread");
const { operatingReceipt } = require("../conversation/receipt");
const applicationTargetRead = require("../applications/application_target_read");
const applicationTargetAuthority = require("../applications/application_target_authority");
const applicationSendCommand = require("../applications/application_send_command");
const capability = require("../identity/capability");
const staffLeasingIntent = require("./staff_sms_intent");

const ACTION_CODE = "send_application_after_tour";
const PROCESS_LOCAL_CONFIRMATION_KEY = crypto.randomBytes(32);

class ConversationalActionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ConversationalActionError";
    this.httpStatus = status;
    this.code = code;
    this.publicMessage = message;
  }
}

function confirmationKey(secret) {
  if (typeof secret === "string" && secret.trim()) {
    return crypto.createHash("sha256").update(secret.trim(), "utf8").digest();
  }
  return Buffer.from(PROCESS_LOCAL_CONFIRMATION_KEY);
}

function confirmationTtlSeconds(value) {
  const parsed = Number(value == null ? process.env.CONVERSATIONAL_ACTION_TTL_SECONDS : value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 300;
}

function makeConfirmationCodec({ secret = null, ttlSeconds = null, now = Date.now } = {}) {
  const key = confirmationKey(secret);
  const ttl = confirmationTtlSeconds(ttlSeconds);

  function mint(claims) {
    const expiresAt = Math.floor(now() / 1000) + ttl;
    const body = {
      version: 1,
      action_code: ACTION_CODE,
      property_id: String(claims.property_id),
      actor_user_id: String(claims.actor_user_id),
      conversion_id: String(claims.conversion_id),
      unit_id: String(claims.unit_id),
      space_id: claims.space_id == null ? null : String(claims.space_id),
      intended_move_in: claims.intended_move_in == null
        ? null : String(claims.intended_move_in),
      nonce: crypto.randomBytes(16).toString("base64url"),
      expires_at: expiresAt,
    };
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(body), "utf8"), cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      token: ["sca1", iv.toString("base64url"), ciphertext.toString("base64url"),
        tag.toString("base64url")].join("."),
      expires_at: new Date(expiresAt * 1000).toISOString(),
    };
  }

  function open(token) {
    let claims;
    try {
      const parts = String(token || "").split(".");
      if (parts.length !== 4 || parts[0] !== "sca1") throw new Error("bad shape");
      const iv = Buffer.from(parts[1], "base64url");
      const ciphertext = Buffer.from(parts[2], "base64url");
      const tag = Buffer.from(parts[3], "base64url");
      if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("bad bytes");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      claims = JSON.parse(Buffer.concat([
        decipher.update(ciphertext), decipher.final(),
      ]).toString("utf8"));
    } catch (_) {
      throw new ConversationalActionError(
        400, "confirmation_invalid", "That application confirmation is invalid. Nothing was sent."
      );
    }
    const keys = ["action_code", "actor_user_id", "conversion_id", "expires_at",
      "intended_move_in", "nonce", "property_id", "space_id", "unit_id", "version"];
    if (Object.keys(claims).sort().join(",") !== keys.sort().join(",") ||
        claims.version !== 1 || claims.action_code !== ACTION_CODE ||
        !claims.property_id || !claims.actor_user_id || !claims.conversion_id ||
        !claims.unit_id || !claims.nonce || !Number.isInteger(claims.expires_at)) {
      throw new ConversationalActionError(
        400, "confirmation_invalid", "That application confirmation is invalid. Nothing was sent."
      );
    }
    if (claims.expires_at <= Math.floor(now() / 1000)) {
      throw new ConversationalActionError(
        410, "confirmation_expired", "That application confirmation expired. Nothing was sent; ask again for a fresh proposal."
      );
    }
    return claims;
  }

  return Object.freeze({ mint, open, ttlSeconds: ttl });
}

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
  const namesAUnit = /\bunit\s*[#-]?\s*[a-z0-9][a-z0-9-]*\b/i.test(String(text || ""));
  const candidates = hintedUnitId && !namesAUnit
    ? allTargets.filter((target) => String(target.unit_id) === String(hintedUnitId))
    : allTargets;
  const matches = candidates.filter((target) => targetMatches(text, target));
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
  confirmationSecret = process.env.CONVERSATIONAL_ACTION_SECRET || null,
  confirmationTtlSeconds = null,
  confirmationNow = Date.now,
} = {}) {
  getLeasingTourService = typeof getLeasingTourService === "function"
    ? getLeasingTourService : () => null;
  getConversionService = typeof getConversionService === "function"
    ? getConversionService : () => null;
  getApplicationInvitations = typeof getApplicationInvitations === "function"
    ? getApplicationInvitations : () => null;
  const confirmationCodec = makeConfirmationCodec({
    secret: confirmationSecret,
    ttlSeconds: confirmationTtlSeconds,
    now: confirmationNow,
  });

  function requireActionContext({ propertyContext, userId }) {
    if (!userId) {
      throw new ConversationalActionError(
        401, "staff_session_required", "A signed-in staff session is required. Nothing was sent."
      );
    }
    if (!propertyContext || !["one", "explicit_reference"].includes(propertyContext.outcome)
        || !propertyContext.propertyId) {
      throw new ConversationalActionError(
        403, "property_context_required", "A server-derived property assignment is required. Nothing was sent."
      );
    }
    if (!leasingAllowed(propertyContext)) {
      throw new ConversationalActionError(
        403, "leasing_module_required",
        "Your assignment at this property does not include Leasing. Nothing was sent."
      );
    }
    return String(propertyContext.propertyId);
  }

  async function issueApplicationProposal(pool, {
    propertyId, userId, conversionId, target,
  }) {
    const row = (await pool.query(
      `select lc.id, lc.person_id, p.name as prospect_name
         from leasing_conversions lc
         join persons p on p.id=lc.person_id
         join leasing_conversion_obligations lco
           on lco.conversion_id=lc.id and lco.rung='tour_followup'
         join obligations o on o.id=lco.obligation_id
        where lc.id=$1 and lc.property_id=$2 and lc.status='active'
          and o.status='open' and o.assigned_user_id=$3
        limit 1`,
      [conversionId, propertyId, userId]
    )).rows[0];
    if (!row) {
      throw new ConversationalActionError(
        409, "post_tour_followup_unavailable",
        "That post-tour application follow-up is no longer open and assigned to you. Nothing was sent."
      );
    }

    const birth = await capability.evaluateApplicationLinkBirth(pool, {
      property_id: propertyId,
      person_id: row.person_id,
    });
    if (!birth.allowed) {
      throw new ConversationalActionError(
        409, "application_birth_refused",
        birth.display_reason || "Application sending is not active for this property yet."
      );
    }

    const targetState = await applicationTargetAuthority.resolveApplicationTarget(pool, {
      property_id: propertyId,
      unit_id: target.unit_id,
      space_id: target.space_id,
      intended_move_in: target.intended_move_in,
      require_offerable: true,
    });
    if (!targetState || targetState.offerable === false || targetState.ok === false) {
      throw new ConversationalActionError(
        (targetState && targetState.httpStatus) || 409,
        (targetState && targetState.refusal_code) || "application_target_unavailable",
        (targetState && (targetState.refusal_reason || targetState.reason)) ||
          "That home is no longer offerable. Nothing was sent."
      );
    }

    const minted = confirmationCodec.mint({
      property_id: propertyId,
      actor_user_id: userId,
      conversion_id: row.id,
      unit_id: target.unit_id,
      space_id: target.space_id,
      intended_move_in: target.intended_move_in,
    });
    const label = targetLabel(target);
    return Object.freeze({
      action_code: ACTION_CODE,
      confirmation_required: true,
      confirmation: minted.token,
      expires_at: minted.expires_at,
      prospect_name: row.prospect_name,
      target_label: label,
      sms_prompt: `Nothing was sent. Reply "Confirm ${minted.token}" to send ${row.prospect_name} the application for ${label}.`,
      receipt: `Ready to send ${row.prospect_name} the application for ${label}. Nothing was sent; explicit confirmation is required.`,
      _conversion_id: row.id,
    });
  }

  async function priorConfirmationUse(db, { propertyId, userId, conversionId, idempotencyKey }) {
    const sourceIdentity = `operator_recorded:${propertyId}:${conversionId}:${userId}:${idempotencyKey}`;
    return (await db.query(
      `select ai.id as intent_id, p.name as prospect_name,
              inv.id as invitation_id, inv.status as invitation_status,
              u.unit_number, s.space_label
         from application_intents ai
         join leasing_conversions lc on lc.id=ai.conversion_id
         join persons p on p.id=lc.person_id
         left join application_invitations inv on inv.conversion_id=ai.conversion_id
          and inv.status in ('prepared','manually_sent','provider_dispatched','consumed')
         left join units u on u.id=inv.unit_id
         left join spaces s on s.id=inv.space_id
        where ai.property_id=$1 and ai.source='operator_recorded'
          and ai.source_identity=$2
        order by inv.created_at desc nulls last limit 1`,
      [propertyId, sourceIdentity]
    )).rows[0] || null;
  }

  function usedConfirmationResult(prior) {
    const target = prior && prior.unit_number
      ? `Unit ${prior.unit_number}${prior.space_label ? `, ${prior.space_label}` : ""}`
      : "the selected home";
    const sent = prior && ["manually_sent", "provider_dispatched", "consumed"]
      .includes(prior.invitation_status);
    return Object.freeze({
      kind: "confirmation_refused",
      http_status: 409,
      outcome: "confirmation_used",
      action_code: ACTION_CODE,
      confirmation_required: false,
      sent: false,
      replayed: true,
      receipt: sent
        ? `This confirmation was already used. The application was already sent to ${prior.prospect_name} for ${target}; no second send occurred.`
        : "This confirmation was already used. No second application action occurred.",
    });
  }

  async function confirmApplication(pool, {
    userId, propertyContext, confirmation,
  }) {
    const propertyId = requireActionContext({ propertyContext, userId });
    const claims = confirmationCodec.open(confirmation);
    if (String(claims.property_id) !== propertyId) {
      throw new ConversationalActionError(
        403, "confirmation_property_mismatch", "That confirmation belongs to another property. Nothing was sent."
      );
    }
    if (String(claims.actor_user_id) !== String(userId)) {
      throw new ConversationalActionError(
        403, "confirmation_actor_mismatch", "That confirmation belongs to another staff session. Nothing was sent."
      );
    }

    const idempotencyKey = `conversational-confirmation:${claims.nonce}`;
    const already = await priorConfirmationUse(pool, {
      propertyId, userId, conversionId: claims.conversion_id, idempotencyKey,
    });
    if (already) return usedConfirmationResult(already);

    const conversionService = getConversionService();
    const applicationInvitations = getApplicationInvitations();
    if (!conversionService || !applicationInvitations) {
      throw new ConversationalActionError(
        503, "application_service_unavailable", "The canonical application-send service is unavailable. Nothing was sent."
      );
    }

    const client = await pool.connect();
    let staged;
    let prospectName;
    let confirmedTargetLabel = "the selected home";
    try {
      await client.query("begin");
      const raced = await priorConfirmationUse(client, {
        propertyId, userId, conversionId: claims.conversion_id, idempotencyKey,
      });
      if (raced) {
        await client.query("rollback");
        return usedConfirmationResult(raced);
      }

      const locked = (await client.query(
        `select lc.id, lc.person_id, p.name as prospect_name
           from leasing_conversions lc
           join persons p on p.id=lc.person_id
           join leasing_conversion_obligations lco
             on lco.conversion_id=lc.id and lco.rung='tour_followup'
           join obligations o on o.id=lco.obligation_id
          where lc.id=$1 and lc.property_id=$2 and lc.status='active'
            and o.status='open' and o.assigned_user_id=$3
          for update of lc`,
        [claims.conversion_id, propertyId, userId]
      )).rows[0];
      if (!locked) {
        throw new ConversationalActionError(
          409, "post_tour_followup_unavailable",
          "That post-tour application follow-up is no longer open and assigned to you. Nothing was sent."
        );
      }
      prospectName = locked.prospect_name;

      const targetName = (await client.query(
        `select u.unit_number, s.space_label
           from units u
           left join spaces s on s.id=$3 and s.unit_id=u.id
          where u.id=$1 and u.property_id=$2`,
        [claims.unit_id, propertyId, claims.space_id]
      )).rows[0];
      if (!targetName || (claims.space_id && !targetName.space_label)) {
        throw new ConversationalActionError(
          409, "application_target_unavailable",
          "That application target is no longer available at this property. Nothing was sent."
        );
      }
      confirmedTargetLabel = targetLabel({
        unit_number: targetName.unit_number,
        space_label: targetName.space_label,
        intended_move_in: claims.intended_move_in,
      });

      const birth = await capability.evaluateApplicationLinkBirth(client, {
        property_id: propertyId,
        person_id: locked.person_id,
      });
      if (!birth.allowed) {
        throw new ConversationalActionError(
          409, "application_birth_refused",
          birth.display_reason || "Application sending is not active for this property yet."
        );
      }

      staged = await applicationSendCommand.stageApplicationSend(
        client,
        { conversionService, applicationInvitations },
        {
          conversionId: locked.id,
          actorUserId: userId,
          unitId: claims.unit_id,
          spaceId: claims.space_id,
          intendedMoveIn: claims.intended_move_in,
          idempotencyKey,
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
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const dispatched = await applicationSendCommand.dispatchApplicationSend(
      { applicationInvitations }, staged, { actorUserId: userId }
    );
    const sent = !!(dispatched && dispatched.dispatched);
    return Object.freeze({
      kind: "application_sent",
      http_status: sent ? 200 : 409,
      outcome: sent ? "application_sent" : "application_send_failed",
      action_code: ACTION_CODE,
      confirmation_required: false,
      sent,
      replayed: false,
      receipt: sent
        ? `Application sent to ${prospectName} for ${confirmedTargetLabel}.`
        : (dispatched && dispatched.receipt) || "The application was prepared, but the tenant text did not send.",
      invitation_id: staged.invitation_id,
      prospect_name: prospectName,
      target_label: confirmedTargetLabel,
      dispatched,
    });
  }

  async function run(pool, {
    organizationId, userId, lineId, body, providerMessageId,
    propertyContext, clarification = null, intent, transport = "sms",
  }) {
    if (!["sms", "dashboard"].includes(transport)) {
      throw new Error(`unsupported staff leasing transport ${transport}`);
    }
    const recorded = transport === "sms"
      ? await staffThread.inTransaction(pool, (client) => staffThread.recordInbound(client, {
          organizationId, userId, lineId, body, providerMessageId,
        }))
      : null;
    const actionRequestId = providerMessageId ||
      (recorded && recorded.inbound && recorded.inbound.id) || crypto.randomUUID();

    async function finish(outcome, result, classification, createdObject = null, extra = null) {
      const operating = operatingReceipt({ outcome, result });
      if (operating.text === null) {
        throw new Error(`staff leasing receipt refused (${operating.refusal})`);
      }
      if (transport === "dashboard") {
        const detail = extra || {};
        return {
          http_status: detail.http_status || 200,
          outcome: detail.outcome || outcome,
          action_code: detail.action_code || null,
          confirmation_required: detail.confirmation_required === true,
          confirmation: detail.confirmation ? {
            token: detail.confirmation,
            expires_at: detail.expires_at,
          } : null,
          receipt: detail.receipt || operating.text,
          subject: detail.prospect_name ? { display_name: detail.prospect_name } : null,
          target: detail.target_label ? { label: detail.target_label } : null,
          sent: detail.sent === true,
          replayed: detail.replayed === true,
        };
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
        action: extra || null,
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
      }, "leasing_property_context_required", null, transport === "dashboard" ? {
        http_status: 403,
        outcome: "property_context_required",
        action_code: ACTION_CODE,
        confirmation_required: false,
        sent: false,
        replayed: false,
        receipt: answer,
      } : null);
    }

    if (!leasingAllowed(propertyContext)) {
      const answer = "Your assignment at this property does not include Leasing, so I did not record or send anything.";
      return finish("leasing_clarification", {
        answer,
        reasonCode: "leasing_module_required",
        isQuestion: false,
      }, "leasing_module_required", null, transport === "dashboard" ? {
        http_status: 403,
        outcome: "leasing_module_required",
        action_code: ACTION_CODE,
        confirmation_required: false,
        sent: false,
        replayed: false,
        receipt: answer,
      } : null);
    }

    const propertyId = propertyContext.propertyId;
    const parsed = intent || staffLeasingIntent.readStaffLeasingIntent(body);
    let capture = null;
    let conversion = null;

    if (parsed.intent === "confirm_application") {
      try {
        const confirmed = await confirmApplication(pool, {
          userId, propertyContext, confirmation: parsed.confirmation,
        });
        if (confirmed.kind === "application_sent") {
          return finish("application_invitation_prepared", {
            invitationId: confirmed.invitation_id,
            prospectName: confirmed.prospect_name,
            targetLabel: confirmed.target_label || "the selected home",
            dispatched: confirmed.sent,
            capture: null,
          }, "leasing_application_confirmed", null, confirmed);
        }
        return finish("leasing_clarification", {
          answer: confirmed.receipt,
          reasonCode: confirmed.outcome,
          isQuestion: false,
        }, `leasing_${confirmed.outcome}`, null, confirmed);
      } catch (error) {
        if (!(error instanceof ConversationalActionError)) throw error;
        return finish("leasing_clarification", {
          answer: error.publicMessage,
          reasonCode: error.code,
          isQuestion: false,
        }, `leasing_${error.code}`, null, {
          http_status: error.httpStatus,
          outcome: error.code,
          action_code: ACTION_CODE,
          confirmation_required: false,
          sent: false,
          replayed: false,
          receipt: error.publicMessage,
        });
      }
    }

    if (!["capture_tour", "clarify_tour_standing", "send_application", "application_target"]
      .includes(parsed.intent)) {
      const answer = "That request is outside the one supported conversational action. Nothing was recorded or sent.";
      return finish("leasing_clarification", {
        answer,
        reasonCode: "unsupported_action",
        isQuestion: false,
      }, "leasing_unsupported_action", null, {
        http_status: 422,
        outcome: "unsupported_action",
        action_code: null,
        confirmation_required: false,
        receipt: answer,
      });
    }

    if (["capture_tour", "clarify_tour_standing"].includes(parsed.intent)) {
      const tours = await openToursForStaff(pool, { propertyId, userId });
      const choice = chooseNamedCandidate(body, tours);
      if (transport === "dashboard" && choice.reason === "only_open") {
        choice.candidate = null;
        choice.reason = "subject_required";
        choice.candidates = tours;
      }
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
          idempotency_key: `staff-conversation-tour:${actionRequestId}`,
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
      let nextPrompt = null;
      let proposal = null;
      if (capture && parsed.standing === "ready_to_apply" && parsed.hasTarget) {
        try {
          const targetMenu = await applicationTargetRead.leaseableApplicationTargets(pool, {
            property_id: propertyId,
          });
          const targetChoice = chooseTarget(
            body,
            targetMenu.eligible_targets,
            capture.unitId || null
          );
          if (targetChoice.target) {
            proposal = await issueApplicationProposal(pool, {
              propertyId,
              userId,
              conversionId: capture.conversionId,
              target: targetChoice.target,
            });
            nextPrompt = proposal.sms_prompt;
          } else {
            nextPrompt = targetPrompt(targetChoice.candidates || [], capture.prospectName);
          }
        } catch (error) {
          nextPrompt = error instanceof ConversationalActionError
            ? error.publicMessage
            : "I couldn't read the application targets just now. Nothing was sent. Try the application request again.";
        }
      }
      return finish("tour_outcome_recorded", {
        tourId: capture.tourId,
        conversionId: capture.conversionId,
        prospectName: capture.prospectName,
        standingLabel: capture.standingLabel,
        nextPrompt,
      }, "leasing_tour_outcome_recorded", null, proposal ? {
        ...proposal,
        outcome: "tour_outcome_recorded",
        receipt: null,
        sent: false,
        replayed: false,
      } : null);
    }

    if (!conversion) {
      const followups = await openApplicationFollowups(pool, { propertyId, userId });
      const choice = chooseNamedCandidate(body, followups);
      if (transport === "dashboard" && choice.reason === "only_open") {
        choice.candidate = null;
        choice.reason = "subject_required";
        choice.candidates = followups;
      }
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

    try {
      const proposal = await issueApplicationProposal(pool, {
        propertyId,
        userId,
        conversionId: conversion.conversion_id,
        target: targetChoice.target,
      });
      return finish("leasing_clarification", {
        answer: proposal.sms_prompt,
        reasonCode: "application_confirmation_required",
        isQuestion: true,
      }, "leasing_application_confirmation_required", {
        type: "leasing_conversion",
        id: conversion.conversion_id,
      }, {
        ...proposal,
        outcome: "application_send_proposed",
        sent: false,
        replayed: false,
      });
    } catch (error) {
      if (!(error instanceof ConversationalActionError)) throw error;
      return finish("leasing_clarification", {
        answer: error.publicMessage,
        reasonCode: error.code,
        isQuestion: false,
      }, `leasing_${error.code}`, null, {
        http_status: error.httpStatus,
        outcome: error.code,
        action_code: ACTION_CODE,
        confirmation_required: false,
        sent: false,
        replayed: false,
        receipt: error.publicMessage,
      });
    }
  }

  return Object.freeze({
    run,
    ACTION_CODE,
    _private: {
      openToursForStaff,
      openApplicationFollowups,
      chooseNamedCandidate,
      candidatePrompt,
      chooseTarget,
      targetLabel,
      targetPrompt,
      leasingAllowed,
      issueApplicationProposal,
      confirmApplication,
      confirmationCodec,
    },
  });
}

module.exports = {
  makeStaffLeasingAction,
  ACTION_CODE,
  ConversationalActionError,
  _private: { makeConfirmationCodec },
};
