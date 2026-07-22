// ════════════════════════════════════════════════════════════════════
//  application_review.js — Slice 2: make Build A visible to the operator.
//
//  READ-ONLY review/proof. NOT countersign, NOT lease execution, NOT packet
//  regeneration, NOT concession control. Four separate truths, kept distinct:
//    1. application terms   (the canonical source — Build A structured columns)
//    2. completeness        (applicationTermsComplete — Build A's contract)
//    3. concession state    (none | unknown | structured; structured shows the
//                            GOVERNED dated economic lines, never a text flag)
//    4. packet currency     (lease_packets.terms_json is persisted → drift is
//                            real: not_generated | current | stale)
//
//  ALL computation server-side. The browser displays the result; it never
//  compares legal/economic terms itself (constraint #1). Compare CANONICAL
//  values from terms_json vs. current structured columns, normalized — never
//  rendered text (constraint #2). Objects stay distinct — application, packet,
//  concession schedule, future lease are related but never collapsed (#3).
//
//  Two session-scoped operator routes (property SERVER-DERIVED from req.operator,
//  application verified to belong to that property):
//    GET /operator/leasing/applications-review        (the list)
//    GET /operator/leasing/application-review?application_id=  (the detail)
//
//  CLASSIFICATION: Class 1 permanent primitive (the review reads). No writes.
//
//  deps: { pool, requireOperator, requireLeasingModuleAccess }
//        (the operator-session middlewares, shared from operator.js)
// ════════════════════════════════════════════════════════════════════

const { applicationTermsComplete, structuredTerms } = require("./application_terms");

// Pure compute functions — operator.js owns the two thin session-scoped routes
// and calls these (same pattern as turn_priority.js). Keeps operator.js session
// middleware as the one auth path; keeps the review LOGIC here, tested in isolation.

const nDate = v => (v ? new Date(v).toISOString().slice(0, 10) : null);
const nNum = v => (v == null || v === "" ? null : Number(v));
const nStr = v => (v == null || v === "" ? null : String(v));

// packet drift: persisted terms_json snapshot vs. current structured columns.
function packetCurrency(app, packetRow) {
  if (!packetRow) return { status: "not_generated", drifted_fields: [] };
  let snap = packetRow.terms_json;
  if (typeof snap === "string") { try { snap = JSON.parse(snap); } catch (e) { snap = {}; } }
  snap = snap || {};
  const checks = [
    ["lease_start_date", nDate(snap.lease_start_date), nDate(app.lease_start_date)],
    ["lease_end_date",   nDate(snap.lease_end_date),   nDate(app.lease_end_date)],
    ["monthly_rent",     nNum(snap.monthly_rent),      nNum(app.rent)],
    ["security_deposit", nNum(snap.security_deposit),  nNum(app.deposit)],
    ["concession_status",nStr(snap.concession_status), nStr(app.concession_status)],
    ["unit_id",          nStr(snap.unit_id),           nStr(app.unit_id)],
    ["resident_names",   nStr(snap.resident_names),    nStr(app.applicant_name)],
  ];
  const drifted = checks.filter(([_, was, now]) => was !== now)
    .map(([field, was, now]) => ({ field, packet_value: was, current_value: now }));
  return { status: drifted.length ? "stale" : "current", drifted_fields: drifted };
}

async function concessionDetail(client, app) {
  const status = app.concession_status || "unknown";
  if (status !== "structured") return { status, lines: null, schedule_id: null };
  const sch = await client.query(
    `select id from lease_economic_schedules
      where application_id = $1 and status = 'locked'
      order by created_at desc limit 1`, [app.id]);
  if (!sch.rows.length) return { status, lines: [], schedule_id: null, note: "structured status has no governed schedule (incomplete)" };
  const scheduleId = sch.rows[0].id;
  const lines = await client.query(
    `select effective_month, line_type, amount, source_reference
       from lease_economic_lines where schedule_id = $1
      order by effective_month asc, line_type asc`, [scheduleId]);
  return {
    status, schedule_id: scheduleId,
    lines: lines.rows.map(r => ({
      effective_month: nDate(r.effective_month), line_type: r.line_type,
      amount: r.amount == null ? null : Number(r.amount), source_reference: r.source_reference || null,
    })),
  };
}

async function loadScopedApp(client, applicationId, propertyId) {
  const q = await client.query(`select * from lease_applications where id = $1`, [applicationId]);
  const app = q.rows[0];
  if (!app) return { app: null, reason: "not_found" };
  if (String(app.property_id) !== String(propertyId)) return { app: null, reason: "cross_property" };
  return { app };
}

async function latestPacket(client, applicationId) {
  // Canonical current packet: the non-superseded head, highest version.
  const q = await client.query(
    `select id, version, status, terms_json, is_placeholder,
            sent_at, tenant_token_expires_at, tenant_submitted_at,
            voided_at, void_reason, superseded_at,
            proposed_terms_confirmation_id, created_at, updated_at
       from lease_packets
      where application_id = $1
        and superseded_at is null
      order by version desc
      limit 1`, [applicationId]);
  return q.rows[0] || null;
}

