// ════════════════════════════════════════════════════════════════════
//  ONBOARDING FUNNEL — six-step operating-record funnel, honest mode.
//  (Merged: partner's v2 schema-safe base + the thread's verified rules.)
//
//  Funnel:  Revenue → Expenses → Vendors → Roles → NOI Goal → Dashboard
//
//  The product rule (same as the owner dashboard): RENDER all six steps,
//  POPULATE only earned facts, mark everything else visibly pending. No fake
//  numbers — ever. Backend vocab stays out of the surface; details under keys.
//
//  REVENUE GATE (corrected): supported revenue = PROMOTED rent only
//  (promoted_unit_id is not null). A clean parse (prov='confirmed') or an
//  approval (decision_status='approved') is NOT supported revenue — both are
//  still candidates. Parsed-but-unpromoted rent is held-out / untied exposure.
//  Anchor reason: promoted_unit_id is the only state that means a real unit
//  exists (the /ingest/:runId/promote step created it). Duplicate promotion is
//  already blocked at the DB by the units unique constraint; the read-side
//  dedupe here is secondary belt-and-suspenders.
//
//  Mount in server.js (near the other mounts, ~line 2824):
//    const onboardingFunnel = require("./onboarding_funnel");
//    app.use("/api", onboardingFunnel({ pool }));
//  Needs only { pool }.
// ════════════════════════════════════════════════════════════════════


const CORE_ROLES = [
  "property_manager",
  "maintenance",
  "leasing",
  "accounting",
  "asset_manager",
];

function money(n) {
  if (n === null || n === undefined) return null;
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : null;
}

async function tableExists(pool, tableName) {
  const r = await pool.query(
    `select exists (
       select 1
         from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
     ) as exists`,
    [tableName]
  );
  return !!(r.rows[0] && r.rows[0].exists);
}

