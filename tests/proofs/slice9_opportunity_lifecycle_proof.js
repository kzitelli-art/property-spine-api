// ════════════════════════════════════════════════════════════════════
//  slice9_opportunity_lifecycle_proof.js — TERMINAL AND PENDING TRUTH.
//
//  The load-bearing claim: TWO OPPORTUNITIES SHARING ONE CONVERSATION are
//  independently classifiable. Closing one must not close the other; reopening
//  one must not reopen the other. That case was previously unrepresentable —
//  `conversations` is UNIQUE per (property_id, person_id), so one conversation
//  covers every opportunity a person ever has at a property.
//
//  And an honesty claim: a mutable status label can never override event truth,
//  and a label with no event behind it stays incomplete rather than terminal.
//
//  Real Postgres, transaction-rolled, self-contained (creates its own property).
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_opportunity_lifecycle_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const {
  opportunityLifecycleSnapshot, LIFECYCLE, PENDING,
} = require(path.join(REPO, "src/leasing/opportunity_lifecycle_read"));
const { measure, backfill } = require(path.join(REPO, "tools/lifecycle_event_attribution_backfill"));

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

(async () => {
  if (!process.env.DATABASE_URL) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const c = await pool.connect();
  const svc = require(path.join(REPO, "src/leasing/leasing_lifecycle_service"));
  try {
    await c.query("begin");
    const one = async (q, a = []) => (await c.query(q, a)).rows[0];

    // ── SELF-CONTAINED SETUP ──────────────────────────────────────────
    const P = (await one(`insert into properties (name, operating_timezone)
      values ('S9 lifecycle proof — scratch','America/New_York') returning id`)).id;
    const other = (await one(`insert into properties (name, operating_timezone)
      values ('S9 lifecycle proof — other','America/New_York') returning id`)).id;
    const person = (await one(`insert into persons (name, lifecycle_status)
      values ('Lifecycle prospect','lead') returning id`)).id;
    const host = (await one(`insert into users (email, name)
      values ('lifecycle@proof.test','Host') returning id`)).id;
    const conv = (await one(`insert into conversations (property_id, person_id, channel_primary, status)
      values ($1,$2,'sms','open') returning id`, [P, person])).id;
    const lead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
      values ($1,$2,'new',now()) returning id`, [person, P])).id;
    const unit = (await one(`insert into units (property_id, unit_number)
      values ($1,'L-1') returning id`, [P])).id;

    //  leasing_conversions_one_active permits ONE active opportunity per
    //  person+property. Cases that need another ACTIVE opportunity get their
    //  own person; the shared-conversation case deliberately does not.
    const mkPersonLead = async (name) => {
      const pid = (await one(`insert into persons (name, lifecycle_status) values ($1,'lead') returning id`, [name])).id;
      const lid = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
                              values ($1,$2,'new',now()) returning id`, [pid, P])).id;
      return { person: pid, lead: lid };
    };
    const mkOpp = async (status, stage, who = null) => {
      const w = who || { person, lead };
      return (await one(
        `insert into leasing_conversions (person_id, property_id, lead_id, status, current_stage,
           opened_at, actual_tour_host_user_id, conversation_owner_user_id)
         values ($1,$2,$3,$4,$5, now() - interval '30 days', $6,$6) returning id`,
        [w.person, P, w.lead, status, stage, host])).id;
    };

    //  TWO opportunities, ONE conversation — the case that was unrepresentable.
    const oA = await mkOpp("released", "tour_followup");
    const oB = await mkOpp("active", "touring");

    ok((await one(`select count(*)::int n from conversations where property_id=$1 and person_id=$2`, [P, person])).n === 1,
      "exactly ONE conversation exists for this person at this property");
    ok(oA !== oB, "and TWO opportunities share it");

    //  A service bound to THIS transaction, so its writes roll back with the
    //  harness. The service opens its own begin/commit/rollback; issued on a
    //  shared connection those would control the OUTER transaction, and its
    //  first controlled refusal would roll back the entire setup. So its
    //  transaction control is mapped onto SAVEPOINTS: the service's semantics
    //  are preserved exactly (its rollback still undoes its own work) without
    //  it being able to destroy the harness.
    let spN = 0;
    const mkClient = () => {
      let sp = null;
      return {
        query: (text, ...rest) => {
          const t = typeof text === "string" ? text.trim().toLowerCase() : "";
          if (t === "begin") { sp = `sp_${++spN}`; return c.query(`savepoint ${sp}`); }
          if (t === "commit") { const s = sp; sp = null; return c.query(`release savepoint ${s}`); }
          if (t === "rollback") { const s = sp; sp = null; return c.query(`rollback to savepoint ${s}`); }
          return c.query(text, ...rest);
        },
        release() {},
      };
    };
    const txClient = { connect: async () => mkClient(), query: (...a) => c.query(...a), totalCount: 0 };
    const L = svc({ pool: txClient });

    const snap = async (as_of = null) =>
      opportunityLifecycleSnapshot(c, { property_id: P, as_of });
    const rowOf = (s, id) => s.rows.find((r) => String(r.opportunity_id) === String(id));

    console.log("\n── 1 · NEW OPPORTUNITY, NO LATER EVENT ──────────────────");
    let s0 = await snap();
    ok(rowOf(s0, oB).lifecycle_state === LIFECYCLE.NO_TERMINAL_EVENT,
      `a fresh opportunity has no terminal event (${rowOf(s0, oB).lifecycle_state})`);
    ok(rowOf(s0, oB).terminal === false && rowOf(s0, oB).terminal_event_id === null,
      "not terminal, and nothing is claimed as evidence");

    console.log("\n── 2 · WRITERS REQUIRE EXACT OPPORTUNITY IDENTITY ───────");
    let refused = null;
    try {
      await L.closeNotFit({ conversationId: conv, propertyId: P,
        actorUserId: host, reasonCode: "budget_mismatch" });
    } catch (e) { refused = e; }
    ok(refused && refused.httpStatus === 400,
      `close WITHOUT an opportunity id refuses (${refused && refused.httpStatus})`);
    ok(/exact opportunity id/i.test(refused.publicMessage), "saying exactly why");
    const evCount = (await one(`select count(*)::int n from leasing_lead_lifecycle_events where conversation_id=$1`, [conv])).n;
    ok(evCount === 0, "and NO event was written — it refuses BEFORE any write");

    console.log("\n── 3 · WRONG-PROPERTY OPPORTUNITY REFUSES ───────────────");
    const foreignPerson = (await one(`insert into persons (name, lifecycle_status) values ('Foreign','lead') returning id`)).id;
    const foreignLead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at) values ($1,$2,'new',now()) returning id`, [foreignPerson, other])).id;
    const foreignOpp = (await one(
      `insert into leasing_conversions (person_id, property_id, lead_id, status, current_stage, opened_at, actual_tour_host_user_id, conversation_owner_user_id)
       values ($1,$2,$3,'active','touring',now(),$4,$4) returning id`, [foreignPerson, other, foreignLead, host])).id;
    let wrongProp = null;
    try {
      await L.closeNotFit({ conversationId: conv, propertyId: P, conversionId: foreignOpp,
        actorUserId: host, reasonCode: "budget_mismatch" });
    } catch (e) { wrongProp = e; }
    ok(wrongProp && wrongProp.httpStatus === 403,
      `an opportunity at another property refuses (${wrongProp && wrongProp.httpStatus})`);

    console.log("\n── 4 · CLOSING ONE DOES NOT CLOSE THE OTHER ─────────────");
    await L.closeNotFit({ conversationId: conv, propertyId: P, conversionId: oA,
      actorUserId: host, reasonCode: "budget_mismatch", idempotencyKey: "close-A-1" });
    let s1 = await snap();
    ok(rowOf(s1, oA).terminal === true, "opportunity A is terminal");
    ok(rowOf(s1, oA).terminal_code === "budget_mismatch",
      `carrying its governed reason code (${rowOf(s1, oA).terminal_code})`);
    ok(!!rowOf(s1, oA).terminal_event_id, "and the exact event id supporting it");
    ok(rowOf(s1, oB).terminal === false,
      "opportunity B — SAME conversation — is NOT terminal");
    ok(rowOf(s1, oB).lifecycle_state === LIFECYCLE.NO_TERMINAL_EVENT,
      "and still has no terminal event of its own");

    console.log("\n── 5 · REOPENING ONE DOES NOT REOPEN THE OTHER ──────────");
    await L.closeNotFit({ conversationId: conv, propertyId: P, conversionId: oB,
      actorUserId: host, reasonCode: "location", idempotencyKey: "close-B-1" });
    await L.reopen({ conversationId: conv, propertyId: P, conversionId: oB,
      actorUserId: host, idempotencyKey: "reopen-B-1" });
    let s2 = await snap();
    ok(rowOf(s2, oB).lifecycle_state === LIFECYCLE.REOPENED,
      `B is reopened after terminal (${rowOf(s2, oB).lifecycle_state})`);
    ok(rowOf(s2, oB).terminal === false, "so B is not terminal as of now");
    ok(rowOf(s2, oA).terminal === true,
      "while A — same conversation — REMAINS terminal, untouched by B's reopen");

    console.log("\n── 6 · REOPEN PRESERVES THE PRIOR TERMINAL HISTORY ──────");
    const hb = rowOf(s2, oB).terminal_history;
    ok(hb.length === 2, `both events are retained (${hb.length})`);
    ok(hb[0].event_type === "closed_not_fit" && hb[0].reason_code === "location",
      "the earlier close is still readable, with its reason");
    ok(hb[1].event_type === "reopened", "followed by the reopen");
    ok(!!rowOf(s2, oB).latest_reopen_event_id, "and the exact reopen event id is named");

    console.log("\n── 7 · TERMINAL → REOPEN → TERMINAL AGAIN ───────────────");
    await L.closeNotFit({ conversationId: conv, propertyId: P, conversionId: oB,
      actorUserId: host, reasonCode: "no_longer_interested", idempotencyKey: "close-B-2" });
    let s3 = await snap();
    ok(rowOf(s3, oB).terminal === true, "B is terminal again");
    ok(rowOf(s3, oB).terminal_code === "no_longer_interested",
      `the LATER terminal event is the current evidence (${rowOf(s3, oB).terminal_code})`);
    ok(rowOf(s3, oB).terminal_history.length === 3,
      `and the whole chronology survives (${rowOf(s3, oB).terminal_history.length})`);
    ok(rowOf(s3, oB).terminal_history.map((h) => h.event_type).join(">")
       === "closed_not_fit>reopened>closed_not_fit", "in order");

    console.log("\n── 8 · STALE LABEL CANNOT OVERRIDE EVENT TRUTH ──────────");
    //  oB's mutable status still says 'active' while events say terminal.
    ok(rowOf(s3, oB).compatibility.conversion_status === "active",
      "the mutable label still reads 'active'");
    ok(rowOf(s3, oB).terminal === true, "but the EVENTS say terminal, and they win");
    ok(rowOf(s3, oB).label_disagrees_with_events === true, "and the disagreement is surfaced, not hidden");

    console.log("\n── 9 · LABEL SAYS CLOSED BUT NO TERMINAL EVENT ──────────");
    //  oA's label is 'released' — but consider a THIRD opportunity whose label
    //  claims closure with no event at all.
    const oC = await mkOpp("released", "new");
    let s4 = await snap();
    ok(rowOf(s4, oC).lifecycle_state === LIFECYCLE.NO_TERMINAL_EVENT,
      `a 'released' label with no event is NOT terminal (${rowOf(s4, oC).lifecycle_state})`);
    ok(rowOf(s4, oC).terminal === false, "the label is not accepted as evidence");
    ok(rowOf(s4, oC).label_disagrees_with_events === true,
      "and the row reports that the label disagrees with the events");

    console.log("\n── 10 · PENDING: FUTURE APPOINTMENT ─────────────────────");
    await c.query(`insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
                     scheduled_for, status, conversion_id)
                   values ($1,$2,$3,$4, now() + interval '7 days','scheduled',$5)`,
      [lead, P, unit, host, oC]);
    let s5 = await snap();
    ok(rowOf(s5, oC).pending_state === "pending", "a future appointment makes it pending");
    ok(rowOf(s5, oC).pending_basis.includes(PENDING.FUTURE_APPOINTMENT),
      `naming the exact basis (${rowOf(s5, oC).pending_basis.join(", ")})`);

    console.log("\n── 11 · PENDING: OBSERVED VISIT AWAITING OUTCOME ────────");
    const wD = await mkPersonLead("Pending prospect D");
    const oD = await mkOpp("active", "touring", wD);
    await c.query(`insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
                     scheduled_for, status, completed_at, conversion_id)
                   values ($1,$2,$3,$4, now() - interval '2 days','completed', now() - interval '2 days',$5)`,
      [wD.lead, P, unit, host, oD]);
    let s6 = await snap();
    ok(rowOf(s6, oD).pending_basis.includes(PENDING.VISIT_AWAITING),
      "a completed visit with no captured outcome is pending on that outcome");

    console.log("\n── 12 · PENDING: OPEN FOLLOW-UP OBLIGATION ──────────────");
    const oblig = (await one(`insert into obligations (module, type, status)
      values ('leasing','generic','open') returning id`)).id;
    await c.query(`insert into leasing_conversion_obligations (conversion_id, obligation_id, rung, owner_user_id, due_by)
                   values ($1,$2,'tour_followup',$3, now() + interval '1 day')`, [oD, oblig, host]);
    let s7 = await snap();
    ok(rowOf(s7, oD).pending_basis.includes(PENDING.OPEN_OBLIGATION),
      "an open follow-up obligation is a pending basis");

    console.log("\n── 13 · PENDING: APPLICATION UNDERWAY ───────────────────");
    await c.query(`insert into lease_applications (property_id, person_id, conversion_id, status, created_at)
                   values ($1,$2,$3,'submitted', now())`, [P, wD.person, oD]);
    let s8 = await snap();
    ok(rowOf(s8, oD).pending_basis.includes(PENDING.APPLICATION_UNDERWAY),
      "an application in progress is a pending basis");
    ok(rowOf(s8, oD).pending_basis.length >= 3,
      `several real bases coexist and are all named (${rowOf(s8, oD).pending_basis.length})`);

    console.log("\n── 14 · NOT TERMINAL WITH NOTHING PENDING IS ITS OWN ANSWER ─");
    const wE = await mkPersonLead("Quiet prospect E");
    const oE = await mkOpp("active", "new", wE);
    let s9 = await snap();
    ok(rowOf(s9, oE).pending_state === PENDING.NONE_KNOWN,
      `no known pending act (${rowOf(s9, oE).pending_state})`);
    ok(rowOf(s9, oE).pending_state !== "active",
      "and it is NEVER called 'active' merely to fill a status");
    ok(rowOf(s9, oE).terminal === false && rowOf(s9, oE).pending_basis.length === 0,
      "not terminal, no pending basis — a distinct, honest state");

    console.log("\n── 15 · PAST APPOINTMENT, UNKNOWN OBSERVATION ───────────");
    const wF = await mkPersonLead("Past-appt prospect F");
    const oF = await mkOpp("active", "touring", wF);
    await c.query(`insert into leasing_tours (lead_id, property_id, unit_id, leasing_agent_id,
                     scheduled_for, status, conversion_id)
                   values ($1,$2,$3,$4, now() - interval '9 days','scheduled',$5)`,
      [wF.lead, P, unit, host, oF]);
    let s10 = await snap();
    ok(rowOf(s10, oF).pending_basis.includes(PENDING.FUTURE_APPOINTMENT) === false,
      "a PAST appointment is not a future one");
    ok(rowOf(s10, oF).pending_state === PENDING.NONE_KNOWN,
      "and an unobserved past appointment is not silently a pending act");
    ok(rowOf(s10, oF).terminal === false, "nor is it terminal — the clock closes nothing");

    console.log("\n── 16 · REPLAY IS IDEMPOTENT ────────────────────────────");
    let dup = null;
    try {
      await L.closeNotFit({ conversationId: conv, propertyId: P, conversionId: oA,
        actorUserId: host, reasonCode: "budget_mismatch", idempotencyKey: "close-A-1" });
    } catch (e) { dup = e; }
    ok(dup && dup.httpStatus === 409, `replaying the same close is refused (${dup && dup.httpStatus})`);
    const aEvents = (await one(
      `select count(*)::int n from leasing_lead_lifecycle_events where conversion_id=$1 and event_type='closed_not_fit'`, [oA])).n;
    ok(aEvents === 1, `and exactly ONE close event exists for A (${aEvents})`);

    console.log("\n── 17 · STABLE AS-OF READS BEFORE AND AFTER A CLOSE ─────");
    const beforeClose = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const sBefore = await snap(beforeClose);
    ok(rowOf(sBefore, oA).terminal === false,
      "read AS OF an hour ago, A is not yet terminal");
    ok(rowOf(await snap(), oA).terminal === true, "read as of now, it is");
    const r1 = await snap(beforeClose), r2 = await snap(beforeClose);
    ok(JSON.stringify(r1.rows) === JSON.stringify(r2.rows),
      "and two reads at the SAME as_of are byte-identical");

    console.log("\n── 18 · UNATTRIBUTED HISTORY STAYS UNAPPLIED ────────────");
    //  A legacy conversation-level terminal event, as history contains.
    await c.query(`insert into leasing_lead_lifecycle_events
        (conversation_id, property_id, event_sequence, event_type, actor_type, actor_id,
         reason_code, idempotency_key, occurred_at)
       values ($1,$2,999,'closed_not_fit','operator',$3,'duplicate','legacy-1', now())`,
      [conv, P, host]);
    let s11 = await snap();
    ok(s11.unattributed_terminal_events.length === 1,
      "a conversation-level terminal event is reported separately");
    ok(rowOf(s11, oE).terminal === false,
      "and is NOT applied to any opportunity — that would require guessing");
    ok(rowOf(s11, oE).coverage_state === "untrackable_history_present",
      `coverage says so explicitly (${rowOf(s11, oE).coverage_state})`);

    console.log("\n── 19 · EXACT BACKFILL WRITES ONLY EXACT ROWS ───────────");
    const M = await measure(c, { property_id: P });
    ok(M.untrackable.length >= 1,
      `closed_not_fit / reopened carry no exact evidence (${M.untrackable.length} untrackable)`);
    ok(M.exactly_attributable.length === 0,
      "and nothing is invented for them");
    const before = (await one(`select count(*)::int n from leasing_lead_lifecycle_events where conversion_id is null`)).n;
    const B = await backfill(c, { property_id: P, apply: true });
    const after = (await one(`select count(*)::int n from leasing_lead_lifecycle_events where conversion_id is null`)).n;
    ok(B.written === M.exactly_attributable.length,
      `the backfill wrote exactly the exact-evidence rows (${B.written})`);
    ok(after === before - B.written, "and touched nothing else");
    const src = require("fs").readFileSync(
      path.join(REPO, "tools/lifecycle_event_attribution_backfill.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (const [label, re] of [
      ["active-conversion lookup", /status\s*=\s*''active''|status\s*=\s*'active'/],
      ["person+property lookup",   /person_id/],
      ["lead-based attribution",   /lead_id/],
      ["time-proximity selection", /order by[\s\S]{0,60}limit 1/i],
    ]) ok(!re.test(src), `no ${label} in the backfill`);

    console.log("\n── 20 · THE PROJECTION NEVER READS MUTABLE STATUS ───────");
    const psrc = require("fs").readFileSync(
      path.join(REPO, "src/leasing/opportunity_lifecycle_read.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    ok(!/leasing_leads/.test(psrc), "leasing_leads is never queried for terminal truth");
    ok(!/\b(insert|update|delete)\s+(into\s+)?[a-z_]/i.test(psrc), "the projection writes nothing");
    ok(!/rank|score|stage_config|pipeline/i.test(psrc), "no ranking, scoring, stages or pipeline");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   opportunity lifecycle: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
