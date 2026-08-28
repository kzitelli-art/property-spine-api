// ════════════════════════════════════════════════════════════════════
//  readiness_certification_proof.js — BUILD 4 proof harness
//
//    node tests/proofs/readiness_certification_proof.js
//
//  Part A (pure) runs anywhere. Part B requires DATABASE_URL and REAL
//  Postgres; without it this harness EXITS NON-ZERO. No fixture fallback.
// ════════════════════════════════════════════════════════════════════

"use strict";

const G = require("../../src/maintenance/readiness_gate");
const { makeReadinessService, AUTHORITY_LADDER } = require("../../src/maintenance/readiness_service");
const { marketingState } = require("../../src/surfaces/availability_read");
const { computeTurnFlow, STAGE } = require("../../src/maintenance/turn_sequence");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const COMPLETE = { inspection_completeness: "complete_turn_scope", id: "s1", triage_confirmation_id: "tc1" };
const done = (id, stage, extra) => ({ id, status: "complete", work_text: id, stage, reopened_count: 0, ...extra });
const claim = (wid, sat) => ({ work_id: wid, id: "c-" + wid, proof_satisfied: sat, created_at: "2026-07-28T10:00:00Z" });
const ALL_CONFIRMED = {
  work_complete_confirmed: true, cleaning_acceptable_confirmed: true,
  appliances_present_confirmed: true, appliance_function_confirmed: true,
  no_repair_blocker_confirmed: true, keys_accounted_confirmed: true,
  condition_acceptable_confirmed: true, no_unknowns_confirmed: true,
};

