// AI LEASING STRATEGY — operator read projection
//
// Read-only, property-scoped, and intentionally narrow. It answers:
//   • which named strategies exist for this property;
//   • whether each strategy has passed all required replay surfaces;
//   • whether a governed deployment is active/configured/paused;
//   • which exact strategy version is assigned to each visible conversation.
//
// It does NOT score agents, recommend allocation, activate deployments, or infer
// outcomes. Those require the evidence rail and an explicit operator decision.
"use strict";

const REQUIRED_SURFACES = Object.freeze([
  "first_response",
  "ongoing_reply",
  "regenerated_reply",
]);

function deploymentRank(status) {
  return { active: 0, configured: 1, paused: 2, retired: 3 }[status] ?? 9;
}

function overallState(strategies) {
  const active = strategies.filter((s) => s.deployment_status === "active").length;
  const ready = strategies.filter((s) => s.validation.ready).length;
  if (active === strategies.length && active > 0) return "active";
  if (active > 0) return "partially_active";
  if (strategies.length > 0 && ready === strategies.length) return "ready_to_configure";
  return "validation_required";
}

async function loadProfiles(pool, propertyId) {
  const rows = (await pool.query(
    `select p.id as strategy_profile_id, p.strategy_key, p.interface_name,
            p.interface_title, p.description,
            lv.id as latest_version_id, lv.version_number as latest_version_number,
            lv.status as latest_version_status,
            d.id as deployment_id, d.strategy_version_id as deployed_version_id,
            dv.version_number as deployed_version_number,
            dv.status as deployed_version_status,
            d.status as deployment_status, d.traffic_weight, d.cohort_key,
            d.activated_at, d.paused_at
       from ai_leasing_strategy_profiles p
       left join lateral (
         select v.id, v.version_number, v.status
           from ai_leasing_strategy_versions v
          where v.strategy_profile_id = p.id
          order by v.version_number desc
          limit 1
       ) lv on true
       left join lateral (
         select x.*
           from property_ai_leasing_strategy_deployments x
          where x.property_id = $1 and x.strategy_profile_id = p.id
          order by case x.status
                     when 'active' then 0 when 'configured' then 1
                     when 'paused' then 2 else 3 end,
                   x.created_at desc
          limit 1
       ) d on true
       left join ai_leasing_strategy_versions dv on dv.id = d.strategy_version_id
      where p.status = 'active'
      order by p.created_at asc, p.strategy_key asc`,
    [propertyId]
  )).rows;

  return rows.map((row) => ({
    ...row,
    selected_version_id: row.deployed_version_id || row.latest_version_id || null,
    selected_version_number: row.deployed_version_number || row.latest_version_number || null,
    selected_version_status: row.deployed_version_status || row.latest_version_status || null,
  })).sort((a, b) => {
    const rank = deploymentRank(a.deployment_status) - deploymentRank(b.deployment_status);
    return rank || String(a.strategy_key).localeCompare(String(b.strategy_key));
  });
}

async function loadValidation(pool, versionIds) {
  if (!versionIds.length) return new Map();
  const rows = (await pool.query(
    `select strategy_version_id,
            array_agg(distinct generation_surface order by generation_surface)
              filter (where status='passed') as passed_surfaces,
            max(completed_at) filter (where status='passed') as last_passed_at
       from ai_leasing_strategy_validation_runs
      where strategy_version_id = any($1::uuid[])
      group by strategy_version_id`,
    [versionIds]
  )).rows;
  return new Map(rows.map((row) => [String(row.strategy_version_id), row]));
}

async function loadAssignedCounts(pool, propertyId) {
  const rows = (await pool.query(
    `select cur.strategy_profile_id,
            count(distinct cur.leasing_lead_id)::int as assigned_open_opportunities
       from leasing_lead_ai_strategy_current cur
       join leasing_leads ll on ll.id = cur.leasing_lead_id
       join conversations c on c.id = cur.conversation_id
      where cur.property_id = $1
        and ll.status not in ('leased','lost')
        and c.status = 'open'
      group by cur.strategy_profile_id`,
    [propertyId]
  )).rows;
  return new Map(rows.map((row) => [String(row.strategy_profile_id), Number(row.assigned_open_opportunities || 0)]));
}

