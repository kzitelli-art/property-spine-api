// ============================================================
// autoconfirm.js — EARNED AUTONOMY for vendor categorization (migration 044)
//
// THE ONE IDEA: the money layer already PROPOSES a category for a known
// vendor and PARKS the line for a human confirm. Every confirm records
// proposed_category + confirmed_category on money_events — a track record
// of "proposed X, human agreed X" that already accumulates. This module
// turns that record into a controllable autonomy:
//
//   1. READ (instrument)  — per (vendor, property), how strong is the
//      track record? consecutive agreements, override count, amount band.
//      Writes nothing. Surfaces who has EARNED the right to be asked.
//   2. SWITCH (grant)     — a human flips auto_confirm on a (vendor,
//      property) rule, knowingly, after the read justifies it. Fully
//      audited: who, when, why. Reversible.
//   3. DECIDE (enforce)   — when a bank row lands, the bridge asks this
//      module: may this line auto-confirm? Yes ONLY if the switch is on
//      AND the amount is inside the learned band (tripwire #1). Otherwise
//      it falls back to the normal human queue — exactly today's behavior.
//
// THE BOUNDARY (important): this module NEVER creates a money_event. The
// bridge (bankbridge.js) remains the ONLY birth path for money. This
// module only (a) reads history, (b) stores the switch + its audit, and
// (c) answers a yes/no decision the bridge consults. The DB never
// auto-confirms; app code does, and it does so through the same audited
// bridge lifecycle every human confirm uses.
//
// THE TWO TRIPWIRES (what makes turning it on safe):
//   • OUT-OF-BAND: a charge outside the learned amount band does NOT
//     auto-confirm even for a trusted vendor — it drops to the human
//     queue. This is Key 2's variance case: the one human review you want.
//     Enforced HERE, in decideAutoConfirm().
//   • OVERRIDE → REVOKE: one human override of an auto-confirmed line
//     snaps that vendor's switch back to off until it re-earns trust.
//     Exposed HERE as revokeOnOverride(); bankbridge calls it when a human
//     re-categorizes a line that was auto-confirmed.
//
// EARNED, NOT GRANTED DAY ONE. The read gates (shows eligibility); the
// human grants (flips the switch); this module stores + enforces. Three
// separate steps on purpose. Nobody makes a day-one trust decision.
//
// Factory (standing module pattern):
//   const autoConfirmModule = require('./autoconfirm');
//   app.use('/', autoConfirmModule({ pool }));
//   // and the bridge consults the decision/revoke helpers it exports:
//   const { decideAutoConfirm, revokeOnOverride } = autoConfirmModule.helpers({ pool });
// ============================================================

// ── THE THRESHOLD (data, not vibe). Tunable in one place. The read uses
//    these to decide who is "eligible to be asked"; they are the honest
//    definition of "learned enough."
const THRESHOLD = {
  MIN_CONFIRMS: 5,        // ≥ this many human confirms of this vendor/property
  MAX_OVERRIDES: 0,       // and this many corrections (proposed ≠ confirmed)
  BAND_TOLERANCE: 0.25,   // learned amount band = min..max of confirmed history,
                          // widened by ±25% — a charge outside this is variance
};

