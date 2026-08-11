// ════════════════════════════════════════════════════════════════════
//  asset_management.js — THE ASSET MANAGEMENT OPERATING DOOR
//
//  The FOURTH operating door, beside Leasing, Management and Maintenance.
//  Staff/operator side. This is where the economic structure and economic
//  performance of a property become operable.
//
//  It is NOT the Owner / Investor surface. That is a later, different
//  audience — potentially a different login — and it must not reuse this
//  module entitlement merely because it consumes this door's truth.
//
//  ── WHAT THIS SLICE IS ──────────────────────────────────────────────
//  A SHELL. It establishes the four-room hierarchy and nothing else:
//
//      REVENUE · CAPITAL · PROPERTY OBLIGATIONS · OPERATING COSTS
//
//  It returns an ESTABLISHMENT STATE per room, never a metric. There is
//  no amount, no schedule, no currency and no chart anywhere in it, and
//  that is the point: the rooms exist before they are furnished, and an
//  unfurnished room says so out loud.
//
//  ── ESTABLISHMENT IS DERIVED, NEVER STORED ──────────────────────────
//  Each room's state is computed from what the schema can actually
//  answer, this request. Nothing is written and no state column exists.
//  If a later migration establishes debt, this door starts saying so
//  without a backfill, because it was never remembering an answer.
//
//  Today the honest answers are:
//
//    REVENUE               partially_established — leases carry rent and a
//                          term, so a flat monthly rent position is real.
//                          Escalations and recurring charges do not exist
//                          (economic_classes.js grades the second itself:
//                          recurring_charge_model_not_built).
//    CAPITAL               not_established — no debt, equity or reserve
//    PROPERTY OBLIGATIONS  not_established — no tax or insurance
//    OPERATING COSTS       not_established — no payroll, contract, utility
//
//  Those three are not stubs. A repo-wide search over every migration
//  found zero tables for any of them, so "not established" is a
//  statement the server can defend rather than a placeholder.
//
//  ── THE EMPTY ROOM ANSWERS THE EXPOSURE CONTRACT ────────────────────
//  what it is about · why Spine cannot stand behind it · what would
//  establish it · who owns that (or UNASSIGNED). An empty room that
//  cannot answer those is a stub; one that can is useful, and the
//  vocabulary stays correct when the room fills.
//
//  ── AUTHORITY (§21) ─────────────────────────────────────────────────
//  Property comes from the resolved staff session, never the request. A
//  client-supplied property_id is REFUSED rather than ignored. Access is
//  gated on allowed_modules containing 'asset_management' — the module
//  entitlement, NOT the asset_manager job title. Those are different
//  facts and the repo keeps them apart deliberately.
//
//  CLASS 2 (permanent). The shell is permanent; only its rooms fill.
// ════════════════════════════════════════════════════════════════════

"use strict";

//  The four rooms. Sub-labels may evolve; the four-part structure is the
//  product direction and is stated in CLAUDE.md.
const ROOMS = Object.freeze([
  Object.freeze({
    key: "revenue",
    label: "Revenue",
    covers: ["Rent", "Vacancy", "Concessions", "Other Income"],
  }),
  Object.freeze({
    key: "capital",
    label: "Capital",
    covers: ["Senior Debt", "Mezzanine Debt", "Preferred Equity", "Reserves / Escrows"],
  }),
  //  PROPERTY OBLIGATIONS is the widest of the four, and deliberately so:
  //  it eventually holds everything the asset must maintain simply because
  //  we own and operate it — financial AND regulatory. Rental licenses,
  //  registrations, filings, tax compliance, inspections, renewals.
  //
  //  Compliance lives HERE rather than as a fifth room, because a lapsed
  //  rental licence and an unpaid tax bill are the same kind of fact from
  //  the asset's point of view: a standing obligation of ownership with a
  //  date and a consequence. Splitting them would make the operator look
  //  in two places for one answer.
  //
  //  NO COMPLIANCE LOGIC EXISTS. This is navigation and product structure
  //  only — the sub-labels say what the room is FOR, not what it does.
  Object.freeze({
    key: "property_obligations",
    label: "Property Obligations",
    covers: ["Taxes", "Insurance", "Licenses & Registrations", "Compliance", "Other fixed / recurring"],
  }),
  Object.freeze({
    key: "operating_costs",
    label: "Operating Costs",
    covers: ["Payroll", "Management Fees", "Utilities", "Contracts", "Repairs / other"],
  }),
]);

const ESTABLISHMENT_STATES = Object.freeze([
  "established",
  "partially_established",
  "not_established",
]);

