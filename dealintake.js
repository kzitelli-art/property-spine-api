// ════════════════════════════════════════════════════════════════════
//  DEAL INTAKE — the onboarding front door, batch edition.
//
//  "Upload what you have. One door." The user drops a messy deal folder.
//  This module:
//    1. CLASSIFIES every file (filename → path → ONE batched model call
//       for the stragglers; 'unknown' is an honest answer, never a guess).
//    2. RESOLVES identity read-only via the registry (identify ≠ commit).
//    3. Returns the found / missing / confidence summary the front end shows.
//    4. CAPTURES corrections as data (no self-modifying behavior).
//    5. Routes a confirmed rent roll into the EXISTING ingest pipeline —
//       it never reimplements extraction, candidates, or promotion.
//
//  ROUTES:
//    POST /deal-intakes                          — start an intake {onboarding_type}
//    POST /deal-intakes/:id/files                — multipart batch upload + classify
//    GET  /deal-intakes/:id/summary              — found/missing/confidence object
//    POST /deal-intakes/:id/files/:fileId/correct— record a human correction
//    POST /deal-intakes/:id/run-rentroll         — {file_id, property_id} → real ingest
//    GET  /deal-intakes                          — recent intakes (newest first)
//
//  Mount in server.js (AFTER pool, registryInstance, fileToText, runIngestAuto):
//    const dealIntakeModule = require("./dealintake");
//    app.use("/", dealIntakeModule({ pool, anthropic, INGEST_MODEL, registryInstance, fileToText, runIngestAuto, upload }));
// ════════════════════════════════════════════════════════════════════

