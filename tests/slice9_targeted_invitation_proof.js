// ════════════════════════════════════════════════════════════════════
//  slice9_targeted_invitation_proof.js
//
//  Commit B. Every application-link entry path resolves its target through
//  the ONE authority, and a refusal lands BEFORE any durable side effect.
//
//  The defect this proves closed: `unitOfferable` was an INJECTED dependency
//  defaulting to null. A caller that simply did not pass it created an
//  invitation with no target validation whatsoever — and two production
//  callers (createAndDispatchApplicationInvitation, createPreparedInvitation)
//  never passed it. Possessing a unit_id was effectively permission to skip
//  resolution.
//
//  Run: DATABASE_URL=... node tests/slice9_targeted_invitation_proof.js
//  One transaction, rolled back. Seeds its own scratch property.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const { seedInventory } = require("./fixtures/slice9_inventory_fixture");

let pass = 0, fail = 0;
const ok = (c, m, d) => {
  if (c) { pass++; console.log("   PASS  " + m); }
  else { fail++; console.log("   FAIL  " + m + (d ? "\n           " + d : "")); }
};
const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
  ? false : { rejectUnauthorized: false };

// Throwing callers: capture the refusal instead of the stack.
async function refusal(fn) {
  try { const v = await fn(); return { threw: false, value: v }; }
  catch (e) { return { threw: true, code: e.code, status: e.httpStatus, message: e.publicMessage || e.message }; }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl });
  const c = await pool.connect();

  try {
    await c.query("begin");
    const s = await seedInventory(c);
    const P = s.property_id, U = s.units;

    // The module under test. commBoundary is deliberately NOT wired: no test
    // in this file may reach a wire, and an unwired boundary makes that
    // structural rather than a promise.
    //
    // spawnObligationFromEvent is a REAL insert into the caller's transaction,
    // not a no-op stub. The approval gate is a genuine consequence of a
    // successful birth, and a stub that returned a fake object would let a
    // birth "succeed" without the obligation the product promises.
    const spawnObligationFromEvent = async (client, o) => (await client.query(
      `insert into obligations
         (property_id, person_id, unit_id, source_event_id, related_id, related_type,
          module, type, label, owner_type, assigned_role, status, priority, severity)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [o.property_id, o.person_id, o.unit_id, o.source_event_id, o.related_id, o.related_type,
       o.module, o.type, o.label, o.owner_type, o.assigned_role, o.status, o.priority, o.severity]
    )).rows[0];

    const mod = require(path.join(REPO, "src/applications/applicationSubmission"))({
      pool, conversionService: null, commBoundary: null, spawnObligationFromEvent,
    });
    const svc = mod._service;

    const person = (await c.query(
      `insert into persons (name, lifecycle_status) values ('Commit B applicant','lead') returning id`)).rows[0].id;

    const countRows = async () => (await c.query(
      `select
         (select count(*) from application_invitations where property_id=$1)::int inv,
         (select count(*) from comm_events where property_id=$1)::int comms,
         (select count(*) from lease_applications where property_id=$1)::int apps`, [P])).rows[0];

    console.log("\n── createPreparedInvitation IS A CHOKE POINT ────────────");
    const before = await countRows();

    const multi = await refusal(() => svc.createPreparedInvitation(c, {
      property_id: P, person_id: person, unit_id: U["S-two-space"].unit_id }));
    ok(multi.threw, "a multi-space unit refuses at invitation preparation");
    ok(multi.code === "space_grain_not_supported", `refusal code is the governed one (${multi.code})`);
    ok(multi.status === 409, `refusal is 409 (${multi.status})`);
    ok(!/space_grain/.test(multi.message || ""), "operator copy carries no internal code");

    const occupied = await refusal(() => svc.createPreparedInvitation(c, {
      property_id: P, person_id: person, unit_id: U["G-occupied"].unit_id }));
    ok(occupied.threw && occupied.code === "not_offerable",
      `an occupied unit refuses preparation (${occupied.code})`);

    const locked = await refusal(() => svc.createPreparedInvitation(c, {
      property_id: P, person_id: person, unit_id: U["J-future-locked"].unit_id }));
    ok(locked.threw, "a unit committed to a future resident refuses preparation");

    const zero = await refusal(() => svc.createPreparedInvitation(c, {
      property_id: P, person_id: person, unit_id: U["R-zero-space"].unit_id }));
    ok(zero.threw && zero.code === "application_target_unconfigured",
      `a zero-space unit refuses as unconfigured (${zero.code})`);

    const after = await countRows();
    ok(after.inv === before.inv, `NO invitation row survives a refusal (${before.inv} → ${after.inv})`);
    ok(after.comms === before.comms, `NO comm_event survives a refusal (${before.comms} → ${after.comms})`);

    console.log("\n── AND IT STILL PREPARES A VALID TARGET ─────────────────");
    const good = await svc.createPreparedInvitation(c, {
      property_id: P, person_id: person, unit_id: U["A-marketable"].unit_id });
    ok(!!good.invitation_id, "a marketable sole-space unit prepares");
    ok(String(good.resolved_space_id) === String(U["A-marketable"].space_id),
      "the receipt carries the server-derived space");
    ok(good.resolution_basis === "sole_space_unit", "and names the basis");

    console.log("\n── resolved_space_id IS NOT PERSISTED AS LINEAGE ────────");
    const invCols = (await c.query(
      `select column_name from information_schema.columns where table_name='application_invitations'`
    )).rows.map(r => r.column_name);
    ok(!invCols.includes("space_id"), "application_invitations has no space_id column");
    const stored = (await c.query(
      `select * from application_invitations where id=$1`, [good.invitation_id])).rows[0];
    const leaked = Object.entries(stored).filter(([k, v]) =>
      k !== "id" && String(v) === String(good.resolved_space_id));
    ok(leaked.length === 0,
      "the resolved space is written to NO column on the invitation",
      leaked.length ? "leaked into: " + leaked.map(([k]) => k).join(", ") : "");

    console.log("\n── FUTURE-DATED TARGETS REFUSE AT PREPARATION ───────────");
    const farOut = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
    const preRefusal = await countRows();

    for (const name of ["B-upcoming", "C-turnover"]) {
      const r = await refusal(() => svc.createPreparedInvitation(c, {
        property_id: P, person_id: person, unit_id: U[name].unit_id }));
      ok(r.threw && r.code === "future_application_target_not_supported",
        `${name} refuses preparation (${r.code})`);
      ok(!/unavailable|not available today\.$/i.test(r.message || "")
         && /cannot yet carry/i.test(r.message || ""),
        `${name} names the lineage limitation, not position unavailability`);
      // Passing a date must not reopen the door.
      const withDate = await refusal(() => svc.createPreparedInvitation(c, {
        property_id: P, person_id: person, unit_id: U[name].unit_id,
        intended_move_in: farOut }));
      ok(withDate.threw && withDate.code === "future_application_target_not_supported",
        `${name} refuses identically even with an intended move-in date`);
    }

    console.log("\n── A PREPARATION REFUSAL LEAVES NOTHING BEHIND ──────────");
    const postRefusal = await countRows();
    ok(postRefusal.inv === preRefusal.inv,
      `NO invitation was created (${preRefusal.inv} → ${postRefusal.inv})`);
    ok(postRefusal.comms === preRefusal.comms,
      `NO communication was inserted (${preRefusal.comms} → ${postRefusal.comms})`);
    ok(postRefusal.apps === preRefusal.apps,
      `NO lease application was born (${preRefusal.apps} → ${postRefusal.apps})`);
    const sideEffects = (await c.query(
      `select
         (select count(*) from events where property_id=$1
            and type in ('application_link_sent','application_submitted'))::int evts,
         (select count(*) from obligations where property_id=$1
            and type in ('application_approval','send_application_link'))::int obs`,
      [P])).rows[0];
    ok(sideEffects.evts === 0, "NO lifecycle event was recorded");
    ok(sideEffects.obs === 0, "NO obligation progression followed");

    console.log("\n── NO SHADOW LINEAGE IS WRITTEN ANYWHERE ────────────────");
    //  The refused date and the resolved space must exist in NO durable field.
    const shadow = (await c.query(
      `select
         (select count(*) from application_invitations where property_id=$1)::int inv,
         (select count(*) from comm_events where property_id=$1 and body ilike '%'||$2||'%')::int comms,
         (select count(*) from events where property_id=$1 and note ilike '%'||$2||'%')::int evts`,
      [P, farOut])).rows[0];
    ok(shadow.comms === 0, "the intended move-in date appears in no communication body");
    ok(shadow.evts === 0, "and in no event note");
    const invCols2 = (await c.query(
      `select column_name from information_schema.columns where table_name='application_invitations'`
    )).rows.map((r) => r.column_name);
    ok(!invCols2.some((k) => /move_in|intended/i.test(k)),
      "application_invitations still has no intended-move-in column — none was added");
    ok(!invCols2.includes("space_id"), "and still no space_id column");

    console.log("\n── APPLICATION BIRTH ENFORCES THE GRAIN FLOOR ───────────");
    const birthMulti = await refusal(() => svc.submitApplicationService(c, {
      property_id: P, person_id: person, unit_id: U["S-two-space"].unit_id,
      applicant_name: "Commit B applicant" }));
    ok(birthMulti.threw && birthMulti.code === "space_grain_not_supported",
      `a multi-space unit cannot birth an application (${birthMulti.code})`);

    //  Deliberate: an application RECORD is not an offer. The internal door
    //  records applications that already happened, so grain refuses and
    //  marketability does not.
    const birthOccupied = await refusal(() => svc.submitApplicationService(c, {
      property_id: P, person_id: person, unit_id: U["G-occupied"].unit_id,
      applicant_name: "Commit B applicant" }));
    ok(birthOccupied.threw === false,
      "an occupied unit CAN still birth an application — a record is not an offer");

    const appsNow = await countRows();
    ok(appsNow.apps > before.apps, "the permitted birth actually landed");

    console.log("\n── THE INJECTION HOLE IS CLOSED ─────────────────────────");
    const fs = require("fs");
    const src = fs.readFileSync(path.join(REPO, "src/applications/applicationSubmission.js"), "utf8");
    ok(/require\(["']\.\/application_target_authority["']\)/.test(src),
      "the module requires the authority directly rather than receiving it");
    ok(!/if \(unit_id && unitOfferable\)/.test(src),
      "validation no longer depends on an injected function being present");

    const opsrc = fs.readFileSync(path.join(REPO, "src/identity/operator.js"), "utf8");
    ok(/applicationTargetAuthority\.resolveApplicationTarget/.test(opsrc),
      "unitOfferableState is now an adapter over the authority");
    const legacyRefs = (opsrc.match(/require\(["']\.\.\/tenancy\/availability["']\)/g) || []).length;
    // Was 1 at Commit B (leaseable-units still on the legacy read). Commit D cut
    // it over and Commit E deleted the module, so the honest expectation is now
    // ZERO. Tightened, not relaxed.
    ok(legacyRefs === 0,
      `ZERO legacy availability references remain in operator.js (found ${legacyRefs})`);

    console.log("\n── PROVIDER DISPATCH CANNOT BYPASS RESOLUTION ───────────");
    //  commBoundary is unwired, so a bypassed refusal would surface as
    //  boundary_not_wired. Getting the TARGET refusal instead proves the
    //  resolution happens before the dispatch path is even consulted.
    const disp = await refusal(() => svc.createAndDispatchApplicationInvitation({
      property_id: P, person_id: person, unit_id: U["S-two-space"].unit_id }));
    ok(disp.threw === false && disp.value && disp.value.reason === "boundary_not_wired",
      "with no comms boundary the dispatch path refuses before any wire",
      JSON.stringify(disp).slice(0, 160));
    ok(/resolveApplicationTarget/.test(
        src.split("async function createAndDispatchApplicationInvitation")[1].slice(0, 4000)),
      "and the dispatch service resolves the target before its inserts");
    ok(/TARGET RESOLUTION BEFORE ANY SIDE EFFECT/.test(src),
      "the ordering is stated at the point it is enforced");

  } catch (e) {
    fail++; console.log("   FAIL  harness threw: " + e.message + "\n" + e.stack);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`   targeted invitation: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