// The proposed-terms confirmation the application currently points at.
async function loadConfirmation(client, app) {
  const cid = app && app.proposed_terms_confirmation_id;
  if (!cid) return null;
  const q = await client.query(
    `select id, source, rent, security_deposit, lease_start_date, lease_end_date,
            concession_status, actor_user_id, created_at
       from application_proposed_terms_confirmations
      where id = $1`, [cid]);
  return q.rows[0] || null;
}

function mainBlocker(complete, missing, currency) {
  if (!complete) {
    const first = missing[0];
    const label = {
      person: "no applicant on file", unit: "no unit assigned", rent: "rent not set",
      deposit: "deposit not set", start_date: "missing start date", end_date: "missing end date",
      end_date_after_start: "end date not after start", concession_unresolved: "concession unresolved",
      concession_unvalidated_no_client: "concession unvalidated",
      concession_structured_but_no_schedule: "concession marked structured but has no governed schedule",
    }[first] || first;
    return "Terms incomplete — " + label;
  }
  if (currency && currency.status === "stale") return "Packet stale — regenerate before countersign";
  if (currency && currency.status === "not_generated") return "Terms complete — packet not generated yet";
  return "Ready — terms complete, packet current";
}

// Build the LIST rows for a property.
async function buildReviewList(client, propertyId) {
  const apps = (await client.query(
    `select * from lease_applications where property_id = $1 order by created_at desc nulls last`,
    [propertyId])).rows;
  const rows = [];
  for (const app of apps) {
    const verdict = await applicationTermsComplete(app, client);
    const packet = await latestPacket(client, app.id);
    const currency = packetCurrency(app, packet);
    rows.push({
      application_id: app.id, applicant_name: app.applicant_name || null,
      unit_label: app.unit_label || null, status: app.status,
      completeness: verdict.complete ? "complete" : "incomplete",
      missing_count: verdict.missing.length, packet_status: currency.status,
      concession_status: app.concession_status || "unknown",
      main_blocker: mainBlocker(verdict.complete, verdict.missing, currency),
    });
  }
  return { property_id: propertyId, count: rows.length, applications: rows };
}

// Build the DETAIL payload for one scoped application (or a scope error).
// ── EXECUTED LEASE + ADMISSION (088) ────────────────────────────────
// A verified-but-blocked lease must never be invisible: the evidence would
// exist with nobody able to see what must happen next. Reads only; the
// blockers were authored by the admission evaluator, not re-derived here.
async function loadExecutedLease(client, app) {
  let rec = null;
  try {
    rec = (await client.query(
      `select id, space_id, rent, security_deposit, lease_start_date, lease_end_date,
              executed_at, execution_channel, document_reference, document_sha256,
              provider_name, provider_document_id, provider_version_id,
              record_state, admission_status, admission_blockers, admission_evaluated_at,
              verified_by_user_id, verified_at
         from executed_lease_records
        where application_id=$1 and record_state='verified' limit 1`, [app.id])).rows[0] || null;
  } catch (e) {
    // table absent (pre-088 deploy) → honest null, never a guess
    return { present: false, unavailable: true };
  }
  if (!rec) return { present: false };
  const blockers = Array.isArray(rec.admission_blockers)
    ? rec.admission_blockers
    : (() => { try { return JSON.parse(rec.admission_blockers || "[]"); } catch (_) { return []; } })();
  return {
    present: true,
    record_id: rec.id,
    space_id: rec.space_id,
    executed_at: rec.executed_at,
    execution_channel: rec.execution_channel,
    document: {
      reference: rec.document_reference || null,
      sha256: rec.document_sha256 || null,
      provider: rec.provider_name || null,
      provider_document_id: rec.provider_document_id || null,
      provider_version_id: rec.provider_version_id || null,
    },
    terms: {
      rent: nNum(rec.rent), security_deposit: nNum(rec.security_deposit),
      lease_start_date: nDate(rec.lease_start_date), lease_end_date: nDate(rec.lease_end_date),
    },
    verified_by_user_id: rec.verified_by_user_id,
    verified_at: rec.verified_at,
    activation_status: rec.admission_status,
    activation_evaluated_at: rec.admission_evaluated_at,
    blockers,
  };
}

// The one primary action an operator should take next on this application,
// as far as the execution seam is concerned. Honest about all three states.
function executionPrimaryAction(exec) {
  if (!exec || exec.unavailable) return null;
  if (!exec.present) {
    return { action: "verify_executed_lease", label: "Verify Executed Lease",
      reason: "No governing executed lease has been recorded for this application yet." };
  }
  if (exec.activation_status === "blocked") {
    return { action: "review_conflict", label: "Review Conflict",
      reason: "The executed lease is recorded and stands, but operational activation is blocked.",
      blockers: exec.blockers.map((b) => b.code) };
  }
  if (exec.activation_status === "admitted") {
    return { action: "confirm_term", label: "Confirm Term",
      reason: "The executed lease is verified and admitted. Confirm the term to create the lease and begin move-in work." };
  }
  return { action: "verify_executed_lease", label: "Verify Executed Lease",
    reason: "The executed lease has been recorded but not yet evaluated for activation." };
}

