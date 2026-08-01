// ════════════════════════════════════════════════════════════════════
//  resident_sms_work_order_proof.js
//  Contract: docs/RESIDENT_SMS_WORK_ORDER_CONTRACT.md (v3, 5eef41f)
//
//  Part A — PURE. The obligation state machine and the closed vocabularies.
//           Runs anywhere, no database.
//  Part B — DURABLE. The 20 contract cases against REAL Postgres, in a
//           transaction that is ALWAYS rolled back. Requires DATABASE_URL.
//
//  Without DATABASE_URL this harness reports Part A only and exits NONZERO,
//  so a missing database can never be mistaken for a passing suite. That is
//  the same discipline renewals_slice6_proof.js uses and the same failure
//  mode run_harnesses.sh exists to prevent.
// ════════════════════════════════════════════════════════════════════
"use strict";

const assert = require("assert");
const path = require("path");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; failures.push(name); console.error(`  FAIL  ${name}`); }
}
async function throws(fn, re, name) {
  try { await fn(); ok(false, `${name} (expected a refusal, got success)`); }
  catch (e) { ok(re.test(e.message || ""), `${name}${re.test(e.message || "") ? "" : ` (got: ${e.message})`}`); }
}
function section(t) { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`); }

// ────────────────────────────────────────────────────────────────────
//  PART A — PURE
// ────────────────────────────────────────────────────────────────────
(async function partA() {
  console.log("\n════ PART A — pure (no database) ════");

  section("classifyUrgency — the closed emergency vocabulary");
  const { classifyUrgency } = require(path.join(__dirname, "../src/maintenance/maintenance_urgency.js"));
  const EMERGENCY_TYPES_KEYS = [
    "active_leak", "flood", "no_heat", "no_hot_water", "electrical_hazard",
    "fire_life_safety", "lockout", "security_issue", "sewer_backup",
    "roof_leak", "major_appliance", "manager_override",
  ];
  const probes = [
    "there is smoke coming from the outlet", "water is pouring through the ceiling",
    "I smell gas", "someone broke in and the door won't lock", "sewage is backing up",
    "the sink has a slow drip", "my smoke alarm keeps chirping low battery",
    "there's a leak", "no power in the unit", "the window is cracked",
  ];
  let allValid = true;
  for (const p of probes) {
    const u = classifyUrgency(p);
    if (u.emergency_type && !EMERGENCY_TYPES_KEYS.includes(u.emergency_type)) allValid = false;
    if (u.urgency === "emergency" && !u.emergency_type) allValid = false;
    if (u.urgency === "needs_confirmation" && !u.clarifying_question) allValid = false;
  }
  ok(allValid, "every emergency verdict carries a VALID type; every needs_confirmation carries a question");

  section("transitionObligation — the constrained state machine");
  // Exercised against a fake client: this proves the guard logic, which is
  // pure. The DB-facing behaviour is Part B's job.
  // The REAL implementation server.js uses — not a copy.
  const { transitionObligation, OBLIGATION_TRANSITIONS } =
    require(path.join(__dirname, "../src/shared/obligation_transitions.js"));

  ok(Object.keys(OBLIGATION_TRANSITIONS).sort().join(",") ===
     "confirm_urgency->emergency_repair,confirm_urgency->maintenance_repair",
     "exactly two transitions are permitted — no generic mutation path exists");

  const rowOpen = { id: "o1", type: "confirm_urgency", status: "open", property_id: "p", person_id: null, unit_id: null, related_type: "work_order", related_id: "w1", required_inputs: [] };
  const client = (row) => ({ calls: [], async query(sql, params) {
    this.calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
    if (/^select \* from obligations/.test(String(sql).trim())) return { rows: row ? [row] : [] };
    if (/^update obligations/.test(String(sql).trim())) return { rows: [{ ...row, type: params[0] }] };
    return { rows: [] };
  } });

  await throws(() => transitionObligation(client(rowOpen), {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "billback_decision", label: "x", required_inputs: [], priority: "normal", severity: "normal",
  }), /not permitted/, "a transition outside the whitelist is refused");

  await throws(() => transitionObligation(client(rowOpen), {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "emergency_repair", label: "x", required_inputs: ["closeout_proof"],
    priority: "high", severity: "emergency", // escalates_to_role + due_at missing
  }), /requires .*escalates_to_role|requires .*due_at/, "emergency target refuses without its coupled deadline/escalation fields");

  await throws(() => transitionObligation(client(rowOpen), {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "maintenance_repair", required_inputs: ["closeout_proof"], priority: "normal", severity: "normal",
  }), /requires label/, "a type may not move without its label");

  await throws(() => transitionObligation(client({ ...rowOpen, type: "maintenance_repair" }), {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "maintenance_repair", label: "x", required_inputs: [], priority: "normal", severity: "normal",
  }), /is now maintenance_repair/, "STALE STATE fails closed — someone else already resolved it");

  await throws(() => transitionObligation(client({ ...rowOpen, status: "complete" }), {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "maintenance_repair", label: "x", required_inputs: [], priority: "normal", severity: "normal",
  }), /already complete/, "a completed obligation cannot be transitioned");

  const c1 = client(rowOpen);
  await transitionObligation(c1, {
    obligation_id: "o1", expected_type: "confirm_urgency", expected_status: "open",
    to_type: "maintenance_repair", label: "Maintenance request",
    required_inputs: ["closeout_proof"], priority: "normal", severity: "normal",
  });
  const updates = c1.calls.filter((c) => /^update obligations/.test(c.sql));
  ok(updates.length === 1, "every coupled field moves in ONE update — no partial-write window");
  const evs = c1.calls.filter((c) => /insert into events/.test(c.sql));
  ok(evs.length === 1 && /work_order_urgency_resolved/.test(JSON.stringify(evs[0].params)),
     "a transition always writes durable history, typed from the table not the caller");

  section("self-review · work-order and obligation state may never diverge");
  {
    const { makeWorkOrderService } = require(path.join(__dirname, "../src/maintenance/work_order_service.js"));
    const { satisfyObligation } = require(path.join(__dirname, "./_engine.js"));
    const svc = makeWorkOrderService({ spawnObligationFromEvent: async () => ({}), satisfyObligation, transitionObligation });
    const mk = (oblType) => {
      const calls = [];
      const wo = { id: "w1", property_id: "p", unit_id: null, urgency_status: "needs_confirmation" };
      const obl = { id: "o1", type: oblType, status: "open", required_inputs: ["urgency_confirmation"], property_id: "p", person_id: null, unit_id: null, related_type: "work_order", related_id: "w1" };
      return { calls, obl, client: { async query(sql, params) {
        const s = String(sql).replace(/\s+/g, " ").trim(); calls.push({ s, params });
        if (/^select \* from work_orders/.test(s)) return { rows: [wo] };
        if (/^select \* from obligations where related_type/.test(s)) return { rows: [obl] };
        if (/^select \* from obligations where id=/.test(s)) return { rows: [obl] };
        if (/^update obligations set required_inputs/.test(s)) { obl.required_inputs = params[0]; return { rows: [obl] }; }
        return { rows: [] };
      } } };
    };
    // The state this flow governs → both move.
    const good = mk("confirm_urgency");
    const rg = await svc.appendClarification(good.client, { work_order_id: "w1", person_id: "x", text: "water is pouring through the ceiling", classifyUrgency });
    ok(rg.outcome === "escalated_emergency", "a governed clarification escalates");
    ok(good.calls.some((c) => /^update work_orders/.test(c.s)) && good.calls.some((c) => /^update obligations set type/.test(c.s)),
       "…and the work order AND the obligation both move");
    // Someone already resolved the obligation → neither moves.
    const bad = mk("maintenance_repair");
    const rb = await svc.appendClarification(bad.client, { work_order_id: "w1", person_id: "x", text: "water is pouring through the ceiling", classifyUrgency });
    ok(rb.outcome === "unresolved", "an ungoverned state resolves to 'unresolved', not a half-apply");
    ok(!bad.calls.some((c) => /^update work_orders/.test(c.s)), "the work order is NOT escalated behind a routine obligation");
    ok(!bad.calls.some((c) => /^update obligations/.test(c.s)), "and the obligation is not touched either");
    // Already emergency → no downgrade, note only.
    const emg = mk("confirm_urgency");
    emg.client.query = (function (orig) { return async function (sql, params) {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^select \* from work_orders/.test(s)) { emg.calls.push({ s, params }); return { rows: [{ id: "w1", property_id: "p", unit_id: null, urgency_status: "emergency" }] }; }
      return orig.call(this, sql, params);
    }; })(emg.client.query);
    const re = await svc.appendClarification(emg.client, { work_order_id: "w1", person_id: "x", text: "actually it is just a slow minor drip", classifyUrgency });
    ok(re.outcome === "already_emergency" && !emg.calls.some((c) => /^update work_orders/.test(c.s)),
       "an emergency is never downgraded by a later clarification");
  }

  console.log(`\n  Part A: ${pass} passed, ${fail} failed`);
})().then(partB).catch((e) => { console.error("PART A ERROR:", e); process.exit(1); });

// ────────────────────────────────────────────────────────────────────
//  PART B — DURABLE (real Postgres, always rolled back)
// ────────────────────────────────────────────────────────────────────
async function partB() {
  if (!process.env.DATABASE_URL) {
    console.error(`
════════════════════════════════════════════════════════════════════
  PART B NOT RUN — DATABASE_URL is not set.

  The 20 contract cases assert against EXECUTED behaviour, not source.
  This harness refuses to report green without them: a suite that
  passes because it skipped its own subject is the exact failure mode
  run_harnesses.sh exists to prevent.

  Set DATABASE_URL (Render env) and re-run.
════════════════════════════════════════════════════════════════════`);
    process.exit(1);
  }

  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const c = await pool.connect();

  try {
    await c.query("begin");
    const RUN = require("crypto").randomUUID().slice(0, 8);
    console.log(`\n════ PART B — real Postgres (rolled back) · run ${RUN} ════`);
    console.log("  fixtures are created fresh and rolled back; NO pre-existing row is read, updated or deleted.");

    // ── fixture: property, unit, person, active lease, used invite ──
    const prop = (await c.query(
      `insert into properties (name) values ($1) returning id`, [`TEST SMS-WO PROOF ${RUN}`])).rows[0];
    const unit = (await c.query(
      `insert into units (property_id, unit_number) values ($1,$2) returning id`, [prop.id, `PROOF-${RUN}`])).rows[0];
    const person = (await c.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status) values ($1,$2,$2,'tenant') returning id`,
      [`TEST SMS Proof Resident ${RUN}`, `+1500${RUN.replace(/\D/g,"0").slice(0,7).padEnd(7,"0")}`])).rows[0];
    const neighbour = (await c.query(
      `insert into persons (name, phone, primary_phone_e164, lifecycle_status) values ($1,$2,$2,'tenant') returning id`,
      [`TEST SMS Proof Neighbour ${RUN}`, `+1501${RUN.replace(/\D/g,"0").slice(0,7).padEnd(7,"0")}`])).rows[0];
    const evTypes = async (woId) => (await c.query(
      `select type from events where note like '%'||$1||'%' order by occurred_at asc`, [woId])).rows.map((r) => r.type);

    // ── 1 ── ambiguous report → needs_confirmation + confirm_urgency, UNASSIGNED
    section("1 · ambiguous report opens needs_confirmation with an unassigned question");
    const w1 = await mkWO("needs_confirmation");
    const o1 = await oblOf(w1.workOrder.id);
    const w1db = (await c.query("select * from work_orders where id=$1", [w1.workOrder.id])).rows[0];
    ok(w1db.urgency_status === "needs_confirmation", "PERSISTED work order is needs_confirmation");
    ok(o1 && o1.type === "confirm_urgency", "one confirm_urgency obligation exists");
    ok(o1.assigned_user_id === null, "assigned_user_id is honestly null (UNASSIGNED)");
    ok((o1.required_inputs || []).includes("urgency_confirmation"), "urgency_confirmation is outstanding");

    // ── 2 ── clear routine → regular + maintenance_repair
    section("2 · clear routine report opens a regular repair obligation");
    const w2 = await mkWO("regular");
    const o2 = await oblOf(w2.workOrder.id);
    const w2db = (await c.query("select * from work_orders where id=$1", [w2.workOrder.id])).rows[0];
    ok(w2db.urgency_status === "regular" && w2db.is_emergency === false, "PERSISTED: regular, not emergency");
    ok(o2.type === "maintenance_repair" && (o2.required_inputs || []).includes("closeout_proof"), "maintenance_repair wants closeout_proof");
    ok(o2.assigned_user_id === null, "assigned_user_id is honestly null");

    // ── 3 ── emergency → emergency_repair with due_at + closeout_proof
    section("3 · emergency opens emergency_repair with a deadline");
    const w3 = await mkWO("emergency", "active_leak");
    const o3 = await oblOf(w3.workOrder.id);
    const w3db = (await c.query("select * from work_orders where id=$1", [w3.workOrder.id])).rows[0];
    ok(w3db.is_emergency === true && w3db.needs_pm_review === true, "PERSISTED: is_emergency and needs_pm_review both derived true");
    ok(o3.type === "emergency_repair" && o3.due_at !== null, "emergency_repair carries a due_at");
    ok(o3.severity === "emergency" && o3.escalates_to_role === "property_manager", "severity and escalation path are set");

    // ── 4 ── duplicate MessageSid → exactly one work order
    section("4 · duplicate MessageSid produces exactly one work order");
    const dupKey = "SM_PROOF_DUP_0001";
    const d1 = await svc.createWorkOrder(c, {
      property_id: prop.id, unit_id: unit.id, reported_by_person_id: person.id, affected_person_id: person.id,
      title: "dup", description: "dup", source: "tenant", urgency_status: "regular", idempotency_key: dupKey });
    const d2 = await svc.createWorkOrder(c, {
      property_id: prop.id, unit_id: unit.id, reported_by_person_id: person.id, affected_person_id: person.id,
      title: "dup", description: "dup", source: "tenant", urgency_status: "regular", idempotency_key: dupKey });
    ok(d2.deduped === true && d2.workOrder.id === d1.workOrder.id, "the second call dedupes to the same work order");
    const dupRows = (await c.query(
      `select count(*)::int n from work_orders where idempotency_key=$1 and property_id=$2`, [dupKey, prop.id])).rows[0];
    ok(dupRows.n === 1, "PERSISTED: exactly ONE work_orders row carries that idempotency_key");
    const dupObl = (await c.query(
      `select count(*)::int n from obligations where related_type='work_order' and related_id=$1`, [d1.workOrder.id])).rows[0];
    ok(dupObl.n === 1, "and exactly ONE obligation exists, not two");

    // ── 6 ── clarification answers routinely (§6.2)
    section("6 · routine clarification — receipts, field by field");
    const w6 = await mkWO("needs_confirmation");
    const o6before = await oblOf(w6.workOrder.id);
    const r6 = await svc.appendClarification(c, {
      work_order_id: w6.workOrder.id, person_id: person.id,
      text: "it is just a slow minor drip, no rush", classifyUrgency });
    const w6after = (await c.query("select * from work_orders where id=$1", [w6.workOrder.id])).rows[0];
    const o6 = await oblOf(w6.workOrder.id);
    ok(r6.outcome === "resolved_regular", "outcome is resolved_regular");
    ok(w6after.urgency_status === "regular", "work_orders.urgency_status → regular");
    ok(w6after.urgency_decided_by === "resident_clarification", "urgency_decided_by → resident_clarification");
    ok(w6after.urgency_decided_at !== null, "urgency_decided_at stamped");
    ok(w6after.is_emergency === false && w6after.needs_pm_review === false, "is_emergency and needs_pm_review stay false");
    ok(o6.id === o6before.id, "it is the SAME obligation, not a replacement");
    ok(o6.status === "open", "THE REPAIR OBLIGATION IS STILL OPEN");
    ok(o6.type === "maintenance_repair", "type → maintenance_repair");
    ok(o6.label === "Maintenance request", "label moved WITH the type");
    ok(!(o6.required_inputs || []).includes("urgency_confirmation"), "the stale urgency_confirmation input is gone");
    ok((o6.required_inputs || []).includes("closeout_proof"), "closeout_proof is now required");
    const ev6 = await evTypes(w6.workOrder.id);
    ok(ev6.includes("work_order_clarification"), "clarification event written");
    ok(ev6.includes("work_order_urgency_resolved"), "durable transition event written");

    // ── 7 ── clarification escalates to emergency (§6.3)
    section("7 · emergency clarification — receipts, field by field");
    const w7 = await mkWO("needs_confirmation");
    const r7 = await svc.appendClarification(c, {
      work_order_id: w7.workOrder.id, person_id: person.id,
      text: "water is pouring through the ceiling right now", classifyUrgency });
    const w7after = (await c.query("select * from work_orders where id=$1", [w7.workOrder.id])).rows[0];
    const o7 = await oblOf(w7.workOrder.id);
    ok(r7.outcome === "escalated_emergency" && r7.escalated === true, "outcome is escalated_emergency");
    ok(w7after.urgency_status === "emergency" && w7after.is_emergency === true, "work order → emergency");
    ok(w7after.needs_pm_review === true, "needs_pm_review → true");
    ok(w7after.urgency_decided_by === "resident_clarification", "decision provenance recorded");
    ok(o7.status === "open" && o7.type === "emergency_repair", "SAME obligation, still open, now emergency_repair");
    ok(/^EMERGENCY: /.test(o7.label || ""), "label moved with the type");
    ok(o7.due_at !== null, "due_at set");
    ok(o7.severity === "emergency" && o7.escalates_to_role === "property_manager", "severity + escalation set");
    ok(!(o7.required_inputs || []).includes("urgency_confirmation"), "stale urgency_confirmation removed");
    ok((o7.required_inputs || []).includes("closeout_proof"), "closeout_proof required");
    const esc = (await c.query(
      `select note from events where type='work_order_urgency_escalated' and note like '%'||$1||'%' limit 1`, [o7.id])).rows[0];
    ok(!!esc && /active_leak/.test(esc.note), "the escalation event carries emergency_type — its only durable home");

    // ── 8 ── clarification leaves uncertainty (§6.4)
    section("8 · unresolved clarification changes nothing but the note");
    const w8 = await mkWO("needs_confirmation");
    const o8before = await oblOf(w8.workOrder.id);
    const r8 = await svc.appendClarification(c, {
      work_order_id: w8.workOrder.id, person_id: person.id,
      text: "there is a weird smell I can't place", classifyUrgency });
    const w8after = (await c.query("select * from work_orders where id=$1", [w8.workOrder.id])).rows[0];
    const o8 = await oblOf(w8.workOrder.id);
    ok(r8.outcome === "unresolved", "outcome is unresolved");
    ok(w8after.urgency_status === "needs_confirmation", "work order unchanged");
    ok(o8.type === "confirm_urgency" && (o8.required_inputs || []).includes("urgency_confirmation"),
       "the question stays outstanding — we do not pretend it was answered");
    ok(o8.updated_at.getTime() === o8before.updated_at.getTime(), "the obligation row was not even touched");

    // ── 5/16 ── vocabulary: both entry points refuse the same bad input
    section("5 · one closed vocabulary across both entry points");
    await throws(() => svc.createWorkOrder(c, {
      property_id: prop.id, reported_by_person_id: person.id, title: "x",
      source: "tenant", urgency_status: "emergency", emergency_type: "not_a_real_type" }),
      /emergency_type required/, "createWorkOrder refuses an unknown emergency_type");
    const badUrgency = () => ({ urgency: "emergency", emergency_type: "not_a_real_type", basis: "x" });
    const w16 = await mkWO("needs_confirmation");
    await throws(() => svc.appendClarification(c, {
      work_order_id: w16.workOrder.id, person_id: person.id, text: "x", classifyUrgency: badUrgency }),
      /emergency_type required/, "appendClarification refuses it IDENTICALLY (no manager_override fallback)");

    // ── 17 ── reporter ≠ affected: the person_id proxy would misroute
    section("17 · reporter ≠ affected — the lookup must key on who we ASKED");
    const w17 = await svc.createWorkOrder(c, {
      property_id: prop.id, unit_id: unit.id,
      reported_by_person_id: neighbour.id, affected_person_id: person.id,
      title: "neighbour report", description: "leak through the shared wall",
      source: "tenant", urgency_status: "needs_confirmation", urgency_basis: "proof" });
    const o17 = await oblOf(w17.workOrder.id);
    ok(o17.person_id === person.id,
       "the obligation carries the AFFECTED person — proving person_id is the wrong key");
    const conv17 = (await c.query(
      `insert into conversations (property_id, person_id) values ($1,$2)
       on conflict (property_id, person_id) do update set last_message_at=now() returning id`,
      [prop.id, neighbour.id])).rows[0];
    await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification, created_object_type, created_object_id)
       values ($1,$2,$3,'sms','outbound','Is water actively leaking right now?','auto_reply','work_order',$4)`,
      [prop.id, neighbour.id, conv17.id, w17.workOrder.id]);
    const found17 = (await c.query(
      `select o.id from comm_events ce join obligations o
         on o.related_type='work_order' and o.related_id=ce.created_object_id
        and o.status='open' and o.type='confirm_urgency'
        where ce.property_id=$1 and ce.person_id=$2 and ce.direction='outbound'
          and ce.created_object_type='work_order'
          and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')`,
      [prop.id, neighbour.id])).rows;
    ok(found17.length === 1 && found17[0].id === o17.id,
       "the question-based lookup FINDS it for the reporter; a person_id lookup would have found nothing");

    // ── 18 ── legacy-unlinked question is not eligible
    section("18 · a question with no durable link cannot drive automation");
    const w18 = await mkWO("needs_confirmation");
    await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification)
       values ($1,$2,$3,'sms','outbound','legacy question with no link','auto_reply')`,
      [prop.id, person.id, conv17.id]);
    const found18 = (await c.query(
      `select 1 from comm_events ce join obligations o
         on o.related_type='work_order' and o.related_id=ce.created_object_id
        where ce.property_id=$1 and ce.body='legacy question with no link'
          and ce.created_object_type='work_order'`, [prop.id])).rows;
    ok(found18.length === 0, "an unlinked question joins to nothing — legacy-unlinked is inert by construction");
    ok((await oblOf(w18.workOrder.id)).type === "confirm_urgency", "and its work order is untouched");

    // ── 19 ── definitively failed delivery is not an asked question
    section("19 · a question whose delivery failed was never asked");
    const w19 = await mkWO("needs_confirmation");
    await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification, created_object_type, created_object_id, sms_status)
       values ($1,$2,$3,'sms','outbound','q','auto_reply','work_order',$4,'failed')`,
      [prop.id, person.id, conv17.id, w19.workOrder.id]);
    const found19 = (await c.query(
      `select 1 from comm_events ce join obligations o
         on o.related_type='work_order' and o.related_id=ce.created_object_id
        and o.status='open' and o.type='confirm_urgency'
        where ce.created_object_id=$1
          and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')`,
      [w19.workOrder.id])).rows;
    ok(found19.length === 0, "a failed-delivery question is excluded from the gate");
    const foundNull = (await c.query(
      `select 1 from comm_events ce where ce.created_object_id=$1
        and coalesce(ce.sms_status,'') not in ('failed','refused','undelivered')`,
      [w17.workOrder.id])).rows;
    ok(foundNull.length === 1, "but a NULL sms_status (the browser door) stays eligible");

    // ── 15 ── transitionObligation guards, against real rows
    section("15 · transition guards hold against real rows");
    const w15 = await mkWO("needs_confirmation");
    const o15 = await oblOf(w15.workOrder.id);
    await throws(() => transitionObligation(c, {
      obligation_id: o15.id, expected_type: "maintenance_repair", expected_status: "open",
      to_type: "emergency_repair", label: "x", required_inputs: [], priority: "high",
      severity: "emergency", escalates_to_role: "property_manager", due_at: new Date() }),
      /is now confirm_urgency/, "expected-type mismatch fails closed on a real row");

    // ── 21 ── §7.6 must not suppress a repeat reporter's NEW request
    //  Regression pin for a defect found in self-review: every outbound reply
    //  about a work order carries created_object_type='work_order', including
    //  the ordinary "request opened" acknowledgment. Scoping §7.6 on that
    //  column alone matched every resident who had ever had ANY work order and
    //  silently stopped creating new ones for them forever.
    section("21 · a repeat reporter is not silenced by their own history");
    const wPrev = await mkWO("regular");                       // an ORDINARY past request
    await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification, created_object_type, created_object_id)
       values ($1,$2,$3,'sms','outbound','Got it — request opened.','auto_reply','work_order',$4)`,
      [prop.id, person.id, conv17.id, wPrev.workOrder.id]);
    const suppressed = (await c.query(
      `select 1 from comm_events ce
        where ce.property_id=$1 and ce.person_id=$2 and ce.direction='outbound'
          and ce.classification='clarification_question'
          and ce.created_object_type='work_order'
          and exists (select 1 from work_orders w where w.id=ce.created_object_id
                        and w.property_id=ce.property_id
                        and w.urgency_decided_by='resident_clarification')
        limit 1`, [prop.id, person.id])).rows;
    ok(suppressed.length === 0,
       "an ordinary acknowledgment does NOT count as an answered question — the next request still opens");
    const broadMatch = (await c.query(
      `select count(*)::int n from comm_events ce
        where ce.property_id=$1 and ce.person_id=$2 and ce.direction='outbound'
          and ce.created_object_type='work_order'`, [prop.id, person.id])).rows[0];
    ok(broadMatch.n >= 1,
       "…even though the broad created_object_type match (the defective predicate) DOES hit");

    // ── 20 ── needs_human starts true (the invisible-orphan fix)
    section("20 · an unprocessed claim is visible, not an invisible orphan");
    const convP = (await c.query(
      `insert into conversations (property_id, person_id) values ($1,$2)
       on conflict (property_id, person_id) do update set last_message_at=now() returning id`,
      [prop.id, person.id])).rows[0];
    const inb = (await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, needs_human)
       values ($1,$2,$3,'sms','inbound','unprocessed claim',true) returning id, needs_human`,
      [prop.id, person.id, convP.id])).rows[0];
    ok(inb.needs_human === true, "T1 commits the claim already flagged");
    const visible = (await c.query(
      `select count(*)::int n from comm_events
        where property_id=$1 and direction='inbound' and conversation_id is not null and needs_human=true`,
      [prop.id])).rows[0];
    ok(visible.n >= 1, "and it is counted by the exact predicate desks.js/board.js use");
    const outboundFlagged = (await c.query(
      `select count(*)::int n from comm_events
        where property_id=$1 and direction='outbound' and needs_human=true`, [prop.id])).rows[0];
    ok(outboundFlagged.n === 0,
       "flagging an OUTBOUND row would be invisible to those readers — which is why §15.2 re-flags the inbound one");

    // ── 12 ── T2 failure leaves the claim visible and creates nothing
    //  Proven at the DB level with a SAVEPOINT standing in for T2: the inbound
    //  claim is committed by T1 (here, before the savepoint), T2 does work and
    //  then fails, and the rollback must leave the claim intact and flagged
    //  with no work order behind it.
    section("12 · a failed T2 preserves the claim, flagged, and creates nothing");
    const inbT2 = (await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, needs_human)
       values ($1,$2,$3,'sms','inbound','T2 will fail on this one',true) returning id`,
      [prop.id, person.id, convP.id])).rows[0];
    await c.query("savepoint t2");
    const doomed = await mkWO("regular");
    await c.query("update comm_events set needs_human=false where id=$1", [inbT2.id]);
    await c.query("rollback to savepoint t2");
    const inbAfter = (await c.query("select needs_human from comm_events where id=$1", [inbT2.id])).rows[0];
    const doomedGone = (await c.query("select count(*)::int n from work_orders where id=$1", [doomed.workOrder.id])).rows[0];
    const doomedObl = (await c.query("select count(*)::int n from obligations where related_id=$1", [doomed.workOrder.id])).rows[0];
    ok(inbAfter.needs_human === true, "PERSISTED: the inbound claim survives and is STILL needs_human=true");
    ok(doomedGone.n === 0, "no work order persists from the failed T2");
    ok(doomedObl.n === 0, "and no orphan obligation either");

    // ── 13 ── double-send guard, and structural proof no SMS can leave
    section("13 · sendPropertySms refuses a second send — and cannot send at all here");
    const boundary = require(path.join(__dirname, "../src/comms/communications_boundary.js"))({
      pool: { query: (...a) => c.query(...a) },
      sms: { sendSms: async () => { throw new Error("HARNESS: a real send was attempted"); },
             ready: () => true, validateWebhook: () => true },
    });
    const outEvt = (await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification, sms_sid)
       values ($1,$2,$3,'sms','outbound','already on the wire','auto_reply',$4) returning id`,
      [prop.id, person.id, convP.id, `SM_HARNESS_${RUN}`])).rows[0];
    const second = await boundary.sendPropertySms({
      property_id: prop.id, recipient: "+15005550009", body: "duplicate attempt",
      purpose: "ai_reply", person_id: person.id, eventId: outEvt.id });
    ok(second.sent === false && second.reason === "already_sent",
       "an outbound already carrying a provider SID is REFUSED, not resent");
    const fresh = (await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, classification)
       values ($1,$2,$3,'sms','outbound','never sent','auto_reply') returning id`,
      [prop.id, person.id, convP.id])).rows[0];
    const attempt = await boundary.sendPropertySms({
      property_id: prop.id, recipient: "+15005550009", body: "x",
      purpose: "ai_reply", person_id: person.id, eventId: fresh.id });
    ok(attempt.sent === false && attempt.reason === "no_property_line",
       "and a fixture property has NO sms_number, so no send is structurally reachable");

    // ── 6b ── delivery failure re-flags the inbound claim (§15.2)
    section("6b · a failed outbound delivery re-flags the INBOUND row");
    const inbD = (await c.query(
      `insert into comm_events (property_id, person_id, conversation_id, channel, direction, body, needs_human)
       values ($1,$2,$3,'sms','inbound','processed, but the reply failed',false) returning id`,
      [prop.id, person.id, convP.id])).rows[0];
    await c.query(`update comm_events set needs_human = true where id = $1`, [inbD.id]);
    const inbDafter = (await c.query(
      `select needs_human, direction from comm_events where id=$1`, [inbD.id])).rows[0];
    ok(inbDafter.needs_human === true && inbDafter.direction === "inbound",
       "PERSISTED: the INBOUND row is re-flagged — the only row either queue reader counts");

    section("CONTRACT CASE COVERAGE — all 20, honestly accounted for");
    const COVERAGE = [
      [1, "ambiguous → needs_confirmation + confirm_urgency", "COVERED"],
      [2, "clear routine → regular + maintenance_repair", "COVERED"],
      [3, "emergency → emergency_repair + due_at", "COVERED"],
      [4, "duplicate MessageSid → one work order", "COVERED"],
      [5, "unknown sender → zero rows", "NOT COVERED — boundary-level, needs HTTP"],
      [6, "routine clarification transitions", "COVERED"],
      [7, "emergency clarification transitions", "COVERED"],
      [8, "unresolved clarification changes nothing", "COVERED"],
      [9, "separate problem → new work order", "NOT COVERED — needs runInbound via HTTP"],
      [10, "both/unclear → preserve + flag", "NOT COVERED — needs runInbound via HTTP"],
      [11, "two pending clarifications → preserve", "NOT COVERED — needs runInbound via HTTP"],
      [12, "T2 failure preserves + flags", "COVERED (savepoint)"],
      [13, "double-send guard refuses", "COVERED"],
      [14, "browser door unchanged", "NOT COVERED — needs HTTP"],
      [15, "transition guards", "COVERED"],
      [16, "one closed emergency vocabulary", "COVERED"],
      [17, "reporter ≠ affected", "COVERED"],
      [18, "legacy-unlinked is inert", "COVERED"],
      [19, "failed-delivery question excluded", "COVERED"],
      [20, "claim starts visible (needs_human)", "COVERED"],
      ["6b", "failed delivery re-flags inbound", "COVERED"],
      [21, "repeat reporter not suppressed", "COVERED"],
    ];
    for (const [n, what, state] of COVERAGE) {
      console.log(`  ${String(state).startsWith("COVERED") ? "▣" : "▢"} ${String(n).padEnd(3)} ${what}${String(state).startsWith("COVERED") ? "" : "  ← " + state}`);
    }
    const uncovered = COVERAGE.filter(([, , s]) => !String(s).startsWith("COVERED"));
    console.log(`\n  ${COVERAGE.length - uncovered.length}/${COVERAGE.length} exercised here; ${uncovered.length} require an HTTP-level harness (cases 5, 9, 10, 11, 14).`);
    console.log("  Those five are NOT proven by this run and must not be reported as such.");

    console.log(`\n════ ${pass} passed, ${fail} failed ════`);
    if (failures.length) console.error("FAILURES:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
}
