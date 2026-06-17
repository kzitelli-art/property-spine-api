// ============================================================
// portfolio.js — THE REALITY INVENTORY (Phase 1 of the operating shell)
//
// THE PROBLEM THIS SOLVES: the dashboard blends real data, demo seeds, and
// empty-state fallbacks on every screen, so the operator can't tell what's
// actually in the live database. This endpoint answers that question with
// ZERO demo mask: for each managed property, exactly what live Neon holds.
// Empty reads as empty. Unknown source reads as unknown. Honest by design.
//
// IT IS THE FOUNDATION of the whole operating frame:
//   • the portfolio view (the login landing — pick a property)
//   • the property switcher (each property's live status)
//   • the Live/Demo/Empty source badge (per property, told the truth)
//
// HARD RULES:
//   • READ ONLY. Pure counts. Cannot mutate, cannot break anything.
//   • NO DEMO FALLBACK. If a property has zero work orders, it returns 0,
//     not a seeded number. The truth, even when the truth is "nothing here."
//   • HONEST PROVENANCE. Existing rows whose origin we don't know are
//     labeled 'existing_source_unknown' — we say we don't know rather than
//     pretend the data is clean.
//   • IDENTITY IS THE PROPERTY ROW. We match the managed deal list to real
//     properties by canonical_key first (stable), then by a name/address
//     contains-match, then report 'not_in_db' for any that don't resolve —
//     so a property in the deal list that was never created shows as such,
//     instead of silently vanishing.
//
// THE MANAGED DEAL LIST (the portfolio): the operator's properties, in the
// order they should appear. A property here that has no DB row is reported
// as needs-creation, not hidden.
//
// Factory (standing module pattern, read-only):
//   const portfolioModule = require('./portfolio');
//   app.use('/api', portfolioModule({ pool }));   // → GET /api/portfolio
//   (auth: the global operator-key middleware already covers /api/* — it is
//    NOT in the public-prefix allowlist, so /api/portfolio is protected.)
// ============================================================

// The managed portfolio — the deal list. Each entry is matched to a real
// properties row by canonical_key, then by name/address contains. Order is
// the display order in the portfolio rail.
//   label   — backend/full name (1850 keeps "1850 N 18th (Berks)")
//   display — short UI name shown in the switcher rail
const DEAL_LIST = [
  { key: "4233-CHESTNUT", label: "Solo on Chestnut",      display: "Solo",        match: ["solo", "4233"] },
  { key: "4125-CHESTNUT", label: "UNO on Chestnut",       display: "UNO",         match: ["uno", "4125"] },
  { key: null,            label: "Greenery",              display: "Greenery",    match: ["greenery", "1325"] },
  { key: null,            label: "Temple Nest",           display: "Temple Nest", match: ["temple nest", "temple"] },
  { key: null,            label: "Skyline",               display: "Skyline",     match: ["skyline"] },
  { key: null,            label: "1850 N 18th (Berks)",   display: "1850",        match: ["1850", "berks"] },
];

