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
//
//  ── THREE LISTS PER ROOM, AND THEY ARE NOT THE SAME JOB ─────────────
//
//    covers   the CANONICAL structural list — what the room holds. It is a
//             product ruling and is pinned by name in the proof.
//    eyebrow  the DISPLAY list on the home card, which is a dense one-line
//             context strip and drops the "other / catch-all" tail.
//
//    compartments  the room's own sub-doors — the PERMANENT SKELETON.
//
//  covers and eyebrow are allowed to differ in length. They are NOT allowed
//  to disagree: a proof asserts every eyebrow entry abbreviates a real
//  covers entry, so a card can never advertise something the room does not
//  hold.
//
//  ── COMPARTMENTS ARE THE SKELETON, NOT AN EMPTY STATE ───────────────
//
//  Each room breaks into the compartments it will always have. They are
//  rendered now, honestly empty, so the room is the real Property
//  Obligations page from day one rather than an explanatory placeholder
//  that gets thrown away when Insurance arrives. The operator should
//  already understand where Insurance and Taxes are going to live.
//
//  A compartment carries its own establishment, because they will fill in
//  ONE AT A TIME — Rent is real today while Vacancy is not, and a room
//  that averaged them into one state would be lying in both directions.
/*  ── THE FOUR DOORS. THE PERMANENT SKELETON. ─────────────────────────
 *
 *      CAPITAL STACK · PROPERTY EXPENSES · PROJECTS & CAPEX · COMPLIANCE
 *
 *  ── WHY THE PREVIOUS FOUR WERE REPLACED ─────────────────────────────
 *  Revenue · Capital · Property Obligations · Operating Costs mixed four
 *  different KINDS of thing at one level: an income category, a
 *  capitalisation structure, a bundle of standing obligations, and a
 *  bundle of operating costs. Two consequences followed, and both were
 *  real:
 *
 *    · Taxes and Insurance sat under "Property Obligations" alongside
 *      Licences and Compliance, which are not expenses at all — so the
 *      room could never answer "what does this property cost to own".
 *    · Operating Costs was a second, parallel home for expenses, so the
 *      same question had two rooms and neither had the whole answer.
 *
 *  The new four are cut by QUESTION, not by accounting category:
 *
 *      CAPITAL STACK      how is this property capitalised, and what do
 *                         we owe the people who capitalised it?
 *      PROPERTY EXPENSES  what does it cost to own and operate?
 *      PROJECTS & CAPEX   where are we investing capital in the asset?
 *      COMPLIANCE         is it legally and regulatorily in good standing?
 *
 *  ── THE DOOR IS NAVIGATION. THE MODULE OWNS THE TRUTH. ──────────────
 *  Taxes and Insurance move INTACT under Property Expenses. Neither is
 *  flattened into a summary row and neither loses a capability: the room
 *  is a way in, and the domain behind it is unchanged. This build moves
 *  doors; it does not rewrite either house.
 *
 *  ── AND REVENUE IS NOT A DOOR HERE ──────────────────────────────────
 *  It was removed rather than relocated. Revenue's operating sources
 *  live in Leasing and Management, which own the leases, the concessions
 *  and the vacancy. Asset Management will later READ the economic
 *  consequence — T-12, NOI, budget vs actual — and must not grow a
 *  second revenue-management surface to do it. A door here would have
 *  been exactly that invitation.
 *
 *  ── THREE LISTS PER ROOM, AND THEY ARE NOT THE SAME JOB ─────────────
 *    covers        the CANONICAL structural list — what the room holds.
 *    eyebrow       the DISPLAY list on the home card. It ABBREVIATES
 *                  covers and never invents; a proof asserts it.
 *    compartments  the room's own sub-doors — the permanent skeleton.
 *
 *  A compartment carries its own establishment, because they fill in ONE
 *  AT A TIME. Taxes and Insurance are governed today while the other
 *  seven expense modules do not exist, and a room that averaged them
 *  into one state would be lying in both directions.
 */
