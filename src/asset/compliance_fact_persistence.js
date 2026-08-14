"use strict";

const { CompliancePersistenceError, digest } = require("./compliance_persistence.js");
const writeContracts = require("./compliance_fact_write_contracts.js");

const EXISTING_ITEM_REQUIRED = new Set([
  "payment_observed", "cure_performed", "authority_disposition",
]);

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CompliancePersistenceError("CONFIRMATION_INCOMPLETE", `${name} is required`);
  }
  return value.trim();
}

function normalized(value) {
  return value === null || value === undefined
    ? null
    : String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function receipt(outcome, itemId, confirmation) {
  return writeContracts.validateReceipt({
    contract_version: writeContracts.RECEIPT_VERSION,
    outcome,
    record: { kind: "compliance_item", id: String(itemId) },
    established: {
      item_kind: confirmation.item.item_kind,
      compliance_type: confirmation.item.compliance_type,
      fact_type: confirmation.fact.fact_type,
    },
    next: { kind: "reread_compliance_standing" },
  });
}

async function validateCredentialContinuity(client, itemId, value) {
  const rows = (await client.query(
    `select credential_issuing_authority, credential_property_address,
            credential_subject_identifier
       from compliance_facts f
      where item_id = $1 and fact_type = 'credential_period'
        and not exists (
          select 1 from compliance_facts correction
           where correction.supersedes_fact_id = f.id
        )`, [itemId])).rows;
  if (rows.length === 0) {
    throw new CompliancePersistenceError(
      "ITEM_IDENTITY_NOT_ESTABLISHED", "The requested credential has no established identity.", 409);
  }
  const checks = [
    ["issuing authority", "credential_issuing_authority", value.issuing_authority],
    ["property subject", "credential_property_address", value.property_address],
  ];
  for (const [label, key, candidate] of checks) {
    const established = [...new Set(rows.map((row) => normalized(row[key])).filter(Boolean))];
    if (established.some((entry) => entry !== normalized(candidate))) {
      throw new CompliancePersistenceError(
        "ITEM_IDENTITY_MISMATCH", `The confirmed ${label} does not match the canonical item.`, 409);
    }
  }
  const subjects = [...new Set(rows
    .map((row) => normalized(row.credential_subject_identifier)).filter(Boolean))];
  if (subjects.length > 0 && !subjects.includes(normalized(value.subject_identifier))) {
    throw new CompliancePersistenceError(
      "ITEM_IDENTITY_MISMATCH", "The confirmed covered subject does not match the canonical item.", 409);
  }
  // External identifiers are period evidence, never authority to resolve item continuity.
}

function insertSpec(factType, value) {
  const specs = {
    credential_period: {
      columns: ["credential_issuing_authority", "credential_external_number",
        "credential_subject_identifier", "credential_code", "credential_activity_number",
        "credential_legal_entity_name", "credential_property_address", "credential_unit_count",
        "credential_effective_from", "credential_effective_through"],
      values: [value.issuing_authority, value.external_number, value.subject_identifier,
        value.credential_code, value.activity_number, value.legal_entity_name,
        value.property_address, value.unit_count, value.effective_from, value.effective_through],
    },
    finding_issued: {
      columns: ["finding_issued_on", "finding_external_reference", "finding_summary"],
      values: [value.issued_on, value.external_reference, value.summary],
    },
    payment_observed: {
      columns: ["payment_observed_on", "payment_amount_cents", "payment_currency_code",
        "payment_reference"],
      values: [value.observed_on, value.amount_cents, value.currency_code, value.payment_reference],
    },
    cure_performed: {
      columns: ["cure_performed_on", "cure_summary"],
      values: [value.performed_on, value.summary],
    },
    authority_disposition: {
      columns: ["authority_decided_on", "authority_disposition", "authority_summary"],
      values: [value.decided_on, value.disposition, value.summary],
    },
    inspection_result: {
      columns: ["inspection_performed_on", "inspection_outcome", "inspection_summary"],
      values: [value.performed_on, value.outcome, value.summary],
    },
    requirement_applicability: {
      columns: ["requirement_decided_on", "requirement_applicability", "requirement_summary"],
      values: [value.decided_on, value.applicability, value.summary],
    },
  };
  return specs[factType];
}

function createComplianceFactWriter() {
  async function establishFact(pool, input = {}) {
    const authority = input.authority || {};
    const propertyId = required(authority.property_id, "server-derived property_id");
    const actorId = required(authority.actor_user_id, "server-derived actor_user_id");
    const confirmation = writeContracts.validateConfirmation(input.confirmation);
    const factType = confirmation.fact.fact_type;
    let itemId = confirmation.item.existing_item_id;
    if (EXISTING_ITEM_REQUIRED.has(factType) && itemId === null) {
      throw new CompliancePersistenceError(
        "EXISTING_ITEM_REQUIRED", `${factType} must be attached to an established finding.`, 409);
    }

    const requestFingerprint = digest({
      version: "compliance.fact_request.v1", propertyId,
      idempotencyKey: confirmation.idempotency_key,
    });
    const establishmentFingerprint = digest({
      version: "compliance.fact_establishment.v1", propertyId, confirmation,
    });
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const lockKey of [requestFingerprint, establishmentFingerprint].sort()) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      }
      const prior = (await client.query(
        `select item_id, request_fingerprint, establishment_fingerprint
           from compliance_facts
          where request_fingerprint = $1 or establishment_fingerprint = $2
          order by established_at, id limit 1`,
        [requestFingerprint, establishmentFingerprint])).rows[0];
      if (prior) {
        if (prior.request_fingerprint === requestFingerprint &&
            prior.establishment_fingerprint !== establishmentFingerprint) {
          throw new CompliancePersistenceError(
            "IDEMPOTENCY_CONFLICT", "This idempotency key names a different fact.", 409);
        }
        await client.query("commit");
        return receipt("idempotent_replay", prior.item_id, confirmation);
      }

      const artifact = (await client.query(
        `select id, scope_type, scope_id, original_filename, sha256
           from source_artifacts where id = $1 for share`,
        [confirmation.artifact_id])).rows[0];
      if (!artifact || artifact.scope_type !== "property" ||
          String(artifact.scope_id) !== propertyId) {
        throw new CompliancePersistenceError(
          "ARTIFACT_OUT_OF_SCOPE", "The retained source is outside the authorized property.", 403);
      }
      if (artifact.sha256 !== confirmation.artifact_sha256) {
        throw new CompliancePersistenceError(
          "ARTIFACT_DIGEST_MISMATCH", "The retained source digest no longer matches.", 409);
      }

      if (itemId !== null) {
        const item = (await client.query(
          `select id, property_id, item_kind, compliance_type
             from compliance_items where id = $1 for update`, [itemId])).rows[0];
        if (!item || String(item.property_id) !== propertyId) {
          throw new CompliancePersistenceError(
            "ITEM_OUT_OF_SCOPE", "The requested Compliance item is outside the authorized property.", 403);
        }
        if (item.item_kind !== confirmation.item.item_kind ||
            item.compliance_type !== confirmation.item.compliance_type) {
          throw new CompliancePersistenceError(
            "ITEM_KIND_MISMATCH", "The requested item has a different Compliance identity.", 409);
        }
        if (factType === "credential_period" && confirmation.correction === null) {
          await validateCredentialContinuity(client, itemId, confirmation.fact.value);
        }
      } else {
        itemId = (await client.query(
          `insert into compliance_items
             (property_id, item_kind, compliance_type, created_by_user_id)
           values ($1, $2, $3, $4) returning id`,
          [propertyId, confirmation.item.item_kind,
            confirmation.item.compliance_type, actorId])).rows[0].id;
      }

      if (confirmation.correction !== null) {
        const target = (await client.query(
          `select id, item_id, fact_type from compliance_facts where id = $1 for update`,
          [confirmation.correction.supersedes_fact_id])).rows[0];
        if (!target || String(target.item_id) !== String(itemId) || target.fact_type !== factType) {
          throw new CompliancePersistenceError(
            "CORRECTION_TARGET_MISMATCH", "The correction target is outside this item or fact type.", 409);
        }
      }

      const spec = insertSpec(factType, confirmation.fact.value);
      const fixedColumns = ["item_id", "fact_type", ...spec.columns,
        "supersedes_fact_id", "correction_reason", "request_fingerprint",
        "establishment_fingerprint", "established_by_user_id"];
      const values = [itemId, factType, ...spec.values,
        confirmation.correction && confirmation.correction.supersedes_fact_id,
        confirmation.correction && confirmation.correction.reason,
        requestFingerprint, establishmentFingerprint, actorId];
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const fact = (await client.query(
        `insert into compliance_facts (${fixedColumns.join(", ")})
         values (${placeholders.join(", ")}) returning id`, values)).rows[0];
      await client.query(
        `insert into compliance_fact_evidence
           (fact_id, source_artifact_id, evidence_role, label)
         values ($1, $2, $3, $4)`,
        [fact.id, artifact.id, writeContracts.EVIDENCE_ROLE[factType], artifact.original_filename]);
      await client.query("commit");
      return receipt("established", itemId, confirmation);
    } catch (error) {
      try { await client.query("rollback"); } catch (_) {}
      if (error && error.code === "23505") {
        const replay = (await client.query(
          `select item_id from compliance_facts where establishment_fingerprint = $1 limit 1`,
          [establishmentFingerprint])).rows[0];
        if (replay) return receipt("idempotent_replay", replay.item_id, confirmation);
        throw new CompliancePersistenceError(
          "CONFIRMATION_CONFLICT", "Concurrent confirmation created conflicting truth.", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ establishFact });
}

module.exports = { createComplianceFactWriter };
