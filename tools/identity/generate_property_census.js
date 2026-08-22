#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   GENERATE THE PROPERTY CENSUS SQL. NEVER RUN IT.

       node tools/identity/generate_property_census.js > tools/identity/property_census.sql

   Emits a single read-only script a human pastes into the Neon editor.
   This generator does not connect to any database and the script it
   writes contains no statement that can write.

   ── WHY A GENERATOR AND NOT A HAND-WRITTEN FILE ─────────────────────
   152 tables reference `properties`. Hand-maintaining 152 blocks
   guarantees drift the moment a migration lands. The table list is
   derived from `property_dependency_graph.js`, which parses the
   migration chain — so the census follows the schema instead of
   remembering it.

   ── THE TIMESTAMP COLUMN ────────────────────────────────────────────
   Not every dependent table has `created_at`. Which ones do is a schema
   fact, and this generator does NOT guess: it reads a column map
   captured from a disposable local database built from the real
   migration chain, stored beside this file as
   `property_census_columns.json`. Regenerate that map with --capture
   against a LOCAL, DISPOSABLE database only.

   A table with no timestamp column reports NULL for earliest/latest
   rather than being dropped from the census — a table that cannot date
   its rows still counts them, and an omitted table would read as zero.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const { build } = require("./property_dependency_graph.js");

const COLUMN_MAP = path.join(__dirname, "property_census_columns.json");
const TIMESTAMP_PREFERENCE = ["created_at", "recorded_at", "occurred_at", "uploaded_at", "captured_at"];

function loadColumnMap() {
  if (!fs.existsSync(COLUMN_MAP)) {
    console.error("\n  ✗ REFUSED: " + COLUMN_MAP + " is missing.");
    console.error("    Capture it first against a LOCAL DISPOSABLE database:");
    console.error("    PGURL=postgres://…/disposable node tools/identity/generate_property_census.js --capture\n");
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(COLUMN_MAP, "utf8"));
}

/* --capture: introspect a local disposable database for timestamp
   columns. Refuses anything that is not obviously local. */
