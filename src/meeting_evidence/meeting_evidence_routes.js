"use strict";

const express = require("express");
const staffSessions = require("../identity/staff_session_service");
const service = require("./meeting_evidence_service");
const passageScopeService = require("./meeting_passage_scope_service");
const receiptService = require("./meeting_receipt_service");
const receiptWorkflow = require("./meeting_receipt_workflow");
const { createAnthropicMeetingReceiptExtractor } = require("./anthropic_meeting_receipt_extractor");

function requirePool(pool) {
  if (!pool) throw new Error("meeting evidence routes require a pool");
}

function requireOperatorFactory(pool) {
  return async function requireOperator(req, res, next) {
    try {
      const op = await staffSessions.resolveStaffSession(pool, req.headers["x-staff-session"]);
      if (!op) return res.status(401).json({ error: "No valid operator session. Sign in." });
      req.operator = op;
      return next();
    } catch (err) {
      console.error("meeting evidence session resolution failed", err);
      return res.status(500).json({ error: "session resolution failed" });
    }
  };
}

function requireMeetingEvidenceAccess(req, res, next) {
  if (!service.hasMeetingEvidenceAccess(req.operator)) {
    return res.status(403).json({
      error: "meeting-evidence access requires active property authority and an operating module entitlement.",
    });
  }
  return next();
}

function refuseClientProperty(req, res, next) {
  const claimed = (req.query && req.query.property_id) || (req.body && req.body.property_id) || null;
  if (claimed && String(claimed) !== String(req.operator.property_id)) {
    return res.status(403).json({
      error: "property authority is server-derived; a client-supplied property_id cannot select a different property.",
      acting_on: req.operator.property_id,
    });
  }
  return next();
}

function mapError(res, err) {
  const status = err.httpStatus || 500;
  const body = { error: err.message || "meeting evidence request failed" };
  if (err.code) body.code = err.code;
  if (err.detail) body.detail = err.detail;
  if (err.errors) body.errors = err.errors;
  return res.status(status).json(body);
}

function readAiWebhook({ pool, serviceOverride } = {}) {
  requirePool(pool);
  const router = express.Router();
  const impl = serviceOverride || service;

  router.post("/",
    express.raw({ type: "*/*", limit: service.RAW_BODY_LIMIT_BYTES }),
    async (req, res) => {
      try {
        const out = await impl.receiveReadWebhook(pool, {
          rawBody: req.body,
          signatureHeader: req.get("X-Read-Signature"),
          env: process.env,
          requestIp: req.ip,
        });
        return res.status(out.httpStatus).json(out.body);
      } catch (err) {
        console.error("read ai webhook failed after receipt attempt", err);
        return res.status(500).json({ ok: false, status: "processing_failed" });
      }
    });

  return router;
}

function readAiWebhookErrorHandler({ pool } = {}) {
  requirePool(pool);
  return async function readAiWebhookError(err, req, res, next) {
    if (!err || err.type !== "entity.too.large") return next(err);
    await service.recordSecurityReceiptSafe(pool, {
      connection_id: null,
      body_sha256: null,
      byte_length: typeof err.length === "number" ? err.length : null,
      refusal_status: "refused_body_too_large",
      request_ip: req.ip,
      detail: "route-specific raw body parser refused the Read AI payload before JSON parsing",
    });
    return res.status(413).json({ ok: false, status: "refused_body_too_large" });
  };
}

