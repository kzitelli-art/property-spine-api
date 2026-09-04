// =============================================================
// lease_packets.js — Lease Packet v1, REBUILT as an obligation-input
// collector (NOT an activation engine).
//
//   What this module IS:
//     • the tenant-facing surface: one scrolling terms-review packet, inline
//       acknowledgments, a final acknowledgment.
//     • on final tenant submit (v3), it satisfies the SINGLE input
//       ("terms_acknowledged") on the application's terms_review obligation
//       — the one applications.js spawned at approve — and completes that
//       obligation in the SAME transaction (§5b atomicity). Nothing else.
//
//   What this module is NOT, and structurally cannot be:
//     • it has NO countersign route. Company acceptance is the tenancy
//       anchor's job, and countersign fails closed until real lease
//       execution exists (execution_evidence.js — Path B).
//     • it NEVER writes lease_applications.status. There is no SQL in this
//       file that touches that column.
//     • it NEVER satisfies a signature input. reviewed demonstration terms
//       ≠ signed governing lease — that equivalence is the retired bug.
//
//   The seam, exactly (v3):
//     resident acknowledges  →  packet reaches 'submitted'  →
//     satisfyObligation(terms_acknowledged) + completeObligation, atomically →
//     application_next = "Executed lease required"  →  FULL STOP.
//     Lease execution, countersign, tenancy: Path B, behind the execution
//     seam. This module cannot reach any of it.
//
//   Acknowledgment = review/intent only (Option A). The captured value is
//   audit evidence, NOT a legally-binding signature on the final lease. It
//   records that the resident reviewed the demonstration terms; the complete
//   lease and required addenda govern — delivered separately when the
//   property has no governing instrument on file, and carried BY the packet
//   when it does (184) — and a tenancy
//   begins only through the governed countersign/activation path.
//
//   Injection (server.js), mounted AFTER applications.js so the packet sits
//   behind the same approved-application record:
//     app.use("/", leasePacketsModule({ pool, satisfyObligation }));
//
//   Auth: NO local gate. Operator routes rely on the GLOBAL operator gate
//   in server.js. Tenant routes live under /t/ (globally exempt).
// =============================================================

const express = require("express");
const packetEligibility = require("./lease_packet_eligibility");
const crypto = require("crypto");

