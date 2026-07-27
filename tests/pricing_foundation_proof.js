// ════════════════════════════════════════════════════════════════════
//  pricing_foundation_proof.js — governed Pricing & Concessions, slice 1
//
//  Nothing is published. This proves the FOUNDATION refuses correctly:
//  durable type identity, cross-property rejection, no silent omission,
//  overlap failure, honest absence, and an AI that cannot reach around the
//  truth sheet.
//
//  Run: DATABASE_URL=... node tests/pricing_foundation_proof.js
//  READ-ONLY.
// ════════════════════════════════════════════════════════════════════

"use strict";
const path = require("path");
const { Pool } = require("pg");
const REPO = path.resolve(__dirname, "..");
const DEMO = "a50fbdd0-3642-431e-b532-0dcd6ab8a4fe";
const OTHER = "9e2bb96e-08e2-41db-81c2-91055ceb50a3";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("   PASS  " + m); } else { fail++; console.log("   FAIL  " + m); } };

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.log("FATAL: DATABASE_URL required"); process.exit(1); }
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { effectivePropertyPricing } = require(path.join(REPO, "src/money/effective_pricing"));
  const { checkPublishable, IMPLEMENTED_TIMING_PROFILES } = require(path.join(REPO, "src/money/pricing_publication_contract"));
  const { quotablePricing } = require(path.join(REPO, "src/agent/pricing_adapter"));

  console.log("\n== STRUCTURE: durable unit-type identity ==");
  const cols = (await pool.query(
    `select column_name from information_schema.columns where table_name='pricing_terms'`)).rows.map(r => r.column_name);
  ok(cols.includes("unit_type_id"), "pricing_terms carries a durable unit_type_id");
  ok(cols.includes("property_id"), "pricing_terms carries property_id so the key can enforce scope");
  ok(cols.includes("unit_type"), "the legacy text column is RETAINED as provenance, not dropped");
  ok(cols.includes("offer_state"), "a type can be explicitly not offered / pricing unavailable");
  ok(cols.includes("override_scope") && cols.includes("override_ref"),
    "later cohort/space overrides are possible without being built");
  const fks = (await pool.query(
    `select conname from pg_constraint where conrelid='pricing_terms'::regclass and contype='f'`)).rows.map(r => r.conname);
  ok(fks.includes("fk_pricing_terms_unit_type"), "composite FK ties the term's property to its unit type");
  ok(fks.includes("fk_pricing_terms_version_property"), "composite FK ties the term's property to its version");

  console.log("\n== cross-property unit types are REJECTED BY THE DATABASE ==");
  const otherType = (await pool.query(
    "select id from property_unit_types where property_id<>$1 limit 1", [DEMO])).rows[0];
  const demoVersion = (await pool.query(
    "select id from property_pricing_versions where property_id=$1 limit 1", [DEMO])).rows[0];
  const demoType = (await pool.query(
    "select id from property_unit_types where property_id=$1 limit 1", [DEMO])).rows[0];
  ok(!!demoType, "Demo has governed unit types");
  if (otherType && demoVersion) {
    let rejected = false;
    try {
      await pool.query("begin");
      await pool.query(
        `insert into pricing_terms (pricing_version_id, property_id, unit_type_id, unit_type, lease_term_months, base_rent)
         values ($1,$2,$3,'legacy',12,1000)`, [demoVersion.id, DEMO, otherType.id]);
      await pool.query("rollback");
    } catch (e) { rejected = /foreign key|violates/i.test(e.message); await pool.query("rollback"); }
    ok(rejected, "a term referencing another property's unit type is refused");
  } else {
    // No second property has governed types yet — assert the constraint shape
    // instead of a vacuous pass.
    ok(fks.includes("fk_pricing_terms_unit_type"),
      "no second property has governed types yet; the composite FK is asserted structurally");
  }

  console.log("\n== READ: honest absence ==");
  const eff = await effectivePropertyPricing(pool, { property_id: DEMO });
  ok(eff.published_version === null, "no published version exists");
  ok(eff.absence && eff.absence.reason === "no_published_pricing_version", "absence is named, not an empty object");
  ok(eff.unit_types.length === 9, `every governed type is listed (${eff.unit_types.length})`);
  ok(eff.unit_types.every(t => t.offer_state === "no_published_version"), "each type reports it has no published pricing");
  ok(eff.completeness.types_requiring_decision > 0,
    `${eff.completeness.types_requiring_decision} types have marketable inventory and owe a decision`);
  ok(eff.completeness.complete === false, "completeness is false without a version");
  ok(eff.completeness.unclassified_positions >= 1,
    `unclassified positions are counted, not hidden (${eff.completeness.unclassified_positions})`);
  // The read DECLARES what it refuses to read, so the forbidden names appear
  // in proof.never_reads by design. That declaration is the disclaimer; strip
  // it, then assert the names appear nowhere else — and assert the disclaimer
  // itself separately, so removing it cannot silently pass this test.
  ok(Array.isArray(eff.proof.never_reads)
     && ["units.market_rent", "window.__pricingStore", "rent_survey_observations"]
        .every(s => eff.proof.never_reads.includes(s)),
    "the read names the three sources it refuses, on the record");
  const payload = { ...eff, proof: { ...eff.proof, never_reads: undefined } };
  ok(!JSON.stringify(payload).includes("market_rent"),
    "market_rent carries no value anywhere in the pricing read");

  // Comment lines are prose; the declaration is a string literal. Strip both,
  // so what remains is only source that could actually READ the column.
  const effSrc = require("fs").readFileSync(path.join(REPO, "src/money/effective_pricing.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n")
    .replace(/never_reads:\s*\[[^\]]*\]/, "never_reads:[]");
  ok(!/market_rent|__pricingStore|rent_survey/.test(effSrc),
    "the service never reads market_rent, the client store or a survey observation");

  console.log("\n== FEES: exactly one live source ==");
  ok(eff.fees.source === "agent_facts" && eff.fees.ownership === "transitional_external",
    "fees are exposed as an explicitly external transitional source");
  ok(eff.fees.facts.length === 5, `all five approved fee facts are surfaced (${eff.fees.facts.length})`);
  ok(/fee_terms is NOT read as authority/i.test(eff.fees.owner_note),
    "pricing_terms.fee_terms is explicitly not authority during transition");
  ok(!eff.unit_types.some(t => (t.terms || []).some(x => x.fee_terms_present)),
    "no fee value is quotable from pricing terms today");

  console.log("\n== CONCESSIONS: inactive until schedule lines work ==");
  ok(IMPLEMENTED_TIMING_PROFILES.length === 0, "no timing profile is implemented");
  ok(eff.concessions.advertised.length === 0, "nothing is advertised");
  ok(/schedule_line_engine_not_activated|timing_profile_not_implemented/.test(eff.concessions.concessions_unavailable),
    `concessions report why they are unavailable (${eff.concessions.concessions_unavailable})`);

  console.log("\n== PUBLICATION: fails closed ==");
  const base = {
    property_id: DEMO, effective_from: "2026-08-01",
    publisher: { person_id: "p1", can_publish: true },
    existing_published: [], marketable_types: [], terms: [], concessions: [],
    fee_sources: { governed_count: 0, external_count: 5 }, receipt_reviewed: true,
  };
  ok(checkPublishable(base).publishable, "a complete, empty-inventory picture can publish");
  const codes = (pic) => checkPublishable(pic).blockers.map(b => b.code);
  ok(codes({ ...base, publisher: { person_id: "p1", can_publish: false } }).includes("publisher_lacks_authority"),
    "a publisher without authority is refused");
  ok(codes({ ...base, effective_from: null }).includes("no_effective_from"), "a version without an effective date is refused");
  ok(codes({ ...base, existing_published: [{ version_id: "v9", effective_from: "2026-07-01", effective_until: null }] })
    .includes("overlapping_published_version"), "an overlapping published period is refused");
  ok(codes({ ...base, marketable_types: [{ unit_type_id: "t1", label: "Studio", marketable_positions: 108 }] })
    .includes("marketable_type_not_addressed"),
    "a marketable type left unaddressed is refused - silence cannot publish");
  ok(!codes({ ...base,
      marketable_types: [{ unit_type_id: "t1", label: "Studio", marketable_positions: 108 }],
      terms: [{ unit_type_id: "t1", property_id: DEMO, offer_state: "not_offered", lease_term_months: 12, renewal_rent: null }] })
    .includes("marketable_type_not_addressed"),
    "an EXPLICIT not_offered satisfies the same type");
  ok(codes({ ...base, terms: [{ unit_type_id: null, legacy_unit_type_text: "S.1UN_02", property_id: DEMO, offer_state: "offered", base_rent: 1450, lease_term_months: 12, renewal_rent: 1500 }] })
    .includes("term_without_governed_type"), "a text-only unit type is refused");
  ok(codes({ ...base, terms: [{ unit_type_id: "t1", property_id: OTHER, offer_state: "offered", base_rent: 1450, lease_term_months: 12, renewal_rent: 1500 }] })
    .includes("cross_property_term"), "a cross-property term is refused");
  ok(codes({ ...base, terms: [{ unit_type_id: "t1", property_id: DEMO, offer_state: "offered", base_rent: 1450, lease_term_months: 12, renewal_rent: 1500, promoted_from: "units.market_rent" }] })
    .includes("market_rent_promotion"), "promoting a legacy market_rent value is refused");
  ok(codes({ ...base, terms: [{ unit_type_id: "t1", property_id: DEMO, offer_state: "offered", base_rent: 1450, lease_term_months: 12, renewal_rent: 1500, promoted_from: "client_store" }] })
    .includes("client_store_promotion"), "promoting the client store is refused");
  ok(codes({ ...base, terms: [{ unit_type_id: "t1", property_id: DEMO, offer_state: "offered", base_rent: 1450, lease_term_months: 99, renewal_rent: 1500 }] })
    .includes("invalid_lease_term"), "an invalid lease term is refused");
  ok(codes({ ...base, terms: [{ unit_type_id: "t1", property_id: DEMO, offer_state: "offered", base_rent: 1450, lease_term_months: 12 }] })
    .includes("renewal_pricing_not_addressed"), "renewal pricing must be explicit, even if unavailable");
  ok(codes({ ...base, concessions: [{ concession_type: "free_rent", timing_profile: "first_full_month" }] })
    .includes("concession_timing_profile_not_implemented"),
    "a concession on an unimplemented timing profile is refused");
  ok(!codes({ ...base, concessions: [{ concession_type: "fee_waiver", timing_profile: "first_full_month", fee_category: "admin" }] })
    .includes("concession_timing_profile_not_implemented"),
    "a fee waiver needs no calendar and is publishable");
  ok(codes({ ...base, fee_sources: { governed_count: 3, external_count: 5 } }).includes("two_fee_sources"),
    "two independently quotable fee sources are refused");
  ok(codes({ ...base, receipt_reviewed: false }).includes("no_reviewed_receipt"),
    "a version without a reviewed receipt is refused");

  console.log("\n== AI ADAPTER: dark, and cannot reach around the sheet ==");
  const q1 = await quotablePricing(pool, { property_id: DEMO, unit_type_id: demoType.id });
  ok(q1.quotable === false && q1.reason === "no_published_pricing_version",
    "with no published version the AI cannot quote");
  ok(/confirm the current pricing/i.test(q1.say), "and it hands off honestly rather than guessing");
  const space101 = (await pool.query(
    `select s.id from spaces s join units u on u.id=s.unit_id where u.property_id=$1 and u.unit_number='101'`, [DEMO])).rows[0];
  const q2 = await quotablePricing(pool, { property_id: DEMO, space_id: space101.id });
  ok(q2.quotable === false && q2.reason === "unit_type_unresolved",
    "unit 101 cannot receive type-based pricing until it is classified");
  const q3 = await quotablePricing(pool, {});
  ok(q3.quotable === false && q3.reason === "no_property_context", "no property context means no quote");
  const adapterSrc = require("fs").readFileSync(path.join(REPO, "src/agent/pricing_adapter.js"), "utf8")
    .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok(!/market_rent/.test(adapterSrc), "the adapter never references market_rent");
  ok(!/__pricingStore|pricingFor\(/.test(adapterSrc), "the adapter never references the client store");
  ok(!/survey|comp\b/i.test(adapterSrc), "the adapter never references rent-survey observations");
  ok(!/square_feet|bedrooms|label\s*===/.test(adapterSrc), "the adapter never infers a type from shape or label");
  ok(/effectivePropertyPricing/.test(adapterSrc), "the adapter reads only the governed truth sheet");

  console.log("\n== the adapter is DARK ==");
  const wired = require("child_process").execSync(
    "git grep -l pricing_adapter -- src server.js || true", { cwd: REPO, encoding: "utf8" }).trim();
  ok(wired === "" || wired === "src/agent/pricing_adapter.js",
    `nothing calls the adapter yet (${wired || "no references"})`);

  await pool.end();
  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.log("FATAL:", e.message); process.exit(1); });
