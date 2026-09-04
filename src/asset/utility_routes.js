"use strict";

module.exports = function utilityRoutes(deps = {}) {
  const express = require("express");
  const multer = require("multer");
  const router = express.Router();

  const positionRead = deps.positionRead || require("./utility_position_read.js");
  const utilities = deps.utilityService || require("./utility_service.js");
  const artifacts = deps.artifacts || require("../onboarding/source_artifact_service.js");
  const documentRead = deps.documentRead || require("./utility_document_read.js");
  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    fileToText,
  } = deps;
  if (!pool) throw new Error("utility_routes requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`utility_routes requires ${name}`);
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];
  const EVIDENCE_KINDS = Object.freeze([
    "utility_statement", "utility_service_agreement", "utility_addendum",
    "utility_meter_schedule", "utility_account_confirmation",
  ]);

  function fail(res, error) {
    const sayable = new Set([
      "BAD_INPUT", "NOT_FOUND", "SOURCE_REQUIRED", "SOURCE_NOT_FOUND",
      "SOURCE_SCOPE_MISMATCH", "PROVENANCE_REQUIRED", "REVISION_REASON_REQUIRED",
    ]);
    if (error && sayable.has(error.code)) {
      const status = error.code === "NOT_FOUND" || error.code === "SOURCE_NOT_FOUND" ? 404 : 422;
      return res.status(status).json({ error: error.code, receipt: error.message });
    }
    console.error("utility route failed", error);
    return res.status(500).json({ error: "utility_write_failed" });
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

  function canonicalInput(req) {
    return {
      ...(req.body || {}),
      property_id: req.operator.property_id,
      user_id: req.operator.id,
    };
  }

  router.get("/operator/asset-management/utilities", ...gate, async (req, res) => {
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
      console.error("operator/asset-management/utilities read failed", error);
      return res.status(503).json({ error: "utilities_compartment_unavailable" });
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
          receipt: "That file is over 25 MB. Upload the Utility document on its own.",
        });
      }
      return res.status(400).json({ error: "upload_failed", receipt: error.message });
    });
  }

  router.post("/operator/asset-management/utilities/evidence",
    requireOperator, acceptFile, refuseClientAuthority, requireAssetManagementModule,
    async (req, res) => {
      const kind = String((req.body && req.body.artifact_kind) || "utility_statement");
      if (!EVIDENCE_KINDS.includes(kind)) {
        return res.status(422).json({
          error: "unsupported_artifact_kind",
          receipt: `"${kind}" is not Utility evidence Spine retains. Expected one of: ${EVIDENCE_KINDS.join(", ")}.`,
        });
      }
      if (!req.file) {
        return res.status(400).json({
          error: "no_file",
          receipt: "Choose the Utility statement, agreement, addendum, meter schedule, or account confirmation.",
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
          available: false, found_count: 0, fields: {}, unknown: [], associations: {},
          source: "none",
          reason: "Spine retained this document but has not read it. Enter and confirm only what it states.",
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
            console.error("utility document scan failed (document retained)", scanError);
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
            || `${stored.original_filename} is on file. Confirmed facts are recorded separately.`,
        });
      } catch (error) {
        if (error && error.artifactRefusal) {
          return res.status(422).json({ error: error.reason, receipt: error.message });
        }
        return fail(res, error);
      }
    });

  router.get("/operator/asset-management/utilities/evidence/:artifactId", ...gate,
    async (req, res) => {
      try {
        const artifact = await artifacts.read(pool, req.params.artifactId);
        if (!artifact || artifact.scope_type !== "property"
            || String(artifact.scope_id) !== String(req.operator.property_id)) {
          return res.status(404).json({ error: "utility_evidence_not_found" });
        }
        const filename = String(artifact.original_filename || "utility-evidence")
          .replace(/["\r\n]/g, "_");
        res.set("Cache-Control", "private, no-store");
        res.set("Content-Disposition", `inline; filename="${filename}"`);
        res.type(artifact.mime_type || "application/octet-stream");
        return res.send(artifact.content);
      } catch (error) {
        console.error("utility evidence read failed", error);
        return res.status(503).json({ error: "utility_evidence_unavailable" });
      }
    });

  function write(path, serviceMethod, receipt) {
    router.post(path, ...gate, async (req, res) => {
      try {
        const record = await inTransaction((client) =>
          utilities[serviceMethod](client, canonicalInput(req)));
        return res.status(201).json({ record, receipt });
      } catch (error) {
        return fail(res, error);
      }
    });
  }

  /*
   * One human confirmation of one service topology. This is orchestration,
   * not a second writer: every durable fact still passes through the same
   * canonical service functions, inside one transaction.
   */
  router.post("/operator/asset-management/utilities/setup", ...gate,
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
          let service;
          let declaration = null;
          if (body.applicability) {
            const declared = await utilities.declareService(client, {
              ...base,
              service_class: body.service_class,
              service_label: body.service_label || null,
              applicability: body.applicability,
              effective_from: body.effective_from,
              supersedes_id: body.supersedes_id || null,
              revision_reason: body.revision_reason || null,
            });
            service = declared.service;
            declaration = declared.declaration;
          } else {
            service = await utilities.ensureService(client, {
              property_id: base.property_id,
              user_id: base.user_id,
              service_class: body.service_class,
              service_label: body.service_label || null,
            });
          }

          const hasTopology = body.provider || body.provider_id || body.arrangement || body.account
            || body.service_point || body.meter;
          if (body.applicability === "not_applicable" && hasTopology) {
            throw utilities.utilityError("BAD_INPUT",
              "a service established as not applicable cannot carry a provider, arrangement, account, service point, or meter");
          }

          let provider = null;
          if (body.provider && body.provider.provider_name) {
            provider = await utilities.establishProvider(client, {
              ...base,
              provider_name: body.provider.provider_name,
            });
            await utilities.relateProvider(client, {
              ...base,
              service_id: service.id,
              provider_id: provider.id,
              effective_from: body.effective_from,
            });
          } else if (body.provider_id) {
            provider = { id: body.provider_id };
            await utilities.relateProvider(client, {
              ...base,
              service_id: service.id,
              provider_id: provider.id,
              effective_from: body.effective_from,
            });
          }

          const arrangement = body.arrangement
            ? await utilities.recordArrangement(client, {
                ...body.arrangement,
                ...base,
                service_id: service.id,
                supersedes_id: body.arrangement.supersedes_id
                  || (!body.applicability ? body.supersedes_id : null),
                revision_reason: body.arrangement.revision_reason
                  || (!body.applicability ? body.revision_reason : null),
                effective_from: body.arrangement.supersedes_id && body.arrangement.effective_from
                  ? body.arrangement.effective_from : body.effective_from,
              })
            : null;

          let account = null;
          if (body.account) {
            const providerId = body.account.provider_id || (provider && provider.id);
            if (!providerId) {
              throw utilities.utilityError("BAD_INPUT",
                "a provider must be selected before a provider account can be recorded");
            }
            account = await utilities.establishAccount(client, {
              ...body.account,
              ...base,
              provider_id: providerId,
              effective_from: body.effective_from,
            });
            await utilities.link(client, "account_service", {
              ...base,
              left_id: account.id,
              right_id: service.id,
              effective_from: body.effective_from,
            });
          }

          const servicePoint = body.service_point
            ? await utilities.recordServicePoint(client, {
                ...body.service_point,
                ...base,
                service_id: service.id,
                effective_from: body.effective_from,
              })
            : null;

          let meter = null;
          if (body.meter) {
            meter = await utilities.recordMeter(client, {
              ...body.meter,
              ...base,
              provider_id: body.meter.provider_id || (provider && provider.id) || null,
              effective_from: body.effective_from,
            });
          }

          const links = [];
          async function map(kind, leftId, rightId) {
            if (!leftId || !rightId) return;
            links.push(await utilities.link(client, kind, {
              ...base, left_id: leftId, right_id: rightId,
              effective_from: body.effective_from,
            }));
          }
          await map("account_service_point", account && account.id, servicePoint && servicePoint.id);
          await map("meter_service_point", meter && meter.id, servicePoint && servicePoint.id);
          await map("account_meter", account && account.id, meter && meter.id);

          return { service, declaration, provider, arrangement, account, service_point: servicePoint,
            meter, links: links.filter(Boolean) };
        });
        return res.status(201).json({
          records,
          receipt: "Utility setup recorded from the confirmed service, responsibility, account, and meter facts.",
        });
      } catch (error) {
        return fail(res, error);
      }
    });

  write("/operator/asset-management/utilities/services", "declareService",
    "Utility service applicability recorded from the confirmed evidence.");
  write("/operator/asset-management/utilities/providers", "establishProvider",
    "Utility provider recorded for this property.");
  write("/operator/asset-management/utilities/provider-relationships", "relateProvider",
    "Provider relationship recorded for this Utility service.");
  write("/operator/asset-management/utilities/arrangements", "recordArrangement",
    "Utility billing, responsibility, and recovery arrangement recorded as separate facts.");
  write("/operator/asset-management/utilities/accounts", "establishAccount",
    "Provider account recorded for this property.");
  write("/operator/asset-management/utilities/service-points", "recordServicePoint",
    "Utility service point recorded for this property.");
  write("/operator/asset-management/utilities/meters", "recordMeter",
    "Utility meter recorded without assuming an account or unit relationship.");
  write("/operator/asset-management/utilities/statements", "recordStatement",
    "Utility statement recorded. Provider payment remains not established.");

  router.post("/operator/asset-management/utilities/relationships", ...gate,
    async (req, res) => {
      try {
        const input = canonicalInput(req);
        const kind = input.kind;
        delete input.kind;
        const record = await inTransaction((client) => utilities.link(client, kind, input));
        return res.status(201).json({
          record,
          receipt: "Utility map relationship recorded from the confirmed evidence.",
        });
      } catch (error) {
        return fail(res, error);
      }
    });

  return router;
};

module.exports.EVIDENCE_KINDS = Object.freeze([
  "utility_statement", "utility_service_agreement", "utility_addendum",
  "utility_meter_schedule", "utility_account_confirmation",
]);
