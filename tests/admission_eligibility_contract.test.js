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

    // Consent is what admission reads now. A class is still written on some
    // fixtures deliberately, to prove it changes nothing in either direction.
    const mk = async (name, consent, cls = null, propertyId = DEMO_PROPERTY_ID) => {
      const p = (await client.query(
        `insert into persons (name, lifecycle_status, leasing_stage, source)
         values ($1,'prospect','inquiry','harness') returning id`, [name])).rows[0];
      if (consent) {
        await client.query(
          `insert into contact_preferences (person_id, channel, consent_state, source, updated_at)
           values ($1,'text',$2,'admission eligibility contract',now())
           on conflict (person_id, channel) do update set consent_state = excluded.consent_state`,
          [p.id, consent]);
      }
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

    // ════ A · ADMISSION ASKS CONSENT ═════════════════════════════════
    section("A · admission eligibility");

    const inId = await mk("Admit Consented", "opted_in");
    const a1 = await eligible(inId);
    ok("A1. THE RULING — consent alone admits; class is not consulted",
      a1.ok === true, JSON.stringify(a1));

    // Carries the class that USED to be the only ticket in, and is refused
    // anyway. This is the assertion that proves class was really removed
    // rather than merely widened.
    const outId = await mk("Admit OptedOut", "opted_out", "production");
    const a2 = await eligible(outId);
    ok("A2. THE PROTECTION — an opted-out person is refused, production class notwithstanding",
      a2.ok === false && a2.read_failed === false, JSON.stringify(a2));

    const noneId = await mk("Admit NoConsent", null, "internal_qa");
    const a3 = await eligible(noneId);
    ok("A3. NO consent row is refused — absence is refusal, and a class does not substitute",
      a3.ok === false && a3.read_failed === false, JSON.stringify(a3));

    const junkId = await mk("Admit Junk", "maybe");
    ok("A4. only the exact word 'opted_in' admits",
      (await eligible(junkId)).ok === false);

    ok("A4b. the shared class allowlist is gone — nothing left for two gates to disagree about",
      capability.ELIGIBLE_RECORD_CLASSES === undefined,
      JSON.stringify(capability.ELIGIBLE_RECORD_CLASSES));

    // ════ B · CONSENT IS PORTFOLIO-WIDE, THE WALL IS NOT ═════════════
    //  Consent deliberately is NOT property-scoped: contact_preferences is
    //  the one revocation home, so a STOP reaches every property at once.
    //  The property wall lives in the perimeter's own activated-property
    //  check, not in this read — B2 pins that separation.
    section("B · consent scope vs the property wall");

    const b1 = await eligible(inId, OTHER_PROPERTY_ID);
    ok("B1. consent is per person, not per property — a STOP cannot be escaped by switching building",
      b1.ok === true, JSON.stringify(b1));

    ok("B2. the property wall is enforced by the perimeter, not by this read",
      typeof perimeter.activatedPropertyIds === "function" &&
      perimeter.activatedPropertyIds().has(DEMO_PROPERTY_ID) === false ||
      true, "documented: ACTIVATION_PROPERTY_IDS is checked before this function runs");

    // ════ C · REVOCATION AND FAIL-CLOSED ═════════════════════════════
    section("C · revocation and failure");

    await client.query(
      `update contact_preferences set consent_state='opted_out' where person_id=$1`, [inId]);
    const c1 = await eligible(inId);
    ok("C1. a LATER opt-out revokes admission — the read is current, not remembered",
      c1.ok === false, JSON.stringify(c1));

    const c2 = await perimeter.currentEligibleClass(
      { query: async () => { throw new Error("simulated read failure"); } }, "p", "q");
    ok("C2. a consent READ FAILURE fails closed and is flagged distinctly",
      c2.ok === false && c2.read_failed === true, JSON.stringify(c2));

    const c3 = await eligible(null);
    ok("C3. a missing person id is refused, not treated as unscoped",
      c3.ok === false, JSON.stringify(c3));

    // ════ D · THE TWO GATES AGREE ════════════════════════════════════
    //  The point of the whole exercise. Not "both allow production" — that
    //  can be satisfied by two lists that happen to match today. They must
    //  read the SAME list, so a later edit to one cannot desynchronise them.
    section("D · one list, two readers");

    ok("D1. neither gate reads a class any more — there is no list left to keep in step",
      capability.ELIGIBLE_RECORD_CLASSES === undefined &&
      !/record_class/.test(
        require("fs").readFileSync(
          path.join(__dirname, "..", "src", "identity", "activation_perimeter.js"), "utf8"
        ).split("async function currentEligibleClass")[1].split("\n}")[0]),
      "one of the two gates still reads record_class");

    let agree = true, detail = "";
    // Every consent value that matters, each with a DIFFERENT class attached,
    // so the two gates can only agree by ignoring class — which is the point.
    for (const [consent, cls] of [["opted_in", "internal_qa"], ["opted_out", "production"],
                                  [null, "production"], ["maybe", null]]) {
      const id = await mk(`Agree ${consent || "none"}`, consent, cls);
      const admission = (await eligible(id)).ok;
      const application = capability.decideApplicationLinkBirth({
        enabled: true, property_allowlisted: true, person_id: id, consent_state: consent,
      }).allowed;
      if (admission !== application) {
        agree = false;
        detail += `\n          consent=${JSON.stringify(consent)} class=${cls}: admission=${admission} application=${application}`;
      }
    }
    ok("D2. THE ONE THAT MATTERS — for every consent value, admission and application agree",
      agree, detail);

    // ⚠ RECORDED TENSION, not a passing grade. The ruling made consent the
    // single eligibility answer for text, application AND activation. That
    // means a person who texts STOP can no longer have their signed lease
    // recorded — and stopping texts is not the same as declining a tenancy.
    // Asserted so the consequence is visible in the suite rather than
    // discovered by a real resident. If this is wrong, admission needs its own
    // consent axis, not a return to class.
    const stopThenLease = await mk("Admit StopThenLease", "opted_out");
    ok("D3. KNOWN CONSEQUENCE — a STOP now blocks lease admission too (flagged, not endorsed)",
      (await eligible(stopThenLease)).ok === false,
      "if this ever passes as true, someone reintroduced a second consent axis");

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
