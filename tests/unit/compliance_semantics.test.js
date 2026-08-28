#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const contracts = require("../../src/asset/compliance_contracts.js");
const factContracts = require("../../src/asset/compliance_fact_contracts.js");
const semantics = require("../../src/asset/compliance_semantics.js");
const projection = require("../../src/asset/compliance_projection.js");
const solo = require("./fixtures/compliance/solo_license_periods.js");

const EXPECTED_ASSERTIONS = 78;
let pass = 0, fail = 0;
function ok(label, condition, detail) {
  if (condition) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}
function rejects(label, fn) {
  let rejected = false;
  try { fn(); } catch (_) { rejected = true; }
  ok(label, rejected);
}

const sourceReference = solo.sourceReference("Finding source", "finding-source");
const recordReference = {
  contract_version: contracts.VERSIONS.reference,
  role: "canonical_record",
  label: "City rental license #922616",
  opener: { kind: "server_minted", token: "license-record" },
};
const findingRecordReference = {
  contract_version: contracts.VERSIONS.reference,
  role: "canonical_record",
  label: "Finding F-100",
  opener: { kind: "server_minted", token: "finding-record" },
};

function fact(factType, factId, establishedAt, value, role = "supporting", overrides = {}) {
  return {
    contract_version: factContracts.FACT_VERSION,
    fact_id: factId,
    fact_type: factType,
    established_at: establishedAt,
    supersedes_fact_id: null,
    correction_reason: null,
    value,
    evidence: [{ role, label: `${factType} evidence`, reference: sourceReference }],
    ...overrides,
  };
}

const issued = fact("finding_issued", "finding-issued", "2026-06-01T12:00:00Z", {
  issued_on: "2026-06-01", summary: "Authority issued a finding.",
}, "finding");
const payment = fact("payment_observed", "finding-payment", "2026-06-03T12:00:00Z", {
  observed_on: "2026-06-03", amount_cents: 25000, currency_code: "USD",
}, "payment");
const cure = fact("cure_performed", "finding-cure", "2026-06-05T12:00:00Z", {
  performed_on: "2026-06-05", summary: "The cited condition was repaired.",
}, "cure");
const closed = fact("authority_disposition", "finding-closed", "2026-06-10T12:00:00Z", {
  decided_on: "2026-06-10", disposition: "closed", summary: "Authority recorded closure.",
}, "authority_disposition");

const unknownCoverage = {
  state: "unknown",
  meaning: "No complete census of property requirements has been established.",
};
const credentialSpec = {
  kind: "credential",
  entity: {
    type: "credential", compliance_type: "rental_license",
    record_id: "license-922616", label: "City rental license #922616",
  },
  facts: [solo.priorPeriod, solo.successorPeriod],
  action_condition: null,
  record_reference: recordReference,
};
const findingSpec = {
  kind: "finding",
  entity: {
    type: "finding", compliance_type: "authority_finding",
    record_id: "finding-f-100", label: "Finding F-100",
  },
  facts: [issued, payment, cure, closed],
  action_condition: null,
  record_reference: findingRecordReference,
};

console.log("COMPLIANCE SEMANTICS - typed facts, history, standing, attention, projection");

for (const candidate of [solo.priorPeriod, issued, payment, cure, closed]) {
  ok(`${candidate.fact_type} has an exact governed contract`,
    factContracts.validateFact(candidate) === candidate);
}
rejects("arbitrary fact types are refused", () => factContracts.validateFact({ ...issued, fact_type: "anything" }));
rejects("typed values refuse arbitrary JSON", () => factContracts.validateFact({
  ...issued, value: { ...issued.value, arbitrary: true },
}));
rejects("a correction cannot omit its reason", () => factContracts.validateFact({
  ...solo.priorPeriod, supersedes_fact_id: "older-period",
}));
rejects("a credential period cannot end before it begins", () => factContracts.validateFact({
  ...solo.priorPeriod, value: { effective_from: "2025-05-02", effective_through: "2025-05-01" },
}));
rejects("canonical facts require evidence", () => factContracts.validateFact({
  ...solo.priorPeriod, evidence: [],
}));

