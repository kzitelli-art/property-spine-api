"use strict";

const crypto = require("crypto");
const contracts = require("./compliance_contracts.js");

class CompliancePersistenceError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "CompliancePersistenceError";
    this.code = code;
    this.status = status;
  }
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CompliancePersistenceError("CONFIRMATION_INCOMPLETE", `${name} is required`);
  }
  return value.trim();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function normalized(value) {
  return value === null || value === undefined
    ? null
    : String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function sameWhenEstablished(currentValues, confirmedValue) {
  const established = [...new Set(currentValues.filter((value) => value !== null).map(normalized))];
  if (established.length === 0) return true;
  if (confirmedValue === null) return false;
  return established.every((value) => value === normalized(confirmedValue));
}

function writeReceipt(outcome, itemId, confirmed) {
  return contracts.validateWriteReceipt({
    contract_version: contracts.VERSIONS.write_receipt,
    outcome,
    record: { kind: "compliance_item", id: itemId },
    established: {
      compliance_type: confirmed.compliance_type,
      external_credential_number: confirmed.external_credential_number,
      effective_from: confirmed.effective_from,
      effective_through: confirmed.effective_through,
    },
    next: { kind: "reread_compliance_standing" },
  });
}

async function currentCredentialIdentity(client, itemId) {
  const { rows } = await client.query(
    `select f.credential_issuing_authority, f.credential_external_number,
            f.credential_legal_entity_name, f.credential_property_address
       from compliance_facts f
      where f.item_id = $1 and f.fact_type = 'credential_period'
        and not exists (
          select 1 from compliance_facts correction
           where correction.supersedes_fact_id = f.id
        )
      order by f.established_at, f.id`,
    [itemId]);
  return rows;
}

function validateExistingIdentity(rows, confirmed) {
  if (rows.length === 0) {
    throw new CompliancePersistenceError(
      "ITEM_IDENTITY_NOT_ESTABLISHED",
      "The requested Compliance item has no established credential identity.", 409);
  }
  const comparisons = [
    ["issuing authority", "credential_issuing_authority", confirmed.issuing_authority],
    ["legal subject", "credential_legal_entity_name", confirmed.legal_entity_name],
    ["property subject", "credential_property_address", confirmed.property_address],
  ];
  for (const [label, key, value] of comparisons) {
    if (!sameWhenEstablished(rows.map((row) => row[key]), value)) {
      throw new CompliancePersistenceError(
        "ITEM_IDENTITY_MISMATCH", `The confirmed ${label} does not match the canonical item.`, 409);
    }
  }
  // External numbers intentionally do not grant or refuse continuity. They
  // support recognition and remain preserved on each fact for correction/history.
}

function credentialColumns(confirmed) {
  return [
    required(confirmed.issuing_authority, "issuing_authority"),
    required(confirmed.external_credential_number, "external_credential_number"),
    confirmed.credential_code,
    confirmed.commercial_activity_number,
    required(confirmed.legal_entity_name, "legal_entity_name"),
    required(confirmed.property_address, "property_address"),
    confirmed.unit_count,
    required(confirmed.effective_from, "effective_from"),
    required(confirmed.effective_through, "effective_through"),
  ];
}

function createComplianceWriter({ readProposal } = {}) {
  if (typeof readProposal !== "function") {
    throw new Error("compliance_persistence requires a governed readProposal function");
  }

  async function establishCredentialPeriod(pool, input = {}) {
    const authority = input.authority || {};
    const propertyId = required(authority.property_id, "server-derived property_id");
    const actorId = required(authority.actor_user_id, "server-derived actor_user_id");
    const existingItemId = input.existing_item_id || null;
    const confirmation = contracts.validateConfirmationRequest(input.confirmation);
    if (confirmation.confirmed.compliance_type !== "rental_license") {
      throw new CompliancePersistenceError(
        "UNSUPPORTED_COMPLIANCE_TYPE", "This writer only establishes rental licenses.");
    }
    if (confirmation.correction !== null && existingItemId === null) {
      throw new CompliancePersistenceError(
        "CORRECTION_ITEM_REQUIRED", "A correction must name its canonical Compliance item.");
    }

    const requestFingerprint = digest({ version: "compliance.request.v1", propertyId,
      idempotencyKey: confirmation.idempotency_key });
    const establishmentFingerprint = digest({
      version: "compliance.establishment.v1",
      propertyId,
      relationship: existingItemId || "new_item",
      artifactId: confirmation.artifact_id,
      artifactSha256: confirmation.artifact_sha256,
      proposalFingerprint: confirmation.proposal_fingerprint,
      confirmed: confirmation.confirmed,
      correction: confirmation.correction,
    });

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const lockKey of [requestFingerprint, establishmentFingerprint].sort()) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      }

      const prior = (await client.query(
        `select id, item_id, request_fingerprint, establishment_fingerprint
           from compliance_facts
          where request_fingerprint = $1 or establishment_fingerprint = $2
          order by established_at, id limit 1`,
        [requestFingerprint, establishmentFingerprint])).rows[0];
      if (prior) {
        if (prior.request_fingerprint === requestFingerprint &&
            prior.establishment_fingerprint !== establishmentFingerprint) {
          throw new CompliancePersistenceError(
            "IDEMPOTENCY_CONFLICT", "This idempotency key already names a different confirmation.", 409);
        }
        await client.query("commit");
        return writeReceipt("idempotent_replay", prior.item_id, confirmation.confirmed);
      }

      const artifact = (await client.query(
        `select id, scope_type, scope_id, original_filename, mime_type, artifact_kind,
                sha256, content, source_as_of_date
           from source_artifacts where id = $1 for share`,
        [confirmation.artifact_id])).rows[0];
      if (!artifact || artifact.scope_type !== "property" || String(artifact.scope_id) !== propertyId) {
        throw new CompliancePersistenceError(
          "ARTIFACT_OUT_OF_SCOPE", "The retained source does not belong to the authorized property.", 403);
      }
      if (artifact.sha256 !== confirmation.artifact_sha256) {
        throw new CompliancePersistenceError(
          "ARTIFACT_DIGEST_MISMATCH", "The retained source digest no longer matches the confirmation.", 409);
      }

      const proposal = await readProposal({ artifact, property_id: propertyId });
      contracts.validateProposal(proposal);
      const expectedProposalFingerprint = contracts.proposalFingerprint(artifact.sha256, proposal);
      if (expectedProposalFingerprint !== confirmation.proposal_fingerprint) {
        throw new CompliancePersistenceError(
          "PROPOSAL_STALE", "The confirmation does not match the governed source reading.", 409);
      }
      if (proposal.recognition_state !== "recognized" ||
          proposal.source_classification !== "authority_issued_credential") {
        throw new CompliancePersistenceError(
          "SOURCE_NOT_COMPETENT", "Only authority-issued credential evidence can establish issuance.");
      }

      let itemId = existingItemId;
      if (itemId) {
        const item = (await client.query(
          `select id, property_id, item_kind, compliance_type
             from compliance_items where id = $1 for update`, [itemId])).rows[0];
        if (!item || String(item.property_id) !== propertyId) {
          throw new CompliancePersistenceError(
            "ITEM_OUT_OF_SCOPE", "The requested Compliance item is outside the authorized property.", 403);
        }
        if (item.item_kind !== "credential" ||
            item.compliance_type !== confirmation.confirmed.compliance_type) {
          throw new CompliancePersistenceError(
            "ITEM_KIND_MISMATCH", "The requested canonical item has a different Compliance identity.", 409);
        }
        validateExistingIdentity(await currentCredentialIdentity(client, itemId), confirmation.confirmed);
      } else {
        itemId = (await client.query(
          `insert into compliance_items
             (property_id, item_kind, compliance_type, created_by_user_id)
           values ($1, 'credential', $2, $3) returning id`,
          [propertyId, confirmation.confirmed.compliance_type, actorId])).rows[0].id;
      }

      if (confirmation.correction !== null) {
        const target = (await client.query(
          `select id, item_id, fact_type from compliance_facts
            where id = $1 for update`, [confirmation.correction.supersedes_fact_id])).rows[0];
        if (!target || String(target.item_id) !== String(itemId) ||
            target.fact_type !== "credential_period") {
          throw new CompliancePersistenceError(
            "CORRECTION_TARGET_MISMATCH", "The correction target is not a credential fact on this item.", 409);
        }
      }

      const values = credentialColumns(confirmation.confirmed);
      const fact = (await client.query(
        `insert into compliance_facts (
           item_id, fact_type,
           credential_issuing_authority, credential_external_number,
           credential_code, credential_activity_number,
           credential_legal_entity_name, credential_property_address,
           credential_unit_count, credential_effective_from, credential_effective_through,
           supersedes_fact_id, correction_reason,
           request_fingerprint, establishment_fingerprint, established_by_user_id)
         values ($1, 'credential_period', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15)
         returning id, established_at`,
        [itemId, ...values,
          confirmation.correction && confirmation.correction.supersedes_fact_id,
          confirmation.correction && confirmation.correction.reason,
          requestFingerprint, establishmentFingerprint, actorId])).rows[0];

      await client.query(
        `insert into compliance_fact_evidence
           (fact_id, source_artifact_id, evidence_role, label)
         values ($1, $2, 'issuance', $3)`,
        [fact.id, artifact.id, artifact.original_filename]);

      await client.query("commit");
      return writeReceipt("established", itemId, confirmation.confirmed);
    } catch (error) {
      try { await client.query("rollback"); } catch (_) {}
      if (error && error.code === "23505") {
        const replay = (await client.query(
          `select item_id from compliance_facts
            where establishment_fingerprint = $1 limit 1`,
          [establishmentFingerprint])).rows[0];
        if (replay) {
          return writeReceipt("idempotent_replay", replay.item_id, confirmation.confirmed);
        }
        throw new CompliancePersistenceError(
          "CONFIRMATION_CONFLICT", "Concurrent confirmation created conflicting canonical truth.", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ establishCredentialPeriod });
}

module.exports = { createComplianceWriter, CompliancePersistenceError, digest };
