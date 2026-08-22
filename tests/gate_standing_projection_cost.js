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
const URL = process.env.B2_DATABASE_URL || "postgres://postgres@127.0.0.1:55434/b2";
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

/*  Bounded = the result size does not grow with the property's history. */
function isBounded(sql) {
  const s = sql.toLowerCase();
  if (!/^\s*(select|with)/.test(s)) return true;            // not a read
  if (/\blimit\s+\d+/.test(s)) return true;                 // explicitly capped
  if (/\bselect\s+count\s*\(/.test(s)) return true;         // aggregate
  if (/\bselect\s+(max|min|sum|avg)\s*\(/.test(s)) return true;
  if (/\bwhere\s+\w*\.?id\s*=\s*\$\d/.test(s)) return true; // pk lookup
  if (/\bexists\s*\(/.test(s) && /\blimit\b/.test(s)) return true;
  return false;
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
  L("  " + "domain".padEnd(20) + "queries  unbounded  outcome");
  L("  " + "-".repeat(70));

  const results = [];
  for (const d of DOMAINS) {
    const { wrapped, log } = recorder(client);
    let outcome = "ok";
    try {
      const out = await d.run(wrapped);
      //  ⚠ THE MAPPINGS ARE PROVEN HERE, ON REAL READINGS.
      //  Validating adapter.project(domain, null) proves only the
      //  NOT_ESTABLISHED branch. Every read above returns a REAL reading
      //  from a REAL database, so mapping it is the only evidence that
      //  the ESTABLISHED branch is shaped correctly too.
      const subject = (out && out.rich !== undefined) ? out.rich : out;
      const projected = adapter.project(d.domain, subject, d.extra ? d.extra(out) : undefined);
      const probs = contractShape.validate(projected);
      if (probs.length) outcome = "INVALID SHAPE: " + probs.join("; ").slice(0, 60);
    }
    catch (e) { outcome = "threw: " + String(e.message).slice(0, 40); }
    const unbounded = log.filter((q) => !isBounded(q));
    results.push({ domain: d.domain, queries: log.length, unbounded: unbounded.length, outcome, sample: unbounded[0] });
    L("  " + d.domain.padEnd(20) +
      String(log.length).padStart(5) + String(unbounded.length).padStart(10) + "  " + outcome);
  }

  await client.query("delete from properties where id = $1", [PROPERTY]).catch(() => {});
  await client.end();

  L("");
  L("UNBOUNDED STATEMENTS — the walks §40.6 forbids");
  L("-".repeat(74));
  for (const r of results.filter((x) => x.unbounded)) {
    L(`  ${r.domain}`);
    L(`    ${String(r.sample).slice(0, 150)}`);
  }

  const walkers = results.filter((r) => r.unbounded > 0);
  const total = results.reduce((a, r) => a + r.queries, 0);
  L("");
  L("=".repeat(74));
  L(`  ${results.length} domains · ${total} queries to gather all of them ONCE, on an EMPTY property`);
  L(`  ${walkers.length} issue at least one unbounded read: ${walkers.map((w) => w.domain).join(", ")}`);
  L("");
  L("  This is the number that decides whether Ask Spine can gather every");
  L("  entitled domain per question. While it is this high, a router is");
  L("  load-bearing — and §40.6 forbids the router. That is the tension");
  L("  Build 2 measures and does not, on its own, resolve.");
  L("");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