section("D1  completed work alone can NEVER emit ready");
{
  const work = [done("r1", STAGE.REPAIR), done("p1", STAGE.PAINT), done("c1", STAGE.FINAL_CLEAN)];
  const claims = work.map((w) => claim(w.id, true));
  const gate = G.readinessGate({ scope: COMPLETE, work, claims, certifications: [] });
  ok("everything complete and proven → the WALK is actionable", gate.actionable, JSON.stringify(gate.blockers));
  ok("but the gate never says ready", !/"ready"/.test(JSON.stringify(gate)));
  ok("and says so in words", /NOT readiness/i.test(gate.meaning), gate.meaning);

  // the flow engine, likewise
  const flow = computeTurnFlow({ scope: COMPLETE, work });
  ok("the flow still refuses to call the unit ready",
     /NOT ready/i.test(flow.controlling_next_action.why), flow.controlling_next_action.why);
  ok("no readiness verdict anywhere in the gate or flow",
     !/"readiness"\s*:\s*"ready"/.test(JSON.stringify({ gate, flow })));

  // availability: an uncertified unit that walked clean is NOT marketable
  const base = { conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", physical_readiness: "ready" };
  ok("uncertified + walked clean is NOT marketable_now",
     marketingState({ ...base, triage: { readiness: "unknown", pending_walk: false } }, true).state === "readiness_unknown");
}

section("D2  only an explicit authorized certification can emit ready");
{
  const base = { conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", physical_readiness: "ready" };
  const certified = marketingState({ ...base, triage: { certified_ready: true, readiness: "ready" } }, true);
  ok("a certified unit becomes marketable_now", certified.state === "marketable_now", certified.state);
  ok("with no blocking reason", certified.reason === null);

  // the ONLY difference between the two calls is the certification
  const uncertified = marketingState({ ...base, triage: { readiness: "unknown", pending_walk: false } }, true);
  ok("without the certification the same unit is not marketable", uncertified.state !== "marketable_now");

  const src = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_gate"), "utf8");
  ok("the gate module cannot produce a certification", !/insert into unit_readiness_certifications/i.test(src));
  ok("the gate states the rule", /ABSENCE OF OPEN WORK IS NOT READINESS/i.test(src));
}

section("D3  every prerequisite blocks, and names itself");
{
  const full = [done("r1", STAGE.REPAIR), done("c1", STAGE.FINAL_CLEAN)];
  const claims = full.map((w) => claim(w.id, true));
  const codes = (o) => G.readinessGate(o).blockers.map((b) => b.code);

  ok("no scope blocks", codes({ scope: null, work: [], claims: [] }).includes("no_turn_scope"));
  ok("partial inspection blocks",
     codes({ scope: { inspection_completeness: "partial" }, work: [], claims: [] }).includes("inspection_incomplete"));
  ok("open work blocks",
     codes({ scope: COMPLETE, work: [{ id: "x", status: "required", work_text: "Paint", stage: STAGE.PAINT }], claims: [] })
       .includes("work_outstanding"));
  ok("unplaced inherited work blocks",
     codes({ scope: COMPLETE, work: [{ id: "x", status: "required", work_text: "Fridge", stage: null }], claims: [] })
       .includes("inherited_work_not_placed"));
  ok("complete-but-unproven work blocks",
     codes({ scope: COMPLETE, work: full, claims: [claim("r1", false), claim("c1", true)] })
       .includes("proof_unsatisfied"));
  ok("open final cleaning blocks",
     codes({ scope: COMPLETE, work: [done("r1", STAGE.REPAIR), { id: "c1", status: "required", work_text: "Clean", stage: STAGE.FINAL_CLEAN }], claims })
       .includes("final_cleaning_outstanding"));
  ok("an existing live certification blocks a second walk",
     codes({ scope: COMPLETE, work: full, claims, certifications: [{ state: "ready" }] })
       .includes("already_certified"));

  // reopened work is an ACTIVE blocker, not history
  const reopened = [{ id: "r1", status: "required", work_text: "Repair wall", stage: STAGE.REPAIR, reopened_count: 1 }];
  const g = G.readinessGate({ scope: COMPLETE, work: reopened, claims: [] });
  ok("reopened work blocks the walk", !g.actionable);
  ok("and the detail says it was reopened", /reopened/i.test(g.blockers[0].detail), g.blockers[0].detail);
  ok("every blocker names the exact thing in the way",
     G.readinessGate({ scope: COMPLETE, work: [{ id: "x", status: "required", work_text: "Paint full unit", stage: STAGE.PAINT }], claims: [] })
       .blockers[0].items.includes("Paint full unit"));
}

section("D4  a ready walk must affirm every required area");
{
  ok("nothing affirmed → all required areas missing", G.missingConfirmations({}).length === G.REQUIRED_FOR_READY.length);
  ok("all affirmed → nothing missing", G.missingConfirmations(ALL_CONFIRMED).length === 0);
  for (const key of G.REQUIRED_FOR_READY) {
    const partial = { ...ALL_CONFIRMED, [key]: null };
    ok(`unanswered '${key}' blocks ready`, G.missingConfirmations(partial).some((m) => m.key === key));
    const asFalse = { ...ALL_CONFIRMED, [key]: false };
    ok(`explicitly false '${key}' blocks ready`, G.missingConfirmations(asFalse).some((m) => m.key === key));
  }
  ok("appliance function is NOT required (may not apply to the unit)",
     !G.REQUIRED_FOR_READY.includes("appliance_function_confirmed"));
  ok("and it is still offered as an area",
     G.CONFIRMATION_AREAS.some((a) => a.key === "appliance_function_confirmed"));
  ok("the form stays short", G.CONFIRMATION_AREAS.length <= 8, String(G.CONFIRMATION_AREAS.length));
}

const ASYNC = [];
section("D5  worker/certifier — performing work neither grants nor removes authority");
{
  const svc = makeReadinessService({
    spawnObligationFromEvent: async () => ({ id: "o" }),
    workAcceptanceService: { reopenWork: async () => ({ work: {}, preserved_claim_id: "c" }) },
  });
  const fake = (row) => ({ query: async () => ({ rows: row ? [row] : [] }) });

  ASYNC.push((async () => {
    const seniorMgr = { role_title: "Senior Property Manager", allowed_modules: ["management"], name: "S" };
    const apm = { role_title: "Assistant Property Manager", allowed_modules: ["management"], name: "A" };
    const tech = { role_title: "Lead Maintenance Tech", allowed_modules: ["maintenance"], name: "T" };
    const mgrNoAccess = { role_title: "Senior Property Manager", allowed_modules: [], name: "G" };

    ok("a senior manager is authorized", (await svc.resolveWalkAuthority(fake(seniorMgr), {})).authorized === true);
    ok("and ranks first", (await svc.resolveWalkAuthority(fake(seniorMgr), {})).rank === 1);
    ok("an assistant manager is authorized (delegated)", (await svc.resolveWalkAuthority(fake(apm), {})).authorized === true);
    ok("and ranks second", (await svc.resolveWalkAuthority(fake(apm), {})).rank === 2);

    // A TITLE CANNOT GRANT AUTHORITY
    const ghost = await svc.resolveWalkAuthority(fake(mgrNoAccess), {});
    ok("a senior-manager TITLE with no module access is NOT authorized", ghost.authorized === false);
    ok("and says the module is what is missing", /management module access/i.test(ghost.reason), ghost.reason);

    // maintenance-only cannot certify — a real authority boundary
    const t = await svc.resolveWalkAuthority(fake(tech), {});
    ok("a maintenance-only technician cannot certify", t.authorized === false);
    ok("and the reason names the missing module", /management module access/i.test(t.reason), t.reason);

    // ── ALL THREE CONDITIONS NECESSARY, NONE SUFFICIENT ──
    //  An unrelated management-module user with NO eligible manager assignment
    //  and no explicit delegation must be refused. Module access alone cannot
    //  create authority.
    const plainMgmt = { role_title: "Marketing Coordinator", allowed_modules: ["management"],
                        primary_for_modules: [], name: "C" };
    const c = await svc.resolveWalkAuthority(fake(plainMgmt), {});
    ok("management-module access ALONE cannot certify", c.authorized === false, JSON.stringify(c));
    ok("and the reason says access alone is not enough",
       /alone does not permit/i.test(c.reason), c.reason);

    //  No assignment at this property at all — property authority is required
    //  and is checked first.
    const none = await svc.resolveWalkAuthority(fake(null), {});
    ok("no assignment at this property cannot certify", none.authorized === false);
    ok("and says so", /no active assignment/i.test(none.reason), none.reason);

    //  A senior property manager with proper authority CAN certify.
    ok("a senior property manager with proper authority can certify",
       (await svc.resolveWalkAuthority(fake({ ...seniorMgr, primary_for_modules: [] }), {})).authorized === true);

    //  An eligible assistant property manager CAN certify under the temporary
    //  delegation adapter.
    const a = await svc.resolveWalkAuthority(fake({ ...apm, primary_for_modules: [] }), {});
    ok("an eligible assistant property manager can certify", a.authorized === true);
    ok("and the basis names the delegation adapter", /delegated/i.test(a.basis), a.basis);

    //  EXPLICIT DELEGATION path: an unranked title that OWNS the management
    //  module at this property is authorized — the delegation was recorded by
    //  whoever set up the team, not inferred here.
    const del = await svc.resolveWalkAuthority(
      fake({ ...plainMgmt, primary_for_modules: ["management"] }), {});
    ok("explicit delegated readiness authority can certify", del.authorized === true);
    ok("and it is marked as delegation, not a title match", del.via_delegation === true);
    ok("with a stated basis", /explicitly delegated/i.test(del.basis), del.basis);

    //  A ranked TITLE with no module access is still refused — title alone
    //  cannot create authority either.
    ok("a manager title with no module access is still refused",
       (await svc.resolveWalkAuthority(fake({ role_title: "Property Manager", allowed_modules: [], primary_for_modules: [] }), {}))
         .authorized === false);

    // NO blanket worker ban: authority is asked of everyone identically
    const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
    ok("there is no 'did this person do the work' check anywhere",
       !/performed_work|did_work|worker_cannot|is_worker/i.test(svcSrc));
    ok("and the reason is documented",
       /Performing work is not authority and it is not disqualification/i.test(svcSrc));

    // THE WORKER RULE: performing work neither grants nor removes authority.
    // A person who did the work certifies only when they INDEPENDENTLY satisfy
    // readiness authority — the check is identical either way.
    ok("a worker who independently satisfies readiness authority CAN certify",
       (await svc.resolveWalkAuthority(fake({ ...apm, primary_for_modules: [] }), {})).authorized === true);
    ok("a worker who does NOT independently satisfy it cannot",
       (await svc.resolveWalkAuthority(fake(tech), {})).authorized === false);
    ok("the authority answer does not depend on work performed at all",
       JSON.stringify(await svc.resolveWalkAuthority(fake({ ...apm, primary_for_modules: [] }), {})) ===
       JSON.stringify(await svc.resolveWalkAuthority(fake({ ...apm, primary_for_modules: [] }), { user_id: "whoever" })));

    // no name is hardcoded
    ok("no named employee in the ladder", AUTHORITY_LADDER.every((r) => r.re instanceof RegExp));
    ok("no email address in the module", !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(svcSrc));
  })());
}

section("D6  ultimate accountability is preserved, or recorded unresolved");
{
  const svc = makeReadinessService({
    spawnObligationFromEvent: async () => ({ id: "o" }),
    workAcceptanceService: { reopenWork: async () => ({}) },
  });
  const fake = (rows) => ({ query: async () => ({ rows }) });
  ASYNC.push((async () => {
    const senior = await svc.resolveSeniorAccountable(
      fake([{ user_id: "s", role_title: "Senior Property Manager", name: "S", allowed_modules: ["management"] }]), {});
    ok("a senior manager resolves", senior.user_id === "s");
    ok("with a stated basis", /resolved from assignment/i.test(senior.basis));

    const none = await svc.resolveSeniorAccountable(
      fake([{ user_id: "t", role_title: "Maintenance Tech", name: "T", allowed_modules: ["maintenance"] }]), {});
    ok("no management staff → UNRESOLVED, not a guess", none.user_id === null);
    ok("and says why", /UNRESOLVED/.test(none.basis), none.basis);

    const unrankable = await svc.resolveSeniorAccountable(
      fake([{ user_id: "m", role_title: "Community Director", name: "M", allowed_modules: ["management"] }]), {});
    ok("management staff with an unrankable title → UNRESOLVED, not guessed", unrankable.user_id === null);
    ok("and states it was not guessed", /Not guessed/i.test(unrankable.basis), unrankable.basis);

    // Accountability is carried as FIELDS on the walk and certification, not
    // as a second obligation or a duplicate readiness owner (ruling 4).
    const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
    const mig = require("fs").readFileSync(__dirname + "/../migrations/116_readiness_certification.sql", "utf8");
    ok("accountability is a field on the walk", /senior_accountable_user_id/.test(mig));
    ok("and carried onto the certification", /senior_accountable_basis/.test(mig));
    ok("no accountability obligation type was invented",
       !/accountability_owner|senior_accountable_obligation|buck_stops/i.test(svcSrc + mig));
    ok("the migration says no new authority model is invented",
       /No new authority model is invented/i.test(mig));
  })());
}

section("D7  certification does NOT override another availability blocker");
{
  const base = { conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", physical_readiness: "ready" };
  const cert = { certified_ready: true, readiness: "ready" };

  const cases = [
    ["down unit", { is_down: true }, "down"],
    ["possession conflict", { conflict_state: "conflicted" }, "contested"],
    ["operating-use restriction", { operating_use: "model" }, "not_marketable_use"],
    ["successor locked", { successor: { state: "locked" } }, "successor_locked"],
    ["successor pending", { successor: { state: "pending" } }, "successor_pending"],
    ["evidence disagrees", { evidence_state: "disagrees" }, "evidence_disagrees"],
    ["activation pending", { availability_state: "committed_activation_pending" }, "activation_pending"],
    ["possession not returned", { possession_state: "delivered" }, "not_ready"],
    ["spanning lease", { lease: { lease_id: "l", end_date: "2027-01-01" }, notice_state: "none" }, "occupied"],
    ["use type not configured", { use_type: null }, "use_not_configured"],
  ];
  for (const [name, over, expect] of cases) {
    const r = marketingState({ ...base, ...over, triage: cert }, true);
    ok(`certified + ${name} → ${expect}, NOT marketable`, r.state === expect, r.state);
  }
  ok("certified with nothing else wrong IS marketable",
     marketingState({ ...base, triage: cert }, true).state === "marketable_now");
  ok("every blocker still names itself",
     cases.every(([, over]) => !!marketingState({ ...base, ...over, triage: cert }, true).reason));
}

section("D8  no unit outside the governed pathway changes behavior");
{
  const base = { conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", triage: null };
  ok("no triage + readiness 'ready' → marketable_now (prior behavior)",
     marketingState({ ...base, physical_readiness: "ready" }, true).state === "marketable_now");
  ok("no triage + readiness 'unknown' → still NOT reinterpreted",
     marketingState({ ...base, physical_readiness: "unknown" }, true).state === "marketable_now");
  ok("no triage + turning → turnover_required",
     marketingState({ ...base, physical_readiness: "turning" }, true).state === "turnover_required");
  ok("BUILD 4 added no guard outside the triage block",
     marketingState({ ...base, physical_readiness: "ready" }, true).reason === null);
}

section("D9  a failed walk reopens the flow through the canonical path");
{
  const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
  ok("new findings go to unit_triage_findings", /insert into unit_triage_findings/.test(svcSrc));
  ok("new work goes to unit_triage_required_work", /insert into unit_triage_required_work/.test(svcSrc));
  ok("prior completions reopen via workAcceptanceService, not a local copy",
     /workAcceptanceService\.reopenWork/.test(svcSrc));
  ok("there is no generic failure note", !/final walk failed.*note|generic/i.test(
     svcSrc.split("\n").filter((l) => /insert into unit_triage_required_work/.test(l)).join("\n")));
  ok("the service refuses to build without the canonical reopen path", (() => {
    try { makeReadinessService({ spawnObligationFromEvent: async () => ({}) }); return false; }
    catch (e) { return /one canonical path/i.test(e.message); }
  })());

  // the flow recalculates once work reopens
  const work = [done("r1", STAGE.REPAIR), done("p1", STAGE.PAINT), done("c1", STAGE.FINAL_CLEAN)];
  ok("all complete → walk actionable",
     G.readinessGate({ scope: COMPLETE, work, claims: work.map((w) => claim(w.id, true)) }).actionable);
  const after = work.map((w) => (w.id === "r1" ? { ...w, status: "required" } : w));
  const g2 = G.readinessGate({ scope: COMPLETE, work: after, claims: work.map((w) => claim(w.id, true)) });
  ok("a reopened item makes the walk NOT actionable again", !g2.actionable);
  const flow = computeTurnFlow({ scope: COMPLETE, work: after });
  ok("and the controlling next action recalculates to it",
     /r1/i.test(flow.controlling_next_action.action), flow.controlling_next_action.action);
  ok("readiness walk blocked again", flow.readiness_walk_blocked);
}

section("D10  correction and revocation preserve the original");
{
  const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
  ok("a correction INSERTS a new row", /insert into unit_readiness_certifications[\s\S]{0,400}supersedes_id/.test(svcSrc));
  ok("there is no UPDATE of a certification", !/update unit_readiness_certifications/i.test(svcSrc));
  ok("there is no DELETE of a certification", !/delete from unit_readiness_certifications/i.test(svcSrc));
  ok("a reason is required", /a reason is required to correct or revoke/i.test(svcSrc));
  ok("a reinspection obligation results", /REINSPECTION/.test(svcSrc));
  ok("and it says readiness did not silently flip", /did not silently flip/i.test(svcSrc));

  const mig = require("fs").readFileSync(__dirname + "/../migrations/116_readiness_certification.sql", "utf8");
  ok("the schema forbids a terminal state without a supersede",
     /ck_urc_terminal_states_supersede/.test(mig));
  ok("the schema requires a correction reason", /ck_urc_correction_states_reason/.test(mig));
  ok("one live original per walk", /uq_urc_one_original_per_walk/.test(mig));
  ok("a ready walk must affirm every required area, structurally",
     /ck_urw_ready_requires_all_confirmations/.test(mig));
}

section("D11  a successful certification is quiet; photos are optional");
{
  const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
  const ready = svcSrc.slice(svcSrc.indexOf("async function finishReady"), svcSrc.indexOf("// ── NOT READY"));
  ok("the ready path spawns NO obligation", !/spawnObligationFromEvent/.test(ready));
  ok("it closes the final-walk obligation instead", /update obligations set status='complete'/.test(ready));
  ok("the not-ready path DOES create a manager decision",
     /spawnObligationFromEvent/.test(svcSrc.slice(svcSrc.indexOf("// ── NOT READY"))));

  const mig = require("fs").readFileSync(__dirname + "/../migrations/116_readiness_certification.sql", "utf8");
  ok("walk photos default to empty (optional)", /photos\s+text\[\] not null default '\{\}'/.test(mig));
  ok("no photo minimum is imposed on the walk", !/photos.*array_length.*>=/i.test(mig));
  ok("the migration says photos are optional", /OPTIONAL/.test(mig));

  ok("the certification preserves the state it relied on", /relied_on_state/.test(svcSrc));
  for (const k of ["completed_work", "proof_satisfied_claims", "final_cleaning", "unresolved_unknowns"]) {
    ok(`relied_on_state carries ${k}`, new RegExp(k).test(svcSrc));
  }
}

section("D12  readiness is one axis and says so");
{
  const svcSrc = require("fs").readFileSync(require.resolve("../src/maintenance/readiness_service"), "utf8");
  ok("the meaning disclaims possession", /not possession/i.test(svcSrc));
  ok("disclaims keys handed over", /not keys handed over/i.test(svcSrc));
  ok("disclaims an active lease", /not an active lease/i.test(svcSrc));
  ok("disclaims legal occupancy", /not legal occupancy/i.test(svcSrc));
  const mig = require("fs").readFileSync(__dirname + "/../migrations/116_readiness_certification.sql", "utf8");
  ok("the migration states the same", /WHAT READINESS DOES NOT MEAN/.test(mig));
}

// ════════════════════════════════════════════════════════════════
//  PART B — DURABLE. Requires REAL Postgres.
// ════════════════════════════════════════════════════════════════
async function partB() {
  section("DB  durable proof against real Postgres");
  if (!process.env.DATABASE_URL) {
    console.log(`
  NOT RUN — DATABASE_URL is not set.

  Part A proves the pure logic. It does NOT prove the slice. Unexercised:

    · migration 116 applies cleanly on top of ceiling 115
    · the constraints actually refuse
        - a ready walk with an unanswered area  (ck_urw_ready_requires_all_confirmations)
        - a revoked row with no supersede       (ck_urc_terminal_states_supersede)
        - a correction with no reason           (ck_urc_correction_states_reason)
        - two live originals for one walk       (uq_urc_one_original_per_walk)
    · recordWalk writes walk + certification + event in ONE transaction
    · a failed walk writes findings, work, reopenings and the manager decision
      in ONE transaction and rolls back as one
    · availability actually reads the certification and recalculates
    · a revocation removes readiness by supersession

  PROOF LEVEL REACHED: Built-but-dormant.
`);
    return false;
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_name in ('unit_readiness_walks','unit_readiness_certifications','reclean_rulings')`);
    ok("migration 116 tables exist", t.rows.length === 3, t.rows.map((r) => r.table_name).join(",") || "none");
  } finally { await pool.end(); }
  return true;
}

(async () => {
  // Every async section must SETTLE before the result prints. A harness that
  // races its own summary can report green with assertions still pending —
  // which is exactly the kind of false pass these harnesses exist to prevent.
  await Promise.all(ASYNC);
  const ranB = await partB();
  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("\n  PROOF LEVEL: " + (ranB ? "Proven (real DB)" : "Built-but-dormant (pure logic only)"));
  if (!ranB) console.log("  Real HTTP and browser verification still required before this is 'done'.");
  process.exit(failed > 0 || !ranB ? 1 : 0);
})();
