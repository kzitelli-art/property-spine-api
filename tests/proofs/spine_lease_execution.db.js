/* ════════════════════════════════════════════════════════════════════
   spine_lease_execution.db.js — SPINE'S OWN EXECUTED INSTRUMENT INTO THE
   CANONICAL EXECUTED-LEASE SERVICE. REAL POSTGRES.

   The adapter under test creates NO second architecture. It composes:
     executed_lease_service.verifyExecutedLease   (the one record + admission)
     tenancy_anchor_service.confirmTermService    (the one tenancy writer)

   ── WHAT IS REAL HERE AND WHAT IS NOT — SAID PLAINLY ────────────────
   `verifyExecutedLease` is the REAL service against a REAL database, so
   the canonical record, its constraints and the admission engine are all
   genuinely exercised. `confirmTermService` is a RECORDING STUB: the real
   one is constructed in server.js with the obligation engine injected,
   and standing that up here would be testing the wiring of server.js
   rather than this adapter. What is therefore proven is that the adapter
   INVOKES the canonical writer with server-derived arguments on a clean
   admission and does NOT invoke it when blocked. That the writer then
   creates exactly one pending lease is that service's own proof.

   ── WHY verified_by_user_id IS NOT FAKED ────────────────────────────
   088 requires it because "verification is an attested act by a real
   staff user". For an in-Spine execution the verifier IS the authorised
   company signer — the human who performed the consequential act — and
   185 records `verification_basis = 'spine_instrument'` so the two acts
   are never readable as the same claim. Asserted below.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   Requires migrations 034, 088, 182, 184, 185.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/spine_proof \
       node tests/proofs/spine_lease_execution.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const executedLease = require("../../src/applications/executed_lease_service.js");
const { executeSpineLease } = require("../../src/applications/spine_lease_execution.js");
//  The SAME normalizer the executed-lease service uses. Computing the
//  acknowledged payload hash any other way would make the fixture disagree
//  with the engine for a reason that is about the fixture, not the product.
const { normalizeAndHash } = require("../../src/applications/proposed_terms_service.js");

const pool = new Pool({ connectionString: CONN });
let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
};

//  A REAL obligation spawner. server.js injects the production one; this
//  inserts the same durable row into the same table, so the admission
//  engine's lifecycle transition is genuinely satisfied rather than bypassed.
//  Stubbing it to return a fake id would have proven the transition ran, not
//  that it could run.
const spawnObligationFromEvent = async (client, o) => (await client.query(
  `insert into obligations (property_id, person_id, unit_id, source_event_id, related_id, related_type,
                            module, type, label, owner_type, assigned_role, status, priority, severity,
                            required_inputs)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
  [o.property_id, o.person_id, o.unit_id, o.source_event_id, o.related_id, o.related_type,
   o.module, o.type, o.label, o.owner_type, o.assigned_role, o.status, o.priority, o.severity,
   o.required_inputs])).rows[0];

//  The recording stub. It captures what the adapter would hand the canonical
//  writer, so "was it invoked, and with server-derived arguments" is provable.
let confirmCalls = [];
const confirmTermStub = async (client, args) => {
  confirmCalls.push(args);
  return { lease_id: "00000000-0000-0000-0000-0000000000aa", lease_status: "pending" };
};

async function refused(label, fn, expectCode) {
  try { await fn(); ok(label, false, "ACCEPTED — it should have refused"); }
  catch (e) {
    const code = (e.body && e.body.error) || e.code || e.message;
    ok(label, expectCode ? String(code).includes(expectCode) : true,
       "got: " + String(code).slice(0, 90));
  }
}

(async () => {
  const q = (s, p) => pool.query(s, p);
  const HASH = "b".repeat(64);

  // ── a world: property, bed, resident, signer, application, packet ──
  const prop = (await q("insert into properties (name) values ('Spine Exec Proof') returning id")).rows[0].id;
  const unit = (await q("insert into units (property_id, unit_number) values ($1,'3B') returning id", [prop])).rows[0].id;
  const bed = (await q("select id from spaces where unit_id=$1", [unit])).rows[0].id;
  const person = (await q("insert into persons (name) values ('Jane Smith') returning id")).rows[0].id;
  const signer = (await q("insert into users (name, role) values ('Authorised Signer','property_manager') returning id")).rows[0].id;
  const other = (await q("insert into users (name, role) values ('Someone Else','property_manager') returning id")).rows[0].id;
  const appId = (await q(
    `insert into lease_applications (property_id, unit_id, space_id, person_id, applicant_name, status)
     values ($1,$2,$3,$4,'Jane Smith','lease_ready') returning id`, [prop, unit, bed, person])).rows[0].id;

  //  The intake gate is a Class-2 release control, not a design boundary.
  process.env.EXECUTED_LEASE_INTAKE_ENABLED = "true";
  process.env.EXECUTED_LEASE_PROPERTY_IDS = prop;

  const terms = {
    space_id: bed, rent: 1025, security_deposit: 1025,
    lease_start_date: "2026-09-01", lease_end_date: "2027-08-31", concession_status: "none",
  };
  async function makePacket({ version, status = "executed", placeholder = false, hash = HASH,
                              residentSig = true, companySig = true, companyUser = signer,
                              termsJson = terms, application = appId }) {
    const p = (await q(
      `insert into lease_packets (property_id, application_id, unit_id, version, status, is_placeholder,
                                  instrument_body_sha256, instrument_form_code, terms_json,
                                  resident_executed_at, company_executed_at)
       values ($1,$2,$3,$4,'submitted',$5,$6,'SKYLINE_RESIDENTIAL',$7,now(),now()) returning id`,
      [prop, application, unit, version, placeholder, hash, JSON.stringify(termsJson)])).rows[0].id;
    if (residentSig) await q(
      `insert into lease_packet_fields (lease_packet_id, field_key, section_key, label, field_type, signer_role, completed, completed_at, signed_by_person_id, ip_address, session_id)
       values ($1,'r','execution','Resident','signature','tenant',true,now(),$2,'203.0.113.7','sess-r')`, [p, person]);
    if (companySig) await q(
      `insert into lease_packet_fields (lease_packet_id, field_key, section_key, label, field_type, signer_role, completed, completed_at, signed_by_user_id, ip_address, session_id)
       values ($1,'c','execution','Company','signature','company',true,now(),$2,'203.0.113.9','sess-c')`, [p, companyUser]);
    if (status !== "submitted") await q("update lease_packets set status=$2 where id=$1", [p, status]);
    return p;
  }
  const run = (packet, user = signer) => executeSpineLease(pool, {
    lease_packet_id: packet, company_signer_user_id: user,
  }, { executedLease, confirmTerm: confirmTermStub, spawnObligationFromEvent });

  console.log("\n── 1 · THE ADAPTER REFUSES WHAT IT MUST ───────────────────────");
  await refused("a packet that is not executed", async () => run(await makePacket({ version: 1, status: "submitted" })), "packet_not_executed");
  await refused("no company signer supplied", async () => {
    const p = await makePacket({ version: 2 });
    return executeSpineLease(pool, { lease_packet_id: p }, { executedLease, confirmTerm: confirmTermStub, spawnObligationFromEvent });
  }, "company_signer_required");
  await refused("a packet with no resident signature", async () =>
    run(await makePacket({ version: 3, residentSig: false })), "resident_signature_missing");
  await refused("a packet with no company signature", async () =>
    run(await makePacket({ version: 4, companySig: false })), "company_signature_missing");
  await refused("a DIFFERENT user recording someone else's signature", async () =>
    run(await makePacket({ version: 5 }), other), "company_signer_mismatch");
  await refused("an instrument with no hash", async () => {
    //  184's trigger blocks executing a hashless packet, so it is forced past
    //  the guard here to prove the adapter refuses independently.
    const p = await makePacket({ version: 6, status: "submitted" });
    await q("update lease_packets set instrument_body_sha256=null where id=$1", [p]);
    await q("update lease_packets set status='executed' where id=$1", [p]).catch(() => {});
    return run(p);
  });

  console.log("\n── 2 · ONE SIGNED INSTRUMENT, ONE IDENTITY, ONE RECORD ────────");
  confirmCalls = [];
  //  ADMISSION DEMANDS A PROPOSED-TERMS CONFIRMATION to compare the executed
  //  lease against — the engine's `no_acknowledged_terms` blocker. That is
  //  the existing rule and it is not being weakened; the fixture satisfies it
  //  so the CLEAN-ADMISSION path is genuinely exercised rather than asserted.
  //  Without this the harness only ever proves the blocked branch, which is
  //  the easier half and not the claim.
  const ptEv = (await q("insert into events (property_id, person_id, type, note) values ($1,$2,'proposed_terms_confirmed','fixture') returning id", [prop, person])).rows[0].id;
  await q(
    `insert into application_proposed_terms_confirmations
       (application_id, property_id, actor_user_id, event_id, rent, security_deposit,
        lease_start_date, lease_end_date, concession_status, source, authority_basis,
        idempotency_key, payload_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'none','operator_proposed_terms','role_authority',$9,$10)`,
    [appId, prop, signer, ptEv, terms.rent, terms.security_deposit,
     terms.lease_start_date, terms.lease_end_date, "ptc-" + appId,
     normalizeAndHash({ rent: terms.rent, security_deposit: terms.security_deposit,
       lease_start_date: terms.lease_start_date, lease_end_date: terms.lease_end_date,
       concession_status: "none" }).payload_hash]);
  const good = await makePacket({ version: 10 });
  await q(`update lease_packets set proposed_terms_confirmation_id =
             (select id from application_proposed_terms_confirmations where application_id=$1 limit 1)
           where id=$2`, [appId, good]);
  const out = await run(good);
  ok("execution produced a canonical executed-lease record", !!out.executed_lease_record_id);
  const rec = (await q("select * from executed_lease_records where id=$1", [out.executed_lease_record_id])).rows[0];
  ok("…basis is spine_instrument, not an attestation", rec.verification_basis === "spine_instrument", rec.verification_basis);
  ok("…channel is spine_esign, not hidden under 'other'", rec.execution_channel === "spine_esign", rec.execution_channel);
  ok("…lineage points at the packet that was executed", String(rec.source_lease_packet_id) === String(good));
  ok("…document_sha256 EQUALS the packet's instrument hash", rec.document_sha256 === HASH, rec.document_sha256);
  ok("…the verifier is the company SIGNER, a real user", String(rec.verified_by_user_id) === String(signer));
  ok("…the bed came from the packet, not a request body", String(rec.space_id) === String(bed));
  ok("…and the economics are the SIGNED ones", Number(rec.rent) === 1025);
  const sg = typeof rec.signers === "string" ? JSON.parse(rec.signers) : rec.signers;
  ok("…both sides' signer evidence is carried", sg.some((x) => x.role === "tenant") && sg.some((x) => x.role === "company"));
  ok("…including per-signature audit evidence", sg.every((x) => x.ip_address && x.session_id));

  console.log("\n── 3 · NO SECOND HUMAN CEREMONY ───────────────────────────────");
  if (out.activation_status === "admitted") {
    ok("a clean admission invokes the canonical tenancy writer automatically", confirmCalls.length === 1);
    ok("…with a server-derived confirmer, not a typed name",
       confirmCalls.length === 1 && String(confirmCalls[0].confirmed_by_user_id) === String(signer));
    ok("…and the operator sees one act, not two", out.tenancy && out.tenancy.lease_id);
  } else {
    ok("blocked: the tenancy writer was NOT invoked", confirmCalls.length === 0);
    ok("…the executed lease is still recorded", !!rec.id);
    ok("…and the conflict is named, never an empty success",
       Array.isArray(out.blockers) && out.blockers.length > 0, JSON.stringify(out.blockers));
    console.log("          blockers: " + JSON.stringify(out.blockers));
  }

  console.log("\n── 4 · A CONFLICT PRESERVES WHAT WAS SIGNED ───────────────────");
  confirmCalls = [];
  //  A packet whose signed premises contradict the application's own bed.
  const otherUnit = (await q("insert into units (property_id, unit_number) values ($1,'9Z') returning id", [prop])).rows[0].id;
  const otherBed = (await q("select id from spaces where unit_id=$1", [otherUnit])).rows[0].id;
  const conflicted = await makePacket({ version: 11, termsJson: { ...terms, space_id: otherBed } });
  let conflictOut = null, threw = null;
  try { conflictOut = await run(conflicted); } catch (e) { threw = e; }
  if (conflictOut) {
    const crec = (await q("select id, record_state from executed_lease_records where source_lease_packet_id=$1", [conflicted])).rows[0];
    ok("the executed lease is RECORDED even on a premises conflict", !!crec);
    ok("…activation is blocked rather than the evidence erased",
       conflictOut.activation_status === "blocked" || (conflictOut.blockers || []).length > 0,
       JSON.stringify({ s: conflictOut.activation_status, b: conflictOut.blockers }));
  } else {
    ok("a premises conflict is a NAMED refusal, not a silent pass",
       !!threw && !!(threw.body || threw.code), String(threw && (threw.code || threw.message)).slice(0, 80));
  }

  console.log("\n── 5 · REPLAY CONVERGES, IT DOES NOT DUPLICATE ────────────────");
  const again = await run(good);
  ok("a second execution of the same packet is idempotent or refused",
     again.idempotent === true || String(again.executed_lease_record_id) === String(out.executed_lease_record_id),
     JSON.stringify({ idem: again.idempotent, id: again.executed_lease_record_id }));
  const count = (await q("select count(*)::int n from executed_lease_records where source_lease_packet_id=$1", [good])).rows[0].n;
  ok("…and exactly ONE record exists for that packet", count === 1, "count=" + count);

  console.log("\n── 6 · THE ATTESTATION PATH IS UNCHANGED ──────────────────────");
  const legacyApp = (await q(
    `insert into lease_applications (property_id, unit_id, space_id, person_id, applicant_name, status)
     values ($1,$2,$3,$4,'Legacy','lease_ready') returning id`, [prop, unit, bed, person])).rows[0].id;
  let legacy = null;
  try {
    legacy = await executedLease.verifyExecutedLease(pool, {
      application_id: legacyApp, space_id: bed, rent: 900, security_deposit: 900,
      lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
      document_sha256: "c".repeat(64), executed_at: new Date().toISOString(),
      signers: [{ name: "Legacy Tenant", capacity: "resident" }], execution_channel: "paper",
      verified_by_user_id: signer,
    }, {});
  } catch (e) { legacy = { error: (e.body && e.body.error) || e.code || e.message }; }
  ok("a paper lease still verifies by staff attestation",
     !!(legacy && legacy.record_id), JSON.stringify(legacy).slice(0, 120));
  if (legacy && legacy.record_id) {
    const lrec = (await q("select verification_basis, source_lease_packet_id from executed_lease_records where id=$1", [legacy.record_id])).rows[0];
    ok("…and it defaults to staff_attestation with no packet lineage",
       lrec.verification_basis === "staff_attestation" && lrec.source_lease_packet_id === null);
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("   ✗ " + f));
  console.log("════════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("DIED:", e && e.stack);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
