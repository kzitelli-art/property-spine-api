/* ════════════════════════════════════════════════════════════════════
   application_to_lease_journey.db.js — ONE CONTINUOUS JOURNEY, THROUGH
   THE REAL PUBLIC SUBMISSION DOOR.

     invitation prepared and attested sent
       → applicant submits at POST /applications/submit-public  (real HTTP)
       → completion is what is owed, not a lease
       → completion closes → package owed + decision live, together
       → package prepared and dispatched, no person acting
       → applicant signs at POST /t/lease/:token/submit          (real HTTP)
       → the bed is held; the signing clock stops

   Plus the two branches that matter as much as the happy path:
     REJECTION        a denied application releases its bed and owes nothing
     FAILED DELIVERY  an unreachable applicant is a SYSTEM failure; the work
                      stays owed and nothing is closed as done

   The unit tests and the durable-handoff proof each exercise one link.
   This is the only place the links are exercised AS A CHAIN, and the only
   place the applicant's two acts go through the doors a real applicant
   actually touches.

   Requires the API on E2E_API_BASE against the SAME database.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

const root = path.resolve(__dirname, "..", "..");
const engine = require(path.join(root, "src/shared/obligation_engine.js"));
const leasePacketsModule = require(path.join(root, "src/applications/lease_packets.js"));
const leaseHandoffModule = require(path.join(root, "src/applications/lease_handoff.js"));
const submissionModule = require(path.join(root, "src/applications/application_submission.js"));
const leasingConversionModule = require(path.join(root, "src/leasing/leasing_conversion.js"));
const { createConversionClosureAuthority } = require(path.join(root, "src/leasing/conversion_obligation_closure.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const applicationHold = require(path.join(root, "src/applications/application_inventory_hold.js"));
const { materializeRentableSpaces } = require(path.join(root, "src/tenancy/inventory_materialization.js"));
const { prepareApplicationOffer } = require(path.join(root, "src/money/application_offer_terms.js"));

const API = process.env.E2E_API_BASE || "http://127.0.0.1:3100";

let pass = 0, fail = 0; const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};
const get = async (p) => {
  const r = await fetch(`${API}${p}`);
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
};
const post = async (p, body) => {
  const r = await fetch(`${API}${p}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, body: j };
};

function tenantV3Capture({ email, phone, desiredMoveIn }) {
  return {
    application_form_version: "tenant_v3",
    date_of_birth: "1996-04-11", email, phone,
    address: { line1: "12 Prior Street", city: "Philadelphia", state: "PA", postal_code: "19104" },
    current_since: "2024-06", housing_status: "rent",
    income_status: "employed", income_amount: 5200, income_frequency: "monthly",
    employer: "Kestrel Labs", job_title: "Analyst",
    desired_move_in: desiredMoveIn, move_flexibility: "exact",
    occupants: 1, has_pets: "no", guarantor_needed: "no",
    applicant_accuracy_certified: true, electronic_delivery_consent: true,
  };
}

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  const leasePackets = leasePacketsModule({ pool,
    satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation })._service;

  const runId = randomUUID().slice(0, 8);
  const sent = [];
  const commBoundary = require(path.join(root, "src/comms/communications_boundary.js"))({ pool,
    sms: { enabled: () => true,
      sendSms: async ({ to, body }) => {
        sent.push({ to, body });
        return { sent: true, sid: `JRN-${runId}-${sent.length}`, status: "queued" };
      } } });
  //  A transport that is OFF, for the failed-delivery branch. Same module,
  //  different wire — so the branch measures the handoff's handling and not
  //  a difference in the code under test.
  const deadBoundary = require(path.join(root, "src/comms/communications_boundary.js"))({ pool,
    sms: { enabled: () => false } });

  const handoffOf = (cb) => leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    satisfyObligation: engine.satisfyObligation,
    completeObligation: engine.completeObligation, leasePackets, commBoundary: cb });
  const handoff = handoffOf(commBoundary);
  const handoffDead = handoffOf(deadBoundary);

  //  The invitation service, built exactly as server.js builds it. The raw
  //  token exists only in this call's return — which is why the invitation
  //  cannot be minted by the proof's own INSERT and still be submittable.
  const conv = leasingConversionModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation,
    closureAuthority: createConversionClosureAuthority() });
  const submission = submissionModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation,
    conversionService: conv._service, commBoundary, leaseHandoff: handoff })._service;

  const tag = `journey-${randomUUID().slice(0, 8)}`;
  try {
    // ── FIXTURE ────────────────────────────────────────────────────
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const personOf = async (n, phone = null) => {
      const p = await one("insert into persons(name) values($1) returning id", [n]);
      if (phone) await pool.query("update persons set primary_phone_e164=$2 where id=$1", [p.id, phone]);
      return p.id;
    };
    const opPerson = await personOf(`${tag}-operator`);
    const applicant = await personOf(`${tag}-applicant`, "+12025550388");
    const denied = await personOf(`${tag}-denied`, "+12025550389");
    const unreachable = await personOf(`${tag}-unreachable`);      // NO phone, deliberately
    const operator = await one(`insert into users
      (name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
      [`${tag} op`, `${tag}@example.test`, org.id, opPerson]);
    const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis,address)
      values($1,$1,$2,'bed',$3) returning id`,
      [`${tag} property`, org.id, "4233 Chestnut Street, Philadelphia, PA 19104"]);
    await pool.query(`insert into property_team_assignments
      (property_id,user_id,role_title,allowed_modules,active,can_manage_roles)
      values($1,$2,'Proof Seat','{management,leasing}',true,true)`, [property.id, operator.id]);
    await pool.query(`insert into assignments
      (person_id,property_id,role,scope,is_active,provenance)
      values($1,$2,'property_manager','all',true,'{"source":"proof"}'::jsonb)`, [opPerson, property.id]);
    await pool.query(`insert into leasing_leads(property_id,person_id) values($1,$2),($1,$3),($1,$4)`,
      [property.id, applicant, denied, unreachable]);
    await pool.query(`update properties set lease_config = $2::jsonb where id = $1`,
      [property.id, JSON.stringify({
        landlord_entity: `${tag} Holdings, LLC`,
        rent_payment_location: "the on-site manager's office",
        application_fee: "50.00", amenity_fee: "300.00", telecom_fee: "0.00",
        utility_responsibility: "Resident pays all utilities.",
        late_fee: "75.00",
        notice_requirement: "At least 60 days' written notice before the end of the term.",
        insurance_note: "Renter's insurance is recommended.",
      })]);
    await pool.query(`insert into communication_lines
        (e164, line_type, property_id, authority_ceiling, permitted_audience,
         inbound_enabled, outbound_enabled, outbound_policy, status)
       values ($1,'property_facing',$2,'external','residents_and_prospects',
               true,true,'proactive','active')`,
      [`+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`, property.id]);
    await pool.query(`insert into contact_preferences (person_id, channel, consent_state)
       values ($1,'text','opted_in'),($2,'text','opted_in'),($3,'text','opted_in')`,
      [applicant, denied, unreachable]);

    //  THREE BEDS, all established vacant through the real opening chain.
    const unit = await one("insert into units(property_id,unit_number) values($1,'601') returning id", [property.id]);
    await pool.query("delete from spaces where unit_id=$1", [unit.id]);
    await materializeRentableSpaces(pool, { unit_id: unit.id, labels: ["A", "B", "C"], kind: "bed" });
    await pool.query("update spaces set use_type='residential' where unit_id=$1", [unit.id]);
    const bed = {};
    for (const l of ["A", "B", "C"]) {
      bed[l] = (await one("select id from spaces where unit_id=$1 and space_label=$2", [unit.id, l])).id;
    }
    const batch = await one(`insert into import_batches(property_id,source_type,source_file,
      source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger',$2,date '2026-07-31','bed','confirmed','committed') returning id`,
      [property.id, `${tag}.csv`]);
    const act = await one(`insert into activations(property_id,status,source_as_of_date,
      import_batch_id,source_label) values($1,'activated',date '2026-07-31',$2,$3) returning id`,
      [property.id, batch.id, `${tag}.csv`]);
    let ri = 0;
    for (const l of ["A", "B", "C"]) {
      ri++;
      const srcRow = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,
        produced_unit_id,produced_space_id) values($1,$2,$3,'fixture: confirmed vacancy',$4,$5) returning id`,
        [batch.id, ri, JSON.stringify({ unit_number: "601", space_label: l, is_vacant: true }), unit.id, bed[l]]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,
        normalized_json,status,status_reason,import_source_row_id,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted','Fixture: confirmed vacant rentable position.',$5,now())`,
        [act.id, property.id, `601|${l}`,
         JSON.stringify({ section: "current", unit_number: "601", space_label: l, is_vacant: true }), srcRow.id]);
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,activation_id,import_batch_id,
      as_of_date,positions_established,positions_unresolved,source_rows_read,authority_basis,status)
      values($1,$2,$3,date '2026-07-31',3,0,3,'fixture:application_to_lease_journey.db.js','established')`,
      [property.id, act.id, batch.id]);

    //  ONE HELPER, THREE JOURNEYS. Every applicant below walks the same
    //  doors; only the branch differs.
    async function invitedApplicant({ person, spaceId, key }) {
      const c = await pool.connect();
      let offer, prepared;
      try {
        await c.query("begin");
        offer = await prepareApplicationOffer(c, {
          actor: { id: operator.id, property_id: property.id },
          person_id: person, space_id: spaceId,
          lease_start_date: "2026-11-01", lease_end_date: "2027-10-31",
          rent: 1450, security_deposit: 1450, fees: [], concessions: { status: "none" },
          idempotency_key: `${tag}-${key}`,
        });
        prepared = await submission.createPreparedInvitation(c, {
          property_id: property.id, person_id: person, space_id: spaceId,
          created_by_user_id: operator.id, application_offer_id: offer.offer.id,
        });
        //  A 'prepared' link cannot be submitted — the send must be attested.
        //  That refusal is the product's, and the journey obeys it.
        await submission.attestInvitationSent(c, {
          invitation_id: prepared.invitation_id, dispatch_source: "manual",
          channel: "sms", recipient_snapshot: "+12025550388", sent_by_user_id: operator.id });
        await c.query("commit");
      } catch (e) { await c.query("rollback").catch(() => {}); throw e; }
      finally { c.release(); }
      return { offer, token: prepared.token, invitation_id: prepared.invitation_id };
    }

    // ══ JOURNEY 1 · THE WHOLE CHAIN ═══════════════════════════════
    const j1 = await invitedApplicant({ person: applicant, spaceId: bed.A, key: "a" });

    /*  ⚠ THE TERMS ARE ACKNOWLEDGED FROM THE PAGE THE APPLICANT READS.
     *  requireTermsAcknowledgement compares the submitted hash against the
     *  CURRENT offer, so a proof that reached into the database for it would
     *  be acknowledging terms nobody was shown. The hash is taken from
     *  GET /t/application/:token/context — the applicant's own door.      */
    const ctx1 = await get(`/t/application/${j1.token}/context`);
    ok("the applicant's page shows them the exact terms to acknowledge",
      ctx1.status === 200 && !!(ctx1.body && ctx1.body.application_terms
        && ctx1.body.application_terms.terms_hash),
      `${ctx1.status} ${JSON.stringify(ctx1.body).slice(0, 220)}`);
    const hash1 = ctx1.body && ctx1.body.application_terms
      && ctx1.body.application_terms.terms_hash;

    const submitted = await post("/applications/submit-public", {
      token: j1.token, applicant_name: `${tag} applicant`,
      application_terms_acknowledged: true, application_terms_hash: hash1,
      captured: tenantV3Capture({ email: "a@example.test", phone: "+12025550388",
        desiredMoveIn: "2026-11-01" }) });
    ok("the applicant submits through the REAL public door",
      submitted.status === 200 && !!submitted.body.application,
      `${submitted.status} ${JSON.stringify(submitted.body).slice(0, 220)}`);
    const appId = submitted.body.application && submitted.body.application.id;

    /*  ⚠ THE BOUNDARY, THROUGH THE PRODUCT'S OWN RESPONSE. Submission
     *  returns what is owed — the applicant's completion — and the receipt
     *  names the approver. It does NOT return a lease.                    */
    ok("…and what submission owes is COMPLETION, reported in its own response",
      !!submitted.body.completion_obligation_id, JSON.stringify({
        completion: submitted.body.completion_obligation_id,
        outstanding: submitted.body.outstanding_requirements }));
    ok("…and the application is `submitted`, not approved",
      submitted.body.application.status === "submitted", submitted.body.application.status);

    const standing1 = await handoff.readApplicationHandoffStanding(pool, appId);
    ok("…and the standing read says the package is owed with nothing outstanding",
      standing1.position === "package_owed" && standing1.outstanding.length === 0,
      JSON.stringify(standing1));
    ok("…and the approver's decision is LIVE, with nobody notified and that said out loud",
      standing1.decision.state === "awaiting_decision"
        && standing1.decision.approver_notified === false,
      JSON.stringify(standing1.decision));

    const run1 = await handoff.runOwedHandoffs({ application_id: appId });
    ok("the package is prepared and dispatched with NO person acting",
      (run1.results[0] || {}).outcome === "accepted", JSON.stringify(run1.results[0]));

    const link1 = (sent[sent.length - 1] || {}).body || "";
    const tok1 = (link1.match(/\/t\/lease\/([A-Za-z0-9_-]+)/) || [])[1] || null;
    const pk1 = await one(
      `select id from lease_packets where application_id=$1 and superseded_at is null`, [appId]);
    for (const f of (await pool.query(
      `select id from lease_packet_fields where lease_packet_id=$1
        and signer_role='tenant' and required=true`, [pk1.id])).rows) {
      const r = await post(`/t/lease/${tok1}/fields/${f.id}/complete`, { value: "true" });
      if (r.status !== 200) throw new Error(`field complete ${r.status}: ${JSON.stringify(r.body)}`);
    }
    const signed = await post(`/t/lease/${tok1}/submit`, {});
    ok("the applicant SIGNS through the real public signer door",
      signed.status === 200, `${signed.status} ${JSON.stringify(signed.body).slice(0, 200)}`);

    const avail1 = await availabilityRead(pool, { property_id: property.id });
    const rowA = avail1.rows.find((r) => String(r.space_id) === String(bed.A));
    ok("…and their home is held the moment they sign",
      rowA.marketing_state === applicationHold.HELD_STATE
        && String(rowA.application_hold.application_id) === String(appId),
      JSON.stringify({ s: rowA.marketing_state, h: rowA.application_hold }));

    const rec1 = await handoff.reconcileOwedSignatures({ application_id: appId });
    ok("…and the signature closes its own clock input",
      (rec1.results[0] || {}).outcome === "fully_signed", JSON.stringify(rec1.results[0]));
    const final1 = await handoff.readApplicationHandoffStanding(pool, appId);
    ok("…leaving one standing sentence: package sent, signed, decision still the approver's",
      final1.position === "package_sent" && final1.signature.state === "fully_signed"
        && final1.decision.state === "awaiting_decision",
      JSON.stringify({ p: final1.position, s: final1.signature.state, d: final1.decision.state }));

    // ══ JOURNEY 2 · REJECTION ═════════════════════════════════════
    const j2 = await invitedApplicant({ person: denied, spaceId: bed.B, key: "b" });
    const sub2 = await post("/applications/submit-public", {
      token: j2.token, applicant_name: `${tag} denied`,
      application_terms_acknowledged: true,
      application_terms_hash: (await get(`/t/application/${j2.token}/context`))
        .body.application_terms.terms_hash,
      captured: tenantV3Capture({ email: "b@example.test", phone: "+12025550389",
        desiredMoveIn: "2026-11-01" }) });
    ok("a second applicant submits through the same door", sub2.status === 200,
      `${sub2.status} ${JSON.stringify(sub2.body).slice(0, 200)}`);
    const app2 = sub2.body.application.id;
    await handoff.runOwedHandoffs({ application_id: app2 });
    const link2 = (sent[sent.length - 1] || {}).body || "";
    const tok2 = (link2.match(/\/t\/lease\/([A-Za-z0-9_-]+)/) || [])[1] || null;
    const pk2 = await one(
      `select id from lease_packets where application_id=$1 and superseded_at is null`, [app2]);
    for (const f of (await pool.query(
      `select id from lease_packet_fields where lease_packet_id=$1
        and signer_role='tenant' and required=true`, [pk2.id])).rows) {
      await post(`/t/lease/${tok2}/fields/${f.id}/complete`, { value: "true" });
    }
    await post(`/t/lease/${tok2}/submit`, {});
    const heldBefore = await availabilityRead(pool, { property_id: property.id });
    ok("…signs, and holds their home",
      heldBefore.rows.find((r) => String(r.space_id) === String(bed.B))
        .marketing_state === applicationHold.HELD_STATE);

    /*  THE REJECTION, through the product's own decision service. The bed
     *  must come back to the market by the SAME read that held it — not by
     *  a release step somebody has to remember.                           */
    const denyRes = await fetch(`${API}/applications/${app2}/deny`, {
      method: "POST",
      headers: { "content-type": "application/json",
                 "x-operator-key": process.env.OPERATOR_KEY || "proof-operator-key" },
      body: JSON.stringify({ reason: "declined", note: "proof: declined on screening",
        decided_by_user_id: operator.id }) });
    ok("the decision is made through the real operator door",
      denyRes.status === 200, `${denyRes.status} ${(await denyRes.text()).slice(0, 200)}`);
    const app2After = await one("select status from lease_applications where id=$1", [app2]);
    ok("a denied application is terminal", app2After.status === "declined", app2After.status);
    const afterDeny = await availabilityRead(pool, { property_id: property.id });
    ok("…and its home returns to the market by the same read that held it",
      afterDeny.rows.find((r) => String(r.space_id) === String(bed.B))
        .marketing_state === "marketable_now",
      afterDeny.rows.find((r) => String(r.space_id) === String(bed.B)).marketing_state);
    const deniedSweep = await handoff.runOwedHandoffs({ property_ids: [property.id], limit: 50 });
    ok("…and nothing further is prepared for it",
      !deniedSweep.results.some((r) => String(r.application_id) === String(app2)
        && r.outcome === "accepted"),
      JSON.stringify(deniedSweep.results.map((r) => r.outcome)));
    /*  ⚠ THE DEFECT THIS WHOLE JOURNEY FOUND. The deny route already
     *  released the conversion rail's signature rung — *"so the team is not
     *  told to chase a signature on a dead application"* — and knew nothing
     *  about the three obligations this build added. A declined applicant
     *  kept a 60-day signing clock, a completion chase and an owed package.
     *  All three are now released as `revoked` in the same transaction:
     *  nothing was supplied and no window ran out, the work was called off. */
    const leftOpen = (await pool.query(
      `select type, status, resolution_code from obligations
        where related_id=$1 and type = any($2::text[])`,
      [app2, handoff.RELEASED_ON_TERMINAL])).rows;
    ok("…and a dead application owes NOTHING — no signing clock, no chase, no package",
      leftOpen.length > 0 && leftOpen.every((o) => o.status === "complete"),
      JSON.stringify(leftOpen));
    ok("…released as `revoked`, never as satisfied or expired",
      leftOpen.filter((o) => o.resolution_code === "revoked").length > 0
        && !leftOpen.some((o) => o.resolution_code === "satisfied"),
      JSON.stringify(leftOpen.map((o) => `${o.type}:${o.resolution_code}`)));

    // ══ JOURNEY 3 · FAILED DELIVERY ═══════════════════════════════
    /*  An applicant Spine cannot reach. The package is still real and still
     *  committed; what failed is the send. That is a SYSTEM failure, not
     *  applicant inaction, and the work stays owed.                       */
    const j3 = await invitedApplicant({ person: unreachable, spaceId: bed.C, key: "c" });
    const sub3 = await post("/applications/submit-public", {
      token: j3.token, applicant_name: `${tag} unreachable`,
      application_terms_acknowledged: true,
      application_terms_hash: (await get(`/t/application/${j3.token}/context`))
        .body.application_terms.terms_hash,
      captured: tenantV3Capture({ email: "c@example.test", phone: "+12025550390",
        desiredMoveIn: "2026-11-01" }) });
    ok("a third applicant submits through the same door", sub3.status === 200,
      `${sub3.status} ${JSON.stringify(sub3.body).slice(0, 200)}`);
    const app3 = sub3.body.application.id;
    const run3 = await handoffDead.runOwedHandoffs({ application_id: app3 });
    const r3 = run3.results[0] || {};
    ok("an undeliverable package is a SYSTEM failure, named as one",
      r3.outcome === "not_accepted" && r3.failure_class === "system", JSON.stringify(r3));
    ok("…and the package itself was committed, so nothing has to be rebuilt",
      !!r3.packet_id && (await pool.query(
        "select 1 from lease_packets where application_id=$1", [app3])).rows.length === 1);
    const owed3 = await one(`select status from obligations where related_id=$1 and type=$2`,
      [app3, handoff.HANDOFF_TYPE]);
    ok("…and the work stays OWED rather than being closed as done",
      owed3.status !== "complete", JSON.stringify(owed3));
    ok("…and NO signing clock started — a link that never went out starts no deadline",
      (await pool.query(`select 1 from obligations where related_id=$1 and type=$2`,
        [app3, handoff.SIGNING_TYPE])).rows.length === 0);
    const standing3 = await handoff.readApplicationHandoffStanding(pool, app3);
    ok("…and the standing read says the package is still owed, not sent",
      standing3.position === "package_owed" && standing3.signature.state === "NOT_ESTABLISHED",
      JSON.stringify({ p: standing3.position, s: standing3.signature.state }));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
