"use strict";

const { parseVerifiedReadPayload, readReadIdentity } = require("./read_ai_payload");
const { readReadTranscript } = require("./read_ai_transcript");
const { serviceError, sha256Hex } = require("./meeting_evidence_service");

const SCOPE_MODES = Object.freeze(["single_property", "mixed_property", "unresolved"]);
const TARGET_KINDS = Object.freeze([
  "property",
  "portfolio_wide",
  "external_property",
  "unresolved",
  "excluded_sensitive",
]);
const SCOPE_REVIEW_COVERAGE = Object.freeze(["partial", "complete"]);
const PROPERTY_MODULES = Object.freeze(["management", "asset_management", "leasing"]);

function presentText(value) {
  const text = String(value == null ? "" : value).trim();
  return text || null;
}

function requireText(value, code, message) {
  const text = presentText(value);
  if (!text) throw serviceError(400, code, message);
  return text;
}

function requireChoice(value, choices, code, message) {
  if (!choices.includes(value)) throw serviceError(400, code, message);
  return value;
}

function unicodeCharacters(value) {
  return Array.from(String(value || ""));
}

async function withTransaction(db, fn) {
  if (!db || typeof db.connect !== "function" || typeof db.release === "function") return fn(db);
  const client = await db.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    try { await client.query("rollback"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function providerMeetingAuthority(db, providerMeetingId) {
  return (await db.query(
    `select m.id as provider_meeting_id, m.provider_session_id,
            m.provider_title, m.provider_started_at_text, m.provider_ended_at_text,
            c.authorized_by_user_id
       from meeting_provider_meetings m
       join integration_connections c
         on c.id = m.connection_id
        and c.provider = m.provider
        and c.connection_status = 'active'
      where m.id = $1`,
    [providerMeetingId]
  )).rows[0] || null;
}

function requireConnectionAuthorizer(context, actorUserId) {
  if (!context) {
    throw serviceError(404, "provider_meeting_not_found", "Provider meeting not found on an active connection.");
  }
  if (String(context.authorized_by_user_id) !== String(actorUserId)) {
    throw serviceError(403, "meeting_scope_authority_required",
      "Only the user who authorized this Read connection may classify or inspect the unbound meeting.");
  }
}

async function currentScopeClassification(db, providerMeetingId, { lock = false } = {}) {
  const lockSql = lock ? "for update" : "";
  return (await db.query(
    `select c.scope_classification_id, c.provider_meeting_id, c.scope_mode,
            c.classification_basis, c.classified_by_user_id, c.classified_at,
            c.supersedes_classification_id
       from meeting_provider_scope_classifications c
      where c.provider_meeting_id = $1
        and not exists (
          select 1 from meeting_provider_scope_classifications child
           where child.supersedes_classification_id = c.scope_classification_id
        )
      ${lockSql}`,
    [providerMeetingId]
  )).rows[0] || null;
}

async function classifyProviderMeetingScope(db, {
  providerMeetingId,
  scopeMode,
  classificationBasis,
  classifiedByUserId,
} = {}) {
  if (!providerMeetingId) {
    throw serviceError(400, "missing_provider_meeting_id", "provider meeting id is required.");
  }
  if (!classifiedByUserId) {
    throw serviceError(401, "no_scope_classifier", "A staff session is required to classify meeting scope.");
  }
  requireChoice(scopeMode, SCOPE_MODES, "unknown_meeting_scope_mode",
    "scope mode must be single_property, mixed_property, or unresolved.");
  const basis = requireText(classificationBasis, "missing_scope_classification_basis",
    "classification basis is required.");

  return withTransaction(db, async (client) => {
    const authority = await providerMeetingAuthority(client, providerMeetingId);
    requireConnectionAuthorizer(authority, classifiedByUserId);
    const current = await currentScopeClassification(client, providerMeetingId, { lock: true });
    if (current && current.scope_mode === scopeMode && current.classification_basis === basis) {
      return { ...current, deduplicated: true };
    }

    const inserted = (await client.query(
      `insert into meeting_provider_scope_classifications
         (provider_meeting_id, scope_mode, classification_basis,
          classified_by_user_id, supersedes_classification_id)
       values ($1,$2,$3,$4,$5)
       returning scope_classification_id, provider_meeting_id, scope_mode,
                 classification_basis, classified_by_user_id, classified_at,
                 supersedes_classification_id`,
      [providerMeetingId, scopeMode, basis, classifiedByUserId,
       current ? current.scope_classification_id : null]
    )).rows[0];
    return { ...inserted, deduplicated: false };
  });
}

async function qualifiedDeliveryContext(db, { providerMeetingId, providerDeliveryId } = {}) {
  const row = (await db.query(
    `select m.id as provider_meeting_id, m.provider_session_id,
            m.provider_title, m.provider_started_at_text, m.provider_ended_at_text,
            d.id as provider_delivery_id, d.raw_body, d.payload_sha256,
            d.provider_event_trigger, q.qualification_id,
            q.qualification_basis, q.qualified_at,
            c.authorized_by_user_id
       from meeting_provider_meetings m
       join integration_connections c
         on c.id = m.connection_id
        and c.provider = m.provider
        and c.connection_status = 'active'
       join meeting_provider_deliveries d
         on d.connection_id = m.connection_id
        and d.provider = m.provider
        and d.provider_session_id = m.provider_session_id
        and d.id = $2
        and d.related_delivery_id is null
        and d.delivery_state = 'processed_unbound'
       join meeting_provider_delivery_current_qualifications q
         on q.provider_delivery_id = d.id
        and q.provider_meeting_id = m.id
        and q.qualification_status = 'qualified_final'
      where m.id = $1`,
    [providerMeetingId, providerDeliveryId]
  )).rows[0];
  if (!row) {
    throw serviceError(409, "mixed_meeting_delivery_not_final",
      "Passage scoping requires this exact provider delivery to be currently qualified final.");
  }

  const parsed = parseVerifiedReadPayload(row.raw_body);
  if (!parsed.ok) {
    throw serviceError(409, "mixed_meeting_delivery_invalid", "The exact provider delivery is not valid JSON evidence.");
  }
  const identity = readReadIdentity(parsed.payload);
  if (identity.session_id !== row.provider_session_id) {
    throw serviceError(409, "mixed_meeting_delivery_identity_mismatch",
      "The exact provider delivery no longer resolves to this provider meeting identity.");
  }
  const transcript = readReadTranscript(parsed.payload);
  if (!transcript.ok) {
    throw serviceError(409, transcript.code, transcript.message);
  }
  return { ...row, transcript };
}

async function readScopeWorkspace(db, {
  providerMeetingId,
  providerDeliveryId,
  actorUserId,
} = {}) {
  const context = await qualifiedDeliveryContext(db, { providerMeetingId, providerDeliveryId });
  requireConnectionAuthorizer(context, actorUserId);
  const classification = await currentScopeClassification(db, providerMeetingId);
  return {
    provider_meeting: {
      provider_meeting_id: context.provider_meeting_id,
      provider_delivery_id: context.provider_delivery_id,
      provider_delivery_qualification_id: context.qualification_id,
      provider_title: context.provider_title,
      provider_started_at_text: context.provider_started_at_text,
      provider_ended_at_text: context.provider_ended_at_text,
      provider_event_trigger: context.provider_event_trigger,
      payload_sha256: context.payload_sha256,
    },
    scope_classification: classification,
    blocks: context.transcript.blocks,
  };
}

function normalizePassageInput(passages, { blocks, propertyId } = {}) {
  if (!Array.isArray(passages)) {
    throw serviceError(400, "passage_scope_array_required", "passages must be an array.");
  }
  const blockByOrdinal = new Map((blocks || []).map((block) => [block.provider_block_ordinal, block]));
  const normalized = passages.map((passage, index) => {
    const input = passage && typeof passage === "object" ? passage : {};
    const blockOrdinal = Number(input.provider_block_ordinal);
    const charStart = Number(input.char_start);
    const charEnd = Number(input.char_end);
    if (!Number.isInteger(blockOrdinal) || blockOrdinal < 1 || !blockByOrdinal.has(blockOrdinal)) {
      throw serviceError(400, "passage_scope_block_invalid", `passages[${index}] has no exact provider block.`);
    }
    const block = blockByOrdinal.get(blockOrdinal);
    const blockCharacters = unicodeCharacters(block.text);
    if (!Number.isInteger(charStart) || !Number.isInteger(charEnd)
        || charStart < 0 || charEnd <= charStart || charEnd > blockCharacters.length) {
      throw serviceError(400, "passage_scope_range_invalid",
        `passages[${index}] must name a valid character range inside provider block ${blockOrdinal}.`);
    }
    const targetKind = requireChoice(input.scope_target_kind, TARGET_KINDS,
      "unknown_passage_scope_target", `passages[${index}] has an unknown scope target.`);
    if (input.property_id && String(input.property_id) !== String(propertyId)) {
      throw serviceError(403, "passage_scope_client_property_refused",
        "A passage cannot use a client-supplied property to expand server-derived scope.");
    }
    if (input.property_id && targetKind !== "property") {
      throw serviceError(400, "passage_scope_property_not_allowed",
        `passages[${index}] may only carry property_id for property scope.`);
    }
    const externalLabel = targetKind === "external_property"
      ? requireText(input.external_scope_label, "external_scope_label_required",
        `passages[${index}] requires an external property label.`)
      : null;
    if (targetKind !== "external_property" && presentText(input.external_scope_label)) {
      throw serviceError(400, "external_scope_label_not_allowed",
        `passages[${index}] may only carry an external label for external_property scope.`);
    }
    // PostgreSQL char_length/substring count Unicode code points. Array.from
    // gives the server the same offset semantics even when Read emits emoji.
    const passageText = blockCharacters.slice(charStart, charEnd).join("");
    if (!passageText.trim()) {
      throw serviceError(400, "passage_scope_blank", `passages[${index}] selects only whitespace.`);
    }
    if (input.expected_text != null && String(input.expected_text) !== passageText) {
      throw serviceError(409, "passage_scope_stale_address",
        `passages[${index}] no longer matches the exact provider text at that address.`);
    }
    return {
      provider_block_ordinal: blockOrdinal,
      char_start: charStart,
      char_end: charEnd,
      provider_start_time: block.provider_start_time,
      provider_timestamp: block.provider_timestamp,
      speaker_label: block.speaker_label,
      passage_text: passageText,
      passage_text_sha256: sha256Hex(Buffer.from(passageText, "utf8")),
      scope_target_kind: targetKind,
      property_id: targetKind === "property" ? propertyId : null,
      external_scope_label: externalLabel,
      scope_note: presentText(input.scope_note),
    };
  }).sort((left, right) =>
    left.provider_block_ordinal - right.provider_block_ordinal
    || left.char_start - right.char_start
    || left.char_end - right.char_end
    || left.scope_target_kind.localeCompare(right.scope_target_kind));

  for (let index = 1; index < normalized.length; index += 1) {
    const prior = normalized[index - 1];
    const current = normalized[index];
    if (prior.provider_block_ordinal === current.provider_block_ordinal
        && current.char_start < prior.char_end) {
      throw serviceError(409, "passage_scope_overlap",
        `Provider block ${current.provider_block_ordinal} contains overlapping current scope ranges.`);
    }
  }
  return normalized;
}

function passageScopeDigest(scopeBasis, scopeReviewCoverage, passages) {
  const payload = {
    scope_basis: scopeBasis,
    scope_review_coverage: scopeReviewCoverage,
    passages: passages.map((passage) => ({
      provider_block_ordinal: passage.provider_block_ordinal,
      char_start: passage.char_start,
      char_end: passage.char_end,
      passage_text_sha256: passage.passage_text_sha256,
      scope_target_kind: passage.scope_target_kind,
      property_id: passage.property_id,
      external_scope_label: passage.external_scope_label,
      scope_note: passage.scope_note,
    })),
  };
  return sha256Hex(Buffer.from(JSON.stringify(payload), "utf8"));
}

async function assertPropertyAuthority(db, { propertyId, userId } = {}) {
  const allowed = (await db.query(
    `select exists (
       select 1 from property_team_assignments a
        where a.property_id = $1
          and a.user_id = $2
          and a.active = true
          and (
            a.can_manage_roles = true
            or a.allowed_modules && $3::text[]
          )
     ) as allowed`,
    [propertyId, userId, PROPERTY_MODULES]
  )).rows[0];
  if (!allowed || allowed.allowed !== true) {
    throw serviceError(403, "passage_scope_property_authority_required",
      "Passage scope requires active authority at the server-derived property.");
  }
}

async function loadPassageScopeSet(db, passageScopeSetId) {
  const set = (await db.query(
      `select passage_scope_set_id, provider_meeting_id,
            provider_delivery_qualification_id, scope_classification_id,
            scope_status, scope_review_coverage, scope_basis, scope_digest, scoped_by_user_id,
            scoped_at, supersedes_passage_scope_set_id
       from meeting_passage_scope_sets
      where passage_scope_set_id = $1`,
    [passageScopeSetId]
  )).rows[0];
  const passages = set ? (await db.query(
    `select passage_scope_id, passage_scope_set_id, ordinal,
            provider_block_ordinal, char_start, char_end,
            provider_start_time, speaker_label, passage_text,
            passage_text_sha256, scope_target_kind, property_id,
            external_scope_label, scope_note
       from meeting_passage_scopes
      where passage_scope_set_id = $1
      order by ordinal`,
    [passageScopeSetId]
  )).rows : [];
  return { set, passages };
}

async function replacePassageScopeSet(db, {
  providerMeetingId,
  providerDeliveryId,
  propertyId,
  scopedByUserId,
  scopeBasis,
  scopeReviewCoverage,
  passages,
} = {}) {
  if (!providerMeetingId || !providerDeliveryId || !propertyId) {
    throw serviceError(400, "passage_scope_identity_required",
      "provider meeting, exact delivery, and server-derived property are required.");
  }
  if (!scopedByUserId) {
    throw serviceError(401, "no_passage_scope_actor", "A staff session is required to scope meeting passages.");
  }
  const basis = requireText(scopeBasis, "missing_passage_scope_basis", "passage scope basis is required.");

  return withTransaction(db, async (client) => {
    const context = await qualifiedDeliveryContext(client, { providerMeetingId, providerDeliveryId });
    requireConnectionAuthorizer(context, scopedByUserId);
    await assertPropertyAuthority(client, { propertyId, userId: scopedByUserId });
    const classification = await currentScopeClassification(client, providerMeetingId, { lock: true });
    if (!classification || classification.scope_mode !== "mixed_property") {
      throw serviceError(409, "mixed_meeting_classification_required",
        "Passage scoping requires a current explicit mixed-property classification.");
    }
    if (String(classification.classified_by_user_id) !== String(scopedByUserId)) {
      throw serviceError(403, "meeting_scope_classifier_mismatch",
        "The connection authorizer who classified this meeting must scope its passages.");
    }

    const normalized = normalizePassageInput(passages, {
      blocks: context.transcript.blocks,
      propertyId,
    });
    if (!normalized.length && scopeReviewCoverage != null && scopeReviewCoverage !== "none") {
      throw serviceError(400, "withdrawn_passage_scope_coverage_invalid",
        "An empty withdrawn scope set must use scope_review_coverage none.");
    }
    const reviewCoverage = normalized.length
      ? requireChoice(scopeReviewCoverage, SCOPE_REVIEW_COVERAGE,
        "passage_scope_review_coverage_required",
        "scope_review_coverage must explicitly be partial or complete for a qualified set.")
      : "none";
    const digest = passageScopeDigest(basis, reviewCoverage, normalized);
    const current = (await client.query(
      `select s.*
         from meeting_passage_scope_sets s
        where s.scope_classification_id = $1
          and s.provider_delivery_qualification_id = $2
          and not exists (
            select 1 from meeting_passage_scope_sets child
             where child.supersedes_passage_scope_set_id = s.passage_scope_set_id
          )
        for update`,
      [classification.scope_classification_id, context.qualification_id]
    )).rows[0];
    if (current && current.scope_digest === digest) {
      const loaded = await loadPassageScopeSet(client, current.passage_scope_set_id);
      return { ...loaded, deduplicated: true };
    }

    const status = normalized.length ? "qualified" : "withdrawn";
    const inserted = (await client.query(
      `insert into meeting_passage_scope_sets
         (provider_meeting_id, provider_delivery_qualification_id,
          scope_classification_id, scope_status, scope_review_coverage,
          scope_basis, scope_digest,
          scoped_by_user_id, supersedes_passage_scope_set_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning passage_scope_set_id`,
      [providerMeetingId, context.qualification_id,
       classification.scope_classification_id, status, reviewCoverage, basis, digest,
       scopedByUserId, current ? current.passage_scope_set_id : null]
    )).rows[0];

    for (let index = 0; index < normalized.length; index += 1) {
      const passage = normalized[index];
      await client.query(
        `insert into meeting_passage_scopes
           (passage_scope_set_id, ordinal, provider_block_ordinal,
            char_start, char_end, provider_start_time, speaker_label,
            passage_text, passage_text_sha256, scope_target_kind,
            property_id, external_scope_label, scope_note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [inserted.passage_scope_set_id, index + 1, passage.provider_block_ordinal,
         passage.char_start, passage.char_end, passage.provider_start_time,
         passage.speaker_label, passage.passage_text, passage.passage_text_sha256,
         passage.scope_target_kind, passage.property_id,
         passage.external_scope_label, passage.scope_note]
      );
    }
    const loaded = await loadPassageScopeSet(client, inserted.passage_scope_set_id);
    return { ...loaded, deduplicated: false };
  });
}

async function readPropertyPassagePreview(db, {
  providerMeetingId,
  providerDeliveryId,
  propertyId,
  actorUserId,
} = {}) {
  await assertPropertyAuthority(db, { propertyId, userId: actorUserId });
  const set = (await db.query(
    `select s.*, d.raw_body
       from meeting_passage_scope_current_sets s
       join meeting_provider_delivery_qualifications q
         on q.qualification_id = s.provider_delivery_qualification_id
       join meeting_provider_deliveries d on d.id = q.provider_delivery_id
      where s.provider_meeting_id = $1
        and s.provider_delivery_id = $2`,
    [providerMeetingId, providerDeliveryId]
  )).rows[0];
  if (!set) {
    throw serviceError(404, "current_passage_scope_not_found",
      "No current qualified passage scope exists for this exact mixed-meeting delivery.");
  }

  const propertyPassages = (await db.query(
    `select passage_scope_id, ordinal, provider_block_ordinal,
            char_start, char_end, provider_start_time, speaker_label,
            passage_text, passage_text_sha256, property_id, scope_note
       from meeting_property_current_passages
      where passage_scope_set_id = $1 and property_id = $2
      order by ordinal`,
    [set.passage_scope_set_id, propertyId]
  )).rows;
  const parsed = parseVerifiedReadPayload(set.raw_body);
  const transcript = parsed.ok ? readReadTranscript(parsed.payload) : { ok: false };
  const blockByOrdinal = new Map((transcript.blocks || []).map((block) =>
    [block.provider_block_ordinal, block]));
  const visible = propertyPassages.map((passage) => ({
    ...passage,
    provider_timestamp: (blockByOrdinal.get(passage.provider_block_ordinal) || {}).provider_timestamp || null,
  }));
  return {
    scope: {
      passage_scope_set_id: set.passage_scope_set_id,
      provider_meeting_id: set.provider_meeting_id,
      provider_delivery_id: set.provider_delivery_id,
      provider_delivery_qualification_id: set.provider_delivery_qualification_id,
      scope_classification_id: set.scope_classification_id,
      scope_review_coverage: set.scope_review_coverage,
      scope_basis: set.scope_basis,
      scope_digest: set.scope_digest,
      scoped_by_user_id: set.scoped_by_user_id,
      scoped_at: set.scoped_at,
    },
    property_id: propertyId,
    property_passage_count: visible.length,
    passages: visible,
    scoped_excerpt: visible.map((passage) =>
      `${passage.provider_timestamp || passage.provider_start_time} - ${passage.speaker_label}\n${passage.passage_text}`
    ).join("\n\n"),
  };
}

module.exports = {
  SCOPE_MODES,
  SCOPE_REVIEW_COVERAGE,
  TARGET_KINDS,
  classifyProviderMeetingScope,
  currentScopeClassification,
  normalizePassageInput,
  passageScopeDigest,
  readPropertyPassagePreview,
  readScopeWorkspace,
  replacePassageScopeSet,
};
