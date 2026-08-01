// ════════════════════════════════════════════════════════════════════
//  executed_lease_service.js — VERIFY EXECUTED LEASE
//
//  THE ONE canonical way a really-executed governing lease enters
//  Property Spine. Property Spine signs nothing. An authorized staff
//  member attests that a governing lease exists, identifies which exact
//  document version, and records its normalized governing terms.
//
//  Permanent by design: a paper lease, a DocuSign envelope, or a future
//  in-product signing system all land HERE. A signing provider would
//  feed this evidence model, never create a second lease-execution
//  architecture.
//
//  CLASSIFICATION (volunteered):
//    · this service, the table, the resolver body   → Class 1 permanent
//    · EXECUTED_LEASE_INTAKE_ENABLED + property     → Class 2, retired
//      allowlist                                       when execution
//                                                      intake activates
//                                                      for real operation
//
//  TRANSACTION: the CALLER owns begin/commit (same convention as
//  proposed_terms_service and the tenancy anchor). This service writes
//  on the passed client and never commits.
// ════════════════════════════════════════════════════════════════════

const { normalizeAndHash } = require("./proposed_terms_service");
// THE ONE canonical writer of lease_applications.status. This service records
// executed-lease evidence; it never moves the application lifecycle itself.
const lifecycle = require("./application_lifecycle");

// The normalization contract this service is built against. 085's
// normalizeAndHash is version 1. If that normalizer changes, this
// constant moves with it and old records stay honestly incomparable
// rather than silently mis-comparing.
const NORMALIZATION_VERSION = 1;

function err(httpStatus, code, message, extra) {
  const e = new Error(message || code);
  e.httpStatus = httpStatus; e.code = code; e.extra = extra || null;
  return e;
}
const badRequest = (c, m, x) => err(400, c, m, x);
const conflict = (c, m, x) => err(409, c, m, x);
const refused = (c, m, x) => err(403, c, m, x);

