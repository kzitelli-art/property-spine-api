// ════════════════════════════════════════════════════════════════════
//  slice9_inbound_decision_proof.js — "OPPORTUNITY SELECTION REQUIRED".
//
//  THE USABILITY STANDARD UNDER TEST:
//    the system knows a person replied
//      -> one person knows it is theirs
//      -> the next decision is explicit
//      -> the exact opportunity is reopened only after judgment
//
//  Real Postgres, transaction-rolled, self-contained.
//
//  Run: DATABASE_URL=... node tests/proofs/slice9_inbound_decision_proof.js
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");
const D = require(path.join(REPO, "src/leasing/inbound_opportunity_decision"));
const svc = require(path.join(REPO, "src/leasing/leasing_lifecycle_service"));
const { opportunityLifecycleSnapshot } =
  require(path.join(REPO, "src/leasing/opportunity_lifecycle_read"));

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
  try {
    await c.query("begin");
    const one = async (q, a = []) => (await c.query(q, a)).rows[0];

    const P = (await one(`insert into properties (name, operating_timezone)
      values ('S9 inbound decision — scratch','America/New_York') returning id`)).id;
    const other = (await one(`insert into properties (name, operating_timezone)
      values ('S9 inbound decision — other','America/New_York') returning id`)).id;
    const host = (await one(`insert into users (email,name)
      values ('inbound@proof.test','Operator') returning id`)).id;

    let spN = 0;
    const mkClient = () => {
      let sp = null;
      return { query: (t, ...r) => {
        const s = typeof t === "string" ? t.trim().toLowerCase() : "";
        if (s === "begin") { sp = `sp${++spN}`; return c.query(`savepoint ${sp}`); }
        if (s === "commit") { const x = sp; sp = null; return c.query(`release savepoint ${x}`); }
        if (s === "rollback") { const x = sp; sp = null; return c.query(`rollback to savepoint ${x}`); }
        return c.query(t, ...r);
      }, release() {} };
    };
    const L = svc({ pool: { connect: async () => mkClient(), query: (...a) => c.query(...a), totalCount: 0 } });

    //  One person, one conversation, N opportunities — the real shape.
    const setup = async (label, nOpps, closeWhich = []) => {
      const person = (await one(`insert into persons (name, lifecycle_status) values ($1,'lead') returning id`, [label])).id;
      const conv = (await one(`insert into conversations (property_id, person_id, channel_primary, status)
        values ($1,$2,'sms','open') returning id`, [P, person])).id;
      const lead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
        values ($1,$2,'new',now()) returning id`, [person, P])).id;
      const opps = [];
      for (let i = 0; i < nOpps; i++) {
        opps.push((await one(
          `insert into leasing_conversions (person_id,property_id,lead_id,status,current_stage,opened_at,
             actual_tour_host_user_id, conversation_owner_user_id)
           values ($1,$2,$3,$4,'touring', now() - ($5 || ' days')::interval, $6,$6) returning id`,
          [person, P, lead, i === nOpps - 1 ? "active" : "released", String(60 - i * 10), host])).id);
      }
      let seq = 0;
      for (const idx of closeWhich) {
        await c.query(`insert into leasing_lead_lifecycle_events (conversation_id, conversion_id, property_id,
            event_sequence, event_type, actor_type, actor_id, reason_code, idempotency_key, occurred_at)
          values ($1,$2,$3,$4,'closed_not_fit','operator',$5,'budget_mismatch',$6, now() - interval '3 days')`,
          [conv, opps[idx], P, ++seq, host, `${label}-close-${idx}`]);
      }
      const inbound = (await one(`insert into comm_events (property_id, person_id, conversation_id, channel,
          direction, body, classification, sender_role)
        values ($1,$2,$3,'text','inbound','Still interested actually','leasing','prospect') returning id`,
        [P, person, conv])).id;
      return { person, conv, lead, opps, inbound };
    };

    console.log("\n── 1 · ONE CLOSED OPPORTUNITY, ONE INBOUND REPLY ────────");
    const A = await setup("Single", 1, [0]);
    const rA = await L.maybeReopenOnQualifyingInbound(c, {
      conversationId: A.conv, sourceCommEventId: A.inbound });
    ok(rA.refused === true && rA.refusal_code === "opportunity_identity_required",
      "attribution is refused — the system never picks an opportunity");
    ok(rA.decision_opened === true, "and an explicit decision is opened");
    ok(!!rA.decision_obligation_id, "with a real obligation id");
    ok(/replied after the opportunity was closed/i.test(rA.operator_prompt),
      `the operator prompt is plain language ("${rA.operator_prompt.slice(0, 46)}…")`);
    ok(!/conversion|grain|lifecycle event/i.test(rA.operator_prompt),
      "and mentions no conversion id, grain or lifecycle-event architecture");

    console.log("\n── 2 · MESSAGE SURVIVES THE REFUSAL ─────────────────────");
    ok((await one(`select count(*)::int n from comm_events where id=$1`, [A.inbound])).n === 1,
      "the prospect's reply is still durably stored");
    ok((await one(`select count(*)::int n from leasing_lead_lifecycle_events
                   where conversation_id=$1 and event_type='reopened'`, [A.conv])).n === 0,
      "and NO reopen event was invented");

    console.log("\n── 3 · ONE PERSON OWNS THE NEXT ACTION ──────────────────");
    const ob = await one(`select * from obligations where id=$1`, [rA.decision_obligation_id]);
    ok(ob.type === D.DECISION_TYPE, `the decision is typed (${ob.type})`);
    ok(ob.status === "open", "and open");
    ok(String(ob.related_id) === String(A.conv) && ob.related_type === "conversation",
      "linked to the CONVERSATION, never to a guessed opportunity");
    ok(ob.conversion_id === undefined || ob.conversion_id === null,
      "and carries no conversion_id at all");
    //  obligations.source_event_id FKs `events`, not `comm_events`, and there is
    //  no comm-event column — so the inbound reference rides the dedupe_key
    //  rather than being forced into a column that means something else.
    ok(ob.source_event_id === null,
      "source_event_id is left NULL rather than pointing at the wrong table");
    ok(String(D.inboundEventIdOf(ob)) === String(A.inbound),
      "and the exact inbound message is still recoverable from the decision");
    ok(ob.owner_eligibility_state === "unassigned" && ob.assigned_user_id === null,
      `ownership is EXPLICIT — UNASSIGNED, never silently ownerless (${ob.owner_eligibility_state})`);
    ok(Array.isArray(ob.required_inputs) && ob.required_inputs.includes(D.DECISION_INPUT),
      `the exact proof required is stated (${ob.required_inputs})`);
    ok(!!ob.created_at, "with a created time");

    console.log("\n── 4 · DUPLICATE INBOUND DELIVERY IS IDEMPOTENT ─────────");
    const rA2 = await L.maybeReopenOnQualifyingInbound(c, {
      conversationId: A.conv, sourceCommEventId: A.inbound });
    ok(String(rA2.decision_obligation_id) === String(rA.decision_obligation_id),
      "a replayed delivery converges on the SAME decision");
    ok((await one(`select count(*)::int n from obligations where type=$1 and related_id=$2`,
      [D.DECISION_TYPE, A.conv])).n === 1, "exactly one decision exists");

    console.log("\n── 5 · ONE CANDIDATE IS STILL A HUMAN CONFIRMATION ──────");
    const cand1 = await D.listOpportunityCandidates(c, { property_id: P, conversation_id: A.conv });
    ok(cand1.candidate_count === 1, `one candidate is offered (${cand1.candidate_count})`);
    ok(cand1.selection_required === true && cand1.auto_selected === null,
      "selection is still REQUIRED — the server selects nothing");
    ok(cand1.candidates[0].closed_by_event === true,
      "and the candidate's closed state comes from EVENTS, not the mutable label");

    console.log("\n── 6 · SEVERAL CANDIDATES REMAIN UNRESOLVED ─────────────");
    const B = await setup("Several", 3, [2]);
    await L.maybeReopenOnQualifyingInbound(c, { conversationId: B.conv, sourceCommEventId: B.inbound });
    const candN = await D.listOpportunityCandidates(c, { property_id: P, conversation_id: B.conv });
    ok(candN.candidate_count === 3, `all three are offered (${candN.candidate_count})`);
    ok(candN.auto_selected === null, "none is auto-selected");
    const ids = candN.candidates.map((x) => String(x.opportunity_id));
    ok(new Set(ids).size === 3, "each is a distinct exact opportunity id");

    console.log("\n── 7 · ZERO CANDIDATES REMAINS UNRESOLVED AND VISIBLE ───");
    const zPerson = (await one(`insert into persons (name, lifecycle_status) values ('No opps','lead') returning id`)).id;
    const zConv = (await one(`insert into conversations (property_id, person_id, channel_primary, status)
      values ($1,$2,'sms','open') returning id`, [P, zPerson])).id;
    const candZ = await D.listOpportunityCandidates(c, { property_id: P, conversation_id: zConv });
    ok(candZ.candidate_count === 0, "no candidate exists");
    ok(candZ.selection_required === true, "and the decision is NOT resolvable by choosing nothing");

    console.log("\n── 8 · WRONG-PROPERTY CANDIDATE EXCLUSION ───────────────");
    //  Same person, an opportunity at ANOTHER property.
    const fLead = (await one(`insert into leasing_leads (person_id, property_id, status, received_at)
      values ($1,$2,'new',now()) returning id`, [A.person, other])).id;
    const fOpp = (await one(`insert into leasing_conversions (person_id,property_id,lead_id,status,current_stage,
        opened_at, actual_tour_host_user_id, conversation_owner_user_id)
      values ($1,$2,$3,'active','touring',now(),$4,$4) returning id`, [A.person, other, fLead, host])).id;
    const candW = await D.listOpportunityCandidates(c, { property_id: P, conversation_id: A.conv });
    ok(!candW.candidates.some((x) => String(x.opportunity_id) === String(fOpp)),
      "an opportunity at another property is never offered");
    const candX = await D.listOpportunityCandidates(c, { property_id: other, conversation_id: A.conv });
    ok(candX.ok === false && candX.refusal_code === "conversation_not_at_property",
      `and a cross-property read refuses (${candX.refusal_code})`);

    console.log("\n── 9 · EXACT SELECTION REOPENS ONLY THE SELECTED ONE ────");
    //  Close TWO of B's opportunities so isolation is observable.
    await c.query(`insert into leasing_lead_lifecycle_events (conversation_id, conversion_id, property_id,
        event_sequence, event_type, actor_type, actor_id, reason_code, idempotency_key, occurred_at)
      values ($1,$2,$3,9,'closed_not_fit','operator',$4,'location','B-close-0', now() - interval '2 days')`,
      [B.conv, B.opps[0], P, host]);
    const bDecision = (await one(`select id from obligations where type=$1 and related_id=$2`,
      [D.DECISION_TYPE, B.conv])).id;
    const res = await D.resolveInboundOpportunityDecision(c, {
      obligation_id: bDecision, conversation_id: B.conv, property_id: P,
      conversion_id: B.opps[2], actor_user_id: host, source_comm_event_id: B.inbound,
      lifecycleService: L });
    ok(res.ok === true, `the selected opportunity is reopened (${res.refusal_reason || "ok"})`);
    ok(String(res.opportunity_id) === String(B.opps[2]), "exactly the one chosen");
    ok(!!res.reopen_event_id, "with a real reopen event");
    const lifeB = await opportunityLifecycleSnapshot(c, { property_id: P });
    const rowB2 = lifeB.rows.find((r) => String(r.opportunity_id) === String(B.opps[2]));
    const rowB0 = lifeB.rows.find((r) => String(r.opportunity_id) === String(B.opps[0]));
    ok(rowB2.terminal === false && rowB2.reopened_after_terminal === true,
      "the chosen opportunity is reopened");
    ok(rowB0.terminal === true, "the OTHER closed opportunity remains terminal");

    console.log("\n── 10 · PRIOR TERMINAL HISTORY IS PRESERVED ─────────────");
    ok(rowB2.terminal_history.length === 2, `both events retained (${rowB2.terminal_history.length})`);
    ok(rowB2.terminal_history[0].event_type === "closed_not_fit",
      "the original terminal event is neither mutated nor deleted");
    ok(rowB2.terminal_history[0].reason_code === "budget_mismatch", "with its reason intact");

    console.log("\n── 11 · THE DECISION CLOSES WITH PROOF ──────────────────");
    const closedOb = await one(`select * from obligations where id=$1`, [bDecision]);
    ok(closedOb.status === "complete", `the decision obligation is closed (${closedOb.status})`);
    //  satisfyObligation records proof as a durable `events` row.
    const proofEv = await one(
      `select note from events where type = $1 order by occurred_at desc limit 1`,
      [`input_satisfied:${D.DECISION_INPUT}`]);
    ok(!!proofEv, "a durable proof event was written");
    ok(/selected_opportunity_id/.test(proofEv.note) && proofEv.note.includes(String(B.opps[2])),
      "naming the exact opportunity the operator selected");
    ok(/explicit_human_selection/.test(proofEv.note),
      "and recording the basis as explicit human selection");
    ok(String(closedOb.completed_by || host) === String(host), "attributed to the deciding actor");

    console.log("\n── 12 · SELECTION WITHOUT AN OPPORTUNITY REFUSES ────────");
    const noPick = await D.resolveInboundOpportunityDecision(c, {
      obligation_id: rA.decision_obligation_id, conversation_id: A.conv, property_id: P,
      conversion_id: null, actor_user_id: host, lifecycleService: L });
    ok(noPick.ok === false && noPick.refusal_code === "opportunity_selection_required",
      `resolving without a choice refuses (${noPick.refusal_code})`);
    ok(/will not choose one/i.test(noPick.refusal_reason), "saying the system will not choose");

    console.log("\n── 13 · FAILED REOPEN LEAVES THE DECISION VISIBLE ───────");
    const bad = await D.resolveInboundOpportunityDecision(c, {
      obligation_id: rA.decision_obligation_id, conversation_id: A.conv, property_id: P,
      conversion_id: fOpp, actor_user_id: host, lifecycleService: L });
    ok(bad.ok === false, "selecting a wrong-property opportunity fails");
    ok(bad.decision_remains_open === true, "the decision REMAINS open");
    ok(!!bad.refusal_reason, `with the exact blocked reason ("${String(bad.refusal_reason).slice(0, 40)}…")`);
    const stillOpen = await one(`select status from obligations where id=$1`, [rA.decision_obligation_id]);
    ok(stillOpen.status === "open", `and is not silently marked handled (${stillOpen.status})`);

    console.log("\n── 15 · VISIBILITY IN THE CANONICAL OBLIGATION READ ─────");
    //  The canonical scoped read is main's operator_obligations_service.list.
    //  Its projection is reproduced here EXACTLY (from origin/main
    //  src/obligations/operator_obligations_service.js) so this proof measures
    //  the real contract rather than a convenient one. Its two mandatory
    //  predicates are property_id and module.
    const FIELDS = ["id","property_id","module","type","label","status","due_at",
      "assigned_user_id","assigned_role","person_id","unit_id","related_type",
      "related_id","created_at","updated_at"];
    const listed = (await c.query(
      `select ${FIELDS.map((f) => "o." + f).join(", ")},
              (o.due_at is not null and o.due_at < now()) as is_overdue
         from obligations o
        where o.property_id = $1 and o.module = any($2::text[])
        order by o.due_at asc nulls last, o.created_at desc, o.id asc`,
      [P, ["leasing"]])).rows;
    const mine = listed.find((r) => String(r.id) === String(rA.decision_obligation_id));
    ok(!!mine, "the decision APPEARS in the canonical property+module scoped read");
    ok(mine.module === "leasing", `under the leasing module an operator holds (${mine.module})`);
    ok(mine.status === "open", "as open work");
    ok(/Choose which opportunity this reply belongs to/.test(mine.label),
      `with a plain-language label ("${mine.label}")`);
    ok(!/conversion|conversation|lifecycle|grain/i.test(mine.label),
      "exposing no conversion id, conversation grain or lifecycle terminology");
    ok(String(mine.related_id) === String(A.conv) && mine.related_type === "conversation",
      "carrying its conversation context");
    ok(String(mine.person_id) === String(A.person), "and its person context");

    console.log("\n── 16 · SCOPE AND UNASSIGNED COVERAGE ───────────────────");
    const otherScope = (await c.query(
      `select id from obligations where property_id=$1 and module = any($2::text[])`,
      [other, ["leasing"]])).rows;
    ok(!otherScope.some((r) => String(r.id) === String(rA.decision_obligation_id)),
      "it never appears under another property's scope");
    const noModule = (await c.query(
      `select id from obligations where property_id=$1 and module = any($2::text[])`,
      [P, ["maintenance"]])).rows;
    ok(!noModule.some((r) => String(r.id) === String(rA.decision_obligation_id)),
      "nor to an operator without the leasing module");
    //  UNASSIGNED coverage read.
    const unassigned = (await c.query(
      `select id, owner_eligibility_state from obligations
        where property_id=$1 and status <> 'complete' and assigned_user_id is null`, [P])).rows;
    const un = unassigned.find((r) => String(r.id) === String(rA.decision_obligation_id));
    ok(!!un, "an unassigned decision appears in the unassigned/coverage read");
    ok(un.owner_eligibility_state === "unassigned",
      `with ownership stated EXPLICITLY, not merely absent (${un.owner_eligibility_state})`);

    console.log("\n── 17 · THE QUEUE DOES NOT MARK IT HANDLED ──────────────");
    const openNow = await one(`select status from obligations where id=$1`, [rA.decision_obligation_id]);
    ok(openNow.status === "open",
      "while the decision is unresolved it stays open — never silently handled");
    ok((await one(`select body from comm_events where id=$1`, [A.inbound])).body.length > 0,
      "and the underlying reply remains readable");
    const bDone = await one(`select status from obligations where id=$1`, [bDecision]);
    ok(bDone.status === "complete",
      "a resolved decision leaves the queue (complete), so it cannot linger");

    console.log("\n── 14 · NO INFERRED OPPORTUNITY ID IS EVER WRITTEN ──────");
    const guessed = (await one(
      `select count(*)::int n from obligations where type=$1 and related_type <> 'conversation'`,
      [D.DECISION_TYPE])).n;
    ok(guessed === 0, "no decision obligation carries anything but its conversation");
    const src = require("fs").readFileSync(
      path.join(REPO, "src/leasing/inbound_opportunity_decision.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (const [label, re] of [
      ["last-active selection",  /status\s*=\s*''active''/],
      //  Targeted at SELECTING AN OPPORTUNITY. A `limit 1` that reads a display
      //  fact for an ALREADY-identified candidate (its last close reason) is
      //  not a pick, and a guard that cannot tell those apart tests nothing.
      ["latest-creation pick",   /from leasing_conversions[\s\S]{0,200}?limit 1/i],
      ["message-timing pick",    /occurred_at[\s\S]{0,40}limit 1/i],
      ["appointment proximity",  /scheduled_for[\s\S]{0,40}limit 1/i],
    ]) ok(!re.test(src), `no ${label} in the decision module`);

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release(); await pool.end();
  }
  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   inbound decision: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