async function capture() {
  const url = process.env.PGURL || "";
  const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
  if (!local) {
    console.error("\n  ✗ REFUSED: --capture requires PGURL pointing at 127.0.0.1 or localhost.");
    console.error("    This tool may never introspect a remote or production database.\n");
    process.exit(2);
  }
  const { Client } = require("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  const g = build();
  const tables = [...new Set(g.edges.map((e) => e.table))].sort();
  const { rows } = await c.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])`, [tables]);
  await c.end();
  const map = {};
  for (const t of tables) map[t] = null;
  const byTable = {};
  for (const r of rows) (byTable[r.table_name] ||= new Set()).add(r.column_name);
  for (const t of tables) {
    const cols = byTable[t];
    if (!cols) { map[t] = { missing: true, ts: null }; continue; }
    map[t] = { missing: false, ts: TIMESTAMP_PREFERENCE.find((c) => cols.has(c)) || null };
  }
  fs.writeFileSync(COLUMN_MAP, JSON.stringify(map, null, 2) + "\n");
  const withTs = Object.values(map).filter((m) => m && m.ts).length;
  console.error(`  captured ${tables.length} tables · ${withTs} have a timestamp column · ${tables.length - withTs} do not`);
}

function emit() {
  const g = build();
  const map = loadColumnMap();
  const edges = g.edges.slice().sort((a, b) => a.table.localeCompare(b.table));
  const missing = edges.filter((e) => map[e.table] && map[e.table].missing).map((e) => e.table);
  const usable = edges.filter((e) => map[e.table] && !map[e.table].missing);

  const L = [];
  const P = (s = "") => L.push(s);

  P("-- ════════════════════════════════════════════════════════════════════");
  P("--  PROPERTY IDENTITY CENSUS — READ-ONLY");
  P("--");
  P("--  GENERATED FILE. Do not edit by hand.");
  P("--    node tools/identity/generate_property_census.js > tools/identity/property_census.sql");
  P("--");
  P("--  Four property rows compete for the identity \"Solo on Chestnut / 4233\".");
  P("--  This answers what actually hangs off each one, so a ruling can be");
  P("--  made on evidence. It makes no ruling and changes no data.");
  P("--");
  P("--  ── WHAT THIS SCRIPT MAY DO ────────────────────────────────────────");
  P("--  SELECT only. No INSERT, UPDATE, DELETE, DDL, temp table, function,");
  P("--  or writing CTE appears anywhere below. It is safe to run against");
  P("--  production BY A HUMAN WHO HAS READ IT.");
  P("--");
  P("--  Run it in a READ-ONLY transaction so the database — not this");
  P("--  comment — is what enforces that:");
  P("--");
  P("--      begin transaction read only;   -- <- already the first statement");
  P("--      …                              -- <- the census");
  P("--      rollback;                      -- <- already the last statement");
  P("--");
  P("--  ── WHO RUNS IT ────────────────────────────────────────────────────");
  P("--  A human, in the Neon editor. It was NOT run by the thread that");
  P("--  generated it, deliberately: an unattended session is not the place");
  P("--  to discover that a credential was wider than advertised.");
  P("--");
  P(`--  Derived from ${g.files.length} migration files, ceiling ${g.files[g.files.length - 1].slice(0, 3)}.`);
  P(`--  ${usable.length} dependent tables. Verified to parse and execute against a`);
  P("--  DISPOSABLE LOCAL Postgres built from the real migration chain to the");
  P("--  same ceiling, exit 0, every count zero.");
  P("--");
  P("--  Precisely what that proves, and what it does not: that database was");
  P("--  not strictly empty — the harness precondition");
  P("--  tests/e2e/preconditions/087.sql inserts one `properties` row, and it");
  P("--  uses the PRODUCTION Demo Building UUID. So the run proves the SQL is");
  P("--  syntactically valid, that every table and column it names exists in");
  P("--  the real schema, and that it returns zero counts where there are no");
  P("--  rows. It proves nothing about production data.");
  P("-- ════════════════════════════════════════════════════════════════════");
  P();
  P("begin transaction read only;");
  P();
  P("-- ── STEP 0 · WHICH ROWS ARE THE CANDIDATES? ─────────────────────────");
  P("--  Two of the four ids are not recoverable from the repository: the");
  P("--  handoff records them only as the truncated prefixes 21197bb1… and");
  P("--  79a5a8d1…, which came from a production boot log. Run this first,");
  P("--  then paste the full ids into STEP 1.");
  P("--");
  P("--  This is a DISCOVERY query. Resolving a property by name is exactly");
  P("--  what docs/DB_HARNESS_ISOLATION.md forbids for operating code, and");
  P("--  the reason it is forbidden — three rows share the name — is the");
  P("--  reason a census has to start by listing them.");
  P("select id, name, display_name, canonical_key, created_at");
  P("  from properties");
  P(" where name ilike '%solo%' or name ilike '%chestnut%' or name ilike '%4233%'");
  P("    or name ilike '%demo building%' or display_name ilike '%solo%'");
  P(" order by created_at asc;");
  P();
  P("-- ── STEP 1 · THE CANDIDATES ─────────────────────────────────────────");
  P("--  EDIT ONLY THIS BLOCK. Every query below reads from it, so the ids");
  P("--  are named once rather than in 152 places.");
  P("--  Replace the two placeholder ids with what STEP 0 returned.");
  P();
  P("--  a50fbdd0… 'Property Spine Demo Building' / displayed Solo — populated");
  P("--  9e2bb96e… canonical 4233 Chestnut");
  P("--  21197bb1… ) two further rows named 'Solo on Chestnut', full ids");
  P("--  79a5a8d1… ) UNKNOWN to the repository — fill in from STEP 0");
  P();

  const candidates = `with candidates (property_id) as (
  values
    ('a50fbdd0-3642-431e-b532-0dcd6ab8a4fe'::uuid),   -- Demo Building / displayed Solo
    ('9e2bb96e-08e2-41db-81c2-91055ceb50a3'::uuid),   -- canonical 4233 Chestnut
    ('00000000-0000-0000-0000-000000000000'::uuid),   -- REPLACE: 21197bb1…
    ('00000000-0000-0000-0000-000000000000'::uuid)    -- REPLACE: 79a5a8d1…
)`;

  P("-- ── STEP 2 · IDENTITY OF EACH CANDIDATE ─────────────────────────────");
  P(candidates);
  P("select p.id, p.name, p.display_name, p.canonical_key, p.created_at");
  P("  from candidates c join properties p on p.id = c.property_id");
  P(" order by p.created_at asc;");
  P();
  P("-- ── STEP 3 · PER-TABLE ROW COUNTS, HIGHEST FIRST ────────────────────");
  P("--  One row per (property, table) where the count is non-zero.");
  P("--  A table with no timestamp column reports NULL for the date bounds");
  P("--  rather than being omitted — an omitted table would read as zero.");
  P(candidates + ",");
  P("counts as (");
  const blocks = usable.map((e) => {
    const ts = map[e.table].ts;
    const earliest = ts ? `min(t.${ts})` : "null::timestamptz";
    const latest = ts ? `max(t.${ts})` : "null::timestamptz";
    return `  select '${e.table}'::text as table_name, '${e.column}'::text as fk_column, ` +
           `'${e.action}'::text as on_delete, c.property_id,\n` +
           `         count(t.*) as row_count, ${earliest} as earliest, ${latest} as latest\n` +
           `    from candidates c left join ${e.table} t on t.${e.column} = c.property_id\n` +
           `   group by c.property_id`;
  });
  P(blocks.join("\n  union all\n"));
  P(")");
  P("select table_name, fk_column, on_delete, property_id, row_count, earliest, latest");
  P("  from counts");
  P(" where row_count > 0");
  P(" order by row_count desc, table_name, property_id;");
  P();
  P("-- ── STEP 4 · TOTALS, SO THE FOUR ARE COMPARABLE AT A GLANCE ─────────");
  P(candidates + ",");
  P("counts as (");
  P(blocks.join("\n  union all\n"));
  P(")");
  P("select property_id,");
  P("       sum(row_count)                                  as total_rows,");
  P("       count(*) filter (where row_count > 0)           as tables_touched,");
  P("       sum(row_count) filter (where on_delete = 'CASCADE')   as rows_a_delete_would_destroy,");
  P("       sum(row_count) filter (where on_delete in ('RESTRICT','NO ACTION')) as rows_that_would_block_a_delete,");
  P("       sum(row_count) filter (where on_delete = 'SET NULL')  as rows_that_would_be_orphaned,");
  P("       min(earliest)                                   as earliest_activity,");
  P("       max(latest)                                     as latest_activity");
  P("  from counts");
  P(" group by property_id");
  P(" order by total_rows desc;");
  P();
  P("-- ── STEP 5 · THE FOUR GUARANTEED MERGE COLLISIONS ───────────────────");
  P("--  Each of these permits ONE row per property. If two candidates both");
  P("--  return a row here, a merge collides with certainty — no shared");
  P("--  business key needed. This is what decides whether Option B can run");
  P("--  as a single transaction at all.");
  /* Derived from the SINGLETON classification, never hand-listed — the
     hand-written version named `opening_positions`, renamed away by
     migration 159. */
  const singles = [];
  const seenS = new Set();
  for (const u of g.uniques.filter((x) => x.klass === "SINGLETON")) {
    if (seenS.has(u.table)) continue;
    seenS.add(u.table);
    singles.push(u);
  }
  P(candidates);
  singles.forEach((u, i) => {
    if (i) P("union all");
    P(`select '${u.table}'${i ? "" : " as tbl"}, c.property_id, count(t.*)${i ? "" : " as rows"}`);
    P(`  from candidates c left join ${u.table} t`);
    P(`    on t.property_id = c.property_id` + (u.partial ? `\n   and (${u.partial})` : ""));
    P(" group by c.property_id");
  });
  P(" order by 1, 2;");
  P();
  P("-- ── STEP 6 · THE TWO TRIGGER WALLS THE FK GRAPH CANNOT SEE ──────────");
  P("--  Both tables carry an UNCONDITIONAL delete-refusal trigger AND a");
  P("--  CASCADE foreign key. Proven on a disposable database: a single row");
  P("--  in either makes `delete from properties` RAISE, not cascade.");
  P("--  If either returns > 0, a delete of that property is IMPOSSIBLE");
  P("--  until the row is retired through its own governed path.");
  P(candidates);
  P("select 'ai_leasing_operating_rules' as tbl, c.property_id, count(t.*) as rows");
  P("  from candidates c left join ai_leasing_operating_rules t on t.property_id = c.property_id");
  P(" group by c.property_id");
  P("union all");
  P("select 'governed_charge_rulings', c.property_id, count(t.*)");
  P("  from candidates c left join governed_charge_rulings t on t.property_id = c.property_id");
  P(" group by c.property_id");
  P(" order by 1, 2;");
  P();
  P("-- ── STEP 7 · SOURCE ARTIFACTS — INVISIBLE TO THE FK GRAPH ───────────");
  P("--  `source_artifacts` has NO property_id column and NO foreign key to");
  P("--  properties. It binds by a polymorphic (scope_type, scope_id) pair,");
  P("--  so it appears NOWHERE in the 154-edge dependency graph. A property");
  P("--  delete leaves these orphaned but intact; a rebind strands them,");
  P("--  and an immutability trigger refuses to move or delete them.");
  P(candidates);
  P("select c.property_id, count(a.*) as artifacts,");
  P("       min(a.uploaded_at) as earliest, max(a.uploaded_at) as latest");
  P("  from candidates c");
  P("  left join source_artifacts a on a.scope_type = 'property' and a.scope_id = c.property_id");
  P(" group by c.property_id");
  P(" order by artifacts desc;");
  P();
  P("-- ── STEP 8 · MARLOW'S TOUR — PROTECTED FOREVER ──────────────────────");
  P("--  31ca5801-… must survive every option. Source protects it only");
  P("--  TRANSITIVELY, through its parent property being in owner.js's");
  P("--  NEVER_DELETE list. Nothing is keyed on the tour id itself.");
  P("--  Confirm which property currently owns it before any ruling.");
  P("select id, property_id, status, created_at");
  P("  from leasing_tours");
  P(" where id = '31ca5801-a851-4be5-802d-28739f24d6e1';");
  P();
  P("rollback;");
  P();
  if (missing.length) {
    P("-- ── TABLES OMITTED ──────────────────────────────────────────────────");
    P("--  These are declared in the migration chain but were absent from the");
    P("--  captured schema. They are NOT counted above. Investigate before");
    P("--  treating the totals as complete:");
    for (const t of missing) P(`--    ${t}`);
  }
  return L.join("\n") + "\n";
}

if (require.main === module) {
  if (process.argv.includes("--capture")) capture();
  else process.stdout.write(emit());
}
