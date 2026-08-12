/* ════════════════════════════════════════════════════════════════════
   gate_insurance_funding_boundary.js — THE WALL BETWEEN WHAT INSURANCE
   COSTS AND HOW IT IS PAID FOR, ASSERTED STRUCTURALLY AND IN BOTH
   DIRECTIONS.

   Migration 161 exists because the June 2026 Skyline workpaper computed
   a property's annual insurance cost FROM THE FINANCING STREAM —
   allocated IPFS down payment plus installments, ÷ 12 — making the
   payment instrument the source of the economic fact.

   `gate_insurance_economic_independence.js` guards that by VOCABULARY:
   it fails when a word like `installment` or `escrow` appears in the
   economic chain. That is a real guard and it stays. It is also not
   enough, and the gap is specific:

       Vocabulary catches a financing WORD in an economic file.
       It does not catch an economic file REQUIRING a funding module
       whose own name is innocent, and it does not catch a funding
       module WRITING to an economic table.

   Once funding files exist, the vocabulary gate keeps passing while the
   seam rots, because it only ever looks at the economic side.

   ── THE BOUNDARY, AS RULED ──────────────────────────────────────────
   1  The economic chain may NEVER import funding. Not directly, not
      transitively, not through an innocent-looking intermediary.
   2  Funding MAY reference the insurance obligation or coverage it
      funds. That is the whole point of a funding record.
   3  Funding may NOT determine insurance cost or accrual. Structurally
      that means: funding may not WRITE economic tables and may not
      ALTER economic schema. It reads and references; it never authors.

   Direction is the asymmetry. Funding → economics is a legitimate
   reference. Economics → funding is the defect, always.

   ── IT TESTS ITS OWN DETECTORS, EVERY RUN ───────────────────────────
   Every analyser here is a pure function of file text, and the gate
   feeds each one known-good and known-bad input before it looks at a
   real file. A gate that under-detects is worse than no gate because it
   launders the gap into evidence — and this one has to keep working
   long after everyone has forgotten it exists.

   ── IT REPORTS ITS OWN COVERAGE ─────────────────────────────────────
   The funding set is EMPTY until Slice B lands. An empty set makes
   assertions 1 and 3 pass trivially, so the gate says out loud how many
   funding files it actually found. "0 declared, 0 present" is a
   statement about scope, not a clean bill of health, and it must not
   read as one.

   Run:  node tests/gate_insurance_funding_boundary.js
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "\n          " + detail : "")); }
}

/*  ══ TWO DOMAINS, ONE RULE ═════════════════════════════════════════
 *  Insurance and Taxes have the SAME wall for the SAME reason, so they
 *  get one implementation of it rather than two files that agree until
 *  somebody edits one — §17 counts that a defect even while they agree.
 *
 *  Taxes is declared BEFORE its schema exists, deliberately. The wall has
 *  to be executable before the thing it guards is written, or the first
 *  tax-funding commit is the one deciding where the wall goes. Every
 *  declared-but-absent path is REPORTED, never silently skipped.
 *
 *  The tax case is the one the operator named: changing a lender escrow
 *  contribution must not move the annual tax liability or the monthly tax
 *  accrual. Escrow may REFERENCE the tax obligation it pays. It may never
 *  author it — and a fully funded escrow is still not PAID until there is
 *  evidence the City was paid.
 */
const INSURANCE_ECONOMIC = [
  "migrations/161_insurance_economic_truth.sql",
  "migrations/162_insurance_coverage_participation.sql",
  "src/asset/insurance_program_service.js",
  "src/asset/insurance_allocation_service.js",
  "src/asset/insurance_position_read.js",
  "src/asset/insurance_establishment.js",
  "src/asset/insurance_document_read.js",
  "src/asset/insurance_standing.js",
];

/*  ── THE FUNDING CHAIN ──────────────────────────────────────────────
 *  Declared BEFORE it exists, on purpose. The wall has to be executable
 *  before the schema it guards is written, or the first funding commit
 *  is the one deciding where the wall goes.
 *
 *  A path listed here and absent from disk is reported, never silently
 *  skipped. */