const twoPeriods = semantics.buildEffectiveHistory([solo.priorPeriod, solo.successorPeriod]);
ok("the prior source-backed period is exact",
  solo.priorPeriod.value.effective_from === "2025-05-02" &&
  solo.priorPeriod.value.effective_through === "2026-05-01");
ok("the successor source-backed period is exact",
  solo.successorPeriod.value.effective_from === "2026-04-30" &&
  solo.successorPeriod.value.effective_through === "2027-05-01");
ok("both real Solo periods remain in readable history", twoPeriods.entries.length === 2);
ok("a successor period is an establishment, not a correction",
  twoPeriods.entries.every((entry) => entry.change === "establishment"));
ok("a successor period does not supersede the prior period", twoPeriods.effective_facts.length === 2);
ok("the historical Solo period remains readable",
  twoPeriods.entries.some((entry) => entry.fact.value.effective_through === "2026-05-01"));
ok("the source-backed overlap is surfaced as conflicted",
  semantics.deriveCredentialStanding(
    [solo.priorPeriod, solo.successorPeriod], "2026-05-01").code === "conflicted");

const mistakenPeriod = {
  ...solo.priorPeriod,
  fact_id: "mistaken-period",
  value: { effective_from: "2025-05-01", effective_through: "2026-05-01" },
};
const correctedPeriod = {
  ...solo.priorPeriod,
  fact_id: "corrected-period",
  established_at: "2026-08-13T14:02:00Z",
  supersedes_fact_id: "mistaken-period",
  correction_reason: "Corrected the transcribed effective date from the authority-issued credential.",
};
const correctedHistory = semantics.buildEffectiveHistory([mistakenPeriod, correctedPeriod]);
ok("a correction is identified as a correction", correctedHistory.entries[1].change === "correction");
ok("a correction retains its reason", correctedHistory.entries[1].fact.correction_reason.includes("transcribed"));
ok("a superseded fact is excluded from effective facts",
  !correctedHistory.effective_facts.some((entry) => entry.fact_id === "mistaken-period"));
ok("a superseded fact remains readable in history",
  correctedHistory.entries.some((entry) => entry.fact.fact_id === "mistaken-period"));
rejects("a correction cannot target an unknown fact", () => semantics.buildEffectiveHistory([correctedPeriod]));
rejects("a correction cannot cross fact types", () => semantics.buildEffectiveHistory([
  issued,
  { ...cure, supersedes_fact_id: issued.fact_id, correction_reason: "Wrong type." },
]));
rejects("duplicate canonical fact ids are refused", () =>
  semantics.buildEffectiveHistory([solo.priorPeriod, solo.priorPeriod]));
const correctionBranch = {
  ...correctedPeriod,
  fact_id: "second-correction-branch",
  established_at: "2026-08-13T14:03:00Z",
  value: { effective_from: "2025-05-03", effective_through: "2026-05-01" },
};
ok("branched live corrections derive conflicted",
  semantics.deriveCredentialStanding(
    [mistakenPeriod, correctedPeriod, correctionBranch], "2025-05-10").code === "conflicted");

const current = semantics.deriveCredentialStanding([solo.priorPeriod, solo.successorPeriod], "2025-07-01");
ok("a covering established period derives current", current.code === "current");
ok("current names the exact as-of date", current.as_of === "2025-07-01");
ok("current is based on the covering period", current.why.effective_from === "2025-05-02");
const future = semantics.deriveCredentialStanding([solo.successorPeriod], "2026-04-29");
ok("a future-only established period derives not_yet_effective", future.code === "not_yet_effective");
const ended = semantics.deriveCredentialStanding([solo.priorPeriod, solo.successorPeriod], "2027-06-01");
ok("ended history derives no_current_period_established", ended.code === "no_current_period_established");
ok("ended history does not state that no valid license exists",
  !JSON.stringify(ended).toLowerCase().includes("no valid license"));