async function loadConversationAssignments(pool, propertyId, conversationIds) {
  if (!conversationIds.length) return {};
  const rows = (await pool.query(
    `select distinct on (cur.conversation_id)
            cur.conversation_id, cur.leasing_lead_id, cur.assignment_event_id,
            cur.assigned_at, p.strategy_key, p.interface_name, p.interface_title,
            v.version_number, v.status as version_status,
            d.status as deployment_status
       from leasing_lead_ai_strategy_current cur
       join leasing_leads ll on ll.id = cur.leasing_lead_id
       join ai_leasing_strategy_profiles p on p.id = cur.strategy_profile_id
       join ai_leasing_strategy_versions v on v.id = cur.strategy_version_id
       join property_ai_leasing_strategy_deployments d on d.id = cur.deployment_id
      where cur.property_id = $1
        and cur.conversation_id = any($2::uuid[])
        and ll.status not in ('leased','lost')
      order by cur.conversation_id, ll.created_at desc, cur.assigned_at desc`,
    [propertyId, conversationIds]
  )).rows;

  return Object.fromEntries(rows.map((row) => [String(row.conversation_id), {
    strategy_key: row.strategy_key,
    name: row.interface_name,
    title: row.interface_title,
    version: Number(row.version_number),
    version_status: row.version_status,
    deployment_status: row.deployment_status,
    leasing_lead_id: row.leasing_lead_id,
    assignment_event_id: row.assignment_event_id,
    assigned_at: row.assigned_at,
  }]));
}

async function loadAiLeasingStrategyProjection(pool, { propertyId, conversationIds = [] }) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!propertyId) throw new TypeError("propertyId is required");

  const profileRows = await loadProfiles(pool, propertyId);
  const selectedIds = [...new Set(profileRows.map((r) => r.selected_version_id).filter(Boolean).map(String))];
  const [validationByVersion, assignedByProfile, assignmentsByConversation] = await Promise.all([
    loadValidation(pool, selectedIds),
    loadAssignedCounts(pool, propertyId),
    loadConversationAssignments(pool, propertyId, conversationIds.map(String)),
  ]);

  const strategies = profileRows.map((row) => {
    const validationRow = row.selected_version_id
      ? validationByVersion.get(String(row.selected_version_id))
      : null;
    const passed = validationRow && Array.isArray(validationRow.passed_surfaces)
      ? validationRow.passed_surfaces
      : [];
    const passedSet = new Set(passed);
    const missing = REQUIRED_SURFACES.filter((surface) => !passedSet.has(surface));
    return {
      strategy_key: row.strategy_key,
      name: row.interface_name,
      title: row.interface_title,
      description: row.description,
      version: row.selected_version_number == null ? null : Number(row.selected_version_number),
      version_status: row.selected_version_status,
      deployment_status: row.deployment_status || "not_configured",
      traffic_weight: row.traffic_weight == null ? 0 : Number(row.traffic_weight),
      cohort_key: row.cohort_key || null,
      activated_at: row.activated_at || null,
      assigned_open_opportunities: assignedByProfile.get(String(row.strategy_profile_id)) || 0,
      validation: {
        ready: missing.length === 0 && passed.length === REQUIRED_SURFACES.length,
        passed_surfaces: passed,
        missing_surfaces: missing,
        required_surface_count: REQUIRED_SURFACES.length,
        last_passed_at: validationRow ? validationRow.last_passed_at : null,
      },
    };
  });

  return {
    contract_version: "ai_leasing_strategy_status_v1",
    state: overallState(strategies),
    strategies,
    conversation_assignments: assignmentsByConversation,
    performance: {
      available: false,
      reason: "qualified_outcome_evidence_not_requested_on_conversations_board",
    },
  };
}

module.exports = {
  REQUIRED_SURFACES,
  overallState,
  loadAiLeasingStrategyProjection,
};
