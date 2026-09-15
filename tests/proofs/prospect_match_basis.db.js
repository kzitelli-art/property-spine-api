#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   prospect_match_basis.db.js — MATCHING IS RETRIEVAL ON A DECLARED BASIS.

   Governed by docs/handoffs/new-hp/rulings/MATCHING_BASIS_RULING_20260914.md
   (MB-1 … MB-9). Every assertion below names the ruling it enforces.

   THE FIRST RED this proof exists to show, on the unmodified baseline:
   nothing answers "which homes satisfy this prospect's recorded
   constraints, and on what basis".
     · the canonical leasing owner exposes no such read            (MB-1)
     · no HTTP door answers it for a staff session                 (MB-8)
     · Ask Spine neither declares nor gathers the domain           (MB-8)
     · and the seam that exists today HIDES a budget-violating home
       instead of returning it `violated` with its basis            (MB-3)
   The fourth is the substantive one: absence is a gap, but silently
   dropping a home the prospect cannot afford is a wrong answer.

   Fixture SQL below runs BEFORE any business action and is labelled as
   fixture setup, never as a result. Synthetic tenants and names only.

   Rungs: [DB] canonical readers against real Postgres · [HTTP] the real
   server door · [ASK] the Ask Spine composer. No browser rung.
   ════════════════════════════════════════════════════════════════════ */
"use strict";
const crypto = require("node:crypto");
const { Pool } = require("pg");
const receipt = require("../_run_receipt");
const HARNESS = __filename, EXPECTED = 63;
const URL_ = receipt.harnessConnectionString();
const pool = new Pool({ connectionString: URL_, ssl: false });
const BASE = (process.env.E2E_API_BASE || "http://127.0.0.1:3000").replace(/\/$/, "");
const EXPECT_DEFECT = process.env.PROOF_EXPECT_DEFECT === "1";

const staffSessions = require("../../src/identity/staff_session_service");
const { recordPersonFact } = require("../../src/identity/person_facts");
const { materializeRentableSpaces } = require("../../src/tenancy/inventory_materialization");
const leasingInventory = require("../../src/leasing/leasing_inventory");

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d) => { if (c) { pass++; console.log("  ok    " + n); }
  else { fail++; failures.push(n); console.log("  FAIL  " + n + (d ? "\n        " + String(d).slice(0, 400) : "")); } };