async function buildReviewDetail(client, applicationId, propertyId, resolvers) {
  const { app } = await loadScopedApp(client, applicationId, propertyId);
  if (!app) return { notInScope: true };
  const verdict = await applicationTermsComplete(app, client);
  const terms = structuredTerms(app);
  const packet = await latestPacket(client, app.id);
  const currency = packetCurrency(app, packet);
  const concession = await concessionDetail(client, app);
  const confirmation = await loadConfirmation(client, app);
  const executed_lease = await loadExecutedLease(client, app);
  const lineageMatches = !!(packet && confirmation &&
    String(packet.proposed_terms_confirmation_id) === String(confirmation.id));

  // ── Slice 1: server-authored next action (composition seam) ─────────────
  // operator.js passes { loadGate, resolveNext } from applicationsService —
  // the ONE canonical lifecycle resolver. This projection loads the facts;
  // the resolver interprets them. No lifecycle branching lives in this file,
  // and this file never requires the applications router. When the resolvers
  // are not wired (older server.js), next_action is an honest null — the
  // browser must not guess in its place.
  let next_action = null;
  if (resolvers && typeof resolvers.resolveNext === "function") {
    let gate = null;
    if (typeof resolvers.loadGate === "function") {
      // Single-read invariant: hand the one packet we already loaded to the gate
      // loader so it does NOT issue a second lease_packets query. The resolver
      // and the rendered detail therefore see the exact same current packet.
      try { gate = await resolvers.loadGate(client, app, { packet }); }
      catch (e) { console.error("application-review loadGate failed (non-fatal):", e.message); gate = null; }
    }
    try {
      next_action = resolvers.resolveNext(app, gate, {
        confirmation,
        packet,
        currency_status: currency.status,
        lineage_matches_current_confirmation: packet ? lineageMatches : null,
      });
    } catch (e) {
      console.error("application-review resolveNext failed (non-fatal):", e.message);
      next_action = null;
    }
  }
  return {
    application_id: app.id,
    applicant: { name: app.applicant_name || null, person_id: app.person_id || null },
    unit: { unit_id: app.unit_id || null, unit_label: app.unit_label || null },
    status: app.status,
    next_action, // Slice 1: the server-authored operating instruction (null when resolver unwired)
    // 088: the execution seam, always visible — absent, verified+admitted,
    // or verified+blocked with its reasons and one clear primary action.
    executed_lease,
    execution_primary_action: executionPrimaryAction(executed_lease),
    terms: {
      lease_start_date: nDate(terms.lease_start_date), lease_end_date: nDate(terms.lease_end_date),
      rent: nNum(terms.rent), deposit: nNum(terms.deposit),
      term_source: terms.term_source || null, terms_completed_at: terms.terms_completed_at || null,
    },
    completeness: { complete: verdict.complete, missing: verdict.missing },
    concession,
    proposed_terms_confirmation: confirmation ? {
      id: confirmation.id,
      source: confirmation.source,
      rent: nNum(confirmation.rent),
      security_deposit: nNum(confirmation.security_deposit),
      lease_start_date: nDate(confirmation.lease_start_date),
      lease_end_date: nDate(confirmation.lease_end_date),
      concession_status: confirmation.concession_status || null,
      confirmed_by: confirmation.actor_user_id || null,
      confirmed_at: confirmation.created_at || null,
    } : null,
    packet: {
      id: packet ? packet.id : null,
      version: packet ? packet.version : null,
      status: currency.status, // back-compat alias: existing Lease-packet panel reads d.packet.status
      currency_status: currency.status,
      lifecycle_status: packet ? packet.status : null,
      proposed_terms_confirmation_id: packet ? packet.proposed_terms_confirmation_id : null,
      lineage_matches_current_confirmation: packet ? lineageMatches : null,
      issued_at: packet ? (packet.sent_at || null) : null,
      sent_at: packet ? (packet.sent_at || null) : null,
      tenant_token_expires_at: packet ? (packet.tenant_token_expires_at || null) : null,
      tenant_submitted_at: packet ? (packet.tenant_submitted_at || null) : null,
      voided_at: packet ? (packet.voided_at || null) : null,
      drifted_fields: currency.drifted_fields,
      is_placeholder: packet ? !!packet.is_placeholder : null,
      note: currency.status === "stale" ? "Packet stale — regenerate before countersign."
        : currency.status === "not_generated" ? "Lease packet not generated yet. It will use the canonical application terms."
        : "Lease packet uses canonical application terms.",
    },
  };
}

module.exports = { buildReviewList, buildReviewDetail, packetCurrency, concessionDetail, mainBlocker };
