#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  slice10b_dated_position_rows_proof.js — THE ROW ENGINE, adversarially.
//
//  Real Postgres. SYNTHETIC records only — no production resident, lease,
//  work-order or call data of any kind enters this harness.
//
//  Fixtures are written to be capable of FOOLING the implementation author:
//  each geometry places correct facts beside other correct facts that could
//  be read as contradictory, or that a first-match implementation would get
//  wrong. Every case asserts BOTH what must appear and what must be withheld.
//
//  Requires HARNESS_DATABASE_URL, and REFUSES a value that resolves to the
//  same target as DATABASE_URL — see the connection note below.
// ════════════════════════════════════════════════════════════════════
"use strict";
const path = require("path");
const { Pool } = require("pg");
const receipt = require(path.join(__dirname, "_run_receipt"));
const { datedPositionRows, denominatorClass, EVIDENCE_STATE, RESULT_STATE } = require(path.join(__dirname, "..", "src/tenancy/dated_position_rows"));

//  THE GOVERNED HELPER, not a local check. This harness previously compared
//  the two URLs as STRINGS, which is a weaker rule than it looks: a different
//  user, a trailing slash, an extra query parameter, or localhost vs
//  127.0.0.1 all defeat string equality while still resolving to the same
//  database. harnessConnectionString() parses host, port and database and
//  refuses on the resolved target. Requiring the variable is not the same as
//  refusing the wrong value.
const CONN = receipt.harnessConnectionString();

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log("   PASS  " + msg); } else { fail++; console.log("   FAIL  " + msg); } };
const section = (s) => console.log("\n── " + s + " " + "─".repeat(Math.max(0, 60 - s.length)));

const TARGET = "2026-09-01";

