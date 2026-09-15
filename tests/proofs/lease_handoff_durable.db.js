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
    completeObligation: engine.completeObligation, leasePackets,
    commBoundary: boundaryWith(capturingSms) });
  const handoffDisabled = leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
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
    ok("the package is DELIVERED, not merely prepared",
      r1.outcome === "delivered", JSON.stringify(r1));
    ok("every required signer was reached — a partial send is not a success",
      Array.isArray(r1.per_signer) && r1.per_signer.length > 0
        && r1.per_signer.every((x) => x.delivered), JSON.stringify(r1.per_signer));

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
    ok("the applicant can OPEN the delivered link through the real signer route",
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
      rN.outcome === "undelivered" && rN.failure_class === "system", JSON.stringify(rN));
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
    ok("an undelivered package RESUMES and is delivered on the next run",
      rR.outcome === "delivered", JSON.stringify(rR));
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
    ok("…and the delivered link opens the CURRENT version through the real signer route",
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
    const sweep = handoff.startHandoffRecovery({ enabled: true, intervalMs: 3600000,
      log: { log() {}, error() {} } });
    ok("…and when enabled it starts", sweep.started === true);
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

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