const absent = semantics.deriveCredentialStanding([], "2026-06-01");
ok("insufficient canonical facts derive not_established", absent.code === "not_established");
const overlap = fact("credential_period", "overlap", "2026-08-13T14:03:00Z", {
  effective_from: "2025-05-01", effective_through: "2025-06-01",
}, "issuance");
const conflict = semantics.deriveCredentialStanding([solo.priorPeriod, overlap], "2025-05-15");
ok("contradictory covering facts derive conflicted", conflict.code === "conflicted");
const correctedStanding = semantics.deriveCredentialStanding([mistakenPeriod, correctedPeriod], "2025-05-01");
ok("a superseded period cannot produce current standing", correctedStanding.code === "not_yet_effective");
const semanticsSource = fs.readFileSync(path.join(__dirname, "../../src/asset/compliance_semantics.js"), "utf8");
ok("standing derivation has no implicit clock", !/Date\.now|new Date\s*\(\s*\)/.test(semanticsSource));
rejects("standing derivation refuses a malformed as-of date", () =>
  semantics.deriveCredentialStanding([solo.priorPeriod], "2025-02-30"));
ok("credential derivation emits no legal compliance conclusion", !/compliant/i.test(JSON.stringify(current)));
ok("expiration does not create an obligation", !("obligation_id" in ended));

const open = semantics.deriveFindingStanding([issued], "2026-06-02");
ok("an issued finding without closure derives open", open.code === "open");
const paid = semantics.deriveFindingStanding([issued, payment], "2026-06-04");
ok("payment does not move finding standing", paid.code === "open");
ok("payment is not causal evidence for finding standing", !paid.decisive_fact_ids.includes(payment.fact_id));
const cured = semantics.deriveFindingStanding([issued, cure], "2026-06-06");
ok("a recorded cure awaits authority", cured.code === "cure_recorded_awaiting_authority");
ok("a cure does not claim authority closure", cured.code !== "authority_closed");
const authorityClosed = semantics.deriveFindingStanding([issued, cure, closed], "2026-06-11");
ok("an authority disposition can derive authority_closed", authorityClosed.code === "authority_closed");
const noFinding = semantics.deriveFindingStanding([payment, cure], "2026-06-11");
ok("lifecycle observations without issuance derive not_established", noFinding.code === "not_established");
const secondIssued = { ...issued, fact_id: "second-finding-issued", established_at: "2026-06-01T13:00:00Z" };
ok("multiple live issuances derive conflicted",
  semantics.deriveFindingStanding([issued, secondIssued], "2026-06-02").code === "conflicted");
const remainsOpen = fact("authority_disposition", "finding-remains-open", "2026-06-10T13:00:00Z", {
  decided_on: "2026-06-10", disposition: "remains_open", summary: "Authority left the finding open.",
}, "authority_disposition");
ok("conflicting latest authority dispositions derive conflicted",
  semantics.deriveFindingStanding([issued, closed, remainsOpen], "2026-06-11").code === "conflicted");
const laterOpen = { ...remainsOpen, fact_id: "finding-later-open", value: { ...remainsOpen.value, decided_on: "2026-06-11" } };
ok("a later authority remains-open disposition derives open",
  semantics.deriveFindingStanding([issued, cure, closed, laterOpen], "2026-06-12").code === "open");

ok("no action condition yields no established attention",
  semantics.deriveAttention(null, "2026-06-10").state === "none_established");
const upcomingCondition = {
  state: "established", action: "Submit authority response",
  due_on: "2026-06-12", obligation_id: "obligation-1",
};
ok("a future established condition yields upcoming",
  semantics.deriveAttention(upcomingCondition, "2026-06-10").state === "upcoming");
ok("a due-today established condition yields action_required",
  semantics.deriveAttention({ ...upcomingCondition, due_on: "2026-06-10" }, "2026-06-10").state === "action_required");
ok("a past-due established condition yields overdue",
  semantics.deriveAttention({ ...upcomingCondition, due_on: "2026-06-09" }, "2026-06-10").state === "overdue");
rejects("attention refuses an unlinked action condition", () =>
  semantics.deriveAttention({ ...upcomingCondition, obligation_id: null }, "2026-06-10"));
rejects("attention refuses an implicit or malformed clock", () =>
  semantics.deriveAttention(upcomingCondition, "today"));

