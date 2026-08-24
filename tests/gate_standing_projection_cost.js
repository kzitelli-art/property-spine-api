#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   WHAT DOES A STANDING PROJECTION ACTUALLY COST? — MEASURED

       B2_DATABASE_URL=postgres://…/disposable \
         node tests/gate_standing_projection_cost.js

   PHILOSOPHY §40.6 requires a domain to answer its standing projection
   "cheaply — without walking its full payment, amendment or event
   history", and says why: so that many entitled domains can be gathered
   on EVERY question, "which is what lets Ask Spine answer cross-domain
   questions WITHOUT a classifier or an intent router."

   ── WHY THIS IS MEASURED AND NOT INFERRED ───────────────────────────
   Its sibling `gate_standing_projection_contract.js` tried to judge cost
   by pattern-matching source. It was FALSELY GREEN TWICE:

     attempt 1  scanned only the *_position_read.js files → reported debt
                and equity CHEAP. `loadHistory()` runs at the gather site.
     attempt 2  added the gather site, caught those two → still reported
                compliance, tax and tenancy CHEAP. Their walks are plain
                unbounded `select *` statements. No pattern to match.

   Two false greens in one gate is the answer: cost is not a property of
   the text. So this counts the queries a read ACTUALLY ISSUES, against a
   real Postgres built from the real migration chain.

   ── WHAT IS COUNTED ─────────────────────────────────────────────────
   Every statement the read issues, and whether each is BOUNDED. A
   statement is bounded when it carries a LIMIT, is an aggregate, or is a
   primary-key/unique lookup. An unbounded select over a table whose row
   count grows with the property's history is a walk — that is the thing
   §40.6 forbids, and it is forbidden because it does not scale with the
   number of domains gathered, not because it is slow once.

   The database is EMPTY of operating rows on purpose. An empty property
   is the cheapest possible case, so every number here is a FLOOR: the
   real cost on a property with history is higher, never lower.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — proof infrastructure. REMOVAL CONDITION: none. This is how
   "cheap enough to gather routinely" stays a checkable claim rather than
   an intention.

   Local disposable database only. Refuses anything else.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");
/*  Takes the harness database when run from tests/e2e/verify_all.sh,
    and a hand-made disposable one otherwise. Still refuses anything
    that is not localhost — a gate that can reach production is a
    gate that will, eventually, on someone's laptop. */
const URL = process.env.B2_DATABASE_URL || process.env.E2E_DATABASE_URL
  || "postgres://postgres@127.0.0.1:55434/b2";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("\n  ✗ REFUSED: this gate runs only against a local disposable database.\n");
  process.exit(2);
}

const contractShape = require(path.join(ROOT, "src/shared/standing_projection.js"));
const adapter = require(path.join(ROOT, "src/shared/domain_standing_projections.js"));

const PROPERTY = "b2000000-0000-4000-8000-000000000001";

/*  A recording wrapper around a REAL client. It does not fake results —
    every statement reaches Postgres and returns Postgres's answer. It
    only records what was asked. A fake pool would be measuring the fake
    (CLAUDE.md), which is the failure this file exists to avoid. */
function recorder(client) {
  const log = [];
  const wrapped = {
    async query(text, params) {
      const sql = typeof text === "string" ? text : (text && text.text) || "";
      log.push(sql.replace(/\s+/g, " ").trim());
      return client.query(text, params);
    },
    async connect() { return wrapped; },
    release() {},
    async end() {},
  };
  return { wrapped, log };
}

