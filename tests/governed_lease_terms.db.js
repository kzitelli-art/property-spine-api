/* ════════════════════════════════════════════════════════════════════
   governed_lease_terms.db.js — WHAT SPINE CAN STAND BEHIND FOR ONE
   LEASE, AND WHAT IT HONESTLY CANNOT. REAL POSTGRES.

   The field list under test is not this file's invention and not the
   module's: it is `executed_lease_service.verifyExecutedLease`'s own
   required input set, read backwards. That is what keeps the lease
   bridge from growing a second idea of what a lease needs.

   ── WHAT IT PROVES ──────────────────────────────────────────────────
   · `ready` is COMPUTED from the fields, never asserted — an unfinished
     assembly can never report itself finished;
   · a pricing refusal travels through UNCHANGED rather than being
     restated in this module's words, so one fact keeps one vocabulary;
   · the landlord comes from the governed entity chain and `owner` is
     matched EXACTLY — an operating entity manages the asset and does not
     hold title, and the two must never be interchangeable on an
     instrument somebody signs;
   · the end date is DERIVED from start + term, never asked for twice;
   · the two things Spine has no model for — required addenda and the
     authorised company signer — are NAMED as not established rather
     than omitted. An omitted field reads as "not needed"; these are
     needed and absent, which is the fact the bridge must not paper over.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   Requires migrations 100, 101, 102, 153, 164, 182, 183.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/spine_proof \
       node tests/governed_lease_terms.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const { governedLeaseTerms } = require("../src/applications/governed_lease_terms.js");

const pool = new Pool({ connectionString: CONN });
let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
};

(async () => {
  const q = (s, p) => pool.query(s, p);
  const prop = (await q("insert into properties (name) values ('Lease Terms Proof') returning id")).rows[0].id;
  const type = (await q("insert into property_unit_types (property_id, code, label) values ($1,'3BR','3 Bed') returning id", [prop])).rows[0].id;
  const unit = (await q("insert into units (property_id, unit_number, unit_type_id) values ($1,'3B',$2) returning id", [prop, type])).rows[0].id;
  const bed = (await q("insert into spaces (unit_id, space_label) values ($1,'Bed B') returning id", [unit])).rows[0].id;
  await q("update spaces set use_type='residential' where unit_id=$1", [unit]);
  const person = (await q("insert into persons (name, email) values ('Jane Smith','jane@example.com') returning id")).rows[0].id;
  //  legal_entities.recorded_by_user_id is NOT NULL — an entity is recorded BY
  //  someone, which is the provenance rule 164 enforces at the column.
  const recorder = (await q("insert into users (name, role) values ('Recorder','property_manager') returning id")).rows[0].id;
  const appId = (await q(
    `insert into lease_applications (property_id, unit_id, space_id, person_id, applicant_name, status)
     values ($1,$2,$3,$4,'Jane Smith','submitted') returning id`, [prop, unit, bed, person])).rows[0].id;

  console.log("\n── 1 · NOTHING GOVERNED YET → nothing claimed ─────────────────");
  let r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop });
  ok("not ready", r.ready === false);
  ok("…the bed IS established (182 lineage)", r.fields.space.established === true);
  ok("…the resident IS established", r.fields.residents.established === true);
  ok("…rent is NOT established", r.fields.rent.established === false);
  ok("…and rent's value is null, never 0", r.fields.rent.value === null);
  ok("…term refuses rather than defaulting to 12", r.fields.lease_term_months.reason === "lease_term_not_selected");
  ok("…landlord refuses — a property name is not a legal party",
     r.fields.landlord.reason === "landlord_entity_not_established");
  ok("…addenda named as unmodelled, not omitted", r.fields.required_addenda.reason === "addenda_model_not_built");
  ok("…company signer named as unmodelled, not omitted",
     r.fields.company_signer.reason === "company_signer_not_established");

  console.log("\n── 2 · A PRICING REFUSAL TRAVELS THROUGH UNCHANGED ────────────");
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("rent carries the PRICING reason, not a local restatement",
     r.fields.rent.reason === "no_published_pricing_version", r.fields.rent.reason);
  ok("…end date is derived from start + term", r.fields.lease_end_date.value === "2027-08-31",
     String(r.fields.lease_end_date.value));

  console.log("\n── 3 · GOVERNED PRICING → rent becomes established ────────────");
  const ver = (await q(`insert into property_pricing_versions (property_id,status,effective_from,authority_basis)
    values ($1,'draft',current_date - 1,'{"basis":"proof"}'::jsonb) returning id`, [prop])).rows[0].id;
  await q(`insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent, offer_state)
    values ($1,$2,$3,'3BR',12,1025,'offered')`, [ver, prop, type]);
  await q("update property_pricing_versions set status='published', published_at=now() where id=$1", [ver]);
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("rent is established at the published figure", r.fields.rent.established === true && r.fields.rent.value === 1025,
     JSON.stringify(r.fields.rent).slice(0, 140));
  ok("…and it names what authorised it", !!(r.fields.rent.authority && r.fields.rent.authority.published_version_id));
  ok("deposit still refuses — no approved fact", r.fields.security_deposit.established === false);
  ok("still NOT ready — the unmodelled fields block honestly", r.ready === false);

  console.log("\n── 4 · THE LANDLORD IS A LEGAL PARTY, MATCHED EXACTLY ─────────");
  const opEnt = (await q(`insert into legal_entities (legal_name, provenance_note, recorded_by_user_id) values ('Skyline Manager LLC','proof',$1) returning id`,[recorder])).rows[0].id;
  await q(`insert into legal_entity_properties (legal_entity_id, property_id, relationship_type, effective_from, provenance_note, recorded_by_user_id)
    values ($1,$2,'operating_entity',current_date - 10,'proof',$3)`, [opEnt, prop, recorder]);
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("an OPERATING entity does not become the landlord",
     r.fields.landlord.established === false, JSON.stringify(r.fields.landlord).slice(0, 120));

  const owner = (await q(`insert into legal_entities (legal_name, provenance_note, recorded_by_user_id) values ('Skyline Owner LP','proof',$1) returning id`,[recorder])).rows[0].id;
  await q(`insert into legal_entity_properties (legal_entity_id, property_id, relationship_type, effective_from, provenance_note, recorded_by_user_id)
    values ($1,$2,'owner',current_date - 10,'proof',$3)`, [owner, prop, recorder]);
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("the OWNER entity is the landlord", r.fields.landlord.established === true
     && r.fields.landlord.value.legal_name === "Skyline Owner LP");

  const owner2 = (await q(`insert into legal_entities (legal_name, provenance_note, recorded_by_user_id) values ('Second Owner LP','proof',$1) returning id`,[recorder])).rows[0].id;
  await q(`insert into legal_entity_properties (legal_entity_id, property_id, relationship_type, effective_from, provenance_note, recorded_by_user_id)
    values ($1,$2,'owner',current_date - 5,'proof',$3)`, [owner2, prop, recorder]);
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("TWO owners is ambiguous, never first-row-wins",
     r.fields.landlord.reason === "landlord_entity_ambiguous", r.fields.landlord.reason);

  console.log("\n── 5 · SCOPE AND AIM ──────────────────────────────────────────");
  const other = (await q("insert into properties (name) values ('Elsewhere') returning id")).rows[0].id;
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: other });
  ok("an application at another property refuses",
     r.ready === false && r.blocking[0] === "application_not_at_property");

  const unaimed = (await q(
    `insert into lease_applications (property_id, unit_id, person_id, applicant_name, status)
     values ($1,$2,$3,'Bedless','submitted') returning id`, [prop, unit, person])).rows[0].id;
  r = await governedLeaseTerms(pool, { application_id: unaimed, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  ok("an application with no bed cannot prepare a lease",
     r.fields.space.reason === "space_not_aimed");
  ok("…and its economics refuse for that same reason, not a pricing one",
     r.fields.rent.reason === "space_not_aimed", r.fields.rent.reason);

  console.log("\n── 6 · `ready` IS COMPUTED, NOT ASSERTED ──────────────────────");
  r = await governedLeaseTerms(pool, { application_id: appId, property_id: prop, lease_term_months: 12, lease_start_date: "2026-09-01" });
  const unestablished = Object.entries(r.fields).filter(([, f]) => !f.established).map(([k]) => k);
  ok("blocking lists exactly the unestablished fields",
     JSON.stringify(r.blocking.map((b) => b.field).sort()) === JSON.stringify(unestablished.sort()),
     JSON.stringify(r.blocking.map((b) => b.field)));
  ok("ready is false while any field is unestablished", r.ready === (unestablished.length === 0));
  ok("the module states it produces no document", r.contract.produces_document === false);

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("   ✗ " + f));
  console.log("════════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("DIED:", e && e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
