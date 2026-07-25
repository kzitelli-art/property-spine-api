// ════════════════════════════════════════════════════════════════════
//  leasing_desk_identity.test.js — application rows must carry person_id.
//
//  THE REGRESSION THIS EXISTS FOR
//  ------------------------------
//  buildReviewDetail returns identity NESTED:
//      { applicant: { name, person_id }, unit: { unit_id, unit_label }, … }
//  The loader read it FLAT — detail.person_id, detail.applicant_name,
//  detail.unit_label — which is undefined, silently.
//
//  Two of those three had a summary-level fallback, so names and units
//  still rendered and nothing looked broken. person_id had no fallback,
//  so it was null on every application row, and the operator app — doing
//  exactly the right thing — rendered those names as plain text instead
//  of a dead link. The symptom was "some names open the Person Card and
//  some don't," three layers away from the cause.
//
//  This asserts the loader's OUTPUT against the real nested shape, so a
//  contract that moves again fails here rather than in the browser.
//
//  No database. The review layer is stubbed with the exact shape
//  application_review.js returns, which is the thing that was misread.
//
//  CLASS 3 — test infrastructure outside the operator workflow.
//  RUN:  node leasing_desk_identity.test.js "$(pwd)"
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const loader = require(path.resolve(process.argv[2] || path.join(__dirname, "..", "src", "leasing"), "leasing_desk_loader.js"));

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}

const PROPERTY = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const PERSON = "11111111-2222-3333-4444-555555555555";

// The shape application_review.js actually returns — nested, not flat.
function reviewStub({ withPerson = true, flat = false } = {}) {
  return {
    buildReviewList: async () => ({
      applications: [{ application_id: "app-1", applicant_name: "Summary Name", unit_label: "101" }],
    }),
    buildReviewDetail: async () => {
      if (flat) {
        // A hypothetical future flattening of the contract must also work.
        return {
          application_id: "app-1",
          applicant_name: "Flat Name",
          person_id: withPerson ? PERSON : null,
          unit_label: "202",
          status: "active",
          next_action: { code: "confirm_proposed_terms", state: "available", label: "Confirm the proposed terms." },
        };
      }
      return {
        application_id: "app-1",
        applicant: { name: "Nested Name", person_id: withPerson ? PERSON : null },
        unit: { unit_id: "u-1", unit_label: "202" },
        status: "active",
        next_action: { code: "confirm_proposed_terms", state: "available", label: "Confirm the proposed terms." },
        execution_primary_action: null,
        lease_id: null,
      };
    },
  };
}

const applicationsService = { outstanding: async () => ({}), applicationNext: async () => null };
const fakeClient = { query: async () => ({ rows: [] }) };

async function rowsFor(opts) {
  return loader.loadApplicationRows(fakeClient, PROPERTY, {
    applicationReview: reviewStub(opts),
    applicationsService,
  });
}

async function main() {
  if (typeof loader.loadApplicationRows !== "function") {
    console.error("loadApplicationRows is not exported — the loader shape changed.");
    process.exitCode = 1;
    return;
  }

  const nested = await rowsFor({});
  const r = nested[0] || {};

  ok("1. an application row is produced", nested.length === 1, `got ${nested.length}`);

  ok("2. person_id is read from the NESTED applicant — the actual bug",
    r.person_id === PERSON, `person_id=${r.person_id}`);

  ok("3. the nested applicant name wins over the summary fallback",
    r.applicant_name === "Nested Name", `applicant_name=${r.applicant_name}`);

  ok("4. person_name mirrors the applicant name (what the door renders)",
    r.person_name === "Nested Name", `person_name=${r.person_name}`);

  ok("5. the nested unit label wins over the summary fallback",
    r.unit_label === "202", `unit_label=${r.unit_label}`);

  const flat = await rowsFor({ flat: true });
  ok("6. a flattened detail contract still resolves identity",
    (flat[0] || {}).person_id === PERSON, `person_id=${(flat[0] || {}).person_id}`);

  const none = await rowsFor({ withPerson: false });
  ok("7. a genuinely absent person stays null — never invented",
    (none[0] || {}).person_id === null, `person_id=${(none[0] || {}).person_id}`);

  ok("8. the summary name still carries when detail supplies none",
    (none[0] || {}).applicant_name != null);

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nLEASING DESK — APPLICATION ROW IDENTITY\n${bar}`);
  console.log(lines.join("\n"));
  console.log(bar);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed
    ? "Application names will not open the Person Card until these pass."
    : "Every application row carries the identity the Person Card door needs.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
