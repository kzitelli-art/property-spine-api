// ════════════════════════════════════════════════════════════════════
//  operator_obligations.js — THE AUTHENTICATED OBLIGATIONS DOOR
//
//  Replaces `GET /obligations`, which was protected only by the
//  portfolio-wide shared operator key while taking its property scope
//  from the query string — so any key holder could omit or change
//  property_id and read across every property.
//
//  Here property, modules and actor all come from the resolved staff
//  session. The browser may express a preference (status); it may not
//  supply authority.
//
//  DOORS DELIBERATELY NOT BUILT. The audit found `GET /obligations/:id`
//  had no caller at all, and `satisfy`/`complete` had no product caller.
//  Rebuilding them behind a new URL would preserve attack surface for
//  workflows that do not exist. Their canonical SERVICES are untouched;
//  only the exposed HTTP doors are gone. Add a door when a real workflow
//  needs one.
//
//  CLASS 2 (permanent).
// ════════════════════════════════════════════════════════════════════

"use strict";

module.exports = function operatorObligations(deps) {
  const express = require("express");
  const router = express.Router();
  const staffSessions = require("../identity/staff_session_service");
  const service = require("./operator_obligations_service");

  const { pool } = deps || {};
  if (!pool) throw new Error("operator_obligations requires a pool");

  async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op; next();
    } catch (e) { return res.status(500).json({ error: "session resolution failed" }); }
  }

  //  §21. A client-supplied property is REFUSED rather than ignored, so a
  //  caller cannot believe it chose the scope. Module inputs are ignored
  //  outright — there is no legitimate reason to send one, and refusing
  //  would turn a harmless stray parameter into an error.
  function refuseClientAuthority(req, res, next) {
    const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
    if (claimed && String(claimed) !== String(req.operator.property_id)) {
      return res.status(403).json({
        error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
        acting_on: req.operator.property_id,
      });
    }
    return next();
  }

  const gate = [requireOperator, refuseClientAuthority];

  // ── the scoped collection read ────────────────────────────────────
  router.get("/operator/obligations", ...gate, async (req, res) => {
    try {
      const out = await service.list(pool, {
        property_id: req.operator.property_id,        // session, never the request
        allowed_modules: req.operator.allowed_modules, // session, never the request
        status: req.query && req.query.status,        // preference only
      });

      return res.json({
        items: out.items,
        total: out.total,
        scope: {
          property_id: req.operator.property_id,
          modules: req.operator.allowed_modules || [],
        },
        ...(out.scope_note ? { scope_note: out.scope_note } : {}),
      });
    } catch (e) {
      //  A failure must never reach the browser shaped like an empty
      //  result — that is the false green this whole lane exists to stop.
      console.error("operator/obligations error", e);
      return res.status(500).json({ error: "Could not read this property's open work." });
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  THE INBOUND-OPPORTUNITY DECISION DOOR — detail read.
  //
  //  One exact workflow for one obligation type: resolve_inbound_opportunity.
  //  A prospect replied after their opportunity was closed; the system refused
  //  to guess which opportunity (migration 128) and opened this decision. The
  //  READ gives the operator everything needed to decide — the reply, the
  //  person, the exact candidates — in plain language. It exposes no dedupe
  //  key, no conversation-grain vocabulary, no lifecycle-event terminology.
  //  The candidate id travels only as an OPAQUE token for the action.
  //
  //  Added when a real workflow arrived — exactly the condition the header
  //  above set for new doors.
  // ══════════════════════════════════════════════════════════════════
  const {
    DECISION_TYPE, DECISION_DETAIL, inboundEventIdOf, listOpportunityCandidates,
  } = require("../leasing/inbound_opportunity_decision");

  //  Governed reason codes → plain words. Server-side, so the browser never
  //  needs the vocabulary.
  const PLAIN_REASON = {
    budget_mismatch: "budget didn't fit", program_mismatch: "program didn't fit",
    move_timing: "move timing didn't fit", location: "location didn't fit",
    duplicate: "duplicate inquiry", no_longer_interested: "no longer interested",
    other: "closed for another reason",
  };

  router.get("/operator/obligations/:id/inbound-decision", ...gate, async (req, res) => {
    try {
      //  Outside the session's property or module set is NOT FOUND, not
      //  FORBIDDEN — same posture as every read in this family.
      const ob = (await pool.query(
        `select o.id, o.status, o.label, o.due_at, o.assigned_user_id,
                o.owner_eligibility_state, o.person_id, o.related_id, o.related_type,
                o.dedupe_key, o.created_at,
                (o.due_at is not null and o.due_at < now()) as is_overdue,
                u.name as owner_name
           from obligations o
           left join users u on u.id = o.assigned_user_id
          where o.id = $1 and o.property_id = $2 and o.module = any($3::text[])
            and o.type = $4`,
        [req.params.id, req.operator.property_id,
         req.operator.allowed_modules || [], DECISION_TYPE])).rows[0];
      if (!ob) return res.status(404).json({ error: "No such decision on this property." });

      let blocked_reason = null;

      //  ── THE REPLY — recovered server-side from the temporary adapter ──
      //  The inbound id rides the dedupe key (obligations has no comm-event
      //  reference; source_event_id FKs a different table). Parsed HERE ONLY,
      //  verified against the obligation's own conversation and property, and
      //  never exposed. Replacement condition: a governed comm-event reference
      //  on the obligation model.
      let reply = null;
      const inboundId = inboundEventIdOf(ob);
      if (inboundId) {
        const m = (await pool.query(
          `select ce.id, ce.body, ce.occurred_at, ce.channel, ce.conversation_id, ce.property_id
             from comm_events ce where ce.id = $1`, [inboundId])).rows[0];
        if (m && String(m.conversation_id) === String(ob.related_id)
              && String(m.property_id) === String(req.operator.property_id)) {
          reply = { body: m.body, occurred_at: m.occurred_at, channel: m.channel };
        } else {
          blocked_reason = "The original reply could not be verified against this decision. The decision stays open; do not resolve it blind.";
        }
      } else {
        blocked_reason = "The original reply could not be located for this decision. The decision stays open; do not resolve it blind.";
      }

      const person = (await pool.query(
        `select name from persons where id = $1`, [ob.person_id])).rows[0] || null;

      //  ── CANDIDATES — offered, never selected ──────────────────────
      const cand = await listOpportunityCandidates(pool, {
        property_id: req.operator.property_id, conversation_id: ob.related_id });
      const unitIds = [];
      const raw = cand.ok ? cand.candidates : [];
      //  Exact unit context only: the opportunity's own preferred unit.
      //  EXACT recognition facts only: a toured date comes from a completed
      //  tour carrying THIS opportunity's conversion_id (migration 127); an
      //  applied date from lease_applications.submitted_at exactly linked by
      //  conversion_id (migration 051). Nothing is inferred from lead, person
      //  or time — a candidate without exact facts keeps its opening date.
      const prefs = raw.length ? (await pool.query(
        `select lc.id, un.unit_number,
                (select max(t.completed_at) from leasing_tours t
                  where t.conversion_id = lc.id and t.completed_at is not null) as toured_on,
                (select max(la.submitted_at) from lease_applications la
                  where la.conversion_id = lc.id and la.submitted_at is not null) as applied_on
           from leasing_conversions lc
           left join units un on un.id = lc.preferred_unit_id
          where lc.id = any($1::uuid[])`, [raw.map((x) => x.opportunity_id)])).rows : [];
      const factsOf = new Map(prefs.map((r) => [String(r.id),
        { unit: r.unit_number || null, toured_on: r.toured_on || null, applied_on: r.applied_on || null }]));
      const unitOf = new Map(prefs.map((r) => [String(r.id), r.unit_number || null]));

      const candidates = raw.map((x) => ({
        //  OPAQUE token for the action. Not a label; the browser displays the
        //  plain fields and passes this back untouched.
        opportunity_id: String(x.opportunity_id),
        opened_on: x.opened_at,
        state: x.closed_by_event ? "closed" : "open",
        closed_because: x.closed_by_event
          ? (PLAIN_REASON[x.last_close_reason] || null) : null,
        unit: unitOf.get(String(x.opportunity_id)) || null,
        toured_on: (factsOf.get(String(x.opportunity_id)) || {}).toured_on || null,
        applied_on: (factsOf.get(String(x.opportunity_id)) || {}).applied_on || null,
      }));

      if (!blocked_reason && candidates.length === 0) {
        blocked_reason = "No leasing opportunity exists for this person at this property yet. The decision stays open until one can be identified.";
      }

      return res.json({
        obligation: {
          id: ob.id, status: ob.status,
          owner: ob.assigned_user_id
            ? { user_id: ob.assigned_user_id, name: ob.owner_name || null }
            : "UNASSIGNED",
          due_at: ob.due_at, is_overdue: ob.is_overdue, created_at: ob.created_at,
          instruction: DECISION_DETAIL,
        },
        person: person ? { name: person.name } : null,
        reply,
        candidates,
        candidate_count: candidates.length,
        selection_required: true,
        action: {
          method: "POST",
          path: `/operator/obligations/${ob.id}/inbound-decision/resolve`,
          body: { opportunity_id: "<one of candidates[].opportunity_id>" },
          meaning: "Select one opportunity; the server reopens exactly that one and closes this decision.",
        },
        blocked_reason,
      });
    } catch (e) {
      console.error("inbound-decision read error", e);
      return res.status(500).json({ error: "Could not read this decision." });
    }
  });

  return router;
};
