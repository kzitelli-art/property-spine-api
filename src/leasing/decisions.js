// ════════════════════════════════════════════════════════════════════
//  decisions.js — THE DECISION RAIL
//
//  Money decisions (rent forgiveness · write-off · waiver · CapEx recat)
//  as first-class captured claims. The one-mechanism doctrine: a
//  decision-shaped hole cannot stay empty and silent. Two bands:
//
//    ACT-THEN-REVIEW  amount ≤ the decider's own approval_cap (their
//                     active assignment on this property, 004) →
//                     recorded + CLOSED in one transaction, witnessed
//                     by a durable event. No obligation ceremony.
//
//    CLEAR-AND-PASS   amount > cap, or the decider holds NO cap here
//                     (fail-closed: ungranted authority = zero) →
//                     pending_grant + an OPEN obligation routed via
//                     spawnObligationFromEvent to the escalation
//                     target: the decider's escalates_to assignment's
//                     role (one hop), else 'owner'. Grant or deny —
//                     by someone whose cap covers the amount, or an
//                     owner — closes the loop. Denial is a decision.
//
//  AUTHORITY IS READ FROM assignments (approval_cap, dollars). This
//  module writes no policy. Coverage resolves at read-time: the
//  pending list resolves obligation.assigned_role → the CURRENT
//  active person, or shows UNASSIGNED honestly (never faked).
//
//  Factory (option-1 injection, house pattern):
//    require('./decisions')({ pool, spawnObligationFromEvent,
//                             completeObligation })
//  Mounted at "/" behind the global x-operator-key gate (these paths
//  are not in PUBLIC_EXACT/PUBLIC_PREFIXES — auth is server.js's job).
//
//  All consequential logic lives on _service (transaction-aware,
//  client-first) — routes are the thin HTTP skin, same shape as
//  leasingconversion/agent.
//
//  ⛔ MONEY BUILD 0.5 — THE LEGACY WRITER IS CLOSED (CLASS 2) ─────────
//
//  createDecision and resolveDecision REFUSE. Reads and history are
//  untouched: pendingDecisions, readAuthority, GET /decisions/pending
//  and GET /decisions/:id all behave exactly as before.
//
//  WHY, in one sentence: the canonical money sequence is
//
//      occurrence → obligation → economic decision → cash →
//      recognition → certification → issuance
//
//  and while canonical-domain ownership of each migration-059 decision
//  type is unresolved, this writer is a SECOND authority over economic
//  decisions. A second authority that still writes is not dormant — it
//  is competing, quietly, with whatever is ruled next.
//
//  This is containment, not retirement. The functions, the routes, the
//  service shape and the commitmentledger injection all stay exactly
//  where they are, so the eventual ruling reassigns a live boundary
//  rather than archaeology.
//
//  CLASS 2 — temporary containment adapter.
//  REMOVAL CONDITION — delete the legacy mutation functions, their
//  routes and the injection only when ALL of these are true:
//    1. every migration-059 decision type has a ruled canonical-domain
//       owner;
//    2. replacement commands exist where a replacement is needed;
//    3. legacy mutation compatibility is no longer required by any
//       caller;
//    4. the owner authorises retirement.
//  NOTICED BY — tests/e2e/legacy_decision_writes_disabled.e2e.js, which
//  fails the moment either writer stops refusing. Convenience is not a
//  replacement condition; neither is "nobody calls it anyway."
// ════════════════════════════════════════════════════════════════════

const express = require("express");

const DECISION_TYPES = ["rent_forgiveness", "writeoff", "waiver", "capex_recat", "concession"];
const REASON_CODES = ["hardship", "service_failure", "error_correction", "retention", "legal", "other"];

// assignments.role (004 + 041 vocabulary) → role_name enum for
// obligations.assigned_role. Extends money.js's mapRole with the two
// 041 rooms; unknown falls back like money.js does.
function mapRole(orgRole) {
  const map = {
    property_manager: "property_manager",
    maintenance: "maintenance",
    leasing: "leasing_agent",
    bookkeeper: "accountant",
    asset_manager: "asset_manager",
    owner: "owner",
    reporting: "accountant",
    capital: "owner",
  };
  return map[orgRole] || "property_manager";
}

