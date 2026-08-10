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
  const staffSessions = require("../identity/staff_session_service.js");     // Build 1A-1: a key is not an actor
  const propertyCreation = require("../identity/property_creation_service.js"); // Build 1A-1: THE property write
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
    // Demo Building. NOT a real operating property, but it holds the ONLY
    // irreplaceable record in the system (Marlow's 2026-07-05 tour,
    // 31ca5801-…) plus the whole demo corpus: 344 leases, 431 comm_events,
    // 15 tours, and the open tour_availability the boardroom run needs.
    // Until now it was spared only because its NAME does not match
    // TEST_PATTERNS — a naming coincidence, not a guard. A rename, or a new
    // pattern that happens to match, would cascade all of it away.
    "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe", // Property Spine Demo Building
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
      await client.query("delete from onboarding_runs   where property_id = any($1::uuid[])", [ids]);
      await client.query("delete from money_events      where property_id = any($1::uuid[])", [ids]);
      await client.query("delete from assignments       where property_id = any($1::uuid[])", [ids]);
      // property_aliases FK has no cascade (property_aliases_property_id_fkey) — a
      // property created via create-from-upload owns a resolved alias, so this must
      // be cleared before the property delete or it errors. (Found by the test run.)
      await client.query("delete from property_aliases  where property_id = any($1::uuid[])", [ids]);
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

      // register the address as a RESOLVED alias so future uploads resolve here.
      // SAFETY FLAG (#6): this upsert BLINDLY reassigns the alias to this property
      // (do update set property_id = excluded.property_id). That's fine for an
      // INTERNAL repair endpoint. If this ever becomes FRONT-END accessible, it
      // needs the same alias-hijack guard create-from-upload has — refuse to steal
      // a string already resolved to a DIFFERENT property; return a conflict instead.
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

  // ════════════════════════════════════════════════════════════════════
  //  OWNER DASHBOARD  —  GET /owner/dashboard
  //
  //  The asset-truth board. NOT a glossy summary — it tells the truth about
  //  what the system can and cannot prove. The rule:
  //    KNOWN            → show the number
  //    UNKNOWN          → render null (front end shows "—")
  //    IMPORTANT UNKNOWN→ emit an OWNER OBLIGATION (what must happen to earn it)
  //
  //  This composes the SAME source facts /owner/properties and /owner/attention
  //  already read — it does not invent a second source of truth. It answers the
  //  owner's four questions: am I okay? what changed? where am I exposed? what
  //  decision do you need from me?
  //
  //  HONEST MODE (today's live schema):
  //   - occupancy: promoted units carry NO status column yet → not provable.
  //     Candidates carry status but a candidate is unconfirmed → not "occupancy."
  //     So occupancy is null + an obligation wherever it matters. (When promoted
  //     units gain a status column — see SCHEMA-GAP follow-up — wire it here.)
  //   - NOI: the money/report layer is not live → null + obligation.
  //   - value: needs confirmed NOI + cap rate → null + obligation.
  //  No fake numbers. A "—" the system can defend beats a number it can't.
  // ════════════════════════════════════════════════════════════════════
  router.get("/owner/dashboard", async (_req, res) => {
    try {
      // ---- source facts (same reads the cards/queue use) ----
      const props = (await pool.query(
        "select id, name, address, canonical_key from properties order by name nulls last, created_at"
      )).rows;

      const unitCounts = (await pool.query(
        "select property_id, count(*)::int as n from units group by property_id"
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      const pendCounts = (await pool.query(
        `select property_id, count(distinct unit_number)::int as n from ingest_candidates
          where decision_status = any($1) group by property_id`, [PENDING_STATES]
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      const runCounts = (await pool.query(
        "select property_id, count(*)::int as n from ingest_runs group by property_id"
      )).rows.reduce((m, r) => (m[r.property_id] = r.n, m), {});

      const resolvedAlias = (await pool.query(
        "select distinct property_id from property_aliases where confidence = 'resolved' and property_id is not null"
      )).rows.reduce((s, r) => (s.add(r.property_id), s), new Set());

      const unresolved = (await pool.query(
        `select id, alias_value from property_aliases
          where confidence = 'unresolved' and property_id is null
          order by updated_at desc limit 50`
      )).rows;

      // ---- per-asset truth: actionable obligations vs proof-missing facts ----
      // Two DIFFERENT things, never conflated:
      //   NEEDS YOU      = a real decision the owner can make RIGHT NOW (a flow
      //                    exists: confirm identity, confirm units). Goes in the queue.
      //   PROOF MISSING  = the system can't prove a metric yet and there is NO
      //                    owner action to fix it (no money layer, no cap-rate flow,
      //                    no promoted status). Stated as consequence, NEVER a task.
      const assets = [];
      const attention = [];      // NEEDS YOU — real owner decisions only
      const proof_missing = [];  // PROOF MISSING — honest unavailability, no button

      let provableUnits = 0;
      let anyOccupancyProvable = false;

      for (const p of props) {
        const units_found = unitCounts[p.id] || 0;
        const units_pending = pendCounts[p.id] || 0;
        const files_uploaded = runCounts[p.id] || 0;
        const recognized = resolvedAlias.has(p.id) || !!p.canonical_key;

        // ── OCCUPANCY (honest) ──
        // Provable only from a confirmed status on promoted units — which doesn't
        // exist yet. Pending units ARE an owner decision (confirm them) → that's
        // the actionable path; the occupancy number itself stays proof-missing.
        let occupancy = null;
        // (FUTURE: when units.occupancy_status exists, compute here + set
        //  anyOccupancyProvable = true; provableUnits += ...)

        // ── ACTIONABLE owner obligations (a real flow exists NOW) ──
        const obligations = [];

        // identity — actionable (confirm-link / create-from-upload exist)
        if (!recognized && files_uploaded > 0) {
          obligations.push({
            kind: "confirm_identity",
            issue: "Confirm which property this is.",
            why: `${p.name || "This property"} isn't recognized yet, so nothing about it can be trusted.`,
            owner: "Owner",
          });
        }
        // pending units — actionable (promote/confirm flow exists)
        if (units_pending > 0) {
          obligations.push({
            kind: "confirm_units",
            issue: `Confirm ${units_pending} unit${units_pending === 1 ? "" : "s"} before occupancy is trusted.`,
            why: `${p.name || "This property"}'s occupancy can't be trusted until these are confirmed.`,
            owner: "Owner",
          });
        }
        // nothing on file — actionable (upload flow exists)
        if (files_uploaded === 0) {
          obligations.push({
            kind: "upload_rent_roll",
            issue: "Add a rent roll to get started.",
            why: `${p.name || "This property"} has no data yet.`,
            owner: "Owner",
          });
        }

        // ── PROOF-MISSING facts (no owner action exists — do NOT make a task) ──
        const missing = [];
        // occupancy unavailable (units not promoted with status). Only worth saying
        // when there's no louder pending-units obligation already covering it.
        if (!anyOccupancyProvable && units_pending === 0 && files_uploaded > 0) {
          missing.push({ metric: "occupancy", note: "Occupancy cannot be shown yet — unit status isn't confirmed." });
        }
        // NOI — money layer not connected. Always missing today.
        missing.push({ metric: "noi", note: "NOI cannot be shown yet — no operating statement connected." });
        // value — depends on NOI + a cap-rate assumption flow that doesn't exist.
        missing.push({ metric: "value", note: "Value cannot be calculated yet — needs NOI and a cap-rate assumption." });

        const noi = null;
        const value = null;

        // the asset's surface issue = its top ACTIONABLE obligation. If none, say
        // "No owner action" — NOT "nothing needs you" (proof gaps may still exist,
        // shown in proof_missing; we don't claim completeness). Unrecognized with
        // no decision yet stays "—".
        const top = obligations[0] || null;
        const noActionIssue = recognized ? "No owner action." : "—";

        assets.push({
          property_id: p.id,
          name: p.name || "Untitled property",
          address: p.address || null,
          occupancy, noi, value,                 // null → UI renders —
          issue: top ? top.issue : noActionIssue,
          action: top
            ? { label: ownerActionLabel(top.kind), kind: top.kind }
            : { label: "Open", kind: "open_property" },
          _details: {
            canonical_key: p.canonical_key || null,
            recognized, units_found, units_pending, files_uploaded,
            obligations,        // actionable only
            proof_missing: missing,
          },
        });

        // queue gets ONLY the asset's top real decision
        if (top) {
          attention.push({
            id: "att_asset_" + p.id,
            property_id: p.id,
            property_name: p.name || "Untitled property",
            headline: ownerHeadline(top.kind),
            detail: top.why,
            priority: top.kind === "confirm_identity" ? "high" : "normal",
            action: { label: ownerActionLabel(top.kind), kind: top.kind },
            _details: { source: "asset_obligation", obligation: top },
          });
        }

        // proof-missing rolls up per asset (consequence, not task)
        for (const mfact of missing) {
          proof_missing.push({
            property_id: p.id,
            property_name: p.name || "Untitled property",
            metric: mfact.metric,
            note: mfact.note,
          });
        }
      }

      // unresolved-alias items (a file that looks like a property we don't know).
      // These are owner identity decisions — same as /owner/attention #1.
      for (const a of unresolved) {
        attention.push({
          id: "att_alias_" + a.id,
          property_id: null,
          property_name: null,
          headline: "Confirm a property",
          detail: `A file looks like "${a.alias_value}", but it isn't linked to a property yet.`,
          priority: "high",
          action: { label: "Confirm", kind: "confirm_identity" },
          _details: { source: "unresolved_alias", alias_id: a.id, alias_value: a.alias_value },
        });
      }

      // v1: high priority first, then the rest, stable within group.
      // FUTURE (#4 ranking): current_truth / queue order should rank by BUSINESS
      //   CONSEQUENCE (identity unconfirmed > roll unconfirmed > major proof gap >
      //   approval due), not array order. This sort is the v1 stand-in.
      // FUTURE (#5 dedupe): an unresolved alias and an unrecognized property can be
      //   the SAME real decision ("confirm this property"). v1 may show both; the
      //   owner experience wants ONE identity decision per property. Dedupe by
      //   business consequence, not one item per alias row. Acceptable for v1.
      attention.sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1));

      // ---- PORTFOLIO METRICS (honest) ----
      // Null until the proof layer earns it. The note says WHY — truth, not apology.
      const needs_you = attention.length;
      const metrics = {
        occupancy: {
          value: anyOccupancyProvable ? `${Math.round(provableUnits)}%` : null,
          note: anyOccupancyProvable ? "From confirmed units" : "Not shown yet — unit status isn't confirmed",
        },
        noi: { value: null, note: "Not shown yet — no operating statement connected" },
        value: { value: null, note: "Not shown yet — needs NOI and a cap-rate assumption" },
        needs_you: { value: needs_you, note: "Real owner decisions" },
      };

      // ---- CURRENT TRUTH (one sentence) ----
      const current_truth = needs_you > 0
        ? {
            headline: `Needs ${needs_you} decision${needs_you === 1 ? "" : "s"}`,
            detail: attention[0] ? attention[0].detail : "",
            primary_action: {
              label: "Resolve first issue",
              kind: "review_attention",
              target_id: attention[0] ? attention[0].id : null,
            },
          }
        : {
            headline: "Nothing needs you right now",
            detail: "No open owner decisions across the portfolio.",
            primary_action: null,
          };

      // Section order: Current truth → Metrics → Assets → Needs You → Proof Missing.
      res.json({ current_truth, metrics, assets, attention, proof_missing });
    } catch (e) {
      console.error("owner/dashboard error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // owner-facing labels (no backend vocab leaks)
  function ownerActionLabel(kind) {
    return {
      confirm_identity: "Confirm",
      confirm_units: "Confirm units",
      upload_rent_roll: "Upload",
      open_property: "Open",
    }[kind] || "Review";
  }
  function ownerHeadline(kind) {
    return {
      confirm_identity: "Confirm property match",
      confirm_units: "Confirm units",
      upload_rent_roll: "Add a rent roll",
    }[kind] || "Review";
  }


  //
  //  The "New property" path of the add-asset flow, in ONE call. The owner
  //  uploaded a file, identify returned new_property, the owner said "yes,
  //  create it." This does — atomically — what /properties + /identity +
  //  confirm-link did separately, so the new property is recognized on its
  //  NEXT upload instead of fragmenting into a second unknown.
  //
  //  Body: { name, address?, found_as?, resolve_value?, canonical_key?, source? }
  //    - name        required (the only hard requirement, matches POST /properties)
  //    - resolve_value || found_as  → the RESOLVED alias the matcher keys on.
  //      Registered so the next upload of this string resolves here. (Decision:
  //      resolve_value first — it's the exact string identify resolved on; found_as
  //      is the owner-facing label and can differ on labeled rolls.)
  //    - canonical_key  explicit wins; else DERIVED from address when confident
  //      (address-anchored, e.g. "4233 Chestnut Street" -> "4233-CHESTNUT"). Never
  //      invented from a name — a bad key pollutes the uniqueness anchor permanently.
  //
  //  One transaction. 23505 on canonical_key -> 409 ("may already exist") so the
  //  front end can offer the owner the link-existing path instead.
  // ════════════════════════════════════════════════════════════════════

  //  Build 1A-1: deriveCanonicalKey lived here, and was the ONLY door
  //  that derived a key from an address. It moved verbatim into
  //  src/identity/property_creation_service.js so every door gets it —
  //  and so the alias normalization beside it stops being a second copy
  //  of the registry's norm(). One implementation, one behaviour.

  //  Build 1A-1: the write is the canonical service's. This route keeps
  //  its owner-facing CARD shape (the front end drops the result straight
  //  into the grid) and its alias provenance ('rent_roll' by default),
  //  and hands over authority, identity derivation, the alias-hijack
  //  refusal and the immutable creation record.
  //
  //  ── WHY THIS ROUTE NOW NEEDS A SESSION ──────────────────────────
  //  It sat behind the shared OPERATOR_KEY alone. See the note on
  //  /bank/onboard-property and docs/BUILD_0_ONBOARDING_AUTHORITY_AUDIT.md
  //  §2C. Nothing in the deployed app calls it, so no live surface loses
  //  a capability. Its alias-hijack refusal — the best identity behaviour
  //  of the four doors — moved into the service unchanged and now protects
  //  every door, not just this one.
  router.post("/owner/properties/create-from-upload", async (req, res) => {
    const { name, address, found_as, resolve_value, canonical_key, source, organization_id } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    // the string the registry matcher will key on next time — resolve_value first.
    const aliasValue = (resolve_value && String(resolve_value).trim())
      || (found_as && String(found_as).trim())
      || null;

    try {
      const session = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
      if (!session) {
        return res.status(401).json({
          error: "A staff session is required to create a property.",
          reason: "no_authenticated_actor",
          receipt: "Send x-staff-session. The operator key authenticates the caller, not the human — " +
                   "and creating a property records who did it.",
        });
      }

      const out = await propertyCreation.createProperty(pool, {
        actor: { user_id: session.id },
        organization_id: organization_id || null,
        name, address, canonical_key,
        aliases: aliasValue ? [aliasValue] : [],
        alias_source_system: source || "rent_roll",
        source: "owner_upload",
      });

      const prop = out.property;
      const alias = out.aliases && out.aliases[0] ? out.aliases[0] : null;

      // return the SAME owner-facing card shape /owner/properties uses, so the
      // front end can drop it straight into the grid. A brand-new property has
      // no units/runs yet; recognized = it has a resolved alias or canonical_key.
      const recognized = !!alias || !!prop.canonical_key;
      res.status(201).json({
        status: "created",
        property: {
          property_id: prop.id,
          name: prop.name || "Untitled property",
          address: prop.address || null,
          identity: recognized ? "Recognized" : "New",
          files_uploaded: 0,
          units_found: 0,
          units_pending: 0,
          open_questions: 0,
          next_action: "Upload a rent roll to populate this property.",
          _details: {
            canonical_key: prop.canonical_key || null,
            //  Why identity is absent, when it is. Previously a bare null
            //  that the surface could not explain to the owner.
            canonical_key_absent_reason: prop.canonical_key_absent_reason || null,
            recognized_by_alias: !!alias,
            alias_id: alias ? alias.alias_id : null,
            alias_value: aliasValue,
            canonical_key_source: out.canonical_key_source,
          },
        },
      });
    } catch (e) {
      if (e.httpStatus) {
        //  The two refusals this route always had, now raised by the
        //  service and reported with the same statuses the front end
        //  already branches on: 409 identity collision (offer
        //  link-existing) and 409 alias conflict (do not steal a string).
        const status = e.refusalReason === "property_identity_exists" ? 409
          : e.refusalReason === "alias_conflict" ? 409
          : e.httpStatus;
        return res.status(status).json({
          status: e.refusalReason === "property_identity_exists" ? "exists_maybe"
            : e.refusalReason === "alias_conflict" ? "alias_conflict" : undefined,
          error: e.publicMessage, reason: e.refusalReason, ...e.detail,
        });
      }
      console.error("create-from-upload error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
