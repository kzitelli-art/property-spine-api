#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  full_lifecycle_arc.js — ONE new inquiry, all the way to a lease.
//
//  inquiry → tour booked → tour given → application sent → application
//  filled → approved → terms → executed lease recorded → term confirmed
//  → A LEASE EXISTS.
//
//  Every step goes through the CANONICAL door the product itself uses.
//  Nothing is hand-injected: no manual classification row, no forced
//  status, no fabricated dispatch. The one in-process call is
//  enrollInternalQa, which is the SAME canonical function the comms
//  boundary uses — there is still no session-authed enroll route.
//
//  ── WHY THE PREFLIGHT IS LOUD ──────────────────────────────────────
//  Two of this chain's gates refuse OPAQUELY. `confirm-term` returns one
//  undifferentiated 403 for eight different conditions, and a blocked
//  executed-lease admission silently leaves the application one status
//  short of eligible. A run that dies at step 10 on a missing env var has
//  already written nine steps of real data. So every preconditionis
//  checked FIRST, and the arc refuses to start if any is missing.
//
//  ── THE ONE STEP THAT NEEDS A REAL PHONE ───────────────────────────
//  An application link that was never sent CANNOT be submitted — the
//  product refuses, correctly. So step 6 must genuinely dispatch. Point
//  ARC_PHONE at a handset you control. Do NOT attest a manual send that
//  did not happen; that is faking a dispatch.
//
//  CLASS 3 — test/demo infrastructure.
//
//  RUN:
//    DATABASE_URL=…  OPERATOR_KEY=…  LEASING_INTAKE_SECRET=…  \
//    STAFF_SESSION=…  ARC_PHONE=+1…  node tests/arcs/full_lifecycle_arc.js
//
//  STAFF_SESSION must belong to a user whose property_team_assignments
//  role_title is literally 'leasing_manager' or 'property_manager' —
//  resolveSendActionBasis matches that free-text field, so an account
//  titled 'Admin' is refused however senior it is. Mint one with
//  establish_qa_staff_session.js, but note it picks the FIRST leasing
//  user, which may be the wrong one.
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");

//  ⚠ NO PRODUCTION DEFAULT. This line used to fall back to the live
//  production URL, so running this file with no environment set drove the
//  whole lease lifecycle against real production data — silently. Recorded
//  as defect #4 in docs/CURRENT_STATE.md. It now refuses instead: point it
//  somewhere deliberately, or it does not run.
if (!process.env.ARC_BASE) {
  console.error("REFUSED: set ARC_BASE explicitly (e.g. http://localhost:3000).");
  console.error("There is deliberately no default — this harness drives a full lease lifecycle.");
  process.exit(2);
}
const API = process.env.ARC_BASE.replace(/\/+$/, "");
const PROPERTY_ID = process.env.ARC_PROPERTY_ID || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const PHONE = process.env.ARC_PHONE || "";
const NAME = process.env.ARC_NAME || `Arc Prospect ${String(Date.now()).slice(-6)}`;
const STAFF_SESSION = process.env.STAFF_SESSION || "";
const OPERATOR_KEY = process.env.OPERATOR_KEY || "";
const INTAKE_SECRET = process.env.LEASING_INTAKE_SECRET || "";
const QA_ACTOR = process.env.ARC_ACTOR_USER_ID || "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";
const SEND_MODE = (process.env.ARC_SEND || "provider").toLowerCase(); // provider | prepare
const RESUME = process.env.ARC_RESUME_CONVERSION || "";               // pick up the back half
const RENT = Number(process.env.ARC_RENT || 1850);

const H = {
  "content-type": "application/json",
  "x-staff-session": STAFF_SESSION,
  "x-operator-key": OPERATOR_KEY,
  "x-intake-secret": INTAKE_SECRET,
};

