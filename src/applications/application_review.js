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
  //  The inventory LABELS travel with the application. lease_applications
  //  carries unit_id and space_id, but its denormalised unit_label is not
  //  populated by the writers — so this read named neither the unit nor the
  //  bed for an application at an exact space, while the Person Card and the
  //  standing read both named "Unit 3B · Bed B". Same fact, two stories.
  //  Joined from `units` and `spaces`, which own those labels.
  const q = await client.query(
    `select a.*, u.unit_number as inventory_unit_label, s.space_label as inventory_space_label
       from lease_applications a
       left join units  u on u.id = a.unit_id
       left join spaces s on s.id = a.space_id
      where a.id = $1`, [applicationId]);
  const app = q.rows[0];
  if (!app) return { app: null, reason: "not_found" };
  if (String(app.property_id) !== String(propertyId)) return { app: null, reason: "cross_property" };
  return { app };
}

async function latestPacket(client, applicationId) {
  // Canonical current packet: the non-superseded head, highest version.
  const q = await client.query(
    //  The instrument columns are SELECTED, not merely present. Without
    //  them this read cannot tell a packet that carries a real governing
    //  instrument from one that does not, and it offered "Verify Executed
    //  Lease" — the outside-attestation door — for a lease Spine itself is
    //  holding and waiting on the resident to sign.
    `select id, version, status, terms_json, is_placeholder,
            sent_at, tenant_token_expires_at, tenant_submitted_at,
            voided_at, void_reason, superseded_at,
            instrument_form_code, instrument_body_sha256,
            instrument_source_artifact_id, instrument_terms_sha256,
            instrument_package_sha256,
            resident_executed_at, company_executed_at,
            proposed_terms_confirmation_id, created_at, updated_at
       from lease_packets
      where application_id = $1
        and superseded_at is null
      order by version desc
      limit 1`, [applicationId]);
  const packet = q.rows[0] || null;
  if (!packet) return null;
  const signerRows = await client.query(
    `select s.signer_role, s.display_name, s.link_issued_at,
            s.token_expires_at, s.submitted_at,
            sf.completed_at as signature_completed_at
       from lease_packet_signers s
       left join lease_packet_fields sf
         on sf.lease_packet_id=s.lease_packet_id
        and sf.signer_role=s.signer_role
        and sf.field_type='signature'
      where s.lease_packet_id=$1
      order by case s.signer_role when 'tenant' then 1 else 2 end`,
    [packet.id]);
  packet.signing_parties = signerRows.rows.map((s) => ({
    signer_role: s.signer_role,
    display_name: s.display_name,
    link_issued_at: s.link_issued_at || null,
    token_expires_at: s.token_expires_at || null,
    submitted_at: s.submitted_at || null,
    signature_completed_at: s.signature_completed_at || null,
    complete: !!(s.submitted_at && s.signature_completed_at),
  }));
  return packet;
}

