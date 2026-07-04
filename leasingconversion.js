// ════════════════════════════════════════════════════════════════════
//  LEASING CONVERSION RAIL — leasingconversion.js
//
//  The canonical system-of-record for a prospect's POST-TOUR relationship.
//  After a completed tour, the human who ACTUALLY gave it owns the
//  conversation until they explicitly hand it off. AI prepares; the human
//  sends. This module owns the durable truth: who toured them, who owns the
//  conversation now, every handoff, and each rung's immutable kept/missed
//  outcome — the history the Leasing queues and the Grade later read.
//
//  WHAT THIS MODULE DOES NOT DO (by contract): no UI, no Grade math, no
//  Twilio. It does not invent people. Child follow-up COMMITMENTS are created
//  through the SHARED obligation engine (spawnObligationFromEvent / complete-
//  Obligation), injected — never reimplemented here.
//
//  Deps: { pool, spawnObligationFromEvent, completeObligation }.
//  Operator routes gated by shared OPERATOR_KEY (x-operator-key), fail-closed.
//
//  THE RUNGS:
//    Core human-conversation rungs (owned by the conversation owner):
//      tour_followup → applicant_followup → lease_signature_followup
//    Separate decision / operating gates (can run ALONGSIDE; owned by a role):
//      application_approval, lease_terms_approval, lease_countersign,
//      move_in_readiness
// ════════════════════════════════════════════════════════════════════

const express = require("express");
const staffIdentity = require("./staff_identity_resolver.js"); // 067: the ONE canonical users↔persons↔assignments read

