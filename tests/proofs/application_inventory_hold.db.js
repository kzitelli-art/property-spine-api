/* ════════════════════════════════════════════════════════════════════
   application_inventory_hold.db.js — A HOME AN APPLICANT HAS SIGNED FOR
   STOPS BEING OFFERED, EVERYWHERE, THE MOMENT THEY SIGN.

   Before this, an applicant could sign the package Spine prepared and
   nothing in the system changed: the bed still read `marketable_now`,
   the matcher still offered it, and a second application could still be
   aimed at it. Two people could sign for one bed.

   THE SIGNATURE HERE IS REAL. It goes through the public signer routes —
   POST /t/lease/:token/fields/:id/complete then POST /t/lease/:token/submit
   — with the token the handoff actually minted. Nothing stamps
   tenant_submitted_at by hand, because a proof that writes the fact it is
   testing proves the proof.

   Requires the API on E2E_API_BASE against the SAME database.
   Run through the owned proof wrapper with E2E_PROOF_MANIFEST.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const boundary = require("../e2e/proof_boundary.js");
require("../e2e/proof_fence_preload.js");
const { Pool } = require("pg");

//  The proof owns its send mode — see the note in lease_handoff_durable.db.js.
//  Unset, SMS_SEND_MODE defaults to `disabled` and every send refuses before
//  the transport, so this would pass or fail on the caller's shell.
process.env.SMS_SEND_MODE = "customer_care";

const root = path.resolve(__dirname, "..", "..");
const engine = require(path.join(root, "src/shared/obligation_engine.js"));
const leasePacketsModule = require(path.join(root, "src/applications/lease_packets.js"));
const leaseHandoffModule = require(path.join(root, "src/applications/lease_handoff.js"));
const applicationTarget = require(path.join(root, "src/applications/application_target_authority.js"));
const applicationHold = require(path.join(root, "src/applications/application_inventory_hold.js"));
const { availabilityRead } = require(path.join(root, "src/surfaces/availability_read.js"));
const applicationTargetRead = require(path.join(root, "src/applications/application_target_read.js"));
const { prepareApplicationOffer } = require(path.join(root, "src/money/application_offer_terms.js"));
const lifecycle = require(path.join(root, "src/applications/application_lifecycle.js"));
const { materializeRentableSpaces } = require(path.join(root, "src/tenancy/inventory_materialization.js"));

const API = process.env.E2E_API_BASE || "http://127.0.0.1:3100";

let pass = 0, fail = 0; const failures = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); }
};

(async () => {
  await boundary.assertDatabase();
  const pool = new Pool({ connectionString: boundary.manifest().url, ssl: false });
  const one = async (sql, args = []) => (await pool.query(sql, args)).rows[0];

  const leasePackets = leasePacketsModule({ pool,
    satisfyObligation: engine.satisfyObligation, completeObligation: engine.completeObligation })._service;

  const runId = randomUUID().slice(0, 8);
  const sent = [];
  const sms = {
    enabled: () => true,
    sendSms: async ({ to, body }) => {
      sent.push({ to, body });
      return { sent: true, sid: `HOLD-${runId}-${sent.length}`, status: "queued" };
    },
  };
  const commBoundary = require(path.join(root, "src/comms/communications_boundary.js"))({ pool, sms });
  const handoff = leaseHandoffModule({ pool,
    spawnObligationFromEvent: engine.spawnObligationFromEvent,
    satisfyObligation: engine.satisfyObligation,
    completeObligation: engine.completeObligation, leasePackets, commBoundary });

  const tag = `hold-${randomUUID().slice(0, 8)}`;
  try {
    // ── FIXTURE ────────────────────────────────────────────────────
    const org = await one("insert into organizations(name,slug) values($1,$1) returning id", [tag]);
    const personOf = async (n) => (await one("insert into persons(name) values($1) returning id", [n])).id;
    const opPerson = await personOf(`${tag}-operator`);
    const applicant = await personOf(`${tag}-applicant`);
    const rival = await personOf(`${tag}-second-prospect`);
    await pool.query(`update persons set primary_phone_e164=$2 where id=$1`, [applicant, "+12025550288"]);
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
    await pool.query(`insert into leasing_leads(property_id,person_id) values($1,$2),($1,$3)`,
      [property.id, applicant, rival]);
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
       values ($1,'text','opted_in')`, [applicant]);

    /*  TWO BEDS IN ONE UNIT, BOTH ESTABLISHED VACANT.
     *
     *  The sibling is the control: a hold is on a BED, and holding a room
     *  must not take its roommate's room off the market. A per-unit hold
     *  would pass a single-bed fixture.
     *
     *  ⚠ AND THE VACANCY IS ESTABLISHED THROUGH THE OPENING-POSITION CHAIN,
     *  not asserted. availability_read refuses to call a position marketable
     *  without an established occupancy basis — correctly — so a fixture that
     *  skipped this would have measured `occupancy_unknown` and learned
     *  nothing about the hold. Both beds must start genuinely marketable or
     *  the difference this proof is looking for is invisible.            */
    const unit = await one("insert into units(property_id,unit_number) values($1,'501') returning id", [property.id]);
    await pool.query("delete from spaces where unit_id=$1", [unit.id]);
    await materializeRentableSpaces(pool, { unit_id: unit.id, labels: ["RoomA", "RoomB"], kind: "bed" });
    await pool.query("update spaces set use_type='residential' where unit_id=$1", [unit.id]);
    const roomA = await one("select id from spaces where unit_id=$1 and space_label='RoomA'", [unit.id]);
    const roomB = await one("select id from spaces where unit_id=$1 and space_label='RoomB'", [unit.id]);

    const batch = await one(`insert into import_batches(property_id,source_type,source_file,
      source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger',$2,date '2026-07-31','bed','confirmed','committed') returning id`,
      [property.id, `${tag}.csv`]);
    const act = await one(`insert into activations(property_id,status,source_as_of_date,
      import_batch_id,source_label) values($1,'activated',date '2026-07-31',$2,$3) returning id`,
      [property.id, batch.id, `${tag}.csv`]);
    let rowIndex = 0;
    for (const bed of [{ label: "RoomA", id: roomA.id }, { label: "RoomB", id: roomB.id }]) {
      rowIndex++;
      const srcRow = await one(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,
        produced_unit_id,produced_space_id) values($1,$2,$3,'fixture: confirmed vacancy',$4,$5) returning id`,
        [batch.id, rowIndex,
         JSON.stringify({ unit_number: "501", space_label: bed.label, is_vacant: true }),
         unit.id, bed.id]);
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,
        normalized_json,status,status_reason,import_source_row_id,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted','Fixture: confirmed vacant rentable position.',$5,now())`,
        [act.id, property.id, `501|${bed.label}`,
         JSON.stringify({ section: "current", unit_number: "501", space_label: bed.label, is_vacant: true }),
         srcRow.id]);
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,activation_id,import_batch_id,
      as_of_date,positions_established,positions_unresolved,source_rows_read,authority_basis,status)
      values($1,$2,$3,date '2026-07-31',2,0,2,'fixture:application_inventory_hold.db.js','established')`,
      [property.id, act.id, batch.id]);

    const c0 = await pool.connect();
    let offer;
    try { await c0.query("begin");
      offer = await prepareApplicationOffer(c0, {
        actor: { id: operator.id, property_id: property.id },
        person_id: applicant, space_id: roomA.id,
        lease_start_date: "2026-10-01", lease_end_date: "2027-09-30",
        rent: 1400, security_deposit: 1400, fees: [], concessions: { status: "none" },
        idempotency_key: `${tag}-offer`,
      });
      await c0.query("commit");
    } catch (e) { await c0.query("rollback").catch(() => {}); throw e; }
    finally { c0.release(); }

    const app = await one(`insert into lease_applications
      (property_id, person_id, unit_id, space_id, applicant_name, status, submitted_at,
       application_offer_id, application_terms_acknowledged_at, application_terms_hash)
      values($1,$2,$3,$4,$5,'submitted', now(), $6, now(), $7) returning *`,
      [property.id, applicant, unit.id, roomA.id, `${tag} applicant`, offer.offer.id,
       offer.offer.offered_terms_snapshot.application_terms_hash]);

    // ── 1 · BEFORE THE SIGNATURE, THE BED IS OPEN ──────────────────
    const before = await availabilityRead(pool, { property_id: property.id });
    const rowABefore = before.rows.find((r) => String(r.space_id) === String(roomA.id));
    ok("before anyone signs, the bed reads marketable and carries no hold",
      rowABefore.marketing_state === "marketable_now" && rowABefore.application_hold === null,
      JSON.stringify({ state: rowABefore.marketing_state, hold: rowABefore.application_hold }));
    const targetBefore = await applicationTarget.resolveApplicationTarget(pool, {
      property_id: property.id, space_id: roomA.id, intended_move_in: "2026-10-01" });
    ok("…and an application may be aimed at it",
      targetBefore.ok === true && targetBefore.offerable === true, JSON.stringify(targetBefore.refusal_code));

    // ── 2 · THE APPLICANT SIGNS, THROUGH THE REAL SIGNER ROUTES ────
    const c1 = await pool.connect();
    try { await c1.query("begin");
      await handoff.recordCompletionOwed(c1, { application: app });
      await c1.query("commit"); } finally { c1.release(); }
    const run = await handoff.runOwedHandoffs({ application_id: app.id });
    ok("the handoff prepared and dispatched the package",
      (run.results[0] || {}).outcome === "accepted", JSON.stringify(run.results[0]));

    //  The token comes out of the message the product actually sent — not
    //  out of the database. A token nobody could have received proves
    //  nothing about a signature anybody could have made.
    const link = (sent[sent.length - 1] || {}).body || "";
    const token = (link.match(/\/t\/lease\/([A-Za-z0-9_-]+)/) || [])[1] || null;
    ok("a signing token reached the applicant's message", !!token, link);

    const packet = await one(
      `select id from lease_packets where application_id=$1 and superseded_at is null`, [app.id]);
    const fields = (await pool.query(
      `select id from lease_packet_fields
        where lease_packet_id=$1 and signer_role='tenant' and required=true`, [packet.id])).rows;
    for (const f of fields) {
      const r = await fetch(`${API}/t/lease/${token}/fields/${f.id}/complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "true" }) });
      if (!r.ok) throw new Error(`field complete failed ${r.status}: ${await r.text()}`);
    }
    const submit = await fetch(`${API}/t/lease/${token}/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const submitBody = await submit.json().catch(() => ({}));
    ok("the applicant SIGNS through the real public signer route",
      submit.status === 200, `${submit.status} ${JSON.stringify(submitBody).slice(0, 200)}`);
    const signedPacket = await one(
      `select tenant_submitted_at, status from lease_packets where id=$1`, [packet.id]);
    ok("…and the canonical signature fact is stamped by the product, not by this proof",
      !!signedPacket.tenant_submitted_at, JSON.stringify(signedPacket));

    // ── 3 · THE HOLD REACHES THE CANONICAL AVAILABILITY READER ─────
    const after = await availabilityRead(pool, { property_id: property.id });
    const rowA = after.rows.find((r) => String(r.space_id) === String(roomA.id));
    const rowB = after.rows.find((r) => String(r.space_id) === String(roomB.id));
    ok("the signed bed is no longer marketable — it is HELD",
      rowA.marketing_state === applicationHold.HELD_STATE, rowA.marketing_state);
    ok("…and the row says WHO holds it and SINCE WHEN, not just that it is held",
      !!rowA.application_hold
        && String(rowA.application_hold.application_id) === String(app.id)
        && !!rowA.application_hold.signed_at
        && rowA.application_hold.applicant_name === `${tag} applicant`,
      JSON.stringify(rowA.application_hold));
    ok("…with operator copy, not an internal code",
      rowA.blocking_label === "Signed for by an applicant — held", rowA.blocking_label);
    ok("…and the ROOMMATE'S bed is untouched — a hold is on a home, not a unit",
      rowB.marketing_state === "marketable_now" && rowB.application_hold === null,
      JSON.stringify({ state: rowB.marketing_state, hold: rowB.application_hold }));
    ok("…and the property headline stops counting it as marketable",
      after.headline.marketable_now === before.headline.marketable_now - 1,
      `${before.headline.marketable_now} → ${after.headline.marketable_now}`);
    /*  A state absent from the summary is a quiet remainder, which is how a
     *  bed goes missing from a count. The held home is named, not dropped. */
    ok("…and the held home is NAMED in the headline rather than quietly missing",
      after.headline[applicationHold.HELD_STATE] === 1
        && after.states[applicationHold.HELD_STATE] === 1,
      JSON.stringify(after.headline));

    // ── 4 · AND THE APPLICATION-TARGET AUTHORITY ───────────────────
    const rivalTarget = await applicationTarget.resolveApplicationTarget(pool, {
      property_id: property.id, space_id: roomA.id, intended_move_in: "2026-10-01" });
    ok("a SECOND application cannot be aimed at the held bed",
      rivalTarget.ok === false
        && rivalTarget.refusal_code === "application_target_held_for_signed_applicant",
      JSON.stringify({ ok: rivalTarget.ok, code: rivalTarget.refusal_code }));
    ok("…and the refusal is a sentence a person can act on",
      /already signed for this home/.test(rivalTarget.refusal_reason || "")
        && /Choose another home/.test(rivalTarget.refusal_reason || ""),
      rivalTarget.refusal_reason);
    /*  ⚠ AND IT NAMES NOBODY. This sentence is shown to a different
     *  prospect. Naming who signed would disclose one applicant's decision
     *  to another; the attribution belongs on the entitled operator row.  */
    ok("…and it does NOT disclose who signed to the person being refused",
      !String(rivalTarget.refusal_reason || "").includes(`${tag} applicant`),
      rivalTarget.refusal_reason);
    ok("…while the holder's OWN application is not refused by its own hold",
      (await applicationTarget.resolveApplicationTarget(pool, {
        property_id: property.id, space_id: roomA.id, intended_move_in: "2026-10-01",
        for_application_id: app.id })).ok === true);
    ok("…and the exemption needs the real id — a wrong one is still refused",
      (await applicationTarget.resolveApplicationTarget(pool, {
        property_id: property.id, space_id: roomA.id, intended_move_in: "2026-10-01",
        for_application_id: randomUUID() })).refusal_code
        === "application_target_held_for_signed_applicant");
    const submissionTarget = await applicationTarget.resolveSubmissionTarget(pool, {
      property_id: property.id, unit_id: unit.id, space_id: roomA.id,
      intended_move_in: "2026-10-01" });
    ok("submission-time revalidation keeps the COMMITMENT reason, not a generic unavailability",
      submissionTarget.ok === false
        && submissionTarget.refusal_code === "application_target_held_for_signed_applicant",
      JSON.stringify(submissionTarget.refusal_code));

    /*  ── 4b · AND THE MATCHER STOPS OFFERING IT ───────────────────
     *  `leaseableApplicationTargets` is the shared authority the prospect
     *  matcher and Ask Spine both read. It consults availabilityRead and
     *  evaluateDatedOfferability — the two things the hold now reaches — so
     *  this inherits the refusal rather than implementing it again. Proven
     *  rather than assumed: "it should follow" is how two readers come to
     *  disagree about one bed.                                           */
    const leaseable = await applicationTargetRead.leaseableApplicationTargets(pool, {
      property_id: property.id, requested_start: "2026-10-01", requested_end: "2027-09-30" });
    const eligibleSpaces = (leaseable.eligible_targets || []).map((t) => String(t.space_id));
    ok("the prospect matcher no longer offers the held home",
      !eligibleSpaces.includes(String(roomA.id)), JSON.stringify(eligibleSpaces));
    ok("…and still offers its roommate's home",
      eligibleSpaces.includes(String(roomB.id)), JSON.stringify(eligibleSpaces));

    /*  ── 4c · A HOLD ENDS WHEN TENANCY BEGINS ────────────────────
     *  A hold is a PRE-tenancy commitment. Once the application reaches
     *  `accepted_term_required` or `active` the lease exists and governs
     *  the bed; a reader still saying "held for a signed applicant" is
     *  asserting a commitment that has already been honoured.
     *
     *  The first version released only on declined / withdrawn / expired —
     *  right for an application that STOPPED, wrong for one that FINISHED
     *  — and CI found it as a later scenario refused with
     *  `application_target_held_for_signed_applicant` on a bed whose
     *  application had long since become a tenancy.
     *
     *  In production the lease usually decides first, because this read is
     *  consulted LAST and an occupied position never reaches it. That is
     *  exactly why the predicate is asserted directly here: a guard that is
     *  only correct because something upstream normally shadows it is not
     *  a guard.                                                          */
    for (const st of ["approved", "lease_ready"]) {
      await pool.query("update lease_applications set status=$2 where id=$1", [app.id, st]);
      ok(`a signed application at \`${st}\` still holds its home`,
        !!(await applicationHold.holdForSpace(pool, roomA.id)));
    }
    for (const st of applicationHold.RELEASED_STATUSES.filter(
           (x) => !["declined", "withdrawn", "expired"].includes(x))) {
      await pool.query("update lease_applications set status=$2 where id=$1", [app.id, st]);
      ok(`…and at \`${st}\` the lease governs the home, so the hold ends`,
        (await applicationHold.holdForSpace(pool, roomA.id)) === null);
    }
    await pool.query("update lease_applications set status='lease_ready' where id=$1", [app.id]);

    // ── 5 · NOTHING WAS RESERVED, SO NOTHING HAS TO BE RELEASED ────
    /*  The hold is a READ of the signature. A withdrawn application releases
     *  its bed through the same read that created the hold — no release
     *  step, no stale reservation, no row anybody has to remember to
     *  delete.                                                            */
    const cW = await pool.connect();
    try { await cW.query("begin");
      await lifecycle.markTerminal(cW, { applicationId: app.id, terminalCode: "withdrawn",
        decisionReason: "proof: applicant withdrew after signing" });
      await cW.query("commit"); } finally { cW.release(); }
    const released = await availabilityRead(pool, { property_id: property.id });
    const rowAReleased = released.rows.find((r) => String(r.space_id) === String(roomA.id));
    ok("a withdrawn application releases the bed by the same read that held it",
      rowAReleased.marketing_state === "marketable_now" && rowAReleased.application_hold === null,
      JSON.stringify({ state: rowAReleased.marketing_state, hold: rowAReleased.application_hold }));
    ok("…and the bed can be aimed at again",
      (await applicationTarget.resolveApplicationTarget(pool, {
        property_id: property.id, space_id: roomA.id, intended_move_in: "2026-10-01" })).ok === true);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log("FAILED: " + failures.join(" | "));
  } finally {
    await pool.end();
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error("HARNESS ERROR", e && e.stack ? e.stack : e); process.exitCode = 2; });
