// ════════════════════════════════════════════════════════════════════
//  asset_management.js — THE ASSET MANAGEMENT DOOR
//
//  The routes behind Spine's fourth surface. Ownership and asset
//  management will eventually consume what the operating side produces and
//  read it at the DEAL level — performance, reporting, debt, investors,
//  risk, obligations, decisions.
//
//  Tonight it supports exactly one path, end to end:
//
//      Deals → Deal → Properties → Setup → Opening Position
//
//  ── EVERY ROUTE HERE REQUIRES A HUMAN ───────────────────────────────
//  `x-staff-session`, resolved server-side, on all of them. The shared
//  operator key authenticates the CALLER; it is not an actor, and every
//  write on this surface records who did it. There is no route here that
//  reads an actor, an organization or a property id from a request body
//  and believes it.
//
//  ── WHY THE ROUTES ARE THIN ─────────────────────────────────────────
//  Authority, refusals and receipts all live in the services. A route
//  reads the session, calls one service function, and renders what comes
//  back. Anything else here would be a second place where a rule lives.
// ════════════════════════════════════════════════════════════════════

"use strict";

const staffSessions = require("../identity/staff_session_service.js");
const propertyCreation = require("../identity/property_creation_service.js");
const dealService = require("./deal_service.js");
const activation = require("./activation_service.js");
const artifacts = require("./source_artifact_service.js");