module.exports = function autoconfirm(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("autoconfirm module requires a pool");

  // ──────────────────────────────────────────────────────────────────
  //  THE TRACK-RECORD QUERY — the heart of the read.
  //  Per (vendor, property), over bank-bridged money_events that carried
  //  a proposal: count agreements (proposed = confirmed), corrections
  //  (proposed ≠ confirmed), and the confirmed-amount band. "Consecutive
  //  agreements" = agreements since the most recent correction (a
  //  correction resets the streak — trust is current, not lifetime).
  //
  //  Only rows with a non-null proposed_category count: the Amazon-class
  //  human-queue lines (no proposal) can never build auto-confirm trust,
  //  which is correct — there is no rule to flip for them.
  //  vendor match is by money_events.vendor = vendors.canonical_name (the
  //  bridge writes the canonical vendor name onto the money_event).
  // ──────────────────────────────────────────────────────────────────
  async function trackRecord(client, { property_id, vendor_id }) {
    const db = client || pool;
    // Pull this vendor's bridged history at this property, newest first,
    // so we can compute the CURRENT streak (agreements since last override).
    const r = await db.query(
      `select me.id,
              me.amount,
              me.proposed_category,
              me.confirmed_category,
              me.verified_at,
              (me.proposed_category is not distinct from me.confirmed_category) as agreed
         from money_events me
         join vendors v on v.canonical_name = me.vendor
        where me.property_id = $1
          and v.id = $2
          and me.proposed_category is not null
          and me.confirmed_category is not null
          and me.status = 'report_ready'
        order by me.verified_at desc nulls last, me.created_at desc`,
      [property_id, vendor_id]);

    const rows = r.rows;
    const total = rows.length;
    const overrides = rows.filter(x => !x.agreed).length;

    // current streak: agreements from the top until the first correction
    let streak = 0;
    for (const x of rows) { if (x.agreed) streak++; else break; }

    // the agreed category (must be unanimous among agreements to be a rule)
    const agreedCats = [...new Set(rows.filter(x => x.agreed).map(x => x.confirmed_category))];
    const agreedCategory = agreedCats.length === 1 ? agreedCats[0] : null;

    // learned amount band from AGREED rows only, widened by tolerance
    const agreedAmts = rows.filter(x => x.agreed).map(x => Math.abs(Number(x.amount)));
    let band = null;
    if (agreedAmts.length) {
      const lo = Math.min(...agreedAmts);
      const hi = Math.max(...agreedAmts);
      band = {
        low:  Number((lo * (1 - THRESHOLD.BAND_TOLERANCE)).toFixed(2)),
        high: Number((hi * (1 + THRESHOLD.BAND_TOLERANCE)).toFixed(2)),
        observed_low: Number(lo.toFixed(2)),
        observed_high: Number(hi.toFixed(2)),
      };
    }

    const eligible =
      streak >= THRESHOLD.MIN_CONFIRMS &&
      overrides <= THRESHOLD.MAX_OVERRIDES &&
      agreedCategory !== null;

    return {
      total_confirms: total,
      agreements: total - overrides,
      overrides,
      current_streak: streak,
      agreed_category: agreedCategory,
      amount_band: band,
      eligible,
      threshold: THRESHOLD,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  DECISION HELPER (consulted by the bridge on every landing row).
  //  Returns { auto: bool, reason, rule_id?, confirmed_category? }.
  //  auto:true ONLY when the switch is on for this (vendor,property) AND
  //  the incoming amount is inside the learned band. Everything else
  //  returns auto:false with a reason → the bridge runs its normal
  //  human-queue path (today's behavior). This NEVER writes.
  // ──────────────────────────────────────────────────────────────────
  async function decideAutoConfirm(client, { property_id, vendor_id, amount }) {
    const db = client || pool;
    const rule = await db.query(
      `select id, default_category, auto_confirm
         from vendor_property_categories
        where property_id = $1 and vendor_id = $2`,
      [property_id, vendor_id]);

    if (!rule.rows.length || !rule.rows[0].auto_confirm) {
      return { auto: false, reason: "no_auto_confirm_rule" };
    }
    const ruleRow = rule.rows[0];

    // tripwire #1 — out-of-band amount falls back to the human queue.
    const rec = await trackRecord(db, { property_id, vendor_id });
    const amt = Math.abs(Number(amount));
    if (rec.amount_band && (amt < rec.amount_band.low || amt > rec.amount_band.high)) {
      return {
        auto: false,
        reason: "amount_out_of_band",
        band: rec.amount_band,
        amount: amt,
        rule_id: ruleRow.id,
      };
    }

    return {
      auto: true,
      reason: "auto_confirm",
      rule_id: ruleRow.id,
      confirmed_category: ruleRow.default_category,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  TRIPWIRE #2 — revoke on override. The bridge calls this when a human
  //  re-categorizes a line that was auto-confirmed (proposed ≠ what the
  //  human now chose). Snaps the switch off and records why. Reversible:
  //  the switch can be re-earned and re-granted later. Off is an update,
  //  never a delete — the grant/revoke trail persists.
  // ──────────────────────────────────────────────────────────────────
  async function revokeOnOverride(client, { property_id, vendor_id, reason }) {
    const db = client || pool;
    const upd = await db.query(
      `update vendor_property_categories
          set auto_confirm = false,
              revoked_at = now(),
              revoked_reason = $3,
              updated_at = now()
        where property_id = $1 and vendor_id = $2 and auto_confirm = true
        returning id`,
      [property_id, vendor_id, reason || "human override of an auto-confirmed line"]);
    return { revoked: upd.rowCount > 0, rule_id: upd.rows[0]?.id || null };
  }

  // ════════════════════════════════════════════════════════════════
  //  ENDPOINTS
  // ════════════════════════════════════════════════════════════════

  // ── READ: who has EARNED the right to be asked, for a property ──────
  //   GET /properties/:id/auto-confirm/eligible
  //   For every vendor that has a category rule at this property, compute
  //   the track record and report eligibility. The "want to pre-authorize?"
  //   surface. Writes nothing.
  router.get("/properties/:id/auto-confirm/eligible", async (req, res) => {
    const property_id = req.params.id;
    try {
      // every vendor with a rule (property override OR global default) that
      // has shown up on this property's bridged money_events
      const vendors = await pool.query(
        `select distinct v.id, v.canonical_name,
                coalesce(vpc.default_category, v.default_category) as effective_category,
                vpc.id as rule_id,
                vpc.auto_confirm,
                vpc.revoked_at
           from vendors v
           join money_events me on me.vendor = v.canonical_name and me.property_id = $1
           left join vendor_property_categories vpc
                  on vpc.vendor_id = v.id and vpc.property_id = $1
          where coalesce(vpc.default_category, v.default_category) is not null`,
        [property_id]);

      const out = [];
      for (const v of vendors.rows) {
        const rec = await trackRecord(pool, { property_id, vendor_id: v.id });
        out.push({
          vendor_id: v.id,
          vendor: v.canonical_name,
          proposed_category: v.effective_category,
          rule_id: v.rule_id,
          auto_confirm_on: v.auto_confirm === true,
          previously_revoked: v.revoked_at != null,
          record: rec,
          // the surface's call to action — only when earned and not already on
          can_pre_authorize: rec.eligible && v.auto_confirm !== true,
          pre_authorize_via: rec.eligible && v.auto_confirm !== true
            ? `POST /properties/${property_id}/auto-confirm/grant { vendor_id, granted_by_person_id, note? }`
            : null,
        });
      }
      // eligible first, then by streak — the "ask me" list rises to the top
      out.sort((a, b) =>
        (b.can_pre_authorize - a.can_pre_authorize) ||
        (b.record.current_streak - a.record.current_streak));

      res.json({
        property_id,
        threshold: THRESHOLD,
        note: "Eligibility is EARNED, not granted. can_pre_authorize=true means the record justifies asking — a human still flips the switch.",
        vendors: out,
      });
    } catch (e) {
      console.error("auto-confirm eligible error:", e);
      res.status(500).json({ error: "eligibility read failed", detail: e.message });
    }
  });

  // ── READ ONE: the full track record for a single (vendor, property) ──
  //   GET /properties/:id/auto-confirm/record/:vendorId
  router.get("/properties/:id/auto-confirm/record/:vendorId", async (req, res) => {
    try {
      const rec = await trackRecord(pool, {
        property_id: req.params.id, vendor_id: req.params.vendorId });
      res.json({ property_id: req.params.id, vendor_id: req.params.vendorId, record: rec });
    } catch (e) {
      console.error("auto-confirm record error:", e);
      res.status(500).json({ error: "record read failed", detail: e.message });
    }
  });

  // ── GRANT: a human flips the switch ON for a (vendor, property) ──────
  //   POST /properties/:id/auto-confirm/grant
  //   Body: { vendor_id, granted_by_person_id, note? }
  //   Re-checks eligibility server-side (never trust the client that the
  //   record justifies it), then turns auto_confirm on WITH the audit
  //   trail. Idempotent-ish: re-granting refreshes the audit stamp.
  router.post("/properties/:id/auto-confirm/grant", async (req, res) => {
    const property_id = req.params.id;
    const { vendor_id, granted_by_person_id, note = null } = req.body || {};
    if (!vendor_id || !granted_by_person_id) {
      return res.status(400).json({ error: "vendor_id and granted_by_person_id are required" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");

      // the rule must already exist (a category proposal to graduate).
      const rule = await client.query(
        `select id, default_category from vendor_property_categories
          where property_id = $1 and vendor_id = $2 for update`,
        [property_id, vendor_id]);
      if (!rule.rows.length) {
        await client.query("rollback");
        return res.status(409).json({
          error: "no category rule for this vendor at this property — nothing to graduate",
          hint: "set a per-property rule first (bankbridge: set-property-vendor-category), or rely on the global default by creating the property rule",
        });
      }

      // SERVER-SIDE eligibility gate — the record must justify it NOW.
      const rec = await trackRecord(client, { property_id, vendor_id });
      if (!rec.eligible) {
        await client.query("rollback");
        return res.status(412).json({
          error: "not yet earned — the track record does not meet the threshold",
          record: rec,
          threshold: THRESHOLD,
        });
      }

      const upd = await client.query(
        `update vendor_property_categories
            set auto_confirm = true,
                auto_confirm_by = $3,
                auto_confirm_at = now(),
                auto_confirm_note = $4,
                revoked_at = null,
                revoked_reason = null,
                updated_at = now()
          where property_id = $1 and vendor_id = $2
          returning id, default_category, auto_confirm, auto_confirm_at`,
        [property_id, vendor_id, granted_by_person_id,
         note || `granted on track record: streak ${rec.current_streak}, ${rec.overrides} overrides`]);

      await client.query("commit");
      res.json({
        granted: true,
        rule: upd.rows[0],
        record_at_grant: rec,
        note: "Auto-confirm is ON for this vendor at this property. It will revoke automatically on any human override, or manually via /revoke.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("auto-confirm grant error:", e);
      res.status(500).json({ error: "grant failed", detail: e.message });
    } finally {
      client.release();
    }
  });

  // ── REVOKE: a human turns the switch OFF (manual off-switch) ─────────
  //   POST /properties/:id/auto-confirm/revoke
  //   Body: { vendor_id, reason? }
  //   The manual companion to the automatic override tripwire.
  router.post("/properties/:id/auto-confirm/revoke", async (req, res) => {
    const property_id = req.params.id;
    const { vendor_id, reason = "manually revoked" } = req.body || {};
    if (!vendor_id) return res.status(400).json({ error: "vendor_id is required" });
    try {
      const out = await revokeOnOverride(pool, { property_id, vendor_id, reason });
      if (!out.revoked) {
        return res.status(404).json({ error: "no active auto-confirm rule to revoke for this vendor/property" });
      }
      res.json({ revoked: true, rule_id: out.rule_id, reason });
    } catch (e) {
      console.error("auto-confirm revoke error:", e);
      res.status(500).json({ error: "revoke failed", detail: e.message });
    }
  });

  // expose the router AND the helpers the bridge consults
  router.helpers = { trackRecord, decideAutoConfirm, revokeOnOverride, THRESHOLD };
  return router;
};

// Also expose helpers without mounting (for bankbridge to import the
// decision/revoke functions against the same pool).
module.exports.helpers = function (deps) {
  const r = module.exports(deps);
  return r.helpers;
};
