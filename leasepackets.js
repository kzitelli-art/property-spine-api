// =============================================================
// leasepackets.js — Lease Packet v1, REBUILT as an obligation-input
// collector (NOT an activation engine).
//
//   What this module IS:
//     • the tenant-facing surface: one scrolling lease packet, inline
//       initials, a final signature.
//     • on final tenant submit, it satisfies the SINGLE tenant input
//       ("applicant_signature") on the application's EXISTING activation
//       obligation — the one applications.js already spawned at approve.
//
//   What this module is NOT, and structurally cannot be:
//     • it has NO countersign route. Manager countersign + activation is
//       applications.js, exclusively.
//     • it NEVER writes lease_applications.status. It cannot set 'active'.
//       There is no SQL in this file that touches that column.
//     • it does NOT call completeObligation. Completing the activation
//       obligation (the gate) is the countersign path's job.
//
//   The seam, exactly:
//     tenant initials/signs  →  packet reaches 'submitted'  →
//     satisfyObligation(applicant_signature [+ guarantor_signature])  →
//     application is STILL not active (countersign input remains)  →
//     manager countersigns via applications.js  →  completeObligation  →
//     only THEN active.
//
//   Acknowledgment = review/intent only (Option A). The captured value is
//   audit evidence, NOT a legally-binding signature on the final lease. It
//   records that the resident reviewed the demonstration terms; the complete
//   lease and required addenda (delivered separately) govern, and a tenancy
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
const crypto = require("crypto");

