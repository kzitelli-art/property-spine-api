"use strict";
const assert = require("assert");
const { REQUIRED_SURFACES, overallState, loadAiLeasingStrategyProjection } = require("../../src/leasing/ai_leasing_strategy_projection");

function result(rows) { return { rows }; }

async function main() {
  assert.deepStrictEqual(REQUIRED_SURFACES, ["first_response", "ongoing_reply", "regenerated_reply"]);
  assert.strictEqual(overallState([]), "validation_required");
  assert.strictEqual(overallState([{ deployment_status: "active", validation: { ready: true } }]), "active");
  assert.strictEqual(overallState([
    { deployment_status: "active", validation: { ready: true } },
    { deployment_status: "not_configured", validation: { ready: true } },
  ]), "partially_active");

  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("from ai_leasing_strategy_profiles p")) {
        return result([
          {
            strategy_profile_id: "p-maya", strategy_key: "maya", interface_name: "Maya", interface_title: "The Guide",
            description: "Patient discovery", latest_version_id: "v-maya", latest_version_number: 1,
            latest_version_status: "validated", deployment_id: "d-maya", deployed_version_id: "v-maya",
            deployed_version_number: 1, deployed_version_status: "validated", deployment_status: "active",
            traffic_weight: 5000, cohort_key: "all_eligible_leads", activated_at: "2026-07-31T12:00:00Z",
          },
          {
            strategy_profile_id: "p-james", strategy_key: "james", interface_name: "James", interface_title: "The Closer",
            description: "Direct progression", latest_version_id: "v-james", latest_version_number: 1,
            latest_version_status: "draft", deployment_id: null, deployed_version_id: null,
            deployed_version_number: null, deployed_version_status: null, deployment_status: null,
            traffic_weight: null, cohort_key: null, activated_at: null,
          },
        ]);
      }
      if (sql.includes("from ai_leasing_strategy_validation_runs")) {
        return result([
          { strategy_version_id: "v-maya", passed_surfaces: [...REQUIRED_SURFACES], last_passed_at: "2026-07-31T11:00:00Z" },
          { strategy_version_id: "v-james", passed_surfaces: ["first_response"], last_passed_at: "2026-07-31T11:00:00Z" },
        ]);
      }
      if (sql.includes("assigned_open_opportunities")) {
        return result([{ strategy_profile_id: "p-maya", assigned_open_opportunities: 7 }]);
      }
      if (sql.includes("distinct on (cur.conversation_id)")) {
        return result([{
          conversation_id: "c-1", leasing_lead_id: "l-1", assignment_event_id: "a-1",
          assigned_at: "2026-07-31T12:01:00Z", strategy_key: "maya", interface_name: "Maya",
          interface_title: "The Guide", version_number: 1, version_status: "validated", deployment_status: "active",
        }]);
      }
      throw new Error("Unexpected SQL: " + sql);
    },
  };

  const out = await loadAiLeasingStrategyProjection(pool, { propertyId: "property-1", conversationIds: ["c-1"] });
  assert.strictEqual(out.contract_version, "ai_leasing_strategy_status_v1");
  assert.strictEqual(out.state, "partially_active");
  assert.strictEqual(out.strategies.length, 2);
  assert.strictEqual(out.strategies[0].name, "Maya");
  assert.strictEqual(out.strategies[0].validation.ready, true);
  assert.strictEqual(out.strategies[0].assigned_open_opportunities, 7);
  assert.deepStrictEqual(out.strategies[1].validation.missing_surfaces, ["ongoing_reply", "regenerated_reply"]);
  assert.strictEqual(out.conversation_assignments["c-1"].name, "Maya");
  assert.strictEqual(out.performance.available, false);
  assert.strictEqual(calls.length, 4);
  console.log("ai_leasing_strategy_projection: 15/15");
}

main().catch((error) => { console.error(error); process.exit(1); });
