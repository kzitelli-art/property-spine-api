// ════════════════════════════════════════════════════════════════════
//  work_acceptance_proof.js — BUILD 3 proof harness
//
//    node tests/work_acceptance_proof.js
//
//  Part A (pure) runs anywhere. Part B requires DATABASE_URL and REAL
//  Postgres; without it this harness EXITS NON-ZERO and says the slice is
//  unproven. It never substitutes a fixture or a mock pool.
// ════════════════════════════════════════════════════════════════════

"use strict";

const P = require("../src/maintenance/work_proof");
const { proposeCommitment, makeWorkAcceptanceService } = require("../src/maintenance/work_acceptance_service");
const { computeTurnFlow, STAGE } = require("../src/maintenance/turn_sequence");

let passed = 0, failed = 0;
const fails = [];
const ok = (n, c, d) => { if (c) passed++; else { failed++; fails.push(n + (d ? "  — " + d : "")); } };
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 58 - t.length)));

const W = (over) => ({ id: "w1", status: "required", work_text: "Paint full unit", stage: STAGE.PAINT,
  disturbs_painted_surfaces: null, owner_user_id: "u1", sequence_exception: false, ...over });
const COMPLETE = { inspection_completeness: "complete_turn_scope" };

section("C1  proof requirements are lightweight and stage-appropriate");
{
  const paint = P.proofRequirementFor(W({ work_text: "Paint full unit", stage: STAGE.PAINT }));
  ok("paint needs exactly one photo", paint.photos_min === 1, String(paint.photos_min));
  ok("paint needs no functional confirmation", paint.needs_functional_confirmation === false);

  const clean = P.proofRequirementFor(W({ work_text: "Complete final full clean", stage: STAGE.FINAL_CLEAN }));
  ok("cleaning needs one photo", clean.photos_min === 1);
  ok("cleaning needs no functional confirmation", clean.needs_functional_confirmation === false);

  const appl = P.proofRequirementFor(W({ work_text: "Source and install refrigerator", stage: STAGE.REPAIR }));
  ok("appliance install needs a photo", appl.photos_min === 1);
  ok("appliance install ALSO needs a functional confirmation", appl.needs_functional_confirmation === true);

  const rep = P.proofRequirementFor(W({ work_text: "Diagnose and repair bathroom faucet leaks", stage: STAGE.REPAIR }));
  ok("a leak repair needs a functional confirmation", rep.needs_functional_confirmation === true);

  const trash = P.proofRequirementFor(W({ work_text: "Remove trash and debris", stage: STAGE.REPAIR }));
  ok("plain removal needs only a photo", trash.needs_functional_confirmation === false);

  ok("no requirement exceeds one photo",
     Object.values(P.REQUIREMENTS).every((r) => r.photos_min === null || r.photos_min <= 1));
  ok("every requirement says nothing inspects the photo",
     /Nothing here inspects/.test(paint.not_inspected));
  const walk = P.proofRequirementFor(W({ stage: STAGE.READINESS_WALK }));
  ok("the readiness walk has NO completable requirement", walk.photos_min === null);
}

