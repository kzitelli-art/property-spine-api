"use strict";

const artifacts = require("../onboarding/source_artifact_service.js");
const evidenceIntake = require("./compliance_evidence_intake.js");
const documentRead = require("./compliance_document_read.js");
const reads = require("./compliance_read.js");
const { createComplianceWriter, CompliancePersistenceError } =
  require("./compliance_persistence.js");
const { createComplianceFactWriter } = require("./compliance_fact_persistence.js");
const { createComplianceReferenceService, ComplianceReferenceError } =
  require("./compliance_references.js");

function isoDate(value) {
  const text = value === undefined || value === null || value === ""
    ? new Date().toISOString().slice(0, 10) : String(value);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== text) {
    const error = new TypeError("as_of must be a real ISO date");
    error.code = "BAD_AS_OF";
    throw error;
  }
  return text;
}

function safeFilename(value) {
  return String(value || "compliance-source")
    .replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "compliance-source";
}

module.exports = function complianceHttp(deps = {}) {
  const express = require("express");
  const multer = require("multer");
  const router = express.Router();
  const {
    pool, fileToText, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  } = deps;
  if (!pool) throw new Error("compliance_http requires a pool");
  for (const [name, fn] of Object.entries({
    fileToText, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`compliance_http requires ${name}`);
  }

  const references = deps.referenceService || createComplianceReferenceService({
    // A configured key lets references survive process restarts and work across
    // instances. Without one they intentionally last only for this process.
    secret: deps.referenceSecret || process.env.COMPLIANCE_REFERENCE_SECRET,
  });
  if (typeof references.mintReference !== "function" ||
      typeof references.openReference !== "function") {
    throw new Error("compliance_http requires a complete reference service");
  }
  const writer = createComplianceWriter({
    readProposal: async ({ artifact }) => {
      const text = await fileToText({
        originalname: artifact.original_filename,
        mimetype: artifact.mime_type,
        buffer: artifact.content,
      });
      return documentRead.propose(text);
    },
  });
  const factWriter = createComplianceFactWriter();
  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];
  const uploadOne = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: artifacts.MAX_BYTES, files: 1 },
  }).single("file");

  function acceptEvidenceFile(req, res, next) {
    uploadOne(req, res, (error) => {
      if (!error) return next();
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file_too_large", receipt: "That file is over 25 MB." });
      }
      return res.status(400).json({ error: "upload_failed", receipt: error.message });
    });
  }
  const multipartGate = [
    requireOperator, acceptEvidenceFile, refuseClientAuthority, requireAssetManagementModule,
  ];

  function authority(req) {
    return {
      property_id: String(req.operator.property_id),
      actor_user_id: String(req.operator.id),
    };
  }

  function unavailable(res, error, operation) {
    if (error instanceof ComplianceReferenceError) {
      return res.status(404).json({ error: "opener_unavailable" });
    }
    if (error instanceof CompliancePersistenceError) {
      const hidden = new Set(["ITEM_OUT_OF_SCOPE", "ARTIFACT_OUT_OF_SCOPE"]);
      if (hidden.has(error.code)) return res.status(404).json({ error: "not_found" });
      return res.status(error.status || 422).json({
        error: String(error.code || "confirmation_refused").toLowerCase(),
        receipt: error.message,
      });
    }
    if (error instanceof TypeError || (error && error.code === "BAD_AS_OF")) {
      return res.status(422).json({ error: "invalid_request", receipt: error.message });
    }
    console.error(`compliance ${operation} failed`, error);
    return res.status(503).json({ error: "read_failed" });
  }

  async function confirm(req, res) {
    try {
      const receipt = await writer.establishCredentialPeriod(pool, {
        authority: authority(req),
        existing_item_id: req.params.itemId || null,
        confirmation: req.body,
      });
      return res.status(receipt.outcome === "established" ? 201 : 200).json(receipt);
    } catch (error) {
      return unavailable(res, error, "confirmation");
    }
  }

  router.post("/operator/asset-management/compliance/confirm", ...gate, confirm);
  router.post("/operator/asset-management/compliance/items/:itemId/confirm", ...gate, confirm);

  router.post("/operator/asset-management/compliance/facts", ...gate, async (req, res) => {
    try {
      const receipt = await factWriter.establishFact(pool, {
        authority: authority(req),
        confirmation: req.body,
      });
      return res.status(receipt.outcome === "established" ? 201 : 200).json(receipt);
    } catch (error) {
      return unavailable(res, error, "fact confirmation");
    }
  });

  router.post("/operator/asset-management/compliance/evidence", ...multipartGate,
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: "no_file", receipt: "Choose a Compliance document." });
      }
      try {
        const intake = await evidenceIntake.retainAndRecognize(pool, {
          authorized_property_id: String(req.operator.property_id),
          authenticated_user_id: String(req.operator.id),
          authority_basis: "asset_management_module",
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
          extractText: async (buffer) => fileToText({
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            buffer,
          }),
        });
        const item_relationship = intake.proposal
          ? await reads.proposeExistingItemRelationship(pool, {
              property_id: String(req.operator.property_id), proposal: intake.proposal,
            })
          : null;
        return res.status(201).json({ intake, item_relationship });
      } catch (error) {
        return unavailable(res, error, "evidence intake");
      }
    });

  router.get("/operator/asset-management/compliance", ...gate, async (req, res) => {
    try {
      const standing = await reads.readComplianceStanding(pool, {
        property_id: String(req.operator.property_id),
        as_of: isoDate(req.query.as_of),
        mintReference: references.mintReference,
      });
      return res.json(standing);
    } catch (error) {
      return unavailable(res, error, "standing read");
    }
  });

  router.get("/operator/asset-management/compliance/items/:itemId", ...gate, async (req, res) => {
    try {
      const detail = await reads.readComplianceDetail(pool, {
        property_id: String(req.operator.property_id),
        item_id: req.params.itemId,
        as_of: isoDate(req.query.as_of),
        mintReference: references.mintReference,
      });
      if (!detail) return res.status(404).json({ error: "not_found" });
      return res.json(detail);
    } catch (error) {
      return unavailable(res, error, "detail read");
    }
  });

  function claimsFor(req, role) {
    const claims = references.openReference(req.params.token);
    if (claims.role !== role || String(claims.property_id) !== String(req.operator.property_id)) {
      throw new ComplianceReferenceError("REFERENCE_UNAVAILABLE", "Reference scope mismatch");
    }
    return claims;
  }

  router.get("/operator/asset-management/compliance/open/record/:token", ...gate,
    async (req, res) => {
      try {
        const claims = claimsFor(req, "canonical_record");
        const detail = await reads.readComplianceDetail(pool, {
          property_id: String(req.operator.property_id),
          item_id: claims.resource_id,
          as_of: isoDate(req.query.as_of),
          mintReference: references.mintReference,
        });
        if (!detail) return res.status(404).json({ error: "not_found" });
        return res.json(detail);
      } catch (error) {
        return unavailable(res, error, "record opener");
      }
    });

  router.get("/operator/asset-management/compliance/open/source/:token", ...gate,
    async (req, res) => {
      try {
        const claims = claimsFor(req, "source_artifact");
        const artifact = await artifacts.read(pool, claims.resource_id);
        if (!artifact || artifact.scope_type !== "property" ||
            String(artifact.scope_id) !== String(req.operator.property_id)) {
          return res.status(404).json({ error: "not_found" });
        }
        if (!Buffer.isBuffer(artifact.content)) {
          return res.status(410).json({ error: "source_unavailable" });
        }
        res.set({
          "Content-Type": artifact.mime_type || "application/octet-stream",
          "Content-Length": String(artifact.content.length),
          "Content-Disposition": `inline; filename="${safeFilename(artifact.original_filename)}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        return res.send(artifact.content);
      } catch (error) {
        return unavailable(res, error, "source opener");
      }
    });

  return router;
};

module.exports.isoDate = isoDate;
module.exports.safeFilename = safeFilename;
