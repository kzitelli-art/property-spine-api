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
   ⚠ THIS PARAGRAPH ONCE DESCRIBED A HEURISTIC — "bounded means it
   carries a LIMIT, is an aggregate, or is a key lookup" — AND THAT
   HEURISTIC WAS WRONG. It flagged every structural read and would have
   had me add LIMIT to "the coverages on this property", truncating truth
   (§5) to pass this gate. §40.6 says "without walking its full payment,
   amendment or event history". That is a claim about HISTORY, not about
   syntax.

   So each statement is DECLARED, by hand, as one of:

     STRUCTURAL     bounded by how the property is BUILT. Grows with
                    coverages, instruments, meters, financings — not with
                    time or operating events.
     HISTORY_WALK   grows every month the property is operated. The thing
                    §40.6 forbids, and forbidden because it does not scale
                    with the NUMBER OF DOMAINS gathered, not because it is
                    slow once.
     DERIVED_BOUND  growth entirely inherited from another declared walk,
                    so counting it here would count one curve twice.
                    `bounded_by` must name a live HISTORY_WALK.

   Three mechanical classifiers were tried before giving up on mechanism;
   see THE RATCHET below. The gate's job is to keep the declaration
   honest, not to guess.

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

const fs = require("fs");
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

/*  ── THE FIXTURE UNDER-PROVOKES, SO THE SOURCE IS SCANNED TOO ────────
 *
 *  The measurement runs on an EMPTY property, which makes every number a
 *  floor. That was known. What was NOT known is that emptiness does not
 *  merely shrink the numbers — it makes whole statements never fire, and
 *  a statement that never fires cannot be classified by observation.
 *
 *  compliance_facts was caught by eye. Then tax_liabilities, tax_filings,
 *  tax_payments and tax_appeals turned out to sit behind
 *  `oblIds.length ? … : []` in exactly the same way, and NOTHING would
 *  have caught those — they are the literal "payment history" §40.6
 *  names, and the gate measuring §40.6 could not see them.
 *
 *  So the gate no longer trusts what it observed. It reads the SOURCE of
 *  every file below and requires each `from <table>` in it to be
 *  declared, fired or not. Observation still classifies; the scan is what
 *  makes the declaration complete.
 *
 *  ── THE PATTERN, NOT THREE INCIDENTS ────────────────────────────
 *  A MEASUREMENT THAT ONLY OBSERVES EXECUTION CANNOT SEE CODE THAT DOES
 *  NOT EXECUTE.
 *
 *  Same class, three times in one build:
 *    the runner that stops at first failure   22 gates reported NOT RUN,
 *                                             which read as "fine"
 *    the fixture that never provokes a read   compliance short-circuits
 *                                             on an empty property
 *    this gate, blind to guarded code         everything behind
 *                                             `if (oblIds.length)`
 *
 *  It is the same failure as a green gate never shown able to go red,
 *  applied to the measuring instrument. The remedy is always the same:
 *  add a channel that does not depend on the code running.
 *
 *  ── THE SCOPE, STATED (CLAUDE.md: "a gate must scan the same scope as
 *     the claim it asserts") ─────────────────────────────────────────
 *  These files and no others. The reads reached THROUGH them —
 *  src/tenancy/dated_positions.js and space_position.js — are outside
 *  this thread's lane and are covered by observation only. That is a
 *  known gap, and naming it here is the point.                          */
const SCANNED_SOURCES = [
  "src/asset/insurance_position_read.js",
  "src/asset/tax_position_read.js",
  "src/asset/utility_position_read.js",
  "src/asset/contracted_service_position_read.js",
  "src/asset/compliance_read.js",
  "src/tenancy/tenancy_position_read.js",
  "src/asset/equity_position_service.js",
  "src/asset/debt_instrument_service.js",
];

/*  Comments are stripped before scanning. CLAUDE.md: "A mention is not a
    guard" — a `from foo` inside a comment must not satisfy the scan, and
    a `from foo` inside a comment must not alarm it either. */
