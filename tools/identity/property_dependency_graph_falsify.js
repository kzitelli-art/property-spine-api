#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════
   FALSIFY THE GRAPH PARSER — no database, no migrations touched.

       node tools/identity/property_dependency_graph_falsify.js

   `property_dependency_graph.js` reported "zero unparsed" on the real
   migration tree. PHILOSOPHY §33: "A green gate that has never been
   shown capable of going red is evidence of nothing more than a green
   run." This file is the going-red.

   ── §18 COMPONENT CLASS ─────────────────────────────────────────────
   CLASS 3 — inventory / evidence infrastructure. It sits outside the
   signed-in operator workflow, ships to no user, and makes no product
   decision.

   REMOVAL CONDITION: none. This is deliberate and is NOT Class 4. The
   property identity ruling is a one-time decision, and this tooling is
   the record of how it was made — the evidence has to outlive the
   ruling or the ruling cannot be re-examined. It is removed only if
   `properties` stops being a table.

   Each case below is fed to the same parser the graph uses. Two kinds:

     MUST FIND    a real FK form — if the parser misses it, the graph's
                  counts are a floor and the report says so falsely
     MUST IGNORE  a comment or a lookalike — if the parser counts it,
                  the graph inflates and "a mention is not a guard"
                  (CLAUDE.md) has been violated
     MUST FLAG    a form the parser cannot classify — it must appear in
                  `unparsed`, never be silently dropped
   ════════════════════════════════════════════════════════════════════ */
"use strict";

const path = require("path");
const Module = require("module");
const fs = require("fs");

/* Load the parser against a synthetic migrations directory. The parser
   reads a directory, so give it a real temporary one — no mocking of fs,
   which would be testing the mock rather than the parser. */
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "propgraph-"));

function runCases(cases) {
  for (const f of fs.readdirSync(TMP)) fs.unlinkSync(path.join(TMP, f));
  cases.forEach((c, i) => fs.writeFileSync(path.join(TMP, `${String(i).padStart(3, "0")}_case.sql`), c.sql));

  // Re-require the module with MIGRATIONS_DIR pointed at TMP.
  const modPath = require.resolve("./property_dependency_graph.js");
  delete require.cache[modPath];
  const src = fs.readFileSync(modPath, "utf8").replace(
    /const MIGRATIONS_DIR = .*/,
    `const MIGRATIONS_DIR = ${JSON.stringify(TMP)};`
  );
  const m = new Module(modPath, null);
  m.filename = modPath;
  m.paths = Module._nodeModulePaths(path.dirname(modPath));
  m._compile(src, modPath);
  return m.exports.build();
}

