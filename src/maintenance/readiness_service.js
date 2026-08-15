// ════════════════════════════════════════════════════════════════════
//  readiness_service.js — THE ONE CANONICAL READINESS PATH (BUILD 4)
//
//  The final gate. This is the ONLY module in the system permitted to make a
//  unit physically ready, and it can do so only by writing a certification a
//  named human signed.
//
//  Injected deps: { spawnObligationFromEvent, workAcceptanceService }
//
//  ── THE ABSENCE OF OPEN WORK IS NOT READINESS ───────────────────────
//  There is no code path here that derives `ready` from state. Every
//  certification originates in an explicit human confirmation with every
//  required area affirmed.
//
//  ── WORKER AND CERTIFIER (ruling 2) ─────────────────────────────────
//  There is deliberately NO check for "did this person do any of the work".
//  Performing work is not authority and it is not disqualification either. The
//  only question asked is whether the person INDEPENDENTLY holds final-walk
//  authority. On a small team the person who painted the unit may well be the
//  assistant manager, and a blanket ban would force a lie or a stall.
//
//  ── AND READINESS IS ONE AXIS ONLY ──────────────────────────────────
//  A certification never touches possession, economic tenancy, move-in
//  delivery, down status, successor commitments or operating use. It says the
//  unit is physically acceptable. Availability decides marketability, and
//  another blocker still wins.
// ════════════════════════════════════════════════════════════════════

"use strict";

const { readinessGate, missingConfirmations, CONFIRMATION_AREAS } = require("./readiness_gate");
const { computeTurnFlow, STAGE } = require("./turn_sequence");
const { interpretRepairs } = require("./turn_scope_interpreter");
const { readNextCommittedMoveIn } = require("./unit_move_in_read");

const OBLIGATION_TYPES = Object.freeze({
  FINAL_WALK: "final_readiness_walk",
  REINSPECTION: "readiness_reinspection",
  PROTECT_MOVE_IN: "protect_next_move_in",
});

// ── FINAL-WALK AUTHORITY: A TEMPORARY RANKING ADAPTER (ruling 3) ────
//
//  CLASS 4. A title may RANK people who are ALREADY authorized. It may not
//  grant property authority, module access, or final-walk authority.
//
//  Eligibility is decided FIRST and separately, by the existing foundation:
//  an active property_team_assignments row with `management` module access.
//  Final walk is a management act, so maintenance-only access is not enough —
//  that is a real authority boundary, and it is the assignment that draws it,
//  not this list.
//
//  REPLACEMENT CONDITION: delete this ladder when a property can configure its
//  own final-readiness authority. Nothing else changes — the eligibility
//  filter already stands alone.
const AUTHORITY_LADDER = [
  { re: /\bsenior\s+(property\s+)?manager\b/i, rank: 1, why: "senior property manager" },
  { re: /\b(assistant|asst\.?)\s+(property\s+)?manager\b/i, rank: 2, why: "assistant property manager (delegated)" },
  { re: /\b(property\s+)?manager\b/i, rank: 3, why: "property manager" },
];

async function closeActiveTurnoversForReadiness(db, { property_id, unit_id, ready_date = null }) {
  return (await db.query(
    `update turnovers
        set status='ready', ready_date=coalesce($3::date,current_date), updated_at=now()
      where property_id=$1 and unit_id=$2 and status='in_progress'
      returning id, property_id, unit_id, status, ready_date`,
    [property_id, unit_id, ready_date]
  )).rows;
}

