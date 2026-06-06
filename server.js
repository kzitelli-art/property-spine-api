// ════════════════════════════════════════════════════════════════════
//  PROPERTY SPINE — API server v1
//  Intentionally tiny. Two real endpoints prove the round trip:
//    POST /properties  → create a property
//    GET  /properties  → read them back
//    GET  /health      → is the server + db alive
//  Every other endpoint later is THIS pattern repeated.
// ════════════════════════════════════════════════════════════════════
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Anthropic = require("@anthropic-ai/sdk");
const multer = require("multer");          // handles file uploads (rent roll .xlsx/.csv)
const XLSX = require("xlsx");              // parses the spreadsheet to rows

// uploads held in memory (small files); 5mb cap so a huge file can't choke us
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// The AI client. ANTHROPIC_API_KEY is set as an environment variable in
// Render — never hardcoded. This is the "rent the model" piece: the model
// lives at Anthropic; our server calls it and feeds it our data.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());            // lets the frontend (Netlify) call this API
app.use(express.json({ limit: "1mb" }));  // body-size cap — stops oversized payloads

// ── lightweight shared-key auth ──────────────────────────────────────
// NOT full auth (that's the later raise+hire phase: real users, org scoping,
// rate limits). This is the cheap floor: if API_KEY is set in Render, every
// request must send it as `x-api-key`. /health stays open so uptime checks
// work. If API_KEY is unset, the gate is open (local dev convenience).
const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  if (!API_KEY) return next();  // no key configured → open (dev)
  if (req.get("x-api-key") === API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// The database connection. DATABASE_URL is set as an environment variable
// in Render — NEVER hardcoded here. Neon requires SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── health: confirms server is up AND can reach the database ──
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("select now() as time");
    res.json({ ok: true, db_time: r.rows[0].time });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── create a property ──
app.post("/properties", async (req, res) => {
  const { name, address, city, state, zip, property_type } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const r = await pool.query(
      `insert into properties (name, address, city, state, zip, property_type)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [name, address || null, city || null, state || null, zip || null, property_type || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── read all properties back ──
app.get("/properties", async (_req, res) => {
  try {
    const r = await pool.query("select * from properties order by created_at desc");
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── read one property (with its units) ──
app.get("/properties/:id", async (req, res) => {
  try {
    const p = await pool.query("select * from properties where id=$1", [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ error: "not found" });
    const units = await pool.query("select * from units where property_id=$1", [req.params.id]);
    res.json({ ...p.rows[0], units: units.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  UNITS — same pattern as properties, attached to a property_id.
//  Creating a unit auto-creates its Space (the database trigger does it),
//  so the "lease attaches to a space, never a unit" invariant protects itself.
// ════════════════════════════════════════════════════════════════════

// ── create a unit under a property ──
app.post("/properties/:propertyId/units", async (req, res) => {
  const { unit_number, bedrooms, bathrooms, square_feet, market_rent } = req.body || {};
  if (!unit_number) return res.status(400).json({ error: "unit_number is required" });
  try {
    // make sure the property exists first (clear error beats a confusing one)
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    const r = await pool.query(
      `insert into units (property_id, unit_number, bedrooms, bathrooms, square_feet, market_rent)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [req.params.propertyId, unit_number, bedrooms ?? null, bathrooms ?? null,
       square_feet ?? null, market_rent ?? null]
    );
    const unit = r.rows[0];
    // read back the space the trigger just created, so the response proves the invariant
    const spaces = await pool.query("select * from spaces where unit_id=$1", [unit.id]);
    res.status(201).json({ ...unit, spaces: spaces.rows });
  } catch (e) {
    // 23505 = unique_violation (the uq_unit_per_property constraint)
    if (e.code === "23505") {
      return res.status(409).json({ error: "a unit with that number already exists for this property" });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── list units for a property ──
app.get("/properties/:propertyId/units", async (req, res) => {
  try {
    const r = await pool.query(
      "select * from units where property_id=$1 order by unit_number",
      [req.params.propertyId]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  PERSONS — the durable human record.
//  A person is created the moment they first make contact (an inquiry) and
//  is NEVER replaced. Their lifecycle_status moves lead → applicant →
//  tenant → past; the row persists through all of it. This is what lets
//  management see the WHOLE funnel — including the inquiry leads that never
//  toured — which is the raw material for marketing-spend decisions.
//
//  Two things this block deliberately does, beyond plain CRUD:
//   1. Validates lifecycle transitions (you can't skip lead→past by typo).
//   2. Writes a real EVENT on every status change, so time-to-stage and
//      funnel conversion are computable later from the event log. The
//      engine's rule — "events are real" — holds even in the pre-tour,
//      agent-invisible phase.
//
//  Paste this block into server.js AFTER the units endpoints and BEFORE
//  the "AI INGESTION" section. It uses the same `pool`, same conventions.
// ════════════════════════════════════════════════════════════════════

// The allowed lifecycle states, in order. Index position lets us reason
// about "forward" vs "backward" moves without hardcoding pairs.
const LIFECYCLE = ["lead", "applicant", "tenant", "past"];

// Which transitions are legal. Forward-by-one is the normal path. We also
// allow a few real-world moves that aren't strictly +1:
//   • any → past  (a person can drop out / move out from any stage)
//   • tenant → past and applicant → past are the common ones
// We do NOT allow skipping forward (lead → tenant) — that hides the funnel.
// Going backward (tenant → lead) is blocked: it would corrupt analytics and
// usually means a data error, not a real event.
function transitionAllowed(from, to) {
  if (from === to) return true;                 // no-op update is fine
  if (to === "past") return true;               // anyone can exit to past
  const fi = LIFECYCLE.indexOf(from);
  const ti = LIFECYCLE.indexOf(to);
  if (fi === -1 || ti === -1) return false;     // unknown status
  return ti === fi + 1;                          // only forward by exactly one
}

// ── create a person (this is what an inquiry creates) ──
// property_id and source are the analytics-critical fields. `source` is the
// marketing channel (zillow, apartments.com, walk_in, referral, ...) — the
// field the PM/leasing manager reads to decide where the dollars go.
// lifecycle_status defaults to 'lead'; you normally don't pass it on create.
app.post("/persons", async (req, res) => {
  const {
    name, email, phone, source,
    property_id, interested_unit_id,
    lifecycle_status,            // optional; defaults to 'lead' in the DB
  } = req.body || {};

  // A lead with no way to reach them and no name is just noise. Require at
  // least one identifying/contact field so the record is actually useful.
  if (!name && !email && !phone) {
    return res.status(400).json({ error: "a person needs at least one of: name, email, phone" });
  }

  // If a status was passed on create, it must be a real one.
  if (lifecycle_status && !LIFECYCLE.includes(lifecycle_status)) {
    return res.status(400).json({ error: `lifecycle_status must be one of: ${LIFECYCLE.join(", ")}` });
  }

  try {
    // If a property was named, confirm it exists (clear error beats a vague FK error).
    if (property_id) {
      const prop = await pool.query("select id from properties where id=$1", [property_id]);
      if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });
    }
    // Same for an interested unit, if supplied.
    if (interested_unit_id) {
      const u = await pool.query("select id from units where id=$1", [interested_unit_id]);
      if (u.rows.length === 0) return res.status(404).json({ error: "interested_unit_id not found" });
    }

    const r = await pool.query(
      `insert into persons
         (name, email, phone, source, lifecycle_status, leasing_stage, interested_unit_id)
       values ($1,$2,$3,$4, coalesce($5,'lead'), coalesce($5,'lead'), $6)
       returning *`,
      [name ?? null, email ?? null, phone ?? null, source ?? null,
       lifecycle_status ?? null, interested_unit_id ?? null]
    );
    const person = r.rows[0];

    // Write the inquiry as a real EVENT. This is agent-invisible (it spawns
    // no human obligation) but management-visible: it's the first datapoint
    // in this person's funnel and the anchor for "time to first response".
    await pool.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,'inquiry',$4)`,
      [property_id ?? null, person.id, interested_unit_id ?? null,
       source ? `inquiry via ${source}` : "inquiry"]
    );

    res.status(201).json(person);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── list persons (with light filtering for the management views) ──
// Optional query params, all filters are additive:
//   ?lifecycle_status=lead     → just leads (the agent's world starts later)
//   ?source=zillow             → conversion-by-source analysis
//   ?property_id=<uuid>        → scope to one property
// Newest first, so a review screen shows fresh inquiries on top.
app.get("/persons", async (req, res) => {
  const { lifecycle_status, source, property_id } = req.query;
  try {
    const where = [];
    const vals = [];
    if (lifecycle_status) { vals.push(lifecycle_status); where.push(`lifecycle_status = $${vals.length}`); }
    if (source)           { vals.push(source);           where.push(`source = $${vals.length}`); }
    if (property_id)      { vals.push(property_id);      where.push(`id in (select person_id from events where property_id = $${vals.length})`); }
    const sql =
      "select * from persons" +
      (where.length ? " where " + where.join(" and ") : "") +
      " order by created_at desc";
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── read one person (with their event history — the funnel trail) ──
app.get("/persons/:id", async (req, res) => {
  try {
    const p = await pool.query("select * from persons where id=$1", [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ error: "not found" });
    const events = await pool.query(
      "select * from events where person_id=$1 order by occurred_at",
      [req.params.id]
    );
    res.json({ ...p.rows[0], events: events.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── update a person ──
// Durable record: this NEVER deletes and recreates. It edits in place.
// Editable fields: contact info, source, interested unit, and — carefully —
// lifecycle_status, which must pass transitionAllowed(). A legal status
// change writes a real EVENT (e.g. lead→applicant) so the funnel is measurable.
app.patch("/persons/:id", async (req, res) => {
  const {
    name, email, phone, source,
    interested_unit_id, lifecycle_status, leasing_stage,
  } = req.body || {};

  try {
    const cur = await pool.query("select * from persons where id=$1", [req.params.id]);
    if (cur.rows.length === 0) return res.status(404).json({ error: "not found" });
    const person = cur.rows[0];

    // Validate a lifecycle change before touching anything.
    let statusChanged = false;
    if (lifecycle_status !== undefined && lifecycle_status !== person.lifecycle_status) {
      if (!LIFECYCLE.includes(lifecycle_status)) {
        return res.status(400).json({ error: `lifecycle_status must be one of: ${LIFECYCLE.join(", ")}` });
      }
      if (!transitionAllowed(person.lifecycle_status, lifecycle_status)) {
        return res.status(409).json({
          error: `illegal transition ${person.lifecycle_status} → ${lifecycle_status}. ` +
                 `Allowed: forward one step (${LIFECYCLE.join(" → ")}), or any → past.`,
        });
      }
      statusChanged = true;
    }

    // If an interested unit is being set, confirm it exists.
    if (interested_unit_id) {
      const u = await pool.query("select id from units where id=$1", [interested_unit_id]);
      if (u.rows.length === 0) return res.status(404).json({ error: "interested_unit_id not found" });
    }

    // Build a partial update — only the fields actually supplied change.
    // `coalesce(new, old)` keeps existing values when a field is omitted.
    const r = await pool.query(
      `update persons set
         name              = coalesce($1, name),
         email             = coalesce($2, email),
         phone             = coalesce($3, phone),
         source            = coalesce($4, source),
         interested_unit_id= coalesce($5, interested_unit_id),
         lifecycle_status  = coalesce($6, lifecycle_status),
         leasing_stage     = coalesce($7, leasing_stage),
         updated_at        = now()
       where id=$8
       returning *`,
      [name ?? null, email ?? null, phone ?? null, source ?? null,
       interested_unit_id ?? null, lifecycle_status ?? null, leasing_stage ?? null,
       req.params.id]
    );
    const updated = r.rows[0];

    // A status change is a real event in this person's funnel. Record it.
    if (statusChanged) {
      await pool.query(
        `insert into events (person_id, type, note)
         values ($1,'lifecycle_change',$2)`,
        [updated.id, `${person.lifecycle_status} → ${updated.lifecycle_status}`]
      );
    }

    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  AI INGESTION — staged + auditable. The trust layer made honest.
//  Paste a messy rent roll → the AI extracts rows → NOTHING writes straight
//  into `units`. Instead we persist:
//    • one ingest_run  — the raw input, the model's raw output, the model id
//    • N ingest_candidates — each extracted row + its AI provenance, held
//      for review at decision_status='pending'
//  A separate /promote step turns an approved candidate into a real unit in
//  an EXPLICIT, recorded transition (promoted_unit_id/at/by). If the system
//  ever says "confirmed", there is now a record of what was confirmed,
//  against what input, by which model, and who promoted it.
//
//  Model id lives in the INGEST_MODEL env var (set in Render) so the working
//  string is config, not code — change it without a redeploy of logic.
// ════════════════════════════════════════════════════════════════════
const INGEST_MODEL = process.env.INGEST_MODEL || "claude-sonnet-4-5";

// ── the prompt. Handles both pasted lines AND flattened spreadsheet rows ──
// (Yardi/AppFolio exports have section dividers like "Unit Type: Studio",
//  multi-column rows, status + resident columns. The model is told to read
//  bedrooms from the unit-type section when the row itself doesn't say.)
function ingestPrompt(text) {
  return `You are reading a property rent roll. It may be pasted text OR rows flattened from a spreadsheet export (Yardi/AppFolio style). Extract the residential units into JSON.

For each unit return:
- unit_number (string, required) — the Bldg-Unit or unit id
- bedrooms (number or null) — if the row sits under a section like "Unit Type: Studio" use 0; "1x1" = 1; "2x2" = 2; "3x2"/"3 Bed" = 3; if truly unknown, null
- market_rent (number or null) — the Market Rent column if present, else the scheduled/actual rent
- prov: "confirmed" or "assumed" (see the rule below — be precise about this)
- note: short reason only if prov is "assumed" or unclear (else "")

How to set prov — this matters:
- "confirmed" = the row is clear and the values are read directly, INCLUDING bedrooms taken from a clear "Unit Type:" section header. In a grouped rent roll, the section header IS the source of truth for bedrooms — reading "101 is a studio" because it sits under "Unit Type: Studio" is a direct read, NOT a guess. A normal unit with a clear number, a section-header bedroom count, and a rent column is CONFIRMED.
- "assumed" = reserve this for genuine ambiguity, e.g.: bedrooms truly unknown (no section header), no rent figure anywhere, a non-residential or model/placeholder unit (resident like "Model"), a unit number that doesn't cleanly parse, or conflicting values.
- Do NOT mark a unit "assumed" merely because bedrooms came from the section header. That is the expected, reliable case.

Rules:
- Only include actual residential units. Ignore titles, column headers, "Unit Type:" divider lines, subtotals, totals (any line containing "Total"), parameter/metadata rows, and blank lines.
- Parking spots, storage, retail, and amenity lines are NOT residential units — put their raw line in "unclear".
- If you cannot tell whether a row is a unit, do NOT invent it — put the raw line in "unclear".
- Never guess a unit_number. No clear unit number → "unclear".

Return ONLY valid JSON, no prose, in this exact shape:
{"units":[{"unit_number":"","bedrooms":null,"market_rent":null,"prov":"confirmed","note":""}],"unclear":["raw line that couldn't be parsed"]}

Rent roll:
"""
${text}
"""`;
}

// ── SHARED INGEST PIPELINE ────────────────────────────────────────────
// Both the text endpoint and the file endpoint call this. The trust logic
// (model call → parse → persist run → stage candidates) lives ONCE, here,
// so file upload inherits the exact same staging/provenance behavior.
async function runIngest(propertyId, sourceText, kind) {
  const ai = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: 8000,                       // bigger: real rolls have 100+ units
    messages: [{ role: "user", content: ingestPrompt(sourceText) }],
  });

  const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  let raw = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { const err = new Error("AI returned unparseable output"); err.raw = rawOutput; err.unparseable = true; throw err; }

  const units = Array.isArray(parsed.units) ? parsed.units : [];
  const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];

  // Persist the run — verbatim input, raw model output, model id (provenance anchor).
  const runRes = await pool.query(
    `insert into ingest_runs
       (property_id, kind, source_text, model_id, model_raw_output, candidate_count, unclear)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [propertyId, kind, sourceText, INGEST_MODEL, rawOutput, units.length, unclear]
  );
  const run = runRes.rows[0];

  // Stage every row as a candidate. NOTHING promoted here.
  const candidates = [];
  for (const u of units) {
    const hasNumber = !!u.unit_number;
    const prov = (u.prov === "confirmed" && hasNumber) ? "confirmed" : "assumed";
    const decision = (prov === "confirmed") ? "approved" : "pending";
    const note = !hasNumber ? "no unit number" : (u.note || null);
    const c = await pool.query(
      `insert into ingest_candidates
         (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [run.id, propertyId, hasNumber ? String(u.unit_number) : null,
       u.bedrooms ?? null, u.market_rent ?? null, prov, note, decision]
    );
    candidates.push(c.rows[0]);
  }

  return {
    run_id: run.id,
    candidate_count: candidates.length,
    approved: candidates.filter(c => c.decision_status === "approved"),
    needs_review: candidates.filter(c => c.decision_status === "pending"),
    unclear,
    note: "Nothing was written to units. Review, then POST /ingest/:runId/promote to create units.",
  };
}

// ── ingest from pasted TEXT ──
app.post("/properties/:propertyId/ingest", async (req, res) => {
  const { rent_roll_text } = req.body || {};
  if (!rent_roll_text) return res.status(400).json({ error: "rent_roll_text is required" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });
    const result = await runIngest(req.params.propertyId, rent_roll_text, "rent_roll");
    res.json(result);
  } catch (e) {
    if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
    res.status(500).json({ error: e.message });
  }
});

// ── ingest from an uploaded FILE (.xlsx / .xls / .csv) ──
// The server reads the spreadsheet, flattens every sheet to plain rows, and
// feeds that text through the SAME pipeline. Same staging, same provenance,
// same promote step — the only new thing is turning a file into text first.
app.post("/properties/:propertyId/ingest-file", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file uploaded (field name must be 'file')" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    // Parse the workbook from the uploaded bytes. Flatten each sheet to TSV-ish
    // text so the model sees rows the way a human reading the file would.
    let wb;
    try { wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true }); }
    catch { return res.status(400).json({ error: "could not read file — is it a valid .xlsx/.xls/.csv?" }); }

    let flat = "";
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, raw: false });
      flat += `### SHEET: ${sheetName}\n`;
      for (const row of rows) {
        const line = (row || []).map(c => (c == null ? "" : String(c))).join("\t").trim();
        if (line) flat += line + "\n";
      }
      flat += "\n";
    }

    if (!flat.trim()) return res.status(400).json({ error: "file parsed but contained no rows" });

    const result = await runIngest(req.params.propertyId, flat, "rent_roll_file");
    res.json({ ...result, source_filename: req.file.originalname });
  } catch (e) {
    if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
    res.status(500).json({ error: e.message });
  }
});

// ── read a run's candidates back (for the review screen) ──
app.get("/ingest/:runId", async (req, res) => {
  try {
    const run = await pool.query("select * from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const cands = await pool.query(
      "select * from ingest_candidates where run_id=$1 order by created_at", [req.params.runId]
    );
    res.json({ ...run.rows[0], candidates: cands.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  PROMOTE — the explicit transition. An approved candidate becomes a real
//  unit, and we RECORD the transition on the candidate: promoted_unit_id,
//  promoted_at, promoted_by, decision_status='promoted'. This is the
//  "Completed Record" end of the loop, applied to ingestion.
//  Promotes only candidates whose decision_status='approved'. Pending/rejected
//  are skipped (a human must approve them first). The unique constraint on
//  units means a re-run that duplicates a number is caught, not silently doubled.
// ════════════════════════════════════════════════════════════════════
app.post("/ingest/:runId/promote", async (req, res) => {
  const { promoted_by } = req.body || {};  // optional user id; nullable for now
  try {
    const run = await pool.query("select id, property_id from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const propertyId = run.rows[0].property_id;

    const approved = await pool.query(
      "select * from ingest_candidates where run_id=$1 and decision_status='approved'",
      [req.params.runId]
    );

    const promoted = [];
    const skipped = [];
    for (const c of approved.rows) {
      try {
        const u = await pool.query(
          `insert into units (property_id, unit_number, bedrooms, market_rent)
           values ($1,$2,$3,$4) returning *`,
          [propertyId, c.unit_number, c.bedrooms ?? null, c.market_rent ?? null]
        );
        const unit = u.rows[0];  // its space auto-creates via the trigger
        // record the transition on the candidate — explicit, not implied
        await pool.query(
          `update ingest_candidates
             set decision_status='promoted', promoted_unit_id=$1,
                 promoted_at=now(), promoted_by=$2
           where id=$3`,
          [unit.id, promoted_by ?? null, c.id]
        );
        promoted.push({ candidate_id: c.id, unit });
      } catch (e) {
        // duplicate unit_number (23505) or other — skip, don't fail the batch
        skipped.push({ candidate_id: c.id, unit_number: c.unit_number,
          reason: e.code === "23505" ? "unit already exists" : e.message });
      }
    }

    res.json({ promoted_count: promoted.length, promoted, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  BULK APPROVE — flip a run's pending candidates to 'approved' in one call,
//  so a human can clear a reviewed batch at once instead of one at a time.
//  This is still a recorded human decision: reviewed_by/reviewed_at are set.
//  It does NOT create units — the explicit /promote step still does that, so
//  the approve→promote separation (and its audit trail) stays intact.
//  Optional body: { candidate_ids: [...] } to approve only specific ones;
//  omit it to approve ALL pending candidates in the run.
// ════════════════════════════════════════════════════════════════════
app.post("/ingest/:runId/approve", async (req, res) => {
  const { reviewed_by, candidate_ids } = req.body || {};  // both optional
  try {
    const run = await pool.query("select id from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });

    let result;
    if (Array.isArray(candidate_ids) && candidate_ids.length) {
      // approve only the named candidates (that are still pending) in this run
      result = await pool.query(
        `update ingest_candidates
           set decision_status='approved', reviewed_by=$1, reviewed_at=now()
         where run_id=$2 and decision_status='pending' and id = any($3::uuid[])
         returning id`,
        [reviewed_by ?? null, req.params.runId, candidate_ids]
      );
    } else {
      // approve ALL pending candidates in this run
      result = await pool.query(
        `update ingest_candidates
           set decision_status='approved', reviewed_by=$1, reviewed_at=now()
         where run_id=$2 and decision_status='pending'
         returning id`,
        [reviewed_by ?? null, req.params.runId]
      );
    }

    res.json({
      approved_count: result.rows.length,
      note: "Approved (recorded as a human decision). Now POST /ingest/:runId/promote to create units.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Property Spine API listening on ${port}`));
