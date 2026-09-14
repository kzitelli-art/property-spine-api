"use strict";
// ════════════════════════════════════════════════════════════════════
//  compliance_ask_spine.test.js — the Compliance projection Ask Spine
//  is handed, asserted on its shape rather than on the screen's.
//
//  WHY THIS FILE EXISTS
//  --------------------
//  It did not. Every other registered Asset Management domain had one —
//  debt_ask_spine, equity_ask_spine, utility_ask_spine,
//  contracted_service_ask_spine — and compliance was named as a
//  regression target twice before anyone checked that the file was there.
//  The entitlement matrix covers WHO may read compliance; nothing covered
//  WHAT they get when they may. This is that half.
//
//  Built in the shape of debt's: a synthetic canonical reading injected
//  through the reader seam, then the projection asserted field by field.
//  No database, no network, no fixture file.
//
//  THE TWO THINGS IT REALLY GUARDS
//  -------------------------------
//  1. The envelope fields survive. A projection that silently loses
//     `standing`, `why` or `unresolved` still renders on a screen and
//     still answers a question — with less truth behind it than the
//     reader returned, and nothing failing.
//  2. NO RECORD ID ESCAPES (§40.8). References are minted server-side and
//     the model is handed roles, never identities: "a model holding an id
//     can compose a link Spine did not resolve." The reader's own record
//     ids are seeded into this fixture precisely so their absence from
//     the projection is a measurement and not an assumption.
//
//  CLASS 1 — permanent.
// ════════════════════════════════════════════════════════════════════
const assert = require("assert");
const ask = require("../../src/agent/ask_spine_answer.js");

const PROPERTY = "property-compliance";
//  Seeded so the leak assertion has something real to look for. Synthetic.
const RECORD_ID = "record-11111111-2222-3333-4444-555555555555";
const SOURCE_ID = "source-99999999-8888-7777-6666-555555555555";
const OPENER_TOKEN = "opener-token-do-not-leak";

let passed = 0;
async function ok(label, check) {
  await check();
  passed += 1;
  console.log(`  ok    ${label}`);
}

function standing() {
  return {
    contract_version: "compliance.v1",
    capability_classes: { retrieval: true, comparison: false, causal_explanation: false },
    composition_authorization: "unsolved",
    as_of: "2026-09-14",
    coverage: { licenses: "covered", inspections: "covered", violations: "covered" },
    items: [{
      entity: { type: "license", compliance_type: "rental_license",
        label: "Rental License 0001", id: RECORD_ID },
      standing: "current",
      why: "Issued 2026-01-01, expires 2027-01-01; the certificate is retained.",
      evidence: [{ role: "canonical_record", label: "License certificate",
        record_id: RECORD_ID, source_id: SOURCE_ID }],
      unresolved: null,
      next: { requirement: "renewal", due_date: "2026-12-01" },
      attention: "none",
      references: [{ role: "canonical_record", label: "License certificate",
        opener: { token: OPENER_TOKEN } }],
    }, {
      entity: { type: "inspection", compliance_type: "fire_inspection",
        label: "Fire Inspection", id: RECORD_ID },
      standing: "not_established",
      why: "No inspection record is retained for this period.",
      evidence: [],
      unresolved: "no_record_retained",
      next: null,
      attention: "required",
      references: [],
    }],
    references: [{ role: "canonical_record", label: "License certificate",
      opener: { token: OPENER_TOKEN } }],
  };
}

const NO_DB = { query() { throw new Error("this test must not touch a database"); } };
const complianceReader = (overrides = {}) => ({
  async readComplianceStanding(_db, args) {
    if (overrides.spy) overrides.spy.args = args;
    if (overrides.error) throw overrides.error;
    return overrides.standing || standing();
  },
});
const gather = (modules, extra = {}) => ask.gatherFacts(NO_DB, {
  property_id: PROPERTY, allowed_modules: modules, subject: "compliance",
  question: "are our licenses current", complianceReader: complianceReader(extra),
  mintComplianceReference: (r) => r,
});

