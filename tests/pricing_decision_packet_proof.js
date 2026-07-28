// ════════════════════════════════════════════════════════════════════
//  pricing_decision_packet_proof.js — the Initial Pricing Decision Packet
//
//  Proves the packet informs without recommending, that the preview refuses
//  without writing, that a legacy zero cannot become an offer, and that the
//  adapter stays dark.
//
//  Run: DATABASE_URL=... node tests/pricing_decision_packet_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const { effectivePropertyPricing } = require(path.join(REPO, "src/money/effective_pricing"));
  const { pricingDecisionPacket } = require(path.join(REPO, "src/money/pricing_decision_packet"));
  const { previewPublication } = require(path.join(REPO, "src/money/pricing_publication_preview"));
  const { moneyFactContradictions, VERDICTS } = require(path.join(REPO, "src/money/money_fact_contradictions"));
  const { ECONOMIC_CLASSES, MONEY_OBLIGATION_CONTRACT, representability } = require(path.join(REPO, "src/money/economic_classes"));
  const { quotablePricing } = require(path.join(REPO, "src/agent/pricing_adapter"));

  console.log("\n== CORRECTION: a legacy zero is not an offer ==");
  const eff = await effectivePropertyPricing(pool, { property_id: DEMO });
  const comm = eff.unit_types.find((t) => t.code === "comm");
  ok(!!comm, "the commercial type is still listed, not hidden");
  ok(comm.offer_state === "not_applicable_to_residential_pricing",
    `commercial says not_applicable_to_residential_pricing (${comm.offer_state})`);
  ok(comm.requires_pricing_decision === false, "commercial owes no residential pricing decision");
  ok(comm.residential_positions === 0, "commercial has zero residential positions");
  ok(comm.legacy_value_disposition === "legacy_evidence_only", "its legacy value is marked evidence only");
  ok(!JSON.stringify(comm).includes("\"0\"") && (comm.terms || []).length === 0,
    "no numeric zero is carried as a term");
  const q0 = await quotablePricing(pool, { property_id: DEMO, unit_type_id: comm.unit_type_id });
  ok(q0.quotable === false && q0.reason === "not_applicable_to_residential_pricing",
    "the AI refuses the commercial type by name, not by accident");

  console.log("\n== ECONOMIC CLASSES: seven, kept distinct ==");
  const classes = Object.keys(ECONOMIC_CLASSES);
  ["base_rent","recurring_charge","one_time_fee","deposit_required","deposit_held","concession","credit"]
    .forEach((k) => ok(classes.includes(k), `class ${k} exists`));
  ok(ECONOMIC_CLASSES.base_rent.enters_rent_roll === true, "base_rent enters the rent roll");
  ok(ECONOMIC_CLASSES.recurring_charge.enters_rent_roll === false,
    "a recurring charge does NOT enter the rent roll — collapsing it would overstate NOI");
  ok(ECONOMIC_CLASSES.deposit_required.canonical_owner.includes("NOT pricing"),
    "a deposit REQUIREMENT is underwriting, not pricing");
  ok(ECONOMIC_CLASSES.deposit_held.representable_today === "structurally"
    && ECONOMIC_CLASSES.deposit_required.representable_today === false,
    "held and required are answered differently — a requirement is not a liability");
  ok(MONEY_OBLIGATION_CONTRACT.length === 9, "the obligation contract asks nine questions");
  const rep = representability();
  ok(rep.filter((r) => r.representable_today === false).length === 3,
    "three classes are honestly unrepresentable today");
  ok(rep.every((r) => r.representable_today !== false || r.blocker),
    "every unrepresentable class states WHY, rather than just failing");
  const ecSrc = fs.readFileSync(path.join(REPO, "src/money/economic_classes.js"), "utf8");
  ok(!/create table|alter table/i.test(ecSrc), "the class contract creates no schema");

  console.log("\n== CONTRADICTION REPORT: graded, no second copy ==");
  const money = await moneyFactContradictions(pool, { property_id: DEMO });
  ok(money.disposition === "review_only_no_governed_copy_created", "the report says it is not a source");
  ok(money.summary.total === 12, `${money.summary.total} live money facts are graded (13 minus the cut-over application fee)`);
  ok(money.summary.unreviewed === 0, "no money fact is ungraded");
  ok(money.facts.every((f) => VERDICTS.includes(f.verdict)), "every verdict is from the fixed vocabulary");
  const pet = money.facts.find((f) => f.fact_key === "pet_policy");
  ok(pet && pet.verdict === "conflicting" && pet.one_time_component === 300 && pet.amount === 30,
    "pet_policy is flagged conflicting — one fact carrying two economic classes");
  const tel = money.facts.find((f) => f.fact_key === "pricing_telecom_fee");
  ok(tel && tel.amount === null && tel.unresolved === "range_75_to_99",
    "the telecom range resolves to NO amount rather than a guessed midpoint");
  const mir = money.facts.find((f) => f.fact_key === "move_in_requirements");
  ok(mir && mir.verdict === "prose_duplication", "move_in_requirements is flagged as a duplicate copy");
  ok(money.summary.recurring_charges_with_no_model === 4,
    `four recurring charges have no model (${money.summary.recurring_charges_with_no_model})`);
  ok(money.summary.quoted_today_but_not_safe >= 1,
    `${money.summary.quoted_today_but_not_safe} facts are quoted today but graded not-safe — stated, not hidden`);

  console.log("\n== DECISION PACKET: pacing first, recommending nothing ==");
  const pkt = await pricingDecisionPacket(pool, { property_id: DEMO });
  ok(pkt.disposition === "read_only_preview_no_rows_written", "the packet says it wrote nothing");
  ok(pkt.unit_types.length === 9, "one decision row per governed type");
  const studio = pkt.unit_types.find((r) => r.code === "S.1UN_02");
  ok(!!studio && studio.pacing.residential_positions > 0, "the Studio row carries residential inventory");
  ok(studio.pacing.contractually_locked_at_horizon != null && studio.pacing.uncovered_at_horizon != null,
    "pacing states cover at the horizon, not just today");
  ok(studio.pacing.horizon_days === 90, "the horizon is 90 days");
  ok(studio.pacing.uncovered_at_horizon
     === studio.pacing.residential_positions - studio.pacing.contractually_locked_at_horizon,
    "uncovered is derived from cover, not counted separately");
  ok(studio.evidence.legacy_market_rent.disposition === "evidence_only_never_an_offer",
    "the legacy range is labelled evidence, never an offer");
  ok(studio.evidence.in_place_contractual_rent.claim === "proven_executed_lease",
    "in-place rent carries its claim strength");
  ok(studio.evidence.client_store_status === "unavailable_server_side",
    "the client store has no candidate to carry forward");
  ok(studio.missing_decisions.includes("new_lease_rent") && studio.missing_decisions.includes("renewal_rent"),
    "the row states which decisions are missing");
  const packetJson = JSON.stringify(pkt);
  ok(!/suggested_rent|recommended_rent|proposed_rent/.test(packetJson),
    "the packet contains NO recommendation field");
  ok(pkt.proof.recommends_nothing === true, "and says so on the record");
  ok(pkt.market_evidence.status === "unavailable"
     && pkt.market_evidence.reason === "governed_market_observations_not_built",
    "market evidence is explicitly absent, not silently missing");
  const commRow = pkt.unit_types.find((r) => r.code === "comm");
  ok(commRow.requires_pricing_decision === false && commRow.missing_decisions.length === 0,
    "commercial appears in the packet and is asked for nothing");
  ok(pkt.headline.types_not_applicable === 1, "exactly one type is outside residential pricing");

  console.log("\n== STUDIO SPREAD: distribution, not a rule ==");
  const sp = pkt.spread_analysis.find((s) => s.label === "Studio");
  ok(!!sp && sp.spread > 0, `the Studio spread is reported ($${sp.min}–$${sp.max})`);
  ok(Array.isArray(sp.histogram) && sp.histogram.length === sp.distinct_values,
    `the spread is ${sp.distinct_values} discrete values, not a continuum`);
  ok(sp.histogram.reduce((s, h) => s + h.positions, 0) === sp.count,
    "every position is accounted for in the histogram");
  ok(!!sp.breakdowns.by_square_feet && !!sp.breakdowns.by_floor && !!sp.breakdowns.by_lease_start_year,
    "size, floor and lease-year breakdowns are all returned");
  ok(sp.furnished_split_possible === false,
    "furnished is already a separate governed type, so it cannot explain an in-type spread");
  ok(/never converted into a pricing rule/i.test(sp.interpretation_rule),
    "correlation is explicitly not permitted to become a rule");
  ok(!pkt.spread_analysis.some((s) => s.label === "Commercial Space"),
    "no spread analysis is offered for non-residential inventory");

  console.log("\n== DRY RUN: refuses, and writes nothing ==");
  const empty = await previewPublication(pool, { property_id: DEMO, proposal: {} });
  ok(empty.disposition === "dry_run_no_write_performed", "the preview says it performed no write");
  ok(empty.would_publish === false, "an empty proposal would not publish");
  const codes = (p) => p.blockers.map((b) => b.code);
  ok(codes(empty).includes("no_publisher"), "no publisher is a blocker");
  ok(codes(empty).includes("no_effective_from"), "no effective date is a blocker");
  ok(codes(empty).includes("no_reviewed_receipt"), "no reviewed receipt is a blocker");
  ok(empty.missing_unit_types.length === 8,
    `all eight types owing a decision are listed as missing (${empty.missing_unit_types.length})`);
  ok(!empty.missing_unit_types.some((m) => m.label === "Commercial Space"),
    "commercial is NOT demanded of the publisher");
  ok(empty.publisher_authority_required.can_publish === false,
    "authority is refused when no publisher is named");
  ok(/never taken from the request body/i.test(empty.publisher_authority_required.rule),
    "authority is read from assignments, not asserted by the caller");

  console.log("\n== DRY RUN: authority is READ, not claimed ==");
  const fake = await previewPublication(pool, { property_id: DEMO,
    proposal: { publisher_person_id: "00000000-0000-0000-0000-000000000000", effective_from: "2026-08-01", receipt_reviewed: true } });
  ok(codes(fake).includes("no_publisher") || codes(fake).includes("publisher_lacks_authority"),
    "an unknown person cannot publish by asserting an id");

  console.log("\n== DRY RUN: the quote preview is the deliverable ==");
  ok(Array.isArray(empty.quote_preview) && empty.quote_preview.length === 18,
    `every type is previewed for new-lease AND renewal (${empty.quote_preview.length})`);
  ok(empty.quote_preview.every((q) => q.quotable === false),
    "with a refused sheet, NOTHING is quotable");
  ok(empty.quote_preview.every((q) => q.would_say && !/\$\d/.test(q.would_say)),
    "and no dollar figure appears in any sentence a prospect would hear");
  ok(empty.remains_unavailable.some((r) => r.value === "recurring_charges"),
    "the preview names what would still be unavailable after publishing");
  ok(empty.remains_unavailable.some((r) => r.value === "market_evidence"),
    "including market evidence");

  console.log("\n== DRY RUN: a fee waiver over an ungoverned fee is refused ==");
  const waiver = await previewPublication(pool, { property_id: DEMO, proposal: {
    effective_from: "2026-08-01", receipt_reviewed: true,
    concessions: [{ concession_type: "fee_waiver", fee_category: "telecom", timing_profile: null }],
  }});
  ok(codes(waiver).includes("waiver_over_ungoverned_fee"),
    "waiving the unresolved telecom fee is refused — the discount is unstatable");
  ok(waiver.unsupported_concessions.length > 0, "and it is surfaced as an unsupported concession");

  console.log("\n== DRY RUN: a complete sheet still refuses on real blockers ==");
  const full = await previewPublication(pool, { property_id: DEMO, proposal: {
    effective_from: "2026-08-01", receipt_reviewed: true,
    publisher_person_id: "00000000-0000-0000-0000-000000000000",
    terms: eff.unit_types.filter((t) => t.requires_pricing_decision).map((t) => ({
      unit_type_id: t.unit_type_id, lease_term_months: 12, base_rent: 1500,
      renewal_rent: 1550, offer_state: "offered",
    })),
  }});
  ok(full.missing_unit_types.length === 0, "with all eight addressed, none are missing");
  ok(full.would_publish === false, "it still refuses — authority is not satisfied");
  ok(full.quote_preview.every((q) => !q.quotable), "so still nothing would be quoted");

  console.log("\n== the adapter is STILL dark ==");
  const callers = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === "node_modules" || f.name.startsWith(".")) continue;
      const full2 = path.join(dir, f.name);
      if (f.isDirectory()) { walk(full2); continue; }
      if (!f.name.endsWith(".js")) continue;
      if (full2.includes("pricing_adapter") || full2.includes("tests")) continue;
      const src = fs.readFileSync(full2, "utf8");
      if (/require\([^)]*pricing_adapter/.test(src)) callers.push(path.relative(REPO, full2));
    }
  };
  walk(path.join(REPO, "src"));
  // Both consumers are preview-only: one writes nothing, the other sends
  // nothing. Dark means no prospect-facing path calls it, not zero references.
  const allowed = ["pricing_publication_preview", "shadow_quote_simulator", "economic_adapter"];
  ok(callers.length > 0 && callers.every((c) => allowed.some((a) => c.includes(a))),
    `only preview-only consumers call the adapter (${callers.join(", ") || "none"})`);
  const agentSrc = fs.readFileSync(path.join(REPO, "src/agent/agent.js"), "utf8");
  ok(!/pricing_adapter|quotablePricing/.test(agentSrc),
    "the LIVE agent still does not call the adapter — quoting behaviour is unchanged");

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