module.exports = function assetManagement(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");

  const { pool } = deps || {};
  if (!pool) throw new Error("asset_management requires a pool");

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      return next();
    } catch (e) {
      console.error("asset-management session resolution failed", e);
      return res.status(500).json({ error: "session resolution failed" });
    }
  }

  //  §21. A client-supplied property is REFUSED, not ignored, so a caller
  //  can never believe it chose the scope.
  function refuseClientAuthority(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  //  The module entitlement gate. Mirrors requireLeasingModuleAccess.
  //
  //  ENTITLEMENT, NOT JOB TITLE. Whether someone is called an asset
  //  manager is an organizational fact; whether they may open this door
  //  at this property is an entitlement fact. Reading the role name here
  //  would merge two things the repo keeps apart, and would silently
  //  deny a property manager who legitimately holds the module.
  function requireAssetManagementModule(req, res, next) {
    const mods = (req.operator && req.operator.allowed_modules) || [];
    if (!mods.includes("asset_management")) {
      return res.status(403).json({
        error: "asset-management-module access required at this property (property_team_assignments.allowed_modules).",
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  /*  Is there a real, dated rent position at this property?
   *
   *  A lease counts only when it can actually carry a monthly position:
   *  a rent amount AND a start date. A row with neither is a tenancy
   *  record, not an economic one, and counting it would make the room
   *  look established when nothing could be generated from it.
   *
   *  This is the ONLY room whose state is read from data, because it is
   *  the only one whose primitives exist. */
  async function revenueEstablishment(client, propertyId) {
    const { rows } = await client.query(
      `select
         count(*) filter (where rent is not null and rent > 0 and start_date is not null)::int
           as positioned,
         count(*)::int as total
       from leases
       where property_id = $1
         and lease_status = 'active'`,
      [propertyId]);

    const positioned = (rows[0] && rows[0].positioned) || 0;
    const total = (rows[0] && rows[0].total) || 0;

    if (positioned === 0) {
      return {
        state: "not_established",
        //  An honest zero, and it says WHICH zero: no leases at all is a
        //  different situation from leases that carry no economics.
        why: total === 0
          ? "No active leases are established for this property yet."
          : `${total} active lease${total === 1 ? "" : "s"} exist, but none carries both a rent amount and a start date.`,
        establishes: "Establish the opening tenancy position from a rent roll (Deal Setup).",
      };
    }

    //  Deliberately never 'established'. Flat monthly rent is real, but a
    //  revenue position is not complete without escalations and recurring
    //  charges, and neither exists. Saying 'established' here would be the
    //  confident-wrong this door is built to avoid.
    //  Product copy, so it is written as a person would say it. The verb
    //  agrees with the count as well as the noun — "1 active lease carry"
    //  is the kind of seam that makes a careful surface read as generated.
    const subject = positioned === 1 ? "1 active lease carries" : `${positioned} active leases carry`;
    return {
      state: "partially_established",
      why: `${subject} a rent amount and a term, so a flat monthly rent position is real. Rent escalations and recurring charges (parking, pet, utilities billed to residents) are not represented anywhere yet, so this room cannot yet state a complete revenue position.`,
      establishes: "Rent escalation schedules and a recurring-charge model.",
    };
  }

  //  The three rooms with no primitives at all. Their text is the Exposure
  //  contract, not an apology: what this is about, why Spine cannot stand
  //  behind it, what would establish it.
  const UNBUILT = Object.freeze({
    capital: {
      state: "not_established",
      why: "Spine holds no debt, equity or reserve instruments for this property. Loan documents may have been retained during Deal Setup, but no economic terms have been read out of them, so there is nothing to stand behind.",
      establishes: "Governed debt and equity terms — principal, rate, accrual basis, payment schedule — read from the loan documents.",
    },
    property_obligations: {
      state: "not_established",
      //  The sentence has to cover the whole room, not the two examples
      //  that are easiest to name. A room whose sub-labels promise
      //  licences and compliance while its copy only mentions tax and
      //  insurance is quietly telling the operator the rest is handled.
      why: "Spine holds no tax obligations, insurance policies, licences or registrations for this property, and tracks no filing or renewal dates. Bills, policies and certificates may have been retained during Deal Setup, but nothing has been read out of them, so Spine cannot say what this property owes or when anything is due.",
      establishes: "Governed obligation terms — amount and period covered for tax and insurance, and the issuing body, expiry and renewal date for each licence, registration and recurring filing.",
    },
    operating_costs: {
      state: "not_established",
      why: "Spine holds no payroll allocations, management-fee terms, utility accounts or service contracts for this property.",
      establishes: "Governed recurring operating terms read from the management agreement, contracts and operating setup.",
    },
  });

  /*  GET /operator/asset-management/overview
   *
   *  The four rooms and their establishment state. No amounts. */
  router.get("/operator/asset-management/overview", ...gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    let client;
    try {
      client = await pool.connect();

      const revenue = await revenueEstablishment(client, propertyId);

      const rooms = ROOMS.map((room) => {
        const found = room.key === "revenue" ? revenue : UNBUILT[room.key];
        return {
          key: room.key,
          label: room.label,
          covers: room.covers,
          establishment: found.state,
          //  Plain English, operator-facing. Never a status word, never an
          //  id, never a table name.
          why: found.why,
          what_would_establish_it: found.establishes,
          //  §5 / the Exposure contract: a room with no established
          //  economics has no owner to name, and inventing one is worse
          //  than the blank. UNASSIGNED is the honest answer until an
          //  owner is actually recorded.
          owner: "UNASSIGNED",
        };
      });

      return res.json({
        property_id: propertyId,
        rooms,
        //  The door states its own limits so the surface never has to
        //  guess, and so a reader cannot mistake a shell for a product.
        scope_note:
          "Asset Management shell. Establishment state only — this door returns no amounts, no schedules and no financial positions, because the underlying governed economic terms are not built yet.",
      });
    } catch (e) {
      //  A failure must never reach the browser shaped like an empty
      //  result. An empty overview and a broken overview are different
      //  facts and the surface renders them differently.
      console.error("operator/asset-management/overview error", e);
      return res.status(503).json({ error: "asset management overview unavailable" });
    } finally {
      if (client) client.release();
    }
  });

  return router;
};

module.exports.ROOMS = ROOMS;
module.exports.ESTABLISHMENT_STATES = ESTABLISHMENT_STATES;
