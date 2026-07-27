// ════════════════════════════════════════════════════════════════════
//  pricing_governance_proof.js — the permanent pricing invariants
//
//  Proves the lifecycle, authority, validation, compiler, shadow simulator,
//  Future Rent Roll contract and market-evidence seam.
//
//  WRITES: draft rows and review receipts, inside a transaction that is
//  ROLLED BACK. Nothing is published and nothing survives the run.
//
//  Run: DATABASE_URL=... node tests/pricing_governance_proof.js
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OWNER_PERSON = "16b442ee-0ec5-425a-90f3-ab8708a15b77";   // Jordan Avery (demo), owner on Demo
const LEASING_PERSON = "b1e0dcd2-a9bc-4ac6-aee8-7a5ea0739e63"; // Kandice, leasing on Demo

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };
const section = (s) => console.log("\n== " + s + " ==");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { pricingAuthority, authorityInventory } = require(path.join(REPO, "src/money/pricing_authority"));
  const { validateMoneyEntry, validateMoneySet } = require(path.join(REPO, "src/money/economic_class_validation"));
  const { compileSchedule, PROFILES, IMPLEMENTED } = require(path.join(REPO, "src/money/concession_schedule_compiler"));
  const { saveDraft, submitReview, publishVersion, proposalDigest } = require(path.join(REPO, "src/money/pricing_lifecycle"));
  const { shadowQuoteReport } = require(path.join(REPO, "src/money/shadow_quote_simulator"));
  const { futureRentRollPricingPreview } = require(path.join(REPO, "src/money/future_rent_roll_pricing_contract"));
  const mkt = require(path.join(REPO, "src/money/market_evidence_contract"));
  const { effectivePropertyPricing } = require(path.join(REPO, "src/money/effective_pricing"));

  const eff = await effectivePropertyPricing(pool, { property_id: DEMO });
  const priced = eff.unit_types.filter((t) => t.requires_pricing_decision);

  // ── PHASE 1: schema supports the lifecycle honestly ───────────────
  section("PHASE 1 — the lifecycle primitives exist");
  const cols = async (t) => (await pool.query(
    `select column_name, is_nullable from information_schema.columns where table_name=$1`, [t])).rows;
  const pt = await cols("pricing_terms");
  ok(pt.find((c) => c.column_name === "base_rent").is_nullable === "YES",
    "a type can be addressed WITHOUT inventing a price (base_rent nullable)");
  const rr = await cols("pricing_review_receipts");
  ok(rr.length > 0, "pricing_review_receipts exists — review history has a home");
  ["packet_snapshot", "proposal_snapshot", "preview_snapshot", "proposal_digest"]
    .forEach((c) => ok(rr.some((x) => x.column_name === c), `the receipt carries ${c}`));
  const pv = await cols("property_pricing_versions");
  ok(pv.some((c) => c.column_name === "review_receipt_id"), "a version records WHICH receipt authorised it");
  ok(pv.some((c) => c.column_name === "publication_receipt"), "the before/after receipt is stored on the version");

  const ex = (await pool.query(
    `select conname, pg_get_constraintdef(oid) def from pg_constraint
      where conname='ex_pricing_versions_no_overlap'`)).rows[0];
  ok(!!ex && /EXCLUDE/.test(ex.def), "non-overlap is a DATABASE exclusion constraint, not a service check");
  const trg = (await pool.query(
    `select tgname from pg_trigger where tgname in
      ('trg_pricing_version_immutable','trg_pricing_terms_frozen','trg_concession_policies_frozen')`)).rows;
  ok(trg.length === 3, `immutability is enforced by ${trg.length} database triggers`);

  // ── PHASE 2: authority ────────────────────────────────────────────
  section("PHASE 2 — authority is explicit and fails closed");
  // The property's only owner assignment sat on a demo lead and has been
  // deactivated by ruling, so this can no longer be proven against live data.
  // It is proven against a CONSTRUCTED assignment inside a rolled-back
  // transaction instead — the rule still holds, and the harness no longer
  // depends on an invalid row continuing to exist.
  const deadOwner = await pricingAuthority(pool, { property_id: DEMO, person_id: OWNER_PERSON });
  ok(!deadOwner.may_publish_pricing,
    "the DEACTIVATED owner assignment confers nothing — an inactive row is not authority");

  const c0 = await pool.connect();
  await c0.query("begin");
  const probePool = { query: c0.query.bind(c0) };
  await c0.query(
    `insert into assignments (person_id, property_id, role, is_active)
     values ($1,$2,'owner',true)`, [LEASING_PERSON, DEMO]);
  const owner = await pricingAuthority(probePool, { property_id: DEMO, person_id: LEASING_PERSON });
  ok(owner.may_prepare_pricing && owner.may_review_pricing && owner.may_publish_pricing,
    "an ACTIVE owner assignment holds the pricing verbs (constructed, rolled back)");
  ok(owner.basis.may_publish_pricing === "assignment:owner", "and the receipt names the basis");
  await c0.query("rollback");
  c0.release();
  const stillNone = (await pool.query(
    `select count(*)::int n from assignments where property_id=$1 and is_active=true
       and role in ('owner','asset_manager')`, [DEMO])).rows[0].n;
  ok(Number(stillNone) === 1,
    "and only the ONE governed assignment remains — the constructed probe did not survive the rollback");
  const leasing = await pricingAuthority(pool, { property_id: DEMO, person_id: LEASING_PERSON });
  ok(!leasing.may_publish_pricing && !leasing.may_prepare_pricing,
    "a LEASING assignment grants nothing — generic property membership is not authority");
  ok(leasing.basis.may_publish_pricing === null, "a denied verb carries no basis");
  const nobody = await pricingAuthority(pool, { property_id: DEMO, person_id: null });
  ok(!nobody.may_publish_pricing && nobody.denied_reason === "no_person_identified", "no person is a denial");
  const ghost = await pricingAuthority(pool, { property_id: DEMO, person_id: "00000000-0000-0000-0000-000000000000" });
  ok(!ghost.may_publish_pricing && ghost.denied_reason === "person_not_found", "an unknown person is a denial");
  const wrongProp = await pricingAuthority(pool, { property_id: "9e2bb96e-08e2-41db-81c2-91055ceb50a3", person_id: OWNER_PERSON });
  ok(!wrongProp.may_publish_pricing, "authority does NOT travel to another property");
  const failPool = { query: async () => { throw new Error("db down"); } };
  const broken = await pricingAuthority(failPool, { property_id: DEMO, person_id: OWNER_PERSON });
  ok(!broken.may_publish_pricing && broken.denied_reason === "authority_read_failed",
    "a failed authority read DENIES — unavailable and permitted never collapse the wrong way");

  // THE BOUNDARY: session identity is not linked to a person.
  const qaUser = await pricingAuthority(pool, { property_id: DEMO, user_id: "e9a7659f-ee1a-4bde-9e0c-02c6632ff066" });
  ok(!qaUser.may_publish_pricing && qaUser.denied_reason === "session_identity_not_linked_to_a_person",
    "the QA operator's SESSION cannot reach authority — reported, not name-matched");
  const inv = await authorityInventory(pool, {});
  // ONE by ruling: the demo-lead owner assignment was deactivated, and a
  // governed asset_manager was established on Demo Building only.
  ok(inv.summary.properties_with_publish_authority === 1,
    `exactly ${inv.summary.properties_with_publish_authority} of ${inv.summary.properties_total} properties has publish authority`);
  ok(inv.summary.grants_total === 0, "no authority grants exist anywhere");

  // ── PHASE 4: economic-class validation ────────────────────────────
  section("PHASE 4 — economic-class separation is executable");
  const codes = (r) => r.errors.map((e) => e.code);
  ok(codes(validateMoneyEntry({ economic_class: "one_time_fee", amount: 30, amount_text: "$30/month pet rent",
      cadence: "one_time", required: false, applicability: "pets" }))
    .includes("recurring_entered_as_one_time_fee"), "a monthly charge entered as a one-time fee is refused");
  ok(codes(validateMoneyEntry({ economic_class: "deposit_held", amount: 1000, cadence: "one_time",
      required: true, refundable: true, applicability: "all" }))
    .includes("requirement_entered_as_held_deposit"), "a requirement entered as a held deposit is refused");
  ok(codes(validateMoneyEntry({ economic_class: "credit", amount: 500, cadence: "one_time", advertised: true,
      required: false, applicability: "veterans" }, { authority: {} }))
    .includes("credit_advertised_without_authority"), "a credit advertised without authority is refused");
  ok(codes(validateMoneyEntry({ economic_class: "one_time_fee", amount: 87, amount_text: "a telecom fee of $75–99",
      cadence: "one_time", required: true, applicability: "move-in" }))
    .includes("range_quoted_as_precise_amount"), "a range quoted as a precise amount is refused");
  ok(codes(validateMoneyEntry({ economic_class: "one_time_fee", amount: 50, required: true, applicability: "applicants" }))
    .includes("cadence_unknown"), "a fee without cadence is refused");
  ok(codes(validateMoneyEntry({ economic_class: "one_time_fee", amount: 50, cadence: "one_time", required: true }))
    .includes("required_without_applicability"), "a required charge without applicability is refused");
  ok(codes(validateMoneyEntry({ economic_class: "recurring_charge", amount: 15, cadence: "monthly",
      required: false, applicability: "program", presented_as: "universal" }))
    .includes("optional_presented_as_universal"), "an optional charge presented as universal is refused");
  const dup = validateMoneySet([
    { value_key: "amenity_fee", economic_class: "one_time_fee", amount: 300, cadence: "one_time",
      required: true, applicability: "move-in", canonical_owner: "pricing" },
    { value_key: "amenity_fee", economic_class: "one_time_fee", amount: 300, cadence: "one_time",
      required: true, applicability: "move-in", canonical_owner: "agent_facts" },
  ]);
  ok(dup.errors.some((e) => e.code === "duplicate_value_two_owners"),
    "a duplicated value with two competing owners is refused");
  const rec = validateMoneySet([{ value_key: "parking", economic_class: "recurring_charge", amount: 300,
    cadence: "monthly", required: false, applicability: "optional garage" }]);
  ok(!rec.valid && rec.recurring_disposition.reason === "recurring_charge_model_not_built",
    "a recurring charge is REFUSED from a pricing sheet, not flattened into fee prose");
  ok(/not yet available for precise quoting/.test(rec.recurring_disposition.permitted_statement),
    "and the sheet is given an honest sentence to say instead");
  const good = validateMoneyEntry({ economic_class: "one_time_fee", amount: 50, amount_text: "The application fee is $50.",
    cadence: "one_time", required: true, applicability: "per applicant", refundable: false,
    effective_from: "2026-01-01", authority: "field guide", canonical_owner: "pricing" });
  ok(good.valid, "a clean, fully-specified fee validates");

  // ── PHASE 6: the schedule compiler ────────────────────────────────
  section("PHASE 6 — the compiler produces dated lines, deterministically");
  ok(IMPLEMENTED.length === 8, `all eight profiles are implemented (${IMPLEMENTED.length})`);
  ok(PROFILES.free_rent_period.implemented === true
     && PROFILES.free_rent_period.requires_proration_basis === true,
    "free_rent_period is now implemented and requires an explicit proration basis");
  const waiver = compileSchedule({ timing_profile: "one_time_fee_waiver", concession_type: "fee_waiver",
    fee_category: "application", fee_amount: 50, fee_resolved: true, posting_date: "2026-09-01", base_rent: 1450 });
  ok(waiver.ok && waiver.lines.length === 1 && waiver.lines[0].amount === 50,
    "a fee waiver compiles to exactly one dated credit line");
  ok(waiver.effective_rent === 1450, "and does not change monthly rent");
  const badWaiver = compileSchedule({ timing_profile: "one_time_fee_waiver", concession_type: "fee_waiver",
    fee_category: "telecom", fee_amount: null, fee_resolved: false, posting_date: "2026-09-01" });
  ok(!badWaiver.ok && badWaiver.code === "governed_fee_unresolved",
    "a waiver over an UNRESOLVED governed fee is refused — its size cannot be stated");
  const disc = compileSchedule({ timing_profile: "fixed_monthly_discount", value: 100, duration_months: 3,
    lease_start: "2026-09-15", lease_end: "2027-09-14", base_rent: 1450, lease_term_months: 12 });
  ok(disc.ok && disc.lines.length === 3, "a 3-month discount compiles to three dated lines");
  ok(disc.lines[0].date === "2026-10-01" && disc.lines[2].date === "2026-12-01",
    `lines start at the first FULL month (${disc.lines.map((l) => l.date).join(", ")})`);
  ok(disc.total_credit === 300 && disc.effective_rent === 1425,
    "effective rent is DERIVED from the lines ($1450 − 300/12 = $1425), never asserted beside them");
  const disc2 = compileSchedule({ timing_profile: "fixed_monthly_discount", value: 100, duration_months: 3,
    lease_start: "2026-09-15", lease_end: "2027-09-14", base_rent: 1450, lease_term_months: 12 });
  ok(JSON.stringify(disc) === JSON.stringify(disc2), "the compiler is deterministic — identical inputs, identical output");
  ok(!compileSchedule({ timing_profile: "fixed_monthly_discount", value: 100, duration_months: 3,
      base_rent: 1450 }).ok, "missing lease dates are refused");
  ok(compileSchedule({ timing_profile: "fixed_monthly_discount", value: 100, duration_months: 24,
      lease_start: "2026-09-01", lease_end: "2027-08-31", base_rent: 1450, lease_term_months: 12 }).code
      === "duration_exceeds_term", "a discount longer than the term is refused");
  ok(compileSchedule({ timing_profile: "first_full_month", lease_start: "2026-09-01",
      lease_end: "2027-08-31", base_rent: 1450 }).code === "proration_basis_required",
    "a calendar profile without an explicit proration basis is refused");
  ok(compileSchedule({ timing_profile: "not_a_profile", lease_start: "2026-09-01",
      lease_end: "2027-08-31", base_rent: 1450 }).code === "unknown_timing_profile",
    "and a genuinely unknown profile is refused as unknown");
  const compSrc = fs.readFileSync(path.join(REPO, "src/money/concession_schedule_compiler.js"), "utf8");
  ok(!/Date\.now\(\)|Math\.random\(\)|new Date\(\)/.test(compSrc.replace(/new Date\(Date\.UTC/g, "").replace(/new Date\(String/g, "")),
    "the compiler has no clock and no randomness — it is pure");
  ok(!/free_months/.test(JSON.stringify(disc)), "free_months never appears as economic truth");

  // ── PHASE 9: market evidence ──────────────────────────────────────
  section("PHASE 9 — market evidence is displayable, never consumable");
  ok(mkt.CONSUMPTION_RULE.may_be_displayed_as_evidence === true
     && mkt.CONSUMPTION_RULE.may_be_consumed_as_pricing === false,
    "the boundary is declared: displayable, not consumable");
  const obs = { observation_id: "o1", source: "public_listing", observed_at: "2026-07-20",
    recorded_at: "2026-07-21", subject_kind: "competitor_property", competitor_ref: "comp-a",
    unit_type_relationship: "asserted_comparable", advertised_rent: 1395,
    verification: "public_unverified", confidence: "medium", freshness_days: 7 };
  ok(mkt.validateObservation(obs).valid, "a well-formed observation validates");
  ok(mkt.validateObservation({ ...obs, confidence: "high" }).errors.some((e) => e.code === "confidence_exceeds_verification"),
    "an unverified public listing cannot claim high confidence");
  ok(mkt.validateObservation({ ...obs, governed_unit_type_id: "x" }).errors
      .some((e) => e.code === "competitor_mapped_to_governed_type"),
    "a competitor's unit cannot BE one of our governed types");
  const disp = mkt.asDisplayEvidence([obs]);
  ok(disp.authoritative === false && disp.observations[0].disposition === "evidence_only_not_pricing",
    "displayed evidence is marked non-authoritative on every row");
  ok(mkt.attemptConsumeAsPricing(obs).accepted === false
     && mkt.attemptConsumeAsPricing(obs).code === "market_observation_cannot_become_pricing",
    "consuming an observation as pricing is refused");
  ok(mkt.asDisplayEvidence([]).reason === "governed_market_observations_not_built",
    "with no observations the seam reports honest absence");
  const mktSrc = fs.readFileSync(path.join(REPO, "src/money/market_evidence_contract.js"), "utf8");
  ok(!/pool|query|create table|fetch|http/i.test(mktSrc.replace(/\/\/.*/g, "")),
    "the seam has NO store, NO network and NO schema — contract only");

  // ── PHASE 7: shadow simulator ─────────────────────────────────────
  section("PHASE 7 — shadow comparison sends nothing");
  const before = (await pool.query(
    `select (select count(*)::int from comm_events) c, (select count(*)::int from persons) p`)).rows[0];
  const shadow = await shadowQuoteReport(pool, { property_id: DEMO });
  const after = (await pool.query(
    `select (select count(*)::int from comm_events) c, (select count(*)::int from persons) p`)).rows[0];
  ok(before.c === after.c, `no comm_event was written (${before.c} → ${after.c})`);
  ok(before.p === after.p, `no person was created (${before.p} → ${after.p})`);
  ok(shadow.sent_anything === false && shadow.guarantees.includes("no outbound SMS"), "the report states it sent nothing");
  ok(shadow.comparisons.length > 15, `${shadow.comparisons.length} comparisons across every scenario`);
  ok(shadow.comparisons.some((c) => c.scenario === "unclassified_position"), "unit 101 is covered");
  ok(shadow.comparisons.some((c) => c.scenario === "commercial_space"), "commercial space is covered");
  ok(shadow.comparisons.some((c) => c.scenario === "advertised_concession"), "an advertised concession is covered");
  ok(shadow.comparisons.some((c) => c.scenario === "discretionary_concession"), "a prohibited discretionary concession is covered");
  ok(shadow.summary.would_become_unavailable > 0,
    `${shadow.summary.would_become_unavailable} live answers would become unavailable after cutover — stated, not hidden`);
  ok(shadow.summary.unsupported_precision > 0,
    `${shadow.summary.unsupported_precision} live answers carry unsupported precision`);
  const spread530 = shadow.comparisons.find((c) => c.unsupported_precision
    && c.unsupported_precision.kind === "single_row_from_an_unexplained_spread");
  ok(!!spread530, "the unit-530 shape is detected: a live answer chosen by sort order from a spread");

  // ── PHASE 8: Future Rent Roll contract ────────────────────────────
  section("PHASE 8 — Future Rent Roll preview never reprices locked facts");
  const frr = await futureRentRollPricingPreview(pool, { property_id: DEMO });
  ok(frr.disposition.startsWith("read_only"), "the preview is read-only and not wired into the roll");
  ok(frr.summary.repriced_locked_positions === 0, "ZERO locked positions were repriced");
  ok(frr.rows.filter((r) => r.disposition === "locked_contractual").every((r) => r.pricing_applied === false),
    "every locked position carries pricing_applied = false");
  ok(frr.rows.filter((r) => r.disposition === "pending_successor").every((r) => r.projected_rent === null),
    `all ${frr.summary.pending_successor} pending successors receive zero projected pricing`);
  ok(frr.rows.filter((r) => r.disposition === "contested").every((r) => r.projected_rent === null),
    "contested positions receive zero projected pricing");
  ok(frr.rows.filter((r) => r.disposition === "unclassified").every((r) => r.projected_rent === null),
    "unclassified positions receive no type-based assumption");
  ok(frr.summary.positions_given_projected_pricing === 0,
    "NO uncovered position is given projected revenue — pricing alone cannot create occupancy");
  ok(frr.assumptions.status === "unavailable" && frr.assumptions.reason === "approved_assumption_set_not_built",
    "the assumption set is honestly absent");
  ok(frr.eligible_version_status === "published", "only a published version is eligible — a draft is invisible");

  // ── PHASE 1 (live): draft lifecycle, rolled back ──────────────────
  section("PHASE 1 — draft lifecycle against live constraints (rolled back)");
  const proposal = {
    effective_from: "2026-09-01",
    terms: priced.map((t) => ({ unit_type_id: t.unit_type_id, lease_term_months: 12,
      base_rent: 1500, renewal_rent: 1550, offer_state: "offered" })),
  };
  ok(proposalDigest(proposal) === proposalDigest(JSON.parse(JSON.stringify(proposal))),
    "the proposal digest is stable across serialisation");
  ok(proposalDigest(proposal) !== proposalDigest({ ...proposal, effective_from: "2026-10-01" }),
    "and changes when the proposal changes");

  // Authority gate on the write paths.
  let denied = null;
  try { await saveDraft(pool, { property_id: DEMO, person_id: LEASING_PERSON, proposal }); }
  catch (e) { denied = e.code; }
  ok(denied === "not_authorized_to_prepare", "a leasing assignment cannot save a draft");
  denied = null;
  try { await submitReview(pool, { property_id: DEMO, person_id: LEASING_PERSON, proposal, decision: "approved" }); }
  catch (e) { denied = e.code; }
  ok(denied === "not_authorized_to_review", "a leasing assignment cannot submit a review");

  // Real writes against real constraints and triggers — inside ONE outer
  // transaction that is always rolled back.
  //
  // The property now has NO active owner assignment (the invalid one was
  // deactivated by ruling), so this block needs an authority that does not
  // exist. It is NOT created in production: the assignment is inserted inside
  // the outer transaction and dies with it. A temporary real assignment on a
  // shared database would be an authority grant that survives a crash.
  //
  // The shim neutralises the services' own begin/commit so their transaction
  // control cannot escape the wrapper — an earlier version without this had
  // saveDraft's commit committing the outer transaction.
  const txClient = await pool.connect();
  await txClient.query("begin");
  const rawQuery = txClient.query.bind(txClient);
  const shimQuery = async (text, params) => {
    if (typeof text === "string" && /^\s*(begin|commit|rollback)\s*;?\s*$/i.test(text)) {
      return { rows: [], rowCount: 0 };
    }
    return rawQuery(text, params);
  };
  const txPool = {
    query: shimQuery,
    connect: async () => ({ query: shimQuery, release: () => {} }),
  };
  await rawQuery(
    `insert into assignments (person_id, property_id, role, is_active)
     values ($1,$2,'owner',true)`, [OWNER_PERSON, DEMO]);

  // An EXPECTED failure inside a transaction aborts it, so every intentional
  // refusal runs in its own savepoint. Without this the first proven trigger
  // would poison every assertion after it.
  const expectFail = async (sql, params) => {
    await rawQuery("savepoint sp");
    try { await rawQuery(sql, params); await rawQuery("release savepoint sp"); return null; }
    catch (e) { await rawQuery("rollback to savepoint sp"); return e.message; }
  };

  const created = { versions: [], receipts: [] };
  try {
    // A proposal that WOULD publish, so the digest check is actually reached
    // rather than being masked by an earlier contract refusal.
    const publishable = { ...proposal, publisher_person_id: OWNER_PERSON, receipt_reviewed: true };

    const draft = await saveDraft(txPool, { property_id: DEMO, person_id: OWNER_PERSON, proposal: publishable });
    created.versions.push(draft.draft_version_id);
    ok(!!draft.draft_version_id, "an owner can save a draft");
    ok(draft.status === "draft" && draft.operating_effect === "none", "the draft declares zero operating effect");

    const termRows = (await txPool.query(
      "select count(*)::int n from pricing_terms where pricing_version_id=$1", [draft.draft_version_id])).rows[0].n;
    ok(termRows === priced.length, `all ${termRows} addressed types were written as real rows`);

    const visible = await effectivePropertyPricing(txPool, { property_id: DEMO });
    ok(visible.published_version === null,
      "THE DRAFT IS INVISIBLE — effective pricing still reports no published version");
    ok(visible.absence.reason === "no_published_pricing_version", "and the absence is unchanged");
    const frrWithDraft = await futureRentRollPricingPreview(txPool, { property_id: DEMO });
    ok(frrWithDraft.published_version_at_date === null,
      "and the Future Rent Roll preview is unchanged by the draft's existence");

    const rev = await submitReview(txPool, { property_id: DEMO, person_id: OWNER_PERSON,
      draft_version_id: draft.draft_version_id, proposal: publishable, decision: "approved", note: "harness" });
    created.receipts.push(rev.review_receipt_id);
    ok(!!rev.review_receipt_id, "a review receipt is written");
    ok(rev.proposal_digest === proposalDigest(publishable), "the receipt carries the proposal digest");
    const snap = (await txPool.query(
      "select packet_snapshot, preview_snapshot from pricing_review_receipts where id=$1",
      [rev.review_receipt_id])).rows[0];
    ok(!!snap.packet_snapshot && !!snap.preview_snapshot,
      "the receipt stores the full packet the reviewer saw — reproducible after the draft moves on");

    // THE CHECK THAT MAKES THE RECEIPT MEAN SOMETHING.
    let pubErr = null;
    try {
      await publishVersion(txPool, { property_id: DEMO, person_id: OWNER_PERSON,
        draft_version_id: draft.draft_version_id,
        proposal: { ...publishable, terms: publishable.terms.map((t) => ({ ...t, base_rent: 1600 })) },
        review_receipt_id: rev.review_receipt_id, dry_run: true });
    } catch (e) { pubErr = e.code; }
    ok(pubErr === "proposal_changed_since_review",
      "a sheet edited after review CANNOT publish wearing the old receipt");

    // The receipt survives its draft being replaced — the whole reason the
    // table exists separately from the version.
    await saveDraft(txPool, { property_id: DEMO, person_id: OWNER_PERSON,
      proposal: { ...publishable, note: "rewritten" }, draft_version_id: draft.draft_version_id });
    const stillThere = (await txPool.query(
      "select id, proposal_digest from pricing_review_receipts where id=$1", [rev.review_receipt_id])).rows[0];
    ok(!!stillThere && stillThere.proposal_digest === rev.proposal_digest,
      "the review receipt SURVIVES the draft being rewritten, digest intact");

    // A published version would be immutable — proven against the real trigger.
    await txPool.query("update property_pricing_versions set status='published', effective_from=$2 where id=$1",
      [draft.draft_version_id, "2026-09-01"]);
    const immutable = await expectFail("update property_pricing_versions set effective_from=$2 where id=$1",
      [draft.draft_version_id, "2026-11-01"]);
    ok(/immutable/i.test(immutable || ""), "a published version REFUSES to have its dates altered");
    const frozen = await expectFail("update pricing_terms set base_rent=9999 where pricing_version_id=$1",
      [draft.draft_version_id]);
    ok(/immutable/i.test(frozen || ""), "the terms of a published version REFUSE to change");
    const backToDraft = await expectFail("update property_pricing_versions set status='draft' where id=$1",
      [draft.draft_version_id]);
    ok(/cannot return to draft/i.test(backToDraft || ""), "a published version cannot return to draft");

    // Two published versions cannot cover one day.
    let overlap = null;
    const second = (await txPool.query(
      `insert into property_pricing_versions (property_id,status,effective_from)
       values ($1,'draft','2026-10-01') returning id`, [DEMO])).rows[0].id;
    created.versions.push(second);
    overlap = await expectFail("update property_pricing_versions set status='published' where id=$1", [second]);
    ok(/exclusion|overlap|conflicting key/i.test(overlap || ""),
      `a second published version overlapping the first is REFUSED by the database [${overlap || "NO ERROR RAISED"}]`);
  } finally {
    // ONE rollback discards the draft, the receipt, the published state AND
    // the constructed assignment. Nothing is deleted by id because nothing
    // was ever committed.
    await rawQuery("rollback");
    txClient.release();
  }

  const leftover = (await pool.query(
    `select (select count(*)::int from property_pricing_versions) v,
            (select count(*)::int from pricing_terms) t,
            (select count(*)::int from pricing_review_receipts) r`)).rows[0];
  ok(leftover.v === 0 && leftover.t === 0 && leftover.r === 0,
    `nothing survived the run (versions ${leftover.v}, terms ${leftover.t}, receipts ${leftover.r})`);
  const finalEff = await effectivePropertyPricing(pool, { property_id: DEMO });
  ok(finalEff.published_version === null && finalEff.absence.reason === "no_published_pricing_version",
    "and the property still reports NO published pricing version");

  // ── standing invariants ───────────────────────────────────────────
  section("STANDING INVARIANTS");
  ok(eff.unit_types.find((t) => t.code === "comm").offer_state === "not_applicable_to_residential_pricing",
    "commercial pricing remains not applicable");
  ok(!JSON.stringify({ ...eff, proof: null }).includes("market_rent"), "legacy $0 never becomes an offer");
  const agentSrc = fs.readFileSync(path.join(REPO, "src/agent/agent.js"), "utf8");
  ok(!/pricing_adapter|quotablePricing/.test(agentSrc), "no live agent path reads the governed adapter yet");
  const appHtml = fs.readFileSync(path.join(REPO, "../app/index.html"), "utf8");
  ok(/_rrSignedIn\(\)\) return \{ unit_types: \[\] \}/.test(appHtml),
    "no signed-in path reads the retired client store");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