/*  ── STRUCTURE vs HISTORY, AND WHY THE FIRST THREE ATTEMPTS FAILED ───
 *  §40.6 forbids a standing projection that walks "its full payment,
 *  amendment or event history". It does NOT forbid reading the property's
 *  current shape. Those are different growth curves and only one is the
 *  defect:
 *
 *      STRUCTURAL    grows with what the property IS — units, coverages,
 *                    instruments, providers, legal entities. Bounded by
 *                    the deal's size, which is small and does not grow
 *                    just because time passed.
 *      HISTORY_WALK  grows with what has HAPPENED — facts, payments,
 *                    amendments, superseded rows, events. Unbounded in
 *                    the only sense that matters: it grows forever.
 *
 *  Three mechanical classifiers were tried and each was partly right,
 *  which is the finding:
 *
 *    1  "no LIMIT"        — flags every structural read. Would have had
 *                           me add LIMIT to "coverages on this property",
 *                           silently truncating truth (§5) to pass a gate.
 *    2  walk-signal regex — missed plain `select *` walks entirely.
 *    3  append-only table — closer, but `capital_stack_positions` carries
 *                           no append-only trigger and still accumulates
 *                           superseded rows, while `compliance_items`
 *                           carries one and is structural.
 *
 *  So the classification is DECLARED per statement, with a reason, and
 *  the gate's job is to keep the declaration honest rather than to guess.
 *  This is §40.5's shape — "declared as data, as part of its read
 *  contract" — applied to cost instead of to truth walls.
 *
 *  ── THE RATCHET ─────────────────────────────────────────────────────
 *  HISTORY_WALK_CEILING is the number of history walks tolerated today.
 *  The gate fails if the count RISES. It does not pretend the remaining
 *  walks are acceptable; it makes them un-regressable while they are
 *  fixed one at a time, and every one is named below with what it needs.  */
/*  The REAL number, which is OBSERVED + HIDDEN.
 *
 *  Eight walks are issued against the empty measurement property. A ninth
 *  — compliance_facts — is real and simply never fires here, because
 *  compliance_read short-circuits when the property has no items. An
 *  earlier receipt reported "eight" and that number invited being read as
 *  the ceiling. It is not. The ceiling counts every walk this gate can
 *  name, whether or not the fixture happens to provoke it.
 *
 *  A declaration carrying `hidden_by_fixture` is counted without being
 *  observed — and if the fixture ever DOES provoke it, the gate fails
 *  until the flag is removed, so the two never both count it.          */
const HISTORY_WALK_CEILING = 8;

/*  Every statement each read issues, classified. `match` is a distinctive
    fragment of the statement. An issued statement matching NOTHING here
    is a gate failure — that is how a new unbounded read cannot arrive
    unnoticed. */