// ── ACTIVATION GATE ─────────────────────────────────────────────────
// Two independent controls, matching the application-intent pattern
// already proven live: the kill switch alone cannot be bypassed by the
// allowlist, and the allowlist alone cannot open the feature.
function gateState() {
  const enabled = process.env.EXECUTED_LEASE_INTAKE_ENABLED === "true";
  const ids = String(process.env.EXECUTED_LEASE_PROPERTY_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return { enabled, allowlist: ids };
}

function assertGate(property_id) {
  const { enabled, allowlist } = gateState();
  if (!enabled) {
    throw err(503, "executed_lease_intake_disabled",
      "Executed-lease intake is switched off on this deploy.");
  }
  if (allowlist.length === 0 || !allowlist.includes(String(property_id))) {
    throw err(503, "property_not_activated",
      "This property is not activated for executed-lease intake.");
  }
}

// ── THE RESOLVER SOURCE ─────────────────────────────────────────────
// The ONLY read that answers "does a verified governing lease exist for
// this application?" Takes an application id and nothing else — no
// caller-suppliable argument reaches it, which is what prevents a body
// assertion from becoming execution truth.
async function resolveVerifiedExecutionRecord(client, applicationId) {
  if (!applicationId) return null;
  const q = await client.query(
    `select * from executed_lease_records
      where application_id = $1 and record_state = 'verified'
      limit 1`,
    [applicationId]
  );
  return q.rows[0] || null;
}

// ── VERIFY (record) ─────────────────────────────────────────────────
//  ONE OPERATOR ACTION, TWO INTERNAL PHASES (ruling):
//    Phase 1 — record the governing evidence
//    Phase 2 — attempt operational admission
//  Phase 1 persists even when Phase 2 finds a conflict. Phase 2 never
//  throws on a disagreement, so the caller's single transaction commits
//  the evidence and the blocked verdict together. There is no separate
//  human "countersign" or "admit" step.
async function verifyExecutedLease(client, {
  application_id,
  space_id,
  rent, security_deposit, lease_start_date, lease_end_date,
  concession_status = "none", concession_schedule_id = null,
  document_reference = null, document_sha256 = null,
  provider_name = null, provider_document_id = null, provider_version_id = null,
  document_version = 1,
  executed_at, effective_date = null, signers, execution_channel,
  verified_by_user_id,
  supersedes_record_id = null,
  idempotency_key = null,
}, deps = {}) {
  if (!application_id) throw badRequest("application_id_required");
  if (!verified_by_user_id) throw badRequest("verified_by_user_id_required",
    "Verification is an attested act by a real staff user.");

  // ── the application, locked ──
  const app = (await client.query(
    "select * from lease_applications where id=$1 for update", [application_id]
  )).rows[0];
  if (!app) throw err(404, "application_not_found", "No application with that id.");

  assertGate(app.property_id);

  // ── PREMISES: the canonical leaseable atom is the space ──
  if (!space_id) {
    throw badRequest("space_required",
      "An executed lease must identify its premises. No premises, no verified execution record.");
  }
  const space = (await client.query(
    `select s.id, s.unit_id, u.property_id
       from spaces s join units u on u.id = s.unit_id
      where s.id = $1`, [space_id]
  )).rows[0];
  if (!space) throw badRequest("space_not_found", "No space with that id.");
  // PROPERTY WALL: the premises must belong to the application's property.
  if (String(space.property_id) !== String(app.property_id)) {
    throw refused("cross_property_space",
      "That space belongs to a different property than the application.");
  }
  // OBJECT IDENTITY — RECORDED, NOT REFUSED (ruling).
  // The executed document is the governing legal fact. An upstream
  // application disagreeing about premises must not stop Property Spine
  // from recording accurately what was actually signed. Both facts are
  // retained; confirm-term refuses with premises_conflict until an
  // authorized correction resolves it. Recording truth is never blocked;
  // operational activation is.
  const premises_conflict = (app.unit_id && String(space.unit_id) !== String(app.unit_id))
    ? { application_unit_id: app.unit_id, executed_space_unit_id: space.unit_id,
        executed_space_id: space_id,
        note: "The executed lease's premises are not in the unit this application named. " +
              "The record stands; term confirmation is blocked until this is corrected." }
    : null;

  // ── DOCUMENT IDENTITY: a mutable path is context, never proof ──
  const hasHash = !!document_sha256;
  const hasProviderVersion = !!(provider_document_id && provider_version_id);
  if (!hasHash && !hasProviderVersion) {
    throw badRequest("document_identity_required",
      "Record a document SHA-256, or an immutable provider document id AND version id. " +
      "A folder path can later point at different bytes; it cannot unlock tenancy on its own.");
  }

  // ── EXECUTION FACTS ──
  if (!executed_at) throw badRequest("executed_at_required", "When did the parties sign?");
  if (!Array.isArray(signers) || signers.length === 0) {
    throw badRequest("signers_required", "Record each signer's name and legal capacity.");
  }
  for (const s of signers) {
    if (!s || !s.name || !s.capacity) {
      throw badRequest("signer_shape_invalid",
        "Each signer needs at least { name, capacity }.");
    }
  }
  if (!["paper", "external_esign", "other"].includes(String(execution_channel))) {
    throw badRequest("execution_channel_invalid",
      "execution_channel must be paper | external_esign | other.");
  }

  // ── CONCESSIONS: a status word is not proof of matching economics ──
  // 085's normalizer accepts 'none' only, so a non-none concession cannot
  // be compared against acknowledged terms at all today. Fail closed
  // rather than imply hash equality proves concession equality.
  if (String(concession_status) !== "none" && !concession_schedule_id) {
    throw refused("concession_economics_unnormalized",
      "This lease carries a concession with no canonical normalized economics. " +
      "Structured concessions are not yet supported end to end; recording it would " +
      "imply an equality the hash cannot prove.");
  }

  // ── NORMALIZED GOVERNING TERMS: same normalizer as 085 ──
  const { canonical, payload_hash } = normalizeAndHash({
    rent, security_deposit, lease_start_date, lease_end_date, concession_status,
  });
  if (canonical.lease_end_date <= canonical.lease_start_date) {
    throw badRequest("end_must_be_after_start");
  }
  if (Number(canonical.rent) <= 0) throw badRequest("rent_must_be_positive");

  // ── IDEMPOTENCY: same key + same terms → the existing record ──
  if (idempotency_key) {
    const prior = (await client.query(
      `select * from executed_lease_records
        where application_id=$1 and idempotency_key=$2`,
      [application_id, idempotency_key])).rows[0];
    if (prior) {
      if (prior.payload_hash !== payload_hash) {
        throw conflict("idempotency_conflict",
          "Same idempotency key, different governing terms.");
      }
      // re-evaluate admission: a blocker may have been corrected upstream
      const re = await evaluateExecutedLeaseAdmission(client,
        { application_id, evaluation_context: "re_evaluation",
          evaluated_by_user_id: verified_by_user_id }, deps);
      return { idempotent: true, record_id: prior.id, payload_hash,
               record_state: "verified",
               activation_status: re.admitted ? "admitted" : "blocked",
               blockers: re.blockers, term_obligation_id: re.term_obligation_id || null,
               receipt: "This executed lease was already verified — no new record." };
    }
  }

  // ── SUPERSESSION: one live verified record. A correction supersedes. ──
  const live = await resolveVerifiedExecutionRecord(client, application_id);
  if (live) {
    // POST-CONFIRMATION BOUNDARY (ruling): once a lease was created from
    // this evidence, its basis may not be swapped out while the lease
    // stands. Ordinary supersession refuses; a lease amendment is required.
    if (live.lease_id) {
      throw conflict("lease_amendment_required",
        "A lease has already been created from this executed-lease record. Its basis cannot be " +
        "replaced while the lease stands — a lease amendment/correction is required.",
        { current_record_id: live.id, lease_id: live.lease_id });
    }
    if (!supersedes_record_id) {
      throw conflict("verified_execution_exists",
        "A verified executed lease already governs this application. To correct it, " +
        "supersede that record explicitly or void it — records are never edited.",
        { current_record_id: live.id });
    }
    if (String(supersedes_record_id) !== String(live.id)) {
      throw conflict("supersedes_stale",
        "supersedes_record_id does not point at the currently live verified record.",
        { current_record_id: live.id });
    }
    await client.query(
      `update executed_lease_records set record_state='superseded' where id=$1`, [live.id]);
  }

  // ── WRITE: immutable event first, then the record, then the pointer ──
  const ev = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1, $2, $3, 'executed_lease_verified', $4) returning id`,
    [app.property_id, app.person_id || null, space.unit_id,
     `executed lease verified for application ${application_id} ` +
     `(hash ${payload_hash.slice(0, 12)}, executed ${executed_at})`]
  )).rows[0];

  const rec = (await client.query(
    `insert into executed_lease_records
       (application_id, property_id, space_id,
        rent, security_deposit, lease_start_date, lease_end_date,
        concession_status, concession_schedule_id, payload_hash, normalization_version,
        document_reference, document_sha256, provider_name,
        provider_document_id, provider_version_id, document_version,
        executed_at, effective_date, signers, execution_channel,
        verified_by_user_id, event_id, supersedes_record_id, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     returning *`,
    [application_id, app.property_id, space_id,
     canonical.rent, canonical.security_deposit,
     canonical.lease_start_date, canonical.lease_end_date,
     canonical.concession_status, concession_schedule_id, payload_hash, NORMALIZATION_VERSION,
     document_reference, document_sha256, provider_name,
     provider_document_id, provider_version_id, document_version,
     executed_at, effective_date, JSON.stringify(signers), execution_channel,
     verified_by_user_id, ev.id, supersedes_record_id || null, idempotency_key]
  )).rows[0];

  await client.query(
    `update lease_applications set executed_lease_record_id=$1, updated_at=now() where id=$2`,
    [rec.id, application_id]);

  // ── PHASE 2 — attempt operational admission. Never throws on conflict,
  //    so the evidence recorded above stands either way.
  const admission = await evaluateExecutedLeaseAdmission(client,
    { application_id, evaluation_context: "verify", evaluated_by_user_id: verified_by_user_id }, deps);

  return {
    idempotent: false,
    record_id: rec.id,
    payload_hash,
    normalization_version: NORMALIZATION_VERSION,
    space_id,
    premises_conflict,
    // THE RECORD SUCCEEDED. Activation may still be blocked — the route
    // returns 200, not 409. A later confirm-term attempt returns 409
    // while blockers remain.
    record_state: "verified",
    activation_status: admission.admitted ? "admitted" : "blocked",
    blockers: admission.blockers,
    term_obligation_id: admission.term_obligation_id || null,
    supersedes_record_id: supersedes_record_id || null,
    receipt:
      `Executed lease verified for ${app.applicant_name || "this applicant"} — ` +
      `${canonical.lease_start_date} to ${canonical.lease_end_date} at $${canonical.rent}/mo. ` +
      (admission.admitted
        ? `Confirm the term next to create the tenancy anchor.`
        : `The executed lease is RECORDED and stands. Activation is blocked: ` +
          admission.blockers.map(b => b.code).join(", ") +
          `. Correct the conflict, then confirm the term.`),
  };
}

// ════════════════════════════════════════════════════════════════════
//  PHASE 2 — OPERATIONAL ADMISSION
//
//  Replaces the retired countersignService. Absorbs its legitimate
//  responsibilities (open term confirmation) and drops its illegitimate
//  one ("locked economics win" — the executed document is governing, so
//  a conflicting offer BLOCKS rather than overrides).
//
//  CRITICAL: a conflict is NOT an error. This never throws on a
//  disagreement. It returns { admitted:false, blockers:[...] } so the
//  caller's transaction commits Phase 1's evidence alongside a durable
//  blocked state. Only genuine failures propagate and roll back.
// ════════════════════════════════════════════════════════════════════
// ── 2a. READ-ONLY EVALUATION — no writes; transaction lock allowed ───
//  Separated deliberately: confirm-term must RECOMPUTE blockers inside
//  its own transaction rather than trust a stored verdict, and it must
//  do so without spawning obligations or moving application state.
//
//  This read acquires a row lock on the exact spaces.id before checking
//  overlapping leases. That lock is not a business-state write; it is the
//  serialization boundary that makes "one space, one tenancy" true under
//  concurrent confirm-term attempts. The caller must keep the transaction
//  open through any resulting lease insert and commit.
async function computeAdmissionBlockers(client, { application_id }) {
  const app = (await client.query(
    "select * from lease_applications where id=$1", [application_id])).rows[0];
  if (!app) throw err(404, "application_not_found", "No application with that id.");

  const record = await resolveVerifiedExecutionRecord(client, application_id);
  if (!record) {
    return { app, record: null,
      blockers: [{ code: "no_verified_execution",
        detail: "No verified executed lease governs this application." }],
      sources: { executed_lease_record_id: null } };
  }

  const blockers = [];
  const sources = {
    executed_lease_record_id: record.id,
    executed_lease_record_state: record.record_state,
    space_id: record.space_id,
  };

  // ── 0. THE LIFECYCLE WALL — ASKED, NEVER ATTEMPTED ──────────────────
  //  Admission moves the application to 'accepted_term_required', and that
  //  transition belongs to the lifecycle authority. Not every row may make
  //  it: a terminal application is immutable, and one that never reached
  //  approval carries no approval instant across the boundary. This service
  //  must not DISCOVER that by attempting the write — the refusal would roll
  //  back the caller's single transaction and destroy the executed-lease
  //  evidence Phase 1 already recorded. assessTransition answers the same
  //  question with no write and no throw, so an inadmissible row becomes a
  //  BLOCKER, the evidence still commits, and the 200-with-blocked contract
  //  survives. Confirm-term recomputes through this same function, so it
  //  refuses to build a tenancy on such a row for the same reason.
  //  already_in_state is NOT a blocker: an application already at — or past —
  //  term confirmation is admitted, and the authority issues no statement.
  const transition = lifecycle.assessTransition(
    app.status, lifecycle.STATUS.ACCEPTED_TERM_REQUIRED);
  sources.application_status = app.status || null;
  if (!transition.admissible && !transition.already_in_state) {
    blockers.push({ code: transition.code, detail: transition.reason,
      application_status: app.status || null });
  }

  // ── 1. what the TENANT ACKNOWLEDGED — the primary baseline ──
  // Prefer the confirmation bound to the SUBMITTED packet (what they
  // actually saw) over the application's current pointer, which may
  // have moved since acknowledgment.
  const pk = (await client.query(
    `select proposed_terms_confirmation_id from lease_packets
      where application_id=$1 and status='submitted'
      order by created_at desc limit 1`, [application_id])).rows[0];
  const confirmationId = (pk && pk.proposed_terms_confirmation_id)
    || app.proposed_terms_confirmation_id || null;
  sources.acknowledged_confirmation_id = confirmationId;
  sources.acknowledged_source = pk && pk.proposed_terms_confirmation_id
    ? "submitted_packet" : "application_pointer";

  if (!confirmationId) {
    blockers.push({ code: "no_acknowledged_terms",
      detail: "No proposed-terms confirmation exists to compare the executed lease against." });
  } else {
    const conf = (await client.query(
      `select id, rent, security_deposit, lease_start_date, lease_end_date,
              concession_status, payload_hash
         from application_proposed_terms_confirmations where id=$1`, [confirmationId])).rows[0];
    if (!conf) {
      blockers.push({ code: "no_acknowledged_terms",
        detail: "The referenced proposed-terms confirmation is missing." });
    } else if (Number(record.normalization_version) !== NORMALIZATION_VERSION) {
      // hashes produced under different normalization rules are not
      // comparable; pretending otherwise is worse than refusing
      blockers.push({ code: "normalization_version_mismatch",
        detail: `Record normalized at v${record.normalization_version}; this deploy compares at v${NORMALIZATION_VERSION}.`,
        record_normalization_version: record.normalization_version,
        service_normalization_version: NORMALIZATION_VERSION });
    } else if (conf.payload_hash !== record.payload_hash) {
      // ONE comparison: hash equality over the SAME normalizer.
      blockers.push({ code: "proposed_terms_conflict",
        detail: "The executed lease's governing terms differ from the terms the resident acknowledged.",
        acknowledged: { rent: conf.rent, security_deposit: conf.security_deposit,
                        lease_start_date: conf.lease_start_date, lease_end_date: conf.lease_end_date,
                        concession_status: conf.concession_status, payload_hash: conf.payload_hash },
        executed: { rent: record.rent, security_deposit: record.security_deposit,
                    lease_start_date: record.lease_start_date, lease_end_date: record.lease_end_date,
                    concession_status: record.concession_status, payload_hash: record.payload_hash } });
    }
  }

  // ── 2. premises — object identity, not economics ──
  // Lock the canonical leased atom before the overlap read. Confirm-term
  // calls this evaluator and performs its lease insert in the SAME
  // transaction, so competing confirmations on one space serialize: the
  // second waiter resumes after the first commit and sees the new lease.
  const sp = (await client.query(
    "select id, unit_id from spaces where id=$1 for update", [record.space_id])).rows[0];
  sources.executed_unit_id = sp ? sp.unit_id : null;
  sources.application_unit_id = app.unit_id || null;
  if (!sp) {
    blockers.push({ code: "premises_conflict", detail: "The executed lease's space no longer exists." });
  } else if (app.unit_id && String(sp.unit_id) !== String(app.unit_id)) {
    blockers.push({ code: "premises_conflict",
      detail: "The executed lease's premises are not in the unit this application named.",
      application_unit_id: app.unit_id, executed_space_id: record.space_id, executed_unit_id: sp.unit_id });
  }

  // ── 2b. OVERLAPPING OPERATIVE LEASE — one space, one tenancy ────────
  //  The same doctrine as the wall itself: evidence may be RECORDED
  //  (verify never refuses on this), but confirm-term may not CREATE a
  //  competing tenancy on a space that already has an operative lease
  //  overlapping these dates. 'pending' counts as operative here — two
  //  uncommenced commitments on one space is already a double-booking.
  //  The exact lease born from THIS executed record is excluded so a
  //  post-confirm re-evaluation does not conflict with itself. Excluding by
  //  application_id would be too broad: a stale or duplicate lease carrying
  //  the same application must still surface as a conflict. Before confirm-
  //  term record.lease_id is null, so nothing is excluded.
  const overlap = await client.query(
    `select id, lease_status, start_date, end_date, tenant_ids
       from leases
      where space_id = $1
        and ($2::uuid is null or id <> $2::uuid)
        and lease_status not in
            ('cancelled','terminated','rescinded','void','expired','superseded')
        and daterange(start_date, end_date, '[]')
            && daterange($3::date, $4::date, '[]')
      order by start_date asc`,
    [record.space_id, record.lease_id || null,
     record.lease_start_date, record.lease_end_date]);
  sources.overlap_check = {
    space_id: record.space_id,
    range: [record.lease_start_date, record.lease_end_date],
    excluded_self_lease_id: record.lease_id || null,
    competing_leases_found: overlap.rows.length,
  };
  if (overlap.rows.length > 0) {
    blockers.push({ code: "overlapping_operative_lease",
      detail: "An operative lease already occupies this space for overlapping dates. " +
              "The executed evidence stands; a competing tenancy will not be created. " +
              "Resolve the existing lease (terminate, supersede, or correct its dates) first.",
      competing: overlap.rows.map(l => ({
        lease_id: l.id, lease_status: l.lease_status,
        start_date: l.start_date, end_date: l.end_date,
        tenant_ids: l.tenant_ids || [],
      })) });
  }

  // ── 3. locked offer — DETECTS a discrepancy; never decides the numbers ──
  const sched = (await client.query(
    `select id from lease_economic_schedules
      where application_id=$1 and status='locked' order by created_at desc limit 1`,
    [application_id])).rows[0];
  sources.locked_schedule_id = sched ? sched.id : null;
  if (sched) {
    const br = (await client.query(
      `select amount from lease_economic_lines
        where schedule_id=$1 and line_type='base_rent'
        order by effective_month asc limit 1`, [sched.id])).rows[0];
    if (br && Math.abs(Number(br.amount) - Number(record.rent)) > 0.005) {
      blockers.push({ code: "locked_offer_conflict",
        detail: "The executed lease's rent differs from the locked offer economics. " +
                "The executed document governs; the disagreement must be corrected, not overridden.",
        locked_offer_rent: Number(br.amount), executed_rent: Number(record.rent) });
    }
  }

  return { app, record, blockers, sources, space: sp || null };
}

// ── 2b. RECORD THE EVALUATION — append-only history + fast projection ──
//  The row on executed_lease_records is a PROJECTION and is overwritten.
//  This writes the immutable history: a conflict that later clears must
//  not disappear.
async function recordAdmissionEvaluation(client, {
  record, application_id, blockers, sources,
  evaluation_context, evaluated_by_user_id = null,
}) {
  const result = blockers.length === 0 ? "admitted" : "blocked";
  if (record) {
    await client.query(
      `insert into executed_lease_admission_evaluations
         (executed_lease_record_id, application_id, result, blockers,
          sources_compared, evaluation_context, evaluated_by_user_id)
       values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [record.id, application_id, result, JSON.stringify(blockers),
       JSON.stringify(sources || {}), evaluation_context, evaluated_by_user_id]);

    await client.query(
      `update executed_lease_records
          set admission_status=$1, admission_blockers=$2::jsonb, admission_evaluated_at=now()
        where id=$3`,
      [result, JSON.stringify(blockers), record.id]);
  }
  return result;
}

