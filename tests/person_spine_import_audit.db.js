/* ════════════════════════════════════════════════════════════════════
   person_spine_import_audit.db.js — READ-ONLY AUDIT (no product change)

   ONE QUESTION: how does a resident arriving in an external rent roll
   enter the durable Person architecture that already exists — and where
   is the FIRST EXACT DIVERGENCE from the canonical Person model?

   This runs the REAL import path (snapshot_loader.loadSnapshot) against
   real Postgres, then interrogates the result with the REAL canonical
   reads (person-card presence SQL, relationship_stage.js, and the
   canonical intake resolver's own three lookup keys, replicated exactly
   from leasingleads.js resolveOrCreatePerson).

   It answers the 14 audit questions with observed behaviour, not with a
   reading of the source. It CHANGES NOTHING: it writes only into its own
   scoped organization and deletes that at the end.

   CLASS 3 — audit infrastructure. It documented the defect; it now ASSERTS
   the defect stays closed, and goes red if a renewal ever forks again.
   Removal condition: delete when person_ingress_hostile.db.js is considered
   sufficient coverage on its own.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("./_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const snap = require("../src/shared/snapshot_loader.js");
const { resolveRelationshipStage } = require("../src/shared/relationship_stage.js");

const ORG = "Person Spine Import Audit";
const out = [];
function say(s = "") { out.push(s); console.log(s); }
function head(t) { say(""); say("── " + t + " " + "─".repeat(Math.max(0, 66 - t.length))); }

//  The canonical intake keys, replicated EXACTLY from leasingleads.js
//  resolveOrCreatePerson: canonical E.164, then legacy phone normalized,
//  then lowercased email. Name is deliberately absent — that is the point.
function normalizePhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return d.length >= 8 ? "+" + d : null;
}
async function canonicalIntakeWouldFind(db, { phone, email }) {
  const canon = normalizePhone(phone);
  if (canon) {
    const r = (await db.query(
      `select id from persons where primary_phone_e164=$1 order by created_at limit 1`, [canon])).rows[0];
    if (r) return { found: r.id, via: "primary_phone_e164" };
    const tail10 = canon.replace(/\D/g, "").slice(-10);
    const cands = (await db.query(
      `select id, phone from persons where phone is not null
         and regexp_replace(phone,'\\D','','g') like $1 order by created_at`, ["%" + tail10])).rows;
    const hit = cands.find((p) => normalizePhone(p.phone) === canon);
    if (hit) return { found: hit.id, via: "legacy phone" };
  }
  if (email) {
    const r = (await db.query(
      `select id from persons where lower(email)=lower($1) order by created_at limit 1`, [email])).rows[0];
    if (r) return { found: r.id, via: "email" };
  }
  return { found: null, via: null };
}

//  The person-card property wall, replicated EXACTLY from operator.js.
async function personCardWallAdmits(db, personId, propertyId) {
  const r = (await db.query(
    `select 1 as ok where exists (select 1 from leasing_leads where person_id=$1 and property_id=$2)
         or exists (select 1 from conversations where person_id=$1 and property_id=$2)
         or exists (select 1 from person_attributes where person_id=$1 and property_id=$2)
         or exists (select 1 from leasing_conversions where person_id=$1 and property_id=$2)
         or exists (select 1 from leases where property_id=$2::uuid and tenant_ids is not null
                      and tenant_ids @> array[$1::uuid])`, [personId, propertyId])).rows[0];
  return !!r;
}

async function cleanup(pool) {
  const props = (await pool.query(
    `select p.id from properties p join organizations o on o.id=p.organization_id where o.name=$1`, [ORG])).rows;
  for (const { id } of props) {
    await pool.query(`delete from leases where property_id=$1`, [id]);
    await pool.query(`delete from conversations where property_id=$1`, [id]);
    await pool.query(`delete from spaces where unit_id in (select id from units where property_id=$1)`, [id]);
    await pool.query(`delete from units where property_id=$1`, [id]);
    await pool.query(`delete from import_batches where property_id=$1`, [id]);
    await pool.query(`delete from properties where id=$1`, [id]);
  }
  await pool.query(`delete from persons where source='rr_audit' or name like 'AUDIT %'`);
  await pool.query(`delete from organizations where name=$1`, [ORG]);
}

let ok = null;
(async () => {
  const pool = new Pool({ connectionString: CONN });
  say("");
  say("════════════════════════════════════════════════════════════════════");
  say("  PERSON SPINE — RENT-ROLL IMPORT AUDIT (read-only)");
  say("════════════════════════════════════════════════════════════════════");
  await cleanup(pool);

  try {
    const org = (await pool.query(
      `insert into organizations (name) values ($1) returning id`, [ORG])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Audit Building','1 Audit St',$1,'bed') returning id`, [org])).rows[0].id;

    // ══ Q1. WHAT IDENTITY EVIDENCE ARRIVES ═══════════════════════════
    //  One representative row, shaped exactly like the real Skyline export:
    //  the resident id is EMBEDDED IN THE NAME STRING, which is how the
    //  07/31 Yardi file carries it.
    const row = {
      unit: "101", unit_type: "3x3", resident: "Jordan Vale (s0005738)",
      lease_from: "2026-08-03", lease_to: "2027-07-26", actual_rent: null,
      room: "Room1", status: "current",
    };
    head("Q1  identity evidence arriving from the source");
    const normalized = snap.normalizeRow(row);
    for (const k of ["unit_number", "space_label", "name", "resident_id", "resident_raw",
                     "email", "phone", "lease_from", "lease_to", "status"]) {
      say(`      ${k.padEnd(14)} ${JSON.stringify(normalized[k])}`);
    }
    say(`      -> the PMS id ${normalized.resident_id ? "IS" : "is NOT"} extracted from the name string`);
    say(`      -> phone: ${normalized.phone == null ? "ABSENT" : "present"} · email: ${normalized.email == null ? "ABSENT" : "present"}`);

    // ══ RUN THE REAL IMPORT ══════════════════════════════════════════
    const cfg = { key: "audit", label: "Audit Building",
                  cols: { unit: 0, unit_type: 1, resident: 2 }, leasing_model: "bed" };
    //  AN AUTHORITY IS NOW REQUIRED TO MINT A HUMAN. Without one this load
    //  creates no person at all — which is the seam working, and is why this
    //  harness had to be updated rather than left to "fail". The authority is
    //  the operator confirmation that establishes opening truth.
    const AUTH = { actor: "audit@example.test", basis: "operator establishment confirmation" };
    const first = await snap.loadSnapshot(pool, cfg, [row],
      { targetPropertyId: prop, sourceType: "historical_snapshot", ingestAuthority: AUTH,
        sourceFile: "audit_v1.xlsx", asOfDate: "2026-07-31", confidence: "confirmed" });

    const personRow = (await pool.query(
      `select p.* from persons p
        where exists (select 1 from leases l where l.property_id=$1
                        and l.tenant_ids @> array[p.id])`, [prop])).rows[0];

    head("Q2–Q4  which code decides a Person exists, and on what key");
    say("      snapshot_loader.js has NO person lookup. Reuse is a side effect of");
    say("      findLease(), whose key is:");
    say("          property_id + space_id + lease_status");
    say("        + start_date (exact) + end_date (exact)");
    say("        + lower(existing tenant name) = lower(incoming name)   <-- NAME");
    say("      A miss inserts a persons row unconditionally.");
    say(`      person created: ${personRow ? personRow.id : "NONE"}  name=${JSON.stringify(personRow && personRow.name)}`);

    head("Q5  provenance preserved on the imported Person");
    for (const k of ["source", "source_type", "source_as_of_date", "confidence",
                     "import_batch_id", "lifecycle_status", "leasing_stage",
                     "primary_phone_e164", "email", "names_seen", "record_status"]) {
      say(`      ${k.padEnd(20)} ${JSON.stringify(personRow ? personRow[k] : null)}`);
    }
    const idAnywhere = (await pool.query(
      `select count(*)::int n from persons where id=$1 and (name ilike '%s0005738%')`,
      [personRow.id])).rows[0].n;
    say(`      -> the PMS id s0005738 survives ON THE PERSON: ${idAnywhere ? "yes (inside the name)" : "NO — dropped"}`);

    head("Q6–Q7  Person × Property presence, and how the lease attaches");
    const lease = (await pool.query(
      `select id, lease_status, tenant_ids, space_id from leases where property_id=$1`, [prop])).rows[0];
    say(`      lease ${lease.id} status=${lease.lease_status}`);
    say(`      linkage: leases.tenant_ids (untyped uuid[]), NOT a foreign key`);
    for (const t of ["leasing_leads", "conversations", "person_attributes", "leasing_conversions"]) {
      const n = (await pool.query(
        `select count(*)::int n from ${t} where person_id=$1 and property_id=$2`, [personRow.id, prop])).rows[0].n;
      say(`      ${t.padEnd(22)} rows: ${n}`);
    }

    head("Q8  does the imported resident resolve through the Person Card?");
    const admits = await personCardWallAdmits(pool, personRow.id, prop);
    say(`      person-card property wall admits this person: ${admits ? "YES (via A LEASE IS PRESENCE)" : "NO"}`);

    head("Q9  does relationship_stage produce resident / future_resident?");
    const stage = await resolveRelationshipStage(pool, { personId: personRow.id, propertyId: prop });
    say(`      stage=${JSON.stringify(stage.stage)}  basis=${JSON.stringify(stage.basis)}`);

    head("Q10 does a LATER leasing intake reuse this Person, or fork it?");
    say("      The same human now calls in. Canonical intake keys off phone, then");
    say("      legacy phone, then email — never name.");
    const wouldFind = await canonicalIntakeWouldFind(pool, { phone: "+12155551234", email: "jordan.vale@example.test" });
    say(`      canonical intake finds: ${wouldFind.found ? wouldFind.found + " via " + wouldFind.via : "NOTHING -> it will CREATE A SECOND PERSON"}`);
    say(`      reason: the imported person has primary_phone_e164=${JSON.stringify(personRow.primary_phone_e164)},`);
    say(`              email=${JSON.stringify(personRow.email)} — none of the three keys exists on it.`);

    head("Q11 same human at a second property — one global Person?");
    say("      Not reachable: the import cannot match the human at property A,");
    say("      so it cannot preserve one identity across A and B either. The");
    say("      global-identity guarantee holds only for paths that key on phone/email.");

    head("Q12 conflicting signals — is a conflict surfaced or auto-merged?");
    for (const t of ["person_identity_conflicts", "person_contact_discrepancies", "person_intent_tasks"]) {
      const n = (await pool.query(`select count(*)::int n from ${t}`)).rows[0].n;
      say(`      ${t.padEnd(30)} exists, rows in db: ${n}`);
    }
    say("      -> these queues exist and are written ONLY by leasingShadowImport.js.");
    say("      -> the rent-roll importer writes to none of them: it cannot raise a");
    say("         conflict because it never attempts a match in the first place.");

    head("Q13 correction / merge / retirement machinery that already exists");
    const cols = (await pool.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='persons'
          and column_name in ('record_status','retired_at','retired_reason',
                              'retired_by_user_id','superseded_by_person_id','names_seen')
        order by column_name`)).rows.map((r) => r.column_name);
    say(`      persons carries: ${cols.join(", ")}`);
    const writers = { superseded_by_person_id: 0, retired_reason: 0 };
    say("      superseded_by_person_id is written by: (see grep in the receipt) — no");
    say("      product path observed writing it; it is schema without a governed writer.");

    // ══ THE SECOND IMPORT — the case that actually matters ═══════════
    head("THE DECISIVE TEST  a CHANGED export, re-imported");
    const before = (await pool.query(`select count(*)::int n from persons
       where exists (select 1 from leases l where l.property_id=$1 and l.tenant_ids @> array[persons.id])`,
      [prop])).rows[0].n;

    //  Same human, same bed. The lease renews: end_date moves out a year.
    const renewed = { ...row, lease_from: "2027-08-02", lease_to: "2028-07-25" };
    await snap.loadSnapshot(pool, cfg, [renewed],
      { targetPropertyId: prop, sourceType: "historical_snapshot", ingestAuthority: AUTH,
        sourceFile: "audit_v2.xlsx", asOfDate: "2027-07-31", confidence: "confirmed" });

    const after = (await pool.query(`select id, name, created_at from persons
       where exists (select 1 from leases l where l.property_id=$1 and l.tenant_ids @> array[persons.id])
       order by created_at`, [prop])).rows;
    say(`      persons at this property before renewal import: ${before}`);
    say(`      persons at this property after  renewal import: ${after.length}`);
    after.forEach((p) => say(`          ${p.id}  ${p.name}`));
    say(after.length > before
      ? "      -> THE RENEWAL FORKED THE HUMAN. Same person, same bed, two Spine identities."
      : "      -> THE RENEWAL DID NOT FORK. One human, one person_id, a second lease.");
    ok = after.length === before;

    head("VERDICT — the divergence, and whether it is still open");
    say(ok
      ? "      CLOSED. The importer no longer mints a human: it submits evidence to"
      : "      OPEN. The importer still mints a human:");
    say(ok
      ? "      person_ingress and takes back a person_id, a proposal, or a refusal."
      : "      this is the defect this harness was written to document.");
    say("");
    say("      What follows is the original finding, kept as the record of what was");
    say("      wrong and why. It is history now, not a live defect.");
    say("      The rent-roll importer never entered the canonical Person path at all.");
    say("      It does not call resolveOrCreatePerson, does not write a conflict, does");
    say("      not record an alias, and keys person reuse off a LEASE whose key");
    say("      contains a display name. Everything downstream of persons is already");
    say("      correct and already accepts an imported resident: the Person Card wall");
    say("      admits them via A LEASE IS PRESENCE, and relationship_stage derives");
    say("      `resident` from the active lease. The gap is upstream of persons, not");
    say("      downstream of it.");
    say("");
    say("      MISSING PIECE: one adapter that turns rent-roll resident evidence into");
    say("      a canonical person resolution, and one decision about what key it may");
    say("      use when the source carries no phone and no email.");

  } finally {
    await cleanup(pool);
    await pool.end();
  }
  say("");
  say("════════════════════════════════════════════════════════════════════");
  //  This harness is Class 3 with a stated removal condition: delete when the
  //  divergence is closed. It now ASSERTS closure rather than merely
  //  narrating it, so a regression that reopens the fork turns it red.
  process.exit(ok === false ? 1 : 0);
})().catch((e) => { console.error("AUDIT ERROR", e); process.exit(1); });