module.exports = function assetManagement({ pool, upload }) {
  const express = require("express");
  const router = express.Router();

  if (!pool) throw new Error("asset_management requires a pool");
  if (!upload) throw new Error("asset_management requires the multer upload instance");

  //  ── THE ONLY WAY INTO EVERY ROUTE BELOW ──────────────────────────
  async function requireHuman(req, res, next) {
    try {
      const session = await staffSessions.resolveStaffSession(pool, req.get("x-staff-session"));
      if (!session) {
        return res.status(401).json({
          error: "sign_in_required", reason: "no_authenticated_actor",
          receipt: "Asset Management records who did what, so it needs a signed-in person. " +
                   "The operator key identifies the app, not the human.",
        });
      }
      req.human = session;
      next();
    } catch (e) {
      //  Unavailable must never collapse into permitted.
      return res.status(503).json({ error: "identity_unavailable",
        receipt: "Could not establish who is acting. Refused." });
    }
  }

  //  Body actor fields are REJECTED, not ignored (frozen in PR #38). A
  //  stale client that keeps sending one believes it is honoured; saying
  //  so is the only way it ever gets fixed.
  const BODY_ACTOR_FIELDS = ["confirmed_by", "promoted_by", "established_by",
                             "actor_user_id", "user_id", "uploaded_by", "added_by_user_id"];
  function rejectBodyActor(req, res, next) {
    const found = BODY_ACTOR_FIELDS.filter((f) => req.body && req.body[f] !== undefined);
    if (found.length) {
      return res.status(400).json({
        error: "body_actor_field_rejected", fields: found,
        receipt: `Who is acting comes from the signed-in session, never from the request. ` +
                 `Remove ${found.join(", ")}.`,
      });
    }
    next();
  }

  function fail(res, e) {
    if (e && e.httpStatus) {
      return res.status(e.httpStatus).json({
        error: e.reason || "refused", reason: e.reason, receipt: e.receipt || e.message,
        ...(e.current_deal_id ? { current_deal_id: e.current_deal_id } : {}),
        ...(e.columns ? { columns: e.columns } : {}),
        ...(e.space_count ? { space_count: e.space_count } : {}),
      });
    }
    if (e && e.artifactRefusal) {
      return res.status(400).json({ error: e.reason, reason: e.reason, receipt: e.receipt });
    }
    //  A refusal from the database is product copy the moment a person can
    //  see it. These arrive with the text the migration wrote.
    if (e && ["restrict_violation", "not_null_violation", "foreign_key_violation"].includes(e.code)) {
      return res.status(409).json({ error: "refused_by_the_record", receipt: e.message, detail: e.detail });
    }
    console.error("asset-management error:", e);
    return res.status(500).json({ error: "unexpected", receipt: e && e.message });
  }

  // ══ DEALS ═══════════════════════════════════════════════════════════

  router.get("/asset/deals", requireHuman, async (req, res) => {
    try {
      const deals = await dealService.listDeals(pool, { user_id: req.human.id });
      res.json({ deals, count: deals.length });
    } catch (e) { fail(res, e); }
  });

  router.post("/asset/deals", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const { deal_name, onboarding_type, organization_id } = req.body || {};
      const deal = await dealService.createDeal(pool, {
        user_id: req.human.id,
        deal_name,
        onboarding_type: onboarding_type || "existing_asset",
        requested_organization_id: organization_id || null,
        creation_source: "asset_management_console",
      });
      res.status(201).json({ deal, receipt: `Deal "${deal.deal_name}" created.` });
    } catch (e) { fail(res, e); }
  });

  router.get("/asset/deals/:dealId", requireHuman, async (req, res) => {
    try {
      const out = await dealService.getDeal(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ══ PROPERTIES ON A DEAL ════════════════════════════════════════════

  //  Create a NEW property straight into the deal. The property itself is
  //  written by the Build 1A canonical service — this route does not
  //  insert into `properties` and must never learn how.
  router.post("/asset/deals/:dealId/properties/new", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const scope = await dealService.resolveDealScope(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId });
      if (!scope.ok) {
        return res.status(scope.status).json({ error: scope.reason, receipt: scope.receipt });
      }
      const { name, address, city, state, zip, property_type, planned_unit_count, leasing_basis } = req.body || {};

      const created = await propertyCreation.createProperty(pool, {
        actor: { user_id: req.human.id },
        organization_id: scope.deal.organization_id,
        name, address, city, state, zip, property_type, planned_unit_count,
        leasing_basis,
        source: "deal_intake",
      });

      const membership = await dealService.addProperty(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId,
        property_id: created.property.id,
        note: "Created from Asset Management while setting up this deal.",
      });

      res.status(201).json({ property: created.property, receipt: membership.receipt });
    } catch (e) { fail(res, e); }
  });

  //  Attach a property that already exists.
  router.post("/asset/deals/:dealId/properties", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const out = await dealService.addProperty(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId,
        property_id: (req.body || {}).property_id, note: (req.body || {}).note || null });
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
  });

  router.delete("/asset/deals/:dealId/properties/:propertyId", requireHuman, async (req, res) => {
    try {
      const out = await dealService.releaseProperty(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId,
        property_id: req.params.propertyId });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  //  Properties this actor may add — their organization's, not already in
  //  a current deal. Scoped so a picker never leaks another client's
  //  portfolio.
  router.get("/asset/deals/:dealId/available-properties", requireHuman, async (req, res) => {
    try {
      const scope = await dealService.resolveDealScope(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId });
      if (!scope.ok) return res.status(scope.status).json({ error: scope.reason, receipt: scope.receipt });

      const rows = (await pool.query(
        `select p.id, p.name, p.display_name, p.address, p.city, p.state
           from properties p
          where p.organization_id = $1
            and not exists (select 1 from deal_intake_properties dp
                             where dp.property_id = p.id and dp.status='current')
          order by p.name nulls last, p.address limit 200`,
        [scope.deal.organization_id])).rows;
      res.json({ properties: rows, count: rows.length });
    } catch (e) { fail(res, e); }
  });

  // ══ THE RETAINED SOURCE FILE ════════════════════════════════════════

  //  STEP 1 of the upload flow: the exact file reaches the server and is
  //  kept. The app parses the same file locally afterwards and sends rows
  //  in step 2 — so the parser is not rewritten server-side merely to
  //  retain the source, and the source is retained anyway.
  const uploadOne = upload.single("file");
  router.post("/asset/deals/:dealId/properties/:propertyId/source", requireHuman, (req, res, next) => {
    uploadOne(req, res, (err) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "file_too_large",
            receipt: "That file is over 25 MB. Export just the rent-roll sheet." });
        }
        return res.status(400).json({ error: "upload_failed", receipt: err.message });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const scope = await activation.resolveActivationScope(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId,
        property_id: req.params.propertyId });
      if (!req.file) {
        return res.status(400).json({ error: "no_file",
          receipt: "Choose the rent roll file to upload." });
      }
      const stored = await artifacts.store(pool, {
        scope_type: "property", scope_id: req.params.propertyId,
        filename: req.file.originalname, mimetype: req.file.mimetype,
        buffer: req.file.buffer,
        uploaded_by_user_id: req.human.id,
        authority_basis: scope.authority_basis,
        source_as_of_date: (req.body && req.body.source_as_of_date) || null,
        artifact_kind: "rent_roll",
      });
      res.status(stored.deduplicated ? 200 : 201).json({
        artifact: {
          id: stored.id, filename: stored.original_filename,
          byte_size: stored.byte_size, uploaded_at: stored.uploaded_at,
        },
        receipt: stored.receipt ||
          `${stored.original_filename} is on file. Spine keeps it so it can always show ` +
          `what this position came from.`,
      });
    } catch (e) { fail(res, e); }
  });

  //  Hand the exact bytes back. This is what makes retention meaningful:
  //  a position can produce the document that established it.
  router.get("/asset/source/:artifactId/download", requireHuman, async (req, res) => {
    try {
      const a = await artifacts.read(pool, req.params.artifactId);
      if (!a) return res.status(404).json({ error: "not_found", receipt: "That file is not on record." });

      //  Scope is checked HERE, against the actor, not inside the storage
      //  service: what a file is and who may see it are different questions.
      if (a.scope_type === "property") {
        const held = (await pool.query(
          `select dp.intake_id from deal_intake_properties dp
            where dp.property_id = $1 and dp.status='current'`, [a.scope_id])).rows[0];
        if (!held) return res.status(403).json({ error: "no_current_deal",
          receipt: "That file's property is not currently on a deal you can open." });
        const scope = await dealService.resolveDealScope(pool, {
          user_id: req.human.id, deal_intake_id: held.intake_id });
        if (!scope.ok) return res.status(scope.status).json({ error: scope.reason, receipt: scope.receipt });
      } else {
        const scope = await dealService.resolveDealScope(pool, {
          user_id: req.human.id, deal_intake_id: a.scope_id });
        if (!scope.ok) return res.status(scope.status).json({ error: scope.reason, receipt: scope.receipt });
      }

      res.setHeader("Content-Type", a.mime_type || "application/octet-stream");
      res.setHeader("Content-Disposition",
        `attachment; filename="${String(a.original_filename).replace(/"/g, "")}"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(a.content);
    } catch (e) { fail(res, e); }
  });

  // ══ ACTIVATION ══════════════════════════════════════════════════════

  router.post("/asset/deals/:dealId/properties/:propertyId/activation",
    requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const out = await activation.openActivation(pool, {
        user_id: req.human.id, deal_intake_id: req.params.dealId,
        property_id: req.params.propertyId,
        source_label: (req.body || {}).source_label || null });
      res.status(out.reopened ? 200 : 201).json(out);
    } catch (e) { fail(res, e); }
  });

  //  STEP 2: the rows the app parsed, plus the artifact they came from.
  router.post("/asset/activations/:activationId/read-source",
    requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const act = (await pool.query("select * from activations where id=$1",
        [req.params.activationId])).rows[0];
      if (!act) return res.status(404).json({ error: "activation_not_found",
        receipt: "That setup is no longer on record." });

      const out = await activation.ingestRentRoll(pool, {
        user_id: req.human.id,
        deal_intake_id: act.deal_id, property_id: act.property_id,
        activation_id: act.id,
        rows: (req.body || {}).rows,
        source_artifact_id: (req.body || {}).source_artifact_id,
        source_as_of_date: (req.body || {}).source_as_of_date || null,
        leasing_basis: (req.body || {}).leasing_basis || null,
        force: Boolean((req.body || {}).force),
      });
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
  });

  router.get("/asset/activations/:activationId", requireHuman, async (req, res) => {
    try {
      const out = await activation.readActivation(pool, {
        user_id: req.human.id, activation_id: req.params.activationId });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  router.post("/asset/proposals/:proposedId/confirm", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const out = await activation.confirmProposal(pool, {
        user_id: req.human.id, proposed_id: req.params.proposedId });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  router.post("/asset/proposals/:proposedId/dismiss", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const out = await activation.rejectProposal(pool, {
        user_id: req.human.id, proposed_id: req.params.proposedId,
        reason: (req.body || {}).reason || null });
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  router.post("/asset/activations/:activationId/establish", requireHuman, rejectBodyActor, async (req, res) => {
    try {
      const out = await activation.establishOpeningPosition(pool, {
        user_id: req.human.id, activation_id: req.params.activationId });
      res.status(201).json(out);
    } catch (e) { fail(res, e); }
  });

  //  The established position, read back. Deliberately references the
  //  canonical state rather than restating it: the counts here are what
  //  was established, and `canonical_units`/`canonical_leases` are what is
  //  true now. Both are shown, because when they differ that IS the news.
  router.get("/asset/properties/:propertyId/opening-position", requireHuman, async (req, res) => {
    try {
      const held = (await pool.query(
        `select intake_id from deal_intake_properties
          where property_id=$1 and status='current'`, [req.params.propertyId])).rows[0];
      if (!held) return res.status(404).json({ error: "no_current_deal",
        receipt: "That property is not currently on a deal." });
      const scope = await dealService.resolveDealScope(pool, {
        user_id: req.human.id, deal_intake_id: held.intake_id });
      if (!scope.ok) return res.status(scope.status).json({ error: scope.reason, receipt: scope.receipt });

      const position = (await pool.query(
        `select op.*, ib.source_file, ib.source_as_of_date as batch_as_of
           from opening_positions op
           left join import_batches ib on ib.id = op.import_batch_id
          where op.property_id = $1 and op.status = 'established'`,
        [req.params.propertyId])).rows[0] || null;
      if (!position) {
        return res.json({ established: false,
          receipt: "No opening position has been established for this property yet." });
      }
      const sources = (await pool.query(
        `select sa.id, sa.original_filename, sa.byte_size, sa.sha256, sa.uploaded_at, ops.role
           from opening_position_sources ops
           join source_artifacts sa on sa.id = ops.source_artifact_id
          where ops.opening_position_id = $1`, [position.id])).rows;
      const live = (await pool.query(
        `select
           (select count(*)::int from units u where u.property_id=$1) as canonical_units,
           (select count(*)::int from leases l where l.property_id=$1 and l.lease_status='active')
             as canonical_active_leases`, [req.params.propertyId])).rows[0];

      res.json({ established: true, position, sources, live });
    } catch (e) { fail(res, e); }
  });

  return router;
};