module.exports = function portfolio(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("portfolio module requires a pool");

  // ── resolve one deal-list entry to a real properties row ──────────────
  //   Returns one of:
  //     { found:true, property, match_basis:'canonical_key', match_token }
  //     { found:true, property, match_basis:'name_address', match_token }
  //     { found:false, reason:'ambiguous_match', candidates, match_token }
  //     { found:false, reason:'not_in_db' }
  //   NEVER silently picks the first fuzzy hit. If a token matches more than
  //   one property, it's ambiguous and we say so with the candidates.
  async function resolveProperty(entry) {
    // 1) by canonical_key when we have one — the stable, unambiguous path
    if (entry.key) {
      const r = await pool.query(
        "select id, name, address, canonical_key from properties where canonical_key = $1", [entry.key]);
      if (r.rows.length) {
        return { found: true, property: r.rows[0], match_basis: "canonical_key", match_token: entry.key };
      }
    }
    // 2) by name/address contains-any of the match tokens. For EACH token,
    //    pull ALL matches (not limit 1). One match → resolved-fuzzy. More
    //    than one → ambiguous, surface candidates, do not guess.
    for (const token of entry.match) {
      const r = await pool.query(
        `select id, name, address, canonical_key from properties
          where lower(name) like '%'||$1||'%' or lower(coalesce(address,'')) like '%'||$1||'%'
          order by created_at`, [token.toLowerCase()]);
      if (r.rows.length === 1) {
        return { found: true, property: r.rows[0], match_basis: "name_address", match_token: token };
      }
      if (r.rows.length > 1) {
        return {
          found: false, reason: "ambiguous_match", match_token: token,
          candidates: r.rows.map(p => ({ id: p.id, name: p.name, address: p.address, canonical_key: p.canonical_key })),
        };
      }
      // zero matches for this token → try the next token
    }
    return { found: false, reason: "not_in_db" };
  }

  // ── count what live Neon actually holds for one property ──────────────
  async function inventoryFor(prop) {
    const id = prop.id;
    const one = async (sql) => Number((await pool.query(sql, [id])).rows[0].n);

    const units = await one("select count(*)::int n from units where property_id = $1");
    const work_orders = await one("select count(*)::int n from work_orders where property_id = $1");
    // OPEN = not in an explicit DONE set. Confirmed done-states from
    // maintenance.js are 'complete' and 'closed'; everything else
    // (open|scheduled|in_progress|escalated|needs_followup|active) is open.
    // coalesce guards any null status so a null never reads as done.
    const open_work_orders = await one(
      "select count(*)::int n from work_orders where property_id = $1 " +
      "and lower(coalesce(status,'open')) not in ('complete','closed')");
    // raw status breakdown — so the count is auditable, never opaque
    const status_rows = (await pool.query(
      "select lower(coalesce(status,'(null)')) as status, count(*)::int n " +
      "from work_orders where property_id = $1 group by 1 order by 2 desc", [id])).rows;
    const work_order_status_breakdown = {};
    for (const r of status_rows) work_order_status_breakdown[r.status] = r.n;

    const money_events = await one("select count(*)::int n from money_events where property_id = $1");
    const leasing_leads = await one("select count(*)::int n from leasing_leads where property_id = $1");
    const scheduled_charges = await one("select count(*)::int n from scheduled_charges where property_id = $1");

    // bank transactions are joined through bank_accounts
    const bank_txns = Number((await pool.query(
      `select count(*)::int n from bank_transactions
        where bank_account_id in (select id from bank_accounts where property_id = $1)`, [id])).rows[0].n);

    // tenants = persons linked to this property via leases/units is complex;
    // we report the simpler, honest proxy: persons referenced by this
    // property's work orders + leases. To stay strictly truthful and cheap,
    // count distinct persons on this property's units' leases.
    const tenants = Number((await pool.query(
      `select count(distinct p.id)::int n
         from persons p
         join leases l on p.id = any(l.tenant_ids)
         join spaces s on l.space_id = s.id
         join units u on s.unit_id = u.id
        where u.property_id = $1`, [id])).rows[0].n).valueOf();

    // data_status — the honest one-word verdict
    const hasAny = units + work_orders + money_events + leasing_leads + bank_txns + scheduled_charges > 0;
    const data_status = hasAny ? "existing_source_unknown" : "empty";

    return {
      unit_count: units,
      work_order_count: work_orders,
      open_work_order_count: open_work_orders,
      work_order_status_breakdown,   // raw status counts — the open count is auditable
      money_event_count: money_events,
      leasing_lead_count: leasing_leads,
      scheduled_charge_count: scheduled_charges,
      bank_transaction_count: bank_txns,
      tenant_count: tenants,
      has_live_data: hasAny,
      data_status,         // 'empty' | 'existing_source_unknown'
      last_upload_at: null, // no upload-batch table yet (Phase 5); honest null
    };
  }

  // ── THE INVENTORY — GET /api/portfolio ────────────────────────────────
  //   The login landing + switcher source. One call, the whole truth.
  router.get("/portfolio", async (req, res) => {
    try {
      const properties = [];
      for (const entry of DEAL_LIST) {
        const r = await resolveProperty(entry);

        if (!r.found && r.reason === "ambiguous_match") {
          properties.push({
            deal_label: entry.label,
            display_label: entry.display,
            canonical_key: entry.key,
            in_db: false,
            data_status: "ambiguous_match",
            match_token: r.match_token,
            candidates: r.candidates,
            note: "more than one property matched this name/address token — refusing to guess. Resolve by setting a canonical_key.",
          });
          continue;
        }
        if (!r.found) {
          properties.push({
            deal_label: entry.label,
            display_label: entry.display,
            canonical_key: entry.key,
            in_db: false,
            data_status: "not_in_db",
            note: "in the managed list but no property record exists yet — needs creation/intake",
          });
          continue;
        }

        const prop = r.property;
        const inv = await inventoryFor(prop);
        properties.push({
          deal_label: entry.label,
          display_label: entry.display,
          id: prop.id,
          db_name: prop.name,
          address: prop.address,
          canonical_key: prop.canonical_key,
          in_db: true,
          match_basis: r.match_basis,     // 'canonical_key' | 'name_address'
          match_token: r.match_token,     // what it matched on (audit trail)
          ...inv,
        });
      }

      // portfolio-level rollup — the honest top line
      const live = properties.filter(p => p.in_db && p.has_live_data).length;
      const empty = properties.filter(p => p.in_db && !p.has_live_data).length;
      const ambiguous = properties.filter(p => p.data_status === "ambiguous_match").length;
      const missing = properties.filter(p => p.data_status === "not_in_db").length;

      res.json({
        portfolio: "OneFive",
        property_count: properties.length,
        summary: {
          with_live_data: live,
          in_db_but_empty: empty,
          ambiguous_match: ambiguous,
          not_in_db: missing,
        },
        note: "Reality inventory — counts straight from live Neon, no demo data. This endpoint never guesses: a fuzzy match is labeled fuzzy (match_basis='name_address'), an ambiguous match returns candidates instead of picking one, and a missing property says 'not_in_db'. 'empty' means genuinely no records.",
        properties,
      });
    } catch (e) {
      console.error("portfolio inventory error:", e);
      res.status(500).json({ error: "portfolio inventory failed", detail: e.message });
    }
  });

  return router;
};
