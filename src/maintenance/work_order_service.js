//  The routed follow-up vocabulary, so a clarification or a dedupe never lands on a
//  follow-up that merely shares the work order link.
const { FOLLOW_UP_TYPES } = require("./not_done_reasons");
// ════════════════════════════════════════════════════════════════════
//  work_order_service.js — THE ONE CANONICAL WORK-ORDER CREATION PATH
//
//  Ruling (sign-off): every work order — tenant, operator, or future
//  channel — flows through this service. No route coordinates low-level
//  writes on its own. Each call produces, in one caller-owned transaction:
//      · the work order (original text preserved VERBATIM)
//      · source-neutral urgency truth (status / basis / decided_by / at)
//      · a routing obligation for EVERY work order (owner or honest UNASSIGNED)
//      · a trigger event (the trail)
//  and appendClarification() adds append-only history to the SAME open loop,
//  escalating the SAME work order + obligation if a clarification establishes
//  an emergency. The original description is never overwritten.
//
//  Injected deps: { spawnObligationFromEvent }  (the shared engine helper)
//  The emergency vocabulary + category derivation live here so the ONE
//  service owns them; maintenance.js and tenant_link.js both call in.
// ════════════════════════════════════════════════════════════════════

// ── The fixed emergency list (mirrors the operator vocabulary) ──
const EMERGENCY_TYPES = {
  active_leak:       { label: "Active leak / flood",            urgency: "immediate" },
  flood:             { label: "Flood",                          urgency: "immediate" },
  no_heat:           { label: "No heat",                        urgency: "same_day"  },
  no_hot_water:      { label: "No hot water (urgent)",          urgency: "same_day"  },
  electrical_hazard: { label: "Electrical hazard",              urgency: "immediate" },
  fire_life_safety:  { label: "Fire alarm / life safety",       urgency: "immediate" },
  lockout:           { label: "Lockout",                        urgency: "immediate" },
  security_issue:    { label: "Broken exterior door / security",urgency: "same_day"  },
  sewer_backup:      { label: "Sewer backup",                   urgency: "high"      },
  roof_leak:         { label: "Roof leak",                      urgency: "high"      },
  major_appliance:   { label: "Major appliance failure (urgent)",urgency: "high"     },
  manager_override:  { label: "Marked emergency by manager",    urgency: "immediate" },
};
const EMERGENCY_CHAIN = ["on_call_maintenance", "maintenance", "property_manager", "owner"];

const urgencyToDueAt = (urgency) => {
  const mins = { immediate: 0, same_day: 8 * 60, high: 24 * 60 }[urgency] ?? 24 * 60;
  return new Date(Date.now() + mins * 60 * 1000);
};
// obligations.priority allows only low|normal|high. All emergency tiers are high.
const urgencyToPriority = (urgency) => (urgency ? "high" : "normal");

