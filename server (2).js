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

// The AI client. ANTHROPIC_API_KEY is set as an environment variable in
// Render — never hardcoded. This is the "rent the model" piece: the model
// lives at Anthropic; our server calls it and feeds it our data.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());            // lets the frontend (Netlify) call this API
app.use(express.json());

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
      [req.params.propertyId, unit_number, bedrooms || null, bathrooms || null,
       square_feet || null, market_rent || null]
    );
    const unit = r.rows[0];
    // read back the space the trigger just created, so the response proves the invariant
    const spaces = await pool.query("select * from spaces where unit_id=$1", [unit.id]);
    res.status(201).json({ ...unit, spaces: spaces.rows });
  } catch (e) {
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
//  AI INGESTION — the judgment layer's first real job.
//  Paste a messy rent roll → the AI extracts units → server writes them.
//  Crucially: the AI marks each unit confirmed | assumed, and flags rows
//  it can't read. We auto-create the CONFIRMED ones; assumed/unclear come
//  back for a human to approve. AI reads & decides; it never silently guesses.
// ════════════════════════════════════════════════════════════════════
app.post("/properties/:propertyId/ingest", async (req, res) => {
  const { rent_roll_text } = req.body || {};
  if (!rent_roll_text) return res.status(400).json({ error: "rent_roll_text is required" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    // Ask the model to turn messy text into structured rows, with provenance.
    const prompt =
`You are reading a property rent roll. Extract the units into JSON.

For each unit return:
- unit_number (string, required)
- bedrooms (number or null)
- market_rent (number or null)
- prov: "confirmed" if the row is clear and complete, "assumed" if you had to guess or infer a value
- note: short reason only if prov is "assumed" or something is unclear (else "")

Rules:
- Only include rows that are actually units. Ignore totals, headers, blank lines.
- If you cannot tell whether a row is a unit, do NOT invent it — leave it out and add it to "unclear".
- Never guess a unit_number. If there's no clear unit number, it goes in "unclear".

Return ONLY valid JSON, no prose, in this exact shape:
{"units":[{"unit_number":"","bedrooms":null,"market_rent":null,"prov":"confirmed","note":""}],"unclear":["raw line that couldn't be parsed"]}

Rent roll:
"""
${rent_roll_text}
"""`;

    const ai = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    // Pull the text out and parse the JSON the model returned.
    let raw = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(); // strip fences if any
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(502).json({ error: "AI returned unparseable output", raw }); }

    const units = Array.isArray(parsed.units) ? parsed.units : [];
    const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];

    // Write the CONFIRMED units. Hold assumed/unclear for human review.
    const created = [];
    const needsReview = [];
    for (const u of units) {
      if (!u.unit_number) { needsReview.push({ ...u, why: "no unit number" }); continue; }
      if (u.prov === "assumed") { needsReview.push(u); continue; }
      const r = await pool.query(
        `insert into units (property_id, unit_number, bedrooms, market_rent)
         values ($1,$2,$3,$4) returning *`,
        [req.params.propertyId, String(u.unit_number), u.bedrooms ?? null, u.market_rent ?? null]
      );
      created.push(r.rows[0]); // its space auto-creates via the trigger
    }

    res.json({
      created_count: created.length,
      created,
      needs_review: needsReview,   // assumed values — human confirms before saving
      unclear,                     // lines the AI refused to guess on
    });
  } catch (e) {
    // Surface a clean message — e.g. missing/invalid API key shows here.
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Property Spine API listening on ${port}`));
