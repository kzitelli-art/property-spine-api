// ════════════════════════════════════════════════════════════════════
//  CAPTURE CHASE — proof.
//
//  Simulates the real scenario this exists for: prime season, one agent,
//  EIGHT tours back to back, the first one excellent. Walks the clock and
//  checks the system asks at the right moments, stops when it should, and
//  refuses rather than guesses everywhere it cannot know.
//
//  Pure module — no database, no sending. The one live query at the end
//  measures how many of the property's real tours could actually be
//  chased today, which is a finding rather than a pass/fail.
//
//  Run (PowerShell, from api/):
//    node tests/proofs/capture_chase_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const CC = require("../../src/leasing/capture_chase");
const TO = require("../../src/leasing/tour_outcome");

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

const HOST = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const END  = "2026-07-28T15:00:00Z";           // tour ends 11:00 local
const at   = (mins) => new Date(new Date(END).getTime() + mins * 60000).toISOString();

(async () => {
  console.log("CAPTURE CHASE — one agent, eight tours, the first one excellent\n");

  // ── [1] the ladder walks correctly ────────────────────────────────
  console.log("[1] the ladder: what happens as the clock moves");
  const timeline = [0, 4, 6, 30, 50, 120, 245, 400].map(m => {
    const asks = [];
    // replay: every attempt whose due time has passed, and unanswered
    for (const rung of CC.LADDER) {
      if (m >= rung.after_minutes) asks.push({ attempt_no: rung.attempt, asked_at: at(rung.after_minutes), responded_at: null });
    }
    // the decision is made BEFORE the current rung is sent, so drop the last
    const priorAsks = asks.slice(0, Math.max(0, asks.length - (m >= (CC.LADDER[asks.length - 1] || {}).after_minutes ? 1 : 0)));
    const r = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE,
      tourEndedAt: END, hostUserId: HOST, asks: priorAsks, now: at(m) });
    return { minutes_after_tour: m, asks_already_made: priorAsks.length,
             action: r.action, attempt: r.attempt_no || "—", channel: r.channel || "—" };
  });
  console.table(timeline);

  const t0 = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE, tourEndedAt: END,
                                  hostUserId: HOST, asks: [], now: at(0) });
  check(t0.action === CC.ACTION.WAIT, "at the buzzer: WAIT, not ask", "the agent is still shaking a hand");
  const t6 = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE, tourEndedAt: END,
                                  hostUserId: HOST, asks: [], now: at(6) });
  check(t6.action === CC.ACTION.ASK && t6.attempt_no === 1 && t6.channel === "sms",
        "5 minutes later: ASK by SMS", "the walk back to the lobby — freshest judgment");

  // ── [2] it stops. a prompt that repeats forever is noise ──────────
  console.log("\n[2] it stops asking");
  const allThree = CC.LADDER.map(r => ({ attempt_no: r.attempt, asked_at: at(r.after_minutes), responded_at: null }));
  const exhausted = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE, tourEndedAt: END,
                                         hostUserId: HOST, asks: allThree, now: at(600) });
  check(exhausted.action === CC.ACTION.SWEEP_ONLY,
        `after ${CC.MAX_ATTEMPTS} unanswered asks it stops texting`, exhausted.reason);
  check(CC.MAX_ATTEMPTS <= 3, "the ladder is short by design", `${CC.MAX_ATTEMPTS} rungs — noise is how a real signal gets ignored`);

  // ── [3] an answer ends it immediately ─────────────────────────────
  console.log("\n[3] an answer ends the chase");
  const answered = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE, tourEndedAt: END,
    hostUserId: HOST, asks: [{ attempt_no: 1, asked_at: at(5), responded_at: at(7) }], now: at(300) });
  check(answered.action === CC.ACTION.NONE, "one answer stops all further asks", answered.reason);

  // ── [4] it refuses rather than inventing ──────────────────────────
  console.log("\n[4] where it cannot know, it says so");
  const noSlot = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.UNTRACKABLE, tourEndedAt: null,
                                      hostUserId: HOST, asks: [], now: at(300) });
  check(noSlot.action === CC.ACTION.BLOCKED, "no slot → BLOCKED, not chased",
        "a fabricated 'tour ended at' would make every downstream minute a lie");
  const noHost = CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.OVERDUE, tourEndedAt: END,
                                      hostUserId: null, asks: [], now: at(300) });
  check(noHost.action === CC.ACTION.BLOCKED, "no host → BLOCKED, and the reason is named",
        noHost.reason);
  check(/unscoreable/.test(noHost.reason), "and it says why that matters for accountability");
  check(CC.nextChaseAction({ captureState: TO.CAPTURE_STATE.SCHEDULED, tourEndedAt: END,
                             hostUserId: HOST, asks: [], now: at(-60) }).action === CC.ACTION.NONE,
        "a future tour is not chased");

  // ── [5] the message itself ────────────────────────────────────────
  console.log("\n[5] what lands on the agent's phone");
  const txt = CC.buildPromptText({ prospectName: "Sarah Chen", unitLabel: "Unit 530", timeLabel: "10:00" });
  console.log("      ┌─────────────────────────────────────────────┐");
  txt.split("\n").forEach(l => console.log("      │ " + l.padEnd(43) + "│"));
  console.log("      └─────────────────────────────────────────────┘");
  check(/Sarah Chen/.test(txt), "the PERSON's name leads", "that is what the agent recognises, not a tour id");
  check(/1 .*2 .*3 .*4/.test(txt), "four numbered options, one thumb");
  check(!/http/i.test(txt), "no link to tap", "no app to open, no context to reload");

  // ── [6] the reply parser refuses to guess ─────────────────────────
  console.log("\n[6] reading the reply");
  const replies = ["2", " 3 ", "4.", "1)", "hot", "2 - she loved it", "", "5", "yes"];
  console.table(replies.map(r => {
    const p = CC.parsePromptReply(r);
    return { reply: JSON.stringify(r), accepted: p.ok, standing: p.standing || "—",
             why_not: p.reason ? p.reason.slice(0, 44) : "" };
  }));
  check(CC.parsePromptReply("2").standing === "hot_lead", "'2' is Hot Lead");
  check(CC.parsePromptReply(" 3 ").standing === "possible", "whitespace tolerated");
  check(CC.parsePromptReply("hot").ok === false, "'hot' is REFUSED, not interpreted",
        "a misread reply records a judgment the agent did not make");
  check(CC.parsePromptReply("2 - she loved it").ok === false,
        "a reply with commentary is refused", "ambiguous input must not become a silent judgment");
  check(CC.parsePromptReply("5").ok === false, "out of range refused");

  // every number the prompt offers must be a number the parser accepts
  const offered = (txt.match(/\b([1-4])\s/g) || []).map(s => s.trim());
  check(offered.every(n => CC.parsePromptReply(n).ok),
        "every option the prompt shows is one the parser accepts",
        "prompt and parser cannot drift — a mismatch silently records the wrong judgment");

  // ── [7] against the real board: could we chase anything today? ────
  console.log("\n[7] the real board — how many tours could actually be chased");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const rows = (await pool.query(
      `select t.id, t.leasing_agent_id, av.ends_at,
              (t.status in ('completed','no_show','cancelled','rescheduled')) as is_terminal,
              u.phone is not null and u.phone <> '' as host_has_phone
         from leasing_tours t
         left join tour_availability av on av.id = t.slot_id
         left join users u on u.id = t.leasing_agent_id
        where t.property_id = 'a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'`)).rows;
    const tally = {};
    let reachable = 0;
    for (const t of rows) {
      const cs = TO.resolveCaptureState({ isTerminal: t.is_terminal, tourEndedAt: t.ends_at, graceMinutes: 15 });
      const a = CC.nextChaseAction({ captureState: cs.state, tourEndedAt: t.ends_at,
                                     hostUserId: t.leasing_agent_id, asks: [] });
      tally[a.action] = (tally[a.action] || 0) + 1;
      if (a.action === CC.ACTION.ASK && t.host_has_phone) reachable++;
    }
    console.table(Object.entries(tally).map(([action, n]) => ({ action, tours: n })));
    console.log(`      tours we could actually TEXT about right now: ${reachable}`);
    check(true, "measured against the live board",
          `${reachable} reachable — staff phones are the binding constraint, not the logic`);
  } finally { await pool.end(); }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error("HARNESS ERROR:", e.message, e.stack); process.exitCode = 1; });