// ── deriveCategories — NO LONGER ON THE WORK-ORDER PATH ─────────────
//
//  ⚠ SURVIVES FOR ONE CALLER ONLY: the supply-requests route, which still
//  carries an operating_category of its own. Decomposing the supply request the
//  way migration 098 decomposed the work order is separate, unstarted work.
//
//  createWorkOrder does NOT call this. A work order records OBSERVATIONS
//  (tenant_caused, work_nature, extends_useful_life, cause) and derives no
//  category at all — see migration 098 and the module header for why each
//  derived column left. Do not reintroduce a call to this from the work-order
//  path; that is the thing that was removed.
//
//  HISTORY, kept because it is the reason for the rule. Two functions with this
//  name once disagreed: a stub in this file that ignored unit_state and cause
//  and always returned resident_repair / is_capex:false / billback:false, and
//  the real engine in maintenance.js reachable only through
//  GET /maintenance/preview-category. The STUB was the one inside
//  createWorkOrder. So an operator previewed "tenant billback", pressed save,
//  and got an ordinary resident repair — money owed by a resident silently
//  expensed to the property, renovation work expensed instead of capitalized.
//  Consolidating them was right, but consolidation was not the real fix: the
//  work order should never have been authoring money meaning in the first
//  place. Migration 098 finished the job.
//
//  REMOVAL CONDITION (§18 Class 4): delete this function when the supply
//  request records observations instead of a derived operating_category.
function deriveCategories({ field_category, unit_state, cause, is_emergency }) {
  const fc = (field_category || "general").toLowerCase();

  // Operating category — what the PM sees.
  let operating_category;
  if (cause === "tenant_damage") {
    operating_category = "tenant_billback";
  } else if (unit_state === "renovation") {
    operating_category = "capital";
  } else if (unit_state === "vacant") {
    operating_category = "turn";
  } else {
    operating_category = "resident_repair";   // occupied / default
  }

  // NO gl_category. A work order does not author money meaning.
  //
  //  This function used to derive and store a per-trade GL string
  //  (`capex_flooring`, `tenant_billback_drywall`, `turn_paint`,
  //  `plumbing_repairs`). That inverted the layering: money is a layer
  //  THROUGH capture surfaces, reporting READS confirmed truth and never
  //  authors it, and maintenance ended up owning a chart it has no authority
  //  over. migrations/019_vendor_property_categories.sql already ruled this,
  //  in its own header: "Resolution order, applied at read time, NEVER
  //  STORED" and "the category vocabulary stays DATA". Storing a computed
  //  gl_category contradicted a rule that already existed.
  //
  //  It also crushed two axes into one string. Whether the property or the
  //  tenant bears a cost is a BILLBACK fact; which account it hits is an
  //  ACCOUNTING fact. `tenant_billback_drywall` fused them — and the live
  //  chart proves the point: category_report_map maps `tenant_billback` to
  //  report_section 'Income', not to an expense line at all. One field could
  //  not carry both without lying about one.
  //
  //  What this returns now is only what the work order actually KNOWS:
  //  operating context, capital-in-nature, and tenant-caused. GL resolution
  //  is a mapping applied at read, owned by the reporting layer where
  //  category_report_map lives.
  //
  //  The gl_category COLUMN is deliberately left in place and simply unwritten
  //  until step 5's single migration — one design change should not cost two
  //  migrations. Rows created from now on carry null there, honestly.
  return {
    operating_category,
    is_capex: operating_category === "capital",
    billback: operating_category === "tenant_billback",
  };
}

const URGENCY_STATUSES = ["emergency", "regular", "needs_confirmation"];
const DECIDED_BY = ["system", "resident_clarification", "operator"];

// ── CLOSED OPERATIONAL VOCABULARIES ─────────────────────────────────
//  Same discipline as EMERGENCY_TYPES and NOT_DONE_REASONS: a fixed list that
//  REFUSES what it does not recognise. `cause` is an operational observation
//  ONLY — nothing derives money meaning from it, so a typo can no longer
//  silently change how a cost is treated (which is exactly what the old
//  free-text `cause === "tenant_damage"` derivation allowed).
//
//  Mirrored by ck_wo_cause / ck_wo_work_nature in migration 098. The DB is the
//  structural backstop; these give the caller an honest 400 naming the set.
const CAUSES = [
  "normal_wear",        // ordinary aging and use
  "equipment_failure",  // a component failed
  "accident",           // unintentional damage
  "improper_use",       // used in a way it was not meant to be
  "vandalism",          // deliberate damage — distinct from improper_use by
                        // intent, and often by a third party rather than the resident
  "weather",            // storm, freeze, water from outside
  "end_of_life",        // reached the end of its service life
  "unknown",            // honestly not established
];
const WORK_NATURES = ["repair", "replacement"];

// ── THE BILLBACK RAIL ───────────────────────────────────────────────
//  An OBSERVATION (`tenant_caused`) is not a billback. Whether the property
//  charges a resident is a DECISION with an owner, an actor, a time and a
//  reason, reversible only by a correction that preserves what it corrected.
//  See migration 099 for the full shape and for what is deliberately not built.
const BILLBACK_DECISIONS = ["bill_back", "do_not_bill_back"];
const BILLBACK_OBLIGATION_TYPE = "billback_decision";