module.exports = function dealIntake(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, anthropic, INGEST_MODEL, registryInstance, fileToText, runIngestAuto, upload } = deps;

  if (!pool) throw new Error("dealintake requires a pool");
  if (!anthropic) throw new Error("dealintake requires the anthropic client");
  if (!registryInstance || !registryInstance.resolveOnly) throw new Error("dealintake requires registryInstance with resolveOnly");
  if (!fileToText) throw new Error("dealintake requires fileToText");
  if (!runIngestAuto) throw new Error("dealintake requires runIngestAuto");
  if (!upload) throw new Error("dealintake requires the multer upload instance");

  const DOC_TYPES = [
    "offering_memo","rent_roll","t12","operating_statement","lease","utility_bill",
    "service_contract","insurance","tax_bill","acquisition_model","underwriting_model",
    "dd_list","lender_questions","pca","environmental","appraisal","survey","psa","deed",
    "loan_document","entity_document","closing_binder","bank_statement","manager_export","unknown",
  ];

  // Full text is stored ONLY for types that feed downstream extraction.
  const KEEP_FULL_TEXT = new Set(["rent_roll","t12","operating_statement","bank_statement"]);

  const HUMAN_LABEL = {
    offering_memo: "Offering memo", rent_roll: "Rent roll", t12: "T12",
    operating_statement: "Operating statement", lease: "Leases", utility_bill: "Utility bills",
    service_contract: "Service contracts", insurance: "Insurance", tax_bill: "Tax bill",
    acquisition_model: "Acquisition model", underwriting_model: "Underwriting model",
    dd_list: "DD list", lender_questions: "Lender questions", pca: "PCA",
    environmental: "Environmental", appraisal: "Appraisal", survey: "Survey",
    psa: "PSA", deed: "Deed", loan_document: "Loan documents",
    entity_document: "Entity documents", closing_binder: "Closing binder",
    bank_statement: "Bank statements", manager_export: "Manager export", unknown: "Unclassified",
  };

  // document_type → source_category. The locked rule lives here:
  // a closing binder is NOT seller diligence.
  function sourceCategoryOf(docType) {
    if (["offering_memo","rent_roll","t12","operating_statement","lease","utility_bill",
         "service_contract","insurance","tax_bill","manager_export","bank_statement"].includes(docType)) return "seller_material";
    if (["acquisition_model","underwriting_model","dd_list","lender_questions"].includes(docType)) return "buyer_workpaper";
    if (["pca","environmental","appraisal","survey"].includes(docType)) return "third_party_report";
    if (["psa","deed","loan_document","entity_document","closing_binder"].includes(docType)) return "closing_legal";
    return "unknown";
  }

  // ── PASS 1: filename + path heuristics. Deterministic, basis recorded. ──
  // Only UNMISTAKABLE matches; anything else stays unknown for the model pass.
  function classifyByName(filename, relPath) {
    const n = String(filename || "").toLowerCase();
    const p = String(relPath || "").toLowerCase();

    // Path beats filename for the closing-binder rule.
    if (p.includes("closing binder") || p.includes("closing_binder") || n.includes("closing binder"))
      return { type: "closing_binder", basis: p ? "path" : "filename" };

    const rules = [
      [/rent[\s_-]?roll|rentroll/, "rent_roll"],
      [/\bt-?12\b|trailing[\s_-]?(12|twelve)/, "t12"],
      [/operating[\s_-]?statement|income[\s_-]?statement|p&l|profit.?(and|&).?loss/, "operating_statement"],
      [/offering[\s_-]?mem|(^|[\s_-])om([\s_.-]|$)/, "offering_memo"],
      [/\blease\b(?!.*roll)/, "lease"],
      [/pgw|peco|water[\s_-]?(bill|revenue)|utilit/, "utility_bill"],
      [/insurance|\bcoi\b|certificate of/, "insurance"],
      [/tax[\s_-]?(bill|cert|return)|real estate tax/, "tax_bill"],
      [/acquisition[\s_-]?model|acq[\s_-]?model/, "acquisition_model"],
      [/underwrit|uw[\s_-]?model/, "underwriting_model"],
      [/\bdd[\s_-]?(list|checklist)|due[\s_-]?diligence list/, "dd_list"],
      [/lender[\s_-]?question/, "lender_questions"],
      [/\bpca\b|property condition/, "pca"],
      [/environmental|phase[\s_-]?(i|1|ii|2)\b/, "environmental"],
      [/appraisal/, "appraisal"],
      [/survey/, "survey"],
      [/\bpsa\b|purchase.{0,8}sale agreement/, "psa"],
      [/\bdeed\b/, "deed"],
      [/loan[\s_-]?(doc|agree)|mortgage statement|promissory/, "loan_document"],
      [/operating agreement|articles of|certificate of formation|\bllc\b.*agreement/, "entity_document"],
      [/bank[\s_-]?statement|account statement|\bcma\b/, "bank_statement"],
      [/yardi|entrata|appfolio|export/, "manager_export"],
    ];
    for (const [re, type] of rules) {
      if (re.test(n)) return { type, basis: "filename" };
    }
    return { type: "unknown", basis: null };
  }

  // ── PASS 2: ONE batched model call for everything still unknown, and for
  //    pulling the property identity label out of identity-bearing files.
  //    Strict JSON. 'unknown' allowed. Never invent. ──
  async function classifyBatchWithModel(items) {
    // items: [{ idx, filename, excerpt }]
    if (items.length === 0) return {};
    const blocks = items.map(it => [
      `FILE ${it.idx}: ${it.filename}`,
      `EXCERPT:`,
      `"""`,
      String(it.excerpt || "").slice(0, 1500),
      `"""`,
    ].join("\n")).join("\n\n");

    const prompt = [
      "You classify real-estate deal documents. For EACH file below, decide its document_type",
      `from EXACTLY this list: ${DOC_TYPES.join(", ")}.`,
      "If you are not sure, answer \"unknown\" — never guess.",
      "Also: if the excerpt's HEADER plainly names the property (a name or street address),",
      "return it as property_label; otherwise null. Do not infer a property from the filename.",
      "",
      blocks,
      "",
      "Reply with ONLY a JSON object, no prose, no markdown fences, shaped:",
      '{ "files": [ { "idx": <number>, "document_type": "<type>", "property_label": "<string or null>" } ] }',
    ].join("\n");

    const msg = await anthropic.messages.create({
      model: INGEST_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = (msg.content || []).map(c => c.text || "").join("");
    let parsed;
    try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
    catch { return {}; } // model failed to follow shape → everything stays unknown (honest)
    const out = {};
    for (const f of (parsed.files || [])) {
      const t = DOC_TYPES.includes(f.document_type) ? f.document_type : "unknown";
      out[f.idx] = { type: t, label: (typeof f.property_label === "string" && f.property_label.trim()) ? f.property_label.trim() : null };
    }
    return out;
  }

  // ── identity: read-only resolve through the ONE registry path.
  //    Live signature (registry.js): resolveOnly(client, { value }) →
  //    { status: "resolved"|"ambiguous"|"unknown"|"skipped", property_id?, ... } ──
  async function resolveLabel(label) {
    if (!label) return { status: "no_identity_found", property_id: null };
    try {
      const r = await registryInstance.resolveOnly(pool, { value: label });
      if (r && r.status === "resolved") return { status: "resolved", property_id: r.property_id };
      if (r && r.status === "ambiguous") return { status: "ambiguous", property_id: null };
      return { status: "unknown", property_id: null }; // 'skipped' folds into unknown — honest, not invented
    } catch {
      return { status: "unknown", property_id: null }; // fail-soft: resolve errors never sink the intake
    }
  }

  // ── confidence: deterministic, by source quality. Never faked. ──
  function scoreConfidence(types, identityResolved) {
    const has = t => types.has(t);
    const hasOps = has("t12") || has("operating_statement");
    if (has("rent_roll") && hasOps && identityResolved)
      return { level: "high", reason: "Rent roll, operating history, and a recognized property identity are all present." };
    if (has("rent_roll") && hasOps)
      return { level: "high", reason: "Rent roll and operating history present; property identity not yet confirmed." };
    if (has("rent_roll"))
      return { level: "medium", reason: "Rent roll present, but no complete T12 / operating statement found." };
    const legalOnly = [...types].every(t => sourceCategoryOf(t) === "closing_legal" || t === "unknown");
    if (types.size > 0 && legalOnly)
      return { level: "low", reason: "Mostly closing/legal documents — no operating source documents found." };
    if (has("offering_memo") || has("acquisition_model") || has("underwriting_model") || has("utility_bill"))
      return { level: "preliminary", reason: "OM / model / utility support found, but no current rent roll or complete T12." };
    return { level: "low", reason: "No recognizable operating source documents found." };
  }

  // What a complete package needs. Missing items become the front-end list.
  const REQUIRED = ["rent_roll", "t12", "insurance", "tax_bill"];

  // ── shared summary computation: ONE implementation, used by the
  //    per-deal /summary route AND the cross-deal /deal-funnel board,
  //    so the two can never drift apart. Pure: takes file rows, returns
  //    the derived picture. corrected type beats detected (human beats
  //    machine); identity = best resolved file, ambiguity surfaced.
  function summarize(files) {
    const effType = f => f.corrected_document_type || f.detected_document_type;
    const types = new Set(files.map(effType).filter(t => t !== "unknown"));
    let identity = { status: "no_identity_found", property_id: null, label: null };
    const order = { resolved: 0, ambiguous: 1, unknown: 2, no_identity_found: 3 };
    for (const f of files) {
      if (f.registry_status && (order[f.registry_status] ?? 9) < (order[identity.status] ?? 9)) {
        identity = { status: f.registry_status, property_id: f.registry_property_id, label: f.identity_label };
      }
    }
    const conf = scoreConfidence(types, identity.status === "resolved");
    const found = [...types].map(t => HUMAN_LABEL[t] || t);
    const missing = REQUIRED.filter(t => !types.has(t)).map(t => HUMAN_LABEL[t]);
    const unknownCount = files.filter(f => effType(f) === "unknown").length;
    const rentRollFile = files.find(f => effType(f) === "rent_roll");
    const rent_roll_state = !rentRollFile ? "missing"
      : rentRollFile.ingest_run_id ? "ingested" : "uploaded";
    return { effType, types, identity, conf, found, missing, unknownCount, rentRollFile, rent_roll_state };
  }

  // ════════════════════════ ROUTES ════════════════════════

  // start an intake
  router.post("/deal-intakes", async (req, res) => {
    const { onboarding_type, deal_name } = req.body || {};
    if (!["new_acquisition","existing_asset","management_takeover"].includes(onboarding_type))
      return res.status(400).json({ error: "onboarding_type must be new_acquisition | existing_asset | management_takeover" });
    try {
      const r = await pool.query(
        "insert into deal_intakes (onboarding_type, deal_name) values ($1,$2) returning id, deal_name, onboarding_type, status, created_at",
        [onboarding_type, deal_name && String(deal_name).trim() || null]
      );
      res.json({ intake_id: r.rows[0].id, ...r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // batch upload + classify. multipart field "files" (up to 60), optional
  // body field "paths" = JSON array of relative paths aligned by index.
  const uploadMany = upload.array("files", 60);
  router.post("/deal-intakes/:id/files", (req, res, next) => {
    uploadMany(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "a file exceeds the 25 MB cap" });
        return res.status(400).json({ error: "upload failed: " + err.message });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const intake = await pool.query("select * from deal_intakes where id=$1", [req.params.id]);
      if (intake.rows.length === 0) return res.status(404).json({ error: "intake not found" });
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: "no files uploaded (field name must be 'files')" });

      let paths = [];
      try { paths = JSON.parse(req.body && req.body.paths || "[]"); } catch { paths = []; }

      // pass 1 — names/paths; read text for everything readable
      const work = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const relPath = paths[i] || null;
        const byName = classifyByName(f.originalname, relPath);
        let text = "";
        try { text = await fileToText(f); } catch { text = ""; }
        work.push({ idx: i, file: f, relPath, type: byName.type, basis: byName.basis, text });
      }

      // pass 2 — one batched model call for the unknowns + identity labels for
      // identity-bearing types (rent roll / t12 / OM lead the identity hunt)
      const needsModel = work.filter(w =>
        w.type === "unknown" || ["rent_roll","t12","offering_memo","operating_statement"].includes(w.type)
      ).map(w => ({ idx: w.idx, filename: w.file.originalname, excerpt: w.text }));
      const modelOut = await classifyBatchWithModel(needsModel);

      for (const w of work) {
        const m = modelOut[w.idx];
        if (m) {
          if (w.type === "unknown" && m.type !== "unknown") { w.type = m.type; w.basis = "model"; }
          w.identityLabel = m.label || null;
        }
      }

      // identity: resolve read-only, file by file (registry is the ONE path)
      for (const w of work) {
        if (w.identityLabel) {
          const r = await resolveLabel(w.identityLabel);
          w.registryStatus = r.status; w.registryPropertyId = r.property_id;
        } else if (["rent_roll","t12","offering_memo","operating_statement"].includes(w.type)) {
          w.registryStatus = "no_identity_found"; w.registryPropertyId = null;
        }
      }

      // persist
      const saved = [];
      for (const w of work) {
        const keepFull = KEEP_FULL_TEXT.has(w.type);
        const r = await pool.query(
          `insert into deal_intake_files
             (intake_id, original_filename, relative_path, mime_type, size_bytes,
              detected_document_type, source_category, classification_basis,
              identity_label, registry_status, registry_property_id,
              text_excerpt, extracted_text)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           returning id, original_filename, detected_document_type, source_category,
                     classification_basis, identity_label, registry_status, registry_property_id`,
          [req.params.id, w.file.originalname, w.relPath, w.file.mimetype, w.file.size,
           w.type, sourceCategoryOf(w.type), w.basis,
           w.identityLabel || null, w.registryStatus || null, w.registryPropertyId || null,
           (w.text || "").slice(0, 4000) || null, keepFull ? (w.text || null) : null]
        );
        saved.push(r.rows[0]);
      }

      await pool.query("update deal_intakes set status='classified', updated_at=now() where id=$1", [req.params.id]);
      res.json({ files_uploaded: saved.length, status: "classified", files: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // the clean front-end object
  router.get("/deal-intakes/:id/summary", async (req, res) => {
    try {
      const intake = await pool.query("select * from deal_intakes where id=$1", [req.params.id]);
      if (intake.rows.length === 0) return res.status(404).json({ error: "intake not found" });
      const files = (await pool.query(
        "select * from deal_intake_files where intake_id=$1 order by created_at", [req.params.id]
      )).rows;

      // ONE computation, shared with the funnel board (see summarize above)
      const s = summarize(files);
      const { effType, identity, conf, found, missing, unknownCount } = s;

      const next_actions = [];
      const rentRollFile = files.find(f => effType(f) === "rent_roll");
      if (rentRollFile && identity.status === "resolved" && !rentRollFile.ingest_run_id)
        next_actions.push({ action: "run_rentroll", file_id: rentRollFile.id, property_id: identity.property_id,
                            note: "Rent roll found and property recognized — run it through ingest." });
      if (identity.status === "ambiguous")
        next_actions.push({ action: "resolve_identity", note: `"${identity.label}" matches more than one property — needs a human call.` });
      if (identity.status === "unknown")
        next_actions.push({ action: "create_or_link_property", note: `"${identity.label}" is not a recognized property.` });
      for (const m of missing) next_actions.push({ action: "upload_missing", note: `Upload: ${m}` });

      res.json({
        intake_id: req.params.id,
        onboarding_type: intake.rows[0].onboarding_type,
        status: intake.rows[0].status,
        summary: {
          files_uploaded: files.length,
          unclassified: unknownCount,
          confidence: conf.level,
          confidence_reason: conf.reason,
        },
        identity,
        found,
        missing,
        files: files.map(f => ({
          id: f.id, filename: f.original_filename,
          document_type: effType(f), corrected: !!f.corrected_document_type,
          source_category: f.source_category, basis: f.classification_basis,
          registry_status: f.registry_status, ingest_run_id: f.ingest_run_id,
        })),
        next_actions,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // capture a human correction (data only — behavior does not change)
  router.post("/deal-intakes/:id/files/:fileId/correct", async (req, res) => {
    const { document_type } = req.body || {};
    if (!DOC_TYPES.includes(document_type))
      return res.status(400).json({ error: `document_type must be one of: ${DOC_TYPES.join(", ")}` });
    try {
      const r = await pool.query(
        `update deal_intake_files
            set corrected_document_type=$1, source_category=$2, classification_basis='human'
          where id=$3 and intake_id=$4
          returning id, original_filename, detected_document_type, corrected_document_type, source_category`,
        [document_type, sourceCategoryOf(document_type), req.params.fileId, req.params.id]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "file not found in this intake" });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // hand a rent roll into the REAL ingest pipeline (existing candidates,
  // existing human gate, existing promotion). This module adds nothing to it.
  router.post("/deal-intakes/:id/run-rentroll", async (req, res) => {
    const { file_id, property_id } = req.body || {};
    if (!file_id || !property_id) return res.status(400).json({ error: "file_id and property_id are required" });
    try {
      const f = await pool.query(
        "select * from deal_intake_files where id=$1 and intake_id=$2", [file_id, req.params.id]
      );
      if (f.rows.length === 0) return res.status(404).json({ error: "file not found in this intake" });
      const row = f.rows[0];
      const effType = row.corrected_document_type || row.detected_document_type;
      if (effType !== "rent_roll")
        return res.status(409).json({ error: `file is classified as '${effType}', not rent_roll. Correct it first if that's wrong.` });
      if (!row.extracted_text || !row.extracted_text.trim())
        return res.status(409).json({ error: "no stored text for this file — re-upload it." });
      const prop = await pool.query("select id from properties where id=$1", [property_id]);
      if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

      const result = await runIngestAuto(property_id, row.extracted_text, "deal_intake");
      const runId = result && (result.run_id || result.id) || null;
      if (runId) await pool.query("update deal_intake_files set ingest_run_id=$1 where id=$2", [runId, file_id]);
      res.json({ ...result, source_filename: row.original_filename, intake_file_id: file_id });
    } catch (e) {
      if (e.truncated) return res.status(413).json({ error: e.message, truncated: true });
      if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
      res.status(500).json({ error: e.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  RE-RESOLVE — POST /deal-intakes/:id/reresolve
  //  After a human links an alias or creates a property, the file rows
  //  still hold their old identity snapshot. This re-runs the SAME
  //  read-only resolver on every file's identity label and updates the
  //  rows — the only way the board's identity status changes is the
  //  registry's answer changing.
  // ══════════════════════════════════════════════════════════════════
  router.post("/deal-intakes/:id/reresolve", async (req, res) => {
    try {
      const files = (await pool.query(
        "select id, identity_label from deal_intake_files where intake_id=$1 and identity_label is not null",
        [req.params.id])).rows;
      let changed = 0;
      const results = [];
      for (const f of files) {
        const r = await registryInstance.resolveOnly(pool, { value: f.identity_label });
        const status = r.status === "skipped" ? "no_identity_found" : r.status;
        const upd = await pool.query(
          `update deal_intake_files
              set registry_status=$1, registry_property_id=$2
            where id=$3 and (registry_status is distinct from $1 or registry_property_id is distinct from $2)
            returning id`,
          [status, r.property_id || null, f.id]);
        if (upd.rowCount) changed++;
        results.push({ file_id: f.id, label: f.identity_label, status, property_id: r.property_id || null });
      }
      res.json({ rechecked: files.length, changed, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════
  //  CREATE PROPERTY FROM DEAL — POST /deal-intakes/:id/create-property
  //  Body: { name, address }
  //  The "link or create" dead end, ended: a deliberate human action
  //  that creates the property, teaches every identity label observed
  //  in this deal's files as a resolved alias, and re-resolves the
  //  files. Never automatic — the human clicked Create.
  // ══════════════════════════════════════════════════════════════════
  router.post("/deal-intakes/:id/create-property", async (req, res) => {
    const { name, address } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
    if (!address || !String(address).trim()) return res.status(400).json({ error: "address required — address is identity; a property without one can't be resolved against" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const intake = await client.query("select id from deal_intakes where id=$1", [req.params.id]);
      if (intake.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "intake not found" }); }
      const prop = await client.query(
        "insert into properties (name, address) values ($1,$2) returning id, name, address",
        [String(name).trim(), String(address).trim()]);
      const pid = prop.rows[0].id;
      // teach every observed identity label from this deal as a resolved alias
      const labels = (await client.query(
        "select distinct identity_label from deal_intake_files where intake_id=$1 and identity_label is not null",
        [req.params.id])).rows;
      for (const l of labels) {
        await client.query(
          `insert into property_aliases (property_id, source_system, alias_type, alias_value, confidence, note)
           values ($1,'other','address_string',$2,'resolved','taught at property creation from deal intake')
           on conflict (source_system, alias_value) do update
             set property_id = excluded.property_id, confidence='resolved', updated_at=now()`,
          [pid, String(l.identity_label).trim()]);
      }
      await client.query(
        "update deal_intake_files set registry_status='resolved', registry_property_id=$1 where intake_id=$2 and identity_label is not null",
        [pid, req.params.id]);
      await client.query("commit");
      res.status(201).json({
        receipt: `property created: ${prop.rows[0].name} (${prop.rows[0].address})`,
        property_id: pid,
        aliases_taught: labels.length,
        note: "every identity label seen in this deal now resolves to the new property",
      });
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      res.status(500).json({ error: e.message });
    } finally { client.release(); }
  });

  // rename a deal — POST /deal-intakes/:id/name { deal_name }
  router.post("/deal-intakes/:id/name", async (req, res) => {
    const { deal_name } = req.body || {};
    if (!deal_name || !String(deal_name).trim()) return res.status(400).json({ error: "deal_name required" });
    try {
      const r = await pool.query(
        "update deal_intakes set deal_name=$1, updated_at=now() where id=$2 returning id, deal_name",
        [String(deal_name).trim(), req.params.id]);
      if (r.rows.length === 0) return res.status(404).json({ error: "intake not found" });
      res.json(r.rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ══════════════════════════════════════════════════════════════════
  //  THE FUNNEL BOARD — GET /deal-funnel  (migration 024)
  //
  //  Every deal on one board: what arrived, what's missing, whether the
  //  property is recognized, where the rent roll stands, and the single
  //  next action. READ-ONLY — the board derives, it never mutates.
  //  Honest by construction: a deal with no rent roll says MISSING in
  //  its headline; identity ambiguity is surfaced per deal, never
  //  resolved by guess. Uses the SAME summarize() as /summary, so the
  //  per-deal view and the board can never tell different stories.
  // ══════════════════════════════════════════════════════════════════
  router.get("/deal-funnel", async (_req, res) => {
    try {
      const intakes = (await pool.query(
        "select * from deal_intakes order by created_at desc limit 50")).rows;
      const allFiles = intakes.length ? (await pool.query(
        "select * from deal_intake_files where intake_id = any($1) order by created_at",
        [intakes.map(i => i.id)])).rows : [];
      const byIntake = {};
      for (const f of allFiles) (byIntake[f.intake_id] = byIntake[f.intake_id] || []).push(f);

      const deals = intakes.map(i => {
        const files = byIntake[i.id] || [];
        const s = summarize(files);
        // the ONE next action — the funnel's whole point is "what now?"
        let next;
        if (files.length === 0) next = { action: "upload_files", note: "Nothing uploaded yet — drop the deal folder." };
        else if (s.identity.status === "ambiguous") next = { action: "resolve_identity", note: `"${s.identity.label}" matches more than one property — needs a human call.` };
        else if (s.rent_roll_state === "missing") next = { action: "upload_missing", note: "Upload: Rent roll (the required gate — nothing onboards without it)." };
        else if (s.identity.status === "unknown") next = { action: "create_or_link_property", note: `"${s.identity.label}" is not a recognized property — link or create it.` };
        else if (s.identity.status === "no_identity_found") next = { action: "identify", note: "No property string found in any file yet — upload an identity-bearing doc (rent roll, T12, OM)." };
        else if (s.rent_roll_state === "uploaded") next = { action: "run_rentroll", file_id: s.rentRollFile.id, property_id: s.identity.property_id, note: "Rent roll + recognized property — run it through ingest." };
        else if (s.missing.length) next = { action: "upload_missing", note: `Upload: ${s.missing.join(", ")}` };
        else next = { action: "review_candidates", note: "Rent roll ingested — review and promote candidates." };

        return {
          intake_id: i.id,
          deal_name: i.deal_name || "(unnamed deal)",
          onboarding_type: i.onboarding_type,
          created_at: i.created_at,
          files: files.length,
          unclassified: s.unknownCount,
          identity: s.identity,
          confidence: s.conf.level,
          rent_roll: s.rent_roll_state,
          found: s.found,
          missing: s.missing,
          next,
        };
      });

      // funnel totals — counts, never a blended score
      const stage = d =>
        d.files === 0 ? "empty"
        : d.rent_roll === "missing" ? "no_rent_roll"
        : d.identity.status !== "resolved" ? "identity_open"
        : d.rent_roll === "uploaded" ? "ready_to_ingest"
        : "ingested";
      const stages = {};
      for (const d of deals) stages[stage(d)] = (stages[stage(d)] || 0) + 1;

      res.json({
        deals: deals.length,
        stages,
        board: deals,
        note: "READ-ONLY. Stages are honest counts, never blended: empty → no_rent_roll → identity_open → ready_to_ingest → ingested. The rent roll is the gate; identity resolves per file through the registry, never from the deal name.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // recent intakes
  router.get("/deal-intakes", async (_req, res) => {
    try {
      const r = await pool.query(
        `select i.*, count(f.id)::int as file_count
           from deal_intakes i left join deal_intake_files f on f.intake_id=i.id
          group by i.id order by i.created_at desc limit 25`
      );
      res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