const note = (t) => console.log("    · " + t);
const call = (method, p, hdrs, body) => fetch(BASE + p, { method,
  headers: Object.assign({ "content-type": "application/json" }, hdrs || {}),
  body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const TERM = { requested_start: "2027-01-05", requested_end: "2027-12-31", lease_term_months: 12 };
const tag = "MB_" + crypto.randomBytes(3).toString("hex");

(async () => {
  receipt.begin(HARNESS, { url: URL_, expected: EXPECTED });

  // ══ FIXTURE SETUP — labelled, and BEFORE any business action ══════
  //  THE PROOF OWNS ITS INVENTORY. An earlier version borrowed the shared
  //  Skyline fixture, which passed locally and failed in CI: by the time
  //  this step runs, twenty other proofs have leased, applied to and moved
  //  into Skyline, so its one eligible target is gone. A proof that depends
  //  on another proof's leftovers is measuring the order of the suite.
  //
  //  So this establishes its own governed inventory the way the product
  //  does — import batch → activation → source row → confirmed proposed
  //  record → established opening position — copied in shape from
  //  tests/e2e/property_fixture.sql. Two homes, both confirmed vacant, so
  //  the ordering tiebreaks have something to order. Invented figures.
  const org = (await pool.query("insert into organizations(name,slug) values($1,$2) returning id",
    [tag, tag.toLowerCase()])).rows[0].id;
  const person = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect ${tag}`])).rows[0].id;
  const personNoFacts = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect No Facts ${tag}`])).rows[0].id;
  const staff = (await pool.query(`insert into users(name,email,phone,role,auth_provider,platform_role,
      organization_id,is_active,status,account_kind) values($1,$2,$3,'property_manager','phone_otp',
      'org_admin',$4,true,'active','human_staff') returning id`,
    [`Synthetic Staff ${tag}`, `${tag.toLowerCase()}@example.test`,
     `+1215${String(5000000 + (parseInt(tag.slice(3), 16) % 4000000)).padStart(7, "0")}`, org])).rows[0].id;

  async function property(name, display) {
    const id = (await pool.query(`insert into properties(name,display_name,address,organization_id,
      leasing_basis,operating_timezone) values($1,$2,'1 Fixture Way',$3,'unit','America/New_York')
      returning id`, [name, display, org])).rows[0].id;
    await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,role_key,
      scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values($1,$2,'property_admin','property_admin','property',array['leasing','management'],'{management}',true,true)`,
      [id, staff]);
    return id;
  }
  //  ESTABLISH CONFIRMED VACANT POSITIONS, through the same objects a real
  //  confirmation writes. Without this the classifier answers
  //  `occupancy_unknown` and the target read refuses the home — correctly.
  //
  //  ONE opening position per property: uq_opening_tenancy_position_current_per_property
  //  enforces it, which is the product rule, so every home at a property is
  //  established under ONE activation with one source row each.
  async function establishVacantHomes(propertyId, unitNumbers, unitTypeId) {
    const batch = (await pool.query(`insert into import_batches(property_id,source_type,source_file,
      source_as_of_date,leasing_model,confidence,status)
      values($1,'rent_roll_ledger',$2,date '2026-07-31','unit','confirmed','committed') returning id`,
      [propertyId, `${tag}-${propertyId.slice(0, 8)}.csv`])).rows[0].id;
    const act = (await pool.query(`insert into activations(property_id,status,source_as_of_date,
      import_batch_id,source_label) values($1,'activated',date '2026-07-31',$2,$3) returning id`,
      [propertyId, batch, `${tag}.csv`])).rows[0].id;
    const made = [];
    let rowIndex = 0;
    for (const unitNumber of unitNumbers) {
      rowIndex++;
      const unit = (await pool.query(`insert into units(property_id,unit_number,bedrooms,bathrooms,
        unit_type_id,unit_type_source) values($1,$2,2,1,$3,'fixture') returning id`,
        [propertyId, unitNumber, unitTypeId])).rows[0].id;
      await pool.query("delete from spaces where unit_id=$1", [unit]);   // drop the trigger placeholder
      await materializeRentableSpaces(pool, { unit_id: unit, labels: ["Whole"], kind: "unit" });
      //  use_type is the operating-use decision and the materializer does not
      //  make it. Without it the target read answers `use_not_configured` and
      //  refuses the home — correctly, which is why the fixture must record
      //  it rather than the reader assume it.
      await pool.query("update spaces set use_type='residential' where unit_id=$1", [unit]);
      const space = (await pool.query("select id from spaces where unit_id=$1 limit 1", [unit])).rows[0].id;
      const row = (await pool.query(`insert into import_source_rows(import_batch_id,row_index,raw,parse_note,
        produced_unit_id,produced_space_id) values($1,$2,$3,'fixture: confirmed vacancy',$4,$5) returning id`,
        [batch, rowIndex, JSON.stringify({ unit_number: unitNumber, space_label: "Whole", is_vacant: true }),
         unit, space])).rows[0].id;
      await pool.query(`insert into proposed_records(activation_id,property_id,module,target_type,natural_key,
        normalized_json,status,status_reason,import_source_row_id,confirmed_at)
        values($1,$2,'leasing','lease',$3,$4,'promoted','Fixture: confirmed vacant rentable position.',$5,now())`,
        [act, propertyId, `${unitNumber}|Whole`,
         JSON.stringify({ section: "current", unit_number: unitNumber, space_label: "Whole", is_vacant: true }), row]);
      made.push({ unit, space, unitNumber });
    }
    await pool.query(`insert into opening_tenancy_positions(property_id,activation_id,import_batch_id,
      as_of_date,positions_established,positions_unresolved,source_rows_read,authority_basis,status)
      values($1,$2,$3,date '2026-07-31',$4,0,$4,'fixture:prospect_match_basis.db.js','established')`,
      [propertyId, act, batch, made.length]);
    return made;
  }

  const priced = await property(`${tag} priced`, "Priced (fixture)");
  const unpriced = await property(`${tag} unpriced`, "Unpriced (fixture)");
  const typeFor = {};
  for (const pr of [priced, unpriced]) {
    typeFor[pr] = (await pool.query(`insert into property_unit_types(property_id,code,label,sort_order)
      values($1,'2BR','2 Bed / 1 Bath',1) returning id`, [pr])).rows[0].id;
  }
  await establishVacantHomes(priced, ["P-101", "P-102"], typeFor[priced]);
  await establishVacantHomes(unpriced, ["U-201"], typeFor[unpriced]);

  //  Published pricing for the priced property only: draft, then publish,
  //  which is the order the immutability rule requires.
  const ver = (await pool.query(`insert into property_pricing_versions(property_id,status,effective_from,note)
      values($1,'draft',current_date - 1,'FIXTURE — not authorized pricing') returning id`, [priced])).rows[0].id;
  await pool.query(`insert into pricing_terms(pricing_version_id,property_id,unit_type_id,unit_type,
      lease_term_months,base_rent,offer_state) values($1,$2,$3,'2BR',12,1400.00,'offered')`,
    [ver, priced, typeFor[priced]]);
  await pool.query("update property_pricing_versions set status='published', published_at=now() where id=$1", [ver]);

  //  LEGACY-ONLY HOME (acceptance case 5): bedrooms populated and flagged
  //  vacant, with its trigger-provisioned space REMOVED, so there is no
  //  governed position behind it. If matching ever reads the legacy
  //  columns, this row appears in the answer.
  const legacyUnit = (await pool.query(`insert into units(property_id,unit_number,bedrooms,bathrooms,occupancy_status)
      values($1,$2,2,1,'vacant') returning id`, [priced, `LEGACY-${tag}`])).rows[0].id;
  await pool.query("delete from spaces where unit_id=$1", [legacyUnit]);
  const legacySpaces = (await pool.query("select count(*)::int n from spaces where unit_id=$1", [legacyUnit])).rows[0].n;
  ok("PRECONDITION: the legacy-only home has bedrooms and a vacant flag but NO governed position",
    legacySpaces === 0, `spaces=${legacySpaces}`);

  const skyline = priced;   // the property under test for every case below

  //  The prospect's RECORDED constraint, through the canonical writer. The
  //  governed price is 1400, so a recorded budget of 900 makes both homes
  //  violated — the case MB-3 exists for. pa_typed_source_has_ref: a TYPED
  //  receipt must carry its id, and this fixture has no lead row to point
  //  at, so the honest receipt is 'unknown', which the writer allows.
  const budgetWrite = await recordPersonFact(pool, {
    personId: person, propertyId: priced, attrKey: "budget", attrValue: "900",
    source: "human", sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  ok("PRECONDITION: the prospect's budget is recorded through the canonical person-fact writer",
    budgetWrite.written === true, JSON.stringify(budgetWrite.skipped_reason || null));
  ok("PRECONDITION: two governed homes are established and priced for this term",
    (await pool.query("select count(*)::int n from spaces s join units u on u.id=s.unit_id where u.property_id=$1",
      [priced])).rows[0].n === 2, "expected exactly two rentable positions at the priced property");

  const token = (await staffSessions.issueStaffSession(pool,
    { userId: staff, propertyId: priced, purpose: "bootstrap_invite" })).session_token;
  const H = { "x-staff-session": token };
  const inv = leasingInventory({ pool });

  // ══ MB-1 / MB-8 — THE READ AND ITS PROJECTION EXIST ══════════════
  console.log("\nMB-1 [DB] the canonical read and its projection");
  ok("MB-1: the leasing inventory owner exposes a canonical prospect-match read",
    typeof inv.matchProspectHomes === "function", "exports: " + Object.keys(inv).join(", "));
  ok("MB-8: and a compact standing projection beside it",
    typeof inv.readProspectMatchStanding === "function", "exports: " + Object.keys(inv).join(", "));

  // ══ ACCEPTANCE 1 — BUDGET BELOW EVERY GOVERNED PRICE ═════════════
  console.log("\nACCEPTANCE 1 [DB] recorded budget below every governed price");
  const r1 = await inv.matchProspectHomes({ property_id: skyline, person_id: person, ...TERM }, pool);
  ok("MB-1: the answer declares itself retrieval and disclaims comparison and cause",
    r1.capability_class === "retrieval"
      && r1.claims_not_made.includes("comparison") && r1.claims_not_made.includes("causal_explanation"),
    JSON.stringify({ cls: r1.capability_class, not: r1.claims_not_made }));
  ok("MB-3: the over-budget home is RETURNED, not hidden", r1.home_count >= 1 && r1.homes.length >= 1,
    JSON.stringify({ count: r1.home_count }));
  const h1 = r1.homes[0];
  const price1 = h1 && h1.basis.find((b) => b.constraint === "price");
  ok("MB-3: its price constraint reads exactly `violated`", price1 && price1.state === "violated",
    JSON.stringify(price1));
  ok("MB-2: the basis names the recorded prospect fact — key, value and provenance",
    price1 && price1.prospect_fact && price1.prospect_fact.key === "budget"
      && String(price1.prospect_fact.value) === "900" && !!price1.prospect_fact.source
      && !!price1.prospect_fact.recorded_at, JSON.stringify(price1 && price1.prospect_fact));
  ok("MB-2: and the governed home fact it was compared against, with its read and as-of",
    price1 && price1.home_fact && price1.home_fact.read === "effective_pricing.resolveSpaceEconomics"
      && Number(price1.home_fact.value) === 1400 && !!price1.home_fact.as_of,
    JSON.stringify(price1 && price1.home_fact));
  ok("MB-4: the price came from the published pricing authority, not a legacy column",
    price1 && price1.home_fact && price1.home_fact.authority != null,
    JSON.stringify(price1 && price1.home_fact && price1.home_fact.authority));
  //  Scan for a scoring KEY, not the word. The payload deliberately CONTAINS
  //  the word "score" — inside claims_not_made, where it says the read does
  //  not produce one. A substring test fails on its own disclaimer.
  const scoringKeys = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (/(^|_)(score|weight|rank|ranking|fit)(_|$)/i.test(k)) scoringKeys.push(k);
        walk(val);
      }
    }
  })(r1);
  ok("MB-1: no score, weight or ranking KEY appears anywhere in the payload",
    scoringKeys.length === 0, "scoring keys present: " + scoringKeys.join(", "));
  ok("MB-1: and the payload says in its own words that it produces no score",
    Array.isArray(r1.claims_not_made) && r1.claims_not_made.includes("score"),
    JSON.stringify(r1.claims_not_made));

  // ══ ACCEPTANCE 5 — LEGACY-ONLY HOME MUST NOT APPEAR ══════════════
  ok("MB-4 / acceptance: the legacy-only home (bedrooms + vacant, no position) does not appear",
    !r1.homes.some((h) => String(h.unit_id) === String(legacyUnit)),
    JSON.stringify(r1.homes.map((h) => h.unit_number)));

  // ══ MB-3 — READINESS IS COMPARED, NOT ASSUMED ════════════════════
  //  The first delivered version named `move_month` as the prospect fact of
  //  the readiness constraint and then decided the state purely from whether
  //  the home had a governed ready date. A home ready AFTER the month the
  //  prospect recorded read `satisfied`, and `violated` was unreachable — a
  //  two-state constraint wearing a three-state label, naming a fact it had
  //  not compared. That is the exact failure MB-3 exists to prevent, in the
  //  read that exists to enforce it.
  console.log("\nMB-3 [DB] readiness against the recorded move month");
  const personEarly = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect Early ${tag}`])).rows[0].id;
  await recordPersonFact(pool, { personId: personEarly, propertyId: priced,
    attrKey: "move_month", attrValue: "2026-08", source: "human",
    sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  const rEarly = await inv.matchProspectHomes({ property_id: priced, person_id: personEarly, ...TERM }, pool);
  const readyEarly = rEarly.homes[0] && rEarly.homes[0].basis.find((b) => b.constraint === "readiness");
  note(`recorded move_month 2026-08 vs governed ready ${rEarly.homes[0] && rEarly.homes[0].governed_ready_date}`);
  ok("MB-3: a home whose governed ready date is AFTER the recorded move month reads `violated`",
    readyEarly && readyEarly.state === "violated", JSON.stringify(readyEarly));
  ok("MB-2: and the basis names the move_month it actually compared",
    readyEarly && readyEarly.prospect_fact && readyEarly.prospect_fact.key === "move_month"
      && String(readyEarly.prospect_fact.value) === "2026-08", JSON.stringify(readyEarly && readyEarly.prospect_fact));
  //  BOTH DIRECTIONS, and the boundary itself. `violated` above proves the
  //  comparison can fail; without these it is not proven it can ever pass,
  //  and a constraint that only ever fails is as useless as one that only
  //  ever passes. The governed ready date is 2026-09-14, so:
  //    · a month ending AFTER it            -> satisfied
  //    · the month it falls in (its own end) -> satisfied, boundary included
  //    · a month Spine cannot read           -> not_established, never satisfied
  const personLate = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect Late ${tag}`])).rows[0].id;
  await recordPersonFact(pool, { personId: personLate, propertyId: priced,
    attrKey: "move_month", attrValue: "2026-12", source: "human",
    sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  const rLate = await inv.matchProspectHomes({ property_id: priced, person_id: personLate, ...TERM }, pool);
  const readyLate = rLate.homes[0] && rLate.homes[0].basis.find((b) => b.constraint === "readiness");
  ok("MB-3: a home ready BEFORE the end of the recorded month reads `satisfied`",
    readyLate && readyLate.state === "satisfied", JSON.stringify(readyLate));

  //  THE BOUNDARY. The recorded month is the one the ready date falls in, so
  //  the comparison is against that month's LAST day — a prospect who said
  //  September can take a home ready on the 30th, and an off-by-one here
  //  would refuse a home they can actually have.
  const readyDate = String(rLate.homes[0].governed_ready_date);
  const sameMonth = readyDate.slice(0, 7);
  const personBoundary = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect Boundary ${tag}`])).rows[0].id;
  await recordPersonFact(pool, { personId: personBoundary, propertyId: priced,
    attrKey: "move_month", attrValue: sameMonth, source: "human",
    sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  const rBoundary = await inv.matchProspectHomes({ property_id: priced, person_id: personBoundary, ...TERM }, pool);
  const readyBoundary = rBoundary.homes[0] && rBoundary.homes[0].basis.find((b) => b.constraint === "readiness");
  note(`boundary: recorded month ${sameMonth} contains the governed ready date ${readyDate}`);
  ok("MB-3: the month CONTAINING the ready date is satisfied — the last day counts",
    readyBoundary && readyBoundary.state === "satisfied", JSON.stringify(readyBoundary));

  //  A RECORDED MONTH SPINE CANNOT READ. "spring" is a recorded fact and not
  //  a comparable one; treating it as satisfied would promote a home on a
  //  comparison that never happened, which is the defect this whole family
  //  was corrected for.
  const personVague = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Prospect Vague ${tag}`])).rows[0].id;
  await recordPersonFact(pool, { personId: personVague, propertyId: priced,
    attrKey: "move_month", attrValue: "spring", source: "human",
    sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  const rVague = await inv.matchProspectHomes({ property_id: priced, person_id: personVague, ...TERM }, pool);
  const readyVague = rVague.homes[0] && rVague.homes[0].basis.find((b) => b.constraint === "readiness");
  ok("MB-3: an unreadable recorded month is `not_established`, never satisfied",
    readyVague && readyVague.state === "not_established"
      && readyVague.why === "recorded_move_month_not_a_month", JSON.stringify(readyVague));
  ok("MB-2: and the basis still shows the recorded value Spine could not compare",
    readyVague && readyVague.prospect_fact && String(readyVague.prospect_fact.value) === "spring",
    JSON.stringify(readyVague && readyVague.prospect_fact));

  // ══ ACCEPTANCE 2 — NO BUDGET RECORDED ════════════════════════════
  console.log("\nACCEPTANCE 2 [DB] no budget recorded");
  const r2 = await inv.matchProspectHomes({ property_id: skyline, person_id: personNoFacts, ...TERM }, pool);
  const price2 = r2.homes[0] && r2.homes[0].basis.find((b) => b.constraint === "price");
  ok("MB-3: price is `not_established`, never satisfied and never hidden",
    r2.homes.length >= 1 && price2 && price2.state === "not_established",
    JSON.stringify(price2));
  ok("MB-3: and it names WHY — the prospect fact is missing, not the home fact",
    price2 && price2.why === "no_recorded_budget" && price2.prospect_fact === null
      && price2.home_fact !== null, JSON.stringify({ why: price2 && price2.why }));
  const ready2 = r2.homes[0] && r2.homes[0].basis.find((b) => b.constraint === "readiness");
  ok("MB-3: with no recorded move_month, readiness is `not_established` and says so",
    ready2 && ready2.state === "not_established" && ready2.why === "no_recorded_move_month"
      && ready2.prospect_fact === null, JSON.stringify(ready2));
  ok("MB-5: the ordering rule is still named and deterministic",
    typeof r2.ordering_rule === "string" && r2.ordering_rule === r1.ordering_rule
      && /→/.test(r2.ordering_rule), JSON.stringify(r2.ordering_rule));
  const proj2 = await inv.readProspectMatchStanding(pool,
    { property_id: skyline, person_id: personNoFacts, ...TERM });
  ok("MB-8: the projection says how many homes are unknown on price",
    proj2.read_state === "OK" && proj2.unknown_on_price === r2.home_count && proj2.unknown_on_price >= 1,
    JSON.stringify({ unknown: proj2.unknown_on_price, considered: proj2.homes_considered }));
  ok("MB-8: and names which prospect facts are missing rather than implying none exist",
    Array.isArray(proj2.missing_prospect_facts) && proj2.missing_prospect_facts.includes("budget"),
    JSON.stringify(proj2.missing_prospect_facts));
  ok("MB-8: the projection carries NO record ids",
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(JSON.stringify(proj2)),
    JSON.stringify(proj2).slice(0, 200));

  // ══ ACCEPTANCE 3 — NO PUBLISHED PRICING AT THE PROPERTY ══════════
  console.log("\nACCEPTANCE 3 [DB] a property with no published pricing");
  const r3 = await inv.matchProspectHomes({ property_id: unpriced, person_id: person, ...TERM }, pool);
  ok("MB-6: the price family is reported unavailable for the property, not silently empty",
    r3.matched === true && r3.constraint_coverage
      && ["unavailable_for_this_property", "no_governed_homes"].includes(r3.constraint_coverage.price),
    JSON.stringify(r3.constraint_coverage));
  ok("MB-6: readiness is still reported as an evaluable family or honestly as no governed homes",
    r3.constraint_coverage && ["evaluable", "no_governed_homes"].includes(r3.constraint_coverage.readiness),
    JSON.stringify(r3.constraint_coverage));
  ok("MB-6: and the answer is NOT the phrase 'no matches'",
    r3.qualification === "match_basis_recorded", JSON.stringify(r3.qualification));

  // ══ ACCEPTANCE 4 — NO TERM ═══════════════════════════════════════
  console.log("\nACCEPTANCE 4 [DB/HTTP] no term");
  const r4 = await inv.matchProspectHomes({ property_id: skyline, person_id: person }, pool);
  //  ⚠ CONTRACT CHANGED DELIBERATELY. This block used to assert that a
  //  term-less match REFUSED and returned no homes. Showing and offering
  //  are different decisions: a missing lease term prevents a priced
  //  contractual offer, it does not make the homes unknown, and the
  //  composer always gathers without a term — so the old contract meant
  //  an operator asking "what can I show?" got nothing. The old concern
  //  is still honoured, and more strongly: the risk was an EMPTY set
  //  reading as "no inventory", and this now returns a populated one.
  ok("SHOWING: a term-less match ANSWERS instead of refusing",
    r4.matched === true, JSON.stringify(r4.qualification));
  ok("SHOWING: it returns candidate homes, not an empty set that reads as no inventory",
    Array.isArray(r4.homes) && r4.homes.length > 0, `homes=${(r4.homes || []).length}`);
  ok("OFFER RESTRICTION HELD: with no term the ceiling is likely_fit, never offerable",
    r4.decision_strength_ceiling === "likely_fit", JSON.stringify(r4.decision_strength_ceiling));
  ok("OFFER RESTRICTION HELD: NO home claims it is offerable without a chosen term",
    (r4.homes || []).every((h) => h.decision_strength !== "offerable"),
    JSON.stringify((r4.homes || []).map((h) => h.decision_strength).slice(0, 6)));
  ok("SHOWING: the one missing fact is NAMED so a caller can ask for exactly it",
    r4.needs_for_offer === "requested_dates", JSON.stringify(r4.needs_for_offer));
  ok("§5: the term constraint is NOT recorded satisfied when no term was chosen",
    (r4.homes || []).every((h) => {
      const t = h.basis.find((b) => b.constraint === "term");
      return t && t.state === "not_established";
    }), "a term nobody chose was recorded as agreed");
  ok("COVERAGE: term coverage says the comparison did not happen",
    r4.constraint_coverage.term === "term_not_chosen", JSON.stringify(r4.constraint_coverage.term));
  const r4b = await inv.matchProspectHomes({ property_id: skyline, person_id: person,
    requested_start: "2027-01-05", requested_end: "2027-12-31" }, pool);
  //  ⚠ THE DISTINCTION THIS ASSERTION ALWAYS PROTECTED, KEPT AND MADE
  //  SHARPER. It used to prove that a missing PRICING term was a
  //  different REFUSAL from missing dates. Both now answer instead of
  //  refusing, so the distinction moves to what each says is missing --
  //  and the dates the caller DID supply must still read as established,
  //  because the homes were evaluated for that exact interval.
  ok("PRICING TERM: dates were supplied, so the answer does not claim they are missing",
    r4b.matched === true && r4b.constraint_coverage.term === "evaluable",
    JSON.stringify([r4b.matched, r4b.constraint_coverage && r4b.constraint_coverage.term]));
  ok("PRICING TERM: the missing fact named is the pricing term, NOT the dates",
    r4b.needs_for_offer === "pricing_term", JSON.stringify(r4b.needs_for_offer));
  ok("PRICING TERM: still not offerable, because the priced term is unresolved",
    r4b.decision_strength_ceiling === "likely_fit"
      && (r4b.homes || []).every((h) => h.decision_strength !== "offerable"),
    JSON.stringify(r4b.decision_strength_ceiling));
  ok("MISSING DATES AND MISSING PRICING TERM ARE NOT THE SAME FACT",
    r4.needs_for_offer === "requested_dates" && r4b.needs_for_offer === "pricing_term",
    JSON.stringify([r4.needs_for_offer, r4b.needs_for_offer]));

  // ══ MB-5 — ORDERING IS A NAMED RULE ══════════════════════════════
  console.log("\nMB-5 [DB] the ordering rule");
  ok("MB-5: the rule is named in the payload and mentions no weight or score",
    /all_recorded_constraints_satisfied/.test(r1.ordering_rule)
      && /fewest_not_established/.test(r1.ordering_rule)
      && !/weight|score/i.test(r1.ordering_rule), JSON.stringify(r1.ordering_rule));
  const twice = await inv.matchProspectHomes({ property_id: skyline, person_id: person, ...TERM }, pool);
  ok("MB-5: the same inputs produce the same order (deterministic, not arrival-dependent)",
    JSON.stringify(twice.homes.map((h) => h.unit_number + "|" + h.space_label))
      === JSON.stringify(r1.homes.map((h) => h.unit_number + "|" + h.space_label)),
    JSON.stringify(twice.homes.map((h) => h.unit_number)));

  // ══ MB-2 / MB-8 — THROUGH THE REAL STAFF DOOR ════════════════════
  console.log("\nMB-8 [HTTP] the staff door");
  const q = `?person_id=${person}&requested_start=${TERM.requested_start}`
          + `&requested_end=${TERM.requested_end}&lease_term_months=${TERM.lease_term_months}`;
  const http = await call("GET", `/operator/leasing/prospect-match${q}`, H);
  ok("MB-8: a staff-session door answers the match question (200)", http.status === 200,
    `${http.status} ${JSON.stringify(http.body).slice(0, 200)}`);
  ok("MB-2: the HTTP payload carries a per-home basis",
    Array.isArray(http.body.homes) && http.body.homes.length >= 1
      && Array.isArray(http.body.homes[0].basis) && http.body.homes[0].basis.length >= 3,
    JSON.stringify(http.body).slice(0, 260));
  ok("MB-8: property scope is SESSION-derived — a query-string property is ignored",
    (await call("GET", `/operator/leasing/prospect-match${q}&property_id=${unpriced}`, H))
      .body.property_id === http.body.property_id, "a client-supplied property_id changed the answer");
  const noAuth = await call("GET", `/operator/leasing/prospect-match${q}`, null);
  ok("MB-8: the door refuses an unauthenticated caller", noAuth.status === 401 || noAuth.status === 403,
    String(noAuth.status));
  //  The same ruling through the real door: this is the MATCHING door, not
  //  an offer door — no contractual authority is exercised here.
  const noTermHttp = (await call("GET", `/operator/leasing/prospect-match?person_id=${person}`, H)).body;
  ok("SHOWING (HTTP): the door answers without a term instead of refusing",
    noTermHttp.matched === true && Array.isArray(noTermHttp.homes) && noTermHttp.homes.length > 0,
    JSON.stringify(noTermHttp.qualification));
  ok("OFFER RESTRICTION HELD (HTTP): the door caps at likely_fit and names the missing fact",
    noTermHttp.decision_strength_ceiling === "likely_fit"
      && noTermHttp.needs_for_offer === "requested_dates",
    JSON.stringify([noTermHttp.decision_strength_ceiling, noTermHttp.needs_for_offer]));

  // ══ MB-8 / §40.8 — THE PERSON WALL ═══════════════════════════════
  //  The door takes person_id from the query string and reads that person's
  //  recorded facts. person_attributes rows may carry a NULL property_id —
  //  prospect_capture.js writes `propertyId || null` — so without a wall a
  //  leasing user at property A can read the recorded budget, move month and
  //  unit type of a prospect known only to property B, and can confirm which
  //  fact keys any person id carries. The sibling door
  //  /operator/leasing/person-card has refused that since 2026-07-25; this
  //  one must refuse on the SAME predicate, through one shared helper.
  console.log("\nMB-8 [HTTP] the person wall");
  const otherOrg = (await pool.query("insert into organizations(name,slug) values($1,$2) returning id",
    [`${tag} other`, `${tag.toLowerCase()}-other`])).rows[0].id;
  const propertyB = (await pool.query(`insert into properties(name,display_name,address,organization_id,
      leasing_basis,operating_timezone) values($1,'Other property (fixture)','9 Fixture Way',$2,'unit','America/New_York')
      returning id`, [`${tag} propertyB`, otherOrg])).rows[0].id;
  const strangerB = (await pool.query(
    "insert into persons(name,source,lifecycle_status) values($1,'rehearsal','prospect') returning id",
    [`Synthetic Stranger At B ${tag}`])).rows[0].id;
  //  Known ONLY at property B — a lead there, and a property-scoped fact.
  await pool.query("insert into leasing_leads(property_id,person_id) values($1,$2)", [propertyB, strangerB]);
  await recordPersonFact(pool, { personId: strangerB, propertyId: propertyB, attrKey: "budget",
    attrValue: "4321", source: "human", sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  //  And a PERSON-LEVEL fact with no property at all, the shape
  //  prospect_capture.js writes. This is the one a property wall on
  //  person_attributes alone would not catch.
  await recordPersonFact(pool, { personId: strangerB, propertyId: null, attrKey: "unit_type",
    attrValue: "SECRET-2BR", source: "ai_conversation", sourceRecordType: "unknown",
    actorType: "unattributed", verb: "captured" });

  const wallQ = `?person_id=${strangerB}&requested_start=${TERM.requested_start}`
              + `&requested_end=${TERM.requested_end}&lease_term_months=${TERM.lease_term_months}`;
  const crossed = await call("GET", `/operator/leasing/prospect-match${wallQ}`, H);
  const crossedText = JSON.stringify(crossed.body);
  ok("§40.8: a leasing session at THIS property is refused a prospect known only to another",
    crossed.status === 404 || crossed.status === 403, `${crossed.status} ${crossedText.slice(0, 180)}`);
  ok("§40.8: and the refusal leaks NO fact key",
    !/budget|move_month|unit_type/.test(crossedText), crossedText.slice(0, 220));
  ok("§40.8: no fact VALUE — not the property-scoped one, not the person-level one",
    !crossedText.includes("4321") && !crossedText.includes("SECRET-2BR"), crossedText.slice(0, 220));
  ok("§40.8: and no home",
    !/"homes"\s*:\s*\[\s*\{/.test(crossedText), crossedText.slice(0, 220));
  //  A success body also contains the word "record"; requiring the refusal
  //  status here stops this assertion passing on the very answer it exists
  //  to forbid.
  ok("§5: the refusal is sayable and names a next step",
    (crossed.status === 404 || crossed.status === 403)
      && typeof (crossed.body.error || crossed.body.note) === "string"
      && /(lead|tour|conversation|enquir)/i.test(String(crossed.body.error || "") + " " + String(crossed.body.note || "")),
    crossedText.slice(0, 260));
  //  CONTROL — the wall must not become a blanket refusal. The same session,
  //  for a prospect with a lead at THIS property, still gets the full basis.
  await pool.query("insert into leasing_leads(property_id,person_id) values($1,$2)", [priced, person]);
  const allowed = await call("GET", `/operator/leasing/prospect-match${q}`, H);
  ok("CONTROL: a prospect with a lead at THIS property still gets the full basis",
    allowed.status === 200 && Array.isArray(allowed.body.homes) && allowed.body.homes.length >= 1
      && allowed.body.homes[0].basis.length >= 3,
    `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 200)}`);
  ok("CONTROL: and that answer still carries the recorded budget it compared",
    JSON.stringify(allowed.body).includes('"900"'), JSON.stringify(allowed.body).slice(0, 200));
  //  The shared helper is ONE predicate, not a second copy.
  const helperPath = require("node:path").join(__dirname, "..", "..", "src", "identity", "person_property_presence.js");
  const presenceOwner = require("node:fs").existsSync(helperPath)
    ? require("node:fs").readFileSync(helperPath, "utf8") : "";
  const operatorSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "identity", "operator.js"), "utf8");
  ok("§7: both doors reach the wall through the one shared helper, not two copies",
    /hasPresenceAtProperty/.test(presenceOwner)
      && (operatorSrc.match(/hasPresenceAtProperty\(/g) || []).length >= 2
      && (operatorSrc.match(/from leasing_conversions where person_id/g) || []).length === 0,
    "operator.js still carries an inline copy of the presence query");

  // ══ MB-8 — ASK SPINE: REGISTERED AND GATHERED ════════════════════
  console.log("\nMB-8 [ASK] registration and gathering");
  const gateSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "gates", "gate_ask_spine_readers.js"), "utf8");
  ok("MB-8: the Ask Spine registry declares the prospect-match domain",
    /prospect_match\s*:\s*\{/.test(gateSrc), "no prospect_match entry in the registry");

  //  ── THE COMPOSER PATH, CALLED — NOT GREPPED ─────────────────────
  //  The first version of this asserted gathering with a source regex and
  //  then called the projection directly with a term. A regex proves the
  //  line exists; it cannot prove any question reaches it. Call gatherFacts
  //  the way the composer does, with a subject its own producer yields.
  const askSpine = require("../../src/agent/ask_spine_answer");
  const MATCH_QUESTION = "which homes fit this prospect";
  const producedSubject = askSpine.questionSubject(MATCH_QUESTION);
  //  The branch must key on the subject the PRODUCER yields for this
  //  question, not on a word chosen when the branch was written.
  const answerSrcEarly = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "agent", "ask_spine_answer.js"), "utf8");
  ok("MB-8: the gather branch keys on the subject questionSubject actually produces",
    typeof producedSubject === "string" && producedSubject.length > 0
      && new RegExp(`subject === "${producedSubject}"`).test(answerSrcEarly),
    `questionSubject(${JSON.stringify(MATCH_QUESTION)}) = ${producedSubject}, `
      + "but no gather branch keys on it");
  note(`questionSubject(${JSON.stringify(MATCH_QUESTION)}) -> ${producedSubject}`);
  const gathered = await askSpine.gatherFacts(pool, {
    property_id: priced, allowed_modules: ["leasing", "management"],
    subject: producedSubject, question: MATCH_QUESTION });
  ok("MB-8: the composer GATHERS prospect_match for a real matching question",
    Object.prototype.hasOwnProperty.call(gathered, "prospect_match"),
    "facts keys: " + Object.keys(gathered).join(", "));
  const gm = gathered.prospect_match || {};
  ok("§40.7: the term-less gather is a successful read, not a failed one",
    gm.read_state === "OK", JSON.stringify(gm).slice(0, 200));
  ok("ASK: the term-less gather now carries NAMED options, not just counts",
    Array.isArray(gm.options) && gm.options.length > 0
      && typeof gm.options[0].home === "string" && gm.options[0].home.length > 0,
    JSON.stringify(gm.options || []).slice(0, 220));
  ok("§40.8: the options carry LABELS and no record ids",
    (gm.options || []).every((o) => !("space_id" in o) && !("unit_id" in o)),
    JSON.stringify(gm.options || []).slice(0, 200));
  ok("ASK: each option says what it satisfies and what is still unconfirmed",
    (gm.options || []).every((o) => Array.isArray(o.satisfies) && Array.isArray(o.unconfirmed)),
    JSON.stringify(gm.options || []).slice(0, 200));
  ok("OFFER RESTRICTION HELD (ASK): the ceiling is likely_fit and the missing fact is named",
    gm.decision_strength_ceiling === "likely_fit" && gm.needs_from_caller === "requested_dates",
    JSON.stringify([gm.decision_strength_ceiling, gm.needs_from_caller]));
  ok("§40.7: a missing CALLER INPUT never manufactures attention on the property",
    gm.attention_state === null || gm.attention_state === "QUIET",
    `attention_state=${JSON.stringify(gm.attention_state)}`);
  //  SCOPED TO THIS DOMAIN. An earlier version also asserted the composite
  //  state is not BLIND — but BLIND is decided by EVERY other domain's
  //  reader, so any unrelated reader failing would have turned this step red
  //  for a reason that has nothing to do with prospect_match. The claim here
  //  is only that prospect_match contributes neither pending nor blindness.
  const cs = gathered.composite_silence || {};
  ok("§40.7: prospect_match is not named pending in composite_silence",
    !(cs.domains || []).includes("prospect_match"), JSON.stringify(cs).slice(0, 220));
  ok("§40.7: and prospect_match is not among any unread domains",
    !(cs.unread || []).some((u) => u && u.domain === "prospect_match"),
    JSON.stringify(cs).slice(0, 220));
  note(`composite_silence -> ${JSON.stringify(gathered.composite_silence).slice(0, 120)}`);
  //  And the dead subject is gone: a branch no producer can reach is a
  //  registration that cannot be exercised.
  const answerSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "agent", "ask_spine_answer.js"), "utf8");
  //  Strip comments first: the history of the dead branch is worth keeping
  //  in prose, and a mention is not a branch (CLAUDE.md).
  const answerCode = answerSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok("MB-8: no gather branch is keyed to a subject questionSubject cannot yield",
    !/subject === "match"/.test(answerCode) && !/subject === "leasing"(?!_)/.test(answerCode),
    'ask_spine_answer still branches on a subject nothing produces');
  const proj1 = await inv.readProspectMatchStanding(pool, { property_id: skyline, person_id: person, ...TERM });
  ok("MB-8: the projection reports the violated-on-price count for an entitled reader",
    proj1.read_state === "OK" && proj1.violated_on_price >= 1,
    JSON.stringify({ violated: proj1.violated_on_price, satisfying: proj1.satisfy_every_recorded_constraint }));
  ok("MB-1: the projection declares retrieval and disclaims comparison",
    proj1.capability_class === "retrieval" && proj1.claims_not_made.includes("comparison"),
    JSON.stringify(proj1.capability_class));
  const projNoTerm = await inv.readProspectMatchStanding(pool, { property_id: skyline, person_id: person });
  ok("ASK: with no term the projection names options rather than only counting them",
    Array.isArray(projNoTerm.options) && projNoTerm.options.length > 0,
    JSON.stringify((projNoTerm.options || []).map((o) => o.home)));
  ok("OFFER RESTRICTION HELD (ASK projection): nothing reads offerable without a term",
    projNoTerm.offerable === 0 && projNoTerm.decision_strength_ceiling === "likely_fit",
    JSON.stringify([projNoTerm.offerable, projNoTerm.decision_strength_ceiling]));
  ok("§5: likely_fit is not claimed for a home where nothing is known",
    (projNoTerm.options || []).every((o) =>
      o.decision_strength !== "likely_fit" || (o.satisfies || []).length > 0),
    JSON.stringify(projNoTerm.options || []).slice(0, 220));

  // ══ MB-9 — NO SCHEMA ═════════════════════════════════════════════
  console.log("\nMB-9 [DB] no schema was added");
  const ledger = (await pool.query("select max(version::int) v, count(*)::int n from schema_migrations")).rows[0];
  ok("MB-9: the ledger is unchanged by this slice — computed at read time",
    Number(ledger.v) === 198 && Number(ledger.n) === 186, JSON.stringify(ledger));
  const newTables = (await pool.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name like '%match%'`)).rows[0].n;
  ok("MB-9: and no matching table was created", newTables === 0, `tables like %match%: ${newTables}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log("FAILED: " + failures.join(" | "));
  await pool.end();
  process.exit(receipt.complete({ harness: HARNESS, passed: pass, failed: fail, expectedAtLeast: EXPECTED }));
})().catch(e => { console.error("HARNESS ERROR", e); process.exit(2); });
