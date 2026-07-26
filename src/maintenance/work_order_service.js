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
//  service owns them; maintenance.js and tenantlink.js both call in.
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

// ── THE THREE-LAYER CATEGORY ENGINE — ONE definition, owned here ──
//
//  Layer 1 field_category     — what the tech taps  (plumbing, paint…)
//  Layer 2 operating_category — what the PM sees     (repair/turn/billback/capex)
//  Layer 3 gl_category        — what accounting sees (derived)
//
//  Context (unit_state, cause) is what lets the SAME field action map
//  differently. Simple at the edge, precise at the center.
//
//  Pure function: same input always gives same output. The tech sets
//  field_category plus simple context; the server derives the rest, at the
//  moment work happens, so accounting never reconstructs.
//
//  HISTORY — why this is emphatic about being the only copy. A second,
//  stubbed deriveCategories used to live inside this file while the real
//  engine lived in maintenance.js, reachable only through
//  GET /maintenance/preview-category. The stub ignored unit_state and cause
//  and always returned resident_repair / is_capex:false / billback:false —
//  and the stub was the one inside createWorkOrder. So the operator previewed
//  "tenant billback", pressed save, and got an ordinary resident repair:
//  money owed by a resident silently expensed to the property, and renovation
//  work expensed instead of capitalized. Preview and write must agree by
//  CONSTRUCTION, not by two functions being kept in step by hand. Callers
//  import this one; nobody redefines it.
//  Proven by tests/work_order_canonical_path_proof.js layer C (agreement).
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

function makeWorkOrderService(deps) {
  const { spawnObligationFromEvent } = deps;
  if (typeof spawnObligationFromEvent !== "function") {
    throw new Error("work_order_service requires spawnObligationFromEvent()");
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
      property_id, unit_id = null, person_id = null,
      title, description = null,
      field_category = null, unit_state = null, cause = null, est_cost = null,
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
    if (person_id) {
      const p = await client.query("select id from persons where id=$1", [person_id]);
      if (p.rows.length === 0) throw Object.assign(new Error("person not found"), { httpStatus: 404 });
    }

    const derived = deriveCategories({ field_category, unit_state, cause, is_emergency });

    // ── Idempotency: a client-supplied key makes retries safe. If a work order
    //    with this key already exists, return it (and its obligation) — NO new
    //    work order, NO new obligation. The unique index makes a concurrent race
    //    fail the loser rather than duplicate.
    const idempotency_key = spec.idempotency_key ?? null;
    if (idempotency_key) {
      const dup = (await client.query(
        `select * from work_orders
          where idempotency_key=$1 and property_id=$2 and person_id is not distinct from $3`,
        [idempotency_key, property_id, person_id])).rows[0];
      if (dup) {
        const obl = (await client.query(
          "select * from obligations where related_type='work_order' and related_id=$1 order by created_at asc limit 1",
          [dup.id])).rows[0] || null;
        return { workOrder: dup, event: null, obligation: obl, deduped: true };
      }
    }

    // 1) the work order — description stored VERBATIM; urgency truth is source-neutral.
    const wo = (await client.query(
      `insert into work_orders
         (property_id, unit_id, person_id, title, description,
          status, assigned_to, source,
          field_category, operating_category,
          unit_state, cause, is_emergency, is_capex, billback, est_cost, needs_pm_review,
          urgency_status, urgency_basis, urgency_decided_by, urgency_decided_at, idempotency_key)
       values ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),$20)
       returning *`,
      [property_id, unit_id, person_id, title, description,
       assigned_to, source,
       field_category, derived.operating_category,
       unit_state, cause, is_emergency, derived.is_capex, derived.billback, est_cost, is_emergency,
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
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning *`,
      [property_id, person_id, unit_id, evType, JSON.stringify(noteObj)])).rows[0];

    // 3) the routing obligation — for EVERY work order (owner or honest UNASSIGNED)
    const obligation = await spawnObligationFromEvent(
      client,
      obligationSpecFor(urgency_status, emDef, wo, { property_id, person_id, unit_id, source_event_id: ev.id })
    );

    return { workOrder: wo, event: ev, obligation };
  }

  // ── APPEND: clarification as history on the SAME open loop. ──
  //  Original description is NEVER overwritten. If the clarification (via the
  //  narrow classifier) establishes an emergency, escalate the SAME work order
  //  and the SAME obligation.
  async function appendClarification(client, { work_order_id, person_id = null, text, classifyUrgency }) {
    const wo = (await client.query("select * from work_orders where id=$1 for update", [work_order_id])).rows[0];
    if (!wo) throw Object.assign(new Error("work order not found"), { httpStatus: 404 });

    // append-only note event — original description untouched
    await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,'work_order_clarification',$4)`,
      [wo.property_id, person_id, wo.unit_id, JSON.stringify({ work_order_id, text })]);

    let escalated = false;
    // only escalate UP, and only from a non-emergency state
    if (typeof classifyUrgency === "function" && wo.urgency_status !== "emergency") {
      const c = classifyUrgency(text);
      if (c.urgency === "emergency") {
        const emDef = EMERGENCY_TYPES[c.emergency_type] || EMERGENCY_TYPES.manager_override;
        await client.query(
          `update work_orders
              set is_emergency=true, urgency_status='emergency',
                  urgency_basis=$2, urgency_decided_by='resident_clarification',
                  urgency_decided_at=now(), needs_pm_review=true, updated_at=now()
            where id=$1`,
          [work_order_id, c.basis]);
        // escalate the SAME obligation in place (same open loop)
        await client.query(
          `update obligations
              set type='emergency_repair', priority='high', severity='emergency',
                  escalates_to_role='property_manager', due_at=$2, updated_at=now()
            where related_type='work_order' and related_id=$1 and status='open'`,
          [work_order_id, urgencyToDueAt(emDef.urgency)]);
        escalated = true;
      }
    }
    const updated = (await client.query("select * from work_orders where id=$1", [work_order_id])).rows[0];
    return { workOrder: updated, escalated };
  }

  // ── Tenant authorization — every tenant read/write of a work order runs through
  //    this. Fails CLOSED: a work order is reachable only by the resident whose
  //    person owns it, in the same property, and the same unit. 403 otherwise.
  async function assertTenantOwnsWorkOrder(client, { work_order_id, person_id, property_id, unit_id = null }) {
    const wo = (await client.query(
      "select id, person_id, property_id, unit_id from work_orders where id=$1", [work_order_id])).rows[0];
    // Generic 403 for BOTH not-found and not-owned — never reveal whether the
    // target work order exists to an authenticated tenant out of scope.
    const authorized = !!wo && wo.person_id === person_id && wo.property_id === property_id &&
      (wo.unit_id == null || unit_id == null || wo.unit_id === unit_id);
    if (!authorized) throw Object.assign(new Error("not authorized"), { httpStatus: 403 });
    return wo;
  }

  return { createWorkOrder, appendClarification, assertTenantOwnsWorkOrder, EMERGENCY_TYPES };
}

module.exports = { makeWorkOrderService, EMERGENCY_TYPES, EMERGENCY_CHAIN, deriveCategories, urgencyToDueAt, urgencyToPriority };
