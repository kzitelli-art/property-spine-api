/* ════════════════════════════════════════════════════════════════════
   insurance_establishment.js — THE HUMAN ESTABLISHMENT PATH INTO
   INSURANCE. Upload the evidence, confirm what it says, and the existing
   Insurance compartment populates from governed truth.

   Migration 161 built a complete insurance economic architecture and
   wired the READ. It had zero HTTP write callers: both canonical writers
   were reachable only from tests. This is the missing seam, and it is a
   route pair — nothing more.

   ── IT WRITES NOTHING ITSELF ────────────────────────────────────────
   Every durable fact here goes through a canonical writer that already
   exists and is already guarded:

     insurance_program_service    establishProgram · establishCoverage
                                  recordIdentifier · recordParticipation
     insurance_allocation_service openSlice
     source_artifact_service      store

   There is no second insurance writer, and this file must never become
   one. If a rule needs to change, it changes in the service, where every
   caller gets it.

   ── PARTICIPATION AND ALLOCATION ARE DIFFERENT FACTS ────────────────
   Establishing coverage ALWAYS records that this property is named on
   the policy. It records a SHARE only when the operator supplied one.
   That is the state migration 162 created and the one this path exists
   to make reachable: coverage established, allocation honestly missing,
   both visible. No share is ever inferred — not from an equal split, not
   from a unit count, not from "there is only one property on it."

   ── IT KNOWS NOTHING ABOUT FINANCING ────────────────────────────────
   Same wall migration 161 and the two services hold, for the same
   reason: what insurance COSTS must be establishable without knowing how
   it was PAID FOR. tests/gate_insurance_economic_independence.js scans
   this file for financing vocabulary and fails the build on a hit.

   ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────
   It could have been two more routes inside src/surfaces/asset_management.js.
   It is not, for one concrete reason: that file legitimately contains
   the words "Premium financing", "Down payment" and "Financed amount" in
   the Cash & Financing section's `reserved` spec — the description of a
   section that is deliberately unbuilt. So the independence gate cannot
   scan it whole, and a gate that scans less than the claim it makes is
   worse than no gate. Splitting the write path out gives the gate a file
   it can read end to end.

   Authority middleware is INJECTED rather than re-implemented. The
   surface owns who may operate this door; this module owns what the door
   does. Two copies of an authority rule is a §17 defect even while they
   agree.

   CLASS 1 — permanent product primitive.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const INSURANCE_EVIDENCE_KINDS = Object.freeze(["insurance_policy", "insurance_binder"]);

module.exports = function insuranceEstablishment(deps) {
  const express = require("express");
  const multer = require("multer");
  const router = express.Router();

  const programs = require("./insurance_program_service.js");
  const allocations = require("./insurance_allocation_service.js");
  const insurancePosition = require("./insurance_position_read.js");
  const artifacts = require("../onboarding/source_artifact_service.js");

  const {
    pool, requireOperator, refuseClientAuthority, requireAssetManagementModule,
    currentPeriod,
  } = deps || {};
  if (!pool) throw new Error("insurance_establishment requires a pool");
  for (const [name, fn] of Object.entries({
    requireOperator, refuseClientAuthority, requireAssetManagementModule, currentPeriod,
  })) {
    if (typeof fn !== "function") {
      throw new Error(`insurance_establishment requires ${name}`);
    }
  }

  const gate = [requireOperator, refuseClientAuthority, requireAssetManagementModule];

  /*  ── THE MULTIPART GATE IS A DIFFERENT ORDER, AND IT MATTERS ───────
   *  `refuseClientAuthority` reads req.body. On a multipart request there
   *  IS no req.body until multer has run, so composing the ordinary gate
   *  in front of the upload would read undefined, find no claimed
   *  property, and pass — silently IGNORING a body property_id instead of
   *  REFUSING it. §21 and the rule frozen in PR #38 both say refused, not
   *  ignored, and "it happened to be undefined at the time" is not a
   *  refusal.
   *
   *  So the file is parsed first and authority is judged after, against a
   *  body that actually exists. Identity still comes first: an
   *  unauthenticated caller never reaches multer and cannot make the
   *  server buffer 25 MB.
   */
  const uploadOne = multer({
    storage: multer.memoryStorage(),
    //  Matches source_artifact_service.MAX_BYTES exactly. Lower would
    //  refuse in multer's vocabulary before the service could give its own
    //  sayable receipt; higher would buffer bytes about to be rejected.
    limits: { fileSize: artifacts.MAX_BYTES, files: 1 },
  }).single("file");

  function acceptEvidenceFile(req, res, next) {
    uploadOne(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "file_too_large",
          receipt: "That file is over 25 MB. Upload the policy document on its own.",
        });
      }
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        return res.status(400).json({
          error: "one_file", receipt: "Upload one document at a time.",
        });
      }
      return res.status(400).json({ error: "upload_failed", receipt: err.message });
    });
  }

  const multipartGate = [
    requireOperator, acceptEvidenceFile, refuseClientAuthority, requireAssetManagementModule,
  ];

  /*  Named refusals from the services reach the operator as themselves. A
   *  caller who omitted the currency is told the currency is missing —
   *  not "500". A refusal a user can see is product copy. */
  function fail(res, e) {
    if (e && e.artifactRefusal) {
      return res.status(422).json({ error: e.reason, receipt: e.message });
    }
    const SAYABLE = new Set([
      "CURRENCY_NOT_ESTABLISHED", "BAD_INPUT", "NOT_FOUND",
      "OVER_ALLOCATED", "STATED_NEEDS_EXTERNAL_BASIS", "DERIVED_NEEDS_MODEL",
      "PROVENANCE_REQUIRED", "REASON_REQUIRED", "PARTICIPATION_REQUIRED",
    ]);
    if (e && SAYABLE.has(e.code)) {
      return res.status(e.code === "NOT_FOUND" ? 404 : 422)
        .json({ error: e.code, receipt: e.message });
    }
    console.error("insurance establishment write failed", e);
    return res.status(500).json({ error: "insurance_write_failed" });
  }

  /*  ══ POST …/insurance/evidence ═══════════════════════════════════
   *  Retain the document. That is the whole job.
   *
   *  Storing evidence and reading it are two acts and this is only the
   *  first. The artifact is kept so that whatever is established next can
   *  point at what it came from — which is what makes the position
   *  explainable a year later, whether Spine read the file or a human
   *  typed what it said.
   *
   *  The response already has the slot a reader will fill, so adding
   *  extraction later changes what is IN `proposal`, never the contract
   *  around it. Today it says in as many words that Spine has not read
   *  the document: an empty `fields` with no explanation would read as
   *  "found nothing in it", which is a different and false claim.
   */
  router.post("/operator/asset-management/insurance/evidence", ...multipartGate,
    async (req, res) => {
      const propertyId = req.operator.property_id;
      const kind = String((req.body && req.body.artifact_kind) || "insurance_policy");

      if (!INSURANCE_EVIDENCE_KINDS.includes(kind)) {
        return res.status(422).json({
          error: "unsupported_artifact_kind",
          receipt: `Insurance evidence is a policy or a binder. "${kind}" is neither.`,
        });
      }
      if (!req.file) {
        return res.status(400).json({
          error: "no_file", receipt: "Choose the policy or binder to upload.",
        });
      }

      try {
        const stored = await artifacts.store(pool, {
          scope_type: "property",
          //  SERVER-DERIVED. The operator's own property, never a body field.
          scope_id: propertyId,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          buffer: req.file.buffer,
          uploaded_by_user_id: req.operator.id,
          authority_basis: "asset_management_module",
          source_as_of_date: (req.body && req.body.source_as_of_date) || null,
          artifact_kind: kind,
        });

        return res.status(stored.deduplicated ? 200 : 201).json({
          artifact: {
            id: stored.id,
            filename: stored.original_filename,
            byte_size: stored.byte_size,
            artifact_kind: kind,
            uploaded_at: stored.uploaded_at,
            deduplicated: !!stored.deduplicated,
          },
          proposal: {
            //  Becomes true when the reader lands. Nothing else moves.
            available: false,
            reason: "Spine has not read this document. Enter what it says — " +
                    "Spine records your answers against the file you uploaded.",
            fields: {},
          },
          receipt: stored.receipt ||
            `${stored.original_filename} is on file. Spine keeps it so it can always ` +
            `show what this position came from.`,
        });
      } catch (e) { return fail(res, e); }
    });

  /*  ══ POST …/insurance/establish ═══════════════════════════════════
   *  The human has confirmed what the document says. Write it once,
   *  through the canonical writers, in one transaction.
   */
  router.post("/operator/asset-management/insurance/establish", ...gate,
    async (req, res) => {
      const propertyId = req.operator.property_id;
      const body = req.body || {};
      const program = body.program || {};
      const coverages = Array.isArray(body.coverages) ? body.coverages : null;
      const artifactId = body.artifact_id || null;

      if (!coverages || coverages.length === 0) {
        return res.status(422).json({
          error: "no_coverages",
          receipt: "Establishing insurance needs at least one coverage from the document.",
        });
      }

      let client;
      try {
        client = await pool.connect();

        //  ── THE ARTIFACT MUST BE THIS PROPERTY'S ──────────────────────
        //  A valid session at property A must not be able to cite property
        //  B's document as the provenance for A's economics. Authentication
        //  answers WHO may call this; it does not answer WHOSE evidence
        //  they may point at.
        if (artifactId) {
          const art = await artifacts.describe(client, artifactId);
          if (!art) {
            return res.status(404).json({
              error: "artifact_not_found",
              receipt: "That uploaded document is no longer on file. Upload it again.",
            });
          }
          if (!(art.scope_type === "property" && String(art.scope_id) === String(propertyId))) {
            return res.status(403).json({
              error: "artifact_out_of_scope",
              receipt: "That document belongs to a different property and cannot be " +
                       "used as evidence here.",
              acting_on: propertyId,
            });
          }

          //  ── AND IT MUST NOT ALREADY HAVE ESTABLISHED SOMETHING ──────
          //  A double-click, a retry or a re-submitted form would otherwise
          //  write a SECOND program and a second set of coverages from one
          //  document — and because each carries its own premium, the
          //  property's annual cost would silently double. Provenance is
          //  the natural idempotency key: this file has already been used
          //  to establish coverage here.
          const prior = (await client.query(
            `select 1 from insurance_coverage_properties
              where property_id = $1 and observed_in_artifact_id = $2 limit 1`,
            [propertyId, artifactId])).rows[0];
          if (prior) {
            return res.status(409).json({
              error: "already_established",
              receipt: "That document has already established coverage for this property. " +
                       "To change what it says, correct the existing coverage rather than " +
                       "establishing it a second time.",
            });
          }
        }

        await client.query("begin");

        const prog = await programs.establishProgram(client, {
          program_name: program.program_name,
          term_start: program.term_start,
          term_end: program.term_end,
          //  Passed through, never defaulted. The service refuses a missing
          //  currency by name and this route does not soften that.
          currency_code: program.currency_code,
          user_id: req.operator.id,
        });

        const written = [];
        for (const c of coverages) {
          const cov = await programs.establishCoverage(client, {
            program_id: prog.id,
            coverage_type: c.coverage_type,
            carrier_name: c.carrier_name || null,
            broker_name: c.broker_name || null,
            coverage_period_start: c.coverage_period_start,
            coverage_period_end: c.coverage_period_end,
            premium_cents: c.premium_cents,
            taxes_cents: c.taxes_cents || 0,
            fees_cents: c.fees_cents || 0,
            broker_fee_cents: c.broker_fee_cents || 0,
            user_id: req.operator.id,
          });

          //  Policy numbers as observed. Several renderings of one policy
          //  are all true at once; the service keeps them all.
          for (const idf of (Array.isArray(c.identifiers) ? c.identifiers : [])) {
            await programs.recordIdentifier(client, {
              coverage_id: cov.id,
              identifier_value: idf.identifier_value,
              issued_by: idf.issued_by,
              observed_in_artifact_id: artifactId,
              observed_as_of: c.observed_as_of || null,
              user_id: req.operator.id,
            });
          }

          //  ALWAYS. This is the fact the document establishes.
          await programs.recordParticipation(client, {
            coverage_id: cov.id,
            property_id: propertyId,
            observed_in_artifact_id: artifactId,
            observed_as_of: c.observed_as_of || null,
            user_id: req.operator.id,
          });

          //  ONLY when the document states this property's share.
          let allocated = false;
          const a = c.allocation;
          if (a && a.allocated_amount_cents !== undefined && a.allocated_amount_cents !== null) {
            await allocations.openSlice(client, {
              coverage_id: cov.id,
              property_id: propertyId,
              allocated_amount_cents: a.allocated_amount_cents,
              allocation_class: a.allocation_class,
              allocation_basis: a.allocation_basis,
              basis_detail: a.basis_detail || null,
              effective_from: a.effective_from || c.coverage_period_start,
              effective_to: a.effective_to || null,
              source_artifact_id: artifactId,
              provenance_note: a.provenance_note || null,
              user_id: req.operator.id,
            });
            allocated = true;
          }

          written.push({
            coverage_id: cov.id,
            coverage_type: cov.coverage_type,
            share_established: allocated,
          });
        }

        await client.query("commit");

        //  ── RETURN THE READ, NOT A HOPEFUL ECHO ───────────────────────
        //  What comes back is what the dashboard will now show, read from
        //  the database after the commit. A client-side guess at the result
        //  of a write is how a surface comes to display something the
        //  database does not contain.
        const period = /^\d{4}-\d{2}$/.test(String(body.period || ""))
          ? String(body.period) : currentPeriod();
        const position = await insurancePosition.readPosition(client,
          { property_id: propertyId, period });
        const participation = await insurancePosition.readParticipation(client,
          { property_id: propertyId, period });

        const awaiting = participation.awaiting_allocation_count;
        return res.status(201).json({
          established: written,
          program_id: prog.id,
          period,
          position_established: position.established,
          participates: participation.participates,
          awaiting_allocation_count: awaiting,
          //  PERMANENTLY FALSE WHILE THIS SLICE STANDS. Establishing what
          //  insurance COSTS says nothing about how it is settled, and that
          //  chain is not built. Saying otherwise would be the exact seam
          //  migration 161 exists to keep open.
          cash_established: false,
          receipt: awaiting === 0
            ? `Insurance established. ${written.length} coverage${written.length === 1 ? "" : "s"} ` +
              `recorded for this property.`
            : `Insurance established. ${written.length} coverage${written.length === 1 ? "" : "s"} ` +
              `recorded — ${awaiting} still ${awaiting === 1 ? "needs" : "need"} this property's ` +
              `share. Spine will not estimate it.`,
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

module.exports.INSURANCE_EVIDENCE_KINDS = INSURANCE_EVIDENCE_KINDS;
