/*
 * One governing lease package, two resident-side signer identities.
 *
 * Real PostgreSQL proof. No carrier is wired and no message can leave this
 * process. The harness uses HARNESS_DATABASE_URL and refuses production.
 */
"use strict";

const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const receipt = require("../_run_receipt");
const leasePacketsModule = require("../../src/applications/lease_packets");
const { executeSpineLease } = require("../../src/applications/spine_lease_execution");
const { buildReviewList, buildReviewDetail } = require("../../src/applications/application_review");
const { readLeasingStanding } = require("../../src/leasing/leasing_standing_read");

const CONN = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: CONN });
receipt.begin(__filename, { url: CONN, expected: 40 });

let passed = 0;
let failed = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ok    " + label);
  } else {
    failed++;
    failures.push(label);
    console.log("  FAIL  " + label + (detail ? "\n          " + detail : ""));
  }
}

let satisfiedCalls = 0;
let completedCalls = 0;
const packetRouter = leasePacketsModule({
  pool,
  satisfyObligation: async () => { satisfiedCalls++; return { satisfied: true }; },
  completeObligation: async () => { completedCalls++; return { completed: true }; },
});
const packetService = packetRouter._service;

function tokenFrom(url) {
  return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop());
}

async function startServer() {
  const app = express();
  app.use(packetRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function api(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

(async () => {
  const q = (sql, params) => pool.query(sql, params);
  const sourceBytes = Buffer.from("%PDF-1.7\nlocal retained lease source for guarantor proof");
  const bodyHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const termsHash = "b".repeat(64);
  const packageHash = "c".repeat(64);

  const propertyId = (await q(
    "insert into properties(name) values ('Guarantor signing proof') returning id"
  )).rows[0].id;
  const companyUserId = (await q(
    "insert into users(name,role) values ('Company Signer','property_manager') returning id"
  )).rows[0].id;
  const sourceId = (await q(
    `insert into source_artifacts
       (scope_type,scope_id,original_filename,mime_type,artifact_kind,byte_size,sha256,
        content,stored_at,uploaded_by_user_id,uploaded_by_basis)
     values ('property',$1,'lease.pdf','application/pdf','lease_template',$2,$3,$4,now(),$5,'proof')
     returning id`,
    [propertyId, sourceBytes.length, bodyHash, sourceBytes, companyUserId]
  )).rows[0].id;

  async function makeScenario(index, { omitGuarantorField = false } = {}) {
    const residentName = `Resident ${index}`;
    const guarantorName = `Guarantor ${index}`;
    const personId = (await q(
      "insert into persons(name,primary_phone_e164,email) values ($1,$2,$3) returning id",
      [residentName, `+1215555010${index}`, `resident${index}@example.invalid`]
    )).rows[0].id;
    const unitId = (await q(
      "insert into units(property_id,unit_number) values ($1,$2) returning id",
      [propertyId, `G-${index}`]
    )).rows[0].id;
    const spaceId = (await q("select id from spaces where unit_id=$1", [unitId])).rows[0].id;
    const captured = {
      phone: `+1215555010${index}`,
      email: `resident${index}@example.invalid`,
      guarantor_contact: {
        name: guarantorName,
        phone: `+1215555020${index}`,
        email: `guarantor${index}@example.invalid`,
      },
    };
    const applicationId = (await q(
      `insert into lease_applications
         (property_id,unit_id,space_id,person_id,applicant_name,status,captured,
          rent,deposit,lease_start_date,lease_end_date,concession_status)
       values ($1,$2,$3,$4,$5,'lease_ready',$6::jsonb,1500,1500,'2026-10-01','2027-09-30','none')
       returning id`,
      [propertyId, unitId, spaceId, personId, residentName, JSON.stringify(captured)]
    )).rows[0].id;
    const obligationId = (await q(
      `insert into obligations
         (property_id,person_id,unit_id,related_id,related_type,module,type,label,status,required_inputs)
       values ($1,$2,$3,$4,'lease_application','leasing','terms_review','Review lease terms','open',array['terms_acknowledged'])
       returning id`,
      [propertyId, personId, unitId, applicationId]
    )).rows[0].id;
    const eventId = (await q(
      "insert into events(property_id,person_id,type,note) values ($1,$2,'proposed_terms_confirmed','proof') returning id",
      [propertyId, personId]
    )).rows[0].id;
    const confirmationId = (await q(
      `insert into application_proposed_terms_confirmations
         (application_id,property_id,actor_user_id,event_id,rent,security_deposit,
          lease_start_date,lease_end_date,concession_status,source,authority_basis,
          idempotency_key,payload_hash)
       values ($1,$2,$3,$4,1500,1500,'2026-10-01','2027-09-30','none',
               'operator_proposed_terms','role_authority',$5,$6)
       returning id`,
      [applicationId, propertyId, companyUserId, eventId,
       `confirm-${applicationId}`, crypto.createHash("sha256").update(applicationId).digest("hex")]
    )).rows[0].id;
    await q(
      `update lease_applications
          set terms_review_obligation_id=$2, proposed_terms_confirmation_id=$3
        where id=$1`,
      [applicationId, obligationId, confirmationId]
    );
    const terms = {
      resident_names: residentName,
      guarantor_required: true,
      guarantor_name: guarantorName,
      unit_id: unitId,
      space_id: spaceId,
      monthly_rent: 1500,
      security_deposit: 1500,
      lease_start_date: "2026-10-01",
      lease_end_date: "2027-09-30",
      concession_status: "none",
    };
    const packetId = (await q(
      `insert into lease_packets
         (property_id,application_id,unit_id,version,status,terms_json,rendered_snapshot,
          is_placeholder,proposed_terms_confirmation_id,instrument_form_code,
          instrument_source_artifact_id,instrument_body_sha256,instrument_terms_sha256,
          instrument_package_sha256,instrument_manifest,instrument_text_snapshot)
       values ($1,$2,$3,1,'draft',$4::jsonb,$5::jsonb,false,$6,'PROOF_LEASE',
               $7,$8,$9,$10,$11::jsonb,'retained lease text')
       returning id`,
      [propertyId, applicationId, unitId, JSON.stringify(terms),
       JSON.stringify({ title: "Lease", summary: { resident_names: residentName }, sections: [] }),
       confirmationId, sourceId, bodyHash, termsHash, packageHash,
       JSON.stringify({ source_sha256: bodyHash, terms_sha256: termsHash })]
    )).rows[0].id;
    const signerRows = (await q(
      `insert into lease_packet_signers
         (lease_packet_id,signer_role,display_name,person_id,phone_e164,email)
       values ($1,'tenant',$2,$3,$4,$5),
              ($1,'guarantor',$6,null,$7,$8)
       returning id,signer_role,display_name`,
      [packetId, residentName, personId, captured.phone, captured.email,
       guarantorName, captured.guarantor_contact.phone, captured.guarantor_contact.email]
    )).rows;
    const fieldRows = (await q(
      `insert into lease_packet_fields
         (lease_packet_id,field_key,section_key,label,field_type,signer_role,required,clause_hash,display_order)
       values ($1,'sign_resident','sign','Resident signature','signature','tenant',true,$2,1),
              ($1,'sign_guarantor','sign','Guarantor signature','signature','guarantor',true,$2,2),
              ($1,'sign_company','sign','Company signature','signature','company',false,$2,3)
       returning id,signer_role`,
      [packetId, packageHash]
    )).rows;
    if (omitGuarantorField) {
      await q("delete from lease_packet_fields where lease_packet_id=$1 and signer_role='guarantor'",
        [packetId]);
    }

    const client = await pool.connect();
    let issued;
    try {
      await client.query("begin");
      issued = await packetService.issueLeasePacketLink(client, {
        packetId,
        expiresDays: 14,
        idempotencyKey: `issue-${packetId}`,
        actorUserId: companyUserId,
        expectedPropertyId: propertyId,
      });
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    const links = Object.fromEntries(issued.signing_links.map((link) => [link.signer_role, link]));
    const fields = Object.fromEntries(fieldRows.map((field) => [field.signer_role, field.id]));
    const signers = Object.fromEntries(signerRows.map((signer) => [signer.signer_role, signer]));
    return { applicationId, packetId, personId, residentName, guarantorName,
      links, fields, signers, tokens: {
        tenant: tokenFrom(links.tenant.url),
        guarantor: tokenFrom(links.guarantor.url),
      } };
  }

  async function completeAndSubmit(base, scenario, role) {
    const token = scenario.tokens[role];
    const completed = await api(base, "POST",
      `/t/lease/${encodeURIComponent(token)}/fields/${scenario.fields[role]}/complete`,
      { value: role === "tenant" ? scenario.residentName : scenario.guarantorName,
        consent: true, session_id: `session-${role}` });
    const submitted = await api(base, "POST",
      `/t/lease/${encodeURIComponent(token)}/submit`, { session_id: `session-${role}` });
    return { completed, submitted };
  }

  const { server, base } = await startServer();
  try {
    const first = await makeScenario(1);
    ok("one issue returns resident and guarantor links", Object.keys(first.links).length === 2);
    ok("each returned link names the exact signer it belongs to",
      first.links.tenant.display_name === first.residentName
        && first.links.guarantor.display_name === first.guarantorName);
    ok("the two signers receive different secrets", first.tokens.tenant !== first.tokens.guarantor);
    const issuedRow = (await q(
      "select issue_actor_user_id,issue_idempotency_key,issued_at from lease_packets where id=$1",
      [first.packetId])).rows[0];
    ok("issuance persists actor, retry identity, and time together",
      String(issuedRow.issue_actor_user_id) === String(companyUserId)
        && !!issuedRow.issue_idempotency_key && !!issuedRow.issued_at);
    const storedTokens = (await q(
      "select token_hash from lease_packet_signers where lease_packet_id=$1",
      [first.packetId])).rows.map((row) => row.token_hash);
    ok("raw link secrets are never stored", storedTokens.every((hash) =>
      hash !== first.tokens.tenant && hash !== first.tokens.guarantor));
    let signerRewriteError = null;
    try {
      await q("update lease_packet_signers set display_name='Changed' where id=$1",
        [first.signers.guarantor.id]);
    } catch (e) { signerRewriteError = e; }
    ok("signer identity is frozen after the links are issued",
      /frozen after issue/i.test(signerRewriteError && signerRewriteError.message));
    let signerBirthRewriteError = null;
    try {
      await q("update lease_packet_signers set created_at=created_at-interval '1 day' where id=$1",
        [first.signers.guarantor.id]);
    } catch (e) { signerBirthRewriteError = e; }
    ok("signer record identity time is also frozen after issue",
      /frozen after issue/i.test(signerBirthRewriteError && signerBirthRewriteError.message));
    let issuedFieldRewriteError = null;
    try {
      await q("update lease_packet_fields set label='Changed' where id=$1",
        [first.fields.guarantor]);
    } catch (e) { issuedFieldRewriteError = e; }
    ok("issued signer controls are structurally frozen",
      /field evidence is frozen/i.test(issuedFieldRewriteError && issuedFieldRewriteError.message));

    const issuedReview = await buildReviewList(pool, propertyId);
    const issuedApplication = issuedReview.applications.find(
      (application) => String(application.application_id) === String(first.applicationId));
    ok("the canonical property review names both outstanding resident-side signers after issue",
      issuedApplication && issuedApplication.signing.outstanding_signers.length === 2
        && issuedApplication.signing.outstanding_signers.map((signer) => signer.signer_role)
          .sort().join(",") === "guarantor,tenant");
    const otherPropertyId = (await q(
      "insert into properties(name) values ('Other signer proof property') returning id"
    )).rows[0].id;
    const otherReview = await buildReviewList(pool, otherPropertyId);
    ok("the signer census is scoped to the server-derived property",
      otherReview.count === 0 && otherReview.signing.outstanding_signer_count === 0);

    const tenantData = await api(base, "GET", `/t/lease/${encodeURIComponent(first.tokens.tenant)}/data`);
    const guarantorData = await api(base, "GET", `/t/lease/${encodeURIComponent(first.tokens.guarantor)}/data`);
    ok("resident link exposes only resident controls", tenantData.status === 200
      && tenantData.body.packet.fields.every((field) => field.signer_role === "tenant"));
    ok("guarantor link exposes only guarantor controls", guarantorData.status === 200
      && guarantorData.body.packet.fields.every((field) => field.signer_role === "guarantor"));
    const publicJson = JSON.stringify([tenantData.body, guarantorData.body]);
    ok("public signer projections expose no phone or email", !/example\.invalid|\+1215/.test(publicJson));

    const tenantCross = await api(base, "POST",
      `/t/lease/${encodeURIComponent(first.tokens.tenant)}/fields/${first.fields.guarantor}/complete`,
      { value: first.guarantorName, consent: true });
    const guarantorCross = await api(base, "POST",
      `/t/lease/${encodeURIComponent(first.tokens.guarantor)}/fields/${first.fields.tenant}/complete`,
      { value: first.residentName, consent: true });
    ok("resident token cannot complete the guarantor field", tenantCross.status === 404);
    ok("guarantor token cannot complete the resident field", guarantorCross.status === 404);

    const tenantFirst = await completeAndSubmit(base, first, "tenant");
    ok("resident can complete and submit their own controls",
      tenantFirst.completed.status === 200 && tenantFirst.submitted.status === 200);
    ok("the first signer does not advance the package to resident execution",
      tenantFirst.submitted.body.packet.status === "tenant_in_progress");
    ok("the first receipt names the actual outstanding signer",
      /Guarantor 1/.test(tenantFirst.submitted.body.receipt || ""));
    const tenantFirstReview = await buildReviewList(pool, propertyId);
    const tenantFirstStanding = tenantFirstReview.applications.find(
      (application) => String(application.application_id) === String(first.applicationId));
    ok("the property review rereads only the guarantor as outstanding after the resident signs",
      tenantFirstStanding && tenantFirstStanding.signing.outstanding_signers.length === 1
        && tenantFirstStanding.signing.outstanding_signers[0].signer_role === "guarantor"
        && tenantFirstStanding.signing.outstanding_signers[0].display_name === first.guarantorName);

    let earlyCompanyError = null;
    const early = await pool.connect();
    try {
      await early.query("begin");
      await early.query(
        `update lease_packet_fields
            set completed=true,completed_at=now(),signed_by_user_id=$2
          where lease_packet_id=$1 and signer_role='company'`,
        [first.packetId, companyUserId]);
      await early.query(
        "update lease_packets set status='executed',company_executed_at=now() where id=$1",
        [first.packetId]);
      await early.query("commit");
    } catch (e) {
      earlyCompanyError = e;
      await early.query("rollback");
    } finally {
      early.release();
    }
    ok("company execution is refused before the guarantor", !!earlyCompanyError);
    ok("the database blocks premature company-signature evidence",
      /field evidence is frozen at status tenant_in_progress/i.test(
        earlyCompanyError && earlyCompanyError.message));

    const guarantorSecond = await completeAndSubmit(base, first, "guarantor");
    ok("guarantor can complete and submit their own controls",
      guarantorSecond.completed.status === 200 && guarantorSecond.submitted.status === 200);
    ok("the final required signer advances the package to resident execution",
      guarantorSecond.submitted.body.packet.status === "resident_executed");
    const residentExecutedReview = await buildReviewList(pool, propertyId);
    const residentExecutedStanding = residentExecutedReview.applications.find(
      (application) => String(application.application_id) === String(first.applicationId));
    ok("the same property review moves the application to the authorized company signer",
      residentExecutedStanding && residentExecutedStanding.signing.outstanding_signers.length === 1
        && residentExecutedStanding.signing.outstanding_signers[0].signer_role === "company");
    const signerState = (await q(
      "select signer_role,submitted_at from lease_packet_signers where lease_packet_id=$1 order by signer_role",
      [first.packetId])).rows;
    ok("both resident-side submissions are durable",
      signerState.length === 2 && signerState.every((row) => !!row.submitted_at));
    const guarantorPersons = (await q(
      "select count(*)::int n from persons where name=$1", [first.guarantorName])).rows[0].n;
    ok("guarantor application contact is not silently minted as a Person", guarantorPersons === 0);

    const finalCompany = await pool.connect();
    try {
      await finalCompany.query("begin");
      await finalCompany.query(
        `update lease_packet_fields
            set completed=true,completed_at=now(),signed_by_user_id=$2
          where lease_packet_id=$1 and signer_role='company'`,
        [first.packetId, companyUserId]);
      await finalCompany.query(
        "update lease_packets set status='executed',company_executed_at=now() where id=$1",
        [first.packetId]);
      await finalCompany.query("commit");
    } finally {
      finalCompany.release();
    }
    ok("company execution succeeds after every required resident-side signer",
      (await q("select status from lease_packets where id=$1", [first.packetId])).rows[0].status === "executed");
    const executedReview = await buildReviewList(pool, propertyId);
    const executedStanding = executedReview.applications.find(
      (application) => String(application.application_id) === String(first.applicationId));
    ok("the property review removes the application from outstanding signatures after company execution",
      executedStanding && executedStanding.signing.outstanding_signers.length === 0);
    let evidenceDeleteError = null;
    try {
      await q("delete from lease_packet_fields where id=$1", [first.fields.tenant]);
    } catch (e) { evidenceDeleteError = e; }
    ok("executed signature evidence cannot be deleted afterward",
      /field evidence is frozen/i.test(evidenceDeleteError && evidenceDeleteError.message));

    let canonicalArgs = null;
    await executeSpineLease(pool, {
      lease_packet_id: first.packetId,
      company_signer_user_id: companyUserId,
    }, {
      executedLease: {
        verifyExecutedLease: async (_client, args) => {
          canonicalArgs = args;
          return { record_id: crypto.randomUUID(), activation_status: "blocked", idempotent: false };
        },
      },
    });
    const canonicalRoles = canonicalArgs.signers.map((signer) => signer.role).sort();
    ok("canonical execution receives resident, guarantor, and company evidence",
      canonicalRoles.join(",") === "company,guarantor,tenant");
    const canonicalGuarantor = canonicalArgs.signers.find((signer) => signer.role === "guarantor");
    ok("canonical execution records the guarantor's packet-scoped name",
      canonicalGuarantor && canonicalGuarantor.name === first.guarantorName);
    ok("guarantor provenance remains packet-scoped, not a fabricated Person",
      canonicalGuarantor && !canonicalGuarantor.person_id && !!canonicalGuarantor.packet_signer_id);
    const review = await buildReviewDetail(pool, first.applicationId, propertyId);
    ok("Application Records reads both signer states from the packet",
      review.packet.signing_parties.length === 2
        && review.packet.signing_parties.every((signer) => signer.complete));
    const standing = await readLeasingStanding(pool, {
      person_id: first.personId,
      property_id: propertyId,
    });
    ok("Ask Spine's existing leasing standing carries the same signer states",
      standing.lease.signing_parties.length === 2
        && standing.lease.signing_parties.every((signer) => signer.complete));

    const reverse = await makeScenario(2);
    const guarantorFirst = await completeAndSubmit(base, reverse, "guarantor");
    ok("guarantor may sign first without premature resident execution",
      guarantorFirst.submitted.status === 200
        && guarantorFirst.submitted.body.packet.status === "tenant_in_progress");
    ok("the reverse-order receipt waits for the named resident",
      /Resident 2/.test(guarantorFirst.submitted.body.receipt || ""));
    const residentSecond = await completeAndSubmit(base, reverse, "tenant");
    ok("resident signing second completes the resident side",
      residentSecond.submitted.status === 200
        && residentSecond.submitted.body.packet.status === "resident_executed");

    const missing = await makeScenario(3, { omitGuarantorField: true });
    const emptyGuarantorSubmit = await api(base, "POST",
      `/t/lease/${encodeURIComponent(missing.tokens.guarantor)}/submit`,
      { session_id: "session-missing-guarantor" });
    ok("a signer with no required controls cannot submit by absence",
      emptyGuarantorSubmit.status === 409
        && emptyGuarantorSubmit.body.error === "signer_requirements_missing");
    const tenantWithMissingGuarantor = await completeAndSubmit(base, missing, "tenant");
    ok("a missing guarantor signature field does not complete the resident side",
      tenantWithMissingGuarantor.submitted.status === 200
        && tenantWithMissingGuarantor.submitted.body.packet.status === "tenant_in_progress");
    ok("the missing-field receipt still names the outstanding guarantor",
      /Guarantor 3/.test(tenantWithMissingGuarantor.submitted.body.receipt || ""));
    let missingEvidenceError = null;
    try {
      await q("update lease_packets set status='resident_executed',resident_executed_at=now() where id=$1",
        [missing.packetId]);
    } catch (e) { missingEvidenceError = e; }
    ok("the database also treats a missing signer field as missing evidence",
      /no submitted signature for every resident-side signer/i.test(
        missingEvidenceError && missingEvidenceError.message));

    const unsignedSubmit = await makeScenario(4);
    const residentFieldOnly = await api(base, "POST",
      `/t/lease/${encodeURIComponent(unsignedSubmit.tokens.tenant)}/fields/${unsignedSubmit.fields.tenant}/complete`,
      { value: unsignedSubmit.residentName, consent: true, session_id: "session-resident-field-only" });
    const guarantorAfterFieldOnly = await completeAndSubmit(base, unsignedSubmit, "guarantor");
    ok("a completed field without final signer submission does not advance the packet",
      residentFieldOnly.status === 200
        && guarantorAfterFieldOnly.submitted.body.packet.status === "tenant_in_progress");
    ok("the receipt still waits for the signer who has not submitted",
      /Resident 4/.test(guarantorAfterFieldOnly.submitted.body.receipt || ""));
    const residentFinalSubmit = await api(base, "POST",
      `/t/lease/${encodeURIComponent(unsignedSubmit.tokens.tenant)}/submit`,
      { session_id: "session-resident-final" });
    ok("final submission after the recorded signature completes the resident side",
      residentFinalSubmit.status === 200
        && residentFinalSubmit.body.packet.status === "resident_executed");
    ok("only tenant submission satisfies and completes terms review",
      satisfiedCalls === 4 && completedCalls === 4,
      `satisfied=${satisfiedCalls}, completed=${completedCalls}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  failures.forEach((label) => console.log("  failed: " + label));
  const code = receipt.complete({
    harness: __filename,
    passed,
    failed,
    expectedAtLeast: 40,
  });
  await pool.end();
  process.exit(code);
})().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try { await pool.end(); } catch (_) {}
  process.exit(receipt.died(__filename, error, passed + failed));
});
