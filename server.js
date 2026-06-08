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
const maintenanceModule = require("./maintenance");  // isolated maintenance routes
const downUnitsModule = require("./down_units");      // isolated down-units routes
const orgchartModule = require("./orgchart");
const moneyModule = require("./money");
const turnoversModule = require("./turnovers");
const moveinModule = require("./movein");
// uploads held in memory; 25mb cap — OMs are image-heavy and run large, but a
// runaway file still can't choke the box. Oversize returns a clean 413 below.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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

// ════════════════════════════════════════════════════════════════════
//  SHARED CORE SERVICE — spawnObligationFromEvent
//
//  THE single obligation-creation path. Every obligation in the system is
//  born from an event and written here. The leasing tour, the delinquency
//  collections item, and the maintenance emergency all call this — so the
//  business logic lives in ONE place and modules (option-1 injection) never
//  duplicate it. Must be called inside an open transaction (pass `client`).
//
//  spec carries the full column set; priority/severity default to null so
//  callers that don't set them behave exactly as before.
// ════════════════════════════════════════════════════════════════════
async function spawnObligationFromEvent(client, spec) {
  const {
    property_id = null, person_id = null, unit_id = null,
    source_event_id = null, module, type, label,
    owner_type = "human", assigned_role = null, escalates_to_role = null,
    status = "open", due_at = null,
    // priority/severity are NOT NULL in the DB with CHECK vocabularies:
    //   priority: low|normal|high   severity: low|normal|high|emergency
    // Default to 'normal' (valid) so NO caller can trip the not-null constraint.
    // Callers override when the work is genuinely low/high/emergency.
    priority = "normal", severity = "normal",
    required_inputs = [],
    // related_id / related_type link an obligation to the DOMAIN OBJECT it's
    // about (turnover, work order, lease). Both nullable columns. Additive:
    // callers that don't pass them get null (prior behavior); callers that do
    // (turnover, down_units) can now find their obligation by the link.
    related_id = null, related_type = null,
  } = spec;

  // Postgres text[] literal, e.g. {tour_feedback} or {closeout_proof}
  const inputsLiteral = "{" + (required_inputs || []).join(",") + "}";

  const r = await client.query(
    `insert into obligations
       (property_id, person_id, unit_id,
        source_event_id, module, type, label,
        owner_type, assigned_role, escalates_to_role,
        status, due_at, priority, severity, required_inputs,
        related_id, related_type)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [property_id, person_id, unit_id,
     source_event_id, module, type, label,
     owner_type, assigned_role, escalates_to_role,
     status, due_at, priority, severity, inputsLiteral,
     related_id, related_type]
  );
  return r.rows[0];
}

// ════════════════════════════════════════════════════════════════════
//  SHARED CORE SERVICE — satisfyObligation / completeObligation
//
//  The back half of the loop, made shared the same way the front half is.
//  Every module that closes an obligation — leasing, maintenance, money, and
//  the move-in/move-out/deposit obligations to come — goes through THESE, so
//  "how a required input is satisfied" and "how an obligation completes" each
//  live in exactly ONE place. The HTTP routes below call these too.
//
//  Both take an open transaction `client` (like spawnObligationFromEvent) so a
//  caller can satisfy/complete inside its own atomic unit. They THROW typed
//  errors for the gate cases (err.code) so each caller maps them to the right
//  HTTP status without re-implementing the rules:
//    NOT_FOUND       — no such obligation
//    NOT_OUTSTANDING — the input isn't an outstanding required input
//    ALREADY_COMPLETE— completing one that's already complete
//    INPUTS_OUTSTANDING — completing while required_inputs remain (the gate)
// ════════════════════════════════════════════════════════════════════

function obligationError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

// Satisfy ONE required input: record proof as a durable event, remove the
// input from required_inputs. Returns { obligation, satisfied_input, remaining }.
async function satisfyObligation(client, { obligation_id, input, proof = null }) {
  if (!input) throw obligationError("BAD_INPUT", "input is required (which required input this satisfies)");

  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  const outstanding = obligation.required_inputs || [];
  if (!outstanding.includes(input)) {
    throw obligationError("NOT_OUTSTANDING",
      `"${input}" is not an outstanding required input on this obligation`,
      { required_inputs: outstanding });
  }

  // Record the proof as a durable event (same shape the route always used).
  const proofText = (proof == null) ? ""
    : (typeof proof === "string" ? proof : JSON.stringify(proof));
  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,$4,$5)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     `input_satisfied:${input}`,
     proofText ? `${input} provided: ${proofText}` : `${input} provided`]
  );

  const remaining = outstanding.filter(i => i !== input);
  const upd = await client.query(
    `update obligations set required_inputs = $1, updated_at = now()
      where id = $2 returning *`,
    [remaining, obligation_id]
  );

  return { obligation: upd.rows[0], satisfied_input: input, remaining };
}

// Complete an obligation — the proof gate. Refuses (throws) if required_inputs
// remain or it's already complete. Returns the completed obligation row.
async function completeObligation(client, { obligation_id, completed_by = null }) {
  const o = await client.query("select * from obligations where id=$1 for update", [obligation_id]);
  if (o.rows.length === 0) throw obligationError("NOT_FOUND", "obligation not found");
  const obligation = o.rows[0];

  if (obligation.status === "complete") {
    throw obligationError("ALREADY_COMPLETE", "obligation is already complete");
  }

  const outstanding = obligation.required_inputs || [];
  if (outstanding.length > 0) {
    throw obligationError("INPUTS_OUTSTANDING",
      "cannot complete — required inputs are still outstanding",
      { outstanding_inputs: outstanding });
  }

  const r = await client.query(
    `update obligations
        set status = 'complete', completed_at = now(), updated_at = now()
      where id = $1 returning *`,
    [obligation_id]
  );

  await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'obligation_completed',$4)`,
    [obligation.property_id, obligation.person_id, obligation.unit_id,
     `${obligation.type} obligation completed${completed_by ? " by " + completed_by : ""}`]
  );

  return r.rows[0];
}

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
      obligation = await spawnObligationFromEvent(client, {
        property_id: resolvedProperty,
        person_id: person_id ?? null,
        unit_id: unit_id ?? null,
        source_event_id: event.id,
        module: "leasing",
        type: "tour",
        label: "Tour booked — needs an agent to own it",
        owner_type: "human",
        assigned_role: "leasing_agent",
        escalates_to_role: "leasing_agent",
        status: "open",
        due_at: dueAt,
        required_inputs: ["tour_feedback"],
      });
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
// Body: { input, proof? }
//   input — which required input this satisfies (e.g. "tour_feedback")
//   proof — the actual proof (string or object). Stored on a durable event.
// Delegates to the shared satisfyObligation helper — the one place this logic
// lives. The input must currently be in the obligation's required_inputs.
app.patch("/obligations/:id/satisfy", async (req, res) => {
  const { input, proof } = req.body || {};
  if (!input) return res.status(400).json({ error: "input is required (which required input this satisfies)" });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await satisfyObligation(client, { obligation_id: req.params.id, input, proof });
    await client.query("commit");
    res.json({
      ...out.obligation,
      satisfied_input: out.satisfied_input,
      can_complete: out.remaining.length === 0,   // hint for the UI
    });
  } catch (e) {
    await client.query("rollback");
    if (e.code === "NOT_FOUND") return res.status(404).json({ error: e.message });
    if (e.code === "NOT_OUTSTANDING") return res.status(409).json({ error: e.message, required_inputs: e.required_inputs });
    if (e.code === "BAD_INPUT") return res.status(400).json({ error: e.message });
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
  const client = await pool.connect();
  try {
    await client.query("begin");
    const completed = await completeObligation(client, { obligation_id: req.params.id, completed_by });
    await client.query("commit");
    res.json(completed);
  } catch (e) {
    await client.query("rollback");
    if (e.code === "NOT_FOUND") return res.status(404).json({ error: e.message });
    if (e.code === "ALREADY_COMPLETE") return res.status(409).json({ error: e.message });
    if (e.code === "INPUTS_OUTSTANDING") return res.status(409).json({
      error: e.message,
      outstanding_inputs: e.outstanding_inputs,
      hint: "satisfy each required input first (PATCH /obligations/:id/satisfy)",
    });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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
  const d = new Date(dateStr + "T00:00:00Z");
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
    const start = lease.start_date || new Date().toISOString().slice(0, 10);
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
        obligation = await spawnObligationFromEvent(client, {
          property_id: out.property_id,
          person_id: out.tenant_id ?? null,
          module: "collections",
          type: "legal_process",
          label: `Delinquency: ${out.lease_id} is ~${out.days_delinquent}d behind — start legal process`,
          owner_type: "human",
          assigned_role: "property_manager",
          escalates_to_role: "property_manager",
          status: "open",
          priority: "high",
          severity: "high",
          required_inputs: ["legal_review"],
        });
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
    const endMonth = new Date(lease.end_date + "T00:00:00Z").getUTCMonth() + 1;
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
// ════════════════════════════════════════════════════════════════════
//  INGEST v2 — THE COLLAPSE ENGINE
//
//  Replaces the narrow units-only ingest prompt with a LEVELS-AWARE engine.
//  The job is not "parse a rent roll." It is: take messy real-estate material
//  (rent roll, offering memo, broker package, unit mix, pasted text, Excel,
//  CSV, PDF, Word) and collapse it to the deepest reliable structure the
//  document supports — never all-or-nothing.
//
//  Extraction hierarchy (extract to the deepest level the doc supports):
//    L1 Property shell  — name, address, asset type, total units
//    L2 Unit mix        — types, bed/bath, counts by type, market rents
//    L3 Unit schedule   — unit-by-unit rows, status, rents
//    L4 Lease detail    — tenant, dates, in-place rent, deposits, concessions
//    L5 Exceptions      — vacant, down, employee, model, MTM, eviction, offline
//
//  A thin OM that only discloses "24 units: 12 1BR / 12 2BR" is a SUCCESS at
//  L2 — not a failure. The engine reports the level reached and what's missing.
//
//  This UPGRADES the brain and widens the accepted file types. It preserves
//  the proven staged flow (run -> candidates -> approve -> promote) and the
//  ingest_candidates columns unchanged: the unit-level slice still persists
//  exactly as before, so promote/approve keep working. The richer levelled
//  extraction is returned in the API response now; persisting L1/L2/L4/L5 to
//  their own tables is a later migration once the shape is proven in use.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
//  INGEST v2 — THE COLLAPSE ENGINE
//
//  Replaces the narrow units-only ingest prompt with a LEVELS-AWARE engine.
//  The job is not "parse a rent roll." It is: take messy real-estate material
//  (rent roll, offering memo, broker package, unit mix, pasted text, Excel,
//  CSV, PDF, Word) and collapse it to the deepest reliable structure the
//  document supports — never all-or-nothing.
//
//  Extraction hierarchy (extract to the deepest level the doc supports):
//    L1 Property shell  — name, address, asset type, total units
//    L2 Unit mix        — types, bed/bath, counts by type, market rents
//    L3 Unit schedule   — unit-by-unit rows, status, rents
//    L4 Lease detail    — tenant, dates, in-place rent, deposits, concessions
//    L5 Exceptions      — vacant, down, employee, model, MTM, eviction, offline
//
//  A thin OM that only discloses "24 units: 12 1BR / 12 2BR" is a SUCCESS at
//  L2 — not a failure. The engine reports the level reached and what's missing.
//
//  This UPGRADES the brain and widens the accepted file types. It preserves
//  the proven staged flow (run -> candidates -> approve -> promote) and the
//  ingest_candidates columns unchanged: the unit-level slice still persists
//  exactly as before, so promote/approve keep working. The richer levelled
//  extraction is returned in the API response now; persisting L1/L2/L4/L5 to
//  their own tables is a later migration once the shape is proven in use.
// ════════════════════════════════════════════════════════════════════

const INGEST_MODEL = process.env.INGEST_MODEL || "claude-sonnet-4-6";

// ── THE COLLAPSE PROMPT ───────────────────────────────────────────────
function ingestPrompt(text) {
  return `You are the extraction engine for a property-management platform. You read ONE piece of real-estate material and COLLAPSE it to the clean structure underneath. The source may be a rent roll, an offering memorandum, a broker package, a property-management report, a unit-mix table, or pasted text — flattened from Excel/CSV/PDF/Word or pasted by hand. Formats vary wildly (AppFolio, Yardi Breeze, Yardi Voyager, broker OMs, student-housing schedules). Read it the way an experienced operator would.

YOUR FIRST OBLIGATION IS NOT PERFECTION — it is to find the highest-confidence useful truth in the document, at whatever depth it supports. Never fail just because the document is incomplete. Extract to the DEEPEST reliable level:
  L1 Property shell: property name, address, asset type, total unit count.
  L2 Unit mix: unit types, bed/bath counts, count of each type, market/asking rents if present.
  L3 Unit schedule: unit-by-unit rows — unit number, floorplan, status, rent.
  L4 Lease detail: tenant name, lease start/end, in-place rent, deposit, concessions, prelease/renewal status.
  L5 Exceptions: vacant, down/offline, employee, model, month-to-month, eviction, non-revenue, unknown.

Report the deepest level you reliably reached in "level_reached".

DETECT THE SOURCE SYSTEM FIRST, then apply its column map. Known systems and their telltales:
- AppFolio: title "Rent Roll"; a dedicated "Status" COLUMN with values like "Current" / "Vacant-Unrented"; columns Unit, Tenant, Status, Rent (single rent, no market/actual split), Deposit, "Lease From", "Lease To"; footer like "107 Units 95.3% Occupied". No resident IDs, no SqFt, no charge columns. By-bed units written as "101 - 1".
- Entrata (PeakMade and other Entrata-based managers): report template label "AME - Budgeted Rent (ACCT)" at top of every page; footer "Rent Roll 3.7 generated <timestamp> MDT and data as of <timestamp> MDT"; section labels "Unit Details" then "Future Resident Details" then "Average Charges by Unit Type Summary"; plain-English unit types ("Studio","1x1","2x2"); NO resident ID codes (names only, "Last, First"). Columns: "Bldg-Unit" (unit, no leading zeros e.g. "101"), "Unit Type", "SQFT", "Unit Status" (dedicated column), "Resident" (name or "-- Vacant --"), "Budgeted Rent", "Scheduled Charges", "Balance" (negatives in parens), "Deposit Held", "Move-In", "Lease Start", "Lease End", "Expected Move-Out". ENTRATA RENT MAPPING: "Budgeted Rent" -> market_rent (pro-forma/market); "Scheduled Charges" -> actual_rent (what's actually billed in place). "Unit Status" vocabulary maps: "Occupied No Notice"->active; "Notice Rented"/"Notice Unrented"->active (on notice, still occupied); "Vacant Rented Ready"/"Vacant Rented"->vacant (pre-leased, note it); "Vacant Unrented Ready"->vacant; "-- Vacant --"->vacant. ENTRATA PARSING WARNING: resident names and statuses WRAP across 2-3 physical text lines, and vacant units show "-- Vacant --" in the Resident column — do NOT treat a wrapped continuation line as a separate unit; associate wrapped text with the unit row it belongs to.
- Yardi Breeze: header "Property = <name>"; "As Of =" + "Month ="; columns Unit, "Unit SqFt", "Tenant Name", "Actual Rent", "Actual Rent per Sqft", "Tenant Deposit", "Other Deposit", "Misc" (single ancillary bucket, not itemized), "Misc per Sqft", "Move In", "Lease Expiration", "Move Out", "Balance". Status via SECTION HEADERS ("Current/Notice/Vacant Tenants" vs "Future Tenants/Applicants"). The "per Sqft" analytic columns are the giveaway.
- Yardi Voyager (by-unit): header "<name> (1325)"; resident IDs like "t0002191"; unit-type codes like "ut000011"; columns Unit, "Unit Type", "Unit Sq Ft", "Resident" (ID), "Name", "Market Rent", "Actual Rent", "Resident Deposit", "Other", "Move In", "Lease Expiration", "Move Out", "Balance". Status via section headers ("Current/Notice/Vacant Residents" vs "Future Residents/Applicants"); footer "Summary Groups" with "% Unit Occupancy".
- Yardi Voyager (by-room/bed, student housing): header "(crm…)" + a "Summarize By = Room|Bed" line; student IDs like "s0003894"; columns Unit, "Room", "Bed", "Unit/Room Type" (e.g. STU00011), "Resident" (name + s# or VACANT), "Sq Ft", "Market Rent", "Actual Rent", deposits, "Move In", "Lease From", "Lease To", "Move Out", "Balance"; footer "Summary Groups" with "# Of Beds" / "% Bed Occupancy".
- Seller/handoff roll: title often "Rent Roll Analysis"; columns "Tenant Name", "Unit", "Unit Type" (floorplan like "2BR/2BA"), "Rent", "Security Deposit", "Move In/Out", "Lease Start/End"; names as "Last, First". This is what a SELLER hands over at acquisition — a distinct shape.
Put your best guess in detected_system; if none match, "unknown" and read it generically.

CHARGE CODES & CREDITS: some systems (Entrata especially) itemize ancillary charges and CREDITS in a summary block — e.g. "Admin Fees", "Amenity Premium", "Application Fee", "Late Charges", and credits like "Employee Unit Rent Credit" or "Model" shown as NEGATIVE. When a unit's rent figure is a net of such codes, the base residential rent is what matters for actual_rent — do not let a credit line (employee/model) read as the unit's market rent; flag those units' status accordingly (employee/model) and note it.

PROPERTY IDENTITY: the ADDRESS is the stable identity of a property — NOT its name. The same building is often renamed over time (e.g. "SOLO on Chestnut" -> "Uno on Chestnut") and its system database code changes. Always capture the address in property.address; treat the marketing name as a label that can change.

NORMALIZE across formats:
- Many docs have multiple rent columns ("Pre-Lease Rent" vs "In-Place Rent", "Market Rent" vs "Actual Rent"). Map the CURRENT contract/in-place rent to actual_rent, and the asking/market/pre-lease rent to market_rent. If only one rent exists and the doc is a rent roll, it's actual_rent; if it's an OM, it's market_rent (asking).
- STATUS lives in different places by system — derive it from EITHER a "Status" column (AppFolio: "Current"->active, "Vacant-Unrented"->vacant) OR the SECTION HEADER a row sits under (Yardi: rows under "Current/Notice/Vacant …" are active unless the name is VACANT). Normalize to: active | vacant | down | employee | model | mtm | eviction | non_revenue | unknown. Also map "Occupied"->active, "Available"->vacant, "Down"->down, "Employee"->employee, "Model"->model, "MTM"/"Month to Month"->mtm.
- FORWARD-LOOKING UNITS — THE REVENUE-SPINE RULE. The rent roll is not a flat snapshot; it carries what is true TODAY plus what is already SCHEDULED. A single unit can hold more than one true fact: it can be VACANT today yet have a future resident pre-leased into it; it can be OCCUPIED today yet on notice with a move-out scheduled. NEVER collapse a future fact into the current status, and NEVER overwrite the current row with the future one. The SAME unit number can appear twice in a file — once under "Current/Notice/Vacant" and again under "Future Residents/Applicants" (or Entrata's "Future Resident Details"). When that happens, emit the unit ONCE: its top-level status/rent/tenant = the CURRENT-section fact (e.g. vacant), and attach the future-section fact to a "future_events" array on that unit. Do not emit "future" as a status. A row that appears ONLY under a future/applicants section (no current-section counterpart) is a future_event on its unit with current status vacant.
  future_events[] entries look like: { "type": "scheduled_move_in" | "scheduled_move_out" | "renewal" | "rent_change", "tenant_name": "...", "rent": 0, "lease_start": "YYYY-MM-DD", "lease_end": "YYYY-MM-DD" } — include ONLY the fields each event actually has.
- Unit numbers are STRINGS — preserve exactly, including leading zeros ("0101") and alphanumerics ("1F","2R","BR","1325-101").
- ROOM/BED is first-class for student / by-the-bed housing. When the roll has Room and/or Bed columns (or beds leased individually), capture room and bed per row. The bed — not the unit — is the leasable atom; one lease can be one bed.
- PHANTOM ROWS: either Yardi config emits a second row at "0.00" Actual Rent when one resident holds a whole unit (the extra room/bed rows). Do NOT count a 0.00-rent phantom row as a separate lease or as a vacant bed — attribute it to the same resident/lease.
- DO NOT trust filenames or folder names for the reporting period. Take snapshot_date ONLY from the in-file date line ("As Of =", "As of:", "As of"). If there is no in-file date, snapshot_date is null — never infer it from context.
- Itemized charges (parking, pet, insurance) captured separately when present. Breeze lumps ancillary into one "Misc" column — capture it as a single misc charge, not as rent. AppFolio has none. Never fold ancillary into rent.

PROVENANCE — every extracted unit carries prov:
- "confirmed" = read directly from a clear row/section (a bedroom count from a clear "Unit Type" header IS a direct read, not a guess).
- "assumed" = genuine ambiguity: bedrooms with no source, no rent anywhere, a value inferred from an OM's marketing claim, a non-residential/placeholder line, an unparseable unit number, or conflicting values. An offering memo's rents are asking CLAIMS => assumed.

HARD RULES:
- NEVER invent a value. No support => null. A wrong confident value is worse than an honest blank. This is the most important rule.
- Only residential units. Ignore titles, column headers, divider lines, subtotals, any line containing "Total", metadata rows, blanks.
- Parking/storage/retail/amenity lines are NOT units — put their raw line in "unclear".
- If you cannot tell whether a row is a unit, do NOT invent it — raw line into "unclear".
- If the document has NO reliable property/unit signal at all, say so: set level_reached to "none" and explain in "missing".

TOP OF THE STRUCTURE IS NOT ALWAYS ONE PROPERTY. A single file can describe a DEAL / PORTFOLIO — one transaction covering MANY separate properties (separate street addresses). An offering memorandum (OM) for a portfolio is the prime example. The real hierarchy is: file -> deal/portfolio -> properties -> units. Decide first which case you are in:
  • SINGLE PROPERTY: one building / one address (a normal rent roll, a single-asset OM). Emit the flat "property" + "units" shape (the classic shape, unchanged).
  • DEAL / PORTFOLIO: a named offering covering multiple addresses (e.g. "Philadelphia Family Housing Portfolio — 83 units, 284 beds, 28 properties"). Emit the "deal" shape: a deal shell plus a "subject_properties" array, with each property's units nested UNDER it.

SUBJECT vs COMP — THE MOST IMPORTANT ROUTING DECISION IN AN OM. An OM contains the asset being SOLD (the SUBJECT) and also reference material that must NEVER be treated as part of the asset:
  • SUBJECT properties/units: the actual real estate being offered for sale. In a portfolio OM these are listed in the "portfolio overview", the "portfolio rent roll", the "unit mix", and the per-address tax/financial tables. These are the ONLY things that matter for this workflow.
  • COMPS and other NOISE: "Sale comparables" / "sale comps", "Lease comparables" / "lease comps", market-survey tables, surrounding-area statistics, broker contact pages, lender names, maps, photos, market commentary, university/enrollment data. These are OTHER people's buildings or context — shown only for pricing/market color. A sale comp like "2233 N 20th Street, 38 units" is NOT a subject property and its 38 units are NOT subject units.

ROUTING RULE FOR THIS WORKFLOW: capture SUBJECT properties and SUBJECT units ONLY. You MUST still RECOGNIZE a comp well enough to KNOW it is a comp (so it is not mistaken for a subject) — but once recognized, DROP it. Do NOT list comp properties, comp units, broker/lender/market addresses, or market tables in the output. Do NOT spend effort itemizing sale comps or lease comps. The cost of a comp leaking in as a subject is severe (a stranger's building becomes a fake property); the cost of omitting a comp is zero for this workflow. When in genuine doubt whether an address is subject or comp, prefer to EXCLUDE it and note the ambiguity in "missing".
  Telltales that an address is a SUBJECT: it appears in the portfolio overview / portfolio rent roll / unit-mix / per-address tax table; it is inside the offering's own address list; the doc's unit and bed totals are built from it.
  Telltales that an address is a COMP / NOISE: it sits under a heading containing "comparable", "comp", "sale comp", "lease comp", "market", "survey"; it has a Sale Price / Price-Per-Unit / Cap Rate / "leased at sale" / "Seller / Buyer" line; it is a named complex used for rent comparison; it is a broker office or lender address.

DEAL-LEVEL FINANCIAL TABLES: a portfolio OM carries deal-wide financial tables — a tax/assessment table (per-address assessed values + tax bills), a stabilized income & expense (I&E / NOI) summary, an offering price. These belong to the DEAL, not to any one unit. Identify them and place them in "deal.financial_tables" by name with their headline figures. Do NOT force their numbers into units. If a per-address figure (e.g. a tax bill) can be matched to a subject property, you may note it on that property; otherwise keep it at deal level.

OUTPUT SIZE — CRITICAL FOR LARGE ROLLS: Keep the JSON as SMALL as possible. OMIT any field whose value is null, empty, or unknown — do NOT write it out. Only include fields you actually found a value for. The ONLY always-required field per unit is "unit_number"; include "prov" too, and any of the other fields ONLY when they have a real value. This keeps a 100+ unit roll inside one response. The server fills any omitted field with null after parsing, so leaving a field out is exactly equivalent to null — but far smaller.

Return ONLY valid JSON, no prose, no markdown fences. OMIT every field that would be null/empty. There are TWO top-level shapes; choose ONE:

(A) SINGLE PROPERTY — the classic shape (use for a normal rent roll or single-asset doc):
{
  "document_type": "rent_roll | offering_memo | unit_mix | broker_package | pm_report | unknown",
  "detected_system": "appfolio | yardi_breeze | yardi_voyager | entrata | broker_om | student_schedule | seller_handoff | unknown",
  "scope": "single_property",
  "level_reached": "L1 | L2 | L3 | L4 | L5 | none",
  "snapshot_date": "YYYY-MM-DD (omit if none)",
  "property": { "name": "...", "address": "...", "asset_type": "...", "total_units": 0 },
  "unit_mix": [ { "unit_type": "", "bedrooms": 0, "bathrooms": 0, "count": 0, "market_rent": 0 } ],
  "units": [
    { "unit_number": "REQUIRED", "status": "active|vacant|down|employee|model|mtm|eviction|non_revenue|unknown",
      "prov": "confirmed|assumed",
      "...include ONLY fields with real values from this set": "room, bed, address, bedrooms, bathrooms, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, resident_code, deposit, balance, note",
      "future_events": "OMIT unless the unit has a scheduled future move-in/out/renewal; array of { type, tenant_name, rent, lease_start, lease_end }" }
  ],
  "missing": [ "what a buyer/operator would still need that this doc didn't provide" ],
  "unclear": [ "raw lines seen but not placed" ]
}

(B) DEAL / PORTFOLIO — use when ONE transaction covers MANY addresses. SUBJECT properties only; comps DROPPED:
{
  "document_type": "offering_memo | broker_package | ...",
  "detected_system": "broker_om | ...",
  "scope": "deal_portfolio",
  "level_reached": "L1 | L2 | L3 | L4 | L5",
  "snapshot_date": "YYYY-MM-DD (omit if none — e.g. the rent roll 'As of' date)",
  "deal": {
    "name": "The Philadelphia Family Housing Portfolio",
    "broker": "Avison Young (omit if none)",
    "location": "Philadelphia, PA",
    "asset_type": "student / affordable / multifamily ...",
    "stated_totals": { "properties": 28, "units": 83, "beds": 284, "occupancy": "57.8%", "in_place_avg_rent": 1696 },
    "financial_tables": [
      { "name": "tax_underwriting", "note": "per-address assessed values + tax bills", "total_prior_assessed": 17745300, "total_new_assessed": 14927500, "total_tax_bill": 208955.15 },
      { "name": "stabilized_ie", "gross_potential_rent": 2133405, "noi": 1111653 }
    ]
  },
  "subject_properties": [
    {
      "address": "1711 W Montgomery Avenue",   // ADDRESS is identity; REQUIRED per property
      "prov": "confirmed|assumed",
      "...optional property fields with real values": "name, total_units, total_beds, tax_bill, assessed_value, note",
      "units": [
        { "unit_number": "REQUIRED (e.g. 'A','1A')",
          "status": "active|vacant|...",
          "prov": "confirmed|assumed",
          "...include ONLY fields with real values": "bedrooms, bathrooms, room, bed, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, deposit, balance, note",
          "future_events": "OMIT unless scheduled; array of { type, tenant_name, rent, lease_start, lease_end }" }
      ]
    }
  ],
  "comps_seen": 0,    // COUNT of comp properties you recognized and DROPPED (do NOT list them) — proves you saw and excluded them
  "missing": [ "subject-level info a buyer would still need" ],
  "unclear": [ "raw lines you could not confidently route to a subject property" ]
}
RULES FOR SHAPE (B): every subject property MUST have an "address" (identity). Each unit is nested UNDER its property, so a unit number like "A" is unique within its property. In a rent roll, in-place rent -> actual_rent and the asking/market-rate column -> market_rent. Report ONLY subject properties in "subject_properties". Comps are NEVER listed — only COUNTED in "comps_seen". Set "level_reached" to the deepest level reached for the subject (a full per-unit subject rent roll is L4).
Example of ONE slim subject unit: {"unit_number":"A","status":"active","prov":"confirmed","bedrooms":4,"bathrooms":4,"actual_rent":1950,"market_rent":2461,"note":"In-place per bed $488"}

Source material:
"""
${text}
"""`;
}

// ══════════════════════════════════════════════════════════════════════
//  THE PLANNER — plan → targeted extract → merge/reconcile
//
//  The durable path for documents too large for one pass. The architecture,
//  per design: a real-estate document must be UNDERSTOOD before it is
//  extracted. Blind chunking would solve the token problem while creating a
//  worse one — a comp section, a market table, and a subject rent roll all
//  contain addresses, unit counts, and rents; without document-level context
//  a chunk of comps looks just like a chunk of subjects, and the system would
//  promote a stranger's building as a real property.
//
//  So we do NOT split blindly. We:
//    1. PLAN — one small pass reads the whole doc and returns a compact MAP:
//       scope, deal name, stated totals, and the SUBJECT property groups with
//       their verbatim addresses. No unit detail. Tiny even for 200+ units.
//    2. EXTRACT — one pass per batch of subject addresses, each carrying the
//       plan so it knows "these are subjects, everything else here is context."
//       Output per call stays small because each returns only its batch.
//    3. RECONCILE — merge server-side by deal+address+unit, then check the
//       extracted counts against the plan's stated totals. Discrepancies go to
//       review; nothing is silently "fixed", nothing auto-creates, comps never
//       enter the candidate pipeline.
// ══════════════════════════════════════════════════════════════════════

// ── PHASE 1 PROMPT: the document plan (compact map, NO unit detail) ──────
function planPrompt(text) {
  return `You are the planning stage of a real-estate document pipeline. Read the WHOLE document and produce a COMPACT MAP of what it is and where the SUBJECT real estate lives — NOT the unit-level data. A later stage extracts the units; your job is to tell it what matters, what is subject, and what is noise.

CRITICAL DISTINCTION — SUBJECT vs NOISE. A document (especially an offering memorandum) mixes the asset being SOLD (the SUBJECT) with reference material that must NEVER be treated as the asset:
  • SUBJECT: the actual properties offered for sale — listed in the portfolio overview, rent roll, unit-mix, per-address tax table.
  • NOISE: "sale comparables", "lease comparables", "market rent survey", competitive-property tables, broker/lender contacts, university/market commentary, maps, photos. These contain addresses and rents too, but they are OTHER people's buildings or context.
A comp like "2233 N 20th Street, 38 units" is NOISE, not a subject. Identify it well enough to EXCLUDE it.

You MUST list every SUBJECT property address verbatim, because the next stage extracts units only for the addresses you name here. If you miss a subject address, its units are lost. If you wrongly include a comp address, a stranger's building gets promoted. Be exact.

Keep the output SMALL. Do NOT output units, rents, or per-unit rows. Output ONLY the map.

Return ONLY valid JSON, no prose, no fences:
{
  "document_type": "offering_memo | rent_roll | broker_package | unit_mix | pm_report | unknown",
  "detected_system": "broker_om | appfolio | yardi_breeze | yardi_voyager | entrata | student_schedule | seller_handoff | unknown",
  "scope": "single_property | deal_portfolio",
  "deal": {
    "name": "portfolio/deal name (omit if single property)",
    "broker": "omit if none",
    "location": "city, state",
    "asset_type": "student | affordable | multifamily | ...",
    "stated_totals": { "properties": 0, "units": 0, "beds": 0, "offering_price": 0, "noi": 0 }
  },
  "subject_addresses": [ "1414 Diamond Street", "1418 Diamond Street", "..." ],
  "financial_tables_present": [ "tax_summary", "pro_forma_noi", "stabilized_ie", "..." ],
  "comp_sections_present": [ "sale_comparables", "lease_comparables", "market_rent_survey" ],
  "comps_seen": 0,
  "notes": [ "anything the extractor should know — e.g. 'rent schedule spans pages 16-21', 'units labeled like 1F/1R/2F'" ]
}
For a SINGLE property, set scope "single_property", omit "deal", and put the one address in subject_addresses.
"subject_addresses" must contain ONLY subject properties. "comps_seen" is the COUNT of comp/competitive properties you saw and excluded.

Document:
"""
${text}
"""`;
}

// ── PHASE 2 PROMPT: targeted extraction for ONE batch of subject addresses ─
// The plan travels with the call so the model keeps document-level context:
// it knows these addresses are SUBJECTS and that other addresses in the same
// text are comps/noise to ignore.
function extractGroupPrompt(text, plan, addresses) {
  const dealName = (plan.deal && plan.deal.name) || "(single property)";
  return `You are the extraction stage of a real-estate document pipeline. A planning stage has already mapped this document. Your job: extract FULL per-unit detail for ONLY the SUBJECT addresses listed below, using the whole document for context but ignoring everything that is not one of these addresses.

DOCUMENT CONTEXT (from the planner — trust it):
  Deal: ${dealName}
  Document type: ${plan.document_type || "unknown"}
  Detected system: ${plan.detected_system || "unknown"}
  This document also contains comp/market/broker material — that is NOISE. Do NOT extract it.

EXTRACT UNITS ONLY FOR THESE SUBJECT ADDRESSES (extract every one that appears in the text):
${addresses.map(a => "  • " + a).join("\n")}

RULES:
- For each address above, find its units in the rent roll / unit schedule and extract them at the deepest reliable level (unit number, status, beds, baths, sqft, rents, lease dates, tenant).
- A unit number like "A", "1F", "Unit 2" is unique only WITHIN its property — keep each unit under its address.
- In-place/current rent → actual_rent; asking/market/pre-lease rent → market_rent. Vacant units have no actual_rent.
- Status vocabulary → active | vacant | down | employee | model | mtm | non_revenue | unknown. "Occupied"→active, "Available"/"Vacant"→vacant, "Down"→down, "Employee"→employee.
- FORWARD-LOOKING UNITS: a unit can be vacant/occupied TODAY and also have a SCHEDULED future move-in, move-out, or renewal. Do NOT collapse a future fact into status and do NOT emit "future" as a status. If the same unit appears under both a current section and a "Future Residents/Applicants" section, emit it ONCE with the CURRENT fact as its status/rent/tenant and attach the future fact to a "future_events" array. A unit appearing only in a future section is vacant now with a future_event.
- NEVER invent a value. No support → omit the field. Do NOT extract any address that is not in the list above. Do NOT extract comp/market/survey rows.
- Unit numbers are STRINGS — preserve exactly (leading zeros, "1F", "BR").

OUTPUT — keep it SMALL, omit null/empty fields. Return ONLY valid JSON, no prose, no fences:
{
  "properties": [
    {
      "address": "exact subject address from the list",
      "prov": "confirmed|assumed",
      "units": [
        { "unit_number": "REQUIRED", "status": "...", "prov": "confirmed|assumed",
          "...only fields with real values": "bedrooms, bathrooms, square_feet, market_rent, actual_rent, lease_start, lease_end, tenant_name, deposit, balance, note",
          "future_events": "OMIT unless scheduled; array of { type, tenant_name, rent, lease_start, lease_end }" }
      ]
    }
  ],
  "unclear": [ "rows you could not confidently place under one of the listed addresses" ]
}

Document:
"""
${text}
"""`;
}

// ── normalization for merge keys ──────────────────────────────────────
// Addresses must match across the plan and the extraction passes even with
// cosmetic differences ("1414 Diamond Street" vs "1414 W Diamond St"). We
// normalize conservatively: lowercase, collapse whitespace, strip common
// suffixes/directionals to a canonical core. This is for KEY MATCHING only —
// the display address is always the verbatim one from extraction.
function normalizeAddress(addr) {
  if (!addr) return "";
  let s = String(addr).toLowerCase().trim();
  s = s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  // directional + street-type canonicalization
  const repl = [
    [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"], [/\beast\b/g, "e"], [/\bwest\b/g, "w"],
    [/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\bav\b/g, "ave"],
    [/\bplace\b/g, "pl"], [/\bdrive\b/g, "dr"], [/\bboulevard\b/g, "blvd"],
    [/\broad\b/g, "rd"], [/\bcourt\b/g, "ct"], [/\blane\b/g, "ln"],
  ];
  for (const [re, to] of repl) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

// LOOSE address key — the fallback when exact normalized keys miss. A document
// can name the same building two ways across sections: the overview says
// "1414 Diamond Street", the rent schedule says "1414 W Diamond St". Exact
// normalization can canonicalize a directional that's PRESENT in both, but it
// can't add a "W" one source omits — so those keys won't match and the
// property looks empty. This key strips directionals and street-types entirely,
// keeping just the house number + the alphabetic street core, so
// "1414 diamond" == "1414 w diamond". Used ONLY as a fallback after an exact
// miss, to avoid collapsing genuinely-different addresses.
function looseAddressKey(addr) {
  if (!addr) return "";
  let s = normalizeAddress(addr);
  // drop leading-or-trailing directionals and common street types
  s = s.replace(/\b(n|s|e|w|ne|nw|se|sw)\b/g, " ");
  s = s.replace(/\b(st|ave|pl|dr|blvd|rd|ct|ln|ter|way|cir|pkwy)\b/g, " ");
  // keep house number + remaining word stems
  s = s.replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

// Batch the subject addresses so each extraction call's OUTPUT stays well under
// the token ceiling. Student OMs run ~8 units/property; ~10 properties/batch
// keeps a batch around 80 units of detail — comfortably one-pass sized.
function batchAddresses(addresses, perBatch = 10) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += perBatch) {
    batches.push(addresses.slice(i, i + perBatch));
  }
  return batches;
}

// ── extraction_result: the normalized, read-only middle layer ─────────
// The stable contract between raw model output and the candidate workflow.
//
//   model_raw_output        = raw model transcript (audit/debug)
//   extraction_result       = normalized read-only extraction  ← THIS
//   ready_for_promotion / needs_review = candidate workflow
//   canonical units/leases  = created only on promote
//
// It is built from the SAME parsed model output already in hand — no extra
// model call, no DB write, no candidate touched. It CREATES nothing, maps
// nothing into the database, and does NOT pull forward the promote/mapping
// build. One consistent shape for single property AND deal/portfolio:
//   single  → properties:[ one ], deal:null
//   deal    → properties:[ many ], deal:{…}
// The scorer and (later) the review UI read THIS, never the raw transcript.
//
// Field names mirror what the brain emits TODAY (omit-when-null sparse rows);
// per-unit always carries unit_number + prov. Richer flags from the roadmap
// contract (is_future, is_phantom_bed, charges[]) slot in for free once the
// brain emits them — everything is omit-when-null, so absence breaks nothing.
function buildExtractionResult(parsed, isDeal, subjectProperties) {
  const cleanUnits = (arr) => (Array.isArray(arr) ? arr : []).map(u => {
    // pass through only real values; drop internal staging tags
    const { _property_address, ...rest } = u || {};
    return rest;
  });
  const properties = isDeal
    ? (Array.isArray(subjectProperties) ? subjectProperties : []).map(sp => ({
        address: sp.address ?? sp.name ?? null,
        prov: sp.prov ?? "assumed",
        units: cleanUnits(sp.units),
      }))
    : [{
        address: parsed.property?.address ?? null,
        prov: parsed.property ? "confirmed" : "assumed",
        units: cleanUnits(parsed.units),
      }];
  return {
    scope: isDeal ? "deal_portfolio" : "single_property",
    document_type: parsed.document_type ?? "unknown",
    detected_system: parsed.detected_system ?? "unknown",
    level_reached: parsed.level_reached ?? "none",
    snapshot_date: parsed.snapshot_date ?? null,
    deal: isDeal ? (parsed.deal ?? null) : null,
    properties,
    unit_mix: Array.isArray(parsed.unit_mix) ? parsed.unit_mix : [],
    comps_seen: isDeal ? (Number.isFinite(parsed.comps_seen) ? parsed.comps_seen : 0) : null,
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    unclear: Array.isArray(parsed.unclear) ? parsed.unclear : [],
  };
}

// ── SHARED COLLAPSE PIPELINE ──────────────────────────────────────────
// Preserves the proven staged flow. The levelled extraction is returned in
// full; the unit slice persists into ingest_candidates exactly as before.
async function runIngest(propertyId, sourceText, kind) {
  // Output ceiling. The 16k we shipped with was a conservative floor, not the
  // model's real limit — Sonnet can return far more. We push it to a high
  // practical ceiling so large OMs (150+ units, full L4 detail) clear in one
  // pass. MAX_INGEST_TOKENS lets us tune on Render without a code change.
  // This is the BRIDGE: one-pass handles most docs; the planner (plan ->
  // targeted extract -> reconcile) is the durable path for anything bigger.
  const MAX_OUTPUT_TOKENS = parseInt(process.env.MAX_INGEST_TOKENS, 10) || 64000;
  const ai = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: ingestPrompt(sourceText) }],
  });

  const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();

  // TRUNCATION DETECTION — the honest failure. If the model hit the output
  // ceiling, stop_reason is "max_tokens" and the JSON is cut off mid-token.
  // Rather than a cryptic parse error, say plainly that the document outgrew
  // one-pass extraction and needs the planner. This is what makes the bridge
  // a bridge and not a trap: the system KNOWS when it has outgrown one pass.
  if (ai.stop_reason === "max_tokens") {
    const err = new Error(
      "This document is too large for single-pass extraction — the response hit the output ceiling and was cut off. " +
      "It needs the document-planning pipeline (plan → targeted subject extraction → reconcile), which isn't built yet. " +
      "Smaller files and most single/medium portfolios still ingest in one pass."
    );
    err.raw = rawOutput;
    err.truncated = true;
    throw err;
  }

  let raw = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch {
    // A parse failure with no max_tokens stop is a genuinely malformed
    // response, not a size problem — keep it distinct from truncation.
    const err = new Error("AI returned unparseable output (not a size limit — the response was malformed).");
    err.raw = rawOutput;
    err.unparseable = true;
    throw err;
  }

  const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];
  const missing = Array.isArray(parsed.missing) ? parsed.missing : [];

  // ── Decide the shape. A deal/portfolio nests units under subject_properties;
  //    a single property returns a flat units[]. We FLATTEN subject units into
  //    the SAME candidate pipeline so approve/promote is unchanged — but we
  //    stamp each candidate with its property address so a unit number like "A"
  //    stays traceable to its building. COMPS are never here: the brain dropped
  //    them upstream and only COUNTED them in comps_seen.
  const isDeal = parsed.scope === "deal_portfolio" || Array.isArray(parsed.subject_properties);
  const subjectProperties = Array.isArray(parsed.subject_properties) ? parsed.subject_properties : [];

  // stagingUnits = the flat list that becomes candidates. Each carries an
  // optional _property_address (deal case) for the candidate note.
  let stagingUnits = [];
  if (isDeal) {
    for (const sp of subjectProperties) {
      const addr = sp.address || sp.name || null;
      const us = Array.isArray(sp.units) ? sp.units : [];
      for (const u of us) stagingUnits.push({ ...u, _property_address: addr });
    }
  } else {
    stagingUnits = Array.isArray(parsed.units) ? parsed.units : [];
  }

  const unitMix = Array.isArray(parsed.unit_mix) ? parsed.unit_mix : [];

  // Persist the run — verbatim input, raw model output, model id (provenance anchor).
  // candidate_count counts the SUBJECT units staged (comps excluded by design).
  const runRes = await pool.query(
    `insert into ingest_runs
       (property_id, kind, source_text, model_id, model_raw_output, candidate_count, unclear)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [propertyId, kind, sourceText, INGEST_MODEL, rawOutput, stagingUnits.length, unclear]
  );
  const run = runRes.rows[0];

  // Stage every SUBJECT unit as a candidate — SAME columns, SAME decision semantics.
  // market_rent persisted = actual_rent if present, else market_rent (so a rent
  // roll keeps in-place rent and an OM keeps asking rent — one column, correct
  // value). In a deal, the property address is prepended to the note so the
  // reviewer can see which building each "A"/"1A" belongs to. The richer graph
  // rides along in model_raw_output until a later migration gives it tables.
  const candidates = [];
  for (const u of stagingUnits) {
    const hasNumber = !!u.unit_number;
    const prov = (u.prov === "confirmed" && hasNumber) ? "confirmed" : "assumed";
    const decision = (prov === "confirmed") ? "ready_for_promotion" : "pending";
    const addrTag = u._property_address ? `[${u._property_address}] ` : "";
    const baseNote = !hasNumber ? "no unit number" : (u.note || null);
    const note = (addrTag && baseNote) ? addrTag + baseNote : (addrTag ? addrTag.trim() : baseNote);
    const rentToStore = (u.actual_rent != null) ? u.actual_rent : (u.market_rent ?? null);
    const c = await pool.query(
      `insert into ingest_candidates
         (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [run.id, propertyId, hasNumber ? String(u.unit_number) : null,
       u.bedrooms ?? null, rentToStore, prov, note, decision]
    );
    candidates.push(c.rows[0]);
  }

  // ── One clean human-facing summary line, scope-aware. ──
  const compsSeen = Number.isFinite(parsed.comps_seen) ? parsed.comps_seen : 0;
  let summary;
  if (isDeal) {
    const propWord = subjectProperties.length === 1 ? "subject property" : "subject properties";
    summary = `I found one portfolio with ${subjectProperties.length} ${propWord} and ${candidates.length} subject units. These are the only items staged for review.`
      + (compsSeen ? ` (${compsSeen} comparable propertie${compsSeen === 1 ? "" : "s"} were recognized and ignored.)` : "");
  } else {
    summary = `Single property. ${candidates.length} unit${candidates.length === 1 ? "" : "s"} staged for review.`;
  }

  return {
    run_id: run.id,
    document_type: parsed.document_type || "unknown",
    detected_system: parsed.detected_system || "unknown",
    scope: isDeal ? "deal_portfolio" : "single_property",
    level_reached: parsed.level_reached || "none",
    snapshot_date: parsed.snapshot_date || null,
    summary,
    // single-property fields (null in a deal)
    property: isDeal ? null : (parsed.property || null),
    unit_mix: unitMix,
    // deal fields (null in a single property) — returned now, persisted later
    deal: isDeal ? (parsed.deal || null) : null,
    subject_property_count: isDeal ? subjectProperties.length : null,
    subject_properties: isDeal ? subjectProperties : null,  // full graph (units nested)
    comps_seen: isDeal ? compsSeen : null,
    // ── the normalized read-only contract layer (single + deal share one shape) ──
    extraction_result: buildExtractionResult(parsed, isDeal, subjectProperties),
    candidate_count: candidates.length,
    ready_for_promotion: candidates.filter(c => c.decision_status === "ready_for_promotion"),
    needs_review: candidates.filter(c => c.decision_status === "pending"),
    missing,
    unclear,
    note: "Subject assets only. Comps are recognized and dropped — never staged. Nothing written to units yet. AI-confident rows are 'ready_for_promotion'; a human approves (POST /ingest/:runId/approve), then POST /ingest/:runId/promote creates units. extraction_result is the normalized read-only view — it persists nothing.",
  };
}

