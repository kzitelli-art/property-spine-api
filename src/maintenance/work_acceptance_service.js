// ════════════════════════════════════════════════════════════════════
//  work_acceptance_service.js — THE ONE CANONICAL ACCEPT / CLAIM / REOPEN PATH
//
//  BUILD 3. The operating loop:
//    required work → ACCEPTED by eligible staff → due commitment confirmed →
//    completion CLAIMED → lightweight PROOF attached → obligation closes →
//    next stage becomes actionable
//
//  Injected deps: { spawnObligationFromEvent }
//
//  ── THE THREE RULES THIS SERVICE EXISTS TO HOLD ─────────────────────
//  1. ACCEPTANCE IS NOT COMPLETION. Accepting sets nobody's work to done and
//     does not change the item's status. Accepted work is still `required`.
//  2. A COMPLETION CLAIM WITHOUT PROOF DOES NOT CLOSE ANYTHING. The claim is
//     recorded — it is real, somebody said it — and the work stays open with
//     the shortfall named.
//  3. REOPENING PRESERVES THE ORIGINAL CLAIM AND ITS PROOF. The reopen points
//     at the claim; it never deletes it.
//
//  ── AND IT NEVER CERTIFIES READINESS ────────────────────────────────
//  Closing every item in a unit does not make the unit ready. Readiness comes
//  from a walk this build does not perform.
// ════════════════════════════════════════════════════════════════════

"use strict";

const {
  evaluateProof, proofRequirementFor,
  OUTCOMES, OUTCOME_VALUES, UNABLE_REASON_VALUES, UNABLE_REASONS, UNABLE_NEXT_ACTION,
  COMMITMENT_SOURCES,
} = require("./work_proof");
const { computeTurnFlow, STAGE } = require("./turn_sequence");

const OBLIGATION_TYPE = "work_commitment";