async function getColumns(pool, tableName) {
  const r = await pool.query(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1`,
    [tableName]
  );
  return new Set(r.rows.map(x => x.column_name));
}

// ── STEP 1: Revenue exposure from live ingest candidates ──
// SUPPORTED  = promoted rows (promoted_unit_id is not null) — a real unit exists.
// HELD_OUT   = everything else (parsed, confirmed, approved — all still untied).
// A clean parse is necessary but NOT sufficient. Promotion is the proof anchor.
async function computeRevenue(pool, propertyId) {
  const rows = (await pool.query(
    `select market_rent, prov, decision_status, promoted_unit_id
       from ingest_candidates
      where property_id = $1`,
    [propertyId]
  )).rows;

  let claimed = 0;
  let supported = 0;
  let heldOut = 0;
  let units = 0;
  let supportedUnits = 0;
  let heldOutUnits = 0;
  let duplicate_promoted_blocked = 0;

  const seenPromotedUnits = new Set();
  const by_provenance = {};
  const by_decision_status = {};

  for (const r of rows) {
    const rent = Number(r.market_rent) || 0;
    const prov = r.prov || "unknown";
    const status = r.decision_status || "unknown";
    const isPromoted = r.promoted_unit_id !== null && r.promoted_unit_id !== undefined;

    units += 1;
    claimed += rent;
    by_provenance[prov] = (by_provenance[prov] || 0) + rent;
    by_decision_status[status] = (by_decision_status[status] || 0) + rent;

    if (isPromoted) {
      // Secondary read-side dedupe: the units unique constraint already
      // prevents two units for one number, but guard the sum anyway.
      const key = String(r.promoted_unit_id);
      if (seenPromotedUnits.has(key)) {
        duplicate_promoted_blocked += 1;
        heldOut += rent;
        heldOutUnits += 1;
      } else {
        seenPromotedUnits.add(key);
        supported += rent;
        supportedUnits += 1;
      }
    } else {
      // Parsed but not promoted = untied exposure. Confirmed parse is NOT enough.
      heldOut += rent;
      heldOutUnits += 1;
    }
  }

  return {
    status: "live",
    claimed_rent: money(claimed),
    supported_rent: money(supported),
    held_out_rent: money(heldOut),
    support_rate: claimed > 0 ? Math.round((supported / claimed) * 100) : 0,
    units,
    supported_units: supportedUnits,
    held_out_units: heldOutUnits,
    promoted_units: seenPromotedUnits.size,
    duplicate_promoted_blocked,
    avg_rent_per_unit: units > 0 ? money(claimed / units) : null,
    by_provenance: Object.fromEntries(Object.entries(by_provenance).map(([k, v]) => [k, money(v)])),
    by_decision_status: Object.fromEntries(Object.entries(by_decision_status).map(([k, v]) => [k, money(v)])),
    source: "ingest_candidates",
    support_rule: "supported = promoted (promoted_unit_id not null). Clean parse (prov='confirmed') and approval (decision_status='approved') are still candidates — held-out / untied exposure until promoted.",
    limitations: [
      "Tenant, occupancy status, and lease-date issue flags are not available until rent-roll line fields are promoted onto units.",
      "prov and decision_status are shown as workflow context only; neither is used as proof of support. Only promotion is.",
      "Duplicate promoted rows for the same unit are blocked from supported and counted in duplicate_promoted_blocked.",
    ],
  };
}


// ── STEP 4: Property-specific role map ──
// Prefer assignments scoped to the property. Fall back to users.role only when
// assignment shape is unavailable, and disclose that source.
async function computeRoles(pool, propertyId) {
  const usersExists = await tableExists(pool, "users");
  if (!usersExists) {
    return {
      status: "live_empty",
      roles: CORE_ROLES.map(role => ({ role, assigned_to: null, user_id: null, status: "unassigned" })),
      routing_readiness: `0 / ${CORE_ROLES.length}`,
      all_assigned: false,
      source: "users table missing",
      limitations: ["Cannot resolve role routing until users exist."],
    };
  }

  const userCols = await getColumns(pool, "users");
  const userIdCol = userCols.has("id") ? "id" : null;
  const userNameCol = userCols.has("name") ? "name" : userCols.has("full_name") ? "full_name" : userCols.has("email") ? "email" : null;
  const userEmailCol = userCols.has("email") ? "email" : null;
  const userRoleCol = userCols.has("role") ? "role" : null;

  const userSelect = [
    userIdCol ? `${userIdCol} as id` : `null::text as id`,
    userNameCol ? `${userNameCol} as name` : `null::text as name`,
    userEmailCol ? `${userEmailCol} as email` : `null::text as email`,
    userRoleCol ? `${userRoleCol} as role` : `null::text as role`,
  ].join(", ");

  const users = (await pool.query(`select ${userSelect} from users`)).rows;
  const usersById = new Map(users.map(u => [String(u.id), u]));

  let assignmentRows = [];
  let assignmentSource = "users.role fallback";
  const assignmentExists = await tableExists(pool, "assignments");

  if (assignmentExists) {
    const aCols = await getColumns(pool, "assignments");
    const hasProperty = aCols.has("property_id");
    const roleCol = aCols.has("role") ? "role" : aCols.has("assignment_role") ? "assignment_role" : aCols.has("role_key") ? "role_key" : null;
    const userCol = aCols.has("user_id") ? "user_id" : aCols.has("assignee_user_id") ? "assignee_user_id" : null;
    // The live assignments table (orgchart) stores person_id → persons, not user_id → users.
    const personCol = aCols.has("person_id") ? "person_id" : null;
    const nameCol = aCols.has("name") ? "name" : aCols.has("assignee_name") ? "assignee_name" : null;
    const activeFilter = aCols.has("active") ? " and coalesce(active, true) = true"
      : aCols.has("is_active") ? " and coalesce(is_active, true) = true" : "";

    if (hasProperty && roleCol) {
      const selectParts = [
        `${roleCol} as role`,
        userCol ? `${userCol} as user_id` : `null::text as user_id`,
        personCol ? `${personCol} as person_id` : `null::text as person_id`,
        nameCol ? `${nameCol} as assigned_name` : `null::text as assigned_name`,
      ];

      assignmentRows = (await pool.query(
        `select ${selectParts.join(", ")}
           from assignments
          where property_id = $1${activeFilter}`,
        [propertyId]
      )).rows;
      assignmentSource = "assignments scoped to property";

      // Resolve assigned names through persons (the table assignments actually
      // points at). Fail-soft: if persons is missing or the lookup errors, the
      // assignment still counts — it just stays nameless, never crashes roles.
      const personIds = [...new Set(assignmentRows.map(r => r.person_id).filter(Boolean))];
      if (personIds.length) {
        try {
          const pRows = (await pool.query(
            `select id, name from persons where id = any($1::uuid[])`, [personIds]
          )).rows;
          const nameById = new Map(pRows.map(p => [String(p.id), p.name]));
          for (const r of assignmentRows) {
            if (r.person_id && !r.assigned_name) r.assigned_name = nameById.get(String(r.person_id)) || null;
          }
        } catch (e) {
          console.error("computeRoles persons lookup:", e.message);
        }
      }
    }
  }

  // Read-time alias: orgchart's role vocabulary says "bookkeeper"; the funnel's
  // core role is "accounting". Same seat — map it here, touch no data.
  const ROLE_ALIASES = { bookkeeper: "accounting" };

  const assignedByRole = {};
  for (const a of assignmentRows) {
    if (a.role && ROLE_ALIASES[a.role]) a.role = ROLE_ALIASES[a.role];
    if (!a.role || assignedByRole[a.role]) continue;
    const u = a.user_id !== null && a.user_id !== undefined ? usersById.get(String(a.user_id)) : null;
    assignedByRole[a.role] = {
      role: a.role,
      assigned_to: (u && u.name) || a.assigned_name || null,
      user_id: (u && u.id) || a.user_id || null,
      email: (u && u.email) || null,
      status: "assigned",
      source: "assignment",
    };
  }

  // Fallback only for roles not assigned at the property level.
  if (userRoleCol) {
    for (const u of users) {
      if (!u.role || assignedByRole[u.role]) continue;
      assignedByRole[u.role] = {
        role: u.role,
        assigned_to: u.name || u.email || null,
        user_id: u.id || null,
        email: u.email || null,
        status: "assigned",
        source: "users.role fallback",
      };
    }
  }

  const roles = CORE_ROLES.map(role => assignedByRole[role] || {
    role,
    assigned_to: null,
    user_id: null,
    email: null,
    status: "unassigned",
    source: null,
  });

  const ready = roles.filter(r => r.status === "assigned").length;
  return {
    status: "live",
    roles,
    routing_readiness: `${ready} / ${CORE_ROLES.length}`,
    all_assigned: ready === CORE_ROLES.length,
    source: assignmentSource,
    limitations: assignmentSource === "users.role fallback"
      ? ["Property-specific assignments were unavailable or incomplete; unresolved roles fall back to global users.role."]
      : [],
  };
}


// ── STEP 5: NOI Goal, persisted if migration exists ──
async function getNoiGoal(pool, propertyId) {
  const exists = await tableExists(pool, "property_noi_goals");
  if (!exists) return { target_noi: null, persisted: false, source: "no goal table" };

  const r = await pool.query(
    `select target_noi, target_gross_rent, target_avg_rent_per_unit, target_expense_load, updated_at
       from property_noi_goals
      where property_id = $1
      order by updated_at desc
      limit 1`,
    [propertyId]
  );
  if (!r.rows.length) return { target_noi: null, persisted: true, source: "property_noi_goals" };
  return {
    target_noi: money(r.rows[0].target_noi),
    target_gross_rent: money(r.rows[0].target_gross_rent),
    target_avg_rent_per_unit: money(r.rows[0].target_avg_rent_per_unit),
    target_expense_load: money(r.rows[0].target_expense_load),
    updated_at: r.rows[0].updated_at,
    persisted: true,
    source: "property_noi_goals",
  };
}


// ════════════════════════════════════════════════════════════════════
//  COMPACT ONBOARDING STATE — the bridge the operator dashboard reads.
//  One call, one honest summary: which funnel steps are earned, which are
//  pending, who owns each routing role, and the single next gap to close.
//  Reuses computeRevenue / computeRoles / getNoiGoal — never re-derives.
//  Fail-soft: a step that errors reports itself unavailable; it never
//  takes the whole block down.
// ════════════════════════════════════════════════════════════════════
async function computeOnboardingState(pool, propertyId) {
  const out = { status: "live", steps: {}, roles_by_key: {}, next_gap: null, complete: false };

  // Revenue
  try {
    const rev = await computeRevenue(pool, propertyId);
    out.steps.revenue = {
      status: rev.units > 0 ? (rev.supported_units > 0 ? "live" : "claimed_only") : "empty",
      supported_rent: rev.supported_rent,
      held_out_rent: rev.held_out_rent,
      supported_units: rev.supported_units,
      held_out_units: rev.held_out_units,
      support_rate: rev.support_rate,
    };
  } catch (e) { out.steps.revenue = { status: "unavailable", reason: e.message }; }

  // Roles
  try {
    const roles = await computeRoles(pool, propertyId);
    out.steps.roles = {
      status: roles.all_assigned ? "complete" : "incomplete",
      routing_readiness: roles.routing_readiness,
      unassigned: roles.roles.filter(r => r.status !== "assigned").map(r => r.role),
    };
    for (const r of roles.roles) out.roles_by_key[r.role] = {
      role: r.role, assigned_to: r.assigned_to, status: r.status, source: r.source || null,
    };
  } catch (e) { out.steps.roles = { status: "unavailable", reason: e.message }; }

  // NOI goal
  try {
    const goal = await getNoiGoal(pool, propertyId);
    out.steps.noi_goal = {
      status: goal.target_noi != null ? "set" : "not_set",
      persisted: !!goal.persisted,
      target_noi: goal.target_noi ?? null,
    };
  } catch (e) { out.steps.noi_goal = { status: "unavailable", reason: e.message }; }

  // Money-dependent steps stay honestly not connected (same as the funnel read).
  out.steps.expenses = { status: "not_connected" };
  out.steps.vendors  = { status: "not_connected" };

  // The single next gap, in funnel order. Roles outrank revenue because
  // routing is what makes every other desk actionable.
  const gaps = [];
  if (out.steps.roles && out.steps.roles.status === "incomplete")
    gaps.push({ step: "roles", label: `Assign ${out.steps.roles.unassigned.length} routing role${out.steps.roles.unassigned.length === 1 ? "" : "s"}: ${out.steps.roles.unassigned.join(", ")}.`, go: "onboarding_roles" });
  if (out.steps.revenue && (out.steps.revenue.status === "empty"))
    gaps.push({ step: "revenue", label: "No rent roll ingested yet — drop one at the intake door.", go: "onboarding_revenue" });
  if (out.steps.revenue && out.steps.revenue.status === "claimed_only")
    gaps.push({ step: "revenue", label: `${out.steps.revenue.held_out_units} unit${out.steps.revenue.held_out_units === 1 ? "" : "s"} parsed but not promoted — revenue is still a claim.`, go: "onboarding_revenue" });
  if (out.steps.noi_goal && out.steps.noi_goal.status === "not_set")
    gaps.push({ step: "noi_goal", label: "Set the NOI goal so the dashboard has a target.", go: "onboarding_noi_goal" });

  out.next_gap = gaps[0] || null;
  out.complete =
    out.steps.roles && out.steps.roles.status === "complete" &&
    out.steps.revenue && out.steps.revenue.status === "live" &&
    out.steps.noi_goal && out.steps.noi_goal.status === "set";
  return out;
}

module.exports = function onboardingFunnel(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("onboarding_funnel module requires a pool");

  async function upsertNoiGoal(propertyId, body) {
    const exists = await tableExists(pool, "property_noi_goals");
    if (!exists) {
      return {
        target_noi: money(body.target_noi),
        target_gross_rent: money(body.target_gross_rent),
        target_avg_rent_per_unit: money(body.target_avg_rent_per_unit),
        target_expense_load: money(body.target_expense_load),
        persisted: false,
        source: "no goal table",
        note: "Goal accepted but not stored because property_noi_goals has not been migrated yet.",
      };
    }

    const targetNoi = body.target_noi === undefined || body.target_noi === null || body.target_noi === "" ? null : Number(body.target_noi);
    const targetGross = body.target_gross_rent === undefined || body.target_gross_rent === null || body.target_gross_rent === "" ? null : Number(body.target_gross_rent);
    const targetAvg = body.target_avg_rent_per_unit === undefined || body.target_avg_rent_per_unit === null || body.target_avg_rent_per_unit === "" ? null : Number(body.target_avg_rent_per_unit);
    const targetExp = body.target_expense_load === undefined || body.target_expense_load === null || body.target_expense_load === "" ? null : Number(body.target_expense_load);

    for (const [key, val] of Object.entries({ target_noi: targetNoi, target_gross_rent: targetGross, target_avg_rent_per_unit: targetAvg, target_expense_load: targetExp })) {
      if (val !== null && (!Number.isFinite(val) || val < 0)) throw new Error(`${key} must be a non-negative number`);
    }

    const r = await pool.query(
      `insert into property_noi_goals
          (property_id, target_noi, target_gross_rent, target_avg_rent_per_unit, target_expense_load, updated_at)
       values ($1::uuid, $2, $3, $4, $5, now())
       on conflict (property_id) do update set
          target_noi = excluded.target_noi,
          target_gross_rent = excluded.target_gross_rent,
          target_avg_rent_per_unit = excluded.target_avg_rent_per_unit,
          target_expense_load = excluded.target_expense_load,
          updated_at = now()
       returning target_noi, target_gross_rent, target_avg_rent_per_unit, target_expense_load, updated_at`,
      [propertyId, targetNoi, targetGross, targetAvg, targetExp]
    );

    return {
      target_noi: money(r.rows[0].target_noi),
      target_gross_rent: money(r.rows[0].target_gross_rent),
      target_avg_rent_per_unit: money(r.rows[0].target_avg_rent_per_unit),
      target_expense_load: money(r.rows[0].target_expense_load),
      updated_at: r.rows[0].updated_at,
      persisted: true,
      source: "property_noi_goals",
    };
  }

  function buildNoiGoalPayload(revenue, goal) {
    // Expenses remain unavailable until money layer exists. Therefore current NOI
    // and gap remain null even when target is persisted.
    return {
      status: "partial",
      target_noi: goal.target_noi || null,
      target_gross_rent: goal.target_gross_rent || null,
      target_avg_rent_per_unit: goal.target_avg_rent_per_unit || null,
      target_expense_load: goal.target_expense_load || null,
      persisted: !!goal.persisted,
      current_supported_revenue: revenue.supported_rent,
      current_expenses: null,
      current_noi: null,
      gap_to_target: null,
      source: goal.source,
      limitations: [
        "Current NOI and gap to target cannot be computed until the expense money layer is connected.",
        goal.persisted ? "NOI goal is persisted." : "NOI goal is not persisted until property_noi_goals exists.",
      ],
    };
  }

  router.get("/properties/:propertyId/onboarding/revenue", async (req, res) => {
    try { res.json(await computeRevenue(pool, req.params.propertyId)); }
    catch (e) { console.error("onboarding/revenue error", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/properties/:propertyId/onboarding/roles", async (req, res) => {
    try { res.json(await computeRoles(pool, req.params.propertyId)); }
    catch (e) { console.error("onboarding/roles error", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/properties/:propertyId/onboarding/noi-goal", async (req, res) => {
    try {
      const revenue = await computeRevenue(pool, req.params.propertyId);
      const goal = await getNoiGoal(pool, req.params.propertyId);
      res.json(buildNoiGoalPayload(revenue, goal));
    } catch (e) {
      console.error("onboarding/noi-goal GET error", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/properties/:propertyId/onboarding/noi-goal", async (req, res) => {
    try {
      const saved = await upsertNoiGoal(req.params.propertyId, req.body || {});
      const revenue = await computeRevenue(pool, req.params.propertyId);
      res.json(buildNoiGoalPayload(revenue, saved));
    } catch (e) {
      console.error("onboarding/noi-goal POST error", e);
      const status = /must be a non-negative number/.test(e.message) ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  router.get("/properties/:propertyId/onboarding", async (req, res) => {
    try {
      const propertyId = req.params.propertyId;
      const revenue = await computeRevenue(pool, propertyId);
      const roles = await computeRoles(pool, propertyId);
      const goal = await getNoiGoal(pool, propertyId);
      const noiGoal = buildNoiGoalPayload(revenue, goal);

      res.json({
        property_id: propertyId,
        steps: {
          revenue,
          expenses: {
            status: "not_connected",
            note: "Connect bank activity to build the expense record. No spend is shown until then.",
            required_for: ["current_expenses", "current_noi", "gap_to_target", "vendor discovery"],
          },
          vendors: {
            status: "not_connected",
            note: "Vendors become real once transactions/payees exist.",
            required_for: ["recurring spend map", "default categories", "expense confidence"],
          },
          roles,
          noi_goal: noiGoal,
          dashboard: {
            status: "live_partial",
            note: "Shows real revenue exposure, roles, and persisted targets where available; money-dependent sections remain not connected.",
          },
        },
        principle: "Render the whole funnel. Populate earned facts. Everything else is visibly pending.",
      });
    } catch (e) {
      console.error("onboarding full error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Compact bridge read — the operator dashboard's onboarding strip.
  router.get("/properties/:propertyId/onboarding/state", async (req, res) => {
    try { res.json(await computeOnboardingState(pool, req.params.propertyId)); }
    catch (e) { console.error("onboarding/state error", e); res.status(500).json({ error: e.message }); }
  });

  return router;
};


// Shared compute exports — desks.js (and any other read surface) uses these
// instead of re-deriving onboarding math. Same pattern as exposure.js.
module.exports.computeRevenue = computeRevenue;
module.exports.computeRoles = computeRoles;
module.exports.computeOnboardingState = computeOnboardingState;
