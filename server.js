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
         source            = coalesce($4::role_name, source),
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
});// ════════════════════════════════════════════════════════════════════
//  EVENTS + THE OBLIGATION ENGINE (first real link)
//
//  This is the load-bearing claim of the whole product: an obligation is
//  ONLY ever born from an event, server-side, in one atomic transaction.
//  There is deliberately NO "create obligation directly" endpoint — that
//  would let the front-end fake the engine. The only path to a tour
//  obligation is: a `tour_booked` event is written → the server spawns the
//  obligation in the SAME transaction. Event and obligation commit together
//  or not at all.
//
//  The agent-invisible / management-visible split holds here:
//   • an `inquiry` event spawns NO human obligation (AI-owned, pre-tour)
//   • a `tour_booked` event is the FIRST thing that creates a human
//     obligation — "a tour exists and someone must own it"
//
//  Paste this block into server.js AFTER the Persons endpoints and BEFORE
//  the "" section. Uses the same `pool` and conventions.
// ════════════════════════════════════════════════════════════════════

// How long a tour obligation sits before it's considered stale. Operator
// rule: 60 days, or immediately if the lead says they're out. At staleness
// the AI surfaces a "kill this lead?" prompt — but only the leasing agent
// can actually kill it. This is just the clock; the prompt/kill is later.
const TOUR_STALE_DAYS = 60;

// Resolve which property a person belongs to (from their earliest event that
// names one — normally the inquiry). Lets obligations/events carry property
// for management's by-property funnel slicing, even when the caller didn't
// pass it. Returns null if none found.
async function propertyForPerson(client, personId) {
  if (!personId) return null;
  const r = await client.query(
    `select property_id from events
      where person_id=$1 and property_id is not null
      order by occurred_at asc limit 1`,
    [personId]
  );
  return r.rows[0]?.property_id ?? null;
}

// ── write an event (the trigger surface for the engine) ──
// Any event type is allowed (events are a durable ledger of what happened).
// Most types just record. `tour_booked` ALSO spawns a tour obligation, in
// the same transaction. Body: { type, person_id?, property_id?, unit_id?, note? }
app.post("/events", async (req, res) => {
  const { type, person_id, property_id, unit_id, note } = req.body || {};
  if (!type) return res.status(400).json({ error: "type is required" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    // Validate any referenced rows up front, with clear errors.
    if (person_id) {
      const p = await client.query("select id from persons where id=$1", [person_id]);
      if (p.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "person not found" }); }
    }
    if (property_id) {
      const p = await client.query("select id from properties where id=$1", [property_id]);
      if (p.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "property not found" }); }
    }
    if (unit_id) {
      const u = await client.query("select id from units where id=$1", [unit_id]);
      if (u.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "unit not found" }); }
    }

    // If no property was passed but we have a person, resolve it (keeps the
    // funnel sliceable by property — fixes the gap where lifecycle events had
    // a null property_id).
    const resolvedProperty = property_id ?? await propertyForPerson(client, person_id);

    // Write the event itself.
    const ev = await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5) returning *`,
      [resolvedProperty, person_id ?? null, unit_id ?? null, type, note ?? null]
    );
    const event = ev.rows[0];

    // ── THE ENGINE LINK ──────────────────────────────────────────────
    // tour_booked is the first event that spawns a human obligation.
    let obligation = null;
if (type === "tour_booked") {
      const dueAt = new Date(Date.now() + TOUR_STALE_DAYS * 24 * 60 * 60 * 1000);
      const ob = await client.query(
        `insert into obligations
           (property_id, person_id, unit_id,
            source_event_id, module, type, label,
            owner_type, assigned_role, escalates_to_role,
            status, due_at, required_inputs)
         values ($1,$2,$3,$4,'leasing','tour',$5,
                 'human','leasing_agent','leasing_agent','open',$6,$7)
         returning *`,
        [resolvedProperty, person_id ?? null, unit_id ?? null,
         event.id, "Tour booked — needs an agent to own it", dueAt,
         '{tour_feedback}']
      );
      obligation = ob.rows[0];
    }

    await client.query("commit");
    res.status(201).json({ event, obligation });   // obligation is null for non-tour events
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── list events (optionally filtered) ──
// ?person_id=<uuid>  ?property_id=<uuid>  ?type=tour_booked
app.get("/events", async (req, res) => {
  const { person_id, property_id, type } = req.query;
  try {
    const where = [];
    const vals = [];
    if (person_id)   { vals.push(person_id);   where.push(`person_id = $${vals.length}`); }
    if (property_id) { vals.push(property_id); where.push(`property_id = $${vals.length}`); }
    if (type)        { vals.push(type);        where.push(`type = $${vals.length}`); }
    const sql = "select * from events" +
      (where.length ? " where " + where.join(" and ") : "") +
      " order by occurred_at desc";
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  OBLIGATIONS — read + claim. (No create-directly endpoint, on purpose.)
// ════════════════════════════════════════════════════════════════════

// ── list obligations (the role dashboards read this) ──
// ?assigned_role=leasing_agent  → the leasing pool
// ?status=open                  → unclaimed/active filter
// ?assigned_user_id=<uuid>      → "my obligations"
// ?unclaimed=true               → open AND nobody assigned yet (the claim pool)
// ?property_id=<uuid>
app.get("/obligations", async (req, res) => {
  const { assigned_role, status, assigned_user_id, property_id, unclaimed } = req.query;
  try {
    const where = [];
    const vals = [];
    if (assigned_role)    { vals.push(assigned_role);    where.push(`assigned_role = $${vals.length}`); }
    if (status)           { vals.push(status);           where.push(`status = $${vals.length}`); }
    if (assigned_user_id) { vals.push(assigned_user_id); where.push(`assigned_user_id = $${vals.length}`); }
    if (property_id)      { vals.push(property_id);      where.push(`property_id = $${vals.length}`); }
    if (unclaimed === "true") { where.push(`assigned_user_id is null and status = 'open'`); }
    const sql = "select * from obligations" +
      (where.length ? " where " + where.join(" and ") : "") +
      " order by due_at asc nulls last, created_at desc";
    const r = await pool.query(sql, vals);

    // Add a read-time `is_overdue` flag — the clock is read-time logic, no jobs.
    const now = Date.now();
    const rows = r.rows.map(o => ({
      ...o,
      is_overdue: o.due_at ? (new Date(o.due_at).getTime() < now) : false,
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── read one obligation (with the event that caused it — proves causality) ──
app.get("/obligations/:id", async (req, res) => {
  try {
    const o = await pool.query("select * from obligations where id=$1", [req.params.id]);
    if (o.rows.length === 0) return res.status(404).json({ error: "not found" });
    const obligation = o.rows[0];
    let source_event = null;
    if (obligation.source_event_id) {
      const e = await pool.query("select * from events where id=$1", [obligation.source_event_id]);
      source_event = e.rows[0] ?? null;
    }
    const now = Date.now();
    res.json({
      ...obligation,
      is_overdue: obligation.due_at ? (new Date(obligation.due_at).getTime() < now) : false,
      source_event,   // the "this is why this obligation exists" link
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLAIM an obligation ──
// The simplified claim mechanic: claiming IS just the first update to the
// already-existing obligation. Stamps assigned_user_id and flips open →
// in_progress. An agent claims it for themselves; a manager can claim it
// for someone by passing a different user_id. Default behavior is "claim".
//
// Body: { user_id }   — the user taking ownership (required)
// Guards: the obligation must exist, the user must exist, and it must not
// already be claimed by someone else (re-claiming the same person is a no-op;
// a manager reassigning is a separate explicit action, kept simple for now).
app.patch("/obligations/:id/claim", async (req, res) => {
  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id is required (who is claiming it)" });
  try {
    const o = await pool.query("select * from obligations where id=$1", [req.params.id]);
    if (o.rows.length === 0) return res.status(404).json({ error: "obligation not found" });
    const obligation = o.rows[0];

    const u = await pool.query("select id, name from users where id=$1", [user_id]);
    if (u.rows.length === 0) return res.status(404).json({ error: "user not found" });

    // Already claimed by someone else → conflict (don't silently steal it).
    if (obligation.assigned_user_id && obligation.assigned_user_id !== user_id) {
      return res.status(409).json({
        error: "already claimed by another user",
        assigned_user_id: obligation.assigned_user_id,
      });
    }

    const r = await pool.query(
      `update obligations
         set assigned_user_id = $1,
             status = case when status = 'open' then 'in_progress' else status end,
             updated_at = now()
       where id = $2
       returning *`,
      [user_id, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  USERS (minimal) — needed so obligations can belong to real people.
//  Not auth. Just create/list the staff who own obligations (e.g. Katie).
//  role must be one of the role_name enum values.
// ════════════════════════════════════════════════════════════════════
const ROLE_NAMES = ["owner","asset_manager","property_manager","leasing_agent","maintenance","accountant","ai","system"];

app.post("/users", async (req, res) => {
  const { name, email, phone, role } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  if (role && !ROLE_NAMES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLE_NAMES.join(", ")}` });
  }
  try {
    const r = await pool.query(
      `insert into users (name, email, phone, role)
       values ($1,$2,$3, coalesce($4::role_name,'property_manager')) returning *`,
      [name, email ?? null, phone ?? null, role ?? null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "a user with that email already exists" });
    res.status(500).json({ error: e.message });
  }
});