module.exports = function leasePacketsModule(deps) {
  const { pool, satisfyObligation, completeObligation } = deps;
  //  The canonical staff-session resolver and the canonical execution
  //  services. `executionServices` is a THUNK, not a value: this module is
  //  mounted before executed_lease_service and tenancy_anchor_service are
  //  composed in server.js, so a value captured now would be undefined
  //  forever. Called per request, the closure reads them after composition.
  //  Both are optional — without them the company-signature door reports
  //  itself unwired rather than half-working.
  const staffSessions = deps.staffSessions || null;
  const executionServices = typeof deps.executionServices === "function" ? deps.executionServices : null;
  if (typeof satisfyObligation !== "function" || typeof completeObligation !== "function") {
    throw new Error("leasePacketsModule requires { satisfyObligation, completeObligation } — the shared engine helpers. v3: submit satisfies AND completes the terms_review obligation in one transaction (§5b atomicity). Refusing to run a parallel path.");
  }
  const { executeSpineLease } = require("./spine_lease_execution");
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  const BASE_URL =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    "https://property-spine-api.onrender.com";

  // ─────────────── small helpers ───────────────
  const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  const stableHash = (v) => sha256(JSON.stringify(v ?? {}));
  const makeToken = () => crypto.randomBytes(32).toString("base64url");
  const clientIp = (req) => {
    const f = req.headers["x-forwarded-for"];
    if (typeof f === "string" && f.length) return f.split(",")[0].trim();
    return req.ip || null;
  };

  function requestAuditContext(req) {
    if (!req) return { ip_address: null, user_agent: null };
    return {
      ip_address: clientIp(req),
      user_agent: (req.headers && req.headers["user-agent"]) || null,
    };
  }

  function normalizeAuditContext(source) {
    if (!source) return { ip_address: null, user_agent: null };
    if (Object.prototype.hasOwnProperty.call(source, "ip_address") ||
        Object.prototype.hasOwnProperty.call(source, "user_agent")) {
      return {
        ip_address: source.ip_address || null,
        user_agent: source.user_agent || null,
      };
    }
    return requestAuditContext(source);
  }

  async function audit(q, source, packetId, actorRole, eventType, eventJson = {}) {
    const ctx = normalizeAuditContext(source);
    await q.query(
      `insert into lease_packet_audit_events
         (lease_packet_id, actor_role, event_type, event_json, ip_address, user_agent)
       values ($1,$2,$3,$4,$5,$6)`,
      [packetId, actorRole, eventType, eventJson, ctx.ip_address, ctx.user_agent]
    );
  }

  function packetError(httpStatus, code, receipt, extra = {}) {
    const e = new Error(receipt);
    e.httpStatus = httpStatus;
    e.code = code;
    e.body = { error: code, receipt, ...extra };
    return e;
  }

  function sendPacketError(res, e, logLabel, fallbackReceipt) {
    if (e && e.httpStatus) {
      return res.status(e.httpStatus).json(e.body || {
        error: e.code || "packet_write_refused",
        receipt: e.message,
      });
    }
    console.error(logLabel, e);
    return res.status(500).json({
      error: "internal",
      receipt: fallbackReceipt,
      detail: e && e.message ? e.message : null,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  //  LEASE TERMS REVIEW — DEMONSTRATION
  //
  //  This renders Property Spine's OWN plain-language summary of the
  //  verified property + application facts. It is NOT the NAA lease, not a
  //  condensed NAA lease, not a governing instrument, and it reproduces no
  //  NAA clause language, section structure, branding, or appearance. The
  //  complete lease and required addenda (delivered separately) govern.
  //
  //  Interaction: the tenant ACKNOWLEDGES demonstration terms. That records
  //  review/intent only. It does NOT activate a lease and is not a legal
  //  signature on the final instrument. Activation remains exclusively the
  //  governed manager-countersign path in applications.js.
  // ═══════════════════════════════════════════════════════════════════

  // ── CANONICAL LEASE-CONFIG RESOLVER ─────────────────────────────────
  //  ONE resolver. Order: (1) durable property.lease_config when it exists;
  //  (2) the external property-keyed configuration adapter; (3) null.
  //  There is NO property-ID branch in rendering or business logic — a
  //  property is a KEY into the config store, and the Demo Building is one
  //  key exactly as the real Solo property will be one key. Same contract,
  //  same failure mode. When a property has no configuration, this returns
  //  null and packet generation FAILS CLOSED (see requireLeaseConfig).
  function leaseConfigFor(property) {
    if (property && property.lease_config && typeof property.lease_config === "object") {
      return { source: "property.lease_config", cfg: property.lease_config };
    }
    const ext = property && EXTERNAL_LEASE_CONFIG[property.id];
    if (ext) return { source: "external_adapter", cfg: ext };
    return null;
  }

  // ── EXTERNAL LEASE-CONFIG ADAPTER ───────────────────────────────────
  //  CLASS 2 — TEMPORARY CONFIGURATION ADAPTER.
  //  Replacement condition: durable property lease configuration
  //  (properties.lease_config), OR an approved official lease-provider
  //  integration, becomes the canonical source. When that lands,
  //  leaseConfigFor reads it first (already does) and this map is deleted.
  //
  //  Each entry is the SAME shape a real property's lease_config row will
  //  be. The Demo Building entry carries Solo's real, verified fee values
  //  sourced from Solo's executed lease documents — configuration data, not
  //  code behavior. A real property added here (or given a lease_config row)
  //  resolves through the identical path with no code change.
  const EXTERNAL_LEASE_CONFIG = {
    // Demo Building (display "Solo on Chestnut") — verified Solo terms.
    "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe": {
      landlord_entity: "4233 Chestnut, LLC",
      rent_payment_location: "the on-site manager's office or the online payment site",
      application_fee: "50.00",
      amenity_fee: "300.00",
      amenity_fee_renewal: "250.00",
      telecom_fee: "99.00",
      utility_responsibility: "Resident pays all utilities; utilities are billed and allocated through Conservice.",
      late_fee: "75.00",
      // Verified Solo lease term (from Solo's executed lease documents),
      // NOT rendered as a statutory rule.
      notice_requirement: "At least 60 days' written notice before the end of the term to renew or move out (per Solo's lease terms).",
      insurance_note: "The owner does not insure resident personal property or personal injury; renter's insurance is recommended.",
    },
  };

  // Required configured terms. Missing ANY of these blocks generation — a
  // plausible default could produce a materially wrong lease. (notice and
  // utility are strings; fees are money strings; all must be present.)
  const REQUIRED_CONFIG_KEYS = [
    "landlord_entity", "application_fee", "amenity_fee",
    "utility_responsibility", "late_fee", "notice_requirement",
  ];

  // Fail-closed validation. Returns { ok, cfg, source } or { ok:false, missing }.
  // Also treats blank/placeholder application terms (rent, deposit, dates) as
  // missing — the demo summary must not display an economics blank.
  function requireLeaseConfig(property, terms) {
    const resolved = leaseConfigFor(property);
    const missing = [];
    if (!resolved) {
      return { ok: false, missing: ["(no lease configuration for this property)"] , cfg: null };
    }
    const cfg = resolved.cfg;
    for (const k of REQUIRED_CONFIG_KEYS) {
      const v = cfg[k];
      if (v == null || String(v).trim() === "") missing.push("config:" + k);
    }
    // Application-supplied economics must be real, not blank.
    const need = {
      resident_names: terms.resident_names,
      unit: terms.unit_label || terms.unit_number,
      monthly_rent: terms.monthly_rent,
      security_deposit: terms.security_deposit,
      lease_start_date: terms.lease_start_date,
      lease_end_date: terms.lease_end_date,
      property_address: terms.property_address && !/pending/i.test(terms.property_address) ? terms.property_address : "",
    };
    for (const [k, v] of Object.entries(need)) {
      if (v == null || String(v).trim() === "") missing.push("term:" + k);
    }
    if (missing.length) return { ok: false, missing, cfg };
    return { ok: true, cfg, source: resolved.source };
  }

  const money = (v) => (v != null && String(v).trim() !== "" ? "$" + v : null);

  // Property Spine's OWN plain-language sections. No NAA language/structure.
  // Every displayed economic value comes from validated application terms or
  // the canonical config (both already checked by requireLeaseConfig).
  function demoSummarySections(terms, cfg) {
    return [
      { key: "parties", title: "Parties & Unit", ack: false, body: [
        `Owner: ${cfg.landlord_entity}.`,
        `Resident(s): ${terms.resident_names}${terms.guarantor_required ? " (a guarantor is named on this application)" : ""}.`,
        //  THE INSTRUMENT NAMES WHAT IS BEING LET. In a unit let by the
        //  bed, "Unit 3B" is not what this resident is taking — they are
        //  taking one space inside it, and a lease that names only the unit
        //  is ambiguous about the thing it governs. The bed is appended
        //  only when the packet actually carries one, so a whole-unit lease
        //  reads exactly as it does today.
        terms.space_label
          ? `Unit: ${terms.unit_label || terms.unit_number}, ${terms.space_label}, ${terms.property_address}.`
          : `Unit: ${terms.unit_label || terms.unit_number}, ${terms.property_address}.`,
      ] },
      { key: "term", title: "Lease Dates", ack: true, body: [
        `Proposed start: ${terms.lease_start_date}.`,
        `Proposed end: ${terms.lease_end_date}.`,
      ] },
      { key: "rent", title: "Monthly Rent", ack: true, body: [
        `Rent: ${money(terms.monthly_rent)} per month, due in advance on the 1st.`,
        `Payable at ${cfg.rent_payment_location || "the location stated on the lease"}.`,
        money(cfg.late_fee) ? `Late fee if rent is not paid on time: ${money(cfg.late_fee)}.` : null,
      ].filter(Boolean) },
      { key: "deposit", title: "Security Deposit", ack: true, body: [
        `Security deposit: ${money(terms.security_deposit)}, due on or before signing the lease.`,
        "If Pennsylvania's security-deposit disposition timeline applies, an itemized accounting and any refund follow after move-out. The exact handling is governed by the lease and applicable law.",
      ] },
      { key: "fees", title: "Move-in Fees", ack: false, body: [
        money(cfg.application_fee) ? `Application fee (new residents): ${money(cfg.application_fee)}, non-refundable.` : null,
        money(cfg.amenity_fee) ? `Amenity fee at move-in: ${money(cfg.amenity_fee)}${money(cfg.amenity_fee_renewal) ? ` (${money(cfg.amenity_fee_renewal)} at renewal)` : ""}, non-refundable.` : null,
        money(cfg.telecom_fee) ? `Telecom / account set-up fee: ${money(cfg.telecom_fee)} at move-in.` : null,
      ].filter(Boolean) },
      { key: "utilities", title: "Utilities", ack: false, body: [
        cfg.utility_responsibility,
      ] },
      { key: "insurance", title: "Insurance", ack: false, body: [
        cfg.insurance_note || "Renter's insurance is recommended; the lease states the owner's limits of liability.",
      ] },
      { key: "notice", title: "Renewal / Move-out Notice", ack: false, body: [
        cfg.notice_requirement,
      ] },
      { key: "use", title: "Use & Occupancy", ack: false, body: [
        "The unit is for residential use only, by the residents and any occupants named on the lease.",
        "Residents keep the unit clean and in good condition and follow the community rules, which are part of the lease.",
      ] },
      { key: "maintenance", title: "Maintenance & Repairs", ack: false, body: [
        "Report maintenance issues through the resident portal or in writing; in an emergency (fire, gas, flooding, or a crime in progress) call 911 first, then notify the office.",
        "The owner makes needed repairs with reasonable diligence. Residents are responsible for damage they, their occupants, or their guests cause beyond ordinary wear.",
      ] },
      { key: "access", title: "Owner Access", ack: false, body: [
        "The owner may enter at reasonable times to make repairs, perform maintenance or inspections, or show the unit after a move-out notice, giving notice as required by the lease and law.",
      ] },
      { key: "alterations", title: "Alterations & Property", ack: false, body: [
        "Residents do not alter, paint, re-key, or make structural changes to the unit without the owner's written consent.",
        "Keys, fobs, fixtures, and appliances provided with the unit are returned in good condition at move-out.",
      ] },
      { key: "default", title: "Default & Remedies", ack: false, body: [
        "Not paying rent or other amounts when due, or breaking the lease or community rules, places the resident in default.",
        "On default the owner may pursue the remedies allowed by the lease and Pennsylvania law, including late charges and, where applicable, recovery of possession. The specific process and any charges are governed by the lease and applicable law.",
      ] },
      { key: "ack", title: "Acknowledge Demonstration Terms", ack: true, body: [
        "Acknowledging records that you have reviewed these proposed terms. It is not a signature on the lease and does not create or activate a tenancy.",
        "The complete lease and required addenda — provided separately — will govern. A tenancy begins only when the owner executes the lease through the normal process.",
      ] },
    ];
  }

  //  THE GOVERNING INSTRUMENT, WHEN THE PROPERTY HAS ONE.
  //  Read from the property's own lease configuration — the same durable
  //  object requireLeaseConfig already validates. It is OPTIONAL by design:
  //  a property with no lease form of record keeps exactly the behaviour it
  //  has today, a demonstration summary that is acknowledged and not signed.
  //  Both halves are required together; a form named without the hash of its
  //  bytes cannot be signed ON anything, which is the one thing 184's guard
  //  exists to refuse.
  function governingInstrumentFrom(cfg) {
    const gi = cfg && cfg.governing_instrument;
    if (!gi || typeof gi !== "object") return null;
    const form_code = String(gi.form_code || "").trim();
    const body_sha256 = String(gi.body_sha256 || "").trim();
    if (!form_code || !body_sha256) return null;
    return { form_code, form_version: String(gi.form_version || "").trim() || null, body_sha256 };
  }

  // Fields carried by a packet, as [key, section, label, type, signer_role].
  //
  // WITHOUT a governing instrument these are acknowledgment fields — review
  // and intent only, not a signature on a final instrument. That was the
  // whole truth while no instrument could exist.
  //
  // WITH one, the packet also carries the signatures that instrument is
  // signed by. The schema has admitted both since 034 (field_type
  // 'signature') and 184 (signer_role 'company'); only this builder never
  // reached for them, so 184's execution states and the whole execution rail
  // behind them were unreachable. Found by driving the path, not reading it.
  //
  //   · the resident signature is REQUIRED, so the resident's own submit
  //     gate refuses until it is made;
  //   · the company signature is NOT required, because the company signs
  //     AFTER the resident and a required field would deadlock that gate
  //     against the order 184's trigger enforces.
  function requiredFieldsFor(terms, instrument) {
    const base = [
      ["ack_term",    "term",    "Lease dates",              "acknowledgment", "tenant"],
      ["ack_rent",    "rent",    "Monthly rent",             "acknowledgment", "tenant"],
      ["ack_deposit", "deposit", "Security deposit",         "acknowledgment", "tenant"],
      ["ack_terms",   "ack",     "Demonstration terms",      "acknowledgment", "tenant"],
    ];
    if (terms.guarantor_required) {
      base.push(["ack_guarantor", "ack", "Guarantor acknowledgment", "acknowledgment", "tenant"]);
    }
    if (instrument) {
      base.push(["sign_resident", "ack", "Resident signature",  "signature", "tenant"]);
      base.push(["sign_company",  "ack", "Company signature",   "signature", "company"]);
    }
    return base;
  }

  const NOT_THE_LEASE_STATEMENT =
    "This is a demonstration summary of proposed lease terms. It is not the complete lease, does not replace the governing lease and required addenda, and does not create or activate a tenancy.";

  function buildRendered(terms, cfg) {
    return {
      title: "Lease Terms Review — Demonstration",
      is_placeholder: false,
      is_demonstration_summary: true,
      not_the_lease: NOT_THE_LEASE_STATEMENT,
      subtitle: terms.property_address || "",
      summary: {
        landlord_entity: cfg.landlord_entity,
        resident_names: terms.resident_names || "",
        unit: terms.unit_label || terms.unit_number || "",
        lease_start_date: terms.lease_start_date || "",
        lease_end_date: terms.lease_end_date || "",
        monthly_rent: terms.monthly_rent ?? "",
        security_deposit: terms.security_deposit ?? "",
        guarantor_required: !!terms.guarantor_required,
      },
      sections: demoSummarySections(terms, cfg),
    };
  }

  async function getBundle(q, packetId) {
    const pk = await q.query(`select * from lease_packets where id=$1`, [packetId]);
    if (!pk.rows[0]) return null;
    const fields = await q.query(
      `select * from lease_packet_fields where lease_packet_id=$1 order by display_order, created_at`,
      [packetId]);
    const docs = await q.query(
      `select * from lease_packet_documents where lease_packet_id=$1 order by created_at`,
      [packetId]);
    return { packet: pk.rows[0], fields: fields.rows, documents: docs.rows };
  }

  function publicPacket(bundle) {
    const { packet, fields, documents } = bundle;
    const req = fields.filter((f) => f.required);
    const done = req.filter((f) => f.completed).length;
    return {
      id: packet.id,
      property_id: packet.property_id,
      application_id: packet.application_id,
      unit_id: packet.unit_id,
      version: packet.version,
      status: packet.status,
      proposed_terms_confirmation_id: packet.proposed_terms_confirmation_id || null,
      sent_at: packet.sent_at || null,
      tenant_token_expires_at: packet.tenant_token_expires_at || null,
      is_placeholder: packet.is_placeholder,
      is_demonstration_summary: true,
      acknowledgment_meaning: "review_intent_only",   // NOT a signature on the lease
      terms: packet.terms_json,
      rendered_snapshot: packet.rendered_snapshot,
      progress: { completed: done, required: req.length },
      fields: fields.map((f) => ({
        id: f.id, field_key: f.field_key, section_key: f.section_key,
        label: f.label, field_type: f.field_type, signer_role: f.signer_role,
        required: f.required, completed: f.completed, completed_at: f.completed_at,
        display_order: f.display_order,
      })),
      documents: documents.map((d) => ({
        id: d.id, document_type: d.document_type, title: d.title,
        file_url: d.file_url, required_acknowledgment: d.required_acknowledgment,
        acknowledged_at: d.acknowledged_at,
      })),
    };
  }

  //  WHAT THE RESIDENT IS SHOWN. The packet holds every signature field,
  //  including the company's; the resident is shown only their own. This is
  //  ONE projection rather than a filter at one route, because the tenant
  //  surface answers from three places — the initial load, every field
  //  completion, and the final submit — and a filter applied to one of them
  //  is a rule the other two do not have. That is exactly what happened:
  //  the load was filtered, the completion response was not, and the
  //  landlord's "Sign" control reappeared on the resident's page the moment
  //  they acknowledged anything. Found by clicking through it in a browser.
  function residentPacket(bundle) {
    return publicPacket({
      ...bundle,
      fields: (bundle.fields || []).filter((f) => f.signer_role !== "company"),
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  OPERATOR ROUTES  (global gate applies — no local auth here)
  // ════════════════════════════════════════════════════════════════

  // ── CANONICAL PACKET WRITE SERVICE ─────────────────────────────────
  // One implementation, two operator doors:
  //   • legacy OPERATOR_KEY routes below
  //   • staff-session /operator/leasing/* adapters in operator.js

  async function generateLeasePacket(client, {
    applicationId,
    actorUserId = null,
    expectedPropertyId = null,
    createNewVersion = false,
    auditContext = null,
  }) {
    if (!applicationId) {
      throw packetError(400, "application_id_required", "An application id is required.");
    }

    const app = (await client.query(
      `select * from lease_applications where id=$1 for update`,
      [applicationId]
    )).rows[0];
    if (!app) {
      throw packetError(404, "application_not_found", "No application with that id.");
    }
    // ── THE ONE ELIGIBILITY PREDICATE ────────────────────────────────
    //  The existing packet is read FIRST so a single assessment sees every
    //  fact. Lock order is unchanged: lease_applications above, then
    //  lease_packets. Both were already `for update` selects.
    const existingPacket = (await client.query(
      `select * from lease_packets
        where application_id=$1 and superseded_at is null
        order by version desc limit 1 for update`,
      [app.id]
    )).rows[0] || null;

    const verdict = packetEligibility.assessLeasePacketEligibility(app, {
      existingPacket, expectedPropertyId, createNewVersion,
    });
    if (!verdict.eligible) {
      throw packetError(
        verdict.reason_code === packetEligibility.REASON.NOT_AT_PROPERTY ? 403 : 409,
        verdict.reason_code,
        verdict.message,
        {
          status: verdict.current_status,
          existing_packet_id: verdict.existing_packet_id,
          required_fact_missing: verdict.required_fact_missing,
        }
      );
    }

    const confirmationId = app.proposed_terms_confirmation_id || null;
    if (!confirmationId) {
      // Unreachable via the predicate above, which refuses on this fact first.
      // Kept as a belt-and-braces guard because everything below dereferences it.
      throw packetError(
        409,
        packetEligibility.REASON.NO_TERMS,
        "Confirm the proposed terms before generating the resident review packet."
      );
    }
    const confirmation = (await client.query(
      `select id, source, rent, security_deposit, lease_start_date, lease_end_date,
              concession_status, actor_user_id, created_at
         from application_proposed_terms_confirmations
        where id=$1`,
      [confirmationId]
    )).rows[0];
    if (!confirmation) {
      throw packetError(
        409,
        "no_current_proposed_terms_confirmation",
        "The application's current proposed-terms confirmation is missing."
      );
    }

    const prop = (await client.query(
      //  lease_config is SELECTED, not just referenced (186). leaseConfigFor
      //  reads `property.lease_config` first by design, but this explicit
      //  column list omitted it — so the durable path could never resolve
      //  even once the column existed, and every property fell through to
      //  the Class-2 EXTERNAL_LEASE_CONFIG map that holds Demo Building
      //  alone. Found by running the real path, not by reading it.
      `select id, name, canonical_key, address, lease_config from properties where id=$1`,
      [app.property_id]
    )).rows[0] || {};

    let unitLabel = app.unit_label || "";
    if (!unitLabel && app.unit_id) {
      const u = (await client.query(
        `select unit_number from units where id=$1`,
        [app.unit_id]
      )).rows[0];
      unitLabel = (u && u.unit_number) || "";
    }

    //  The bed's own label, read from inventory rather than trusted from a
    //  denormalised column, so the instrument can name it.
    let spaceLabel = "";
    if (app.space_id) {
      const sp = (await client.query(
        `select space_label from spaces where id=$1`, [app.space_id])).rows[0];
      spaceLabel = (sp && sp.space_label) || "";
    }

    const captured = app.captured || {};
    const terms = {
      property_address: prop.address || captured.property_address || "[property address pending]",
      landlord_legal_entity: captured.landlord_legal_entity || "[landlord entity pending — supply on the property record]",
      property_name: prop.name || "",
      resident_names: app.applicant_name || captured.resident_names || "",
      unit_id: app.unit_id || null,
      //  THE EXACT BED TRAVELS INTO THE SIGNED SNAPSHOT (182).
      //  The application has carried a space since 182 and the execution
      //  adapter states that the bed "travels from the packet, which took it
      //  from the application" — but this builder never took it, so every
      //  signed snapshot named a unit and no bed. In a unit let by the bed
      //  that is the difference between a lease and an ambiguity, and the
      //  adapter refused it rather than guess. Found by running the path.
      space_id: app.space_id || null,
      space_label: spaceLabel,
      unit_label: unitLabel,
      unit_number: unitLabel,
      monthly_rent: confirmation.rent != null ? confirmation.rent : "",
      security_deposit: confirmation.security_deposit != null ? confirmation.security_deposit : "",
      lease_start_date: confirmation.lease_start_date || "",
      lease_end_date: confirmation.lease_end_date || "",
      concession_status: confirmation.concession_status || "unknown",
      guarantor_required: !!app.guarantor_name,
    };

    const check = requireLeaseConfig(prop, terms);
    if (!check.ok) {
      throw packetError(
        409,
        "lease_configuration_incomplete",
        "Cannot generate the demonstration summary — required lease configuration or confirmed terms are missing. This fails closed rather than showing a plausible default that could be materially wrong.",
        { missing: check.missing }
      );
    }

    //  THE INSTRUMENT IS KNOWN BEFORE THE PACKET IS BUILT, NOT AFTER.
    //  Three pieces of the existing machinery force this order, and none of
    //  them is being changed:
    //    · fields are deleted and re-created on every generation, so a field
    //      set is born with a packet and is never bolted onto a live one;
    //    · packets are VERSIONED with supersession, which exists so a sent
    //      packet is never mutated in place — a packet generated before the
    //      form existed is superseded by the next version, not upgraded;
    //    · rendered_snapshot_hash is computed HERE. An instrument attached
    //      afterwards would not be what was rendered and hashed, and the
    //      signer would not be signing the exact hashed instrument, which is
    //      the single guarantee 184 exists to make.
    const instrument = governingInstrumentFrom(check.cfg);
    const rendered = buildRendered(terms, check.cfg);
    const renderedHash = stableHash(rendered);
    // Already read and already assessed by the predicate above.
    const current = existingPacket;

    let pk;
    if (current && current.status === "draft") {
      pk = (await client.query(
        `update lease_packets
            set terms_json=$2, rendered_snapshot=$3, rendered_snapshot_hash=$4,
                proposed_terms_confirmation_id=$5,
                instrument_form_code=$6, instrument_form_version=$7,
                instrument_body_sha256=$8,
                instrument_established_at = case when $8::text is null then null else now() end,
                is_placeholder=false, updated_at=now()
          where id=$1 returning *`,
        [current.id, terms, rendered, renderedHash, confirmation.id,
         instrument ? instrument.form_code : null,
         instrument ? instrument.form_version : null,
         instrument ? instrument.body_sha256 : null]
      )).rows[0];
      await audit(client, auditContext, pk.id, "system", "draft_regenerated", {
        rendered_snapshot_hash: renderedHash,
        proposed_terms_confirmation_id: confirmation.id,
        actor_user_id: actorUserId,
      });
    } else {
      const newVersion = current ? Number(current.version) + 1 : 1;
      const supersedes = current &&
        ["sent", "in_progress", "tenant_in_progress"].includes(current.status)
        ? current.id : null;
      pk = (await client.query(
        `insert into lease_packets
           (property_id, application_id, unit_id, version, status, terms_json,
            rendered_snapshot, rendered_snapshot_hash, is_placeholder,
            supersedes_packet_id, proposed_terms_confirmation_id,
            instrument_form_code, instrument_form_version, instrument_body_sha256,
            instrument_established_at)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,false,$8,$9,$10,$11,$12,
                 case when $12::text is null then null else now() end)
         returning *`,
        [
          app.property_id, app.id, terms.unit_id, newVersion, terms,
          rendered, renderedHash, supersedes, confirmation.id,
          instrument ? instrument.form_code : null,
          instrument ? instrument.form_version : null,
          instrument ? instrument.body_sha256 : null,
        ]
      )).rows[0];
      if (supersedes) {
        await client.query(
          `update lease_packets
              set superseded_at=now(), updated_at=now()
            where id=$1`,
          [supersedes]
        );
        await audit(client, auditContext, pk.id, "system", "version_superseded_prior", {
          superseded_packet_id: supersedes,
          new_version: newVersion,
          proposed_terms_confirmation_id: confirmation.id,
          actor_user_id: actorUserId,
        });
      }
    }

    await client.query(`delete from lease_packet_fields where lease_packet_id=$1`, [pk.id]);
    const requiredFields = requiredFieldsFor(terms, instrument);
    for (let i = 0; i < requiredFields.length; i++) {
      const [fk, sk, label, ft, role] = requiredFields[i];
      const clauseHash = stableHash(
        rendered.sections.find((s) => s.key === sk) || { sk, label }
      );
      //  The company signature is the one field that is NOT required: the
      //  resident's submit gate counts required-and-incomplete fields, and
      //  the company signs after the resident (184's trigger). Requiring it
      //  would deadlock the gate against the order the business performs.
      const isRequired = !(ft === "signature" && role === "company");
      await client.query(
        `insert into lease_packet_fields
           (lease_packet_id, field_key, section_key, label, field_type,
            signer_role, required, clause_hash, display_order)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [pk.id, fk, sk, label, ft, role, isRequired, clauseHash, i + 1]
      );
    }

    await client.query(`delete from lease_packet_documents where lease_packet_id=$1`, [pk.id]);
    const docs = [
      //  THE TITLE STATES WHAT IS ACTUALLY TRUE OF THIS PACKET.
      //  "delivered separately" was correct while Spine held no instrument.
      //  On a packet that CARRIES the governing instrument the resident is
      //  signing, it is a false statement on a resident-facing document —
      //  and the one most likely to be relied on. Found in the lifecycle
      //  drift audit, not by a test failing.
      { document_type: "lease_body",
        title: instrument
          ? `Complete Lease & Required Addenda (governing — ${instrument.form_code})`
          : "Complete Lease & Required Addenda (governing — delivered separately)",
        required_acknowledgment: false },
      { document_type: "rental_license", title: "Rental License", required_acknowledgment: true },
      { document_type: "rental_suitability", title: "Certificate of Rental Suitability", required_acknowledgment: true },
    ];
    for (const d of docs) {
      await client.query(
        `insert into lease_packet_documents
           (lease_packet_id, document_type, title, required_acknowledgment)
         values ($1,$2,$3,$4)`,
        [pk.id, d.document_type, d.title, d.required_acknowledgment]
      );
    }

    await audit(client, auditContext, pk.id, "operator", "packet_generated", {
      application_id: app.id,
      proposed_terms_confirmation_id: confirmation.id,
      actor_user_id: actorUserId,
      is_demonstration_summary: true,
      config_source: check.source,
    });

    const bundle = await getBundle(client, pk.id);
    return {
      receipt: `Lease Terms Review (Demonstration) generated for ${terms.resident_names || "applicant"} from the current confirmed proposed terms. This is a demonstration summary, not the lease; the complete lease and required addenda govern.`,
      packet: publicPacket(bundle),
    };
  }

  async function issueLeasePacketLink(client, {
    packetId,
    expiresDays = 14,
    idempotencyKey = null,
    actorUserId = null,
    expectedPropertyId = null,
    auditContext = null,
  }) {
    if (!packetId) {
      throw packetError(400, "packet_id_required", "A packet id is required.");
    }

    const row = (await client.query(
      `select pk.*,
              la.property_id as application_property_id,
              la.status as application_status,
              la.proposed_terms_confirmation_id as current_confirmation_id
         from lease_packets pk
         join lease_applications la on la.id=pk.application_id
        where pk.id=$1
        for update of pk, la`,
      [packetId]
    )).rows[0];
    if (!row) {
      throw packetError(404, "packet_not_found", "No lease packet with that id.");
    }
    if (expectedPropertyId &&
        (String(row.property_id) !== String(expectedPropertyId) ||
         String(row.application_property_id) !== String(expectedPropertyId))) {
      throw packetError(403, "not_permitted", "This action is not permitted.");
    }
    if (row.superseded_at) {
      throw packetError(
        409,
        "packet_superseded",
        "This packet has been superseded and cannot be issued.",
        { packet_id: row.id, status: row.status }
      );
    }

    if (["sent", "in_progress", "tenant_in_progress"].includes(row.status)) {
      return {
        receipt: "The resident review link was already issued. No new token was created.",
        already_issued: true,
        tenant_url: null,
        packet_id: row.id,
        status: row.status,
      };
    }
    if (row.status !== "draft") {
      throw packetError(
        409,
        "packet_not_issuable",
        `Packet is '${row.status}' and cannot be issued.`,
        { packet_id: row.id, status: row.status }
      );
    }
    if (!row.current_confirmation_id) {
      throw packetError(
        409,
        "no_current_proposed_terms_confirmation",
        "The application has no current proposed-terms confirmation."
      );
    }
    if (!row.proposed_terms_confirmation_id) {
      throw packetError(
        409,
        "packet_lineage_unproven",
        "This draft is not bound to a proposed-terms confirmation. Regenerate it before issue."
      );
    }
    if (String(row.proposed_terms_confirmation_id) !== String(row.current_confirmation_id)) {
      throw packetError(
        409,
        "packet_confirmation_mismatch",
        "This draft was generated from an older proposed-terms confirmation. Regenerate it before issue."
      );
    }
    // The SAME hand-maintained list lived here too. Issuing is a different act
    // from generating, so it keeps its own reason code — but the status
    // prerequisite is identical and now comes from the one derived set rather
    // than a second copy that could drift from the first.
    if (!packetEligibility.PACKET_ELIGIBLE_STATUSES.includes(row.application_status)) {
      throw packetError(
        409,
        "application_not_issuable",
        `Application is '${row.application_status}' and the packet cannot be issued.`,
        { status: row.application_status }
      );
    }

    const days = Number(expiresDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw packetError(400, "invalid_expiry", "expires_days must be a positive number.");
    }

    const token = makeToken();
    const tokenHash = sha256(token);
    const pk = (await client.query(
      `update lease_packets
          set status='sent',
              tenant_token_hash=$2,
              tenant_token_expires_at=now() + ($3 || ' days')::interval,
              sent_at=coalesce(sent_at,now()),
              updated_at=now()
        where id=$1 and status='draft' and superseded_at is null
        returning *`,
      [row.id, tokenHash, days]
    )).rows[0];
    if (!pk) {
      throw packetError(
        409,
        "packet_not_issuable",
        "The packet changed before issue. Reload and try again."
      );
    }

    await audit(client, auditContext, pk.id, "operator", "packet_sent", {
      expires_days: days,
      idempotency_key: idempotencyKey || null,
      actor_user_id: actorUserId,
      proposed_terms_confirmation_id: pk.proposed_terms_confirmation_id || null,
    });

    return {
      receipt: `Link issued (expires in ${days} days). This captures the resident's acknowledgment of demonstration terms only — not a signature on the lease.`,
      already_issued: false,
      tenant_url: `${BASE_URL}/t/lease/${encodeURIComponent(token)}`,
      packet_id: pk.id,
      status: pk.status,
    };
  }

  router.post("/applications/:id/lease-packet", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await generateLeasePacket(client, {
        applicationId: req.params.id,
        actorUserId: null,
        createNewVersion: !!(req.body && req.body.create_new_version === true),
        auditContext: requestAuditContext(req),
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return sendPacketError(res, e, "lease-packet generate:", "Could not generate the lease packet.");
    } finally {
      client.release();
    }
  });

  router.get("/lease-packets/:id", async (req, res) => {
    try {
      const bundle = await getBundle(pool, req.params.id);
      if (!bundle) return res.status(404).json({ receipt: "No lease packet with that id." });
      return res.json({ packet: publicPacket(bundle) });
    } catch (e) {
      return res.status(500).json({ receipt: "Could not read the lease packet.", error: e.message });
    }
  });

  router.post("/lease-packets/:id/send", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await issueLeasePacketLink(client, {
        packetId: req.params.id,
        expiresDays: req.body && req.body.expires_days != null ? req.body.expires_days : 14,
        idempotencyKey: (req.body && req.body.idempotency_key) || null,
        actorUserId: null,
        auditContext: requestAuditContext(req),
      });
      await client.query("commit");
      return res.json(out);
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return sendPacketError(res, e, "lease-packet issue:", "Could not issue the lease packet.");
    } finally {
      client.release();
    }
  });

  // ── THE COMPANY SIGNATURE — ONE ACT ─────────────────────────────
  //  The company signs, and that single act carries the instrument to
  //  canonical truth. That is the adapter's own stated contract:
  //
  //      "THE OPERATOR EXPERIENCES ONE ACT. Company signs. Internally that
  //       still travels executed → admitted → accepted_term_required →
  //       confirmTermService → pending lease anchor... What it may not have
  //       is a second human click."
  //
  //  This route OWNS NOTHING. It completes an existing signature field on an
  //  existing packet using columns 184 added, moves the packet through states
  //  184 defined, and delegates to executeSpineLease — which in turn composes
  //  the ONE executed-lease service and the ONE tenancy writer. No second
  //  execution path, no second tenancy writer, no new evidence model.
  //
  //  WHO MAY BIND THE COMPANY IS NOT DECIDED HERE. That is an open ruling
  //  (R2). The gate is the EXISTING leasing/management entitlement, and the
  //  record names the human who acted — 184's column says exactly this:
  //  "this column records who did, it does not decide who may."
  router.post("/operator/leasing/lease-packets/:id/company-sign", async (req, res) => {
    if (!staffSessions || !executionServices) {
      return res.status(503).json({
        error: "execution_not_wired",
        receipt: "In-Spine lease execution is not wired on this deploy.",
      });
    }
    let operator;
    try {
      operator = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
    } catch (e) {
      return res.status(500).json({ error: "session_resolution_failed", receipt: "The operator session could not be resolved." });
    }
    if (!operator) {
      return res.status(401).json({ error: "no_operator_session", receipt: "No valid operator session. Sign in." });
    }
    const modules = Array.isArray(operator.allowed_modules) ? operator.allowed_modules : [];
    if (!modules.includes("leasing") && !modules.includes("management")) {
      return res.status(403).json({
        error: "module_not_authorized",
        receipt: "Your assignment at this property does not authorize signing a lease for the company.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const pk = (await client.query(
        `select * from lease_packets where id=$1 for update`, [req.params.id])).rows[0];
      if (!pk) { await client.query("rollback"); return res.status(404).json({ receipt: "No lease packet with that id." }); }

      //  THE SESSION'S PROPERTY IS THE WALL. A packet at another property is
      //  not this operator's to sign, and the property comes from the session
      //  rather than the request.
      if (String(pk.property_id) !== String(operator.property_id)) {
        await client.query("rollback");
        return res.status(403).json({
          error: "packet_not_at_your_property",
          receipt: "That lease packet belongs to another property.",
        });
      }

      //  EACH REFUSAL NAMES ITS OWN REASON. A single "the resident has not
      //  executed" for every non-signable packet is false on three of these
      //  four paths — an operator told that about a packet the resident
      //  definitely signed would go looking for the wrong thing. Caught by
      //  reading what the hostile replay and supersession cases actually
      //  reported, not by the fact that they refused.
      if (pk.voided_at || pk.status === "voided") {
        await client.query("rollback");
        return res.status(409).json({
          error: "packet_voided",
          receipt: "This lease packet was voided and cannot be executed.",
        });
      }
      if (pk.superseded_at) {
        await client.query("rollback");
        return res.status(409).json({
          error: "packet_superseded",
          receipt: "This packet was superseded by a later version. Execute the current version; "
                 + "this one remains evidence of what was issued.",
        });
      }
      if (pk.status === "executed") {
        await client.query("rollback");
        return res.status(409).json({
          error: "packet_already_executed",
          receipt: "This packet is already executed. It is not signed twice.",
          company_executed_at: pk.company_executed_at,
        });
      }
      //  THE RESIDENT SIGNS FIRST. 184's trigger enforces this in Postgres;
      //  refusing here too means the operator gets an explanation instead of
      //  a constraint violation.
      if (pk.status !== "resident_executed") {
        await client.query("rollback");
        return res.status(409).json({
          error: "resident_has_not_executed",
          receipt: `This packet is '${pk.status}'. The resident signs the instrument before the company does.`,
        });
      }

      const field = (await client.query(
        `update lease_packet_fields
            set completed=true, completed_at=now(), field_value=$3,
                signed_by_user_id=$4, session_id=$5, ip_address=$6, user_agent=$7
          where lease_packet_id=$1 and field_key=$2
            and field_type='signature' and signer_role='company'
            and completed=false
          returning *`,
        [pk.id, "sign_company", operator.name || "the authorised company signer",
         operator.id, operator.session_id || null, clientIp(req),
         (req.headers && req.headers["user-agent"]) || null])).rows[0];
      if (!field) {
        await client.query("rollback");
        return res.status(409).json({
          error: "no_company_signature_field",
          receipt: "This packet carries no outstanding company signature. It may already be executed, or it was generated before the property had a governing instrument.",
        });
      }

      await client.query(
        `update lease_packets
            set status='executed',
                company_executed_at = coalesce(company_executed_at, now()),
                updated_at=now()
          where id=$1`, [pk.id]);
      await audit(client, req, pk.id, "operator", "company_executed", {
        signed_by_user_id: operator.id,
        instrument_body_sha256: pk.instrument_body_sha256,
      });

      //  ── AND THE SAME ACT REACHES CANONICAL TRUTH ──────────────────
      const svcs = executionServices() || {};
      const out = await executeSpineLease(
        client,
        { lease_packet_id: pk.id, company_signer_user_id: operator.id },
        { executedLease: svcs.executedLease, confirmTerm: svcs.confirmTerm,
          spawnObligationFromEvent: svcs.spawnObligationFromEvent }
      );
      await client.query("commit");
      return res.status(201).json({
        receipt: out.tenancy_error
          ? "Lease executed and recorded. Activation is blocked — the executed lease stands and names the conflict."
          : "Lease executed. The signed instrument is canonical truth.",
        ...out,
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (e && e.svc) return res.status(e.http || 409).json(e.body);
      console.error("company-sign:", e);
      return res.status(500).json({ receipt: "Could not execute the lease.", error: e.message });
    } finally { client.release(); }
  });

  // ════════════════════════════════════════════════════════════════
  //  TENANT ROUTES  (under /t/ — globally exempt from operator gate)
  // ════════════════════════════════════════════════════════════════

  // Serve the tenant HTML at /t/lease/:token (no static serving in server.js).
  // The file currently lives at the repo ROOT (not public/). Resolve to
  // whichever location actually exists so this cannot silently 404, and log
  // clearly if it is genuinely missing.
  const fsMod = require("fs");
  const pathMod = require("path");
  const TENANT_HTML_CANDIDATES = [
    pathMod.join(__dirname, "tenant_lease_packet.html"),
    pathMod.join(__dirname, "public", "tenant_lease_packet.html"),
  ];
  const TENANT_HTML_PATH = TENANT_HTML_CANDIDATES.find((p) => { try { return fsMod.existsSync(p); } catch (_) { return false; } }) || TENANT_HTML_CANDIDATES[0];
  if (!fsMod.existsSync(TENANT_HTML_PATH)) {
    console.error("[lease_packets] tenant_lease_packet.html not found at any known path:", TENANT_HTML_CANDIDATES.join(" , "));
  }
  router.get("/t/lease/:token", (req, res) => {
    // The acknowledgment token is carried IN THE URL. Without no-referrer,
    // every outbound request from this page leaks a live credential in the
    // Referer header. Without no-store, a resident's proposed terms persist
    // in shared caches. Without frame-ancestors, the Acknowledge button can
    // be clickjacked. Same posture as the applicant page.
    res.set({
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": [
        "default-src 'none'",
        "connect-src 'self'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    });
    res.type("html").sendFile(TENANT_HTML_PATH, (err) => {
      if (err) { console.error("[lease_packets] tenant page sendFile failed:", err.message); res.status(404).send("Lease page not found."); }
    });
  });

  // Tenant reads packet JSON by token.
  router.get("/t/lease/:token/data", async (req, res) => {
    try {
      const id = (await pool.query(
        `select id from lease_packets
          where tenant_token_hash=$1 and tenant_token_expires_at > now()
            and status <> 'voided'`,
        [sha256(req.params.token)])).rows[0]?.id;
      if (!id) return res.status(404).json({ receipt: "Lease link is invalid or expired." });
      const bundle = await getBundle(pool, id);
      //  THE RESIDENT SEES ONLY THE RESIDENT'S SIGNATURES.
      //  The company signature field lives on the same packet, and rendering
      //  it here put a "Sign" control for the LANDLORD on the resident's own
      //  page. It could never have worked — the completion route only touches
      //  required fields and the company's is not required — but an
      //  unusable control inviting a resident to sign as the company is not
      //  a cosmetic problem. Found by looking at the page in a browser, not
      //  by reading the field list.
      res.json({ packet: residentPacket(bundle) });
    } catch (e) {
      res.status(500).json({ receipt: "Could not load the lease packet.", error: e.message });
    }
  });

  // Tenant completes ONE field (internal evidence — does NOT touch the obligation).
  router.post("/t/lease/:token/fields/:field_id/complete", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const pk = (await client.query(
        `select * from lease_packets
          where tenant_token_hash=$1 and tenant_token_expires_at > now()
            and status not in ('submitted','resident_executed','executed','voided')
          for update`,
        [sha256(req.params.token)])).rows[0];
      if (!pk) { await client.query("rollback"); return res.status(404).json({ receipt: "Lease link is invalid, expired, or already submitted." }); }

      const value = String(req.body?.value || "").trim();
      if (!value) { await client.query("rollback"); return res.status(400).json({ receipt: "An acknowledgment value is required." }); }

      //  WHO SIGNED IS SERVER-DERIVED, NEVER SUPPLIED. 184 added
      //  signed_by_person_id precisely so a signature names a durable
      //  identity rather than a typed string; this writer never used it, so
      //  every resident signature landed anonymous and the execution adapter
      //  refused it as signer_identity_missing. The identity comes from the
      //  application this packet belongs to — the token proves it is that
      //  resident, and a body-supplied name would be a claim, not evidence.
      const holder = (await client.query(
        `select person_id from lease_applications where id=$1`, [pk.application_id])).rows[0];
      const signerPersonId = holder ? holder.person_id : null;

      const field = (await client.query(
        `update lease_packet_fields
            set completed=true, completed_at=now(),
                field_value=$3, session_id=$4, ip_address=$5, user_agent=$6,
                signed_by_person_id = case when field_type='signature'
                                           then $7::uuid else signed_by_person_id end
          where id=$1 and lease_packet_id=$2 and required=true and completed = false
          returning *`,
        [req.params.field_id, pk.id, value, req.body?.session_id || null, clientIp(req), req.headers["user-agent"] || null, signerPersonId])).rows[0];
      if (!field) {
        //  Completed once. A second completion overwrote completed_at, the
        //  value, the IP and — for a signature — the signer. Company-sign
        //  refuses this; the resident side did not.
        const done = (await client.query(
          `select id from lease_packet_fields where id=$1 and lease_packet_id=$2 and completed = true`,
          [req.params.field_id, pk.id])).rows[0];
        await client.query("rollback");
        if (done) return res.status(409).json({ receipt: "That step is already completed and its record stands. If something is wrong with it, the leasing office corrects it." });
        return res.status(404).json({ receipt: "No such field on this packet." });
      }

      //  A signature with no identifiable signer is evidence of nothing. Fail
      //  here rather than let it reach canonical truth anonymous.
      if (field.field_type === "signature" && !signerPersonId) {
        await client.query("rollback");
        return res.status(409).json({
          error: "signer_identity_unavailable",
          receipt: "This application names no person, so a signature on it cannot record who signed.",
        });
      }

      await client.query(
        `update lease_packets
            set status = case when status in ('sent','draft') then 'tenant_in_progress' else status end,
                updated_at = now()
          where id=$1`, [pk.id]);
      await audit(client, req, pk.id, "tenant", "field_completed",
        { field_key: field.field_key, field_type: field.field_type });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({ packet: residentPacket(bundle) });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      res.status(500).json({ receipt: "Could not record that field.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── TENANT FINAL SUBMIT — THE SEAM (v3) ───────────────
  //  When every required field is complete, this satisfies the SINGLE input
  //  ("terms_acknowledged") on the application's terms_review obligation and
  //  COMPLETES that obligation in the same transaction (§5b atomic; resident
  //  supplies the input, the system records completion). It marks the packet
  //  'submitted'. It touches nothing else: no signature inputs, no status,
  //  no lease, no tenancy, no occupancy. application_next then reads
  //  "Executed lease required" — the honest dead-end until Path B.
  router.post("/t/lease/:token/submit", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const pk = (await client.query(
        `select * from lease_packets
          where tenant_token_hash=$1 and tenant_token_expires_at > now()
            and status not in ('submitted','resident_executed','executed','voided')
          for update`,
        [sha256(req.params.token)])).rows[0];
      if (!pk) { await client.query("rollback"); return res.status(404).json({ receipt: "Lease link is invalid, expired, or already submitted." }); }

      // refuse until all required tenant fields are complete
      const incomplete = (await client.query(
        `select field_key, label from lease_packet_fields
          where lease_packet_id=$1 and required=true and completed=false
          order by display_order`, [pk.id])).rows;
      if (incomplete.length) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Acknowledge all required sections before submitting.", outstanding: incomplete });
      }

      // ── v3: the application + its TERMS_REVIEW obligation ───────────────
      // This route closes exactly ONE input: terms_acknowledged, on the
      // terms_review obligation. It satisfies NO signature input, creates NO
      // lease, promotes NO tenant, changes NO status/classification/occupancy.
      const app = (await client.query(
        `select * from lease_applications where id=$1`, [pk.application_id])).rows[0];
      if (!app) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "Application record missing for this packet." });
      }
      if (!app.terms_review_obligation_id) {
        // A pre-v3 packet on a legacy blended-gate application. Feeding a
        // terms acknowledgment into signature inputs is the exact false
        // equivalence this build removes — refuse honestly, never satisfy.
        await client.query("rollback");
        return res.status(409).json({
          error: "legacy_application_pre_terms_review",
          receipt: "This application predates the terms-review correction. Its acknowledgment path is retired — a terms acknowledgment is not a signature. Contact the office; a current terms-review packet can be issued under the corrected flow.",
        });
      }

      // §5b — the FROZEN ACKNOWLEDGMENT EVIDENCE. The resident supplies the
      // input; the system records completion (Rule 7: ownership of the
      // terms_review work ≠ who satisfied it — never the manager).
      const fieldRows = (await client.query(
        `select field_key, clause_hash from lease_packet_fields
          where lease_packet_id=$1 and required=true order by display_order`, [pk.id])).rows;
      const evidence = {
        application_id: app.id,
        terms_review_obligation_id: app.terms_review_obligation_id,
        lease_packet_id: pk.id,
        packet_version: pk.version,
        rendered_snapshot_hash: pk.rendered_snapshot_hash,
        completed_field_hashes: fieldRows.map((f) => ({ field_key: f.field_key, clause_hash: f.clause_hash })),
        acknowledgment_meaning: "review_intent_only",
        token_hash_ref: pk.tenant_token_hash,
        person_id: app.person_id || null,
        occurred_at: new Date().toISOString(),
        recorded_at: new Date().toISOString(),
        ip: clientIp(req),
        user_agent: (req.headers && req.headers["user-agent"]) || null,
        source: "lease_terms_demonstration",
      };

      const satisfied = [];
      const alreadyDone = [];
      try {
        await satisfyObligation(client, {
          obligation_id: app.terms_review_obligation_id,
          input: "terms_acknowledged",
          proof: evidence,
        });
        satisfied.push("terms_acknowledged");
      } catch (e) {
        if (e.code === "NOT_OUTSTANDING") { alreadyDone.push("terms_acknowledged"); }
        else {
          await client.query("rollback");
          console.error("lease-packet submit satisfy:", e);
          return res.status(409).json({ receipt: "The terms-review obligation rejected the acknowledgment input.", error_code: e.code || null, detail: e.message });
        }
      }
      // Atomic (§5b): completion rides the SAME transaction as the evidence
      // write and packet state — no partial acknowledgment state exists.
      // completed_by null = system-recorded; the resident's identity lives in
      // the proof, never as a staff completion actor.
      try {
        await completeObligation(client, { obligation_id: app.terms_review_obligation_id, completed_by: null });
      } catch (e) {
        if (e.code !== "ALREADY_COMPLETE" && e.code !== "INPUTS_OUTSTANDING") throw e;
        if (e.code === "INPUTS_OUTSTANDING") {
          await client.query("rollback");
          return res.status(409).json({ receipt: "The terms-review obligation has other outstanding inputs — this should not happen (its only input is terms_acknowledged). Investigate before retrying.", outstanding: e.outstanding_inputs });
        }
      }

      //  THE PACKET'S STATE DEPENDS ON WHAT IT ACTUALLY IS.
      //  With no governing instrument this is a terms acknowledgment and
      //  'submitted' remains its terminal state — unchanged, and still the
      //  honest dead-end for every existing packet.
      //  With one, the resident has signed the exact hashed instrument, and
      //  184 added 'resident_executed' for precisely that fact. Application
      //  status, classification, leases, tenancy and occupancy stay untouched
      //  either way (§3): this records who signed what, nothing downstream.
      const residentSigned = (await client.query(
        `select 1 from lease_packet_fields
          where lease_packet_id=$1 and field_type='signature'
            and signer_role in ('tenant','guarantor') and completed=true limit 1`,
        [pk.id])).rows.length > 0;
      const executesHere = !!pk.instrument_body_sha256 && residentSigned;

      await client.query(
        `update lease_packets
            set status = $2,
                tenant_submitted_at = coalesce(tenant_submitted_at, now()),
                resident_executed_at = case when $2='resident_executed'
                                            then coalesce(resident_executed_at, now())
                                            else resident_executed_at end,
                updated_at=now()
          where id=$1`, [pk.id, executesHere ? "resident_executed" : "submitted"]);

      // v3: NO stamping of applicant_signed_at/guarantor_signed_at — those
      // columns are signature evidence, and this was never a signature. The
      // acknowledgment's time lives where it belongs: lease_packets.
      // tenant_submitted_at + the frozen §5b evidence on the obligation.

      await audit(client, req, pk.id, "tenant", "tenant_submitted",
        { satisfied_inputs: satisfied, already_satisfied: alreadyDone, meaning: "review_intent_only",
          terms_review_obligation_id: app.terms_review_obligation_id });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({
        receipt: "Acknowledged. Your review of the proposed terms is recorded. This does not sign or activate a lease — a tenancy begins only when the governing lease is executed and the owner accepts through the normal process.",
        satisfied_obligation_inputs: satisfied,
        application_next: "Executed lease required",
        note: "This document is a demonstration summary of proposed terms, not the governing lease. Nothing further happens until a real lease execution exists.",
        packet: residentPacket(bundle),
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error("lease-packet submit:", e);
      res.status(500).json({ receipt: "Could not submit the lease packet.", error: e.message });
    } finally { client.release(); }
  });

  router._service = Object.freeze({
    generateLeasePacket,
    issueLeasePacketLink,
    getBundle,
    publicPacket,
  });
  return router;
};
