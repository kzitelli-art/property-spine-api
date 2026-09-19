"use strict";
/*  ══════════════════════════════════════════════════════════════════════
    person_continuity_handle.db.js — NO DURABLE CONTINUITY HANDLE → NO
    DURABLE PERSON (CURRENT_STATE row 136 → 156, ruled 2026-09-19).

    A rent-roll row names a resident and carries no phone and no email
    (the real parser maps neither). Before: the operator's confirmation
    minted a durable Person from the name alone — Greenery's 95 Persons
    carry phone 0/95, email 0/95, and cannot recognise a single resident
    who texts next year. After: the tenancy is still established, the
    lease carries no tenant, the claim is staged with the reason, the rent
    roll counts the row as resident_not_linked and shows the source's name
    beside it as a claim. Evidence WITH a handle still creates. Confirming
    a name-only claim as "a new person" is refused with the next step.

    Witness (PROOF_EXPECT_DEFECT=1 on the parent tree): the same
    confirmation creates the Person and the rent roll reads 0 not linked.
    Real services, owned database, nothing mocked.
    ══════════════════════════════════════════════════════════════════════ */
const assert = require("node:assert/strict");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const parent = process.env.PROOF_EXPECT_DEFECT === "1";
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const personIngress = require(path.join(root, "src/identity/person_ingress.js"));
const { currentRentRoll } = require(path.join(root, "src/surfaces/rent_roll_canonical.js"));
const { reviewedIngest } = require("../helpers/reviewed_source.js");
let pool, passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log("  ok    " + label); } else { failed++; console.log("  FAIL  " + label + (detail ? "\n        " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); } };
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const NAME = "Jordan Vale";
//  Unique per run: the owned database keeps earlier runs' Persons, and a
//  reused phone would RESOLVE to one of them instead of creating.
const NONCE = String(1000 + Math.floor(Math.random() * 8999));
const PH1 = "215556" + NONCE, PH2 = "215557" + NONCE;
const csv = `Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To\n101,Room1,${NAME} (s0005738),900,850,2026-07-01,2027-06-30\n`;