// ════════════════════════════════════════════════════════════════════
//  PHASE 2 — OPERATIONAL ADMISSION
//
//  Replaces the retired countersignService. Absorbs its legitimate
//  responsibility (open term confirmation) and drops its illegitimate
//  one ("locked economics win" — the executed document is governing, so
//  a conflicting offer BLOCKS rather than overrides).
//
//  CRITICAL: a conflict is NOT an error. This never throws on a
//  disagreement. It returns { admitted:false, blockers:[...] } so the
//  caller's single transaction commits Phase 1's evidence alongside a
//  durable blocked verdict. Only genuine failures propagate and roll back.
// ════════════════════════════════════════════════════════════════════
async function evaluateExecutedLeaseAdmission(client, {
  application_id, evaluation_context = "verify", evaluated_by_user_id = null,
}, deps = {}) {
  const { spawnObligationFromEvent = null } = deps;

  const { app, record, blockers, sources, space } =
    await computeAdmissionBlockers(client, { application_id });

  if (!record) {
    return { admitted: false, blockers, sources };
  }

  await recordAdmissionEvaluation(client, {
    record, application_id, blockers, sources, evaluation_context, evaluated_by_user_id,
  });

  if (blockers.length > 0) {
    return { admitted: false, blockers, sources, record_id: record.id };
  }

  // ── CLEAN: open term confirmation (absorbed from countersignService) ──
  // Operator-facing meaning is "term confirmation required" — never
  // "accepted" or "countersigned", which imply a legal act after the
  // lease was already executed.
  //  The transition itself is the lifecycle authority's, on THIS transaction's
  //  client, in ONE statement. Two things that fixes at exactly this line:
  //  countersigned_at is no longer rewritten with now() on every idempotent
  //  re-verification (the authority coalesces it, and a replay from
  //  'accepted_term_required' issues no statement at all), and the previously
  //  unguarded update can no longer resurrect a terminal application.
  //  Admissibility was settled as a blocker above, so this cannot refuse here;
  //  if it ever did, that is a genuine invariant failure and it propagates.
  await lifecycle.markAcceptedTermRequired(client, { applicationId: app.id });

  const ev = (await client.query(
    `insert into events (property_id, person_id, unit_id, type, note)
     values ($1,$2,$3,'executed_lease_admitted',$4) returning id`,
    [app.property_id, app.person_id || null, space ? space.unit_id : null,
     `Executed lease admitted — term confirmation required (${app.applicant_name || "applicant"})`]
  )).rows[0];

  let termObligation = null;
  if (typeof spawnObligationFromEvent === "function") {
    try {
      termObligation = await spawnObligationFromEvent(client, {
        property_id: app.property_id,
        person_id: app.person_id,
        unit_id: space ? space.unit_id : app.unit_id,
        source_event_id: ev.id,
        related_id: app.id,
        related_type: "lease_application",
        module: "applications",
        type: "term_required",
        label: `Confirm lease term — ${app.applicant_name}${app.unit_label ? " · " + app.unit_label : ""}`,
        owner_type: "human",
        assigned_role: "property_manager",
        status: "open",
        priority: "high",
        severity: "normal",
        required_inputs: ["lease_term_confirmation"],
      });
    } catch (e) {
      // idempotency belt: never stack a second term_required
      if (e.code === "23505") {
        const ex = await client.query(
          `select id from obligations
            where related_id=$1 and related_type='lease_application'
              and type='term_required' and status in ('open','in_progress')
            order by created_at desc limit 1`, [app.id]);
        termObligation = ex.rows[0] || null;
      } else { throw e; }
    }
  }

  return {
    admitted: true, blockers: [], sources, record_id: record.id,
    term_obligation_id: termObligation ? termObligation.id : null,
  };
}

