"use strict";

const crypto = require("crypto");

const RULE_KINDS = Object.freeze(["policy", "sop", "guardrail"]);
const SOURCE_TYPES = Object.freeze([
  "management_policy",
  "lease_or_addendum",
  "verified_operator_confirmation",
  "other_documented_source",
]);
const GENERATION_SURFACES = Object.freeze([
  "first_response",
  "ongoing_reply",
  "regenerated_reply",
]);
const CONTRACT_VERSION = "governed_operating_context_leasing_v1";

// Explicit effective-state vocabulary (mandatory correction #4). `status` on
// the row only ever says active|retired — it says nothing about whether a
// scheduled-future or already-expired row is actually governing generation
// right now. Every read that shows a rule to an operator must use this, never
// raw `status`, or a future/expired row reads as "active" when it is not.
const EFFECTIVE_STATES = Object.freeze(["active_now", "scheduled", "expired", "retired"]);

// Prompt/rule budget (mandatory correction #5). Every active rule is appended
// verbatim to every generation (buildOperatingContextDirective). Unbounded
// input here is not merely a cost problem — it is the mechanism by which a
// governed guardrail could get silently dropped or truncated out of a model
// context window with nobody the wiser. The correct failure mode is a loud,
// visible refusal at the moment content is ADDED, never a silent truncation
// at the moment content is USED (PHILOSOPHY.md §5: honest blank beats
// confident wrong — a truncated guardrail that looks intact is the "confident
// wrong" case). The property is conservative for a first pilot; both numbers
// are policy, not physics, and may be revisited with evidence.
const MAX_ACTIVE_RULES_PER_PROPERTY = 40;
const MAX_DIRECTIVE_CHARS = 12000;

function effectiveState(rule, at = new Date()) {
  if (!rule) return null;
  if (rule.status === "retired") return "retired";
  const now = new Date(at).getTime();
  const confirmedAt = rule.confirmed_at ? new Date(rule.confirmed_at).getTime() : null;
  const effectiveUntil = rule.effective_until ? new Date(rule.effective_until).getTime() : null;
  if (confirmedAt != null && confirmedAt > now) return "scheduled";
  if (effectiveUntil != null && effectiveUntil <= now) return "expired";
  return "active_now";
}

function httpErr(status, message, code = null) {
  const error = new Error(message);
  error.httpStatus = status;
  error.publicMessage = message;
  if (code) error.code = code;
  return error;
}

function cleanText(value, { required = false, max = 1000, label = "Value" } = {}) {
  if (value == null) {
    if (required) throw httpErr(400, `${label} is required.`);
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    if (required) throw httpErr(400, `${label} is required.`);
    return null;
  }
  if (text.length > max) throw httpErr(400, `${label} is too long.`);
  return text;
}

function normalizeRuleKey(value) {
  const key = cleanText(value, { required: true, max: 64, label: "Rule key" })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(key)) {
    throw httpErr(400, "Rule key must begin with a letter and contain only letters, numbers, or underscores.");
  }
  return key;
}

function normalizeSteps(value, kind) {
  let raw = value;
  if (typeof raw === "string") raw = raw.split(/\r?\n/);
  if (!Array.isArray(raw)) raw = [];
  const steps = raw
    .map((step) => String(step == null ? "" : step).trim())
    .filter(Boolean);
  if (steps.some((step) => step.length > 1000)) throw httpErr(400, "Each SOP step must be 1,000 characters or fewer.");
  if (steps.length > 30) throw httpErr(400, "An SOP may contain at most 30 steps.");
  if (kind === "sop" && steps.length === 0) throw httpErr(400, "An SOP requires at least one step.");
  if (kind !== "sop" && steps.length > 0) throw httpErr(400, "Only an SOP may contain ordered steps.");
  return steps;
}