const DECLARED = [
  { match: "from insurance_property_allocations", kind: "STRUCTURAL",
    why: "allocations LIVE IN THE PERIOD — effective_from/effective_to filtered and " +
         "supersession filtered. Grows with coverages, not with time." },
  { match: "from legal_entity_properties", kind: "STRUCTURAL",
    why: "effective-dated entity relationships current at as_of" },
  { match: "from tax_obligation_applicability", kind: "STRUCTURAL",
    why: "effective-dated applicability current at as_of" },
  { match: "from tax_obligations", kind: "HISTORY_WALK",
    why: "NO date filter — every obligation ever recorded for the property. " +
         "NEEDS: a bounded read for standing (open obligations only); the full " +
         "set belongs to the detail projection." },
  { match: "from tax_clearances", kind: "STRUCTURAL", why: "order by … limit 1" },
  { match: "from utility_providers", kind: "STRUCTURAL",
    why: "providers referenced by THIS property, via exists(). Grows with providers." },
  { match: "from contracted_service_providers", kind: "STRUCTURAL",
    why: "providers referenced by THIS property, via exists()" },
  /*  RECLASSIFIED — this was declared a HISTORY_WALK and is not one.
      The statement does NOT read the property's obligations. It reads only
      obligations reachable through contracted_service_decision_links
      (`and exists (select 1 from contracted_service_decision_links l
      where l.obligation_id = o.id and l.property_id = $1)`), so its row
      count is the LINK count, never the obligation count.

      And the link count is the TERM count: migration 171 makes links
      append-only, FK'd to (term_id, property_id, engagement_id), and one
      is written per governing decision — so links arrive with amendments
      and with nothing else. That growth is already counted, once, under
      contracted_service_terms. Counting it here counts the same curve
      twice.

      Bounding it by status would have been the "obvious" fix and would
      have been WRONG OUTPUT: decisionOwner() looks the obligation up BY
      ID from the newest link, so a link pointing at a CLOSED obligation
      would lose its owner and report UNASSIGNED — a confident-wrong owner
      on a screen (§5), bought to make this gate green.                  */
  { match: "from obligations o", kind: "DERIVED_BOUND",
    bounded_by: "from contracted_service_terms",
    why: "scoped by EXISTS on contracted_service_decision_links, which are " +
         "written one per governing decision and therefore grow with terms, " +
         "not with operating events. The curve is counted under terms." },
  { match: "from compliance_items", kind: "STRUCTURAL",
    why: "the licences and requirements this property holds. Append-only, so " +
         "retired items accumulate — but slowly, with structure, not per event." },
  { match: "from compliance_facts", kind: "HISTORY_WALK",
    hidden_by_fixture:
      "compliance_read short-circuits when the property has no compliance items, " +
      "so this statement is never ISSUED against the empty measurement property. " +
      "It is counted anyway. The canonical property holds one compliance record " +
      "today; the walk arrives with the second.",
    why: "EVERY fact ever recorded for every item, plus every evidence row, plus " +
         "an awaited mintReference PER EVIDENCE ROW. The clearest walk of the set. " +
         "NEEDS: distinct-on(item_id) latest non-superseded fact for standing; the " +
         "full chain is detail." },
  { match: "from spaces s", kind: "HISTORY_WALK",
    why: "structural at the top (spaces × units) but carries correlated json_agg " +
         "subqueries pulling EVERY lease and EVERY move-in/move-out event per space. " +
         "LIVES IN src/tenancy/space_position.js:323 (loadSpaceRows), reached via " +
         "src/tenancy/dated_positions.js. NOT src/shared/ — an earlier receipt said " +
         "so and was wrong. src/tenancy/ is in no declared lane; it waits." },
  { match: "from capital_stack_positions", kind: "STRUCTURAL",
    why: "positions in the capital stack. Effective-dated and superseded rows do " +
         "accumulate, but with financings, not with operating events." },
  { match: "from debt_instruments", kind: "STRUCTURAL",
    why: "instruments attached to this property, effective-dated" },
  { match: "from properties", kind: "STRUCTURAL", why: "the property row itself" },
  { match: "from users", kind: "STRUCTURAL", why: "an identity lookup" },
  //  ── utility's 14-table loop, and contracted_service's 10 ───────────
  //  Both issue `select * from <table> where property_id = $1` for every
  //  table in a fixed TABLES map. Most are structural — the property's
  //  meters, service points, accounts. Two families are not: provider
  //  STATEMENTS and their usage rows arrive every billing cycle forever,
  //  and financial observations and term amendments accumulate the same
  //  way. The loop makes no distinction, which is why declaring each one
  //  matters more here than anywhere else in this file.
  { match: "from utility_statements", kind: "HISTORY_WALK",
    why: "every provider statement this property has ever received, unbounded. " +
         "NEEDS: latest statement per account for standing; the series is detail." },
  { match: "from utility_statement_usage", kind: "HISTORY_WALK",
    why: "every usage row of every statement. Grows fastest of anything here. " +
         "NEEDS: it does not belong in a standing projection at all." },
  { match: "from contracted_service_financial_observations", kind: "HISTORY_WALK",
    why: "observed amounts accumulate per invoice/period. NEEDS: latest per " +
         "engagement for standing." },
  { match: "from contracted_service_terms", kind: "HISTORY_WALK",
    why: "term amendments accumulate — §40.6 names amendment history explicitly. " +
         "NEEDS: current term per engagement for standing." },
  { match: "from utility_services", kind: "STRUCTURAL", why: "service classes at this property" },
  { match: "from utility_service_declarations", kind: "STRUCTURAL", why: "declared applicability" },
  { match: "from utility_service_providers", kind: "STRUCTURAL", why: "provider relationships" },
  { match: "from utility_arrangements", kind: "STRUCTURAL", why: "who pays which service" },
  { match: "from utility_provider_accounts", kind: "STRUCTURAL", why: "accounts held" },
  { match: "from utility_account_services", kind: "STRUCTURAL", why: "account↔service links" },
  { match: "from utility_service_points", kind: "STRUCTURAL", why: "physical service points" },
  { match: "from utility_meters", kind: "STRUCTURAL", why: "meters installed" },
  { match: "from utility_meter_service_points", kind: "STRUCTURAL", why: "meter↔point links" },
  { match: "from utility_account_service_points", kind: "STRUCTURAL", why: "account↔point links" },
  { match: "from utility_account_meters", kind: "STRUCTURAL", why: "account↔meter links" },
  { match: "from contracted_service_coverage_reviews", kind: "STRUCTURAL", why: "one current review" },
  { match: "from contracted_service_requirements", kind: "STRUCTURAL", why: "requirements declared" },
  { match: "from contracted_service_engagements", kind: "STRUCTURAL", why: "engagements held" },
  { match: "from contracted_service_documents", kind: "STRUCTURAL", why: "documents attached" },
  { match: "from contracted_service_scopes", kind: "STRUCTURAL", why: "scope of each engagement" },
  { match: "from contracted_service_locations", kind: "STRUCTURAL", why: "where each applies" },
  { match: "from contracted_service_price_components", kind: "STRUCTURAL", why: "price structure" },
  { match: "from contracted_service_decision_links", kind: "STRUCTURAL", why: "decision links" },
  { match: "from opening_tenancy_positions", kind: "STRUCTURAL",
    why: "one CURRENT opening position per property — migration 157 enforces it" },
  { match: "from units where property_id", kind: "STRUCTURAL", why: "units marked down" },
  { match: "from inventory_retirements", kind: "STRUCTURAL", why: "an aggregate count" },
  { match: "from import_batches", kind: "HISTORY_WALK",
    why: "every rent-roll import ever run against this property, no bound. " +
         "LIVES IN src/tenancy/dated_positions.js:633. NOT src/shared/ — an earlier " +
         "receipt said so and was wrong. src/tenancy/ is in no declared lane; it " +
         "waits. NEEDS: the latest establishing batch for standing; the series is " +
         "detail." },
  { match: "from capital_stack_conflicts", kind: "STRUCTURAL",
    why: "recorded conflicts on the cap table — resolved ones stay, but they " +
         "arrive with financings, not with operating events" },
  { match: "from common_equity_class_terms", kind: "STRUCTURAL",
    why: "the equity classes this deal defines, effective-dated. Grows with " +
         "financings, not with operating events." },
];