const INSURANCE_FUNDING = [
  "migrations/163_insurance_funding.sql",
  "src/asset/insurance_funding_service.js",
  "src/asset/insurance_funding_read.js",
  "src/asset/insurance_funding.js",
];

//  ── TAXES. DECLARED AHEAD OF THE SCHEMA, ON PURPOSE. ───────────────
const TAX_ECONOMIC = [
  "migrations/165_philadelphia_tax_position.sql",
  "src/asset/tax_obligation_service.js",
  "src/asset/tax_position_read.js",
  "src/asset/tax_establishment.js",
  "src/asset/philadelphia_tax_rules.js",
];
const TAX_FUNDING = [
  "migrations/166_tax_funding.sql",
  "src/asset/tax_funding_service.js",
  "src/asset/tax_funding_read.js",
  "src/asset/tax_funding.js",
];

/*  Tables each side OWNS. Ownership is what makes a write a violation:
 *  funding writing `insurance_property_allocations` would be funding
 *  authoring the number that becomes this property's economic cost —
 *  the exact defect 161 exists to prevent, arriving from the other side. */
const INSURANCE_ECONOMIC_TABLES = [
  "insurance_programs",
  "insurance_coverages",
  "insurance_coverage_identifiers",
  "insurance_property_allocations",
  "insurance_coverage_properties",
];
const INSURANCE_FUNDING_TABLES = [
  "insurance_funding_arrangements",
  "premium_finance_agreements",
  "insurance_escrow_arrangements",
];
const TAX_ECONOMIC_TABLES = [
  "tax_obligations",
  "tax_liabilities",
  "tax_obligation_applicability",
  "tax_filings",
];
const TAX_FUNDING_TABLES = [
  "tax_funding_arrangements",
  "tax_escrow_arrangements",
];

const DOMAINS = [
  { name: "insurance",
    economic: INSURANCE_ECONOMIC, funding: INSURANCE_FUNDING,
    economicTables: INSURANCE_ECONOMIC_TABLES, fundingTables: INSURANCE_FUNDING_TABLES,
    //  The accrual whose independence is the point of the whole wall.
    accrualFile: "src/asset/insurance_position_read.js",
    accrualRule: /termMonths|term_months/ },
  { name: "tax",
    economic: TAX_ECONOMIC, funding: TAX_FUNDING,
    economicTables: TAX_ECONOMIC_TABLES, fundingTables: TAX_FUNDING_TABLES,
    accrualFile: "src/asset/tax_position_read.js",
    accrualRule: /annual_liability|liability_cents/ },
];

// ── PURE ANALYSERS ───────────────────────────────────────────────────

function stripComments(src, isSql) {
  let out = src;
  if (isSql) out = out.replace(/--[^\n]*/g, " ");
  else out = out.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  return out;
}

/*  Local requires only. A bare `require("express")` is not a repo edge
 *  and following it would walk into node_modules forever. */