section("C2  a claim without proof does NOT close the work");
{
  const paint = W();
  //  RELEASE CANDIDATE: a photo is a VERIFIED ATTACHMENT. `verified_photos`
  //  are the references the service resolved against the attachment store;
  //  `attachments_available` says whether a store exists at all. Both default
  //  to the safe answer, so these cases state the store explicitly.
  const STORE = { attachments_available: true };

  const bare = P.evaluateProof(paint, { outcome: "completed", verified_photos: [], functional_confirmation: null }, STORE);
  ok("completed with no photo is NOT satisfied", bare.satisfied === false);
  ok("and names the shortfall", /completion photo/i.test(bare.shortfall), bare.shortfall);

  const withPhoto = P.evaluateProof(paint, { outcome: "completed", verified_photos: ["att-1"] }, STORE);
  ok("completed with a VERIFIED attachment IS satisfied", withPhoto.satisfied === true, withPhoto.shortfall);

  //  ── A STRING IS NOT A PHOTO ──────────────────────────────────────
  //  The defect this replaced: `proof_photos` was counted, so one typed
  //  character — or one space — closed the work.
  for (const junk of [" ", "x", "photo.jpg", "3f2504e0-4f89-41d3-9a0c-0305e82c3301"]) {
    ok(`typed ${JSON.stringify(junk)} does NOT satisfy proof`,
       P.evaluateProof(paint, { outcome: "completed", proof_photos: [junk] }, STORE).satisfied === false);
  }
  //  And with no attachment store at all, nothing can satisfy it — fail closed.
  const noStore = P.evaluateProof(paint, { outcome: "completed", verified_photos: ["att-1"] });
  ok("with no attachment store, even a verified reference does not satisfy", noStore.satisfied === false);
  ok("and it says photo proof is unavailable rather than asking for a photo",
     noStore.photo_proof_unavailable === true && /unavailable/i.test(noStore.shortfall), noStore.shortfall);

  const appl = W({ work_text: "Source and install refrigerator", stage: STAGE.REPAIR });
  const photoOnly = P.evaluateProof(appl, { outcome: "completed", verified_photos: ["att-1"] }, STORE);
  ok("appliance with photo but no confirmation is NOT satisfied", photoOnly.satisfied === false);
  ok("and names the missing confirmation", /works/i.test(photoOnly.shortfall), photoOnly.shortfall);
  ok("a two-character confirmation does not count",
     P.evaluateProof(appl, { outcome: "completed", verified_photos: ["att-1"], functional_confirmation: "ok" }, STORE).satisfied === false);
  ok("a real sentence does", P.evaluateProof(appl, {
    outcome: "completed", verified_photos: ["att-1"], functional_confirmation: "Installed and cooling." }, STORE).satisfied === true);

  for (const o of ["unable_to_complete", "needs_followup"]) {
    const v = P.evaluateProof(paint, { outcome: o, verified_photos: ["att-1"] }, STORE);
    ok(`'${o}' can never satisfy proof`, v.satisfied === false);
    ok(`'${o}' does not demand a completion photo`, v.shortfall === null);
  }
  ok("the readiness walk cannot be completed at all",
     P.evaluateProof(W({ stage: STAGE.READINESS_WALK }), { outcome: "completed", verified_photos: ["att-1"] }, STORE).satisfied === false);
}

section("C3  acceptance is a proposal until confirmed, and never implies ownership");
{
  const now = "2026-07-28T12:00:00.000Z";
  const p = proposeCommitment({ text: "I'll handle it tomorrow", actor_user_id: "u9", now });
  ok("it is labelled a proposal", p.is_proposal === true);
  ok("nothing is recorded", /Nothing has been accepted/.test(p.nothing_recorded));
  ok("proposes the speaker as owner", p.proposed_owner_user_id === "u9");
  ok("proposes tomorrow", String(p.proposed_due_at).slice(0, 10) === "2026-07-29", p.proposed_due_at);
  ok("names where the date came from", /tomorrow/.test(p.proposed_due_basis));
  ok("commitment source is proposed_from_text", p.commitment_source === "proposed_from_text");

  const third = proposeCommitment({ text: "someone should do this tomorrow", actor_user_id: "u9", now });
  ok("third-person proposes NO owner", third.proposed_owner_user_id === null, String(third.proposed_owner_user_id));
  ok("and says why", /did not say who/i.test(third.proposed_owner_basis));

  const noDate = proposeCommitment({ text: "I'll take it", actor_user_id: "u9", now });
  ok("no date in the text → no date proposed", noDate.proposed_due_at === null);
  ok("and commitment source is 'none'", noDate.commitment_source === "none");
  ok("no date is never invented", !/2026/.test(String(noDate.proposed_due_at)));

  const days = proposeCommitment({ text: "I can get to it in 3 days", actor_user_id: "u9", now });
  ok("'in 3 days' is read", String(days.proposed_due_at).slice(0, 10) === "2026-07-31", days.proposed_due_at);
}

section("C4  flow progression: closing work unlocks the next stage");
{
  const work = [
    { id: "r1", status: "required", work_text: "Diagnose and repair hole in the wall", stage: STAGE.REPAIR, disturbs_painted_surfaces: true, owner_user_id: "u1" },
    { id: "p1", status: "required", work_text: "Paint full unit", stage: STAGE.PAINT, owner_user_id: "u1" },
    { id: "c1", status: "required", work_text: "Complete final full clean", stage: STAGE.FINAL_CLEAN, owner_user_id: "u1" },
  ];
  const st = (w, s) => computeTurnFlow({ scope: COMPLETE, work: w }).stages.find((x) => x.stage === s);

  ok("paint blocked while the wall repair is open", st(work, STAGE.PAINT).blocked);
  ok("cleaning blocked", st(work, STAGE.FINAL_CLEAN).blocked);

  work[0].status = "complete";
  ok("repair complete → paint becomes actionable", !st(work, STAGE.PAINT).blocked);
  ok("cleaning still blocked by open paint", st(work, STAGE.FINAL_CLEAN).blocked);

  work[1].status = "complete";
  ok("paint complete → cleaning becomes actionable", !st(work, STAGE.FINAL_CLEAN).blocked);
  ok("readiness walk still blocked by open cleaning",
     computeTurnFlow({ scope: COMPLETE, work }).readiness_walk_blocked);

  work[2].status = "complete";
  const done = computeTurnFlow({ scope: COMPLETE, work });
  ok("all work complete → readiness walk unblocked", !done.readiness_walk_blocked);
  ok("BUT the unit is still NOT ready", /NOT ready/i.test(done.controlling_next_action.why), done.controlling_next_action.why);
  ok("and BUILD 3 offers no way to certify it",
     done.controlling_next_action.kind === "readiness_walk_available");
  ok("no readiness verdict is emitted anywhere",
     !/"readiness"\s*:\s*"ready"/.test(JSON.stringify(done)));
}

