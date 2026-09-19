/* ════════════════════════════════════════════════════════════════════
   vacated_position_basis.db.js — A GOVERNED MOVE-OUT IS A VACANCY FACT.

   Found by the operating-loop audit (CURRENT_STATE row 150): a resident
   leaves through Spine's own move-out door, the turn closes, and the
   position can never be offered again. positionBasis could establish
   vacancy from exactly one thing — an accepted opening claim of `vacant`
   — and evidenceState treated an `occupied` opening claim with no lease as
   `uncorroborated` no matter what happened after the claim's date. So:

       opening claim occupied  →  "Occupied" from the stale claim, forever
       no opening claim        →  "occupancy unknown", forever

   The owned Greenery copy has 95 active leases, 0 possession events and 0
   turnovers. Its first real move-out lands in the first state.

   THE RULE THIS PINS: a turnover that NAMES this position's outgoing lease
   is a governed later fact. It establishes vacancy
   (basis `turnover_recorded_move_out`), it governs an older `occupied`
   opening claim (evidence `governed_by_later_fact`), and the tenancy axis
   reads `vacant`. Vacancy is still evaluated LAST: a current lease,
   a commenced lease, recorded possession and an unreconciled claim all
   still win; a lease merely EXPIRING establishes nothing; a turn opened
   without an outgoing lease establishes nothing; a NEWER opening claim
   wins over an older door; and a move-out on bed 1 says nothing about
   bed 2.

   Synthetic, in the caller-owned proof database, through the REAL
   turnover writer and the REAL turn closer. Nothing outside the scratch
   properties is touched.

   Run:      node tests/proofs/vacated_position_basis.db.js
   Witness:  PROOF_EXPECT_DEFECT=1 PROOF_BUSINESS_ROOT=<parent worktree> node …
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const { datedPropertyPositions } = require(path.join(root, "src/tenancy/dated_positions.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const { recordEffectivePossession } = require(path.join(root, "src/tenancy/space_position.js"));
const engine = require(path.join(root, "src/shared/obligation_engine.js"));
const { makeUnitTriageService } = require(path.join(root, "src/maintenance/unit_triage_service.js"));
const { makeTurnoverService } = require(path.join(root, "src/maintenance/turnover_service.js"));
const { closeActiveTurnoversForReadiness } = require(path.join(root, "src/maintenance/readiness_service.js"));

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => ymd(Date.now() + n * DAY);

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const tag = `vacated-basis-${randomUUID().slice(0, 8)}`;

  const unitTriageService = makeUnitTriageService({ spawnObligationFromEvent: engine.spawnObligationFromEvent });
  const turnoverService = makeTurnoverService({
    spawnObligationFromEvent: engine.spawnObligationFromEvent, recordEffectivePossession, unitTriageService });

  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const pm = await one(`insert into users(name,email,role,is_active,status,account_kind,organization_id)
    values('Vacated Basis Manager',$1,'property_manager',true,'active','internal_qa',$2) returning id`, [tag + "@example.invalid", org.id]);
  const person = (await one("insert into persons(name,lifecycle_status) values('Vacated Basis Resident','tenant') returning id")).id;

  //  One scratch property with an opening position; a second one so a
  //  NEWER opening claim can be tested without moving the first's baseline.
  async function property(name) {
    const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
      values('existing_asset','classified',$1,$2) returning id`, [name, org.id]);
    const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'unit') returning id`, [name, org.id]);
    await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, p.id]);
    await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,active)
      values($1,$2,'Property Manager','property','{management,maintenance}','{management}',true)`, [p.id, pm.id]);
    return { id: p.id, deal_id: deal.id };
  }
  async function unit(P, n, { beds = 1 } = {}) {
    const u = (await one("insert into units(property_id,unit_number) values($1,$2) returning id", [P, n])).id;
    const auto = (await one("update spaces set use_type='residential', position_kind='unit' where unit_id=$1 returning id", [u])).id;
    const spaces = [auto];
    if (beds > 1) {
      await pool.query("update spaces set space_label='Bed 1', position_kind='bed' where id=$1", [auto]);
      for (let i = 2; i <= beds; i++) {
        spaces.push((await one("insert into spaces(unit_id,space_label,position_kind,use_type) values($1,$2,'bed','residential') returning id", [u, `Bed ${i}`])).id);
      }
    }
    return { unit_id: u, spaces };
  }
  //  An established opening position: claims is [{unit_number, space_id, tenant_name|null}]
  async function opening(P, deal_id, asOf, claims) {
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger','vacated.csv',$2,'unit','confirmed','committed') returning id`, [P, asOf]);
    const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
      values($1,$2,'activated',$3,$4,$5) returning id`, [deal_id, P, asOf, batch.id, pm.id]);
    let ix = 0;
    for (const c of claims) {
      ix += 1;
      const key = c.room ? `${c.unit_number}|${c.room}` : c.unit_number;
      const unitId = (await one("select unit_id from spaces where id=$1", [c.space_id])).unit_id;
      const raw = { unit_number: c.unit_number, room: c.room || null, tenant_name: c.tenant_name, is_vacant: !c.tenant_name };
      const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
        values($1,$2,$3,'vacated basis evidence',$4,$5) returning id`, [batch.id, ix, JSON.stringify(raw), unitId, c.space_id]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
        [act.id, P, key, JSON.stringify({ section: "current", unit_number: c.unit_number, room: c.room || null, tenant_name: c.tenant_name, is_vacant: !c.tenant_name }), ev.id, String(pm.id)]);
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
      positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
      values($1,$2,$3,$4,$5,$6,0,$6,$7,'platform_role:super_admin','established')`, [P, deal_id, act.id, batch.id, asOf, claims.length, pm.id]);
  }
  async function lease(P, space_id, { start = D(-400), end = D(-1) } = {}) {
    return (await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,source_type,confidence)
      values($1,$2,$3,1200,$4,$5,'active','historical_snapshot','confirmed') returning id`, [P, space_id, [person], start, end])).id;
  }
  async function moveOut(P, unit_id, outgoing_lease_id, { close = true } = {}) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await turnoverService.openTurnover(c, { property_id: P, unit_id, outgoing_lease_id,
        needs: ["clean"], expected_ready_date: D(10), actor_user_id: pm.id });
      let closed = [];
      if (close) closed = await closeActiveTurnoversForReadiness(c, { property_id: P, unit_id });
      await c.query("commit");
      return { turnover: out.turnover, closed };
    } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  const read = async (P, asOf = null) => {
    const dp = await datedPropertyPositions(pool, { property_id: P, as_of: asOf });
    const av = await availabilityRead(pool, { property_id: P, as_of: asOf });
    const by = {};
    for (const p of dp.positions) {
      const row = av.rows.find((r) => String(r.space_id) === String(p.space_id));
      by[String(p.space_id)] = { ...p, marketing_state: row.marketing_state, blocking_reason: row.blocking_reason };
    }
    return by;
  };
  const line = (x) => `bucket=${x.bucket} tenancy=${x.tenancy_state} basis=${x.basis_state}/${x.basis_type} evidence=${x.evidence_state} avail=${x.marketing_state}/${x.blocking_reason}`;

  try {
    const A = await property(tag);
    const P = A.id;
    const u201 = await unit(P, "201");   // opening occupied, no possession event (the Greenery shape)
    const u202 = await unit(P, "202");   // no opening claim, possession recorded
    const u203 = await unit(P, "203");   // control: lease merely expired, no door
    const u205 = await unit(P, "205");   // control: turn-only door, no outgoing lease
    const u206 = await unit(P, "206", { beds: 2 }); // control: bed 1 moves out, bed 2 untouched
    const u207 = await unit(P, "207");   // door opened, turn still in progress
    await opening(P, A.deal_id, D(-60), [
      { unit_number: "201", space_id: u201.spaces[0], tenant_name: "Resident 201" },
      { unit_number: "203", space_id: u203.spaces[0], tenant_name: "Resident 203" },
      { unit_number: "205", space_id: u205.spaces[0], tenant_name: "Resident 205" },
      { unit_number: "206", room: "Bed 1", space_id: u206.spaces[0], tenant_name: "Resident 206a" },
      { unit_number: "206", room: "Bed 2", space_id: u206.spaces[1], tenant_name: "Resident 206b" },
      { unit_number: "207", space_id: u207.spaces[0], tenant_name: "Resident 207" },
    ]);
    const L = {};
    L[201] = await lease(P, u201.spaces[0]);
    L[202] = await lease(P, u202.spaces[0]);
    L[203] = await lease(P, u203.spaces[0]);
    L[205] = await lease(P, u205.spaces[0]);
    L["206a"] = await lease(P, u206.spaces[0]);
    L[207] = await lease(P, u207.spaces[0]);
    for (const [uu, l] of [[u202, L[202]], [u206, L["206a"]]]) {
      await recordEffectivePossession(pool, { kind: "move_in", lease_id: l, unit_id: uu.unit_id, property_id: P,
        effective_date: D(-400), actor: pm.id, source: "vacated_basis_fixture", space_id_hint: uu.spaces[0] });
    }

    console.log("\n== before any door: the dead ends as the audit found them ==");
    let by = await read(P);
    ok("201 before: opening claim occupied, lease ended → Occupied from the stale claim",
      by[u201.spaces[0]].bucket === "occupied" && by[u201.spaces[0]].evidence_state === "uncorroborated", line(by[u201.spaces[0]]));
    ok("202 before: possession still recorded → not offered (possession_not_returned)",
      by[u202.spaces[0]].marketing_state === "not_ready", line(by[u202.spaces[0]]));

    console.log("\n== the door: move-out recorded, turn closed ==");
    await moveOut(P, u201.unit_id, L[201]);
    await moveOut(P, u202.unit_id, L[202]);
    await moveOut(P, u206.unit_id, L["206a"]);
    const t207 = await moveOut(P, u207.unit_id, L[207], { close: false });
    //  Turn-only door on 205: no outgoing lease named.
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await turnoverService.openTurnover(c, { property_id: P, unit_id: u205.unit_id, outgoing_lease_id: null,
          needs: ["clean"], actor_user_id: pm.id });
        await closeActiveTurnoversForReadiness(c, { property_id: P, unit_id: u205.unit_id });
        await c.query("commit");
      } finally { c.release(); }
    }
    by = await read(P);
    const a = by[u201.spaces[0]], b = by[u202.spaces[0]], c3 = by[u203.spaces[0]], e = by[u205.spaces[0]];
    const f1 = by[u206.spaces[0]], f2 = by[u206.spaces[1]], h = by[u207.spaces[0]];

    if (parent) {
      console.log("\n== WITNESS (unmodified tree): the dead ends ==");
      ok("201 after the door still reads Occupied from the stale opening claim", a.bucket === "occupied" && a.marketing_state === "occupied", line(a));
      ok("202 after the door reads occupancy unknown", a && b.basis_state === "not_established" && b.marketing_state === "occupancy_unknown", line(b));
    } else {
      console.log("\n== SUCCESSOR: the door is a vacancy fact ==");
      ok("201: basis established by the recorded move-out", a.basis_state === "established" && a.basis_type === "turnover_recorded_move_out", line(a));
      ok("201: the older occupied claim is governed by the later fact", a.evidence_state === "governed_by_later_fact", line(a));
      ok("201: tenancy axis reads vacant, bucket reads Open", a.tenancy_state === "vacant" && a.bucket === "open", line(a));
      ok("201: availability no longer says Occupied — honestly blocked on readiness (walk assigned, not done)",
        a.marketing_state === "readiness_unknown", line(a));
      ok("201: the basis ref names the turnover and the outgoing lease",
        a.basis_ref && a.basis_ref.kind === "turnover" && String(a.basis_ref.outgoing_lease_id) === String(L[201]), JSON.stringify(a.basis_ref));
      ok("202 (no opening claim): basis established by the recorded move-out, bucket Open",
        b.basis_type === "turnover_recorded_move_out" && b.bucket === "open", line(b));
      ok("202: availability honestly blocked on readiness, not occupancy", b.marketing_state === "readiness_unknown", line(b));
      ok("202: the possession end is carried on the dated position",
        b.last_possession_end && String(b.last_possession_end.lease_id) === String(L[202]), JSON.stringify(b.last_possession_end));
      ok("201: bucket reason names the move-out", a.bucket_reason_code === "MOVE_OUT_RECORDED_NO_LATER_BLOCKER", a.bucket_reason_code);
    }

    console.log("\n== controls (same on both trees) ==");
    ok("203: a lease merely expiring establishes nothing — still Occupied on the uncorroborated claim",
      c3.bucket === "occupied" && c3.evidence_state === "uncorroborated" && c3.basis_type === "opening_claim_occupied", line(c3));
    ok("205: a turn-only door with no outgoing lease establishes nothing",
      e.basis_type === "opening_claim_occupied" && e.bucket === "occupied", line(e));
    ok("206 bed 2: bed 1's move-out says nothing about bed 2",
      f2.basis_type === "opening_claim_occupied" && f2.bucket === "occupied", line(f2));
    ok("201 at a date before the door: the lease governs, Occupied",
      (await read(P, D(-1)))[u201.spaces[0]].bucket === "occupied" && (await read(P, D(-1)))[u201.spaces[0]].tenancy_state === "contractually_occupied",
      line((await read(P, D(-1)))[u201.spaces[0]]));
    ok("207: while the turn is open, availability says turnover_required",
      h.marketing_state === "turnover_required", line(h));
    if (!parent) {
      ok("206 bed 1: moved out through the door → Open", f1.bucket === "open" && f1.basis_type === "turnover_recorded_move_out", line(f1));
      ok("207: while the turn is open the rent roll already reads Open on the move-out basis",
        h.bucket === "open" && h.basis_type === "turnover_recorded_move_out", line(h));
    }

    console.log("\n== the door yields to a stronger fact: an incoming lease that has COMMENCED ==");
    //  Found by the loop audit after row 151 shipped: door + commenced pending
    //  lease crashed the rent-roll explanation. The read must not throw, and
    //  the commenced lease — not the door — must answer.
    L["201-next"] = (await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status)
      values($1,$2,$3,1200,$4,$5,'pending') returning id`, [P, u201.spaces[0], [person], D(0), D(365)])).id;
    let commenced = null, threw = null;
    try { commenced = (await read(P))[u201.spaces[0]]; } catch (e) { threw = e.message; }
    ok("201 with a commenced incoming lease: the read does not throw", !threw, threw || "");
    ok("201: the commenced lease answers, not the door",
      commenced && commenced.bucket === "activation_pending" && commenced.basis_type === "commenced_lease_pending_activation", commenced ? line(commenced) : "");
    await pool.query("update leases set lease_status='cancelled' where id=$1", [L["201-next"]]);

    console.log("\n== a NEWER opening claim wins over an older door ==");
    const B = await property(tag + "-newer");
    const u301 = await unit(B.id, "301");
    L[301] = await lease(B.id, u301.spaces[0], { start: D(-400), end: D(-30) });
    const t301 = await moveOut(B.id, u301.unit_id, L[301]);
    //  The door was opened 20 days ago (fixture clock), the opening position is dated 5 days ago and says occupied.
    await pool.query("update turnovers set created_at=now() - interval '20 days' where id=$1", [t301.turnover.id]);
    await opening(B.id, B.deal_id, D(-5), [{ unit_number: "301", space_id: u301.spaces[0], tenant_name: "Resident 301 again" }]);
    const n = (await read(B.id))[u301.spaces[0]];
    ok("301: a newer accepted occupied claim outranks an older move-out",
      n.basis_type === "opening_claim_occupied" && n.bucket === "occupied", line(n));
  } finally {
    console.log(`\n${passed} passed, ${failed} failed${parent ? " (witness mode)" : ""}`);
    await pool.end();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("HARNESS:", e.stack || e.message); process.exit(2); });
