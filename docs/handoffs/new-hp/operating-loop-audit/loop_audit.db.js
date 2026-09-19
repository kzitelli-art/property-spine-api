/*  loop_audit.db.js — ONE POSITION THROUGH THE WHOLE OPERATING LOOP, on a
 *  generic whole-unit apartment fixture, through the REAL services.
 *
 *  Owned proof PostgreSQL 16 + owned HTTP server (loopback). Writes only a
 *  scratch property tagged with a run nonce. Nothing outside it is touched.
 *
 *  Every step records what the canonical readers SAY, and each "HOLD/BREAK"
 *  line is a doctrine expectation: HOLD = the loop closes here, BREAK = it
 *  does not. Neither is an exit code — this is an audit, not a gate.       */
"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const ROOT = "/home/user/property-spine-api";
const boundary = require(path.join(ROOT, "tests/e2e/proof_boundary.js"));
const { Pool } = require(ROOT + "/node_modules/pg");

const { datedPropertyPositions, rentRollBuckets, intervalPropertyPositions } = require(path.join(ROOT, "src/tenancy/dated_positions.js"));
const { availabilityRead } = require(path.join(ROOT, "src/surfaces/availability_read.js"));
const target = require(path.join(ROOT, "src/applications/application_target_authority.js"));
const { rankTurnPriority } = require(path.join(ROOT, "src/maintenance/turn_priority.js"));
const { readNextCommittedMoveIn } = require(path.join(ROOT, "src/maintenance/unit_move_in_read.js"));
const { recordEffectivePossession } = require(path.join(ROOT, "src/tenancy/space_position.js"));
const engine = require(path.join(ROOT, "src/shared/obligation_engine.js"));
const { makeUnitTriageService } = require(path.join(ROOT, "src/maintenance/unit_triage_service.js"));
const { makeUnitTurnScopeService } = require(path.join(ROOT, "src/maintenance/unit_turn_scope_service.js"));
const { makeWorkAcceptanceService } = require(path.join(ROOT, "src/maintenance/work_acceptance_service.js"));
const { makeReadinessService } = require(path.join(ROOT, "src/maintenance/readiness_service.js"));
const { makeTurnoverService } = require(path.join(ROOT, "src/maintenance/turnover_service.js"));
const econ = require(path.join(ROOT, "src/tenancy/economic_tenancy_service.js"));

const DAY = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const TODAY = ymd(Date.now());
const D = (n) => ymd(Date.now() + n * DAY);
const API = process.env.E2E_API_BASE;

