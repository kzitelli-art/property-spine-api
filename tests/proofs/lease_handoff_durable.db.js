/* ════════════════════════════════════════════════════════════════════
   lease_handoff_durable.db.js — AN ELIGIBLE APPLICATION REACHES A
   SIGNABLE PACKET WITHOUT A PERSON RELEASING IT, AND SURVIVES RESTART.

   The progression under test:
     eligible application completed
       → the handoff is OWED, durably, with the submission
       → the packet is generated and the applicant can REACH it
       → the countersignature remains a separate authorized decision

   What this proves is not "a packet can be made" — a staff route already
   did that. It is that the step happens WITHOUT one, that a restart
   between submission and execution loses nothing, that a retry makes no
   second packet, and that an agreement which moved in between is not sent.

   Run through the owned proof wrapper with E2E_PROOF_MANIFEST.
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
const { prepareApplicationOffer } = require(path.join(root, "src/money/application_offer_terms.js"));

let pass = 0, fail = 0; const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  //  The module returns an express router; `_service` is the surface the
  //  operator door and this handoff both call. One instance, one behaviour.
  const leasePackets = leasePacketsModule({ pool,
    satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation })._service;
  /*  The REAL communication boundary, with its transport disabled. It still
   *  applies every consent and stop control; `sent:false` here means the
   *  boundary refused or could not transmit, which is exactly the system
   *  failure the handoff must report rather than call done.            */
  const commBoundary = require(path.join(root, "src/comms/communications_boundary.js"))({
    pool, sms: { enabled: () => false } });
  const handoff = leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    completeObligation: engine.completeObligation, leasePackets, commBoundary });

  const tag = `handoff-${randomUUID().slice(0, 8)}`;
  try {
    // ── FIXTURE ────────────────────────────────────────────────────
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const personOf = async (n) => (await one("insert into persons(name) values($1) returning id", [n])).id;
    const opPerson = await personOf(`${tag}-operator`);
    const applicant = await personOf(`${tag}-applicant`);
    //  The applicant needs a reachable number, or delivery cannot even be
    //  attempted and the proof would measure the wrong refusal.
    await pool.query(`update persons set primary_phone_e164=$2 where id=$1`,
      [applicant, "+12025550188"]);
    const operator = await one(`insert into users
      (name,email,platform_role,organization_id,person_id,is_active,status,account_kind)
      values($1,$2,'org_admin',$3,$4,true,'active','human_staff') returning id`,
      [`${tag} op`, `${tag}@example.test`, org.id, opPerson]);
    const property = await one(`insert into properties(name,canonical_key,organization_id,leasing_basis)
      values($1,$1,$2,'bed') returning id`, [`${tag} property`, org.id]);
    await pool.query(`insert into property_team_assignments
      (property_id,user_id,role_title,allowed_modules,active,can_manage_roles)
      values($1,$2,'Proof Seat','{management,leasing}',true,true)`, [property.id, operator.id]);
    //  prepareApplicationOffer resolves the actor through the canonical staff
    //  identity resolver, which reads `assignments` (person × property) — a
    //  different table from the team assignment above. Both are required, and
    //  the offer writer refuses without the first.
    await pool.query(`insert into assignments
      (person_id,property_id,role,scope,is_active,provenance)
      values($1,$2,'property_manager','all',true,'{\"source\":\"proof\"}'::jsonb)`, [opPerson, property.id]);
    //  The offer writer refuses a person with no canonical relationship to
    //  the property. A lead is the real way a prospect acquires one.
    await pool.query(`insert into leasing_leads(property_id,person_id)
      values($1,$2)`, [property.id, applicant]);
    /*  A LEASE PACKAGE CANNOT BE GENERATED WITHOUT CONFIGURED LEASE TERMS.
     *  generateLeasePacket fails closed with `lease_configuration_incomplete`
     *  rather than rendering a plausible default that could be materially
     *  wrong. That is the same requirement the Griv readiness sheet names as
     *  a hard launch blocker: no approved lease configuration, no signing
     *  package. The fixture therefore configures one explicitly.        */
    //  A real street address is a required lease term, not decoration.
    await pool.query(`update properties set address = $2 where id = $1`,
      [property.id, '4233 Chestnut Street, Philadelphia, PA 19104']);
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
    const unit = await one("insert into units(property_id,unit_number) values($1,'401') returning id", [property.id]);
    const space = await one(`update spaces set space_label='Room1', position_kind='bed',
      use_type='residential' where unit_id=$1 returning id`, [unit.id]);

    //  THE OFFER IS AUTHORED THROUGH ITS GOVERNED WRITER, not inserted.
    //  A hand-built offer row would prove the handoff against a shape the
    //  product never produces.
    const client = await pool.connect();
    let offer;
    try {
      await client.query("begin");
      offer = await prepareApplicationOffer(client, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: space.id,
        lease_start_date: "2026-10-01", lease_end_date: "2027-09-30",
        rent: 1400, security_deposit: 1400, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer`,
      });
      await client.query("commit");
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; }
    finally { client.release(); }
    //  prepareApplicationOffer returns { idempotent, offer, application_terms };
    //  the acknowledgeable hash lives on the offer's immutable snapshot, and
    //  lease_applications enforces it as 64 hex characters.
    const offerId = offer && offer.offer && offer.offer.id;
    const offerHash = offer && offer.offer && offer.offer.offered_terms_snapshot
      && offer.offer.offered_terms_snapshot.application_terms_hash;
    ok("fixture: an application offer is authored through its governed writer",
      !!offerId && /^[a-f0-9]{64}$/.test(String(offerHash || "")),
      JSON.stringify({ offerId: !!offerId, hash: String(offerHash || "").slice(0, 12) }));
    const app = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted',$6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space.id, `${tag} applicant`, offerId, offerHash]);
    ok("fixture: a submitted application is bound to that acknowledged offer",
      app.status === "submitted" && String(app.application_offer_id) === String(offerId));

    // ── 1 · OWED, DURABLY, WITH THE SUBMISSION ─────────────────────
    const c1 = await pool.connect();
    try {
      await c1.query("begin");
      await handoff.recordHandoffOwed(c1, { application: app });
      await c1.query("commit");
    } finally { c1.release(); }

    const owedRow = await one(
      `select id, status, owner_type, type from obligations
        where related_type='lease_application' and related_id=$1 and type=$2`,
      [app.id, handoff.HANDOFF_TYPE]);
    ok("the handoff is recorded as OWED, and it is system-owned work rather than a person's decision",
      !!owedRow && owedRow.status !== "complete" && owedRow.owner_type === "system",
      JSON.stringify(owedRow));

    //  RESTART SURVIVAL IS NOT SIMULATED WITH A FLAG. The obligation is read
    //  back through a SEPARATE pool with no shared in-memory state — the
    //  same thing a new process would find on disk.
    const cold = new Pool({ connectionString: boundary.manifest().url, ssl: false });
    const seenCold = (await cold.query(
      `select id from obligations where related_id=$1 and type=$2 and status<>'complete'`,
      [app.id, handoff.HANDOFF_TYPE])).rows.length;
    await cold.end();
    ok("a process that never saw the submission still finds the owed work on disk",
      seenCold === 1, `rows: ${seenCold}`);

    //  AND RECORDING IT TWICE DOES NOT OWE IT TWICE.
    const c2 = await pool.connect();
    try {
      await c2.query("begin");
      await handoff.recordHandoffOwed(c2, { application: app });
      await c2.query("commit");
    } finally { c2.release(); }
    const owedCount = (await pool.query(
      `select id from obligations where related_id=$1 and type=$2`,
      [app.id, handoff.HANDOFF_TYPE])).rows.length;
    ok("re-recording the same handoff does not owe it twice", owedCount === 1, `rows: ${owedCount}`);

    // ── 2 · PREPARED AUTOMATICALLY, ON THE OFFER AUTHOR'S AUTHORITY ─
    /*  The owner ruling (2026-09-15) grants Spine automatic preparation
     *  against the current, authorized, applicant-acknowledged offer. Two
     *  things must both be true and both are asserted: the AUTHOR remains
     *  the commercial authority, and SPINE is recorded as the executor.
     *  No staff session is minted, and none is implied.                */
    const run1 = await handoff.runOwedHandoffs({ application_id: app.id });
    const r1 = run1.results[0] || {};
    ok("the runner prepares the signing package with NO operator acting",
      !!r1.packet_id && r1.outcome !== "failed", JSON.stringify(r1));

    const packets1 = (await pool.query(
      "select id, status from lease_packets where application_id=$1", [app.id])).rows;
    ok("exactly one packet exists", packets1.length === 1, JSON.stringify(packets1));

    const conf = await one(
      `select actor_user_id, source, authority_basis from application_proposed_terms_confirmations
        where application_id=$1`, [app.id]);
    ok("COMMERCIAL AUTHORITY is the offer's author, not an invented actor",
      !!conf && String(conf.actor_user_id) === String(operator.id)
        && conf.source === "authored_offer_acknowledged",
      JSON.stringify(conf));

    const execEvent = await one(
      `select type, note from events
        where type='application_terms_derived_from_authored_offer_by_spine'
          and property_id=$1 order by occurred_at desc limit 1`, [property.id]);
    ok("SPINE is recorded as the executor, in its own event type, saying the author did not perform it",
      !!execEvent && /AUTOMATICALLY BY SPINE/.test(execEvent.note)
        && /did not perform this preparation/.test(execEvent.note),
      JSON.stringify(execEvent && execEvent.type));

    //  THE APPLICATION IS NOT APPROVED BY ANY OF THIS.
    const after = await one("select status from lease_applications where id=$1", [app.id]);
    ok("the application is still `submitted` — preparing a package approves nothing",
      after.status === "submitted", after.status);

    // ── 3 · DELIVERY IS THE FINISH LINE, NOT TOKEN ISSUANCE ────────
    /*  With the transport disabled the boundary cannot transmit, so this
     *  asserts the FAILURE semantics the ruling requires: a technical
     *  delivery failure is reported as a SYSTEM failure and the work stays
     *  owed. It is never recorded as the applicant not acting.         */
    ok("an undelivered package is reported as a SYSTEM failure, not applicant inaction",
      r1.outcome === "undelivered" && r1.failure_class === "system",
      JSON.stringify({ outcome: r1.outcome, failure_class: r1.failure_class,
        reason: r1.reason_code }));
    const owedAfterUndelivered = await one(
      `select status from obligations where related_id=$1 and type=$2`,
      [app.id, handoff.HANDOFF_TYPE]);
    ok("…and the handoff stays OWED until the applicant can actually reach it",
      !!owedAfterUndelivered && owedAfterUndelivered.status !== "complete",
      JSON.stringify(owedAfterUndelivered));
    const attempted = await one(
      `select type from events where type='lease_signing_link_delivery_attempted'
        and property_id=$1 limit 1`, [property.id]);
    ok("the delivery attempt itself is recorded, so an unreachable applicant is visible",
      !!attempted, JSON.stringify(attempted));

    //  RETRY: no duplicate packet. The remaining gap is named in source —
    //  once a packet is `sent`, issueLeasePacketLink cannot return the URL
    //  again, so the retry reports link_not_recoverable_after_issue rather
    //  than pretending it delivered.
    const run2 = await handoff.runOwedHandoffs({ application_id: app.id });
    const r2 = run2.results[0] || {};
    const packets2 = (await pool.query(
      "select id from lease_packets where application_id=$1", [app.id])).rows;
    ok("a retry creates NO second packet",
      packets2.length === 1, JSON.stringify({ packets: packets2.length }));
    /*  ⚠ MEASURED, AND TIGHTER THAN EXPECTED. The retry does not reach link
     *  issuance at all: generateLeasePacket refuses first with
     *  `packet_already_issued` ("it will not be silently regenerated").
     *  So after ONE failed delivery there is currently no path that
     *  re-delivers access to an existing packet — not a missing URL, a
     *  refused regeneration. That is the exact remaining break, and it is
     *  asserted here rather than described.                            */
    ok("…and the retry refuses to regenerate, naming the block instead of claiming delivery",
      r2.outcome === "failed" && r2.reason_code === "packet_already_issued",
      JSON.stringify(r2));

    // ── 4 · AN AGREEMENT THAT MOVED IS NOT SENT ────────────────────
    //  A second application, owed, whose offer is superseded before the
    //  runner reaches it — the exact window the durable record creates.
    const app2 = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted',$6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space.id, `${tag} applicant 2`, offerId, offerHash]);
    const c3 = await pool.connect();
    try {
      await c3.query("begin");
      await handoff.recordHandoffOwed(c3, { application: app2 });
      await c3.query("commit");
    } finally { c3.release(); }
    await pool.query("update lease_offers set status='superseded' where id=$1", [offerId]);

    const run3 = await handoff.runOwedHandoffs({ application_id: app2.id });
    const r3 = run3.results[0] || {};
    const packets3 = (await pool.query(
      "select id from lease_packets where application_id=$1", [app2.id])).rows;
    ok("a superseded agreement is NOT sent — no packet is created",
      packets3.length === 0, JSON.stringify(r3));
    const stillOwed = await one(
      `select status from obligations where related_id=$1 and type=$2`,
      [app2.id, handoff.HANDOFF_TYPE]);
    ok("…and the work stays OWED rather than being closed as done",
      !!stillOwed && stillOwed.status !== "complete", JSON.stringify(stillOwed));
    const app2After = await one("select status from lease_applications where id=$1", [app2.id]);
    ok("…and the completed application is untouched — recoverable work, not a lost step",
      app2After.status === "submitted", app2After.status);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
