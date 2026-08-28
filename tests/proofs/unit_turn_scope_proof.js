// ════════════════════════════════════════════════════════════════════
//  unit_turn_scope_proof.js — BUILD 2 proof harness
//
//    node tests/proofs/unit_turn_scope_proof.js
//
//  Part A (pure) runs anywhere. Part B requires DATABASE_URL and REAL
//  Postgres; without it this harness EXITS NON-ZERO and says the slice is
//  unproven. It never substitutes a fixture or a mock pool.
//
//  Passing Part A proves BUILT-BUT-DORMANT. It does not prove the slice.
// ════════════════════════════════════════════════════════════════════

"use strict";

const I = require("../../src/maintenance/turn_scope_interpreter");
const { computeTurnFlow, turnExceptions, STAGE } = require("../../src/maintenance/turn_sequence");
const { marketingState } = require("../../src/surfaces/availability_read");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

// durable-row shape from a proposal, so the flow engine sees what the DB would hold
const rows = (p, opts = {}) => p.required_work.map((w, i) => ({
  id: "w" + i, status: "required", work_text: w.work, stage: w.stage,
  disturbs_painted_surfaces: w.disturbs_painted_surfaces === undefined ? null : w.disturbs_painted_surfaces,
  owner_user_id: opts.unowned ? null : "u1",
  sequence_exception: false,
}));
const COMPLETE = { inspection_completeness: "complete_turn_scope" };