// ── "I'll handle it tomorrow" → A PROPOSAL, NEVER AN ACCEPTANCE ─────
//
//  PURE. `now` is passed in rather than read from the clock so this stays
//  testable and deterministic.
//
//  It proposes the speaker as owner and a date. It does NOT accept: the
//  contract is explicit that this becomes accepted only after explicit
//  confirmation, and the scoping or reporting actor is never the owner by
//  implication. Everything it returns is labelled a proposal.
function proposeCommitment({ text = "", actor_user_id = null, now = null } = {}) {
  const t = String(text || "").trim();
  const base = now ? new Date(now) : null;
  const iso = (d) => d.toISOString();
  const at = (d, h) => { const x = new Date(d); x.setUTCHours(h, 0, 0, 0); return x; };

  let due_at = null;
  let matched = null;
  if (base) {
    if (/\btoday\b/i.test(t)) { due_at = iso(at(base, 17)); matched = "today"; }
    else if (/\btomorrow\b/i.test(t)) {
      const d = new Date(base); d.setUTCDate(d.getUTCDate() + 1);
      due_at = iso(at(d, 17)); matched = "tomorrow";
    } else if (/\bthis (after|afternoon|morning)\b/i.test(t)) { due_at = iso(at(base, 17)); matched = "later today"; }
    else {
      const m = t.match(/\bin (\d{1,2}) days?\b/i);
      if (m) {
        const d = new Date(base); d.setUTCDate(d.getUTCDate() + Number(m[1]));
        due_at = iso(at(d, 17)); matched = m[0];
      }
    }
  }

  // First person means the speaker is proposing THEMSELVES. Anything else and
  // we propose no owner at all rather than guessing who they meant.
  const firstPerson = /\b(i'?ll|i will|i can|i'?ve got|let me|i'?m on it)\b/i.test(t);

  return {
    is_proposal: true,
    proposed_owner_user_id: firstPerson ? actor_user_id : null,
    proposed_owner_basis: firstPerson
      ? "the speaker referred to themselves"
      : "no owner proposed — the text did not say who would do it",
    proposed_due_at: due_at,
    proposed_due_basis: matched ? `read from "${matched}"` : "no date found in the text",
    commitment_source: due_at ? "proposed_from_text" : "none",
    interpreted_from: t,
    nothing_recorded:
      "This is a proposal. Nothing has been accepted, nobody has been assigned, and no commitment exists until it is explicitly confirmed.",
  };
}

function makeWorkAcceptanceService(deps) {
  const { spawnObligationFromEvent } = deps || {};
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("work_acceptance_service requires spawnObligationFromEvent()");
  }
  const bad = (m, extra) => Object.assign(new Error(m), { httpStatus: 400, ...(extra || {}) });

  async function loadWork(client, { work_id, property_id }) {
    const w = (await client.query(
      `select w.*, u.unit_number from unit_triage_required_work w
         join units u on u.id = w.unit_id where w.id = $1`, [work_id])).rows[0];
    if (!w) throw Object.assign(new Error("required-work item not found"), { httpStatus: 404 });
    if (property_id && String(w.property_id) !== String(property_id)) {
      throw Object.assign(
        new Error("that work item is not at the property you are operating"), { httpStatus: 403 });
    }
    return w;
  }

  //  Eligibility is the SAME gate the rest of maintenance uses: an active
  //  assignment with maintenance module access at this property. A title never
  //  grants it and this service never widens it.
  async function assertEligible(client, { property_id, user_id }) {
    const r = (await client.query(
      `select 1 from property_team_assignments
        where property_id=$1 and user_id=$2 and active=true
          and (allowed_modules @> array['maintenance']::text[]
            or allowed_modules @> array['management']::text[])`,
      [property_id, user_id])).rows[0];
    if (!r) throw Object.assign(
      new Error("you are not eligible to accept work at this property"), { httpStatus: 403 });
  }

  //  Is this item actionable RIGHT NOW under the sequence rules? Accepting
  //  blocked work would let somebody commit to painting before the wall repair
  //  it waits on — a commitment they cannot keep, which becomes a missed
  //  commitment that was never their fault.
  async function assertActionable(client, w) {
    const scope = (await client.query(
      `select * from unit_turn_scopes where unit_id=$1
        and not exists (select 1 from unit_turn_scopes s2 where s2.supersedes_id = unit_turn_scopes.id)
        order by created_at desc limit 1`, [w.unit_id])).rows[0] || null;
    const all = (await client.query(
      "select * from unit_triage_required_work where unit_id=$1", [w.unit_id])).rows;
    const flow = computeTurnFlow({ scope, work: all });
    const item = flow.items.find((i) => String(i.work_id) === String(w.id));
    if (item && item.blocked) {
      throw Object.assign(
        new Error("that work is blocked by earlier work and cannot be accepted yet"),
        { httpStatus: 409, blocked_by: item.blocked_by });
    }
    return { scope, flow };
  }

  // ── ACCEPT ────────────────────────────────────────────────────────
  async function acceptWork(client, spec) {
    const {
      work_id, property_id, actor_user_id,
      owner_user_id = null, due_at = null,
      commitment_source = null, note = null,
      supersedes_id = null, supersede_reason = null,
    } = spec || {};

    if (!actor_user_id) throw bad("actor_user_id is required — an acceptance needs a human actor");
    const w = await loadWork(client, { work_id, property_id });
    if (w.status !== "required")
      throw bad(`this work is ${w.status} and cannot be accepted`);

    // The OWNER defaults to the acceptor only when they did not name someone
    // else — an explicit self-acceptance, not an implication. It is never
    // inherited from whoever reported or scoped the work.
    const owner = owner_user_id || actor_user_id;
    await assertEligible(client, { property_id: w.property_id, user_id: owner });
    await assertActionable(client, w);

    const src = commitment_source || (due_at ? "operator_entered" : "none");
    if (!COMMITMENT_SOURCES.includes(src)) throw bad("invalid commitment_source", { allowed: COMMITMENT_SOURCES });
    if (src === "none" && due_at) throw bad("a due date needs a commitment source");
    if (src !== "none" && !due_at) throw bad("that commitment source requires a due date");
    if (supersedes_id && !(supersede_reason && String(supersede_reason).trim()))
      throw bad("re-accepting requires a reason for superseding the prior acceptance");

    const acc = (await client.query(
      `insert into work_acceptances
         (work_id, property_id, unit_id, owner_user_id, accepted_by_user_id,
          due_at, commitment_source, note, supersedes_id, supersede_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [w.id, w.property_id, w.unit_id, owner, actor_user_id,
       due_at, src, note, supersedes_id,
       supersede_reason ? String(supersede_reason).trim() : null])).rows[0];

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'work_accepted',$3) returning *`,
      [w.property_id, w.unit_id, JSON.stringify({
        work_id: w.id, acceptance_id: acc.id, owner_user_id: owner,
        accepted_by_user_id: actor_user_id, due_at, commitment_source: src,
      })])).rows[0];

    // The commitment obligation. Carries the due date so a missed commitment
    // is visible without anybody computing it. No due date means no clock —
    // an invented one would be a fake number.
    const obligation = await spawnObligationFromEvent(client, {
      property_id: w.property_id, unit_id: w.unit_id, source_event_id: ev.id,
      module: "maintenance", type: OBLIGATION_TYPE,
      label: `${w.work_text} — unit ${w.unit_number || ""}`.replace(/\s+/g, " ").trim(),
      owner_type: "human", assigned_role: "maintenance", escalates_to_role: "property_manager",
      status: "open", priority: "normal", severity: "normal",
      due_at: due_at || null,
      related_id: w.id, related_type: "required_work",
      assigned_user_id: owner,
      ownership_origin: "explicit_acceptance",
      owner_eligibility_state: "eligible_assignment",
      required_inputs: ["completion_proof"],
      dedupe_key: `work_commitment:${acc.id}`,
    });

    return { acceptance: acc, event: ev, obligation, work: w, proof_requirement: proofRequirementFor(w) };
  }

  // ── CLAIM COMPLETION ──────────────────────────────────────────────
  async function claimCompletion(client, spec) {
    const {
      work_id, property_id, actor_user_id,
      outcome, unable_reason = null, note = null,
      proof_photos = [], functional_confirmation = null,
    } = spec || {};

    if (!actor_user_id) throw bad("actor_user_id is required — a completion claim needs a human actor");
    if (!OUTCOME_VALUES.includes(outcome)) throw bad("invalid outcome", { allowed: OUTCOME_VALUES });
    if (outcome === OUTCOMES.UNABLE && !UNABLE_REASON_VALUES.includes(unable_reason))
      throw bad("unable_to_complete requires a reason", { allowed: UNABLE_REASON_VALUES });

    const w = await loadWork(client, { work_id, property_id });
    if (w.status !== "required") throw bad(`this work is ${w.status} and cannot be claimed`);
    if (w.stage === STAGE.READINESS_WALK)
      throw bad("the final readiness walk is not performed or certified in this build");

    const photos = Array.isArray(proof_photos) ? proof_photos.filter(Boolean) : [];
    const verdict = evaluateProof(w, {
      outcome, proof_photos: photos, functional_confirmation,
    });

    // The CLAIM IS ALWAYS RECORDED. Somebody said this happened, and that is a
    // fact worth keeping even when it does not close the work. Refusing to
    // record it would lose the attempt entirely.
    const claim = (await client.query(
      `insert into work_completion_claims
         (work_id, property_id, unit_id, claimed_by_user_id, outcome, unable_reason,
          note, proof_photos, functional_confirmation, proof_satisfied, proof_shortfall)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [w.id, w.property_id, w.unit_id, actor_user_id, outcome, unable_reason,
       note, photos, functional_confirmation, verdict.satisfied, verdict.shortfall])).rows[0];

    let closed = false;
    let unlockedStages = [];
    if (outcome === OUTCOMES.COMPLETED && verdict.satisfied) {
      await client.query(
        "update unit_triage_required_work set status='complete' where id=$1", [w.id]);
      // Close the commitment obligation, saying how.
      await client.query(
        `update obligations set status='complete', completed_at=now(),
                resolution_code='satisfied', updated_at=now()
          where related_type='required_work' and related_id=$1 and status in ('open','in_progress')`,
        [w.id]);
      closed = true;
    }

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'work_completion_claimed',$3) returning *`,
      [w.property_id, w.unit_id, JSON.stringify({
        work_id: w.id, claim_id: claim.id, outcome, unable_reason,
        proof_satisfied: verdict.satisfied, closed,
      })])).rows[0];

    // Recompute the flow so the caller can see what this unlocked. Reading it
    // here rather than making the caller derive it keeps one answer.
    const after = await readUnitFlow(client, { unit_id: w.unit_id });
    if (closed) {
      unlockedStages = after.flow.stages
        .filter((s) => s.stage && !s.blocked && s.open_count > 0)
        .map((s) => s.label);
    }

    return {
      claim, work: w, event: ev, closed,
      proof: verdict,
      next_action_proposal: outcome === OUTCOMES.UNABLE
        ? { reason: unable_reason, label: UNABLE_REASONS[unable_reason],
            proposed_next: UNABLE_NEXT_ACTION[unable_reason],
            nothing_dispatched: "Nothing has been ordered, scheduled, or sent to anyone." }
        : null,
      flow: after.flow,
      unlocked_stages: unlockedStages,
      // Said on every close. Closing an item is not readiness.
      readiness_note: "Closing this item does not make the unit ready. Readiness comes from the final walk, which this build does not perform.",
    };
  }

  // ── REOPEN ────────────────────────────────────────────────────────
  //
  //  The original claim and its proof SURVIVE. This points at them.
  //  Cascade: reopening dirty or destructive work reopens a completed final
  //  clean, because a unit cleaned before the wall was reopened is not clean.
  //  The cascade is attributed to the TRIGGER, not to the cleaner — it was
  //  not their failure and the record must not read as though it were.
  async function reopenWork(client, spec) {
    const { work_id, property_id, actor_user_id, reason, cascade = true } = spec || {};
    if (!actor_user_id) throw bad("actor_user_id is required — a reopen needs a human actor");
    if (!reason || !String(reason).trim()) throw bad("a reason is required to reopen work");

    const w = await loadWork(client, { work_id, property_id });
    if (w.status !== "complete") throw bad(`this work is ${w.status}, not complete — there is nothing to reopen`);

    const lastClaim = (await client.query(
      `select id from work_completion_claims
        where work_id=$1 and outcome='completed' and proof_satisfied=true
        order by created_at desc limit 1`, [w.id])).rows[0] || null;

    const reopen = (await client.query(
      `insert into work_reopenings
         (work_id, reopens_claim_id, property_id, unit_id, reopened_by_user_id, reason)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [w.id, lastClaim ? lastClaim.id : null, w.property_id, w.unit_id,
       actor_user_id, String(reason).trim()])).rows[0];

    await client.query("update unit_triage_required_work set status='required' where id=$1", [w.id]);

    // CASCADE — only downstream of dirty work, and only onto a completed clean.
    const cascaded = [];
    if (cascade && (w.stage === STAGE.REPAIR || w.stage === STAGE.PAINT)) {
      const cleans = (await client.query(
        `select * from unit_triage_required_work
          where unit_id=$1 and stage=$2 and status='complete'`,
        [w.unit_id, STAGE.FINAL_CLEAN])).rows;
      for (const c of cleans) {
        const cClaim = (await client.query(
          `select id from work_completion_claims where work_id=$1 and proof_satisfied=true
            order by created_at desc limit 1`, [c.id])).rows[0] || null;
        const r = (await client.query(
          `insert into work_reopenings
             (work_id, reopens_claim_id, property_id, unit_id, reopened_by_user_id, reason, triggered_by_work_id)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [c.id, cClaim ? cClaim.id : null, c.property_id, c.unit_id, actor_user_id,
           `Reopened automatically because upstream work was reopened: ${w.work_text}. This is not a failure of the cleaning.`,
           w.id])).rows[0];
        await client.query("update unit_triage_required_work set status='required' where id=$1", [c.id]);
        cascaded.push({ work_id: c.id, work_text: c.work_text, reopening_id: r.id });
      }
    }

    const ev = (await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'work_reopened',$3) returning *`,
      [w.property_id, w.unit_id, JSON.stringify({
        work_id: w.id, reopening_id: reopen.id, reopened_claim_id: lastClaim ? lastClaim.id : null,
        cascaded: cascaded.map((c) => c.work_id),
      })])).rows[0];

    const after = await readUnitFlow(client, { unit_id: w.unit_id });
    return {
      reopening: reopen, work: w, event: ev,
      preserved_claim_id: lastClaim ? lastClaim.id : null,
      cascaded_reopenings: cascaded,
      flow: after.flow,
      note: "The original completion claim and its proof are preserved. This reopen points at them.",
    };
  }

  // ── READS ─────────────────────────────────────────────────────────
  async function readWorkState(db, { work_id }) {
    const w = (await db.query(
      "select * from unit_triage_required_work where id=$1", [work_id])).rows[0];
    if (!w) return null;

    const accRows = (await db.query(
      "select * from work_acceptances where work_id=$1 order by created_at asc", [work_id])).rows;
    const superseded = new Set(accRows.map((a) => a.supersedes_id).filter(Boolean).map(String));
    const liveAcc = accRows.filter((a) => !superseded.has(String(a.id)));
    const acceptance = liveAcc[liveAcc.length - 1] || null;

    const claims = (await db.query(
      "select * from work_completion_claims where work_id=$1 order by created_at asc", [work_id])).rows;
    const reopenings = (await db.query(
      "select * from work_reopenings where work_id=$1 order by created_at asc", [work_id])).rows;

    return {
      work: w,
      requirement: proofRequirementFor(w),
      accepted: !!acceptance,
      acceptance,
      // Kept separate on purpose: these are different people and the record
      // must be able to say so.
      owner_user_id: acceptance ? acceptance.owner_user_id : null,
      accepted_by_user_id: acceptance ? acceptance.accepted_by_user_id : null,
      due_at: acceptance ? acceptance.due_at : null,
      commitment_source: acceptance ? acceptance.commitment_source : "none",
      latest_claim: claims[claims.length - 1] || null,
      claims, reopenings,
      reopened_count: reopenings.length,
      status: w.status,
    };
  }

  async function readUnitFlow(db, { unit_id }) {
    const scope = (await db.query(
      `select * from unit_turn_scopes s where s.unit_id=$1
        and not exists (select 1 from unit_turn_scopes s2 where s2.supersedes_id = s.id)
        order by s.created_at desc limit 1`, [unit_id])).rows[0] || null;
    const work = (await db.query(
      `select w.*, a.owner_user_id, a.due_at, usr.name as owner_name
         from unit_triage_required_work w
         left join lateral (
           select * from work_acceptances wa where wa.work_id = w.id
             and not exists (select 1 from work_acceptances w2 where w2.supersedes_id = wa.id)
            order by wa.created_at desc limit 1
         ) a on true
         left join users usr on usr.id = a.owner_user_id
        where w.unit_id = $1 order by w.created_at asc`, [unit_id])).rows;
    return { scope, work, flow: computeTurnFlow({ scope, work }) };
  }

  // ── MANAGEMENT EXCEPTIONS — routine success is QUIET ──────────────
  //
  //  Six conditions, and ordinary successful work is none of them. A manager
  //  shown every completed paint job stops reading the list.
  function workExceptions({ flow, workStates = [], nextMoveIn = null, now = null } = {}) {
    const out = [];
    const t = now ? new Date(now).getTime() : null;

    if (flow && flow.unassigned_count > 0) {
      out.push({ code: "unassigned_work", label: "Actionable work has no owner",
        detail: `${flow.unassigned_count} actionable item${flow.unassigned_count === 1 ? "" : "s"} nobody has accepted.` });
    }

    // Accepted, actionable, and nobody named a date for THE WORK.
    // "Somebody will get to it" is not a date, and a turn with a committed
    // move-in cannot run on it.
    //
    // NAMING: this is about the WORK's due commitment, never the resident's
    // move-in. An earlier draft read `unresolved_timing` / "Accepted work with
    // no committed date", which sits one line away from a move-in date on the
    // same surface — a manager could reasonably read it as "no committed
    // move-in", which is the opposite situation and calls for the opposite
    // response. The code and the label both now say WORK DUE explicitly.
    const noDate = workStates.filter((s) => s.accepted && !s.due_at && s.status === "required");
    if (noDate.length && nextMoveIn) {
      out.push({ code: "work_due_commitment_missing",
        label: "Accepted work has no due date for the work itself",
        detail: `${noDate.length} accepted item${noDate.length === 1 ? "" : "s"} has no due date for the work, and the resident's move-in is committed for ${nextMoveIn.move_in_date}.` });
    }

    const missed = workStates.filter(
      (s) => s.status === "required" && s.due_at && t && new Date(s.due_at).getTime() < t);
    if (missed.length) {
      out.push({ code: "missed_commitment", label: "A commitment has been missed",
        detail: missed.map((s) => `${s.work.work_text} (due ${String(s.due_at).slice(0, 10)})`).join("; ") });
    }

    const unable = workStates.filter(
      (s) => s.latest_claim && s.latest_claim.outcome === OUTCOMES.UNABLE);
    if (unable.length) {
      out.push({ code: "unable_to_complete", label: "Work could not be completed",
        detail: unable.map((s) => `${s.work.work_text}: ${UNABLE_REASONS[s.latest_claim.unable_reason]}`).join("; ") });
    }

    const shortProof = workStates.filter(
      (s) => s.latest_claim && s.latest_claim.outcome === OUTCOMES.COMPLETED && !s.latest_claim.proof_satisfied);
    if (shortProof.length) {
      out.push({ code: "proof_missing", label: "Completion claimed without the required proof",
        detail: shortProof.map((s) => `${s.work.work_text}: ${s.latest_claim.proof_shortfall}`).join("; ") });
    }

    // Reopened work is only an exception when a committed move-in is exposed.
    // A reopen with no move-in is ordinary rework.
    const reopened = workStates.filter((s) => s.reopened_count > 0 && s.status === "required");
    if (reopened.length && nextMoveIn) {
      out.push({ code: "reopened_threatens_move_in", label: "Reopened work with a committed move-in",
        detail: `${reopened.length} reopened item${reopened.length === 1 ? "" : "s"} outstanding, move-in ${nextMoveIn.move_in_date} — ${nextMoveIn.days_remaining} days remaining.` });
    }

    return out;
  }

  return {
    proposeCommitment, acceptWork, claimCompletion, reopenWork,
    readWorkState, readUnitFlow, workExceptions,
    proofRequirementFor, OBLIGATION_TYPE,
  };
}

module.exports = { makeWorkAcceptanceService, proposeCommitment, OBLIGATION_TYPE };
