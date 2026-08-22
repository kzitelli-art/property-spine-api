/* ════════════════════════════════════════════════════════════════════
   governing_lease_execution.db.js — A PLACEHOLDER CANNOT BE EXECUTED.
   REAL POSTGRES.

   Migration 034 built the resident-signing mechanism and was honest about
   why it was not a lease: `is_placeholder` is TRUE "until a real lease
   template fills the body", and generation "refuses to pretend
   otherwise". Migration 184 keeps that honesty and gives it teeth — the
   database now refuses to execute a packet that has no governing
   instrument, instead of relying on a caller to remember. Migration 191
   also requires the retained source and exact terms/package hashes.

   ── WHAT IS PROVEN ──────────────────────────────────────────────────
   · a placeholder cannot reach resident_executed or executed;
   · an instrument with no retained source and complete package cannot be signed — a
     signature is a signature ON something, and "the packet" is not
     specific enough when a packet is versioned;
   · the company cannot sign before the resident. That order is the
     business's wall, not a UI concern, so it is enforced where a UI
     cannot route around it;
   · a company signer can now EXIST at all (034 checked
     signer_role in ('tenant') and no company row was insertable);
   · a real instrument executes cleanly, resident then company.

   WHAT IT DOES NOT PROVE, DELIBERATELY: that the captured evidence is
   legally sufficient. 034's own note — "audit, not legal proof, see
   counsel note" — is a legal/product ruling and is recorded as open
   ruling R1 in THREAD_HANDOFF, not answered here.

   ISOLATION: HARNESS_DATABASE_URL, refused if it matches DATABASE_URL.
   Requires migrations 034, 184, and 191.

   Run:
     HARNESS_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/spine_proof \
       node tests/governing_lease_execution.db.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: CONN });

let pass = 0, fail = 0; const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log("  ok    " + l); }
  else { fail++; failures.push(l); console.log("  FAIL  " + l + (d ? "\n          " + d : "")); }
};
async function refuses(label, sql, params) {
  try { await pool.query(sql, params); ok(label, false, "ACCEPTED — it should have refused"); }
  catch (e) { ok(label, true); return e.message; }
}
async function accepts(label, sql, params) {
  try { await pool.query(sql, params); ok(label, true); }
  catch (e) { ok(label, false, e.message.slice(0, 110)); }
}

(async () => {
  const q = (s, p) => pool.query(s, p);
  const prop = (await q("insert into properties (name) values ('Execution Proof') returning id")).rows[0].id;
  const unit = (await q("insert into units (property_id, unit_number) values ($1,'3B') returning id", [prop])).rows[0].id;
  const person = (await q("insert into persons (name) values ('Jane Smith') returning id")).rows[0].id;
  const signer = (await q("insert into users (name, role) values ('Authorised Signer','property_manager') returning id")).rows[0].id;
  const sourceBytes = Buffer.from("%PDF-1.7\nretained governing lease proof");
  const sourceHash = require("crypto").createHash("sha256").update(sourceBytes).digest("hex");
  const source = (await q(
    `insert into source_artifacts
       (scope_type,scope_id,original_filename,mime_type,artifact_kind,byte_size,sha256,
        content,stored_at,uploaded_by_user_id,uploaded_by_basis)
     values ('property',$1,'lease.pdf','application/pdf','lease_template',$2,$3,$4,now(),$5,'proof')
     returning id`, [prop, sourceBytes.length, sourceHash, sourceBytes, signer])).rows[0].id;
  const appId = (await q(
    `insert into lease_applications (property_id, unit_id, person_id, applicant_name, status)
     values ($1,$2,$3,'Jane Smith','lease_ready') returning id`, [prop, unit, person])).rows[0].id;

  const mkPacket = async (version, placeholder, completePackage) => (await q(
    `insert into lease_packets (property_id, application_id, unit_id, version, status, is_placeholder,
                                instrument_body_sha256, instrument_form_code,
                                instrument_source_artifact_id, instrument_terms_sha256,
                                instrument_package_sha256, instrument_manifest)
     values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11::jsonb) returning id`,
    [prop, appId, unit, version, placeholder, completePackage ? sourceHash : null,
     completePackage ? "SKYLINE_RESIDENTIAL" : null, completePackage ? source : null,
     completePackage ? "b".repeat(64) : null, completePackage ? "c".repeat(64) : null,
     completePackage ? JSON.stringify({ source_sha256: sourceHash, terms_sha256: "b".repeat(64) }) : null])).rows[0].id;

  console.log("\n── 1 · A PLACEHOLDER CANNOT BE EXECUTED ───────────────────────");
  const ph = await mkPacket(1, true, null);
  await q("update lease_packets set status='sent' where id=$1", [ph]);
  const m1 = await refuses("a placeholder cannot reach resident_executed",
    "update lease_packets set status='resident_executed', resident_executed_at=now() where id=$1", [ph]);
  ok("…and the refusal says why", /placeholder/i.test(m1 || ""), m1);
  await refuses("a placeholder cannot reach executed",
    "update lease_packets set status='executed' where id=$1", [ph]);
  await accepts("…but it can still be voided (034 lifecycle intact)",
    "update lease_packets set status='voided', voided_at=now() where id=$1", [ph]);

  console.log("\n── 2 · A SIGNATURE IS A SIGNATURE *ON* SOMETHING ──────────────");
  const noHash = await mkPacket(2, false, null);
  await q("update lease_packets set status='sent' where id=$1", [noHash]);
  const m2 = await refuses("a real body with no instrument hash cannot be executed",
    "update lease_packets set status='resident_executed', resident_executed_at=now() where id=$1", [noHash]);
  ok("…named as an incomplete retained lease package", /complete retained lease package/i.test(m2 || ""), m2);

  console.log("\n── 3 · THE RESIDENT SIGNS FIRST ───────────────────────────────");
  const real = await mkPacket(3, false, true);
  const packetSigner = (await q(
    `insert into lease_packet_signers (lease_packet_id,signer_role,display_name,person_id)
     values ($1,'tenant','Jane Smith',$2) returning id`, [real, person])).rows[0].id;
  await q(
    `insert into lease_packet_fields
       (lease_packet_id,field_key,section_key,label,field_type,signer_role,required,completed)
     values ($1,'tenant_sig','execution','Resident signature','signature','tenant',true,false),
            ($1,'company_sig','execution','Company signature','signature','company',false,false)`,
    [real]);
  await q("update lease_packets set status='sent' where id=$1", [real]);
  const m3 = await refuses("the company cannot sign before the resident",
    "update lease_packets set status='executed', company_executed_at=now() where id=$1", [real]);
  ok("…and the refusal names the order", /resident/i.test(m3 || ""), m3);

  console.log("\n── 4 · A REAL INSTRUMENT EXECUTES, IN ORDER ───────────────────");
  await accepts("the tenant signature field accepts one-way evidence",
    `update lease_packet_fields
        set completed=true,completed_at=now(),signed_by_person_id=$2,
            signed_by_packet_signer_id=$3,field_value='Jane Smith'
      where lease_packet_id=$1 and field_key='tenant_sig'`, [real, person, packetSigner]);
  await accepts("the resident's final submission is recorded",
    "update lease_packet_signers set submitted_at=now(),updated_at=now() where id=$1",
    [packetSigner]);
  await accepts("resident executes the governing instrument",
    "update lease_packets set status='resident_executed', resident_executed_at=now() where id=$1", [real]);
  await accepts("the COMPANY signature field now completes",
    `update lease_packet_fields
        set completed=true, completed_at=now(), signed_by_user_id=$2
      where lease_packet_id=$1 and field_key='company_sig'`, [real, signer]);
  await accepts("then the company executes it",
    "update lease_packets set status='executed', company_executed_at=now() where id=$1", [real]);
  const done = (await q("select status, resident_executed_at, company_executed_at from lease_packets where id=$1", [real])).rows[0];
  ok("both instants are recorded, not inferred",
     !!done.resident_executed_at && !!done.company_executed_at && done.status === "executed");

  console.log("\n── 5 · A COMPANY SIGNER CAN EXIST AT ALL (034 forbade it) ─────");
  const roleProbe = await mkPacket(4, false, true);
  await refuses("an unknown signer role is still refused",
    `insert into lease_packet_fields (lease_packet_id, field_key, section_key, label, field_type, signer_role)
     values ($1,'other_sig','execution','Somebody','signature','notary')`, [roleProbe]);
  const who = (await q(
    "select signer_role, signed_by_user_id, signed_by_person_id from lease_packet_fields where lease_packet_id=$1 order by field_key", [real])).rows;
  ok("the company signature names a durable user, not a typed name",
     who.find((r) => r.signer_role === "company").signed_by_user_id === signer);

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(`  ${pass} passed · ${fail} failed`);
  if (fail) failures.forEach((f) => console.log("   ✗ " + f));
  console.log("════════════════════════════════════════════════════════════════");
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("DIED:", e && e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
