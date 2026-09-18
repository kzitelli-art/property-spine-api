/* ════════════════════════════════════════════════════════════════════
   canonical_onboarding_ledger.db.js — CURRENT ROWS ESTABLISH INVENTORY;
   FUTURE ROWS ARE EVIDENCE ABOUT INVENTORY THAT ALREADY EXISTS.

   Synthetic and transaction-scoped. The harness deliberately places future
   rows before current rows so source order cannot grant inventory authority.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const loader = require("../../src/shared/snapshot_loader.js");
const { datedPropertyPositions } = require("../../src/tenancy/dated_positions.js");

const HARNESS = "canonical_onboarding_ledger.db.js";
const EXPECTED = 16;
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const local = /^(localhost|127\.0\.0\.1)$/i.test(new URL(CONN).hostname);
  const pool = new Pool({ connectionString: CONN, ssl: local ? false : { rejectUnauthorized: false } });
  const db = await pool.connect();
  try {
    await db.query("begin");
    const tag = `canonical-ledger-${Date.now()}`;
    const org = (await one(db,
      "insert into organizations (name) values ($1) returning id", [tag])).id;
    const user = (await one(db,
      `insert into users (name,email,is_active,status,platform_role,organization_id)
       values ('Canonical ledger proof',$1,true,'active','super_admin',$2) returning id`,
      [`${tag}@example.invalid`, org])).id;
    const property = (await one(db,
      `insert into properties (name,address,organization_id,leasing_basis)
       values ($1,'1 Evidence Way',$2,'bed') returning id`, [tag, org])).id;
    const deal = (await one(db,
      `insert into deal_intakes (onboarding_type,status,deal_name,organization_id)
       values ('existing_asset','classified',$1,$2) returning id`, [tag, org])).id;
    await db.query(
      "insert into deal_intake_properties (intake_id,property_id,status) values ($1,$2,'current')",
      [deal, property]);

    const rows = [
      // Deliberately first: it may resolve Room1 only after CURRENT creates it.
      { row_index: 1, section: "future", unit_number: "101", room: "Room1",
        name: "Future Known", status: "future", lease_from: "2027-08-01" },
      // Future-only position and unit: evidence, never inventory authority.
      { row_index: 2, section: "future", unit_number: "999", room: "Room9",
        name: "Future Unknown", status: "future", lease_from: "2027-08-01" },
      // Unassigned future evidence still belongs to the source-row count.
      { row_index: 3, section: "future", unit_number: null, room: null,
        name: "Future Unassigned", status: "future", lease_from: "2027-08-01" },
      { row_index: 4, section: "current", unit_number: "101", room: "Room1",
        status: "vacant" },
      { row_index: 5, section: "current", unit_number: "102", room: "Room1",
        status: "vacant" },
    ];
    const loaded = await loader.loadLedgerSnapshot(pool, rows, {
      client: db, targetPropertyId: property, sourceFile: "canonical-ledger.xlsx",
      sourceAsOfDate: "2026-07-31", leasingModel: "bed", confidence: "extracted", force: true,
    });
    ok("ledger load succeeds", loaded && loaded.ok === true, JSON.stringify(loaded));
    ok("all five source rows are counted", loaded.loaded.source_rows === 5,
      JSON.stringify(loaded.loaded));
    ok("current and future counts include unassigned evidence",
      loaded.loaded.current_rows === 2 && loaded.loaded.future_rows === 3,
      JSON.stringify(loaded.loaded));

    const shape = await one(db,
      `select count(distinct u.id)::int units, count(s.id)::int spaces,
              count(*) filter (where u.unit_number='999')::int unknown_units
         from units u join spaces s on s.unit_id=u.id
        where u.property_id=$1`, [property]);
    ok("only current rows establish the two units", shape.units === 2 && shape.unknown_units === 0,
      JSON.stringify(shape));
    ok("only the two current Room1 positions exist", shape.spaces === 2, JSON.stringify(shape));

    const evidence = (await db.query(
      `select row_index, produced_unit_id, produced_space_id, parse_note
         from import_source_rows where import_batch_id=$1 order by row_index`,
      [loaded.import_batch_id])).rows;
    ok("every input row is retained as evidence", evidence.length === 5, String(evidence.length));
    ok("future-first known evidence resolves current inventory",
      !!evidence[0].produced_unit_id && !!evidence[0].produced_space_id, JSON.stringify(evidence[0]));
    ok("future-only unknown evidence manufactures no inventory",
      !evidence[1].produced_unit_id && !evidence[1].produced_space_id &&
      /discrepancy/i.test(evidence[1].parse_note || ""), JSON.stringify(evidence[1]));
    ok("unassigned future evidence is retained without produced objects",
      !evidence[2].produced_unit_id && !evidence[2].produced_space_id &&
      /unusable/i.test(evidence[2].parse_note || ""), JSON.stringify(evidence[2]));
    ok("both current rows resolve the inventory they established",
      evidence.slice(3).every((r) => r.produced_unit_id && r.produced_space_id));

    // Build one opening baseline with two adversarial proposal shapes.
    const activation = (await one(db,
      `insert into activations (deal_id,property_id,status,source_as_of_date,import_batch_id,opened_by_user_id)
       values ($1,$2,'activated','2026-07-31',$3,$4) returning id`,
      [deal, property, loaded.import_batch_id, user])).id;
    const propose = async (key, section, status, normalized) => (await one(db,
      `insert into proposed_records
         (activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values ($1,$2,'leasing','lease',$3,$4,$5) returning id`,
      [activation, property, key, JSON.stringify({ section, ...normalized }), status])).id;

    // The exact-key future row must not outrank the unit-key current fallback.
    const current101 = await propose("101", "current", "promoted",
      { unit_number: "101", is_vacant: true });
    await propose("101|Room1", "future", "promoted",
      { unit_number: "101", space_label: "Room1", tenant_name: "Future Known" });
    // A promoted identity candidate is not a lease/occupancy proposal even
    // when its key and normalized shape resemble one.
    await db.query(
      `insert into proposed_records
         (activation_id,property_id,module,target_type,natural_key,normalized_json,status)
       values ($1,$2,'leasing','person','101|Room1',$3,'promoted')`,
      [activation, property, JSON.stringify({ section: "current", tenant_name: "Identity Candidate" })]);
    // Two matching CURRENT rows make opposite claims. The reader must expose
    // the conflict rather than preferring the exact key arbitrarily.
    await propose("102", "current", "promoted",
      { unit_number: "102", tenant_name: "Current Claimed Occupant" });
    await propose("102|Room1", "current", "conflicted",
      { unit_number: "102", space_label: "Room1", is_vacant: true,
        source_claim_conflict: true });
    await db.query(
      `insert into opening_tenancy_positions
         (property_id,deal_intake_id,activation_id,as_of_date,positions_established,
          positions_unresolved,source_rows_read,established_by_user_id,authority_basis,status)
       values ($1,$2,$3,'2026-07-31',1,1,5,$4,'platform_role:super_admin','established')`,
      [property, deal, activation, user]);

    const dated = await datedPropertyPositions(db, { property_id: property, as_of: "2026-08-01" });
    const p101 = dated.positions.find((p) => p.unit_number === "101" && p.space_label === "Room1");
    const p102 = dated.positions.find((p) => p.unit_number === "102" && p.space_label === "Room1");
    ok("canonical read returns exactly the current-established positions", dated.count === 2,
      String(dated.count));
    ok("explicit future proposal is excluded from opening occupancy",
      p101 && p101.occupancy_claim === "vacant", JSON.stringify(p101 && p101._opening_claim_source));
    ok("the accepted current proposal remains the named basis",
      p101 && p101.basis_ref && p101.basis_ref.kind === "opening_position_claim" && p101.basis_ref.proposal_id === current101,
      JSON.stringify(p101 && p101.basis_ref));
    ok("conflicting current claims resolve to unreconciled",
      p102 && p102.occupancy_claim === "unreconciled", JSON.stringify(p102 && p102._opening_claim_source));

    ok("prior-produced-person lookup is exported", typeof loader.priorProducedPerson === "function");
    if (typeof loader.priorProducedPerson === "function") {
      const person = (await one(db, "insert into persons (name) values ('Prior candidate') returning id")).id;
      const priorBatch = (await one(db,
        `insert into import_batches
           (property_id,source_type,source_file,source_as_of_date,leasing_model,confidence,status)
         values ($1,'historical_snapshot','prior.xlsx','2026-06-30','bed','confirmed','committed') returning id`,
        [property])).id;
      await db.query(
        `insert into import_source_rows
           (import_batch_id,row_index,raw,produced_person_id,parse_note)
         values ($1,1,$2,$3,'prior candidate evidence')`,
        [priorBatch, JSON.stringify({ resident_id: "resident-42" }), person]);
      const candidate = await loader.priorProducedPerson(db, property, "resident-42");
      ok("shared lookup returns historical evidence only as a candidate", candidate === person,
        String(candidate));
    } else {
      ok("shared lookup candidate behavior awaits implementation", false,
        "priorProducedPerson is not exported");
    }
  } catch (e) {
    failed++;
    console.error("  FAIL  harness threw  →  " + (e && e.stack ? e.stack : e));
  } finally {
    await db.query("rollback").catch(() => {});
    db.release();
    await pool.end();
  }
  process.exit(receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED }));
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(receipt.died(HARNESS, e, passed + failed));
});
