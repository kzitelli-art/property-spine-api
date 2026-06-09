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
//  Capabilities:
//    - Revenue: real claimed/supported/held-out from ingest_candidates, driven
//      by prov ('confirmed' = supported; all other provenance = held out).
//      VERIFIED on live data: claimed≈10,085 / supported 6,935 / held 3,150.
//    - Roles: property-scoped assignments first, users.role fallback, source disclosed.
//    - NOI Goal: target persists when property_noi_goals exists (migration 012);
//      current NOI + gap stay null until the expense (money) layer is live.
//    - Schema-safe: information_schema detection so column/table drift can't crash.
//
//  Mount in server.js (near the other mounts, ~line 2826):
//    const onboardingFunnel = require("./onboarding_funnel");
//    app.use("/api", onboardingFunnel({ pool }));
//  Needs only { pool }.
//
//  Migration (apply before relying on persistence): 012_property_noi_goals.sql
//  (property_id uuid + FK to properties ON DELETE CASCADE).
// ════════════════════════════════════════════════════════════════════

module.exports = function onboardingFunnel(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("onboarding_funnel module requires a pool");

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

  async function tableExists(tableName) {
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

  async function getColumns(tableName) {
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
  // claimed   = all candidate rents
  // supported = confirmed provenance
  // held_out  = assumed provenance / unproven exposure
  async function computeRevenue(propertyId) {
    const rows = (await pool.query(
      `select market_rent, prov, decision_status
         from ingest_candidates
        where property_id = $1`,
      [propertyId]
    )).rows;

    let claimed = 0;
    let supported = 0;
    let heldOut = 0;
    let units = 0;
    let supportedUnits = 0;
    let assumedUnits = 0;

    const by_provenance = {};
    const by_decision_status = {};

    for (const r of rows) {
      const rent = Number(r.market_rent) || 0;
      const prov = r.prov || "unknown";
      const status = r.decision_status || "unknown";

      units += 1;
      claimed += rent;
      by_provenance[prov] = (by_provenance[prov] || 0) + rent;
      by_decision_status[status] = (by_decision_status[status] || 0) + rent;

      if (prov === "confirmed") {
        supported += rent;
        supportedUnits += 1;
      } else {
        heldOut += rent;
        assumedUnits += 1;
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
      held_out_units: assumedUnits,
      avg_rent_per_unit: units > 0 ? money(claimed / units) : null,
      by_provenance: Object.fromEntries(Object.entries(by_provenance).map(([k, v]) => [k, money(v)])),
      by_decision_status: Object.fromEntries(Object.entries(by_decision_status).map(([k, v]) => [k, money(v)])),
      source: "ingest_candidates",
      support_rule: "prov='confirmed' is supported; all other provenance is held out.",
      limitations: [
        "Tenant, occupancy status, and lease-date issue flags are not available until rent-roll line fields are promoted onto units.",
        "decision_status is shown as workflow context only; it is not used as proof of support.",
      ],
    };
  }

  // ── STEP 4: Property-specific role map ──
  // Prefer assignments scoped to the property. Fall back to users.role only when
  // assignment shape is unavailable, and disclose that source.
  async function computeRoles(propertyId) {
    const usersExists = await tableExists("users");
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

    const userCols = await getColumns("users");
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
    const assignmentExists = await tableExists("assignments");

    if (assignmentExists) {
      const aCols = await getColumns("assignments");
      const hasProperty = aCols.has("property_id");
      const roleCol = aCols.has("role") ? "role" : aCols.has("assignment_role") ? "assignment_role" : aCols.has("role_key") ? "role_key" : null;
      const userCol = aCols.has("user_id") ? "user_id" : aCols.has("assignee_user_id") ? "assignee_user_id" : null;
      const nameCol = aCols.has("name") ? "name" : aCols.has("assignee_name") ? "assignee_name" : null;
      const activeFilter = aCols.has("active") ? " and coalesce(active, true) = true" : "";

      if (hasProperty && roleCol) {
        const selectParts = [
          `${roleCol} as role`,
          userCol ? `${userCol} as user_id` : `null::text as user_id`,
          nameCol ? `${nameCol} as assigned_name` : `null::text as assigned_name`,
        ];

        assignmentRows = (await pool.query(
          `select ${selectParts.join(", ")}
             from assignments
            where property_id = $1${activeFilter}`,
          [propertyId]
        )).rows;
        assignmentSource = "assignments scoped to property";
      }
    }

    const assignedByRole = {};
    for (const a of assignmentRows) {
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
  async function getNoiGoal(propertyId) {
    const exists = await tableExists("property_noi_goals");
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

  async function upsertNoiGoal(propertyId, body) {
    const exists = await tableExists("property_noi_goals");
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
    try { res.json(await computeRevenue(req.params.propertyId)); }
    catch (e) { console.error("onboarding/revenue error", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/properties/:propertyId/onboarding/roles", async (req, res) => {
    try { res.json(await computeRoles(req.params.propertyId)); }
    catch (e) { console.error("onboarding/roles error", e); res.status(500).json({ error: e.message }); }
  });

  router.get("/properties/:propertyId/onboarding/noi-goal", async (req, res) => {
    try {
      const revenue = await computeRevenue(req.params.propertyId);
      const goal = await getNoiGoal(req.params.propertyId);
      res.json(buildNoiGoalPayload(revenue, goal));
    } catch (e) {
      console.error("onboarding/noi-goal GET error", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/properties/:propertyId/onboarding/noi-goal", async (req, res) => {
    try {
      const saved = await upsertNoiGoal(req.params.propertyId, req.body || {});
      const revenue = await computeRevenue(req.params.propertyId);
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
      const revenue = await computeRevenue(propertyId);
      const roles = await computeRoles(propertyId);
      const goal = await getNoiGoal(propertyId);
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

  return router;
};
