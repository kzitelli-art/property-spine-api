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
  /*  ── TWO TRANSPORTS, TWO DIFFERENT CLAIMS ──────────────────────────
   *  CAPTURING is the approved test transport for the POSITIVE acceptance
   *  test: it records the actual recipient, the actual body (which carries
   *  the link) and the outcome, so "delivered" is a measurement rather than
   *  a return value nobody checked. Every consent, line and stop control in
   *  the real boundary still runs in front of it.
   *
   *  DISABLED keeps its place as NEGATIVE coverage — it proves the handoff
   *  reports an unreachable applicant as a system failure. It is not, and
   *  was never, evidence that delivery works.                          */
  const runId = randomUUID().slice(0, 8);
  const captured = [];
  const capturingSms = {
    enabled: () => true,
    sendSms: async ({ to, from, body }) => {
      captured.push({ to, from, body, at: new Date().toISOString() });
      //  comm_events.sms_sid is UNIQUE-INDEXED (it is the inbound idempotency
      //  key). A fixed sid collides with earlier runs on a shared database,
      //  the boundary's insert is caught and logged, and the receipt silently
      //  reads null — which looked like a product defect and was not.
      return { sent: true, sid: `PROOF-${runId}-${captured.length}`, status: "queued" };
    },
  };
  const boundaryWith = (sms) =>
    require(path.join(root, "src/comms/communications_boundary.js"))({ pool, sms });
  const handoff = leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    satisfyObligation: engine.satisfyObligation,
    completeObligation: engine.completeObligation, leasePackets,
    commBoundary: boundaryWith(capturingSms) });
  const handoffDisabled = leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    satisfyObligation: engine.satisfyObligation,
    completeObligation: engine.completeObligation, leasePackets,
    commBoundary: boundaryWith({ enabled: () => false }) });

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
    //  A property-facing outbound line and recorded text consent. Both are
    //  real gates in the boundary: without either, a send refuses before the
    //  transport is reached — which is the correct behaviour, and would make
    //  a "delivered" claim meaningless.
    await pool.query(`insert into communication_lines
        (e164, line_type, property_id, authority_ceiling, permitted_audience,
         inbound_enabled, outbound_enabled, outbound_policy, status)
       values ($1,'property_facing',$2,'external','residents_and_prospects',
               true,true,'proactive','active')`,
      [`+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`, property.id]);
    await pool.query(`insert into contact_preferences (person_id, channel, consent_state)
       values ($1,'text','opted_in')`, [applicant]);
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

    // ── 3 · DELIVERED, AND THE LINK ACTUALLY OPENS ─────────────────
    /*  THE POSITIVE ACCEPTANCE TEST. Measured through the approved
     *  capturing transport, behind the real line, consent and stop gates.  */
    /*  ⚠ ACCEPTED, NOT DELIVERED, and the proof says so. The fake transport
     *  returns Twilio's shape — sent:true with a sid and status "queued".
     *  That is the WIRE TAKING the message, not a handset receiving it, and
     *  the receipt must not upgrade it. Carrier delivery lands later on
     *  comm_events.provider_status through recordProviderStatus.        */
    ok("the package is ACCEPTED BY THE TRANSPORT, not merely prepared",
      r1.outcome === "accepted", JSON.stringify(r1));
    ok("…and the receipt does not claim delivery it has not observed",
      !JSON.stringify(r1).includes("\"delivered\""), JSON.stringify(r1));
    ok("every required signer was reached — a partial send is not a success",
      Array.isArray(r1.per_signer) && r1.per_signer.length > 0
        && r1.per_signer.every((x) => x.accepted && x.transport_state === "accepted"),
      JSON.stringify(r1.per_signer));

    const msg = captured[captured.length - 1];
    ok("the transport captured a real recipient and a real body",
      !!msg && /^\+1\d{10}$/.test(String(msg.to)) && /Your lease is ready to sign/.test(msg.body),
      JSON.stringify(msg && { to: msg.to, body: String(msg.body).slice(0, 40) }));

    /*  ⚠ THE RECEIPT HAS TO LAND ON THE COMMUNICATION RECORD, not just be
     *  returned. An earlier version passed an `events` id where the
     *  boundary updates `comm_events`, so every receipt wrote zero rows.  */
    const commRow = await one(
      `select id, person_id, channel, direction, sms_sid, sms_status, body
         from comm_events where id = $1`, [r1.per_signer[0].comm_event_id]);
    ok("the delivery receipt landed on the correct comm_events row, with the sid and status",
      !!commRow && commRow.channel === "sms" && commRow.direction === "outbound"
        && !!commRow.sms_sid && !!commRow.sms_status,
      JSON.stringify(commRow && { sid: commRow.sms_sid, status: commRow.sms_status }));
    ok("…and it is bound to the SIGNER'S OWN person, so the relationship is right",
      !!commRow && String(commRow.person_id) === String(applicant),
      JSON.stringify({ on_record: commRow && commRow.person_id, applicant }));

    /*  ⚠ BEARER MATERIAL STAYS IN THE MESSAGE RECORD. An earlier version
     *  copied the signing URL into a general `events` note, which is read
     *  across the product.                                               */
    const leaked = await one(
      `select count(*)::int as n from events where note like '%/t/lease/%'`);
    ok("no signing URL leaked into general activity history",
      leaked && leaked.n === 0, JSON.stringify(leaked));

    //  ── AND NOW OPEN IT, THE WAY THE APPLICANT WOULD ────────────────
    const token = String(msg.body).split("/t/lease/")[1];
    const reached = token ? await leasePackets.resolveSignerAccess(pool, token) : null;
    ok("the applicant can OPEN the dispatched link through the real signer route",
      !!(reached && (reached.packet || reached.signer)),
      JSON.stringify(reached ? Object.keys(reached) : null));
    ok("…and it opens THEIR packet — the one this handoff prepared",
      !!reached && String((reached.packet && reached.packet.id) || reached.packet_id || "")
        === String(packets1[0].id),
      JSON.stringify({ opened: (reached && reached.packet && reached.packet.id) || null,
        prepared: packets1[0].id }));

    //  ── RETRY: NO SECOND PACKET, NO SECOND MESSAGE ──────────────────
    const sentBefore = captured.length;
    const run2 = await handoff.runOwedHandoffs({ application_id: app.id });
    const packets2 = (await pool.query(
      "select id from lease_packets where application_id=$1", [app.id])).rows;
    ok("a retry creates NO second packet", packets2.length === 1,
      JSON.stringify({ packets: packets2.length }));
    ok("…and sends no second message — the obligation is complete, so nothing is owed",
      captured.length === sentBefore && run2.considered === 0,
      JSON.stringify({ before: sentBefore, after: captured.length, considered: run2.considered }));

    // ── 3b · NEGATIVE COVERAGE: AN UNREACHABLE APPLICANT ───────────
    /*  Same code path, transport disabled. This is what the earlier 18/18
     *  actually proved, and it is kept — as negative coverage, not as
     *  evidence of delivery.                                            */
    const appN = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted',$6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space.id, `${tag} unreachable`, offerId, offerHash]);
    const cN = await pool.connect();
    try { await cN.query("begin");
      await handoffDisabled.recordHandoffOwed(cN, { application: appN });
      await cN.query("commit"); } finally { cN.release(); }
    const runN = await handoffDisabled.runOwedHandoffs({ application_id: appN.id });
    const rN = runN.results[0] || {};
    ok("an unreachable applicant is a SYSTEM failure and the work stays owed",
      rN.outcome === "not_accepted" && rN.failure_class === "system", JSON.stringify(rN));
    const owedN = await one(`select status from obligations where related_id=$1 and type=$2`,
      [appN.id, handoff.HANDOFF_TYPE]);
    ok("…and it is not closed as done", !!owedN && owedN.status !== "complete", JSON.stringify(owedN));
    const packetN1 = await one(
      `select id, status from lease_packets where application_id=$1`, [appN.id]);
    ok("…and the package itself was still committed, so nothing has to be rebuilt",
      !!packetN1 && ["sent", "tenant_in_progress"].includes(packetN1.status),
      JSON.stringify(packetN1));

    // ── 3c · RECOVERY: THE SAME PACKAGE, REACHED ON THE NEXT RUN ────
    /*  The previous attempt left an issued packet nobody could reach. This
     *  is the case that used to stop permanently at packet_already_issued.
     *  It must now RESUME — same packet, same version, same signers, new
     *  tokens — and never regenerate a different agreement to get a link.  */
    const capturedBefore = captured.length;
    const runR = await handoff.runOwedHandoffs({ application_id: appN.id });
    const rR = runR.results[0] || {};
    ok("an undispatched package RESUMES and is accepted on the next run",
      rR.outcome === "accepted", JSON.stringify(rR));
    const packetsN = (await pool.query(
      "select id from lease_packets where application_id=$1", [appN.id])).rows;
    /*  ⚠ RECOVERY IS A NEW VERSION, AND THAT IS THE SCHEMA'S CHOICE.
     *  Migration 192 freezes signer token authority once a packet leaves
     *  draft, so the undelivered link cannot be re-minted. The prior version
     *  is PRESERVED and superseded, not deleted, and its access must stop
     *  working the moment it is.                                        */
    const priorAfter = await one(
      `select superseded_at from lease_packets where id=$1`, [packetN1.id]);
    ok("…the prior version is preserved and marked superseded, not deleted",
      !!priorAfter && priorAfter.superseded_at !== null, JSON.stringify(priorAfter));
    ok("…and the agreement is the same application's, at a new version",
      packetsN.length === 2, JSON.stringify({ versions: packetsN.length }));
    ok("…and exactly one message went out for it",
      captured.length === capturedBefore + 1,
      JSON.stringify({ before: capturedBefore, after: captured.length }));
    const tokenR = String(captured[captured.length - 1].body).split("/t/lease/")[1];
    const reachedR = tokenR ? await leasePackets.resolveSignerAccess(pool, tokenR) : null;
    ok("…and the dispatched link opens the CURRENT version through the real signer route",
      !!reachedR && String((reachedR.packet && reachedR.packet.id) || "") !== String(packetN1.id),
      JSON.stringify({ opened: reachedR && reachedR.packet && reachedR.packet.id, superseded: packetN1.id }));

    // ── 3d · RECOVERY RUNS WITHOUT ANYONE CALLING THE RUNNER ────────
    /*  The after-commit call accelerates the first attempt; it cannot be the
     *  only path. This asserts the sweep itself picks owed work off the
     *  database — which is what makes a restart survivable rather than
     *  merely recorded.                                                  */
    const appS = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted',$6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space.id, `${tag} swept`, offerId, offerHash]);
    const cS = await pool.connect();
    try { await cS.query("begin");
      await handoff.recordHandoffOwed(cS, { application: appS });
      await cS.query("commit"); } finally { cS.release(); }
    ok("the sweep refuses to start unless explicitly enabled",
      handoff.startHandoffRecovery({ enabled: false }).started === false);
    /*  ⚠ ENABLED IS NOT ENOUGH. An unattended sweep with no property scope
     *  reaches every property Spine holds, and what it does at the end is
     *  text a real person a bearer link to a governing agreement. Enabling
     *  it without naming properties is refused rather than read as "all".  */
    const unscoped = handoff.startHandoffRecovery({ enabled: true, intervalMs: 3600000,
      log: { log() {}, error() {} } });
    ok("…and enabled with NO property scope still refuses, rather than sweeping everything",
      unscoped.started === false && unscoped.reason === "no_property_scope",
      JSON.stringify(unscoped));
    const sweep = handoff.startHandoffRecovery({ enabled: true, intervalMs: 3600000,
      propertyIds: [property.id], log: { log() {}, error() {} } });
    ok("…and it starts once the properties it may touch are named",
      sweep.started === true && sweep.property_ids.length === 1, JSON.stringify(sweep.property_ids));
    await new Promise((r) => setTimeout(r, 2500));
    if (sweep.stop) sweep.stop();
    const sweptObl = await one(`select status from obligations where related_id=$1 and type=$2`,
      [appS.id, handoff.HANDOFF_TYPE]);
    ok("owed work is discharged by the sweep alone — no applicant request, no manual runner call",
      !!sweptObl && sweptObl.status === "complete", JSON.stringify(sweptObl));

    // ── 4 · AN AGREEMENT THAT MOVED IS NOT SENT ────────────────────
    //  A second application, owed, whose offer is superseded before the
    //  runner reaches it — the exact window the durable record creates.
    /*  ⚠ ITS OWN OFFER, ON ITS OWN SPACE. An earlier version superseded the
     *  single offer every application in this run shared, which retroactively
     *  made the delivered applications' offers unreadable and broke a sibling
     *  read-only proof on the same database. A fixture that reaches back into
     *  another case's facts is measuring the wrong thing.               */
    const space2 = await one(`insert into spaces (unit_id, space_label, position_kind, use_type)
      values($1,'Room2','bed','residential') returning id`, [unit.id]);
    const c2o = await pool.connect();
    let offer2;
    try {
      await c2o.query("begin");
      offer2 = await prepareApplicationOffer(c2o, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: space2.id,
        lease_start_date: "2026-11-01", lease_end_date: "2027-10-31",
        rent: 1500, security_deposit: 1500, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer-2`,
      });
      await c2o.query("commit");
    } catch (e) { await c2o.query("rollback").catch(() => {}); throw e; }
    finally { c2o.release(); }
    const offer2Id = offer2.offer.id;
    const offer2Hash = offer2.offer.offered_terms_snapshot.application_terms_hash;
    const app2 = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted',$6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space2.id, `${tag} applicant 2`, offer2Id, offer2Hash]);
    const c3 = await pool.connect();
    try {
      await c3.query("begin");
      await handoff.recordHandoffOwed(c3, { application: app2 });
      await c3.query("commit");
    } finally { c3.release(); }
    await pool.query("update lease_offers set status='superseded' where id=$1", [offer2Id]);

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

    /*  ══════════════════════════════════════════════════════════════
     *   5 · SUBMITTING IS NOT COMPLETING
     *  ══════════════════════════════════════════════════════════════
     *  The boundary this whole module exists behind. An application that
     *  arrives missing something owes APPLICANT FOLLOW-UP, and an unattended
     *  sweep must not turn it into a delivered lease because nobody is
     *  watching. Proven by making an application genuinely incomplete — a
     *  guarantor named with no contact — and then running the sweep at it.  */
    const space5 = await one(`insert into spaces (unit_id, space_label, position_kind, use_type)
      values($1,'Room5','bed','residential') returning id`, [unit.id]);
    const c5o = await pool.connect();
    let offer5;
    try {
      await c5o.query("begin");
      offer5 = await prepareApplicationOffer(c5o, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: space5.id,
        lease_start_date: "2026-12-01", lease_end_date: "2027-11-30",
        rent: 1500, security_deposit: 1500, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer-5`,
      });
      await c5o.query("commit");
    } catch (e) { await c5o.query("rollback").catch(() => {}); throw e; }
    finally { c5o.release(); }

    //  A guarantor is NAMED and their contact is absent. This is exactly the
    //  application lease_packets refuses with `guarantor_contact_not_established`
    //  — observed at submission instead of at 3am inside a sweep.
    const app5 = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, guarantor_name, status,
       submitted_at, application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,$6,'submitted', now(), $7, now(), $8) returning *`,
      [property.id, applicant, unit.id, space5.id, `${tag} incomplete`,
       `${tag} guarantor`, offer5.offer.id,
       offer5.offer.offered_terms_snapshot.application_terms_hash]);

    const c5 = await pool.connect();
    let owed5;
    try { await c5.query("begin");
      owed5 = await handoff.recordCompletionOwed(c5, { application: app5 });
      await c5.query("commit"); } finally { c5.release(); }

    ok("an incomplete application owes APPLICANT WORK, and names what is missing",
      owed5.complete === false
        && owed5.required_inputs.includes(handoff.COMPLETION_INPUTS.GUARANTOR_CONTACT),
      JSON.stringify(owed5.required_inputs));
    ok("…and NO lease handoff is owed — submitting is not completing",
      owed5.handoff === null
        && (await pool.query(`select 1 from obligations where related_id=$1 and type=$2`,
             [app5.id, handoff.HANDOFF_TYPE])).rows.length === 0);

    /*  THE OWED WORK IS A PERSON'S, AND IT CARRIES THE 30-DAY CLOCK.
     *  Spine cannot supply a guarantor's mobile number, so this is not
     *  system work, and the clock lives on the obligation's own due_at
     *  where the board escalates it like anything else.                  */
    const ob5 = await one(`select owner_type, assigned_role, due_at, required_inputs
                             from obligations where related_id=$1 and type=$2`,
      [app5.id, handoff.COMPLETION_TYPE]);
    ok("…owed by a PERSON, not by Spine — Spine cannot supply a missing contact",
      ob5.owner_type === "human" && !!ob5.assigned_role, JSON.stringify(ob5));
    const days5 = Math.round(
      (new Date(ob5.due_at) - new Date(app5.submitted_at)) / (24 * 3600 * 1000));
    ok(`…and the completion clock is ${handoff.COMPLETION_WINDOW_DAYS} days from submission`,
      days5 === handoff.COMPLETION_WINDOW_DAYS, `${days5} days`);

    /*  ⚠ THE CENTRAL ASSERTION. Nobody is watching; the sweep runs.       */
    const sweep5 = await handoff.runOwedHandoffs({ application_id: app5.id });
    ok("an unattended sweep prepares NOTHING for an incomplete application",
      sweep5.considered === 0
        && (await pool.query("select 1 from lease_packets where application_id=$1",
             [app5.id])).rows.length === 0, JSON.stringify(sweep5));

    /*  AND THE GUARD HOLDS EVEN IF THE WRITER IS BYPASSED. A handoff owed
     *  directly beside an open completion obligation is deferred by name,
     *  not silently executed — the boundary is not one edit from being gone. */
    const c5b = await pool.connect();
    try { await c5b.query("begin");
      await handoff.recordHandoffOwed(c5b, { application: app5 });
      await c5b.query("commit"); } finally { c5b.release(); }
    const forced5 = await handoff.runOwedHandoffs({ application_id: app5.id });
    ok("…and a handoff owed by any other route is DEFERRED while completion is open",
      (forced5.results[0] || {}).reason_code === "application_completion_outstanding",
      JSON.stringify(forced5.results[0]));
    ok("…still with no packet, and the deferral names what is outstanding",
      (await pool.query("select 1 from lease_packets where application_id=$1",
        [app5.id])).rows.length === 0
      && ((forced5.results[0] || {}).outstanding || []).includes(
           handoff.COMPLETION_INPUTS.GUARANTOR_CONTACT),
      JSON.stringify(forced5.results[0]));

    /*  THE FACT CLOSES THE INPUT — NOT A BUTTON.
     *  Reconcile with the guarantor contact still missing: nothing moves.
     *  There is deliberately no way to assert completeness over a fact that
     *  is not there.                                                      */
    const c5c = await pool.connect();
    let noop5;
    try { await c5c.query("begin");
      noop5 = await handoff.reconcileApplicationCompletion(c5c, { application_id: app5.id });
      await c5c.query("commit"); } finally { c5c.release(); }
    ok("re-observation cannot satisfy an input the facts still find missing",
      noop5.reconciled === false && noop5.reason === "nothing_resolved",
      JSON.stringify(noop5));

    //  Now the guarantor's contact genuinely arrives, through the application
    //  record the packet writer reads. Nothing tells this module about it.
    await pool.query(
      `update lease_applications set captured = $2::jsonb where id=$1`,
      [app5.id, JSON.stringify({
        guarantor_contact: { name: `${tag} guarantor`, phone: "+12025550199",
          email: "guarantor@example.test" } })]);

    const c5d = await pool.connect();
    let fixed5;
    try { await c5d.query("begin");
      fixed5 = await handoff.reconcileApplicationCompletion(c5d, { application_id: app5.id });
      await c5d.query("commit"); } finally { c5d.release(); }
    ok("the FACT arriving closes the input, through the engine's own satisfyObligation",
      fixed5.reconciled === true && fixed5.complete === true
        && fixed5.satisfied.includes(handoff.COMPLETION_INPUTS.GUARANTOR_CONTACT),
      JSON.stringify(fixed5));
    const satEvt = (await pool.query(
      `select 1 from events where property_id=$1 and type=$2`,
      [property.id, `input_satisfied:${handoff.COMPLETION_INPUTS.GUARANTOR_CONTACT}`])).rows;
    ok("…leaving the engine's own durable proof that it was satisfied",
      satEvt.length > 0);
    ok("…and only NOW is the lease handoff owed",
      !!fixed5.handoff && fixed5.handoff.owed === true, JSON.stringify(fixed5.handoff));

    const standing5 = await handoff.readApplicationHandoffStanding(null, app5.id);
    ok("the standing read says the package is owed, with nothing outstanding",
      standing5.position === "package_owed" && standing5.outstanding.length === 0,
      JSON.stringify(standing5));

    /*  ── 5b · THE 30-DAY CLOCK HAS TEETH ──────────────────────────
     *  An application nobody completed does not sit open pretending an
     *  applicant is still coming. It lapses through the lifecycle authority
     *  — the only writer of lease_applications.status — and the obligation
     *  closes as `expired`, never as satisfied.                           */
    const space6 = await one(`insert into spaces (unit_id, space_label, position_kind, use_type)
      values($1,'Room6','bed','residential') returning id`, [unit.id]);
    const stale = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, guarantor_name,
       status, submitted_at)
      values($1,$2,$3,$4,$5,$6,'submitted', now() - interval '40 days') returning *`,
      [property.id, applicant, unit.id, space6.id, `${tag} lapsed`, `${tag} g2`]);
    const c6 = await pool.connect();
    try { await c6.query("begin");
      await handoff.recordCompletionOwed(c6, { application: stale });
      await c6.query("commit"); } finally { c6.release(); }

    const early = await handoff.expireStaleCompletions({
      application_id: stale.id, now: new Date(Date.now() - 20 * 24 * 3600 * 1000) });
    ok("the clock does not fire early — 20 days in, the application is still open",
      early.considered === 0, JSON.stringify(early));

    const lapsed = await handoff.expireStaleCompletions({ application_id: stale.id });
    ok("past the window the application lapses, through the lifecycle authority",
      (lapsed.results[0] || {}).outcome === "expired", JSON.stringify(lapsed.results[0]));
    const staleAfter = await one(
      `select status, terminal_code, decision_reason from lease_applications where id=$1`,
      [stale.id]);
    ok("…recorded as `expired` by the one writer of application status",
      staleAfter.status === "expired" && staleAfter.terminal_code === "expired",
      JSON.stringify(staleAfter));
    const staleObl = await one(
      `select status, resolution_code, required_inputs from obligations
        where related_id=$1 and type=$2`, [stale.id, handoff.COMPLETION_TYPE]);
    ok("…and the obligation closes as EXPIRED, never as satisfied — nothing was supplied",
      staleObl.status === "complete" && staleObl.resolution_code === "expired"
        && (staleObl.required_inputs || []).length > 0,
      JSON.stringify(staleObl));
    ok("…and no signing package was prepared for an application that lapsed",
      (await pool.query("select 1 from lease_packets where application_id=$1",
        [stale.id])).rows.length === 0);

    /*  ── 5c · A COMPLETE APPLICATION IS COMPLETE AT SUBMISSION ─────
     *  The two-step leasing design (migration 195), unchanged: an applicant
     *  who acknowledged an authored offer and left nothing outstanding has
     *  COMPLETED, and the handoff is owed in the same transaction. The
     *  boundary is a boundary, not a brake.                              */
    const space7 = await one(`insert into spaces (unit_id, space_label, position_kind, use_type)
      values($1,'Room7','bed','residential') returning id`, [unit.id]);
    const c7o = await pool.connect();
    let offer7;
    try { await c7o.query("begin");
      offer7 = await prepareApplicationOffer(c7o, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: space7.id,
        lease_start_date: "2027-01-01", lease_end_date: "2027-12-31",
        rent: 1500, security_deposit: 1500, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer-7`,
      });
      await c7o.query("commit");
    } catch (e) { await c7o.query("rollback").catch(() => {}); throw e; }
    finally { c7o.release(); }
    const app7 = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status, submitted_at,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted', now(), $6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space7.id, `${tag} complete`, offer7.offer.id,
       offer7.offer.offered_terms_snapshot.application_terms_hash]);
    const c7 = await pool.connect();
    let owed7;
    try { await c7.query("begin");
      owed7 = await handoff.recordCompletionOwed(c7, { application: app7 });
      await c7.query("commit"); } finally { c7.release(); }
    ok("an application with nothing outstanding is COMPLETE at submission…",
      owed7.complete === true && owed7.required_inputs.length === 0,
      JSON.stringify(owed7.required_inputs));
    ok("…and owes the handoff in the SAME transaction — the boundary is not a brake",
      !!owed7.handoff && owed7.handoff.owed === true, JSON.stringify(owed7.handoff));
    const run7 = await handoff.runOwedHandoffs({ application_id: app7.id });
    ok("…which the runner then discharges with no person acting",
      (run7.results[0] || {}).outcome === "accepted", JSON.stringify(run7.results[0]));

    /*  ── 5d · A SWEEP DOES NOT REACH HISTORY ──────────────────────
     *  An imported application records something that ALREADY HAPPENED
     *  somewhere else. Spine did not run it and does not now finish it —
     *  least of all by texting its applicant a bearer link years later.   */
    const space8 = await one(`insert into spaces (unit_id, space_label, position_kind, use_type)
      values($1,'Room8','bed','residential') returning id`, [unit.id]);
    /*  ⚠ FULLY SENDABLE ON PURPOSE. Given a real acknowledged offer, this
     *  application would be prepared and texted if the exclusion were the
     *  only thing stopping it — so the assertion measures the exclusion and
     *  not some other refusal the fixture happened to trip.              */
    const c8o = await pool.connect();
    let offer8;
    try { await c8o.query("begin");
      offer8 = await prepareApplicationOffer(c8o, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: space8.id,
        lease_start_date: "2027-02-01", lease_end_date: "2028-01-31",
        rent: 1500, security_deposit: 1500, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer-8`,
      });
      await c8o.query("commit");
    } catch (e) { await c8o.query("rollback").catch(() => {}); throw e; }
    finally { c8o.release(); }
    const imported = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status, submitted_at, source,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted', now() - interval '400 days', 'import', $6, now(), $7) returning *`,
      [property.id, applicant, unit.id, space8.id, `${tag} historical`, offer8.offer.id,
       offer8.offer.offered_terms_snapshot.application_terms_hash]);
    const c8 = await pool.connect();
    try { await c8.query("begin");
      await handoff.recordHandoffOwed(c8, { application: imported });
      await c8.query("commit"); } finally { c8.release(); }
    const sweptAll = await handoff.runOwedHandoffs({ property_ids: [property.id], limit: 50 });
    ok("a scoped sweep passes over an IMPORTED application entirely",
      !sweptAll.results.some((r) => r.application_id === imported.id)
        && (await pool.query("select 1 from lease_packets where application_id=$1",
             [imported.id])).rows.length === 0,
      JSON.stringify(sweptAll.results.map((r) => r.outcome)));
    const importedObl = await one(
      `select status from obligations where related_id=$1 and type=$2`,
      [imported.id, handoff.HANDOFF_TYPE]);
    ok("…and leaves it owed and untouched rather than closing it as done",
      importedObl.status !== "complete", JSON.stringify(importedObl));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
