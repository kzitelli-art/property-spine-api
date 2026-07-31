#!/usr/bin/env node
"use strict";

// Predeployment gate for a completed replay artifact.
//
// Usage:
//   node tools/validate_ai_leasing_strategy_replay.js --artifact ./replay.json
//   DATABASE_URL=... node tools/validate_ai_leasing_strategy_replay.js \
//     --artifact ./replay.json --record
//
// The artifact contains evaluator results, not raw model credentials:
// {
//   "strategy_version_id":"...",
//   "generation_surface":"first_response|ongoing_reply|regenerated_reply",
//   "model":"...",
//   "prompt_revision":"...",
//   "evaluator_version":"...",
//   "behavior_policy":{...},
//   "cases":[{ "scenario_id":"...", "expected_move":"...",
//              "actual_move":"...", "tour_gate_adherent":true,
//              "detail_depth_adherent":true, "question_rule_adherent":true,
//              "unsupported_fact":false,
//              "safety_violation":false, "shared_rule_violation":false,
//              "blind_review_pass":true }]
// }

const fs = require("fs");
const path = require("path");
const validation = require("../src/leasing/ai_leasing_strategy_behavior_validation");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const artifactPath = arg("--artifact");
  const record = process.argv.includes("--record");
  if (!artifactPath) throw new Error("--artifact <path> is required");
  const artifact = JSON.parse(fs.readFileSync(path.resolve(artifactPath), "utf8"));
  const summary = validation.summarizeBehaviorReplay({
    behaviorPolicy: artifact.behavior_policy,
    cases: artifact.cases,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.status !== "passed") {
    process.exitCode = 1;
    return;
  }
  if (!record) return;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required with --record");
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await validation.recordBehaviorValidation(client, {
      strategyVersionId: artifact.strategy_version_id,
      generationSurface: artifact.generation_surface,
      model: artifact.model,
      promptRevision: artifact.prompt_revision,
      evaluatorVersion: artifact.evaluator_version,
      runtimeContractVersion: artifact.runtime_contract_version || "ai_leasing_strategy_v2",
      behaviorPolicy: artifact.behavior_policy,
      cases: artifact.cases,
      details: artifact.details || null,
    });
    await client.query("commit");
    console.log(JSON.stringify({ recorded: true, validation_id: out.validation.id, status: out.validation.status }, null, 2));
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
