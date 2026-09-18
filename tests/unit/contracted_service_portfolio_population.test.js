"use strict";

const assert = require("assert");
const projection = require("../../src/asset/contracted_service_projection.js");
const portfolio = require("../support/contracted_service_portfolio_snapshots.js");

function read(factory) {
  return projection.project(factory(), { as_of: "2026-08-14" });
}

{
  const result = read(portfolio.solo4125);
  assert.strictEqual(result.detail.engagements.length, 2);
  assert.strictEqual(result.standing.unmatched_document_count, 2);
  assert.strictEqual(result.detail.unmatched_documents[0].execution_state, "unsigned");
  const printing = result.detail.engagements.find((row) =>
    row.label === "Resident printing amenity");
  assert.strictEqual(printing.financial_observations[0].provider_name, "PrintWithMe, LLC");
  assert.strictEqual(printing.financial_observations[0].amount_cents, 23460);
  assert.strictEqual(printing.term_standing.current.initial_term_months, 12);
  assert(/installation/i.test(printing.term_standing.current.commencement_trigger));
  const pestGap = result.detail.unresolved.find((gap) =>
    gap.financial_observation_id === "solo-obs-patriot");
  assert(pestGap.question.includes("replace or supplement Ehrlich Pest Control"));
  assert(!result.detail.unmatched_financial_observations.some((row) =>
    row.service_class === "landscaping"));
}

{
  const result = read(portfolio.skyline1417);
  assert.strictEqual(result.detail.engagements.length, 1);
  const elevator = result.detail.engagements[0];
  assert.strictEqual(elevator.provider.name, "Fujitec America, Inc.");
  assert.strictEqual(elevator.execution_standing, "EXECUTED_GOVERNING");
  assert.strictEqual(elevator.term_standing.state, "OUTCOME_NOT_ESTABLISHED");
  assert.strictEqual(elevator.term_standing.current.prices[0].amount_cents, 15000);
  assert.strictEqual(elevator.financial_observations[0].amount_cents, 17010);
  assert(result.detail.unmatched_financial_observations.some((row) =>
    row.provider_name === "David & Daisy's Janitorial Maid Services"));
  assert(!/renewed|current service authority is established/i.test(elevator.term_standing.reason));
}

{
  const result = read(portfolio.greenery1325);
  assert.strictEqual(result.detail.engagements.length, 1);
  const locker = result.detail.engagements[0];
  assert.strictEqual(locker.label, "Amazon package locker");
  assert.strictEqual(locker.execution_standing, "EXECUTED_GOVERNING");
  assert.strictEqual(locker.term_standing.state, "OUTCOME_NOT_ESTABLISHED");
  assert.strictEqual(locker.term_standing.milestone.kind, "term_dates_not_established");
  assert.strictEqual(locker.term_standing.current.initial_term_months, 60);
  assert(/installation and activation/i.test(locker.term_standing.current.commencement_trigger));
  assert.strictEqual(locker.term_standing.current.prices[0].amount_cents, 790000);
  assert.strictEqual(locker.financial_observations[0].amount_cents, 837400);
  assert(result.detail.unmatched_financial_observations.some((row) =>
    row.provider_name === "Otis Elevator Company" && row.amount_cents === 101371));
  assert(!result.detail.unmatched_financial_observations.some((row) =>
    ["fire_alarm_monitoring", "landscaping"].includes(row.service_class)));
}

console.log("contracted service portfolio population tests passed");
