"use strict";
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const bridge = require("./src/identity/staffbridge")({ pool: p });
const { resolveAuthority } = require("./src/identity/authority_resolution");
const { resolveActorContext } = require("./src/identity/actor_context");
const USER = "78375274-922a-44c5-8b61-0c285d1b9911";
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const ACTOR = "e9a7659f-ee1a-4bde-9e0c-02c6632ff066";
(async () => {
  // ── STEP 1: classify (its own attributable write) ──
  const c1 = await p.connect();
  await c1.query("begin");
  const already = (await c1.query("select account_kind from users where id=$1",[USER])).rows[0];
  if (already.account_kind !== "human_staff") {
    await bridge._service.classifyAccount(c1, { user_id: USER, account_kind: "human_staff", performed_by_user_id: ACTOR });
  }
  await c1.query("commit"); c1.release();
  console.log("STEP 1 classify: account_kind=human_staff (already applied: " + (already.account_kind==="human_staff") + ")");

  // ── STEP 2: create the staff person AND link, one governed txn ──
  // The staff record carries the EMAIL. The PHONE deliberately stays with the
  // tenant record so both identifiers keep resolving to exactly one person.
  const c2 = await p.connect();
  await c2.query("begin");
  const link = await bridge._service.linkBridge(c2, {
    user_id: USER,
    create_staff_person: { name: "Kameron Zitelli — Staff", email: "kz8434@gmail.com",
                           phone: null, property_id: DEMO },
    reason_code: "governed_pricing_authority_ruling",
    reason_detail: "New staff person created per ownership ruling 2026-07-27. The existing demo tenant person ede3fe95 is left untouched as a counterparty with all history intact.",
    evidence_type: "operator_attestation",
    evidence_reference: "Demo Pricing Authority Ruling 2026-07-27",
    performed_by_user_id: ACTOR,
  });
  await c2.query("commit"); c2.release();
  console.log("STEP 2 link: " + JSON.stringify(link).slice(0,400));
  const NEW_PERSON = (await p.query("select person_id from users where id=$1",[USER])).rows[0].person_id;
  console.log("   new staff person_id: " + NEW_PERSON);

  // ── STEP 3: staff context (created by createStaffPerson) ──
  const ctx = await p.query("select id, context_type, property_id from person_contexts where person_id=$1",[NEW_PERSON]);
  console.log("STEP 3 staff context: " + JSON.stringify(ctx.rows));

  // ── STEP 4: authority — dry run first ──
  const spec = { user_id: USER, person_id: NEW_PERSON, property_id: DEMO,
    requested_role: "asset_manager", reviewer_user_id: ACTOR,
    reason: "Ownership ruling 2026-07-27: Kameron Zitelli is the Demo pricing publisher. asset_manager classification per ruling." };
  const dry = await resolveAuthority(p, { spec });
  console.log("\nSTEP 4 DRY RUN would_apply=" + dry.would_apply + " blocking=" + JSON.stringify(dry.blocking));
  for (const c of dry.receipt.evidence) console.log("   " + (c.passed?"PASS":"FAIL") + "  " + c.id + " — " + c.detail);
  console.log("   consequence: " + dry.receipt.authority_consequence);
  if (dry.would_apply) {
    const app = await resolveAuthority(p, { spec, apply: true });
    console.log("\nSTEP 4 APPLIED assignment_id=" + app.created_id);
  }
  const after = await resolveActorContext(p, { user_id: USER, property_id: DEMO });
  console.log("\nACTOR CONTEXT: " + JSON.stringify({ok:after.ok, link:after.link_status,
    person:after.person && after.person.display_name, asg:after.assignments.map(a=>a.role),
    caps:after.capabilities, basis:after.basis}, null, 1));
  await p.end();
})();
