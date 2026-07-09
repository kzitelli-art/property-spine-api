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
//   Tenant signature = INTENT (Option A). The captured value is audit
//   evidence, not a legally-binding signature; PA e-sign enforceability is
//   a counsel question, unanswered, and the data/UI label it as intent.
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

  // ─────────────── packet body (PLACEHOLDER until a real template lands) ───────────────
  // Every clause string here is generic + clearly provisional. No real lease
  // language, no hardcoded property/entity except inside an explicit 4233
  // fixture (see fixtureTermsFor4233 below, used only by the test harness).
  function placeholderSections(terms) {
    const p = "[PLACEHOLDER — not the real lease. Final clause language pending the approved template.]";
    return [
      { key: "parties", title: "Parties & Premises", body: [
        `Landlord: ${terms.landlord_legal_entity || "[landlord entity pending]"}`,
        `Resident: ${terms.resident_names || "[resident]"}`,
        `Premises: ${terms.unit_label || terms.unit_number || "[unit]"}, ${terms.property_address || "[property address pending]"}`,
        p ] },
      { key: "term", title: "Lease Term", body: [
        `Start: ${terms.lease_start_date || "[start date]"}`,
        `End: ${terms.lease_end_date || "[end date]"}`,
        p ] },
      { key: "rent", title: "Rent & Charges", body: [
        `Monthly rent: ${terms.monthly_rent != null && terms.monthly_rent !== "" ? "$" + terms.monthly_rent : "[rent pending]"}`,
        p ] },
      { key: "deposit", title: "Security Deposit", body: [
        `Security deposit: ${terms.security_deposit != null && terms.security_deposit !== "" ? "$" + terms.security_deposit : "[deposit pending]"}`,
        p ] },
      { key: "rules", title: "Resident Responsibilities", body: [ p ] },
      { key: "access", title: "Maintenance & Owner Access", body: [ p ] },
      { key: "city_docs", title: "Required City Documents", body: [
        "Rental License, Certificate of Rental Suitability, and any required lead / handbook notices are tracked with this packet.",
        "Acknowledgment confirms receipt only.",
        p ] },
      { key: "esign", title: "Electronic Signature (Intent)", body: [
        "Your signature here records your INTENT and submits the packet for management review.",
        "This is NOT a binding signature and the lease is NOT active until management countersigns it in the system.",
        p ] },
    ];
  }

  // tenant required fields: section initials + acknowledgment + ONE signature.
  // These are INTERNAL evidence. They are NOT obligation inputs.
  const REQUIRED_FIELDS = [
    ["initial_term",    "term",     "Lease term",                 "initial"],
    ["initial_rent",    "rent",     "Rent & charges",             "initial"],
    ["initial_deposit", "deposit",  "Security deposit",           "initial"],
    ["initial_rules",   "rules",    "Resident responsibilities",  "initial"],
    ["initial_access",  "access",   "Maintenance & owner access", "initial"],
    ["ack_city_docs",   "city_docs","Required city documents",    "acknowledgment"],
    ["initial_esign",   "esign",    "Electronic signature notice","initial"],
    ["tenant_signature","esign",    "Resident signature",         "signature"],
  ];

  function buildRendered(terms) {
    return {
      title: "Residential Lease Packet (PLACEHOLDER)",
      is_placeholder: true,
      subtitle: terms.property_address || "[property address pending]",
      summary: {
        resident_names: terms.resident_names || "",
        unit: terms.unit_label || terms.unit_number || "",
        lease_start_date: terms.lease_start_date || "",
        lease_end_date: terms.lease_end_date || "",
        monthly_rent: terms.monthly_rent ?? "",
        security_deposit: terms.security_deposit ?? "",
        guarantor_required: !!terms.guarantor_required,
      },
      sections: placeholderSections(terms),
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
      signature_meaning: "intent_only",   // Option A, surfaced to the UI
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

      const rendered = buildRendered(terms);
      const renderedHash = stableHash(rendered);

      const pk = (await client.query(
        `insert into lease_packets
           (property_id, application_id, unit_id, status, terms_json,
            rendered_snapshot, rendered_snapshot_hash, is_placeholder)
         values ($1,$2,$3,'draft',$4,$5,$6, true)
         on conflict (application_id, version) do update set
           terms_json = excluded.terms_json,
           rendered_snapshot = excluded.rendered_snapshot,
           rendered_snapshot_hash = excluded.rendered_snapshot_hash,
           is_placeholder = true,
           updated_at = now()
         returning *`,
        [app.property_id, app.id, terms.unit_id, terms, rendered, renderedHash])).rows[0];

      // (re)build fields
      await client.query(`delete from lease_packet_fields where lease_packet_id=$1`, [pk.id]);
      for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
        const [fk, sk, label, ft] = REQUIRED_FIELDS[i];
        const clauseHash = stableHash(rendered.sections.find((s) => s.key === sk) || { sk, label });
        await client.query(
          `insert into lease_packet_fields
             (lease_packet_id, field_key, section_key, label, field_type, signer_role, required, clause_hash, display_order)
           values ($1,$2,$3,$4,$5,'tenant',true,$6,$7)`,
          [pk.id, fk, sk, label, ft, clauseHash, i + 1]);
      }

      // (re)build default tracked documents
      await client.query(`delete from lease_packet_documents where lease_packet_id=$1`, [pk.id]);
      const docs = [
        { document_type: "lease_body",         title: "Residential Lease Agreement (placeholder)", required_acknowledgment: false },
        { document_type: "rental_license",     title: "Rental License",                            required_acknowledgment: true  },
        { document_type: "rental_suitability", title: "Certificate of Rental Suitability",         required_acknowledgment: true  },
      ];
      for (const d of docs) {
        await client.query(
          `insert into lease_packet_documents
             (lease_packet_id, document_type, title, required_acknowledgment)
           values ($1,$2,$3,$4)`,
          [pk.id, d.document_type, d.title, d.required_acknowledgment]);
      }

      await audit(client, req, pk.id, "operator", "packet_generated",
        { application_id: app.id, is_placeholder: true });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({
        receipt: `Placeholder lease packet generated for ${terms.resident_names || "applicant"}. NOT a real lease — body is placeholder until the template lands. Send it to capture tenant intent; activation still requires manager countersign via applications.js.`,
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
        receipt: `Tenant link issued (expires in ${days} days). This captures intent only.`,
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
  const TENANT_HTML_PATH = require("path").join(__dirname, "public", "tenant_lease_packet.html");
  router.get("/t/lease/:token", (req, res) => {
    res.type("html").sendFile(TENANT_HTML_PATH, (err) => {
      if (err) res.status(404).send("Lease packet page not found.");
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
      if (!value) { await client.query("rollback"); return res.status(400).json({ receipt: "A value (your initials / signature) is required." }); }

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
        return res.status(409).json({ receipt: "Finish all required initials and the signature before submitting.", outstanding: incomplete });
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
            proof: { source: "lease_packet", packet_id: pk.id, meaning: "intent_only",
                     captured_at: new Date().toISOString(), ip: clientIp(req) },
          });
          satisfied.push(input);
        } catch (e) {
          // NOT_OUTSTANDING = it was already satisfied earlier — that's fine,
          // idempotent. Any other engine error is real: roll back and surface.
          if (e.code === "NOT_OUTSTANDING") { alreadyDone.push(input); continue; }
          await client.query("rollback");
          console.error("lease-packet submit satisfy:", e);
          return res.status(409).json({ receipt: "The activation obligation rejected the signature input.", error_code: e.code || null, detail: e.message });
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
        { satisfied_inputs: satisfied, already_satisfied: alreadyDone, meaning: "intent_only" });
      await client.query("commit");
      const bundle = await getBundle(pool, pk.id);
      res.json({
        receipt: "Submitted. Your signature is recorded as INTENT and the lease is now waiting on management countersignature. It is NOT active yet.",
        satisfied_obligation_inputs: satisfied,
        application_still_active: false,
        note: "Activation happens only when a manager countersigns through the application — not here.",
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