function importsOf(src) {
  const code = stripComments(src, false);
  const out = [];
  const re = /require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

/*  Does this text NAME a table at all — a reference, a join, a select,
 *  a foreign key? Word-boundary matched so `insurance_coverages_extra`
 *  does not read as `insurance_coverages`. */
function namesTable(src, table, isSql) {
  return new RegExp(`\\b${table}\\b`).test(stripComments(src, isSql));
}

/*  Does this text WRITE the table? insert / update / delete, plus DDL
 *  that changes its shape. Deliberately NOT tripped by `references
 *  insurance_coverages(id)` — a foreign key is how funding points at
 *  what it funds, which the ruling explicitly permits. */
function writesTable(src, table, isSql) {
  const code = stripComments(src, isSql);
  const patterns = [
    new RegExp(`insert\\s+into\\s+${table}\\b`, "i"),
    new RegExp(`update\\s+${table}\\b`, "i"),
    new RegExp(`delete\\s+from\\s+${table}\\b`, "i"),
    new RegExp(`alter\\s+table\\s+(if\\s+exists\\s+)?${table}\\b`, "i"),
    new RegExp(`drop\\s+table\\s+(if\\s+exists\\s+)?${table}\\b`, "i"),
    new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?${table}\\b`, "i"),
    new RegExp(`truncate\\s+(table\\s+)?${table}\\b`, "i"),
  ];
  return patterns.some((p) => p.test(code));
}

// ── SELF-TEST: PROVE THE DETECTORS BITE, BEFORE TRUSTING THEM ────────

function selfTest() {
  console.log("── 0. THE DETECTORS ARE TESTED BEFORE THEY ARE USED ──");

  ok("importsOf finds a relative require",
     importsOf('const f = require("./insurance_funding_service.js");')
       .includes("./insurance_funding_service.js"));
  ok("importsOf finds one reached through a directory hop",
     importsOf('require("../asset/insurance_funding.js")').includes("../asset/insurance_funding.js"));
  ok("importsOf ignores a package require",
     importsOf('require("express")').length === 0);
  ok("importsOf ignores a require inside a COMMENT — a mention is not an edge",
     importsOf('// require("./insurance_funding_service.js")').length === 0);
  ok("importsOf ignores one inside a block comment",
     importsOf('/*\n  require("./insurance_funding_service.js")\n*/').length === 0);

  ok("namesTable finds a plain reference",
     namesTable("select * from insurance_coverages c", "insurance_coverages", true));
  ok("namesTable is word-bounded — a longer name is a different table",
     !namesTable("select * from insurance_coverages_archive", "insurance_coverages", true));

  ok("writesTable catches an insert",
     writesTable("insert into insurance_property_allocations (a) values (1)",
                 "insurance_property_allocations", true));
  ok("writesTable catches an update",
     writesTable("update insurance_coverages set premium_cents = 1", "insurance_coverages", true));
  ok("writesTable catches a delete",
     writesTable("delete from insurance_programs where id = $1", "insurance_programs", true));
  ok("writesTable catches an ALTER — funding may not reshape economic schema",
     writesTable("alter table insurance_coverages add column x int", "insurance_coverages", true));
  ok("writesTable catches `alter table if exists`",
     writesTable("alter table if exists insurance_coverages drop column x",
                 "insurance_coverages", true));

  //  THE ONE THAT MATTERS MOST. A foreign key is how funding points at
  //  the coverage it funds. If this trips, the gate forbids the thing
  //  the ruling explicitly permits and Slice B cannot be written.
  ok("writesTable does NOT trip on a foreign key reference",
     !writesTable("coverage_id uuid not null references insurance_coverages(id)",
                  "insurance_coverages", true));
  ok("writesTable does NOT trip on a select",
     !writesTable("select total_cents from insurance_coverages where id = $1",
                  "insurance_coverages", true));
  ok("writesTable does NOT trip on a join",
     !writesTable("join insurance_coverages c on c.id = f.coverage_id",
                  "insurance_coverages", true));
}

// ── THE REAL SCAN ────────────────────────────────────────────────────

function readIf(rel) {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

/*  Resolve a relative require to a repo-relative path, trying the exact
 *  name then the .js suffix — the two forms this repo actually uses. */
function resolveEdge(fromRel, spec) {
  const baseDir = path.dirname(path.join(ROOT, fromRel));
  for (const candidate of [spec, spec + ".js", path.join(spec, "index.js")]) {
    const abs = path.resolve(baseDir, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return path.relative(ROOT, abs).split(path.sep).join("/");
    }
  }
  return null;
}

/*  Every repo file reachable from a starting file by local requires.
 *  TRANSITIVE, because the defect this catches is an economic file
 *  reaching funding through an innocent-looking intermediary. */
function reachableFrom(startRel) {
  const seen = new Set();
  const stack = [startRel];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const src = readIf(cur);
    if (src === null || cur.endsWith(".sql")) continue;
    for (const spec of importsOf(src)) {
      const next = resolveEdge(cur, spec);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  seen.delete(startRel);
  return seen;
}

console.log("════════════════════════════════════════════════════════════════");
console.log("  GATE      funding boundary  (structural, both ways, per domain)");
console.log("════════════════════════════════════════════════════════════════\n");

selfTest();

for (const d of DOMAINS) {
  const economicPresent = d.economic.filter((f) => readIf(f) !== null);
  const fundingPresent = d.funding.filter((f) => readIf(f) !== null);
  const fundingSet = new Set(d.funding);

  console.log(`\n══ ${d.name.toUpperCase()} ═══════════════════════════════════════`);
  console.log(`  economic chain : ${economicPresent.length}/${d.economic.length} present`);
  console.log(`  funding chain  : ${fundingPresent.length}/${d.funding.length} present`);

  //  COVERAGE, STATED BEFORE THE VERDICT. A domain whose files do not
  //  exist yet passes its cross-checks trivially, and saying so is the
  //  difference between a scope statement and a clean bill of health.
  if (!economicPresent.length && !fundingPresent.length) {
    console.log("  ⚠ DECLARED, NOT YET BUILT. Every cross-check below is VACUOUS —");
    console.log("    it passes because there is nothing to violate it. The wall is");
    console.log("    executable and becomes load-bearing on the first file that lands.");
    continue;
  }
  if (!fundingPresent.length) {
    console.log("  ⚠ no funding files yet — the funding-side checks are VACUOUS.");
  }

  console.log(`\n  ── ${d.name}: economics may never import funding ──`);
  for (const rel of economicPresent) {
    if (rel.endsWith(".sql")) continue;
    const reach = reachableFrom(rel);
    const bad = [...reach].filter((r) => fundingSet.has(r));
    ok(`${rel} reaches no funding module (${reach.size} repo files transitively)`,
       bad.length === 0, bad.join(", "));
  }

  console.log(`\n  ── ${d.name}: economics may not name a funding table ──`);
  for (const rel of economicPresent) {
    const src = readIf(rel);
    const hits = d.fundingTables.filter((t) => namesTable(src, t, rel.endsWith(".sql")));
    ok(`${rel} names no funding table`, hits.length === 0, hits.join(", "));
  }

  console.log(`\n  ── ${d.name}: funding may reference economics, never author it ──`);
  if (!fundingPresent.length) {
    console.log("     (nothing to scan — stated above)");
  } else {
    for (const rel of fundingPresent) {
      const src = readIf(rel);
      const isSql = rel.endsWith(".sql");
      const writes = d.economicTables.filter((t) => writesTable(src, t, isSql));
      ok(`${rel} writes no economic table`, writes.length === 0, writes.join(", "));
      //  Referencing is EXPECTED and is deliberately not asserted against.
      //  Saying so here stops the next reader "tightening" it into a ban.
    }
  }

  const readSrc = readIf(d.accrualFile);
  if (readSrc !== null) {
    console.log(`\n  ── ${d.name}: the economic derivation's inputs ──`);
    ok(`${d.accrualFile} still derives from its own governed terms`,
       d.accrualRule.test(stripComments(readSrc, false)),
       "the derivation moved — re-read it before changing this gate");
    ok(`${d.accrualFile} imports nothing — it cannot reach funding by any path`,
       importsOf(readSrc).length === 0, importsOf(readSrc).join(", "));
  }
}

console.log("\n════════════════════════════════════════════════════════════════");
console.log(`  ASSERTIONS COMPLETE · ${pass + fail} run · ${pass} passed · ${fail} failed`);
if (fail) {
  console.log("  ✗ FAIL — a funding boundary is not holding.");
  console.log("  EXIT      1");
  console.log("════════════════════════════════════════════════════════════════");
  process.exit(1);
}
console.log("  ✓ PASS — economics cannot reach funding; funding cannot author economics.");
console.log("  EXIT      0");
console.log("════════════════════════════════════════════════════════════════");