function normalizeTimestamp(value, { required = false, label = "Date" } = {}) {
  if (value == null || value === "") {
    if (required) throw httpErr(400, `${label} is required.`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpErr(400, `${label} is invalid.`);
  return date.toISOString();
}

function normalizeRuleInput(input) {
  const body = input && typeof input === "object" ? input : {};
  const kind = cleanText(body.rule_kind, { required: true, max: 20, label: "Rule type" });
  if (!RULE_KINDS.includes(kind)) throw httpErr(400, "Rule type must be policy, SOP, or guardrail.");
  const sourceType = cleanText(body.source_type, { required: true, max: 80, label: "Source type" });
  if (!SOURCE_TYPES.includes(sourceType)) throw httpErr(400, "Source type is not supported.");

  const confirmedAt = normalizeTimestamp(body.confirmed_at || new Date(), { required: true, label: "Confirmed date" });
  const effectiveUntil = normalizeTimestamp(body.effective_until, { label: "Effective-until date" });
  if (effectiveUntil && new Date(effectiveUntil) <= new Date(confirmedAt)) {
    throw httpErr(400, "Effective-until date must be after the confirmed date.");
  }

  return Object.freeze({
    rule_key: normalizeRuleKey(body.rule_key || body.title),
    rule_kind: kind,
    title: cleanText(body.title, { required: true, max: 160, label: "Title" }),
    instruction_text: cleanText(body.instruction_text, { required: true, max: 6000, label: "Instruction" }),
    trigger_text: cleanText(body.trigger_text, { max: 2000, label: "Trigger" }),
    steps: normalizeSteps(body.steps, kind),
    escalation_text: cleanText(body.escalation_text, { max: 2000, label: "Escalation" }),
    source_type: sourceType,
    source_note: cleanText(body.source_note, { max: 1000, label: "Source note" }),
    confirmed_at: confirmedAt,
    effective_until: effectiveUntil,
  });
}

// canonicalRule feeds the hash/snapshot comparison generation depends on, so
// it must contain ONLY facts that change what the AI is told — never status,
// retirement audit fields, or anything else about the row's lifecycle. Adding
// a field here changes what counts as "the rules changed" for stale-draft
// purposes; that is a deliberate, narrow surface, not an incidental one.
function canonicalRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id || null,
    property_id: rule.property_id || null,
    rule_key: rule.rule_key,
    rule_kind: rule.rule_kind,
    title: rule.title,
    instruction_text: rule.instruction_text,
    trigger_text: rule.trigger_text || null,
    steps: Array.isArray(rule.steps) ? rule.steps.map(String) : [],
    escalation_text: rule.escalation_text || null,
    source_type: rule.source_type,
    source_note: rule.source_note || null,
    confirmed_at: rule.confirmed_at ? new Date(rule.confirmed_at).toISOString() : null,
    effective_until: rule.effective_until ? new Date(rule.effective_until).toISOString() : null,
  };
}

// Presentation shape for the settings surface — the canonical row PLUS the
// lifecycle/state/audit facts an operator needs to see, but that must never
// enter the generation snapshot/hash above.
function presentedRule(rule, at = new Date()) {
  if (!rule) return null;
  return {
    ...canonicalRule(rule),
    status: rule.status,
    effective_state: effectiveState(rule, at),
    supersedes_rule_id: rule.supersedes_rule_id || null,
    approved_by_user_id: rule.approved_by_user_id || null,
    approved_by_name: rule.approved_by_name || null,
    created_at: rule.created_at ? new Date(rule.created_at).toISOString() : null,
    retired_at: rule.retired_at ? new Date(rule.retired_at).toISOString() : null,
    retired_by_user_id: rule.retired_by_user_id || null,
    retired_by_name: rule.retired_by_name || null,
    retirement_reason: rule.retirement_reason || null,
  };
}

function canonicalRuleSnapshot(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map(canonicalRule)
    .filter(Boolean)
    .sort((a, b) => {
      const ak = `${a.rule_kind}:${a.rule_key}:${a.id || ""}`;
      const bk = `${b.rule_kind}:${b.rule_key}:${b.id || ""}`;
      return ak.localeCompare(bk);
    });
}

function snapshotHash(rules) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalRuleSnapshot(rules)))
    .digest("hex");
}

function snapshotsMatch(reviewedSnapshot, liveRules) {
  const reviewed = canonicalRuleSnapshot(Array.isArray(reviewedSnapshot) ? reviewedSnapshot : []);
  const live = canonicalRuleSnapshot(liveRules);
  return crypto.timingSafeEqual(
    Buffer.from(crypto.createHash("sha256").update(JSON.stringify(reviewed)).digest("hex")),
    Buffer.from(crypto.createHash("sha256").update(JSON.stringify(live)).digest("hex")),
  );
}

