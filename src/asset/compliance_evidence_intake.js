"use strict";

const artifacts = require("../onboarding/source_artifact_service.js");
const documentRead = require("./compliance_document_read.js");
const {
  VERSIONS, proposalFingerprint, validateFailure, validateIntake,
} = require("./compliance_contracts.js");

// The eventual route must derive both authority values from its authenticated
// session. This service deliberately accepts no browser-authored property_id or
// actor_id field and performs no canonical Compliance write.
async function retainAndRecognize(db, {
  authorized_property_id,
  authenticated_user_id,
  authority_basis,
  filename,
  mimetype,
  buffer,
  extractText,
} = {}) {
  if (!authorized_property_id || !authenticated_user_id) {
    throw new TypeError("authorized property and authenticated user context are required");
  }
  if (typeof extractText !== "function") throw new TypeError("extractText is required");

  const stored = await artifacts.store(db, {
    scope_type: "property",
    scope_id: authorized_property_id,
    filename,
    mimetype,
    buffer,
    uploaded_by_user_id: authenticated_user_id,
    authority_basis,
    artifact_kind: "other",
  });

  const artifact = {
    id: stored.id,
    sha256: stored.sha256,
    artifact_kind: stored.artifact_kind,
    deduplicated: stored.deduplicated,
  };

  try {
    const text = await extractText(buffer);
    const proposal = documentRead.propose(text);
    return validateIntake({
      contract_version: VERSIONS.intake,
      artifact,
      proposal,
      proposal_basis: {
        adapter: documentRead.ADAPTER,
        adapter_version: documentRead.ADAPTER_VERSION,
        fingerprint: proposalFingerprint(stored.sha256, proposal),
      },
      failure: null,
    });
  } catch (error) {
    const failure = validateFailure({
      contract_version: VERSIONS.failure,
      code: "recognition_failed",
      message: "The source was retained, but Spine could not read it. Review the source and enter only what it establishes.",
      retryable: true,
      artifact: { id: stored.id, retained: true },
    });
    return validateIntake({
      contract_version: VERSIONS.intake,
      artifact,
      proposal: null,
      proposal_basis: null,
      failure,
    });
  }
}

module.exports = { retainAndRecognize };
