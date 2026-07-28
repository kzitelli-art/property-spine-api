// ════════════════════════════════════════════════════════════════════
//  governed_economics_proof.js — the permanent economic invariants
//
//  Charge classes, the completed concession compiler, the dark economic
//  adapter, the fact-migration preview and the Future Rent Roll economic
//  stack. Constructed cases + live reads. Writes only inside rollbacks.
//
//  Run: DATABASE_URL=... node tests/governed_economics_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";
const KZ_USER = "78375274-922a-44c5-8b61-0c285d1b9911";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const sec = (s) => console.log("\n== " + s + " ==");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const gc = require(path.join(REPO, "src/money/governed_charges"));
  const comp = require(path.join(REPO, "src/money/concession_schedule_compiler"));
  const { factMigrationPreview } = require(path.join(REPO, "src/money/fact_migration_preview"));
  const { economicAnswer } = require(path.join(REPO, "src/agent/economic_adapter"));
  const { futureRentRollPricingPreview } = require(path.join(REPO, "src/money/future_rent_roll_pricing_contract"));
  const pac = require(path.join(REPO, "src/identity/privileged_actor_contract"));

  const codes = (r) => r.blockers.map((b) => b.code);
  const baseCharge = {
    charge_code: "x", display_label: "X", effective_from: "2026-01-01",
    applicability_basis: "all residents", incurred_on_event: "move_in",
  };
  const CTX = { property_id: DEMO, actor_may_publish: true };

  sec("ECONOMIC CLASSES CANNOT COLLAPSE");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "recurring_charge",
      cadence: "one_time", obligation: "required" }, CTX)).includes("recurring_charge_not_monthly"),
    "a recurring charge stored as one-time is refused — $X/month must never become $X once");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: "monthly", obligation: "required" }, CTX)).includes("one_time_fee_with_monthly_cadence"),
    "a one-time fee billed monthly is refused — the $300 pet fee shape");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "deposit_required",
      cadence: "conditional", obligation: "required", refundable: false, amount: 1000 }, CTX))
      .includes("deposit_required_not_refundable"),
    "deposit_required marked non-refundable is refused — that recognises a refundable balance as income");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "deposit_required",
      cadence: "conditional", obligation: "required", refundable: true, amount: 1000,
      counts_as_revenue: true }, CTX)).includes("deposit_required_as_revenue"),
    "deposit_required as revenue is refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required", refundable: true, amount: 50 }, CTX))
      .includes("refundable_fee"), "a refundable fee is refused — that is a deposit");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "base_rent",
      cadence: "monthly", obligation: "required", amount: 1500 }, CTX)).includes("class_not_in_catalog"),
    "base_rent cannot hold a catalog row — it would be a second asking rent");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "deposit_held",
      cadence: "one_time", obligation: "required", amount: 1000 }, CTX)).includes("class_not_in_catalog"),
    "deposit_held cannot hold a catalog row — a requirement would masquerade as a liability");

  sec("AMOUNT, CADENCE, APPLICABILITY");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required", amount: 87, amount_text: "a telecom fee of $75–99" }, CTX))
      .includes("range_without_determinant"),
    "a range quoted as a precise amount is refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required" }, CTX)).includes("amount_missing"),
    "an amount that is neither resolved nor explained is refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required", amount_unresolved_reason: "range",
      quotable_precisely: true }, CTX)).includes("unresolved_marked_quotable"),
    "an unresolved charge marked quotable is refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "one_time_fee",
      cadence: null, obligation: "required", amount: 50 }, CTX)).includes("cadence_unknown"),
    "a charge without cadence is refused — it could not be summed");
  ok(codes(gc.checkChargePublishable({ charge_code: "x", display_label: "X",
      effective_from: "2026-01-01", incurred_on_event: "move_in", economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required", amount: 50 }, CTX))
      .includes("required_without_applicability"),
    "a REQUIRED charge without applicability is refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "recurring_charge",
      cadence: "monthly", obligation: "optional", amount: 15, presented_as: "universal" }, CTX))
      .includes("optional_presented_as_universal"),
    "an optional charge presented as universal is refused — the insurance shape");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, economic_class: "recurring_charge",
      cadence: "monthly", obligation: "conditional", amount: 30 }, CTX))
      .includes("conditional_without_condition"),
    "a conditional charge with no named condition is refused");
  const dupCtx = { ...CTX, existing_owners: new Map([["fee.application", "agent_facts"]]) };
  ok(codes(gc.checkChargePublishable({ ...baseCharge, charge_code: "fee.application",
      economic_class: "one_time_fee", cadence: "one_time", obligation: "required", amount: 50 }, dupCtx))
      .includes("duplicate_value_two_owners"),
    "a duplicate owner of the same quotable value is surfaced and refused");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, property_id: OTHER,
      economic_class: "one_time_fee", cadence: "one_time", obligation: "required", amount: 50 }, CTX))
      .includes("cross_property_charge"), "a cross-property charge is refused");
  ok(gc.checkChargePublishable({ ...baseCharge, charge_code: "fee.application",
      economic_class: "one_time_fee", cadence: "one_time", obligation: "required",
      amount: 50, refundable: false }, CTX).publishable,
    "a clean, fully-specified fee passes");
  ok(codes(gc.checkChargePublishable({ ...baseCharge, charge_code: "f", economic_class: "one_time_fee",
      cadence: "one_time", obligation: "required", amount: 50 }, { property_id: DEMO }))
      .includes("no_publish_authority"), "publishing without may_publish_pricing is refused");

  sec("DATABASE ENFORCES THE CLASSES TOO");
  const dbFail = async (sql, params) => {
    const c = await pool.connect();
    try { await c.query("begin"); await c.query(sql, params); await c.query("rollback"); return null; }
    catch (e) { await c.query("rollback").catch(() => {}); return e.constraint || e.message; }
    finally { c.release(); }
  };
  const ins = `insert into property_governed_charges
    (property_id, charge_code, display_label, economic_class, cadence, amount, obligation,
     applicability_basis, effective_from, refundable, source_provenance)
    values ($1,$2,'L',$3,$4,$5,'required','all','2026-01-01',$6,'harness')`;
  ok(await dbFail(ins, [DEMO, "t1", "recurring_charge", "one_time", 30, false])
      === "ck_gc_recurring_is_monthly",
    "the DATABASE refuses a non-monthly recurring charge");
  ok(await dbFail(ins, [DEMO, "t2", "one_time_fee", "monthly", 300, false])
      === "ck_gc_one_time_not_monthly",
    "the DATABASE refuses a monthly one-time fee");
  ok(await dbFail(ins, [DEMO, "t3", "deposit_required", "conditional", 1000, false])
      === "ck_gc_deposit_refundable",
    "the DATABASE refuses a non-refundable deposit requirement");
  ok(await dbFail(ins, [DEMO, "t4", "base_rent", "monthly", 1500, false])
      === "ck_gc_economic_class",
    "the DATABASE refuses base_rent in the catalog");
  ok(await dbFail(`insert into property_governed_charges
      (property_id, charge_code, display_label, economic_class, cadence, obligation,
       applicability_basis, effective_from, unit_type_id, applicability_scope, amount,
       refundable, source_provenance)
      values ($1,'t5','L','one_time_fee','one_time','required','all','2026-01-01',
              (select id from property_unit_types where property_id=$2::uuid limit 1),
              'unit_type',50,false,'harness')`,
      [DEMO, OTHER]) !== null,
    "the DATABASE refuses a cross-property unit-type reference");

  sec("CONCESSION COMPILER — all eight profiles, dated lines");
  ok(comp.IMPLEMENTED.length === 8, `all eight profiles are implemented (${comp.IMPLEMENTED.length})`);
  ok(Object.keys(comp.PRORATION_BASES).length === 3,
    `three proration bases exist (${Object.keys(comp.PRORATION_BASES).join(", ")})`);
  const L = { lease_start: "2026-09-15", lease_end: "2027-09-14", base_rent: 1500, lease_term_months: 12 };
  const noBasis = comp.compileSchedule({ ...L, timing_profile: "free_rent_period",
    free_from: "2026-09-15", free_until: "2026-11-01" });
  ok(noBasis.code === "proration_basis_required",
    "a profile that can land on a partial month REFUSES without an explicit basis");
  const fr = comp.compileSchedule({ ...L, timing_profile: "free_rent_period",
    free_from: "2026-09-15", free_until: "2026-11-01", proration_basis: "actual_days" });
  ok(fr.ok && fr.lines.length === 2 && fr.lines[0].amount === 800,
    `free_rent_period produces dated lines (${fr.lines.map((l) => l.date + "=$" + l.amount).join(", ")})`);
  ok(fr.effective_rent === Math.round((1500 - fr.total_credit / 12) * 100) / 100,
    "and effective rent is DERIVED from those lines");
  const frFull = comp.compileSchedule({ ...L, timing_profile: "free_rent_period",
    free_from: "2026-09-15", free_until: "2026-11-01", proration_basis: "full_months_only" });
  ok(frFull.total_credit !== fr.total_credit,
    `the basis CHANGES the answer ($${fr.total_credit} vs $${frFull.total_credit}) — which is why it cannot default`);
  // February is where actual_days and thirty_day_month genuinely diverge.
  const feb = (b) => comp.compileSchedule({ lease_start: "2027-02-09", lease_end: "2028-02-08",
    base_rent: 1500, lease_term_months: 12, timing_profile: "free_rent_period",
    free_from: "2027-02-09", free_until: "2027-03-01", proration_basis: b });
  ok(feb("actual_days").total_credit !== feb("thirty_day_month").total_credit,
    `on a 20-day February the bases differ ($${feb("actual_days").total_credit} vs $${feb("thirty_day_month").total_credit})`);
  for (const p of ["first_full_month", "third_full_month", "final_full_month"]) {
    const r = comp.compileSchedule({ ...L, timing_profile: p, proration_basis: "actual_days" });
    ok(r.ok && r.lines.length === 1 && r.lines[0].amount === 1500, `${p} produces one dated line`);
  }
  const schedNo = comp.compileSchedule({ ...L, timing_profile: "monthly_scheduled_credit" });
  ok(schedNo.code === "schedule_source_required",
    "monthly_scheduled_credit REFUSES without an explicit schedule source");
  const sched = comp.compileSchedule({ ...L, timing_profile: "monthly_scheduled_credit",
    schedule_source: "explicit_lines",
    schedule_lines: [{ date: "2026-10-01", amount: 300 }, { date: "2026-11-01", amount: 300 },
                     { date: "2026-12-01", amount: 300 }] });
  ok(sched.ok && sched.lines.length === 3 && sched.total_credit === 900,
    "with explicit lines it compiles to three dated credits totalling $900");
  ok(comp.compileSchedule({ ...L, timing_profile: "monthly_scheduled_credit",
      schedule_source: "explicit_lines", schedule_lines: [{ date: "2030-01-01", amount: 300 }] }).code
      === "schedule_line_outside_lease", "a schedule line outside the lease is refused");
  const d1 = comp.compileSchedule({ ...L, timing_profile: "free_rent_period", free_from: "2026-09-15",
    free_until: "2026-11-01", proration_basis: "actual_days" });
  ok(JSON.stringify(d1) === JSON.stringify(fr), "the compiler is deterministic — same inputs, same lines");
  ok(!/free_months/.test(JSON.stringify([fr, sched])), "free_months never appears as economic truth");
  const waiverBad = comp.compileSchedule({ timing_profile: "one_time_fee_waiver",
    concession_type: "fee_waiver", fee_category: "telecom", fee_resolved: false, posting_date: "2026-09-01" });
  ok(waiverBad.code === "governed_fee_unresolved",
    "a waiver over an UNRESOLVED governed fee is still refused");

  sec("FACT MIGRATION PREVIEW — no write, contract-checked");
  const mig = await factMigrationPreview(pool, { property_id: DEMO });
  ok(mig.disposition === "no_write_migration_preview", "the preview writes nothing");
  // 12 after cutover: pricing_application_fee retired into the governed charge.
  ok(mig.summary.total === 12, `${mig.summary.total} monetary facts remain live and previewed (13 minus the cut-over application fee)`);
  ok(mig.summary.safe_to_migrate === 1,
    `exactly ${mig.summary.safe_to_migrate} fact is safe to migrate — the application fee already did`);
  const safeKeys = mig.facts.filter((f) => f.safe_to_migrate).map((f) => f.fact_key);
  ok(safeKeys.length === 1 && safeKeys[0] === "pricing_admin_fee",
    `and it is the administration fee (${safeKeys.join(", ")})`);
  const blockedFor = (k) => (mig.facts.find((f) => f.fact_key === k) || {}).blocked_reason;
  ok(blockedFor("pricing_telecom_fee") === "range_determinant_unknown", "telecom is blocked on its determinant");
  ok(blockedFor("pricing_amenity_fee") === "new_lease_versus_renewal_amount_not_structured",
    "amenity is blocked on new-lease vs renewal");
  ok(blockedFor("pet_policy") === "fee_and_rent_not_separated_and_per_pet_unknown",
    "pet economics is blocked on the fee/rent split");
  ok(blockedFor("renters_insurance") === "required_versus_optional_contradiction",
    "insurance is blocked on required-versus-optional");
  ok(blockedFor("pricing_security_deposit") === "underwriting_requirement_not_separated_from_deposit_held",
    "the security deposit is blocked on requirement-versus-held");
  const mir = mig.facts.find((f) => f.fact_key === "move_in_requirements");
  ok(mir.proposed_governed_destination === null,
    "move_in_requirements gets NO governed destination — a charge row would make the duplicate permanent");
  ok(mig.facts.every((f) => f.retirement_action),
    "every fact carries an explicit retirement action");
  ok(mig.facts.filter((f) => !f.safe_to_migrate).every((f) =>
    f.retirement_action !== "retire_fact_in_the_SAME_commit_that_publishes_its_governed_row"),
    "no blocked fact is scheduled for retirement");

  sec("DARK ECONOMIC ADAPTER — classes never collapsed");
  const ans = await economicAnswer(pool, { property_id: DEMO, intent: "new_lease" });
  ok(ans.proof.sends_nothing && ans.proof.writes_nothing, "it sends nothing and writes nothing");
  ok(ans.combined_monthly.amount === null,
    "NO combined monthly figure is produced while components are ungoverned");
  ok(Array.isArray(ans.combined_monthly.withheld_because) && ans.combined_monthly.withheld_because.length > 0,
    `and the reason is named (${ans.combined_monthly.withheld_because.slice(0, 2).join(", ")})`);
  ok(ans.combined_move_in.amount === null, "NO move-in total is produced");
  const classes = new Set(ans.components.map((c) => c.economic_class));
  ok(classes.has("base_rent") && classes.has("one_time_fee") && classes.has("recurring_charge")
     && classes.has("deposit_required") && classes.has("concession"),
    `every economic class is separately represented (${[...classes].join(", ")})`);
  ok(ans.components.every((c) => c.state && require(path.join(REPO, "src/agent/economic_adapter")).STATES.includes(c.state)),
    "every component carries one of the seven declared states");
  ok(ans.components.every((c) => c.quotable_precisely === (c.state === "known_and_quotable")),
    "quotability is derived from state, never asserted separately");
  const rec = ans.components.find((c) => c.economic_class === "recurring_charge");
  ok(rec && rec.state !== "known_and_quotable" && /not yet available/i.test(rec.say || ""),
    "recurring charges report the honest sentence rather than a number");
  const commercial = await economicAnswer(pool, { property_id: DEMO,
    unit_type_id: (await pool.query(
      "select id from property_unit_types where property_id=$1 and code='comm'", [DEMO])).rows[0].id });
  ok(commercial.components.some((c) => c.economic_class === "base_rent" && c.state === "not_applicable"),
    "commercial space is not_applicable, never a legacy $0");
  const noProp = await economicAnswer(pool, {});
  ok(noProp.answerable === false && noProp.reason === "no_property_context", "no property context is refused");
  const deadPool = { query: async () => { throw new Error("db down"); } };
  const dead = await economicAnswer(deadPool, { property_id: DEMO });
  ok(dead.components.every((c) => c.state === "unavailable" || c.amount === null),
    "a failed live read produces UNAVAILABLE, never sample economics");
  // proof.never_reads NAMES the forbidden sources on purpose; strip the
  // declaration, then assert the names appear nowhere else.
  const ansPayload = JSON.stringify({ ...ans, proof: { ...ans.proof, never_reads: undefined } });
  ok(!ansPayload.includes("market_rent"), "no market_rent VALUE appears in the answer");
  ok(ans.proof.never_reads.includes("units.market_rent"),
    "and the answer names what it refuses to read, on the record");

  sec("PARTIAL ANSWERS ARE ANSWERS");
  ok(/does not void the others/i.test(ans.partial_answer_note),
    "a missing class does not void the others, on the record");
  // Nothing is published, so every class is currently unresolved. The claim
  // that a RESOLVED class survives beside unresolved ones needs one to exist,
  // so a charge is published inside a transaction and rolled back.
  const pc = await pool.connect();
  await pc.query("begin");
  const txPool = { query: pc.query.bind(pc) };
  await pc.query(
    `insert into property_governed_charges
       (property_id, charge_code, display_label, economic_class, cadence, amount, obligation,
        applicability_basis, effective_from, refundable, source_provenance, record_state,
        published_by_person_id, published_at, incurred_on_event)
     values ($1,'fee.harness_probe','Harness probe fee','one_time_fee','one_time',50,'required',
             'Per applicant on a new-lease application.','2026-01-01',false,'harness','active',
             (select person_id from users where id=$2), now(), 'application')`,
    [DEMO, KZ_USER]);
  const partial = await economicAnswer(txPool, { property_id: DEMO, intent: "new_lease" });
  const fee = partial.components.find((c) => c.code === "fee.harness_probe");
  ok(!!fee && fee.state === "known_and_quotable" && fee.amount === 50,
    "a governed fee resolves to known_and_quotable with its amount");
  ok(fee.governed_source === "property_governed_charges" && !!fee.authority_receipt,
    "carrying its governed source and authority receipt");
  const rentPart = partial.components.find((c) => c.economic_class === "base_rent");
  ok(rentPart && rentPart.state !== "known_and_quotable",
    "while base rent remains unresolved in the same answer");
  ok(partial.answerable === true,
    "the answer is ANSWERABLE — one resolved class is not voided by unresolved ones");
  ok(partial.combined_monthly.amount === null,
    "and the combined monthly total is STILL withheld, because a component is missing");
  await pc.query("rollback");
  pc.release();
  // Count ACTIVE rows: two DRAFT candidates are legitimately persisted, so a
  // bare row count would now flag them as rollback leakage.
  // Count only the PROBE code: the real approved fee.application is legitimately
  // active, so a bare active count would flag the published decision as leakage.
  const leftoverProbe = Number((await pool.query(
    "select count(*)::int n from property_governed_charges where charge_code='fee.harness_probe'")).rows[0].n);
  ok(leftoverProbe === 0, `the constructed probe did not survive the rollback (${leftoverProbe})`);

  sec("FUTURE RENT ROLL ECONOMIC STACK");
  const frr = await futureRentRollPricingPreview(pool, { property_id: DEMO });
  ok(!!frr.economic_stack, "the economic stack is represented");
  ok(frr.economic_stack.recurring_contractual_charges.included_in_projection === 0,
    "no recurring charge is projected onto an unlocked position");
  ok(/never assumed/i.test(frr.economic_stack.recurring_contractual_charges.rule),
    "optional charges are never assumed; conditional ones need a governed true condition");
  ok(frr.economic_stack.dated_concession_lines.included === 0
     && /ONLY through dated lines/i.test(frr.economic_stack.dated_concession_lines.rule),
    "concessions reduce economics only through dated lines");
  ok(frr.economic_stack.excluded_from_recurring.one_time_fees.treatment.includes("never annualized"),
    "one-time fees are never annualized into rent");
  ok(frr.economic_stack.excluded_from_recurring.deposit_required.treatment.includes("ZERO revenue"),
    "deposit_required contributes zero revenue");
  ok(frr.economic_stack.excluded_from_recurring.deposit_held.treatment.includes("ZERO revenue"),
    "deposit_held contributes zero revenue");
  ok(frr.economic_stack.scheduled_recurring_economics.value === null,
    "scheduled recurring economics is null without approved assumptions");
  ok(frr.summary.repriced_locked_positions === 0, "zero locked positions repriced");
  ok(frr.summary.positions_given_projected_pricing === 0, "zero positions given projected revenue");

  sec("OPERATING STATE UNCHANGED");
  const st = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) v,
            (select count(*)::int from property_governed_charges where record_state='active') c,
            (select count(*)::int from concession_policies where active) k`)).rows[0];
  ok(Number(st.v) === 0, "no pricing version published");
  ok(Number(st.c) === 1, "exactly one governed charge is published — the approved application fee");
  ok(Number(st.k) === 0, "no concession active");
  const agentSrc = fs.readFileSync(path.join(REPO, "src/agent/agent.js"), "utf8");
  ok(!/economic_adapter|economicAnswer/.test(agentSrc), "the live agent does not call the economic adapter");
  const eaCallers = require("child_process")
    .execSync("git grep -l economic_adapter -- src server.js || true", { cwd: REPO, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  // operator.js consumes it for a REVIEW-only route. Dark has always meant
  // no PROSPECT-FACING path calls it, not zero references.
  const AE_ALLOWED = ["src/agent/economic_adapter.js", "src/identity/operator.js"];
  const eaUnexpected = eaCallers
    .map((c) => c.split("\\").join("/"))
    .filter((c) => !AE_ALLOWED.includes(c));
  ok(eaUnexpected.length === 0,
    `only review-only consumers reference the economic adapter (${eaUnexpected.join(", ") || "none"})`);


  sec("PERSISTED DRAFTS HAVE ZERO OPERATING EFFECT");
  const { effectiveEconomicPicture } = require(path.join(REPO, "src/money/economic_picture"));
  const { economicShadowReport } = require(path.join(REPO, "src/money/economic_shadow"));
  const activeOnly = await gc.governedCharges(pool, { property_id: DEMO });
  const withDrafts = await gc.governedCharges(pool, { property_id: DEMO, include_drafts: true });
  ok(withDrafts.summary.draft === 1, `one draft candidate remains (${withDrafts.summary.draft}) — the application fee published`);
  ok(activeOnly.summary.total === 1 && activeOnly.one_time_fees[0].charge_code === "fee.application",
    "the DEFAULT read returns ONLY the published fee — the draft stays invisible");
  ok(withDrafts.summary.active === 1 && withDrafts.summary.quotable === 1,
    "exactly one charge is active and quotable");
  const draftCodes = withDrafts.one_time_fees.filter((c) => c.record_state === 'draft').map((c) => c.charge_code).sort();
  ok(JSON.stringify(draftCodes) === JSON.stringify(["fee.administration"]),
    `the remaining draft is the administration fee (${draftCodes.join(", ")})`);
  ok(withDrafts.one_time_fees.every((c) => /migration_candidate_from:/.test(c.source_provenance || "")),
    "each records the source fact it was derived from");
  ok(withDrafts.one_time_fees.filter((c) => c.record_state === "draft")
      .every((c) => c.not_quotable_reason === "draft_has_no_operating_effect"),
    "and the draft states why it cannot be quoted");
  const adapterNow = await economicAnswer(pool, { property_id: DEMO });
  ok(!adapterNow.components.some((c) => c.code === "fee.administration"),
    "the DARK ADAPTER cannot see the remaining DRAFT at all");
  ok(adapterNow.components.some((c) => c.code === "fee.application" && c.state === "known_and_quotable"),
    "but it DOES see the published application fee — the cutover is real");
  const liveFacts = Number((await pool.query(
    `select count(*)::int n from agent_facts where property_id=$1 and status='active'
       and fact_key in ('pricing_application_fee','pricing_admin_fee')`, [DEMO])).rows[0].n);
  ok(liveFacts === 1, "only the administration fact remains live — the application fact retired at cutover");

  sec("ECONOMIC PICTURE — composition, not a new source");
  const pic = await effectiveEconomicPicture(pool, { property_id: DEMO });
  ok(pic.disposition === "composition_read_no_new_source_of_truth", "it declares itself a composition");
  ok(pic.proof.copies_nothing === true, "and copies nothing");
  ["base_rent", "one_time_fees", "recurring_charges", "deposit_requirements", "advertised_concessions"]
    .forEach((k) => ok(!!pic[k] && !!pic[k].economic_class, `${k} is a separate block carrying its class`));
  ok(pic.one_time_fees.drafts.length === 1 && pic.one_time_fees.published.length === 1,
    "drafts are carried SEPARATELY from published, never merged");
  ok(pic.combined_monthly_total.amount === null && pic.combined_monthly_total.withheld === true,
    "no combined monthly total is fabricated");
  ok(Array.isArray(pic.combined_monthly_total.withheld_because)
     && pic.combined_monthly_total.withheld_because.length > 0,
    `and the reason is named (${pic.combined_monthly_total.withheld_because.join(", ")})`);
  ok(pic.combined_move_in_total.amount === null
     && /Deposits stay SEPARATELY identified/.test(pic.combined_move_in_total.rule),
    "the move-in total is withheld and deposits stay separately identified");
  ok(pic.legacy_transitional.still_live === true && pic.legacy_transitional.facts.length === 12,
    "the 12 remaining transitional legacy facts are carried as still-live");
  // Pinned to the exact set. This briefly accepted "10 or 11" so it would pass
  // across the application-fee cutover — an assertion that accepts two answers
  // is not an assertion, and it would have hidden a fact silently changing
  // verdict. The cut-over fee was never a contradiction, so the count did not
  // actually move.
  const CONTRADICTED = ["entry_access", "move_in_credits", "move_in_requirements",
    "parking_pricing", "pet_policy", "pricing_amenity_fee", "pricing_security_deposit",
    "pricing_telecom_fee", "renters_insurance", "unit_transfers", "utilities"];
  ok(pic.contradictions.length === 11, `${pic.contradictions.length} contradictions are surfaced`);
  ok(JSON.stringify(pic.contradictions.map((c) => c.fact_key).sort()) === JSON.stringify(CONTRADICTED),
    "and they are exactly the eleven known-contradicted facts, by name");
  ok(pic.missing_determinants.length > 0,
    `missing determinants are named (${pic.missing_determinants.length})`);
  ok(pic.completeness.independently_governed === true,
    "classes stay independently governed — there is no master economic version");
  const picPayload = JSON.stringify({ ...pic, proof: { ...pic.proof, never_reads: undefined } });
  ok(!picPayload.includes("market_rent"), "no market_rent value appears in the picture");
  const deadPic = await effectiveEconomicPicture(
    { query: async () => { throw new Error("down"); } }, { property_id: DEMO });
  ok(Object.values(deadPic.completeness.by_class).includes("unavailable"),
    "a failed read returns UNAVAILABLE per class, never empty or sample economics");

  sec("EXTENDED SHADOW — 25 scenarios, nothing sent");
  const beforeS = (await pool.query(
    `select (select count(*)::int from comm_events) c, (select count(*)::int from persons) p,
            (select count(*)::int from obligations) o,
            (select count(*)::int from property_governed_charges) g`)).rows[0];
  const shadow = await economicShadowReport(pool, { property_id: DEMO, other_property_id: OTHER });
  const afterS = (await pool.query(
    `select (select count(*)::int from comm_events) c, (select count(*)::int from persons) p,
            (select count(*)::int from obligations) o,
            (select count(*)::int from property_governed_charges) g`)).rows[0];
  ok(JSON.stringify(beforeS) === JSON.stringify(afterS),
    `nothing was written (${JSON.stringify(afterS)})`);
  ok(shadow.sent_anything === false, "the report states it sent nothing");
  ok(shadow.summary.compared >= 25, `${shadow.summary.compared} scenarios compared`);
  const has = (frag) => shadow.comparisons.some((c) => c.scenario.includes(frag));
  ["new_lease_asking_rent", "renewal_rent", "application_fee", "administration_fee",
   "amenity_fee", "telecom_charge", "parking", "pet_fee_and_rent", "wifi", "insurance",
   "deposit_requirement", "move_in_requirements", "move_in_credits",
   "concession:one_time_fee_waiver", "concession:flat_dated_credit",
   "concession:fixed_monthly_discount", "concession:free_rent_period",
   "unclassified_unit_101", "model_unit_214", "activation_pending_unit_530",
   "commercial_space", "another_property", "failed_economic_read"]
    .forEach((f) => ok(has(f), `scenario present: ${f}`));
  ok(shadow.summary.unsupported_precision > 0,
    `${shadow.summary.unsupported_precision} live answers carry unsupported precision`);
  ok(shadow.summary.duplicate_ownership_blocking === 0,
    "NO duplicate ownership — the legacy application fact retired at cutover");
  ok(shadow.summary.cannot_survive_cutover > 0,
    `${shadow.summary.cannot_survive_cutover} live answers cannot safely survive cutover, each with a reason`);
  const failRow = shadow.comparisons.find((c) => c.scenario === "failed_economic_read");
  ok(failRow && failRow.governed_disposition === "unavailable",
    "a failed economic read is reported as unavailable, not as agreement");
  const commRow2 = shadow.comparisons.find((c) => c.scenario === "commercial_space");
  ok(commRow2 && commRow2.current_answer === 0 && commRow2.governed_answer === null,
    "commercial: the live $0 against a governed refusal is surfaced as a real disagreement");
  ok(shadow.comparisons.filter((c) => c.scenario.startsWith("concession:"))
      .some((c) => c.governed_disposition === "refused"),
    "a concession over an unresolved fee is still refused in shadow");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