function sqlTablesIn(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const found = new Map();

  /*  ONLY TEMPLATE LITERALS. Every SQL statement in this repo lives in
      backticks, and nothing else does. Scanning the whole file instead
      found `"…the source this property was established from did not
      carry."` — English prose in a user-facing string — and reported a
      table called "did not". A scan that reports prose as schema will be
      silenced by the next person, and a silenced scan is worse than none. */
  for (const raw of src.match(/`[^`]*`/g) || []) {
    if (!/\bselect\b/i.test(raw)) continue;
    /*  SQL comments inside the statement are prose too. `--  participation,
        not from allocations: a policy covering three` reported a table
        called "allocations". Same rule as above, one level in. */
    const lit = raw.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

    /*  CTE names are not tables. `with allocations as (…) select … from
        allocations` reads a name this statement just defined; declaring
        it would be declaring a variable. */
    const ctes = new Set();
    const cteRe = /(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi;
    let cm;
    while ((cm = cteRe.exec(lit))) ctes.add(cm[1].toLowerCase());

    const re = /\bfrom\s+([a-z_][a-z0-9_]*)\s*(?:\b([a-z][a-z0-9_]*)\b)?/gi;
    let m;
    while ((m = re.exec(lit))) {
      const table = m[1].toLowerCase();
      if (ctes.has(table)) continue;
      const alias = m[2] && !/^(where|join|left|inner|order|group|limit|on|as|and|or|select|union|having|cross|full|right|for|offset|natural)$/i.test(m[2])
        ? m[2].toLowerCase() : null;
      const key = alias ? `from ${table} ${alias}` : `from ${table}`;
      if (!found.has(key)) found.set(key, file);
    }
  }
  return found;
}

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
 *  ── §40.6 IS STANDING **PLUS** DETAIL, NEVER STANDING **INSTEAD OF**
 *     DETAIL. ────────────────────────────────────────────────────────
 *
 *  The compact projection is a SECOND, CHEAPER read beside the full one.
 *  It does not replace it, and bounding a loader is not permission to
 *  delete the series it was loading.
 *
 *  ⚠ THE FAILURE THIS PREVENTS IS NASTY, AND A TEST SUITE WILL NOT CATCH
 *  IT. paidOverPeriod() computes amounts paid across a period and needs
 *  every observation in it. It is exported, proven in
 *  debt_institutional_acceptance.db.js — and called by NOTHING in src/.
 *  Built-but-dormant.
 *
 *  Bounding the loader those two share would have destroyed a working
 *  capability, and NO PRODUCTION CALLER EXISTED TO GO RED. A cost
 *  optimisation on a shared loader looks free precisely when it is not:
 *  the caller that would have complained is the one that has not been
 *  written yet, or the one whose only witness is a test nobody runs in
 *  the same pass.
 *
 *  So the rule is structural, not a matter of care:
 *
 *      BOUND THE STANDING PATH. KEEP THE SERIES REACHABLE BY NAME.
 *
 *  debt_payment_observations is bounded inside loadHistory(); the series
 *  moved to loadPaymentObservations(), which says in its own name what it
 *  is for. Nothing was deleted — one caller now asks for the expensive
 *  thing explicitly, which is the whole of §40.6's shape.
 *
 *  ── THREE TIMES THE OBVIOUS BOUND WOULD HAVE TRADED TRUTH FOR A
 *     NUMBER. READ THESE BEFORE BOUNDING ANYTHING. ──────────────────
 *
 *  Each of these looked like a fix, would have made this gate greener,
 *  and would have put a wrong answer on an operator's screen. None was
 *  caught by a test failing — all three were caught by reading what the
 *  consumer actually does with the rows.
 *
 *  1  `select * from obligations o` — "restrict to open obligations".
 *     decisionOwner() looks the obligation up BY ID from the newest
 *     decision link. A link pointing at a CLOSED obligation would find
 *     nothing and report UNASSIGNED — a contract with a real accountable
 *     owner rendering as having none. §5, in the direction that looks
 *     like diligence.
 *
 *  2  `select * from debt_balance_observations` — "take the latest row".
 *     There are TWO consumers. W1 does
 *     `balances.find(source === "payoff_statement")` on an ASCENDING
 *     array, which takes the EARLIEST payoff statement. A latest-row
 *     bound silently changes W1 — and on an instrument with one payoff
 *     statement, which is every fixture in this repo, the two are the
 *     same row and nothing goes red.
 *
 *  3  `select * from debt_payment_observations` — bounding the SHARED
 *     loader. paidOverPeriod() needs the series and is called by nothing
 *     in src/: built-but-dormant. The bound would have broken a working
 *     capability with no production caller to go red. §40.6 is standing
 *     PLUS detail, not standing INSTEAD of detail.
 *
 *  The common shape: the SQL looked wasteful, and the waste was load-
 *  bearing for a consumer that was not the one I was looking at. Find
 *  every consumer of the array before you bound the query.
 *
 *  ── THE RATCHET ─────────────────────────────────────────────────────
 *  HISTORY_WALK_CEILING is the number of history walks tolerated today.
 *  The gate fails if the count RISES. It does not pretend the remaining
 *  walks are acceptable; it makes them un-regressable while they are
 *  fixed one at a time, and every one is named below with what it needs.  */
/*  THE REAL NUMBER = ISSUED ∪ FOUND IN THE SOURCE.
 *
 *  The first version of this ceiling counted only what the empty property
 *  provoked, and reported eight. That number invited being read as the
 *  ceiling. It was not one — it was the subset of walks the fixture
 *  happened to reach.
 *
 *  Four walks are never issued here at all: the property has no
 *  compliance item and no debt instrument, so compliance_read and
 *  debt_instrument_service.loadHistory() short-circuit. compliance_facts
 *  was caught by eye. The three debt walks — including
 *  debt_payment_observations, which is payment history in the plainest
 *  sense §40.6 has — were caught by nothing until the source scan
 *  existed, and that is the whole argument for the scan.               */
const HISTORY_WALK_CEILING = 9;

/*  ══ COMPUTE_WALK — A CATEGORY THIS GATE CANNOT MEASURE ═════════════
 *
 *  ⚠ STATED LIMITATION, NOT A TO-DO: THIS GATE MEASURES QUERIES, NOT
 *  COMPUTE. Everything above counts statements issued to Postgres. A read
 *  can be perfectly bounded in SQL and still walk history in JavaScript,
 *  and nothing here would notice.
 *
 *  This is the SAME BLIND SPOT as the empty fixture, arriving a third
 *  time: a measurement that only observes one channel cannot see what
 *  happens in another. It is named here rather than instrumented,
 *  deliberately. A fourth measuring instrument is worth less right now
 *  than an honest boundary on the three that exist.
 *
 *  So COMPUTE_WALK entries are DECLARED BY HAND and DELIBERATELY
 *  UNMEASURED. They are not counted toward HISTORY_WALK_CEILING, because
 *  a ratchet over a number nothing measures is theatre.
 *
 *  ── WHAT KEEPS THE DECLARATION FROM ROTTING ─────────────────────────
 *  Every entry names a `pin`: a source coupling that MUST still exist for
 *  the claim to be true. The gate asserts the pin, which is cheap and
 *  needs no execution. If the coupling disappears — because someone fixed
 *  it — the pin goes red and says so, and the entry gets deleted
 *  deliberately instead of quietly becoming a lie. That is the same
 *  inverted assertion the defect blocks in
 *  debt_observation_bound_equivalence.db.js use.
 *
 *  This is NOT a compute measurement. It is a staleness guard on a
 *  hand-written claim, which is the least a hand-written claim owes.   */
const COMPUTE_WALKS = [
  {
    what: "position() derives the FULL amortization schedule on every call",
    where: "src/asset/debt_position_read.js",
    why: "deriveSchedule() walks every due date from origination to maturity — "
       + "120 rows on the 4125 specimen, and it COMPOUNDS, so each row depends "
       + "on the previous one's balance. standingProjection() then reads "
       + "projected_principal out of it. THE COMPACT PROJECTION PAYS FOR THE "
       + "WHOLE SCHEDULE. Every SQL statement in the Debt read is bounded or "
       + "structural and this gate reports Debt as clean.",
    //  Two couplings. Both must hold for the claim above to be true.
    pin: [
      { file: "src/asset/debt_position_read.js",
        re: /const schedule = t \? deriveSchedule\(terms, instrument\) : \[\];/,
        says: "position() derives the schedule" },
      { file: "src/asset/debt_position_read.js",
        re: /projected_principal: reading\.principal_position\.projected/,
        says: "standingProjection() reads a value derived from it" },
    ],
  },
];

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

  /*  ── FOUND BY THE SOURCE SCAN, NOT BY OBSERVATION ─────────────────
      Everything below sits behind an emptiness guard and never fired
      against the empty measurement property. tax_filings and tax_payments
      are the literal payment history §40.6 forbids walking, and the gate
      built to measure §40.6 could not see them.                        */
  { match: "from tax_liabilities l", kind: "DERIVED_BOUND",
    bounded_by: "from tax_obligations",
    why: "one live liability per obligation (supersession-filtered). Grows with " +
         "obligations and with nothing else; that curve is counted there." },
  { match: "from tax_liabilities s", kind: "DERIVED_BOUND",
    bounded_by: "from tax_obligations",
    why: "the supersession NOT EXISTS inside the statement above" },
  { match: "from tax_filings", kind: "DERIVED_BOUND",
    bounded_by: "from tax_obligations",
    why: "EVERY filing for every obligation loaded — but the obligation set is " +
         "the driver, and a period carries a fixed number of filings. Counted " +
         "under tax_obligations. NOTE: if tax_obligations is ever bounded, this " +
         "one loses its bound and the gate will say so." },
  { match: "from tax_payments", kind: "DERIVED_BOUND",
    bounded_by: "from tax_obligations",
    why: "same shape as filings — payment rows per obligation, fixed per period. " +
         "This is the statement §40.6 names by name, and it is uncounted ONLY " +
         "because its driver is counted." },
  { match: "from tax_appeals", kind: "STRUCTURAL",
    why: "`and closed_on is null` — open appeals only. Bounded at the database." },
  { match: "from compliance_fact_evidence e", kind: "DERIVED_BOUND",
    bounded_by: "from compliance_facts",
    why: "evidence rows per fact. The fact walk is the driver and is counted." },
  { match: "from insurance_coverages c", kind: "STRUCTURAL",
    why: "coverages live in the period — coverage_period_start/end filtered" },
  { match: "from insurance_coverage_properties o", kind: "STRUCTURAL",
    why: "a count of properties named on one policy" },
  { match: "from insurance_coverage_properties cp", kind: "STRUCTURAL",
    why: "policies naming this property, period-filtered" },

  /*  ── DEBT'S loadHistory() — the name is the finding ────────────────
      Six statements, none observed, because the empty property has no
      instrument. Two of them are unbounded observation series. */
  /*  ── RECLASSIFIED, AND I MAY BE WRONG ─────────────────────────────
      I declared this a HISTORY_WALK on §40.6's phrase "amendment
      history". Looking at what writes it: addTerm() has ONE caller, an
      operator recording a regime from the governing document. Rows arrive
      at origination and at modification. A ten-year loan carries two to
      four. That is the same curve as capital_stack_positions, which is
      declared STRUCTURAL two lines up for the same reason — it grows with
      financings, not with operating events.

      contracted_service_terms stays a walk and the difference is real: a
      service contract RENEWS on a cadence, so its term rows arrive with
      the calendar. A loan modification does not.

      It also could not be bounded even if it were a walk. deriveSchedule()
      calls inForce(terms, due) for EVERY due date from origination to
      maturity, and line 324 asks whether ANY term is an exercised
      extension. Both need every regime.

      ⚠ WHICH SURFACES THE COST THIS GATE DOES NOT MEASURE. position()
      derives the full 120-row amortization schedule on every call, and
      standingProjection() reads projected_principal out of it — so the
      COMPACT projection pays for the whole schedule. That is a compute
      walk, not a query walk, and this gate counts queries. Recorded here
      because it is the next real cost in Debt and nothing else names it. */
  { match: "from debt_terms", kind: "STRUCTURAL",
    why: "the governing document's regimes. Arrives at origination and at " +
         "modification — with financings, not with operating events. Cannot be " +
         "bounded regardless: deriveSchedule() needs every regime." },
  /*  ── A BOUND WAS BUILT FOR THIS AND REVERTED ──────────────────────
      It was correct at every date except one: two observations recorded
      for the SAME as_of_date. position() sorts with a comparator that
      returns -1 for equal keys, so the winner is input order, and
      `order by as_of_date` does not order equal dates. The answer is
      already arbitrary; a bound only changes WHICH arbitrary row wins.

      Two balances for one date from different sources is a CONFLICT, and
      §5 says say so rather than pick. That is a writer ruling, not a cost
      change. BLOCKED on it, and counted until then.                     */
  { match: "from debt_balance_observations", kind: "HISTORY_WALK",
    why: "every balance ever observed, no bound. BLOCKED, not unexamined: the " +
         "bound is proved correct at every date except a same-date tie, where the " +
         "current read's answer is undefined. Needs a conflict verdict first. " +
         "LIVES IN src/asset/debt_instrument_service.js." },
  /*  ── FIXED ────────────────────────────────────────────────────────
      Was `select * from debt_payment_observations where instrument_id=$1
      order by observed_as_of` — every payment ever observed, every column,
      no bound, on the standing-read path. Now the newest observation on or
      before as_of, eight named columns, `limit 1`.

      The full series did not disappear: loadPaymentObservations() is the
      detail read §40.6 calls for, and paidOverPeriod() — built-but-dormant,
      called by nothing in src/ — uses it. Bounding the shared loader would
      have broken a working capability with nothing in src/ to go red.

      Equivalence proved at eight dates in
      tests/debt_observation_bound_equivalence.db.js, including both sides
      of every boundary, against the unbounded loader preserved verbatim. */
  { match: "from debt_payment_observations", kind: "STRUCTURAL",
    why: "BOUNDED — the newest observation on or before as_of, limit 1. The " +
         "series is reachable through loadPaymentObservations() as a detail read." },
  { match: "from debt_instrument_parties", kind: "STRUCTURAL",
    why: "who is on the loan. Effective-dated rows accumulate with assignments, " +
         "not with operating events." },
  { match: "from debt_instrument_properties", kind: "STRUCTURAL",
    why: "the collateral named by this instrument" },
  { match: "from debt_reserve_requirements", kind: "STRUCTURAL",
    why: "reserve covenants the instrument imposes" },
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
    why: "NEVER ISSUED against the empty property — compliance_read short-circuits " +
         "with no items, so this is counted from the SOURCE SCAN. The canonical " +
         "property holds one compliance record today; the walk arrives with the " +
         "second." +
         " EVERY fact ever recorded for every item, plus every evidence row, plus " +
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
      const h = await svc.loadHistory(db, ids[0], "2026-08-22");
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

  /*  ── THE COUNT IS OBSERVED ∪ SCANNED ─────────────────────────────
      An earlier version counted only what the fixture provoked, and
      carried a hand-written `hidden_by_fixture` flag for the one walk I
      happened to notice. That was the bug in miniature: the count was my
      memory, not a measurement. Three debt walks were sitting behind an
      emptiness guard the whole time and no flag named them.

      Now a walk counts if the fixture issued it OR the source scan found
      it. Neither channel can be quietly switched off: an observed walk
      cannot be un-declared (the undeclared check), and a declared walk
      that appears in NEITHER channel is dead code and must be removed. */
  /*  DERIVED_BOUND — a statement whose growth is entirely inherited from
      another declared walk. It is NOT counted (that would be the same
      curve twice) and it is NOT free: `bounded_by` must name a
      declaration that is itself a HISTORY_WALK. If that walk is ever
      fixed or reclassified, this one loses its bound and the gate goes
      red until someone re-examines it. That is what stops DERIVED_BOUND
      from being the quiet place to put an inconvenient walk. */
  const derived = DECLARED.filter((d) => d.kind === "DERIVED_BOUND");
  const badlyBound = derived.filter((d) => {
    const target = DECLARED.find((x) => x.match === d.bounded_by);
    return !target || target.kind !== "HISTORY_WALK";
  });

  const scanned = new Map();
  for (const file of SCANNED_SOURCES) {
    for (const [key, where] of sqlTablesIn(file)) {
      const c = classify(key);
      if (c && c.kind === "HISTORY_WALK" && !scanned.has(c.match)) scanned.set(c.match, where);
    }
  }
  const counted = new Map();
  for (const m of seen) counted.set(m, "issued by the fixture");
  for (const [m, where] of scanned) if (!counted.has(m)) counted.set(m, `found in ${where}`);

  /*  ── COMPUTE_WALK · REPORTED, PINNED, NOT COUNTED ────────────────  */
  const rottedPins = [];
  for (const cw of COMPUTE_WALKS) {
    for (const pin of cw.pin) {
      const src = fs.readFileSync(path.join(ROOT, pin.file), "utf8");
      if (!pin.re.test(src)) rottedPins.push({ cw, pin });
    }
  }
  if (COMPUTE_WALKS.length) {
    L("COMPUTE WALKS — DECLARED BY HAND, AND THIS GATE DOES NOT MEASURE THEM");
    L("-".repeat(74));
    for (const cw of COMPUTE_WALKS) {
      L(`  ${cw.what}`);
      L(`    ${cw.where}`);
      L(`    ${cw.why.replace(/(.{66})\s/g, "$1\n    ")}`);
      for (const pin of cw.pin) L(`    pin: ${pin.says}`);
      L("");
    }
    L("  These are NOT counted toward the ceiling. A ratchet over a number");
    L("  nothing measures is theatre. This gate counts QUERIES; a read can be");
    L("  perfectly bounded in SQL and still walk history in JavaScript.");
    L("");
  }

  if (derived.length) {
    L("DERIVED — growth inherited from another declared walk, counted there");
    L("-".repeat(74));
    for (const d of derived) L(`  ${d.match.padEnd(38)} →  ${d.bounded_by}`);
    L("");
  }

  const notObserved = [...counted].filter(([m]) => !seen.has(m));
  if (notObserved.length) {
    L("COUNTED BUT NEVER ISSUED — the empty property does not provoke these");
    L("-".repeat(74));
    for (const [m, where] of notObserved) L(`  ${m.padEnd(44)} ${where}`);
    L("");
  }

  /*  A declared walk in neither channel is stale: the statement it names
      is gone. Left in place it inflates the ceiling forever, which is
      headroom under another name. */
  const deadDeclarations = DECLARED.filter((d) => d.kind === "HISTORY_WALK"
    && !seen.has(d.match) && !scanned.has(d.match));

  const walkCount = counted.size;
  const total = results.reduce((a, r) => a + r.queries, 0);
  L("=".repeat(74));
  L(`  ${results.length} domains · ${total} queries to gather all of them ONCE, on an EMPTY property`);
  L(`  ${walkCount} distinct history walk(s) — ${seen.size} issued by the fixture + ` +
    `${notObserved.length} found only by the source scan · ceiling ${HISTORY_WALK_CEILING}`);
  L("");

  /*  ── THE SCAN ────────────────────────────────────────────────────
      Every `from <table>` in the scanned sources must be declared,
      whether or not the empty fixture provoked it. */
  const unscanned = [];
  for (const file of SCANNED_SOURCES) {
    for (const [key, where] of sqlTablesIn(file)) {
      if (classify(key)) continue;
      unscanned.push({ key, where });
    }
  }
  if (unscanned.length) {
    L("IN THE SOURCE BUT NOT DECLARED — statements the fixture never provoked");
    L("-".repeat(74));
    for (const u of unscanned) L(`  ${u.key.padEnd(48)} ${u.where}`);
    L("");
  }

  let failed = 0;
  if (unscanned.length) {
    failed++;
    L(`  ✘ ${unscanned.length} statement(s) exist in the scanned sources and are not declared.`);
    L("      An empty property does not provoke every read. Undeclared AND");
    L("      unobserved is the blind spot that hid tax_filings and tax_payments —");
    L("      the literal payment history §40.6 forbids walking.");
  } else {
    L("  ✔ every `from <table>` in the scanned sources is declared, fired or not");
  }
  if (rottedPins.length) {
    failed++;
    L(`  ✘ ${rottedPins.length} COMPUTE_WALK pin(s) no longer hold.`);
    L("      A hand-declared claim whose source coupling is gone is a lie the");
    L("      next reader will believe. Either the walk was FIXED — delete the");
    L("      entry and say so — or it moved and the pin needs re-aiming.");
    for (const r of rottedPins) L(`      ${r.pin.file}: ${r.pin.says}`);
  }
  if (badlyBound.length) {
    failed++;
    L(`  ✘ ${badlyBound.length} DERIVED_BOUND declaration(s) do not name a live HISTORY_WALK.`);
    L("      A derived statement is uncounted because its growth is counted");
    L("      elsewhere. If that elsewhere is gone, it is counted NOWHERE.");
    for (const d of badlyBound) L(`      ${d.match} → bounded_by "${d.bounded_by}"`);
  }
  if (deadDeclarations.length) {
    failed++;
    L(`  ✘ ${deadDeclarations.length} declared history walk(s) appear in NEITHER the run nor the scan.`);
    L("      The statement is gone. A declaration outliving its statement holds");
    L("      the ceiling up forever, which is headroom wearing a reason.");
    for (const d of deadDeclarations) L(`      ${d.match}`);
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