(async () => {
  await boundary.assertDatabase();
  pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const tag = `continuity-${randomUUID().slice(0, 8)}`;
  const t0 = (await one("select now() as t")).t;
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const human = await one("insert into persons(name,email) values('Continuity Operator',$1) returning id", [`${tag}-op@example.test`]);
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Continuity Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, human.id]);
  const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: tag, creation_source: "deal_setup_console" });
  const property = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [tag, org.id]);
  await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id });
  const act = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id })).activation;
  const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: property.id, filename: "continuity.csv", mimetype: "text/csv",
    buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: "2026-07-31" });
  await reviewedIngest(activation, pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id, activation_id: act.id,
    source_artifact_id: artifact.id, source_as_of_date: "2026-07-31" });
  const claim = await one("select * from proposed_records where activation_id=$1 and target_type='lease' and normalized_json->>'section'='current'", [act.id]);
  const normalized = claim.normalized_json || {};
  console.log(`\n== the source row: name "${normalized.tenant_name}" · phone ${normalized.phone == null ? "ABSENT" : "present"} · email ${normalized.email == null ? "ABSENT" : "present"} · pms id ${normalized.resident_id || "none"} ==`);
  ok("the real parser carries no phone and no email for this row (the fixture is the real shape)", normalized.phone == null && normalized.email == null);

  console.log("\n== the operator confirms the row ==");
  const confirmed = await activation.confirmProposal(pool, { user_id: user.id, proposed_id: claim.id });
  const lease = await one("select * from leases where id=$1", [confirmed.lease_id]);
  const minted = (await pool.query("select id, phone, email, primary_phone_e164 from persons where name=$1 and created_at >= $2", [NAME, t0])).rows;
  const personClaim = await one("select status, status_reason, resolution_kind, promoted_record_id from proposed_records where activation_id=$1 and target_type='person'", [act.id]);
  const evidence = await one("select produced_person_id, produced_lease_id from import_source_rows where id=$1", [claim.import_source_row_id]);
  const rr = await currentRentRoll(pool, { property_id: property.id });
  const row = rr.rows.find((r) => r.lease && String(r.lease.lease_id) === String(lease.id));
  console.log("        outcome:", confirmed.outcome, "· person_id:", confirmed.person_id, "· tenant_ids:", JSON.stringify(lease.tenant_ids), "· persons minted:", minted.length);
  console.log("        person claim:", JSON.stringify(personClaim));
  console.log("        rent roll row: resident", JSON.stringify(row && row.resident), "· resident_claim", JSON.stringify(row && row.resident_claim), "· resident_not_linked", rr.exceptions.resident_not_linked);

  if (parent) {
    console.log("\n== WITNESS (unmodified tree): the name alone mints a human ==");
    ok("the confirmation created a durable Person from a name-only row", minted.length === 1 && confirmed.person_id, { minted, person_id: confirmed.person_id });
    ok("and that Person has no continuity handle at all", minted[0] && !minted[0].phone && !minted[0].email && !minted[0].primary_phone_e164, minted[0]);
    ok("the lease carries it as its tenant", Array.isArray(lease.tenant_ids) && lease.tenant_ids.length === 1);
    ok("so the rent roll reads 0 resident_not_linked — the exception is invisible", rr.exceptions.resident_not_linked === 0, rr.exceptions);
  } else {
    console.log("\n== SUCCESSOR ==");
    ok("the tenancy is established: a lease exists with the source's terms", confirmed.outcome === "lease_created" && lease && Number(lease.rent) === 850 && lease.lease_status === "active", confirmed);
    ok("no Person was minted from the name", minted.length === 0 && confirmed.person_id === null && confirmed.resident_linked === false, { minted, confirmed });
    ok("the lease carries no tenant — not a guess, not a placeholder", Array.isArray(lease.tenant_ids) && lease.tenant_ids.length === 0, lease.tenant_ids);
    ok("the person claim is STAGED with the reason, not needs_review and not promoted",
      personClaim && personClaim.status === "staged" && personClaim.resolution_kind == null && personClaim.promoted_record_id == null && /no phone or email/.test(personClaim.status_reason || ""), personClaim);
    ok("the evidence row names the lease it produced and no person", evidence && String(evidence.produced_lease_id) === String(lease.id) && evidence.produced_person_id == null, evidence);
    ok("the receipt says so in words an operator can read", /Resident not linked/.test(confirmed.receipt || ""), confirmed.receipt);
    ok("the canonical rent roll counts it: resident_not_linked = 1", rr.exceptions.resident_not_linked === 1, rr.exceptions);
    ok("the row has no resident …", row && row.resident === null, row && row.resident);
    ok("… and carries the source's name as a CLAIM, marked not linked", row && row.resident_claim && row.resident_claim.name === NAME && row.resident_claim.linked === false && row.resident_claim.source === "rent_roll", row && row.resident_claim);
    ok("the row still counts as contractually occupied (the tenancy is real; the identity is what is missing)",
      rr.tenancy_summary && rr.tenancy_summary.contractually_occupied === 1, rr.tenancy_summary);

    console.log("\n== a reviewer saying 'a new person' about a name-only claim is a judgment, not a record ==");
    const pc = await one("select id from proposed_records where activation_id=$1 and target_type='person'", [act.id]);
    const judged = await personIngress.confirmPersonProposal(pool, { proposal_id: pc.id, action: "created", actor: String(user.id) });
    ok("resolves as distinct_unlinked: no person id, no resolution kind", judged.identity_decision === "distinct_unlinked" && judged.person_id === null && judged.resolution_kind == null, judged);
    const still = await one("select status, resolution_kind, promoted_record_id, confirmed_by, status_reason, payload_json->>'identity_decision' as d from proposed_records where id=$1", [pc.id]);
    ok("the claim stays STAGED and unpromoted, carries who decided and why", still.status === "staged" && still.resolution_kind == null && still.promoted_record_id == null && still.confirmed_by === String(user.id) && still.d === "distinct_unlinked" && /phone or email/.test(still.status_reason || ""), still);
    ok("still no Person", (await pool.query("select count(*)::int n from persons where name=$1 and created_at >= $2", [NAME, t0])).rows[0].n === 0);
    const again = await personIngress.ingestPerson(pool, { property_id: property.id, channel: "rent_roll", activation_id: act.id,
      authority: { actor: String(user.id), basis: "operator confirmation of an activation row" },
      evidence: { name: NAME, source_system: "rent_roll", source_record_id: "s0005738", import_source_row_id: claim.import_source_row_id } });
    ok("a later ingest of the same evidence row honours the decision: unlinked, no candidates re-asked, no Person",
      again.person_id === null && again.staged_reason === "no_continuity_handle" && (again.evidence_used || []).includes("confirmed_person_proposal"), again);

    console.log("\n== controls: evidence WITH a handle still creates, under the same authority ==");
    const auth = { actor: String(user.id), basis: "operator confirmation of an activation row" };
    const byPhone = await personIngress.ingestPerson(pool, { property_id: property.id, channel: "rent_roll", authority: auth,
      evidence: { name: "Casey Handle", phone: PH1, source_system: "rent_roll", source_record_id: "s0009001" } });
    const p1 = byPhone.person_id ? await one("select primary_phone_e164, email from persons where id=$1", [byPhone.person_id]) : null;
    ok("a phone is a handle: created, and the Person carries it", byPhone.disposition === "created" && p1 && p1.primary_phone_e164 === "+1" + PH1, { byPhone, p1 });
    const byEmail = await personIngress.ingestPerson(pool, { property_id: property.id, channel: "rent_roll", authority: auth,
      evidence: { name: "Robin Mailer", email: "Robin.Mailer." + NONCE + "@Example.test", source_system: "rent_roll", source_record_id: "s0009002" } });
    const p2 = byEmail.person_id ? await one("select primary_phone_e164, email from persons where id=$1", [byEmail.person_id]) : null;
    ok("an email is a handle: created, and the Person carries it", byEmail.disposition === "created" && p2 && p2.email === "robin.mailer." + NONCE + "@example.test", { byEmail, p2 });
    const idOnly = await personIngress.ingestPerson(pool, { property_id: property.id, channel: "rent_roll", authority: auth, activation_id: act.id,
      evidence: { name: "Sam Keyed", source_system: "rent_roll", source_record_id: "s0009003", import_source_row_id: null } });
    ok("a PMS resident id is provenance, not a handle: staged with the reason, no Person",
      idOnly.person_id === null && idOnly.staged_reason === "no_continuity_handle" && idOnly.resolution_kind == null, idOnly);
    const noAuth = await personIngress.ingestPerson(pool, { property_id: property.id, channel: "rent_roll", authority: null,
      evidence: { name: "Nobody Signed", phone: PH2, source_system: "rent_roll", source_record_id: "s0009004" } });
    ok("a handle without an authority still stages (authority is still required to mint)", noAuth.person_id === null && noAuth.staged_reason === "no_authority", noAuth);
    ok("continuityHandle is exported and pure", personIngress.continuityHandle({ name: "x" }) === null
      && personIngress.continuityHandle({ phone: "2155550192" }).kind === "phone" && personIngress.continuityHandle({ email: "a@b.co" }).kind === "email");
  }

  console.log(`\n${passed} passed, ${failed} failed${parent ? " (witness mode)" : ""}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("HARNESS:", e.stack || e.message); try { await pool.end(); } catch (_) {} process.exit(2); });