const ROOMS = Object.freeze([
  Object.freeze({
    key: "capital_stack",
    label: "Capital Stack",
    covers: ["Debt", "Equity & Preferred Equity", "Reserves & Escrows"],
    eyebrow: ["Debt", "Equity", "Reserves"],
    belongs: "How this property is capitalised, and what it owes the people who capitalised it.",
    //  ⚠ RESERVES & ESCROWS IS A READER, NEVER A SECOND WRITER.
    //  Tax escrow truth is owned by the Tax module and insurance escrow
    //  truth by the Insurance module, each behind the executable funding
    //  wall in gate_funding_boundary.js. Capital Stack may aggregate
    //  those positions later; it may never author them. A capital room
    //  that started writing escrow would reopen the exact seam the wall
    //  exists to keep shut.
    compartments: [
      { key: "debt", label: "Debt", derived: "debt",
        note: "No governed debt instruments yet" },
      { key: "equity", label: "Equity & Preferred Equity", derived: "equity",
        note: "No governed equity or preferred terms yet" },
      { key: "reserves_escrows", label: "Reserves & Escrows",
        note: "No governed reserve accounts yet" },
    ],
  }),

  /*  PROPERTY EXPENSES is the widest of the four and the only one with
   *  anything live in it. Nine modules, two of them governed today.
   *
   *  ⚠ A LICENCE FEE IS AN EXPENSE. A LICENCE IS NOT.
   *  When Licences & Registrations is built it lives under COMPLIANCE —
   *  its status, renewal, expiry and evidence are compliance truth. The
   *  fee it generates may later be read as an expense here. One domain
   *  owns the operational truth; the economic consequence is read
   *  elsewhere; there are never two truths. The old taxonomy had
   *  licences sitting beside taxes as though they were the same kind of
   *  fact, which is how that distinction gets lost.
   */
  Object.freeze({
    key: "property_expenses",
    label: "Property Expenses",
    covers: ["Taxes", "Insurance", "Payroll & Staffing", "Utilities",
             "Contracted Services", "Repairs & Maintenance",
             "Management & Administration", "Marketing & Leasing Costs",
             "Other Operating Expenses"],
    eyebrow: ["Taxes", "Insurance", "Payroll", "Utilities"],
    belongs: "What this property costs to own and operate.",
    compartments: [
      //  `derived` resolves against the domain's own canonical read. The
      //  two live modules keep everything they had — this room is the way
      //  in, not a summary that replaces them.
      { key: "taxes", label: "Taxes", derived: "taxes" },
      { key: "insurance", label: "Insurance", derived: "insurance" },
      { key: "payroll_staffing", label: "Payroll & Staffing",
        note: "No governed payroll allocation yet" },
      { key: "utilities", label: "Utilities", derived: "utilities" },
      { key: "contracted_services", label: "Contracted Services",
        note: "No governed service contracts yet" },
      { key: "repairs_maintenance", label: "Repairs & Maintenance",
        note: "No governed repair or maintenance expense terms yet" },
      { key: "management_administration", label: "Management & Administration",
        note: "No governed management fee or administrative terms yet" },
      { key: "marketing_leasing", label: "Marketing & Leasing Costs",
        note: "No governed marketing or leasing cost terms yet" },
      { key: "other_operating_expenses", label: "Other Operating Expenses",
        note: "No other governed operating expense terms yet" },
    ],
  }),

  /*  ⚠ PROJECTS & CAPEX IS NOT A SECOND WORK-ORDER SYSTEM.
   *  Maintenance owns the work EVENT — who was dispatched, what they
   *  found, what they did, the photograph. This room owns the
   *  asset-management view of capital work: what was budgeted, committed,
   *  spent and drawn against which source of capital. When it is built it
   *  will REFERENCE operating work; it will never duplicate it, and a
   *  work order must never be creatable from inside Asset Management.
   */
  Object.freeze({
    key: "projects_capex",
    label: "Projects & CapEx",
    covers: ["Projects", "Unit Improvements", "Building Systems",
             "Equipment & FF&E", "Capital Reserves & Draws"],
    eyebrow: ["Projects", "Unit Improvements", "Building Systems"],
    belongs: "Where capital is being invested in the physical property, and what that work costs.",
    compartments: [
      { key: "projects", label: "Projects",
        note: "No governed capital projects yet" },
      { key: "unit_improvements", label: "Unit Improvements",
        note: "No governed unit improvement work yet" },
      { key: "building_systems", label: "Building Systems",
        note: "No governed building system work yet" },
      { key: "equipment_ff_e", label: "Equipment & FF&E",
        note: "No governed equipment or FF&E yet" },
      { key: "capital_reserves_draws", label: "Capital Reserves & Draws",
        note: "No governed reserve draws yet" },
    ],
  }),

  /*  COMPLIANCE is its own door rather than a compartment of an
   *  obligations room, because "is the property in good standing" is a
   *  different question from "what does it cost", and it is answered by
   *  different evidence with different consequences. A lapsed rental
   *  licence stops you letting a unit; an unpaid bill does not.
   */
  Object.freeze({
    key: "compliance",
    label: "Compliance",
    covers: ["Licenses & Registrations", "Inspections", "Certificates",
             "Violations & Cure", "Recurring Requirements"],
    eyebrow: ["Licenses", "Inspections", "Certificates"],
    belongs: "Whether this property is legally and regulatorily in good standing.",
    compartments: [
      { key: "licenses_registrations", label: "Licenses & Registrations", derived: "licenses_registrations",
        note: "No governed licences or registrations yet" },
      { key: "inspections", label: "Inspections", derived: "inspections",
        note: "No governed inspection schedule yet" },
      { key: "certificates", label: "Certificates", derived: "certificates",
        note: "No governed certificates yet" },
      { key: "violations_cure", label: "Violations & Cure", derived: "violations_cure",
        note: "No governed violations or cure deadlines yet" },
      { key: "recurring_requirements", label: "Recurring Requirements", derived: "recurring_requirements",
        note: "No governed recurring requirements yet" },
    ],
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
  const insurancePosition = require("../asset/insurance_position_read.js");
  //  The Insurance WRITE path. Its own module, mounted here behind this
  //  door's authority — see its header for why it is not two more routes
  //  in this file (the independence gate has to be able to read it whole,
  //  and this file legitimately contains financing words in the Cash &
  //  Financing section spec).
  const insuranceEstablishment = require("../asset/insurance_establishment.js");
  //  Good standing — a pure derivation over the coverages the property
  //  participates in. No table, no stored state, nothing to go stale.
  const insuranceStanding = require("../asset/insurance_standing.js");
  //  HOW insurance is paid for. A SEPARATE chain from what it costs, and
  //  the separation is enforced by gate_funding_boundary.js.
  //  This surface may hold both because a surface is the composition
  //  point; the economic chain itself may never reach funding.
  const insuranceFunding = require("../asset/insurance_funding.js");
  const insuranceFundingRead = require("../asset/insurance_funding_read.js");

  //  ── TAXES ─────────────────────────────────────────────────────────
  //  The same two-chain shape, one domain over. The economic read is
  //  given its jurisdiction rules rather than importing them, so a second
  //  jurisdiction is a new rules module and not a new read.
  const taxPosition = require("../asset/tax_position_read.js");
  const taxRules = require("../asset/philadelphia_tax_rules.js");
  const taxEstablishment = require("../asset/tax_establishment.js");
  //  HOW tax is paid for. A SEPARATE chain, enforced by
  //  gate_funding_boundary.js — including that nothing on this side can
  //  write `tax_payments`, so no escrow can make a bill read as paid.
  const taxFunding = require("../asset/tax_funding.js");
  const taxFundingRead = require("../asset/tax_funding_read.js");
  const utilityPosition = require("../asset/utility_position_read.js");
  const utilityRoutes = require("../asset/utility_routes.js");
  const contractedServicePosition = require("../asset/contracted_service_position_read.js");
  const contractedServiceRoutes = require("../asset/contracted_service_routes.js");
  //  The taxpayer capture seam. NOT owned by Taxes — `legal_entities` is a
  //  shared primitive that ownership and debt work will want too — but
  //  mounted here because this is the door an operator is standing in when
  //  BIRT asks them for an entity that does not exist yet.
  const legalEntityRoutes = require("../entity/legal_entity_routes.js");
  //  Debt's governed READ seam. Two GETs, no writers exposed — the
  //  durable write path belongs to document establishment, not to a
  //  public door per canonical writer. See src/asset/debt_routes.js.
  const debtRoutes = require("../asset/debt_routes.js");
  //  For the Capital Stack home-card probe ONLY — establishmentForProperty
  //  is a cheap COUNT, never position() and never the schedule derivation.
  const debtSvc = require("../asset/debt_instrument_service.js");
  //  Equity's governed READ seam. One GET — see src/asset/equity_routes.js
  //  for why there is no standing/detail split the way Debt has one.
  const equityRoutes = require("../asset/equity_routes.js");
  //  Same probe discipline as debtSvc, immediately above.
  const equitySvc = require("../asset/equity_position_service.js");
  const complianceHttp = require("../asset/compliance_http.js");
  const complianceRead = require("../asset/compliance_read.js");

  const { pool, fileToText } = deps || {};
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


  /*  ── WHAT IS ACTUALLY ESTABLISHED IN PROPERTY EXPENSES ─────────────
   *  The only room with anything live in it, so the only one whose state
   *  is resolved against data rather than declared.
   *
   *  ⚠ IT ASKS THE DOMAINS. IT DOES NOT RE-DERIVE THEM.
   *  Establishment comes from each module's own canonical read, and
   *  NOTHING ELSE from those reads is kept — no liability, no accrual, no
   *  premium, no coverage. The taxonomy is navigation; the modules own
   *  the truth. A room that started carrying its children's figures would
   *  be a second place those figures could be wrong, and the first place
   *  anyone would look.
   *
   *  ⚠ AND IT CANNOT REACH `established`.
   *  Two of nine modules are governed. A room reporting ESTABLISHED
   *  because Taxes and Insurance are in hand would be telling an operator
   *  that payroll, utilities, contracted services and four more are
   *  accounted for. The cap is deliberate and the copy names the gap.
   */
  async function propertyExpensesEstablishment(client, propertyId) {
    const live = [];

    //  Each probe is defensive on purpose: this is a NAVIGATION read, and
    //  a domain that cannot answer must not take the whole desk down with
    //  it. An unavailable module reads as not established here, which is
    //  the honest answer to "what can Spine stand behind right now".
    let taxes = null;
    try {
      const pos = await taxPosition.readTaxPosition(client,
        { property_id: propertyId, rules: taxRules });
      const answered = pos.rows.filter((r) => r.applicability !== "not_established").length;
      taxes = answered > 0
        ? { established: true,
            note: `${answered} of ${pos.rows.length} Philadelphia taxes answered` }
        : { established: false, note: "No governed tax obligations yet" };
    } catch (e) {
      console.error("asset-management overview: tax establishment probe failed", e);
      taxes = { established: false, note: "No governed tax obligations yet" };
    }
    if (taxes.established) live.push("Taxes");

    let insurance = null;
    try {
      const part = await insurancePosition.readParticipation(client,
        { property_id: propertyId, period: currentPeriod() });
      insurance = part.participates
        ? { established: true,
            note: `${part.coverages.length} active ` +
                  `coverage${part.coverages.length === 1 ? "" : "s"}` }
        : { established: false, note: "No governed policies yet" };
    } catch (e) {
      console.error("asset-management overview: insurance establishment probe failed", e);
      insurance = { established: false, note: "No governed policies yet" };
    }
    if (insurance.established) live.push("Insurance");

    let utilities = null;
    try {
      const standing = await utilityPosition.readStanding(client, { property_id: propertyId });
      utilities = standing.setup_state !== "not_established"
        ? { established: true,
            note: `${standing.established_services} service` +
                  `${standing.established_services === 1 ? "" : "s"} established` +
                  (standing.unresolved_count
                    ? `, ${standing.unresolved_count} setup question${standing.unresolved_count === 1 ? "" : "s"} open`
                    : "") }
        : { established: false, note: "No governed Utility setup yet" };
    } catch (e) {
      console.error("asset-management overview: Utility establishment probe failed", e);
      utilities = { established: false, note: "No governed Utility setup yet" };
    }
    if (utilities.established) live.push("Utilities");

    let contractedServices = null;
    try {
      const standing = await contractedServicePosition.readStanding(client,
        { property_id: propertyId });
      contractedServices = standing.setup_state !== "not_established"
        ? { established: true,
            note: `${standing.engagement_count} service engagement` +
              `${standing.engagement_count === 1 ? "" : "s"} established` +
              (standing.unresolved_count
                ? `, ${standing.unresolved_count} question${standing.unresolved_count === 1 ? "" : "s"} open`
                : "") }
        : { established: false, note: "No governed contracted services yet" };
    } catch (e) {
      console.error("asset-management overview: Contracted Services establishment probe failed", e);
      contractedServices = { established: false, note: "No governed contracted services yet" };
    }
    if (contractedServices.established) live.push("Contracted Services");

    const byKey = { taxes, insurance, utilities, contracted_services: contractedServices };

    if (!live.length) {
      return {
        state: "not_established",
        byKey,
        //  SHORT — the home card. One line, no machinery.
        summary: "No tax, insurance, Utility, Contracted Services or other operating expense terms are established for this property.",
        why: "Spine holds no governed expense terms for this property. Bills, policies, " +
             "contracts and payroll arrangements may have been retained during Deal Setup, " +
             "but nothing has been read out of them, so Spine cannot say what this property " +
             "costs to own or operate.",
        establishes: "Governed expense terms — what is owed, for what period, on what evidence — " +
                     "starting with the tax and insurance a property carries from day one.",
      };
    }

    //  PARTIAL, ALWAYS, AND IT SAYS WHICH PART. Naming the two that are
    //  governed is what stops the sentence reading as a claim about the
    //  other seven.
    const named = live.length > 1
      ? `${live.slice(0, -1).join(", ")} and ${live[live.length - 1]}`
      : live[0];
    const absent = [];
    if (!taxes.established) absent.push("taxes");
    if (!insurance.established) absent.push("insurance");
    if (!utilities.established) absent.push("utilities");
    if (!contractedServices.established) absent.push("contracted services");
    absent.push("payroll", "repairs", "management and administration",
      "marketing", "other operating expenses");
    return {
      state: "partially_established",
      byKey,
      summary: `${named} ${live.length === 1 ? "is" : "are"} established. ` +
               `The other operating expenses are not.`,
      why: `${named} ${live.length === 1 ? "carries" : "carry"} governed terms Spine can ` +
           `stand behind. ${absent.join(", ")} have no governed terms ` +
           `anywhere, so this room cannot yet state what the property costs in total.`,
      establishes: "Governed terms for the remaining operating expenses, each with its own " +
                   "evidence and period.",
    };
  }

  //  The three rooms with no primitives at all.  //  The three rooms with no primitives at all. Their text is the Exposure
  //  contract, not an apology: what this is about, why Spine cannot stand
  //  behind it, what would establish it.
  //  Each carries BOTH a one-line `summary` for the home card and the long
  //  `why` / `establishes` for inside the room.
  //
  //  The split is the point. Putting the full explanation on the home card
  //  turned the desk into an audit page — four stacked essays of equal
  //  weight, with the hierarchy buried underneath them. The operator should
  //  read four room names in three seconds; the setup guidance is useful
  //  only once they have chosen a room, and that is where it now lives.
  const UNBUILT = Object.freeze({
    capital_stack: {
      state: "not_established",
      summary: "No debt, equity or reserve terms are established for this property.",
      why: "Spine holds no debt, equity or reserve instruments for this property. Loan documents may have been retained during Deal Setup, but no economic terms have been read out of them, so there is nothing to stand behind.",
      establishes: "Governed debt and equity terms — principal, rate, accrual basis, payment schedule, covenant position — read from the loan documents.",
    },
    projects_capex: {
      state: "not_established",
      summary: "No capital projects or improvement work are established for this property.",
      //  Says what this room is FOR, in a way that does not read as a
      //  promise about maintenance. Maintenance owns the work event; this
      //  room will own the economic position of capital work.
      why: "Spine holds no capital projects, budgets or draw positions for this property. Maintenance may hold operating work orders against it, and those are a different fact — this room is about what capital work costs and where the capital comes from, not about who was dispatched.",
      establishes: "Governed project terms — budget, approved amount, committed and spent, the source of capital, and the evidence behind each draw.",
    },
    compliance: {
      state: "not_established",
      summary: "No licences, inspections or certificates are established for this property.",
      why: "Spine holds no licences, registrations, inspection schedules or certificates for this property, and tracks no expiry or cure deadlines. Certificates may have been retained during Deal Setup, but nothing has been read out of them, so Spine cannot say whether this property is in good standing.",
      establishes: "Governed compliance records — the issuing body, expiry and renewal date for each licence and registration, and the schedule for each recurring inspection or filing.",
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

      //  ONE room resolves against data. The other three declare, because
      //  a repo-wide search finds no table for any of them — "not
      //  established" there is a statement the server can defend rather
      //  than a placeholder.
      const expenses = await propertyExpensesEstablishment(client, propertyId);
      let compliance = UNBUILT.compliance;
      try {
        const found = await complianceRead.readComplianceEstablishment(client,
          { property_id: propertyId });
        compliance = found.established
          ? {
              state: "partially_established",
              summary: `${found.item_count} governed Compliance item${found.item_count === 1 ? "" : "s"} established. The property-wide requirement census remains unknown.`,
              why: "Spine holds source-backed Compliance truth for this property, but no complete requirement census has been established.",
              establishes: "Additional governed Compliance items and, later, an explicit requirement census.",
              byKey: {
                licenses_registrations: {
                  established: found.license_count > 0,
                  note: found.license_count > 0
                    ? `${found.license_count} governed license or registration item${found.license_count === 1 ? "" : "s"}`
                    : "No governed licences or registrations yet",
                },
                inspections: {
                  established: found.inspection_count > 0,
                  note: found.inspection_count > 0
                    ? `${found.inspection_count} governed inspection item${found.inspection_count === 1 ? "" : "s"}`
                    : "No governed inspections yet",
                },
                certificates: {
                  established: found.certificate_count > 0,
                  note: found.certificate_count > 0
                    ? `${found.certificate_count} governed certificate item${found.certificate_count === 1 ? "" : "s"}`
                    : "No governed certificates yet",
                },
                violations_cure: {
                  established: found.finding_count > 0,
                  note: found.finding_count > 0
                    ? `${found.finding_count} governed violation item${found.finding_count === 1 ? "" : "s"}`
                    : "No governed violations or cures yet",
                },
                recurring_requirements: {
                  established: found.requirement_count > 0,
                  note: found.requirement_count > 0
                    ? `${found.requirement_count} governed applicability item${found.requirement_count === 1 ? "" : "s"}`
                    : "No governed recurring requirements yet",
                },
              },
            }
          : UNBUILT.compliance;
      } catch (e) {
        console.error("asset-management overview: Compliance establishment probe failed", e);
      }

      //  TWO compartments of three can now be live. capital_stack stays
      //  capped at partially_established regardless of how many of
      //  {debt, equity} are established — Reserves & Escrows remains
      //  unbuilt, and Equity's own portfolio survey found that even a
      //  fully "established" equity entity routinely has no named
      //  holders (see docs/EQUITY_READ_CONTRACT_AND_SCHEMA.md, E1/E10),
      //  so `established` here still could not mean the capital
      //  structure is fully accounted for.
      let capitalStack = UNBUILT.capital_stack;
      try {
        const [debtFound, equityFound] = await Promise.all([
          debtSvc.establishmentForProperty(client, propertyId),
          equitySvc.establishmentForProperty(client, propertyId),
        ]);
        if (debtFound.established || equityFound.established) {
          const establishedNotes = [
            debtFound.established ? debtFound.note : null,
            equityFound.established ? equityFound.note : null,
          ].filter(Boolean);
          const missing = [
            !debtFound.established ? "Debt" : null,
            !equityFound.established ? "Equity" : null,
            "Reserves & Escrows",
          ].filter(Boolean);
          capitalStack = {
            state: "partially_established",
            summary: `${establishedNotes.join(". ")}. ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not established.`,
            why: `Spine holds governed capital-stack truth for this property where it has been ` +
                 `established, each fact with its source document. Some of Debt, Equity and ` +
                 `Reserves & Escrows have no governed terms yet, so this room cannot yet state ` +
                 `the full capital structure.`,
            establishes: "Governed debt, equity, preferred-equity and reserve account " +
                         "positions, each with its own evidence.",
            byKey: {
              debt: { established: debtFound.established, note: debtFound.note },
              equity: { established: equityFound.established, note: equityFound.note },
            },
          };
        }
      } catch (e) {
        console.error("asset-management overview: Capital Stack establishment probe failed", e);
      }

      const rooms = ROOMS.map((room) => {
        const found = room.key === "property_expenses" ? expenses
          : room.key === "compliance" ? compliance
          : room.key === "capital_stack" ? capitalStack : UNBUILT[room.key];

        //  A compartment marked `derived` names the module that answers
        //  for it; every other compartment is honestly not established and
        //  says which KIND of thing is missing rather than repeating one
        //  generic line.
        const compartments = (room.compartments || []).map((c) => {
          const answer = c.derived && found.byKey ? found.byKey[c.derived] : null;
          return answer
            ? { key: c.key, label: c.label,
                establishment: answer.established ? "established" : "not_established",
                note: answer.note }
            : { key: c.key, label: c.label,
                establishment: "not_established",
                note: c.note };
        });

        return {
          compartments,
          key: room.key,
          label: room.label,
          covers: room.covers,
          establishment: found.state,

          // ── THE HOME CARD READS THESE THREE, AND NOTHING ELSE ────────
          eyebrow: room.eyebrow,
          belongs: room.belongs,
          //  One line. The card says whether the room is established and
          //  in one breath what that means — never the full account of
          //  what is missing.
          establishment_summary: found.summary,

          // ── ⏳ CLASS 4 — ROOM-LEVEL EXPLANATION, NOT RENDERED IN V1 ──
          //
          //  These three are emitted and no surface reads them. That is
          //  deliberate and it is classified rather than left to rot.
          //
          //  The room page STOPS at its compartment skeleton. Property
          //  Obligations explaining how all four of its children get
          //  established is the wrong altitude — it is more than the
          //  operator asked for, and it is not actionable until you are
          //  standing in the compartment it concerns.
          //
          //  They stay in the response because they are the Exposure
          //  contract's answers for this room and they are true today.
          //
          //  REMOVAL / RELOCATION CONDITION: when the first compartment
          //  surface is built (Insurance), this explanation moves DOWN to
          //  compartment level — each compartment carrying its own why,
          //  its own source documents and its own next owner — and these
          //  room-level fields are deleted in the same commit.
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
        //  NO scope_note. It used to sit under the desk explaining that
        //  this door returns no amounts — developer language leaking into
        //  the product. The honest cards already say the same thing in the
        //  operator's words, and a caveat nobody needs is just noise on a
        //  surface whose whole job is calm.
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

  /* ════════════════════════════════════════════════════════════════════
   *  GET /operator/asset-management/insurance
   *
   *  The Insurance compartment of Property Obligations. The FIRST
   *  compartment to get its own surface.
   *
   *  ── INSURANCE IS PROPERTY-CENTRIC ON THE SURFACE, EVEN WHEN THE
   *     UNDERLYING INSURANCE IS NOT ─────────────────────────────────
   *  The reality underneath includes portfolio and shared programs,
   *  property-specific policies, Property / GL / Umbrella / Excess
   *  layers, several carriers, mid-term endorsements and additions,
   *  property allocations, premium plus taxes and fees, lender escrow,
   *  and premium financing with down payments and installments.
   *
   *  The asset manager must not have to reconstruct any of that. This
   *  screen answers ONE question — what is this property's current
   *  insurance position — and everything else is a drill-down.
   *
   *  ── FOUR TRUTHS THAT MUST NEVER COLLAPSE INTO ONE RECORD ────────
   *
   *    coverage   what coverage/program/policy applies, for what period
   *    economic   what cost belongs to THIS property and THIS period
   *    cash       what was or will be paid, when, through which escrow
   *               or financing path
   *    history    what changed, when, and why
   *
   *  Each section below declares which truth it holds, in the response,
   *  so the separation survives a later reader who did not read this
   *  comment. They must reconcile eventually. They must never become one
   *  mutable insurance row.
   *
   *  THE DOCTRINE THAT DECIDES THE ECONOMIC SECTION:
   *    Coverage period determines when the expense economically belongs.
   *    Cash payment timing does not.
   *  A $120k premium paid once in January belongs ~$10k to each month it
   *  covers. That is §39 — cash and accrual are two readings of one
   *  history — arriving at its first real domain.
   *
   *  ── WHAT THIS SLICE IS NOT ──────────────────────────────────────
   *  No policy schema, no allocation engine, no accrual generator, no
   *  financing math, no document extraction, no accounting recognition.
   *  Those are gated on research still running. This returns the
   *  permanent SHAPE with honest blanks, and the API keeps ownership of
   *  all future math so the surface never computes anything.
   *
   *  CLASS 2 (permanent). The skeleton is permanent; only its facts fill.
   * ════════════════════════════════════════════════════════════════════ */

  //  The headline strip. Five slots reserved for real facts, rendered as
  //  honest blanks until governed insurance truth exists. `value: null` is
  //  the whole point — never zero, never "$0", never a dash pretending to
  //  be a number (§5, and the MONEY_OBLIGATION_CONTRACT rule that an
  //  amount is "a resolved number, OR an explicit unresolved reason").
  const INSURANCE_POSITION = Object.freeze([
    { key: "coverage", label: "Coverage",
      awaiting: "Current coverage has not been established." },
    { key: "annual_cost", label: "Annual Cost",
      awaiting: "Annual allocated economic cost is not established." },
    { key: "monthly_accrual", label: "Monthly Accrual",
      awaiting: "No expense has been recognised for this period." },
    { key: "next_renewal", label: "Next Renewal",
      awaiting: "No renewal or expiration date is established." },
    { key: "payment", label: "Payment",
      awaiting: "Direct, escrowed or financed is not established." },
  ]);

  const INSURANCE_SECTIONS = Object.freeze([
    Object.freeze({
      key: "coverage_stack",
      label: "Coverage Stack",
      truth: "coverage",
      blurb: "The insurance affecting this property.",
      //  DO NOT ASSUME ONE POLICY PER PROPERTY. A property can sit under a
      //  portfolio program for Property, a separate GL policy, and an
      //  umbrella above both — three carriers, three periods, one property.
      layers: ["Property", "General Liability", "Umbrella / Excess", "Other"],
      reserved: ["Carrier", "Policy / program reference", "Coverage period",
                 "Current · expiring · historical",
                 "Individually insured or part of a shared program"],
      awaiting: "No governed policies or programs are established for this property.",
    }),
    Object.freeze({
      key: "economic_position",
      label: "Economic Position",
      truth: "economic",
      blurb: "What insurance costs this property and when it belongs.",
      reserved: ["Premium", "Taxes", "Fees", "Total program / policy cost",
                 "Property allocation", "Property-level economic cost",
                 "Coverage / economic period", "Monthly / period accrual"],
      //  Stated in the payload, not just in this comment, because it is the
      //  rule that decides every number this section will ever show.
      doctrine: "Coverage period determines when the expense economically belongs. Cash payment timing does not.",
      awaiting: "No premium, allocation or accrual is established.",
    }),
    Object.freeze({
      key: "cash_financing",
      label: "Cash & Financing",
      truth: "cash",
      blurb: "What is actually paid, when, and how.",
      reserved: ["Direct payment", "Lender escrow", "Premium financing",
                 "Finance company", "Down payment", "Financed amount",
                 "Installment count", "Installment amount",
                 "First payment · payment schedule"],
      //  SEPARATE FROM ECONOMIC POSITION, PERMANENTLY. The surface must be
      //  able to say "economic insurance expense this month = X" and "cash
      //  insurance payment this month = Y" and treat NEITHER as the error.
      //  Collapsing them is how a financed premium reads as twelve months
      //  of expense in the month the down payment cleared.
      awaiting: "No payment, escrow or financing arrangement is established.",
    }),
    Object.freeze({
      key: "renewals_history",
      label: "Renewals & History",
      truth: "history",
      blurb: "What changed, when, and why.",
      reserved: ["Renewals", "Endorsements", "Mid-term additions / removals",
                 "Carrier changes", "Premium / allocation changes",
                 "Cancelled or replaced policies", "Source documents · proof"],
      //  INSURANCE CHANGES AMEND HISTORY. THEY DO NOT OVERWRITE IT.
      //  A 2026 renewal is a NEW governed term. A mid-year endorsement is a
      //  dated change. The prior term stays historically true, because a
      //  reported period must still be explainable after the policy that
      //  produced it has been replaced. Same shape as the claim-scoped
      //  supersession ruling: history accumulates, it does not advance.
      doctrine: "A renewal is a new governed term and an endorsement is a dated change. The prior term stays historically true.",
      awaiting: "No renewals, endorsements or history are recorded.",
    }),
  ]);

  //  Money is rendered by the SERVER, never by the browser. desks.js
  //  states the rule for the other three doors — "the backend owns the
  //  headline math; the front end renders labels" — and a currency
  //  formatted two ways is two different numbers to a reader.
  function money(cents, currency) {
    if (cents === null || cents === undefined) return null;
    const sign = cents < 0 ? "-" : "";
    const whole = Math.floor(Math.abs(cents) / 100).toLocaleString("en-US");
    const frac = String(Math.abs(cents) % 100).padStart(2, "0");
    //  AN UNKNOWN CURRENCY MUST NOT PRINT ITSELF. `currency + " "` with a
    //  null currency rendered "null 9,400.00" on a real screen — a caller
    //  formatting a governed amount for a property that has no allocation,
    //  and therefore no currency from the position. The amount is real;
    //  only its denomination is unknown, so the number stands alone rather
    //  than wearing the word null.
    const unit = currency === "USD" ? "$" : (currency ? currency + " " : "");
    return `${sign}${unit}${whole}.${frac}`;
  }

  const COVERAGE_LABEL = Object.freeze({
    property: "Property", general_liability: "General Liability",
    umbrella_excess: "Umbrella / Excess", other: "Other",
  });

  function currentPeriod() {
    const n = new Date();
    return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  router.get("/operator/asset-management/insurance", ...gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    //  A PREFERENCE, not authority. The browser may ask about a month; it
    //  may not ask about a property.
    const period = /^\d{4}-\d{2}$/.test(String(req.query && req.query.period || ""))
      ? String(req.query.period) : currentPeriod();

    let client;
    try {
      client = await pool.connect();
      const position = await insurancePosition.readPosition(client, { property_id: propertyId, period });
      //  Every coverage this property is NAMED ON, allocated or not. This
      //  is a SUPERSET of position.coverages — migration 162's foreign key
      //  guarantees it, because an allocation cannot exist without one.
      const participation = await insurancePosition.readParticipation(client,
        { property_id: propertyId, period });
      //  Read alongside, never mixed in. Nothing from this read reaches
      //  annual_cost or monthly_accrual — those come from readPosition,
      //  which cannot see the funding tables at all.
      const funding = await insuranceFundingRead.readFunding(client,
        { property_id: propertyId, period });
      const completeness = position.established
        ? await insurancePosition.readCompleteness(client, { property_id: propertyId, period })
        : [];
      const history = position.established
        ? await insurancePosition.readHistory(client, { property_id: propertyId })
        : [];

      const cur = position.currency_code;
      const established = position.established;

      //  ── THE POSITION STRIP ────────────────────────────────────────
      //  Four slots fill from governed truth. PAYMENT stays unestablished
      //  because financing is a different chain and is not built — and
      //  saying so is the honest answer, not a gap in this one.
      const VALUES = {
        //  COUNTED FROM PARTICIPATION. A coverage this property is named
        //  on is active insurance whether or not its share is worked out,
        //  and reporting "1 active" while the property sits on three real
        //  policies would understate the coverage it actually has.
        coverage: participation.participates
          ? `${participation.coverages.length} active`
          : null,
        //  ⚠ MONEY STAYS ALLOCATION-GATED, AND MUST. These come from
        //  readPosition, which is unchanged. A coverage with no stated
        //  share contributes NOTHING here — its cost to this property is
        //  unknown, and the policy's own total is what the whole policy
        //  costs across every property on it, not what this one owes.
        //  Blank, never zero (§39).
        annual_cost: money(position.annual_cost_cents, cur),
        monthly_accrual: money(position.period_accrual_cents, cur),
        //  From participation, so a policy expiring soon is reported even
        //  while its share is unestablished. A date is not a cost.
        next_renewal: participation.next_renewal,
        //  ── HOW IT IS PAID, ONCE SOMEBODY HAS RECORDED IT ──────────
        //  This cell was permanently null while the funding chain did not
        //  exist. It does now, and leaving it blank would be honest-blank
        //  inverted: claiming ignorance of something Spine holds. The
        //  slot has always been named PAYMENT for exactly this.
        //
        //  A LABEL, NEVER AN AMOUNT. Every financing figure — installment,
        //  down payment, finance charge, total of payments — stays inside
        //  Cash & Financing. A borrowing cost sitting in a strip of
        //  insurance figures is how it starts reading as one.
        //
        //  Several methods are NAMED, not averaged into "Mixed": a
        //  property whose Property policy is escrowed and whose GL is
        //  financed is two different arrangements, and the strip can say
        //  so in the space it has.
        payment: funding.established
          ? Array.from(new Set(funding.arrangements.map((a) => a.method_label))).join(" · ")
          : null,
      };
      //  Keys and labels come from INSURANCE_POSITION — the one place the
      //  strip is defined. Building them inline here would have been a
      //  second definition of the same five slots, drifting from the first
      //  the moment either changed.
      const positionCells = INSURANCE_POSITION.map((p) => ({
        key: p.key, label: p.label,
        value: VALUES[p.key] === undefined ? null : VALUES[p.key],
      }));

      //  ── COVERAGE STACK ────────────────────────────────────────────
      //  Built from PARTICIPATION, not from the allocation-gated position.
      //  Coverage is a coverage whether or not anyone has worked out this
      //  property's share of it, and rendering only the allocated ones is
      //  what made an honestly-partial establishment look like nothing.
      //
      //  ⚠ TWO SENSES OF ONE WORD, KEPT APART ON PURPOSE.
      //    `sharing`          how many properties are on this policy
      //    participation      THE ROW EXISTS AT ALL — this property is
      //                       named on this coverage
      //  The field below was called `participation` while it meant only
      //  the first. Now that the second is a real durable fact with its
      //  own table, one name for both would be the merge CLAUDE.md warns
      //  about, so the display string is `sharing` and the fact keeps the
      //  name. Renaming a response key is a contract change, so the old
      //  key is still emitted beside it — see below.
      const stackRows = participation.coverages.map((c) => ({
        coverage_id: c.coverage_id,
        label: COVERAGE_LABEL[c.coverage_type] || c.coverage_type,
        carrier: c.carrier_name,
        program: c.program_name,
        period: `${c.coverage_period_start} – ${c.coverage_period_end}`,
        //  Counted from the participation table, so a policy naming three
        //  properties reads as shared from the first one established —
        //  not only once somebody has allocated all three.
        sharing: c.properties_on_policy > 1
          ? `Shared — ${c.properties_on_policy} properties`
          : "Individually insured",
        //  ⏳ CLASS 2 — COMPATIBILITY KEY. The deployed app reads
        //  `participation` as the display string. An API output key is a
        //  contract and 159 already broke one by renaming without the
        //  reader; this emits both so the app can move first.
        //  REMOVAL CONDITION: delete once no deployed app build reads
        //  `row.participation` — grep property-spine-app/index.html and
        //  asset-management-door.js before removing.
        participation: c.properties_on_policy > 1
          ? `Shared — ${c.properties_on_policy} properties`
          : "Individually insured",
        //  THE NEW TRUTH THE STACK CAN NOW TELL. A row is real coverage
        //  either way; this says whether its cost to THIS property is
        //  known yet. Never a zero, never an estimate.
        share_established: c.share_established,
        share_status: c.share_established ? "established" : "not_established",
        provenance_strength: c.provenance_strength,
      }));

      //  ── ECONOMIC POSITION ─────────────────────────────────────────
      //  stated and derived stay visibly different classes all the way to
      //  the surface, and a derived row carries the model that made it.
      const economicRows = position.coverages.map((c) => ({
        coverage_id: c.coverage_id,
        label: COVERAGE_LABEL[c.coverage_type] || c.coverage_type,
        property_annual_cost: money(c.property_annual_cost_cents, c.currency_code),
        monthly_accrual: money(c.property_monthly_accrual_cents, c.currency_code),
        term_months: c.term_months,
        allocation_class: c.allocation_class,
        allocation_basis: c.allocation_basis,
        basis_detail: c.basis_detail,
        provenance_strength: c.provenance_strength,
        effective_from: c.effective_from,
        effective_to: c.effective_to,
      }));

      //  THE UNRESOLVED REMAINDER. Stated, never plugged.
      const unreconciled = completeness.filter((c) => !c.reconciles).map((c) => ({
        label: COVERAGE_LABEL[c.coverage_type] || c.coverage_type,
        unallocated: money(c.unallocated_cents, cur),
      }));

      //  ── COVERAGE ESTABLISHED, SHARE NOT ───────────────────────────
      //  Named in the economic section, because that is where somebody is
      //  reading the numbers and needs to know a real coverage is
      //  contributing NOTHING to them yet.
      //
      //  This satisfies the Exposure contract's shape: what it is about,
      //  why Spine cannot stand behind it, what would resolve it, when it
      //  was observed. MAGNITUDE IS DELIBERATELY ABSENT — the whole policy
      //  total is not this property's share, and putting a number here
      //  that nobody stated is the confident-wrong this refuses to be.
      //  Unknown is a valid Exposure; zero would be a lie.
      const awaitingAllocation = participation.awaiting_allocation.map((c) => ({
        coverage_id: c.coverage_id,
        label: COVERAGE_LABEL[c.coverage_type] || c.coverage_type,
        carrier: c.carrier_name,
        program: c.program_name,
        period: `${c.coverage_period_start} – ${c.coverage_period_end}`,
        sharing: c.properties_on_policy > 1
          ? `Shared — ${c.properties_on_policy} properties`
          : "Individually insured",
        //  Unknown, and said so rather than shown as a dash or a zero.
        property_share: null,
        why: "This property's share of this policy has not been established.",
        //  Reads after `why`, so it has to be a sentence rather than a
        //  fragment. On screen the two run together and "A stated share for
        //  this property." on its own read like a truncated thought.
        resolved_by: c.properties_on_policy > 1
          ? "Resolved by the allocation schedule, or a broker-stated share for this property."
          : "Resolved by a stated share for this property.",
        observed_as_of: c.observed_as_of,
      }));

      return res.json({
        property_id: propertyId,
        room: "property_expenses",
        compartment: "insurance",
        label: "Insurance",
        period,
        currency_code: cur,
        //  Driven by PARTICIPATION, not by the allocation. Coverage
        //  recorded with its share still missing is real work and must not
        //  report as nothing — that equivalence is what this slice exists
        //  to end. Still never "established": the cash path is unbuilt.
        establishment: participation.participates ? "partially_established" : "not_established",

        //  The state the dashboard could not previously express, said in
        //  one place so no surface has to derive it from row counts.
        participates: participation.participates,
        awaiting_allocation_count: participation.awaiting_allocation_count,

        //  How it is paid, said at the top level so a surface does not
        //  have to dig it out of a section to know whether it is known.
        //  It is deliberately NOT in the position strip's money cells.
        funding_established: funding.established,
        funding_methods: funding.methods,

        //  ── ARE WE INSURED, AND IN GOOD STANDING? ──────────────────
        //  Derived here, every request, from coverage periods and the
        //  presence of a bound successor. Never stored, so it cannot go
        //  stale and no backfill is needed when a renewal is recorded.
        //
        //  It is deliberately NOT gated on allocation: whether this
        //  property's share of a policy has been worked out has nothing
        //  to do with whether the property is covered.
        standing: insuranceStanding.standingOf({
          coverages: participation.coverages,
          asOf: (req.query && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.as_of || "")))
            //  A PREFERENCE, not authority — the same rule `period` follows.
            //  It exists so a proof can ask about a date without waiting for
            //  one, and it can only move the clock, never the property.
            ? String(req.query.as_of) : null,
        }),

        position: positionCells.map((p) => ({
          key: p.key, label: p.label, value: p.value,
        })),

        //  ROWS ARE MERGED INTO THE SPEC, not restated beside it.
        //  `reserved` and `doctrine` live in INSURANCE_SECTIONS and are
        //  still emitted: no surface prints them — a browser assertion
        //  enforces that — but they are what says what a section will
        //  hold, and Cash & Financing has nothing else to say it with
        //  while its chain is unbuilt. Proofs and docs read them.
        sections: INSURANCE_SECTIONS.map((sec) => {
          const live = {
            //  Coverage is established when the property is NAMED on a
            //  policy. Its cost being unknown is the economic section's
            //  problem to state, not a reason to deny the coverage exists.
            coverage_stack:     { rows: stackRows,
                                  establishment: participation.participates
                                    ? "established" : "not_established" },
            //  Three states, not two. `partially_established` is the one
            //  the schema could not previously represent: some real cost
            //  is known AND some coverage still has no stated share.
            economic_position:  { rows: economicRows, unreconciled,
                                  awaiting_allocation: awaitingAllocation,
                                  establishment:
                                    !established
                                      ? "not_established"
                                      : (awaitingAllocation.length
                                          ? "partially_established" : "established") },
            //  ── HOW IT IS PAID. NEVER WHAT IT COSTS. ──────────────
            //  Established means somebody recorded the mechanism —
            //  including recording that it is paid DIRECTLY, which is a
            //  positive finding. Absence stays not_established: no
            //  arrangement means Spine does not know, and defaulting to
            //  "direct" would be a healthy state invented from silence.
            cash_financing:     { rows: funding.arrangements.map((a) => ({
                                    arrangement_id: a.arrangement_id,
                                    coverage_id: a.coverage_id,
                                    label: COVERAGE_LABEL[a.coverage_type] || a.coverage_type,
                                    carrier: a.carrier_name,
                                    method: a.funding_method,
                                    method_label: a.method_label,
                                    effective_from: a.effective_from,
                                    provenance_strength: a.provenance_strength,
                                    corrected: a.corrected,
                                    //  FINANCING FIGURES, FORMATTED AND
                                    //  NAMED AS SUCH. `finance_charge` is
                                    //  the cost of borrowing, not part of
                                    //  what insurance costs, and
                                    //  `total_of_payments` is what goes to
                                    //  the finance company — neither is an
                                    //  insurance number and neither
                                    //  appears in the position strip.
                                    //  The PROGRAM's currency, not the
                                    //  position's: financing exists whether
                                    //  or not this property's share does,
                                    //  and `cur` is null until an allocation
                                    //  establishes one.
                                    finance: a.finance ? (function (fc) { return {
                                      provider: a.finance.finance_provider,
                                      down_payment: money(a.finance.down_payment_cents, fc),
                                      principal_financed: money(a.finance.principal_financed_cents, fc),
                                      finance_charge: money(a.finance.finance_charge_cents, fc),
                                      installments: (a.finance.installment_count !== null
                                        && a.finance.installment_cents !== null)
                                        ? `${a.finance.installment_count} × ` +
                                          `${money(a.finance.installment_cents, fc)}`
                                        : null,
                                      first_payment_date: a.finance.first_payment_date,
                                      total_of_payments: money(a.finance.total_of_payments_cents, fc),
                                    }; })(a.currency_code || cur) : null,
                                    escrow: a.escrow || null,
                                  })),
                                  establishment: funding.established
                                    ? "established" : "not_established" },
            //  Label the coverage type here, where COVERAGE_LABEL lives.
            //  `general_liability` is a schema token and an operator
            //  should never be shown one.
            renewals_history:   { rows: history.map((h) => ({
                                    ...h,
                                    coverage_type: COVERAGE_LABEL[h.coverage_type] || h.coverage_type })),
                                  establishment: history.length ? "established" : "not_established" },
          }[sec.key] || { rows: [], establishment: "not_established" };

          return {
            key: sec.key, label: sec.label, truth: sec.truth, blurb: sec.blurb,
            establishment: live.establishment,
            reserved: sec.reserved,
            ...(sec.layers ? { layers: sec.layers } : {}),
            ...(sec.doctrine ? { doctrine: sec.doctrine } : {}),
            rows: live.rows,
            ...(live.unreconciled ? { unreconciled: live.unreconciled } : {}),
            //  Coverage whose share is unknown. Emitted even when empty,
            //  so a surface can tell "none outstanding" from "this build
            //  does not report it" — absent and zero are different answers.
            ...(live.awaiting_allocation ? { awaiting_allocation: live.awaiting_allocation } : {}),
          };
        }),
      });
    } catch (e) {
      console.error("operator/asset-management/insurance error", e);
      return res.status(503).json({ error: "insurance compartment unavailable" });
    } finally {
      if (client) client.release();
    }
  });

  /* ════════════════════════════════════════════════════════════════════
   *  GET /operator/asset-management/taxes
   *
   *  The Taxes compartment of Property Obligations. FOUR ROWS, because
   *  Philadelphia has four governed taxes and an operator should be able
   *  to answer "are our taxes current" in one look.
   *
   *      Real Estate Tax   the PROPERTY owes it, annual, due Mar 31
   *      BIRT              the TAXPAYER owes it, annual return Apr 15
   *      NPT               the TAXPAYER owes it, return + two estimates
   *      U&O               tied to business USE, monthly, due the 25th
   *
   *  Commercial Trash is deliberately absent. It is a municipal fee with
   *  its own exemption machinery, not one of these four.
   *
   *  ── THE COMPOSITION IS THE POINT, AND SO IS THE SEAM ────────────
   *  Two reads, held apart:
   *
   *      tax_position_read   what is owed, filed, paid — the economics
   *      tax_funding_read    how it is paid for — escrow, contribution,
   *                          balance, the servicer's disbursements
   *
   *  This surface is the only place they meet, and they meet by
   *  ADJACENCY, never by merge. Funding is attached under each row's
   *  `funding` key and contributes NOTHING to that row's `state`,
   *  `annual_liability_cents` or `monthly_accrual_cents`. A surface is
   *  allowed to compose what the economic chain may not import.
   *
   *  ── WHAT THE SCREEN MUST NEVER SAY ──────────────────────────────
   *  That a bill is paid because an escrow is funded. `state` comes from
   *  the position read, which cannot see an escrow by any path, and the
   *  boundary gate fails the build if that ever stops being true.
   *
   *  CLASS 1 (permanent).
   * ════════════════════════════════════════════════════════════════════ */

  //  The headline strip. Honest blanks until governed truth exists —
  //  never zero, never a dash pretending to be a number (§5).
  const TAX_POSITION = Object.freeze([
    { key: "standing", label: "Standing",
      awaiting: "No tax applicability has been confirmed." },
    { key: "annual_liability", label: "Annual Liability",
      awaiting: "No governed liability is established." },
    { key: "monthly_accrual", label: "Monthly Accrual",
      awaiting: "No expense has been recognised for this period." },
    { key: "next_due", label: "Next Due",
      awaiting: "No due date is established." },
    { key: "funding", label: "Funding",
      awaiting: "Escrowed or paid directly is not established." },
  ]);

  const TAX_STANDING_LABEL = Object.freeze({
    not_established: "Not established",
    overdue: "Overdue",
    action_required: "Action required",
    current: "Current",
  });

  router.get("/operator/asset-management/taxes", ...gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    //  A PREFERENCE, not authority. The browser may ask about a date; it
    //  may not ask about a property.
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query && req.query.as_of || ""))
      ? String(req.query.as_of) : null;

    let client;
    try {
      client = await pool.connect();

      const position = await taxPosition.readTaxPosition(client,
        { property_id: propertyId, as_of: asOf, rules: taxRules });
      //  Read alongside, never mixed in. Nothing from this read reaches
      //  any row's state, liability or accrual.
      const funding = await taxFundingRead.readTaxFunding(client,
        { property_id: propertyId, as_of: asOf });

      //  ── TOTALS ────────────────────────────────────────────────────
      //  Only what is KNOWN is summed, and the count of unknowns travels
      //  with the total. A sum of three of four liabilities presented as
      //  "the annual tax" is a confident wrong number at exactly the
      //  altitude where it reaches a lender.
      const applicable = position.rows.filter((r) => r.applicability === "applies");
      const known = applicable.filter((r) => r.annual_liability_cents !== null);
      const unknownCount = applicable.length - known.length;
      //  ⚠ A TAX NOBODY HAS ANSWERED FOR MAKES THE TOTAL PARTIAL TOO.
      //  The first version counted only APPLICABLE obligations missing an
      //  amount, so a property with one established bill and three
      //  unanswered taxes showed a confident-looking total with no caveat.
      //  A browser proof caught it. Not knowing whether a tax applies is
      //  not the same as it contributing zero.
      const unresolved = position.rows
        .filter((r) => r.applicability === "not_established").length;
      const currencies = Array.from(new Set(known.map((r) => r.currency_code).filter(Boolean)));
      const cur = currencies.length === 1 ? currencies[0] : null;
      const totalAnnual = known.length
        ? known.reduce((a, r) => a + r.annual_liability_cents, 0) : null;
      const totalAccrual = known.length
        ? known.reduce((a, r) => a + (r.monthly_accrual_cents || 0), 0) : null;

      const VALUES = {
        standing: TAX_STANDING_LABEL[position.overall] || null,
        //  Blank while nothing is known. Partial while some is — and it
        //  says so beside the number rather than presenting a subtotal as
        //  a total.
        annual_liability: money(totalAnnual, cur),
        monthly_accrual: money(totalAccrual, cur),
        next_due: position.next_due,
        //  A LABEL, NEVER AN AMOUNT. The monthly escrow contribution is
        //  cash to a servicer; putting it in a strip of tax figures is how
        //  it starts reading as the tax.
        funding: funding.established
          ? Array.from(new Set(funding.arrangements.map((a) => a.method_label))).join(" · ")
          : null,
      };

      const positionCells = TAX_POSITION.map((p) => ({
        key: p.key, label: p.label,
        value: VALUES[p.key] === undefined ? null : VALUES[p.key],
        awaiting: (VALUES[p.key] === undefined || VALUES[p.key] === null) ? p.awaiting : null,
      }));

      return res.json({
        compartment: "taxes",
        room: "property_expenses",
        acting_on: propertyId,
        jurisdiction: position.jurisdiction,
        as_of: position.as_of,
        overall: position.overall,
        overall_why: position.overall_why,
        position: positionCells,
        totals: {
          annual_liability_cents: totalAnnual,
          monthly_accrual_cents: totalAccrual,
          currency_code: cur,
          //  Stated, not hidden. This is the difference between "the
          //  annual tax is $48,000" and "the annual tax is at least
          //  $48,000, and one obligation has no bill yet".
          obligations_with_unknown_amount: unknownCount,
          //  The other way a total can be short: a tax nobody has yet said
          //  applies or does not. Counted separately because they are
          //  different gaps with different next steps.
          taxes_not_established: unresolved,
          is_partial: unknownCount > 0 || unresolved > 0,
        },

        //  ── THE FOUR ROWS ─────────────────────────────────────────
        //  Position first, funding attached beside it. The spread order
        //  is deliberate: funding is added UNDER its own key and can
        //  never overwrite a state, a liability or an accrual.
        rows: position.rows.map((r) => {
          const arr = funding.arrangements.find((a) => a.tax_type === r.tax_type) || null;
          const gaps = funding.unevidenced_disbursements
            .filter((d) => d.tax_type === r.tax_type);
          return {
            ...r,
            //  A JURISDICTION RULE, SENT RATHER THAN RE-IMPLEMENTED.
            //  Real Estate Tax is billed by the City and paid; there is no
            //  return. The browser must not decide that — a second copy of
            //  Philadelphia's rules in an app is a copy nobody updates.
            requires_filing: !!taxRules.REQUIRES_FILING[r.tax_type],
            annual_liability: money(r.annual_liability_cents, r.currency_code),
            monthly_accrual: money(r.monthly_accrual_cents, r.currency_code),
            city_balance: money(r.city_balance_cents, r.currency_code),
            funding: arr ? {
              arrangement_id: arr.arrangement_id,
              funding_method: arr.funding_method,
              method_label: arr.method_label,
              escrow: arr.escrow ? {
                ...arr.escrow,
                monthly_contribution: money(arr.escrow.monthly_contribution_cents, cur || "USD"),
                balance_amount: arr.escrow.balance
                  ? money(arr.escrow.balance.balance_cents, arr.escrow.balance.currency_code)
                  : null,
              } : null,
            } : null,
            //  UNKNOWN, SAID AS UNKNOWN. An absent arrangement is never
            //  rendered as "paid directly".
            funding_awaiting: arr ? null
              : "How this is paid has not been established.",
            //  ⚠ THE DISAGREEMENT, CARRIED ONTO THE ROW.
            //  The servicer says they paid it; Spine has no City evidence.
            //  It sits beside the row's state, which stays unpaid.
            unevidenced_disbursements: gaps,
          };
        }),

        //  BIRT and NPT belong to these, not to the property.
        entities: position.entities,
        clearance: position.clearance,
        //  The correction that matters this year: the exemption ended,
        //  the tax did not.
        uo_exemption: position.uo_exemption,
        funding_summary: {
          established: funding.established,
          unknown_for: funding.unknown_for,
          unevidenced_disbursements: funding.unevidenced_disbursements,
        },
      });
    } catch (e) {
      console.error("operator/asset-management/taxes error", e);
      return res.status(503).json({ error: "taxes compartment unavailable" });
    } finally {
      if (client) client.release();
    }
  });

  /*  ── THE INSURANCE WRITE PATH ──────────────────────────────────────
   *  Mounted behind THIS door's authority, injected rather than
   *  re-implemented. The establishment module owns what the routes do;
   *  this file owns who may reach them. Two copies of an authority rule
   *  is a §17 defect even while the copies agree, and it is exactly how
   *  the two would drift the first time either changed.
   */
  router.use(insuranceFunding({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    currentPeriod,
  }));

  router.use(insuranceEstablishment({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    currentPeriod,
    //  OPTIONAL BY DESIGN. Without it the evidence route still retains the
    //  document and simply reports that Spine has not read it — which is
    //  the honest answer and was the shipped behaviour before the scan
    //  existed. A missing reader degrades to a blank form, never to a
    //  broken upload.
    fileToText,
  }));

  /*  ── THE TAX WRITE PATHS ───────────────────────────────────────────
   *  Two routers, mounted side by side, that may not import each other.
   *  Funding first, matching Insurance: neither order matters to Express,
   *  and keeping the two surfaces identical means a reader who has
   *  understood one has understood both.
   */
  router.use(taxFunding({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  }));

  router.use(taxEstablishment({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    //  OPTIONAL BY DESIGN, exactly as in Insurance. Without it the
    //  evidence route still retains the document and reports honestly
    //  that Spine has not read it. A missing reader degrades to a blank
    //  form, never to a broken upload.
    fileToText,
  }));

  router.use(utilityRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    fileToText,
  }));

  router.use(contractedServiceRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    fileToText,
  }));

  router.use(legalEntityRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  }));

  router.use(debtRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  }));

  router.use(equityRoutes({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  }));

  router.use(complianceHttp({
    pool, fileToText, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  }));

  return router;
};

module.exports.ROOMS = ROOMS;
module.exports.ESTABLISHMENT_STATES = ESTABLISHMENT_STATES;
