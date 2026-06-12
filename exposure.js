// ============================================================
// exposure.js — THE SECOND SCOREBOARD (property-level exposure rollup)
//
// Every property carries two headline numbers:
//   NOI      — what the property is producing        (report-read owns this)
//   EXPOSURE — how much of the money story is still UNPROVEN (this module)
//
// One read-only route. No migration. No writes. It aggregates the
// gross-unproven-exposure headline from every proof rung that exists:
//   deposits (009) · ledgers (010) · bank intake (012)
// and is built to absorb future rungs (waterfall, loan) as new sources.
//
// THE BOARD RULE (locked, reused verbatim):
//   headline = GROSS, never net. Offsetting errors must not read clean.
//   known_error_exposure = checked and found wrong  → sum |claimed − confirmed|
//   untied_exposure      = not yet proven           → sum |claimed|
//   deferred             = owner-approved exit      → NOT exposure
//   fully_clean          = true only when every source is READABLE and 0.
//
// FAIL-SOFT, NEVER FAKE-ZERO:
//   Each source is queried independently. If its tables don't exist yet
//   (e.g. 012 SQL not yet run in Neon — Postgres error 42P01), the source
//   reports status:'unavailable' with the reason. An unreadable source is
//   NOT zero — the rollup marks complete:false and fully_clean:false,
//   because "couldn't look" must never be reported as "looked and clean."
//   This is why the module can deploy BEFORE the bank tables exist.
//
// Factory (standing module pattern):
//   const exposureModule = require('./exposure');
//   app.use('/', exposureModule({ pool }));
// ============================================================

const express = require("express");

// Shared single-source exposure computation — exposure route AND desk
// endpoints both call THIS. Two computations of the headline number would
// be the exact divergence the spine exists to prevent.
async function computeExposure(pool, propertyId) {
  async function trySource(name, fn) {
    try {
      const r = await fn();
      return { source: name, status: "ok", ...r };
    } catch (e) {
      const missingTable = e && e.code === "42P01"; // undefined_table
      return {
        source: name,
        status: "unavailable",
        reason: missingTable
          ? "tables not created yet (migration recorded but SQL not applied — run it in Neon)"
          : e.message,
        gross_unproven_exposure: null, // null, NEVER 0 — unreadable is not clean
      };
    }
  }

  const prop = (await pool.query(
    "select id, name, canonical_key from properties where id=$1", [propertyId])).rows[0];
  if (!prop) return null;

      // ── source: DEPOSITS (009) ──────────────────────────────────────
      const deposits = await trySource("deposits", async () => {
        const r = (await pool.query(
          `select
             coalesce(sum(abs(claimed_amount - confirmed_amount))
               filter (where status = 'discrepancy'), 0)::numeric(14,2) as known_error,
             coalesce(sum(abs(claimed_amount))
               filter (where status in ('claimed','reconciling')), 0)::numeric(14,2) as untied,
             count(*) filter (where status = 'discrepancy')::int            as discrepancies,
             count(*) filter (where status in ('claimed','reconciling'))::int as unproven_count,
             count(*) filter (where status = 'deferred')::int               as deferred_count,
             count(*)::int                                                  as total_claims
           from deposit_claims where property_id = $1`, [propertyId])).rows[0];
        const gross = Number(r.known_error) + Number(r.untied);
        return {
          known_error_exposure: Number(r.known_error),
          untied_exposure: Number(r.untied),
          gross_unproven_exposure: Number(gross.toFixed(2)),
          counts: { discrepancies: r.discrepancies, unproven: r.unproven_count,
                    deferred: r.deferred_count, total: r.total_claims },
        };
      });

      // ── source: LEDGERS (010) — signed balances, so abs() is the rule ─
      const ledgers = await trySource("ledgers", async () => {
        const r = (await pool.query(
          `select
             coalesce(sum(abs(claimed_balance - confirmed_balance))
               filter (where status = 'discrepancy'), 0)::numeric(14,2) as known_error,
             coalesce(sum(abs(claimed_balance))
               filter (where status in ('claimed','reconciling')), 0)::numeric(14,2) as untied,
             count(*) filter (where status = 'discrepancy')::int            as discrepancies,
             count(*) filter (where status in ('claimed','reconciling'))::int as unproven_count,
             count(*) filter (where status = 'deferred')::int               as deferred_count,
             count(*)::int                                                  as total_claims
           from ledger_claims where property_id = $1`, [propertyId])).rows[0];
        const gross = Number(r.known_error) + Number(r.untied);
        return {
          known_error_exposure: Number(r.known_error),
          untied_exposure: Number(r.untied),
          gross_unproven_exposure: Number(gross.toFixed(2)),
          counts: { discrepancies: r.discrepancies, unproven: r.unproven_count,
                    deferred: r.deferred_count, total: r.total_claims },
        };
      });

      // ── source: BANK INTAKE (012) — claimed lines, gross |amount| ─────
      // Everything still 'claimed' is unproven money movement. Identified
      // lines with exception flags are visible on the bank board but are
      // NOT exposure (payee proven) — same dollar never counted twice.
      const bank = await trySource("bank", async () => {
        const r = (await pool.query(
          `select
             coalesce(sum(abs(t.amount)) filter (where t.status = 'claimed'), 0)::numeric(14,2) as untied,
             count(*) filter (where t.status = 'claimed')::int    as unproven_count,
             count(*) filter (where t.status = 'identified')::int as identified_count,
             count(*)::int                                        as total_txns,
             count(distinct t.bank_account_id)::int               as accounts
           from bank_transactions t
           join bank_accounts a on a.id = t.bank_account_id
          where a.property_id = $1`, [propertyId])).rows[0];
        return {
          known_error_exposure: 0,                       // amount mismatches stay claimed → already in untied
          untied_exposure: Number(r.untied),
          gross_unproven_exposure: Number(r.untied),
          counts: { unproven: r.unproven_count, identified: r.identified_count,
                    total: r.total_txns, accounts: r.accounts },
        };
      });

      // ── rollup: gross across readable sources; honesty about the rest ─
      const sources = [deposits, ledgers, bank];
      const readable = sources.filter(s => s.status === "ok");
      const unavailable = sources.filter(s => s.status !== "ok");
      const total = readable.reduce((s, x) => s + (x.gross_unproven_exposure || 0), 0);
      const complete = unavailable.length === 0;

  return {
        property: { id: prop.id, name: prop.name, canonical_key: prop.canonical_key },
        gross_unproven_exposure: Number(total.toFixed(2)),
        headline_note: complete
          ? "gross across all proof rungs — never net, never the same dollar twice"
          : "INCOMPLETE — " + unavailable.map(u => u.source).join(", ")
            + " unreadable; the true exposure is AT LEAST this number",
        complete,
        fully_clean: complete && total === 0,
        sources,
        not_yet_covered: ["cash/waterfall (future rung)", "loan reconciliation (future rung)"],
  };
}

module.exports = function exposureModule({ pool }) {
  const router = express.Router();

  router.get("/properties/:id/exposure", async (req, res) => {
    try {
      const out = await computeExposure(pool, req.params.id);
      if (!out) return res.status(404).json({ error: "property not found" });
      return res.json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};
module.exports.computeExposure = computeExposure;