app.get("/users", async (_req, res) => {
  try {
    const r = await pool.query("select * from users order by created_at desc");
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});// ════════════════════════════════════════════════════════════════════
//  CLOSING THE LOOP — PROOF → COMPLETED RECORD
//
//  An obligation carries `required_inputs` (a text[]). While that array is
//  non-empty, something is still owed and the obligation CANNOT be closed.
//  This is the proof gate — the back half of the core loop:
//    Event → Obligation → Required Input → Clock → Escalation → PROOF → RECORD
//
//  Two actions:
//   • /satisfy — record the proof for ONE required input and remove it from
//     the list. The proof is captured as a real EVENT, so it's durable and
//     (for tour feedback) becomes the material the AI follow-up reads later.
//   • /complete — close the obligation, but ONLY if nothing is still owed.
//     If required_inputs is non-empty, it's refused with what's missing.
//
//  Paste this block into server.js AFTER the claim endpoint and BEFORE the
//  "AI INGESTION" section (or anywhere among the obligation endpoints).
// ════════════════════════════════════════════════════════════════════

// ── SATISFY a required input (record proof, check it off) ──
// Body: { input, proof?, satisfied_by? }
//   input        — which required input this satisfies (e.g. "tour_feedback")
//   proof        — the actual proof. For tour_feedback this is the structured
//                  feedback object/text (objections, move-in date, where else
//                  touring, decision timeline, red flags). Stored on the event.
//   satisfied_by — optional user id who provided it.
// The input must currently be in the obligation's required_inputs, or it's a
// no-op error (you can't satisfy something that wasn't owed).
app.patch("/obligations/:id/satisfy", async (req, res) => {
  const { input, proof, satisfied_by } = req.body || {};
  if (!input) return res.status(400).json({ error: "input is required (which required input this satisfies)" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const o = await client.query("select * from obligations where id=$1 for update", [req.params.id]);
    if (o.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "obligation not found" }); }
    const obligation = o.rows[0];

    const outstanding = obligation.required_inputs || [];
    if (!outstanding.includes(input)) {
      await client.query("rollback");
      return res.status(409).json({
        error: `"${input}" is not an outstanding required input on this obligation`,
        required_inputs: outstanding,
      });
    }

    // Record the proof as a durable event. The note carries a compact summary;
    // the full proof (if an object) is JSON-stringified into the note so it's
    // not lost. This event is what the AI follow-up will read for tour feedback.
    const proofText = (proof == null) ? ""
      : (typeof proof === "string" ? proof : JSON.stringify(proof));
    await client.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,$4,$5)`,
      [obligation.property_id, obligation.person_id, obligation.unit_id,
       `input_satisfied:${input}`,
       proofText ? `${input} provided: ${proofText}` : `${input} provided`]
    );

    // Remove the satisfied input from the array.
    const remaining = outstanding.filter(i => i !== input);
    const upd = await client.query(
      `update obligations
         set required_inputs = $1,
             updated_at = now()
       where id = $2
       returning *`,
      [remaining, req.params.id]
    );

    await client.query("commit");
    res.json({
      ...upd.rows[0],
      satisfied_input: input,
      can_complete: remaining.length === 0,   // hint for the UI
    });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── COMPLETE an obligation (the proof gate) ──
// Body: { completed_by? }
// Refuses with 409 if any required_inputs remain — naming what's still owed.
// On success: status='complete', completed_at=now(). The Completed Record.
app.patch("/obligations/:id/complete", async (req, res) => {
  const { completed_by } = req.body || {};
  try {
    const o = await pool.query("select * from obligations where id=$1", [req.params.id]);
    if (o.rows.length === 0) return res.status(404).json({ error: "obligation not found" });
    const obligation = o.rows[0];

    if (obligation.status === "complete") {
      return res.status(409).json({ error: "obligation is already complete" });
    }

    const outstanding = obligation.required_inputs || [];
    if (outstanding.length > 0) {
      // THE GATE. Can't close while proof is owed.
      return res.status(409).json({
        error: "cannot complete — required inputs are still outstanding",
        outstanding_inputs: outstanding,
        hint: "satisfy each required input first (PATCH /obligations/:id/satisfy)",
      });
    }

    const r = await pool.query(
      `update obligations
         set status = 'complete',
             completed_at = now(),
             updated_at = now()
       where id = $1
       returning *`,
      [req.params.id]
    );

    // Record the completion as an event too — the loop closes in the ledger.
    await pool.query(
      `insert into events (property_id, person_id, unit_id, type, note)
       values ($1,$2,$3,'obligation_completed',$4)`,
      [obligation.property_id, obligation.person_id, obligation.unit_id,
       `${obligation.type} obligation completed${completed_by ? " by " + completed_by : ""}`]
    );

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});// ════════════════════════════════════════════════════════════════════
//  REVENUE SIDE — all four blocks, paste-once.
//  Order: leases+schedule -> payments+delinquency -> PM approval -> tenant linkage.
//  Paste this ENTIRE file into server.js on the blank line ABOVE the
//  "// AI INGESTION" banner. Requires both schema files run in Neon first
//  (scheduled_charges_schema.sql, then scheduled_charges_schema_v2.sql).
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  LEASES + REVENUE SCHEDULE
//
//  The lease is the control document. Signing it generates the FULL revenue
//  schedule — not just a rent charge, but deposit, app fee, first month,
//  recurring rent, and any concessions with their booking treatment. The
//  leasing agent picks simple options; the correct schedule is derived here.
//
//  Scope of THIS build (matches the operator doc): timing and flow, not
//  payment processing. We model what's due, when, why, and whether it's
//  satisfied. Payment allocation + delinquency read from this later.
//
//  Paste into server.js among the other endpoints (before AI INGESTION).
//  Requires the scheduled_charges table (run scheduled_charges_schema.sql).
// ════════════════════════════════════════════════════════════════════

// Charge types that, by default, must be paid before keys (the move-in gate).
const MOVE_IN_GATE_TYPES = ["application_fee", "security_deposit", "first_month_rent", "move_in_fee", "deposit"];

// Add N months to a date (returns YYYY-MM-DD).
function addMonths(dateStr, n) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

// ── create a lease (minimal; carries the inputs the schedule derives from) ──
// Body: { property_id, space_id, tenant_ids?, rent, start_date, end_date,
//         security_deposit?, application_fee? }
app.post("/leases", async (req, res) => {
  const {
    property_id, space_id, tenant_ids,
    rent, start_date, end_date,
    security_deposit, application_fee,
  } = req.body || {};
  if (!property_id || !space_id) return res.status(400).json({ error: "property_id and space_id are required" });
  if (!rent) return res.status(400).json({ error: "rent is required to build a schedule" });
  try {
    const sp = await pool.query("select id from spaces where id=$1", [space_id]);
    if (sp.rows.length === 0) return res.status(404).json({ error: "space not found" });

    const r = await pool.query(
      `insert into leases
         (property_id, space_id, tenant_ids, rent, start_date, end_date,
          security_deposit, application_fee, lease_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
       returning *`,
      [property_id, space_id, tenant_ids ?? [], rent, start_date ?? null, end_date ?? null,
       security_deposit ?? null, application_fee ?? null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GENERATE the revenue schedule from the lease ──
// This is the lease-as-control-document in action. One call turns lease terms
// into the full set of scheduled charges. Idempotent-ish: refuses to double-
// generate (clears+regenerates only if ?force=true).
//
// Body (optional, all have sane defaults from the operator doc):
//   { application_fee=25, security_deposit=1 month, move_in_fees=[{label,amount}],
//     recurring=[{charge_type,label,amount}],  // pet_rent, parking, etc.
//     concession: { months, treatment } }      // treatment: upfront | amortized
app.post("/leases/:id/generate-schedule", async (req, res) => {
  const force = req.query.force === "true";
  const body = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    if (lease.schedule_generated_at && !force) {
      await client.query("rollback");
      return res.status(409).json({ error: "schedule already generated; pass ?force=true to regenerate" });
    }
    if (force) {
      await client.query("delete from scheduled_charges where lease_id=$1", [lease.id]);
    }

    const rent = Number(lease.rent);
    const start = (lease.start_date ? new Date(lease.start_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
    const appFee = body.application_fee ?? Number(lease.application_fee ?? 25);
    const deposit = body.security_deposit ?? Number(lease.security_deposit ?? rent); // default: 1 month
    const rows = [];

    // Helper to push a charge.
    const charge = (charge_type, label, amount, due_on, opts = {}) =>
      rows.push({ charge_type, label, amount, due_on,
        is_move_in_gate: opts.gate ?? MOVE_IN_GATE_TYPES.includes(charge_type),
        recurs: opts.recurs ?? false, recur_period: opts.recur_period ?? null,
        concession_treatment: opts.concession_treatment ?? null,
        concession_of_months: opts.concession_of_months ?? null });

    // 1. Application fee — due at application (use start as a placeholder date).
    if (appFee > 0) charge("application_fee", "Application fee", appFee, start);
    // 2. Security deposit — due at signing / before keys.
    if (deposit > 0) charge("security_deposit", "Security deposit", deposit, start);
    // 3. First month's rent — due before keys.
    charge("first_month_rent", "First month's rent", rent, start);
    // 4. Move-in fees (optional list).
    for (const f of (body.move_in_fees || [])) {
      if (f && f.amount) charge("move_in_fee", f.label || "Move-in fee", Number(f.amount), start);
    }
    // 5. Recurring monthly rent line (represented once, recurs=true; expansion later).
    charge("rent", "Monthly rent", rent, addMonths(start, 1), { recurs: true, recur_period: "monthly", gate: false });
    // 6. Other recurring charges (pet rent, parking, utilities).
    for (const rc of (body.recurring || [])) {
      if (rc && rc.amount) charge(rc.charge_type || "one_time", rc.label || rc.charge_type, Number(rc.amount),
        addMonths(start, 1), { recurs: true, recur_period: "monthly", gate: false });
    }
    // 7. Concession — simple input (months + treatment), correct booking behind the scenes.
    if (body.concession && body.concession.months) {
      const months = Number(body.concession.months);
      const treatment = body.concession.treatment === "amortized" ? "amortized" : "upfront";
      if (treatment === "upfront") {
        // Full credit at move-in / month 1.
        charge("concession_credit", `Concession: ${months} month(s) free (upfront)`, rent * months, start,
          { gate: false, concession_treatment: "upfront", concession_of_months: months });
      } else {
        // Amortized: a per-month credit across the term (represented as one recurring credit line).
        const lr2 = lease.end_date
          ? Math.max(1, Math.round((new Date(lease.end_date) - new Date(start)) / (30.44 * 86400000)))
          : 12;
        const perMonth = (rent * months) / lr2;
        charge("concession_credit", `Concession: ${months} month(s) free (amortized over ${lr2} mo)`,
          Number(perMonth.toFixed(2)), addMonths(start, 1),
          { gate: false, recurs: true, recur_period: "monthly",
            concession_treatment: "amortized", concession_of_months: months });
      }
    }

    // Write them all.
    const written = [];
    for (const c of rows) {
      const r = await client.query(
        `insert into scheduled_charges
           (lease_id, property_id, charge_type, label, amount, due_on, status,
            is_move_in_gate, recurs, recur_period, concession_treatment, concession_of_months)
         values ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11)
         returning *`,
        [lease.id, lease.property_id, c.charge_type, c.label, c.amount, c.due_on,
         c.is_move_in_gate, c.recurs, c.recur_period, c.concession_treatment, c.concession_of_months]
      );
      written.push(r.rows[0]);
    }

    await client.query("update leases set schedule_generated_at=now(), updated_at=now() where id=$1", [lease.id]);
    await client.query("commit");

    res.status(201).json({ lease_id: lease.id, generated: written.length, charges: written });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── READ a lease's schedule, with the move-in gate and balance computed ──
app.get("/leases/:id/schedule", async (req, res) => {
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });

    const sc = await pool.query(
      "select * from scheduled_charges where lease_id=$1 order by due_on nulls last, created_at",
      [req.params.id]
    );
    const charges = sc.rows;

    // Money math. Credits (concession_credit) reduce what's owed.
    const isCredit = c => c.charge_type === "concession_credit";
    const owed = charges
      .filter(c => c.status === "scheduled" && !isCredit(c))
      .reduce((s, c) => s + Number(c.amount), 0);
    const credits = charges
      .filter(c => c.status === "scheduled" && isCredit(c))
      .reduce((s, c) => s + Number(c.amount), 0);

    // The move-in gate: every gate charge that isn't satisfied yet.
    const gateCharges = charges.filter(c => c.is_move_in_gate);
    const gateOutstanding = gateCharges.filter(c => c.status === "scheduled");
    const moveInBalance = gateOutstanding.reduce((s, c) => s + Number(c.amount), 0);

    res.json({
      lease_id: req.params.id,
      total_scheduled_owed: Number(owed.toFixed(2)),
      total_scheduled_credits: Number(credits.toFixed(2)),
      net_scheduled: Number((owed - credits).toFixed(2)),
      move_in_balance_due: Number(moveInBalance.toFixed(2)),
      keys_released: gateOutstanding.length === 0 && gateCharges.length > 0,  // gate clear?
      gate_outstanding: gateOutstanding,
      charges,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  PAYMENTS + ALLOCATION  (reads FROM scheduled_charges)
//
//  A tenant pays whatever amount they want. The system allocates it against
//  the schedule using the operator's default rules:
//    • oldest unpaid first
//    • rent before optional/ancillary charges
//    • unpaid balances stay open
//    • overpayment becomes a tenant credit (applied to future charges)
//
//  Each payment is recorded as a ledger_entries row (the money that HAPPENED).
//  Each fully-covered scheduled_charge flips to 'satisfied'. Partial coverage
//  is tracked so a charge can be partly paid.
//
//  Scope note: this is the allocation/flow layer. Real payment processing
//  (cards, ACH, bank linking) is still later — we record an amount + method.
//
//  Requires a small column to track partial payment on a charge:
//    alter table scheduled_charges add column if not exists amount_paid numeric(10,2) not null default 0;
//  (included in scheduled_charges_schema_v2.sql)
// ════════════════════════════════════════════════════════════════════

// Priority for allocation: lower number = paid first. Rent-type before ancillary.
function chargePriority(c) {
  const rentish = ["first_month_rent", "rent"];
  const moveIn  = ["application_fee", "security_deposit", "move_in_fee", "deposit"];
  if (moveIn.includes(c.charge_type)) return 0;   // move-in gate items first
  if (rentish.includes(c.charge_type)) return 1;  // then rent
  return 2;                                        // then ancillary (pet, parking, utilities, late fees)
}

// ── record a tenant payment and allocate it ──
// Body: { amount, method?, occurred_at? }
app.post("/leases/:id/payments", async (req, res) => {
  const { amount, method, occurred_at } = req.body || {};
  const payAmount = Number(amount);
  if (!payAmount || payAmount <= 0) return res.status(400).json({ error: "a positive amount is required" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    // Pull outstanding charges (not credits, not satisfied/void/waived), ordered
    // by allocation priority then by due date (oldest first).
    const sc = await client.query(
      `select * from scheduled_charges
        where lease_id=$1 and status='scheduled' and charge_type <> 'concession_credit'`,
      [lease.id]
    );
    const charges = sc.rows
      .map(c => ({ ...c, remaining: Number(c.amount) - Number(c.amount_paid || 0) }))
      .filter(c => c.remaining > 0.001)
      .sort((a, b) => chargePriority(a) - chargePriority(b)
        || (new Date(a.due_on || "2999-01-01") - new Date(b.due_on || "2999-01-01")));

    // Record the payment itself in the ledger.
    const led = await client.query(
      `insert into ledger_entries (lease_id, label, kind, amount, method, occurred_at)
       values ($1,$2,'payment',$3,$4, coalesce($5, now()))
       returning *`,
      [lease.id, "Tenant payment", payAmount, method ?? null, occurred_at ?? null]
    );

    // Allocate.
    let left = payAmount;
    const applied = [];
    for (const c of charges) {
      if (left <= 0.001) break;
      const take = Math.min(left, c.remaining);
      const newPaid = Number(c.amount_paid || 0) + take;
      const fullyPaid = newPaid + 0.001 >= Number(c.amount);
      await client.query(
        `update scheduled_charges
           set amount_paid=$1, status=$2, updated_at=now()
         where id=$3`,
        [Number(newPaid.toFixed(2)), fullyPaid ? "satisfied" : "scheduled", c.id]
      );
      applied.push({ charge_id: c.id, charge_type: c.charge_type, label: c.label,
        applied: Number(take.toFixed(2)), now_satisfied: fullyPaid });
      left -= take;
    }

    // Overpayment becomes a credit (recorded as a ledger note for now).
    const creditLeft = Number(left.toFixed(2));
    if (creditLeft > 0.001) {
      await client.query(
        `insert into ledger_entries (lease_id, label, kind, amount, method)
         values ($1,'Tenant credit (overpayment)','credit',$2,$3)`,
        [lease.id, creditLeft, method ?? null]
      );
    }

    // Recompute the move-in gate after this payment.
    const gate = await client.query(
      `select count(*)::int as n from scheduled_charges
        where lease_id=$1 and is_move_in_gate=true and status='scheduled'`,
      [lease.id]
    );
    const keysReleased = gate.rows[0].n === 0;

    await client.query("commit");
    res.status(201).json({
      payment: led.rows[0],
      allocated: applied,
      credit_remaining: creditLeft,
      keys_released: keysReleased,
    });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── DELINQUENCY view + the two-payments-behind legal trigger ──
// Read-time (no background job). Computes what's overdue and unpaid as of now,
// and the delinquency stage. If the tenant is effectively two payments behind,
// it spawns a collections obligation (the engine, reused) AND assembles the
// package the AI/legal review needs — once (won't duplicate).
//
// GET  /leases/:id/delinquency        → just the read (no side effects)
// POST /leases/:id/delinquency/check  → read + spawn obligation if triggered
app.get("/leases/:id/delinquency", async (req, res) => {
  try {
    const out = await computeDelinquency(pool, req.params.id);
    if (out.error) return res.status(out.code).json({ error: out.error });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/leases/:id/delinquency/check", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await computeDelinquency(client, req.params.id);
    if (out.error) { await client.query("rollback"); return res.status(out.code).json({ error: out.error }); }

    let obligation = null;
    if (out.legal_trigger) {
      // Don't double-create: is there already an open collections obligation?
      const existing = await client.query(
        `select id from obligations
          where module='collections' and type='legal_process'
            and status in ('open','in_progress') and property_id=$1
            and person_id is not distinct from $2`,
        [out.property_id, out.tenant_id ?? null]
      );
      if (existing.rows.length === 0) {
        const ob = await client.query(
          `insert into obligations
             (property_id, person_id, module, type, label,
              owner_type, assigned_role, escalates_to_role,
              status, priority, severity, required_inputs)
           values ($1,$2,'collections','legal_process',$3,
                   'human','property_manager','property_manager','open','high','high',
                   '{legal_review}')
           returning *`,
          [out.property_id, out.tenant_id ?? null,
           `Delinquency: ${out.lease_id} is ~${out.days_delinquent}d behind — start legal process`]
        );
        obligation = ob.rows[0];
        // The package the AI/legal review needs, captured as an event.
        await client.query(
          `insert into events (property_id, person_id, type, note)
           values ($1,$2,'collections_package',$3)`,
          [out.property_id, out.tenant_id ?? null, JSON.stringify(out.package)]
        );
      }
    }

    await client.query("commit");
    res.json({ ...out, obligation_created: obligation });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Shared delinquency computation. Works with a pool or a transaction client.
async function computeDelinquency(db, leaseId) {
  const lr = await db.query("select * from leases where id=$1", [leaseId]);
  if (lr.rows.length === 0) return { error: "lease not found", code: 404 };
  const lease = lr.rows[0];

  const today = new Date();
  const sc = await db.query(
    `select * from scheduled_charges
      where lease_id=$1 and status='scheduled'
        and charge_type in ('first_month_rent','rent','move_in_fee')
        and due_on is not null and due_on <= $2`,
    [leaseId, today.toISOString().slice(0, 10)]
  );
  const overdue = sc.rows.map(c => ({ ...c, remaining: Number(c.amount) - Number(c.amount_paid || 0) }))
    .filter(c => c.remaining > 0.001);

  const totalOverdue = overdue.reduce((s, c) => s + c.remaining, 0);

  // Oldest overdue charge → days delinquent.
  let daysDelinquent = 0;
  if (overdue.length) {
    const oldest = overdue.reduce((a, b) => new Date(a.due_on) < new Date(b.due_on) ? a : b);
    daysDelinquent = Math.floor((today - new Date(oldest.due_on)) / 86400000);
  }

  // Stage. Operator rule: rent due 1st, grace to 5th, late from 6th; the big
  // trigger is effectively two payments behind (~60 days).
  const rentPeriods = overdue.filter(c => c.charge_type === "rent" || c.charge_type === "first_month_rent").length;
  let stage = "current";
  if (overdue.length) stage = "late";
  if (daysDelinquent > 5) stage = "delinquent";
  const legalTrigger = rentPeriods >= 2 || daysDelinquent >= 60;
  if (legalTrigger) stage = "legal_process";

  const tenantId = (lease.tenant_ids && lease.tenant_ids[0]) || null;

  return {
    lease_id: leaseId,
    property_id: lease.property_id,
    tenant_id: tenantId,
    stage,                                   // current | late | delinquent | legal_process
    days_delinquent: daysDelinquent,
    periods_behind: rentPeriods,
    total_overdue: Number(totalOverdue.toFixed(2)),
    legal_trigger: legalTrigger,
    overdue_charges: overdue.map(c => ({ id: c.id, type: c.charge_type, label: c.label,
      due_on: c.due_on, remaining: Number(c.remaining.toFixed(2)) })),
    // The package the AI assembles for legal review (timing + flow, not filing).
    package: {
      lease_id: leaseId,
      tenant_id: tenantId,
      stage,
      days_delinquent: daysDelinquent,
      periods_behind: rentPeriods,
      total_overdue: Number(totalOverdue.toFixed(2)),
      note: "Auto-assembled at delinquency check. For PM/legal review — system does not file.",
    },
  };
}
// ════════════════════════════════════════════════════════════════════
//  PM APPROVAL PACKAGE  (the "buck stops with the PM" surface)
//
//  Lease approval isn't just "is the document correct." It's "does this lease
//  support the asset plan." This endpoint assembles the single view a PM
//  approves against:
//    • lease abstract (terms)
//    • full revenue schedule + move-in balance (reads scheduled_charges)
//    • concession details + booking treatment
//    • asset-plan FLAGS — a coaching layer, not a rigid gate
//
//  The flags begin as comments/highlights the PM can heed or override. Over
//  time, overrides become training data for better rules. The PM can approve
//  or reject; the decision is recorded as an event.
//
//  Reads from leases + scheduled_charges + units/spaces. No new table.
// ════════════════════════════════════════════════════════════════════

// Months with historically weak student/market leasing (configurable later;
// for now, a simple heuristic the PM sees and can override). Nov–Feb flagged.
const WEAK_LEASING_MONTHS = [11, 12, 1, 2];

// Build the asset-plan flags. Pure read; produces human-readable highlights.
async function assetPlanFlags(db, lease, charges) {
  const flags = [];

  // Lease expiration in a weak leasing month → future re-lease risk.
  if (lease.end_date) {
    const endMonth = new Date(String(lease.end_date).slice(0, 10) + "T00:00:00Z").getUTCMonth() + 1;
    if (WEAK_LEASING_MONTHS.includes(endMonth)) {
      flags.push({ level: "warn", code: "weak_expiration_month",
        message: `Lease expires in month ${endMonth}, a historically weak leasing window — re-leasing may be slow.` });
    }
  }

  // Scarce inventory of this unit type at the property → consider pushing rent.
  // (Counts spaces in the same property with no active lease, same bedroom count.)
  if (lease.space_id) {
    const u = await db.query(
      `select un.bedrooms from spaces sp join units un on un.id=sp.unit_id where sp.id=$1`,
      [lease.space_id]
    );
    const beds = u.rows[0]?.bedrooms ?? null;
    if (beds !== null) {
      const avail = await db.query(
        `select count(*)::int as n
           from spaces sp join units un on un.id=sp.unit_id
          where un.property_id=$1 and un.bedrooms=$2
            and sp.id not in (select space_id from leases where lease_status in ('active','pending'))`,
        [lease.property_id, beds]
      );
      const remaining = avail.rows[0].n;
      if (remaining <= 1) {
        flags.push({ level: "opportunity", code: "scarce_inventory",
          message: `Only ${remaining} ${beds}BR space(s) left unleased at this property — consider pushing rent; little inventory behind it.` });
      }
    }
  }

  // Concession present → note its exposure.
  const concession = charges.find(c => c.charge_type === "concession_credit");
  if (concession) {
    flags.push({ level: "info", code: "concession_applied",
      message: `Concession applied (${concession.label}) — booked ${concession.concession_treatment}. Confirm it fits the property's revenue plan.` });
  }

  // Lease start far in the future → carrying vacancy until then.
  if (lease.start_date) {
    const days = Math.floor((new Date(lease.start_date) - new Date()) / 86400000);
    if (days > 30) {
      flags.push({ level: "warn", code: "vacancy_until_start",
        message: `Unit would sit vacant ~${days} days until lease start — weigh against holding for a sooner move-in.` });
    }
  }

  return flags;
}

