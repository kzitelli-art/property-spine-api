// ════════════════════════════════════════════════════════════════════
//  OWNER  —  the owner-facing aggregate endpoints behind the front door.
//
//  These exist so the front end never has to assemble owner views from raw
//  tables. They roll up what already exists (properties, units, ingest runs,
//  ingest candidates, registry aliases) into the shapes the API contract
//  defines. Owner fields are top-level + plain English; debug lives in _details.
//
//  GET /owner/properties  — the property cards
//  GET /owner/attention   — the needs-attention queue
//
//  Read-only. Mounts with: app.use("/", ownerModule({ pool }));
//  Build to MATCH the contract mocks so the front end's swap is invisible.
// ════════════════════════════════════════════════════════════════════

module.exports = function owner(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("owner module requires a pool");

  // Candidate states that still need the owner (not yet real, not rejected).
  const PENDING_STATES = ["pending", "ready_for_promotion", "approved"];

  // ── GET /owner/properties — the cards ──────────────────────────────
  router.get("/owner/properties", async (_req, res) => {
    try {
      // One round-trip per fact, joined in app code (small N — owner portfolio).
      const props = (await pool.query(
        "select id, name, address, canonical_key from properties order by name nulls last, created_at"
      )).rows;

      // units found (real, promoted) per property
      const unitCounts = (await pool.query(
        "select property_id, count(*)::int as n from units group by property_id"
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      // units pending (candidates not yet promoted/rejected) per property
      const pendCounts = (await pool.query(
        `select property_id, count(*)::int as n from ingest_candidates
          where decision_status = any($1) group by property_id`, [PENDING_STATES]
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      // files uploaded (ingest runs) per property
      const runCounts = (await pool.query(
        "select property_id, count(*)::int as n from ingest_runs group by property_id"
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      // does each property have a resolved alias? (identity = Recognized)
      const resolvedAlias = (await pool.query(
        "select distinct property_id from property_aliases where confidence = 'resolved' and property_id is not null"
      )).rows.reduce((s, r) => (s.add(r.property_id), s), new Set());

      const cards = props.map(p => {
        const units_found = unitCounts[p.id] || 0;
        const units_pending = pendCounts[p.id] || 0;
        const files_uploaded = runCounts[p.id] || 0;
        const recognized = resolvedAlias.has(p.id) || !!p.canonical_key;

        // identity in three words (owner-facing, no backend vocab)
        const identity = recognized ? "Recognized" : (files_uploaded > 0 ? "Needs confirmation" : "New");

        // open questions = pending units that need a confirm. (Queue, #4, adds
        // unresolved-alias items that have no property_id, so those live there.)
        const open_questions = units_pending > 0 ? 1 : 0;

        // next action — the single most useful plain-English step.
        let next_action;
        if (units_pending > 0) next_action = `Confirm ${units_pending} new unit${units_pending === 1 ? "" : "s"} found in an upload.`;
        else if (files_uploaded === 0) next_action = "Upload a rent roll to populate this property.";
        else if (units_found === 0) next_action = "Units were read but none added yet — review the last upload.";
        else next_action = "Up to date.";

        return {
          property_id: p.id,
          name: p.name || "Untitled property",
          address: p.address || null,
          identity,
          files_uploaded,
          units_found,
          units_pending,
          open_questions,
          next_action,
          _details: {
            canonical_key: p.canonical_key || null,
            recognized_by_alias: resolvedAlias.has(p.id),
          },
        };
      });

      res.json({ properties: cards });
    } catch (e) {
      console.error("owner/properties error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /owner/attention — the needs-attention queue ───────────────
  router.get("/owner/attention", async (_req, res) => {
    try {
      const items = [];

      // 1) Unresolved aliases — a file looked like a property we don't know yet.
      const unresolved = (await pool.query(
        `select id, alias_value, source_system from property_aliases
          where confidence = 'unresolved' and property_id is null
          order by updated_at desc limit 50`
      )).rows;
      for (const a of unresolved) {
        items.push({
          id: "att_alias_" + a.id,
          headline: "Confirm a property",
          detail: `A file looks like "${a.alias_value}", but it isn't linked to a property yet.`,
          property_id: null,
          action: { label: "Review", kind: "confirm_identity" },
          _details: { source: "unresolved_alias", alias_id: a.id, source_system: a.source_system, alias_value: a.alias_value },
        });
      }

      // 2) Pending units — read from an upload, waiting to be added.
      const pending = (await pool.query(
        `select c.property_id, p.name, count(*)::int as n,
                max(c.created_at) as last_seen
           from ingest_candidates c
           join properties p on p.id = c.property_id
          where c.decision_status = any($1)
          group by c.property_id, p.name
          order by max(c.created_at) desc limit 50`, [PENDING_STATES]
      )).rows;
      for (const r of pending) {
        items.push({
          id: "att_units_" + r.property_id,
          headline: `${r.n} unit${r.n === 1 ? "" : "s"} waiting to be added`,
          detail: `From a recent upload for ${r.name || "a property"}.`,
          property_id: r.property_id,
          action: { label: "Review units", kind: "promote_units" },
          _details: { source: "pending_candidates", candidate_count: r.n, last_seen: r.last_seen },
        });
      }

      res.json({ items });
    } catch (e) {
      console.error("owner/attention error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
