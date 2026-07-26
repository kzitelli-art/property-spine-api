// ════════════════════════════════════════════════════════════════════
//  A STANDING IS NOT A LABEL — proof.
//
//  Fable lock 1: lifecycle stage and post-tour standing are different
//  truths. "Hot Lead" is one agent's read of one tour on one day. It must
//  be superseded by later evidence and disappear when the relationship
//  advances, closes or changes. Do not permanently brand the person.
//
//  And the owner's rule: never offer an action already taken.
//
//  Pure module. The one live query at the end checks the real record.
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const TO = require("../src/leasing/tour_outcome");

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const NOW = "2026-07-26T12:00:00Z";
const ago = (d) => new Date(new Date(NOW).getTime() - d * 86400000).toISOString();

(async () => {
  console.log("A STANDING IS NOT A LABEL\n");

  // ── [1] it never appears bare ─────────────────────────────────────
  console.log("[1] a standing is never shown without its source");
  const fresh = TO.resolveStandingDisplay({
    standing: TO.STANDING.HOT_LEAD, standingAt: NOW,
    standingStage: "tour_followup", currentStage: "tour_followup", now: NOW });
  check(fresh.show === true, "a fresh read is shown");
  check(!!fresh.qualifier, "and it always carries a qualifier",
        `"${fresh.label} · ${fresh.qualifier}"`);
  check(/today/.test(fresh.qualifier), "which dates it");

  const old = TO.resolveStandingDisplay({
    standing: TO.STANDING.HOT_LEAD, standingAt: ago(30),
    standingStage: "tour_followup", currentStage: "tour_followup", now: NOW });
  check(/30 days ago/.test(old.qualifier || ""),
        "a month-old read is dated, not presented as current",
        `"${old.label} · ${old.qualifier}"`);

  // ── [2] it goes quiet when the relationship moves ─────────────────
  console.log("\n[2] it disappears when the relationship moves past it");
  const advanced = TO.resolveStandingDisplay({
    standing: TO.STANDING.READY_TO_APPLY, standingAt: ago(9),
    standingStage: "tour_followup", currentStage: "applicant_followup", now: NOW });
  check(advanced.show === false,
        "'Ready to Apply' vanishes once they have applied", advanced.reason);

  const closed = TO.resolveStandingDisplay({
    standing: TO.STANDING.HOT_LEAD, standingAt: ago(2),
    relationshipClosed: true, now: NOW });
  check(closed.show === false, "a closed relationship shows no live read", closed.reason);

  const superseded = TO.resolveStandingDisplay({
    standing: TO.STANDING.POSSIBLE, standingAt: ago(9),
    laterStandingAt: ago(1),
    standingStage: "tour_followup", currentStage: "tour_followup", now: NOW });
  check(superseded.show === false, "an older tour's read is superseded by a newer one",
        superseded.reason);

  // ── [3] never offer an action already taken ───────────────────────
  console.log("\n[3] the choices change with where they already are");
  const atTour = TO.standingOptionsForStage("tour_followup");
  const atApplicant = TO.standingOptionsForStage("applicant_followup");
  const atSigning = TO.standingOptionsForStage("lease_signature_followup");

  console.table([
    { stage: "tour_followup",            options: atTour.map(o => o.label).join(" · ") },
    { stage: "applicant_followup",       options: atApplicant.map(o => o.label).join(" · ") },
    { stage: "lease_signature_followup", options: atSigning.map(o => o.label).join(" · ") },
  ]);

  check(atTour.some(o => o.label === "Ready to Apply"),
        "before applying: 'Ready to Apply' is offered");
  check(!atApplicant.some(o => o.label === "Ready to Apply"),
        "AFTER applying: 'Ready to Apply' is gone",
        "a rushed tap would have recorded a next move already done");
  check(atApplicant.some(o => o.label === "Ready to Sign"),
        "and the same key is relabelled to the real next step", "Ready to Sign");
  check(!atSigning.some(o => o.key === TO.STANDING.READY_TO_APPLY),
        "mid-signature it is withdrawn entirely, not relabelled into nonsense");

  // ── [4] ONE vocabulary, not two lifecycles ────────────────────────
  console.log("\n[4] one vocabulary — the keys never change");
  const keysEverywhere = new Set([...atTour, ...atApplicant, ...atSigning].map(o => o.key));
  check([...keysEverywhere].every(k => TO.STANDING_VALUES.includes(k)),
        "every option at every stage is one of the four standings",
        "labels adapt; the vocabulary does not fork");
  check(TO.standingOptionsForStage("something_unmapped").length === TO.STANDING_VALUES.length,
        "an unknown stage gets the default set, not invented labels");

  // ── [5] the real record ───────────────────────────────────────────
  console.log("\n[5] against the live relationship");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const c = (await pool.query(
      `select current_stage, tour_outcome, status, updated_at
         from leasing_conversions where person_id=$1 and status='active' limit 1`,
      ["ede3fe95-457f-4100-a505-d8fae6390013"])).rows[0];
    console.table([c]);
    const disp = TO.resolveStandingDisplay({
      standing: c && c.tour_outcome, standingAt: c && c.updated_at,
      standingStage: "tour_followup", currentStage: c && c.current_stage });
    console.log(`     display: ${disp.show ? `"${disp.label} · ${disp.qualifier}"` : `hidden — ${disp.reason}`}`);
    check(c && c.current_stage === "applicant_followup",
          "the repaired stage held", c && c.current_stage);
    check(disp.show === false,
          "and their 'ready_to_apply' read is correctly hidden",
          "they already applied — showing it would imply work that is done");
  } finally { await pool.end(); }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exitCode = 1; });