function classify(sql) {
  const s = sql.toLowerCase().replace(/\s+/g, " ");
  const hit = DECLARED.find((d) => s.includes(d.match.toLowerCase()));
  return hit || null;
}

/*  ── THE SEVEN, and how each is actually invoked ─────────────────────
    Each entry calls the read the way Ask Spine (or the surface) calls
    it, so the number measured is the number really paid.               */
const DOMAINS = [
  { domain: "insurance",
    run: async (db) => require(path.join(ROOT, "src/asset/insurance_position_read.js"))
      .readPosition(db, { property_id: PROPERTY, period: "2026-08" }) },
  { domain: "tax",
    run: async (db) => {
      const rules = require(path.join(ROOT, "src/asset/philadelphia_tax_rules.js"));
      return require(path.join(ROOT, "src/asset/tax_position_read.js"))
        .readTaxPosition(db, { property_id: PROPERTY, as_of: "2026-08-22", rules });
    } },
  { domain: "utility",
    run: async (db) => require(path.join(ROOT, "src/asset/utility_position_read.js"))
      .readStanding(db, { property_id: PROPERTY }) },
  { domain: "contracted_service",
    run: async (db) => require(path.join(ROOT, "src/asset/contracted_service_position_read.js"))
      .readStanding(db, { property_id: PROPERTY }) },
  { domain: "compliance",
    run: async (db) => require(path.join(ROOT, "src/asset/compliance_read.js"))
      .readComplianceStanding(db, { property_id: PROPERTY, as_of: "2026-08-22",
        mintReference: async () => ({ ref: "r" }) }) },
  { domain: "tenancy",
    run: async (db) => require(path.join(ROOT, "src/tenancy/tenancy_position_read.js"))
      .readTenancyStanding(db, { property_id: PROPERTY }) },
  { domain: "equity",
    run: async (db) => {
      const svc = require(path.join(ROOT, "src/asset/equity_position_service.js"));
      const read = require(path.join(ROOT, "src/asset/equity_position_read.js"));
      const history = await svc.loadHistory(db, PROPERTY);
      const reading = read.position(history, "2026-08-22");
      return { rich: read.standingProjection(reading), reading };
    },
    extra: (out) => (out && out.reading) || null },
  { domain: "debt",
    run: async (db) => {
      const svc = require(path.join(ROOT, "src/asset/debt_instrument_service.js"));
      const read = require(path.join(ROOT, "src/asset/debt_position_read.js"));
      const ids = await svc.listInstrumentsForProperty(db, PROPERTY);
      if (!ids.length) return null;
      const h = await svc.loadHistory(db, ids[0]);
      return read.standingProjection(read.position(h, "2026-08-22"));
    } },
];

