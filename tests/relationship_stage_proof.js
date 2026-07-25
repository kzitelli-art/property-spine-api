// ════════════════════════════════════════════════════════════════════
//  RELATIONSHIP STAGE RESOLVER PROOF  —  READ-ONLY
//
//  Proves the ONE stage resolver (src/shared/relationship_stage.js)
//  against real Postgres. This harness writes NOTHING: no insert, no
//  update, no delete, no scratch property. It reads live rows and
//  asserts the resolver's emitted output.
//
//  It is falsifiable against pre-fix code: OLD_RULE below is the exact
//  logic the Person Card used before (prospect, upgraded to applicant
//  when a lease_applications row exists). Block 3 FAILS if the resolver
//  does not disagree with OLD_RULE on at least one real person — i.e.
//  if the fix changed nothing, this harness goes red.
//
//    DATABASE_URL=... node tests/relationship_stage_proof.js
// ════════════════════════════════════════════════════════════════════
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { resolveRelationshipStage, STAGES } = require("../src/shared/relationship_stage");

const PROP = process.env.STAGE_PROOF_PROPERTY_ID || "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
let pass = 0, fail = 0;
const chk = (n, c, d = "") => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${d}`)); };

// The EXACT pre-fix logic, reproduced so the harness can prove it was wrong.
async function OLD_RULE(personId, propertyId) {
  const a = (await pool.query(
    `select 1 from lease_applications where person_id=$1 and property_id=$2 limit 1`,
    [personId, propertyId])).rows[0];
  return a ? "applicant" : "prospect";
}

async function main() {
  console.log("═══ RELATIONSHIP STAGE RESOLVER (read-only) ═══");
  console.log(`  property ${PROP}\n`);

  // ── 1. LADDER — each rung resolves from real evidence ───────────────
  console.log("─── 1. the ladder resolves from real evidence ───");

  const resident = (await pool.query(
    `select t.pid::text as person_id from leases l, unnest(l.tenant_ids) t(pid)
      where l.property_id=$1 and l.lease_status='active' limit 1`, [PROP])).rows[0];
  if (resident) {
    const r = await resolveRelationshipStage(pool, { personId: resident.person_id, propertyId: PROP });
    chk("active lease  → resident", r.stage === "resident" && r.basis === "active_lease", JSON.stringify(r));
  } else chk("active lease → resident", false, "no active lease with tenant_ids at this property");

  const future = (await pool.query(
    `select t.pid::text as person_id from leases l, unnest(l.tenant_ids) t(pid)
      where l.property_id=$1 and l.lease_status='pending'
        and not exists (select 1 from leases l2, unnest(l2.tenant_ids) t2(pid)
                         where l2.property_id=$1 and l2.lease_status='active' and t2.pid::text=t.pid::text)
      limit 1`, [PROP])).rows[0];
  if (future) {
    const r = await resolveRelationshipStage(pool, { personId: future.person_id, propertyId: PROP });
    chk("pending lease → future_resident", r.stage === "future_resident" && r.basis === "pending_lease", JSON.stringify(r));
  } else chk("pending lease → future_resident", false, "no pending-only tenant at this property");

  // person_id is NULLABLE on lease_applications and is null on 8 of 14 rows
  // live (1 of 7 on Demo). An application with no person can never reach a
  // Person Card or a People Index — reported below, not silently skipped.
  const orphanApps = (await pool.query(
    `select count(*)::int n from lease_applications where property_id=$1 and person_id is null`,
    [PROP])).rows[0].n;
  const applicant = (await pool.query(
    `select a.person_id from lease_applications a
      where a.property_id=$1 and a.person_id is not null
        and not exists (select 1 from leases l, unnest(l.tenant_ids) t(pid)
                         where l.property_id=$1 and t.pid::text=a.person_id::text)
      limit 1`, [PROP])).rows[0];
  if (applicant) {
    const r = await resolveRelationshipStage(pool, { personId: applicant.person_id, propertyId: PROP });
    chk("application (no lease) → applicant", r.stage === "applicant" && r.basis === "application", JSON.stringify(r));
  } else chk("application (no lease) → applicant", false, "no lease-free applicant at this property");
  console.log(`  · note: ${orphanApps} application(s) here have person_id NULL — unreachable by any person-scoped read`);

  const prospect = (await pool.query(
    `select ll.person_id from leasing_leads ll
      where ll.property_id=$1
        and not exists (select 1 from lease_applications a where a.person_id=ll.person_id and a.property_id=$1)
        and not exists (select 1 from leases l, unnest(l.tenant_ids) t(pid)
                         where l.property_id=$1 and t.pid::text=ll.person_id::text)
      limit 1`, [PROP])).rows[0];
  if (prospect) {
    const r = await resolveRelationshipStage(pool, { personId: prospect.person_id, propertyId: PROP });
    chk("lead only → prospect", r.stage === "prospect" && r.basis === "presence", JSON.stringify(r));
  } else chk("lead only → prospect", false, "no lead-only person at this property");

  // ── 2. HONEST BLANK — absence is never a default word ───────────────
  console.log("\n─── 2. honest blank, never a default ───");
  const nobody = "00000000-0000-0000-0000-0000000000ff";
  const rn = await resolveRelationshipStage(pool, { personId: nobody, propertyId: PROP });
  chk("no presence → stage null (not 'prospect')", rn.stage === null && rn.basis === null, JSON.stringify(rn));
  const rmissing = await resolveRelationshipStage(pool, { personId: null, propertyId: PROP });
  chk("missing person_id → stage null, no throw", rmissing.stage === null);

  // ── 3. FALSIFIABILITY — the resolver must DISAGREE with the old rule ─
  console.log("\n─── 3. proven to fail against pre-fix logic ───");
  const people = (await pool.query(
    `select distinct person_id from (
       select person_id from leasing_leads where property_id=$1
       union select person_id from lease_applications where property_id=$1
       union select t.pid::uuid from leases l, unnest(l.tenant_ids) t(pid) where l.property_id=$1
     ) u limit 400`, [PROP])).rows;
  let changed = 0, regressed = 0, formerEmitted = 0;
  const rank = (s) => (s === null ? -1 : STAGES.indexOf(s));
  for (const row of people) {
    const now = await resolveRelationshipStage(pool, { personId: row.person_id, propertyId: PROP });
    const old = await OLD_RULE(row.person_id, PROP);
    if (now.stage === "former_resident") formerEmitted++;
    if (now.stage && now.stage !== old) changed++;
    if (now.stage && rank(now.stage) < rank(old)) regressed++;
  }
  console.log(`  scanned ${people.length} people — ${changed} answers changed, ${regressed} regressed`);
  chk("resolver DISAGREES with pre-fix logic on real people (fix is load-bearing)", changed > 0, `changed=${changed}`);
  chk("NO person regresses to a less-advanced stage (strictly additive)", regressed === 0, `regressed=${regressed}`);
  chk("former_resident is NEVER emitted (not derivable, not faked)", formerEmitted === 0, `emitted=${formerEmitted}`);

  // ── 4. NOTHING STORED — the resolver writes no stage anywhere ────────
  console.log("\n─── 4. derived, never stored ───");
  const src = require("fs").readFileSync(require("path").join(__dirname, "../src/shared/relationship_stage.js"), "utf8");
  chk("resolver source contains no insert/update/delete", !/\b(insert|update|delete)\s/i.test(src));

  console.log(`\n═ RESULT: ${pass} passed, ${fail} failed ═`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async e => { console.error("STAGE PROOF ERROR:", e); try { await pool.end(); } catch (_) {} process.exit(1); });
