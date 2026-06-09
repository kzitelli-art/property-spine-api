// ════════════════════════════════════════════════════════════════════
//  PUBLIC RENT-ROLL REVIEW — a sharable testing link.
//
//  PURPOSE: send a link, let real people upload real rent rolls, capture their
//  corrections, make the PARSER smarter — WITHOUT ever touching live NOI or
//  supported revenue.
//
//  THE WALL (structural, not policy):
//    - This module takes NO property id and NEVER calls runIngest.
//    - It writes ONLY to public_upload_sessions / public_rent_roll_feedback /
//      mapping_memory (migration 013) — none of which reference properties or
//      ingest_candidates.
//    - It therefore CANNOT create candidates, promote, or create supported
//      revenue. Supported revenue still requires the normal promotion gate.
//    - mapping_memory is the only thing that could later inform live parsing,
//      and it is captured here but NOT wired to the live parser in this build
//      (the "hold off" decision). Wiring it in is a deliberate later step.
//
//  GATE: a shared password (PUBLIC_REVIEW_PASSWORD env var). Checked on every
//  write route. No login, no accounts — just a key Kameron hands out.
//
//  Mount in server.js (near the other mounts). It needs the SAME extraction
//  pieces the live ingest uses, passed in as deps so it reuses them verbatim:
//    const publicReview = require("./public_review");
//    app.use("/", publicReview({ pool, anthropic, INGEST_MODEL, fileToText, ingestPrompt, upload }));
// ════════════════════════════════════════════════════════════════════