const CASES = [
  { name: "column-level FK, cascade", expect: "find",
    sql: `create table a (id uuid primary key, property_id uuid not null references properties(id) on delete cascade);`,
    check: (g) => g.edges.some((e) => e.table === "a" && e.column === "property_id" && e.action === "CASCADE") },

  { name: "no ON DELETE clause defaults to NO ACTION", expect: "find",
    sql: `create table b (id uuid primary key, property_id uuid not null references properties(id));`,
    check: (g) => g.edges.some((e) => e.table === "b" && e.action === "NO ACTION" && e.effect === "BLOCKS") },

  { name: "table-level FOREIGN KEY constraint, set null", expect: "find",
    sql: `create table c (id uuid primary key, pid uuid,
            constraint fk_c_prop foreign key (pid) references properties(id) on delete set null);`,
    check: (g) => g.edges.some((e) => e.table === "c" && e.column === "pid" && e.action === "SET NULL" && e.constraint === "fk_c_prop") },

  { name: "ALTER TABLE ADD CONSTRAINT", expect: "find",
    sql: `create table d (id uuid primary key, pid uuid);
          alter table d add constraint fk_d foreign key (pid) references properties(id) on delete restrict;`,
    check: (g) => g.edges.some((e) => e.table === "d" && e.action === "RESTRICT" && e.form === "alter_add_constraint") },

  { name: "ALTER TABLE ADD COLUMN with inline reference", expect: "find",
    sql: `create table e (id uuid primary key);
          alter table e add column if not exists property_id uuid references properties(id) on delete cascade;`,
    check: (g) => g.edges.some((e) => e.table === "e" && e.column === "property_id" && e.action === "CASCADE") },

  { name: "non-standard column name is still an edge", expect: "find",
    sql: `create table f (id uuid primary key, subject_property_id uuid references properties(id) on delete restrict);`,
    check: (g) => g.edges.some((e) => e.table === "f" && e.column === "subject_property_id") },

  { name: "line-commented FK is NOT an edge", expect: "ignore",
    sql: `create table g (id uuid primary key
            -- property_id uuid references properties(id) on delete cascade
          );`,
    check: (g) => !g.edges.some((e) => e.table === "g") },

  { name: "block-commented FK is NOT an edge", expect: "ignore",
    sql: `/* create table h (property_id uuid references properties(id) on delete cascade); */
          create table h (id uuid primary key);`,
    check: (g) => !g.edges.some((e) => e.table === "h") },

  { name: "prose mentioning properties is NOT an edge", expect: "ignore",
    sql: `-- This table does not reference properties(id) at all, deliberately.
          create table i (id uuid primary key);`,
    check: (g) => !g.edges.some((e) => e.table === "i") },

  { name: "a DIFFERENT table named ..._properties is NOT an edge", expect: "ignore",
    sql: `create table j (id uuid primary key, x uuid references deal_intake_properties(id) on delete cascade);`,
    check: (g) => !g.edges.some((e) => e.table === "j") },

  { name: "FK on a table dropped later is excluded from live", expect: "ignore",
    sql: `create table k (id uuid primary key, property_id uuid references properties(id) on delete cascade);
          drop table if exists k cascade;`,
    check: (g) => !g.edges.some((e) => e.table === "k") && g.droppedEdges.some((e) => e.table === "k") },

  { name: "string literal containing the FK text is NOT an edge", expect: "ignore",
    sql: `create table l (id uuid primary key, note text default 'references properties(id) on delete cascade');`,
    check: (g) => !g.edges.some((e) => e.table === "l" && e.column !== "note") &&
                  !g.edges.some((e) => e.table === "l") },

  /* ── The rebind graph. Misclassifying these is the failure that
        would matter most: SINGLETON rendered as an empty key list looks
        like the WEAKEST constraint when it is the strongest. ────────── */
  { name: "unique(id, property_id) is an ANCHOR, not a collision", expect: "find",
    sql: `create table n (id uuid primary key, property_id uuid references properties(id), unique (id, property_id));`,
    check: (g) => g.uniques.some((u) => u.table === "n" && u.klass === "ANCHOR") },

  { name: "unique(property_id) alone is SINGLETON, not empty-COLLIDABLE", expect: "find",
    sql: `create table o (id uuid primary key, property_id uuid references properties(id), unique (property_id));`,
    check: (g) => g.uniques.some((u) => u.table === "o" && u.klass === "SINGLETON" && u.business.length === 0) },

  { name: "unique(property_id, business_key) is COLLIDABLE", expect: "find",
    sql: `create table p (id uuid primary key, property_id uuid references properties(id), code text, unique (property_id, code));`,
    check: (g) => g.uniques.some((u) => u.table === "p" && u.klass === "COLLIDABLE" && u.business.join() === "code") },

  { name: "partial unique index keeps its predicate INCLUDING the literal", expect: "find",
    sql: `create table q (id uuid primary key, property_id uuid references properties(id), status text);
          create unique index uq_q on q (property_id) where status = 'published';`,
    check: (g) => g.uniques.some((u) => u.table === "q" && u.klass === "SINGLETON" &&
                                        u.partial === "status = 'published'") },

  { name: "expression column with nested parens is not truncated", expect: "find",
    sql: `create table r (id uuid primary key, property_id uuid references properties(id), label text);
          create unique index uq_r on r (property_id, lower(trim(label))) where label is not null;`,
    check: (g) => g.uniques.some((u) => u.table === "r" && u.klass === "COLLIDABLE" &&
                                        u.business.join() === "lower(trim(label))") },

  /* An expression carrying an INTERNAL COMMA. The previous case does not
     exercise the paren-depth guard at all — `lower(trim(label))` splits
     identically with or without it, so it stayed green when the guard was
     deleted. This is the real tree's `coalesce(person_id, '…'::uuid)`. */
  { name: "expression column with an INTERNAL COMMA stays one column", expect: "find",
    sql: `create table u (id uuid primary key, property_id uuid references properties(id), person_id uuid, k text);
          create unique index uq_u on u (property_id, k, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid));`,
    check: (g) => g.uniques.some((u) => u.table === "u" && u.business.length === 2 &&
                                        u.business[1].startsWith("coalesce(person_id,")) },

  { name: "a unique NOT involving property_id is ignored", expect: "ignore",
    sql: `create table s (id uuid primary key, property_id uuid references properties(id), code text, unique (code));`,
    check: (g) => !g.uniques.some((u) => u.table === "s") },

  /* ── Renames. The graph reported `opening_positions`, a table that has
        not existed since migration 159. Caught only by building the same
        chain into a disposable local database and comparing. ────────── */
  { name: "ALTER TABLE … RENAME TO moves the edge to the new name", expect: "find",
    sql: `create table old_name (id uuid primary key, property_id uuid references properties(id) on delete cascade);
          alter table old_name rename to new_name;`,
    check: (g) => g.edges.some((e) => e.table === "new_name" && e.declaredAs === "old_name") &&
                  !g.edges.some((e) => e.table === "old_name") },

  { name: "a rename inside a DO $$ block is still seen", expect: "find",
    sql: `create table do_old (id uuid primary key, property_id uuid references properties(id) on delete cascade);
          do $$ begin
            if exists (select 1 from information_schema.tables where table_name = 'do_old') then
              alter table do_old rename to do_new;
            end if;
          end $$;`,
    check: (g) => g.edges.some((e) => e.table === "do_new") && !g.edges.some((e) => e.table === "do_old") },

  { name: "a rename also moves the table's unique constraints", expect: "find",
    sql: `create table uq_old (id uuid primary key, property_id uuid references properties(id), unique (property_id));
          alter table uq_old rename to uq_new;`,
    check: (g) => g.uniques.some((u) => u.table === "uq_new" && u.klass === "SINGLETON") &&
                  !g.uniques.some((u) => u.table === "uq_old") },
];

