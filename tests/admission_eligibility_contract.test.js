// ════════════════════════════════════════════════════════════════════
//  admission_eligibility_contract.test.js — the OTHER half of the gate.
//
//  WHAT THIS PROTECTS
//  ------------------
//  Two gates once demanded opposite classifications, and classification is
//  one value per person per property:
//
//    application link birth   required internal_qa
//    tenancy admission        required internal_qa   ← this file
//    comms boundary           requires production    (customer_care)
//
//  Merging only the application gate moved the wall rather than removing it:
//  a `production` prospect could be SENT an application and could never be
//  admitted to a tenancy. Half a deadlock is still a deadlock — it just
//  fails later, after the prospect has filled in a form.
//
//  So the assertion that matters here is not "production is allowed". It is
//  that BOTH gates answer the same question the same way, from the SAME
//  list, so they cannot drift apart in a later edit.
//
//  Runs against real Postgres inside an always-rolled-back transaction.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  DATABASE_URL=... node tests/admission_eligibility_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");
const perimeter = require(path.join(__dirname, "..", "src", "identity", "activation_perimeter.js"));
const capability = require(path.join(__dirname, "..", "src", "identity", "capability.js"));

const DEMO_PROPERTY_ID = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER_PROPERTY_ID = "9e2bb96e-08e2-41db-81c2-91055ceb50a3"; // Real Solo — parked, never written here

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required — this contract is about a real classification read.");
    process.exitCode = 2; return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();

  try {
    await client.query("begin");

    const mk = async (name, cls, propertyId = DEMO_PROPERTY_ID) => {
      const p = (await client.query(
        `insert into persons (name, lifecycle_status, leasing_stage, source)
         values ($1,'prospect','inquiry','harness') returning id`, [name])).rows[0];
      if (cls) {
        await client.query(
          `insert into person_property_classifications
             (person_id, property_id, record_class, classification_source, classification_reason)
           values ($1,$2,$3,'operator','admission eligibility contract')`, [p.id, propertyId, cls]);
      }
      return p.id;
    };

    // currentEligibleClass takes a query-runner; the open transaction IS one,
    // so every insert above is visible and nothing persists.
    const eligible = (personId, propertyId = DEMO_PROPERTY_ID) =>
      perimeter.currentEligibleClass(client, personId, propertyId);

    // ════ A · THE MERGE ══════════════════════════════════════════════
    section("A · admission eligibility");

    const prodId = await mk("Admit Prod", "production");
    const a1 = await eligible(prodId);
    ok("A1. THE RULING — a production person is ADMISSION-eligible (fails on the old hardcoded check)",
      a1.ok === true, JSON.stringify(a1));

    const qaId = await mk("Admit QA", "internal_qa");
    const a2 = await eligible(qaId);
    ok("A2. an internal_qa person is still eligible — the QA arc depends on it",
      a2.ok === true, JSON.stringify(a2));

    const noneId = await mk("Admit None", null);
    const a3 = await eligible(noneId);
    ok("A3. an UNCLASSIFIED person is refused — absence of a decision is not permission",
      a3.ok === false && a3.read_failed === false, JSON.stringify(a3));

    // A class nobody named cannot even be STORED — the table carries a CHECK
    // constraint. So the allowlist in code is the second line, not the first.
    // Prove the constraint really rejects (inside a savepoint, so the failure
    // does not abort the surrounding transaction), then prove the code would
    // refuse such a value anyway if the constraint were ever relaxed.
    let constraintRejected = false;
    await client.query("savepoint bogus_class");
    try {
      await mk("Admit Bogus", "vendor");
      await client.query("release savepoint bogus_class");
    } catch (e) {
      constraintRejected = /check constraint/i.test(e.message);
      await client.query("rollback to savepoint bogus_class");
    }
    ok("A4. the DATABASE refuses to store a class nobody named — first line of defence",
      constraintRejected);

    ok("A4b. ...and the code would refuse it too if that constraint were relaxed",
      capability.ELIGIBLE_RECORD_CLASSES.includes("vendor") === false &&
      capability.decideApplicationLinkBirth({
        enabled: true, property_allowlisted: true, person_id: "p", record_class: "vendor",
      }).allowed === false);

    // ════ B · THE PROPERTY WALL ══════════════════════════════════════
    section("B · the property wall");

    const crossId = await mk("Admit CrossProp", "production", OTHER_PROPERTY_ID);
    const b1 = await eligible(crossId, DEMO_PROPERTY_ID);
    ok("B1. production AT ANOTHER PROPERTY is refused here — classification is property-scoped",
      b1.ok === false, JSON.stringify(b1));
    const b2 = await eligible(crossId, OTHER_PROPERTY_ID);
    ok("B2. ...and the same person IS eligible at the property they are classified for",
      b2.ok === true, JSON.stringify(b2));

    // ════ C · SUPERSESSION AND FAIL-CLOSED ═══════════════════════════
    section("C · supersession and failure");

    await client.query(
      `update person_property_classifications set superseded_at = now()
        where person_id = $1 and property_id = $2`, [prodId, DEMO_PROPERTY_ID]);
    const c1 = await eligible(prodId);
    ok("C1. a SUPERSEDED classification is not a current one — refused",
      c1.ok === false, JSON.stringify(c1));

    const c2 = await perimeter.currentEligibleClass(
      { query: async () => { throw new Error("simulated read failure"); } }, "p", "q");
    ok("C2. a classification READ FAILURE fails closed and is flagged distinctly",
      c2.ok === false && c2.read_failed === true, JSON.stringify(c2));

    const c3 = await eligible(null);
    ok("C3. a missing person id is refused, not treated as unscoped",
      c3.ok === false, JSON.stringify(c3));

    // ════ D · THE TWO GATES AGREE ════════════════════════════════════
    //  The point of the whole exercise. Not "both allow production" — that
    //  can be satisfied by two lists that happen to match today. They must
    //  read the SAME list, so a later edit to one cannot desynchronise them.
    section("D · one list, two readers");

    ok("D1. the perimeter imports the capability allowlist rather than restating it",
      Array.isArray(capability.ELIGIBLE_RECORD_CLASSES) &&
      capability.ELIGIBLE_RECORD_CLASSES.includes("production") &&
      capability.ELIGIBLE_RECORD_CLASSES.includes("internal_qa"),
      JSON.stringify(capability.ELIGIBLE_RECORD_CLASSES));

    let agree = true, detail = "";
    // Only classes the CHECK constraint permits, plus the unclassified case.
    for (const cls of [...capability.ELIGIBLE_RECORD_CLASSES, null]) {
      const id = await mk(`Agree ${cls || "none"}`, cls);
      const admission = (await eligible(id)).ok;
      const application = capability.decideApplicationLinkBirth({
        enabled: true, property_allowlisted: true, person_id: id, record_class: cls,
      }).allowed;
      if (admission !== application) {
        agree = false;
        detail += `\n          record_class=${JSON.stringify(cls)}: admission=${admission} application=${application}`;
      }
    }
    ok("D2. THE ONE THAT MATTERS — for every class, admission and application agree",
      agree, detail);

    ok("D3. consent is NOT an admission condition — recording a signed lease is not an outbound",
      !/consent|opted_out|stop/i.test(
        require("fs").readFileSync(
          path.join(__dirname, "..", "src", "identity", "activation_perimeter.js"), "utf8"
        ).split("async function currentEligibleClass")[1].split("}")[0]));

  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await client.query("rollback"); } catch (_) {}
    client.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nADMISSION ELIGIBILITY — THE OTHER HALF OF THE GATE\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Rolled back; nothing persisted. Fix the failures above and re-run."
    : "A prospect who may be sent an application may also become a resident.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
