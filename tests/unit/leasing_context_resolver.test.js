// ════════════════════════════════════════════════════════════════════
//  leasing_context_resolver.test.js
//
//  Two things under test, and the second is the one that matters:
//
//    1. The resolver picks the right context for a question.
//    2. Narrowing the context did not quietly weaken anything the agent
//       already guaranteed — property isolation, the stale-draft economic
//       comparison, and the refusal to answer from a fact that is not on
//       file for THIS property.
//
//  (2) is tested through the real `resolveContext` with a fake client, so
//  the assertions run against the shipped filter rather than a restatement
//  of it. No database, no model call, no network.
// ════════════════════════════════════════════════════════════════════

"use strict";

const assert = require("node:assert");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");

const resolver = require(path.join(root, "src/agent/leasing_context_resolver"));
const { resolveLeasingContext, selects } = resolver;
const { compareEconomicSources, isEconomic } = require(path.join(root, "src/agent/draft_source_identity"));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`); }
}

// ── a fake client: answers the three reads resolveContext performs ───
const THIS_PROPERTY = "11111111-1111-1111-1111-111111111111";
const OTHER_PROPERTY = "22222222-2222-2222-2222-222222222222";

//  Deliberately shaped like the live corpus described in the handoff: a
//  property with a handful of curated shelves plus economic facts.
const CORPUS = {
  [THIS_PROPERTY]: [
    { fact_key: "pet_policy", category: "pets", rendered_text: "Two pets max, 50lb limit.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    { fact_key: "parking_rules", category: "parking", rendered_text: "Garage parking by waitlist.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    { fact_key: "amenities", category: "leasing_knowledge", rendered_text: "Roof deck, laundry on 2.", source_type: "verified_operator_confirmation", confirmed_at: "2026-09-01" },
    { fact_key: "leasing_faq", category: "leasing_knowledge", rendered_text: "Internet is resident-arranged.", source_type: "verified_operator_confirmation", confirmed_at: "2026-09-01" },
    { fact_key: "neighborhood", category: "leasing_knowledge", rendered_text: "Coffee two blocks north.", source_type: "verified_operator_confirmation", confirmed_at: "2026-09-01" },
    { fact_key: "tour_window", category: "tours", rendered_text: "Tours weekdays 9-5.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    { fact_key: "required_documents", category: "documents", rendered_text: "Photo ID and proof of income.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    //  ECONOMIC — pricing category. Must survive every selection.
    { fact_key: "pricing_admin_fee", category: "pricing", rendered_text: "Admin fee $150.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    { fact_key: "utilities", category: "pricing", rendered_text: "Water billed at $45/mo.", source_type: "management_policy", confirmed_at: "2026-09-01" },
  ],
  //  The demo shape. NOTHING may ever reach into it.
  [OTHER_PROPERTY]: [
    { fact_key: "pet_policy", category: "pets", rendered_text: "DEMO: pets welcome, no limits.", source_type: "management_policy", confirmed_at: "2026-09-01" },
    { fact_key: "amenities", category: "leasing_knowledge", rendered_text: "DEMO: pool, sauna, sky lounge.", source_type: "management_policy", confirmed_at: "2026-09-01" },
  ],
};

function fakeClient({ facts = CORPUS, unitRow = null, charges = [] } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      if (/from agent_facts/i.test(sql)) {
        const pid = params[0];
        //  MIRRORS leasing_knowledge.readActive's real WHERE clause: this
        //  property, active, property-level. A test that returned everything
        //  would not be testing isolation, it would be assuming it.
        return { rows: (facts[pid] || []).map(r => ({ id: r.fact_key, ...r })) };
      }
      if (/property_governed_charges/i.test(sql)) return { rows: charges };
      if (/from units/i.test(sql)) return { rows: unitRow ? [unitRow] : [] };
      return { rows: [] };
    },
  };
}

//  Build the agent module with stubs, purely to reach the real resolveContext.
function realResolveContext() {
  const stubPool = { connect: async () => ({ release() {}, query: async () => ({ rows: [] }) }), query: async () => ({ rows: [] }) };
  const router = require(path.join(root, "src/agent/agent"))({
    pool: stubPool, anthropic: null, INGEST_MODEL: "test-model",
    spawnObligationFromEvent: async () => ({ id: "ob" }),
    completeObligation: async () => {}, leasingLifecycle: {},
  });
  //  router._service is the shipped service surface the authenticated routes
  //  call. Reaching it means these assertions run against the REAL
  //  resolveContext, not a copy of its logic.
  const svc = router && router._service;
  assert.strictEqual(typeof (svc && svc.resolveContext), "function",
    "agent router._service must expose resolveContext");
  return svc.resolveContext;
}

console.log("\nLEASING CONTEXT RESOLVER\n");

// ══════════════════════════════════════════════════════════════════
console.log("1 · a pet question selects the pet fact and nothing unrelated");
{
  const s = resolveLeasingContext({ message: "Can I bring my dog?", propertyId: THIS_PROPERTY });
  ok("intent is pets", s.intents.includes("pets"), s.intents);
  ok("selects pet_policy", s.factKeys.includes("pet_policy"), s.factKeys);
  ok("is a narrow read", s.selective === true && s.basis === "matched", { selective: s.selective, basis: s.basis });
  ok("does NOT select parking", !s.factKeys.includes("parking_rules"), s.factKeys);
  ok("does NOT select neighborhood", !s.factKeys.includes("neighborhood"), s.factKeys);
  ok("does NOT select required_documents", !s.factKeys.includes("required_documents"), s.factKeys);
  ok("does not invoke governed pricing", s.needsPricing === false, s.needsPricing);
  ok("does not invoke governed inventory", s.needsInventory === false, s.needsInventory);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n2 · a parking question selects parking knowledge only");
{
  const s = resolveLeasingContext({ message: "Is there parking on site?", propertyId: THIS_PROPERTY });
  ok("intent is parking", s.intents.includes("parking"), s.intents);
  ok("selects parking_rules", s.factKeys.includes("parking_rules"), s.factKeys);
  ok("does NOT select pet_policy", !s.factKeys.includes("pet_policy"), s.factKeys);
  //  `parking` is inside leasing_knowledge's amenities regex, so the shelf
  //  comes along by way of the EXISTING registry. That is reuse working, not
  //  leakage — the amenities shelf is where parking wording actually lives.
  ok("amenities shelf rides along from the existing registry", s.factKeys.includes("amenities"), s.factKeys);
  ok("no governed pricing required", s.needsPricing === false, s.needsPricing);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n3 · a pricing / availability question requires the governed paths");
{
  const a = resolveLeasingContext({ message: "How much is rent for a studio?", propertyId: THIS_PROPERTY });
  ok("pricing required", a.needsPricing === true, a.needsPricing);
  ok("inventory required", a.needsInventory === true, a.needsInventory);

  const b = resolveLeasingContext({ message: "What do you have available right now?", propertyId: THIS_PROPERTY });
  ok("availability alone requires inventory", b.needsInventory === true, b.needsInventory);

  const c = resolveLeasingContext({ message: "I need a 2BR in August under $2,500.", propertyId: THIS_PROPERTY });
  ok("Example 3 requires pricing", c.needsPricing === true, c.needsPricing);
  ok("Example 3 requires inventory", c.needsInventory === true, c.needsInventory);
  ok("Example 3 is not answered from a knowledge shelf alone",
    c.basis === "matched" || c.basis === "economic_only", c.basis);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n4 · a mixed question selects the fact AND the governed paths");
{
  const s = resolveLeasingContext({ message: "Do you allow dogs and what 2BRs are available?", propertyId: THIS_PROPERTY });
  ok("intent includes pets", s.intents.includes("pets"), s.intents);
  ok("selects pet_policy", s.factKeys.includes("pet_policy"), s.factKeys);
  ok("inventory required", s.needsInventory === true, s.needsInventory);
  ok("still a narrow fact read", s.selective === true, s.selective);
}

// ══════════════════════════════════════════════════════════════════
console.log("\n5 · property scoping — a selection can never reach another property");
{
  const resolveContext = realResolveContext();
  const s = resolveLeasingContext({ message: "Can I bring my dog?", propertyId: THIS_PROPERTY });
  const c = fakeClient();
  return (async () => {
    const ctx = await resolveContext(c, { property_id: THIS_PROPERTY, selection: s });
    const keys = ctx.facts.map(f => f.fact_key);
    const texts = ctx.facts.map(f => f.rendered_text).join(" | ");

    ok("the fact read was scoped to this property", c.seen.some(q =>
      /from agent_facts/i.test(q.sql) && q.params[0] === THIS_PROPERTY), c.seen.map(q => q.params));
    ok("no read was issued for any other property",
      !c.seen.some(q => (q.params || []).includes(OTHER_PROPERTY)), c.seen.map(q => q.params));
    ok("the demo property's pet policy is absent", !/DEMO/.test(texts), texts);
    ok("this property's pet policy is present", keys.includes("pet_policy"), keys);
    ok("unrelated curated shelves were dropped", !keys.includes("neighborhood"), keys);

    // ══════════════════════════════════════════════════════════════
    console.log("\n6 · a missing fact stays missing — no demo fallback, no borrowed answer");
    {
      //  This property has NO laundry-specific key; ask something it cannot
      //  answer while the demo shape could.
      const sel = resolveLeasingContext({ message: "Can I bring my dog?", propertyId: OTHER_PROPERTY });
      //  A property with nothing recorded at all.
      const bare = fakeClient({ facts: { [OTHER_PROPERTY]: [] } });
      const out = await resolveContext(bare, { property_id: OTHER_PROPERTY, selection: sel });
      ok("no facts are returned for a property with none", out.facts.length === 0, out.facts);
      ok("nothing was borrowed from the populated property",
        !bare.seen.some(q => (q.params || []).includes(THIS_PROPERTY)), bare.seen.map(q => q.params));

      //  And a selection that matches nothing on a POPULATED property yields
      //  an empty curated set rather than a near-miss substitute.
      const noMatch = { selective: true, factKeys: ["a_key_no_property_has"], categories: [], needsPricing: false, needsInventory: false };
      const c2 = fakeClient();
      const out2 = await resolveContext(c2, { property_id: THIS_PROPERTY, selection: noMatch });
      const nonEconomic = out2.facts.filter(f => !isEconomic(f));
      ok("an unmatched selection returns no curated fact at all", nonEconomic.length === 0, nonEconomic.map(f => f.fact_key));
    }

    // ══════════════════════════════════════════════════════════════
    console.log("\n7 · the snapshot still carries what stale-draft protection needs");
    {
      const petSel = resolveLeasingContext({ message: "Can I bring my dog?", propertyId: THIS_PROPERTY });
      const cc = fakeClient();
      const narrowed = await resolveContext(cc, { property_id: THIS_PROPERTY, selection: petSel });
      const wide = await resolveContext(fakeClient(), { property_id: THIS_PROPERTY });

      ok("the selected fact is in the snapshot",
        narrowed.facts.some(f => f.fact_key === "pet_policy"), narrowed.facts.map(f => f.fact_key));

      //  THE LOAD-BEARING ONE. Economic sources are identical narrowed and
      //  unnarrowed, so compareEconomicSources — which the pre-send guard
      //  runs against a LIVE unnarrowed read — cannot start reporting a
      //  false difference, and cannot stop seeing a real one.
      const narrowedEcon = narrowed.facts.filter(isEconomic).map(f => f.fact_key).sort();
      const wideEcon = wide.facts.filter(isEconomic).map(f => f.fact_key).sort();
      ok("every economic source survives narrowing",
        JSON.stringify(narrowedEcon) === JSON.stringify(wideEcon), { narrowedEcon, wideEcon });
      ok("economic sources are actually present to be compared", narrowedEcon.length > 0, narrowedEcon);

      const same = compareEconomicSources(narrowed.facts, wide.facts);
      ok("a narrowed snapshot does NOT read as economically stale against a live wide read",
        same.match === true, { added: same.added_ids, removed: same.removed_ids, changed: same.changed_ids });

      //  And a real economic change is still caught after narrowing.
      const moved = JSON.parse(JSON.stringify(CORPUS));
      moved[THIS_PROPERTY] = moved[THIS_PROPERTY].map(f =>
        f.fact_key === "pricing_admin_fee" ? { ...f, rendered_text: "Admin fee $400." } : f);
      const after = await resolveContext(fakeClient({ facts: moved }), { property_id: THIS_PROPERTY });
      const diff = compareEconomicSources(narrowed.facts, after.facts);
      ok("a changed fee still marks the narrowed draft stale",
        diff.match === false && diff.changed_ids.includes("pricing_admin_fee"), diff);

      //  A fee that APPEARS after review is still caught — the guarantee
      //  tests/proofs/draft_stale_source_proof.js asserts.
      const grew = JSON.parse(JSON.stringify(CORPUS));
      grew[THIS_PROPERTY].push({ fact_key: "pricing_pet_fee", category: "pricing", rendered_text: "Pet fee $300.", source_type: "management_policy", confirmed_at: "2026-09-10" });
      const appeared = await resolveContext(fakeClient({ facts: grew }), { property_id: THIS_PROPERTY });
      const grewDiff = compareEconomicSources(narrowed.facts, appeared.facts);
      ok("a fee that appeared after review still marks the draft stale",
        grewDiff.match === false && grewDiff.added_ids.includes("pricing_pet_fee"), grewDiff);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("\n8 · the governed reads are skipped only when genuinely not needed");
    {
      const resolveCtx = resolveContext;
      const unitRow = { unit_number: "3B", bedrooms: 2, bathrooms: 1, square_feet: 900, unit_type_id: "ut-1" };

      const petSel = resolveLeasingContext({ message: "Can I bring my dog?", propertyId: THIS_PROPERTY });
      const c1 = fakeClient({ unitRow });
      const petCtx = await resolveCtx(c1, { property_id: THIS_PROPERTY, unit_id: "u-1", selection: petSel });
      ok("a pet turn still reads the unit (bedrooms are ordinary context)",
        !!petCtx.unit && petCtx.unit.unit_number === "3B", petCtx.unit);
      ok("a pet turn does NOT carry a rent figure",
        petCtx.unit && petCtx.unit.pricing && petCtx.unit.pricing.quotable === false, petCtx.unit && petCtx.unit.pricing);
      ok("the skipped read is marked as NOT READ, not as unquotable",
        petCtx.unit.pricing.not_read_this_turn === true, petCtx.unit.pricing);

      const wideCtx = await resolveCtx(fakeClient({ unitRow }), { property_id: THIS_PROPERTY, unit_id: "u-1" });
      ok("with no selection the unit read is unchanged", !!wideCtx.unit, wideCtx.unit);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("\n9 · the resolver can never starve the direct pricing reply");
    {
      //  directPricingReply fires on its own `asksRent` test and needs
      //  unit.pricing to exist. If PRICING_RX were narrower than asksRent,
      //  a rent question could arrive with pricing deliberately unread and
      //  the direct quote path would silently stop working. Every phrase
      //  that trips asksRent must also trip PRICING_RX.
      const asksRentPhrases = [
        "what is the rent", "what's the pricing", "what is the lease rate",
        "what is the monthly rate", "how much does it cost", "what's the price",
        "how much is the price per month", "what is the cost per month",
      ];
      let allCovered = true;
      const missed = [];
      for (const p of asksRentPhrases) {
        if (!resolver.PRICING_RX.test(p)) { allCovered = false; missed.push(p); }
      }
      ok("every rent phrasing the direct reply recognises also requires pricing", allCovered, missed);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("\n10 · unclassified input loads everything, exactly as before");
    {
      for (const [label, msg] of [["empty", ""], ["greeting", "hi there"], ["opaque", "ok sounds good"]]) {
        const s2 = resolveLeasingContext({ message: msg, propertyId: THIS_PROPERTY });
        ok(`${label}: not a narrow read`, s2.selective === false, { basis: s2.basis, selective: s2.selective });
        ok(`${label}: selects() admits every fact`,
          CORPUS[THIS_PROPERTY].every(f => selects(s2, f)), s2.basis);
      }
      const wide = await resolveContext(fakeClient(), { property_id: THIS_PROPERTY,
        selection: resolveLeasingContext({ message: "hi there", propertyId: THIS_PROPERTY }) });
      ok("an unclassified turn returns the full curated set",
        wide.facts.length === CORPUS[THIS_PROPERTY].length, wide.facts.map(f => f.fact_key));
    }

    // ══════════════════════════════════════════════════════════════
    console.log("\n11 · regressions found by running real prospect phrasings");
    {
      //  Every line below was a MISS on the first version of the table,
      //  found by putting two dozen things a prospect actually texts through
      //  the resolver rather than through the examples in the spec.
      const sel = m => resolveLeasingContext({ message: m, propertyId: THIS_PROPERTY });

      //  THE ONE THAT WOULD HAVE SHIPPED SILENTLY. `\b` after `\d` needs a
      //  non-word character next, so "under $2,500" matched on the COMMA and
      //  "under 2000" did not. Example 3 passed by luck of its punctuation.
      for (const m of ["under 2000", "under $2500", "max 2000", "no more than 1800", "im looking for something under 2000"]) {
        ok(`a stated budget requires governed pricing: "${m}"`, sel(m).needsPricing === true, sel(m));
      }
      ok("the punctuated form still works", sel("I need a 2BR in August under $2,500.").needsPricing === true);

      ok('"can i see it saturday" reaches the tour shelf',
        sel("can i see it saturday").factKeys.includes("tour_window"), sel("can i see it saturday").factKeys);
      ok('"wheres the office" reaches the contact shelf',
        sel("wheres the office").factKeys.includes("office_contact"), sel("wheres the office").factKeys);
      ok('"do you allow subletting" is recognised',
        sel("do you allow subletting").intents.includes("lease_term"), sel("do you allow subletting").intents);
      ok('"how long is the lease" is recognised',
        sel("how long is the lease").intents.includes("lease_term"), sel("how long is the lease").intents);

      //  AND THE DEFECT THAT WIDENING INTRODUCED. lease_term names no shelf,
      //  so matching it produced selective:true with an empty factKeys list —
      //  a narrow read to NOTHING, which tells the model nothing on file
      //  answers the question while the property may hold plenty.
      for (const m of ["how long is the lease", "do you allow subletting"]) {
        const r = sel(m);
        ok(`an intent naming no shelf does not narrow to nothing: "${m}"`,
          r.selective === false && r.basis === "intent_without_shelf", { selective: r.selective, basis: r.basis, factKeys: r.factKeys });
      }
      ok("no selective result is ever empty-handed", [
        "can i see it saturday", "do u take dogs", "is there a gym", "how do I apply",
        "what utilities do i pay", "wheres the office", "how long is the lease",
        "do you allow subletting", "hi", "is it furnished",
      ].every(m => { const r = sel(m); return !r.selective || r.factKeys.length > 0 || r.categories.length > 0; }));

      //  Renters insurance is not what "is wifi included" asked about.
      ok("a wifi question does not select renters insurance",
        !sel("is wifi included").factKeys.includes("renters_insurance"), sel("is wifi included").factKeys);
      ok("an insurance question still does",
        sel("do i need renters insurance").factKeys.includes("renters_insurance"), sel("do i need renters insurance").factKeys);

      //  `floor` alone is not an availability question.
      //  Asserted on the pattern, not on the flag: "what floor is it on"
      //  falls through to `unclassified`, which deliberately sets BOTH flags
      //  true (load everything). The claim here is narrower and is the real
      //  one — a bare "floor" no longer reads as an availability search.
      ok('a bare "floor" is not an availability pattern',
        resolver.INVENTORY_RX.test("what floor is it on") === false);
      ok('"unit on the 3rd floor" still is',
        sel("is the unit on the 3rd floor available").needsInventory === true, sel("is the unit on the 3rd floor available"));
    }

    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  })();
}