function railError(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

//  ── THE CONTAINMENT WALL (Money Build 0.5, Class 2) ────────────────
//  One refusal, one vocabulary, two callers. The code and the reason are
//  EXACT and are asserted verbatim by the e2e proof — an approximate
//  refusal is a refusal nobody can build a gate on.
const LEGACY_DECISION_WRITES_DISABLED_CODE = "LEGACY_DECISION_WRITES_DISABLED";
const LEGACY_DECISION_WRITES_DISABLED_REASON =
  "Migration 059 decision writes are closed pending canonical-domain reassignment.";

//  `reason` rides on the error rather than being reconstructed at the HTTP
//  skin, so a DIRECT _service caller — which has no HTTP skin — gets the
//  same sentence the route returns. One boundary, one explanation.
function legacyDecisionWritesDisabled() {
  return railError(
    LEGACY_DECISION_WRITES_DISABLED_CODE,
    LEGACY_DECISION_WRITES_DISABLED_REASON,
    { reason: LEGACY_DECISION_WRITES_DISABLED_REASON }
  );
}

const TYPE_LABEL = {
  rent_forgiveness: "Rent forgiveness",
  writeoff: "Write-off",
  waiver: "Waiver",
  capex_recat: "CapEx recategorization",
  concession: "Concession",   // 064 — over-guardrail discretionary concessions
};

function money(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = function decisionsModule({ pool, spawnObligationFromEvent, completeObligation }) {
  const app = express.Router();

  // ── the authority read ─────────────────────────────────────────────
  // The decider's strongest active assignment on THIS property.
  // No row, or a NULL cap → cap 0 (fail-closed): nothing closes quietly
  // on authority nobody granted.
  async function readAuthority(client, property_id, person_id) {
    const r = await client.query(
      `select id, role, approval_cap, escalates_to_assignment_id
         from assignments
        where property_id = $1 and person_id = $2 and is_active = true
        order by approval_cap desc nulls last, created_at
        limit 1`,
      [property_id, person_id]
    );
    if (r.rowCount === 0) return { cap: 0, role: null, escalates_to_assignment_id: null };
    const a = r.rows[0];
    return {
      cap: a.approval_cap == null ? 0 : Number(a.approval_cap),
      role: a.role,
      escalates_to_assignment_id: a.escalates_to_assignment_id,
    };
  }

  // One hop up the 004 escalation graph → a role_name enum target.
  // No pointer, or a stale/inactive target → 'owner' (the ceiling).
  async function escalationTarget(client, escalates_to_assignment_id) {
    if (!escalates_to_assignment_id) return "owner";
    const r = await client.query(
      `select role from assignments where id = $1 and is_active = true`,
      [escalates_to_assignment_id]
    );
    if (r.rowCount === 0) return "owner";
    return mapRole(r.rows[0].role);
  }

  // ── SERVICE: createDecision ────────────────────────────────────────
  // The single write path both bands share. Transaction-aware
  // (client-first) so a future caller can fold it into its own atomic
  // unit — the HTTP route below owns its own transaction.
  async function createDecision(client, spec) {
    const {
      property_id, decided_by_person_id,
      type, amount, reason_code,
      note = null, person_id = null,
      related_id = null, related_type = null,
    } = spec || {};

    // validation — tight, boring, first
    if (!property_id) throw railError("BAD_INPUT", "property_id required");
    if (!decided_by_person_id) throw railError("BAD_INPUT", "decided_by_person_id required — a human must decide");
    if (!DECISION_TYPES.includes(type)) {
      throw railError("BAD_INPUT", `type must be one of: ${DECISION_TYPES.join(", ")}`);
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw railError("BAD_INPUT", "amount must be a positive number (dollars)");
    if (!REASON_CODES.includes(reason_code)) {
      throw railError("BAD_INPUT", `reason_code must be one of: ${REASON_CODES.join(", ")}`);
    }
    if (reason_code === "other" && (!note || !String(note).trim())) {
      throw railError("BAD_INPUT", "reason_code 'other' requires a note — words, not a shrug");
    }

    const prop = await client.query(`select id, name from properties where id = $1`, [property_id]);
    if (prop.rowCount === 0) throw railError("NOT_FOUND", "property not found");
    const who = await client.query(`select id, name from persons where id = $1`, [decided_by_person_id]);
    if (who.rowCount === 0) throw railError("NOT_FOUND", "decided_by person not found");
    if (person_id) {
      const subj = await client.query(`select id from persons where id = $1`, [person_id]);
      if (subj.rowCount === 0) throw railError("NOT_FOUND", "subject person not found");
    }

    const authority = await readAuthority(client, property_id, decided_by_person_id);
    const within = amt <= authority.cap;
    const label = `${TYPE_LABEL[type]} · ${money(amt)} · ${reason_code}`;

    if (within) {
      // ACT-THEN-REVIEW: recorded and closed in one stroke, witnessed.
      const ev = await client.query(
        `insert into events (property_id, person_id, type, note)
         values ($1,$2,'money_decision_recorded',$3) returning id`,
        [property_id, person_id, `${label} — decided within authority (cap ${money(authority.cap)})`]
      );
      const d = await client.query(
        `insert into decision_cases
           (property_id, person_id, related_id, related_type, type, amount,
            reason_code, note, state, decided_by_person_id, source_event_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'closed_recorded',$9,$10)
         returning *`,
        [property_id, person_id, related_id, related_type, type, amt,
         reason_code, note, decided_by_person_id, ev.rows[0].id]
      );
      return { decision: d.rows[0], band: "act_then_review", obligation: null };
    }

    // CLEAR-AND-PASS: the open loop, backed by an obligation the
    // engine owns. Event first (obligations are born from events).
    const target = await escalationTarget(client, authority.escalates_to_assignment_id);
    const ev = await client.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,'money_decision_escalated',$3) returning id`,
      [property_id, person_id,
       `${label} — exceeds decider's authority (cap ${money(authority.cap)}); needs grant`]
    );
    const d = await client.query(
      `insert into decision_cases
         (property_id, person_id, related_id, related_type, type, amount,
          reason_code, note, state, decided_by_person_id, source_event_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'pending_grant',$9,$10)
       returning *`,
      [property_id, person_id, related_id, related_type, type, amt,
       reason_code, note, decided_by_person_id, ev.rows[0].id]
    );
    const obligation = await spawnObligationFromEvent(client, {
      property_id,
      person_id,
      source_event_id: ev.rows[0].id,
      module: "accounting",
      type: "decision_grant",
      label: `${label} — needs grant`,
      assigned_role: target,
      escalates_to_role: "owner",
      priority: "high",
      related_id: d.rows[0].id,
      related_type: "decision_case",
    });
    const upd = await client.query(
      `update decision_cases set obligation_id = $1, updated_at = now()
        where id = $2 returning *`,
      [obligation.id, d.rows[0].id]
    );
    return { decision: upd.rows[0], band: "clear_and_pass", obligation };
  }

  // ── SERVICE: resolveDecision (grant | deny) ────────────────────────
  // One resolver, two verbs — the loop closes either way. Row-locked
  // (FOR UPDATE) so concurrent resolvers serialize; exactly one wins.
  async function resolveDecision(client, spec) {
    //  ⛔ FIRST STATEMENT, DELIBERATELY — same contract as createDecision.
    throw legacyDecisionWritesDisabled();

    //  ⚠ THE SIGNATURE MOVED FROM A DESTRUCTURING PARAMETER TO `spec`, AND
    //  THAT IS LOAD-BEARING. A destructuring parameter list is evaluated AT
    //  CALL TIME, before the function's first statement runs — so
    //  `resolveDecision(client)` or `resolveDecision(client, undefined)`
    //  would have thrown a bare TypeError instead of the governed refusal,
    //  and a caller would learn that something broke rather than that the
    //  writer is closed. "Refuse before payload destructuring" is not
    //  satisfiable while the payload is destructured in the signature.
    const { decision_id, verb, resolved_by_person_id, note = null } = spec || {};
    if (!["grant", "deny"].includes(verb)) throw railError("BAD_INPUT", "verb must be grant or deny");
    if (!resolved_by_person_id) throw railError("BAD_INPUT", `${verb === "grant" ? "granted" : "denied"}_by_person_id required — a human must resolve`);
    if (verb === "deny" && (!note || !String(note).trim())) {
      throw railError("BAD_INPUT", "deny requires a note — the person who cleared this deserves the why");
    }

    const dq = await client.query(
      `select * from decision_cases where id = $1 for update`, [decision_id]
    );
    if (dq.rowCount === 0) throw railError("NOT_FOUND", "decision not found");
    const d = dq.rows[0];
    if (d.state !== "pending_grant") {
      throw railError("NOT_PENDING", `decision is ${d.state} — only pending_grant can be ${verb}ed`, { state: d.state });
    }

    const who = await client.query(`select id, name from persons where id = $1`, [resolved_by_person_id]);
    if (who.rowCount === 0) throw railError("NOT_FOUND", "resolving person not found");

    // AUTHORITY GATE: an owner on this property, or anyone whose own
    // cap covers the amount. Deny takes the same authority as grant —
    // saying no is also exercising it.
    const auth = await readAuthority(client, d.property_id, resolved_by_person_id);
    const isOwner = auth.role === "owner";
    if (!isOwner && Number(d.amount) > auth.cap) {
      throw railError("NO_AUTHORITY",
        `${money(d.amount)} exceeds your approval cap (${money(auth.cap)}) — this needs someone whose authority covers it`,
        { amount: Number(d.amount), cap: auth.cap });
    }

    // Close the obligation through the shared back half — never our
    // own SQL for the engine's lifecycle.
    if (d.obligation_id) {
      await completeObligation(client, {
        obligation_id: d.obligation_id,
        completed_by: who.rows[0].name || resolved_by_person_id,
      });
    }

    const newState = verb === "grant" ? "granted" : "denied";
    const upd = await client.query(
      `update decision_cases
          set state = $1, resolved_by_person_id = $2, resolved_at = now(),
              resolution_note = $3, updated_at = now()
        where id = $4 returning *`,
      [newState, resolved_by_person_id, note, decision_id]
    );
    await client.query(
      `insert into events (property_id, person_id, type, note)
       values ($1,$2,$3,$4)`,
      [d.property_id, d.person_id, `money_decision_${newState}`,
       `${TYPE_LABEL[d.type]} · ${money(d.amount)} ${newState} by ${who.rows[0].name || "person"}${note ? " — " + note : ""}`]
    );
    return upd.rows[0];
  }

  // ── SERVICE: pendingDecisions ──────────────────────────────────────
  // The inbox read. Property-scoped. Resolves each open obligation's
  // assigned_role to the CURRENT active person at read-time — or
  // owner_person: null, which the caller must render as UNASSIGNED,
  // never a made-up name.
  async function pendingDecisions(client, { property_id }) {
    if (!property_id) throw railError("BAD_INPUT", "property_id required");
    const r = await client.query(
      `select d.*, o.assigned_role, o.status as obligation_status,
              cur.person_id as owner_person_id, cur.name as owner_person_name
         from decision_cases d
         join obligations o on o.id = d.obligation_id
         left join lateral (
             select a.person_id, p.name
               from assignments a
               join persons p on p.id = a.person_id
              where a.property_id = d.property_id
                and a.is_active = true
                and a.role = (case o.assigned_role::text
                                when 'leasing_agent' then 'leasing'
                                when 'accountant'    then 'bookkeeper'
                                else o.assigned_role::text end)
              order by a.created_at
              limit 1
         ) cur on true
        where d.property_id = $1 and d.state = 'pending_grant'
        order by d.decided_at asc`,
      [property_id]
    );
    return r.rows;
  }

  // ── HTTP skin ──────────────────────────────────────────────────────
  const httpStatus = {
    BAD_INPUT: 400, NOT_FOUND: 404, NOT_PENDING: 409,
    NO_AUTHORITY: 403, ALREADY_COMPLETE: 409, INPUTS_OUTSTANDING: 409,
    //  410 GONE, not 403 and not 404. The route is not forbidden to this
    //  caller and it is not missing — it existed, it was authoritative, and
    //  it has been deliberately closed. 410 is the only status that says so.
    LEGACY_DECISION_WRITES_DISABLED: 410,
  };
  function sendErr(res, e) {
    const s = httpStatus[e.code] || 500;
    const body = { error: e.message, code: e.code || "INTERNAL" };
    //  `error` is retained for existing callers; `code` and `reason` are the
    //  contract. A caller that reads only `error` keeps working.
    if (e.reason) body.reason = e.reason;
    if (e.state) body.state = e.state;
    if (e.cap != null) body.cap = e.cap;
    return res.status(s).json(body);
  }
  async function inTx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      try { await client.query("rollback"); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  // Create — both bands. Receipt says plainly which band it took.
  app.post("/decisions", async (req, res) => {
    try {
      const out = await inTx((c) => createDecision(c, req.body || {}));
      const d = out.decision;
      const receipt = out.band === "act_then_review"
        ? `Recorded and closed: ${TYPE_LABEL[d.type]} of ${money(d.amount)} (${d.reason_code}). Within your authority — no further action.`
        : `Cleared for grant: ${TYPE_LABEL[d.type]} of ${money(d.amount)} exceeds your authority. It is now in the ${out.obligation.assigned_role.replace(/_/g, " ")}'s pending decisions and cannot linger silently.`;
      res.status(201).json({ decision: d, band: out.band, obligation_id: d.obligation_id, receipt });
    } catch (e) { sendErr(res, e); }
  });

  // The inbox — pending grants for a property, owner resolved live.
  app.get("/decisions/pending", async (req, res) => {
    try {
      const rows = await inTx((c) => pendingDecisions(c, { property_id: req.query.property_id }));
      res.json({
        property_id: req.query.property_id,
        count: rows.length,
        pending: rows.map((r) => ({
          id: r.id, type: r.type, amount: Number(r.amount),
          reason_code: r.reason_code, note: r.note,
          person_id: r.person_id,
          decided_by_person_id: r.decided_by_person_id, decided_at: r.decided_at,
          assigned_role: r.assigned_role,
          owner_person_id: r.owner_person_id,
          owner_person_name: r.owner_person_name, // null = UNASSIGNED, render honestly
          obligation_id: r.obligation_id,
        })),
      });
    } catch (e) { sendErr(res, e); }
  });

  app.get("/decisions/:id", async (req, res) => {
    try {
      const r = await pool.query(`select * from decision_cases where id = $1`, [req.params.id]);
      if (r.rowCount === 0) return res.status(404).json({ error: "decision not found", code: "NOT_FOUND" });
      res.json({ decision: r.rows[0] });
    } catch (e) { sendErr(res, e); }
  });

  app.post("/decisions/:id/grant", async (req, res) => {
    try {
      const d = await resolveDecision(null, {   // ⛔ not inTx — see POST /decisions
        decision_id: req.params.id, verb: "grant",
        resolved_by_person_id: (req.body || {}).granted_by_person_id,
        note: (req.body || {}).note || null,
      });
      res.json({ decision: d, receipt: `Granted: ${TYPE_LABEL[d.type]} of ${money(d.amount)}. The loop is closed.` });
    } catch (e) { sendErr(res, e); }
  });

  app.post("/decisions/:id/deny", async (req, res) => {
    try {
      const d = await resolveDecision(null, {   // ⛔ not inTx — see POST /decisions
        decision_id: req.params.id, verb: "deny",
        resolved_by_person_id: (req.body || {}).denied_by_person_id,
        note: (req.body || {}).note || null,
      });
      res.json({ decision: d, receipt: `Denied: ${TYPE_LABEL[d.type]} of ${money(d.amount)}. The loop is closed — the decider can see why.` });
    } catch (e) { sendErr(res, e); }
  });

  // consequential logic exposed for future callers (house pattern)
  app._service = { createDecision, resolveDecision, pendingDecisions, readAuthority };
  return app;
};
