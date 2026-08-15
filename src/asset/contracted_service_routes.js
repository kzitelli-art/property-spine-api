"use strict";

const EVIDENCE_KINDS = Object.freeze([
  "contracted_service_proposal", "contracted_service_agreement",
  "contracted_service_statement_of_work", "contracted_service_amendment",
  "contracted_service_addendum", "contracted_service_renewal_notice",
  "contracted_service_termination_notice", "contracted_service_invoice",
  "contracted_service_certificate_of_insurance", "contracted_service_service_report",
  "contracted_service_accounting_report", "contracted_service_other",
]);

module.exports = function contractedServiceRoutes(deps = {}) {
  const express = require("express");
  const multer = require("multer");
  const router = express.Router();

  const positionRead = deps.positionRead || require("./contracted_service_position_read.js");
  const services = deps.contractedService || require("./contracted_service_service.js");
  const artifacts = deps.artifacts || require("../onboarding/source_artifact_service.js");
  const documentRead = deps.documentRead || require("./contracted_service_document_read.js");
  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule, fileToText,
  } = deps;
  if (!pool) throw new Error("contracted_service_routes requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`contracted_service_routes requires ${name}`);
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  function fail(res, error) {
    const sayable = new Set([
      "BAD_INPUT", "NOT_FOUND", "SOURCE_REQUIRED", "SOURCE_NOT_FOUND",
      "SOURCE_SCOPE_MISMATCH", "PROVENANCE_REQUIRED", "REVISION_REASON_REQUIRED",
      "EXECUTED_GOVERNING_SOURCE_REQUIRED",
    ]);
    if (error && sayable.has(error.code)) {
      const status = error.code === "NOT_FOUND" || error.code === "SOURCE_NOT_FOUND" ? 404 : 422;
      return res.status(status).json({ error: error.code, receipt: error.message });
    }
    console.error("contracted service route failed", error);
    return res.status(500).json({ error: "contracted_service_write_failed" });
  }

  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      try { await client.query("rollback"); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  function canonicalInput(req, supplied = req.body || {}) {
    return {
      ...supplied,
      property_id: req.operator.property_id,
      user_id: req.operator.id,
    };
  }

  router.get("/operator/asset-management/contracted-services", ...gate, async (req, res) => {
    const requested = String((req.query && req.query.as_of) || "");
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : null;
    let client;
    try {
      client = await pool.connect();
      const position = await positionRead.readPosition(client, {
        property_id: req.operator.property_id,
        as_of: asOf,
      });
      return res.json({ property_id: req.operator.property_id, ...position });
    } catch (error) {
      console.error("operator/asset-management/contracted-services read failed", error);
      return res.status(503).json({ error: "contracted_services_compartment_unavailable" });
    } finally {
      if (client) client.release();
    }
  });

  const uploadOne = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: artifacts.MAX_BYTES, files: 1 },
  }).single("file");

  function acceptFile(req, res, next) {
    uploadOne(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "file_too_large",
          receipt: "That file is over 25 MB. Upload the service document on its own.",
        });
      }
      return res.status(400).json({ error: "upload_failed", receipt: error.message });
    });
  }

  router.post("/operator/asset-management/contracted-services/evidence",
    requireOperator, acceptFile, refuseClientAuthority, requireAssetManagementModule,
    async (req, res) => {
      const kind = String((req.body && req.body.artifact_kind) || "contracted_service_agreement");
      if (!EVIDENCE_KINDS.includes(kind)) {
        return res.status(422).json({
          error: "unsupported_artifact_kind",
          receipt: `"${kind}" is not Contracted Services evidence Spine retains.`,
        });
      }
      if (!req.file) {
        return res.status(400).json({
          error: "no_file",
          receipt: "Choose the proposal, agreement, amendment, notice, invoice, or service evidence.",
        });
      }
      try {
        const stored = await artifacts.store(pool, {
          scope_type: "property",
          scope_id: req.operator.property_id,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
          uploaded_by_user_id: req.operator.id,
          authority_basis: "asset_management_module",
          artifact_kind: kind,
        });
        const storedKind = stored.artifact_kind || kind;
        let proposal = {
          available: false, authority: "proposal_only", fields: {}, term: {},
          price_components: [], scope: {}, unknown: [], source: "none",
          warnings: ["Spine retained this document but has not read it. Confirm only what it states."],
        };
        if (typeof fileToText === "function") {
          try {
            const text = await fileToText({
              buffer: req.file.buffer,
              mimetype: req.file.mimetype,
              originalname: req.file.originalname,
            });
            proposal = documentRead.propose(text, storedKind);
          } catch (scanError) {
            console.error("contracted service document scan failed (document retained)", scanError);
          }
        }
        return res.status(stored.deduplicated ? 200 : 201).json({
          artifact: {
            id: stored.id,
            filename: stored.original_filename,
            artifact_kind: storedKind,
            deduplicated: !!stored.deduplicated,
          },
          proposal,
          receipt: stored.receipt
            || `${stored.original_filename} is on file. Recognized facts still require confirmation.`,
        });
      } catch (error) {
        if (error && error.artifactRefusal) {
          return res.status(422).json({ error: error.reason, receipt: error.message });
        }
        return fail(res, error);
      }
    });

  router.get("/operator/asset-management/contracted-services/evidence/:artifactId", ...gate,
    async (req, res) => {
      try {
        const artifact = await artifacts.read(pool, req.params.artifactId);
        if (!artifact || artifact.scope_type !== "property"
            || String(artifact.scope_id) !== String(req.operator.property_id)) {
          return res.status(404).json({ error: "contracted_service_evidence_not_found" });
        }
        const filename = String(artifact.original_filename || "contracted-service-evidence")
          .replace(/["\r\n]/g, "_");
        res.set("Cache-Control", "private, no-store");
        res.set("Content-Disposition", `inline; filename="${filename}"`);
        res.type(artifact.mime_type || "application/octet-stream");
        return res.send(artifact.content);
      } catch (error) {
        console.error("contracted service evidence read failed", error);
        return res.status(503).json({ error: "contracted_service_evidence_unavailable" });
      }
    });

  function write(path, method, receipt) {
    router.post(path, ...gate, async (req, res) => {
      try {
        const record = await inTransaction((client) =>
          services[method](client, canonicalInput(req)));
        return res.status(201).json({ record, receipt });
      } catch (error) {
        return fail(res, error);
      }
    });
  }

  router.get("/operator/asset-management/contracted-services/provider-candidates", ...gate,
    async (req, res) => {
      let client;
      try {
        client = await pool.connect();
        const candidates = await services.findProviderCandidates(client, {
          provider_name: req.query && req.query.name,
        });
        return res.json({ candidates });
      } catch (error) {
        return fail(res, error);
      } finally {
        if (client) client.release();
      }
    });

  /* One operator confirmation, composed only from canonical append-only writers. */
  router.post("/operator/asset-management/contracted-services/confirm", ...gate,
    async (req, res) => {
      const body = req.body || {};
      try {
        const records = await inTransaction(async (client) => {
          const base = {
            property_id: req.operator.property_id,
            user_id: req.operator.id,
            source_artifact_id: body.source_artifact_id || null,
            provenance_note: body.provenance_note || null,
          };
          const hasEngagementTruth = body.provider || body.provider_id || body.engagement
            || body.document || body.term || body.scope || (body.price_components || []).length;
          if (body.requirement
              && body.requirement.determination !== "contracted_service_required"
              && hasEngagementTruth) {
            throw services.contractedServiceError("BAD_INPUT",
              "a service established as in-house or not applicable cannot carry a contractor engagement");
          }

          const coverageReview = body.coverage_review
            ? await services.recordCoverageReview(client, { ...body.coverage_review, ...base }) : null;
          const requirement = body.requirement
            ? await services.recordRequirement(client, { ...body.requirement, ...base }) : null;
          let provider = null;
          if (body.provider && body.provider.provider_name) {
            provider = await services.establishProvider(client, { ...body.provider, ...base });
          } else if (body.provider_id) {
            provider = { id: body.provider_id };
          }

          let engagement = null;
          if (hasEngagementTruth) {
            if (!provider || !provider.id) {
              throw services.contractedServiceError("BAD_INPUT",
                "select or establish a provider before confirming a service engagement");
            }
            engagement = await services.createEngagement(client, {
              ...(body.engagement || {}), ...base,
              service_class: (body.engagement && body.engagement.service_class)
                || (body.requirement && body.requirement.service_class),
              service_label: (body.engagement && body.engagement.service_label)
                || (body.requirement && body.requirement.service_label) || null,
              provider_id: provider.id,
              effective_from: (body.engagement && body.engagement.effective_from)
                || (body.requirement && body.requirement.effective_from) || null,
            });
          }

          const document = body.document ? await services.confirmDocument(client, {
            ...body.document, ...base,
            source_artifact_id: body.document.source_artifact_id || base.source_artifact_id,
            engagement_id: engagement && engagement.id,
          }) : null;
          const term = body.term ? await services.recordTerm(client, {
            ...body.term, ...base,
            engagement_id: engagement && engagement.id,
            document_id: body.term.document_id || (document && document.id),
          }) : null;
          const scope = body.scope ? await services.recordScope(client, {
            ...body.scope, ...base,
            engagement_id: engagement && engagement.id,
            term_id: body.scope.term_id || (term && term.id) || null,
          }) : null;
          const prices = [];
          for (const component of body.price_components || []) {
            prices.push(await services.recordPriceComponent(client, {
              ...component, ...base,
              term_id: component.term_id || (term && term.id),
            }));
          }
          return { coverage_review: coverageReview, requirement, provider, engagement,
            document, term, scope, price_components: prices };
        });
        return res.status(201).json({
          records,
          receipt: "Contracted service facts recorded from the operator-confirmed evidence.",
        });
      } catch (error) {
        return fail(res, error);
      }
    });

  write("/operator/asset-management/contracted-services/coverage-reviews", "recordCoverageReview",
    "Property service coverage review recorded.");
  write("/operator/asset-management/contracted-services/requirements", "recordRequirement",
    "Service delivery requirement recorded.");
  write("/operator/asset-management/contracted-services/providers", "establishProvider",
    "Contracted-service provider identity recorded.");
  write("/operator/asset-management/contracted-services/engagements", "createEngagement",
    "Property service engagement recorded.");
  write("/operator/asset-management/contracted-services/documents", "confirmDocument",
    "Document classification and execution state confirmed separately.");
  write("/operator/asset-management/contracted-services/terms", "recordTerm",
    "Service terms recorded with their stated authority.");
  write("/operator/asset-management/contracted-services/scopes", "recordScope",
    "Contracted scope recorded.");
  write("/operator/asset-management/contracted-services/locations", "recordLocation",
    "Contracted service location recorded.");
  write("/operator/asset-management/contracted-services/prices", "recordPriceComponent",
    "Contract price component recorded separately from accounting actuals.");
  write("/operator/asset-management/contracted-services/financial-observations",
    "recordFinancialObservation",
    "Financial observation recorded without establishing agreement or payment.");
  write("/operator/asset-management/contracted-services/decision-links", "linkDecision",
    "Contract decision linked to its accountable obligation.");

  return router;
};

module.exports.EVIDENCE_KINDS = EVIDENCE_KINDS;
