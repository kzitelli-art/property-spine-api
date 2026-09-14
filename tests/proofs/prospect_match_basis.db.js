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
const HARNESS = __filename, EXPECTED = 40;
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
  //  The governed inventory is the repository's own established fixture:
  //  Skyline E2E carries ONE eligible target (3B | Bed B) under an
  //  established opening position, priced at 1025 for a 12-month term.
  //  Hand-rolling a second activation chain would prove my fixture, not
  //  the product. A separate synthetic property carries NO published
  //  pricing, for the coverage case.
  const skyline = (await pool.query(
    "select id from properties where name='Skyline E2E' order by created_at desc limit 1")).rows[0].id;
  const org = (await pool.query(
    "select organization_id from properties where id=$1", [skyline])).rows[0].organization_id
    || (await pool.query("insert into organizations(name,slug) values($1,$2) returning id",
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

  const unpriced = (await pool.query(`insert into properties(name,display_name,address,organization_id,
      leasing_basis,operating_timezone) values($1,'Unpriced (fixture)','2 Fixture Way',$2,'unit','America/New_York')
      returning id`, [`${tag} unpriced`, org])).rows[0].id;
  for (const p of [skyline, unpriced]) {
    await pool.query(`insert into property_team_assignments(property_id,user_id,role_title,role_key,
      scope_type,allowed_modules,primary_for_modules,can_manage_roles,active)
      values($1,$2,'property_admin','property_admin','property',array['leasing','management'],'{management}',true,true)
      on conflict do nothing`, [p, staff]);
  }

  //  LEGACY-ONLY HOME (acceptance case 5): units.bedrooms populated and
  //  flagged vacant, with its trigger-provisioned space REMOVED so there is
  //  no Deal Setup position behind it. If matching ever reads the legacy
  //  columns, this row appears.
  const legacyUnit = (await pool.query(`insert into units(property_id,unit_number,bedrooms,bathrooms,occupancy_status)
      values($1,$2,2,1,'vacant') returning id`, [skyline, `LEGACY-${tag}`])).rows[0].id;
  await pool.query("delete from spaces where unit_id=$1", [legacyUnit]);
  const legacySpaces = (await pool.query("select count(*)::int n from spaces where unit_id=$1", [legacyUnit])).rows[0].n;
  ok("PRECONDITION: the legacy-only home has bedrooms and a vacant flag but NO governed position",
    legacySpaces === 0, `spaces=${legacySpaces}`);

  //  The prospect's RECORDED constraint, through the canonical writer.
  //  1200 is above nothing here: the governed price is 1025, so a budget of
  //  900 makes the one eligible home violated, which is the case MB-3 exists
  //  for. pa_typed_source_has_ref: a TYPED receipt must carry its id, and
  //  this fixture has no lead row to point at, so the honest receipt is
  //  'unknown' — the writer's own vocabulary allows it.
  const budgetWrite = await recordPersonFact(pool, {
    personId: person, propertyId: skyline, attrKey: "budget", attrValue: "900",
    source: "human", sourceRecordType: "unknown", actorType: "unattributed", verb: "captured" });
  ok("PRECONDITION: the prospect's budget is recorded through the canonical person-fact writer",
    budgetWrite.written === true, JSON.stringify(budgetWrite.skipped_reason || null));

  const token = (await staffSessions.issueStaffSession(pool,
    { userId: staff, propertyId: skyline, purpose: "bootstrap_invite" })).session_token;
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
      && Number(price1.home_fact.value) === 1025 && !!price1.home_fact.as_of,
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
  ok("MB-7: refused with the EXISTING reason, inherited from the seam",
    r4.matched === false && r4.qualification === "term_required"
      && r4.refusal_inherited_from === "availableUnits(exact_spaces)", JSON.stringify(r4.qualification));
  ok("MB-7: the refusal carries the sentence that keeps 'I need your dates' distinct from 'nothing available'",
    typeof r4.note === "string" && /dates/i.test(r4.note) && /not an answer about inventory|nothing being/i.test(r4.note),
    JSON.stringify(r4.note || "").slice(0, 200));
  ok("MB-7: and it returns no homes at all rather than an empty match set that reads as inventory",
    Array.isArray(r4.homes) && r4.homes.length === 0);
  const r4b = await inv.matchProspectHomes({ property_id: skyline, person_id: person,
    requested_start: "2027-01-05", requested_end: "2027-12-31" }, pool);
  ok("MB-7: a term with no published pricing months is a DIFFERENT refusal, not the same one",
    r4b.matched === false && r4b.qualification === "pricing_term_required",
    JSON.stringify(r4b.qualification));

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
  ok("MB-7 (HTTP): no term is refused through the door too, with the reason",
    (await call("GET", `/operator/leasing/prospect-match?person_id=${person}`, H))
      .body.qualification === "term_required");

  // ══ MB-8 — ASK SPINE: REGISTERED AND GATHERED ════════════════════
  console.log("\nMB-8 [ASK] registration and gathering");
  const gateSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "gates", "gate_ask_spine_readers.js"), "utf8");
  ok("MB-8: the Ask Spine registry declares the prospect-match domain",
    /prospect_match\s*:\s*\{/.test(gateSrc), "no prospect_match entry in the registry");
  const answerSrc = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "src", "agent", "ask_spine_answer.js"), "utf8");
  ok("MB-8: ask_spine_answer gathers the prospect-match standing projection",
    /readProspectMatchStanding/.test(answerSrc) && /facts\.prospect_match\s*=/.test(answerSrc),
    "ask_spine_answer never calls the standing read");
  const proj1 = await inv.readProspectMatchStanding(pool, { property_id: skyline, person_id: person, ...TERM });
  ok("MB-8: the projection reports the violated-on-price count for an entitled reader",
    proj1.read_state === "OK" && proj1.violated_on_price >= 1,
    JSON.stringify({ violated: proj1.violated_on_price, satisfying: proj1.satisfy_every_recorded_constraint }));
  ok("MB-1: the projection declares retrieval and disclaims comparison",
    proj1.capability_class === "retrieval" && proj1.claims_not_made.includes("comparison"),
    JSON.stringify(proj1.capability_class));
  const projNoTerm = await inv.readProspectMatchStanding(pool, { property_id: skyline, person_id: person });
  ok("MB-7 (ASK): with no term the projection is NOT_ESTABLISHED and says why — never 'no homes'",
    projNoTerm.truth_state === "NOT_ESTABLISHED" && projNoTerm.qualification === "term_required"
      && typeof projNoTerm.why === "string", JSON.stringify(projNoTerm.qualification));

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
