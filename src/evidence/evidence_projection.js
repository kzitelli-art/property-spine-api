// ════════════════════════════════════════════════════════════════════
//  evidence_projection.js — Slice 9, step 6. The Market & Pricing read.
//
//  ── EACH SECTION FAILS ALONE ─────────────────────────────────────────
//  A failed conversion query must not erase Tour Demand and Lead Demand.
//  Sections are settled independently and a rejection becomes that section's
//  honest error state, never the whole page's. There is no fixture fallback
//  anywhere in this file — a failed read says so.
//
//  ── THE THREE ABSENT DOMAINS STAY ABSENT ─────────────────────────────
//  Rent Survey, Listings and Market Context render 'not_connected'
//  permanently. No empty future tables, no sample competitors, no fake
//  listing statuses. They require separately authorised external
//  integrations (ruling 7), and a placeholder row would be a claim that the
//  integration exists.
//
//  ── READ-ONLY WITH RESPECT TO ECONOMICS ──────────────────────────────
//  Nothing here writes. Evidence may later be cited by a governed pricing
//  decision; this slice creates no path from an observation to a price.
// ════════════════════════════════════════════════════════════════════
"use strict";

const { resolveOperatingWindow, currentMonthWindow } = require("../shared/operating_window");
const { tourDemand } = require("./tour_demand");
const { leadDemand } = require("./lead_demand");
const { conversionFunnels } = require("./conversion");

const NOT_CONNECTED = Object.freeze({
  rent_survey: "Rent survey observations require an external integration that is not authorised or built.",
  listings: "Listing channel state requires an external integration; an attempted publication is not a confirmed live listing.",
  market_context: "Market context (new supply, seasonality, academic and employer calendars) requires external sources.",
});

async function settleSection(name, fn) {
  try { return await fn(); }
  catch (e) {
    return {
      state: "error",
      reason: "section_read_failed",
      detail: e.publicMessage || e.message || "This section could not be read.",
      section: name,
    };
  }
}

async function marketEvidenceProjection(pool, { property_id, start_local = null, end_local = null, as_of = null } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool is required");
  if (!property_id) throw new TypeError("property_id is required");

  const window = (start_local && end_local)
    ? await resolveOperatingWindow(pool, { property_id, start_local, end_local, as_of })
    : await currentMonthWindow(pool, { property_id, as_of });

  // Sections settle independently — one rejection does not take the others.
  const [lead, tour, conv] = await Promise.all([
    settleSection("lead_demand", () => leadDemand(pool, window)),
    settleSection("tour_demand", () => tourDemand(pool, window)),
    settleSection("conversion", () => conversionFunnels(pool, window)),
  ]);

  return {
    contract_version: "market_evidence_v1",
    property_id,
    operating_timezone: window.operating_timezone,
    window: {
      state: window.state,
      reason: window.reason || null,
      start_local: window.window_start_local,
      end_local: window.window_end_local,
      start_utc: window.window_start_utc,
      end_utc: window.window_end_utc,
    },
    as_of_utc: window.as_of_utc,
    sections: {
      lead_demand: lead,
      tour_demand: tour,
      conversion: conv,
      rent_survey: { state: "not_connected", detail: NOT_CONNECTED.rent_survey },
      listings: { state: "not_connected", detail: NOT_CONNECTED.listings },
      market_context: { state: "not_connected", detail: NOT_CONNECTED.market_context },
    },
  };
}

module.exports = { marketEvidenceProjection, NOT_CONNECTED };
