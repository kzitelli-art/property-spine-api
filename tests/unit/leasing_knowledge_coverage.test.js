"use strict";
const assert = require("node:assert/strict");
const knowledge = require("../../src/leasing/leasing_knowledge");
const now = new Date("2026-09-10T12:00:00Z");
assert.equal(typeof knowledge.buildCoverage, "function", "canonical knowledge coverage projection exists");
const fact = (id, key, extra = {}) => ({id, fact_key:key, space_id:null, status:"active", effective_until:null, created_at:"2026-09-01T00:00:00Z", ...extra});
const rows = [
  fact("amenities-now", "amenities"),
  fact("amenities-old", "amenities", {status:"retired"}),
  fact("photo-expired", "photos", {effective_until:now.toISOString()}),
  fact("floor-retired", "floor_plans", {status:"retired"}),
  fact("space-tour", "virtual_tours", {space_id:"room-a"}),
  fact("legacy-policy", "pet_policy"),
];
const coverage = knowledge.buildCoverage(rows, now);
assert.deepEqual(coverage.counts, {total:10,current:1,missing:7,expired:1,retired:1});
const topic = key => coverage.items.find(row => row.fact_key === key);
assert.equal(topic("amenities").current.id, "amenities-now");
assert.deepEqual(topic("amenities").history.map(f=>f.id), ["amenities-old"]);
assert.equal(topic("photos").state, "expired");
assert.equal(topic("floor_plans").state, "retired");
assert.equal(topic("virtual_tours").state, "missing");
assert.equal(topic("virtual_tours").history.length, 0);
assert.deepEqual(knowledge.selectCurrentFacts(rows, now).map(f=>f.id), ["amenities-now","legacy-policy"]);
assert.equal(knowledge.buildCoverage([], now).counts.missing, 10);
assert.equal(knowledge.buildCoverage([fact("future", "photos", {effective_until:"2026-09-11T00:00:00Z"})], now).counts.current, 1);
assert.deepEqual(coverage.items.map(i=>i.fact_key), Object.keys(knowledge.TOPICS));
assert.ok(coverage.items.every(i=>i.prompts.length && i.owner_notice));
assert.throws(()=>knowledge.buildCoverage([], "invalid"), /valid/);
assert.match(coverage.note, /not.*complet/i);
console.log("PASS knowledge coverage: scoped current, expiry boundary, retired history, missing topics, legacy compatibility and catalog");