(async () => {
  const client = new Client({ connectionString: URL });
  await client.connect();
  await client.query("delete from properties where id = $1", [PROPERTY]).catch(() => {});
  await client.query("insert into properties (id, name) values ($1, $2)",
    [PROPERTY, "B2 Cost Measurement Property"]);

  const L = (s = "") => console.log(s);
  L("\nSTANDING PROJECTION COST — MEASURED AGAINST REAL POSTGRES");
  L("=".repeat(74));
  L("  One EMPTY property. Every number is a FLOOR — a property with real");
  L("  history costs more, never less.");
  L("");
  L("  " + "domain".padEnd(20) + "queries  hist-walk  outcome");
  L("  " + "-".repeat(70));

  const results = [];
  const undeclared = [];
  for (const d of DOMAINS) {
    const { wrapped, log } = recorder(client);
    let outcome = "ok";
    try {
      const out = await d.run(wrapped);
      const subject = (out && out.rich !== undefined) ? out.rich : out;
      const projected = adapter.project(d.domain, subject, d.extra ? d.extra(out) : undefined);
      const probs = contractShape.validate(projected);
      if (probs.length) outcome = "INVALID SHAPE: " + probs.join("; ").slice(0, 60);
    } catch (e) { outcome = "threw: " + String(e.message).slice(0, 40); }

    const walks = [];
    for (const q of log) {
      const c = classify(q);
      if (!c) { undeclared.push({ domain: d.domain, sql: q.slice(0, 120) }); continue; }
      if (c.kind === "HISTORY_WALK") walks.push(c);
    }
    results.push({ domain: d.domain, queries: log.length, walks, outcome });
    L("  " + d.domain.padEnd(20) +
      String(log.length).padStart(5) + String(walks.length).padStart(10) + "  " + outcome);
  }

  L("");
  L("HISTORY WALKS — the reads §40.6 actually forbids, and what each needs");
  L("-".repeat(74));
  const seen = new Set();
  for (const r of results) {
    for (const w of r.walks) {
      if (seen.has(w.match)) continue;
      seen.add(w.match);
      L(`  ${r.domain} · ${w.match}`);
      L(`    ${w.why.replace(/(.{66})\s/g, "$1\n    ")}`);
      L("");
    }
  }

  /*  The hidden ones: declared walks the fixture never provokes. Named
      here so the printed number is the real number, not the observable
      one. */
  /*  DERIVED_BOUND — a statement whose growth is entirely inherited from
      another declared walk. It is NOT counted (that would be the same
      curve twice) and it is NOT free: `bounded_by` must name a declaration
      that is itself a HISTORY_WALK. If that walk is ever fixed or
      reclassified, this one loses its bound and the gate goes red until
      someone re-examines it. That is what stops DERIVED_BOUND from being
      the quiet place to put an inconvenient walk. */
  const derived = DECLARED.filter((d) => d.kind === "DERIVED_BOUND");
  const badlyBound = derived.filter((d) => {
    const target = DECLARED.find((x) => x.match === d.bounded_by);
    return !target || target.kind !== "HISTORY_WALK";
  });
  if (derived.length) {
    L("DERIVED — growth inherited from another declared walk, counted there");
    L("-".repeat(74));
    for (const d of derived) {
      L(`  ${d.match}   →   bounded by   ${d.bounded_by}`);
      L(`    ${d.why.replace(/(.{66})\s/g, "$1\n    ")}`);
      L("");
    }
  }

  const hidden = DECLARED.filter((d) => d.kind === "HISTORY_WALK" && d.hidden_by_fixture);
  const hiddenUnseen = hidden.filter((d) => !seen.has(d.match));
  const hiddenButSeen = hidden.filter((d) => seen.has(d.match));
  if (hidden.length) {
    L("HIDDEN BY THE FIXTURE — real walks this measurement cannot provoke");
    L("-".repeat(74));
    for (const d of hidden) {
      L(`  ${d.match}${seen.has(d.match) ? "   ⚠ ISSUED — no longer hidden" : ""}`);
      L(`    ${d.hidden_by_fixture.replace(/(.{66})\s/g, "$1\n    ")}`);
      L(`    ${d.why.replace(/(.{66})\s/g, "$1\n    ")}`);
      L("");
    }
  }

  const walkCount = seen.size + hiddenUnseen.length;
  const total = results.reduce((a, r) => a + r.queries, 0);
  L("=".repeat(74));
  L(`  ${results.length} domains · ${total} queries to gather all of them ONCE, on an EMPTY property`);
  L(`  ${walkCount} distinct history walk(s) — ${seen.size} observed + ${hiddenUnseen.length} hidden by the fixture ` +
    `· ceiling ${HISTORY_WALK_CEILING}`);
  L("");

  let failed = 0;
  if (badlyBound.length) {
    failed++;
    L(`  ✘ ${badlyBound.length} DERIVED_BOUND declaration(s) do not name a live HISTORY_WALK.`);
    L("      A derived statement is uncounted because its growth is counted");
    L("      elsewhere. If that elsewhere is gone, it is counted NOWHERE.");
    for (const d of badlyBound) L(`      ${d.match} → bounded_by "${d.bounded_by}"`);
  }
  if (hiddenButSeen.length) {
    failed++;
    L(`  ✘ ${hiddenButSeen.length} declaration(s) claim to be hidden by the fixture but were ISSUED.`);
    L("      A hidden walk is counted without being observed. Once it is observed");
    L("      it would be counted twice, or the claim is simply stale. Remove");
    L("      `hidden_by_fixture` from: " + hiddenButSeen.map((d) => d.match).join(", "));
  }
  if (undeclared.length) {
    failed++;
    L(`  ✘ ${undeclared.length} statement(s) issued that this gate does not classify.`);
    L("      An unclassified read is how a new history walk arrives unnoticed.");
    for (const u of undeclared.slice(0, 5)) L(`      ${u.domain}: ${u.sql}`);
  } else {
    L("  ✔ every statement issued is declared and classified");
  }
  if (walkCount > HISTORY_WALK_CEILING) {
    failed++;
    L(`  ✘ history walks ROSE to ${walkCount}; the ceiling is ${HISTORY_WALK_CEILING}.`);
    L("      The ceiling is a ratchet. It may fall. It may never rise.");
  } else if (walkCount < HISTORY_WALK_CEILING) {
    failed++;
    L(`  ✘ history walks FELL to ${walkCount} — lower the ceiling to ${walkCount}.`);
    L("      A ceiling above the real number stops being a ratchet and starts");
    L("      being headroom, which is how the count creeps back up.");
  } else {
    L(`  ✔ history walks are at the declared ceiling of ${HISTORY_WALK_CEILING}, not above it`);
  }
  L("");
  L(`  This is a RATCHET, not a pass. ${walkCount} reads still walk history and each`);
  L("  is named above with what it needs. §40.6 is not satisfied until this is 0,");
  L("  and Build 4 (delete the regex router) stays blocked until it is.");
  L("");

  await client.query("delete from properties where id = $1", [PROPERTY]).catch(() => {});
  await client.end();

  L("");
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
