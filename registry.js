// ════════════════════════════════════════════════════════════════════
//  PROPERTY REGISTRY MODULE — registry.js
//
//  STEP ZERO of the bridge layer. The canonical-key resolver. Every bridge
//  to come (cash/waterfall, loan, book-to-book) must first answer "which
//  property is this system talking about?" — and the real data proves that's
//  not obvious: "SOLO on Chestnut" means both 4125 and 4233; a 4233 loan doc
//  says "LVL 4125". Name is not identity. This module resolves any system
//  string to ONE canonical property, or flags it unresolved for a human.
//  It NEVER guesses — an unmapped string returns unresolved, not a best-match.
//
//  Routes:
//    POST /registry/properties/:id/canonical-key  — set the canonical key (address-anchored)
//    POST /registry/aliases                        — register one or many aliases
//    GET  /registry/resolve?source=&value=         — THE call: string → property (or unresolved)
//    POST /registry/aliases/:id/assign             — map an unresolved alias to a property
//    GET  /registry/unresolved                     — the human queue: aliases not yet mapped
//    GET  /registry/properties/:id/aliases         — all known strings for a property
//
//  Mount in server.js (two lines):
//    const registryModule = require("./registry");
//    app.use("/", registryModule({ pool }));
// ════════════════════════════════════════════════════════════════════

