"use strict";
/*  ══════════════════════════════════════════════════════════════════════
    link_resident.db.js — THE DOOR THAT LINKS AN UNLINKED RESIDENT
    (CURRENT_STATE row 156 → 157).

    Row 156 established the refusal: a rent-roll row with no phone and no
    email establishes the lease with NO tenant and stages the person claim,
    and the rent roll shows the source's name as an unlinked claim. Correct,
    and it left an operator with no way to link that resident once they had
    a handle. This proves the one door that closes it.

    Real services, owned database, real HTTP over a real socket. The fixture
    is the Deal Setup path — the same one person_continuity_handle.db.js
    uses — so the leases under test are established exactly as production
    establishes them, unlinked, with their claims staged.

    NOTHING IS MOCKED except the absence of a browser: the route, the staff
    session resolution, person_ingress, the rent roll read and every write
    are the shipped code.
    ══════════════════════════════════════════════════════════════════════ */
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { randomUUID, createHash } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");
const root = path.resolve(process.env.PROOF_BUSINESS_ROOT || path.join(__dirname, "../.."));
const activation = require(path.join(root, "src/onboarding/activation_service.js"));
const artifacts = require(path.join(root, "src/onboarding/source_artifact_service.js"));
const deals = require(path.join(root, "src/onboarding/deal_service.js"));
const { currentRentRoll } = require(path.join(root, "src/surfaces/rent_roll_canonical.js"));
const { reviewedIngest } = require("../helpers/reviewed_source.js");

let pool, passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail !== undefined ? "\n        " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
};
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

//  Unique per run: the owned database keeps earlier runs' Persons, and a
//  reused phone would RESOLVE to one of them instead of creating.
const NONCE = String(1000 + Math.floor(Math.random() * 8999));
const PH_LINK = "215558" + NONCE;      // links unit 101, then reused for 102
const PH_DUP  = "215559" + NONCE;      // deliberately on two Persons
const N1 = "Jordan Vale", N2 = "Riley Chase", N3 = "Avery Doss";
const csv = `Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To
101,Room1,${N1} (s0005738),900,850,2026-07-01,2027-06-30
102,Room1,${N2} (s0005739),900,875,2026-07-01,2027-06-30
103,Room1,${N3} (s0005740),900,900,2026-07-01,2027-06-30
`;