// ══════════════════════════════════════════════════════════════════════
//  PLANNER ORCHESTRATION — plan → targeted extract → merge/reconcile
//
//  Used when one-pass truncates (or when forced). Same staged output contract
//  as runIngest so the review/approve/promote flow downstream is unchanged.
//  Output-only: nothing auto-writes to units; comps never become candidates;
//  reconciliation surfaces discrepancies for review rather than fixing them.
// ══════════════════════════════════════════════════════════════════════

// small helper: call the model, strip fences, parse, with truncation awareness
async function callModelJSON(prompt, maxTokens, label) {
  const ai = await anthropic.messages.create({
    model: INGEST_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const rawOutput = (ai.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (ai.stop_reason === "max_tokens") {
    const hint = label === "Extract"
      ? " A single extraction batch was too large — lower PLAN_PER_BATCH (env var) so fewer properties are extracted per pass."
      : "";
    const err = new Error(`${label} stage hit the output ceiling — batch too large.${hint}`);
    err.raw = rawOutput; err.truncated = true; err.stage = label;
    throw err;
  }
  const cleaned = rawOutput.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return { parsed: JSON.parse(cleaned), raw: rawOutput }; }
  catch {
    const err = new Error(`${label} stage returned unparseable JSON.`);
    err.raw = rawOutput; err.unparseable = true; err.stage = label;
    throw err;
  }
}

async function runIngestPlanned(propertyId, sourceText, kind) {
  const PLAN_TOKENS    = parseInt(process.env.PLAN_TOKENS, 10)    || 8000;   // the map is small
  const EXTRACT_TOKENS = parseInt(process.env.EXTRACT_TOKENS, 10) || 32000;  // one batch of units
  const PER_BATCH      = parseInt(process.env.PLAN_PER_BATCH, 10) || 10;     // subject addresses per extract call

  // ── PHASE 1: PLAN ──
  const { parsed: plan, raw: planRaw } = await callModelJSON(planPrompt(sourceText), PLAN_TOKENS, "Plan");
  const subjectAddresses = Array.isArray(plan.subject_addresses) ? plan.subject_addresses.filter(Boolean) : [];
  const isDeal = plan.scope === "deal_portfolio" || subjectAddresses.length > 1;

  if (subjectAddresses.length === 0) {
    const err = new Error("Planner found no subject addresses in this document.");
    err.raw = planRaw; err.unparseable = true; throw err;
  }

  // ── PHASE 2: TARGETED EXTRACTION, batch by batch ──
  const batches = batchAddresses(subjectAddresses, PER_BATCH);
  const extractedByAddr = new Map();   // exact normalized key -> { address, prov, units }
  const extractedByLoose = new Map();  // loose key -> same object (directional-tolerant fallback)
  const extractRawOutputs = [];
  const allUnclear = [];

  for (const batch of batches) {
    const { parsed: ex, raw } = await callModelJSON(extractGroupPrompt(sourceText, plan, batch), EXTRACT_TOKENS, "Extract");
    extractRawOutputs.push(raw);
    if (Array.isArray(ex.unclear)) allUnclear.push(...ex.unclear);
    const props = Array.isArray(ex.properties) ? ex.properties : [];
    for (const p of props) {
      if (!p.address) continue;
      const key = normalizeAddress(p.address);
      const loose = looseAddressKey(p.address);
      const units = Array.isArray(p.units) ? p.units : [];
      if (extractedByAddr.has(key)) {
        // merge: same property surfaced in two batches (shouldn't happen, but safe)
        const existing = extractedByAddr.get(key);
        const seen = new Set(existing.units.map(u => String(u.unit_number)));
        for (const u of units) if (!seen.has(String(u.unit_number))) existing.units.push(u);
      } else {
        const rec = { address: p.address, prov: p.prov || "confirmed", units };
        extractedByAddr.set(key, rec);
        if (loose && !extractedByLoose.has(loose)) extractedByLoose.set(loose, rec);
      }
    }
  }

  // ── Build the subject_properties graph (same shape runIngest returns) ──
  // Match each planned subject to its extracted units: try the EXACT normalized
  // key first; on a miss, fall back to the directional-tolerant LOOSE key so a
  // "1414 Diamond Street" plan still finds "1414 W Diamond St" units. Only when
  // both miss is the property truly empty (and reconciliation will flag it).
  const subjectProperties = [];
  const matchedKeys = new Set();
  for (const addr of subjectAddresses) {
    const key = normalizeAddress(addr);
    const loose = looseAddressKey(addr);
    let hit = extractedByAddr.get(key);
    let how = hit ? "exact" : null;
    if (!hit && extractedByLoose.has(loose)) { hit = extractedByLoose.get(loose); how = "loose"; }
    if (hit) {
      matchedKeys.add(normalizeAddress(hit.address));
      // keep the PLANNED address as display identity (page-7 overview spelling),
      // but note when units were matched by the looser key for transparency.
      subjectProperties.push({
        address: addr,
        prov: hit.prov,
        units: hit.units,
        ...(how === "loose" ? { _matched_via: `loose key (extracted as "${hit.address}")` } : {}),
      });
    } else {
      subjectProperties.push({ address: addr, prov: "assumed", units: [], _note: "planned subject but no units extracted" });
    }
  }

  // Any extracted property that never matched a planned subject — surface it,
  // don't silently drop it. Could be a spelling the planner didn't list, or a
  // comp the extractor shouldn't have returned. Either way it's a review signal.
  const orphanExtracted = [];
  for (const [key, rec] of extractedByAddr.entries()) {
    if (!matchedKeys.has(key)) orphanExtracted.push(rec.address);
  }

  // ── Flatten subject units into staging (identical semantics to runIngest) ──
  const stagingUnits = [];
  for (const sp of subjectProperties) {
    for (const u of (sp.units || [])) stagingUnits.push({ ...u, _property_address: sp.address });
  }

  // ── PHASE 3: RECONCILE against the plan's stated totals ──
  const stated = (plan.deal && plan.deal.stated_totals) || {};
  const extractedPropCount = subjectProperties.filter(p => (p.units || []).length > 0).length;
  const plannedPropCount = subjectAddresses.length;
  const extractedUnitCount = stagingUnits.length;
  const emptyProps = subjectProperties.filter(p => (p.units || []).length === 0).map(p => p.address);

  const reconciliation = {
    planned_subject_properties: plannedPropCount,
    extracted_properties_with_units: extractedPropCount,
    extracted_units: extractedUnitCount,
    stated_properties: stated.properties ?? null,
    stated_units: stated.units ?? null,
    stated_beds: stated.beds ?? null,
    orphan_extracted_properties: orphanExtracted,
    flags: [],
  };
  if (stated.properties != null && stated.properties !== plannedPropCount)
    reconciliation.flags.push(`Stated ${stated.properties} properties but planner mapped ${plannedPropCount} subject addresses.`);
  if (stated.units != null && stated.units !== extractedUnitCount)
    reconciliation.flags.push(`Stated ${stated.units} units but extracted ${extractedUnitCount}.`);
  if (emptyProps.length)
    reconciliation.flags.push(`${emptyProps.length} planned propert${emptyProps.length === 1 ? "y" : "ies"} returned no units: ${emptyProps.slice(0, 8).join(", ")}${emptyProps.length > 8 ? "…" : ""}.`);
  if (orphanExtracted.length)
    reconciliation.flags.push(`${orphanExtracted.length} extracted propert${orphanExtracted.length === 1 ? "y" : "ies"} did not match any planned subject: ${orphanExtracted.slice(0, 8).join(", ")}${orphanExtracted.length > 8 ? "…" : ""}.`);

  // ── Persist the run. We write the SAME kind value the one-pass path uses
  //    (known-good against the live table) rather than a new "_planned" variant
  //    that could trip a CHECK/enum constraint the repo can't see. The planned/
  //    multi-pass fact is recorded inside model_raw_output (mode:"planned"),
  //    which is free-form text — so the distinction is preserved without
  //    risking the insert. plan + all extract passes are stored for full
  //    provenance of a multi-call ingest. ──
  const combinedRaw = JSON.stringify({ mode: "planned", plan: planRaw, extracts: extractRawOutputs }, null, 0);
  const runRes = await pool.query(
    `insert into ingest_runs
       (property_id, kind, source_text, model_id, model_raw_output, candidate_count, unclear)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [propertyId, kind, sourceText, INGEST_MODEL, combinedRaw, stagingUnits.length, allUnclear]
  );
  const run = runRes.rows[0];

  // ── Stage subject units as candidates — SAME columns/semantics as runIngest ──
  const candidates = [];
  for (const u of stagingUnits) {
    const hasNumber = !!u.unit_number;
    const prov = (u.prov === "confirmed" && hasNumber) ? "confirmed" : "assumed";
    const decision = (prov === "confirmed") ? "ready_for_promotion" : "pending";
    const addrTag = u._property_address ? `[${u._property_address}] ` : "";
    const baseNote = !hasNumber ? "no unit number" : (u.note || null);
    const note = (addrTag && baseNote) ? addrTag + baseNote : (addrTag ? addrTag.trim() : baseNote);
    const rentToStore = (u.actual_rent != null) ? u.actual_rent : (u.market_rent ?? null);
    const c = await pool.query(
      `insert into ingest_candidates
         (run_id, property_id, unit_number, bedrooms, market_rent, prov, ai_note, decision_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [run.id, propertyId, hasNumber ? String(u.unit_number) : null,
       u.bedrooms ?? null, rentToStore, prov, note, decision]
    );
    candidates.push(c.rows[0]);
  }

  const compsSeen = Number.isFinite(plan.comps_seen) ? plan.comps_seen : 0;
  const propWord = subjectProperties.length === 1 ? "subject property" : "subject properties";
  let summary = `Planned ingest: ${subjectProperties.length} ${propWord}, ${candidates.length} subject units staged across ${batches.length} extraction pass${batches.length === 1 ? "" : "es"}.`;
  if (compsSeen) summary += ` (${compsSeen} comparable propert${compsSeen === 1 ? "y" : "ies"} recognized and ignored.)`;
  if (reconciliation.flags.length) summary += ` ${reconciliation.flags.length} reconciliation flag${reconciliation.flags.length === 1 ? "" : "s"} for review.`;

  // ── INFER the real level reached — do NOT claim L4 unless lease-level detail
  //    was actually extracted. L4 = per-unit lease/tenant detail present;
  //    L3 = per-unit rows with attributes but no lease detail; L2 = unit counts
  //    only (none here, since we extract rows); L1 = addresses but no units.
  //    Overstating the level overstates confidence the data doesn't support.
  const hasLeaseDetail = stagingUnits.some(u =>
    u.tenant_name || u.lease_start || u.lease_end || u.deposit != null || u.balance != null);
  const hasUnitDetail = stagingUnits.some(u =>
    u.bedrooms != null || u.bathrooms != null || u.square_feet != null ||
    u.market_rent != null || u.actual_rent != null);
  const levelReached =
    stagingUnits.length === 0 ? "L1" :
    hasLeaseDetail ? "L4" :
    hasUnitDetail ? "L3" : "L2";

  return {
    run_id: run.id,
    mode: "planned",
    document_type: plan.document_type || "unknown",
    detected_system: plan.detected_system || "unknown",
    scope: isDeal ? "deal_portfolio" : "single_property",
    level_reached: levelReached,
    summary,
    property: isDeal ? null : (subjectProperties[0] || null),
    deal: isDeal ? (plan.deal || null) : null,
    subject_property_count: subjectProperties.length,
    subject_properties: subjectProperties,
    comps_seen: compsSeen,
    // ── normalized read-only contract layer — same shape as the one-pass path.
    //    Sourced from the planner's own subjectProperties graph (units nested)
    //    plus the plan's doc-level facts. Read-only; persists nothing. ──
    extraction_result: buildExtractionResult(
      { document_type: plan.document_type, detected_system: plan.detected_system,
        level_reached: levelReached, snapshot_date: plan.snapshot_date || null,
        deal: plan.deal || null, comps_seen: compsSeen,
        unit_mix: [], missing: [], unclear: allUnclear },
      isDeal, subjectProperties
    ),
    candidate_count: candidates.length,
    ready_for_promotion: candidates.filter(c => c.decision_status === "ready_for_promotion"),
    needs_review: candidates.filter(c => c.decision_status === "pending"),
    reconciliation,
    unclear: allUnclear,
    note: "Planned (multi-pass) ingest. Plan → targeted subject extraction → merge/reconcile. Subject assets only; comps never staged; nothing written to units yet. Reconciliation flags are for human review — they do not auto-resolve. NOTE: portfolio (multi-property) promotion is currently BLOCKED — staging and review work, but /promote refuses portfolios until per-subject-property mapping exists. Single-property runs promote normally.",
  };
}

// ── ROUTER: one-pass first; fall through to the planner on truncation ──
// This is the hybrid. Small/medium docs ride the proven single-pass path.
// When a doc is too large and one-pass truncates, we automatically switch to
// plan → targeted extract → reconcile instead of failing. The user drops one
// file; the system decides how to handle it. INGEST_FORCE_PLANNER=1 forces the
// planner for testing.
async function runIngestAuto(propertyId, sourceText, kind) {
  if (process.env.INGEST_FORCE_PLANNER === "1") {
    return await runIngestPlanned(propertyId, sourceText, kind);
  }
  try {
    return await runIngest(propertyId, sourceText, kind);
  } catch (e) {
    if (e.truncated) {
      // one-pass outgrew the ceiling → durable path
      return await runIngestPlanned(propertyId, sourceText, kind);
    }
    throw e;
  }
}

// ── FILE → TEXT: read any supported file type into plain text ─────────
// Excel/CSV via SheetJS, PDF via pdf-parse, Word via mammoth, plain text as-is.
// All flow into the SAME runIngest pipeline — turning a file into text is the
// only thing that differs by type.
async function fileToText(file) {
  const name = (file.originalname || "").toLowerCase();
  const buf = file.buffer;

  // Excel / CSV
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
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
    return flat;
  }

  // PDF (text-based; scanned/handwritten OCR is a later layer)
  if (name.endsWith(".pdf")) {
    // Import the inner library directly. The package's index.js runs a debug
    // block on require that reads a sample file off disk — absent on Render,
    // it throws and 500s the request. The lib module skips that block.
    const pdfParse = require("pdf-parse/lib/pdf-parse.js");
    const data = await pdfParse(buf);
    return data.text || "";
  }

  // Word
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value || "";
  }

  // Plain text / unknown — try utf-8
  return buf.toString("utf8");
}