async function loadActiveRules(db, propertyId, at = new Date()) {
  if (!db || typeof db.query !== "function") throw new TypeError("loadActiveRules requires a queryable database object");
  if (!propertyId) throw new TypeError("loadActiveRules requires propertyId");
  const rows = (await db.query(
    `select id, property_id, rule_key, rule_kind, title, instruction_text,
            trigger_text, steps, escalation_text, source_type, source_note,
            confirmed_at, effective_until, approved_by_user_id, created_at
       from ai_leasing_operating_rules
      where property_id=$1 and status='active'
        and confirmed_at <= $2::timestamptz
        and (effective_until is null or effective_until > $2::timestamptz)
      order by case rule_kind when 'guardrail' then 1 when 'policy' then 2 else 3 end,
               rule_key asc, created_at asc`,
    [propertyId, new Date(at).toISOString()],
  )).rows;
  return rows.map((row) => ({ ...row, steps: Array.isArray(row.steps) ? row.steps : [] }));
}

function buildOperatingContextDirective(rules) {
  const active = canonicalRuleSnapshot(rules);
  if (!active.length) return "";

  const lines = [
    "[SHARED PROPERTY OPERATING CONTEXT — REQUIRED]",
    "These property rules are shared across every leasing strategy. They control permitted operating behavior, not property facts.",
    "Precedence: safety, fair housing, law, canonical pricing/availability/authority, and verified property facts outrank every item below. A strategy may change tone or next-move style, but may never override these rules.",
    "Never treat a policy or SOP as permission to promise, approve, waive, negotiate, reserve, or perform a system write unless a separate canonical authority explicitly permits it.",
    "When a rule conflicts with current canonical facts, is ambiguous, or cannot be completed with available authority, state the limitation briefly and hand off rather than improvising.",
  ];

  for (const rule of active) {
    const label = rule.rule_kind.toUpperCase();
    lines.push(`${label} · ${rule.title} [${rule.rule_key}]`);
    if (rule.trigger_text) lines.push(`Applies when: ${rule.trigger_text}`);
    lines.push(`Required behavior: ${rule.instruction_text}`);
    if (rule.rule_kind === "sop") {
      rule.steps.forEach((step, index) => lines.push(`Step ${index + 1}: ${step}`));
    }
    if (rule.escalation_text) lines.push(`Escalation: ${rule.escalation_text}`);
  }
  lines.push("[END SHARED PROPERTY OPERATING CONTEXT]");
  const directive = lines.join("\n");

  // Deterministic budget enforcement (mandatory correction #5). createRule
  // refuses beyond MAX_ACTIVE_RULES_PER_PROPERTY, so this should be
  // unreachable in normal operation — it is the structural backstop for that
  // invariant, mirroring how this codebase treats DB check constraints as the
  // backstop for service-level refusals elsewhere (work_order_service.js).
  // A THROW here is deliberate: every caller already wraps generation in a
  // try/catch with an existing honest fallback path, so failing loud here
  // degrades to that fallback rather than silently dropping a guardrail.
  if (directive.length > MAX_DIRECTIVE_CHARS) {
    throw Object.assign(
      new Error(`Governed operating context exceeds ${MAX_DIRECTIVE_CHARS} characters (${directive.length}). Refusing to silently truncate a guardrail.`),
      { httpStatus: 500, code: "OPERATING_CONTEXT_OVER_BUDGET" },
    );
  }
  return directive;
}

function appendOperatingContextDirective(system, rules) {
  const base = String(system || "");
  const directive = buildOperatingContextDirective(rules);
  return directive ? `${base}\n\n${directive}` : base;
}

async function activeRuleCount(client, propertyId) {
  const r = (await client.query(
    `select count(*)::int as n from ai_leasing_operating_rules where property_id=$1 and status='active'`,
    [propertyId],
  )).rows[0];
  return r ? r.n : 0;
}