(async () => {
  await boundary.assertDatabase();
  pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const tag = `linkres-${randomUUID().slice(0, 8)}`;

  // ── FIXTURE: the Deal Setup path, exactly as production runs it ──────
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const human = await one("insert into persons(name,email) values('Link Operator',$1) returning id", [`${tag}-op@example.test`]);
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Link Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, human.id]);
  const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: tag, creation_source: "deal_setup_console" });
  const property = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [tag, org.id]);
  const other = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [tag + "-other", org.id]);
  await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id });
  const act = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id })).activation;
  const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: property.id, filename: "link.csv", mimetype: "text/csv",
    buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: "2026-07-31" });
  await reviewedIngest(activation, pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id, activation_id: act.id,
    source_artifact_id: artifact.id, source_as_of_date: "2026-07-31" });

  const claims = (await pool.query(
    `select * from proposed_records where activation_id=$1 and target_type='lease'
       and normalized_json->>'section'='current' order by normalized_json->>'unit_number'`, [act.id])).rows;
  ok("fixture: the real parser produced three current-lease claims", claims.length === 3, claims.length);
  const leases = [];
  for (const c of claims) leases.push((await activation.confirmProposal(pool, { user_id: user.id, proposed_id: c.id })).lease_id);
  const leaseRows = (await pool.query("select id, tenant_ids from leases where id = any($1::uuid[]) order by id", [leases])).rows;
  ok("fixture: three leases established, every one with NO tenant (row 156's refusal)",
    leaseRows.length === 3 && leaseRows.every((l) => Array.isArray(l.tenant_ids) && l.tenant_ids.length === 0),
    leaseRows.map((l) => l.tenant_ids));
  const rr0 = await currentRentRoll(pool, { property_id: property.id });
  ok("fixture: the rent roll counts all three as resident_not_linked", rr0.exceptions.resident_not_linked === 3, rr0.exceptions);

  // ── staff sessions: one on the property, one on a DIFFERENT property ──
  const mkSession = async (propId, modules) => {
    const tok = "proof-" + randomUUID();
    await pool.query(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
                      values ($1,$2,'Proof Manager',$3::text[],true)`, [user.id, propId, modules]);
    await pool.query(`insert into staff_sessions (user_id, property_id, token_digest, issuance_purpose, revoked, expires_at)
                      values ($1,$2,$3,'sms_otp',false, now() + interval '1 hour')`, [user.id, propId, sha256(tok)]);
    return tok;
  };
  const TOK = await mkSession(property.id, ["management", "leasing"]);
  const TOK_OTHER = await mkSession(other.id, ["management"]);

  // ── the real route, over a real socket ──────────────────────────────
  const app = express();
  app.use(express.json());
  app.use("/", require(path.join(root, "src/tenancy/link_resident.js"))({ pool }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const link = (leaseId, body, token = TOK) => fetch(`${base}/operator/leases/${leaseId}/link-resident`, {
    method: "POST", headers: { "content-type": "application/json", "x-staff-session": token },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

  const claimFor = (leaseId) => one(
    `select pr.id, pr.status, pr.resolution_kind, pr.promoted_record_id, pr.confirmed_by, pr.import_source_row_id
       from proposed_records pr
      where pr.target_type='person' and pr.import_source_row_id = (
        select import_source_row_id from proposed_records where promoted_record_id=$1 and target_type='lease' limit 1)
      order by pr.created_at desc limit 1`, [leaseId]);

  console.log("\n1 · link by phone — a Person is created and the lease names them");
  const r1 = await link(leases[0], { phone: PH_LINK, source_basis: "called the resident to confirm" });
  ok("the door answers 200", r1.status === 200, r1);
  ok("outcome is created", r1.json && r1.json.outcome === "created", r1.json);
  const l1 = await one("select tenant_ids from leases where id=$1", [leases[0]]);
  ok("the lease now names exactly that person", l1.tenant_ids.length === 1 && String(l1.tenant_ids[0]) === String(r1.json.person_id), l1.tenant_ids);
  const p1 = await one("select primary_phone_e164, name, lifecycle_status, leasing_stage from persons where id=$1", [r1.json.person_id]);
  ok("the Person carries the continuity handle — the whole point of row 156", p1 && p1.primary_phone_e164 === "+1" + PH_LINK, p1);
  ok("SEAM 2: a CREATED person is created a resident, not the ingress default 'lead'",
    p1 && p1.lifecycle_status === "resident" && p1.leasing_stage === "resident", p1);
  const c1 = await claimFor(leases[0]);
  ok("the staged claim is PROMOTED, with resolution_kind and promoted_record_id together (migration 177)",
    c1 && c1.status === "promoted" && c1.resolution_kind === "created" && String(c1.promoted_record_id) === String(r1.json.person_id) && c1.confirmed_by === String(user.id), c1);
  const e1 = await one("select produced_person_id from import_source_rows where id=$1", [c1.import_source_row_id]);
  ok("the evidence row names the person it produced", e1 && String(e1.produced_person_id) === String(r1.json.person_id), e1);
  const ev1 = await one("select type, note, person_id from events where person_id=$1 and type='resident_linked'", [r1.json.person_id]);
  ok("one resident_linked event, naming the handle KIND and the basis", ev1 && /by phone/.test(ev1.note) && /called the resident/.test(ev1.note), ev1);
  ok("the event does NOT record the phone number itself", ev1 && !new RegExp(PH_LINK).test(ev1.note), ev1 && ev1.note);

  console.log("\n2 · the canonical read changes, and only where it should");
  const rr1 = await currentRentRoll(pool, { property_id: property.id });
  const row1 = rr1.rows.find((r) => r.lease && String(r.lease.lease_id) === String(leases[0]));
  ok("the row now has a resident (person)", row1 && row1.resident && String(row1.resident.person_id) === String(r1.json.person_id), row1 && row1.resident);
  ok("… and resident_claim is gone — a claim is what stands in for a person, not beside one", row1 && row1.resident_claim === null, row1 && row1.resident_claim);
  ok("resident_not_linked dropped by exactly one", rr1.exceptions.resident_not_linked === 2, rr1.exceptions);
  ok("the tenancy itself did not move: still three contractually occupied",
    rr1.tenancy_summary && rr1.tenancy_summary.contractually_occupied === 3, rr1.tenancy_summary);

  console.log("\n3 · the SAME phone on a second lease resolves to the SAME person");
  const r2 = await link(leases[1], { phone: PH_LINK, source_basis: "same resident, second bed" });
  ok("outcome is resolved_existing, not a second create", r2.status === 200 && r2.json.outcome === "resolved_existing", r2.json);
  ok("it is the same person_id", String(r2.json.person_id) === String(r1.json.person_id), { first: r1.json.person_id, second: r2.json.person_id });
  const dupes = await one("select count(*)::int n from persons where primary_phone_e164=$1", ["+1" + PH_LINK]);
  ok("ONE Person carries that phone, on two leases", dupes.n === 1, dupes);
  const c2 = await claimFor(leases[1]);
  ok("the second claim records HOW it resolved — recognised, not created", c2 && c2.resolution_kind === "resolved_existing", c2);

  console.log("\n4 · a handle on two Persons is a conflict — 409, and nothing is written");
  const dupA = await one("insert into persons(name,primary_phone_e164) values($1,$2) returning id", ["Dup One " + NONCE, "+1" + PH_DUP]);
  const dupB = await one("insert into persons(name,primary_phone_e164) values($1,$2) returning id", ["Dup Two " + NONCE, "+1" + PH_DUP]);
  const r3 = await link(leases[2], { phone: PH_DUP, source_basis: "resident gave this number" });
  ok("the door refuses with 409", r3.status === 409, r3);
  ok("it names the disagreement rather than choosing", /more than one person/i.test((r3.json || {}).receipt || ""), r3.json && r3.json.receipt);
  ok("the candidates travel, so a human can resolve it", Array.isArray(r3.json.candidates) && r3.json.candidates.length >= 2, r3.json && r3.json.candidates);
  const l3 = await one("select tenant_ids from leases where id=$1", [leases[2]]);
  ok("NOTHING was written: the lease still has no tenant", l3.tenant_ids.length === 0, l3.tenant_ids);
  const c3 = await claimFor(leases[2]);
  ok("… and the claim is still staged, unpromoted", c3 && c3.status === "staged" && c3.promoted_record_id == null, c3);
  const rr3 = await currentRentRoll(pool, { property_id: property.id });
  ok("… and the rent roll is unchanged by the refusal", rr3.exceptions.resident_not_linked === 1, rr3.exceptions);

  console.log("\n5 · the refusals");
  const rWrong = await link(leases[2], { phone: "215550" + NONCE, source_basis: "x" }, TOK_OTHER);
  ok("a lease on another property is NOT FOUND, not forbidden (a 403 would confirm it exists)", rWrong.status === 404, rWrong);
  const rTaken = await link(leases[0], { phone: "215551" + NONCE, source_basis: "x" });
  ok("an already-linked lease refuses rather than adding a second resident", rTaken.status === 409 && /already has a resident/i.test(rTaken.json.receipt), rTaken.json);
  const rNoHandle = await link(leases[2], { source_basis: "x" });
  ok("no phone and no email refuses, and says why a name is not enough", rNoHandle.status === 400 && /name alone is not/i.test(rNoHandle.json.receipt), rNoHandle.json);
  const rBlank = await link(leases[2], { phone: "   ", source_basis: "x" });
  ok("a handle that normalises to nothing is the same refusal", rBlank.status === 400, rBlank);
  const rNoBasis = await link(leases[2], { phone: "215552" + NONCE });
  ok("no source_basis refuses — how a resident was identified is part of the record", rNoBasis.status === 400 && /where this phone or email came from/i.test(rNoBasis.json.receipt), rNoBasis.json);
  const rNoSession = await fetch(`${base}/operator/leases/${leases[2]}/link-resident`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "2155550000", source_basis: "x" }) })
    .then(async (r) => ({ status: r.status }));
  ok("no session is 401", rNoSession.status === 401, rNoSession);
  const rClientAuth = await link(leases[2], { phone: "215553" + NONCE, source_basis: "x", property_id: other.id });
  ok("§21: a client-supplied property_id is REFUSED, not ignored", rClientAuth.status === 403, rClientAuth);

  console.log("\n6 · the lease is still unlinked after every refusal");
  const lFinal = await one("select tenant_ids from leases where id=$1", [leases[2]]);
  ok("unit 103 was never touched by any of them", lFinal.tenant_ids.length === 0, lFinal.tenant_ids);
  const stray = await one("select count(*)::int n from persons where name = any($1::text[])", [[N3]]);
  ok("and no Person was minted from its name by any refusal", stray.n === 0, stray);

  // ────────────────────────────────────────────────────────────────────
  //  7 · SEAM 2 — resolved_existing advances a 'lead' person to 'resident',
  //  and never downgrades a person with a MORE specific status already.
  //  Two spare leases, off-rent-roll (no matching import claim), exactly
  //  the same pattern identity_loop_closes.db.js uses for its negative
  //  control: real units and spaces so the door's own property/space/lease
  //  reads are exercised for real, invisible to the CSV-driven rent-roll
  //  assertions above.
  console.log("\n7 · SEAM 2 — resolved_existing on 'lead' advances; on 'tenant' does not move");
  const mkSpareLease = async (unitNumber) => {
    const u = await one("insert into units (property_id, unit_number) values ($1,$2) returning id", [property.id, unitNumber]);
    const sp = await one("insert into spaces (unit_id) values ($1) returning id", [u.id]);
    return one(`insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
                values ($1,$2,'{}','active','2026-07-01','2027-06-30',900) returning id`, [property.id, sp.id]);
  };

  const PH_LEAD = "215560" + NONCE;
  const leadPerson = await one(
    "insert into persons(name, primary_phone_e164, lifecycle_status, leasing_stage) values ($1,$2,'lead','lead') returning id",
    ["Pre-existing Lead " + NONCE, "+1" + PH_LEAD]);
  const leaseLead = await mkSpareLease("197");
  const rLead = await link(leaseLead.id, { phone: PH_LEAD, source_basis: "recognised from a prior inquiry" });
  ok("resolved_existing, not a second create", rLead.status === 200 && rLead.json.outcome === "resolved_existing", rLead.json);
  ok("it is the SAME pre-existing person", String(rLead.json.person_id) === String(leadPerson.id), { got: rLead.json.person_id, want: leadPerson.id });
  const leadAfter = await one("select lifecycle_status, leasing_stage from persons where id=$1", [leadPerson.id]);
  ok("a 'lead' person is ADVANCED to 'resident' — a lease in force is presence",
    leadAfter.lifecycle_status === "resident" && leadAfter.leasing_stage === "resident", leadAfter);
  const evLead = await one("select note from events where person_id=$1 and type='resident_linked' order by occurred_at desc limit 1", [leadPerson.id]);
  ok("the event names the lifecycle advance", evLead && /[Ll]ifecycle advanced to resident/.test(evLead.note), evLead);

  const PH_TENANT = "215557" + NONCE;
  const tenantPerson = await one(
    "insert into persons(name, primary_phone_e164, lifecycle_status, leasing_stage) values ($1,$2,'tenant','tenant') returning id",
    ["Pre-existing Tenant " + NONCE, "+1" + PH_TENANT]);
  const leaseTenant = await mkSpareLease("198");
  const rTenant = await link(leaseTenant.id, { phone: PH_TENANT, source_basis: "recognised, already a tenant elsewhere" });
  ok("resolved_existing on the tenant too", rTenant.status === 200 && rTenant.json.outcome === "resolved_existing", rTenant.json);
  const tenantAfter = await one("select lifecycle_status, leasing_stage from persons where id=$1", [tenantPerson.id]);
  ok("a 'tenant' person is left UNCHANGED — this door recognises presence, it never downgrades a more specific status",
    tenantAfter.lifecycle_status === "tenant" && tenantAfter.leasing_stage === "tenant", tenantAfter);
  const evTenant = await one("select note from events where person_id=$1 and type='resident_linked' order by occurred_at desc limit 1", [tenantPerson.id]);
  ok("… and the event does NOT claim a lifecycle advance that did not happen",
    evTenant && !/[Ll]ifecycle advanced/.test(evTenant.note), evTenant);

  await new Promise((r) => server.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("HARNESS:", e.stack || e.message); try { await pool.end(); } catch (_) {} process.exit(2); });
