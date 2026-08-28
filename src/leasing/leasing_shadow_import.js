"use strict";
// ════════════════════════════════════════════════════════════════════════
//  leasing_shadow_import.js — the Skyline RIDE-ALONG resolver (Layer 1 + 2)
//
//  Turns a parsed Acuity/Outlook occurrence into the full
//  Person-Card (+ lead + scheduled tour) chain in PREVIEW mode — mirroring real
//  leasing activity in Property Spine WITHOUT sending any outreach or touching
//  Yardi. The adapter (Layer 3) is the sensor; THIS is the brain.
//
//  GOVERNING RULE: "Phone identifies the human. The intake task identifies what
//  that human wants now."
//
//  THE THREE STATES OF AN INCOMING PHONE:
//    1. no / invalid phone, or insufficient identity
//         -> person_identity_conflicts row. No card formed (or card with no
//            usable key). No lead. The EXCEPTION queue.
//    2. KNOWN phone (matches an existing Person Card) = the SAME person
//         -> append the tour to that card, raise an existing_person_tour_intent
//            task. NEVER a duplicate person. NEVER an automatic new lead.
//            A different name/email is retained as alias / discrepancy, not a fork.
//    3. NEW phone (no existing card)
//         -> create the Person Card + a new PREVIEW leasing_lead + attach the
//            PREVIEW scheduled tour. The ONLY state that auto-creates a new lead.
//
//  Email/name disagreement on a known phone is a NON-BLOCKING contact-data
//  discrepancy (person_contact_discrepancies), NOT an identity conflict.
//
//  THE GUARDRAIL (data-enforced, not a label): every row this module writes is
//  import_mode='preview'. This module NEVER calls the SMS transport. Preview is
//  barred from outreach structurally — there is no code path here that reaches
//  smsForEvent. (Live intake with outreach stays in leasing_leads.js.)
//
//  OWNERSHIP (persons-space, the lead-owner convention):
//    Resolve the active Leasing Agent assignment for the property (assignments
//    table, role='leasing_agent', is_active). Write its person_id to
//    leasing_leads.assignee_id and onto the intent task's owner_person_id.
//    NO active agent -> leave UNASSIGNED + raise a leasing_coverage_exception +
//    escalate to the manager. Do NOT silently make the manager the agent.
//    ESCALATION != COVERAGE: escalates_to_assignment_id is the accountability
//    route, not a coverage assignment. Automatic coverage routing is added only
//    when an explicit coverage/availability model exists — never inferred here.
//
//  scheduled_tours.scheduled_host_user_id (users-space) is left NULL — the
//  scheduled host is context, and we don't yet know which staff user will host.
//
//  Deps mirror the other leasing modules: { pool }. No anthropic, no sms —
//  this module cannot send, by construction.
// ════════════════════════════════════════════════════════════════════════

const express = require("express");