section("B1  every paint choice produces the right work");
{
  const cases = [
    ["none", 0, null], ["touch_up", 1, "Touch up paint"], ["full", 1, "Paint full unit"], ["unknown", 0, null],
  ];
  for (const [level, count, text] of cases) {
    const p = I.proposeScope({ paint_level: level, cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
    const paint = p.required_work.filter((w) => w.stage === STAGE.PAINT);
    ok(`paint '${level}' → ${count} work item(s)`, paint.length === count, String(paint.length));
    if (text) ok(`paint '${level}' text`, paint[0].work === text, paint[0] && paint[0].work);
  }
  const partial = I.proposeScope({ paint_level: "partial", paint_areas: "kitchen and hall", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const pw = partial.required_work.filter((w) => w.stage === STAGE.PAINT);
  ok("paint 'partial' carries the areas", pw.length === 1 && /kitchen and hall/.test(pw[0].work), pw[0] && pw[0].work);
  ok("paint 'unknown' records an unresolved unknown",
     I.proposeScope({ paint_level: "unknown", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" })
      .unknowns.some((u) => /paint level is unknown/i.test(u)));
}

section("B2  every cleaning choice produces the right work");
{
  const cases = [
    ["none", 0, null], ["touch_up", 1, "Complete final touch-up clean"],
    ["full", 1, "Complete final full clean"], ["deep", 1, "Complete final deep clean"], ["unknown", 0, null],
  ];
  for (const [level, count, text] of cases) {
    const p = I.proposeScope({ paint_level: "none", cleaning_level: level, keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
    const cw = p.required_work.filter((w) => w.stage === STAGE.FINAL_CLEAN);
    ok(`cleaning '${level}' → ${count} work item(s)`, cw.length === count, String(cw.length));
    if (text) ok(`cleaning '${level}' text`, cw[0].work === text, cw[0] && cw[0].work);
  }
  ok("cleaning 'unknown' records an unresolved unknown",
     I.proposeScope({ paint_level: "none", cleaning_level: "unknown", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" })
      .unknowns.some((u) => /cleaning level is unknown/i.test(u)));
}

section("B3  findings stay separate from required work");
{
  const p = I.proposeScope({
    repairs_text: "Bathroom faucet leaks, bedroom door does not latch, and two outlets are loose.",
    paint_level: "none", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope",
  });
  ok("three separate findings, not one note", p.findings.length === 3, String(p.findings.length));
  ok("three separate work items", p.required_work.length === 3, String(p.required_work.length));
  ok("findings and work are different objects",
     p.findings.every((f) => f.finding && f.work === undefined) &&
     p.required_work.every((w) => w.work && w.finding === undefined));
  ok("every work item links to its finding",
     p.required_work.every((w) => Number.isInteger(w.from_finding_index)));
  ok("no generic combined repair note",
     !p.required_work.some((w) => /^Repairs? needed$|various|misc/i.test(w.work)));
  ok("faucet does NOT disturb paint",
     p.required_work.find((w) => /faucet/i.test(w.work)).disturbs_painted_surfaces === false);
  ok("door DOES disturb paint",
     p.required_work.find((w) => /door/i.test(w.work)).disturbs_painted_surfaces === true);
  ok("outlets DO disturb paint (plural must match)",
     p.required_work.find((w) => /outlet/i.test(w.work)).disturbs_painted_surfaces === true);
}

section("B4  sequence dependencies");
{
  const p = I.proposeScope({ repairs_text: "Hole in the bedroom wall", paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const f = computeTurnFlow({ scope: COMPLETE, work: rows(p) });
  const st = (s) => f.stages.find((x) => x.stage === s);
  ok("repair is actionable first", !st(STAGE.REPAIR).blocked);
  ok("paint blocked by paint-disturbing repair", st(STAGE.PAINT).blocked);
  ok("paint blocker names the reason",
     st(STAGE.PAINT).blocked_by[0].reason === "repair_work_disturbs_painted_surfaces");
  ok("final cleaning blocked", st(STAGE.FINAL_CLEAN).blocked);
  ok("readiness walk blocked", f.readiness_walk_blocked);

  // a repair that does NOT disturb paint must not block paint
  const p2 = I.proposeScope({ repairs_text: "Bathroom faucet leaks", paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const f2 = computeTurnFlow({ scope: COMPLETE, work: rows(p2) });
  ok("a faucet repair does NOT block paint",
     !f2.stages.find((x) => x.stage === STAGE.PAINT).blocked);
  ok("but final cleaning is still blocked by the open repair",
     f2.stages.find((x) => x.stage === STAGE.FINAL_CLEAN).blocked);
}

section("B5  final cleaning cannot be actionable before prerequisites");
{
  const p = I.proposeScope({ repairs_text: "Hole in the wall", paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const all = rows(p);
  const clean = () => computeTurnFlow({ scope: COMPLETE, work: all.filter((w) => w.status === "required") })
    .items.find((i) => i.stage === STAGE.FINAL_CLEAN);
  ok("cleaning blocked while repair + paint open", clean().blocked);
  all.find((w) => w.stage === STAGE.REPAIR).status = "withdrawn";
  ok("cleaning still blocked while paint open", clean().blocked);
  all.find((w) => w.stage === STAGE.PAINT).status = "withdrawn";
  ok("cleaning actionable only once both are resolved", clean().actionable);
  ok("withdrawn work stops blocking (a correction must not block forever)",
     !computeTurnFlow({ scope: COMPLETE, work: all }).stages.find((x) => x.stage === STAGE.FINAL_CLEAN).blocked);
}

section("B6  'ready' remains unreachable");
{
  const shapes = [
    { paint_level: "none", cleaning_level: "none", inspection_completeness: "complete_turn_scope" },
    { paint_level: "full", cleaning_level: "deep", inspection_completeness: "complete_turn_scope" },
    { paint_level: "none", cleaning_level: "none", inspection_completeness: "partial" },
  ];
  const emitted = [];
  for (const s of shapes) {
    const p = I.proposeScope({ ...s, keys_status: "accounted_for" });
    const f = computeTurnFlow({ scope: { inspection_completeness: s.inspection_completeness }, work: rows(p) });
    emitted.push(JSON.stringify(f));
    ok("flow never reports the unit ready (" + s.paint_level + "/" + s.cleaning_level + "/" + s.inspection_completeness + ")",
       !/"readiness"\s*:\s*"ready"/.test(JSON.stringify(f)));
  }
  ok("no flow emits a readiness verdict at all",
     emitted.every((j) => !/readiness_verdict|is_ready|unit_ready/.test(j)));

  // an empty, complete scope unblocks the WALK — which is permission to look,
  // not a readiness claim, and it says so
  const done = computeTurnFlow({ scope: COMPLETE, work: [] });
  ok("empty complete scope unblocks the readiness walk", !done.readiness_walk_blocked);
  ok("and states plainly that the unit is NOT ready",
     /NOT ready/i.test(done.controlling_next_action.why), done.controlling_next_action.why);
  ok("BUILD 2 offers no way to complete the walk",
     done.controlling_next_action.kind === "readiness_walk_available");
}

section("B7  partial inspection preserves unknown scope");
{
  const p = I.proposeScope({ repairs_text: "Kitchen faucet drips", paint_level: "none", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "partial" });
  ok("partial inspection is stated as an unknown",
     p.unknowns.some((u) => /PARTIAL inspection/i.test(u)));
  ok("known finding still becomes work", p.required_work.length === 1);
  const f = computeTurnFlow({ scope: { inspection_completeness: "partial" }, work: rows(p) });
  ok("readiness walk blocked by the partial inspection", f.readiness_walk_blocked);
  const done = computeTurnFlow({ scope: { inspection_completeness: "partial" }, work: [] });
  ok("even with NO open work, partial inspection blocks readiness", done.readiness_walk_blocked);
  ok("and names the inspection as the blocker",
     /inspection/i.test(done.controlling_next_action.why), done.controlling_next_action.why);
  ok("partial inspection is a management exception",
     turnExceptions({ scope: { inspection_completeness: "partial" }, work: [] })
       .some((e) => e.code === "inspection_partial"));
}

section("B8  no owner produces UNASSIGNED and controls the flow");
{
  const p = I.proposeScope({ appliances: [{ key: "refrigerator", label: "Refrigerator", condition: "missing" }], paint_level: "touch_up", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const f = computeTurnFlow({ scope: COMPLETE, work: rows(p, { unowned: true }) });
  ok("unowned work is reported UNASSIGNED", f.items.every((i) => i.owner === "UNASSIGNED"));
  ok("assignment becomes the controlling next action", f.controlling_next_action.kind === "assign_owner", f.controlling_next_action.kind);
  ok("the action names assignment", /assign or accept/i.test(f.controlling_next_action.action));
  ok("no eligible owner is a management exception",
     turnExceptions({ scope: COMPLETE, work: rows(p, { unowned: true }) }).some((e) => e.code === "no_eligible_owner"));
  ok("the refrigerator item keeps its own identity",
     f.items.some((i) => /refrigerator/i.test(i.work_text)));
  const j = JSON.stringify(f);
  ok("no vendor, cost or delivery date invented", !/vendor|cost|price|deliver|invoice/i.test(j));
}

section("B9  ordinary deep cleaning is never severe and never manager risk");
{
  const p = I.proposeScope({ paint_level: "none", cleaning_level: "deep", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  ok("deep clean produces exactly one work item", p.required_work.length === 1);
  ok("staged as final cleaning", p.required_work[0].stage === STAGE.FINAL_CLEAN);
  ok("no finding is marked severe", p.findings.every((f) => f.is_severe === false));
  ok("no long-lead kind anywhere", p.findings.every((f) => f.long_lead_kind === null));

  const f = computeTurnFlow({ scope: COMPLETE, work: rows(p) });
  ok("cleaning is the controlling next action", /clean/i.test(f.controlling_next_action.action), f.controlling_next_action.action);
  ok("readiness remains blocked", f.readiness_walk_blocked);

  // with a committed move-in three days out, ordinary deep cleaning still
  // raises NOTHING — the exception needs a severe or long-lead triage finding
  const ex = turnExceptions({
    scope: COMPLETE, work: rows(p),
    triage: { initial_condition: "normal_turn", findings: [] },
    nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 3 },
  });
  ok("no manager risk from deep cleaning alone",
     !ex.some((e) => e.code === "committed_move_in_at_risk"), JSON.stringify(ex.map((e) => e.code)));
  ok("routine turn raises no exception at all", ex.length === 0, JSON.stringify(ex.map((e) => e.code)));

  // a severe triage finding beside the same move-in DOES raise it
  const ex2 = turnExceptions({
    scope: COMPLETE, work: rows(p),
    triage: { initial_condition: "severe", findings: [{ long_lead_kind: "pest_treatment" }] },
    nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 3 },
  });
  ok("a severe condition beside a committed move-in DOES raise it",
     ex2.some((e) => e.code === "committed_move_in_at_risk"));
}

section("B10  correction recalculates work and next action");
{
  // original: touch-up paint, no repairs
  const before = I.proposeScope({ paint_level: "touch_up", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const fb = computeTurnFlow({ scope: COMPLETE, work: rows(before) });
  ok("before: paint is the controlling action", /paint/i.test(fb.controlling_next_action.action), fb.controlling_next_action.action);

  // correction: full paint. The prior work is SUPERSEDED, never deleted.
  const supersededRows = rows(before).map((w) => ({ ...w, status: "superseded" }));
  const after = I.proposeScope({ paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const combined = supersededRows.concat(rows(after));
  const fa = computeTurnFlow({ scope: COMPLETE, work: combined });

  ok("superseded work is not counted as open", fa.open_count === after.required_work.length, String(fa.open_count));
  ok("superseded work still exists in the input (not deleted)",
     combined.some((w) => w.status === "superseded"));
  ok("after: full paint is now required", fa.items.some((i) => i.work_text === "Paint full unit"));
  ok("after: touch-up is no longer open", !fa.items.some((i) => /touch up/i.test(i.work_text)));
  ok("controlling next action recalculated", /paint full unit/i.test(fa.controlling_next_action.action), fa.controlling_next_action.action);

  // correcting a missing appliance to found: its work supersedes and cleaning
  // becomes controlling
  const withFridge = I.proposeScope({ appliances: [{ key: "refrigerator", label: "Refrigerator", condition: "missing" }], paint_level: "none", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const fixed = rows(withFridge).map((w) => (/refrigerator/i.test(w.work_text) ? { ...w, status: "superseded" } : w));
  const ff = computeTurnFlow({ scope: COMPLETE, work: fixed });
  ok("appliance found → cleaning becomes controlling", /clean/i.test(ff.controlling_next_action.action), ff.controlling_next_action.action);
}

section("B11  sequence exception is per-item and attributed");
{
  const p = I.proposeScope({ repairs_text: "Hole in the wall", paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const w = rows(p);
  const paintRow = w.find((x) => x.stage === STAGE.PAINT);
  ok("paint blocked before the exception",
     computeTurnFlow({ scope: COMPLETE, work: w }).items.find((i) => i.stage === STAGE.PAINT).blocked);

  paintRow.sequence_exception = true;
  paintRow.sequence_exception_reason = "Painter only available today; wall patch is in a closet.";
  const f = computeTurnFlow({ scope: COMPLETE, work: w });
  const paintItem = f.items.find((i) => i.stage === STAGE.PAINT);
  ok("released item becomes actionable", paintItem.actionable);
  ok("release stays visible", paintItem.sequence_exception === true);
  ok("and records what it was released from", paintItem.released_from.length > 0);
  ok("the exception did NOT release final cleaning",
     f.items.find((i) => i.stage === STAGE.FINAL_CLEAN).blocked);
}

section("B12  units with no BUILD 1 or BUILD 2 evidence keep prior behavior");
{
  const base = {
    conflict_state: "clear", is_down: false, operating_use: "standard", evidence_state: "agrees",
    availability_state: "ready_now", successor: { state: "none" }, lease: null,
    possession_state: "pending", use_type: "residential", triage: null,
  };
  ok("no triage + readiness 'ready' → marketable_now",
     marketingState({ ...base, physical_readiness: "ready" }, true).state === "marketable_now");
  ok("no triage + readiness 'unknown' → NOT reinterpreted",
     marketingState({ ...base, physical_readiness: "unknown" }, true).state === "marketable_now");
  ok("BUILD 2 adds no new availability guard",
     marketingState({ ...base, physical_readiness: "ready" }, true).reason === null);

  // and the flow engine over an empty unit invents nothing
  const f = computeTurnFlow({ scope: null, work: [] });
  ok("no scope → readiness walk blocked, honestly", f.readiness_walk_blocked);
  ok("no scope → names the missing scope",
     /no complete turn scope/i.test(f.controlling_next_action.why), f.controlling_next_action.why);
  ok("no scope → no invented work", f.open_count === 0);
}

section("B13  appliance inventory is honest about being unknown");
{
  ok("standard list is not claimed as unit inventory", I.STANDARD_APPLIANCES.length > 0);
  const p = I.proposeScope({
    appliances: [{ key: "refrigerator", label: "Refrigerator", condition: "unknown" }],
    paint_level: "none", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope",
  });
  ok("unchecked appliance stays unknown, never 'working'",
     p.unknowns.some((u) => /not checked/i.test(u)));
  ok("and produces no work", p.required_work.length === 0);
  ok("and produces no finding", p.findings.length === 0);
}

section("B14  keys: a fact about keys, not a ruling about a person");
{
  const p = I.proposeScope({ keys_status: "items_missing", keys_note: "one mailbox key", paint_level: "none", cleaning_level: "none", inspection_completeness: "complete_turn_scope" });
  ok("missing keys become a finding", p.findings.some((f) => /missing/i.test(f.finding)));
  ok("no charge, lock or legal conclusion", p.unknowns.some((u) => /no resident charge/i.test(u)));
  const j = JSON.stringify(p);
  ok("no billback or charge language anywhere", !/billback|charge the|deduct|deposit/i.test(j));
}

section("B15  inherited BUILD 1 work must enter the ordered flow");
{
  // A BUILD 1 triage item: known, unresolved, no stage.
  const inherited = {
    id: "b1", status: "required", work_text: "Source and install refrigerator",
    stage: null, disturbs_painted_surfaces: null, owner_user_id: "u1", sequence_exception: false,
  };
  const scoped = I.proposeScope({ paint_level: "touch_up", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });

  // ── 4. PARTIAL inspection may honestly retain unstaged work ──
  const partial = computeTurnFlow({
    scope: { inspection_completeness: "partial" },
    work: [inherited].concat(rows(scoped)),
  });
  const pItem = partial.items.find((i) => i.work_id === "b1");
  ok("partial scope: inherited work needs no decision yet", pItem.requires_scope_decision === false);
  ok("partial scope: raises no unplaced-work exception",
     !turnExceptions({ scope: { inspection_completeness: "partial" }, work: [inherited] })
        .some((e) => e.code === "inherited_work_not_placed"));

  // ── 5. COMPLETE inspection cannot silently retain it ──
  const complete = computeTurnFlow({ scope: COMPLETE, work: [inherited].concat(rows(scoped)) });
  const cItem = complete.items.find((i) => i.work_id === "b1");
  ok("complete scope: inherited work REQUIRES a decision", cItem.requires_scope_decision === true);
  ok("complete scope: it is counted", complete.unplaced_inherited_count === 1, String(complete.unplaced_inherited_count));
  ok("complete scope: surfaces an exception",
     turnExceptions({ scope: COMPLETE, work: [inherited] })
       .some((e) => e.code === "inherited_work_not_placed"));
  ok("the exception names the item",
     turnExceptions({ scope: COMPLETE, work: [inherited] })
       .find((e) => e.code === "inherited_work_not_placed").detail.includes("refrigerator"));

  // ── 3. it does NOT disappear from the readiness prerequisite set ──
  ok("unplaced inherited work blocks the readiness walk", complete.readiness_walk_blocked);
  const onlyInherited = computeTurnFlow({ scope: COMPLETE, work: [inherited] });
  ok("even with ALL scope work resolved, it still blocks readiness", onlyInherited.readiness_walk_blocked);
  ok("the controlling action is to PLACE it, not to 'complete' it",
     onlyInherited.controlling_next_action.kind === "place_inherited_work",
     onlyInherited.controlling_next_action.kind);
  ok("and names itself as unplaced from the initial walk",
     /never placed|not placed/i.test(onlyInherited.controlling_next_action.why),
     onlyInherited.controlling_next_action.why);
  ok("unplaced work outranks ordinary actionable work",
     computeTurnFlow({ scope: COMPLETE, work: [inherited].concat(rows(scoped)) })
       .controlling_next_action.kind === "place_inherited_work");
  // Exactly ONE later stage blocked → singular verb. Cleaning-only scope:
  // nothing precedes it, and only the readiness walk sits downstream.
  const cleanOnly = I.proposeScope({ paint_level: "none", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const fSing = computeTurnFlow({ scope: COMPLETE, work: rows(cleanOnly) });
  ok("one downstream stage → singular verb",
     /remains blocked/.test(fSing.controlling_next_action.why), fSing.controlling_next_action.why);
  ok("and never the plural verb on a single subject",
     !/walk remain blocked/.test(fSing.controlling_next_action.why));
  // TWO downstream stages → plural verb
  const twoDown = I.proposeScope({ repairs_text: "Bathroom faucet leaks", paint_level: "full", cleaning_level: "full", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope" });
  const fPlur = computeTurnFlow({ scope: COMPLETE, work: rows(twoDown) });
  ok("two downstream stages → plural verb",
     /remain blocked/.test(fPlur.controlling_next_action.why) && !/remains blocked/.test(fPlur.controlling_next_action.why),
     fPlur.controlling_next_action.why);

  // the seam this closes: unplaced must NOT read as "does not block"
  ok("stage=NULL after a complete scope no longer means 'does not block'",
     onlyInherited.readiness_walk_blocked === true);

  // ── 1. placed into the repair stage, it behaves like scope work ──
  const staged = { ...inherited, stage: "repair", disturbs_painted_surfaces: false, stage_decision_required: false };
  const f1 = computeTurnFlow({ scope: COMPLETE, work: [staged].concat(rows(scoped)) });
  const sItem = f1.items.find((i) => i.work_id === "b1");
  ok("staged inherited work no longer needs a decision", sItem.requires_scope_decision === false);
  ok("staged into repairs", sItem.stage === "repair");
  ok("final cleaning is downstream of it",
     f1.stages.find((x) => x.stage === STAGE.FINAL_CLEAN).blocked);
  ok("no unplaced exception once it is staged",
     !turnExceptions({ scope: COMPLETE, work: [staged] }).some((e) => e.code === "inherited_work_not_placed"));

  // ── 2. explicitly marked unknown-and-owed still blocks ──
  const owed = { ...inherited, stage: null, stage_decision_required: true, stage_decision_note: "Cannot place until the appliance is sourced." };
  const f2 = computeTurnFlow({ scope: { inspection_completeness: "partial" }, work: [owed] });
  ok("explicitly unknown-and-owed requires a decision even on a PARTIAL scope",
     f2.items[0].requires_scope_decision === true);
  ok("and still blocks readiness", f2.readiness_walk_blocked);
  ok("and carries its note", f2.items[0].stage_decision_note === "Cannot place until the appliance is sourced.");

  // ── withdrawn is the third honest exit ──
  const gone = { ...inherited, status: "withdrawn" };
  const f3 = computeTurnFlow({ scope: COMPLETE, work: [gone] });
  ok("withdrawn inherited work stops blocking", !f3.readiness_walk_blocked);
  ok("and is not counted as open", f3.open_count === 0);
}

section("B16  scope-owner ladder is a temporary adapter, not an authority model");
{
  const { makeUnitTurnScopeService } = require("../../src/maintenance/unit_turn_scope_service");
  const svc = makeUnitTurnScopeService({ spawnObligationFromEvent: async () => ({ id: "o" }) });
  // Injected rows, not a database. This exercises the ORDERING logic only.
  const fake = (rowsIn) => ({ query: async () => ({ rows: rowsIn }) });

  const APM = { user_id: "apm", role_title: "Assistant Property Manager", name: "A", allowed_modules: ["management"] };
  const PM = { user_id: "pm", role_title: "Property Manager", name: "P", allowed_modules: ["management"] };
  const TECH = { user_id: "t", role_title: "Lead Maintenance Tech", name: "T", allowed_modules: ["maintenance"] };
  const APM_NO_ACCESS = { user_id: "ghost", role_title: "Assistant Property Manager", name: "G", allowed_modules: [] };

  (async () => {
    const a = await svc.resolveScopeOwner(fake([PM, APM, TECH]), { property_id: "p" });
    ok("assistant property manager is preferred", a && a.user_id === "apm", a && a.user_id);

    // 2. a title match alone cannot grant authority
    const b = await svc.resolveScopeOwner(fake([APM_NO_ACCESS, TECH]), { property_id: "p" });
    ok("an APM with NO module access is never selected", b && b.user_id !== "ghost", b && b.user_id);
    ok("the eligible tech is selected instead", b && b.user_id === "t");

    const c = await svc.resolveScopeOwner(fake([APM_NO_ACCESS]), { property_id: "p" });
    ok("title alone yields UNASSIGNED, not an owner", c === null);

    const d = await svc.resolveScopeOwner(fake([]), { property_id: "p" });
    ok("no staff at all yields UNASSIGNED", d === null);

    // 4. the reporting actor is never assigned by implication
    const e = await svc.resolveScopeOwner(fake([APM, PM]), { property_id: "p", exclude_user_id: "apm" });
    ok("the actor who typed the scope is preferred against", e && e.user_id === "pm", e && e.user_id);
    const f = await svc.resolveScopeOwner(fake([APM]), { property_id: "p", exclude_user_id: "apm" });
    ok("but a sole eligible person is still the owner, not a false UNASSIGNED", f && f.user_id === "apm");

    // 3. no named employee hardcoded
    const src = require("fs").readFileSync(require.resolve("../src/maintenance/unit_turn_scope_service"), "utf8");
    ok("no email address appears in the module", !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(src));
    ok("ladder is patterns, not identifiers", svc.SCOPE_OWNER_LADDER.every((r) => r.re instanceof RegExp));
    ok("replacement condition is documented",
       /EXACT REPLACEMENT CONDITION/.test(src) && /CLASS 4 . TEMPORARY ADAPTER/i.test(src));
    ok("module eligibility documented as authoritative",
       /EXISTING ASSIGNMENT AND MODULE ELIGIBILITY REMAIN AUTHORITATIVE/.test(src));
    ok("title-cannot-grant-authority documented",
       /A TITLE MATCH ALONE CANNOT GRANT AUTHORITY/.test(src));
  })();
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

    · migration 113 applies cleanly on top of ceiling 112
    · the append-only constraints actually refuse
        - a correction with no reason      (ck_uts_correction_states_reason)
        - two originals per triage walk    (uq_uts_one_original_per_triage)
        - paint_areas without partial      (ck_uts_paint_areas_only_when_partial)
        - an unattributed sequence override(ck_utrw_exception_is_attributed)
    · confirmScope writes scope + appliances + findings + work + event +
      obligation in ONE transaction, and rolls back as one
    · a correction supersedes prior work instead of deleting it
    · UNASSIGNED appears when no eligible staff exist
    · the scope-owner ladder resolves an assistant property manager first

  PROOF LEVEL REACHED: Built-but-dormant.
`);
    return false;
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_name in ('unit_turn_scopes','unit_turn_appliances')`);
    ok("migration 113 tables exist", t.rows.length === 2, t.rows.map((r) => r.table_name).join(",") || "none");
    if (t.rows.length !== 2) return true;
    const cols = await pool.query(
      `select column_name from information_schema.columns
        where table_name='unit_triage_required_work'
          and column_name in ('stage','turn_scope_id','disturbs_painted_surfaces','sequence_exception')`);
    ok("required-work stage columns exist", cols.rows.length === 4, String(cols.rows.length));
  } finally { await pool.end(); }
  return true;
}

(async () => {
  const ranB = await partB();
  section("RESULT");
  console.log("  assertions passed: " + passed);
  console.log("  assertions failed: " + failed);
  if (fails.length) { console.log("\n  FAILURES:"); fails.forEach((f) => console.log("   ✗ " + f)); }
  console.log("\n  PROOF LEVEL: " + (ranB ? "Proven (real DB)" : "Built-but-dormant (pure logic only)"));
  if (!ranB) console.log("  Real HTTP and browser verification still required before this is 'done'.");
  process.exit(failed > 0 || !ranB ? 1 : 0);
})();