(async () => {
  const pool = new Pool({ connectionString: CONN, ssl: false });
  const c = await pool.connect();
  const one = async (q, a = []) => (await c.query(q, a)).rows[0];
  let F = {};
  try {
    await c.query("begin");
    const A = (await one(`insert into properties (name, operating_timezone) values ('10B Rows Tower','America/Los_Angeles') returning id`)).id;
    const B = (await one(`insert into properties (name, operating_timezone) values ('10B Rows Neighbour','America/New_York') returning id`)).id;
    const NOTZ = (await one(`insert into properties (name) values ('10B No Timezone') returning id`)).id;
    const person = (await one(`insert into persons (name, lifecycle_status) values ('10B Synthetic Tenant','tenant') returning id`)).id;
    const user = (await one(`insert into users (name,email,phone,role,is_active,status)
      values ('10B Classifier',$1,$2,'property_manager',true,'active') returning id`,
      [`10b-${Date.now()}@rows.test`, "+1724" + String(Date.now()).slice(-7)])).id;

    //  Each named space is one geometry. The unit auto-creates its space.
    const mkSpace = async (prop, num, use_type) => {
      const unit = (await one(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [prop, num])).id;
      let sp = (await c.query(`select id from spaces where unit_id=$1`, [unit])).rows[0];
      if (!sp) sp = await one(`insert into spaces (unit_id) values ($1) returning id`, [unit]);
      if (use_type !== undefined) {
        await c.query(`update spaces set use_type=$2, classified_by_user_id=$3, classified_at=now(),
                       classification_source='proof' where id=$1`, [sp.id, use_type, user]);
      }
      return sp.id;
    };
    const mkLease = (prop, space, start, end, status, rent) => c.query(
      `insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
       values ($1,$2,$3,$4,$5,$6,$7)`, [prop, space, [person], rent, start, end, status]);

    F.A = A; F.B = B; F.NOTZ = NOTZ; F.user = user;
    // ── denominator geometries ──
    F.resid   = await mkSpace(A, "R-1", "residential");
    F.comm    = await mkSpace(A, "C-1", "commercial");
    F.nonrev  = await mkSpace(A, "N-1", "non_revenue");
    F.other   = await mkSpace(A, "O-1", "other");
    F.unclass = await mkSpace(A, "U-1", null);
    await mkLease(A, F.resid,  "2026-01-01", "2026-12-31", "active", 1500);
    await mkLease(A, F.comm,   "2026-01-01", "2026-12-31", "active", 4000);
    //  ADVERSARIAL: a non-revenue space carrying a stale but valid lease.
    await mkLease(A, F.nonrev, "2026-01-01", "2026-12-31", "active", 999);
    await mkLease(A, F.other,  "2026-01-01", "2026-12-31", "active", 1100);
    await mkLease(A, F.unclass,"2026-01-01", "2026-12-31", "active", 1200);

    // ── conflict geometries ──
    F.two   = await mkSpace(A, "X-2", "residential");
    F.three = await mkSpace(A, "X-3", "residential");
    F.term  = await mkSpace(A, "X-T", "residential");
    F.sameday = await mkSpace(A, "X-S", "residential");
    await mkLease(A, F.two, "2026-01-01", "2026-12-31", "active", 1000);
    await mkLease(A, F.two, "2026-06-01", "2027-05-31", "active", 2000);      // overlaps
    await mkLease(A, F.three, "2026-01-01", "2026-12-31", "active", 1000);
    await mkLease(A, F.three, "2026-06-01", "2027-05-31", "active", 2000);
    await mkLease(A, F.three, "2026-08-01", "2026-10-31", "active", 3000);    // three-way
    //  ADVERSARIAL: a TERMINAL lease overlapping a live one must not conflict.
    await mkLease(A, F.term, "2026-01-01", "2026-12-31", "active", 1300);
    await mkLease(A, F.term, "2026-06-01", "2027-05-31", "terminated", 9999);
    //  ADVERSARIAL: same-day end/start boundary — inclusive semantics preserved.
    await mkLease(A, F.sameday, "2026-01-01", "2026-09-01", "active", 1400);
    await mkLease(A, F.sameday, "2026-09-01", "2027-08-31", "active", 1600);

    // ── economics geometries ──
    F.dated   = await mkSpace(A, "E-D", "residential");
    F.step    = await mkSpace(A, "E-S", "residential");
    F.conc    = await mkSpace(A, "E-C", "residential");
    F.legacyIn  = await mkSpace(A, "E-LI", "residential");
    F.legacyOut = await mkSpace(A, "E-LO", "residential");
    F.norent  = await mkSpace(A, "E-N", "residential");
    F.econConflict = await mkSpace(A, "E-X", "residential");
    await mkLease(A, F.dated, "2026-01-01", "2026-12-31", "active", 1111);   // leases.rent must LOSE
    await mkLease(A, F.step,  "2026-01-01", "2026-12-31", "active", 1111);
    await mkLease(A, F.conc,  "2026-01-01", "2026-12-31", "active", 1111);
    await mkLease(A, F.legacyIn,  "2026-09-01", "2027-08-31", "active", 1750); // starts ON the target, in its opening month
    await mkLease(A, F.legacyOut, "2026-01-01", "2026-12-31", "active", 1800); // started long before
    await mkLease(A, F.norent, "2026-01-01", "2026-12-31", "active", null);
    await mkLease(A, F.econConflict, "2026-01-01", "2026-12-31", "active", 1111);
    //  ADVERSARIAL: market_rent is present and must NEVER be used.
    await c.query(`update units set market_rent=9876 where property_id=$1`, [A]);

    const app = (await one(`insert into lease_applications (property_id, person_id, status)
      values ($1,$2,'approved') returning id`, [A, person])).id;
    //  A draft offer scoped to the property satisfies both offer constraints
    //  (draft needs no evidence; scope-XOR-space needs exactly one target).
    const offer = (await one(
      `insert into lease_offers (property_id, person_id, status, source, scope,
         offered_terms_snapshot, authority_basis_snapshot, granted_by_person_id)
       values ($1,$2,'draft','discretionary','property','{}'::jsonb,'{}'::jsonb,$3) returning id`,
      [A, person, person])).id;
    //  uq_les_application_live: one live schedule per application, so each
    //  geometry gets its own application rather than sharing one.
    const mkSched = async (space) => {
      const a = (await one(`insert into lease_applications (property_id, person_id, status)
        values ($1,$2,'approved') returning id`, [A, person])).id;
      return (await one(
        `insert into lease_economic_schedules (property_id, application_id, space_id, status,
           source_offer_id, locked_by_person_id) values ($1,$2,$3,'locked',$4,$5) returning id`,
        [A, a, space, offer, person])).id;
    };
    void app;
    const mkLine = (sched, ym, type, amt) => c.query(
      `insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
       values ($1,$2::date,$3,$4)`, [sched, ym + "-01", type, amt]);

    const sD = await mkSched(F.dated);  await mkLine(sD, "2026-09", "base_rent", 2500);
    //  a genuine dated STEP: month 1 differs from the target month.
    const sS = await mkSched(F.step);
    await mkLine(sS, "2026-01", "base_rent", 1111);
    await mkLine(sS, "2026-09", "base_rent", 1999);
    const sC = await mkSched(F.conc);
    await mkLine(sC, "2026-09", "base_rent", 2000);
    await mkLine(sC, "2026-09", "concession_credit", -300);
    //  a one-time fee in the same month must NOT change monthly contract rent.
    await mkLine(sC, "2026-09", "one_time_fee", 250);
    const sX = await mkSched(F.econConflict);
    await mkLine(sX, "2026-09", "base_rent", 2100);
    await mkLine(sX, "2026-09", "base_rent", 2600);   // two applicable base rents

    // ── obligation geometries ──
    F.obActive   = await mkSpace(A, "OB-A", "residential");
    F.obUnassign = await mkSpace(A, "OB-U", "residential");
    F.obOverdue  = await mkSpace(A, "OB-O", "residential");
    F.obDone     = await mkSpace(A, "OB-D", "residential");
    F.obTwo      = await mkSpace(A, "OB-2", "residential");
    F.obNoDest   = await mkSpace(A, "OB-N", "residential");
    F.obXProp    = await mkSpace(A, "OB-X", "residential");
    const leaseFor = async (space, prop) => {
      await mkLease(prop || A, space, "2026-01-01", "2026-12-31", "active", 1500);
      return (await one(`select id from leases where space_id=$1 order by created_at desc limit 1`, [space])).id;
    };
    F.lActive   = await leaseFor(F.obActive);
    F.lUnassign = await leaseFor(F.obUnassign);
    F.lOverdue  = await leaseFor(F.obOverdue);
    F.lDone     = await leaseFor(F.obDone);
    F.lTwo      = await leaseFor(F.obTwo);
    F.lNoDest   = await leaseFor(F.obNoDest);
    F.lXProp    = await leaseFor(F.obXProp);
    const mkObl = async (prop, lease, type, status, due, owner, label) => (await one(
      `insert into obligations (property_id, module, type, status, related_id, related_type, due_at, assigned_user_id, label)
       values ($1,'leasing',$2,$3,$4,'lease',$5,$6,$7) returning id`,
      [prop, type, status, lease, due, owner, label])).id;
    F.oActive   = await mkObl(A, F.lActive, 'resolve_inbound_opportunity', 'open', '2099-01-01', user, 'Resolve the inbound reply');
    F.oUnassign = await mkObl(A, F.lUnassign, 'resolve_inbound_opportunity', 'open', '2099-01-01', null, 'Resolve the inbound reply');
    F.oOverdue  = await mkObl(A, F.lOverdue, 'resolve_inbound_opportunity', 'open', '2020-01-01', user, 'Resolve the inbound reply');
    F.oDone     = await mkObl(A, F.lDone, 'resolve_inbound_opportunity', 'complete', '2020-01-01', user, 'Already handled');
    await mkObl(A, F.lTwo, 'resolve_inbound_opportunity', 'open', '2099-01-01', user, 'First');
    await mkObl(A, F.lTwo, 'resolve_inbound_opportunity', 'in_progress', '2099-01-01', user, 'Second');
    F.oNoDest   = await mkObl(A, F.lNoDest, 'lease_review', 'open', '2099-01-01', user, 'Review the lease');
    //  ADVERSARIAL: an obligation on property B pointing at a property-A lease.
    F.oXProp    = await mkObl(B, F.lXProp, 'resolve_inbound_opportunity', 'open', '2099-01-01', user, 'Wrong property');

    // ── neighbouring-property noise ──
    F.bSpace = await mkSpace(B, "B-1", "residential");
    await mkLease(B, F.bSpace, "2026-01-01", "2026-12-31", "active", 7777);

    await c.query("commit");
  } catch (e) { await c.query("rollback"); c.release(); await pool.end(); throw e; }
  c.release();

  const byId = (rows) => new Map(rows.map((r) => [String(r.space_id), r]));
  const out = await datedPositionRows(pool, { property_id: F.A, as_of: TARGET });
  const R = byId(out.rows);
  const row = (id) => R.get(String(id));

  const noTzEarly = await datedPositionRows(pool, { property_id: F.NOTZ });
  console.log("\n════ SLICE 10B — DATED POSITION ROWS (synthetic data only) ════");

  section("A  denominator class, from the governed spaces.use_type authority");
  ok("residential → revenue", row(F.resid).denominator_class === "revenue");
  ok("commercial  → revenue (governed: MARKETABLE_USE_TYPES = residential+commercial)",
    row(F.comm).denominator_class === "revenue");
  ok("non_revenue → non_revenue", row(F.nonrev).denominator_class === "non_revenue");
  ok("'other'     → unknown, never quietly revenue", row(F.other).denominator_class === "unknown");
  ok("unclassified (NULL) → unknown", row(F.unclass).denominator_class === "unknown");
  ok("pure mapping agrees at every input",
    denominatorClass("residential") === "revenue" && denominatorClass("commercial") === "revenue"
    && denominatorClass("non_revenue") === "non_revenue" && denominatorClass("other") === "unknown"
    && denominatorClass(null) === "unknown");
  ok("classification provenance is preserved",
    row(F.resid).classified_by_user_id === F.user && !!row(F.resid).classified_at);
  ok("an unknown denominator reports coverage.denominator = unknown",
    row(F.unclass).coverage.denominator === "unknown");
  //  ADVERSARIAL: the stale lease on a non-revenue space must not promote it.
  ok("a non_revenue space carrying a live lease stays non_revenue",
    row(F.nonrev).denominator_class === "non_revenue" && row(F.nonrev).governing_lease_id !== null);
  //  ADVERSARIAL: an unknown denominator must not erase a proven position.
  ok("unknown denominator does NOT erase the proven occupancy fact",
    row(F.unclass).governing_lease_id !== null && row(F.unclass).coverage.occupancy === "complete");

  //  REGRESSION. position_state was null on every non-conflicted row because
  //  dated_positions does not carry future_state; 89 assertions missed it
  //  because only the conflict case was ever checked. This is the direct guard.
  ok("A0  a clean non-conflicted row NEVER returns position_state: null",
    out.rows.filter((r) => r.conflict_state !== "conflicted")
      .every((r) => typeof r.position_state === "string" && r.position_state.length > 0));

  section("B  conflict integrity — no first-match may win");
  const two = row(F.two), three = row(F.three);
  ok("two-way overlap is a conflict", two.position_state === "conflict" && two.conflict_state === "conflicted");
  ok("a conflicted row names NO governing lease", two.governing_lease_id === null);
  ok("a conflicted row publishes NO rent", two.contractual_rent === null);
  ok("and says so via rent_authority=conflict", two.rent_authority === "conflict");
  ok("both conflicting lease ids are preserved", (two.conflicting_lease_ids || []).length === 2);
  ok("three-way overlap preserves all three ids", (three.conflicting_lease_ids || []).length === 3);
  ok("a TERMINAL overlapping lease does not manufacture a conflict",
    row(F.term).conflict_state === "clear" && row(F.term).governing_lease_id !== null);
  ok("same-day end/start registers as a conflict under inclusive semantics (preserved, not changed)",
    row(F.sameday).conflict_state === "conflicted");
  ok("a conflicted row still reports its denominator class",
    two.denominator_class === "revenue" && two.coverage.denominator === "complete");

  section("C  contractual economics precedence");
  ok("a dated line WINS over leases.rent (2500, not 1111)",
    row(F.dated).contractual_rent === 2500 && row(F.dated).rent_authority === "dated_economic_line");
  ok("a dated STEP returns the target month's amount (1999, not the opening 1111)",
    row(F.step).contractual_rent === 1999);
  ok("a concession nets against base rent (2000 − 300 = 1700)",
    row(F.conc).contractual_rent === 1700);
  ok("a one-time fee does NOT enter monthly contract rent", row(F.conc).contractual_rent === 1700);
  ok("two applicable base rents → conflict, no amount selected",
    row(F.econConflict).contractual_rent === null && row(F.econConflict).rent_authority === "conflict");
  ok("legacy fallback inside the lease's opening month is complete",
    row(F.legacyIn).rent_authority === "legacy_lease_rent"
    && row(F.legacyIn).legacy_qualification === "within_initial_month"
    && row(F.legacyIn).coverage.rent === "complete");
  ok("legacy fallback BEYOND the provable period is partial, not confident",
    row(F.legacyOut).rent_authority === "legacy_lease_rent"
    && row(F.legacyOut).legacy_qualification === "beyond_provable_period"
    && row(F.legacyOut).coverage.rent === "partial");
  ok("a lease with no rent reports missing, never zero",
    row(F.norent).contractual_rent === null && row(F.norent).rent_authority === "missing");
  ok("market_rent (9876) is NEVER returned as contractual rent",
    !out.rows.some((r) => r.contractual_rent === 9876));
  ok("every row names its rent authority",
    out.rows.every((r) => ["dated_economic_line", "legacy_lease_rent", "missing", "conflict"].includes(r.rent_authority)));

  section("D2 agent-consumable contract: lineage, typed blockers, result class");
  //  "Which lease created this future rent change?" must be answerable from the
  //  row itself, not by re-querying.
  const stepRow = row(F.step);
  ok("a dated amount names the schedule that produced it",
    stepRow.rent_lineage.length > 0 && !!stepRow.rent_lineage[0].schedule_id);
  ok("and the application/offer lineage behind that schedule",
    !!stepRow.rent_lineage[0].application_id && !!stepRow.rent_lineage[0].source_offer_id);
  ok("and the effective month the amount belongs to",
    stepRow.rent_lineage.some((l) => l.effective_month === "2026-09"));
  ok("a legacy fallback names the lease it came from",
    row(F.legacyOut).rent_lineage[0].lease_id && row(F.legacyOut).rent_lineage[0].basis === "legacy_lease_rent");
  //  Typed, not prose. A consumer must not parse sentences to learn why.
  ok("a conflicted row carries a typed blocker",
    two.blockers.some((b) => b.code === "conflicting_leases" && b.affects.includes("rent")));
  ok("conflicting economic lines carry their own typed blocker",
    row(F.econConflict).blockers.some((b) => b.code === "conflicting_economic_lines"));
  ok("an unqualified legacy amount carries a typed blocker",
    row(F.legacyOut).blockers.some((b) => b.code === "undated_rent_beyond_opening_month"));
  ok("no recorded rent carries a typed blocker",
    row(F.norent).blockers.some((b) => b.code === "no_contractual_rent_recorded"));
  ok("an unclassified position carries a denominator blocker",
    row(F.unclass).blockers.some((b) => b.code === "position_use_type_unclassified" && b.affects.includes("denominator")));
  ok("a fully governed row carries NO blockers", row(F.dated).blockers.length === 0);
  ok("every blocker names what it affects",
    out.rows.every((r) => r.blockers.every((b) => b.code && Array.isArray(b.affects) && b.detail)));

  section("D3 named evidence state and honest result states");
  ok("a governed dated schedule → contractually_supported",
    row(F.dated).evidence_state === EVIDENCE_STATE.SUPPORTED);
  ok("legacy inside its provable month → qualified_legacy",
    row(F.legacyIn).evidence_state === EVIDENCE_STATE.QUALIFIED_LEGACY);
  ok("legacy beyond its provable month → incomplete, NOT quietly supported",
    row(F.legacyOut).evidence_state === EVIDENCE_STATE.INCOMPLETE);
  ok("no recorded rent → incomplete", row(F.norent).evidence_state === EVIDENCE_STATE.INCOMPLETE);
  ok("competing leases → conflicting", two.evidence_state === EVIDENCE_STATE.CONFLICTING);
  ok("competing economic lines → conflicting",
    row(F.econConflict).evidence_state === EVIDENCE_STATE.CONFLICTING);
  ok("evidence state is a named source fact, never a confidence score",
    out.rows.every((r) => Object.values(EVIDENCE_STATE).includes(r.evidence_state))
    && !out.rows.some((r) => typeof r.confidence === "number"));
  ok("a property with positions reports qualifying_result_exists",
    out.result_state === RESULT_STATE.QUALIFYING);
  ok("a property with no operating day reports authority_missing, NOT empty",
    noTzEarly.result_state === RESULT_STATE.AUTHORITY_MISSING);
  ok("and that is a different state from having no positions",
    RESULT_STATE.AUTHORITY_MISSING !== RESULT_STATE.NONE);

  section("D  independent coverage axes");
  ok("known occupancy + missing rent → occupancy complete, rent partial",
    row(F.norent).coverage.occupancy === "complete" && row(F.norent).coverage.rent === "partial");
  ok("conflict → occupancy conflict AND rent conflict", two.coverage.occupancy === "conflict" && two.coverage.rent === "conflict");
  ok("every row's action coverage is one of the three governed values",
    out.rows.every((r) => ["complete", "conflict", "no_canonical_action"].includes(r.coverage.action)));

  section("E2 exact existing-action projection");
  const A1 = row(F.obActive);
  ok("one exact active obligation projects an action",
    A1.resolution_state === "existing_action" && A1.existing_action.obligation_id === F.oActive);
  ok("the correlation evidence names the traversal it used",
    A1.existing_action.evidence.correlation === "obligation.related_id(related_type=lease) -> leases.space_id");
  ok("both property walls are recorded as evidence",
    /both matched/.test(A1.existing_action.evidence.property_walled));
  ok("a real owner is returned as {user_id,name}",
    A1.existing_action.owner.user_id === F.user);
  ok("an unowned obligation returns the literal UNASSIGNED, never a nearby staffer",
    row(F.obUnassign).existing_action.owner === "UNASSIGNED");
  ok("a future due date → not_due", A1.existing_action.due_state === "not_due");
  ok("a past due date → overdue", row(F.obOverdue).existing_action.due_state === "overdue");
  ok("a governed destination is structured, not prose",
    A1.existing_action.canonical_destination.route_key === "operator.obligations.inbound_decision"
    && A1.existing_action.canonical_destination.object_id === F.oActive
    && A1.existing_action.canonical_destination.object_type === "obligation");
  ok("an obligation type with NO governed route returns null and discloses it",
    row(F.obNoDest).existing_action.canonical_destination === null
    && /No governed operator destination/.test(row(F.obNoDest).existing_action.destination_note));
  ok("a COMPLETE obligation is not presented as the current action",
    row(F.obDone).resolution_state === "no_canonical_action"
    && row(F.obDone).existing_action === null);
  ok("but it remains visible as lineage explaining why none is active",
    row(F.obDone).closed_action_lineage.some((l) => l.obligation_id === F.oDone && l.status === "complete"));
  ok("two active obligations for one condition → typed conflict, neither selected",
    row(F.obTwo).resolution_state === "conflict" && row(F.obTwo).existing_action === null);
  ok("and both obligation ids are preserved",
    (row(F.obTwo).conflicting_obligation_ids || []).length === 2);
  ok("a cross-property obligation is refused",
    row(F.obXProp).resolution_state === "no_canonical_action" && row(F.obXProp).existing_action === null);
  ok("a position with no obligation says so in the exact words",
    row(F.resid).resolution_state === "no_canonical_action"
    && row(F.resid).explanation === undefined
    && row(F.resid).resolution_explanation === "No canonical action is recorded yet.");
  ok("the obligation join does not duplicate any row",
    out.rows.length === new Set(out.rows.map((r) => String(r.space_id))).size);
  ok("coverage.action reflects the projection",
    A1.coverage.action === "complete" && row(F.obTwo).coverage.action === "conflict"
    && row(F.resid).coverage.action === "no_canonical_action");

  section("E  withheld aggregates");
  ok("no projected occupancy rate is published", out.projected_occupancy_rate === undefined);
  ok("no revenue denominator is published", out.revenue_denominator === undefined);
  ok("no scheduled rent total is published", out.scheduled_rent_total === undefined);
  ok("and each withholding states its reason",
    !!out.withheld.projected_occupancy_rate && !!out.withheld.revenue_denominator && !!out.withheld.scheduled_rent_total);

  section("F  scope, shape and cost");
  ok("no neighbouring-property space appears", !R.has(String(F.bSpace)));
  ok("no row is duplicated by the economics join",
    out.rows.length === new Set(out.rows.map((r) => String(r.space_id))).size);
  ok("one row per canonical space on this property", out.rows.length === 23);
  const ordered = out.rows.map((r) => String(r.space_id));
  const second = await datedPositionRows(pool, { property_id: F.A, as_of: TARGET });
  ok("ordering is deterministic across calls",
    JSON.stringify(second.rows.map((r) => String(r.space_id))) === JSON.stringify(ordered));
  let n = 0;
  const counting = { query: (...a) => { n++; return pool.query(...a); }, connect: (...a) => pool.connect(...a), totalCount: pool.totalCount };
  await datedPositionRows(counting, { property_id: F.A, as_of: TARGET });
  console.log(`   OBSERVED  query count for ${out.rows.length} rows: ${n}`);
  ok("query count does not grow with row count (no per-row queries)", n < 12);

  section("G  target-date meaning (owner ruling)");
  ok("an explicit as_of is honoured as a property-local calendar date",
    out.as_of === TARGET && out.as_of_basis === "explicit_property_local_date");
  ok("the property's operating timezone is stated", out.operating_timezone === "America/Los_Angeles");
  const defaulted = await datedPositionRows(pool, { property_id: F.A });
  const laToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  ok("a missing as_of resolves to PROPERTY-LOCAL today, not UTC today",
    defaulted.as_of === `${laToday.year}-${laToday.month}-${laToday.day}`
    && defaulted.as_of_basis === "property_local_today");
  const noTz = await datedPositionRows(pool, { property_id: F.NOTZ });
  ok("a property with no operating timezone refuses rather than borrowing UTC",
    noTz.state === "unavailable" && noTz.reason === "property_operating_timezone_not_configured" && noTz.rows.length === 0);

  section("G2 CONSTANT QUERY COUNT — row growth isolated from shape growth");
  //  The earlier "5 for 1, 9 for 23" figures did not isolate row count from
  //  fixture shape: the bigger fixture also switched on economics, provenance
  //  and obligations. This builds a LARGE property whose repeated mix is the
  //  SAME shape as the small one, so only the row count differs.
  const big = await (async () => {
    const cc = await pool.connect();
    const o = async (q, a = []) => (await cc.query(q, a)).rows[0];
    try {
      await cc.query("begin");
      const P = (await o(`insert into properties (name, operating_timezone) values ('10B Scale','America/Los_Angeles') returning id`)).id;
      const per = (await o(`insert into persons (name, lifecycle_status) values ('10B Scale Tenant','tenant') returning id`)).id;
      const usr = (await o(`insert into users (name,email,phone,role,is_active,status)
        values ('10B Scale User',$1,$2,'property_manager',true,'active') returning id`,
        [`sc-${Date.now()}@rows.test`, "+1725" + String(Date.now()).slice(-7)])).id;
      const off = (await o(`insert into lease_offers (property_id, person_id, status, source, scope,
          offered_terms_snapshot, authority_basis_snapshot, granted_by_person_id)
        values ($1,$2,'draft','discretionary','property','{}'::jsonb,'{}'::jsonb,$3) returning id`, [P, per, per])).id;
      //  Ten repetitions of the same nine-shape mix = 90 positions.
      const SHAPES = ["dated", "legacy_in", "legacy_out", "econ_conflict", "missing",
                      "obligation", "unassigned", "two_obligations", "unclassified"];
      for (let i = 0; i < 10; i++) {
        for (const shape of SHAPES) {
          const unit = (await o(`insert into units (property_id, unit_number) values ($1,$2) returning id`, [P, `S-${i}-${shape}`])).id;
          const sp = (await cc.query(`select id from spaces where unit_id=$1`, [unit])).rows[0].id;
          if (shape !== "unclassified") {
            await cc.query(`update spaces set use_type='residential', classified_by_user_id=$2,
                            classified_at=now(), classification_source='proof' where id=$1`, [sp, usr]);
          }
          const start = shape === "legacy_in" ? "2026-09-01" : "2026-01-01";
          await cc.query(`insert into leases (property_id, space_id, tenant_ids, rent, start_date, end_date, lease_status)
            values ($1,$2,$3,$4,$5,'2027-08-31','active')`, [P, sp, [per], shape === "missing" ? null : 1500, start]);
          const lease = (await o(`select id from leases where space_id=$1 limit 1`, [sp])).id;
          if (shape === "dated" || shape === "econ_conflict") {
            const a = (await o(`insert into lease_applications (property_id, person_id, status)
              values ($1,$2,'approved') returning id`, [P, per])).id;
            const sc = (await o(`insert into lease_economic_schedules (property_id, application_id, space_id, status,
                source_offer_id, locked_by_person_id) values ($1,$2,$3,'locked',$4,$5) returning id`, [P, a, sp, off, per])).id;
            await cc.query(`insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
              values ($1,'2026-09-01',$2,$3)`, [sc, "base_rent", 2000]);
            if (shape === "econ_conflict") {
              await cc.query(`insert into lease_economic_lines (schedule_id, effective_month, line_type, amount)
                values ($1,'2026-09-01','base_rent',2600)`, [sc]);
            }
          }
          const obl = (t2, st, own) => cc.query(
            `insert into obligations (property_id, module, type, status, related_id, related_type, due_at, assigned_user_id, label)
             values ($1,'leasing',$2,$3,$4,'lease','2099-01-01',$5,'Proof')`, [P, t2, st, lease, own]);
          if (shape === "obligation") await obl("resolve_inbound_opportunity", "open", usr);
          if (shape === "unassigned") await obl("resolve_inbound_opportunity", "open", null);
          if (shape === "two_obligations") { await obl("resolve_inbound_opportunity", "open", usr);
                                             await obl("resolve_inbound_opportunity", "in_progress", usr); }
        }
      }
      await cc.query("commit");
      return P;
    } catch (e) { await cc.query("rollback"); throw e; } finally { cc.release(); }
  })();

  let nSmall = 0, nLarge = 0;
  const cnt = (ref) => ({ query: (...a) => { ref.n++; return pool.query(...a); },
                          connect: (...a) => pool.connect(...a), totalCount: pool.totalCount });
  const rs = { n: 0 }; const smallOut = await datedPositionRows(cnt(rs), { property_id: F.A, as_of: TARGET }); nSmall = rs.n;
  const rl = { n: 0 }; const largeOut = await datedPositionRows(cnt(rl), { property_id: big, as_of: TARGET }); nLarge = rl.n;
  console.log(`   OBSERVED  small ${smallOut.rows.length} rows -> ${nSmall} queries; large ${largeOut.rows.length} rows -> ${nLarge} queries`);
  ok(`row count grows (${smallOut.rows.length} -> ${largeOut.rows.length})`, largeOut.rows.length > smallOut.rows.length * 3);
  ok(`query count does NOT grow (${nSmall} === ${nLarge}) — no N+1`, nSmall === nLarge);
  ok("large result stays unique by spaces.id",
    largeOut.rows.length === new Set(largeOut.rows.map((r) => String(r.space_id))).size);
  const l1 = largeOut.rows.map((r) => String(r.space_id));
  const l2 = (await datedPositionRows(pool, { property_id: big, as_of: TARGET })).rows.map((r) => String(r.space_id));
  ok("large ordering stays deterministic", JSON.stringify(l1) === JSON.stringify(l2));
  ok("the repeated mix really did activate every rail",
    largeOut.rows.some((r) => r.rent_authority === "dated_economic_line")
    && largeOut.rows.some((r) => r.rent_authority === "legacy_lease_rent")
    && largeOut.rows.some((r) => r.rent_authority === "conflict")
    && largeOut.rows.some((r) => r.rent_authority === "missing")
    && largeOut.rows.some((r) => r.resolution_state === "existing_action")
    && largeOut.rows.some((r) => r.existing_action && r.existing_action.owner === "UNASSIGNED")
    && largeOut.rows.some((r) => r.resolution_state === "conflict")
    && largeOut.rows.some((r) => r.denominator_class === "unknown"));

  section("H  writes");
  const before = await pool.query("select (select count(*) from leases) l, (select count(*) from events) e");
  await datedPositionRows(pool, { property_id: F.A, as_of: "2026-10-01" });
  const after = await pool.query("select (select count(*) from leases) l, (select count(*) from events) e");
  ok("the engine writes nothing", before.rows[0].l === after.rows[0].l && before.rows[0].e === after.rows[0].e);

  console.log(`\n════ dated position rows: ${pass} passed, ${fail} failed ════\n`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("PROOF CRASHED: " + e.message); console.error(e.stack.split("\n").slice(1, 4).join("\n")); process.exit(1); });