// ── ingest from pasted TEXT ──
app.post("/properties/:propertyId/ingest", async (req, res) => {
  const { rent_roll_text } = req.body || {};
  if (!rent_roll_text) return res.status(400).json({ error: "rent_roll_text is required" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });
    const result = await runIngestAuto(req.params.propertyId, rent_roll_text, "rent_roll");
    res.json(result);
  } catch (e) {
    if (e.truncated) return res.status(413).json({ error: e.message, truncated: true });
    if (e.unparseable) return res.status(502).json({ error: e.message, raw: e.raw });
    res.status(500).json({ error: e.message });
  }
});

// ── ingest from an uploaded FILE (.xlsx/.xls/.csv/.pdf/.docx/.doc/.txt) ──
// The server reads any supported type to text, then runs the SAME pipeline.
// Multer runs first; we wrap it so an oversize file returns a clean 413 JSON
// instead of crashing the request with a 500 HTML page.
const uploadSingle = upload.single("file");
app.post("/properties/:propertyId/ingest-file", (req, res, next) => {
  uploadSingle(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file too large — max 25 MB. If it's a big image-heavy PDF, the text-only content is what we need; try exporting/printing it to a smaller PDF, or paste the table text." });
      }
      return res.status(400).json({ error: "upload failed: " + err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file uploaded (field name must be 'file')" });
  try {
    const prop = await pool.query("select id from properties where id=$1", [req.params.propertyId]);
    if (prop.rows.length === 0) return res.status(404).json({ error: "property not found" });

    let text;
    try { text = await fileToText(req.file); }
    catch { return res.status(400).json({ error: "could not read file — supported: .xlsx .xls .csv .pdf .docx .doc .txt" }); }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "file parsed but contained no readable text. If it is a scanned/photo PDF, OCR isn't supported yet — paste the table or upload an Excel/CSV." });
    }

    const result = await runIngestAuto(req.params.propertyId, text, "rent_roll_file");
    res.json({ ...result, source_filename: req.file.originalname });
  } catch (e) {
    if (e.truncated) return res.status(413).json({ error: e.message, truncated: true });
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
    const run = await pool.query("select id, property_id, model_raw_output from ingest_runs where id=$1", [req.params.runId]);
    if (run.rows.length === 0) return res.status(404).json({ error: "run not found" });
    const propertyId = run.rows[0].property_id;

    const approved = await pool.query(
      "select * from ingest_candidates where run_id=$1 and decision_status='approved'",
      [req.params.runId]
    );

    // ── PORTFOLIO PROMOTION GUARDRAIL (precise, fail-closed) ───────────
    // Promotion inserts every unit under the ONE propertyId from the run (see
    // the units insert below). Correct for a single property; for a portfolio
    // it would collapse many subject buildings into one property record. Until
    // per-subject-property mapping exists (address as a first-class candidate
    // column + per-property promote), we block the UNSAFE condition only:
    // candidates that belong to more than one subject property.
    //
    // We do NOT block merely because the planner was used. We block on the real
    // signal — the count of DISTINCT "[address]" tags across approved
    // candidates — and we FAIL CLOSED:
    //   • exactly 1 distinct address  → safe, allow (all units = one property)
    //   • more than 1 distinct address → block (would collapse properties)
    //   • a planned run where we CANNOT confirm exactly one address → block
    //     (ambiguous; we won't promote what we can't prove is single-property)
    // A non-planned single-property run (one-pass, no tags) is unaffected.
    const rawOut = run.rows[0].model_raw_output || "";
    const isPlannedRun = /^\s*\{\s*"mode"\s*:\s*"planned"/.test(rawOut);
    const distinctAddrTags = new Set(
      approved.rows
        .map(c => (c.ai_note || "").match(/^\[([^\]]+)\]/))
        .filter(Boolean)
        .map(m => m[1].trim())
    );
    const addrCount = distinctAddrTags.size;

    // block if: more than one address, OR a planned run we can't confirm as
    // exactly-one-address (addrCount !== 1 means 0 = can't tell, or >1 = multi).
    const blockMultiAddress = addrCount > 1;
    const blockAmbiguousPlanned = isPlannedRun && addrCount !== 1;
    if (blockMultiAddress || blockAmbiguousPlanned) {
      return res.status(409).json({
        error: "Portfolio promotion is blocked until subject-property mapping is implemented. This run has units tied to multiple subject addresses, and promoting now would collapse them into one property.",
        detail: {
          distinct_subject_addresses: addrCount,
          planned_run: isPlannedRun,
          approved_candidates: approved.rows.length,
          reason: blockMultiAddress ? "multiple_subject_addresses" : "planned_run_address_count_unconfirmed",
        },
        what_you_can_do: "Staging and review work normally — candidates are saved and readable. Single-property runs still promote. Portfolio promotion will be enabled once each subject address maps to its own property.",
        blocked: true,
      });
    }
    // ───────────────────────────────────────────────────────────────────

    const promoted = [];
    const skipped = [];
    for (const c of approved.rows) {
      // Each candidate is its own transaction: the unit insert and the
      // candidate's promoted-status update commit together or not at all.
      // This keeps the audit trail and canonical state in sync — a unit can
      // never exist while its candidate still reads 'approved' (which would
      // let a re-run create the unit twice).
      const client = await pool.connect();
      try {
        await client.query("begin");
        const u = await client.query(
          `insert into units (property_id, unit_number, bedrooms, market_rent)
           values ($1,$2,$3,$4) returning *`,
          [propertyId, c.unit_number, c.bedrooms ?? null, c.market_rent ?? null]
        );
        const unit = u.rows[0];  // its space auto-creates via the trigger
        // record the transition on the candidate — explicit, not implied
        await client.query(
          `update ingest_candidates
             set decision_status='promoted', promoted_unit_id=$1,
                 promoted_at=now(), promoted_by=$2
           where id=$3`,
          [unit.id, promoted_by ?? null, c.id]
        );
        await client.query("commit");
        promoted.push({ candidate_id: c.id, unit });
      } catch (e) {
        await client.query("rollback");
        // duplicate unit_number (23505) or other — skip, don't fail the batch
        skipped.push({ candidate_id: c.id, unit_number: c.unit_number,
          reason: e.code === "23505" ? "unit already exists" : e.message });
      } finally {
        client.release();
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
         where run_id=$2 and decision_status in ('pending','ready_for_promotion') and id = any($3::uuid[])
         returning id`,
        [reviewed_by ?? null, req.params.runId, candidate_ids]
      );
    } else {
      // approve ALL pending candidates in this run
      result = await pool.query(
        `update ingest_candidates
           set decision_status='approved', reviewed_by=$1, reviewed_at=now()
         where run_id=$2 and decision_status in ('pending','ready_for_promotion')
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

// ── MAINTENANCE MODULE (isolated; injected pool + shared obligation path) ──
app.use("/", maintenanceModule({ pool, spawnObligationFromEvent }));

// ── DOWN UNITS MODULE (isolated; same injection pattern) ──
app.use("/", downUnitsModule({ pool, spawnObligationFromEvent }));

// ── ORG CHART MODULE (isolated; same injection pattern) ──
app.use("/", moneyModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
app.use("/", orgchartModule({ pool }));
app.use("/", turnoversModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));
app.use("/", moveinModule({ pool, spawnObligationFromEvent, satisfyObligation, completeObligation }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Property Spine API listening on ${port}`));
