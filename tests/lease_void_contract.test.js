// ════════════════════════════════════════════════════════════════════
//  lease_void_contract.test.js — the narrow door stays narrow.
//
//  WHAT THIS PROTECTS
//  ------------------
//  voidHollowLease exists because a hollow `pending` row silently blocked
//  Confirm Term on its unit, and nothing in the product could retire one.
//  The temptation was a general "cancel this lease" button. That would
//  have been quicker and would have handed someone the power to end a real
//  tenancy by accident, to fix a problem caused by rows that never were
//  one.
//
//  So the assertions that matter most are the REFUSALS. A door this close
//  to possession, rent and reporting is only safe while it cannot open on
//  a lease that means something.
//
//  Real Postgres, always rolled back.
//
//  CLASS 3 — test infrastructure.
//  RUN:  DATABASE_URL=... node tests/lease_void_contract.test.js
// ════════════════════════════════════════════════════════════════════
"use strict";

const path = require("path");
const { Pool } = require("pg");
const svc = require(path.join(__dirname, "..", "src", "tenancy", "lease_void_service.js"));

const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let passed = 0, failed = 0;
const lines = [];
function ok(label, cond, detail) {
  if (cond) { passed++; lines.push(`  ok    ${label}`); }
  else { failed++; lines.push(`  FAIL  ${label}${detail ? "\n          " + detail : ""}`); }
}
function section(t) { lines.push(`\n  ── ${t} ${"─".repeat(Math.max(0, 52 - t.length))}`); }

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required."); process.exitCode = 2; return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();

  try {
    await c.query("begin");

    const space = (await c.query(
      `select s.id from spaces s join units u on u.id = s.unit_id
        where u.property_id = $1 limit 1`, [DEMO])).rows[0];
    const actor = (await c.query(
      `insert into users (name, role, is_active, status) values ('Void Contract Actor','property_manager',true,'active')
       returning id`)).rows[0].id;

    // tenant_ids is NOT NULL — a hollow lease carries an EMPTY array, not a
    // null. Worth knowing: "no tenant" is already expressible in the schema.
    const mkLease = async ({ status = "pending", tenants = [], applicationId = null, activated = null } = {}) =>
      (await c.query(
        `insert into leases (property_id, space_id, lease_status, start_date, end_date, rent,
                             tenant_ids, application_id, economic_tenancy_activated_at)
         values ($1,$2,$3,'2026-08-01','2027-07-31',1800,$4,$5,$6) returning id`,
        [DEMO, space.id, status, tenants, applicationId, activated])).rows[0].id;

    const voidIt = (id, reason = "created_in_error") =>
      svc.voidHollowLease(c, { lease_id: id, actor_user_id: actor, reason });

    const refused = async (id, expectCode, reason = "created_in_error") => {
      try { await c.query("savepoint v"); await voidIt(id, reason); await c.query("release savepoint v"); return null; }
      catch (e) { await c.query("rollback to savepoint v"); return e.code === expectCode ? true : e.code || e.message; }
    };

    // ════ A · THE DOOR OPENS FOR WHAT IT IS FOR ══════════════════════
    section("A · a lease that never became a tenancy");

    const hollow = await mkLease();
    const out = await voidIt(hollow);
    ok("A1. a hollow pending lease is retired",
      out.voided === true && out.lease_status === "cancelled", JSON.stringify(out));
    ok("A2. the PRIOR status is reported, so the row can be read back to what it was",
      out.prior_status === "pending", JSON.stringify(out.prior_status));

    const after = (await c.query(
      `select lease_status, start_date, end_date, rent, space_id from leases where id=$1`, [hollow])).rows[0];
    ok("A3. RETIRED IN PLACE — dates, rent and space survive; nothing was deleted",
      after.lease_status === "cancelled" && after.rent !== null && after.space_id === space.id,
      JSON.stringify(after));

    const ev = (await c.query(
      `select type, note from events where id = $1`, [out.event_id])).rows[0];
    ok("A4. an event records the act, naming the actor and the prior status",
      ev.type === "lease_voided" && ev.note.includes(actor) && ev.note.includes("pending"), ev.note);

    ok("A5. the space is free — the retired lease no longer counts as operative",
      (await c.query(
        `select count(*)::int n from leases where space_id=$1 and id=$2
          and lease_status not in ('cancelled','terminated','rescinded','void','expired','superseded')`,
        [space.id, hollow])).rows[0].n === 0);

    // ════ B · THE REFUSALS — WHY THIS IS SAFE ════════════════════════
    //  Each of these is a lease that means something. If any starts
    //  passing, the narrow door has become a general one.
    section("B · what it must never touch");

    const withTenant = await mkLease({ tenants: [actor] });
    ok("B1. THE ONE THAT MATTERS — a lease naming a resident is refused",
      (await refused(withTenant, "lease_has_tenants")) === true);

    const withApp = await mkLease({ applicationId: null });
    await c.query(`update leases set application_id = $1 where id = $2`,
      [(await c.query(
        `insert into lease_applications (property_id, person_id, status, applicant_name)
         values ($1, null, 'submitted', 'Void Contract App') returning id`, [DEMO])).rows[0].id, withApp]);
    ok("B2. a lease born from an application is refused — retiring it would orphan the application",
      (await refused(withApp, "lease_has_application")) === true);

    const activated = await mkLease({ activated: new Date().toISOString() });
    ok("B3. a lease with an activated economic tenancy is refused — money has moved against it",
      (await refused(activated, "economic_tenancy_active")) === true);

    ok("B4. an already-retired lease is refused rather than double-voided",
      (await refused(hollow, "already_retired")) === true);

    ok("B5. a lease that does not exist is refused, not silently ignored",
      (await refused("00000000-0000-0000-0000-000000000001", "lease_not_found")) === true);

    // ════ C · ATTESTATION AND VOCABULARY ═════════════════════════════
    section("C · it is an attested act");

    const another = await mkLease();
    let noActor = null;
    try { await svc.voidHollowLease(c, { lease_id: another, actor_user_id: null, reason: "created_in_error" }); }
    catch (e) { noActor = e.code; }
    ok("C1. no actor, no void — this is an attested act, never anonymous",
      noActor === "actor_required", noActor);

    let badReason = null;
    try { await svc.voidHollowLease(c, { lease_id: another, actor_user_id: actor, reason: "because" }); }
    catch (e) { badReason = e.code; }
    ok("C2. the reason is a closed vocabulary — free text cannot stand in for a decision",
      badReason === "reason_required", badReason);

    ok("C3. refusalReason can be asked WITHOUT acting, so a caller can show why before it tries",
      svc.refusalReason({ lease_status: "pending", tenant_ids: [actor] }).code === "lease_has_tenants" &&
      svc.refusalReason({ lease_status: "pending", tenant_ids: [] }) === null);

  } catch (e) {
    failed++; lines.push(`  FAIL  harness threw: ${e.message}`);
  } finally {
    try { await c.query("rollback"); } catch (_) {}
    c.release();
    await pool.end().catch(() => {});
  }

  const bar = "─".repeat(66);
  console.log(`\n${bar}\nLEASE VOID — THE NARROW DOOR STAYS NARROW\n${bar}`);
  console.log(lines.join("\n"));
  console.log(`\n${bar}`);
  console.log(`${passed}/${passed + failed} passed` + (failed ? `  —  ${failed} failure(s)` : ""));
  console.log(failed ? "Rolled back; nothing persisted."
    : "It can retire a lease that never was. It cannot end one that is.");
  console.log(`${bar}\n`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error("harness error:", e); process.exitCode = 1; });