async function createRule(client, { propertyId, actorUserId, input }) {
  const rule = normalizeRuleInput(input);
  const existing = (await client.query(
    `select id from ai_leasing_operating_rules
      where property_id=$1 and rule_kind=$2 and rule_key=$3 and status='active'
      limit 1 for update`,
    [propertyId, rule.rule_kind, rule.rule_key],
  )).rows[0];
  if (existing) throw httpErr(409, "An active rule with this type and key already exists. Replace it instead.");

  // Rule-count budget (mandatory correction #5). Checked at the moment content
  // is ADDED, not the moment it is used — see buildOperatingContextDirective.
  // A replace never reaches here (net rule count is unchanged by a 1-for-1
  // supersession); only genuinely new rules can grow the count.
  const count = await activeRuleCount(client, propertyId);
  if (count >= MAX_ACTIVE_RULES_PER_PROPERTY) {
    throw httpErr(409,
      `This property already has ${count} active operating rules, the maximum of ${MAX_ACTIVE_RULES_PER_PROPERTY}. Retire an existing policy, SOP, or guardrail before adding another.`);
  }

  return (await client.query(
    `insert into ai_leasing_operating_rules
       (property_id, rule_key, rule_kind, title, instruction_text, trigger_text,
        steps, escalation_text, source_type, source_note, confirmed_at,
        effective_until, status, approved_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'active',$13)
     returning *`,
    [propertyId, rule.rule_key, rule.rule_kind, rule.title, rule.instruction_text,
     rule.trigger_text, JSON.stringify(rule.steps), rule.escalation_text,
     rule.source_type, rule.source_note, rule.confirmed_at, rule.effective_until,
     actorUserId],
  )).rows[0];
}

async function scopedRule(client, { ruleId, propertyId, forUpdate = false }) {
  const row = (await client.query(
    `select * from ai_leasing_operating_rules where id=$1${forUpdate ? " for update" : ""}`,
    [ruleId],
  )).rows[0];
  if (!row) throw httpErr(404, "Rule not found.");
  if (String(row.property_id) !== String(propertyId)) throw httpErr(403, "Rule is outside your property scope.");
  return row;
}

async function replaceRule(client, { ruleId, propertyId, actorUserId, retiredByUserId = null, retirementReason = null, input }) {
  const old = await scopedRule(client, { ruleId, propertyId, forUpdate: true });
  if (old.status !== "active") throw httpErr(409, `Only an active rule can be replaced (this rule is '${old.status}').`);
  // REPLACEMENT IDENTITY LOCK (mandatory correction #3). property_id,
  // rule_kind, and rule_key are SERVER-DERIVED from the row being replaced,
  // never taken from the request body — the same "client input is never
  // authority over identity" discipline PHILOSOPHY.md §21 applies to
  // property/actor identity applies here to RULE identity. A caller who wants
  // a different kind or key must retire the old rule and create a new one;
  // the DB's trg_ai_leasing_operating_rule_lineage trigger is the structural
  // backstop if this service is ever bypassed.
  const rule = normalizeRuleInput({ ...input, rule_key: old.rule_key, rule_kind: old.rule_kind });

  // RETIREMENT AUDIT (mandatory correction #2). A replace retires the prior
  // version, so it records the SAME retirement actor/reason a standalone
  // retire does — replacing without recording who authorized the retirement
  // half of the operation would leave that half unaudited.
  if (!retiredByUserId) throw httpErr(400, "retiredByUserId is required to replace a rule.");
  await client.query(
    `update ai_leasing_operating_rules
        set status='retired', retired_at=now(), retired_by_user_id=$2, retirement_reason=$3
      where id=$1 and status='active'`,
    [old.id, retiredByUserId, retirementReason],
  );

  try {
    const replacement = (await client.query(
      `insert into ai_leasing_operating_rules
         (property_id, rule_key, rule_kind, title, instruction_text, trigger_text,
          steps, escalation_text, source_type, source_note, confirmed_at,
          effective_until, status, supersedes_rule_id, approved_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,'active',$13,$14)
       returning *`,
      [propertyId, rule.rule_key, rule.rule_kind, rule.title, rule.instruction_text,
       rule.trigger_text, JSON.stringify(rule.steps), rule.escalation_text,
       rule.source_type, rule.source_note, rule.confirmed_at, rule.effective_until,
       old.id, actorUserId],
    )).rows[0];
    return { retired_rule_id: old.id, replacement };
  } catch (error) {
    if (error && error.code === "23505") {
      throw httpErr(409, "Another active rule already uses that type and key.");
    }
    throw error;
  }
}

