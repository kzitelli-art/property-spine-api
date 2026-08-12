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
const ROOMS = Object.freeze([
  Object.freeze({
    key: "revenue",
    label: "Revenue",
    covers: ["Rent", "Vacancy", "Concessions", "Other Income"],
    eyebrow: ["Rent", "Vacancy", "Concessions", "Other Income"],
    belongs: "What this property earns, and what it fails to earn.",
    compartments: [
      //  `rent` is the one compartment with a live source today, so its
      //  establishment is resolved per property rather than declared here.
      { key: "rent", label: "Rent", derived: true },
      { key: "vacancy", label: "Vacancy", note: "No governed vacancy position yet" },
      { key: "concessions", label: "Concessions", note: "No governed concession terms yet" },
      { key: "other_income", label: "Other Income", note: "No governed other-income terms yet" },
    ],
  }),
  Object.freeze({
    key: "capital",
    label: "Capital",
    covers: ["Senior Debt", "Mezzanine Debt", "Preferred Equity", "Reserves / Escrows"],
    eyebrow: ["Senior Debt", "Mezzanine Debt", "Preferred Equity", "Reserves / Escrows"],
    belongs: "How the property is financed, and what that structure costs.",
    compartments: [
      { key: "senior_debt", label: "Senior Debt", note: "No governed senior debt yet" },
      { key: "mezzanine", label: "Mezzanine Debt", note: "No governed mezzanine debt yet" },
      { key: "preferred_equity", label: "Preferred Equity", note: "No governed preferred equity yet" },
      { key: "reserves", label: "Reserves / Escrows", note: "No governed reserves or escrows yet" },
    ],
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
    eyebrow: ["Taxes", "Insurance", "Licenses & Registrations", "Compliance"],
    belongs: "The recurring obligations required to own and operate this property.",
    //  ONE ordering of this list, everywhere. covers, eyebrow and
    //  compartments agree, so nobody has to wonder which is canonical.
    compartments: [
      { key: "taxes", label: "Taxes", note: "No governed tax obligations yet" },
      { key: "insurance", label: "Insurance", note: "No governed policies yet" },
      { key: "licenses", label: "Licenses & Registrations", note: "No governed licenses yet" },
      { key: "compliance", label: "Compliance", note: "No governed compliance obligations yet" },
    ],
  }),
  Object.freeze({
    key: "operating_costs",
    label: "Operating Costs",
    covers: ["Payroll", "Management Fees", "Utilities", "Contracts", "Repairs / other"],
    eyebrow: ["Payroll", "Management Fees", "Utilities", "Contracts", "Repairs"],
    belongs: "What it costs to run the property day to day.",
    compartments: [
      { key: "payroll", label: "Payroll", note: "No governed payroll allocation yet" },
      { key: "management_fees", label: "Management Fees", note: "No governed fee terms yet" },
      { key: "utilities", label: "Utilities", note: "No governed utility accounts yet" },
      { key: "contracts", label: "Contracts", note: "No governed service contracts yet" },
      { key: "repairs", label: "Repairs / other", note: "No governed operating expense terms yet" },
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
        //  SHORT — the home card. One line, no machinery. It must stay
        //  shorter than the room's own explanation below; a card line that
        //  outgrows the room is the card quietly becoming the room again.
        summary: "No revenue economics are established yet.",
        compartment_note: "No governed rent position yet",
        //  LONG — inside the room, where it becomes setup guidance.
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
      //  SHORT — the home card. Says what IS available and what is not, in
      //  one breath, with no counts and no machinery.
      summary: "Base rent is available from current leases. Additional revenue economics are not yet established.",
      compartment_note: "Base rent from current leases",
      why: `${subject} a rent amount and a term, so a flat monthly rent position is real. Rent escalations and recurring charges (parking, pet, utilities billed to residents) are not represented anywhere yet, so this room cannot yet state a complete revenue position.`,
      establishes: "Rent escalation schedules and a recurring-charge model.",
    };
  }

  //  The three rooms with no primitives at all. Their text is the Exposure
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
    capital: {
      state: "not_established",
      summary: "No debt, equity or reserve terms are established for this property.",
      why: "Spine holds no debt, equity or reserve instruments for this property. Loan documents may have been retained during Deal Setup, but no economic terms have been read out of them, so there is nothing to stand behind.",
      establishes: "Governed debt and equity terms — principal, rate, accrual basis, payment schedule — read from the loan documents.",
    },
    property_obligations: {
      state: "not_established",
      summary: "No tax, insurance, licence or compliance obligations are established for this property.",
      //  The sentence has to cover the whole room, not the two examples
      //  that are easiest to name. A room whose sub-labels promise
      //  licences and compliance while its copy only mentions tax and
      //  insurance is quietly telling the operator the rest is handled.
      why: "Spine holds no tax obligations, insurance policies, licences or registrations for this property, and tracks no filing or renewal dates. Bills, policies and certificates may have been retained during Deal Setup, but nothing has been read out of them, so Spine cannot say what this property owes or when anything is due.",
      establishes: "Governed obligation terms — amount and period covered for tax and insurance, and the issuing body, expiry and renewal date for each licence, registration and recurring filing.",
    },
    operating_costs: {
      state: "not_established",
      summary: "No payroll, fee, utility or contract terms are established for this property.",
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

        //  A compartment marked `derived` resolves against real data; every
        //  other compartment is honestly not established, and says which
        //  KIND of thing is missing rather than repeating one generic line.
        const compartments = (room.compartments || []).map((c) => (
          c.derived
            ? { key: c.key, label: c.label,
                establishment: revenue.state,
                note: revenue.compartment_note }
            : { key: c.key, label: c.label,
                establishment: "not_established",
                note: c.note }
        ));

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
    return `${sign}${currency === "USD" ? "$" : currency + " "}${whole}.${frac}`;
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
        //  Deliberately null, permanently, while this slice stands.
        //  Direct / escrowed / financed is a CASH fact and cash is a
        //  different chain that this door cannot see.
        payment: null,
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
        resolved_by: c.properties_on_policy > 1
          ? "The allocation schedule, or a broker-stated share for this property."
          : "A stated share for this property.",
        observed_as_of: c.observed_as_of,
      }));

      return res.json({
        property_id: propertyId,
        room: "property_obligations",
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
            //  Unchanged, and correct.
            cash_financing:     { rows: [], establishment: "not_established" },
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

  /*  ── THE INSURANCE WRITE PATH ──────────────────────────────────────
   *  Mounted behind THIS door's authority, injected rather than
   *  re-implemented. The establishment module owns what the routes do;
   *  this file owns who may reach them. Two copies of an authority rule
   *  is a §17 defect even while the copies agree, and it is exactly how
   *  the two would drift the first time either changed.
   */
  router.use(insuranceEstablishment({
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    currentPeriod,
  }));

  return router;
};

module.exports.ROOMS = ROOMS;
module.exports.ESTABLISHMENT_STATES = ESTABLISHMENT_STATES;
