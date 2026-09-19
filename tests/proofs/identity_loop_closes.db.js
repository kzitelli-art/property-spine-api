"use strict";
/*  ══════════════════════════════════════════════════════════════════════
    identity_loop_closes.db.js — ONE RESIDENT, ALL THE WAY ROUND
    (CURRENT_STATE rows 156 → 158 → 159 → 160).

    Three rows built three pieces: the refusal that stages a name-only claim
    (156), the Ask Spine read of that exception (158), and the door that
    links the resident once a handle exists (159). Each was proven alone.
    This walks ONE resident through all of it and asserts at every seam,
    because three green proofs of three pieces is not a proof that the loop
    closes.

    THE LOOP:
      rent roll row (name only) → lease, no tenant, claim staged
        → screen AND Ask Spine both say resident_not_linked
        → management links by phone
        → screen AND Ask Spine both say linked, same read
        → that phone texts the property line → attributed to that person
        → Person Card shows the tenancy
        → Ask Spine, entitled, names the resident; unentitled gets nothing
      → and the OLD door onto the same lease refuses, naming the new one

    TWO FINDINGS ARE RECORDED AS ASSERTIONS, NOT AS NOTES: the inbound text
    does not recognise the linked resident (seam 3), and the linked resident
    never leaves lifecycle 'lead' (seam 2). Widen either and a test goes red.

    WHERE EACH SEAM IS ENTERED, SAID PRECISELY:
      · Deal Setup, link-resident and Person Card go through REAL HTTP or
        their real services.
      · The inbound SMS enters at `resolveInboundSmsContext` — the canonical
        resolver the /communications/inbound-sms webhook calls, and the seam
        that DECIDES attribution. The transport above it (Twilio signature,
        provider ack, work-order dispatch) is exercised by
        resident_sms_route_proof.db.js and is NOT re-proven here.
      · No model is invoked. The Ask Spine client is a stub that THROWS if
        called, so a passing tenancy answer is a governed read and not a
        sentence someone generated.
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
const { readTenancyStanding } = require(path.join(root, "src/tenancy/tenancy_position_read.js"));
const askSpineAnswer = require(path.join(root, "src/agent/ask_spine_answer.js"));
const { reviewedIngest } = require("../helpers/reviewed_source.js");

let pool, passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log("  ok    " + label); }
  else { failed++; console.log("  FAIL  " + label + (detail !== undefined ? "\n        " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : "")); }
};
const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];
const sha256 = (v) => createHash("sha256").update(v).digest("hex");

const NONCE = String(1000 + Math.floor(Math.random() * 8999));
const RESIDENT_PHONE = "215561" + NONCE;   // the one resident, all the way round
const STRANGER_PHONE = "215562" + NONCE;   // negative control: never this resident
const DUP_PHONE      = "215563" + NONCE;   // deliberately on two Persons
const LINE           = "+1215564" + NONCE; // the property's own line
const NAME = "Jordan Vale";
const UNIT = "101";
const csv = `Unit,Room,Resident,Market Rent,Actual Rent,Lease From,Lease To
${UNIT},Room1,${NAME} (s0005738),900,850,2026-07-01,2027-06-30
`;

//  A client that THROWS if the model is reached. A tenancy answer that
//  passes here is a governed read, not generated prose.
const anthropicNever = { messages: { create: async () => { throw new Error("proof: the model must not be invoked"); } } };

(async () => {
  await boundary.assertDatabase();
  pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const tag = `idloop-${randomUUID().slice(0, 8)}`;

  // ── FIXTURE: the Deal Setup path, as production runs it ─────────────
  const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
  const human = await one("insert into persons(name,email) values('Loop Operator',$1) returning id", [`${tag}-op@example.test`]);
  const user = await one(`insert into users(name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
    values('Loop Operator',$1,'org_admin',$2,$3,true,'active','human_staff') returning id`, [`${tag}@example.test`, org.id, human.id]);
  const deal = await deals.createDeal(pool, { user_id: user.id, deal_name: tag, creation_source: "deal_setup_console" });
  const property = await one("insert into properties(name,canonical_key,organization_id,leasing_basis) values($1,$1,$2,'bed') returning id", [tag, org.id]);
  await deals.addProperty(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id });
  const act = (await activation.openActivation(pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id })).activation;
  const artifact = await artifacts.store(pool, { scope_type: "property", scope_id: property.id, filename: "loop.csv", mimetype: "text/csv",
    buffer: Buffer.from(csv), uploaded_by_user_id: user.id, source_as_of_date: "2026-07-31" });
  await reviewedIngest(activation, pool, { user_id: user.id, deal_intake_id: deal.id, property_id: property.id, activation_id: act.id,
    source_artifact_id: artifact.id, source_as_of_date: "2026-07-31" });
  await pool.query(`insert into communication_lines
      (e164, line_type, property_id, authority_ceiling, permitted_audience, inbound_enabled, outbound_enabled, outbound_policy, status)
    values ($1,'property_facing',$2,'external','residents_and_prospects',true,true,'proactive','active')`, [LINE, property.id]);

  const mkSession = async (propId, modules) => {
    const tok = "proof-" + randomUUID();
    await pool.query(`insert into property_team_assignments (user_id, property_id, role_title, allowed_modules, active)
                      values ($1,$2,'Proof Role',$3::text[],true)`, [user.id, propId, modules]);
    await pool.query(`insert into staff_sessions (user_id, property_id, token_digest, issuance_purpose, revoked, expires_at)
                      values ($1,$2,$3,'sms_otp',false, now() + interval '1 hour')`, [user.id, propId, sha256(tok)]);
    return tok;
  };
  const TOK = await mkSession(property.id, ["management", "leasing"]);

  const app = express();
  app.use(express.json());
  app.use("/", require(path.join(root, "src/tenancy/link_resident.js"))({ pool }));
  app.use("/", require(path.join(root, "src/identity/operator.js"))({ pool }));
  //  The RETIRED second door is mounted exactly as server.js mounts it
  //  (app.use("/", lease_lifecycle_routes({...}))), so seam 6 asserts the
  //  real registered path and not a path this proof invented. The obligation
  //  spawner THROWS: the refusal must never reach a handler that uses it.
  app.use("/", require(path.join(root, "src/tenancy/lease_lifecycle_routes.js"))({
    pool, spawnObligationFromEvent: () => { throw new Error("the retired door ran a handler"); } }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const linkReq = (leaseId, body, token = TOK) => fetch(`${base}/operator/leases/${leaseId}/link-resident`, {
    method: "POST", headers: { "content-type": "application/json", "x-staff-session": token },
    body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const ask = (question, modules) => askSpineAnswer.answer(pool, anthropicNever, {
    property_id: property.id, allowed_modules: modules, operator_user_id: user.id,
    primary_for_modules: [], question });

  // ══════════════════════════════════════════════════════════════════
  console.log("\n1 · the row establishes a tenancy and NO person — both readers agree");
  const claim = await one(`select * from proposed_records where activation_id=$1 and target_type='lease' and normalized_json->>'section'='current'`, [act.id]);
  const confirmed = await activation.confirmProposal(pool, { user_id: user.id, proposed_id: claim.id });
  const lease = await one("select id, tenant_ids, space_id from leases where id=$1", [confirmed.lease_id]);
  ok("the lease exists and carries NO tenant", lease && lease.tenant_ids.length === 0, lease && lease.tenant_ids);

  const rr1 = await currentRentRoll(pool, { property_id: property.id });
  const row1 = rr1.rows.find((r) => r.lease && String(r.lease.lease_id) === String(lease.id));
  ok("the SCREEN read: resident_not_linked = 1", rr1.exceptions.resident_not_linked === 1, rr1.exceptions);
  ok("the SCREEN read: the source's name stands as an unlinked CLAIM",
    row1 && row1.resident === null && row1.resident_claim && row1.resident_claim.name === NAME && row1.resident_claim.linked === false, row1 && row1.resident_claim);

  const st1 = await readTenancyStanding(pool, { property_id: property.id });
  ok("ASK SPINE's standing read says the SAME count — one read, two projections",
    st1.exceptions.resident_not_linked === rr1.exceptions.resident_not_linked && st1.exceptions.resident_not_linked === 1,
    { ask: st1.exceptions.resident_not_linked, screen: rr1.exceptions.resident_not_linked });
  const claimed = (st1.resident_claims_unlinked || []).find((c) => c.name === NAME);
  ok("… and lists the claimed name as unlinked", claimed && claimed.linked === false, st1.resident_claims_unlinked);

  // ══════════════════════════════════════════════════════════════════
  console.log("\n2 · management links by phone — both readers move together");
  const linked = await linkReq(lease.id, { phone: RESIDENT_PHONE, source_basis: "called the resident" });
  ok("the door answers 200 and created a person", linked.status === 200 && linked.json.outcome === "created", linked);
  const personId = linked.json && linked.json.person_id;
  const person = await one("select id, name, primary_phone_e164 from persons where id=$1", [personId]);
  ok("the Person carries the continuity handle", person && person.primary_phone_e164 === "+1" + RESIDENT_PHONE, person);
  const lease2 = await one("select tenant_ids from leases where id=$1", [lease.id]);
  ok("the lease names exactly that person", lease2.tenant_ids.length === 1 && String(lease2.tenant_ids[0]) === String(personId), lease2.tenant_ids);
  const pClaim = await one(`select status, resolution_kind, promoted_record_id from proposed_records
     where target_type='person' and activation_id=$1 order by created_at desc limit 1`, [act.id]);
  ok("the staged claim is promoted, and records HOW it resolved",
    pClaim && pClaim.status === "promoted" && pClaim.resolution_kind === "created" && String(pClaim.promoted_record_id) === String(personId), pClaim);

  //  ⛔ SECOND FINDING, MEASURED RATHER THAN READ OFF THE SOURCE.
  //  The retired POST /leases/:id/tenants advanced the person to 'tenant'
  //  and wrote a lifecycle_change event. link-resident does not: it passes
  //  no lifecycle_status to ingestPerson, which defaults to 'lead'. So a
  //  resident on an active lease reads 'lead' in the person lifecycle.
  //  It has a CONSEQUENCE worth naming: authority_resolution's
  //  HARD_COUNTERPARTY set is {tenant, resident, past_resident, applicant,
  //  vendor} — the values a staff context CANNOT override. 'lead' is not in
  //  it, so the "a real counterparty may not be granted staff authority"
  //  guard does not fire for a resident linked this way.
  //  NOT this slice's to fix (on `resolved_existing` ingress does not update
  //  an existing person, so a correct fix is a ruling about the lifecycle
  //  model, not a field). Asserted so it is evidence, and so that whoever
  //  fixes it has to come here and say so.
  const lifecycle = await one("select lifecycle_status, leasing_stage from persons where id=$1", [personId]);
  ok("⛔ FINDING: a linked resident on an active lease still reads lifecycle 'lead'",
    lifecycle.lifecycle_status === "lead", lifecycle);
  ok("… and 'lead' is outside the set a staff context cannot override",
    !["tenant", "resident", "past_resident", "applicant", "vendor"].includes(lifecycle.lifecycle_status), lifecycle);

  const rr2 = await currentRentRoll(pool, { property_id: property.id });
  const row2 = rr2.rows.find((r) => r.lease && String(r.lease.lease_id) === String(lease.id));
  ok("the SCREEN read: resident_not_linked = 0", rr2.exceptions.resident_not_linked === 0, rr2.exceptions);
  ok("the SCREEN read: resident is the person, and the claim is gone",
    row2 && row2.resident && String(row2.resident.person_id) === String(personId) && row2.resident_claim === null, row2 && { r: row2.resident, c: row2.resident_claim });
  const st2 = await readTenancyStanding(pool, { property_id: property.id });
  ok("ASK SPINE's standing read moved with it — still the same read",
    st2.exceptions.resident_not_linked === 0 && (st2.resident_claims_unlinked || []).length === 0,
    { count: st2.exceptions.resident_not_linked, claims: st2.resident_claims_unlinked });

  // ══════════════════════════════════════════════════════════════════
  console.log("\n3 · that phone texts the property line — recognised, not re-created");
  const commBoundary = require(path.join(root, "src/comms/communications_boundary.js"))({
    pool, sms: { enabled: () => true, validateWebhook: () => true, sendSms: async () => { throw new Error("proof: no outbound"); } } });
  const personsBefore = (await one("select count(*)::int n from persons")).n;
  const inbound = await commBoundary.resolveInboundSmsContext({
    To: LINE, From: "+1" + RESIDENT_PHONE, MessageSid: "SM" + randomUUID().replace(/-/g, "").slice(0, 30), body: "my sink is leaking" });
  ok("the inbound resolved to THIS property", inbound.property && String(inbound.property.id) === String(property.id), inbound.property);
  /*  ⛔ THE LOOP DOES NOT CLOSE HERE. THIS IS THE FINDING.
   *
   *  The resident is linked: an active lease at this property carries their
   *  person id, and that Person's primary_phone_e164 is the number texting
   *  in. They are still resolved as an UNMATCHED sender.
   *
   *  Why, exactly: tier 1 of the inbound sender resolution requires
   *      join tenant_invites ti on ti.person_id = per.id
   *                            and ti.property_id = $1 and ti.status = 'used'
   *  — a resident who has ACCEPTED an invite. Tier 2 requires an open
   *  leasing lead. A rent-roll resident linked by an operator has neither.
   *
   *  This is arguably CORRECT, not a bug, and that is why it is reported
   *  rather than fixed: an operator typing a phone into a lease is an
   *  operator's CLAIM that the number is theirs; an accepted invite is the
   *  RESIDENT proving it. Attributing inbound texts — which open work
   *  orders and disclose tenancy — on the claim alone would widen trust
   *  materially. Changing tier 1 is an authorization decision, not a small
   *  in-blast-radius fix.
   *
   *  So row 136's promise ("recognise a resident who texts next year")
   *  needs BOTH: link (row 159) establishes the person; verification
   *  establishes that the phone is theirs. The second half does not exist.
   *
   *  These assertions record the CURRENT truth. If inbound recognition is
   *  ever widened, they go red and name this comment — which is correct.  */
  ok("⛔ FINDING: the linked resident is NOT recognised — tier 1 needs a USED tenant invite",
    inbound.person === null && inbound.ambiguous === true, { person: inbound.person, ambiguous: inbound.ambiguous });
  ok("the text is preserved on the property for a human, not guessed at",
    inbound.comm_event && inbound.comm_event.person_id === null && inbound.comm_event.needs_human === true,
    inbound.comm_event && { p: inbound.comm_event.person_id, nh: inbound.comm_event.needs_human });
  ok("and the gap is exactly the invite: this resident has no used tenant_invite",
    (await one("select count(*)::int n from tenant_invites where person_id=$1 and status='used'", [personId])).n === 0);
  const personsAfter = (await one("select count(*)::int n from persons")).n;
  ok("NO second Person was created by the text", personsAfter === personsBefore, { before: personsBefore, after: personsAfter });
  const dupPhone = (await one("select count(*)::int n from persons where primary_phone_e164=$1", ["+1" + RESIDENT_PHONE])).n;
  ok("exactly ONE Person carries that phone", dupPhone === 1, dupPhone);

  console.log("\n3b · NEGATIVE CONTROL — a different phone is not this resident");
  const stranger = await commBoundary.resolveInboundSmsContext({
    To: LINE, From: "+1" + STRANGER_PHONE, MessageSid: "SM" + randomUUID().replace(/-/g, "").slice(0, 30), body: "hello" });
  ok("a stranger's text is NOT attributed to the linked resident",
    !stranger.person || String(stranger.person.id) !== String(personId), stranger.person);
  ok("it is kept on the property for a human instead of guessed",
    stranger.ambiguous === true && stranger.comm_event && stranger.comm_event.person_id === null,
    { ambiguous: stranger.ambiguous, ce: stranger.comm_event && { p: stranger.comm_event.person_id, nh: stranger.comm_event.needs_human } });

  // ══════════════════════════════════════════════════════════════════
  console.log("\n4 · the Person Card shows the tenancy");
  const card = await fetch(`${base}/operator/leasing/person-card?person_id=${personId}`, { headers: { "x-staff-session": TOK } })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("the canonical Person Card read answers 200", card.status === 200, card.status);
  const cardStr = JSON.stringify(card.json || {});
  ok("it names this person", card.json && (card.json.person || {}).id === personId, card.json && card.json.person);
  ok("and it shows a presence/tenancy at this property — not an empty card",
    /"(presence|tenancy|lease)"/.test(cardStr) && !/"presence"\s*:\s*(false|null)/.test(cardStr), cardStr.slice(0, 300));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n5 · Ask Spine, entitled and not");
  const entitled = await ask(`who lives in ${UNIT}`, ["leasing", "management"]);
  /*  The model owns WORDING, never authority. With the client stubbed to
   *  throw, the authorization decision still completes and the answer
   *  degrades to "couldn't reach the assistant" — which is the doctrine
   *  working. So what is asserted here is the part that must never depend
   *  on a model: entitlement. The resident being READABLE to an entitled
   *  reader is proven above, on the governed standing read, where it
   *  belongs. The generated sentence is NOT exercised by this proof.  */
  ok("an entitled operator passes authorization (the model is never consulted for that)",
    entitled && entitled.outcome !== "not_authorized", entitled && { o: entitled.outcome });

  const unentitled = await ask(`who lives in ${UNIT}`, ["maintenance"]);
  ok("an unentitled session is refused", unentitled && unentitled.outcome === "not_authorized", unentitled && unentitled.outcome);
  ok("… and the refusal discloses no name", !new RegExp(NAME).test(JSON.stringify(unentitled)), JSON.stringify(unentitled).slice(0, 200));

  // ══════════════════════════════════════════════════════════════════
  console.log("\n6 · NEGATIVE CONTROL — a handle on two Persons refuses and writes nothing");
  await pool.query("insert into persons(name,primary_phone_e164) values($1,$2),($3,$2)",
    ["Dup One " + NONCE, "+1" + DUP_PHONE, "Dup Two " + NONCE]);
  //  A lease with NO space, so it is invisible to the rent roll and cannot
  //  disturb the counts above. It exists only to be refused.
  //  leases.space_id is NOT NULL — a lease names a space. So this spare gets
  //  a real unit and space, which means it IS visible to the rent roll as a
  //  second unlinked lease. The counts below account for it rather than
  //  pretending it is invisible.
  const spUnit = await one("insert into units (property_id, unit_number) values ($1,$2) returning id", [property.id, "199"]);
  const spSpace = await one("insert into spaces (unit_id) values ($1) returning id", [spUnit.id]);
  const spare = await one(`insert into leases (property_id, space_id, tenant_ids, lease_status, start_date, end_date, rent)
                           values ($1,$2,'{}','active','2026-07-01','2027-06-30',900) returning id`, [property.id, spSpace.id]);
  const conflicted = await linkReq(spare.id, { phone: DUP_PHONE, source_basis: "resident gave this number" });
  ok("the door refuses 409", conflicted.status === 409, conflicted);
  ok("it names the disagreement and carries the candidates",
    /more than one person/i.test((conflicted.json || {}).receipt || "") && (conflicted.json.candidates || []).length >= 2, conflicted.json);
  const spareAfter = await one("select tenant_ids from leases where id=$1", [spare.id]);
  ok("nothing was written", spareAfter.tenant_ids.length === 0, spareAfter.tenant_ids);
  const rr3 = await currentRentRoll(pool, { property_id: property.id });
  const row3 = rr3.rows.find((r) => r.lease && String(r.lease.lease_id) === String(lease.id));
  ok("the refusal changed nothing: the spare is the ONLY unlinked lease",
    rr3.exceptions.resident_not_linked === 1, rr3.exceptions);
  ok("and the resident we linked is still linked", row3 && row3.resident && String(row3.resident.person_id) === String(personId), row3 && row3.resident);


  // ══════════════════════════════════════════════════════════════════
  console.log("\n7 · the SECOND door onto 'who is on this lease' is closed");
  //  Two doors is how one lease ends up with two answers about the same
  //  resident. POST /leases/:id/tenants took a person_id straight onto a
  //  lease with no property scope, no session, no ingress. It now refuses.
  //  This asserts the refusal AND that the refusal WROTE NOTHING — a 410
  //  that still mutated would be the worst of both.
  const beforeRetired = await one("select tenant_ids from leases where id=$1", [spare.id]);
  const retired = await fetch(`${base}/leases/${spare.id}/tenants`, {
    method: "POST", headers: { "content-type": "application/json", "x-staff-session": TOK },
    body: JSON.stringify({ person_id: personId }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  ok("the retired door answers 410 Gone, not 404 and not success", retired.status === 410, retired);
  ok("the refusal NAMES the door to use instead — a refusal must be sayable and name a next step",
    /link-resident/.test((retired.json || {}).receipt || "") && (retired.json || {}).next_step === "POST /operator/leases/:leaseId/link-resident",
    retired.json);
  ok("the refusal does not leak machinery at a person who typed a name",
    !/person_id|tenant_ids|ingress|proposed_record/i.test((retired.json || {}).receipt || ""), retired.json);
  const afterRetired = await one("select tenant_ids from leases where id=$1", [spare.id]);
  ok("and it wrote NOTHING — the lease is untouched",
    JSON.stringify(afterRetired.tenant_ids) === JSON.stringify(beforeRetired.tenant_ids), { before: beforeRetired.tenant_ids, after: afterRetired.tenant_ids });
  const rr4 = await currentRentRoll(pool, { property_id: property.id });
  ok("the canonical read is unchanged by the refusal",
    rr4.exceptions.resident_not_linked === rr3.exceptions.resident_not_linked, { before: rr3.exceptions, after: rr4.exceptions });

  await new Promise((r) => server.close(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error("HARNESS:", e.stack || e.message); try { await pool.end(); } catch (_) {} process.exit(2); });
