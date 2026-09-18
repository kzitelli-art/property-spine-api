"use strict";

// Proof-only convenience. It still exercises the public preview/apply contract:
// a caller must explicitly accept every server suggestion, and any identity
// without a suggestion stops the proof instead of inventing a mapping.
async function reviewedIngest(activation, db, args, choose) {
  const preview = await activation.previewRentRoll(db, args);
  const decisions = preview.identities
    .filter(identity => identity.current_row_indices && identity.current_row_indices.length)
    .map(identity => {
      const decision = choose ? choose(identity, preview) : identity.suggested_decision;
      if (!decision) throw new Error(`proof_requires_explicit_home_decision:${identity.key}`);
      return { key: identity.key, ...decision };
    });
  return activation.ingestRentRoll(db, {
    ...args,
    leasing_basis: preview.leasing_basis,
    source_token: preview.source_token,
    inventory_decisions: decisions,
  });
}

async function reviewedHttp(request, activationId, headers, body, choose) {
  const preview = await request("POST", `/deal-setup/activations/${activationId}/preview-source`, {
    headers,
    body,
  });
  if (preview.status !== 200) return { preview, applied: null };
  const decisions = preview.body.identities
    .filter(identity => identity.current_row_indices && identity.current_row_indices.length)
    .map(identity => {
      const decision = choose ? choose(identity, preview.body) : identity.suggested_decision;
      if (!decision) throw new Error(`proof_requires_explicit_home_decision:${identity.key}`);
      return { key: identity.key, ...decision };
    });
  const applied = await request("POST", `/deal-setup/activations/${activationId}/read-source`, {
    headers,
    body: {
      ...body,
      leasing_basis: preview.body.leasing_basis,
      source_token: preview.body.source_token,
      inventory_decisions: decisions,
    },
  });
  return { preview, applied };
}

module.exports = { reviewedIngest, reviewedHttp };