const out = [];
const say = (s) => { console.log(s); out.push(s); };
let holds = 0, breaks = 0;
const verdict = (label, ok, detail = "") => {
  if (ok) { holds++; say("  HOLD   " + label + (detail ? "   [" + detail + "]" : "")); }
  else    { breaks++; say("  BREAK  " + label + (detail ? "   [" + detail + "]" : "")); }
};
const note = (label, detail) => say("  note   " + label + "   [" + detail + "]");

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
  const tag = "loop-audit-" + randomUUID().slice(0, 8);

  // ── real services, wired exactly as server.js wires them ───────────
  const spawnObligationFromEvent = engine.spawnObligationFromEvent;
  const unitTriageService = makeUnitTriageService({ spawnObligationFromEvent });
  const unitTurnScopeService = makeUnitTurnScopeService({ spawnObligationFromEvent });
  const attachmentService = require(path.join(ROOT, "src/maintenance/work_proof_attachment_service.js")).makeWorkProofAttachmentService();
  const workAcceptanceService = makeWorkAcceptanceService({ spawnObligationFromEvent, attachmentService });
  const readinessService = makeReadinessService({ spawnObligationFromEvent, workAcceptanceService });
  const turnoverService = makeTurnoverService({ spawnObligationFromEvent, recordEffectivePossession, unitTriageService });

  // ── FIXTURE: a generic whole-unit apartment building ───────────────
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const pm = await one(`insert into users(name,email,role,is_active,status,account_kind,organization_id)
    values('Loop Audit Property Manager',$1,'property_manager',true,'active','internal_qa',$2) returning id`, [tag + "@example.invalid", org.id]);
  const deal = await one(`insert into deal_intakes(onboarding_type,status,deal_name,organization_id)
    values('existing_asset','classified',$1,$2) returning id`, [tag, org.id]);
  const p = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
    values($1,$1,$2,'unit') returning id`, [tag, org.id]);
  const P = p.id;
  await pool.query("insert into deal_intake_properties(intake_id,property_id,status) values($1,$2,'current')", [deal.id, P]);
  await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,scope_type,allowed_modules,primary_for_modules,active)
    values($1,$2,'Property Manager','property','{management,maintenance,leasing}','{management}',true)`, [P, pm.id]);

  const persons = {};
  for (const n of ["Resident A", "Resident B", "Resident C", "Resident D", "Prospect One", "Prospect Two", "Prospect Three"]) {
    persons[n] = (await one("insert into persons(name,lifecycle_status) values($1,$2) returning id",
      [n, n.startsWith("Prospect") ? "prospect" : "tenant"])).id;
  }
  const U = {}, S = {};
  for (const n of ["101", "102", "103", "104", "105"]) {
    U[n] = (await one("insert into units(property_id,unit_number,bedrooms) values($1,$2,1) returning id", [P, n])).id;
    S[n] = (await one("update spaces set use_type='residential', position_kind='unit' where unit_id=$1 returning id", [U[n]])).id;
  }

  // Opening rent roll as of 60 days ago: 101, 102, 103 occupied by a named
  // resident. 104 is deliberately ABSENT from the opening source so its
  // basis rests on its lease alone.
  const AS_OF = D(-60);
  const batch = await one(`insert into import_batches(property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
    values($1,'rent_roll_ledger','loop.csv',$2,'unit','confirmed','committed') returning id`, [P, AS_OF]);
  const act = await one(`insert into activations(deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
    values($1,$2,'activated',$3,$4,$5) returning id`, [deal.id, P, AS_OF, batch.id, pm.id]);
  let rowIx = 0;
  for (const [n, who] of [["101", "Resident A"], ["102", "Resident B"], ["103", "Resident C"]]) {
    rowIx += 1;
    const raw = { unit_number: n, tenant_name: who, is_vacant: false, status: "current" };
    const ev = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,produced_unit_id,produced_space_id)
      values($1,$2,$3,'loop audit opening evidence',$4,$5) returning id`, [batch.id, rowIx, JSON.stringify(raw), U[n], S[n]]);
    await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,normalized_json,status,import_source_row_id,confirmed_by,confirmed_at)
      values($1,$2,'leasing','lease',$3,$4,'promoted',$5,$6,now())`,
      [act.id, P, n, JSON.stringify({ section: "current", unit_number: n, tenant_name: who, is_vacant: false }), ev.id, String(pm.id)]);
  }
  await one(`insert into opening_tenancy_positions(property_id,deal_intake_id,activation_id,import_batch_id,as_of_date,
    positions_established,positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
    values($1,$2,$3,$4,$5,3,0,3,$6,'platform_role:super_admin','established') returning id`, [P, deal.id, act.id, batch.id, AS_OF, pm.id]);

  // Outgoing leases: every resident's term ended YESTERDAY.
  const lease = async (n, who, { status = "active", start = D(-400), end = D(-1), executed = false, funded = false, rent = 1500 } = {}) => {
    const l = await one(`insert into leases(property_id,space_id,tenant_ids,rent,start_date,end_date,lease_status,source_type,confidence,security_deposit)
      values($1,$2,$3,$4,$5,$6,$7,'historical_snapshot','confirmed',0) returning id`, [P, S[n], [persons[who]], rent, start, end, status]);
    if (executed) {
      const app = await one(`insert into lease_applications(property_id,applicant_name,status,person_id,unit_id) values($1,$2,'active',$3,$4) returning id`,
        [P, who, persons[who], U[n]]);
      const ev = await one(`insert into events(property_id,unit_id,type,note) values($1,$2,'lease_executed','loop audit executed record') returning id`, [P, U[n]]);
      await pool.query(`insert into executed_lease_records(application_id,property_id,space_id,rent,security_deposit,lease_start_date,lease_end_date,
          payload_hash,executed_at,signers,execution_channel,verified_by_user_id,event_id,record_state,document_sha256,lease_id)
        values($1,$2,$3,$4,0,$5,$6,'loop-hash',$5,$7,'paper',$8,$9,'verified','loop-sha',$10)`,
        [app.id, P, S[n], rent, start, end, JSON.stringify([{ name: who }]), pm.id, ev.id, l.id]);
      await pool.query("update leases set application_id=$2 where id=$1", [l.id, app.id]);
    }
    if (funded) {
      await pool.query(`insert into scheduled_charges(property_id,lease_id,period,amount,amount_paid,status,is_move_in_required,move_in_requirement_key,display_label,charge_type)
        values($1,$2,$3,$4,$4,'paid',true,'first_month','First month rent','rent')`, [P, l.id, start, rent]);
    }
    return l.id;
  };
  const L = {};
  L["101"] = await lease("101", "Resident A");
  L["102"] = await lease("102", "Resident B");
  L["103"] = await lease("103", "Resident C");
  L["104"] = await lease("104", "Resident D");
  L["105"] = await lease("105", "Resident D");
  // Possession was recorded for 101 and 102 (keys were handed over 400 days
  // ago). 103 and 104 never had a possession event — a lease and nothing else.
  for (const n of ["101", "102", "105"]) {
    await recordEffectivePossession(pool, { kind: "move_in", lease_id: L[n], unit_id: U[n], property_id: P,
      effective_date: D(-400), actor: pm.id, source: "loop_audit_fixture", space_id_hint: S[n] });
  }

  // ── READERS ───────────────────────────────────────────────────────
  const readAll = async (asOf = null) => {
    const dp = await datedPropertyPositions(pool, { property_id: P, as_of: asOf });
    const av = await availabilityRead(pool, { property_id: P, as_of: asOf });
    const rr = rentRollBuckets(dp.positions);
    const byUnit = {};
    for (const pos of dp.positions) {
      const row = av.rows.find((r) => String(r.space_id) === String(pos.space_id));
      byUnit[pos.unit_number] = {
        bucket: pos.bucket, tenancy_state: pos.tenancy_state, basis: pos.basis_state + "/" + pos.basis_type,
        evidence: pos.evidence_state, possession: pos.possession_state,
        marketing: row.marketing_state, reason: row.blocking_reason,
        available_from: row.available_from, confidence: row.availability_confidence,
        readiness: row.physical_readiness + "/" + row.readiness_basis,
        commitment: row.future_commitment ? row.future_commitment.state : null,
      };
    }
    return { dp, av, rr, byUnit };
  };
  const show = (label, r) => {
    say("\n── " + label + "  (as_of " + r.dp.as_of + ")");
    for (const [n, x] of Object.entries(r.byUnit)) {
      say(`   ${n}  rr=${x.bucket}/${x.tenancy_state}  basis=${x.basis}  ev=${x.evidence}  poss=${x.possession}  ` +
          `→ avail=${x.marketing}(${x.reason})  from=${x.available_from}/${x.confidence}  ready=${x.readiness}  fc=${x.commitment}`);
    }
    say(`   rent roll tally: ${JSON.stringify(r.rr)}`);
  };
  const askFor = async (n, who, start, end, extra = {}) => {
    const t = await target.resolveApplicationTarget(pool, { property_id: P, unit_id: U[n], intended_move_in: start, requested_end: end, ...extra });
    return { ok: t.ok, offerable: t.offerable, code: t.refusal_code, state: t.marketing_state, from: t.available_from };
  };
  const turnRow = async (n) => (await rankTurnPriority(pool, P)).turns.find((t) => String(t.unit_id) === String(U[n])) || null;

  // ════════════════════════════════════════════════════════════════
  say("\n=== S0  Every lease ended yesterday. Nobody has told Spine anything else. ===");
  let r = await readAll();
  show("S0", r);
  verdict("Rent Roll → Availability: 101 (possession still held) is NOT offered",
    r.byUnit["101"].marketing !== "marketable_now", r.byUnit["101"].marketing + "/" + r.byUnit["101"].reason);
  verdict("Rent Roll → Availability: 101's reason is the RIGHT ended without possession returned",
    r.byUnit["101"].reason === "possession_not_returned", r.byUnit["101"].reason);
  verdict("Control E (103, opening claim, no possession event): contractually free, readiness unresolved → not called ready",
    r.byUnit["103"].marketing !== "marketable_now", r.byUnit["103"].marketing + "/" + r.byUnit["103"].reason + " ready=" + r.byUnit["103"].readiness);
  note("Control E reason names a STALE opening claim, not readiness",
    "103 basis=" + r.byUnit["103"].basis + " evidence=" + r.byUnit["103"].evidence);
  verdict("Control E (104, lease-only basis, no claim): not called ready",
    r.byUnit["104"].marketing !== "marketable_now", r.byUnit["104"].marketing + "/" + r.byUnit["104"].reason + " basis=" + r.byUnit["104"].basis);
  verdict("Rent roll and availability agree 103/104 are not occupied positions",
    r.byUnit["103"].bucket !== "occupied" && r.byUnit["104"].bucket !== "occupied",
    "103=" + r.byUnit["103"].bucket + " 104=" + r.byUnit["104"].bucket);

  // ════════════════════════════════════════════════════════════════
  say("\n=== S1  Move-out confirmed on 101 through the canonical turnover writer; expected ready " + D(14) + " ===");
  const c1 = await pool.connect();
  let t101;
  try {
    await c1.query("begin");
    t101 = await turnoverService.openTurnover(c1, { property_id: P, unit_id: U["101"], outgoing_lease_id: L["101"],
      needs: ["paint", "clean"], expected_ready_date: D(14), actor_user_id: pm.id });
    await c1.query("commit");
  } catch (e) { await c1.query("rollback"); throw e; } finally { c1.release(); }
  note("openTurnover", t101.move_out_note + " | walk: " + t101.initial_walk_note);
  r = await readAll();
  show("S1", r);
  verdict("Maintenance → Availability: turn in progress reads turnover_required with the governed expected date",
    r.byUnit["101"].marketing === "turnover_required" && r.byUnit["101"].available_from === D(14) && r.byUnit["101"].confidence === "expected",
    r.byUnit["101"].marketing + " from=" + r.byUnit["101"].available_from + "/" + r.byUnit["101"].confidence);
  let tr = await turnRow("101");
  verdict("The turn enters Turn Priority as raw vacancy (no commitment yet)", tr && tr.demand_tier_key === "raw_vacancy", tr && tr.demand_tier_key);
  verdict("Rent roll: 101 is now an OPEN position (classified, not a remainder)", r.byUnit["101"].bucket === "open", r.byUnit["101"].bucket + " basis=" + r.byUnit["101"].basis);

  // ════════════════════════════════════════════════════════════════
  say("\n=== S2  Prospect One asks for 101 from " + D(20) + " to " + D(385) + " (after expected ready) ===");
  let a = await askFor("101", "Prospect One", D(20), D(385));
  verdict("Availability → Leasing: honestly offerable for the requested dates", a.ok && a.offerable, JSON.stringify(a));
  a = await askFor("101", "Prospect One", D(10), D(375));
  verdict("Control A: move-in requested BEFORE the governed ready date → refused",
    !a.offerable && a.code === "application_move_in_before_expected_ready", JSON.stringify(a));

  // ════════════════════════════════════════════════════════════════
  say("\n=== S3  Prospect One's lease is created: pending, start " + D(20) + ", executed AND funded (locked) ===");
  say("   (written as confirm-term writes it — leases.pending with application_id, executed record, paid move-in charge —");
  say("    the real confirmTermService needs the whole application chain and is exercised by tour_application_lease.e2e.js)");
  L["101-next"] = await lease("101", "Prospect One", { status: "pending", start: D(20), end: D(385), executed: true, funded: true });
  r = await readAll();
  show("S3", r);
  verdict("Leasing → Rent Roll: the future commitment rides on the same dated position",
    r.byUnit["101"].commitment === "locked", "fc=" + r.byUnit["101"].commitment);
  verdict("Availability: position now committed to a future resident (never offered)",
    r.byUnit["101"].marketing === "successor_locked", r.byUnit["101"].marketing);
  tr = await turnRow("101");
  verdict("Leasing → Maintenance: Turn Priority AUTOMATICALLY carries the incoming commitment and its deadline",
    tr && tr.demand_tier_key === "committed_start" && tr.commitment_start_date === D(20), tr && (tr.demand_tier_key + " " + tr.commitment_start_date));
  const nm = await readNextCommittedMoveIn(pool, { unit_id: U["101"], property_id: P });
  verdict("Maintenance's own move-in reader sees the same lease", nm && String(nm.lease_id) === String(L["101-next"]) && nm.move_in_date === D(20), JSON.stringify(nm));
  a = await askFor("101", "Prospect Two", D(25), D(300));
  verdict("Control B: a second prospect asking inside the committed interval → refused", !a.offerable, JSON.stringify(a));
  const iv = await intervalPropertyPositions(pool, { property_id: P, requested_start: D(25), requested_end: D(300) });
  const ivp = iv.positions.find((x) => String(x.space_id) === String(S["101"]));
  note("interval read for 101 over the second prospect's dates", ivp.interval_state);

  // ════════════════════════════════════════════════════════════════
  say("\n=== S4  Initial walk on 101: vacant, SEVERE, long-lead HVAC finding (turn will slip) ===");
  const c4 = await pool.connect();
  let triage101;
  try {
    await c4.query("begin");
    triage101 = await unitTriageService.confirmTriage(c4, { property_id: P, unit_id: U["101"], actor_user_id: pm.id,
      original_text: "walked 101: empty, HVAC dead, needs full replacement", vacancy_observation: "vacant", initial_condition: "severe",
      findings: [{ finding_text: "HVAC dead, replacement needed", long_lead_kind: "hvac_failure" }], required_work: [] });
    await c4.query("commit");
  } catch (e) { await c4.query("rollback"); throw e; } finally { c4.release(); }
  verdict("Leasing → Maintenance: severe triage on a committed unit raises the PROTECT-MOVE-IN decision for a manager",
    !!triage101.move_in_risk_obligation, triage101.move_in_risk_obligation ? triage101.move_in_risk_obligation.label : "none");
  r = await readAll();
  show("S4", r);
  verdict("Maintenance → Leasing: the expected ready date should move (or lose confidence) after a severe long-lead finding",
    !(r.byUnit["101"].available_from === D(14) && r.byUnit["101"].confidence === "expected"),
    "still from=" + r.byUnit["101"].available_from + "/" + r.byUnit["101"].confidence + " reason=" + r.byUnit["101"].reason);
  const rd = await one("select status, ready_date from turnovers where id=$1", [t101.turnover.id]);
  note("turnovers.ready_date after severe triage", JSON.stringify(rd));

  say("\n=== S4b Control C on 102: turn opened (expected " + D(14) + "), prospect asks " + D(20) + ", THEN the walk finds a long-lead problem ===");
  const c4b = await pool.connect();
  let t102;
  try {
    await c4b.query("begin");
    t102 = await turnoverService.openTurnover(c4b, { property_id: P, unit_id: U["102"], outgoing_lease_id: L["102"],
      needs: ["clean"], expected_ready_date: D(14), actor_user_id: pm.id });
    await c4b.query("commit");
  } catch (e) { await c4b.query("rollback"); throw e; } finally { c4b.release(); }
  const before = await askFor("102", "Prospect Three", D(20), D(385));
  verdict("102 offerable for " + D(20) + " before the walk", before.ok && before.offerable, JSON.stringify(before));
  const c4c = await pool.connect();
  try {
    await c4c.query("begin");
    await unitTriageService.confirmTriage(c4c, { property_id: P, unit_id: U["102"], actor_user_id: pm.id,
      original_text: "walked 102: empty, roaches everywhere, needs treatment cycle", vacancy_observation: "vacant", initial_condition: "severe",
      findings: [{ finding_text: "pest treatment cycle required", long_lead_kind: "pest_treatment" }], required_work: [] });
    await c4c.query("commit");
  } catch (e) { await c4c.query("rollback"); throw e; } finally { c4c.release(); }
  const after = await askFor("102", "Prospect Three", D(20), D(385));
  r = await readAll();
  verdict("Control C: after the turn visibly slips, leasing should NOT still be able to promise " + D(20) + " on the old date",
    !(after.ok && after.offerable && after.from === D(14)), JSON.stringify(after) + " triage=" + r.byUnit["102"].readiness);
  const protect102 = await one("select count(*)::int as n from obligations where unit_id=$1 and type='protect_next_move_in'", [U["102"]]);
  note("obligations raised for 102's slip (no committed move-in on it yet)", "protect_next_move_in=" + protect102.n + " — nothing else signals leasing");

  // ════════════════════════════════════════════════════════════════
  say("\n=== S5  Work and readiness on 101: complete turn scope, final walk certifies READY ===");
  const c5 = await pool.connect();
  let scope101, walk101;
  try {
    await c5.query("begin");
    scope101 = await unitTurnScopeService.confirmScope(c5, { property_id: P, unit_id: U["101"], actor_user_id: pm.id,
      triage_confirmation_id: triage101.confirmation.id, original_text: "HVAC replaced by vendor; paint touch-up; full clean done",
      paint_level: "none", cleaning_level: "none", keys_status: "accounted_for", inspection_completeness: "complete_turn_scope",
      required_work: [] });
    await c5.query("commit");
  } catch (e) { await c5.query("rollback"); throw e; } finally { c5.release(); }
  const gate = await readinessService.readGateState(pool, { unit_id: U["101"] });
  note("readiness gate before the final walk", gate.gate.actionable ? "actionable" : JSON.stringify(gate.gate.blockers.map((b) => b.code)));
  const c5b = await pool.connect();
  try {
    await c5b.query("begin");
    walk101 = await readinessService.recordWalk(c5b, { property_id: P, unit_id: U["101"], actor_user_id: pm.id, outcome: "ready",
      confirmations: { work_complete_confirmed: true, cleaning_acceptable_confirmed: true, appliances_present_confirmed: true,
        appliance_function_confirmed: true, no_repair_blocker_confirmed: true, keys_accounted_confirmed: true,
        condition_acceptable_confirmed: true, no_unknowns_confirmed: true }, note: "loop audit final walk" });
    await c5b.query("commit");
  } catch (e) { await c5b.query("rollback"); throw e; } finally { c5b.release(); }
  note("certification", "outcome=" + walk101.outcome + " closed_turnovers=" + walk101.closed_turnovers.length + " next_move_in=" + (walk101.next_move_in && walk101.next_move_in.move_in_date));
  r = await readAll();
  show("S5", r);
  verdict("Work → Readiness → Availability: certification closes the physical turn and the readiness axis reads certified",
    r.byUnit["101"].readiness === "ready/certification", r.byUnit["101"].readiness);
  tr = await turnRow("101");
  verdict("The turn leaves Turn Priority automatically", tr === null, tr ? tr.demand_tier_key : "gone");
  verdict("Control D: physically ready but contractually committed → still not offered to anyone else",
    r.byUnit["101"].marketing === "successor_locked", r.byUnit["101"].marketing);
  a = await askFor("101", "Prospect Two", D(25), D(300));
  verdict("Control D (application authority agrees)", !a.offerable, JSON.stringify(a));
  const deliv = await one("select count(*)::int as n from obligations where related_id=$1 and type='move_in_delivery'", [L["101-next"]]);
  note("move-in delivery obligation (unit_ready gate) for the incoming lease",
    "n=" + deliv.n + " — in production confirm-term opens it; certification does not feed its unit_ready input (source: readiness_service.js has no delivery call)");

  // ════════════════════════════════════════════════════════════════
  say("\n=== S5b Legacy door on 102: POST /turnovers/:id/ready with the shared operator key, no certification ===");
  const hdr = { "content-type": "application/json", "x-operator-key": "e2e-key" };
  for (const gate of ["moveout_photos", "deposit_review"]) {
    const s = await fetch(API + "/turnovers/" + t102.turnover.id + "/satisfy", { method: "POST", headers: hdr, body: JSON.stringify({ gate, proof: { note: "loop audit" } }) });
    note("satisfy " + gate, "HTTP " + s.status);
  }
  const ready = await fetch(API + "/turnovers/" + t102.turnover.id + "/ready", { method: "POST", headers: hdr, body: JSON.stringify({}) });
  const readyBody = await ready.json();
  note("legacy ready", "HTTP " + ready.status + " status=" + (readyBody.turnover && readyBody.turnover.status));
  const cert102 = await one("select count(*)::int as n from unit_readiness_certifications where unit_id=$1", [U["102"]]);
  r = await readAll();
  show("S5b", r);
  verdict("A second readiness writer should not exist: the legacy route closed the turn with zero certifications",
    !(ready.status === 200 && cert102.n === 0), "HTTP " + ready.status + " certifications=" + cert102.n);
  verdict("After a governed move-out and a closed turn, 102 should be OFFERABLE (or honestly blocked on readiness), not 'occupied' from a stale opening claim",
    !(r.byUnit["102"].marketing === "occupied"), r.byUnit["102"].marketing + "/" + r.byUnit["102"].reason + " basis=" + r.byUnit["102"].basis + " ev=" + r.byUnit["102"].evidence);

  say("\n=== S5c 105 (lease-only basis, possession recorded, NO opening claim): governed move-out, turn closed ===");
  const c5c = await pool.connect();
  let t105;
  try {
    await c5c.query("begin");
    t105 = await turnoverService.openTurnover(c5c, { property_id: P, unit_id: U["105"], outgoing_lease_id: L["105"],
      needs: ["clean"], expected_ready_date: D(7), actor_user_id: pm.id });
    await c5c.query("commit");
  } catch (e) { await c5c.query("rollback"); throw e; } finally { c5c.release(); }
  note("105 move-out", t105.move_out_note);
  r = await readAll();
  verdict("105 during the turn: turnover_required with a governed date", r.byUnit["105"].marketing === "turnover_required", r.byUnit["105"].marketing + " basis=" + r.byUnit["105"].basis);
  for (const gate of ["moveout_photos", "deposit_review"]) {
    await fetch(API + "/turnovers/" + t105.turnover.id + "/satisfy", { method: "POST", headers: hdr, body: JSON.stringify({ gate, proof: { note: "loop audit" } }) });
  }
  const ready105 = await fetch(API + "/turnovers/" + t105.turnover.id + "/ready", { method: "POST", headers: hdr, body: JSON.stringify({}) });
  note("105 legacy ready", "HTTP " + ready105.status);
  r = await readAll();
  show("S5c", r);
  verdict("After a governed move-out (possession end RECORDED) and a closed turn, 105 should be offerable or honestly readiness-blocked, not 'occupancy unknown'",
    !(r.byUnit["105"].marketing === "occupancy_unknown"), r.byUnit["105"].marketing + "/" + r.byUnit["105"].reason + " basis=" + r.byUnit["105"].basis + " rr=" + r.byUnit["105"].bucket);
  const lpe = (await datedPropertyPositions(pool, { property_id: P })).positions.find((x) => x.unit_number === "105");
  note("what Spine DOES hold for 105", "last_possession_end=" + JSON.stringify(lpe.last_possession_end) + " turn=" + JSON.stringify(await one("select status, outgoing_lease_id is not null as has_outgoing from turnovers where id=$1", [t105.turnover.id])));

  // ════════════════════════════════════════════════════════════════
  say("\n=== S6  Move-in. The dated read at " + D(20) + ", then the clock is moved so the real activation writer can run ===");
  let rf = await readAll(D(20));
  show("S6 dated read at lease start", rf);
  verdict("Move-in → Rent Roll (dated): at the start date the committed lease reads activation_pending, not open and not occupied",
    rf.byUnit["101"].bucket === "activation_pending", rf.byUnit["101"].bucket + "/" + rf.byUnit["101"].tenancy_state);
  // clock: the lease commences today (fixture manipulation, stated)
  await pool.query("update leases set start_date=$2, end_date=$3 where id=$1", [L["101-next"], TODAY, D(365)]);
  await pool.query("update scheduled_charges set period=$2 where lease_id=$1", [L["101-next"], TODAY]);
  const elr = await one("select id from executed_lease_records where lease_id=$1", [L["101-next"]]);
  const csEv = await one("insert into events(property_id,unit_id,type,note) values($1,$2,'move_in_charge_set_confirmed','loop audit') returning id", [P, U["101"]]);
  await pool.query(`insert into lease_move_in_charge_sets(lease_id,property_id,executed_lease_record_id,first_period_amount,first_period_start,first_period_end,required_fees,payload_hash,normalization_version,calculation_note,authority_basis,event_id,status,confirmed_by_user_id,confirmed_at)
    values($1,$2,$3,1500,$4,$5,'[]','loop-hash',1,'loop audit: first month only','{"basis":"loop audit fixture"}',$7,'confirmed',$6,now())`, [L["101-next"], P, elr.id, TODAY, D(29), pm.id, csEv.id]);
  r = await readAll();
  show("S6 today, lease commenced, funds cleared, not yet activated", r);
  verdict("Before activation: activation_pending on the rent roll AND on availability (same fact, two readers)",
    r.byUnit["101"].bucket === "activation_pending" && r.byUnit["101"].marketing === "activation_pending",
    r.byUnit["101"].bucket + " / " + r.byUnit["101"].marketing);
  const c6 = await pool.connect();
  let activation;
  try {
    await c6.query("begin");
    activation = await econ.attemptEconomicTenancyActivation(c6, { lease_id: L["101-next"], activated_by_user_id: pm.id, actor_name: "Loop Audit PM" });
    await c6.query("commit");
  } catch (e) { await c6.query("rollback"); throw e; } finally { c6.release(); }
  note("activation", "activated=" + activation.activated + " funds=" + activation.funds.state);
  r = await readAll();
  show("S6 after activation", r);
  verdict("Move-in → Rent Roll: the incoming commitment IS the next current tenancy — no reclassification step",
    r.byUnit["101"].bucket === "occupied" && r.byUnit["101"].tenancy_state === "contractually_occupied" && r.rr.occupied_contractual >= 1,
    r.byUnit["101"].bucket + "/" + r.byUnit["101"].tenancy_state);
  verdict("Availability agrees (occupied by a spanning lease)", r.byUnit["101"].marketing === "occupied" && r.byUnit["101"].reason === "spanning_lease", r.byUnit["101"].marketing);
  note("possession after activation", r.byUnit["101"].possession + " — keys are a separate governed handoff, by design");

  say("\n=== SUMMARY  holds=" + holds + "  breaks=" + breaks + "  property=" + P + " ===");
  require("node:fs").writeFileSync(path.join(__dirname, "loop_audit.out"), out.join("\n") + "\n");
  await pool.end();
})().catch((e) => { console.error("HARNESS:", e.stack || e.message, e.blockers || ""); process.exit(2); });
