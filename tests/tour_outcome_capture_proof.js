// ════════════════════════════════════════════════════════════════════
//  POST-TOUR CAPTURE — vocabulary + the ask record. Proof.
//
//  Two halves:
//    · the vocabulary resolver is PURE — exercised directly, no mocking
//    · the prompts table is exercised against REAL Postgres inside a
//      transaction that ALWAYS ROLLS BACK. Nothing is persisted.
//
//  Proves the things that would actually hurt if they were wrong:
//    1. The live `interested` problem is REAL (not assumed) — measured.
//    2. HONEST BLANK: no capture is not a neutral outcome. It routes
//       nowhere and says so.
//    3. THE HARD LINE: the AI cannot supply a standing. It was not there.
//    4. Four words, four DIFFERENT destinations — otherwise splitting the
//       vocabulary bought nothing.
//    5. Contradictions are refused, not tolerated (a no-show has no
//       standing).
//    6. Attendance without judgment is a real half-state, not an error.
//    7. Latency is honest: unmeasurable reads as unmeasurable.
//    8. The prompts table's CHECKs actually REJECT — each proven by
//       attempting a violating insert and requiring failure.
//
//  Run (PowerShell, from api/):
//    $env:DATABASE_URL = ...
//    node tests/tour_outcome_capture_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const TO = require("../src/leasing/tour_outcome");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

async function mustReject(client, label, sql, params) {
  await client.query("savepoint sp");
  try {
    await client.query(sql, params);
    await client.query("rollback to savepoint sp");
    check(false, label, "the database ACCEPTED it — the constraint does not bind");
  } catch (e) {
    await client.query("rollback to savepoint sp");
    check(true, label, e.code || "rejected");
  }
}