const standingProjection = projection.buildStandingProjection({
  as_of: "2025-07-01", coverage: unknownCoverage, items: [credentialSpec],
});
ok("the governed standing projection validates", contracts.validateStanding(standingProjection) === standingProjection);
ok("projection emits the pure standing", standingProjection.items[0].standing.code === "current");
ok("projection emits why", standingProjection.items[0].why.basis === "established_credential_period");
ok("projection emits evidence summaries", standingProjection.items[0].evidence[0].role === "issuance");
ok("projection emits semantic references", standingProjection.references.every((ref) => ref.opener.kind === "server_minted"));
ok("projection emits unknown coverage honestly", standingProjection.coverage.state === "unknown");
ok("unknown coverage travels as unresolved",
  standingProjection.items[0].unresolved.some((item) => item.code === "requirement_census_unknown"));
ok("unknown coverage never becomes everything-is-fine",
  !/everything is fine|compliant/i.test(JSON.stringify(standingProjection)));
ok("projection exposes no raw artifact id", !/artifact_id/.test(JSON.stringify(standingProjection)));
ok("projection exposes no route URL", !/https?:\/\//.test(JSON.stringify(standingProjection)));
ok("projection parks cross-domain composition",
  standingProjection.composition_authorization === "unsolved_cross_domain");
ok("projection claims retrieval and no larger capability",
  standingProjection.capability_classes.retrieval.claim === "claimed" &&
  standingProjection.capability_classes.comparison.claim === "not_claimed" &&
  standingProjection.capability_classes.causal_explanation.claim === "not_claimed");
ok("an expiration date remains a date-only next event",
  standingProjection.items[0].next.state === "date_only");
ok("an ended credential period still has no action",
  projection.buildStandingProjection({
    as_of: "2027-06-01", coverage: unknownCoverage, items: [credentialSpec],
  }).items[0].attention.state === "none_established");

const actionProjection = projection.buildStandingProjection({
  as_of: "2026-06-10",
  coverage: unknownCoverage,
  items: [{ ...findingSpec, action_condition: upcomingCondition }],
});
ok("an established condition yields attention in projection",
  actionProjection.items[0].attention.state === "upcoming");
ok("an established condition, not expiration, yields the action next event",
  actionProjection.items[0].next.state === "action_established");
rejects("standing receipts refuse attention without a linked obligation", () =>
  contracts.validateStanding({
    ...actionProjection,
    items: [{
      ...actionProjection.items[0],
      attention: { state: "upcoming", obligation_id: null },
    }],
  }));

const detail = projection.buildDetailProjection({
  as_of: "2025-07-01", coverage: unknownCoverage, item: credentialSpec,
});
ok("the governed detail projection validates", contracts.validateDetail(detail) === detail);
ok("detail retains both real license periods", detail.history.length === 2);
ok("detail does not rewrite a new period as a correction",
  detail.history.every((event) => event.event === "period_established"));
const correctionDetail = projection.buildDetailProjection({
  as_of: "2025-05-02", coverage: unknownCoverage,
  item: { ...credentialSpec, facts: [mistakenPeriod, correctedPeriod] },
});
ok("detail retains a superseded historical fact", correctionDetail.history.length === 2);
ok("detail retains correction target and reason",
  correctionDetail.history[1].event === "fact_corrected" &&
  correctionDetail.history[1].supersedes_fact_id === "mistaken-period" &&
  correctionDetail.history[1].reason.includes("transcribed"));
const findingDetail = projection.buildDetailProjection({
  as_of: "2026-06-11", coverage: unknownCoverage, item: findingSpec,
});
ok("finding detail retains payment without treating it as cure",
  findingDetail.history.some((event) => event.event === "payment_observed") &&
  findingDetail.history.some((event) => event.event === "cure_performed"));
ok("finding projection rests closure on authority evidence",
  findingDetail.item.standing.code === "authority_closed" &&
  findingDetail.item.evidence.some((entry) => entry.role === "authority_disposition"));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_ASSERTIONS) {
  console.error(`Assertion census drift: expected ${EXPECTED_ASSERTIONS}, ran ${pass + fail}`);
  process.exit(2);
}
process.exit(fail ? 1 : 0);