async function retireRule(client, { ruleId, propertyId, retiredByUserId, retirementReason = null }) {
  const row = await scopedRule(client, { ruleId, propertyId, forUpdate: true });
  if (row.status !== "active") throw httpErr(409, `Rule is already '${row.status}'.`);
  if (!retiredByUserId) throw httpErr(400, "retiredByUserId is required to retire a rule.");
  await client.query(
    `update ai_leasing_operating_rules
        set status='retired', retired_at=now(), retired_by_user_id=$2, retirement_reason=$3
      where id=$1 and status='active'`,
    [row.id, retiredByUserId, retirementReason],
  );
  return { retired_rule_id: row.id };
}

async function listSettings(db, { propertyId }) {
  const strategyRows = (await db.query(
    `select p.id as strategy_profile_id, p.strategy_key, p.interface_name,
            p.interface_title, p.description, p.status as profile_status,
            v.id as strategy_version_id, v.version_number, v.behavior_policy,
            v.prompt_contract_version, v.status as version_status, v.effective_at,
            d.id as deployment_id, d.status as deployment_status, d.traffic_weight,
            d.cohort_key, d.activated_at
       from ai_leasing_strategy_profiles p
       left join lateral (
         select * from ai_leasing_strategy_versions v0
          where v0.strategy_profile_id=p.id
          order by v0.version_number desc limit 1
       ) v on true
       left join lateral (
         select * from property_ai_leasing_strategy_deployments d0
          where d0.property_id=$1 and d0.strategy_profile_id=p.id
          order by case d0.status when 'active' then 1 when 'configured' then 2 when 'paused' then 3 else 4 end,
                   d0.created_at desc limit 1
       ) d on true
      where p.status='active'
      order by case p.strategy_key when 'maya' then 1 when 'james' then 2 when 'claire' then 3 else 10 end,
               p.interface_name asc`,
    [propertyId],
  )).rows;

  const validationRows = (await db.query(
    `select vr.strategy_version_id, vr.generation_surface,
            bool_or(vr.status='passed') as passed,
            max(vr.completed_at) filter (where vr.status='passed') as passed_at
       from ai_leasing_strategy_validation_runs vr
       join ai_leasing_strategy_versions v on v.id=vr.strategy_version_id
       join ai_leasing_strategy_profiles p on p.id=v.strategy_profile_id
      where p.status='active'
      group by vr.strategy_version_id, vr.generation_surface`,
  )).rows;
  const validationByVersion = new Map();
  for (const row of validationRows) {
    const entry = validationByVersion.get(row.strategy_version_id) || {};
    entry[row.generation_surface] = { passed: !!row.passed, passed_at: row.passed_at || null };
    validationByVersion.set(row.strategy_version_id, entry);
  }

  const assignmentRows = (await db.query(
    `select current.strategy_profile_id, count(*)::int as assigned_opportunities
       from leasing_lead_ai_strategy_current current
       join leasing_leads ll on ll.id=current.leasing_lead_id
      where current.property_id=$1 and ll.status not in ('leased','lost')
      group by current.strategy_profile_id`,
    [propertyId],
  )).rows;
  const assignmentCount = new Map(assignmentRows.map((row) => [String(row.strategy_profile_id), Number(row.assigned_opportunities || 0)]));

  const knowledge = (await db.query(
    `select f.id, f.fact_key, f.category, f.rendered_text, f.source_type,
            f.source_record_id, f.confirmed_at, f.effective_until, f.status,
            f.approved_by_user_id, f.created_at, u.name as approved_by_name
       from agent_facts f
       left join users u on u.id=f.approved_by_user_id
      where f.property_id=$1
      order by case f.status when 'active' then 1 else 2 end, f.fact_key asc, f.created_at desc`,
    [propertyId],
  )).rows;

  const rules = (await db.query(
    `select r.*, u.name as approved_by_name, ru.name as retired_by_name
       from ai_leasing_operating_rules r
       left join users u on u.id=r.approved_by_user_id
       left join users ru on ru.id=r.retired_by_user_id
      where r.property_id=$1
      order by case r.status when 'active' then 1 else 2 end,
               case r.rule_kind when 'guardrail' then 1 when 'policy' then 2 else 3 end,
               r.rule_key asc, r.created_at desc`,
    [propertyId],
  )).rows.map((row) => presentedRule({ ...row, steps: Array.isArray(row.steps) ? row.steps : [] }));

  const strategies = strategyRows.map((row) => {
    const validation = validationByVersion.get(row.strategy_version_id) || {};
    const surfaces = GENERATION_SURFACES.map((surface) => ({
      surface,
      passed: !!(validation[surface] && validation[surface].passed),
      passed_at: validation[surface] ? validation[surface].passed_at : null,
    }));
    return {
      strategy_profile_id: row.strategy_profile_id,
      strategy_key: row.strategy_key,
      interface_name: row.interface_name,
      interface_title: row.interface_title,
      description: row.description,
      strategy_version_id: row.strategy_version_id,
      version_number: row.version_number,
      behavior_policy: row.behavior_policy || null,
      prompt_contract_version: row.prompt_contract_version,
      version_status: row.version_status || null,
      validation_surfaces: surfaces,
      behaviorally_validated: surfaces.every((surface) => surface.passed),
      deployment: row.deployment_id ? {
        id: row.deployment_id,
        status: row.deployment_status,
        traffic_weight: row.traffic_weight,
        cohort_key: row.cohort_key,
        activated_at: row.activated_at,
      } : null,
      assigned_open_opportunities: assignmentCount.get(String(row.strategy_profile_id)) || 0,
    };
  });

  const activeKnowledge = knowledge.filter((item) => item.status === "active");
  // Counts and "active" filtering use effective_state, never raw status
  // (mandatory correction #4). A scheduled-future or already-expired row
  // still carries status='active' in the DB — that is correct storage, but
  // it must never present as governing generation right now.
  const activeRules = rules.filter((item) => item.effective_state === "active_now");
  const scheduledRules = rules.filter((item) => item.effective_state === "scheduled");
  const expiredRules = rules.filter((item) => item.effective_state === "expired");
  return {
    contract_version: "governed_operating_context_leasing_v1",
    operating_context_contract_version: CONTRACT_VERSION,
    feature: {
      name: "Governed Operating Context",
      consumer: "leasing",
      version: 1,
      strategy_surface: "secondary",
      activation_controls: false,
    },
    property_id: propertyId,
    shared_across_strategies: true,
    strategies,
    knowledge: {
      items: knowledge,
      active_count: activeKnowledge.length,
      source_types: SOURCE_TYPES,
      note: "Building knowledge is shared by every leasing strategy and remains governed by the existing agent_facts rail.",
    },
    operating_rules: {
      items: rules,
      active_count: activeRules.length,
      scheduled_count: scheduledRules.length,
      expired_count: expiredRules.length,
      max_active: MAX_ACTIVE_RULES_PER_PROPERTY,
      kinds: RULE_KINDS,
      source_types: SOURCE_TYPES,
      effective_states: EFFECTIVE_STATES,
      note: "Policies, SOPs, and guardrails govern every leasing strategy at this property and grant no new action authority. Only 'active_now' rules affect generation; scheduled and expired rules are shown honestly but do not.",
    },
    counts: {
      strategies: strategies.length,
      active_knowledge: activeKnowledge.length,
      active_policies: activeRules.filter((item) => item.rule_kind === "policy").length,
      active_sops: activeRules.filter((item) => item.rule_kind === "sop").length,
      active_guardrails: activeRules.filter((item) => item.rule_kind === "guardrail").length,
    },
  };
}

module.exports = {
  CONTRACT_VERSION,
  RULE_KINDS,
  SOURCE_TYPES,
  GENERATION_SURFACES,
  EFFECTIVE_STATES,
  MAX_ACTIVE_RULES_PER_PROPERTY,
  MAX_DIRECTIVE_CHARS,
  httpErr,
  normalizeRuleKey,
  normalizeRuleInput,
  effectiveState,
  canonicalRule,
  presentedRule,
  canonicalRuleSnapshot,
  snapshotHash,
  snapshotsMatch,
  loadActiveRules,
  buildOperatingContextDirective,
  appendOperatingContextDirective,
  activeRuleCount,
  createRule,
  replaceRule,
  retireRule,
  scopedRule,
  listSettings,
};
