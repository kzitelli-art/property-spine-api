// baseline_routes.js — extracted VERBATIM from server.js (lines 291-926).
// Route paths and registration order are unchanged: server.js mounts this
// router at "/" at the exact position these routes were registered inline.
const express = require("express");
const propertyCreation = require("../identity/property_creation_service"); // Build 1A-1: THE property write

module.exports = function baselineRoutes({ pool, spawnObligationFromEvent }) {
  const router = express.Router();
// ── health: confirms server is up AND can reach the database ──
//  ── WHAT EXACT CODE IS RUNNING ──────────────────────────────────────
//  /health is where a person looks first, and it is the one door reachable
//  without a session — which is precisely why the build identity belongs
//  here. Until this question could be answered from the running
//  application, `deployed` was an assumption: Render ships a build
//  artifact with no .git, so `git rev-parse` on the box fails and nothing
//  else stated the commit.
//
//  Only the SHORT sha and how it was resolved are exposed. That answers
//  "is the running build the commit I think it is" without publishing
//  more of the repository's shape than the question needs. When nothing
//  identifies the build the field is null and `build_identified` is false
//  — an honest blank, never a plausible-looking sha.
const { buildIdentity } = require("../shared/build_identity");
router.get("/health", async (_req, res) => {
  const id = buildIdentity();
  const build = {
    build_identified: !!id.commit,
    commit_short: id.short,
    resolved_from: id.resolved_from,
    started_at: id.started_at,
  };
  try {
    const r = await pool.query("select now() as time");
    res.json({ ok: true, db_time: r.rows[0].time, build });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, build });
  }
});

//  The full record — including the untruncated commit — behind the
//  operator gate, for anyone reconciling a deployment against a branch.
router.get("/operator/build", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ build: buildIdentity() });
});

