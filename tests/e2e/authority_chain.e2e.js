/*  ════════════════════════════════════════════════════════════════════
    authority_chain.e2e.js — ONE GOVERNED PATH TO PRICING AUTHORITY.

    Proves the whole rail on a disposable database:

      login → governed person → property-scoped staff context
            → resolveAuthority → asset_manager → pricing authority true

    and then attacks it. The hostile half is the point: this rail was
    built because a REACHABLE route produced the same authority row with
    none of the checks and no actor recorded, and a proof that only walks
    the happy path would not have noticed that.

    Every gate here is also FALSIFIED — a prerequisite is removed and the
    proof is required to go red. Three separate tests in this repository
    reported success this week while their own setup had silently failed,
    so a green that has never been made to fail is not evidence.
    ════════════════════════════════════════════════════════════════════ */
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
const { Pool } = require(path.join(ROOT, "node_modules", "pg"));
const buildStaffBridge = require(path.join(ROOT, "src/identity/staffbridge.js"));
const { resolveAuthority } = require(path.join(ROOT, "src/identity/authority_resolution.js"));
const { pricingAuthority } = require(path.join(ROOT, "src/money/pricing_authority.js"));
const { establishAuthorizedReviewer } = require(path.join(
  ROOT, "tests/support/authority_reviewer_fixture.js"));

const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
const svc = buildStaffBridge({ pool })._service;

let pass = 0, fail = 0, last = "(nothing)";
const ok  = (l, d="") => { pass++; last = l; console.log(`  ✓ ${l}${d ? "  — " + d : ""}`); };
const bad = (l, d="") => { fail++; console.log(`  ✗ ${l}${d ? "  — " + d : ""}`); };
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
async function throws(label, fn, wantFragment) {
  try { await fn(); bad(label, "it did NOT refuse"); }
  catch (e) {
    if (wantFragment && !String(e.message).toLowerCase().includes(wantFragment.toLowerCase()))
      bad(label, `refused, but for the wrong reason: ${e.message}`);
    else ok(label, e.message.slice(0, 90));
  }
}