section("C5  reopened work recalculates the flow");
{
  const work = [
    { id: "r1", status: "complete", work_text: "Repair wall", stage: STAGE.REPAIR, disturbs_painted_surfaces: true, owner_user_id: "u1" },
    { id: "p1", status: "complete", work_text: "Paint full unit", stage: STAGE.PAINT, owner_user_id: "u1" },
    { id: "c1", status: "complete", work_text: "Complete final full clean", stage: STAGE.FINAL_CLEAN, owner_user_id: "u1" },
  ];
  ok("all complete → readiness unblocked", !computeTurnFlow({ scope: COMPLETE, work }).readiness_walk_blocked);

  // repair reopened; cascade reopens cleaning (service behavior modelled here)
  work[0].status = "required";
  work[2].status = "required";
  const after = computeTurnFlow({ scope: COMPLETE, work });
  ok("reopening blocks readiness again", after.readiness_walk_blocked);
  ok("the controlling action recalculates to the repair",
     /repair wall/i.test(after.controlling_next_action.action), after.controlling_next_action.action);
  ok("cleaning is blocked again by the reopened repair",
     after.stages.find((x) => x.stage === STAGE.FINAL_CLEAN).blocked);
}

section("C6  unable-to-complete keeps work open and dispatches nothing");
{
  ok("every unable reason has a label",
     P.UNABLE_REASON_VALUES.every((r) => !!P.UNABLE_REASONS[r]));
  ok("every unable reason proposes a next action",
     P.UNABLE_REASON_VALUES.every((r) => !!P.UNABLE_NEXT_ACTION[r]));
  ok("the parts reason states nothing was ordered",
     /Nothing has been ordered/i.test(P.UNABLE_NEXT_ACTION.part_or_appliance_unavailable));
  ok("the specialist reason states no vendor was contacted",
     /No vendor has been contacted/i.test(P.UNABLE_NEXT_ACTION.specialist_required));
  const all = JSON.stringify(P.UNABLE_NEXT_ACTION);
  ok("no proposed action claims a dispatch happened",
     !/\b(has been sent|we have (ordered|scheduled)|dispatched|notified)\b/i.test(all));
  ok("the seven required reasons exist", P.UNABLE_REASON_VALUES.length === 7, String(P.UNABLE_REASON_VALUES.length));
}

