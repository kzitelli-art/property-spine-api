// =============================================================
// leasepackets.js — Lease review and execution package.
//
//   What this module IS:
//     • the tenant-facing surface: one scrolling package with the retained
//       governing lease, exact deal-term schedule, acknowledgments and the
//       required resident-side signatures when the property has established
//       that source.
//     • the demonstration-only fallback for properties that have not yet
//       established a governing source; that path records review only.
//     • the adapter from resident execution to the existing governed company
//       countersign and tenancy services.
//
//   What this module is NOT:
//     • it is not a second lease or tenancy writer. Company countersign
//       delegates to the existing execution and tenancy services.
//     • it never treats a demonstration acknowledgment as a signature.
//     • it never executes a package without retained source bytes, an exact
//       terms schedule, a deterministic package hash and signer identity.
//
//   The seam, exactly (v3):
//     demonstration only: resident acknowledges → terms-review obligation
//       completes → packet stops at submitted.
//     governing package: every required resident-side signer signs →
//       resident_executed → authorized company countersign delegates to
//       execution → tenancy/rent-roll truth.
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
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const sourceArtifacts = require("../onboarding/source_artifact_service");
const { normalizeE164 } = require("../identity/phone_identity");

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
  const normalizeSignatureName = (v) => String(v || "")
    .normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
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

  function extensionOf(filename) {
    const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function safeDownloadName(filename) {
    return String(filename || "lease-document")
      .replace(/[\r\n"\\/]/g, "_")
      .slice(0, 180) || "lease-document";
  }

  async function extractLeaseText(artifact) {
    const ext = extensionOf(artifact && artifact.original_filename);
    let text = "";
    if (ext === "docx") {
      const result = await mammoth.extractRawText({ buffer: artifact.content });
      text = result && result.value;
    } else if (ext === "pdf") {
      const result = await pdfParse(artifact.content);
      text = result && result.text;
    } else {
      throw packetError(409, "lease_source_shape_unsupported",
        "The retained lease source is not a supported Word or PDF document.");
    }
    const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
    if (normalized.length < 500) {
      throw packetError(409, "lease_source_text_unusable",
        "The lease file is retained, but its text could not be read well enough to show the resident. Upload the original editable Word form or a text-based PDF.");
    }
    return normalized;
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

  function dateOnly(value) {
    if (value == null || String(value).trim() === "") return null;
    if (value instanceof Date) {
      return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"),
        String(value.getDate()).padStart(2, "0")].join("-");
    }
    return String(value).slice(0, 10);
  }

  function displayDate(value) {
    const normalized = dateOnly(value);
    const match = normalized && normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return normalized;
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
  }

  function punctuate(value) {
    const text = value == null ? "" : String(value).trim();
    return !text || /[.!?]$/.test(text) ? text : text + ".";
  }

  const money = (v) => {
    if (v == null || String(v).trim() === "") return null;
    const number = Number(String(v).replace(/[$,]/g, ""));
    return Number.isFinite(number)
      ? number.toLocaleString("en-US", { style: "currency", currency: "USD" })
      : "$" + String(v).trim();
  };

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
        `Proposed start: ${displayDate(terms.lease_start_date)}.`,
        `Proposed end: ${displayDate(terms.lease_end_date)}.`,
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
  function configuredInstrumentFrom(cfg) {
    const gi = cfg && cfg.governing_instrument;
    if (!gi || typeof gi !== "object") return null;
    const form_code = String(gi.form_code || "").trim();
    const body_sha256 = String(gi.body_sha256 || "").trim();
    const source_artifact_id = String(gi.source_artifact_id || "").trim();
    if (!form_code || !body_sha256 || !source_artifact_id) {
      throw packetError(409, "lease_instrument_configuration_incomplete",
        "The property names a lease form but does not bind it to retained source bytes. Re-open Lease document setup and upload the exact governing form.");
    }
    return {
      form_code,
      form_version: String(gi.form_version || "").trim() || null,
      body_sha256,
      source_artifact_id,
    };
  }

  function leaseTermsSchedule(terms, cfg) {
    return {
      schema_version: 1,
      parties: {
        landlord_entity: cfg.landlord_entity,
        resident_names: terms.resident_names,
        guarantor_name: terms.guarantor_name || null,
      },
      premises: {
        property_name: terms.property_name,
        property_address: terms.property_address,
        unit_id: terms.unit_id,
        unit_label: terms.unit_label || terms.unit_number,
        space_id: terms.space_id || null,
        space_label: terms.space_label || null,
      },
      term: {
        lease_start_date: dateOnly(terms.lease_start_date),
        lease_end_date: dateOnly(terms.lease_end_date),
      },
      economics: {
        monthly_rent: terms.monthly_rent,
        security_deposit: terms.security_deposit,
        concession_status: terms.concession_status,
        application_fee: cfg.application_fee,
        amenity_fee: cfg.amenity_fee,
        utility_fee_total: cfg.utility_fee_total == null ? null : cfg.utility_fee_total,
        utility_fee_payment_preference: terms.utility_payment_preference || null,
      },
      operations: {
        rent_payment_location: cfg.rent_payment_location || null,
        utility_responsibility: cfg.utility_responsibility,
        late_fee: cfg.late_fee,
        notice_requirement: cfg.notice_requirement,
        parking_interest: terms.parking_interest || null,
      },
    };
  }

  async function governingInstrumentFrom(q, property, cfg, terms) {
    const configured = configuredInstrumentFrom(cfg);
    if (!configured) return null;

    const artifact = await sourceArtifacts.read(q, configured.source_artifact_id);
    if (!artifact
        || artifact.scope_type !== "property"
        || String(artifact.scope_id) !== String(property.id)
        || artifact.artifact_kind !== "lease_template") {
      throw packetError(409, "lease_source_not_governing",
        "The configured lease source is missing or does not belong to this property. Re-open Lease document setup before generating a packet.");
    }
    if (String(artifact.sha256).toLowerCase() !== configured.body_sha256.toLowerCase()) {
      throw packetError(409, "lease_source_hash_mismatch",
        "The retained lease bytes do not match the configured form hash. No packet was generated.");
    }

    const text_snapshot = await extractLeaseText(artifact);
    const terms_schedule = leaseTermsSchedule(terms, cfg);
    const terms_sha256 = stableHash(terms_schedule);
    const manifest = {
      schema_version: 1,
      form_code: configured.form_code,
      form_version: configured.form_version,
      source_artifact_id: configured.source_artifact_id,
      source_filename: artifact.original_filename,
      source_sha256: artifact.sha256,
      terms_sha256,
    };
    return {
      ...configured,
      artifact,
      text_snapshot,
      terms_schedule,
      terms_sha256,
      manifest,
      package_sha256: stableHash(manifest),
    };
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
      ["ack_terms",   "ack",     instrument ? "Official lease package" : "Demonstration terms", "acknowledgment", "tenant"],
    ];
    if (terms.guarantor_required) {
      base.push(["ack_guarantor", "ack", "Guarantor acknowledgment", "acknowledgment", "tenant"]);
    }
    if (instrument) {
      base.push(["sign_resident", "ack", "Resident signature",  "signature", "tenant"]);
      if (terms.guarantor_required) {
        base.push(["ack_guarantor_package", "ack", "Guarantor package review", "acknowledgment", "guarantor"]);
        base.push(["sign_guarantor", "ack", "Guarantor signature", "signature", "guarantor"]);
      }
      base.push(["sign_company",  "ack", "Company signature",   "signature", "company"]);
    }
    return base;
  }

  async function establishPacketSigners(q, { packet, application, terms, instrument }) {
    const captured = application.captured || {};
    let person = null;
    if (application.person_id) {
      person = (await q.query(
        `select id, name, email, phone, primary_phone_e164 from persons where id=$1`,
        [application.person_id])).rows[0] || null;
    }
    if (instrument && !person) {
      throw packetError(409, "resident_identity_not_established",
        "The applicant is not linked to a durable person, so the lease cannot record who signs it. Resolve the applicant identity before generating the governing packet.");
    }

    const signers = [{
      role: "tenant",
      name: application.applicant_name || (person && person.name) || terms.resident_names,
      person_id: application.person_id || null,
      phone: normalizeE164(captured.phone || (person && (person.primary_phone_e164 || person.phone))),
      email: String(captured.email || (person && person.email) || "").trim() || null,
    }];

    if (instrument && terms.guarantor_required) {
      const contact = captured.guarantor_contact || {};
      const guarantorName = String(contact.name || terms.guarantor_name || "").trim();
      const guarantorPhone = normalizeE164(contact.phone);
      const guarantorEmail = String(contact.email || "").trim() || null;
      if (!guarantorName || !guarantorPhone || !guarantorEmail) {
        throw packetError(409, "guarantor_contact_not_established",
          "This application requires a guarantor, but the guarantor's name, mobile number, or email is missing. Correct the application before generating the governing packet.");
      }
      signers.push({
        role: "guarantor",
        name: guarantorName,
        person_id: null,
        phone: guarantorPhone,
        email: guarantorEmail,
      });
    }

    // Generation changes only a draft packet. Rebuild its participant rows
    // from the application snapshot so no prior contact survives a correction.
    // Sent packets are versioned rather than regenerated in place.
    await q.query(`delete from lease_packet_signers where lease_packet_id=$1`, [packet.id]);
    for (const signer of signers) {
      await q.query(
        `insert into lease_packet_signers
           (lease_packet_id, signer_role, display_name, person_id, phone_e164, email)
         values ($1,$2,$3,$4,$5,$6)`,
        [packet.id, signer.role, signer.name, signer.person_id, signer.phone, signer.email]);
    }
    return signers;
  }

  const NOT_THE_LEASE_STATEMENT =
    "This is a demonstration summary of proposed lease terms. It is not the complete lease, does not replace the governing lease and required addenda, and does not create or activate a tenancy.";

  function governingPackageSections(schedule) {
    const p = schedule.premises;
    const e = schedule.economics;
    const o = schedule.operations;
    const unit = p.space_label
      ? `${p.unit_label}, ${p.space_label}`
      : p.unit_label;
    return [
      { key: "parties", title: "Parties & Home", ack: false, body: [
        `Landlord: ${schedule.parties.landlord_entity}.`,
        `Resident(s): ${schedule.parties.resident_names}.`,
        schedule.parties.guarantor_name ? `Guarantor: ${schedule.parties.guarantor_name}.` : null,
        `Home: ${unit}, ${p.property_address}.`,
      ].filter(Boolean) },
      { key: "term", title: "Lease Dates", ack: true, body: [
        `Starts: ${displayDate(schedule.term.lease_start_date)}.`,
        `Ends: ${displayDate(schedule.term.lease_end_date)}.`,
      ] },
      { key: "rent", title: "Rent", ack: true, body: [
        `Monthly rent: ${money(e.monthly_rent)}.`,
        o.rent_payment_location ? `Payment location: ${punctuate(o.rent_payment_location)}` : null,
        `Late fee: ${money(o.late_fee)} if rent is not paid on time.`,
      ].filter(Boolean) },
      { key: "deposit", title: "Deposit & Property Charges", ack: true, body: [
        `Security deposit: ${money(e.security_deposit)}.`,
        e.application_fee != null ? `Application fee: ${money(e.application_fee)}.` : null,
        e.amenity_fee != null ? `Amenity fee: ${money(e.amenity_fee)}.` : null,
        e.utility_fee_total != null ? `Lease-term utility fee: ${money(e.utility_fee_total)}.` : null,
        e.utility_fee_payment_preference ? `Resident payment preference: ${e.utility_fee_payment_preference}.` : null,
      ].filter(Boolean) },
      { key: "operations", title: "Utilities, Notice & Parking", ack: false, body: [
        o.utility_responsibility,
        `Renewal / move-out notice: ${punctuate(o.notice_requirement)}`,
        o.parking_interest ? `Parking preference from application: ${o.parking_interest}. This is not a parking reservation.` : null,
      ].filter(Boolean) },
      { key: "ack", title: "Sign the Complete Package", ack: true, body: [
        "The governing lease form and this exact deal-terms schedule are presented together as one package.",
        "Your electronic signature applies to that complete package. The company must countersign before the tenancy is activated.",
      ] },
    ];
  }

  function buildRendered(terms, cfg, instrument = null) {
    const isInstrument = !!instrument;
    return {
      title: isInstrument ? "Residential Lease Package" : "Lease Terms Review — Demonstration",
      is_placeholder: false,
      is_demonstration_summary: !isInstrument,
      is_governing_lease_package: isInstrument,
      not_the_lease: isInstrument ? null : NOT_THE_LEASE_STATEMENT,
      subtitle: terms.property_address || "",
      summary: {
        landlord_entity: cfg.landlord_entity,
        resident_names: terms.resident_names || "",
        unit: terms.unit_label || terms.unit_number || "",
        lease_start_date: dateOnly(terms.lease_start_date) || "",
        lease_end_date: dateOnly(terms.lease_end_date) || "",
        monthly_rent: terms.monthly_rent ?? "",
        security_deposit: terms.security_deposit ?? "",
        guarantor_required: !!terms.guarantor_required,
      },
      sections: isInstrument
        ? governingPackageSections(instrument.terms_schedule)
        : demoSummarySections(terms, cfg),
      instrument: isInstrument ? {
        form_code: instrument.form_code,
        form_version: instrument.form_version,
        source_filename: instrument.artifact.original_filename,
        source_sha256: instrument.body_sha256,
        terms_sha256: instrument.terms_sha256,
        package_sha256: instrument.package_sha256,
        terms_schedule: instrument.terms_schedule,
        text_snapshot: instrument.text_snapshot,
      } : null,
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
    const signers = await q.query(
      `select s.id, s.signer_role, s.display_name, s.person_id,
              s.link_issued_at, s.token_expires_at, s.submitted_at,
              sf.completed_at as signature_completed_at
         from lease_packet_signers s
         left join lease_packet_fields sf
           on sf.lease_packet_id=s.lease_packet_id
          and sf.signer_role=s.signer_role
          and sf.field_type='signature'
        where s.lease_packet_id=$1
        order by case s.signer_role when 'tenant' then 1 else 2 end`,
      [packetId]);
    return { packet: pk.rows[0], fields: fields.rows, documents: docs.rows,
             signers: signers.rows };
  }

  function publicPacket(bundle) {
    const { packet, fields, documents, signers = [] } = bundle;
    const req = fields.filter((f) => f.required);
    const done = req.filter((f) => f.completed).length;
    const carriesInstrument = !!packet.instrument_source_artifact_id;
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
      is_demonstration_summary: !carriesInstrument,
      is_governing_lease_package: carriesInstrument,
      acknowledgment_meaning: carriesInstrument ? "lease_execution" : "review_intent_only",
      instrument: carriesInstrument ? {
        form_code: packet.instrument_form_code,
        form_version: packet.instrument_form_version,
        source_filename: packet.instrument_manifest && packet.instrument_manifest.source_filename,
        source_sha256: packet.instrument_body_sha256,
        terms_sha256: packet.instrument_terms_sha256,
        package_sha256: packet.instrument_package_sha256,
        download_path: `/t/lease/{token}/instrument`,
      } : null,
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
        has_retained_source: !!d.source_artifact_id,
      })),
      signing_parties: signers.map((s) => ({
        signer_role: s.signer_role,
        display_name: s.display_name,
        link_issued_at: s.link_issued_at || null,
        token_expires_at: s.token_expires_at || null,
        submitted_at: s.submitted_at || null,
        signature_completed_at: s.signature_completed_at || null,
        complete: !!(s.submitted_at && s.signature_completed_at),
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
  function signerPacket(bundle, signer) {
    const role = signer && signer.signer_role ? signer.signer_role : "tenant";
    return {
      ...publicPacket({
        ...bundle,
        fields: (bundle.fields || []).filter((f) => f.signer_role === role),
      }),
      current_signer: {
        signer_role: role,
        display_name: signer && signer.display_name ? signer.display_name : null,
        submitted_at: signer && signer.submitted_at ? signer.submitted_at : null,
      },
    };
  }

  function residentPacket(bundle) {
    const signer = (bundle.signers || []).find((s) => s.signer_role === "tenant") || {
      signer_role: "tenant", display_name: null, submitted_at: null,
    };
    return signerPacket({
      ...bundle,
    }, signer);
  }

  // ════════════════════════════════════════════════════════════════
  //  OPERATOR ROUTES  (global gate applies — no local auth here)
  // ════════════════════════════════════════════════════════════════

  // ── CANONICAL PACKET WRITE SERVICE ─────────────────────────────────
  // One implementation, two operator doors:
  //   • legacy OPERATOR_KEY routes below
  //   • staff-session /operator/leasing/* adapters in operator.js

  function normalizedLeaseSetupTerms(input = {}) {
    const out = {};
    for (const key of [
      ...REQUIRED_CONFIG_KEYS,
      "rent_payment_location", "insurance_note", "utility_fee_total",
    ]) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        const value = input[key];
        out[key] = value == null ? null : String(value).trim();
      }
    }
    return out;
  }

  async function propertyLeaseConfiguration(q, propertyId) {
    const property = (await q.query(
      `select id, name, address, lease_config from properties where id=$1`,
      [propertyId])).rows[0];
    if (!property) throw packetError(404, "property_not_found", "No property with that id.");

    const cfg = property.lease_config && typeof property.lease_config === "object"
      ? property.lease_config
      : {};
    const configured = cfg.governing_instrument && typeof cfg.governing_instrument === "object"
      ? cfg.governing_instrument
      : null;
    const artifact = configured && configured.source_artifact_id
      ? await sourceArtifacts.describe(q, configured.source_artifact_id)
      : null;
    const authority = cfg.execution_authority && typeof cfg.execution_authority === "object"
      ? cfg.execution_authority
      : {};
    const signerIds = Array.isArray(authority.company_signer_user_ids)
      ? authority.company_signer_user_ids.map(String)
      : [];
    let signers = [];
    if (signerIds.length) {
      signers = (await q.query(
        `select id, name from users where id = any($1::uuid[]) and is_active=true order by name`,
        [signerIds])).rows;
    }
    const missingTerms = REQUIRED_CONFIG_KEYS.filter((key) =>
      cfg[key] == null || String(cfg[key]).trim() === "");
    const sourceMatches = !!(artifact
      && artifact.scope_type === "property"
      && String(artifact.scope_id) === String(property.id)
      && artifact.artifact_kind === "lease_template"
      && String(artifact.sha256).toLowerCase() === String(configured.body_sha256 || "").toLowerCase());

    return {
      property: { id: property.id, name: property.name, address: property.address },
      terms: Object.fromEntries([
        ...REQUIRED_CONFIG_KEYS,
        "rent_payment_location", "insurance_note", "utility_fee_total",
      ].map((key) => [key, cfg[key] == null ? "" : cfg[key]])),
      application_options: cfg.application_options || {},
      instrument: configured ? {
        form_code: configured.form_code || null,
        form_version: configured.form_version || null,
        source_artifact_id: configured.source_artifact_id || null,
        source_filename: artifact && artifact.original_filename,
        source_sha256: artifact && artifact.sha256,
        source_as_of_date: artifact ? dateOnly(artifact.source_as_of_date) : null,
        configured_sha256: configured.body_sha256 || null,
        source_matches_configuration: sourceMatches,
      } : null,
      company_signers: signers,
      missing_terms: missingTerms,
      ready_to_generate: sourceMatches && missingTerms.length === 0,
      ready_to_execute: sourceMatches && missingTerms.length === 0 && signers.length > 0,
    };
  }

  async function configurePropertyLeaseTemplate(client, {
    propertyId,
    actorUserId,
    actorName = null,
    file,
    formCode,
    formVersion = null,
    sourceAsOfDate = null,
    leaseTerms = {},
    applicationOptions = {},
    confirmCompanySigner = false,
  } = {}) {
    if (!propertyId || !actorUserId) {
      throw packetError(400, "lease_setup_identity_required",
        "A property and authenticated setup operator are required.");
    }
    if (!file || !file.buffer) {
      throw packetError(400, "lease_template_required",
        "Choose the exact Word or PDF lease form used by this property.");
    }
    const code = String(formCode || "").trim();
    if (!code || code.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(code)) {
      throw packetError(400, "lease_form_code_invalid",
        "Form code is required and may contain letters, numbers, dots, dashes, and underscores.");
    }
    const version = String(formVersion || "").trim() || null;
    if (version && version.length > 120) {
      throw packetError(400, "lease_form_version_invalid", "Form version is too long.");
    }
    const asOf = String(sourceAsOfDate || "").trim() || null;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      throw packetError(400, "lease_source_date_invalid", "Source date must be YYYY-MM-DD.");
    }
    if (confirmCompanySigner !== true) {
      throw packetError(409, "company_signer_confirmation_required",
        "Confirm that this signed-in account is authorized to countersign this property's leases.");
    }

    sourceArtifacts.validateUpload({
      filename: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
      artifact_kind: "lease_template",
    });
    await extractLeaseText({ original_filename: file.originalname, content: file.buffer });

    const property = (await client.query(
      `select id, name, lease_config from properties where id=$1 for update`,
      [propertyId])).rows[0];
    if (!property) throw packetError(404, "property_not_found", "No property with that id.");

    const stored = await sourceArtifacts.store(client, {
      scope_type: "property",
      scope_id: property.id,
      filename: file.originalname,
      mimetype: file.mimetype,
      buffer: file.buffer,
      uploaded_by_user_id: actorUserId,
      authority_basis: "authenticated management lease setup",
      source_as_of_date: asOf,
      artifact_kind: "lease_template",
    });
    if (stored.artifact_kind !== "lease_template") {
      throw packetError(409, "lease_source_kind_conflict",
        "These exact bytes are already retained under a different source kind. Upload the actual lease form rather than relabeling another source.");
    }

    const current = property.lease_config && typeof property.lease_config === "object"
      ? property.lease_config
      : {};
    const next = {
      ...current,
      ...normalizedLeaseSetupTerms(leaseTerms),
      application_options: {
        ...(current.application_options || {}),
        ask_parking_interest: applicationOptions.ask_parking_interest === true,
        parking_note: String(applicationOptions.parking_note || "").trim() || null,
        ask_utility_payment_preference: applicationOptions.ask_utility_payment_preference === true,
        utility_payment_note: String(applicationOptions.utility_payment_note || "").trim() || null,
      },
      governing_instrument: {
        form_code: code,
        form_version: version,
        body_sha256: stored.sha256,
        source_artifact_id: stored.id,
        source_as_of_date: asOf,
      },
      execution_authority: {
        ...(current.execution_authority || {}),
        company_signer_user_ids: [String(actorUserId)],
        confirmed_by_user_id: String(actorUserId),
        confirmed_signer_name: actorName || null,
        confirmed_at: new Date().toISOString(),
        basis: "authenticated operator confirmed as company signer during lease setup",
      },
    };
    const missingTerms = REQUIRED_CONFIG_KEYS.filter((key) =>
      next[key] == null || String(next[key]).trim() === "");
    if (missingTerms.length) {
      throw packetError(409, "lease_configuration_incomplete",
        "Complete the required property terms before establishing the governing lease form.",
        { missing: missingTerms });
    }

    await client.query(
      `update properties set lease_config=$2::jsonb, updated_at=now() where id=$1`,
      [property.id, JSON.stringify(next)]);
    return {
      receipt: `${stored.original_filename} is now the retained governing lease source for ${property.name}. The signed-in account is the recorded company signer.`,
      configuration: await propertyLeaseConfiguration(client, property.id),
    };
  }

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
      guarantor_name: app.guarantor_name || null,
      utility_payment_preference: captured.utility_payment_preference || null,
      parking_interest: captured.parking_interest || null,
    };

    const check = requireLeaseConfig(prop, terms);
    if (!check.ok) {
      throw packetError(
        409,
        "lease_configuration_incomplete",
        "Cannot generate the lease package — required property configuration or confirmed terms are missing. This fails closed rather than showing a plausible default that could be materially wrong.",
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
    const instrument = await governingInstrumentFrom(client, prop, check.cfg, terms);
    const rendered = buildRendered(terms, check.cfg, instrument);
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
                 instrument_source_artifact_id=$9,
                 instrument_terms_sha256=$10,
                 instrument_package_sha256=$11,
                 instrument_manifest=$12,
                 instrument_text_snapshot=$13,
                 instrument_established_at = case when $9::uuid is null then null else now() end,
                 is_placeholder=false, updated_at=now()
          where id=$1 returning *`,
        [current.id, terms, rendered, renderedHash, confirmation.id,
         instrument ? instrument.form_code : null,
         instrument ? instrument.form_version : null,
         instrument ? instrument.body_sha256 : null,
         instrument ? instrument.source_artifact_id : null,
         instrument ? instrument.terms_sha256 : null,
         instrument ? instrument.package_sha256 : null,
         instrument ? instrument.manifest : null,
         instrument ? instrument.text_snapshot : null]
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
             instrument_source_artifact_id, instrument_terms_sha256,
             instrument_package_sha256, instrument_manifest, instrument_text_snapshot,
             instrument_established_at)
         values ($1,$2,$3,$4,'draft',$5,$6,$7,false,$8,$9,$10,$11,$12,
                  $13,$14,$15,$16,$17,
                  case when $13::uuid is null then null else now() end)
         returning *`,
        [
          app.property_id, app.id, terms.unit_id, newVersion, terms,
          rendered, renderedHash, supersedes, confirmation.id,
          instrument ? instrument.form_code : null,
          instrument ? instrument.form_version : null,
          instrument ? instrument.body_sha256 : null,
          instrument ? instrument.source_artifact_id : null,
          instrument ? instrument.terms_sha256 : null,
          instrument ? instrument.package_sha256 : null,
          instrument ? instrument.manifest : null,
          instrument ? instrument.text_snapshot : null,
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

    const packetSigners = await establishPacketSigners(client, {
      packet: pk, application: app, terms, instrument,
    });

    await client.query(`delete from lease_packet_fields where lease_packet_id=$1`, [pk.id]);
    const requiredFields = requiredFieldsFor(terms, instrument);
    for (let i = 0; i < requiredFields.length; i++) {
      const [fk, sk, label, ft, role] = requiredFields[i];
      const clauseHash = instrument && ft === "signature"
        ? instrument.package_sha256
        : stableHash(rendered.sections.find((s) => s.key === sk) || { sk, label });
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
           (lease_packet_id, document_type, title, required_acknowledgment, source_artifact_id)
         values ($1,$2,$3,$4,$5)`,
        [pk.id, d.document_type, d.title, d.required_acknowledgment,
         instrument && d.document_type === "lease_body" ? instrument.source_artifact_id : null]
      );
    }

    await audit(client, auditContext, pk.id, "operator", "packet_generated", {
      application_id: app.id,
      proposed_terms_confirmation_id: confirmation.id,
      actor_user_id: actorUserId,
      is_demonstration_summary: !instrument,
      instrument_source_artifact_id: instrument ? instrument.source_artifact_id : null,
      instrument_package_sha256: instrument ? instrument.package_sha256 : null,
      signer_roles: packetSigners.map((s) => s.role),
      config_source: check.source,
    });

    const bundle = await getBundle(client, pk.id);
    return {
      receipt: instrument
        ? `Lease package generated for ${terms.resident_names || "applicant"}. It binds the retained ${instrument.form_code} source to the exact confirmed unit, dates, rent, deposit, and property terms.`
        : `Lease Terms Review (Demonstration) generated for ${terms.resident_names || "applicant"} from the current confirmed proposed terms. This is a demonstration summary, not the lease; the complete lease and required addenda govern.`,
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
    if (!!actorUserId !== !!idempotencyKey) {
      throw packetError(400, "issue_identity_incomplete",
        "A staff-issued signing package requires both the server-derived actor and one retry identity.");
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
        receipt: "The signing links were already issued. No new token was created.",
        already_issued: true,
        tenant_url: null,
        guarantor_url: null,
        signing_links: [],
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

    if (row.instrument_source_artifact_id) {
      const source = await sourceArtifacts.read(client, row.instrument_source_artifact_id);
      if (!source
          || String(source.scope_id) !== String(row.property_id)
          || source.artifact_kind !== "lease_template"
          || String(source.sha256).toLowerCase() !== String(row.instrument_body_sha256 || "").toLowerCase()
          || !row.instrument_terms_sha256
          || !row.instrument_package_sha256
          || !row.instrument_manifest) {
        throw packetError(409, "lease_package_source_unavailable",
          "The complete retained lease package cannot be reproduced. Regenerate it from Lease document setup before sending anything to the resident.");
      }
    }

    const days = Number(expiresDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw packetError(400, "invalid_expiry", "expires_days must be a positive number.");
    }

    const signerRows = (await client.query(
      `select id, signer_role, display_name
         from lease_packet_signers
        where lease_packet_id=$1
        order by case signer_role when 'tenant' then 1 else 2 end
        for update`, [row.id])).rows;
    if (!signerRows.some((s) => s.signer_role === "tenant")) {
      throw packetError(409, "resident_signer_missing",
        "This packet names no resident signer. Regenerate it before issuing any link.");
    }
    const guarantorField = (await client.query(
      `select 1 from lease_packet_fields
        where lease_packet_id=$1 and signer_role='guarantor' and required=true limit 1`,
      [row.id])).rows.length > 0;
    if (guarantorField && !signerRows.some((s) => s.signer_role === "guarantor")) {
      throw packetError(409, "guarantor_signer_missing",
        "This packet requires a guarantor signature but names no guarantor signer. Regenerate it before issuing any link.");
    }

    const signingLinks = [];
    let tenantTokenHash = null;
    for (const signer of signerRows) {
      const token = makeToken();
      const tokenHash = sha256(token);
      await client.query(
        `update lease_packet_signers
            set token_hash=$2,
                token_expires_at=now() + ($3 || ' days')::interval,
                link_issued_at=now(), updated_at=now()
          where id=$1`, [signer.id, tokenHash, days]);
      if (signer.signer_role === "tenant") tenantTokenHash = tokenHash;
      signingLinks.push({
        signer_role: signer.signer_role,
        display_name: signer.display_name,
        url: `${BASE_URL}/t/lease/${encodeURIComponent(token)}`,
      });
    }

    const pk = (await client.query(
      `update lease_packets
          set status='sent',
              tenant_token_hash=$2,
              tenant_token_expires_at=now() + ($3 || ' days')::interval,
              sent_at=coalesce(sent_at,now()),
              issue_actor_user_id=$4,
              issue_idempotency_key=$5,
              issued_at=case when $4::uuid is null then null else coalesce(issued_at,now()) end,
              updated_at=now()
        where id=$1 and status='draft' and superseded_at is null
        returning *`,
      [row.id, tenantTokenHash, days, actorUserId, idempotencyKey]
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
      signer_roles: signingLinks.map((s) => s.signer_role),
    });

    const tenantLink = signingLinks.find((s) => s.signer_role === "tenant") || null;
    const guarantorLink = signingLinks.find((s) => s.signer_role === "guarantor") || null;

    return {
      receipt: pk.instrument_source_artifact_id
        ? `${signingLinks.length === 1 ? "Lease-signing link" : "Separate resident and guarantor signing links"} issued (expires in ${days} days). Each presents the same retained governing form and exact deal terms as one package.`
        : `Link issued (expires in ${days} days). This captures the resident's acknowledgment of demonstration terms only — not a signature on the lease.`,
      already_issued: false,
      tenant_url: tenantLink && tenantLink.url,
      guarantor_url: guarantorLink && guarantorLink.url,
      signing_links: signingLinks,
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

      const property = (await client.query(
        `select lease_config from properties where id=$1`, [pk.property_id])).rows[0] || {};
      const executionAuthority = property.lease_config
        && property.lease_config.execution_authority;
      const companySignerIds = executionAuthority
        && Array.isArray(executionAuthority.company_signer_user_ids)
        ? executionAuthority.company_signer_user_ids.map(String)
        : [];
      if (!companySignerIds.includes(String(operator.id))) {
        await client.query("rollback");
        return res.status(403).json({
          error: "company_signer_not_authorized",
          receipt: "This account is not recorded as an authorized company signer for this property's lease form.",
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
        instrument_package_sha256: pk.instrument_package_sha256,
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

  async function resolveSignerAccess(q, rawToken, { lock = false } = {}) {
    const tokenHash = sha256(rawToken);
    const suffix = lock ? " for update of pk, s" : "";
    let row = (await q.query(
      `select pk.*,
              s.id as access_signer_id,
              s.signer_role as access_signer_role,
              s.display_name as access_display_name,
              s.person_id as access_person_id,
              s.token_hash as access_token_hash,
              s.submitted_at as access_submitted_at
         from lease_packet_signers s
         join lease_packets pk on pk.id=s.lease_packet_id
        where s.token_hash=$1 and s.token_expires_at>now()
          and pk.status<>'voided' and pk.superseded_at is null${suffix}`,
      [tokenHash])).rows[0];

    // Rollout compatibility for a link issued before 192. Migration 192
    // backfills these rows; this fallback prevents an older partial database
    // from turning a valid resident link into a 404 during deployment.
    if (!row) {
      const legacySuffix = lock ? " for update of pk" : "";
      row = (await q.query(
        `select pk.*,
                null::uuid as access_signer_id,
                'tenant'::text as access_signer_role,
                a.applicant_name as access_display_name,
                a.person_id as access_person_id,
                pk.tenant_token_hash as access_token_hash,
                pk.tenant_submitted_at as access_submitted_at
           from lease_packets pk
           join lease_applications a on a.id=pk.application_id
          where pk.tenant_token_hash=$1 and pk.tenant_token_expires_at>now()
            and pk.status<>'voided' and pk.superseded_at is null${legacySuffix}`,
        [tokenHash])).rows[0];
    }
    if (!row) return null;
    return {
      packet: row,
      signer: {
        id: row.access_signer_id || null,
        signer_role: row.access_signer_role || "tenant",
        display_name: row.access_display_name || null,
        person_id: row.access_person_id || null,
        token_hash: row.access_token_hash || tokenHash,
        submitted_at: row.access_submitted_at || null,
      },
    };
  }

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
    console.error("[leasepackets] tenant_lease_packet.html not found at any known path:", TENANT_HTML_CANDIDATES.join(" , "));
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
      if (err) { console.error("[leasepackets] tenant page sendFile failed:", err.message); res.status(404).send("Lease page not found."); }
    });
  });

  // Tenant reads packet JSON by token.
  router.get("/t/lease/:token/data", async (req, res) => {
    try {
      const access = await resolveSignerAccess(pool, req.params.token);
      if (!access) return res.status(404).json({ receipt: "Lease link is invalid or expired." });
      const bundle = await getBundle(pool, access.packet.id);
      // Each party sees the complete package but only their own controls.
      // A shared field projection would let a resident sign as a guarantor or
      // expose the company control on the public page.
      res.json({ packet: signerPacket(bundle, access.signer) });
    } catch (e) {
      res.status(500).json({ receipt: "Could not load the lease packet.", error: e.message });
    }
  });

  // Exact governing bytes, token-scoped to the same resident packet. The
  // extracted text improves review on a phone; this download is the retained
  // source itself and remains the authoritative file.
  router.get("/t/lease/:token/instrument", async (req, res) => {
    try {
      const access = await resolveSignerAccess(pool, req.params.token);
      const packet = access && access.packet;
      if (!packet || !packet.instrument_source_artifact_id) {
        return res.status(404).json({ receipt: "This packet does not carry a governing lease file." });
      }
      const artifact = await sourceArtifacts.read(pool, packet.instrument_source_artifact_id);
      if (!artifact
          || artifact.scope_type !== "property"
          || String(artifact.scope_id) !== String(packet.property_id)
          || artifact.artifact_kind !== "lease_template"
          || String(artifact.sha256).toLowerCase() !== String(packet.instrument_body_sha256).toLowerCase()) {
        return res.status(409).json({
          error: "lease_source_unavailable",
          receipt: "The retained lease file no longer matches this packet. Do not sign it; contact the leasing office.",
        });
      }
      res.set({
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename="${safeDownloadName(artifact.original_filename)}"`,
      });
      return res.type(artifact.mime_type || "application/octet-stream").send(artifact.content);
    } catch (e) {
      console.error("lease instrument download:", e);
      return res.status(500).json({ receipt: "Could not retrieve the lease file." });
    }
  });

  // Tenant completes ONE field (internal evidence — does NOT touch the obligation).
  router.post("/t/lease/:token/fields/:field_id/complete", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const access = await resolveSignerAccess(client, req.params.token, { lock: true });
      const pk = access && access.packet;
      const signer = access && access.signer;
      if (!pk || ["submitted", "resident_executed", "executed", "voided"].includes(pk.status)
          || (signer && signer.submitted_at)) {
        await client.query("rollback");
        return res.status(404).json({ receipt: "Lease link is invalid, expired, or already submitted." });
      }

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
        `select person_id, applicant_name from lease_applications where id=$1`, [pk.application_id])).rows[0];
      const signerPersonId = signer.signer_role === "tenant"
        ? (signer.person_id || (holder && holder.person_id) || null)
        : null;
      const packetSignerId = signer.id || null;

      const targetField = (await client.query(
        `select field_type, signer_role, completed, field_value from lease_packet_fields
          where id=$1 and lease_packet_id=$2 and required=true and signer_role=$3`,
        [req.params.field_id, pk.id, signer.signer_role])).rows[0];
      if (!targetField) {
        await client.query("rollback");
        return res.status(404).json({ receipt: "No such field on this packet." });
      }
      if (targetField.field_type === "signature") {
        if (req.body?.consent !== true || value.length < 2) {
          await client.query("rollback");
          return res.status(400).json({
            error: "signature_intent_required",
            receipt: "Type your full legal name and intentionally choose Sign.",
          });
        }
      }

      // Completion is evidence, not an editable draft. An exact retry after a
      // lost response is harmless and returns the current packet, but it does
      // not rewrite when/how the signer acted or append a second audit event.
      // A different value is a correction request and needs a governed new
      // packet rather than silently replacing signed evidence in place.
      if (targetField.completed) {
        const sameValue = targetField.field_type === "signature"
          ? normalizeSignatureName(targetField.field_value) === normalizeSignatureName(value)
          : String(targetField.field_value || "").trim() === value;
        await client.query("rollback");
        if (!sameValue) {
          return res.status(409).json({
            error: "field_already_completed",
            receipt: "This field already carries completed evidence and cannot be rewritten. Contact the leasing office if the package needs correction.",
          });
        }
        const bundle = await getBundle(pool, pk.id);
        return res.json({
          receipt: "This field was already completed; the original evidence is unchanged.",
          already_completed: true,
          packet: signerPacket(bundle, signer),
        });
      }

      if (targetField.field_type === "signature") {
        const expectedName = normalizeSignatureName(signer.display_name);
        if (!expectedName) {
          await client.query("rollback");
          return res.status(409).json({
            error: "signer_identity_unavailable",
            receipt: "This signing link does not name its signer. Contact the leasing office before signing.",
          });
        }
        if (normalizeSignatureName(value) !== expectedName) {
          await client.query("rollback");
          return res.status(400).json({
            error: "signature_name_mismatch",
            receipt: "The typed name does not match the signer named on this lease package. Type the full legal name shown for this signing link.",
          });
        }
      }

      const field = (await client.query(
        `update lease_packet_fields
            set completed=true, completed_at=now(),
                field_value=$3, session_id=$4, ip_address=$5, user_agent=$6,
                signed_by_person_id = case when field_type='signature'
                                           then $7::uuid else signed_by_person_id end,
                signed_by_packet_signer_id = case when field_type='signature'
                                                  then $8::uuid else signed_by_packet_signer_id end
          where id=$1 and lease_packet_id=$2 and required=true and signer_role=$9
            and completed=false
          returning *`,
        [req.params.field_id, pk.id, value, req.body?.session_id || null, clientIp(req),
         req.headers["user-agent"] || null, signerPersonId, packetSignerId,
         signer.signer_role])).rows[0];
      if (!field) { await client.query("rollback"); return res.status(404).json({ receipt: "No such field on this packet." }); }

      //  A signature with no identifiable signer is evidence of nothing. Fail
      //  here rather than let it reach canonical truth anonymous.
      if (field.field_type === "signature"
          && ((signer.signer_role === "tenant" && !signerPersonId)
              || (signer.signer_role === "guarantor" && !packetSignerId))) {
        await client.query("rollback");
        return res.status(409).json({
          error: "signer_identity_unavailable",
          receipt: "This signing link cannot establish who is signing. Contact the leasing office before continuing.",
        });
      }

      await client.query(
        `update lease_packets
            set status = case when status in ('sent','draft') then 'tenant_in_progress' else status end,
                updated_at = now()
          where id=$1`, [pk.id]);
      await audit(client, req, pk.id, signer.signer_role, "field_completed",
        { field_key: field.field_key, field_type: field.field_type,
          signer_role: signer.signer_role, packet_signer_id: packetSignerId });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({ packet: signerPacket(bundle, {
        ...signer,
        submitted_at: (bundle.signers || []).find((s) => s.id === packetSignerId)?.submitted_at || null,
      }) });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      res.status(500).json({ receipt: "Could not record that field.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────── PUBLIC SIGNER FINAL SUBMIT — THE SEAM (v3) ───────────
  //  The tenant's submit satisfies the terms-review obligation. A
  //  demonstration packet stops at submitted. A governing package reaches
  //  resident_executed only after every required resident-side signer has
  //  completed their controls on the same exact package.
  router.post("/t/lease/:token/submit", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const access = await resolveSignerAccess(client, req.params.token, { lock: true });
      const pk = access && access.packet;
      const signer = access && access.signer;
      if (!pk || ["submitted", "resident_executed", "executed", "voided"].includes(pk.status)
          || (signer && signer.submitted_at)) {
        await client.query("rollback");
        return res.status(404).json({ receipt: "Lease link is invalid, expired, or already submitted." });
      }

      // Refuse until THIS signer has completed their own fields. The other
      // party's outstanding controls do not trap this person on the page.
      const signerRequirements = (await client.query(
        `select field_key, label, completed from lease_packet_fields
          where lease_packet_id=$1 and signer_role=$2
            and required=true
          order by display_order`, [pk.id, signer.signer_role])).rows;
      if (!signerRequirements.length) {
        await client.query("rollback");
        return res.status(409).json({
          error: "signer_requirements_missing",
          receipt: "This signing link has no required controls. Nothing can be treated as signed; contact the leasing office.",
        });
      }
      const incomplete = signerRequirements.filter((field) => !field.completed);
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
      if (signer.signer_role === "tenant" && !app.terms_review_obligation_id) {
        // A pre-v3 packet on a legacy blended-gate application. Feeding a
        // terms acknowledgment into signature inputs is the exact false
        // equivalence this build removes — refuse honestly, never satisfy.
        await client.query("rollback");
        return res.status(409).json({
          error: "legacy_application_pre_terms_review",
          receipt: "This application predates the terms-review correction. Its acknowledgment path is retired — a terms acknowledgment is not a signature. Contact the office; a current terms-review packet can be issued under the corrected flow.",
        });
      }

      const governingPackage = !!pk.instrument_source_artifact_id;
      if (governingPackage && (!pk.instrument_body_sha256
          || !pk.instrument_terms_sha256
          || !pk.instrument_package_sha256
          || !pk.instrument_manifest)) {
        await client.query("rollback");
        return res.status(409).json({
          error: "lease_package_incomplete",
          receipt: "This lease package cannot reproduce the exact form and deal terms. Do not sign it; contact the leasing office.",
        });
      }

      // §5b — the FROZEN ACKNOWLEDGMENT EVIDENCE. The resident supplies the
      // input; the system records completion (Rule 7: ownership of the
      // terms_review work ≠ who satisfied it — never the manager).
      const fieldRows = (await client.query(
        `select field_key, clause_hash from lease_packet_fields
          where lease_packet_id=$1 and signer_role=$2 and required=true
          order by display_order`, [pk.id, signer.signer_role])).rows;
      const evidence = {
        application_id: app.id,
        terms_review_obligation_id: app.terms_review_obligation_id,
        lease_packet_id: pk.id,
        packet_version: pk.version,
        rendered_snapshot_hash: pk.rendered_snapshot_hash,
        completed_field_hashes: fieldRows.map((f) => ({ field_key: f.field_key, clause_hash: f.clause_hash })),
        acknowledgment_meaning: governingPackage ? "lease_execution" : "review_intent_only",
        instrument_package_sha256: governingPackage ? pk.instrument_package_sha256 : null,
        token_hash_ref: signer.token_hash,
        signer_role: signer.signer_role,
        packet_signer_id: signer.id || null,
        person_id: signer.signer_role === "tenant" ? (app.person_id || null) : null,
        occurred_at: new Date().toISOString(),
        recorded_at: new Date().toISOString(),
        ip: clientIp(req),
        user_agent: (req.headers && req.headers["user-agent"]) || null,
        source: governingPackage ? "retained_lease_package" : "lease_terms_demonstration",
      };

      const satisfied = [];
      const alreadyDone = [];
      if (true) {
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
        // write and packet state. The guarantor does not satisfy the
        // applicant's terms-review work; their own signature remains separate.
        try {
          await completeObligation(client, { obligation_id: app.terms_review_obligation_id, completed_by: null });
        } catch (e) {
          if (e.code !== "ALREADY_COMPLETE" && e.code !== "INPUTS_OUTSTANDING") throw e;
          if (e.code === "INPUTS_OUTSTANDING") {
            await client.query("rollback");
            return res.status(409).json({ receipt: "The terms-review obligation has other outstanding inputs — this should not happen (its only input is terms_acknowledged). Investigate before retrying.", outstanding: e.outstanding_inputs });
          }
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
      if (signer.id) {
        await client.query(
          `update lease_packet_signers
              set submitted_at=coalesce(submitted_at,now()), updated_at=now()
            where id=$1`, [signer.id]);
      }
      const outstandingSigners = (await client.query(
        `select s.signer_role, s.display_name
          from lease_packet_signers s
          where s.lease_packet_id=$1
            and (s.submitted_at is null or not exists (
              select 1 from lease_packet_fields f
               where f.lease_packet_id=s.lease_packet_id
                 and f.field_type='signature' and f.signer_role=s.signer_role
                 and f.required=true and f.completed=true
                 and f.signed_by_packet_signer_id=s.id
            ))
          order by s.signer_role`, [pk.id])).rows;
      const residentSigned = (await client.query(
        `select 1 from lease_packet_fields
          where lease_packet_id=$1 and field_type='signature'
            and signer_role='tenant' and completed=true limit 1`, [pk.id])).rows.length > 0;
      const executesHere = governingPackage && !!pk.instrument_package_sha256
        && residentSigned && outstandingSigners.length === 0;
      const nextPacketStatus = governingPackage
        ? (executesHere ? "resident_executed" : "tenant_in_progress")
        : "submitted";

      await client.query(
        `update lease_packets
            set status = $2,
                tenant_submitted_at = case when $3='tenant'
                                           then coalesce(tenant_submitted_at, now())
                                           else tenant_submitted_at end,
                resident_executed_at = case when $2='resident_executed'
                                            then coalesce(resident_executed_at, now())
                                            else resident_executed_at end,
                updated_at=now()
          where id=$1`, [pk.id, nextPacketStatus, signer.signer_role]);

      // v3: NO stamping of applicant_signed_at/guarantor_signed_at — those
      // columns are signature evidence, and this was never a signature. The
      // acknowledgment's time lives where it belongs: lease_packets.
      // tenant_submitted_at + the frozen §5b evidence on the obligation.

      await audit(client, req, pk.id, signer.signer_role, `${signer.signer_role}_submitted`,
        { satisfied_inputs: satisfied, already_satisfied: alreadyDone,
          signer_role: signer.signer_role,
          packet_signer_id: signer.id || null,
          outstanding_signer_roles: outstandingSigners.map((s) => s.signer_role),
          meaning: governingPackage ? "lease_execution" : "review_intent_only",
          instrument_package_sha256: governingPackage ? pk.instrument_package_sha256 : null,
          terms_review_obligation_id: app.terms_review_obligation_id });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      const currentSigner = (bundle.signers || []).find((s) =>
        (signer.id && String(s.id) === String(signer.id)) || s.signer_role === signer.signer_role) || signer;
      const waitingOn = outstandingSigners.map((s) => s.display_name || s.signer_role).join(" and ");
      res.json({
        receipt: governingPackage && executesHere
          ? "Signed. Every required resident-side signature on the complete lease package is recorded. The authorized company signer may now countersign."
          : governingPackage
          ? `Signed. Your ${signer.signer_role === "guarantor" ? "guarantor" : "resident"} signature is recorded. The package is still waiting for ${waitingOn}.`
          : "Acknowledged. Your review of the proposed terms is recorded. This does not sign or activate a lease — a tenancy begins only when the governing lease is executed and the owner accepts through the normal process.",
        satisfied_obligation_inputs: satisfied,
        application_next: governingPackage
          ? (executesHere ? "Company countersignature required" : `Waiting for ${waitingOn}`)
          : "Executed lease required",
        note: governingPackage
          ? (executesHere
            ? "The resident side is complete. No tenancy is activated until the authorized company signer countersigns the same package."
            : "This signature is complete. No company signature or tenancy can occur until every required resident-side signer finishes the same package.")
          : "This document is a demonstration summary of proposed terms, not the governing lease. Nothing further happens until a real lease execution exists.",
        packet: signerPacket(bundle, currentSigner),
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
    propertyLeaseConfiguration,
    configurePropertyLeaseTemplate,
  });
  return router;
};