module.exports = function registry(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool } = deps;
  if (!pool) throw new Error("registry module requires a pool");

  const SOURCES = ["yardi", "entrata", "mri", "lender", "bank", "sharepoint", "rent_roll", "other"];
  const TYPES = ["code", "name", "account", "folder", "entity", "loan_number", "address_string"];

  // ── confidence gate: does this string look like a real property identifier?
  // Don't pollute the unresolved queue with headers, titles, owner names, blanks.
  // A real property string has a number (street number / unit code) OR is a known
  // property-name shape. Junk (pure prose, report titles, empty fragments) is
  // rejected. Conservative: when unsure, reject — an un-registered real property
  // surfaces elsewhere (orphanExtracted), but junk in the queue erodes trust.
  function looksLikePropertyString(s) {
    if (!s) return false;
    const t = String(s).trim();
    if (t.length < 3 || t.length > 120) return false;          // blanks / runaway fragments

    // reject obvious report boilerplate / titles / headers regardless of digits
    if (/\b(rent roll|as of|confidential|page|trial balance|balance sheet|income statement|cash flow|summary|report|prepared|period|total|sq ft|market|resident|deposit)\b/i.test(t)) return false;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t)) return false;      // contains a date anywhere

    if (!/\d/.test(t)) {
      // no digit: only a short proper-noun-ish name (e.g. "Uno on Chestnut")
      const words = t.split(/\s+/);
      if (words.length > 6) return false;                       // titles / sentences
      if (/[.:;]/.test(t)) return false;                        // punctuation = prose/title
      return /^[A-Z]/.test(t);                                  // proper-noun-ish only
    }
    // has a digit — must look address-like or code-like, not just contain a number.
    // (report boilerplate with digits was already rejected above.)
    if (/^\d{1,4}$/.test(t)) return false;                      // bare number
    const addressLike = /\d+\s+\w+/.test(t);                    // "4233 Chestnut", "1213 Walnut"
    const codeLike = /[a-z]+\d|\d+\)/i.test(t);                 // crm1439, "(380010)"
    const nameWithNumber = t.split(/\s+/).length >= 2 && /\d/.test(t); // "SOLO on Chestnut - 4233"
    return addressLike || codeLike || nameWithNumber;
  }

  // normalize for lookup only (storage keeps the as-seen value for provenance):
  // trim + lowercase. Resolution is case/whitespace-insensitive.
  const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());

  // ── PROPERTY FALLBACK (the Jun 10 registry-gap fix) ────────────────
  // A clean address string ("4233 Chestnut") resolved UNKNOWN even though
  // the property was live, because matching only ever looked at TAUGHT
  // aliases. Fallback: if no alias matches, compare the normalized input
  // against the properties table itself — canonical_key (separators
  // normalized) and address ONLY. NEVER name: name is not identity
  // (SOLO→Uno proved it). Exact normalized equality only — no fuzzy
  // matching, because a silent wrong match is the exact failure this
  // registry exists to kill. Multiple hits → ambiguous, never a guess.
  const keyNorm = (s) => norm(s).replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  async function propertyFallback(client, value) {
    const v = keyNorm(value);
    if (!v) return null;
    const r = await client.query(
      `select id as property_id, canonical_key, name as property_name
         from properties
        where regexp_replace(lower(btrim(coalesce(canonical_key,''))), '[-_]+', ' ', 'g') = $1
           or regexp_replace(lower(btrim(coalesce(address,''))), '[-_]+', ' ', 'g') = $1`,
      [v]
    );
    if (r.rows.length === 1) return { status: "resolved", via: "property_fallback", ...r.rows[0], input: value };
    if (r.rows.length > 1) return { status: "ambiguous", via: "property_fallback", input: value,
      candidates: r.rows.map(x => ({ property_id: x.property_id, canonical_key: x.canonical_key, property_name: x.property_name })) };
    return null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  SHARED HELPER — resolveOrRegister(client, { source, value, alias_type })
  //
  //  The product behavior, callable from ingest (no buttons, no manual entry):
  //  given a property string read from a file, return one of:
  //    { status:'resolved',   property_id, canonical_key }   — attach to this property
  //    { status:'ambiguous',  candidates:[...] }              — FLAG, never guess
  //    { status:'registered_unresolved', alias_id }           — auto-registered from
  //         the file as an unresolved alias; surfaced in the human queue
  //
  //  Takes a client so the caller controls the transaction (ingest is one txn).
  //  This is the ONE identity path — ingest does not reimplement matching.
  // ══════════════════════════════════════════════════════════════════
  async function resolveOrRegister(client, { source = "rent_roll", value, alias_type = "address_string" }) {
    if (!value || !String(value).trim()) return { status: "skipped", reason: "empty_value" };
    const v = norm(value);

    // look across all sources first (a string may have been registered under any)
    const r = await client.query(
      `select pa.property_id, p.canonical_key, p.name as property_name
         from property_aliases pa
         left join properties p on p.id = pa.property_id
        where lower(btrim(pa.alias_value)) = $1`,
      [v]
    );
    const props = [...new Set(r.rows.filter(x => x.property_id).map(x => x.property_id))];

    if (props.length === 1) {
      const hit = r.rows.find(x => x.property_id);
      return { status: "resolved", property_id: hit.property_id, canonical_key: hit.canonical_key, property_name: hit.property_name, input: value };
    }
    if (props.length > 1) {
      // the collision case — flag it, do NOT guess (the anti-Mark rule on identity)
      return { status: "ambiguous", input: value,
        candidates: r.rows.filter(x => x.property_id).map(x => ({ property_id: x.property_id, canonical_key: x.canonical_key, property_name: x.property_name })) };
    }

    // FALLBACK before auto-registering: maybe no alias was ever taught,
    // but the string IS a live property's canonical key or address.
    const fb = await propertyFallback(client, value);
    if (fb) {
      if (fb.status === "resolved") {
        // committing path may learn: record the observed string as a
        // proposed alias so the NEXT resolve is a direct alias hit.
        await client.query(
          `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
           values ($1, $2, $3, $4, 'proposed', 'learned via property fallback (matched canonical_key/address)')
           on conflict (source_system, alias_value) do update
             set property_id = excluded.property_id, updated_at = now()`,
          [fb.property_id,
           SOURCES.includes(source) ? source : "other",
           TYPES.includes(alias_type) ? alias_type : "address_string",
           String(value).trim()]
        );
      }
      return fb;
    }

    // unknown OR known-but-unresolved → register from the file as unresolved.
    // But ONLY if it looks like a real property string — don't pollute the queue
    // with headers/titles/junk. (Resolved + ambiguous already returned above, so
    // the gate only guards NEW unresolved registrations.)
    if (!looksLikePropertyString(value)) {
      return { status: "skipped", reason: "not_property_like", input: value };
    }
    // upsert keeps it idempotent if the same string is ingested again.
    const ins = await client.query(
      `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
       values (null, $1, $2, $3, 'unresolved', $4)
       on conflict (source_system, alias_value) do update
         set updated_at = now()
       returning id, confidence`,
      [SOURCES.includes(source) ? source : "other",
       TYPES.includes(alias_type) ? alias_type : "address_string",
       String(value).trim(),
       "auto-registered from ingest; needs human resolution"]
    );
    return { status: "registered_unresolved", alias_id: ins.rows[0].id, input: value };
  }

  // ══════════════════════════════════════════════════════════════════
  //  SET CANONICAL KEY  —  POST /registry/properties/:id/canonical-key
  //  Body: { canonical_key }   e.g. "4233-CHESTNUT" (address-anchored, not name)
  // ══════════════════════════════════════════════════════════════════
  router.post("/registry/properties/:id/canonical-key", async (req, res) => {
    const property_id = req.params.id;
    const { canonical_key } = req.body || {};
    if (!canonical_key || !String(canonical_key).trim()) {
      return res.status(400).json({ error: "canonical_key required — anchor it on the address, not the name (e.g. 4233-CHESTNUT)" });
    }
    try {
      const p = await pool.query("select id, address from properties where id=$1", [property_id]);
      if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      try {
        const upd = await pool.query(
          "update properties set canonical_key=$1, updated_at=now() where id=$2 returning id, name, address, canonical_key",
          [String(canonical_key).trim(), property_id]
        );
        res.json({ property: upd.rows[0], note: "Canonical key set. This is the one identity every system alias resolves to." });
      } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "that canonical_key is already used by another property", canonical_key });
        throw e;
      }
    } catch (e) {
      console.error("canonical-key error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  REGISTER ALIASES  —  POST /registry/aliases
  //  Body: { aliases: [ { source_system, alias_value, alias_type?, property_id?, confidence?, note? } ] }
  //  property_id present → resolved/proposed mapping. Absent → unresolved (human queue).
  // ══════════════════════════════════════════════════════════════════
  router.post("/registry/aliases", async (req, res) => {
    const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases : null;
    if (!aliases || aliases.length === 0) {
      return res.status(400).json({ error: "aliases[] required — each { source_system, alias_value, alias_type?, property_id? }" });
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = [];
      for (const a of aliases) {
        if (!SOURCES.includes(a.source_system)) { await client.query("rollback"); return res.status(400).json({ error: `source_system must be one of ${SOURCES.join("|")}`, bad: a }); }
        if (!a.alias_value || !String(a.alias_value).trim()) { await client.query("rollback"); return res.status(400).json({ error: "each alias needs alias_value", bad: a }); }
        const alias_type = a.alias_type && TYPES.includes(a.alias_type) ? a.alias_type : "code";
        const property_id = a.property_id || null;
        // confidence: explicit > (resolved if property given) > unresolved
        const confidence = a.confidence || (property_id ? "resolved" : "unresolved");
        if (property_id) {
          const p = await client.query("select id from properties where id=$1", [property_id]);
          if (p.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "property_id not found", bad: a }); }
        }
        // upsert on (source_system, alias_value) — re-registering updates the mapping
        const ins = await client.query(
          `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
           values ($1,$2,$3,$4,$5,$6)
           on conflict (source_system, alias_value) do update
             set property_id = excluded.property_id,
                 alias_type  = excluded.alias_type,
                 confidence  = excluded.confidence,
                 note        = coalesce(excluded.note, property_aliases.note),
                 updated_at  = now()
           returning *`,
          [property_id, a.source_system, alias_type, String(a.alias_value).trim(), confidence, a.note || null]
        );
        out.push(ins.rows[0]);
      }
      await client.query("commit");
      res.status(201).json({
        registered: out.length, aliases: out,
        note: "Aliases registered. Those with no property_id are 'unresolved' and surface in GET /registry/unresolved for a human to assign — never auto-guessed.",
      });
    } catch (e) {
      await client.query("rollback");
      console.error("aliases register error", e);
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  RESOLVE  —  GET /registry/resolve?source=&value=
  //  THE call every bridge makes first. Given a system string, return the one
  //  canonical property — or unresolved. NEVER guesses a best match.
  // ══════════════════════════════════════════════════════════════════
  router.get("/registry/resolve", async (req, res) => {
    const { source, value } = req.query;
    if (!value) return res.status(400).json({ error: "value is required (the system string to resolve)" });
    try {
      // exact match within source if given; else across all sources.
      // case/whitespace-insensitive via lower(trim()).
      const vals = [norm(value)];
      let where = "lower(btrim(alias_value)) = $1";
      if (source) { vals.push(source); where += ` and source_system = $${vals.length}`; }

      const r = await pool.query(
        `select pa.*, p.name as property_name, p.address as property_address, p.canonical_key
           from property_aliases pa
           left join properties p on p.id = pa.property_id
          where ${where}`,
        vals
      );

      if (r.rows.length === 0) {
        // FALLBACK (Jun 10 gap): no alias taught, but the string may BE a
        // live property's canonical key or address. Same shared helper as
        // resolveOnly / resolveOrRegister — one identity path. Read-only here.
        const fb = await propertyFallback(pool, value);
        if (fb && fb.status === "resolved") {
          return res.json({
            resolved: true,
            property_id: fb.property_id,
            canonical_key: fb.canonical_key,
            property_name: fb.property_name,
            matched_via: { fallback: "property_fallback", note: "matched the property's own canonical_key/address — no alias was taught. Teach the alias to make this a first-class match." },
          });
        }
        if (fb && fb.status === "ambiguous") {
          return res.json({ resolved: false, reason: "ambiguous", input: { source: source || null, value },
            candidates: fb.candidates,
            note: "This string matches MORE THAN ONE property's canonical_key/address. NOT guessed — needs a human call." });
        }
        return res.json({ resolved: false, reason: "no_alias", input: { source: source || null, value },
          note: "No alias matches. Register it via POST /registry/aliases (with property_id to resolve, or without to queue for a human)." });
      }
      // distinct properties this string maps to
      const props = [...new Set(r.rows.filter(x => x.property_id).map(x => x.property_id))];
      if (props.length === 0) {
        return res.json({ resolved: false, reason: "unresolved_alias", input: { source: source || null, value },
          matches: r.rows.map(x => ({ source_system: x.source_system, confidence: x.confidence })),
          note: "Alias is known but not yet mapped to a property. Assign it via POST /registry/aliases/:id/assign." });
      }
      if (props.length > 1) {
        // the collision case — the exact thing this layer exists to catch.
        return res.json({ resolved: false, reason: "ambiguous", input: { source: source || null, value },
          candidates: r.rows.filter(x => x.property_id).map(x => ({ property_id: x.property_id, canonical_key: x.canonical_key, property_name: x.property_name, source_system: x.source_system })),
          note: "This string maps to MORE THAN ONE property (e.g. 'SOLO on Chestnut' → 4125 and 4233). Resolve by passing source= to disambiguate, or fix the aliases. NOT guessed." });
      }
      const hit = r.rows.find(x => x.property_id);
      res.json({
        resolved: true,
        property_id: hit.property_id,
        canonical_key: hit.canonical_key,
        property_name: hit.property_name,
        property_address: hit.property_address,
        matched_via: { source_system: hit.source_system, alias_type: hit.alias_type, alias_value: hit.alias_value, confidence: hit.confidence },
      });
    } catch (e) {
      console.error("resolve error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  ASSIGN  —  POST /registry/aliases/:id/assign
  //  Body: { property_id, confidence? }  — map an unresolved alias to a property.
  // ══════════════════════════════════════════════════════════════════
  router.post("/registry/aliases/:id/assign", async (req, res) => {
    const alias_id = req.params.id;
    const { property_id, confidence = "resolved" } = req.body || {};
    if (!property_id) return res.status(400).json({ error: "property_id required" });
    try {
      const p = await pool.query("select id from properties where id=$1", [property_id]);
      if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      const upd = await pool.query(
        "update property_aliases set property_id=$1, confidence=$2, updated_at=now() where id=$3 returning *",
        [property_id, ["resolved", "proposed", "unresolved"].includes(confidence) ? confidence : "resolved", alias_id]
      );
      if (upd.rows.length === 0) return res.status(404).json({ error: "alias not found" });
      res.json({ alias: upd.rows[0], note: "Alias assigned. It now resolves to this property." });
    } catch (e) {
      console.error("assign error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  UNRESOLVED QUEUE  —  GET /registry/unresolved
  //  The human queue: every alias seen but not mapped. The honest exception list.
  // ══════════════════════════════════════════════════════════════════
  router.get("/registry/unresolved", async (req, res) => {
    try {
      const r = await pool.query(
        `select * from property_aliases where property_id is null or confidence = 'unresolved' order by created_at asc`
      );
      res.json({ count: r.rows.length, unresolved: r.rows,
        note: "Aliases the system has seen but not mapped to a property. Nothing was guessed — each needs a human assign via POST /registry/aliases/:id/assign." });
    } catch (e) {
      console.error("unresolved error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  PROPERTY ALIASES  —  GET /registry/properties/:id/aliases
  //  All the strings every system uses for one property.
  // ══════════════════════════════════════════════════════════════════
  router.get("/registry/properties/:id/aliases", async (req, res) => {
    try {
      const p = await pool.query("select id, name, address, canonical_key from properties where id=$1", [req.params.id]);
      if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      const r = await pool.query("select * from property_aliases where property_id=$1 order by source_system, alias_type", [req.params.id]);
      res.json({ property: p.rows[0], alias_count: r.rows.length, aliases: r.rows });
    } catch (e) {
      console.error("property aliases error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── READ-ONLY twin of resolveOrRegister. Same SELECT, same norm, but it
  //    NEVER writes. The fast identity front-door pass uses this so a glance
  //    at a file does not mutate the registry. Registration happens only when
  //    the user confirms (router.confirmRegister below). Returns:
  //      { status:'resolved',  property_id, canonical_key, property_name }
  //      { status:'ambiguous', candidates:[...] }
  //      { status:'unknown',   would_register: <bool from looksLikePropertyString> }
  //      { status:'skipped',   reason }
  async function resolveOnly(client, { value }) {
    if (!value || !String(value).trim()) return { status: "skipped", reason: "empty_value" };
    const v = norm(value);
    const r = await client.query(
      `select pa.property_id, p.canonical_key, p.name as property_name
         from property_aliases pa
         left join properties p on p.id = pa.property_id
        where lower(btrim(pa.alias_value)) = $1`,
      [v]
    );
    const props = [...new Set(r.rows.filter(x => x.property_id).map(x => x.property_id))];
    if (props.length === 1) {
      const hit = r.rows.find(x => x.property_id);
      return { status: "resolved", property_id: hit.property_id, canonical_key: hit.canonical_key, property_name: hit.property_name, input: value };
    }
    if (props.length > 1) {
      return { status: "ambiguous", input: value,
        candidates: r.rows.filter(x => x.property_id).map(x => ({ property_id: x.property_id, canonical_key: x.canonical_key, property_name: x.property_name })) };
    }
    // FALLBACK (read-only): no alias taught, but the string may BE a live
    // property's canonical key or address. Looks, never writes.
    const fb = await propertyFallback(client, value);
    if (fb) return fb;

    // unknown — report whether a confirm WOULD be allowed to register it,
    // but do not write anything now.
    return { status: "unknown", input: value, would_register: looksLikePropertyString(value) };
  }

  // expose the shared resolver so ingest (and future bridges) use the ONE
  // identity path rather than reimplementing matching.
  router.resolveOrRegister = resolveOrRegister;
  router.resolveOnly = resolveOnly;
  return router;
};