module.exports = function publicReview(deps) {
  const express = require("express");
  const router = express.Router();
  const { pool, anthropic, INGEST_MODEL, fileToText, ingestPrompt, upload } = deps;

  if (!pool) throw new Error("public_review requires a pool");
  if (!anthropic) throw new Error("public_review requires the anthropic client");
  if (!fileToText) throw new Error("public_review requires fileToText");
  if (!ingestPrompt) throw new Error("public_review requires ingestPrompt");
  if (!upload) throw new Error("public_review requires the multer upload instance");

  const PASSWORD = process.env.PUBLIC_REVIEW_PASSWORD || null;

  // Moderate size cap for the public route: 10 MB (tighter than the 25 MB live
  // cap — public files are rent rolls, not giant OMs, and this limits API cost).
  const PUBLIC_MAX_BYTES = 10 * 1024 * 1024;

  // ── password check (shared secret, sent as header or field) ──
  function checkPassword(req, res) {
    if (!PASSWORD) {
      res.status(503).json({ error: "Public review is not configured (no password set). Set PUBLIC_REVIEW_PASSWORD." });
      return false;
    }
    const given = req.get("x-review-password") || (req.body && req.body.password) || req.query.password;
    if (given !== PASSWORD) {
      res.status(401).json({ error: "Wrong or missing password." });
      return false;
    }
    return true;
  }

  // ── format signature: a stable fingerprint of the file's shape ──
  // Built from detected_system + the sorted top header tokens, so two files in
  // the same layout produce the same signature (the key mapping_memory uses).
  function formatSignature(detectedSystem, sourceText) {
    const firstLines = (sourceText || "").split("\n").slice(0, 25).join(" ");
    const tokens = (firstLines.match(/[A-Za-z][A-Za-z /]{2,}/g) || [])
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length >= 3);
    const top = Array.from(new Set(tokens)).sort().slice(0, 12).join("|");
    return `${detectedSystem || "unknown"}::${top}`;
  }

  // ── parse a file to the extraction result, WITHOUT writing candidates ──
  async function parseOnly(sourceText) {
    const ai = await anthropic.messages.create({
      model: INGEST_MODEL,
      max_tokens: parseInt(process.env.MAX_INGEST_TOKENS, 10) || 64000,
      messages: [{ role: "user", content: ingestPrompt(sourceText) }],
    });
    if (ai.stop_reason === "max_tokens") {
      const err = new Error("This file is too large for single-pass extraction. Try a smaller rent roll or paste the table text.");
      err.truncated = true;
      throw err;
    }
    const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const raw = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const err = new Error("The parser returned output we couldn't read. Try re-uploading, or paste the table text.");
      err.unparseable = true;
      throw err;
    }
    return parsed;
  }

  // Flatten the extraction to a simple row list for the grading UI (single OR deal).
  function flattenRows(parsed) {
    const out = [];
    const pushUnit = (u, addr) => out.push({
      property_address: addr || null,
      unit_number: u.unit_number ?? null,
      bedrooms: u.bedrooms ?? null,
      market_rent: u.market_rent ?? null,
      actual_rent: u.actual_rent ?? null,
      status: u.status ?? null,
      tenant_name: u.tenant_name ?? null,
      lease_start: u.lease_start ?? null,
      lease_end: u.lease_end ?? null,
      prov: u.prov ?? null,
    });
    if (Array.isArray(parsed.subject_properties)) {
      for (const sp of parsed.subject_properties) {
        const addr = sp.address || sp.name || null;
        for (const u of (sp.units || [])) pushUnit(u, addr);
      }
    } else {
      for (const u of (parsed.units || [])) pushUnit(u, null);
    }
    return out;
  }

  // multer wrapper with the tighter public cap
  const publicUpload = upload.single("file");

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 1: PARSE — upload a file, get the extraction back. No DB write to
  //  candidates. Saves a public_upload_sessions row and returns its id.
  // ════════════════════════════════════════════════════════════════
  router.post("/public/rent-roll/parse", (req, res, next) => {
    publicUpload(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "File too large — keep it under 10 MB. For a big image PDF, export the table to Excel/CSV or paste the text." });
        }
        return res.status(400).json({ error: "Upload failed: " + err.message });
      }
      next();
    });
  }, async (req, res) => {
    if (!checkPassword(req, res)) return;
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')." });

    // Enforce the tighter public cap explicitly (the shared multer cap is 25 MB).
    if (req.file.size > PUBLIC_MAX_BYTES) {
      return res.status(413).json({ error: "File too large — keep it under 10 MB." });
    }

    try {
      let text;
      try { text = await fileToText(req.file); }
      catch { return res.status(400).json({ error: "Couldn't read that file. Supported: .xlsx .xls .csv .pdf .docx .doc .txt" }); }

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "The file had no readable text. If it's a scanned/photo PDF, paste the table or upload an Excel/CSV instead." });
      }

      const parsed = await parseOnly(text);
      const rows = flattenRows(parsed);
      const detectedSystem = parsed.detected_system || "unknown";
      const signature = formatSignature(detectedSystem, text);

      const session = await pool.query(
        `insert into public_upload_sessions
           (uploader_name, uploader_email, source_filename, detected_system,
            format_signature, level_reached, raw_extraction, extracted_row_count)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id, created_at`,
        [
          req.body.uploader_name || null,
          req.body.uploader_email || null,
          req.file.originalname || null,
          detectedSystem,
          signature,
          parsed.level_reached || null,
          parsed,
          rows.length,
        ]
      );

      res.json({
        session_id: session.rows[0].id,
        detected_system: detectedSystem,
        level_reached: parsed.level_reached || null,
        format_signature: signature,
        row_count: rows.length,
        rows,
        unclear: Array.isArray(parsed.unclear) ? parsed.unclear : [],
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        note: "This is a parse-only preview. Nothing here affects any live property, NOI, or supported revenue.",
      });
    } catch (e) {
      if (e.truncated) return res.status(413).json({ error: e.message });
      if (e.unparseable) return res.status(502).json({ error: e.message });
      console.error("public parse error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 2: FEEDBACK — grade + corrections for a session. Saves feedback and
  //  records HUMAN-corrected mappings into mapping_memory (corrected_by_human).
  //  mapping_memory is captured but NOT wired to the live parser in this build.
  // ════════════════════════════════════════════════════════════════
  router.post("/public/rent-roll/feedback", express.json({ limit: "2mb" }), async (req, res) => {
    if (!checkPassword(req, res)) return;
    const { session_id, rating, corrected_mappings, corrected_rows, notes } = req.body || {};
    if (!session_id) return res.status(400).json({ error: "session_id is required." });
    if (rating && !["accurate", "partial", "wrong"].includes(rating)) {
      return res.status(400).json({ error: "rating must be accurate, partial, or wrong." });
    }

    try {
      const sess = await pool.query(
        "select id, format_signature from public_upload_sessions where id=$1",
        [session_id]
      );
      if (!sess.rows.length) return res.status(404).json({ error: "session not found." });
      const signature = sess.rows[0].format_signature;

      const fb = await pool.query(
        `insert into public_rent_roll_feedback
           (session_id, rating, corrected_mappings, corrected_rows, notes)
         values ($1,$2,$3,$4,$5) returning id, created_at`,
        [session_id, rating || null, corrected_mappings || null, corrected_rows || null, notes || null]
      );

      // Record human-corrected column mappings into mapping_memory (high trust).
      // Upsert: reinforce times_seen if the same mapping is seen again.
      let learned = 0;
      if (corrected_mappings && typeof corrected_mappings === "object") {
        for (const [sourceCol, canonicalField] of Object.entries(corrected_mappings)) {
          if (!sourceCol || !canonicalField) continue;
          await pool.query(
            `insert into mapping_memory
               (format_signature, source_column, canonical_field, corrected_by_human, confidence, times_seen, last_seen_at)
             values ($1,$2,$3,true,1.0,1,now())
             on conflict (format_signature, source_column, canonical_field) do update set
               corrected_by_human = true,
               times_seen = mapping_memory.times_seen + 1,
               last_seen_at = now()`,
            [signature, String(sourceCol), String(canonicalField)]
          );
          learned += 1;
        }
      }

      res.json({
        feedback_id: fb.rows[0].id,
        learned_mappings: learned,
        note: "Thanks — saved. Corrections are stored as training data only. They do not affect any live property or revenue.",
      });
    } catch (e) {
      console.error("public feedback error", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  ROUTE 3: ADMIN — uploads, scores, corrections, accuracy over time.
  //  Password-gated (same shared secret). Read-only.
  // ════════════════════════════════════════════════════════════════
  router.get("/public/rent-roll/admin", async (req, res) => {
    if (!checkPassword(req, res)) return;
    try {
      const sessions = (await pool.query(
        `select s.id, s.uploader_name, s.uploader_email, s.source_filename,
                s.detected_system, s.format_signature, s.level_reached,
                s.extracted_row_count, s.created_at,
                f.rating, f.notes, f.created_at as feedback_at
           from public_upload_sessions s
           left join public_rent_roll_feedback f on f.session_id = s.id
          order by s.created_at desc
          limit 200`
      )).rows;

      const ratingCounts = (await pool.query(
        `select coalesce(rating,'(ungraded)') as rating, count(*)::int as n
           from public_rent_roll_feedback group by rating`
      )).rows;

      const mappings = (await pool.query(
        `select format_signature, source_column, canonical_field,
                corrected_by_human, times_seen, last_seen_at
           from mapping_memory
          order by last_seen_at desc
          limit 200`
      )).rows;

      const totals = (await pool.query(
        `select
           (select count(*)::int from public_upload_sessions) as total_uploads,
           (select count(*)::int from public_rent_roll_feedback) as total_feedback,
           (select count(*)::int from mapping_memory) as total_learned_mappings`
      )).rows[0];

      res.json({ totals, rating_breakdown: ratingCounts, sessions, learned_mappings: mappings });
    } catch (e) {
      console.error("public admin error", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
