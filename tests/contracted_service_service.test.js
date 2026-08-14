"use strict";

const assert = require("assert");
const service = require("../src/asset/contracted_service_service.js");

const PROPERTY = "property-a";
const OTHER_PROPERTY = "property-b";
const ENGAGEMENT = "engagement-a";
const ARTIFACT = "artifact-a";
const OTHER_ARTIFACT = "artifact-b";
const USER = "user-a";

let passed = 0;

async function ok(label, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${label}`);
}

async function rejects(fn, pattern) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, "operation unexpectedly succeeded");
  assert(pattern.test(`${error.code || ""} ${error.message || ""}`), error.message);
}

function fakeClient({
  document = {
    id: "document-a", property_id: PROPERTY, engagement_id: ENGAGEMENT,
    source_artifact_id: ARTIFACT, document_kind: "proposal", execution_state: "unsigned",
  },
  priorTerm = null,
  providerCandidates = [],
  obligationProperty = PROPERTY,
} = {}) {
  let sequence = 0;
  const calls = [];
  const inserts = [];

  function inserted(table, params) {
    sequence += 1;
    const row = { id: `${table}-${sequence}` };
    inserts.push({ table, params, row });
    return { rows: [row] };
  }

  return {
    calls,
    inserts,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ text, params });
      if (/select id from properties/i.test(text)) {
        return { rows: params[0] === PROPERTY ? [{ id: PROPERTY }] : [] };
      }
      if (/select id, scope_type, scope_id from source_artifacts/i.test(text)) {
        if (params[0] === ARTIFACT) {
          return { rows: [{ id: ARTIFACT, scope_type: "property", scope_id: PROPERTY }] };
        }
        if (params[0] === OTHER_ARTIFACT) {
          return { rows: [{ id: OTHER_ARTIFACT, scope_type: "property", scope_id: OTHER_PROPERTY }] };
        }
        return { rows: [] };
      }
      if (/select id, provider_name from contracted_service_providers where id/i.test(text)) {
        return { rows: [{ id: params[0], provider_name: "Provider One" }] };
      }
      if (/select id, provider_name from contracted_service_providers\s+where lower/i.test(text)) {
        return { rows: providerCandidates };
      }
      if (/select \* from contracted_service_engagements/i.test(text)) {
        return { rows: params[0] === ENGAGEMENT && params[1] === PROPERTY
          ? [{ id: ENGAGEMENT, property_id: PROPERTY }] : [] };
      }
      if (/select \* from contracted_service_documents/i.test(text)) {
        return { rows: document && params[0] === document.id && params[1] === PROPERTY
          ? [document] : [] };
      }
      if (/select \* from contracted_service_terms/i.test(text)) {
        if (priorTerm && params[0] === priorTerm.id && params[1] === PROPERTY) {
          return { rows: [priorTerm] };
        }
        return { rows: params[0] === "term-a" && params[1] === PROPERTY
          ? [{ id: "term-a", property_id: PROPERTY, engagement_id: ENGAGEMENT }] : [] };
      }
      if (/select \* from contracted_service_financial_observations/i.test(text)) {
        return { rows: [{ id: params[0], property_id: PROPERTY }] };
      }
      if (/select id from obligations/i.test(text)) {
        return { rows: params[1] === obligationProperty ? [{ id: params[0] }] : [] };
      }
      const match = text.match(/insert into\s+(contracted_service_[a-z_]+)/i);
      if (match) return inserted(match[1], params);
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
}

function termInput(overrides = {}) {
  return {
    property_id: PROPERTY,
    engagement_id: ENGAGEMENT,
    document_id: "document-a",
    term_authority: "governing",
    commencement_date: "2026-01-01",
    initial_end_date: "2026-12-31",
    term_kind: "fixed",
    automatic_renewal: false,
    source_artifact_id: ARTIFACT,
    user_id: USER,
    ...overrides,
  };
}

async function main() {
  console.log("\nCONTRACTED SERVICES CANONICAL WRITER - TRUTH WALLS\n");

  await ok("an unsigned proposal cannot establish governing terms", async () => {
    const db = fakeClient();
    await rejects(() => service.recordTerm(db, termInput()),
      /EXECUTED_GOVERNING_SOURCE_REQUIRED.*executed agreement/i);
    assert(!db.inserts.some(({ table }) => table === "contracted_service_terms"));
  });

  await ok("an unsigned proposal may retain offered terms", async () => {
    const db = fakeClient();
    await service.recordTerm(db, termInput({ term_authority: "offered" }));
    assert(db.inserts.some(({ table }) => table === "contracted_service_terms"));
  });

  await ok("an executed agreement may establish governing terms", async () => {
    const db = fakeClient({ document: {
      id: "document-a", property_id: PROPERTY, engagement_id: ENGAGEMENT,
      source_artifact_id: ARTIFACT, document_kind: "agreement", execution_state: "executed",
    } });
    await service.recordTerm(db, termInput());
    assert(db.inserts.some(({ table }) => table === "contracted_service_terms"));
  });

  await ok("a fixed term may preserve an installation trigger and stated duration", async () => {
    const db = fakeClient({ document: {
      id: "document-a", property_id: PROPERTY, engagement_id: ENGAGEMENT,
      source_artifact_id: ARTIFACT, document_kind: "agreement", execution_state: "executed",
    } });
    await service.recordTerm(db, termInput({
      commencement_date: null, initial_end_date: null,
      commencement_trigger: "Installation and activation of the service",
      initial_term_months: 12,
    }));
    assert(db.inserts.some(({ table }) => table === "contracted_service_terms"));
    await rejects(() => service.recordTerm(db, termInput({
      commencement_date: null, initial_end_date: null,
      commencement_trigger: "Installation and activation of the service",
    })), /BAD_INPUT.*commencement trigger and initial duration/i);
  });

  await ok("cross-property evidence is rejected before a document is written", async () => {
    const db = fakeClient();
    await rejects(() => service.confirmDocument(db, {
      property_id: PROPERTY, source_artifact_id: OTHER_ARTIFACT,
      document_kind: "proposal", execution_state: "unsigned", user_id: USER,
    }), /SOURCE_SCOPE_MISMATCH.*same property/i);
    assert(!db.inserts.some(({ table }) => table === "contracted_service_documents"));
  });

  await ok("a correction retains commencement date and states its reason", async () => {
    const db = fakeClient({
      document: {
        id: "document-a", property_id: PROPERTY, engagement_id: ENGAGEMENT,
        source_artifact_id: ARTIFACT, document_kind: "agreement", execution_state: "executed",
      },
      priorTerm: {
        id: "prior-term", property_id: PROPERTY, engagement_id: ENGAGEMENT,
        commencement_date: "2026-01-01",
      },
    });
    await rejects(() => service.recordTerm(db, termInput({
      supersedes_id: "prior-term", revision_reason: "Corrected end date",
      commencement_date: "2026-02-01",
    })), /BAD_INPUT.*retain.*commencement_date/i);
    await rejects(() => service.recordTerm(db, termInput({
      supersedes_id: "prior-term",
    })), /REVISION_REASON_REQUIRED/i);
    await service.recordTerm(db, termInput({
      supersedes_id: "prior-term", revision_reason: "Corrected end date",
    }));
  });

  await ok("an event-term correction retains its commencement trigger", async () => {
    const db = fakeClient({
      priorTerm: { id: "prior-term", property_id: PROPERTY, engagement_id: ENGAGEMENT,
        commencement_date: null, commencement_trigger: "Installation of the service" },
    });
    await rejects(() => service.recordTerm(db, termInput({
      term_authority: "offered", commencement_date: null, initial_end_date: null,
      commencement_trigger: "Activation of the service", initial_term_months: 12,
      supersedes_id: "prior-term", revision_reason: "Changed trigger",
    })), /BAD_INPUT.*retain.*commencement_trigger/i);
  });

  await ok("automatic renewal requires its stated renewal period", async () => {
    const db = fakeClient();
    await rejects(() => service.recordTerm(db, termInput({
      term_authority: "offered", automatic_renewal: true,
    })), /BAD_INPUT.*renewal period/i);
  });

  await ok("dates are real calendar values and effective ranges move forward", async () => {
    const db = fakeClient();
    await rejects(() => service.recordRequirement(db, {
      property_id: PROPERTY, service_class: "snow_removal",
      determination: "contracted_service_required", effective_from: "2026-02-30",
      provenance_note: "Operator confirmed", user_id: USER,
    }), /BAD_INPUT.*ISO date/i);
    await rejects(() => service.createEngagement(db, {
      property_id: PROPERTY, service_class: "snow_removal", provider_id: "provider-a",
      effective_from: "2026-12-01", effective_to: "2026-01-01",
      provenance_note: "Operator confirmed", user_id: USER,
    }), /BAD_INPUT.*effective_to must be after effective_from/i);
  });

  await ok("renewal flags reject string lookalikes", async () => {
    const db = fakeClient();
    await rejects(() => service.recordTerm(db, termInput({
      term_authority: "offered", automatic_renewal: "false",
    })), /BAD_INPUT.*automatic_renewal must be true or false/i);
  });

  await ok("a term cannot cite evidence other than its linked document", async () => {
    const db = fakeClient();
    await rejects(() => service.recordTerm(db, termInput({
      term_authority: "offered", source_artifact_id: "artifact-c",
    })), /BAD_INPUT.*source attached to their service document/i);
  });

  await ok("unknown variable pricing stays descriptive instead of becoming zero", async () => {
    const db = fakeClient();
    await service.recordPriceComponent(db, {
      property_id: PROPERTY, term_id: "term-a", price_basis: "variable",
      amount_cents: null, description: "Per occurrence; rate not established", user_id: USER,
    });
    await rejects(() => service.recordPriceComponent(db, {
      property_id: PROPERTY, term_id: "term-a", price_basis: "monthly",
      amount_cents: null, user_id: USER,
    }), /BAD_INPUT.*requires amount_cents/i);
    await rejects(() => service.recordPriceComponent(db, {
      property_id: PROPERTY, term_id: "term-a", price_basis: "monthly", user_id: USER,
    }), /BAD_INPUT.*requires amount_cents/i);
  });

  await ok("a financial observation requires retained evidence and identification", async () => {
    const db = fakeClient();
    await rejects(() => service.recordFinancialObservation(db, {
      property_id: PROPERTY, observation_kind: "invoice", line_label: "Cleaning",
      user_id: USER,
    }), /SOURCE_REQUIRED/i);
    await rejects(() => service.recordFinancialObservation(db, {
      property_id: PROPERTY, source_artifact_id: ARTIFACT,
      observation_kind: "invoice", user_id: USER,
    }), /BAD_INPUT.*must identify/i);
    await service.recordFinancialObservation(db, {
      property_id: PROPERTY, source_artifact_id: ARTIFACT,
      observation_kind: "invoice", line_label: "Cleaning", amount_cents: 680000,
      user_id: USER,
    });
    assert(!db.inserts.some(({ table }) => /payment|payable/.test(table)));
  });

  await ok("a decision link cannot borrow another property's obligation", async () => {
    const db = fakeClient({ obligationProperty: OTHER_PROPERTY });
    await rejects(() => service.linkDecision(db, {
      property_id: PROPERTY, engagement_id: ENGAGEMENT, obligation_id: "obligation-a",
      decision_kind: "renewal_review", user_id: USER,
    }), /NOT_FOUND.*this property/i);
  });

  await ok("provider lookup suggests reuse without silently merging identities", async () => {
    const db = fakeClient({ providerCandidates: [
      { id: "provider-a", provider_name: "Angel Cleaning Services LLC" },
    ] });
    const candidates = await service.findProviderCandidates(db, {
      provider_name: "angel cleaning services llc",
    });
    assert.strictEqual(candidates.length, 1);
    assert(!db.inserts.length);
    await service.establishProvider(db, {
      property_id: PROPERTY, provider_name: "Angel Cleaning Services LLC",
      source_artifact_id: ARTIFACT, user_id: USER,
    });
    assert(db.inserts.some(({ table }) => table === "contracted_service_providers"));
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