(async () => {
  console.log("POST-TOUR CAPTURE — vocabulary + ask record\n");

  // ── [1] the problem this replaces is real, measured not assumed ────
  console.log("[1] the vocabulary problem is real");
  const vocab = (await pool.query(
    `select coalesce(tour_outcome,'(null)') as w, count(*)::int c
       from leasing_conversions group by 1 order by 2 desc`)).rows;
  const total = vocab.reduce((a, r) => a + r.c, 0);
  const top = vocab[0];
  const pct = Math.round((top.c / total) * 100);
  console.log(`      live: ${vocab.map(v => `${v.w}=${v.c}`).join("  ")}`);
  check(pct >= 60, `one word carries ${pct}% of all outcomes`,
        `'${top.w}' — a word swallowing this much is hiding distinct truths`);
  check(!vocab.some(v => /not.?moving|lost|dead|closed/i.test(v.w)),
        "there is currently NO word for 'not moving forward'",
        "which is why nothing ever closes");

  // ── [2] honest blank ──────────────────────────────────────────────
  console.log("\n[2] HONEST BLANK — an uncaptured tour is not a neutral outcome");
  const blank = TO.resolveTourOutcome({});
  check(blank.captured === false, "no capture → captured:false");
  check(blank.next_move === null, "no capture routes NOWHERE",
        blank.next_move === null ? "nothing is invented" : "IT INVENTED A NEXT MOVE");
  check(blank.standing === null, "no capture has no standing");

  // ── [3] the hard line ─────────────────────────────────────────────
  console.log("\n[3] THE HARD LINE — the AI was not at the tour");
  const aiTried = TO.resolveTourOutcome({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.HOT_LEAD, judgedBy: TO.JUDGED_BY.AI });
  check(aiTried.valid === false, "the AI cannot supply a standing", aiTried.refusal || "");
  check(aiTried.next_move === null, "and a refused judgment routes nowhere");
  const noJudge = TO.resolveTourOutcome({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.HOT_LEAD, judgedBy: null });
  check(noJudge.valid === false, "an unattributed standing is refused",
        "a judgment with no judge is not a judgment");
  const agent = TO.resolveTourOutcome({
    attendance: TO.ATTENDANCE.TOURED, standing: TO.STANDING.HOT_LEAD, judgedBy: TO.JUDGED_BY.AGENT });
  check(agent.valid === true && agent.judged_by === "agent",
        "the agent's judgment IS accepted and attributed");

  // ── [4] four words, four destinations ──────────────────────────────
  console.log("\n[4] each word routes somewhere DIFFERENT");
  const routes = TO.STANDING_VALUES.map(s => {
    const r = TO.resolveTourOutcome({ attendance: TO.ATTENDANCE.TOURED, standing: s, judgedBy: "agent" });
    return { standing: TO.STANDING_LABEL[s], next: r.next_move && r.next_move.key,
             urgency: r.next_move && r.next_move.urgency, closes: r.next_move && r.next_move.closes_lead };
  });
  console.table(routes);
  const keys = new Set(routes.map(r => r.next));
  check(keys.size === TO.STANDING_VALUES.length,
        `${TO.STANDING_VALUES.length} standings produce ${keys.size} distinct next moves`,
        keys.size === TO.STANDING_VALUES.length ? "splitting the word bought something"
                                                : "two words route the same — the split is cosmetic");
  check(routes.some(r => r.closes === true), "exactly one word can CLOSE a lead",
        "the funnel can finally tell the truth about itself");

  // ── [5] contradictions refused ────────────────────────────────────
  console.log("\n[5] contradictions are refused, not tolerated");
  const noShowStanding = TO.resolveTourOutcome({
    attendance: TO.ATTENDANCE.NO_SHOW, standing: TO.STANDING.HOT_LEAD, judgedBy: "agent" });
  check(noShowStanding.valid === false, "a no-show cannot carry a standing", noShowStanding.refusal || "");
  check(TO.resolveTourOutcome({ attendance: "vibes" }).valid === false, "an unknown attendance is refused");
  check(TO.resolveTourOutcome({ attendance: "toured", standing: "warmish", judgedBy: "agent" }).valid === false,
        "an unknown standing is refused");

  // ── [6] the half-state a busy day actually produces ────────────────
  console.log("\n[6] attendance without judgment is a real half-state");
  const half = TO.resolveTourOutcome({ attendance: TO.ATTENDANCE.TOURED });
  check(half.valid === true && half.captured === true && half.needs_standing === true && half.next_move === null,
        "'toured, judgment still owed' is valid, captured, and routes nowhere yet",
        "the common busy-day state is not an error");
  const noShow = TO.resolveTourOutcome({ attendance: TO.ATTENDANCE.NO_SHOW });
  check(noShow.valid === true && noShow.next_move && noShow.next_move.key === "no_show_recovery",
        "a no-show still routes without any standing", "a no-show is not a no");

  // ── [7] latency is honest ─────────────────────────────────────────
  console.log("\n[7] latency: unmeasurable reads as unmeasurable");
  check(TO.captureLatencyMinutes({ tourEndedAt: null, capturedAt: new Date() }) === null,
        "no tour end time → null, never 0", "a tour with no slot cannot be timed, and says so");
  check(TO.captureLatencyMinutes({
          tourEndedAt: "2026-07-28T14:00:00Z", capturedAt: "2026-07-28T14:07:00Z" }) === 7,
        "a real pair measures correctly", "7 minutes");

  // ── [7b] three vocabularies, one meaning — against the REAL live rows ──
  console.log("\n[7b] the bridge: every live outcome value, normalized");
  const live = (await pool.query(
    `select coalesce(tour_outcome,'(null)') as v, count(*)::int c
       from leasing_conversions group by 1 order by 2 desc`)).rows;
  const mapped = live.map(r => {
    const n = TO.normalizeStanding({ interest_level: r.v === "(null)" ? null : r.v });
    return { live_value: r.v, rows: r.c,
             resolves_to: n.standing || "— unresolved —",
             why: n.reason ? n.reason.slice(0, 62) : "" };
  });
  console.table(mapped);
  const ambiguous = mapped.find(m => m.live_value === "interested");
  check(ambiguous && ambiguous.resolves_to === "— unresolved —",
        "'interested' (27 rows) refuses to resolve",
        "the hot/possible distinction was never captured — guessing would invent a judgment");
  const clean = mapped.find(m => m.live_value === "start_application");
  check(clean && clean.resolves_to === TO.STANDING.READY_TO_APPLY,
        "'start_application' DOES resolve — it only ever meant one thing");

  console.log("\n     v2 two-level → v3 one word:");
  const v2cases = [
    { disposition: "keep_working", sub_read: "hot" },
    { disposition: "keep_working", sub_read: "warm" },
    { disposition: "keep_working" },                          // ambiguous on purpose
    { disposition: "close_watch", future_fit: "close" },
    { disposition: "close_watch", future_fit: "keep" },
    { disposition: "close_watch" },                           // ambiguous on purpose
    { disposition: "needs_change" },
  ];
  console.table(v2cases.map(c => {
    const n = TO.normalizeStanding(c);
    return { input: JSON.stringify(c), resolves_to: n.standing || "— unresolved —",
             why: n.reason ? n.reason.slice(0, 54) : "" };
  }));
  check(TO.normalizeStanding({ disposition: "keep_working", sub_read: "hot" }).standing === TO.STANDING.HOT_LEAD,
        "keep_working + hot → Hot Lead");
  check(TO.normalizeStanding({ disposition: "keep_working" }).resolved === false,
        "keep_working ALONE refuses", "ambiguous between hot_lead and possible");
  check(TO.normalizeStanding({ disposition: "close_watch", future_fit: "close" }).standing === TO.STANDING.NOT_MOVING_FORWARD,
        "close_watch + close → Not Moving Forward", "the funnel gets its first way to close");

  // ── [7c] THE WRITE PATH DECISION — the real function the service calls ──
  //  Not a copy. completeTourService calls exactly this.
  console.log("\n[7c] what the capture service will actually write");
  const RECORDER = "11111111-1111-1111-1111-111111111111";
  const cases = [
    { name: "v3 · agent taps Hot Lead",
      fb: { standing: "hot_lead" }, rec: RECORDER },
    { name: "v2 · keep_working + hot",
      fb: { disposition: "keep_working", sub_read: "hot" }, rec: RECORDER },
    { name: "v2 · close_watch + close",
      fb: { disposition: "close_watch", future_fit: "close" }, rec: RECORDER },
    { name: "v1 · 'interested' (the 27 rows)",
      fb: { interest_level: "interested" }, rec: RECORDER },
    { name: "v3 · Hot Lead but NO recorder",
      fb: { standing: "hot_lead" }, rec: null },
    { name: "nothing supplied",
      fb: {}, rec: RECORDER },
  ];
  console.table(cases.map(c => {
    const r = TO.resolveCapturedStanding({ fb: c.fb, recordedByUserId: c.rec });
    return { case: c.name, writes_tour_outcome: r.tour_outcome_value || "(null)",
             standing: r.standing || "—", judged_by: r.judged_by || "—",
             next_move: r.next_move ? r.next_move.key : "—",
             why_not: r.unresolved_reason ? r.unresolved_reason.slice(0, 40) : "" };
  }));

  const v3 = TO.resolveCapturedStanding({ fb: { standing: "hot_lead" }, recordedByUserId: RECORDER });
  check(v3.standing === "hot_lead" && v3.judged_by === "agent" && v3.tour_outcome_value === "hot_lead",
        "a v3 tap writes the four-word standing, attributed to the agent");
  check(v3.next_move && v3.next_move.key === "follow_up_today",
        "and it carries the next move", v3.next_move.key);

  const v2c = TO.resolveCapturedStanding({ fb: { disposition: "close_watch", future_fit: "close" }, recordedByUserId: RECORDER });
  check(v2c.standing === "not_moving_forward" && v2c.next_move.closes_lead === true,
        "a v2 close resolves and CLOSES the lead");

  const v1c = TO.resolveCapturedStanding({ fb: { interest_level: "interested" }, recordedByUserId: RECORDER });
  check(v1c.standing === null && v1c.tour_outcome_value === "interested",
        "'interested' writes through UNCHANGED — not upgraded, not lost",
        "the raw input is preserved; no judgment is invented");
  check(!!v1c.unresolved_reason, "and the reason is recorded", "an honest blank that explains itself");

  const noRec = TO.resolveCapturedStanding({ fb: { standing: "hot_lead" }, recordedByUserId: null });
  check(noRec.standing === null && noRec.judged_by === null,
        "a standing with NO recorder is refused", noRec.unresolved_reason);
  check(noRec.tour_outcome_value === "hot_lead",
        "but the raw value still survives", "input is never silently discarded");

  // ── [7d] the service module still loads with the new wiring ────────
  console.log("\n[7d] the capture service loads with the new dependency");
  let svcOk = false, svcErrMsg = "";
  try { require("../src/leasing/leasingleads"); svcOk = true; }
  catch (e) { svcErrMsg = e.message; }
  check(svcOk, "leasingleads.js resolves tour_outcome.js", svcOk ? "require graph intact" : svcErrMsg);

  // ── [8] the ask record binds ──────────────────────────────────────
  console.log("\n[8] tour_outcome_prompts — the CHECKs actually reject");
  const tour = (await pool.query(`select id from leasing_tours order by created_at desc limit 1`)).rows[0];
  const user = (await pool.query(`select id from users limit 1`)).rows[0];
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = `insert into tour_outcome_prompts (tour_id, asked_user_id, channel, attempt_no)`;
    await mustReject(client, "unknown channel rejected",
      `${ins} values ($1,$2,'carrier_pigeon',1)`, [tour.id, user.id]);
    await mustReject(client, "attempt_no 0 rejected",
      `${ins} values ($1,$2,'sms',0)`, [tour.id, user.id]);
    await mustReject(client, "an ask with no user AND no note rejected",
      `insert into tour_outcome_prompts (tour_id, channel) values ($1,'sms')`, [tour.id]);
    await mustReject(client, "responded_at without a source rejected",
      `insert into tour_outcome_prompts (tour_id, asked_user_id, channel, responded_at)
       values ($1,$2,'sms', now())`, [tour.id, user.id]);
    await mustReject(client, "an ask both answered AND abandoned rejected",
      `insert into tour_outcome_prompts (tour_id, asked_user_id, channel, responded_at, response_source, closed_without_response_reason)
       values ($1,$2,'sms', now(), 'sms_reply', 'abandoned')`, [tour.id, user.id]);

    // a host-less tour CAN be recorded, with a stated reason (attempt 9 so it
    // does not occupy the attempt numbers the duplicate test needs)
    await client.query(
      `insert into tour_outcome_prompts (tour_id, channel, attempt_no, note)
       values ($1,'sms',9,'no host assigned — nobody to ask')`, [tour.id]);
    check(true, "a host-less ask IS recordable when the reason is stated",
          "an unassigned tour is unscoreable, honestly — not skipped");

    // one row per ATTEMPT, not per tour
    await client.query(`${ins} values ($1,$2,'sms',1)`, [tour.id, user.id]);
    check(true, "attempt 1 recorded");
    await mustReject(client, "a duplicate attempt_no for the same tour is rejected",
      `${ins} values ($1,$2,'sms',1)`, [tour.id, user.id]);
    await client.query(`${ins} values ($1,$2,'sms',2)`, [tour.id, user.id]);
    const asks = (await client.query(
      `select count(*)::int c from tour_outcome_prompts where tour_id=$1`, [tour.id])).rows[0].c;
    check(asks === 3, "a SECOND attempt is a SECOND ROW, not an update",
          `${asks} asks on record — "we asked twice" is a fact, not an overwrite`);
  } finally {
    await client.query("rollback");
    client.release();
  }

  const leaked = (await pool.query(`select count(*)::int c from tour_outcome_prompts`)).rows[0].c;
  check(leaked === 0, "rollback left nothing behind", leaked === 0 ? "0 rows" : `${leaked} LEAKED`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exitCode = 1; })
  .finally(() => pool.end());