// ── GET the approval package ──
app.get("/leases/:id/approval-package", async (req, res) => {
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });
    const lease = lr.rows[0];

    const sc = await pool.query(
      "select * from scheduled_charges where lease_id=$1 order by due_on nulls last, created_at",
      [req.params.id]
    );
    const charges = sc.rows;

    const isCredit = c => c.charge_type === "concession_credit";
    const owed = charges.filter(c => !isCredit(c)).reduce((s, c) => s + Number(c.amount), 0);
    const credits = charges.filter(isCredit).reduce((s, c) => s + Number(c.amount), 0);
    const gateOutstanding = charges.filter(c => c.is_move_in_gate && c.status === "scheduled");
    const moveInBalance = gateOutstanding.reduce((s, c) => s + Number(c.amount), 0);

    const flags = await assetPlanFlags(pool, lease, charges);

    res.json({
      lease_abstract: {
        lease_id: lease.id, property_id: lease.property_id, space_id: lease.space_id,
        rent: lease.rent, start_date: lease.start_date, end_date: lease.end_date,
        status: lease.lease_status, tenant_ids: lease.tenant_ids,
      },
      revenue_schedule: charges,
      money_summary: {
        total_owed: Number(owed.toFixed(2)),
        total_credits: Number(credits.toFixed(2)),
        net: Number((owed - credits).toFixed(2)),
        move_in_balance_due: Number(moveInBalance.toFixed(2)),
      },
      concession: charges.find(isCredit) || null,
      asset_plan_flags: flags,                 // coaching layer — heed or override
      schedule_generated: !!lease.schedule_generated_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PM decision: approve or reject the lease ──
// Body: { decision: "approve"|"reject", decided_by?, note? }
// Recorded as an event; on approve, lease moves pending → active.
app.patch("/leases/:id/approval", async (req, res) => {
  const { decision, decided_by, note } = req.body || {};
  if (!["approve", "reject"].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });

    const newStatus = decision === "approve" ? "active" : "rejected";
    const r = await pool.query(
      "update leases set lease_status=$1, updated_at=now() where id=$2 returning *",
      [newStatus, req.params.id]
    );
    await pool.query(
      `insert into events (property_id, type, note)
       values ($1,$2,$3)`,
      [r.rows[0].property_id, `lease_${decision}d`,
       `Lease ${decision}d${decided_by ? " by " + decided_by : ""}${note ? ": " + note : ""}`]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ════════════════════════════════════════════════════════════════════
//  TENANT LINKAGE — applicant → tenant on a lease
//
//  The missing connective tissue. The leasing side builds up a person
//  (lead → applicant). The lease/money side needs to know WHO the tenant is,
//  so obligations (e.g. collections) attach to a real human instead of being
//  orphaned. This endpoint links a person to a lease and advances their
//  lifecycle to 'tenant' in one atomic step.
//
//  • adds person_id to leases.tenant_ids (no duplicates)
//  • advances the person applicant → tenant (validated; writes a funnel event)
//  • records a tenant_added event on the lease
//
//  Paste into server.js among the lease endpoints (before AI INGESTION).
// ════════════════════════════════════════════════════════════════════

// ── attach a person to a lease as a tenant ──
// Body: { person_id }
app.post("/leases/:id/tenants", async (req, res) => {
  const { person_id } = req.body || {};
  if (!person_id) return res.status(400).json({ error: "person_id is required" });

  const client = await pool.connect();
  try {
    await client.query("begin");

    const lr = await client.query("select * from leases where id=$1 for update", [req.params.id]);
    if (lr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "lease not found" }); }
    const lease = lr.rows[0];

    const pr = await client.query("select * from persons where id=$1 for update", [person_id]);
    if (pr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "person not found" }); }
    const person = pr.rows[0];

    // Already on the lease? No-op success (idempotent).
    const current = lease.tenant_ids || [];
    const alreadyOn = current.includes(person_id);

    // Add to tenant_ids if not present (array_append guarded by uniqueness).
    if (!alreadyOn) {
      await client.query(
        `update leases set tenant_ids = array_append(tenant_ids, $1), updated_at=now()
         where id=$2`,
        [person_id, req.params.id]
      );
    }

    // Advance lifecycle to tenant. Only valid forward moves: applicant→tenant
    // is the normal path. If they're already 'tenant', leave it. If they're a
    // 'lead' (skipping applicant), we still allow it here because attaching to a
    // signed lease is itself the proof they've become a tenant — but we record
    // the jump honestly in the event note.
    let lifecycleNote = null;
    if (person.lifecycle_status !== "tenant" && person.lifecycle_status !== "past") {
      const from = person.lifecycle_status;
      await client.query(
        `update persons set lifecycle_status='tenant', updated_at=now() where id=$1`,
        [person_id]
      );
      await client.query(
        `insert into events (property_id, person_id, type, note)
         values ($1,$2,'lifecycle_change',$3)`,
        [lease.property_id, person_id, `${from} → tenant (attached to lease ${lease.id})`]
      );
      lifecycleNote = `${from} → tenant`;
    }

    // Record the linkage as a lease event.
    await client.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,'tenant_added',$3)`,
      [lease.property_id, person_id, `tenant added to lease ${lease.id}`]
    );

    await client.query("commit");

    // Return the refreshed lease + person.
    const out = await pool.query("select * from leases where id=$1", [req.params.id]);
    res.status(201).json({
      lease: out.rows[0],
      person_advanced: lifecycleNote,
      already_on_lease: alreadyOn,
    });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── remove a person from a lease (roommate leaves, data fix) ──
// Body: { person_id }
// Does NOT change the person's lifecycle (leaving one lease doesn't make them
// 'past' — they may be on another lease). Records the removal as an event.
app.delete("/leases/:id/tenants", async (req, res) => {
  const { person_id } = req.body || {};
  if (!person_id) return res.status(400).json({ error: "person_id is required" });
  try {
    const lr = await pool.query("select * from leases where id=$1", [req.params.id]);
    if (lr.rows.length === 0) return res.status(404).json({ error: "lease not found" });
    const lease = lr.rows[0];

    if (!(lease.tenant_ids || []).includes(person_id)) {
      return res.status(409).json({ error: "that person is not a tenant on this lease" });
    }

    const r = await pool.query(
      `update leases set tenant_ids = array_remove(tenant_ids, $1), updated_at=now()
       where id=$2 returning *`,
      [person_id, req.params.id]
    );
    await pool.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,'tenant_removed',$3)`,
      [lease.property_id, person_id, `tenant removed from lease ${lease.id}`]
    );
    res.json({ lease: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});// ════════════════════════════════════════════════════════════════════
//  MAINTENANCE — the three-layer category engine + work orders + supplies
//
//  Core idea (from the spec): capture operating context at the moment work
//  happens, so accounting never reconstructs it later. The tech taps a simple
//  field category; the server derives the operating (PM) and GL (accounting)
//  categories using CONTEXT. Same field action maps differently by context:
//    paint + occupied  → repair/maintenance
//    paint + vacant    → turn cost
//    paint + damage    → tenant billback
//    paint + renovation→ capex
//
//  "Simple at the edge, precise at the center."
//
//  Requires maintenance_schema.sql.
//  Paste into server.js before the AI INGESTION banner.
// ════════════════════════════════════════════════════════════════════

// Layer 1 field categories the tech can pick (what they SEE).
const FIELD_CATEGORIES = [
  "plumbing", "electrical", "hvac", "appliance", "paint", "drywall",
  "cleaning", "pest", "lock", "landscaping", "elevator", "amenity",
  "turn", "supplies", "vendor_needed", "other",
];

// ── THE MAPPING ENGINE ──────────────────────────────────────────────
// Given a field category + context, derive operating (Layer 2) and GL
// (Layer 3). This is the precise center. It is intentionally rule-based and
// readable — the spec says start as rules, refine with real overrides later.
function deriveCategories({ field_category, unit_state, cause, is_capex, billback }) {
  const fc = field_category || "other";
  const state = unit_state || "occupied";       // default: occupied
  const damaged = cause === "tenant_damage";

  // ---- Layer 2: operating category (what the PM sees) ----
  let operating;
  if (is_capex) operating = "capital";
  else if (fc === "turn" || state === "vacant") operating = "turn";
  else if (state === "renovation") operating = "capital";
  else if (damaged) operating = "tenant_damage";
  else if (fc === "vendor_needed") operating = "vendor_quote";
  else if (fc === "supplies") operating = "supply_request";
  else if (fc === "amenity") operating = "common_area";
  else operating = "resident_repair";

  // ---- Layer 3: GL / T12 category (what accounting sees) ----
  // Capex and billback override the trade-specific GL.
  let gl;
  if (is_capex || state === "renovation") {
    gl = "capex";
  } else if (billback || damaged) {
    gl = "tenant_billback";
  } else if (operating === "turn") {
    // turn-specific GL by trade
    const turnMap = { paint: "turn_painting", cleaning: "turn_cleaning", drywall: "turn_painting" };
    gl = turnMap[fc] || "turn_make_ready";
  } else {
    // normal repair GL by trade
    const tradeMap = {
      plumbing: "plumbing_repairs", electrical: "electrical_repairs", hvac: "hvac_repairs",
      appliance: "appliance_repair", paint: "repairs_maintenance", drywall: "repairs_maintenance",
      cleaning: "cleaning", pest: "pest_control", lock: "repairs_maintenance",
      landscaping: "landscaping", elevator: "building_systems", amenity: "common_area_maintenance",
      supplies: "maintenance_supplies", other: "repairs_maintenance",
    };
    gl = tradeMap[fc] || "repairs_maintenance";
  }

  return { operating_category: operating, gl_category: gl };
}

// Expose the mapping so the UI can preview categories before saving.
// GET /maintenance/preview-category?field_category=paint&unit_state=vacant&cause=normal_wear
app.get("/maintenance/preview-category", (req, res) => {
  const { field_category, unit_state, cause, is_capex, billback } = req.query;
  if (!field_category) return res.status(400).json({ error: "field_category is required" });
  res.json(deriveCategories({
    field_category, unit_state, cause,
    is_capex: is_capex === "true", billback: billback === "true",
  }));
});

// ── create a work order WITH categories derived at capture ──
// Body: { property_id, unit_id?, person_id?, title, description,
//         field_category, unit_state?, cause?, is_emergency?, is_capex?,
//         billback?, est_cost?, source? }
app.post("/work-orders", async (req, res) => {
  const b = req.body || {};
  if (!b.property_id) return res.status(400).json({ error: "property_id is required" });
  if (!b.field_category) return res.status(400).json({ error: "field_category is required (what the tech taps)" });
  if (!FIELD_CATEGORIES.includes(b.field_category)) {
    return res.status(400).json({ error: `field_category must be one of: ${FIELD_CATEGORIES.join(", ")}` });
  }
  try {
    const prop = await pool.query("select id from properties where id=$1", [b.property_id]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    // Derive the operating + GL categories NOW, while context is fresh.
    const derived = deriveCategories(b);

    const r = await pool.query(
      `insert into work_orders
         (property_id, unit_id, person_id, title, issue_type, description, status, source,
          field_category, operating_category, gl_category,
          unit_state, cause, is_emergency, is_capex, billback, est_cost)
       values ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning *`,
      [b.property_id, b.unit_id ?? null, b.person_id ?? null,
       b.title ?? null, b.field_category, b.description ?? null, b.source ?? "staff",
       b.field_category, derived.operating_category, derived.gl_category,
       b.unit_state ?? "occupied", b.cause ?? "normal_wear",
       b.is_emergency === true, b.is_capex === true, b.billback === true, b.est_cost ?? null]
    );
    const wo = r.rows[0];

    // Record the work order as an event (operating reality → the ledger of events).
    await pool.query(
      `insert into events (property_id, unit_id, person_id, type, note)
       values ($1,$2,$3,'work_order_opened',$4)`,
      [wo.property_id, wo.unit_id, wo.person_id,
       `WO ${wo.id}: ${b.field_category} (${derived.operating_category} / ${derived.gl_category})`]
    );

    // Emergency → spawn an immediate maintenance obligation (the engine, reused).
    let obligation = null;
    if (b.is_emergency === true) {
      const ob = await pool.query(
        `insert into obligations
           (property_id, unit_id, related_id, related_type, module, type, label,
            owner_type, assigned_role, escalates_to_role, status, priority, severity, required_inputs)
         values ($1,$2,$3,'work_order','maintenance','emergency_response',$4,
                 'human','maintenance','property_manager','open','high','emergency','{on_site_response}')
         returning *`,
        [wo.property_id, wo.unit_id, wo.id, `EMERGENCY: ${b.title || b.field_category}`]
      );
      obligation = ob.rows[0];
    }

    res.status(201).json({ work_order: wo, emergency_obligation: obligation });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── list work orders (the maintenance + management dashboards read this) ──
// ?status=open  ?operating_category=turn  ?is_emergency=true  ?property_id=
app.get("/work-orders", async (req, res) => {
  const { status, operating_category, is_emergency, property_id, needs_pm_review } = req.query;
  try {
    const where = [], vals = [];
    if (status)             { vals.push(status);             where.push(`status = $${vals.length}`); }
    if (operating_category) { vals.push(operating_category); where.push(`operating_category = $${vals.length}`); }
    if (property_id)        { vals.push(property_id);        where.push(`property_id = $${vals.length}`); }
    if (is_emergency === "true")    where.push(`is_emergency = true`);
    if (needs_pm_review === "true") where.push(`needs_pm_review = true`);
    const sql = "select * from work_orders" +
      (where.length ? " where " + where.join(" and ") : "") +
      " order by is_emergency desc, created_at desc";
    const r = await pool.query(sql, vals);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLOSE OUT a work order (the "is this 100% done?" decision tree) ──
// Body: { done: true,  completion_note?, completion_photo? }
//   OR  { done: false, reason, ...optional }
//
// done=true  → status complete (or needs_pm_review if no proof on a type that
//              requires it — kept simple: photo OR note required to close clean).
// done=false → status stays open, a follow-up OBLIGATION is spawned based on the
//              reason (continuity engine: the chain cannot break). Reason routes:
//   need_part / part_ordered → supply follow-up; need_vendor → vendor quote;
//   need_approval → PM; no_access / tenant_not_home → reschedule; etc.
const NOT_DONE_REASONS = [
  "need_part", "part_ordered", "need_vendor", "need_approval", "no_access",
  "tenant_not_home", "could_not_find_issue", "duplicate", "need_second_visit",
  "partially_completed", "unsafe_condition", "tenant_caused_damage", "manager_review",
];

app.patch("/work-orders/:id/closeout", async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("begin");
    const wr = await client.query("select * from work_orders where id=$1 for update", [req.params.id]);
    if (wr.rows.length === 0) { await client.query("rollback"); return res.status(404).json({ error: "work order not found" }); }
    const wo = wr.rows[0];

    if (b.done === true) {
      // Proof gate: need a note OR photo to close clean; else flag for PM review.
      const hasProof = !!(b.completion_note || b.completion_photo);
      const status = "complete";
      const needsReview = !hasProof;
      const r = await client.query(
        `update work_orders
           set status=$1, completion_note=$2, completion_photo=$3,
               needs_pm_review=$4, updated_at=now()
         where id=$5 returning *`,
        [status, b.completion_note ?? null, b.completion_photo ?? null, needsReview, req.params.id]
      );
      await client.query(
        `insert into events (property_id, unit_id, type, note)
         values ($1,$2,'work_order_completed',$3)`,
        [wo.property_id, wo.unit_id, `WO ${wo.id} completed${needsReview ? " (NO PROOF — flagged for PM review)" : ""}`]
      );
      await client.query("commit");
      return res.json({ work_order: r.rows[0], needs_pm_review: needsReview });
    }

    // done === false → reason required, spawn the right follow-up obligation.
    if (!b.reason || !NOT_DONE_REASONS.includes(b.reason)) {
      await client.query("rollback");
      return res.status(400).json({ error: `reason required, one of: ${NOT_DONE_REASONS.join(", ")}` });
    }

    // Route the reason → obligation type + owner + required proof.
    const routes = {
      need_part:        { type: "supply_follow_up", role: "maintenance", inputs: "{part_ordered}" },
      part_ordered:     { type: "await_part",       role: "maintenance", inputs: "{part_received,reschedule}" },
      need_vendor:      { type: "vendor_quote",     role: "property_manager", inputs: "{quote_requested}" },
      need_approval:    { type: "pm_approval",      role: "property_manager", inputs: "{approval_decision}" },
      no_access:        { type: "reschedule",       role: "maintenance", inputs: "{rescheduled}" },
      tenant_not_home:  { type: "reschedule",       role: "maintenance", inputs: "{rescheduled}" },
      need_second_visit:{ type: "reschedule",       role: "maintenance", inputs: "{second_visit_done}" },
      unsafe_condition: { type: "escalation",       role: "property_manager", inputs: "{pm_reviewed}" },
      tenant_caused_damage: { type: "billback_review", role: "property_manager", inputs: "{billback_decision}" },
      manager_review:   { type: "pm_review",        role: "property_manager", inputs: "{pm_reviewed}" },
      could_not_find_issue: { type: "pm_review",    role: "property_manager", inputs: "{pm_reviewed}" },
      duplicate:        { type: "pm_review",        role: "property_manager", inputs: "{pm_confirmed_duplicate}" },
      partially_completed: { type: "second_visit",  role: "maintenance", inputs: "{remaining_work_done}" },
    };
    const route = routes[b.reason];

    const ob = await client.query(
      `insert into obligations
         (property_id, unit_id, related_id, related_type, module, type, label,
          owner_type, assigned_role, escalates_to_role, status, priority, required_inputs)
       values ($1,$2,$3,'work_order','maintenance',$4,$5,
               'human',$6::role_name,'property_manager','open','normal',$7::text[])
       returning *`,
      [wo.property_id, wo.unit_id, wo.id, route.type,
       `WO follow-up (${b.reason}): ${wo.title || wo.field_category}`,
       route.role, route.inputs]
    );

    // The WO itself stays open with the reason recorded; chain preserved.
    await client.query(
      `update work_orders set completion_note=$1, updated_at=now() where id=$2`,
      [`NOT DONE: ${b.reason}${b.note ? " — " + b.note : ""}`, req.params.id]
    );
    await client.query(
      `insert into events (property_id, unit_id, type, note)
       values ($1,$2,'work_order_not_done',$3)`,
      [wo.property_id, wo.unit_id, `WO ${wo.id} not done: ${b.reason} → follow-up obligation spawned`]
    );

    await client.query("commit");
    res.json({ work_order_status: "open", reason: b.reason, follow_up_obligation: ob.rows[0] });
  } catch (e) {
    await client.query("rollback");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── SUPPLY REQUEST — category born at request time ──
// Body: { property_id, unit_id?, work_order_id?, requested_by, item, quantity?,
//         reason?, field_category?, unit_state?, cause?, est_cost? }
app.post("/supply-requests", async (req, res) => {
  const b = req.body || {};
  if (!b.property_id || !b.item) return res.status(400).json({ error: "property_id and item are required" });
  try {
    const derived = deriveCategories({
      field_category: b.field_category || "supplies",
      unit_state: b.unit_state, cause: b.cause,
      is_capex: b.is_capex === true, billback: b.billback === true,
    });
    const r = await pool.query(
      `insert into supply_requests
         (property_id, unit_id, work_order_id, requested_by, item, quantity, reason,
          field_category, operating_category, gl_category, est_cost, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested')
       returning *`,
      [b.property_id, b.unit_id ?? null, b.work_order_id ?? null, b.requested_by ?? null,
       b.item, b.quantity ?? null, b.reason ?? null,
       b.field_category || "supplies", derived.operating_category, derived.gl_category, b.est_cost ?? null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── approve / order / deny a supply request (PM gate) ──
// Body: { status: "approved"|"ordered"|"received"|"denied", approved_by? }
app.patch("/supply-requests/:id/status", async (req, res) => {
  const { status, approved_by } = req.body || {};
  const allowed = ["approved", "ordered", "received", "denied"];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });
  try {
    const r = await pool.query(
      `update supply_requests set status=$1, approved_by=coalesce($2, approved_by), updated_at=now()
       where id=$3 returning *`,
      [status, approved_by ?? null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "supply request not found" });
    res.json(r.rows[0]);
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