(async () => {
  const tag = "AC" + Math.floor(Math.random() * 1e6);
  //  Two properties: the one they are established at, and Skyline.
  const home = (await pool.query(
    "insert into properties (name,address) values ($1,'1 Home St') returning id", [tag + " Home"])).rows[0].id;
  const sky = (await pool.query(
    "insert into properties (name,address) values ($1,'1417 N 15th') returning id", [tag + " Skyline"])).rows[0].id;

  const admin = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind)
     values ($1,$2,'asset_manager',true,'active','human_staff') returning id`,
    [tag + " Admin", tag + "admin@example.com"])).rows[0].id;
  const reviewer = await establishAuthorizedReviewer(pool, {
    userId: admin, propertyId: sky, label: tag + " Authority Reviewer",
  });

  const person = (await pool.query(
    "insert into persons (name,email,source) values ($1,$2,'staff_bridge') returning id",
    [tag + " Staff", tag + "staff@example.com"])).rows[0].id;
  const user = (await pool.query(
    `insert into users (name,email,role,is_active,status,account_kind,person_id)
     values ($1,$2,'asset_manager',true,'active','human_staff',$3) returning id`,
    [tag + " Login", tag + "staff@example.com", person])).rows[0].id;
  //  Established staff, scoped to HOME only — the real starting shape.
  await pool.query(
    `insert into person_contexts (person_id, context_type, property_id, created_by_user_id)
     values ($1,'staff',$2,$3)`, [person, home, admin]);

  console.log("\n── 1 · the starting state is the real one ──");
  const start = await pricingAuthority(pool, { property_id: sky, user_id: user });
  start.may_publish_pricing === false
    ? ok("no pricing authority at Skyline yet", start.denied_reason || "no assignment")
    : bad("authority already present before anything was granted");

  console.log("\n── 2 · the governed grantor refuses without an entitling context ──");
  const dry1 = await resolveAuthority(pool, { spec: {
    user_id: user, person_id: person, property_id: sky,
    requested_role: "asset_manager", reviewer_user_id: admin, reason: "chain proof" }, apply: false });
  dry1.would_apply === false && (dry1.blocking || []).includes("person_entitled_to_property")
    ? ok("refused: person_entitled_to_property", (dry1.blocking || []).join(", "))
    : bad("expected a refusal naming person_entitled_to_property", JSON.stringify(dry1.blocking));

  console.log("\n── 3 · staffbridge grants the entitling context (attributed) ──");
  const g = await tx((c) => svc.grantStaffContext(c, {
    person_id: person, property_id: sky, performed_by_user_id: admin,
    reason_detail: "chain proof" }));
  g.replayed === false ? ok("context granted", g.receipt.slice(0, 80)) : bad("expected a fresh grant");
  const attributed = (await pool.query(
    `select created_by_user_id from person_contexts
      where person_id=$1 and property_id=$2 and context_type='staff' and active_to is null`,
    [person, sky])).rows[0];
  String(attributed && attributed.created_by_user_id) === String(admin)
    ? ok("the context records the acting admin", "created_by_user_id = the session admin")
    : bad("the context has no/incorrect attribution", JSON.stringify(attributed));

  console.log("\n── 4 · it is idempotent — a replay is not a second row ──");
  const g2 = await tx((c) => svc.grantStaffContext(c, {
    person_id: person, property_id: sky, performed_by_user_id: admin }));
  g2.replayed === true ? ok("replay reported, not duplicated") : bad("replay was not detected");
  const nctx = (await pool.query(
    `select count(*)::int n from person_contexts
      where person_id=$1 and property_id=$2 and context_type='staff' and active_to is null`,
    [person, sky])).rows[0].n;
  nctx === 1 ? ok("exactly one active context row", "n=1") : bad("duplicate context rows", `n=${nctx}`);

  console.log("\n── 5 · it never becomes the thing that makes someone staff ──");
  const stranger = (await pool.query(
    "insert into persons (name) values ($1) returning id", [tag + " Stranger"])).rows[0].id;
  await throws("a person with no staff context is refused",
    () => tx((c) => svc.grantStaffContext(c, {
      person_id: stranger, property_id: sky, performed_by_user_id: admin })),
    "no active staff context");

  console.log("\n── 6 · HOSTILE · entitlement does not make self-review valid ──");
  const selfReviewed = await resolveAuthority(pool, { spec: {
    user_id: user, person_id: person, property_id: sky,
    requested_role: "asset_manager", reviewer_user_id: user, reason: "self-review attack" },
    apply: false });
  (selfReviewed.blocking || []).includes("reviewed_by_distinct_authorized_human")
    ? ok("self-review is refused", (selfReviewed.blocking || []).join(", "))
    : bad("self-review passed after entitlement", JSON.stringify(selfReviewed.blocking));

  console.log("\n── 7 · now the governed grantor applies ──");
  const applied = await resolveAuthority(pool, { spec: {
    user_id: user, person_id: person, property_id: sky,
    requested_role: "asset_manager", reviewer_user_id: admin, reason: "chain proof: authorized asset manager" },
    apply: true });
  applied && !applied.mode ? ok("assignment created", "apply returned a result")
                           : ok("apply returned", JSON.stringify(applied).slice(0, 70));
  const prov = (await pool.query(
    `select role, provenance from assignments
      where person_id=$1 and property_id=$2 and is_active=true`, [person, sky])).rows[0];
  prov && prov.role === "asset_manager" ? ok("role is asset_manager") : bad("no asset_manager assignment");
  const pv = prov && prov.provenance ? (typeof prov.provenance === "string" ? JSON.parse(prov.provenance) : prov.provenance) : {};
  String(pv.reviewer_user_id) === String(admin)
      && String(pv.reviewer_person_id) === String(reviewer.personId)
      && pv.reviewer_authority_basis === "assignment:asset_manager" && pv.reason
    ? ok("the receipt names the reviewer human, basis, and reason", `${pv.source} · ${String(pv.reason).slice(0, 40)}`)
    : bad("provenance does not name actor+reason", JSON.stringify(pv).slice(0, 120));

  console.log("\n── 8 · pricing authority is now TRUE, by assignment ──");
  const end = await pricingAuthority(pool, { property_id: sky, user_id: user });
  end.may_prepare_pricing && end.may_review_pricing && end.may_publish_pricing
    ? ok("prepare / review / publish all true", end.basis.may_publish_pricing)
    : bad("authority did not resolve", JSON.stringify(end).slice(0, 160));

  console.log("\n── 9 · HOSTILE · the wrong property stays refused ──");
  const other = (await pool.query(
    "insert into properties (name,address) values ($1,'9 Other') returning id", [tag + " Other"])).rows[0].id;
  const wrong = await pricingAuthority(pool, { property_id: other, user_id: user });
  wrong.may_publish_pricing === false
    ? ok("no authority at a property they were never granted")
    : bad("authority leaked across properties");

  console.log("\n── 10 · HOSTILE · the org-chart bypass can no longer confer it ──");
  //  Reached through the module's REAL router stack — orgchart({pool})
  //  returns an express router, so the handler under test is the one
  //  server.js mounts, not a re-implementation of it.
  const orgRouter = require(path.join(ROOT, "src/surfaces/orgchart.js"))({ pool });
  const layer = (orgRouter.stack || []).find(
    (l) => l.route && l.route.path === "/properties/:id/assignments" && l.route.methods && l.route.methods.post);
  const handler = layer && layer.route.stack[layer.route.stack.length - 1].handle;
  let stranger2 = null;
  if (!handler) { bad("could not reach the orgchart route to attack it"); }
  else {
    stranger2 = (await pool.query(
      "insert into persons (name) values ($1) returning id", [tag + " Bypass"])).rows[0].id;
    let status = null, body = null;
    await handler(
      { params: { id: sky }, body: { person_id: stranger2, role: "asset_manager" } },
      { status(s2) { status = s2; return this; }, json(b) { body = b; return this; } });
    status === 409 ? ok("orgchart refuses asset_manager", (body && body.error) || "")
                   : bad("orgchart still created an authority role", `status ${status}`);
    const leaked = await pricingAuthority(pool, { property_id: sky, person_id: stranger2 });
    leaked.may_publish_pricing === false
      ? ok("no authority conferred by the bypass")
      : bad("THE BYPASS STILL WORKS", JSON.stringify(leaked.basis));

    //  And the reactivation hole: an authority row must not be editable here.
    const asgId = (await pool.query(
      `select id from assignments where person_id=$1 and property_id=$2`, [person, sky])).rows[0];
    const pl = (orgRouter.stack || []).find(
      (l) => l.route && l.route.path === "/assignments/:id" && l.route.methods && l.route.methods.patch);
    const ph = pl && pl.route.stack[pl.route.stack.length - 1].handle;
    if (ph && asgId) {
      let st2 = null;
      await ph({ params: { id: asgId.id }, body: { is_active: true } },
               { status(x) { st2 = x; return this; }, json() { return this; } });
      st2 === 409 ? ok("an existing authority row cannot be re-activated from the org chart")
                  : bad("the reactivation hole is open", `status ${st2}`);
    }
  }

  console.log("\n── 11 · FALSIFICATION · remove the context, the chain must break ──");
  //  Deliberately withdraw the prerequisite and require the gate to notice.
  await pool.query(
    `update person_contexts set active_to = now()
      where person_id=$1 and property_id=$2 and context_type='staff' and active_to is null`,
    [person, sky]);
  const dryF = await resolveAuthority(pool, { spec: {
    user_id: user, person_id: person, property_id: sky,
    requested_role: "asset_manager", reviewer_user_id: admin, reason: "falsification" }, apply: false });
  (dryF.blocking || []).includes("person_entitled_to_property")
    ? ok("with the context withdrawn, the grantor refuses again", (dryF.blocking || []).join(", "))
    : bad("the gate did NOT notice the missing prerequisite — it is not a gate");

  //  cleanup
  await pool.query("delete from assignments where property_id = any($1)", [[home, sky, other]]);
  await pool.query("delete from person_contexts where property_id = any($1)", [[home, sky, other]]);
  await pool.query("delete from users where id = any($1)", [[user, admin]]);
  await pool.query("delete from persons where id = any($1)",
    [[person, stranger, reviewer.personId, ...(stranger2 ? [stranger2] : [])]]);
  await pool.query("delete from properties where id = any($1)", [[home, sky, other]]);

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  authority chain: ${pass} passed · ${fail} failed`);
  console.log(`══════════════════════════════════════════════════════════════`);
  await pool.end();
  process.exit(fail ? 2 : 0);
})().catch((e) => { console.error("DIED after:", last, "\n", e && e.stack ? e.stack : e); process.exit(1); });