// One application-signing projection, derived only from the packet facts this
// canonical review already loads. It adds no lifecycle vocabulary: resident
// parties are outstanding only after their links are issued and before their
// own required signature evidence is complete; the company signer is
// outstanding only in the existing `resident_executed` packet state.
function packetSigningStanding(packet) {
  if (!packet || packet.voided_at || packet.superseded_at) {
    return {
      signing_started: false,
      resident_executed_at: packet ? (packet.resident_executed_at || null) : null,
      company_executed_at: packet ? (packet.company_executed_at || null) : null,
      outstanding_signers: [],
    };
  }

  const parties = Array.isArray(packet.signing_parties) ? packet.signing_parties : [];
  const residentSigningStarted = !!packet.sent_at || parties.some((party) => !!party.link_issued_at);
  const outstanding = residentSigningStarted
    ? parties.filter((party) => !party.complete).map((party) => ({
        signer_role: party.signer_role,
        display_name: party.display_name ||
          (party.signer_role === "guarantor" ? "Guarantor" : "Resident"),
      }))
    : [];

  if (packet.status === "resident_executed" && !packet.company_executed_at) {
    outstanding.push({ signer_role: "company", display_name: "Authorized company signer" });
  }

  return {
    signing_started: residentSigningStarted || !!packet.resident_executed_at,
    resident_executed_at: packet.resident_executed_at || null,
    company_executed_at: packet.company_executed_at || null,
    outstanding_signers: outstanding,
  };
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
  if (currency && currency.status === "stale") return "Packet stale — regenerate before resident review";
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
    const signing = packetSigningStanding(packet);
    rows.push({
      application_id: app.id, applicant_name: app.applicant_name || null,
      unit_label: app.unit_label || null, status: app.status,
      completeness: verdict.complete ? "complete" : "incomplete",
      missing_count: verdict.missing.length, packet_status: currency.status,
      concession_status: app.concession_status || "unknown",
      main_blocker: mainBlocker(verdict.complete, verdict.missing, currency),
      signing,
    });
  }
  const outstandingSigners = rows.flatMap((row) =>
    row.signing.outstanding_signers.map((signer) => ({
      application_id: row.application_id,
      applicant_name: row.applicant_name,
      unit_label: row.unit_label,
      signer_role: signer.signer_role,
      display_name: signer.display_name,
    })));
  return {
    property_id: propertyId,
    count: rows.length,
    applications: rows,
    signing: {
      applications_waiting_on_signature_count:
        new Set(outstandingSigners.map((signer) => String(signer.application_id))).size,
      outstanding_signer_count: outstandingSigners.length,
      outstanding_signers: outstandingSigners,
    },
  };
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
function executionPrimaryAction(app, exec, leaseId, packet) {
  if (!exec || exec.unavailable) return null;

  //  ── SPINE IS HOLDING A SIGNED INSTRUMENT ──────────────────────────
  //  When the resident has executed the governing instrument inside Spine,
  //  the next act is the COMPANY SIGNATURE — not a staff attestation that
  //  an outside lease exists. Offering "Verify Executed Lease" here pointed
  //  the operator at the attestation door for a lease Spine itself
  //  witnessed: the wrong button, and the "verify what I just signed"
  //  ceremony this product exists to remove. It would also have recorded
  //  the execution as staff_attestation when spine_instrument is the truth.
  //  Found by driving a resident signature and reading what the surface
  //  then told the operator to do.
  if (!leaseId && packet && packet.status === "resident_executed"
      && packet.instrument_source_artifact_id
      && packet.instrument_terms_sha256 && packet.instrument_package_sha256) {
    return { action: "company_execute_lease", label: "Sign for the Company",
      reason: "The resident has executed the governing instrument. The authorised company signer signs to complete it.",
      method: "POST",
      endpoint: `/operator/leasing/lease-packets/${packet.id}/company-sign` };
  }
  // A draft package has not reached a signer. The canonical application
  // action already offers issuance, so a second execution panel would falsely
  // describe signing as underway before any secure link exists.
  if (!leaseId && packet && packet.status === "draft"
      && packet.instrument_source_artifact_id
      && packet.instrument_terms_sha256 && packet.instrument_package_sha256) {
    return null;
  }
  //  Awaiting the resident on an instrument Spine holds — nothing for the
  //  company to do yet, and nothing to attest to.
  if (!leaseId && packet && packet.instrument_source_artifact_id
      && packet.instrument_terms_sha256 && packet.instrument_package_sha256
      && ["sent", "in_progress", "tenant_in_progress"].includes(packet.status)) {
    const waiting = (packet.signing_parties || []).filter((s) => !s.complete);
    const names = waiting.map((s) => s.display_name ||
      (s.signer_role === "guarantor" ? "the guarantor" : "the resident"));
    const waitingLabel = names.length ? names.join(" and ") : "the resident";
    return { action: "await_resident_execution", label: "Signing in Progress",
      reason: `The governing instrument is waiting for ${waitingLabel}.`,
      method: null, endpoint: null };
  }
  // A lease already exists for this application: confirm-term has run and the
  // tenancy anchor is created. Offering it again authors an action the server
  // will refuse. The next work is move-in, which the move-in read authors.
  if (leaseId) {
    return { action: "term_confirmed", label: "Term Confirmed",
      reason: "The lease term is confirmed and the tenancy anchor exists. Move-in work continues below.",
      method: null, endpoint: null };
  }
  if (!exec.present) {
    return { action: "verify_executed_lease", label: "Verify Executed Lease",
      reason: "No governing executed lease has been recorded for this application yet.",
      method: "POST",
      endpoint: `/operator/leasing/applications/${app.id}/executed-lease/verify` };
  }
  if (exec.activation_status === "blocked") {
    return { action: "review_conflict", label: "Review Conflict",
      reason: "The executed lease is recorded and stands, but operational activation is blocked.",
      method: null,
      endpoint: null,
      blockers: exec.blockers.map((b) => b.code) };
  }
  if (exec.activation_status === "admitted") {
    return { action: "confirm_term", label: "Confirm Term",
      reason: "The executed lease is verified and admitted. Confirm the term to create the lease and begin move-in work.",
      method: "POST",
      endpoint: `/operator/leasing/applications/${app.id}/confirm-term` };
  }
  return { action: "verify_executed_lease", label: "Verify Executed Lease",
    reason: "The executed lease has been recorded but not yet evaluated for activation.",
    method: "POST",
    endpoint: `/operator/leasing/applications/${app.id}/executed-lease/verify` };
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

  // 089: the lease this application produced, if confirm-term has run. The
  // move-in operating read is lease-keyed, so without this the operator app has
  // no way to reach it. Honest null before a lease exists.
  let lease_id = null;
  try {
    const lq = await client.query(
      `select id from leases
        where application_id = $1
          and lease_status not in ('cancelled','rescinded','void','superseded')
        order by created_at desc limit 1`, [app.id]);
    lease_id = lq.rows[0] ? lq.rows[0].id : null;
  } catch (e) { lease_id = null; }

  // 088 verify form: the premises picker needs the SPACES inside the
  // application's unit — the canonical leaseable atom is spaces.id, and the
  // browser must never guess it. Honest empty list when no unit is chosen.
  let unit_spaces = [];
  if (app.unit_id) {
    try {
      const sq = await client.query(
        `select id as space_id, coalesce(space_label, '(whole unit)') as space_label
           from spaces where unit_id = $1 order by created_at asc`, [app.unit_id]);
      unit_spaces = sq.rows;
    } catch (e) { unit_spaces = []; }
  }
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
        //  THE EXECUTION SEAM, ALREADY LOADED HERE.
        //  Without it the resolver cannot tell a lease waiting for the
        //  company's signature from one that was never executed at all, and
        //  answered "Executed lease required" to both. It is passed rather
        //  than re-queried so the resolver stays a pure interpreter.
        executed_lease,
      });
    } catch (e) {
      console.error("application-review resolveNext failed (non-fatal):", e.message);
      next_action = null;
    }
  }
  return {
    application_id: app.id,
    applicant: { name: app.applicant_name || null, person_id: app.person_id || null },
    unit: { unit_id: app.unit_id || null,
            unit_label: app.unit_label || app.inventory_unit_label || null },
    //  THE EXACT SPACE THIS APPLICATION IS FOR. Distinct from `unit_spaces`
    //  below, which is the MENU of spaces in the unit — a menu is not a
    //  choice, and reading one as the other is how a bed-level application
    //  gets reported as a whole-unit one.
    space: { space_id: app.space_id || null,
             space_label: app.inventory_space_label || null },
    status: app.status,
    next_action, // Slice 1: the server-authored operating instruction (null when resolver unwired)
    // 088: the execution seam, always visible — absent, verified+admitted,
    // or verified+blocked with its reasons and one clear primary action.
    executed_lease,
    execution_primary_action: executionPrimaryAction(app, executed_lease, lease_id, packet),
    // lease-keyed surfaces (move-in state) hang off this; null until confirm-term
    lease_id,
    unit_spaces,
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
      signing_parties: packet ? (packet.signing_parties || []) : [],
      //  WHO HAS EXECUTED THE INSTRUMENT. 184 records both acts on the
      //  packet and this read already loads them; not projecting them meant
      //  the operator's review screen could not say whether the resident had
      //  signed, while three other surfaces could.
      carries_governing_instrument: packet
        ? !!(packet.instrument_source_artifact_id
             && packet.instrument_body_sha256
             && packet.instrument_terms_sha256
             && packet.instrument_package_sha256)
        : null,
      instrument_form_code: packet ? (packet.instrument_form_code || null) : null,
      instrument_package_sha256: packet ? (packet.instrument_package_sha256 || null) : null,
      resident_executed_at: packet ? (packet.resident_executed_at || null) : null,
      company_executed_at: packet ? (packet.company_executed_at || null) : null,
      voided_at: packet ? (packet.voided_at || null) : null,
      drifted_fields: currency.drifted_fields,
      is_placeholder: packet ? !!packet.is_placeholder : null,
      note: currency.status === "stale" ? "Packet stale — regenerate before resident review."
        : currency.status === "not_generated" ? "Lease packet not generated yet. It will use the canonical application terms."
        : "Lease packet uses canonical application terms.",
    },
  };
}

module.exports = {
  buildReviewList, buildReviewDetail, packetCurrency, concessionDetail, mainBlocker,
  packetSigningStanding,
};