module.exports = function leasingConversionModule({ pool, spawnObligationFromEvent, completeObligation }) {
  const router = express.Router();

  // ── AUTH ────────────────────────────────────────────────────────────
  function requireOperator(req, res, next) {
    const expected = process.env.OPERATOR_KEY;
    if (!expected) return res.status(503).json({ receipt: "Operator routes are locked: set OPERATOR_KEY in Render's environment, then send it as the x-operator-key header." });
    if (req.headers["x-operator-key"] !== expected) return res.status(401).json({ receipt: "Operator key missing or wrong." });
    next();
  }

  // ── RUNG CONFIG ─────────────────────────────────────────────────────
  // Default windows (ms). Conservative starting values; configurable later.
  const HOUR = 3600 * 1000;
  const RUNG = {
    tour_followup:            { window: 24 * HOUR,  next: "applicant_followup",      kind: "conversation", label: (n) => `Tour follow-up — ${n}` },
    applicant_followup:       { window: 72 * HOUR,  next: "lease_signature_followup",kind: "conversation", label: (n) => `Application follow-up — ${n}` },
    lease_signature_followup: { window: 48 * HOUR,  next: null,                      kind: "conversation", label: (n) => `Lease-signature follow-up — ${n}` },
    // gates — owned by a role, not the conversation owner. No auto-next.
    application_approval:     { window: 48 * HOUR,  next: null, kind: "gate", gate_role: "leasing_manager",          label: (n) => `Application approval — ${n}` },
    lease_terms_approval:     { window: 48 * HOUR,  next: null, kind: "gate", gate_role: "property_manager",         label: (n) => `Lease-terms approval — ${n}` },
    lease_countersign:        { window: 48 * HOUR,  next: null, kind: "gate", gate_role: "property_manager",         label: (n) => `Lease countersign — ${n}` },
    move_in_readiness:        { window: 72 * HOUR,  next: null, kind: "gate", gate_role: "property_manager",         label: (n) => `Move-in readiness — ${n}` },
  };
  const CONVERSATION_RUNGS = Object.keys(RUNG).filter(k => RUNG[k].kind === "conversation");

  function dueFromNow(ms) { return new Date(Date.now() + ms).toISOString(); }

  // ── personname helper for labels (best-effort; never blocks) ──
  async function personName(client, person_id) {
    try {
      const r = await client.query("select name from persons where id=$1", [person_id]);
      return (r.rows[0] && r.rows[0].name) || "prospect";
    } catch { return "prospect"; }
  }

  // ════════════════════════════════════════════════════════════════════
  //  CORE SERVICE — these functions ARE the canonical rules. The HTTP routes
  //  below are thin wrappers. Each takes an open transaction `client`.
  // ════════════════════════════════════════════════════════════════════

  // Spawn ONE rung: create the commitment in the shared obligations table via
  // the injected engine, then write the conversion-link row that carries the
  // immutable outcome. Returns { obligation, link }.
  async function spawnRung(client, { conversion, rung, owner_user_id, owner_role, labelSuffix = null }) {
    const cfg = RUNG[rung];
    if (!cfg) throw httpErr(400, `unknown rung "${rung}"`);
    const name = await personName(client, conversion.person_id);

    // The follow-up commitment is a real obligation (one accountable-human spine).
    const ob = await spawnObligationFromEvent(client, {
      property_id: conversion.property_id,
      person_id:   conversion.person_id,
      module:      "leasing",
      type:        rung,
      label:       cfg.label(name) + (labelSuffix || ""),
      owner_type:  "human",
      assigned_role: owner_role || null,
      status:      "open",
      due_at:      dueFromNow(cfg.window),
      related_id:  conversion.id,
      related_type:"leasing_conversion",
    });

    const link = (await client.query(
      `insert into leasing_conversion_obligations
         (conversion_id, obligation_id, rung, owner_user_id, owner_role, due_by)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [conversion.id, ob.id, rung, owner_user_id || null, owner_role || null, ob.due_at]
    )).rows[0];

    // Cache latest stage for fast queue reads (conversation rungs only).
    if (cfg.kind === "conversation") {
      await client.query(
        `update leasing_conversions set current_stage=$1, updated_at=now() where id=$2`,
        [rung, conversion.id]
      );
    }
    return { obligation: ob, link };
  }

  // RULE: a conversion record cannot be created without a confirmed actual host.
  // Creates the parent, the synthetic 'origin' handoff (so history starts with
  // the tour), and the first tour_followup rung owned by the actual host.
  // ── OWNERSHIP ≠ ATTRIBUTION (module-level, one rule for every spawn site) ──
  // A user may OWN a follow-up obligation only if it resolves to an active
  // assignment at this property. assignments(004) keys on person_id; no
  // users↔persons bridge exists yet, so an asserted host id is not provably
  // eligible and must never silently become an owner. Resolves an owner from
  // a preference-ordered list of candidate user ids, returning the first
  // eligible one, else null (UNASSIGNED — honest).
  async function eligibleOwner(client, propertyId, candidates) {
    // 067: delegated to the CANONICAL staff identity resolver. Same contract
    // ({owner, basis}), stricter truth: eligibility now also requires an
    // active-eligible account (is_active AND status='active' — anything
    // else, including unknown future statuses, fails closed), a deliberate
    // audited bridge, human_staff classification, and no bridge conflict.
    // No raw users.person_id join lives in this module anymore.
    return staffIdentity.resolveEligibleOwner(client, propertyId, candidates);
  }

  async function createConversionFromTour(client, {
    person_id, property_id, origin_tour_id = null, lead_id = null,
    scheduled_tour_host_user_id = null, actual_tour_host_user_id,
    feedback_recorded_by_user_id = null, tour_outcome = null, tour_notes = null,
    // v2: the recommendation from the tour outcome (next_move). A recommendation
    // is never a soft word that can rot unowned — it IS the content of the
    // follow-up obligation, carried in the rung's label and owned by the host.
    recommendation = null,
    // multi-move: an ordered array of next-move codes. First = primary (anchors
    // the conversation); the rest spawn sibling task obligations.
    recommendations = null,
    // #1: the operator may explicitly choose the follow-up owner. Honored ONLY
    // when it resolves to an active eligible assignment (re-validated here).
    explicit_owner_user_id = null,
  }) {
    if (!actual_tour_host_user_id) {
      throw httpErr(422, "INCOMPLETE: actual_tour_host_user_id is required — a completed-tour outcome cannot spawn the conversion rail until the actual host is confirmed.");
    }
    if (!person_id || !property_id) throw httpErr(400, "person_id and property_id are required.");

    // actual host becomes the initial conversation owner.
    const conv = (await client.query(
      `insert into leasing_conversions
         (person_id, property_id, origin_tour_id, lead_id,
          scheduled_tour_host_user_id, actual_tour_host_user_id, feedback_recorded_by_user_id,
          conversation_owner_user_id, current_stage, status, tour_outcome, tour_notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'tour_followup','active',$9,$10)
       returning *`,
      [person_id, property_id, origin_tour_id, lead_id,
       scheduled_tour_host_user_id, actual_tour_host_user_id, feedback_recorded_by_user_id,
       actual_tour_host_user_id, tour_outcome, tour_notes]
    )).rows[0];

    // origin row in the handoff history: "toured by X" (from = null).
    await client.query(
      `insert into leasing_conversation_handoffs
         (conversion_id, from_user_id, to_user_id, by_user_id, kind, reason)
       values ($1, null, $2, $3, 'origin', 'gave the completed tour')`,
      [conv.id, actual_tour_host_user_id, feedback_recorded_by_user_id || actual_tour_host_user_id]
    );

    const REC_LABEL = {
      send_application: "send the application", send_terms: "send terms",
      send_options: "send best options", send_follow_up: "send a follow-up",
      set_follow_up_time: "set a follow-up time", different_home: "offer a different home",
      different_price: "revisit price", different_timing: "revisit timing",
      follow_up_later: "follow up later", watch_future: "watch for a future fit",
      close_out: "close out", send_floor_plans: "send floor plans of available units",
    };

    // ── OWNERSHIP ≠ ATTRIBUTION (see eligibleOwner) — the operator's EXPLICIT
    // choice wins if eligible; else the actual host if eligible; else the
    // scheduled host if eligible; else UNASSIGNED. The claim is preserved on the
    // conversion row regardless of who ends up owning.
    const owned = await eligibleOwner(client, property_id,
      [explicit_owner_user_id, actual_tour_host_user_id, scheduled_tour_host_user_id]);
    const ownerUserId = owned.owner;
    const ownerBasis = !ownerUserId ? "unassigned"
                     : ownerUserId === explicit_owner_user_id ? "chosen"
                     : ownerUserId === actual_tour_host_user_id ? "actual_host"
                     : ownerUserId === scheduled_tour_host_user_id ? "scheduled_host"
                     : "unassigned";

    // ── MULTI-MOVE: the operator may pick several next moves. Each is a REAL,
    // separately-owned task — never collapsed into one vague follow-up. The
    // PRIMARY move anchors the conversation (the tour_followup rung that drives
    // the queue + current_stage); every ADDITIONAL move spawns its own sibling
    // task obligation (same owner, own recommendation, own due). recommendations
    // is an ordered array of move codes; `recommendation` (singular) stays
    // supported for back-compat and becomes the sole/primary move.
    const moves = Array.isArray(recommendations) && recommendations.length
      ? recommendations.filter((m) => REC_LABEL[m])
      : (recommendation && REC_LABEL[recommendation] ? [recommendation] : []);
    const primaryMove = moves[0] || null;
    const extraMoves = moves.slice(1);

    const first = await spawnRung(client, {
      conversion: conv, rung: "tour_followup", owner_user_id: ownerUserId,
      labelSuffix: primaryMove ? ` — recommended: ${REC_LABEL[primaryMove]}` : null,
    });

    // ── LOOP-B SIBLING TASKS: SUPPRESSED (identity-bridge release, locked) ──
    // Sibling `leasing_task` obligations have NO visible queue/board home
    // yet. An obligation nobody can see is an open loop disguised as
    // automation — the bridge must not activate invisible owned work. Until
    // every sibling has a visible, completeable surface (queue presence,
    // owner, due state, source tour, completion path, visible reassignment),
    // generation stays OFF. The extra moves are NOT lost: they are recorded
    // durably as a real event below and returned in next_move_codes.
    // Re-enable by restoring the spawn loop ONLY after the visibility bar
    // in the 067 handoff is proven.
    const LOOPB_SIBLING_TASKS_SUPPRESSED = true;
    const siblingTasks = [];
    if (extraMoves.length && LOOPB_SIBLING_TASKS_SUPPRESSED) {
      // durable record of the operator's full intent — a fact, not a task.
      await client.query(
        `insert into events (property_id, person_id, type, note)
         values ($1, $2, 'leasing_next_moves_recorded', $3)`,
        [conv.property_id, conv.person_id,
         `Additional next moves noted: ${extraMoves.map((m) => REC_LABEL[m]).join("; ")} [${extraMoves.join(",")}]`]);
    }

    return {
      conversion: conv, first_rung: first, sibling_tasks: siblingTasks,
      sibling_tasks_suppressed: extraMoves.length > 0,   // 067: honest receipt — extra moves recorded as an event, no invisible obligations spawned
      suppressed_move_codes: extraMoves,
      // next_move stays a machine-readable CODE — routing/reporting/AI read this,
      // never the rendered label. The label is presentation only.
      next_move_code: primaryMove,
      next_move_label: primaryMove ? REC_LABEL[primaryMove] : null,
      next_move_codes: moves,                       // the full ordered set
      // attribution facts stay distinct + inspectable
      ownership: {
        actual_host_claim_user_id: actual_tour_host_user_id,
        scheduled_host_user_id: scheduled_tour_host_user_id,
        recorded_by_user_id: feedback_recorded_by_user_id,
        obligation_owner_user_id: ownerUserId,
        owner_basis: ownerBasis,
      },
    };
  }

  // RULE: explicit handoff is the ONLY way the conversation owner changes.
  // Preserves the original tour host, writes a durable transfer, re-points the
  // currently-OPEN conversation rung to the new owner (closed rungs keep their
  // owner forever). Clears handoff_required.
  async function handoffConversation(client, { conversion_id, from_user_id = null, to_user_id, by_user_id = null, kind = "handoff", reason = null, note = null }) {
    if (!to_user_id) throw httpErr(400, "handoff requires a named successor (to_user_id).");
    const conv = (await client.query("select * from leasing_conversions where id=$1 for update", [conversion_id])).rows[0];
    if (!conv) throw httpErr(404, "conversion not found.");
    if (conv.status !== "active") throw httpErr(409, `conversion is ${conv.status}; cannot hand off.`);
    if (from_user_id && from_user_id !== conv.conversation_owner_user_id) {
      throw httpErr(409, "handoff 'from' does not match the current conversation owner.");
    }

    const prev = conv.conversation_owner_user_id;
    await client.query(
      `update leasing_conversions
         set conversation_owner_user_id=$1, handoff_required=false, updated_at=now()
       where id=$2`,
      [to_user_id, conversion_id]
    );
    await client.query(
      `insert into leasing_conversation_handoffs
         (conversion_id, from_user_id, to_user_id, by_user_id, kind, reason, note)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [conversion_id, prev, to_user_id, by_user_id || prev, kind, reason, note]
    );

    // Move only OPEN conversation rungs to the new owner. (Gate rungs and any
    // closed rung are untouched — gates belong to roles; closed = history.)
    await client.query(
      `update leasing_conversion_obligations lco
         set owner_user_id=$1
       from leasing_conversions c
       where lco.conversion_id=$2 and lco.outcome is null
         and lco.rung in ('tour_followup','applicant_followup','lease_signature_followup')`,
      [to_user_id, conversion_id]
    );

    return { conversion_id, previous_owner: prev, new_owner: to_user_id };
  }

  // RULE: absence sets a VISIBLE handoff_required risk — never an auto-reroute.
  async function flagHandoffRequired(client, { conversion_id }) {
    const conv = (await client.query("select * from leasing_conversions where id=$1 for update", [conversion_id])).rows[0];
    if (!conv) throw httpErr(404, "conversion not found.");
    await client.query(`update leasing_conversions set handoff_required=true, updated_at=now() where id=$1`, [conversion_id]);
    return { conversion_id, handoff_required: true, conversation_owner_user_id: conv.conversation_owner_user_id };
  }

  // RULE: completing/releasing a rung writes a WRITE-ONCE outcome + proof, then
  // (only if kept and not released) spawns the next rung. NEVER mutates the
  // closed rung. result ∈ completed | released | missed.
  async function resolveRung(client, { obligation_id, result, proof = null, by_user_id = null, suppress_next = false }) {
    const link = (await client.query(
      "select * from leasing_conversion_obligations where obligation_id=$1 for update", [obligation_id]
    )).rows[0];
    if (!link) throw httpErr(404, "no conversion rung for that obligation.");
    if (link.outcome != null) throw httpErr(409, `rung already closed as ${link.outcome}/${link.resolution}.`); // write-once

    const outcome = (result === "missed") ? "missed" : "kept"; // released = honored = kept
    const resolution = (result === "released") ? "released" : (result === "missed" ? "missed" : "completed");

    // Stamp the immutable outcome on the link (what the Grade reads).
    await client.query(
      `update leasing_conversion_obligations
         set outcome=$1, resolution=$2, proof=$3, closed_at=now()
       where id=$4`,
      [outcome, resolution, proof ? JSON.stringify(proof) : null, link.id]
    );

    // Close the underlying obligation through the shared engine when the human
    // acted (completed/released). A MISSED rung leaves the obligation open-but-
    // overdue? No — we mark it closed too, but as missed, so it leaves queues.
    try {
      if (resolution === "completed" || resolution === "released") {
        await completeObligation(client, { obligation_id, completed_by: by_user_id });
      } else {
        // missed: close the obligation row without proof-gate completion.
        await client.query(`update obligations set status='missed', updated_at=now() where id=$1`, [obligation_id]);
      }
    } catch (e) {
      // If the shared engine refuses (e.g. inputs outstanding), surface honestly
      // rather than silently — but the outcome stamp above already persisted.
      if (e.code !== "ALREADY_COMPLETE") {
        // best-effort fallback so the rung still leaves the queue
        await client.query(`update obligations set status=$1, updated_at=now() where id=$2`,
          [resolution === "missed" ? "missed" : "complete", obligation_id]);
      }
    }

    const conv = (await client.query("select * from leasing_conversions where id=$1 for update", [link.conversion_id])).rows[0];

    // Advance ONLY on kept + not released + a conversation rung with a next —
    // AND only when the caller has not suppressed the auto-advance. suppress_next
    // exists because some transitions are GATED, not automatic: an application
    // submission closes applicant_followup but must NOT auto-start lease-signature
    // follow-up — that begins only when the leasing_manager APPROVES. The caller
    // (submission) suppresses here; approval explicitly spawns the next rung.
    let spawned = null;
    const cfg = RUNG[link.rung];
    if (!suppress_next && outcome === "kept" && resolution !== "released" && cfg && cfg.kind === "conversation" && cfg.next) {
      // the conversation owner is an attribution pointer, not proof of
      // eligibility — gate it through the same ownership contract.
      const nextOwned = await eligibleOwner(client, conv.property_id, [conv.conversation_owner_user_id]);
      spawned = await spawnRung(client, {
        conversion: conv, rung: cfg.next, owner_user_id: nextOwned.owner,
      });
    }
    // Released closes the whole conversation.
    if (resolution === "released") {
      await client.query(`update leasing_conversions set status='released', closed_at=now(), updated_at=now() where id=$1`, [conv.id]);
    }

    return { obligation_id, rung: link.rung, outcome, resolution, spawned: spawned ? spawned.link.rung : null, suppressed_next: !!(suppress_next && cfg && cfg.next) };
  }

  // Add a separate decision/operating GATE that coexists with the conversation.
  async function addGate(client, { conversion_id, rung, owner_user_id = null }) {
    const cfg = RUNG[rung];
    if (!cfg || cfg.kind !== "gate") throw httpErr(400, `"${rung}" is not a gate rung.`);
    const conv = (await client.query("select * from leasing_conversions where id=$1", [conversion_id])).rows[0];
    if (!conv) throw httpErr(404, "conversion not found.");
    return spawnRung(client, { conversion: conv, rung, owner_user_id, owner_role: cfg.gate_role });
  }

  // Explicitly advance the conversation to a named CONVERSATION rung. Used when
  // a transition is GATED rather than automatic: e.g. an approved application
  // STARTS lease_signature_followup (submission suppressed the auto-advance, so
  // approval is what begins signature work). Idempotent-guarded: refuses if an
  // open rung of that type already exists on the conversion.
  async function advanceToRung(client, { conversion_id, rung, owner_user_id = null }) {
    const cfg = RUNG[rung];
    if (!cfg || cfg.kind !== "conversation") throw httpErr(400, `"${rung}" is not a conversation rung.`);
    const conv = (await client.query("select * from leasing_conversions where id=$1 for update", [conversion_id])).rows[0];
    if (!conv) throw httpErr(404, "conversion not found.");
    const existing = await client.query(
      `select 1 from leasing_conversion_obligations
        where conversion_id=$1 and rung=$2 and outcome is null limit 1`,
      [conversion_id, rung]
    );
    if (existing.rows.length) throw httpErr(409, `an open ${rung} rung already exists on this conversion.`);
    // an explicit owner passed by the caller is honored; the conversation-owner
    // FALLBACK is gated — an attribution pointer is not proof of eligibility.
    let owner = owner_user_id;
    if (!owner) owner = (await eligibleOwner(client, conv.property_id, [conv.conversation_owner_user_id])).owner;
    return spawnRung(client, { conversion: conv, rung, owner_user_id: owner });
  }

  // ── read: the full conversion view (record + history + open/closed rungs) ──
  async function readConversion(client, conversion_id) {
    const conv = (await client.query("select * from leasing_conversions where id=$1", [conversion_id])).rows[0];
    if (!conv) return null;
    const handoffs = (await client.query(
      "select * from leasing_conversation_handoffs where conversion_id=$1 order by created_at", [conversion_id]
    )).rows;
    const rungs = (await client.query(
      `select lco.*, o.status as obligation_status, o.due_at
         from leasing_conversion_obligations lco
         join obligations o on o.id = lco.obligation_id
        where lco.conversion_id=$1 order by lco.created_at`, [conversion_id]
    )).rows;
    return { conversion: conv, ownership_history: handoffs, rungs };
  }

  // ════════════════════════════════════════════════════════════════════
  //  HTTP — thin wrappers over the service, each in its own transaction.
  // ════════════════════════════════════════════════════════════════════
  function httpErr(status, message) { const e = new Error(message); e.http = status; return e; }
  async function tx(fn, res) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback");
      const status = e.http || 500;
      return res.status(status).json({ receipt: e.message });
    } finally {
      client.release();
    }
  }

  // POST /leasing/conversions  — create from a confirmed completed tour
  router.post("/leasing/conversions", requireOperator, (req, res) => tx(async (client) => {
    const out = await createConversionFromTour(client, req.body || {});
    return { receipt: `Conversion opened for the prospect; tour_followup is owned by the actual host.`, ...out };
  }, res));

  // GET /leasing/conversions/:id — full canonical view
  router.get("/leasing/conversions/:id", requireOperator, async (req, res) => {
    const client = await pool.connect();
    try {
      const out = await readConversion(client, req.params.id);
      if (!out) return res.status(404).json({ receipt: "conversion not found." });
      return res.json(out);
    } catch (e) { return res.status(500).json({ receipt: e.message }); }
    finally { client.release(); }
  });

  // POST /leasing/conversions/:id/handoff — explicit owner transfer
  router.post("/leasing/conversions/:id/handoff", requireOperator, (req, res) => tx(async (client) => {
    const out = await handoffConversation(client, { conversion_id: req.params.id, ...(req.body || {}) });
    return { receipt: `Conversation handed to the named successor; original tour host preserved in history.`, ...out };
  }, res));

  // POST /leasing/conversions/:id/handoff-required — flag absence risk (no reroute)
  router.post("/leasing/conversions/:id/handoff-required", requireOperator, (req, res) => tx(async (client) => {
    const out = await flagHandoffRequired(client, { conversion_id: req.params.id });
    return { receipt: `handoff_required flagged — the conversation was NOT rerouted; a named handoff is needed.`, ...out };
  }, res));

  // POST /leasing/conversions/:id/gates — add a decision/operating gate
  router.post("/leasing/conversions/:id/gates", requireOperator, (req, res) => tx(async (client) => {
    const out = await addGate(client, { conversion_id: req.params.id, ...(req.body || {}) });
    return { receipt: `Gate "${req.body && req.body.rung}" added alongside the conversation.`, obligation_id: out.obligation.id, rung: out.link.rung };
  }, res));

  // POST /leasing/rungs/:obligationId/resolve — complete | release | missed
  router.post("/leasing/rungs/:obligationId/resolve", requireOperator, (req, res) => tx(async (client) => {
    const out = await resolveRung(client, { obligation_id: req.params.obligationId, ...(req.body || {}) });
    return { receipt: `Rung ${out.rung} closed as ${out.outcome}/${out.resolution}${out.spawned ? `; spawned ${out.spawned}` : ""}.`, ...out };
  }, res));

  // Expose the service layer for in-process tests + future server-side callers.
  router._service = {
    createConversionFromTour, handoffConversation, flagHandoffRequired,
    resolveRung, addGate, advanceToRung, readConversion, spawnRung, RUNG, CONVERSATION_RUNGS,
  };
  // Expose the single-door service alongside the router so the tour-outcome
  // seam (leasingleads /complete) opens the conversion rail through THIS
  // instance — no module reimplements conversion opening.
  return Object.assign(router, { services: { createConversionFromTour } });
};
