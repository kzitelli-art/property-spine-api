/* ════════════════════════════════════════════════════════════════════
   tax_establishment.js — the HTTP seam for establishing governed tax
   truth: what applies, what is owed, what was filed, what was paid.

   ── IT IS IN THE ECONOMIC CHAIN, AND IT MAY NOT REACH FUNDING ───────
   `gate_funding_boundary.js` scans this file. It may not import
   `tax_funding*`, directly or transitively, and it may not so much as
   NAME an escrow table. Escrow routes live in `tax_funding.js`, mounted
   beside this one by the surface, which is the composition point.

   The practical consequence, and the one that matters: there is no path
   through this module by which an escrow balance can make a bill read as
   paid. `POST …/payment` requires City payment evidence and nothing
   else can call it.

   ── SEVEN ROUTES BECAUSE SEVEN DIFFERENT FACTS ──────────────────────
   evidence · applicability · obligation · liability · filing · payment ·
   appeal — plus clearance, which is compliance evidence about a subject
   rather than about one obligation.

   Collapsing filing and payment into a single "mark handled" is the
   defect migration 165 refuses to store, so the seam refuses to offer
   it. A filed BIRT return does not pay a balance.

   ── AUTHORITY IS INJECTED, NEVER RE-IMPLEMENTED ─────────────────────
   The surface owns who may reach these routes; this module owns what
   they do. Two copies of an authority rule is a §17 defect even while
   the copies agree.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

module.exports = function taxEstablishment(deps) {
  const express = require("express");
  const router = express.Router();

  const taxes = require("./tax_obligation_service.js");
  const positionRead = require("./tax_position_read.js");
  const rules = require("./philadelphia_tax_rules.js");
  //  ONE statement of "which entities does this property reach", shared
  //  with the funding seam. It is the rule that decides whether an
  //  operator may write a BIRT record at all.
  const entities = require("../entity/legal_entity_service.js");

  //  The proposal adapter. It has no authority: nothing it returns is
  //  written, and the confirm routes never consult it.
  const docRead = require("./tax_document_read.js");

  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    //  OPTIONAL. Without it the evidence route still retains the document
    //  and says plainly that Spine has not read it — a missing reader
    //  degrades to a blank form, never to a broken upload.
    fileToText,
  } = deps || {};
  if (!pool) throw new Error("tax_establishment requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule,
  })) {
    if (typeof fn !== "function") throw new Error(`tax_establishment requires ${name}`);
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  function fail(res, e) {
    const SAYABLE = new Set([
      "BAD_INPUT", "NOT_FOUND", "PROVENANCE_REQUIRED", "REASON_REQUIRED",
      "SUBJECT_REQUIRED", "WRONG_SUBJECT", "BASIS_REQUIRED", "PERIOD_REQUIRED",
      "CORRECTION_REQUIRED", "ALREADY_ESTABLISHED", "UNKNOWN_REQUIREMENT",
      "REQUIREMENT_REQUIRED",
    ]);
    if (e && SAYABLE.has(e.code)) {
      return res.status(e.code === "NOT_FOUND" ? 404 : 422)
        .json({ error: e.code, receipt: e.message });
    }
    console.error("tax establishment write failed", e);
    return res.status(500).json({ error: "tax_establishment_write_failed" });
  }

  const todayISO = () => positionRead.isoDay(new Date());

  async function reachableEntityIds(client, propertyId, today) {
    const live = await entities.readForProperty(client,
      { property_id: propertyId, as_of: today });
    return live.map((e) => e.legal_entity_id);
  }

  /*  ── WHOSE OBLIGATION MAY THIS OPERATOR TOUCH? ────────────────────
   *  A property-subject obligation must be this property's. An
   *  entity-subject obligation must belong to an entity this property
   *  reaches today, OR be explicitly related to this property. The second
   *  clause matters: a BIRT obligation related to this property stays
   *  operable here even while the entity relationship is being re-dated.
   */
  async function reachableObligation(client, obligationId, propertyId, today) {
    const ids = await reachableEntityIds(client, propertyId, today);
    const { rows } = await client.query(
      `select o.* from tax_obligations o
        where o.id = $1
          and (o.liable_property_id = $2
               or o.liable_legal_entity_id = any($3::uuid[])
               or exists (select 1 from tax_obligation_properties op
                           where op.obligation_id = o.id and op.property_id = $2))`,
      [obligationId, propertyId, ids]);
    return rows[0] || null;
  }

  //  Resolve the subject a write should carry, from the tax type and the
  //  operator's own property. The client never chooses it.
  async function subjectFor(client, taxType, body, propertyId, today) {
    if (rules.SUBJECT_KIND[taxType] === "property") {
      return { property_id: propertyId, legal_entity_id: null };
    }
    const entityId = body.legal_entity_id || null;
    if (!entityId) {
      const e = new Error(
        `${rules.TAX_LABEL[taxType]} is owed by the taxpayer — name the legal entity ` +
        "that files it. If none is established for this property yet, establish it first.");
      e.code = "SUBJECT_REQUIRED";
      throw e;
    }
    const ids = await reachableEntityIds(client, propertyId, today);
    if (!ids.includes(entityId)) {
      const e = new Error(
        "That legal entity is not related to this property, so tax truth for it cannot " +
        "be recorded from here.");
      e.code = "ENTITY_NOT_RELATED";
      throw e;
    }
    return { property_id: null, legal_entity_id: entityId };
  }

  async function currentPosition(client, propertyId) {
    return positionRead.readTaxPosition(client, { property_id: propertyId, rules });
  }

  /*  ══ POST …/taxes/evidence ════════════════════════════════════════
   *  Retain a City document. Storing it asserts NOTHING — not that a tax
   *  applies, not that it is owed, and emphatically not that it is paid.
   *  Each governed fact is a separate confirmed act.
   */
  const multer = require("multer");
  const artifacts = require("../onboarding/source_artifact_service.js");
  const TAX_EVIDENCE_KINDS = Object.freeze([
    "tax_bill", "tax_balance_statement", "tax_return", "tax_payment_receipt",
    "tax_clearance_certificate", "tax_account_statement", "tax_appeal_document",
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
          receipt: "That file is over 25 MB. Upload the document on its own." });
      }
      return res.status(400).json({ error: "upload_failed", receipt: err.message });
    });
  }

  router.post("/operator/asset-management/taxes/evidence",
    requireOperator, acceptFile, refuseClientAuthority, requireAssetManagementModule,
    async (req, res) => {
      const kind = String((req.body && req.body.artifact_kind) || "tax_bill");
      if (!TAX_EVIDENCE_KINDS.includes(kind)) {
        return res.status(422).json({ error: "unsupported_artifact_kind",
          receipt: `"${kind}" is not a kind of tax evidence Spine retains. Expected one ` +
                   `of: ${TAX_EVIDENCE_KINDS.join(", ")}.` });
      }
      if (!req.file) {
        return res.status(400).json({ error: "no_file",
          receipt: "Choose the bill, return, receipt or statement to upload." });
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
        /*  ── READ THE DOCUMENT, PROPOSE NOTHING BINDING ────────────
         *  The scan runs AFTER the artifact is safely stored, and its
         *  failure is not the upload's failure: a City bill Spine could
         *  not parse is still a bill worth retaining, and the operator
         *  can type what it says. Losing the document because a PDF
         *  library threw would be the worse outcome by far.
         */
        const storedKind = stored.artifact_kind || kind;
        let proposal = {
          available: false, fields: {}, unknown: [], source: "none",
          reason: "Spine has not read this document. Enter what it says — Spine " +
                  "records your answers against the file you uploaded.",
        };
        if (typeof fileToText === "function") {
          try {
            const text = await fileToText({
              buffer: req.file.buffer, mimetype: req.file.mimetype,
              originalname: req.file.originalname,
            });
            proposal = docRead.propose(text, storedKind);
          } catch (scanErr) {
            console.error("tax document scan failed (document retained)", scanErr);
          }
        }

        return res.status(stored.deduplicated ? 200 : 201).json({
          artifact: { id: stored.id, filename: stored.original_filename,
                      //  THE STORED KIND, not the requested one. Dedup resolves by
                      //  bytes, and the kind on file wins.
                      artifact_kind: storedKind,
                      deduplicated: !!stored.deduplicated },
          //  Carried, never merged into anything. The confirm routes read
          //  the human's body and nothing else.
          proposal,
          receipt: stored.receipt ||
            `${stored.original_filename} is on file. A document on file is not yet a ` +
            `governed fact — confirm what it establishes next.`,
        });
      } catch (e) {
        if (e && e.artifactRefusal) {
          return res.status(422).json({ error: e.reason, receipt: e.message });
        }
        return fail(res, e);
      }
    });

  /*  ══ POST …/taxes/applicability ═══════════════════════════════════
   *  Does this tax apply here? A HUMAN determination with a stated basis,
   *  never inferred from an entity type or a property's use.
   */
  router.post("/operator/asset-management/taxes/applicability", ...gate, async (req, res) => {
    const b = req.body || {};
    const propertyId = req.operator.property_id;
    const today = todayISO();

    if (!rules.TAX_TYPES.includes(b.tax_type)) {
      return res.status(422).json({ error: "tax_type_required",
        receipt: `Which tax is this about? One of: ` +
                 `${rules.TAX_TYPES.map((t) => rules.TAX_LABEL[t]).join(", ")}.` });
    }

    let client;
    try {
      client = await pool.connect();
      const subject = await subjectFor(client, b.tax_type, b, propertyId, today);

      await client.query("begin");
      const row = await taxes.confirmApplicability(client, {
        tax_type: b.tax_type,
        determination: b.determination,
        basis: b.basis,
        property_id: subject.property_id,
        legal_entity_id: subject.legal_entity_id,
        effective_from: b.effective_from || today,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        supersedes_id: b.supersedes_id || null,
        revision_reason: b.revision_reason || null,
        user_id: req.operator.id,
      });
      await client.query("commit");

      const position = await currentPosition(client, propertyId);
      return res.status(201).json({
        applicability_id: row.id,
        position,
        receipt: row.determination === "applies"
          ? `${rules.TAX_LABEL[b.tax_type]} applies here. The obligation itself is not ` +
            `established until a bill or return is recorded.`
          : `${rules.TAX_LABEL[b.tax_type]} is recorded as not applicable — ${row.basis}`,
      });
    } catch (e) {
      if (client) { try { await client.query("rollback"); } catch (_) {} }
      if (e && e.code === "ENTITY_NOT_RELATED") {
        return res.status(403).json({ error: e.code, receipt: e.message });
      }
      return fail(res, e);
    } finally {
      if (client) client.release();
    }
  });

  /*  ══ POST …/taxes/obligation ══════════════════════════════════════
   *  Establish the obligation, and — in the same transaction, because it
   *  is one human act with one document in hand — the liability the City
   *  states on it.
   *
   *  The liability is OPTIONAL. "We know 2026 Real Estate Tax exists and
   *  we do not have the bill yet" is a real state and a better record
   *  than a zero.
   */
  router.post("/operator/asset-management/taxes/obligation", ...gate, async (req, res) => {
    const b = req.body || {};
    const propertyId = req.operator.property_id;
    const today = todayISO();

    if (!rules.TAX_TYPES.includes(b.tax_type)) {
      return res.status(422).json({ error: "tax_type_required",
        receipt: `Which tax is this? One of: ` +
                 `${rules.TAX_TYPES.map((t) => rules.TAX_LABEL[t]).join(", ")}.` });
    }

    let client;
    try {
      client = await pool.connect();
      const subject = await subjectFor(client, b.tax_type, b, propertyId, today);

      await client.query("begin");
      const obl = await taxes.establishObligation(client, {
        tax_type: b.tax_type,
        period_year: b.period_year === undefined ? undefined : Number(b.period_year),
        period_month: b.period_month === undefined || b.period_month === null
          ? null : Number(b.period_month),
        property_id: subject.property_id,
        legal_entity_id: subject.legal_entity_id,
        //  An ENTITY obligation surfaces on this property while remaining
        //  one obligation. This is the relationship, not a second row.
        related_property_ids: subject.legal_entity_id ? [propertyId] : null,
        account_identifier: b.account_identifier || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });

      let liability = null;
      if (b.annual_liability_cents !== undefined && b.annual_liability_cents !== null) {
        //  The due date comes from the jurisdiction's clocks, not from the
        //  caller — a due date typed into a form is a rule nobody can find
        //  when it changes. A caller may still state one explicitly when
        //  the City's notice differs.
        const milestones = rules.milestonesFor(b.tax_type, obl.period_start instanceof Date
          ? positionRead.isoDay(obl.period_start) : String(obl.period_start).slice(0, 10));
        const payment = milestones.find((m) => m.kind === "payment");
        liability = await taxes.recordLiability(client, {
          obligation_id: obl.id,
          annual_liability_cents: Number(b.annual_liability_cents),
          assessment_cents: b.assessment_cents === undefined || b.assessment_cents === null
            ? null : Number(b.assessment_cents),
          city_balance_cents: b.city_balance_cents === undefined || b.city_balance_cents === null
            ? null : Number(b.city_balance_cents),
          balance_as_of: b.balance_as_of || null,
          due_date: b.due_date || (payment ? payment.due : null),
          currency_code: b.currency_code || "USD",
          source_artifact_id: b.artifact_id || null,
          provenance_note: b.provenance_note || null,
          user_id: req.operator.id,
        });
      }
      await client.query("commit");

      const position = await currentPosition(client, propertyId);
      return res.status(201).json({
        obligation_id: obl.id,
        period_label: obl.period_label,
        liability_id: liability ? liability.id : null,
        position,
        receipt: liability
          ? `${rules.TAX_LABEL[obl.tax_type]} ${obl.period_label} established. Spine records ` +
            `what the City says is owed — it does not compute a bill.`
          : `${rules.TAX_LABEL[obl.tax_type]} ${obl.period_label} established with no amount. ` +
            `Add the bill when it arrives; the amount stays unknown until then.`,
      });
    } catch (e) {
      if (client) { try { await client.query("rollback"); } catch (_) {} }
      if (e && e.code === "ENTITY_NOT_RELATED") {
        return res.status(403).json({ error: e.code, receipt: e.message });
      }
      return fail(res, e);
    } finally {
      if (client) client.release();
    }
  });

  /*  Shared prologue for the four per-obligation writes. Each one is a
   *  different governed fact; what they share is whose obligation it is. */
  function perObligation(path, handler, receipt) {
    router.post(path, ...gate, async (req, res) => {
      let client;
      try {
        client = await pool.connect();
        const obl = await reachableObligation(
          client, req.params.id, req.operator.property_id, todayISO());
        if (!obl) {
          return res.status(404).json({ error: "obligation_not_found",
            receipt: "That tax obligation is not reachable from this property." });
        }
        await client.query("begin");
        const row = await handler(client, req, obl);
        await client.query("commit");

        const position = await currentPosition(client, req.operator.property_id);
        return res.status(201).json({
          id: row.id, obligation_id: obl.id, position, receipt: receipt(row, obl),
        });
      } catch (e) {
        if (client) { try { await client.query("rollback"); } catch (_) {} }
        return fail(res, e);
      } finally {
        if (client) client.release();
      }
    });
  }

  /*  ══ …/:id/liability ═════════════════════════════════════════════
   *  A new City figure, or a correction of one Spine got wrong. The
   *  predecessor stays readable either way. */
  perObligation("/operator/asset-management/taxes/obligation/:id/liability",
    (client, req, obl) => {
      const b = req.body || {};
      const milestones = rules.milestonesFor(obl.tax_type, positionRead.isoDay(obl.period_start));
      const payment = milestones.find((m) => m.kind === "payment");
      return taxes.recordLiability(client, {
        obligation_id: obl.id,
        annual_liability_cents: b.annual_liability_cents === undefined
          ? undefined : Number(b.annual_liability_cents),
        assessment_cents: b.assessment_cents === undefined || b.assessment_cents === null
          ? null : Number(b.assessment_cents),
        city_balance_cents: b.city_balance_cents === undefined || b.city_balance_cents === null
          ? null : Number(b.city_balance_cents),
        balance_as_of: b.balance_as_of || null,
        due_date: b.due_date || (payment ? payment.due : null),
        currency_code: b.currency_code || "USD",
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        supersedes_id: b.supersedes_id || null,
        revision_reason: b.revision_reason || null,
        user_id: req.operator.id,
      });
    },
    (row, obl) => `${rules.TAX_LABEL[obl.tax_type]} liability recorded from the City's ` +
                  `figure${row.supersedes_id ? ", correcting the earlier one" : ""}.`);

  /*  ══ …/:id/filing ════════════════════════════════════════════════
   *  A return, an estimate or an extension. NOT a payment. */
  perObligation("/operator/asset-management/taxes/obligation/:id/filing",
    (client, req, obl) => {
      const b = req.body || {};
      return taxes.recordFiling(client, {
        obligation_id: obl.id,
        filed_at: b.filed_at,
        filing_kind: b.filing_kind || "return",
        confirmation_reference: b.confirmation_reference || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });
    },
    (row, obl) => `${rules.TAX_LABEL[obl.tax_type]} ${row.filing_kind.replace(/_/g, " ")} ` +
                  `recorded as filed. Filing does not pay the balance.`);

  /*  ══ …/:id/payment ═══════════════════════════════════════════════
   *  ⚠ THIS IS WHAT `PAID` MEANS. Evidence the City was paid. No escrow
   *  balance, no servicer statement and no lender's word reaches here —
   *  the boundary gate makes that structural. */
  perObligation("/operator/asset-management/taxes/obligation/:id/payment",
    (client, req, obl) => {
      const b = req.body || {};
      return taxes.recordPayment(client, {
        obligation_id: obl.id,
        paid_at: b.paid_at,
        amount_cents: b.amount_cents === undefined ? undefined : Number(b.amount_cents),
        paid_by: b.paid_by || null,
        //  WHICH requirement this money pays. Omitted where an obligation
        //  carries exactly one, refused by the writer where it carries
        //  several — the browser never guesses on the caller's behalf.
        satisfies_requirement: b.satisfies_requirement || null,
        confirmation_reference: b.confirmation_reference || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });
    },
    (row, obl) => `${rules.TAX_LABEL[obl.tax_type]} payment recorded from City evidence` +
                  `${row.paid_by === "lender_escrow"
                      ? " — remitted by the lender's escrow, and evidenced by the City." : "."}`);

  /*  ══ …/:id/filer-profile ═════════════════════════════════════════
   *  Whether the City's mandatory next-year estimated payment applies to
   *  this taxpayer in this year. A DETERMINATION with a stated basis —
   *  never inferred from entity_type, a formation date, or the absence of
   *  a prior return in Spine. Until it is recorded the row reports the
   *  requirement as UNKNOWN rather than inventing or omitting it.
   */
  perObligation("/operator/asset-management/taxes/obligation/:id/filer-profile",
    (client, req) => {
      const b = req.body || {};
      return taxes.setBirtFilerProfile(client, {
        obligation_id: req.params.id,
        birt_filer_profile: b.birt_filer_profile,
        basis: b.basis,
        user_id: req.operator.id,
      });
    },
    //  ⚠ NOT `.toLowerCase()` ON THE LABEL. It rendered as "first year of
    //  business in philadelphia" on a real screen — lowercasing a whole
    //  phrase to make it fit a sentence also lowercases the proper noun
    //  inside it.
    (row) => `Recorded: ${rules.BIRT_FILER_LABEL[row.birt_filer_profile]}. ` +
             (row.birt_filer_profile === "first_year"
               ? "The City grants first-year filers relief from the mandatory estimated payment."
               : "The mandatory estimated payment for the following year applies."));

  /*  ══ …/:id/appeal ════════════════════════════════════════════════
   *  An open appeal changes NOTHING about the current liability. It is
   *  recorded beside it, never on it. */
  perObligation("/operator/asset-management/taxes/obligation/:id/appeal",
    (client, req, obl) => {
      const b = req.body || {};
      return taxes.openAppeal(client, {
        obligation_id: obl.id,
        opened_on: b.opened_on,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });
    },
    (row, obl) => `Appeal opened against ${rules.TAX_LABEL[obl.tax_type]}. The current ` +
                  `liability is unchanged until the City says otherwise.`);

  /*  ══ POST …/taxes/clearance ═══════════════════════════════════════
   *  Compliance evidence about a SUBJECT, not about one obligation. It
   *  may strengthen the standing read; it may never manufacture a missing
   *  liability, filing or payment. Where it disagrees with an obligation,
   *  the read surfaces the conflict.
   */
  router.post("/operator/asset-management/taxes/clearance", ...gate, async (req, res) => {
    const b = req.body || {};
    const propertyId = req.operator.property_id;
    const today = todayISO();

    let client;
    try {
      client = await pool.connect();
      let entityId = b.legal_entity_id || null;
      if (entityId) {
        const ids = await reachableEntityIds(client, propertyId, today);
        if (!ids.includes(entityId)) {
          return res.status(403).json({ error: "ENTITY_NOT_RELATED",
            receipt: "That legal entity is not related to this property." });
        }
      }

      await client.query("begin");
      const row = await taxes.recordClearance(client, {
        property_id: entityId ? null : propertyId,
        legal_entity_id: entityId,
        issued_on: b.issued_on,
        verified_through: b.verified_through,
        certificate_reference: b.certificate_reference || null,
        source_artifact_id: b.artifact_id || null,
        provenance_note: b.provenance_note || null,
        user_id: req.operator.id,
      });
      await client.query("commit");

      const position = await currentPosition(client, propertyId);
      const conflicts = position.clearance ? position.clearance.conflicts_with : [];
      return res.status(201).json({
        clearance_id: row.id,
        position,
        receipt: conflicts.length
          ? `Clearance recorded — and it disagrees with what Spine holds for ` +
            `${conflicts.join(", ")}. Both are on file; the disagreement is shown rather ` +
            `than resolved.`
          : "Clearance recorded as compliance evidence. It does not establish any " +
            "obligation, filing or payment on its own.",
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