// ── VOID (correction without a replacement) ─────────────────────────
async function voidExecutedLease(client, { record_id, void_reason, voided_by_user_id }) {
  if (!record_id) throw badRequest("record_id_required");
  if (!void_reason) throw badRequest("void_reason_required",
    "A void is an attested correction; it carries its reason.");
  if (!voided_by_user_id) throw badRequest("voided_by_user_id_required");

  const rec = (await client.query(
    "select * from executed_lease_records where id=$1 for update", [record_id])).rows[0];
  if (!rec) throw err(404, "record_not_found", "No executed-lease record with that id.");
  if (rec.record_state === "voided") {
    return { idempotent: true, record_id, receipt: "Already voided." };
  }
  // Once a lease was created from it, the record is history — correct
  // forward with a superseding record, never void the anchor's basis.
  if (rec.lease_id) {
    throw conflict("lease_amendment_required",
      "A lease has already been created from this executed-lease record. It cannot be voided " +
      "while the lease stands — a lease amendment/correction is required.",
      { lease_id: rec.lease_id });
  }
  await client.query(
    `update executed_lease_records
        set record_state='voided', void_reason=$1, voided_by_user_id=$2, voided_at=now()
      where id=$3`, [void_reason, voided_by_user_id, record_id]);
  await client.query(
    `update lease_applications set executed_lease_record_id=null
      where executed_lease_record_id=$1`, [record_id]);
  return { idempotent: false, record_id, receipt: "Executed-lease record voided." };
}

module.exports = {
  verifyExecutedLease,
  evaluateExecutedLeaseAdmission,
  // confirm-term calls these two directly: RECOMPUTE from live sources
  // inside its own transaction, never trust the stored verdict.
  computeAdmissionBlockers,
  recordAdmissionEvaluation,
  voidExecutedLease,
  resolveVerifiedExecutionRecord,
  gateState,
  NORMALIZATION_VERSION,
};