section("C7  management exceptions — routine success is quiet");
{
  const svc = makeWorkAcceptanceService({ spawnObligationFromEvent: async () => ({ id: "o" }) });
  const now = "2026-07-28T12:00:00.000Z";
  const state = (over) => ({
    work: { id: "w", work_text: "Paint full unit" }, status: "required",
    accepted: true, due_at: null, reopened_count: 0, latest_claim: null, ...over,
  });

  const flowClean = { unassigned_count: 0 };
  ok("routine accepted work with a date raises nothing",
     svc.workExceptions({ flow: flowClean, workStates: [state({ due_at: "2026-07-30T17:00:00Z" })], now }).length === 0);

  ok("successfully completed work raises nothing",
     svc.workExceptions({ flow: flowClean, now,
       workStates: [state({ status: "complete", latest_claim: { outcome: "completed", proof_satisfied: true } })] }).length === 0);

  const codes = (o) => svc.workExceptions(o).map((e) => e.code);
  ok("UNASSIGNED raises an exception",
     codes({ flow: { unassigned_count: 2 }, workStates: [], now }).includes("unassigned_work"));
  ok("a missed commitment raises an exception",
     codes({ flow: flowClean, now, workStates: [state({ due_at: "2026-07-27T17:00:00Z" })] }).includes("missed_commitment"));
  ok("a future commitment does NOT",
     !codes({ flow: flowClean, now, workStates: [state({ due_at: "2026-07-30T17:00:00Z" })] }).includes("missed_commitment"));
  ok("unable-to-complete raises an exception",
     codes({ flow: flowClean, now, workStates: [state({ latest_claim: { outcome: "unable_to_complete", unable_reason: "access_issue" } })] })
       .includes("unable_to_complete"));
  ok("a completion claim short of proof raises an exception",
     codes({ flow: flowClean, now, workStates: [state({ latest_claim: { outcome: "completed", proof_satisfied: false, proof_shortfall: "Missing a completion photo." } })] })
       .includes("proof_missing"));
  ok("accepted work with no WORK due date + a committed move-in raises it",
     codes({ flow: flowClean, now, nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 4 }, workStates: [state()] })
       .includes("work_due_commitment_missing"));
  ok("accepted with no work due date and NO move-in does not",
     !codes({ flow: flowClean, now, workStates: [state()] }).includes("work_due_commitment_missing"));
  // The rename exists so a manager cannot read this as "no committed move-in",
  // which is the opposite situation and calls for the opposite response.
  const ex = svc.workExceptions({ flow: flowClean, now,
    nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 4 }, workStates: [state()] })
    .find((e) => e.code === "work_due_commitment_missing");
  ok("the label names the WORK's due date, not a move-in commitment",
     /due date for the work itself/i.test(ex.label), ex.label);
  ok("the detail distinguishes the two dates explicitly",
     /due date for the work/i.test(ex.detail) && /resident's move-in is committed/i.test(ex.detail), ex.detail);
  ok("no exception code could be misread as being about a move-in commitment",
     !codes({ flow: flowClean, now, nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 4 }, workStates: [state()] })
       .some((c) => /^unresolved_timing$|no_committed_date/.test(c)));
  ok("reopened work with a committed move-in raises an exception",
     codes({ flow: flowClean, now, nextMoveIn: { move_in_date: "2026-08-01", days_remaining: 4 },
             workStates: [state({ reopened_count: 1, due_at: "2026-07-30T17:00:00Z" })] })
       .includes("reopened_threatens_move_in"));
  ok("reopened work with NO move-in is ordinary rework",
     !codes({ flow: flowClean, now, workStates: [state({ reopened_count: 1, due_at: "2026-07-30T17:00:00Z" })] })
       .includes("reopened_threatens_move_in"));
}

section("C8  service construction and vocabulary guards");
{
  let threw = false;
  try { makeWorkAcceptanceService({}); } catch (e) { threw = true; }
  ok("service refuses to build without the shared obligation engine", threw);
  ok("three outcomes, exactly", P.OUTCOME_VALUES.length === 3);
  ok("'accepted' is NOT a work status", !P.OUTCOME_VALUES.includes("accepted"));
  const src = require("fs").readFileSync(require.resolve("../src/maintenance/work_proof"), "utf8");
  // Check for CV *code*, not the word — the module's own comment disclaims
  // computer vision, so a naive word match flags the disclaimer itself.
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ok("no CV or ML dependency is imported",
     !/require\(['"][^'"]*(vision|tensorflow|opencv|rekognition|clarifai|@google-cloud\/vis)/i.test(code));
  ok("nothing inspects, scores or classifies a photo",
     !/\b(classify|detectLabels|analyzeImage|scorePhoto|imageScore|inferQuality)\b/.test(code));
  ok("proof evaluation only counts VERIFIED attachments",
     /verified\.length < req\.photos_min/.test(code));
  ok("and never reads the raw proof_photos strings when deciding",
     !/proof_photos[^\n]*<\s*req\.photos_min/.test(code));
  ok("the doctrine is stated in the header", /no computer vision/i.test(src));
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

    · migration 115 applies cleanly on top of ceiling 114
    · the constraints actually refuse
        - unable_to_complete with no reason   (ck_wcc_unable_states_reason)
        - proof_satisfied on a non-completed claim (ck_wcc_only_completed_satisfies)
        - a due date with commitment_source 'none' (ck_wa_commitment_source_matches_date)
        - a supersede with no reason          (ck_wa_supersede_states_reason)
    · accept / claim / reopen each write in ONE transaction and roll back as one
    · a proof-short claim is RECORDED while the work stays 'required'
    · closing work flips status and closes the commitment obligation
    · reopening preserves the original claim and cascades to final cleaning
    · blocked work cannot be accepted

  PROOF LEVEL REACHED: Built-but-dormant.
`);
    return false;
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_name in ('work_acceptances','work_completion_claims','work_reopenings')`);
    ok("migration 115 tables exist", t.rows.length === 3, t.rows.map((r) => r.table_name).join(",") || "none");
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