function operatorRoutes({
  pool,
  anthropic = null,
  extractorOverride = null,
  receiptServiceOverride = null,
  receiptWorkflowOverride = null,
  passageScopeServiceOverride = null,
} = {}) {
  requirePool(pool);
  const router = express.Router();
  const gate = [requireOperatorFactory(pool), requireMeetingEvidenceAccess, refuseClientProperty];
  const receipts = receiptServiceOverride || receiptService;
  const workflow = receiptWorkflowOverride || receiptWorkflow;
  const passageScopes = passageScopeServiceOverride || passageScopeService;
  const extractor = extractorOverride || (anthropic
    ? createAnthropicMeetingReceiptExtractor({ anthropic })
    : null);

  router.post("/operator/meeting-evidence/read-ai/connection", ...gate, async (req, res) => {
    try {
      const row = await service.ensureReadAiConnection(pool, {
        connectionId: process.env.READ_AI_CONNECTION_ID,
        authorizedByUserId: req.operator.id,
        providerMetadata: (req.body && req.body.provider_metadata) || {},
      });
      return res.json({
        id: row.id,
        provider: row.provider,
        authorized_by_user_id: row.authorized_by_user_id,
        authorized_at: row.authorized_at,
        connection_status: row.connection_status,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/scope-classifications", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const row = await passageScopes.classifyProviderMeetingScope(pool, {
        providerMeetingId: req.params.id,
        scopeMode: body.scope_mode,
        classificationBasis: body.classification_basis,
        classifiedByUserId: req.operator.id,
      });
      return res.status(row.deduplicated ? 200 : 201).json(row);
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.get("/operator/meeting-evidence/provider-meetings/:id/deliveries/:deliveryId/scope-workspace", ...gate, async (req, res) => {
    try {
      return res.json(await passageScopes.readScopeWorkspace(pool, {
        providerMeetingId: req.params.id,
        providerDeliveryId: req.params.deliveryId,
        actorUserId: req.operator.id,
      }));
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/deliveries/:deliveryId/passage-scope-sets", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const out = await passageScopes.replacePassageScopeSet(pool, {
        providerMeetingId: req.params.id,
        providerDeliveryId: req.params.deliveryId,
        propertyId: req.operator.property_id,
        scopedByUserId: req.operator.id,
        scopeBasis: body.scope_basis,
        scopeReviewCoverage: body.scope_review_coverage,
        passages: body.passages,
      });
      return res.status(out.deduplicated ? 200 : 201).json(out);
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.get("/operator/meeting-evidence/provider-meetings/:id/deliveries/:deliveryId/property-passage-preview", ...gate, async (req, res) => {
    try {
      return res.json(await passageScopes.readPropertyPassagePreview(pool, {
        providerMeetingId: req.params.id,
        providerDeliveryId: req.params.deliveryId,
        propertyId: req.operator.property_id,
        actorUserId: req.operator.id,
      }));
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/bind", ...gate, async (req, res) => {
    try {
      const row = await service.bindProviderMeeting(pool, {
        providerMeetingId: req.params.id,
        propertyId: req.operator.property_id,
        boundByUserId: req.operator.id,
        bindingBasis: "staff_session_explicit_binding",
      });
      return res.json({
        provider_meeting_id: row.provider_meeting_id,
        property_id: row.property_id,
        bound_by_user_id: row.bound_by_user_id,
        bound_at: row.bound_at,
        binding_basis: row.binding_basis,
        binding_kind: row.binding_kind,
        correction_reason: row.correction_reason,
        supersedes_binding_id: row.supersedes_binding_id,
        deduplicated: row.deduplicated,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/binding-corrections", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const row = await service.correctProviderMeetingBinding(pool, {
        providerMeetingId: req.params.id,
        currentPropertyId: req.operator.property_id,
        replacementPropertyId: body.replacement_property_id,
        correctedByUserId: req.operator.id,
        correctionReason: body.correction_reason,
        bindingBasis: "staff_session_explicit_correction",
      });
      return res.status(201).json({
        provider_meeting_id: row.provider_meeting_id,
        property_id: row.property_id,
        bound_by_user_id: row.bound_by_user_id,
        bound_at: row.bound_at,
        binding_basis: row.binding_basis,
        binding_kind: row.binding_kind,
        correction_reason: row.correction_reason,
        supersedes_binding_id: row.supersedes_binding_id,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/deliveries/:deliveryId/finality", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const row = await service.qualifyProviderDelivery(pool, {
        providerMeetingId: req.params.id,
        providerDeliveryId: req.params.deliveryId,
        qualificationStatus: body.qualification_status,
        qualificationBasis: body.qualification_basis,
        qualifiedByUserId: req.operator.id,
      });
      return res.status(row.deduplicated ? 200 : 201).json({
        qualification_id: row.qualification_id,
        provider_meeting_id: row.provider_meeting_id,
        provider_delivery_id: row.provider_delivery_id,
        qualification_status: row.qualification_status,
        qualification_method: row.qualification_method,
        qualification_basis: row.qualification_basis,
        qualified_by_user_id: row.qualified_by_user_id,
        qualified_at: row.qualified_at,
        supersedes_qualification_id: row.supersedes_qualification_id,
        provider_event_trigger: row.provider_event_trigger,
        deduplicated: row.deduplicated,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.get("/operator/meeting-evidence/provider-meetings/:id", ...gate, async (req, res) => {
    try {
      const out = await service.readBoundProviderMeeting(pool, {
        providerMeetingId: req.params.id,
        propertyId: req.operator.property_id,
      });
      if (!out) {
        return res.status(404).json({
          error: "No property-scoped meeting evidence is visible for this operator.",
        });
      }
      return res.json({
        property_id: req.operator.property_id,
        meeting: out.meeting,
        deliveries: out.deliveries,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.get("/operator/meeting-evidence/release-readiness", ...gate, async (req, res) => {
    try {
      const readiness = await workflow.assertMeetingReceiptReady(pool);
      return res.json(readiness);
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/provider-meetings/:id/owner-receipt", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const out = await workflow.generateOwnerReceiptFromProviderMeeting({
        db: pool,
        extractor,
        providerMeetingId: req.params.id,
        propertyId: req.operator.property_id,
        initiatedByUserId: req.operator.id,
        intendedRecipientPersonId: body.intended_recipient_person_id || null,
        acknowledgePriorReview: body.acknowledge_prior_review === true,
      });
      return res.status(201).json({
        meeting: out.meeting,
        transcript: out.transcript,
        extraction_attempt: out.extraction_attempt,
        extraction_outcome: out.extraction_outcome,
        extraction_run: out.extraction.run,
        receipt: out.receipt,
        rendered: out.rendered,
        reissue: out.reissue,
      });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.get("/operator/meeting-evidence/receipts/:id", ...gate, async (req, res) => {
    try {
      return res.json(await receipts.loadReceiptForProperty(pool, {
        receiptId: req.params.id,
        propertyId: req.operator.property_id,
      }));
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/receipts/:id/manual-edits", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const edit = await receipts.appendManualEditForReceipt(pool, {
        receiptId: req.params.id,
        propertyId: req.operator.property_id,
        editedByUserId: req.operator.id,
        editSource: "manual_preview",
        fieldName: body.field_name,
        humanText: body.human_text,
        changeNote: body.change_note || null,
      });
      return res.status(201).json({ edit });
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/receipts/:id/sent", ...gate, async (req, res) => {
    try {
      const body = req.body || {};
      const sent = await receipts.recordManualSend(pool, {
        receiptId: req.params.id,
        propertyId: req.operator.property_id,
        markedByUserId: req.operator.id,
        sentSubject: body.sent_subject,
        sentBody: body.sent_body,
        sentChannelNote: body.sent_channel_note || null,
      });
      return res.json(sent);
    } catch (err) {
      return mapError(res, err);
    }
  });

  router.post("/operator/meeting-evidence/receipts/:id/feedback", ...gate, async (req, res) => {
    try {
      await receipts.loadReceiptForProperty(pool, {
        receiptId: req.params.id,
        propertyId: req.operator.property_id,
      });
      const body = req.body || {};
      const feedback = await receipts.recordReceiptFeedback(pool, {
        feedbackKind: body.feedback_kind,
        receiptId: req.params.id,
        receiptItemId: body.receipt_item_id || null,
        candidateId: body.candidate_id || null,
        description: body.description || null,
        supportingSegmentIds: body.supporting_segment_ids || [],
        reviewSource: "direct_review",
        reviewerUserId: req.operator.id,
        note: body.note || null,
      });
      return res.status(201).json(feedback);
    } catch (err) {
      return mapError(res, err);
    }
  });

  return router;
}

module.exports = {
  operatorRoutes,
  readAiWebhook,
  readAiWebhookErrorHandler,
};
