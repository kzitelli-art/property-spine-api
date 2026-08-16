"use strict";

const assert = require("assert");
const svc = require("../src/asset/equity_position_service.js");
const read = require("../src/asset/equity_position_read.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${e.message}`);
  }
}

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rows === undefined ? [{ id: "recorded" }] : rows };
    },
  };
}

function preferred(overrides) {
  return {
    position_id: "position-1",
    term_source: "secondary_summary",
    source_authority: "secondary_summary",
    minimum_dividend_schedule_text: "8% to 12.5%",
    effective_from: "2020-07-31",
    source_artifact_id: "artifact-1",
    recorded_by_user_id: "user-1",
    ...overrides,
  };
}

function internalNote(overrides) {
  return {
    position_id: "position-1",
    claim_source: "internal_note",
    amount_cents: 370000000,
    as_of_date: "2026-03-30",
    source_artifact_id: "artifact-1",
    recorded_by_user_id: "user-1",
    ...overrides,
  };
}

(async () => {
  console.log("\nEquity writer guards");

  await test("secondary summaries cannot establish an additive relationship", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addPreferredTerms(db, preferred({
        minimum_dividend_relationship_to_preferred_return: "additive",
      })),
      (e) => e.code === "EQUITY_MINIMUM_DIVIDEND_RELATIONSHIP_UNGOVERNED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("governed authority still requires a retained source artifact", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addPreferredTerms(db, preferred({
        term_source: "governing_document",
        source_authority: "governed_read",
        source_artifact_id: null,
        minimum_dividend_relationship_to_preferred_return: "offset",
      })),
      (e) => e.code === "EQUITY_MINIMUM_DIVIDEND_RELATIONSHIP_UNGOVERNED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("not_established remains recordable from a secondary summary", async () => {
    const db = fakeDb();
    await svc.addPreferredTerms(db, preferred({}));
    assert.strictEqual(db.calls.length, 1);
    assert.strictEqual(db.calls[0].params[9], "not_established");
  });

  await test("a governed artifact may establish a resolved relationship", async () => {
    const db = fakeDb();
    await svc.addPreferredTerms(db, preferred({
      term_source: "governing_document",
      source_authority: "governed_read",
      minimum_dividend_relationship_to_preferred_return: "other",
    }));
    assert.strictEqual(db.calls.length, 1);
    assert.strictEqual(db.calls[0].params[9], "other");
  });

  await test("preferred terms refuse a non-preferred parent", async () => {
    const db = fakeDb([]);
    await assert.rejects(
      svc.addPreferredTerms(db, preferred({
        term_source: "governing_document",
        source_authority: "governed_read",
      })),
      (e) => e.code === "EQUITY_POSITION_CLASS_MISMATCH"
    );
    assert.strictEqual(db.calls.length, 1);
    assert(/position_class = 'preferred'/.test(db.calls[0].sql));
  });

  await test("common overrides refuse a non-common parent", async () => {
    const db = fakeDb([]);
    await assert.rejects(
      svc.addPositionOverride(db, {
        position_id: "position-1",
        override_kind: "other",
        override_text: "not applicable",
        execution_status: "draft_unexecuted",
        source_authority: "governed_read",
        effective_from: "2020-07-31",
        source_artifact_id: "artifact-1",
        recorded_by_user_id: "user-1",
      }),
      (e) => e.code === "EQUITY_POSITION_CLASS_MISMATCH"
    );
    assert.strictEqual(db.calls.length, 1);
    assert(/position_class = 'common'/.test(db.calls[0].sql));
  });

  await test("an unsourced position is refused before SQL", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addPosition(db, {
        property_id: "property-1",
        issuer_legal_entity_id: "issuer-1",
        position_class: "common",
        holder_name_text: "Unsourced Holder",
        effective_from: "2026-01-01",
        recorded_by_user_id: "user-1",
      }),
      (e) => e.code === "EQUITY_PROVENANCE_REQUIRED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("a position cannot supersede a different economic slot", async () => {
    const db = fakeDb([]);
    await assert.rejects(
      svc.addPosition(db, {
        property_id: "property-1",
        issuer_legal_entity_id: "issuer-1",
        position_class: "common",
        holder_name_text: "Successor Holder",
        effective_from: "2026-01-01",
        supersedes_position_id: "prior-position-1",
        source_artifact_id: "assignment-1",
        recorded_by_user_id: "user-1",
      }),
      (e) => e.code === "EQUITY_POSITION_SUPERSESSION_MISMATCH"
    );
    assert.strictEqual(db.calls.length, 1);
    assert(/prior\.property_id = \$1/.test(db.calls[0].sql));
    assert(/prior\.issuer_legal_entity_id = \$2/.test(db.calls[0].sql));
    assert(/prior\.position_class = \$3/.test(db.calls[0].sql));
    assert(/prior\.effective_from <= \$6/.test(db.calls[0].sql));
    assert(/successor\.supersedes_position_id = prior\.id/.test(db.calls[0].sql));
  });

  await test("a supersession requires the transfer artifact", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addPosition(db, {
        property_id: "property-1",
        issuer_legal_entity_id: "issuer-1",
        position_class: "common",
        holder_name_text: "Successor Holder",
        effective_from: "2026-01-01",
        supersedes_position_id: "prior-position-1",
        provenance_note: "verbal report",
        recorded_by_user_id: "user-1",
      }),
      (e) => e.code === "EQUITY_POSITION_SUPERSESSION_UNGOVERNED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("a successor retires the prior holder on its effective date", async () => {
    const history = {
      positions: [
        {
          id: "position-old",
          property_id: "property-1",
          issuer_legal_entity_id: "issuer-1",
          position_class: "common",
          holder_legal_entity_id: null,
          holder_name_text: "Original Holder",
          effective_from: "2020-01-01",
          effective_to: null,
          supersedes_position_id: null,
        },
        {
          id: "position-new",
          property_id: "property-1",
          issuer_legal_entity_id: "issuer-1",
          position_class: "common",
          holder_legal_entity_id: null,
          holder_name_text: "Successor Holder",
          effective_from: "2026-01-01",
          effective_to: null,
          supersedes_position_id: "position-old",
        },
      ],
      common_class_terms: [],
      position_overrides: [],
      preferred_terms: [],
      pledges: [],
      amount_claims: [],
      conflicts: [],
    };
    const before = read.position(history, "2025-12-31");
    const after = read.position(history, "2026-01-01");
    assert.deepStrictEqual(before.positions.map((p) => p.holder.party_name_text), ["Original Holder"]);
    assert.deepStrictEqual(after.positions.map((p) => p.holder.party_name_text), ["Successor Holder"]);
  });

  await test("a conflict cannot point at another property's position", async () => {
    const db = fakeDb([]);
    await assert.rejects(
      svc.recordConflict(db, {
        property_id: "property-1",
        position_id: "position-2",
        conflict_kind: "holder_identity",
        claim_a_text: "claim A",
        claim_a_source_artifact_id: "artifact-a",
        claim_b_text: "claim B",
        claim_b_source_artifact_id: "artifact-b",
        noted_as_of: "2026-01-01",
        recorded_by_user_id: "user-1",
      }),
      (e) => e.code === "EQUITY_CONFLICT_PROPERTY_MISMATCH"
    );
    assert.strictEqual(db.calls.length, 1);
    assert(/p\.id = \$2 and p\.property_id = \$1/.test(db.calls[0].sql));
  });

  await test("an unattributed internal note is refused before SQL", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addCapitalAmountClaim(db, internalNote({})),
      (e) => e.code === "EQUITY_INTERNAL_NOTE_ATTRIBUTION_REQUIRED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("whitespace is not a speaker", async () => {
    const db = fakeDb();
    await assert.rejects(
      svc.addCapitalAmountClaim(db, internalNote({ asserted_by_text: "   " })),
      (e) => e.code === "EQUITY_INTERNAL_NOTE_ATTRIBUTION_REQUIRED"
    );
    assert.strictEqual(db.calls.length, 0);
  });

  await test("a named internal-note speaker is retained", async () => {
    const db = fakeDb();
    await svc.addCapitalAmountClaim(db, internalNote({ asserted_by_text: "Rob Vernicek" }));
    assert.strictEqual(db.calls.length, 1);
    assert.strictEqual(db.calls[0].params[2], "Rob Vernicek");
  });

  await test("the canonical history read carries the holder's governed legal name", async () => {
    const db = {
      async query(sql) {
        if (/from capital_stack_positions p/.test(sql)) {
          return { rows: [{
            id: "position-1",
            property_id: "property-1",
            issuer_legal_entity_id: "issuer-1",
            position_class: "preferred",
            holder_legal_entity_id: "holder-1",
            holder_name_text: null,
            holder_legal_name: "MSC 4125 Chestnut LLC",
            effective_from: "2020-07-31",
            effective_to: null,
          }] };
        }
        return { rows: [] };
      },
    };
    const history = await svc.loadHistory(db, "property-1");
    const reading = read.position(history, "2026-08-16");
    assert.strictEqual(reading.positions[0].holder.legal_name, "MSC 4125 Chestnut LLC");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
