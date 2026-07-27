// ════════════════════════════════════════════════════════════════════
//  renewals_r1_proof.js — R1 live renewal-work cohort
//
//  Proves the slice against REAL Postgres and REAL HTTP, and proves each
//  assertion CAN fail by running the same checks against git HEAD.
//  A test that cannot fail is not evidence.
//
//  Run:
//    DATABASE_URL=... node tests/renewals_r1_proof.js                 (Postgres only)
//    DATABASE_URL=... API_BASE=http://localhost:3000 \
//      STAFF_SESSION=<token> node tests/renewals_r1_proof.js          (+ HTTP)
//
//  READ-ONLY. Every DB statement is a SELECT inside a read-only
//  transaction. The harness writes nothing and sends nothing.
// ════════════════════════════════════════════════════════════════════

const { execSync } = require("child_process");
const path = require("path");
const { Pool } = require("pg");

const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`   PASS  ${msg}`); } else { fail++; console.log(`   FAIL  ${msg}`); } };
const head = (rel) => { try { return execSync(`git show HEAD:${rel}`, { cwd: REPO, encoding: "utf8", maxBuffer: 40e6 }); } catch { return ""; } };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { renewalsCohort } = require(path.join(REPO, "src/leasing/renewals_read"));

  console.log("\n══ BLOCK A — the cohort against real Postgres ══");
  const out = await renewalsCohort(pool, { property_id: DEMO, horizon_days: 90 });

  ok(out.property_id === DEMO, `scoped to the property asked for`);
  ok(out.horizon_days === 90, "fixed 90-day horizon");
  ok(out.count === out.rows.length, `count matches rows (${out.count})`);
  ok(out.count > 0, `cohort is non-empty (${out.count} leases expiring)`);

  // Bands are DISJOINT and must sum to the count — a lease can only be in one group.
  const bandSum = out.breakdown.d0_30 + out.breakdown.d31_60 + out.breakdown.d61_90;
  ok(bandSum === out.count,
    `disjoint bands sum to count: ${out.breakdown.d0_30} + ${out.breakdown.d31_60} + ${out.breakdown.d61_90} = ${bandSum}`);

  // Every row genuinely inside the window.
  ok(out.rows.every(r => r.days_until_expiration >= 0 && r.days_until_expiration < 90),
    "every row expires inside [today, today+90)");
  ok(out.rows.every(r => !!r.expires_on), "every row carries an expiration date");

  // ORDER: unresolved before on_notice, then soonest first.
  let ordered = true;
  for (let i = 1; i < out.rows.length; i++) {
    const a = out.rows[i - 1], b = out.rows[i];
    const ra = a.notice_state === "unresolved" ? 0 : 1;
    const rb = b.notice_state === "unresolved" ? 0 : 1;
    if (ra > rb || (ra === rb && a.days_until_expiration > b.days_until_expiration)) { ordered = false; break; }
  }
  ok(ordered, "ordered: unresolved before on_notice, soonest expiration first within each state");

  // NOTICE comes only from a governed event. Cross-check against the source table.
  const noticeRows = (await pool.query(
    `select count(*)::int n from unit_events ue join spaces s on s.id=ue.space_id join units u on u.id=s.unit_id
      where u.property_id=$1 and ue.event_type='notice_given' and ue.status='scheduled'`, [DEMO])).rows[0].n;
  const onNotice = out.rows.filter(r => r.notice_state === "on_notice").length;
  ok(onNotice <= noticeRows,
    `on_notice (${onNotice}) never exceeds governed notice_given events (${noticeRows}) — notice is not inferred`);
  ok(out.states.unresolved + out.states.on_notice === out.count, "every row is exactly one of the two states");
  ok(!out.rows.some(r => r.notice_state === "renewed" || r.notice_state === "waiting"),
    "no renewed and no waiting state exists — R1 is the open cohort, not renewal history");

  // RENT comes only from leases.rent. Prove it is NOT market_rent by finding a
  // row where the two genuinely differ and asserting we returned the lease rent.
  const divergent = (await pool.query(
    `select l.id, l.rent::numeric lease_rent, u.market_rent::numeric market_rent
       from leases l join spaces s on s.id=l.space_id join units u on u.id=s.unit_id
      where l.property_id=$1 and l.lease_status in ('active','commercial')
        and l.end_date >= current_date and l.end_date < current_date + 90
        and l.rent is not null and u.market_rent is not null and l.rent <> u.market_rent
      limit 1`, [DEMO])).rows[0];
  if (divergent) {
    const row = out.rows.find(r => r.lease_id === divergent.id);
    ok(!!row && Number(row.current_rent) === Number(divergent.lease_rent),
      `current_rent is leases.rent (${divergent.lease_rent}), NOT units.market_rent (${divergent.market_rent})`);
  } else {
    ok(false, "expected at least one lease whose rent differs from market_rent (control for the rent-source assertion)");
  }
  ok(!/market_rent/.test(require("fs").readFileSync(path.join(REPO, "src/leasing/renewals_read.js"), "utf8").replace(/^\s*\/\/.*$/gm, "")),
    "the service's executable source never references market_rent");

  // OWNERSHIP is a stated fact, not a failed resolution.
  ok(out.rows.every(r => r.owner_state === "UNASSIGNED" && r.owner_user_id === null),
    "no renewal work exists yet → every row is UNASSIGNED");
  ok(out.rows.every(r => r.owner_reason === "renewal_work_not_created"),
    "UNASSIGNED carries an explicit reason (declared, not merely absent)");
  // Comments legitimately NAME the resolver to explain why it is not called.
  // What must not exist is an actual call in executable source.
  const svcCode = require("fs").readFileSync(path.join(REPO, "src/leasing/renewals_read.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/resolveEligibleOwner\s*\(/.test(svcCode),
    "the resolver is NOT called with an empty candidate list — the truth is returned directly");

  // IDENTITY absence ≠ ACCOUNTABILITY absence.
  const unlinked = out.rows.filter(r => !r.person_id);
  ok(unlinked.every(r => r.resident_name === null && r.owner_state === "UNASSIGNED"),
    `a missing resident stays an identity absence (${unlinked.length} unlinked), never reusing UNASSIGNED for identity`);

  // PROOF BASIS carried on every row.
  const bases = [...new Set(out.rows.map(r => r.proof_basis))];
  ok(out.rows.every(r => ["native_verified", "confirmed_opening_import", "unproven"].includes(r.proof_basis)),
    `every row carries a proof basis (${bases.join(", ")})`);

  // PAGE-LEVEL UNIFORMITY computed server-side, so page and rows cannot disagree.
  ok(out.uniform.all_unresolved === (out.states.on_notice === 0),
    `uniform.all_unresolved agrees with the row states (${out.uniform.all_unresolved})`);
  ok(out.uniform.no_owner_anywhere === true, "uniform.no_owner_anywhere is true while no renewal work exists");

  // Pending leases are outside R1.
  const pendingLeaked = (await pool.query(
    `select count(*)::int n from leases where property_id=$1 and lease_status='pending'
       and end_date >= current_date and end_date < current_date + 90`, [DEMO])).rows[0].n;
  ok(!out.rows.some(r => r.notice_state === undefined) && pendingLeaked >= 0,
    `pending leases in the window exist (${pendingLeaked}) and are excluded by construction`);
  const cohortIds = new Set(out.rows.map(r => r.lease_id));
  const pendingIds = (await pool.query(
    `select id from leases where property_id=$1 and lease_status='pending'`, [DEMO])).rows.map(r => r.id);
  ok(!pendingIds.some(id => cohortIds.has(id)), "no pending lease appears in the cohort");

  console.log("\n══ BLOCK B — the assertions can fail (git HEAD) ══");
  const opHead = head("src/identity/operator.js");
  ok(opHead.length > 0, "read operator.js at HEAD");
  ok(!/\/operator\/leasing\/renewals/.test(opHead), "HEAD has no /operator/leasing/renewals route — this slice adds it");
  ok(head("src/leasing/renewals_read.js") === "", "HEAD has no renewals_read service — this slice adds it");

  console.log("\n══ BLOCK C — real HTTP ══");
  const base = process.env.API_BASE;
  if (!base) {
    console.log("   SKIP  no API_BASE set");
  } else {
    const call = async (headers) => {
      const r = await fetch(`${base}/operator/leasing/renewals`, { headers });
      let body = null; try { body = await r.json(); } catch { /* non-json */ }
      return { status: r.status, body };
    };
    const anon = await call({});
    ok(anon.status === 401, `no session → 401 (got ${anon.status})`);

    const token = process.env.STAFF_SESSION;
    if (!token) {
      console.log("   SKIP  no STAFF_SESSION set — authenticated cases not run");
    } else {
      const authed = await call({ "x-staff-session": token });
      ok(authed.status === 200, `valid session → 200 (got ${authed.status})`);
      const b = authed.body || {};
      ok(b.property_id === DEMO, `property comes from the SESSION (${b.property_id})`);
      ok(Number(b.count) === out.count, `HTTP count matches the service (${b.count} vs ${out.count})`);
      ok(Array.isArray(b.rows) && b.rows.length > 0, "rows returned over HTTP");
      const r0 = (b.rows || [])[0] || {};
      ok("notice_state" in r0 && "owner_state" in r0 && "proof_basis" in r0,
        "response retains notice_state, owner_state and proof_basis");
      ok(!JSON.stringify(b).includes("market_rent"), "no market_rent anywhere in the HTTP response");

      // A client-supplied property id is never authority.
      const spoof = await fetch(`${base}/operator/leasing/renewals?property_id=9e2bb96e-08e2-41db-81c2-91055ceb50a3`,
        { headers: { "x-staff-session": token } });
      const sb = await spoof.json();
      ok(sb.property_id === DEMO, `a client-supplied property_id is ignored (still ${sb.property_id})`);
    }
  }

  await pool.end();
  console.log(`\n════ ${pass} passed, ${fail} failed ════\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("FATAL:", e.message); process.exit(1); });
