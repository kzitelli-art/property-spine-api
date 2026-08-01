// ════════════════════════════════════════════════════════════════════
//  DB-BACKED TEST — leasing conversion rail (the contract's required proof set)
//
//  Runs the REAL module service layer against a REAL Postgres instance with
//  the REAL obligation engine (extracted verbatim from server.js) and the REAL
//  migration 047. No in-memory simulation. Each scenario is a transaction.
//
//  Run:  DATABASE_URL=... node test_conversion_rail.db.js
// ════════════════════════════════════════════════════════════════════
const receipt = require("./_run_receipt.js");
const { Pool } = require("pg");
const engine = require("./_engine.js");
const buildModule = require("../src/leasing/leasingconversion.js");
// THE CLOSURE AUTHORITY. leasingconversion.js fails CLOSED without it
// (leasingconversion.js:35-37) — and this harness was not passing it, so it
// threw at BUILD time and no assertion in this file had run for as long as
// that guard has existed. Mounted here exactly as server.js:3284 mounts it.
const { createConversionClosureAuthority } = require("../src/leasing/conversion_obligation_closure.js");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Mount the module to get its service layer (router._service), injecting the
// REAL engine functions exactly as server.js does.
const router = buildModule({
  pool,
  spawnObligationFromEvent: engine.spawnObligationFromEvent,
  completeObligation: engine.completeObligation,
  closureAuthority: createConversionClosureAuthority(),
});
const svc = router._service;

// ── tiny test harness ──
let pass = 0, fail = 0;
function ok(label) { console.log("  PASS  " + label); pass++; }
function bad(label, e) { console.log("  FAIL  " + label + "  →  " + (e && e.message || e)); fail++; }
async function T(label, fn) { try { await fn(); ok(label); } catch (e) { bad(label, e); } }
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}
// reads need no transaction; use a fresh client each time to avoid any nested-tx state.
async function read(fn) {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}
async function expectThrow(fn, frag) {
  try { await fn(); } catch (e) {
    if (!frag || (e.message || "").includes(frag)) return;
    throw new Error(`threw but not "${frag}": ${e.message}`);
  }
  throw new Error(`expected a throw containing "${frag}"`);
}

// ── seed: real rows in the real tables (a property, three staff users, a prospect) ──
let ctx = {};
async function seed() {
  await tx(async (c) => {
    const prop = (await c.query(
      `insert into properties (name) values ('Solo on Chestnut') returning id`
    )).rows[0];
    // users table: insert minimal — discover its required columns first.
    // baseline users has at least id, name, role likely. Use name only + role if needed.
    // ── ELIGIBLE STAFF, built through the SAME chain production requires ──
    //  resolveStaffIdentity returns "resolved" only for a user that is:
    //    1. active + status active + account_kind 'human_staff'
    //    2. BRIDGED to a durable person (users.person_id)
    //    3. holding an ACTIVE assignments row at this property
    //    4. holding an ACTIVE property_team_assignments row — the authority
    //       VETO added 2026-07-26: an owner must be able to do the work
    //    5. unconflicted (exactly one active user per person)
    //
    //  The old mkUser created ONLY a bare users row, so every "host" in this
    //  file was an attributed CLAIM and never an eligible OWNER. That is why
    //  scenario 4 expected Katie to own the rung and production honestly
    //  refused: attribution does not confer operating authority. Nothing about
    //  the resolver is bypassed or weakened here — the fixture now supplies the
    //  real thing.
    async function mkUser(name, { eligible = true } = {}) {
      const person = (await c.query(
        `insert into persons (name, lifecycle_status) values ($1,'lead') returning id`, [name])).rows[0].id;
      const uid = (await c.query(
        `insert into users (name, role, person_id, account_kind, is_active, status)
         values ($1,'leasing_agent',$2,'human_staff',true,'active') returning id`,
        [name, person])).rows[0].id;
      if (!eligible) return uid;   // deliberately attribution-only — see scenario 4b
      await c.query(
        `insert into assignments (person_id, property_id, role, is_active)
         values ($1,$2,'leasing_agent',true)`, [person, prop.id]);
      await c.query(
        `insert into property_team_assignments (property_id, user_id, role_title, allowed_modules, active)
         values ($1,$2,'Leasing Agent', array['leasing'], true)`, [prop.id, uid]);
      return uid;
    }
    ctx.property_id = prop.id;
    ctx.katie  = await mkUser("Katie Leung");     // actual host in most scenarios
    ctx.warren = await mkUser("Warren Diaz");      // scheduled host
    ctx.candace= await mkUser("Candace Riley");    // handoff successor
    ctx.olivia = await mkUser("Olivia Grant");     // leasing manager (gate)
    // Scenario 4b's host: a real, active, bridged staff account that holds NO
    // assignment at this property. Attributable, not authorised.
    ctx.drew  = await mkUser("Drew Halloran", { eligible: false });
    const person = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Ava Morgan','lead') returning id`
    )).rows[0];
    ctx.person_id = person.id;
    // a second prospect for the no-host-confirmation scenario
    ctx.person2_id = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Marcus Webb','lead') returning id`
    )).rows[0].id;
    // a third prospect, toured by the ineligible host (scenario 4b)
    ctx.person3_id = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Priya Raman','lead') returning id`
    )).rows[0].id;
    const tour = (await c.query(
      // leasing_tours.lead_id is NOT NULL in the real schema (migration 038) — a
      // tour belongs to a lead. Create the lead first and link it.
      `insert into leasing_leads (person_id, property_id, status) values ($1,$2,'tour_scheduled') returning id`,
      [ctx.person_id, ctx.property_id]
    )).rows[0];
    ctx.lead_id = tour.id;
    const realTour = (await c.query(
      `insert into leasing_tours (lead_id, property_id, status) values ($1,$2,'completed') returning id`,
      [ctx.lead_id, ctx.property_id]
    )).rows[0];
    ctx.tour_id = realTour.id;
  });
}

