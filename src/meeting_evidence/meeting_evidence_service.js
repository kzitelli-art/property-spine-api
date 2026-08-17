"use strict";

const crypto = require("crypto");
const { normaliseHeader, verifyReadSignature } = require("./read_ai_signature");
const {
  parseVerifiedReadPayload,
  readProviderMetadata,
  readReadIdentity,
} = require("./read_ai_payload");
const { readReadTranscript } = require("./read_ai_transcript");

const PROVIDER = "read_ai";
const RAW_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const MEETING_EVIDENCE_MODULES = Object.freeze(["management", "asset_management", "leasing"]);

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function asUuidish(value) {
  const v = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

function serviceError(httpStatus, code, message) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

function hasMeetingEvidenceAccess(operator) {
  const mods = (operator && operator.allowed_modules) || [];
  return operator && (operator.can_manage_roles === true ||
    MEETING_EVIDENCE_MODULES.some((m) => mods.includes(m)));
}

async function withTransaction(db, fn) {
  if (!db || typeof db.connect !== "function" || typeof db.release === "function") return fn(db);
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    try { await client.query("rollback"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function recordSecurityReceipt(db, {
  connection_id = null,
  body_sha256 = null,
  byte_length = null,
  refusal_status,
  request_ip = null,
  detail = null,
} = {}) {
  await db.query(
    `insert into meeting_webhook_security_receipts
       (provider, connection_id, body_sha256, byte_length, refusal_status, request_ip, detail)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [PROVIDER, connection_id, body_sha256, byte_length, refusal_status, request_ip, detail]
  );
}

async function recordSecurityReceiptSafe(db, input) {
  try {
    if (db && typeof db.query === "function") await recordSecurityReceipt(db, input);
  } catch (err) {
    console.error("meeting evidence security receipt failed", err.message);
  }
}

async function resolveConfiguredReadConnection(db, connectionId) {
  const row = (await db.query(
    `select id, provider, authorized_by_user_id, authorized_at, connection_status
       from integration_connections
      where id = $1 and provider = $2 and connection_status = 'active'`,
    [connectionId, PROVIDER]
  )).rows[0];
  return row || null;
}

async function insertDelivery(client, {
  connection_id,
  related_delivery_id = null,
  provider_request_id = null,
  provider_session_id = null,
  raw_body,
  payload_sha256,
  byte_length,
  signature_header,
  delivery_state,
  provider_event_trigger = null,
  provider_payload_metadata = {},
}) {
  return (await client.query(
    `insert into meeting_provider_deliveries
       (provider, connection_id, related_delivery_id, provider_request_id, provider_session_id,
        payload_sha256, byte_length, raw_body, signature_header, delivery_state,
        provider_event_trigger, provider_payload_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id, provider_request_id, provider_session_id, payload_sha256, byte_length,
               delivery_state, provider_event_trigger, received_at`,
    [PROVIDER, connection_id, related_delivery_id, provider_request_id, provider_session_id,
     payload_sha256, byte_length, raw_body, signature_header, delivery_state,
     provider_event_trigger, provider_payload_metadata]
  )).rows[0];
}

async function findLogicalDelivery(client, { connection_id, provider_request_id, payload_sha256 }) {
  if (provider_request_id) {
    return (await client.query(
      `select d.id, d.provider_request_id, d.provider_session_id, d.payload_sha256,
              d.delivery_state, m.id as provider_meeting_id
         from meeting_provider_deliveries d
         left join meeting_provider_meetings m
           on m.connection_id = d.connection_id
          and m.provider = d.provider
          and m.provider_session_id = d.provider_session_id
        where d.connection_id = $1
          and d.provider_request_id = $2
          and d.related_delivery_id is null
        limit 1`,
      [connection_id, provider_request_id]
    )).rows[0] || null;
  }
  return (await client.query(
    `select d.id, d.provider_request_id, d.provider_session_id, d.payload_sha256,
            d.delivery_state, null::uuid as provider_meeting_id
       from meeting_provider_deliveries d
      where d.connection_id = $1
        and d.provider_request_id is null
        and d.payload_sha256 = $2
        and d.related_delivery_id is null
      limit 1`,
    [connection_id, payload_sha256]
  )).rows[0] || null;
}

async function ensureProviderMeeting(client, {
  connection_id,
  provider_session_id,
  first_delivery_id,
  provider_title = null,
  provider_started_at_text = null,
  provider_ended_at_text = null,
  provider_metadata = {},
}) {
  const inserted = (await client.query(
    `insert into meeting_provider_meetings
       (provider, connection_id, provider_session_id, first_delivery_id,
        provider_title, provider_started_at_text, provider_ended_at_text, provider_metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (connection_id, provider, provider_session_id) do nothing
     returning id, provider_session_id, first_delivery_id, first_observed_at,
               provider_title, provider_started_at_text, provider_ended_at_text`,
    [PROVIDER, connection_id, provider_session_id, first_delivery_id,
     provider_title, provider_started_at_text, provider_ended_at_text, provider_metadata]
  )).rows[0];
  if (inserted) return inserted;

  return (await client.query(
    `select id, provider_session_id, first_delivery_id, first_observed_at,
            provider_title, provider_started_at_text, provider_ended_at_text
       from meeting_provider_meetings
      where connection_id = $1 and provider = $2 and provider_session_id = $3`,
    [connection_id, PROVIDER, provider_session_id]
  )).rows[0];
}

async function persistVerifiedDelivery(db, input) {
  return withTransaction(db, async (client) => {
    const existing = await findLogicalDelivery(client, {
      connection_id: input.connection_id,
      provider_request_id: input.provider_request_id,
      payload_sha256: input.payload_sha256,
    });

    if (existing) {
      const duplicateState = existing.payload_sha256 === input.payload_sha256
        ? "duplicate_delivery"
        : "provider_anomaly";
      const row = await insertDelivery(client, {
        ...input,
        related_delivery_id: existing.id,
        delivery_state: duplicateState,
      });
      return {
        delivery: row,
        provider_meeting_id: existing.provider_meeting_id || null,
        outcome: duplicateState,
        logical_delivery_id: existing.id,
      };
    }

    const delivery = await insertDelivery(client, input);
    let meeting = null;
    if (input.delivery_state === "processed_unbound" && input.provider_session_id) {
      meeting = await ensureProviderMeeting(client, {
        connection_id: input.connection_id,
        provider_session_id: input.provider_session_id,
        first_delivery_id: delivery.id,
        ...input.provider_metadata_columns,
      });
    }
    return {
      delivery,
      provider_meeting_id: meeting ? meeting.id : null,
      outcome: input.delivery_state,
      logical_delivery_id: delivery.id,
    };
  });
}

async function receiveReadWebhook(db, {
  rawBody,
  signatureHeader,
  env = process.env,
  requestIp = null,
} = {}) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  const bodyHash = sha256Hex(raw);
  const byteLength = raw.length;
  const connectionId = asUuidish(env.READ_AI_CONNECTION_ID);
  const configuredSecret = String(env.READ_AI_WEBHOOK_SIGNING_KEY || "").trim();

  if (byteLength > RAW_BODY_LIMIT_BYTES) {
    await recordSecurityReceiptSafe(db, {
      connection_id: null,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_body_too_large",
      request_ip: requestIp,
    });
    return { httpStatus: 413, body: { ok: false, status: "refused_body_too_large" } };
  }

  if (!connectionId || !configuredSecret) {
    await recordSecurityReceiptSafe(db, {
      connection_id: null,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_unknown_connection",
      request_ip: requestIp,
      detail: !connectionId ? "READ_AI_CONNECTION_ID missing or invalid" : "READ_AI_WEBHOOK_SIGNING_KEY missing",
    });
    return { httpStatus: 503, body: { ok: false, status: "refused_unknown_connection" } };
  }

  const connection = await resolveConfiguredReadConnection(db, connectionId);
  if (!connection) {
    await recordSecurityReceiptSafe(db, {
      connection_id: null,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_unknown_connection",
      request_ip: requestIp,
      detail: "configured connection was not found or is not active",
    });
    return { httpStatus: 503, body: { ok: false, status: "refused_unknown_connection" } };
  }

  let signature;
  try {
    signature = verifyReadSignature({
      rawBody: raw,
      signatureHeader,
      signingKeyBase64: configuredSecret,
    });
  } catch (err) {
    await recordSecurityReceiptSafe(db, {
      connection_id: connection.id,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_unknown_connection",
      request_ip: requestIp,
      detail: err.code || "signing key configuration failed",
    });
    return { httpStatus: 503, body: { ok: false, status: "refused_unknown_connection" } };
  }

  if (signature.reason === "missing_signature") {
    await recordSecurityReceiptSafe(db, {
      connection_id: connection.id,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_missing_signature",
      request_ip: requestIp,
    });
    return { httpStatus: 401, body: { ok: false, status: "refused_missing_signature" } };
  }
  if (!signature.ok) {
    await recordSecurityReceiptSafe(db, {
      connection_id: connection.id,
      body_sha256: bodyHash,
      byte_length: byteLength,
      refusal_status: "refused_invalid_signature",
      request_ip: requestIp,
    });
    return { httpStatus: 401, body: { ok: false, status: "refused_invalid_signature" } };
  }

  const parsed = parseVerifiedReadPayload(raw);
  let provider_request_id = null;
  let provider_session_id = null;
  let delivery_state = "verified_invalid_payload";
  let providerMetadata = {
    provider_title: null,
    provider_started_at_text: null,
    provider_ended_at_text: null,
    provider_event_trigger: null,
    metadata: { parse_error: parsed.error || "unknown" },
  };

  if (parsed.ok) {
    const identity = readReadIdentity(parsed.payload);
    provider_request_id = identity.request_id;
    provider_session_id = identity.session_id;
    providerMetadata = readProviderMetadata(parsed.payload);
    if (provider_request_id && provider_session_id) {
      delivery_state = "processed_unbound";
    } else {
      delivery_state = "verified_unresolved_identity";
      providerMetadata.metadata.identity_error = !provider_request_id
        ? "missing_request_id"
        : "missing_session_id";
    }
  }

  const persisted = await persistVerifiedDelivery(db, {
    connection_id: connection.id,
    provider_request_id,
    provider_session_id,
    raw_body: raw,
    payload_sha256: bodyHash,
    byte_length: byteLength,
    signature_header: normaliseHeader(signatureHeader).toLowerCase(),
    delivery_state,
    provider_event_trigger: providerMetadata.provider_event_trigger,
    provider_payload_metadata: providerMetadata.metadata,
    provider_metadata_columns: {
      provider_title: providerMetadata.provider_title,
      provider_started_at_text: providerMetadata.provider_started_at_text,
      provider_ended_at_text: providerMetadata.provider_ended_at_text,
      provider_metadata: providerMetadata.metadata,
    },
  });

  return {
    httpStatus: 202,
    body: {
      ok: true,
      status: persisted.outcome,
      delivery_id: persisted.delivery.id,
      logical_delivery_id: persisted.logical_delivery_id,
      provider_meeting_id: persisted.provider_meeting_id,
      request_id: provider_request_id,
      session_id: provider_session_id,
      payload_sha256: bodyHash,
      byte_length: byteLength,
    },
  };
}

async function ensureReadAiConnection(db, {
  connectionId,
  authorizedByUserId,
  providerMetadata = {},
} = {}) {
  const id = asUuidish(connectionId);
  if (!id) throw serviceError(503, "read_ai_connection_not_configured", "READ_AI_CONNECTION_ID is missing or invalid.");
  if (!authorizedByUserId) throw serviceError(401, "no_authorizing_user", "A staff session is required to authorize the Read AI connection.");

  return (await db.query(
    `insert into integration_connections
       (id, provider, authorized_by_user_id, authorized_at, connection_status, provider_account_metadata)
     values ($1,$2,$3,now(),'active',$4)
     on conflict (id) do update
       set connection_status = 'active',
           provider_account_metadata = excluded.provider_account_metadata,
           updated_at = now()
     returning id, provider, authorized_by_user_id, authorized_at, connection_status,
               provider_account_metadata`,
    [id, PROVIDER, authorizedByUserId, providerMetadata || {}]
  )).rows[0];
}

async function bindProviderMeeting(db, {
  providerMeetingId,
  propertyId,
  boundByUserId,
  bindingBasis = "staff_session_explicit_binding",
} = {}) {
  if (!providerMeetingId) throw serviceError(400, "missing_provider_meeting_id", "provider meeting id is required.");
  if (!propertyId) throw serviceError(400, "missing_property_id", "property id is required.");
  if (!boundByUserId) throw serviceError(401, "no_binder", "A staff session is required to bind meeting evidence.");

  return withTransaction(db, async (client) => {
    const meeting = (await client.query(
      `select id, provider, connection_id, provider_session_id, first_delivery_id
         from meeting_provider_meetings
        where id = $1`,
      [providerMeetingId]
    )).rows[0];
    if (!meeting) throw serviceError(404, "provider_meeting_not_found", "Provider meeting not found.");

    const current = (await client.query(
      `select b.id, b.provider_meeting_id, b.property_id, b.bound_by_user_id,
              b.bound_at, b.binding_basis, b.binding_kind, b.correction_reason,
              b.supersedes_binding_id
         from meeting_property_bindings b
        where b.provider_meeting_id = $1
          and not exists (
            select 1 from meeting_property_bindings child
             where child.supersedes_binding_id = b.id
          )
        for update`,
      [providerMeetingId]
    )).rows[0];
    if (current) {
      if (String(current.property_id) === String(propertyId)) {
        return { ...current, deduplicated: true };
      }
      throw serviceError(409, "provider_meeting_binding_correction_required",
        "Provider meeting is already bound to another property; use an explicit binding correction.");
    }

    const row = (await client.query(
      `insert into meeting_property_bindings
         (provider_meeting_id, property_id, bound_by_user_id, binding_basis, binding_kind)
       values ($1,$2,$3,$4,'initial')
       on conflict (provider_meeting_id) where supersedes_binding_id is null do nothing
       returning id, provider_meeting_id, property_id, bound_by_user_id, bound_at,
                 binding_basis, binding_kind, correction_reason, supersedes_binding_id`,
      [providerMeetingId, propertyId, boundByUserId, bindingBasis]
    )).rows[0];
    if (row) return { ...row, deduplicated: false };

    const raced = (await client.query(
      `select * from meeting_property_current_bindings where provider_meeting_id = $1`,
      [providerMeetingId]
    )).rows[0];
    if (raced && String(raced.property_id) === String(propertyId)) {
      return { ...raced, deduplicated: true };
    }
    throw serviceError(409, "provider_meeting_binding_correction_required",
      "Provider meeting became bound to another property; use an explicit binding correction.");
  });
}

async function correctProviderMeetingBinding(db, {
  providerMeetingId,
  currentPropertyId,
  replacementPropertyId,
  correctedByUserId,
  correctionReason,
  bindingBasis = "staff_session_explicit_correction",
} = {}) {
  if (!providerMeetingId) throw serviceError(400, "missing_provider_meeting_id", "provider meeting id is required.");
  if (!currentPropertyId) throw serviceError(400, "missing_current_property_id", "current property id is required.");
  if (!replacementPropertyId) throw serviceError(400, "missing_replacement_property_id", "replacement property id is required.");
  if (!correctedByUserId) throw serviceError(401, "no_binding_corrector", "A staff session is required to correct meeting evidence.");
  if (!String(correctionReason || "").trim()) {
    throw serviceError(400, "missing_binding_correction_reason", "binding correction reason is required.");
  }
  if (String(currentPropertyId) === String(replacementPropertyId)) {
    throw serviceError(409, "binding_replacement_unchanged", "replacement property must differ from the current binding.");
  }

  return withTransaction(db, async (client) => {
    const current = (await client.query(
      `select b.*
         from meeting_property_bindings b
        where b.provider_meeting_id = $1
          and not exists (
            select 1 from meeting_property_bindings child
             where child.supersedes_binding_id = b.id
          )
        for update`,
      [providerMeetingId]
    )).rows[0];
    if (!current) throw serviceError(404, "provider_meeting_binding_not_found", "Provider meeting has no current property binding.");
    if (String(current.property_id) !== String(currentPropertyId)) {
      throw serviceError(404, "provider_meeting_binding_not_visible",
        "The current provider meeting binding is not visible from this staff session property.");
    }

    const assignments = (await client.query(
      `select property_id, can_manage_roles
         from property_team_assignments
        where user_id = $1
          and property_id = any($2::uuid[])
          and active = true`,
      [correctedByUserId, [currentPropertyId, replacementPropertyId]]
    )).rows;
    const manages = new Set(assignments
      .filter((row) => row.can_manage_roles === true)
      .map((row) => String(row.property_id)));
    if (!manages.has(String(currentPropertyId)) || !manages.has(String(replacementPropertyId))) {
      throw serviceError(403, "binding_correction_authority_required",
        "Binding correction requires active management authority at both properties.");
    }

    return (await client.query(
      `insert into meeting_property_bindings
         (provider_meeting_id, property_id, bound_by_user_id, binding_basis,
          binding_kind, correction_reason, supersedes_binding_id)
       values ($1,$2,$3,$4,'correction',$5,$6)
       returning id, provider_meeting_id, property_id, bound_by_user_id, bound_at,
                 binding_basis, binding_kind, correction_reason, supersedes_binding_id`,
      [providerMeetingId, replacementPropertyId, correctedByUserId, bindingBasis,
       String(correctionReason).trim(), current.id]
    )).rows[0];
  });
}

async function qualifyProviderDelivery(db, {
  providerMeetingId,
  providerDeliveryId,
  qualificationStatus,
  qualificationBasis,
  qualifiedByUserId,
} = {}) {
  if (!providerMeetingId) throw serviceError(400, "missing_provider_meeting_id", "provider meeting id is required.");
  if (!providerDeliveryId) throw serviceError(400, "missing_provider_delivery_id", "provider delivery id is required.");
  if (!qualifiedByUserId) throw serviceError(401, "no_finality_qualifier", "A staff session is required to qualify finality.");
  if (!["qualified_final", "not_final"].includes(qualificationStatus)) {
    throw serviceError(400, "unknown_finality_qualification", "qualification status must be qualified_final or not_final.");
  }
  if (!String(qualificationBasis || "").trim()) {
    throw serviceError(400, "missing_finality_basis", "qualification basis is required.");
  }

  return withTransaction(db, async (client) => {
    const delivery = (await client.query(
      `select d.id, d.provider_event_trigger, d.related_delivery_id, d.delivery_state,
              m.id as provider_meeting_id, c.authorized_by_user_id
         from meeting_provider_deliveries d
         join meeting_provider_meetings m
           on m.connection_id = d.connection_id
          and m.provider = d.provider
          and m.provider_session_id = d.provider_session_id
         join integration_connections c
           on c.id = d.connection_id
          and c.connection_status = 'active'
        where d.id = $1 and m.id = $2`,
      [providerDeliveryId, providerMeetingId]
    )).rows[0];
    if (!delivery || delivery.related_delivery_id || delivery.delivery_state !== "processed_unbound") {
      throw serviceError(404, "logical_provider_delivery_not_found",
        "No exact logical provider delivery is available for this provider meeting.");
    }
    if (String(delivery.authorized_by_user_id) !== String(qualifiedByUserId)) {
      throw serviceError(403, "finality_qualification_authority_required",
        "Only the user who authorized this Read connection may qualify delivery finality.");
    }

    const current = (await client.query(
      `select q.*
         from meeting_provider_delivery_qualifications q
        where q.provider_delivery_id = $1
          and not exists (
            select 1 from meeting_provider_delivery_qualifications child
             where child.supersedes_qualification_id = q.qualification_id
          )
        for update`,
      [providerDeliveryId]
    )).rows[0];
    if (current
        && current.qualification_status === qualificationStatus
        && current.qualification_basis === String(qualificationBasis).trim()) {
      return { ...current, provider_event_trigger: delivery.provider_event_trigger, deduplicated: true };
    }

    const inserted = (await client.query(
      `insert into meeting_provider_delivery_qualifications
         (provider_meeting_id, provider_delivery_id, qualification_status,
          qualification_method, qualification_basis, qualified_by_user_id,
          supersedes_qualification_id)
       values ($1,$2,$3,'manual_exact_delivery_review',$4,$5,$6)
       returning qualification_id, provider_meeting_id, provider_delivery_id,
                 qualification_status, qualification_method, qualification_basis,
                 qualified_by_user_id,
                 qualified_at, supersedes_qualification_id`,
      [providerMeetingId, providerDeliveryId, qualificationStatus,
       String(qualificationBasis).trim(), qualifiedByUserId,
       current ? current.qualification_id : null]
    )).rows[0];
    return { ...inserted, provider_event_trigger: delivery.provider_event_trigger, deduplicated: false };
  });
}

async function readBoundProviderMeeting(db, { providerMeetingId, propertyId } = {}) {
  const meeting = (await db.query(
    `select m.id, m.provider, m.connection_id, m.provider_session_id,
            m.first_delivery_id, m.first_observed_at, m.provider_title,
            m.provider_started_at_text, m.provider_ended_at_text,
            b.id as binding_id, b.property_id, b.bound_by_user_id, b.bound_at, b.binding_basis
       from meeting_provider_meetings m
       join meeting_property_current_bindings b on b.provider_meeting_id = m.id
      where m.id = $1 and b.property_id = $2`,
    [providerMeetingId, propertyId]
  )).rows[0];
  if (!meeting) return null;

  const deliveries = (await db.query(
    `select id, provider_request_id, provider_session_id, received_at,
            payload_sha256, byte_length, delivery_state, related_delivery_id,
            provider_event_trigger
       from meeting_provider_deliveries
      where connection_id = $1 and provider_session_id = $2
      order by received_at asc`,
    [meeting.connection_id, meeting.provider_session_id]
  )).rows;

  return { meeting, deliveries };
}

async function readBoundProviderTranscript(db, { providerMeetingId, propertyId } = {}) {
  const scoped = await readBoundProviderMeeting(db, { providerMeetingId, propertyId });
  if (!scoped) {
    throw serviceError(404, "bound_provider_meeting_not_found", "No bound provider meeting is visible for this property.");
  }

  const deliveries = (await db.query(
    `select d.id, d.received_at, d.payload_sha256, d.raw_body,
            d.provider_event_trigger, q.qualification_id,
            q.qualification_status, q.qualification_basis, q.qualified_at
       from meeting_provider_deliveries d
       join meeting_provider_delivery_current_qualifications q
         on q.provider_delivery_id = d.id
        and q.provider_meeting_id = $3
        and q.qualification_status = 'qualified_final'
      where d.connection_id = $1
        and d.provider_session_id = $2
        and d.related_delivery_id is null
        and d.delivery_state = 'processed_unbound'
      order by d.received_at desc`,
    [scoped.meeting.connection_id, scoped.meeting.provider_session_id, providerMeetingId]
  )).rows;

  for (const delivery of deliveries) {
    const parsed = parseVerifiedReadPayload(delivery.raw_body);
    if (!parsed.ok) continue;
    const identity = readReadIdentity(parsed.payload);
    if (identity.session_id !== scoped.meeting.provider_session_id) continue;
    const transcript = readReadTranscript(parsed.payload);
    if (!transcript.ok) continue;
    return {
      ...transcript,
      provider_meeting: scoped.meeting,
      provider_delivery_id: delivery.id,
      provider_delivery_qualification_id: delivery.qualification_id,
      provider_event_trigger: delivery.provider_event_trigger,
      provider_payload_sha256: delivery.payload_sha256,
    };
  }

  throw serviceError(409, "bound_meeting_has_no_qualified_final_transcript",
    "The bound Read AI meeting has no valid transcript from an exact delivery currently qualified as final.");
}

module.exports = {
  MEETING_EVIDENCE_MODULES,
  PROVIDER,
  RAW_BODY_LIMIT_BYTES,
  bindProviderMeeting,
  correctProviderMeetingBinding,
  ensureReadAiConnection,
  hasMeetingEvidenceAccess,
  qualifyProviderDelivery,
  readBoundProviderMeeting,
  readBoundProviderTranscript,
  receiveReadWebhook,
  recordSecurityReceiptSafe,
  serviceError,
  sha256Hex,
};
