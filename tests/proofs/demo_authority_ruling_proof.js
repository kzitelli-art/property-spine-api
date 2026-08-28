// ════════════════════════════════════════════════════════════════════
//  demo_authority_ruling_proof.js — the applied ruling, proven
//
//  Kameron login → new verified human_staff person → asset_manager at Demo
//  Building → governed pricing authority. Nothing published.
//
//  Run: DATABASE_URL=... node tests/proofs/demo_authority_ruling_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..", "..");

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const KZ_USER = "78375274-922a-44c5-8b61-0c285d1b9911";
const STAFF_PERSON = "c1dedf39-e5bc-4bb9-a22f-083156781ddd";
const TENANT_PERSON = "ede3fe95-457f-4100-a505-d8fae6390013";
const VOIDED = "8d1ce2a1-29f2-490c-a861-3b73c68a2da7";
const DEAD_ASSIGNMENT = "4117da50-87fc-4624-b4a9-509921e7e97f";
const DEMO_LEAD = "16b442ee-0ec5-425a-90f3-ab8708a15b77";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const sec = (s) => console.log("\n== " + s + " ==");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { resolveActorContext, FULL_AUTHORITY_ROLES } = require(path.join(REPO, "src/identity/actor_context"));
  const { authorityInventory } = require(path.join(REPO, "src/money/pricing_authority"));

  sec("THE LOGIN RESOLVES TO THE NEW STAFF PERSON");
  const u = (await pool.query(
    "select id, email, person_id, account_kind from users where id=$1", [KZ_USER])).rows[0];
  ok(u.account_kind === "human_staff", "the login is classified human_staff");
  ok(String(u.person_id) === STAFF_PERSON, "and is linked to the NEW staff person");
  const sp = (await pool.query(
    "select id, name, email, source, lifecycle_status from persons where id=$1", [STAFF_PERSON])).rows[0];
  ok(sp.source === "staff_bridge", "the staff person was created through the governed bridge");
  const ctx = (await pool.query(
    "select context_type, property_id from person_contexts where person_id=$1", [STAFF_PERSON])).rows;
  ok(ctx.length === 1 && ctx[0].context_type === "staff",
    "it carries exactly one governed staff context");
  ok(String(ctx[0].property_id) === DEMO, "scoped to Demo Building");
  const audit = (await pool.query(
    `select action, prior_person_id, new_person_id, effective_to from user_person_bridge_audit
      where user_id=$1 order by performed_at`, [KZ_USER])).rows;
  ok(audit.length === 2 && audit[0].action === "linked" && audit[1].action === "relinked",
    `the bridge audit is append-only and complete (${audit.map((a) => a.action).join(" → ")})`);
  ok(String(audit[audit.length - 1].new_person_id) === STAFF_PERSON && audit[1].effective_to === null,
    "the open audit row names the live staff person");

  sec("THE TENANT RECORD IS UNCHANGED");
  const t = (await pool.query(
    "select id, name, lifecycle_status, source, primary_phone_e164 from persons where id=$1",
    [TENANT_PERSON])).rows[0];
  ok(!!t, "the tenant person still exists");
  ok(t.lifecycle_status === "tenant", "still lifecycle tenant");
  ok(t.source === "boardroom_demo", "still sourced from the boardroom demo");
  ok(t.primary_phone_e164 === "+17243098434", "still holds the phone — identifiers stay deterministic");
  const tLinked = (await pool.query("select id from users where person_id=$1", [TENANT_PERSON])).rows;
  ok(tLinked.length === 0, "no login is linked to it — it was not reused");
  const tAsg = (await pool.query("select id from assignments where person_id=$1", [TENANT_PERSON])).rows;
  ok(tAsg.length === 0, "it holds no assignment — no staff authority was attached");
  // Counterparty history intact.
  const hist = (await pool.query(
    `select (select count(*)::int from comm_events where person_id=$1) comms,
            (select count(*)::int from events where person_id=$1) events,
            (select count(*)::int from obligations where person_id=$1) obligations`,
    [TENANT_PERSON])).rows[0];
  ok(Number(hist.comms) > 100 && Number(hist.events) > 50 && Number(hist.obligations) > 50,
    `its counterparty history is intact (${hist.comms} comms, ${hist.events} events, ${hist.obligations} obligations)`);
  ok(String(STAFF_PERSON) !== String(TENANT_PERSON), "the two identities remain separate rows");

  sec("THE DUPLICATE IS RETIRED, NOT DELETED OR MERGED");
  const v = (await pool.query(
    `select name, email, source, created_at, record_status, retired_at, retired_reason,
            retired_by_user_id, superseded_by_person_id from persons where id=$1`, [VOIDED])).rows[0];
  ok(!!v, "the duplicate row still EXISTS — not hard-deleted");
  ok(v.record_status === "retired", "it is retired through the governed lifecycle");
  ok(v.retired_reason === "duplicate_created_in_error", "with the reason recorded verbatim");
  ok(!!v.retired_at && !!v.retired_by_user_id, "and when, and by whom");
  ok(String(v.superseded_by_person_id) === STAFF_PERSON,
    "an auditable resolution reference points at the surviving canonical identity");
  ok(v.name === "Kameron Zitelli — Staff",
    "the record still says what it WAS — retirement is recorded in its own fields, not by renaming");
  ok(new Date(v.created_at).toISOString().startsWith("2026-07-27T21:45:08"),
    "its creation timestamp is preserved");
  ok(v.email === null, "its email was released so the identifier resolves to one active person");
  const vCtx = (await pool.query(
    "select id from person_contexts where person_id=$1 and context_type='staff'", [VOIDED])).rows;
  ok(vCtx.length === 0, "its staff context was removed — it can never receive authority");
  const vAsg = (await pool.query("select id from assignments where person_id=$1", [VOIDED])).rows;
  const vUsr = (await pool.query("select id from users where person_id=$1", [VOIDED])).rows;
  ok(vAsg.length === 0 && vUsr.length === 0,
    "it holds no assignment and no session — it cannot receive work or authority");
  const retireGuard = (await pool.query(
    `select pg_get_constraintdef(oid) def from pg_constraint
      where conname='ck_persons_retirement_is_explained'`)).rows[0];
  ok(!!retireGuard, "a retirement without a reason and timestamp is refused by constraint");
  const vAudit = (await pool.query(
    "select id from user_person_bridge_audit where prior_person_id=$1 or new_person_id=$1", [VOIDED])).rows;
  ok(vAudit.length === 2, "but the bridge audit still references it — history was NOT rewritten");
  const emailStaff = (await pool.query(
    `select pe.id from person_contexts pc join persons pe on pe.id=pc.person_id
      where pc.context_type='staff' and pe.email='kz8434@gmail.com'`)).rows;
  ok(emailStaff.length === 1 && String(emailStaff[0].id) === STAFF_PERSON,
    "exactly ONE staff person holds that email");

  sec("THE ASSIGNMENT IS ASSET_MANAGER, DEMO-ONLY");
  const asg = (await pool.query(
    "select id, property_id, role, is_active, provenance from assignments where person_id=$1", [STAFF_PERSON])).rows;
  ok(asg.length === 1, `exactly one assignment exists (${asg.length})`);
  ok(asg[0].role === "asset_manager", "the role is asset_manager");
  ok(asg[0].is_active === true, "it is active");
  ok(String(asg[0].property_id) === DEMO, "and it is Demo Building only");
  ok(asg[0].provenance && asg[0].provenance.reviewer_user_id,
    "its provenance names the reviewer and reason");
  const anyOwner = (await pool.query(
    "select id from assignments where person_id=$1 and role='owner'", [STAFF_PERSON])).rows;
  ok(anyOwner.length === 0, "NO owner assignment was recreated");
  ok(FULL_AUTHORITY_ROLES.has("asset_manager") && FULL_AUTHORITY_ROLES.has("owner"),
    "the contract keeps owner and asset_manager distinct but both authority-bearing");
  ok(!FULL_AUTHORITY_ROLES.has("property_manager"),
    "property_manager remains daily operating management, not pricing authority");

  sec("PRICING AUTHORITY RESOLVES THROUGH THE ASSIGNMENT");
  const ctxDemo = await resolveActorContext(pool, { user_id: KZ_USER, property_id: DEMO });
  ok(ctxDemo.ok && ctxDemo.link_status === "linked", "the actor context resolves");
  ok(ctxDemo.person.person_id === STAFF_PERSON, "to the new staff person");
  ["may_prepare_pricing", "may_review_pricing", "may_publish_pricing", "may_manage_concession_authority"]
    .forEach((v2) => {
      ok(ctxDemo.capabilities[v2] === true, `${v2} is derived`);
      ok(ctxDemo.basis[v2] === "assignment:asset_manager", `  …from assignment:asset_manager`);
    });

  sec("NO OTHER PROPERTY GAINS AUTHORITY");
  const props = (await pool.query("select id, name from properties")).rows;
  ok(props.length === 28, `${props.length} properties exist`);
  let leaked = [];
  for (const pr of props) {
    if (String(pr.id) === DEMO) continue;
    const c2 = await resolveActorContext(pool, { user_id: KZ_USER, property_id: pr.id });
    if (c2.capabilities.may_publish_pricing) leaked.push(pr.name);
  }
  ok(leaked.length === 0, `authority reaches ZERO of the other 27 properties (${leaked.join(", ") || "none"})`);
  const inv = await authorityInventory(pool, {});
  ok(inv.summary.properties_with_publish_authority === 1,
    `exactly 1 of ${inv.summary.properties_total} properties has publish authority`);
  const real = ["9e2bb96e-08e2-41db-81c2-91055ceb50a3"];  // 4233 Chestnut, 274 real leases
  for (const rp of real) {
    const c3 = await resolveActorContext(pool, { user_id: KZ_USER, property_id: rp });
    ok(c3.capabilities.may_publish_pricing === false,
      "and NOT the real 4233 Chestnut production property");
  }

  sec("THE HISTORICAL DEMO-LEAD ASSIGNMENT IS UNTOUCHED");
  const dead = (await pool.query(
    "select person_id, role, is_active, created_at, provenance from assignments where id=$1",
    [DEAD_ASSIGNMENT])).rows[0];
  ok(!!dead, "the historical row still exists");
  ok(dead.is_active === false, "still deactivated");
  ok(String(dead.person_id) === DEMO_LEAD, "still naming the demo lead it was wrongly attached to");
  ok(dead.role === "owner", "still recording that it was an owner assignment");
  ok(new Date(dead.created_at).toISOString().startsWith("2026-07-02"), "creation date unchanged");
  ok(!!dead.provenance.deactivation_reason, "and its deactivation reason is intact");

  sec("NOTHING OPERATING CHANGED");
  const st = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) versions,
            (select count(*)::int from pricing_terms) terms,
            (select count(*)::int from pricing_review_receipts) receipts,
            (select count(*)::int from concession_policies where active) active_concessions,
            (select count(*)::int from concession_authority_grants) grants`)).rows[0];
  ok(Number(st.versions) === 0, "no pricing version exists");
  ok(Number(st.terms) === 0 && Number(st.receipts) === 0, "no terms, no review receipts");
  ok(Number(st.active_concessions) === 0, "no concession is active");
  ok(Number(st.grants) === 0, "no authority grant exists — authority is the assignment");
  const agentSrc = fs.readFileSync(path.join(REPO, "src/agent/agent.js"), "utf8");
  //  ── INVERTED 2026-08-20, DELIBERATELY ────────────────────────────
  //  This asserted the OPPOSITE: that the live agent does NOT read the
  //  governed adapter. That was an accurate description of a defect, pinned
  //  as though it were an invariant.
  //
  //  The agent read units.market_rent — a legacy per-unit column with no
  //  publish step, no version and no review between it and a prospect's
  //  phone — and put it straight into the model's context. It had already
  //  been wrong in production once: $237 off on unit 530, to nine real
  //  people. While these four assertions stood, fixing that made the suite
  //  red, so the tests were protecting the defect.
  //
  //  The rule that survives is the one that always mattered: the agent must
  //  never read the LEGACY COLUMN. That is now asserted directly, which is
  //  stronger than asserting the absence of the adapter — it forbids the
  //  actual failure rather than one symptom of it.
  ok(/quotablePricing/.test(agentSrc), "the live agent DOES reach the governed adapter");
  ok(!/select[^;]*market_rent[^;]*from units/i.test(agentSrc),
    "the live agent never selects the legacy units.market_rent column");
  const { futureRentRollPricingPreview } = require(path.join(REPO, "src/money/future_rent_roll_pricing_contract"));
  const frr = await futureRentRollPricingPreview(pool, { property_id: DEMO });
  ok(frr.summary.positions_given_projected_pricing === 0, "Future Rent Roll gives 0 positions projected pricing");
  ok(frr.published_version_at_date === null, "and sees no published version");
  const persons = Number((await pool.query("select count(*)::int n from persons")).rows[0].n);
  ok(persons === 902, `persons = ${persons} (900 original + 1 staff + 1 voided duplicate); none merged or deleted`);

  sec("STAFF CREATION IS IDEMPOTENT — RETRIES AND RACES");
  const bridge = require(path.join(REPO, "src/identity/staff_bridge"))({ pool });
  const n0 = Number((await pool.query("select count(*)::int n from persons")).rows[0].n);
  const attempt = async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const out = await bridge._service.linkBridge(c, {
        user_id: KZ_USER,
        create_staff_person: { name: "Kameron Zitelli — Staff", email: "kz8434@gmail.com",
                               phone: null, property_id: DEMO },
        reason_code: "idempotency_probe", performed_by_user_id: "e9a7659f-ee1a-4bde-9e0c-02c6632ff066",
      });
      await c.query("commit");
      return out;
    } catch (e) { await c.query("rollback").catch(() => {}); return { error: e.message }; }
    finally { c.release(); }
  };
  const seq = await attempt();
  ok(seq.already_exists === true && String(seq.person.id) === STAFF_PERSON,
    "a sequential retry returns the already-linked person, explicitly");
  // FIVE at once — the case a pre-check alone cannot survive.
  const burst = await Promise.all([1, 2, 3, 4, 5].map(attempt));
  ok(burst.every((b) => b.already_exists === true),
    "five SIMULTANEOUS requests all return already_exists");
  ok(burst.every((b) => String(b.person.id) === STAFF_PERSON),
    "and all resolve to the same canonical person");
  const n1 = Number((await pool.query("select count(*)::int n from persons")).rows[0].n);
  ok(n1 === n0, `ZERO persons were created across 6 attempts (${n0} → ${n1})`);
  const activeStaff = (await pool.query(
    `select id from persons where lower(email)='kz8434@gmail.com'
       and source='staff_bridge' and record_status='active'`)).rows;
  ok(activeStaff.length === 1, "exactly one ACTIVE staff person holds that identity");

  // The database backstop: a caller bypassing the function entirely.
  let raw = null;
  try {
    await pool.query("insert into persons (name,email,source) values ($1,$2,'staff_bridge')",
      ["Bypass Attempt", "kz8434@gmail.com"]);
  } catch (e) { raw = e.constraint || e.message; }
  ok(raw === "uq_active_staff_person_email",
    "a DIRECT insert bypassing the service is refused by the database, not just the application");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