async function main() {
  console.log("\nCOMPLIANCE ASK SPINE\n");

  await ok("compliance language selects Compliance", async () => {
    assert.strictEqual(ask.questionSubject("are our licenses current"), "compliance");
    assert.strictEqual(ask.questionSubject("what inspections are due"), "compliance");
  });

  await ok("the entitled projection carries the contract envelope", async () => {
    const f = await gather(["asset_management"]);
    assert.ok(f.compliance, "compliance was not gathered for an entitled session");
    assert.strictEqual(f.compliance.contract_version, "compliance.v1");
    assert.strictEqual(f.compliance.as_of, "2026-09-14");
    assert.deepStrictEqual(f.compliance.capability_classes,
      { retrieval: true, comparison: false, causal_explanation: false });
    //  §40.10 — retrieval is claimed, comparison and cause are not.
    assert.strictEqual(f.compliance.capability_classes.comparison, false);
    assert.strictEqual(f.compliance.capability_classes.causal_explanation, false);
    //  §40.8 — the cross-domain question is recorded as unsolved, not silently allowed.
    assert.strictEqual(f.compliance.composition_authorization, "unsolved");
    assert.ok(f.compliance.coverage, "coverage must say what the read covered");
  });

  await ok("every item keeps standing, why, unresolved, next and attention", async () => {
    const f = await gather(["asset_management"]);
    assert.strictEqual(f.compliance.items.length, 2);
    const [license, inspection] = f.compliance.items;
    assert.strictEqual(license.entity.type, "license");
    assert.strictEqual(license.entity.compliance_type, "rental_license");
    assert.strictEqual(license.entity.label, "Rental License 0001");
    assert.strictEqual(license.standing, "current");
    assert.ok(license.why && license.why.length > 0, "a standing without a why is a verdict");
    assert.strictEqual(license.unresolved, null);
    assert.strictEqual(license.attention, "none");
    //  NOT_ESTABLISHED is its own answer and must not read as "fine".
    assert.strictEqual(inspection.standing, "not_established");
    assert.strictEqual(inspection.unresolved, "no_record_retained");
    assert.strictEqual(inspection.attention, "required");
    assert.strictEqual(inspection.next, null);
  });

  await ok("evidence is carried as role and label — never as a record identity", async () => {
    const f = await gather(["asset_management"]);
    const evidence = f.compliance.items[0].evidence;
    assert.strictEqual(evidence.length, 1);
    assert.deepStrictEqual(Object.keys(evidence[0]).sort(), ["label", "role"]);
    assert.strictEqual(evidence[0].role, "canonical_record");
    //  And references reach the model as ROLES only.
    assert.deepStrictEqual(f.compliance.items[0].reference_roles, ["canonical_record"]);
  });

  await ok("NO RECORD ID, SOURCE ID OR OPENER TOKEN ESCAPES INTO MODEL CONTEXT", async () => {
    const f = await gather(["asset_management"]);
    const blob = JSON.stringify(f.compliance);
    for (const secret of [RECORD_ID, SOURCE_ID, OPENER_TOKEN]) {
      assert.ok(!blob.includes(secret),
        `the projection leaked ${secret}: ${blob.slice(0, 200)}`);
    }
    //  The seeded ids ARE in the reader's output, so their absence above is
    //  a measurement of the projection and not of an empty fixture.
    assert.ok(JSON.stringify(standing()).includes(RECORD_ID));
    assert.ok(JSON.stringify(standing()).includes(OPENER_TOKEN));
  });

  await ok("the reader is asked for this property, on a dated basis", async () => {
    const spy = {};
    await gather(["asset_management"], { spy });
    assert.strictEqual(spy.args.property_id, PROPERTY);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(spy.args.as_of)),
      `as_of must be a date, got ${JSON.stringify(spy.args.as_of)}`);
  });

  await ok("a broken read is READ_FAILED — never an empty compliance picture", async () => {
    const f = await gather(["asset_management"], { error: new Error("owned failure") });
    assert.strictEqual(f.compliance.read_state, "READ_FAILED");
    assert.strictEqual(f.compliance.items, undefined,
      "a failed read must not present itself as zero items");
    //  §40.7 — a reader that did not return makes composite silence BLIND.
    assert.strictEqual(f.composite_silence.state, "BLIND");
  });

  await ok("an unentitled session gets no compliance facts at all", async () => {
    for (const modules of [[], ["leasing"], ["management"], ["maintenance"]]) {
      const f = await gather(modules);
      assert.strictEqual(f.compliance, undefined,
        `modules ${JSON.stringify(modules)} received a compliance fact`);
      //  Absence is not a silence of the property (§40.7), and absence is
      //  not a refusal either — it must not appear under `withheld`.
      assert.notStrictEqual(f.composite_silence.state, "BLIND");
      assert.ok(!(f.composite_silence.withheld || [])
        .some((w) => w.domain === "compliance"));
    }
  });

  console.log(`\n${passed} assertions passed\n`);
}

main().catch((error) => { console.error(error); process.exit(1); });