async function main() {
  receipt.begin(__filename);
  console.log("\n══════════ CONVERSION RAIL — DB-BACKED PROOF (real Postgres) ══════════\n");
  await seed();

  // ── 1. completed tour with NO confirmed actual host cannot create a record ──
  await T("1 · no actual host → conversion record refused (INCOMPLETE)", async () => {
    await expectThrow(() => tx(c => svc.createConversionFromTour(c, {
      person_id: ctx.person2_id, property_id: ctx.property_id, origin_tour_id: ctx.tour_id,
      scheduled_tour_host_user_id: ctx.warren, /* actual_tour_host_user_id MISSING */
    })), "INCOMPLETE");
    // and nothing was written
    const n = (await pool.query(`select count(*)::int c from leasing_conversions where person_id=$1`, [ctx.person2_id])).rows[0].c;
    assert(n === 0, "a record was written despite missing host");
  });

  // Create the canonical record: scheduled = Warren, ACTUAL = Katie.
  let conv, firstObId;
  await T("2 · scheduled host (Warren) and actual host (Katie) may differ; both preserved", async () => {
    const out = await tx(c => svc.createConversionFromTour(c, {
      person_id: ctx.person_id, property_id: ctx.property_id, origin_tour_id: ctx.tour_id,
      scheduled_tour_host_user_id: ctx.warren,
      actual_tour_host_user_id: ctx.katie,
      feedback_recorded_by_user_id: ctx.katie,
      tour_outcome: "interested",
      tour_notes: "Lit up at the rooftop; parents worried about Broad St noise. Serious for Aug.",
    }));
    conv = out.conversion;
    assert(conv.scheduled_tour_host_user_id === ctx.warren, "scheduled host not Warren");
    assert(conv.actual_tour_host_user_id === ctx.katie, "actual host not Katie");
    assert(conv.scheduled_tour_host_user_id !== conv.actual_tour_host_user_id, "should differ");
  });

  // ── 3. actual host becomes the initial conversation owner ──
  await T("3 · actual host (Katie) is the initial conversation owner", async () => {
    assert(conv.conversation_owner_user_id === ctx.katie, "owner should be actual host Katie");
  });

  // ── 4. a tour_followup obligation is created and linked to that owner ──
  await T("4 · tour_followup obligation created + linked to Katie", async () => {
    const view = await read(c => svc.readConversion(c, conv.id));
    const tf = view.rungs.find(r => r.rung === "tour_followup");
    assert(tf, "no tour_followup rung");
    assert(tf.owner_user_id === ctx.katie, "rung owner not Katie");
    assert(tf.obligation_status === "open", "obligation not open");
    // and it's a real row in the shared obligations table
    const ob = (await pool.query(`select * from obligations where id=$1`, [tf.obligation_id])).rows[0];
    assert(ob && ob.module === "leasing" && ob.type === "tour_followup", "obligation not in shared table");
    firstObId = tf.obligation_id;
    // history origin row present
    assert(view.ownership_history[0].kind === "origin" && view.ownership_history[0].to_user_id === ctx.katie, "no origin history");
  });

  // ── 4b. THE OTHER HALF OF THE SAME RULE: attribution without authority ──
  //  Scenario 4 proves an ELIGIBLE actual host becomes the owner. This proves
  //  the converse, which is the rule that actually protects the board: a host
  //  who really did give the tour but holds no active assignment at this
  //  property is still ATTRIBUTED the tour — and the follow-up is left honestly
  //  UNASSIGNED rather than handed to him, or quietly reassigned to some other
  //  staff member the system happens to know about.
  //
  //  Drew is the ONLY candidate here (no scheduled host is supplied), so there
  //  is nothing legitimate to fall back to. If anything but null appears as the
  //  rung owner, ownership was invented.
  await T("4b · ineligible actual host → attribution kept, obligation honestly UNASSIGNED, no invented owner", async () => {
    const out = await tx(c => svc.createConversionFromTour(c, {
      person_id: ctx.person3_id, property_id: ctx.property_id, origin_tour_id: ctx.tour_id,
      actual_tour_host_user_id: ctx.drew,
      feedback_recorded_by_user_id: ctx.drew,
      tour_outcome: "interested",
    }));
    const dc = out.conversion;

    // ATTRIBUTION SURVIVES. The record still says who gave the tour.
    assert(dc.actual_tour_host_user_id === ctx.drew, "actual host attribution was dropped for an ineligible user");
    const hist = (await pool.query(
      `select * from leasing_conversation_handoffs where conversion_id=$1 order by created_at`, [dc.id])).rows;
    assert(hist[0] && hist[0].kind === "origin" && hist[0].to_user_id === ctx.drew,
      "origin history must still name the person who gave the tour");

    // AUTHORITY DOES NOT. The rung is unowned.
    const view = await read(c => svc.readConversion(c, dc.id));
    const tf = view.rungs.find(r => r.rung === "tour_followup");
    assert(tf, "no tour_followup rung");
    assert(tf.owner_user_id === null,
      `rung must be UNASSIGNED; got owner ${tf.owner_user_id}`);
    for (const [who, id] of [["Katie", ctx.katie], ["Warren", ctx.warren],
                             ["Candace", ctx.candace], ["Olivia", ctx.olivia], ["Drew", ctx.drew]]) {
      assert(tf.owner_user_id !== id, `ownership was invented — rung fell through to ${who}`);
    }
    const ob = (await pool.query(`select * from obligations where id=$1`, [tf.obligation_id])).rows[0];
    assert(ob.assigned_user_id === null, "obligation carries an assigned user despite no eligible owner");
    assert(ob.status === "open", "the unowned obligation must still be OPEN and visible, not hidden");

    // THE LEDGER SAYS SO IN ITS OWN WORDS — 'unassigned' is recorded as a
    // deliberate state, not left as an absent field nobody wrote.
    const ev = (await pool.query(
      `select * from leasing_conversion_obligation_events
        where conversion_obligation_id=$1 and event_type='created'`, [tf.id])).rows[0];
    assert(ev, "no birth event written for the unowned rung");
    assert(ev.next_owner_user_id === null, "birth event names an owner the rung does not have");
    assert(ev.owner_eligibility_state === "unassigned",
      `birth event eligibility should be 'unassigned'; got ${ev.owner_eligibility_state}`);
    assert(ev.ownership_origin === null,
      `an unowned rung has no ownership origin; got ${ev.ownership_origin}`);

    // ── PINNED, NOT ENDORSED — an open question this scenario exposes ──
    //  leasingconversion.js:274 writes conversation_owner_user_id from
    //  actual_tour_host_user_id VERBATIM, without passing it through
    //  eligibleOwner. So on this row the conversion says "Drew owns the
    //  conversation" while the obligation it spawned says UNASSIGNED. Two
    //  fields describing one thing, disagreeing.
    //
    //  That may be intentional (the field is the relationship's attribution
    //  anchor, and handoffConversation reads it as "from") or it may be a
    //  confident-wrong owner on an operator surface. Deciding is an authority
    //  ruling, not a test change, so nothing in the product is touched here.
    //  The value is PINNED so the answer cannot change silently.
    assert(dc.conversation_owner_user_id === ctx.drew,
      `conversation_owner_user_id changed behaviour: expected the verbatim actual host (${ctx.drew}), got ${dc.conversation_owner_user_id} — re-open the ownership-vs-attribution ruling before editing this line`);
  });

  // ── 6 (run before 5 to test absence on the untouched owner): owner absence does NOT silently transfer ──
  await T("6 · owner absence flags handoff_required; owner is NOT silently transferred", async () => {
    const before = (await pool.query(`select conversation_owner_user_id from leasing_conversions where id=$1`, [conv.id])).rows[0];
    await tx(c => svc.flagHandoffRequired(c, { conversion_id: conv.id }));
    const after = (await pool.query(`select conversation_owner_user_id, handoff_required from leasing_conversions where id=$1`, [conv.id])).rows[0];
    assert(after.handoff_required === true, "handoff_required not set");
    assert(after.conversation_owner_user_id === before.conversation_owner_user_id, "owner was silently changed by absence");
    assert(after.conversation_owner_user_id === ctx.katie, "owner should still be Katie");
  });

  // ── 5. explicit handoff changes the owner while preserving original tour host ──
  await T("5 · explicit handoff Katie→Candace; owner changes, original host preserved, history records the transfer", async () => {
    await tx(c => svc.handoffConversation(c, {
      conversion_id: conv.id, from_user_id: ctx.katie, to_user_id: ctx.candace, by_user_id: ctx.katie,
      reason: "vacation coverage",
    }));
    const view = await read(c => svc.readConversion(c, conv.id));
    assert(view.conversion.conversation_owner_user_id === ctx.candace, "owner not Candace");
    assert(view.conversion.actual_tour_host_user_id === ctx.katie, "original tour host must remain Katie");
    assert(view.conversion.handoff_required === false, "handoff_required not cleared by naming a successor");
    const last = view.ownership_history[view.ownership_history.length - 1];
    assert(last.kind === "handoff" && last.from_user_id === ctx.katie && last.to_user_id === ctx.candace, "transfer not in history");
    // the OPEN tour_followup rung moved to Candace
    const tf = view.rungs.find(r => r.rung === "tour_followup");
    assert(tf.owner_user_id === ctx.candace, "open rung did not move to new owner");
  });

  // reject handoff to nobody
  await T("5b · handoff with no named successor is rejected", async () => {
    await expectThrow(() => tx(c => svc.handoffConversation(c, { conversion_id: conv.id, to_user_id: null })), "named successor");
  });

  // ── 7. completing a follow-up writes durable KEPT proof ──
  let secondObId;
  await T("7 · completing tour_followup writes durable kept proof; rung immutable", async () => {
    const out = await tx(c => svc.resolveRung(c, {
      obligation_id: firstObId, result: "completed", by_user_id: ctx.candace,
      proof: { kind: "message_sent", channel: "sms", summary: "Sent rooftop options + app link." },
    }));
    assert(out.outcome === "kept" && out.resolution === "completed", "not kept/completed");
    const link = (await pool.query(`select * from leasing_conversion_obligations where obligation_id=$1`, [firstObId])).rows[0];
    assert(link.outcome === "kept", "outcome not persisted kept");
    assert(link.proof && JSON.parse(JSON.stringify(link.proof)).kind === "message_sent", "proof not stored");
    assert(link.closed_at != null, "closed_at not set");
    // a durable event was written by the shared engine
    const ev = (await pool.query(`select count(*)::int c from events where type='obligation_completed'`)).rows[0].c;
    assert(ev >= 1, "no durable completion event");
    // advancing happened (assertion 9 verifies non-mutation)
    assert(out.spawned === "applicant_followup", "did not spawn applicant_followup");
  });

  // ── 9. advancing creates a NEW child without overwriting the prior one ──
  await T("9 · advancing spawned applicant_followup; tour_followup row + proof survive intact", async () => {
    const view = await read(c => svc.readConversion(c, conv.id));
    const tf = view.rungs.find(r => r.rung === "tour_followup");
    const af = view.rungs.find(r => r.rung === "applicant_followup");
    assert(tf && af, "expected both rungs to exist");
    assert(tf.outcome === "kept" && tf.resolution === "completed", "tour_followup history lost");
    assert(tf.proof != null, "tour_followup proof lost on advance");
    assert(af.outcome == null && af.obligation_status === "open", "applicant_followup not freshly open");
    assert(af.obligation_id !== tf.obligation_id, "new rung is not a distinct obligation");
    assert(af.owner_user_id === ctx.candace, "new rung owner not current conversation owner");
    secondObId = af.obligation_id;
  });

  // ── 8. a crossed due window writes durable MISSED proof (no advance) ──
  await T("8 · crossed window with no action → durable missed proof, no further advance", async () => {
    // Resolve the applicant rung as missed (simulating a window sweep result).
    const before = (await read(c => svc.readConversion(c, conv.id))).rungs.length;
    const out = await tx(c => svc.resolveRung(c, { obligation_id: secondObId, result: "missed" }));
    assert(out.outcome === "missed" && out.resolution === "missed", "not missed");
    const link = (await pool.query(`select * from leasing_conversion_obligations where obligation_id=$1`, [secondObId])).rows[0];
    assert(link.outcome === "missed" && link.closed_at != null, "missed not persisted");
    const after = (await read(c => svc.readConversion(c, conv.id))).rungs.length;
    assert(after === before, "missed must not spawn the next rung");
    // obligation left the open queue
    const ob = (await pool.query(`select status from obligations where id=$1`, [secondObId])).rows[0];
    assert(ob.status === "missed", "obligation not marked missed");
  });

  // ── 10. a manager/PM gate can coexist with the tour host's conversation obligation ──
  await T("10 · a leasing-manager gate coexists with the conversation; separate owner", async () => {
    // open a fresh conversation so it has a live conversation rung, then add a gate alongside.
    const fresh = await tx(c => svc.createConversionFromTour(c, {
      person_id: ctx.person2_id, property_id: ctx.property_id, origin_tour_id: ctx.tour_id,
      actual_tour_host_user_id: ctx.katie, feedback_recorded_by_user_id: ctx.katie, tour_outcome: "interested",
    }));
    const fc = fresh.conversion;
    await tx(c => svc.addGate(c, { conversion_id: fc.id, rung: "application_approval", owner_user_id: ctx.olivia }));
    const view = await read(c => svc.readConversion(c, fc.id));
    const conversationRung = view.rungs.find(r => r.rung === "tour_followup");
    const gate = view.rungs.find(r => r.rung === "application_approval");
    assert(conversationRung && conversationRung.obligation_status === "open", "conversation rung missing/closed");
    assert(gate && gate.obligation_status === "open", "gate not created");
    assert(conversationRung.owner_user_id === ctx.katie, "conversation owner should be the host (Katie)");
    assert(gate.owner_user_id === ctx.olivia, "gate owner should be the leasing manager (Olivia)");
    assert(gate.owner_role === "leasing_manager", "gate role not stamped");
    // the two coexist: host pushes the relationship while the manager owns the decision
    assert(conversationRung.obligation_id !== gate.obligation_id, "gate and conversation should be distinct obligations");
  });

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  ${pass} / ${pass + fail} scenarios passed`);
  console.log("──────────────────────────────────────────────────────────────");

  await pool.end();
  // expectedAtLeast is the real guard: this harness ran ZERO assertions for
  // 204 commits and reported nothing at all. A run that executes fewer
  // scenarios than the rail defines is INVALID, not merely quiet.
  process.exitCode = receipt.complete({
    harness: __filename, passed: pass, failed: fail, expectedAtLeast: 12,
  });
}

main().catch((e) => {
  // The defect this harness suffered was PRE-ASSERTION DEATH: it threw at
  // construction and printed nothing an eye would flag. A crash now reports
  // itself in the same vocabulary as a failed run, and says plainly that zero
  // assertions executed.
  console.error("\n════════════════════════════════════════════════════════════════");
  console.error("  ✗ RUN INVALID — the harness died before completing its assertions.");
  console.error("    Assertions executed: " + (pass + fail) + "  (a run that proves nothing)");
  console.error("    Cause: " + (e && e.message ? e.message : e));
  console.error("════════════════════════════════════════════════════════════════\n");
  process.exitCode = 1;
});
