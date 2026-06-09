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
        `select property_id, count(distinct unit_number)::int as n from ingest_candidates
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
        `select c.property_id, p.name, count(distinct c.unit_number)::int as n,
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

  // ════════════════════════════════════════════════════════════════════
  //  CLEANUP — remove TEST/scratch properties that pollute the owner view.
  //  PREVIEW-FIRST and HARD-GUARDED. Two protections, both required:
  //   1. A NEVER-DELETE whitelist of the real property ids (belt).
  //   2. A name-pattern match for known test/scratch prefixes (suspenders).
  //  A property is deletable ONLY if it matches a test pattern AND is not in
  //  the whitelist. `GET` (or no confirm) returns a PREVIEW — what WOULD be
  //  deleted. Deletion happens ONLY on POST with { "confirm": "DELETE" }.
  //  Cascade handles child rows (units/candidates/runs) automatically.
  // ════════════════════════════════════════════════════════════════════
  const NEVER_DELETE = [
    "260b6bac-4738-47c4-b86d-511b726adc48", // 4125 Chestnut
    "9e2bb96e-08e2-41db-81c2-91055ceb50a3", // 4233 Chestnut
    "971c51ab-be96-4e5f-81df-0e59804c879b", // The Felix
  ];
  // Name patterns that mark a row as test/scratch. Anchored to how these were
  // actually named (prefixes + embedded timestamps). Real properties never match.
  const TEST_PATTERNS = [
    "TEST %", "TEST—%", "TEST %", "DIAG %", "SCORER SCRATCH%",
    "OM Test%", "Money Test%", "Movein Test%", "Turn Test%", "Close Test%",
    "%Test 17%",     // unix-ms timestamped test rows
    "%2026-06-0%",   // ISO-timestamped scratch rows
  ];

  async function findDeletable(client) {
    // Match any test pattern, exclude the whitelist by id. Parameterized.
    const r = await client.query(
      `select id, name, address from properties
        where id <> all($1::uuid[])
          and (` + TEST_PATTERNS.map((_, i) => `name ilike $${i + 2}`).join(" or ") + `)
        order by name`,
      [NEVER_DELETE, ...TEST_PATTERNS]
    );
    return r.rows;
  }

  // PREVIEW — safe, read-only. Shows what cleanup WOULD remove.
  router.get("/owner/cleanup-preview", async (_req, res) => {
    try {
      const rows = await findDeletable(pool);
      res.json({
        would_delete_count: rows.length,
        protected_ids: NEVER_DELETE,
        would_delete: rows.map(r => ({ property_id: r.id, name: r.name, address: r.address })),
        note: "Preview only. Nothing deleted. To delete, POST /owner/cleanup with { \"confirm\": \"DELETE\" }.",
      });
    } catch (e) {
      console.error("cleanup-preview error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE — only with explicit confirm. Deletes non-cascading child rows
  // first (assignments, money_events, onboarding chain), then the property
  // (which cascades units/candidates/leases/events). All in ONE transaction.
  router.post("/owner/cleanup", async (req, res) => {
    const client = await pool.connect();
    try {
      const confirm = req.body && req.body.confirm;
      const rows = await findDeletable(client);
      if (confirm !== "DELETE") {
        client.release();
        return res.status(400).json({
          error: "confirmation required",
          would_delete_count: rows.length,
          would_delete: rows.map(r => ({ property_id: r.id, name: r.name })),
          note: "No rows deleted. Re-POST with body { \"confirm\": \"DELETE\" } to proceed.",
        });
      }
      const ids = rows.map(r => r.id);
      if (ids.length === 0) { client.release(); return res.json({ deleted_count: 0, note: "Nothing matched — already clean." }); }

      await client.query("begin");
      // 0. break the circular ref: properties.accountable_assignment_id -> assignments(id).
      //    Null it on the test properties so their assignments can be deleted.
      await client.query(
        "update properties set accountable_assignment_id = null where id = any($1::uuid[])", [ids]);
      // 1. onboarding claim children (reference onboarding_runs, no cascade)
      await client.query(
        `delete from deposit_claims where onboarding_run_id in
           (select id from onboarding_runs where property_id = any($1::uuid[]))`, [ids]);
      await client.query(
        `delete from ledger_claims where onboarding_run_id in
           (select id from onboarding_runs where property_id = any($1::uuid[]))`, [ids]);
      // 2. direct property references that do NOT cascade
      await client.query("delete from onboarding_runs where property_id = any($1::uuid[])", [ids]);
      await client.query("delete from money_events   where property_id = any($1::uuid[])", [ids]);
      await client.query("delete from assignments    where property_id = any($1::uuid[])", [ids]);
      // 3. the property itself — cascades units, candidates, leases, events, etc.
      const del = await client.query(
        "delete from properties where id = any($1::uuid[]) returning id, name", [ids]);
      await client.query("commit");
      client.release();

      res.json({
        deleted_count: del.rows.length,
        deleted: del.rows.map(r => ({ property_id: r.id, name: r.name })),
        protected_ids: NEVER_DELETE,
        note: "Test properties removed (non-cascading children cleared first, rest cascaded). Real properties untouched.",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch {}
      client.release();
      console.error("cleanup error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  ALIAS CLEANUP — clear junk/test unresolved aliases from the queue.
  //  Same preview-first, confirm-required pattern. Only touches UNRESOLVED
  //  aliases (confidence='unresolved', property_id IS NULL) — a resolved alias
  //  links a real property and is never deletable here. Deletes by explicit
  //  alias_id list OR by a test-pattern match, never blindly.
  // ════════════════════════════════════════════════════════════════════
  const JUNK_ALIAS_PATTERNS = [
    "%UNKNOWN%",     // e.g. "380010-UNKNOWN" — placeholder, not a real string
    "%TEST%", "%DIAG%", "%SCRATCH%",
  ];

  async function findJunkAliases(client) {
    const r = await client.query(
      `select id, alias_value, source_system from property_aliases
        where confidence = 'unresolved' and property_id is null
          and (` + JUNK_ALIAS_PATTERNS.map((_, i) => `alias_value ilike $${i + 1}`).join(" or ") + `)
        order by updated_at desc`,
      [...JUNK_ALIAS_PATTERNS]
    );
    return r.rows;
  }

  // PREVIEW — read-only.
  router.get("/owner/alias-cleanup-preview", async (_req, res) => {
    try {
      const rows = await findJunkAliases(pool);
      res.json({
        would_delete_count: rows.length,
        would_delete: rows.map(r => ({ alias_id: r.id, alias_value: r.alias_value, source_system: r.source_system })),
        note: "Preview only. Only UNRESOLVED, unlinked aliases matching junk patterns. To delete, POST /owner/alias-cleanup with { \"confirm\": \"DELETE\" }.",
      });
    } catch (e) {
      console.error("alias-cleanup-preview error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE — confirm required. Optionally pass { alias_ids: [...] } to target
  // specific ones; otherwise deletes all junk-pattern unresolved aliases.
  router.post("/owner/alias-cleanup", async (req, res) => {
    try {
      const { confirm, alias_ids } = req.body || {};
      let rows;
      if (Array.isArray(alias_ids) && alias_ids.length) {
        // explicit list — still guard to unresolved+unlinked only
        rows = (await pool.query(
          `select id, alias_value from property_aliases
            where id = any($1::uuid[]) and confidence = 'unresolved' and property_id is null`,
          [alias_ids]
        )).rows;
      } else {
        rows = await findJunkAliases(pool);
      }
      if (confirm !== "DELETE") {
        return res.status(400).json({ error: "confirmation required",
          would_delete_count: rows.length,
          would_delete: rows.map(r => ({ alias_id: r.id, alias_value: r.alias_value })),
          note: "No aliases deleted. Re-POST with { \"confirm\": \"DELETE\" }." });
      }
      const ids = rows.map(r => r.id);
      if (ids.length === 0) return res.json({ deleted_count: 0, note: "Nothing matched — queue already clean." });
      const del = await pool.query(
        "delete from property_aliases where id = any($1::uuid[]) returning id, alias_value", [ids]
      );
      res.json({ deleted_count: del.rows.length,
        deleted: del.rows.map(r => ({ alias_id: r.id, alias_value: r.alias_value })),
        note: "Junk unresolved aliases removed. Resolved/linked aliases untouched." });
    } catch (e) {
      console.error("alias-cleanup error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //  SET PROPERTY IDENTITY — give a real property its address + canonical key
  //  so it reads "Recognized" instead of "Needs confirmation". Takes the
  //  address as INPUT — never invents one (no support => no write). Use for
  //  The Felix: POST /owner/properties/:id/identity
  //    { "address": "<real street address>", "canonical_key": "FELIX" }
  //  Also registers the address as a resolved alias so future uploads match.
  // ════════════════════════════════════════════════════════════════════
  router.post("/owner/properties/:id/identity", async (req, res) => {
    try {
      const { address, canonical_key } = req.body || {};
      if (!address && !canonical_key) {
        return res.status(400).json({ error: "provide at least one of: address, canonical_key. Nothing is invented." });
      }
      const p = (await pool.query("select id, name from properties where id=$1", [req.params.id])).rows[0];
      if (!p) return res.status(404).json({ error: "property not found" });

      // set address and/or canonical_key (only what was provided)
      const sets = [], vals = []; let n = 1;
      if (address)        { sets.push(`address=$${n++}`); vals.push(String(address).trim()); }
      if (canonical_key)  { sets.push(`canonical_key=$${n++}`); vals.push(String(canonical_key).trim()); }
      vals.push(req.params.id);
      let updated;
      try {
        updated = (await pool.query(
          `update properties set ${sets.join(", ")}, updated_at=now() where id=$${n} returning id, name, address, canonical_key`,
          vals
        )).rows[0];
      } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "that canonical_key is already used by another property" });
        throw e;
      }

      // register the address as a RESOLVED alias so future uploads resolve here
      let alias = null;
      if (address) {
        alias = (await pool.query(
          `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
           values ($1, 'rent_roll', 'address_string', $2, 'resolved', 'set via owner identity fix')
           on conflict (source_system, alias_value) do update
             set property_id=excluded.property_id, confidence='resolved', updated_at=now()
           returning id`, [req.params.id, String(address).trim()]
        )).rows[0];
      }
      res.json({ status: "identity_set", property: updated,
        alias_registered: alias ? alias.id : null,
        note: "Property identity set. It will now read Recognized, and future uploads of this address resolve to it." });
    } catch (e) {
      console.error("set-identity error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