module.exports = function leasePacketsModule(deps) {
  const { pool, satisfyObligation } = deps;
  if (typeof satisfyObligation !== "function") {
    throw new Error("leasePacketsModule requires { satisfyObligation } — the shared engine helper. Refusing to run a parallel signature path.");
  }
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

  async function audit(q, req, packetId, actorRole, eventType, eventJson = {}) {
    await q.query(
      `insert into lease_packet_audit_events
         (lease_packet_id, actor_role, event_type, event_json, ip_address, user_agent)
       values ($1,$2,$3,$4,$5,$6)`,
      [packetId, actorRole, eventType, eventJson, clientIp(req), req.headers["user-agent"] || null]
    );
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
        `Unit: ${terms.unit_label || terms.unit_number}, ${terms.property_address}.`,
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

  // Acknowledgment fields — review/intent only. NOT obligation inputs, NOT a
  // legal signature on the final instrument. Guarantor acknowledgment added
  // when a guarantor is named.
  function requiredFieldsFor(terms) {
    const base = [
      ["ack_term",    "term",    "Lease dates",              "acknowledgment"],
      ["ack_rent",    "rent",    "Monthly rent",             "acknowledgment"],
      ["ack_deposit", "deposit", "Security deposit",         "acknowledgment"],
      ["ack_terms",   "ack",     "Demonstration terms",      "acknowledgment"],
    ];
    if (terms.guarantor_required) {
      base.push(["ack_guarantor", "ack", "Guarantor acknowledgment", "acknowledgment"]);
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
      status: packet.status,
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

  // ════════════════════════════════════════════════════════════════
  //  OPERATOR ROUTES  (global gate applies — no local auth here)
  // ════════════════════════════════════════════════════════════════

  // Generate a packet from an approved/lease_ready application.
  // Terms come ONLY from live lease_applications columns + the properties
  // row. No imagined columns. No hardcoded 4233 defaults.
  router.post("/applications/:id/lease-packet", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const app = (await client.query(
        `select * from lease_applications where id=$1`, [req.params.id])).rows[0];
      if (!app) { await client.query("rollback"); return res.status(404).json({ receipt: "No application with that id." }); }

      // Packet is only meaningful once the application is approved (the
      // activation obligation exists). Guard on that, not on guessed status.
      if (!app.activation_obligation_id || !["lease_ready", "tenant_signed", "approved"].includes(app.status)) {
        await client.query("rollback");
        return res.status(409).json({ receipt: `Application is '${app.status}' with no open activation gate — approve it first.`, status: app.status });
      }

      // Property identity from the REAL properties row (never hardcoded).
      // NOTE: when durable properties.lease_config lands, add it to this
      // SELECT — leaseConfigFor already prefers property.lease_config over the
      // external adapter. Until then the column does not exist, so we do not
      // select it (a phantom column would error).
      const prop = (await client.query(
        `select id, name, canonical_key, address from properties where id=$1`,
        [app.property_id])).rows[0] || {};

      // unit label, if the app links a unit
      let unitLabel = app.unit_label || "";
      if (!unitLabel && app.unit_id) {
        const u = (await client.query(`select unit_number from units where id=$1`, [app.unit_id])).rows[0];
        unitLabel = u?.unit_number || "";
      }

      const captured = app.captured || {};
      const terms = {
        // identity — from properties row + captured, NOT hardcoded
        property_address: prop.address || captured.property_address || "[property address pending]",
        landlord_legal_entity: captured.landlord_legal_entity || "[landlord entity pending — supply on the property record]",
        property_name: prop.name || "",
        // resident / unit — live columns only
        resident_names: app.applicant_name || captured.resident_names || "",
        unit_id: app.unit_id || null,
        unit_label: unitLabel,
        unit_number: unitLabel,
        // money / term — STRUCTURED live columns only (Build A). captured is NO LONGER
        // an operating source for dates; it remains audit/fallback display only.
        monthly_rent: app.rent != null ? app.rent : "",
        security_deposit: app.deposit != null ? app.deposit : "",
        lease_start_date: app.lease_start_date || "",   // structured column (075), not captured
        lease_end_date: app.lease_end_date || "",       // structured column (075), not captured
        concession_status: app.concession_status || "unknown",
        guarantor_required: !!app.guarantor_name,
      };

      // ── FAIL CLOSED: required lease configuration + real economics ──────
      // Missing configured fees / utilities / notice, or blank application
      // economics, BLOCK generation. No generic legal or financial default —
      // a plausible default could produce a materially wrong document.
      const check = requireLeaseConfig(prop, terms);
      if (!check.ok) {
        await client.query("rollback");
        return res.status(409).json({
          error: "lease_configuration_incomplete",
          receipt: "Cannot generate the demonstration summary — required lease configuration or application terms are missing. This fails closed rather than showing a plausible default that could be materially wrong.",
          missing: check.missing,
        });
      }
      const cfg = check.cfg;

      const rendered = buildRendered(terms, cfg);
      const renderedHash = stableHash(rendered);

      const pk = (await client.query(
        `insert into lease_packets
           (property_id, application_id, unit_id, status, terms_json,
            rendered_snapshot, rendered_snapshot_hash, is_placeholder)
         values ($1,$2,$3,'draft',$4,$5,$6, false)
         on conflict (application_id, version) do update set
           terms_json = excluded.terms_json,
           rendered_snapshot = excluded.rendered_snapshot,
           rendered_snapshot_hash = excluded.rendered_snapshot_hash,
           is_placeholder = false,
           updated_at = now()
         returning *`,
        [app.property_id, app.id, terms.unit_id, terms, rendered, renderedHash])).rows[0];

      // (re)build fields
      await client.query(`delete from lease_packet_fields where lease_packet_id=$1`, [pk.id]);
      const requiredFields = requiredFieldsFor(terms);
      for (let i = 0; i < requiredFields.length; i++) {
        const [fk, sk, label, ft] = requiredFields[i];
        const clauseHash = stableHash(rendered.sections.find((s) => s.key === sk) || { sk, label });
        await client.query(
          `insert into lease_packet_fields
             (lease_packet_id, field_key, section_key, label, field_type, signer_role, required, clause_hash, display_order)
           values ($1,$2,$3,$4,$5,'tenant',true,$6,$7)`,
          [pk.id, fk, sk, label, ft, clauseHash, i + 1]);
      }

      // (re)build tracked documents — the complete lease + required addenda
      // are delivered separately and GOVERN; this summary does not.
      await client.query(`delete from lease_packet_documents where lease_packet_id=$1`, [pk.id]);
      const docs = [
        { document_type: "lease_body",         title: "Complete Lease & Required Addenda (governing — delivered separately)", required_acknowledgment: false },
        { document_type: "rental_license",     title: "Rental License",                    required_acknowledgment: true  },
        { document_type: "rental_suitability", title: "Certificate of Rental Suitability", required_acknowledgment: true  },
      ];
      for (const d of docs) {
        await client.query(
          `insert into lease_packet_documents
             (lease_packet_id, document_type, title, required_acknowledgment)
           values ($1,$2,$3,$4)`,
          [pk.id, d.document_type, d.title, d.required_acknowledgment]);
      }

      await audit(client, req, pk.id, "operator", "packet_generated",
        { application_id: app.id, is_demonstration_summary: true, config_source: check.source });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({
        receipt: `Lease Terms Review (Demonstration) generated for ${terms.resident_names || "applicant"} from verified property + application terms. This is a demonstration summary, not the lease; the complete lease and required addenda govern. Sending it captures the resident's acknowledgment only — activation still requires the manager countersign via applications.js.`,
        packet: publicPacket(bundle),
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error("lease-packet generate:", e);
      res.status(500).json({ receipt: "Could not generate the lease packet.", error: e.message });
    } finally { client.release(); }
  });

  // Read a packet (operator).
  router.get("/lease-packets/:id", async (req, res) => {
    try {
      const bundle = await getBundle(pool, req.params.id);
      if (!bundle) return res.status(404).json({ receipt: "No lease packet with that id." });
      res.json({ packet: publicPacket(bundle) });
    } catch (e) {
      res.status(500).json({ receipt: "Could not read the lease packet.", error: e.message });
    }
  });

  // Send / issue a tenant link. Returns the raw token URL ONCE.
  router.post("/lease-packets/:id/send", async (req, res) => {
    try {
      const token = makeToken();
      const tokenHash = sha256(token);
      const days = Number(req.body?.expires_days || 14);
      const pk = (await pool.query(
        `update lease_packets
            set status = case when status='draft' then 'sent' else status end,
                tenant_token_hash = $2,
                tenant_token_expires_at = now() + ($3 || ' days')::interval,
                sent_at = coalesce(sent_at, now()),
                updated_at = now()
          where id=$1 and status not in ('submitted','voided')
          returning *`,
        [req.params.id, tokenHash, days])).rows[0];
      if (!pk) return res.status(409).json({ receipt: "Packet not found, already submitted, or voided." });
      await audit(pool, req, pk.id, "operator", "packet_sent", { expires_days: days });
      res.json({
        receipt: `Link issued (expires in ${days} days). This captures the resident's acknowledgment of demonstration terms only — not a signature on the lease.`,
        tenant_url: `${BASE_URL}/t/lease/${encodeURIComponent(token)}`,
        status: pk.status,
      });
    } catch (e) {
      res.status(500).json({ receipt: "Could not send the lease packet.", error: e.message });
    }
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
    console.error("[leasepackets] tenant_lease_packet.html not found at any known path:", TENANT_HTML_CANDIDATES.join(" , "));
  }
  router.get("/t/lease/:token", (req, res) => {
    res.type("html").sendFile(TENANT_HTML_PATH, (err) => {
      if (err) { console.error("[leasepackets] tenant page sendFile failed:", err.message); res.status(404).send("Lease page not found."); }
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
      res.json({ packet: publicPacket(bundle) });
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
            and status not in ('submitted','voided')
          for update`,
        [sha256(req.params.token)])).rows[0];
      if (!pk) { await client.query("rollback"); return res.status(404).json({ receipt: "Lease link is invalid, expired, or already submitted." }); }

      const value = String(req.body?.value || "").trim();
      if (!value) { await client.query("rollback"); return res.status(400).json({ receipt: "An acknowledgment value is required." }); }

      const field = (await client.query(
        `update lease_packet_fields
            set completed=true, completed_at=now(),
                field_value=$3, session_id=$4, ip_address=$5, user_agent=$6
          where id=$1 and lease_packet_id=$2 and required=true
          returning *`,
        [req.params.field_id, pk.id, value, req.body?.session_id || null, clientIp(req), req.headers["user-agent"] || null])).rows[0];
      if (!field) { await client.query("rollback"); return res.status(404).json({ receipt: "No such field on this packet." }); }

      await client.query(
        `update lease_packets
            set status = case when status in ('sent','draft') then 'tenant_in_progress' else status end,
                updated_at = now()
          where id=$1`, [pk.id]);
      await audit(client, req, pk.id, "tenant", "field_completed",
        { field_key: field.field_key, field_type: field.field_type });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({ packet: publicPacket(bundle) });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      res.status(500).json({ receipt: "Could not record that field.", error: e.message });
    } finally { client.release(); }
  });

  // ─────────────── TENANT FINAL SUBMIT — THE SEAM ───────────────
  //  When every required tenant field is complete, this satisfies the SINGLE
  //  tenant input ("applicant_signature", + "guarantor_signature" if the app
  //  has a guarantor) on the application's EXISTING activation obligation,
  //  via the shared satisfyObligation helper. It then marks the packet
  //  'submitted'. It does NOT complete the obligation. It does NOT set the
  //  application active. The countersign input remains outstanding — the
  //  application stays not-active until applications.js countersign runs.
  router.post("/t/lease/:token/submit", async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const pk = (await client.query(
        `select * from lease_packets
          where tenant_token_hash=$1 and tenant_token_expires_at > now()
            and status not in ('submitted','voided')
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

      // the application + its activation obligation (the real gate)
      const app = (await client.query(
        `select * from lease_applications where id=$1`, [pk.application_id])).rows[0];
      if (!app || !app.activation_obligation_id) {
        await client.query("rollback");
        return res.status(409).json({ receipt: "This application has no open activation gate — nothing to feed. (Was it approved?)" });
      }

      // satisfy the tenant-side input(s) on the EXISTING obligation.
      // applicant_signature always; guarantor_signature only if the app has a
      // guarantor (mirrors applications.js's tenantInputs()).
      const toSatisfy = ["applicant_signature", ...(app.guarantor_name ? ["guarantor_signature"] : [])];
      const satisfied = [];
      const alreadyDone = [];
      for (const input of toSatisfy) {
        try {
          await satisfyObligation(client, {
            obligation_id: app.activation_obligation_id,
            input,
            proof: { source: "lease_terms_demonstration", packet_id: pk.id, meaning: "acknowledgment_review_intent_only",
                     captured_at: new Date().toISOString(), ip: clientIp(req) },
          });
          satisfied.push(input);
        } catch (e) {
          // NOT_OUTSTANDING = it was already satisfied earlier — that's fine,
          // idempotent. Any other engine error is real: roll back and surface.
          if (e.code === "NOT_OUTSTANDING") { alreadyDone.push(input); continue; }
          await client.query("rollback");
          console.error("lease-packet submit satisfy:", e);
          return res.status(409).json({ receipt: "The activation obligation rejected the acknowledgment input.", error_code: e.code || null, detail: e.message });
        }
      }

      // mark the packet submitted — its terminal state. NOT 'active'.
      await client.query(
        `update lease_packets
            set status='submitted', tenant_submitted_at = coalesce(tenant_submitted_at, now()), updated_at=now()
          where id=$1`, [pk.id]);

      // mirror tenant signature time onto the application row for the operator
      // Gate's existing display — WITHOUT touching status. (status stays
      // whatever applications.js set; activation is owned there.)
      // Also let applications.js's own status logic flip to 'tenant_signed'
      // on its next read; here we only stamp the timestamp, never 'active'.
      await client.query(
        `update lease_applications
            set applicant_signed_at = coalesce(applicant_signed_at, now()),
                guarantor_signed_at = case when $2 then coalesce(guarantor_signed_at, now()) else guarantor_signed_at end,
                updated_at = now()
          where id=$1`,
        [app.id, !!app.guarantor_name]);

      await audit(client, req, pk.id, "tenant", "tenant_submitted",
        { satisfied_inputs: satisfied, already_satisfied: alreadyDone, meaning: "acknowledgment_review_intent_only" });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({
        receipt: "Acknowledged. Your review of the demonstration terms is recorded. This does not activate a lease — a tenancy begins only when the owner executes the complete lease through the normal process.",
        satisfied_obligation_inputs: satisfied,
        application_still_active: false,
        note: "Activation happens only when a manager countersigns through the application — not here. This document is a demonstration summary, not the governing lease.",
        packet: publicPacket(bundle),
      });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      console.error("lease-packet submit:", e);
      res.status(500).json({ receipt: "Could not submit the lease packet.", error: e.message });
    } finally { client.release(); }
  });

  return router;
};