let pass = 0, fail = 0;
const results = [];
for (const c of CASES) {
  const g = runCases([c]);
  const ok = c.check(g);
  results.push({ ok, name: c.name, expect: c.expect,
                 saw: g.edges.map((e) => `${e.table}.${e.column}:${e.action}`).join(", ") || "(no edges)",
                 unparsed: g.unparsed.length });
  ok ? pass++ : fail++;
}

/* PROOF THAT THE PARSER CAN GO RED: a form deliberately outside what it
   handles must land in `unparsed`, not vanish. If this ever passes
   silently, the "zero unparsed" line in the report is worthless.

   There are TWO independent flag paths and both need a case. The first
   version of this file only exercised the ALTER path, so deliberately
   deleting the catch-all `unparsed.push` left the suite fully GREEN —
   the exact "green is a claim about what was measured" failure this
   repo documents. Both paths are covered now, and both were confirmed
   to go red by deleting their push. */
const GAPS = [
  { name: "unhandled ALTER form is FLAGGED, not dropped",
    sql: `alter table m validate constraint some_fk references properties;` },
  { name: "unhandled NON-DDL form is FLAGGED, not dropped (catch-all path)",
    sql: `select 1 from t references properties(id);` },
];
for (const gap of GAPS) {
  const g = runCases([gap]);
  const ok = g.unparsed.length > 0 && g.edges.length === 0;
  results.push({ ok, name: gap.name, expect: "flag",
                 saw: `unparsed=${g.unparsed.length} edges=${g.edges.length}`, unparsed: g.unparsed.length });
  ok ? pass++ : fail++;
}

console.log("\nFALSIFYING THE PROPERTY DEPENDENCY GRAPH PARSER");
console.log("=".repeat(72));
for (const r of results) {
  console.log(`  ${r.ok ? "✔" : "✘"}  [${r.expect.padEnd(6)}] ${r.name}`);
  if (!r.ok) console.log(`         saw: ${r.saw}   unparsed: ${r.unparsed}`);
}
console.log("-".repeat(72));
console.log(`  ${pass} passed, ${fail} failed`);
console.log(fail === 0
  ? "\n  The parser finds every FK form present in the tree, ignores comments,\n  string literals and lookalike table names, and FLAGS what it cannot\n  classify. That is what makes the report's 'zero unparsed' mean something.\n"
  : "\n  ⛔ The graph's counts cannot be trusted until these pass.\n");

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
