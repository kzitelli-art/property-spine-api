/* ════════════════════════════════════════════════════════════════════
   tax_funding.js — the HTTP seam for how a tax is paid for.

   Its own module, mounted by the Asset Management surface behind that
   door's authority. It is NOT part of tax_establishment.js, and that is
   structural rather than tidy: establishment is in the economic chain,
   and `gate_funding_boundary.js` fails the build if an economic file
   imports funding. Putting these routes beside the establish route would
   break the wall the moment it was written.

   The surface can hold both because a surface is the composition point,
   not the economic chain.

   ── EVERY WRITE HERE ANSWERS "IS THE TAX PAID?" WITH "NOT FROM THIS" ─
   Recording an escrow, a balance, or a servicer's disbursement changes
   nothing about what is owed, whether a return was filed, or whether the
   City was paid. Each response says so explicitly rather than leaving a
   caller to infer it from silence.

   Authority middleware is INJECTED, never re-implemented — two copies of
   an authority rule is a §17 defect even while the copies agree.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

module.exports = function taxFunding(deps) {
  const express = require("express");
  const router = express.Router();

  const funding = require("./tax_funding_service.js");
  const fundingRead = require("./tax_funding_read.js");
  const rules = require("./philadelphia_tax_rules.js");
  //  ONE statement of "which entities does this property reach", shared
  //  with the economic seam. A second copy here would be a §17 defect the
  //  day either side changed, and it is exactly the rule that decides
  //  whether an operator may write a BIRT record at all.
  const entities = require("../entity/legal_entity_service.js");

  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
  } = deps || {};
  if (!pool) throw new Error("tax_funding requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`tax_funding requires ${name}`);
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  function fail(res, e) {
    const SAYABLE = new Set([
      "BAD_INPUT", "NOT_FOUND", "PROVENANCE_REQUIRED", "REASON_REQUIRED",
      "SUBJECT_REQUIRED", "WRONG_SUBJECT", "CORRECTION_REQUIRED",
      "DIRECT_HAS_NO_ESCROW", "ESCROW_HOLDER_REQUIRED", "NOT_AN_ESCROW",
      "ALREADY_OBSERVED", "OBLIGATION_MISMATCH",
    ]);
    if (e && SAYABLE.has(e.code)) {
      return res.status(e.code === "NOT_FOUND" ? 404 : 422)
        .json({ error: e.code, receipt: e.message });
    }
    console.error("tax funding write failed", e);
    return res.status(500).json({ error: "tax_funding_write_failed" });
  }

  /*  ── WHOSE ARRANGEMENT MAY THIS OPERATOR TOUCH? ───────────────────
   *  Authentication answers WHO may call a route. It does not answer
   *  WHOSE record they may write. A property-subject arrangement must be
   *  this property's; an entity-subject arrangement must belong to an
   *  entity related to this property today.
   */
  async function reachableEntityIds(client, propertyId, today) {
    const live = await entities.readForProperty(client,
      { property_id: propertyId, as_of: today });
    return live.map((e) => e.legal_entity_id);
  }

  async function reachableArrangement(client, arrangementId, propertyId, today) {
    const ids = await reachableEntityIds(client, propertyId, today);
    const { rows } = await client.query(
      `select a.* from tax_funding_arrangements a
        where a.id = $1
          and (a.subject_property_id = $2
               or a.subject_legal_entity_id = any($3::uuid[]))`,
      [arrangementId, propertyId, ids]);
    return rows[0] || null;
  }

  /*  An entity-subject write must name an entity this property actually
   *  reaches. Without this an operator at one property could record
   *  funding against any entity in the database — authentication answers
   *  WHO may call the route, never WHOSE record they may write. */
  async function entityReachable(client, entityId, propertyId, today) {
    return (await reachableEntityIds(client, propertyId, today)).includes(entityId);
  }

  const todayISO = () => funding.isoDay(new Date());

  /*  ══ POST …/taxes/funding/evidence ════════════════════════════════
   *  Retain a servicer escrow statement or analysis.
   *
   *  ITS OWN ROUTE, ON THIS SIDE OF THE WALL. The establishment module
   *  has an evidence route already; reusing it would put funding
   *  documents through economic code for the sake of two lines.
   */
  const multer = require("multer");
  const artifacts = require("../onboarding/source_artifact_service.js");
  const FUNDING_EVIDENCE_KINDS = Object.freeze([
    "tax_escrow_statement", "tax_escrow_analysis",
  ]);

  const uploadOne = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: artifacts.MAX_BYTES, files: 1 },
  }).single("file");

  //  Multer FIRST, then authority — `req.body` does not exist before it,
  //  so the ordinary gate order would read undefined and silently IGNORE
  //  a body property_id instead of refusing it. Identity still comes
  //  first: an unauthenticated caller never reaches the parser.
  function acceptFile(req, res, next) {
    uploadOne(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "file_too_large",
          receipt: "That file is over 25 MB. Upload the statement on its own." });
      }
      return res.status(400).json({ error: "upload_failed", receipt: err.message });
    });
  }

  router.post("/operator/asset-management/taxes/funding/evidence",
    requireOperator, acceptFile, refuseClientAuthority, requireAssetManagementModule,
    async (req, res) => {
      const kind = String((req.body && req.body.artifact_kind) || "tax_escrow_statement");
      if (!FUNDING_EVIDENCE_KINDS.includes(kind)) {
        return res.status(422).json({ error: "unsupported_artifact_kind",
          receipt: `Tax funding evidence is an escrow statement or an escrow analysis. ` +
                   `"${kind}" is neither.` });
      }
      if (!req.file) {
        return res.status(400).json({ error: "no_file",
          receipt: "Choose the escrow statement or analysis to upload." });
      }
      try {
        const stored = await artifacts.store(pool, {
          scope_type: "property",
          //  SERVER-DERIVED, never a body field.
          scope_id: req.operator.property_id,
          filename: req.file.originalname, mimetype: req.file.mimetype,
          buffer: req.file.buffer, uploaded_by_user_id: req.operator.id,
          authority_basis: "asset_management_module", artifact_kind: kind,
        });
        return res.status(stored.deduplicated ? 200 : 201).json({
          artifact: { id: stored.id, filename: stored.original_filename,
                      //  THE STORED KIND, not the requested one. Dedup resolves by
                      //  bytes, and the kind on file wins.
                      artifact_kind: stored.artifact_kind || kind,
                      deduplicated: !!stored.deduplicated },
          receipt: stored.receipt ||
            `${stored.original_filename} is on file. A statement on file does not yet say ` +
            `how anything is paid, and it never says a bill was paid — confirm the ` +
            `arrangement next.`,
        });
      } catch (e) {
        if (e && e.artifactRefusal) {
          return res.status(422).json({ error: e.reason, receipt: e.message });
        }
        return fail(res, e);
      }
    });

  /*  ══ POST …/taxes/funding ═════════════════════════════════════════
   *  Record how a tax is funded. Nothing written here can change what is
   *  owed or the monthly accrual — the position read derives both from
   *  the governed liability and cannot see this table.
   */
  router.post("/operator/asset-management/taxes/funding", ...gate, async (req, res) => {
    const propertyId = req.operator.property_id;
    const b = req.body || {};
    const today = todayISO();

    if (!rules.TAX_TYPES.includes(b.tax_type)) {
      return res.status(422).json({ error: "tax_type_required",
        receipt: `Recording funding needs the tax it pays. One of: ` +
                 `${rules.TAX_TYPES.map((t) => rules.TAX_LABEL[t]).join(", ")}.` });
    }

    const kind = rules.SUBJECT_KIND[b.tax_type];
    let entityId = null;
    if (kind === "legal_entity") {
      entityId = b.legal_entity_id || null;
      if (!entityId) {
        return res.status(422).json({ error: "SUBJECT_REQUIRED",
          receipt: `${rules.TAX_LABEL[b.tax_type]} is owed by the taxpayer — name the ` +
                   `legal entity whose funding this is.` });
      }
    }

    let client;
    try {
      client = await pool.connect();
      if (entityId && !(await entityReachable(client, entityId, propertyId, today))) {
        return res.status(403).json({ error: "entity_not_related",
          receipt: "That legal entity is not related to this property, so funding for it " +
                   "cannot be recorded from here." });
      }

      await client.query("begin");
      const arr = await funding.openArrangement(client, {
        tax_type: b.tax_type,
        //  SERVER-DERIVED. The gate middleware already refused a
        //  mismatched body property_id outright.
        property_id: kind === "property" ? propertyId : null,
        legal_entity_id: entityId,
        funding_method: b.funding_method,
        effective_from: b.effective_from,
        effective_to: b.effective_to || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        escrow: b.escrow || null,
        user_id: req.operator.id,
      });
      await client.query("commit");

      const now = await fundingRead.readTaxFunding(client, { property_id: propertyId });
      return res.status(201).json({
        arrangement_id: arr.id,
        funding: now,
        //  ⚠ SAID EXPLICITLY, EVERY TIME. Two separate claims, because
        //  they are the two mistakes this domain exists to prevent.
        tax_liability_changed: false,
        tax_payment_recorded: false,
        receipt: `Funding recorded for ${rules.TAX_LABEL[arr.tax_type]}: ` +
                 `${fundingRead.METHOD_LABEL[arr.funding_method]}. What the City says is ` +
                 `owed is unchanged, and nothing here says a bill was paid.`,
      });
    } catch (e) {
      if (client) { try { await client.query("rollback"); } catch (_) {} }
      return fail(res, e);
    } finally {
      if (client) client.release();
    }
  });

  /*  ══ POST …/taxes/funding/:id/correct ═════════════════════════════
   *  Restate a claim that was wrong. A servicer RAISING the contribution
   *  is not this — that is the world changing, and it opens a new
   *  arrangement so last year's cash stays explainable.
   */
  router.post("/operator/asset-management/taxes/funding/:id/correct", ...gate,
    async (req, res) => {
      const b = req.body || {};
      let client;
      try {
        client = await pool.connect();
        const owns = await reachableArrangement(
          client, req.params.id, req.operator.property_id, todayISO());
        if (!owns) {
          return res.status(404).json({ error: "arrangement_not_found",
            receipt: "That funding arrangement is not reachable from this property." });
        }

        await client.query("begin");
        const arr = await funding.correctArrangement(client, {
          arrangement_id: req.params.id,
          funding_method: b.funding_method || null,
          revision_reason: b.revision_reason,
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          escrow: b.escrow || null,
          user_id: req.operator.id,
        });
        await client.query("commit");

        const now = await fundingRead.readTaxFunding(client,
          { property_id: req.operator.property_id });
        return res.status(201).json({
          arrangement_id: arr.id,
          superseded_id: req.params.id,
          funding: now,
          tax_liability_changed: false,
          tax_payment_recorded: false,
          receipt: "Funding corrected. The earlier claim is preserved and still readable.",
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });

  /*  ══ POST …/taxes/funding/:id/balance ═════════════════════════════
   *  What the statement said, on a day. An observation, not a term.
   */
  router.post("/operator/asset-management/taxes/funding/:id/balance", ...gate,
    async (req, res) => {
      const b = req.body || {};
      let client;
      try {
        client = await pool.connect();
        const owns = await reachableArrangement(
          client, req.params.id, req.operator.property_id, todayISO());
        if (!owns) {
          return res.status(404).json({ error: "arrangement_not_found",
            receipt: "That escrow is not reachable from this property." });
        }

        await client.query("begin");
        const obs = await funding.recordEscrowObservation(client, {
          arrangement_id: req.params.id,
          observed_on: b.observed_on,
          balance_cents: b.balance_cents,
          currency_code: b.currency_code || "USD",
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          user_id: req.operator.id,
        });
        await client.query("commit");

        const now = await fundingRead.readTaxFunding(client,
          { property_id: req.operator.property_id });
        return res.status(201).json({
          observation_id: obs.id,
          funding: now,
          tax_liability_changed: false,
          tax_payment_recorded: false,
          //  ⚠ THE RECEIPT SAYS THE THING THE NUMBER INVITES SOMEONE TO
          //  ASSUME. A balance over the bill is the single most persuasive
          //  wrong reason to believe a tax is handled.
          receipt: "Escrow balance recorded as of " +
                   `${funding.isoDay(obs.observed_on)}. It shows what the servicer holds — ` +
                   "not that any bill has been paid.",
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });

  /*  ══ POST …/taxes/funding/:id/disbursement ════════════════════════
   *  The servicer says they sent money toward a specific bill.
   *
   *  ⚠ THIS DOES NOT PAY THE BILL. The obligation keeps reading unpaid
   *  until City payment evidence exists, and the read surfaces this
   *  disbursement beside it as the reason someone believed otherwise.
   */
  router.post("/operator/asset-management/taxes/funding/:id/disbursement", ...gate,
    async (req, res) => {
      const b = req.body || {};
      let client;
      try {
        client = await pool.connect();
        const owns = await reachableArrangement(
          client, req.params.id, req.operator.property_id, todayISO());
        if (!owns) {
          return res.status(404).json({ error: "arrangement_not_found",
            receipt: "That escrow is not reachable from this property." });
        }

        await client.query("begin");
        const d = await funding.recordDisbursement(client, {
          arrangement_id: req.params.id,
          obligation_id: b.obligation_id,
          disbursed_on: b.disbursed_on,
          amount_cents: b.amount_cents,
          currency_code: b.currency_code || "USD",
          reference: b.reference || null,
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          user_id: req.operator.id,
        });
        await client.query("commit");

        const now = await fundingRead.readTaxFunding(client,
          { property_id: req.operator.property_id });
        return res.status(201).json({
          disbursement_id: d.id,
          funding: now,
          tax_liability_changed: false,
          tax_payment_recorded: false,
          receipt: "Escrow disbursement recorded. This is the servicer's account of what " +
                   "they sent — the bill stays unpaid in Spine until there is City payment " +
                   "evidence.",
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });

  return router;
};
