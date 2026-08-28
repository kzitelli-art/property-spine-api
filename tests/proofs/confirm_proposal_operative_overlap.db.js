/* ════════════════════════════════════════════════════════════════════
   confirm_proposal_operative_overlap.db.js — THE CANONICAL LEASE WRITER
   MAY NOT DOUBLE-BOOK A BED.

   ── THE HOLE THIS CLOSES ────────────────────────────────────────────
   `confirmProposal` inserted a lease unconditionally. `leases` carries
   only a plain index on space_id (001_baseline:145), so confirming a
   newer rent roll against a bed that already had a lease created a
   SECOND tenancy on it — no refusal, no constraint, no trace, and every
   economic read downstream reading two residents where there is one.

   The rule was never missing from Spine. It was in
   executed_lease_service §2b and nowhere else, which is why the writer
   that needed it did not have it.

   ── WHAT IS PROVEN HERE ─────────────────────────────────────────────
   The DENY-list, one arm at a time, because the failure mode of an
   allow-list is silent:

       active      blocks        cancelled   confirms
       pending     blocks        expired     confirms
       signed      blocks        disjoint dates  confirms

   plus: several competitors on one bed are ALL named; a vacant row is
   untouched by any of it; a blocked row creates no person and no lease;
   and the blocked row lands in `needs_review`, which is the status
   establishOpeningPosition actually counts as unresolved.

   ── WHAT IT DELIBERATELY DOES NOT PROVE ─────────────────────────────
   It does not prove which competing claim wins. Nothing in this build
   decides that; the refusal exists precisely because a person decides it
   from source evidence.

   CLASS 3 — proof infrastructure.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const receipt = require("../_run_receipt.js");
const CONN = receipt.harnessConnectionString();
const { Pool } = require("pg");
const activation = require("../../src/onboarding/activation_service.js");
const { OPERATIVE_OVERLAP_SQL, RETIRED_STATUSES } =
  require("../../src/tenancy/operative_overlap.js");

const HARNESS = "confirm_proposal_operative_overlap.db.js";
const EXPECTED = 48;

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log("  ok    " + label); passed++; }
  else { console.log("  FAIL  " + label + (detail ? "  →  " + detail : "")); failed++; }
};

const TERM = { from: "2026-08-01", to: "2027-07-31" };

(async () => {
  receipt.begin(HARNESS, { url: CONN, expected: EXPECTED });
  const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

  try {
    // ══ 0. THE PREDICATE ITSELF ══════════════════════════════════════
    console.log("\n  ── the shared predicate ──");
    for (const s of ["cancelled", "terminated", "rescinded", "void", "expired", "superseded"]) {
      ok(`'${s}' is retired in the shared list`, RETIRED_STATUSES.includes(s));
    }
    ok("the SQL denies exactly that list, and is not an allow-list",
      RETIRED_STATUSES.every((s) => OPERATIVE_OVERLAP_SQL.includes(`'${s}'`))
      && /not in \(/.test(OPERATIVE_OVERLAP_SQL)
      && !/lease_status in \(/.test(OPERATIVE_OVERLAP_SQL));
    ok("'pending' is NOT retired — it is operative",
      !RETIRED_STATUSES.includes("pending"));
    ok("'signed' is NOT retired — the allow-list bug, pinned",
      !RETIRED_STATUSES.includes("signed"));

    // ══ 1. A REAL PROPERTY, DEAL, ACTOR AND ACTIVATION ═══════════════
    const org = (await pool.query(
      `insert into organizations (name) values ('Overlap Proof Co') returning id`)).rows[0].id;
    const user = (await pool.query(
      `insert into users (name, email, is_active, status, platform_role, organization_id)
       values ('Overlap Proof Operator', $1, true, 'active', 'super_admin', $2) returning id`,
      [`overlap-${Date.now()}@example.invalid`, org])).rows[0].id;
    const prop = (await pool.query(
      `insert into properties (name, address, organization_id, leasing_basis)
       values ('Overlap Proof Property','1 Proof Way',$1,'bed') returning id`, [org])).rows[0].id;
    const deal = (await pool.query(
      `insert into deal_intakes (onboarding_type, status, deal_name, organization_id)
       values ('existing_asset','classified','Overlap Proof Deal',$1) returning id`, [org])).rows[0].id;
    await pool.query(
      `insert into deal_intake_properties (intake_id, property_id, status) values ($1,$2,'current')`,
      [deal, prop]);
    const opened = await activation.openActivation(pool, {
      user_id: user, deal_intake_id: deal, property_id: prop, source_label: "overlap proof" });
    const activationId = opened.activation.id;
    ok("a real activation opened through the canonical writer", !!activationId);

    //  Beds. trg_unit_space auto-creates one '(whole unit)' space per unit;
    //  a bed-grain property has none, so it is removed exactly as the real
    //  inventory correction did.
    const bedOf = new Map();
    for (const unitNumber of ["101", "102", "103", "104", "105", "106", "107", "108"]) {
      const u = (await pool.query(
        `insert into units (property_id, unit_number) values ($1,$2) returning id`,
        [prop, unitNumber])).rows[0].id;
      await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
      const s = (await pool.query(
        `insert into spaces (unit_id, space_label) values ($1,'Room1') returning id`, [u])).rows[0].id;
      bedOf.set(unitNumber, s);
    }

    const putLease = (unitNumber, status, from = TERM.from, to = TERM.to) =>
      pool.query(
        `insert into leases (property_id, space_id, rent, lease_status, start_date, end_date, tenant_ids)
         values ($1,$2,900,$3,$4,$5,'{}') returning id`,
        [prop, bedOf.get(unitNumber), status, from, to]).then((r) => r.rows[0].id);

    const propose = async (unitNumber, over = {}) => {
      const n = { unit_number: unitNumber, space_label: "Room1",
        tenant_name: `Resident ${unitNumber}`, rent: 1200,
        start_date: TERM.from, end_date: TERM.to, ...over };
      return (await pool.query(
        `insert into proposed_records
           (activation_id, property_id, module, target_type, natural_key, normalized_json, status)
         values ($1,$2,'leasing','lease',$3,$4,'staged') returning id`,
        [activationId, prop, `${unitNumber}|Room1-${Math.random()}`, JSON.stringify(n)])).rows[0].id;
    };

    const confirm = async (id) => {
      try { return { out: await activation.confirmProposal(pool, { user_id: user, proposed_id: id }) }; }
      catch (e) { return { err: e }; }
    };
    const statusOf = async (id) => (await pool.query(
      `select status, status_reason from proposed_records where id=$1`, [id])).rows[0];
    const leaseCount = async (unitNumber) => Number((await pool.query(
      `select count(*)::int c from leases where space_id=$1`, [bedOf.get(unitNumber)])).rows[0].c);

    // ══ 2. EVERY OPERATIVE ARM BLOCKS ════════════════════════════════
    console.log("\n  ── operative statuses block ──");
    for (const [unitNumber, status] of [["101", "active"], ["102", "pending"], ["103", "signed"]]) {
      const competitor = await putLease(unitNumber, status);
      const before = await leaseCount(unitNumber);
      const p = await propose(unitNumber);
      const { out, err } = await confirm(p);
      const st = await statusOf(p);
      ok(`${status}: confirm refuses`, !out && err && err.reason === "overlapping_operative_lease",
        err ? err.reason : "no refusal");
      ok(`${status}: proposal is needs_review`, st.status === "needs_review", st.status);
      ok(`${status}: the reason names the competing lease id`,
        String(st.status_reason || "").includes(competitor));
      ok(`${status}: the reason names its status and term`,
        String(st.status_reason || "").includes(status)
        && String(st.status_reason || "").includes("2026-08-01"));
      ok(`${status}: NO lease was created`, (await leaseCount(unitNumber)) === before,
        `${await leaseCount(unitNumber)} vs ${before}`);
    }

    // ══ 3. EVERY RETIRED ARM CONFIRMS ════════════════════════════════
    console.log("\n  ── retired statuses do not block ──");
    for (const [unitNumber, status] of [["104", "cancelled"], ["105", "expired"]]) {
      await putLease(unitNumber, status);
      const p = await propose(unitNumber);
      const { out, err } = await confirm(p);
      ok(`${status}: confirm proceeds`, !!out && !!out.lease_id, err ? err.message : "no lease");
      ok(`${status}: the bed now holds the new lease`, (await leaseCount(unitNumber)) === 2);
    }

    // ══ 4. THE DATE HALF OF THE RULE ═════════════════════════════════
    console.log("\n  ── dates are half the rule ──");
    await putLease("106", "active", "2025-08-01", "2026-06-30");   // ends before ours starts
    const disjoint = await propose("106");
    const dj = await confirm(disjoint);
    ok("an ACTIVE lease with disjoint dates does not block", !!dj.out && !!dj.out.lease_id,
      dj.err ? dj.err.reason : "");
    ok("…and the confirm really wrote a second, non-overlapping lease",
      (await leaseCount("106")) === 2);

    // ══ 5. SEVERAL COMPETITORS ON ONE BED ════════════════════════════
    console.log("\n  ── more than one competing claim ──");
    const c1 = await putLease("107", "active");
    const c2 = await putLease("107", "pending");
    const many = await propose("107");
    const mr = await confirm(many);
    const manySt = await statusOf(many);
    ok("both competing leases are named, not just the first",
      String(manySt.status_reason || "").includes(c1)
      && String(manySt.status_reason || "").includes(c2), manySt.status_reason);
    ok("the refusal carries both competing leases structurally",
      !!mr.err && Array.isArray(mr.err.competing) && mr.err.competing.length === 2,
      mr.err ? JSON.stringify(mr.err.competing || null) : "");
    ok("the reason counts them in plain words",
      /2 operative leases/.test(String(manySt.status_reason || "")), manySt.status_reason);

    // ══ 6. NO RESIDUE — NO PERSON IS MINTED BY A REFUSED ROW ═════════
    console.log("\n  ── a refused row leaves nothing behind ──");
    const personsBefore = Number((await pool.query(
      `select count(*)::int c from persons where name = 'Ghost Resident'`)).rows[0].c);
    await putLease("108", "active");
    const ghost = await propose("108", { tenant_name: "Ghost Resident" });
    const gr = await confirm(ghost);
    const personsAfter = Number((await pool.query(
      `select count(*)::int c from persons where name = 'Ghost Resident'`)).rows[0].c);
    ok("the refused row created no Person", personsAfter === personsBefore,
      `${personsBefore} → ${personsAfter}`);
    ok("…and the refusal is a sentence an operator can act on",
      !!gr.err && /already has a lease in force/.test(gr.err.message)
      && /marked for review/.test(gr.err.message), gr.err ? gr.err.message : "");
    ok("…and it names the bed, not an internal id",
      !!gr.err && gr.err.message.includes("Unit 108") && gr.err.message.includes("Room1"),
      gr.err ? gr.err.message : "");

    // ══ 7. VACANT ROWS ════════════════════════════════════════════════
    /*  ⚠ THIS SECTION ASSERTED THE OPPOSITE AND WAS WRONG.
     *
     *  It read "a vacant row on an OCCUPIED bed still promotes", and that
     *  passed, because at the time it was true. It was also the Skyline
     *  109A defect written down as intended behaviour: the July source
     *  called the bed empty, an April lease in force said someone lived
     *  there, and Spine confirmed the vacancy without saying the two
     *  disagreed.
     *
     *  A vacancy is a CLAIM. It can be contradicted, and being contradicted
     *  by a lease in force is not a detail — it is the whole question. The
     *  vacant path now refuses exactly as the occupied path does.
     *
     *  What has NOT changed, and is still asserted below: the wall is about
     *  contradiction, not about vacancy. A vacant row on a FREE bed
     *  promotes exactly as it always did, and still creates no lease.  */
    console.log("\n  ── a vacancy contradicted by a lease in force ──");
    const vacantBefore = await leaseCount("101");
    const vac = await propose("101", { tenant_name: null, is_vacant: true });
    const vr = await confirm(vac);
    ok("a vacant row on an OCCUPIED bed is REFUSED, not promoted",
      !vr.out && vr.err && vr.err.reason === "vacancy_contradicted_by_operative_lease",
      vr.err ? vr.err.reason : "it promoted");
    ok("…it is needs_review, not promoted",
      (await statusOf(vac)).status === "needs_review");
    ok("…and it still created no lease", (await leaseCount("101")) === vacantBefore);

    console.log("\n  ── a vacancy nobody contradicts is untouched ──");
    //  109 is a bed this harness never put a lease on.
    const freeUnit = "109";
    {
      const u = (await pool.query(
        `insert into units (property_id, unit_number) values ($1,$2) returning id`,
        [prop, freeUnit])).rows[0].id;
      await pool.query(`delete from spaces where unit_id=$1 and space_label='(whole unit)'`, [u]);
      const sp = (await pool.query(
        `insert into spaces (unit_id, space_label) values ($1,'Room1') returning id`, [u])).rows[0].id;
      bedOf.set(freeUnit, sp);
    }
    const vac2 = await propose(freeUnit, { tenant_name: null, is_vacant: true });
    const vr2 = await confirm(vac2);
    ok("a vacant row on a FREE bed still promotes", !!vr2.out && vr2.out.vacant === true,
      vr2.err ? vr2.err.reason : "");
    ok("…and creates no lease", vr2.out && vr2.out.lease_id === null
      && (await leaseCount(freeUnit)) === 0);
    ok("…and is 'promoted', so it counts as established",
      (await statusOf(vac2)).status === "promoted");

    // ══ 8. THE STATEMENT CAN SEE THEM ════════════════════════════════
    //  The whole point of needs_review over staged/rejected:
    //  establishOpeningPosition counts needs_review as unresolved, and
    //  counts neither of the other two at all.
    console.log("\n  ── establishOpeningPosition can see the held rows ──");
    const tally = (await pool.query(
      `select
         count(*) filter (where status='promoted')::int  as established,
         count(*) filter (where status in ('needs_review','blocked','conflicted'))::int as unresolved,
         count(*) filter (where status='staged')::int    as staged,
         count(*)::int as total
       from proposed_records where activation_id=$1`, [activationId])).rows[0];
    ok("every blocked row is counted as unresolved, none invisible",
      tally.unresolved === 6, JSON.stringify(tally));
    ok("no row was left 'staged' by a refusal", tally.staged === 0, JSON.stringify(tally));
    ok("established + unresolved accounts for every proposal",
      tally.established + tally.unresolved === tally.total, JSON.stringify(tally));

    // ══ 9. THE SECOND CONFIRM IS STILL REFUSED ══════════════════════
    //  A needs_review row is not blocked from being retried — and until
    //  the conflict is actually resolved, retrying must fail the same way.
    console.log("\n  ── retrying without resolving anything still refuses ──");
    const retry = await confirm(many);
    ok("re-confirming a held row refuses identically",
      !!retry.err && retry.err.reason === "overlapping_operative_lease",
      retry.err ? retry.err.reason : "it succeeded");
    ok("…and still created no lease", (await leaseCount("107")) === 2);

  } catch (e) {
    console.error("\n  HARNESS ERROR:", e && e.stack ? e.stack : e);
    failed++;
  } finally {
    await pool.end();
  }

  console.log(`\n  ${failed === 0 ? "ALL PASS" : "FAILURES PRESENT"}   ${passed}/${passed + failed}`);
  receipt.complete({ harness: HARNESS, passed, failed, expectedAtLeast: EXPECTED });
  process.exit(failed === 0 ? 0 : 1);
})();