module.exports = function leasingShadowImportModule({ pool }) {
  const router = express.Router();

  function requireOperator(req, res, next) {
    const key = req.get("x-operator-key");
    if (!process.env.OPERATOR_KEY || key === process.env.OPERATOR_KEY) return next();
    return res.status(401).json({ error: "operator key required" });
  }

  // ── phone normalization: identical rule to leasing_scheduling.js /
  //    leasing_leads.js. null return == structurally invalid/unusable phone. ──
  function normalizePhone(raw) {
    if (!raw) return null;
    const d = String(raw).replace(/\D/g, "");
    if (d.length === 10) return "+1" + d;
    if (d.length === 11 && d[0] === "1") return "+" + d;
    if (String(raw).startsWith("+")) return String(raw).trim();
    return null;
  }
  function normalizeEmail(raw) {
    const e = raw && String(raw).trim().toLowerCase();
    return e && e.includes("@") ? e : null;
  }

  // Append an incoming name to persons.names_seen as a source alias, deduped by
  // (name, source). Never forks a card; the single `name` column keeps the best
  // display name (backfilled only when blank), the array keeps the lifetime.
  async function appendNameAlias(client, personId, name, source) {
    if (!name) return;
    const row = (await client.query(`select name, names_seen from persons where id=$1`, [personId])).rows[0];
    if (!row) return;
    const seen = Array.isArray(row.names_seen) ? row.names_seen : [];
    const exists = seen.find((a) => a && a.name === name && a.source === source);
    const nowIso = new Date().toISOString();
    let next;
    if (exists) {
      next = seen.map((a) => (a === exists ? { ...a, last_seen_at: nowIso } : a));
    } else {
      next = seen.concat([{ name, source, first_seen_at: nowIso, last_seen_at: nowIso }]);
    }
    // backfill display name only if blank; never overwrite an existing one.
    await client.query(
      `update persons set name = coalesce(name, $1), names_seen = $2::jsonb, updated_at = now() where id = $3`,
      [name, JSON.stringify(next), personId]
    );
  }

  // Record a non-blocking contact-data discrepancy (e.g. a different email on a
  // phone-matched card). Visible to the leasing owner; never forks, never blocks.
  async function recordDiscrepancy(client, personId, field, existingValue, incomingValue, source) {
    if (existingValue == null || incomingValue == null) return;
    if (String(existingValue).trim().toLowerCase() === String(incomingValue).trim().toLowerCase()) return;
    // de-dupe an already-open identical discrepancy
    const dup = (await client.query(
      `select id from person_contact_discrepancies
        where person_id=$1 and field=$2 and incoming_value=$3 and status='open' limit 1`,
      [personId, field, String(incomingValue)]
    )).rows[0];
    if (dup) return;
    await client.query(
      `insert into person_contact_discrepancies (person_id, field, existing_value, incoming_value, source)
       values ($1,$2,$3,$4,$5)`,
      [personId, field, existingValue == null ? null : String(existingValue), String(incomingValue), source || null]
    );
  }

  // ── OWNERSHIP: resolve the active Leasing Agent for a property (persons-space).
  //    Returns { person_id } or null. Does NOT consider escalation as coverage. ──
  async function resolveActiveLeasingAgent(client, propertyId) {
    const r = (await client.query(
      `select id, person_id from assignments
        where property_id=$1 and lower(role)='leasing_agent' and is_active=true
        order by created_at limit 1`,
      [propertyId]
    )).rows[0];
    return r ? { assignment_id: r.id, person_id: r.person_id } : null;
  }

  // Resolve the manager an unowned-leasing gap escalates TO. This reads the
  // active leasing-agent assignment's escalates_to (accountability route). If
  // there is no agent assignment at all, we fall back to any active manager-ish
  // assignment for the property (property_manager / asset_manager / owner) as the
  // accountable party. This is ESCALATION (who is accountable), NOT a coverage
  // assignment of leasing work.
  async function resolveEscalationTarget(client, propertyId) {
    // Prefer an explicit manager assignment on the property.
    const mgr = (await client.query(
      `select person_id from assignments
        where property_id=$1 and is_active=true
          and lower(role) in ('property_manager','asset_manager','owner')
        order by case lower(role)
                   when 'property_manager' then 1
                   when 'asset_manager'    then 2
                   when 'owner'            then 3
                   else 4 end,
                 created_at
        limit 1`,
      [propertyId]
    )).rows[0];
    return mgr ? mgr.person_id : null;
  }

  // ── STATE 3: NEW phone -> preview Person Card + preview lead + preview tour ──
  //    The ONLY auto-new-lead path. Never sends anything.
  async function importNewPhone(client, occ, e164, email, source) {
    // create the Person Card (persons-space identity).
    const person = (await client.query(
      `insert into persons (name, phone, email, primary_phone_e164, lifecycle_status, leasing_stage, source, names_seen)
       values ($1,$2,$3,$4,'lead','lead',$5,$6::jsonb) returning *`,
      [
        occ.prospect_name || null,
        e164, // store the normalized number in the legacy column too
        email,
        e164,
        source,
        JSON.stringify(occ.prospect_name ? [{ name: occ.prospect_name, source, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }] : []),
      ]
    )).rows[0];

    // resolve the owning leasing agent (persons-space) or raise a coverage gap.
    const agent = await resolveActiveLeasingAgent(client, occ.property_id);

    // create the PREVIEW lead. assignee_id = agent person, or null (UNASSIGNED).
    const lead = (await client.query(
      `insert into leasing_leads
         (person_id, property_id, unit_id, message, raw_payload, assignee_id, import_mode, import_source, status)
       values ($1,$2,$3,$4,$5::jsonb,$6,'preview',$7,'tour_scheduled')
       returning *`,
      [
        person.id,
        occ.property_id,
        occ.unit_id || null,
        occ.message || null,
        JSON.stringify(occ),
        agent ? agent.person_id : null,
        source,
      ]
    )).rows[0];

    // attach / upsert the PREVIEW scheduled tour. scheduled_host_user_id stays
    // NULL (we don't know the staff host yet). Link the person we just resolved.
    const tour = await upsertPreviewTour(client, occ, person.id, source);

    // if no active agent, the lead is UNASSIGNED -> coverage exception + escalate.
    let coverageException = null;
    if (!agent) {
      coverageException = await raiseCoverageException(client, occ.property_id, lead.id, tour ? tour.id : null);
    }

    return {
      state: "new_phone",
      created_person: true,
      person_id: person.id,
      lead_id: lead.id,
      scheduled_tour_id: tour ? tour.id : null,
      assigned_person_id: agent ? agent.person_id : null,
      coverage_exception_id: coverageException ? coverageException.id : null,
      outreach_sent: false, // by construction — this module cannot send
    };
  }

  // ── STATE 2: KNOWN phone -> same person, intent task, NO new lead ──────────
  async function importKnownPhone(client, occ, person, email, source) {
    // retain the incoming name as an alias (never fork).
    await appendNameAlias(client, person.id, occ.prospect_name, source);
    // a differing email is a NON-BLOCKING discrepancy, not a conflict.
    if (email && person.email && email !== String(person.email).trim().toLowerCase()) {
      await recordDiscrepancy(client, person.id, "email", person.email, email, source);
    } else if (email && !person.email) {
      // backfill a missing email silently (no discrepancy).
      await client.query(`update persons set email=coalesce(email,$1), updated_at=now() where id=$2`, [email, person.id]);
    }
    // ensure the canonical key is populated on an older card.
    await client.query(
      `update persons set primary_phone_e164=coalesce(primary_phone_e164,$1), updated_at=now() where id=$2`,
      [normalizePhone(person.phone) || null, person.id]
    );

    // attach / upsert the PREVIEW scheduled tour to this existing card.
    const tour = await upsertPreviewTour(client, occ, person.id, source);

    // owner of the intent task = active leasing agent (persons-space) or null.
    const agent = await resolveActiveLeasingAgent(client, occ.property_id);
    let coverageException = null;
    if (!agent) {
      coverageException = await raiseCoverageException(client, occ.property_id, null, tour ? tour.id : null);
    }

    // raise the intent task: "what does this person want to do?" — unless one is
    // already open for this person+tour (idempotent).
    let intent = (await client.query(
      `select * from person_intent_tasks
        where person_id=$1 and coalesce(scheduled_tour_id::text,'')=coalesce($2::text,'')
          and status='needs_confirmation' limit 1`,
      [person.id, tour ? tour.id : null]
    )).rows[0];
    if (!intent) {
      intent = (await client.query(
        `insert into person_intent_tasks
           (person_id, property_id, scheduled_tour_id, owner_role, owner_person_id)
         values ($1,$2,$3,'leasing_agent',$4) returning *`,
        [person.id, occ.property_id, tour ? tour.id : null, agent ? agent.person_id : null]
      )).rows[0];
    }

    return {
      state: "known_phone",
      created_person: false,
      created_lead: false, // NEVER an automatic new lead
      person_id: person.id,
      scheduled_tour_id: tour ? tour.id : null,
      intent_task_id: intent.id,
      assigned_person_id: agent ? agent.person_id : null,
      coverage_exception_id: coverageException ? coverageException.id : null,
      outreach_sent: false,
    };
  }

  // ── STATE 1: no / invalid phone -> conflict row, no lead ───────────────────
  async function raiseIdentityConflict(client, occ, conflictType) {
    const row = (await client.query(
      `insert into person_identity_conflicts (person_id, incoming_payload, conflict_type, property_id)
       values (null,$1::jsonb,$2,$3) returning *`,
      [JSON.stringify(occ), conflictType, occ.property_id || null]
    )).rows[0];
    return {
      state: "identity_conflict",
      conflict_type: conflictType,
      conflict_id: row.id,
      created_person: false,
      created_lead: false,
      outreach_sent: false,
    };
  }

  // PREVIEW scheduled-tour upsert. Dedup on (source_system, external_appt_id)
  // when present — matches the unique index from 048. Links the resolved person.
  // scheduled_host_user_id is NEVER set here.
  async function upsertPreviewTour(client, occ, personId, source) {
    if (occ.external_appt_id) {
      const existing = (await client.query(
        `select * from scheduled_tours where source_system=$1 and external_appt_id=$2 limit 1`,
        [occ.source_system || "acuity_squarespace", occ.external_appt_id]
      )).rows[0];
      if (existing) {
        await client.query(
          `update scheduled_tours
              set person_id=coalesce(person_id,$1),
                  prospect_name=coalesce(prospect_name,$2),
                  prospect_phone=coalesce(prospect_phone,$3),
                  prospect_email=coalesce(prospect_email,$4),
                  updated_at=now()
            where id=$5`,
          [personId, occ.prospect_name || null, occ.prospect_phone || null, occ.prospect_email || null, existing.id]
        );
        return existing;
      }
    }
    const tour = (await client.query(
      `insert into scheduled_tours
         (property_id, person_id, prospect_name, prospect_phone, prospect_email,
          external_appt_id, source_system, appointment_type, scheduled_start, scheduled_end,
          status, authority, import_mode, import_source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled','individual','preview',$11)
       returning *`,
      [
        occ.property_id || null,
        personId,
        occ.prospect_name || null,
        occ.prospect_phone || null,
        occ.prospect_email || null,
        occ.external_appt_id || null,
        occ.source_system || "acuity_squarespace",
        occ.appointment_type || null,
        occ.scheduled_start || null,
        occ.scheduled_end || null,
        source,
      ]
    )).rows[0];
    return tour;
  }

  // Raise a manager-visible coverage exception + escalate. The lead stays
  // UNASSIGNED. We do NOT assign the manager as the leasing agent.
  async function raiseCoverageException(client, propertyId, leadId, tourId) {
    const escalateTo = await resolveEscalationTarget(client, propertyId);
    // de-dupe an open exception for the same lead/tour.
    const dup = (await client.query(
      `select id from leasing_coverage_exceptions
        where property_id=$1
          and coalesce(lead_id::text,'')=coalesce($2::text,'')
          and coalesce(scheduled_tour_id::text,'')=coalesce($3::text,'')
          and status='open' limit 1`,
      [propertyId, leadId, tourId]
    )).rows[0];
    if (dup) return dup;
    const row = (await client.query(
      `insert into leasing_coverage_exceptions
         (property_id, required_role, lead_id, scheduled_tour_id, reason, escalated_to_person_id)
       values ($1,'leasing_agent',$2,$3,'no_active_leasing_agent',$4) returning *`,
      [propertyId, leadId, tourId, escalateTo]
    )).rows[0];
    return row;
  }

  // ── THE ENTRY POINT: resolve one parsed occurrence through the three states.
  //    `occ` is the parsed Acuity occurrence (the adapter's output, or a test
  //    payload). Expected fields: property_id, prospect_name, prospect_phone,
  //    prospect_email, external_appt_id, source_system, appointment_type,
  //    scheduled_start, scheduled_end, optionally unit_id / message.
  //    `booking_for_other` (bool) on the payload forces State 1 when the source
  //    explicitly says the booking is for a different actual person we can't id. ──
  async function ingestShadowOccurrence(client, occ, opts = {}) {
    const source = opts.source || occ.import_source || "outlook_acuity_ride_along";
    const rawPhone = occ.prospect_phone;
    const e164 = normalizePhone(rawPhone);
    const email = normalizeEmail(occ.prospect_email);

    // STATE 1a: the source says this booking is for someone else and we have no
    // usable identity for that actual person -> insufficient identity.
    if (occ.booking_for_other && !e164) {
      return raiseIdentityConflict(client, occ, "insufficient_identity");
    }
    // STATE 1b: no phone at all.
    if (!rawPhone || String(rawPhone).trim() === "") {
      return raiseIdentityConflict(client, occ, "no_phone");
    }
    // STATE 1c: a phone was provided but it is not a usable number.
    if (!e164) {
      return raiseIdentityConflict(client, occ, "invalid_phone");
    }

    // Match on the canonical key first, then the legacy phone column (older rows
    // not yet backfilled), then email as a weak fallback. Phone match wins.
    let person =
      (await client.query(`select * from persons where primary_phone_e164=$1 order by created_at limit 1`, [e164])).rows[0] ||
      (await client.query(`select * from persons where phone=$1 order by created_at limit 1`, [e164])).rows[0] ||
      (await client.query(`select * from persons where phone=$1 order by created_at limit 1`, [rawPhone])).rows[0] ||
      null;

    if (person) {
      // STATE 2: known phone = same person.
      return importKnownPhone(client, occ, person, email, source);
    }
    // STATE 3: new phone.
    return importNewPhone(client, occ, e164, email, source);
  }

  // tx helper mirroring the other modules.
  async function tx(fn, res) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback");
      console.error("leasing_shadow_import:", e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  }

  // ── ROUTES ─────────────────────────────────────────────────────────────
  // Ingest one shadow occurrence (the adapter calls this; also operator-testable).
  router.post("/shadow-import/occurrence", requireOperator, (req, res) =>
    tx((client) => ingestShadowOccurrence(client, req.body || {}, req.body && req.body._opts), res)
  );

  // Resolve an intent task: a human answers "what does this person want?" The
  // system maps the plain answer to a structural outcome. (Outcomes that create
  // a leasing_opportunity are stubbed here — the opportunities object is built
  // when this first fires; until then we record the resolved_intent + leave a
  // clear marker. This keeps the migration lean per the build decision.)
  router.post("/shadow-import/intent-tasks/:id/resolve", requireOperator, (req, res) =>
    tx(async (client) => {
      const id = req.params.id;
      const intent = (req.body && req.body.intent) || null;
      const VALID = ["transfer", "other_property", "returning", "booking_for_other", "new_prospect"];
      if (!VALID.includes(intent)) {
        const e = new Error(`intent must be one of ${VALID.join(", ")}`);
        e._client = true;
        throw e;
      }
      const row = (await client.query(
        `update person_intent_tasks
            set status='resolved', resolved_intent=$1, resolved_at=now(), resolved_by=$2
          where id=$3 and status='needs_confirmation' returning *`,
        [intent, (req.body && req.body.resolved_by) || null, id]
      )).rows[0];
      if (!row) {
        const e = new Error("no open intent task with that id");
        e._client = true;
        throw e;
      }
      // NOTE: the leasing_opportunities object is intentionally NOT built yet.
      // When it is, this is where each resolved_intent maps to its action:
      //   transfer/new_prospect -> new opportunity at THIS property
      //   other_property        -> new opportunity at the named property
      //   returning             -> reopened opportunity at the relevant property
      //   booking_for_other     -> new Person Card for the actual prospect
      return { resolved: true, intent_task: row, opportunity_created: false, note: "opportunities object not yet built (by design)" };
    }, res)
  );

  // Read surfaces (operator/manager visibility).
  router.get("/shadow-import/conflicts", requireOperator, async (req, res) => {
    const r = await pool.query(`select * from person_identity_conflicts where status='open' order by created_at desc`);
    res.json({ conflicts: r.rows });
  });
  router.get("/shadow-import/intent-tasks", requireOperator, async (req, res) => {
    const r = await pool.query(`select * from person_intent_tasks where status='needs_confirmation' order by created_at desc`);
    res.json({ intent_tasks: r.rows });
  });
  router.get("/shadow-import/coverage-exceptions", requireOperator, async (req, res) => {
    const r = await pool.query(`select * from leasing_coverage_exceptions where status='open' order by created_at desc`);
    res.json({ coverage_exceptions: r.rows });
  });

  // expose the service for tests + the adapter wiring (Layer 3).
  router._service = {
    ingestShadowOccurrence,
    resolveActiveLeasingAgent,
    resolveEscalationTarget,
    normalizePhone,
    normalizeEmail,
    appendNameAlias,
    recordDiscrepancy,
  };
  return router;
};