let step = 0;
async function call(method, p, body) {
  const r = await fetch(API + p, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  return { status: r.status, json: j };
}
const good = (r) => r.status >= 200 && r.status < 300;
function halt(label, r, note) {
  console.error(`\n✗ HALTED at [${step}] ${label}`);
  console.error(`  HTTP ${r.status}`);
  console.error(`  ${JSON.stringify(r.json)}`);
  if (note) console.error(`\n  ${note}`);
  console.error(`\n  Steps before this one DID write. Nothing after ran.`);
  process.exit(1);
}
function announce(label) { step++; console.log(`\n[${step}] ${label}`); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // ══ PREFLIGHT — everything checked before anything is written ══════
  console.log("═══ FULL LIFECYCLE ARC ═══");
  console.log(`base=${API}`);
  console.log(`property=${PROPERTY_ID}`);
  console.log(`prospect="${NAME}"  phone=${PHONE || "(unset)"}`);
  console.log(`send mode=${SEND_MODE}\n── preflight ──`);

  // ══ RESUME ════════════════════════════════════════════════════════
  //  A real applicant submitted the form on their own phone. Pick up the
  //  back half from the conversion, deriving everything from the record
  //  rather than re-asking for it.
  if (RESUME) {
    if (!process.env.DATABASE_URL || !STAFF_SESSION) {
      console.error("\n✗ resume needs DATABASE_URL and STAFF_SESSION."); await pool.end(); process.exit(1);
    }
    const app = (await pool.query(
      `select la.id, la.status, la.person_id, la.unit_id, la.applicant_name,
              s.id space_id, u.unit_number
         from lease_applications la
         left join units u on u.id = la.unit_id
         left join spaces s on s.unit_id = u.id
        where la.conversion_id = $1
          and la.status not in ('denied','declined','withdrawn')
        order by la.created_at desc limit 1`, [RESUME])).rows[0];
    if (!app) {
      console.error(`\n✗ No live application on conversion ${RESUME} yet.`);
      console.error(`  The applicant has not submitted the form. Nothing to resume.`);
      await pool.end(); process.exit(1);
    }
    console.log(`  resuming conversion ${RESUME}`);
    console.log(`  application ${app.id}  status=${app.status}  applicant="${app.applicant_name}"`);
    console.log(`  unit ${app.unit_number}  space=${app.space_id}\n`);
    if (!app.space_id) {
      console.error("✗ the application has no resolvable space — executed-lease intake requires premises.");
      await pool.end(); process.exit(1);
    }
    await backHalf({
      application_id: app.id, space_id: app.space_id, unit_number: app.unit_number,
      person_id: app.person_id, applicant_name: app.applicant_name || NAME,
    });
    await pool.end();
    return;
  }

  const missing = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!STAFF_SESSION) missing.push("STAFF_SESSION (mint with establish_qa_staff_session.js)");
  if (!OPERATOR_KEY) missing.push("OPERATOR_KEY (Render env — the legacy booking door still needs it)");
  if (!INTAKE_SECRET) missing.push("LEASING_INTAKE_SECRET (Render env)");
  if (!PHONE) missing.push("ARC_PHONE (a handset you control — the link must genuinely send)");
  if (missing.length) {
    console.error("\n✗ Cannot start. Missing:");
    for (const m of missing) console.error(`    ${m}`);
    console.error("\n  Nothing was written.");
    await pool.end(); process.exit(1);
  }

  // the API's own env, read through its behaviour rather than assumed
  const health = await call("GET", "/health");
  console.log(`  api reachable: ${good(health) ? "yes" : "NO"}`);
  if (!good(health)) { console.error("  API is not answering. Stopping."); await pool.end(); process.exit(1); }

  const slot = (await pool.query(
    `select id, starts_at from tour_availability
      where property_id=$1 and status='open' and starts_at > now()
      order by starts_at limit 1`, [PROPERTY_ID])).rows[0];
  console.log(`  open future tour slot: ${slot ? slot.id : "NONE"}`);
  if (!slot) { console.error("  No open slot to book. Stopping before any write."); await pool.end(); process.exit(1); }

  // a vacant unit with a space and NO operative lease — hollow 'pending'
  // leases are a known recurring class and each one silently freezes
  // confirm-term on its unit four layers from any error message.
  //  "No operative lease" is necessary but NOT sufficient. The availability
  //  projection has its own idea of leaseable, and a unit whose
  //  occupancy_status is 'unknown' is refused at prepare with
  //  not_leaseable — after a lease-free unit is chosen and five steps have
  //  already written. So gather CANDIDATES, vacant first, and let the route
  //  be the authority on offerability rather than guessing it here.
  const units = (await pool.query(
    `select u.id unit_id, u.unit_number, u.occupancy_status, s.id space_id
       from units u
       join spaces s on s.unit_id = u.id
      where u.property_id = $1
        and coalesce(u.occupancy_status,'') <> 'occupied'
        and not exists (
          select 1 from leases l
           where l.space_id = s.id
             and l.lease_status not in
                 ('cancelled','terminated','rescinded','void','expired','superseded'))
      order by (u.occupancy_status = 'vacant') desc, u.unit_number
      limit 8`, [PROPERTY_ID])).rows;
  console.log(`  candidate units (vacant first): ${units.map((u) => `${u.unit_number}(${u.occupancy_status || "-"})`).join(", ") || "NONE"}`);
  if (!units.length) {
    console.error("  Every non-occupied unit already carries an operative lease — confirm-term would block.");
    console.error("  Check for hollow 'pending' leases (tenants=0, application_id null).");
    await pool.end(); process.exit(1);
  }
  let unit = units[0];

  const dupe = (await pool.query(`select id, name from persons where phone = $1`, [PHONE])).rows;
  console.log(`  existing persons on this phone: ${dupe.length}${dupe.length ? ` (${dupe.map(d=>d.name).join(", ")})` : ""}`);
  if (dupe.length) {
    console.log("  NOTE: phone is the global dedup key — intake will REUSE that person,");
    console.log("        and a live application on them will refuse the new intent.");
  }
  console.log("  preflight OK\n");

  // ══ 1 · INQUIRY ═══════════════════════════════════════════════════
  announce("inquiry → POST /leasing/intake");
  const intake = await call("POST", "/leasing/intake", {
    property_id: PROPERTY_ID, phone: PHONE, name: NAME,
    source: "full_lifecycle_arc", attempt_sms: false,
  });
  if (!good(intake)) halt("intake", intake,
    "503 = LEASING_INTAKE_SECRET or LEASING_INTAKE_PROPERTY_IDS unset in Render. 403 = this property not bound to the credential.");
  const { person_id, lead_id } = intake.json;
  console.log(`  ✓ person=${person_id}  lead=${lead_id}  new_person=${intake.json.new_person}`);

  // ══ 2 · ENROL (classification + consent) ══════════════════════════
  announce("enrol → enrollInternalQa() [canonical fn; no route exists yet]");
  // The REAL boundary, not a copy. tests/comm_boundary_harness.js used to be
  // a 647-line duplicate of it and had already drifted — it still carried the
  // retired internal_qa_autonomous mode and the class checks that were removed
  // on 2026-07-26. A stale duplicate of the module that decides who may be
  // texted is worse than no harness at all, so it is gone.
  const boundary = require(path.join(__dirname, "..", "..", "src", "comms", "communications_boundary.js"))({ pool });
  const enroll = await boundary.enrollInternalQa({
    person_id, property_id: PROPERTY_ID, actor_user_id: QA_ACTOR, reason: "full_lifecycle_arc",
  });
  console.log(`  ✓ ${enroll.receipt || "internal_qa + opted_in"}`);

  // ══ 3 · BOOK THE TOUR ═════════════════════════════════════════════
  announce(`book → POST /leasing/slots/${slot.id}/book`);
  const book = await call("POST", `/leasing/slots/${slot.id}/book`, { lead_id });
  if (!good(book)) halt("book", book, "401 = OPERATOR_KEY wrong. This legacy door does not accept a staff session.");
  const tour_id = book.json.tour_id;
  console.log(`  ✓ tour=${tour_id}  (this one carries a real slot_id)`);

  // ══ 4 · GIVE THE TOUR ═════════════════════════════════════════════
  announce("complete → POST /operator/leasing/tours/:id/complete");
  const complete = await call("POST", `/operator/leasing/tours/${tour_id}/complete`, {
    feedback: { disposition: "start_application", notes: "full lifecycle arc — tour given." },
  });
  if (!good(complete)) halt("complete tour", complete);
  const conversion_id = complete.json.conversion_id;
  if (!conversion_id) halt("complete tour", complete, "No conversion_id — the rail did not open, and the application intent needs it.");
  console.log(`  ✓ conversion=${conversion_id}`);

  // ══ 5 · INTENT ════════════════════════════════════════════════════
  announce("intent → POST /operator/leasing/application-intent");
  const intent = await call("POST", "/operator/leasing/application-intent", {
    conversion_id, idempotency_key: `arc-${conversion_id}`,
  });
  if (!good(intent)) halt("application intent", intent);
  const prepare_obligation_id = intent.json.prepare_obligation_id;
  console.log(`  ✓ intent=${intent.json.intent_id}  prepare=${prepare_obligation_id}`);

  // ══ 6 · SEND THE APPLICATION ══════════════════════════════════════
  const sendPath = SEND_MODE === "prepare"
    ? "/operator/leasing/application-invitations"
    : "/operator/leasing/application-invitations/send";
  announce(`send → POST ${sendPath}${SEND_MODE === "provider" ? "  (this really texts)" : "  (NO text)"}`);
  //  Try candidates until one is offerable. A 409 not_leaseable is the
  //  availability projection refusing THIS unit, not a failure of the arc —
  //  any other status is a real stop.
  let sent = null;
  for (const cand of units) {
    const r = await call("POST", sendPath, {
      prepare_obligation_id, unit_id: cand.unit_id,
      message_prefix: "Your application for the apartment you toured:",
    });
    if (good(r)) { unit = cand; sent = r; break; }
    const notLeaseable = r.status === 409 && /not_leaseable|no longer offerable/i.test(JSON.stringify(r.json));
    console.log(`    unit ${cand.unit_number} refused: ${r.status} ${JSON.stringify(r.json)}`);
    if (!notLeaseable) halt("send application", r,
      "403 owner/covering role = STAFF_SESSION's role_title is not literally 'leasing_manager'/'property_manager'.");
  }
  if (!sent) halt("send application",
    { status: 409, json: { error: "no candidate unit was offerable" } },
    "Every lease-free unit was refused by the availability projection. Check occupancy_status — 'unknown' is not leaseable.");
  console.log(`  using unit ${unit.unit_number}`);
  console.log(`  ✓ invitation=${sent.json.invitation_id}`);
  if (sent.json.link) console.log(`    link: ${sent.json.link}`);

  // The PROVIDER SEND route returns no raw token — by design. The token is
  // hashed at rest and exists in clear only inside the message that was sent.
  // So in provider mode the arc CANNOT submit on the applicant's behalf, and
  // should not want to: a real person is holding the link. Stop here and wait.
  if (SEND_MODE === "provider") {
    console.log(`\n═══ HANDED OFF TO THE APPLICANT ═══`);
    console.log(`  A real text has been dispatched. The arc does not fill in the form —`);
    console.log(`  the person holding the phone does.`);
    console.log(`\n  conversion:   ${conversion_id}`);
    console.log(`  person:       ${person_id}`);
    console.log(`  unit/space:   ${unit.unit_number} / ${unit.space_id}`);
    console.log(`\n  When they have submitted, resume the back half with:`);
    console.log(`    ARC_RESUME_CONVERSION=${conversion_id} node tests/arcs/full_lifecycle_arc.js`);
    console.log(`\n  (If the link is needed again it is recoverable from comm_events.body —`);
    console.log(`   the invitation row stores only a digest.)`);
    await pool.end();
    return;
  }
  const token = sent.json.token;

  // ══ 7 · THE PROSPECT FILLS IT IN ══════════════════════════════════
  announce("apply → POST /applications/submit-public  (public; no operator auth)");
  const submit = await fetch(API + "/applications/submit-public", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token, applicant_name: NAME, rent: RENT, deposit: RENT,
      captured: {
        application_form_version: "tenant_v2",
        date_of_birth: "1992-03-14", email: `arc.${Date.now()}@example.com`, phone: PHONE,
        address: { line1: "1400 Market St", city: "Philadelphia", state: "PA", postal_code: "19107" },
        current_since: "2023-06", housing_status: "rent",
        income_status: "employed", income_amount: 92000, income_frequency: "annual",
        employer: "Example Corp", job_title: "Analyst",
        desired_move_in: "2026-09-01", move_flexibility: "plus_minus_7",
        occupants: 1, has_pets: "no", guarantor_needed: "no",
      },
    }),
  });
  const submitJson = await submit.json().catch(() => null);
  if (submit.status < 200 || submit.status >= 300) {
    halt("applicant submit", { status: submit.status, json: submitJson },
      "409 'never sent' = ARC_SEND=prepare. A link that was not dispatched cannot be submitted, by design.");
  }
  const application_id = submitJson.application_id || submitJson.id;
  console.log(`  ✓ application=${application_id}  status=${submitJson.status || "(submitted)"}`);

  await backHalf({ application_id, space_id: unit.space_id, unit_number: unit.unit_number,
                   person_id, applicant_name: NAME });
  await pool.end();
  return;

  // ══ THE BACK HALF ═════════════════════════════════════════════════
  //  Declared here, hoisted, and called from BOTH paths: the full run
  //  above, and the resume path for when a real applicant submitted the
  //  form themselves. Provider mode cannot self-submit — the raw token
  //  only exists inside the message that was sent — so resuming is the
  //  normal way this finishes, not an error recovery.
  async function backHalf({ application_id, space_id, unit_number, person_id, applicant_name }) {
  // ══ 8 · APPROVE ═══════════════════════════════════════════════════
  announce("approve → POST /operator/leasing/applications/:id/approve");
  const approve = await call("POST", `/operator/leasing/applications/${application_id}/approve`, {
    decision_reason: "full lifecycle arc — approved.",
  });
  if (!good(approve)) halt("approve", approve);
  console.log(`  ✓ ${approve.json.receipt || JSON.stringify(approve.json)}`);

  // ══ 9 · PROPOSED TERMS ════════════════════════════════════════════
  announce("terms → POST /operator/leasing/applications/:id/proposed-terms");
  const terms = await call("POST", `/operator/leasing/applications/${application_id}/proposed-terms`, {
    rent: RENT, security_deposit: RENT,
    lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
    concession_status: "none", idempotency_key: `arc-terms-${application_id}`,
  });
  if (!good(terms)) halt("proposed terms", terms);
  console.log(`  ✓ confirmation=${terms.json.confirmation_id}  basis=${terms.json.authority_basis}`);

  // ══ 10 · THE EXECUTED LEASE ═══════════════════════════════════════
  announce("executed lease → POST /operator/leasing/applications/:id/executed-lease/verify");
  const verify = await call("POST", `/operator/leasing/applications/${application_id}/executed-lease/verify`, {
    space_id, rent: RENT, security_deposit: RENT,
    lease_start_date: "2026-09-01", lease_end_date: "2027-08-31",
    concession_status: "none",
    document_reference: "full lifecycle arc — executed lease",
    document_sha256: require("crypto").createHash("sha256").update(`arc-${application_id}`).digest("hex"),
    document_version: 1,
    executed_at: new Date().toISOString(),
    effective_date: "2026-09-01",
    execution_channel: "paper",
    signers: [{ name: applicant_name, capacity: "resident" }, { name: "Property Spine", capacity: "landlord_agent" }],
    idempotency_key: `arc-exec-${application_id}`,
  });
  if (!good(verify)) halt("executed lease verify", verify);
  console.log(`  ✓ record=${verify.json.record_id}  state=${verify.json.record_state}  activation=${verify.json.activation_status}`);
  if (verify.json.activation_status !== "admitted") {
    console.error(`\n✗ HALTED — admission blocked, so the application never reaches 'accepted_term_required'`);
    console.error(`  and confirm-term will refuse it with an opaque 403.`);
    console.error(`  blockers: ${JSON.stringify(verify.json.blockers, null, 1)}`);
    process.exit(1);
  }

  // ══ 11 · CONFIRM THE TERM → A LEASE EXISTS ════════════════════════
  announce("confirm → POST /operator/leasing/applications/:id/confirm-term");
  const confirm = await call("POST", `/operator/leasing/applications/${application_id}/confirm-term`, {});
  if (!good(confirm)) halt("confirm term", confirm,
    "One opaque 403 covers eight conditions. Evaluate them against the data — see tests/unit/admission_eligibility_contract.test.js.");
  console.log(`  ✓ ${confirm.json.receipt}`);

  // ══ READ-BACK — the HTTP 200 is a claim; this is the record ════════
  const lease = (await pool.query(`select * from leases where id=$1`, [confirm.json.lease_id])).rows[0];
  const app = (await pool.query(
    `select status, activated_at, executed_lease_record_id from lease_applications where id=$1`, [application_id])).rows[0];
  const tenants = lease && Array.isArray(lease.tenant_ids) ? lease.tenant_ids : [];

  console.log(`\n═══ ARC COMPLETE ═══`);
  console.log(`  lease        ${lease.id}`);
  console.log(`  status       ${lease.lease_status}   ${String(lease.start_date).slice(0,10)} → ${String(lease.end_date).slice(0,10)}   $${lease.rent}`);
  console.log(`  tenant       ${tenants.length ? tenants.join(", ") : "NONE — investigate"}`);
  console.log(`  application  ${application_id}  status=${app.status}`);
  console.log(`  person       ${person_id}   "${applicant_name}"`);
  console.log(`  unit         ${unit_number}  space=${space_id}`);
  console.log(`\n  inquiry → tour → application → lease, every step through a canonical door.`);
  if (!tenants.includes(person_id)) {
    console.error(`\n  ⚠ the lease does not list this person as a tenant — that is a real defect, not a pass.`);
    process.exitCode = 1;
  }
  }
})().catch((e) => { console.error("\n✗ UNCAUGHT:", e.message); process.exit(1); });
