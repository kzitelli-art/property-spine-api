// ════════════════════════════════════════════════════════════════════
//  IDENTIFY  —  the property-agnostic front door
//
//  The user drops a file. BEFORE any heavy unit extraction, this answers
//  one question fast: WHAT PROPERTY IS THIS, and do we recognize it?
//
//  Two phases, deliberately split:
//    1. IDENTIFY (read-only)  — scan-first + model-fallback to pull the
//       property ADDRESS, then resolveOnly() against the registry. Returns
//       matched | ambiguous | unknown. Writes NOTHING.
//    2. CONFIRM (writes)      — only after the user says "yes, this is the
//       property": register the alias (link) or surface that a property
//       needs creating. The glance never mutates state; the confirm does.
//
//  Identity is the ADDRESS, never the marketing name. Fast pass and full
//  ingest must converge on the same normalized address string or the
//  registry fragments — so we extract the address form, same as the full
//  ingest prompt is instructed to.
//
//  Mount (two lines in server.js, AFTER pool + registryInstance exist):
//    const identifyModule = require("./identify");
//    app.use("/", identifyModule({ pool, anthropic, registryInstance, INGEST_MODEL, fileToText }));
// ════════════════════════════════════════════════════════════════════

module.exports = function identify(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, anthropic, registryInstance, INGEST_MODEL, fileToText, upload } = deps;
  if (!pool) throw new Error("identify module requires a pool");
  if (!registryInstance || !registryInstance.resolveOnly) throw new Error("identify requires registryInstance with resolveOnly");

  // ── SCAN-FIRST address extractor. Most rent-roll headers carry the
  //    property line in the first handful of rows, e.g.
  //      "4233 - SOLO on Chestnut (4233)"
  //      "Property = 1325 N 15th"
  //      "Tower Place (tower)"
  //    We try to pull an ADDRESS-shaped string cheaply. If we can't find one
  //    confidently, we return null and the caller falls back to the model.
  //
  //    Returns { address, name, basis } or null.
  function scanForIdentity(text) {
    if (!text) return null;
    // Identity lives in the TOP of the file, never in a data row. We look only
    // at the first 8 non-empty lines and only accept UNMISTAKABLE header shapes.
    // Anything ambiguous returns null -> the caller uses the model. We would
    // rather be slow than confidently wrong (the 00 MODEL lesson).
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 8);

    for (const line of lines) {
      // A data row has many tab-separated cells. A header property-line does not.
      // If a line has 3+ tabs, it's a row of unit data — never an identity line.
      const tabCells = line.split(/\t/).filter(c => c.trim()).length;
      if (tabCells >= 3) continue;

      // Shape 1 — "Property = <x>" / "Property: <x>" (Yardi Breeze).
      let m = line.match(/^property\s*[:=]\s*(.+)$/i);
      if (m && m[1].trim().length >= 3) {
        const val = m[1].trim();
        return { address: null, name: val, label: val, basis: "scan:property_label" };
      }

      // Shape 2 — "<code> - <Name> (<code>)"  e.g. "4233 - SOLO on Chestnut (4233)".
      //   The defining header shape in these Yardi rolls. Capture the NAME core
      //   and the code; we resolve on the cleaned label. Must have the " - " and
      //   the trailing "(...)" to qualify — a data row won't.
      m = line.match(/^([\w.-]{1,12})\s+[-–]\s+(.+?)\s*\(([^)]+)\)\s*$/);
      if (m) {
        const name = m[2].trim();
        if (name.length >= 3 && !/\b(rent roll|total|summary|page)\b/i.test(name)) {
          return { address: null, name: name, code: m[1].trim(), label: line.trim(), basis: "scan:code_name_code" };
        }
      }

      // Shape 3 — "<Name> (<code>)"  e.g. "Tower Place (tower)".
      m = line.match(/^([A-Za-z][A-Za-z0-9.\-' ]{2,40})\s*\(([^)]+)\)\s*$/);
      if (m && !/\b(rent roll|total|summary|page|as of)\b/i.test(m[1])) {
        return { address: null, name: m[1].trim(), code: m[2].trim(), label: line.trim(), basis: "scan:name_code" };
      }

      // Shape 4 — a clean street address ON ITS OWN LINE (no tabs, starts with a
      //   street number, looks like an address). A data row was already excluded
      //   by the tab check, so this only matches a real address header line.
      if (tabCells === 0) {
        m = line.match(/^(\d{2,6}\s+[NSEW]?\.?\s*[A-Za-z][A-Za-z0-9.\-' ]{2,40})$/);
        if (m && !/\bMODEL|VACANT|DOWN\b/i.test(m[1])) {
          return { address: m[1].trim(), name: null, label: m[1].trim(), basis: "scan:street_line" };
        }
      }
    }
    return null; // nothing unmistakable -> model fallback
  }


  // ── MODEL FALLBACK. Only when the scan can't find an address. Tiny prompt,
  //    tiny output — this is NOT the extraction engine, just identity.
  async function modelForIdentity(text) {
    const head = String(text).split(/\r?\n/).slice(0, 40).join("\n");
    const prompt =
      "From the header of this property document, return ONLY the property's identity as JSON: " +
      '{"address":"<street address if present, else null>","name":"<marketing/display name if present, else null>"}. ' +
      "The ADDRESS is the stable identity (e.g. \"4233 Chestnut Street\"); the NAME is a label that can change (e.g. \"SOLO on Chestnut\"). " +
      "Return null for a field you cannot read. No prose, no markdown, JSON only.\n\nHEADER:\n" + head;
    const ai = await anthropic.messages.create({
      model: INGEST_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    try {
      const j = JSON.parse(raw);
      return { address: j.address || null, name: j.name || null, basis: "model" };
    } catch {
      return { address: null, name: null, basis: "model_unparseable", raw };
    }
  }

  // ── Build the user-facing answer from a resolve result + the identity. ──
  function shapeAnswer(identity, resolved) {
    const display = identity.address || identity.label || identity.name || identity.input || "(unreadable)";
    if (resolved.status === "resolved") {
      return {
        result: "matched",
        message: `Matched to ${resolved.property_name || resolved.canonical_key || display}.`,
        property_id: resolved.property_id,
        canonical_key: resolved.canonical_key,
        resolved_on: identity.address || identity.name,
      };
    }
    if (resolved.status === "ambiguous") {
      return {
        result: "ambiguous",
        message: `"${display}" could be more than one property. Please confirm which.`,
        candidates: resolved.candidates,
        resolved_on: identity.address || identity.name,
      };
    }
    // unknown
    return {
      result: "unknown",
      message: `I found ${display}. Is this a property you already have, or a new one?`,
      would_register: resolved.would_register === true,
      resolved_on: identity.address || identity.name,
    };
  }

  // ── core: text -> identity -> read-only resolve -> answer ──
  async function identifyFromText(text) {
    if (!text || !text.trim()) {
      return { result: "no_text", message: "The file had no readable text to identify a property from." };
    }
    let identity = scanForIdentity(text);
    let usedModel = false;
    // Scan only fires on unmistakable header shapes. If it found nothing, the
    // model reads the header for identity. We do NOT fire the model when the scan
    // already succeeded — that keeps the standard rolls fast (no confident garbage,
    // no needless model call). The model returns {address, name}.
    if (!identity) {
      identity = await modelForIdentity(text);
      usedModel = true;
    }

    // Resolve on the ADDRESS if we have one (stable identity), else the NAME/label.
    const resolveValue = identity.address || identity.label || identity.name;
    if (!resolveValue) {
      return { result: "unreadable", message: "Could not read a property name or address from this file.",
               identity, used_model: usedModel };
    }
    const resolved = await registryInstance.resolveOnly(pool, { value: resolveValue });
    const answer = shapeAnswer({ ...identity, input: resolveValue }, resolved);
    return { ...answer, identity, used_model: usedModel, resolve_value: resolveValue };
  }

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 1 — IDENTIFY (read-only). Property-agnostic: NO :propertyId.
  //  POST /identify        { text }            — pasted text
  //  POST /identify-file   (multipart "file")  — uploaded file
  //  Optional body field route_property_id adds a file-vs-route conflict note.
  // ════════════════════════════════════════════════════════════════════
  router.post("/identify", async (req, res) => {
    try {
      const { text, route_property_id } = req.body || {};
      const out = await identifyFromText(text);
      attachRouteCheck(out, route_property_id);
      res.json(out);
    } catch (e) {
      console.error("identify error", e);
      res.status(500).json({ error: e.message });
    }
  });

  if (upload && fileToText) {
    const single = upload.single("file");
    router.post("/identify-file", (req, res, next) => {
      single(req, res, (err) => {
        if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
          .json({ error: "upload failed: " + err.message });
        next();
      });
    }, async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "no file uploaded (field name must be 'file')" });
        let text;
        try { text = await fileToText(req.file); }
        catch { return res.status(400).json({ error: "could not read file — supported: .xlsx .xls .csv .pdf .docx .doc .txt" }); }
        const out = await identifyFromText(text);
        attachRouteCheck(out, (req.body && req.body.route_property_id) || null);
        out.source_filename = req.file.originalname;
        res.json(out);
      } catch (e) {
        console.error("identify-file error", e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  // Optional: if a property context was already chosen, note whether the file agrees.
  function attachRouteCheck(out, routeId) {
    if (!routeId) return;
    if (out.result === "matched") {
      out.route_check = out.property_id === routeId
        ? { status: "match", note: "File identity matches the route property." }
        : { status: "CONFLICT", route_property_id: routeId, resolved_property_id: out.property_id,
            note: "The file resolves to a DIFFERENT property than the route. Route is NOT applied as truth — a human must reconcile." };
    } else if (out.result === "ambiguous") {
      out.route_check = { status: "ambiguous_in_file", route_property_id: routeId,
        note: "File identity is ambiguous; route property is not confirmed." };
    } else {
      out.route_check = { status: "no_resolved_identity", route_property_id: routeId,
        note: "Nothing in the file resolved to a known property; route is the user's assertion only." };
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  PHASE 2 — CONFIRM (writes). Only after the user answers the glance.
  //  POST /identify/confirm-link   { property_id, alias_value, source? }
  //     The user said "yes, this file IS that property" → register the alias
  //     (resolved, linked). Uses the shared write path so it's the ONE identity
  //     path. This is the ONLY place the front door mutates the registry.
  // ════════════════════════════════════════════════════════════════════
  router.post("/identify/confirm-link", async (req, res) => {
    try {
      const { property_id, alias_value, source } = req.body || {};
      if (!property_id || !alias_value) return res.status(400).json({ error: "property_id and alias_value are required" });
      const p = await pool.query("select id, name, canonical_key from properties where id=$1", [property_id]);
      if (p.rows.length === 0) return res.status(404).json({ error: "property not found" });
      // Write a RESOLVED alias linking this string to the confirmed property.
      const ins = await pool.query(
        `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
         values ($1, $2, 'address_string', $3, 'resolved', 'user-confirmed via identify front door')
         on conflict (source_system, alias_value) do update
           set property_id = excluded.property_id, confidence = 'resolved', updated_at = now()
         returning id, property_id, confidence`,
        [property_id, source || "rent_roll", String(alias_value).trim()]
      );
      res.json({ result: "linked", property: p.rows[0], alias: ins.rows[0],
        message: `Linked "${alias_value}" to ${p.rows[0].name || p.rows[0].canonical_key}. Future uploads will resolve automatically.` });
    } catch (e) {
      console.error("confirm-link error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