// ── create a property ──────────────────────────────────────────────
//  THE FIFTH DOOR. Build 1A-1 collapsed four property-creation routes into
//  one canonical service and asserted there were no others. There were:
//  this one. The audit searched `src/`; this file is at the repo root, and
//  the gate that was supposed to catch it inherited the same blind spot.
//
//  It is now a caller like the other four — session-resolved actor, an
//  organization, address-anchored identity or a recorded reason it has
//  none, and an immutable creation record.
//
//  COLLAPSED rather than retired: nothing in this repo calls it (the app
//  only GETs /properties), but the shared operator key is held outside the
//  repository and source cannot prove a consumer does not exist. Both
//  choices break an unknown caller; this one breaks it with a 401 that
//  names what is missing instead of a dead end.
router.post("/properties", async (req, res) => {
  const { name, address, city, state, zip, property_type, organization_id } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const session = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
    if (!session) {
      return res.status(401).json({
        error: "A staff session is required to create a property.",
        reason: "no_authenticated_actor",
        receipt: "Send x-staff-session. The operator key authenticates the caller, not the " +
                 "human — and creating a property records who did it.",
      });
    }
    const out = await propertyCreation.createProperty(pool, {
      actor: { user_id: session.id },
      organization_id: organization_id || null,
      name, address, city, state, zip, property_type,
      source: "legacy_properties_route",
    });
    res.status(201).json(out.property);
  } catch (e) {
    if (e.httpStatus) {
      return res.status(e.httpStatus).json({ error: e.publicMessage, reason: e.refusalReason, ...e.detail });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── read all properties back ──
router.get("/properties", async (_req, res) => {
  try {
    const r = await pool.query("select * from properties order by created_at desc");
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── read one property (with its units) ──
router.get("/properties/:id", async (req, res) => {
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
router.post("/properties/:propertyId/units", async (req, res) => {
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
router.get("/properties/:propertyId/units", async (req, res) => {
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
router.post("/persons", async (req, res) => {
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

    // CANONICAL IDENTITY: normalize the phone and dedup on primary_phone_e164
    // (the one-phone-one-person rule). A raw insert here previously minted a
    // duplicate person for the same human in a different phone format. If a
    // person with this canonical phone already exists, reuse it (backfilling
    // the canonical key on legacy rows) rather than creating a second.
    const { normalizeE164: __normPhone } = require("../identity/phone_identity");
    const __canon = __normPhone(phone);
    let person = null;
    if (__canon) {
      person = (await pool.query(
        `select * from persons where primary_phone_e164=$1 order by created_at limit 1`, [__canon])).rows[0] || null;
      if (!person) {
        // adopt a legacy row whose STORED phone normalizes to our canonical
        // (matches any raw stored format), then backfill the canonical key.
        const __tail10 = __canon.replace(/\D/g, "").slice(-10);
        const __cands = (await pool.query(
          `select * from persons where phone is not null and regexp_replace(phone,'\\D','','g') like $1 order by created_at`,
          ["%" + __tail10])).rows;
        person = __cands.find(p => __normPhone(p.phone) === __canon) || null;
        if (person) {
          await pool.query(`update persons set primary_phone_e164=coalesce(primary_phone_e164,$1), updated_at=now() where id=$2`, [__canon, person.id]);
        }
      }
    }
    if (person) {
      // backfill missing contact fields; identity stays put.
      await pool.query(
        `update persons set name=coalesce(name,$1), email=coalesce(email,$2), updated_at=now() where id=$3`,
        [name ?? null, email ?? null, person.id]);
    } else {
      const r = await pool.query(
        `insert into persons
           (name, email, phone, primary_phone_e164, source, lifecycle_status, leasing_stage, interested_unit_id)
         values ($1,$2,$3,$4,$5, coalesce($6,'lead'), coalesce($6,'lead'), $7)
         returning *`,
        [name ?? null, email ?? null, phone ?? null, __canon, source ?? null,
         lifecycle_status ?? null, interested_unit_id ?? null]
      );
      person = r.rows[0];
    }

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
router.get("/persons", async (req, res) => {
  const { lifecycle_status, source, property_id } = req.query;
  try {
    const where = [];
    const vals = [];
    if (lifecycle_status) { vals.push(lifecycle_status); where.push(`lifecycle_status = $${vals.length}`); }
    if (source)           { vals.push(source);           where.push(`source = $${vals.length}`); }
    if (property_id)      { vals.push(property_id);      where.push(`id in (select person_id from events where property_id = $${vals.length})`); }
    // ── STAFF LEAK GUARD (067) ── a staff-only person carries the schema's
    // floor lifecycle ('lead') but is NOT an inquiry. Exclude anyone with an
    // ACTIVE staff context UNLESS a real leasing relationship exists (a
    // leasing_leads row) — the same human may legitimately also be a
    // prospect (additive contexts, never a mutually-exclusive type).
    where.push(
      `not exists (select 1 from person_contexts pc
                    where pc.person_id = persons.id
                      and pc.context_type = 'staff' and pc.active_to is null
                      and not exists (select 1 from leasing_leads ll
                                       where ll.person_id = persons.id))`);
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
router.get("/persons/:id", async (req, res) => {
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
router.patch("/persons/:id", async (req, res) => {
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
router.post("/events", async (req, res) => {
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
router.get("/events", async (req, res) => {
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
// ── RETIRED: GET /obligations and GET /obligations/:id ──────────────
//  Both were protected only by the portfolio-wide shared OPERATOR_KEY while
//  taking property scope from the request (the collection) or ignoring it
//  entirely (the detail read). Any key holder could read across every
//  property. See docs/archive/SECURITY_OBLIGATIONS_ROUTE.md.
//
//  The collection read is replaced by the session-scoped
//  GET /operator/obligations, registered below with the other operator doors.
//
//  The detail read is NOT replaced. The audit found it had no caller in
//  either repository, so rebuilding it behind a new URL would preserve
//  attack surface for a workflow that does not exist. Add it back only when
//  a real workflow needs it.

// ── read one obligation (with the event that caused it — proves causality) ──
// ── RETIRED: PATCH /obligations/:id/{claim,satisfy,complete} ────────
//  All three sat behind the portfolio-wide shared OPERATOR_KEY with no
//  property, module or actor authority, acting on an obligation by ID alone.
//  claim additionally took the assignee from the REQUEST BODY, so a key
//  holder could claim any work, on any property, as any user.
//
//  claim is replaced by PATCH /operator/obligations/:id/claim (self-claim,
//  session-derived actor), registered with the other operator doors.
//
//  satisfy and complete are NOT replaced — neither had a product caller. The
//  canonical services satisfyObligation and completeObligation are UNCHANGED
//  and still enforce required inputs and the conversion rail; they are proven
//  directly rather than through an exposed door kept alive for a test to call.
//  See docs/archive/SECURITY_OBLIGATIONS_ROUTE.md.

// ════════════════════════════════════════════════════════════════════
//  USERS (minimal) — needed so obligations can belong to real people.
//  Not auth. Just create/list the staff who own obligations (e.g. Katie).
//  role must be one of the role_name enum values.
// ════════════════════════════════════════════════════════════════════
const ROLE_NAMES = ["owner","asset_manager","property_manager","leasing_agent","maintenance","accountant","ai","system"];

router.post("/users", async (req, res) => {
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

router.get("/users", async (_req, res) => {
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
// ── COMPLETE an obligation (the proof gate) ──
// Body: { completed_by? }
// Refuses with 409 if any required_inputs remain — naming what's still owed.
// On success: status='complete', completed_at=now(). The Completed Record.
// ════════════════════════════════════════════════════════════════════
  return router;
}