function makeReadinessService(deps) {
  const { spawnObligationFromEvent, workAcceptanceService } = deps || {};
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("readiness_service requires spawnObligationFromEvent()");
  }
  if (!workAcceptanceService || typeof workAcceptanceService.reopenWork !== "function") {
    throw new Error("readiness_service requires workAcceptanceService — reopening prior work must use the one canonical path");
  }
  const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

  //  Is this person authorized to perform and certify a final walk?
  //  ELIGIBILITY FIRST — the title is consulted only for ranking, never to
  //  admit anyone the assignment did not already admit.
  async function resolveWalkAuthority(client, { property_id, user_id }) {
    const r = (await client.query(
      `select pta.role_title, pta.allowed_modules, pta.primary_for_modules, u.name
         from property_team_assignments pta join users u on u.id = pta.user_id
        where pta.property_id=$1 and pta.user_id=$2 and pta.active=true`,
      [property_id, user_id])).rows[0];
    if (!r) return { authorized: false, reason: "no active assignment at this property" };
    const mods = r.allowed_modules || [];
    if (!mods.includes("management")) {
      return {
        authorized: false,
        reason: "final-readiness certification requires management module access at this property",
        role_title: r.role_title,
      };
    }

    // ── THREE CONDITIONS, ALL NECESSARY, NONE SUFFICIENT ───────────────
    //  An earlier draft stopped at module access, which meant ANY operator
    //  with the management module could certify readiness. That made module
    //  access sufficient on its own — exactly what the ruling forbids.
    //
    //      authorized for the property        (active assignment, checked above)
    //    + management module access           (checked above)
    //    + eligible manager assignment
    //      OR explicit delegated authority    (checked here)
    //
    //  A TITLE alone cannot create authority: an unranked title with no module
    //  access was already refused above, and a ranked title at another property
    //  never loads here at all.
    //  MODULE ACCESS alone cannot create authority: that is this block.
    const rung = AUTHORITY_LADDER.find((x) => x.re.test(String(r.role_title || "")));

    //  EXPLICIT DELEGATION, from an existing governed field. migration 035
    //  defines primary_for_modules as "which modules this user OWNS (tier 1)".
    //  Owning the management module at a property IS an explicit delegation
    //  already recorded by whoever set up the team — so this reuses a
    //  foundation rather than inventing a second authority model, which
    //  BUILD 4 is forbidden from doing.
    const delegated = (r.primary_for_modules || []).includes("management");

    if (!rung && !delegated) {
      return {
        authorized: false,
        role_title: r.role_title,
        reason: "management module access alone does not permit readiness certification — an eligible manager assignment or explicit delegated readiness authority is also required",
      };
    }

    return {
      authorized: true,
      role_title: r.role_title,
      name: r.name,
      rank: rung ? rung.rank : 3,
      basis: rung ? rung.why : "explicitly delegated readiness authority (primary_for_modules includes management)",
      via_delegation: !rung && delegated,
    };
  }

  //  Where the buck stops at this property, resolved from EXISTING
  //  assignments. Returns null with a stated basis when it cannot be resolved
  //  — recorded honestly rather than inventing a second owner or a new
  //  authority model (ruling 4).
  async function resolveSeniorAccountable(client, { property_id }) {
    const rows = (await client.query(
      `select pta.user_id, pta.role_title, u.name, pta.allowed_modules
         from property_team_assignments pta join users u on u.id = pta.user_id
        where pta.property_id=$1 and pta.active=true order by pta.created_at asc`,
      [property_id])).rows;
    const mgmt = rows.filter((x) => (x.allowed_modules || []).includes("management"));
    if (!mgmt.length) {
      return { user_id: null, basis: "UNRESOLVED — no active management assignment exists at this property" };
    }
    for (const rung of AUTHORITY_LADDER) {
      const hit = mgmt.find((x) => rung.re.test(String(x.role_title || "")));
      if (hit) return { user_id: hit.user_id, name: hit.name, basis: `resolved from assignment: ${rung.why}` };
    }
    return {
      user_id: null,
      basis: "UNRESOLVED — management staff exist but none carries a title this adapter can rank as senior. Not guessed.",
    };
  }

  // ── GATE STATE ────────────────────────────────────────────────────
  async function readGateState(db, { unit_id }) {
    const scope = (await db.query(
      `select * from unit_turn_scopes s where s.unit_id=$1
        and not exists (select 1 from unit_turn_scopes s2 where s2.supersedes_id = s.id)
        order by s.created_at desc limit 1`, [unit_id])).rows[0] || null;
    const work = (await db.query(
      `select w.*, (select count(*) from work_reopenings r where r.work_id=w.id) as reopened_count
         from unit_triage_required_work w where w.unit_id=$1 order by w.created_at asc`,
      [unit_id])).rows;
    const claims = (await db.query(
      "select * from work_completion_claims where unit_id=$1 order by created_at asc", [unit_id])).rows;
    const certs = await liveCertifications(db, { unit_id });

    return {
      unit_id, scope, work, claims,
      certifications: certs,
      certification: certs.find((c) => c.state === "ready") || null,
      gate: readinessGate({ scope, work, claims, certifications: certs }),
      flow: computeTurnFlow({ scope, work }),
      confirmation_areas: CONFIRMATION_AREAS,
    };
  }

  async function liveCertifications(db, { unit_id }) {
    const rows = (await db.query(
      "select * from unit_readiness_certifications where unit_id=$1 order by created_at asc",
      [unit_id])).rows;
    const superseded = new Set(rows.map((r) => r.supersedes_id).filter(Boolean).map(String));
    return rows.filter((r) => !superseded.has(String(r.id)));
  }

  // ── RECORD THE FINAL WALK ─────────────────────────────────────────
  async function recordWalk(client, spec) {
    const {
      property_id, unit_id, actor_user_id, outcome,
      confirmations = {}, note = null, photos = [],
      // failed-walk payload
      findings_text = "",
      reopen_work = [],       // [{ work_id, reason }] — prior completions disproved
      reclean_ruling = null,  // { required: bool, reason } — ruling 6
    } = spec || {};

    if (!actor_user_id) throw bad("actor_user_id is required — a final walk needs a human actor");
    if (!["ready", "not_ready"].includes(outcome)) throw bad("outcome must be 'ready' or 'not_ready'");

    const u = (await client.query(
      "select id, unit_number, property_id from units where id=$1", [unit_id])).rows[0];
    if (!u) throw Object.assign(new Error("unit not found"), { httpStatus: 404 });
    if (String(u.property_id) !== String(property_id))
      throw Object.assign(new Error("that unit is not at the property you are operating"), { httpStatus: 403 });

    // AUTHORITY. Asked of everyone equally — performing work neither grants
    // nor removes it.
    const auth = await resolveWalkAuthority(client, { property_id, user_id: actor_user_id });
    if (!auth.authorized) {
      throw Object.assign(
        new Error(`you are not authorized to perform the final readiness walk: ${auth.reason}`),
        { httpStatus: 403 });
    }

    const state = await readGateState(client, { unit_id });
    if (!state.gate.actionable) {
      throw Object.assign(
        new Error("the final readiness walk is not yet actionable"),
        { httpStatus: 409, blockers: state.gate.blockers });
    }

    if (outcome === "ready") {
      const missing = missingConfirmations(confirmations);
      if (missing.length) {
        throw Object.assign(
          new Error("a ready walk requires every confirmation area to be affirmed"),
          { httpStatus: 400, missing });
      }
    }

    const senior = await resolveSeniorAccountable(client, { property_id });

    const walk = (await client.query(
      `insert into unit_readiness_walks
         (property_id, unit_id, turn_scope_id, walked_by_user_id,
          senior_accountable_user_id, senior_accountable_basis, outcome,
          work_complete_confirmed, cleaning_acceptable_confirmed, appliances_present_confirmed,
          appliance_function_confirmed, no_repair_blocker_confirmed, keys_accounted_confirmed,
          condition_acceptable_confirmed, no_unknowns_confirmed, note, photos)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
      [property_id, unit_id, state.scope ? state.scope.id : null, actor_user_id,
       senior.user_id, senior.basis, outcome,
       confirmations.work_complete_confirmed ?? null,
       confirmations.cleaning_acceptable_confirmed ?? null,
       confirmations.appliances_present_confirmed ?? null,
       confirmations.appliance_function_confirmed ?? null,
       confirmations.no_repair_blocker_confirmed ?? null,
       confirmations.keys_accounted_confirmed ?? null,
       confirmations.condition_acceptable_confirmed ?? null,
       confirmations.no_unknowns_confirmed ?? null,
       note, photos])).rows[0];

    const nextMoveIn = await nextCommittedMoveIn(client, { unit_id });

    if (outcome === "ready") {
      return finishReady(client, { walk, state, senior, actor_user_id, note, photos, nextMoveIn, u, auth });
    }
    return finishNotReady(client, {
      walk, state, actor_user_id, property_id, unit_id, u,
      findings_text, reopen_work, reclean_ruling, nextMoveIn,
    });
  }

  // ── READY: WRITE THE CERTIFICATION ────────────────────────────────
  async function finishReady(client, { walk, state, senior, actor_user_id, note, photos, nextMoveIn, u, auth }) {
    // The exact state relied upon, captured NOW. Without it, a later dispute
    // has nothing to examine and "it was certified" becomes unfalsifiable.
    const relied = {
      turn_scope_id: state.scope ? state.scope.id : null,
      inspection_completeness: state.scope ? state.scope.inspection_completeness : null,
      paint_level: state.scope ? state.scope.paint_level : null,
      cleaning_level: state.scope ? state.scope.cleaning_level : null,
      keys_status: state.scope ? state.scope.keys_status : null,
      completed_work: state.work.filter((w) => w.status === "complete")
        .map((w) => ({ id: w.id, work_text: w.work_text, stage: w.stage })),
      proof_satisfied_claims: state.claims.filter((c) => c.proof_satisfied)
        .map((c) => ({ work_id: c.work_id, claim_id: c.id, claimed_at: c.claimed_at })),
      final_cleaning: state.work.filter((w) => w.stage === STAGE.FINAL_CLEAN)
        .map((w) => ({ id: w.id, status: w.status })),
      // Recorded even at `ready`: a walker may accept a unit while something
      // stays unknown, and the record must show what they accepted it despite.
      unresolved_unknowns: state.scope
        ? [state.scope.paint_level === "unknown" ? "paint level" : null,
           state.scope.cleaning_level === "unknown" ? "cleaning level" : null,
           state.scope.keys_status === "unknown" ? "keys and access" : null].filter(Boolean)
        : [],
      gate_at_certification: state.gate.blockers.map((b) => b.code),
    };

    const cert = (await client.query(
      `insert into unit_readiness_certifications
         (walk_id, property_id, unit_id, certified_by_user_id, walked_by_user_id,
          senior_accountable_user_id, senior_accountable_basis, state, note, photos,
          relied_on_state, next_move_in_date)
       values ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11) returning *`,
      [walk.id, walk.property_id, walk.unit_id, actor_user_id, walk.walked_by_user_id,
       senior.user_id, senior.basis, note, photos,
       JSON.stringify(relied), nextMoveIn ? nextMoveIn.move_in_date : null])).rows[0];

    // The named human certification is the authority that closes the physical
    // turn. Administrative move-out proof remains on its own obligation; it
    // cannot keep a physically ready unit in the turn queue or block leasing.
    const closedTurnovers = await closeActiveTurnoversForReadiness(client, {
      property_id: walk.property_id,
      unit_id: walk.unit_id,
    });

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'unit_certified_ready',$3) returning *`,
      [walk.property_id, walk.unit_id, JSON.stringify({
        walk_id: walk.id, certification_id: cert.id,
        certified_by: actor_user_id, walked_by: walk.walked_by_user_id,
        closed_turnover_ids: closedTurnovers.map((t) => t.id),
      })])).rows[0];

    // Close the final-walk obligation if one is open. A SUCCESSFUL
    // certification spawns nothing — it is quiet by design.
    await client.query(
      `update obligations set status='complete', completed_at=now(),
              resolution_code='satisfied', updated_at=now()
        where related_type='unit' and related_id=$1 and type=$2 and status in ('open','in_progress')`,
      [walk.unit_id, OBLIGATION_TYPES.FINAL_WALK]);

    return {
      outcome: "ready", walk, certification: cert, event: ev,
      closed_turnovers: closedTurnovers,
      next_move_in: nextMoveIn,
      authority: auth,
      senior_accountable: senior,
      // Said on every certification. Readiness is one axis.
      meaning: "This unit is physically ready. That is not possession, not keys handed over, not an active lease, and not legal occupancy.",
    };
  }

  // ── NOT READY: REOPEN THE FLOW THROUGH THE CANONICAL PATH ─────────
  async function finishNotReady(client, {
    walk, state, actor_user_id, property_id, unit_id, u,
    findings_text, reopen_work, reclean_ruling, nextMoveIn,
  }) {
    // 1) NEW conditions the walk discovered → finding → required work.
    //    Same tables Builds 1-3 use. No raw insert, no generic failure note.
    const newFindings = [];
    const newWork = [];
    const confirmationId = state.scope ? state.scope.triage_confirmation_id : null;

    for (const r of interpretRepairs(findings_text)) {
      const f = (await client.query(
        `insert into unit_triage_findings
           (confirmation_id, turn_scope_id, readiness_walk_id, property_id, unit_id,
            finding_text, evidence_text, origin, is_severe, long_lead_kind)
         values ($1,$2,$3,$4,$5,$6,$7,'proposed',false,null) returning *`,
        [confirmationId, state.scope ? state.scope.id : null, walk.id,
         property_id, unit_id, r.finding, r.evidence])).rows[0];
      newFindings.push(f);

      const w = (await client.query(
        `insert into unit_triage_required_work
           (finding_id, confirmation_id, turn_scope_id, readiness_walk_id, property_id, unit_id,
            work_text, origin, stage, disturbs_painted_surfaces)
         values ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9) returning *`,
        [f.id, confirmationId, state.scope ? state.scope.id : null, walk.id,
         property_id, unit_id, r.work, r.stage, r.disturbs_painted_surfaces])).rows[0];
      newWork.push(w);
    }

    // 2) PRIOR completions the walk DISPROVED → reopen through the one
    //    canonical path, which preserves the original claim and its proof.
    const reopened = [];
    for (const r of reopen_work || []) {
      if (!r || !r.work_id) continue;
      const out = await workAcceptanceService.reopenWork(client, {
        work_id: r.work_id, property_id, actor_user_id,
        reason: r.reason && String(r.reason).trim()
          ? `Final readiness walk found this incomplete: ${String(r.reason).trim()}`
          : "Final readiness walk found this incomplete.",
        // Cascade is decided by the reclean ruling below, not blindly here.
        cascade: false,
      });
      reopened.push({
        work_id: r.work_id, work_text: out.work.work_text,
        preserved_claim_id: out.preserved_claim_id,
      });
    }

    // 3) RECLEAN RULING (ruling 6). Corrective work that disturbs the cleaned
    //    condition reopens final cleaning — but not every reopened item does,
    //    and assuming so sends crews to reclean units that are still clean.
    //    Where it clearly does not, an authorized human rules so, ATTRIBUTED.
    const disturbs = newWork.some((w) => w.disturbs_painted_surfaces !== false)
      || reopened.length > 0;
    let recleanDecision = null;
    const cleans = state.work.filter((w) => w.stage === STAGE.FINAL_CLEAN && w.status === "complete");

    if (cleans.length) {
      const explicit = reclean_ruling && typeof reclean_ruling.required === "boolean";
      if (explicit && !reclean_ruling.required) {
        if (!reclean_ruling.reason || !String(reclean_ruling.reason).trim())
          throw bad("ruling that recleaning is unnecessary requires a reason");
        for (const c of cleans) {
          await client.query(
            `insert into reclean_rulings (work_id, property_id, unit_id, reclean_required, ruled_by_user_id, reason)
             values ($1,$2,$3,false,$4,$5)`,
            [c.id, property_id, unit_id, actor_user_id, String(reclean_ruling.reason).trim()]);
        }
        recleanDecision = { reclean_required: false, reason: String(reclean_ruling.reason).trim(), ruled_by: actor_user_id };
      } else if (disturbs || (explicit && reclean_ruling.required)) {
        for (const c of cleans) {
          await client.query(
            `insert into reclean_rulings (work_id, property_id, unit_id, reclean_required, ruled_by_user_id, reason)
             values ($1,$2,$3,true,$4,$5)`,
            [c.id, property_id, unit_id, actor_user_id,
             "Corrective work from the final walk disturbs the cleaned condition."]);
          await client.query("update unit_triage_required_work set status='required' where id=$1", [c.id]);
          const lastClaim = (await client.query(
            `select id from work_completion_claims where work_id=$1 and proof_satisfied=true
              order by created_at desc limit 1`, [c.id])).rows[0] || null;
          await client.query(
            `insert into work_reopenings
               (work_id, reopens_claim_id, property_id, unit_id, reopened_by_user_id, reason)
             values ($1,$2,$3,$4,$5,$6)`,
            [c.id, lastClaim ? lastClaim.id : null, property_id, unit_id, actor_user_id,
             "Reopened because corrective work from the final readiness walk disturbs the cleaned condition. This is not a failure of the cleaning."]);
        }
        recleanDecision = { reclean_required: true, reason: "Corrective work disturbs the cleaned condition." };
      }
    }

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'final_walk_failed',$3) returning *`,
      [property_id, unit_id, JSON.stringify({
        walk_id: walk.id, new_findings: newFindings.length,
        new_work: newWork.length, reopened: reopened.map((r) => r.work_id),
        reclean_required: recleanDecision ? recleanDecision.reclean_required : null,
      })])).rows[0];

    // 4) Move-in protection. Create or refresh the manager decision — never a
    //    resident action. This build does not transfer, contact, promise or
    //    reschedule anything.
    let moveInObligation = null;
    if (nextMoveIn) {
      const senior = await resolveSeniorAccountable(client, { property_id });
      moveInObligation = await spawnObligationFromEvent(client, {
        property_id, unit_id, source_event_id: ev.id,
        module: "maintenance", type: OBLIGATION_TYPES.PROTECT_MOVE_IN,
        label: `Protect the next move-in — unit ${u.unit_number || ""}, ${nextMoveIn.move_in_date} (${nextMoveIn.days_remaining} days)`.replace(/\s+/g, " ").trim(),
        owner_type: "human", assigned_role: "property_manager", escalates_to_role: "asset_manager",
        status: "open", priority: "high", severity: "high", due_at: null,
        related_id: walk.id, related_type: "readiness_walk",
        assigned_user_id: senior.user_id,
        ownership_origin: senior.user_id ? "eligible_assignment" : "observation_spawn",
        owner_eligibility_state: senior.user_id ? "eligible_assignment" : "unassigned",
        dedupe_key: `protect_next_move_in_walk:${walk.id}`,
      });
    }

    const after = await readGateState(client, { unit_id });
    return {
      outcome: "not_ready", walk, event: ev,
      new_findings: newFindings, new_work: newWork,
      reopened_work: reopened,
      reclean: recleanDecision,
      next_move_in: nextMoveIn,
      move_in_obligation: moveInObligation,
      gate: after.gate, flow: after.flow,
      meaning: "The unit is not ready. New work has been created through the same canonical path as every other finding, and the flow has recalculated.",
    };
  }

  // ── CORRECT OR REVOKE ─────────────────────────────────────────────
  //  Never an overwrite, never a delete. `ready` does not silently flip back.
  async function correctCertification(client, spec) {
    const { certification_id, property_id, actor_user_id, new_state, reason } = spec || {};
    if (!actor_user_id) throw bad("actor_user_id is required");
    if (!["revoked", "corrected"].includes(new_state))
      throw bad("new_state must be 'revoked' or 'corrected'");
    if (!reason || !String(reason).trim()) throw bad("a reason is required to correct or revoke a certification");

    const orig = (await client.query(
      "select * from unit_readiness_certifications where id=$1", [certification_id])).rows[0];
    if (!orig) throw Object.assign(new Error("certification not found"), { httpStatus: 404 });
    if (String(orig.property_id) !== String(property_id))
      throw Object.assign(new Error("that certification is not at the property you are operating"), { httpStatus: 403 });

    const auth = await resolveWalkAuthority(client, { property_id, user_id: actor_user_id });
    if (!auth.authorized)
      throw Object.assign(new Error(`you are not authorized to correct a readiness certification: ${auth.reason}`), { httpStatus: 403 });

    const senior = await resolveSeniorAccountable(client, { property_id });
    // A NEW ROW pointing at the original. The original is untouched.
    const row = (await client.query(
      `insert into unit_readiness_certifications
         (walk_id, property_id, unit_id, certified_by_user_id, walked_by_user_id,
          senior_accountable_user_id, senior_accountable_basis, state,
          note, relied_on_state, supersedes_id, correction_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [orig.walk_id, orig.property_id, orig.unit_id, actor_user_id, orig.walked_by_user_id,
       senior.user_id, senior.basis, new_state, null,
       JSON.stringify({ supersedes: orig.id, prior_state: orig.state }),
       orig.id, String(reason).trim()])).rows[0];

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'readiness_certification_corrected',$3) returning *`,
      [orig.property_id, orig.unit_id, JSON.stringify({
        original_certification_id: orig.id, new_certification_id: row.id,
        new_state, reason: String(reason).trim(),
      })])).rows[0];

    // The unit must be looked at again. This is the resulting obligation the
    // ruling requires — a reinspection, not a silent downgrade.
    const obligation = await spawnObligationFromEvent(client, {
      property_id: orig.property_id, unit_id: orig.unit_id, source_event_id: ev.id,
      module: "maintenance", type: OBLIGATION_TYPES.REINSPECTION,
      label: `Re-inspect after readiness was ${new_state}`,
      owner_type: "human", assigned_role: "property_manager", escalates_to_role: "asset_manager",
      status: "open", priority: "high", severity: "high", due_at: null,
      related_id: orig.unit_id, related_type: "unit",
      assigned_user_id: senior.user_id,
      ownership_origin: senior.user_id ? "eligible_assignment" : "observation_spawn",
      owner_eligibility_state: senior.user_id ? "eligible_assignment" : "unassigned",
      dedupe_key: `readiness_reinspection:${row.id}`,
    });

    return {
      original: orig, correction: row, event: ev, obligation,
      current_readiness: "not_ready",
      note: "The original certification is preserved. This is a new row pointing at it; readiness did not silently flip.",
    };
  }

  async function nextCommittedMoveIn(db, { unit_id }) {
    return readNextCommittedMoveIn(db, { unit_id });
  }

  return {
    readGateState, recordWalk, correctCertification,
    resolveWalkAuthority, resolveSeniorAccountable, liveCertifications, nextCommittedMoveIn,
    OBLIGATION_TYPES, AUTHORITY_LADDER,
  };
}

module.exports = {
  makeReadinessService,
  closeActiveTurnoversForReadiness,
  OBLIGATION_TYPES,
  AUTHORITY_LADDER,
};