function makeWorkOrderService(deps) {
  const { spawnObligationFromEvent, satisfyObligation, transitionObligation } = deps;
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("work_order_service requires spawnObligationFromEvent()");
  }
  // appendClarification resolves an urgency question, which means satisfying
  // the stale required input and retyping the obligation. Both are shared
  // engine services — this module must never hand-roll either, or the
  // clarification path becomes a second obligation implementation.
  if (typeof satisfyObligation !== "function" || typeof transitionObligation !== "function") {
    throw new Error("work_order_service requires satisfyObligation() and transitionObligation()");
  }

  // ── Obligation spec per urgency — the routing intent for EVERY WO. ──
  //  assigned_role='maintenance' always; the engine resolves the person, or
  //  leaves it UNASSIGNED when no eligible maintenance person exists. That
  //  unresolved-but-owned-by-role state IS the honest UNASSIGNED.
  function obligationSpecFor(urgency_status, emDef, workOrder, ids) {
    const base = {
      property_id: ids.property_id,
      person_id: ids.person_id ?? null,
      unit_id: ids.unit_id ?? null,
      source_event_id: ids.source_event_id,
      module: "maintenance",
      owner_type: "human",
      assigned_role: "maintenance",
      status: "open",
      related_id: workOrder.id,
      related_type: "work_order",
    };
    if (urgency_status === "emergency") {
      return {
        ...base,
        type: "emergency_repair",
        label: `EMERGENCY: ${emDef.label} — needs on-call to own it`,
        escalates_to_role: "property_manager",
        due_at: urgencyToDueAt(emDef.urgency),
        priority: urgencyToPriority(emDef.urgency),
        severity: "emergency",
        required_inputs: ["closeout_proof"],
      };
    }
    if (urgency_status === "needs_confirmation") {
      return {
        ...base,
        type: "confirm_urgency",
        label: "Maintenance request — urgency needs confirmation",
        priority: "normal",
        severity: "normal",
        required_inputs: ["urgency_confirmation"],
      };
    }
    // regular
    return {
      ...base,
      type: "maintenance_repair",
      label: "Maintenance request",
      priority: "normal",
      severity: "normal",
      required_inputs: ["closeout_proof"],
    };
  }

  // ── CREATE: the one path. Caller owns the transaction (client). ──
  async function createWorkOrder(client, spec) {
    const {
      property_id, unit_id = null,
      // TWO people, never one. Frequently the same human; sometimes not — a
      // neighbour reports a leak coming through a shared wall.
      reported_by_person_id = null, affected_person_id = null,
      title, description = null,
      field_category = null, cause = null, est_cost = null,
      // OBSERVATIONS the work order legitimately knows. All optional: an
      // unobserved fact stays null. It never becomes false to keep a form tidy.
      tenant_caused = null, work_nature = null, extends_useful_life = null,
      assigned_to = null,
      source,                       // 'tenant' | 'operator' | future
      urgency_status,               // required, source-neutral
      urgency_basis = null,
      urgency_decided_by = "system",
      emergency_type = null,
    } = spec;

    if (!property_id) throw Object.assign(new Error("property_id is required"), { httpStatus: 400 });
    if (!title) throw Object.assign(new Error("title is required"), { httpStatus: 400 });
    if (!URGENCY_STATUSES.includes(urgency_status))
      throw Object.assign(new Error("valid urgency_status is required"), { httpStatus: 400 });
    if (!DECIDED_BY.includes(urgency_decided_by))
      throw Object.assign(new Error("invalid urgency_decided_by"), { httpStatus: 400 });

    // ── closed vocabularies, refused in the service, not by a DB constraint ──
    //  The DB check constraints are the structural backstop. These give the
    //  caller an honest 400 that NAMES the allowed set, the same discipline as
    //  EMERGENCY_TYPES and NOT_DONE_REASONS. A caller should learn what is
    //  allowed from the refusal, not from a 500.
    if (cause !== null && !CAUSES.includes(cause))
      throw Object.assign(new Error("invalid cause"), { httpStatus: 400, allowed: CAUSES });
    if (work_nature !== null && !WORK_NATURES.includes(work_nature))
      throw Object.assign(new Error("invalid work_nature"), { httpStatus: 400, allowed: WORK_NATURES });

    const is_emergency = urgency_status === "emergency";
    let emDef = null;
    if (is_emergency) {
      emDef = EMERGENCY_TYPES[emergency_type];
      if (!emDef) throw Object.assign(
        new Error("emergency_type required for emergency work order"),
        { httpStatus: 400, allowed: Object.keys(EMERGENCY_TYPES) });
    }

    // reference validation (clear errors)
    const prop = await client.query("select id from properties where id=$1", [property_id]);
    if (prop.rows.length === 0) throw Object.assign(new Error("property not found"), { httpStatus: 404 });
    if (unit_id) {
      const u = await client.query("select id from units where id=$1", [unit_id]);
      if (u.rows.length === 0) throw Object.assign(new Error("unit not found"), { httpStatus: 404 });
    }
    for (const [label, pid] of [["reported_by_person_id", reported_by_person_id],
                                ["affected_person_id", affected_person_id]]) {
      if (!pid) continue;
      const p = await client.query("select id from persons where id=$1", [pid]);
      if (p.rows.length === 0)
        throw Object.assign(new Error(`person not found (${label})`), { httpStatus: 404 });
    }

    // ── Idempotency: a client-supplied key makes retries safe. If a work order
    //    with this key already exists, return it (and its obligation) — NO new
    //    work order, NO new obligation. The unique index makes a concurrent race
    //    fail the loser rather than duplicate.
    //    Keyed on the REPORTER: the same person re-sending the same request is
    //    the retry this protects against.
    const idempotency_key = spec.idempotency_key ?? null;
    if (idempotency_key) {
      const dup = (await client.query(
        `select * from work_orders
          where idempotency_key=$1 and property_id=$2
            and reported_by_person_id is not distinct from $3`,
        [idempotency_key, property_id, reported_by_person_id])).rows[0];
      if (dup) {
        //  The work order's OWN obligation — not the billback decision or a
        //  routed follow-up, which share the link and, born in the same
        //  transaction, share created_at with it. Same exclusion the status
        //  read applies.
        const obl = (await client.query(
          `select * from obligations where related_type='work_order' and related_id=$1
            and type <> 'billback_decision' and not (type = any($2::text[]))
            order by created_at asc limit 1`,
          [dup.id, FOLLOW_UP_TYPES])).rows[0] || null;
        return { workOrder: dup, event: null, obligation: obl, deduped: true };
      }
    }

    // 1) the work order — description stored VERBATIM; urgency truth is source-neutral.
    const wo = (await client.query(
      `insert into work_orders
         (property_id, unit_id, reported_by_person_id, affected_person_id, title, description,
          status, assigned_to, source,
          field_category, cause,
          tenant_caused, work_nature, extends_useful_life,
          is_emergency, est_cost, needs_pm_review,
          urgency_status, urgency_basis, urgency_decided_by, urgency_decided_at, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20)
       returning *`,
      [property_id, unit_id, reported_by_person_id, affected_person_id, title, description,
       assigned_to, source,
       field_category, cause,
       tenant_caused, work_nature, extends_useful_life,
       is_emergency, est_cost, is_emergency,
       urgency_status, urgency_basis, urgency_decided_by, idempotency_key])).rows[0];

    // 2) the trigger event (uniform trail; carries the WO link + urgency)
    const noteObj = {
      work_order_id: wo.id, urgency_status, urgency_basis,
      emergency_type: is_emergency ? emergency_type : null,
      emergency_label: emDef ? emDef.label : null,
      escalation_chain: is_emergency ? EMERGENCY_CHAIN : null,
    };
    const evType = is_emergency ? "emergency_work_order" : "work_order_opened";
    const ev = (await client.query(
      // The event carries the AFFECTED person: the relationship spine is about
      // whose home this happened to, not who happened to phone it in. When only
      // a reporter is known, that is the best available relationship anchor.
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning *`,
      [property_id, affected_person_id ?? reported_by_person_id, unit_id,
       evType, JSON.stringify(noteObj)])).rows[0];

    // 3) the routing obligation — for EVERY work order (owner or honest UNASSIGNED)
    const obligation = await spawnObligationFromEvent(
      client,
      obligationSpecFor(urgency_status, emDef, wo, {
        property_id, unit_id, source_event_id: ev.id,
        // the obligation hangs off the affected relationship for the same reason
        person_id: affected_person_id ?? reported_by_person_id,
      })
    );

    // 4) THE OBSERVATION OWES A DECISION.
    //    tenant_caused === true is an observation, never a billback. It spawns
    //    an obligation someone must answer, in THIS transaction — so a work
    //    order asserting the resident caused the damage cannot exist without a
    //    named human owing a decision about it. Strictly `=== true`: an
    //    unobserved cause (null) is not an accusation and owes nothing.
    let billbackObligation = null;
    if (tenant_caused === true) {
      billbackObligation = await spawnBillbackDecision(client, { workOrder: wo, event: ev });
    }

    return { workOrder: wo, event: ev, obligation, billbackObligation };
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE BILLBACK RAIL
  //
  //  observation (tenant_caused=true)
  //    → obligation 'billback_decision'   someone OWES an answer
  //      → a decision entry               attributed, dated, reasoned
  //        → a correction entry           reverses without overwriting
  //
  //  Nothing here posts money. A decision to bill back is a decision; turning
  //  it into money is a separate rung that does not exist.
  // ══════════════════════════════════════════════════════════════════

  //  Spawned from the observation, inside the SAME transaction as the work
  //  order — so a work order that says "the resident caused this" can never
  //  exist without someone owing a decision about it.
  async function spawnBillbackDecision(client, { workOrder, event }) {
    return spawnObligationFromEvent(client, {
      property_id: workOrder.property_id,
      person_id: workOrder.affected_person_id ?? workOrder.reported_by_person_id ?? null,
      unit_id: workOrder.unit_id ?? null,
      source_event_id: event ? event.id : null,
      module: "maintenance",
      type: BILLBACK_OBLIGATION_TYPE,
      label: `Decide whether to bill this back — ${workOrder.title || "work order"}`,
      // A machine may not decide to charge a resident.
      owner_type: "human",
      assigned_role: "property_manager",
      escalates_to_role: "owner",
      status: "open",                       // BORN OPEN. never born complete.
      priority: "normal",
      severity: "normal",
      // Honestly null. There is no defensible SLA for deciding a billback, and
      // an invented clock would be a fake number. Note that no operator surface
      // lists this obligation yet either — see migration 099, note 4. That is a
      // missing surface, not a missing clock.
      due_at: null,
      required_inputs: ["billback_decision"],
      related_id: workOrder.id,
      related_type: "work_order",
      // Provenance, so "nobody is eligible" and "nobody asked" are different
      // facts. ck_oblig_billback_ownership enforces the pairing.
      ownership_origin: "observation_spawn",
      owner_eligibility_state: "unassigned",
      // One decision per work order, so a retry cannot produce a second.
      dedupe_key: `billback_decision:${workOrder.id}`,
    });
  }

  //  Shared writer for both a decision and a correction. Append-only: there is
  //  deliberately no update path and no delete path on this table, here or
  //  anywhere else.
  async function appendBillbackEntry(client, {
    work_order_id, entry_kind, decision, actor_user_id,
    reason, amount_cents = null, supersedes_id = null,
  }) {
    if (!work_order_id) throw Object.assign(new Error("work_order_id is required"), { httpStatus: 400 });
    if (!BILLBACK_DECISIONS.includes(decision))
      throw Object.assign(new Error("invalid billback decision"), { httpStatus: 400, allowed: BILLBACK_DECISIONS });
    // Every entry says WHY. A charge with no stated reason is a silent charge.
    if (!reason || !String(reason).trim())
      throw Object.assign(new Error("a reason is required for a billback decision"), { httpStatus: 400 });
    // A human decided, or it did not happen.
    if (!actor_user_id)
      throw Object.assign(new Error("actor_user_id is required — a billback decision needs a human actor"), { httpStatus: 400 });
    // Never a placeholder zero. Absent cost stays absent.
    if (amount_cents !== null && !(Number(amount_cents) > 0))
      throw Object.assign(new Error("amount_cents must be a positive amount or null — never zero-filled"), { httpStatus: 400 });

    const wo = (await client.query(
      "select id, property_id from work_orders where id=$1", [work_order_id])).rows[0];
    if (!wo) throw Object.assign(new Error("work order not found"), { httpStatus: 404 });

    const obl = (await client.query(
      `select id, status from obligations
        where related_type='work_order' and related_id=$1 and type=$2
        order by created_at asc limit 1`,
      [work_order_id, BILLBACK_OBLIGATION_TYPE])).rows[0] || null;

    const row = (await client.query(
      `insert into work_order_billback_decisions
         (work_order_id, property_id, entry_kind, decision, amount_cents,
          reason, actor_user_id, supersedes_id, source_obligation_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [work_order_id, wo.property_id, entry_kind, decision, amount_cents,
       String(reason).trim(), actor_user_id, supersedes_id, obl ? obl.id : null])).rows[0];

    // The first decision satisfies the obligation and CLOSES IT SAYING HOW.
    // Deciding NOT to charge closes it too — that is a decision, not an
    // absence of one.
    if (entry_kind === "decision" && obl && obl.status !== "complete") {
      await client.query(
        `update obligations
            set status='complete', completed_at=now(), resolution_code='satisfied', updated_at=now()
          where id=$1`, [obl.id]);
    }
    return row;
  }

  const recordBillbackDecision = (client, spec) =>
    appendBillbackEntry(client, { ...spec, entry_kind: "decision", supersedes_id: null });

  //  A reversal is a NEW entry pointing at the one it supersedes. The original
  //  is never touched: current reads may change, history may not.
  async function recordBillbackCorrection(client, spec) {
    if (!spec || !spec.supersedes_id)
      throw Object.assign(new Error("supersedes_id is required — a correction must say what it corrects"), { httpStatus: 400 });
    return appendBillbackEntry(client, { ...spec, entry_kind: "correction" });
  }

  //  CURRENT STATE IS A READ, never a stored status. The latest entry that
  //  nothing supersedes wins. `disputed` is derived here rather than living in
  //  ck_obl_status, which every obligation in the system shares.
  async function readBillbackState(db, { work_order_id }) {
    const rows = (await db.query(
      `select * from work_order_billback_decisions
        where work_order_id=$1 order by created_at asc, id asc`, [work_order_id])).rows;
    if (rows.length === 0) return null;              // no decision exists yet
    const superseded = new Set(rows.map((r) => r.supersedes_id).filter(Boolean));
    const decisions = rows.filter((r) => r.entry_kind !== "dispute" && !superseded.has(r.id));
    const current = decisions[decisions.length - 1] || null;
    const lastDispute = [...rows].reverse().find((r) => r.entry_kind === "dispute") || null;

    // Separation of duties is made VISIBLE, not enforced. On a small team the
    // same human legitimately observes and decides; a control that gets worked
    // around teaches people to work around controls. So we surface it.
    const wo = (await db.query(
      "select reported_by_person_id, tenant_caused from work_orders where id=$1",
      [work_order_id])).rows[0] || {};
    const observer = (await db.query(
      `select note from events
        where type in ('emergency_work_order','work_order_opened')
          and note::text like '%' || $1 || '%' limit 1`, [work_order_id])).rows[0] || null;

    return {
      work_order_id,
      decision: current ? current.decision : null,
      amount_cents: current ? current.amount_cents : null,   // null is normal
      entry_id: current ? current.id : null,
      decided_by: current ? current.actor_user_id : null,
      decided_at: current ? current.created_at : null,
      reason: current ? current.reason : null,
      corrected: !!(current && current.entry_kind === "correction"),
      disputed: !!(lastDispute && current && lastDispute.created_at > current.created_at),
      // visible, not prevented — see above
      observed_by_same_actor:
        !!(current && observer && String(observer.note || "").includes(String(current.actor_user_id))),
      history: rows.map((r) => ({
        id: r.id, kind: r.entry_kind, decision: r.decision, amount_cents: r.amount_cents,
        actor_user_id: r.actor_user_id, actor_person_id: r.actor_person_id,
        reason: r.reason, supersedes_id: r.supersedes_id, created_at: r.created_at,
      })),
    };
  }

  //  There is deliberately NO recordBillbackDispute here. The table accepts the
  //  shape so we do not migrate twice, but a dispute needs a resident-facing
  //  surface that does not exist and has not been approved. Dormant by design,
  //  not by omission. See migration 099, note 1.

  // ── APPEND: clarification as history on the SAME open loop. ──
  //  Original description is NEVER overwritten. If the clarification (via the
  //  narrow classifier) establishes an emergency, escalate the SAME work order
  //  and the SAME obligation.
  //  THREE OUTCOMES, one canonical implementation, shared by the SMS door and
  //  the browser door alike. The prior version had five defects: it never
  //  transitioned needs_confirmation -> regular, never satisfied the stale
  //  urgency_confirmation input, updated the obligation's type without its
  //  label, escalated via an unaudited UPDATE that wrote no event, and fell
  //  back to manager_override on an unknown emergency type where createWorkOrder
  //  throws. All five are closed here rather than worked around by any caller.
  //
  //  outcome: 'unresolved' | 'resolved_regular' | 'escalated_emergency' | 'already_emergency'
  async function appendClarification(client, { work_order_id, person_id = null, text, classifyUrgency }) {
    const wo = (await client.query("select * from work_orders where id=$1 for update", [work_order_id])).rows[0];
    if (!wo) throw Object.assign(new Error("work order not found"), { httpStatus: 404 });

    // append-only note event — original description untouched, always written
    await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,'work_order_clarification',$4)`,
      [wo.property_id, person_id, wo.unit_id, JSON.stringify({ work_order_id, text })]);

    // The open obligation for THIS work order. Absent (legacy rows, or already
    // resolved) → the note stands alone; we never invent one.
    const obligation = (await client.query(
      `select * from obligations
        where related_type='work_order' and related_id=$1 and status='open'
          and type <> 'billback_decision' and not (type = any($2::text[]))
        order by created_at asc limit 1`, [work_order_id, FOLLOW_UP_TYPES])).rows[0] || null;

    const finish = async (outcome, escalated) => {
      const updated = (await client.query("select * from work_orders where id=$1", [work_order_id])).rows[0];
      return { workOrder: updated, escalated, outcome, obligation_id: obligation ? obligation.id : null };
    };

    // §6.5 — already emergency. No downgrade, ever. Note only.
    if (wo.urgency_status === "emergency") return finish("already_emergency", false);
    if (typeof classifyUrgency !== "function") return finish("unresolved", false);

    const c = classifyUrgency(text);

    // §6.4 — the answer did not settle the question. Change nothing else.
    // A clarification that leaves needs_confirmation intact is an honest
    // outcome, not a failure: the resident replied, and we still do not know.
    if (c.urgency === "needs_confirmation") return finish("unresolved", false);

    // SELF-REVIEW FIX — work-order and obligation state must AGREE (contract
    // guarantee #4). The first cut updated work_orders whenever the
    // clarification resolved, and transitioned the obligation only when one
    // happened to be in `confirm_urgency`. That produces the exact mismatch
    // this slice exists to eliminate: a work order escalated to emergency
    // whose obligation is still a routine repair with normal priority and no
    // deadline — or a work order moved to regular with no accountable repair
    // obligation behind it at all.
    //
    // So the two move together or neither moves. If this work order is not in
    // the state this flow governs (no open obligation, or one that is no
    // longer `confirm_urgency` because someone already resolved it), the
    // clarification is recorded as a note and the message is flagged for a
    // human. Fail closed, never half-applied.
    const canTransition = !!obligation && obligation.type === "confirm_urgency";
    if (!canTransition) return finish("unresolved", false);

    if (c.urgency === "emergency") {
      // §6.6 — ONE closed vocabulary. The prior `|| manager_override` fallback
      // silently invented an emergency type where createWorkOrder refuses one.
      // Both entry points now fail the same way on the same input.
      const emDef = EMERGENCY_TYPES[c.emergency_type];
      if (!emDef) throw Object.assign(
        new Error("emergency_type required for emergency work order"),
        { httpStatus: 400, allowed: Object.keys(EMERGENCY_TYPES) });

      await client.query(
        `update work_orders
            set is_emergency=true, urgency_status='emergency',
                urgency_basis=$2, urgency_decided_by='resident_clarification',
                urgency_decided_at=now(), needs_pm_review=true, updated_at=now()
          where id=$1`,
        [work_order_id, c.basis]);

      {
        // Satisfy the stale input FIRST so the audit records that the question
        // was answered, then retype. Both inside the caller's transaction: in
        // between, the row reads confirm_urgency with no inputs outstanding —
        // a state completeObligation would happily close. It must never be
        // observable, and with one transaction it never is.
        if ((obligation.required_inputs || []).includes("urgency_confirmation")) {
          await satisfyObligation(client, {
            obligation_id: obligation.id, input: "urgency_confirmation",
            proof: "resident clarification",
          });
        }
        await transitionObligation(client, {
          obligation_id: obligation.id,
          expected_type: "confirm_urgency", expected_status: "open",
          to_type: "emergency_repair",
          label: `EMERGENCY: ${emDef.label} — needs on-call to own it`,
          required_inputs: ["closeout_proof"],
          priority: urgencyToPriority(emDef.urgency),
          severity: "emergency",
          escalates_to_role: "property_manager",
          due_at: urgencyToDueAt(emDef.urgency),
          reason: "resident clarification established an emergency",
          // §3.12 — emergency_type has no work_orders column. This event note
          // is its ONLY durable home on a clarification-driven escalation.
          event_note: {
            emergency_type: c.emergency_type, emergency_label: emDef.label,
            prior_urgency_status: wo.urgency_status, new_urgency_status: "emergency",
            urgency_basis: c.basis, urgency_decided_by: "resident_clarification",
          },
        });
      }
      return finish("escalated_emergency", true);
    }

    // §6.2 — resolved as routine. The repair obligation STAYS OPEN; answering
    // the urgency question never closes the work.
    if (c.urgency === "regular" && wo.urgency_status === "needs_confirmation") {
      await client.query(
        `update work_orders
            set urgency_status='regular', is_emergency=false, needs_pm_review=false,
                urgency_basis=$2, urgency_decided_by='resident_clarification',
                urgency_decided_at=now(), updated_at=now()
          where id=$1`,
        [work_order_id, c.basis]);

      {
        if ((obligation.required_inputs || []).includes("urgency_confirmation")) {
          await satisfyObligation(client, {
            obligation_id: obligation.id, input: "urgency_confirmation",
            proof: "resident clarification",
          });
        }
        const spec = obligationSpecFor("regular", null, { id: work_order_id }, {
          property_id: wo.property_id, unit_id: wo.unit_id, source_event_id: null,
        });
        await transitionObligation(client, {
          obligation_id: obligation.id,
          expected_type: "confirm_urgency", expected_status: "open",
          to_type: "maintenance_repair",
          label: spec.label,
          required_inputs: spec.required_inputs,
          priority: spec.priority, severity: spec.severity,
          reason: "resident clarification established a routine repair",
          event_note: {
            prior_urgency_status: wo.urgency_status, new_urgency_status: "regular",
            urgency_basis: c.basis, urgency_decided_by: "resident_clarification",
          },
        });
      }
      return finish("resolved_regular", false);
    }

    return finish("unresolved", false);
  }

  // ── Tenant authorization — every tenant read/write of a work order runs through
  //    this. Fails CLOSED: 403 otherwise.
  //
  //  With the person split, "whose work order is this" has two honest answers:
  //  the resident who REPORTED it, and the resident whose home is AFFECTED.
  //  Either may reach it — a resident must be able to follow a repair in their
  //  own unit that a neighbour or staff member filed, and the neighbour who
  //  reported it must be able to see the thing they raised. Property and unit
  //  must still match, so this widens who inside a tenancy may look, never
  //  which tenancy.
  async function assertTenantOwnsWorkOrder(client, { work_order_id, person_id, property_id, unit_id = null }) {
    const wo = (await client.query(
      `select id, reported_by_person_id, affected_person_id, property_id, unit_id
         from work_orders where id=$1`, [work_order_id])).rows[0];
    // Generic 403 for BOTH not-found and not-owned — never reveal whether the
    // target work order exists to an authenticated tenant out of scope.
    const isTheirs = !!wo && !!person_id &&
      (wo.reported_by_person_id === person_id || wo.affected_person_id === person_id);
    const authorized = isTheirs && wo.property_id === property_id &&
      (wo.unit_id == null || unit_id == null || wo.unit_id === unit_id);
    if (!authorized) throw Object.assign(new Error("not authorized"), { httpStatus: 403 });
    return wo;
  }

  return {
    createWorkOrder, appendClarification, assertTenantOwnsWorkOrder, EMERGENCY_TYPES,
    // The billback rail — APPEND ONLY. Note what is deliberately absent and
    // must stay absent: no updateBillbackDecision, no deleteBillbackDecision
    // (history is not editable), and no recordBillbackDispute (dormant until a
    // resident-facing surface exists and has been approved).
    recordBillbackDecision, recordBillbackCorrection, readBillbackState,
  };
}

module.exports = {
  makeWorkOrderService, EMERGENCY_TYPES, EMERGENCY_CHAIN,
  CAUSES, WORK_NATURES, BILLBACK_DECISIONS, BILLBACK_OBLIGATION_TYPE,
  // deriveCategories survives ONLY for supply_requests, which still carries an
  // operating_category. Decomposing the supply request is separate work and is
  // deliberately not in this slice. It is no longer on the work-order path.
  deriveCategories, urgencyToDueAt, urgencyToPriority,
};
